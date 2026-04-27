# Effect.ts Protocol Additions (from tRPC Design)

**Date:** 2026-04-23
**Status:** Draft
**Context:** Beneficial protocol-layer patterns from the tRPC/Zod migration design that the Effect.ts migration design does not cover. These are transport-architecture and data-integrity patterns — orthogonal to Effect's internal architecture wins (DI, errors, lifecycle, concurrency). All can be implemented with Effect primitives.

---

## 1. Request-Response Separation

### Problem

Current architecture models request-response pairs as fire-and-forget commands with unrelated async events. Client sends `{type: "get_models"}`, eventually receives `{type: "model_list", ...}` — correlated by convention, not types. No compile-time guarantee request matches response.

Effect design (as written) keeps this pattern. Handlers return `Effect<void | Record<string, unknown>, E, R>` but results still broadcast as events.

### What to add

Split operations into three categories:

**Queries** (read, direct return):
- `sessions.list`, `sessions.search`, `sessions.history`
- `models.list`, `agents.list`, `system.commands`, `system.todo`
- `files.list`, `files.content`, `files.tree`, `files.directories`
- `terminal.list`, `projects.list`, `instances.list`
- `tools.content`, `system.proxyDetect`, `system.scan`

**Mutations** (write, direct return):
- `sessions.create`, `sessions.switch`, `sessions.delete`, `sessions.rename`, `sessions.fork`, `sessions.view`
- `chat.send`, `chat.cancel`, `chat.rewind`, `chat.inputSync`
- `permissions.respond`, `permissions.answerQuestion`, `permissions.rejectQuestion`
- `models.switch`, `models.setDefault`, `models.switchVariant`
- `agents.switch`
- `terminal.create`, `terminal.input`, `terminal.resize`, `terminal.close`, `terminal.command`
- `projects.add`, `projects.remove`, `projects.rename`
- `instances.add`, `instances.remove`, `instances.start`, `instances.stop`, `instances.update`, `instances.rename`, `instances.setProject`
- `system.reload`

**Subscriptions** (server-pushed, ongoing):
- Only unsolicited server-initiated events — LLM streaming, status changes, permission requests, file changes, PTY output, input sync, client count, banners, notifications.

### Effect implementation via `@effect/rpc`

`@effect/rpc` provides typed RPC with Schema-validated request/response pairs, WebSocket transport, and streaming — no tRPC needed.

```typescript
// Define RPC endpoint
const ListSessions = Rpc.make("ListSessions", {
  payload: Schema.Struct({ filter: Schema.optional(Schema.String) }),
  success: Schema.Array(SessionInfoSchema),
  error: Schema.Union(SessionNotFoundError, PersistenceError),
});

// Group RPCs
const SessionRpcs = RpcGroup.make(
  ListSessions, CreateSession, SwitchSession, DeleteSession, /* ... */
).prefix("sessions");

// Implement handlers as Layer
const SessionHandlersLive = SessionRpcs.toLayer(
  Effect.gen(function* () {
    const sessions = yield* SessionManager;
    return {
      ListSessions: (req) => sessions.list(req.filter),
      CreateSession: (req) => sessions.create(req),
      // ...
    };
  })
);

// Client — fully typed, each RPC becomes a method
const client = yield* RpcClient.make(SessionRpcs);
const sessions = yield* client.ListSessions({ filter: "active" });
//    ^? SessionInfo[]  — fully inferred
```

### What this replaces

15+ current fire-and-forget events become direct return values:

| Current event | Becomes |
|---|---|
| `session_list` | `sessions.list()` return |
| `model_list` | `models.list()` return |
| `agent_list` | `agents.list()` return |
| `command_list` | `system.commands()` return |
| `file_list`, `file_content`, `file_tree` | `files.*` query returns |
| `directory_list` | `files.directories()` return |
| `pty_list` | `terminal.list()` return |
| `project_list` | `projects.list()` return |
| `todo_state` | `system.todo()` return |
| `session_switched` | `sessions.switch()` return |
| `session_forked` | `sessions.fork()` return |
| `history_page` | `sessions.history()` return |
| `rewind_result` | `chat.rewind()` return |
| `instance_list` | `instances.list()` return |
| `model_info`, `default_model_info`, `variant_info` | Respective mutation returns |

