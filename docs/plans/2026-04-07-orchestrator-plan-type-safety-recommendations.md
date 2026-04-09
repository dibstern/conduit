# Orchestrator Plan: Type Safety, Design & Debuggability Recommendations

> Recommendations for improving the [orchestrator implementation plan](./2026-04-05-orchestrator-implementation-plan.md) with stronger type assurances, better design, and easier debugging — especially for LLM agents diagnosing failures.

---

## Overview

The plan is architecturally sound. These recommendations target a specific class of problems: situations where things go wrong silently, where type casts hide bugs, and where error messages don't carry enough context for an LLM to diagnose the issue without manual spelunking.

The existing conduit codebase has strong patterns the persistence layer should adopt: branded types (`RequestId`, `PermissionId`), a `RelayError` hierarchy with structured context and error codes, `assertNever()` for exhaustive switches, compile-time exhaustiveness assertions (see `event-translator.ts:41-69`), and `formatErrorDetail()` for log-safe error rendering. The plan's persistence code uses none of these.

---

## 1. Eliminate `as CanonicalEvent` Casts with Typed Factory Functions

**Problem:** The plan uses `as CanonicalEvent` in 6+ locations: `makeEvent()` in the translator (`canonical-event-translator.ts:3432`), `rowToStoredEvent()` in the event store (`event-store.ts:2090`), every test helper, and the DualWriteHook's synthetic session.created (`dual-write-hook.ts:4296`). The `CanonicalEvent` type is a proper discriminated union (lines 1499-1509), but because it's a distributed conditional type mapped over `CanonicalEventType`, TypeScript can't narrow it from object literals. Every `as CanonicalEvent` cast silently disables the type checking that the discriminated union was designed to provide.

**Recommendation:** Create typed factory functions that enforce payload/type correspondence at the call site:

```typescript
// events.ts — add typed event constructors

/** Create a canonical event with compile-time payload checking. */
export function canonicalEvent<K extends CanonicalEventType>(
  type: K,
  sessionId: string,
  data: EventPayloadMap[K],
  opts?: { eventId?: string; metadata?: EventMetadata; provider?: string; createdAt?: number },
): Extract<CanonicalEvent, { type: K }> {
  return {
    eventId: opts?.eventId ?? createEventId(),
    sessionId,
    type,
    data,
    metadata: opts?.metadata ?? {},
    provider: opts?.provider ?? "opencode",
    createdAt: opts?.createdAt ?? Date.now(),
  } as Extract<CanonicalEvent, { type: K }>;
}
```

This confines the single unavoidable cast to one place, and every call site gets full type checking on the `data` argument. The translator's `makeEvent()`, every test helper, and the DualWriteHook's synthetic event should use this instead of ad-hoc object literals with `as CanonicalEvent`.

**Impact:** Catches payload shape errors at compile time instead of runtime. The current code would happily let you write `canonicalEvent("session.created", "s1", { messageId: "m1", partId: "p1", text: "hello" })` with zero complaints.

---

## 2. Add Branded Types for IDs

**Problem:** Event IDs, command IDs, session IDs, message IDs, and part IDs are all plain `string`. Nothing prevents passing a message ID where a session ID is expected. The codebase already uses branded types for `RequestId` and `PermissionId` (`shared-types.ts:10,17`).

**Recommendation:** Define branded types for the persistence layer's ID domains:

```typescript
export type EventId = string & { readonly __brand: "EventId" };
export type CommandId = string & { readonly __brand: "CommandId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type PartId = string & { readonly __brand: "PartId" };

export function createEventId(): EventId {
  return `evt_${randomUUID()}` as EventId;
}
export function createCommandId(): CommandId {
  return `cmd_${randomUUID()}` as CommandId;
}
```

Then thread these through all payload interfaces, the `CanonicalEvent` envelope, `StoredEvent`, `CommandReceipt`, and the `EventStore`/`ProjectorCursorRepository` APIs. The branded types are zero-cost at runtime but prevent cross-contamination at compile time.

