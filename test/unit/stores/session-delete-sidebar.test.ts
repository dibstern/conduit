// ─── Sidebar removal on delete ────────────────────────────────────────────────
// The sidebar (SessionList.svelte) renders getDateGroups() -> getFilteredSessions().
// A deleted session must leave that list in every UI state, including during an
// active search — searchResults is a snapshot no removal path writes to, so it
// has to be reconciled against the live session map at read time.

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
	getFilteredSessions,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";

const VICTIM = { id: "victim", title: "Doomed Session", updatedAt: Date.now() };
const KEEPER = { id: "keeper", title: "Survivor", updatedAt: Date.now() };

beforeEach(() => {
	sessionState.currentId = "keeper";
	sessionState.rootSessions = [VICTIM, KEEPER];
	sessionState.allSessions = [VICTIM, KEEPER];
	sessionState.searchResults = null;
	sessionState.searchQuery = "";
	sessionState.sessions.clear();
	sessionState.sessions.set(VICTIM.id, VICTIM);
	sessionState.sessions.set(KEEPER.id, KEEPER);
	uiState.hideSubagentSessions = true;
});

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

	it("drops the session when subagents are shown (allSessions path)", () => {
		uiState.hideSubagentSessions = false;
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	// Regression: searchResults took priority in getFilteredSessions but was
	// never pruned by the delete path, so the row survived until the query
	// was cleared. The server's follow-up session_list can't rescue it either,
	// because handleSessionList only clears searchResults when the query is empty.
	it("drops the session during an active search", () => {
		sessionState.searchQuery = "s";
		sessionState.searchResults = [VICTIM, KEEPER];
		deleteVictim();
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("stays dropped after the server's follow-up session_list broadcast", () => {
		sessionState.searchQuery = "s";
		sessionState.searchResults = [VICTIM, KEEPER];
		deleteVictim();
		handleMessage({
			type: "session_list",
			sessions: [KEEPER],
			roots: true,
		} as RelayMessage);
		expect(sidebarIds()).toEqual(["keeper"]);
	});

	it("leaves a normal search untouched when nothing was deleted", () => {
		sessionState.searchQuery = "s";
		sessionState.searchResults = [VICTIM, KEEPER];
		expect(sidebarIds()).toEqual(["victim", "keeper"]);
	});
});
