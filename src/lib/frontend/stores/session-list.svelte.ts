import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
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
import { getCurrentSlug } from "./router.svelte.js";
import {
	clearSessionSearch,
	getFilteredSessions,
	loadDaemonSessions,
	loadMoreDaemonSessions,
	loadMoreSearchResults,
	searchSessions,
	sessionState,
} from "./session.svelte.js";

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
	readonly groups: readonly {
		project: ProjectRef;
		rows: readonly SessionRow[];
	}[];
	readonly settled: boolean;
	readonly status: FeedStatus;
	readonly staleSince: number | null;
	search(query: string): SearchQuery;
	loadMore(project: ProjectRef): Promise<void>;
}

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

export const sessionList: SessionListView = {
	get groups() {
		const groups: { project: ProjectRef; rows: SessionRow[] }[] = [];
		// Keep the current cross-project order when callers flatten the groups.
		for (const row of getFilteredSessions()) {
			const project = row.projectSlug ?? getCurrentSlug() ?? "";
			const last = groups.at(-1);
			if (last?.project === project) last.rows.push(row);
			else groups.push({ project, rows: [row] });
		}
		return groups;
	},
	get settled() {
		return sessionSubscription.status._tag === "live";
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
		else clearSessionSearch();
		return searchQuery;
	},
	loadMore(project) {
		return project === getCurrentSlug()
			? loadMoreDaemonSessions()
			: Promise.resolve();
	},
};

let attachGeneration = 0;
let shellFiber: RuntimeFiber<void, unknown> | null = null;
let attachedProject: ProjectRef | null = null;

async function stopShell(): Promise<void> {
	const fiber = shellFiber;
	shellFiber = null;
	if (fiber) await runTransportEffect(Fiber.interrupt(fiber));
}

export function attachSessionList(project: ProjectRef): void {
	const generation = ++attachGeneration;
	void loadDaemonSessions();
	if (attachedProject !== project) setShellFeedStatus({ _tag: "cold" });
	attachedProject = project;
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
								if (change._tag === "synchronized") flushPendingSeen(project);
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

export function refreshSessionList(): Promise<void> {
	return loadDaemonSessions();
}

export function currentSearchQuery(): SearchQuery | null {
	return sessionState.searchResults === null ? null : searchQuery;
}
