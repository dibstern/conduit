// ─── WebSocket Message Dispatch ──────────────────────────────────────────────
// Extracted from ws.svelte.ts — centralized message routing and event replay.
// Pure dispatch table: routes incoming RelayMessage to the appropriate store.
//
// Task 4: Two-tier dispatcher routes per-session events by event.sessionId
// via routePerSession. Global events handled by handleMessage directly.
// dispatchToCurrent adapter removed.

import { notificationContent } from "../../notification-content.js";
import type {
	PerSessionEvent,
	PerSessionEventType,
} from "../../shared-types.js";
import type {
	ChatMessage,
	HistoryMessage,
	RelayMessage,
	ToolMessage,
} from "../types.js";
import { historyToChatMessages } from "../utils/history-logic.js";
import { createFrontendLogger } from "../utils/logger.js";
import { renderMarkdown } from "../utils/markdown.js";
import {
	addUserMessage,
	advanceTurnIfNewMessage,
	beginReplayBatch,
	chatState,
	clearMessages,
	commitReplayFinal,
	discardReplayBatch,
	findMessage,
	flushPendingRender,
	getMessages,
	getOrCreateSessionSlot,
	handleDelta,
	handleDone,
	handleError,
	handleInputSyncReceived,
	handleMessageRemoved,
	handlePartRemoved,
	handleResult,
	handleStatus,
	handleThinkingDelta,
	handleThinkingStart,
	handleThinkingStop,
	handleToolExecuting,
	handleToolResult,
	handleToolStart,
	historyState,
	isProcessing,
	markPendingHistoryQueuedFallback,
	phaseEndReplay,
	phaseStartReplay,
	prependMessages,
	registerClearMessagesHook,
	renderDeferredMarkdown,
	type SessionActivity,
	type SessionMessages,
	seedRegistryFromMessages,
	sessionActivity,
} from "./chat.svelte.js";
import {
	handleAgentList,
	handleCommandList,
	handleDefaultModelInfo,
	handleModelInfo,
	handleModelList,
	handleVariantInfo,
} from "./discovery.svelte.js";
import { handleFileTree } from "./file-tree.svelte.js";
import {
	clearScanInFlight,
	handleInstanceList,
	handleInstanceStatus,
	handleProxyDetected,
	handleScanResult,
} from "./instance.svelte.js";
import { dispatch } from "./notification-reducer.svelte.js";
import {
	clearSessionLocal,
	handleAskUser,
	handleAskUserError,
	handleAskUserResolved,
	handlePermissionRequest,
	handlePermissionResolved,
} from "./permissions.svelte.js";
import { handleProjectList } from "./project.svelte.js";
import { getCurrentSlug, replaceRoute } from "./router.svelte.js";
import {
	consumeSwitchingFromId,
	findSession,
	handleSessionForked,
	handleSessionList,
	handleSessionSwitched,
	sessionState,
} from "./session.svelte.js";
import {
	handlePtyCreated,
	handlePtyDeleted,
	handlePtyError,
	handlePtyExited,
	handlePtyList,
	handlePtyOutput,
} from "./terminal.svelte.js";
import {
	clearTodoState,
	handleTodoState,
	updateTodosFromToolResult,
} from "./todo.svelte.js";
import {
	removeBanner,
	setClientCount,
	showBanner,
	showToast,
	updateContextPercent,
} from "./ui.svelte.js";

import {
	directoryListeners,
	fileBrowserListeners,
	fileHistoryListeners,
	planModeListeners,
	projectListeners,
	rewindListeners,
} from "./ws-listeners.js";
import { triggerNotifications } from "./ws-notifications.js";
import { wsSend } from "./ws-send.svelte.js";

const log = createFrontendLogger("ws");

// ─── Per-session event routing ─────────────────────────────────────────────
// Runtime Set of per-session event types for the isPerSessionEvent guard.
// Mirrors the PerSessionEventType TS union in shared-types.ts.

const PER_SESSION_EVENT_TYPES: ReadonlySet<string> =
	new Set<PerSessionEventType>([
		"delta",
		"thinking_start",
		"thinking_delta",
		"thinking_stop",
		"tool_start",
		"tool_executing",
		"tool_result",
		"tool_content",
		"result",
		"done",
		"error",
		"status",
		"user_message",
		"part_removed",
		"message_removed",
		"ask_user",
		"ask_user_resolved",
		"ask_user_error",
		"permission_request",
		"permission_resolved",
		"session_switched",
		"session_forked",
		"history_page",
		"provider_session_reloaded",
		"session_deleted",
	]);

/** Runtime guard: does this message carry a per-session event type? */
export function isPerSessionEvent(msg: RelayMessage): msg is PerSessionEvent {
	return PER_SESSION_EVENT_TYPES.has(msg.type);
}

/** Per-session event types that still require global coordination in handleMessage.
 *  These are NOT routed through routePerSession. */