**Impact:** Prevents an entire class of bugs where IDs get swapped silently. Particularly important in projectors that receive multiple IDs per event (e.g., `ToolStartedPayload` has `messageId`, `partId`, `callId`).

---

## 3. Constrain String-Typed Status and Role Fields

**Problem:** Multiple fields that should be constrained are typed as `string`:
- `SessionStatusPayload.status` — should be `"idle" | "busy" | "retry" | "error"` (matching `SessionStatus` in `opencode-client.ts:37-40`)
- `CommandReceipt.status` — is `"accepted" | "rejected"` in the interface but `string` in the DB row, with a silent fallback in `rowToReceipt()` (line 2398) that converts unknown values to `"rejected"`
- `PermissionResolvedPayload.decision` — typed as `string`, should be `"once" | "always" | "reject"` per audit amendment C7
- `CanonicalEvent.provider` — should be `"opencode" | "claude-sdk"` (or a const union that grows)

**Recommendation:** Use const-derived string literal unions (the same pattern as `POLLER_START_REASONS` in `monitoring-types.ts:42-56`):

```typescript
export const PROVIDER_TYPES = ["opencode", "claude-sdk"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const SESSION_STATUSES = ["idle", "busy", "retry", "error"] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

export const PERMISSION_DECISIONS = ["once", "always", "reject"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];
```

For the `rowToReceipt()` silent fallback, throw instead of silently converting:

```typescript
private rowToReceipt(row: ReceiptRow): CommandReceipt {
  if (row.status !== "accepted" && row.status !== "rejected") {
    throw new PersistenceError("INVALID_RECEIPT_STATUS", `Unknown receipt status: ${row.status}`, {
      commandId: row.command_id,
      status: row.status,
    });
  }
  // ...
}
```

**Impact:** Catches typos and stale string values at compile time. The current code would accept `status: "busyy"` in a `SessionStatusPayload` with no complaint.

---

## 4. Create a `PersistenceError` Class Hierarchy

**Problem:** The plan uses bare `Error` with string messages everywhere: `throw new Error("INSERT RETURNING produced no rows")` (event-store.ts:1972), `throw new Error("Unknown event type in database: ...")` (event-store.ts:2077). The codebase has a mature `RelayError` hierarchy with error codes, structured context, and multiple serialization formats. The persistence layer throws errors that lose all context.

**Recommendation:** Create a persistence-specific error hierarchy:

```typescript
// persistence/errors.ts

export type PersistenceErrorCode =
  | "UNKNOWN_EVENT_TYPE"
  | "INVALID_RECEIPT_STATUS"
  | "APPEND_FAILED"
  | "PROJECTION_FAILED"
  | "MIGRATION_FAILED"
  | "SCHEMA_VALIDATION_FAILED"
  | "CURSOR_MISMATCH"
  | "DESERIALIZATION_FAILED"
  | "SESSION_SEED_FAILED"
  | "DUAL_WRITE_FAILED";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly context: Record<string, unknown>;

  constructor(code: PersistenceErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = "PersistenceError";
    this.code = code;
    this.context = context;
  }

  /** Structured representation for logging. */
  toLog(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...this.context,
    };
  }
}
```

Then replace every `throw new Error(...)` with contextual throws:

```typescript
// Before (event-store.ts:2077):
throw new Error(`Unknown event type in database: ${row.type}`);

// After:
throw new PersistenceError("UNKNOWN_EVENT_TYPE", `Unknown event type in database: ${row.type}`, {
  sequence: row.sequence,
  eventId: row.event_id,
  sessionId: row.session_id,
  type: row.type,
});
```

**Impact:** When an LLM sees a PersistenceError in logs, it immediately knows the error code, the affected entity, and enough context to form a hypothesis — without needing to grep the codebase for where the error was thrown.

---

## 5. Add Runtime Payload Validation on Event Append

