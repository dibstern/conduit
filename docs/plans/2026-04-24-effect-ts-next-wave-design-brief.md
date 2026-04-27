# Effect.ts Next Wave: Design Brief

> What needs designing and planning before the next round of Effect migration work.

---

## Part 1: Rewiring daemon.ts start() to use makeDaemonLive

### Current State

`makeDaemonLive` in `daemon-layers.ts` composes 11 Layer factories covering signal handlers, process error handlers, PID files, 3 servers (HTTP, IPC, onboarding), and 5 background services (KeepAwake, VersionChecker, StorageMonitor, PortScanner, SessionOverrides). All Layers have finalizers for clean shutdown.

`daemon.ts start()` is ~580 lines of imperative code that still creates services manually, registers them nowhere (ServiceRegistry deleted), and drains them explicitly in `stop()`. The Layers exist but aren't wired.

### What makeDaemonLive Covers vs What It Doesn't

**Covered (pure lifecycle start/stop):**
- Signal handlers (SIGTERM/SIGINT/SIGHUP)
- Process error handlers (unhandledRejection/uncaughtException)
- PID file write/cleanup
- HTTP, IPC, onboarding server start/close
- KeepAwake, VersionChecker, StorageMonitor, PortScanner lifecycle

**Not covered (complex startup orchestration):**
1. Crash counter recording and validation
2. Config rehydration from disk (instances, projects, dismissed paths, keep-awake overrides)
3. Probe-and-convert logic (detect unreachable unmanaged instances, convert to managed)
4. Smart default detection (probe localhost:4096, create instance)
5. Auto-start managed default instance
6. WebSocket upgrade routing with lazy relay creation
7. Port scanner initialization with discovery/loss callbacks and instance auto-add
8. Session count prefetching (fire-and-forget)
9. Project auto-discovery from OpenCode API
10. Push notification manager initialization
11. TLS certificate loading/generation
12. HTTP router creation with auth configuration
13. Event loop blocking detector
14. Config persistence coalescing (`_pendingSave`/`_needsResave`)

### Why This Is Hard

The uncovered items aren't simple start/stop pairs. They involve:

- **Ordering dependencies**: IPC must start before HTTP (CLI needs to send commands during init). TLS certs must load before HTTP server creation. Router needs auth manager, push manager, and project list callbacks.
- **Shared mutable state**: `daemon.ts` holds ~30 mutable fields that startup steps read/write. Port scanner callbacks reference `this.instanceManager` and `this.registry`. WebSocket upgrade handler references `this.registry` and `this.router`. Config save references everything.
- **Fire-and-forget async**: Project discovery, session prefetch, and push init are non-blocking background work launched during startup. They don't block the main sequence but need error isolation.
- **Lazy initialization**: Relays start on first WebSocket connection, not during `start()`. The upgrade handler calls `ensureRelayStarted()` which may trigger relay creation.
- **Callback wiring between services**: Port scanner calls `instanceManager.addInstance()` on discovery. Storage monitor triggers event store eviction. Version checker broadcasts to all browsers. These cross-service callbacks are set up during startup.

### Design Questions to Resolve

1. **State model**: Should daemon mutable state move to `Effect.Ref` values provided via Layers, or stay as class fields with the Daemon class wrapped in a single Layer?

2. **Startup vs Layer**: Which startup steps become Layers (with finalizers) vs which become Effect programs that run once after Layers are built? Guideline: if it has a matching cleanup action, it's a Layer. If it's a one-shot init, it's an Effect program.

3. **Callback wiring**: How do cross-service callbacks (port scanner -> instance manager, storage monitor -> event store) get wired? Options:
   - Services expose PubSub/Stream, wiring code subscribes (clean but adds complexity)
   - Services accept callbacks at construction (current pattern, simple, works with Layers)
   - Services access other services via Context.Tag (Effect-idiomatic but requires all services as Tags)

4. **Lazy relay creation**: The upgrade handler creates relays on-demand. Under Effect, this could be an `Effect.cached` factory or a `Ref<Map<slug, Relay>>`. Need to decide how relay lifecycle interacts with daemon scope.