const GLOBALLY_COORDINATED_TYPES: ReadonlySet<string> = new Set([
	"session_switched",
	"session_forked",
	"history_page",
	"session_deleted",
]);

function isDev(): boolean {
	return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/**
 * Route a per-session event to the correct session slot by event.sessionId.
 * Validates sessionId presence and membership in sessionState.sessions.
 *
 * NOTE: notification_event is excluded from PerSessionEventType by
 * construction — it routes through handleMessage's global dispatch instead.
 */
function routePerSession(event: PerSessionEvent): void {
	// ── Dev-mode assertion on missing/empty sessionId ───────────────────
	if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
		if (isDev())
			throw new Error(`routePerSession: missing sessionId on ${event.type}`);
		// prod: silently drop — telemetry counter would go here
		return;
	}

	// ── Unknown-session guard ──────────────────────────────────────────
	if (!sessionState.sessions.has(event.sessionId)) {
		log.debug(
			"routePerSession: unknown sessionId %s for event %s",
			event.sessionId,
			event.type,
		);
		// prod: silently drop — telemetry counter would go here
		return;
	}

	const { activity, messages } = getOrCreateSessionSlot(event.sessionId);

	// ── Turn boundary detection ─────────────────────────────────────────
	if ("messageId" in event && event.messageId != null) {
		advanceTurnIfNewMessage(activity, messages, event.messageId as string);
	}

	switch (event.type) {
		case "delta":
			handleDelta(activity, messages, event);
			break;
		case "thinking_start":
			handleThinkingStart(activity, messages, event);
			break;
		case "thinking_delta":
			handleThinkingDelta(activity, messages, event);
			break;
		case "thinking_stop":
			handleThinkingStop(activity, messages, event);
			break;
		case "tool_start":
			handleToolStart(activity, messages, event);
			break;
		case "tool_executing":
			handleToolExecuting(activity, messages, event);
			break;
		case "tool_result": {
			handleToolResult(activity, messages, event);
			// If this was a TodoWrite result, also update the todo store.
			const msgs = getMessages(messages);
			const toolMsg = msgs.find(
				(m): m is ToolMessage => m.type === "tool" && m.id === event.id,
			);
			if (toolMsg?.name === "TodoWrite" && !event.is_error && event.content) {
				updateTodosFromToolResult(event.content);
			}
			break;
		}
		case "result":
			handleResult(activity, messages, event);
			break;
		case "done": {
			handleDone(activity, messages, event);
			// Only notify for root agent sessions — subagent completions are
			// intermediate steps; the parent emits its own done when finished.
			const doneSession = findSession(event.sessionId);
			if (!doneSession?.parentID) {
				triggerNotifications(event);
			}
			break;
		}
		case "status":
			handleStatus(activity, messages, event);
			break;
		case "error":
			handleChatError(activity, messages, event);
			triggerNotifications(event);
			break;
		case "user_message":
			addUserMessage(activity, messages, event.text, undefined, isProcessing());
			break;
		case "tool_content":
			handleToolContentResponse(event);
			break;
		case "part_removed":
			handlePartRemoved(activity, messages, event);
			break;
		case "message_removed":
			handleMessageRemoved(activity, messages, event);
			break;
		case "permission_request":
			handlePermissionRequest(event, wsSend);
			triggerNotifications(event);
			break;
		case "permission_resolved":
			handlePermissionResolved(event);
			break;
		case "ask_user":
			handleAskUser(event, event.sessionId);
			triggerNotifications(event);
			break;
		case "ask_user_resolved":
			handleAskUserResolved(event);
			break;
		case "ask_user_error":
			handleAskUserError(event);
			break;
		case "session_switched":
			// Handled in handleMessage — session_switched requires global
			// coordination (URL updates, message clearing, replay).
			// This should not be reached via routePerSession.
			break;
		case "session_forked":
			// Handled in handleMessage — requires global toast.
			break;
		case "history_page":
			// Handled in handleMessage — requires async history conversion.
			break;
		case "provider_session_reloaded":
			log.debug("Provider session reloaded:", event.sessionId);
			break;
		case "session_deleted":
			// Handled in handleMessage — requires global session state update.
			break;
	}
}

/** Get the current session slot for non-handler functions that need
 *  activity/messages but don't take an event parameter. */
function getCurrentSlot(): {
	activity: SessionActivity;
	messages: SessionMessages;
} | null {
	const id = sessionState.currentId;
	if (!id) return null;
	return getOrCreateSessionSlot(id);
}

// ─── LLM Content Start ──────────────────────────────────────────────────────
// Single source of truth for event types that indicate the LLM started
// producing content for a turn. Used by replayEvents() to track `llmActive`
// and infer whether a user_message was sent while the LLM was busy (queued).
// A user_message that appears while llmActive is true gets `sentDuringEpoch`
// set, so the UI can derive the "Queued" shimmer reactively.

// LLM content start types — canonical source is event-classify.ts (shared
// between server and frontend). Import from there so the turn-boundary
// definition stays in sync with patchMissingDone and isLastTurnActive.
import { LLM_CONTENT_START_TYPES } from "../../event-classify.js";

