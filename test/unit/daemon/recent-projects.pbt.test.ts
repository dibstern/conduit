// ─── Property-Based Tests: Recent Projects (Ticket 3.6) ────────────────────
//
// Properties tested:
// P1: addRecent always keeps list ≤ MAX_RECENT_PROJECTS (AC3)
// P2: addRecent moves existing directory to front (updates lastUsed) (AC1)
// P3: getRecent returns list sorted by lastUsed descending (AC2)
// P4: pruneRecent never exceeds maxSize (AC3)
// P5: serialize→deserialize roundtrip (AC2)
// P6: deserializeRecent handles corrupt JSON gracefully (safety)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	addRecent,
	deserializeRecent,
	getRecent,
	MAX_RECENT_PROJECTS,
	pruneRecent,
	serializeRecent,
} from "../../../src/lib/daemon/recent-projects.js";
import type { RecentProject } from "../../../src/lib/types.js";
import {
	edgeCaseString,
	recentProjectList,
	timestamp,
} from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

describe("Ticket 3.6 — Recent Projects PBT", () => {
	// ─── P1: List size invariant ──────────────────────────────────────────

	describe("P1: addRecent never exceeds MAX_RECENT_PROJECTS (AC3)", () => {
		it("property: after any number of adds, list.length ≤ 20", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							directory: fc
								.string({ minLength: 1, maxLength: 50 })
								.map((s) => `/home/${s}`),
							slug: fc.string({ minLength: 1, maxLength: 20 }),
							now: timestamp,
						}),
						{ minLength: 0, maxLength: 30 },
					),
					(entries) => {
						let list: RecentProject[] = [];
						for (const entry of entries) {
							list = addRecent(
								list,
								entry.directory,
								entry.slug,
								undefined,
								entry.now,
							);
						}
						expect(list.length).toBeLessThanOrEqual(MAX_RECENT_PROJECTS);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: Dedup and move to front ─────────────────────────────────────

	describe("P2: addRecent deduplicates by directory (AC1)", () => {
		it("property: adding same directory twice → only one entry, latest timestamp", () => {
			fc.assert(
				fc.property(
					recentProjectList,
					fc.string({ minLength: 1, maxLength: 50 }).map((s) => `/home/${s}`),
					fc.string({ minLength: 1, maxLength: 20 }),
					timestamp,
					timestamp,
					(initial, dir, slug, time1, time2) => {
						let list = addRecent(initial, dir, slug, undefined, time1);
						const countAfterFirst = list.filter(
							(p) => p.directory === dir,
						).length;
						expect(countAfterFirst).toBe(1);

						list = addRecent(list, dir, slug, undefined, time2);
						const countAfterSecond = list.filter(
							(p) => p.directory === dir,
						).length;
						expect(countAfterSecond).toBe(1);

						// Latest timestamp should be the second
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						const entry = list.find((p) => p.directory === dir)!;
						expect(entry.lastUsed).toBe(time2);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: Sorted order ────────────────────────────────────────────────

	describe("P3: getRecent returns sorted by lastUsed descending (AC2)", () => {
		it("property: result is sorted descending by lastUsed", () => {
			fc.assert(
				fc.property(recentProjectList, (list) => {
					const sorted = getRecent(list);
					for (let i = 1; i < sorted.length; i++) {
						// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
						expect(sorted[i - 1]!.lastUsed).toBeGreaterThanOrEqual(
							// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
							sorted[i]!.lastUsed,
						);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: getRecent preserves all elements (no data loss)", () => {
			fc.assert(
				fc.property(recentProjectList, (list) => {
					const sorted = getRecent(list);
					expect(sorted).toHaveLength(list.length);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P4: Prune invariant ──────────────────────────────────────────────

	describe("P4: pruneRecent never exceeds maxSize (AC3)", () => {
		it("property: pruneRecent(list, n) always returns ≤ n items", () => {
			fc.assert(
				fc.property(
					recentProjectList,
					fc.integer({ min: 0, max: 30 }),
					(list, maxSize) => {
						const pruned = pruneRecent(list, maxSize);
						expect(pruned.length).toBeLessThanOrEqual(maxSize);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: pruneRecent keeps the most recent entries", () => {
			fc.assert(
				fc.property(
					recentProjectList.filter((l) => l.length > 0),
					fc.integer({ min: 1, max: 20 }),
					(list, maxSize) => {
						const pruned = pruneRecent(list, maxSize);

						// Every kept entry should have lastUsed >= every removed entry
						const _prunedMinTime = Math.min(...pruned.map((p) => p.lastUsed));
						const allTimes = list.map((p) => p.lastUsed).sort((a, b) => b - a);
						const cutoff =
							allTimes[Math.min(maxSize, allTimes.length) - 1] ?? 0;

						for (const p of pruned) {
							expect(p.lastUsed).toBeGreaterThanOrEqual(cutoff);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P5: Serialize/deserialize roundtrip ──────────────────────────────

	describe("P5: serialize→deserialize roundtrip (AC2)", () => {
		it("property: roundtrip preserves all entries", () => {
			fc.assert(
				fc.property(recentProjectList, (list) => {
					// Ensure valid entries (match what deserialize expects)
					const valid = list.filter(
						(p) => p.directory.length > 0 && p.slug.length > 0,
					);
					const json = serializeRecent(valid);
					const parsed = deserializeRecent(json);

					expect(parsed).toHaveLength(valid.length);
					for (let i = 0; i < valid.length; i++) {
						// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
						expect(parsed[i]!.directory).toBe(valid[i]!.directory);
						// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
						expect(parsed[i]!.slug).toBe(valid[i]!.slug);
						// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
						expect(parsed[i]!.lastUsed).toBe(valid[i]!.lastUsed);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P6: Corrupt JSON handling ────────────────────────────────────────

	describe("P6: deserializeRecent handles corrupt input (safety)", () => {
		it("property: arbitrary strings never throw, return empty array", () => {
			fc.assert(
				fc.property(edgeCaseString, (json) => {
					const result = deserializeRecent(json);
					expect(Array.isArray(result)).toBe(true);
					// All returned entries should be valid
					for (const entry of result) {
						expect(typeof entry.directory).toBe("string");
						expect(typeof entry.slug).toBe("string");
						expect(typeof entry.lastUsed).toBe("number");
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: valid JSON but wrong shape returns empty array", () => {
			fc.assert(
				fc.property(fc.jsonValue(), (value) => {
					const json = JSON.stringify(value);
					const result = deserializeRecent(json);
					expect(Array.isArray(result)).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
