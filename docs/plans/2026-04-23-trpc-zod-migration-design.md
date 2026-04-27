# tRPC + Zod Migration Design

**Date:** 2026-04-23
**Status:** Draft

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| RPC framework | tRPC v11 | Typed end-to-end, Standard Schema, WS support |
| Validation | Zod | Native tRPC ecosystem fit, larger tooling ecosystem |
| Transport | Full WebSocket (wsLink) | input_sync latency, single connection, existing WS infrastructure |
| Subscription tier | Three-tier (session + global + terminal) | Matches frontend two-tier dispatch + per-PTY scoping |
| Backpressure | Pull-from-store via SQLite cursors | Event store IS the bounded buffer, zero memory growth during stalls |
| PTY persistence | Persist PTY output in event store | Single pattern for all subscriptions, enables mobile reconnect replay |
| Outbound events | tRPC subscriptions replace raw RelayMessage stream | Full type safety, tracked() resume, unified protocol |

## Problem

Conduit's client-server communication has three gaps:

1. **No runtime validation at trust boundary.** `PayloadMap` in `handlers/payloads.ts` defines payload shapes as TypeScript interfaces only. Raw JSON is cast with `as PayloadMap[keyof PayloadMap]` at dispatch — no runtime checking. Malformed payloads pass silently.

2. **Hand-maintained dispatch boilerplate.** `MESSAGE_HANDLERS` in `handlers/index.ts` is a 45-entry record mapping string keys to handler functions with `as MessageHandler` casts. Adding a handler requires updating the type union in `ws-router.ts`, the payload interface in `payloads.ts`, the dispatch table in `index.ts`, and the handler implementation. Four files for one endpoint.

3. **No typed client calls.** The frontend sends `{type: "get_models"}` as a raw JSON string and receives `{type: "model_list", ...}` as an unrelated async event. Request-response pairs are correlated by convention, not by type system. No compile-time guarantee that a command sends the right payload or that the response matches.

The orchestrator migration (completed April 2026) created the preconditions for fixing these: durable event store with monotonic sequences, CQRS projections, command receipts. tRPC fills the typed RPC layer the orchestrator was designed to sit behind.

## Tech Stack

### New dependencies

```
@trpc/server    — server router, procedures, WS adapter
@trpc/client    — client links, wsLink, createWSClient
zod             — input/output validation schemas
```

### Unchanged

SvelteKit 5.53, Svelte 5.53 (runes), Node >= 22.5, ws 8.18, TypeScript 5.8, SQLite (node:sqlite WAL mode).

## tRPC Router Structure

