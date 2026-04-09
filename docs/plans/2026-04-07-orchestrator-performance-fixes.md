# Orchestrator Performance & Scalability Fixes

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix 8 performance and scalability issues identified in the orchestrator implementation plan audit, ranging from a hot-path regression (50 unnecessary SELECTs/sec) to event-loop blocking during eviction and recovery.

**Architecture:** All fixes are amendments to existing plan tasks — they modify code already specified in `docs/plans/2026-04-05-orchestrator-implementation-plan.md` and `docs/plans/2026-04-07-orchestrator-performance-scalability-recommendations-v2.md`. No new architectural concepts. Each fix is self-contained and independently applicable.

**Tech Stack:** Node 22+ `node:sqlite` (WAL mode), TypeScript, Vitest.

**Parent plan:** `docs/plans/2026-04-05-orchestrator-implementation-plan.md`

---

## Audit Amendments (2026-04-07)

> Full audit: `docs/plans/2026-04-07-orchestrator-performance-fixes-audit.md`
> Per-task reports: `docs/plans/audits/orchestrator-performance-fixes-task-{1,2,3,4}.md`, `docs/plans/audits/orchestrator-performance-fixes-tasks-6-7.md`

| # | Finding | Amendment Applied |
|---|---------|-------------------|
| T1-1 | SQLite does not skip COALESCE subquery on ON CONFLICT path | Corrected prose and code comments in Task 1 |
| T1-7 | No replay test for sort_order stability | Added `thinking.delta` replay test to Task 1 |
| T2-1 | Test asserts `statementCacheSize === 4` (impossible with `maxCacheSize: 3`) | Rewrote test with `hasCachedStatement()` approach |
| T2-2 | Test doesn't distinguish LRU from FIFO | Rewrote test to assert which specific statement was evicted |
| T3-1 | Async test expects wrong batch/yield count for divisible totals | Changed to non-divisible count (190), added separate divisible test |
| T3-3 | Uses `events.rowid` instead of `events.sequence` | Replaced with `sequence` for consistency |
| T3-8 | File named `eviction.ts` vs parent's `event-store-eviction.ts` | Added rename note |
| T3-10 | Missing receipt edge-case test | Added test for time-based vs session-based eviction |
| T4-1 | `ProjectionRunnerOptions` should be `ProjectionRunnerConfig` | Renamed, noted `recoveryBatchSize` addition |
| T4-2 | `recoverAsync()` return type incompatible with `RecoveryResult` | Defined `AsyncRecoveryResult` interface |
| T4-4 | "Same end state" test is bogus | Replaced with CH4 guard test |
| T4-5 | No CH4 guard test for `recoverAsync()` | Added `projectEvent throws before recoverAsync` test |
| T4-7 | `seedSessionAndEvents()` missing `message.created` event | Added message seed before text.delta loop |
| T6-1 | Parent plan test uses removed `beforeMessageId` | Added NOTE comment about updating parent plan test |
| T6-2 | Dropped `LIMIT + 1` over-fetch breaks `hasMore` | Restored `limit + 1` in both query branches |
| T6-3 | Cursor query returns DESC but other branches return ASC | Wrapped in subquery with ASC re-sort |
| T7-4 | PRAGMA type annotations incorrect | Fixed to single-column result types |
| T7-5 | Tests missing session seed (FK violation) | Added session INSERT before event seeding |
| T7-6 | `getHealthCheck()` duplicates existing `health()` | Merged into existing `health()` method (user decision) |

---

## Plan Overview

| Task | Issue | Severity | Amends |
|------|-------|----------|--------|
| 1 | `getNextSortOrder()` called on every delta, not just part creation | HIGH | Task 16 (MessageProjector) |
| 2 | Statement cache is FIFO, not LRU | LOW | Task 1 (SqliteClient) |
| 3 | Eviction DELETE + VACUUM block event loop for seconds | HIGH | Task 51 / P6 (EventStoreEviction) |
| 4 | Recovery blocks event loop for 30+ seconds at 100K events | MEDIUM | Task 21 (ProjectionRunner) |
| 5 | `command_receipts` grows unbounded | LOW | Task 51 (EventStoreEviction) |
| 6 | Pagination SQL uses tuple comparison SQLite doesn't optimize | MEDIUM | Task 23 (ReadQueryService) |
| 7 | No eviction until Phase 7 — database grows ~360MB/day | HIGH | Task 22.5 (PersistenceDiagnostics) |
| 8 | P1 doc incorrectly claims `text \|\| ?` is O(1) | DOC | v2 recommendations doc |

---

## Task 1: Eliminate `getNextSortOrder()` from the Delta Hot Path

**Problem:** `getNextSortOrder()` runs `SELECT MAX(sort_order) FROM message_parts WHERE message_id = ?` on every `text.delta`, `thinking.delta`, `thinking.start`, and `tool.started` event. The plan comment claims "Only called on part-creation events... not on subsequent deltas for existing parts" — but this is wrong. The UPSERT's VALUES clause evaluates `getNextSortOrder()` *before* SQLite determines whether the INSERT or ON CONFLICT path will execute. At 50 tokens/sec, this adds 50 unnecessary aggregate queries per second.

**Fix:** Move `sort_order` computation into the SQL itself via a `COALESCE` subquery in the VALUES clause. On the ON CONFLICT path, `sort_order` is not in the `DO UPDATE SET` clause, so the computed value is discarded. Note: SQLite still evaluates the subquery on every execution (it evaluates all VALUES expressions before conflict detection), but it runs within the same prepared statement — eliminating the separate `db.queryOne()` round-trip that `getNextSortOrder()` required. The aggregate `MAX(sort_order)` hits the covering index `idx_message_parts_message (message_id, sort_order)` and costs ~10μs.

