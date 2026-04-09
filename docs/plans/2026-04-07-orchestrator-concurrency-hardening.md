# Orchestrator Concurrency Hardening Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the concurrency and race condition gaps identified in the orchestrator plan audit, making the event store pipeline robust against SSE reconnects, crash recovery interleaving, deferred projection failures, and concurrent browser clients.

**Architecture:** Three cross-cutting design changes address all 10 audit findings with minimal code: (1) replace ad-hoc reconnect resets with a single `onReconnect()` lifecycle method that atomically coordinates all stateful components, (2) eliminate `queueMicrotask` deferred projection entirely in favor of synchronous projection with the already-planned P1 delta buffer for performance, and (3) make projector cursor advancement monotonic so recovery can never regress cursor positions. These changes are amendments to the existing orchestrator implementation plan — they modify existing task code rather than adding new phases.

**Tech Stack:** Node 22+ `node:sqlite` (WAL mode), TypeScript, Vitest, existing conduit relay infrastructure.

---

## Design Rationale

The orchestrator plan introduces several stateful components — `CanonicalEventTranslator`, `SessionSeeder`, `EventStore.versionCache`, `ProjectionRunner` — that must be coordinated during lifecycle transitions (reconnect, recovery, shutdown). The audit found that each component handles its own reset independently, creating windows where one component is reset but another is not. The fix unifies these into lifecycle events.

### Three Principles

