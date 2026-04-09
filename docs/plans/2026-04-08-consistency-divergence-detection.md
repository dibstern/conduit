# Consistency & Divergence Detection Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Add comprehensive consistency verification, divergence detection, and automatic rollback for the JSONL→SQLite dual-write migration — ensuring data correctness is verified at every phase, not just assumed.

**Architecture:** Three layers of defense: (1) a `ShadowRead` comparison framework that runs both legacy and SQLite paths side-by-side for every Phase 4 sub-phase, logging diffs without affecting the served result; (2) a `DivergenceCircuitBreaker` that tracks divergence rates per read path and auto-reverts flags when a threshold is exceeded; (3) event-store integrity checks and a `DualWriteAuditor` that spot-checks canonical event correctness against in-memory relay state. All mechanisms are additive amendments to the existing orchestrator implementation plan — they modify existing tasks' code, not the plan's phase structure.

**Tech Stack:** TypeScript, Vitest, existing `ReadFlags` / `ReadQueryService` / `PersistenceDiagnostics` from the orchestrator plan.

**Parent plan:** `docs/plans/2026-04-05-orchestrator-implementation-plan.md`

---

## Plan Overview

| Task | Goal | Amends |
|------|------|--------|
| 1 | Three-state `ReadFlagMode` (legacy / shadow / sqlite) | Task 24 |
| 2 | Generic `ShadowReadComparator` framework | New file |
| 3 | Per-flag `ReadPathStats` + `DivergenceCircuitBreaker` | New file, Task 24 |
| 4 | Shadow-read wiring for 4a (tool content) | Task 25 |
| 5 | Shadow-read wiring for 4b (fork metadata) | Task 26 |
| 6 | Shadow-read wiring for 4e (session history) | Tasks 31-32 |
| 7 | Shadow-read wiring for 4f (pending approvals) | Tasks 33-34 |
| 8 | Retrofit 4c (session list) + 4d (session status) to use `ShadowReadComparator` | Tasks 28, 30 |
| 9 | Event store integrity checks | Task 22.5 |
| 10 | `DualWriteAuditor` — spot-check canonical events vs relay state | Task 22.5 / Task 10 |
| 11 | Rollback procedure documentation | Phase 4 intro |
| 12 | Wire circuit breaker + diagnostics into relay stack | Task 24.5, Task 12 |

---

## Audit Amendments (2026-04-08)

The following amendments address findings from the parallel plan audit. All are applied inline to the task code below.

### Critical Amendments

| ID | Task | Finding | Fix |
|----|------|---------|-----|
| C1 | 1 | **Truthy string bug**: Parent plan checks like `if (flags.toolContent)` are truthy for all non-empty strings including `"legacy"`. All Phase 4 handlers would take the SQLite path unconditionally. | Add `isActive(mode)` and `isSqlite(mode)` helper functions to `read-flags.ts`. All parent plan checks must use `isActive(flags.toolContent)` instead of `if (flags.toolContent)`. Document this as a required amendment to parent plan Tasks 25-34. |
| C2 | 2 | **Stale mode capture**: `ShadowReadComparator` stores `mode` as a readonly config field. When the circuit breaker trips and mutates `flags[name] = "legacy"`, the comparator continues operating in its pre-trip mode. The breaker is effectively disconnected. | Change `mode` from a static value to a `getMode: () => ReadFlagMode` getter function. The comparator reads the mode dynamically on every `.read()` call. |
| C3 | 4-7,12 | **Dead code — no wiring**: Tasks 4-7 define comparators and comparison functions but never show how the comparator instances reach their consumers (HandlerDeps, SessionManager, etc.). Task 12 creates breakers but not comparators. | Expand Task 12 to show explicit per-sub-phase comparator construction in relay-stack.ts, HandlerDeps field additions, and wiring into each handler. |
| C4 | 2 | **Uncaught sqliteFn() throw**: In shadow mode, `sqliteFn()` is called synchronously. If it throws, the exception crashes the request handler even though the legacy value was available. Violates shadow mode's contract of "never affect the served result." | Wrap `sqliteFn()` in try/catch in shadow mode. Log the error, return legacy result. |

### Important Amendments

| ID | Task | Finding | Fix |
|----|------|---------|-----|
| I1 | 1 | `true → "sqlite"` backward compat mapping skips the shadow validation phase entirely. | **Ask User**: Decided to keep as-is. The mapping is for existing boolean configs. New deployments should use the three-state mode string. Document the risk. |
| I2 | 6 | Session history comparator only checks `text` on the latest message. Missing `parts`, `role`, `tokens`, `cost` fields. | Expand `compareSessionHistory` to check role and message count per role. Don't deep-compare `parts` (too expensive for fire-and-forget); text + role + count is sufficient for divergence detection. |
| I3 | 7 | Pending approvals comparator skips `toolName` field comparison. | Add `toolName` mismatch detection. |
| I4 | 2 | Test uses `Promise.resolve("legacy-value")` reference equality which fails with `toEqual`. | Fix test to use `await result.value` for assertion. |
| I5 | 10 | `DualWriteAuditor.audit()` takes a `RelaySnapshot` but no caller is shown. | Add relay snapshot construction to Task 12's periodic audit timer setup. |
| I6 | 9 | Sequence gap detection is unnecessary — AUTOINCREMENT sequences can't have gaps unless rows are deleted, which the append-only store never does. | Replace with simpler max-sequence check. Keep orphan and unparsable checks. |

---

### Task 1: Three-State ReadFlagMode

**Files:**
- Modify: `src/lib/persistence/read-flags.ts`
- Modify: `test/unit/persistence/read-flags.test.ts`

**Purpose:** Replace the boolean `ReadFlags` with a three-state `ReadFlagMode`: `"legacy"` (serve legacy, no SQLite query), `"shadow"` (serve legacy, query SQLite in background, log diffs), `"sqlite"` (serve SQLite, query legacy in background, log diffs). This is the standard dark-launch / Scientist pattern. The existing plan's Task 24 defines boolean flags; this replaces them.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/read-flags.test.ts
import { describe, expect, it } from "vitest";
import {
	createReadFlags,
	type ReadFlagConfig,
	type ReadFlags,
	type ReadFlagMode,
} from "../../../src/lib/persistence/read-flags.js";

