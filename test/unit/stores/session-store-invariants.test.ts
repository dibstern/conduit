// ─── Session store invariants ────────────────────────────────────────────────
// The session store is split in two: a server-owned map of `SessionInfo` rows
// written only by the `applySession*` functions, and a client-owned block
// holding this tab's selection and search. These tests hold that line.
//
// The load-bearing claim is that the store's invariants are at least as strong
// as the wire type's: every row in the server half decodes through the wire
// schema, and — the part that catches synthesized rows — deep-equals a row the
// server actually sent.

import { Schema } from "effect";
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

import { SessionInfoSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	chatState,
	sessionActivity,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyListSessionsResponse,
	applySessionRemoved,
	applySessionSnapshot,
	applySessionUpsert,
	clearSessionState,
	getFilteredSessions,
	handleSessionForked,
	handleSessionList,
	handleSessionSwitched,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import type {
	RelayMessage,
	SessionInfo,
} from "../../../src/lib/frontend/types.js";

const decodeSessionInfo = Schema.decodeUnknownSync(SessionInfoSchema);

/** Decode the whole server-owned half through the wire schema. Throws if any
 *  row is not a valid `SessionInfo`. */
const decodeServerHalf = (): readonly (typeof SessionInfoSchema.Type)[] =>
	[...sessionState.sessions.values()].map((row) => decodeSessionInfo(row));

beforeEach(() => {
	clearSessionState();
	uiState.hideSubagentSessions = true;
});

// ─── Loop 1: no invented rows ───────────────────────────────────────────────

describe("the server half holds only rows the server sent", () => {
	it("does not synthesize a row for a session_switched the list has not caught up with", () => {
		handleSessionSwitched({
			type: "session_switched",
			id: "ses_child",
			sessionId: "ses_child",
			parentID: "ses_parent",
		} as Extract<RelayMessage, { type: "session_switched" }>);

		expect(sessionState.currentId).toBe("ses_child");
		expect(sessionState.sessions.has("ses_child")).toBe(false);
		// The partial row this used to insert had `title: ""`, so it rendered as
		// a blank entry in the sidebar whenever subagents were shown.
		uiState.hideSubagentSessions = false;
		expect(getFilteredSessions()).toEqual([]);
	});

	it("records the parent on a row the server has already sent", () => {
		applySessionSnapshot([{ id: "ses_child", title: "Child" }], "complete");
		handleSessionSwitched({
			type: "session_switched",
			id: "ses_child",
			sessionId: "ses_child",
			parentID: "ses_parent",
		} as Extract<RelayMessage, { type: "session_switched" }>);

		expect(sessionState.sessions.get("ses_child")).toEqual({
			id: "ses_child",
			title: "Child",
			parentID: "ses_parent",
		});
	});
});

// ─── Loop 2: one representation ─────────────────────────────────────────────

describe("the server half is one representation", () => {
	it("shows a rename delivered by an all-sessions list in the roots view", () => {
		handleSessionList({
			type: "session_list",
			sessions: [{ id: "a", title: "Old" }],
			roots: true,
		});
		handleSessionList({
			type: "session_list",
			sessions: [{ id: "a", title: "New" }],
			roots: false,
		});

		expect(sessionState.sessions.size).toBe(1);
		expect(getFilteredSessions().map((s) => s.title)).toEqual(["New"]);
	});

	it("reads search hits through the server half, so a rename follows", () => {
		handleSessionList({
			type: "session_list",
			sessions: [{ id: "a", title: "Old" }],
			roots: false,
			search: true,
		});
		applySessionUpsert({ id: "a", title: "Renamed" });

		expect(getFilteredSessions().map((s) => s.title)).toEqual(["Renamed"]);
	});

	it("drops a removed session out of an active search", () => {
		handleSessionList({
			type: "session_list",
			sessions: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
			roots: false,
			search: true,
		});
		applySessionRemoved("a");

		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b"]);
	});
});

// ─── Loop 3: recency ────────────────────────────────────────────────────────

describe("sidebar order", () => {
	it("moves a session to the top when the server reports it as newer", () => {
		applySessionSnapshot(
			[
				{ id: "a", title: "A", updatedAt: 1000 },
				{ id: "b", title: "B", updatedAt: 2000 },
			],
			"complete",
		);
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b", "a"]);

		applySessionUpsert({ id: "a", title: "A", updatedAt: 3000 });
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("falls back to createdAt when the server sends no updatedAt", () => {
		applySessionSnapshot(
			[
				{ id: "a", title: "A", createdAt: 1000 },
				{ id: "b", title: "B", createdAt: 3000 },
			],
			"complete",
		);
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b", "a"]);
	});
});

// ─── Loop 4: the wire schema is the store's invariant ───────────────────────

describe("every mutation path leaves the server half wire-valid", () => {
	const ROWS: SessionInfo[] = [
		{ id: "root", title: "Root", updatedAt: 3000 },
		{
			id: "child",
			title: "Child",
			parentID: "root",
			updatedAt: 2000,
			forkMessageId: "msg_7",
			forkPointTimestamp: 1234,
			pendingQuestionCount: 1,
			messageCount: 12,
			processing: true,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	];

	/** Every row in the server half decodes as a `SessionInfo` *and* is one of
	 *  the rows the server sent — no field dropped, no row invented. */
	const expectWireValid = (sent: readonly SessionInfo[]) => {
		for (const row of decodeServerHalf()) {
			expect(sent).toContainEqual(row);
		}
	};

	it("applySessionSnapshot(complete)", () => {
		applySessionSnapshot(ROWS, "complete");
		expect(sessionState.sessions.size).toBe(2);
		expectWireValid(ROWS);
	});

	it("applySessionSnapshot(partial)", () => {
		applySessionSnapshot(ROWS, "partial");
		expectWireValid(ROWS);
	});

	it("applySessionUpsert", () => {
		applySessionSnapshot(ROWS, "complete");
		const renamed = { ...ROWS[1], title: "Renamed" } as SessionInfo;
		applySessionUpsert(renamed);
		expectWireValid([...ROWS, renamed]);
	});

	it("applySessionRemoved", () => {
		applySessionSnapshot(ROWS, "complete");
		applySessionRemoved("child");
		expect(sessionState.sessions.size).toBe(1);
		expectWireValid(ROWS);
	});

	it("handleSessionList", () => {
		handleSessionList({ type: "session_list", sessions: ROWS, roots: false });
		expectWireValid(ROWS);
	});

	it("handleSessionList (search)", () => {
		handleSessionList({
			type: "session_list",
			sessions: ROWS,
			roots: false,
			search: true,
		});
		expect(sessionState.searchMatchIds).toEqual(["root", "child"]);
		expectWireValid(ROWS);
	});

	it("handleSessionSwitched", () => {
		applySessionSnapshot(ROWS, "complete");
		handleSessionSwitched({
			type: "session_switched",
			id: "child",
			sessionId: "child",
			parentID: "root",
		} as Extract<RelayMessage, { type: "session_switched" }>);
		expectWireValid(ROWS);
	});

	it("handleSessionForked", () => {
		const forked: SessionInfo = {
			id: "forked",
			title: "Forked",
			parentID: "root",
			updatedAt: 4000,
		};
		applySessionSnapshot(ROWS, "complete");
		handleSessionForked({
			type: "session_forked",
			sessionId: "root",
			session: forked,
			parentId: "root",
			parentTitle: "Root",
		});
		expectWireValid([...ROWS, forked]);
	});

	it("applyListSessionsResponse", () => {
		applyListSessionsResponse({
			projectSlug: "p",
			roots: false,
			sessions: ROWS,
		});
		expectWireValid(ROWS);
	});

	it("session_deleted through the dispatcher", () => {
		applySessionSnapshot(ROWS, "complete");
		handleMessage({
			type: "session_deleted",
			sessionId: "child",
		} as RelayMessage);
		expect(sessionState.sessions.has("child")).toBe(false);
		expectWireValid(ROWS);
	});
});

// ─── The client half survives server writes ─────────────────────────────────

describe("applying server rows never touches the client half", () => {
	it("keeps the selection and the search query", () => {
		sessionState.currentId = "root";
		sessionState.searchQuery = "roo";

		applySessionSnapshot([{ id: "root", title: "Root" }], "complete");
		applySessionUpsert({ id: "other", title: "Other" });
		applySessionRemoved("other");

		expect(sessionState.currentId).toBe("root");
		expect(sessionState.searchQuery).toBe("roo");
	});
});

// ─── A deleted session is not "the session being viewed" ────────────────────

describe("deleting the session being viewed", () => {
	it("does not let a later event rebuild the chat state deletion threw away", async () => {
		vi.useFakeTimers();
		try {
			applySessionUpsert({ id: "ses_doomed", title: "Doomed" });
			sessionState.currentId = "ses_doomed";
			handleMessage({
				type: "status",
				sessionId: "ses_doomed",
				status: "processing",
			} as RelayMessage);
			expect(sessionActivity.has("ses_doomed")).toBe(true);

			// The server deletes it. Deleting the last session leaves no other to
			// switch us to, so nothing else moves the selection.
			handleMessage({
				type: "session_deleted",
				sessionId: "ses_doomed",
			} as RelayMessage);
			expect(sessionState.sessions.has("ses_doomed")).toBe(false);
			expect(sessionActivity.has("ses_doomed")).toBe(false);

			// A status that was already in flight when it went.
			handleMessage({
				type: "status",
				sessionId: "ses_doomed",
				status: "processing",
			} as RelayMessage);
			await vi.advanceTimersByTimeAsync(200);

			expect(sessionActivity.has("ses_doomed")).toBe(false);
			expect(sessionState.currentId).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── Characterization: the session being viewed is always routable ──────────

describe("event routing for the session being viewed", () => {
	it("routes events for the selected session before its row arrives", async () => {
		vi.useFakeTimers();
		try {
			handleMessage({
				type: "session_switched",
				id: "ses_new",
				sessionId: "ses_new",
			} as RelayMessage);
			expect(sessionState.sessions.has("ses_new")).toBe(false);

			handleMessage({
				type: "delta",
				sessionId: "ses_new",
				text: "hello",
			} as RelayMessage);
			await vi.advanceTimersByTimeAsync(200);

			expect(chatState.messages.length).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
