import { Duration, Effect } from "effect";
import { createLogger } from "../../logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../../persistence/effect/claude-event-persist-effect.js";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";
import { claudeRuntimeEvent } from "./claude-runtime-event.js";
import {
	type ClaudeSubagentSdk,
	type ClaudeSubagentTranscriptCursor,
	claudeSubagentSessionId,
	commitClaudeSubagentTranscriptCursor,
	defaultClaudeSubagentSdk,
	stageSessionMessagesToEvents,
} from "./claude-subagent-materializer.js";
import type {
	ClaudeSessionContext,
	ClaudeSubagentLivePoller,
	SDKMessage,
	SDKResultMessage,
	SDKSystemLike,
	SessionMessage,
} from "./types.js";

const log = createLogger("claude-provider-runtime");
const SUBAGENT_POLL_TIMEOUT_MS = 2000;

type SubagentDeps = Pick<
	ClaudeProviderInstanceDeps,
	| "subagentSdk"
	| "materializeSubagents"
	| "ensureClaudeSubagentSession"
	| "subagentPollTimeoutMs"
>;

function isClaudeTaskStartedMessage(
	message: SDKMessage,
): message is SDKSystemLike & {
	readonly subtype: "task_started";
	readonly task_id: string;
	readonly tool_use_id: string;
	readonly session_id?: string;
} {
	if (message.type !== "system" || message.subtype !== "task_started") {
		return false;
	}
	const task = message as Record<string, unknown>;
	return (
		typeof task["task_id"] === "string" &&
		typeof task["tool_use_id"] === "string"
	);
}

function createClaudeSubagentTranscriptCursor(): ClaudeSubagentTranscriptCursor {
	return {
		messageRoles: new Map(),
		textOffsets: new Map(),
		thinkingOffsets: new Map(),
		toolStarts: new Set(),
		toolCompletions: new Set(),
	};
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
export function detachSubagentFinalizationContext(
	ctx: ClaudeSessionContext,
): ClaudeSessionContext {
	const subagentPollers = new Map(ctx.subagentPollers ?? []);
	const finalizationCtx = {
		...ctx,
		eventSink: ctx.eventSink,
		resumeSessionId: ctx.resumeSessionId,
		lastAssistantUuid: ctx.lastAssistantUuid,
		subagentTasks: new Map(ctx.subagentTasks ?? []),
		subagentPollers,
		get stopped() {
			return ctx.stopped;
		},
	} as ClaudeSessionContext;
	(
		ctx as { subagentPollers: Map<string, ClaudeSubagentLivePoller> }
	).subagentPollers = new Map();
	(
		ctx as { pendingSubagentMessages: Map<string, SessionMessage[]> }
	).pendingSubagentMessages = new Map();
	return finalizationCtx;
}

function materializeSubagentsAfterResultEffect(
	materializeSubagents: ClaudeProviderInstanceDeps["materializeSubagents"],
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (!materializeSubagents) return;
		const parentClaudeSessionId = ctx.resumeSessionId ?? result.session_id;
		if (!parentClaudeSessionId) return;

		const materialized = yield* materializeSubagents({
			parentConduitSessionId: ctx.sessionId,
			parentClaudeSessionId,
			workspaceRoot: ctx.workspaceRoot,
			knownTasks: ctx.subagentTasks ?? new Map(),
		});
		if (ctx.stopped) return;

		for (const child of materialized) {
			if (!child.parentToolUseId || !ctx.eventSink) continue;
			const task = ctx.subagentTasks?.get(child.sdkSubagentId);
			yield* ctx.eventSink.push(
				claudeRuntimeEvent("tool.running", ctx.sessionId, {
					messageId: result.uuid ?? ctx.lastAssistantUuid ?? "",
					partId: child.parentToolUseId,
					metadata: {
						...(task?.description ? { description: task.description } : {}),
						...(task?.subagentType ? { subagentType: task.subagentType } : {}),
						childSessionId: child.childSessionId,
						sdkSubagentId: child.sdkSubagentId,
						providerTaskId: child.sdkSubagentId,
					},
				}),
			);
		}
	});
}

export function finalizeSubagentsAfterResultEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		yield* finalPollAndStopSubagentsEffect(deps, ctx);
		yield* materializeSubagentsAfterResultEffect(
			deps.materializeSubagents,
			ctx,
			result,
		);
	}).pipe(
		Effect.catchAll((err) =>
			Effect.sync(() => {
				log.warn(
					`Final Claude subagent catch-up failed for ${ctx.sessionId}: ${err instanceof Error ? err.message : err}`,
				);
			}),
		),
	);
}

