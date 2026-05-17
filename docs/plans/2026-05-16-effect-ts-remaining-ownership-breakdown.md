# Remaining Effect Ownership Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the remaining Effect-compatible but not Effect-owned runtime surfaces to idiomatic Effect services, starting with the Claude adapter/translator path, and record the full remaining migration inventory.

**Architecture:** Keep the closed May 15 guardrails closed: one daemon runtime, per-project relay scope, WebSocket transport, typed contracts, and no app-internal runtime escape hatches. The next migration pass is narrower: replace class-owned mutable state, Promise/callback loops, and compatibility shells with scoped `Layer` services, `Ref`, `Queue`, `Deferred`, `FiberMap`, `Stream`, typed errors, and explicit external adapters only at SDK, Node, browser, and public Promise boundaries.

**Tech Stack:** `effect 3.x`, `@effect/platform`, `@effect/sql`, `@effect/rpc`, `@effect/vitest`, Svelte 5, Node.js, SQLite, Claude Agent SDK, OpenCode SDK.

---

## Status

The mainline guardrail checklist in `docs/plans/2026-05-14-effect-ts-mainline-live-progress.md` is closed. Do not reopen it just because a file still uses a class internally. This document tracks the stricter ownership level:

- **Effect-returning:** a public method returns `Effect`, but state/lifecycle may still live in a class.
- **Effect-compatible:** a class is acquired by a `Layer`, has finalizers, and exposes Effect methods, but the class still owns mutable state.
- **Effect-owned:** state and lifecycle are owned by Effect services/layers, with mutable state in `Ref`, `Queue`, `Deferred`, `FiberMap`, `PubSub`, `Stream`, or scoped resources.

The current codebase has many Effect-owned domains already. The remaining work is mostly converting Effect-compatible classes and public compatibility shells.

## Audit Inputs

Live checkout:

- Branch: `main`
- CWD: `/Users/dstern/src/personal/conduit`
- Date: 2026-05-16

Docs read:

- `docs/agent-guide/architecture.md`
- `docs/plans/2026-05-11-effect-ts-mainline-completion-plan.md`
- `docs/plans/2026-05-14-effect-ts-mainline-live-progress.md`
- `docs/plans/effect-ts-next-wave/phase-7-remaining-migration.md`
- `docs/plans/2026-05-15-provider-boundary-runtime-schemas.md` (untracked at audit time; related provider-boundary plan)

Static audit commands used:

```bash
rg -n "Effect\.run(Promise|Sync)|Runtime\.run(Promise|Sync)|ManagedRuntime|\.runPromise\(|\.runSync\(|Effect\.promise\(" src/lib -g '*.ts'
rg -n "Layer\.succeed\(" src/lib -g '*.ts'
rg -n "^export class |^class |^export function create|^export async function|async function|new Promise|setInterval|setTimeout|EventEmitter|extends EventEmitter" src/lib/{daemon,relay,instance,session,persistence,provider,server,handlers,domain} -g '*.ts'
rg -n "bridge|compat|imperative|Effect-owned|not yet|TODO|FIXME|Layer\.succeed|ManagedRuntime|EventEmitter|setInterval|setTimeout|new Promise" src/lib docs/plans/2026-05-14-effect-ts-mainline-live-progress.md -g '*.ts' -g '*.md'
```

## Current Boundary Classification

### Accepted External Boundaries

Keep these as Promise/callback edges unless a specific product need says otherwise:

- `src/lib/instance/sdk-factory.ts`: OpenCode SDK `fetch` adapter boundary.
- `src/lib/provider/claude/claude-permission-bridge.ts`: SDK `canUseTool` callback must return a Promise, but its core logic should move into Effect.
- `src/lib/frontend/transport/runtime.ts`: frontend Promise API for Svelte callers.
- `src/lib/relay/relay-stack.ts`: public `createProjectRelay()` Promise startup API.
- Node HTTP, Node IPC, WebSocket, browser event, service worker, clipboard, and CLI prompt callbacks.

### Explicit Non-Targets

Do not migrate these just to make greps quieter:

- Svelte `$state` stores and local UI timers.
- Pure functions, schema/type modules, markdown/diff/render helpers, and static frontend utilities.
- SDK wrapper classes where the class is just the external SDK facade, unless Conduit-owned state is mixed into that wrapper.
- CLI interactive menus and setup prompts. These are command-line UI, not long-lived app state.