**Files:**
- Modify (plan amendment): Task 16 — `src/lib/persistence/projectors/message-projector.ts`
- Test: `test/unit/persistence/projectors/message-projector.test.ts` (existing tests, add new benchmark-style test)

**Step 1: Write the failing test**

Add to the existing `message-projector.test.ts`:

```typescript
// Append to test/unit/persistence/projectors/message-projector.test.ts

describe("sort_order assignment", () => {
	it("assigns incrementing sort_order to new parts", () => {
		projector.project(
			makeStored("message.created", "s1", {
				messageId: "m1", role: "assistant", sessionId: "s1",
			} satisfies MessageCreatedPayload, 1),
			db,
		);

		// Three different parts
		projector.project(
			makeStored("text.delta", "s1", {
				messageId: "m1", partId: "p1", text: "A",
			} satisfies TextDeltaPayload, 2),
			db,
		);
		projector.project(
			makeStored("thinking.start", "s1", {
				messageId: "m1", partId: "t1",
			} satisfies ThinkingStartPayload, 3),
			db,
		);
		projector.project(
			makeStored("tool.started", "s1", {
				messageId: "m1", partId: "tool1",
				toolName: "bash", callId: "c1", input: {},
			} satisfies ToolStartedPayload, 4),
			db,
		);

		const parts = db.query<{ id: string; sort_order: number }>(
			"SELECT id, sort_order FROM message_parts WHERE message_id = ? ORDER BY sort_order",
			["m1"],
		);
		expect(parts).toHaveLength(3);
		expect(parts[0]!.id).toBe("p1");
		expect(parts[0]!.sort_order).toBe(0);
		expect(parts[1]!.id).toBe("t1");
		expect(parts[1]!.sort_order).toBe(1);
		expect(parts[2]!.id).toBe("tool1");
		expect(parts[2]!.sort_order).toBe(2);
	});

	it("does not change sort_order on subsequent deltas for the same part", () => {
		projector.project(
			makeStored("message.created", "s1", {
				messageId: "m1", role: "assistant", sessionId: "s1",
			} satisfies MessageCreatedPayload, 1),
			db,
		);

		projector.project(
			makeStored("text.delta", "s1", {
				messageId: "m1", partId: "p1", text: "Hello ",
			} satisfies TextDeltaPayload, 2),
			db,
		);
		projector.project(
			makeStored("text.delta", "s1", {
				messageId: "m1", partId: "p1", text: "World",
			} satisfies TextDeltaPayload, 3),
			db,
		);

		const parts = db.query<{ id: string; sort_order: number; text: string }>(
			"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
			["m1"],
		);
		expect(parts).toHaveLength(1);
		expect(parts[0]!.sort_order).toBe(0); // unchanged from first insert
		expect(parts[0]!.text).toBe("Hello World");
	});

	it("sort_order is stable when thinking.delta is replayed with replaying=true", () => {
		projector.project(
			makeStored("message.created", "s1", {
				messageId: "m1", role: "assistant", sessionId: "s1",
			} satisfies MessageCreatedPayload, 1),
			db,
		);

		const thinkDelta = makeStored("thinking.delta", "s1", {
			messageId: "m1", partId: "t1", text: "Hmm...",
		} satisfies ThinkingDeltaPayload, 2);
		projector.project(thinkDelta, db);

		// Replay the same event with replaying=true — should be skipped by alreadyApplied
		projector.project(thinkDelta, db, { replaying: true });

		const parts = db.query<{ id: string; sort_order: number; text: string }>(
			"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
			["m1"],
		);
		expect(parts).toHaveLength(1);
		expect(parts[0]!.sort_order).toBe(0);
		expect(parts[0]!.text).toBe("Hmm..."); // not doubled
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/message-projector.test.ts`
Expected: FAIL — the test file doesn't exist yet (plan hasn't been implemented). When it is implemented, these tests verify the fix.

**Step 3: Amend the MessageProjector implementation**

Replace all calls to `this.getNextSortOrder(db, event.data.messageId)` with an inline SQL subquery, and delete the `getNextSortOrder` method.

The `text.delta` handler becomes:

```typescript
if (isEventType(event, "text.delta")) {
	if (ctx?.replaying && this.alreadyApplied(db, event.data.messageId, event.sequence)) return;

	// (P1, Perf-Fix-1) sort_order computed in SQL, not Node.js.
	// SQLite evaluates the COALESCE subquery on every execution (including
	// the ON CONFLICT path), but sort_order is not in DO UPDATE SET, so
	// the value is discarded on updates. The key benefit: eliminating a
	// separate db.queryOne() round-trip per delta (~50/sec during streaming).
	// The subquery hits the covering index idx_message_parts_message and
	// costs ~10μs.
	db.execute(
		`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
		 VALUES (?, ?, 'text', ?,
		     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
		     ?, ?)
		 ON CONFLICT (id) DO UPDATE SET
		     text = message_parts.text || excluded.text,
		     updated_at = excluded.updated_at`,
		[
			event.data.partId,
			event.data.messageId,
			event.data.text,
			event.data.messageId,  // for the COALESCE subquery
			event.createdAt,
			event.createdAt,
		],
	);

	db.execute(
		`UPDATE messages SET text = text || ?, last_applied_seq = ?, updated_at = ? WHERE id = ?`,
		[event.data.text, event.sequence, event.createdAt, event.data.messageId],
	);
	return;
}
```

Apply the same pattern to `thinking.start`:

```typescript
if (isEventType(event, "thinking.start")) {
	db.execute(
		`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
		 VALUES (?, ?, 'thinking', '',
		     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
		     ?, ?)
		 ON CONFLICT (id) DO NOTHING`,
		[
			event.data.partId,
			event.data.messageId,
			event.data.messageId,
			event.createdAt,
			event.createdAt,
		],
	);
	db.execute(
		"UPDATE messages SET updated_at = ? WHERE id = ?",
		[event.createdAt, event.data.messageId],
	);
	return;
}
```

