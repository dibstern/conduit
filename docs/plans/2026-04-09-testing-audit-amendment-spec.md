# Testing Strategy Audit: Amendment Specification

> Specifies exactly how to amend the [orchestrator implementation plan](./2026-04-05-orchestrator-implementation-plan.md) in-place to resolve all 14 findings from the [testing strategy audit](./2026-04-07-orchestrator-testing-strategy-audit.md). Uses the hybrid approach: shared infrastructure in full code, one worked example per pattern category, checklists for remaining tasks.
>
> **Approach:** Amend the plan in-place. The amendment table entries (T1-T7) were the right diagnoses but were never applied to the task code blocks that executing agents read. This document provides the concrete code and patterns needed to make those applications.

---

## Table of Contents

1. [Task 0: Shared Test Factory Infrastructure](#1-task-0-shared-test-factory-infrastructure) — F2, F3, F4, F8, F11
2. [Pattern: Replace Local Factories with Shared Imports](#2-pattern-replace-local-factories-with-shared-imports) — F4, F7, F8, F11
3. [Pattern: Wiring Tests for Inline Reimplementations](#3-pattern-wiring-tests-for-inline-reimplementations) — F1
4. [Specific Additions: Boundary Tests](#4-specific-additions-boundary-tests) — F5, F14
5. [Specific Additions: Property-Based Tests](#5-specific-additions-property-based-tests) — F6, F12
6. [Specific Additions: Failure Injection Tests](#6-specific-additions-failure-injection-tests) — F9
7. [Specific Additions: Integration & Equivalence Tests](#7-specific-additions-integration--equivalence-tests) — F10
8. [Specific Additions: Schema Assertions](#8-specific-additions-schema-assertions) — F13
9. [Coding Guidelines Additions](#9-coding-guidelines-additions) — F11
10. [Application Manifest & Order](#10-application-manifest--order)

---

## 1. Task 0: Shared Test Factory Infrastructure

**Addresses:** F2 (no task slot), F3 (untyped makeSSEEvent), F4 (bypass canonicalEvent), F8 (non-deterministic timestamps), F11 (as CanonicalEvent casts)

Insert this task **before Task 1** in the plan. All subsequent tasks import from these three modules instead of defining local factories.

### Files

```
test/helpers/
├── persistence-factories.ts    # Event store, projections, read queries
├── sse-factories.ts            # SSE events, relay pipeline mocks
└── provider-factories.ts       # Adapters, EventSink, OrchestrationEngine
```

### 1a. `persistence-factories.ts`

This is the most critical module — it replaces 33+ scattered factory copies with a single `createTestHarness()` call that builds a fully-wired in-memory persistence stack.

```typescript
// test/helpers/persistence-factories.ts
import { SqliteClient } from "../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../src/lib/persistence/schema.js";
import { EventStore } from "../../src/lib/persistence/event-store.js";
import {
  canonicalEvent,
  createEventId,
  validateEventPayload,
  type CanonicalEvent,
  type StoredEvent,
  type EventId,
  type EventMetadata,
  type EventPayloadMap,
} from "../../src/lib/persistence/events.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Fixed timestamp for deterministic tests. Override explicitly when testing time-dependent behavior. */
export const FIXED_TEST_TIMESTAMP = 1_000_000_000_000; // 2001-09-09T01:46:40Z

/** Second fixed timestamp for tests needing two distinct times. */
export const FIXED_TEST_TIMESTAMP_2 = 1_000_000_060_000; // +60s

// ─── Canonical Event Factories ───────────────────────────────────────────────
//
// Every factory calls canonicalEvent() internally — never raw object + `as` cast.
// This enforces the type-data correspondence defined by the discriminated union.

export function makeSessionCreatedEvent(
  sessionId: string,
  opts?: {
    eventId?: EventId;
    metadata?: EventMetadata;
    createdAt?: number;
    title?: string;
    provider?: string;
  },
): CanonicalEvent {
  return canonicalEvent("session.created", sessionId, {
    sessionId,
    title: opts?.title ?? "Test Session",
    provider: opts?.provider ?? "opencode",
  }, {
    eventId: opts?.eventId ?? createEventId(),
    metadata: opts?.metadata ?? {},
    createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
  });
}

export function makeTextDelta(
  sessionId: string,
  messageId: string,
  text: string,
  opts?: {
    eventId?: EventId;
    partId?: string;
    metadata?: EventMetadata;
    createdAt?: number;
  },
): CanonicalEvent {
  return canonicalEvent("text.delta", sessionId, {
    messageId,
    partId: opts?.partId ?? "p1",
    text,
  }, {
    eventId: opts?.eventId ?? createEventId(),
    metadata: opts?.metadata ?? {},
    createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
  });
}

export function makeMessageCreatedEvent(
  sessionId: string,
  messageId: string,
  opts?: {
    eventId?: EventId;
    role?: "user" | "assistant";
    metadata?: EventMetadata;
    createdAt?: number;
  },
): CanonicalEvent {
  return canonicalEvent("message.created", sessionId, {
    messageId,
    role: opts?.role ?? "assistant",
  }, {
    eventId: opts?.eventId ?? createEventId(),
    metadata: opts?.metadata ?? {},
    createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
  });
}

export function makeSessionStatusEvent(
  sessionId: string,
  status: "idle" | "busy" | "error",
  opts?: {
    eventId?: EventId;
    metadata?: EventMetadata;
    createdAt?: number;
  },
): CanonicalEvent {
  return canonicalEvent("session.status", sessionId, {
    sessionId,
    status,
  }, {
    eventId: opts?.eventId ?? createEventId(),
    metadata: opts?.metadata ?? {},
    createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
  });
}

// ─── StoredEvent Factory ─────────────────────────────────────────────────────

/**
 * Create a StoredEvent with validated type-data correspondence and runtime invariants.
 * Uses canonicalEvent() internally — never raw casts.
 */
export function makeStored<T extends StoredEvent["type"]>(
  type: T,
  sessionId: string,
  data: EventPayloadMap[T],
  opts?: {
    sequence?: number;
    createdAt?: number;
    streamVersion?: number;
    eventId?: EventId;
    metadata?: EventMetadata;
  },
): StoredEvent {
  const sequence = opts?.sequence ?? 1;
  if (sequence < 1) {
    throw new Error(`makeStored: sequence must be >= 1, got ${sequence}`);
  }

  const streamVersion = opts?.streamVersion ?? 0;
  if (streamVersion < 0) {
    throw new Error(`makeStored: streamVersion must be >= 0, got ${streamVersion}`);
  }

  const event = canonicalEvent(type, sessionId, data, {
    eventId: opts?.eventId ?? createEventId(),
    metadata: opts?.metadata ?? {},
    createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
  });

  // Validate payload at construction time — catch invalid test data immediately
  validateEventPayload(event);

  return { ...event, sequence, streamVersion } as StoredEvent;
}

// ─── Session/Message Seeding ─────────────────────────────────────────────────

export interface SessionSeedOpts {
  provider?: string;
  title?: string;
  status?: string;
  parentId?: string;
  forkPointEvent?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface MessageSeedOpts {
  role?: "user" | "assistant";
  createdAt?: number;
  updatedAt?: number;
  lastAppliedSeq?: number;
  parts?: Array<{
    id: string;
    type: "text" | "thinking" | "tool";
    text?: string;
    sortOrder?: number;
  }>;
}

export interface TurnSeedOpts {
  assistantMessageId?: string;
  state?: "active" | "completed" | "error";
  createdAt?: number;
  updatedAt?: number;
}

// ─── Test Harness ────────────────────────────────────────────────────────────

export interface TestHarness {
  readonly db: SqliteClient;
  readonly eventStore: EventStore;
  seedSession: (id: string, opts?: SessionSeedOpts) => void;
  seedMessage: (id: string, sessionId: string, opts?: MessageSeedOpts) => void;
  seedTurn: (id: string, sessionId: string, opts?: TurnSeedOpts) => void;
  close: () => void;
}

/**
 * Build a fully-wired in-memory persistence stack in one call.
 * Handles schema setup, session seeding, FK consistency, and deterministic timestamps.
 */
export function createTestHarness(): TestHarness {
  const db = SqliteClient.memory();
  runMigrations(db, schemaMigrations);
  const eventStore = new EventStore(db);

  function seedSession(id: string, opts?: SessionSeedOpts): void {
    const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
    db.execute(
      `INSERT INTO sessions (id, provider, title, status, parent_id, fork_point_event, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts?.provider ?? "opencode",
        opts?.title ?? "Test Session",          // Matches makeSessionCreatedEvent default
        opts?.status ?? "idle",
        opts?.parentId ?? null,
        opts?.forkPointEvent ?? null,
        now,
        opts?.updatedAt ?? now,
      ],
    );
  }

  function seedMessage(id: string, sessionId: string, opts?: MessageSeedOpts): void {
    const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
    // Insert into messages table (no parts column — P1 normalization)
    db.execute(
      `INSERT INTO messages (id, session_id, role, created_at, updated_at, last_applied_seq)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId,
        opts?.role ?? "assistant",
        now,
        opts?.updatedAt ?? now,
        opts?.lastAppliedSeq ?? 0,
      ],
    );

    // Insert each part into message_parts table (F7: write to normalized table)
    for (const [i, part] of (opts?.parts ?? []).entries()) {
      db.execute(
        `INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          part.id,
          id,
          part.type,
          part.text ?? "",
          part.sortOrder ?? i,
          now,
          now,
        ],
      );
    }
  }

  function seedTurn(id: string, sessionId: string, opts?: TurnSeedOpts): void {
    const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
    db.execute(
      `INSERT INTO turns (id, session_id, assistant_message_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId,
        opts?.assistantMessageId ?? null,
        opts?.state ?? "active",
        now,
        opts?.updatedAt ?? now,
      ],
    );
  }

  return {
    db,
    eventStore,
    seedSession,
    seedMessage,
    seedTurn,
    close: () => db.close(),
  };
}
```

**Design decisions:**

1. **`FIXED_TEST_TIMESTAMP`** — All factories default to the same deterministic timestamp. Snapshot tests are deterministic by default (F8). Override explicitly when testing time-dependent behavior.

2. **`canonicalEvent()` internal** — Every event factory calls `canonicalEvent()` instead of raw object construction + `as CanonicalEvent`. This enforces type-data correspondence at compile time (F4, F11).

3. **`validateEventPayload()` at construction** — `makeStored()` validates payload fields at factory call time, not when the event hits the store three calls later (F7).

4. **Runtime invariant checks** — `makeStored()` throws on `sequence < 1` and `streamVersion < 0` (T3).

5. **Title consistency** — `seedSession()` defaults to `"Test Session"` matching `makeSessionCreatedEvent()` — prevents the divergence identified in F7.

6. **`seedMessage()` writes to `message_parts`** — Uses normalized table, not the non-existent `parts` TEXT column (T5).

### 1b. `sse-factories.ts`

```typescript
// test/helpers/sse-factories.ts
import type { OpenCodeEvent } from "../../src/lib/types.js";
import type { KnownOpenCodeEvent } from "../../src/lib/relay/opencode-events.js";

// ─── Type-Safe SSE Event Factory ─────────────────────────────────────────────

type KnownSSEType = KnownOpenCodeEvent["type"];

/**
 * Known SSE event types — runtime guard for the type-constrained overload.
 * Maintained alongside the KnownOpenCodeEvent union type.
 */
const KNOWN_SSE_TYPES = new Set<string>([
  // Message lifecycle
  "message.created", "message.updated", "message.removed",
  // Part lifecycle
  "message.part.delta", "message.part.updated", "message.part.removed",
  // Session lifecycle
  "session.status", "session.error", "session.updated",
  // Approval flow
  "permission.asked", "permission.replied",
  // Question flow
  "question.asked", "question.replied",
  // Terminal & file
  "pty.created", "pty.data", "file.edited",
]);

/**
 * Create a typed SSE event. The type parameter constrains `type` to known
 * SSE event types at compile time. Runtime guard catches typos that slip
 * through generic usage.
 *
 * Addresses F3: accepts KnownSSEType, not arbitrary string.
 */
export function makeSSEEvent<T extends KnownSSEType>(
  type: T,
  properties: Record<string, unknown>,
): OpenCodeEvent {
  if (!KNOWN_SSE_TYPES.has(type)) {
    throw new Error(
      `makeSSEEvent: unknown SSE event type "${type}". ` +
      `Known types: ${[...KNOWN_SSE_TYPES].join(", ")}`,
    );
  }
  return { type, properties } as OpenCodeEvent;
}

/**
 * Create an intentionally unknown SSE event for testing unknown-event handling.
 * Clearly separated from makeSSEEvent to prevent accidental use.
 */
export function makeUnknownSSEEvent(
  type: string,
  properties: Record<string, unknown> = {},
): OpenCodeEvent {
  if (KNOWN_SSE_TYPES.has(type)) {
    throw new Error(
      `makeUnknownSSEEvent: "${type}" is a known type. Use makeSSEEvent() instead.`,
    );
  }
  return { type, properties } as OpenCodeEvent;
}

/**
 * Build a realistic SSE event sequence for integration tests.
 * Returns events plus expected read-model outcomes for data-driven assertions.
 */
export interface RealisticSequenceResult {
  events: OpenCodeEvent[];
  expectedTitle: string;
  expectedMessageCount: number;
  expectedToolCount: number;
  sessionId: string;
}

export function createRealisticSSESequence(sessionId: string): RealisticSequenceResult {
  const events: OpenCodeEvent[] = [
    // Session start
    makeSSEEvent("session.status", { status: { type: "busy" } }),
    // User message
    makeSSEEvent("message.created", {
      sessionID: sessionId,
      message: { id: "msg-1", role: "user" },
    }),
    // Assistant message with text
    makeSSEEvent("message.created", {
      sessionID: sessionId,
      message: { id: "msg-2", role: "assistant" },
    }),
    makeSSEEvent("message.part.delta", {
      sessionID: sessionId,
      messageID: "msg-2",
      partID: "part-1",
      field: "text",
      delta: "Hello, ",
    }),
    makeSSEEvent("message.part.delta", {
      sessionID: sessionId,
      messageID: "msg-2",
      partID: "part-1",
      field: "text",
      delta: "world!",
    }),
    // Tool use
    makeSSEEvent("message.part.updated", {
      partID: "part-2",
      part: {
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: { status: "running", input: { path: "/test" } },
      },
    }),
    // Permission flow
    makeSSEEvent("permission.asked", {
      id: "perm-1",
      sessionID: sessionId,
      permission: "read",
      patterns: ["/test"],
      metadata: {},
    }),
    makeSSEEvent("permission.replied", {
      id: "perm-1",
      sessionID: sessionId,
      decision: "once",
    }),
    // Tool complete
    makeSSEEvent("message.part.updated", {
      partID: "part-2",
      part: {
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: { status: "completed", output: "file content" },
      },
    }),
    // Message updated (token counts)
    makeSSEEvent("message.updated", {
      sessionID: sessionId,
      message: {
        role: "assistant",
        tokens: { input: 100, output: 50, cache: { read: 10, write: 5 } },
        time: { created: 1000, completed: 2000 },
      },
    }),
    // Session idle
    makeSSEEvent("session.status", { status: { type: "idle" } }),
  ];

  return {
    events,
    expectedTitle: "Test Session",
    expectedMessageCount: 2,
    expectedToolCount: 1,
    sessionId,
  };
}
```

### 1c. `provider-factories.ts`

```typescript
// test/helpers/provider-factories.ts
import { vi } from "vitest";
import type { ProviderAdapter } from "../../src/lib/provider/types.js";
import type { EventSink } from "../../src/lib/provider/event-sink.js";
import type { OpenCodeClient } from "../../src/lib/relay/opencode-client.js";
import type { CanonicalEvent } from "../../src/lib/persistence/events.js";

/**
 * Create a stub OpenCode client where unmocked methods throw.
 * Prevents tests from accidentally calling methods they didn't set up.
 */
export function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient {
  const methodNames = [
    "sendMessageAsync", "abortSession", "replyPermission", "replyQuestion",
    "rejectQuestion", "listPendingQuestions", "getSession", "getMessages",
    "getMessage", "getMessagesPage", "listSessions", "listAgents",
    "listProviders", "listCommands", "listProjects", "listDirectory",
    "getFileContent", "createPty", "deletePty", "resizePty", "listPtys",
    "revertSession", "forkSession", "createSession", "deleteSession",
    "getAuthHeaders", "getHealth", "switchModel", "listPendingPermissions",
    "getBaseUrl", "getConfig", "updateConfig",
  ] as const;

  const stub: Record<string, unknown> = {};
  for (const name of methodNames) {
    stub[name] = vi.fn().mockImplementation(() => {
      throw new Error(`makeStubClient: unmocked method "${name}" called`);
    });
  }

  return { ...stub, ...overrides } as unknown as OpenCodeClient;
}

/**
 * Create a stub provider adapter where unmocked methods throw.
 */
export function makeStubAdapter(
  id: string,
  overrides?: Partial<ProviderAdapter>,
): ProviderAdapter {
  return {
    id,
    discover: vi.fn().mockImplementation(() => {
      throw new Error(`makeStubAdapter(${id}): unmocked method "discover" called`);
    }),
    sendTurn: vi.fn().mockImplementation(() => {
      throw new Error(`makeStubAdapter(${id}): unmocked method "sendTurn" called`);
    }),
    interruptTurn: vi.fn().mockImplementation(() => {
      throw new Error(`makeStubAdapter(${id}): unmocked method "interruptTurn" called`);
    }),
    resolvePermission: vi.fn().mockImplementation(() => {
      throw new Error(`makeStubAdapter(${id}): unmocked method "resolvePermission" called`);
    }),
    resolveQuestion: vi.fn().mockImplementation(() => {
      throw new Error(`makeStubAdapter(${id}): unmocked method "resolveQuestion" called`);
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ProviderAdapter;
}

/**
 * Create a stub EventSink that optionally tracks appended events.
 */
export function makeStubEventSink(
  opts?: { trackEvents?: boolean },
): EventSink & { events: CanonicalEvent[] } {
  const events: CanonicalEvent[] = [];
  return {
    events,
    append: vi.fn().mockImplementation((event: CanonicalEvent) => {
      if (opts?.trackEvents) events.push(event);
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    getPendingState: vi.fn().mockReturnValue({
      pendingPermissions: [],
      pendingQuestions: [],
    }),
  } as unknown as EventSink & { events: CanonicalEvent[] };
}
```

### Task 0 Test

```typescript
// test/unit/persistence/shared-factories.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  createTestHarness,
  makeSessionCreatedEvent,
  makeStored,
  FIXED_TEST_TIMESTAMP,
} from "../../helpers/persistence-factories.js";
import { makeSSEEvent, makeUnknownSSEEvent } from "../../helpers/sse-factories.js";
import { makeStubClient } from "../../helpers/provider-factories.js";

describe("persistence-factories", () => {
  it("createTestHarness returns wired stack", () => {
    const harness = createTestHarness();
    harness.seedSession("s1");
    const stored = harness.eventStore.append(makeSessionCreatedEvent("s1"));
    expect(stored.sequence).toBe(1);
    expect(stored.streamVersion).toBe(0);
    harness.close();
  });

  it("makeStored rejects sequence < 1", () => {
    expect(() => makeStored("session.created", "s1", {
      sessionId: "s1", title: "T", provider: "opencode",
    }, { sequence: 0 })).toThrow("sequence must be >= 1");
  });

  it("makeStored rejects streamVersion < 0", () => {
    expect(() => makeStored("session.created", "s1", {
      sessionId: "s1", title: "T", provider: "opencode",
    }, { streamVersion: -1 })).toThrow("streamVersion must be >= 0");
  });

  it("all factories use FIXED_TEST_TIMESTAMP by default", () => {
    const event = makeSessionCreatedEvent("s1");
    expect(event.createdAt).toBe(FIXED_TEST_TIMESTAMP);
  });

  it("seedSession title matches makeSessionCreatedEvent title", () => {
    const harness = createTestHarness();
    harness.seedSession("s1");
    const row = harness.db.queryOne<{ title: string }>(
      "SELECT title FROM sessions WHERE id = ?", ["s1"],
    );
    const event = makeSessionCreatedEvent("s1");
    expect(row!.title).toBe((event.data as { title: string }).title);
    harness.close();
  });
});

describe("sse-factories", () => {
  it("makeSSEEvent rejects unknown types at runtime", () => {
    // @ts-expect-error — intentionally testing runtime guard
    expect(() => makeSSEEvent("message.delta", {})).toThrow("unknown SSE event type");
  });

  it("makeSSEEvent accepts valid types", () => {
    const event = makeSSEEvent("message.part.delta", {
      sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "hi",
    });
    expect(event.type).toBe("message.part.delta");
  });

  it("makeUnknownSSEEvent rejects known types", () => {
    expect(() => makeUnknownSSEEvent("session.status", {})).toThrow("known type");
  });
});

describe("provider-factories", () => {
  it("makeStubClient throws on unmocked methods", () => {
    const client = makeStubClient();
    expect(() => client.listSessions()).toThrow("unmocked method");
  });

  it("makeStubClient allows overrides", async () => {
    const client = makeStubClient({
      listSessions: vi.fn().mockResolvedValue([]),
    });
    await expect(client.listSessions()).resolves.toEqual([]);
  });
});
```

---

## 2. Pattern: Replace Local Factories with Shared Imports

**Addresses:** F4, F7, F8, F11

This pattern applies to every task that defines local `makeSessionCreatedEvent()`, `makeTextDelta()`, `seedSession()`, or uses `as CanonicalEvent` casts.

### Before (Task 5 pattern — current plan)

```typescript
// test/unit/persistence/event-store.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { EventStore } from "../../../src/lib/persistence/event-store.js";
import { createEventId, type CanonicalEvent } from "../../../src/lib/persistence/events.js";

function makeSessionCreatedEvent(sessionId: string): CanonicalEvent {
  return {
    eventId: createEventId(),
    sessionId,
    type: "session.created",
    data: { sessionId, title: "Test Session", provider: "opencode" },
    metadata: {},
    provider: "opencode",
    createdAt: Date.now(),                    // ← F8: non-deterministic
  } as CanonicalEvent;                        // ← F4/F11: bypasses canonicalEvent()
}

function seedSession(client: SqliteClient, sessionId: string): void {
  client.execute(
    "INSERT INTO sessions (...) VALUES (...)",
    [sessionId, "opencode", "Test", ...],     // ← F7: title "Test" ≠ "Test Session"
  );
}

describe("EventStore", () => {
  let client: SqliteClient;
  let store: EventStore;

  beforeEach(() => {
    client = SqliteClient.memory();
    runMigrations(client, schemaMigrations);
    store = new EventStore(client);
  });

  afterEach(() => { client?.close(); });

  // ... tests ...
});
```

### After (amended)

```typescript
// test/unit/persistence/event-store.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventStore } from "../../../src/lib/persistence/event-store.js";
import {
  createTestHarness,
  makeSessionCreatedEvent,
  makeTextDelta,
  type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("EventStore", () => {
  let harness: TestHarness;
  let store: EventStore;

  beforeEach(() => {
    harness = createTestHarness();
    store = harness.eventStore;
  });

  afterEach(() => { harness.close(); });

  describe("append", () => {
    it("appends an event and returns it with sequence and streamVersion", () => {
      harness.seedSession("s1");
      const event = makeSessionCreatedEvent("s1");
      const stored = store.append(event);
      expect(stored.sequence).toBe(1);
      expect(stored.streamVersion).toBe(0);
      expect(stored.eventId).toBe(event.eventId);
    });

    // ... remaining tests use harness.seedSession() and shared factories ...
  });
});
```

### What changes

| Before | After | Why |
|--------|-------|-----|
| `SqliteClient.memory()` + `runMigrations()` + `new EventStore()` | `createTestHarness()` | One call, no manual wiring |
| Local `makeSessionCreatedEvent()` with `as CanonicalEvent` | Import from `persistence-factories.ts` | Uses `canonicalEvent()` internally (F4) |
| Local `seedSession()` with `"Test"` title | `harness.seedSession()` with `"Test Session"` default | Title matches event factory (F7) |
| `Date.now()` in factories | `FIXED_TEST_TIMESTAMP` default | Deterministic snapshots (F8) |

### Checklist: Apply to these tasks

| Task | Local factories to remove | Notes |
|------|--------------------------|-------|
| **5** | `makeSessionCreatedEvent`, `makeTextDelta`, `seedSession` | Worked example above |
| **6** | `seedSession` (receipt tests) | Also seed session before receipt INSERT for FK safety (F7) |
| **7** | `makeSSEEvent` (5 copies) | Replace with import from `sse-factories.ts` |
| **8** | `seedSession`, `makeSessionCreatedEvent` | Fix `"evt_test-1"` invalid EventId format (F7) |
| **9** | `makeSessionCreatedEvent`, `seedSession` | Session seeder tests |
| **10** | `makeSSEEvent`, `makeStored`, `seedSession` | DualWriteHook tests |
| **11** | `makeSSEEvent` | SSE wiring integration tests |
| **15-20** | `makeStored` (per projector) | Projector tests — also add snapshot tests (T7) |
| **21** | `makeStored`, `seedSession` | ProjectionRunner tests |
| **22** | `makeStored`, `seedSession` | Wire ProjectionRunner tests |
| **23** | `seedSession`, `seedMessage` | ReadQueryService tests — use `harness.seedMessage()` with parts array |
| **31-32** | `seedMessage` with `parts` TEXT column | **Critical:** replace with `harness.seedMessage()` that writes to `message_parts` table (T5) |

---

## 3. Pattern: Wiring Tests for Inline Reimplementations

**Addresses:** F1

Four Phase 4 tasks define business logic inline in the test file and test that instead of the production function. Each task needs the existing algorithm test (renamed) plus a new wiring test.

### Worked Example: Task 26 (Fork Resolution)

**Current state** (plan lines 13802-13878): Test defines `resolveForkEntry()` inline and tests it. Production `SessionManager.getForkEntry()` is separate and untested.

**Amendment — add wiring test block after Step 1:**

```typescript
// ─── Wiring test (add to test/unit/session/fork-metadata-sqlite.test.ts) ────

import {
  createTestHarness,
  type TestHarness,
} from "../../helpers/persistence-factories.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";

describe("fork resolution (wiring)", () => {
  // This tests the PRODUCTION SessionManager.getForkEntry() with real dependencies.
  // The algorithm test above validates the resolution strategy independently.

  let harness: TestHarness;
  let sessionMgr: SessionManager;

  beforeEach(() => {
    harness = createTestHarness();
    // Seed a fork session in SQLite
    harness.seedSession("parent-1");
    harness.seedSession("fork-1", {
      parentId: "parent-1",
      forkPointEvent: "msg-10-sqlite",
    });

    const readQuery = new ReadQueryService(harness.db);
    sessionMgr = new SessionManager({
      // ... minimal real deps ...
      readQuery,
      readFlags: { forkMetadata: "sqlite" },
    });
  });

  afterEach(() => { harness.close(); });

  it("production getForkEntry() returns correct entry from SQLite", () => {
    const entry = sessionMgr.getForkEntry("fork-1");
    expect(entry).toEqual({
      forkMessageId: "msg-10-sqlite",
      parentID: "parent-1",
    });
  });

  it("production getForkEntry() returns undefined for non-fork", () => {
    expect(sessionMgr.getForkEntry("parent-1")).toBeUndefined();
  });
});
```

**Also rename the existing test:**

```diff
-describe("Fork metadata read switchover", () => {
+describe("Fork metadata read switchover algorithm (spec)", () => {
```

### Wiring Test Shape (uniform for Tasks 24.5, 26, 28, 30)

Every wiring test follows the same structure:

```
given:  seeded SQLite state via createTestHarness() + ReadFlags set to "sqlite"
when:   call production method with real ReadQueryService over in-memory DB
then:   assert return value matches expected shape
```

### Checklist: Apply to these tasks

| Task | Inline Function | Production Target | Wiring Test Setup |
|------|----------------|-------------------|-------------------|
| **24.5** | `buildHandlerDeps()` | `createProjectRelay()` in relay-stack.ts | Verify `readQuery` and `readFlags` are wired into PermissionBridge and SessionManager |
| **26** | `resolveForkEntry()` | `SessionManager.getForkEntry()` | Worked example above |
| **28** | `dualListSessions()` | `SessionManager.listSessions()` | Seed 3 sessions, verify SQLite path returns same shape as legacy |
| **30** | `resolveRawStatuses()` | `SessionStatusPoller.poll()` | Seed session status events, verify reconciliation returns correct statuses |

---

## 4. Specific Additions: Boundary Tests

**Addresses:** F5, F14

These are specific test additions to Task 5's EventStore test code block. Not a pattern — just missing tests.

### F5: Missing EventStore Boundary Tests

Add to Task 5's test block (after the existing tests):

```typescript
describe("EventStore boundary conditions", () => {
  let harness: TestHarness;
  let store: EventStore;

  beforeEach(() => {
    harness = createTestHarness();
    store = harness.eventStore;
  });

  afterEach(() => { harness.close(); });

  it("accepts createdAt = 0 (epoch zero)", () => {
    harness.seedSession("s1");
    const stored = store.append(makeSessionCreatedEvent("s1", { createdAt: 0 }));
    const read = store.readFromSequence(0);
    expect(read[0].createdAt).toBe(0);
  });

  it("handles large data payloads without truncation", () => {
    harness.seedSession("s1");
    harness.eventStore.append(makeSessionCreatedEvent("s1"));
    const largeText = "x".repeat(10_000);
    const stored = store.append(makeTextDelta("s1", "m1", largeText));
    const read = store.readFromSequence(stored.sequence - 1);
    expect((read[0].data as { text: string }).text).toBe(largeText);
  });

  it("readFromSequence with afterSequence = -1 behaves as 0", () => {
    harness.seedSession("s1");
    store.append(makeSessionCreatedEvent("s1"));
    // afterSequence is exclusive lower bound — -1 should return all events
    const read = store.readFromSequence(-1);
    expect(read.length).toBe(1);
  });

  it("readBySession with limit = 0 returns empty array", () => {
    harness.seedSession("s1");
    store.append(makeSessionCreatedEvent("s1"));
    const read = store.readBySession("s1", 0);
    expect(read).toEqual([]);
  });

  it("readFromSequence with cursor beyond max returns empty", () => {
    harness.seedSession("s1");
    store.append(makeSessionCreatedEvent("s1"));
    const read = store.readFromSequence(999);
    expect(read).toEqual([]);
  });

  it("concurrent version conflict via two EventStore instances", () => {
    harness.seedSession("s1");
    const store2 = new EventStore(harness.db);

    // Both stores start with empty caches
    store.append(makeSessionCreatedEvent("s1"));

    // store2 doesn't know about store's append — should still get correct version
    const e2 = store2.append(makeTextDelta("s1", "m1", "hello"));
    expect(e2.streamVersion).toBe(1); // 0 was taken by store's append
    expect(e2.sequence).toBe(2);
  });

  it("validateEventPayload catches null required fields", () => {
    harness.seedSession("s1");
    expect(() => {
      store.append(canonicalEvent("text.delta", "s1", {
        messageId: null as unknown as string,
        partId: "p1",
        text: "x",
      }, { createdAt: FIXED_TEST_TIMESTAMP }));
    }).toThrow();
  });
});
```

### F14: resetVersionCache Unit Test

Add to Task 5's test block:

```typescript
describe("resetVersionCache", () => {
  let harness: TestHarness;
  let store: EventStore;

  beforeEach(() => {
    harness = createTestHarness();
    store = harness.eventStore;
  });

  afterEach(() => { harness.close(); });

  it("clears cached versions and falls back to DB query", () => {
    harness.seedSession("s1");
    store.append(makeSessionCreatedEvent("s1"));
    store.append(makeTextDelta("s1", "m1", "a"));
    store.append(makeTextDelta("s1", "m1", "b"));
    // Cache now has s1 → streamVersion 2

    store.resetVersionCache();

    // Next append should query DB for current max version, not use stale cache
    const e4 = store.append(makeTextDelta("s1", "m1", "c"));
    expect(e4.streamVersion).toBe(3); // 0, 1, 2, then 3
    expect(e4.sequence).toBe(4);
  });

  it("handles reset with empty store", () => {
    store.resetVersionCache();
    harness.seedSession("s1");
    const e1 = store.append(makeSessionCreatedEvent("s1"));
    expect(e1.streamVersion).toBe(0);
  });

  it("handles reset after events from multiple sessions", () => {
    harness.seedSession("s1");
    harness.seedSession("s2");
    store.append(makeSessionCreatedEvent("s1"));
    store.append(makeSessionCreatedEvent("s2"));
    store.append(makeTextDelta("s1", "m1", "a"));

    store.resetVersionCache();

    // Both sessions should resolve correctly from DB
    const e4 = store.append(makeTextDelta("s1", "m1", "b"));
    const e5 = store.append(makeTextDelta("s2", "m2", "c"));
    expect(e4.streamVersion).toBe(2); // s1: 0, 1, then 2
    expect(e5.streamVersion).toBe(1); // s2: 0, then 1
  });
});
```

---

## 5. Specific Additions: Property-Based Tests

**Addresses:** F6 (missing properties), F12 (state machine generator)

### F6: Property 6 — Eviction Safety

Add to the T4 property tests (new file `test/unit/persistence/eviction.prop.test.ts`):

```typescript
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  createTestHarness,
  makeSessionCreatedEvent,
  makeTextDelta,
} from "../../helpers/persistence-factories.js";
import { EventStoreEviction } from "../../../src/lib/persistence/event-store-eviction.js";

describe("Property: Eviction Safety", () => {
  it("evicting random sessions leaves no FK violations or orphans", () => {
    fc.assert(
      fc.property(
        // Generate 1-10 sessions, each with 1-20 events
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 20 }),
        // Random subset to evict (as percentage)
        fc.float({ min: 0, max: 1, noNaN: true }),
        (sessionCount, eventsPerSession, evictRatio) => {
          const harness = createTestHarness();
          const sessionIds: string[] = [];

          // Seed sessions and events
          for (let s = 0; s < sessionCount; s++) {
            const sid = `s-${s}`;
            sessionIds.push(sid);
            harness.seedSession(sid);
            harness.eventStore.append(makeSessionCreatedEvent(sid));
            for (let e = 1; e < eventsPerSession; e++) {
              harness.eventStore.append(makeTextDelta(sid, `m-${s}`, `delta-${e}`));
            }
          }

          // Evict a random subset
          const evictCount = Math.floor(sessionIds.length * evictRatio);
          const toEvict = sessionIds.slice(0, evictCount);
          const evictor = new EventStoreEviction(harness.db);
          for (const sid of toEvict) {
            evictor.evictSession(sid);
          }

          // Assert: no FK violations
          expect(() => {
            harness.db.execute("PRAGMA foreign_key_check");
          }).not.toThrow();

          // Assert: no orphaned events (every event's session_id exists in sessions)
          const orphanedEvents = harness.db.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count FROM events e
             WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id)`,
          );
          expect(orphanedEvents!.count).toBe(0);

          // Assert: remaining events have valid sequences
          const remaining = sessionIds.filter(s => !toEvict.includes(s));
          for (const sid of remaining) {
            const events = harness.eventStore.readBySession(sid, undefined);
            for (let i = 1; i < events.length; i++) {
              expect(events[i].streamVersion).toBe(events[i - 1].streamVersion + 1);
            }
          }

          harness.close();
        },
      ),
      { numRuns: 50 },
    );
  });
});
```

### F6: Property 7 — Tiered Write Pipeline Event Ordering

Add to `test/unit/persistence/tiered-write.prop.test.ts`:

```typescript
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { createTestHarness } from "../../helpers/persistence-factories.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";
import { DualWriteHook, SYNC_TYPES } from "../../../src/lib/persistence/dual-write-hook.js";

