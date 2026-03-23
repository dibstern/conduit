// ─── Chat Store ──────────────────────────────────────────────────────────────
// Manages chat messages, streaming state, and processing.

import type {
	AssistantMessage,
	ChatMessage,
	RelayMessage,
	ResultMessage,
	SystemMessage,
	SystemMessageVariant,
	ThinkingMessage,
	ToolMessage,
	UserMessage,
} from "../types.js";
import { generateUuid } from "../utils/format.js";
import { renderMarkdown } from "../utils/markdown.js";
import { discoveryState } from "./discovery.svelte.js";
import { createToolRegistry } from "./tool-registry.js";
import { uiState, updateContextPercent } from "./ui.svelte.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Type-safe search: narrows ChatMessage by discriminant, avoiding unsafe index casts. */
export function findMessage<T extends ChatMessage["type"]>(
	messages: ChatMessage[],
	type: T,
	predicate: (m: Extract<ChatMessage, { type: T }>) => boolean,
): { index: number; message: Extract<ChatMessage, { type: T }> } | undefined {
	for (let i = 0; i < messages.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const m = messages[i]!;
		if (m.type === type && predicate(m as Extract<ChatMessage, { type: T }>)) {
			return { index: i, message: m as Extract<ChatMessage, { type: T }> };
		}
	}
	return undefined;
}

// ─── State ──────────────────────────────────────────────────────────────────

export const chatState = $state({
	messages: [] as ChatMessage[],
	/** Raw text of the currently streaming assistant message. */
	currentAssistantText: "",
	/** Whether the LLM is currently generating. */
	processing: false,
	/** Tracks whether we're mid-stream (assistant message not yet finalized). */
	streaming: false,
	/** True during event replay (session switch). Suppresses streaming animations. */
	replaying: false,
	/** True after clearQueuedFlags() is called, reset when processing starts.
	 *  Used by the unified rendering pipeline to know that the LLM has started
	 *  responding to a previously-queued message (so the queued shimmer should be removed). */
	queuedFlagsCleared: false,
});

/** Pagination state for history loading (shared between HistoryLoader and dispatch). */
export const historyState = $state({
	/** Whether there are more history pages to fetch from the server.
	 *  Defaults to false (disarmed). Set to true only when the server
	 *  explicitly says there are more pages (REST fallback with hasMore). */
	hasMore: false,
	/** Whether a history page request is in-flight. */
	loading: false,
	/** Count of REST-level messages loaded via history (for pagination offset). */
	messageCount: 0,
});

// ─── Input Sync State ───────────────────────────────────────────────────────
// Tracks the last input text received from another tab viewing the same session.

export const inputSyncState = $state({
	/** The synced input text. */
	text: "",
	/** Client ID that originated the sync (empty string if unknown). */
	lastFrom: "",
	/** Timestamp of the last sync update (monotonic, for change detection). */
	lastUpdated: 0,
});

/** Handle an incoming input_sync message from another tab. */
export function handleInputSyncReceived(msg: {
	text?: string;
	from?: string;
}): void {
	inputSyncState.text = msg.text ?? "";
	inputSyncState.lastFrom = msg.from ?? "";
	inputSyncState.lastUpdated = Date.now();
}

// ─── Derived getters ────────────────────────────────────────────────────────

/** Get the number of messages in current conversation. */
export function getMessageCount(): number {
	return chatState.messages.length;
}

// ─── Internal state (not reactive — used for debouncing) ────────────────────

let renderTimer: ReturnType<typeof setTimeout> | null = null;
let thinkingStartTime = 0;

/** Centralized tool lifecycle state machine. Enforces forward-only transitions. */
const registry = createToolRegistry({
	log: (level, message) => {
		const tag = `[ToolRegistry] ${message}`;
		if (level === "error") {
			console.error(tag);
			if (import.meta.env.DEV) throw new Error(tag);
		} else if (level === "warn") {
			console.warn(tag);
		} else {
			console.debug(tag);
		}
	},
});

/** Append a new tool message to chatState.messages. */
function applyToolCreate(tool: ToolMessage): void {
	setMessages([...getMessages(), tool]);
}