```
appRouter
├── sessions
│   ├── .list()              query  → z.array(SessionInfoSchema)
│   ├── .search()            query  → z.array(SessionInfoSchema)
│   ├── .history()           query  → HistoryPageSchema
│   ├── .create()            mutation → CreateSessionResultSchema
│   ├── .switch()            mutation → SwitchSessionResultSchema
│   ├── .view()              mutation → ViewSessionResultSchema
│   ├── .delete()            mutation → DeleteSessionResultSchema
│   ├── .rename()            mutation → RenameSessionResultSchema
│   └── .fork()              mutation → ForkSessionResultSchema
│
├── chat
│   ├── .send()              mutation → SendResultSchema
│   ├── .cancel()            mutation → CancelResultSchema
│   ├── .rewind()            mutation → RewindResultSchema
│   └── .inputSync()         mutation → z.void()
│
├── permissions
│   ├── .respond()           mutation → PermissionResultSchema
│   ├── .answerQuestion()    mutation → AnswerResultSchema
│   └── .rejectQuestion()    mutation → RejectResultSchema
│
├── models
│   ├── .list()              query  → z.array(ProviderInfoSchema)
│   ├── .switch()            mutation → SwitchModelResultSchema
│   ├── .setDefault()        mutation → SetDefaultResultSchema
│   └── .switchVariant()     mutation → SwitchVariantResultSchema
│
├── agents
│   ├── .list()              query  → AgentListResultSchema
│   └── .switch()            mutation → z.void()
│
├── files
│   ├── .list()              query  → z.array(FileEntrySchema)
│   ├── .content()           query  → FileContentSchema
│   ├── .tree()              query  → z.array(TreeEntrySchema)
│   └── .directories()       query  → z.array(DirectoryEntrySchema)
│
├── terminal
│   ├── .list()              query  → z.array(PtyInfoSchema)
│   ├── .create()            mutation → CreatePtyResultSchema
│   ├── .input()             mutation → z.void()
│   ├── .resize()            mutation → z.void()
│   ├── .close()             mutation → ClosePtyResultSchema
│   └── .command()           mutation → CommandResultSchema
│
├── projects
│   ├── .list()              query  → z.array(ProjectInfoSchema)
│   ├── .add()               mutation → AddProjectResultSchema
│   ├── .remove()            mutation → RemoveProjectResultSchema
│   └── .rename()            mutation → RenameProjectResultSchema
│
├── instances
│   ├── .list()              query  → z.array(InstanceInfoSchema)
│   ├── .add()               mutation → AddInstanceResultSchema
│   ├── .remove()            mutation → RemoveInstanceResultSchema
│   ├── .start()             mutation → StartInstanceResultSchema
│   ├── .stop()              mutation → StopInstanceResultSchema
│   ├── .update()            mutation → UpdateInstanceResultSchema
│   ├── .rename()            mutation → RenameInstanceResultSchema
│   └── .setProject()        mutation → SetProjectResultSchema
│
├── tools
│   └── .content()           query  → ToolContentSchema
│
├── system
│   ├── .commands()          query  → z.array(CommandInfoSchema)
│   ├── .todo()              query  → z.array(TodoItemSchema)
│   ├── .proxyDetect()       query  → ProxyResultSchema
│   ├── .scan()              query  → ScanResultSchema
│   └── .reload()            mutation → ReloadResultSchema
│
└── events
    ├── .session()           subscription → SessionEventSchema
    ├── .global()            subscription → GlobalEventSchema
    └── .terminal()          subscription → TerminalEventSchema
```

**Counts:** 13 queries, 28 mutations, 3 subscriptions. Replaces 45-entry MESSAGE_HANDLERS dispatch table + 44-type RelayMessage event stream.

## What Moves From Subscriptions to Query/Mutation Returns

These event types currently sent as async WS events become direct return values:

| Current event | Becomes | Why |
|--------------|---------|-----|
| `session_list` | `sessions.list()` return | Response to explicit request |
| `model_list` | `models.list()` return | Response to explicit request |
| `agent_list` | `agents.list()` return | Response to explicit request |
| `command_list` | `system.commands()` return | Response to explicit request |
| `file_list`, `file_content`, `file_tree` | `files.*` query returns | Response to explicit request |
| `directory_list` | `files.directories()` return | Response to explicit request |
| `pty_list` | `terminal.list()` return | Response to explicit request |
| `project_list` | `projects.list()` return | Response to explicit request |
| `todo_state` | `system.todo()` return | Response to explicit request |
| `session_switched` | `sessions.switch()` return | Response to explicit command |
| `session_forked` | `sessions.fork()` return | Response to explicit command |
| `history_page` | `sessions.history()` return | Response to explicit query |
| `rewind_result` | `chat.rewind()` return | Response to explicit command |
| `instance_list` | `instances.list()` return | Response to explicit request |
| `model_info`, `default_model_info`, `variant_info` | Respective mutation returns | Response to explicit command |

What remains as subscription events: only unsolicited server-initiated events — LLM streaming, status changes, permission requests, file changes, PTY output, input sync, client count, banners, notifications.

## Three-Tier Subscription Design

### Tier 1: `events.session({ sessionId, lastEventId? })`

**Input:** `z.object({ sessionId: z.string(), lastEventId: z.number().optional() })`