export function handleSubagentTaskStartedEffect(
	ensureSession: ClaudeProviderInstanceDeps["ensureClaudeSubagentSession"],
	ctx: ClaudeSessionContext,
	message: SDKMessage,
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (!isClaudeTaskStartedMessage(message)) return;

		const parentClaudeSessionId = ctx.resumeSessionId ?? message.session_id;
		if (!parentClaudeSessionId) return;

		const pollers = getSubagentPollers(ctx);
		const existingPoller = pollers.get(message.task_id);
		const childSessionId =
			existingPoller?.childSessionId ??
			claudeSubagentSessionId({
				parentConduitSessionId: ctx.sessionId,
				parentClaudeSessionId,
				sdkSubagentId: message.task_id,
			});
		const task = ctx.subagentTasks?.get(message.task_id);
		let sessionReady = false;
		const ensureClaudeSubagentSession =
			yield* resolveEnsureClaudeSubagentSessionEffect(ensureSession);
		sessionReady = ensureClaudeSubagentSession == null;
		if (ensureClaudeSubagentSession) {
			// UX alternative: delay creating the child session until the first forwarded subagent message or final catch-up returns content.
			const ensured = yield* ensureClaudeSubagentSession({
				childSessionId,
				parentSessionId: ctx.sessionId,
				providerSessionId: message.task_id,
				title: claudeSubagentTitle(task),
			}).pipe(
				Effect.as(true),
				Effect.catchAll((err) =>
					Effect.sync(() => {
						log.warn(
							`Failed to ensure Claude subagent session for ${ctx.sessionId}/${message.task_id}: ${err instanceof Error ? err.message : err}`,
						);
						return false;
					}),
				),
			);
			sessionReady = ensured;
		}
		if (!sessionReady) return;

		if (ctx.subagentTasks) {
			ctx.subagentTasks.set(message.task_id, {
				toolUseId: message.tool_use_id,
				childSessionId,
				...(task?.parentMessageId
					? { parentMessageId: task.parentMessageId }
					: {}),
				...(task?.description ? { description: task.description } : {}),
				...(task?.subagentType ? { subagentType: task.subagentType } : {}),
			});
		}

		if (ctx.eventSink) {
			yield* ctx.eventSink
				.push(
					claudeRuntimeEvent("tool.running", ctx.sessionId, {
						messageId: task?.parentMessageId ?? ctx.lastAssistantUuid ?? "",
						partId: message.tool_use_id,
						metadata: {
							...(task?.description ? { description: task.description } : {}),
							...(task?.subagentType
								? { subagentType: task.subagentType }
								: {}),
							childSessionId,
							sdkSubagentId: message.task_id,
							providerTaskId: message.task_id,
						},
					}),
				)
				.pipe(
					Effect.catchAll((err) =>
						Effect.sync(() => {
							log.warn(
								`Failed to push Claude subagent metadata for ${ctx.sessionId}/${message.task_id}: ${err instanceof Error ? err.message : err}`,
							);
						}),
					),
				);
		}

		if (existingPoller) {
			if (sessionReady) {
				existingPoller.sessionReady = true;
				yield* flushPendingSubagentMessagesEffect(ctx, existingPoller);
			}
			return;
		}

		const poller: ClaudeSubagentLivePoller = {
			sdkSubagentId: message.task_id,
			childSessionId,
			parentClaudeSessionId,
			parentToolUseId: message.tool_use_id,
			cursor: createClaudeSubagentTranscriptCursor(),
			sessionReady,
			active: true,
		};
		pollers.set(message.task_id, poller);
		if (sessionReady) {
			yield* flushPendingSubagentMessagesEffect(ctx, poller);
		}
	});
}

export function pushForwardedSubagentMessageEffect(
	ctx: ClaudeSessionContext,
	message: SDKMessage,
): Effect.Effect<boolean, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (message.type !== "assistant" && message.type !== "user") return false;
		const parentToolUseId =
			"parent_tool_use_id" in message &&
			typeof message.parent_tool_use_id === "string"
				? message.parent_tool_use_id
				: undefined;
		if (!parentToolUseId) return false;

		const poller = findSubagentPollerByParentToolUseId(ctx, parentToolUseId);
		if (!poller?.sessionReady) {
			queuePendingSubagentMessage(
				ctx,
				parentToolUseId,
				message as unknown as SessionMessage,
			);
			return true;
		}

		yield* pushForwardedSubagentMessagesEffect(ctx, poller, [
			message as unknown as SessionMessage,
		]);
		return true;
	});
}

function queuePendingSubagentMessage(
	ctx: ClaudeSessionContext,
	parentToolUseId: string,
	message: SessionMessage,
): void {
	const pending = getPendingSubagentMessages(ctx);
	const messages = pending.get(parentToolUseId);
	if (messages) {
		messages.push(message);
	} else {
		pending.set(parentToolUseId, [message]);
	}
}

function flushPendingSubagentMessagesEffect(
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		const pending = getPendingSubagentMessages(ctx);
		const messages = pending.get(poller.parentToolUseId);
		if (!messages || messages.length === 0) return;
		pending.delete(poller.parentToolUseId);
		yield* pushForwardedSubagentMessagesEffect(ctx, poller, messages);
	});
}