Apply to `thinking.delta`:

```typescript
if (isEventType(event, "thinking.delta")) {
	if (ctx?.replaying && this.alreadyApplied(db, event.data.messageId, event.sequence)) return;

	db.execute(
		`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
		 VALUES (?, ?, 'thinking', ?,
		     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
		     ?, ?)
		 ON CONFLICT (id) DO UPDATE SET
		     text = message_parts.text || excluded.text,
		     updated_at = excluded.updated_at`,
		[
			event.data.partId,
			event.data.messageId,
			event.data.text,
			event.data.messageId,
			event.createdAt,
			event.createdAt,
		],
	);
	db.execute(
		"UPDATE messages SET last_applied_seq = ?, updated_at = ? WHERE id = ?",
		[event.sequence, event.createdAt, event.data.messageId],
	);
	return;
}
```

Apply to `tool.started`:

```typescript
if (isEventType(event, "tool.started")) {
	db.execute(
		`INSERT INTO message_parts
		 (id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at)
		 VALUES (?, ?, 'tool', ?, ?, ?, 'started',
		     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
		     ?, ?)
		 ON CONFLICT (id) DO NOTHING`,
		[
			event.data.partId,
			event.data.messageId,
			event.data.toolName,
			event.data.callId,
			encodeJson(event.data.input),
			event.data.messageId,
			event.createdAt,
			event.createdAt,
		],
	);
	db.execute(
		"UPDATE messages SET updated_at = ? WHERE id = ?",
		[event.createdAt, event.data.messageId],
	);
	return;
}
```

**Delete the `getNextSortOrder` method entirely.** It is no longer called.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/message-projector.test.ts`
Expected: PASS — all existing tests plus the new sort_order tests pass.

**Step 5: Refactor if needed**

No refactoring needed. The subquery is the standard SQLite pattern for auto-incrementing within a group.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/message-projector.ts test/unit/persistence/projectors/message-projector.test.ts
git commit -m "perf(persistence): move sort_order computation into SQL — eliminate getNextSortOrder() hot-path SELECT"
```

---

## Task 2: Make Statement Cache LRU-by-Access

**Problem:** The `SqliteClient` statement cache evicts the oldest entry by insertion order. A frequently-used statement inserted early can be evicted before a rarely-used statement inserted recently. ES6 `Map` iteration order is insertion order, not access order.

**Fix:** On cache hit, delete and re-insert the entry to move it to the end of the iteration order. This makes the Map behave as an LRU cache with zero additional data structures. Add a `hasCachedStatement(sql)` test-only method to verify which statement was evicted.

**Files:**
- Modify (plan amendment): Task 1 — `src/lib/persistence/sqlite-client.ts`
- Test: `test/unit/persistence/sqlite-client.test.ts` (add LRU test)

**Step 1: Write the failing test**

First, add a test-only method to `SqliteClient`:

```typescript
/** Test-only: check if a statement is in the cache. */
hasCachedStatement(sql: string): boolean {
	return this.stmtCache.has(sql);
}
```

Then add to the existing `sqlite-client.test.ts`:

```typescript
it("evicts least-recently-used statement, not least-recently-inserted", () => {
	client = SqliteClient.memory({ maxCacheSize: 3 });
	client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");

	// Fill cache to capacity (CREATE TABLE is entry 1)
	const qA = "SELECT 1";
	const qB = "SELECT 2";
	const qC = "SELECT 3";
	client.query(qA); // cache: [CREATE, qA] → size 2
	client.query(qB); // cache: [CREATE, qA, qB] → size 3 (full)
	client.query(qC); // cache: [qA, qB, qC] → size 3 (CREATE evicted)
	expect(client.statementCacheSize).toBe(3);
	expect(client.hasCachedStatement("CREATE TABLE t (id INTEGER PRIMARY KEY)")).toBe(false);

	// Access qA — LRU should move it to "most recently used"
	client.query(qA);
	// LRU order should now be: qB, qC, qA (qB is least recently used)

	// Insert qD — should evict qB (LRU), NOT qA
	const qD = "SELECT 4";
	client.query(qD);
	expect(client.statementCacheSize).toBe(3);

	// qB should have been evicted (it was least recently used)
	expect(client.hasCachedStatement(qB)).toBe(false);
	// qA should still be cached (it was accessed after qB)
	expect(client.hasCachedStatement(qA)).toBe(true);
	// qC and qD should be cached
	expect(client.hasCachedStatement(qC)).toBe(true);
	expect(client.hasCachedStatement(qD)).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/sqlite-client.test.ts`
Expected: FAIL — without the LRU fix, `qA` would be evicted (oldest by insertion) instead of `qB`.

**Step 3: Amend the `prepare` method**