Yields discriminated union of 24 per-session event types:

- **Streaming:** `delta`, `thinking_start`, `thinking_delta`, `thinking_stop`
- **Tools:** `tool_start`, `tool_executing`, `tool_result`, `tool_content`
- **Turn lifecycle:** `result`, `done`, `status`, `error`, `user_message`
- **Permissions:** `permission_request`, `permission_resolved`, `ask_user`, `ask_user_resolved`, `ask_user_error`
- **Edits:** `part_removed`, `message_removed`
- **Session:** `session_deleted`, `provider_session_reloaded`

**Lifecycle:**

- Client subscribes when viewing a session
- Session switch = unsubscribe old, subscribe new (with replay from `lastEventId`)
- Server generator pulls from event store by `session_id` cursor
- Multiple clients viewing same session = multiple independent generators pulling from same store

### Tier 2: `events.global({ lastEventId? })`

**Input:** `z.object({ lastEventId: z.number().optional() })`

Yields discriminated union of global event types:

- **Sync:** `input_sync`, `client_count`
- **Files:** `file_changed`
- **Instances:** `instance_status`, `instance_update`
- **Notifications:** `notification_event`, `banner`, `update_available`
- **System:** `connection_status`, `skip_permissions`, `proxy_detected`, `scan_result`
- **PTY lifecycle:** `pty_created` (discovery — client needs to know PTY exists before subscribing)
- **Invalidation signals:** `sessions_changed`, `todo_updated` (client re-queries via RPC)

Invalidation signals replace full snapshot pushes. Global subscription yields `{ type: "sessions_changed" }`, client decides whether to refetch via `sessions.list()`.

### Tier 3: `events.terminal({ ptyId, lastEventId? })`

**Input:** `z.object({ ptyId: z.string(), lastEventId: z.number().optional() })`

**Yields:** `pty_output | pty_exited | pty_deleted`

**Lifecycle:**

- Client subscribes when opening a terminal tab
- Multiple terminals = multiple subscriptions
- Unsubscribe on tab close — server cleans up via `AbortSignal`
- `pty_created` stays in global (client must know PTY exists before subscribing)

## Pull-Based Backpressure via Event Store

All three subscription tiers use the same pattern. The event store IS the bounded buffer.

### Server-side subscription generator pattern

```
For each subscription:
  1. Start at cursor = lastEventId ?? 0
  2. Query event store: readBySession(id, cursor, limit=50)
     (or readGlobal / readByPty for other tiers)
  3. If no results → await notification signal for that scope
  4. If results → for each event:
       a. Check ws.bufferedAmount < HIGH_WATER_MARK (256KB)
       b. If over → await 'drain' on underlying socket
       c. yield tracked(event.sequence, event)
       d. Advance cursor
  5. Goto 2
```

### Why this works

- Events are durable in SQLite before generator sees them
- If client stalls: generator pauses at drain check, stops pulling from store
- Zero memory growth — events accumulate in SQLite, not Node.js heap
- On reconnect: generator starts from `lastEventId`, replays missed events
- 10 LLM sessions x stalled phone = 10 paused generators, ~0 bytes server memory
- SQLite read overhead: <1ms per batch with WAL mode + indexed `(session_id, sequence)`

### Notification channel

Lightweight EventEmitter that emits scope keys (session ID, "global", PTY ID) when new events are persisted. Two modes:

**Standard (most events):** Data-free notification — just "wake up, new events exist." Generator wakes up, pulls from store. Single code path for replay and live.

**Hot path (input_sync):** Notification carries the event data directly, skipping the SQLite read. `input_sync` is latency-critical (real-time typing preview between devices) and ephemeral (not worth persisting). The generator yields the carried event immediately without a store round-trip. This hybrid avoids adding ~1ms latency to the one event type where users perceive delay.

Events eligible for hot-path: `input_sync`, `client_count`, `connection_status` — ephemeral, low-frequency, latency-sensitive. All other events use standard pull-from-store.

