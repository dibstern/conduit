// Manages chat messages, streaming state, and processing.
//
// Two-tier per-session chat state. Handlers receive (activity, messages, event)
// and write to per-session tiers. The routePerSession dispatcher in
// ws-dispatch.ts resolves the correct session slot by event.sessionId.

import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { FeedStatus } from "../transport/supervise.js";
import type {
	ChatMessage,
	HistoryMessage,
	RelayMessage,
	SystemMessage,
	SystemMessageVariant,
	ToolMessage,
	UserMessage,
} from "../types.js";
import { generateUuid } from "../utils/format.js";
import { createFrontendLogger } from "../utils/logger.js";
import { getBrowserClientId } from "./client-identity.js";
import { discoveryState } from "./discovery.svelte.js";
import { sessionState } from "./session.svelte.js";
import { createToolRegistry, type ToolRegistry } from "./tool-registry.js";

// Tier 1 — Activity. Unbounded. Small scalars + small Sets, << 1 KB per session.
export type SessionActivity = {
	phase: ChatPhase;
	turnEpoch: number;
	turnGeneration: number;
	endedGeneration: number;
	terminalTurnIds: ReadonlySet<string>;
	currentMessageId: string | null;
	currentPartId: string | null;
	replayGeneration: number;
	doneMessageIds: SvelteSet<string>;
	seenMessageIds: SvelteSet<string>;
	renderTimer: ReturnType<typeof setTimeout> | null;
	thinkingStartTime: number;
};

// Tier 2 — Messages. LRU-capped. Holds only data safely reconstructable
// from the server's event log.
export type SessionMessages = {
	messages: ChatMessage[];
	transcript: {
		rows: HistoryMessage[];
		hwm: number | null;
		hasMore: boolean;
		cursor?: string;
		status: FeedStatus;
		project: string;
		carriedUsers: Map<
			string,
			Pick<UserMessage, "sentDuringEpoch" | "originId" | "images">
		>;
	} | null;
	currentAssistantText: string;
	loadLifecycle: LoadLifecycle;
	contextPercent: number;
	historyHasMore: boolean;
	historyLoading: boolean;
	toolRegistry: ToolRegistry;
};

// Composite read shape for the chat view. NEVER instantiated as storage.
export type SessionChatState = SessionActivity & SessionMessages;

// Factories (return plain POJOs — $state wrapping happens in getOrCreate*)

export function createEmptySessionActivity(): SessionActivity {
	return {
		phase: "idle",
		turnEpoch: 0,
		turnGeneration: 0,
		endedGeneration: -1,
		terminalTurnIds: new Set(),
		currentMessageId: null,
		currentPartId: null,
		replayGeneration: 0,
		doneMessageIds: new SvelteSet(),
		seenMessageIds: new SvelteSet(),
		renderTimer: null,
		thinkingStartTime: 0,
	};
}

export function createEmptySessionMessages(): SessionMessages {
	return {
		messages: [],
		transcript: null,
		currentAssistantText: "",
		loadLifecycle: "empty",
		contextPercent: 0,
		historyHasMore: false,
		historyLoading: false,
		toolRegistry: createToolRegistry(),
	};
}

export const ACTIVITY_KEYS: ReadonlySet<keyof SessionActivity> = new Set(
	Object.keys(createEmptySessionActivity()) as (keyof SessionActivity)[],
);

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

// Empty sentinels (frozen POJOs, NOT $state)