describe("Property: Tiered Write Pipeline Event Ordering", () => {
  it("all events appear exactly once with preserved ordering within tiers", () => {
    const sseTypeGen = fc.constantFrom(
      "session.status", "session.error", "permission.asked", "permission.replied",
      "message.created", "message.updated", "message.part.delta",
      "message.part.updated", "question.asked",
    );

    fc.assert(
      fc.property(
        fc.array(sseTypeGen, { minLength: 1, maxLength: 50 }),
        (eventTypes) => {
          const harness = createTestHarness();
          harness.seedSession("s1");
          const hook = new DualWriteHook({ persistence: harness.layer });

          for (const type of eventTypes) {
            hook.onSSEEvent(
              makeSSEEvent(type as any, { sessionID: "s1" }),
              "s1",
            );
          }

          // Drain microtask queue (for deferred events)
          // In test, we can synchronously flush

          const stored = harness.eventStore.readFromSequence(0);

          // Every event appears exactly once (no duplicate eventIds)
          const storedIds = new Set(stored.map(e => e.eventId));
          expect(storedIds.size).toBe(stored.length);

          // Global sequence is monotonically increasing
          for (let i = 1; i < stored.length; i++) {
            expect(stored[i].sequence).toBeGreaterThan(stored[i - 1].sequence);
          }

          // Within the single session, streamVersions are contiguous
          const versions = stored.map(e => e.streamVersion);
          for (let i = 0; i < versions.length; i++) {
            expect(versions[i]).toBe(i);
          }

          harness.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});
```

### F12: State Machine Generator for Property 2 (Projection Convergence)

The existing `arbitraries.ts` generates independent SSE events — no state machine for valid sequences. Property 2 requires sequences where preconditions are respected (e.g., `message.created` before `text.delta`).

Design a generator using fast-check's `fc.commands` model-based testing API:

```typescript
// test/helpers/event-sequence-generator.ts
import fc from "fast-check";
import {
  canonicalEvent,
  createEventId,
  type CanonicalEvent,
} from "../../src/lib/persistence/events.js";
import { FIXED_TEST_TIMESTAMP } from "./persistence-factories.js";

/** Tracks what entities exist so commands can check preconditions. */
interface SequenceState {
  sessions: Set<string>;
  messages: Map<string, string>;       // messageId → sessionId
  activeTools: Map<string, string>;     // callId → messageId
  pendingPermissions: Set<string>;      // permissionId
  nextEventTime: number;
}

function initialState(): SequenceState {
  return {
    sessions: new Set(),
    messages: new Map(),
    activeTools: new Map(),
    pendingPermissions: new Set(),
    nextEventTime: FIXED_TEST_TIMESTAMP,
  };
}

/** Base class for state-machine commands that emit canonical events. */
abstract class EventCommand implements fc.Command<SequenceState, CanonicalEvent[]> {
  abstract check(state: Readonly<SequenceState>): boolean;
  abstract run(state: SequenceState, events: CanonicalEvent[]): void;
  abstract toString(): string;
}

class CreateSessionCommand extends EventCommand {
  constructor(private sessionId: string) { super(); }
  check(state: Readonly<SequenceState>) { return !state.sessions.has(this.sessionId); }
  run(state: SequenceState, events: CanonicalEvent[]) {
    state.sessions.add(this.sessionId);
    events.push(canonicalEvent("session.created", this.sessionId, {
      sessionId: this.sessionId, title: "Test", provider: "opencode",
    }, { eventId: createEventId(), createdAt: state.nextEventTime++ }));
  }
  toString() { return `CreateSession(${this.sessionId})`; }
}

class CreateMessageCommand extends EventCommand {
  constructor(
    private sessionId: string,
    private messageId: string,
    private role: "user" | "assistant",
  ) { super(); }
  check(state: Readonly<SequenceState>) {
    return state.sessions.has(this.sessionId) && !state.messages.has(this.messageId);
  }
  run(state: SequenceState, events: CanonicalEvent[]) {
    state.messages.set(this.messageId, this.sessionId);
    events.push(canonicalEvent("message.created", this.sessionId, {
      messageId: this.messageId, role: this.role,
    }, { eventId: createEventId(), createdAt: state.nextEventTime++ }));
  }
  toString() { return `CreateMessage(${this.sessionId}, ${this.messageId})`; }
}

class EmitTextDeltaCommand extends EventCommand {
  constructor(
    private messageId: string,
    private text: string,
  ) { super(); }
  check(state: Readonly<SequenceState>) { return state.messages.has(this.messageId); }
  run(state: SequenceState, events: CanonicalEvent[]) {
    const sessionId = state.messages.get(this.messageId)!;
    events.push(canonicalEvent("text.delta", sessionId, {
      messageId: this.messageId, partId: "p1", text: this.text,
    }, { eventId: createEventId(), createdAt: state.nextEventTime++ }));
  }
  toString() { return `TextDelta(${this.messageId}, "${this.text}")`; }
}

// Additional commands follow the same pattern:
// StartToolCommand, CompleteToolCommand,
// AskPermissionCommand, ResolvePermissionCommand,
// SessionStatusCommand, etc.
// Each: check() validates preconditions, run() mutates state + emits event.

/**
 * Generate a valid canonical event sequence respecting lifecycle preconditions.
 * Uses fast-check's command-based model testing.
 */
export function validEventSequence(
  opts?: { maxSessions?: number; maxMessages?: number; maxEvents?: number },
): fc.Arbitrary<CanonicalEvent[]> {
  const maxS = opts?.maxSessions ?? 3;
  const maxM = opts?.maxMessages ?? 10;

  const sessionIds = Array.from({ length: maxS }, (_, i) => `s-${i}`);
  const messageIds = Array.from({ length: maxM }, (_, i) => `m-${i}`);

  const commandGens = [
    fc.constantFrom(...sessionIds).map(id => new CreateSessionCommand(id)),
    fc.tuple(
      fc.constantFrom(...sessionIds),
      fc.constantFrom(...messageIds),
      fc.constantFrom("user" as const, "assistant" as const),
    ).map(([s, m, r]) => new CreateMessageCommand(s, m, r)),
    fc.tuple(
      fc.constantFrom(...messageIds),
      fc.string({ minLength: 1, maxLength: 20 }),
    ).map(([m, t]) => new EmitTextDeltaCommand(m, t)),
  ];

  return fc.commands(commandGens, { maxCommands: opts?.maxEvents ?? 30 }).map(cmds => {
    const state = initialState();
    const events: CanonicalEvent[] = [];
    for (const cmd of cmds) {
      if ((cmd as EventCommand).check(state)) {
        (cmd as EventCommand).run(state, events);
      }
    }
    return events;
  });
}
```

This generator should be referenced in the T4.2 property test (Property 2: Projection Convergence) in the plan.

---

## 6. Specific Additions: Failure Injection Tests

**Addresses:** F9

Add to Tasks 10-11 test code blocks.

### Worked Example: Task 10 (DualWriteHook failure paths)

```typescript
describe("tiered write failure isolation", () => {
  let harness: TestHarness;
  let hook: DualWriteHook;

  beforeEach(() => {
    harness = createTestHarness();
    harness.seedSession("s1");
    hook = new DualWriteHook({ persistence: harness.layer });
  });

  afterEach(() => { harness.close(); });

  it("relay continues when deferred write fails (SQLITE_BUSY)", () => {
    // Make append throw for deferred events only
    vi.spyOn(harness.eventStore, "append").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    const sseEvent = makeSSEEvent("message.part.delta", {
      sessionID: "s1", messageID: "m1", partID: "p1",
      field: "text", delta: "hello",
    });

    // Should not throw — error is caught and logged, relay unaffected
    expect(() => hook.onSSEEvent(sseEvent, "s1")).not.toThrow();
  });

  it("onReconnect() clears pending deferred writes", () => {
    // Queue a deferred event
    hook.onSSEEvent(makeSSEEvent("message.part.delta", {
      sessionID: "s1", messageID: "m1", partID: "p1",
      field: "text", delta: "hello",
    }), "s1");

    // Reconnect before microtask runs
    hook.onReconnect();

    // Stats should show the reset
    const stats = hook.getStats();
    expect(stats.reconnectCount).toBeGreaterThan(0);
  });

  it("SYNC_TYPE event during pending deferred batch processes correctly", () => {
    // Queue deferred events (text.delta)
    hook.onSSEEvent(makeSSEEvent("message.part.delta", {
      sessionID: "s1", messageID: "m1", partID: "p1",
      field: "text", delta: "hello",
    }), "s1");

    // SYNC_TYPE event arrives while deferred batch pending (permission.asked)
    const syncResult = hook.onSSEEvent(makeSSEEvent("permission.asked", {
      id: "perm-1", sessionID: "s1", permission: "read",
      patterns: ["/test"], metadata: {},
    }), "s1");

    // Sync event should be written immediately, not deferred
    expect(syncResult.ok).toBe(true);
  });

  it("queueMicrotask callback after stop is safe", async () => {
    // Queue deferred events
    hook.onSSEEvent(makeSSEEvent("message.part.delta", {
      sessionID: "s1", messageID: "m1", partID: "p1",
      field: "text", delta: "hello",
    }), "s1");

    // Stop the hook (simulating daemon shutdown)
    hook.stop();

    // Let microtask run — should not throw
    await new Promise(resolve => queueMicrotask(resolve));

    // No crash, no stale writes
  });
});
```

### Checklist: Also add to Task 11

Task 11 (SSE wiring integration) should include tests for:
- SSE reconnect (`onReconnect()`) while deferred writes are in-flight
- Network flap scenario: rapid disconnect/reconnect cycle

---

## 7. Specific Additions: Integration & Equivalence Tests

**Addresses:** F10

### JSONL↔SQLite Read Equivalence Contract Test

Add as a standalone Phase 4 prerequisite test file. Uses the existing `.opencode.json.gz` recorded fixtures.

```typescript
// test/integration/persistence/dual-read-equivalence.test.ts
import { describe, it, expect, afterEach } from "vitest";
import {
  createTestHarness,
  type TestHarness,
} from "../../helpers/persistence-factories.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import {
  ProjectionRunner,
  createAllProjectors,
} from "../../../src/lib/persistence/projection-runner.js";
import { loadOpenCodeRecording } from "../../helpers/opencode-utils.js";

/**
 * Normalize session/message data for structural comparison.
 * Strips implementation-specific fields (internal IDs, exact timestamps)
 * while preserving semantic content (titles, roles, text, tool results).
 */
function normalizeSessionList(sessions: unknown[]): unknown[] {
  return sessions.map((s: any) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    messageCount: s.messageCount ?? s.message_count,
  })).sort((a: any, b: any) => a.id.localeCompare(b.id));
}

function normalizeMessages(messages: unknown[]): unknown[] {
  return messages.map((m: any) => ({
    id: m.id,
    role: m.role,
    textLength: (m.text ?? m.content ?? "").length,
    partCount: (m.parts ?? []).length,
  })).sort((a: any, b: any) => a.id.localeCompare(b.id));
}

describe("JSONL ↔ SQLite read equivalence", () => {
  let harness: TestHarness;

  afterEach(() => { harness?.close(); });

  it("chat-tool-call produces identical read models from both paths", async () => {
    const recording = await loadOpenCodeRecording("chat-tool-call");

    // Path A: existing relay pipeline (JSONL/in-memory)
    const jsonlHarness = createRelayHarness(recording);
    await jsonlHarness.replay();
    const jsonlSessions = jsonlHarness.sessionMgr.listSessions();
    const jsonlMessages = jsonlHarness.messageCache.getEvents(
      jsonlSessions[0].id,
    );

    // Path B: dual-write pipeline (SQLite)
    harness = createTestHarness();
    const hook = new DualWriteHook({ persistence: harness.layer });
    const runner = new ProjectionRunner(harness.db, createAllProjectors());
    const readQuery = new ReadQueryService(harness.db);

    // Replay same recording through dual-write
    for (const event of recording.events) {
      const result = hook.onSSEEvent(event, recording.sessionId);
      if (result.ok) {
        for (const stored of harness.eventStore.readFromSequence(
          runner.getHighWaterMark(),
        )) {
          runner.projectEvent(stored);
        }
      }
    }

    const sqliteSessions = readQuery.listSessions();
    const sqliteMessages = readQuery.getSessionMessages(recording.sessionId);

    // Compare structural shape (ignoring format differences)
    expect(normalizeSessionList(sqliteSessions))
      .toEqual(normalizeSessionList(jsonlSessions));
    expect(normalizeMessages(sqliteMessages))
      .toEqual(normalizeMessages(jsonlMessages));
  });

  // Additional recordings to test:
  // "chat-simple", "chat-streaming", "chat-permission-flow"
});
```

### End-to-End Pipeline Test (T6)

Reference the `createRealisticSSESequence()` from `sse-factories.ts` (Section 1b):

```typescript
// test/integration/persistence/event-pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestHarness,
  type TestHarness,
} from "../../helpers/persistence-factories.js";
import { createRealisticSSESequence } from "../../helpers/sse-factories.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import {
  ProjectionRunner,
  createAllProjectors,
} from "../../../src/lib/persistence/projection-runner.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";

