# Effect.ts Conventions

> Shared reference for all phase documents. Read ONCE before starting any phase.

## Error Handling

- **All new error types** MUST use `Data.TaggedError` (or `Schema.TaggedError` when serialization is needed). Never use plain classes with a `_tag` field — they won't work with `Effect.catchTag`.
- Service methods MUST expose expected errors in the `E` type parameter — do NOT catch all errors internally. Callers decide how to handle them.
- **Use `Effect.catchTag`** (not `Effect.catchAll`) for expected failures. `catchAll` swallows defects (programming bugs) — only use it at the top-level daemon boundary or when you intentionally want degraded operation.
- In service internals, always catch specific tagged errors so defects propagate to the supervisor for diagnostics.
- **AUDIT FIX (H7):** Service functions that catch errors internally and return `Effect<A, never, R>` MUST still log the error context. Use `Effect.tapError(Effect.logWarning)` before `catchTag` so callers at least see the failure in logs. Only use `never` in the error channel when the function genuinely cannot fail (e.g., read-only state access).

## Testing

- Use `@effect/vitest` (`it.effect`, `it.scoped`) for ALL tests that run Effect programs — never use plain `it()` with manual `Effect.runPromise()` wrappers.
- `it.effect` provides automatic Effect execution, proper Cause traces on failure, and `TestClock` integration.
- Plain vitest `it()` is ONLY for pure-function tests that don't touch Effect.
- Use `TestClock.adjust()` for time-dependent tests — never use real `Effect.sleep()` in tests.
- **AUDIT FIX (H5):** When a `describe` block defines a shared Layer variable (e.g., `const testLayer = ...`), every `it.effect` / `it.scoped` that provides it MUST wrap it in `Layer.fresh(testLayer)`. Without this, vitest's concurrent test execution can share Ref state across tests. Example:
  ```typescript
  const testLayer = makeDaemonStateLive(); // contains Ref.make — stateful
  it.effect("test A", () =>
    myEffect.pipe(Effect.provide(Layer.fresh(testLayer))) // ← Layer.fresh
  );
  ```
  The executing agent MUST apply this pattern to every test in this plan. The code examples in the phase documents omit `Layer.fresh` for brevity — add it during implementation.

## Logging

- All Effect modules use `Effect.logInfo` / `Effect.logWarning` / `Effect.logError` — never import pino directly.
- **Every service function that operates on a specific entity** (session, instance, poller, client) MUST use `Effect.annotateLogs` to attach the entity ID. Example: `.pipe(Effect.annotateLogs("sessionId", sessionId))`.

## Fiber Supervision

- Long-lived fibers (health pollers, message pollers, SSE streams, background tasks) MUST use `Effect.retry` with a schedule so they restart on unexpected errors rather than silently dying.
- **AUDIT FIX (C5):** Use `Effect.forkScoped` (NOT `Effect.forkDaemon`) for background tasks that should stop on shutdown. `forkDaemon` fibers survive Layer teardown and are NOT interrupted when the daemon stops. `forkScoped` ties fibers to the enclosing Scope so they're interrupted in reverse order during graceful shutdown.

## Configuration

- Schedule intervals and timeouts MUST be configurable via the Layer config, not hardcoded.
- Use `Effect.Config` for environment-sourced values — see Phase 4 Task 28 for the `DaemonConfig` Layer.

## @effect/platform Usage

- `@effect/platform/FileSystem` + `@effect/platform-node/NodeFileSystem` for file operations.
- `@effect/platform/HttpClient` for outgoing HTTP requests (enables test injection without `vi.mock`).
- `@effect/platform-node/NodeHttpServer` for serving HTTP (replaces raw `http.createServer`).
- `@effect/platform-node/NodeCommandExecutor` for process spawning.

## Layer Composition

- Use `Layer.provide` to express dependency relationships, not flat `Layer.mergeAll`.
- `mergeAll` is only for truly independent Layers.
- `Layer.merge` / `Layer.provide` composition ensures stateful services are built exactly once.

## Data Structures

