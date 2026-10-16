import { describe, expect, it } from "vitest";
import {
	type AutoSettleFacts,
	getAutoSettleOutlook,
} from "../../../src/lib/session/auto-settle-policy.js";

const DAY = 86_400_000;
const NOW = 10 * DAY;
const idle = 3 * DAY;

const eligible = (): AutoSettleFacts => ({
	exists: true,
	settledAt: null,
	lastMessageAt: NOW - idle - 1,
	latestUserMessageAt: null,
	latestTurn: null,
	status: "idle",
	hasPendingApproval: false,
	hasLiveBackgroundWork: false,
	hasViewer: false,
	isSnoozed: false,
	pinnedAt: null,
	unread: false,
	autoSettleDisabledAt: null,
	unsettledAt: null,
});

describe("automatic idle settlement policy", () => {
	// Merge facts must use the session's checkout, preserve all settlement guards,
	// and consume each merged head once, including after a fetch or daemon restart.
	it("settles recent work when its own branch has a new merged head", () => {
		expect(
			getAutoSettleOutlook(
				{
					...eligible(),
					lastMessageAt: NOW - 1_000,
					latestUserMessageAt: NOW - 2_000,
					latestTurn: {
						state: "completed",
						requestedAt: NOW - 2_000,
						startedAt: NOW - 1_900,
						completedAt: NOW - 1_000,
					},
					mergedHead: "new-head",
				},
				NOW,
				idle,
			).kind === "due",
		).toBe(true);
	});

	it.each([
		["a consumed merge", { settledMergedHead: "merged-head" }],
		["unread", { unread: true }],
		["running", { status: "busy" }],
		["pending approval", { hasPendingApproval: true }],
		["pinned", { pinnedAt: NOW - 2_000 }],
		["viewed", { hasViewer: true }],
		["snoozed", { isSnoozed: true }],
		["background work", { hasLiveBackgroundWork: true }],
		["disabled", { autoSettleDisabledAt: NOW - 2_000 }],
	])("does not let a merge bypass %s", (_label, override) => {
		expect(
			getAutoSettleOutlook(
				{
					...eligible(),
					lastMessageAt: NOW - 100,
					latestUserMessageAt: NOW - 2_000,
					latestTurn: {
						state: "completed",
						requestedAt: NOW - 2_000,
						startedAt: NOW - 1_900,
						completedAt: NOW - 100,
					},
					mergedHead: "merged-head",
					...override,
				},
				NOW,
				idle,
			).kind === "due",
		).toBe(false);
	});

	it("keeps resumed work active until a different branch head merges", () => {
		const resumed = {
			...eligible(),
			lastMessageAt: NOW - 100,
			unsettledAt: NOW - 500,
			latestUserMessageAt: NOW - 500,
			latestTurn: {
				state: "completed",
				requestedAt: NOW - 500,
				startedAt: NOW - 450,
				completedAt: NOW - 100,
			},
			mergedHead: "merged-head",
			settledMergedHead: "merged-head",
		};
		expect(getAutoSettleOutlook(resumed, NOW, idle).kind === "due").toBe(false);
		expect(
			getAutoSettleOutlook({ ...resumed, mergedHead: "next-head" }, NOW, idle)
				.kind === "due",
		).toBe(true);
	});

	it("settles an eligible session", () => {
		expect(getAutoSettleOutlook(eligible(), NOW, idle).kind === "due").toBe(
			true,
		);
	});

	it.each([
		["pending approval or question", { hasPendingApproval: true }],
		["busy", { status: "busy" }],
		["retrying", { status: "retry" }],
		["live background work", { hasLiveBackgroundWork: true }],
		["pinned", { pinnedAt: NOW - DAY }],
		["open in a browser", { hasViewer: true }],
		["unread", { unread: true }],
		["auto-settle disabled", { autoSettleDisabledAt: NOW - DAY }],
		["already settled", { settledAt: NOW - DAY }],
		["missing", { exists: false }],
		["snoozed", { isSnoozed: true }],
	] as const)("leaves %s alone", (_reason, patch) => {
		expect(
			getAutoSettleOutlook({ ...eligible(), ...patch }, NOW, idle).kind ===
				"due",
		).toBe(false);
	});

	it.each([
		"pending",
		"running",
	] as const)("leaves a %s latest turn alone", (state) => {
		expect(
			getAutoSettleOutlook(
				{
					...eligible(),
					latestTurn: {
						state,
						requestedAt: NOW - idle - 1,
						startedAt: null,
						completedAt: null,
					},
				},
				NOW,
				idle,
			).kind === "due",
		).toBe(false);
	});

	it("blocks an un-settle after the last activity", () => {
		expect(
			getAutoSettleOutlook({ ...eligible(), unsettledAt: NOW - DAY }, NOW, idle)
				.kind === "due",
		).toBe(false);
	});

	it("allows new activity after un-settle once it becomes idle", () => {
		expect(
			getAutoSettleOutlook(
				{
					...eligible(),
					lastMessageAt: NOW - idle - 1,
					unsettledAt: NOW - idle - 2,
				},
				NOW,
				idle,
			).kind === "due",
		).toBe(true);
		expect(
			getAutoSettleOutlook(
				{ ...eligible(), unsettledAt: NOW - idle - 1 },
				NOW,
				idle,
			).kind === "due",
		).toBe(true);
	});

	it("uses a strict idle-window boundary", () => {
		expect(
			getAutoSettleOutlook(
				{ ...eligible(), lastMessageAt: NOW - idle },
				NOW,
				idle,
			).kind === "due",
		).toBe(false);
		expect(
			getAutoSettleOutlook(
				{ ...eligible(), lastMessageAt: NOW - idle - 1 },
				NOW,
				idle,
			).kind === "due",
		).toBe(true);
	});

	it("never settles when the setting is null", () => {
		expect(getAutoSettleOutlook(eligible(), NOW, null).kind === "due").toBe(
			false,
		);
	});

	it("respects the queued user message grace boundary", () => {
		const queued = { ...eligible(), latestUserMessageAt: NOW - 119_999 };
		expect(getAutoSettleOutlook(queued, NOW, idle).kind === "due").toBe(false);
		expect(
			getAutoSettleOutlook(
				{ ...queued, latestUserMessageAt: NOW - 120_000 },
				NOW,
				idle,
			).kind === "due",
		).toBe(false);
		expect(
			getAutoSettleOutlook(
				{ ...queued, latestUserMessageAt: NOW - 120_001 },
				NOW,
				idle,
			).kind === "due",
		).toBe(true);
	});

	it("does not block a user message already picked up by a turn", () => {
		const facts = eligible();
		expect(
			getAutoSettleOutlook(
				{
					...facts,
					latestUserMessageAt: NOW - 1000,
					latestTurn: {
						state: "completed",
						requestedAt: NOW - 999,
						startedAt: NOW - 998,
						completedAt: NOW - 997,
					},
				},
				NOW,
				1000,
			).kind === "due",
		).toBe(false); // Recent turn activity still controls idleness.
	});

	it("allows a woken snooze", () => {
		expect(
			getAutoSettleOutlook({ ...eligible(), isSnoozed: false }, NOW, idle)
				.kind === "due",
		).toBe(true);
	});

	it("does not treat rename or pin timestamps as activity", () => {
		expect(
			getAutoSettleOutlook({ ...eligible(), pinnedAt: null }, NOW, idle)
				.kind === "due",
		).toBe(true);
	});
});