describe("ReadFlags (three-state)", () => {
	it("defaults all flags to 'legacy'", () => {
		const flags = createReadFlags();
		expect(flags.toolContent).toBe("legacy");
		expect(flags.forkMetadata).toBe("legacy");
		expect(flags.sessionList).toBe("legacy");
		expect(flags.sessionStatus).toBe("legacy");
		expect(flags.sessionHistory).toBe("legacy");
		expect(flags.pendingApprovals).toBe("legacy");
	});

	it("accepts partial overrides", () => {
		const flags = createReadFlags({ toolContent: "shadow", sessionList: "sqlite" });
		expect(flags.toolContent).toBe("shadow");
		expect(flags.forkMetadata).toBe("legacy");
		expect(flags.sessionList).toBe("sqlite");
		expect(flags.sessionStatus).toBe("legacy");
	});

	it("accepts all flags as sqlite", () => {
		const flags = createReadFlags({
			toolContent: "sqlite",
			forkMetadata: "sqlite",
			sessionList: "sqlite",
			sessionStatus: "sqlite",
			sessionHistory: "sqlite",
			pendingApprovals: "sqlite",
		});
		expect(flags.toolContent).toBe("sqlite");
		expect(flags.pendingApprovals).toBe("sqlite");
	});

	it("flags are mutable for runtime toggling", () => {
		const flags = createReadFlags();
		expect(flags.toolContent).toBe("legacy");
		flags.toolContent = "shadow";
		expect(flags.toolContent).toBe("shadow");
		flags.toolContent = "sqlite";
		expect(flags.toolContent).toBe("sqlite");
	});

	it("backward compat: boolean true maps to 'sqlite'", () => {
		// Support existing config that may pass booleans during transition
		const flags = createReadFlags({ toolContent: true as unknown as ReadFlagMode });
		expect(flags.toolContent).toBe("sqlite");
	});

	it("backward compat: boolean false maps to 'legacy'", () => {
		const flags = createReadFlags({ toolContent: false as unknown as ReadFlagMode });
		expect(flags.toolContent).toBe("legacy");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/read-flags.test.ts`
Expected: FAIL — current implementation returns booleans, not strings.

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/read-flags.ts

/**
 * Three-state read path mode for each Phase 4 sub-phase.
 *
 * - "legacy": Serve from legacy source (JSONL/REST/memory). No SQLite query.
 * - "shadow": Serve from legacy source. Query SQLite in background, log diffs.
 *             Use this to validate SQLite correctness before switching reads.
 * - "sqlite": Serve from SQLite. Query legacy in background, log diffs.
 *             Use this when confident SQLite is correct.
 *
 * Progression: legacy → shadow → sqlite → (Phase 7 removes legacy entirely)
 */
export type ReadFlagMode = "legacy" | "shadow" | "sqlite";

export interface ReadFlagConfig {
	toolContent?: ReadFlagMode;
	forkMetadata?: ReadFlagMode;
	sessionList?: ReadFlagMode;
	sessionStatus?: ReadFlagMode;
	sessionHistory?: ReadFlagMode;
	pendingApprovals?: ReadFlagMode;
}

export interface ReadFlags {
	toolContent: ReadFlagMode;
	forkMetadata: ReadFlagMode;
	sessionList: ReadFlagMode;
	sessionStatus: ReadFlagMode;
	sessionHistory: ReadFlagMode;
	pendingApprovals: ReadFlagMode;
}

/** Normalize a config value that may be a boolean (backward compat) or a mode string. */
function normalizeMode(value: ReadFlagMode | boolean | undefined): ReadFlagMode {
	if (value === undefined) return "legacy";
	if (value === true) return "sqlite";
	if (value === false) return "legacy";
	return value;
}

export function createReadFlags(config?: ReadFlagConfig): ReadFlags {
	return {
		toolContent: normalizeMode(config?.toolContent as ReadFlagMode | boolean | undefined),
		forkMetadata: normalizeMode(config?.forkMetadata as ReadFlagMode | boolean | undefined),
		sessionList: normalizeMode(config?.sessionList as ReadFlagMode | boolean | undefined),
		sessionStatus: normalizeMode(config?.sessionStatus as ReadFlagMode | boolean | undefined),
		sessionHistory: normalizeMode(config?.sessionHistory as ReadFlagMode | boolean | undefined),
		pendingApprovals: normalizeMode(config?.pendingApprovals as ReadFlagMode | boolean | undefined),
	};
}

// ─── Mode Check Helpers ─────────────────────────────────────────────────────
//
// (C1) CRITICAL: DO NOT use `if (flags.toolContent)` — all non-empty strings
// are truthy, so "legacy" would activate the SQLite path. Always use these
// helpers. All parent plan Tasks 25-34 must be amended to replace:
//   `if (this.readFlags?.sessionList && this.readQuery)`
// with:
//   `if (isActive(this.readFlags?.sessionList) && this.readQuery)`

/** Returns true if the mode involves querying SQLite (shadow or sqlite). */
export function isActive(mode: ReadFlagMode | undefined): boolean {
	return mode === "shadow" || mode === "sqlite";
}

/** Returns true if SQLite is the authoritative source. */
export function isSqlite(mode: ReadFlagMode | undefined): boolean {
	return mode === "sqlite";
}

/** Returns true if the mode is shadow (legacy authoritative, SQLite compared). */
export function isShadow(mode: ReadFlagMode | undefined): boolean {
	return mode === "shadow";
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/read-flags.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/read-flags.ts test/unit/persistence/read-flags.test.ts
git commit -m "feat(persistence): replace boolean ReadFlags with three-state ReadFlagMode (legacy/shadow/sqlite)"
```

---

### Task 2: Generic ShadowReadComparator Framework

**Files:**
- Create: `src/lib/persistence/shadow-read-comparator.ts`
- Test: `test/unit/persistence/shadow-read-comparator.test.ts`

**Purpose:** A generic utility that every Phase 4 sub-phase uses to implement shadow-read and comparison logging. Encapsulates the pattern: "run the authoritative path synchronously, run the non-authoritative path in the background, compare results, log diffs, feed the circuit breaker." Replaces the ad-hoc `compareWithLegacyListInBackground` pattern from Task 28.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/shadow-read-comparator.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	ShadowReadComparator,
	type ComparisonDiff,
	type ShadowReadConfig,
} from "../../../src/lib/persistence/shadow-read-comparator.js";
import type { ReadFlagMode } from "../../../src/lib/persistence/read-flags.js";

function makeComparator<T>(
	mode: ReadFlagMode,
	overrides?: Partial<ShadowReadConfig<T>>,
): { comparator: ShadowReadComparator<T>; log: { warn: ReturnType<typeof vi.fn> } } {
	const log = { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() };
	const comparator = new ShadowReadComparator<T>({
		label: "test-read",
		getMode: () => mode,  // (C2) Dynamic getter
		log,
		compare: overrides?.compare ?? ((a, b) => {
			const diffs: string[] = [];
			if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push("value-mismatch");
			return diffs;
		}),
		...overrides,
	});
	return { comparator, log };
}

describe("ShadowReadComparator", () => {
	describe("legacy mode", () => {
		it("returns legacy result and does not call sqlite", async () => {
			const { comparator } = makeComparator<string>("legacy");
			const sqliteFn = vi.fn(() => "sqlite-value");
			const result = comparator.read(
				() => Promise.resolve("legacy-value"),
				sqliteFn,
			);
			expect(result.source).toBe("legacy");
			expect(await result.value).toBe("legacy-value");
			expect(sqliteFn).not.toHaveBeenCalled();
		});
	});

	describe("shadow mode", () => {
		it("returns legacy result synchronously", async () => {
			const { comparator } = makeComparator<string>("shadow");
			const result = comparator.read(
				() => Promise.resolve("legacy-value"),
				() => "sqlite-value",
			);
			expect(result.source).toBe("legacy");
			const value = await result.value;
			expect(value).toBe("legacy-value");
		});

		it("queries sqlite in background and logs diffs", async () => {
			const { comparator, log } = makeComparator<string>("shadow", {
				compare: (legacy, sqlite) => {
					if (legacy !== sqlite) return [`expected "${legacy}" got "${sqlite}"`];
					return [];
				},
			});
			const result = comparator.read(
				() => Promise.resolve("legacy-value"),
				() => "sqlite-value",
			);
			// Wait for background comparison to complete
			await result.value;
			await new Promise((r) => setTimeout(r, 10));
			expect(log.warn).toHaveBeenCalledWith(
				expect.stringContaining("test-read divergence"),
				expect.objectContaining({ diffs: expect.any(Array) }),
			);
		});

		it("does not log when results match", async () => {
			const { comparator, log } = makeComparator<string>("shadow");
			const result = comparator.read(
				() => Promise.resolve("same"),
				() => "same",
			);
			await result.value;
			await new Promise((r) => setTimeout(r, 10));
			expect(log.warn).not.toHaveBeenCalled();
		});
	});

	describe("sqlite mode", () => {
		it("returns sqlite result synchronously", () => {
			const { comparator } = makeComparator<string>("sqlite");
			const result = comparator.read(
				() => Promise.resolve("legacy-value"),
				() => "sqlite-value",
			);
			expect(result.source).toBe("sqlite");
			// sqlite result is not a promise — it's available immediately
			expect(result.syncValue).toBe("sqlite-value");
		});

		it("queries legacy in background and logs diffs", async () => {
			const { comparator, log } = makeComparator<string>("sqlite", {
				compare: (legacy, sqlite) => {
					if (legacy !== sqlite) return [`mismatch`];
					return [];
				},
			});
			const result = comparator.read(
				() => Promise.resolve("legacy-value"),
				() => "sqlite-value",
			);
			// Wait for background comparison
			await new Promise((r) => setTimeout(r, 10));
			expect(log.warn).toHaveBeenCalledWith(
				expect.stringContaining("test-read divergence"),
				expect.objectContaining({ diffs: expect.any(Array) }),
			);
		});
	});

	describe("stats tracking", () => {
		it("tracks reads, comparisons, and divergences", async () => {
			const { comparator } = makeComparator<string>("shadow", {
				compare: (a, b) => (a !== b ? ["diff"] : []),
			});

			// Matching read
			comparator.read(() => Promise.resolve("same"), () => "same");
			await new Promise((r) => setTimeout(r, 10));

			// Diverging read
			comparator.read(() => Promise.resolve("a"), () => "b");
			await new Promise((r) => setTimeout(r, 10));

			const stats = comparator.getStats();
			expect(stats.totalReads).toBe(2);
			expect(stats.comparisonAttempts).toBe(2);
			expect(stats.comparisonSuccesses).toBe(1);
			expect(stats.comparisonFailures).toBe(1);
		});

		it("tracks comparison errors separately from divergences", async () => {
			const { comparator } = makeComparator<string>("shadow");
			comparator.read(
				() => Promise.reject(new Error("REST unavailable")),
				() => "sqlite-value",
			);
			await new Promise((r) => setTimeout(r, 10));

			const stats = comparator.getStats();
			expect(stats.totalReads).toBe(1);
			expect(stats.comparisonErrors).toBe(1);
			expect(stats.comparisonFailures).toBe(0);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/shadow-read-comparator.test.ts`
Expected: FAIL with "Cannot find module '...shadow-read-comparator.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/shadow-read-comparator.ts

import type { ReadFlagMode } from "./read-flags.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReadPathStats {
	totalReads: number;
	comparisonAttempts: number;
	comparisonSuccesses: number;
	comparisonFailures: number;
	comparisonErrors: number;
	lastDivergenceAt?: number;
}

export interface ComparisonDiff {
	diffs: string[];
	timingGapMs?: number;
}

interface ShadowReadLog {
	warn(msg: string, context?: Record<string, unknown>): void;
	verbose(msg: string, context?: Record<string, unknown>): void;
	info(msg: string, context?: Record<string, unknown>): void;
	debug(msg: string, context?: Record<string, unknown>): void;
}

export interface ShadowReadConfig<T> {
	/** Human-readable label for log messages (e.g. "session-list", "tool-content"). */
	readonly label: string;
	/**
	 * (C2) Dynamic mode getter — reads the current mode on every .read() call.
	 * This is a function, not a static value, because the DivergenceCircuitBreaker
	 * may mutate the ReadFlags object at any time to revert a flag to "legacy".
	 * If this were a snapshot, the comparator would continue operating in its
	 * pre-trip mode after the breaker trips.
	 */
	readonly getMode: () => ReadFlagMode;
	/** Logger for comparison output. */
	readonly log: ShadowReadLog;
	/**
	 * Compare legacy and sqlite results. Return empty array if they match,
	 * or an array of human-readable diff descriptions if they diverge.
	 */
	readonly compare: (legacy: T, sqlite: T) => string[];
	/** Optional callback invoked on every comparison outcome. Used by circuit breaker. */
	readonly onComparison?: (diverged: boolean) => void;
}

export interface ShadowReadResult<T> {
	/** Which source provided the authoritative result. */
	source: "legacy" | "sqlite";
	/** The authoritative value (may be a Promise in legacy/shadow mode). */
	value: T | Promise<T>;
	/** In sqlite mode, the synchronous result. Undefined in legacy/shadow mode. */
	syncValue?: T;
}

// ─── ShadowReadComparator ────────────────────────────────────────────────────

/**
 * Generic shadow-read comparator for Phase 4 read-path migration.
 *
 * Encapsulates the three-mode pattern:
 * - legacy:  serve legacy, skip SQLite entirely
 * - shadow:  serve legacy, query SQLite in background, compare, log diffs
 * - sqlite:  serve SQLite, query legacy in background, compare, log diffs
 *
 * Every Phase 4 sub-phase uses one of these instead of ad-hoc comparison code.
 * Stats are exposed for diagnostics and the circuit breaker.
 */
export class ShadowReadComparator<T> {
	private readonly config: ShadowReadConfig<T>;
	private stats: ReadPathStats = {
		totalReads: 0,
		comparisonAttempts: 0,
		comparisonSuccesses: 0,
		comparisonFailures: 0,
		comparisonErrors: 0,
	};

	constructor(config: ShadowReadConfig<T>) {
		this.config = config;
	}

	/**
	 * Execute a read with shadow comparison based on the current mode.
	 *
	 * @param legacyFn  — returns the legacy result (may be async)
	 * @param sqliteFn  — returns the SQLite result (always sync)
	 */
	read(
		legacyFn: () => T | Promise<T>,
		sqliteFn: () => T,
	): ShadowReadResult<T> {
		this.stats.totalReads++;

		// (C2) Read mode dynamically — the breaker may have tripped since construction
		const mode = this.config.getMode();

		switch (mode) {
			case "legacy":
				return { source: "legacy", value: legacyFn() };

			case "shadow": {
				// Legacy is authoritative. Query SQLite in background for comparison.
				const legacyResult = legacyFn();
				// (C4) Wrap sqliteFn in try/catch — shadow mode must NEVER affect
				// the served result. If SQLite throws, log and skip comparison.
				let sqliteResult: T;
				try {
					sqliteResult = sqliteFn();
				} catch (err) {
					this.stats.comparisonAttempts++;
					this.stats.comparisonErrors++;
					this.config.log.verbose(
						`${this.config.label} shadow sqliteFn threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
					);
					return { source: "legacy", value: legacyResult };
				}
				this.compareInBackground(legacyResult, sqliteResult);
				return { source: "legacy", value: legacyResult };
			}

			case "sqlite": {
				// SQLite is authoritative. Query legacy in background for comparison.
				const sqliteResult = sqliteFn();
				const legacyResult = legacyFn();
				this.compareInBackground(legacyResult, sqliteResult);
				return { source: "sqlite", value: sqliteResult, syncValue: sqliteResult };
			}
		}
	}

	getStats(): Readonly<ReadPathStats> {
		return { ...this.stats };
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private compareInBackground(
		legacyResult: T | Promise<T>,
		sqliteResult: T,
	): void {
		const readAt = Date.now();
		Promise.resolve(legacyResult)
			.then((legacy) => {
				this.stats.comparisonAttempts++;
				const comparedAt = Date.now();
				const diffs = this.config.compare(legacy, sqliteResult);
				const diverged = diffs.length > 0;

				if (diverged) {
					this.stats.comparisonFailures++;
					this.stats.lastDivergenceAt = Date.now();
					this.config.log.warn(`${this.config.label} divergence`, {
						diffs,
						diffCount: diffs.length,
						timingGapMs: comparedAt - readAt,
						mode: this.config.mode,
					});
				} else {
					this.stats.comparisonSuccesses++;
				}

				this.config.onComparison?.(diverged);
			})
			.catch((err) => {
				this.stats.comparisonAttempts++;
				this.stats.comparisonErrors++;
				this.config.log.verbose(
					`${this.config.label} comparison error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
				);
				// Comparison errors are NOT divergences — don't trip the breaker.
				// The legacy path may be unavailable (e.g., REST timeout).
			});
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/shadow-read-comparator.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/shadow-read-comparator.ts test/unit/persistence/shadow-read-comparator.test.ts
git commit -m "feat(persistence): add ShadowReadComparator — generic three-mode comparison framework for Phase 4"
```

---

### Task 3: DivergenceCircuitBreaker

**Files:**
- Create: `src/lib/persistence/divergence-circuit-breaker.ts`
- Test: `test/unit/persistence/divergence-circuit-breaker.test.ts`

**Purpose:** Tracks divergence rate over a rolling window. When divergence exceeds a configurable threshold, auto-reverts the corresponding `ReadFlag` back to `"legacy"` and logs an error. This turns comparison logging from observability into safety. Each Phase 4 sub-phase gets its own breaker instance.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/divergence-circuit-breaker.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	DivergenceCircuitBreaker,
	type CircuitBreakerConfig,
} from "../../../src/lib/persistence/divergence-circuit-breaker.js";
import type { ReadFlags, ReadFlagMode } from "../../../src/lib/persistence/read-flags.js";
import { createReadFlags } from "../../../src/lib/persistence/read-flags.js";

describe("DivergenceCircuitBreaker", () => {
	let flags: ReadFlags;
	let log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		flags = createReadFlags({ sessionList: "sqlite" });
		log = { error: vi.fn(), warn: vi.fn() };
	});

	it("does not trip when divergence is below threshold", () => {
		const breaker = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.1, // 10%
			windowSize: 10,
		});

		// 1 divergence out of 10 = 10% — at threshold, not over
		breaker.record(true); // diverged
		for (let i = 0; i < 9; i++) breaker.record(false);

		expect(flags.sessionList).toBe("sqlite");
		expect(log.error).not.toHaveBeenCalled();
	});

	it("trips when divergence exceeds threshold", () => {
		const breaker = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.1, // 10%
			windowSize: 10,
		});

		// 2 divergences out of 10 = 20% — over threshold
		breaker.record(true);
		breaker.record(true);
		for (let i = 0; i < 8; i++) breaker.record(false);

		expect(flags.sessionList).toBe("legacy");
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("Circuit breaker tripped"),
			expect.objectContaining({ flagName: "sessionList" }),
		);
	});

	it("does not evaluate until window is full", () => {
		const breaker = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.1,
			windowSize: 20,
		});

		// 5 divergences out of 5 = 100% — but window not full yet
		for (let i = 0; i < 5; i++) breaker.record(true);

		expect(flags.sessionList).toBe("sqlite"); // not tripped
	});

	it("uses rolling window — old checks fall off", () => {
		const breaker = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.1,
			windowSize: 10,
		});

		// Fill window with 5 divergences then 5 successes
		for (let i = 0; i < 5; i++) breaker.record(true);
		for (let i = 0; i < 5; i++) breaker.record(false);
		// 5/10 = 50% — trips
		expect(flags.sessionList).toBe("legacy");

		// Reset for next test
		flags.sessionList = "sqlite";

		const breaker2 = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.1,
			windowSize: 10,
		});

		// 2 divergences then 20 successes — old divergences fall off
		breaker2.record(true);
		breaker2.record(true);
		for (let i = 0; i < 20; i++) breaker2.record(false);
		expect(flags.sessionList).toBe("sqlite"); // not tripped — divergences fell out
	});

	it("trips from shadow mode back to legacy", () => {
		flags.sessionList = "shadow";
		const breaker = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.05,
			windowSize: 20,
		});

		for (let i = 0; i < 5; i++) breaker.record(true);
		for (let i = 0; i < 15; i++) breaker.record(false);
		// 5/20 = 25% — over threshold
		expect(flags.sessionList).toBe("legacy");
	});

	it("exposes stats", () => {
		const breaker = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.1,
			windowSize: 100,
		});
		breaker.record(true);
		breaker.record(false);
		breaker.record(false);

		const stats = breaker.getStats();
		expect(stats.totalChecks).toBe(3);
		expect(stats.divergences).toBe(1);
		expect(stats.tripped).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/divergence-circuit-breaker.test.ts`
Expected: FAIL with "Cannot find module '...divergence-circuit-breaker.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/divergence-circuit-breaker.ts

import type { ReadFlags, ReadFlagMode } from "./read-flags.js";

interface CircuitBreakerLog {
	error(msg: string, context?: Record<string, unknown>): void;
	warn(msg: string, context?: Record<string, unknown>): void;
}

export interface CircuitBreakerConfig {
	/** Which flag this breaker guards. */
	readonly flagName: keyof ReadFlags;
	/** Mutable reference to the flags object — breaker writes to this on trip. */
	readonly flags: ReadFlags;
	readonly log: CircuitBreakerLog;
	/** Divergence rate threshold (0.0-1.0). Default: 0.05 (5%). */
	readonly threshold?: number;
	/** Number of checks in the rolling window. Default: 100. */
	readonly windowSize?: number;
}

export interface CircuitBreakerStats {
	readonly totalChecks: number;
	readonly divergences: number;
	readonly tripped: boolean;
	readonly rate: number;
}

/**
 * Tracks divergence rate for a single read-path flag over a rolling window.
 *
 * When the divergence rate (divergences / window) exceeds the threshold,
 * the breaker trips: it sets the corresponding ReadFlag back to "legacy"
 * and logs an error.
 *
 * Each Phase 4 sub-phase gets its own breaker instance, wired into its
 * ShadowReadComparator's `onComparison` callback.
 */
export class DivergenceCircuitBreaker {
	private readonly flagName: keyof ReadFlags;
	private readonly flags: ReadFlags;
	private readonly log: CircuitBreakerLog;
	private readonly threshold: number;
	private readonly windowSize: number;

	/** Circular buffer of recent check results (true = diverged). */
	private readonly window: boolean[];
	private writePos = 0;
	private totalRecorded = 0;
	private _tripped = false;

	constructor(config: CircuitBreakerConfig) {
		this.flagName = config.flagName;
		this.flags = config.flags;
		this.log = config.log;
		this.threshold = config.threshold ?? 0.05;
		this.windowSize = config.windowSize ?? 100;
		this.window = new Array(this.windowSize).fill(false);
	}

	/**
	 * Record a comparison result. Called by ShadowReadComparator.onComparison.
	 *
	 * @param diverged — true if legacy and sqlite results differed
	 */
	record(diverged: boolean): void {
		this.window[this.writePos] = diverged;
		this.writePos = (this.writePos + 1) % this.windowSize;
		this.totalRecorded++;

		if (this._tripped) return;
		if (this.totalRecorded < this.windowSize) return;

		const divergences = this.window.filter(Boolean).length;
		const rate = divergences / this.windowSize;

		if (rate > this.threshold) {
			this._tripped = true;
			this.flags[this.flagName] = "legacy";
			this.log.error(
				`Circuit breaker tripped for ${this.flagName} — reverted to legacy`,
				{
					flagName: this.flagName,
					rate: Math.round(rate * 1000) / 10, // e.g. 5.2%
					threshold: this.threshold * 100,
					windowSize: this.windowSize,
					divergences,
				},
			);
		}
	}

	getStats(): CircuitBreakerStats {
		const filled = Math.min(this.totalRecorded, this.windowSize);
		const divergences = filled > 0
			? this.window.slice(0, filled).filter(Boolean).length
			: 0;
		return {
			totalChecks: this.totalRecorded,
			divergences,
			tripped: this._tripped,
			rate: filled > 0 ? divergences / filled : 0,
		};
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/divergence-circuit-breaker.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/divergence-circuit-breaker.ts test/unit/persistence/divergence-circuit-breaker.test.ts
git commit -m "feat(persistence): add DivergenceCircuitBreaker — auto-reverts read flags on excessive divergence"
```