## Remaining Migration Inventory

### 1. Claude Provider Runtime, Translator, Permission Bridge, Capabilities

**Priority:** P0. This is the next highest-value slice because recent regressions landed here and the current shape is only partially Effect-owned.

**Files:**

- `src/lib/provider/claude/claude-provider-instance.ts`
- `src/lib/provider/claude/claude-event-translator.ts`
- `src/lib/provider/claude/claude-permission-bridge.ts`
- `src/lib/provider/claude/claude-capabilities-probe.ts`
- `src/lib/provider/claude/ttl-cache.ts`
- `src/lib/provider/claude/effect-prompt-queue.ts`
- Tests under `test/unit/provider/claude/*`

**Current shape:**

- `ClaudeProviderInstance` implements `ProviderInstance` and returns `Effect`, but owns session state in class fields: `sessions`, `sessionLocks`, `turnDeferredQueues`, `endedSessionStreams`, and `permissionBridge`.
- SDK stream consumption is an `async runStreamConsumer(...)` loop stored as `ctx.streamConsumer: Promise<void>`.
- `ClaudeEventTranslator` is a mutable class with `currentAssistantMessageId`, `partIdCounter`, `async translate(...)`, `async flushPendingTools(...)`, and a Promise bridge through `runEffect`.
- `ClaudePermissionBridge` is a class whose core `_handlePermission(...)` is async/Promise based because the SDK callback is Promise based.
- Capability probing is Promise/global-cache based through `TTLCache` and `getCachedClaudeCapabilities(...)`.
- `EffectPromptQueue` is mostly good: it uses Effect `Queue` and `Stream.toAsyncIterableEffect`; only the SDK-facing AsyncIterator boundary must remain Promise-shaped.

**Target shape:**

- Add `ClaudeProviderRuntimeTag` and `ClaudeProviderRuntimeLive`.
- Move provider session state into a runtime service:
  - `Ref<HashMap<string, ClaudeSessionState>>` for sessions.
  - `Ref<HashMap<string, Deferred.Deferred<void, ClaudeProviderError>>>` or a per-session lock helper for setup locks.
  - `Ref<HashMap<string, Chunk<Deferred.Deferred<TurnResult, ClaudeProviderError>>>>` for turn waiters.
  - `FiberMap<string>` for active SDK stream consumers.
  - `Clock` for timestamps instead of `new Date()` inside Effect programs.
- Keep a thin `ClaudeProviderInstance` facade only if `ProviderInstance` still requires a class. The facade should delegate every method to `ClaudeProviderRuntime`.
- Convert stream consumption to an Effect fiber:
  - Convert the SDK `AsyncIterable<unknown>` to a `Stream` or an `Effect.async` loop.
  - Decode provider envelopes before translation, using the provider-boundary schema plan.
  - Run translator effects inside the same fiber.
  - Finalize by marking stream ended and rejecting pending turn waiters.
  - Interrupting the fiber should abort the SDK query and close the prompt queue.
- Convert `ClaudeEventTranslator` into either:
  - a pure translator returning `readonly CanonicalEvent[]`, plus an Effect shell that pushes events, or
  - `ClaudeTranslationService` with translator state in a `Ref`.
- Convert `ClaudePermissionBridge` into:
  - `ClaudePermissionService.requestToolPermission(...)` returning `Effect<PermissionResult, ClaudePermissionError, ...>`.
  - a tiny `toSdkCanUseTool(ctx)` adapter that calls `Effect.runPromise` only at the SDK callback boundary.
  - abort/interrupt modeled with Effect interruption or `Effect.race`, not hand-rolled `new Promise` racing except at the SDK callback adapter.
- Convert capabilities into `ClaudeCapabilitiesService`:
  - Layer-owned TTL state keyed by workspace root.
  - `Clock`-based expiry.
  - in-flight dedupe via `Deferred` in a `Ref` or `FiberMap`.
  - SDK probe wrapped in `Effect.tryPromise`.

**Test plan:**

