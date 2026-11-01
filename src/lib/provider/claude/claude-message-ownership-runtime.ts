import { Clock, Duration, Effect, Fiber, type Scope, Semaphore } from "effect";
import { createLogger } from "../../logger.js";
import { ClaudeEventPersistEffectTag } from "../../persistence/effect/claude-event-persist-effect.js";
import { createEventId } from "../../persistence/events.js";
import { isRecord } from "../../utils.js";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import {
	claudeTaskNotificationMetadata,
	claudeTaskProgressMetadata,
	claudeTaskStartedMetadata,
	claudeTaskUpdatedMetadata,
	claudeToolProgressMetadata,
} from "./claude-event-translator.js";
import type {
	ClaudeOwnershipDecision,
	ClaudeOwnershipInput,
} from "./claude-message-ownership.js";
import type {
	ClaudeProviderInstanceDeps,
	ClaudeSessionRunnerDeps,
} from "./claude-provider-runtime.js";
import { claudeRuntimeEvent } from "./claude-runtime-event.js";
import {
	type ClaudeSubagentSdk,
	type ClaudeSubagentTranscriptCursor,
	commitClaudeSubagentTranscriptCursor,
	stageSessionMessagesToEvents,
} from "./claude-subagent-materializer.js";
import type {
	ClaudeSessionContext,
	ClaudeSubagentLivePoller,
	ClaudeSubagentTranscriptSnapshot,
	SessionMessage,
} from "./types.js";

const log = createLogger("claude-provider-runtime");
const SUBAGENT_POLL_TIMEOUT_MS = 2000;

type SubagentDeps = Pick<
	ClaudeSessionRunnerDeps,
	"subagentSdk" | "subagentPollTimeoutMs" | "subagentPollIntervalMs"
>;

type EnsureSubagentSession = (
	input: Parameters<
		NonNullable<ClaudeProviderInstanceDeps["ensureClaudeSubagentSession"]>
	>[0],
) => Effect.Effect<void, ClaudeAdapterError>;

type ReadSubagentTranscript = (
	childSessionId: string,
) => Effect.Effect<ClaudeSubagentTranscriptSnapshot, ClaudeAdapterError>;

function subagentTranscript(
	ctx: ClaudeSessionContext,
	childSessionId: string,
	readTranscript: ReadSubagentTranscript | undefined,
): Effect.Effect<ClaudeSubagentTranscriptCursor, ClaudeAdapterError> {
	return Effect.gen(function* () {
		const transcripts = (ctx.subagentTranscripts ??= new Map());
		const existing = transcripts.get(childSessionId);
		if (existing) return existing;
		const cursor: ClaudeSubagentTranscriptCursor = {
			messageRoles: new Map(),
			textOffsets: new Map(),
			thinkingOffsets: new Map(),
			toolStarts: new Set(),
			toolCompletions: new Set(),
			toolMessageIds: new Map(),
		};
		const read =
			yield* resolveReadClaudeSubagentTranscriptEffect(readTranscript);
		if (read) {
			const snapshot = yield* read(childSessionId);
			for (const message of snapshot.messages)
				cursor.messageRoles.set(message.id, message.role);
			for (const part of snapshot.parts) {
				if (part.type === "tool") {
					cursor.toolStarts.add(part.id);
					if (part.status === "completed" || part.status === "error")
						cursor.toolCompletions.add(part.id);
					cursor.toolMessageIds?.set(part.id, part.messageId);
				} else if (part.type === "text" || part.type === "thinking") {
					const separator = part.id.lastIndexOf("-");
					if (separator < 0 || part.id.slice(0, separator) !== part.messageId)
						continue;
					const offsetKey = `${part.messageId}:${part.id.slice(separator + 1)}`;
					const offsets =
						part.type === "text" ? cursor.textOffsets : cursor.thinkingOffsets;
					offsets?.set(offsetKey, part.text?.length ?? 0);
				}
			}
		}
		transcripts.set(childSessionId, cursor);
		return cursor;
	});
}

/** Prefer the Task's human description ("Audit auth flow") — the raw
 *  subagent type is an internal identifier (e.g. "local_agent") and reads
 *  as noise in the session sidebar. */
