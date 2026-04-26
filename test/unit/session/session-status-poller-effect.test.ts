import { describe, it } from "@effect/vitest";
import { Duration, Effect, HashMap, Layer, Ref } from "effect";
import { expect, vi } from "vitest";
import {
	makePollerStateLive,
	PollerStateTag,
	reconcile,
	type StatusCorrection,
} from "../../../src/lib/effect/session-status-poller.js";

describe("SessionStatusPoller Effect", () => {
	const mockApi = {
		getSessionStatuses: vi.fn().mockReturnValue(
			Effect.succeed([
				{ id: "s1", status: "idle" },
				{ id: "s2", status: "busy" },
			]),
		),
	};

	const mockDb = {
		getSessionStatuses: vi.fn().mockReturnValue(
			Effect.succeed([
				{ id: "s1", status: "idle" },
				{ id: "s2", status: "idle" }, // Mismatch — API says busy, DB says idle
			]),
		),
	};

	it.effect("initializes with empty state", () =>
		Effect.gen(function* () {
			const ref = yield* PollerStateTag;
			const result = yield* Ref.get(ref);
			expect(HashMap.size(result.previousStatuses)).toBe(0);
			expect(HashMap.size(result.activityTimestamps)).toBe(0);
		}).pipe(Effect.provide(Layer.fresh(makePollerStateLive()))),
	);

	it.effect("reconcile detects status mismatches", () =>
		Effect.gen(function* () {
			const corrections: StatusCorrection[] = [];
			const applyCorrection = vi.fn((c: StatusCorrection) => {
				corrections.push(c);
				return Effect.succeed(undefined);
			});
			yield* reconcile(mockDb, mockApi, applyCorrection);
			expect(corrections.length).toBeGreaterThanOrEqual(1);
		}).pipe(Effect.provide(Layer.fresh(makePollerStateLive()))),
	);

	it.effect("isMessageActive checks TTL correctly", () =>
		Effect.gen(function* () {
			const now = Date.now();
			const ref = yield* PollerStateTag;
			yield* Ref.update(ref, (s) => ({
				...s,
				activityTimestamps: HashMap.fromIterable([
					["active", now - 1000] as const,
					["stale", now - 300_000] as const,
				]),
			}));
			const state = yield* Ref.get(ref);
			const activeTTL = Duration.seconds(60);
			const activeTs = HashMap.unsafeGet(state.activityTimestamps, "active");
			const staleTs = HashMap.unsafeGet(state.activityTimestamps, "stale");
			expect(now - activeTs < Duration.toMillis(activeTTL)).toBe(true);
			expect(now - staleTs < Duration.toMillis(activeTTL)).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makePollerStateLive()))),
	);
});