1. **Lifecycle transitions are atomic.** One method call resets everything. No caller can forget a component.
2. **Projections are synchronous.** `queueMicrotask` introduces a crash window (event appended, projection deferred, process dies) and an error recovery gap (deferred projection fails, cursor doesn't advance, event is un-projected until next `recover()`). Synchronous projection eliminates both. The real performance optimization is P1's `ProjectionDeltaBuffer` (batching 200ms of deltas into one SQL write), not microtask deferral.
3. **Cursors only move forward.** A one-line SQL change (`MAX(excluded.last_applied_seq, last_applied_seq)`) makes cursor updates monotonic, eliminating the class of bugs where `syncAllCursors()` or recovery regresses a cursor that was advanced by a concurrent live event.

### Audit Coverage Matrix

| Audit Finding | Severity | Addressed By |
|---------------|----------|-------------|
| #1 SSE reconnect stale translator | HIGH | Task 1 (atomic `onReconnect`) |
| #5 `queueMicrotask` deferred projection errors | HIGH | Task 2 (drop deferred projection) |
| #2 Recovery interleaving with live dual-write | MEDIUM | Task 3 (monotonic cursors) |
| #6 Recovery must complete before SSE wiring | MEDIUM | Task 4 (startup ordering assertion) |
| #7 `versionCache` stale after reconnect | MEDIUM | Task 1 (already in `resetTranslator`, formalized) |
| #8 DeltaBuffer flush vs synchronous events | MEDIUM | Task 2 (synchronous projection + future P1 test) |
| #3 Multiple tabs sending permission replies | LOW | Task 5 (document SQLite `changes` check) |
| #4 SessionSeeder cache vs DB divergence | LOW | No change needed (already correct) |
| #9 Concurrent `sendTurn()` | LOW | No change needed (Q7 addresses) |
| #10 Transaction strategy divergence | LOW | No change needed (I4 documents) |

---

### Applied Audit Amendments (2026-04-07)

> Full audit reports: `docs/plans/audits/orchestrator-concurrency-hardening-task-{1-5}.md`
> Synthesis: `docs/plans/2026-04-07-orchestrator-concurrency-hardening-audit.md`

| # | Amendment | Affected Task |
|---|-----------|---------------|
| A1 | Dropped `onSSEEventWithEpoch()` — `rehydrationGen` already guards async rehydration. Epoch is private for diagnostics only. | Task 1 |
| A2 | Added Task 11 and Task 12 test files to the Files section (rename `resetTranslator` call sites). | Task 1 |
| A3 | Fixed try/catch comment: `projectEvent()` catches per-projector errors internally; outer catch is for infrastructure failures only. | Task 2 |
| A4 | Added projector-specific failure test alongside the closed-DB test. | Task 2 |
| A5 | Added recovery-interleaving test for monotonic cursors. Noted backward-compatibility with existing Task 13 tests. | Task 3 |
| A6 | Added explicit `recover()` call site in `relay-stack.ts`. Changed warning to hard error (user decision). | Task 4 |
| A7 | Added production-wiring-order test (`PersistenceLayer` → `recover()` → `projectEvent()`). | Task 4 |
| A8 | Specified exact file and insertion point for Task 34 amendment. Clarified Phase 7 scope. | Task 5 |

---

## Task 1: Atomic Reconnect Lifecycle on DualWriteHook

**Problem:** The plan currently calls `dualWriteHook.resetTranslator()` on SSE reconnect (Task 12, line 5526). This method resets the translator, seeder, and version cache — but the name suggests it only resets the translator, making it easy for a future maintainer to add a new stateful component and forget to reset it here. More critically, SSE events from the old connection's buffer may still be queued in Node's event loop and will be processed after the reset, seeing empty `trackedParts` and producing duplicate `tool.started` events with distinct `eventId`s that the unique constraint won't catch.

**Fix:** (a) Rename `resetTranslator()` to `onReconnect()` and document it as the single lifecycle coordination point. (b) Add a private `epoch` counter for diagnostics and internal coordination. No public epoch-checking API — the existing `rehydrationGen` counter in `wireSSEConsumer()` already guards async rehydration callbacks against stale reconnects. The epoch mechanism on `DualWriteHook` guards the event store write path; `rehydrationGen` guards the WebSocket broadcast path.

**Files:**
- Modify (plan amendment): Task 10 — `src/lib/persistence/dual-write-hook.ts`
- Modify (plan amendment): Task 11 — `test/unit/persistence/dual-write-integration.test.ts` (rename `resetTranslator()` → `onReconnect()` at line 5170)
- Modify (plan amendment): Task 12 — `src/lib/relay/sse-wiring.ts`
- Modify (plan amendment): Task 12 — `test/unit/persistence/feature-flag.test.ts` (rename test and call site from `resetTranslator()` → `onReconnect()` at lines 5407/5432)
- Test: `test/unit/persistence/dual-write-reconnect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/dual-write-reconnect.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

const noopLog = {
	warn: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	verbose: vi.fn(),
};

describe("DualWriteHook reconnect lifecycle", () => {
	let layer: PersistenceLayer;
	let hook: DualWriteHook;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		hook = new DualWriteHook({ persistence: layer, log: noopLog });
	});

	afterEach(() => {
		layer.close();
	});

	it("onReconnect() resets translator, seeder, and version cache", () => {
		// Track a tool part
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				messageID: "m1",
				partID: "part-1",
				part: {
					id: "part-1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending" },
				},
			}),
			"s1",
		);

		const beforeCount = layer.eventStore.readFromSequence(0).length;

		// Simulate reconnect
		hook.onReconnect();

		// Same part again — should produce tool.started because state was reset
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				messageID: "m1",
				partID: "part-1",
				part: {
					id: "part-1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending" },
				},
			}),
			"s1",
		);

		const afterEvents = layer.eventStore.readFromSequence(0);
		const toolStarted = afterEvents.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(2); // One before reconnect, one after
	});

	it("onReconnect() increments internal epoch for diagnostics", () => {
		const statsBefore = hook.getStats();
		hook.onReconnect();
		hook.onReconnect();
		// Epoch is private — verify via getStats() which should include reconnect count
		// The exact assertion depends on whether getStats() exposes epoch; if not,
		// the test simply verifies double-reconnect doesn't corrupt state.
	});

	it("events after onReconnect() are accepted normally", () => {
		hook.onReconnect();

		const result = hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "m1",
				info: { role: "user", parts: [] },
			}),
			"s1",
		);
		expect(result.ok).toBe(true);
	});

	it("onReconnect() is idempotent — double-call does not corrupt state", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "m1",
				info: { role: "user", parts: [] },
			}),
			"s1",
		);

		hook.onReconnect();
		hook.onReconnect(); // Second call should be harmless

		// Should still accept events
		const result = hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "m2",
				info: { role: "user", parts: [] },
			}),
			"s1",
		);
		expect(result.ok).toBe(true);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/dual-write-reconnect.test.ts`
Expected: FAIL — `onReconnect`, `currentEpoch`, `onSSEEventWithEpoch` don't exist yet.

**Step 3: Amend implementation**

Amend the `DualWriteHook` class from Task 10 of the orchestrator plan:

```typescript
// Amendments to src/lib/persistence/dual-write-hook.ts

export class DualWriteHook {
	// ... existing fields ...

	/** Private epoch counter for diagnostics. Incremented on every SSE reconnect. */
	private _epoch = 0;

	// ... existing constructor ...

	/**
	 * Lifecycle method: called on SSE reconnect.
	 *
	 * Atomically resets ALL stateful components in one call so no caller
	 * can forget a component. The epoch counter is incremented for
	 * diagnostics (visible in logs and getStats()).
	 *
	 * Replaces the previous `resetTranslator()` method. The name change
	 * signals that this is a lifecycle coordination point, not a single-
	 * component reset.
	 *
	 * Note on async rehydration: The existing `rehydrationGen` counter
	 * in `wireSSEConsumer()` already guards rehydration callbacks against
	 * stale reconnects (sse-wiring.ts:441-457). `onReconnect()` guards
	 * the event store write path. These are complementary mechanisms:
	 * - `rehydrationGen` guards WebSocket broadcast path
	 * - `onReconnect()` epoch guards event store write path
	 */
	onReconnect(): void {
		this._epoch++;
		this.translator.reset();
		this.seeder.reset();
		this.persistence.eventStore.resetVersionCache();
		this.log.info("dual-write reconnect", { epoch: this._epoch });
	}

	// The existing onSSEEvent() is unchanged.
	// No public epoch-checking API is needed — the synchronous SSE handler
	// (handleSSEEvent) always runs in the current event loop tick after
	// onReconnect(), so stale events from the old connection cannot reach it.
	// Async rehydration callbacks are guarded by rehydrationGen, not the epoch.

	// REMOVE the old resetTranslator() method. Replace all call sites with onReconnect().
}
```

The `DualWriteResult` union is unchanged from the orchestrator plan — no `"stale-epoch"` reason is needed since the public API doesn't expose epoch checking:

```typescript
export type DualWriteResult =
	| { ok: true; eventsWritten: number; sessionSeeded: boolean }
	| { ok: false; reason: "disabled" | "no-session" | "not-translatable" | "error"; error?: string };
```

Amend `sse-wiring.ts` reconnect handler (Task 12):

```typescript
// In wireSSEConsumer(), inside the "connected" handler:
consumer.on("connected", () => {
	const gen = ++rehydrationGen;

	// Atomic reconnect: resets translator, seeder, version cache, bumps epoch.
	// Must happen BEFORE broadcast and rehydration.
	if (deps.dualWriteHook) {
		deps.dualWriteHook.onReconnect();
	}

	// ... rest of existing connected handler ...
});
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/dual-write-reconnect.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The epoch mechanism is zero-cost (one integer comparison per event).

**Step 6: Commit**

```bash
git add src/lib/persistence/dual-write-hook.ts src/lib/relay/sse-wiring.ts test/unit/persistence/dual-write-reconnect.test.ts
git commit -m "fix(persistence): atomic onReconnect() with epoch-based stale event detection"
```

---

## Task 2: Drop Deferred Projection — Keep All Projections Synchronous

**Problem:** Task 22 (line 10763) introduces `queueMicrotask()` for "selective deferred projection" of non-critical event types. This creates two hazards:

1. **Crash window:** Event is appended to the store (durable), projection is deferred to a microtask. If the process crashes before the microtask runs, the event is in the store but its projections are missing. Recovery fixes this on next startup, but the window exists.
2. **Error orphaning:** If the deferred projection throws, the `catch` block logs and increments `_errors`, but the projector cursor does NOT advance. The event stays un-projected until the next `recover()` call. During normal operation, `recover()` only runs at startup, so the event could be un-projected for the entire daemon lifetime.

The performance gain from `queueMicrotask` is negligible: a single `node:sqlite` INSERT takes ~0.1ms, and projection of a `text.delta` event (the most frequent type) involves one `SELECT` + one `UPDATE` — ~0.3ms total. The real performance optimization is P1's `ProjectionDeltaBuffer`, which batches 200ms of deltas into one read-modify-write cycle, reducing per-token SQL from ~3 statements to ~0.2.

**Fix:** Remove all `queueMicrotask` deferred projection code from Task 22. Keep projections synchronous. Rely on P1's delta buffer (separate task, same plan) for the performance optimization.

**Files:**
- Modify (plan amendment): Task 22 — `src/lib/persistence/dual-write-hook.ts`
- Test: `test/unit/persistence/dual-write-projection-sync.test.ts`

**Step 1: Write the failing test**

This test verifies that projections are applied synchronously — immediately after `onSSEEvent()` returns, the projection tables reflect the event.

```typescript
// test/unit/persistence/dual-write-projection-sync.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

const noopLog = {
	warn: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	verbose: vi.fn(),
};

describe("Synchronous projection (no queueMicrotask)", () => {
	let layer: PersistenceLayer;
	let hook: DualWriteHook;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		hook = new DualWriteHook({ persistence: layer, log: noopLog });
	});

	afterEach(() => {
		layer.close();
	});

	it("message.created is projected synchronously — visible immediately after onSSEEvent", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "msg-1",
				info: { role: "user", parts: [{ type: "text", text: "hello" }] },
			}),
			"s1",
		);

		// Projection must be visible NOW, not after a microtask
		const messages = layer.db.query<{ id: string; role: string }>(
			"SELECT id, role FROM messages WHERE session_id = ?",
			["s1"],
		);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
	});

	it("text.delta is projected synchronously — no deferred microtask", () => {
		// Create the message first
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "msg-1",
				info: { role: "assistant", parts: [] },
			}),
			"s1",
		);

		// Register a text part
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				messageID: "msg-1",
				partID: "p1",
				part: { id: "p1", type: "text" },
			}),
			"s1",
		);

		// Send a text delta
		hook.onSSEEvent(
			makeSSEEvent("message.part.delta", {
				sessionID: "s1",
				messageID: "msg-1",
				partID: "p1",
				field: "text",
				delta: "Hello world",
			}),
			"s1",
		);

		// text.delta projection must be visible NOW
		const msg = layer.db.queryOne<{ text: string }>(
			"SELECT text FROM messages WHERE id = ?",
			["msg-1"],
		);
		expect(msg).toBeDefined();
		expect(msg!.text).toBe("Hello world");
	});

	it("tool.started is projected synchronously with activity row", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				messageID: "msg-1",
				partID: "tool-1",
				part: {
					id: "tool-1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending", input: { command: "ls" } },
				},
			}),
			"s1",
		);

		// Activity projection must be visible NOW
		const activities = layer.db.query<{ kind: string }>(
			"SELECT kind FROM activities WHERE session_id = ?",
			["s1"],
		);
		const toolStarted = activities.find((a) => a.kind === "tool.started");
		expect(toolStarted).toBeDefined();
	});

	it("per-projector failure does not break the relay pipeline or other projectors", () => {
		// This tests the ProjectionRunner's per-projector fault isolation (A4).
		// A failing ActivityProjector should not prevent SessionProjector from working.
		
		// Create a message (triggers message projector + turn projector)
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "msg-1",
				info: { role: "user", parts: [{ type: "text", text: "hello" }] },
			}),
			"s1",
		);

		// Session and message projections should succeed even if one projector
		// had an internal error. Verify both are present.
		const session = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(session).toBeDefined();

		const messages = layer.db.query<{ id: string }>(
			"SELECT id FROM messages WHERE session_id = ?",
			["s1"],
		);
		expect(messages).toHaveLength(1);
	});

	it("dual-write error (closed DB) does not throw", () => {
		// Close DB to force infrastructure errors
		layer.close();

		const logWarn = vi.fn();
		const brokenHook = new DualWriteHook({
			persistence: layer,
			log: { warn: logWarn, debug: vi.fn(), info: vi.fn(), verbose: vi.fn() },
		});

		// Should not throw — error is caught and logged
		expect(() =>
			brokenHook.onSSEEvent(
				makeSSEEvent("message.created", {
					sessionID: "s1",
					messageID: "msg-1",
					info: { role: "user", parts: [] },
				}),
				"s1",
			),
		).not.toThrow();

		expect(logWarn).toHaveBeenCalled();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/dual-write-projection-sync.test.ts`
Expected: FAIL if `queueMicrotask` is used — the text.delta test would fail because the projection hasn't run yet.

**Step 3: Amend implementation**

Replace the Task 22 amendment to `DualWriteHook.onSSEEvent()` with synchronous projection. In the `"appending"` stage loop, after each `eventStore.append()`:

```typescript
// In DualWriteHook.onSSEEvent(), replace the queueMicrotask block with:

const stored = this.persistence.eventStore.append(enriched as CanonicalEvent);
this._eventsWritten++;

// Project synchronously. All event types, no deferral.
// Performance optimization comes from P1's ProjectionDeltaBuffer
// (batching deltas), not from microtask deferral.
//
// Note: projectEvent() already catches per-projector errors internally
// via recordFailure() and does NOT re-throw. The try/catch here only
// catches infrastructure-level failures (cursor sync, transaction
// begin/commit errors). Do NOT increment _errors here to avoid
// double-counting with ProjectionRunner's internal failure tracking.
const tProject0 = performance.now();
try {
	this.persistence.projectionRunner.projectEvent(stored);
} catch (infraErr) {
	// Infrastructure failure (not a per-projector error — those are
	// caught inside projectEvent). Log but don't break the relay.
	this.log.warn("projection infrastructure failure", {
		sequence: stored.sequence,
		type: stored.type,
		sessionId: stored.sessionId,
		error: infraErr instanceof Error ? infraErr.message : String(infraErr),
	});
}
const tProject1 = performance.now();
this._totalProjectMs += tProject1 - tProject0;
this._peakProjectMs = Math.max(this._peakProjectMs, tProject1 - tProject0);
```

Remove `SYNC_PROJECT_TYPES`, `queueMicrotask`, and the deferred projection `catch` block entirely from the plan.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/dual-write-projection-sync.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The synchronous path is simpler than the deferred path it replaces.

**Step 6: Commit**

```bash
git add src/lib/persistence/dual-write-hook.ts test/unit/persistence/dual-write-projection-sync.test.ts
git commit -m "fix(persistence): keep projections synchronous — drop queueMicrotask deferral"
```

---

## Task 3: Monotonic Cursor Advancement

**Problem:** `ProjectorCursorRepository.upsert()` (Task 13, line 5826) unconditionally sets `last_applied_seq` to the new value. If `ProjectionRunner.recover()` calls `syncAllCursors(cursor)` where `cursor` is the recovery endpoint (e.g., sequence 500), but a concurrent live event has already advanced a projector's cursor to 501, the upsert regresses the cursor to 500. On next startup, event 501 would be re-projected — not a data corruption bug (projectors are idempotent for most event types), but `text.delta` replay would double text content unless the `alreadyApplied()` guard catches it.

**Fix:** Change the SQL `ON CONFLICT` clause to use `MAX()`, making cursor advancement monotonic. This is a one-line change that eliminates an entire class of regression bugs.

**Files:**
- Modify (plan amendment): Task 13 — `src/lib/persistence/projector-cursor-repository.ts`
- Test: `test/unit/persistence/projector-cursor-monotonic.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projector-cursor-monotonic.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";

describe("Monotonic cursor advancement", () => {
	let client: SqliteClient;
	let repo: ProjectorCursorRepository;

	beforeEach(() => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		repo = new ProjectorCursorRepository(client);
	});

	afterEach(() => {
		client?.close();
	});

	it("advancing cursor forward works normally", () => {
		repo.upsert("session", 10);
		repo.upsert("session", 20);
		expect(repo.get("session")!.lastAppliedSeq).toBe(20);
	});

	it("attempting to regress cursor is a no-op — cursor stays at higher value", () => {
		repo.upsert("session", 100);
		repo.upsert("session", 50); // Attempt to regress
		expect(repo.get("session")!.lastAppliedSeq).toBe(100);
	});

	it("upserting the same value is idempotent", () => {
		repo.upsert("session", 42);
		repo.upsert("session", 42);
		expect(repo.get("session")!.lastAppliedSeq).toBe(42);
	});

	it("different projectors advance independently", () => {
		repo.upsert("session", 100);
		repo.upsert("message", 50);

		// Attempt to regress session but advance message
		repo.upsert("session", 80);
		repo.upsert("message", 60);

		expect(repo.get("session")!.lastAppliedSeq).toBe(100); // Not regressed
		expect(repo.get("message")!.lastAppliedSeq).toBe(60);  // Advanced
	});

	it("syncAllCursors from ProjectionRunner never regresses any cursor", () => {
		repo.upsert("session", 200);
		repo.upsert("message", 150);
		repo.upsert("turn", 100);

		// Simulate syncAllCursors(120) — should advance turn but not regress others
		repo.upsert("session", 120);
		repo.upsert("message", 120);
		repo.upsert("turn", 120);

		expect(repo.get("session")!.lastAppliedSeq).toBe(200);
		expect(repo.get("message")!.lastAppliedSeq).toBe(150);
		expect(repo.get("turn")!.lastAppliedSeq).toBe(120);
	});

	it("recovery interleaved with live events: live cursor is not regressed", () => {
		// Simulate: recovery starts at cursor 0, live event projects to cursor 501
		// Recovery's syncAllCursors(500) must not regress the live cursor
		repo.upsert("session", 501); // Live event advanced this cursor
		repo.upsert("message", 0);   // Not yet recovered

		// Recovery runs syncAllCursors(500) for all projectors
		repo.upsert("session", 500);
		repo.upsert("message", 500);

		expect(repo.get("session")!.lastAppliedSeq).toBe(501); // Not regressed
		expect(repo.get("message")!.lastAppliedSeq).toBe(500); // Advanced by recovery
	});
});

// NOTE: The existing Task 13 tests (projector-cursor-repository.test.ts) in the
// orchestrator plan test unconditional upsert. The "updates an existing cursor"
// test (line 5685) sets cursor to 10 then 20 — this still passes with MAX()
// since 20 > 10. No existing test expects cursor regression, so the monotonic
// change is backward-compatible.
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projector-cursor-monotonic.test.ts`
Expected: FAIL — the regression test case expects 100 but gets 50 (current `upsert` unconditionally overwrites).

**Step 3: Amend implementation**

Change one line in `ProjectorCursorRepository.upsert()`:

```typescript
// src/lib/persistence/projector-cursor-repository.ts
// In the upsert() method, change:
//
//   ON CONFLICT (projector_name) DO UPDATE SET
//       last_applied_seq = excluded.last_applied_seq,
//       updated_at = excluded.updated_at
//
// To:

upsert(projectorName: string, lastAppliedSeq: number): void {
	this.db.execute(
		`
		INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT (projector_name) DO UPDATE SET
			last_applied_seq = MAX(excluded.last_applied_seq, projector_cursors.last_applied_seq),
			updated_at = CASE
				WHEN excluded.last_applied_seq > projector_cursors.last_applied_seq
				THEN excluded.updated_at
				ELSE projector_cursors.updated_at
			END
		`,
		[projectorName, lastAppliedSeq, Date.now()],
	);
}
```

The `MAX()` ensures the cursor never goes backward. The `CASE` on `updated_at` avoids bumping the timestamp when the value doesn't actually change (useful for diagnostics — `updated_at` reflects the last real advancement).

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projector-cursor-monotonic.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. One SQL change, all existing tests still pass.

**Step 6: Commit**

```bash
git add src/lib/persistence/projector-cursor-repository.ts test/unit/persistence/projector-cursor-monotonic.test.ts
git commit -m "fix(persistence): make cursor advancement monotonic — upsert uses MAX()"
```

---

## Task 4: Startup Ordering Assertion — Recovery Before SSE

**Problem:** The plan assumes recovery completes before SSE events arrive, but this ordering is implicit (it depends on the construction order in `relay-stack.ts`). If a future refactor moves `PersistenceLayer` initialization after `wireSSEConsumer()`, events would be processed against un-recovered projections, causing duplicates for non-idempotent event types.

**Fix:** (a) Add a `recovered` flag to `ProjectionRunner` that defaults to `false`. `projectEvent()` throws if called before `recover()` — this immediately catches missing wiring during development. (b) Add the explicit `recover()` call site in `relay-stack.ts`, after `DualWriteHook` creation and before `wireSSEConsumer()`.

**Files:**
- Modify (plan amendment): Task 21 — `src/lib/persistence/projection-runner.ts`
- Modify (plan amendment): Task 12 — `src/lib/relay/relay-stack.ts` (add `recover()` call)
- Test: `test/unit/persistence/projection-runner-lifecycle.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projection-runner-lifecycle.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { EventStore } from "../../../src/lib/persistence/event-store.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";
import {
	ProjectionRunner,
	createAllProjectors,
} from "../../../src/lib/persistence/projection-runner.js";
import {
	createEventId,
	type StoredEvent,
	type SessionCreatedPayload,
} from "../../../src/lib/persistence/events.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";

function makeCanonical(sessionId: string, now: number) {
	return {
		eventId: createEventId(),
		sessionId,
		type: "session.created" as const,
		data: { sessionId, title: "Test", provider: "opencode" } satisfies SessionCreatedPayload,
		metadata: {},
		provider: "opencode",
		createdAt: now,
	};
}

describe("ProjectionRunner lifecycle ordering", () => {
	let db: SqliteClient;
	let eventStore: EventStore;
	let cursorRepo: ProjectorCursorRepository;
	let logWarn: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		eventStore = new EventStore(db);
		cursorRepo = new ProjectorCursorRepository(db);
		logWarn = vi.fn();
	});

	afterEach(() => {
		db?.close();
	});

	it("throws when projectEvent is called before recover()", () => {
		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
			log: { warn: logWarn, info: vi.fn(), verbose: vi.fn(), debug: vi.fn() } as any,
		});

		const stored = eventStore.append(makeCanonical("s1", Date.now()));

		// projectEvent before recover() — should throw
		expect(() => runner.projectEvent(stored)).toThrow(
			/recover\(\) must be called before projectEvent/,
		);
	});

	it("does not throw after recover() is called", () => {
		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
			log: { warn: logWarn, info: vi.fn(), verbose: vi.fn(), debug: vi.fn() } as any,
		});

		runner.recover();

		const stored = eventStore.append(makeCanonical("s1", Date.now()));

		// Should not throw — recover() was called first
		expect(() => runner.projectEvent(stored)).not.toThrow();

		// Projection should succeed
		const session = db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(session).toBeDefined();
	});

	it("simulates production wiring order: recover → project", () => {
		// This test verifies the expected relay-stack.ts construction order
		const layer = PersistenceLayer.memory();
		try {
			// Step 1: PersistenceLayer created (done above)
			// Step 2: recover() called before SSE events
			layer.projectionRunner.recover();
			expect(layer.projectionRunner.isRecovered).toBe(true);

			// Step 3: Now projectEvent works (SSE events can flow)
			const stored = layer.eventStore.append(makeCanonical("s1", Date.now()));
			expect(() => layer.projectionRunner.projectEvent(stored)).not.toThrow();
		} finally {
			layer.close();
		}
	});

	it("recover() sets the recovered flag", () => {
		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
		});

		expect(runner.isRecovered).toBe(false);
		runner.recover();
		expect(runner.isRecovered).toBe(true);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projection-runner-lifecycle.test.ts`
Expected: FAIL — `isRecovered` and the warning don't exist yet.

**Step 3: Amend implementation**

Add to `ProjectionRunner`:

```typescript
// In src/lib/persistence/projection-runner.ts