/** Replace a tool message in chatState.messages by UUID. */
function applyToolUpdate(uuid: string, tool: ToolMessage): void {
	const messages = [...getMessages()];
	const found = findMessage(messages, "tool", (m) => m.uuid === uuid);
	if (found) {
		messages[found.index] = tool;
		setMessages(messages);
	}
}

/**
 * Track messageIds that have been finalized by handleDone() (not by tool_start).
 * Used to suppress duplicate deltas from the message poller, which can
 * re-synthesize content that SSE already delivered when its snapshot is stale.
 */
const doneMessageIds = new Set<string>();

// ─── Abort hook ─────────────────────────────────────────────────────────────
// Used by ws-dispatch.ts to abort in-flight async replays when clearMessages
// is called. Avoids circular imports (ws-dispatch → chat.svelte, not vice versa).

let onClearMessages: (() => void) | null = null;

export function registerClearMessagesHook(fn: () => void): void {
	onClearMessages = fn;
}

// ─── Replay Batch ───────────────────────────────────────────────────────────
let replayBatch: ChatMessage[] | null = null;

export function beginReplayBatch(): void {
	replayBatch = [...chatState.messages];
}

export function commitReplayBatch(): void {
	if (replayBatch !== null) {
		chatState.messages = replayBatch;
		replayBatch = null;
	}
}

export function discardReplayBatch(): void {
	replayBatch = null;
}

export function getMessages(): ChatMessage[] {
	return replayBatch ?? chatState.messages;
}