### Generator-level debounce for coalescing events

Some event types fire rapidly but only the latest value matters (e.g., `instance_status` changing 10 times in 200ms during instance startup). The pull-from-store generator applies debounce per event type:

```
When pulling events from store:
  1. Read batch of events
  2. For debounce-eligible types: if multiple events of same type in batch,
     keep only the last one (latest sequence wins)
  3. Yield remaining events normally
```

Debounce-eligible types: `instance_status`, `sessions_changed`, `todo_updated`, `scan_result`. These are all state-snapshot events where intermediate values are discarded by the client anyway.

This is batch-level coalescing, not time-based debounce — simpler than Effect's `Stream.debounce(200ms)` but achieves the same effect when the generator is pulling in batches. If a client is keeping up (reading every event promptly), no coalescing occurs. If a client falls behind, rapid-fire events of the same type collapse to the latest.

### HIGH_WATER_MARK

Constant 256KB per WebSocket connection. `ws.bufferedAmount` is inherently per-client — a phone on 3G hits the threshold quickly while a LAN laptop never does. The threshold does not need to adapt; the signal already does.

## PTY Output Persistence

### New event types for event store

Add to canonical event types:

```
"pty.output"    — terminal data chunk
"pty.exited"    — terminal process ended
"pty.deleted"   — terminal removed
"pty.created"   — terminal started (goes to global subscription)
```

### Schema impact

PTY events use existing `events` table. `session_id` field carries `pty_id` for terminal events. PTY events do not need `stream_version` optimistic concurrency — terminal output is append-only with no conflicts.

### Write path

PTY manager receives output from upstream → writes to event store via `append()` → emits notification on PTY scope → terminal subscription generator wakes up and pulls.

### Scrollback replacement

Current `ptyManager.appendScrollback()` (50KB in-memory buffer) replaced by the event store. Scrollback query: `readBySession(ptyId, 0, limit=1000)`. No separate buffer needed.

### Cleanup

Old PTY events pruned periodically. Terminal output from closed PTYs is expendable. Cleanup job: `DELETE FROM events WHERE type LIKE 'pty.%' AND created_at < ?` (e.g., 24h retention).

## Zod Schema Organization

### File structure

```
src/lib/schemas/
├── common.ts          — branded types (RequestId, PermissionId), shared primitives
├── sessions.ts        — session input/output schemas
├── chat.ts            — message, delta, tool schemas
├── models.ts          — provider, model schemas
├── agents.ts          — agent schemas
├── files.ts           — file entry, content schemas
├── terminal.ts        — PTY schemas
├── projects.ts        — project schemas
├── instances.ts       — instance schemas
├── permissions.ts     — permission/question schemas
├── system.ts          — command, todo, scan schemas
└── events/
    ├── session.ts     — SessionEventSchema (discriminated union)
    ├── global.ts      — GlobalEventSchema (discriminated union)
    └── terminal.ts    — TerminalEventSchema (discriminated union)
```

### Schema derivation

Zod schemas become the single source of truth. TypeScript types are inferred:

```typescript
// Schema defines shape + validation
export const SessionInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['idle', 'busy', 'error']),
  provider: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Type inferred from schema — no separate interface
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
```

Current `shared-types.ts` interfaces become Zod schemas. The `PayloadMap` interface in `handlers/payloads.ts` is replaced by per-procedure Zod input schemas. The `RelayMessage` discriminated union is replaced by per-subscription Zod output schemas.

### Branded types

```typescript
export const RequestIdSchema = z.string().brand<'RequestId'>();
export const PermissionIdSchema = z.string().brand<'PermissionId'>();
```

## Five Data Integrity Patterns

### Pattern 1: Sequence-based deduplication

`tracked()` assigns event store `sequence` as the event ID. Client tracks `lastAppliedSeq` per subscription scope. On reconnection, `lastEventId` is sent — server replays from cursor, client skips any events with `seq <= lastAppliedSeq` that arrive in the overlap window.

