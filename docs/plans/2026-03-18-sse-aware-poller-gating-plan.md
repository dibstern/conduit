# SSE-Aware Monitoring Reducer Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace the hard `MAX_CONCURRENT_POLLERS = 10` cap with a pure monitoring reducer that uses SSE coverage to decide per-session whether a REST poller is needed.

**Architecture:** A pure reducer (`evaluateSession`/`evaluateAll`) tracks per-session monitoring phases and produces tagged effects as data. An effect executor applies them. Status augmentation is refactored to separate computation from mutation. Notification logic is extracted into a shared policy function.

**Tech Stack:** TypeScript, Vitest, pure functions, discriminated unions.

**Design doc:** `docs/plans/2026-03-18-sse-aware-poller-gating-design.md`

**TDD cycle:** Every task with tests follows Red → Green → Refactor:
1. **Red:** Write failing test, run to confirm it fails.
2. **Green:** Write minimal implementation, run to confirm it passes.
3. **Refactor:** Review implementation for clarity, duplication, naming. Run tests again to confirm refactor didn't break anything.
4. **Commit.**

---

### Task 1: Types and Constants

**Files:**
- Create: `src/lib/relay/monitoring-types.ts`

**Step 1: Create types file with all discriminated unions, reason literals, and config**

```typescript
// src/lib/relay/monitoring-types.ts
import type { SessionStatus } from "../instance/opencode-client.js";

// ── Session monitoring phases ────────────────────────────────────────────

export type SessionMonitorPhase =
	| { readonly phase: "idle" }
	| { readonly phase: "busy-grace"; readonly busySince: number }
	| {
			readonly phase: "busy-sse-covered";
			readonly busySince: number;
			readonly lastSSEAt: number;
		}
	| {
			readonly phase: "busy-polling";
			readonly busySince: number;
			readonly pollerStartedAt: number;
		}
	| {
			readonly phase: "busy-capped";
			readonly busySince: number;
			readonly cappedAt: number;
		};

// ── SSE coverage ────────────────────────────────────────────────────────

export type SSECoverage =
	| { readonly kind: "active"; readonly lastEventAt: number }
	| { readonly kind: "stale"; readonly lastEventAt: number }
	| { readonly kind: "never-seen" }
	| { readonly kind: "disconnected" };

// ── Evaluation context ──────────────────────────────────────────────────

export interface SessionEvalContext {
	readonly now: number;
	readonly status: SessionStatus;
	readonly sseConnected: boolean;
	readonly lastSSEEventAt: number | undefined;
	readonly isSubagent: boolean;
	readonly hasViewers: boolean;
}

// ── Effect reasons (const-derived) ──────────────────────────────────────

export const POLLER_START_REASONS = [
	"sse-disconnected",
	"sse-stale",
	"no-sse-history",
	"sse-grace-expired",
] as const;
export type PollerStartReason = (typeof POLLER_START_REASONS)[number];

export const POLLER_STOP_REASONS = [
	"idle-no-viewers",
	"idle-has-viewers",
	"sse-now-covering",
	"session-deleted",
] as const;
export type PollerStopReason = (typeof POLLER_STOP_REASONS)[number];

// ── Effects ─────────────────────────────────────────────────────────────

export type MonitoringEffect =
	| {
			readonly effect: "start-poller";
			readonly sessionId: string;
			readonly reason: PollerStartReason;
		}
	| {
			readonly effect: "stop-poller";
			readonly sessionId: string;
			readonly reason: PollerStopReason;
		}
	| { readonly effect: "notify-busy"; readonly sessionId: string }
	| {
			readonly effect: "notify-idle";
			readonly sessionId: string;
			readonly isSubagent: boolean;
		};

// ── Global state ────────────────────────────────────────────────────────

export interface MonitoringState {
	readonly sessions: ReadonlyMap<string, SessionMonitorPhase>;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface PollerGatingConfig {
	readonly sseActiveThresholdMs: number;
	readonly sseGracePeriodMs: number;
	readonly maxPollers: number;
}

export const DEFAULT_POLLER_GATING_CONFIG: PollerGatingConfig = {
	sseActiveThresholdMs: 5_000,
	sseGracePeriodMs: 3_000,
	maxPollers: 50,
};
```

**Step 2: Verify types compile**

Run: `pnpm check`

**Step 3: Commit**

Message: `feat: add monitoring reducer types and constants`

---

### Task 2: `deriveSSECoverage` and `SessionSSETracker`

**Files:**
- Create: `src/lib/relay/session-sse-tracker.ts`
- Add to: `src/lib/relay/monitoring-types.ts` (if `SessionSSETracker` interface not already there)
- Create: `test/unit/relay/session-sse-tracker.test.ts`

**Step 1: Write failing tests for `deriveSSECoverage` and `createSessionSSETracker`**

```typescript
// test/unit/relay/session-sse-tracker.test.ts
import { describe, expect, it } from "vitest";
import {
	createSessionSSETracker,
	deriveSSECoverage,
} from "../../../src/lib/relay/session-sse-tracker.js";

describe("deriveSSECoverage", () => {
	const THRESHOLD = 5_000;

	it("returns disconnected when global SSE is not connected", () => {
		expect(deriveSSECoverage(false, 1000, 2000, THRESHOLD)).toEqual({
			kind: "disconnected",
		});
	});

	it("returns never-seen when no SSE event recorded for session", () => {
		expect(deriveSSECoverage(true, undefined, 2000, THRESHOLD)).toEqual({
			kind: "never-seen",
		});
	});

	it("returns active when last event is within threshold", () => {
		expect(deriveSSECoverage(true, 1000, 2000, THRESHOLD)).toEqual({
			kind: "active",
			lastEventAt: 1000,
		});
	});

	it("returns stale when last event exceeds threshold", () => {
		expect(deriveSSECoverage(true, 1000, 7000, THRESHOLD)).toEqual({
			kind: "stale",
			lastEventAt: 1000,
		});
	});

	it("returns active at exactly the threshold boundary", () => {
		expect(deriveSSECoverage(true, 1000, 5999, THRESHOLD)).toEqual({
			kind: "active",
			lastEventAt: 1000,
		});
	});

	it("returns stale at exactly the threshold boundary", () => {
		expect(deriveSSECoverage(true, 1000, 6000, THRESHOLD)).toEqual({
			kind: "stale",
			lastEventAt: 1000,
		});
	});
});

describe("createSessionSSETracker", () => {
	it("returns undefined for unknown session", () => {
		const tracker = createSessionSSETracker();
		expect(tracker.getLastEventAt("unknown")).toBeUndefined();
	});

	it("records and retrieves event timestamp", () => {
		const tracker = createSessionSSETracker();
		tracker.recordEvent("s1", 1000);
		expect(tracker.getLastEventAt("s1")).toBe(1000);
	});

	it("overwrites with later timestamp", () => {
		const tracker = createSessionSSETracker();
		tracker.recordEvent("s1", 1000);
		tracker.recordEvent("s1", 2000);
		expect(tracker.getLastEventAt("s1")).toBe(2000);
	});

	it("remove clears tracking for a session", () => {
		const tracker = createSessionSSETracker();
		tracker.recordEvent("s1", 1000);
		tracker.remove("s1");
		expect(tracker.getLastEventAt("s1")).toBeUndefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- test/unit/relay/session-sse-tracker.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `deriveSSECoverage` and `createSessionSSETracker`**

```typescript
// src/lib/relay/session-sse-tracker.ts
import type { SSECoverage } from "./monitoring-types.js";