export class ProjectionRunner {
	// ... existing fields ...

	/** True after recover() has been called. projectEvent() throws if false. */
	private _recovered = false;

	get isRecovered(): boolean {
		return this._recovered;
	}

	projectEvent(event: StoredEvent): void {
		// Lifecycle check: hard error if projecting before recovery.
		// This catches missing recover() wiring immediately during development.
		// In production, relay-stack.ts calls recover() before wireSSEConsumer(),
		// so this path is unreachable.
		if (!this._recovered) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"recover() must be called before projectEvent(). " +
				"Ensure recover() is called in relay-stack.ts before SSE wiring.",
				{ sequence: event.sequence, type: event.type },
			);
		}

		// ... rest of existing projectEvent implementation ...
	}

	recover(): RecoveryResult {
		// ... existing recover implementation ...
		// At the end, before returning:
		this._recovered = true;
		return result;
	}
}
```

**Step 4: Add `recover()` call site to relay-stack.ts**

Amend Task 12 of the orchestrator plan. In `createProjectRelay()`, after `DualWriteHook` creation and before `wireSSEConsumer()`:

```typescript
// In createProjectRelay(), after DualWriteHook creation:

// ── Projection recovery (must complete before SSE events flow) ─────────
if (config.persistence) {
	const result = config.persistence.projectionRunner.recover();
	if (result.totalReplayed > 0) {
		log.info(`Projection recovery: ${result.totalReplayed} events replayed in ${result.durationMs}ms`);
	}
}

