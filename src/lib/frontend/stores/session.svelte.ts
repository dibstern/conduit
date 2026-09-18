// ─── Session Store ───────────────────────────────────────────────────────────
// Server-owned session rows on one side, this tab's selection and search on
// the other. The two halves never write each other.

import { SvelteMap } from "svelte/reactivity";
import type { ListSessionsResponse } from "../transport/ws-rpc.js";
import {
	type CreateSessionRpcInput,
	createSessionRpc,
	getAgentsRpc,
	getCommandsRpc,
	getModelsRpc,
	switchPermissionModeRpc,
	type ViewSessionRpcInput,
	viewSessionRpc,
} from "../transport/ws-rpc-client.js";
import type {
	DateGroups,
	Immutable,
	RelayMessage,
	RequestId,
	SessionInfo,
} from "../types.js";
import {
	abortSessionReplay,
	activateSessionChatState,
	clearSessionChatState,
} from "./chat.svelte.js";
import { getBrowserClientId } from "./client-identity.js";
import {
	applyGetAgentsResponse,
	applyGetCommandsResponse,
	applyGetModelsResponse,
	flushPendingPermissionMode,
	getEffectiveInstanceId,
} from "./discovery.svelte.js";
import { getCurrentSlug, navigate } from "./router.svelte.js";
import { uiState } from "./ui.svelte.js";

// ─── Server-owned state ─────────────────────────────────────────────────────
// Every session the server has told us about, keyed by id — one representation,
// not a map plus two arrays kept in step by hand. The `applySession*` functions
// below are the only writers, and every row they store is a whole `SessionInfo`
// straight off the wire. Nothing outside this module can write it: `sessionState`
// hands it out as a `ReadonlyMap`.

const serverSessions = new SvelteMap<string, SessionInfo>();

// ─── Client-owned state ─────────────────────────────────────────────────────
// What this tab is looking at. Applying server rows never touches it.

const clientSession = $state({
	currentId: null as string | null,
	searchQuery: "",
	/** Ids the last server search matched, or null when no search is running.
	 *  Ids rather than rows, so a session renamed or deleted mid-search follows
	 *  the server half instead of a snapshot that nothing updates. */
	searchMatchIds: null as string[] | null,
});

/** Read view over both halves. The server half is read-only by type; the
 *  client half is a plain setting. */
export const sessionState = {
	/** Server-owned. Write through `applySessionSnapshot`, `applySessionUpsert`
	 *  or `applySessionRemoved`. */
	get sessions(): ReadonlyMap<string, Immutable<SessionInfo>> {
		return serverSessions;
	},
	get currentId(): string | null {
		return clientSession.currentId;
	},
	set currentId(id: string | null) {
		clientSession.currentId = id;
	},
	get searchQuery(): string {
		return clientSession.searchQuery;
	},
	set searchQuery(query: string) {
		setSearchQuery(query);
	},
	get searchMatchIds(): readonly string[] | null {
		return clientSession.searchMatchIds;
	},
};

// ─── Session Creation State Machine ──────────────────────────────────────────
// Guards the new-session flow with typed phases. Prevents double-clicks,
// tracks in-flight creation for button state, and handles timeout.
//
// Uses a { value: T } wrapper because Svelte 5's $state creates a reactive
// proxy — you can't reassign a top-level $state variable, only mutate its
// properties. The wrapper lets us swap the entire discriminated union cleanly
// without Object.assign/delete hacks.

/** Exported for tests — avoids magic numbers. */
export const NEW_SESSION_TIMEOUT_MS = 5000;
/** Exported for tests — avoids magic numbers. */
export const ERROR_DISPLAY_MS = 2000;

export type SessionCreationStatus =
	| { phase: "idle" }
	| { phase: "creating"; requestId: RequestId; startedAt: number }
	| { phase: "error"; message: string; requestId: RequestId };

export const sessionCreation = $state<{ value: SessionCreationStatus }>({
	value: { phase: "idle" },
});

/** Active timeout timer — cleared on completion or reset. */
let _creationTimer: ReturnType<typeof setTimeout> | null = null;
let _errorResetTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
	if (_creationTimer) {
		clearTimeout(_creationTimer);
		_creationTimer = null;
	}
	if (_errorResetTimer) {
		clearTimeout(_errorResetTimer);
		_errorResetTimer = null;
	}
}

/**
 * Create a branded RequestId from crypto.randomUUID().
 * Frontend-only — the server receives and echoes RequestIds, never creates them.
 */
function createRequestId(): RequestId {
	return crypto.randomUUID() as RequestId;
}

/**
 * Transition idle -> creating. Returns the requestId, or null if not idle.
 * Starts a timeout that auto-fails after NEW_SESSION_TIMEOUT_MS.
 */