**Problem:** The `EventStore.append()` method accepts any `CanonicalEvent` and JSON-serializes `event.data` with zero validation. A translator bug that produces `{ type: "session.created", data: { messageId: "m1" } }` (wrong payload for the type) would be silently persisted and only cause problems downstream when a projector tries to use `event.data.sessionId` and gets `undefined`.

**Recommendation:** Add a lightweight validation layer that runs on append in development/test, or always:

```typescript
// events.ts — add per-type payload shape validators

const PAYLOAD_REQUIRED_FIELDS: Record<CanonicalEventType, string[]> = {
  "session.created": ["sessionId", "title", "provider"],
  "message.created": ["messageId", "role", "sessionId"],
  "text.delta": ["messageId", "partId", "text"],
  "tool.started": ["messageId", "partId", "toolName", "callId"],
  // ... all 20 types
};

export function validateEventPayload(event: CanonicalEvent): void {
  const required = PAYLOAD_REQUIRED_FIELDS[event.type];
  if (!required) return;
  const data = event.data as Record<string, unknown>;
  const missing = required.filter((field) => data[field] === undefined);
  if (missing.length > 0) {
    throw new PersistenceError("SCHEMA_VALIDATION_FAILED",
      `Event ${event.type} missing required fields: ${missing.join(", ")}`,
      { eventId: event.eventId, sessionId: event.sessionId, type: event.type, missing });
  }
}
```

Call this from `EventStore.append()`:

```typescript
append(event: CanonicalEvent): StoredEvent {
  validateEventPayload(event); // Catches translator bugs at write time
  // ...
}
```

**Impact:** Catches translator bugs at write time instead of read time. The error message tells you exactly which fields are missing, on which event type, in which session. An LLM can immediately fix the translator.

---

## 6. Add Safe JSON Deserialization in `rowToStoredEvent`

**Problem:** `rowToStoredEvent()` (event-store.ts:2088-2089) calls `JSON.parse(row.data)` and `JSON.parse(row.metadata)` with no error handling. A corrupted row would throw a bare `SyntaxError: Unexpected token...` with no indication of which event, sequence, or session is affected.

**Recommendation:** Wrap with contextual error handling:

```typescript
private rowToStoredEvent(row: EventRow): StoredEvent {
  // ... type validation ...

  let data: unknown;
  let metadata: unknown;
  try {
    data = JSON.parse(row.data);
  } catch (err) {
    throw new PersistenceError("DESERIALIZATION_FAILED", "Failed to parse event data JSON", {
      sequence: row.sequence,
      eventId: row.event_id,
      sessionId: row.session_id,
      type: row.type,
      rawData: row.data.slice(0, 200),
      parseError: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    metadata = JSON.parse(row.metadata);
  } catch (err) {
    throw new PersistenceError("DESERIALIZATION_FAILED", "Failed to parse event metadata JSON", {
      sequence: row.sequence,
      eventId: row.event_id,
      rawMetadata: row.metadata.slice(0, 200),
      parseError: err instanceof Error ? err.message : String(err),
    });
  }
  // ...
}
```

**Impact:** When an LLM encounters a deserialization failure, it knows exactly which event row is corrupt and can inspect the raw data.

---

## 7. Replace Silent Projector Fallthrough with `assertNever`

**Problem:** Every projector ends with `// Unhandled event types are silently ignored.` If a projector's `handles` array claims it handles `turn.completed` but the if/return chain misses it due to a typo or refactor, the event is silently dropped. The codebase uses `assertNever()` (`utils.ts:24`) and compile-time exhaustiveness assertions (`event-translator.ts:41-69`) precisely to prevent this.

**Recommendation:** Add compile-time exhaustiveness checking for each projector's handled types, mirroring the pattern in `event-translator.ts`:

```typescript
// In session-projector.ts — after the last if/return block:

// Compile-time: verify all declared handles are covered
type _HandledBySessionProjector =
  | "session.created"
  | "session.renamed"
  | "session.status"
  | "session.provider_changed"
  | "turn.completed"
  | "turn.error";
type _DeclaredHandles = (typeof SessionProjector.prototype.handles)[number];
type _MissingFromSwitch = Exclude<_DeclaredHandles, _HandledBySessionProjector>;
type _AssertAllHandled = _MissingFromSwitch extends never ? true : { error: `Unhandled: ${_MissingFromSwitch}` };
const _exhaustiveCheck: _AssertAllHandled = true;
```

