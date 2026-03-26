// ─── Notification Reducer Tests ──────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import {
	type NotifAction,
	type NotifMap,
	reduce,
	type SessionNotifState,
} from "../../../src/lib/frontend/stores/notification-reducer.svelte.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const EMPTY: NotifMap = new Map();

function mapOf(
	...entries: [string, SessionNotifState][]
): Map<string, SessionNotifState> {
	return new Map(entries);
}

function attention(
	q: number,
	p: number,
): SessionNotifState & { kind: "attention" } {
	return { kind: "attention", questions: q, permissions: p };
}

const DONE_UNVIEWED: SessionNotifState = { kind: "done-unviewed" };

// ─── question_appeared ──────────────────────────────────────────────────────

describe("question_appeared", () => {
	it("creates attention from empty state", () => {
		const result = reduce(EMPTY, {
			type: "question_appeared",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(1, 0));
		expect(result.size).toBe(1);
	});

	it("increments existing question count", () => {
		const state = mapOf(["s1", attention(2, 1)]);
		const result = reduce(state, {
			type: "question_appeared",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(3, 1));
	});

	it("transitions done-unviewed to attention", () => {
		const state = mapOf(["s1", DONE_UNVIEWED]);
		const result = reduce(state, {
			type: "question_appeared",
			sessionId: "s1",
		});
		// done-unviewed has no question/permission counts, so getAttention returns {0,0}
		// then increments question to 1
		expect(result.get("s1")).toEqual(attention(1, 0));
	});

	it("does not affect other sessions", () => {
		const state = mapOf(["s1", attention(1, 0)], ["s2", attention(0, 3)]);
		const result = reduce(state, {
			type: "question_appeared",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(2, 0));
		expect(result.get("s2")).toEqual(attention(0, 3));
	});
});

// ─── question_resolved ──────────────────────────────────────────────────────

describe("question_resolved", () => {
	it("force-evicts all questions, preserves permissions", () => {
		const state = mapOf(["s1", attention(5, 2)]);
		const result = reduce(state, {
			type: "question_resolved",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(0, 2));
	});

	it("removes entry when both counts reach zero", () => {
		const state = mapOf(["s1", attention(3, 0)]);
		const result = reduce(state, {
			type: "question_resolved",
			sessionId: "s1",
		});
		expect(result.has("s1")).toBe(false);
	});

	it("is a no-op on empty state", () => {
		const result = reduce(EMPTY, {
			type: "question_resolved",
			sessionId: "s1",
		});
		expect(result.size).toBe(0);
	});

	it("is a no-op on session not in map", () => {
		const state = mapOf(["s2", attention(1, 0)]);
		const result = reduce(state, {
			type: "question_resolved",
			sessionId: "s1",
		});
		expect(result.has("s1")).toBe(false);
		expect(result.get("s2")).toEqual(attention(1, 0));
	});
});

// ─── permission_appeared ────────────────────────────────────────────────────

describe("permission_appeared", () => {
	it("creates attention from empty state", () => {
		const result = reduce(EMPTY, {
			type: "permission_appeared",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(0, 1));
	});

	it("increments existing permission count", () => {
		const state = mapOf(["s1", attention(1, 2)]);
		const result = reduce(state, {
			type: "permission_appeared",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(1, 3));
	});

	it("transitions done-unviewed to attention", () => {
		const state = mapOf(["s1", DONE_UNVIEWED]);
		const result = reduce(state, {
			type: "permission_appeared",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(0, 1));
	});
});

// ─── permission_resolved ────────────────────────────────────────────────────

describe("permission_resolved", () => {
	it("decrements permission count, preserves questions", () => {
		const state = mapOf(["s1", attention(2, 3)]);
		const result = reduce(state, {
			type: "permission_resolved",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(attention(2, 2));
	});

	it("removes entry when both counts reach zero", () => {
		const state = mapOf(["s1", attention(0, 1)]);
		const result = reduce(state, {
			type: "permission_resolved",
			sessionId: "s1",
		});
		expect(result.has("s1")).toBe(false);
	});

	it("does not go below zero", () => {
		const state = mapOf(["s1", attention(1, 0)]);
		const result = reduce(state, {
			type: "permission_resolved",
			sessionId: "s1",
		});
		// permissions was already 0, Math.max(0, 0-1) = 0, questions=1 so entry stays
		expect(result.get("s1")).toEqual(attention(1, 0));
	});

	it("is a no-op on empty state", () => {
		const result = reduce(EMPTY, {
			type: "permission_resolved",
			sessionId: "s1",
		});
		expect(result.size).toBe(0);
	});
});

// ─── session_done ───────────────────────────────────────────────────────────

describe("session_done", () => {
	it("overwrites attention with done-unviewed", () => {
		const state = mapOf(["s1", attention(3, 2)]);
		const result = reduce(state, {
			type: "session_done",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(DONE_UNVIEWED);
	});

	it("sets done-unviewed on session with no prior state", () => {
		const result = reduce(EMPTY, {
			type: "session_done",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(DONE_UNVIEWED);
	});

	it("does not affect other sessions", () => {
		const state = mapOf(["s1", attention(1, 0)], ["s2", attention(0, 1)]);
		const result = reduce(state, {
			type: "session_done",
			sessionId: "s1",
		});
		expect(result.get("s1")).toEqual(DONE_UNVIEWED);
		expect(result.get("s2")).toEqual(attention(0, 1));
	});
});

// ─── session_viewed ─────────────────────────────────────────────────────────

describe("session_viewed", () => {
	it("deletes entry entirely", () => {
		const state = mapOf(["s1", DONE_UNVIEWED], ["s2", attention(1, 0)]);
		const result = reduce(state, {
			type: "session_viewed",
			sessionId: "s1",
		});
		expect(result.has("s1")).toBe(false);
		expect(result.get("s2")).toEqual(attention(1, 0));
	});

	it("is a no-op on session not in map", () => {
		const state = mapOf(["s1", attention(1, 0)]);
		const result = reduce(state, {
			type: "session_viewed",
			sessionId: "s2",
		});
		expect(result.size).toBe(1);
		expect(result.get("s1")).toEqual(attention(1, 0));
	});

	it("clears attention state", () => {
		const state = mapOf(["s1", attention(5, 3)]);
		const result = reduce(state, {
			type: "session_viewed",
			sessionId: "s1",
		});
		expect(result.has("s1")).toBe(false);
		expect(result.size).toBe(0);
	});
});

// ─── reconcile ──────────────────────────────────────────────────────────────

describe("reconcile", () => {
	it("overwrites attention states with server counts", () => {
		const state = mapOf(["s1", attention(1, 0)]);
		const counts = new Map([["s1", { questions: 3, permissions: 2 }]]);
		const result = reduce(state, { type: "reconcile", counts });
		expect(result.get("s1")).toEqual(attention(3, 2));
	});

	it("preserves done-unviewed when server has no counts", () => {
		const state = mapOf(["s1", DONE_UNVIEWED]);
		const counts = new Map<
			string,
			{ questions: number; permissions: number }
		>();
		const result = reduce(state, { type: "reconcile", counts });
		expect(result.get("s1")).toEqual(DONE_UNVIEWED);
	});

	it("overwrites done-unviewed when server says attention", () => {
		const state = mapOf(["s1", DONE_UNVIEWED]);
		const counts = new Map([["s1", { questions: 1, permissions: 0 }]]);
		const result = reduce(state, { type: "reconcile", counts });
		expect(result.get("s1")).toEqual(attention(1, 0));
	});

	it("adds new attention sessions from server", () => {
		const state = mapOf(["s1", DONE_UNVIEWED]);
		const counts = new Map([["s2", { questions: 0, permissions: 1 }]]);
		const result = reduce(state, { type: "reconcile", counts });
		expect(result.get("s1")).toEqual(DONE_UNVIEWED);
		expect(result.get("s2")).toEqual(attention(0, 1));
	});

	it("drops old attention sessions not in server counts", () => {
		const state = mapOf(["s1", attention(2, 1)]);
		const counts = new Map<
			string,
			{ questions: number; permissions: number }
		>();
		const result = reduce(state, { type: "reconcile", counts });
		expect(result.has("s1")).toBe(false);
		expect(result.size).toBe(0);
	});

	it("skips server sessions with zero counts", () => {
		const counts = new Map([["s1", { questions: 0, permissions: 0 }]]);
		const result = reduce(EMPTY, { type: "reconcile", counts });
		expect(result.has("s1")).toBe(false);
		expect(result.size).toBe(0);
	});

	it("handles complex reconcile with mixed state", () => {
		const state = mapOf(
			["s1", attention(5, 0)], // old attention — will be dropped
			["s2", DONE_UNVIEWED], // done-unviewed — preserved
			["s3", DONE_UNVIEWED], // done-unviewed — overwritten by server
		);
		const counts = new Map([
			["s3", { questions: 2, permissions: 0 }], // overwrite done-unviewed
			["s4", { questions: 0, permissions: 3 }], // new session
		]);
		const result = reduce(state, { type: "reconcile", counts });
		expect(result.has("s1")).toBe(false); // dropped
		expect(result.get("s2")).toEqual(DONE_UNVIEWED); // preserved
		expect(result.get("s3")).toEqual(attention(2, 0)); // overwritten
		expect(result.get("s4")).toEqual(attention(0, 3)); // added
		expect(result.size).toBe(3);
	});
});

// ─── reset ──────────────────────────────────────────────────────────────────

describe("reset", () => {
	it("returns empty map", () => {
		const state = mapOf(["s1", attention(1, 2)], ["s2", DONE_UNVIEWED]);
		const result = reduce(state, { type: "reset" });
		expect(result.size).toBe(0);
	});

	it("returns empty map from already empty state", () => {
		const result = reduce(EMPTY, { type: "reset" });
		expect(result.size).toBe(0);
	});
});

// ─── Immutability ───────────────────────────────────────────────────────────

describe("immutability", () => {
	it("does not mutate the original state map", () => {
		const state = mapOf(["s1", attention(1, 0)]);
		const result = reduce(state, {
			type: "question_appeared",
			sessionId: "s1",
		});
		// Original untouched
		expect(state.get("s1")).toEqual(attention(1, 0));
		// Result has new value
		expect(result.get("s1")).toEqual(attention(2, 0));
		// Different references
		expect(result).not.toBe(state);
	});
});

// ─── Exhaustive action handling ─────────────────────────────────────────────

describe("exhaustive handling", () => {
	it("handles every action type without throwing", () => {
		const actions: NotifAction[] = [
			{ type: "question_appeared", sessionId: "s1" },
			{ type: "question_resolved", sessionId: "s1" },
			{ type: "permission_appeared", sessionId: "s1" },
			{ type: "permission_resolved", sessionId: "s1" },
			{ type: "session_done", sessionId: "s1" },
			{ type: "session_viewed", sessionId: "s1" },
			{
				type: "reconcile",
				counts: new Map([["s1", { questions: 1, permissions: 0 }]]),
			},
			{ type: "reset" },
		];
		for (const action of actions) {
			expect(() => reduce(EMPTY, action)).not.toThrow();
		}
	});
});