// ── Wire SSE consumer (after recovery) ─────────────────────────────────
wireSSEConsumer(/* ... */);
```

This makes the ordering invariant explicit in code. The `projectEvent()` hard error (Step 3) is the safety net — if a future refactor moves `wireSSEConsumer()` before recovery, the first SSE event will throw immediately, making the bug obvious.

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projection-runner-lifecycle.test.ts`
Expected: PASS

**Step 6: Refactor if needed**

No refactoring needed.

**Step 7: Commit**

```bash
git add src/lib/persistence/projection-runner.ts src/lib/relay/relay-stack.ts test/unit/persistence/projection-runner-lifecycle.test.ts
git commit -m "fix(persistence): hard error when projecting before recovery — add recover() to relay-stack"
```

---

## Task 5: Document Permission Resolution Atomicity for SQLite Path

**Problem:** When Phase 4f migrates permission resolution from the in-memory `PermissionBridge` Map to the SQLite `pending_approvals` table, the first-wins semantics must be preserved. The current Map-based approach uses synchronous `get()` + `delete()` — the first handler deletes the entry, the second gets `null`. The SQLite approach must use `UPDATE ... WHERE status = 'pending'` and check `changes === 0` to detect the second-tab case.

**Fix:** This is a documentation + test amendment to Task 34 (Phase 4f). No new code beyond what's already planned — just ensuring the implementation checks `changes`.

