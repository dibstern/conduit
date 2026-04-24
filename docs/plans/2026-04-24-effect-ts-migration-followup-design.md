# Effect.ts Migration Follow-Up Design

**Date:** 2026-04-24
**Context:** The original 7-layer Effect.ts migration plan was implemented in the `feature/effect-ts-migration` worktree. Post-implementation audit revealed 6 gaps: dead legacy code, incomplete TaggedErrorClass conversion, unmigrated retry-fetch consumer, daemon lifecycle out of scope, and minor documentation gaps. This plan addresses all of them.

**Worktree:** `.worktrees/effect-ts-migration` (branch: `feature/effect-ts-migration`)

**Approach:** Bottom-up (A). Clean dead code first, then fix errors, then migrate sdk-factory, then the full daemon. Each workstream is independently shippable.

---

## W1: Delete Dead Legacy Dispatch Code

**Problem:** `EFFECT_MESSAGE_HANDLERS` + `dispatchMessageEffect` fully replaced `MESSAGE_HANDLERS` + `dispatchMessage` in production (relay-stack.ts:533 routes through Effect runtime). Legacy versions remain as dead code.

**Changes:**
- `src/lib/handlers/index.ts` — delete `MESSAGE_HANDLERS` record, `dispatchMessage()` function, their exports
- `test/unit/handlers/message-handlers.test.ts` — remove tests covering `MESSAGE_HANDLERS` completeness
- `test/unit/server/ws-router.pbt.test.ts` — remove `MESSAGE_HANDLERS` import/validation

**Verification:** `pnpm check && pnpm test:unit`

---

## W5: TransportLayer.empty Clarifying Comment

**Problem:** `TransportLayer = Layer.empty` in `src/lib/frontend/transport/runtime.ts` looks like incomplete work but is intentional — frontend has no service dependencies, ManagedRuntime is needed for fiber lifecycle (interrupt stream on reconnect).

**Change:** Add clarifying comment after the declaration.

---

## W3: Migrate sdk-factory.ts to Full Effect

**Problem:** `src/lib/instance/sdk-factory.ts` still imports old `createRetryFetch()` from `src/lib/instance/retry-fetch.ts`. Effect version exists at `src/lib/effect/retry-fetch.ts` but has behavior gaps and sdk-factory hasn't been converted.

**Design:**

### Fix Effect retry-fetch behavior gaps
- Backoff: `Schedule.exponential` → `Schedule.linear` (match old: 1000, 2000, 3000ms)
- Add `baseFetch` option for test injection
- Widen signature from `string` to `RequestInfo | URL`

### Convert sdk-factory to Effect
- `createSdkClient` → `createSdkClientEffect` returning `Effect.Effect<SdkFactoryResult, OpenCodeConnectionError>`
- Internal fetch wrapping uses `fetchWithRetry` from Effect retry-fetch directly
- Export `SdkClientTag` (Context.Tag) and `SdkClientLive` Layer in `src/lib/effect/services.ts`

### Update consumers
- `relay-stack.ts` (already Effect-based) — replace synchronous `createSdkClient()` with `yield* createSdkClientEffect(...)` in Effect pipeline
- `daemon.ts` (not yet Effect) — temporary compat wrapper `createSdkClient = (...args) => Effect.runPromise(createSdkClientEffect(...args))`, deleted in W4

### Cleanup
- Delete `src/lib/instance/retry-fetch.ts`
- Update `test/unit/effect/retry-fetch.test.ts` — add baseFetch injection and linear backoff tests

---

## W2: Convert Errors to Schema.TaggedErrorClass

**Problem:** Layer 1 added manual `_tag` properties. Layer 5 was supposed to convert to `Schema.TaggedErrorClass` but this was missed. All 7 error classes still extend plain `Error`.

**Design:**

### Relay errors (6 classes)
Each subclass (OpenCodeConnectionError, OpenCodeApiError, SSEConnectionError, WebSocketError, AuthenticationError, ConfigurationError) becomes `Schema.TaggedErrorClass`. Shared fields extracted to `RelayErrorFields` Schema struct. Instance methods (`toJSON`, `toWebSocket`, `toMessage`, `toSystemError`, `toLog`) preserved on class body.

Wire compat: `get code() { return this._tag; }` — downstream `.code` references work without mass rename.

RelayError base class eliminated. `RelayError` becomes a `Schema.Union` type alias for pattern matching.

### PersistenceError
Same pattern. `_tag = "PersistenceError"` becomes automatic. `code` field stays as separate `Schema.Literal` sub-discriminant.

### Construction site updates (~48 sites)
Current constructors already use object pattern — minimal changes expected. Main risk: `RelayError.fromCaught()` static method needs new home (standalone function or on a specific subclass).

### Wire format
`error.code` values change from `"OPENCODE_API_ERROR"` → `"OpenCodeApiError"`. Update all downstream checks (`grep '.code ===' src/`).

