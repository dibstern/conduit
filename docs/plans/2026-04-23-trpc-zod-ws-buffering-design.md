# tRPC + Zod Migration Design

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

## Tech Stack Additions

```
New dependencies:
  @trpc/server    — server router, procedures, WS adapter
  @trpc/client    — client links, wsLink, createWSClient
  zod             — input/output validation schemas

Removed after migration:
  (nothing removed — ws package stays, tRPC uses it)
```

Current stack unchanged: SvelteKit 5.53, Svelte 5.53, Node ≥22.5, ws 8.18, TypeScript 5.8.

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
    ├── .session()           subscription → SessionEventSchema (discriminated union, 24 types)
    ├── .global()            subscription → GlobalEventSchema (discriminated union, 20+ types)
    └── .terminal()          subscription → TerminalEventSchema (pty_output | pty_exited | pty_deleted)
```

**Counts:** 13 queries, 28 mutations, 3 subscriptions. Replaces 45-entry MESSAGE_HANDLERS dispatch table + 44-type RelayMessage event stream.

### What moves from subscriptions to query/mutation returns

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

**What remains as subscription events:** Only unsolicited server-initiated events — LLM streaming, status changes, permission requests, file changes, PTY output, input sync, client count, banners, notifications.

## Three-Tier Subscription Design

### Tier 1: `events.session({ sessionId, lastEventId? })`

**Input:** `z.object({ sessionId: z.string(), lastEventId: z.number().optional() })`

**Yields discriminated union of 24 per-session event types:**
- Streaming: `delta`, `thinking_start`, `thinking_delta`, `thinking_stop`
- Tools: `tool_start`, `tool_executing`, `tool_result`, `tool_content`
- Turn lifecycle: `result`, `done`, `status`, `error`, `user_message`
- Permissions: `permission_request`, `permission_resolved`, `ask_user`, `ask_user_resolved`, `ask_user_error`
- Edits: `part_removed`, `message_removed`
- Session: `session_deleted`, `provider_session_reloaded`

**Lifecycle:**
- Client subscribes when viewing a session
- Session switch = unsubscribe old → subscribe new (with replay from `lastEventId`)
- Server generator pulls from event store by `session_id` cursor
- Multiple clients viewing same session = multiple independent generators pulling from same store

### Tier 2: `events.global({ lastEventId? })`

**Input:** `z.object({ lastEventId: z.number().optional() })`

**Yields discriminated union of global event types:**
- Sync: `input_sync`, `client_count`
- Files: `file_changed`
- Instances: `instance_status`, `instance_update`
- Notifications: `notification_event`, `banner`, `update_available`
- System: `connection_status`, `skip_permissions`, `proxy_detected`, `scan_result`
- PTY lifecycle: `pty_created` (discovery — client needs to know PTY exists before subscribing)
- Session changes: `sessions_changed` (invalidation signal — client re-queries `sessions.list()`)
- Todo: `todo_updated` (invalidation signal — client re-queries `system.todo()`)

**Note on invalidation signals:** Some events that were previously full snapshots (`session_list`, `todo_state`) become lightweight invalidation signals. The global subscription yields `{ type: "sessions_changed" }`, and the client decides whether to refetch via `sessions.list()`. This is cleaner than pushing full lists through the subscription.

### Tier 3: `events.terminal({ ptyId, lastEventId? })`

**Input:** `z.object({ ptyId: z.string(), lastEventId: z.number().optional() })`

**Yields:** `pty_output | pty_exited | pty_deleted`

**Lifecycle:**
- Client subscribes when opening a terminal tab
- Multiple terminals = multiple subscriptions
- Unsubscribe on tab close — server cleans up via `AbortSignal`
- `pty_output` is high-frequency during builds but now durable in event store

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

**Why this works:**
- Events are durable in SQLite before generator sees them
- If client stalls: generator pauses at drain check, stops pulling from store
- Zero memory growth — events accumulate in SQLite, not Node.js heap
- On reconnect: generator starts from `lastEventId`, replays missed events
- 10 LLM sessions × stalled phone = 10 paused generators, ~0 bytes server memory
- SQLite read overhead: <1ms per batch with WAL mode + indexed `(session_id, sequence)`

**Notification channel:** Lightweight EventEmitter that emits scope keys (session ID, "global", PTY ID) when new events are persisted. Carries no data — just "wake up, new events exist." Generator wakes up, pulls from store.

**HIGH_WATER_MARK:** Constant 256KB per WebSocket connection. `ws.bufferedAmount` is inherently per-client — a phone on 3G hits the threshold quickly while a LAN laptop never does. The threshold doesn't need to adapt; the signal already does.

## PTY Output Persistence

### New event types for event store

Add to `CANONICAL_EVENT_TYPES`:
```
"pty.output"    — terminal data chunk
"pty.exited"    — terminal process ended
"pty.deleted"   — terminal removed
"pty.created"   — terminal started (goes to global subscription)
```

### Schema impact

PTY events use existing `events` table. `session_id` field repurposed as `pty_id` for terminal events (or add a `scope` column to distinguish). PTY events don't need `stream_version` optimistic concurrency — terminal output is append-only with no conflicts.

### Write path

PTY manager receives output from upstream → writes to event store via `append()` → emits notification on PTY scope → terminal subscription generator wakes up and pulls.

### Scrollback replacement

Current `ptyManager.appendScrollback()` (50KB in-memory buffer) is replaced by the event store. Scrollback query: `readBySession(ptyId, 0, limit=1000)`. No separate buffer needed.

### Cleanup

Old PTY events should be pruned periodically. Terminal output from closed PTYs is expendable. A cleanup job can `DELETE FROM events WHERE type LIKE 'pty.%' AND created_at < ?` (e.g., 24h retention).

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

**Current `shared-types.ts` interfaces become Zod schemas.** The `PayloadMap` interface in `handlers/payloads.ts` is replaced by per-procedure Zod input schemas. The `RelayMessage` discriminated union is replaced by per-subscription Zod output schemas.

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
- `delta` → find message by ID in `SvelteMap`, find text part by index, only append if content extends existing. If message doesn't exist yet, `seenMessageIds.has(id)` guards creation.
- `tool_start` → check if tool entry already exists in message's parts before creating.
- `status` → primitive assignment. Svelte 5's `safe_equals` handles this — assigning same primitive value is automatically a no-op.
- `permission_request` → check if request with same `requestId` already exists in `permissionsState`.

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
- `events.global` — no, low frequency (input_sync debounced, client_count rare)

### Pattern 5: Server-side deduplication for snapshot events (optional)

Most subscription events are deltas — inherently non-redundant. For the few snapshot-style events pushed through subscriptions (e.g., `instance_status`, `sessions_changed` invalidation), server checks whether state actually changed before persisting to event store.

**Implementation:** Before emitting `sessions_changed`, compare a lightweight hash/version of current session list against last emitted version per client scope. Skip emit if unchanged.

**Priority:** Low. This is an optimization, not a correctness requirement. Implement after core migration is stable.

## Server Migration Architecture

### tRPC server setup

```
src/lib/server/
├── trpc/
│   ├── context.ts          — createContext (wsHandler, eventStore, sessionMgr, ...)
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