---

## 2. Three-Tier Subscription Design

### Problem

Effect design keeps flat `RelayMessage` union on one pipe. Every client gets every event. No scoping.

### What to add

Three subscription scopes, each as a separate `Stream`:

**Tier 1: Session events** — scoped by `sessionId`
- Streaming: `delta`, `thinking_start`, `thinking_delta`, `thinking_stop`
- Tools: `tool_start`, `tool_executing`, `tool_result`, `tool_content`
- Turn lifecycle: `result`, `done`, `status`, `error`, `user_message`
- Permissions: `permission_request`, `permission_resolved`, `ask_user`, `ask_user_resolved`, `ask_user_error`
- Edits: `part_removed`, `message_removed`
- Session: `session_deleted`, `provider_session_reloaded`

**Tier 2: Global events** — system-wide, low frequency
- Sync: `input_sync`, `client_count`
- Files: `file_changed`
- Instances: `instance_status`, `instance_update`
- Notifications: `notification_event`, `banner`, `update_available`
- System: `connection_status`, `skip_permissions`, `proxy_detected`, `scan_result`
- PTY lifecycle: `pty_created` (discovery — must know PTY exists before subscribing)
- Invalidation signals: `sessions_changed`, `todo_updated` (client re-queries via RPC)

**Tier 3: Terminal events** — scoped by `ptyId`
- `pty_output`, `pty_exited`, `pty_deleted`

### Effect implementation

```typescript
// Per-scope PubSub
const SessionEventBus = Context.Tag("SessionEventBus")<
  SessionEventBus, PubSub.PubSub<SessionEvent>
>();

const GlobalEventBus = Context.Tag("GlobalEventBus")<
  GlobalEventBus, PubSub.PubSub<GlobalEvent>
>();

const TerminalEventBus = Context.Tag("TerminalEventBus")<
  TerminalEventBus, PubSub.PubSub<TerminalEvent>
>();

// Session subscription — client subscribes with sessionId filter
const sessionSubscription = (sessionId: string) =>
  Effect.gen(function* () {
    const bus = yield* SessionEventBus;
    const sub = yield* PubSub.subscribe(bus);
    return Stream.fromQueue(sub).pipe(
      Stream.filter((e) => e.sessionId === sessionId),
    );
  });
```

### Session switch flow

```
1. Unsubscribe from old session stream (fiber interrupted via Scope)
2. const result = yield* sessions.switch({ sessionId })
   → returns session data + replay events directly
3. Apply replay events to stores
4. Subscribe to new session stream
5. Live events flow — no gap because lastEventId resumes from replay
```

---

## 3. Pull-From-Store Backpressure

### Problem

Effect design uses `PubSub.unbounded()` everywhere. If client stalls (phone on 3G, tab backgrounded), events accumulate in memory. 10 stalled sessions = unbounded memory growth. This is same OOM risk the tRPC doc identifies in t3code.

### What to add

Event store (SQLite) IS the bounded buffer. Subscription generators pull from store, not from in-memory PubSub.

### Pattern

```
For each subscription:
  1. Start at cursor = lastEventId ?? 0
  2. Query event store: readBySession(id, cursor, limit=50)
  3. If no results → await notification signal for that scope
  4. If results → for each event:
       a. Check ws.bufferedAmount < HIGH_WATER_MARK (256KB)
       b. If over → await drain on underlying socket
       c. Yield event with sequence number
       d. Advance cursor
  5. Goto 2
```

### Effect implementation