**Implementation:** Client-side `useSubscription` wrapper tracks `lastAppliedSeq`. Before dispatching an event, checks `event.sequence > lastAppliedSeq`. Updates `lastAppliedSeq` after dispatch.

**Where:** Wrapper around all three subscription consumers. Single implementation, applied uniformly.

### Pattern 2: Idempotent event handlers

Every event handler checks before mutating. Applying the same event twice is a no-op.

**Examples:**

- `delta` — find message by ID in `SvelteMap`, find text part by index, only append if content extends existing. If message doesn't exist yet, `seenMessageIds.has(id)` guards creation.
- `tool_start` — check if tool entry already exists in message's parts before creating.
- `status` — primitive assignment. Svelte 5's `safe_equals` handles this — assigning same primitive value is automatically a no-op.
- `permission_request` — check if request with same `requestId` already exists in `permissionsState`.

**Already partially implemented:** `seenMessageIds` (`SvelteSet<string>`) in `SessionActivity` already guards message deduplication. Extend this discipline to all handlers.

### Pattern 3: Mutation over replacement for store updates

Svelte 5's proxy-based `$state` provides fine-grained reactivity on mutations but triggers full invalidation on reference replacement.

**Rules:**

- `messages.push(newMsg)` not `messages = [...messages, newMsg]`
- `session.title = newTitle` not `sessions.set(id, { ...session, title: newTitle })`
- Use `SvelteMap.set(key, value)` for keyed collections (already used for `sessionActivity`, `sessionMessages`, `sessionState.sessions`)
- Arrays of primitives: replacement is fine (Svelte checks element-wise for primitives)

**Already partially implemented:** Codebase already uses `SvelteMap`/`SvelteSet` for primary collections. Audit during migration to ensure no array replacements in hot paths.

### Pattern 4: RAF batching for high-frequency events

Subscription `onData` buffers events and flushes per animation frame.

**Pattern:**

```
onData callback:
  1. Push event to buffer array (plain, non-reactive)
  2. If no RAF scheduled → requestAnimationFrame(flush)

flush:
  3. For each buffered event, dispatch to handler synchronously
  4. Svelte batches all synchronous state changes into one DOM update
  5. Clear buffer
```

**Already implemented:** `liveEventBuffer` and `replayBatch` with `REPLAY_CHUNK_SIZE = 80` and `yieldToEventLoop()`. The tRPC migration wires this same pattern to `useSubscription` `onData` instead of raw WS `onmessage`.

**Which subscriptions need it:**

- `events.session` — yes, delta/thinking events at 20-50/sec
- `events.terminal` — yes, build output at 100+ lines/sec
- `events.global` — no, low frequency

### Pattern 5: Server-side deduplication for snapshot events (optional)

Most subscription events are deltas — inherently non-redundant. For the few snapshot-style events pushed through subscriptions (e.g., `instance_status`, `sessions_changed` invalidation), server checks whether state actually changed before persisting to event store.

**Priority:** Low. Optimization, not correctness requirement. Implement after core migration is stable.

## Server Migration Architecture

### tRPC server file structure

```
src/lib/server/
├── trpc/
│   ├── context.ts          — createContext (maps to current HandlerDeps)
│   ├── router.ts           — appRouter (merges all sub-routers)
│   ├── procedures.ts       — base procedures with middleware
│   └── routers/
│       ├── sessions.ts     — sessions sub-router
│       ├── chat.ts         — chat sub-router
│       ├── permissions.ts  — permissions sub-router
│       ├── models.ts       — models sub-router
│       ├── agents.ts       — agents sub-router
│       ├── files.ts        — files sub-router
│       ├── terminal.ts     — terminal sub-router
│       ├── projects.ts     — projects sub-router
│       ├── instances.ts    — instances sub-router
│       ├── tools.ts        — tools sub-router
│       ├── system.ts       — system sub-router
│       └── events.ts       — three subscription procedures
├── subscription-manager.ts — pull-based generator factory + notification emitter
└── ws-adapter.ts           — applyWSSHandler integration with existing HTTP server
```