function isLlmContentStart(type: string): boolean {
	return LLM_CONTENT_START_TYPES.has(type as RelayMessage["type"]);
}

// ─── Async replay infrastructure ────────────────────────────────────────────

// LEGACY module-level replayGeneration — kept for backward compat.
// Per-session generation lives on activity.replayGeneration (Task 3).
let replayGeneration = 0;
const REPLAY_CHUNK_SIZE = 80; // ~16ms per chunk with batched mutations

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Live event buffer during replay ────────────────────────────────────────
// When an async replay is in progress, live WebSocket chat events are buffered
// instead of being dispatched immediately. This prevents interleaving of live
// events (e.g. thinking_stop) with cached events being replayed, which would
// cause data loss (e.g. cached thinking_deltas silently dropped after a live
// thinking_stop prematurely marks the thinking message as done).
// LEGACY module-level buffer — kept for backward compat.
// Per-session buffer lives on activity.liveEventBuffer (Task 3).
let liveEventBuffer: RelayMessage[] | null = null;

/** Event types handled by dispatchChatEvent — used to decide what to buffer. */
const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set([
	"user_message",
	"delta",
	"thinking_start",
	"thinking_delta",
	"thinking_stop",
	"tool_start",
	"tool_executing",
	"tool_result",
	"result",
	"done",
	"status",
	"error",
]);

/** Start buffering live chat events for a specific session slot. */
function startBufferingLiveEvents(activity?: SessionActivity): void {
	if (activity) activity.liveEventBuffer = [];
	liveEventBuffer = [];
}

/** Drain buffered live events through normal dispatch (called after replay commits). */
function drainLiveEventBuffer(activity?: SessionActivity): void {
	// Prefer per-session buffer, fall back to legacy
	const buffer = activity?.liveEventBuffer ?? liveEventBuffer;
	if (activity) activity.liveEventBuffer = null;
	liveEventBuffer = null;
	if (!buffer || buffer.length === 0) return;
	for (const event of buffer) {
		const ctx: DispatchContext = { isReplay: false, isQueued: isProcessing() };
		dispatchChatEvent(event, ctx);
	}
}

// Register abort hook: clearMessages bumps generation to cancel in-flight replays
// and discards the live event buffer (session is changing, buffered events are stale).
registerClearMessagesHook((sessionId: string | null) => {
	replayGeneration++;
	liveEventBuffer = null;
	// Per-session cleanup
	if (sessionId) {
		const activity = sessionActivity.get(sessionId);
		if (activity) {
			activity.liveEventBuffer = null;
			activity.replayGeneration++;
		}
	}
});

// ─── Async history conversion ───────────────────────────────────────────────

/**
 * Convert history messages in yielding chunks.
 * historyToChatMessages stays synchronous (pure, well-tested).
 * This wrapper yields between chunks to avoid blocking the main thread.
 *
 * Captures the target slot at start and uses its replayGeneration for
 * ghost-write guard. Session switches bump generation via clearMessages.
 */
async function convertHistoryAsync(
	messages: HistoryMessage[],
	render: (text: string) => string,
	capturedActivity?: SessionActivity,
): Promise<ChatMessage[] | null> {
	const CHUNK = 50;
	const gen = replayGeneration; // legacy snapshot
	const activityGen = capturedActivity?.replayGeneration; // per-session snapshot
	const result: ChatMessage[] = [];

	for (let i = 0; i < messages.length; i += CHUNK) {
		const slice = messages.slice(i, i + CHUNK);
		const converted = historyToChatMessages(slice, render);
		result.push(...converted);

		if (i + CHUNK < messages.length) {
			await yieldToEventLoop();
			// Ghost-write guard: abort if generation changed
			if (gen !== replayGeneration) return null;
			if (
				capturedActivity &&
				activityGen !== undefined &&
				capturedActivity.replayGeneration !== activityGen
			)
				return null;
		}
	}

	return result;
}

// ─── Shared chat-event dispatch ─────────────────────────────────────────────
// Single dispatch function for ALL chat event types (PERSISTED_EVENT_TYPES
// plus `status`). Used by both handleMessage (live) and replayEvents (replay)
// to eliminate the parallel switch statements that previously diverged subtly.

/** Context passed to dispatchChatEvent to abstract live/replay differences. */
export interface DispatchContext {
	/** True when replaying cached events (suppresses notifications). */
	isReplay: boolean;
	/** Whether the LLM is currently active (sentDuringEpoch source).
	 *  Live: `isProcessing()`. Replay: local `llmActive` tracker. */
	isQueued: boolean;
}