```typescript
const pullFromStore = (
  scope: SubscriptionScope,
  startFrom: number,
) =>
  Stream.unfoldEffect(startFrom, (cursor) =>
    Effect.gen(function* () {
      const store = yield* EventStore;
      const notify = yield* NotificationChannel;
      const batch = yield* store.read(scope, cursor, 50);
      if (batch.length === 0) {
        yield* notify.await(scope); // park until new events
        return Option.some([[] as const, cursor] as const);
      }
      const lastSeq = batch[batch.length - 1].sequence;
      return Option.some([batch, lastSeq] as const);
    })
  ).pipe(
    Stream.flatMap((batch) => Stream.fromIterable(batch)),
  );
```

### Why this beats PubSub.unbounded

- Events durable in SQLite before consumer sees them
- Client stalls → generator pauses at drain check, stops pulling
- Zero memory growth — events in SQLite, not Node heap
- Reconnect → resume from `lastEventId`, replay missed events
- 10 stalled sessions = 10 paused generators, ~0 bytes server memory
- SQLite read: <1ms per batch with WAL + indexed `(session_id, sequence)`

### Notification channel

Lightweight signal (Effect `Deferred` or `PubSub`) that emits scope keys when new events persisted. Two modes:

**Standard:** Data-free notification. Generator wakes, pulls from store. Single code path for replay and live.

**Hot path:** Notification carries event data directly, skipping SQLite read. For latency-critical ephemeral events: `input_sync`, `client_count`, `connection_status`. Generator yields carried event immediately — avoids ~1ms store round-trip for typing preview.

---

## 4. PTY Output Persistence

### Problem

Current PTY output stored in 50KB in-memory scrollback buffer (`ptyManager.appendScrollback()`). Lost on server restart. No replay on reconnect. Not unified with event store pattern.

### What to add

PTY output goes to event store. Same subscription pattern as session and global events.

### New event types

```
pty.output   — terminal data chunk
pty.exited   — terminal process ended
pty.deleted  — terminal removed
pty.created  — terminal started (goes to global subscription)
```

### Write path

PTY manager receives output → writes to event store via `append()` → emits notification on PTY scope → terminal subscription generator wakes and pulls.

### Scrollback replacement

`ptyManager.appendScrollback()` (50KB buffer) replaced by event store. Scrollback query: `readBySession(ptyId, 0, limit=1000)`. No separate buffer.

### Cleanup

```sql
DELETE FROM events WHERE type LIKE 'pty.%' AND created_at < ?
```

24h retention. Terminal output from closed PTYs expendable. Open question: per-PTY cap vs time-based.

### Schema impact

PTY events use existing `events` table. `session_id` field carries `pty_id` for terminal events. No `stream_version` needed — terminal output is append-only, no conflicts.

---

## 5. Client-Side Data Integrity Patterns

### Problem

Effect design focuses on server architecture. Says nothing about client-side data integrity — deduplication, idempotency, batching, reactivity efficiency. These are transport-agnostic; apply regardless of Effect or tRPC.

### Pattern 1: Sequence-based deduplication

Event store assigns monotonic `sequence` to every event. Client tracks `lastAppliedSeq` per subscription scope. On reconnect, `lastEventId` sent — server replays from cursor, client skips `seq <= lastAppliedSeq` in overlap window.

```typescript
// Client-side wrapper for all subscription consumers
const makeDeduplicatedConsumer = () => {
  let lastAppliedSeq = 0;
  return (event: SubscriptionEvent) => {
    if (event.sequence <= lastAppliedSeq) return; // skip duplicate
    lastAppliedSeq = event.sequence;
    dispatch(event);
  };
};
```

### Pattern 2: Idempotent event handlers

Every handler checks before mutating. Applying same event twice = no-op.

- `delta` — find message by ID, find text part by index, only append if content extends existing
- `tool_start` — check if tool entry already exists before creating
- `status` — primitive assignment (Svelte 5 `safe_equals` handles this automatically)
- `permission_request` — check if request with same `requestId` already exists