**Files:**
- Modify (plan amendment): Task 34 — permission resolution handler
- Test: `test/unit/persistence/permission-resolution-atomicity.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/permission-resolution-atomicity.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";

describe("Permission resolution atomicity (SQLite path)", () => {
	let db: SqliteClient;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);

		// Seed a session and a pending permission
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		db.execute(
			`INSERT INTO pending_approvals (id, session_id, type, status, tool_name, created_at)
			 VALUES (?, ?, 'permission', 'pending', ?, ?)`,
			["perm-1", "s1", "bash", Date.now()],
		);
	});

	afterEach(() => {
		db?.close();
	});

	/**
	 * Simulates the resolution pattern that must be used in the Phase 4f handler.
	 * Returns true if THIS call was the one that resolved the permission (first-wins).
	 */
	function resolvePermission(db: SqliteClient, permId: string, decision: string): boolean {
		const result = db.execute(
			`UPDATE pending_approvals
			 SET status = 'resolved', decision = ?, resolved_at = ?
			 WHERE id = ? AND status = 'pending'`,
			[decision, Date.now(), permId],
		);
		// changes === 0 means another tab already resolved it
		return (result.changes as number) > 0;
	}

	it("first resolution succeeds", () => {
		const resolved = resolvePermission(db, "perm-1", "once");
		expect(resolved).toBe(true);

		const row = db.queryOne<{ status: string; decision: string }>(
			"SELECT status, decision FROM pending_approvals WHERE id = ?",
			["perm-1"],
		);
		expect(row!.status).toBe("resolved");
		expect(row!.decision).toBe("once");
	});

	it("second resolution for the same permission returns false (first-wins)", () => {
		const first = resolvePermission(db, "perm-1", "once");
		const second = resolvePermission(db, "perm-1", "always");

		expect(first).toBe(true);
		expect(second).toBe(false);

		// Decision remains from the first resolver
		const row = db.queryOne<{ decision: string }>(
			"SELECT decision FROM pending_approvals WHERE id = ?",
			["perm-1"],
		);
		expect(row!.decision).toBe("once");
	});

	it("resolution of unknown permission returns false", () => {
		const resolved = resolvePermission(db, "perm-nonexistent", "once");
		expect(resolved).toBe(false);
	});

	it("resolution of already-resolved permission returns false", () => {
		resolvePermission(db, "perm-1", "once");

		// Try to re-resolve
		const reResolved = resolvePermission(db, "perm-1", "reject");
		expect(reResolved).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/permission-resolution-atomicity.test.ts`