/**
 * Dispatch a single chat event to the appropriate store handler.
 * Returns `true` if the event was a chat event (handled), `false` otherwise.
 *
 * Live vs replay divergences:
 * - `user_message`: 3rd arg uses `ctx.isQueued` (live: processing, replay: llmActive)
 * - `tool_result`: TodoWrite side-effect uses `getMessages()` (works for both)
 * - `done`: notifications fire only when `!ctx.isReplay` and not a subagent
 * - `error`: live routes through `handleChatError` (PTY/HANDLER/INSTANCE) +
 *   notifications; replay uses `handleError` directly (those error codes
 *   never appear in the cache — they're sent via sendToSession, not recordEvent)
 */
function dispatchChatEvent(event: RelayMessage, ctx: DispatchContext): boolean {
	// ── Resolve per-session slot ────────────────────────────────────────
	const slot = getCurrentSlot();
	// During startup or when no session is active, we still need to handle
	// events (e.g. during session_switched replay). Use a lazy fallback.
	const activity = slot?.activity;
	const messages = slot?.messages;

	// ── Turn boundary detection ─────────────────────────────────────────
	// When an event carries a messageId that differs from the current one,
	// a new turn has started.  This single check replaces per-handler
	// new-turn detection and handles all response shapes (text-first,
	// tool-first, thinking-first).
	const hasMessageId = "messageId" in event;
	const msgId = hasMessageId
		? (event as Record<string, unknown>)["messageId"]
		: undefined;
	if (hasMessageId && msgId != null && activity && messages) {
		advanceTurnIfNewMessage(activity, messages, msgId as string);
	} else if (hasMessageId && msgId != null) {
		// Fallback: no slot yet — just log
		log.debug(
			"advanceTurn skipped — no slot for event %s messageId=%s",
			event.type,
			msgId,
		);
	} else {
		const LLM_TYPES = new Set([
			"delta",
			"thinking_start",
			"thinking_delta",
			"thinking_stop",
			"tool_start",
			"tool_executing",
			"tool_result",
			"result",
		]);
		if (LLM_TYPES.has(event.type)) {
			log.debug(
				"LLM event %s has NO messageId (hasKey=%s val=%s) replay=%s",
				event.type,
				hasMessageId,
				msgId,
				ctx.isReplay,
			);
		}
	}

	// Guard: if we have no slot, we can't dispatch. This should only
	// happen if currentId is null (extremely early in startup).
	if (!activity || !messages) {
		if (CHAT_EVENT_TYPES.has(event.type)) {
			log.debug("dispatchChatEvent: no slot for event %s", event.type);
		}
		return false;
	}

	switch (event.type) {
		case "user_message":
			addUserMessage(activity, messages, event.text, undefined, ctx.isQueued);
			return true;
		case "delta":
			handleDelta(activity, messages, event);
			return true;
		case "thinking_start":
			handleThinkingStart(activity, messages, event);
			return true;
		case "thinking_delta":
			handleThinkingDelta(activity, messages, event);
			return true;
		case "thinking_stop":
			handleThinkingStop(activity, messages, event);
			return true;
		case "tool_start":
			handleToolStart(activity, messages, event);
			return true;
		case "tool_executing":
			handleToolExecuting(activity, messages, event);
			return true;
		case "tool_result":
			handleToolResult(activity, messages, event);
			// If this was a TodoWrite result, also update the todo store.
			// The tool_result has no `name`, so look up the message in chat state.
			// getMessages() returns the replay batch during replay, chatState.messages live.
			{
				const msgs = getMessages(messages);
				const toolMsg = msgs.find(
					(m): m is ToolMessage => m.type === "tool" && m.id === event.id,
				);
				if (toolMsg?.name === "TodoWrite" && !event.is_error && event.content) {
					updateTodosFromToolResult(event.content);
				}
			}
			return true;
		case "result":
			handleResult(activity, messages, event);
			return true;
		case "done": {
			handleDone(activity, messages, event);
			if (!ctx.isReplay) {
				// Only notify for root agent sessions — subagent completions are
				// intermediate steps; the parent emits its own done when finished.
				const doneSession = findSession(sessionState.currentId ?? "");
				if (!doneSession?.parentID) {
					triggerNotifications(event);
				}
			}
			return true;
		}
		case "status":
			handleStatus(activity, messages, event);
			return true;
		case "error":
			if (ctx.isReplay) {
				// Replay: route directly to handleError. PTY/HANDLER/INSTANCE
				// error codes never appear in the cache (they're sent via
				// sendToSession, not recordEvent), so no routing is needed.
				handleError(activity, messages, event);
			} else {
				// Live: full error routing (PTY, HANDLER, INSTANCE) + notifications.
				handleChatError(activity, messages, event);
				triggerNotifications(event);
			}
			return true;
		default:
			return false;
	}
}

// ─── Centralized message dispatch ───────────────────────────────────────────

/**
 * Route an incoming WebSocket message to the appropriate store handler.
 * Replaces the vanilla handler registry pattern.
 */