---

### Task 4: Shadow-Read Wiring for 4a (Tool Content)

**Files:**
- Modify: `src/lib/handlers/tool-content.ts` (amends Task 25)
- Test: `test/unit/handlers/tool-content-shadow.test.ts`

**Purpose:** Wire `ShadowReadComparator` into the tool content handler so all three modes work: legacy (in-memory `ToolContentStore`), shadow (serve in-memory, compare with SQLite), sqlite (serve SQLite, compare with in-memory). The existing Task 25 only has binary flag-on/flag-off.

**Step 1: Write the failing test**

```typescript
// test/unit/handlers/tool-content-shadow.test.ts
import { describe, expect, it, vi } from "vitest";
import { ShadowReadComparator } from "../../../src/lib/persistence/shadow-read-comparator.js";
import type { ReadFlagMode } from "../../../src/lib/persistence/read-flags.js";

describe("Tool content shadow-read comparison", () => {
	function compareToolContent(legacy: string | undefined, sqlite: string | undefined): string[] {
		const diffs: string[] = [];
		if (legacy === undefined && sqlite === undefined) return diffs;
		if (legacy === undefined) { diffs.push("missing-in-legacy"); return diffs; }
		if (sqlite === undefined) { diffs.push("missing-in-sqlite"); return diffs; }
		if (legacy !== sqlite) diffs.push(`content-mismatch: legacy=${legacy.length}bytes sqlite=${sqlite.length}bytes`);
		return diffs;
	}

	it("shadow mode serves legacy value", async () => {
		const comparator = new ShadowReadComparator<string | undefined>({
			label: "tool-content",
			getMode: () => "shadow",
			log: { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() },
			compare: compareToolContent,
		});

		const result = comparator.read(
			() => "in-memory-content",
			() => "sqlite-content",
		);

		expect(result.source).toBe("legacy");
		expect(await result.value).toBe("in-memory-content");
	});

	it("shadow mode logs diff when content mismatches", async () => {
		const log = { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() };
		const comparator = new ShadowReadComparator<string | undefined>({
			label: "tool-content",
			getMode: () => "shadow",
			log,
			compare: compareToolContent,
		});

		comparator.read(
			() => "value-A",
			() => "value-B",
		);
		await new Promise((r) => setTimeout(r, 10));

		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("tool-content divergence"),
			expect.objectContaining({ diffs: expect.any(Array) }),
		);
	});

	it("sqlite mode serves sqlite value", () => {
		const comparator = new ShadowReadComparator<string | undefined>({
			label: "tool-content",
			getMode: () => "sqlite",
			log: { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() },
			compare: compareToolContent,
		});

		const result = comparator.read(
			() => "legacy-value",
			() => "sqlite-value",
		);
		expect(result.source).toBe("sqlite");
		expect(result.syncValue).toBe("sqlite-value");
	});

	it("no diff when both return undefined (tool not found)", async () => {
		const log = { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() };
		const comparator = new ShadowReadComparator<string | undefined>({
			label: "tool-content",
			getMode: () => "shadow",
			log,
			compare: compareToolContent,
		});

		comparator.read(
			() => undefined,
			() => undefined,
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(log.warn).not.toHaveBeenCalled();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers/tool-content-shadow.test.ts`
Expected: PASS (test exercises ShadowReadComparator directly, which exists from Task 2)

