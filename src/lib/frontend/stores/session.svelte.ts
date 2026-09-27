// ─── Session Store ───────────────────────────────────────────────────────────
// Server-owned session rows on one side, this tab's selection and search on
// the other. The two halves never write each other.

import { busySessionIds as propagateBusySessions } from "../../session-busy.js";
import {
	applySessionChange,
	resetSessionSubscription,
	sessionSubscription,
} from "../transport/session-subscription.svelte.js";
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
	DateGroups,
	Immutable,
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
import { sessionActivityBridge } from "./session-activity.svelte.js";
import type { SessionGrouping, SessionStatusFilter } from "./session-scope.js";
import { getSessionScope } from "./session-scope.js";

// ─── Server-owned state ─────────────────────────────────────────────────────
// Every session the server has told us about, keyed by id — one representation,
// not a map plus two arrays kept in step by hand. The map itself belongs to the
// subscription that fills it (ni8.5 T-9); this store is a view over it and
// holds no copy. The `applySession*` functions below are this module's only
// door into it, and every row they store is a whole `SessionInfo` straight off
// the wire. Nothing outside can write it: `sessionState` hands it out as a
// `ReadonlyMap`.

const serverSessions = $derived(sessionSubscription.rows);
let rootSessions = $state.raw<readonly SessionInfo[]>([]);
let familySessions = $state.raw<readonly SessionInfo[]>([]);
const busySessionIds = $derived.by(() => {
	return propagateBusySessions(
		serverSessions,
		sessionActivityBridge.pending.keys(),
	);
});

/** The session view's single busy decision, shared by every sidebar row. */
export function isSessionBusy(id: string): boolean {
	return busySessionIds.has(id);
}

/** Live content only. Replay must never create a new activity bridge. */
export function observeSessionActivity(event: RelayMessage): void {
	if (!("sessionId" in event) || !event.sessionId) return;
	const id = event.sessionId;
	if (id !== clientSession.currentId && !serverSessions.has(id)) return;
	// Legacy `status` hints may come from the poller. Only the shell's
	// accepted row can retire activity or supply a status for this view.
	switch (event.type) {
		case "delta":
		case "thinking_start":
		case "thinking_delta":
		case "tool_start":
		case "tool_executing":
		case "tool_result":
			sessionActivityBridge.mark(id);
	}
}

// ─── Client-owned state ─────────────────────────────────────────────────────
// What this tab is looking at. Applying server rows never touches it.

const clientSession = $state({
	currentId: null as string | null,
	announcedParent: null as { sessionId: string; parentId: string } | null,
	searchQuery: "",
	/** Ids the last server search matched, or null when no search is running.
	 *  Ids rather than rows, so a session renamed or deleted mid-search follows
	 *  the server half instead of a snapshot that nothing updates. */
	searchMatchIds: null as string[] | null,
	daemonSessions: [] as SessionInfo[],
	daemonUnavailableProjects: [] as string[],
	daemonCursor: null as ListDaemonSessionsResponse["nextCursor"],
	daemonHasMore: false,
	daemonLoading: false,
	searchResults: null as SessionInfo[] | null,
	searchCursor: null as ListDaemonSessionsResponse["nextCursor"],
	searchHasMore: false,
	searchLoading: false,
	now: Date.now(),
});

/** Read view over both halves. The server half is read-only by type; the
 *  client half is a plain setting. */