Already partially implemented: `seenMessageIds` (`SvelteSet<string>`) in `SessionActivity`. Extend discipline to all handlers.

### Pattern 3: Mutation over replacement for Svelte 5

Svelte 5 proxy-based `$state` gives fine-grained reactivity on mutations but full invalidation on reference replacement.

Rules:
- `messages.push(newMsg)` not `messages = [...messages, newMsg]`
- `session.title = newTitle` not `sessions.set(id, { ...session, title: newTitle })`
- `SvelteMap.set(key, value)` for keyed collections
- Arrays of primitives: replacement OK (Svelte checks element-wise)

### Pattern 4: RAF batching for high-frequency events

Buffer events, flush per animation frame:

```
onData:
  1. Push event to buffer (plain array, non-reactive)
  2. If no RAF scheduled → requestAnimationFrame(flush)

flush:
  3. Dispatch each buffered event synchronously
  4. Svelte batches all synchronous state changes into one DOM update
  5. Clear buffer
```

Which subscriptions need it:
- Session events — yes, delta/thinking at 20-50/sec
- Terminal events — yes, build output at 100+ lines/sec
- Global events — no, low frequency

Already implemented as `liveEventBuffer` + `replayBatch` with `REPLAY_CHUNK_SIZE = 80` and `yieldToEventLoop()`. Migration wires same pattern to new subscription consumer instead of raw WS `onmessage`.

### Pattern 5: Server-side dedup for snapshot events (optional)

For snapshot-style events pushed through subscriptions (`instance_status`, `sessions_changed`), server checks whether state actually changed before persisting.

Low priority. Optimization, not correctness. Implement after core migration stable.

---

## 6. Invalidation Signals

### Problem

Current architecture pushes full snapshots when state changes. Session list changes → push entire `session_list` with all sessions. Wastes bandwidth, forces client to diff.

### What to add

Replace full snapshot pushes with lightweight invalidation signals through global subscription. Client decides whether to refetch.

```typescript
// Server: persist lightweight signal
yield* eventStore.append({
  type: "sessions_changed",
  scope: "global",
  // no payload — just "something changed"
});

// Client: re-query on invalidation
globalSubscription.onData((event) => {
  if (event.type === "sessions_changed") {
    // Client decides: refetch if session list visible, ignore if not
    if (sessionListVisible) {
      const sessions = await rpc.sessions.list();
      sessionStore.set(sessions);
    }
  }
});
```

### Invalidation-eligible events

| Current full push | Becomes signal |
|---|---|
| `session_list` (broadcast on create/delete) | `sessions_changed` |
| `todo_state` (broadcast on update) | `todo_updated` |
| `instance_list` (broadcast on status change) | `instance_updated` |

### Why signals beat snapshots

- Bandwidth: signal is ~20 bytes vs full session list (could be KB)
- Client autonomy: only refetch if data is visible/needed
- Composability: multiple rapid changes → one refetch (natural coalescing)

---

## 7. Event Coalescing

### Problem

Some event types fire rapidly but only latest value matters. `instance_status` changing 10 times in 200ms during startup — intermediate values discarded by client anyway.

### What to add

Batch-level coalescing in pull-from-store generator:

```
When pulling events from store:
  1. Read batch
  2. For coalesce-eligible types: if multiple events of same type in batch,
     keep only last one (latest sequence wins)
  3. Yield remaining events
```

### Effect implementation

```typescript
const coalesce = (batch: ReadonlyArray<StoreEvent>) => {
  const lastByType = new Map<string, StoreEvent>();
  const result: StoreEvent[] = [];
  for (const event of batch) {
    if (COALESCE_TYPES.has(event.type)) {
      lastByType.set(event.type, event);
    } else {
      result.push(event);
    }
  }
  // Append coalesced events at their original sequence position
  for (const event of lastByType.values()) {
    result.push(event);
  }
  return result.sort((a, b) => a.sequence - b.sequence);
};

const COALESCE_TYPES = new Set([
  "instance_status",
  "sessions_changed",
  "todo_updated",
  "scan_result",
]);
```

