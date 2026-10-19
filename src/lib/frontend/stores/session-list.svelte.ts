import { Effect, Fiber, Stream } from "effect";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import {
	applySessionChange,
	discardForeignSavedShell,
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

let attachGeneration = 0;
let shellFiber: Fiber.Fiber<void, unknown> | null = null;
let shellSaveTimer: ReturnType<typeof setTimeout> | undefined;
let attachedProject: ProjectRef | null = null;
accountSnapshotChangedListeners.add(({ firstList }) => {
	if (firstList || attachedProject === null) return;
	const project = attachedProject;
	detachSessionList();
	attachSessionList(project);
});
const shellSynchronizedListeners = new Set<(project: ProjectRef) => void>();

export function onShellSynchronized(
	fn: (project: ProjectRef) => void,
): () => void {
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

export function attachSessionList(project: ProjectRef = ""): void {
	if (attachedProject !== null) {
		attachedProject = project;
		return;
	}
	const generation = ++attachGeneration;
	discardForeignSavedShell(project);
	if (attachedProject !== project) setShellFeedStatus({ _tag: "cold" });
	attachedProject = project;
	let synchronized = false;
	const save = () => {
		if (generation !== attachGeneration) return;
		clearTimeout(shellSaveTimer);
		shellSaveTimer = undefined;
		if (synchronized && attachedProject)
			void saveShell(attachedProject, [...sessionSubscription.rows.values()]);
	};
	void stopShell().then(async () => {
		const runtime = await getRuntime();
		if (generation !== attachGeneration) return;
		const fiber = runtime.runFork(
			Effect.flatMap(WsRpcClients, (clients) =>
				Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
					Stream.runForEach(
						supervise(
							subscriptions.shell({
								onTransportDrop: () => {
									if (generation === attachGeneration) noteTransportDrop();
								},
							}),
							(status) => {
								if (generation !== attachGeneration) return;
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
								if (generation !== attachGeneration) return;
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
									for (const listener of shellSynchronizedListeners)
										listener(attachedProject ?? "");
									void refreshListedSessions();
								} else if (synchronized && shellSaveTimer === undefined) {
									shellSaveTimer = setTimeout(save, 3_000);
								}
							}),
					),
				),
			),
		);
		if (generation === attachGeneration) shellFiber = fiber;
		else runtime.runFork(Fiber.interrupt(fiber));
	});
}

export function detachSessionList(): void {
	attachGeneration++;
	void stopShell();
	attachedProject = null;
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