function claudeSubagentTitle(task?: {
	readonly description?: string;
	readonly subagentType?: string;
}): string {
	if (task?.description) return task.description;
	const subagentType = task?.subagentType;
	if (!subagentType) return "Claude Subagent";
	const first = subagentType[0]?.toUpperCase() ?? "";
	return `${first}${subagentType.slice(1)} Agent`;
}

export function decideClaudeMessageOwnershipEffect(
	ctx: ClaudeSessionContext,
	input: ClaudeOwnershipInput,
	applyDecisions: (
		decisions: readonly ClaudeOwnershipDecision[],
	) => Effect.Effect<void, ClaudeAdapterError>,
): Effect.Effect<void, ClaudeAdapterError> {
	const permit = (ctx.messageOwnershipPermit ??= Semaphore.makeUnsafe(1));
	return Effect.gen(function* () {
		const timedInput =
			input.kind === "sdk"
				? {
						...input,
						receivedAt: input.receivedAt ?? (yield* Clock.currentTimeMillis),
					}
				: input;
		// Sample at SDK ingress, before ownership can hold this start or wait
		// for another delivery. Duplicate starts keep the earliest receipt.
		if (
			ctx.subagentTasks &&
			timedInput.kind === "sdk" &&
			timedInput.message.type === "system" &&
			timedInput.message.subtype === "task_started"
		) {
			const message = timedInput.message;
			const known = ctx.subagentTasks.get(message.task_id);
			const toolUseId = message.tool_use_id ?? known?.toolUseId;
			if (toolUseId !== undefined) {
				const receivedAt = timedInput.receivedAt;
				ctx.subagentTasks.set(message.task_id, {
					...known,
					toolUseId,
					startedAt: Math.min(known?.startedAt ?? receivedAt, receivedAt),
					...(message.workflow_name
						? { workflowName: message.workflow_name }
						: {}),
				});
			}
		}
		yield* permit.withPermits(1)(
			// Once an issuer is registered, deliver its tool before another input can
			// use it. Finish reserved deliveries before a final read interrupts a poll.
			Effect.uninterruptible(
				Effect.suspend(() => {
					const decisions = ctx.messageOwnership?.decide(timedInput) ?? [];
					// Record terminal reports before delivery can fork a final read.
					// Replayed held reports take this path as well as live SDK input.
					for (const decision of decisions) {
						if (decision.kind !== "route" || !decision.tool) continue;
						const message = decision.message;
						if (message.type !== "system") continue;
						const status =
							message.subtype === "task_notification"
								? message.status
								: message.subtype === "task_updated"
									? message.patch.status
									: undefined;
						if (
							status !== "completed" &&
							status !== "failed" &&
							status !== "stopped" &&
							status !== "killed"
						)
							continue;
						if (!("task_id" in message)) continue;
						ctx.subagentTasks?.set(message.task_id, {
							...ctx.subagentTasks.get(message.task_id),
							toolUseId: decision.tool.toolUseId,
							outcome:
								status === "completed"
									? "completed"
									: status === "failed"
										? "error"
										: "interrupted",
							...(status === "failed" && message.subtype === "task_notification"
								? { failureMessage: message.summary }
								: {}),
							...(status === "failed" &&
							message.subtype === "task_updated" &&
							message.patch.error
								? { failureMessage: message.patch.error }
								: {}),
						});
					}
					return applyDecisions(decisions);
				}),
			),
		);
	});
}

