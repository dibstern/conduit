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
import { createFrontendLogger } from "../utils/logger.js";
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

/** Valid chat pipeline phases. Single source of truth — the derived
 *  flags (isProcessing, isStreaming, isReplaying) derive from this value.
 *  Impossible boolean combinations are unrepresentable. */
export type ChatPhase = "idle" | "processing" | "streaming";

export type LoadLifecycle = "empty" | "loading" | "committed" | "ready";

export const chatState = $state({
	messages: [] as ChatMessage[],
	/** Raw text of the currently streaming assistant message. */
	currentAssistantText: "",
	/** Single source of truth for the chat pipeline phase. */
	phase: "idle" as ChatPhase,
	/** Tracks the lifecycle of loading session data into the chat store. */
	loadLifecycle: "empty" as LoadLifecycle,
	/** Monotonically increasing counter, bumped on each `done` event.
	 *  Provides an explicit, reliable turn-boundary signal for logic that
	 *  needs to distinguish "same turn" from "new turn" (e.g. queued-flag
	 *  clearing, future turn-aware features). Reset to 0 on clearMessages. */
	turnEpoch: 0,
});

// ─── Derived phase flags ────────────────────────────────────────────────────
// Svelte 5 forbids exporting $derived directly from .svelte.ts modules.
// We expose the derived values as exported functions that return the current
// reactive value.  Call sites read them as `isProcessing()`.

const _isProcessing = $derived(
	chatState.loadLifecycle !== "loading" &&
		(chatState.phase === "processing" || chatState.phase === "streaming"),
);
const _isStreaming = $derived(
	chatState.loadLifecycle !== "loading" && chatState.phase === "streaming",
);
const _isReplaying = $derived(chatState.loadLifecycle === "loading");
const _isLoading = $derived(chatState.loadLifecycle === "loading");

/** LLM is active (processing or streaming). */
export function isProcessing(): boolean {
	return _isProcessing;
}
/** Receiving deltas (assistant message being built). */
export function isStreaming(): boolean {
	return _isStreaming;
}
/** Event replay in progress. */
export function isReplaying(): boolean {
	return _isReplaying;
}
/** Session data is being loaded into the chat store. */
export function isLoading(): boolean {
	return _isLoading;
}

// ─── Phase Transitions ─────────────────────────────────────────────────────
// Enforce valid combinations of processing/streaming/replaying.
// All production code MUST use these instead of setting booleans directly.
// Tests may still set booleans directly for arbitrary state setup.

/** Session is idle — no LLM activity, no streaming. */
export function phaseToIdle(): void {
	chatState.phase = "idle";
}

/** LLM is active, awaiting first delta. */
export function phaseToProcessing(): void {
	chatState.phase = "processing";
}

/** Receiving deltas — assistant message being built. */
export function phaseToStreaming(): void {
	chatState.phase = "streaming";
}

/** Start event replay. */
export function phaseStartReplay(): void {
	chatState.loadLifecycle = "loading";
}

/** End event replay, reconcile phase based on current phase
 *  and external processing signals.
 *  loadLifecycle stays at "committed" — renderDeferredMarkdown will
 *  transition to "ready" once all deferred markdown is rendered.
 *  If there are no deferred messages, renderDeferredMarkdown sets
 *  "ready" on its first (and only) batch.
 *  @param llmActive — whether the replayed event stream ended mid-turn */
export function phaseEndReplay(llmActive: boolean): void {
	// Don't set loadLifecycle here — leave at "committed" so the
	// scroll controller's settle phase can run while deferred markdown
	// rendering completes. renderDeferredMarkdown sets "ready" when done.
	if (llmActive && chatState.phase === "idle") {
		chatState.phase = "processing";
	}
}

/** Full reset — used by clearMessages on session switch. */
function phaseReset(): void {
	chatState.phase = "idle";
	chatState.loadLifecycle = "empty";
}

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
const registryLog = createFrontendLogger("ToolRegistry", {
	onError(...args: unknown[]) {
		if (import.meta.env.DEV)
			throw new Error(["[ToolRegistry]", ...args].map(String).join(" "));
	},
});
const registry = createToolRegistry({ log: registryLog });

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

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Walk messages backward, find the last one matching `type` and `predicate`,
 * apply `updater`. Returns the new array and whether a match was found.
 * Pure — does not touch reactive state. */