export interface SessionSSETracker {
	recordEvent(sessionId: string, now: number): void;
	getLastEventAt(sessionId: string): number | undefined;
	remove(sessionId: string): void;
}

export function createSessionSSETracker(): SessionSSETracker {
	const timestamps = new Map<string, number>();
	return {
		recordEvent(sessionId, now) {
			timestamps.set(sessionId, now);
		},
		getLastEventAt(sessionId) {
			return timestamps.get(sessionId);
		},
		remove(sessionId) {
			timestamps.delete(sessionId);
		},
	};
}

export function deriveSSECoverage(
	globalConnected: boolean,
	lastSessionEventAt: number | undefined,
	now: number,
	activeThresholdMs: number,
): SSECoverage {
	if (!globalConnected) return { kind: "disconnected" };
	if (lastSessionEventAt === undefined) return { kind: "never-seen" };
	if (now - lastSessionEventAt < activeThresholdMs)
		return { kind: "active", lastEventAt: lastSessionEventAt };
	return { kind: "stale", lastEventAt: lastSessionEventAt };
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- test/unit/relay/session-sse-tracker.test.ts`
Expected: PASS

**Step 5: Refactor**

Review the implementation for clarity, duplication, and naming. Consider: are the function signatures minimal? Any dead code? Any constants that should be extracted? Run tests again after any changes.

Run: `pnpm test:unit -- test/unit/relay/session-sse-tracker.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `feat: add SessionSSETracker and deriveSSECoverage`

---

### Task 3: `assembleContext`

**Files:**
- Create: `src/lib/relay/monitoring-reducer.ts` (start with `assembleContext`)
- Create: `test/unit/relay/monitoring-reducer.test.ts` (start with `assembleContext` tests)

**Step 1: Write failing tests**

```typescript
// test/unit/relay/monitoring-reducer.test.ts
import { describe, expect, it } from "vitest";
import { assembleContext } from "../../../src/lib/relay/monitoring-reducer.js";
import type { SessionSSETracker } from "../../../src/lib/relay/session-sse-tracker.js";

// Minimal SSE tracker stub for tests
function stubTracker(
	data: Record<string, number> = {},
): SessionSSETracker {
	return {
		recordEvent() {},
		getLastEventAt(id) {
			return data[id];
		},
		remove() {},
	};
}

describe("assembleContext", () => {
	it("assembles all fields from data sources", () => {
		const ctx = assembleContext(
			"s1",
			{ type: "busy" },
			{ connected: true },
			stubTracker({ s1: 900 }),
			new Map([["s1", "parent1"]]),
			(sid) => sid === "s1",
			1000,
		);
		expect(ctx).toEqual({
			now: 1000,
			status: { type: "busy" },
			sseConnected: true,
			lastSSEEventAt: 900,
			isSubagent: true,
			hasViewers: true,
		});
	});

	it("isSubagent is false when session not in parent map", () => {
		const ctx = assembleContext(
			"s2",
			{ type: "idle" },
			{ connected: false },
			stubTracker(),
			new Map(),
			() => false,
			2000,
		);
		expect(ctx.isSubagent).toBe(false);
		expect(ctx.lastSSEEventAt).toBeUndefined();
		expect(ctx.hasViewers).toBe(false);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: FAIL

**Step 3: Implement `assembleContext`**

```typescript
// src/lib/relay/monitoring-reducer.ts
import type { SessionStatus } from "../instance/opencode-client.js";
import type { SessionEvalContext } from "./monitoring-types.js";
import type { SessionSSETracker } from "./session-sse-tracker.js";

export function assembleContext(
	sessionId: string,
	status: SessionStatus,
	sseHealth: { connected: boolean },
	sseTracker: SessionSSETracker,
	parentMap: ReadonlyMap<string, string>,
	hasViewers: (sessionId: string) => boolean,
	now: number,
): SessionEvalContext {
	return {
		now,
		status,
		sseConnected: sseHealth.connected,
		lastSSEEventAt: sseTracker.getLastEventAt(sessionId),
		isSubagent: parentMap.has(sessionId),
		hasViewers: hasViewers(sessionId),
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: PASS

**Step 5: Refactor**

Review `assembleContext` — is the signature minimal? Should `sseHealth` be narrowed further? Any unnecessary indirection? Run tests again after any changes.

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `feat: add assembleContext for monitoring reducer`

---

### Task 4: `evaluateSession`

This is the core transition function. Write table-driven tests covering every row from the design doc's transition table.

**Files:**
- Modify: `src/lib/relay/monitoring-reducer.ts`
- Modify: `test/unit/relay/monitoring-reducer.test.ts`

**Step 1: Write failing table-driven tests**

Add to `test/unit/relay/monitoring-reducer.test.ts`:

```typescript
import {
	assembleContext,
	evaluateSession,
} from "../../../src/lib/relay/monitoring-reducer.js";
import type {
	MonitoringEffect,
	PollerGatingConfig,
	SessionEvalContext,
	SessionMonitorPhase,
} from "../../../src/lib/relay/monitoring-types.js";

const DEFAULT_CONFIG: PollerGatingConfig = {
	sseActiveThresholdMs: 5_000,
	sseGracePeriodMs: 3_000,
	maxPollers: 50,
};

// Helper to build a minimal SessionEvalContext
function ctx(overrides: Partial<SessionEvalContext> = {}): SessionEvalContext {
	return {
		now: 1000,
		status: { type: "idle" },
		sseConnected: true,
		lastSSEEventAt: undefined,
		isSubagent: false,
		hasViewers: false,
		...overrides,
	};
}

describe("evaluateSession", () => {
	// ── from idle ────────────────────────────────────────────────────────

	it("idle + idle status → idle, no effects", () => {
		const result = evaluateSession("s1", { phase: "idle" }, ctx(), DEFAULT_CONFIG);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([]);
	});

	it("idle + busy + SSE active → busy-sse-covered + notify-busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({ status: { type: "busy" }, lastSSEEventAt: 900 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 1000,
			lastSSEAt: 900,
		});
		expect(result.effects).toEqual([{ effect: "notify-busy", sessionId: "s1" }]);
	});

	it("idle + busy + no SSE → busy-grace + notify-busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({ status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "busy-grace", busySince: 1000 });
		expect(result.effects).toEqual([{ effect: "notify-busy", sessionId: "s1" }]);
	});

	it("idle + retry status → treated as busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({ status: { type: "retry", attempt: 1, message: "err", next: 2000 } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-grace");
		expect(result.effects).toContainEqual({ effect: "notify-busy", sessionId: "s1" });
	});

	// ── from busy-grace ──────────────────────────────────────────────────

	it("busy-grace + idle → idle + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 1000, status: { type: "idle" }, isSubagent: false }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-grace + idle (subagent) → notify-idle with isSubagent=true", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ status: { type: "idle" }, isSubagent: true }),
			DEFAULT_CONFIG,
		);
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: true },
		]);
	});

	it("busy-grace + SSE active → busy-sse-covered, no effects", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ status: { type: "busy" }, lastSSEEventAt: 800 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 800,
		});
		expect(result.effects).toEqual([]);
	});

	it("busy-grace + grace expired + SSE disconnected → busy-polling + start-poller(sse-disconnected)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 5000, status: { type: "busy" }, sseConnected: false }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-polling",
			busySince: 0,
			pollerStartedAt: 5000,
		});
		expect(result.effects).toEqual([
			{ effect: "start-poller", sessionId: "s1", reason: "sse-disconnected" },
		]);
	});

	it("busy-grace + grace expired + SSE never-seen → busy-polling + start-poller(no-sse-history)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 5000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "no-sse-history",
		});
	});

	it("busy-grace + grace NOT expired + no SSE → stays busy-grace", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 2000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "busy-grace", busySince: 0 });
		expect(result.effects).toEqual([]);
	});

	it("busy-grace + grace expiry exact boundary (now - busySince === gracePeriodMs) → stays busy-grace (check is >)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 3000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		// Grace check is `>` not `>=`, so exactly at threshold stays in grace
		expect(result.phase).toEqual({ phase: "busy-grace", busySince: 0 });
		expect(result.effects).toEqual([]);
	});

	it("busy-grace + grace expired + SSE stale → busy-polling + start-poller(sse-grace-expired)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 5000, status: { type: "busy" }, lastSSEEventAt: 100 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "sse-grace-expired",
		});
	});

	// ── from busy-sse-covered ────────────────────────────────────────────

	it("busy-sse-covered + idle → idle + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ status: { type: "idle" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-sse-covered + SSE disconnected → busy-polling + start-poller(sse-disconnected)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ now: 1000, status: { type: "busy" }, sseConnected: false }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "sse-disconnected",
		});
	});

	it("busy-sse-covered + SSE stale → busy-polling + start-poller(sse-stale)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ now: 10000, status: { type: "busy" }, lastSSEEventAt: 500 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "sse-stale",
		});
	});

	it("busy-sse-covered + SSE active → stays, updates lastSSEAt", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ now: 2000, status: { type: "busy" }, lastSSEEventAt: 1800 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 1800,
		});
		expect(result.effects).toEqual([]);
	});

	// ── from busy-polling ────────────────────────────────────────────────

	it("busy-polling + idle + no viewers → stop-poller(idle-no-viewers) + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "idle" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "stop-poller", sessionId: "s1", reason: "idle-no-viewers" },
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-polling + idle + has viewers → stop-poller(idle-has-viewers) + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "idle" }, hasViewers: true }),
			DEFAULT_CONFIG,
		);
		expect(result.effects).toContainEqual({
			effect: "stop-poller",
			sessionId: "s1",
			reason: "idle-has-viewers",
		});
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
	});

	it("busy-polling + SSE resumes → busy-sse-covered + stop-poller(sse-now-covering)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "busy" }, lastSSEEventAt: 4900 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 4900,
		});
		expect(result.effects).toEqual([
			{ effect: "stop-poller", sessionId: "s1", reason: "sse-now-covering" },
		]);
	});

	it("busy-polling + still busy + no SSE → stays busy-polling", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-polling",
			busySince: 0,
			pollerStartedAt: 100,
		});
		expect(result.effects).toEqual([]);
	});

	// ── from busy-capped ────────────────────────────────────────────────

	it("busy-capped + idle → idle + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-capped", busySince: 0, cappedAt: 100 },
			ctx({ now: 5000, status: { type: "idle" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-capped + SSE active → busy-sse-covered, no effects", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-capped", busySince: 0, cappedAt: 100 },
			ctx({ now: 2000, status: { type: "busy" }, lastSSEEventAt: 1800 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 1800,
		});
		expect(result.effects).toEqual([]);
	});

	it("busy-capped + still busy + no SSE → stays busy-capped", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-capped", busySince: 0, cappedAt: 100 },
			ctx({ now: 5000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-capped",
			busySince: 0,
			cappedAt: 100,
		});
		expect(result.effects).toEqual([]);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: FAIL (evaluateSession not exported)

**Step 3: Implement `evaluateSession`**

Add to `src/lib/relay/monitoring-reducer.ts`:

```typescript
import type {
	MonitoringEffect,
	PollerGatingConfig,
	SessionEvalContext,
	SessionMonitorPhase,
} from "./monitoring-types.js";
import type { SSECoverage } from "./monitoring-types.js";
import { deriveSSECoverage } from "./session-sse-tracker.js";

export function evaluateSession(
	sessionId: string,
	current: SessionMonitorPhase,
	ctx: SessionEvalContext,
	config: Readonly<PollerGatingConfig>,
): {
	readonly phase: SessionMonitorPhase;
	readonly effects: readonly MonitoringEffect[];
} {
	const isBusy =
		ctx.status.type === "busy" || ctx.status.type === "retry";
	const sse: SSECoverage = deriveSSECoverage(
		ctx.sseConnected,
		ctx.lastSSEEventAt,
		ctx.now,
		config.sseActiveThresholdMs,
	);
	const effects: MonitoringEffect[] = [];

	switch (current.phase) {
		case "idle": {
			if (!isBusy) return { phase: current, effects: [] };
			effects.push({ effect: "notify-busy", sessionId });
			if (sse.kind === "active") {
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: ctx.now,
						lastSSEAt: sse.lastEventAt,
					},
					effects,
				};
			}
			return {
				phase: { phase: "busy-grace", busySince: ctx.now },
				effects,
			};
		}

		case "busy-grace": {
			if (!isBusy) {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "active") {
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: current.busySince,
						lastSSEAt: sse.lastEventAt,
					},
					effects: [],
				};
			}
			const graceExpired =
				ctx.now - current.busySince > config.sseGracePeriodMs;
			if (graceExpired) {
				const reason =
					sse.kind === "disconnected"
						? ("sse-disconnected" as const)
						: sse.kind === "never-seen"
							? ("no-sse-history" as const)
							: ("sse-grace-expired" as const);
				effects.push({ effect: "start-poller", sessionId, reason });
				return {
					phase: {
						phase: "busy-polling",
						busySince: current.busySince,
						pollerStartedAt: ctx.now,
					},
					effects,
				};
			}
			return { phase: current, effects: [] };
		}

		case "busy-sse-covered": {
			if (!isBusy) {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "disconnected") {
				effects.push({
					effect: "start-poller",
					sessionId,
					reason: "sse-disconnected",
				});
				return {
					phase: {
						phase: "busy-polling",
						busySince: current.busySince,
						pollerStartedAt: ctx.now,
					},
					effects,
				};
			}
			if (sse.kind === "stale") {
				effects.push({
					effect: "start-poller",
					sessionId,
					reason: "sse-stale",
				});
				return {
					phase: {
						phase: "busy-polling",
						busySince: current.busySince,
						pollerStartedAt: ctx.now,
					},
					effects,
				};
			}
			// SSE still active — update lastSSEAt
			return {
				phase: {
					phase: "busy-sse-covered",
					busySince: current.busySince,
					lastSSEAt: sse.kind === "active" ? sse.lastEventAt : current.lastSSEAt,
				},
				effects: [],
			};
		}

		case "busy-polling": {
			if (!isBusy) {
				const stopReason = ctx.hasViewers
					? ("idle-has-viewers" as const)
					: ("idle-no-viewers" as const);
				effects.push({ effect: "stop-poller", sessionId, reason: stopReason });
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "active") {
				effects.push({
					effect: "stop-poller",
					sessionId,
					reason: "sse-now-covering",
				});
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: current.busySince,
						lastSSEAt: sse.lastEventAt,
					},
					effects,
				};
			}
			return { phase: current, effects: [] };
		}

		case "busy-capped": {
			if (!isBusy) {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "active") {
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: current.busySince,
						lastSSEAt: sse.lastEventAt,
					},
					effects: [],
				};
			}
			// Still busy, no SSE — stay capped. evaluateAll will promote if cap has room.
			return { phase: current, effects: [] };
		}

		default: {
			const _exhaustive: never = current;
			return _exhaustive;
		}
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: PASS

