import { randomUUID } from "node:crypto";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberMap,
	Option,
	type Scope,
} from "effect";
import { SqlClient } from "effect/sql";
import type { AccountsState } from "../../account-directory.js";
import type { Account } from "../../contracts/account.js";
import type { KnownProviderDriverKind } from "../../contracts/provider-instance.js";
import {
	bindTurnTimelineSink,
	observeTurnTimelineFrame,
} from "../../domain/daemon/Services/turn-timeline.js";
import type { PendingInteractionService } from "../../domain/relay/Services/pending-interaction-service.js";
import type {
	ProviderRuntimeIngestion,
	ProviderRuntimeIngestionError,
} from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { formatErrorDetail } from "../../errors-utils.js";
import { createLogger } from "../../logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
	type ClaudeEventPersistFailure,
} from "../../persistence/effect/claude-event-persist-effect.js";
import type { makeRetireReplacedProcessPrompts } from "../../persistence/effect/retire-pending-prompts.js";
import type { BackgroundTaskTransition } from "../../session/background-liveness.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { OrchestrationEngine } from "../orchestration-engine.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { RelayEventSinkDeps } from "../relay-event-sink.js";
import type {
	EventSink,
	PermissionDecision,
	PreWarmSessionInput,
	ProviderCall,
	ProviderCapabilities,
	ProviderControlCommandStatus,
	ProviderControlContext,
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
import { discoverAllRunners } from "./runner-registry.js";
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

/** Check every owner, including one retained across an account rebind. */
export const assertSessionRunnerAvailable = (
	sessionId: string,
	registry: ProviderRegistry | undefined,
) =>
	Effect.gen(function* () {
		for (const providerId of registry?.listProviders() ?? []) {
			const provider = registry?.getInstance(providerId);
			if (!(provider instanceof RunnerProviderInstance)) continue;
			const failure = yield* provider.getSessionFailureEffect(sessionId);
			if (failure)
				return yield* new ProviderInstanceFailure({
					providerId,
					operation: failure.operation,
					cause: Object.assign(new Error(failure.message), failure),
				});
		}
	});

type PreparedTurn = Omit<
	Extract<SessionCommand, { type: "send-turn" }>,
	"type" | "sinkId" | "aborted"
>;

/** Provider policy only; sink, interaction and runner lifetime belong to the instance. */
export interface RunnerDriverPieces {
	readonly driverKind: KnownProviderDriverKind;
	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
		call?: ProviderCall,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure>;
	readonly generateTextEffect: ProviderInstance["generateTextEffect"];
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

export interface RunnerRecoveryDependencies {
	readonly projectId: string;
	readonly ingestion: ProviderRuntimeIngestion;
	readonly pending: PendingInteractionService;
	readonly timeoutHooks: Pick<
		RelayEventSinkDeps,
		"clearTimeout" | "resetTimeout"
	>;
	readonly persist: ClaudeEventPersistEffect;
	readonly resolveCallContext: OrchestrationEngine["resolveCallContextEffect"];
	readonly retirePrompts: (
		currentProcessId: string | null,
		options?: {
			readonly expiredProcessId?: string;
			readonly exceptCommandId?: string;
		},
	) => ReturnType<Effect.Success<typeof makeRetireReplacedProcessPrompts>>;
}

export interface RunnerProviderInstanceDeps {
	readonly accountResources?: {
		readonly use: <A, E, R>(
			account: Account,
			work: (account: Account) => Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | ProviderInstanceFailure, R>;
	};
	readonly accounts: Effect.Effect<AccountsState>;
	readonly autoSettleAfterDays?: Effect.Effect<number | null | undefined>;
	readonly daemonConfigDir?: string;
	readonly projectRootForSession?: (
		sessionId: string,
		projectId?: string,
	) => Effect.Effect<string | undefined>;
	readonly recoveryForSession?: (
		sessionId: string,
	) => Effect.Effect<RunnerRecoveryDependencies | undefined>;
	readonly onBackgroundTask?: (input: BackgroundTaskTransition) => void;
	readonly ensureChildSession?: ClaudeEventPersistEffect["ensureClaudeSubagentSession"];
	readonly readSubagentTranscript?: ClaudeEventPersistEffect["readClaudeSubagentTranscript"];
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
		const accountResourceFibers = yield* FiberMap.make<string, void, never>();
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
			accountResourceFibers,
			providerScope,
			shutdown,
		);
		yield* Effect.addFinalizer(() => shutdown.pipe(Effect.ignore));
		return instance;
	});

/** Provider API compatibility and event-store interaction routing only. */
export class RunnerProviderInstance implements ProviderInstance {
	readonly providerId: KnownProviderDriverKind;
	private readonly sinks = new Map<string, EventSink>();
	private readonly sinkSessions = new Map<string, string>();
	private detachingInteractions = false;
	private recoveredSink:
		| ((
				sessionId: string,
				sinkId: string,
		  ) => Effect.Effect<EventSink | undefined>)
		| undefined;
	private readonly recoveredSinkIds = new Set<string>();
	private readonly recoveredRequests = new Map<
		string,
		Deferred.Deferred<void>
	>();

	private recoverWithContexts = (
		recoveryForSession: NonNullable<
			RunnerProviderInstanceDeps["recoveryForSession"]
		>,
		sessionIds?: ReadonlySet<string>,
		ownsPendingSend?: OrchestrationEngine["ownsPendingSend"],
	) =>
		Effect.gen({ self: this }, function* () {
			const sql = yield* SqlClient.SqlClient;
			// An in-process runner's turns ended with the relay that ran them, so
			// every running command is unclaimed. Runner processes may outlive it.
			let claimed = new Set<string>();
			if (this.runner.recoverEffect) {
				this.recoveredSink = (sessionId, sinkId) =>
					Effect.gen({ self: this }, function* () {
						const recovery = yield* recoveryForSession(sessionId);
						if (!recovery) return undefined;
						return makeRecoveredEventSink({
							driverKind: this.providerId,
							sessionId,
							sql,
							ingestion: recovery.ingestion,
							pending: recovery.pending,
							timeoutHooks: recovery.timeoutHooks,
							onRegistered: (id) => {
								const ready = this.recoveredRequests.get(
									JSON.stringify([sinkId, id]),
								);
								return ready ? Deferred.succeed(ready, undefined) : Effect.void;
							},
						});
					});
				yield* sessionIds
					? (this.runner.attachSessionsEffect?.([...sessionIds]) ?? Effect.void)
					: this.runner.recoverEffect;
				const registrations = yield* Effect.try(() =>
					discoverAllRunners(this.deps.daemonConfigDir),
				).pipe(
					Effect.catch((error) =>
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
			const sessions = yield* sql<{
				id: string;
				provider: string;
			}>`SELECT id, provider FROM sessions`;
			for (const session of sessions) {
				if (sessionIds && !sessionIds.has(session.id)) continue;
				const driver =
					accounts.accounts.find((account) => account.id === session.provider)
						?.driver ??
					accounts.deleted.find((account) => account.id === session.provider)
						?.driver;
				if (
					!claimed.has(session.id) &&
					(driver ?? session.provider) === this.providerId
				) {
					const recovery = yield* recoveryForSession(session.id);
					if (recovery) yield* recovery.retirePrompts(null);
				}
			}
			for (const sessionId of claimed) {
				if (sessionIds && !sessionIds.has(sessionId)) continue;
				const native = yield* this.runner.getNativeSessionEffect?.(sessionId) ??
					Effect.succeed(undefined);
				const account = accounts.accounts.find(
					(account) => account.id === native?.instanceId,
				);
				if (
					account &&
					(yield* this.runner.hasDemandEffect?.(sessionId) ??
						Effect.succeed(false))
				)
					yield* this.withAccountResources(
						account,
						sessionId,
						() => Effect.void,
					);
			}
			yield* settleUnclaimedRunnerCommands(
				sql,
				claimed,
				this.providerId,
				(id) =>
					accounts.accounts.find((account) => account.id === id)?.driver ??
					accounts.deleted.find((account) => account.id === id)?.driver,
				(sinkId, turn, failure, beforeProject) =>
					Effect.gen({ self: this }, function* () {
						const recovery = yield* recoveryForSession(turn.sessionId);
						if (!recovery) return;
						const requestIds = new Set([
							...(yield* recovery.pending.listPendingPermissions(
								turn.sessionId,
							)).map((request) => request.requestId),
							...(yield* recovery.pending.listPendingQuestions(
								turn.sessionId,
							)).map((request) => request.requestId),
						]);
						let persistenceError: ProviderRuntimeIngestionError | undefined;
						yield* failRunnerTurn(
							(output) =>
								Effect.gen(function* () {
									if (output.type === "event") {
										// Startup has no WebSocket publisher or live sink yet.
										yield* recovery.ingestion.ingestBatch([output.event], {
											publishToBus: false,
											publishToRelay: false,
											...(output.event.type === "turn.error"
												? {
														beforeProject,
														beforeCommit:
															recovery.pending.cancelSessionInteractions(
																turn.sessionId,
																failure.message,
																{ recoverQuestions: false, requestIds },
															),
													}
												: {}),
										});
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
							accounts.accounts.some((account) => account.id === turn.accountId)
								? failure
								: {
										operation: "recover stopped runner",
										message: `${this.providerId} account "${turn.accountId}" is unavailable`,
										code: "account_unavailable",
										retryable: false,
									},
							this.providerId,
						);
						// failRunnerTurn logs errors; database failures still need a retry.
						if (persistenceError) return yield* Effect.fail(persistenceError);
					}),
				recoveryForSession,
				sessionIds,
				ownsPendingSend,
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
		private readonly accountResourceFibers: FiberMap.FiberMap<
			string,
			void,
			never
		>,
		private readonly providerScope: Scope.Scope,
		private readonly shutdown: Effect.Effect<void, ProviderInstanceFailure>,
	) {
		this.providerId = driver.driverKind;
	}

	recoverProjectContextsEffect(
		recoveryForSession: NonNullable<
			RunnerProviderInstanceDeps["recoveryForSession"]
		>,
	) {
		return this.recoverWithContexts(recoveryForSession);
	}

	attachSessionsEffect(
		sessionIds: readonly string[],
		recoveryForSession: NonNullable<
			RunnerProviderInstanceDeps["recoveryForSession"]
		>,
		ownsPendingSend?: OrchestrationEngine["ownsPendingSend"],
	) {
		return this.recoverWithContexts(
			recoveryForSession,
			new Set(sessionIds),
			ownsPendingSend,
		);
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
						...(failure.code === "provider_process_gone" ||
						(command.type === "send-turn" && failure.code === "runner_detached")
							? { code: failure.code }
							: {}),
					}),
			),
		);
	}

	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
		call?: ProviderCall,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> {
		return this.driver.discoverEffect(workspaceRoot, account, options, call);
	}

	generateTextEffect(
		input: Parameters<ProviderInstance["generateTextEffect"]>[0],
	): Effect.Effect<string, ProviderInstanceFailure> {
		return this.driver.generateTextEffect(input);
	}

	hasLiveProcessEffect(
		sessionId: string,
		processId?: string,
	): Effect.Effect<boolean> {
		return this.runner.hasLiveProcessEffect(sessionId, processId);
	}

	getControlProcessIdEffect(
		sessionId: string,
	): Effect.Effect<string | undefined, ProviderInstanceFailure> {
		return Effect.gen({ self: this }, function* () {
			const failure = yield* this.getSessionFailureEffect(sessionId);
			if (failure)
				return yield* new ProviderInstanceFailure({
					providerId: this.providerId,
					operation: "getControlProcessId",
					code: "provider_process_unavailable",
					cause: new Error(failure.message),
				});
			return yield* this.runner.getControlProcessIdEffect?.(sessionId) ??
				Effect.succeed(undefined);
		});
	}

	getSessionFailureEffect(sessionId: string) {
		return (
			this.runner.getSessionFailureEffect?.(sessionId) ??
			Effect.succeed(undefined)
		);
	}

	getControlCommandStatusEffect(
		sessionId: string,
		control: ProviderControlContext,
	): Effect.Effect<ProviderControlCommandStatus, ProviderInstanceFailure> {
		return (
			this.runner.getControlCommandStatusEffect?.(sessionId, control) ??
			Effect.fail(
				sessionFailure(
					"get control command status",
					"Runner cannot reconcile commands",
				),
			)
		).pipe(
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
		return input.account
			? this.withAccountResources(
					input.account,
					input.sessionId,
					(account) => this.sendTurnUnscopedEffect({ ...input, account }),
					runnerSinkId(
						input.inputId,
						input.commandAttempt,
						input.nativeResumeFallback,
					),
				)
			: this.sendTurnUnscopedEffect(input);
	}

	private withAccountResources<A>(
		admitted: Account,
		sessionId: string,
		operation: (account: Account) => Effect.Effect<A, ProviderInstanceFailure>,
		sinkId?: string,
	): Effect.Effect<A, ProviderInstanceFailure> {
		const resources = this.deps.accountResources;
		if (!resources) return operation(admitted);
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen({ self: this }, function* () {
				const reply = yield* Deferred.make<A, ProviderInstanceFailure>();
				let callerCancelled = false;
				const work = resources
					.use(admitted, (account) =>
						Effect.gen({ self: this }, function* () {
							const result = yield* operation(account);
							yield* Deferred.succeed(reply, result);
							// Intake can precede the end of the native turn by hours. The runner's
							// quiescence also counts questions, approvals and background finalizers.
							while (
								yield* this.runner.hasDemandEffect?.(sessionId) ??
									Effect.succeed(false)
							) {
								const native = yield* this.runner.getNativeSessionEffect?.(
									sessionId,
								) ?? Effect.succeed(undefined);
								if (native && native.instanceId !== admitted.id) break;
								yield* Effect.sleep("25 millis");
							}
						}),
					)
					.pipe(
						Effect.onInterrupt(() =>
							Effect.gen({ self: this }, function* () {
								if (this.detachingInteractions) return;
								if (sinkId)
									yield* this.runner
										.executeEffect({ type: "abort", sinkId })
										.pipe(Effect.ignore);
								const native = yield* this.runner.getNativeSessionEffect?.(
									sessionId,
								) ?? Effect.succeed(undefined);
								if (
									!callerCancelled &&
									(native?.instanceId === admitted.id || (!native && !sinkId))
								)
									yield* this.runner
										.executeEffect({ type: "end-session", sessionId })
										.pipe(Effect.ignore);
							}),
						),
						Effect.onExit((exit) =>
							Exit.isFailure(exit)
								? Deferred.failCause(reply, exit.cause)
								: Effect.void,
						),
						Effect.catchCause(() => Effect.void),
					);
				const fiber = yield* FiberMap.run(
					this.accountResourceFibers,
					randomUUID(),
					Effect.interruptible(work),
				);
				return yield* restore(Deferred.await(reply)).pipe(
					Effect.onInterrupt(() =>
						Effect.sync(() => {
							callerCancelled = true;
						}).pipe(Effect.andThen(Fiber.interrupt(fiber))),
					),
				);
			}),
		);
	}

	private sendTurnUnscopedEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		const {
			eventSink,
			abortSignal,
			awaitIntake: _awaitIntake,
			...payload
		} = input;
		const { sessionId } = input;
		const sinkId = runnerSinkId(
			input.inputId,
			input.commandAttempt,
			input.nativeResumeFallback,
		);
		const send = Effect.gen({ self: this }, function* () {
			const prepared = yield* this.driver.prepareTurnEffect(payload);
			this.sinks.set(sinkId, eventSink);
			this.sinkSessions.set(sinkId, sessionId);
			bindTurnTimelineSink(sinkId, {
				sessionId,
				inputId: input.inputId,
			});
			this.reportSinkForTesting("allocated", sinkId, sessionId);
			const aborted = Effect.callback<void>((resume) => {
				const onAbort = () => resume(Effect.void);
				if (abortSignal.aborted) onAbort();
				else abortSignal.addEventListener("abort", onAbort, { once: true });
				return Effect.sync(() =>
					abortSignal.removeEventListener("abort", onAbort),
				);
			});
			yield* FiberMap.run(
				this.abortFibers,
				sinkId,
				aborted.pipe(
					Effect.andThen(this.runner.executeEffect({ type: "abort", sinkId })),
					Effect.ignore,
				),
			);
			return yield* this.commandEffect({
				type: "send-turn",
				sinkId,
				aborted: abortSignal.aborted,
				...prepared,
			});
		});
		return (this.runner.withTurnEffect?.(payload, sinkId, send) ?? send).pipe(
			Effect.mapError((cause) =>
				cause instanceof ProviderInstanceFailure
					? cause
					: new ProviderInstanceFailure({
							providerId: this.providerId,
							operation: cause.operation,
							cause,
						}),
			),
		);
	}

	/** Places a send's user message once; only a missing session fails it. */
	private placeUserMessageEffect(input: {
		readonly sessionId: string;
		readonly inputId: string;
		readonly text: string;
		readonly runId?: string;
		readonly images?: readonly string[];
	}): Effect.Effect<void, ClaudeEventPersistFailure> {
		return Effect.gen({ self: this }, function* () {
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
				...(input.runId ? { runId: input.runId } : {}),
				...(input.images ? { images: input.images } : {}),
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
		const warm = (input: PreWarmSessionInput) =>
			Effect.gen({ self: this }, function* () {
				const command = yield* prepare(input, this.providerScope);
				if (command) yield* this.commandEffect(command);
			});
		const preWarm = input.account
			? this.withAccountResources(input.account, input.sessionId, (account) =>
					warm({ ...input, account }),
				)
			: warm(input);
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen({ self: this }, function* () {
				const runPreWarm = yield* FiberMap.runtime(this.preWarmFibers)();
				const fiber = yield* Effect.sync(() => {
					const existing = FiberMap.getUnsafe(
						this.preWarmFibers,
						input.sessionId,
					);
					if (Option.isSome(existing)) {
						if (
							process.env["NODE_ENV"] === "test" &&
							process.env["CONDUIT_TEST_UPGRADE_SINK_PROOF"] === "1" &&
							process.connected
						)
							process.send?.({
								channel: "conduit-process-test",
								kind: "pre-warm-joined",
								sessionId: input.sessionId,
							});
						return existing.value;
					}
					return runPreWarm(input.sessionId, Effect.interruptible(preWarm), {
						onlyIfMissing: true,
					});
				});
				const exit = yield* restore(Fiber.await(fiber)).pipe(
					Effect.onInterrupt(() => Fiber.interrupt(fiber)),
				);
				if (Exit.isSuccess(exit)) return;
				return yield* Failure.isInterruptedOnly(exit.cause)
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
		turnIds?: readonly string[],
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		// A bound Stop must leave a pre-warm for a replacement turn alone.
		return (
			turnIds === undefined
				? FiberMap.remove(this.preWarmFibers, sessionId)
				: Effect.void
		).pipe(
			Effect.andThen(
				this.commandEffect({
					type: "interrupt",
					sessionId,
					...(control ? { control } : {}),
					...(call ? { call } : {}),
					...(turnIds !== undefined ? { turnIds } : {}),
				}),
			),
		);
	}
	stopTaskEffect(
		sessionId: string,
		taskId: string,
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.driver.stopTask
			? this.commandEffect({
					type: "stop-task",
					sessionId,
					taskId,
					...(call ? { call } : {}),
				})
			: Effect.void;
	}
	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
		_providerProcessId?: string,
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-permission",
			sessionId,
			...(control ? { control } : {}),
			...(call ? { call } : {}),
			requestId,
			decision,
		});
	}
	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-question",
			sessionId,
			...(control ? { control } : {}),
			...(call ? { call } : {}),
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
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "apply-live-settings",
			sessionId,
			...(call ? { call } : {}),
			settings,
		});
	}
	setPermissionModeEffect(
		sessionId: string,
		mode: SessionPermissionMode,
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "apply-live-settings",
			sessionId,
			...(call ? { call } : {}),
			settings: { permissionMode: mode },
		});
	}
	endSessionEffect(
		sessionId: string,
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return FiberMap.remove(this.preWarmFibers, sessionId).pipe(
			Effect.andThen(
				this.commandEffect({
					type: "end-session",
					sessionId,
					...(control ? { control } : {}),
					...(call ? { call } : {}),
				}),
			),
		);
	}
	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return this.shutdown;
	}

	/** Project scopes release their attachments without closing the shared driver. */
	releaseSessionsEffect(sessionIds: readonly string[]): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			const sessions = new Set(sessionIds);
			for (const sessionId of sessions) {
				yield* FiberMap.remove(this.preWarmFibers, sessionId);
				yield* this.runner.detachSessionEffect?.(sessionId) ??
					this.runner
						.executeEffect({ type: "end-session", sessionId })
						.pipe(Effect.ignore);
			}
			for (const [sinkId, sessionId] of this.sinkSessions) {
				if (!sessions.has(sessionId)) continue;
				yield* this.sinks.get(sinkId)?.detachInteractions?.() ?? Effect.void;
				for (const [key] of Array.from(this.interactionFibers))
					if (key.startsWith(`${sinkId}:`))
						yield* FiberMap.remove(this.interactionFibers, key);
				yield* FiberMap.remove(this.abortFibers, sinkId);
				this.sinks.delete(sinkId);
				this.sinkSessions.delete(sinkId);
				this.recoveredSinkIds.delete(sinkId);
				this.reportSinkForTesting("released", sinkId, sessionId);
			}
		});
	}

	/** Shared by explicit shutdown and scope disposal through one cached Effect. */
	disposeEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return Effect.gen({ self: this }, function* () {
			this.detachingInteractions = true;
			for (const sink of this.sinks.values()) {
				yield* sink.detachInteractions?.() ?? Effect.void;
			}
			yield* FiberMap.clear(this.preWarmFibers);
			yield* this.commandEffect({ type: "shutdown" });
		}).pipe(
			Effect.ensuring(
				Effect.gen({ self: this }, function* () {
					this.sinks.clear();
					this.sinkSessions.clear();
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
		return Effect.gen({ self: this }, function* () {
			observeTurnTimelineFrame(output);
			if (output.type === "background-task") {
				this.deps.onBackgroundTask?.(output.transition);
				return;
			}
			let sink = this.sinks.get(output.sinkId);
			if (!sink && recoveredSessionId && this.recoveredSink) {
				sink = yield* this.recoveredSink(recoveredSessionId, output.sinkId);
				if (!sink) return;
				this.sinks.set(output.sinkId, sink);
				this.sinkSessions.set(output.sinkId, recoveredSessionId);
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
					const requestKey = JSON.stringify([
						output.sinkId,
						output.request.requestId,
					]);
					const registered = this.recoveredSinkIds.has(output.sinkId)
						? yield* Deferred.make<void>()
						: undefined;
					if (registered) this.recoveredRequests.set(requestKey, registered);
					// Registration and UI waiters belong here; only the outbox delivers answers.
					const request = Effect.suspend(() =>
						output.type === "permission-request"
							? sink.requestPermission(output.request).pipe(Effect.asVoid)
							: sink.requestQuestion(output.request).pipe(Effect.asVoid),
					);
					yield* FiberMap.run(
						this.interactionFibers,
						`${output.sinkId}:${output.request.requestId}`,
						request.pipe(
							Effect.onExit((exit) =>
								Effect.gen({ self: this }, function* () {
									// Failed asks never register a waiter. Release recovery's
									// readiness barrier before reporting their cancellation.
									if (registered)
										yield* Deferred.succeed(registered, undefined);
									if (
										Exit.isFailure(exit) &&
										!Failure.isInterruptedOnly(exit.cause)
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
													Failure.squashCause(exit.cause),
												),
											})
											.pipe(Effect.ignore);
									}
								}),
							),
							Effect.catchCause(() => Effect.void),
						),
					);
					if (registered) {
						yield* Deferred.await(registered);
						this.recoveredRequests.delete(requestKey);
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
					).pipe(Effect.catchCause(() => Effect.void));
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
					this.sinkSessions.delete(output.sinkId);
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
				case "read-subagent-transcript": {
					const project = yield* this.deps.recoveryForSession?.(
						output.childSessionId,
					) ?? Effect.succeed(undefined);
					const persist = yield* Effect.serviceOption(
						ClaudeEventPersistEffectTag,
					);
					const readTranscript =
						this.deps.readSubagentTranscript ??
						project?.persist.readClaudeSubagentTranscript ??
						(persist._tag === "Some"
							? persist.value.readClaudeSubagentTranscript
							: undefined);
					const subagentTranscript = yield* readTranscript?.(
						output.childSessionId,
					).pipe(
						Effect.mapError((cause) => sessionFailure(output.type, cause)),
					) ?? Effect.succeed({ messages: [], parts: [] });
					return { subagentTranscript };
				}
				case "ensure-subagent-session": {
					const project = yield* this.deps.recoveryForSession?.(
						output.input.parentSessionId,
					) ?? Effect.succeed(undefined);
					const persist = yield* Effect.serviceOption(
						ClaudeEventPersistEffectTag,
					);
					const ensureSession =
						this.deps.ensureChildSession ??
						project?.persist.ensureClaudeSubagentSession ??
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
			Effect.map((reply) => reply ?? {}),
			Effect.catchDefect((cause) =>
				Effect.fail(sessionFailure(output.type, cause)),
			),
		);
	}
}
