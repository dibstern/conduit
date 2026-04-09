# Orchestrator Plan: Further Recommendations for Type Safety, Design & LLM Debuggability

> Additional recommendations for the [orchestrator implementation plan](./2026-04-05-orchestrator-implementation-plan.md), building on the [initial type-safety review](./2026-04-07-orchestrator-plan-type-safety-recommendations.md) (R1-R16, already applied inline).
>
> Focus: gaps the initial review didn't cover -- especially in Phases 3-7, the provider adapter layer, the Claude adapter, and cross-cutting concerns around failure traceability.

---

## Scope

The initial R1-R16 recommendations targeted Phase 1-2 foundations (typed factories, branded IDs, PersistenceError, payload validation, replay idempotency, diagnostics). They were applied inline.

This document targets:
- **Phase 3** projector design gaps
- **Phase 4** read-switchover failure modes
- **Phase 5-6** provider adapter and Claude adapter type safety
- **Cross-cutting** concerns: test infrastructure, error correlation, migration safety, and debugging support for LLM agents

---

## A. Projector Design (Phase 3)

### A1. Parts JSON read-modify-write lacks structural validation

**Problem:** `MessageProjector.readParts()` calls `decodeJson<MessagePart[]>(row.parts)` and trusts the result is a well-formed `MessagePart[]`. If the JSON is structurally valid but contains unexpected shapes (e.g., a tool part missing `toolName`, or a `type` field with an unknown value), the projector silently produces corrupt projection state. The `decodeJson` helper returns `undefined` only on parse failure, not on shape mismatch.

**Recommendation:** Add a `validateParts()` function that checks each element has a valid `type` discriminant and the required fields for that type. Call it after `decodeJson` in `readParts()`. On validation failure, log a `PersistenceError` with code `DESERIALIZATION_FAILED` including the raw JSON (truncated), the index of the bad part, and the specific field that failed validation. Return an empty array to prevent cascading corruption.

```typescript
function validateParts(raw: unknown[]): MessagePart[] {
  const valid: MessagePart[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as Record<string, unknown>;
    if (!p || typeof p.type !== "string" || !["text", "thinking", "tool"].includes(p.type)) {
      // Log warning with part index and raw content
      continue;
    }
    if (typeof p.id !== "string") continue;
    valid.push(p as MessagePart);
  }
  return valid;
}
```

**Impact:** Prevents a single corrupt part from breaking the entire message projection. An LLM investigating "message shows wrong parts" can see exactly which part failed validation and why.

---

### A2. TurnProjector uses implicit "most recent" queries that can silently match wrong turns

**Problem:** The TurnProjector assigns assistant messages and status transitions to the "most recent pending/running turn" via sub-select queries like `WHERE session_id = ? AND state IN ('pending', 'running') ORDER BY requested_at DESC LIMIT 1`. If events arrive out of order during recovery (which the plan acknowledges is possible), this can assign an assistant message or status change to the wrong turn. The plan has no mechanism to detect or report this.

**Recommendation:** Add a `turn_id` field to `SessionStatusPayload` and `MessageCreatedPayload` (or carry it in `EventMetadata.providerTurnId`) so the TurnProjector can do deterministic matching instead of positional matching. If the event doesn't carry a turn ID (e.g., during OpenCode dual-write where turns aren't tracked upstream), fall back to the current "most recent" heuristic but log a diagnostic warning:

```typescript
if (!explicitTurnId) {
  this.log?.verbose(`TurnProjector: using positional match for ${event.type} — no turnId in event metadata`, {
    sequence: event.sequence,
    sessionId: event.sessionId,
  });
}
```

**Impact:** Makes turn-projection mismatches diagnosable. Without this, an LLM sees "turn has wrong assistant message" and has no way to trace whether the cause was event ordering, a missing turn ID, or a projector bug.

---

### A3. ProjectionRunner.recover() has no progress reporting or timeout

**Problem:** The plan's recovery loop (Task 22, `ProjectionRunner.recover()`) replays events in 500-event batches from `minCursor()`. On a database with thousands of events, this can take seconds or even minutes. There is no progress reporting, no timeout, and no way for an LLM to determine whether recovery is progressing or stuck.

