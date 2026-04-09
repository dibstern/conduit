# Orchestrator Plan: Testing Strategy Audit

> Comprehensive audit of the testing strategy in the [orchestrator implementation plan](./2026-04-05-orchestrator-implementation-plan.md) and its T1-T7 amendments from the [testing strategy recommendations](./2026-04-07-orchestrator-testing-strategy-recommendations.md). Finds 14 issues across test authenticity, factory quality, boundary conditions, property-based testing, integration gaps, snapshot determinism, and negative-path coverage.

---

## Meta-Finding: Amendments Declared but Not Applied

The T1-T7 amendments are the right diagnoses. The problem is structural: they exist as **amendment table entries** in the plan header (lines 249-267 of the implementation plan), not as applied changes to the task code blocks. An executing agent reads task code blocks verbatim. Task 5's test code still defines local `makeSessionCreatedEvent()` and `seedSession()` functions, still uses `as CanonicalEvent` casts, and never references the shared factories that T2 specifies. Every finding below either comes from an amendment that was declared but never applied to task code, or from a gap the amendments didn't identify.

---

## Findings

### F1. T1 Wiring Tests: Declared but No Code Written

**Severity: High** | **Affects: Tasks 24.5, 26, 28, 30**

T1 says "Add wiring tests that import and call production functions alongside existing algorithm specs." The amendment table lists Tasks 24.5, 26, 28, 30 as affected. But the plan's actual task code blocks for those tasks were never updated with wiring test code. The inline-reimplementation tests remain the *only* tests.

The executing agent will implement only the inline algorithm specs and skip the wiring tests entirely, since there is no code block to follow.

**Required fix:** Write concrete wiring test code blocks for Tasks 24.5, 26, 28, 30. Each should follow the T1 design:

```typescript
// Example wiring test shape for Task 26 (fork resolution)
describe("fork resolution (wiring)", () => {
  it("production getForkEntry() returns correct entry from SQLite", () => {
    const harness = createTestHarness();
    harness.seedSession("s1", { parentId: "s0", forkPointEvent: "evt_5" });
    // ... seed events ...
    const readQuery = new ReadQueryService(harness.db);
    const sessionMgr = new SessionManager({ /* ... real deps with readQuery ... */ });

    const entry = sessionMgr.getForkEntry("s1");
    expect(entry).toEqual({ parentId: "s0", forkPointEvent: "evt_5" });
    harness.close();
  });
});
```

---

### F2. T2 Shared Factories Have No Task Slot

**Severity: High** | **Affects: All persistence + provider tests**

T2 specifies `createTestHarness()`, shared `persistence-factories.ts`, `provider-factories.ts`, and `sse-factories.ts`. But no task in the plan creates these files. The T2 dependency note says "T2 should be implemented first" — but there is no task slot for it.

Concrete count of duplicated factories in plan code blocks:
- `seedSession`: 4+ copies with different signatures
- `makeSSEEvent`: 5+ copies
- `makeStored` / `makeSessionCreatedEvent` / `makeTextDelta`: 6+ copies

**Required fix:** Add an explicit task (e.g., "Task 0: Shared Test Factories") as the first task, before Task 1. It should create the three factory files with all exports documented in T2's design. Every subsequent task's test code block should import from these files instead of defining local copies.

---

### F3. `makeSSEEvent` Accepts Untyped `string` as `type`

**Severity: High** | **Affects: Task 7 tests, all tasks using makeSSEEvent**

Task 7 (plan line 3082):
```typescript
function makeSSEEvent(
  type: string,  // ← accepts ANY string
  properties: Record<string, unknown>,
): OpenCodeEvent {
  return { type, properties } as OpenCodeEvent;
}
```

T3 says "Add runtime invariant checks." But this local factory (which T2 was supposed to replace) still accepts any string. Passing `"message.delta"` (invalid — the real type is `"message.part.delta"`) compiles and creates tests that pass on invalid data.

The existing codebase's `test/helpers/arbitraries.ts` already has properly typed SSE event generators. The plan's factories are less safe than what already exists.

**Required fix:** The shared `sse-factories.ts` must constrain `type` to `KnownOpenCodeEvent["type"]` at minimum:

```typescript
import type { KnownOpenCodeEvent } from "../../src/lib/relay/opencode-events.js";

type KnownSSEType = KnownOpenCodeEvent["type"];

export function makeSSEEvent<T extends KnownSSEType>(
  type: T,
  properties: Record<string, unknown>,
): OpenCodeEvent {
  return { type, properties } as OpenCodeEvent;
}
```

Add a runtime guard for the unconstrained fallback:

```typescript
const KNOWN_SSE_TYPES = new Set<string>([
  "message.created", "message.updated", "message.part.delta",
  "message.part.updated", "message.part.removed", "message.removed",
  "session.status", "session.error", "session.updated",
  "permission.asked", "permission.replied",
  "question.asked", "question.replied",
  "pty.created", "pty.data", "file.edited",
]);

export function makeSSEEvent(type: string, properties: Record<string, unknown>): OpenCodeEvent {
  if (!KNOWN_SSE_TYPES.has(type)) {
    throw new Error(`makeSSEEvent: unknown SSE event type "${type}". Known types: ${[...KNOWN_SSE_TYPES].join(", ")}`);
  }
  return { type, properties } as OpenCodeEvent;
}
```

---

### F4. Test Factories Bypass `canonicalEvent()` — Using `as CanonicalEvent` Casts

**Severity: Medium** | **Affects: Tasks 5, 7, 9, 10, and others**

Task 5's test (plan line 2045-2077) defines `makeSessionCreatedEvent()` and `makeTextDelta()` using raw object construction with `as CanonicalEvent`. The plan's own Task 4 defines `canonicalEvent()` — a typed factory that enforces payload-type correspondence at compile time. But the test helpers don't use it.

This means a test factory can produce a `type: "session.created"` event with `TextDeltaPayload` data, and TypeScript won't catch it because the `as CanonicalEvent` cast erases the type constraint.

Count across plan: 14+ uses of `as CanonicalEvent` in test code blocks.

**Required fix:** All test factories should use `canonicalEvent()` from `src/lib/persistence/events.ts` internally:

```typescript
// In shared persistence-factories.ts
import { canonicalEvent, createEventId, type CanonicalEvent } from "../../src/lib/persistence/events.js";

export function makeSessionCreatedEvent(
  sessionId: string,
  opts?: { eventId?: EventId; metadata?: EventMetadata; createdAt?: number },
): CanonicalEvent {
  return canonicalEvent("session.created", sessionId, {
    sessionId,
    title: "Test Session",
    provider: "opencode",
  }, {
    eventId: opts?.eventId,
    metadata: opts?.metadata,
    createdAt: opts?.createdAt ?? 1_000_000_000_000, // fixed default for determinism (F8)
  });
}
```

Ban `as CanonicalEvent` in test code. If a test needs to create an intentionally invalid event (e.g., to test validation), it should be clearly marked:

```typescript
// Intentionally invalid — testing validation catches this
const invalid = { ...validEvent, data: {} } as unknown as CanonicalEvent;
```

---

### F5. Missing Boundary Conditions in Event Store Tests

**Severity: Medium** | **Affects: Task 5**

Task 5's EventStore tests cover the happy path thoroughly but miss several boundary cases:

| Missing Test | Risk | Suggested Test |
|---|---|---|
| `createdAt = 0` | Zero timestamps valid but often mishandled | `store.append(makeEvent({ createdAt: 0 }))` — assert no error, read back correctly |
| Very large `data` payload (>200 chars) | `rowToStoredEvent` slices raw data to 200 chars in error paths — test the non-error path | Append event with 10KB data, read back, assert deep equality |
| `readFromSequence` with `afterSequence = -1` | Negative cursors — should behave as 0 or throw | Document and test the behavior |
| `readBySession` with `limit = 0` | `LIMIT 0` returns nothing — is this intentional? | Document and test |
| Concurrent version conflict via `EventStore.append()` | Plan claims "optimistic concurrency" but never triggers a conflict through the store API | Use two EventStore instances on the same DB, interleave appends |
| `validateEventPayload` with `null` field values | `{ messageId: null }` passes `!== undefined` check | Test that `null` required fields are caught |
| `readFromSequence` with cursor beyond max sequence | Should return empty array | Add explicit test |

**Required fix:** Add these tests to Task 5's test code block. The concurrent version conflict test is especially important — it validates the core concurrency safety claim.