Additionally, at runtime, add a development-mode assertion inside `project()`:

```typescript
project(event: StoredEvent, db: SqliteClient): void {
  // ... all the if/return blocks ...

  // If we reach here AND the event type is in our handles list, something is wrong
  if ((this.handles as readonly string[]).includes(event.type)) {
    throw new PersistenceError("PROJECTION_FAILED",
      `Projector "${this.name}" declares it handles "${event.type}" but has no implementation`,
      { projectorName: this.name, eventType: event.type, sequence: event.sequence });
  }
}
```

**Impact:** Catches projector implementation gaps at compile time AND runtime. Without this, a projector bug manifests as silently missing projection data, which is extremely difficult to diagnose.

---

## 8. Enrich DualWriteHook Error Logging with Structured Context

**Problem:** The DualWriteHook's catch-all (dual-write-hook.ts:4306-4309) logs `dual-write error: ${errMsg} (event=${event.type})`. This loses the session ID, the sequence number, the specific stage that failed (translation? seeding? append?), and any structured error context from `PersistenceError`.

**Recommendation:** Use the codebase's `formatErrorDetail()` pattern and include structured context:

```typescript
} catch (err) {
  this._errors++;
  const stage = this.currentStage; // track "translating" | "seeding" | "appending"
  this.log.warn(`dual-write error`, {
    stage,
    eventType: event.type,
    sessionId: sessionId ?? "none",
    error: err instanceof PersistenceError ? err.toLog() : formatErrorDetail(err),
    stats: this.getStats(),
  });
}
```

To track stage, wrap each section:

```typescript
onSSEEvent(event: OpenCodeEvent, sessionId: string | undefined): void {
  if (!this.enabled) return;
  this._eventsReceived++;
  let stage: "translating" | "seeding" | "appending" = "translating";
  try {
    const result = this.translator.translate(event, sessionId);
    if (!result) { this._eventsSkipped++; return; }

    stage = "seeding";
    if (sessionId) { /* ... */ }

    stage = "appending";
    for (const canonicalEvent of result.events) { /* ... */ }
  } catch (err) {
    this._errors++;
    this.log.warn(`dual-write error at ${stage}: ...`, { stage, eventType: event.type, sessionId });
  }
}
```

**Impact:** An LLM seeing the log entry knows immediately whether the failure was in translation (translator bug), seeding (schema/FK issue), or appending (concurrency/corruption). The stats snapshot tells it whether this is a one-off or systemic.

---

## 9. Tag Synthetic Events Distinctly from SSE-Sourced Events

**Problem:** The DualWriteHook creates synthetic `session.created` events (dual-write-hook.ts:4288-4296) when it first sees a session. These look identical to events that would come from the SSE translator. During debugging, there's no way to distinguish "this session.created came from OpenCode" vs "this session.created was synthesized by the seeder."

**Recommendation:** Use the `metadata` field to tag synthetic events:

```typescript
this.persistence.eventStore.append(canonicalEvent("session.created", sessionId, {
  sessionId, title: "Untitled", provider: "opencode",
}, {
  metadata: { adapterKey: "opencode", synthetic: true, source: "session-seeder" },
}));
```

Define `synthetic` and `source` as standard metadata fields:

```typescript
export interface EventMetadata {
  readonly commandId?: string;
  readonly causationEventId?: string;
  readonly correlationId?: string;
  readonly adapterKey?: string;
  readonly providerTurnId?: string;
  /** True if this event was synthesized (not from a provider stream). */
  readonly synthetic?: boolean;
  /** Human-readable source label for debugging. */
  readonly source?: string;
}
```

**Impact:** When an LLM queries the event store and sees two `session.created` events for the same session, it can immediately tell which was real and which was synthetic, avoiding confusion about "why is there a duplicate session.created?"