function pushForwardedSubagentMessagesEffect(
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	messages: readonly SessionMessage[],
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		const stage = stageSessionMessagesToEvents({
			childSessionId: poller.childSessionId,
			messages,
			cursor: poller.cursor,
		});
		const sink = ctx.eventSink;
		if (!sink) return;
		for (const event of stage.events) {
			yield* sink.push(event);
		}
		commitClaudeSubagentTranscriptCursor(poller.cursor, stage.cursor);
	});
}

function findSubagentPollerByParentToolUseId(
	ctx: ClaudeSessionContext,
	parentToolUseId: string,
): ClaudeSubagentLivePoller | undefined {
	const pollers = ctx.subagentPollers;
	if (!pollers) return undefined;
	for (const poller of pollers.values()) {
		if (poller.parentToolUseId === parentToolUseId) return poller;
	}
	return undefined;
}

function getPendingSubagentMessages(
	ctx: ClaudeSessionContext,
): Map<string, SessionMessage[]> {
	if (ctx.pendingSubagentMessages) return ctx.pendingSubagentMessages;
	const pending = new Map<string, SessionMessage[]>();
	(
		ctx as { pendingSubagentMessages: Map<string, SessionMessage[]> }
	).pendingSubagentMessages = pending;
	return pending;
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

function resolveSubagentSdk(deps: SubagentDeps): ClaudeSubagentSdk | undefined {
	return (
		deps.subagentSdk ??
		(deps.materializeSubagents ? defaultClaudeSubagentSdk : undefined)
	);
}

function resolveEnsureClaudeSubagentSessionEffect(
	ensureClaudeSubagentSession: ClaudeProviderInstanceDeps["ensureClaudeSubagentSession"],
): Effect.Effect<
	ClaudeEventPersistEffect["ensureClaudeSubagentSession"] | undefined
> {
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

function pollClaudeSubagentOnceEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	subagentSdk: ClaudeSubagentSdk,
	options: { readonly allowInactive?: boolean } = {},
): Effect.Effect<void, ClaudeAdapterError> {
	if (!canPollSubagent(ctx, poller, options)) return Effect.void;
	return pollClaudeSubagentSnapshotEffect(
		deps,
		ctx,
		poller,
		subagentSdk,
		options,
	);
}

function pollClaudeSubagentSnapshotEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	subagentSdk: ClaudeSubagentSdk,
	options: { readonly allowInactive?: boolean },
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (!canPollSubagent(ctx, poller, options)) return;
		const messages = yield* Effect.tryPromise({
			try: () =>
				subagentSdk.getSubagentMessages(
					poller.parentClaudeSessionId,
					poller.sdkSubagentId,
					{ dir: ctx.workspaceRoot },
				),
			catch: (cause) =>
				new ClaudeBoundaryError({ operation: "getSubagentMessages", cause }),
		}).pipe(
			Effect.timeoutFail({
				duration: Duration.millis(subagentPollTimeoutMs(deps)),
				onTimeout: () =>
					new ClaudeRuntimeError({
						message: `Claude subagent poll ${ctx.sessionId}/${poller.sdkSubagentId} timed out after ${subagentPollTimeoutMs(deps)}ms`,
					}),
			}),
		);
		if (!canPollSubagent(ctx, poller, options)) return;
		const stage = stageSessionMessagesToEvents({
			childSessionId: poller.childSessionId,
			messages,
			cursor: poller.cursor,
		});
		const sink = ctx.eventSink;
		if (!sink || !canPollSubagent(ctx, poller, options)) return;
		for (const event of stage.events) {
			if (!canPollSubagent(ctx, poller, options)) return;
			yield* sink.push(event);
		}
		if (!canPollSubagent(ctx, poller, options)) return;
		commitClaudeSubagentTranscriptCursor(poller.cursor, stage.cursor);
	});
}

function canPollSubagent(
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	options: { readonly allowInactive?: boolean },
): boolean {
	return (
		poller.sessionReady &&
		!ctx.stopped &&
		(poller.active || options.allowInactive === true)
	);
}

function subagentPollTimeoutMs(deps: SubagentDeps): number {
	return deps.subagentPollTimeoutMs ?? SUBAGENT_POLL_TIMEOUT_MS;
}

function finalPollAndStopSubagentsEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		const pollers = ctx.subagentPollers;
		if (!pollers || pollers.size === 0) return;
		const subagentSdk = resolveSubagentSdk(deps);
		if (!subagentSdk) {
			stopSubagentPollers(ctx);
			return;
		}

		for (const poller of pollers.values()) {
			yield* pollClaudeSubagentOnceEffect(deps, ctx, poller, subagentSdk, {
				allowInactive: true,
			}).pipe(
				Effect.catchAll((err) =>
					Effect.sync(() => {
						log.warn(
							`Final Claude subagent poll failed for ${ctx.sessionId}/${poller.sdkSubagentId}: ${err instanceof Error ? err.message : err}`,
						);
					}),
				),
			);
		}
		stopSubagentPollers(ctx);
	});
}

export function stopSubagentPollers(ctx: ClaudeSessionContext): void {
	const pollers = ctx.subagentPollers;
	if (!pollers) return;
	for (const poller of pollers.values()) {
		poller.active = false;
	}
	pollers.clear();
}
