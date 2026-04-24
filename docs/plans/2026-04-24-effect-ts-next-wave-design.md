# Effect.ts Next Wave: Resolved Design

> Concrete design decisions for completing the Effect.ts migration across all remaining modules.
> Companion to [design brief](./2026-04-24-effect-ts-next-wave-design-brief.md) which poses the questions this document resolves.

---

## Design Principles

1. **No partial Effect boundaries** — each module fully converts in its PR. No mixed Promise+Effect within a module.
2. **No callbacks** — services read each other via `Context.Tag`. No callback bags, no EventEmitter, no PubSub.
3. **No classes** — services dissolve into Layers + Refs. Layer IS the service.
4. **No setInterval/setTimeout** — `Effect.Schedule` for recurring work, `Effect.timeout` for deadlines.
5. **No AbortController** — fiber interruption handles cancellation.
6. **No try/catch** — Effect error channel for typed errors, `Schema.TaggedError` for error definitions.
7. **No manual resource cleanup** — `Effect.acquireRelease` and Layer finalizers.

---

## Part 1: Daemon Dissolution

### 1.1 DaemonState — single Ref for mutable runtime state

The Daemon class (41 fields, 586-line `start()`) dissolves entirely. No class remains.

Init-once service refs (httpServer, router, pushManager, etc.) exist only as `Context.Tag` dependencies from their respective Layers. Only truly mutable runtime state lives in a Ref:

```typescript
interface DaemonState {
  // Runtime config (mutated via IPC)
  pinHash: string | null
  keepAwake: boolean
  keepAwakeCommand: string | undefined
  keepAwakeArgs: string[] | undefined
  clientCount: number
  shuttingDown: boolean

  // Persisted collections (rehydrated from disk, mutated at runtime)
  dismissedPaths: Set<string>
  persistedSessionCounts: Map<string, number>

  // Config persistence coalescing
  pendingSave: Promise<void> | null
  needsResave: boolean
}
```

Provided as `DaemonStateTag` via `Ref.make(initialState)` in a Layer. All reads/writes go through `Ref.get`/`Ref.update` — concurrency-safe.

### 1.2 Startup program — top-level Effect.gen

Replaces `start()`. Runs after Layer construction. Three phases:

**Phase 1: Layer build (`makeDaemonLive`)**
All services constructed, finalizers registered. Servers started (IPC, HTTP, onboarding). Background services running (KeepAwake, VersionChecker, StorageMonitor, PortScanner).

**Phase 2: Sequential startup effects**

Each step is a standalone Effect function reading dependencies from Context. Error policy per step:

| Step | Error policy |
|------|-------------|
| `crashCounter.record()` | Fatal — propagate |
| `loadConfig` → DaemonState ref | Degraded — `Effect.orElseSucceed(() => DaemonState.empty)` |
| `rehydrateInstances()` | Degraded — log warning, skip |
| `probeAndConvert()` | Degraded — log warning, skip |
| `detectSmartDefault()` | Degraded — log warning, skip |
| `autoStartManagedDefault()` | Degraded — log warning, skip |
| `loadTlsCerts` → `TlsConfigTag` | Fatal — propagate |
| `createRouter` → `RouterTag` | Fatal — propagate (depends on TLS, auth) |
| `wireCallbacks()` | Fatal — propagate (depends on services existing) |

**Phase 3: Forked background effects**

```typescript
yield* Effect.forkScoped(discoverProjects.pipe(
  Effect.catchAllCause(Effect.logWarning)))
yield* Effect.forkScoped(prefetchSessionCounts.pipe(
  Effect.catchAllCause(Effect.logWarning)))
yield* Effect.forkScoped(initPushNotifications.pipe(
  Effect.catchAllCause(Effect.logWarning)))
```

`forkScoped` — fibers bound to daemon scope, auto-interrupted on shutdown. `catchAllCause` — captures defects too, not just typed errors.

### 1.3 Layer composition — expanded makeDaemonLive

