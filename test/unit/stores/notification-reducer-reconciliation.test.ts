// ─── Notification Reducer: Reconciliation Race Condition Tests ──────────────
import { describe, expect, it } from "vitest";
import {
	type NotifAction,
	type NotifMap,
	reduce,
	type SessionNotifState,
} from "../../../src/lib/frontend/stores/notification-reducer.svelte.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const EMPTY: NotifMap = new Map();

function attention(q: number, p: number): SessionNotifState {
	return { kind: "attention", questions: q, permissions: p };
}

const DONE_UNVIEWED: SessionNotifState = { kind: "done-unviewed" };

/** Apply a sequence of actions to the reducer, returning final state. */
function applySequence(initial: NotifMap, actions: NotifAction[]): NotifMap {
	return actions.reduce((state, action) => reduce(state, action), initial);
}

/** Shorthand for a reconcile action with question counts (permissions=0). */
function reconcileWith(
	...entries: [string, { questions: number; permissions: number }][]
): NotifAction {
	return { type: "reconcile", counts: new Map(entries) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("reconciliation race conditions", () => {
	describe("individual events followed by reconcile", () => {
		it("reconcile overwrites stale question_appeared counts with server truth", () => {
			// Client sees 3 question_appeared events, but server says only 1 pending
			const result = applySequence(EMPTY, [
				{ type: "question_appeared", sessionId: "s1" },
				{ type: "question_appeared", sessionId: "s1" },
				{ type: "question_appeared", sessionId: "s1" },
				reconcileWith(["s1", { questions: 1, permissions: 0 }]),
			]);
			expect(result.get("s1")).toEqual(attention(1, 0));
		});

		it("reconcile preserves done-unviewed even after question_appeared", () => {
			// Session goes done-unviewed, then a stale question_appeared overrides it
			// to attention(1,0). Reconcile with 0 questions should restore done-unviewed.
			// But reconcile only preserves done-unviewed if the session is currently
			// done-unviewed in state. Here the question_appeared already overwrote it,
			// so we need to test the opposite ordering: done after appear, then reconcile.
			//
			// Actually: appear transitions to attention, then done transitions to
			// done-unviewed, then reconcile(0) should preserve done-unviewed.
			const result = applySequence(EMPTY, [
				{ type: "question_appeared", sessionId: "s1" },
				{ type: "session_done", sessionId: "s1" },
				reconcileWith(["s1", { questions: 0, permissions: 0 }]),
			]);
			expect(result.get("s1")).toEqual(DONE_UNVIEWED);
		});

		it("reconcile clears attention for sessions the server says have 0 questions", () => {
			// Client accumulated attention, but server says nothing pending
			const result = applySequence(EMPTY, [
				{ type: "question_appeared", sessionId: "s1" },
				{ type: "question_appeared", sessionId: "s1" },
				reconcileWith(["s1", { questions: 0, permissions: 0 }]),
			]);
			expect(result.has("s1")).toBe(false);
		});
	});

	describe("reconcile followed by individual events", () => {
		it("question_appeared after reconcile increments from server-reconciled state", () => {
			// Server says 2 questions, then another appears -> 3
			const result = applySequence(EMPTY, [
				reconcileWith(["s1", { questions: 2, permissions: 0 }]),
				{ type: "question_appeared", sessionId: "s1" },
			]);
			expect(result.get("s1")).toEqual(attention(3, 0));
		});

		it("question_resolved after reconcile clears questions regardless of reconciled count", () => {
			// Server says 5 questions, then resolved clears all
			const result = applySequence(EMPTY, [
				reconcileWith(["s1", { questions: 5, permissions: 1 }]),
				{ type: "question_resolved", sessionId: "s1" },
			]);
			// question_resolved force-evicts all questions, permissions preserved
			expect(result.get("s1")).toEqual(attention(0, 1));
		});

		it("session_done after reconcile overwrites attention with done-unviewed", () => {
			// Server says 3 questions, then session completes
			const result = applySequence(EMPTY, [
				reconcileWith(["s1", { questions: 3, permissions: 2 }]),
				{ type: "session_done", sessionId: "s1" },
			]);
			expect(result.get("s1")).toEqual(DONE_UNVIEWED);
		});
	});

	describe("interleaved sequences", () => {
		it("handles: appear -> appear -> reconcile(1) -> resolved correctly", () => {
			// Start with 0, appear twice (count=2), reconcile says 1, then resolved clears to 0
			const result = applySequence(EMPTY, [
				{ type: "question_appeared", sessionId: "s1" },
				{ type: "question_appeared", sessionId: "s1" },
				reconcileWith(["s1", { questions: 1, permissions: 0 }]),
				{ type: "question_resolved", sessionId: "s1" },
			]);
			// resolved force-evicts all questions, no permissions -> entry removed
			expect(result.has("s1")).toBe(false);
		});

		it("handles: reconcile(2) -> resolved -> appear -> reconcile(1) correctly", () => {
			// reconcile says 2, resolved clears, appear adds 1, reconcile says 1 -> final count=1
			const result = applySequence(EMPTY, [
				reconcileWith(["s1", { questions: 2, permissions: 0 }]),
				{ type: "question_resolved", sessionId: "s1" },
				{ type: "question_appeared", sessionId: "s1" },
				reconcileWith(["s1", { questions: 1, permissions: 0 }]),
			]);
			expect(result.get("s1")).toEqual(attention(1, 0));
		});

		it("handles: appear -> done -> reconcile(0) correctly", () => {
			// appear makes attention, done makes done-unviewed, reconcile(0) preserves done-unviewed
			const result = applySequence(EMPTY, [
				{ type: "question_appeared", sessionId: "s1" },
				{ type: "session_done", sessionId: "s1" },
				reconcileWith(["s1", { questions: 0, permissions: 0 }]),
			]);
			// reconcile preserves done-unviewed when server has zero counts
			expect(result.get("s1")).toEqual(DONE_UNVIEWED);
		});

		it("handles: done -> reconcile(1) correctly", () => {
			// done makes done-unviewed, reconcile says 1 question -> overwrites to attention(1,0)
			const result = applySequence(EMPTY, [
				{ type: "session_done", sessionId: "s1" },
				reconcileWith(["s1", { questions: 1, permissions: 0 }]),
			]);
			// Server says there's a pending question, so attention overwrites done-unviewed
			expect(result.get("s1")).toEqual(attention(1, 0));
		});
	});

	describe("multi-session reconciliation", () => {
		it("reconcile correctly handles mixed sessions: some with questions, some done-unviewed, some clean", () => {
			// Set up a complex multi-session scenario
			const state = applySequence(EMPTY, [
				// s1: has questions from individual events
				{ type: "question_appeared", sessionId: "s1" },
				{ type: "question_appeared", sessionId: "s1" },
				// s2: is done-unviewed
				{ type: "session_done", sessionId: "s2" },
				// s3: has permissions
				{ type: "permission_appeared", sessionId: "s3" },
				// s4: had questions but was resolved (clean)
				{ type: "question_appeared", sessionId: "s4" },
				{ type: "question_resolved", sessionId: "s4" },
			]);

			// Verify pre-reconcile state
			expect(state.get("s1")).toEqual(attention(2, 0));
			expect(state.get("s2")).toEqual(DONE_UNVIEWED);
			expect(state.get("s3")).toEqual(attention(0, 1));
			expect(state.has("s4")).toBe(false);

			// Now reconcile with server truth:
			// - s1: server says only 1 question (stale events)
			// - s2: server has no counts (done-unviewed preserved)
			// - s3: not in server counts (dropped — server says no pending permissions)
			// - s5: new session server knows about
			const result = reduce(state, {
				type: "reconcile",
				counts: new Map([
					["s1", { questions: 1, permissions: 0 }],
					["s5", { questions: 0, permissions: 2 }],
				]),
			});

			expect(result.get("s1")).toEqual(attention(1, 0)); // overwritten by server
			expect(result.get("s2")).toEqual(DONE_UNVIEWED); // preserved (client-local)
			expect(result.has("s3")).toBe(false); // dropped (not in server counts)
			expect(result.has("s4")).toBe(false); // was already clean
			expect(result.get("s5")).toEqual(attention(0, 2)); // new from server
			expect(result.size).toBe(3); // s1, s2, s5
		});
	});
});
