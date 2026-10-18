// @vitest-environment jsdom
import { clearSessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { sessionList } from "../../../src/lib/frontend/stores/session-list.svelte.js";
import {
	applySessionRemoved,
	seedFamilySessions,
	seedRootSessions,
	seedSessions,
} from "./session-fixtures.js";
// Cross-project paged search stays separate from the daemon-wide live feed.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: vi.fn(),
}));

import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionSearch,
	DAEMON_SESSION_PAGE_SIZE,
	getFilteredSessions,
	loadMoreSearchResults,
	searchSessions,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import type { ListDaemonSessionsResponse } from "../../../src/lib/frontend/transport/ws-rpc.js";
import { rpc as callRpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

const rpc = vi.mocked(callRpc<"ListDaemonSessions">);

/** Rows are named after their position in the full expected ordering, so a
 *  duplicate, a gap or a reorder is visible in the assertion itself. */
function row(index: number, projectSlug: string) {
	return {
		accountId: null,
		id: `s${index}`,
		title: `Session ${index}`,
		status: "idle" as const,
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
	};
}

beforeEach(() => {
	clearSessionState();
	rpc.mockReset();
	seedRootSessions([]);
	seedFamilySessions([]);
	openSessionForSetup(null);
	sessionState.searchQuery = "";
	clearSessionSearch();
	routerState.path = "/";
	attachedProjectState.slug = "project-a";
	routerState.search = "";
});

it("keeps search results separate from live session rows", async () => {
	seedSessions([{ id: "local", title: "Live", projectSlug: "project-a" }]);
	rpc.mockResolvedValueOnce(
		page([1], { hasMore: false, projectSlug: "project-b" }),
	);

	const query = sessionList.search("match");
	await query.ready;
	expect(query.results.map((row) => row.id)).toEqual(["s1"]);
	expect(sessionState.sessions.has("s1")).toBe(false);
	expect(sessionState.rootSessions.map((row) => row.id)).toEqual(["local"]);
});

describe("cross-project search", () => {
	it("searches every project through the daemon query, not just this one", async () => {
		rpc.mockResolvedValueOnce(page([0, 1], { hasMore: false }));

		await searchSessions("  session  ", true);

		expect(rpc).toHaveBeenCalledWith("ListDaemonSessions", {
			projectSlug: "project-a",
			roots: true,
			search: "session",
			limit: DAEMON_SESSION_PAGE_SIZE,
		});
		expect(sessionState.searchResults?.map((s) => s.id)).toEqual(["s0", "s1"]);
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

	it("drops a session deleted mid-search but keeps another project's live match", async () => {
		const local = {
			id: "local",
			title: "Local session",
			projectSlug: "project-a",
			updatedAt: 1000,
		};
		seedRootSessions([local, row(1, "project-b")]);
		rpc.mockResolvedValueOnce({
			...page([], { hasMore: false }),
			sessions: [
				{
					accountId: null,
					id: "local",
					title: "Local session",
					status: "idle",
					projectSlug: "project-a",
				},
				{
					accountId: null,
					id: "s1",
					title: "Session 1",
					status: "idle",
					projectSlug: "project-b",
				},
			],
		});
		await searchSessions("session", true);

		expect(getFilteredSessions().map((s) => s.id)).toEqual(["local", "s1"]);

		// Deletion updates the same live collection used to reconcile search.
		applySessionRemoved("local");

		expect(getFilteredSessions().map((s) => s.id)).toEqual(["s1"]);
	});
});

describe("project scope", () => {
	const local = { id: "local", title: "Local session" };

	beforeEach(() => {
		routerState.search = "?p=project-b";
		seedRootSessions([local, row(1, "project-b")]);
	});

	it("scopes the search as well", async () => {
		rpc.mockResolvedValueOnce(
			page([1], { hasMore: false, projectSlug: "project-b" }),
		);

		await searchSessions("session", true);

		expect(rpc).toHaveBeenCalledWith(
			"ListDaemonSessions",
			expect.objectContaining({ scope: "project-b" }),
		);
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["s1"]);
	});
});
