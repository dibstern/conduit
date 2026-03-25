// ─── WebSocket Message Dispatch ──────────────────────────────────────────────
// Extracted from ws.svelte.ts — centralized message routing and event replay.
// Pure dispatch table: routes incoming RelayMessage to the appropriate store.

import { notificationContent } from "../../notification-content.js";
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
	beginReplayBatch,
	chatState,
	clearMessages,
	clearQueuedFlags,
	commitReplayBatch,
	discardReplayBatch,
	findMessage,
	flushPendingRender,
	getMessages,
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
	phaseEndReplay,
	phaseStartReplay,
	prependMessages,
	registerClearMessagesHook,
	renderDeferredMarkdown,
	seedRegistryFromMessages,
	shouldClearQueuedOnContent,
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
import {
	addRemoteQuestion,
	clearSessionLocal,
	handleAskUser,
	handleAskUserError,
	handleAskUserResolved,
	handlePermissionRequest,
	handlePermissionResolved,
	removeRemoteQuestion,
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
import { setLatestVersion } from "./version.svelte.js";
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

// ─── LLM Content Start (queued-flag coordination) ───────────────────────────
// Single source of truth for event types that indicate the LLM started
// producing content for a turn. Used for two purposes:
//   1. clearQueuedFlags() — remove the "Queued" shimmer when the LLM responds
//   2. llmActive tracking in replayEvents() — infer queued state from events
//
// Both handleMessage() and replayEvents() use this constant via
// isLlmContentStart() so there is exactly one place to update.

const LLM_CONTENT_START_TYPES: ReadonlySet<RelayMessage["type"]> = new Set([
	"delta",
	"thinking_start",
	"tool_start",
] as const);

function isLlmContentStart(type: string): boolean {
	return LLM_CONTENT_START_TYPES.has(type as RelayMessage["type"]);
}

// ─── Async replay infrastructure ────────────────────────────────────────────

let replayGeneration = 0;
const REPLAY_CHUNK_SIZE = 80; // ~16ms per chunk with batched mutations

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// Register abort hook: clearMessages bumps generation to cancel in-flight replays
registerClearMessagesHook(() => {
	replayGeneration++;
});

// ─── Async history conversion ───────────────────────────────────────────────

/**
 * Convert history messages in yielding chunks.
 * historyToChatMessages stays synchronous (pure, well-tested).
 * This wrapper yields between chunks to avoid blocking the main thread.
 *
 * Uses replayGeneration for abort detection. Safe because:
 * - historyState.loading prevents concurrent history_page loads
 * - Session switches bump generation via clearMessages → abortReplay()
 */
async function convertHistoryAsync(
	messages: HistoryMessage[],
	render: (text: string) => string,
): Promise<ChatMessage[] | null> {
	const CHUNK = 50;
	const gen = replayGeneration; // snapshot
	const result: ChatMessage[] = [];

	for (let i = 0; i < messages.length; i += CHUNK) {
		const slice = messages.slice(i, i + CHUNK);
		const converted = historyToChatMessages(slice, render);
		result.push(...converted);

		if (i + CHUNK < messages.length) {
			await yieldToEventLoop();
			if (gen !== replayGeneration) return null; // aborted
		}
	}

	return result;
}

// ─── Shared chat-event dispatch ─────────────────────────────────────────────
// Single dispatch function for ALL chat event types (CACHEABLE_EVENT_TYPES
// plus `status`). Used by both handleMessage (live) and replayEvents (replay)
// to eliminate the parallel switch statements that previously diverged subtly.

/** Context passed to dispatchChatEvent to abstract live/replay differences. */
export interface DispatchContext {
	/** True when replaying cached events (suppresses notifications). */
	isReplay: boolean;
	/** Whether the session is currently processing (queued-flag source).
	 *  Live: `chatState.processing`. Replay: local `llmActive` tracker. */
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
	switch (event.type) {
		case "user_message":
			addUserMessage(event.text, undefined, ctx.isQueued);
			return true;
		case "delta":
			handleDelta(event);
			return true;
		case "thinking_start":
			handleThinkingStart(event);
			return true;
		case "thinking_delta":
			handleThinkingDelta(event);
			return true;
		case "thinking_stop":
			handleThinkingStop(event);
			return true;
		case "tool_start":
			handleToolStart(event);
			return true;
		case "tool_executing":
			handleToolExecuting(event);
			return true;
		case "tool_result":
			handleToolResult(event);
			// If this was a TodoWrite result, also update the todo store.
			// The tool_result has no `name`, so look up the message in chat state.
			// getMessages() returns the replay batch during replay, chatState.messages live.
			{
				const msgs = getMessages();
				const toolMsg = msgs.find(
					(m): m is ToolMessage => m.type === "tool" && m.id === event.id,
				);
				if (toolMsg?.name === "TodoWrite" && !event.is_error && event.content) {
					updateTodosFromToolResult(event.content);
				}
			}
			return true;
		case "result":
			handleResult(event);
			return true;
		case "done": {
			handleDone(event);
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
			handleStatus(event);
			return true;
		case "error":
			if (ctx.isReplay) {
				// Replay: route directly to handleError. PTY/HANDLER/INSTANCE
				// error codes never appear in the cache (they're sent via
				// sendToSession, not recordEvent), so no routing is needed.
				handleError(event);
			} else {
				// Live: full error routing (PTY, HANDLER, INSTANCE) + notifications.
				handleChatError(event);
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
	// ── Chat events (shared dispatch) ───────────────────────────────────
	const ctx: DispatchContext = {
		isReplay: false,
		isQueued: isProcessing(),
	};
	if (dispatchChatEvent(msg, ctx)) {
		// Queued-flag clearing: gated by shouldClearQueuedOnContent() which
		// uses turnEpoch to ensure only genuinely NEW turns clear flags.
		if (isLlmContentStart(msg.type) && shouldClearQueuedOnContent())
			clearQueuedFlags();
		return;
	}

	// ── Live-only chat events (not cacheable, not in replay) ────────────
	switch (msg.type) {
		case "tool_content":
			handleToolContentResponse(msg);
			return;
	}

	switch (msg.type) {
		// ─── Sessions ────────────────────────────────────────────────────
		case "session_list":
			handleSessionList(msg);
			break;
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
			clearSessionLocal(previousSessionId); // Keep remote permissions
			if (msg.id) removeRemoteQuestion(msg.id); // Now viewing this session — no longer remote

			if (msg.events) {
				// Cache hit: replay raw events through existing chat handlers
				// (full fidelity — same code paths as live streaming).
				// Fire-and-forget — handleMessage stays synchronous.
				replayEvents(msg.events).catch((err) => {
					log.warn("Replay error:", err);
				});
				// Events cache covers the full session — suppress history loading.
				// historyState.hasMore stays false (set by clearMessages above),
				// so the IntersectionObserver can never fire spuriously.
			} else if (msg.history) {
				// REST API fallback: convert to ChatMessages and prepend.
				// Fire-and-forget — handleMessage stays synchronous.
				const historyMsgs = msg.history.messages;
				const hasMore = msg.history.hasMore;
				const msgCount = historyMsgs.length;
				const gen = replayGeneration; // snapshot before async
				convertHistoryAsync(historyMsgs, renderMarkdown)
					.then((chatMsgs) => {
						if (chatMsgs && gen === replayGeneration) {
							prependMessages(chatMsgs);
							seedRegistryFromMessages(chatMsgs);
							historyState.hasMore = hasMore;
							historyState.messageCount = msgCount;
						}
					})
					.catch((err) => {
						log.warn("History conversion error:", err);
					});
			} else {
				// Empty session (neither events nor history) — hasMore stays false
				// so "Beginning of session" marker shows immediately.
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
		case "permission_request":
			handlePermissionRequest(msg, wsSend);
			triggerNotifications(msg);
			break;
		case "permission_resolved":
			handlePermissionResolved(msg);
			break;
		case "ask_user":
			handleAskUser(msg);
			triggerNotifications(msg);
			break;
		case "ask_user_resolved":
			handleAskUserResolved(msg);
			break;
		case "ask_user_error":
			handleAskUserError(msg);
			break;

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
			const historyMsg = msg as Extract<RelayMessage, { type: "history_page" }>;
			const rawMessages = historyMsg.messages ?? [];
			const hasMore = historyMsg.hasMore ?? false;
			const gen = replayGeneration; // snapshot before async
			convertHistoryAsync(rawMessages, renderMarkdown)
				.then((chatMsgs) => {
					if (chatMsgs && gen === replayGeneration) {
						prependMessages(chatMsgs);
						seedRegistryFromMessages(chatMsgs);
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

		// ─── Part / Message removal ──────────────────────────────────────
		case "part_removed":
			handlePartRemoved(msg);
			break;
		case "message_removed":
			handleMessageRemoved(msg);
			break;

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

			// Track cross-session question notifications so the
			// AttentionBanner component can show them.
			if (msg.eventType === "ask_user" && msg.sessionId) {
				addRemoteQuestion(msg.sessionId);
			} else if (msg.eventType === "ask_user_resolved" && msg.sessionId) {
				removeRemoteQuestion(msg.sessionId);
			}

			triggerNotifications(syntheticMsg);

			// In-app toast for cross-session events — skip for ask_user and
			// ask_user_resolved since the AttentionBanner already handles those.
			if (
				msg.eventType !== "ask_user" &&
				msg.eventType !== "ask_user_resolved"
			) {
				const content = notificationContent(syntheticMsg);
				if (content) {
					showToast(
						content.title + (content.body ? ` — ${content.body}` : ""),
						{
							variant: msg.eventType === "error" ? "warn" : "default",
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

export async function replayEvents(events: RelayMessage[]): Promise<void> {
	phaseStartReplay();
	const generation = ++replayGeneration;

	beginReplayBatch();

	// Local tracker: true when the LLM is producing content for the current
	// turn. Inferred from event structure, NOT from status events (which
	// aren't cached). Used to set the `queued` flag on user_message events.
	let llmActive = false;

	for (let i = 0; i < events.length; i++) {
		// Abort: a newer replay or clearMessages happened
		if (generation !== replayGeneration) {
			discardReplayBatch();
			return; // don't set replaying=false — clearMessages already did, or new replay set it true
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

		// ── Queued-flag clearing ─────────────────────────────────────────
		// Same turnEpoch gate as handleMessage().
		if (isLlmContentStart(event.type) && shouldClearQueuedOnContent())
			clearQueuedFlags();

		// Yield between chunks to keep the main thread responsive
		if ((i + 1) % REPLAY_CHUNK_SIZE === 0) {
			commitReplayBatch();
			await yieldToEventLoop();
			if (generation !== replayGeneration) return; // aborted during yield
			beginReplayBatch();
		}
	}

	// Flush any pending debounced render (for mid-stream sessions
	// where no "done" event has been received yet)
	flushPendingRender();
	commitReplayBatch();

	// Reconcile processing state: during replay, handleDone is guarded
	// from clearing isProcessing (to avoid overwriting a live
	// status:processing message from the server that arrived during a
	// yield). Now that replay is complete, reconcile the processing state.
	// phaseEndReplay merges two signals: llmActive (last replayed turn
	// still in-flight) and isProcessing (live status:processing
	// arrived during a yield — status events are NOT cacheable).
	phaseEndReplay(llmActive);
	renderDeferredMarkdown();
}

// ─── Auxiliary handlers (only called from handleMessage) ────────────────────

/** Tool content: replace truncated result with full content. */
function handleToolContentResponse(
	msg: Extract<RelayMessage, { type: "tool_content" }>,
): void {
	const { toolId, content } = msg;
	const messages = [...chatState.messages];
	const found = findMessage(messages, "tool", (m) => m.id === toolId);
	if (found) {
		chatState.messages = messages.map((m, i) => {
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
}

/** Error routing: PTY errors vs chat errors. */
function handleChatError(msg: Extract<RelayMessage, { type: "error" }>): void {
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
	handleError(msg);
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
				text: `Update available: ${ver}`,
				dismissible: true,
				...(msg.version != null && { version: msg.version }),
			});
			// Also track in version store for sidebar footer
			if (msg.version) {
				setLatestVersion(msg.version);
			}
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