```typescript
private prepare(sql: string): StatementSync {
	let stmt = this.stmtCache.get(sql);
	if (stmt) {
		// LRU: move to end of Map iteration order so it's evicted last
		this.stmtCache.delete(sql);
		this.stmtCache.set(sql, stmt);
		return stmt;
	}

	stmt = this.db.prepare(sql);
	this.stmtCache.set(sql, stmt);

	// Evict oldest (least recently used) entries if cache exceeds capacity
	if (this.stmtCache.size > this.maxCacheSize) {
		const firstKey = this.stmtCache.keys().next().value;
		if (firstKey !== undefined) this.stmtCache.delete(firstKey);
	}

	return stmt;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/sqlite-client.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. Two lines added.

**Step 6: Commit**

```bash
git add src/lib/persistence/sqlite-client.ts test/unit/persistence/sqlite-client.test.ts
git commit -m "perf(persistence): make statement cache LRU-by-access via Map reinsert"
```

---

## Task 3: Batched Eviction and Off-Thread VACUUM

**Problem:** `EventStoreEviction.evictOldSessionEvents()` runs a single `DELETE FROM events WHERE session_id IN (...)`. At 1M events with 100 idle sessions, this can delete 500K rows in one synchronous call, blocking the event loop for seconds. `vacuum()` rewrites the entire database file — 5-30 seconds for a 200MB+ database.

**Fix:** (a) Batch the DELETE into chunks of 5,000 rows using `LIMIT`, yielding the event loop between batches with a callback. (b) Remove `vacuum()` from the public API and document that it should be run via a worker thread or CLI command, not during normal daemon operation.

**Files:**
- Modify (plan amendment): Task 51 — `src/lib/persistence/eviction.ts` (renamed from parent plan's `event-store-eviction.ts` for brevity; update parent plan references accordingly)
- Test: `test/unit/persistence/eviction.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/eviction.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { EventStoreEviction } from "../../../src/lib/persistence/eviction.js";

