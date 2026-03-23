// ─── WebSocket Message Dispatch ──────────────────────────────────────────────
// Extracted from ws.svelte.ts — centralized message routing and event replay.
// Pure dispatch table: routes incoming RelayMessage to the appropriate store.

import type { RelayMessage, ToolMessage } from "../types.js";
import { historyToChatMessages } from "../utils/history-logic.js";
import { renderMarkdown } from "../utils/markdown.js";
import {
	addUserMessage,
	chatState,
	clearMessages,
	clearQueuedFlags,
	findMessage,
	flushPendingRender,
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
	prependMessages,
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
	findSession,
	getSwitchingFromId,
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

// ─── Centralized message dispatch ───────────────────────────────────────────

/**
 * Route an incoming WebSocket message to the appropriate store handler.
 * Replaces the vanilla handler registry pattern.
 */
export function handleMessage(msg: RelayMessage): void {
	switch (msg.type) {
		// ─── Chat / Streaming ────────────────────────────────────────────
		case "delta":
			handleDelta(msg);
			break;
		case "thinking_start":
			handleThinkingStart(msg);
			break;
		case "thinking_delta":
			handleThinkingDelta(msg);
			break;
		case "thinking_stop":
			handleThinkingStop(msg);
			break;
		case "tool_start":
			handleToolStart(msg);
			break;
		case "tool_executing":
			handleToolExecuting(msg);
			break;
		case "tool_result":
			handleToolResult(msg);
			// If this was a TodoWrite result, also update the todo store.
			// The tool_result has no `name`, so look up the message in chat state.
			{
				const toolMsg = chatState.messages.find(
					(m): m is ToolMessage => m.type === "tool" && m.id === msg.id,
				);
				if (toolMsg?.name === "TodoWrite" && !msg.is_error && msg.content) {
					updateTodosFromToolResult(msg.content);
				}
			}
			break;
		case "tool_content":
			handleToolContentResponse(msg);
			break;
		case "result":
			handleResult(msg);
			break;
		case "done": {
			handleDone(msg);
			// Only notify for root agent sessions — subagent completions are
			// intermediate steps; the parent emits its own done when finished.
			const doneSession = findSession(sessionState.currentId ?? "");
			if (!doneSession?.parentID) {
				triggerNotifications(msg);
			}
			break;
		}
		case "status":
			handleStatus(msg);
			break;
		case "error":
			handleChatError(msg);
			triggerNotifications(msg);
			break;
		case "user_message":
			// From another tab/client — mark as queued if the session is processing
			addUserMessage(msg.text, undefined, chatState.processing);
			break;

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
			const previousSessionId = getSwitchingFromId() ?? sessionState.currentId;
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

			if (msg.events) {
				// Cache hit: replay raw events through existing chat handlers
				// (full fidelity — same code paths as live streaming).
				replayEvents(msg.events);
				// Events cache covers the full session — suppress history loading.
				// historyState.hasMore stays false (set by clearMessages above),
				// so the IntersectionObserver can never fire spuriously.
			} else if (msg.history) {
				// REST API fallback: convert to ChatMessages and prepend
				const chatMsgs = historyToChatMessages(
					msg.history.messages,
					renderMarkdown,
				);
				prependMessages(chatMsgs);
				historyState.hasMore = msg.history.hasMore;
				historyState.messageCount = msg.history.messages.length;
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
			// Convert and prepend older messages into chatState.messages
			const historyMsg = msg as Extract<RelayMessage, { type: "history_page" }>;
			const rawMessages = historyMsg.messages ?? [];
			const chatMsgs = historyToChatMessages(rawMessages, renderMarkdown);
			prependMessages(chatMsgs);
			historyState.hasMore = historyMsg.hasMore ?? false;
			historyState.loading = false;
			historyState.messageCount += rawMessages.length;
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
		case "notification_event":
			triggerNotifications({
				type: msg.eventType,
				...(msg.message != null ? { message: msg.message } : {}),
			} as RelayMessage);
			break;

		default:
			// Unknown message type — log in dev mode only
			if (import.meta.env.DEV) {
				console.debug("[ws] Unhandled message type:", msg.type, msg);
			}
			break;
	}

	// ── Queued-flag clearing (single source of truth) ────────────────
	// Driven by LLM_CONTENT_START_TYPES — no manual clearQueuedFlags()
	// calls in individual switch branches. See replayEvents() for the
	// same pattern.
	if (isLlmContentStart(msg.type)) clearQueuedFlags();
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

export function replayEvents(events: RelayMessage[]): void {
	chatState.replaying = true;

	// Local tracker: true when the LLM is producing content for the current
	// turn. Inferred from event structure, NOT from status events (which
	// aren't cached). Used to set the `queued` flag on user_message events.
	let llmActive = false;

	for (const event of events) {
		// ── LLM activity tracking (before handler, so user_message reads it) ──
		if (isLlmContentStart(event.type)) llmActive = true;
		else if (event.type === "done") llmActive = false;
		else if (event.type === "error" && event.code !== "RETRY")
			llmActive = false;

		switch (event.type) {
			case "user_message":
				addUserMessage(event.text, undefined, llmActive);
				break;
			case "delta":
				handleDelta(event);
				break;
			case "done":
				handleDone(event);
				break;
			case "tool_start":
				handleToolStart(event);
				break;
			case "tool_executing":
				handleToolExecuting(event);
				break;
			case "tool_result":
				handleToolResult(event);
				// Also update todo store if this was a TodoWrite result
				{
					const toolMsg = chatState.messages.find(
						(m): m is ToolMessage => m.type === "tool" && m.id === event.id,
					);
					if (
						toolMsg?.name === "TodoWrite" &&
						!event.is_error &&
						event.content
					) {
						updateTodosFromToolResult(event.content);
					}
				}
				break;
			case "result":
				handleResult(event);
				break;
			case "thinking_start":
				handleThinkingStart(event);
				break;
			case "thinking_delta":
				handleThinkingDelta(event);
				break;
			case "thinking_stop":
				handleThinkingStop(event);
				break;
			case "status":
				handleStatus(event);
				break;
			case "error":
				handleError(event);
				break;
			// Skip: session_switched, permission_*, session_list, etc.
			// These are not part of the chat message stream.
		}

		// ── Queued-flag clearing (single source of truth) ────────────────
		// Same LLM_CONTENT_START_TYPES constant as handleMessage().
		if (isLlmContentStart(event.type)) clearQueuedFlags();
	}
	// Flush any pending debounced render (for mid-stream sessions
	// where no "done" event has been received yet)
	flushPendingRender();
	chatState.replaying = false;
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
			duration: 4000,
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