export function handleMessage(msg: RelayMessage): void {
	// ── Two-tier routing: per-session events vs global events ────────────
	// Per-session events are routed by event.sessionId to the correct
	// session slot. notification_event is excluded by construction
	// (PerSessionEventType union does not include it).
	if (isPerSessionEvent(msg)) {
		// Buffer live chat events during replay to prevent interleaving
		if (liveEventBuffer !== null && CHAT_EVENT_TYPES.has(msg.type)) {
			const currentActivity = sessionState.currentId
				? sessionActivity.get(sessionState.currentId)
				: undefined;
			if (currentActivity?.liveEventBuffer) {
				currentActivity.liveEventBuffer.push(msg);
			}
			liveEventBuffer.push(msg);
			return;
		}

		// Events requiring global coordination are handled in the switch
		// below rather than routePerSession. All other per-session events
		// route through routePerSession.
		if (!GLOBALLY_COORDINATED_TYPES.has(msg.type)) {
			routePerSession(msg);
			return;
		}
	}

	// ── Global events + globally-coordinated per-session events ──────────
	switch (msg.type) {
		// ─── Sessions ────────────────────────────────────────────────────
		case "session_list": {
			handleSessionList(msg);
			// Reconcile notification reducer with server-side question counts.
			// session_list messages include pendingQuestionCount per session.
			const sessions = msg.sessions;
			if (Array.isArray(sessions)) {
				const counts = new Map<
					string,
					{ questions: number; permissions: number }
				>();
				for (const s of sessions) {
					if (s.pendingQuestionCount && s.pendingQuestionCount > 0) {
						counts.set(s.id, {
							questions: s.pendingQuestionCount,
							permissions: 0,
						});
					}
				}
				dispatch({ type: "reconcile", counts });
			}
			break;
		}
		case "session_forked": {
			handleSessionForked(msg);
			const parentTitle = msg.parentTitle ?? "session";
			showToast(`Forked from "${parentTitle}"`);
			break;
		}
		case "session_switched": {
			// Use the ID captured by switchToSession() before it changed currentId.
			// Falls back to sessionState.currentId for server-initiated switches
			// (e.g. new_session flow) where switchToSession() wasn't called.
			// consumeSwitchingFromId() reads and clears the value in one call to
			// prevent stale IDs from leaking into future server-initiated switches.
			const previousSessionId =
				consumeSwitchingFromId() ?? sessionState.currentId;
			handleSessionSwitched(msg);

			// Update URL to reflect the new session
			const slug = getCurrentSlug();
			if (slug && msg.id) replaceRoute(`/p/${slug}/s/${msg.id}`);

			// Idempotent — switchToSession() already cleared optimistically,
			// but this covers server-initiated switches (new session, fork).
			clearMessages();
			updateContextPercent(0);
			clearTodoState();
			clearSessionLocal(previousSessionId);
			dispatch({ type: "session_viewed", sessionId: msg.id });

			if (msg.events) {
				// Cache hit: replay raw events through existing chat handlers
				// (full fidelity — same code paths as live streaming).
				// Fire-and-forget — handleMessage stays synchronous.
				const eventsHasMore = msg.eventsHasMore ?? false;
				replayEvents(msg.events, msg.id, eventsHasMore).catch((err) => {
					log.warn("Replay error:", err);
				});
			} else if (msg.history) {
				// REST API fallback: convert to ChatMessages and prepend.
				// REST history has no event-level data, so sentDuringEpoch
				// can't be set during conversion.  Signal that the next
				// status:processing should apply the queued-state fallback.
				markPendingHistoryQueuedFallback();
				// Fire-and-forget — handleMessage stays synchronous.
				// Capture slot at start so commits go to the correct session.
				const historyMsgs = msg.history.messages;
				const hasMore = msg.history.hasMore;
				const msgCount = historyMsgs.length;
				const capturedSlot = getOrCreateSessionSlot(msg.id);
				const gen = replayGeneration; // snapshot before async
				convertHistoryAsync(historyMsgs, renderMarkdown, capturedSlot.activity)
					.then((chatMsgs) => {
						if (chatMsgs && gen === replayGeneration) {
							// Commit to captured slot, not getCurrentSlot()
							prependMessages(
								capturedSlot.activity,
								capturedSlot.messages,
								chatMsgs,
							);
							seedRegistryFromMessages(
								capturedSlot.activity,
								capturedSlot.messages,
								chatMsgs,
							);
							historyState.hasMore = hasMore;
							historyState.messageCount = msgCount;
							// Transition loadLifecycle so the scroll controller
							// exits "loading" state and scrolls to bottom.
							chatState.loadLifecycle = "ready";
						}
					})
					.catch((err) => {
						log.warn("History conversion error:", err);
					});
			} else {
				// Empty session (neither events nor history) — hasMore stays false
				// so "Beginning of session" marker shows immediately.
				// Transition loadLifecycle to "ready" so the scroll controller
				// exits "loading" state and can handle live events normally.
				chatState.loadLifecycle = "ready";
			}

			// Apply server-provided input draft for this session.
			// This uses the input_sync mechanism so InputArea picks it up
			// via the existing $effect (server value overrides local draft).
			if (msg.inputText != null) {
				handleInputSyncReceived({ text: msg.inputText });
			}

			break;
		}

		// ─── Terminal / PTY ──────────────────────────────────────────────
		case "pty_list":
			handlePtyList(msg);
			break;
		case "pty_created":
			handlePtyCreated(msg);
			break;
		case "pty_output":
			handlePtyOutput(msg);
			break;
		case "pty_exited":
			handlePtyExited(msg);
			break;
		case "pty_deleted":
			handlePtyDeleted(msg);
			break;

		// ─── Discovery ───────────────────────────────────────────────────
		case "agent_list":
			handleAgentList(msg);
			break;
		case "model_list":
			handleModelList(msg);
			break;
		case "model_info":
			handleModelInfo(msg);
			break;
		case "default_model_info":
			handleDefaultModelInfo(msg);
			break;
		case "variant_info":
			handleVariantInfo(msg);
			break;
		case "command_list":
			handleCommandList(msg);
			break;

		// ─── Permissions & Questions ─────────────────────────────────────
		// Now routed through routePerSession (per-session events).

		// ─── UI ──────────────────────────────────────────────────────────
		case "client_count":
			setClientCount(msg.count ?? 0);
			break;
		case "connection_status":
			handleConnectionStatus(msg);
			break;
		case "banner":
		case "skip_permissions":
		case "update_available":
			handleBannerMessage(msg);
			break;
		case "input_sync":
			handleInputSyncReceived(msg);
			break;

		// ─── History ─────────────────────────────────────────────────────
		case "history_page": {
			// Convert and prepend older messages into chatState.messages.
			// Fire-and-forget — handleMessage stays synchronous.
			// Capture slot at start so commits go to the correct session.
			const historyMsg = msg as Extract<RelayMessage, { type: "history_page" }>;
			const rawMessages = historyMsg.messages ?? [];
			const hasMore = historyMsg.hasMore ?? false;
			const hpCapturedSlot = sessionState.currentId
				? getOrCreateSessionSlot(sessionState.currentId)
				: null;
			const gen = replayGeneration; // snapshot before async
			convertHistoryAsync(rawMessages, renderMarkdown, hpCapturedSlot?.activity)
				.then((chatMsgs) => {
					if (chatMsgs && gen === replayGeneration) {
						// Commit to captured slot, not getCurrentSlot()
						if (hpCapturedSlot) {
							prependMessages(
								hpCapturedSlot.activity,
								hpCapturedSlot.messages,
								chatMsgs,
							);
							seedRegistryFromMessages(
								hpCapturedSlot.activity,
								hpCapturedSlot.messages,
								chatMsgs,
							);
						}
						historyState.hasMore = hasMore;
						historyState.messageCount += rawMessages.length;
					}
					historyState.loading = false; // ALWAYS reset, even on abort
				})
				.catch((err) => {
					log.warn("History page conversion error:", err);
					historyState.loading = false;
				});
			break;
		}

		// ─── Plan Mode ───────────────────────────────────────────────────
		case "plan_enter":
		case "plan_exit":
		case "plan_content":
		case "plan_approval":
			for (const fn of planModeListeners) fn(msg);
			break;

		// ─── File Tree (@ autocomplete) ──────────────────────────────────
		case "file_tree":
			handleFileTree(msg as { type: "file_tree"; entries: unknown });
			break;

		// ─── File Browser ────────────────────────────────────────────────
		case "file_list":
		case "file_content":
			for (const fn of fileBrowserListeners) fn(msg);
			break;

		// ─── File Changes (routed to both browser and history) ──────────
		case "file_changed":
			for (const fn of fileBrowserListeners) fn(msg);
			for (const fn of fileHistoryListeners) fn(msg);
			break;
		case "file_history_result":
			for (const fn of fileHistoryListeners) fn(msg);
			break;

		// ─── Rewind ──────────────────────────────────────────────────────
		case "rewind_result":
			for (const fn of rewindListeners) fn(msg);
			break;

		// ─── Project ─────────────────────────────────────────────────────
		case "project_list":
			handleProjectList(msg);
			for (const fn of projectListeners) fn(msg);
			break;

		// ─── Directory Listing ──────────────────────────────────────────
		case "directory_list":
			for (const fn of directoryListeners) fn(msg);
			break;

		// ─── Todo ────────────────────────────────────────────────────────
		case "todo_state":
			handleTodoState(msg);
			break;

		// ─── Provider session reload / Part / Message removal ──────────────
		// Now routed through routePerSession (per-session events).

		// ─── Instances ───────────────────────────────────────────────────
		case "instance_list":
			handleInstanceList(msg);
			break;
		case "instance_status":
			handleInstanceStatus(msg);
			break;
		case "proxy_detected":
			handleProxyDetected(msg);
			break;
		case "scan_result":
			handleScanResult(msg);
			break;

		// ─── Cross-session notifications ─────────────────────────────────
		// Broadcast by the server when a notification-worthy event (done,
		// error) is dropped because the user is viewing a different session.
		// Trigger sound/browser notifications without updating chat state.
		case "notification_event": {
			const syntheticMsg = {
				type: msg.eventType,
				...(msg.message != null ? { message: msg.message } : {}),
				...(msg.sessionId != null ? { sessionId: msg.sessionId } : {}),
			} as RelayMessage;

			// Dispatch to notification reducer based on event type
			if (msg.sessionId) {
				if (msg.eventType === "ask_user") {
					dispatch({ type: "question_appeared", sessionId: msg.sessionId });
				} else if (msg.eventType === "ask_user_resolved") {
					dispatch({ type: "question_resolved", sessionId: msg.sessionId });
				} else if (msg.eventType === "done") {
					dispatch({ type: "session_done", sessionId: msg.sessionId });
				} else if (msg.eventType === "session_viewed") {
					dispatch({ type: "session_viewed", sessionId: msg.sessionId });
				}
			}

			// session_viewed is a silent indicator update — no notifications or toasts.
			if (msg.eventType === "session_viewed") break;

			// Suppress all frontend notifications for subagent done events.
			// Server-side notification-policy.ts is the primary defense; this is belt-and-suspenders.
			const isSubagentDone =
				msg.eventType === "done" &&
				msg.sessionId &&
				findSession(msg.sessionId)?.parentID;

			if (!isSubagentDone) {
				triggerNotifications(syntheticMsg);
			}

			// In-app toast for cross-session error events only. Done events
			// are suppressed: all "done" messages are synthetic (generated by
			// conduit from session.status:idle), and OpenCode can emit idle
			// between tool rounds (e.g. after a bash call completes), causing
			// spurious "Task Complete" toasts mid-turn. Users still get sound,
			// browser/push notifications, and the sidebar green dot for
			// genuine completions. Skip ask_user and ask_user_resolved since
			// the AttentionBanner already handles those.
			if (!isSubagentDone && msg.eventType === "error") {
				const content = notificationContent(syntheticMsg);
				if (content) {
					showToast(
						content.title + (content.body ? ` — ${content.body}` : ""),
						{
							variant: "warn",
						},
					);
				}
			}
			break;
		}

		default:
			// Unknown message type — debug-only (tree-shaken in production)
			log.debug("Unhandled message type:", msg.type, msg);
			break;
	}
}

