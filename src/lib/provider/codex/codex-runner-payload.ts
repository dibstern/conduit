import {
	Clock,
	Deferred,
	Effect,
	Exit,
	Queue,
	Schema,
	Scope,
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
import { runnerPidAlive } from "../runner/runner-registry.js";
import type { RunnerSinkBindings } from "../runner/runner-sink-bindings.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionTurn,
} from "../runner/session-runner.js";
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
	SkillInputSchema,
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
import { codexRuntimeEvent, recordCodexTurnRefs } from "./codex-item-mapper.js";
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
const decodeSkillInput = Schema.decodeUnknownOption(SkillInputSchema);

export interface CodexRunnerDeps {
	readonly workspaceRoot: string;
	readonly daemonConfigDir: string;
	readonly environment?: () => Readonly<Record<string, string | undefined>>;
}

type ChildUpdate =
	| { readonly notification: AppServerNotification }
	| { readonly interrupted: true }
	| { readonly failure: unknown };

interface CodexChild {
	readonly scope: Scope.Closeable;
	readonly client: AppServerClient;
	readonly updates: Queue.Queue<ChildUpdate>;
	dead: boolean;
}

interface ActiveTurn {
	state: CodexTurnState;
	readonly interactions: CodexInteractions;
	readonly started: Deferred.Deferred<string | undefined>;
	readonly cancelled: Deferred.Deferred<void>;
	cancelRequested: boolean;
	submitted: boolean;
	readonly steers: Map<
		string,
		{
			readonly input: SessionTurn;
			readonly sinkId: string;
			readonly finished: Deferred.Deferred<boolean, SessionFailure>;
		}
	>;
	readonly userItems: Set<string>;
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
	) {}

	sendTurn(
		input: SessionTurn,
		sink: EventSink,
		signal: AbortSignal,
	): Effect.Effect<TurnResult, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			let session = this.sessions.get(input.sessionId);
			if (!session) {
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
				const digest = input.providerState["codex.forkDigest"];
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
				};
				this.sessions.set(input.sessionId, session);
			}
			if (session.busy) return yield* this.steer(session, input, sink);
			const current = session;
			// Keep the outcome durable until a different input supersedes it.
			if (current.continuationInputId !== input.inputId) {
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
			const now = yield* Clock.currentTimeMillis;
			const active: ActiveTurn = {
				state: createCodexTurnState({
					sessionId: input.sessionId,
					turnId: input.inputId,
					messageId: createEventId(),
					providerId: "codex",
					threadId: current.threadId ?? input.sessionId,
					now,
					...(input.goalState ? { goalState: input.goalState } : {}),
					tokenUsageBaseline: current.tokenUsageTotal,
				}),
				started: yield* Deferred.make<string | undefined>(),
				cancelled: yield* Deferred.make<void>(),
				cancelRequested: signal.aborted,
				submitted: false,
				steers: new Map(),
				userItems: new Set(),
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
			const apply = (update: CodexTurnUpdate) =>
				Effect.gen(function* () {
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
					if (!active.state.executingTurnId || update.outcome) {
						for (const pending of active.steers.values())
							yield* Deferred.succeed(pending.finished, false);
					}
					if (update.outcome) {
						current.busy = false;
						yield* Deferred.succeed(active.started, undefined);
						for (const pending of active.steers.values())
							yield* Deferred.succeed(pending.finished, false);
					}
					if (
						update.outcome?.error?.code === "auth_required" &&
						current.codexHome
					)
						invalidateCodexAuth(current.codexHome);
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
						yield* push(
							"session.usage_limited",
							{
								instanceId: input.account?.id ?? input.instanceId ?? "codex",
								cutOffMessageId:
									input.continuation?.cutOffMessageId ?? input.inputId,
								rateLimitType: limitId,
								...(resets.length ? { resetsAt: Math.max(...resets) } : {}),
							},
							{ modelId: input.model?.modelId },
						);
					}
					for (const event of update.events) yield* sink.push(event);
					return update.outcome;
				});
			return yield* Effect.scoped(
				Effect.gen({ self: this }, function* () {
					const abort = Effect.callback<void>((resume) => {
						const onAbort = () => resume(Effect.void);
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
						return Effect.sync(() =>
							signal.removeEventListener("abort", onAbort),
						);
					});
					yield* abort.pipe(
						Effect.andThen(this.interrupt(input.sessionId)),
						Effect.forkScoped,
					);
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
											text: input.text ?? input.prompt,
											...(input.images?.length ? { images: input.images } : {}),
										},
									});
								yield* push("session.status", {
									sessionId: input.sessionId,
									status: "busy",
								});
								yield* push("message.created", {
									sessionId: input.sessionId,
									messageId: active.state.items.messageId,
									role: "assistant",
								});
							});
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
						const child = yield* Effect.raceFirst(
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
						if (!child || signal.aborted || active.cancelRequested)
							return yield* apply(interruptCodexTurn(active.state, Date.now()));
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
							const beforeTurnId =
								input.providerState["codex.revertBeforeTurnId"];
							if (typeof beforeTurnId === "string") {
								yield* child.client
									.request(
										"thread/revert",
										{
											threadId: current.threadId,
											beforeTurnId,
										},
										ThreadRevertResponseSchema,
									)
									.pipe(
										Effect.mapError((cause) => ({
											message: `Codex conversation rewind failed before turn ${beforeTurnId}: ${cause.message}`,
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
						const compact = input.prompt.trim() === "/compact";
						if (compact)
							active.state = { ...active.state, manualCompaction: true };
						const goalCommand = parseCodexGoalCommand(input.prompt);
						if (goalCommand && !["set", "resume"].includes(goalCommand.type)) {
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
							current.resumeFallbackDigest ??
							input.providerState["codex.forkDigest"];
						const seed =
							current.forkSeedPending &&
							typeof digest === "string" &&
							digest.length > 0
								? digest
								: undefined;
						const effort = input.providerState["codex.effort"];
						const skill = decodeSkillInput(input.providerState["codex.skill"]);
						// No yield between checking cancellation and submitting the turn.
						if (signal.aborted || active.cancelRequested)
							return yield* apply(interruptCodexTurn(active.state, Date.now()));
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
										...(skill._tag === "Some" ? [skill.value] : []),
										...(input.images ?? []).map((url) => ({
											type: "image",
											url,
										})),
									],
									cwd: current.cwd,
									model: input.model.modelId,
									...(typeof effort === "string" ? { effort } : {}),
									summary: "detailed",
									...codexSessionConfig({
										permissionMode: input.permissionMode,
										cwd: current.cwd,
										modelId: input.model.modelId,
										effort: typeof effort === "string" ? effort : undefined,
									}),
								},
								TurnStartResponseSchema,
							);
							active.state = acceptCodexTurn(
								active.state,
								accepted.turn.id,
								accepted.turn.startedAt,
							);
							const refs = recordCodexTurnRefs(active.state.items);
							active.state = { ...active.state, items: refs.items };
							for (const event of refs.events) yield* sink.push(event);
							if (active.state.executingTurnId)
								yield* Deferred.succeed(
									active.started,
									active.state.executingTurnId,
								);
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
						while (!active.state.settled) {
							const deadline = active.state.successorDeadline;
							if (deadline !== undefined) {
								const expired = expireCodexGoalSuccessor(
									active.state,
									yield* Clock.currentTimeMillis,
								);
								if (expired.outcome) return yield* apply(expired);
							}
							const update = yield* deadline === undefined
								? Queue.take(child.updates)
								: Queue.take(child.updates).pipe(
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
							if ("interrupted" in update)
								return yield* apply(
									interruptCodexTurn(
										active.state,
										yield* Clock.currentTimeMillis,
									),
								);
							if ("failure" in update)
								return yield* Effect.fail(update.failure);
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
							if (decoded.method === "serverRequest/resolved") {
								if (decoded.params.threadId === current.threadId)
									yield* active.interactions.resolve(decoded.params.requestId);
								continue;
							}
							if (
								(decoded.method === "item/started" ||
									decoded.method === "item/completed") &&
								decoded.params.turnId === active.state.executingTurnId &&
								decoded.params.threadId === current.threadId &&
								decoded.params.item.type === "userMessage" &&
								!("raw" in decoded.params.item)
							) {
								const item = decoded.params.item;
								const firstUserItem = active.userItems.size === 0;
								if (!active.userItems.has(item.id)) {
									active.userItems.add(item.id);
									const pending = item.clientId
										? active.steers.get(item.clientId)
										: firstUserItem
											? undefined
											: [...active.steers.values()].find(
													({ input }) =>
														input.prompt ===
														item.content
															.flatMap((part) =>
																part.type === "text" ? [part.text] : [],
															)
															.join(""),
												);
									if (pending) {
										yield* this.emit({
											type: "place-user-message",
											sinkId: pending.sinkId,
											input: {
												sessionId: input.sessionId,
												inputId: pending.input.inputId,
												text: pending.input.text ?? pending.input.prompt,
												...(pending.input.images?.length
													? { images: pending.input.images }
													: {}),
											},
										});
										yield* push(
											"message.created",
											{
												sessionId: input.sessionId,
												messageId: pending.input.inputId,
												role: "user",
											},
											{ source: "codex.native-turn" },
										);
										yield* Deferred.succeed(pending.finished, true);
										active.steers.delete(pending.input.inputId);
									}
								}
							}
							const result = yield* apply(
								handleCodexTurnNotification(
									active.state,
									decoded,
									yield* Clock.currentTimeMillis,
								),
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
					if (current.active === active)
						yield* push("session.status", {
							sessionId: input.sessionId,
							status: "idle",
						});
					return this.result(
						current,
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
					Effect.gen(function* () {
						yield* active.interactions.interrupt();
						for (const pending of active.steers.values())
							yield* Deferred.succeed(pending.finished, false);
						if (current.active === active) {
							current.busy = false;
							current.active = undefined;
						}
						yield* Deferred.succeed(active.started, undefined);
					}),
				),
			);
		});
	}

	interrupt(sessionId: string): Effect.Effect<void, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const session = this.sessions.get(sessionId);
			if (!session) return;
			session.subagents?.beginInterrupt();
			const active = session.active;
			if (!active) {
				yield* this.interruptChildren(session);
				return;
			}
			active.cancelRequested = true;
			active.state = { ...active.state, interruptRequested: true };
			yield* Deferred.succeed(active.cancelled, undefined);
			yield* active.interactions.interrupt();
			if (!active.submitted) return;
			yield* Deferred.await(active.started);
			if (
				active.state.settled ||
				active.interruptSent ||
				!session.child ||
				!session.threadId
			) {
				yield* this.interruptChildren(session);
				return;
			}
			active.interruptSent = true;
			const children = session.subagents?.runningTurns ?? [];
			if (active.state.goalState.goal || active.state.goalActivationPending)
				yield* session.child.client
					.request(
						"thread/goal/set",
						{ threadId: session.threadId, status: "paused", origin: "user" },
						ThreadGoalSetResponseSchema,
					)
					.pipe(
						Effect.catch((cause) =>
							Effect.sync(() =>
								log.warn("codex.goal_pause_failed", {
									message: turnFailure(cause).message,
								}),
							),
						),
					);
			const turnId = active.state.executingTurnId;
			if (!turnId) {
				yield* this.interruptChildren(session, children);
				yield* Queue.offer(session.child.updates, { interrupted: true });
				return;
			}
			yield* session.child.client
				.request(
					"turn/interrupt",
					{ threadId: session.threadId, turnId },
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
			yield* this.interruptChildren(session, children);
			yield* Queue.offer(session.child.updates, { interrupted: true });
		});
	}

	private interruptChildren(
		session: CodexSession,
		turns = session.subagents?.runningTurns ?? [],
	) {
		return Effect.gen(function* () {
			for (const target of turns) {
				if (session.child)
					yield* session.child.client
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
			yield* session.subagents?.interrupt() ?? Effect.void;
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

	private steer(
		session: CodexSession,
		input: SessionTurn,
		sink: EventSink,
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
				if (
					input.prompt.trim() === "/compact" ||
					active?.state.manualCompaction
				)
					return declined;
				const command = parseCodexGoalCommand(input.prompt);
				if (
					active &&
					!active.state.settled &&
					!active.cancelRequested &&
					command &&
					sinkId
				) {
					yield* this.emit({
						type: "place-user-message",
						sinkId,
						input: {
							sessionId: input.sessionId,
							inputId: input.inputId,
							text: input.text ?? input.prompt,
						},
					});
					const facts = yield* this.goalCommand(session, command).pipe(
						Effect.mapError(
							(cause): SessionFailure => ({
								operation: "goal command",
								message: turnFailure(cause).message,
							}),
						),
					);
					if (command.type === "show" && facts && session.child)
						yield* Queue.offer(session.child.updates, { notification: facts });
					return { ...declined, status: "joined" };
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
				const finished = yield* Deferred.make<boolean, SessionFailure>();
				active.steers.set(input.inputId, { input, sinkId, finished });
				yield* session.child.client
					.request(
						"turn/steer",
						{
							threadId: session.threadId,
							expectedTurnId: active.state.executingTurnId,
							clientUserMessageId: input.inputId,
							input: [
								{ type: "text", text: input.prompt, text_elements: [] },
								...(input.images ?? []).map((url) => ({ type: "image", url })),
							],
						},
						TurnSteerResponseSchema,
					)
					.pipe(
						Effect.catch(() => Deferred.succeed(finished, false)),
						Effect.forkScoped,
					);
				const delivered = yield* Deferred.await(finished);
				active.steers.delete(input.inputId);
				return { ...declined, status: delivered ? "joined" : "steer-declined" };
			}),
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
					onServerRequest: (method, params, id) =>
						session.subagents?.request(method, params, id) ??
						session.active?.interactions.request(method, params, id),
				});
				const updates = yield* Queue.unbounded<ChildUpdate>();
				const child: CodexChild = { scope, client, updates, dead: false };
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
						yield* Queue.offer(updates, { notification });
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
							{ cwd: session.cwd, model: input.model?.modelId },
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
				return child;
			}).pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.onError(() => Scope.close(scope, Exit.void)),
			);
		});
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
		session: CodexSession,
		outcome: NonNullable<CodexTurnUpdate["outcome"]>,
		durationMs: number,
	): TurnResult {
		return {
			...outcome,
			cost: 0,
			durationMs,
			...(outcome.error
				? { error: { ...outcome.error, retryHandled: true } }
				: {}),
			...(session.continuationKind
				? {
						handoff: {
							continuationKind: session.continuationKind,
							included: 0,
							omitted: 0,
							firstMessageIncluded: false,
							tokens: 0,
						},
					}
				: {}),
			providerStateUpdates: session.threadId
				? [
						{ key: "codex.threadId", value: session.threadId },
						{ key: "codex.cwd", value: session.cwd },
					]
				: [],
		};
	}
}

export const makeCodexSessionRunner = (
	deps: CodexRunnerDeps,
	emit: (
		output: SessionOutput,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
) =>
	makeInProcessSessionRunner(
		(sinks) =>
			Effect.gen(function* () {
				const scope = yield* Effect.scope;
				return new CodexRunnerPayload(deps, sinks, emit, scope);
			}),
		emit,
	);