export function applyClaudeOwnershipDecisionEffect(
	ensureSession: EnsureSubagentSession | undefined,
	ctx: ClaudeSessionContext,
	decision: ClaudeOwnershipDecision,
	parentClaudeSessionId?: string,
	options: {
		readonly allowStopped?: boolean;
		readonly readTranscript?: ReadSubagentTranscript;
	} = {},
): Effect.Effect<Effect.Effect<void> | undefined, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (decision.kind === "hold" || decision.kind === "drop") {
			logClaudeOwnershipDecision(ctx, decision);
			return;
		}
		if (decision.kind === "start-feed" || decision.kind === "final-read")
			return;
		const failed = (ctx.failedSubagentSessions ??= new Set());
		if (decision.kind === "route" || decision.kind === "route-transcript") {
			let childSessionId: string;
			// The agent task owning this session, when known from a route.
			let ownerTaskId: string | undefined;
			if (decision.kind === "route-transcript")
				childSessionId = decision.childSessionId;
			else {
				if (decision.owner.kind === "parent") return;
				childSessionId = decision.owner.childSessionId;
				ownerTaskId = decision.owner.taskId;
			}
			if (failed.has(childSessionId)) {
				log.warn(`Dropping Claude messages for failed child ${childSessionId}`);
				return;
			}
			const sink =
				ctx.stopped && !options.allowStopped ? undefined : ctx.eventSink;
			if (!sink) return;
			let messages: readonly SessionMessage[] | undefined;
			if (decision.kind === "route-transcript") messages = decision.messages;
			else {
				const message = decision.message;
				if (message.type === "assistant" || message.type === "user")
					messages = [
						{
							type: message.type,
							uuid: message.uuid ?? "",
							session_id: message.session_id ?? parentClaudeSessionId ?? "",
							message: message.message,
							parent_tool_use_id: message.parent_tool_use_id ?? null,
							parent_agent_id: null,
						},
					];
			}
			if (messages) {
				const cursor = yield* subagentTranscript(
					ctx,
					childSessionId,
					options.readTranscript,
				);
				const stage = stageSessionMessagesToEvents({
					childSessionId,
					messages,
					cursor,
				});
				// Ownership holds its permit through reservation and every event push.
				commitClaudeSubagentTranscriptCursor(cursor, stage.cursor);
				// As for Codex children, the child's prompt opens an observed run
				// that owns its turn until child or ownership-end settlement. After
				// ownership ends, late history still persists but opens no run.
				const runs = (ctx.subagentRunIds ??= new Map());
				for (const event of stage.events) {
					const promptId =
						!ctx.subagentRunsClosed &&
						event.type === "message.created" &&
						isRecord(event.data) &&
						event.data["role"] === "user" &&
						!runs.has(childSessionId)
							? String(event.data["messageId"])
							: undefined;
					const runId = promptId ? createEventId() : runs.get(childSessionId);
					yield* sink.push(runId ? { ...event, runId } : event);
					if (promptId && runId) {
						yield* sink.push(
							claudeRuntimeEvent(
								"run.started",
								childSessionId,
								{ inputId: promptId, requestedRunId: runId },
								runId,
							),
						);
						// A sweep can only claim runs whose start has committed. If it
						// closed ownership during delivery, settle this late start here.
						if (ctx.subagentRunsClosed)
							yield* settleClaudeSubagentRunEffect(
								ctx,
								childSessionId,
								runId,
								SUBAGENT_POLL_TIMEOUT_MS,
							);
						else runs.set(childSessionId, runId);
					}
				}
				return;
			}
			if (decision.kind !== "route" || !decision.tool) return;
			const sdkMessage = decision.message;
			let metadata: Record<string, unknown>;
			if (sdkMessage.type === "tool_progress") {
				metadata = claudeToolProgressMetadata(sdkMessage);
			} else if (sdkMessage.type === "system") {
				switch (sdkMessage.subtype) {
					case "task_started": {
						// A task started inside an agent: remember which task started it.
						const known = ctx.subagentTasks?.get(sdkMessage.task_id);
						const startedAt =
							known?.startedAt ?? (yield* Clock.currentTimeMillis);
						ctx.subagentTasks?.set(sdkMessage.task_id, {
							...known,
							toolUseId: decision.tool.toolUseId,
							...(ownerTaskId ? { parentTaskId: ownerTaskId } : {}),
							startedAt,
						});
						metadata = claudeTaskStartedMetadata(sdkMessage, startedAt);
						break;
					}
					case "task_progress":
						metadata = claudeTaskProgressMetadata(sdkMessage);
						break;
					case "task_notification":
						metadata = claudeTaskNotificationMetadata(sdkMessage);
						break;
					case "task_updated": {
						const task = ctx.subagentTasks?.get(sdkMessage.task_id);
						const update = claudeTaskUpdatedMetadata(
							sdkMessage,
							decision.receivedAt ?? (yield* Clock.currentTimeMillis),
							task,
						);
						ctx.subagentTasks?.set(sdkMessage.task_id, {
							...task,
							toolUseId: decision.tool.toolUseId,
							pausedAt: update.pausedAt,
							pausedMs: update.pausedMs,
						});
						metadata = update;
						break;
					}
					default:
						return;
				}
			} else return;
			yield* sink.push(
				claudeRuntimeEvent("tool.running", childSessionId, {
					messageId: decision.tool.issuingMessageId ?? "",
					partId: decision.tool.toolUseId,
					metadata,
				}),
			);
			return;
		}

		const { childSessionId, taskId, toolUseId, issuer } = decision;
		if (issuer.kind === "child" && failed.has(issuer.childSessionId)) {
			failed.add(childSessionId);
			log.warn(
				`Dropping Claude child ${childSessionId}: issuer ${issuer.childSessionId} failed`,
			);
			return;
		}
		const task = {
			toolUseId,
			...(decision.issuingMessageId
				? { parentMessageId: decision.issuingMessageId }
				: {}),
			...(decision.description ? { description: decision.description } : {}),
			...(decision.taskType ? { subagentType: decision.taskType } : {}),
		};
		const ensureClaudeSubagentSession =
			yield* resolveEnsureClaudeSubagentSessionEffect(ensureSession);
		if (ensureClaudeSubagentSession) {
			const ensured = yield* ensureClaudeSubagentSession({
				childSessionId,
				parentSessionId: ctx.sessionId,
				providerSessionId: taskId,
				title: claudeSubagentTitle(task),
			}).pipe(
				Effect.as(true),
				Effect.catch((err) =>
					Effect.sync(() => {
						log.warn(
							`Failed to ensure Claude subagent session for ${ctx.sessionId}/${taskId}: ${err instanceof Error ? err.message : err}`,
						);
						return false;
					}),
				),
			);
			if (!ensured) {
				failed.add(childSessionId);
				return;
			}
		}
		// Ownership can discover a live child after its launching tool returned.
		// Its status starts here regardless of that tool part's completion state.
		yield* ctx.eventSink
			?.push(
				claudeRuntimeEvent("session.status", childSessionId, {
					sessionId: childSessionId,
					status: "busy",
				}),
			)
			.pipe(Effect.ignore) ?? Effect.void;
		ctx.subagentTasks?.set(taskId, {
			...ctx.subagentTasks.get(taskId),
			...task,
			childSessionId,
			...(issuer.kind === "child" ? { parentTaskId: issuer.taskId } : {}),
		});

		const childLink = ctx.eventSink
			? ctx.eventSink
					.push(
						claudeRuntimeEvent(
							"tool.running",
							issuer.kind === "parent" ? ctx.sessionId : issuer.childSessionId,
							{
								messageId:
									decision.issuingMessageId ??
									(issuer.kind === "parent"
										? ctx.lastAssistantUuid
										: undefined) ??
									"",
								partId: toolUseId,
								metadata: {
									...(task?.description
										? { description: task.description }
										: {}),
									...(task?.subagentType
										? { subagentType: task.subagentType }
										: {}),
									childSessionId,
									sdkSubagentId: taskId,
									providerTaskId: taskId,
								},
							},
							issuer.kind === "parent"
								? (ctx.toolRunIds?.get(toolUseId) ??
										(decision.issuingMessageId
											? ctx.messageRunIds?.get(decision.issuingMessageId)
											: undefined))
								: undefined,
						),
					)
					.pipe(
						Effect.catch((err) =>
							Effect.sync(() => {
								log.warn(
									`Failed to push Claude subagent metadata for ${ctx.sessionId}/${taskId}: ${err instanceof Error ? err.message : err}`,
								);
							}),
						),
					)
			: undefined;
		if (issuer.kind === "child" && childLink) yield* childLink;

		// A parent task_started may create its tool part during translation.
		// Publish its link after that route so the projector can merge it.
		return issuer.kind === "parent" ? childLink : undefined;
	});
}