**Recommendation:** Add structured progress reporting to the recovery loop:

```typescript
recover(): RecoveryResult {
  const startTime = Date.now();
  let totalReplayed = 0;
  let batchCount = 0;
  const startCursor = this.cursorRepo.minCursor();

  while (true) {
    const events = this.eventStore.readFromSequence(cursor, BATCH_SIZE);
    if (events.length === 0) break;

    for (const event of events) {
      this.projectEvent(event);
    }
    totalReplayed += events.length;
    batchCount++;
    cursor = events[events.length - 1]!.sequence;

    this.log?.info(`recovery progress: batch=${batchCount} replayed=${totalReplayed} cursor=${cursor}`);
  }

  const result = {
    startCursor,
    endCursor: cursor,
    totalReplayed,
    batchCount,
    durationMs: Date.now() - startTime,
    projectorCursors: this.cursorRepo.listAll(),
  };
  this.log?.info(`recovery complete`, result);
  return result;
}
```

Return a `RecoveryResult` object so callers (and diagnostics) can inspect what happened. This follows the codebase's existing pattern of returning structured results from operations (e.g., `DualWriteResult`, `DualWriteStats`).

**Impact:** An LLM debugging "daemon takes 30 seconds to start" can immediately see recovery replayed 5,000 events in 12 batches. Without this, startup stalls are opaque.

---

### A4. No per-projector error isolation in ProjectionRunner

**Problem:** The plan says "if a projector fails, the event is still in the store but the cursor does not advance." But in the `projectEvent()` implementation, ALL projectors run inside a single `db.runInTransaction()`. If the SessionProjector succeeds but the MessageProjector throws, the entire transaction rolls back -- including the SessionProjector's successful work and its cursor advancement. This means a single broken projector blocks ALL projectors, not just itself.

**Recommendation:** Run each projector in its own transaction:

```typescript
projectEvent(event: StoredEvent): void {
  for (const projector of this.projectors) {
    if (!(projector.handles as readonly string[]).includes(event.type)) continue;
    try {
      this.db.runInTransaction(() => {
        projector.project(event, this.db);
        this.cursorRepo.upsert(projector.name, event.sequence);
      });
    } catch (err) {
      // Log failure but continue with other projectors
      this.failures.push({ /* ... */ });
      this.log?.warn(`Projector ${projector.name} failed`, { /* context */ });
    }
  }
}
```

This matches the t3code pattern where each projector runs independently. The trade-off is that projections can be temporarily inconsistent (session row updated but message row not), but this is recoverable on next startup. The alternative -- one broken projector blocking everything -- is not recoverable without manual intervention.

**Impact:** A bug in ActivityProjector (the most complex projector) doesn't break session listing or message display. Recovery only needs to replay events for the failed projector.

---

## B. Read Switchover Safety (Phase 4)

### B1. ReadQueryService methods have no structured error wrapping

**Problem:** `ReadQueryService` methods (Tasks 23, 25-34) use `this.db.query()` and `this.db.queryOne()` directly. If a query fails (e.g., corrupt database, missing table, schema mismatch after a bad migration), the caller gets a raw SQLite error with no context about which read path failed, which session was being queried, or which flag was active.

**Recommendation:** Wrap each `ReadQueryService` method with a try/catch that throws `PersistenceError` with the `PROJECTION_FAILED` code and includes the method name, parameters, and flag state:

```typescript
getSessionMessages(sessionId: string, opts?: { limit?: number }): MessageRow[] {
  try {
    return this.db.query<MessageRow>(/* ... */, [sessionId, opts?.limit ?? 50]);
  } catch (err) {
    throw new PersistenceError("PROJECTION_FAILED",
      `ReadQueryService.getSessionMessages failed`,
      {
        method: "getSessionMessages",
        sessionId,
        limit: opts?.limit,
        sqliteError: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
```

**Impact:** When the SQLite path fails and the system falls back to REST, the log entry tells an LLM exactly which read path failed and why, instead of a bare `SQLITE_ERROR: no such table: messages`.