---

## 10. Add SSE Event Correlation to Canonical Events

**Problem:** A single SSE `message.part.updated` event with `status: "running"` can produce two canonical events (`tool.started` + `tool.running`). These are appended individually with no link between them. When debugging "why did two events appear in sequence 45 and 46?", there's no way to trace them back to a single SSE event without correlating timestamps.

**Recommendation:** Add a `batchId` or `sseCorrelationId` to metadata when appending multiple events from one SSE event:

```typescript
// In DualWriteHook.onSSEEvent(), when result.events.length > 1:
const batchId = createEventId(); // shared across all events from this SSE event
for (const canonicalEvent of result.events) {
  const enriched = {
    ...canonicalEvent,
    metadata: {
      ...canonicalEvent.metadata,
      ...(result.events.length > 1 ? { sseBatchId: batchId, sseBatchSize: result.events.length } : {}),
    },
  };
  this.persistence.eventStore.append(enriched as CanonicalEvent);
}
```

**Impact:** When an LLM sees unexpected event ordering or duplicates, it can group events by `sseBatchId` to understand "these 3 events all came from one SSE event."

---

## 11. Fix the Replay Idempotency Gap in MessageProjector

**Problem:** The plan explicitly documents that replaying `text.delta` doubles the text (line 6559). The projector contract states "Must be idempotent for replay" (line 5504), but `text.delta` is not idempotent — it appends to the existing part text every time. This is acknowledged in the plan but deferred to "cursor-based recovery handles this." This is a design gap: if a cursor rewinds even one event, every subsequent text.delta is corrupted.

**Recommendation:** Two options:

**Option A (simpler, recommended):** Track the last-applied sequence per message and skip events already applied:

```typescript
// Add a last_applied_seq column to messages table (or a separate tracking table)
// In text.delta handler:
const lastSeq = this.getLastAppliedSeq(db, event.data.messageId);
if (event.sequence <= lastSeq) return; // Already applied, skip
// ... apply delta ...
this.updateLastAppliedSeq(db, event.data.messageId, event.sequence);
```

**Option B (more robust):** On recovery, delete and re-project all messages from scratch for affected sessions. This is what the plan's "full re-creation from message.created forward" comment hints at, but it's not implemented anywhere.

Either way, the current plan leaves a ticking time bomb: any cursor rewind corrupts message text.

**Impact:** Without this fix, any recovery scenario (crash, restart, cursor rewind) produces doubled text in messages, which is visually obvious and will generate confused user bug reports.

---

## 12. Add Diagnostic Query Utilities

**Problem:** When things go wrong in the event store or projections, there's no built-in way to inspect health. An LLM debugging a "messages aren't showing up" issue would need to manually construct SQL queries to check projection state, cursor lag, orphaned events, etc.

**Recommendation:** Add a `PersistenceDiagnostics` class with prebuilt health-check queries:

```typescript
export class PersistenceDiagnostics {
  constructor(private readonly db: SqliteClient) {}

  /** Summary of event store and projection health. */
  health(): PersistenceHealth {
    return {
      totalEvents: this.db.queryOne<{c:number}>("SELECT COUNT(*) as c FROM events")?.c ?? 0,
      totalSessions: this.db.queryOne<{c:number}>("SELECT COUNT(*) as c FROM sessions")?.c ?? 0,
      projectorCursors: this.db.query<{name:string, seq:number}>(
        "SELECT projector_name as name, last_applied_seq as seq FROM projector_cursors"),
      maxSequence: this.db.queryOne<{m:number}>("SELECT MAX(sequence) as m FROM events")?.m ?? 0,
      pendingApprovals: this.db.queryOne<{c:number}>(
        "SELECT COUNT(*) as c FROM pending_approvals WHERE status='pending'")?.c ?? 0,
      streamingMessages: this.db.queryOne<{c:number}>(
        "SELECT COUNT(*) as c FROM messages WHERE is_streaming=1")?.c ?? 0,
    };
  }

  /** Find sessions with events but no session row (FK violation survivors). */
  orphanedEvents(): { sessionId: string; eventCount: number }[] { /* ... */ }

  /** Find projectors that are behind the event stream. */
  projectorLag(): { name: string; lag: number }[] { /* ... */ }

  /** Find messages stuck in streaming state for >5 minutes. */
  staleStreamingMessages(): { id: string; sessionId: string; stuckSince: number }[] { /* ... */ }
}
```