const EMPTY_ACTIVITY_RAW = createEmptySessionActivity();
const EMPTY_MESSAGES_RAW = createEmptySessionMessages();
const throwingRegistryStub = () => {
	throw new Error("EMPTY_MESSAGES.toolRegistry is read-only");
};
for (const methodName of Object.keys(
	EMPTY_MESSAGES_RAW.toolRegistry,
) as (keyof ToolRegistry)[]) {
	if (typeof EMPTY_MESSAGES_RAW.toolRegistry[methodName] === "function") {
		EMPTY_MESSAGES_RAW.toolRegistry[methodName] = throwingRegistryStub;
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

export const sessionActivity = new SvelteMap<string, SessionActivity>();
export const sessionMessages = new SvelteMap<string, SessionMessages>();

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

export function getOrCreateSessionActivity(id: string): SessionActivity {
	if (id === "") throw new Error("getOrCreateSessionActivity: empty sessionId");
	const existing = sessionActivity.get(id);
	if (existing) return existing;
	const activity: SessionActivity = $state(createEmptySessionActivity());
	sessionActivity.set(id, activity);
	return activity;
}

export function getOrCreateSessionMessages(id: string): SessionMessages {
	if (id === "") throw new Error("getOrCreateSessionMessages: empty sessionId");
	const existing = sessionMessages.get(id);
	if (existing) {
		touchLRU(id);
		return existing;
	}
	const sessionMessageState: SessionMessages = $state(
		createEmptySessionMessages(),
	);
	sessionMessages.set(id, sessionMessageState);
	ensureLRUCap();
	touchLRU(id);
	return sessionMessageState;
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

// LRU helpers (Tier 2 only)

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
		const candidate = lruOrder[0];
		if (candidate === undefined) break;
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

/** Type-safe search: narrows ChatMessage by discriminant, avoiding unsafe index casts. */
export function findMessage<T extends ChatMessage["type"]>(
	messages: ChatMessage[],
	type: T,
	predicate: (message: Extract<ChatMessage, { type: T }>) => boolean,
): { index: number; message: Extract<ChatMessage, { type: T }> } | undefined {
	for (const [i, message] of messages.entries()) {
		if (
			message.type === type &&
			predicate(message as Extract<ChatMessage, { type: T }>)
		) {
			return {
				index: i,
				message: message as Extract<ChatMessage, { type: T }>,
			};
		}
	}
	return undefined;
}

/** Valid chat pipeline phases. Single source of truth — the derived
 *  flags (isProcessing, isStreaming, isReplaying) derive from this value.
 *  Impossible boolean combinations are unrepresentable. */
export type ChatPhase = "idle" | "processing" | "streaming";

export type LoadLifecycle = "empty" | "loading" | "ready";

/** The six fields the legacy global mirror ever exposed. */
type ChatMirror = Readonly<
	Pick<
		SessionChatState,
		| "messages"
		| "currentAssistantText"
		| "phase"
		| "loadLifecycle"
		| "turnEpoch"
		| "currentMessageId"
	>
>;

/** Legacy global view of the current session's chat state.
 *
 *  Frozen by ni8.5 §13: this holds no storage of its own and nothing writes
 *  it — every getter resolves against `currentChat()`, i.e. the per-session
 *  slot for `sessionState.currentId`. The object is frozen, so an assignment
 *  is a compile error under `Readonly<…>` and a TypeError at runtime under
 *  strict mode. New code reads `currentChat()` directly; when the last reader
 *  has moved, delete this. */
export const chatState: ChatMirror = Object.freeze({
	get messages() {
		return currentChat().messages;
	},
	get currentAssistantText() {
		return currentChat().currentAssistantText;
	},
	get phase() {
		return currentChat().phase;
	},
	get loadLifecycle() {
		return currentChat().loadLifecycle;
	},
	get turnEpoch() {
		return currentChat().turnEpoch;
	},
	get currentMessageId() {
		return currentChat().currentMessageId;
	},
});

// Svelte 5 forbids exporting $derived directly from .svelte.ts modules.
// We expose the derived values as exported functions that return the current
// reactive value.  Call sites read them as `isProcessing()`.

/** Is the LLM working on this slot's turn? The one definition of "busy",
 *  shared by the current-session flag below and by dispatch paths that must
 *  answer the same question for a *background* session's slot. */
export function isLlmActive(
	phase: ChatPhase,
	loadLifecycle: LoadLifecycle,
): boolean {
	return (
		loadLifecycle !== "loading" &&
		(phase === "processing" || phase === "streaming")
	);
}

const _isProcessing = $derived(
	isLlmActive(_currentChat.phase, _currentChat.loadLifecycle),
);
const _isStreaming = $derived(
	_currentChat.loadLifecycle !== "loading" &&
		_currentChat.phase === "streaming",
);
const _isReplaying = $derived(_currentChat.loadLifecycle === "loading");
const _isLoading = $derived(_currentChat.loadLifecycle === "loading");

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

// Enforce valid combinations of processing/streaming/replaying.
// All production code MUST use these instead of setting booleans directly.
// Tests may still set booleans directly for arbitrary state setup.

/** Session is idle — no LLM activity, no streaming. */
export function phaseToIdle(activity: SessionActivity): void {
	activity.phase = "idle";
}

/** LLM is active, awaiting first delta. */
export function phaseToProcessing(activity: SessionActivity): void {
	if (activity.phase === "idle") {
		activity.turnGeneration++;
	}
	activity.phase = "processing";
}

/** Receiving deltas — assistant message being built. */
export function phaseToStreaming(activity: SessionActivity): void {
	if (activity.phase === "idle") {
		activity.turnGeneration++;
	}
	activity.phase = "streaming";
}

/** End the visible turn on socket close through the same idempotent reducer.
 * Background sessions retain their phase until server reconciliation. */
export function phaseCurrentSessionToIdle(): void {
	const id = sessionState.currentId;
	if (id === null) return;
	const activity = sessionActivity.get(id);
	const messages = sessionMessages.get(id);
	if (!activity || !messages) return;
	if (activity.phase === "idle") return;
	applyTerminalTurn(activity, messages);
}

/** Pagination state for history loading (shared between HistoryLoader and dispatch). */
export const historyState = $state({
	/** Whether there are more history pages to fetch from the server.
	 *  Defaults to false (disarmed). Set to true only when the server
	 *  explicitly says there are more pages. */
	hasMore: false,
	/** Whether a history page request is in-flight. */
	loading: false,
});

// Tracks the last input text received from another tab viewing the same session.

export const inputSyncState = $state({
	/** The synced input text. */
	text: "",
	/** Client ID that originated the sync (empty string if unknown). */
	lastFrom: "",
	/** Timestamp of the last sync update (monotonic, for change detection). */
	lastUpdated: 0,
	/** A reconnect's older server draft must not replace text being saved. */
	reloadPending: false,
});

let persistInputDraftHook: (() => Promise<boolean>) | undefined;

/** The mounted composer flushes its latest text through existing draft sync. */
export function registerInputDraftPersistence(
	persist: () => Promise<boolean>,
): () => void {
	persistInputDraftHook = persist;
	return () => {
		if (persistInputDraftHook === persist) persistInputDraftHook = undefined;
	};
}

/** False defers reload to keep pending attachments in the mounted composer. */
export async function persistInputDraft(): Promise<boolean> {
	return (await persistInputDraftHook?.()) ?? true;
}

/** Handle an incoming input_sync message from another tab. */
export function handleInputSyncReceived(msg: {
	text?: string | undefined;
	from?: string | undefined;
}): void {
	inputSyncState.text = msg.text ?? "";
	inputSyncState.lastFrom = msg.from ?? "";
	inputSyncState.lastUpdated = Date.now();
}

/** Get the number of messages in current conversation. */
export function getMessageCount(): number {
	return currentChat().messages.length;
}

const log = createFrontendLogger("chat");

/** Append a new tool message to the session's message list. */
function _applyToolCreate(
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

/**
 * Walk messages backward, find the last one matching `type` and `predicate`,
 * apply `updater`. Returns the new array and whether a match was found.
 * Pure — does not touch reactive state. */
export function updateLastMessage<T extends ChatMessage["type"]>(
	messages: readonly ChatMessage[],
	type: T,
	predicate: (message: Extract<ChatMessage, { type: T }>) => boolean,
	updater: (message: Extract<ChatMessage, { type: T }>) => ChatMessage,
): { messages: ChatMessage[]; found: boolean } {
	const out = [...messages];
	for (let i = out.length - 1; i >= 0; i--) {
		const message = out[i];
		if (message === undefined) continue;
		if (
			message.type === type &&
			predicate(message as Extract<ChatMessage, { type: T }>)
		) {
			out[i] = updater(message as Extract<ChatMessage, { type: T }>);
			return { messages: out, found: true };
		}
	}
	return { messages: out, found: false };
}

/** Finalize the current assistant part and reset streaming state.
 *  Returns its `messageId` (if any) for dedup tracking. */
function flushAndFinalizeAssistant(
	_activity: SessionActivity,
	_messages: SessionMessages,
): string | undefined {
	// Clear per-session renderTimer
	if (_activity?.renderTimer !== null && _activity?.renderTimer !== undefined) {
		clearTimeout(_activity.renderTimer);
		_activity.renderTimer = null;
	}

	let finalizedMessageId: string | undefined;
	const currentPartId = _activity.currentPartId;
	const { messages, found } = updateLastMessage(
		getMessages(_messages),
		"assistant",
		(m) =>
			!m.finalized && (currentPartId == null || m.partId === currentPartId),
		(m) => {
			finalizedMessageId = m.messageId;
			return { ...m, finalized: true };
		},
	);
	if (found) setMessages(_messages, messages);

	// Phase transition is the caller's responsibility.
	_messages.currentAssistantText = "";
	_activity.currentPartId = null;
	return finalizedMessageId;
}

export function getMessages(messages?: SessionMessages): ChatMessage[] {
	return messages?.messages ?? [];
}

export function setMessages(
	messages: SessionMessages,
	msgs: ChatMessage[],
): void {
	messages.messages = msgs;
}

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
	partId?: string,
): void {
	if (messageId == null) return;

	if (partId != null) {
		const currentMessages = getMessages(messages);
		for (let i = currentMessages.length - 1; i >= 0; i--) {
			const message = currentMessages[i];
			if (message === undefined) continue;
			if (message.type === "assistant" && message.partId === partId) {
				activity.seenMessageIds.add(messageId);
				break;
			}
		}
	}

	// Already seen this messageId — just update currentMessageId (it may
	// have changed back from a different message) but don't bump epoch.
	if (activity.seenMessageIds.has(messageId)) {
		activity.currentMessageId = messageId;
		return;
	}

	activity.seenMessageIds.add(messageId);
	const previousTurnAlreadyEnded =
		activity.endedGeneration === activity.turnGeneration;
	activity.turnGeneration++;

	// Finalize any in-progress assistant streaming from the previous turn.
	if (activity.phase === "streaming") {
		const finalizedId = flushAndFinalizeAssistant(activity, messages);
		if (finalizedId) {
			activity.doneMessageIds.add(finalizedId);
		}
		phaseToProcessing(activity);
	}

	// Bump turnEpoch — clears "Queued" shimmer on user messages sent
	// during the previous turn (sentDuringEpoch < turnEpoch).
	// A terminal event may already have released the previous turn's queue.
	// Only infer a missing boundary when it has not been applied yet. Do not
	// require having seen the previous reply: a tab that joined mid-turn never
	// did, and Claude starts a queued prompt's reply without ending the turn.
	if (!previousTurnAlreadyEnded) {
		activity.turnEpoch++;
		log.debug(
			"advanceTurn NEW messageId=%s prev=%s turnEpoch=%d phase=%s",
			messageId,
			activity.currentMessageId,
			activity.turnEpoch,
			activity.phase,
		);
	}

	activity.currentMessageId = messageId;
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

export function handleToolExecuting(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "tool_executing" }>,
): void {
	let result = messages.toolRegistry.executing(msg.id, msg.input, msg.metadata);
	// If executing() rejected because the tool is already running,
	// fall back to updateMetadata() for metadata-only updates
	// (e.g. subagent sessionId arriving after initial running event).
	if (result.action === "reject" && msg.metadata) {
		result = messages.toolRegistry.updateMetadata(msg.id, msg.metadata);
	}
	if (result.action === "update") {
		applyToolUpdate(activity, messages, result.uuid, result.tool);
	}
}

/** Compute context usage from token counts and the turn's effective window,
 *  falling back to the current model limit for legacy result messages. */
function updateContextFromTokens(
	messages: SessionMessages,
	usage:
		| {
				input?: number;
				output?: number;
				cache_read?: number;
				cache_creation?: number;
				context_window?: number | undefined;
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
	const limit =
		typeof usage.context_window === "number" &&
		Number.isFinite(usage.context_window) &&
		usage.context_window > 0
			? usage.context_window
			: currentContextLimit();
	if (limit) {
		// Clamp: context occupancy can never exceed the window; >100 means
		// stale aggregate token data (pre-fix history rows).
		messages.contextPercent = Math.min(100, Math.round((total / limit) * 100));
	}
}

/** Resolve the effective context limit: the selected context-window override
 *  ("200k" / "1m") wins over the model's default limit. */
function currentContextLimit(): number | undefined {
	const override = discoveryState.currentContextWindow;
	if (override === "1m") return 1_000_000;
	if (override === "200k") return 200_000;
	const modelId = discoveryState.currentModelId;
	if (!modelId) return undefined;
	for (const p of discoveryState.providers) {
		const model = p.models.find((m) => m.id === modelId);
		if (model?.limit?.context) return model.limit.context;
	}
	return undefined;
}

/** Restore the context usage bar from the projected transcript. */
export function restoreContextFromMessages(messages: SessionMessages): void {
	const msgs = getMessages(messages);
	for (let i = msgs.length - 1; i >= 0; i--) {
		const message = msgs[i];
		// A compaction divider defines context size when it is the most recent
		// context-defining event (i.e. no real turn ran after `/compact`). The
		// `/compact` turn itself reports 0 tokens, so its result is skipped below.
		if (message?.type === "system" && typeof message.postTokens === "number") {
			const limit = currentContextLimit();
			if (limit !== undefined) {
				messages.contextPercent = Math.min(
					100,
					Math.round((message.postTokens / limit) * 100),
				);
			}
			return;
		}
		if (message?.type !== "result") continue;
		const total =
			(message.inputTokens ?? 0) +
			(message.outputTokens ?? 0) +
			(message.cacheRead ?? 0) +
			(message.cacheWrite ?? 0);
		// Skip zero-token results (e.g. the `/compact` turn) so the walk falls
		// through to the compaction divider that carries the true post size.
		if (total <= 0) continue;
		updateContextFromTokens(messages, {
			...(message.inputTokens != null && { input: message.inputTokens }),
			...(message.outputTokens != null && { output: message.outputTokens }),
			...(message.cacheRead != null && { cache_read: message.cacheRead }),
			...(message.cacheWrite != null && { cache_creation: message.cacheWrite }),
			...(message.context_window != null && {
				context_window: message.context_window,
			}),
		});
		return;
	}
}

export function handleDone(
	activity: SessionActivity,
	messages: SessionMessages,
	_msg: Extract<RelayMessage, { type: "done" }>,
): void {
	applyTerminalTurn(activity, messages);
}

/** Apply durable terminal state without delivering alerts. `turnId` must be
 * turns.id (the user message id), not the provider runtime's turnId.
 * Legacy push events lack that identity; their fallback identifies the
 * current monotone generation, not an old envelope.
 * The turn projection currently has no per-turn revision. */
export function applyTerminalTurn(
	activity: SessionActivity,
	messages: SessionMessages,
	terminal?: {
		readonly turnId?: string;
		readonly error?: Extract<RelayMessage, { type: "error" }>;
	},
): boolean {
	if (terminal?.turnId !== undefined) {
		if (activity.terminalTurnIds.has(terminal.turnId)) return false;
		// Bound replay dedup to recent turns. An evicted id costs at worst one
		// redundant idempotent re-finalize, never a stuck session.
		activity.terminalTurnIds = new Set(
			[...activity.terminalTurnIds, terminal.turnId].slice(-8),
		);
	} else if (activity.endedGeneration === activity.turnGeneration) {
		return false;
	}
	activity.endedGeneration = activity.turnGeneration;

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
			const message = msgs[idx];
			if (message === undefined) continue;
			if (message.type === "tool") {
				msgs[idx] = { ...message, status: "completed" };
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

	if (terminal?.error) {
		const { code, message, statusCode, details } = terminal.error;
		addSystemMessage(activity, messages, message, "error", {
			code,
			...(statusCode !== undefined ? { statusCode } : {}),
			...(details !== undefined ? { details } : {}),
		});
	}

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
	activity.turnEpoch++;
	phaseToIdle(activity);
	return true;
}

export function handleStatus(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "status" }>,
): void {
	if (msg.status === "processing") {
		// Don't downgrade from "streaming" — it's a more specific phase.
		// A queued send can report processing while a projected row streams.
		if (activity.phase !== "streaming") {
			phaseToProcessing(activity);
		}
	} else if (msg.status === "idle") {
		if (activity.phase !== "idle") {
			applyTerminalTurn(activity, messages);
		}

		activity.currentMessageId = null;
		messages.currentAssistantText = "";
		activity.thinkingStartTime = 0;

		// seenMessageIds / doneMessageIds remain (cross-turn dedup)
	}
}

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
	if (msg.code === "RETRY") {
		requestScrollOnNextContent();
		addSystemMessage(activity, messages, msg.message, "info");
	} else {
		applyTerminalTurn(activity, messages, { error: msg });
	}
}

export function handleCompaction(
	_activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "compaction" }>,
): void {
	requestScrollOnNextContent();
	const notice: SystemMessage = {
		type: "system",
		uuid: generateUuid(),
		text: msg.detail,
		variant: msg.state === "failed" ? "error" : "info",
		compaction: msg.state,
		...(msg.preTokens !== undefined ? { preTokens: msg.preTokens } : {}),
		...(msg.postTokens !== undefined ? { postTokens: msg.postTokens } : {}),
		createdAt: Date.now(),
	};
	// The outcome supersedes the "Compacting…" notice rather than stacking under it.
	const kept =
		msg.state === "started"
			? getMessages(messages)
			: getMessages(messages).filter(
					(m) => m.type !== "system" || m.compaction !== "started",
				);
	setMessages(messages, [...kept, notice]);

	if (
		msg.state === "completed" &&
		typeof msg.postTokens === "number" &&
		msg.postTokens > 0
	) {
		const limit = currentContextLimit();
		if (limit !== undefined) {
			messages.contextPercent = Math.min(
				100,
				Math.round((msg.postTokens / limit) * 100),
			);
		}
	}
}

// Keep per-origin FIFO entries even when a provisional bubble is removed.
const pendingUserMessages = new WeakMap<SessionMessages, Map<string, string>>();

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
	messageId?: string,
	isOwnMessage = true,
	originId = isOwnMessage ? getBrowserClientId() : undefined,
): void {
	if (messageId) {
		const current = getMessages(messages);
		if (
			current.some(
				(message) => message.type === "user" && message.messageId === messageId,
			)
		)
			return;
		const pendingIds = pendingUserMessages.get(messages);
		const pendingId = originId
			? [...(pendingIds ?? [])].find(([, origin]) => origin === originId)?.[0]
			: undefined;
		if (pendingId) pendingIds?.delete(pendingId);
		const pending = current.find(
			(message) =>
				message.type === "user" &&
				!message.messageId &&
				message.uuid === pendingId,
		);
		if (pending?.type === "user" && pending.text === text) {
			setMessages(
				messages,
				current.map((message) =>
					message.uuid === pending.uuid ? { ...pending, messageId } : message,
				),
			);
			return;
		}
	}
	// Finalize the in-progress assistant message only during replay,
	// where user_message events can appear between delta events without
	// an intervening done event.  During live streaming the assistant
	// message stays unfinalized so subsequent deltas continue updating
	// it and the queued user message stays at the end.
	if (!sentWhileProcessing && messages.currentAssistantText) {
		flushAndFinalizeAssistant(activity, messages);
		phaseToIdle(activity);
	}

	const uuid = generateUuid();
	if (originId && !messageId) {
		const pendingIds =
			pendingUserMessages.get(messages) ?? new Map<string, string>();
		pendingIds.set(uuid, originId);
		pendingUserMessages.set(messages, pendingIds);
	}
	const msg: UserMessage = {
		type: "user",
		uuid,
		...(messageId != null && { messageId }),
		...(originId != null && { originId }),
		text,
		createdAt: Date.now(),
		...(images != null && { images }),
		...(sentWhileProcessing ? { sentDuringEpoch: activity.turnEpoch } : {}),
	};
	if (sentWhileProcessing) {
		log.debug(
			"addUserMessage queued msg sentDuringEpoch=%d turnEpoch=%d currentMessageId=%s phase=%s",
			activity.turnEpoch,
			activity.turnEpoch,
			activity.currentMessageId,
			activity.phase,
		);
	}

	// A user message should always scroll to bottom — it's a direct user
	// action, never a background event. When the session is idle (e.g.
	// between turns), isProcessing() is false and the content-change
	// effect guard would skip the scroll without this request.
	// Skip while the transcript is loading; its ready transition handles scrolling.
	if (messages.loadLifecycle !== "loading") {
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

/** Sync the tool registry with projected transcript tools so retained tool
 *  events can update them. */
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

export function activateSessionChatState(sessionId: string): void {
	const messages = sessionMessages.get(sessionId);

	historyState.hasMore = messages?.historyHasMore ?? false;
	historyState.loading = messages?.historyLoading ?? false;
}

/**
 * Clear all messages (e.g. on session switch).
 *
 * Reads reactive `sessionState.currentId`, so a direct call from an `$effect`
 * body would subscribe that effect to session changes and can loop. Call it
 * from event callbacks or inside `untrack()`, as ChatLayout does.
 */
export function clearMessages(): void {
	// Also clear per-session state for the current session
	const currentId = sessionState.currentId;
	if (currentId) {
		const activity = sessionActivity.get(currentId);
		if (activity) {
			activity.phase = "idle";
			activity.turnEpoch = 0;
			activity.turnGeneration = 0;
			activity.endedGeneration = -1;
			activity.terminalTurnIds = new Set();
			activity.currentMessageId = null;
			activity.currentPartId = null;
			activity.doneMessageIds.clear();
			activity.seenMessageIds.clear();
			activity.replayGeneration++;
			if (activity.renderTimer) {
				clearTimeout(activity.renderTimer);
				activity.renderTimer = null;
			}
		}
		const messages = sessionMessages.get(currentId);
		if (messages) {
			messages.messages = [];
			messages.currentAssistantText = "";
			messages.loadLifecycle = "empty";
			messages.toolRegistry.clear();
		}
	}
	historyState.hasMore = false;
	historyState.loading = false;
}