- Add `@effect/vitest` tests for the runtime service before changing the facade.
- Cover concurrent `sendTurn` for the same session, stopped-session resume, agent switch restart, stream-error turn rejection, shutdown interruption, permission approval suggestions, question answers, and capability cache in-flight dedupe.
- Keep existing provider-instance tests green by delegating the class facade to the service.
- Run:

```bash
pnpm vitest run test/unit/provider/claude
pnpm check
```

**Exit criteria:**

- No class field in `claude-provider-instance.ts` owns live session state.
- `ClaudeEventTranslator` no longer calls a Promise-shaped `runEffect`.
- Only the SDK callback adapter uses `Effect.runPromise`.
- Capability cache is Layer-owned and testable with `TestClock`.

### 2. Provider Orchestration And Provider Registry

**Priority:** P1. This should follow the Claude slice, because Claude runtime changes are easier if orchestration remains stable.

**Files:**

- `src/lib/provider/orchestration-engine.ts`
- `src/lib/provider/orchestration-wiring.ts`
- `src/lib/provider/provider-registry.ts`
- `src/lib/provider/opencode-provider-instance.ts`
- `src/lib/provider/event-sink.ts`
- `src/lib/domain/relay/Services/services.ts`

**Current shape:**

- `ProviderRegistry` is a mutable class around `Map<string, ProviderInstance>`.
- `OrchestrationEngine` is a class around `sessionBindings` and `processedCommands`; it uses `Ref.unsafeMake` for command dedupe but class fields for the rest.
- `createOrchestrationLayer(...)` still exposes an imperative compatibility view for tests/compat surfaces.
- `OpenCodeProviderInstance` returns `Effect` but owns `pendingTurns` in a class `Map`.
- `EventSinkImpl` still depends on raw `EventStore` / `ProjectionRunner` classes and appears to be a legacy path; production Claude uses `createRelayEventSink`.

**Target shape:**

- Introduce `ProviderRegistryService`:
  - `register`, `get`, `remove`, `list`, and `shutdownAll` as Effect methods.
  - Registry state in `Ref<HashMap<string, ProviderInstance>>`.
- Replace `OrchestrationEngine` class with `OrchestrationService`:
  - `sessionBindings` in `Ref<HashMap<string, ProviderId>>`.
  - `processedCommands` in bounded `Ref<HashSet<string>>` or a small LRU service.
  - command handlers as plain Effect functions.
- Convert `OpenCodeProviderInstance` to the same runtime pattern as Claude:
  - pending turns in a `Ref<HashMap<SessionId, Deferred<TurnResult, Error>>>`.
  - abort handling with `Effect.acquireRelease` or `Effect.async`.
  - keep `notifyTurnCompleted` as a narrow SSE callback adapter until SSE is Effect-owned.
- Delete or quarantine `EventSinkImpl` if no production path uses it. If tests still need it, port it to Effect persistence services or move it under test helpers.

**Test plan:**

- `test/unit/provider/orchestration-engine.test.ts` should become service-level tests with test Layers.
- Add a regression test proving duplicate command handling and provider session binding survive the service conversion.
- Run:

```bash
pnpm vitest run test/unit/provider
pnpm vitest run test/unit/handlers/permissions.test.ts test/unit/handlers/prompt-provider-state-effect.test.ts
pnpm check
```

**Exit criteria:**

- `new ProviderRegistry`, `new OrchestrationEngine`, and `Ref.unsafeMake` are gone from production provider orchestration.
- `createOrchestrationLayer(...)` is deleted or test-only.
- OpenCode pending-turn state is Effect-owned.

### 3. OpenCode SSE, Message Polling, PTY, And WebSocket Handler Shells

**Priority:** P1/P2. These are runtime-heavy but already have partial Effect replacements.

**Files:**

- `src/lib/relay/sse-stream.ts`
- `src/lib/domain/relay/Services/sse-stream.ts`
- `src/lib/domain/relay/Services/sse-stream-service.ts`
- `src/lib/relay/message-poller-impl.ts`
- `src/lib/domain/relay/Services/message-poller.ts`
- `src/lib/domain/relay/Layers/message-poller-manager-layer.ts`
- `src/lib/relay/pty-manager.ts`
- `src/lib/domain/relay/Services/pty-manager-service.ts`
- `src/lib/domain/relay/Layers/pty-manager-layer.ts`
- `src/lib/server/effect-ws-handler.ts`
- `src/lib/domain/relay/Services/ws-handler-service.ts`
- `src/lib/domain/relay/Layers/websocket-handler-layer.ts`