- Prefer `HashMap` from `effect` over `new Map()` copying in `Ref.update`. `HashMap` provides structural sharing.
- **Exception:** Use native `Map` when values contain mutable Effect primitives (e.g., `Fiber.RuntimeFiber`). Document the exception inline.

## Coordination & Streaming

- `Effect.Deferred` for one-shot async coordination (server ready signals, startup completion).
- `Effect.Queue` for buffered message channels (WebSocket bootstrap queue, event buffering).
- `PubSub` for cross-service event broadcasting. Use `Stream.fromPubSub` to consume as Streams.
- `Effect.cachedWithTTL` for API results that tolerate staleness.

## Retry Discrimination

- Use `Schedule.whileInput((e) => isRetryable(e))` for retry policies that should stop based on error type. Don't use a flat `Schedule.recurs(n)` when some errors are non-retryable.

## Tracing

- Use `Effect.withSpan` at key boundaries (IPC dispatch, WS message handling, SSE connection lifecycle, API calls) for OpenTelemetry-compatible tracing.

## Daemon Entry Point

- Use `Layer.launch` for the top-level daemon program. It constructs the Layer, runs until interrupted (SIGINT/SIGTERM), then tears down all finalizers in reverse order.

## Persistence

- Use `@effect/sql-sqlite-node` for SQLite. Provides type-safe `SqlClient` with `SqlClient.withTransaction`, connection pooling, and Effect-native integration.

## Scoped Resources

- Use `ScopedRef` for caches that hold scoped resources and support swapping/invalidation (e.g., relay cache).

## No Forward References

- **AUDIT FIX (C1):** A module created in Phase N MUST NOT import from modules created in Phase N+1 or later. If a type alias references Tags from later phases, use a comment placeholder and expand it in the task that creates the dependency. This prevents compile failures when executing phases sequentially.

## No Wrappers Policy

- Every task converts the module AND updates all consumers to use the Effect API directly.
- No bridge/adapter files. Old implementations are deleted after ALL consumers are converted.
- The executing agent MUST `grep` for all import sites of old modules and update them before committing.

## API Correctness (Effect ^3.21)

- Use `Effect.void` (not `Effect.unit` — deprecated in 3.x).
- `Stream.timeoutFail` uses **positional arguments**: `Stream.timeoutFail(() => error, duration)` — NOT an options object.
- `Config.redacted` wraps a Config: `Config.string("KEY").pipe(Config.redacted)`.
- `Supervisor.track` is an Effect (must `yield*` it). **`Supervisor.toArray` does NOT exist** — use `sv.value`.
- `Effect.supervised` is **curried**: `Effect.supervised(supervisor)(effect)`.
- `Metric.histogram` uses `MetricBoundaries` (not `Metric.HistogramBoundaries`).
- Use `@effect/platform-node/NodeHttpClient` for the HttpClient Layer.
- Use `@effect/platform-node/NodeCommandExecutor` for process spawning.
- Use `@effect/platform` `Stream` utilities (`Stream.decodeText`, `Stream.splitLines`) for HTTP response bodies in Node.js — NOT Web ReadableStream APIs.

## Service Definition Pattern

- **`Effect.Service` does NOT exist in Effect 3.21.2.** Previous audit notes referencing it were incorrect. The correct pattern for all service definitions is `Context.Tag` + `Layer.succeed` / `Layer.effect` / `Layer.scoped`.
- For simple services (no lifecycle), use: `class MyTag extends Context.Tag("My")<MyTag, MyService>() {}` + `Layer.succeed(MyTag, impl)`.
- For stateful services, use: `Layer.effect(MyTag, Ref.make(...).pipe(Effect.map(ref => impl)))`.
- For services with lifecycle (background fibers, cleanup), use: `Layer.scoped(MyTag, Effect.gen(function* () { ... yield* Effect.addFinalizer(...); return impl; }))`.
- **AUDIT FIX (M1):** Do NOT defer service cleanup — this plan IS the full migration. All services use the `Context.Tag` pattern consistently with the existing branch.

## Stream.timeoutFail (positional args)