5. **Error isolation**: Startup has explicit "non-fatal" operations (push init, project discovery, session prefetch). Under Effect, these become `Effect.catchAll(() => Effect.void)` or `Effect.ignoreLogged`. Need clear policy on which startup failures are fatal vs logged.

6. **IPC command handlers**: 35+ IPC commands mutate daemon state. Under full Effect, these would be Effect programs reading services from Context. But they currently close over `this.*`. Migration path: keep closures initially, convert to Context reads later.

### Recommended Approach

**Incremental, not big-bang.** Move startup into Effect in phases:

**Phase A: Wrap Daemon class in a Layer**
- Create `DaemonTag` and a `makeDaemonServiceLive` Layer that constructs the Daemon instance
- `start()` stays imperative inside the Layer's acquire
- `stop()` stays imperative inside the Layer's finalizer
- `makeDaemonLive` provides infrastructure Layers, `DaemonTag` Layer sits on top
- Net effect: daemon lifecycle is Effect-managed, internals unchanged

**Phase B: Extract startup effects**
- Pull individual startup steps out of `start()` into standalone Effect functions
- Each function takes dependencies as args (not `this.*`)
- `start()` becomes: build DaemonLive Layer, then `yield*` each startup effect
- Test each startup effect independently

**Phase C: Convert state to Ref**
- Move mutable fields to `Effect.Ref` one at a time
- Start with simple state (clientCount, dismissedPaths, shuttingDown)
- Graduate to complex state (instanceManager contents, registry entries)

**Phase D: Convert IPC to Effect**
- IPC command handlers become Effect programs
- Read services from Context instead of closing over `this.*`
- Each command is a standalone Effect function, tested independently

---

## Part 2: Other Non-Effect Code Worth Migrating

### Tier 1: High Impact, Moderate Risk

These are central to the system and would benefit most from Effect's structured concurrency, error handling, and resource management.

#### SessionManager (`src/lib/session/session-manager.ts`)
**Last EventEmitter in the codebase.** Manages session CRUD, caches metadata, handles pagination. Heavy mutable state (6 Maps/Sets). EventEmitter for broadcast/send/lifecycle events.

**Design needs:**
- Replace EventEmitter with typed callbacks (same pattern as Task 10) or Effect.PubSub
- Convert API calls from raw Promises to Effect with retry + error typing
- Move cached state (parentMap, lastMessageAt, paginationCursors) to Effect.Ref
- Handle cursor-based pagination recovery (400 on stale cursor) via Effect error channel

#### SSEStream (`src/lib/relay/sse-stream.ts`)
Already migrated from EventEmitter to callbacks. Uses manual exponential backoff, AbortController, health tracking. The reconnection logic (interval calculation, stale detection, attempt counting) is a natural fit for `Effect.Schedule` + `Effect.Stream`.

**Design needs:**
- Replace manual backoff with `Schedule.exponential` + `Schedule.jittered`
- Replace AbortController with Effect fiber interruption
- Model SSE events as `Effect.Stream`
- Stale detection via `Effect.Schedule.spaced` timeout

#### SessionStatusPoller (`src/lib/session/session-status-poller.ts`)
Background reconciliation loop (7s interval). Compares SQLite state vs REST API, injects corrective events. Heavy mutable state (previous statuses, activity timestamps, child-to-parent cache, idle session tracking).

**Design needs:**
- Replace setInterval with `Effect.Schedule.spaced(7_000)`
- Model reconciliation as `Effect.Stream` pipeline
- Move all mutable maps to `Effect.Ref`
- Message activity TTL decay via `Effect.Schedule`

### Tier 2: Medium Impact, Low Risk

Simpler services where Effect provides cleaner lifecycle and error handling.

#### MessagePoller + MessagePollerManager (`src/lib/relay/message-poller*.ts`)
Polling fallback when SSE is silent. Manager tracks pollers per session. Already uses callbacks. setInterval-based with idle timeout. Direct swap to `Effect.Schedule` + `Effect.Ref`.