### Context (replaces HandlerDeps)

tRPC context maps to existing `HandlerDeps`:

| HandlerDeps field | tRPC context field | Purpose |
|---|---|---|
| wsHandler | ctx.wsHandler | broadcast, sendTo (still needed for multi-client push) |
| sessionMgr | ctx.sessionMgr | Session lifecycle |
| ptyManager | ctx.ptyManager | PTY management |
| config | ctx.config | Project relay config |
| orchestrationEngine | ctx.orchestration | Provider routing |
| eventStore | ctx.eventStore | Event persistence |
| readQuery | ctx.readQuery | SQLite read queries |

Handlers keep their existing logic — the tRPC router calls them, replacing `dispatchMessage`.

### WS adapter integration

`applyWSSHandler` from `@trpc/server/adapters/ws` attaches to the existing `ws.Server`. The current WS upgrade path in `ws-handler.ts` routes to tRPC instead of `parseIncomingMessage → routeMessage → dispatchMessage`.

Auth stays cookie-based on WS upgrade — same as current. `connectionParams` carries auth token from the upgrade request for tRPC context creation.

## Frontend Migration Architecture

### tRPC client file structure

```
src/lib/frontend/
├── trpc/
│   ├── client.ts           — createWSClient, wsLink, createTRPCClient
│   ├── types.ts            — AppRouter type import
│   └── subscriptions.ts    — subscription wrappers with dedup + RAF batching
├── stores/
│   ├── ws-dispatch.ts      → REPLACED by subscription handlers
│   ├── ws.svelte.ts        → REPLACED by trpc/client.ts
│   ├── ws-send.svelte.ts   → REPLACED by trpc mutations
│   └── (all other stores remain — chat, session, discovery, etc.)
```

### Client connection lifecycle

```
Current:
  new WebSocket(url) → onopen → send JSON → onmessage → dispatch

tRPC:
  createWSClient({ url }) → wsLink → createTRPCClient → subscribe()
```

`createWSClient` handles reconnection with configurable `retryDelayMs`. Replaces manual exponential backoff in `ws.svelte.ts`. Reconnection sends `lastEventId` via `tracked()` — server replays missed events from store cursor.

### Subscription consumption

```
Current flow:
  ws.onmessage → parseJSON → handleMessage → routePerSession/global → store updates

tRPC flow:
  trpc.events.session.subscribe({ sessionId, lastEventId }, {
    onData(event) {
      // Pattern 1: skip if event.sequence <= lastAppliedSeq
      // Pattern 4: buffer for RAF batch
      // Dispatch to existing per-session store handlers
    }
  })

  trpc.events.global.subscribe({ lastEventId }, {
    onData(event) {
      // Pattern 1: dedup
      // Dispatch to existing global store handlers
    }
  })

  trpc.events.terminal.subscribe({ ptyId, lastEventId }, {
    onData(event) {
      // Pattern 1: dedup
      // Pattern 4: RAF batch
      // Dispatch to terminal store
    }
  })
```

Existing store handler logic in `ws-dispatch.ts` (`routePerSession`, `handleMessage`) is preserved — called from subscription `onData` instead of raw WS dispatch.

### Session switch flow (updated)

```
Current:
  1. Send {type: "switch_session"} over WS
  2. Eventually receive "session_switched" event with replay data

tRPC:
  1. Unsubscribe from old session subscription
  2. const result = await trpc.sessions.switch.mutate({ sessionId })
     → returns session data + replay events directly
  3. Apply replay events to stores (same replayEvents logic)
  4. Subscribe to new session: trpc.events.session.subscribe({ sessionId })
  5. Live events flow immediately — no gap because tracked(lastEventId)
     resumes from where replay left off
```

## What Gets Deleted