---

### F6. T4 Missing Two Critical Property Specifications

**Severity: Medium** | **Affects: Phase 7 (eviction) and Phase 2 (tiered write)**

T4 specifies 5 properties. Two additional high-value properties are missing:

#### Property 6: Eviction Safety

```
for all (sessions, events) in arbitrary histories:
  evict(random subset of sessions)
  assert: no FK violations (all remaining FK references resolve)
  assert: no orphaned projection rows (every message_parts.message_id exists in messages, etc.)
  assert: remaining events have valid session_id references
```

Phase 7's eviction deletes through 9 tables in FK-safe order. A property test with random session-event histories and random eviction subsets would catch FK ordering bugs and orphaned rows that example tests can't cover.

#### Property 7: Tiered Write Pipeline Event Ordering

```
for all SSE event sequences E:
  let syncEvents = E.filter(e => SYNC_TYPES.has(e.type))
  let deferredEvents = E.filter(e => !SYNC_TYPES.has(e.type))
  run through tiered pipeline
  assert: every event appears in the store exactly once
  assert: global sequence preserves original ordering within each tier
  assert: no relay message references an event not yet in the store
```

S1-S3's tiered write pipeline with `queueMicrotask` deferral is the most complex concurrency addition. A property test would catch lost events, duplicates, and ordering violations.

**Required fix:** Add these as T4.6 and T4.7 to the testing strategy recommendations, with concrete generator designs.

---

### F7. Test Helpers Silently Produce Schema-Violating Data

**Severity: Medium** | **Affects: Tasks 5, 6, 8, 9**

Beyond T3's identified issues, additional silent schema violations in plan test code:

1. **Task 5, line 2042:** `makeSessionCreatedEvent("s1")` produces `data: { title: "Test Session" }` but the session row seeded at line 2079 has `title: "Test"`. The event store and projection will have divergent titles — exactly the kind of bug dual-write is supposed to catch.

2. **Task 8, line 4166:** `{ eventId: "evt_test-1", ... } as CanonicalEvent` — `"evt_test-1"` doesn't match the `EventId` branded type format (`evt_${uuid}`). Compiles only because of the `as` cast.

3. **Task 6:** `CommandReceipt` tests use `sessionId: "s1"` but `command_receipts` has no FK to `sessions`. Tests pass, but if FKs are added later, every receipt test breaks. Should seed the session first for forward-compatibility.

**Required fix:** All test helpers should use `createTestHarness()` which handles schema setup, session seeding, and FK consistency atomically. The `seedSession` + manual INSERT pattern should be replaced throughout.

---

### F8. Snapshot Tests (T7) Have Non-Deterministic Fields

**Severity: Medium** | **Affects: Tasks 15-20 snapshots**

T7's design shows snapshot tests that capture `SELECT * FROM sessions WHERE id = 's1'`. The sessions table includes `created_at` and `updated_at` columns with runtime-generated timestamps. These vary per test run, making snapshots non-deterministic.

T7's design doesn't address this. Without fixed timestamps, the first run records the snapshot, every subsequent run fails because timestamps differ.

**Required fix:** The shared `makeStored` factory from T2 should default `createdAt` to a fixed value:

```typescript
const FIXED_TEST_TIMESTAMP = 1_000_000_000_000; // 2001-09-09T01:46:40Z

export function makeStored<T extends StoredEvent["type"]>(
  type: T,
  sessionId: string,
  data: EventPayloadMap[T],
  opts?: { sequence?: number; createdAt?: number; streamVersion?: number },
): StoredEvent {
  return {
    sequence: opts?.sequence ?? 1,
    streamVersion: opts?.streamVersion ?? 0,
    ...canonicalEvent(type, sessionId, data, {
      createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
    }),
  } as StoredEvent;
}
```

Similarly, `seedSession` should default timestamps to `FIXED_TEST_TIMESTAMP`. The `seedMessage` and `seedTurn` helpers should do the same. This makes snapshot tests deterministic by default while allowing explicit override when time-dependent behavior is under test.

---

### F9. No Failure-Injection Tests for Tiered Write Pipeline

**Severity: Medium** | **Affects: Tasks 10-11**

S1-S3's tiered write pipeline is the most complex concurrency addition. Task 10 (DualWriteHook) and Task 11 (SSE wiring integration) don't test failure modes:

| Missing failure test | Production scenario |
|---|---|
| Deferred write fails (SQLite locked) | Another process or long-running read query holds the WAL lock |
| `queueMicrotask` runs after relay stack stop | Daemon shutdown during streaming |
| SYNC_TYPE event arrives while deferred batch pending | Permission asked during tool output streaming |
| SSE reconnect (`onReconnect()`) while deferred writes in-flight | Network flap during active session |

**Required fix:** Add failure-injection tests to Tasks 10-11:

```typescript
describe("tiered write failure isolation", () => {
  it("relay continues when deferred write fails", () => {
    const hook = new DualWriteHook({ persistence: harness.layer });
    // Make append throw for deferred events
    vi.spyOn(harness.eventStore, "append").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });

    const sseEvent = makeSSEEvent("message.part.delta", { ... });
    // Should not throw — error is caught and logged
    expect(() => hook.onSSEEvent(sseEvent, "s1")).not.toThrow();
    // Relay pipeline should still have processed the event
    expect(relayBroadcastSpy).toHaveBeenCalled();
  });

  it("onReconnect() cancels pending deferred writes", () => {
    // Queue deferred events
    hook.onSSEEvent(makeSSEEvent("message.part.delta", { ... }), "s1");
    // Reconnect before microtask runs
    hook.onReconnect();
    // Verify: no stale events written, version cache cleared
    expect(harness.eventStore.resetVersionCache).toHaveBeenCalled();
  });
});
```

---

### F10. No JSONL-to-SQLite Equivalence Contract Test

**Severity: Medium** | **Affects: Phase 4 (read switchover)**

The plan introduces dual-write (Phase 2) and read switchover (Phase 4). The `ShadowReadComparator` provides runtime comparison, but there is no test that feeds a recorded OpenCode interaction through both paths and asserts structural equality.

The existing codebase has 12+ recorded `.opencode.json.gz` fixtures (chat-simple, chat-streaming, chat-tool-call, etc.) designed for exactly this kind of replay testing.

**Required fix:** Add an integration test to Task 24 or as a standalone Phase 4 prerequisite:

```typescript
// test/integration/persistence/dual-read-equivalence.test.ts
describe("JSONL ↔ SQLite read equivalence", () => {
  it("chat-tool-call produces identical read models from both paths", async () => {
    const recording = await loadOpenCodeRecording("chat-tool-call");

    // Path A: existing relay pipeline (JSONL)
    const jsonlHarness = createRelayHarness(recording);
    await jsonlHarness.replay();
    const jsonlSessions = jsonlHarness.sessionMgr.listSessions();
    const jsonlMessages = jsonlHarness.messageCache.getEvents("sess-1");

    // Path B: dual-write pipeline (SQLite)
    const sqliteHarness = createDualWriteHarness(recording);
    await sqliteHarness.replay();
    const sqliteSessions = sqliteHarness.readQuery.listSessions();
    const sqliteMessages = sqliteHarness.readQuery.getSessionMessages("sess-1");

    // Compare structure (ignoring format differences)
    expect(normalizeSessionList(sqliteSessions))
      .toEqual(normalizeSessionList(jsonlSessions));
    expect(normalizeMessages(sqliteMessages))
      .toEqual(normalizeMessages(jsonlMessages));
  });
});
```

This is the highest-leverage integration test for the migration — it validates the entire dual-write-to-read-switchover pipeline using real recorded data.

---

### F11. `as CanonicalEvent` Cast Pattern Throughout Test Code

**Severity: Low-Medium** | **Affects: 14+ test code blocks**

Across the plan, test code uses `as CanonicalEvent` to construct events. R1 introduced `canonicalEvent()` specifically to eliminate these casts. The existing codebase's `arbitraries.ts` and `mock-factories.ts` use typed factory functions. The plan's test code is retrograde.

The `as` cast erases the discriminated union's type-data correspondence. A `type: "session.created"` event could carry `TextDeltaPayload` data and TypeScript would not flag it.