**Current shape:**

- `domain/relay/Services/sse-stream.ts` already has an Effect `Stream` implementation, but production `SSEStreamLive` still constructs the imperative `relay/sse-stream.ts` class.
- `domain/relay/Services/message-poller.ts` has a FiberMap-based poller service, but production `makeMessagePollerManagerLive` still constructs `new MessagePollerManager(...)`.
- `domain/relay/Services/pty-manager-service.ts` has Effect-owned PTY state helpers, but production `PtyManagerLive` still constructs `new PtyManager(...)`.
- `domain/relay/Services/ws-handler-service.ts` owns client state in a `Ref`, but `EffectWsHandler` still owns an `EventEmitter`, `Set`, `Map`, and heartbeat fiber in a class. The comments explicitly say heartbeat remains in the imperative layer.

**Target shape:**

- Wire the Effect SSE `Stream` implementation into production:
  - `SSEStreamTag` should expose Effect stream operations, not an imperative class port.
  - `wireSSEConsumerEffect` should consume the stream directly.
  - Keep only a tiny adapter for OpenCode SDK event source details if needed.
- Replace `MessagePollerManager` production wiring with `PollerManagerStateTag` / `FiberMap` service:
  - expose `start`, `stop`, `drain`, and `isActive`.
  - remove the old class from production and keep old tests only until parity is proven.
- Move `PtyManager` session state and lifecycle into `PtyManagerStateTag` plus scoped fibers:
  - shell process lifetime and websocket upstream remain external resources.
  - `closeAll` becomes scope finalization.
- Move `EffectWsHandler` heartbeat and client maps into `WsHandlerStateTag`:
  - class may remain only as the `ws` package callback adapter.
  - the adapter should not own business state.
  - heartbeat should be a scoped fiber, not constructor-started class state.

**Test plan:**

- First add production wiring tests proving the Effect replacements are actually used.
- Then port existing unit behavior from old class tests to service tests.
- Run:

```bash
pnpm vitest run test/unit/relay/sse-stream.test.ts test/unit/effect/message-poller-manager-layer.test.ts test/unit/effect/pty-manager-layer.test.ts
pnpm vitest run test/unit/server test/integration/flows/ws-handler-coverage.integration.ts
pnpm check
```

**Exit criteria:**

- Production `SSEStreamLive`, `makeMessagePollerManagerLive`, and `PtyManagerLive` do not instantiate old runtime classes.
- `EffectWsHandler` owns only external `ws` callback attachment, not relay state.
- Existing raw terminal data-plane behavior is preserved.

### 4. Persistence Runtime Cleanup

**Priority:** P2. Production already uses `makePersistenceEffectLayer`, so this is cleanup and stricter ownership, not a guardrail blocker.

**Files:**

- `src/lib/persistence/effect/live.ts`
- `src/lib/persistence/effect/projection-runner-effect.ts`
- `src/lib/persistence/effect/dual-write-hook-effect.ts`
- `src/lib/persistence/canonical-event-translator.ts`
- Legacy modules:
  - `src/lib/persistence/event-store.ts`
  - `src/lib/persistence/projection-runner.ts`
  - `src/lib/persistence/persistence-layer.ts`
  - `src/lib/persistence/read-query-service.ts`
  - `src/lib/persistence/provider-state-service.ts`
  - `src/lib/persistence/dual-write-hook.ts`

**Current shape:**

- Production relay uses `makePersistenceEffectLayer(config.persistenceDbPath)`.
- Legacy raw SQLite persistence classes still exist, mostly for tests and historical paths.
- `ProjectionRunnerEffect` still keeps mutable `failures`, `recovered`, and `replaying` closure variables instead of `Ref`.
- `EffectDualWriteHook` is an Effect-flavored class with mutable stats and a `setInterval` stats logger.
- `CanonicalEventTranslator` is a mutable class with per-session part tracking.

**Target shape:**

