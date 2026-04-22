// ─── Chat Store ──────────────────────────────────────────────────────────────
// Manages chat messages, streaming state, and processing.
//
// Two-tier per-session chat state. Handlers receive (activity, messages, event)
// and write to per-session tiers. The routePerSession dispatcher in
// ws-dispatch.ts resolves the correct session slot by event.sessionId.

import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { PerSessionEvent } from "../../shared-types.js";
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
import { sessionState } from "./session.svelte.js";
import { createToolRegistry, type ToolRegistry } from "./tool-registry.js";

// ─── Two-Tier Per-Session Chat State ────────────────────────────────────────

// Tier 1 — Activity. Unbounded. Small scalars + small Sets, << 1 KB per session.
export type SessionActivity = {
	phase: ChatPhase;
	turnEpoch: number;
	currentMessageId: string | null;
	replayGeneration: number;
	doneMessageIds: SvelteSet<string>;
	seenMessageIds: SvelteSet<string>;
	liveEventBuffer: PerSessionEvent[] | null;
	eventsHasMore: boolean;
	renderTimer: ReturnType<typeof setTimeout> | null;
	thinkingStartTime: number;
};

// Tier 2 — Messages. LRU-capped. Holds only data safely reconstructable
// from the server's event log.
export type SessionMessages = {
	messages: ChatMessage[];
	currentAssistantText: string;
	loadLifecycle: LoadLifecycle;
	contextPercent: number;
	historyHasMore: boolean;
	historyMessageCount: number;
	historyLoading: boolean;
	toolRegistry: ToolRegistry;
	/** Working copy of messages during replay. Null when not replaying.
	 *  Moved from module-level in Task 3 to enable per-session replay. */
	replayBatch: ChatMessage[] | null;
	/** Per-session buffer of older messages from large replays.
	 *  HistoryLoader pages through this before hitting the server. */
	replayBuffer: ChatMessage[] | null;
};

// Composite read shape for the chat view. NEVER instantiated as storage.
export type SessionChatState = SessionActivity & SessionMessages;

// ── Factories (return plain POJOs — $state wrapping happens in getOrCreate*) ──

export function createEmptySessionActivity(): SessionActivity {
	return {
		phase: "idle",
		turnEpoch: 0,
		currentMessageId: null,
		replayGeneration: 0,
		doneMessageIds: new SvelteSet(),
		seenMessageIds: new SvelteSet(),
		liveEventBuffer: null,
		eventsHasMore: false,
		renderTimer: null,
		thinkingStartTime: 0,
	};
}

export function createEmptySessionMessages(): SessionMessages {
	return {
		messages: [],
		currentAssistantText: "",
		loadLifecycle: "empty",
		contextPercent: 0,
		historyHasMore: false,
		historyMessageCount: 0,
		historyLoading: false,
		toolRegistry: createToolRegistry(),
		replayBatch: null,
		replayBuffer: null,
	};
}

// ── ACTIVITY_KEYS — derived from factory return shape ──

export const ACTIVITY_KEYS: ReadonlySet<keyof SessionActivity> = new Set(
	Object.keys(createEmptySessionActivity()) as (keyof SessionActivity)[],
);

// ── composeChatState — read-only Proxy with full trap set ──

export function composeChatState(
	activity: SessionActivity,
	messages: SessionMessages,
): SessionChatState {
	return new Proxy({} as SessionChatState, {
		get(_t, key) {
			if (typeof key !== "string") return undefined;
			return ACTIVITY_KEYS.has(key as keyof SessionActivity)
				? (activity as Record<string, unknown>)[key]
				: (messages as Record<string, unknown>)[key];
		},
		set() {
			throw new Error(
				"currentChat() is read-only. Mutate state via handlers (activity, messages) parameters.",
			);
		},
		has(_t, key) {
			if (typeof key !== "string") return false;
			return ACTIVITY_KEYS.has(key as keyof SessionActivity) || key in messages;
		},
		ownKeys() {
			return [...ACTIVITY_KEYS, ...Object.keys(createEmptySessionMessages())];
		},
		getOwnPropertyDescriptor(_t, key) {
			if (typeof key !== "string") return undefined;
			const source = ACTIVITY_KEYS.has(key as keyof SessionActivity)
				? activity
				: messages;
			const value = (source as Record<string, unknown>)[key];
			if (value === undefined) return undefined;
			return { value, writable: false, enumerable: true, configurable: true };
		},
	});
}

// ── Empty sentinels (frozen POJOs, NOT $state) ──