export const sessionState = {
	/** Server-owned. Write through `applySessionSnapshot`, `applySessionUpsert`
	 *  or `applySessionRemoved`. */
	get sessions(): ReadonlyMap<string, Immutable<SessionInfo>> {
		return serverSessions;
	},
	get rootSessions(): readonly Immutable<SessionInfo>[] {
		return rootSessions;
	},
	get familySessions(): readonly Immutable<SessionInfo>[] {
		return familySessions;
	},
	get daemonSessions(): readonly SessionInfo[] {
		return clientSession.daemonSessions;
	},
	get daemonUnavailableProjects(): readonly string[] {
		return clientSession.daemonUnavailableProjects;
	},
	get daemonCursor() {
		return clientSession.daemonCursor;
	},
	get daemonHasMore() {
		return clientSession.daemonHasMore;
	},
	get daemonLoading() {
		return clientSession.daemonLoading;
	},
	get searchResults(): readonly SessionInfo[] | null {
		return clientSession.searchResults;
	},
	get searchCursor() {
		return clientSession.searchCursor;
	},
	get searchHasMore() {
		return clientSession.searchHasMore;
	},
	get searchLoading() {
		return clientSession.searchLoading;
	},
	get now() {
		return clientSession.now;
	},
	set now(value: number) {
		clientSession.now = value;
	},
	/** Whether the subscription has finished delivering its initial rows. */
	get settled(): boolean {
		return sessionSubscription.settled;
	},
	get currentId(): string | null {
		return clientSession.currentId;
	},
	get currentParentId(): string | null {
		const id = clientSession.currentId;
		if (!id) return null;
		return (
			serverSessions.get(id)?.parentID ??
			(clientSession.announcedParent?.sessionId === id
				? clientSession.announcedParent.parentId
				: null)
		);
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

let selectionGeneration = 0;
let pendingSelectionRequestId: RequestId | undefined;

export function acceptsSessionSwitch(
	requestId: RequestId | undefined,
): boolean {
	return requestId === undefined || requestId === pendingSelectionRequestId;
}

/**
 * Transition idle -> creating. Returns the requestId, or null if not idle.
 * Starts a timeout that auto-fails after NEW_SESSION_TIMEOUT_MS.
 */
export function requestNewSession(): RequestId | null {
	if (sessionCreation.value.phase !== "idle") return null;
	const requestId = createRequestId();
	selectionGeneration++;
	pendingSelectionRequestId = requestId;
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
	if (scope === "partial") {
		for (const row of rows) applySessionChange({ _tag: "upsert", item: row });
		return;
	}
	const incoming = new Set(rows.map((row) => row.id));
	const reaped = [...serverSessions.keys()].filter((id) => !incoming.has(id));
	applySessionChange({ _tag: "snapshot", rows });
	rootSessions = rows.filter((row) => !row.parentID);
	familySessions = rows;
	for (const id of reaped) forgetSession(id);
}

/** Apply a single session row the server has created or changed. */
export function applySessionUpsert(row: SessionInfo): void {
	applySessionChange({ _tag: "upsert", item: row });
	if (rootSessions.some((existing) => existing.id === row.id))
		rootSessions = rootSessions.map((existing) =>
			existing.id === row.id ? row : existing,
		);
	if (familySessions.some((existing) => existing.id === row.id))
		familySessions = familySessions.map((existing) =>
			existing.id === row.id ? row : existing,
		);
}

/** Apply a session the server has deleted. */
export function applySessionRemoved(id: string): void {
	applySessionChange({ _tag: "remove", id });
	rootSessions = rootSessions.filter((row) => row.id !== id);
	familySessions = familySessions.filter((row) => row.id !== id);
	clientSession.daemonSessions = clientSession.daemonSessions.filter(
		(row) => row.id !== id,
	);
	if (clientSession.searchResults)
		clientSession.searchResults = clientSession.searchResults.filter(
			(row) => row.id !== id,
		);
	forgetSession(id);
}

/** Drop the state this tab keeps for a session the map no longer holds. */
function forgetSession(id: string): void {
	clearSessionChatState(id);
	// A session that is gone cannot still be the one we are looking at. The
	// selection is what makes a session routable before its row arrives, so
	// leaving it behind lets a late event rebuild the chat state we just threw
	// away — and deleting the last session leaves no other for the server to
	// switch us to, so nothing else would clear it.
	if (clientSession.currentId === id) clientSession.currentId = null;
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

export function isSessionSnoozed(session: SessionInfo, now: number): boolean {
	return (
		session.snoozedAt != null &&
		!(session.snoozedUntil != null && session.snoozedUntil <= now)
	);
}

export function isSessionWoken(session: SessionInfo, now: number): boolean {
	return (
		session.wokenAt != null ||
		(session.snoozedAt != null &&
			session.snoozedUntil != null &&
			session.snoozedUntil <= now)
	);
}

// The store is global for the life of the browser page. Keep one timer for the
// earliest loaded wake and replace it whenever a list page changes.
$effect.root(() => {
	$effect(() => {
		const rows = [
			...sessionState.rootSessions,
			...sessionState.daemonSessions,
			...(sessionState.searchResults ?? []),
		];
		const now = sessionState.now;
		const nextWake = rows.reduce<number | null>((earliest, row) => {
			const until = row.snoozedAt != null ? row.snoozedUntil : undefined;
			if (until == null || until <= now) return earliest;
			return earliest == null ? until : Math.min(earliest, until);
		}, null);
		if (nextWake == null) return;
		const timer = setTimeout(
			() => {
				clientSession.now = Date.now();
			},
			Math.max(1, Math.min(nextWake - Date.now(), 2_147_483_647)),
		);
		return () => clearTimeout(timer);
	});
});

/** Manual pin/settle/snooze placement takes precedence over attention tiers. */
export function groupSessionsByAttention(
	sessions: SessionInfo[],
	now: number = Date.now(),
): AttentionGroups {
	const groups: AttentionGroups = {
		pinned: [],
		settled: [],
		snoozed: [],
		needsYou: [],
		running: [],
		doneUnread: [],
		idle: [],
	};

	for (const s of sessions) {
		if (s.pinnedAt != null) {
			groups.pinned.push(s);
			continue;
		}
		if (s.settledAt != null) {
			groups.settled.push(s);
			continue;
		}
		if (isSessionSnoozed(s, now)) {
			groups.snoozed.push(s);
			continue;
		}
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

	groups.pinned.sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
	groups.settled.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
	// Indefinite snoozes go last; MAX_SAFE_INTEGER rather than Infinity because
	// Infinity - Infinity is NaN, which breaks the comparator for two of them.
	groups.snoozed.sort(
		(a, b) =>
			(a.snoozedUntil ?? Number.MAX_SAFE_INTEGER) -
			(b.snoozedUntil ?? Number.MAX_SAFE_INTEGER),
	);
	// Stable, so recency still decides between two rows of the same tier.
	groups.needsYou.sort(
		(a, b) =>
			NEEDS_YOU_ORDER.indexOf(sessionAttention(a)) -
			NEEDS_YOU_ORDER.indexOf(sessionAttention(b)),
	);

	return groups;
}

export interface SessionSection {
	key: string;
	label: string;
	sessions: SessionInfo[];
}

export interface SessionProjection {
	pinned: SessionInfo[];
	sections: SessionSection[];
	snoozed: SessionInfo[];
	settled: SessionInfo[];
}

/** Project the already scoped and title-searched rows for the sidebar. */
export function projectSessionList(
	sessions: SessionInfo[],
	options: { status: SessionStatusFilter | null; grouping: SessionGrouping },
	now: number,
	projectLabel: (session: SessionInfo) => { key: string; label: string },
): SessionProjection {
	const matching = sessions.filter(
		(session) =>
			options.status === null || sessionMatchesStatus(session, options.status),
	);
	const groups = groupSessionsByAttention(matching, now);
	const shelves = {
		pinned: groups.pinned,
		snoozed: groups.snoozed,
		settled: groups.settled,
	};
	if (options.grouping === "status") {
		return {
			...shelves,
			sections: [
				{ key: "needs-you", label: "Needs you", sessions: groups.needsYou },
				{ key: "running", label: "Running", sessions: groups.running },
				{ key: "unread", label: "Done, unread", sessions: groups.doneUnread },
				{ key: "idle", label: "Idle", sessions: groups.idle },
			].filter((section) => section.sessions.length > 0),
		};
	}

	const live = matching
		.filter(
			(session) =>
				session.pinnedAt == null &&
				session.settledAt == null &&
				!isSessionSnoozed(session, now),
		)
		.sort((a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime());
	if (options.grouping === "time") {
		const dates = groupSessionsByDate(live, new Date(now));
		return {
			...shelves,
			sections: [
				{ key: "today", label: "Today", sessions: dates.today },
				{ key: "yesterday", label: "Yesterday", sessions: dates.yesterday },
				{ key: "older", label: "Older", sessions: dates.older },
			].filter((section) => section.sessions.length > 0),
		};
	}

	const byProject = new Map<string, SessionSection>();
	for (const session of live) {
		const { key, label } = projectLabel(session);
		let section = byProject.get(key);
		if (!section) {
			section = { key, label, sessions: [] };
			byProject.set(key, section);
		}
		section.sessions.push(session);
	}
	return { ...shelves, sections: [...byProject.values()] };
}

export function sessionMatchesStatus(
	session: SessionInfo,
	status: SessionStatusFilter,
): boolean {
	const attention = sessionAttention(session);
	switch (status) {
		case "needs-you":
			return (
				attention === "needs-approval" ||
				attention === "needs-reply" ||
				attention === "error"
			);
		case "running":
			return attention === "working";
		case "unread":
			return attention === "done-unread";
	}
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
	if (!Array.isArray(sessions)) return;

	if (search) {
		applySessionSnapshot(sessions, "partial");
		clientSession.searchMatchIds = sessions.map((s) => s.id);
		return;
	}
	if (roots !== true) return;
	rootSessions = sessions.filter((row) => !row.parentID);
	for (const row of rootSessions)
		applySessionChange({ _tag: "upsert", item: row });
}

export function handleSessionFamily(
	msg: Extract<RelayMessage, { type: "session_family" }>,
): void {
	familySessions = msg.sessions;
	const rootIds = new Set(rootSessions.map((root) => root.id));
	for (const row of familySessions) {
		if (!rootIds.has(row.id)) {
			applySessionChange({ _tag: "upsert", item: row });
		}
	}
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

/** How many cross-project rows one page asks for. Exported so the caller that
 *  fetches the first page uses the same size as the sentinel that fetches the
 *  rest -- a first page smaller than the viewport would never scroll, and so
 *  would never ask for a second. */
export const DAEMON_SESSION_PAGE_SIZE = 30;

/** Bumped by anything that invalidates in-flight browse pages. A response
 *  carrying a stale token is dropped rather than appended, so a project switch
 *  cannot splice another project's page onto the new list. */
let daemonBrowseToken = 0;

/** Fetches the first cross-project page for the current scope, replacing
 *  whatever was listed. Run on connect and again whenever the scope changes. */
export async function loadDaemonSessions(): Promise<void> {
	const projectSlug = getCurrentSlug();
	if (!projectSlug) return;
	daemonBrowseToken += 1;
	const token = daemonBrowseToken;
	const scope = getSessionScope();
	try {
		const response = await listDaemonSessionsRpc({
			projectSlug,
			limit: DAEMON_SESSION_PAGE_SIZE,
			...(scope === null ? {} : { scope }),
		});
		if (token === daemonBrowseToken) applyListDaemonSessionsResponse(response);
	} catch {
		// The local project's rows arrive separately; the list stays usable.
	}
}

/** Applies a FIRST page: replaces the accumulator rather than appending. */
export function applyListDaemonSessionsResponse(
	response: ListDaemonSessionsResponse,
): void {
	daemonBrowseToken += 1;
	clientSession.daemonSessions = [...response.sessions];
	clientSession.daemonCursor = response.nextCursor;
	clientSession.daemonHasMore = response.hasMore;
	clientSession.daemonLoading = false;
	clientSession.daemonUnavailableProjects = response.availability
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
	clientSession.daemonLoading = true;
	try {
		const scope = getSessionScope();
		const response = await listDaemonSessionsRpc({
			projectSlug,
			limit: DAEMON_SESSION_PAGE_SIZE,
			cursor,
			...(scope === null ? {} : { scope }),
		});
		if (token !== daemonBrowseToken) return;
		// Dedupe by id. The keyset cursor does not re-emit rows, but a session
		// whose updated_at moves between two requests can land on both pages, and
		// a repeated key throws out of Svelte's keyed {#each}.
		const seen = new Set(sessionState.daemonSessions.map((row) => row.id));
		const incoming = response.sessions.filter(
			(session) => !seen.has(session.id),
		);
		clientSession.daemonSessions = [
			...sessionState.daemonSessions,
			...incoming,
		];
		clientSession.daemonCursor = response.nextCursor;
		clientSession.daemonHasMore = response.hasMore;
		clientSession.daemonUnavailableProjects = response.availability
			.filter((entry) => !entry.available)
			.map((entry) => entry.projectSlug);
	} catch {
		// Keep the rows already on screen and leave hasMore alone, so scrolling
		// again retries rather than declaring the list finished.
	} finally {
		if (token === daemonBrowseToken) clientSession.daemonLoading = false;
	}
}

/** The query the server is currently answering. Distinct from
 *  sessionState.searchQuery, which is what the user has typed this instant:
 *  the debounce means they disagree, and paging must repeat the committed one. */
let activeSearch: {
	query: string;
	roots: boolean;
	scope: string | null;
} | null = null;
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
	activeSearch = { query: trimmed, roots, scope: getSessionScope() };
	clientSession.searchCursor = null;
	clientSession.searchHasMore = false;
	// Results are left on screen until the new page lands. Blanking them first
	// makes every keystroke flash the list through its "no match" state.
	await runSearchPage(daemonSearchToken, true);
}

/** Appends the next page of the active search. */
export async function loadMoreSearchResults(): Promise<void> {
	if (
		activeSearch === null ||
		clientSession.searchCursor === null ||
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
	clientSession.searchResults = null;
	clientSession.searchCursor = null;
	clientSession.searchHasMore = false;
	clientSession.searchLoading = false;
}

async function runSearchPage(token: number, replace: boolean): Promise<void> {
	const search = activeSearch;
	const projectSlug = getCurrentSlug();
	if (search === null || !projectSlug) return;
	const cursor = replace ? null : sessionState.searchCursor;
	clientSession.searchLoading = true;
	try {
		const response = await listDaemonSessionsRpc({
			projectSlug,
			roots: search.roots,
			search: search.query,
			limit: DAEMON_SESSION_PAGE_SIZE,
			...(search.scope === null ? {} : { scope: search.scope }),
			...(cursor === null ? {} : { cursor }),
		});
		if (token !== daemonSearchToken) return;
		applySearchResultsResponse(response, replace);
	} catch {
		// Same as browse paging: keep what is shown, allow a retry.
	} finally {
		if (token === daemonSearchToken) clientSession.searchLoading = false;
	}
}

export function applySearchResultsResponse(
	response: ListDaemonSessionsResponse,
	replace = true,
): void {
	const incoming = response.sessions;
	if (replace) {
		clientSession.searchResults = [...incoming];
	} else {
		const previous = sessionState.searchResults ?? [];
		const seen = new Set(previous.map((row) => row.id));
		clientSession.searchResults = [
			...previous,
			...incoming.filter((session) => !seen.has(session.id)),
		];
	}
	clientSession.searchCursor = response.nextCursor;
	clientSession.searchHasMore = response.hasMore;
}

export function handleSessionSwitched(
	msg: Extract<RelayMessage, { type: "session_switched" }>,
): void {
	const { id, requestId } = msg;
	if (requestId === undefined) selectionGeneration++;
	pendingSelectionRequestId = undefined;
	if (id) {
		clientSession.currentId = id;
		// A switch can precede the family row. Keep only this selection's
		// announced lineage; a server row takes precedence when it arrives.
		clientSession.announcedParent = msg.parentID
			? { sessionId: id, parentId: msg.parentID }
			: null;
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
	return (
		familySessions.find((row) => row.id === id) ??
		rootSessions.find((row) => row.id === id) ??
		serverSessions.get(id)
	);
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
	const session =
		rootSessions.find((row) => row.id === sessionId) ??
		serverSessions.get(sessionId);
	if (session === undefined) return null;
	if (
		(session.pendingQuestionCount ?? 0) > 0 ||
		(session.pendingPermissionCount ?? 0) > 0
	)
		return "attention";
	return session.unread === true ? "done-unviewed" : null;
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
	for (const session of sessionState.rootSessions) {
		const sessionId = session.id;
		if (sessionId === currentSessionId || descendants.has(sessionId)) continue;
		const questions = session.pendingQuestionCount ?? 0;
		const permissions = session.pendingPermissionCount ?? 0;
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

/** The sidebar and its search show root sessions only. */
export function getFilteredSessions(): SessionInfo[] {
	const scope = getSessionScope();
	const currentSlug = getCurrentSlug();
	// Local rows carry no projectSlug: they belong to the project this socket
	// is attached to.
	const inScope = (session: SessionInfo) =>
		scope === null || (session.projectSlug ?? currentSlug) === scope;
	if (sessionState.searchResults !== null) {
		const searchSlug = currentSlug;
		// Root rows carry the subtree rollup, so search hits resolve against
		// them rather than the membership map, where family rows (individual
		// state) win.
		const liveRoots = new Map(
			sessionState.rootSessions.map((session) => [session.id, session]),
		);
		return sessionState.searchResults.flatMap((session) => {
			if (session.parentID || !inScope(session)) return [];
			if (session.projectSlug != null && session.projectSlug !== searchSlug) {
				return [session];
			}
			const liveSession = liveRoots.get(session.id);
			return liveSession ? [liveSession] : [];
		});
	}
	const localSessions = sessionState.rootSessions;
	const query = sessionState.searchQuery.toLowerCase().trim();
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
	const sessions = [...localSessions, ...foreignSessions]
		.filter(inScope)
		.sort((a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime());
	if (!query) return sessions;
	return sessions.filter((s) => s.title.toLowerCase().includes(query));
}

/** Get sessions grouped into the sidebar's sections. */
export function getAttentionGroups(): AttentionGroups {
	return groupSessionsByAttention(getFilteredSessions(), sessionState.now);
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
 * `currentId` is overwritten so dispatch can abort the outgoing replay
 * when the server confirms the switch.
 */
let _switchingFromId: string | null = null;

/** Read and clear the switching-from ID. Consuming it prevents stale IDs
 *  from leaking into future server-initiated switches. */
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
	projectSlug?: string,
	view?: (input: ViewSessionRpcInput) => void,
): void {
	// Capture the outgoing session for permission cleanup in ws-dispatch.
	const generation = ++selectionGeneration;
	pendingSelectionRequestId = createRequestId();
	_switchingFromId = clientSession.currentId;
	if (_switchingFromId && _switchingFromId !== sessionId) {
		abortSessionReplay(_switchingFromId);
	}

	clientSession.currentId = sessionId;
	clientSession.announcedParent = null;
	activateSessionChatState(sessionId);

	const slug = projectSlug ?? getCurrentSlug();
	clientSession.currentId = sessionId;
	navigate(`/s/${sessionId}`);
	if (slug) {
		const input: ViewSessionRpcInput = {
			projectSlug: slug,
			sessionId,
			originId: getBrowserClientId(),
			requestId: pendingSelectionRequestId,
		};
		if (view) {
			view(input);
		} else {
			void viewSessionRpc(input).catch(() => undefined);
		}
	}
	if (slug) {
		void getAgentsRpc({ projectSlug: slug, sessionId })
			.then((response) => {
				if (
					generation === selectionGeneration &&
					clientSession.currentId === sessionId &&
					getCurrentSlug() === slug
				)
					applyGetAgentsResponse(response);
			})
			.catch(() => undefined);
		void getCommandsRpc({ projectSlug: slug, sessionId })
			.then((response) => {
				if (
					generation === selectionGeneration &&
					clientSession.currentId === sessionId &&
					getCurrentSlug() === slug
				)
					applyGetCommandsResponse(response);
			})
			.catch(() => undefined);
		// Re-syncs per-session overrides (variant, context window, permission
		// mode) that connect-time hydration cannot see for later switches.
		void getModelsRpc({ projectSlug: slug, sessionId })
			.then((response) => {
				if (
					generation === selectionGeneration &&
					clientSession.currentId === sessionId &&
					getCurrentSlug() === slug
				)
					applyGetModelsResponse(response);
			})
			.catch(() => undefined);
	}
}

/** Clear all session state (for project switch). */
export function clearSessionState(): void {
	selectionGeneration++;
	pendingSelectionRequestId = undefined;
	_switchingFromId = null;
	resetSessionCreation(); // Cancel any in-flight creation (project switch safety)
	const held = [...serverSessions.keys()];
	resetSessionSubscription();
	for (const id of held) forgetSession(id);
	for (const id of new Set([
		...sessionActivity.keys(),
		...sessionMessages.keys(),
	])) {
		clearSessionChatState(id);
	}
	clientSession.currentId = null;
	clientSession.announcedParent = null;
	setSearchQuery("");
	rootSessions = [];
	familySessions = [];
	clientSession.daemonSessions = [];
	clientSession.daemonUnavailableProjects = [];
	clientSession.daemonCursor = null;
	clientSession.daemonHasMore = false;
	clientSession.daemonLoading = false;
	daemonBrowseToken++;
	clearSessionSearch();
}