- Move `ProjectionRunnerEffect` state into `Ref` and `Clock`:
  - `failures: Ref<Chunk<ProjectionFailure>>`
  - `recovered: Ref<boolean>`
  - `replaying: Ref<boolean>`
  - use `Clock.currentTimeMillis` instead of `Date.now`.
- Replace `EffectDualWriteHook` class with `DualWriteService`:
  - stats in `Ref`.
  - stats logging as an optional scoped repeating fiber with `Schedule.spaced`.
  - translator/seeder state either pure per-stream state or `Ref`.
- Decide the fate of legacy raw persistence modules:
  - If no production imports remain, mark them as legacy test fixtures or migrate tests to Effect services and delete.
  - Keep only one persistence implementation in production docs.
- Convert `CanonicalEventTranslator` only if it remains production-critical after SSE stream conversion. If it is purely a stateful translator, make state explicit so replay/reset behavior is testable without a class.

**Test plan:**

- Migrate one representative test from each legacy class to the Effect service before deleting legacy code.
- Add `TestClock` tests for stats logging and projection failure timestamps.
- Run:

```bash
pnpm vitest run test/unit/persistence test/unit/persistence/effect-dual-write-hook.test.ts
pnpm vitest run test/unit/effect/session-manager-service.test.ts
pnpm check
```

**Exit criteria:**

- Production persistence has no class-owned mutable state except pure external adapters.
- Legacy raw SQLite classes are either deleted or explicitly isolated as test-only compatibility.

### 5. Relay Startup And Standalone Multi-Project Relay Shell

**Priority:** P2. This is a public compatibility area; do not change behavior casually.

**Files:**

- `src/lib/relay/relay-stack.ts`
- `src/lib/domain/daemon/Layers/relay-factory-layer.ts`
- `src/lib/domain/daemon/Services/relay-cache.ts`
- `src/lib/domain/relay/Layers/*`

**Current shape:**

- `createProjectRelay(config): Promise<ProjectRelay>` is still the public Promise boundary and creates a per-relay `ManagedRuntime`.
- The startup effect inside `createProjectRelay` is well-contained, but the function still has local mutable variables such as `wsHandler`, `relayManagedRuntime`, `startup`, `stopMonitoring`, and `defaultCommandQueue`.
- `createRelayStack(config): Promise<RelayStack>` remains a standalone, multi-project compatibility shell that directly constructs `EffectRelayServer`, push manager, maps of relays, and pending slug sets.
- `EffectRelayServer` is still a class shell around HTTP server behavior.

**Target shape:**

- Keep `createProjectRelay` as the public Promise adapter, but move internals into `ProjectRelayLive(config)`:
  - one Layer constructs startup, runtime resources, command queue, monitoring wiring, and shutdown finalizers.
  - public function becomes `ManagedRuntime.make(...).runPromise(ProjectRelayTag)` plus dispose adapter.
- Convert `RelayDefaultCommandQueue` to a scoped queue service or fold it into `RelayCommandGate`.
- Convert `createRelayStack` to use daemon/relay services or mark it deprecated if foreground daemon is now the canonical multi-project path.
- Decide whether `EffectRelayServer` remains a standalone adapter or moves into `domain/server/Layers/http-server-layer.ts`.

**Test plan:**

- Preserve existing daemon/relay integration tests before moving the shell.
- Add static guards so `createProjectRelay` remains the only relay runtime startup Promise boundary.
- Run:

```bash
pnpm vitest run test/unit/relay test/integration/daemon/daemon-server.test.ts
pnpm test:contract
pnpm check
```

**Exit criteria:**

- Relay startup state is Layer-owned.
- `createRelayStack` is either Effect-backed or documented as deprecated compatibility.
- No new app-internal `ManagedRuntime` usage appears outside public startup adapters.

### 6. Daemon Lifecycle And Foreground Compatibility Shell

**Priority:** P2/P3. The daemon graph is Effect-owned, but Node server lifecycle helpers remain Promise/callback based.

**Files:**

- `src/lib/daemon/daemon-lifecycle.ts`
- `src/lib/domain/daemon/Services/daemon-lifecycle-context.ts`
- `src/lib/domain/daemon/Layers/daemon-layers.ts`
- `src/lib/domain/daemon/Layers/daemon-foreground.ts`
- `src/lib/domain/daemon/Layers/daemon-main.ts`
- `src/lib/domain/server/Layers/http-server-layer.ts`
- `src/lib/domain/server/Layers/ws-routing-layer.ts`

