// ─── Cross-project session paging and search (store level) ──────────────────
// These assert over the store's data, not over rendering: paging and ordering
// are properties of the accumulator, and a DOM test would only be able to see
// them through whatever the sidebar happens to group and sort today.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	createSessionRpc: vi.fn(),
	getAgentsRpc: vi.fn(),
	getCommandsRpc: vi.fn(),
	getModelsRpc: vi.fn(),
	listDaemonSessionsRpc: vi.fn(),
	switchPermissionModeRpc: vi.fn(),
	viewSessionRpc: vi.fn(),
}));

import {
	routerState,
	syncSlugState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applyListDaemonSessionsResponse,
	clearSessionSearch,
	DAEMON_SESSION_PAGE_SIZE,
	getFilteredSessions,
	loadMoreDaemonSessions,
	loadMoreSearchResults,
	searchSessions,
	sessionState,
	setSearchQuery,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import type { ListDaemonSessionsResponse } from "../../../src/lib/frontend/transport/ws-rpc.js";
import { listDaemonSessionsRpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

const rpc = vi.mocked(listDaemonSessionsRpc);

/** Rows are named after their position in the full expected ordering, so a
 *  duplicate, a gap or a reorder is visible in the assertion itself. */
function row(index: number, projectSlug: string) {
	return {
		id: `s${index}`,
		title: `Session ${index}`,
		projectSlug,
		updatedAt: 1000 - index,
	};
}

function page(
	indices: number[],
	options: { hasMore: boolean; projectSlug?: string } = { hasMore: false },
): ListDaemonSessionsResponse {
	const sessions = indices.map((index) =>
		row(
			index,
			options.projectSlug ?? (index % 2 === 0 ? "project-a" : "project-b"),
		),
	);
	const last = sessions.at(-1);
	return {
		projectSlug: "project-a",
		sessions,
		availability: [
			{ projectSlug: "project-a", available: true },
			{ projectSlug: "project-b", available: true },
		],
		hasMore: options.hasMore,
		nextCursor:
			options.hasMore && last
				? { updatedAt: last.updatedAt, id: last.id }
				: null,
	} as ListDaemonSessionsResponse;
}

beforeEach(() => {
	rpc.mockReset();
	sessionState.rootSessions = [];
	sessionState.familySessions = [];
	sessionState.daemonSessions = [];
	sessionState.daemonUnavailableProjects = [];
	sessionState.daemonCursor = null;
	sessionState.daemonHasMore = false;
	sessionState.daemonLoading = false;
	sessionState.currentId = null;
	sessionState.sessions.clear();
	sessionState.searchQuery = "";
	clearSessionSearch();
	routerState.path = "/p/project-a";
	syncSlugState(routerState.path);
});

describe("cross-project browse paging", () => {
	it("keeps the cursor and the more-pages flag from the first page", () => {
		applyListDaemonSessionsResponse(page([0, 1], { hasMore: true }));

		expect(sessionState.daemonSessions.map((s) => s.id)).toEqual(["s0", "s1"]);
		expect(sessionState.daemonHasMore).toBe(true);
		expect(sessionState.daemonCursor).toEqual({ updatedAt: 999, id: "s1" });
	});

	it("appends page by page in order, each row exactly once", async () => {
		applyListDaemonSessionsResponse(page([0, 1], { hasMore: true }));
		rpc.mockResolvedValueOnce(page([2, 3], { hasMore: true }));
		await loadMoreDaemonSessions();
		rpc.mockResolvedValueOnce(page([4, 5], { hasMore: false }));
		await loadMoreDaemonSessions();

		expect(sessionState.daemonSessions.map((s) => s.id)).toEqual([
			"s0",
			"s1",
			"s2",
			"s3",
			"s4",
			"s5",
		]);
		expect(sessionState.daemonHasMore).toBe(false);
		expect(sessionState.daemonCursor).toBeNull();
	});

	it("asks for the next page with the cursor it was handed", async () => {
		applyListDaemonSessionsResponse(page([0, 1], { hasMore: true }));
		rpc.mockResolvedValueOnce(page([2], { hasMore: false }));

		await loadMoreDaemonSessions();

		expect(rpc).toHaveBeenCalledWith({
			projectSlug: "project-a",
			limit: DAEMON_SESSION_PAGE_SIZE,
			cursor: { updatedAt: 999, id: "s1" },
		});
	});

	it("stops requesting once the list is exhausted, and clears loading", async () => {
		applyListDaemonSessionsResponse(page([0, 1], { hasMore: false }));

		await loadMoreDaemonSessions();
		await loadMoreDaemonSessions();

		expect(rpc).not.toHaveBeenCalled();
		expect(sessionState.daemonLoading).toBe(false);
	});

	it("issues one request when the sentinel fires twice before a page lands", async () => {
		applyListDaemonSessionsResponse(page([0], { hasMore: true }));
		rpc.mockResolvedValue(page([1], { hasMore: false }));

		await Promise.all([loadMoreDaemonSessions(), loadMoreDaemonSessions()]);

		expect(rpc).toHaveBeenCalledTimes(1);
	});

	it("drops a row the next page repeats rather than duplicating its key", async () => {
		applyListDaemonSessionsResponse(page([0, 1], { hasMore: true }));
		rpc.mockResolvedValueOnce(page([1, 2], { hasMore: false }));

		await loadMoreDaemonSessions();

		expect(sessionState.daemonSessions.map((s) => s.id)).toEqual([
			"s0",
			"s1",
			"s2",
		]);
	});

	it("keeps the rows already shown when a page fails, and allows a retry", async () => {
		applyListDaemonSessionsResponse(page([0], { hasMore: true }));
		rpc.mockRejectedValueOnce(new Error("socket closed"));

		await loadMoreDaemonSessions();

		expect(sessionState.daemonSessions.map((s) => s.id)).toEqual(["s0"]);
		expect(sessionState.daemonHasMore).toBe(true);
		expect(sessionState.daemonLoading).toBe(false);

		rpc.mockResolvedValueOnce(page([1], { hasMore: false }));
		await loadMoreDaemonSessions();
		expect(sessionState.daemonSessions.map((s) => s.id)).toEqual(["s0", "s1"]);
	});
});

describe("cross-project search", () => {
	it("searches every project through the daemon query, not just this one", async () => {
		rpc.mockResolvedValueOnce(page([0, 1], { hasMore: false }));

		await searchSessions("  session  ", true);

		expect(rpc).toHaveBeenCalledWith({
			projectSlug: "project-a",
			roots: true,
			search: "session",
			limit: DAEMON_SESSION_PAGE_SIZE,
		});
		expect(sessionState.searchResults?.map((s) => s.id)).toEqual(["s0", "s1"]);
	});

	it("pages the filtered set on its own cursor, leaving the browse page alone", async () => {
		applyListDaemonSessionsResponse(page([0, 1], { hasMore: true }));
		const browseCursor = sessionState.daemonCursor;

		rpc.mockResolvedValueOnce(page([2, 3], { hasMore: true }));
		await searchSessions("session", true);
		rpc.mockResolvedValueOnce(page([4], { hasMore: false }));
		await loadMoreSearchResults();

		expect(sessionState.searchResults?.map((s) => s.id)).toEqual([
			"s2",
			"s3",
			"s4",
		]);
		expect(sessionState.searchHasMore).toBe(false);
		expect(sessionState.daemonSessions.map((s) => s.id)).toEqual(["s0", "s1"]);
		expect(sessionState.daemonCursor).toEqual(browseCursor);
	});

	it("restores the browse page it was hiding when the search is cleared", async () => {
		applyListDaemonSessionsResponse(page([0, 1], { hasMore: true }));
		rpc.mockResolvedValueOnce(page([2], { hasMore: false }));
		await searchSessions("session", true);

		clearSessionSearch();
		setSearchQuery("");

		expect(sessionState.searchResults).toBeNull();
		expect(sessionState.daemonSessions.map((s) => s.id)).toEqual(["s0", "s1"]);
		// s0 belongs to the attached project, so it comes out of the local arrays
		// rather than the cross-project accumulator; s1 is the foreign row.
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["s1"]);
	});

	it("stops requesting at the end of the filtered set", async () => {
		rpc.mockResolvedValueOnce(page([0], { hasMore: false }));
		await searchSessions("session", true);
		rpc.mockReset();

		await loadMoreSearchResults();

		expect(rpc).not.toHaveBeenCalled();
		expect(sessionState.searchLoading).toBe(false);
	});

	it("ignores a page that lands after its query was superseded", async () => {
		let release: (value: ListDaemonSessionsResponse) => void = () => {};
		rpc.mockReturnValueOnce(
			new Promise<ListDaemonSessionsResponse>((resolve) => {
				release = resolve;
			}),
		);
		const stale = searchSessions("old", true);

		rpc.mockResolvedValueOnce(page([9], { hasMore: false }));
		await searchSessions("new", true);
		release(page([0], { hasMore: true }));
		await stale;

		expect(sessionState.searchResults?.map((s) => s.id)).toEqual(["s9"]);
		expect(sessionState.searchHasMore).toBe(false);
	});

	it("drops a local session deleted mid-search but keeps foreign matches", async () => {
		const local = {
			id: "local",
			title: "Local session",
			projectSlug: "project-a",
		};
		sessionState.rootSessions = [local];
		sessionState.sessions.set(local.id, local);
		rpc.mockResolvedValueOnce({
			...page([], { hasMore: false }),
			sessions: [
				{ id: "local", title: "Local session", projectSlug: "project-a" },
				{ id: "s1", title: "Session 1", projectSlug: "project-b" },
			],
		} as ListDaemonSessionsResponse);
		await searchSessions("session", true);

		expect(getFilteredSessions().map((s) => s.id)).toEqual(["local", "s1"]);

		// The delete paths only ever touch the live map and the local arrays.
		sessionState.sessions.delete("local");
		sessionState.rootSessions = [];

		expect(getFilteredSessions().map((s) => s.id)).toEqual(["s1"]);
	});
});