- `Stream.timeoutFail` uses **positional arguments** (verified against `effect/Stream.d.ts`):
  - WRONG: `Stream.timeoutFail({ onTimeout: () => err, duration: d })`
  - RIGHT: `Stream.timeoutFail(() => err, d)`
  - This applies everywhere in the plan that uses `Stream.timeoutFail`.

## ScopedRef.make vs ScopedRef.fromAcquire

- **AUDIT FIX (C8):** `ScopedRef.make(evaluate)` takes a `LazyArg<A>` (thunk returning a plain value). It does NOT accept an Effect.
  - For plain values: `ScopedRef.make(() => null)`
  - For Effect-based initialization: `ScopedRef.fromAcquire(Effect.succeed(null))`
  - The plan code using `ScopedRef.make(() => Effect.succeed(...))` is wrong — it stores the Effect as the value instead of running it.

## FiberMap / FiberSet for managed fiber collections

- **AUDIT FIX (H8):** When managing a collection of named fibers (e.g., one poller per session, one health checker per instance), use `FiberMap<K, A, E>` instead of `Map<string, Fiber.RuntimeFiber>` + manual interrupt loops.
  - `FiberMap.make<string>()` — creates a fiber map scoped to the current scope
  - `FiberMap.run(fiberMap, key, effect)` — forks effect and registers under key, auto-interrupts previous fiber for same key
  - All fibers are automatically interrupted when the enclosing scope closes
  - Eliminates manual `Ref.modify` + `Fiber.interrupt` patterns and associated race conditions

## Schema.transform for domain↔wire conversions

- **AUDIT FIX (H9):** Prefer `Schema.transform(FromSchema, ToSchema, { decode, encode })` over manual serialize/deserialize functions when converting between wire format (JSON) and domain types (e.g., `Array<string>` ↔ `Set<string>`, persisted config ↔ runtime state).

## Data.TaggedEnum for discriminated event unions

- **AUDIT FIX (H10):** Use `Data.TaggedEnum` for event types that need exhaustive pattern matching (e.g., DaemonEvent). Provides compile-time exhaustiveness in `match` and proper value constructors. Interfaces with `readonly _tag` string literals don't provide exhaustiveness guarantees.

## @effect/rpc API (Effect 3.21)

- **AUDIT FIX (C6):** The `@effect/rpc` package does NOT export `Rpc.effect()`, `RpcRouter.make()`, or `RpcRouter.toHandler()`. The actual API is:
  - `Rpc.make(tag, options)` — define an RPC endpoint
  - `RpcGroup.make(...rpcs)` — group endpoints
  - `RpcGroup.toHandlersContext()` — get handler context
  - `RpcGroup.toLayer()` — create Layer from handlers
  - `RpcClient.make(group)` — create type-safe client

## PinoLoggerLive must forward annotations

- **AUDIT FIX (L7):** The `Logger.make` callback receives `{ logLevel, message, annotations, spans, cause }`. The PinoLoggerLive implementation MUST forward `annotations` as Pino child logger bindings, otherwise all `Effect.annotateLogs` context is lost.

## Tech Stack

```
effect              3.21.2   (pin exact — no caret)
@effect/platform    0.96.1
@effect/platform-node 0.106.0
@effect/vitest      (dev dependency — install in prerequisites)
@effect/sql         0.30.0   (Phase 2b Task 15)
@effect/sql-sqlite-node 0.28.0 (Phase 2b Task 15)
@effect/rpc         (Phase 6)
better-sqlite3      (Phase 2b Task 15)
```

## Effect.forEach Optimization

- **AUDIT FIX (H-R5-7):** When `Effect.forEach` return values are ignored (e.g., broadcasting, cleanup loops), pass `{ discard: true }` to avoid building an unused result array. Example:
  ```typescript
  // BAD: builds Array<void> that is immediately discarded
  yield* Effect.forEach(items, (item) => process(item), { concurrency: 10 });
  // GOOD: discards results, avoids allocation
  yield* Effect.forEach(items, (item) => process(item), { concurrency: 10, discard: true });
  ```
- This applies to: `rehydrateInstances` (Task 3), `broadcast` (Task 18/32), `healthPollFiber` correction broadcasts, and `PubSub` publisher loops.