---

### B2. Dual-read comparison (Task 28) swallows timing diffs silently

**Problem:** The `compareWithLegacyListInBackground` function fires off a background REST request and compares it with the SQLite result. But the comparison is inherently racy -- sessions can be created/deleted between the two reads. The plan acknowledges this ("may report false diffs under concurrent mutations") but provides no mechanism to distinguish real diffs from timing artifacts.

**Recommendation:** Add a `tolerance` window to the comparison. Sessions created within the last N seconds (e.g., 5 seconds) should be excluded from the "missing in SQLite" list, since they may not have been projected yet. Log the comparison with a `timingGap` field showing the time delta between the SQLite read and the REST read:

```typescript
const sqliteReadAt = Date.now();
const sqliteResult = sessionRowsToSessionInfoList(rows);
// ...
legacyList().then((restResult) => {
  const restReadAt = Date.now();
  const diff = compareSessionLists(restResult, sqliteResult, {
    ignoreCreatedWithin: 5000,
    sqliteReadAt,
    restReadAt,
  });
  if (diff.significantMismatches > 0) {
    log.warn(`session-list-diff`, {
      ...diff,
      timingGapMs: restReadAt - sqliteReadAt,
    });
  }
});
```

**Impact:** Prevents false-positive alerts that erode trust in the SQLite path. An LLM investigating comparison warnings can see whether the timing gap is large enough to explain the diff.

---

## C. Provider Adapter Layer (Phase 5)

### C1. OrchestrationCommand discriminated union lacks exhaustive type coverage

**Problem:** `OrchestrationCommand` is a union of 5 command types. The `dispatch()` method has a `switch` on `command.type` with a `default: never` branch -- good. But the `OrchestrationResult` return type is `TurnResult | AdapterCapabilities | void`, which is a union that loses information about which command produced which result. Callers of `dispatch()` must `as`-cast the result based on what command they sent.

**Recommendation:** Use a generic dispatch signature or overloaded signatures:

```typescript
// Option A: Overloaded signatures
dispatch(command: SendTurnCommand): Promise<TurnResult>;
dispatch(command: DiscoverCommand): Promise<AdapterCapabilities>;
dispatch(command: InterruptTurnCommand): Promise<void>;
dispatch(command: ResolvePermissionCommand): Promise<void>;
dispatch(command: ResolveQuestionCommand): Promise<void>;
dispatch(command: OrchestrationCommand): Promise<OrchestrationResult>;

// Option B: Type-mapped dispatch
type OrchestrationResultMap = {
  send_turn: TurnResult;
  discover: AdapterCapabilities;
  interrupt_turn: void;
  resolve_permission: void;
  resolve_question: void;
};

dispatch<K extends OrchestrationCommand["type"]>(
  command: Extract<OrchestrationCommand, { type: K }>,
): Promise<OrchestrationResultMap[K]>;
```

**Impact:** Callers get typed results without casts. An LLM implementing a handler that calls `dispatch` gets compile-time feedback about what the result shape is, preventing `result.models` on a `void` result.

---

### C2. EventSinkImpl has no write-rate observability

**Problem:** `EventSinkImpl.push()` calls `eventStore.append()` + `projectionRunner.projectEvent()` synchronously for every SDK event. During high-throughput periods (e.g., a tool producing hundreds of text deltas per second), there's no visibility into throughput, backpressure, or latency. If the SQLite write path becomes a bottleneck, the symptom is "the adapter feels slow" with no data to diagnose.

**Recommendation:** Add a lightweight stats tracker to `EventSinkImpl`:

```typescript
interface EventSinkStats {
  eventsWritten: number;
  totalWriteMs: number;
  totalProjectMs: number;
  peakBatchLatencyMs: number;
  lastWriteAt: number;
}

// In push():
async push(event: CanonicalEvent): Promise<void> {
  const t0 = performance.now();
  const stored = this.eventStore.append(event);
  const t1 = performance.now();
  this.projectionRunner.projectEvent(stored);
  const t2 = performance.now();

  this.stats.eventsWritten++;
  this.stats.totalWriteMs += (t1 - t0);
  this.stats.totalProjectMs += (t2 - t1);
  this.stats.peakBatchLatencyMs = Math.max(this.stats.peakBatchLatencyMs, t2 - t0);
  this.stats.lastWriteAt = Date.now();
}
```