// ─── Event Replay (session switch with cached events) ────────────────────────
// Replays raw events through existing chat handlers — same code paths as live
// streaming. Zero conversion, full fidelity, handles mid-stream.
//
// Queued-flag inference: The message cache NEVER contains status:processing
// events (prompt.ts sends them via sendToSession, not recordEvent). So we
// track LLM activity locally via LLM_CONTENT_START_TYPES: content events set
// llmActive=true; done and non-retry errors set it false. A user_message
// that appears while llmActive is true was queued behind an in-progress turn.

export async function replayEvents(
	events: RelayMessage[],
	sessionId: string,
	eventsHasMore = false,
): Promise<void> {
	// ── Slot-capture: capture at start, thread through all dispatches ──
	// Do NOT use currentChat() or dispatchToCurrent — commit to captured slot.
	const slot = getOrCreateSessionSlot(sessionId);
	const gen = ++slot.activity.replayGeneration;
	const legacyGen = ++replayGeneration;

	phaseStartReplay(slot.activity);
	beginReplayBatch(slot.activity, slot.messages);
	startBufferingLiveEvents(slot.activity);

	/** Ghost-write guard: abort if the slot's generation has changed
	 *  (concurrent replay or clearMessages bumped it). */
	function isAborted(): boolean {
		return (
			slot.activity.replayGeneration !== gen || legacyGen !== replayGeneration
		);
	}

	try {
		// Local tracker: true when the LLM is producing content for the current
		// turn. Inferred from event structure, NOT from status events (which
		// aren't cached). Used to set the `queued` flag on user_message events.
		let llmActive = false;

		for (let i = 0; i < events.length; i++) {
			// Abort: a newer replay or clearMessages happened
			if (isAborted()) {
				discardReplayBatch(slot.activity, slot.messages);
				return; // don't call phaseEndReplay — clearMessages already reset loadLifecycle, or a new replay set it to loading
			}

			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const event = events[i]!;

			// ── LLM activity tracking (before handler, so user_message reads it) ──
			if (isLlmContentStart(event.type)) llmActive = true;
			else if (event.type === "done") llmActive = false;
			else if (event.type === "error" && event.code !== "RETRY")
				llmActive = false;

			const ctx: DispatchContext = { isReplay: true, isQueued: llmActive };
			dispatchChatEvent(event, ctx);

			// Yield between chunks to keep the main thread responsive.
			// NOTE: Do NOT call discardReplayBatch() on abort after yield.
			// A newer replay may have already called beginReplayBatch() and
			// started populating it — discarding here would destroy the new
			// replay's batch. clearMessages() already sets replayBatch = null.
			if ((i + 1) % REPLAY_CHUNK_SIZE === 0) {
				await yieldToEventLoop();
				if (isAborted()) return;
			}
		}

		// Flush any pending debounced render (for mid-stream sessions
		// where no "done" event has been received yet)
		flushPendingRender(slot.activity, slot.messages);

		// Single commit: page large replays so only the last 50 messages
		// render immediately, with older messages buffered for lazy loading.
		commitReplayFinal(slot.activity, slot.messages, sessionId, eventsHasMore);

		// Reconcile processing state after replay completes.
		// During replay, handler functions (handleDone, handleDelta, etc.)
		// set chatState.phase directly (no longer guarded by "replaying").
		// phaseEndReplay only needs to handle the edge case where llmActive
		// is true but phase ended at "idle" (all turns completed during
		// replay, but server says LLM is still active).
		phaseEndReplay(slot.activity, llmActive);

		// Drain live events that arrived while the replay was in progress.
		// These are post-cache events dispatched as normal live events,
		// continuing the timeline where the cache left off.
		drainLiveEventBuffer(slot.activity);

		renderDeferredMarkdown(slot.activity, slot.messages);
	} finally {
		// Safety: ensure buffer is cleared on any exit path not handled above.
		// Normal path: drainLiveEventBuffer already set buffer to null.
		// Abort path: clearMessages hook already set buffer to null.
		// Error path: discard any un-drained buffer to prevent infinite buffering.
		if (slot.activity) slot.activity.liveEventBuffer = null;
		liveEventBuffer = null;
	}
}