function logClaudeOwnershipDecision(
	ctx: ClaudeSessionContext,
	decision: Extract<ClaudeOwnershipDecision, { kind: "hold" | "drop" }>,
): void {
	if (decision.kind === "hold") {
		log.debug(
			`Holding Claude message ${decision.message.uuid} for ${ctx.sessionId}, awaiting ${decision.awaiting}`,
		);
	} else {
		log.warn(
			`Dropping Claude message ${decision.message.uuid} for ${ctx.sessionId}: ${decision.reason}`,
		);
	}
}

function getSubagentPollers(
	ctx: ClaudeSessionContext,
): Map<string, ClaudeSubagentLivePoller> {
	if (ctx.subagentPollers) return ctx.subagentPollers;
	const pollers = new Map<string, ClaudeSubagentLivePoller>();
	(
		ctx as { subagentPollers: Map<string, ClaudeSubagentLivePoller> }
	).subagentPollers = pollers;
	return pollers;
}

function resolveEnsureClaudeSubagentSessionEffect(
	ensureClaudeSubagentSession: EnsureSubagentSession | undefined,
): Effect.Effect<EnsureSubagentSession | undefined> {
	return Effect.gen(function* () {
		if (ensureClaudeSubagentSession) {
			return ensureClaudeSubagentSession;
		}
		// Claude provider turn callbacks run outside the relay persistence context.
		const persist = yield* Effect.serviceOption(ClaudeEventPersistEffectTag);
		return persist._tag === "Some"
			? persist.value.ensureClaudeSubagentSession
			: undefined;
	});
}