export function requestNewSession(): RequestId | null {
	if (sessionCreation.value.phase !== "idle") return null;
	const requestId = createRequestId();
	sessionCreation.value = {
		phase: "creating",
		requestId,
		startedAt: Date.now(),
	};

	// Timeout: auto-fail if server doesn't respond.
	// Lives in the store (not a component $effect) so it works regardless
	// of which UI panel is visible.
	clearTimers();
	_creationTimer = setTimeout(() => {
		_creationTimer = null;
		if (
			sessionCreation.value.phase === "creating" &&
			sessionCreation.value.requestId === requestId
		) {
			failNewSession(requestId, "Session creation timed out");
		}
	}, NEW_SESSION_TIMEOUT_MS);

	return requestId;
}

/**
 * Transition creating -> idle when requestId matches (server confirmed).
 */
export function completeNewSession(requestId: string): void {
	if (sessionCreation.value.phase !== "creating") return;
	if (sessionCreation.value.requestId !== requestId) return;
	clearTimers();
	sessionCreation.value = { phase: "idle" };
}

/**
 * Transition creating -> error. Auto-resets to idle after ERROR_DISPLAY_MS.
 */
export function failNewSession(requestId: string, message: string): void {
	if (sessionCreation.value.phase !== "creating") return;
	if (sessionCreation.value.requestId !== requestId) return;
	clearTimers();
	sessionCreation.value = {
		phase: "error",
		message,
		requestId: requestId as RequestId,
	};

	// Auto-reset to idle after the error is displayed
	_errorResetTimer = setTimeout(() => {
		_errorResetTimer = null;
		if (sessionCreation.value.phase === "error") {
			sessionCreation.value = { phase: "idle" };
		}
	}, ERROR_DISPLAY_MS);
}

/**
 * Reset to idle from any phase. Clears all timers.
 */
export function resetSessionCreation(): void {
	clearTimers();
	sessionCreation.value = { phase: "idle" };
}

/**
 * Guard + send in one call. Returns the requestId, or null if already creating.
 * Both Sidebar and SessionList call this — centralizes the guard and payload
 * shape so they can't diverge.
 */
export function sendNewSession(
	start?: (input: CreateSessionRpcInput) => void,
): RequestId | null {
	const requestId = requestNewSession();
	if (!requestId) return null;
	const projectSlug = getCurrentSlug();
	if (!projectSlug) {
		failNewSession(requestId, "No active project");
		return requestId;
	}
	const input: CreateSessionRpcInput = {
		projectSlug,
		requestId,
		originId: getBrowserClientId(),
		// Bind the session to the selected harness instance (replaces the
		// legacy implicit default-model-provider derivation).
		instanceId: getEffectiveInstanceId(),
	};
	if (start) {
		start(input);
	} else {
		void createSessionRpc(input).catch((error: unknown) =>
			failNewSession(
				requestId,
				error instanceof Error ? error.message : String(error),
			),
		);
	}
	return requestId;
}

// ─── Applying server rows ───────────────────────────────────────────────────
// The only door into the server half.

/** What a snapshot of the session list covers. */
export type SessionSnapshotScope =
	/** Every session the server has: a row it omits has been removed. */
	| "complete"
	/** Part of the list: a row it omits says nothing. */
	| "partial";

/** Apply a snapshot of the session list.
 *
 *  Only a `"complete"` snapshot reaps. A roots-only or search snapshot does
 *  not, because a session we hold may be a child that has not learned its
 *  `parentID` yet, and its absence from a roots list is not a deletion. */
export function applySessionSnapshot(
	rows: readonly SessionInfo[],
	scope: SessionSnapshotScope,
): void {
	if (scope === "complete") {
		const incoming = new Set(rows.map((row) => row.id));
		for (const id of [...serverSessions.keys()]) {
			if (!incoming.has(id)) forgetSession(id);
		}
	}
	for (const row of rows) serverSessions.set(row.id, row);
}

/** Apply a single session row the server has created or changed. */
export function applySessionUpsert(row: SessionInfo): void {
	serverSessions.set(row.id, row);
}

/** Apply a session the server has deleted. */
export function applySessionRemoved(id: string): void {
	forgetSession(id);
}