**Current shape:**

- `daemon-lifecycle.ts` still owns low-level HTTP, HTTPS, IPC, onboarding server, and socket lifecycle helpers with `new Promise`, Node callbacks, and mutable `DaemonLifecycleContext`.
- `DaemonLifecycleContextLive` provides a mutable object into the Layer graph.
- `startForegroundDaemon(...)` is an async compatibility facade with local cached snapshots and a `ManagedRuntime`.
- `makeDaemonLive(...)` is Effect-composed, but still includes no-op `Layer.succeed(...)` stubs for optional background services when omitted.

**Target shape:**

- Move each low-level server helper behind scoped services:
  - `HttpServerLive` owns listen/close with `Effect.async` / `Effect.acquireRelease`.
  - `IpcServerLive` owns Unix socket lifecycle and dispatch fibers.
  - `OnboardingServerLive` owns onboarding server lifecycle.
- Replace mutable `DaemonLifecycleContext` with narrower service refs:
  - `HttpServerRefTag`
  - `IpcServerRefTag`
  - `OnboardingServerRefTag`
  - client count / socket client state in `Ref`.
- Keep `startForegroundDaemon` as a public Promise facade, but make snapshot refresh use a single Effect handle method instead of local async cache choreography where practical.
- No-op optional background services can stay as `Layer.succeed` values if they are pure service implementations, not prebuilt imperative instances. Record this distinction in the guard.

**Test plan:**

- Move daemon lifecycle tests from direct helper calls to service-layer tests gradually.
- Keep TLS and IPC integration tests unchanged until the service behavior is proven.
- Run:

```bash
pnpm vitest run test/unit/effect/http-server-live.test.ts test/unit/daemon/daemon-onboarding.test.ts
pnpm vitest run test/integration/daemon/daemon-tls.test.ts test/integration/daemon/daemon-server.test.ts
pnpm check
```

**Exit criteria:**

- `DaemonLifecycleContext` is no longer a broad mutable context object.
- Node server lifecycle is acquired and released by scoped Layers.
- Foreground facade remains the only Promise compatibility edge for CLI callers.

### 7. HTTP, WebSocket RPC, And Frontend Transport Boundary

**Priority:** P3. Most of this is acceptable boundary code; only internal state should be tightened.

**Files:**

- `src/lib/server/effect-ws-handler.ts`
- `src/lib/server/ws-rpc-handler.ts`
- `src/lib/server/effect-http-router.ts`
- `src/lib/domain/server/Layers/http-router-layer.ts`
- `src/lib/frontend/transport/runtime.ts`
- `src/lib/frontend/transport/ws-rpc-client.ts`
- `src/lib/frontend/stores/ws.svelte.ts`
- `src/lib/frontend/stores/ws-dispatch.ts`

**Current shape:**

- `WsRpcWebSocketHandler` stores a relay `ManagedRuntime` because RPC calls enter from WebSocket callbacks.
- `EffectWsHandler` is still the larger class shell discussed above.
- Frontend RPC functions expose Promise-returning wrappers over Effect transport, which is appropriate for Svelte callers.
- Some non-RPC frontend status/theme/push paths still use `fetch`.
- Frontend stores use timers and local mutable state.

**Target shape:**

- Keep frontend Promise wrappers; they are the UI boundary.
- Keep WebSocket callback adapters, but move handler state into Effect services.
- Gradually route remaining direct frontend `fetch` calls through typed RPC only when they are durable app operations. Do not migrate theme/status probes solely for purity.
- Do not put Svelte local UI state into Effect.

**Test plan:**

- Static guard remains the main protection for runtime bridges.
- Add frontend transport tests only when changing transport APIs.
- Run:

```bash
pnpm vitest run test/unit/frontend test/unit/server
pnpm check
```

**Exit criteria:**

- Callback adapters are thin.
- Browser app state remains idiomatic Svelte.
- No duplicate runtime ownership appears in server or frontend transport.

### 8. Legacy Daemon, Instance, Session, And Persistence Classes

**Priority:** P3 cleanup. These are mostly superseded or test-only, but the codebase still carries them.