**Step 5: Refactor**

Review `evaluateSession` for:
- Duplicated pattern between phases (e.g., the `!isBusy` → idle transition appears in 3 branches — can it be hoisted?). Only hoist if it genuinely reduces complexity; each phase having explicit handling is also a valid design choice for readability.
- Are the `as const` assertions on reason literals necessary, or can TypeScript infer them?
- Is the `switch` exhaustiveness check working (the `default: never` branch)?
- Any helper worth extracting (e.g., a `transitionToPolling` or `transitionToIdle` helper)?

Run tests again after any changes:

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `feat: implement evaluateSession transition function`

---

### Task 5: `evaluateAll` and `initialMonitoringState`

**Files:**
- Modify: `src/lib/relay/monitoring-reducer.ts`
- Modify: `test/unit/relay/monitoring-reducer.test.ts`

**Step 1: Write failing tests for `evaluateAll`**

Add to the test file:

```typescript
import {
	assembleContext,
	evaluateAll,
	evaluateSession,
	initialMonitoringState,
} from "../../../src/lib/relay/monitoring-reducer.js";

describe("evaluateAll", () => {
	it("new sessions default to idle and evaluate normally", () => {
		const contexts = new Map([
			["s1", ctx({ status: { type: "busy" } })],
		]);
		const result = evaluateAll(initialMonitoringState(), contexts, DEFAULT_CONFIG);
		expect(result.state.sessions.get("s1")?.phase).toBe("busy-grace");
		expect(result.effects).toContainEqual({ effect: "notify-busy", sessionId: "s1" });
	});

	it("deleted session with active poller emits stop-poller(session-deleted) and notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-polling" as const, busySince: 0, pollerStartedAt: 100 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "stop-poller",
			sessionId: "s1",
			reason: "session-deleted",
		});
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
		expect(result.state.sessions.has("s1")).toBe(false);
	});

	it("deleted session in busy-sse-covered emits notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-sse-covered" as const, busySince: 0, lastSSEAt: 500 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
		// No stop-poller since it wasn't polling
		expect(result.effects.filter((e) => e.effect === "stop-poller")).toEqual([]);
	});

	it("deleted session in busy-grace emits notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-grace" as const, busySince: 0 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
	});

	it("deleted session in busy-capped emits notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-capped" as const, busySince: 0, cappedAt: 100 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
	});

	it("steady state produces no effects", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "idle" as const }],
			]),
		};
		const contexts = new Map([
			["s1", ctx({ status: { type: "idle" } })],
		]);
		const result = evaluateAll(state, contexts, DEFAULT_CONFIG);
		expect(result.effects).toEqual([]);
		expect(result.state.sessions.get("s1")).toEqual({ phase: "idle" });
	});

	it("safety cap drops excess start-poller effects and sets busy-capped phase", () => {
		const config = { ...DEFAULT_CONFIG, maxPollers: 1 };
		const contexts = new Map([
			["s1", ctx({ now: 5000, status: { type: "busy" } })],
			["s2", ctx({ now: 5000, status: { type: "busy" } })],
		]);
		// Both sessions in busy-grace with expired grace
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["s1", { phase: "busy-grace", busySince: 0 }],
				["s2", { phase: "busy-grace", busySince: 0 }],
			]),
		};
		const result = evaluateAll(state, contexts, config);
		const starts = result.effects.filter((e) => e.effect === "start-poller");
		expect(starts).toHaveLength(1);
		// The capped session should be in busy-capped phase, not busy-grace
		const phases = [...result.state.sessions.values()];
		const capped = phases.filter((p) => p.phase === "busy-capped");
		expect(capped).toHaveLength(1);
		// Verify busySince is preserved (original was 0)
		expect(capped[0]).toHaveProperty("busySince", 0);
		expect(capped[0]).toHaveProperty("cappedAt", 5000);
	});

	it("safety cap correctly counts continuing pollers (no double-counting)", () => {
		const config = { ...DEFAULT_CONFIG, maxPollers: 2 };
		const contexts = new Map([
			// s1 is already polling, stays busy → continues as busy-polling
			["s1", ctx({ now: 5000, status: { type: "busy" } })],
			// s2 and s3 both want to start polling
			["s2", ctx({ now: 5000, status: { type: "busy" } })],
			["s3", ctx({ now: 5000, status: { type: "busy" } })],
		]);
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["s1", { phase: "busy-polling", busySince: 0, pollerStartedAt: 100 }],
				["s2", { phase: "busy-grace", busySince: 0 }],
				["s3", { phase: "busy-grace", busySince: 0 }],
			]),
		};
		const result = evaluateAll(state, contexts, config);
		// s1 continues (1 continuing), s2 starts (1 new) = 2 total = maxPollers
		// s3 should be capped
		const starts = result.effects.filter((e) => e.effect === "start-poller");
		expect(starts).toHaveLength(1); // only s2 (or s3) starts
		const capped = [...result.state.sessions.values()].filter(
			(p) => p.phase === "busy-capped",
		);
		expect(capped).toHaveLength(1);
	});

	it("busy-capped sessions are promoted when cap has room", () => {
		const config = { ...DEFAULT_CONFIG, maxPollers: 2 };
		const contexts = new Map([
			["s1", ctx({ now: 5000, status: { type: "busy" } })],
			["s2", ctx({ now: 5000, status: { type: "busy" } })],
		]);
		// s1 was polling, s2 was capped
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["s1", { phase: "busy-polling", busySince: 0, pollerStartedAt: 100 }],
				["s2", { phase: "busy-capped", busySince: 0, cappedAt: 4000 }],
			]),
		};
		const result = evaluateAll(state, contexts, config);
		// s1 continues as busy-polling, s2 should be promoted from capped → busy-polling
		expect(result.state.sessions.get("s2")?.phase).toBe("busy-polling");
		const starts = result.effects.filter((e) => e.effect === "start-poller");
		expect(starts).toContainEqual(
			expect.objectContaining({ sessionId: "s2" }),
		);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: FAIL

**Step 3: Implement `evaluateAll` and `initialMonitoringState`**

Add to `src/lib/relay/monitoring-reducer.ts`:

```typescript
import type { MonitoringState, PollerStartReason } from "./monitoring-types.js";