Current `makeDaemonLive` stays, gains new Layers:

| New Layer | Provides | Finalizer |
|-----------|----------|-----------|
| `DaemonStateLive` | `DaemonStateTag` (Ref) | Persist config to disk |
| `TlsConfigLive` | `TlsConfigTag` | None |
| `RouterLive` | `RouterTag` | None |
| `RelayCacheLive` | `RelayCacheTag` (ScopedCache) | Invalidate all entries |
| `EventLoopDetectorLive` | — | Clear interval |
| `IpcHandlerLive` | `IpcHandlerTag` | None |

Composed via `Layer.provide` chains (not `mergeAll`) to enforce ordering: TLS before Router before HTTP.

### 1.4 IPC handlers — Schema-driven Effect functions

**Command definitions → Schema.TaggedRequest:**

```typescript
const AddProjectRequest = Schema.TaggedRequest<AddProjectRequest>()(
  "AddProject",
  {
    failure: Schema.Union(InvalidDirectoryError, ProjectExistsError),
    success: Schema.Struct({ slug: Schema.String, path: Schema.String }),
    payload: { directory: Schema.String }
  }
)

const IpcCommand = Schema.Union(
  AddProjectRequest, RemoveProjectRequest, ListProjectsRequest,
  SetPinRequest, /* ... all 18 */
)
```

**Handler pattern:**

```typescript
const handleAddProject = Effect.gen(function*() {
  const cmd = yield* AddProjectRequest
  const registry = yield* ProjectRegistryTag
  const state = yield* DaemonStateTag
  const project = yield* registry.addProject(cmd.directory)
  yield* persistConfig(state)
  return { ok: true, slug: project.slug }
})
```

**Dispatch → Schema.decode + pattern match:**

```typescript
const dispatch = (raw: string) => Effect.gen(function*() {
  const command = yield* Schema.decode(IpcCommand)(JSON.parse(raw))
  switch (command._tag) {
    case "AddProject": return yield* handleAddProject(command)
    case "RemoveProject": return yield* handleRemoveProject(command)
    // ...
  }
})
```

Validation errors → `Schema.ParseError` in error channel. No manual validation functions.

**JSON-lines framing → Stream:**

```typescript
const ipcConnectionStream = (socket: Socket) =>
  Stream.fromReadable(socket).pipe(
    Stream.splitLines,
    Stream.mapEffect(dispatch),
    Stream.tap(response =>
      Effect.sync(() => socket.write(JSON.stringify(response) + "\n"))),
    Stream.catchAllCause(Effect.logWarning)
  )
```

---

## Part 2: Relay System — ScopedCache + Context Wiring

### 2.1 ScopedCache replaces ProjectRegistry state machine

Current ProjectRegistry manages `Map<slug, ProjectEntry>` with three states (registering/ready/error), AbortControllers, and manual cleanup. Replaced by one construct:

```typescript
const RelayCacheTag = Context.Tag<ScopedCache<string, Relay>>()

const RelayCacheLive = Layer.scoped(RelayCacheTag,
  ScopedCache.make({
    lookup: (slug: string) => createRelay(slug),
    capacity: 200,
    timeToLive: Duration.infinity
  })
)
```

**Behavior mapping:**

| Current pattern | ScopedCache equivalent |
|----------------|----------------------|
| `ensureRelayStarted(slug)` | `cache.get(slug)` — creates on miss, deduplicates concurrent calls |
| `waitForRelay(slug, 10_000)` | `cache.get(slug).pipe(Effect.timeout(Duration.seconds(10)))` |
| `registry.remove(slug)` | `cache.invalidate(slug)` — triggers scope finalization |
| `registry.stopAll()` in shutdown | Cache scope finalization — all entries cleaned up |
| AbortController per relay | Fiber interruption on invalidation |
| registering/ready/error states | Handled internally by ScopedCache |

### 2.2 Relay creation reads from Context

No callback bag. Relay creation Effect reads services directly:

```typescript
const createRelay = (slug: string) => Effect.gen(function*() {
  const instanceManager = yield* InstanceManagerTag
  const registry = yield* ProjectRegistryTag
  const sessionManager = yield* SessionManagerTag
  const state = yield* DaemonStateTag
  const config = yield* TlsConfigTag

  // ... build relay with direct service access

  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      // relay cleanup: stop SSE, pollers, WS handler
    })
  )

  return relay
})
```

Each relay runs in its own scope (provided by ScopedCache). Finalizer handles cleanup.

### 2.3 WebSocket upgrade handler

```typescript
const handleUpgrade = Effect.gen(function*() {
  const cache = yield* RelayCacheTag
  const router = yield* RouterTag

  return (req: IncomingMessage, socket: Socket, head: Buffer) =>
    Effect.gen(function*() {
      const slug = extractSlug(req.url)
      yield* router.authenticate(req)
      const relay = yield* cache.get(slug).pipe(
        Effect.timeout(Duration.seconds(10)),
        Effect.catchTag("TimeoutException", () =>
          Effect.fail(new RelayCreationTimeout({ slug })))
      )
      relay.wsHandler.handleUpgrade(req, socket, head)
    })
})
```

### 2.4 ProjectRegistry narrows in scope

No longer manages relay lifecycle (ScopedCache does that). Becomes thin metadata store:

- Project CRUD (add/remove/update)
- Project-to-instance binding
- Broadcast project list changes via `yield* WsHandlerTag`

May dissolve into `Ref<Map<slug, ProjectMetadata>>` + a few Effect functions if no meaningful logic remains beyond Map operations.

---

## Part 3: Tier 1 Modules — High Impact

### 3.1 SessionManager — last EventEmitter dissolved

SessionManager (646 lines) has 3 events, 5 Maps, 11 public methods. Dissolves into Layer + Ref.

**Event elimination:**

| Event | Current | Replacement |
|-------|---------|-------------|
| `broadcast` | EventEmitter, fire-and-forget | Direct call: `yield* WsHandlerTag` → `.broadcast(msg)` |
| `send` | Declared but never emitted | Delete (dead code) |
| `session_lifecycle` | EventEmitter, sequential async | Direct call: `yield* SessionLifecycleTag` → `.onCreated(id)` / `.onDeleted(id)` |

No EventEmitter import remains in codebase after this.

**State → Ref:**

```typescript
interface SessionManagerState {
  cachedParentMap: Map<string, string>
  lastMessageAt: Map<string, number>
  forkMeta: Map<string, ForkEntry>
  pendingQuestionCounts: Map<string, number>
  paginationCursors: Map<string, string>
}
```

Single `Ref<SessionManagerState>` — atomic updates across maps when operations touch multiple (e.g., deleteSession clears from all maps).

**API calls → Effect with typed retry:**

```typescript
const listSessions = (options?) => Effect.gen(function*() {
  const sdk = yield* OpenCodeAPITag
  const state = yield* SessionManagerStateTag
  const response = yield* sdk.listSessions(options).pipe(
    Effect.retry(Schedule.exponential("500 millis").pipe(
      Schedule.compose(Schedule.recurs(3))))
  )
  yield* Ref.update(state, s => ({
    ...s, cachedParentMap: buildParentMap(response)
  }))
  return response
})
```

Pagination cursor 400 errors handled via `Effect.catchTag("StaleCursorError", () => resetAndRetry)`.

**Dissolves into:**
- `SessionManagerStateLive` — Layer providing `Ref<SessionManagerState>`
- `SessionManagerLive` — Layer providing `SessionManagerTag` (methods as Effect functions)
- `SessionLifecycleTag` — interface for lifecycle callbacks (implemented by relay wiring)

### 3.2 SSEStream — Schedule + Stream

SSEStream (183 lines) already migrated from EventEmitter to callbacks. Manual backoff, AbortController, health tracking remain.

**Backoff → Schedule:**

