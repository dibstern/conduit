// ─── Session Store ───────────────────────────────────────────────────────────
// Manages session list, active session, search, and date grouping.

import { SvelteMap } from "svelte/reactivity";
import type {
	DateGroups,
	RelayMessage,
	RequestId,
	SessionInfo,
} from "../types.js";
import {
	clearMessages,
	restoreCachedMessages,
	stashSessionMessages,
} from "./chat.svelte.js";
import { getCurrentSlug, navigate } from "./router.svelte.js";
import { uiState, updateContextPercent } from "./ui.svelte.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const sessionState = $state({
	rootSessions: [] as SessionInfo[],
	allSessions: [] as SessionInfo[],
	currentId: null as string | null,
	searchQuery: "",
	searchResults: null as SessionInfo[] | null,
	hasMore: false,
	/** Id-keyed map maintained alongside rootSessions/allSessions arrays.
	 *  Used by the dispatcher's unknown-session guard (O(1) membership check)
	 *  and by clearSessionChatState's diff path. */
	sessions: new SvelteMap<string, SessionInfo>(),
});

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
	send: (data: Record<string, unknown>) => void,
): RequestId | null {
	const requestId = requestNewSession();
	if (!requestId) return null;
	send({ type: "new_session", requestId });
	return requestId;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find a session by ID across both cached arrays.
 *  Prefers allSessions (more complete), falls back to rootSessions (available earlier). */
export function findSession(id: string): SessionInfo | undefined {
	return (
		sessionState.allSessions.find((s) => s.id === id) ??
		sessionState.rootSessions.find((s) => s.id === id)
	);
}

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get sessions filtered by search query (case-insensitive title match).
 *  Subagent sessions (those with a parentID) are excluded when the
 *  hideSubagentSessions UI toggle is active (default). */
export function getFilteredSessions(): SessionInfo[] {
	// Active search results take priority (already filtered by server)
	if (sessionState.searchResults !== null) {
		return sessionState.searchResults;
	}
	let sessions: SessionInfo[];
	if (uiState.hideSubagentSessions) {
		sessions = sessionState.rootSessions;
	} else {
		// Fall back to rootSessions while allSessions hasn't loaded yet
		sessions =
			sessionState.allSessions.length > 0
				? sessionState.allSessions
				: sessionState.rootSessions;
	}
	const query = sessionState.searchQuery.toLowerCase().trim();
	if (!query) return sessions;
	return sessions.filter((s) => s.title.toLowerCase().includes(query));
}

/** Get sessions grouped by date: today, yesterday, older. */
export function getDateGroups(): DateGroups {
	return groupSessionsByDate(getFilteredSessions());
}

/** Get the currently active session object (or undefined). */
export function getActiveSession(): SessionInfo | undefined {
	return findSession(sessionState.currentId ?? "");
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Group sessions into today/yesterday/older buckets. */
export function groupSessionsByDate(
	sessions: SessionInfo[],
	now?: Date,
): DateGroups {
	const ref = now ?? new Date();
	const todayStart = new Date(ref);
	todayStart.setHours(0, 0, 0, 0);
	const yesterdayStart = new Date(todayStart);
	yesterdayStart.setDate(yesterdayStart.getDate() - 1);

	const groups: DateGroups = { today: [], yesterday: [], older: [] };

	for (const s of sessions) {
		const updated = s.updatedAt
			? new Date(s.updatedAt)
			: s.createdAt
				? new Date(s.createdAt)
				: new Date(0);

		if (updated >= todayStart) {
			groups.today.push(s);
		} else if (updated >= yesterdayStart) {
			groups.yesterday.push(s);
		} else {
			groups.older.push(s);
		}
	}

	return groups;
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleSessionList(
	msg: Extract<RelayMessage, { type: "session_list" }>,
): void {
	const { sessions, roots, search } = msg;
	if (!Array.isArray(sessions)) return;

	// Search results go to a separate field — never overwrite main arrays.
	if (search) {
		sessionState.searchResults = sessions;
		return;
	}

	// Clear search results when a fresh full list arrives (not during active search)
	if (!sessionState.searchQuery.trim()) {
		sessionState.searchResults = null;
	}

	if (roots === true) {
		sessionState.rootSessions = sessions;
	} else if (roots === false) {
		sessionState.allSessions = sessions;
	} else {
		// Backward-compat: untagged session_list (no `roots` field) contains
		// a mixed bag of sessions. Populate both arrays so the sidebar works
		// regardless of the subagent toggle state.
		sessionState.rootSessions = sessions.filter((s) => !s.parentID);
		sessionState.allSessions = sessions;
	}
}

export function handleSessionSwitched(
	msg: Extract<RelayMessage, { type: "session_switched" }>,
): void {
	const { id, requestId } = msg;
	if (id) {
		sessionState.currentId = id;
	}
	// Co-located: complete the creation state machine if this session_switched
	// is the response to our new_session request. This is inside
	// handleSessionSwitched (not in the dispatch switch) so it can't be
	// accidentally separated from the state update.
	if (requestId) {
		completeNewSession(requestId);
	}
}

/** Handle a session_forked message — add the new session to the list. */
export function handleSessionForked(
	msg: Extract<RelayMessage, { type: "session_forked" }>,
): void {
	const { session } = msg;
	// Forked sessions always have parentID (the fork source), so they only
	// go into allSessions. The next session_list broadcast will update both
	// arrays authoritatively.
	if (!sessionState.allSessions.some((s) => s.id === session.id)) {
		sessionState.allSessions = [session, ...sessionState.allSessions];
	}
}

// ─── Actions ────────────────────────────────────────────────────────────────

export function setSearchQuery(query: string): void {
	sessionState.searchQuery = query;
}

export function setCurrentSession(id: string | null): void {
	sessionState.currentId = id;
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
 * Updates local state, navigates the URL, and sends `view_session` to the server.
 *
 * Optimistically stashes the outgoing session's messages into a local cache
 * and restores cached messages for the target session (if available) so the
 * user sees an instant transition instead of a blank screen while waiting for
 * the server round-trip.
 */
export function switchToSession(
	sessionId: string,
	sendWs: (data: Record<string, unknown>) => void,
): void {
	// Capture the outgoing session for permission cleanup in ws-dispatch.
	_switchingFromId = sessionState.currentId;

	// Stash current session's messages before switching.
	if (sessionState.currentId) {
		stashSessionMessages(sessionState.currentId);
	}

	sessionState.currentId = sessionId;

	// Optimistic restore — show cached messages instantly if we've visited
	// this session before.  Falls back to a clean slate if no cache entry.
	if (!restoreCachedMessages(sessionId)) {
		clearMessages();
		updateContextPercent(0);
	}

	const slug = getCurrentSlug();
	if (slug) navigate(`/p/${slug}/s/${sessionId}`);
	sendWs({ type: "view_session", sessionId });
}

/** Clear all session state (for project switch). */
export function clearSessionState(): void {
	resetSessionCreation(); // Cancel any in-flight creation (project switch safety)
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
}