export function initialMonitoringState(): MonitoringState {
	return { sessions: new Map() };
}

export function evaluateAll(
	state: MonitoringState,
	contexts: ReadonlyMap<string, SessionEvalContext>,
	config: Readonly<PollerGatingConfig>,
): {
	readonly state: MonitoringState;
	readonly effects: readonly MonitoringEffect[];
} {
	const newSessions = new Map<string, SessionMonitorPhase>();
	const effects: MonitoringEffect[] = [];

	// Evaluate sessions present in contexts
	for (const [sessionId, evalCtx] of contexts) {
		const current = state.sessions.get(sessionId) ?? { phase: "idle" as const };
		const result = evaluateSession(sessionId, current, evalCtx, config);
		newSessions.set(sessionId, result.phase);
		effects.push(...result.effects);
	}

	// Handle sessions that disappeared (deleted)
	for (const [sessionId, phase] of state.sessions) {
		if (!contexts.has(sessionId)) {
			// Any busy phase → notify-idle so browser clients get a done event
			if (phase.phase !== "idle") {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: false, // deleted sessions — safe default
				});
			}
			// busy-polling additionally needs stop-poller
			if (phase.phase === "busy-polling") {
				effects.push({
					effect: "stop-poller",
					sessionId,
					reason: "session-deleted",
				});
			}
		}
	}

	// Promote busy-capped sessions if cap has room (checked after safety cap below)
	// First, collect which sessions are candidates for promotion
	const cappedSessions: string[] = [];
	for (const [sessionId, phase] of newSessions) {
		if (phase.phase === "busy-capped") {
			cappedSessions.push(sessionId);
		}
	}

	// Safety cap post-processing
	// Count sessions that were busy-polling in PREVIOUS state AND remain busy-polling in new state
	let continuingPollers = 0;
	for (const [sessionId, oldPhase] of state.sessions) {
		if (oldPhase.phase === "busy-polling") {
			const newPhase = newSessions.get(sessionId);
			if (newPhase && newPhase.phase === "busy-polling") {
				continuingPollers++;
			}
		}
	}
	const startEffects = effects.filter((e) => e.effect === "start-poller");
	const totalPollers = continuingPollers + startEffects.length;

	if (totalPollers > config.maxPollers) {
		// Drop excess start-poller effects (keep the first N that fit)
		const excess = totalPollers - config.maxPollers;
		const toKeep = startEffects.length - excess;
		let kept = 0;
		const now = contexts.values().next().value?.now ?? Date.now();
		const capped = effects.filter((e) => {
			if (e.effect !== "start-poller") return true;
			if (kept < toKeep) {
				kept++;
				return true;
			}
			// Set phase to busy-capped, preserving original busySince
			const currentPhase = newSessions.get(e.sessionId);
			const busySince =
				currentPhase && "busySince" in currentPhase
					? currentPhase.busySince
					: now;
			newSessions.set(e.sessionId, {
				phase: "busy-capped",
				busySince,
				cappedAt: now,
			});
			return false;
		});

		// After capping, try to promote any existing busy-capped sessions if room opened
		// (room opened = toKeep > 0, meaning some starts were allowed)
		// Count remaining capacity after capping
		const usedAfterCap = continuingPollers + toKeep;
		let remaining = config.maxPollers - usedAfterCap;
		const promotionEffects: MonitoringEffect[] = [];
		for (const sessionId of cappedSessions) {
			if (remaining <= 0) break;
			const phase = newSessions.get(sessionId);
			if (phase?.phase === "busy-capped") {
				const ctx = contexts.get(sessionId);
				const reason: PollerStartReason = ctx
					? (!ctx.sseConnected
						? "sse-disconnected"
						: ctx.lastSSEEventAt === undefined
							? "no-sse-history"
							: "sse-grace-expired")
					: "sse-grace-expired";
				promotionEffects.push({ effect: "start-poller", sessionId, reason });
				newSessions.set(sessionId, {
					phase: "busy-polling",
					busySince: phase.busySince,
					pollerStartedAt: now,
				});
				remaining--;
			}
		}

		return { state: { sessions: newSessions }, effects: [...capped, ...promotionEffects] };
	}

	// No cap exceeded — promote all busy-capped sessions
	const promotionEffects: MonitoringEffect[] = [];
	let currentTotal = totalPollers;
	for (const sessionId of cappedSessions) {
		if (currentTotal >= config.maxPollers) break;
		const phase = newSessions.get(sessionId);
		if (phase?.phase === "busy-capped") {
			const ctx = contexts.get(sessionId);
			const now = ctx?.now ?? Date.now();
			const reason: PollerStartReason = ctx
				? (!ctx.sseConnected
					? "sse-disconnected"
					: ctx.lastSSEEventAt === undefined
						? "no-sse-history"
						: "sse-grace-expired")
				: "sse-grace-expired";
			promotionEffects.push({ effect: "start-poller", sessionId, reason });
			newSessions.set(sessionId, {
				phase: "busy-polling",
				busySince: phase.busySince,
				pollerStartedAt: now,
			});
			currentTotal++;
		}
	}

	return { state: { sessions: newSessions }, effects: [...effects, ...promotionEffects] };
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: PASS

