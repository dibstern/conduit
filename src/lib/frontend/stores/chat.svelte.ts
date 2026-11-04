// Manages chat messages, streaming state, and processing.
//
// Per-session activity follows shell rows; transcripts follow session detail.

import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type {
	SessionDetailEnvelope,
	SessionDetailWindow,
} from "../../contracts/ws-rpc.js";
import type { FeedStatus } from "../transport/supervise.js";
import type {
	ChatMessage,
	HistoryMessage,
	HistoryMessagePart,
	SessionInfo,
	SystemMessage,
	SystemMessageVariant,
	ToolMessage,
	UserMessage,
} from "../types.js";
import { generateUuid } from "../utils/format.js";
import { isSubagentToolName } from "../utils/subagent-tools.js";
import { discoveryState } from "./discovery.svelte.js";
import { getCurrentRoute } from "./router.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import { refreshSessionSkills } from "./session-skills.svelte.js";

// Tier 1 — Activity. Unbounded. Small scalars + small Sets, << 1 KB per session.
export type SessionActivity = {
	turnGeneration: number;
	endedGeneration: number;
	terminalTurnIds: ReadonlySet<string>;
	currentMessageId: string | null;
	currentPartId: string | null;
	replayGeneration: number;
	doneMessageIds: SvelteSet<string>;
	seenMessageIds: SvelteSet<string>;
	renderTimer: ReturnType<typeof setTimeout> | null;
};

// Tier 2 — Messages. LRU-capped. Holds only data safely reconstructable
// from the server's event log.
export class SessionMessages {
	messages = $state.raw<ChatMessage[]>([]);
	transcript = $state.raw<{
		window?: SessionDetailWindow | undefined;
		rows: HistoryMessage[];
		hwm: number | null;
		hasMore: boolean;
		cursor?: string;
		status: FeedStatus;
		project: string;
		/** Inputs conduit holds for the session, oldest first: the tray. */
		pending: PendingInput[];
		/** Canonical pending cut point, supplied by the session-detail stream. */
		pendingRewindMessageId?: string | null;
		/** The queue stopped draining because the last turn did not end normally. */
		paused?: boolean;
		/** Why no draft can steer now, or null when one can. Undefined until the
		 *  session's inbox arm arrives: a session that never held an input. */
		steer?: InboxState["steer"] | undefined;
		/** Parts that arrived before their message, by message id. */
		waiting: ReadonlyMap<string, HistoryMessagePart[]>;
		/** Each live part's place among its message's parts, by part id. */
		partOrder: ReadonlyMap<string, number>;
	} | null>(null);
	currentAssistantText = $state("");
	loadLifecycle = $state<LoadLifecycle>("empty");
	contextPercent = $state(0);
	historyHasMore = $state(false);
	historyLoading = $state(false);
}

type DetailItem = Extract<SessionDetailEnvelope, { _tag: "upsert" }>["item"];

/** The session-detail stream's inbox arm. */
type InboxState = Extract<DetailItem, { _tag: "inbox" }>["inbox"];

/** One `pendingInput` row of the session-detail stream. */
export type PendingInput = Extract<
	DetailItem,
	{ _tag: "pendingInput" }
>["input"];

// Composite read shape for the chat view. NEVER instantiated as storage.
export type SessionChatState = SessionActivity & SessionMessages;

// Plain factories also supply the frozen sentinels and enumerable view keys.

export function createEmptySessionActivity(): SessionActivity {
	return {
		turnGeneration: 0,
		endedGeneration: -1,
		terminalTurnIds: new Set(),
		currentMessageId: null,
		currentPartId: null,
		replayGeneration: 0,
		doneMessageIds: new SvelteSet(),
		seenMessageIds: new SvelteSet(),
		renderTimer: null,
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
				? activity[key as keyof SessionActivity]
				: messages[key as keyof SessionMessages];
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
			const value = ACTIVITY_KEYS.has(key as keyof SessionActivity)
				? activity[key as keyof SessionActivity]
				: messages[key as keyof SessionMessages];
			if (value === undefined) return undefined;
			return { value, writable: false, enumerable: true, configurable: true };
		},
	});
}

// Empty sentinels (frozen POJOs, NOT $state)

const EMPTY_ACTIVITY_RAW = createEmptySessionActivity();
const EMPTY_MESSAGES_RAW = createEmptySessionMessages();
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

/** The row's foreground, as SessionActivity answers it (CONTRACT.md 8.1): a Run, input or wake,
 *  reads processing; background tasks alone never do. */
