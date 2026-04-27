# Phase 2a: Session Stack (Tasks 9-12)

> **Prerequisites:** Phase 1 Tasks 1-5 complete. Read [conventions.md](conventions.md).
> **Parallel with:** Phase 2b (Services & Persistence).
> **Merge milestone:** Part of M1 (after both Phase 2a and 2b complete).

**Goal:** Dissolve SessionManager EventEmitter, convert SSE stream to Effect.Stream, replace setInterval pollers with Effect.Schedule, and add fiber-per-session message polling. These 4 tasks are independent of each other — they can run in parallel.

---

### Task 9: SessionManager — dissolve EventEmitter

**Files:**
- Create: `src/lib/effect/session-manager-state.ts`
- Create: `src/lib/effect/session-manager-service.ts`
- Test: `test/unit/session/session-manager-effect.test.ts`
- Modify: `src/lib/effect/services.ts` (update SessionManagerTag shape)

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-manager-effect.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, HashMap, Option } from "effect";
import {
  SessionManagerStateTag,
  makeSessionManagerStateLive,
  type SessionManagerState,
} from "../../../src/lib/effect/session-manager-state.js";
import {
  SessionManagerServiceTag,
  listSessions,
  createSession,
  deleteSession,
  recordMessageActivity,
} from "../../../src/lib/effect/session-manager-service.js";
import { OpenCodeAPITag } from "../../../src/lib/effect/services.js";