const EMPTY_ACTIVITY_RAW = createEmptySessionActivity();
const EMPTY_MESSAGES_RAW = createEmptySessionMessages();
const throwingRegistryStub = () => {
	throw new Error("EMPTY_MESSAGES.toolRegistry is read-only");
};
for (const methodName of Object.keys(
	EMPTY_MESSAGES_RAW.toolRegistry,
) as (keyof ToolRegistry)[]) {
	if (typeof EMPTY_MESSAGES_RAW.toolRegistry[methodName] === "function") {
		(EMPTY_MESSAGES_RAW.toolRegistry as unknown as Record<string, unknown>)[
			methodName
		] = throwingRegistryStub;
	}
}
export const EMPTY_ACTIVITY: SessionActivity =
	Object.freeze(EMPTY_ACTIVITY_RAW);
export const EMPTY_MESSAGES: SessionMessages =
	Object.freeze(EMPTY_MESSAGES_RAW);

const EMPTY_STATE_RAW: SessionChatState = composeChatState(
	EMPTY_ACTIVITY,
	EMPTY_MESSAGES,
);

export const EMPTY_STATE: SessionChatState =
	(import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
		? new Proxy(EMPTY_STATE_RAW, {
				set(_t, key) {
					throw new Error(
						`Attempted to mutate EMPTY_STATE.${String(key)} — currentId is null. This is a routing bug.`,
					);
				},
			})
		: EMPTY_STATE_RAW;

// ── Per-session maps ──

export const sessionActivity = new SvelteMap<string, SessionActivity>();
export const sessionMessages = new SvelteMap<string, SessionMessages>();

// ── Read API ──

const _currentChat = $derived.by((): SessionChatState => {
	const id = sessionState.currentId;
	if (id == null) return EMPTY_STATE;
	const activity = sessionActivity.get(id);
	if (!activity) return EMPTY_STATE;
	const messages = sessionMessages.get(id) ?? EMPTY_MESSAGES;
	return composeChatState(activity, messages);
});
export function currentChat(): SessionChatState {
	return _currentChat;
}

export function getSessionPhase(id: string): ChatPhase {
	return sessionActivity.get(id)?.phase ?? "idle";
}

// ── Write API ──

export function getOrCreateSessionActivity(id: string): SessionActivity {
	if (id === "") throw new Error("getOrCreateSessionActivity: empty sessionId");
	const existing = sessionActivity.get(id);
	if (existing) return existing;
	// biome-ignore lint/style/useConst: $state() requires let for Svelte 5 reactivity
	let a: SessionActivity = $state(createEmptySessionActivity());
	sessionActivity.set(id, a);
	return a;
}

export function getOrCreateSessionMessages(id: string): SessionMessages {
	if (id === "") throw new Error("getOrCreateSessionMessages: empty sessionId");
	const existing = sessionMessages.get(id);
	if (existing) {
		touchLRU(id);
		return existing;
	}
	// biome-ignore lint/style/useConst: $state() requires let for Svelte 5 reactivity
	let m: SessionMessages = $state(createEmptySessionMessages());
	sessionMessages.set(id, m);
	ensureLRUCap();
	touchLRU(id);
	return m;
}

export function getOrCreateSessionSlot(id: string): {
	activity: SessionActivity;
	messages: SessionMessages;
} {
	return {
		activity: getOrCreateSessionActivity(id),
		messages: getOrCreateSessionMessages(id),
	};
}

export function clearSessionChatState(id: string): void {
	const activity = sessionActivity.get(id);
	if (activity) {
		activity.replayGeneration++;
		if (activity.renderTimer) {
			clearTimeout(activity.renderTimer);
		}
	}
	sessionActivity.delete(id);
	sessionMessages.delete(id);
	const lruIdx = lruOrder.indexOf(id);
	if (lruIdx !== -1) lruOrder.splice(lruIdx, 1);
}

// ── LRU helpers (Tier 2 only) ──

const TIER2_LRU_CAP = 20;
const lruOrder: string[] = [];

/** Reset internal LRU state. Exported for test cleanup only. */
export function _resetLRU(): void {
	lruOrder.length = 0;
}

function touchLRU(id: string): void {
	const idx = lruOrder.indexOf(id);
	if (idx !== -1) lruOrder.splice(idx, 1);
	lruOrder.push(id);
}

function ensureLRUCap(): void {
	while (sessionMessages.size > TIER2_LRU_CAP && lruOrder.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: safe — length check above
		const candidate = lruOrder[0]!;
		// Never evict the current session
		if (candidate === sessionState.currentId) {
			lruOrder.shift();
			lruOrder.push(candidate);
			// If the only candidate left is current, stop
			if (lruOrder.length <= 1) break;
			continue;
		}
		lruOrder.shift();
		sessionMessages.delete(candidate);
	}
}

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
	/** Monotonically increasing counter, bumped on each turn boundary.
	 *  Provides an explicit, reliable turn-boundary signal for logic that
	 *  needs to distinguish "same turn" from "new turn" (e.g. queued-flag
	 *  clearing, future turn-aware features). Reset to 0 on clearMessages. */
	turnEpoch: 0,
	/** The messageId of the current OpenCode response.  When a new event
	 *  arrives with a different messageId, that's a turn boundary.  Reset
	 *  to null on clearMessages and done. */
	currentMessageId: null as string | null,
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
export function phaseToIdle(_activity?: SessionActivity): void {
	chatState.phase = "idle";
}

/** LLM is active, awaiting first delta. */
export function phaseToProcessing(_activity?: SessionActivity): void {
	chatState.phase = "processing";
}

/** Receiving deltas — assistant message being built. */
export function phaseToStreaming(_activity?: SessionActivity): void {
	chatState.phase = "streaming";
}

/** Start event replay. */
export function phaseStartReplay(_activity?: SessionActivity): void {
	chatState.loadLifecycle = "loading";
}

/** End event replay, reconcile phase based on current phase
 *  and external processing signals.
 *  loadLifecycle stays at "committed" — renderDeferredMarkdown will
 *  transition to "ready" once all deferred markdown is rendered.
 *  If there are no deferred messages, renderDeferredMarkdown sets
 *  "ready" on its first (and only) batch.
 *  @param llmActive — whether the replayed event stream ended mid-turn */
export function phaseEndReplay(
	_activity: SessionActivity | undefined,
	llmActive: boolean,
): void {
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

const log = createFrontendLogger("chat");

/** Append a new tool message to the session's message list. */
function applyToolCreate(
	_activity: SessionActivity,
	_messages: SessionMessages,
	tool: ToolMessage,
): void {
	setMessages(_messages, [...getMessages(_messages), tool]);
}

/** Replace a tool message in the session's message list by UUID. */
function applyToolUpdate(
	_activity: SessionActivity,
	_messages: SessionMessages,
	uuid: string,
	tool: ToolMessage,
): void {
	const messages = [...getMessages(_messages)];
	const found = findMessage(messages, "tool", (m) => m.uuid === uuid);
	if (found) {
		messages[found.index] = tool;
		setMessages(_messages, messages);
	}
}

// doneMessageIds: per-session only (activity.doneMessageIds). Module-level set removed in Task 6.

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
function flushAndFinalizeAssistant(
	_activity: SessionActivity,
	_messages: SessionMessages,
): string | undefined {
	// Check the phase flag
	if (chatState.phase !== "streaming") return undefined;

	// Clear per-session renderTimer
	if (_activity?.renderTimer !== null && _activity?.renderTimer !== undefined) {
		clearTimeout(_activity.renderTimer);
		_activity.renderTimer = null;
	}
	if (chatState.currentAssistantText) {
		flushAssistantRender(_activity, _messages);
	}

	let finalizedMessageId: string | undefined;
	const { messages, found } = updateLastMessage(
		getMessages(_messages),
		"assistant",
		(m) => !m.finalized,
		(m) => {
			finalizedMessageId = m.messageId;
			return { ...m, finalized: true };
		},
	);
	if (found) setMessages(_messages, messages);

	// Clear assistant text. Phase transition is the caller's responsibility
	// (handleDone → phaseToIdle, handleToolStart → phaseToProcessing, etc.)
	chatState.currentAssistantText = "";
	return finalizedMessageId;
}

// ─── Abort hook ─────────────────────────────────────────────────────────────
// Used by ws-dispatch.ts to abort in-flight async replays when clearMessages
// is called. Avoids circular imports (ws-dispatch → chat.svelte, not vice versa).

let onClearMessages: ((sessionId: string | null) => void) | null = null;

export function registerClearMessagesHook(
	fn: (sessionId: string | null) => void,
): void {
	onClearMessages = fn;
}

// replayBatch: per-session only (messages.replayBatch). Module-level variable removed in Task 6.

export function beginReplayBatch(
	_activity?: SessionActivity,
	_messages?: SessionMessages,
): void {
	if (_messages) {
		_messages.replayBatch = [...chatState.messages];
	}
}

export function discardReplayBatch(
	_activity?: SessionActivity,
	_messages?: SessionMessages,
): void {
	if (_messages) {
		_messages.replayBatch = null;
	}
}

// ─── Replay Paging ──────────────────────────────────────────────────────────
// When a replay produces more than INITIAL_PAGE_SIZE messages, only the last
// page is committed to the session's message list. Older messages are stored
// in a per-session buffer for HistoryLoader to page through on demand.

const INITIAL_PAGE_SIZE = 50;

/** Check if a session's event cache was marked as incomplete by the server. */
export function isEventsHasMore(
	_activity: SessionActivity | undefined,
	_messages: SessionMessages | undefined,
	_sessionId: string,
): boolean {
	if (_activity) return _activity.eventsHasMore;
	return false;
}

export function getReplayBuffer(
	_activity: SessionActivity | undefined,
	_messages: SessionMessages | undefined,
	_sessionId: string,
): ChatMessage[] | undefined {
	return _messages?.replayBuffer ?? undefined;
}

export function consumeReplayBuffer(
	_activity: SessionActivity | undefined,
	_messages: SessionMessages | undefined,
	_sessionId: string,
	count: number,
): ChatMessage[] {
	const buffer = _messages?.replayBuffer;
	if (!buffer || buffer.length === 0) return [];
	const page = buffer.splice(buffer.length - count, count);
	if (buffer.length === 0) {
		if (_messages) _messages.replayBuffer = null;
	}
	// Render deferred markdown on buffered messages before they enter
	// the session's message list.  During replay, assistant messages store
	// raw text in `html` with `needsRender: true` to avoid blocking.  The
	// initial renderDeferredMarkdown() only processes the last
	// INITIAL_PAGE_SIZE messages, so buffered messages must be rendered
	// here when they're consumed for display.
	return page.map((m) => {
		if (m.type === "assistant" && m.needsRender) {
			const { needsRender: _, ...rest } = m;
			return { ...rest, html: renderMarkdown(m.rawText) };
		}
		return m;
	});
}

/**
 * @param eventsHasMore - When true, the server's event cache does not cover
 *   the full session. After the local replay buffer is exhausted, the frontend
 *   should fall through to server-based pagination for older messages.
 *   When false (default), buffer exhaustion means "beginning of session".
 */
export function commitReplayFinal(
	_activity: SessionActivity | undefined,
	_messages: SessionMessages | undefined,
	_sessionId: string,
	eventsHasMore = false,
): void {
	const batch = _messages?.replayBatch;
	if (batch === null || batch === undefined) return;
	const all = batch;
	if (_messages) _messages.replayBatch = null;

	if (all.length <= INITIAL_PAGE_SIZE) {
		chatState.messages = all;
		if (_messages) {
			_messages.historyHasMore = eventsHasMore;
		}
		historyState.hasMore = eventsHasMore;
	} else {
		const cutoff = all.length - INITIAL_PAGE_SIZE;
		const bufferSlice = all.slice(0, cutoff);
		if (_messages) _messages.replayBuffer = bufferSlice;
		chatState.messages = all.slice(cutoff);
		if (_messages) {
			_messages.historyHasMore = true;
		}
		historyState.hasMore = true;
	}
	if (eventsHasMore) {
		if (_activity) _activity.eventsHasMore = true;
	}
	chatState.loadLifecycle = "committed";
}

export function getMessages(_messages?: SessionMessages): ChatMessage[] {
	if (_messages?.replayBatch !== null && _messages?.replayBatch !== undefined) {
		return _messages.replayBatch;
	}
	return chatState.messages;
}

export function setMessages(
	_messages: SessionMessages,
	msgs: ChatMessage[],
): void {
	if (_messages?.replayBatch !== null && _messages?.replayBatch !== undefined) {
		_messages.replayBatch = msgs;
	} else {
		chatState.messages = msgs;
	}
}

// ─── Turn boundary detection ────────────────────────────────────────────────

/** Detect a turn boundary when a new messageId is seen.
 *
 *  Called from `dispatchChatEvent` for every event that carries a
 *  messageId.  When the id changes, the previous turn is finalized
 *  (if streaming), turnEpoch is bumped (clearing "Queued" shimmers),
 *  and the new messageId is recorded.
 *
 *  No-op when the messageId is the same as the current one. */
// seenMessageIds: per-session only (activity.seenMessageIds). Module-level set removed in Task 6.

export function advanceTurnIfNewMessage(
	activity: SessionActivity,
	messages: SessionMessages,
	messageId: string | undefined,
): void {
	if (messageId == null) return;

	// Already seen this messageId — just update currentMessageId (it may
	// have changed back from a different message) but don't bump epoch.
	if (activity.seenMessageIds.has(messageId)) {
		chatState.currentMessageId = messageId;
		return;
	}

	// ── First event of a genuinely new message ─────────────────────────
	activity.seenMessageIds.add(messageId);

	// Finalize any in-progress assistant streaming from the previous turn.
	if (chatState.phase === "streaming") {
		const finalizedId = flushAndFinalizeAssistant(activity, messages);
		if (finalizedId) {
			activity.doneMessageIds.add(finalizedId);
		}
		phaseToProcessing(activity);
	}

	// Bump turnEpoch — clears "Queued" shimmer on user messages sent
	// during the previous turn (sentDuringEpoch < turnEpoch).
	// Only bump if this isn't the very first message in the session.
	const prevId = chatState.currentMessageId;
	if (prevId != null) {
		chatState.turnEpoch++;
		log.debug(
			"advanceTurn NEW messageId=%s prev=%s turnEpoch=%d phase=%s",
			messageId,
			prevId,
			chatState.turnEpoch,
			chatState.phase,
		);
	} else {
		log.debug(
			"advanceTurn FIRST messageId=%s (no bump, turnEpoch=%d)",
			messageId,
			chatState.turnEpoch,
		);
	}

	chatState.currentMessageId = messageId;
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleDelta(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "delta" }>,
): void {
	const { text, messageId } = msg;

	// ── Deduplicate: skip deltas for a messageId that was already finalized ──
	// This prevents the message poller from creating a second AssistantMessage
	// for content that SSE already delivered. The poller can re-synthesize the
	// entire response when its snapshot is stale (SSE silence gap > 2s).
	if (messageId && activity.doneMessageIds.has(messageId)) {
		return;
	}

	// advanceTurnIfNewMessage (called at the dispatch level) already
	// finalized streaming and transitioned to "processing" if this delta
	// belongs to a new turn.  We just need to check the phase.
	const needsNewMessage = chatState.phase !== "streaming";

	// If no current assistant message, create one.
	if (needsNewMessage) {
		const uuid = generateUuid();
		const assistantMsg: AssistantMessage = {
			type: "assistant",
			uuid,
			rawText: "",
			html: "",
			finalized: false,
			...(messageId != null && { messageId }),
		};
		setMessages(messages, [...getMessages(messages), assistantMsg]);
		phaseToStreaming(activity);
		chatState.currentAssistantText = "";
	}

	chatState.currentAssistantText += text;

	// Debounced markdown render (80ms)
	if (activity?.renderTimer !== null && activity?.renderTimer !== undefined) {
		clearTimeout(activity.renderTimer);
	}
	const timer = setTimeout(() => {
		activity.renderTimer = null;
		flushAssistantRender(activity, messages);
	}, 80);
	activity.renderTimer = timer;
}

export function handleThinkingStart(
	_activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "thinking_start" }>,
): void {
	const now = Date.now();
	_activity.thinkingStartTime = now;
	const uuid = generateUuid();
	const thinkingMsg: ThinkingMessage = {
		type: "thinking",
		uuid,
		text: "",
		done: false,
		...(msg.messageId != null && { messageId: msg.messageId }),
	};
	setMessages(messages, [...getMessages(messages), thinkingMsg]);
}

export function handleThinkingDelta(
	_activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "thinking_delta" }>,
): void {
	const { messages: updated, found } = updateLastMessage(
		getMessages(messages),
		"thinking",
		(m) => !m.done,
		(m) => ({ ...m, text: m.text + msg.text }),
	);
	if (found) setMessages(messages, updated);
}