export function getSessionPhase(id: string): ChatPhase {
	return findSession(id)?.activity?.foreground === "working"
		? "processing"
		: "idle";
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
	const sessionMessageState = new SessionMessages();
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

/** Whether the session's foreground Run is working, read from its row's activity. */
export type ChatPhase = "idle" | "processing";

export type LoadLifecycle = "empty" | "loading" | "ready";

/** The fields the legacy global mirror still exposes. */
type ChatMirror = Readonly<
	Pick<
		SessionChatState,
		"messages" | "currentAssistantText" | "loadLifecycle" | "currentMessageId"
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
	get loadLifecycle() {
		return currentChat().loadLifecycle;
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
	return loadLifecycle !== "loading" && phase === "processing";
}

const _isProcessing = $derived(
	isLlmActive(
		getSessionPhase(sessionState.currentId ?? ""),
		_currentChat.loadLifecycle,
	),
);
const _isReplaying = $derived(_currentChat.loadLifecycle === "loading");
const _isLoading = $derived(_currentChat.loadLifecycle === "loading");

/** The current session's foreground Run is working. */
export function isProcessing(): boolean {
	return _isProcessing;
}
/** Event replay in progress. */
export function isReplaying(): boolean {
	return _isReplaying;
}
/** Session data is being loaded into the chat store. */
export function isLoading(): boolean {
	return _isLoading;
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

export type LocalSend = {
	/** Null while a draft's create is in flight: that draft's pane shows it. */
	readonly sessionId: string | null;
	readonly draftId?: string | undefined;
	readonly message: UserMessage;
	/** A draft's first send: it starts its session, so the pane begins with it. */
	readonly opensSession: boolean;
};

/** Sends shown from the click until the server places them, by input id.
 *  A user message otherwise appears only once the server places it. */
export const localSends = new SvelteMap<string, LocalSend>();

/** The sends to show in a pane: `null` names the shown draft. */
export function localSendsIn(sessionId: string | null): LocalSend[] {
	const route = getCurrentRoute();
	const draftId =
		sessionId === null && route.page === "chat" ? route.draftId : undefined;
	return [...localSends.values()].filter(
		(send) => send.sessionId === sessionId && send.draftId === draftId,
	);
}

// Compatibility exports for transport consumers and the build-reload contract.
export {
	handleInputSyncReceived,
	inputSyncState,
	persistInputDraft,
	registerInputDraftPersistence,
} from "./composer-draft/runner.svelte.js";

// The mounted composer owns insertion; persistence belongs to its keyed draft runner.
let inputDraftInsert: ((text: string) => void) | undefined;
export function registerInputDraft(insert: (text: string) => void): () => void {
	inputDraftInsert = insert;
	return () => {
		if (inputDraftInsert === insert) inputDraftInsert = undefined;
	};
}

/** Append ask-reply text using the composer's normal edit and draft-sync path. */
export function insertInputDraft(text: string): void {
	inputDraftInsert?.(text);
}

/** Get the number of messages in current conversation. */
export function getMessageCount(): number {
	return currentChat().messages.length;
}

/** Append a new tool message to the session's message list. */
function _applyToolCreate(
	_activity: SessionActivity,
	_messages: SessionMessages,
	tool: ToolMessage,
): void {
	setMessages(_messages, [...getMessages(_messages), tool]);
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
 *  messageId.  When the id changes, a new turn generation starts and the
 *  new messageId is recorded.
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
	// have changed back from a different message) but start no new turn.
	if (activity.seenMessageIds.has(messageId)) {
		activity.currentMessageId = messageId;
		return;
	}

	activity.seenMessageIds.add(messageId);
	activity.turnGeneration++;
	activity.currentMessageId = messageId;
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
				contextTokens?: number;
				context_window?: number | undefined;
		  }
		| undefined,
): void {
	if (!usage) return;
	const total =
		usage.contextTokens ??
		(usage.input ?? 0) +
			(usage.output ?? 0) +
			(usage.cache_read ?? 0) +
			(usage.cache_creation ?? 0);
	if (total <= 0 && usage.contextTokens === undefined) return;
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
			message.contextTokens ??
			(message.inputTokens ?? 0) +
				(message.outputTokens ?? 0) +
				(message.cacheRead ?? 0) +
				(message.cacheWrite ?? 0);
		// Skip zero-token results (e.g. the `/compact` turn) so the walk falls
		// through to the compaction divider that carries the true post size.
		if (total <= 0 && message.contextTokens === undefined) continue;
		updateContextFromTokens(messages, {
			...(message.inputTokens != null && { input: message.inputTokens }),
			...(message.outputTokens != null && { output: message.outputTokens }),
			...(message.cacheRead != null && { cache_read: message.cacheRead }),
			...(message.cacheWrite != null && { cache_creation: message.cacheWrite }),
			...(message.contextTokens != null && {
				contextTokens: message.contextTokens,
			}),
			...(message.context_window != null && {
				context_window: message.context_window,
			}),
		});
		return;
	}
}

