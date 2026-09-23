// ─── Session Store ───────────────────────────────────────────────────────────
// Manages session list, active session, search, and date grouping.

import { SvelteMap } from "svelte/reactivity";
import type {
	ListDaemonSessionsResponse,
	ListSessionsResponse,
} from "../transport/ws-rpc.js";
import {
	type CreateSessionRpcInput,
	createSessionRpc,
	getAgentsRpc,
	getCommandsRpc,
	getModelsRpc,
	listDaemonSessionsRpc,
	switchPermissionModeRpc,
	type ViewSessionRpcInput,
	viewSessionRpc,
} from "../transport/ws-rpc-client.js";
import type {
	AttentionGroups,
	DaemonSessionCursor,
	RelayMessage,
	RequestId,
	SessionAttention,
	SessionInfo,
} from "../types.js";
import {
	abortSessionReplay,
	activateSessionChatState,
	clearSessionChatState,
	sessionActivity,
	sessionMessages,
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

// ─── State ──────────────────────────────────────────────────────────────────

export const sessionState = $state({
	rootSessions: [] as SessionInfo[],
	familySessions: [] as SessionInfo[],
	daemonSessions: [] as SessionInfo[],
	// Projects the daemon could not read a session list from -- a directory that
	// has moved or been deleted, or a store it could not open. Held so the list
	// can say its own coverage is incomplete: the failure is otherwise
	// indistinguishable from a project that genuinely has no sessions.
	daemonUnavailableProjects: [] as string[],
	// Keyset cursor for the cross-project browse page. Null means "start at the
	// top"; daemonHasMore false means the merge is exhausted and the scroll
	// sentinel must stop asking, which is what keeps the list from showing a
	// loading row that never resolves.
	daemonCursor: null as DaemonSessionCursor | null,
	daemonHasMore: false,
	daemonLoading: false,
	currentId: null as string | null,
	searchQuery: "",
	searchResults: null as SessionInfo[] | null,
	// Search pages on its own cursor, deliberately separate from the browse
	// cursor above. Sharing one would mean clearing a query dropped the browse
	// list back to its first page instead of restoring where the user was.
	searchCursor: null as DaemonSessionCursor | null,
	searchHasMore: false,
	searchLoading: false,
	/** Id-keyed map maintained alongside rootSessions/familySessions arrays.
	 *  Used by the dispatcher's unknown-session guard (O(1) membership check)
	 *  for the roots, family, and selected session. */
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find metadata in the current roots, family, or selected-session stub. */
export function findSession(id: string): SessionInfo | undefined {
	return (
		sessionState.familySessions.find((s) => s.id === id) ??
		sessionState.rootSessions.find((s) => s.id === id) ??
		(id === sessionState.currentId ? sessionState.sessions.get(id) : undefined)
	);
}

/** Membership changes must not evict cached transcripts during navigation. */
function syncSessionMembership(): void {
	const selected = sessionState.currentId
		? sessionState.sessions.get(sessionState.currentId)
		: undefined;
	sessionState.sessions.clear();
	if (selected) sessionState.sessions.set(selected.id, selected);
	for (const session of [
		...sessionState.rootSessions,
		...sessionState.familySessions,
	]) {
		sessionState.sessions.set(session.id, session);
	}
}

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** The sidebar and its search show root sessions only. */
export function getFilteredSessions(): SessionInfo[] {
	if (sessionState.searchResults !== null) {
		const searchSlug = getCurrentSlug();
		// Root rows carry the subtree rollup, so search hits resolve against
		// them rather than the membership map, where family rows (individual
		// state) win.
		const liveRoots = new Map(
			sessionState.rootSessions.map((session) => [session.id, session]),
		);
		return sessionState.searchResults.flatMap((session) => {
			if (session.parentID) return [];
			if (session.projectSlug != null && session.projectSlug !== searchSlug) {
				return [session];
			}
			const liveSession = liveRoots.get(session.id);
			return liveSession ? [liveSession] : [];
		});
	}
	const localSessions = sessionState.rootSessions;
	const query = sessionState.searchQuery.toLowerCase().trim();
	const currentSlug = getCurrentSlug();
	// Foreign rows stay in while a query is active and get title-filtered with
	// the rest. The server search they will be replaced by now covers every
	// project too, so the local filter and the landing results agree -- which is
	// why these no longer have to stand down to avoid flashing in and out.
	const foreignSessions = sessionState.daemonSessions.filter(
		(session) =>
			session.projectSlug != null &&
			session.projectSlug !== currentSlug &&
			!session.parentID,
	);
	const sessions = [...localSessions, ...foreignSessions].sort(
		(a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
	);
	if (!query) return sessions;
	return sessions.filter((s) => s.title.toLowerCase().includes(query));
}

/** Get sessions grouped into the sidebar's four sections. */
export function getAttentionGroups(): AttentionGroups {
	return groupSessionsByAttention(getFilteredSessions());
}

/** Get the currently active session object (or undefined). */
export function getActiveSession(): SessionInfo | undefined {
	return findSession(sessionState.currentId ?? "");
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * The row's attention tier. The server derives it in one place and sends it on
 * every row, so the client only has to read it; a row arriving without one is
 * from a daemon that predates the field, and idle is the honest reading of no
 * signal rather than a guess assembled from processing flags and counts.
 */
export function sessionAttention(session: SessionInfo): SessionAttention {
	return session.attention ?? "idle";
}

// Within "Needs you", an approval outranks a question outranks a failure: the
// first two are blocking something right now, a failure has already stopped.
const NEEDS_YOU_ORDER: readonly SessionAttention[] = [
	"needs-approval",
	"needs-reply",
	"error",
];

/** Group sessions into the sidebar's four sections, in tier order. */
export function groupSessionsByAttention(
	sessions: SessionInfo[],
): AttentionGroups {
	const groups: AttentionGroups = {
		needsYou: [],
		running: [],
		doneUnread: [],
		idle: [],
	};

	for (const s of sessions) {
		switch (sessionAttention(s)) {
			case "needs-approval":
			case "needs-reply":
			case "error":
				groups.needsYou.push(s);
				break;
			case "working":
				groups.running.push(s);
				break;
			case "done-unread":
				groups.doneUnread.push(s);
				break;
			case "idle":
				groups.idle.push(s);
				break;
		}
	}

	// Stable, so recency still decides between two rows of the same tier.
	groups.needsYou.sort(
		(a, b) =>
			NEEDS_YOU_ORDER.indexOf(sessionAttention(a)) -
			NEEDS_YOU_ORDER.indexOf(sessionAttention(b)),
	);

	return groups;
}

function getSessionDate(session: SessionInfo): Date {
	return session.updatedAt
		? new Date(session.updatedAt)
		: session.createdAt
			? new Date(session.createdAt)
			: new Date(0);
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleSessionList(
	msg: Extract<RelayMessage, { type: "session_list" }>,
): void {
	const { sessions, roots, search } = msg;
	if (!Array.isArray(sessions) || roots === false) return;
	if (search) {
		sessionState.searchResults = sessions.filter(
			(session) => !session.parentID,
		);
		return;
	}
	if (!sessionState.searchQuery.trim()) sessionState.searchResults = null;
	const nextRoots = sessions.filter((session) => !session.parentID);
	const nextIds = new Set(nextRoots.map((session) => session.id));
	const removedIds = new Set(
		sessionState.rootSessions
			.filter((session) => !nextIds.has(session.id))
			.map((session) => session.id),
	);
	if (sessionState.searchResults)
		sessionState.searchResults = sessionState.searchResults.filter(
			(session) => !removedIds.has(session.id),
		);
	sessionState.rootSessions = nextRoots;
	syncSessionMembership();
}

export function handleSessionFamily(
	msg: Extract<RelayMessage, { type: "session_family" }>,
): void {
	sessionState.familySessions = msg.sessions;
	syncSessionMembership();
}

const sessionInfoFromRpc = (
	session: ListSessionsResponse["sessions"][number],
): SessionInfo => ({
	id: session.id,
	title: session.title,
	...(session.createdAt != null ? { createdAt: session.createdAt } : {}),
	...(session.updatedAt != null ? { updatedAt: session.updatedAt } : {}),
	...(session.messageCount != null
		? { messageCount: session.messageCount }
		: {}),
	...(session.processing != null ? { processing: session.processing } : {}),
	...(session.parentID != null ? { parentID: session.parentID } : {}),
	...(session.forkMessageId != null
		? { forkMessageId: session.forkMessageId }
		: {}),
	...(session.forkPointTimestamp != null
		? { forkPointTimestamp: session.forkPointTimestamp }
		: {}),
	...(session.pendingQuestionCount != null
		? { pendingQuestionCount: session.pendingQuestionCount }
		: {}),
	...(session.pendingPermissionCount != null
		? { pendingPermissionCount: session.pendingPermissionCount }
		: {}),
	...(session.attention != null ? { attention: session.attention } : {}),
	...(session.unread != null ? { unread: session.unread } : {}),
	...(session.projectSlug != null ? { projectSlug: session.projectSlug } : {}),
});

export function applyListSessionsResponse(
	response: ListSessionsResponse,
): void {
	handleSessionList({
		type: "session_list",
		sessions: response.sessions.map(sessionInfoFromRpc),
		roots: response.roots,
		...(response.search ? { search: true } : {}),
	});
}

/** How many cross-project rows one page asks for. Exported so the caller that
 *  fetches the first page uses the same size as the sentinel that fetches the
 *  rest -- a first page smaller than the viewport would never scroll, and so
 *  would never ask for a second. */
export const DAEMON_SESSION_PAGE_SIZE = 30;

/** Bumped by anything that invalidates in-flight browse pages. A response
 *  carrying a stale token is dropped rather than appended, so a project switch
 *  cannot splice another project's page onto the new list. */
let daemonBrowseToken = 0;

/** Applies a FIRST page: replaces the accumulator rather than appending. */
export function applyListDaemonSessionsResponse(
	response: ListDaemonSessionsResponse,
): void {
	daemonBrowseToken += 1;
	sessionState.daemonSessions = response.sessions.map(sessionInfoFromRpc);
	sessionState.daemonCursor = response.nextCursor;
	sessionState.daemonHasMore = response.hasMore;
	sessionState.daemonLoading = false;
	sessionState.daemonUnavailableProjects = response.availability
		.filter((entry) => !entry.available)
		.map((entry) => entry.projectSlug);
}

/** Appends the next cross-project page. No-ops at the end of the list and while
 *  a page is already in flight, which is what stops the scroll sentinel from
 *  re-requesting an exhausted cursor forever. */
export async function loadMoreDaemonSessions(): Promise<void> {
	const projectSlug = getCurrentSlug();
	const cursor = sessionState.daemonCursor;
	if (
		!projectSlug ||
		cursor === null ||
		!sessionState.daemonHasMore ||
		sessionState.daemonLoading
	) {
		return;
	}
	const token = daemonBrowseToken;
	sessionState.daemonLoading = true;
	try {
		const response = await listDaemonSessionsRpc({
			projectSlug,
			limit: DAEMON_SESSION_PAGE_SIZE,
			cursor,
		});
		if (token !== daemonBrowseToken) return;
		// Dedupe by id. The keyset cursor does not re-emit rows, but a session
		// whose updated_at moves between two requests can land on both pages, and
		// a repeated key throws out of Svelte's keyed {#each}.
		const seen = new Set(sessionState.daemonSessions.map((row) => row.id));
		const incoming = response.sessions
			.map(sessionInfoFromRpc)
			.filter((session) => !seen.has(session.id));
		sessionState.daemonSessions = [...sessionState.daemonSessions, ...incoming];
		sessionState.daemonCursor = response.nextCursor;
		sessionState.daemonHasMore = response.hasMore;
		sessionState.daemonUnavailableProjects = response.availability
			.filter((entry) => !entry.available)
			.map((entry) => entry.projectSlug);
	} catch {
		// Keep the rows already on screen and leave hasMore alone, so scrolling
		// again retries rather than declaring the list finished.
	} finally {
		if (token === daemonBrowseToken) sessionState.daemonLoading = false;
	}
}

/** The query the server is currently answering. Distinct from
 *  sessionState.searchQuery, which is what the user has typed this instant:
 *  the debounce means they disagree, and paging must repeat the committed one. */
let activeSearch: { query: string; roots: boolean } | null = null;
let daemonSearchToken = 0;

/** Runs a fresh cross-project title search, replacing any earlier results. */
export async function searchSessions(
	query: string,
	roots: boolean,
): Promise<void> {
	const trimmed = query.trim();
	if (!trimmed) {
		clearSessionSearch();
		return;
	}
	daemonSearchToken += 1;
	activeSearch = { query: trimmed, roots };
	sessionState.searchCursor = null;
	sessionState.searchHasMore = false;
	// Results are left on screen until the new page lands. Blanking them first
	// makes every keystroke flash the list through its "no match" state.
	await runSearchPage(daemonSearchToken, true);
}

/** Appends the next page of the active search. */
export async function loadMoreSearchResults(): Promise<void> {
	if (
		activeSearch === null ||
		sessionState.searchCursor === null ||
		!sessionState.searchHasMore ||
		sessionState.searchLoading
	) {
		return;
	}
	await runSearchPage(daemonSearchToken, false);
}

export function clearSessionSearch(): void {
	daemonSearchToken += 1;
	activeSearch = null;
	sessionState.searchResults = null;
	sessionState.searchCursor = null;
	sessionState.searchHasMore = false;
	sessionState.searchLoading = false;
}

async function runSearchPage(token: number, replace: boolean): Promise<void> {
	const search = activeSearch;
	const projectSlug = getCurrentSlug();
	if (search === null || !projectSlug) return;
	const cursor = replace ? null : sessionState.searchCursor;
	sessionState.searchLoading = true;
	try {
		const response = await listDaemonSessionsRpc({
			projectSlug,
			roots: search.roots,
			search: search.query,
			limit: DAEMON_SESSION_PAGE_SIZE,
			...(cursor === null ? {} : { cursor }),
		});
		if (token !== daemonSearchToken) return;
		const incoming = response.sessions.map(sessionInfoFromRpc);
		if (replace) {
			sessionState.searchResults = incoming;
		} else {
			const previous = sessionState.searchResults ?? [];
			const seen = new Set(previous.map((row) => row.id));
			sessionState.searchResults = [
				...previous,
				...incoming.filter((session) => !seen.has(session.id)),
			];
		}
		sessionState.searchCursor = response.nextCursor;
		sessionState.searchHasMore = response.hasMore;
	} catch {
		// Same as browse paging: keep what is shown, allow a retry.
	} finally {
		if (token === daemonSearchToken) sessionState.searchLoading = false;
	}
}

export function handleSessionSwitched(
	msg: Extract<RelayMessage, { type: "session_switched" }>,
): void {
	const { id, requestId } = msg;
	if (id) {
		sessionState.currentId = id;
		if (!findSession(id)) {
			sessionState.sessions.set(id, {
				id,
				title: "",
				...(msg.parentID ? { parentID: msg.parentID } : {}),
			});
		}
		syncSessionMembership();
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

/** Handle a session_forked message — add the new session to the list. */
export function handleSessionForked(
	msg: Extract<RelayMessage, { type: "session_forked" }>,
): void {
	const { session } = msg;
	// The family snapshot sent before the switch owns membership. Keep supplied
	// metadata only when this fork is already part of the viewer's family.
	if (
		sessionState.familySessions.some((candidate) => candidate.id === session.id)
	) {
		sessionState.familySessions = sessionState.familySessions.map(
			(candidate) => (candidate.id === session.id ? session : candidate),
		);
	}
	if (sessionState.currentId === session.id)
		sessionState.sessions.set(session.id, session);
	syncSessionMembership();
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
	_switchingFromId = sessionState.currentId;
	if (_switchingFromId && _switchingFromId !== sessionId) {
		abortSessionReplay(_switchingFromId);
	}

	sessionState.currentId = sessionId;
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
	for (const id of new Set([
		...sessionActivity.keys(),
		...sessionMessages.keys(),
	])) {
		clearSessionChatState(id);
	}
	sessionState.sessions.clear();
	sessionState.rootSessions = [];
	sessionState.familySessions = [];
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	clearSessionSearch();
	daemonBrowseToken += 1;
	sessionState.daemonSessions = [];
	sessionState.daemonCursor = null;
	sessionState.daemonHasMore = false;
	sessionState.daemonLoading = false;
}
