import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applySessionChange,
	applySessionRemoved,
	applySessionSnapshot,
	applySessionUpsert,
	seedSearchResults,
} from "./session-fixtures.js";
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
import { sessionActivity } from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearSessionState,
	followFork,
	getFilteredSessions,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

const decodeSessionInfo = Schema.decodeUnknownSync(SessionInfoSchema);

/** Decode the whole server-owned half through the wire schema. Throws if any
 *  row is not a valid `SessionInfo`. */
const decodeServerHalf = (): readonly (typeof SessionInfoSchema.Type)[] =>
	[...sessionState.sessions.values()].map((row) => decodeSessionInfo(row));

beforeEach(() => {
	clearSessionState();
});

describe("the server half holds only rows the server sent", () => {
	it("does not synthesize a row for a selected session whose list has not caught up", () => {
		sessionState.currentId = "ses_child";

		expect(sessionState.currentId).toBe("ses_child");
		expect(sessionState.sessions.has("ses_child")).toBe(false);
		// The partial row this used to insert had `title: ""`, so it rendered as
		// a blank entry in the sidebar whenever subagents were shown.
		expect(getFilteredSessions()).toEqual([]);
	});

	it("keeps a listed row unchanged while exposing announced parent lineage", () => {
		applySessionSnapshot(
			[{ id: "ses_child", title: "Child", status: "idle" }],
			"complete",
		);
		sessionState.currentId = "ses_child";
		followFork({
			projectSlug: "p",
			sessionId: "ses_child",
			parentId: "ses_parent",
		});

		expect(sessionState.sessions.get("ses_child")).toEqual({
			id: "ses_child",
			title: "Child",
			status: "idle",
		});
		expect(sessionState.currentParentId).toBe("ses_parent");
	});
});

describe("the server half is one representation", () => {
	it("shows a rename delivered by a new root snapshot", () => {
		applySessionSnapshot(
			[{ id: "a", title: "Old", status: "idle" }],
			"complete",
		);
		applySessionSnapshot(
			[{ id: "a", title: "New", status: "idle" }],
			"complete",
		);

		expect(sessionState.sessions.size).toBe(1);
		expect(getFilteredSessions().map((s) => s.title)).toEqual(["New"]);
	});

	it("reads search hits through the server half, so a rename follows", () => {
		applySessionSnapshot(
			[{ id: "a", title: "Old", status: "idle" }],
			"complete",
		);
		seedSearchResults([{ id: "a", title: "Old" }]);
		applySessionUpsert({ id: "a", title: "Renamed", status: "idle" });

		expect(getFilteredSessions().map((s) => s.title)).toEqual(["Renamed"]);
	});

	it("drops a removed session out of an active search", () => {
		applySessionSnapshot(
			[
				{ id: "a", title: "A", status: "idle" },
				{ id: "b", title: "B", status: "idle" },
			],
			"complete",
		);
		seedSearchResults([
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
		]);
		applySessionRemoved("a");

		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b"]);
	});
});

describe("sidebar order", () => {
	it("moves a session to the top when the server reports it as newer", () => {
		applySessionSnapshot(
			[
				{ id: "a", title: "A", status: "idle", updatedAt: 1000 },
				{ id: "b", title: "B", status: "idle", updatedAt: 2000 },
			],
			"complete",
		);
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b", "a"]);

		applySessionUpsert({
			id: "a",
			title: "A",
			status: "idle",
			updatedAt: 3000,
		});
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("falls back to createdAt when the server sends no updatedAt", () => {
		applySessionSnapshot(
			[
				{ id: "a", title: "A", status: "idle", createdAt: 1000 },
				{ id: "b", title: "B", status: "idle", createdAt: 3000 },
			],
			"complete",
		);
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b", "a"]);
	});
});

describe("every mutation path leaves the server half wire-valid", () => {
	const ROWS: SessionInfo[] = [
		{ id: "root", title: "Root", status: "idle", updatedAt: 3000 },
		{
			id: "child",
			title: "Child",
			status: "busy",
			parentID: "root",
			updatedAt: 2000,
			forkMessageId: "msg_7",
			forkPointTimestamp: 1234,
			messageCount: 12,
			createdAt: 1767225600000,
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

	it("client selection", () => {
		applySessionSnapshot(ROWS, "complete");
		sessionState.currentId = "child";
		expectWireValid(ROWS);
	});

	it("a deletion leaves membership to the feed's remove", () => {
		applySessionSnapshot(ROWS, "complete");
		expect(sessionState.sessions.has("child")).toBe(true);
		applySessionChange({ _tag: "remove", id: "child" });
		expect(sessionState.sessions.has("child")).toBe(false);
		expectWireValid(ROWS);
	});
});

describe("applying server rows never touches the client half", () => {
	it("keeps the selection and the search query", () => {
		sessionState.currentId = "root";
		sessionState.searchQuery = "roo";

		applySessionSnapshot(
			[{ id: "root", title: "Root", status: "idle" }],
			"complete",
		);
		applySessionUpsert({ id: "other", title: "Other", status: "idle" });
		applySessionRemoved("other");

		expect(sessionState.currentId).toBe("root");
		expect(sessionState.searchQuery).toBe("roo");
	});
});

describe("deleting the session being viewed", () => {
	it("does not let a later event rebuild the chat state deletion threw away", async () => {
		vi.useFakeTimers();
		try {
			applySessionUpsert({ id: "ses_doomed", title: "Doomed", status: "idle" });
			sessionState.currentId = "ses_doomed";
			handleMessage({ type: "thinking_stop", sessionId: "ses_doomed" });
			expect(sessionActivity.has("ses_doomed")).toBe(true);

			// The server deletes it. Deleting the last session leaves no other to
			// switch us to, so nothing else moves the selection.
			applySessionChange({ _tag: "remove", id: "ses_doomed" });
			expect(sessionState.sessions.has("ses_doomed")).toBe(false);
			expect(sessionActivity.has("ses_doomed")).toBe(false);

			// An event that was already in flight when it went.
			handleMessage({ type: "thinking_stop", sessionId: "ses_doomed" });
			await vi.advanceTimersByTimeAsync(200);

			expect(sessionActivity.has("ses_doomed")).toBe(false);
			expect(sessionState.currentId).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("event routing for the session being viewed", () => {
	it("routes events for the selected session before its row arrives", async () => {
		vi.useFakeTimers();
		try {
			routerState.path = "/s/ses_new";
			sessionState.currentId = "ses_new";
			expect(sessionState.sessions.has("ses_new")).toBe(false);

			handleMessage({ type: "thinking_stop", sessionId: "ses_new" });
			await vi.advanceTimersByTimeAsync(200);

			expect(sessionActivity.has("ses_new")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