/** Drop our copy of a session and the chat state hanging off it. */
function forgetSession(id: string): void {
	serverSessions.delete(id);
	clearSessionChatState(id);
	// A session that is gone cannot still be the one we are looking at. The
	// selection is what makes a session routable before its row arrives, so
	// leaving it behind lets a late event rebuild the chat state we just threw
	// away — and deleting the last session leaves no other for the server to
	// switch us to, so nothing else would clear it.
	if (clientSession.currentId === id) clientSession.currentId = null;
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleSessionList(
	msg: Extract<RelayMessage, { type: "session_list" }>,
): void {
	const { sessions, roots, search } = msg;
	if (!Array.isArray(sessions)) return;

	if (search) {
		applySessionSnapshot(sessions, "partial");
		clientSession.searchMatchIds = sessions.map((s) => s.id);
		return;
	}
	// An untagged list (legacy sources) carries a mixed bag of roots and
	// children, so like a roots:false list it covers everything.
	applySessionSnapshot(sessions, roots === true ? "partial" : "complete");
}

export function applyListSessionsResponse(
	response: ListSessionsResponse,
): void {
	// The RPC decodes into the same session type the WebSocket message carries
	// (ni8.5 T-1), so the sessions go straight through.
	handleSessionList({
		type: "session_list",
		sessions: [...response.sessions],
		roots: response.roots,
		...(response.search ? { search: true } : {}),
	});
}

export function handleSessionSwitched(
	msg: Extract<RelayMessage, { type: "session_switched" }>,
): void {
	const { id, requestId } = msg;
	if (id) {
		clientSession.currentId = id;
		// `session_switched` can beat the list that contains the session, so it
		// carries the parent itself. Patch the row if we hold one; never invent
		// one — the list will carry the same lineage when it lands.
		const known = msg.parentID ? serverSessions.get(id) : undefined;
		if (known && msg.parentID) {
			applySessionUpsert({ ...known, parentID: msg.parentID });
		}
		// A permission mode selected before any session was bound can only be
		// delivered now that we know the session id.
		const slug = getCurrentSlug();
		if (slug) {
			flushPendingPermissionMode(slug, id, switchPermissionModeRpc);
		}
	}
	// Co-located: complete the creation state machine if this session_switched
	// is the response to our CreateSession RPC request. This is inside
	// handleSessionSwitched (not in the dispatch switch) so it can't be
	// accidentally separated from the state update.
	if (requestId) {
		completeNewSession(requestId);
	}
}

/** Handle a session_forked message — the server created a new session. */
export function handleSessionForked(
	msg: Extract<RelayMessage, { type: "session_forked" }>,
): void {
	applySessionUpsert(msg.session);
}

// ─── Reading the session list ───────────────────────────────────────────────
// Components should wrap these in $derived() for reactive caching.

/** Find a session by id. */
export function findSession(id: string): Immutable<SessionInfo> | undefined {
	return serverSessions.get(id);
}

// ─── Notification views (ni8.23) ────────────────────────────────────────────
// Three facts the server derives onto the row: how many questions and
// permissions are unanswered, and whether a message landed since the session was
// last looked at. These are reads over the server-owned half — there is no
// client-side notification state left to drift out of step with them, and a
// client that reconnects gets the truth in its snapshot rather than rebuilding a
// guess from events it may have missed.

/** What the sidebar dot should show for a session, if anything. */
export function getSessionIndicator(
	sessionId: string,
	currentSessionId: string | null,
): "attention" | "done-unviewed" | null {
	// Tab-local by design: a session cannot be waiting on you while it is the one
	// on your screen, and which one that is differs per browser tab, so the
	// server cannot answer it (ni8.23 C3).
	if (sessionId === currentSessionId) return null;
	const session = serverSessions.get(sessionId);
	if (session === undefined) return null;
	if (
		(session.pendingQuestions ?? 0) > 0 ||
		(session.pendingPermissions ?? 0) > 0
	)
		return "attention";
	return session.unseenActivity === true ? "done-unviewed" : null;
}

/** Every session waiting on an answer, for the attention banner. Excludes the
 *  session on screen and its descendants — their prompts are already visible. */
export function getAttentionSessions(
	currentSessionId: string | null,
	getDescendantIds: (sessionId: string) => Set<string>,
): Map<string, { questions: number; permissions: number }> {
	const descendants = currentSessionId
		? getDescendantIds(currentSessionId)
		: new Set<string>();
	const waiting = new Map<string, { questions: number; permissions: number }>();
	for (const [sessionId, session] of serverSessions) {
		if (sessionId === currentSessionId || descendants.has(sessionId)) continue;
		const questions = session.pendingQuestions ?? 0;
		const permissions = session.pendingPermissions ?? 0;
		if (questions > 0 || permissions > 0)
			waiting.set(sessionId, { questions, permissions });
	}
	return waiting;
}

/** When a session last changed, as the sidebar means it. */
function lastChangedAt(session: Immutable<SessionInfo>): number {
	// `||`, not `??`: a provider that has never touched a session sends `0` or
	// `""` as readily as it omits the field, and all three mean the same thing
	// — exactly as the line below reads a missing timestamp as 0.
	const at = session.updatedAt || session.createdAt;
	return at ? new Date(at).getTime() : 0;
}

/** The sessions the sidebar should show, most recently changed first.
 *  Subagent sessions (those with a parentID) are excluded when the
 *  hideSubagentSessions UI toggle is active (default). */
export function getFilteredSessions(): readonly Immutable<SessionInfo>[] {
	const matchIds = clientSession.searchMatchIds;
	if (matchIds !== null) {
		// Resolve against the server half so a session renamed or deleted while
		// the search is up follows the server, in the order the server matched.
		return matchIds.flatMap((id) => {
			const session = serverSessions.get(id);
			return session ? [session] : [];
		});
	}

	const query = clientSession.searchQuery.toLowerCase().trim();
	return [...serverSessions.values()]
		.filter(
			(s) =>
				!(uiState.hideSubagentSessions && s.parentID) &&
				(!query || s.title.toLowerCase().includes(query)),
		)
		.sort((a, b) => lastChangedAt(b) - lastChangedAt(a));
}

/** Get sessions grouped by date: today, yesterday, older. */
export function getDateGroups(): DateGroups {
	return groupSessionsByDate(getFilteredSessions());
}

/** Get the currently active session object (or undefined). */
export function getActiveSession(): Immutable<SessionInfo> | undefined {
	return findSession(clientSession.currentId ?? "");
}

/** Group sessions into today/yesterday/older buckets. */
export function groupSessionsByDate(
	sessions: readonly Immutable<SessionInfo>[],
	now?: Date,
): DateGroups {
	const ref = now ?? new Date();
	const todayStart = new Date(ref);
	todayStart.setHours(0, 0, 0, 0);
	const yesterdayStart = new Date(todayStart);
	yesterdayStart.setDate(yesterdayStart.getDate() - 1);

	const groups: DateGroups = { today: [], yesterday: [], older: [] };

	for (const s of sessions) {
		const updated = lastChangedAt(s);
		if (updated >= todayStart.getTime()) {
			groups.today.push(s);
		} else if (updated >= yesterdayStart.getTime()) {
			groups.yesterday.push(s);
		} else {
			groups.older.push(s);
		}
	}

	return groups;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Set the sidebar filter. Clearing it also drops any server search matches —
 *  an empty query has nothing to match. */
export function setSearchQuery(query: string): void {
	clientSession.searchQuery = query;
	if (!query.trim()) clientSession.searchMatchIds = null;
}

export function setCurrentSession(id: string | null): void {
	clientSession.currentId = id;
}

/**
 * The session ID we are switching *away from*.  Captured here before
 * `currentId` is overwritten so that `ws-dispatch` can pass the correct
 * value to `clearSessionLocal` when the server confirms the switch.
 */
let _switchingFromId: string | null = null;

/** Read and clear the switching-from ID. Used by ws-dispatch to pass the
 *  correct previous session to `clearSessionLocal`. Consuming (clearing)
 *  prevents stale IDs from leaking into future server-initiated switches. */
export function consumeSwitchingFromId(): string | null {
	const id = _switchingFromId;
	_switchingFromId = null;
	return id;
}

/**
 * Switch this tab to a different session.
 * Updates local state, navigates the URL, and sends `ViewSession` to the server.
 *
 * The two-tier per-session store retains session state across switches
 * (Tier 1 is unbounded, Tier 2 is LRU-capped).
 */
export function switchToSession(
	sessionId: string,
	view?: (input: ViewSessionRpcInput) => void,
): void {
	// Capture the outgoing session for permission cleanup in ws-dispatch.
	_switchingFromId = clientSession.currentId;
	if (_switchingFromId && _switchingFromId !== sessionId) {
		abortSessionReplay(_switchingFromId);
	}

	clientSession.currentId = sessionId;
	activateSessionChatState(sessionId);

	const slug = getCurrentSlug();
	if (slug) navigate(`/p/${slug}/s/${sessionId}`);
	if (slug) {
		const input: ViewSessionRpcInput = {
			projectSlug: slug,
			sessionId,
			originId: getBrowserClientId(),
		};
		if (view) {
			view(input);
		} else {
			void viewSessionRpc(input).catch(() => undefined);
		}
	}
	if (slug) {
		void getAgentsRpc({ projectSlug: slug, sessionId })
			.then(applyGetAgentsResponse)
			.catch(() => undefined);
		void getCommandsRpc({ projectSlug: slug, sessionId })
			.then(applyGetCommandsResponse)
			.catch(() => undefined);
		// Re-syncs per-session overrides (variant, context window, permission
		// mode) that connect-time hydration cannot see for later switches.
		void getModelsRpc({ projectSlug: slug, sessionId })
			.then(applyGetModelsResponse)
			.catch(() => undefined);
	}
}

/** Clear all session state (for project switch). */
export function clearSessionState(): void {
	resetSessionCreation(); // Cancel any in-flight creation (project switch safety)
	for (const id of [...serverSessions.keys()]) forgetSession(id);
	clientSession.currentId = null;
	setSearchQuery("");
}