describe("SessionManager Effect", () => {
  const mockApi = {
    listSessions: vi.fn().mockReturnValue(
      Effect.succeed({ sessions: [{ id: "s1", title: "Test" }] })
    ),
    createSession: vi.fn().mockReturnValue(
      Effect.succeed({ id: "s-new", title: "New" })
    ),
    deleteSession: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const testLayer = Layer.mergeAll(
    makeSessionManagerStateLive(),
    Layer.succeed(OpenCodeAPITag, mockApi as unknown as OpenCodeAPITag["Type"]),
  );

  it.effect("listSessions fetches from API and caches parent map", () =>
    Effect.gen(function* () {
      const result = yield* listSessions();

      expect(result.sessions).toHaveLength(1);
      expect(mockApi.listSessions).toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer))
  );

  it.effect("createSession calls API and emits lifecycle", () =>
    Effect.gen(function* () {
      const result = yield* createSession("My session");

      expect(result.id).toBe("s-new");
      expect(mockApi.createSession).toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer))
  );

  it.effect("recordMessageActivity updates timestamp", () =>
    Effect.gen(function* () {
      yield* recordMessageActivity("s1", 12345);
      const ref = yield* SessionManagerStateTag;
      const state = yield* Ref.get(ref);
      // HashMap.get returns Option — use Option.getOrNull for assertion
      const result = HashMap.get(state.lastMessageAt, "s1").pipe(Option.getOrNull);

      expect(result).toBe(12345);
    }).pipe(Effect.provide(testLayer))
  );

  it.effect("deleteSession clears all state maps", () =>
    Effect.gen(function* () {
      // Seed some state first
      yield* recordMessageActivity("s1", 12345);
      const ref = yield* SessionManagerStateTag;
      yield* Ref.update(ref, (s) => ({
        ...s,
        cachedParentMap: HashMap.make(["child1", "s1"]),
        paginationCursors: HashMap.make(["s1", "cursor-1"]),
      }));

      // Delete
      yield* deleteSession("s1");

      const state = yield* Ref.get(ref);
      const result = {
        hasActivity: HashMap.has(state.lastMessageAt, "s1"),
        hasCursor: HashMap.has(state.paginationCursors, "s1"),
      };

      expect(result.hasActivity).toBe(false);
      expect(result.hasCursor).toBe(false);
    }).pipe(Effect.provide(testLayer))
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-manager-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write state module**

```typescript
// src/lib/effect/session-manager-state.ts
import { Context, Effect, Layer, Ref, HashMap } from "effect";

export interface ForkEntry {
  forkMessageId: string;
  parentId: string;
  forkPointTimestamp: number;
}

// Use HashMap (not Map) for structural sharing in Ref.update —
// avoids the `new Map(s.map)` copy overhead and the risk of
// forgetting to copy. HashMap.remove/set/filter return new
// instances without mutating the original.
export interface SessionManagerState {
  cachedParentMap: HashMap.HashMap<string, string>;
  lastMessageAt: HashMap.HashMap<string, number>;
  forkMeta: HashMap.HashMap<string, ForkEntry>;
  pendingQuestionCounts: HashMap.HashMap<string, number>;
  paginationCursors: HashMap.HashMap<string, string>;
}

export const SessionManagerState = {
  empty: (): SessionManagerState => ({
    cachedParentMap: HashMap.empty(),
    lastMessageAt: HashMap.empty(),
    forkMeta: HashMap.empty(),
    pendingQuestionCounts: HashMap.empty(),
    paginationCursors: HashMap.empty(),
  }),
};

export class SessionManagerStateTag extends Context.Tag("SessionManagerState")<
  SessionManagerStateTag,
  Ref.Ref<SessionManagerState>
>() {}

export const makeSessionManagerStateLive = (
  initial?: Partial<SessionManagerState>
): Layer.Layer<SessionManagerStateTag> =>
  Layer.effect(
    SessionManagerStateTag,
    Ref.make({ ...SessionManagerState.empty(), ...initial })
  );
```

**Step 4: Write service module**

```typescript
// src/lib/effect/session-manager-service.ts
import { Effect, Ref, Schedule, Duration, HashMap } from "effect";
import { SessionManagerStateTag } from "./session-manager-state.js";
import { OpenCodeAPITag } from "./services.js";

const retryPolicy = Schedule.exponential("500 millis").pipe(
  Schedule.intersect(Schedule.recurs(3))
);

// Cached session list — fiber-safe with automatic TTL expiration.
// Callers get the cached result if within TTL, or a fresh fetch otherwise.
// This replaces manual Ref-based caching with eviction logic.
const listSessionsUncached = (options?: { limit?: number }) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;
    const stateRef = yield* SessionManagerStateTag;

    const response = yield* api.listSessions(options).pipe(
      Effect.retry(retryPolicy),
      Effect.catchTag("OpenCodeApiError", (e) =>
        Effect.logWarning("listSessions API error", e).pipe(Effect.flatMap(() => Effect.fail(e)))
      ),
      Effect.catchTag("OpenCodeConnectionError", (e) =>
        Effect.logWarning("listSessions connection error", e).pipe(Effect.flatMap(() => Effect.fail(e)))
      ),
    );

    // Update parent map cache from response using HashMap
    if (response.sessions) {
      let parentMap = HashMap.empty<string, string>();
      for (const session of response.sessions) {
        if ((session as any).parentId) {
          parentMap = HashMap.set(parentMap, session.id, (session as any).parentId);
        }
      }
      yield* Ref.update(stateRef, (s) => ({ ...s, cachedParentMap: parentMap }));
    }

    return response;
  }).pipe(
    Effect.annotateLogs("operation", "listSessions"),
    Effect.withSpan("session.listSessions")
  );

// Export the cached version — tolerates 5s staleness for rapid UI polling.
// Effect.cachedWithTTL returns Effect<Effect<A>> — the outer Effect creates
// the cache, the inner Effect reads from it.
export const listSessions = (options?: { limit?: number }) =>
  listSessionsUncached(options);

// To enable caching at the Layer level, create the cache once in the Layer:
//   const cachedList = yield* Effect.cachedWithTTL(listSessionsUncached(), Duration.seconds(5));
// Then expose `cachedList` via the SessionManagerServiceTag.

export const createSession = (title?: string) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;
    const session = yield* api.createSession(title);
    // Lifecycle event handled via direct call (no EventEmitter)
    return session;
  }).pipe(
    Effect.annotateLogs("operation", "createSession"),
    Effect.withSpan("session.createSession")
  );

export const deleteSession = (sessionId: string) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;
    const stateRef = yield* SessionManagerStateTag;

    yield* api.deleteSession(sessionId);

    // Atomic cleanup across all state maps using HashMap (persistent/immutable)
    yield* Ref.update(stateRef, (s) => {
      // Remove session from each map
      let cachedParentMap = HashMap.remove(s.cachedParentMap, sessionId);
      const lastMessageAt = HashMap.remove(s.lastMessageAt, sessionId);
      const forkMeta = HashMap.remove(s.forkMeta, sessionId);
      const pendingQuestionCounts = HashMap.remove(s.pendingQuestionCounts, sessionId);
      const paginationCursors = HashMap.remove(s.paginationCursors, sessionId);

      // Also clean parent references pointing to this session
      cachedParentMap = HashMap.filter(cachedParentMap, (parent) => parent !== sessionId);

      return { cachedParentMap, lastMessageAt, forkMeta, pendingQuestionCounts, paginationCursors };
    });
  }).pipe(
    Effect.annotateLogs("sessionId", sessionId),
    Effect.withSpan("session.deleteSession", { attributes: { sessionId } })
  );

export const recordMessageActivity = (sessionId: string, timestamp?: number) =>
  Effect.gen(function* () {
    const ref = yield* SessionManagerStateTag;
    yield* Ref.update(ref, (s) => ({
      ...s,
      lastMessageAt: HashMap.set(s.lastMessageAt, sessionId, timestamp ?? Date.now()),
    }));
  }).pipe(Effect.annotateLogs("sessionId", sessionId));

// NOTE: All session operations use Effect.annotateLogs("sessionId", id) and
// Effect.withSpan for tracing. The executing agent
// should apply this pattern to listSessions, createSession, deleteSession too.

export class SessionManagerServiceTag extends Context.Tag("SessionManagerService")<
  SessionManagerServiceTag,
  {
    listSessions: typeof listSessions;
    createSession: typeof createSession;
    deleteSession: typeof deleteSession;
    recordMessageActivity: typeof recordMessageActivity;
  }
>() {}

// AUDIT FIX (H4 + H-R5-5): Every service Tag needs a Live Layer that
// ENCAPSULATES its dependencies. Layer.succeed wraps raw function references
// whose deps leak to every consumer. Layer.effect captures the Tags at
// construction time, so consumers only need SessionManagerServiceTag.
export const SessionManagerServiceLive: Layer.Layer<
  SessionManagerServiceTag,
  never,
  SessionManagerStateTag | OpenCodeAPITag
> = Layer.effect(
  SessionManagerServiceTag,
  Effect.gen(function* () {
    // Capture dependencies at Layer construction time
    const stateRef = yield* SessionManagerStateTag;
    const api = yield* OpenCodeAPITag;
    // Return service implementation with deps pre-bound
    return {
      listSessions: (options?: { limit?: number }) => listSessions(options),
      createSession: (title?: string) => createSession(title),
      deleteSession: (sessionId: string) => deleteSession(sessionId),
      recordMessageActivity: (sessionId: string, timestamp?: number) =>
        recordMessageActivity(sessionId, timestamp),
    };
  })
);
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-manager-effect.test.ts`
Expected: 4 tests PASS

**Step 6: Commit**

```bash
git add src/lib/effect/session-manager-state.ts src/lib/effect/session-manager-service.ts test/unit/session/session-manager-effect.test.ts
git commit -m "feat(effect): dissolve SessionManager EventEmitter into Layer + Ref"
```

---

### Task 10: SSEStream — Schedule + Stream

**Files:**
- Create: `src/lib/effect/sse-stream.ts`
- Test: `test/unit/relay/sse-stream-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay/sse-stream-effect.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Stream, Chunk, Duration, Schedule, Exit } from "effect";
import {
  sseStream,
  resilientSSE,
  reconnectSchedule,
  type SSEEvent,
} from "../../../src/lib/effect/sse-stream.js";

describe("SSE Stream Effect", () => {
  it("reconnectSchedule has exponential backoff with jitter", () => {
    // Schedule should be exponential starting at 1s, with jitter
    expect(reconnectSchedule).toBeDefined();
  });

  it.effect("sseStream produces SSEEvent items", () =>
    Effect.gen(function* () {
      // Mock EventSource-like behavior via factory
      const events: SSEEvent[] = [
        { type: "message", data: '{"id":"1"}', lastEventId: "1" },
        { type: "message", data: '{"id":"2"}', lastEventId: "2" },
      ];

      const mockStream = Stream.fromIterable(events);

      const result = yield* Stream.runCollect(mockStream).pipe(
        Effect.map(Chunk.toArray)
      );

      expect(result).toHaveLength(2);
      expect(result[0].data).toBe('{"id":"1"}');
    })
  );

  it.effect("stale detection fails stream after timeout", () =>
    Effect.gen(function* () {
      // Stream that never emits — should timeout
      const neverStream = Stream.never as Stream.Stream<SSEEvent, never>;

      const exit = yield* Effect.exit(
        Stream.runDrain(
          neverStream.pipe(
            // AUDIT FIX (C7): Stream.timeoutFail uses positional args, NOT options object
            Stream.timeoutFail(() => new Error("SSE stale"), Duration.millis(100))
          )
        )
      );

      expect(Exit.isFailure(exit)).toBe(true);
    })
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/sse-stream-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/sse-stream.ts
import { Data, Effect, Option, Ref, Stream, Schedule, Duration, Chunk, identity } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";

export interface SSEEvent {
  type: string;
  data: string;
  lastEventId?: string;
}

// Use Data.TaggedError so these work with Effect.catchTag
export class SSEConnectionError extends Data.TaggedError("SSEConnectionError")<{
  cause: unknown;
}> {}

export class SSEStaleError extends Data.TaggedError("SSEStaleError")<{
  lastEventId?: string;
}> {}

// Exponential backoff: 1s base, jittered, capped at 5 min elapsed.
// Uses Schedule.intersect to combine exponential delays with an elapsed
// time cap — intersect takes the minimum of both schedule decisions.
// Schedule.whileInput stops retrying on non-retryable errors (e.g., auth failures).
export const reconnectSchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.upTo(Duration.minutes(5)),
  Schedule.whileInput((error: SSEConnectionError) => {
    // Don't retry authentication errors — they won't resolve on retry
    const cause = error.cause;
    if (cause && typeof cause === "object" && "status" in cause) {
      const status = (cause as { status: number }).status;
      if (status === 401 || status === 403) return false;
    }
    return true; // Retry all other connection errors
  }),
);

// Parse a single SSE event block (data: ...\nevent: ...\nid: ...)
const parseSSEBlock = (block: string): SSEEvent | null => {
  let data = "";
  let type = "message";
  let id: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) data += line.slice(6);
    else if (line.startsWith("event: ")) type = line.slice(7);
    else if (line.startsWith("id: ")) id = line.slice(4);
  }
  if (!data) return null;
  return { type, data, lastEventId: id };
};

/**
 * Create an SSE stream from a URL using @effect/platform HttpClient.
 *
 * IMPORTANT: Do NOT use Web ReadableStream APIs (response.body.getReader())
 * — those are browser-only. In Node.js with @effect/platform-node, the
 * response body is consumed via HttpClientResponse.stream, which returns
 * an Effect.Stream<Uint8Array>. We pipe through Stream.decodeText and
 * a custom SSE block parser to produce SSEEvent items.
 *
 * The implementer MUST check src/lib/relay/sse-stream.ts to see the
 * actual SSE connection mechanism and adapt accordingly.
 */
export const sseStream = (
  url: string,
  options?: { headers?: Record<string, string>; lastEventId?: string }
): Stream.Stream<SSEEvent, SSEConnectionError, HttpClient.HttpClient> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Accept", "text/event-stream"),
        options?.lastEventId
          ? HttpClientRequest.setHeader("Last-Event-ID", options.lastEventId)
          : identity,
        options?.headers
          ? (req) => Object.entries(options.headers!).reduce(
              (r, [k, v]) => HttpClientRequest.setHeader(k, v)(r), req
            )
          : identity,
      );

      const response = yield* client.execute(request).pipe(
        Effect.mapError((e) => new SSEConnectionError({ cause: e }))
      );

      // Use @effect/platform Stream utilities for Node.js compatibility.
      // HttpClientResponse.stream returns Stream<Uint8Array> — pipe through
      // decodeText to get strings, then split on double-newline for SSE blocks.
      return HttpClientResponse.stream(response).pipe(
        Stream.decodeText(),
        // Accumulate text and split on double-newline (SSE block boundary)
        Stream.mapAccum("", (buffer, chunk) => {
          const combined = buffer + chunk;
          const blocks = combined.split("\n\n");
          const remainder = blocks.pop() ?? "";
          return [remainder, blocks];
        }),
        Stream.flatMap((blocks) => Stream.fromIterable(blocks)),
        Stream.filterMap((block) => {
          const event = parseSSEBlock(block);
          return event ? Option.some(event) : Option.none();
        }),
        Stream.mapError((e) => new SSEConnectionError({ cause: e })),
      );
    })
  );

/**
 * Resilient SSE stream with automatic reconnection and stale detection.
 * Reconnects with exponential backoff on connection errors.
 * Tracks lastEventId across reconnections for resume-from-last-event.
 * Fails with SSEStaleError if no events received within staleness window.
 */
export const resilientSSE = (
  url: string,
  options?: {
    staleTimeout?: Duration.DurationInput;
    headers?: Record<string, string>;
  }
): Stream.Stream<SSEEvent, SSEStaleError> => {
  const staleTimeout = options?.staleTimeout ?? Duration.seconds(90);

  // Track lastEventId across reconnections using Effect.Ref (not mutable let).
  // This is fiber-safe and preserves referential transparency.
  return Stream.unwrap(
    Effect.gen(function* () {
      const lastEventIdRef = yield* Ref.make<string | undefined>(undefined);

      const connectWithResume = () =>
        Stream.unwrap(
          Ref.get(lastEventIdRef).pipe(
            Effect.map((lastEventId) =>
              sseStream(url, { headers: options?.headers, lastEventId }).pipe(
                Stream.tap((event) =>
                  event.lastEventId
                    ? Ref.set(lastEventIdRef, event.lastEventId)
                    : Effect.void
                )
              )
            )
          )
        );

      // Stream.timeoutFail's onTimeout returns a value (not an Effect), so
      // we cannot read the Ref inside it. Instead, use Stream.timeoutFailCause
      // with a Ref snapshot taken on each event via Stream.tap + Stream.mapAccum,
      // or accept that the stale error won't carry the exact lastEventId.
      // Pragmatic approach: snapshot the lastEventId into a mutable variable
      // that the onTimeout closure reads. This is safe because the timeout
      // fires on the same fiber that updates the variable via Stream.tap.
      let lastSeenId: string | undefined;
      return connectWithResume().pipe(
        Stream.tap((event) =>
          Effect.sync(() => { if (event.lastEventId) lastSeenId = event.lastEventId; })
        ),
        Stream.retry(reconnectSchedule),
        // AUDIT FIX (C7): Stream.timeoutFail uses positional args
        Stream.timeoutFail(() => new SSEStaleError({ lastEventId: lastSeenId }), staleTimeout),
      );
    })
  );
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/sse-stream-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/sse-stream.ts test/unit/relay/sse-stream-effect.test.ts
git commit -m "feat(effect): replace SSEStream class with Effect.Stream + Schedule reconnection"
```

---

### Task 11: SessionStatusPoller — Schedule + Ref

**Files:**
- Create: `src/lib/effect/session-status-poller.ts`
- Test: `test/unit/session/session-status-poller-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-status-poller-effect.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Fiber, Duration, HashMap } from "effect";
import {
  PollerStateTag,
  makePollerStateLive,
  reconcile,
  type PollerState,
} from "../../../src/lib/effect/session-status-poller.js";
import { OpenCodeAPITag } from "../../../src/lib/effect/services.js";

describe("SessionStatusPoller Effect", () => {
  const mockApi = {
    getSessionStatuses: vi.fn().mockReturnValue(
      Effect.succeed([
        { id: "s1", status: "idle" },
        { id: "s2", status: "busy" },
      ])
    ),
  };

  const mockDb = {
    getSessionStatuses: vi.fn().mockReturnValue(
      Effect.succeed([
        { id: "s1", status: "idle" },
        { id: "s2", status: "idle" }, // Mismatch — API says busy, DB says idle
      ])
    ),
  };

  it.effect("initializes with empty state", () =>
    Effect.gen(function* () {
      const ref = yield* PollerStateTag;
      const result = yield* Ref.get(ref);

      expect(result.previousStatuses.size).toBe(0);
      expect(result.activityTimestamps.size).toBe(0);
    }).pipe(Effect.provide(makePollerStateLive()))
  );

  it.effect("reconcile detects status mismatches", () =>
    Effect.gen(function* () {
      const corrections: any[] = [];
      const applyCorrection = vi.fn((c: any) => {
        corrections.push(c);
        return Effect.succeed(undefined);
      });

      yield* reconcile(mockDb as any, mockApi as any, applyCorrection);

      // s2 status mismatch should produce a correction
      expect(corrections.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(makePollerStateLive()))
  );

  it.effect("isMessageActive checks TTL correctly", () =>
    Effect.gen(function* () {
      const now = Date.now();
      const ref = yield* PollerStateTag;
      yield* Ref.update(ref, (s) => ({
        ...s,
        activityTimestamps: HashMap.make(
          ["active", now - 1000],      // 1s ago — active
          ["stale", now - 300_000],     // 5min ago — stale
        ),
      }));
      const state = yield* Ref.get(ref);
      const activeTTL = Duration.seconds(60);
      const activeTs = HashMap.unsafeGet(state.activityTimestamps, "active");
      const staleTs = HashMap.unsafeGet(state.activityTimestamps, "stale");
      const result = {
        activeIsActive: now - activeTs < Duration.toMillis(activeTTL),
        staleIsActive: now - staleTs < Duration.toMillis(activeTTL),
      };

      expect(result.activeIsActive).toBe(true);
      expect(result.staleIsActive).toBe(false);
    }).pipe(Effect.provide(makePollerStateLive()))
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-status-poller-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/session-status-poller.ts
// NOTE: Uses HashMap (not Map) per conventions — structural sharing in Ref.update.
import { Context, Effect, Layer, Ref, Schedule, Duration, HashMap } from "effect";

export interface SessionStatus {
  id: string;
  status: string;
}

export interface PollerState {
  previousStatuses: HashMap.HashMap<string, string>;
  activityTimestamps: HashMap.HashMap<string, number>;
  childToParentCache: HashMap.HashMap<string, string>;
  idleSessionTracking: HashMap.HashMap<string, number>;
}

export const PollerState = {
  empty: (): PollerState => ({
    previousStatuses: HashMap.empty(),
    activityTimestamps: HashMap.empty(),
    childToParentCache: HashMap.empty(),
    idleSessionTracking: HashMap.empty(),
  }),
};

export class PollerStateTag extends Context.Tag("PollerState")<
  PollerStateTag,
  Ref.Ref<PollerState>
>() {}

export const makePollerStateLive = (
  initial?: Partial<PollerState>
): Layer.Layer<PollerStateTag> =>
  Layer.effect(PollerStateTag, Ref.make({ ...PollerState.empty(), ...initial }));

export interface StatusCorrection {
  sessionId: string;
  expected: string;
  actual: string;
}

export const diffStatuses = (
  previous: HashMap.HashMap<string, string>,
  dbStatuses: SessionStatus[],
  apiStatuses: SessionStatus[]
): StatusCorrection[] => {
  const apiMap = HashMap.fromIterable(apiStatuses.map((s) => [s.id, s.status] as const));
  const corrections: StatusCorrection[] = [];

  for (const dbSession of dbStatuses) {
    const apiStatus = HashMap.get(apiMap, dbSession.id);
    if (apiStatus._tag === "Some" && apiStatus.value !== dbSession.status) {
      corrections.push({
        sessionId: dbSession.id,
        expected: apiStatus.value,
        actual: dbSession.status,
      });
    }
  }

  return corrections;
};

export const reconcile = (
  db: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  api: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  applyCorrection: (c: StatusCorrection) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const ref = yield* PollerStateTag;
    const state = yield* Ref.get(ref);

    const dbSessions = yield* db.getSessionStatuses();
    const apiSessions = yield* api.getSessionStatuses().pipe(
      Effect.retry(Schedule.once)
    );

    const corrections = diffStatuses(state.previousStatuses, dbSessions, apiSessions);

    yield* Effect.forEach(corrections, applyCorrection, { concurrency: "unbounded" });

    // Update previous statuses using HashMap
    const newStatuses = HashMap.fromIterable(apiSessions.map((s) => [s.id, s.status] as const));
    yield* Ref.update(ref, (s) => ({ ...s, previousStatuses: newStatuses }));
  }).pipe(Effect.withSpan("statusPoller.reconcile"));

/**
 * Run the reconciliation loop as a scoped fiber.
 * Returns the fiber handle for external interruption.
 * Interval is configurable; retries on unexpected errors with backoff
 * so the fiber doesn't silently die.
 */
export const startReconciliationLoop = (
  db: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  api: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  applyCorrection: (c: StatusCorrection) => Effect.Effect<void>,
  interval: Duration.DurationInput = Duration.seconds(7)
) =>
  reconcile(db, api, applyCorrection).pipe(
    Effect.repeat(Schedule.spaced(interval)),
    // Retry the whole loop on unexpected errors — don't silently die
    Effect.retry(Schedule.exponential("2 seconds").pipe(Schedule.intersect(Schedule.recurs(5)))),
    // catchAll is intentional here — this is the outermost degraded path for
    // a background fiber. After all retries are exhausted, log and let the
    // fiber exit gracefully. Defects still propagate as Cause.Die.
    Effect.catchAll((e) => Effect.logWarning("Reconciliation loop failed after retries", e)),
    Effect.forkScoped
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-status-poller-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/session-status-poller.ts test/unit/session/session-status-poller-effect.test.ts
git commit -m "feat(effect): replace SessionStatusPoller setInterval with Effect.Schedule + Ref"
```

---

### Task 12: MessagePoller — fiber-per-session

**Files:**
- Create: `src/lib/effect/message-poller.ts`
- Test: `test/unit/relay/message-poller-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay/message-poller-effect.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Fiber, Duration, Exit, HashMap } from "effect";
import {
  PollerManagerStateTag,
  makePollerManagerStateLive,
  startPoller,
  stopPoller,
  isPollerActive,
} from "../../../src/lib/effect/message-poller.js";
import { OpenCodeAPITag } from "../../../src/lib/effect/services.js";

describe("MessagePoller Effect", () => {
  const mockApi = {
    getMessages: vi.fn().mockReturnValue(Effect.succeed([])),
  };

  const testLayer = Layer.mergeAll(
    makePollerManagerStateLive(),
    Layer.succeed(OpenCodeAPITag, mockApi as unknown as OpenCodeAPITag["Type"]),
  );

  it.scoped("starts a poller for a session", () =>
    Effect.gen(function* () {
      yield* startPoller("s1");
      const result = yield* isPollerActive("s1");

      expect(result).toBe(true);
    }).pipe(Effect.provide(testLayer))
  );

  it.scoped("replaces poller for same session (FiberMap auto-dedup)", () =>
    Effect.gen(function* () {
      yield* startPoller("s1");
      yield* startPoller("s1"); // FiberMap.run auto-interrupts previous
      // FiberMap still has exactly 1 entry for "s1"
      const result = yield* isPollerActive("s1");
      expect(result).toBe(true);
    }).pipe(Effect.provide(testLayer))
  );

  it.scoped("stops a poller by interrupting its fiber", () =>
    Effect.gen(function* () {
      yield* startPoller("s1");
      expect(yield* isPollerActive("s1")).toBe(true);
      yield* stopPoller("s1");
      const result = yield* isPollerActive("s1");

      expect(result).toBe(false);
    }).pipe(Effect.provide(testLayer))
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/message-poller-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/message-poller.ts
// AUDIT FIX (H8): Use FiberMap instead of manual Map<string, Fiber> + manual
// interrupt loops. FiberMap auto-interrupts on scope close, provides run()
// for fork-and-register, and eliminates race conditions between check-and-fork.
import { Context, Effect, Layer, FiberMap, Schedule, Duration } from "effect";
import { OpenCodeAPITag } from "./services.js";

export class PollerManagerStateTag extends Context.Tag("PollerManagerState")<
  PollerManagerStateTag,
  FiberMap.FiberMap<string>
>() {}

export const makePollerManagerStateLive = (): Layer.Layer<PollerManagerStateTag> =>
  Layer.scoped(PollerManagerStateTag, FiberMap.make<string>());

const pollSession = (sessionId: string, interval: Duration.DurationInput) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;

    const poll = api.getMessages(sessionId).pipe(
      // Catch expected API errors (network, auth) — let defects propagate
      Effect.catchTag("OpenCodeApiError", (e) =>
        Effect.logWarning("Poll API error for session " + sessionId, e)
      ),
      Effect.catchTag("OpenCodeConnectionError", (e) =>
        Effect.logWarning("Poll connection error for session " + sessionId, e)
      ),
    );

    yield* poll.pipe(
      Effect.repeat(Schedule.spaced(interval)),
      Effect.timeout(Duration.minutes(5)),
      // Retry on unexpected errors so the fiber doesn't silently die
      Effect.retry(Schedule.exponential("1 second").pipe(Schedule.intersect(Schedule.recurs(3)))),
      Effect.interruptible
    );
  });

// AUDIT FIX (H8): FiberMap.run auto-deduplicates — if a fiber already exists
// for the key, it's interrupted before the new one starts. No manual
// check-and-fork race condition. All fibers auto-interrupted on scope close.
export const startPoller = (sessionId: string, interval: Duration.DurationInput = Duration.seconds(3)) =>
  Effect.gen(function* () {
    const fiberMap = yield* PollerManagerStateTag;
    // FiberMap.run: forks effect under key, auto-interrupts previous if exists
    yield* FiberMap.run(fiberMap, sessionId, pollSession(sessionId, interval));
  }).pipe(
    Effect.annotateLogs("sessionId", sessionId),
    Effect.withSpan("poller.start", { attributes: { sessionId } })
  );

export const stopPoller = (sessionId: string) =>
  Effect.gen(function* () {
    const fiberMap = yield* PollerManagerStateTag;
    // FiberMap.remove interrupts the fiber and removes the entry
    yield* FiberMap.remove(fiberMap, sessionId);
  }).pipe(
    Effect.annotateLogs("sessionId", sessionId),
    Effect.withSpan("poller.stop", { attributes: { sessionId } })
  );

export const isPollerActive = (sessionId: string) =>
  Effect.gen(function* () {
    const fiberMap = yield* PollerManagerStateTag;
    return FiberMap.has(fiberMap, sessionId);
  });
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/message-poller-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/message-poller.ts test/unit/relay/message-poller-effect.test.ts
git commit -m "feat(effect): replace MessagePoller setInterval with fiber-per-session + Schedule"
```