/** Apply durable terminal state without delivering alerts. `turnId` must be
 * turns.id (the user message id), not the provider runtime's turnId.
 * Shell idle transitions have no turn identity and use the current generation.
 * The turn projection currently has no per-turn revision. */
export function applyTerminalTurn(
	activity: SessionActivity,
	messages: SessionMessages,
	terminal?: { readonly turnId?: string },
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
	const current = getMessages(messages);
	const finalized = current.map(
		(message): ChatMessage =>
			message.type === "tool" &&
			(message.status === "pending" || message.status === "running") &&
			!isSubagentToolName(message.name)
				? { ...message, status: "completed" }
				: message,
	);
	if (finalized.some((message, i) => message !== current[i]))
		setMessages(messages, finalized);

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

	// NOTE: currentMessageId is intentionally NOT reset here. It must
	// persist so that advanceTurnIfNewMessage can compare the next turn's
	// messageId against it. Resetting to null makes every post-done turn
	// look like the first message in a fresh session.
	// Only clearMessages (session switch) should reset it.

	// The row already reads idle, so isProcessing() is false when the batched
	// content-change effect fires; request the scroll for the finalized message.
	requestScrollOnNextContent();
	return true;
}

type TurnRow = Pick<SessionInfo, "activity" | "lastTurnEndVersion">;

/** Follows the row's foreground Run (CONTRACT.md 8.1): its start opens a turn generation, and its
 *  end, or a newer reported turn end, finalizes the transcript. Idempotent, so the shell and family
 *  feeds may both report one row. */
export function followSessionTurn(
	id: string,
	next: TurnRow | undefined,
	previous: TurnRow | undefined,
): void {
	const activity = sessionActivity.get(id);
	if (!activity) return;
	if (next?.activity?.foreground === "working") {
		if (activity.endedGeneration === activity.turnGeneration)
			activity.turnGeneration++;
		return;
	}
	const turnEndVersion = next?.lastTurnEndVersion;
	if (
		previous?.activity?.foreground !== "working" &&
		(turnEndVersion ?? 0) <= (previous?.lastTurnEndVersion ?? 0)
	)
		return;
	const messages = sessionMessages.get(id);
	// Parent cancellation can idle a child without advancing its last end.
	// That end completes the new generation even if this key was seen.
	const turnId =
		turnEndVersion === undefined ? undefined : `row:${turnEndVersion}`;
	if (messages)
		applyTerminalTurn(
			activity,
			messages,
			turnId === undefined || activity.terminalTurnIds.has(turnId)
				? undefined
				: { turnId },
		);
	activity.currentMessageId = null;
	if (messages) messages.currentAssistantText = "";
	refreshSessionSkills(id);
	// seenMessageIds / doneMessageIds remain (cross-turn dedup)
}

// One-shot flag consumed by the MessageList content-change $effect.
// Used when content is added that MUST trigger auto-scroll even though the
// session already reads idle (e.g. an error message after the turn ended,
// when isProcessing() is false and the normal guard would skip the scroll).
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

/** Show a shell-row status as a transient notice, replacing the previous one;
 *  `undefined` removes it. */
function followRowNotice(
	id: string,
	text: string | undefined,
	marker: Pick<SystemMessage, "compaction" | "retry">,
	isNotice: (message: SystemMessage) => boolean,
): void {
	const messages = sessionMessages.get(id);
	if (!messages) return;
	const current = getMessages(messages);
	const settled = current.filter((m) => m.type !== "system" || !isNotice(m));
	if (text === undefined) {
		if (settled.length !== current.length) setMessages(messages, settled);
		return;
	}
	requestScrollOnNextContent();
	setMessages(messages, [
		...settled,
		{
			type: "system",
			uuid: generateUuid(),
			text,
			variant: "info",
			...marker,
			createdAt: Date.now(),
		},
	]);
}

/** Follow the shell row's compaction in progress (ni8.33, C1): show it as a
 *  transient notice. The transcript projects the outcome, which supersedes
 *  the notice once the row clears it. */
export function followSessionCompaction(
	id: string,
	compacting: string | undefined,
): void {
	followRowNotice(
		id,
		compacting,
		{ compaction: "started" },
		(m) => m.compaction === "started",
	);
}

/** Follow the shell row's provider retry (C1): its reason shows while the
 *  provider waits and leaves once the row clears it. */
export function followSessionRetry(
	id: string,
	retrying: string | undefined,
): void {
	followRowNotice(id, retrying, { retry: true }, (m) => m.retry === true);
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
		}
	}
	historyState.hasMore = false;
	historyState.loading = false;
}
