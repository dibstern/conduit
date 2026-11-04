import {
	Clock,
	Deferred,
	Effect,
	Exit,
	Option,
	Queue,
	Schema,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import type {
	ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventType,
} from "../../contracts/providers/provider-runtime-event.js";
import { createLogger } from "../../logger.js";
import { createEventId } from "../../persistence/events.js";
import { isRecord } from "../../utils.js";
import { EventSinkIngestionError } from "../event-sink-errors.js";
import { makeInProcessSessionRunner } from "../runner/in-process-session-runner.js";
import type { LiveSettings, RunnerPayload } from "../runner/runner-payload.js";
import type {
	ServerMarkInput,
	ServerMarkResult,
} from "../runner/runner-protocol.js";
import { runnerPidAlive } from "../runner/runner-registry.js";
import type { RunnerSinkBindings } from "../runner/runner-sink-bindings.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionTurn,
} from "../runner/session-runner.js";
import { TurnFacts } from "../runner/turn-facts.js";
import type { EventSink, TurnErrorCode, TurnResult } from "../types.js";
import { openAppServerTransport } from "./app-server/app-server.js";
import {
	type AppServerClient,
	type AppServerNotification,
	AppServerRpcError,
	connectAppServer,
} from "./app-server/client.js";
import {
	decodeNotification,
	type RateLimitSnapshotSchema,
	ThreadBackgroundTerminalsListResponseSchema,
	ThreadBackgroundTerminalsTerminateResponseSchema,
	ThreadCompactStartResponseSchema,
	ThreadForkResponseSchema,
	ThreadGoalClearResponseSchema,
	ThreadGoalGetResponseSchema,
	ThreadGoalSetResponseSchema,
	ThreadResumeResponseSchema,
	ThreadRevertResponseSchema,
	ThreadStartResponseSchema,
	ThreadUnarchiveResponseSchema,
	type TokenUsageBreakdownSchema,
	TurnInterruptResponseSchema,
	TurnStartResponseSchema,
	TurnSteerResponseSchema,
} from "./app-server/protocol.js";
import { AppServerExited } from "./app-server/transport.js";
import { invalidateCodexAuth } from "./codex-discovery.js";
import { prepareCodexAccount } from "./codex-home.js";
import { CodexInteractions } from "./codex-interactions.js";
import { codexRuntimeEvent } from "./codex-item-mapper.js";
import { answerServerMark, SERVER_MARK_TOOL } from "./codex-server-mark.js";
import { codexSessionConfig } from "./codex-session-config.js";
import {
	readCodexSessionIdentity,
	writeCodexSessionIdentity,
} from "./codex-session-store.js";
import { CodexSubagents } from "./codex-subagents.js";
import {
	acceptCodexTurn,
	type CodexTurnState,
	type CodexTurnUpdate,
	completeCodexTurn,
	createCodexTurnState,
	expireCodexGoalSuccessor,
	failCodexTurn,
	handleCodexTurnNotification,
	interruptCodexTurn,
	parseCodexGoalCommand,
} from "./codex-turn-lifecycle.js";
import { codexUsageReading, mergeCodexRateLimits } from "./codex-usage.js";

const log = createLogger("codex-runner");
const decodeTurnFacts = Schema.decodeUnknownOption(TurnFacts);

export interface CodexRunnerDeps {
	readonly workspaceRoot: string;
	readonly daemonConfigDir: string;
	readonly environment?: () => Readonly<Record<string, string | undefined>>;
	readonly onAbandonedRun?: (inputId: string) => void;
	/** The daemon's PortWatcher, reached over the runner socket (8.7 Declared). */
	readonly markServer?: (
		input: ServerMarkInput,
	) => Effect.Effect<ServerMarkResult, unknown>;
}

type ChildUpdate =
	// `at` is when the runner received it: the successor deadline judges arrival, not reading.
	| { readonly notification: AppServerNotification; readonly at: number }
	| { readonly interrupted: ActiveTurn }
	| { readonly failure: unknown };

interface CodexChild {
	readonly scope: Scope.Closeable;
	readonly client: AppServerClient;
	readonly updates: Queue.Queue<ChildUpdate>;
	dead: boolean;
	/** A row the last loop read after its successor window: the next reader's first. */
	carried?: ChildUpdate | undefined;
	/** Native turn starts queued while busy that no loop has read yet, oldest first. */
	readonly unclaimed: string[];
}

interface ActiveTurn {
	state: CodexTurnState;
	readonly sink: EventSink;
	/** The runs whose sends this turn carries: its start's and its steers'. */
	readonly runIds: Set<string>;
	readonly interactions: CodexInteractions;
	readonly started: Deferred.Deferred<string | undefined>;
	readonly cancelled: Deferred.Deferred<void>;
	cancelRequested: boolean;
	submitted: boolean;
	interruptSent: boolean;
}

interface CodexSession {
	readonly cwd: string;
	readonly codexHome?: string;
	threadId?: string | undefined;
	inheritedThreadIds?: readonly string[] | undefined;
	forkSource?:
		| { readonly threadId: string; readonly lastTurnId: string }
		| undefined;
	controllerPid?: number | undefined;
	child?: CodexChild | undefined;
	active?: ActiveTurn | undefined;
	busy: boolean;
	forkSeedPending: boolean;
	resumeFallbackDigest?: string | undefined;
	continuationKind?: "native-thread" | "transcript-digest" | undefined;
	continuationInputId?: string | undefined;
	readonly rateLimits: Map<string, typeof RateLimitSnapshotSchema.Type>;
	subagents?: CodexSubagents;
	tokenUsageTotal?: typeof TokenUsageBreakdownSchema.Type | undefined;
	/** The last send and its sink: a turn Codex starts while idle runs on them. */
	last?: { readonly input: SessionTurn; readonly sink: EventSink } | undefined;
	/** The goal as the last turn left it; main's copy is the send's, not the wake's. */
	goalState?: CodexTurnState["goalState"] | undefined;
	/** Background terminals: one re-read at a time, the set last sent, when each was first listed. */
	readonly terminals: {
		readonly lock: Semaphore.Semaphore;
		sent?: string;
		seen: ReadonlyMap<string, number>;
	};
}

function turnFailure(cause: unknown): { code: TurnErrorCode; message: string } {
	const tag = isRecord(cause) ? cause["_tag"] : undefined;
	return {
		code:
			isRecord(cause) &&
			(cause["code"] === "codex_thread_missing" ||
				cause["code"] === "agent_busy")
				? cause["code"]
				: tag === "AppServerExited" ||
						tag === "AppServerIoError" ||
						tag === "AppServerLineTooLong"
					? "provider_unavailable"
					: "provider_error",
		message:
			cause instanceof Error
				? cause.message
				: isRecord(cause) && typeof cause["message"] === "string"
					? cause["message"]
					: String(cause),
	};
}

export class CodexRunnerPayload implements RunnerPayload {
	private readonly sessions = new Map<string, CodexSession>();
	private readonly unknownMethods = new Map<string, number>();