#### InstanceManager (`src/lib/instance/instance-manager.ts`)
Already migrated from EventEmitter to callbacks. Complex lifecycle: health polling per instance (setInterval Map), restart rate-limiting (timestamp tracking), process spawning. 14 emit sites converted to callbacks.

**Design needs:**
- Per-instance health polling as Effect fibers (auto-cancel on instance removal)
- Restart rate-limiting via `Effect.Schedule` + `Effect.Ref<Set<timestamp>>`
- Process spawning via Effect (interruptible, with automatic cleanup)

#### StorageMonitor, VersionChecker, PortScanner, KeepAwake
Already have Layer factories. Internal logic still uses setInterval/setTimeout/spawn. Converting internals to Effect would make the Layers self-contained rather than wrapping imperative classes.

**Design needs per service:**
- Replace setInterval with `Effect.Schedule.spaced` inside the Layer
- Replace mutable state with `Effect.Ref`
- Replace spawn with Effect-managed process
- Service class dissolves; Layer IS the service

### Tier 3: Lower Priority, Higher Complexity

#### Persistence Layer (`src/lib/persistence/`)
EventStore, ProjectionRunner, ReadQueryService. Raw `db.query()` calls with try/catch. Transaction management via `db.runInTransaction()`.

**Design needs:**
- `Effect.acquireRelease` for database connections
- Transaction scope via Effect (auto-rollback on error)
- Projection replay as `Effect.Stream` pipeline
- PersistenceError already uses Schema.TaggedError (done in Task 6)

#### OrchestrationEngine (`src/lib/provider/orchestration-engine.ts`)
Partially migrated — already uses `Effect.Ref` for idempotency. Routes commands to provider adapters. Mixed Promise + Effect patterns.

**Design needs:**
- Complete the partial migration: return `Effect<TurnResult>` instead of `Promise<TurnResult>`
- Session-to-provider binding via `Effect.Ref<Map>`

#### PTY Upstream (`src/lib/relay/pty-upstream.ts`)
WebSocket connection to OpenCode PTY endpoint. Promise wrapper with setTimeout. Natural fit for `Effect.Stream` over WebSocket messages with `Effect.timeout`.

#### IPC Protocol (`src/lib/daemon/daemon-ipc.ts`)
Unix socket protocol with manual JSON framing. 35+ command handlers. Would benefit from Effect.Stream for message parsing and Effect error channels for command results.

#### Rate Limiter (`src/lib/server/rate-limiter.ts`)
Token bucket per IP with cleanup interval. Small, self-contained. Easy win for `Effect.Ref` + `Effect.Schedule`.

#### Push Notifications (`src/lib/server/push.ts`)
VAPID key management, subscription tracking, concurrent sends. `Effect.Pool` for send rate limiting, `Effect.Scope` for key file lifecycle.

---

## Suggested Planning Order

| Priority | Scope | Effort | Prerequisite |
|----------|-------|--------|--------------|
| 1 | Daemon Phase A (wrap in Layer) | Small | None |
| 2 | SessionManager (last EventEmitter) | Medium | None |
| 3 | SSEStream internals | Medium | None |
| 4 | SessionStatusPoller internals | Medium | None |
| 5 | Daemon Phase B (extract startup effects) | Large | Phase A |
| 6 | MessagePoller + Manager internals | Small | None |
| 7 | InstanceManager internals | Medium | None |
| 8 | Leaf service internals (4 services) | Small | None |
| 9 | Daemon Phase C (state to Ref) | Large | Phase B |
| 10 | Persistence layer | Large | None |
| 11 | OrchestrationEngine completion | Small | None |
| 12 | Daemon Phase D (IPC to Effect) | Large | Phase C |
| 13 | PTY, Rate Limiter, Push | Small each | None |

Items 1-4 can proceed in parallel. Items 6-8 can proceed in parallel. The daemon phases (1, 5, 9, 12) are sequential.