export function updateLastMessage<T extends ChatMessage["type"]>(
	messages: readonly ChatMessage[],
	type: T,
	predicate: (m: Extract<ChatMessage, { type: T }>) => boolean,
	updater: (m: Extract<ChatMessage, { type: T }>) => ChatMessage,
): { messages: ChatMessage[]; found: boolean } {
	const out = [...messages];
	for (let i = out.length - 1; i >= 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const m = out[i]!;
		if (m.type === type && predicate(m as Extract<ChatMessage, { type: T }>)) {
			out[i] = updater(m as Extract<ChatMessage, { type: T }>);
			return { messages: out, found: true };
		}
	}
	return { messages: out, found: false };
}

/** Flush the debounced render timer, render pending markdown, finalize the
 *  last unfinalized assistant message, and reset streaming state.
 *  Returns the finalized message's `messageId` (if any) for dedup tracking.
 *
 *  Consolidates the pattern previously duplicated in handleDone,
 *  handleToolStart, and addUserMessage. */
function flushAndFinalizeAssistant(): string | undefined {
	// Check the phase flag
	if (chatState.phase !== "streaming") return undefined;

	if (renderTimer !== null) {
		clearTimeout(renderTimer);
		renderTimer = null;
	}
	if (chatState.currentAssistantText) {
		flushAssistantRender();
	}

	let finalizedMessageId: string | undefined;
	const { messages, found } = updateLastMessage(
		getMessages(),
		"assistant",
		(m) => !m.finalized,
		(m) => {
			finalizedMessageId = m.messageId;
			return { ...m, finalized: true };
		},
	);
	if (found) setMessages(messages);

	// Clear assistant text. Phase transition is the caller's responsibility
	// (handleDone → phaseToIdle, handleToolStart → phaseToProcessing, etc.)
	chatState.currentAssistantText = "";
	return finalizedMessageId;
}

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

export function discardReplayBatch(): void {
	replayBatch = null;
}

// ─── Replay Paging ──────────────────────────────────────────────────────────
// When a replay produces more than INITIAL_PAGE_SIZE messages, only the last
// page is committed to chatState.messages. Older messages are stored in a
// per-session buffer for HistoryLoader to page through on demand.

const INITIAL_PAGE_SIZE = 50;
const replayBuffers = new Map<string, ChatMessage[]>();

export function getReplayBuffer(sessionId: string): ChatMessage[] | undefined {
	return replayBuffers.get(sessionId);
}

export function consumeReplayBuffer(
	sessionId: string,
	count: number,
): ChatMessage[] {
	const buffer = replayBuffers.get(sessionId);
	if (!buffer || buffer.length === 0) return [];
	const page = buffer.splice(buffer.length - count, count);
	if (buffer.length === 0) replayBuffers.delete(sessionId);
	return page;
}