function setMessages(msgs: ChatMessage[]): void {
	if (replayBatch !== null) {
		replayBatch = msgs;
	} else {
		chatState.messages = msgs;
	}
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleDelta(
	msg: Extract<RelayMessage, { type: "delta" }>,
): void {
	const { text, messageId } = msg;

	// ── Deduplicate: skip deltas for a messageId that was already finalized ──
	// This prevents the message poller from creating a second AssistantMessage
	// for content that SSE already delivered. The poller can re-synthesize the
	// entire response when its snapshot is stale (SSE silence gap > 2s).
	if (messageId && doneMessageIds.has(messageId)) {
		return;
	}

	// If no current assistant message, create one
	if (!chatState.streaming) {
		const uuid = generateUuid();
		const assistantMsg: AssistantMessage = {
			type: "assistant",
			uuid,
			rawText: "",
			html: "",
			finalized: false,
			...(messageId != null && { messageId }),
		};
		setMessages([...getMessages(), assistantMsg]);
		chatState.streaming = true;
		chatState.currentAssistantText = "";
	}

	chatState.currentAssistantText += text;

	// Debounced markdown render (80ms)
	if (renderTimer !== null) clearTimeout(renderTimer);
	renderTimer = setTimeout(() => {
		renderTimer = null;
		flushAssistantRender();
	}, 80);
}

export function handleThinkingStart(
	_msg: Extract<RelayMessage, { type: "thinking_start" }>,
): void {
	thinkingStartTime = Date.now();
	const uuid = generateUuid();
	const thinkingMsg: ThinkingMessage = {
		type: "thinking",
		uuid,
		text: "",
		done: false,
	};
	setMessages([...getMessages(), thinkingMsg]);
}

export function handleThinkingDelta(
	msg: Extract<RelayMessage, { type: "thinking_delta" }>,
): void {
	const { text } = msg;

	// Find the last thinking message and append
	const messages = [...getMessages()];
	for (let i = messages.length - 1; i >= 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const m = messages[i]!;
		if (m.type === "thinking" && !m.done) {
			messages[i] = {
				...m,
				text: m.text + text,
			};
			setMessages(messages);
			return;
		}
	}
}

export function handleThinkingStop(
	_msg: Extract<RelayMessage, { type: "thinking_stop" }>,
): void {
	const duration = thinkingStartTime > 0 ? Date.now() - thinkingStartTime : 0;
	thinkingStartTime = 0;

	const messages = [...getMessages()];
	for (let i = messages.length - 1; i >= 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const m = messages[i]!;
		if (m.type === "thinking" && !m.done) {
			messages[i] = {
				...m,
				done: true,
				duration,
			};
			setMessages(messages);
			return;
		}
	}
}

export function handleToolStart(
	msg: Extract<RelayMessage, { type: "tool_start" }>,
): void {
	const { id, name, messageId } = msg;

	const result = registry.start(id, name || "unknown", messageId);

	if (result.action === "duplicate") {
		return;
	}

	if (result.action !== "create") {
		return;
	}

	// ── Finalize current assistant text before inserting tool ──────────
	if (chatState.streaming && chatState.currentAssistantText) {
		if (renderTimer !== null) {
			clearTimeout(renderTimer);
			renderTimer = null;
		}
		flushAssistantRender();

		const messages = [...getMessages()];
		for (let i = messages.length - 1; i >= 0; i--) {
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const m = messages[i]!;
			if (m.type === "assistant" && !m.finalized) {
				messages[i] = {
					...m,
					finalized: true,
				};
				setMessages(messages);
				break;
			}
		}

		chatState.streaming = false;
		chatState.currentAssistantText = "";
	}

	applyToolCreate(result.tool);
}

export function handleToolExecuting(
	msg: Extract<RelayMessage, { type: "tool_executing" }>,
): void {
	const result = registry.executing(msg.id, msg.input, msg.metadata);
	if (result.action === "update") {
		applyToolUpdate(result.uuid, result.tool);
	}
}

export function handleToolResult(
	msg: Extract<RelayMessage, { type: "tool_result" }>,
): void {
	const result = registry.complete(msg.id, msg.content, msg.is_error, {
		...(msg.isTruncated != null && { isTruncated: msg.isTruncated }),
		...(msg.fullContentLength != null && {
			fullContentLength: msg.fullContentLength,
		}),
	});
	if (result.action === "update") {
		applyToolUpdate(result.uuid, result.tool);
	}
}

export function handleResult(
	msg: Extract<RelayMessage, { type: "result" }>,
): void {
	const { usage, cost, duration } = msg;

	// ── Deduplicate result bars ─────────────────────────────────────────
	// OpenCode sends multiple message.updated events for the same assistant
	// message (first with cost/tokens, then again with duration). Instead
	// of appending a new ResultMessage each time, update the existing one
	// in-place. The last ResultMessage in the array (not separated by a
	// "done" message) is considered the same turn's result bar.
	const currentMessages = getMessages();
	const lastMsg = currentMessages[currentMessages.length - 1];
	if (lastMsg?.type === "result") {
		const messages = [...currentMessages];
		const dur = duration ?? lastMsg.duration;
		messages[messages.length - 1] = {
			...lastMsg,
			cost: cost ?? lastMsg.cost,
			...(dur != null && { duration: dur }),
			inputTokens: usage?.input ?? lastMsg.inputTokens,
			outputTokens: usage?.output ?? lastMsg.outputTokens,
			cacheRead: usage?.cache_read ?? lastMsg.cacheRead,
			cacheWrite: usage?.cache_creation ?? lastMsg.cacheWrite,
		};
		setMessages(messages);
		// Update context usage bar
		updateContextFromTokens(usage);
		return;
	}

	const uuid = generateUuid();
	const resultMsg: ResultMessage = {
		type: "result",
		uuid,
		cost,
		duration,
		inputTokens: usage?.input,
		outputTokens: usage?.output,
		cacheRead: usage?.cache_read,
		cacheWrite: usage?.cache_creation,
	};
	setMessages([...getMessages(), resultMsg]);
	// Update context usage bar
	updateContextFromTokens(usage);
}

/** Compute context window usage from token counts and current model's limit. */
function updateContextFromTokens(
	usage:
		| {
				input?: number;
				output?: number;
				cache_read?: number;
				cache_creation?: number;
		  }
		| undefined,
): void {
	if (!usage) return;
	const total =
		(usage.input ?? 0) +
		(usage.output ?? 0) +
		(usage.cache_read ?? 0) +
		(usage.cache_creation ?? 0);
	if (total <= 0) return;

	// Find the current model's context limit
	const modelId = discoveryState.currentModelId;
	if (!modelId) return;
	for (const p of discoveryState.providers) {
		const model = p.models.find((m) => m.id === modelId);
		if (model?.limit?.context) {
			const pct = Math.round((total / model.limit.context) * 100);
			updateContextPercent(pct);
			return;
		}
	}
}

export function handleDone(
	_msg: Extract<RelayMessage, { type: "done" }>,
): void {
	// Flush any pending render
	if (renderTimer !== null) {
		clearTimeout(renderTimer);
		renderTimer = null;
	}

	// Finalize the assistant message
	if (chatState.streaming) {
		flushAssistantRender();
		const messages = [...getMessages()];
		for (let i = messages.length - 1; i >= 0; i--) {
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const m = messages[i]!;
			if (m.type === "assistant" && !m.finalized) {
				messages[i] = {
					...m,
					finalized: true,
				};
				setMessages(messages);
				// Record messageId so duplicate deltas from the message poller
				// are suppressed (see handleDelta dedup guard).
				if (m.messageId) {
					doneMessageIds.add(m.messageId);
				}
				break;
			}
		}
	}

	// Finalize any tools still in non-terminal states (pending/running).
	const finResult = registry.finalizeAll(getMessages());
	if (finResult.action === "finalized") {
		const messages = [...getMessages()];
		for (const idx of finResult.indices) {
			// biome-ignore lint/style/noNonNullAssertion: safe — index from finalizeAll
			const m = messages[idx]!;
			if (m.type === "tool") {
				messages[idx] = { ...m, status: "completed" };
			}
		}
		setMessages(messages);
	}

	chatState.streaming = false;
	chatState.processing = false;
	chatState.currentAssistantText = "";
}

export function handleStatus(
	msg: Extract<RelayMessage, { type: "status" }>,
): void {
	if (msg.status === "processing") {
		chatState.processing = true;
		// Reset so queued styling can be applied for new processing turns
		chatState.queuedFlagsCleared = false;
		// Apply queued flag to the last unresponded user message.
		// This handles the REST history path where messages are prepended
		// before status:processing arrives as a separate WS message.
		applyQueuedFlagInPlace();
	}
}

/** Mark the last unresponded user message as queued in-place.
 *  Called when processing starts — handles the timing gap between
 *  REST history prepend and status:processing arrival. */
function applyQueuedFlagInPlace(): void {
	const msgs = getMessages();
	if (msgs.length === 0) return;

	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m) continue;
		if (m.type === "user") {
			// Check if there's an assistant response after it
			const hasResponse = msgs
				.slice(i + 1)
				.some((msg) => msg.type === "assistant");
			if (hasResponse) return; // Already responded — no queued flag needed
			// No response — mark as queued (immutable update)
			setMessages(
				msgs.map((msg, idx) => (idx === i ? { ...msg, queued: true } : msg)),
			);
			return;
		}
	}
}

