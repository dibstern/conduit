// Lane-3227 audit.md 7, 8, 13: Codex's blocked, usageLimited and budgetLimited facts read as
// Paused or lose which limit it was; a Pause answered with budgetLimited leaves Pausing showing; an
// unconfirmed Pause shows nothing to retry and never re-reads Codex's goal, or re-reads on every
// view (one re-read per unconfirmed send), or re-reads for a provider that cannot (Claude).
import { describe, expect, it } from "vitest";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeSessionGoals } from "../../../src/lib/session/session-goals.js";

const goal = {
	condition: "A",
	iterations: 0,
	setAt: 1,
	tokensAtStart: 0,
};
const limitedFacts = (replyTo?: string) =>
	canonicalEvent("session.goal_changed", "s1", {
		sessionId: "s1",
		goal,
		pausedReason: "Goal budget reached",
		limit: "budget",
		...(replyTo ? { replyTo } : {}),
	});

describe("session goals for Codex (82tn.32.27)", () => {
	it("a Pause answered budgetLimited ends Limited (budget), not Paused", () => {
		const goals = makeSessionGoals();
		goals.request("s1", "pause-1", { kind: "pause" }, true);
		expect(goals.phaseOf("s1")).toEqual({
			tag: "Pending",
			action: { kind: "pause" },
			send: "Sent",
		});
		expect(goals.observe([limitedFacts("pause-1")])).toEqual(["s1"]);
		goals.request("s1", "clear-1", { kind: "clear" }, true);
		goals.sends("s1", [
			{ commandId: "clear-1", tag: "Failed", code: "agent_busy" },
		]);
		expect(goals.phaseOf("s1")).toEqual({
			tag: "Confirmed",
			status: { tag: "Limited", condition: "A", limit: "budget" },
			failed: { action: { kind: "clear" }, code: "agent_busy" },
		});
	});

	it("an unconfirmed Pause queues one native re-read, and a read still active keeps Retry", () => {
		const goals = makeSessionGoals();
		goals.request("s1", "pause-1", { kind: "pause" }, true);
		const unconfirmed = [{ commandId: "pause-1", tag: "Unconfirmed" } as const];
		expect(goals.sends("s1", unconfirmed)).toBe(true);
		const [read, ...rest] = goals.takeResends("s1");
		expect(rest).toEqual([]);
		expect(read).toEqual({ id: expect.any(String) });
		expect(read?.id).not.toBe("pause-1");
		goals.sends("s1", unconfirmed);
		expect(goals.takeResends("s1")).toEqual([]);
		// A read already Paused or Limited settles it instead (codex-goals integration, audit 8).
		goals.observe([
			canonicalEvent("session.goal_changed", "s1", { sessionId: "s1", goal }),
		]);
		expect(goals.phaseOf("s1")).toEqual({
			tag: "Pending",
			action: { kind: "pause" },
			send: "Unconfirmed",
		});
	});

	it("no re-read for a provider whose goal cannot be read natively", () => {
		const goals = makeSessionGoals();
		goals.request("s1", "clear-1", { kind: "clear" });
		goals.sends("s1", [{ commandId: "clear-1", tag: "Unconfirmed" }]);
		expect(goals.takeResends("s1")).toEqual([]);
	});
});