## FiberMap API (Effect 3.21)

- **AUDIT FIX (M-R5-6):** Verify `FiberMap.has(map, key)` return type against installed Effect 3.21.2 types. If it returns `Effect<boolean>` instead of `boolean`, all `isPollerActive`-style functions need `yield*`. Check: `node_modules/effect/dist/dts/FiberMap.d.ts`.

## Request Batching & Caching

- When using `Effect.request` + `RequestResolver.makeBatched`, the batching scheduler must be explicitly enabled. Add `Effect.withRequestBatching(true)` to the top-level daemon program in `daemon-main.ts`. Without this, individual `Effect.request` calls resolve one-at-a-time, defeating the purpose of batched resolvers.
- Provide resolvers via `Layer` using `RequestResolver.toLayer(resolver)` — do NOT wrap in `Layer.succeed`.
- `RequestResolver.toLayer(resolver)` returns a Layer that satisfies the resolver's context requirement. Compose it into the daemon Layer stack.
- **AUDIT FIX (M-R5-5):** For requests that tolerate staleness (e.g., session list polling), use `Effect.withRequestCaching(true)` alongside batching. This deduplicates identical concurrent `Effect.request` calls — if two fibers both request `GetSessions` for the same instance within the same batch window, only one HTTP call is made. Add to `daemon-main.ts` alongside `withRequestBatching`:
  ```typescript
  yield* Effect.withRequestBatching(true)(
    Effect.withRequestCaching(true)(
      runStartupSequence
    )
  );
  ```

## Integration with Existing Branch Modules

The feature branch already has 5 Effect modules (`services.ts`, `layers.ts`, `daemon-layers.ts`, `resource.ts`, `retry-fetch.ts`) with 27 Context.Tags, bridge Layers, and daemon lifecycle wiring.

**New modules created by this plan integrate as follows:**
- `daemon-state.ts` (Task 1) adds `DaemonStateTag` to `services.ts` — a new Tag, not replacing an existing one.
- `daemon-config-persistence.ts` (Task 2) adds `PersistencePathTag` — new Tag.
- `daemon-startup.ts` (Task 3) adds `CrashCounterTag` — new Tag.
- `relay-cache.ts` (Task 4) adds `RelayCacheTag` — replaces the bridge Layer for `ProjectRegistryTag` in `layers.ts`.
- `daemon-layers.ts` (Task 5) MODIFIES the existing `daemon-layers.ts` to compose new Layers alongside existing ones. The executing agent MUST read the existing file first and add to it, not replace it.
- Tasks 9-18 create new service modules that are wired into `daemon-layers.ts` in Task 19.
- Phase 3 Task 20 replaces bridge Layers in `layers.ts` with the new Effect-native modules.

**Critical:** The existing `layers.ts` `makeHandlerLayer()` function uses `Layer.succeed(Tag, imperativeInstance)` for each service. During Phase 3 consumer conversion, each bridge is replaced by the Effect-native Layer from Phases 1-2. The executing agent must update `makeHandlerLayer()` incrementally — one service at a time — and run `pnpm check` after each replacement.

## Branch Context

All work happens on `feature/effect-ts-migration` (worktree at `.worktrees/effect-ts-migration/`). On this branch:
- `TrackedService` and `AsyncTracker` are already deleted (commit `a70d53b`).
- EventEmitter removed from ProjectRegistry (commit `8998b4e`), ws-handler (commit `00734af`).
- Classes use typed callback maps (not EventEmitter).
- All 27 Context.Tags defined in `src/lib/effect/services.ts`.
- Bridge Layers in `src/lib/effect/layers.ts`.
- `IPCCommandSchema` (19-command Schema.Union with `cmd` discriminant) in `src/lib/daemon/ipc-protocol.ts`.
- Daemon class has **47 fields** (verified 2026-04-26): 5 config, 5 server refs, 5 manager refs, 4 background service refs, 5 daemon state, 8 config fields, 2 signal handlers, 1 pending work, plus methods. The `DaemonState` interface in Task 1 captures the persisted + runtime-observable subset; the rest are handled by individual service Layers.