export function handleError(
	msg: Extract<RelayMessage, { type: "error" }>,
): void {
	const { code, message } = msg;

	if (code === "RETRY") {
		// Subtle retry message
		addSystemMessage(message, "info");
	} else {
		// Prominent error
		addSystemMessage(message, "error");
		chatState.processing = false;
		chatState.streaming = false;
	}
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Add a user message to the chat.
 *  When `queued` is true the message is visually dimmed with a shimmer —
 *  it has been sent to the server but is waiting for the LLM to start.
 *
 *  Defensively finalizes any in-progress assistant message so that
 *  subsequent delta events create a new AssistantMessage block instead
 *  of appending to the one before the user message. */
export function addUserMessage(
	text: string,
	images?: string[],
	queued?: boolean,
): void {
	// If the assistant is mid-stream, finalize the current message.
	// This can happen during event replay when user_message events
	// appear between delta events without an intervening done event.
	if (chatState.streaming && chatState.currentAssistantText) {
		if (renderTimer !== null) {
			clearTimeout(renderTimer);
			renderTimer = null;
		}
		flushAssistantRender();

		const messages = [...getMessages()];
		for (let i = messages.length - 1; i >= 0; i--) {
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const m = messages[i]!;
			if (m.type === "assistant" && !m.finalized) {
				messages[i] = { ...m, finalized: true };
				setMessages(messages);
				break;
			}
		}
		chatState.streaming = false;
		chatState.currentAssistantText = "";
	}

	const uuid = generateUuid();
	const msg: UserMessage = {
		type: "user",
		uuid,
		text,
		...(images != null && { images }),
		...(queued != null && { queued }),
	};
	setMessages([...getMessages(), msg]);
}

/** Prepend older messages (from history) before existing messages.
 *  Used when paginating older messages or loading REST history. */
export function prependMessages(msgs: ChatMessage[]): void {
	if (msgs.length === 0) return;
	setMessages([...msgs, ...getMessages()]);
}

/** Clear the `queued` flag on all user messages.
 *  Called when a new streaming response starts (first delta) so the
 *  previously-queued message transitions to its normal appearance.
 *  Also sets `queuedFlagsCleared` so the unified rendering pipeline
 *  can reactively remove its queued styling. */
export function clearQueuedFlags(): void {
	chatState.queuedFlagsCleared = true;
	let changed = false;
	const messages = getMessages().map((m) => {
		if (m.type === "user" && m.queued) {
			changed = true;
			return { ...m, queued: false };
		}
		return m;
	});
	if (changed) setMessages(messages);
}

/** Add a system message to the chat. */
export function addSystemMessage(
	text: string,
	variant: SystemMessageVariant = "info",
): void {
	const uuid = generateUuid();
	const msg: SystemMessage = { type: "system", uuid, text, variant };
	setMessages([...getMessages(), msg]);
}

/** Reset all chat state (for stories/tests). Alias for clearMessages. */
export const resetChatState = clearMessages;

/**
 * Flush any pending debounced assistant render immediately.
 * Called after replaying events so mid-stream content is visible.
 */
export function flushPendingRender(): void {
	if (renderTimer !== null) {
		clearTimeout(renderTimer);
		renderTimer = null;
	}
	flushAssistantRender();
}

/** Clear all messages (e.g. on session switch).
 *
 *  IMPORTANT: Do NOT read reactive $state (e.g. sessionState.currentId)
 *  inside this function — it is called from $effect contexts and reading
 *  reactive state here creates infinite effect loops. */
export function clearMessages(): void {
	replayBatch = null;
	chatState.replaying = false; // safety: clear stale flag on session switch
	onClearMessages?.(); // abort in-flight async replays
	cancelDeferredMarkdown(); // abort in-flight deferred renders
	chatState.messages = [];
	chatState.currentAssistantText = "";
	chatState.streaming = false;
	chatState.processing = false;
	chatState.queuedFlagsCleared = false;
	registry.clear();
	doneMessageIds.clear();
	if (renderTimer !== null) {
		clearTimeout(renderTimer);
		renderTimer = null;
	}
	historyState.hasMore = false;
	historyState.loading = false;
	historyState.messageCount = 0;
}

// ─── Session Message Cache ──────────────────────────────────────────────────
// Stashes messages when switching away from a session so that revisiting the
// session shows content instantly (before the server round-trip completes).
// Uses a bounded Map (insertion-ordered) as a simple LRU cache.

const SESSION_CACHE_MAX = 10;

interface CachedSession {
	messages: ChatMessage[];
	contextPercent: number;
	historyHasMore: boolean;
	historyMessageCount: number;
}

const sessionMessageCache = new Map<string, CachedSession>();

/** Save current messages for the given session. No-op if empty.
 *
 *  Uses `$state.snapshot()` to strip Svelte 5 reactive proxies so the
 *  cache holds plain objects.  Re-assigning them later lets Svelte
 *  re-proxify cleanly without double-wrapping or stale signal refs. */
export function stashSessionMessages(sessionId: string): void {
	if (!sessionId || chatState.messages.length === 0) return;
	// Evict oldest entry if at capacity (Map preserves insertion order).
	if (sessionMessageCache.size >= SESSION_CACHE_MAX) {
		const oldest = sessionMessageCache.keys().next().value;
		if (oldest) sessionMessageCache.delete(oldest);
	}
	// Re-insert at end (most-recently-used).
	sessionMessageCache.delete(sessionId);
	sessionMessageCache.set(sessionId, {
		messages: $state.snapshot(chatState.messages),
		contextPercent: uiState.contextPercent,
		historyHasMore: historyState.hasMore,
		historyMessageCount: historyState.messageCount,
	});
}

/** Restore cached messages for the given session.
 *  Returns true on cache hit (messages + context bar restored). */
export function restoreCachedMessages(sessionId: string): boolean {
	const entry = sessionMessageCache.get(sessionId);
	if (!entry) return false;
	chatState.messages = entry.messages;
	updateContextPercent(entry.contextPercent);
	historyState.hasMore = entry.historyHasMore;
	historyState.messageCount = entry.historyMessageCount;
	// Move to end (most-recently-used).
	sessionMessageCache.delete(sessionId);
	sessionMessageCache.set(sessionId, entry);
	return true;
}

/** Remove a session from the message cache (e.g. after deletion). */
export function evictCachedMessages(sessionId: string): void {
	sessionMessageCache.delete(sessionId);
}

// ─── Part/message removal handlers ───────────────────────────────────────────

export function handlePartRemoved(
	msg: Extract<RelayMessage, { type: "part_removed" }>,
): void {
	const { partId } = msg;
	if (!partId) return;
	setMessages(
		getMessages().filter((m) => m.type !== "tool" || m.id !== partId),
	);
	registry.remove(partId);
}

export function handleMessageRemoved(
	msg: Extract<RelayMessage, { type: "message_removed" }>,
): void {
	const { messageId } = msg;
	if (!messageId) return;
	setMessages(
		getMessages().filter(
			(m) => !("messageId" in m) || m.messageId !== messageId,
		),
	);
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Flush the current assistant text to the last assistant message's HTML. */
function flushAssistantRender(): void {
	if (!chatState.currentAssistantText) return;

	const html = chatState.replaying
		? chatState.currentAssistantText // raw text fallback during replay
		: renderMarkdown(chatState.currentAssistantText);

	const messages = [...getMessages()];

	for (let i = messages.length - 1; i >= 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const m = messages[i]!;
		if (m.type === "assistant" && !m.finalized) {
			if (chatState.replaying) {
				messages[i] = {
					...m,
					rawText: chatState.currentAssistantText,
					html,
					needsRender: true,
				};
			} else {
				messages[i] = {
					...m,
					rawText: chatState.currentAssistantText,
					html,
				};
			}
			setMessages(messages);
			return;
		}
	}
}

// ─── Deferred Markdown Rendering ────────────────────────────────────────────
// After replay completes, messages marked with `needsRender` have raw text
// in their `html` field. renderDeferredMarkdown processes them in batches
// via requestIdleCallback/setTimeout to avoid blocking the main thread.

let deferredGeneration = 0;

export function cancelDeferredMarkdown(): void {
	deferredGeneration++;
}

export function renderDeferredMarkdown(): void {
	const generation = ++deferredGeneration;
	const BATCH_SIZE = 5;

	function processBatch(): void {
		if (generation !== deferredGeneration) return; // aborted

		const updated = [...chatState.messages];
		let rendered = 0;
		for (let i = 0; i < updated.length && rendered < BATCH_SIZE; i++) {
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const m = updated[i]!;
			if (m.type === "assistant" && m.needsRender) {
				// Use spread-omit to remove needsRender (exactOptionalPropertyTypes)
				const { needsRender: _, ...rest } = m;
				updated[i] = { ...rest, html: renderMarkdown(m.rawText) };
				rendered++;
			}
		}
		if (rendered > 0) {
			chatState.messages = updated;
		}

		// Continue if more unrendered messages remain
		const hasMore = updated.some(
			(m) => m.type === "assistant" && (m as AssistantMessage).needsRender,
		);
		if (hasMore) {
			setTimeout(processBatch, 0);
		}
	}

	if (typeof requestIdleCallback === "function") {
		requestIdleCallback(() => processBatch());
	} else {
		setTimeout(processBatch, 0);
	}
}
