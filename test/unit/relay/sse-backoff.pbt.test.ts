// ─── Property-Based Tests: SSE Reconnection & Backoff (Ticket 1.2) ───────────
//
// Properties tested:
// P1: Backoff delay is always in [baseDelay, maxDelay] (AC3)
// P2: Backoff delay is monotonically non-decreasing until cap (AC3)
// P3: Backoff reaches maxDelay eventually (AC3)
// P7: Default config matches spec: 1s, 2s, 4s, 8s, max 30s (AC3)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type BackoffConfig,
	calculateBackoffDelay,
} from "../../../src/lib/relay/sse-backoff.js";

const SEED = 42;
const NUM_RUNS = 300;

// ─── Generators ─────────────────────────────────────────────────────────────

const arbBackoffConfig: fc.Arbitrary<BackoffConfig> = fc
	.record({
		baseDelay: fc.integer({ min: 1, max: 10_000 }),
		maxDelay: fc.integer({ min: 1, max: 120_000 }),
		multiplier: fc.oneof(
			fc.constant(2),
			fc.constant(1.5),
			fc.constant(3),
			fc.double({ min: 1.1, max: 5, noNaN: true }),
		),
	})
	.map((c) => ({
		...c,
		// Ensure maxDelay >= baseDelay
		maxDelay: Math.max(c.maxDelay, c.baseDelay),
	}));

describe("Ticket 1.2 — SSE Reconnection & Backoff PBT", () => {
	// ─── P1: Backoff delay bounds ──────────────────────────────────────────

	describe("P1: Backoff delay is always in [baseDelay, maxDelay] (AC3)", () => {
		it("property: delay is bounded", () => {
			fc.assert(
				fc.property(
					fc.nat({ max: 50 }),
					arbBackoffConfig,
					(attempt, config) => {
						const delay = calculateBackoffDelay(attempt, config);
						expect(delay).toBeGreaterThanOrEqual(config.baseDelay);
						expect(delay).toBeLessThanOrEqual(config.maxDelay);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: negative attempt returns baseDelay", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: -1000, max: -1 }),
					arbBackoffConfig,
					(attempt, config) => {
						const delay = calculateBackoffDelay(attempt, config);
						expect(delay).toBe(config.baseDelay);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: Monotonic non-decreasing ──────────────────────────────────────

	describe("P2: Backoff delay is monotonically non-decreasing (AC3)", () => {
		it("property: delay(n) <= delay(n+1)", () => {
			fc.assert(
				fc.property(
					fc.nat({ max: 49 }),
					arbBackoffConfig,
					(attempt, config) => {
						const d1 = calculateBackoffDelay(attempt, config);
						const d2 = calculateBackoffDelay(attempt + 1, config);
						expect(d2).toBeGreaterThanOrEqual(d1);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: Reaches maxDelay eventually ───────────────────────────────────

	describe("P3: Backoff reaches maxDelay eventually (AC3)", () => {
		it("property: sufficiently large attempt -> maxDelay", () => {
			fc.assert(
				fc.property(arbBackoffConfig, (config) => {
					const n = Math.ceil(
						Math.log(config.maxDelay / config.baseDelay) /
							Math.log(config.multiplier),
					);
					const attempt = n + 5;
					const delay = calculateBackoffDelay(attempt, config);
					expect(delay).toBe(config.maxDelay);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P7: Default config matches spec ──────────────────────────────────

	describe("P7: Default config matches spec: 1s, 2s, 4s, 8s, max 30s (AC3)", () => {
		it("first 6 delays match spec exactly", () => {
			const delays = Array.from({ length: 6 }, (_, i) =>
				calculateBackoffDelay(i),
			);
			expect(delays[0]).toBe(1000); // 1s
			expect(delays[1]).toBe(2000); // 2s
			expect(delays[2]).toBe(4000); // 4s
			expect(delays[3]).toBe(8000); // 8s
			expect(delays[4]).toBe(16000); // 16s
			expect(delays[5]).toBe(30000); // capped at 30s
		});

		it("property: all further attempts stay at 30s", () => {
			fc.assert(
				fc.property(fc.integer({ min: 5, max: 100 }), (attempt) => {
					const delay = calculateBackoffDelay(attempt);
					expect(delay).toBe(30000);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