**Files to classify:**

- `src/lib/session/session-manager.ts`
- `src/lib/session/session-registry.ts`
- `src/lib/instance/instance-manager.ts`
- `src/lib/daemon/project-registry.ts`
- `src/lib/daemon/keep-awake.ts`
- `src/lib/daemon/version-check.ts`
- `src/lib/daemon/storage-monitor.ts`
- `src/lib/daemon/port-scanner.ts`
- legacy persistence files listed in Phase 4

**Current shape:**

- Many old class tests still instantiate these classes directly.
- Production often uses Effect replacements, but some old modules remain for compatibility, helper behavior, or tests.
- Some old daemon/instance classes have typed errors and are still useful as behavior references.

**Target shape:**

- For each class, classify one of:
  - **Delete:** no production imports and Effect tests cover the behavior.
  - **Test fixture only:** move under `test/helpers` or mark with explicit comments and import guards.
  - **External adapter:** keep in `src/lib/*` because it wraps a third-party or Node API and is intentionally not Effect-owned internally.
  - **Still production:** create a specific migration task.
- Port tests before deletion. Do not delete behavior coverage.

**Suggested deletion audit:**

```bash
rg -n "new SessionManager|new SessionRegistry|new InstanceManager|new ProjectRegistry|new KeepAwake|new VersionChecker|new StorageMonitor|new PortScanner" src test -g '*.ts'
rg -n "from .*session-manager|from .*instance-manager|from .*project-registry|from .*port-scanner|from .*storage-monitor|from .*version-check|from .*keep-awake" src test -g '*.ts'
```

**Exit criteria:**

- Superseded classes are either deleted or visibly isolated.
- Production code does not import old class modules except for explicit external adapters.

## Recommended Execution Order

1. **Provider schema boundary first or in parallel.** Implement `docs/plans/2026-05-15-provider-boundary-runtime-schemas.md` before deep provider rewrites if possible. Runtime decoding reduces risk when provider internals are refactored.
2. **Claude provider ownership.** Convert Claude runtime, translator, permission bridge, and capabilities service.
3. **Provider orchestration ownership.** Convert registry/engine/OpenCode pending-turn state after Claude stabilizes.
4. **OpenCode stream/poller/PTY ownership.** Wire existing Effect replacements into production one surface at a time.
5. **Persistence stricter ownership.** Convert remaining class-flavored Effect persistence helpers and delete raw SQLite legacy paths where possible.
6. **Relay startup shell.** Move `createProjectRelay` internals behind a Layer while preserving the public Promise API.
7. **Daemon lifecycle shell.** Narrow `DaemonLifecycleContext` into scoped server services.
8. **Server/frontend boundary cleanup.** Thin WebSocket classes and leave Svelte-local state alone.
9. **Legacy class deletion.** Remove or isolate superseded modules and add static guards.

## Claude Slice: Detailed Implementation Plan

### Task 1: Add Runtime Service Skeleton

**Files:**

- Create: `src/lib/provider/claude/claude-provider-runtime.ts`
- Modify: `src/lib/provider/claude/index.ts`
- Test: `test/unit/provider/claude/claude-provider-runtime.test.ts`

**Steps:**

1. Define `ClaudeProviderRuntimeTag`.
2. Define the service interface with the same operations as `ProviderInstance`.
3. Add `ClaudeProviderRuntimeLive(deps)` with empty state refs and no behavior change yet.
4. Write a service construction test proving refs/fibers are scoped and shutdown is idempotent.
5. Run the new test.

### Task 2: Move Session State Into The Runtime

**Files:**

- Modify: `src/lib/provider/claude/claude-provider-runtime.ts`
- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Test: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`

**Steps:**

1. Move `sessions`, `sessionLocks`, `turnDeferredQueues`, and `endedSessionStreams` into runtime refs.
2. Keep existing method names but delegate through the runtime.
3. Preserve stopped-session resume behavior.
4. Run Claude send-turn tests.

### Task 3: Convert Stream Consumer To Fiber

**Files:**

- Modify: `src/lib/provider/claude/claude-provider-runtime.ts`
- Modify: `src/lib/provider/claude/types.ts`
- Test: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`

**Steps:**