**Required fix:** Ban `as CanonicalEvent` in test code (add to the plan's coding guidelines). All event construction must go through `canonicalEvent()` or a T2 shared factory that calls it internally. Only intentionally-invalid events (testing validation) may use `as unknown as CanonicalEvent` with an explanatory comment.

---

### F12. Property 2 (Projection Convergence) Needs a State Machine Generator

**Severity: Low-Medium** | **Affects: T4.2**

T4's Property 2 (Projection Convergence) acknowledges "use a state machine generator" for valid event sequences, but the generator is not designed.

The existing `arbitraries.ts` generates individual SSE events independently — no state machine for valid sequences. Building one requires tracking:
- Open sessions (must `session.created` before any other session event)
- Active messages per session (must `message.created` before `text.delta`)
- Pending tool calls (must `tool.started` before `tool.running` before `tool.completed`)
- Permission requests (must `permission.asked` before `permission.resolved`)

Without this, the property test will either generate invalid sequences (false failures from validation errors) or be constrained to trivial sequences that don't exercise interesting interleavings.

**Required fix:** Design the generator explicitly:

```typescript
// Sketch of valid canonical event sequence generator
function validEventSequence(maxEvents: number): fc.Arbitrary<CanonicalEvent[]> {
  return fc.commands(
    // Available command generators (state-aware):
    fc.constant(new CreateSessionCommand()),
    fc.constant(new CreateMessageCommand()),
    fc.constant(new EmitTextDeltaCommand()),
    fc.constant(new StartToolCommand()),
    fc.constant(new CompleteToolCommand()),
    fc.constant(new AskPermissionCommand()),
    fc.constant(new ResolvePermissionCommand()),
    fc.constant(new CompleteTurnCommand()),
    // ... etc
  ).map(commands => {
    const state = new SequenceGeneratorState();
    const events: CanonicalEvent[] = [];
    for (const cmd of commands) {
      if (cmd.canRun(state)) {
        events.push(...cmd.run(state));
      }
    }
    return events;
  });
}
```

Each command's `canRun(state)` checks preconditions (e.g., `CompleteToolCommand.canRun` requires an active tool call). This uses fast-check's `fc.commands` model-based testing API, which is purpose-built for exactly this pattern.

---

### F13. No Test Asserting FK Constraints Are RESTRICT (Not CASCADE)

**Severity: Low** | **Affects: Task 3 (schema), Phase 7 (eviction)**

T5 notes the need to test FK cascade behavior. The schema uses `FOREIGN KEY (session_id) REFERENCES sessions(id)` without `ON DELETE CASCADE`, defaulting to RESTRICT. S5's eviction strategy deletes in explicit FK-safe order across 9 tables.

If a future migration adds `ON DELETE CASCADE`, the explicit cascade-order code becomes redundant and potentially dangerous (double-deleting). No test documents this design decision.

**Required fix:** Add a schema assertion test to Task 3:

```typescript
describe("Schema FK constraints", () => {
  it("uses RESTRICT (not CASCADE) for session foreign keys", () => {
    const harness = createTestHarness();
    harness.seedSession("s1");
    harness.db.execute(
      "INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["evt-1", "s1", 0, "session.created", "{}", "opencode", Date.now()],
    );

    // Deleting session with dependent events should fail (RESTRICT)
    expect(() => harness.db.execute("DELETE FROM sessions WHERE id = ?", ["s1"]))
      .toThrow(/FOREIGN KEY constraint/);

    harness.close();
  });

  it("documents FK RESTRICT as deliberate — eviction must delete dependents first", () => {
    // This test exists to prevent future migrations from adding ON DELETE CASCADE.
    // S5 eviction deletes in FK-safe order: activities → pending_approvals →
    // message_parts → messages → turns → session_providers → tool_content →
    // provider_state → sessions. CASCADE would bypass this ordering.
    const harness = createTestHarness();

    // Verify all FK-constrained tables RESTRICT on session deletion
    const fkTables = [
      "events", "messages", "turns", "activities",
      "pending_approvals", "session_providers", "tool_content", "provider_state",
    ];

    for (const table of fkTables) {
      harness.seedSession("s-fk-test");
      // Seed a row in the dependent table
      // ... (table-specific INSERT)
      expect(() => harness.db.execute("DELETE FROM sessions WHERE id = ?", ["s-fk-test"]))
        .toThrow(/FOREIGN KEY/);
      // Clean up for next iteration
      harness.db.execute(`DELETE FROM ${table} WHERE session_id = ?`, ["s-fk-test"]);
      harness.db.execute("DELETE FROM sessions WHERE id = ?", ["s-fk-test"]);
    }

    harness.close();
  });
});
```

---

### F14. No Unit Test for `resetVersionCache()`

**Severity: Low** | **Affects: Task 5**

Task 5's EventStore uses an in-memory `versionCache`. Tests create fresh instances per test, so the cache is always empty. No test verifies that `resetVersionCache()` actually clears primed state and that subsequent appends work correctly with a cleared cache.

**Required fix:** Add to Task 5's test:

```typescript
describe("resetVersionCache", () => {
  it("clears cached versions and falls back to DB query", () => {
    seedSession(client, "s1");
    store.append(makeSessionCreatedEvent("s1"));
    store.append(makeTextDelta("s1", "m1", "a"));
    store.append(makeTextDelta("s1", "m1", "b"));
    // Cache now has s1 → 3

    store.resetVersionCache();

    // Next append should query DB for current max version, not use stale cache
    const e4 = store.append(makeTextDelta("s1", "m1", "c"));
    expect(e4.streamVersion).toBe(3); // Correct: 0, 1, 2, then 3
    expect(e4.sequence).toBe(4);
  });

  it("handles reset with empty store", () => {
    store.resetVersionCache();
    seedSession(client, "s1");
    const e1 = store.append(makeSessionCreatedEvent("s1"));
    expect(e1.streamVersion).toBe(0);
  });
});
```

---

## Summary Table

| # | Finding | Severity | Type | Affected Tasks |
|---|---------|----------|------|----------------|
| F1 | T1 wiring tests declared but no code written | **High** | Missing code | 24.5, 26, 28, 30 |
| F2 | T2 shared factories have no task slot | **High** | Structural gap | All persistence tests |
| F3 | `makeSSEEvent` accepts untyped string | **High** | Type safety | 7, all SSE tests |
| F4 | Test factories bypass `canonicalEvent()` | Medium | Type safety | 5, 7, 9, 10+ |
| F5 | Missing EventStore boundary tests | Medium | Edge cases | 5 |
| F6 | T4 missing eviction + pipeline properties | Medium | Property tests | Phase 7, Phase 2 |
| F7 | Test helpers produce schema-violating data | Medium | Data integrity | 5, 6, 8, 9 |
| F8 | Snapshot tests have non-deterministic timestamps | Medium | Determinism | 15-20 |
| F9 | No failure-injection tests for tiered pipeline | Medium | Negative path | 10, 11 |
| F10 | No JSONL↔SQLite equivalence contract test | Medium | Integration | Phase 4 |
| F11 | `as CanonicalEvent` cast pattern in tests | Low-Med | Type safety | 14+ code blocks |
| F12 | Property 2 needs state machine generator | Low-Med | Generator design | T4.2 |
| F13 | No FK RESTRICT assertion test | Low | Schema safety | 3, Phase 7 |
| F14 | No `resetVersionCache()` unit test | Low | Coverage gap | 5 |

### Dependency Order for Fixes

1. **F2 first** — create the shared factory task slot. All other fixes depend on shared factories existing.
2. **F3 + F4 + F8** — fix the factory type safety and determinism issues in the shared factories.
3. **F1** — write wiring test code (requires shared factories from F2).
4. **F5 + F14** — add missing boundary tests to Task 5.
5. **F7 + F11** — fix schema violations and ban `as CanonicalEvent` in test code.
6. **F9 + F10** — add failure-injection and equivalence tests.
7. **F6 + F12 + F13** — add property specs and schema assertion tests.

---

## Amendment to the Plan

Apply the following entry to the plan's Amendment History table:

| Date | Source Document | Summary |
|------|----------------|---------|
| 2026-04-07 | `docs/plans/2026-04-07-orchestrator-testing-strategy-audit.md` | 14 findings on testing strategy: T1-T2 amendments declared but not applied to task code (F1, F2), `makeSSEEvent` type safety (F3), `as CanonicalEvent` cast pattern (F4, F11), missing boundary tests (F5, F14), missing PBT properties (F6, F12), schema-violating test data (F7), non-deterministic snapshots (F8), no failure-injection tests for tiered pipeline (F9), no JSONL-SQLite equivalence test (F10), no FK RESTRICT assertion (F13). |