export function handleThinkingStop(
	_activity: SessionActivity,
	messages: SessionMessages,
	_msg: Extract<RelayMessage, { type: "thinking_stop" }>,
): void {
	const startTime = _activity.thinkingStartTime;
	const duration = startTime > 0 ? Date.now() - startTime : 0;
	_activity.thinkingStartTime = 0;

	const { messages: updated, found } = updateLastMessage(
		getMessages(messages),
		"thinking",
		(m) => !m.done,
		(m) => ({ ...m, done: true, duration }),
	);
	if (found) setMessages(messages, updated);
}

export function handleToolStart(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "tool_start" }>,
): void {
	const { id, name, messageId } = msg;

	const result = messages.toolRegistry.start(id, name || "unknown", messageId);

	if (result.action === "duplicate") {
		return;
	}

	if (result.action !== "create") {
		return;
	}

	// Finalize current assistant text before inserting tool.
	// Transition to processing — LLM is still active, just not streaming text.
	// (advanceTurnIfNewMessage already handles cross-turn finalization, but
	// same-turn tool calls still need to finalize the text block.)
	if (chatState.phase === "streaming") {
		flushAndFinalizeAssistant(activity, messages);
		phaseToProcessing(activity);
	}

	applyToolCreate(activity, messages, result.tool);
}