**Step 3: Write minimal implementation**

Amend the `handleGetToolContent` handler from Task 25 to use `ShadowReadComparator` instead of a simple boolean check. The handler should create or receive a comparator and call `comparator.read()`.

In `src/lib/handlers/tool-content.ts`, replace the boolean flag logic with:

```typescript
// In handleGetToolContent — replace the flag-based if/else with:

// Build the result using the shadow-read pattern
const readResult = toolContentComparator.read(
	// Legacy path: in-memory ToolContentStore
	() => deps.toolContentStore.get(toolId),
	// SQLite path: ReadQueryService
	() => deps.readQuery?.getToolContent(toolId),
);

const content = readResult.source === "sqlite"
	? readResult.syncValue
	: await readResult.value;
```

The comparator itself is constructed once per relay-stack lifecycle and passed through `HandlerDeps` (see Task 12 wiring).

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/handlers/tool-content-shadow.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/handlers/tool-content.ts test/unit/handlers/tool-content-shadow.test.ts
git commit -m "feat(read-switchover): wire ShadowReadComparator into tool content handler (4a)"
```

---

### Task 5: Shadow-Read Wiring for 4b (Fork Metadata)

**Files:**
- Modify: `src/lib/handlers/fork.ts` or wherever fork metadata is read (amends Task 26)
- Test: `test/unit/handlers/fork-metadata-shadow.test.ts`

**Purpose:** Wire `ShadowReadComparator` into fork metadata reads. Compare `fork-metadata.json` file reads with `ReadQueryService.getForkMetadata()`.

**Step 1: Write the failing test**

```typescript
// test/unit/handlers/fork-metadata-shadow.test.ts
import { describe, expect, it, vi } from "vitest";
import { ShadowReadComparator } from "../../../src/lib/persistence/shadow-read-comparator.js";

interface ForkMeta {
	parentId: string;
	forkPointEvent: string;
}

function compareForkMetadata(legacy: ForkMeta | undefined, sqlite: ForkMeta | undefined): string[] {
	const diffs: string[] = [];
	if (!legacy && !sqlite) return diffs;
	if (!legacy) { diffs.push("missing-in-legacy"); return diffs; }
	if (!sqlite) { diffs.push("missing-in-sqlite"); return diffs; }
	if (legacy.parentId !== sqlite.parentId) diffs.push(`parentId: "${legacy.parentId}" vs "${sqlite.parentId}"`);
	if (legacy.forkPointEvent !== sqlite.forkPointEvent) diffs.push(`forkPointEvent: "${legacy.forkPointEvent}" vs "${sqlite.forkPointEvent}"`);
	return diffs;
}

