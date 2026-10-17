// Server-owned session rows on one side, this tab's selection and search on
// the other. The two halves never write each other.

import { SvelteMap } from "svelte/reactivity";
import { busySessionIds as calculateBusySessionIds } from "../../session-busy.js";
import { getScopeGroupKey } from "../../session-scope.js";
import type { BackgroundTask } from "../../shared-types.js";
import {
	isBusy,
	resetSessionSubscription,
	sessionSubscription,
	turnEnded,
} from "../transport/session-subscription.svelte.js";
import {
	type Change,
	emptySubscription,
	reduce,
	type SubscriptionState,
} from "../transport/subscription-state.js";
import type {
	ForkSessionResponse,
	ListDaemonSessionsResponse,
} from "../transport/ws-rpc.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type {
	AttentionGroups,
	DateGroups,
	Immutable,
	SessionAttention,
	SessionInfo,
} from "../types.js";
import {
	activateSessionChatState,
	clearSessionChatState,
	followSessionBusy,
	followSessionCompaction,
	followSessionRetry,
	sessionActivity,
	sessionMessages,
} from "./chat.svelte.js";
import {
	clearDraftSelection,
	followSessionModelSettings,
	handlePermissionModeInfo,
	refreshCatalogs,
} from "./discovery.svelte.js";
import { goalDetails, sessionGoals } from "./goal.svelte.js";
import { getProjectGroup } from "./project-state.svelte.js";
import { attachedProjectState, getCurrentSlug } from "./router.svelte.js";
import { markSessionDeleted, selection } from "./selection.svelte.js";
import { restoreServerUpdateBanner } from "./server-status.svelte.js";
import type { SessionGrouping, SessionStatusFilter } from "./session-scope.js";
import { getSessionScope } from "./session-scope.js";
import { clearTodoState } from "./todo.svelte.js";
import { applyTurnRow, deleteTurn, rebaseTurns } from "./turn.svelte.js";
import { showToast } from "./ui.svelte.js";
import { projectAttachedListeners } from "./ws-listeners.js";

// Re-exported so chat.svelte.ts need not import the subscription directly,
// which would load it ahead of this store and leave its rows undefined.
export { isBusy };

// Every session the server has told us about, keyed by id — one representation,
// not a map plus two arrays kept in step by hand. The map itself belongs to the
// subscription that fills it (ni8.5 T-9); this store is a view over it and
// holds no copy. Every row is a whole `SessionInfo` straight off the wire.
// Nothing outside can write it: `sessionState` hands it out as a `ReadonlyMap`.

const serverSessions = $derived(sessionSubscription.rows);
const isFamilyRoot = (row: Pick<SessionInfo, "parentID">) => !row.parentID;
const rootSessions = $derived(
	[...serverSessions.values()].filter(isFamilyRoot),
);
// The viewed session's family (root and descendants), owned by its
// SubscribeSessionFamily feed: `applyFamilyChange` is the only writer.
let familyApplied = $state.raw<SubscriptionState<SessionInfo>>(
	emptySubscription(),
);
const familySessions = $derived([...familyApplied.rows.values()]);

/** Prefer the versioned row when a family message carries older metadata. */
export function parentOf(id: string): string | null {
	return (
		serverSessions.get(id)?.parentID ??
		familySessions.find((row) => row.id === id)?.parentID ??
		null
	);
}

/**
 * The live background tasks of id's Claude runtime. Only SDK subagent Child
 * Sessions share their parent's runtime; forks and Side Threads own theirs.
 */
export function rootBackgroundTasks(id: string): readonly BackgroundTask[] {
	const seen = new Set([id]);
	let root = id;
	for (
		let up = parentOf(root);
		root.startsWith("claude-subagent-") && up && !seen.has(up);
		up = parentOf(root)
	) {
		seen.add(up);
		root = up;
	}
	return (
		(serverSessions.get(root) ?? familySessions.find((row) => row.id === root))
			?.backgroundTasks ?? []
	);
}