export function handleToolExecuting(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "tool_executing" }>,
): void {
	const result = messages.toolRegistry.executing(
		msg.id,
		msg.input,
		msg.metadata,
	);
	if (result.action === "update") {
		applyToolUpdate(activity, messages, result.uuid, result.tool);
	}
}

export function handleToolResult(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "tool_result" }>,
): void {
	const result = messages.toolRegistry.complete(
		msg.id,
		msg.content,
		msg.is_error,
		{
			...(msg.isTruncated != null && { isTruncated: msg.isTruncated }),
			...(msg.fullContentLength != null && {
				fullContentLength: msg.fullContentLength,
			}),
		},
	);
	if (result.action === "update") {
		applyToolUpdate(activity, messages, result.uuid, result.tool);
	}
}

export function handleResult(
	_activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "result" }>,
): void {
	const { usage, cost, duration } = msg;
	const messageId = "messageId" in msg ? msg.messageId : undefined;

	// ── Deduplicate result bars ─────────────────────────────────────────
	// OpenCode sends multiple message.updated events for the same assistant
	// message (first with cost/tokens, then again with duration). Instead
	// of appending a new ResultMessage each time, update the existing one
	// in-place. Only merge when the last message is a result for the SAME
	// OpenCode message (or when neither carries a messageId, for backward
	// compatibility).
	const currentMessages = getMessages(messages);
	const lastMsg = currentMessages[currentMessages.length - 1];
	if (lastMsg?.type === "result") {
		const sameMessage =
			messageId == null ||
			lastMsg.messageId == null ||
			messageId === lastMsg.messageId;
		if (sameMessage) {
			const msgs = [...currentMessages];
			const dur = duration ?? lastMsg.duration;
			msgs[msgs.length - 1] = {
				...lastMsg,
				cost: cost ?? lastMsg.cost,
				...(dur != null && { duration: dur }),
				inputTokens: usage?.input ?? lastMsg.inputTokens,
				outputTokens: usage?.output ?? lastMsg.outputTokens,
				cacheRead: usage?.cache_read ?? lastMsg.cacheRead,
				cacheWrite: usage?.cache_creation ?? lastMsg.cacheWrite,
				...(messageId != null && { messageId }),
			};
			setMessages(messages, msgs);
			// Update context usage bar
			updateContextFromTokens(messages, usage);
			return;
		}
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
		...(messageId != null && { messageId }),
	};
	setMessages(messages, [...getMessages(messages), resultMsg]);
	// Update context usage bar — dual-write: per-session + legacy
	updateContextFromTokens(messages, usage);
}

