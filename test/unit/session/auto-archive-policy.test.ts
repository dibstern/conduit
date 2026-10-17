import { describe, expect, it } from "vitest";
import {
	type AutoArchiveFacts,
	shouldArchiveIdleSession,
} from "../../../src/lib/session/auto-archive-policy.js";

const day = 86_400_000;
const now = 100 * day;
const facts: AutoArchiveFacts = {
	settledAt: 60 * day,
	archivedAt: null,
	unarchivedAt: null,
	lastActivityAt: 60 * day,
	status: "idle",
	snoozed: false,
	pinnedAt: null,
	hasPendingWork: false,
	hasLiveBackgroundWork: false,
};

describe("automatic session archive", () => {
	it("archives settled sessions only after the idle threshold", () => {
		expect(shouldArchiveIdleSession(facts, now, 30 * day)).toBe(true);
		expect(shouldArchiveIdleSession(facts, now, 40 * day)).toBe(false);
		expect(shouldArchiveIdleSession(facts, now, null)).toBe(false);
	});

	it.each([
		{ settledAt: null },
		{ archivedAt: 90 * day },
		{ snoozed: true },
		{ pinnedAt: 50 * day },
		{ status: "busy" },
		{ status: "retry" },
		{ hasPendingWork: true },
		{ hasLiveBackgroundWork: true },
		{ lastActivityAt: 99 * day },
		{ unarchivedAt: 61 * day },
	])("preserves excluded or restored sessions: %j", (override) => {
		expect(
			shouldArchiveIdleSession({ ...facts, ...override }, now, 30 * day),
		).toBe(false);
	});

	it("requires activity after restoration before a later idle archive", () => {
		expect(
			shouldArchiveIdleSession(
				{ ...facts, unarchivedAt: 59 * day },
				now,
				30 * day,
			),
		).toBe(true);
	});
});