### Test updates
- `test/unit/schema/errors.test.ts` — validate TaggedErrorClass behavior
- `test/unit/errors.pbt.test.ts` — update constructors, instanceof → _tag checks
- Handler/relay tests asserting on error `.code` values

---

## W4: Full Daemon Migration to Effect Layers

**Problem:** Daemon lifecycle (13 Drainable services, ServiceRegistry, AsyncTracker, signal handlers, 3 servers, IPC) is entirely imperative. It's the last major subsystem outside Effect.

**Design:**

### Layer tree

```
DaemonLive
├── SignalHandlerLayer          (SIGTERM/SIGINT → fiber interrupt)
├── ProcessErrorHandlerLayer    (unhandledRejection/uncaughtException)
├── ConfigLayer                 (rehydrate from disk, Schema validate)
├── ServersLayer
│   ├── HttpServerLayer         (acquireRelease: listen/close)
│   ├── IpcServerLayer          (acquireRelease: listen/close)
│   └── OnboardingServerLayer   (acquireRelease: listen/close, TLS-only)
├── CoreServicesLayer
│   ├── InstanceManagerLive     (child process management)
│   ├── ProjectRegistryLive     (relay creation/tracking)
│   ├── PortScannerLive         (discovery polling)
│   └── AuthManagerLive
├── BackgroundServicesLayer
│   ├── VersionCheckerLive      (periodic npm check)
│   ├── KeepAwakeLive           (caffeinate/systemd-inhibit process)
│   ├── StorageMonitorLive      (disk space polling)
│   └── EventLoopMonitorLive
└── RelayServicesLayer          (per-project, already Effect-based)
    ├── SSEStreamLive
    ├── MessagePollerLive
    ├── SessionStatusPollerLive
    ├── SessionOverridesLive
    ├── RelayTimersLive
    └── WebSocketHandlerLive
```

### Primitive replacements

| Current | Effect replacement |
|---------|-------------------|
| `Drainable.drain()` | `Effect.addFinalizer()` inside `Layer.scoped` |
| `ServiceRegistry.drainAll()` | Layer tree finalizer ordering (automatic) |
| `AsyncTracker.track(promise)` | `Effect.forkScoped` fibers |
| `installSignalHandlers(cb)` | Layer that interrupts main fiber on signal |
| `process.on("unhandledRejection")` | Layer.scoped acquire/finalizer |
| `EventEmitter .on()/.emit()` | Typed `PubSub` per service (7 services) |
| Callback patterns (onScan, etc.) | Effect streams or PubSub (4 services) |
| `startServer()`/`closeServer()` | `Effect.acquireRelease` |
| PID/socket file management | HttpServer Layer finalizer |

### Ordering constraints (preserved via Layer dependencies)
- IPC listens before relay factory creates relays
- HTTP ready before WebSocket upgrade
- PortScanner created before relay factory reads it
- Config flushed before services drain (finalizer ordering)
- Servers close AFTER services drain (reverse Layer order)

### Migration sequence
1. SignalHandlerLayer + ProcessErrorHandlerLayer
2. ConfigLayer (rehydrate + Schema validate)
3. Leaf services (no deps): VersionChecker, KeepAwake, StorageMonitor, PortScanner
4. Core services: InstanceManager, ProjectRegistry
5. Relay-bound services: SSEStream, MessagePoller, SessionStatusPoller, SessionOverrides, RelayTimers, WebSocketHandler, MessagePollerManager
6. Server Layers (HTTP, IPC, Onboarding)
7. Compose DaemonLive, wire `Layer.launch` in CLI entry point
8. Delete: service-registry.ts, async-tracker.ts, Drainable interface
9. Delete sdk-factory compat wrapper from W3
10. Update daemon tests
11. Full verification: `pnpm check && pnpm test:unit`, manual smoke test

### EventEmitter → PubSub scope (7 services, ~133 call sites)
- InstanceManager (15 sites): instance_added, status_changed, instance_error
- ProjectRegistry (13 sites): project_added, project_ready, project_error
- WebSocketHandler (11 sites): client_connected, client_disconnected, message
- SSEStream (8 sites): connected, disconnected, reconnecting, error
- SessionStatusPoller (5 sites): status changes
- MessagePoller: synthesized streaming events
- MessagePollerManager: forwarded poller events

Exclusions (Node.js built-ins, NOT migrated): `process.on()`, `httpServer.on()`, `ws.WebSocket.on()`, `wss.on()`

### Sync → async semantic change
`EventEmitter.emit()` is synchronous. `PubSub.publish()` is async. Sites where callers depend on handlers having run before emit returns need analysis — some may need `Effect.sync` + direct calls instead of PubSub.

---

## Execution order

W1 → W5 → W3 → W2 → W4

Each workstream is a separate commit (or set of commits). Each is independently verifiable with `pnpm check && pnpm test:unit`.