/** Compute context window usage from token counts and current model's limit. */
function updateContextFromTokens(
	messages: SessionMessages,
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
			messages.contextPercent = pct;
			return;
		}
	}
}

export function handleDone(
	activity: SessionActivity,
	messages: SessionMessages,
	_msg: Extract<RelayMessage, { type: "done" }>,
): void {
	// Finalize the assistant message and record messageId for dedup
	const finalizedId = flushAndFinalizeAssistant(activity, messages);
	if (finalizedId) {
		activity.doneMessageIds.add(finalizedId);
	}

	// Finalize any tools still in non-terminal states (pending/running).
	const finResult = messages.toolRegistry.finalizeAll(getMessages(messages));
	if (finResult.action === "finalized") {
		const msgs = [...getMessages(messages)];
		for (const idx of finResult.indices) {
			// biome-ignore lint/style/noNonNullAssertion: safe — index from finalizeAll
			const m = msgs[idx]!;
			if (m.type === "tool") {
				msgs[idx] = { ...m, status: "completed" };
			}
		}
		setMessages(messages, msgs);
	}

	// Safety net: finalize any thinking blocks still marked as !done.
	// Normal path: thinking_stop arrives before done. But if the event
	// was lost (SDK bug, network issue, Claude translator gap), this
	// prevents stuck spinners.
	{
		const msgs = getMessages(messages);
		let mutated = false;
		const patched = msgs.map((m) => {
			if (m.type === "thinking" && !m.done) {
				mutated = true;
				return { ...m, done: true, duration: 0 };
			}
			return m;
		});
		if (mutated) setMessages(messages, patched);
	}

	chatState.turnEpoch++;
	log.debug(
		"handleDone turnEpoch=%d currentMessageId=%s phase=%s",
		chatState.turnEpoch,
		chatState.currentMessageId,
		chatState.phase,
	);
	// NOTE: currentMessageId is intentionally NOT reset here. It must
	// persist so that advanceTurnIfNewMessage can compare the next turn's
	// messageId against it. Resetting to null makes every post-done turn
	// look like the first message in a fresh session, skipping turnEpoch++.
	// Only clearMessages (session switch) should reset it.

	// Request scroll before phaseToIdle so the content-change effect scrolls
	// for the finalized assistant message. Without this, phaseToIdle sets
	// phase to "idle" synchronously, so when the batched effect fires,
	// isProcessing() is false and the guard skips the scroll.
	requestScrollOnNextContent();
	phaseToIdle(activity);
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
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "status" }>,
): void {
	if (msg.status === "processing") {
		// Don't downgrade from "streaming" — it's a more specific phase.
		// status:processing from a queued message send (prompt.ts) arrives
		// while deltas are still flowing; overriding to "processing" would
		// cause handleDelta to create a new assistant message, splitting
		// the response around the queued user message.
		if (chatState.phase !== "streaming") {
			phaseToProcessing(activity);
		}
		// Fallback ONLY for REST history loads — the one path where messages
		// don't go through addUserMessage and sentDuringEpoch can't be set
		// from event ordering.  Events replay and live sends both go through
		// addUserMessage, which sets the correct sentDuringEpoch already.
		if (_pendingHistoryQueuedFallback) {
			_pendingHistoryQueuedFallback = false;
			ensureSentDuringEpochOnLastUnrespondedUser(activity, messages);
		}
	} else if (msg.status === "idle") {
		// F2 fix: full cleanup when the server says idle.
		// The server's status is authoritative — if it says idle, clean
		// up all streaming/processing state for this session.
		//
		// 1. If a live in-flight message is pending, finalize it via handleDone
		//    helper path (flushAndFinalizeAssistant).
		if (activity.currentMessageId != null && chatState.phase === "streaming") {
			flushAndFinalizeAssistant(activity, messages);
		}

		// 2. Set phase to idle
		phaseToIdle(activity);

		// 3. Clear in-flight state
		activity.currentMessageId = null;
		messages.currentAssistantText = "";
		chatState.currentAssistantText = "";
		activity.thinkingStartTime = 0;

		// 4. Drain liveEventBuffer if non-null
		if (activity.liveEventBuffer !== null) {
			activity.liveEventBuffer = null;
		}

		// 5. seenMessageIds / doneMessageIds remain (cross-turn dedup)
	}
}