```typescript
const reconnectSchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.compose(Schedule.elapsed.pipe(
    Schedule.whileOutput(Duration.lessThanOrEqualTo(Duration.minutes(5)))))
)
```

**SSE events → Stream:**

```typescript
const sseStream = (url: string) => Stream.async<SSEEvent, SSEError>((emit) => {
  const source = new EventSource(url)
  source.onmessage = (e) => emit.single(parseSSEEvent(e))
  source.onerror = (e) => emit.fail(new SSEConnectionError({ cause: e }))
  return Effect.sync(() => source.close())
})
```

**Stale detection + reconnection as full pipeline:**

```typescript
const resilientSSE = (url: string) =>
  sseStream(url).pipe(
    Stream.retry(reconnectSchedule),
    Stream.timeoutFail(new SSEStaleError(), Duration.seconds(90))
  )
```

No AbortController — fiber interruption handles cancellation. Class dissolves. SSE becomes a function returning `Stream<SSEEvent, SSEError>`.

### 3.3 SessionStatusPoller — Schedule + Stream + Ref

SessionStatusPoller (552 lines): 7s reconciliation loop, SQLite vs REST comparison, corrective event injection.

**Interval → Schedule:**

```typescript
const pollerSchedule = Schedule.spaced(Duration.seconds(7))

const reconciliationLoop = Effect.gen(function*() {
  yield* reconcile.pipe(
    Effect.repeat(pollerSchedule),
    Effect.catchAllCause(Effect.logWarning)
  )
})
```

**State → Ref:**

```typescript
interface PollerState {
  previousStatuses: Map<string, SessionStatus>
  activityTimestamps: Map<string, number>
  childToParentCache: Map<string, string>
  idleSessionTracking: Map<string, number>
}
```

**Reconciliation tick:**

```typescript
const reconcile = Effect.gen(function*() {
  const db = yield* PersistenceTag
  const api = yield* OpenCodeAPITag
  const state = yield* PollerStateTag

  const dbSessions = yield* db.getSessionStatuses()
  const apiSessions = yield* api.getSessionStatuses().pipe(
    Effect.retry(Schedule.once))

  const corrections = diffStatuses(yield* Ref.get(state), dbSessions, apiSessions)

  yield* Effect.forEach(corrections, applyCorrection, { concurrency: "unbounded" })
  yield* Ref.update(state, applyStateUpdates(corrections))
})
```

**Message activity TTL — pure function:**

```typescript
const isMessageActive = (state: PollerState, sessionId: string, ttl: Duration) =>
  pipe(
    Map.get(state.activityTimestamps, sessionId),
    Option.map(ts => Date.now() - ts < Duration.toMillis(ttl)),
    Option.getOrElse(() => false)
  )
```

Dissolves into `PollerStateLive` (Ref) + `SessionStatusPollerLive` (Layer running loop as scoped fiber).

---

## Part 4: Tier 2 Modules — Medium Impact

### 4.1 MessagePoller + Manager — Schedule + Fiber Map

MessagePoller (707 lines): REST polling fallback, per-session, setInterval with idle timeout.

**Per-session poller → scoped fiber:**

```typescript
const pollSession = (sessionId: string) =>
  Effect.gen(function*() {
    const sdk = yield* OpenCodeAPITag

    const poll = sdk.getMessages(sessionId).pipe(
      Effect.flatMap(messages => processNewMessages(sessionId, messages)),
      Effect.catchAllCause(Effect.logWarning)
    )

    yield* poll.pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(3))),
      Effect.timeout(Duration.minutes(5)),
      Effect.interruptible
    )
  })
```

No setInterval. No clearInterval. Fiber interruption handles both idle timeout and explicit stop.

**Manager → Ref<Map<sessionId, Fiber>>:**