1. Store stream consumers in `FiberMap`.
2. Replace `ctx.streamConsumer: Promise<void>` with a fiber identity or remove it.
3. Convert `for await` loop into an Effect-owned stream/fiber.
4. Ensure finalization rejects pending turn waiters and closes prompt queues.
5. Run stream/error/reload tests.

### Task 4: Convert Translator

**Files:**

- Modify: `src/lib/provider/claude/claude-event-translator.ts`
- Modify: `src/lib/provider/claude/claude-provider-runtime.ts`
- Test: `test/unit/provider/claude/claude-event-translator.test.ts`

**Steps:**

1. Introduce explicit translator state type.
2. Make translation return events or an Effect that pushes events without a Promise bridge.
3. Move `currentAssistantMessageId` and `partIdCounter` into service/session state.
4. Preserve thinking, TodoWrite, tool result, task progress, and result translation tests.

### Task 5: Convert Permission Bridge Core

**Files:**

- Modify: `src/lib/provider/claude/claude-permission-bridge.ts`
- Modify: `src/lib/provider/claude/claude-provider-runtime.ts`
- Test: `test/unit/provider/claude/claude-permission-bridge.test.ts`

**Steps:**

1. Extract an Effect-returning permission/question handler.
2. Leave a tiny SDK callback adapter that runs the Effect at the SDK boundary.
3. Preserve SDK `updatedPermissions` suggestions exactly.
4. Preserve `AskUserQuestion` updated input behavior.
5. Run permission bridge tests.

### Task 6: Convert Capabilities Cache

**Files:**

- Modify or replace: `src/lib/provider/claude/claude-capabilities-probe.ts`
- Modify or delete: `src/lib/provider/claude/ttl-cache.ts`
- Test: `test/unit/provider/claude/claude-capabilities-probe.test.ts`

**Steps:**

1. Add `ClaudeCapabilitiesService`.
2. Move TTL state into `Ref`.
3. Use `Clock` for expiry.
4. Use `Deferred` for in-flight dedupe.
5. Keep test override helpers only if tests cannot use Layers directly.

### Task 7: Collapse Facade And Add Guards

**Files:**

- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Modify: `test/unit/effect/runtime-boundary-grep.test.ts`
- Test: all focused Claude tests.

**Steps:**

1. Reduce `ClaudeProviderInstance` to a facade or replace it with a record created by `ClaudeDriver`.
2. Add static guards preventing class-owned session maps and Promise stream consumers from returning.
3. Run:

```bash
pnpm vitest run test/unit/provider/claude
pnpm check
pnpm lint
```

## Static Guard Updates

After each phase, add or update guards for only the thing removed. Avoid broad grep bans that would block legitimate external adapters.

Suggested new guards:

- `claude-provider-instance.ts` must not contain `sessions = new Map`, `sessionLocks = new Map`, `turnDeferredQueues = new Map`, or `private async runStreamConsumer`.
- `claude-event-translator.ts` must not expose `async translate`.
- `claude-permission-bridge.ts` may contain `Effect.runPromise` only in the named SDK callback adapter.
- Production `SSEStreamLive` must not instantiate `new SSEStream`.
- Production `MessagePollerManagerLive` must not instantiate `new MessagePollerManager`.
- Production `PtyManagerLive` must not instantiate `new PtyManager`.
- Production persistence should not import `persistence-layer.ts`, `event-store.ts`, or `projection-runner.ts`.

## Validation Strategy

Use narrow verification per slice.

Minimum for docs-only changes:

```bash
git diff --check
```

Minimum for each implementation slice:

```bash
pnpm check
pnpm lint
pnpm vitest run <focused-tests>
```

Widen when the slice touches relay startup, daemon lifecycle, persistence, or WebSocket routing:

```bash
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

## Open Questions

- Should `createRelayStack(...)` remain a supported standalone multi-project API, or is foreground daemon now the canonical multi-project entrypoint?
- Should legacy raw persistence tests be ported to Effect services before deleting raw classes, or should a smaller compatibility fixture remain for migration confidence?
- Should `ProviderInstance` remain a class-friendly interface, or should providers become plain Effect service records created by driver values?
- Should the provider schema boundary plan be completed before any Claude runtime refactor starts? Recommendation: yes for inbound stream messages and outbound user messages.
