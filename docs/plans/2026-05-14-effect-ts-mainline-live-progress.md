# Effect.ts Mainline Live Progress

Current source of truth for the remaining Effect.ts mainline completion work.

Historical log: `docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md`.

Plan: `docs/plans/2026-05-11-effect-ts-mainline-completion-plan.md`.

Updated: 2026-05-14.

## Update Rules

- Keep this file concise. Do not paste full command logs unless the exact output is the decision evidence.
- Prefer one-line status updates with links to commits, test files, or historical progress sections.
- Keep the old progress doc as append-only history except for banners or index notes.
- If this file grows past roughly 300 lines, archive completed details into a new historical note and keep only live state here.

## Accepted Decisions

- Finish the current migration on Effect 3.x. Effect v4 and `effect/unstable/*` are post-migration work.
- Keep one production daemon owner. Do not add `--daemon-runtime=effect|legacy`.
- Keep per-project relays as deployment, scope, routing, and lifecycle units.
- Adopt command/event/projector/read-model inside each relay now, not later.
- Use a move-only domain organization PR before larger semantic rewrites.
- Use strict `src/lib/contracts/*` for shared schemas, domain protocol declarations, and RPC groups. Do not introduce `packages/contracts/*` in this plan.
- Keep WebSocket as the real-time browser transport. Migrate browser/server operations to Effect RPC over WS in vertical slices.
- Keep per-browser-tab active project/session/thread state in route/Svelte state, not daemon-global mutable state.
- Provider drivers should be plain values that create scoped `ProviderInstance` records. Only the provider instance registry should be a Context service.
- Implement semantic changes test-first, one observable behavior or contract at a time.

## Guardrail Checklist

Every open item must be removed or explicitly reclassified before the migration can be called complete.

