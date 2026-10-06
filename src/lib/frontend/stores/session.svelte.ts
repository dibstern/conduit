// Server-owned session rows on one side, this tab's selection and search on
// the other. The two halves never write each other.

import { busySessionIds as calculateBusySessionIds } from "../../session-busy.js";
import {
	resetSessionSubscription,
	sessionSubscription,
} from "../transport/session-subscription.svelte.js";
import type { ListDaemonSessionsResponse } from "../transport/ws-rpc.js";
import {
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
	SessionAttention,
	SessionInfo,
} from "../types.js";
import {
	activateSessionChatState,
	clearSessionChatState,
	handleInputSyncReceived,
	sessionActivity,
	sessionMessages,
} from "./chat.svelte.js";
import { getBrowserClientId } from "./client-identity.js";
import {
	applyGetAgentsResponse,
	applyGetCommandsResponse,
	applyGetModelsResponse,
	flushPendingPermissionMode,
} from "./discovery.svelte.js";
import { goalDetails, sessionGoals } from "./goal.svelte.js";
import {
	getCurrentSessionId,
	getCurrentSlug,
	navigate,
	replaceRoute,
} from "./router.svelte.js";
import { sessionActivityBridge } from "./session-activity.svelte.js";
import type { SessionGrouping, SessionStatusFilter } from "./session-scope.js";
import { getSessionScope } from "./session-scope.js";
import { clearTodoState } from "./todo.svelte.js";
import { updateContextPercent } from "./ui.svelte.js";

// Every session the server has told us about, keyed by id — one representation,
// not a map plus two arrays kept in step by hand. The map itself belongs to the
// subscription that fills it (ni8.5 T-9); this store is a view over it and
// holds no copy. Every row is a whole `SessionInfo` straight off the wire.
// Nothing outside can write it: `sessionState` hands it out as a `ReadonlyMap`.

const serverSessions = $derived(sessionSubscription.rows);
const rootSessions = $derived(
	[...serverSessions.values()].filter(
		(row) => !row.parentID && !row.sideThread,
	),
);
let familySessions = $state.raw<readonly SessionInfo[]>([]);

/** A session can receive events while its row is still arriving. */
export function isRoutable(id: string): boolean {
	return (
		id === clientSession.currentId ||
		serverSessions.has(id) ||
		familySessions.some((row) => row.id === id)
	);
}

/** Prefer the versioned row when a family message carries older metadata. */
export function parentOf(id: string): string | null {
	return (
		serverSessions.get(id)?.parentID ??
		familySessions.find((row) => row.id === id)?.parentID ??
		(clientSession.announcedParent?.sessionId === id
			? clientSession.announcedParent.parentId
			: null)
	);
}

const busySessionIds = $derived.by(() => {
	const rows = new Map(familySessions.map((row) => [row.id, row]));
	for (const row of serverSessions.values()) rows.set(row.id, row);
	// Activity can arrive before the current session's first family row.
	const currentId = clientSession.currentId;
	if (currentId && !rows.has(currentId)) {
		rows.set(currentId, {
			id: currentId,
			title: "",
			status: "idle",
			parentID: parentOf(currentId) ?? undefined,
		});
	}
	return calculateBusySessionIds(rows, sessionActivityBridge.pending.keys());
});

/** The session view's single busy decision, shared by every sidebar row. */
export function isSessionBusy(id: string): boolean {
	return busySessionIds.has(id);
}

