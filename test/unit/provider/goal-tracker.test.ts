// Failure modes (lane-3226 audit.md 1-11, 25, 26): a superseded Set's late reply clears the newer
// pending action or changes the status; reply order decides the end state; a stale read restores a
// cleared goal; recovery skips Set(B) over Active(A) or resends what is already confirmed; a
// transitional phase is stored, or outlives a failed delivery; a deadline shows nothing to retry;
// a queued clear is not told apart; an uncorrelated reply clears the pending action; a read that
// finds no record drops the goal; "No goal set" leaves Clearing showing.
// Lane-3227 audit.md 7, 8, 13, 14, 18, 19: a Limited status loses which limit it was; a Pause that
// comes back budgetLimited leaves Pausing showing; the not-confirmed re-read drops the pending
// Pause; a slow re-read undoes newer state; Resume while Limited assumes Active; two tabs' Pauses
// let the first one's late reply decide; recovery resends a Pause over a Limited goal.
import { describe, expect, it } from "vitest";
import {
	confirmGoal,
	type GoalTracker,
	goalPhase,
	NO_GOAL,
	recoverGoal,
	requestGoalAction,
} from "../../../src/lib/provider/goal-tracker.js";

const active = (condition: string) => ({ tag: "Active", condition }) as const;
const cleared = { tag: "Cleared" } as const;
const activeA: GoalTracker = confirmGoal(NO_GOAL, {
	kind: "read",
	status: active("A"),
	order: 10,
});

