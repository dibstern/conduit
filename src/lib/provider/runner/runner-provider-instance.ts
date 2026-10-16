import { SqlClient } from "@effect/sql";
import {
	Cause,
	Deferred,
	Effect,
	Either,
	Exit,
	Fiber,
	FiberMap,
	Option,
	type Scope,
} from "effect";
import {
	type AccountsState,
	resolve as resolveAccount,
} from "../../account-directory.js";
import type { Account } from "../../contracts/account.js";
import type { KnownProviderDriverKind } from "../../contracts/provider-instance.js";
import type { DaemonConfigLoadError } from "../../daemon/config-persistence.js";
import {
	bindTurnTimelineSink,
	observeTurnTimelineFrame,
} from "../../domain/daemon/Services/turn-timeline.js";
import { PendingInteractionServiceTag } from "../../domain/relay/Services/pending-interaction-service.js";
import {
	type ProviderRuntimeIngestionError,
	ProviderRuntimeIngestionTag,
} from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	makeProcessingTimeoutHooks,
	type OverridesStateTag,
} from "../../domain/relay/Services/session-overrides-state.js";
import { formatErrorDetail } from "../../errors-utils.js";
import { createLogger } from "../../logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
	type ClaudeEventPersistFailure,
} from "../../persistence/effect/claude-event-persist-effect.js";
import { createEventId } from "../../persistence/events.js";
import type { BackgroundTaskTransition } from "../../session/background-liveness.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import { ProviderInstanceFailure } from "../errors.js";
import type {
	EventSink,
	PermissionDecision,
	PreWarmSessionInput,
	ProviderCapabilities,
	ProviderInstance,
	ProviderNativeSession,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import { makeRecoveredEventSink } from "./runner-event-sink.js";
import {
	runnerSinkId,
	runnerFailure as sessionFailure,
} from "./runner-protocol.js";
import { settleUnclaimedRunnerCommands } from "./runner-recovery.js";
import { discoverRunners } from "./runner-registry.js";
import { failRunnerTurn } from "./runner-turn-failure.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
	SessionTurn,
} from "./session-runner.js";

const log = createLogger("runner-provider-instance");

type PreparedTurn = Omit<
	Extract<SessionCommand, { type: "send-turn" }>,
	"type" | "sinkId" | "aborted"
>;

/** Provider policy only; sink, interaction and runner lifetime belong to the instance. */
export interface RunnerDriverPieces {
	readonly driverKind: KnownProviderDriverKind;
	readonly steering: boolean;
	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure>;
	prepareTurnEffect(
		input: SessionTurn,
	): Effect.Effect<PreparedTurn, ProviderInstanceFailure>;
	readonly preparePreWarmEffect?: (
		input: PreWarmSessionInput,
		scope: Scope.Scope,
	) => Effect.Effect<
		Extract<SessionCommand, { type: "pre-warm" }> | undefined,
		ProviderInstanceFailure
	>;
	readonly stopTask?: boolean;
	readonly nativeSession?: boolean;
}

export interface RunnerProviderInstanceDeps {
	readonly workspaceRoot: string;
	readonly accounts: Effect.Effect<AccountsState, DaemonConfigLoadError>;
	readonly daemonConfigDir?: string;
	readonly onBackgroundTask?: (input: BackgroundTaskTransition) => void;
	readonly ensureChildSession?: ClaudeEventPersistEffect["ensureClaudeSubagentSession"];
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
}