**Step 5: Refactor**

Review `evaluateAll` for:
- Is the safety cap post-processing clean? The `filter` + counter approach works but is it readable? Consider extracting a `applyPollerCap(effects, newSessions, config)` helper if the logic exceeds ~15 lines.
- Is the deleted-session cleanup (iterating `state.sessions` for missing entries) efficient enough for the expected session count (<100)?
- Does `initialMonitoringState` need to accept optional seed state for testing convenience?

Run tests again after any changes:

Run: `pnpm test:unit -- test/unit/relay/monitoring-reducer.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `feat: implement evaluateAll batch evaluation with safety cap`

---

### Task 6: `resolveNotifications`

**Files:**
- Create: `src/lib/relay/notification-policy.ts`
- Create: `test/unit/relay/notification-policy.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/relay/notification-policy.test.ts
import { describe, expect, it } from "vitest";
import { resolveNotifications } from "../../../src/lib/relay/notification-policy.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

describe("resolveNotifications", () => {
	it("done + not subagent + route send → push yes, broadcast no", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			{ action: "send", sessionId: "s1" },
			false,
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(false);
	});

	it("done + not subagent + route drop → push yes, broadcast yes", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			false,
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toBeDefined();
	});

	it("done + subagent → push no, broadcast no", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			true,
		);
		expect(result.sendPush).toBe(false);
		expect(result.broadcastCrossSession).toBe(false);
	});

	it("error + subagent → push yes (only done suppressed for subagents)", () => {
		const result = resolveNotifications(
			{ type: "error", code: "ERR", message: "something broke" } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			true,
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(true);
	});

	it("error + not subagent + route drop → includes error message in payload", () => {
		const result = resolveNotifications(
			{ type: "error", code: "ERR", message: "something broke" } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			false,
		);
		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toHaveProperty("message", "something broke");
	});

	it("non-notifiable type (delta) → push no, broadcast no", () => {
		const result = resolveNotifications(
			{ type: "delta", text: "hello" } as RelayMessage,
			{ action: "send", sessionId: "s1" },
			false,
		);
		expect(result.sendPush).toBe(false);
		expect(result.broadcastCrossSession).toBe(false);
	});
});
```

**Step 2: Run to verify fail**

Run: `pnpm test:unit -- test/unit/relay/notification-policy.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement**

