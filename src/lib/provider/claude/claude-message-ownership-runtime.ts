import { Duration, Effect, Fiber, type Scope } from "effect";
import { createLogger } from "../../logger.js";
import { ClaudeEventPersistEffectTag } from "../../persistence/effect/claude-event-persist-effect.js";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import {
	claudeTaskNotificationMetadata,
	claudeTaskProgressMetadata,
	claudeTaskStartedMetadata,
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
	SessionMessage,
} from "./types.js";

const log = createLogger("claude-provider-runtime");
const SUBAGENT_POLL_TIMEOUT_MS = 2000;

type SubagentDeps = Pick<
	ClaudeSessionRunnerDeps,
	"subagentSdk" | "subagentPollTimeoutMs"
>;

type EnsureSubagentSession = (
	input: Parameters<
		NonNullable<ClaudeProviderInstanceDeps["ensureClaudeSubagentSession"]>
	>[0],
) => Effect.Effect<void, ClaudeAdapterError>;

function subagentTranscript(ctx: ClaudeSessionContext, childSessionId: string) {
	const transcripts = (ctx.subagentTranscripts ??= new Map());
	const existing = transcripts.get(childSessionId);
	if (existing) return existing;
	const cursor: ClaudeSubagentTranscriptCursor = {
		messageRoles: new Map(),
		textOffsets: new Map(),
		thinkingOffsets: new Map(),
		toolStarts: new Set(),
		toolCompletions: new Set(),
	};
	transcripts.set(childSessionId, cursor);
	return cursor;
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
	const permit = (ctx.messageOwnershipPermit ??= Effect.unsafeMakeSemaphore(1));
	return permit.withPermits(1)(
		// Once an issuer is registered, deliver its tool before another input can
		// use it. Finish reserved deliveries before a final read interrupts a poll.
		Effect.uninterruptible(
			Effect.suspend(() =>
				applyDecisions(ctx.messageOwnership?.decide(input) ?? []),
			),
		),
	);
}

export function applyClaudeOwnershipDecisionEffect(
	ensureSession: EnsureSubagentSession | undefined,
	ctx: ClaudeSessionContext,
	decision: ClaudeOwnershipDecision,
	parentClaudeSessionId?: string,
	options: { readonly allowStopped?: boolean } = {},
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
			if (decision.kind === "route-transcript")
				childSessionId = decision.childSessionId;
			else {
				if (decision.owner.kind === "parent") return;
				childSessionId = decision.owner.childSessionId;
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
				const cursor = subagentTranscript(ctx, childSessionId);
				const stage = stageSessionMessagesToEvents({
					childSessionId,
					messages,
					cursor,
				});
				// Ownership holds its permit through reservation and every event push.
				commitClaudeSubagentTranscriptCursor(cursor, stage.cursor);
				for (const event of stage.events) yield* sink.push(event);
				return;
			}
			if (decision.kind !== "route" || !decision.tool) return;
			const sdkMessage = decision.message;
			let metadata: Record<string, unknown>;
			if (sdkMessage.type === "tool_progress") {
				metadata = claudeToolProgressMetadata(sdkMessage);
			} else if (sdkMessage.type === "system") {
				switch (sdkMessage.subtype) {
					case "task_started":
						metadata = claudeTaskStartedMetadata(sdkMessage);
						break;
					case "task_progress":
						metadata = claudeTaskProgressMetadata(sdkMessage);
						break;
					case "task_notification":
						metadata = claudeTaskNotificationMetadata(sdkMessage);
						break;
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
				Effect.catchAll((err) =>
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
		ctx.subagentTasks?.set(taskId, { ...task, childSessionId });

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
						),
					)
					.pipe(
						Effect.catchAll((err) =>
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
					yield* Effect.sleep("500 millis");
					yield* pollClaudeSubagentOnceEffect(
						deps,
						ctx,
						poller,
						sdk,
						applyDecisions,
					).pipe(
						Effect.catchAll((err) =>
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

export function finalReadClaudeSubagentFeedEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	decision: Extract<ClaudeOwnershipDecision, { kind: "final-read" }>,
	applyDecisions: (
		decisions: readonly ClaudeOwnershipDecision[],
	) => Effect.Effect<void, ClaudeAdapterError>,
): Effect.Effect<void> {
	return Effect.gen(function* () {
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
		Effect.catchAll((err) =>
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
		const permit = (ctx.messageOwnershipPermit ??=
			Effect.unsafeMakeSemaphore(1));
		const decisions = yield* permit.withPermits(1)(
			Effect.sync(() => ctx.messageOwnership?.decide({ kind: "end" }) ?? []),
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
		// One budget covers the permit wait and every end-time read, regardless
		// of how many agents remain. Callers fork this after foreground cleanup.
		Effect.timeoutFail({
			duration: Duration.millis(subagentPollTimeoutMs(deps)),
			onTimeout: () =>
				new ClaudeRuntimeError({
					message: `Claude subagent finalization ${ctx.sessionId} timed out after ${subagentPollTimeoutMs(deps)}ms`,
				}),
		}),
		Effect.catchAll((err) =>
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
				for (const poller of remaining)
					if (poller.fiber) yield* Fiber.interruptFork(poller.fiber);
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
						...(ctx.configDir !== undefined && { configDir: ctx.configDir }),
					},
				),
			catch: (cause) =>
				new ClaudeBoundaryError({ operation: "getSubagentMessages", cause }),
		}).pipe(
			Effect.interruptible,
			Effect.timeoutFail({
				duration: Duration.millis(subagentPollTimeoutMs(deps)),
				onTimeout: () =>
					new ClaudeRuntimeError({
						message: `Claude subagent poll ${ctx.sessionId}/${poller.sdkSubagentId} timed out after ${subagentPollTimeoutMs(deps)}ms`,
					}),
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