```typescript
const startPoller = (sessionId: string) => Effect.gen(function*() {
  const state = yield* PollerManagerStateTag
  const current = yield* Ref.get(state)
  if (current.activePollers.has(sessionId)) return
  const fiber = yield* Effect.forkScoped(pollSession(sessionId))
  yield* Ref.update(state, s => ({
    activePollers: new Map([...s.activePollers, [sessionId, fiber]])
  }))
})

const stopPoller = (sessionId: string) => Effect.gen(function*() {
  const state = yield* PollerManagerStateTag
  const current = yield* Ref.get(state)
  const fiber = current.activePollers.get(sessionId)
  if (fiber) {
    yield* Fiber.interrupt(fiber)
    yield* Ref.update(state, s => {
      const next = new Map(s.activePollers)
      next.delete(sessionId)
      return { activePollers: next }
    })
  }
})
```

Manager class dissolves. Two functions + a Ref.

### 4.2 InstanceManager — per-instance fibers

InstanceManager (606 lines): health polling per instance, restart rate-limiting, process spawning.

**Health polling → per-instance fiber:**

```typescript
const healthPollFiber = (instanceId: string) =>
  Effect.gen(function*() {
    const state = yield* InstanceManagerStateTag
    yield* checkHealth(instanceId).pipe(
      Effect.tap(healthy => Ref.update(state, updateHealthStatus(instanceId, healthy))),
      Effect.catchAllCause(Effect.logWarning),
      Effect.repeat(Schedule.spaced(Duration.seconds(5)))
    )
  })
```

Stored in `Ref<Map<instanceId, Fiber>>`. Instance removal → `Fiber.interrupt` → polling stops.

**Restart rate-limiting → Schedule:**

```typescript
const restartSchedule = Schedule.fixed(Duration.seconds(2)).pipe(
  Schedule.compose(Schedule.recurs(5)),
  Schedule.compose(Schedule.elapsed.pipe(
    Schedule.whileOutput(Duration.lessThanOrEqualTo(Duration.minutes(2)))))
)

const restartWithLimit = (instanceId: string) =>
  spawnInstance(instanceId).pipe(Effect.retry(restartSchedule))
```

**Process spawning → acquireRelease:**

```typescript
const spawnInstance = (instanceId: string) => Effect.gen(function*() {
  const config = yield* Ref.get(yield* InstanceManagerStateTag)
  const instance = config.instances.get(instanceId)

  const process = yield* Effect.acquireRelease(
    Effect.sync(() => spawn(instance.command, instance.args, { env: instance.env })),
    (proc) => Effect.sync(() => { proc.kill("SIGTERM") })
  )

  yield* Effect.forkScoped(healthPollFiber(instanceId))
  return process
})
```

Process kill guaranteed by `acquireRelease`. No orphaned child processes.

### 4.3 Leaf services — class dissolves, Layer IS the service

StorageMonitor, VersionChecker, PortScanner, KeepAwake: already have Layer factories wrapping imperative classes. Convert internals so class disappears.

**Pattern (same for all four):**

```typescript
// Layer IS the logic, no class
const StorageMonitorLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const persistence = yield* PersistenceTag
    const state = yield* Ref.make({ lastCheck: 0, usage: 0 })

    const check = Effect.gen(function*() {
      const usage = yield* getStorageUsage
      yield* Ref.set(state, { lastCheck: Date.now(), usage })
      if (usage > HIGH_WATER_MARK) {
        yield* persistence.evictOldEvents()
      }
    })

    yield* check.pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(5))),
      Effect.catchAllCause(Effect.logWarning),
      Effect.forkScoped
    )
  })
)
```

**Per-service specifics:**

| Service | Interval | Key detail |
|---------|----------|------------|
| StorageMonitor | 5 min | Eviction via `yield* PersistenceTag` directly |
| VersionChecker | 1 hour | Broadcast via `yield* WsHandlerTag` directly |
| PortScanner | 30s | Discovery via `yield* InstanceManagerTag`. Conditional Layer (only when smartDefault enabled) |
| KeepAwake | On-demand | Process spawn via `acquireRelease`. Reconstruct on config change via Ref |

No classes. No setInterval. No manual cleanup.

---