// ─── Auxiliary handlers (only called from handleMessage) ────────────────────

/** Tool content: replace truncated result with full content. */
function handleToolContentResponse(
	msg: Extract<RelayMessage, { type: "tool_content" }>,
): void {
	const slot = getCurrentSlot();
	const { toolId, content } = msg;
	const msgs = [...chatState.messages];
	const found = findMessage(msgs, "tool", (m) => m.id === toolId);
	if (found) {
		chatState.messages = msgs.map((m, i) => {
			if (i !== found.index) return m;
			const updated: ToolMessage = {
				...found.message,
				result: content,
				isTruncated: false,
			};
			delete updated.fullContentLength;
			return updated;
		});
	}
	// Suppress unused-variable lint — slot reserved for Task 3 migration
	void slot;
}

/** Error routing: PTY errors vs chat errors. */
function handleChatError(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "error" }>,
): void {
	const code = msg.code;

	// PTY-related errors
	if (code === "PTY_CONNECT_FAILED") {
		handlePtyError(msg);
		return;
	}

	// Handler errors (e.g., question reply failed): show toast so the user
	// knows something went wrong, rather than silently swallowing.
	if (code === "HANDLER_ERROR") {
		const text = msg.message ?? "An operation failed on the server";
		showToast(text, { variant: "warn" });
		return;
	}

	// Instance errors — show as toast and clear scan state if pending
	if (code === "INSTANCE_ERROR") {
		clearScanInFlight();
		showToast(msg.message ?? "Instance operation failed", {
			variant: "warn",
		});
		return;
	}

	// Chat errors
	handleError(activity, messages, msg);
}