```typescript
// Current HandlerDeps fields → tRPC context
wsHandler       → ctx.wsHandler (broadcast, sendTo — still needed for multi-client push)
sessionMgr      → ctx.sessionMgr
ptyManager      → ctx.ptyManager
config          → ctx.config
orchestrationEngine → ctx.orchestration
eventStore      → ctx.eventStore
readQuery       → ctx.readQuery
```

Handlers keep their existing logic — the tRPC router calls them, replacing `dispatchMessage`.

### WS adapter integration

`applyWSSHandler` from `@trpc/server/adapters/ws` attaches to the existing `ws.Server`. The current WS upgrade path in `ws-handler.ts` routes to tRPC instead of `parseIncomingMessage → routeMessage → dispatchMessage`.

Auth stays cookie-based on WS upgrade — same as current. `connectionParams` carries auth token from the upgrade request for tRPC context creation.

## Frontend Migration Architecture

### tRPC client setup

```
src/lib/frontend/
├── trpc/
│   ├── client.ts           — createWSClient, wsLink, createTRPCClient
│   ├── types.ts            — AppRouter type import
│   └── subscriptions.ts    — subscription wrappers with dedup + RAF batching
├── stores/
│   ├── ws-dispatch.ts      → REPLACED by subscription handlers in subscriptions.ts
│   ├── ws.svelte.ts        → REPLACED by trpc/client.ts (createWSClient handles connection)
│   ├── ws-send.svelte.ts   → REPLACED by trpc mutations (rate limiting preserved)
│   └── (all other stores remain — chat, session, discovery, etc.)
```

### Client connection lifecycle

```
Current:
  new WebSocket(url) → onopen → send JSON → onmessage → dispatch

tRPC:
  createWSClient({ url }) → wsLink → createTRPCClient → trpc.events.session.subscribe()
```

`createWSClient` handles reconnection with configurable `retryDelayMs`. Replaces manual exponential backoff in `ws.svelte.ts`. Reconnection sends `lastEventId` via `tracked()` — server replays missed events from store cursor.

### Subscription consumption

```
Current flow:
  ws.onmessage → parseJSON → handleMessage → routePerSession/global → store updates

tRPC flow:
  trpc.events.session.subscribe({ sessionId, lastEventId }, {
    onData(event) {
      // Dedup: skip if event.sequence <= lastAppliedSeq
      // Buffer for RAF batch
      // Dispatch to existing per-session store handlers
    }
  })

  trpc.events.global.subscribe({ lastEventId }, {
    onData(event) {
      // Dedup + dispatch to existing global store handlers
    }
  })

  trpc.events.terminal.subscribe({ ptyId, lastEventId }, {
    onData(event) {
      // Dedup + RAF batch + dispatch to terminal store
    }
  })
```

Existing store handler logic in `ws-dispatch.ts` (`routePerSession`, `handleMessage`) is preserved — just called from subscription `onData` instead of raw WS dispatch.

### Session switch flow (updated)

```
Current:
  1. Send {type: "switch_session"} over WS
  2. Eventually receive "session_switched" event with replay data

tRPC:
  1. Unsubscribe from old session subscription
  2. const result = await trpc.sessions.switch.mutate({ sessionId })
     → returns session data + replay events directly (synchronous RPC return)
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
| `server/ws-router.ts` parseIncomingMessage, routeMessage, VALID_MESSAGE_TYPES | ~110 | tRPC handles parsing + routing |
| `server/ws-handler.ts` heartbeat, bootstrap queue, message handlers | ~300 | applyWSSHandler replaces |
| `frontend/stores/ws.svelte.ts` connection lifecycle | ~250 | createWSClient replaces |
| `frontend/stores/ws-send.svelte.ts` send queue | ~100 | tRPC mutations replace |
| `frontend/stores/ws-dispatch.ts` raw dispatch boilerplate | ~130 | Subscription onData replaces |
| `shared-types.ts` RelayMessage union (partially) | ~200 | Zod event schemas replace |
| **Total deleted** | **~1,300** | |

**What survives:** Handler business logic (each handler function), store update logic (per-event-type handlers in dispatch), SvelteMap/SvelteSet stores, replay batching patterns, rate limiting window.
