import { Effect, Fiber, Stream } from "effect";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import {
	applySessionChange,
	noteTransportDrop,
	sessionSubscription,
	setShellFeedStatus,
} from "../transport/session-subscription.svelte.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { type FeedStatus, supervise } from "../transport/supervise.js";
import type { SessionInfo } from "../types.js";
import { flushPendingSeen } from "../utils/attention.js";
import { projectState } from "./project-state.svelte.js";
import { saveShell } from "./saved-shell.js";
import {
	clearSessionSearch,
	DAEMON_SESSION_PAGE_SIZE,
	getFilteredSessions,
	getSettledSessionCount,
	loadMoreSearchResults,
	searchSessions,
	sessionState,
} from "./session.svelte.js";
import { accountSnapshotChangedListeners } from "./ws-listeners.js";

/** Paint the device's saved sidebar rows until the live snapshot lands. */
export { drawSavedShell } from "../transport/session-subscription.svelte.js";

type ProjectRef = string;
type SessionRow = SessionInfo;

export interface SearchQuery {
	readonly results: readonly SessionRow[];
	readonly hasMore: boolean;
	readonly loading: boolean;
	readonly ready: Promise<void>;
	loadMore(): Promise<void>;
	clear(): void;
}

export interface SessionListView {
	readonly rows: readonly SessionRow[];
	readonly settledCount: { readonly count: number; readonly exact: boolean };
	readonly settled: boolean;
	readonly status: FeedStatus;
	readonly staleSince: number | null;
	search(query: string): SearchQuery;
	loadMore(project: ProjectRef): Promise<void>;
}

// This store is imported while session.svelte.ts is still initializing.
export const browsePage = $state({ limit: 30 });

let searchReady: Promise<void> = Promise.resolve();
const searchQuery: SearchQuery = {
	get results() {
		return sessionState.searchResults ?? [];
	},
	get hasMore() {
		return sessionState.searchHasMore;
	},
	get loading() {
		return sessionState.searchLoading;
	},
	get ready() {
		return searchReady;
	},
	loadMore: () => loadMoreSearchResults(),
	clear: () => clearSessionSearch(),
};

// The count and list read the same array until its dependencies change.
const rows = $derived.by(() => getFilteredSessions());

export const sessionList: SessionListView = {
	get rows() {
		return rows;
	},
	get settledCount() {
		return getSettledSessionCount();
	},
	get settled() {
		return (
			sessionSubscription.settled && sessionSubscription.status._tag === "live"
		);
	},
	get status() {
		return sessionSubscription.status;
	},
	get staleSince() {
		const status = sessionSubscription.status;
		return status._tag === "failing" ? status.since : null;
	},
	search(query) {
		if (query.trim()) searchReady = searchSessions(query, true);
		else {
			clearSessionSearch();
			browsePage.limit = DAEMON_SESSION_PAGE_SIZE;
		}
		return searchQuery;
	},
	loadMore(_project) {
		if (browsePage.limit < rows.length)
			browsePage.limit += DAEMON_SESSION_PAGE_SIZE;
		return Promise.resolve();
	},
};

let followGeneration = 0;
let shellFiber: Fiber.Fiber<void, unknown> | null = null;
let shellSaveTimer: ReturnType<typeof setTimeout> | undefined;
let following = false;
accountSnapshotChangedListeners.add(({ firstList }) => {
	if (firstList || !following) return;
	stopFollowingSessionList();
	followSessionList();
});
const shellSynchronizedListeners = new Set<() => void>();

export function onShellSynchronized(fn: () => void): () => void {
	shellSynchronizedListeners.add(fn);
	return () => shellSynchronizedListeners.delete(fn);
}

async function stopShell(): Promise<void> {
	clearTimeout(shellSaveTimer);
	shellSaveTimer = undefined;
	const fiber = shellFiber;
	shellFiber = null;
	if (fiber) await runTransportEffect(Fiber.interrupt(fiber));
}

/** The sidebar follows the daemon-wide shell feed for the page's life (m379.5). */
export function followSessionList(): void {
	if (following) return;
	following = true;
	const generation = ++followGeneration;
	let synchronized = false;
	const save = () => {
		if (generation !== followGeneration) return;
		clearTimeout(shellSaveTimer);
		shellSaveTimer = undefined;
		if (synchronized) void saveShell([...sessionSubscription.rows.values()]);
	};
	void stopShell().then(async () => {
		const runtime = await getRuntime();
		if (generation !== followGeneration) return;
		const fiber = runtime.runFork(
			Effect.flatMap(WsRpcClients, (clients) =>
				Effect.flatMap(clients.forProject(""), ({ subscriptions }) =>
					Stream.runForEach(
						supervise(
							subscriptions.shell({
								onTransportDrop: () => {
									if (generation === followGeneration) noteTransportDrop();
								},
							}),
							(status) => {
								if (generation !== followGeneration) return;
								const previous = sessionSubscription.status;
								if (previous._tag === "failing" && status._tag !== "live") {
									if (status._tag === "failing")
										setShellFeedStatus({ ...status, since: previous.since });
									return;
								}
								setShellFeedStatus(status);
							},
						),
						(change) =>
							Effect.sync(() => {
								if (generation !== followGeneration) return;
								applySessionChange(change);
								if (change._tag === "projects") return;
								if (change._tag === "snapshot") {
									synchronized = false;
									clearTimeout(shellSaveTimer);
									shellSaveTimer = undefined;
								}
								if (change._tag === "synchronized") {
									synchronized = true;
									save();
									for (const { slug } of projectState.projects)
										flushPendingSeen(slug);
									for (const listener of shellSynchronizedListeners) listener();
									void refreshListedSessions();
								} else if (synchronized && shellSaveTimer === undefined) {
									shellSaveTimer = setTimeout(save, 3_000);
								}
							}),
					),
				),
			),
		);
		if (generation === followGeneration) shellFiber = fiber;
		else runtime.runFork(Fiber.interrupt(fiber));
	});
}

export function stopFollowingSessionList(): void {
	followGeneration++;
	void stopShell();
	following = false;
	setShellFeedStatus({ _tag: "cold" });
}

export function currentSearchQuery(): SearchQuery | null {
	return sessionState.searchResults === null ? null : searchQuery;
}

/** Only paged search needs a fresh read; browse rows follow the shell feed. */
export function refreshListedSessions(): Promise<void> {
	return currentSearchQuery() === null
		? Promise.resolve()
		: sessionList.search(sessionState.searchQuery).ready;
}