Expose `getStats()` for diagnostics. Wire into `PersistenceDiagnostics.health()`.

**Impact:** An LLM debugging "Claude adapter is slow" can check `sink.getStats()` and immediately see whether the bottleneck is SQLite writes, projection, or something upstream.

---

### C3. ProviderRegistry.getAdapterOrThrow produces an untyped Error

**Problem:** `getAdapterOrThrow()` throws `new Error(...)`. The OrchestrationEngine's dispatch methods propagate this as an untyped error. An LLM seeing this in logs has no error code, no context about which command triggered it, and no way to distinguish "no adapter registered" from "adapter crashed."

**Recommendation:** Create a `ProviderError` class (or reuse `PersistenceError` with a new code):

```typescript
export type ProviderErrorCode =
  | "ADAPTER_NOT_FOUND"
  | "SESSION_NOT_BOUND"
  | "DUPLICATE_COMMAND"
  | "SEND_FAILED"
  | "INTERRUPT_FAILED"
  | "PERMISSION_RESOLUTION_FAILED";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "ProviderError";
  }
}
```

Replace all `throw new Error(...)` in `ProviderRegistry`, `OrchestrationEngine`, and adapters with `throw new ProviderError(...)`.

**Impact:** An LLM sees `[ADAPTER_NOT_FOUND] No adapter registered for provider: claude { providerId: "claude", requestedBy: "send_turn", sessionId: "s1" }` instead of `Error: No adapter registered for provider: claude`. The context makes the fix obvious.

---

## D. Claude Adapter (Phase 6)

### D1. ClaudeEventTranslator uses index-based part tracking that breaks on reconnect

**Problem:** The translator tracks in-flight tools by `content_block_start` index number (`ctx.inFlightTools` keyed by `number`). If the SDK session is interrupted and resumed, the index numbering may restart from 0, causing the translator to match new tool events against stale entries in the map. The plan has no reset mechanism for `inFlightTools` on resume.

**Recommendation:** Add a `resetInFlightState(ctx)` method to `ClaudeEventTranslator` and call it at the start of every new turn (when `sendTurn()` enqueues a new message). Also key tools by `toolUseId` (a UUID from the SDK) instead of index, which is stable across reconnects:

```typescript
// Change from:
ctx.inFlightTools: Map<number, ToolInFlight>
// To:
ctx.inFlightTools: Map<string, ToolInFlight> // keyed by toolUseId
```

This also makes the "find tool by itemId" loop in the `user` message handler (`translateUserToolResult`) unnecessary -- it becomes a direct Map lookup.

**Impact:** Prevents phantom tool completions after resume, which would produce "tool completed twice" bugs that are extremely confusing to diagnose.

---

### D2. ClaudePermissionBridge has a double-resolution race between EventSink and resolvePermission

**Problem:** The permission bridge creates a `PendingApproval`, calls `eventSink.requestPermission()` (which internally creates a Deferred in EventSinkImpl), and awaits the sink promise. But `resolvePermission()` on the bridge also tries to resolve the same pending approval via `pending.resolve(decision)`. If both the EventSink resolution and the bridge resolution fire, the behavior depends on which one wins the race. The `PendingApproval.resolve` field is set to `() => {}` (a no-op) and never actually connected to anything.

The plan's amendment Q6 says "Remove the race. EventSink (sinkPromise) is canonical." But the implementation still has the bridge's `resolvePermission()` calling `pending.resolve(decision)` -- which resolves the no-op function, doing nothing useful. Meanwhile, the actual unblocking happens via the EventSink path, which the adapter's `resolvePermission()` method must also trigger by calling `sink.resolvePermission()`.