## Part 5: Tier 3 Modules — Lower Priority

### 5.1 Persistence Layer — Effect-managed transactions

**Database connections → acquireRelease:**

```typescript
const withConnection = <A, E>(
  body: (conn: Connection) => Effect.Effect<A, E>
) => Effect.acquireUseRelease(
  pool.acquire(),
  body,
  (conn) => pool.release(conn)
)
```

**Transactions → scoped Effect with auto-rollback:**

```typescript
const withTransaction = <A, E>(
  body: (tx: Transaction) => Effect.Effect<A, E>
) => withConnection((conn) =>
  Effect.acquireUseRelease(
    conn.beginTransaction(),
    body,
    (tx) => Effect.suspend(() =>
      tx.committed ? Effect.void : tx.rollback())
  )
)
```

**Projection replay → Stream:**

```typescript
const replayProjections = Stream.fromIterable(projections).pipe(
  Stream.mapEffect((projection) =>
    withTransaction((tx) => projection.rebuild(tx))),
  Stream.runDrain
)
```

`PersistenceError` already uses `Schema.TaggedError` (done in prior migration).

### 5.2 OrchestrationEngine — complete partial migration

Already uses `Effect.Ref` for idempotency. Finish by replacing mixed Promise+Effect:

```typescript
// Pure Effect — no Effect.runSync embedded in async
const routeCommand = (cmd: Command) => Effect.gen(function*() {
  const seen = yield* IdempotencySetTag
  const isDuplicate = yield* Ref.modify(seen, checkAndAdd(cmd.id))
  if (isDuplicate) return TurnResult.deduplicated()

  const provider = yield* ProviderRegistryTag
  return yield* provider.execute(cmd)
})
```

Session-to-provider binding: `Ref<Map<sessionId, ProviderId>>`.

### 5.3 PTY Upstream — Stream over WebSocket

```typescript
const ptyStream = (url: string) => Stream.asyncScoped<PtyEvent, PtyError>((emit) =>
  Effect.gen(function*() {
    const ws = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(url)),
      (ws) => Effect.sync(() => ws.close())
    )

    ws.onmessage = (e) => emit.single(parsePtyEvent(e.data))
    ws.onerror = (e) => emit.fail(new PtyConnectionError({ cause: e }))
    ws.onclose = () => emit.end()

    yield* Effect.sleep(Duration.seconds(10)).pipe(
      Effect.flatMap(() =>
        ws.readyState !== WebSocket.OPEN
          ? emit.fail(new PtyConnectionTimeout())
          : Effect.void),
      Effect.forkScoped
    )
  })
)
```

WebSocket lifecycle managed by `acquireRelease`. Timeout via Effect, not setTimeout.

### 5.4 Rate Limiter — Ref + Schedule

```typescript
const RateLimiterLive = Layer.scoped(RateLimiterTag,
  Effect.gen(function*() {
    const state = yield* Ref.make<RateLimiterState>({ buckets: new Map() })

    yield* Ref.update(state, evictStale).pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped
    )

    return {
      checkLimit: (ip: string) => Ref.modify(state, tryConsume(ip)),
    }
  })
)
```

`tryConsume` is pure function: takes state + IP, returns `[allowed: boolean, newState]`. Atomic via `Ref.modify`.

### 5.5 Push Notifications — Pool + acquireRelease

```typescript
const PushManagerLive = Layer.scoped(PushManagerTag,
  Effect.gen(function*() {
    const vapidKeys = yield* loadOrGenerateKeys.pipe(
      Effect.catchAllCause(Effect.logWarning))
    const subscriptions = yield* Ref.make<Map<string, PushSubscription>>(new Map())

    const sendPool = yield* Pool.make({
      acquire: Effect.void,
      size: 10
    })

    return {
      subscribe: (sub) => Ref.update(subscriptions, Map.set(sub.id, sub)),
      unsubscribe: (id) => Ref.update(subscriptions, Map.remove(id)),
      broadcast: (payload) => Effect.gen(function*() {
        const subs = yield* Ref.get(subscriptions)
        yield* Effect.forEach(
          subs.values(),
          (sub) => Pool.use(sendPool, () =>
            sendPush(vapidKeys, sub, payload)).pipe(
            Effect.catchAllCause(Effect.logWarning)),
          { concurrency: "unbounded" }
        )
      })
    }
  })
)
```