describe("goal tracker", () => {
	it("a Set then a Clear ends Cleared whatever order the replies arrive in", () => {
		const both = requestGoalAction(
			requestGoalAction(NO_GOAL, "set-1", { kind: "set", condition: "B" }),
			"clear-1",
			{ kind: "clear" },
		);
		const setReply = {
			kind: "reply",
			replyTo: "set-1",
			status: active("B"),
			order: 20,
		} as const;
		const clearReply = {
			kind: "reply",
			replyTo: "clear-1",
			status: cleared,
			order: 30,
		} as const;
		for (const replies of [
			[setReply, clearReply],
			[clearReply, setReply],
		]) {
			const end = replies.reduce(confirmGoal, both);
			expect(end.confirmed).toEqual(cleared);
			expect(end.pending).toEqual({ tag: "None" });
		}
	});

	it("a late reply to the superseded Set changes nothing", () => {
		const clearing = requestGoalAction(
			requestGoalAction(activeA, "set-1", { kind: "set", condition: "B" }),
			"clear-1",
			{ kind: "clear" },
		);
		expect(
			confirmGoal(clearing, {
				kind: "reply",
				replyTo: "set-1",
				status: active("B"),
				order: 20,
			}),
		).toEqual(clearing);
	});

	it("an uncorrelated reply leaves the pending action and the status alone", () => {
		const clearing = requestGoalAction(activeA, "clear-1", { kind: "clear" });
		expect(
			confirmGoal(clearing, {
				kind: "reply",
				replyTo: "typed-in-chat",
				status: active("C"),
				order: 20,
			}),
		).toEqual(clearing);
	});

	it("a stale read finishing after a Clear does not restore the goal", () => {
		const clearedGoal = confirmGoal(
			requestGoalAction(activeA, "clear-1", { kind: "clear" }),
			{
				kind: "reply",
				replyTo: "clear-1",
				status: cleared,
				order: 40,
			},
		);
		const stale = confirmGoal(clearedGoal, {
			kind: "read",
			status: active("A"),
			order: 25,
		});
		expect(stale.confirmed).toEqual(cleared);
		expect(
			confirmGoal(clearedGoal, { kind: "read", status: active("A"), order: 40 })
				.confirmed,
		).toEqual(cleared);
	});

	it("a newer read always updates the confirmed status, pending or not", () => {
		const clearing = requestGoalAction(activeA, "clear-1", { kind: "clear" });
		const read = confirmGoal(clearing, {
			kind: "read",
			status: { tag: "Met", condition: "A" },
			order: 50,
		});
		expect(read.confirmed).toEqual({ tag: "Met", condition: "A" });
		expect(read.pending).toEqual(clearing.pending);
	});

	it("a read that finds no goal record changes nothing", () => {
		expect(
			confirmGoal(activeA, { kind: "read", status: null, order: 99 }),
		).toEqual(activeA);
	});

	it("a No goal set reply to a clear confirms Cleared", () => {
		const clearing = requestGoalAction(NO_GOAL, "clear-1", { kind: "clear" });
		const end = confirmGoal(clearing, {
			kind: "reply",
			replyTo: "clear-1",
			status: cleared,
			order: 5,
		});
		expect(end).toMatchObject({ confirmed: cleared, pending: { tag: "None" } });
		expect(goalPhase(end, undefined)).toEqual({
			tag: "Confirmed",
			status: cleared,
		});
	});

	it("recovery with Active(A) and pending Set(B) resends Set(B)", () => {
		const setting = requestGoalAction(activeA, "set-1", {
			kind: "set",
			condition: "B",
		});
		expect(recoverGoal(setting)).toEqual({
			goal: setting,
			resend: { id: "set-1", action: { kind: "set", condition: "B" } },
		});
	});

	it("recovery resends nothing the confirmed status already matches", () => {
		const setting = requestGoalAction(activeA, "set-1", {
			kind: "set",
			condition: "A",
		});
		expect(recoverGoal(setting)).toEqual({
			goal: { ...setting, pending: { tag: "None" } },
		});
		const clearing = confirmGoal(
			requestGoalAction(activeA, "clear-1", { kind: "clear" }),
			{
				kind: "read",
				status: cleared,
				order: 60,
			},
		);
		expect(recoverGoal(clearing).resend).toBeUndefined();
		expect(recoverGoal(activeA)).toEqual({ goal: activeA });
	});

	it("stores no transitional phase: Clearing is derived from the pending action and its send", () => {
		const clearing = requestGoalAction(activeA, "clear-1", { kind: "clear" });
		expect(Object.keys(clearing).sort()).toEqual([
			"confirmed",
			"order",
			"pending",
		]);
		expect(clearing.confirmed).toEqual(active("A"));
		const pendingClear = { tag: "Pending", action: { kind: "clear" } } as const;
		expect(goalPhase(clearing, undefined)).toEqual({
			...pendingClear,
			send: "Sent",
		});
		expect(goalPhase(clearing, { commandId: "clear-1", tag: "Sent" })).toEqual({
			...pendingClear,
			send: "Sent",
		});
		expect(
			goalPhase(clearing, { commandId: "clear-1", tag: "Queued" }),
		).toEqual({ ...pendingClear, send: "Queued" });
		expect(
			goalPhase(clearing, { commandId: "clear-1", tag: "Unconfirmed" }),
		).toEqual({
			...pendingClear,
			send: "Unconfirmed",
		});
	});

	it("a failed delivery shows the confirmed status again, with the failure", () => {
		const clearing = requestGoalAction(activeA, "clear-1", { kind: "clear" });
		expect(
			goalPhase(clearing, {
				commandId: "clear-1",
				tag: "Failed",
				code: "process_lost",
			}),
		).toEqual({
			tag: "Confirmed",
			status: active("A"),
			failed: { action: { kind: "clear" }, code: "process_lost" },
		});
		expect(
			goalPhase(clearing, { commandId: "clear-1", tag: "Cancelled" }),
		).toEqual({
			tag: "Confirmed",
			status: active("A"),
			failed: { action: { kind: "clear" }, code: "cancelled" },
		});
	});

	it("a send view for another command does not drive the phase", () => {
		const clearing = requestGoalAction(activeA, "clear-1", { kind: "clear" });
		expect(
			goalPhase(clearing, { commandId: "set-0", tag: "Failed", code: "x" }),
		).toEqual({
			tag: "Pending",
			action: { kind: "clear" },
			send: "Sent",
		});
	});

	describe("Codex Pause, Resume and Limited (82tn.32.27)", () => {
		const limited = (limit: "blocked" | "usage" | "budget") =>
			({ tag: "Limited", condition: "A", limit }) as const;
		const pausing = requestGoalAction(activeA, "pause-1", { kind: "pause" });

		it("fixed trace: Pause sent, not confirmed, the re-read finds budgetLimited", () => {
			// Coverage gate (moved from the Run Ledger gate): the deadline fires, the tracker
			// re-reads thread/goal/get, which returns budgetLimited.
			expect(
				goalPhase(pausing, { commandId: "pause-1", tag: "Unconfirmed" }),
			).toEqual({
				tag: "Pending",
				action: { kind: "pause" },
				send: "Unconfirmed",
			});
			const reread = confirmGoal(pausing, {
				kind: "read",
				status: limited("budget"),
				order: 20,
			});
			expect(reread.confirmed).toEqual(limited("budget"));
			// A read is not the reply: "Pause not confirmed" with Retry stays.
			expect(
				goalPhase(reread, { commandId: "pause-1", tag: "Unconfirmed" }),
			).toEqual({
				tag: "Pending",
				action: { kind: "pause" },
				send: "Unconfirmed",
			});
			const stale = confirmGoal(reread, {
				kind: "read",
				status: active("A"),
				order: 15,
			});
			expect(stale).toBe(reread);
			const replied = confirmGoal(stale, {
				kind: "reply",
				replyTo: "pause-1",
				status: limited("budget"),
				order: 30,
			});
			expect(replied.pending).toEqual({ tag: "None" });
			expect(goalPhase(replied, undefined)).toEqual({
				tag: "Confirmed",
				status: limited("budget"),
			});
		});

		it("a Pause confirmed as budgetLimited shows Limited, not Paused", () => {
			const end = confirmGoal(pausing, {
				kind: "reply",
				replyTo: "pause-1",
				status: limited("budget"),
				order: 20,
			});
			expect(end).toEqual({
				confirmed: limited("budget"),
				pending: { tag: "None" },
				order: 20,
			});
		});

		it("Resume while Limited shows what Codex returns", () => {
			const resuming = requestGoalAction(
				confirmGoal(NO_GOAL, {
					kind: "read",
					status: limited("usage"),
					order: 10,
				}),
				"resume-1",
				{ kind: "resume" },
			);
			const end = confirmGoal(resuming, {
				kind: "reply",
				replyTo: "resume-1",
				status: limited("usage"),
				order: 20,
			});
			expect(end.confirmed).toEqual(limited("usage"));
			expect(end.pending).toEqual({ tag: "None" });
		});

		it("two tabs pressing Pause: the first one's late reply changes nothing", () => {
			const second = requestGoalAction(pausing, "pause-2", { kind: "pause" });
			const late = confirmGoal(second, {
				kind: "reply",
				replyTo: "pause-1",
				status: { tag: "Paused", condition: "A" },
				order: 20,
			});
			expect(late).toBe(second);
			const end = confirmGoal(late, {
				kind: "reply",
				replyTo: "pause-2",
				status: { tag: "Paused", condition: "A" },
				order: 30,
			});
			expect(end.confirmed).toEqual({ tag: "Paused", condition: "A" });
			expect(end.pending).toEqual({ tag: "None" });
		});

		it("recovery does not resend a Pause over a Limited goal, but resends a Resume", () => {
			const limitedPausing = confirmGoal(pausing, {
				kind: "read",
				status: limited("blocked"),
				order: 20,
			});
			expect(recoverGoal(limitedPausing)).toEqual({
				goal: { ...limitedPausing, pending: { tag: "None" } },
			});
			const resuming = requestGoalAction(limitedPausing, "resume-1", {
				kind: "resume",
			});
			expect(recoverGoal(resuming).resend).toEqual({
				id: "resume-1",
				action: { kind: "resume" },
			});
		});
	});
});