function resolveReadClaudeSubagentTranscriptEffect(
	readTranscript: ReadSubagentTranscript | undefined,
): Effect.Effect<ReadSubagentTranscript | undefined> {
	return Effect.gen(function* () {
		if (readTranscript) return readTranscript;
		const persist = yield* Effect.serviceOption(ClaudeEventPersistEffectTag);
		return persist._tag === "Some"
			? (childSessionId: string) =>
					persist.value.readClaudeSubagentTranscript(childSessionId).pipe(
						Effect.mapError(
							(cause) =>
								new ClaudeBoundaryError({
									operation: "readClaudeSubagentTranscript",
									cause,
								}),
						),
					)
			: undefined;
	});
}

export function startClaudeSubagentFeedEffect(
	deps: SubagentDeps,
	scope: Scope.Scope,
	ctx: ClaudeSessionContext,
	decision: Extract<ClaudeOwnershipDecision, { kind: "start-feed" }>,
	applyDecisions: (
		decisions: readonly ClaudeOwnershipDecision[],
	) => Effect.Effect<void, ClaudeAdapterError>,
	parentClaudeSessionId?: string,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const sdk = deps.subagentSdk;
		if (
			!sdk ||
			!parentClaudeSessionId ||
			ctx.stopped ||
			ctx.failedSubagentSessions?.has(decision.childSessionId)
		)
			return;
		const poller: ClaudeSubagentLivePoller = {
			sdkSubagentId: decision.taskId,
			childSessionId: decision.childSessionId,
			parentClaudeSessionId,
			active: true,
		};
		getSubagentPollers(ctx).set(decision.taskId, poller);
		// A nested feed must outlive the poll that discovered its issuer.
		poller.fiber = yield* Effect.forkIn(
			Effect.gen(function* () {
				while (canPollSubagent(ctx, poller, {})) {
					yield* Effect.sleep(deps.subagentPollIntervalMs ?? 500);
					yield* pollClaudeSubagentOnceEffect(
						deps,
						ctx,
						poller,
						sdk,
						applyDecisions,
					).pipe(
						Effect.catch((err) =>
							Effect.sync(() =>
								log.warn(
									`Claude subagent poll failed for ${ctx.sessionId}/${poller.sdkSubagentId}: ${err instanceof Error ? err.message : err}`,
								),
							),
						),
					);
				}
			}).pipe(Effect.interruptible),
			scope,
		);
	});
}