describe("EventStoreEviction", () => {
	let db: SqliteClient;
	let eviction: EventStoreEviction;
	const now = Date.now();
	const oneWeekAgo = now - 8 * 24 * 60 * 60 * 1000;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		eviction = new EventStoreEviction(db);
	});

	afterEach(() => {
		db?.close();
	});

	function seedSession(id: string, status: string, updatedAt: number): void {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[id, "opencode", "Test", status, updatedAt, updatedAt],
		);
	}

	function seedEvents(sessionId: string, count: number): void {
		for (let i = 0; i < count; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, ?, ?, 'text.delta', '{}', 'opencode', ?)`,
				[`evt-${sessionId}-${i}`, sessionId, i, now],
			);
		}
	}

	it("evicts events from idle sessions older than retention period", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedSession("recent-idle", "idle", now);
		seedEvents("old-idle", 100);
		seedEvents("recent-idle", 50);

		const result = eviction.evictSync();

		expect(result.eventsDeleted).toBe(100);
		// Recent session's events untouched
		const remaining = db.query("SELECT * FROM events WHERE session_id = 'recent-idle'");
		expect(remaining).toHaveLength(50);
	});

	it("does not evict events from busy sessions", () => {
		seedSession("old-busy", "busy", oneWeekAgo);
		seedEvents("old-busy", 100);

		const result = eviction.evictSync();
		expect(result.eventsDeleted).toBe(0);
	});

	it("batches large deletes", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 12000); // more than one batch

		const result = eviction.evictSync({ batchSize: 5000 });

		expect(result.eventsDeleted).toBe(12000);
		expect(result.batchesExecuted).toBeGreaterThan(1);
	});

	it("evictAsync yields between batches", async () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		// Use 190 (not divisible by 50) to avoid trailing-empty-batch ambiguity
		seedEvents("old-idle", 190);

		let yieldCount = 0;
		const result = await eviction.evictAsync({
			batchSize: 50,
			onYield: () => { yieldCount++; },
		});

		expect(result.eventsDeleted).toBe(190);
		// 4 batches: 50+50+50+40. The last batch deletes <50 so loop exits.
		expect(result.batchesExecuted).toBe(4);
		// Yields happen between batches (not after the last one)
		expect(yieldCount).toBe(3);
	});

	it("handles exactly-divisible batch counts correctly", async () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 100);

		const result = await eviction.evictAsync({ batchSize: 50 });

		expect(result.eventsDeleted).toBe(100);
		// 3 batches: 50+50+0. The trailing empty batch detects completion.
		expect(result.batchesExecuted).toBe(3);
	});

	it("cleans up command_receipts older than retention period", () => {
		seedSession("s1", "idle", now);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-old", "s1", "accepted", oneWeekAgo],
		);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-recent", "s1", "accepted", now],
		);

		const result = eviction.evictSync();

		const remaining = db.query("SELECT * FROM command_receipts");
		expect(remaining).toHaveLength(1);
		expect(result.receiptsDeleted).toBeGreaterThan(0);
	});

	it("receipt eviction is time-based, independent of event eviction", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 10);
		// Recent receipt for the old session — should survive eviction
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-recent-for-old", "old-idle", "accepted", now],
		);
		// Old receipt for a recent session — should be evicted
		seedSession("recent", "idle", now);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-old-for-recent", "recent", "accepted", oneWeekAgo],
		);

		eviction.evictSync();

		const receipts = db.query<{ command_id: string }>("SELECT command_id FROM command_receipts");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]!.command_id).toBe("cmd-recent-for-old");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/eviction.test.ts`
Expected: FAIL — `EventStoreEviction` doesn't exist yet.

**Step 3: Write implementation**

```typescript
// src/lib/persistence/eviction.ts
import type { SqliteClient } from "./sqlite-client.js";
import type { Logger } from "../logger.js";

export interface EvictionOptions {
	/** How old a session must be (ms) before its events are evicted. Default: 7 days. */
	retentionMs?: number;
	/** Max rows to delete per batch. Default: 5000. */
	batchSize?: number;
	/** Callback invoked between batches (for yielding the event loop). */
	onYield?: () => void;
}

export interface EvictionResult {
	eventsDeleted: number;
	receiptsDeleted: number;
	batchesExecuted: number;
}

/**
 * Age-based event store eviction with batched deletes.
 *
 * Projection rows (sessions, messages, turns, message_parts) remain
 * as queryable history. Only raw event store rows and old command
 * receipts are evicted.
 *
 * Two modes:
 * - `evictSync()`: Batched DELETE in a loop. Each batch is a separate
 *   transaction. Suitable for moderate-size stores (<100K events).
 * - `evictAsync()`: Same batched DELETE but `await`s a `setImmediate`
 *   between batches, yielding the event loop. Use for large stores.
 *
 * VACUUM is intentionally omitted. It rewrites the entire database
 * file synchronously and should only be run from a CLI command or
 * worker thread, never during normal daemon operation.
 */
export class EventStoreEviction {
	private readonly db: SqliteClient;
	private readonly log?: Logger;

	constructor(db: SqliteClient, log?: Logger) {
		this.db = db;
		this.log = log;
	}

	/**
	 * Synchronous batched eviction. Blocks the event loop only for
	 * `batchSize` rows at a time (~1-5ms per batch of 5000 rows).
	 */
	evictSync(opts?: EvictionOptions): EvictionResult {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 5000;
		const cutoff = Date.now() - retentionMs;

		let totalEventsDeleted = 0;
		let batchesExecuted = 0;

		// Batched event deletion — each batch is its own implicit transaction
		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);

			const deleted = Number(result.changes);
			totalEventsDeleted += deleted;
			batchesExecuted++;

			if (deleted < batchSize) break; // last batch
		}

		// Command receipts cleanup (single pass — typically small table)
		const receiptsResult = this.db.execute(
			"DELETE FROM command_receipts WHERE created_at < ?",
			[cutoff],
		);
		const receiptsDeleted = Number(receiptsResult.changes);

		if (totalEventsDeleted > 0 || receiptsDeleted > 0) {
			this.log?.info("eviction complete", {
				eventsDeleted: totalEventsDeleted,
				receiptsDeleted,
				batchesExecuted,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return { eventsDeleted: totalEventsDeleted, receiptsDeleted, batchesExecuted };
	}

	/**
	 * Async batched eviction. Yields the event loop between batches via
	 * `setImmediate`, allowing WebSocket/HTTP handlers to run.
	 */
	async evictAsync(opts?: EvictionOptions): Promise<EvictionResult> {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 5000;
		const onYield = opts?.onYield;
		const cutoff = Date.now() - retentionMs;

		let totalEventsDeleted = 0;
		let batchesExecuted = 0;

		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);

			const deleted = Number(result.changes);
			totalEventsDeleted += deleted;
			batchesExecuted++;

			if (deleted < batchSize) break;

			// Yield the event loop
			onYield?.();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		const receiptsResult = this.db.execute(
			"DELETE FROM command_receipts WHERE created_at < ?",
			[cutoff],
		);
		const receiptsDeleted = Number(receiptsResult.changes);

		if (totalEventsDeleted > 0 || receiptsDeleted > 0) {
			this.log?.info("eviction complete", {
				eventsDeleted: totalEventsDeleted,
				receiptsDeleted,
				batchesExecuted,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return { eventsDeleted: totalEventsDeleted, receiptsDeleted, batchesExecuted };
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/eviction.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/eviction.ts test/unit/persistence/eviction.test.ts
git commit -m "perf(persistence): batched eviction with event-loop yielding, remove synchronous VACUUM"
```

---

## Task 4: Non-Blocking Recovery with Progress Reporting

**Problem:** `ProjectionRunner.recover()` processes all unproject events synchronously. At 100K events with 60% matching a single projector, recovery takes ~30 seconds of continuous event-loop blocking. The daemon appears frozen during this window.

**Fix:** (a) Add a `recoverAsync()` method that yields the event loop between batches via `setImmediate`. (b) Add a progress callback for logging. (c) Keep the existing synchronous `recover()` for tests and small stores. The relay-stack wiring (Task 12) should call `recoverAsync()` instead of `recover()`.

**Files:**
- Modify (plan amendment): Task 21 — `src/lib/persistence/projection-runner.ts`
- Modify (plan amendment): Task 12 — `src/lib/relay/relay-stack.ts`
- Test: `test/unit/persistence/projection-runner-async-recovery.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projection-runner-async-recovery.test.ts
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
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

describe("ProjectionRunner async recovery", () => {
	let db: SqliteClient;
	let eventStore: EventStore;
	let cursorRepo: ProjectorCursorRepository;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		eventStore = new EventStore(db);
		cursorRepo = new ProjectorCursorRepository(db);
	});

	afterEach(() => {
		db?.close();
	});

	function seedSessionAndEvents(sessionId: string, count: number): void {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[sessionId, "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		// Seed a message.created event so text.delta projections have an FK target
		eventStore.append(
			canonicalEvent("message.created", sessionId, {
				messageId: "m1", role: "assistant" as const, sessionId,
			}),
		);
		for (let i = 0; i < count; i++) {
			eventStore.append(
				canonicalEvent("text.delta", sessionId, {
					messageId: "m1", partId: `p-${i}`, text: `chunk-${i}`,
				}),
			);
		}
	}

	it("recoverAsync yields between batches", async () => {
		seedSessionAndEvents("s1", 200);

		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
			recoveryBatchSize: 50,
		});

		let progressCalls = 0;
		const result = await runner.recoverAsync({
			onProgress: (info) => {
				progressCalls++;
				expect(info.projectorName).toBeDefined();
				expect(info.eventsReplayed).toBeGreaterThan(0);
			},
		});

		expect(result.totalReplayed).toBeGreaterThan(0);
		expect(progressCalls).toBeGreaterThan(0);
		expect(runner.isRecovered).toBe(true);
	});

	it("projectEvent throws before recoverAsync completes (CH4 guard)", () => {
		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
		});

		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);

		const stored = eventStore.append(
			canonicalEvent("session.created", "s1", {
				sessionId: "s1", title: "Test", provider: "opencode",
			}),
		);

		// Without calling recoverAsync(), projectEvent should throw
		expect(() => runner.projectEvent(stored)).toThrow(/recover/);
	});

	it("projectEvent works after recoverAsync", async () => {
		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
		});

		await runner.recoverAsync();

		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);

		const stored = eventStore.append(
			canonicalEvent("session.created", "s1", {
				sessionId: "s1", title: "Test", provider: "opencode",
			}),
		);

		expect(() => runner.projectEvent(stored)).not.toThrow();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projection-runner-async-recovery.test.ts`
Expected: FAIL — `recoverAsync` doesn't exist.

**Step 3: Amend the ProjectionRunner**

Add to `src/lib/persistence/projection-runner.ts`:

```typescript
export interface RecoveryProgress {
	projectorName: string;
	eventsReplayed: number;
	totalEstimated: number;
	durationMs: number;
}

export interface AsyncRecoveryOptions {
	/** Called after each batch for progress reporting. */
	onProgress?: (progress: RecoveryProgress) => void;
}

/**
 * Return type for recoverAsync(). Differs from the synchronous RecoveryResult
 * by including per-projector breakdown instead of global cursor fields.
 */
export interface AsyncRecoveryResult {
	totalReplayed: number;
	durationMs: number;
	perProjector: ProjectorRecoveryResult[];
}

export class ProjectionRunner {
	// ... existing fields ...

	private readonly recoveryBatchSize: number;

	// Note: The parent plan (Task 21) defines this as ProjectionRunnerConfig.
	// Add `recoveryBatchSize?: number` to that interface.
	constructor(config: ProjectionRunnerConfig) {
		// ... existing constructor ...
		this.recoveryBatchSize = config.recoveryBatchSize ?? 500;
	}

	/**
	 * Async recovery that yields the event loop between batches.
	 *
	 * Use this in relay-stack.ts instead of `recover()` for production
	 * startup. The daemon remains responsive to health checks and
	 * WebSocket connections while recovery runs.
	 *
	 * Equivalent to `recover()` but with `setImmediate` between batches.
	 */
	async recoverAsync(opts?: AsyncRecoveryOptions): Promise<AsyncRecoveryResult> {
		const startTime = Date.now();
		const latestSeq = this.db.queryOne<{ max_seq: number | null }>(
			"SELECT MAX(sequence) AS max_seq FROM events",
		)?.max_seq ?? 0;

		const allCursors = this.cursorRepo.listAll();
		const allCaughtUp = allCursors.length === this.projectors.length &&
			allCursors.every(c => c.lastAppliedSeq >= latestSeq);

		if (allCaughtUp) {
			this._recovered = true;
			this.log?.info("recovery: all projectors caught up, skipping replay");
			return { totalReplayed: 0, durationMs: 0, perProjector: [] };
		}

		const perProjector: ProjectorRecoveryResult[] = [];
		let totalReplayed = 0;

		for (const projector of this.projectors) {
			const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
			if (cursor >= latestSeq) continue;

			const result = await this.recoverProjectorAsync(
				projector, cursor, latestSeq, opts?.onProgress,
			);
			perProjector.push(result);
			totalReplayed += result.eventsReplayed;
		}

		this._recovered = true;
		return {
			totalReplayed,
			durationMs: Date.now() - startTime,
			perProjector,
		};
	}

	private async recoverProjectorAsync(
		projector: Projector,
		fromCursor: number,
		totalEstimated: number,
		onProgress?: (progress: RecoveryProgress) => void,
	): Promise<ProjectorRecoveryResult> {
		const startTime = Date.now();
		let replayed = 0;
		let cursor = fromCursor;

		const handledTypes = projector.handles;
		const placeholders = handledTypes.map(() => '?').join(', ');

		while (true) {
			const events = this.db.query<EventRow>(
				`SELECT * FROM events
				 WHERE sequence > ? AND type IN (${placeholders})
				 ORDER BY sequence ASC
				 LIMIT ?`,
				[cursor, ...handledTypes, this.recoveryBatchSize],
			);
			if (events.length === 0) break;

			for (const event of events) {
				try {
					this.db.runInTransaction(() => {
						projector.project(this.rowToStoredEvent(event), this.db, { replaying: true });
						this.cursorRepo.upsert(projector.name, event.sequence);
					});
					replayed++;
				} catch (err) {
					this.recordFailure(projector, event, err);
				}
			}

			cursor = events[events.length - 1]!.sequence;

			onProgress?.({
				projectorName: projector.name,
				eventsReplayed: replayed,
				totalEstimated,
				durationMs: Date.now() - startTime,
			});

			// Yield the event loop between batches
			if (events.length >= this.recoveryBatchSize) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}

		// Advance cursor to the global max
		const maxSeq = this.db.queryOne<{ max_seq: number | null }>(
			"SELECT MAX(sequence) AS max_seq FROM events",
		)?.max_seq;
		if (maxSeq != null && maxSeq > cursor) {
			this.cursorRepo.upsert(projector.name, maxSeq);
		}

		return {
			projectorName: projector.name,
			startCursor: fromCursor,
			endCursor: maxSeq ?? cursor,
			eventsReplayed: replayed,
			durationMs: Date.now() - startTime,
		};
	}
}
```

**Amend relay-stack.ts** (Task 12) — change synchronous `recover()` to `recoverAsync()`:

```typescript
// In createProjectRelay(), replace:
//   const result = config.persistence.projectionRunner.recover();
// With:
if (config.persistence) {
	const result = await config.persistence.projectionRunner.recoverAsync({
		onProgress: (p) => {
			log.info(`recovery: ${p.projectorName} — ${p.eventsReplayed} events replayed (${p.durationMs}ms)`);
		},
	});
	if (result.totalReplayed > 0) {
		log.info(`Projection recovery complete: ${result.totalReplayed} events in ${result.durationMs}ms`);
	}
}
```

Note: `createProjectRelay()` is already async (it `await`s SSE consumer setup), so this change is compatible.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projection-runner-async-recovery.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/projection-runner.ts src/lib/relay/relay-stack.ts test/unit/persistence/projection-runner-async-recovery.test.ts
git commit -m "perf(persistence): async recovery with event-loop yielding and progress reporting"
```

---

## Task 5: Command Receipt Eviction

**Addressed in Task 3.** The `EventStoreEviction` implementation in Task 3 includes `command_receipts` cleanup in the same eviction pass, using the same retention period. No separate task needed.

---

## Task 6: Fix Pagination SQL for Composite Cursor

**Problem:** The `ReadQueryService.getSessionMessages()` pagination uses a composite `(created_at, id)` cursor (amendment I9), but the plan's implementation already uses the correct OR-expanded form. However, the `LIMIT` logic has a subtle issue: the over-fetch pattern (`LIMIT pageSize + 1` from amendment I7) is applied in a subquery that reverses sort order, which can produce off-by-one pagination when `hasMore` is computed by the caller.

**Fix:** Ensure the pagination SQL is explicitly correct and add a test that exercises the cursor boundary.

**Files:**
- Modify (plan amendment): Task 23 — `src/lib/persistence/read-query-service.ts`
- Test: `test/unit/persistence/read-query-service.test.ts` (add cursor pagination test)

**Step 1: Write the failing test**

Add to the existing `read-query-service.test.ts`:

```typescript
describe("getSessionMessages cursor pagination", () => {
	it("composite cursor paginates correctly with same-timestamp messages", () => {
		// Seed 5 messages with the same created_at but different IDs
		const ts = Date.now();
		for (const id of ["m-a", "m-b", "m-c", "m-d", "m-e"]) {
			db.execute(
				`INSERT INTO messages (id, session_id, role, text, is_streaming, created_at, updated_at)
				 VALUES (?, 's1', 'user', '', 0, ?, ?)`,
				[id, ts, ts],
			);
		}

		// Page 1: latest 2
		const page1 = svc.getSessionMessages("s1", { limit: 2 });
		expect(page1).toHaveLength(2);

		// Page 2: using cursor from last item of page 1
		const lastItem = page1[page1.length - 1]!;
		const page2 = svc.getSessionMessages("s1", {
			limit: 2,
			beforeCreatedAt: lastItem.created_at,
			beforeId: lastItem.id,
		});
		expect(page2).toHaveLength(2);

		// No overlap between pages
		const page1Ids = new Set(page1.map(m => m.id));
		const page2Ids = new Set(page2.map(m => m.id));
		for (const id of page2Ids) {
			expect(page1Ids.has(id)).toBe(false);
		}
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/read-query-service.test.ts`
Expected: FAIL — `beforeCreatedAt`/`beforeId` params don't exist yet.

**Step 3: Amend the getSessionMessages method**

Replace the `beforeMessageId` parameter (which requires a lookup) with explicit cursor fields:

```typescript
getSessionMessages(
	sessionId: string,
	opts?: {
		limit?: number;
		/** Cursor: return messages before this (created_at, id) pair */
		beforeCreatedAt?: number;
		beforeId?: string;
	},
): MessageRow[] {
	// Cursor-based pagination with composite (created_at, id) cursor.
	// Uses OR-expanded form since SQLite doesn't optimize tuple comparison.
	// Over-fetches by 1 (amendment I7) so callers can detect hasMore.
	// Wraps in subquery to re-sort ASC for consistent caller interface.
	//
	// NOTE: This replaces the parent plan's `beforeMessageId` parameter.
	// Update the parent plan test at line 11660 to use beforeCreatedAt/beforeId.
	if (opts?.beforeCreatedAt != null && opts?.beforeId != null) {
		const limit = opts.limit ?? 50;
		return this.db.query<MessageRow>(
			`SELECT * FROM (
				SELECT * FROM messages
				WHERE session_id = ?
				  AND (created_at < ? OR (created_at = ? AND id < ?))
				ORDER BY created_at DESC, id DESC
				LIMIT ?
			) sub ORDER BY created_at ASC, id ASC`,
			[sessionId, opts.beforeCreatedAt, opts.beforeCreatedAt, opts.beforeId, limit + 1],
		);
	}

	// Latest N messages (first page). Over-fetch by 1 for hasMore detection (I7).
	if (opts?.limit) {
		return this.db.query<MessageRow>(
			`SELECT * FROM (
				SELECT * FROM messages
				WHERE session_id = ?
				ORDER BY created_at DESC, id DESC
				LIMIT ?
			) sub ORDER BY created_at ASC, id ASC`,
			[sessionId, opts.limit + 1],
		);
	}

	// All messages
	return this.db.query<MessageRow>(
		"SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
		[sessionId],
	);
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/read-query-service.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/read-query-service.ts test/unit/persistence/read-query-service.test.ts
git commit -m "fix(persistence): use composite (created_at, id) cursor for message pagination"
```

---

## Task 7: Early Event Count Warning for Phases 2-6

**Problem:** The `EventStoreEviction` class arrives in Phase 7. During Phases 2-6, the database grows ~360MB/day with no eviction. Developers may not notice until the database exceeds several GB.

**Fix:** Add `eventCountWarning` and `dbSizeBytes` fields to the existing `PersistenceDiagnostics.health()` method (merging with, not duplicating, the existing API). This is purely observational — no deletion, just a log warning when the events table exceeds 100K rows.

**Files:**
- Modify (plan amendment): Task 22.5 — `src/lib/persistence/diagnostics.ts`
- Test: `test/unit/persistence/diagnostics.test.ts`

**Step 1: Write the failing test**

Add to existing `diagnostics.test.ts`:

```typescript
describe("event count warning (merged into health())", () => {
	it("reports event count in health()", () => {
		// Seed session first (FK constraint)
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		for (let i = 0; i < 10; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, 's1', ?, 'text.delta', '{}', 'opencode', ?)`,
				[`evt-${i}`, i, Date.now()],
			);
		}

		const health = diagnostics.health();
		expect(health.eventCount).toBe(10);
		expect(health.eventCountWarning).toBe(false);
	});

	it("sets warning flag when event count exceeds threshold", () => {
		const diag = new PersistenceDiagnostics(db, { eventCountWarningThreshold: 5 });

		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		for (let i = 0; i < 10; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, 's1', ?, 'text.delta', '{}', 'opencode', ?)`,
				[`evt-${i}`, i, Date.now()],
			);
		}

		const health = diag.health();
		expect(health.eventCount).toBe(10);
		expect(health.eventCountWarning).toBe(true);
	});

	it("returns zero event count for empty database", () => {
		const health = diagnostics.health();
		expect(health.eventCount).toBe(0);
		expect(health.eventCountWarning).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/diagnostics.test.ts`
Expected: FAIL — `eventCount`/`eventCountWarning` don't exist.

**Step 3: Amend PersistenceDiagnostics**

Amend the existing `PersistenceDiagnostics` constructor and `health()` method (Task 22.5 of the parent plan). Add `eventCountWarningThreshold` option to the constructor and new fields to the `health()` return type.

```typescript
// Amend src/lib/persistence/diagnostics.ts — add to constructor options:

export interface DiagnosticsOptions {
	/** Event count above which health() sets eventCountWarning=true. Default: 100_000. */
	eventCountWarningThreshold?: number;
}

// Amend constructor:
export class PersistenceDiagnostics {
	// ... existing fields ...
	private readonly eventCountWarningThreshold: number;

	constructor(db: SqliteClient, opts?: DiagnosticsOptions) {
		// ... existing constructor ...
		this.eventCountWarningThreshold = opts?.eventCountWarningThreshold ?? 100_000;
	}

	// Amend existing health() return type to include:
	//   eventCount: number
	//   eventCountWarning: boolean
	//   dbSizeBytes: number

	health(): HealthResult {
		// ... existing health check code ...

		const eventCount = this.db.queryOne<{ count: number }>(
			"SELECT COUNT(*) as count FROM events",
		)?.count ?? 0;

		// PRAGMA returns a single-column result. Column name matches the pragma name.
		const pageCountRow = this.db.queryOne<{ page_count: number }>(
			"PRAGMA page_count",
		);
		const pageSizeRow = this.db.queryOne<{ page_size: number }>(
			"PRAGMA page_size",
		);
		const dbSizeBytes = (pageCountRow?.page_count ?? 0) * (pageSizeRow?.page_size ?? 4096);

		return {
			// ... existing fields ...
			eventCount,
			eventCountWarning: eventCount > this.eventCountWarningThreshold,
			dbSizeBytes,
		};
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/diagnostics.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/diagnostics.ts test/unit/persistence/diagnostics.test.ts
git commit -m "feat(persistence): add event count warning to PersistenceDiagnostics health check"
```

---

## Task 8: Correct the `text || ?` O(1) Claim in Documentation

**Problem:** The v2 performance recommendations doc (line 93) claims `text || ?` is "inherently O(1)" — this is incorrect. SQLite's `text || ?` reads the existing text, allocates a new string of `old_len + new_len`, copies both, and writes. Per-delta cost is O(n) where n is accumulated text length, making the total across all deltas O(n²). This is negligible for typical message sizes but becomes material for large tool results streamed as deltas.

**Fix:** Correct the documentation. No code changes.

**Files:**
- Modify: `docs/plans/2026-04-07-orchestrator-performance-scalability-recommendations-v2.md`

**Step 1: Amend the P1 section**

Replace the bullet point at line 93-94:

```
- **O(1) per delta.** No linear scan of a parts array.
```

With:

```
- **O(n) per delta where n is accumulated text length.** SQLite's `text || ?` reads and copies the existing value. Total work across all deltas for a message is O(n²). This is negligible for typical message sizes (5K chars → ~128KB total copies) but would be material for very large streaming outputs (100K+ chars). In practice, large content arrives via `tool.completed` (single write, not streaming deltas), so the quadratic cost is not a concern for real workloads. If profiling reveals this is an issue, replace SQL concat with offset-tracking (store offset + append, reconstruct on read).
```

**Step 2: Commit**

```bash
git add docs/plans/2026-04-07-orchestrator-performance-scalability-recommendations-v2.md
git commit -m "docs(persistence): correct text || ? complexity claim from O(1) to O(n) per delta"
```

---

## Summary of Amendments to Parent Plan

| Parent Plan Task | Amendment | Nature |
|------------------|-----------|--------|
| Task 1 (SqliteClient) | LRU cache hit reorders Map entry | 2-line code change |
| Task 16 (MessageProjector) | Replace `getNextSortOrder()` calls with inline COALESCE subquery; delete the method | SQL refactor, method deletion |
| Task 21 (ProjectionRunner) | Add `recoverAsync()` with `setImmediate` yielding and progress callback | New async method |
| Task 12 (relay-stack.ts) | Call `recoverAsync()` instead of `recover()` | One call-site change |
| Task 22.5 (PersistenceDiagnostics) | Add `eventCount`, `eventCountWarning`, `dbSizeBytes` to health check | New fields |
| Task 23 (ReadQueryService) | Replace `beforeMessageId` with explicit `beforeCreatedAt`/`beforeId` cursor | API change |
| Task 51 (EventStoreEviction) | Batched DELETE with LIMIT, async variant, command_receipts cleanup, remove VACUUM | Full rewrite |
| v2 recommendations doc | Correct O(1) claim to O(n) with tradeoff analysis | Documentation |