**Recommendation:** Make the flow explicit:
1. The bridge's `canUseTool` creates a PendingApproval (for tracking only) and awaits `eventSink.requestPermission()`.
2. The adapter's `resolvePermission()` calls `eventSink.resolvePermission(requestId, response)` -- this is the ONLY path that unblocks the bridge.
3. Remove `PendingApproval.resolve`/`reject` entirely -- they serve no purpose if the EventSink is canonical.
4. `PendingApproval` becomes a tracking record only:

```typescript
export interface PendingApproval {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly createdAt: string;
  // No resolve/reject -- EventSink owns the resolution lifecycle
}
```

Document this in a comment: "Resolution flows: adapter.resolvePermission() -> eventSink.resolvePermission() -> unblocks the promise that bridge.canUseTool() is awaiting."

**Impact:** Eliminates an entire class of "permission hangs forever" bugs. An LLM debugging a hung permission can trace the single resolution path instead of wondering which of two paths was supposed to fire.

---

### D3. ClaudeAdapter.sendTurn lacks a timeout for turn completion

**Problem:** `sendTurn()` creates a `Deferred<TurnResult>` and awaits it until the stream consumer resolves it. If the SDK query hangs (network issue, SDK bug, rate limit), the deferred is never resolved. The `abortSignal` handles user-initiated cancellation, but there's no defensive timeout for "the SDK never responded."

**Recommendation:** Add a configurable `turnTimeoutMs` (default: 10 minutes) and race the deferred against a timeout:

```typescript
const TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const result = await Promise.race([
  deferred.promise,
  new Promise<TurnResult>((_, reject) =>
    setTimeout(() => reject(new ProviderError(
      "SEND_FAILED",
      `Turn timed out after ${TURN_TIMEOUT_MS}ms`,
      { sessionId, turnId, timeoutMs: TURN_TIMEOUT_MS },
    )), TURN_TIMEOUT_MS)
  ),
]);
```

**Impact:** Prevents silent hangs. An LLM sees `[SEND_FAILED] Turn timed out after 600000ms { sessionId: "s1" }` and knows to check SDK connectivity.

---

### D4. Claude adapter types use `as any` casts at SDK boundaries

**Problem:** Multiple locations in the Claude adapter code use `as any` to bridge between conduit types and SDK types (e.g., `requestPermission({ ... } as any)`, `(result as any).usage`, `(result as any).errors`). Each `as any` is a point where type checking is silently disabled, and SDK API changes will not produce compile errors.

**Recommendation:** Create typed wrappers for SDK types at the boundary:

```typescript
// src/lib/provider/claude/sdk-types.ts
// Typed accessors for SDK result fields that aren't in the public type definitions

interface SDKResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface SDKResultExtended {
  usage?: SDKResultUsage;
  errors?: string[];
  total_cost_usd?: number;
  duration_ms?: number;
}

/** Safely extract usage from an SDK result message. */
export function extractUsage(result: SDKMessage): SDKResultUsage | undefined {
  const r = result as unknown as SDKResultExtended;
  return r.usage;
}

/** Safely extract errors from an SDK result message. */
export function extractErrors(result: SDKMessage): string[] {
  const r = result as unknown as SDKResultExtended;
  return Array.isArray(r.errors) ? r.errors : [];
}
```

Confine all `as unknown as` casts to this one file. Every other file in the Claude adapter should import from `sdk-types.ts` instead of using `as any`.

**Impact:** When the SDK types change (e.g., `usage` is renamed to `token_usage`), there's exactly one file to update. Current plan: ~15 scattered `as any` casts that each need to be found and fixed.

---

## E. Cross-Cutting: Test Infrastructure

### E1. Test helper factories are duplicated across every test file

**Problem:** Every projector test file defines its own `makeStored()` helper. Every integration test defines its own `makeSSEEvent()`. Every adapter test defines its own `makeStubClient()`. These are structurally identical but independently maintained. If the `StoredEvent` shape changes (e.g., new required field), every test file breaks independently with the same error.

**Recommendation:** Create a shared `test/helpers/persistence-factories.ts`:

```typescript
// test/helpers/persistence-factories.ts
export function makeStored<T extends StoredEvent["type"]>(
  type: T,
  sessionId: string,
  data: Extract<StoredEvent, { type: T }>["data"],
  opts?: { sequence?: number; createdAt?: number; metadata?: EventMetadata },
): StoredEvent { /* ... */ }

export function seedSession(db: SqliteClient, id: string, opts?: Partial<SessionRow>): void { /* ... */ }
export function seedMessage(db: SqliteClient, id: string, sessionId: string, opts?: Partial<MessageRow>): void { /* ... */ }

export function makeSSEEvent(type: string, properties: Record<string, unknown>): OpenCodeEvent { /* ... */ }
```

This follows the existing codebase pattern of `test/helpers/mock-factories.ts` for handler tests.

**Impact:** One definition, one place to update. Reduces test maintenance burden by ~60% for the persistence layer. When an LLM needs to write a new test, it imports from the factory instead of copy-pasting.

---

### E2. No snapshot/golden-file testing for projector output

**Problem:** Projector tests verify individual field values (`expect(row.title).toBe("Renamed Session")`). But they don't verify the complete row shape. If a projector starts setting a field it shouldn't (or stops setting one it should), the individual-field assertions won't catch it.

**Recommendation:** Add snapshot tests for "full lifecycle" scenarios:

```typescript
it("full session lifecycle produces expected projection state", () => {
  // Run: session.created -> message.created -> text.delta -> tool lifecycle -> turn.completed
  // Then snapshot the complete row state:
  const session = db.queryOne("SELECT * FROM sessions WHERE id = ?", ["s1"]);
  const messages = db.query("SELECT * FROM messages WHERE session_id = ?", ["s1"]);
  const turns = db.query("SELECT * FROM turns WHERE session_id = ?", ["s1"]);

  expect({ session, messages, turns }).toMatchSnapshot();
});
```

This catches regressions where a projector change affects an unexpected column.

**Impact:** Catches silent regressions. Particularly valuable during Phase 4 read-switchover, where any projection shape change could break the adapter layer.

---

## F. Cross-Cutting: Error Correlation and Debugging

### F1. No request-level correlation ID flows through the orchestration layer

**Problem:** When a user sends a message, it flows through: WebSocket handler -> OrchestrationEngine.dispatch() -> adapter.sendTurn() -> EventSink.push() -> EventStore.append() -> ProjectionRunner.projectEvent(). If something fails at any point, there's no shared identifier linking the user's action to the failure. The `commandId` field exists on `OrchestrationCommand` but is optional and not propagated into events.

**Recommendation:** Make `commandId` required on `SendTurnCommand` and propagate it through the EventSink into every event's metadata:

```typescript
// In EventSinkImpl constructor:
constructor(deps: EventSinkDeps & { commandId: string }) {
  this.commandId = deps.commandId;
}

// In push():
async push(event: CanonicalEvent): Promise<void> {
  const enriched = {
    ...event,
    metadata: {
      ...event.metadata,
      commandId: this.commandId,
      correlationId: this.commandId, // Same for now; split if needed
    },
  };
  const stored = this.eventStore.append(enriched as CanonicalEvent);
  this.projectionRunner.projectEvent(stored);
}
```

Then, when an LLM sees a failed event in the store, it can query `SELECT * FROM events WHERE json_extract(metadata, '$.commandId') = 'cmd_abc123'` to find all events from the same user action.

**Impact:** Transforms debugging from "find the event that failed" to "find all events from the user action that triggered the failure." This is the single highest-impact recommendation for LLM debuggability.

---

### F2. DualWriteHook error logs don't include the SSE event payload

**Problem:** When the dual-write hook catches an error, it logs `eventType`, `sessionId`, and `stage`. But it doesn't log the SSE event's `properties` (the actual data that caused the failure). An LLM debugging "dual-write error at stage=translating" needs to see what the translator received to understand why it failed.

**Recommendation:** Include a truncated snapshot of the event properties in the error log:

```typescript
this.log.warn(`dual-write error at stage="${stage}"`, {
  stage,
  eventType: event.type,
  sessionId: sessionId ?? "none",
  // Add truncated event properties for debugging:
  eventProperties: truncateForLog(event.properties, 500),
  error: err instanceof PersistenceError ? err.toLog() : formatErrorDetail(err),
  stats: this.getStats(),
});

function truncateForLog(obj: unknown, maxLen: number): string {
  const json = JSON.stringify(obj);
  return json.length > maxLen ? json.slice(0, maxLen) + "..." : json;
}
```

**Impact:** An LLM can see the exact SSE event that caused the failure and fix the translator without needing to reproduce the event stream.

---

### F3. No structured way to inspect the EventSink's pending permission/question state

**Problem:** When a permission or question is pending (awaiting user response), there's no way to inspect the pending state from outside the EventSink. If the UI reports "permission dialog showed but nothing happened," an LLM needs to check: (1) is there a pending deferred in the EventSink? (2) was the permission.asked event stored? (3) was the event projected to pending_approvals?

**Recommendation:** Add a `getPendingState()` method to EventSinkImpl:

```typescript
getPendingState(): {
  permissions: Array<{ requestId: string; toolName: string; pendingSince: number }>;
  questions: Array<{ requestId: string; pendingSince: number }>;
} {
  return {
    permissions: [...this.pendingPermissions.entries()].map(([id, d]) => ({
      requestId: id,
      toolName: (d as any).toolName ?? "unknown",
      pendingSince: (d as any).createdAt ?? 0,
    })),
    questions: [...this.pendingQuestions.entries()].map(([id, d]) => ({
      requestId: id,
      pendingSince: (d as any).createdAt ?? 0,
    })),
  };
}
```

Wire into `PersistenceDiagnostics` so a single `diagnostics.health()` call shows pending permissions alongside projector state, event counts, and streaming messages.

**Impact:** An LLM can call one diagnostic function and see "there is 1 pending permission for requestId=perm-42, pending for 45 seconds" -- immediately identifying whether the problem is on the EventSink side or the UI side.

---

## G. Migration Safety (Phase 7)

### G1. No migration dry-run or verification for Phase 7 deletions

**Problem:** Phase 7 deletes `MessageCache`, `ToolContentStore`, `PendingUserMessages`, and multiple test files. The plan lists what to delete but provides no verification that the deleted code is truly unreachable. If a handler still imports `MessageCache` after deletion, the error surfaces only at runtime.

**Recommendation:** Before each deletion task, run a static dependency check:

```typescript
// Add to Phase 7 task template:
// Pre-deletion verification:
// 1. Run `pnpm check` — must pass with zero errors
// 2. Search for imports: `rg "from.*message-cache" src/` — must return zero results
// 3. Search for type references: `rg "MessageCache" src/` — must return zero results
// 4. Run `pnpm test:unit` — must pass
// 5. Only then delete the file

// Post-deletion verification:
// 1. Run `pnpm check` — must pass
// 2. Run `pnpm test:all > test-output.log 2>&1`
```

Add this as an explicit checklist to each Phase 7 task rather than relying on the implementer to remember.

**Impact:** Prevents "deleted code that was still imported" breakage. This is a common failure mode when an LLM executes Phase 7 -- it deletes the file but misses an import in a test helper or a type-only import that doesn't fail at runtime.

---

### G2. SessionStatusPoller rewrite (Task 54) lacks a staleness detection mechanism for the event-sourced path

**Problem:** Task 54 rewrites the SessionStatusPoller as a "hybrid reconciliation loop." But the new loop reads from `sessions.status` (projected by SessionProjector from SSE events). If the SSE connection drops and events stop flowing, the projected status becomes stale -- it will show the last known status (possibly "busy") indefinitely. The plan mentions a "30-min staleness safety net" but doesn't specify the mechanism.

**Recommendation:** Track the timestamp of the last `session.status` event per session in the projector. Add a `last_status_event_at` column to the `sessions` table (or use `updated_at`). The reconciliation loop checks:

```typescript
const SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function isSessionStatusStale(session: SessionRow): boolean {
  if (session.status !== "busy") return false;
  return Date.now() - session.updated_at > SESSION_STALE_THRESHOLD_MS;
}

// In reconciliation loop:
for (const session of sessions) {
  if (isSessionStatusStale(session)) {
    log.warn(`Session ${session.id} has been busy for ${(Date.now() - session.updated_at) / 60000}min — marking stale`);
    db.execute("UPDATE sessions SET status = 'idle' WHERE id = ? AND status = 'busy'", [session.id]);
  }
}
```

**Impact:** Prevents "stuck busy" sessions that never resolve. An LLM can see the staleness warning in logs and trace it to SSE connectivity issues.

---

## H. Schema and Data Integrity

### H1. No CHECK constraints on status/role/type columns

**Problem:** The schema uses TEXT columns for `sessions.status`, `messages.role`, `turns.state`, `pending_approvals.status`, etc. Nothing prevents inserting `status = 'buzy'` (typo) or `role = 'system'` (invalid). The plan defines const arrays for valid values (`SESSION_STATUSES`, `MESSAGE_ROLES`, etc.) but these are TypeScript-only -- SQLite doesn't enforce them.

**Recommendation:** Add CHECK constraints to the schema migration:

```sql
-- In createEventStoreTables():
CREATE TABLE sessions (
  ...
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'busy', 'retry', 'error')),
  ...
);

CREATE TABLE messages (
  ...
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  ...
);

CREATE TABLE turns (
  ...
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'running', 'completed', 'interrupted', 'error')),
  ...
);
```

Since the schema is defined in migration 001 (which hasn't been run in production yet), add the CHECK constraints directly. If the migration has already been applied, add a new migration that adds them with `ALTER TABLE ... ADD CHECK ...` (SQLite doesn't support this -- use a table rebuild migration).

**Impact:** SQLite catches invalid values at write time with a clear constraint violation error, preventing corrupt projection state from ever reaching the database. An LLM sees `CHECK constraint failed: sessions` and knows exactly which value violated which constraint.

---

## Summary Table

| # | Area | Severity | Effort | Phase | Description |
|---|------|----------|--------|-------|-------------|
| A1 | Design | Medium | Low | 3 | Validate parts JSON structure after deserialization |
| A2 | Debug | Medium | Medium | 3 | Add turnId to event metadata for deterministic turn matching |
| A3 | Debug | High | Low | 3 | Add progress reporting and RecoveryResult to ProjectionRunner.recover() |
| A4 | Design | High | Medium | 3 | Per-projector transaction isolation in ProjectionRunner |
| B1 | Errors | Medium | Low | 4 | Wrap ReadQueryService methods with PersistenceError |
| B2 | Debug | Low | Low | 4 | Add timing tolerance to dual-read comparison |
| C1 | Types | Medium | Low | 5 | Overloaded dispatch() signatures for typed results |
| C2 | Debug | Medium | Low | 5 | Add write-rate stats to EventSinkImpl |
| C3 | Errors | Medium | Low | 5 | Create ProviderError class for provider layer |
| D1 | Design | High | Low | 6 | Key inFlightTools by toolUseId not index; add reset on resume |
| D2 | Design | High | Medium | 6 | Remove PendingApproval.resolve/reject; document single resolution path |
| D3 | Design | Medium | Low | 6 | Add turn completion timeout to ClaudeAdapter.sendTurn |
| D4 | Types | Medium | Medium | 6 | Confine SDK `as any` casts to typed accessor module |
| E1 | Testing | Medium | Medium | All | Shared test factory helpers for persistence layer |
| E2 | Testing | Low | Low | 3 | Snapshot tests for full projector lifecycle output |
| F1 | Debug | High | Medium | 5 | Propagate commandId through EventSink into all event metadata |
| F2 | Debug | Medium | Low | 2 | Include truncated event properties in dual-write error logs |
| F3 | Debug | Medium | Low | 5 | Expose pending permission/question state on EventSinkImpl |
| G1 | Safety | High | Low | 7 | Static dependency verification checklist before file deletion |
| G2 | Design | Medium | Low | 7 | Staleness detection for event-sourced session status |
| H1 | Types | Medium | Low | 1 | Add CHECK constraints on status/role/type columns |