Wire this into the daemon's debug endpoints and CLI status output.

**Impact:** An LLM can call `diagnostics.health()` and immediately see whether projectors are lagging, events are orphaned, or messages are stuck. This replaces 10 minutes of manual SQL exploration with one function call.

---

## 13. Add `ProjectionRunner` Error Reporting with Event Context

**Problem:** The plan's Phase 3 introduces a `ProjectionRunner` that orchestrates all projectors. When a projector fails, the plan says "the event is still in the store but the cursor does not advance." But there's no mechanism to report WHY a projector failed, for WHICH event, or how many times it's been retried.

**Recommendation:** The `ProjectionRunner` should maintain a failed-events log:

```typescript
interface ProjectionFailure {
  readonly projectorName: string;
  readonly eventSequence: number;
  readonly eventType: CanonicalEventType;
  readonly sessionId: string;
  readonly error: string;
  readonly errorCode?: string;
  readonly failedAt: number;
  readonly retryCount: number;
}

// In ProjectionRunner:
private readonly failures: ProjectionFailure[] = [];

projectEvent(event: StoredEvent): void {
  for (const projector of this.projectors) {
    try {
      this.db.runInTransaction(() => {
        projector.project(event, this.db);
        this.cursorRepo.upsert(projector.name, event.sequence);
      });
    } catch (err) {
      this.failures.push({
        projectorName: projector.name,
        eventSequence: event.sequence,
        eventType: event.type as CanonicalEventType,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof PersistenceError ? err.code : undefined,
        failedAt: Date.now(),
        retryCount: this.getRetryCount(projector.name, event.sequence),
      });
      this.log.warn(`Projector ${projector.name} failed on event ${event.sequence}`, {
        projector: projector.name,
        sequence: event.sequence,
        type: event.type,
        sessionId: event.sessionId,
        error: err instanceof PersistenceError ? err.toLog() : formatErrorDetail(err),
      });
    }
  }
}

/** Expose failures for diagnostics. */
getFailures(): readonly ProjectionFailure[] {
  return this.failures;
}
```

**Impact:** When an LLM sees "projector is lagging," it can inspect `getFailures()` to find the exact event, error, and projector that's stuck — and fix the root cause rather than symptom-chasing.

---

## 14. Use `TranslateResult`-Style Discriminated Unions for Operation Results

**Problem:** The `CanonicalEventTranslator.translate()` returns `CanonicalTranslateResult | null`, where `null` means "not translatable." The dual-write hook's `onSSEEvent()` returns `void` and hides all results. There's no way to inspect what happened after an event was processed.

**Recommendation:** Use the `TranslateResult` pattern (`event-translator.ts:539-541`) for operation results:

```typescript
export type DualWriteResult =
  | { ok: true; eventsWritten: number; sessionSeeded: boolean }
  | { ok: false; reason: "disabled" | "no-session" | "not-translatable" | "error"; error?: string };
```

Change `onSSEEvent()` to return this instead of `void`:

```typescript
onSSEEvent(event: OpenCodeEvent, sessionId: string | undefined): DualWriteResult {
  if (!this.enabled) return { ok: false, reason: "disabled" };
  // ...
}
```

The caller (sse-wiring.ts) can ignore the result in production, but tests and diagnostic tools can inspect it:

```typescript
// In test:
const result = hook.onSSEEvent(event, "sess-1");
expect(result).toEqual({ ok: true, eventsWritten: 2, sessionSeeded: true });

// In diagnostic logging:
if (!result.ok) {
  log.debug(`dual-write skipped: ${result.reason}`, { eventType: event.type });
}
```

