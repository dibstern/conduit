/*
 * Account Limit failure list, from Testing Decisions:
 * - A reading from before the limit releases work.
 * - A stale "available" or unknown reading counts as free for automatic.
 * - A model-only or overage limit is judged free early.
 * - A signed-out account is allowed.
 * - Can't-tell blocks user.
 * - The wrong window is named, or the event's reset wins over a later reading's.
 * - It still waits at or just after the reset time.
 * - A time-only recovery, or one without limitedAt, resumes early.
 * - Seconds and milliseconds are mixed up.
 */
import { describe, expect, it } from "vitest";
import {
	type AccountLimit,
	accountLimit,
	accountLimitWindowLabel,
} from "../../../src/lib/contracts/account-limit.js";
import type {
	LimitRecovery,
	UsageReading,
	UsageWindow,
} from "../../../src/lib/contracts/limit-recovery.js";

const now = 1_800_000_000_000;
const reset = now + 60_000;
const laterReset = now + 120_000;
const recovery: LimitRecovery = {
	instanceId: "account-1",
	rateLimitType: "five_hour",
	limitedAt: now - 2_000,
	resetsAt: reset / 1_000,
	rearms: 0,
	continued: false,
};
const available: UsageReading = {
	accountId: "account-1",
	harness: "claude",
	status: "available",
	windows: [
		{
			kind: "five_hour",
			utilization: 20,
			resetsAt: new Date(reset).toISOString(),
		},
		{ kind: "seven_day", utilization: 30 },
	],
	readAt: now - 1_000,
	stale: false,
};
const full: UsageReading = {
	...available,
	status: "limited",
	windows: [
		{
			kind: "five_hour",
			utilization: 100,
			resetsAt: new Date(reset).toISOString(),
		},
	],
};
const waitUntil: AccountLimit = {
	kind: "wait-until",
	until: reset,
	label: "5-hour limit",
};
const go: AccountLimit = { kind: "go" };
const wait: AccountLimit = { kind: "wait" };
const signedOut: AccountLimit = { kind: "signed-out" };