Batch-level, not time-based. Simpler than `Stream.debounce(200ms)`. If client keeps up, no coalescing. If client falls behind, rapid-fire events collapse to latest.

---

## 8. Deleted Code Accounting

### What to add to Effect design

Explicit accounting of what gets deleted. Effect design lists some files but doesn't quantify total reduction.

Effect migration should delete ~1,300 lines of protocol/transport code (same as tRPC design):

| File | Lines | Reason |
|---|---|---|
| `handlers/index.ts` MESSAGE_HANDLERS table | ~150 | Effect dispatch replaces |
| `handlers/payloads.ts` PayloadMap interface | ~79 | Schema input types replace |
| `server/ws-router.ts` parse/route/validate | ~110 | Schema + Effect routing replaces |
| `server/ws-handler.ts` heartbeat, bootstrap | ~300 | Effect-managed WS replaces |
| `frontend/stores/ws.svelte.ts` connection lifecycle | ~250 | Effect transport replaces |
| `frontend/stores/ws-send.svelte.ts` send queue | ~100 | Schema-encoded sends replace |
| `frontend/stores/ws-dispatch.ts` dispatch boilerplate | ~130 | Subscription consumers replace |
| `shared-types.ts` RelayMessage union (partial) | ~200 | Schema event types replace |

Plus Effect-specific deletions already listed in Effect design:
- `async-tracker.ts`, `tracked-service.ts`, `service-registry.ts`, `retry-fetch.ts`, `prompt-queue.ts`, `handler-deps-wiring.ts`

---

## Summary: What Effect Design Gets from This

| Addition | Effect primitive | Section |
|---|---|---|
| Request-response separation | `@effect/rpc` RpcGroup + Rpc.make | 1 |
| Three-tier subscriptions | Streaming RPCs + Stream per tier | 2 |
| Pull-from-store backpressure | Stream.unfoldEffect + EventStore | 3 |
| PTY persistence | Event store append + terminal scope | 4 |
| Client data integrity (5 patterns) | Transport-agnostic, apply to any frontend | 5 |
| Invalidation signals | Lightweight events, client re-queries | 6 |
| Event coalescing | Batch-level filter in generator | 7 |
| Deletion accounting | Explicit line-count reduction | 8 |
| `@effect/rpc` as transport | Replaces tRPC — typed RPC, WS, streaming, heartbeat | 9 |

All 8 additions use Effect-native patterns. No tRPC dependency needed. Effect design keeps its DI/lifecycle/concurrency/error wins AND gains protocol-layer architecture it was missing.

---

## 9. `@effect/rpc` as Transport Layer (replaces tRPC entirely)

### Context

Initial analysis assumed Effect lacked mature WS transport + typed RPC, making tRPC appear necessary for client type inference, reconnection, and WS lifecycle. Research into `@effect/rpc` (v0.75.1, 75+ releases) shows this assumption was wrong.

### What `@effect/rpc` provides

| Capability | Detail |
|---|---|
| Typed RPC endpoints | `Rpc.make(tag, { payload, success, error, stream? })` with Schema |
| Router definition | `RpcGroup.make(...rpcs)` with `.prefix()`, `.middleware()`, `.merge()` |
| Handler implementation | `group.toLayer(handlers)` — handlers as Layer, composable with DI |
| Typed client | `RpcClient.make(group)` — each RPC becomes a method, full type inference |
| Server WS transport | `layerProtocolWebsocket` / `layerProtocolWebsocketRouter` — drops into HttpRouter |
| Client WS transport | `layerProtocolSocket` with `retryTransientErrors` + configurable `retrySchedule` (exponential backoff) |
| Heartbeat/keepalive | Built-in ping/pong with timeout detection (tRPC does *not* have this) |
| First-class streaming | `stream: true` on Rpc definition — returns `Stream<Chunk, Error>` or `Mailbox` |
| Serialization | JSON, NDJSON, JSON-RPC, MessagePack (tRPC: JSON only) |
| Middleware | Typed, composable, both server and client side, with error schemas and context injection |
| Multiple transports | HTTP, WebSocket, Socket, Worker, Stdio (tRPC: HTTP + WS only) |
| Error typing | Per-RPC error schemas, middleware error composition (tRPC: single `TRPCError` type) |

