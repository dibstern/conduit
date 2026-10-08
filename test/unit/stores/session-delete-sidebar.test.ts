import {
	applyFamilyFeedChange,
	applySessionChange,
	seedFamilySessions,
	seedSearchResults,
	seedSessions,
} from "./session-fixtures.js";
// A deleted session must leave the sidebar in every UI state, including during
// an active search. The search query keeps its results separate from live rows;
// deletion prunes both the query and the current project's roots.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	let store: Record<string, string> = {};
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (k: string) => store[k] ?? null,
			setItem: (k: string, v: string) => {
				store[k] = v;
			},
			removeItem: (k: string) => {
				delete store[k];
			},
			clear: () => {
				store = {};
			},
			get length() {
				return Object.keys(store).length;
			},
			key: () => null,
		},
		writable: true,
		configurable: true,
	});
});

vi.mock("dompurify", () => ({ default: { sanitize: (h: string) => h } }));

import {
	clearSessionState,
	getFilteredSessions,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";

const VICTIM = {
	id: "victim",
	title: "Doomed Session",
	status: "idle",
	updatedAt: Date.now(),
} satisfies SessionInfo;
const KEEPER = {
	id: "keeper",
	title: "Survivor",
	status: "idle",
	updatedAt: Date.now(),
} satisfies SessionInfo;

beforeEach(() => {
	clearSessionState();
	sessionState.currentId = "keeper";
	seedSessions([VICTIM, KEEPER]);
});

/** Seed the server query result independently of the live session rows. */
const searchFor = (query: string, hits: (typeof VICTIM)[]) => {
	sessionState.searchQuery = query;
	seedSearchResults(hits);
};

const deleteVictim = () =>
	applySessionChange({ _tag: "remove", id: "victim", deleted: true });

const sidebarIds = () => getFilteredSessions().map((s) => s.id);

describe("deleted sessions leave the sidebar", () => {
	it("drops the session with no search active", () => {
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("drops the root even when a family snapshot is loaded", () => {
		seedFamilySessions([VICTIM]);
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("keeps family rows until the family feed removes them", () => {
		const child = {
			id: "child",
			title: "Child",
			status: "idle",
			parentID: "victim",
		} satisfies SessionInfo;
		seedFamilySessions([VICTIM, child]);
		deleteVictim();
		expect(sessionState.familySessions.map((row) => row.id)).toEqual([
			"victim",
			"child",
		]);
		expect(sidebarIds()).toEqual(["keeper"]);
		applyFamilyFeedChange({ _tag: "remove", id: "child" });
		applyFamilyFeedChange({ _tag: "remove", id: "victim" });
		expect(sessionState.familySessions).toEqual([]);
	});

	it("removes a deleted subagent when the family feed removes it", () => {
		const child = {
			id: "child",
			title: "Child",
			status: "idle",
			parentID: "victim",
		} satisfies SessionInfo;
		seedFamilySessions([VICTIM, child]);
		applyFamilyFeedChange({ _tag: "remove", id: "child" });
		expect(sessionState.familySessions.map((row) => row.id)).toEqual([
			"victim",
		]);
	});

	// Regression: search hits used to be a snapshot of rows that took priority in
	// getFilteredSessions and that no removal path pruned, so the row survived
	// until the query was cleared.
	it("drops the session during an active search", () => {
		searchFor("s", [VICTIM, KEEPER]);
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("stays dropped after the feed synchronizes", () => {
		searchFor("s", [VICTIM, KEEPER]);
		deleteVictim();
		applySessionChange({ _tag: "snapshot", rows: [KEEPER] });
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("drops a stale searched session after an authoritative tagged refresh", () => {
		searchFor("s", [VICTIM, KEEPER]);
		applySessionChange({ _tag: "snapshot", rows: [KEEPER] });
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("returns the live renamed session object during an active search", () => {
		const renamed = { ...VICTIM, title: "Renamed Session" };
		searchFor("session", [VICTIM]);
		applySessionChange({ _tag: "upsert", item: renamed });
		expect(getFilteredSessions()).toEqual([renamed]);
	});

	it("clears the live session map with the rest of session state", () => {
		clearSessionState();
		expect(sessionState.sessions.size).toBe(0);
	});

	it("leaves a normal search untouched when nothing was deleted", () => {
		searchFor("s", [VICTIM, KEEPER]);
		expect(sidebarIds()).toEqual(["victim", "keeper"]);
	});
});

describe("root rows keep their subtree rollup", () => {
	it("ignores the root's individual state from a later family snapshot", () => {
		const rolled = { ...VICTIM, attention: "needs-approval" as const };
		applySessionChange({ _tag: "upsert", item: rolled });
		seedFamilySessions([
			{ ...VICTIM, attention: "idle" },
			{
				id: "child",
				title: "Child",
				status: "idle",
				updatedAt: 0,
				parentID: VICTIM.id,
			},
		]);
		// By id: the fixtures' Date.now() stamps can differ by a millisecond,
		// which reorders the newest-first sidebar.
		expect(
			getFilteredSessions().find((session) => session.id === VICTIM.id)
				?.attention,
		).toBe("needs-approval");
		sessionState.searchQuery = "doomed";
		seedSearchResults([VICTIM]);
		expect(getFilteredSessions()).toEqual([rolled]);
	});
});
