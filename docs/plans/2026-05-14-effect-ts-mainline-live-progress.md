# Effect.ts Mainline Live Progress

Current source of truth for the remaining Effect.ts mainline completion work.

Historical log: `docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md`.

Plan: `docs/plans/2026-05-11-effect-ts-mainline-completion-plan.md`.

Updated: 2026-05-15.

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
| `startDaemonProcess` imported by CLI | Done | CLI foreground and internal `--daemon` child startup now enter through the Effect daemon starter facade, and the legacy bridge export has been deleted from `daemon-main.ts`. Final static guard passed in `pnpm test:all`. |
| `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition | Done | Production `relay-stack.ts` now composes relay-owned Layers for OpenCode API, config, logger, WebSocket handler, status poller, and instance management. Static guard prevents `Layer.succeed` bridge composition from returning to `relay-stack.ts` or stale relay Layer docs. |
| `PersistenceLayer.open(...)` in daemon or relay production paths | Done | Final static guard passed in `pnpm test:all`. |
| `Effect.promise(` on rejectable operations | Done | Final static guard passed in `pnpm test:all`. |
| `concurrency: "unbounded"` on dynamic collections | Done | Final static guard passed in `pnpm test:all`; fixed-size fanouts need inline justification. |
| Throwing helpers called from Effect programs | Done | Backend expected failures now use tagged domain errors: instance lifecycle, startup rehydration/auto-start, gap endpoint REST, Claude prompt queue protocol, npm registry version checks, relay startup/add-project, instance IPC handler failures, PID write failures, project registry lifecycle, daemon OpenCode availability, daemon spawn lifecycle, and push manager pre-init/VAPID failures. Remaining production `throw new Error` hits are explicitly reclassified and statically guarded as frontend/browser/invariant, story fixture text, or `assertNever` defect paths. Final static guard passed in `pnpm test:all`. |
| App-internal `Effect.runPromise` / `Effect.runSync` | Done | Static guard now scans `Effect`/`Runtime`/`ManagedRuntime` and object `.runPromise`/`.runSync` calls across `src/lib`; the only allowed hits are the standalone HTTP compatibility adapter, OpenCode SDK fetch adapter, Claude SDK permission callback adapter, frontend transport Promise boundary, and public `createProjectRelay()` startup boundary. |

## Current Blockers

None. The guardrail checklist is closed and the full verification gate passed on 2026-05-15.

## Completion State

This mirrors the plan's authoritative order. As of 2026-05-15, there are no live guardrail blockers. The notes below record the committed/current boundary state and any explicitly deferred follow-up, not active blockers.

1. Effect version freeze and post-migration v4 record.
2. Domain organization move-only PR. Done in this branch.
3. Persistence migration runner alignment. Done in this branch. Real production DB dry-run remains required before any persistence consumer switch.
4. Contracts and RPC boundary. Current state: shared `WsRpcGroup`, import guard, and server/frontend re-export wrappers are in place.
5. Hybrid relay domain model. Current state: pure relay command/event/read-model, bounded command gate, and bounded sliding relay event bus are in place.
6. Router service ownership and HTTP runtime boundary. Done locally for daemon and standalone relay HTTP handler ownership; daemon HTTP handler construction now runs inside the router Layer, daemon WebSocket upgrade routing no longer uses `Runtime.runPromise`, daemon HTTP project reads are projected from Effect-owned daemon state instead of a `daemon-main` callback, and daemon push routes read the Effect-owned push manager instead of router options.
7. Scoped project relay ownership. Current state: prebuilt relay object injection is gone from `relay-stack.ts`, client init now forks one Effect-owned bootstrap at the WebSocket callback boundary, startup service acquisition and relay callback/monitoring/poller/SSE setup are consolidated into one Effect program, API/WebSocket handler acquisition no longer uses separate startup `runSync` calls, SSE connect/command-gate readiness runs inside startup, SSE shutdown drain and command-gate stop are scoped finalizers, SSE pending question writes use the owned session service surface, SSE pending permission writes run inside the Effect-owned SSE handler, message/status-poller callbacks now use Effect-owned paths, Effect dual-write persistence is created and run inside the relay runtime, status-poller parent-map reads stay inside the poll Effect instead of a layer-local sync runtime bridge, the standalone/E2E default-session API reads the startup snapshot instead of re-entering the session service, daemon/router session counts read a relay status snapshot instead of a sync runtime bridge, daemon IPC default-agent/model updates use the `ProjectRelay` public surface, public default-agent/model commands enqueue into the scoped relay command loop instead of re-entering the runtime, the status-poller runtime facade is deleted and `StatusPollerLive` now exposes context-free Effect methods backed by its owned refs/fibers, `EffectWsHandler` is built by its scoped Layer and forks callback work into the relay runtime instead of owning a private `ManagedRuntime`, the RPC WebSocket handler now uses a relay-scoped transport instead of a second private transport runtime, the sole relay-stack `runPromise` is guarded as the public startup Promise boundary, daemon `RelayCache` now derives relay creation from `RelayFactoryTag`, `ProjectRegistryTag`, and `InstanceManagerStateTag` instead of a caller-built factory, `RelayFactoryLive` threads Effect-owned project/instance read models into `createProjectRelay`, `RelayFactoryLive` threads Effect-owned instance add/remove/start/stop/update/persist callbacks into `createProjectRelay`, `RelayFactoryLive` threads port-scan, cached-update replay, and push delivery services into `createProjectRelay`, relay project add/remove/rename/set-instance callbacks are owned by `RelayCache` so set-instance can invalidate and recreate relays without a factory-to-cache Context cycle, and in-flight relay creation is now cancellable through a cache-owned creation fiber plus `createProjectRelay` AbortSignal propagation.
8. RPC-over-WS vertical migration. Done locally for ordinary browser operations. `pty_input` is explicitly reclassified as the raw terminal data-plane command until a persistent RPC stream/client design replaces it. Frontend RPC wrappers now share `runTransportEffect` instead of calling the runtime directly per operation.
9. Provider driver and instance ownership. Current state: `ProviderDriver` / `ProviderInstance` / `ProviderCapabilities` / `ProviderInstanceFailure` exist, production orchestration runtime creates `OpenCodeProviderInstance` / `ClaudeProviderInstance` through plain driver values, `ProviderRegistry` now exposes only instance-first APIs, provider implementation/test naming is instance-first, provider wait state now uses Effect `Deferred` for `EventSinkImpl`, OpenCode pending turns, Claude setup locks, and Claude turn queues, the old provider Promise-deferred helper is deleted, Claude translator sink writes no longer use `Runtime.runPromise`, and the remaining OpenCode/Claude SDK Promise adapters are named and statically guarded as external callback boundaries.
10. IPC socket ownership. Done locally pending final recheck: tagged IPC dispatch no longer uses app-internal `Effect.runPromise`, `Runtime.runPromise`, or a `Runtime.defaultRuntime` fallback in `daemon-lifecycle.ts`; legacy cmd-format IPC validates with the old semantics, converts to tagged payloads, and dispatches through the same daemon runtime-owned RPC path; the old `DaemonIPCContext` / `buildIPCHandlers` adapter is deleted.
11. Daemon composition readiness. Current state: IPC status reads now live on the IPC context instead of passing a separate `DaemonLiveOptions.getStatus` callback through the Layer graph, keep-awake/PIN/shutdown IPC now run through native Effect handlers, restart-config IPC now mutates `DaemonConfigRefTag` natively, legacy ManagedRuntime shutdown/restart scheduling is isolated to the IPC socket post-response hook instead of `DaemonIPCContext`, startup session-count prefetch is owned by `SessionPrefetchLive` instead of a daemon-main fetch loop, daemon startup time is seeded in the initial runtime config instead of a post-start runtime mutation, daemon-main derives the bound HTTP port from the owned server handle instead of reading the runtime config ref after startup, daemon HTTP auth uses the layer-owned `AuthManagerTag` instead of a daemon-main snapshot callback, daemon setup-info reads port/TLS from `DaemonConfigRefTag` inside the router layer instead of daemon-main callbacks, daemon HTTP health reads from `DaemonHandleTag` instead of a `daemon-main` callback, daemon HTTP project removal reads from `DaemonHandleTag` instead of a router options callback, daemon HTTP CA downloads read from `TlsCertTag` inside the router layer, daemon HTTP themes are loaded inside the router layer instead of passed from `daemon-main`, daemon router static-file root is supplied from top-level `DaemonLiveOptions.staticDir` instead of duplicated in router options, daemon HTTP project lists/status routing read `ProjectRegistryTag`, `DaemonConfigRefTag`, and non-starting `RelayCacheTag.peek` inside the router layer instead of a `daemon-main` callback, daemon push manager initialization/subscription routes are owned by `PushNotificationManagerLive(configDir)` and `DaemonLiveOptions.httpRouter` is gone, daemon config persistence snapshots are built from Effect-owned daemon/project/instance state and `DaemonLiveOptions.configSnapshot` is gone, `stop()` no longer performs a separate runtime-config read before applying shutdown state, `DaemonLive` is seeded from the local pre-runtime config snapshot instead of calling the runtime-read helper before the runtime exists, saved config rehydration now updates the local startup snapshot directly before the runtime exists, direct `DaemonHandle.stop()` marks shutdown in the local snapshot instead of re-entering the runtime before disposal, the synchronous daemon runtime-config update bridge is deleted, daemon-main config reads now use the local read model while Effect-owned writes mirror back into it, daemon-main project-registry sync/startup acquisition now waits through the ManagedRuntime callback/fiber exit API instead of `runPromise`, daemon port scanning is owned by `PortScannerLive` with manual scan requests entering through the daemon runtime, the CLI/default OpenCode URL is seeded into Effect-owned instance state, `DaemonHandleLive` now exposes a layer-owned handle backed by daemon config, lifecycle, project registry, instance manager, and relay cache state, onboarding CA deps are derived inside `makeOnboardingServerLive` from `TlsCertTag` instead of being placeholder-built in `daemon-main`, `DaemonLifecycleContext` is created by `DaemonLifecycleContextLive` instead of being required in `DaemonLiveOptions`, and `DaemonLiveOptions.relayFactory` is gone.
12. Single-owner daemon cutover. Done locally: CLI foreground, internal `--daemon` child startup, instance lifecycle parity, daemon runtime-config status parity, daemon lifecycle integration parity, the shared daemon E2E harness, daemon project-order E2E setup, daemon smart-default unit/E2E setup, all daemon-server integration cases, daemon-main helper unit coverage, and daemon TLS integration now use Effect-backed daemon starter facades instead of importing/calling `startDaemonProcess`; foreground daemon instance IPC now calls Effect-owned instance services through the managed runtime; foreground daemon config status is mirrored from the Effect config ref; smart-default probe/convert is owned by the daemon instance-state Layer; instance health checks are owned by an overridable Effect service; relay-ready daemon-server coverage now exercises real `RelayFactoryLive` with a mocked `createProjectRelay` dynamic import instead of reintroducing caller-owned relay factories; `DaemonLiveOptions.ipcContext` is gone, tagged/legacy IPC socket dispatch now runs through the daemon layer's Effect-owned RPC handlers, the legacy IPC context adapter is deleted, and the `startDaemonProcess` bridge export is deleted.
13. Final guardrail cleanup. Done locally: static runtime bridge guard now covers `Effect`/`Runtime`/`ManagedRuntime` and object `.runPromise`/`.runSync` calls, with all surviving hits explicitly reclassified; static relay composition guard now prevents `Layer.succeed` bridge wiring from returning to `relay-stack.ts`.
14. Final docs and verification. Done: agent-guide guardrails are documented, the live progress doc records final closure, and `pnpm test:all > test-output.log 2>&1` passed.

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

2026-05-15, final verification closure:

- Fixed the replay E2E duplicate-prompt regression by ignoring own-browser live `user_message` echoes in the per-session dispatch path; committed as `84c31871`.
- `pnpm test:all > test-output.log 2>&1` passed: typecheck, lint, unit, integration, contract, E2E, and Storybook visual gates all completed successfully.
- Final log evidence: Storybook visual reported 494 passed / 16 skipped, then `All steps passed`.

2026-05-15, final runtime boundary reclassification:

- Broadened the runtime boundary guard to catch `Effect`/`Runtime`/`ManagedRuntime` and object `.runPromise`/`.runSync` calls.
- Reclassified the only surviving runtime boundaries as external compatibility edges: standalone HTTP handler, OpenCode SDK fetch, Claude SDK permission callback, frontend transport, and relay startup.
- Added a guard that keeps `Layer.succeed` bridge composition out of `relay-stack.ts` and cleaned stale relay Layer comments that still described the deleted bridge wiring.

2026-05-15, daemon bridge deletion:

- Deleted the `startDaemonProcess` bridge implementation from `daemon-main.ts`.
- Added a static guard preventing the bridge name from returning to `daemon-main.ts`.

2026-05-15, daemon TLS foreground parity:

- Activated `test/integration/daemon/daemon-tls.test.ts` by removing the stale `.skip` suffix and Vitest exclusion.
- Moved daemon TLS integration cases to `startForegroundDaemon`; all active test imports of `startDaemonProcess` are gone.

2026-05-15, daemon-main helper import cleanup:

- Moved `projectDiscovery` out of `daemon-main.ts` and into `daemon-startup.ts`.
- Changed `test/unit/daemon/daemon-main.test.ts` to import helpers from their owning services instead of `daemon-main.js`.

2026-05-15, daemon-server relay-ready foreground parity:

- Moved the relay-ready WebSocket upgrade integration case to `startForegroundDaemon`.
- Kept relay ownership inside the real Effect daemon graph by mocking only the dynamic `createProjectRelay` boundary in the test, not by adding a production relay-factory override.

2026-05-15, daemon instance health-check foreground parity:

- Added `InstanceHealthCheckTag` / `InstanceHealthCheckLive` and routed Effect instance health polling through it, including OpenCode Basic auth from instance or process credentials.
- Moved daemon-server authenticated health-check integration to `startForegroundDaemon`.

2026-05-15, daemon-server direct foreground parity:

- Moved the non-existent slug, invalid upgrade path, no-instance 503, getInstances, and status listener daemon-server integration cases to `startForegroundDaemon`.
- Left the relay-ready upgrade case on the legacy bridge until the Effect-owned relay factory test seam exists, and left authenticated health-check coverage until the instance health-check service seam exists.

2026-05-15, daemon smart-default foreground parity:

- Moved `test/unit/daemon/daemon-auto-start.test.ts` and `test/e2e/specs/daemon-smart-default.spec.ts` from the legacy daemon bridge to `startForegroundDaemon`.
- Added an Effect-owned smart-default resolver for default OpenCode probe/convert during daemon instance-state Layer construction.

2026-05-15, daemon project-order E2E foreground parity:

- Moved `test/e2e/specs/daemon-project-order.spec.ts` from the legacy daemon bridge to `startForegroundDaemon`.

2026-05-15, shared E2E daemon harness foreground parity:

- Moved `test/e2e/helpers/daemon-harness.ts` from the legacy daemon bridge to `startForegroundDaemon`.
- Kept the real OpenCode health wait on the foreground handle after adding Effect-owned unmanaged-instance health polling.

2026-05-15, foreground instance-health parity:

- Started health pollers for unmanaged instances seeded into the Effect instance state at daemon Layer startup.
- Changed foreground sync getters to request a background snapshot refresh so async daemon state changes become visible without the legacy bridge.
- Added foreground coverage proving an `opencodeUrl` default instance reaches `healthy` through the Effect-owned graph.

2026-05-15, daemon lifecycle integration foreground parity:

- Moved `test/integration/flows/daemon-lifecycle.integration.ts` from the legacy daemon bridge to `startForegroundDaemon`.
- Preserved real HTTP health shutdown, PID/socket cleanup, and relay cleanup coverage against the Effect-owned foreground graph.

2026-05-15, daemon runtime-config foreground parity:

- Moved `test/unit/effect/daemon-main-getstatus.test.ts` from the legacy daemon bridge to `startForegroundDaemon`.
- Fixed foreground status parity by mirroring Effect config-ref commits into the compatibility handle cache.
- Fixed foreground stop persistence by marking the config dirty before the final flush.

2026-05-15, instance lifecycle foreground parity:

- Moved `test/unit/instance/instance-lifecycle.test.ts` from the legacy daemon bridge to `startForegroundDaemon`.
- Preserved instance lifecycle coverage for default OpenCode URL seeding, no-smart-default startup, instance config persistence, and project instance assignment.

2026-05-15, legacy IPC adapter deletion:

- Deleted `src/lib/daemon/daemon-ipc.ts` and its direct `buildIPCHandlers` unit tests.
- Replaced the remaining instance IPC add/remove coverage with real `IpcHandlersLayer` / `RpcTest` coverage backed by Effect-owned instance state.
- Removed the unused `IpcContextTag` bridge from `ipc-dispatch.ts` and added a static guard preventing the legacy daemon IPC context adapter from returning.

2026-05-15, daemon IPC context removal:

- Removed `DaemonLiveOptions.ipcContext`; `makeDaemonLive` now derives IPC handlers from `IpcHandlersLayer` inside the daemon Layer graph.
- Deleted the socket-time `buildIPCHandlers` RPC adapter from `daemon-lifecycle.ts`; tagged IPC and legacy cmd-format IPC now dispatch through the same runtime-owned tagged RPC handler surface.
- Moved project, status, instance, default-agent, and default-model IPC handlers onto Effect-owned daemon services; added a static guard preventing caller-built daemon IPC context from returning.

2026-05-15, foreground daemon instance IPC parity:

- Changed `DaemonIPCContext` instance mutators to allow async implementations so Effect-backed contexts do not need sync compatibility throws.
- Wired foreground daemon `instance_add`, `instance_update`, `instance_stop`, and `instance_remove` through Effect-owned instance services and refreshed the foreground read model after each mutation.
- Added real socket coverage for foreground IPC instance add/update/stop/status/list/remove.

2026-05-14, CLI daemon child Effect starter:

- Routed the internal `--daemon` child path through `startDaemonChildProcess`, backed by the same Effect daemon starter module as foreground mode.
- Removed the CLI import of `daemon-main.js` / `startDaemonProcess` and added a static guard to prevent it returning.
- Added CLI coverage for child-process env option translation into the injected daemon child starter.

2026-05-14, CLI foreground Effect starter:

- Added `startForegroundDaemon`, an Effect-backed foreground facade built from `makeDaemonLive` and `DaemonHandleTag`, with a scoped `ManagedRuntime` and compatibility handle methods for CLI foreground.
- Changed `cli-core` foreground mode to call the foreground starter seam instead of `startDaemonProcess`.
- Added isolated temp-config coverage for the real foreground starter and updated CLI foreground tests to mock the starter facade rather than the legacy daemon bridge.

2026-05-14, daemon handle foreground parity:

- Split daemon lifecycle context and project discovery into reusable Effect service modules so the handle can expose foreground-compatible operations without importing daemon layer internals.
- Expanded `DaemonHandleLive` with onboarding port, slug/instance-aware project add, project discovery, instance listing, lifecycle client count, and relay-backed session-count status.
- Added handle behavior coverage for instance/project ownership, relay status projection, dismissed-path updates, and missing-project failures.

2026-05-14, daemon relay factory cancellation parity:

- Changed `RelayCache` to store cancellable in-flight entries before relay creation completes, so invalidation can remove and interrupt startup instead of waiting behind creation.
- Split relay creation from scoped-ref installation so factory startup remains interruptible while completed relays still get cache-owned stop finalizers.
- Added `RelayFactoryLive` interrupt handling that aborts the `createProjectRelay` signal when the Effect is interrupted.
- Added relay-cache and relay-factory coverage for in-flight cancellation and abort propagation.

2026-05-14, daemon relay factory project mutation parity:

- Added relay-cache-owned project controls for add/remove/rename/set-instance callbacks passed into `createProjectRelay`.
- Kept relay invalidation and set-instance recreation owned by `RelayCache` instead of making `RelayFactoryLive` depend on `RelayCacheTag`.
- Added mocked relay-cache/factory coverage proving project callbacks mutate Effect-owned project state and set-instance recreates the relay.

2026-05-14, daemon relay factory auxiliary callback parity:

- Wired `RelayFactoryLive` to pass `triggerScan`, async cached-update replay, and the layer-owned push sender into `createProjectRelay`.
- Moved version checker and port scanner Layers ahead of relay-factory composition so those callbacks are available without app-internal runtime escapes.
- Changed cached-update replay to accept async suppliers in both Effect-owned and compatibility client-init paths.
- Added mocked relay-factory coverage proving auxiliary callbacks use the Effect-owned daemon services.

2026-05-14, daemon relay factory instance callback parity:

- Moved config persistence ahead of relay factory composition so relay factory callbacks can request saves without a RelayCache cycle.
- Wired `addInstance`, `removeInstance`, `startInstance`, `stopInstance`, `updateInstance`, and `persistConfig` from `RelayFactoryLive` to Effect-owned instance state.
- Updated relay instance-management service/types to accept async daemon callbacks.
- Added mocked relay-factory coverage proving instance callbacks mutate Effect-owned state.

2026-05-14, daemon relay factory read-model parity:

- Changed `ProjectRelayConfig` project/instance list suppliers to allow async Effect-owned read-model callbacks.
- Wired `RelayFactoryLive` to provide `getProjects` from `ProjectRegistryTag` and `getInstances` from `InstanceManagerStateTag`.
- Updated client init, project management, instance management, and IPC instance handlers to tolerate async instance/project suppliers.
- Added mocked relay-factory coverage proving Effect-created relays receive the project and instance read suppliers.

2026-05-14, daemon relay factory ownership:

- Removed `DaemonLiveOptions.relayFactory`; `makeDaemonLive` now derives `RelayCache` from `RelayFactoryTag`, `ProjectRegistryTag`, and `InstanceManagerStateTag`.
- Changed `RelayFactory.create` so `RelayCache` owns the long-lived relay finalizer.
- Removed the legacy registry-backed relay factory injection from `daemon-main`.
- Added a static guard preventing callers from assembling the daemon relay factory.

2026-05-14, daemon HTTP handler runtime boundary cleanup:

- Split router Layer construction from request-handler acquisition.
- Changed `makeDaemonHttpRouterLive` to yield `buildHttpRouterRequestHandlerEffect` instead of calling `Effect.runSync` during daemon Layer construction.
- Kept the remaining `Effect.runSync` explicitly scoped to `makeStandaloneHttpRouterRequestHandler`, the standalone relay HTTP compatibility adapter.
- Added a static guard preventing the daemon router Layer from reintroducing the sync bridge.

2026-05-14, default OpenCode URL instance-state prerequisite:

- Added `DaemonLiveOptions.defaultOpencodeUrl` so the Effect-owned instance state sees the CLI/OpenCode URL default before relay-factory ownership moves out of `daemon-main`.
- Seeded a default unmanaged instance only when persisted state does not already contain `default`.
- Added wiring coverage proving `makeDaemonLive` exposes the default instance and external URL through `InstanceManagerStateTag`.

2026-05-14, daemon handle layer prerequisite:

- Added `DaemonHandleLive` as the Effect-owned handle provider for status, port, project add/remove, and project listing.
- Wired `DaemonHandleTag` into `makeDaemonLive` so the composed daemon graph exposes the handle without the legacy process bridge.
- Added behavior and wiring coverage for config-backed status plus project registry mutations.

2026-05-14, onboarding deps layer ownership:

- Removed the placeholder `onboardingDeps` object from `daemon-main`.
- Changed `DaemonLiveOptions` to pass `staticDir` while `makeOnboardingServerLive` derives CA root/cert data from `TlsCertTag`.
- Added a static guard preventing prebuilt onboarding deps from returning to the daemon options bridge.

2026-05-14, daemon lifecycle context layer ownership:

- Added `DaemonLifecycleContextTag` / `DaemonLifecycleContextLive` so `makeDaemonLive` creates the HTTP/IPC/onboarding lifecycle context from `socketPath`.
- Removed `ctx` from `DaemonLiveOptions`; `daemon-main` now reads the layer-owned context after runtime startup for its remaining legacy handle needs.
- Kept focused HTTP/onboarding server tests on compatibility helpers backed by the new context tag and added a static guard against reintroducing caller-built daemon context.

2026-05-14, daemon HTTP health ownership:

- Changed `HealthProvider` to expose an Effect-returning response.
- Removed `getHealthResponse` from `DaemonHttpRouterOptions`; daemon HTTP health now reads from `DaemonHandleTag`.
- Added a static guard preventing `daemon-main` from passing `getStatus()` through router options again.

2026-05-14, daemon HTTP project removal ownership:

- Removed `removeProject` from `DaemonHttpRouterOptions`; daemon HTTP delete-project now reads from `DaemonHandleTag`.
- Preserved removed-project dismissed-path semantics inside `DaemonHandleLive`.
- Added behavior coverage for dismissed-path mutation and missing-project failure plus a static guard against reintroducing the router callback.

2026-05-14, daemon HTTP CA ownership:

- Wired `makeDaemonHttpRouterLive` to derive CA download material from `TlsCertTag`.
- Removed the stale daemon-main CA placeholder comment.
- Added router-layer behavior coverage for `/ca/download` plus a static guard preventing the placeholder from returning.

2026-05-14, daemon HTTP theme ownership:

- Removed `loadThemes` from `DaemonHttpRouterOptions`; daemon HTTP themes now use `loadThemeFiles` inside the router layer.
- Changed `ThemeProvider` to expose an Effect-returning loader while keeping standalone router options Promise-based at the external boundary.
- Added router-layer behavior coverage for `/api/themes` plus a static guard against reintroducing the daemon-main theme callback.

2026-05-14, daemon HTTP static dir ownership:

- Removed duplicate `staticDir` from `DaemonHttpRouterOptions`.
- Changed `makeDaemonLive` to pass top-level `DaemonLiveOptions.staticDir` into `makeDaemonHttpRouterLive`.
- Added static guards preventing nested daemon router static roots from returning.

2026-05-14, daemon HTTP project-list ownership:

- Removed `getProjects` from `DaemonHttpRouterOptions`; daemon project-list, root redirect, and project-status routes now read from `ProjectRegistryTag`, `DaemonConfigRefTag`, and non-starting `RelayCacheTag.peek` inside the router layer.
- Added `RelayCache.peek` so read-only HTTP status projection can observe cached relay status snapshots without starting relays.
- Added behavior coverage for project list/session/client/error projection plus a static guard against reintroducing the daemon-main router callback.

2026-05-14, daemon push manager ownership:

- Added `PushNotificationManagerLive(configDir)` so the daemon Layer graph owns VAPID initialization and the legacy-compatible push sender.
- Removed `DaemonLiveOptions.httpRouter` / `DaemonHttpRouterOptions`; daemon push HTTP routes now read the Effect-owned push manager and relays receive the same sender after daemon runtime startup.
- Added behavior coverage for daemon push routes plus static guards against reintroducing router push options or daemon-main push construction.

2026-05-14, daemon config snapshot ownership:

- Removed `DaemonLiveOptions.configSnapshot` and the unused `makeConfigSnapshotLive` bridge helper.
- Config persistence now always uses `ConfigSnapshotFromEffectStateLive`, backed by `DaemonConfigRefTag`, `ProjectRegistryTag`, and `InstanceManagerStateTag`.
- Added a static guard preventing daemon-main from passing `buildConfig` into the Layer graph.

2026-05-14, frontend RPC runtime boundary cleanup:

- Added `runTransportEffect` as the single frontend transport Promise boundary.
- Rewrote `ws-rpc-client.ts` RPC wrappers to use the shared runner instead of calling `getRuntime().runPromise(...)` per operation.
- Added a frontend static guard preventing direct `runPromise` calls from returning to the RPC client wrappers.

2026-05-14, provider SDK Promise boundary reclassification:

- Moved OpenCode retry-fetch Promise execution behind `runRetryFetchAtFetchBoundary`.
- Moved Claude permission waits behind `runPermissionRequestAtSdkBoundary`.
- Added static guards so those unavoidable SDK Promise adapters stay named external boundaries rather than inline app-internal bridges.

2026-05-14, daemon OpenCode availability throw-helper cleanup:

- Added tagged `OpenCodeUnavailableError` for daemon startup paths where OpenCode is unreachable and the `opencode` binary is missing.
- Strengthened auto-start behavior tests to assert the typed error tag, URL, and port.
- Added a static guard proving those expected startup failures no longer throw plain `Error`.

2026-05-14, throw-helper guardrail reclassification:

- Added a broad runtime-boundary guard that fails on any remaining production `throw new Error` outside the explicit allowlist.
- Reclassified the remaining allowed throws as frontend/browser/invariant, story fixture text, or `assertNever` defect paths.
- Marked the throw-helper guardrail done pending final recheck.

2026-05-14, push manager throw-helper cleanup:

- Added tagged push errors for pre-init send attempts and missing VAPID key state.
- Strengthened push manager behavior tests to assert the typed initialization error.
- Added a static guard proving push initialization failures no longer throw plain `Error`.

2026-05-14, daemon spawn throw-helper cleanup:

- Added tagged daemon spawn errors for port-in-use, missing pid, and child-exited-before-ready failures.
- Changed CLI daemon spawn port-conflict handling to branch on the typed port-in-use tag instead of message text.
- Strengthened daemon-spawn behavior coverage and runtime-boundary guards for the typed spawn surface.

2026-05-14, daemon startup auto-start throw-helper cleanup:

- Added behavior coverage proving expected tagged auto-start failures log and continue, while untyped start rejections remain startup defects.
- Replaced `Effect.tryPromise(() => mgmt.startInstance(...))` plus `UnknownException` handling with typed `InstanceAutoStartFailed` classification.
- Added a static guard preventing daemon startup auto-start from hiding failures behind `UnknownException`.

2026-05-14, gap endpoint HTTP throw-helper cleanup:

- Added tagged `GapEndpointHttpError` for OpenCode gap endpoint GET/POST HTTP failures.
- Added behavior coverage and a static guard proving gap endpoint HTTP failures no longer reject with plain `Error`.

2026-05-14, Claude prompt queue throw-helper cleanup:

- Added tagged `EffectPromptQueueAlreadyIterating` for the SDK-facing single-consumer AsyncIterator protocol guard.
- Added behavior coverage and a static guard proving the prompt queue no longer throws plain `Error` for that expected protocol failure.

2026-05-14, version-check registry throw-helper cleanup:

- Added tagged `NpmRegistryResponseError` and `NpmRegistryInvalidResponseError` for expected registry response failures.
- Added behavior coverage and a static guard proving registry HTTP/shape failures no longer reject with plain `Error`.

2026-05-14, relay-stack expected failure cleanup:

- Added tagged relay errors for creation cancellation, missing HTTP server handle, invalid project directories, and duplicate pending relay creation.
- Added behavior coverage for aborted relay creation and a static guard preventing those relay-stack failures from regressing to plain `Error`.

2026-05-14, shared instance domain errors:

- Added shared tagged instance error types for already-exists, max-limit, invalid URL, not-found, and external-start failures.
- Replaced legacy `InstanceManager` expected plain `Error` throws with those shared tagged errors.
- Re-exported the shared errors from the Effect instance-manager service so existing catchTag call sites keep working.
- Updated daemon startup rehydration to classify expected instance-manager failures by tag instead of message text.
- Added behavior coverage and static guards for typed legacy instance errors and startup classification.

2026-05-14, instance lifecycle IPC throw-helper cleanup:

- Added behavior coverage proving remove/start/stop/update instance failures return successful IPC error responses instead of defecting.
- Centralized sync and Promise instance-management operation wrappers around typed `InstanceMgmtOperationFailed`.
- Added a static guard preventing daemon IPC handlers from reintroducing unknown catch-passthroughs.
- Verified locally with focused IPC handler and runtime-boundary guard tests plus `pnpm check`, `pnpm lint`, and `git diff --check`.

2026-05-14, project registry throw-helper cleanup:

- Added behavior coverage proving duplicate/missing/already-ready project registry failures keep their public messages while carrying tagged domain error identity.
- Replaced expected project registry lifecycle `throw new Error` / Promise rejection paths with `Data.TaggedError` domain errors.
- Updated daemon project removal and ready-relay helpers to throw the same typed registry domain errors instead of ad hoc plain `Error`.
- Added a static guard preventing expected project registry failures from regressing to plain `Error`.

2026-05-14, PID file lifecycle throw-helper cleanup:

- Added behavior coverage proving PID file acquisition failures are typed Layer failures, not defects.
- Replaced `Effect.sync(writePidFile(...))` with `Effect.try(..., DaemonLifecycleLayerError)` inside `makePidFileLive`.
- Verified locally with focused daemon Layer tests.

2026-05-14, startup instance rehydration throw-helper cleanup:

- Added behavior coverage proving persisted instance config rejections do not defect or stop later instance rehydration.
- Replaced the generic `UnknownException` branch with typed `InstanceRehydrationFailed` classification; known legacy instance-manager errors log and continue, unknown causes still defect.
- Verified locally with focused daemon-startup tests.

2026-05-14, instance add IPC throw-helper cleanup:

- Added behavior coverage proving `handleInstanceAdd` returns an IPC error instead of defecting when legacy instance management rejects.
- Wrapped the sync legacy instance add/persist boundary in a typed `InstanceMgmtOperationFailed` Effect error before folding back to `IPCResponse`.
- Verified locally with focused IPC handler tests.

2026-05-14, daemon port scanner Layer ownership:

- Moved daemon auto-discovery port scanning from the legacy `PortScanner` class instance into `PortScannerLive`.
- Added `scanNow`, active/discovered/lost result reporting, per-scan callbacks, and dynamic managed-port exclusion to the Effect scanner service.
- Relay `triggerScan` now enters the daemon runtime through `PortScannerTag` instead of closing over an imperative scanner object.
- Verified locally with focused leaf-service and runtime-boundary tests.

2026-05-14, daemon WebSocket routing runtime Promise bridge cleanup:

- Replaced daemon WebSocket upgrade routing `Runtime.runPromise` handoff with `Runtime.runCallback`.
- Added a guard preventing `Runtime.runPromise(runtime)` from returning in `ws-routing-layer.ts`.
- Verified locally with focused runtime-boundary, WebSocket routing, and scoped-fiber tests.

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
