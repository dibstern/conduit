import { seedSearchResults, seedSessions } from "./session-fixtures.js";
// ─── Sidebar removal on delete ────────────────────────────────────────────────
// The sidebar (SessionList.svelte) renders getAttentionGroups() -> getFilteredSessions().
// A deleted session must leave that list in every UI state, including during an
// active search. The store holds server search hits as ids, not rows, so the
// search view reads through the one server-owned map and a removal there is
// immediately visible — there is no second copy to prune.

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
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";
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

/** Seed an active server search the way SessionList does: the query is the
 *  client's, the hits arrive as a searched session_list. */
const searchFor = (query: string, hits: (typeof VICTIM)[]) => {
	sessionState.searchQuery = query;
	handleMessage({
		type: "session_list",
		sessions: hits,
		search: true,
	} as RelayMessage);
};

const deleteVictim = () =>
	handleMessage({
		type: "session_deleted",
		sessionId: "victim",
	} as RelayMessage);

const sidebarIds = () => getFilteredSessions().map((s) => s.id);

describe("deleted sessions leave the sidebar", () => {
	it("drops the session with no search active", () => {
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("drops the root even when a family snapshot is loaded", () => {
		handleMessage({
			type: "session_family",
			rootId: "victim",
			sessions: [VICTIM],
		});
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("drops the session from the family cache too", () => {
		const child = {
			id: "child",
			title: "Child",
			status: "idle",
			parentID: "victim",
		} satisfies SessionInfo;
		handleMessage({
			type: "session_family",
			rootId: "victim",
			sessions: [VICTIM, child],
		});
		deleteVictim();
		expect(sessionState.familySessions.map((row) => row.id)).toEqual(["child"]);
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("drops a visible subagent from the family when it is deleted", () => {
		const child = {
			id: "child",
			title: "Child",
			status: "idle",
			parentID: "victim",
		} satisfies SessionInfo;
		handleMessage({
			type: "session_family",
			rootId: "victim",
			sessions: [VICTIM, child],
		});
		handleMessage({ type: "session_deleted", sessionId: "child" });
		expect(sessionState.familySessions.map((row) => row.id)).toEqual([
			"victim",
		]);
		expect(sidebarIds()).toEqual(["victim", "keeper"]);
	});

	// Regression: search hits used to be a snapshot of rows that took priority in
	// getFilteredSessions and that no removal path pruned, so the row survived
	// until the query was cleared.
	it("drops the session during an active search", () => {
		searchFor("s", [VICTIM, KEEPER]);
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("stays dropped after the server's follow-up session_list broadcast", () => {
		searchFor("s", [VICTIM, KEEPER]);
		deleteVictim();
		handleMessage({
			type: "session_list",
			sessions: [KEEPER],
			roots: true,
		} as RelayMessage);
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("drops a stale searched session after an authoritative tagged refresh", () => {
		searchFor("s", [VICTIM, KEEPER]);
		handleMessage({
			type: "session_list",
			sessions: [KEEPER],
			roots: true,
		} as RelayMessage);
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("returns the live renamed session object during an active search", () => {
		const renamed = { ...VICTIM, title: "Renamed Session" };
		searchFor("session", [VICTIM]);
		handleMessage({
			type: "session_list",
			sessions: [renamed, KEEPER],
			roots: true,
		} as RelayMessage);
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
		handleMessage({
			type: "session_list",
			sessions: [rolled, KEEPER],
			roots: true,
		} as RelayMessage);
		handleMessage({
			type: "session_family",
			rootId: VICTIM.id,
			sessions: [
				{ ...VICTIM, attention: "idle" },
				{
					id: "child",
					title: "Child",
					status: "idle",
					updatedAt: 0,
					parentID: VICTIM.id,
				},
			],
		} as RelayMessage);
		expect(getFilteredSessions()[0]?.attention).toBe("needs-approval");
		sessionState.searchQuery = "doomed";
		seedSearchResults([VICTIM]);
		expect(getFilteredSessions()).toEqual([rolled]);
	});
});