export function commitReplayFinal(sessionId: string): void {
	if (replayBatch === null) return;
	const all = replayBatch;
	replayBatch = null;

	if (all.length <= INITIAL_PAGE_SIZE) {
		chatState.messages = all;
	} else {
		const cutoff = all.length - INITIAL_PAGE_SIZE;
		replayBuffers.set(sessionId, all.slice(0, cutoff));
		chatState.messages = all.slice(cutoff);
		historyState.hasMore = true;
	}
	chatState.loadLifecycle = "committed";
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

	// If no current assistant message, create one.
	const isCurrentlyStreaming = chatState.phase === "streaming";
	if (!isCurrentlyStreaming) {
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
		phaseToStreaming();
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
	const { messages, found } = updateLastMessage(
		getMessages(),
		"thinking",
		(m) => !m.done,
		(m) => ({ ...m, text: m.text + msg.text }),
	);
	if (found) setMessages(messages);
}

export function handleThinkingStop(
	_msg: Extract<RelayMessage, { type: "thinking_stop" }>,
): void {
	const duration = thinkingStartTime > 0 ? Date.now() - thinkingStartTime : 0;
	thinkingStartTime = 0;

	const { messages, found } = updateLastMessage(
		getMessages(),
		"thinking",
		(m) => !m.done,
		(m) => ({ ...m, done: true, duration }),
	);
	if (found) setMessages(messages);
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

	// Finalize current assistant text before inserting tool.
	// Transition to processing — LLM is still active, just not streaming text.
	if (chatState.phase === "streaming") {
		flushAndFinalizeAssistant();
		phaseToProcessing();
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
	// Finalize the assistant message and record messageId for dedup
	const finalizedId = flushAndFinalizeAssistant();
	if (finalizedId) {
		doneMessageIds.add(finalizedId);
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

	chatState.turnEpoch++;
	phaseToIdle();
}

// ─── REST history queued-state fallback ──────────────────────────────────────
// The REST history path (historyToChatMessages) has no event-level data, so it
// cannot determine which messages were queued.  When status:processing arrives
// after a REST history load, we set sentDuringEpoch on the last unresponded
// user message.  This flag is ONLY set by the REST history load path in
// ws-dispatch.ts and consumed by the first status:processing after it.
let _pendingHistoryQueuedFallback = false;

/** Signal that the current session was loaded via REST history (no events).
 *  The next status:processing will apply the queued-state fallback. */
export function markPendingHistoryQueuedFallback(): void {
	_pendingHistoryQueuedFallback = true;
}

export function handleStatus(
	msg: Extract<RelayMessage, { type: "status" }>,
): void {
	if (msg.status === "processing") {
		phaseToProcessing();
		// Fallback ONLY for REST history loads — the one path where messages
		// don't go through addUserMessage and sentDuringEpoch can't be set
		// from event ordering.  Events replay and live sends both go through
		// addUserMessage, which sets the correct sentDuringEpoch already.
		if (_pendingHistoryQueuedFallback) {
			_pendingHistoryQueuedFallback = false;
			ensureSentDuringEpochOnLastUnrespondedUser();
		}
	}
}

/** Set `sentDuringEpoch` on the last unresponded user message if not
 *  already set.  Called ONLY after REST history loads when the session
 *  is processing — the only path where queued state can't be inferred. */
function ensureSentDuringEpochOnLastUnrespondedUser(): void {
	const msgs = getMessages();
	if (msgs.length === 0) return;

	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m) continue;
		if (m.type === "user") {
			// Already has sentDuringEpoch — write-once, don't touch
			if (m.sentDuringEpoch != null) return;
			// Has an assistant response after it — not queued
			const hasResponse = msgs
				.slice(i + 1)
				.some((msg) => msg.type === "assistant");
			if (hasResponse) return;
			// No sentDuringEpoch and no response — set it
			setMessages(
				msgs.map((msg, idx) =>
					idx === i ? { ...msg, sentDuringEpoch: chatState.turnEpoch } : msg,
				),
			);
			return;
		}
	}
}

export function handleError(
	msg: Extract<RelayMessage, { type: "error" }>,
): void {
	const { code, message, statusCode, details } = msg;
	const errorMeta = {
		code,
		...(statusCode !== undefined ? { statusCode } : {}),
		...(details !== undefined ? { details } : {}),
	};

	if (code === "RETRY") {
		// Subtle retry message
		addSystemMessage(message, "info");
	} else {
		// Prominent error
		addSystemMessage(message, "error", errorMeta);
		phaseToIdle();
	}
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Add a user message to the chat.
 *  When `sentWhileProcessing` is true the message records the current
 *  `turnEpoch` in `sentDuringEpoch` — a write-once, immutable fact.
 *  The UI derives the "Queued" shimmer reactively from this value
 *  and the live `turnEpoch`; no clearing/mutation is ever needed.
 *
 *  During replay, defensively finalizes any in-progress assistant message
 *  so that subsequent delta events create a new AssistantMessage block.
 *  During live streaming (sentWhileProcessing=true), the assistant message
 *  is left unfinalized so deltas keep updating it in-place and the queued
 *  user message stays at the bottom instead of splitting the response. */
export function addUserMessage(
	text: string,
	images?: string[],
	sentWhileProcessing?: boolean,
): void {
	// A live (non-replay) addUserMessage call means addUserMessage is
	// setting the correct sentDuringEpoch — consume the history fallback
	// flag so a subsequent status:processing doesn't override it.
	if (chatState.loadLifecycle !== "loading") {
		_pendingHistoryQueuedFallback = false;
	}

	// Finalize the in-progress assistant message only during replay,
	// where user_message events can appear between delta events without
	// an intervening done event.  During live streaming the assistant
	// message stays unfinalized so subsequent deltas continue updating
	// it and the queued user message stays at the end.
	if (!sentWhileProcessing && chatState.currentAssistantText) {
		flushAndFinalizeAssistant();
		phaseToIdle();
	}

	const uuid = generateUuid();
	const msg: UserMessage = {
		type: "user",
		uuid,
		text,
		...(images != null && { images }),
		...(sentWhileProcessing ? { sentDuringEpoch: chatState.turnEpoch } : {}),
	};
	setMessages([...getMessages(), msg]);
}

/** Prepend older messages (from history) before existing messages.
 *  Used when paginating older messages or loading REST history. */
export function prependMessages(msgs: ChatMessage[]): void {
	if (msgs.length === 0) return;
	setMessages([...msgs, ...getMessages()]);
}

/** Add a system message to the chat. */
export function addSystemMessage(
	text: string,
	variant: SystemMessageVariant = "info",
	errorMeta?: {
		code?: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	},
): void {
	const uuid = generateUuid();
	const msg: SystemMessage = {
		type: "system",
		uuid,
		text,
		variant,
		...(errorMeta?.code ? { errorCode: errorMeta.code } : {}),
		...(errorMeta?.statusCode ? { statusCode: errorMeta.statusCode } : {}),
		...(errorMeta?.details ? { details: errorMeta.details } : {}),
	};
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
/**
 * Seed the ToolRegistry from chat messages loaded via REST history.
 * Without this, SSE events arriving for history-loaded tools would be
 * rejected as "unknown tool" since the registry only knows about tools
 * registered via handleToolStart (the live event path).
 */
export function seedRegistryFromMessages(
	messages: readonly ChatMessage[],
): void {
	const tools = messages.filter((m): m is ToolMessage => m.type === "tool");
	if (tools.length > 0) {
		registry.seedFromHistory(tools);
	}
}

export function clearMessages(): void {
	replayBatch = null;
	replayBuffers.clear();
	phaseReset(); // must be cleared before abort hook — stops replay generation check
	onClearMessages?.(); // abort in-flight async replays
	cancelDeferredMarkdown(); // abort in-flight deferred renders
	chatState.messages = [];
	chatState.currentAssistantText = "";
	chatState.turnEpoch = 0;
	_pendingHistoryQueuedFallback = false;
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
	/** Preserved so that `sentDuringEpoch` comparisons remain correct
	 *  after restore — without this, turnEpoch resets to 0 and messages
	 *  with sentDuringEpoch would incorrectly show the "Queued" shimmer. */
	turnEpoch: number;
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
		turnEpoch: chatState.turnEpoch,
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
	chatState.turnEpoch = entry.turnEpoch;
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

	const rawText = chatState.currentAssistantText;
	const html =
		chatState.loadLifecycle === "loading" ? rawText : renderMarkdown(rawText);
	const isReplay = chatState.loadLifecycle === "loading";

	const { messages, found } = updateLastMessage(
		getMessages(),
		"assistant",
		(m) => !m.finalized,
		(m) => ({
			...m,
			rawText,
			html,
			...(isReplay ? { needsRender: true as const } : {}),
		}),
	);
	if (found) setMessages(messages);
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
		} else if (chatState.loadLifecycle === "committed") {
			chatState.loadLifecycle = "ready";
		}
	}

	if (typeof requestIdleCallback === "function") {
		requestIdleCallback(() => processBatch());
	} else {
		setTimeout(processBatch, 0);
	}
}