export const makeRunnerProviderInstance = (
	deps: RunnerProviderInstanceDeps,
	driver: RunnerDriverPieces,
	makeRunner: (
		emit: (
			output: SessionOutput,
			sessionId?: string,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
	) => Effect.Effect<SessionRunner, never, Scope.Scope>,
): Effect.Effect<RunnerProviderInstance, never, Scope.Scope> =>
	Effect.gen(function* () {
		const providerScope = yield* Effect.scope;
		const abortFibers = yield* FiberMap.make<string, void, never>();
		const interactionFibers = yield* FiberMap.make<string, void, never>();
		const preWarmFibers = yield* FiberMap.make<
			string,
			void,
			ProviderInstanceFailure
		>();
		let instance: RunnerProviderInstance | undefined;
		const dispose = yield* Effect.cached(
			Effect.suspend(() => (instance ? instance.disposeEffect() : Effect.void)),
		);
		const shutdown = Effect.uninterruptible(dispose);
		const runner = yield* makeRunner((output, sessionId) =>
			instance
				? instance.handleOutputEffect(output, sessionId)
				: Effect.succeed({}),
		);
		instance = new RunnerProviderInstance(
			deps,
			driver,
			runner,
			abortFibers,
			interactionFibers,
			preWarmFibers,
			providerScope,
			shutdown,
		);
		yield* Effect.addFinalizer(() => shutdown.pipe(Effect.ignore));
		return instance;
	});

/** Provider API compatibility and event-store interaction routing only. */
export class RunnerProviderInstance implements ProviderInstance {
	readonly providerId: KnownProviderDriverKind;
	readonly steering: boolean;
	private readonly sinks = new Map<string, EventSink>();
	/** Sends handed to the runner and not yet finished, per session. */
	private readonly sendsInFlight = new Map<string, number>();
	private detachingInteractions = false;
	private recoveredSink: ((sessionId: string) => EventSink) | undefined;
	private readonly recoveredSinkIds = new Set<string>();
	private readonly recoveredRequests = new Map<
		string,
		Deferred.Deferred<void>
	>();

	readonly recoverRunnerEffect = Effect.gen(this, function* () {
		const sql = yield* SqlClient.SqlClient;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const pending = yield* PendingInteractionServiceTag;
		const timeoutRuntime = yield* Effect.runtime<OverridesStateTag>();
		// An in-process runner's turns ended with the relay that ran them, so
		// every running command is unclaimed. Runner processes may outlive it.
		let claimed = new Set<string>();
		if (this.runner.recoverEffect) {
			this.recoveredSink = (sessionId) =>
				makeRecoveredEventSink({
					driverKind: this.providerId,
					sessionId,
					sql,
					ingestion,
					pending,
					timeoutHooks: makeProcessingTimeoutHooks(timeoutRuntime, sessionId),
					onRegistered: (id) => {
						const ready = this.recoveredRequests.get(id);
						return ready ? Deferred.succeed(ready, undefined) : Effect.void;
					},
				});
			yield* this.runner.recoverEffect;
			const registrations = yield* Effect.try(() =>
				discoverRunners(this.deps.workspaceRoot, this.deps.daemonConfigDir),
			).pipe(
				Effect.catchAll((error) =>
					Effect.logError("Could not verify runner ownership", error).pipe(
						Effect.as(undefined),
					),
				),
			);
			// Discovery errors are not proof that a running command has no owner.
			if (!registrations) return;
			claimed = new Set(
				registrations
					.filter((runner) => runner.driverKind === this.providerId)
					.map((runner) => runner.sessionId),
			);
		}
		const accounts = yield* this.deps.accounts;
		yield* settleUnclaimedRunnerCommands(
			sql,
			claimed,
			this.providerId,
			(id) =>
				Either.getOrUndefined(resolveAccount(accounts, { _tag: "Id", id }))
					?.driver,
			(sinkId, turn, failure) =>
				Effect.gen(this, function* () {
					let persistenceError: ProviderRuntimeIngestionError | undefined;
					yield* failRunnerTurn(
						(output) =>
							Effect.gen(function* () {
								if (output.type === "event") {
									// Startup has no WebSocket publisher or live sink yet.
									yield* ingestion.ingestBatch([output.event], {
										publishToBus: false,
										publishToRelay: false,
									});
								} else if (output.type === "cancel-interactions") {
									yield* pending.cancelSessionInteractions(
										turn.sessionId,
										output.reason,
										{ recoverQuestions: false },
									);
								}
								return {};
							}).pipe(
								Effect.tapError((error) =>
									Effect.sync(() => {
										persistenceError = error;
									}),
								),
								Effect.mapError((error) =>
									sessionFailure("recover stopped runner", error),
								),
							),
						sinkId,
						turn,
						failure,
						this.providerId,
					);
					// failRunnerTurn logs errors; database failures still need a retry.
					if (persistenceError) return yield* Effect.fail(persistenceError);
				}),
		);
	});

	constructor(
		private readonly deps: RunnerProviderInstanceDeps,
		private readonly driver: RunnerDriverPieces,
		private readonly runner: SessionRunner,
		private readonly abortFibers: FiberMap.FiberMap<string, void, never>,
		private readonly interactionFibers: FiberMap.FiberMap<string, void, never>,
		private readonly preWarmFibers: FiberMap.FiberMap<
			string,
			void,
			ProviderInstanceFailure
		>,
		private readonly providerScope: Scope.Scope,
		private readonly shutdown: Effect.Effect<void, ProviderInstanceFailure>,
	) {
		this.providerId = driver.driverKind;
		this.steering = driver.steering;
	}

	recoverEffect() {
		return this.recoverRunnerEffect;
	}

	private commandEffect(
		command: Extract<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, ProviderInstanceFailure>;
	private commandEffect(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, ProviderInstanceFailure>;
	private commandEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, ProviderInstanceFailure> {
		return this.runner.executeEffect(command).pipe(
			Effect.mapError(
				(failure) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: failure.operation,
						cause: Object.assign(new Error(failure.message), failure),
					}),
			),
		);
	}

	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> {
		return this.driver.discoverEffect(workspaceRoot, account, options);
	}

	getNativeSessionEffect(
		sessionId: string,
	): Effect.Effect<ProviderNativeSession | undefined> {
		return (
			(this.driver.nativeSession
				? this.runner.getNativeSessionEffect?.(sessionId)
				: undefined) ?? Effect.succeed(undefined)
		);
	}

	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		return Effect.gen(this, function* () {
			const { eventSink, abortSignal, ...payload } = input;
			const prepared = yield* this.driver.prepareTurnEffect(payload);
			const { sessionId } = input;
			return yield* Effect.acquireUseRelease(
				Effect.sync(() => {
					const inFlight = this.sendsInFlight.get(sessionId) ?? 0;
					this.sendsInFlight.set(sessionId, inFlight + 1);
					return inFlight;
				}),
				(inFlight) =>
					Effect.gen(this, function* () {
						// An idle send is placed before the runner hop, as fast as a
						// local write; the runner places a held send when the SDK
						// starts it (command_lifecycle: started). A continuation places
						// nothing: it resumes the cut-off message's turn.
						if (inFlight === 0 && !input.continuation)
							yield* this.placeUserMessageEffect({
								sessionId,
								inputId: input.inputId,
								text: input.text ?? input.prompt,
							}).pipe(
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: this.providerId,
											operation: "sendTurn",
											cause,
										}),
								),
							);
						// The SDK reports busy only once the model streams, so SDK-local
						// work (a manual /compact, a slash command) ran with the session
						// idle until its result. A send to an idle session starts its
						// turn now; the turn's end reports idle as before.
						if (inFlight === 0)
							yield* eventSink
								.push({
									eventId: createEventId(),
									type: "session.status",
									providerId: this.providerId,
									sessionId,
									providerRefs: {},
									rawSource: { kind: `${this.providerId}.provider-runtime` },
									createdAt: Date.now(),
									data: { sessionId, status: "busy" },
								})
								.pipe(Effect.ignore);
						const sinkId = runnerSinkId(
							input.inputId,
							input.commandAttempt,
							input.nativeResumeFallback,
						);
						this.sinks.set(sinkId, eventSink);
						bindTurnTimelineSink(sinkId, {
							sessionId,
							inputId: input.inputId,
						});
						this.reportSinkForTesting("allocated", sinkId, sessionId);
						const aborted = Effect.async<void>((resume) => {
							const onAbort = () => resume(Effect.void);
							if (abortSignal.aborted) onAbort();
							else
								abortSignal.addEventListener("abort", onAbort, { once: true });
							return Effect.sync(() =>
								abortSignal.removeEventListener("abort", onAbort),
							);
						});
						yield* FiberMap.run(
							this.abortFibers,
							sinkId,
							aborted.pipe(
								Effect.andThen(
									this.runner.executeEffect({ type: "abort", sinkId }),
								),
								Effect.ignore,
							),
						);
						return yield* this.commandEffect({
							type: "send-turn",
							sinkId,
							aborted: abortSignal.aborted,
							...prepared,
						});
					}),
				() =>
					Effect.sync(() => {
						const remaining = (this.sendsInFlight.get(sessionId) ?? 1) - 1;
						if (remaining > 0) this.sendsInFlight.set(sessionId, remaining);
						else this.sendsInFlight.delete(sessionId);
					}),
			);
		});
	}

	/** Places a send's user message once; only a missing session fails it. */
	private placeUserMessageEffect(input: {
		readonly sessionId: string;
		readonly inputId: string;
		readonly text: string;
	}): Effect.Effect<void, ClaudeEventPersistFailure> {
		return Effect.gen(this, function* () {
			const persist = yield* Effect.serviceOption(ClaudeEventPersistEffectTag);
			const persistUserMessage =
				this.deps.persistUserMessage ??
				(persist._tag === "Some"
					? persist.value.persistUserMessage
					: undefined);
			if (!persistUserMessage) return;
			yield* persistUserMessage(input.sessionId, input.text, {
				messageId: input.inputId,
				inputId: input.inputId,
				provider: this.providerId,
			}).pipe(
				Effect.catchIf(
					(error) => error._tag !== "ClaudeSessionLifecycleError",
					(error) =>
						Effect.sync(() =>
							log.warn(
								`Non-fatal persistence error for runner user message: ${formatErrorDetail(error)}`,
							),
						),
				),
			);
		});
	}

	preWarmSessionEffect(
		input: PreWarmSessionInput,
	): Effect.Effect<void, ProviderInstanceFailure> {
		const prepare = this.driver.preparePreWarmEffect;
		if (!prepare) return Effect.void;
		const preWarm = Effect.gen(this, function* () {
			const command = yield* prepare(input, this.providerScope);
			if (command) yield* this.commandEffect(command);
		});
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen(this, function* () {
				const runPreWarm = yield* FiberMap.runtime(this.preWarmFibers)();
				const fiber = yield* Effect.sync(() => {
					const existing = FiberMap.unsafeGet(
						this.preWarmFibers,
						input.sessionId,
					);
					return Option.isSome(existing)
						? existing.value
						: runPreWarm(input.sessionId, Effect.interruptible(preWarm), {
								onlyIfMissing: true,
							});
				});
				const exit = yield* restore(Fiber.await(fiber)).pipe(
					Effect.onInterrupt(() => Fiber.interrupt(fiber)),
				);
				if (Exit.isSuccess(exit)) return;
				return yield* Cause.isInterruptedOnly(exit.cause)
					? Effect.fail(
							new ProviderInstanceFailure({
								providerId: this.providerId,
								operation: "preWarmSession",
								cause: new Error("Session pre-warm was cancelled"),
							}),
						)
					: Effect.failCause(exit.cause);
			}),
		);
	}

	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return FiberMap.remove(this.preWarmFibers, sessionId).pipe(
			Effect.andThen(this.commandEffect({ type: "interrupt", sessionId })),
		);
	}
	stopTaskEffect(
		sessionId: string,
		taskId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.driver.stopTask
			? this.commandEffect({ type: "stop-task", sessionId, taskId })
			: Effect.void;
	}
	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-permission",
			sessionId,
			requestId,
			decision,
		});
	}
	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-question",
			sessionId,
			requestId,
			answers,
		});
	}
	applyLiveSettingsEffect(
		sessionId: string,
		settings: {
			readonly modelId?: string | undefined;
			readonly contextWindow?: string | undefined;
			readonly variant?: string | undefined;
		},
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "apply-live-settings",
			sessionId,
			settings,
		});
	}
	setPermissionModeEffect(
		sessionId: string,
		mode: SessionPermissionMode,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "apply-live-settings",
			sessionId,
			settings: { permissionMode: mode },
		});
	}
	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return FiberMap.remove(this.preWarmFibers, sessionId).pipe(
			Effect.andThen(this.commandEffect({ type: "end-session", sessionId })),
		);
	}
	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return this.shutdown;
	}

	/** Shared by explicit shutdown and scope disposal through one cached Effect. */
	disposeEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return Effect.gen(this, function* () {
			this.detachingInteractions = true;
			for (const sink of this.sinks.values()) {
				yield* sink.detachInteractions?.() ?? Effect.void;
			}
			yield* FiberMap.clear(this.preWarmFibers);
			yield* this.commandEffect({ type: "shutdown" });
		}).pipe(
			Effect.ensuring(
				Effect.gen(this, function* () {
					this.sinks.clear();
					yield* FiberMap.clear(this.abortFibers);
					yield* FiberMap.clear(this.interactionFibers);
				}),
			),
		);
	}

	private reportSinkForTesting(
		phase: "allocated" | "released",
		sinkId: string,
		sessionId: string | undefined,
	): void {
		if (
			process.env["NODE_ENV"] === "test" &&
			process.env["CONDUIT_TEST_UPGRADE_SINK_PROOF"] === "1" &&
			process.connected
		)
			process.send?.({
				channel: "conduit-process-test",
				kind: "runtime-sink",
				phase,
				sinkId,
				sessionId,
				activeSinks: this.sinks.size,
			});
	}

	handleOutputEffect(
		output: SessionOutput,
		recoveredSessionId?: string,
	): Effect.Effect<SessionOutputReply, SessionFailure> {
		return Effect.gen(this, function* () {
			observeTurnTimelineFrame(output);
			if (output.type === "background-task") {
				this.deps.onBackgroundTask?.(output.transition);
				return;
			}
			let sink = this.sinks.get(output.sinkId);
			if (!sink && recoveredSessionId && this.recoveredSink) {
				sink = this.recoveredSink(recoveredSessionId);
				this.sinks.set(output.sinkId, sink);
				this.recoveredSinkIds.add(output.sinkId);
				this.reportSinkForTesting(
					"allocated",
					output.sinkId,
					recoveredSessionId,
				);
			}
			if (!sink) return;
			if (this.detachingInteractions)
				yield* sink.detachInteractions?.() ?? Effect.void;
			switch (output.type) {
				case "event":
					return yield* sink
						.push(output.event)
						.pipe(Effect.mapError((cause) => sessionFailure("push", cause)));
				case "permission-request":
				case "question-request": {
					const registered = this.recoveredSinkIds.has(output.sinkId)
						? yield* Deferred.make<void>()
						: undefined;
					if (registered)
						this.recoveredRequests.set(output.request.requestId, registered);
					const request = Effect.suspend(() =>
						output.type === "permission-request"
							? sink.requestPermission(output.request).pipe(
									Effect.flatMap((response) =>
										this.runner.executeEffect({
											type: "answer-permission",
											sinkId: output.sinkId,
											requestId: output.request.requestId,
											response,
										}),
									),
								)
							: sink.requestQuestion(output.request).pipe(
									Effect.flatMap((answers) =>
										this.runner.executeEffect({
											type: "answer-question",
											sinkId: output.sinkId,
											requestId: output.request.requestId,
											answers,
										}),
									),
								),
					);
					yield* FiberMap.run(
						this.interactionFibers,
						`${output.sinkId}:${output.request.requestId}`,
						request.pipe(
							Effect.onExit((exit) =>
								Effect.gen(this, function* () {
									if (
										Exit.isFailure(exit) &&
										!Cause.isInterruptedOnly(exit.cause)
									) {
										yield* this.runner
											.executeEffect({
												type: "interaction-failed",
												sinkId: output.sinkId,
												requestId: output.request.requestId,
												kind:
													output.type === "permission-request"
														? "permission"
														: "question",
												failure: sessionFailure(
													"request interaction",
													Cause.squash(exit.cause),
												),
											})
											.pipe(Effect.ignore);
									}
								}),
							),
							Effect.catchAllCause(() => Effect.void),
						),
					);
					if (registered) {
						yield* Deferred.await(registered);
						this.recoveredRequests.delete(output.request.requestId);
					}
					return;
				}
				case "resolve-permission":
					return yield* sink
						.resolvePermission(output.requestId, output.response)
						.pipe(
							Effect.mapError((cause) =>
								sessionFailure("resolvePermission", cause),
							),
						);
				case "resolve-question":
					return yield* sink
						.resolveQuestion(output.requestId, output.answers)
						.pipe(
							Effect.mapError((cause) =>
								sessionFailure("resolveQuestion", cause),
							),
						);
				case "cancel-interactions":
					return yield* Effect.suspend(
						() =>
							sink.cancelSessionInteractions?.(output.reason, {
								recoverQuestions: output.recoverQuestions,
							}) ?? Effect.void,
					).pipe(Effect.catchAllCause(() => Effect.void));
				case "cancel-interaction":
					return yield* FiberMap.remove(
						this.interactionFibers,
						`${output.sinkId}:${output.requestId}`,
					);
				case "release-sink":
					for (const [key] of Array.from(this.interactionFibers)) {
						if (key.startsWith(`${output.sinkId}:`)) {
							yield* FiberMap.remove(this.interactionFibers, key);
						}
					}
					this.sinks.delete(output.sinkId);
					this.recoveredSinkIds.delete(output.sinkId);
					yield* FiberMap.remove(this.abortFibers, output.sinkId);
					this.reportSinkForTesting(
						"released",
						output.sinkId,
						recoveredSessionId,
					);
					return;
				case "place-user-message":
					return yield* this.placeUserMessageEffect(output.input).pipe(
						Effect.mapError((cause) => sessionFailure(output.type, cause)),
					);
				case "ensure-subagent-session": {
					const persist = yield* Effect.serviceOption(
						ClaudeEventPersistEffectTag,
					);
					const ensureSession =
						this.deps.ensureChildSession ??
						(persist._tag === "Some"
							? persist.value.ensureClaudeSubagentSession
							: undefined);
					return yield* ensureSession?.({
						...output.input,
						provider: this.providerId,
					}).pipe(
						Effect.mapError((cause) => sessionFailure(output.type, cause)),
					) ?? Effect.void;
				}
			}
		}).pipe(
			Effect.as({}),
			Effect.catchAllDefect((cause) =>
				Effect.fail(sessionFailure(output.type, cause)),
			),
		);
	}
}