/** Set `sentDuringEpoch` on the last unresponded user message if not
 *  already set.  Called ONLY after REST history loads when the session
 *  is processing — the only path where queued state can't be inferred. */
function ensureSentDuringEpochOnLastUnrespondedUser(
	_activity: SessionActivity,
	messages: SessionMessages,
): void {
	const msgs = getMessages(messages);
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
				messages,
				msgs.map((msg, idx) =>
					idx === i ? { ...msg, sentDuringEpoch: chatState.turnEpoch } : msg,
				),
			);
			return;
		}
	}
}

// ─── Scroll request flag ────────────────────────────────────────────────────
// One-shot flag consumed by the MessageList content-change $effect.
// Used when content is added that MUST trigger auto-scroll even though the
// session phase has already transitioned to idle (e.g. error messages call
// phaseToIdle synchronously, so by the time the batched effect fires,
// isProcessing() is false and the normal guard would skip the scroll).
let _scrollRequestPending = false;

/** Request that the next content-change effect triggers auto-scroll.
 *  Call before adding content that should scroll but won't be covered
 *  by the isProcessing/isSettling guard. */
export function requestScrollOnNextContent(
	_activity?: SessionActivity,
	_messages?: SessionMessages,
): void {
	_scrollRequestPending = true;
}

/** Consume and clear the scroll request. Returns true if a request was pending. */
export function consumeScrollRequest(
	_activity?: SessionActivity,
	_messages?: SessionMessages,
): boolean {
	if (_scrollRequestPending) {
		_scrollRequestPending = false;
		return true;
	}
	return false;
}