function settleClaudeSubagentRunEffect(
	ctx: ClaudeSessionContext,
	sessionId: string,
	runId: string,
	timeoutMs: number,
): Effect.Effect<void> {
	const task = [...(ctx.subagentTasks?.values() ?? [])].find(
		(task) => task.childSessionId === sessionId,
	);
	const outcome = task?.outcome ?? "interrupted";
	const event =
		outcome === "error"
			? claudeRuntimeEvent(
					"turn.error",
					sessionId,
					{
						messageId: "",
						error: task?.failureMessage || "Claude subagent failed",
					},
					runId,
				)
			: claudeRuntimeEvent(
					outcome === "interrupted" ? "turn.interrupted" : "turn.completed",
					sessionId,
					{ messageId: "" },
					runId,
				);
	return (ctx.eventSink?.push(event) ?? Effect.void).pipe(
		Effect.interruptible,
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () =>
				Effect.sync(() =>
					log.warn(
						`Claude child run settlement ${sessionId}/${runId} timed out; runner-exit recovery will interrupt the open run`,
					),
				),
		}),
		Effect.catch((err) =>
			Effect.sync(() =>
				log.warn(
					`Claude child run settlement ${sessionId}/${runId} failed; runner-exit recovery will interrupt the open run: ${err}`,
				),
			),
		),
	);
}

/** Claim delivery attempts synchronously; open store rows remain recoverable on exit. */
function settleClaudeSubagentRunsEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	childSessionId?: string,
): Effect.Effect<void> {
	return Effect.suspend(() => {
		if (childSessionId === undefined) ctx.subagentRunsClosed = true;
		const runs = [...(ctx.subagentRunIds ?? [])].filter(
			([sessionId]) =>
				childSessionId === undefined || sessionId === childSessionId,
		);
		for (const [sessionId] of runs) ctx.subagentRunIds?.delete(sessionId);
		return Effect.forEach(
			runs,
			([sessionId, runId]) =>
				settleClaudeSubagentRunEffect(
					ctx,
					sessionId,
					runId,
					subagentPollTimeoutMs(deps),
				),
			{ concurrency: 2, discard: true },
		);
	}).pipe(Effect.uninterruptible);
}

export function finalReadClaudeSubagentFeedEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	decision: Extract<ClaudeOwnershipDecision, { kind: "final-read" }>,
	applyDecisions: (
		decisions: readonly ClaudeOwnershipDecision[],
	) => Effect.Effect<void, ClaudeAdapterError>,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		// A finish or ownership teardown ends the child's work, even if the
		// final transcript is unavailable or the task never got a poller.
		yield* ctx.eventSink
			?.push(
				claudeRuntimeEvent("session.status", decision.childSessionId, {
					sessionId: decision.childSessionId,
					status: "idle",
				}),
			)
			.pipe(Effect.ignore) ?? Effect.void;
		const poller = ctx.subagentPollers?.get(decision.taskId);
		if (!poller) return;
		poller.active = false;
		ctx.subagentPollers?.delete(decision.taskId);
		if (poller.fiber) yield* Fiber.interrupt(poller.fiber);
		const sdk = deps.subagentSdk;
		if (!sdk) return;
		yield* pollClaudeSubagentOnceEffect(
			deps,
			ctx,
			poller,
			sdk,
			applyDecisions,
			{ allowInactive: true },
		);
	}).pipe(
		Effect.ensuring(
			settleClaudeSubagentRunsEffect(deps, ctx, decision.childSessionId),
		),
		Effect.catch((err) =>
			Effect.sync(() =>
				log.warn(
					`Final Claude subagent poll failed for ${ctx.sessionId}/${decision.taskId}: ${err instanceof Error ? err.message : err}`,
				),
			),
		),
	);
}

export function endClaudeMessageOwnershipEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		for (const poller of ctx.subagentPollers?.values() ?? [])
			poller.active = false;
		const permit = (ctx.messageOwnershipPermit ??= Semaphore.makeUnsafe(1));
		const decisions = yield* permit.withPermits(1)(
			Effect.sync(() => ctx.messageOwnership?.decide({ kind: "end" }) ?? []),
		);
		// Publish idle before a slow final read can consume the shared budget.
		yield* Effect.forEach(
			decisions,
			(decision) =>
				decision.kind === "final-read"
					? (ctx.eventSink
							?.push(
								claudeRuntimeEvent("session.status", decision.childSessionId, {
									sessionId: decision.childSessionId,
									status: "idle",
								}),
							)
							.pipe(Effect.ignore) ?? Effect.void)
					: Effect.void,
			{ concurrency: 2, discard: true },
		);
		// Final reads re-enter ownership with transcript inputs after end releases
		// the permit; no SDK input can open another feed once the core has ended.
		yield* Effect.forEach(
			decisions,
			(decision) =>
				decision.kind === "final-read"
					? finalReadClaudeSubagentFeedEffect(
							deps,
							ctx,
							decision,
							(decisions) =>
								Effect.forEach(
									decisions,
									(route) =>
										applyClaudeOwnershipDecisionEffect(
											undefined,
											ctx,
											route,
											ctx.resumeSessionId,
											{ allowStopped: true },
										),
									{ discard: true },
								),
						)
					: applyClaudeOwnershipDecisionEffect(undefined, ctx, decision).pipe(
							Effect.asVoid,
						),
			{ concurrency: 2, discard: true },
		);
	}).pipe(
		Effect.interruptible,
		// Sweep before cancelling reads: interruption may wait for an already
		// reserved, uninterruptible transcript delivery to finish.
		Effect.raceFirst(
			Effect.sleep(Duration.millis(subagentPollTimeoutMs(deps))).pipe(
				// A completed read or caller cancellation also sweeps before the
				// race waits for its other fiber's uninterruptible delivery.
				Effect.ensuring(settleClaudeSubagentRunsEffect(deps, ctx)),
				Effect.andThen(
					Effect.fail(
						new ClaudeRuntimeError({
							message: `Claude subagent finalization ${ctx.sessionId} timed out after ${subagentPollTimeoutMs(deps)}ms`,
						}),
					),
				),
			),
		),
		Effect.catch((err) =>
			Effect.sync(() =>
				log.warn(
					`Claude subagent finalization failed for ${ctx.sessionId}: ${err instanceof Error ? err.message : err}`,
				),
			),
		),
		Effect.ensuring(
			Effect.gen(function* () {
				// Timeout can leave decisions queued behind the concurrency limit.
				const remaining = Array.from(ctx.subagentPollers?.values() ?? []);
				for (const poller of remaining) poller.active = false;
				ctx.subagentPollers?.clear();
				for (const poller of remaining) {
					if (poller.fiber)
						yield* Effect.sync(() => poller.fiber?.interruptUnsafe());
				}
				// Final reads queued behind the shared budget never enter their own
				// finalizers. Claim every remaining run here, including those children.
				yield* settleClaudeSubagentRunsEffect(deps, ctx);
			}),
		),
	);
}

function pollClaudeSubagentOnceEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	subagentSdk: ClaudeSubagentSdk,
	applyDecisions: (
		decisions: readonly ClaudeOwnershipDecision[],
	) => Effect.Effect<void, ClaudeAdapterError>,
	options: { readonly allowInactive?: boolean } = {},
): Effect.Effect<void, ClaudeAdapterError> {
	if (!canPollSubagent(ctx, poller, options)) return Effect.void;
	return Effect.gen(function* () {
		if (!canPollSubagent(ctx, poller, options)) return;
		const messages = yield* Effect.tryPromise({
			try: () =>
				subagentSdk.getSubagentMessages(
					poller.parentClaudeSessionId,
					poller.sdkSubagentId,
					{
						dir: ctx.workspaceRoot,
						configDir: ctx.configDir,
					},
				),
			catch: (cause) =>
				new ClaudeBoundaryError({ operation: "getSubagentMessages", cause }),
		}).pipe(
			Effect.interruptible,
			Effect.timeoutOrElse({
				duration: Duration.millis(subagentPollTimeoutMs(deps)),
				orElse: () =>
					Effect.fail(
						new ClaudeRuntimeError({
							message: `Claude subagent poll ${ctx.sessionId}/${poller.sdkSubagentId} timed out after ${subagentPollTimeoutMs(deps)}ms`,
						}),
					),
			}),
		);
		if (!canPollSubagent(ctx, poller, options)) return;
		yield* decideClaudeMessageOwnershipEffect(
			ctx,
			{
				kind: "transcript",
				taskId: poller.sdkSubagentId,
				messages,
			},
			applyDecisions,
		);
	});
}

function canPollSubagent(
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	options: { readonly allowInactive?: boolean },
): boolean {
	return options.allowInactive === true || (!ctx.stopped && poller.active);
}

function subagentPollTimeoutMs(deps: SubagentDeps): number {
	return deps.subagentPollTimeoutMs ?? SUBAGENT_POLL_TIMEOUT_MS;
}
