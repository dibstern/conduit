# Orchestrator Plan: Testing Strategy Recommendations

> Best-practice designs for improving the testing strategy of the [orchestrator implementation plan](./2026-04-05-orchestrator-implementation-plan.md). Addresses inline-reimplementation tests, test helper quality, missing edge cases, property-based testing, and structural coverage gaps.

---

## Overview

The plan's test suite is thorough at the unit level — every module has dedicated tests, TDD red-green-refactor is followed consistently, and the test count is high. The problems are systemic rather than local: tests that validate algorithms in isolation from the code that runs in production, test factories that silently produce invalid data, entire categories of bugs that example-based tests structurally cannot catch, and a shared-helpers recommendation (E1) that was declared but never applied.

Seven areas, roughly ordered by impact.

---

## 1. Test Production Code, Not Inline Reimplementations

**Problem.** Five Phase 4 tasks define the business logic inline in the test file and test that, rather than importing and calling the production function. The test passes, the production code has a different bug, nobody knows.

| Task | Inline Function | Production Target |
|------|----------------|-------------------|
| 24.5 | `buildHandlerDeps()` | `createProjectRelay()` in relay-stack.ts |
| 26 | `resolveForkEntry()` | `SessionManager.getForkEntry()` |
| 28 | `dualListSessions()` | `SessionManager.listSessions()` |
| 30 | `resolveRawStatuses()` | `SessionStatusPoller.poll()` |

Task 26's inline function also references `isActive` without importing it — a compile error hidden by the test-only scope.

**Design.** Each task needs two test layers:

1. **Algorithm test (keep, rename).** The inline function is useful as executable documentation of the intended algorithm. Rename it to clearly mark it as a specification, not a test of production code: `describe("fork resolution algorithm (spec)")`.

2. **Wiring test (add).** Import the production function. Construct the minimal real dependencies (ReadQueryService over an in-memory SQLiteClient, real ReadFlags). Call the production function. Assert the same outcomes. This is the test that catches drift between spec and implementation.

The wiring test for Tasks 26/28/30 follows a uniform shape:

```
given:  seeded SQLite state + ReadFlags set to "sqlite"
when:   call production method (e.g., sessionManager.getForkEntry())
then:   assert return value matches expected shape
```

The production methods already accept injected dependencies (ReadQueryService, ReadFlags), so no mocking gymnastics are needed — construct the real objects over an in-memory DB.

---

## 2. One Shared Factory Module, Not 33 Local Copies

**Problem.** Amendment E1 recommends a shared `test/helpers/persistence-factories.ts`. The plan never applies it. The result: `makeSSEEvent` is defined 5 times, `makeStored<T>` 6 times, `seedSession` 5 times with 4 different signatures, `makeStubClient` 4 times. Every copy is a maintenance liability — fix a bug in one, the other four still produce invalid data.

**Design.** Three shared modules, organized by domain boundary:

```
test/helpers/
├── persistence-factories.ts    # Event store, projections, read queries
├── provider-factories.ts       # Adapters, EventSink, OrchestrationEngine
└── sse-factories.ts            # SSE events, relay pipeline mocks
```

### persistence-factories.ts

The core export is a `TestHarness` factory that constructs a fully-wired in-memory persistence stack in one call:

```typescript
export function createTestHarness() {
  const layer = PersistenceLayer.memory();
  return {
    layer,
    db: layer.db,
    eventStore: layer.eventStore,
    seedSession: (id: string, opts?: SessionSeedOpts) => { /* richest signature */ },
    seedMessage: (id: string, sessionId: string, opts?: MessageSeedOpts) => { /* ... */ },
    seedTurn: (id: string, sessionId: string, opts?: TurnSeedOpts) => { /* ... */ },
    makeStored: <T extends StoredEvent["type"]>(
      type: T,
      sessionId: string,
      data: EventPayloadMap[T],
      opts?: { sequence?: number; createdAt?: number },
    ): StoredEvent => { /* ... */ },
    close: () => layer.close(),
  };
}
```