describe("Event Pipeline Integration", () => {
  let harness: TestHarness;

  beforeEach(() => { harness = createTestHarness(); });
  afterEach(() => { harness.close(); });

  it("SSE events produce correct read-model state end-to-end", () => {
    harness.seedSession("sess-1");
    const hook = new DualWriteHook({ persistence: harness.layer });
    const runner = new ProjectionRunner(harness.db, createAllProjectors());
    const readQuery = new ReadQueryService(harness.db);
    let lastSeq = 0;

    // Feed realistic SSE sequence through full pipeline
    const scenario = createRealisticSSESequence("sess-1");
    for (const event of scenario.events) {
      const result = hook.onSSEEvent(event, "sess-1");
      if (result.ok) {
        for (const stored of harness.eventStore.readFromSequence(lastSeq)) {
          runner.projectEvent(stored);
          lastSeq = stored.sequence;
        }
      }
    }

    // Assert read model via ReadQueryService
    const sessions = readQuery.listSessions();
    expect(sessions).toHaveLength(1);

    const messages = readQuery.getSessionMessages("sess-1");
    expect(messages.length).toBe(scenario.expectedMessageCount);

    // Verify text assembly
    const assistantMsg = messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();

    // Verify tool count
    const history = readQuery.getSessionHistory("sess-1");
    const toolParts = history.flatMap((m: any) =>
      (m.parts ?? []).filter((p: any) => p.type === "tool"),
    );
    expect(toolParts.length).toBe(scenario.expectedToolCount);
  });
});
```

---

## 8. Specific Additions: Schema Assertions

**Addresses:** F13

Add to Task 3's test code block:

```typescript
describe("Schema FK constraints", () => {
  let harness: TestHarness;

  beforeEach(() => { harness = createTestHarness(); });
  afterEach(() => { harness.close(); });

  it("uses RESTRICT (not CASCADE) for session foreign keys", () => {
    harness.seedSession("s1");
    harness.eventStore.append(makeSessionCreatedEvent("s1"));

    // Deleting session with dependent events should fail (RESTRICT)
    expect(() =>
      harness.db.execute("DELETE FROM sessions WHERE id = ?", ["s1"]),
    ).toThrow(/FOREIGN KEY constraint/);
  });

  it("documents FK RESTRICT as deliberate — eviction must delete dependents first", () => {
    // This test exists to prevent future migrations from silently adding ON DELETE CASCADE.
    // S5 eviction deletes in FK-safe order across 9 tables.
    // CASCADE would bypass this ordering and could cause data loss.
    const fkTables = [
      "events", "messages", "turns", "activities",
      "pending_approvals", "session_providers",
    ];

    for (const table of fkTables) {
      const sid = `s-fk-${table}`;
      harness.seedSession(sid);

      // Each table needs at least one dependent row
      // (table-specific INSERT — the executing agent fills these per-schema)

      // Verify RESTRICT behavior
      expect(() =>
        harness.db.execute("DELETE FROM sessions WHERE id = ?", [sid]),
      ).toThrow(/FOREIGN KEY/);

      // Clean up: delete dependent first, then session
      harness.db.execute(`DELETE FROM ${table} WHERE session_id = ?`, [sid]);
      harness.db.execute("DELETE FROM sessions WHERE id = ?", [sid]);
    }
  });
});
```

---

## 9. Coding Guidelines Additions

**Addresses:** F11

Add the following to the plan's preamble (after the amendment history table):

### Test Code Quality Rules

1. **Ban `as CanonicalEvent` in test code.** All event construction must go through `canonicalEvent()` or a shared factory that calls it internally. The `as` cast erases the discriminated union's type-data correspondence — a `type: "session.created"` event could carry `TextDeltaPayload` data and TypeScript won't flag it.

   **Only exception:** Intentionally invalid events for testing validation. These must use `as unknown as CanonicalEvent` with an explanatory comment:
   ```typescript
   // Intentionally invalid — testing that validation catches mismatched type/data
   const invalid = { ...validEvent, data: {} } as unknown as CanonicalEvent;
   ```

2. **No local factory copies.** Every task imports from `test/helpers/{persistence,provider,sse}-factories.ts`. If a task needs a factory that doesn't exist, add it to the shared module — never define it locally.

3. **Deterministic timestamps by default.** All test factories use `FIXED_TEST_TIMESTAMP`. Override explicitly with `{ createdAt: Date.now() }` only when testing time-dependent behavior. This ensures snapshot tests are deterministic.

4. **`seedSession()` title must match `makeSessionCreatedEvent()` title.** Both default to `"Test Session"`. If a test needs a custom title, pass it to both.

5. **`seedMessage()` writes to `message_parts` table.** Never insert a `parts` column into the `messages` table directly. Use `harness.seedMessage()` which handles the P1 normalization.

---

## 10. Application Manifest & Order

### Dependency Order

```
Phase 1 (blocking):
  Task 0 (new)  ← F2: create shared factories
    └── F3 + F4 + F8 + F11: type safety and determinism baked into factories

