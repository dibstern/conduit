import { sessionSubscription } from "../transport/session-subscription.svelte.js";
import { listSessionsRpc } from "../transport/ws-rpc-client.js";
import type { SessionInfo } from "../types.js";
import { flushPendingSeen } from "../utils/attention.js";
import { getCurrentSlug } from "./router.svelte.js";
import {
	applyListSessionsResponse,
	clearSessionSearch,
	getFilteredSessions,
	loadDaemonSessions,
	loadMoreDaemonSessions,
	loadMoreSearchResults,
	searchSessions,
	sessionState,
} from "./session.svelte.js";
import { showToast } from "./ui.svelte.js";

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
	search(query) {
		if (query.trim()) searchReady = searchSessions(query, true);
		else clearSessionSearch();
		return searchQuery;
	},
	loadMore(_project) {
		return loadMoreDaemonSessions();
	},
};

let attachGeneration = 0;

/** Keep today's relay reads behind the list boundary until R6 replaces them. */
export function attachSessionList(project: ProjectRef): void {
	const generation = ++attachGeneration;
	void loadDaemonSessions();
	void listSessionsRpc({ projectSlug: project, roots: true })
		.then((response) => {
			if (generation !== attachGeneration) return;
			applyListSessionsResponse(response);
			flushPendingSeen(project);
		})
		.catch(() => {
			if (generation === attachGeneration)
				showToast("Failed to load sessions", { variant: "error" });
		});
}

export function detachSessionList(): void {
	attachGeneration++;
}

export function refreshSessionList(): Promise<void> {
	return loadDaemonSessions();
}

export function currentSearchQuery(): SearchQuery | null {
	return sessionState.searchResults === null ? null : searchQuery;
}