const busySessionIds = $derived.by(() => {
	const rows = new Map(familySessions.map((row) => [row.id, row]));
	for (const row of serverSessions.values()) rows.set(row.id, row);
	return calculateBusySessionIds(rows);
});

/** The session view's single busy decision, shared by every sidebar row. */
export function isSessionBusy(id: string): boolean {
	return busySessionIds.has(id);
}

/** Attach this tab from an AttachProject or cross-project ViewSession reply. */
export function setAttachedProject(slug: string): void {
	if (attachedProjectState.slug !== slug)
		for (const activity of sessionActivity.values())
			activity.replayGeneration++;
	attachedProjectState.slug = slug;
	for (const listener of projectAttachedListeners) listener(slug);
	// Project listeners reset banners, so restore the daemon-wide update offer.
	restoreServerUpdateBanner();
}

// What this tab is looking at. Applying server rows never touches it.

const clientSession = $state({
	announcedFork: null as {
		sessionId: string;
		forkedFrom: string;
		forkMessageId?: string;
		forkPointTimestamp?: number;
	} | null,
	searchQuery: "",
	searchIncludeArchived: false,
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

const currentSessionId = $derived.by(() => {
	const shown = selection.shown;
	return shown.kind === "drawn" ||
		shown.kind === "placing" ||
		shown.kind === "placed"
		? shown.sessionId
		: null;
});

/** Read view over both halves. The server half is read-only by type; the
 *  client half is a plain setting. */
export const sessionState = {
	/** Live placement sources exclude the provisional saved shell. */
	get liveSessions(): ReadonlyMap<string, Immutable<SessionInfo>> {
		return sessionSubscription.liveRows;
	},
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
		return currentSessionId;
	},
	get currentParentId(): string | null {
		const id = sessionState.currentId;
		return id ? parentOf(id) : null;
	},
	get currentFork() {
		const id = sessionState.currentId;
		// Stands in until the Fork's row arrives with its lineage.
		return clientSession.announcedFork?.sessionId === id
			? clientSession.announcedFork
			: null;
	},
	get searchQuery(): string {
		return clientSession.searchQuery;
	},
	get searchIncludeArchived(): boolean {
		return clientSession.searchIncludeArchived;
	},
	set searchQuery(query: string) {
		setSearchQuery(query);
	},
};

/** A deletion owns only its id; selection follows the tombstone. */
export function leaveDeletedSession(id: string): void {
	clientSession.daemonSessions = clientSession.daemonSessions.filter(
		(row) => row.id !== id,
	);
	if (clientSession.searchResults)
		clientSession.searchResults = clientSession.searchResults.filter(
			(row) => row.id !== id,
		);
	markSessionDeleted(id);
}

/** Drop the state this tab keeps for a session the map no longer holds. */
export function forgetSession(id: string): void {
	clearSessionChatState(id);
	sessionGoals.delete(id);
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

// Read marks this tab sent that the server has not sent back yet, so a tap
// moves the sidebar dot at once rather than after the round trip (phones feel
// it most). A mark is dropped when the server's row agrees, when the write
// fails, or when the row's turn end moves: a new turn end is unread on its own
// terms. A root's attention rolls up its forks, so marking one read can still
// leave a dot once the server answers.
const readMarks = new SvelteMap<
	string,
	{
		readonly unread: boolean;
		readonly lastTurnEndVersion: number | undefined;
	}
>();

/** Returns a function that drops this mark, unless a newer one replaced it. */
export function setReadMark(row: SessionInfo, unread: boolean): () => void {
	const mark = { unread, lastTurnEndVersion: row.lastTurnEndVersion };
	readMarks.set(row.id, mark);
	return () => {
		if (readMarks.get(row.id) === mark) readMarks.delete(row.id);
	};
}

/** Drop the marks the server's rows have answered. */
export function settleReadMarks(rows: ReadonlyMap<string, SessionInfo>): void {
	for (const [id, mark] of readMarks) {
		const row = rows.get(id);
		if (
			row &&
			((row.unread === true) === mark.unread ||
				row.lastTurnEndVersion !== mark.lastTurnEndVersion)
		)
			readMarks.delete(id);
	}
}

/** The row as the user last marked it, until the server catches up. */
export function withReadMark<T extends SessionInfo>(row: T): T {
	const mark = readMarks.get(row.id);
	if (
		!mark ||
		mark.lastTurnEndVersion !== row.lastTurnEndVersion ||
		mark.unread === (row.unread === true)
	)
		return row;
	const attention = sessionAttention(row);
	return {
		...row,
		unread: mark.unread,
		attention: mark.unread
			? attention === "idle"
				? "done-unread"
				: attention
			: attention === "done-unread"
				? "idle"
				: attention,
	};
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

/** Group the sidebar's already sorted, scoped and status-filtered rows. */
export function projectSessionList(
	sessions: SessionInfo[],
	grouping: SessionGrouping,
	now: number,
	projectLabel: (session: SessionInfo) => { key: string; label: string },
): SessionProjection {
	const groups = groupSessionsByAttention(sessions, now);
	const shelves = {
		pinned: groups.pinned,
		snoozed: groups.snoozed,
		settled: groups.settled,
	};
	if (grouping === "status") {
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

	const live = sessions.filter(
		(session) =>
			session.pinnedAt == null &&
			session.settledAt == null &&
			!isSessionSnoozed(session, now),
	);
	if (grouping === "time") {
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

/** Apply one family feed change. Versioned, so a late row cannot regress. */
export function applyFamilyChange(change: Change<SessionInfo>): void {
	const next = reduce(familyApplied, change, (row) => row.id);
	if (next === familyApplied) return;
	const previousRows = familyApplied.rows;
	const reconnect = familyApplied.floor !== undefined;
	// Children and archived roots have no shell row; their family owns settings.
	const currentId = sessionState.currentId;
	const viewed = currentId === null ? undefined : next.rows.get(currentId);
	const previous = viewed && previousRows.get(viewed.id);
	if (
		viewed &&
		(viewed.parentID !== undefined || viewed.archivedAt != null) &&
		viewed !== previous
	) {
		followSessionModelSettings(viewed, previous);
		if (
			viewed.archivedAt != null &&
			viewed.permissionMode !== undefined &&
			viewed.permissionMode !== previous?.permissionMode
		)
			handlePermissionModeInfo({ mode: viewed.permissionMode });
	}
	familyApplied = next;
	if (change._tag === "upsert") applyTurnRow(change.item);
	if (change._tag === "remove" && change.deleted === true) {
		leaveDeletedSession(change.id);
		forgetSession(change.id);
		deleteTurn(change.id);
	}
	// Children and archived roots follow status here while live roots use shell.
	if (change._tag === "snapshot") {
		if (reconnect) rebaseTurns([...previousRows.keys(), ...next.rows.keys()]);
		// A bounded rebase can omit a child that finished while disconnected.
		for (const row of previousRows.values()) {
			if (
				(row.parentID === undefined && row.archivedAt == null) ||
				next.rows.has(row.id)
			)
				continue;
			if (isBusy(row)) followSessionBusy(row.id, false);
			followSessionCompaction(row.id, undefined);
			followSessionRetry(row.id, undefined);
		}
		for (const row of next.rows.values()) {
			applyTurnRow(row);
			if (row.parentID === undefined && row.archivedAt == null) continue;
			followSessionBusy(row.id, isBusy(row), row.lastTurnEndVersion);
			followSessionCompaction(row.id, row.compacting);
			followSessionRetry(row.id, row.retrying);
		}
	}
	if (
		change._tag === "upsert" &&
		(change.item.parentID !== undefined || change.item.archivedAt != null)
	) {
		const previousRow = previousRows.get(change.item.id);
		const busy = isBusy(change.item);
		if (
			busy !== isBusy(previousRow) ||
			(!busy && turnEnded(previousRow, change.item))
		)
			followSessionBusy(change.item.id, busy, change.item.lastTurnEndVersion);
		if (change.item.compacting !== previousRow?.compacting)
			followSessionCompaction(change.item.id, change.item.compacting);
		if (change.item.retrying !== previousRow?.retrying)
			followSessionRetry(change.item.id, change.item.retrying);
	}
}

/** Forget the family we were watching (project or family switch). */
export function resetSessionFamily(): void {
	familyApplied = emptySubscription();
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
		const response = await rpc("ListDaemonSessions", {
			projectSlug,
			limit: DAEMON_SESSION_PAGE_SIZE,
			// The sidebar shows other projects' roots only; this project's roots
			// come from the shell feed. Pages of rows that never render keep the
			// scroll sentinel in view, so the pager would walk the whole store.
			roots: true,
			exclude: projectSlug,
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
		const response = await rpc("ListDaemonSessions", {
			projectSlug,
			limit: DAEMON_SESSION_PAGE_SIZE,
			cursor,
			roots: true,
			exclude: projectSlug,
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
	includeArchived: boolean;
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
	activeSearch = {
		query: trimmed,
		roots,
		scope: getSessionScope(),
		includeArchived: clientSession.searchIncludeArchived,
	};
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
	clientSession.searchIncludeArchived = false;
}

export async function setSearchIncludeArchived(value: boolean): Promise<void> {
	clientSession.searchIncludeArchived = value;
	if (!value && clientSession.searchResults) {
		clientSession.searchResults = clientSession.searchResults.filter(
			(session) => session.archivedAt == null,
		);
	}
	if (activeSearch)
		await searchSessions(activeSearch.query, activeSearch.roots);
}

async function runSearchPage(token: number, replace: boolean): Promise<void> {
	const search = activeSearch;
	const projectSlug = getCurrentSlug();
	if (search === null || !projectSlug) return;
	const cursor = replace ? null : sessionState.searchCursor;
	clientSession.searchLoading = true;
	try {
		const response = await rpc("ListDaemonSessions", {
			projectSlug,
			roots: search.roots,
			search: search.query,
			limit: DAEMON_SESSION_PAGE_SIZE,
			...(search.includeArchived ? { includeArchived: true } : {}),
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

/**
 * This tab forked: select the fork and keep its lineage until the family row
 * arrives. Only the forking tab announces it.
 */
export function followFork(
	from: typeof selection.scope,
	response: ForkSessionResponse,
): void {
	clientSession.announcedFork = {
		sessionId: response.sessionId,
		forkedFrom: response.forkedFrom,
		...(response.forkMessageId && { forkMessageId: response.forkMessageId }),
		...(response.forkPointTimestamp != null && {
			forkPointTimestamp: response.forkPointTimestamp,
		}),
	};
	showToast(
		`Forked from "${findSession(response.forkedFrom)?.title || "session"}"`,
	);
	selection.follow(from, response.sessionId, "push");
}

// Components should wrap these in $derived() for reactive caching.

/** Find a session by id. */
export function findSession(id: string): Immutable<SessionInfo> | undefined {
	return (
		serverSessions.get(id) ??
		familySessions.find((row) => row.id === id) ??
		rootSessions.find((row) => row.id === id) ??
		sessionState.daemonSessions.find((row) => row.id === id) ??
		sessionState.searchResults?.find((row) => row.id === id)
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
	return typeof at === "number" ? at : at ? Date.parse(at) : 0;
}

/** The sidebar and its search show root sessions only. */
export function getFilteredSessions(): SessionInfo[] {
	const scope = getSessionScope();
	const groupKey = getScopeGroupKey(scope);
	const currentSlug = getCurrentSlug();
	const inScope = (session: SessionInfo) => {
		const slug = session.projectSlug;
		return (
			scope === null ||
			(groupKey === null
				? slug === scope
				: getProjectGroup(slug)?.key === groupKey)
		);
	};
	let sessions: SessionInfo[];
	if (sessionState.searchResults !== null) {
		const searchSlug = currentSlug;
		// Root rows carry the subtree rollup, so local search hits use the
		// current shell row rather than a possibly older search result.
		const liveRoots = new Map(
			sessionState.rootSessions.map((session) => [session.id, session]),
		);
		sessions = sessionState.searchResults.flatMap((session) => {
			if (!isFamilyRoot(session) || !inScope(session)) return [];
			if (session.projectSlug !== searchSlug) {
				return [session];
			}
			const liveSession = liveRoots.get(session.id);
			return liveSession
				? [liveSession]
				: session.archivedAt != null
					? [session]
					: [];
		});
	} else {
		const localSessions = sessionState.rootSessions;
		const query = sessionState.searchQuery.toLowerCase().trim();
		// Foreign rows stay in while a query is active and get title-filtered with
		// the rest. The server search they will be replaced by now covers every
		// project too, so the local filter and the landing results agree -- which is
		// why these no longer have to stand down to avoid flashing in and out.
		const foreignSessions = sessionState.daemonSessions.filter(
			(session) => session.projectSlug !== currentSlug && isFamilyRoot(session),
		);
		sessions = [...localSessions, ...foreignSessions].filter(inScope);
		if (query)
			sessions = sessions.filter((s) => s.title.toLowerCase().includes(query));
	}
	return sessions
		.map((session) => ({
			row: withReadMark(session),
			changedAt: lastChangedAt(session),
		}))
		.sort((a, b) => b.changedAt - a.changedAt)
		.map(({ row }) => row);
}

/** Get the currently active session object (or undefined). */
export function getActiveSession(): Immutable<SessionInfo> | undefined {
	return findSession(sessionState.currentId ?? "");
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
	if (!query.trim()) clearSessionSearch();
}

/** Per-session UI state follows what selection shows, including leaving it. */
export function followShownSession(
	sessionId: string | null,
	previousId: string | null,
): void {
	if (previousId !== sessionId) goalDetails.open = false;
	if (previousId && previousId !== sessionId) {
		const activity = sessionActivity.get(previousId);
		if (activity) activity.replayGeneration++;
	}
	if (sessionId) activateSessionChatState(sessionId);
	clearDraftSelection();
	if (clientSession.announcedFork?.sessionId !== sessionId)
		clientSession.announcedFork = null;
	if (previousId !== sessionId) {
		clearTodoState();
	}
}

/**
 * Reload the provider session so it picks up skills/commands added on disk,
 * then refetch the command and model catalogs it changes.
 */
export async function reloadProviderSession(sessionId: string): Promise<void> {
	await rpc("ReloadProviderSession", {
		sessionId,
		commandId: crypto.randomUUID(),
	});
	await refreshCatalogs();
}

/** Clear all session state (for project switch). */
export function clearSessionState(): void {
	const held = [...serverSessions.keys()];
	resetSessionSubscription();
	for (const id of held) forgetSession(id);
	for (const id of new Set([
		...sessionActivity.keys(),
		...sessionMessages.keys(),
	])) {
		clearSessionChatState(id);
	}
	clientSession.announcedFork = null;
	setSearchQuery("");
	resetSessionFamily();
	readMarks.clear();
	clientSession.daemonSessions = [];
	clientSession.daemonUnavailableProjects = [];
	clientSession.daemonCursor = null;
	clientSession.daemonHasMore = false;
	clientSession.daemonLoading = false;
	daemonBrowseToken++;
	clearSessionSearch();
}