const cases: readonly {
	readonly name: string;
	readonly reading?: UsageReading;
	readonly recovery?: LimitRecovery;
	readonly now: number;
	readonly user: AccountLimit;
	readonly automatic: AccountLimit;
}[] = [
	// No Limit Recovery: every reading status for both askers.
	{
		name: "no recovery, available",
		reading: available,
		now,
		user: go,
		automatic: go,
	},
	{
		name: "no recovery, limited",
		reading: full,
		now,
		user: waitUntil,
		automatic: waitUntil,
	},
	{
		name: "no recovery, monthly plan limit",
		reading: {
			...full,
			harness: "cursor",
			windows: [
				{
					kind: "month",
					utilization: 100,
					resetsAt: new Date(reset).toISOString(),
				},
			],
		},
		now,
		user: { kind: "wait-until", until: reset, label: "monthly limit" },
		automatic: { kind: "wait-until", until: reset, label: "monthly limit" },
	},
	{
		name: "no recovery, unknown",
		reading: { ...available, status: "unknown", windows: [] },
		now,
		user: go,
		automatic: wait,
	},
	{
		name: "no recovery, unavailable",
		reading: { ...available, status: "unavailable", windows: [] },
		now,
		user: signedOut,
		automatic: signedOut,
	},
	{ name: "no recovery, missing", now, user: go, automatic: wait },
	{
		name: "no recovery, stale available",
		reading: { ...available, stale: true },
		now,
		user: go,
		automatic: wait,
	},
	{
		name: "no recovery, stale full",
		reading: { ...full, stale: true },
		now,
		user: waitUntil,
		automatic: waitUntil,
	},
	{
		name: "no recovery, full 1 ms before reset",
		reading: full,
		now: reset - 1,
		user: waitUntil,
		automatic: waitUntil,
	},
	{
		name: "no recovery, full exactly at reset",
		reading: full,
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "no recovery, full 1 ms after reset",
		reading: full,
		now: reset + 1,
		user: go,
		automatic: go,
	},
	{
		name: "no recovery, limited without a known reset",
		reading: { ...full, windows: [{ kind: "five_hour", utilization: 100 }] },
		now,
		user: go,
		automatic: wait,
	},
	{
		name: "no recovery, unknown cannot prove full",
		reading: { ...full, status: "unknown" },
		now,
		user: go,
		automatic: wait,
	},
	{
		name: "no recovery, available but full",
		reading: { ...full, status: "available" },
		now,
		user: waitUntil,
		automatic: waitUntil,
	},
	// Limit Recovery: freshness is relative to the limit, not the wall clock.
	{
		name: "fresh available proves five-hour free",
		reading: available,
		recovery,
		now,
		user: go,
		automatic: go,
	},
	{
		name: "fresh available proves weekly free",
		reading: available,
		recovery: { ...recovery, rateLimitType: "seven_day" },
		now,
		user: go,
		automatic: go,
	},
	{
		name: "available before limit cannot free it",
		reading: { ...available, readAt: now - 3_000 },
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "available at limitedAt cannot free it",
		reading: { ...available, readAt: now - 2_000 },
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "full before limit cannot block user or replace event reset",
		reading: { ...full, readAt: now - 3_000 },
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "stale available cannot free it",
		reading: { ...available, stale: true },
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "unknown cannot free it",
		reading: { ...available, status: "unknown", windows: [] },
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "unknown model reading still supplies the limiting reset",
		reading: {
			...available,
			status: "unknown",
			windows: [
				{
					kind: "seven_day_model",
					model: "Sonnet",
					utilization: 0,
					resetsAt: new Date(laterReset).toISOString(),
				},
			],
		},
		recovery: { ...recovery, rateLimitType: "seven_day_sonnet" },
		now: reset,
		user: go,
		automatic: {
			kind: "wait-until",
			until: laterReset,
			label: "Sonnet weekly limit",
		},
	},
	{
		name: "missing reading uses event reset seconds",
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "missing reading and reset has no known time",
		recovery: { ...recovery, resetsAt: undefined },
		now,
		user: go,
		automatic: wait,
	},
	{
		name: "signed out overrides full windows and passed reset",
		reading: { ...full, status: "unavailable" },
		recovery,
		now: reset + 1,
		user: signedOut,
		automatic: signedOut,
	},
	{
		name: "fresh full blocks both askers",
		reading: full,
		recovery,
		now,
		user: waitUntil,
		automatic: waitUntil,
	},
	{
		name: "stale full still blocks both askers",
		reading: { ...full, stale: true },
		recovery,
		now,
		user: waitUntil,
		automatic: waitUntil,
	},
	{
		name: "later full reading overrides event reset and names weekly window",
		reading: {
			...full,
			windows: [
				{
					kind: "seven_day",
					utilization: 100,
					resetsAt: new Date(laterReset).toISOString(),
				},
			],
		},
		recovery: { ...recovery, rateLimitType: "seven_day" },
		now: reset,
		user: { kind: "wait-until", until: laterReset, label: "weekly limit" },
		automatic: { kind: "wait-until", until: laterReset, label: "weekly limit" },
	},
	{
		name: "multiple full plan windows wait for the last reset",
		reading: {
			...full,
			windows: [
				...full.windows,
				{
					kind: "seven_day",
					utilization: 100,
					resetsAt: new Date(laterReset).toISOString(),
				},
			],
		},
		recovery,
		now,
		user: { kind: "wait-until", until: laterReset, label: "weekly limit" },
		automatic: { kind: "wait-until", until: laterReset, label: "weekly limit" },
	},
	{
		name: "known full takes priority over a different expired recovery",
		reading: full,
		recovery: {
			...recovery,
			rateLimitType: "seven_day",
			resetsAt: (now - 1_000) / 1_000,
		},
		now,
		user: waitUntil,
		automatic: waitUntil,
	},
	{
		name: "event reset 1 ms before",
		recovery,
		now: reset - 1,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "event reset exactly at reset",
		recovery,
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "event reset 1 ms after",
		recovery,
		now: reset + 1,
		user: go,
		automatic: go,
	},
	{
		name: "reading reset exactly at reset",
		reading: full,
		recovery: { ...recovery, resetsAt: laterReset / 1_000 },
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "reading reset 1 ms before",
		reading: full,
		recovery: { ...recovery, resetsAt: laterReset / 1_000 },
		now: reset - 1,
		user: waitUntil,
		automatic: waitUntil,
	},
	{
		name: "full before limit cannot postpone passed event reset",
		reading: {
			...full,
			readAt: now - 3_000,
			windows: [
				{
					kind: "five_hour",
					utilization: 100,
					resetsAt: new Date(laterReset).toISOString(),
				},
			],
		},
		recovery,
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "stale available uses later reading reset",
		reading: {
			...available,
			stale: true,
			windows: [
				{
					kind: "five_hour",
					utilization: 20,
					resetsAt: new Date(laterReset).toISOString(),
				},
			],
		},
		recovery,
		now: reset,
		user: go,
		automatic: { kind: "wait-until", until: laterReset, label: "5-hour limit" },
	},
	{
		name: "missing reading reset falls back to event",
		reading: { ...available, stale: true, windows: [] },
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "invalid reading reset falls back to event",
		reading: {
			...available,
			stale: true,
			windows: [{ kind: "five_hour", utilization: 20, resetsAt: "invalid" }],
		},
		recovery,
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "model-only recovery cannot be proven free early",
		reading: {
			...available,
			windows: [
				...available.windows,
				{ kind: "seven_day_model", model: "Sonnet", utilization: 0 },
			],
		},
		recovery: { ...recovery, rateLimitType: "seven_day_sonnet" },
		now,
		user: go,
		automatic: {
			kind: "wait-until",
			until: reset,
			label: "Sonnet weekly limit",
		},
	},
	{
		name: "model-only recovery uses its own reading reset",
		reading: {
			...available,
			windows: [
				...available.windows,
				{
					kind: "seven_day_model",
					model: "Sonnet",
					utilization: 0,
					resetsAt: new Date(laterReset).toISOString(),
				},
			],
		},
		recovery: { ...recovery, rateLimitType: "seven_day_sonnet" },
		now: reset,
		user: go,
		automatic: {
			kind: "wait-until",
			until: laterReset,
			label: "Sonnet weekly limit",
		},
	},
	{
		name: "other model's reset cannot release model-only recovery",
		reading: {
			...available,
			windows: [
				{
					kind: "seven_day_model",
					model: "Opus",
					utilization: 0,
					resetsAt: new Date(now - 1_000).toISOString(),
				},
			],
		},
		recovery: { ...recovery, rateLimitType: "seven_day_sonnet" },
		now,
		user: go,
		automatic: {
			kind: "wait-until",
			until: reset,
			label: "Sonnet weekly limit",
		},
	},
	{
		name: "model-only recovery clears at reset",
		reading: available,
		recovery: { ...recovery, rateLimitType: "seven_day_opus" },
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "overage cannot be proven free early",
		reading: available,
		recovery: { ...recovery, rateLimitType: "overage" },
		now,
		user: go,
		automatic: { kind: "wait-until", until: reset, label: "usage limit" },
	},
	{
		name: "overage clears at reset",
		reading: available,
		recovery: { ...recovery, rateLimitType: "overage" },
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "time-only cannot be proven free early",
		reading: available,
		recovery: { ...recovery, timeOnly: true },
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "time-only clears at reset",
		reading: available,
		recovery: { ...recovery, timeOnly: true },
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "explicit false timeOnly allows proven free",
		reading: available,
		recovery: { ...recovery, timeOnly: false },
		now,
		user: go,
		automatic: go,
	},
	{
		name: "missing limitedAt cannot be proven free",
		reading: available,
		recovery: { ...recovery, limitedAt: undefined },
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "missing limitedAt cannot treat full reading as later",
		reading: full,
		recovery: { ...recovery, limitedAt: undefined },
		now,
		user: go,
		automatic: waitUntil,
	},
	{
		name: "missing limitedAt ignores reading reset",
		reading: {
			...full,
			windows: [
				{
					kind: "five_hour",
					utilization: 100,
					resetsAt: new Date(laterReset).toISOString(),
				},
			],
		},
		recovery: { ...recovery, limitedAt: undefined },
		now: reset,
		user: go,
		automatic: go,
	},
	{
		name: "zero limitedAt is a real timestamp",
		reading: available,
		recovery: { ...recovery, limitedAt: 0 },
		now,
		user: go,
		automatic: go,
	},
];

describe("accountLimit", () => {
	it.each(
		cases.flatMap(({ name, user, automatic, ...input }) => [
			{ name, ...input, asker: "user" as const, expected: user },
			{ name, ...input, asker: "automatic" as const, expected: automatic },
		]),
	)("$name, $asker", ({ name: _name, expected, ...input }) => {
		expect(accountLimit(input)).toEqual(expected);
	});
});

describe("accountLimitWindowLabel", () => {
	it.each<[UsageWindow | string, string]>([
		["five_hour", "5-hour limit"],
		["seven_day", "weekly limit"],
		["seven_day_sonnet", "Sonnet weekly limit"],
		["seven_day_opus", "Opus weekly limit"],
		[
			{ kind: "seven_day_model", model: "Sonnet", utilization: 50 },
			"Sonnet weekly limit",
		],
		[
			{ kind: "seven_day_model", model: "Fable", utilization: 50 },
			"Fable weekly limit",
		],
		[{ kind: "seven_day_model", utilization: 50 }, "model weekly limit"],
		["overage", "usage limit"],
	])("%j -> %s", (window, expected) => {
		expect(accountLimitWindowLabel(window)).toBe(expected);
	});
});