describe("Fork metadata shadow-read comparison", () => {
	it("detects parentId mismatch", async () => {
		const log = { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() };
		const comparator = new ShadowReadComparator<ForkMeta | undefined>({
			label: "fork-metadata",
			getMode: () => "shadow",
			log,
			compare: compareForkMetadata,
		});

		comparator.read(
			() => ({ parentId: "p1", forkPointEvent: "evt-1" }),
			() => ({ parentId: "p2", forkPointEvent: "evt-1" }),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(log.warn).toHaveBeenCalled();
	});

	it("no diff when both match", async () => {
		const log = { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() };
		const comparator = new ShadowReadComparator<ForkMeta | undefined>({
			label: "fork-metadata",
			getMode: () => "shadow",
			log,
			compare: compareForkMetadata,
		});

		comparator.read(
			() => ({ parentId: "p1", forkPointEvent: "evt-1" }),
			() => ({ parentId: "p1", forkPointEvent: "evt-1" }),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("detects SQLite missing fork data that legacy has", async () => {
		const log = { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() };
		const comparator = new ShadowReadComparator<ForkMeta | undefined>({
			label: "fork-metadata",
			getMode: () => "shadow",
			log,
			compare: compareForkMetadata,
		});

		comparator.read(
			() => ({ parentId: "p1", forkPointEvent: "evt-1" }),
			() => undefined,
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("fork-metadata divergence"),
			expect.objectContaining({ diffs: ["missing-in-sqlite"] }),
		);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers/fork-metadata-shadow.test.ts`
Expected: PASS (exercises the comparator directly)

**Step 3: Write minimal implementation**

Amend the fork metadata handler (Task 26) to use `ShadowReadComparator<ForkMeta | undefined>` instead of a boolean flag check. Same pattern as Task 4.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/handlers/fork-metadata-shadow.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add test/unit/handlers/fork-metadata-shadow.test.ts
git commit -m "feat(read-switchover): wire ShadowReadComparator into fork metadata handler (4b)"
```

---

### Task 6: Shadow-Read Wiring for 4e (Session History)

**Files:**
- Modify: `src/lib/session/session-switch.ts` (amends Tasks 31-32)
- Test: `test/unit/session/session-history-shadow.test.ts`

**Purpose:** This is the highest-risk Phase 4 sub-phase — session history is the most complex projection and the most visible to users. Add a dedicated comparison function that verifies message count, message ID ordering, and most-recent message text.

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-history-shadow.test.ts
import { describe, expect, it, vi } from "vitest";
import {
	compareSessionHistory,
} from "../../../src/lib/persistence/session-history-comparator.js";

describe("compareSessionHistory", () => {
	it("returns no diffs for identical histories", () => {
		const messages = [
			{ id: "m1", role: "user" as const, text: "hello" },
			{ id: "m2", role: "assistant" as const, text: "hi" },
		];
		const diffs = compareSessionHistory(
			{ messages, hasMore: false },
			{ messages, hasMore: false },
		);
		expect(diffs).toEqual([]);
	});

	it("detects message count mismatch", () => {
		const diffs = compareSessionHistory(
			{ messages: [{ id: "m1", role: "user", text: "a" }], hasMore: false },
			{ messages: [{ id: "m1", role: "user", text: "a" }, { id: "m2", role: "assistant", text: "b" }], hasMore: false },
		);
		expect(diffs).toContain("message-count: legacy=1 sqlite=2");
	});

	it("detects message ID ordering mismatch", () => {
		const diffs = compareSessionHistory(
			{ messages: [{ id: "m1" }, { id: "m2" }], hasMore: false },
			{ messages: [{ id: "m2" }, { id: "m1" }], hasMore: false },
		);
		expect(diffs.some((d) => d.startsWith("message-order"))).toBe(true);
	});

	it("detects missing message IDs", () => {
		const diffs = compareSessionHistory(
			{ messages: [{ id: "m1" }, { id: "m2" }], hasMore: false },
			{ messages: [{ id: "m1" }, { id: "m3" }], hasMore: false },
		);
		expect(diffs.some((d) => d.includes("missing-in-sqlite"))).toBe(true);
		expect(diffs.some((d) => d.includes("missing-in-legacy"))).toBe(true);
	});

	it("detects latest message text mismatch", () => {
		const diffs = compareSessionHistory(
			{ messages: [{ id: "m1", text: "hello" }], hasMore: false },
			{ messages: [{ id: "m1", text: "goodbye" }], hasMore: false },
		);
		expect(diffs.some((d) => d.startsWith("latest-text-mismatch"))).toBe(true);
	});

	it("detects hasMore flag mismatch", () => {
		const diffs = compareSessionHistory(
			{ messages: [{ id: "m1" }], hasMore: true },
			{ messages: [{ id: "m1" }], hasMore: false },
		);
		expect(diffs).toContain("hasMore: legacy=true sqlite=false");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-history-shadow.test.ts`
Expected: FAIL with "Cannot find module '...session-history-comparator.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/session-history-comparator.ts

interface HistoryMessage {
	id: string;
	role?: string;
	text?: string;
	[key: string]: unknown;
}

interface HistoryShape {
	messages: HistoryMessage[];
	hasMore: boolean;
}

/**
 * Compare legacy and SQLite session history results.
 *
 * Checks:
 * 1. Message count match
 * 2. Message ID set equality (detect missing messages)
 * 3. Message ID ordering consistency
 * 4. Latest message text match (truncated comparison)
 * 5. hasMore pagination flag match
 *
 * Returns empty array if histories match, or human-readable diff descriptions.
 */
export function compareSessionHistory(
	legacy: HistoryShape,
	sqlite: HistoryShape,
): string[] {
	const diffs: string[] = [];

	// 1. Message count
	if (legacy.messages.length !== sqlite.messages.length) {
		diffs.push(`message-count: legacy=${legacy.messages.length} sqlite=${sqlite.messages.length}`);
	}

	// 2. Message ID set equality
	const legacyIds = new Set(legacy.messages.map((m) => m.id));
	const sqliteIds = new Set(sqlite.messages.map((m) => m.id));

	const missingInSqlite = [...legacyIds].filter((id) => !sqliteIds.has(id));
	const missingInLegacy = [...sqliteIds].filter((id) => !legacyIds.has(id));

	if (missingInSqlite.length > 0) {
		diffs.push(`missing-in-sqlite: [${missingInSqlite.slice(0, 5).join(", ")}]${missingInSqlite.length > 5 ? `... +${missingInSqlite.length - 5}` : ""}`);
	}
	if (missingInLegacy.length > 0) {
		diffs.push(`missing-in-legacy: [${missingInLegacy.slice(0, 5).join(", ")}]${missingInLegacy.length > 5 ? `... +${missingInLegacy.length - 5}` : ""}`);
	}

	// 3. Message ordering (only compare IDs that exist in both)
	const commonIds = [...legacyIds].filter((id) => sqliteIds.has(id));
	if (commonIds.length >= 2) {
		const legacyOrder = legacy.messages.filter((m) => sqliteIds.has(m.id)).map((m) => m.id);
		const sqliteOrder = sqlite.messages.filter((m) => legacyIds.has(m.id)).map((m) => m.id);
		if (JSON.stringify(legacyOrder) !== JSON.stringify(sqliteOrder)) {
			diffs.push(`message-order mismatch for ${commonIds.length} shared messages`);
		}
	}

	// 4. Role distribution check (I2 — catches systematic role misassignment)
	const legacyRoles = legacy.messages.reduce((acc, m) => {
		acc[m.role ?? "unknown"] = (acc[m.role ?? "unknown"] ?? 0) + 1;
		return acc;
	}, {} as Record<string, number>);
	const sqliteRoles = sqlite.messages.reduce((acc, m) => {
		acc[m.role ?? "unknown"] = (acc[m.role ?? "unknown"] ?? 0) + 1;
		return acc;
	}, {} as Record<string, number>);
	for (const role of new Set([...Object.keys(legacyRoles), ...Object.keys(sqliteRoles)])) {
		if ((legacyRoles[role] ?? 0) !== (sqliteRoles[role] ?? 0)) {
			diffs.push(`role-count-${role}: legacy=${legacyRoles[role] ?? 0} sqlite=${sqliteRoles[role] ?? 0}`);
		}
	}

	// 5. Latest message text comparison
	const legacyLast = legacy.messages[legacy.messages.length - 1];
	const sqliteLast = sqlite.messages[sqlite.messages.length - 1];
	if (legacyLast && sqliteLast && legacyLast.id === sqliteLast.id) {
		const legacyText = (legacyLast.text ?? "").slice(0, 200);
		const sqliteText = (sqliteLast.text ?? "").slice(0, 200);
		if (legacyText !== sqliteText) {
			diffs.push(`latest-text-mismatch: legacy="${legacyText.slice(0, 50)}..." sqlite="${sqliteText.slice(0, 50)}..."`);
		}
	}

	// 6. hasMore flag
	if (legacy.hasMore !== sqlite.hasMore) {
		diffs.push(`hasMore: legacy=${legacy.hasMore} sqlite=${sqlite.hasMore}`);
	}

	return diffs;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-history-shadow.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/session-history-comparator.ts test/unit/session/session-history-shadow.test.ts
git commit -m "feat(persistence): add session history comparator for Phase 4e shadow-read validation"
```

---

### Task 7: Shadow-Read Wiring for 4f (Pending Approvals)

**Files:**
- Modify: `src/lib/persistence/approval-adapter.ts` (amends Tasks 33-34)
- Test: `test/unit/persistence/pending-approvals-shadow.test.ts`

**Purpose:** Add comparison function for pending approvals. Verifies pending set equality (IDs and status) between the in-memory `PermissionBridge` and the `pending_approvals` projection table.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/pending-approvals-shadow.test.ts
import { describe, expect, it } from "vitest";
import {
	comparePendingApprovals,
} from "../../../src/lib/persistence/pending-approvals-comparator.js";

interface PendingApproval {
	id: string;
	type: "permission" | "question";
	status: "pending" | "resolved";
	toolName?: string;
}

describe("comparePendingApprovals", () => {
	it("returns no diffs for identical sets", () => {
		const approvals: PendingApproval[] = [
			{ id: "p1", type: "permission", status: "pending", toolName: "bash" },
		];
		expect(comparePendingApprovals(approvals, approvals)).toEqual([]);
	});

	it("detects missing pending approval in SQLite", () => {
		const legacy: PendingApproval[] = [
			{ id: "p1", type: "permission", status: "pending" },
			{ id: "p2", type: "question", status: "pending" },
		];
		const sqlite: PendingApproval[] = [
			{ id: "p1", type: "permission", status: "pending" },
		];
		const diffs = comparePendingApprovals(legacy, sqlite);
		expect(diffs).toContain("missing-in-sqlite: p2");
	});

	it("detects status mismatch", () => {
		const legacy: PendingApproval[] = [
			{ id: "p1", type: "permission", status: "pending" },
		];
		const sqlite: PendingApproval[] = [
			{ id: "p1", type: "permission", status: "resolved" },
		];
		const diffs = comparePendingApprovals(legacy, sqlite);
		expect(diffs.some((d) => d.includes("status-mismatch"))).toBe(true);
	});

	it("detects count mismatch", () => {
		const diffs = comparePendingApprovals(
			[{ id: "p1", type: "permission", status: "pending" }],
			[
				{ id: "p1", type: "permission", status: "pending" },
				{ id: "p2", type: "question", status: "pending" },
			],
		);
		expect(diffs.some((d) => d.startsWith("count"))).toBe(true);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/pending-approvals-shadow.test.ts`
Expected: FAIL with "Cannot find module '...pending-approvals-comparator.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/pending-approvals-comparator.ts

interface PendingApproval {
	id: string;
	type: "permission" | "question";
	status: "pending" | "resolved";
	toolName?: string;
}

/**
 * Compare in-memory and SQLite pending approval sets.
 * Returns empty array if they match.
 */
export function comparePendingApprovals(
	legacy: PendingApproval[],
	sqlite: PendingApproval[],
): string[] {
	const diffs: string[] = [];

	if (legacy.length !== sqlite.length) {
		diffs.push(`count: legacy=${legacy.length} sqlite=${sqlite.length}`);
	}

	const legacyMap = new Map(legacy.map((a) => [a.id, a]));
	const sqliteMap = new Map(sqlite.map((a) => [a.id, a]));

	for (const [id, legacyApproval] of legacyMap) {
		const sqliteApproval = sqliteMap.get(id);
		if (!sqliteApproval) {
			diffs.push(`missing-in-sqlite: ${id}`);
			continue;
		}
		if (legacyApproval.status !== sqliteApproval.status) {
			diffs.push(`status-mismatch: ${id} legacy=${legacyApproval.status} sqlite=${sqliteApproval.status}`);
		}
		if (legacyApproval.type !== sqliteApproval.type) {
			diffs.push(`type-mismatch: ${id} legacy=${legacyApproval.type} sqlite=${sqliteApproval.type}`);
		}
		// (I3) Also compare toolName
		if (legacyApproval.toolName !== sqliteApproval.toolName) {
			diffs.push(`toolName-mismatch: ${id} legacy="${legacyApproval.toolName}" sqlite="${sqliteApproval.toolName}"`);
		}
	}

	for (const id of sqliteMap.keys()) {
		if (!legacyMap.has(id)) {
			diffs.push(`missing-in-legacy: ${id}`);
		}
	}

	return diffs;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/pending-approvals-shadow.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/pending-approvals-comparator.ts test/unit/persistence/pending-approvals-shadow.test.ts
git commit -m "feat(persistence): add pending approvals comparator for Phase 4f shadow-read validation"
```

---

### Task 8: Retrofit 4c (Session List) and 4d (Session Status) to ShadowReadComparator

**Files:**
- Modify: `src/lib/session/session-manager.ts` (amends Task 28)
- Modify: `src/lib/session/session-status-poller.ts` (amends Task 30)
- Test: `test/unit/session/session-list-shadow-retrofit.test.ts`

**Purpose:** Replace the ad-hoc `compareWithLegacyListInBackground` in Task 28 and the ad-hoc status comparison in Task 30 with `ShadowReadComparator` instances. This unifies all 6 sub-phases under the same framework, giving them identical stats/breaker/diagnostics interfaces.

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-list-shadow-retrofit.test.ts
import { describe, expect, it, vi } from "vitest";
import {
	compareSessionLists,
} from "../../../src/lib/persistence/session-list-adapter.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";

describe("compareSessionLists (used by ShadowReadComparator)", () => {
	it("returns diffs array compatible with ShadowReadComparator.compare", () => {
		const rest: SessionInfo[] = [
			{ id: "s1", title: "REST Title" },
			{ id: "s2", title: "Both" },
		];
		const sqlite: SessionInfo[] = [
			{ id: "s1", title: "SQLite Title" },
			{ id: "s2", title: "Both" },
			{ id: "s3", title: "Extra" },
		];

		// Wrap compareSessionLists to return string[] for ShadowReadComparator
		const diff = compareSessionLists(rest, sqlite);
		const diffs: string[] = [];
		if (diff.missingInSqlite.length > 0) diffs.push(`missing-in-sqlite: ${diff.missingInSqlite.join(", ")}`);
		if (diff.missingInRest.length > 0) diffs.push(`missing-in-rest: ${diff.missingInRest.join(", ")}`);
		for (const m of diff.titleMismatches) diffs.push(`title-mismatch: ${m.id}`);

		expect(diffs).toContain("missing-in-rest: s3");
		expect(diffs.some((d) => d.includes("title-mismatch: s1"))).toBe(true);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-list-shadow-retrofit.test.ts`
Expected: PASS (exercises existing `compareSessionLists`)

**Step 3: Write minimal implementation**

In `session-manager.ts`, replace the `compareWithLegacyListInBackground` method and the boolean flag check with a `ShadowReadComparator<SessionInfo[]>` instance. The comparator's `compare` function wraps `compareSessionLists` to return `string[]`.

In `session-status-poller.ts`, replace the boolean flag check with a `ShadowReadComparator<Record<string, SessionStatus>>` instance whose `compare` function checks for status mismatches per session ID.

Both comparators receive the circuit breaker's `record` callback via the `onComparison` config field.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/`
Expected: All session tests pass.

**Step 5: Refactor if needed**

Delete the `compareWithLegacyListInBackground` method from `session-manager.ts` — it's now handled by the comparator.

**Step 6: Commit**

```bash
git add src/lib/session/session-manager.ts src/lib/session/session-status-poller.ts test/unit/session/session-list-shadow-retrofit.test.ts
git commit -m "refactor(read-switchover): retrofit 4c/4d to use ShadowReadComparator — unified comparison framework"
```

---

### Task 9: Event Store Integrity Checks

**Files:**
- Modify: `src/lib/persistence/diagnostics.ts` (amends Task 22.5)
- Test: `test/unit/persistence/diagnostics-integrity.test.ts`

**Purpose:** Add `checkIntegrity()` to `PersistenceDiagnostics` that verifies event store structural health: sequence gaps, orphaned events (session FK), unparsable payloads, and cursor regressions. Runnable on startup (after recovery), periodically, or via diagnostic command.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/diagnostics-integrity.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { PersistenceDiagnostics, type IntegrityReport } from "../../../src/lib/persistence/diagnostics.js";

describe("PersistenceDiagnostics.checkIntegrity", () => {
	let db: SqliteClient;
	let diag: PersistenceDiagnostics;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		diag = new PersistenceDiagnostics(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns clean report for empty database", () => {
		const report = diag.checkIntegrity();
		expect(report.eventCount).toBe(0);
		expect(report.maxSequence).toBe(0);
		expect(report.sequenceConsistent).toBe(true);
		expect(report.orphanedEvents).toBe(0);
		expect(report.unparsablePayloads).toBe(0);
		expect(report.cursorRegressions).toEqual([]);
		expect(report.projectorLagMax).toBe(0);
	});

	it("detects orphaned events (missing session FK)", () => {
		// Insert session for valid event
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "T", "idle", Date.now(), Date.now()],
		);
		db.execute(
			`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["e1", "s1", 0, "session.created", "{}", "opencode", Date.now()],
		);

		// Disable FK checks to insert orphan
		db.execute("PRAGMA foreign_keys = OFF");
		db.execute(
			`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["e2", "orphan-session", 0, "text.delta", "{}", "opencode", Date.now()],
		);
		db.execute("PRAGMA foreign_keys = ON");

		const report = diag.checkIntegrity();
		expect(report.orphanedEvents).toBe(1);
	});

	it("detects unparsable JSON payloads", () => {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "T", "idle", Date.now(), Date.now()],
		);
		db.execute(
			`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["e1", "s1", 0, "session.created", "NOT-JSON", "opencode", Date.now()],
		);

		const report = diag.checkIntegrity();
		expect(report.unparsablePayloads).toBe(1);
	});

	it("detects projector lag", () => {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "T", "idle", Date.now(), Date.now()],
		);
		// Insert 3 events
		for (let i = 0; i < 3; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[`e${i}`, "s1", i, "text.delta", '{"messageId":"m1","partId":"p1","text":"x"}', "opencode", Date.now()],
			);
		}
		// Cursor at 1 (2 events behind)
		db.execute(
			"INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at) VALUES (?, ?, ?)",
			["message", 1, Date.now()],
		);

		const report = diag.checkIntegrity();
		expect(report.projectorLagMax).toBe(2);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/diagnostics-integrity.test.ts`
Expected: FAIL — `checkIntegrity` does not exist yet.

**Step 3: Write minimal implementation**

Add to `src/lib/persistence/diagnostics.ts`:

```typescript
export interface IntegrityReport {
	/**
	 * (I6) Total event count vs max sequence. If they differ, rows were deleted
	 * from the append-only store — a serious invariant violation. Replaces the
	 * v1 sequence-gap detection which was unnecessary (AUTOINCREMENT can't
	 * produce gaps without DELETE).
	 */
	readonly eventCount: number;
	readonly maxSequence: number;
	readonly sequenceConsistent: boolean;
	/** Events referencing sessions not in the sessions table. */
	readonly orphanedEvents: number;
	/** Events with data that fails JSON.parse(). */
	readonly unparsablePayloads: number;
	/** Projectors whose cursor is behind the max event sequence. */
	readonly cursorRegressions: Array<{ name: string; cursor: number; maxSeq: number; lag: number }>;
	/** Maximum lag across all projectors. */
	readonly projectorLagMax: number;
}

// In PersistenceDiagnostics class:

/**
 * Comprehensive integrity check of the event store and projections.
 *
 * Suitable for running:
 * - On startup (after ProjectionRunner.recover())
 * - Periodically (every 60s in development)
 * - Via diagnostic endpoint or CLI command
 */
checkIntegrity(): IntegrityReport {
	// 1. (I6) Sequence consistency check — count vs max.
	// AUTOINCREMENT sequences can't have gaps without DELETE. If count != max,
	// rows were deleted from the append-only store, which is an invariant violation.
	const eventCount = this.db.queryOne<{ c: number }>(
		"SELECT COUNT(*) AS c FROM events",
	)?.c ?? 0;
	const maxSequence = this.db.queryOne<{ m: number }>(
		"SELECT MAX(sequence) AS m FROM events",
	)?.m ?? 0;
	const sequenceConsistent = eventCount === 0 || eventCount === maxSequence;

	// 2. Orphaned events
	const orphaned = this.db.queryOne<{ c: number }>(
		`SELECT COUNT(*) AS c FROM events e
		 WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id)`,
	)?.c ?? 0;

	// 3. Unparsable payloads (sample up to 100 recent events)
	const recentEvents = this.db.query<{ data: string }>(
		"SELECT data FROM events ORDER BY sequence DESC LIMIT 100",
	);
	let unparsable = 0;
	for (const row of recentEvents) {
		try { JSON.parse(row.data); } catch { unparsable++; }
	}

	// 4. Projector cursor lag
	const maxSeq = this.db.queryOne<{ m: number }>(
		"SELECT MAX(sequence) AS m FROM events",
	)?.m ?? 0;
	const cursors = this.db.query<{ name: string; seq: number }>(
		"SELECT projector_name AS name, last_applied_seq AS seq FROM projector_cursors",
	);
	const regressions = cursors
		.filter((c) => c.seq < maxSeq)
		.map((c) => ({ name: c.name, cursor: c.seq, maxSeq, lag: maxSeq - c.seq }));

	return {
		eventCount,
		maxSequence,
		sequenceConsistent,
		orphanedEvents: orphaned,
		unparsablePayloads: unparsable,
		cursorRegressions: regressions,
		projectorLagMax: regressions.length > 0
			? Math.max(...regressions.map((r) => r.lag))
			: 0,
	};
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/diagnostics-integrity.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/diagnostics.ts test/unit/persistence/diagnostics-integrity.test.ts
git commit -m "feat(persistence): add checkIntegrity() to PersistenceDiagnostics — sequence gaps, orphans, payload validation"
```

---

### Task 10: DualWriteAuditor — Spot-Check Canonical Events vs Relay State

**Files:**
- Create: `src/lib/persistence/dual-write-auditor.ts`
- Test: `test/unit/persistence/dual-write-auditor.test.ts`

**Purpose:** During the dual-write phase (Phases 2-3), periodically spot-check that the canonical event translator is producing correct data by comparing a sample of projected values against the relay's in-memory state. Catches translator bugs that would be invisible to count-based `DualWriteStats`.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/dual-write-auditor.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DualWriteAuditor, type AuditResult } from "../../../src/lib/persistence/dual-write-auditor.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";

describe("DualWriteAuditor", () => {
	let db: SqliteClient;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
	});

	afterEach(() => {
		db.close();
	});

	it("returns clean result when data matches", () => {
		// Seed SQLite
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "My Session", "idle", 1000, 2000],
		);

		const auditor = new DualWriteAuditor(db);
		const result = auditor.audit({
			sessionTitles: new Map([["s1", "My Session"]]),
			sessionStatuses: new Map([["s1", "idle"]]),
			messageCounts: new Map([["s1", 0]]),
		});

		expect(result.mismatches).toEqual([]);
		expect(result.sampledSessions).toBe(1);
	});

	it("detects title mismatch", () => {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "SQLite Title", "idle", 1000, 2000],
		);

		const auditor = new DualWriteAuditor(db);
		const result = auditor.audit({
			sessionTitles: new Map([["s1", "Relay Title"]]),
			sessionStatuses: new Map(),
			messageCounts: new Map(),
		});

		expect(result.mismatches).toHaveLength(1);
		expect(result.mismatches[0]).toEqual({
			sessionId: "s1",
			field: "title",
			relayValue: "Relay Title",
			sqliteValue: "SQLite Title",
		});
	});

	it("detects status mismatch", () => {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "T", "busy", 1000, 2000],
		);

		const auditor = new DualWriteAuditor(db);
		const result = auditor.audit({
			sessionTitles: new Map(),
			sessionStatuses: new Map([["s1", "idle"]]),
			messageCounts: new Map(),
		});

		expect(result.mismatches).toHaveLength(1);
		expect(result.mismatches[0].field).toBe("status");
	});

	it("detects message count mismatch", () => {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "T", "idle", 1000, 2000],
		);
		db.execute(
			"INSERT INTO messages (id, session_id, role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["m1", "s1", "user", "hi", 1000, 1000],
		);

		const auditor = new DualWriteAuditor(db);
		const result = auditor.audit({
			sessionTitles: new Map(),
			sessionStatuses: new Map(),
			messageCounts: new Map([["s1", 5]]),
		});

		expect(result.mismatches).toHaveLength(1);
		expect(result.mismatches[0].field).toBe("messageCount");
		expect(result.mismatches[0].relayValue).toBe(5);
		expect(result.mismatches[0].sqliteValue).toBe(1);
	});

	it("handles sessions missing from SQLite", () => {
		const auditor = new DualWriteAuditor(db);
		const result = auditor.audit({
			sessionTitles: new Map([["missing-s1", "Title"]]),
			sessionStatuses: new Map(),
			messageCounts: new Map(),
		});

		expect(result.mismatches).toHaveLength(1);
		expect(result.mismatches[0].field).toBe("session-missing");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/dual-write-auditor.test.ts`
Expected: FAIL with "Cannot find module '...dual-write-auditor.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/dual-write-auditor.ts
import type { SqliteClient } from "./sqlite-client.js";

export interface AuditMismatch {
	readonly sessionId: string;
	readonly field: string;
	readonly relayValue: unknown;
	readonly sqliteValue: unknown;
}

export interface AuditResult {
	readonly sampledSessions: number;
	readonly checkedFields: number;
	readonly mismatches: AuditMismatch[];
}

export interface RelaySnapshot {
	/** sessionId → title from relay's in-memory state */
	readonly sessionTitles: ReadonlyMap<string, string>;
	/** sessionId → status from relay's poller */
	readonly sessionStatuses: ReadonlyMap<string, string>;
	/** sessionId → message count from relay's message cache */
	readonly messageCounts: ReadonlyMap<string, number>;
}

/**
 * Spot-checks canonical event correctness by comparing SQLite projection
 * state against the relay's in-memory state.
 *
 * Designed to run periodically (e.g., every 60 seconds) during the
 * dual-write phase to catch translator bugs that produce wrong event
 * payloads. DualWriteStats tracks counts; this tracks correctness.
 */
export class DualWriteAuditor {
	constructor(private readonly db: SqliteClient) {}

	/**
	 * Compare relay in-memory state against SQLite projections.
	 *
	 * @param snapshot — current relay state, collected by the caller
	 */
	audit(snapshot: RelaySnapshot): AuditResult {
		const mismatches: AuditMismatch[] = [];
		let checkedFields = 0;

		// Collect all session IDs mentioned in any snapshot map
		const sessionIds = new Set([
			...snapshot.sessionTitles.keys(),
			...snapshot.sessionStatuses.keys(),
			...snapshot.messageCounts.keys(),
		]);

		for (const sid of sessionIds) {
			const row = this.db.queryOne<{ title: string; status: string }>(
				"SELECT title, status FROM sessions WHERE id = ?",
				[sid],
			);

			if (!row) {
				mismatches.push({
					sessionId: sid,
					field: "session-missing",
					relayValue: "exists",
					sqliteValue: "not-found",
				});
				continue;
			}

			// Title check
			const relayTitle = snapshot.sessionTitles.get(sid);
			if (relayTitle !== undefined) {
				checkedFields++;
				if (relayTitle !== row.title) {
					mismatches.push({
						sessionId: sid,
						field: "title",
						relayValue: relayTitle,
						sqliteValue: row.title,
					});
				}
			}

			// Status check
			const relayStatus = snapshot.sessionStatuses.get(sid);
			if (relayStatus !== undefined) {
				checkedFields++;
				if (relayStatus !== row.status) {
					mismatches.push({
						sessionId: sid,
						field: "status",
						relayValue: relayStatus,
						sqliteValue: row.status,
					});
				}
			}

			// Message count check
			const relayCount = snapshot.messageCounts.get(sid);
			if (relayCount !== undefined) {
				checkedFields++;
				const sqliteCount = this.db.queryOne<{ c: number }>(
					"SELECT COUNT(*) AS c FROM messages WHERE session_id = ?",
					[sid],
				)?.c ?? 0;
				if (relayCount !== sqliteCount) {
					mismatches.push({
						sessionId: sid,
						field: "messageCount",
						relayValue: relayCount,
						sqliteValue: sqliteCount,
					});
				}
			}
		}

		return {
			sampledSessions: sessionIds.size,
			checkedFields,
			mismatches,
		};
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/dual-write-auditor.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/dual-write-auditor.ts test/unit/persistence/dual-write-auditor.test.ts
git commit -m "feat(persistence): add DualWriteAuditor — spot-checks canonical event correctness vs relay state"
```

---

### Task 11: Rollback Procedure Documentation

**Files:**
- Modify: `docs/plans/2026-04-05-orchestrator-implementation-plan.md`

**Purpose:** Add a "Rollback Procedure" section to the Phase 4 intro (after line 11218) documenting the exact steps to revert each sub-phase, what happens to data on rollback, and how to rebuild projections from scratch.

**Step 1: Write the content**

Insert after the Phase 4 sub-phase table (line 11218):

```markdown
### Rollback Procedure (per sub-phase)

Each sub-phase can be independently reverted. The dual-write hook continues
writing to SQLite regardless of which read path is active — reads are the
only thing that changes.

**Instant revert (no restart):**

1. Set the flag to `"legacy"` at runtime (URL flag, settings toggle, or
   config change). Reads immediately serve from the legacy source.
2. The DivergenceCircuitBreaker may have already done this automatically
   if divergence exceeded the threshold.

**What happens to SQLite data on rollback:**

- The event store still has every event. Projections continue to be
  maintained by the dual-write hook (writes are always on).
- No data loss or corruption from reverting reads.
- SQLite and legacy run side-by-side indefinitely until confidence is
  re-established.

**If projections are suspect (rebuild from event store):**

```bash
# In application code or via diagnostic endpoint:
DELETE FROM projector_cursors;
DELETE FROM sessions;
DELETE FROM messages;
DELETE FROM message_parts;
DELETE FROM turns;
DELETE FROM session_providers;
DELETE FROM pending_approvals;
DELETE FROM activities;
DELETE FROM tool_content;
# Then restart the daemon — ProjectionRunner.recover() replays all events.
```

**If the event store itself is suspect:**

- Delete the SQLite database file and restart.
- The dual-write hook rebuilds from the next SSE event forward.
- Historical data requires re-seeding from OpenCode REST (not automated —
  known limitation, tracked for Phase 7 follow-up).

**Rollback progression path:**

```
sqlite → shadow → legacy     (if divergence detected)
legacy → shadow → sqlite     (normal promotion)
```

The `shadow` state is the safe middle ground — it serves legacy data while
validating SQLite in the background. Promote to `sqlite` only after the
ShadowReadComparator shows zero divergence over a sustained period (check
ReadPathStats via PersistenceDiagnostics).
```

**Step 2: No test needed** — documentation only.

**Step 3: Apply the edit** to the plan file.

**Step 4: Verify no broken links** — read through the section.

**Step 5: No refactoring needed.**

**Step 6: Commit**

```bash
git add docs/plans/2026-04-05-orchestrator-implementation-plan.md
git commit -m "docs: add Phase 4 rollback procedure with projection rebuild and promotion path"
```

---

### Task 12: Wire Circuit Breaker + Diagnostics into Relay Stack

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` (amends Task 24.5)
- Modify: `src/lib/persistence/persistence-layer.ts` (amends Task 8)
- Modify: `src/lib/persistence/diagnostics.ts` (amends Task 22.5)
- Test: `test/unit/persistence/relay-stack-consistency-wiring.test.ts`

**Purpose:** Wire everything together in the relay stack:
1. Create one `DivergenceCircuitBreaker` per flag
2. Create one `ShadowReadComparator` per sub-phase, wired to its breaker
3. Expose all `ReadPathStats` and breaker stats through `PersistenceDiagnostics`
4. Optionally run `DualWriteAuditor` on a 60-second interval during dual-write phase

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/relay-stack-consistency-wiring.test.ts
import { describe, expect, it, vi } from "vitest";
import { PersistenceDiagnostics } from "../../../src/lib/persistence/diagnostics.js";
import { ShadowReadComparator, type ReadPathStats } from "../../../src/lib/persistence/shadow-read-comparator.js";
import { DivergenceCircuitBreaker } from "../../../src/lib/persistence/divergence-circuit-breaker.js";
import { createReadFlags } from "../../../src/lib/persistence/read-flags.js";

describe("Consistency wiring integration", () => {
	it("circuit breaker auto-reverts flag when wired to comparator", async () => {
		const flags = createReadFlags({ sessionList: "sqlite" });
		const log = { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };

		const breaker = new DivergenceCircuitBreaker({
			flagName: "sessionList",
			flags,
			log,
			threshold: 0.1,
			windowSize: 10,
		});

		const comparator = new ShadowReadComparator<string>({
			label: "session-list",
			getMode: () => flags.sessionList,  // (C2) Dynamic — reads live flag
			log,
			compare: (a, b) => (a !== b ? ["diff"] : []),
			onComparison: (diverged) => breaker.record(diverged),
		});

		// Simulate 3 diverging reads out of 10 = 30% > 10% threshold
		for (let i = 0; i < 3; i++) {
			comparator.read(() => "legacy", () => "sqlite");
		}
		for (let i = 0; i < 7; i++) {
			comparator.read(() => "same", () => "same");
		}

		// Wait for all background comparisons
		await new Promise((r) => setTimeout(r, 50));

		expect(flags.sessionList).toBe("legacy"); // breaker tripped
		expect(breaker.getStats().tripped).toBe(true);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("Circuit breaker tripped"),
			expect.anything(),
		);
	});

	it("diagnostics exposes read path stats from all comparators", () => {
		const comparator = new ShadowReadComparator<string>({
			label: "tool-content",
			getMode: () => "shadow",
			log: { warn: vi.fn(), verbose: vi.fn(), info: vi.fn(), debug: vi.fn() },
			compare: () => [],
		});

		comparator.read(() => "a", () => "a");

		const stats = comparator.getStats();
		expect(stats.totalReads).toBe(1);
		expect(stats.comparisonSuccesses).toBeGreaterThanOrEqual(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/relay-stack-consistency-wiring.test.ts`
Expected: PASS (exercises existing classes)

**Step 3: Write minimal implementation**

In `src/lib/persistence/persistence-layer.ts`, add fields for the auditor and diagnostics:

```typescript
// In PersistenceLayer constructor, after existing initialization:
this.diagnostics = new PersistenceDiagnostics(db);
this.auditor = new DualWriteAuditor(db);
```

In `src/lib/persistence/diagnostics.ts`, add a `readPathHealth()` method that aggregates stats from registered comparators:

```typescript
private readonly comparators = new Map<string, ShadowReadComparator<unknown>>();
private readonly breakers = new Map<string, DivergenceCircuitBreaker>();

registerComparator(label: string, comparator: ShadowReadComparator<unknown>): void {
	this.comparators.set(label, comparator);
}

registerBreaker(flagName: string, breaker: DivergenceCircuitBreaker): void {
	this.breakers.set(flagName, breaker);
}

readPathHealth(): Record<string, { stats: ReadPathStats; breaker?: CircuitBreakerStats }> {
	const result: Record<string, any> = {};
	for (const [label, comparator] of this.comparators) {
		result[label] = {
			stats: comparator.getStats(),
			breaker: this.breakers.get(label)?.getStats(),
		};
	}
	return result;
}
```

In `src/lib/relay/relay-stack.ts`, in the Phase 4 wiring section (Task 24.5 amendment), create breakers and comparators.

**(C3) CRITICAL: This is where comparators are constructed and wired into handler deps. Without this, all shadow-read comparators from Tasks 4-8 are dead code.**

```typescript
// After creating readFlags and readQuery:
import { DivergenceCircuitBreaker } from "../persistence/divergence-circuit-breaker.js";
import { ShadowReadComparator } from "../persistence/shadow-read-comparator.js";
import { isActive } from "../persistence/read-flags.js";
import { compareSessionLists } from "../persistence/session-list-adapter.js";
import { compareSessionHistory } from "../persistence/session-history-comparator.js";
import { comparePendingApprovals } from "../persistence/pending-approvals-comparator.js";

// ── Circuit Breakers (one per flag) ──────────────────────────────────────
const FLAG_NAMES: Array<keyof ReadFlags> = [
	"toolContent", "forkMetadata", "sessionList",
	"sessionStatus", "sessionHistory", "pendingApprovals",
];

const breakers = Object.fromEntries(
	FLAG_NAMES.map((name) => [
		name,
		new DivergenceCircuitBreaker({
			flagName: name,
			flags: readFlags,
			log: log.child("circuit-breaker"),
			threshold: 0.05,
			windowSize: 100,
		}),
	]),
) as Record<keyof ReadFlags, DivergenceCircuitBreaker>;

// ── Shadow-Read Comparators (one per sub-phase) ─────────────────────────
// Each comparator reads its mode dynamically from readFlags (C2) and
// feeds its breaker via onComparison (C3).

const comparators = {
	toolContent: new ShadowReadComparator<string | undefined>({
		label: "tool-content",
		getMode: () => readFlags.toolContent,
		log: log.child("shadow-read"),
		compare: (legacy, sqlite) => {
			if (legacy === undefined && sqlite === undefined) return [];
			if (legacy === undefined) return ["missing-in-legacy"];
			if (sqlite === undefined) return ["missing-in-sqlite"];
			if (legacy !== sqlite) return [`content-mismatch: ${legacy.length}b vs ${sqlite.length}b`];
			return [];
		},
		onComparison: (d) => breakers.toolContent.record(d),
	}),

	forkMetadata: new ShadowReadComparator<{ parentId: string; forkPointEvent: string } | undefined>({
		label: "fork-metadata",
		getMode: () => readFlags.forkMetadata,
		log: log.child("shadow-read"),
		compare: (legacy, sqlite) => {
			if (!legacy && !sqlite) return [];
			if (!legacy) return ["missing-in-legacy"];
			if (!sqlite) return ["missing-in-sqlite"];
			const diffs: string[] = [];
			if (legacy.parentId !== sqlite.parentId) diffs.push(`parentId mismatch`);
			if (legacy.forkPointEvent !== sqlite.forkPointEvent) diffs.push(`forkPointEvent mismatch`);
			return diffs;
		},
		onComparison: (d) => breakers.forkMetadata.record(d),
	}),

	sessionList: new ShadowReadComparator<import("../shared-types.js").SessionInfo[]>({
		label: "session-list",
		getMode: () => readFlags.sessionList,
		log: log.child("shadow-read"),
		compare: (legacy, sqlite) => {
			const diff = compareSessionLists(legacy, sqlite);
			const diffs: string[] = [];
			if (diff.missingInSqlite.length > 0) diffs.push(`missing-in-sqlite: ${diff.missingInSqlite.length}`);
			if (diff.missingInRest.length > 0) diffs.push(`missing-in-rest: ${diff.missingInRest.length}`);
			if (diff.titleMismatches.length > 0) diffs.push(`title-mismatches: ${diff.titleMismatches.length}`);
			return diffs;
		},
		onComparison: (d) => breakers.sessionList.record(d),
	}),

	sessionHistory: new ShadowReadComparator<{ messages: unknown[]; hasMore: boolean }>({
		label: "session-history",
		getMode: () => readFlags.sessionHistory,
		log: log.child("shadow-read"),
		compare: compareSessionHistory,
		onComparison: (d) => breakers.sessionHistory.record(d),
	}),

	// sessionStatus and pendingApprovals follow the same pattern
};

// ── Wire into HandlerDeps ────────────────────────────────────────────────
// (C3) Each handler receives its comparator through HandlerDeps.
// Add to HandlerDeps interface (in src/lib/handlers/types.ts):
//   comparators?: {
//     toolContent?: ShadowReadComparator<string | undefined>;
//     forkMetadata?: ShadowReadComparator<...>;
//     sessionList?: ShadowReadComparator<SessionInfo[]>;
//     sessionHistory?: ShadowReadComparator<...>;
//     pendingApprovals?: ShadowReadComparator<...>;
//   };
//
// Then in handler deps construction:
const handlerDeps = {
	// ... existing fields ...
	readFlags,
	readQuery,
	comparators,
};

// ── Wire into SessionManager ─────────────────────────────────────────────
// SessionManager receives comparators.sessionList for Phase 4c.
// SessionStatusPoller receives comparators.sessionStatus for Phase 4d.

// ── Register with diagnostics ────────────────────────────────────────────
if (config.persistence) {
	const diag = config.persistence.diagnostics;
	for (const [name, breaker] of Object.entries(breakers)) {
		diag.registerBreaker(name, breaker);
	}
	for (const [name, comparator] of Object.entries(comparators)) {
		diag.registerComparator(name, comparator as ShadowReadComparator<unknown>);
	}
}

// ── DualWriteAuditor periodic check (I5) ─────────────────────────────────
// (Only active during dual-write phase, before Phase 7 removes legacy)
if (config.persistence && dualWriteHook) {
	const auditor = config.persistence.auditor;
	const auditInterval = setInterval(() => {
		// Build relay snapshot from in-memory state
		const snapshot = {
			sessionTitles: sessionMgr.getSessionTitleMap?.() ?? new Map(),
			sessionStatuses: new Map(
				Object.entries(statusPoller?.getStatuses() ?? {}).map(
					([id, s]) => [id, s.type],
				),
			),
			messageCounts: messageCache?.getSessionMessageCounts?.() ?? new Map(),
		};
		const result = auditor.audit(snapshot);
		if (result.mismatches.length > 0) {
			log.warn("dual-write audit mismatches", {
				mismatches: result.mismatches.slice(0, 10),
				total: result.mismatches.length,
				sampledSessions: result.sampledSessions,
			});
		}
	}, 60_000); // Every 60 seconds

	// Clean up on relay stop
	onStop(() => clearInterval(auditInterval));
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/relay-stack-consistency-wiring.test.ts`
Expected: PASS

Run: `pnpm vitest run test/unit/persistence/`
Expected: All persistence tests pass.

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/relay/relay-stack.ts src/lib/persistence/persistence-layer.ts src/lib/persistence/diagnostics.ts test/unit/persistence/relay-stack-consistency-wiring.test.ts
git commit -m "feat(persistence): wire circuit breakers + shadow-read comparators into relay stack with diagnostics"
```

---

## Completion Checklist

After all 12 tasks, verify the full plan:

```bash
pnpm vitest run test/unit/persistence/
pnpm vitest run test/unit/handlers/
pnpm vitest run test/unit/session/
pnpm check
pnpm lint
```

Expected: All tests pass. Files created or modified:

| File | Purpose |
|------|---------|
| `src/lib/persistence/read-flags.ts` | **Modified**: three-state `ReadFlagMode` replacing boolean |
| `src/lib/persistence/shadow-read-comparator.ts` | **Created**: generic three-mode comparison framework |
| `src/lib/persistence/divergence-circuit-breaker.ts` | **Created**: auto-revert flag on excessive divergence |
| `src/lib/persistence/session-history-comparator.ts` | **Created**: session history diff (4e) |
| `src/lib/persistence/pending-approvals-comparator.ts` | **Created**: pending approvals diff (4f) |
| `src/lib/persistence/dual-write-auditor.ts` | **Created**: spot-check canonical events vs relay state |
| `src/lib/persistence/diagnostics.ts` | **Modified**: `checkIntegrity()`, `readPathHealth()`, comparator/breaker registry |
| `src/lib/persistence/persistence-layer.ts` | **Modified**: exposes `diagnostics` and `auditor` |
| `src/lib/handlers/tool-content.ts` | **Modified**: uses `ShadowReadComparator` (4a) |
| `src/lib/session/session-manager.ts` | **Modified**: retrofitted to `ShadowReadComparator` (4c) |
| `src/lib/session/session-status-poller.ts` | **Modified**: retrofitted to `ShadowReadComparator` (4d) |
| `src/lib/relay/relay-stack.ts` | **Modified**: creates breakers, comparators, auditor |
| `docs/plans/2026-04-05-orchestrator-implementation-plan.md` | **Modified**: rollback procedure |

**Cross-reference with parent plan amendments:**

| Parent Plan Task | Amendment |
|-----------------|-----------|
| Task 24 (ReadFlags) | Replace `boolean` with `ReadFlagMode` throughout |
| Task 22.5 (Diagnostics) | Add `checkIntegrity()`, `readPathHealth()`, comparator/breaker registry |
| Task 25 (4a tool content) | Wire `ShadowReadComparator` |
| Task 26 (4b fork metadata) | Wire `ShadowReadComparator` |
| Task 28 (4c session list) | Replace ad-hoc comparison with `ShadowReadComparator` |
| Task 30 (4d session status) | Replace ad-hoc comparison with `ShadowReadComparator` |
| Tasks 31-32 (4e session history) | Add `compareSessionHistory()` + wire `ShadowReadComparator` |
| Tasks 33-34 (4f pending approvals) | Add `comparePendingApprovals()` + wire `ShadowReadComparator` |
| Task 24.5 (relay stack wiring) | Create breakers, comparators, register with diagnostics |
| Task 10 (DualWriteHook) | Expose `RelaySnapshot` interface for auditor consumption |
| Phase 4 intro | Add rollback procedure documentation |