Each `seed*` function takes the richest signature (Task 23's version) with all fields optional-with-defaults. The `makeStored` factory is generic, well-typed, and defined once.

### sse-factories.ts

```typescript
export function makeSSEEvent<T extends OpenCodeEventType>(
  type: T,
  properties: OpenCodeEventPayloadMap[T],
): OpenCodeEvent
```

The key improvement: `type` is constrained to known SSE event types, and `properties` is constrained to the correct payload shape for that type. Passing `"message.delta"` (a non-existent type) is a compile error. This catches the Task 36 bug where `makeEvent` uses `"message.delta"` instead of `"text.delta"`.

If the codebase doesn't have an `OpenCodeEventPayloadMap`, the fallback is simpler but still improves on the status quo:

```typescript
export function makeSSEEvent(
  type: OpenCodeEvent["type"],
  properties: Record<string, unknown>,
): OpenCodeEvent
```

Constraining just the `type` parameter to the union of known event types catches the most common class of error.

### provider-factories.ts

```typescript
export function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient
export function makeStubAdapter(id: string, overrides?: Partial<ProviderAdapter>): ProviderAdapter
export function makeStubEventSink(opts?: { trackEvents?: boolean }): EventSink & { events: CanonicalEvent[] }
```

Each returns a fully-typed object where unmocked methods throw `new Error("not mocked: methodName")` instead of silently returning `undefined`. This catches tests that accidentally call methods they didn't set up.

---

## 3. Guard Test Factories Against Invalid Data

**Problem.** Test helpers silently produce structurally invalid data in three ways:

1. **`makeStored<T>` with `sequence: 0`** produces `streamVersion: -1`, violating the schema's non-negative invariant.
2. **`makeEvent` in Task 36** uses `type: "message.delta"` — not a valid canonical event type. Production's `rowToStoredEvent` would throw `UNKNOWN_EVENT_TYPE`.
3. **`makeSSEEvent`** accepts any string as `type`. No guard against typos or non-existent event types.

These are not hypothetical risks. They produce tests that pass on invalid data, building false confidence.

**Design.** Defensive factories with three layers of protection:

**Layer 1: Type constraints.** The generic parameter on `makeStored<T>` already constrains `data` to match `type`. Extend this to `makeSSEEvent` (see Section 2).

**Layer 2: Runtime invariant checks.** Add guards in the shared factories that throw immediately on invalid construction:

```typescript
export function makeStored<T extends StoredEvent["type"]>(
  type: T,
  sessionId: string,
  data: EventPayloadMap[T],
  opts?: { sequence?: number; createdAt?: number },
): StoredEvent {
  const sequence = opts?.sequence ?? 1;
  if (sequence < 1) throw new Error(`makeStored: sequence must be >= 1, got ${sequence}`);
  if (!CANONICAL_EVENT_TYPES.includes(type)) {
    throw new Error(`makeStored: unknown event type "${type}"`);
  }
  // ...
}
```

**Layer 3: `validateEventPayload()` in the factory.** The plan already defines `validateEventPayload()` (Task 4) which checks required fields per event type. Call it inside `makeStored` and `makeCanonical` so that test data is validated at construction time, not when it hits the event store. A test that constructs a `tool.started` event without `toolName` fails at the factory call, not three function calls later in a projector.

---

## 4. Property-Based Tests for Invariant-Rich Code

**Problem.** Example-based unit tests pick a handful of inputs and assert specific outputs. They cannot cover the combinatorial space of event ordering, session interleaving, and reconnect timing. The plan already fixed one off-by-one in cursor handling (C2) that property-based tests would have caught mechanically.

**Design.** Five property specifications, each targeting a specific invariant. Use [fast-check](https://github.com/dubzzz/fast-check) (zero-dependency, Vitest-compatible).

### Property 1: Event Store Replay Consistency

```
∀ events: CanonicalEvent[N], cursor: 0..N
  let stored = appendAll(events)
  let replayed = readFromSequence(cursor)
  assert:
    replayed.length === stored.filter(e => e.sequence > cursor).length
    replayed is sorted by sequence ASC
    ∀ session S: streamVersions for S are contiguous [0, 1, 2, ...]
    ∀ e in replayed: JSON.parse(JSON.stringify(e.data)) deepEquals e.data
```

The generator produces random canonical events with random session IDs, event types, and payload data (constrained to the correct shape per type via the `EventPayloadMap`). The cursor is drawn uniformly from `[0, max sequence]`.

Catches: off-by-one in cursor handling, JSON round-trip edge cases (NaN, Infinity, undefined-in-arrays), stream version gaps, sequence ordering violations.

### Property 2: Projection Convergence (Replay = Streaming)

```
∀ events: CanonicalEvent[N]
  // Path A: stream events one at a time through ProjectionRunner
  streamAll(events) → read projection state A

  // Path B: append all events, then recover() from cursor=0
  appendAll(events); recover() → read projection state B

  assert: state A === state B
```

This is the single most valuable property test for CQRS systems. It ensures projections are deterministic and replay-safe. The generator needs to produce *valid* event sequences (e.g., `message.created` before `text.delta` for the same message) — use a state machine generator that tracks open sessions and messages.

Catches: projection idempotency failures, cursor advancement bugs (CH3), order-dependent logic, missing `INSERT OR IGNORE` guards.

### Property 3: Dual-Write Reconnect Safety

```
∀ events: OpenCodeEvent[N], reconnectPoints: Set<indices into events>
  for i in 0..N:
    if i in reconnectPoints: hook.onReconnect()
    hook.onSSEEvent(events[i], sessionId)
  assert:
    no duplicate eventIds in the store
    ∀ session S: streamVersions have no gaps
    projector cursors never decrease
```

The generator interleaves real SSE events with random `onReconnect()` calls at arbitrary points. This catches reconnect race conditions, version cache staleness, and cursor monotonicity violations.

### Property 4: Session Seeder Idempotency

```
∀ ops: (ensureSession | reset)[N]
  execute ops in sequence
  assert:
    sessions table has no duplicate IDs
    existing session data (title, status) was never overwritten by a re-seed
```

Small, fast, catches subtle INSERT OR IGNORE semantics bugs.

### Property 5: Message Part Assembly

```
∀ deltas: string[N] for a single message part
  project all as text.delta events
  assert:
    message_parts.text === deltas.join("")
```

The generator produces random strings including empty strings, strings with SQL-special characters (`'`, `%`, `\0`), Unicode, and very long strings. Catches SQL `text || ?` concatenation edge cases.

### Implementation pattern

Each property test lives alongside its unit test file:

```
test/unit/persistence/event-store.test.ts        ← existing unit tests
test/unit/persistence/event-store.prop.test.ts   ← property tests
```

Property tests are slower, so they run in a separate `test:prop` script (not in the default `test:unit`). Use `fc.configureGlobal({ numRuns: 200 })` for CI, `numRuns: 20` for local dev.

---

## 5. Fix Schema Mismatches in Test Seed Helpers

**Problem.** Tasks 31 and 32 (`session-history-adapter.test.ts`, `session-switch-sqlite.test.ts`) insert a `parts` TEXT column into the `messages` table. Since P1 normalization, messages don't have a `parts` column — parts live in the normalized `message_parts` table. These tests would fail against the real schema.

**Design.** The fix is structural, not a one-off column rename. The shared `seedMessage` helper (Section 2) must mirror the real schema:

```typescript
seedMessage(id: string, sessionId: string, opts?: {
  role?: "user" | "assistant";
  text?: string;
  parts?: Array<{ id: string; type: "text" | "thinking" | "tool"; text?: string; ... }>;
}) {
  // INSERT into messages table (no parts column)
  db.execute(`INSERT INTO messages (...) VALUES (...)`, [...]);

  // INSERT each part into message_parts table
  for (const [i, part] of (opts?.parts ?? []).entries()) {
    db.execute(`INSERT INTO message_parts (...) VALUES (...)`, [
      part.id, id, part.type, part.text ?? "", ..., i, now, now,
    ]);
  }
}
```

The helper accepts a `parts` array in its API for convenience, but writes to the correct normalized tables. Tests that call `seedMessage` get correct schema behavior without knowing about the normalization.

Additionally, two other schema-related gaps need test coverage:

1. **CHECK constraint enforcement (H1).** Add a dedicated test:
   ```
   expect(() => seedSession("s1", { status: "invalid" })).toThrow(/CHECK constraint/)
   ```
   One test per table with CHECK constraints (sessions, messages, turns, message_parts, pending_approvals).

2. **Foreign key cascade behavior.** The eviction strategy (P6) deletes session rows. Add a test that verifies whether `ON DELETE CASCADE` is configured (it isn't in the current schema — FKs default to `RESTRICT`), and whether the eviction code handles this correctly by deleting dependents first.

---

## 6. End-to-End Pipeline Test

**Problem.** No test exercises the full event pipeline: SSE event → DualWriteHook → translator → seeder → EventStore.append → ProjectionRunner.projectEvent → all 6 projectors → ReadQueryService read. Task 22 (`dual-write-projection.test.ts`) gets close but stops at the ProjectionRunner — it never queries the ReadQueryService to verify the read model is correct.

**Design.** One integration test file, `test/integration/persistence/event-pipeline.test.ts`, that runs the complete pipeline over an in-memory database:

```typescript
describe("Event Pipeline Integration", () => {
  it("SSE events produce correct read-model state", () => {
    const harness = createTestHarness();  // shared factory from Section 2
    const hook = new DualWriteHook({ persistence: harness.layer, ... });
    const runner = createProjectionRunner(harness.db, createAllProjectors());
    const readQuery = new ReadQueryService(harness.db);

    // Feed a realistic SSE sequence: session start, user message,
    // assistant message with tool use, permission flow, turn complete
    const scenario = createRealisticSSESequence("sess-1");
    for (const event of scenario) {
      const result = hook.onSSEEvent(event, "sess-1");
      if (result.ok) {
        // project each appended event
        for (const stored of harness.eventStore.readFromSequence(lastSeq)) {
          runner.projectEvent(stored);
          lastSeq = stored.sequence;
        }
      }
    }

    // Assert read model via ReadQueryService
    const sessions = readQuery.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe(scenario.expectedTitle);

    const messages = readQuery.getSessionMessages("sess-1");
    expect(messages).toHaveLength(scenario.expectedMessageCount);

    const history = readQuery.getSessionHistory("sess-1");
    // verify parts, tool results, token counts, etc.
  });
});
```

The `createRealisticSSESequence` helper produces a canned but realistic event stream that exercises every canonical event type at least once. It returns the events plus expected read-model outcomes (expected title, message count, tool count, etc.) so the assertions are data-driven.

This catches: translator → projector mismatches, missing projector registrations, ReadQueryService queries that don't match the schema projectors actually write, and the P1 normalization mismatch (Section 5).

---

## 7. Snapshot Tests for Projector Output

**Problem.** Amendment E2 recommends snapshot/golden-file tests for projector lifecycle output. None exist. Projector output is the most refactor-sensitive surface in the system — a column rename, a default value change, or a JSON encoding change silently breaks downstream consumers.

**Design.** One snapshot test per projector that feeds a canonical event sequence and snapshots the resulting table rows:

```typescript
describe("SessionProjector snapshots", () => {
  it("matches golden output for standard lifecycle", () => {
    const harness = createTestHarness();
    const projector = new SessionProjector();

    const events = [
      harness.makeStored("session.created", "s1", { sessionId: "s1", title: "T", provider: "opencode" }, { sequence: 1 }),
      harness.makeStored("session.status", "s1", { sessionId: "s1", status: "busy" }, { sequence: 2 }),
      harness.makeStored("session.renamed", "s1", { sessionId: "s1", title: "New Title" }, { sequence: 3 }),
      harness.makeStored("session.status", "s1", { sessionId: "s1", status: "idle" }, { sequence: 4 }),
    ];

    for (const event of events) {
      projector.project(event, harness.db);
    }

    const rows = harness.db.query("SELECT * FROM sessions WHERE id = 's1'");
    expect(rows).toMatchSnapshot();
  });
});
```

Use Vitest's built-in `toMatchSnapshot()`. The snapshot file is committed to git. When a projector's output changes intentionally, `pnpm vitest -u` updates the snapshot and the diff is visible in code review.

For the MessageProjector specifically, the snapshot should include both the `messages` and `message_parts` tables to catch P1 normalization issues:

```typescript
const messages = harness.db.query("SELECT * FROM messages WHERE session_id = 's1'");
const parts = harness.db.query("SELECT * FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE session_id = 's1') ORDER BY message_id, sort_order");
expect({ messages, parts }).toMatchSnapshot();
```

Snapshot tests are not a substitute for behavioral assertions — they're a safety net that catches unintentional changes. The existing unit tests assert specific behaviors; snapshots catch everything else.

---

## Summary of Amendments to the Plan

| # | Section | Amendment | Affected Tasks |
|---|---------|-----------|----------------|
| T1 | §1 | Add wiring tests that import production functions alongside existing algorithm specs | 24.5, 26, 28, 30 |
| T2 | §2 | Create shared `test/helpers/{persistence,provider,sse}-factories.ts`; update all test imports | All persistence + provider tests |
| T3 | §3 | Add runtime invariant checks and `validateEventPayload()` calls in shared factories | T2 factories |
| T4 | §4 | Add 5 property-based test files with `fast-check`; add `test:prop` script | 5, 16, 10, 9, 21 |
| T5 | §5 | Fix `seedMessage` to write to `message_parts` table; add CHECK/FK tests | 31, 32, 3 |
| T6 | §6 | Add end-to-end pipeline integration test | New file |
| T7 | §7 | Add snapshot tests for all 6 projectors | 15-20 |

Dependencies: T2 should be implemented first (all other amendments depend on shared factories). T5 must precede T6 (pipeline test uses correct seed helpers). T4 is independent and can be done in parallel with everything else.