**Impact:** Makes the dual-write hook testable without inspecting the database, and gives diagnostic tools a way to trace event flow without side-effect inspection.

---

## 15. Add Compile-Time Exhaustiveness for Canonical Event Types vs Projector Coverage

**Problem:** There are 20 canonical event types and 6 projectors. There's no compile-time check that every event type is handled by at least one projector. If a new event type is added (e.g., `tool.input_updated` per Q8), it might not be handled by any projector.

**Recommendation:** Add a compile-time assertion in the `ProjectionRunner` or a shared type file:

```typescript
// projectors/coverage.ts
import type { CanonicalEventType } from "../events.js";
import type { SessionProjector } from "./session-projector.js";
import type { MessageProjector } from "./message-projector.js";
// ... etc

type AllProjectedTypes =
  | SessionProjector["handles"][number]
  | MessageProjector["handles"][number]
  | TurnProjector["handles"][number]
  | ProviderProjector["handles"][number]
  | ApprovalProjector["handles"][number]
  | ActivityProjector["handles"][number];

type UnprojectedTypes = Exclude<CanonicalEventType, AllProjectedTypes>;

// This line fails to compile if any canonical event type is not handled by at least one projector:
type _AssertFullCoverage = UnprojectedTypes extends never
  ? true
  : { error: `Unprojected event types: ${UnprojectedTypes}` };
const _coverageCheck: _AssertFullCoverage = true;
```

**Impact:** Adding a new event type without updating projectors becomes a compile error instead of a silent gap.

---

## 16. Add Structured Logging to EventStore Operations

**Problem:** The `EventStore` has no logging at all. When events fail to append, the only signal is an exception propagated to the caller. There's no observability into append rates, batch sizes, stream version conflicts, or read patterns.

**Recommendation:** Accept an optional logger and log key operations at `debug`/`verbose` level:

```typescript
export class EventStore {
  constructor(
    private readonly db: SqliteClient,
    private readonly log?: Logger,
  ) {}

  append(event: CanonicalEvent): StoredEvent {
    // ...
    this.log?.verbose(`event appended`, {
      sequence: stored.sequence,
      type: event.type,
      sessionId: event.sessionId,
      streamVersion: stored.streamVersion,
    });
    return stored;
  }

  // On conflict:
  this.log?.warn(`stream version conflict`, {
    sessionId: event.sessionId,
    eventId: event.eventId,
    expectedVersion,
  });
}
```

This follows the existing codebase pattern where every component gets a child logger (`relay-stack.ts:131-138`).

**Impact:** When debugging "events aren't being stored," an LLM can enable verbose logging and immediately see whether events are being appended, at what rate, and for which sessions.

---

## Summary Table

| # | Area | Severity | Effort | Description |
|---|------|----------|--------|-------------|
| 1 | Types | High | Low | Typed factory for CanonicalEvent (eliminates `as` casts) |
| 2 | Types | Medium | Medium | Branded types for IDs |
| 3 | Types | Medium | Low | Constrain string status/role/decision fields |
| 4 | Errors | High | Medium | PersistenceError class with codes and context |
| 5 | Errors | High | Low | Runtime payload validation on append |
| 6 | Errors | Medium | Low | Safe JSON deserialization with context |
| 7 | Types | High | Low | assertNever in projectors |
| 8 | Debug | High | Low | Structured dual-write error logging |
| 9 | Debug | Medium | Low | Tag synthetic events in metadata |
| 10 | Debug | Medium | Low | SSE event correlation via batch IDs |
| 11 | Design | High | Medium | Fix replay idempotency in MessageProjector |
| 12 | Debug | Medium | Medium | Diagnostic query utilities |
| 13 | Debug | High | Medium | ProjectionRunner failure tracking |
| 14 | Design | Medium | Low | Discriminated union results for operations |
| 15 | Types | Medium | Low | Compile-time projector coverage check |
| 16 | Debug | Medium | Low | Structured logging in EventStore |