### Streaming subscriptions via `@effect/rpc`

Three-tier subscriptions (Section 2) map directly to streaming RPCs:

```typescript
// Define streaming RPC for session events
const SessionEvents = Rpc.make("SessionEvents", {
  payload: Schema.Struct({
    sessionId: Schema.String,
    lastEventId: Schema.optional(Schema.Number),
  }),
  success: SessionEventSchema,  // discriminated union of 24 event types
  error: Schema.Union(SessionNotFoundError),
  stream: true,
});

// Handler returns a Stream
const SessionEventsHandler = (req) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    return pullFromStore({ type: "session", id: req.sessionId }, req.lastEventId ?? 0);
  });

// Client consumption — typed Stream
const client = yield* RpcClient.make(EventRpcs);
const events = client.SessionEvents({ sessionId, lastEventId });
// ^? Stream<SessionEvent, SessionNotFoundError>
```

### Two gaps vs tRPC and how to close them

**Gap 1: Message buffering during disconnect**

tRPC's `wsLink` queues outbound messages while disconnected and flushes on reconnect. Effect's Socket layer fails writes when connection closed.

Solution: `Queue.bounded` in front of socket writer. ~20 lines:

```typescript
const bufferedSend = Effect.gen(function* () {
  const outbox = yield* Queue.bounded<OutboundMessage>(100);
  const socket = yield* Socket;
  const connected = yield* Ref.make(false);

  // Writer fiber: drains queue when socket open
  yield* Queue.take(outbox).pipe(
    Effect.flatMap((msg) =>
      Ref.get(connected).pipe(
        Effect.flatMap((up) =>
          up
            ? socket.send(msg)
            : Effect.unit // stays in queue, Queue.take will re-park
        )
      )
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  return {
    send: (msg: OutboundMessage) => Queue.offer(outbox, msg),
    setConnected: (up: boolean) => Ref.set(connected, up),
  };
});
```

**Gap 2: Automatic subscription re-establishment after reconnect**

tRPC re-subscribes active subscriptions after reconnect. Effect does not.

Non-issue for this architecture: pull-from-store pattern (Section 3) handles this. Client reconnects → resubscribes with `lastEventId` → server resumes from cursor → no gap. The cursor-based design makes re-establishment trivial — just call the streaming RPC again with the last seen sequence number.

### Why `@effect/rpc` over tRPC

| Concern | tRPC | `@effect/rpc` |
|---|---|---|
| Paradigm fit | Second paradigm — every procedure needs `runPromise` bridge to Effect | Native — handlers are `Effect<A, E, R>`, compose with DI/errors/lifecycle |
| Error typing | Single `TRPCError` with string codes | Per-RPC typed error schemas in error channel |
| Streaming | Subscriptions (generator-based, separate concept) | First-class `stream: true`, same type system |
| Middleware | Procedure-level, untyped error propagation | Typed errors, composable, server + client |
| Serialization | JSON only | JSON, NDJSON, JSON-RPC, MessagePack |
| Heartbeat | Not built-in | Built-in ping/pong + timeout detection |
| Bundle | Separate client/server packages | Part of `effect` ecosystem, already in dependency tree |
| DI integration | Context bag (flat object) | Layer/Context/Tag — same DI as rest of codebase |

Adding tRPC to a full-Effect codebase creates paradigm mismatch at every seam. `@effect/rpc` eliminates this — one type system, one error model, one DI mechanism, one lifecycle model, end to end.