Implementation uses `sendPushForEvent` (which handles done, error, permission_request, ask_user) instead of gating on `isNotificationWorthy` (which only covers done, error). Add `sendPushForEvent` to the deps interface.

For subagent suppression: only suppress `done` events for subagent sessions, not all event types. Subagent errors should still fire push notifications. Change the logic from "if isSubagent return no notifications" to "if isSubagent AND msg.type === done return no notifications".

Import `sendPushForEvent` from the existing push module and apply the logic from the design doc Section 10.

**Step 4: Run to verify pass**

Run: `pnpm test:unit -- test/unit/relay/notification-policy.test.ts`
Expected: PASS

**Step 5: Refactor**

Review: is the `crossSessionPayload` construction clean? Could the error-message extraction be simplified? Is the `isNotificationWorthy` import the right abstraction boundary, or should notification-worthiness be defined here?

Run: `pnpm test:unit -- test/unit/relay/notification-policy.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `feat: extract resolveNotifications shared notification policy`

---

### Task 7: `classifyPollerBatch`

**Files:**
- Create: `src/lib/relay/poller-pre-filter.ts`
- Create: `test/unit/relay/poller-pre-filter.test.ts`

**Step 1: Write `classifyPollerBatch` tests and implementation**

Do NOT add a `has()` method to `PendingUserMessages`. The existing `consume()` pattern (check+remove atomically) is correct. The executor loop should call `consume()` inline for all events — this is the existing pattern and avoids echo entries lingering in the pending map.

The pre-filter (`classifyPollerBatch`) classifies the batch for `hasContentActivity` (whether to call `markMessageActivity`), but echo suppression stays inline with `consume()` in the executor loop. The pre-filter does NOT need to identify echoes — it only checks for content activity.

Update `classifyPollerBatch` signature:

```typescript
function classifyPollerBatch(
  events: readonly RelayMessage[],
): { readonly hasContentActivity: boolean }
```

The executor loop handles echo suppression inline:

```typescript
for (const msg of events) {
  if (pendingUserMessages.consume(sessionId, msg)) {
    // This was a relay echo — skip pipeline processing
    continue;
  }
  const result = processEvent(msg, sessionId, viewers, "message-poller");
  applyPipelineResult(result, sessionId, pipelineDeps);
  // ... notification logic ...
}
```

**Step 2: Run to verify fail**

Run: `pnpm test:unit -- test/unit/relay/poller-pre-filter.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `classifyPollerBatch`**