| Guardrail | Status | Live note |
|---|---|---|
| `startDaemonProcess` imported by CLI | Open | Blocked by router, relay, and IPC ownership. Cut over only after branch-local smoke parity. |
| `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition | Done | Recheck before final guardrail close. Production `relay-stack.ts` now composes relay-owned Layers for OpenCode API, config, logger, WebSocket handler, status poller, and instance management. |
| `PersistenceLayer.open(...)` in daemon or relay production paths | Done | Recheck before final guardrail close. |
| `Effect.promise(` on rejectable operations | Done | Recheck before final guardrail close. |
| `concurrency: "unbounded"` on dynamic collections | Done | Recheck before final guardrail close. Fixed-size fanouts need inline justification. |
| Throwing helpers called from Effect programs | Open | Broad grep needs call-path triage; defects and external boundaries can be reclassified. |
| App-internal `Effect.runPromise` / `Effect.runSync` | Open | Daemon HTTP handler construction moved to `src/lib/domain/server/Layers/http-router-layer.ts`; tagged and legacy-format IPC dispatch now use the daemon layer runtime callback boundary at the socket edge, and `daemon-lifecycle.ts` no longer owns a default runtime dispatcher. `daemon-main` no longer waits on project-registry sync or startup acquisition through `ManagedRuntime.runPromise`. Client-init, default-session startup state, relay session-count status, and SSE shutdown no longer build Promise/sync session-service bridges in `relay-stack.ts`; the sole relay-stack `runPromise` is explicitly reclassified as the public `createProjectRelay()` startup boundary. Remaining blockers are final grep hits outside accepted external boundaries. |

## Current Blockers

1. Project relay construction no longer has hidden startup/session/shutdown bridges; the only relay-stack `runPromise` is the explicit `createProjectRelay()` Promise boundary.
2. CLI still imports/calls `startDaemonProcess`.

## Remaining Order

This mirrors the plan's authoritative order. Update this list only when an item is done or re-scoped.

1. Effect version freeze and post-migration v4 record.
2. Domain organization move-only PR. Done locally; pending commit/review.
3. Persistence migration runner alignment. Done locally; pending commit/review. Real production DB dry-run remains required before any persistence consumer switch.
4. Contracts and RPC boundary. Started locally: shared `WsRpcGroup`, import guard, and server/frontend re-export wrappers are in place.
5. Hybrid relay domain model. Started locally: pure relay command/event/read-model, bounded command gate, and bounded sliding relay event bus are in place.
6. Router service ownership and HTTP runtime boundary. Done locally for daemon and standalone relay HTTP handler ownership.
7. Scoped project relay ownership. Started locally: prebuilt relay object injection is gone from `relay-stack.ts`, client init now forks one Effect-owned bootstrap at the WebSocket callback boundary, startup service acquisition and relay callback/monitoring/poller/SSE setup are consolidated into one Effect program, API/WebSocket handler acquisition no longer uses separate startup `runSync` calls, SSE connect/command-gate readiness runs inside startup, SSE shutdown drain and command-gate stop are scoped finalizers, SSE pending question writes use the owned session service surface, SSE pending permission writes run inside the Effect-owned SSE handler, message/status-poller callbacks now use Effect-owned paths, Effect dual-write persistence is created and run inside the relay runtime, status-poller parent-map reads stay inside the poll Effect instead of a layer-local sync runtime bridge, the standalone/E2E default-session API reads the startup snapshot instead of re-entering the session service, daemon/router session counts read a relay status snapshot instead of a sync runtime bridge, daemon IPC default-agent/model updates use the `ProjectRelay` public surface, public default-agent/model commands enqueue into the scoped relay command loop instead of re-entering the runtime, the status-poller runtime facade is deleted and `StatusPollerLive` now exposes context-free Effect methods backed by its owned refs/fibers, `EffectWsHandler` is built by its scoped Layer and forks callback work into the relay runtime instead of owning a private `ManagedRuntime`, the RPC WebSocket handler now uses a relay-scoped transport instead of a second private transport runtime, and the sole relay-stack `runPromise` is guarded as the public startup Promise boundary.
8. RPC-over-WS vertical migration. Done locally for ordinary browser operations. `pty_input` is explicitly reclassified as the raw terminal data-plane command until a persistent RPC stream/client design replaces it.
9. Provider driver and instance ownership. Started locally: `ProviderDriver` / `ProviderInstance` / `ProviderCapabilities` / `ProviderInstanceFailure` exist, production orchestration runtime creates `OpenCodeProviderInstance` / `ClaudeProviderInstance` through plain driver values, `ProviderRegistry` now exposes only instance-first APIs, provider implementation/test naming is instance-first, provider wait state now uses Effect `Deferred` for `EventSinkImpl`, OpenCode pending turns, Claude setup locks, and Claude turn queues, the old provider Promise-deferred helper is deleted, and Claude translator sink writes no longer use `Runtime.runPromise`.
10. IPC socket ownership. Done locally pending final recheck: tagged IPC dispatch no longer uses app-internal `Effect.runPromise`, `Runtime.runPromise`, or a `Runtime.defaultRuntime` fallback in `daemon-lifecycle.ts`; legacy cmd-format IPC validates with the old semantics, converts to tagged payloads, and dispatches through the same daemon runtime-owned RPC path.
11. Daemon composition readiness. Started locally: IPC status reads now live on the IPC context instead of passing a separate `DaemonLiveOptions.getStatus` callback through the Layer graph, keep-awake/PIN/shutdown IPC now run through native Effect handlers, restart-config IPC now mutates `DaemonConfigRefTag` natively, legacy ManagedRuntime shutdown/restart scheduling is isolated to the IPC socket post-response hook instead of `DaemonIPCContext`, startup session-count prefetch is owned by `SessionPrefetchLive` instead of a daemon-main fetch loop, daemon startup time is seeded in the initial runtime config instead of a post-start runtime mutation, daemon-main derives the bound HTTP port from the owned server handle instead of reading the runtime config ref after startup, daemon HTTP auth uses the layer-owned `AuthManagerTag` instead of a daemon-main snapshot callback, daemon setup-info reads port/TLS from `DaemonConfigRefTag` inside the router layer instead of daemon-main callbacks, `stop()` no longer performs a separate runtime-config read before applying shutdown state, `DaemonLive` is seeded from the local pre-runtime config snapshot instead of calling the runtime-read helper before the runtime exists, saved config rehydration now updates the local startup snapshot directly before the runtime exists, direct `DaemonHandle.stop()` marks shutdown in the local snapshot instead of re-entering the runtime before disposal, the synchronous daemon runtime-config update bridge is deleted, daemon-main config reads now use the local read model while Effect-owned writes mirror back into it, and daemon-main project-registry sync/startup acquisition now waits through the ManagedRuntime callback/fiber exit API instead of `runPromise`.
12. Single-owner daemon cutover.
13. Final guardrail cleanup.
14. Final docs and verification.

## Verification Commands

Use narrow tests for each slice, then widen at the slice boundary.

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:e2e --grep "session|websocket|project"
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

For docs-only edits, `git diff --check` is sufficient unless the edit changes commands or planned behavior.

## Latest Update

Detailed completed-slice notes moved to `docs/plans/2026-05-14-effect-ts-mainline-live-progress-archive.md`. Keep only live state and the last few current updates here.

2026-05-14, Claude provider translator runtime bridge cleanup:

- Replaced the Claude provider instance translator sink `Runtime.runPromise` bridge with the runtime callback/fiber exit API.
- Added a provider boundary guard preventing `Runtime.runPromise` from returning in `ClaudeProviderInstance`.
- Verified locally with focused Claude provider boundary and send-turn tests.

2026-05-14, daemon IPC runtime Promise bridge cleanup:

- Removed `Runtime.runPromise(runtime)(...)` from daemon IPC socket dispatch.
- The IPC Layer still owns the daemon runtime boundary, but waits through `Runtime.runCallback` so socket responses preserve the existing Promise-shaped lifecycle contract without a `runPromise` re-entry.
- Added a guard preventing daemon IPC dispatch from using `Runtime.runPromise`.
- Verified locally with focused runtime-boundary, daemon IPC, and daemon Layer tests.

2026-05-14, daemon-main runtime Promise bridge cleanup:

- Removed the remaining `ManagedRuntime.runPromise` calls from `daemon-main` project-registry sync and daemon startup acquisition.
- Startup now acquires `DaemonConfigRefTag` through the daemon runtime callback/fiber exit API instead of running a no-op `Effect.void`.
- Added a guard preventing those daemon-main `runPromise` bridges from returning.
- Verified locally with focused runtime-boundary coverage and `pnpm check`.

2026-05-14, RPC WebSocket transport runtime ownership:

- Removed the private RPC WebSocket transport `ManagedRuntime`.
- Added `makeWsRpcWebSocketHandler` so relay startup acquires the RPC transport from the relay runtime and forks upgrade handling through that scoped transport.
- Moved RPC WebSocket drain before relay runtime disposal.
- Verified locally with focused runtime-boundary, per-tab routing, status-poller broadcast, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, Effect WebSocket handler runtime ownership:

- Removed the private `ManagedRuntime` from `EffectWsHandler`; `WebSocketHandlerLive` now supplies the transport and relay-runtime `runFork` bridge.
- Kept the legacy sync `WebSocketHandlerShape` getters backed by an explicit local client/session mirror.
- Added a guard preventing `EffectWsHandler` from reintroducing private `ManagedRuntime`, `runPromise`, or `runSync` bridges.
- Verified locally with focused runtime-boundary, effect-ws-handler, relay layer, and per-tab routing tests.

2026-05-14, daemon runtime config read bridge cleanup:

- Removed the remaining `daemonRuntime.runSync` config-read path from `daemon-main`.
- Added `commitDaemonRuntimeConfig` as the single write path for daemon runtime config mutations; TLS, bound-port, IPC config, session-prefetch, and daemon-main writes now mirror committed values into the local daemon read model.
- Verified locally with focused runtime-boundary and daemon getStatus tests.

2026-05-14, status-poller runtime facade deletion:

- Deleted `StatusPollerRuntime` and the layer-local `Runtime.runSync` / `Runtime.runPromise` bridge.
- `StatusPollerLive` now owns polling, PubSub fanout, immediate poll triggers, SQL-backed reconciliation, and relay `isProcessing` snapshot updates inside its scoped Layer.
- Updated production consumers to yield status-poller Effect methods; legacy Promise-shaped helpers keep narrow sync ports for unit-only compatibility.
- Verified locally with focused status-poller, monitoring, poller, SSE Effect, lifecycle, runtime-boundary tests plus `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, relay default command ownership:

- Replaced `ProjectRelay.setDefaultAgent` / `setDefaultModel` runtime re-entry wrappers with a scoped FIFO command queue processed inside the relay Layer graph.
- Added behavior coverage for public default-agent updates and a guard preventing those methods from calling `effectRuntime.runtime.runPromise`.
- Verified locally with focused relay default override/runtime-boundary tests and diff hygiene checks.

2026-05-14, daemon IPC post-response shutdown cleanup:

- Removed shutdown/restart scheduling from `DaemonIPCContext` and isolated it behind `IpcPostResponseActions`.
- `Shutdown` and `RestartWithConfig` now run only native Effect IPC handlers before the socket response; the socket layer schedules legacy shutdown after a successful response write.
- Verified locally with focused daemon IPC tests, runtime-boundary guard coverage, `pnpm check`, `pnpm lint`, full pre-commit build/lint/test/typecheck, and diff hygiene checks.

2026-05-14, daemon session-prefetch bridge cleanup:

- Deleted the daemon-main startup `/session?limit=10000` fetch loop; `SessionPrefetchLive` is now the only startup session-count prefetch owner.
- Added daemon-state seeded coverage proving `SessionPrefetchLive` reads projects and instances from the same Effect daemon state used in production composition.
- Verified locally with focused scoped-fiber/runtime-boundary/getStatus tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, daemon startup-time bridge cleanup:

- Seeded daemon `startTime` before `DaemonConfigRefTag` is constructed so startup status does not need a post-start runtime mutation.
- Added a runtime-boundary guard preventing the retired `updateRuntimeConfigSync(... startTime: Date.now())` bridge from returning.
- Verified locally with focused runtime-boundary and daemon getStatus tests.

2026-05-14, daemon bound-port bridge cleanup:

- Synchronized the actual bound HTTP port from the owned Node server handle after the daemon Layer starts.
- Removed the post-start runtime-config read used only for TLS logging and `DaemonHandle.port`.
- Verified locally with focused runtime-boundary and daemon getStatus tests.

2026-05-14, daemon HTTP auth bridge cleanup:

- Removed the daemon-main `AuthManager` instance and its `readRuntimeConfigSnapshot().pinHash` callback.
- `makeDaemonHttpRouterLive` now consumes the existing layer-owned `AuthManagerTag`; standalone relay routing still creates its local auth layer.
- Verified locally with focused runtime-boundary, layer-wiring, auth middleware, daemon getStatus, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, daemon setup-info bridge cleanup:

- Changed `SetupInfoProvider` to expose Effectful reads, letting daemon routing read `DaemonConfigRefTag` directly.
- Removed daemon-main `getPort` and `getIsTls` HTTP router callbacks; standalone relay routing keeps callback-backed setup-info.
- Verified locally with focused runtime-boundary, layer-wiring, HTTP router/server, daemon getStatus, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, daemon stop snapshot cleanup:

- Removed the redundant `readRuntimeConfigSnapshot()` call before `stop()` updates `shuttingDown`; the update path already reads and returns the latest runtime ref when the runtime is alive.
- Added a guard preventing that pre-stop runtime read from returning.
- Verified locally with focused runtime-boundary and daemon getStatus tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, daemon initial config snapshot cleanup:

- Seeded `DaemonLive` from the local pre-runtime config snapshot instead of routing through `readRuntimeConfigSnapshot()` before the daemon runtime exists.
- Added a guard preventing that pre-runtime runtime-read-shaped call from returning.
- Verified locally with focused runtime-boundary and daemon getStatus tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, daemon rehydrate snapshot cleanup:

- Split pre-runtime local config snapshot updates from post-runtime config-ref updates.
- Saved config rehydration now updates the startup snapshot directly instead of calling `updateRuntimeConfigSync()` before the runtime exists.
- Verified locally with focused runtime-boundary and daemon getStatus tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, daemon direct-stop shutdown snapshot cleanup:

- Direct `DaemonHandle.stop()` now marks shutdown in the local snapshot before disposing the runtime.
- Added a guard preventing direct stop from calling `updateRuntimeConfigSync()` and re-entering the runtime solely to set shutdown state.
- Verified locally with focused runtime-boundary and daemon getStatus tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, daemon sync config update bridge deletion:

- Deleted the synchronous daemon runtime-config update bridge and its unit-only fallback helper.
- Project add/remove now update dismissed-path state through the local snapshot immediately and through `DaemonConfigRefTag` inside the existing async Effect daemon-state sync.
- Verified locally with focused runtime-boundary and daemon getStatus tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, relay dual-write runtime ownership:

- Removed the separate persistence `ManagedRuntime` owned by `EffectDualWriteHook`.
- `makeEffectDualWriteHook` now acquires SQL, event store, and projection runner services from the relay Layer graph; SSE handling runs the hook as part of the Effect-owned SSE program.
- Verified locally with focused dual-write/runtime-boundary/SSE wiring tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.

2026-05-14, status-poller parent-map bridge cleanup:

- Changed `PollDeps.getSessionParentMap` to return an Effect so `StatusPollerLive` can read `SessionManagerStateTag` inside the poll program.
- Removed the layer-local `Runtime.runSync(runtime)(getSessionParentMapFromState)` bridge and guarded it against returning.
- Verified locally with focused runtime-boundary/status-poller tests, `pnpm check`, `pnpm lint`, and diff hygiene checks.