export function handleError(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "error" }>,
): void {
	const { code, message, statusCode, details } = msg;
	const errorMeta = {
		code,
		...(statusCode !== undefined ? { statusCode } : {}),
		...(details !== undefined ? { details } : {}),
	};

	if (code === "RETRY") {
		// Subtle retry message — request scroll before adding so the
		// content-change effect scrolls even though phase stays unchanged.
		requestScrollOnNextContent();
		addSystemMessage(activity, messages, message, "info");
	} else {
		// Prominent error — request scroll before phaseToIdle kills the
		// isProcessing guard that the content-change effect relies on.
		requestScrollOnNextContent();
		addSystemMessage(activity, messages, message, "error", errorMeta);
		phaseToIdle(activity);
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
	activity: SessionActivity,
	messages: SessionMessages,
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
		flushAndFinalizeAssistant(activity, messages);
		phaseToIdle(activity);
	}

	const uuid = generateUuid();
	const msg: UserMessage = {
		type: "user",
		uuid,
		text,
		...(images != null && { images }),
		...(sentWhileProcessing ? { sentDuringEpoch: chatState.turnEpoch } : {}),
	};
	if (sentWhileProcessing) {
		log.debug(
			"addUserMessage queued msg sentDuringEpoch=%d turnEpoch=%d currentMessageId=%s phase=%s",
			chatState.turnEpoch,
			chatState.turnEpoch,
			chatState.currentMessageId,
			chatState.phase,
		);
	}

	// A user message should always scroll to bottom — it's a direct user
	// action, never a background event. When the session is idle (e.g.
	// between turns), isProcessing() is false and the content-change
	// effect guard would skip the scroll without this request.
	// Skip during replay — the settle loop handles replay scrolling.
	if (chatState.loadLifecycle !== "loading") {
		requestScrollOnNextContent();
	}

	setMessages(messages, [...getMessages(messages), msg]);
}

/** Prepend older messages (from history) before existing messages.
 *  Used when paginating older messages or loading REST history. */
export function prependMessages(
	_activity: SessionActivity,
	messages: SessionMessages,
	msgs: ChatMessage[],
): void {
	if (msgs.length === 0) return;
	setMessages(messages, [...msgs, ...getMessages(messages)]);
}