**Step 4: Run to verify pass**

Run: `pnpm test:unit -- test/unit/relay/poller-pre-filter.test.ts`
Expected: PASS

**Step 5: Refactor**

Review: is `classifyPollerBatch` doing the right thing? It should only classify content activity, not echo suppression. Echo suppression is handled inline by `consume()` in the executor loop.

Run: `pnpm test:unit -- test/unit/relay/poller-pre-filter.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `feat: add classifyPollerBatch for poller event pre-filter`

---

### Task 8: Pure Status Augmentation

**Files:**
- Create: `src/lib/session/status-augmentation.ts`
- Create: `test/unit/session/status-augmentation.test.ts`

**Step 1: Write failing tests for `computeAugmentedStatuses`**

Test cases from design doc Section 9: subagent propagation, activity injection, TTL expiry, sseIdle clearing.

**Step 2: Run to verify fail**

Run: `pnpm test:unit -- test/unit/session/status-augmentation.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement**

Implement `computeAugmentedStatuses` (pure), `resolveUnknownParents` (async pre-pass), `applyAugmentSideEffects` (effectful post-pass).

**Step 4: Run to verify pass**

Run: `pnpm test:unit -- test/unit/session/status-augmentation.test.ts`
Expected: PASS

**Step 5: Refactor**

Review: does `computeAugmentedStatuses` have a single responsibility or is it doing too much in one pass? Should subagent propagation and message-activity injection be separate pure functions composed together? Check that `AugmentResult` carries exactly the right data — no more, no less. Verify the `resolveUnknownParents` async pre-pass is correctly handling API failures (cache as `undefined`).

Run: `pnpm test:unit -- test/unit/session/status-augmentation.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `feat: extract pure computeAugmentedStatuses from SessionStatusPoller`

---

### Task 9: Effect Executor

**Files:**
- Create: `src/lib/relay/monitoring-effects.ts`

**Step 1: Implement `applyMonitoringEffects`**

The executor is a `switch` on `effect.effect`. It delegates to existing components (`pollerManager`, `statusPoller`, `wsHandler`, etc.) via a `MonitoringEffectDeps` interface using `Pick<>`. The `notify-idle` branch uses `resolveNotifications` from Task 6.

**Important implementation details:**

- **`start-poller` executor:** Add `.catch()` with warning log to the async `client.getMessages()` call, matching the existing error handling pattern:
  ```typescript
  case "start-poller":
    deps.client.getMessages(effect.sessionId)
      .then((msgs) => deps.pollerManager.startPolling(effect.sessionId, msgs))
      .catch((err) => deps.log.warn("Failed to start poller for %s: %s", effect.sessionId, err));
    break;
  ```

- **`sendPushForEvent` in deps:** Add `sendPushForEvent` as a function in `MonitoringEffectDeps`:
  ```typescript
  interface MonitoringEffectDeps {
    // ... existing deps ...
    sendPushForEvent: (pushManager: PushNotificationManager, msg: RelayMessage, log: Logger) => void;
  }
  ```

This is largely wiring code (calling existing methods), so it doesn't need extensive unit tests — integration tests (Task 13) will cover it. Write the implementation with type-safe deps.

**Step 2: Verify types compile**

Run: `pnpm check`

**Step 3: Commit**

Message: `feat: add applyMonitoringEffects effect executor`

---

### Task 10: Wire Reducer into `relay-stack.ts`

> **Rationale for reorder:** This task (formerly Task 12) must happen BEFORE simplifying MessagePollerManager and SessionStatusPoller, because those simplifications remove events/methods that relay-stack.ts still references. Wiring the reducer first replaces those references, so the subsequent simplification tasks don't cause compilation breaks.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`

**Step 1: Add new state and SSE tracker**

At the top of `createProjectRelay()`, add:
- `let monitoringState = initialMonitoringState();`
- `const sseTracker = createSessionSSETracker();`

**Step 2: Construct `pollerGatingConfig` and `effectDeps`**

Add explicit construction of both objects:

```typescript
const pollerGatingConfig: PollerGatingConfig = DEFAULT_POLLER_GATING_CONFIG;
// Or from relay config if configurable:
// const pollerGatingConfig: PollerGatingConfig = {
//   sseActiveThresholdMs: config.sseActiveThresholdMs ?? 5_000,
//   sseGracePeriodMs: config.sseGracePeriodMs ?? 3_000,
//   maxPollers: config.maxPollers ?? 50,
// };

const effectDeps: MonitoringEffectDeps = {
  pollerManager,
  statusPoller,
  overrides,
  client,
  wsHandler,
  pushManager,
  processEvent,
  applyPipelineResult,
  pipelineDeps,
  sendPushForEvent,
  log: sessionLog,
};
```

**Step 3: Update SSE event wiring**

In the existing `sseConsumer.on("event")` handler (around line 683), add `sseTracker.recordEvent(sid, Date.now())` alongside the existing `pollerManager.notifySSEEvent(sid)`.

**Step 4: Update `session_lifecycle` handler**

- On create: remove `pollerManager.startPolling(sid, existingMessages)`. Just rebuild translator history.
- On delete: add `sseTracker.remove(ev.sessionId)`. Remove `pollerManager.stopPolling(sid)` and `statusPoller.clearMessageActivity(sid)`.

**Step 5: Replace `statusPoller.on("changed")` handler**

Replace the body with the pseudocode from design doc Section 7:
1. Session list broadcast (unchanged).
2. Assemble `SessionEvalContext` for each session.
3. Call `evaluateAll(monitoringState, contexts, pollerGatingConfig)`.
4. Update `monitoringState`.
5. Call `applyMonitoringEffects(result.effects, effectDeps)`.