| File | Lines | Reason |
|------|-------|--------|
| `handlers/index.ts` MESSAGE_HANDLERS table | ~150 | Replaced by tRPC router dispatch |
| `handlers/payloads.ts` PayloadMap interface | ~79 | Replaced by Zod input schemas |
| `server/ws-router.ts` parse/route/validate | ~110 | tRPC handles parsing + routing |
| `server/ws-handler.ts` heartbeat, bootstrap, handlers | ~300 | applyWSSHandler replaces |
| `frontend/stores/ws.svelte.ts` connection lifecycle | ~250 | createWSClient replaces |
| `frontend/stores/ws-send.svelte.ts` send queue | ~100 | tRPC mutations replace |
| `frontend/stores/ws-dispatch.ts` dispatch boilerplate | ~130 | Subscription onData replaces |
| `shared-types.ts` RelayMessage union (partially) | ~200 | Zod event schemas replace |
| **Total** | **~1,300** | |

What survives: handler business logic, store update logic (per-event-type handlers), SvelteMap/SvelteSet stores, replay batching patterns, rate limiting window.

## t3code Comparison Notes

t3code (pingdotgg/t3code) uses Effect.ts RPC over WebSocket with a different streaming architecture worth understanding.

### Their architecture

```
LLM event → SQLite append (transaction) → PubSub.publish() → Stream.fromPubSub() → client
                                           (in-memory, unbounded)    ↓
                                                          filter/map/merge/debounce
                                                          (Effect stream operators)
```

Live subscriptions read from in-memory PubSub, NOT from SQLite. SQLite is only read for bootstrap/replay (snapshot-then-live-tail via `Stream.concat`).

### What Effect gives them (not backpressure)

All their queues are `PubSub.unbounded()` — no backpressure strategies used. Effect's value is:

1. **Stream composition:** `Stream.filter(byThreadId)`, `Stream.merge(a, b, c)`, `Stream.debounce(200ms)`, `Stream.mapEffect(enrichFromProjection)`, `Stream.concat(snapshot, live)` — one-line operators that compose declaratively.
2. **Scoped fiber lifecycle:** `Effect.forkScoped` ties background workers to scope lifetimes. WS disconnect → subscription scope closes → fiber interrupted automatically.
3. **PubSub fan-out:** Each consumer gets independent stream from same bus without manual EventEmitter management.
4. **Transactional command processing:** `TxQueue` + `TxRef` for deterministic sequential processing.

### How our design covers the same concerns differently

| Concern | t3code (Effect) | Our design (pull-from-store) |
|---------|-----------------|------------------------------|
| Filtering | `Stream.filter` in memory | SQL `WHERE session_id = ?` — more efficient, no wasted reads |
| Snapshot + live | `Stream.concat` stitching two paths | Single cursor from `lastEventId=0` — one code path |
| Debounce | `Stream.debounce(200ms)` — time-based | Batch-level coalescing in generator — simpler, same practical effect |
| Fan-out | PubSub per consumer | Multiple generators pulling from same store |
| Lifecycle | Scoped fibers | AbortSignal + try/finally |
| Memory during stalls | Unbounded PubSub — same OOM risk | Zero growth — events in SQLite |
| Replay consistency | Two paths (SQLite + PubSub), must handle seam | One path — seam-free |

### Decision

Not adopting Effect. The pull-from-store design handles the same concerns through different mechanisms, with better memory safety and simpler replay. Effect's stream operators are ergonomic but adopting Effect *just* for stream composition in an otherwise async/await codebase would be architectural mismatch. The two adjustments (hot-path notification for latency-critical events, batch-level coalescing for debounce) cover the gaps.

## Open Questions

- PTY event retention policy: 24h? Per-PTY cap? Pruning strategy for high-volume terminal output?
- Migration phasing: big-bang or incremental (dual protocol during transition)?
- Hot-path event list: are `input_sync`, `client_count`, `connection_status` the right set, or should other ephemeral events skip the store?