VAPID key files managed by scope. Pool caps concurrent HTTP requests. Individual send failures isolated.

---

## Part 6: Execution Strategy

### 6.1 Dependency graph

```
                    ┌─────────────────────┐
                    │  Daemon Dissolution  │
                    │  (DaemonState Ref,   │
                    │   startup program,   │
                    │   Layer composition) │
                    └──────┬──────────────┘
                           │
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
     ┌────────────┐  ┌───────────┐  ┌──────────────┐
     │ IPC Schema │  │ Relay     │  │ Leaf Service │
     │ + Handlers │  │ ScopedCa. │  │ Internals    │
     └────────────┘  └───────────┘  └──────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌────────────┐  ┌──────────┐  ┌────────────┐
     │ SSEStream  │  │ Message  │  │ PTY        │
     │ → Stream   │  │ Poller   │  │ Upstream   │
     └────────────┘  └──────────┘  └────────────┘
```

### 6.2 Three parallel tracks

**Track A — Daemon core (sequential):**
1. Dissolve Daemon class → DaemonState Ref + startup Effect program + expanded Layer composition
2. IPC handlers → Schema.TaggedRequest + Effect.gen (depends on DaemonState Ref existing)

**Track B — Session stack (parallel within):**
- SessionManager (EventEmitter → Layer + Ref)
- SessionStatusPoller (setInterval → Schedule + Ref)
- SSEStream (backoff → Schedule + Stream)
- MessagePoller (setInterval → fiber map)

**Track C — Supporting services (parallel within):**
- InstanceManager internals (health polling → fibers, spawn → acquireRelease)
- 4 leaf services (dissolve classes)
- OrchestrationEngine completion
- Persistence layer
- PTY, Rate Limiter, Push

### 6.3 Priority table

| # | Track | Scope | Effort | Prerequisite | Parallelizable with |
|---|-------|-------|--------|--------------|---------------------|
| 1 | A | Daemon dissolution | Large | None | 2, 3, 4 |
| 2 | B | SessionManager | Medium | None | 1, 3, 4 |
| 3 | B | SSEStream → Stream | Medium | None | 1, 2, 4 |
| 4 | B | SessionStatusPoller | Medium | None | 1, 2, 3 |
| 5 | A | IPC Schema + handlers | Medium | #1 | 6, 7, 8 |
| 6 | B | MessagePoller + Manager | Small | None | 5, 7, 8 |
| 7 | C | InstanceManager internals | Medium | None | 5, 6, 8 |
| 8 | C | Leaf service internals (×4) | Small | None | 5, 6, 7 |
| 9 | C | Persistence layer | Large | None | 10, 11, 12 |
| 10 | C | OrchestrationEngine | Small | None | 9, 11, 12 |
| 11 | C | PTY Upstream | Small | None | 9, 10, 12 |
| 12 | C | Rate Limiter + Push | Small | None | 9, 10, 11 |

Items 1–4 start immediately. Items 6–8 start immediately. Only #5 (IPC) blocks on #1 (daemon dissolution).

### 6.4 Testing strategy

Each module provides test Layers with mock implementations. Every Effect function testable in isolation via `Effect.provide(testLayer)`.

```typescript
const TestSessionManagerLive = Layer.succeed(SessionManagerTag, {
  listSessions: () => Effect.succeed(mockSessions),
  createSession: (title) => Effect.succeed(mockSession(title)),
  // ...
})

// Test in isolation
const result = await Effect.runPromise(
  listSessions({ limit: 10 }).pipe(
    Effect.provide(TestSessionManagerLive)
  )
)
```