	constructor(
		private readonly deps: CodexRunnerDeps,
		private readonly sinks: RunnerSinkBindings,
		private readonly emit: (
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
		private readonly scope: Scope.Scope,
		private readonly onTurnStateChanged?: (inFlight: boolean) => void,
	) {}

	sendTurn(
		input: SessionTurn,
		sink: EventSink,
		signal: AbortSignal,
	): Effect.Effect<TurnResult, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const intake = yield* Deferred.make<TurnResult, SessionFailure>();
			let handed = false;
			const claim = () => {
				if (signal.aborted) return false;
				handed = true;
				return true;
			};
			this.sinks.retainSink(sink);
			yield* this.runTurn(input, sink, claim, intake).pipe(
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Effect.sync(() => this.deps.onAbandonedRun?.(input.inputId))
						: Effect.void,
				),
				Effect.exit,
				Effect.flatMap((exit) => Deferred.done(intake, exit)),
				Effect.ensuring(this.sinks.releaseSinkEffect(sink)),
				Effect.ensuring(
					Effect.sync(() => {
						if (!this.sessions.get(input.sessionId)?.busy)
							this.onTurnStateChanged?.(false);
					}),
				),
				Effect.forkIn(this.scope),
			);
			return yield* Effect.raceFirst(
				Deferred.await(intake),
				Effect.callback<TurnResult>((resume) => {
					const onAbort = () =>
						resume(
							Effect.succeed({
								status: handed ? "indeterminate" : "cancelled",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							}),
						);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
					return Effect.sync(() =>
						signal.removeEventListener("abort", onAbort),
					);
				}),
			);
		});
	}

	/** A turn Codex started while idle runs on the last send's input and sink. */
	private wake(
		last: { readonly input: SessionTurn; readonly sink: EventSink },
		turnId: string,
	): Effect.Effect<void> {
		const { runId: _runId, ...input } = last.input;
		return Effect.gen({ self: this }, function* () {
			this.sinks.retainSink(last.sink);
			const intake = yield* Deferred.make<TurnResult, SessionFailure>();
			yield* this.runTurn(input, last.sink, () => true, intake, turnId);
		}).pipe(
			Effect.ignore,
			Effect.ensuring(this.sinks.releaseSinkEffect(last.sink)),
			Effect.ensuring(
				Effect.sync(() => {
					if (!this.sessions.get(input.sessionId)?.busy)
						this.onTurnStateChanged?.(false);
				}),
			),
			Effect.forkIn(this.scope),
			Effect.asVoid,
		);
	}

	hasActiveTurnsEffect(sessionId: string): Effect.Effect<boolean> {
		return Effect.sync(() => this.sessions.get(sessionId)?.busy === true);
	}

	private runTurn(
		input: SessionTurn,
		sink: EventSink,
		claim: () => boolean,
		intake: Deferred.Deferred<TurnResult, SessionFailure>,
		/** The native id of a turn Codex started while idle: a wake, with no Run of its own. */
		wake?: string,
	): Effect.Effect<TurnResult, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const prepared = yield* prepareCodexAccount(
				input.account,
				this.deps.daemonConfigDir,
				this.deps.environment?.() ?? process.env,
			).pipe(
				Effect.mapError(
					(cause): SessionFailure => ({
						operation: "prepare home",
						message: cause.message,
					}),
				),
			);
			let session = this.sessions.get(input.sessionId);
			if (session && !session.busy && session.codexHome !== prepared.home) {
				if (session.child) yield* Scope.close(session.child.scope, Exit.void);
				this.sessions.delete(input.sessionId);
				session = undefined;
			}
			if (!session) {
				const identity = yield* Effect.try({
					try: () =>
						readCodexSessionIdentity(
							this.deps.daemonConfigDir,
							input.sessionId,
						),
					catch: (): SessionFailure => ({
						operation: "session identity",
						message: "Could not read Codex session identity",
					}),
				});
				// The identity pins the home the thread was created under.
				const codexHome = identity?.codexHome ?? prepared.home;
				// The send's facts are decoded below; a malformed one fails the turn there.
				const digest =
					input.facts?._tag === "Codex" ? input.facts.forkDigest : undefined;
				session = {
					cwd: identity?.cwd ?? input.workspaceRoot ?? this.deps.workspaceRoot,
					...(codexHome ? { codexHome } : {}),
					...(identity && !identity.forkSource
						? {
								threadId: identity.threadId,
								controllerPid: identity.controllerPid,
							}
						: {}),
					...(identity?.forkSource ? { forkSource: identity.forkSource } : {}),
					...(identity?.inheritedThreadIds
						? { inheritedThreadIds: identity.inheritedThreadIds }
						: {}),
					busy: false,
					forkSeedPending:
						identity?.forkSeedPending ??
						(!identity && typeof digest === "string" && digest.length > 0),
					...(identity?.resumeFallbackDigest
						? { resumeFallbackDigest: identity.resumeFallbackDigest }
						: {}),
					...(identity?.continuationKind
						? { continuationKind: identity.continuationKind }
						: identity?.resumeFallbackDigest && identity.forkSeedPending
							? { continuationKind: "transcript-digest" as const }
							: {}),
					...(identity?.continuationInputId
						? { continuationInputId: identity.continuationInputId }
						: {}),
					rateLimits: new Map(),
					terminals: { lock: yield* Semaphore.make(1), seen: new Map() },
				};
				this.sessions.set(input.sessionId, session);
			}
			if (session.busy && !wake)
				return yield* this.steer(session, input, sink, claim);
			const current = session;
			if (!wake) current.last = { input, sink };
			// Keep the outcome durable until a different input supersedes it.
			if (!wake && current.continuationInputId !== input.inputId) {
				current.continuationKind =
					current.forkSeedPending && current.resumeFallbackDigest
						? "transcript-digest"
						: input.continuation
							? "native-thread"
							: undefined;
				current.continuationInputId = current.continuationKind
					? input.inputId
					: undefined;
			}
			current.busy = true;
			this.onTurnStateChanged?.(true);
			const now = yield* Clock.currentTimeMillis;
			const goalState = wake ? current.goalState : input.goalState;
			const active: ActiveTurn = {
				sink,
				state: createCodexTurnState({
					sessionId: input.sessionId,
					runId: input.runId,
					turnId: input.continuation?.cutOffMessageId ?? input.inputId,
					messageId: createEventId(),
					providerId: "codex",
					threadId: current.threadId ?? input.sessionId,
					now,
					...(goalState ? { goalState } : {}),
					tokenUsageBaseline: current.tokenUsageTotal,
				}),
				runIds: new Set(input.runId ? [input.runId] : []),
				started: yield* Deferred.make<string | undefined>(),
				cancelled: yield* Deferred.make<void>(),
				cancelRequested: false,
				submitted: false,
				interruptSent: false,
				interactions: new CodexInteractions(
					sink,
					input.permissionMode,
					() => active.state.items,
					(requestId, kind) =>
						this.sinks.withdrawInteraction(sink, requestId, kind),
					(message, requestId) => {
						log.warn("codex.elicitation_declined", { message });
						const partId = `${active.state.items.messageId}:${requestId}:diagnostic`;
						const text = `${message}\n`;
						active.state = {
							...active.state,
							items: {
								...active.state.items,
								parts: [
									...active.state.items.parts,
									{
										kind: "text",
										id: partId,
										itemId: requestId,
										text,
										closed: true,
									},
								],
							},
						};
						return push("text.delta", {
							messageId: active.state.items.messageId,
							partId,
							text,
						});
					},
				),
			};
			current.active = active;
			current.subagents ??= new CodexSubagents(
				input.sessionId,
				(child, ownerSink) => {
					const sinkId = this.sinks.sinkId(ownerSink);
					return sinkId
						? this.emit({
								type: "ensure-subagent-session",
								sinkId,
								input: child,
							}).pipe(
								Effect.asVoid,
								Effect.mapError(
									(cause) => new EventSinkIngestionError({ cause }),
								),
							)
						: Effect.void;
				},
				this.sinks,
				input.account?.id ?? input.instanceId,
			);
			current.subagents.attach({
				get: () => active.state,
				set: (state) => {
					active.state = state;
				},
				sink,
				permissionMode: input.permissionMode,
			});
			const push = <
				K extends Exclude<ProviderRuntimeEventType, "workspace.changed">,
			>(
				type: K,
				data: ProviderRuntimeEventPayloadMap[K],
				metadata?: Readonly<Record<string, unknown>>,
			) => {
				const [items, event] = codexRuntimeEvent(
					{ ...active.state.items, now: Date.now() },
					type,
					data,
				);
				active.state = { ...active.state, items };
				return sink.push(metadata ? { ...event, metadata } : event);
			};
			let accepted = false;
			const acceptInput = () =>
				Effect.gen({ self: this }, function* () {
					if (accepted) return;
					accepted = true;
					if (wake) yield* push("evidence.turn_started", { label: "" });
					if (input.runId)
						yield* push("run.started", {
							inputId: input.inputId,
							requestedRunId: input.runId,
							...(input.continuation
								? { userMessageId: input.continuation.cutOffMessageId }
								: {}),
						});
					yield* push("session.status", {
						sessionId: input.sessionId,
						status: "busy",
					});
					yield* push("message.created", {
						sessionId: input.sessionId,
						messageId: active.state.items.messageId,
						role: "assistant",
						parentID: active.state.items.turnId,
					});
					yield* Deferred.succeed(
						intake,
						this.result(
							{ status: "accepted", tokens: { input: 0, output: 0 } },
							0,
						),
					);
				});
			const apply = (update: CodexTurnUpdate) =>
				Effect.gen(function* () {
					const continuationKind =
						!wake && current.continuationInputId === input.inputId
							? current.continuationKind
							: undefined;
					active.state = update.state;
					current.tokenUsageTotal =
						update.state.items.tokenUsageTotal ?? current.tokenUsageTotal;
					if (update.diagnostic)
						log.debug(update.diagnostic.event, update.diagnostic);
					if (active.state.executingTurnId)
						yield* Deferred.succeed(
							active.started,
							active.state.executingTurnId,
						);
					if (update.outcome) {
						current.busy = false;
						yield* Deferred.succeed(active.started, undefined);
					}
					if (
						update.outcome?.error?.code === "auth_required" &&
						current.codexHome
					)
						invalidateCodexAuth(current.codexHome);
					let usageLimited:
						| ProviderRuntimeEventPayloadMap["session.usage_limited"]
						| undefined;
					if (update.outcome?.error?.code === "usage_limited") {
						const buckets = [...current.rateLimits.values()];
						const bucket =
							buckets.find(
								(value) =>
									value.normalModelSlug === input.model?.modelId ||
									value.limitId === input.model?.modelId,
							) ??
							buckets.find(
								(value) =>
									value.limitId === "codex" &&
									((value.primary?.usedPercent ?? 0) >= 100 ||
										(value.secondary?.usedPercent ?? 0) >= 100),
							) ??
							buckets.find(
								(value) =>
									(value.primary?.usedPercent ?? 0) >= 100 ||
									(value.secondary?.usedPercent ?? 0) >= 100,
							) ??
							buckets.find((value) => value.limitId === "codex");
						const limitId = bucket?.limitId ?? "codex";
						const windows = bucket
							? codexUsageReading({ rateLimits: bucket }).windows
							: [];
						const exhausted = windows.filter(
							(window) => window.utilization >= 100,
						);
						const resets = exhausted.flatMap((window) =>
							window.resetsAt ? [Date.parse(window.resetsAt) / 1000] : [],
						);
						// Detach before publishing: a reset already due can admit the next
						// turn as soon as the limit reaches the scheduler.
						const child = current.child;
						current.child = undefined;
						current.rateLimits.clear();
						if (child) yield* Scope.close(child.scope, Exit.void);
						usageLimited = {
							instanceId: input.account?.id ?? input.instanceId ?? "codex",
							cutOffMessageId:
								input.continuation?.cutOffMessageId ?? input.inputId,
							rateLimitType: limitId,
							...(resets.length ? { resetsAt: Math.max(...resets) } : {}),
						};
					}
					for (const event of update.events) {
						// Native message reference refreshes clear an earlier recovery marker.
						if (event.type === "turn.error" && usageLimited)
							yield* push("session.usage_limited", usageLimited, {
								modelId: input.model?.modelId,
							});
						yield* sink.push(
							event.type === "turn.completed"
								? {
										...event,
										data: {
											...(event.data as ProviderRuntimeEventPayloadMap["turn.completed"]),
											providerStateUpdates: [],
											...(continuationKind ? { continuationKind } : {}),
										},
									}
								: event,
						);
					}
					return update.outcome;
				});
			return yield* Effect.scoped(
				Effect.gen({ self: this }, function* () {
					const outcome = yield* Effect.gen({ self: this }, function* () {
						const sinkId = this.sinks.sinkId(sink);
						const admitInput = () =>
							Effect.gen({ self: this }, function* () {
								if (sinkId && !input.continuation)
									yield* this.emit({
										type: "place-user-message",
										sinkId,
										input: {
											sessionId: input.sessionId,
											inputId: input.inputId,
											...(input.runId ? { runId: input.runId } : {}),
											text: input.text ?? input.prompt,
											...(input.images?.length
												? { images: input.images.map(({ ref }) => ref) }
												: {}),
										},
									});
							});
						let child: CodexChild;
						if (wake) {
							if (!current.child)
								return yield* apply(
									failCodexTurn(
										active.state,
										"provider_unavailable",
										"Codex exited before its turn",
										Date.now(),
									),
								);
							child = current.child;
							active.submitted = true;
							active.state = acceptCodexTurn(active.state, wake);
						} else {
							if (!input.rewind) yield* admitInput();
							if (!input.model)
								return yield* apply(
									failCodexTurn(
										active.state,
										"send_failed",
										"Select a Codex model before sending",
										Date.now(),
									),
								);
							const facts = decodeTurnFacts(input.facts);
							if (Option.isNone(facts) || facts.value._tag !== "Codex")
								return yield* apply(
									failCodexTurn(
										active.state,
										"turn_unprepared",
										"Codex turn has no prepared turn facts",
										Date.now(),
									),
								);
							const opened = yield* Effect.raceFirst(
								Effect.gen({ self: this }, function* () {
									const previousPid = current.controllerPid;
									if (previousPid && previousPid !== process.pid) {
										// Retirement is acknowledged before the old process exits.
										// Match Cursor's bounded wait; never take a live controller.
										yield* Effect.gen(function* () {
											while (runnerPidAlive(previousPid))
												yield* Effect.sleep("50 millis");
										}).pipe(
											Effect.timeoutOrElse({
												duration: "5 seconds",
												orElse: () =>
													Effect.fail({
														code: "agent_busy" as const,
														message:
															"Codex session is owned by another live runner",
													}),
											}),
										);
									}
									return yield* this.open(current, input);
								}),
								Deferred.await(active.cancelled).pipe(Effect.as(undefined)),
							);
							if (!opened || active.cancelRequested)
								return yield* apply(
									interruptCodexTurn(active.state, Date.now()),
								);
							child = opened;
							if (!current.threadId)
								return yield* Effect.fail({
									operation: "thread start",
									message: "Codex did not return a thread identity",
								});
							active.state = {
								...active.state,
								items: { ...active.state.items, threadId: current.threadId },
							};
							if (input.rewind) {
								const truncate = facts.value.truncate;
								if (truncate._tag === "Before") {
									yield* child.client
										.request(
											"thread/revert",
											{
												threadId: current.threadId,
												beforeTurnId: truncate.turnId,
											},
											ThreadRevertResponseSchema,
										)
										.pipe(
											Effect.mapError((cause) => ({
												message: `Codex conversation rewind failed before turn ${truncate.turnId}: ${cause.message}`,
											})),
										);
									current.tokenUsageTotal = undefined;
									active.state = {
										...active.state,
										items: {
											...active.state.items,
											tokenUsageBaseline: undefined,
										},
									};
								}
								if (input.rewind.targetMessageId)
									yield* push("message.removed", {
										messageId: input.rewind.targetMessageId,
									});
							}
							if (input.rewind) yield* admitInput();
							if (!claim())
								return {
									status: "cancelled" as const,
									tokens: { input: 0, output: 0 },
								};
							const compact = input.prompt.trim() === "/compact";
							if (compact)
								active.state = { ...active.state, manualCompaction: true };
							const goalCommand = parseCodexGoalCommand(input.prompt);
							if (
								goalCommand &&
								!["set", "resume"].includes(goalCommand.type)
							) {
								const facts = yield* this.goalCommand(current, goalCommand);
								const decoded = facts ? decodeNotification(facts) : undefined;
								if (decoded?._tag === "known") {
									const outcome = yield* apply(
										handleCodexTurnNotification(
											active.state,
											decoded,
											yield* Clock.currentTimeMillis,
										),
									);
									if (outcome) return outcome;
								}
								return yield* apply(completeCodexTurn(active.state));
							}
							const activateGoal =
								!compact &&
								(goalCommand?.type === "set" ||
									goalCommand?.type === "resume" ||
									!!active.state.goalState.goal);
							if (goalCommand?.type === "set") {
								active.state = {
									...active.state,
									goalActive: false,
									goalActivationPending: true,
								};
								yield* child.client.request(
									"thread/goal/set",
									{
										threadId: current.threadId,
										objective: goalCommand.objective,
										status: "paused",
										origin: "user",
									},
									ThreadGoalSetResponseSchema,
								);
							} else if (activateGoal) {
								active.state = { ...active.state, goalActivationPending: true };
							}
							const digest =
								current.resumeFallbackDigest ?? facts.value.forkDigest;
							const seed =
								current.forkSeedPending &&
								typeof digest === "string" &&
								digest.length > 0
									? digest
									: undefined;
							const { effort, skill } = facts.value;
							// No yield between checking cancellation and submitting the turn.
							if (active.cancelRequested)
								return yield* apply(
									interruptCodexTurn(active.state, Date.now()),
								);
							active.submitted = true;
							if (compact) {
								yield* child.client.request(
									"thread/compact/start",
									{ threadId: current.threadId },
									ThreadCompactStartResponseSchema,
								);
							} else {
								const accepted = yield* child.client.request(
									"turn/start",
									{
										threadId: current.threadId,
										clientUserMessageId: input.inputId,
										input: [
											...(seed
												? [{ type: "text", text: seed, text_elements: [] }]
												: []),
											{
												type: "text",
												text:
													goalCommand?.type === "set"
														? goalCommand.objective
														: goalCommand?.type === "resume"
															? "Continue."
															: input.prompt,
												text_elements: [],
											},
											...(skill._tag === "Skill"
												? [
														{
															type: "skill",
															name: skill.name,
															path: skill.path,
														},
													]
												: []),
											...(input.images ?? []).map(({ dataUrl }) => ({
												type: "image",
												url: dataUrl,
											})),
										],
										cwd: current.cwd,
										model: input.model.modelId,
										...(effort !== undefined ? { effort } : {}),
										summary: "detailed",
										...codexSessionConfig({
											permissionMode: input.permissionMode,
											cwd: current.cwd,
											modelId: input.model.modelId,
											effort,
										}),
									},
									TurnStartResponseSchema,
								);
								active.state = acceptCodexTurn(active.state, accepted.turn.id);
								if (activateGoal && !active.cancelRequested)
									yield* child.client.request(
										"thread/goal/set",
										{
											threadId: current.threadId,
											status: "active",
											origin: "user",
										},
										ThreadGoalSetResponseSchema,
									);
								if (seed) {
									current.forkSeedPending = false;
									current.resumeFallbackDigest = undefined;
									yield* this.persistIdentity(
										input.sessionId,
										current,
										current.threadId,
									);
								}
							}
						}
						while (!active.state.settled) {
							const deadline = active.state.successorDeadline;
							// F271: what has arrived is read before the deadline is judged.
							const carried = child.carried;
							child.carried = undefined;
							const queued = carried
								? Option.some(carried)
								: yield* Queue.poll(child.updates);
							if (Option.isNone(queued) && deadline !== undefined) {
								const expired = expireCodexGoalSuccessor(
									active.state,
									yield* Clock.currentTimeMillis,
								);
								if (expired.outcome) return yield* apply(expired);
							}
							const update = Option.isSome(queued)
								? queued.value
								: deadline === undefined
									? yield* Queue.take(child.updates)
									: yield* Queue.take(child.updates).pipe(
											Effect.timeoutOrElse({
												duration: Math.max(
													0,
													deadline - (yield* Clock.currentTimeMillis),
												),
												orElse: () =>
													Effect.succeed({ goalTimeout: true } as const),
											}),
										);
							if ("goalTimeout" in update) {
								const outcome = yield* apply(
									expireCodexGoalSuccessor(
										active.state,
										yield* Clock.currentTimeMillis,
									),
								);
								if (outcome) return outcome;
								continue;
							}
							if ("interrupted" in update) {
								if (update.interrupted !== active) continue;
								return yield* apply(
									interruptCodexTurn(
										active.state,
										yield* Clock.currentTimeMillis,
									),
								);
							}
							// Inside the successor window the turn has completed; a closed
							// app-server can start no successor, so the held result stands
							// (CONTRACT 3087, 3118).
							if ("failure" in update)
								return deadline === undefined
									? yield* Effect.fail(update.failure)
									: yield* apply(completeCodexTurn(active.state));
							// A row that arrived after the window is not this turn's: the turn
							// ends, the row waits for the next reader (CONTRACT 3119).
							if (deadline !== undefined && update.at >= deadline) {
								child.carried = update;
								return yield* apply(
									expireCodexGoalSuccessor(active.state, update.at),
								);
							}
							const decoded = decodeNotification(update.notification);
							if (decoded._tag === "malformed") {
								log.warn("codex.decode_failed", {
									method: decoded.method,
									bytes: Buffer.byteLength(
										JSON.stringify(update.notification.params) ?? "",
									),
								});
								continue;
							}
							if (decoded._tag === "unknown") {
								const count =
									(this.unknownMethods.get(decoded.method) ?? 0) + 1;
								this.unknownMethods.set(decoded.method, count);
								log.debug("codex.notification_unknown", {
									method: decoded.method,
									count,
								});
								continue;
							}
							const unread =
								decoded.method === "turn/started"
									? child.unclaimed.indexOf(decoded.params.turn.id)
									: -1;
							if (unread >= 0) child.unclaimed.splice(unread, 1);
							if (decoded.method === "serverRequest/resolved") {
								if (decoded.params.threadId === current.threadId)
									yield* active.interactions.resolve(decoded.params.requestId);
								continue;
							}
							if (
								decoded.method === "turn/started" &&
								decoded.params.threadId === current.threadId &&
								(decoded.params.turn.id === active.state.acceptedTurnId ||
									(active.state.manualCompaction &&
										!active.state.acceptedTurnId))
							)
								yield* acceptInput();
							const result = yield* apply(
								handleCodexTurnNotification(active.state, decoded, update.at),
							);
							if (
								decoded.method === "item/started" ||
								decoded.method === "item/completed"
							)
								yield* active.interactions.itemMapped(decoded.params.item.id);
							if (result) return result;
						}
						return undefined;
					}).pipe(
						Effect.catch((cause) => {
							if (active.state.settled) return Effect.fail(cause);
							const failure = turnFailure(cause);
							if (failure.code === "provider_unavailable" && current.child)
								current.child.dead = true;
							return apply(
								failCodexTurn(
									active.state,
									failure.code,
									failure.message,
									Date.now(),
								),
							);
						}),
					);
					// CONTRACT 841-844: a Codex Run ends at its result, so the wake end carries one.
					if (wake && accepted)
						yield* push("evidence.turn_ended", {
							label: "",
							result:
								outcome && "error" in outcome && outcome.error
									? { outcome: outcome.status, code: outcome.error.code }
									: {
											outcome:
												outcome && outcome.status !== "cancelled"
													? outcome.status
													: "error",
										},
						});
					if (current.active === active)
						yield* push("session.status", {
							sessionId: input.sessionId,
							status: "idle",
						});
					return this.result(
						outcome ?? {
							status: "error",
							tokens: active.state.items.tokens,
							error: {
								code: "provider_error",
								message: "Codex turn ended without an outcome",
							},
						},
						Date.now() - now,
					);
				}),
			).pipe(
				Effect.mapError(
					(cause): SessionFailure => ({
						operation: "persist Codex turn",
						message:
							cause instanceof Error
								? cause.message
								: "Could not persist Codex turn",
					}),
				),
				Effect.ensuring(
					Effect.gen({ self: this }, function* () {
						yield* active.interactions.interrupt();
						if (current.active === active) {
							current.busy = false;
							current.active = undefined;
						}
						// The wake below starts from this goal.
						current.goalState = active.state.goalState;
						yield* Deferred.succeed(active.started, undefined);
						// A turn start that arrived while this loop held the session and that
						// it never read is a wake (F243). A dead child still holds its rows and
						// then its failure: the producer offers the failure last.
						const child = current.child;
						const turnId = child?.unclaimed[0];
						if (child && turnId && current.last && !current.busy) {
							child.unclaimed.shift();
							current.busy = true;
							yield* this.wake(current.last, turnId);
						}
					}),
				),
			);
		});
	}

	interrupt(
		sessionId: string,
		runIds?: readonly string[],
	): Effect.Effect<void, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const session = this.sessions.get(sessionId);
			if (!session) return;
			const active = session.active;
			// An empty cohort names no send, so it reaches only a wake (no Runs of its own), as Claude's.
			const wakeStop = runIds?.length === 0 && active?.runIds.size === 0;
			if (runIds && !wakeStop && !runIds.some((id) => active?.runIds.has(id)))
				return;
			session.subagents?.beginInterrupt();
			if (!active) {
				yield* this.interruptChildren(session);
				return;
			}
			const child = session.child;
			const threadId = session.threadId;
			const children = session.subagents?.runningTurns ?? [];
			active.cancelRequested = true;
			active.state = { ...active.state, interruptRequested: true };
			yield* Deferred.succeed(active.cancelled, undefined);
			yield* active.interactions.interrupt();
			if (!active.submitted) return;
			yield* Deferred.await(active.started);
			if (session.active && session.active !== active) return;
			if (active.state.settled || active.interruptSent || !child || !threadId) {
				yield* this.interruptChildren(session, children, active.sink, child);
				return;
			}
			active.interruptSent = true;
			// Stop is not a goal action: an interrupt leaves the goal active (CONTRACT.md 2057).
			const turnId = active.state.executingTurnId;
			if (!turnId) {
				yield* this.interruptChildren(session, children, active.sink, child);
				yield* Queue.offer(child.updates, { interrupted: active });
				return;
			}
			yield* child.client
				.request(
					"turn/interrupt",
					{ threadId, turnId },
					TurnInterruptResponseSchema,
				)
				.pipe(
					Effect.mapError(
						(cause): SessionFailure => ({
							operation: "interrupt",
							message: turnFailure(cause).message,
						}),
					),
				);
			yield* this.interruptChildren(session, children, active.sink, child);
			yield* Queue.offer(child.updates, { interrupted: active });
		});
	}

	private interruptChildren(
		session: CodexSession,
		turns = session.subagents?.runningTurns ?? [],
		ownerSink?: EventSink,
		child = session.child,
	) {
		return Effect.gen(function* () {
			for (const target of turns) {
				if (child)
					yield* child.client
						.request("turn/interrupt", target, TurnInterruptResponseSchema)
						.pipe(
							Effect.catch((cause) =>
								Effect.sync(() =>
									log.warn("codex.child_interrupt_failed", {
										threadId: target.threadId,
										message: turnFailure(cause).message,
									}),
								),
							),
						);
			}
			yield* session.subagents?.interrupt(
				"interrupted",
				undefined,
				ownerSink,
			) ?? Effect.void;
		}).pipe(
			Effect.mapError(
				(cause): SessionFailure => ({
					operation: "interrupt subagents",
					message: turnFailure(cause).message,
				}),
			),
		);
	}

	hasPendingSubagentFinalizers(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.subagents?.hasRunning ?? false;
	}

	/**
	 * 8.4 (CONTRACT.md 2860-2867): Stop tasks terminates one background terminal, then re-reads the
	 * set (8.2, 2792), so the terminal leaves only when a later list omits it (8.3, 2817). Gap
	 * (2866): `terminated: false` is a failed stop while that list still names the terminal; it
	 * fails once, and the reactor never retries it. When the list omits it, the terminal has ended
	 * and the stop is done, so the reply never races that list's snapshot to the ledger.
	 */
	stopTask(
		sessionId: string,
		taskId: string,
	): Effect.Effect<void, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const session = this.sessions.get(sessionId);
			const child = session?.child;
			const threadId = session?.threadId;
			if (!session || !child || child.dead || !threadId)
				return yield* Effect.fail<SessionFailure>({
					operation: "stop-task",
					message: "Codex is not running this session in this runner",
				});
			const answer = yield* Effect.result(
				child.client.request(
					"thread/backgroundTerminals/terminate",
					{ threadId, processId: taskId },
					ThreadBackgroundTerminalsTerminateResponseSchema,
				),
			);
			const listed = yield* this.refreshTerminals(
				sessionId,
				session,
				child.client,
			);
			if (listed && !listed.some(({ processId }) => processId === taskId))
				return;
			if (answer._tag === "Failure")
				return yield* Effect.fail<SessionFailure>({
					operation: "stop-task",
					message: turnFailure(answer.failure).message,
				});
			if (!answer.success.terminated)
				return yield* Effect.fail<SessionFailure>({
					operation: "stop-task",
					message: `Codex did not stop background terminal ${taskId}`,
				});
		});
	}

	private steer(
		session: CodexSession,
		input: SessionTurn,
		sink: EventSink,
		claim: () => boolean,
	): Effect.Effect<TurnResult, SessionFailure> {
		return Effect.scoped(
			Effect.gen({ self: this }, function* () {
				const declined: TurnResult = {
					status: "steer-declined",
					tokens: { input: 0, output: 0 },
					cost: 0,
					durationMs: 0,
					providerStateUpdates: [],
				};
				const active = session.active;
				const sinkId = this.sinks.sinkId(sink);
				const acceptSteer = () =>
					Effect.gen({ self: this }, function* () {
						if (!active || !sinkId) return declined;
						if (!input.continuation)
							yield* this.emit({
								type: "place-user-message",
								sinkId,
								input: {
									sessionId: input.sessionId,
									inputId: input.inputId,
									...(input.runId ? { runId: input.runId } : {}),
									text: input.text ?? input.prompt,
									...(input.images?.length
										? { images: input.images.map(({ ref }) => ref) }
										: {}),
								},
							});
						if (input.runId && active.state.items.runId) {
							const [items, event] = codexRuntimeEvent(
								{ ...active.state.items, now: Date.now() },
								"run.started",
								{
									inputId: input.inputId,
									requestedRunId: input.runId,
									...(input.continuation
										? { userMessageId: input.continuation.cutOffMessageId }
										: {}),
								},
							);
							active.state = { ...active.state, items };
							yield* sink.push(event);
						}
						const [items, event] = codexRuntimeEvent(
							{ ...active.state.items, now: Date.now() },
							"message.created",
							{
								sessionId: input.sessionId,
								messageId: input.continuation?.cutOffMessageId ?? input.inputId,
								role: "user",
							},
						);
						active.state = { ...active.state, items };
						yield* sink.push({
							...event,
							metadata: { source: "codex.native-turn" },
						});
						if (active.state.settled) {
							const [items, event] = codexRuntimeEvent(
								{ ...active.state.items, now: Date.now() },
								"session.status",
								{ sessionId: input.sessionId, status: "idle" },
							);
							active.state = { ...active.state, items };
							yield* sink.push(event);
						}
						return { ...declined, status: "accepted" as const };
					});
				if (
					input.prompt.trim() === "/compact" ||
					active?.state.manualCompaction
				)
					return declined;
				if (active && !active.state.settled && !active.cancelRequested)
					yield* Deferred.await(active.started);
				if (session.active !== active) return declined;
				const command = parseCodexGoalCommand(input.prompt);
				if (
					active &&
					!active.state.settled &&
					!active.cancelRequested &&
					command &&
					sinkId
				) {
					if (!claim()) return { ...declined, status: "cancelled" as const };
					if (input.runId) active.runIds.add(input.runId);
					const facts = yield* this.goalCommand(session, command).pipe(
						Effect.mapError(
							(cause): SessionFailure => ({
								operation: "goal command",
								message: turnFailure(cause).message,
							}),
						),
					);
					if (command.type === "show" && facts && session.child)
						yield* Queue.offer(session.child.updates, {
							notification: facts,
							at: yield* Clock.currentTimeMillis,
						});
					return yield* acceptSteer();
				}
				if (
					!active ||
					active.state.settled ||
					active.cancelRequested ||
					!active.state.executingTurnId ||
					!session.child ||
					!session.threadId ||
					!sinkId
				)
					return declined;
				if (!claim()) return { ...declined, status: "cancelled" as const };
				if (input.runId) active.runIds.add(input.runId);
				const delivered = yield* session.child.client
					.request(
						"turn/steer",
						{
							threadId: session.threadId,
							expectedTurnId: active.state.executingTurnId,
							clientUserMessageId: input.inputId,
							input: [
								{ type: "text", text: input.prompt, text_elements: [] },
								...(input.images ?? []).map(({ dataUrl }) => ({
									type: "image",
									url: dataUrl,
								})),
							],
						},
						TurnSteerResponseSchema,
					)
					.pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false),
					);
				return delivered ? yield* acceptSteer() : declined;
			}),
		).pipe(
			Effect.mapError(
				(cause): SessionFailure => ({
					operation: "steer",
					message: turnFailure(cause).message,
				}),
			),
		);
	}

	private goalCommand(
		session: CodexSession,
		command: NonNullable<ReturnType<typeof parseCodexGoalCommand>>,
	) {
		return Effect.gen(function* () {
			if (!session.child || !session.threadId)
				return yield* Effect.fail(
					new Error("No Codex thread for goal command"),
				);
			const threadId = session.threadId;
			if (command.type === "clear") {
				yield* session.child.client.request(
					"thread/goal/clear",
					{ threadId, origin: "user" },
					ThreadGoalClearResponseSchema,
				);
				return { method: "thread/goal/cleared", params: { threadId } };
			}
			const result =
				command.type === "show"
					? yield* session.child.client.request(
							"thread/goal/get",
							{ threadId },
							ThreadGoalGetResponseSchema,
						)
					: yield* session.child.client.request(
							"thread/goal/set",
							{
								threadId,
								origin: "user",
								status: command.type === "pause" ? "paused" : "active",
								...(command.type === "set"
									? { objective: command.objective }
									: {}),
							},
							ThreadGoalSetResponseSchema,
						);
			if (command.type === "show" && !result.goal) return undefined;
			return result.goal
				? {
						method: "thread/goal/updated",
						params: { threadId, goal: result.goal },
					}
				: { method: "thread/goal/cleared", params: { threadId } };
		});
	}

	applySettings(_sessionId: string, _settings: LiveSettings) {
		return Effect.void;
	}

	endSession(sessionId: string) {
		return Effect.gen({ self: this }, function* () {
			const session = this.sessions.get(sessionId);
			if (!session) return;
			yield* this.interrupt(sessionId).pipe(
				Effect.catch((failure) =>
					Effect.sync(() => log.warn("codex.interrupt_failed", failure)),
				),
			);
			if (session.child) yield* Scope.close(session.child.scope, Exit.void);
			this.sessions.delete(sessionId);
		});
	}

	shutdown() {
		return Effect.forEach(this.sessions.keys(), (id) => this.endSession(id), {
			discard: true,
		});
	}
	getResumeSessionIdEffect(sessionId: string) {
		return Effect.sync(() => this.sessions.get(sessionId)?.threadId);
	}

	private open(session: CodexSession, input: SessionTurn) {
		return Effect.gen({ self: this }, function* () {
			if (session.child && !session.child.dead) return session.child;
			if (session.child) yield* Scope.close(session.child.scope, Exit.void);
			session.child = undefined;
			const scope = yield* Scope.fork(this.scope);
			return yield* Effect.gen({ self: this }, function* () {
				const { env } = yield* prepareCodexAccount(
					input.account,
					this.deps.daemonConfigDir,
					this.deps.environment?.() ?? process.env,
				);
				delete env["CODEX_HOME"];
				if (session.codexHome) env["CODEX_HOME"] = session.codexHome;
				const transport = yield* openAppServerTransport({
					env,
					cwd: session.cwd,
					scenario: "codex-turn",
				});
				const client = yield* connectAppServer(transport, {
					clientInfo: { name: "conduit", title: "Conduit", version: "1.0.0" },
					onServerRequest: (method, params, id) => {
						if (method === "item/tool/call")
							return answerServerMark(
								params,
								this.deps.markServer ??
									(() => Effect.fail("No daemon to mark the server")),
							);
						const active = session.active;
						const interaction: Effect.Effect<unknown, unknown> | undefined =
							active?.interactions.request(method, params, id);
						const foreignRootTurn =
							active?.state.items.nativeTurnId !== undefined &&
							isRecord(params) &&
							params["threadId"] !== active.state.items.threadId &&
							params["turnId"] === active.state.items.nativeTurnId;
						const childRequest = foreignRootTurn
							? undefined
							: session.subagents?.request(method, params, id);
						if (childRequest) return childRequest;
						if (!active || !interaction) return undefined;
						if (
							isRecord(params) &&
							(params["threadId"] !== active.state.items.threadId ||
								(params["turnId"] != null &&
									active.state.items.nativeTurnId !== undefined &&
									params["turnId"] !== active.state.items.nativeTurnId))
						)
							return interaction;
						// Callbacks can overtake the matching notification's durable intake.
						return Deferred.await(active.started).pipe(
							Effect.flatMap((turnId) =>
								!turnId ||
								session.active !== active ||
								active.cancelRequested ||
								active.state.settled
									? active.interactions
											.interrupt()
											.pipe(Effect.andThen(interaction))
									: interaction,
							),
						);
					},
				});
				const updates = yield* Queue.unbounded<ChildUpdate>();
				const child: CodexChild = {
					scope,
					client,
					updates,
					dead: false,
					unclaimed: [],
				};
				yield* Effect.addFinalizer(() =>
					Queue.offer(updates, {
						failure: new AppServerExited({
							code: null,
							signal: null,
							stderrTail: "Codex runner closed the app-server",
						}),
					}),
				);
				yield* Stream.runForEach(client.notifications, (notification) =>
					Effect.gen({ self: this }, function* () {
						const decoded = decodeNotification(notification);
						if (
							decoded._tag === "known" &&
							(yield* session.subagents?.handle(decoded) ??
								Effect.succeed(false))
						)
							return;
						if (
							decoded._tag === "known" &&
							decoded.method === "account/rateLimits/updated"
						) {
							const limitId = decoded.params.rateLimits.limitId ?? "codex";
							const snapshot = mergeCodexRateLimits(
								session.rateLimits.get(limitId),
								{ ...decoded.params.rateLimits, limitId },
							);
							session.rateLimits.set(limitId, snapshot);
							yield* this.emit({
								type: "account-usage",
								accountId: input.account?.id ?? input.instanceId ?? "codex",
								harness: "codex",
								reading: codexUsageReading({ rateLimits: snapshot }, true),
							});
							return;
						}
						// Claimed before the offer: a send arriving now steers into the wake.
						if (
							!session.busy &&
							session.last &&
							decoded._tag === "known" &&
							decoded.method === "turn/started" &&
							decoded.params.threadId === session.threadId
						) {
							session.busy = true;
							yield* this.wake(session.last, decoded.params.turn.id);
						} else if (
							decoded._tag === "known" &&
							decoded.method === "turn/started" &&
							decoded.params.threadId === session.threadId
						)
							child.unclaimed.push(decoded.params.turn.id);
						yield* Queue.offer(updates, {
							notification,
							at: yield* Clock.currentTimeMillis,
						});
						// 8.2 (CONTRACT.md 2791-2793): re-read at turn completion and at a terminal
						// command's start or finish, a late one included; it only updates the set.
						if (
							decoded._tag === "known" &&
							(decoded.method === "turn/completed" ||
								((decoded.method === "item/started" ||
									decoded.method === "item/completed") &&
									decoded.params.item.type === "commandExecution")) &&
							decoded.params.threadId === session.threadId
						)
							yield* this.refreshTerminals(
								input.sessionId,
								session,
								client,
							).pipe(Effect.forkIn(scope));
					}),
				).pipe(
					Effect.catch((failure) =>
						Effect.gen(function* () {
							child.dead = true;
							yield* session.subagents
								?.interrupt("error", turnFailure(failure).message)
								.pipe(Effect.ignore) ?? Effect.void;
							yield* Queue.offer(updates, { failure });
						}),
					),
					Effect.forkIn(scope),
				);
				yield* transport.exit.pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							child.dead = true;
						}),
					),
					Effect.forkIn(scope),
				);
				const start = () =>
					client
						.request(
							"thread/start",
							{
								cwd: session.cwd,
								model: input.model?.modelId,
								dynamicTools: [SERVER_MARK_TOOL],
							},
							ThreadStartResponseSchema,
						)
						.pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									session.inheritedThreadIds = undefined;
								}),
							),
						);
				const fork = () =>
					client
						.request(
							"thread/fork",
							{
								...session.forkSource,
								cwd: session.cwd,
								model: input.model?.modelId,
								excludeTurns: true,
							},
							ThreadForkResponseSchema,
						)
						.pipe(
							Effect.catch(
								(
									failure,
								): Effect.Effect<
									typeof ThreadStartResponseSchema.Type,
									unknown
								> => {
									if (
										failure instanceof AppServerRpcError &&
										/no (?:archived )?rollout found|(?:thread|rollout|turn)(?:Id)? not found\b|(?:thread|rollout|turn) id \S+ (?:was )?not found\b/i.test(
											failure.message,
										) &&
										session.resumeFallbackDigest &&
										!input.rewind
									) {
										session.forkSource = undefined;
										session.forkSeedPending = true;
										session.continuationKind = "transcript-digest";
										session.continuationInputId = input.inputId;
										return start();
									}
									return Effect.fail(
										failure instanceof AppServerRpcError
											? {
													code: "codex_fork_failed" as const,
													message: `Could not fork Codex thread ${session.forkSource?.threadId}: ${failure.message}`,
												}
											: failure,
									);
								},
							),
						);
				const resume = () =>
					client.request(
						"thread/resume",
						{
							threadId: session.threadId,
							excludeTurns: true,
							cwd: session.cwd,
							model: input.model?.modelId,
						},
						ThreadResumeResponseSchema,
					);
				const thread = session.threadId
					? yield* resume().pipe(
							Effect.catch(
								(
									cause,
								): Effect.Effect<
									typeof ThreadResumeResponseSchema.Type,
									unknown
								> => {
									if (
										!(cause instanceof AppServerRpcError) ||
										cause.code !== -32600 ||
										!/no (?:archived )?rollout found|archived/i.test(
											cause.message,
										)
									)
										return Effect.fail(cause);
									return Effect.gen(function* () {
										yield* client
											.request(
												"thread/unarchive",
												{ threadId: session.threadId },
												ThreadUnarchiveResponseSchema,
											)
											.pipe(
												Effect.catch((failure) =>
													failure instanceof AppServerRpcError
														? Effect.void
														: Effect.fail(failure),
												),
											);
										return yield* resume().pipe(
											Effect.catch(
												(
													failure,
												): Effect.Effect<
													typeof ThreadResumeResponseSchema.Type,
													unknown
												> => {
													if (
														failure instanceof AppServerRpcError &&
														/no (?:archived )?rollout found|(?:thread|rollout).*(?:not found|missing)/i.test(
															failure.message,
														) &&
														session.resumeFallbackDigest &&
														!input.rewind
													) {
														session.forkSeedPending = true;
														session.continuationKind = "transcript-digest";
														return start();
													}
													return Effect.fail(
														failure instanceof AppServerRpcError
															? {
																	code: "codex_thread_missing" as const,
																	message: `Could not resume Codex thread ${session.threadId}: ${failure.message}`,
																}
															: failure,
													);
												},
											),
										);
									});
								},
							),
						)
					: yield* session.forkSource ? fork() : start();
				if (!session.forkSeedPending) session.resumeFallbackDigest = undefined;
				session.threadId = thread.thread.id;
				yield* this.persistIdentity(input.sessionId, session, thread.thread.id);
				session.forkSource = undefined;
				session.controllerPid = process.pid;
				session.child = child;
				// 8.2 (CONTRACT.md 2792): re-read on reconnect. Gap: read as every new app-server
				// connection; terminals of one that has gone are gone with it.
				yield* this.refreshTerminals(input.sessionId, session, client).pipe(
					Effect.forkIn(scope),
				);
				return child;
			}).pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.onError(() => Scope.close(scope, Exit.void)),
			);
		});
	}

	/**
	 * 8.2 (CONTRACT.md 2791-2793): the thread's background terminals are its task set. Gap (2791):
	 * a re-read equal to the set last sent sends nothing; the first always sends, so a reattach has
	 * a snapshot to replay (8.3, 2812-2815). Gap (2817): a failed list sends nothing, so the set
	 * stays as last sent until the next re-read. Returns the listed terminals, if any were read.
	 */
	private refreshTerminals(
		sessionId: string,
		session: CodexSession,
		client: AppServerClient,
	) {
		return session.terminals.lock
			.withPermits(1)(
				Effect.gen(function* () {
					const threadId = session.threadId;
					const sink = session.active?.sink ?? session.last?.sink;
					if (!threadId || !sink) return undefined;
					const list = (cursor?: string) =>
						client.request(
							"thread/backgroundTerminals/list",
							{ threadId, ...(cursor ? { cursor } : {}) },
							ThreadBackgroundTerminalsListResponseSchema,
						);
					let page = yield* list();
					const terminals = [...page.data];
					while (page.nextCursor) {
						page = yield* list(page.nextCursor);
						terminals.push(...page.data);
					}
					const now = Date.now();
					const seen = new Map(
						terminals.map(({ processId }) => [
							processId,
							session.terminals.seen.get(processId) ?? now,
						]),
					);
					session.terminals.seen = seen;
					const tasks = terminals.map(({ processId, command, cwd }) => ({
						key: { taskId: processId },
						taskType: "local_bash",
						description: command,
						ambient: false,
						firstSeenAt: seen.get(processId) ?? now,
						// 8.7 (CONTRACT.md 2988): the PortWatcher's task link matches command and cwd.
						cwd,
					}));
					const sent = JSON.stringify(tasks);
					if (sent === session.terminals.sent) return terminals;
					yield* sink.push({
						eventId: createEventId(),
						type: "evidence.tasks_snapshot",
						providerId: "codex",
						sessionId,
						providerRefs: { providerSessionId: threadId },
						rawSource: { kind: "codex.app-server.translator" },
						createdAt: now,
						data: { label: "", tasks },
					});
					session.terminals.sent = sent;
					return terminals;
				}),
			)
			.pipe(
				Effect.catch((cause) =>
					Effect.sync(() => {
						log.warn("codex.terminals_list_failed", {
							sessionId,
							message: turnFailure(cause).message,
						});
						return undefined;
					}),
				),
			);
	}

	private persistIdentity(
		sessionId: string,
		session: CodexSession,
		threadId: string,
	) {
		return Effect.try(() =>
			writeCodexSessionIdentity(this.deps.daemonConfigDir, sessionId, {
				threadId,
				cwd: session.cwd,
				controllerPid: process.pid,
				...(session.inheritedThreadIds
					? { inheritedThreadIds: session.inheritedThreadIds }
					: {}),
				...(session.codexHome ? { codexHome: session.codexHome } : {}),
				...(session.forkSeedPending ? { forkSeedPending: true } : {}),
				...(session.resumeFallbackDigest
					? { resumeFallbackDigest: session.resumeFallbackDigest }
					: {}),
				...(session.continuationKind
					? { continuationKind: session.continuationKind }
					: {}),
				...(session.continuationInputId
					? { continuationInputId: session.continuationInputId }
					: {}),
			}),
		);
	}

	private result(
		outcome: Pick<TurnResult, "status" | "tokens" | "error">,
		durationMs: number,
	): TurnResult {
		return {
			...outcome,
			cost: 0,
			durationMs,
			...(outcome.error
				? { error: { ...outcome.error, retryHandled: true } }
				: {}),
			providerStateUpdates: [],
		};
	}
}

export const makeCodexSessionRunner = (
	deps: CodexRunnerDeps,
	emit: (
		output: SessionOutput,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
	onTurnStateChanged?: (inFlight: boolean) => void,
) =>
	makeInProcessSessionRunner(
		(sinks) =>
			Effect.gen(function* () {
				const scope = yield* Effect.scope;
				return new CodexRunnerPayload(
					deps,
					sinks,
					emit,
					scope,
					onTurnStateChanged,
				);
			}),
		emit,
	);