**Step 6: Remove `became_busy` and `became_idle` handlers**

Delete the `statusPoller.on("became_busy")` and `statusPoller.on("became_idle")` handlers entirely.

**Step 7: Remove `capacity_exceeded` handler**

Delete the `pollerManager.on("capacity_exceeded")` handler.

**Step 8: Refactor poller event handler**

Replace the inline logic with `classifyPollerBatch` + `resolveNotifications` per design doc Section 10. Echo suppression uses `consume()` inline (the existing pattern):

```typescript
for (const msg of events) {
  if (pendingUserMessages.consume(sessionId, msg)) {
    continue; // relay echo — skip
  }
  const viewers = wsHandler.getClientsForSession(sessionId);
  const result = processEvent(msg, sessionId, viewers, "message-poller");
  applyPipelineResult(result, sessionId, pipelineDeps);
  const notify = resolveNotifications(msg, result.route, isSubagent);
  if (notify.sendPush && pushManager) sendPushForEvent(pushManager, msg, sessionLog);
  if (notify.broadcastCrossSession && notify.crossSessionPayload) {
    wsHandler.broadcast(notify.crossSessionPayload);
  }
}
```

**Step 9: Run full test suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 10: Commit**

Message: `feat: wire monitoring reducer into relay-stack, replacing scattered event handlers`

---

### Task 11: Simplify `MessagePollerManager`

**Files:**
- Modify: `src/lib/relay/message-poller-manager.ts`
- Modify: `test/unit/relay/message-poller-manager.test.ts` (update tests)

**Step 1: Remove `MAX_CONCURRENT_POLLERS`, capacity check, `capacity_exceeded` event, and `emitDone`**

The `startPolling` method should always succeed. Remove the cap guard and the `capacity_exceeded` event from the events interface. Remove the `emitDone` method and its delegation.

**Step 2: Update existing tests**

Remove tests that assert `capacity_exceeded` behavior. Verify that `startPolling` now always creates a poller.

Specific test blocks to delete:
- `message-poller-manager.test.ts:158-167` (`emitDone` delegation test)
- `message-poller-manager.test.ts:59` (capacity test — `should not exceed max concurrent pollers`)
- `message-poller-manager.test.ts:78` (capacity test — `should emit capacity_exceeded`)
- `message-poller-manager.test.ts:91` (capacity test — `should allow new poller after stopping one`)

**Step 3: Run tests**

Run: `pnpm test:unit -- test/unit/relay/message-poller-manager.test.ts`
Expected: PASS

**Step 4: Commit**

Message: `refactor: remove MAX_CONCURRENT_POLLERS cap and emitDone from MessagePollerManager`

---

### Task 12: Simplify `SessionStatusPoller`

**Files:**
- Modify: `src/lib/session/session-status-poller.ts`
- Modify: `test/unit/session/session-status-poller.test.ts`

**Step 1: Remove `became_busy`/`became_idle` events and `previousBusy`**

- Remove `previousBusy` field.
- Remove the `computeStatusTransitions` import and the transition detection in `poll()`.
- Remove `became_busy` and `became_idle` from `SessionStatusPollerEvents`.
- Keep `changed` event, `markMessageActivity`, `notifySSEIdle`, `clearMessageActivity`.

**Step 2: Change `poll()` to ALWAYS emit statuses**

Change the `poll()` method to always emit statuses on every poll cycle, not just when statuses have changed. The simplest fix: always emit the statuses, removing the `hasChanged` check that gates the `changed` event. This ensures the reducer is called every 500ms even when status hasn't changed, which is required for grace period expiry.

Either:
- Rename `changed` to `poll-cycle` and always emit, OR
- Always emit `changed` regardless of whether statuses differ (keeping the event name)

The simplest approach: always emit `changed`. The reducer is idempotent — evaluating unchanged statuses produces no effects.

Specific test blocks to update:
- `message-poller.test.ts:881-909` (`emitDone` test block — delete)
- `session-status-poller.test.ts` `notifySSEIdle` test — refactor assertions to not check `became_idle`

**Step 3: Refactor `augmentStatuses` to use pure `computeAugmentedStatuses`**

Replace the body of `augmentStatuses` (or the `poll` method's augmentation call) with:
1. Call `resolveUnknownParents` (async pre-pass).
2. Call `computeAugmentedStatuses` (pure).
3. Call `applyAugmentSideEffects` (effectful).

Import from `status-augmentation.ts`.

**Step 4: Update existing tests**

Remove tests for `became_busy`/`became_idle` events. Add tests verifying the refactored augmentation produces the same results.

**Step 5: Run tests**

Run: `pnpm test:unit -- test/unit/session/session-status-poller.test.ts`
Expected: PASS

**Step 6: Commit**

Message: `refactor: simplify SessionStatusPoller — remove transition detection, always emit statuses, extract pure augmentation`

---

### Task 13: Remove Old Code

**Files:**
- Modify: `src/lib/relay/status-transitions.ts` — delete `computeStatusTransitions`, `StatusTransitions`, `computePollerDecisions`, `PollerDecision`. If the file becomes empty, delete it entirely.
- Modify: `test/unit/relay/status-transitions.test.ts` — delete or remove tests for deleted functions. If all tests are gone, delete the file.
- Modify: `src/lib/relay/message-poller.ts` — remove `emitDone` method.
- Modify: `test/unit/relay/message-poller.test.ts` — delete the `emitDone` test block at lines 881-909.
- Update any remaining imports of removed symbols across the codebase.

**Step 1: Remove old functions and types**

**Step 2: Run full test suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 3: Commit**

Message: `refactor: remove computeStatusTransitions, computePollerDecisions, and emitDone`

---

### Task 14: Full Verification

**Step 1: Run full verification suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass with no regressions.

**Step 2: Spot-check with targeted test directories**

Run: `pnpm test:unit -- test/unit/relay/ test/unit/session/` to run all relay and session tests.
Expected: PASS

**Step 3: Manual smoke test (if relay is running)**

- Start 10+ subagent sessions from the relay UI.
- Verify no `POLLER_CAPACITY` error appears in browser.
- Verify subagent sessions show processing spinners and done transitions correctly.
- Check daemon logs (`~/.opencode/daemon.log`) for `start-poller` / `stop-poller` log entries with reasons.