Phase 2 (high priority, requires Task 0):
  Task 5       ← F5 + F14: add boundary tests
  Tasks 24.5, 26, 28, 30  ← F1: add wiring test blocks

Phase 3 (medium priority):
  Tasks 5-11   ← F4 + F7 + F11: replace local factories with shared imports
  Tasks 15-20  ← F4 + F8: replace local makeStored, add snapshot tests (T7)
  Tasks 31-32  ← T5: fix seedMessage to use message_parts table

Phase 4 (parallel):
  Task 3       ← F13: add FK RESTRICT assertion tests
  Tasks 10-11  ← F9: add failure injection tests
  Phase 4 prereq ← F10: add JSONL-SQLite equivalence test
  New files    ← F6 + F12: property tests for eviction safety + pipeline ordering
```

### Finding-to-Task Map

| Finding | Severity | Amendment | Tasks Affected |
|---------|----------|-----------|----------------|
| F1 | High | Add wiring test blocks (Section 3) | 24.5, 26, 28, 30 |
| F2 | High | Insert Task 0 (Section 1) | New task before Task 1 |
| F3 | High | `makeSSEEvent` type-constrained (Section 1b) | 7, 10, 11, all SSE tests |
| F4 | Medium | Replace `as CanonicalEvent` with `canonicalEvent()` (Section 2) | 5, 7, 9, 10, 15-20, 21, 22 |
| F5 | Medium | Add boundary tests (Section 4) | 5 |
| F6 | Medium | Add Properties 6+7 (Section 5) | New files (Phase 7, Phase 2) |
| F7 | Medium | Title consistency + FK-safe seeding (Section 2) | 5, 6, 8, 9 |
| F8 | Medium | `FIXED_TEST_TIMESTAMP` defaults (Section 1a) | 15-20 snapshots |
| F9 | Medium | Failure injection tests (Section 6) | 10, 11 |
| F10 | Medium | Equivalence contract test (Section 7) | New file (Phase 4 prereq) |
| F11 | Low-Med | Ban `as CanonicalEvent` guideline (Section 9) | 14+ code blocks |
| F12 | Low-Med | State machine generator (Section 5) | T4.2 property test |
| F13 | Low | FK RESTRICT assertion (Section 8) | 3 |
| F14 | Low | `resetVersionCache()` test (Section 4) | 5 |

### Plan Amendment History Entry

Add to the plan's Amendment History table:

| Date | Source Document | Summary |
|------|----------------|---------|
| 2026-04-09 | `docs/plans/2026-04-09-testing-audit-amendment-spec.md` | In-place amendments for all 14 audit findings: Task 0 shared test factories (F2), type-safe `makeSSEEvent` (F3), `canonicalEvent()` usage replacing `as` casts (F4/F11), deterministic timestamps (F8), wiring tests for Tasks 24.5/26/28/30 (F1), boundary tests (F5/F14), property tests for eviction + pipeline (F6/F12), failure injection (F9), JSONL-SQLite equivalence (F10), FK RESTRICT assertions (F13), schema-safe `seedMessage` (F7/T5), coding guidelines banning `as CanonicalEvent`. |