/** Live content only. Replay must never create a new activity bridge. */
export function observeSessionActivity(event: RelayMessage): void {
	if (!("sessionId" in event) || !event.sessionId) return;
	const id = event.sessionId;
	if (!isRoutable(id)) return;
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

// What this tab is looking at. Applying server rows never touches it.

const clientSession = $state({
	currentId: null as string | null,
	announcedParent: null as {
		sessionId: string;
		parentId: string;
		forkMessageId?: string;
		forkPointTimestamp?: number;
	} | null,
	searchQuery: "",
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

$effect.root(() => {
	let previousId: string | null | undefined;
	$effect(() => {
		const id = clientSession.currentId;
		if (previousId !== undefined && id !== previousId) goalDetails.open = false;
		previousId = id;
	});
});

/** Read view over both halves. The server half is read-only by type; the
 *  client half is a plain setting. */
export const sessionState = {
	/** Server-owned. The shell feed is its only writer. */
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
		return id ? parentOf(id) : null;
	},
	get currentFork() {
		return clientSession.announcedParent?.sessionId === clientSession.currentId
			? clientSession.announcedParent
			: null;
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
};

let selectionGeneration = 0;

/** Prune separate cross-project and search reads after a deletion notice. */
export function pruneSessionLists(id: string): void {
	clientSession.daemonSessions = clientSession.daemonSessions.filter(
		(row) => row.id !== id,
	);
	if (clientSession.searchResults)
		clientSession.searchResults = clientSession.searchResults.filter(
			(row) => row.id !== id,
		);
}

/** Drop the state this tab keeps for a session the map no longer holds. */
export function forgetSession(id: string): void {
	clearSessionChatState(id);
	sessionGoals.delete(id);
	// A session that is gone cannot still be the one we are looking at. The
	// selection is what makes a session routable before its row arrives, so
	// leaving it behind lets a late event rebuild the chat state we just threw
	// away — and deleting the last session leaves no other for the server to
	// switch us to, so nothing else would clear it.
	if (clientSession.currentId === id) clientSession.currentId = null;
}

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
			case "monitoring":
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
			return attention === "working" || attention === "monitoring";
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

export function handleSessionFamily(
	msg: Extract<RelayMessage, { type: "session_family" }>,
): void {
	familySessions = msg.sessions;
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

/** Keep fork lineage with this tab's selection until the family row arrives. */
export function handleSessionForked(
	msg: Extract<RelayMessage, { type: "session_forked" }>,
): void {
	if (
		clientSession.announcedParent?.sessionId === clientSession.currentId &&
		clientSession.currentId !== msg.parentId
	)
		return;
	clientSession.announcedParent = {
		sessionId: msg.sessionId,
		parentId: msg.parentId,
		...(msg.forkMessageId && {
			forkMessageId: msg.forkMessageId,
		}),
		...(msg.forkPointTimestamp != null && {
			forkPointTimestamp: msg.forkPointTimestamp,
		}),
	};
}

// Components should wrap these in $derived() for reactive caching.

/** Find a session by id. */
export function findSession(id: string): Immutable<SessionInfo> | undefined {
	return (
		serverSessions.get(id) ??
		familySessions.find((row) => row.id === id) ??
		rootSessions.find((row) => row.id === id)
	);
}

// Notification views (ni8.23)
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
		serverSessions.get(sessionId) ??
		familySessions.find((row) => row.id === sessionId);
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
		// Root rows carry the subtree rollup, so local search hits use the
		// current shell row rather than a possibly older search result.
		const liveRoots = new Map(
			sessionState.rootSessions.map((session) => [session.id, session]),
		);
		return sessionState.searchResults.flatMap((session) => {
			if (session.parentID || session.sideThread || !inScope(session))
				return [];
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
			!session.parentID &&
			!session.sideThread,
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

/** Set the sidebar's immediate local filter while the server query debounces. */
export function setSearchQuery(query: string): void {
	clientSession.searchQuery = query;
}

export function setCurrentSession(id: string | null): void {
	clientSession.currentId = id;
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
	view?: typeof viewSessionRpc,
	options?: { replace?: boolean },
): void {
	const generation = ++selectionGeneration;
	const previousId = clientSession.currentId;
	if (previousId && previousId !== sessionId) {
		const activity = sessionActivity.get(previousId);
		if (activity) activity.replayGeneration++;
	}

	clientSession.currentId = sessionId;
	if (clientSession.announcedParent?.sessionId !== sessionId)
		clientSession.announcedParent = null;
	activateSessionChatState(sessionId);
	if (previousId !== sessionId) {
		updateContextPercent(0);
		clearTodoState();
	}

	const slug = projectSlug ?? getCurrentSlug();
	if (getCurrentSessionId() !== sessionId) {
		if (options?.replace) replaceRoute(`/s/${sessionId}`);
		else navigate(`/s/${sessionId}`);
	}
	if (slug) {
		flushPendingPermissionMode(slug, sessionId, switchPermissionModeRpc);
		const input: ViewSessionRpcInput = {
			projectSlug: slug,
			sessionId,
			originId: getBrowserClientId(),
		};
		void (view ?? viewSessionRpc)(input)
			.then(({ draft }) => {
				if (
					draft !== undefined &&
					generation === selectionGeneration &&
					clientSession.currentId === sessionId &&
					getCurrentSlug() === slug
				)
					handleInputSyncReceived({ text: draft });
			})
			.catch(() => undefined);
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
	familySessions = [];
	clientSession.daemonSessions = [];
	clientSession.daemonUnavailableProjects = [];
	clientSession.daemonCursor = null;
	clientSession.daemonHasMore = false;
	clientSession.daemonLoading = false;
	daemonBrowseToken++;
	clearSessionSearch();
}
