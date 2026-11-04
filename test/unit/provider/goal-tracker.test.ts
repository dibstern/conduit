// Failure modes (lane-3226 audit.md 1-11, 25, 26): a superseded Set's late reply clears the newer
// pending action or changes the status; reply order decides the end state; a stale read restores a
// cleared goal; recovery skips Set(B) over Active(A) or resends what is already confirmed; a
// transitional phase is stored, or outlives a failed delivery; a deadline shows nothing to retry;
// a queued clear is not told apart; an uncorrelated reply clears the pending action; a read that
// finds no record drops the goal; "No goal set" leaves Clearing showing.
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
});