/** Add a system message to the chat. */
export function addSystemMessage(
	_activity: SessionActivity,
	messages: SessionMessages,
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
	setMessages(messages, [...getMessages(messages), msg]);
}

/** Reset all chat state (for stories/tests). Alias for clearMessages. */
export const resetChatState = clearMessages;

/**
 * Flush any pending debounced assistant render immediately.
 * Called after replaying events so mid-stream content is visible.
 */
export function flushPendingRender(
	_activity?: SessionActivity,
	_messages?: SessionMessages,
): void {
	// Clear per-session renderTimer
	if (_activity?.renderTimer !== null && _activity?.renderTimer !== undefined) {
		clearTimeout(_activity.renderTimer);
		_activity.renderTimer = null;
	}
	flushAssistantRender(
		_activity as SessionActivity,
		_messages as SessionMessages,
	);
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
	_activity: SessionActivity,
	_messages: SessionMessages,
	chatMsgs: readonly ChatMessage[],
): void {
	const tools = chatMsgs.filter((m): m is ToolMessage => m.type === "tool");
	if (tools.length > 0) {
		_messages.toolRegistry.seedFromHistory(tools);
	}
}

export function clearMessages(): void {
	phaseReset(); // must be cleared before abort hook — stops replay generation check
	onClearMessages?.(sessionState.currentId); // abort in-flight async replays
	cancelDeferredMarkdown(); // abort in-flight deferred renders
	chatState.messages = [];
	chatState.currentAssistantText = "";
	chatState.turnEpoch = 0;
	chatState.currentMessageId = null;
	_pendingHistoryQueuedFallback = false;
	// Also clear per-session state for the current session
	const currentId = sessionState.currentId;
	if (currentId) {
		const activity = sessionActivity.get(currentId);
		if (activity) {
			activity.doneMessageIds.clear();
			activity.seenMessageIds.clear();
			activity.liveEventBuffer = null;
			activity.replayGeneration++;
			if (activity.renderTimer) {
				clearTimeout(activity.renderTimer);
				activity.renderTimer = null;
			}
		}
		const messages = sessionMessages.get(currentId);
		if (messages) {
			messages.replayBatch = null;
			messages.replayBuffer = null;
			messages.toolRegistry.clear();
		}
	}
	historyState.hasMore = false;
	historyState.loading = false;
	historyState.messageCount = 0;
}

// ─── Part/message removal handlers ───────────────────────────────────────────

export function handlePartRemoved(
	_activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "part_removed" }>,
): void {
	const { partId } = msg;
	if (!partId) return;
	setMessages(
		messages,
		getMessages(messages).filter((m) => m.type !== "tool" || m.id !== partId),
	);
	messages.toolRegistry.remove(partId);
}

export function handleMessageRemoved(
	_activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "message_removed" }>,
): void {
	const { messageId } = msg;
	if (!messageId) return;
	setMessages(
		messages,
		getMessages(messages).filter(
			(m) => !("messageId" in m) || m.messageId !== messageId,
		),
	);
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Flush the current assistant text to the last assistant message's HTML. */
function flushAssistantRender(
	_activity: SessionActivity,
	_messages: SessionMessages,
): void {
	if (!chatState.currentAssistantText) return;

	const rawText = chatState.currentAssistantText;
	const html =
		chatState.loadLifecycle === "loading" ? rawText : renderMarkdown(rawText);
	const isReplay = chatState.loadLifecycle === "loading";

	const { messages: updated, found } = updateLastMessage(
		getMessages(_messages),
		"assistant",
		(m) => !m.finalized,
		(m) => ({
			...m,
			rawText,
			html,
			...(isReplay ? { needsRender: true as const } : {}),
		}),
	);
	if (found) setMessages(_messages, updated);
}

// ─── Deferred Markdown Rendering ────────────────────────────────────────────
// After replay completes, messages marked with `needsRender` have raw text
// in their `html` field. renderDeferredMarkdown processes them in batches
// via requestIdleCallback/setTimeout to avoid blocking the main thread.

// deferredGeneration: per-session only (activity.replayGeneration). Module-level counter removed in Task 6.

export function cancelDeferredMarkdown(
	_activity?: SessionActivity,
	_messages?: SessionMessages,
): void {
	if (_activity) _activity.replayGeneration++;
}

export function renderDeferredMarkdown(
	_activity?: SessionActivity,
	_messages?: SessionMessages,
): void {
	if (_activity) _activity.replayGeneration++;
	const activityGen = _activity?.replayGeneration ?? 0;
	const BATCH_SIZE = 5;

	function processBatch(): void {
		// Per-session abort check
		if (_activity && _activity.replayGeneration !== activityGen) return;

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