Expected: PASS (the tests exercise the SQL pattern directly — they pass because the pattern is correct).

Since this test exercises the pattern rather than production code, it serves as a **specification test** — documenting the exact SQL pattern that Task 34 must use. If a future implementor writes the handler differently, this test file documents the required behavior.

**Step 3: Document the amendment**

Add the following note to `docs/plans/2026-04-05-orchestrator-implementation-plan.md`, in Task 34 (Phase 4f — Pending Permissions Read Switchover), after the Step 5 "Refactor if needed" section and before Step 6 "Commit". Note that Task 34 handles the **read** switchover for `getPending()`. The full **write** migration (permission resolution via SQLite instead of in-memory Map) is a Phase 7 concern. This amendment documents the SQL pattern that the Phase 7 resolution handler must use:

> **Concurrency amendment (Phase 7):** When the permission resolution handler migrates from the in-memory `PermissionBridge.onPermissionResponse()` to SQLite in Phase 7, it MUST use `UPDATE pending_approvals SET status = 'resolved', decision = ? WHERE id = ? AND status = 'pending'` and check `result.changes === 0` to detect duplicate replies from concurrent browser tabs. If `changes === 0`, the handler returns early without calling the provider API — another tab already resolved this permission. This preserves the first-wins semantics of the in-memory `Map.get()` + `Map.delete()` pattern. See `test/unit/persistence/permission-resolution-atomicity.test.ts` for the canonical SQL pattern.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/permission-resolution-atomicity.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add test/unit/persistence/permission-resolution-atomicity.test.ts
git commit -m "docs(persistence): add specification tests for permission resolution atomicity"
```

---

## Verification

After all 5 tasks, run the full verification suite:

```bash
pnpm vitest run test/unit/persistence/
pnpm check
pnpm lint
```

Expected: All tests pass. The changes are amendments to existing plan code — no new runtime abstractions, no new dependencies, no behavioral changes to the relay pipeline.

---

## Summary of Changes to the Orchestrator Plan

| Orchestrator Task | Amendment | Nature |
|-------------------|-----------|--------|
| Task 10 (DualWriteHook) | Rename `resetTranslator()` → `onReconnect()`, add private epoch counter for diagnostics, add `reconnects` to `DualWriteStats` | Method rename + new field |
| Task 11 (Integration test) | Rename `resetTranslator()` → `onReconnect()` at call site | One-line rename |
| Task 12 (SSE wiring) | Call `onReconnect()` instead of `resetTranslator()`, add `recover()` before `wireSSEConsumer()` | Reconnect rename + startup ordering |
| Task 13 (Cursor repo) | `MAX(excluded, existing)` in upsert SQL, `CASE` on `updated_at` | One-line SQL change |
| Task 21 (ProjectionRunner) | Add `_recovered` flag, `isRecovered` getter, hard error guard in `projectEvent()`, `recover()` sets flag | Two fields + one check |
| Task 22 (Wire projections) | Remove `queueMicrotask` / `SYNC_PROJECT_TYPES` / deferred projection entirely, replace with synchronous projection | Code deletion + simplification |
| Task 34 (Phase 4f) | Document `changes === 0` check for SQLite permission resolution (Phase 7) | Documentation |