/** Connection status: show/remove reconnection banner. */
const CONNECTION_BANNER_ID = "opencode-connection-status";

function handleConnectionStatus(
	msg: Extract<RelayMessage, { type: "connection_status" }>,
): void {
	if (msg.status === "connected") {
		removeBanner(CONNECTION_BANNER_ID);
	} else {
		const text =
			msg.status === "reconnecting"
				? "Reconnecting to OpenCode\u2026"
				: "OpenCode server disconnected";
		// Remove first so text updates if status changes (e.g. disconnected -> reconnecting)
		removeBanner(CONNECTION_BANNER_ID);
		showBanner({
			id: CONNECTION_BANNER_ID,
			variant: "warning",
			icon: "alert-triangle",
			text,
			dismissible: false,
		});
	}
}

/** Banner messages: update_available, skip_permissions, custom banners. */
function handleBannerMessage(msg: RelayMessage): void {
	switch (msg.type) {
		case "update_available": {
			const ver = msg.version ?? "new version";
			showBanner({
				id: "update-available",
				variant: "update",
				icon: "arrow-up-circle",
				text: `Update available: v${ver}`,
				dismissible: true,
				link: "https://www.npmjs.com/package/conduit-code",
			});
			break;
		}
		case "skip_permissions":
			showBanner({
				id: "skip-permissions",
				variant: "skip-permissions",
				icon: "shield-off",
				text: "Permissions are being skipped",
				dismissible: true,
			});
			break;
		case "banner":
			showBanner({
				id: msg.config.id ?? "custom",
				variant:
					(msg.config.variant as
						| "update"
						| "onboarding"
						| "skip-permissions"
						| "warning") ?? "onboarding",
				icon: msg.config.icon ?? "info",
				text: msg.config.text ?? "",
				dismissible: msg.config.dismissible ?? true,
			});
			break;
	}
}
