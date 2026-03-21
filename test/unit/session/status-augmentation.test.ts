import { describe, expect, it } from "vitest";
import {
	type AugmentInput,
	computeAugmentedStatuses,
} from "../../../src/lib/session/status-augmentation.js";

describe("computeAugmentedStatuses", () => {
	it("propagates busy to parent session not in raw statuses", () => {
		const input: AugmentInput = {
			raw: { child1: { type: "busy" } },
			parentMap: new Map([["child1", "parent1"]]),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map(),
			sseIdleSessions: new Set(),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.augmented["parent1"]).toEqual({ type: "busy" });
	});

	it("does not override existing parent status", () => {
		const input: AugmentInput = {
			raw: {
				child1: { type: "busy" },
				parent1: { type: "idle" },
			},
			parentMap: new Map([["child1", "parent1"]]),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map(),
			sseIdleSessions: new Set(),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.augmented["parent1"]).toEqual({ type: "idle" });
	});

	it("resolves parent from childToParentResolved cache", () => {
		const input: AugmentInput = {
			raw: { child1: { type: "busy" } },
			parentMap: new Map(),
			childToParentResolved: new Map([["child1", "parent1"]]),
			messageActivityTimestamps: new Map(),
			sseIdleSessions: new Set(),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.augmented["parent1"]).toEqual({ type: "busy" });
	});

	it("injects busy for session with active message activity", () => {
		const input: AugmentInput = {
			raw: {},
			parentMap: new Map(),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map([["s1", 500]]),
			sseIdleSessions: new Set(),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.augmented["s1"]).toEqual({ type: "busy" });
	});

	it("marks expired message activity for cleanup", () => {
		const input: AugmentInput = {
			raw: {},
			parentMap: new Map(),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map([["s1", 500]]),
			sseIdleSessions: new Set(),
			now: 20_000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.expiredActivitySessions).toContain("s1");
		expect(result.augmented["s1"]).toBeUndefined();
	});

	it("does not inject message activity if session already in raw", () => {
		const input: AugmentInput = {
			raw: { s1: { type: "idle" } },
			parentMap: new Map(),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map([["s1", 500]]),
			sseIdleSessions: new Set(),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.augmented["s1"]).toEqual({ type: "idle" });
	});

	it("clears sseIdle for sessions that became busy", () => {
		const input: AugmentInput = {
			raw: { s1: { type: "busy" } },
			parentMap: new Map(),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map(),
			sseIdleSessions: new Set(["s1", "s2"]),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.sseIdleToRemove).toContain("s1");
		expect(result.sseIdleToRemove).not.toContain("s2");
	});

	it("handles retry status as busy for subagent propagation", () => {
		const input: AugmentInput = {
			raw: {
				child1: { type: "retry", attempt: 1, message: "err", next: 2000 },
			},
			parentMap: new Map([["child1", "parent1"]]),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map(),
			sseIdleSessions: new Set(),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.augmented["parent1"]).toEqual({ type: "busy" });
	});

	it("parentMap takes precedence over childToParentResolved", () => {
		const input: AugmentInput = {
			raw: { child1: { type: "busy" } },
			parentMap: new Map([["child1", "parentA"]]),
			childToParentResolved: new Map([["child1", "parentB"]]),
			messageActivityTimestamps: new Map(),
			sseIdleSessions: new Set(),
			now: 1000,
			messageActivityTtlMs: 10_000,
		};
		const result = computeAugmentedStatuses(input);
		expect(result.augmented["parentA"]).toEqual({ type: "busy" });
		expect(result.augmented["parentB"]).toBeUndefined();
	});
});
