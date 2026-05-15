# Effect.ts Mainline Completion Implementation Plan

> **For Codex:** Use `subagent-driven-development` for same-session execution. Use `executing-plans` only when deliberately handing this plan to a separate implementation session.

**Goal:** Migrate the remaining high-value conduit runtime surfaces on `main` to idiomatic Effect.ts, and remove bridge code that gives false confidence that a path is Effect-native.

**Architecture:** Move ownership to one scoped Effect composition root, while preserving the per-project relay as the deployment unit. Inside each relay, adopt the command/event/projector/read-model shape: pure deciders decide commands into durable events, pure projectors rebuild read models from events, and the Effect shell owns SQL, PubSub/event fanout, provider calls, scoped fibers, and WebSocket transport. Keep imperative code only at external callback boundaries such as Node process entry, `ws`, browser events, and third-party SDK callbacks.

**Tech Stack:** `effect 3.21.x`, `@effect/platform`, `@effect/platform-node`, `@effect/rpc@0.75.1`, `@effect/sql`, `@effect/sql-sqlite-node`, `@effect/vitest`, Vitest, Svelte 5, Node.js, SQLite.

**Effect Version Policy:** Finish this migration on the current Effect 3.x stack. Do not introduce `effect@4.0.0-beta.*` or v4-only `effect/unstable/*` imports during this plan. The Effect v4 migration is a separate post-migration track after the guardrail checklist is complete and the architecture is Effect-owned.

**Live Progress:** Use `docs/plans/2026-05-14-effect-ts-mainline-live-progress.md` for current checklist state. `docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md` is a historical evidence log and should not be loaded or appended for routine slice updates.

**Reference Docs:**
- `docs/agent-guide/architecture.md`
- `docs/agent-guide/testing.md`
- `docs/plans/effect-ts-next-wave/conventions.md`
- `docs/plans/2026-05-07-daemon-effect-phase8-plan.md`
- `docs/plans/2026-05-07-daemon-effect-phase8-audit-r2.md`

---

## Migration Principles

This plan intentionally avoids prescribing every line of implementation. The implementer should write the code using the current codebase shape, but must preserve these rules:

- One long-lived daemon runtime. `NodeRuntime.runMain(...)` owns process lifetime and signal handling.
- One scoped Layer graph for daemon services. Do not scatter `Effect.runPromise` / `Effect.runSync` through app-internal code.
- Service methods return `Effect.Effect<A, E, R>`, not `Promise<A>`, once their owning service is migrated.
- External APIs may remain Promise/callback based only at the external boundary; normalize them immediately with `Effect.tryPromise`, `Effect.async`, `Stream.async`, or `Effect.acquireRelease`.
- Expected failures are typed errors. Throwing, `Effect.die`, and plain `Error` are for defects or last-resort foreign errors.
- No `Effect.promise` for rejectable promises.
- No unbounded concurrency for collections whose size can grow with sessions, projects, instances, clients, or messages.
- No permanent bridge Layers that wrap already-constructed imperative instances with `Layer.succeed(Tag, instance)`.
- All long-lived resources are scoped. Shutdown should happen by Scope interruption, not hand-maintained `stop()` chains.
- Use `@effect/vitest` for Effect tests; use `Layer.fresh(...)` for stateful test Layers.
- Implement semantic slices test-first: add the narrow behavior/contract test for the next observable change, make it pass, then refactor. Do not bulk-write speculative tests ahead of the slice.
- Keep the per-project relay model. Do not collapse into a global orchestration engine unless a product requirement appears that the per-project model cannot serve, such as daemon-wide search, a single canonical activity feed, or cross-project orchestration.
- Relay business flow should converge on command/event/projector/read-model. Command deciders and event projectors are pure functions; Effect belongs at the shell.
- SQLite event storage remains the source of truth. Relay read models must be rebuildable from persisted events; do not create a second durable event log unless the existing event store cannot represent the domain event.
- WebSocket remains the real-time transport. The migration may replace the hand-rolled JSON message protocol with typed Effect RPC over WebSocket, but it must not degrade the product to polling.
- Per-browser-tab UI state stays browser/route-local. The daemon stores durable project/session state, not "which tab is looking at which session" state.
- Any relay event bus must declare its backpressure and replay story. Do not add unbounded in-memory PubSub as the default; prefer persisted events plus bounded signals or explicit replay cursors unless the design records why unbounded fanout is safe.
- Provider drivers should avoid a Context tag per driver or per provider instance. A provider registry can be a service, but individual provider drivers should be plain values that create scoped provider instances with captured closures.
- Organize by domain before large semantic rewrites. A move-only domain layout PR is preferred over continuing to grow the flat `src/lib/domain/*` bucket.

## Non-Goals

- Do not force incidental Svelte UI timers, debounce timers, copy-flash timers, or local animation state into Effect. Keep Effect on the frontend at protocol, schema, transport, and long-lived connection boundaries.
- Do not rewrite business behavior while migrating. Preserve project routing, persisted event semantics, and daemon CLI behavior unless a task explicitly says otherwise. The WebSocket protocol may change only in the RPC-over-WS phase, and that phase must migrate server and frontend contracts together.
- Do not migrate to Effect v4 in this plan. Record any v4 follow-ups separately after the Effect 3.x ownership migration is complete.
- Do not replace the per-project relay with a daemon-global engine in this plan.
- Do not keep compatibility wrappers after a consumer is converted. Delete old imports and old implementations in the same PR whenever the change surface is local enough. **Bridge deletion is incremental, per phase.** Phase 9 only confirms the greps are clean and updates docs — its bridge-deletion list should already be empty by the time it runs. If a phase ends with a bridge still alive, that phase did not meet its own exit criteria.

## Guardrail Closure

The original phase list below remains useful as detailed implementation background. The live guardrail checklist is
closed as of 2026-05-15; use `docs/plans/2026-05-14-effect-ts-mainline-live-progress.md` for the final status and
verification evidence.

Closed blockers:

- `PersistenceLayer.open(...)`, rejectable `Effect.promise(...)`, and dynamic `concurrency: "unbounded"` are clean in
  production `src` and covered by the final static guard run.
- Router service ownership and HTTP runtime ownership have moved into Effect-owned daemon/router services.
- Scoped project relay ownership no longer bridge-injects prebuilt relay objects in `relay-stack.ts`.
- IPC socket dispatch now routes through the daemon runtime-owned tagged RPC handler surface.
- The single daemon entrypoint cutover is complete: CLI foreground and internal child startup enter through the
  Effect daemon starter facade, and the legacy `startDaemonProcess` bridge export has been deleted.
- Throwing-helper cleanup has been triaged into typed domain errors or explicit external/invariant reclassifications.

## Target Architecture Refresh

As of the 2026-05-14 planning refresh, the target is the hybrid relay architecture:

- Keep one long-lived daemon hosting many project relays under `/p/<slug>`.
- Keep each per-project relay as the deployment, scope, routing, and lifecycle unit.
- Inside each relay, adopt the t3code-style domain shape:
  - `RelayCommand` / domain command inputs.
  - `RelayEvent` / durable event outputs.
  - `RelayReadModel` / rebuildable state.
  - `decideRelayCommand(readModel, command) -> events`.
  - `projectRelayEvent(readModel, event) -> readModel`.
- The relay Effect shell owns SQL transactions, command dispatch, replay, event publication, provider execution, and reactors.
- A command gate queues or backpressures incoming commands until replay, subscriptions, and reactors are ready. No command should race a half-started relay.
- A relay event bus can fan out in-process events to reactors, but the plan must specify whether it is bounded, sliding, dropping, or replay-backed. The durable event store is the recovery path.
- Effect RPC over WebSocket is the target browser protocol on the current Effect 3.x stack. Shared contracts replace hand-maintained frontend/server decoder drift.
- Effect v4 remains post-migration. Do not spend the mainline completion effort on beta package churn while ownership boundaries are still incomplete.

---

## Phase 0: Baseline, Guardrails, And Inventory

**Goal:** Make the migration measurable before changing behavior.

**Files:**
- Historical baseline already created: `docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md`
- Current live checklist: `docs/plans/2026-05-14-effect-ts-mainline-live-progress.md`
- Modify only if needed: `package.json`, test helpers under `test/helpers/*`

**Tasks:**

1. Create a progress checklist with every bridge/import pattern that must disappear:
   - `startDaemonProcess` imported by CLI
   - `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition
   - `PersistenceLayer.open(...)` in daemon or relay production paths
   - `Effect.promise(` on rejectable operations
   - `concurrency: "unbounded"` on dynamic collections
   - throwing helpers called from Effect programs
   - app-internal `Effect.runPromise` / `Effect.runSync`

2. Capture baseline grep output in the historical baseline progress doc, not as a committed generated artifact:

   ```bash
   rg -n "startDaemonProcess|Layer\\.succeed\\(|PersistenceLayer\\.open|Effect\\.promise|concurrency: \"unbounded\"|Effect\\.run(Promise|Sync)|throw new .*Error" src
   ```

3. Run the narrow baseline:

   ```bash
   pnpm check
   pnpm lint
   pnpm test:unit
   ```

4. If the baseline is not green, record exact failures in the historical baseline progress doc and do not mix baseline repair with migration work.

5. Capture a behavior smoke checklist in the historical baseline progress doc. Tests catch regressions in tested code; this migration mostly touches glue between tested units, so functional smoke must be re-run after every phase. Minimum list:

   - Cold daemon start, IPC `ping` round-trip, clean shutdown (no orphan processes).
   - Single-project chat round-trip with one provider (OpenCode or Claude).
   - Daemon restart preserves an in-flight session (event store rehydrates correctly).
   - Project relay disconnect + reconnect from a browser client.
   - Multi-instance: two projects active concurrently, no cross-talk.

   Record current pass/fail observations as the baseline, including the exact daemon CLI invocation used. Re-run after each phase before opening the PR.

6. Pin the Node version and `pnpm` version used for the baseline (`node --version`, `pnpm --version`) and record both in the historical baseline progress doc. Effect minor versions are already pinned in `package.json`; the plan must not relax that pinning.

**Commit:**

```bash
git add docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md
git commit -m "docs(effect): add mainline migration progress checklist"
```

---

## Phase 0.5: Domain Organization Move-Only PR

**Goal:** Clean up the codebase shape before more semantic migration work. This PR is intentionally mechanical: file moves, import rewrites, and static guards only.

**Target shape:**

- `src/lib/domain/daemon/Services/*` and `src/lib/domain/daemon/Layers/*`
- `src/lib/domain/relay/Services/*` and `src/lib/domain/relay/Layers/*`
- `src/lib/domain/provider/Services/*` and `src/lib/domain/provider/Layers/*`
- `src/lib/domain/persistence/Services/*` and `src/lib/domain/persistence/Layers/*`
- `src/lib/domain/server/Services/*` and `src/lib/domain/server/Layers/*`
- `src/lib/contracts/*` for pure schemas and protocol declarations. This plan records the boundary choice as in-repo `src/lib/contracts`; extracting a workspace package is out of scope until after the migration.

The exact folder names can be adjusted to match local naming, but the end state should be domain-first and should make `src/lib/domain/*` stop being the default place for unrelated services.

**Rules:**

1. Use `git mv` / move-only patches for the domain reshuffle.
2. Do not change behavior, service signatures, runtime composition, protocol envelopes, or tests in this PR.
3. Do not introduce Effect v4 imports or package changes.
4. Avoid compatibility barrels unless they are needed to make the move reviewable; any barrel kept after the PR must be listed in the live progress doc with its removal owner.
5. Add a static guard that prevents new production files from being added to the old flat `src/lib/domain/*` bucket except for explicitly grandfathered composition-root files.
6. Run `pnpm check` and the narrow test set for moved domains. A full suite is useful but the PR's correctness is mostly import/compile parity.

**Exit criteria:**

- The move-only diff can be reviewed without reading behavior.
- Domain folders have clear owners.
- Follow-up semantic PRs have a stable place to put command/event/read-model, RPC contracts, provider instances, and relay Layers.

---

## Phase 0.6: Contracts And RPC Boundary Design

**Goal:** Establish shared protocol contracts before replacing the WebSocket handler surface. This is a blocker before handler migration, because handler migration should target the RPC-owned protocol rather than hardening the old hand-rolled dispatcher as the long-term shape.

**Files:**

- Create: `src/lib/contracts/*` as the strict contracts boundary for this migration.
- Do not introduce `packages/contracts/*` in this plan. A workspace package can be evaluated after the Effect ownership migration is complete.
- Modify: frontend/server imports that currently duplicate protocol schema definitions.
- Review: `docs/plans/effect-ts-next-wave/phase-6-effect-rpc.md`

**Approach:**

1. Stay on the current Effect 3.x packages. Use the checked-in `@effect/rpc@0.75.1` API shape, not v4 `effect/unstable/rpc`.
2. Put only pure schemas, command/event/read-model types, request/response types, RPC group declarations, and serializable error contracts in the contracts boundary. No Layers, daemon state, provider instances, or server implementation.
3. Extract shared schemas and RPC declarations out of server/frontend implementation modules. Server code and frontend code should import contracts, not duplicate them.
4. Add a static import guard: `src/lib/contracts/*` must not import daemon, relay runtime, provider implementation, frontend stores/components, persistence implementation, or any Layer/service implementation code.
5. Define a `WsRpcGroup` for browser/server messages and streams. Every browser-facing RPC should carry project slug and, where relevant, session id. Do not let the daemon store browser tab focus.
6. Keep WebSocket as the transport. The implementation target is typed RPC over WS, not HTTP polling.
7. Introduce RPC declarations before moving handlers so server and frontend can migrate one vertical slice at a time.
8. Do not run legacy WS and RPC as permanent public protocols. Dual wiring is acceptable only inside a branch-local migration slice, and the old message type must be deleted once its RPC replacement is live.

**Tests:**

- Contract compile tests proving frontend and server import the same RPC group.
- Static import guard proving contracts stay implementation-free.
- Server handler tests using the RPC test/client helpers for one read-only method before broader migration.
- Frontend transport tests proving bad RPC payloads fail through typed contract decoding, not hand-written `unknown` parsing.

---

## Phase 1: Fix Best-Practice Violations First

**Goal:** Remove the risky Effect anti-patterns that can hide failures before broad rewiring begins.

### Task 1.1: Replace Rejectable `Effect.promise`

**Files:**
- Modify: `src/lib/relay/session-lifecycle-wiring.ts` (line ~234, `rebuildTranslatorFromHistory`)
- Modify: `src/lib/domain/daemon/Layers/daemon-layers.ts` (line ~91 `Effect.promise(close)` and line ~196 `Effect.promise(() => instance.drain())`)
- Audit: re-run `rg -n "Effect\\.promise\\(" src` and confirm every remaining hit is documented as non-rejecting at its call site.

**Approach:**

- Replace `Effect.promise(() => rebuildTranslatorFromHistory(...))` with `Effect.tryPromise`.
- Map rejection to a typed relay/session lifecycle error.
- For finalizers, do not just swap to `Effect.tryPromise` — finalizers cannot propagate failure to callers. Wrap the typed error in `Effect.catchAll(Effect.logError(...))` so a failing `close()` / `drain()` is logged at shutdown instead of silently swallowed.
- Keep any `Effect.promise` uses only where the promise is genuinely non-rejecting (e.g., deferred wrappers that only ever `resolve`), and add an inline comment explaining why.

**High-risk pattern (regular call site):**

```typescript
const existingMessages = yield* Effect.tryPromise({
  try: () => rebuildTranslatorFromHistory(/* existing args */),
  catch: (cause) =>
    new SessionLifecycleError({
      sessionId,
      operation: "rebuildTranslatorFromHistory",
      cause,
    }),
});
```

**High-risk pattern (finalizer — must log, must not throw):**

```typescript
yield* Effect.addFinalizer(() =>
  Effect.tryPromise({
    try: () => instance.drain(),
    catch: (cause) =>
      new InstanceDrainError({ instanceId: instance.id, cause }),
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError("instance drain failed during shutdown", { error }),
    ),
  ),
);
```

The exact error name can differ, but it must be a `Data.TaggedError` and must appear in the effect error channel until either the caller handles it or (for finalizers) the catchAll logs it.

**Tests:**

- Unit test where history rebuild rejects and the typed error path is observed.
- Unit test where a finalizer-target promise rejects and confirm shutdown still completes and the error is logged (not thrown into the Scope).
- Run:

  ```bash
  pnpm vitest run test/unit/relay test/unit/effect
  pnpm check
  ```

### Task 1.2: Make Persistence Row Decoding Typed

**Files:**
- Modify: `src/lib/persistence/effect/event-store-effect.ts`
- Modify: `src/lib/persistence/effect/projection-runner-effect.ts`
- Test: persistence Effect tests under `test/unit/persistence/*`

**Approach:**

- Replace throwing `rowToStoredEvent(...)` helpers with Effect-returning decoders.
- **Primary technique:** `Schema.decodeUnknown(StoredEventSchema)` — catches both JSON shape drift and field-level validation. If a `StoredEventSchema` does not yet exist, define one in this task. Schema decoding is preferred over `Effect.try(JSON.parse)` because it fails on unknown/missing fields too, not only on malformed JSON.
- **Fallback technique:** `Effect.try` only when no schema is reachable (e.g., decoding a vendor blob whose shape is genuinely opaque). Annotate every such case with a TODO referencing this plan.
- Do not call a throwing decode helper inside `Effect.map`, `Effect.gen`, or array `.map(...)` used inside Effect code.

**High-risk pattern (preferred — schema-first):**

```typescript
const rowToStoredEventEffect = (row: EventRow) =>
  Schema.decodeUnknown(StoredEventSchema)({
    streamId: row.streamId,
    version: row.version,
    payload: JSON.parse(row.payload), // wrapped below to surface JSON errors
  }).pipe(
    Effect.mapError((cause) =>
      new EventStoreError({ operation: "rowToStoredEvent", streamId: row.streamId, cause }),
    ),
  );
```

If `JSON.parse` itself can throw, lift it: `Effect.try({ try: () => JSON.parse(row.payload), catch: ... })` then chain into `Schema.decodeUnknown`.

When mapping rows, use `Effect.forEach(rows, rowToStoredEventEffect)` instead of `rows.map(rowToStoredEvent)`.

**Tests:**

- Valid row decodes successfully.
- Invalid JSON payload fails with typed error, not a defect.
- Invalid event shape fails with typed error if schema validation exists.

### Task 1.3: Remove Unsafe Dynamic Unbounded Concurrency

**Files:**
- Modify: `src/lib/domain/relay/Services/session-status-poller.ts` (line ~294)
- Modify: `src/lib/domain/daemon/Services/project-registry-service.ts` (line ~480)
- Modify or document: `src/lib/handlers/session.ts` (line ~217)

**Approach:**

- Replace dynamic `concurrency: "unbounded"` with a named limit. Use a local module-scoped constant unless a real daemon config field already exists or is introduced in the same slice.
- Use `{ discard: true }` whenever results are unused (broadcast loops, fire-and-forget side effects). Saves an `Array<void>` allocation each iteration.
- Fixed-size fanouts where the size is statically obvious from the call site (e.g., zipping four independent reads) can remain unbounded. Add a one-line comment naming the fixed size so a future reader does not have to count.

**Suggested limits (start values, tune via config later):**

| Site | Reason it grows | Suggested cap |
|---|---|---|
| `session-status-poller.ts:~294` | One per active instance | local `STATUS_CORRECTION_CONCURRENCY = 8` unless/until a real daemon config field is introduced |
| `project-registry-service.ts:~480` | One per project rehydrate | constant `4` (rehydration is bursty at startup; small cap protects SQLite) |
| `handlers/session.ts:~217` | Per-session fanout | inspect: if size is statically known per request, document and keep unbounded; otherwise cap at `8` |

**Sizing rule:** if the fanout size is unknowable at the `forEach` call site (e.g., it scales with whatever `Stream`/`Queue` upstream produces), do not pick a large arbitrary cap — instead bound the *inflow* with `Queue.bounded(n)` or `Stream.buffer({ capacity: n })` and keep the `forEach` concurrency small. Capping at the `forEach` while leaving inflow unbounded just moves the queue into Effect's internal scheduler with no backpressure signal to the producer.

**Tests:**

- Existing status poller tests still pass.
- Test that multiple corrections are processed with all expected side effects (no dropped work due to the new cap).
- For each capped site, add a test that submits more work than the cap and asserts all items complete (cap enforces serialization, not loss).

---

## Phase 2: Establish The Real Daemon Composition Root

**Goal:** Make the daemon process run through Effect ownership, not the imperative bridge.

**Files:**
- Modify: `src/bin/cli-core.ts`
- Modify: `src/lib/domain/daemon/Layers/daemon-main.ts`
- Modify: `src/lib/domain/daemon/Layers/daemon-layers.ts`
- Modify: `src/lib/domain/daemon/Services/daemon-config-ref.ts`
- Review: `docs/plans/2026-05-07-daemon-effect-phase8-plan.md`
- Review: `docs/plans/2026-05-07-daemon-effect-phase8-audit-r2.md`

**Approach:**

1. Treat the Phase 8 plan as the detailed implementation reference, but re-check every code snippet against current `main`.
2. Finish `DaemonConfigRef` / runtime daemon state so mutable daemon state is held in `Ref`, not local `let` variables.
3. Move config persistence, startup, crash counting, keep-awake, TLS, version checking, storage monitor, and port scanner into scoped Layers.
4. Add a `DaemonWiringLive` Layer for cross-service subscriptions. Do not hide bus subscriptions inside unrelated services.
5. Compose with `Layer.provideMerge` where downstream services still need foundation tags. Do not accidentally strip transitive dependencies with `Layer.provide`.
6. **Do not introduce a product runtime flag.** The remaining daemon migration targets a single production owner, not
   `--daemon-runtime=effect|legacy`. Treat HTTP/WS routing ownership and project relay ownership as prerequisites to
   the CLI cutover. After Phase 3 and Phase 4 remove the injected router/relay assembly from the daemon path, build the
   Effect daemon path to smoke parity on the branch, then cut `cli-core.ts` over to
   `NodeRuntime.runMain(Layer.launch(makeDaemonLive(options)))` in the same slice that removes the
   `startDaemonProcess` import.
   - Rollback is a branch or PR revert, not a runtime mode that preserves two daemon owners.
   - A branch-local comparison harness is acceptable if it is test-only and cannot ship as a supported operator path.
   - The cutover slice must include the behavior smoke list from Phase 0 step 5, integration tests, and daemon E2E
     coverage before it can claim `startDaemonProcess` is retired.
7. Delete or quarantine `startDaemonProcess` in the cutover slice. Do not reclassify it as an allowed runtime-boundary
   exception.

**High-risk entrypoint rule:**

Use `NodeRuntime.runMain(Layer.launch(makeDaemonLive(options)))` for the daemon process. `Layer.launch` alone is not enough because it does not install process signal handling.

**Cutover gate (high-risk, write code):**

```typescript
// src/bin/cli-core.ts
await NodeRuntime.runMain(Layer.launch(makeDaemonLive(options)));
```

The Effect daemon path must satisfy the same observable behavior as the current daemon before this replacement lands.
The smoke list in Phase 0 step 5 is the contract. This gate is not reachable while `DaemonLiveOptions` still requires
externally assembled router or project-relay objects.

**Tests:**

- Unit tests for state/config/TLS/startup Layers.
- Integration tests for daemon start/stop and IPC commands.
- Daemon E2E only after the entrypoint switch:

  ```bash
  pnpm check
  pnpm test:unit
  pnpm test:integration
  OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" pnpm test:daemon
  ```

**Commit shape:**

- One commit per daemon service Layer.
- One commit for composition wiring.
- One commit for CLI entrypoint switch and bridge deletion.

---

## Phase 3: Make HTTP And WebSocket Routing Effect-Owned

**Goal:** Remove duplicate routing where Effect Layers exist but real behavior still happens in imperative daemon callbacks.

**Files:**
- Modify: `src/lib/domain/server/Layers/ws-routing-layer.ts`
- Modify: `src/lib/domain/server/Layers/http-server-layer.ts`
- Modify: `src/lib/domain/relay/Layers/ws-transport-layer.ts`
- Modify: `src/lib/domain/server/Services/static-file-handler.ts`
- Modify: `src/lib/domain/server/Layers/auth-middleware.ts`
- Modify: `src/lib/domain/daemon/Layers/daemon-layers.ts`
- Delete or stop using equivalent imperative routing in `src/lib/domain/daemon/Layers/daemon-main.ts`

**Approach:**

1. Make `WebSocketRoutingLive` attach the actual upgrade behavior, or remove it from production composition until it does.
2. Own `/p/<slug>` project dispatch inside the Effect route graph.
3. Keep the `ws` library callback boundary thin: callback receives socket/request, immediately hands off to an Effect program using the daemon runtime.
4. Replace daemon-state callback provider objects (`ProjectsProvider`, `HealthProvider`, `SetupInfoProvider`,
   `RemoveProjectProvider`, and similar one-method route data ports) with Effect services backed by daemon/project/config
   state. Callback-shaped providers are allowed only for true external APIs, and even then the callback edge must
   normalize into Effect immediately.
5. Auth, static files, health, info, setup, project routes, and project WS upgrades should be one route graph with typed
   route errors and one top-level error renderer. Malformed URI decoding, auth failures, missing projects, and handler
   failures should be represented as typed route failures, not thrown exceptions or ad hoc callback return values.
6. Do not keep two route owners serving the same behavior in production. Current production routing is already Effect-shaped in places; the remaining work is to remove callback/provider bridges and put the route data reads behind Effect services.

**Transition slice order (mandatory — do not collapse into one PR):**

Each slice = (a) move the route or upgrade path fully into the Effect route graph, (b) remove the remaining legacy callback/provider bridge for that route, (c) probe green, (d) commit. Smaller surface first.

1. **WS upgrade path** — smallest surface, isolated callback. Easiest to roll back.
2. **`/health`, `/info`, `/setup`** — unauthenticated, simple responses. Validates the route graph plumbing without auth complexity.
3. **`/p/<slug>` project dispatch** — the routing decision the daemon mostly exists to make. Verify slug 404 → typed rejection, valid slug → relay.
4. **Auth middleware + protected routes** — highest churn, do last so the route graph is already proven.
5. **Static file handler** — last because the catch-all is what masks bugs in earlier slices; if a slice misroutes, static catches it silently. Removing static last forces real 404s.

Each slice runs the route probe list below before commit. Do not advance to the next slice until the previous slice's probes are green in CI.

**Route probes that must exist:**

- `GET /health` after startup returns expected status.
- After shutdown, `/health` refuses or fails reliably.
- `GET /p/<slug>/...` reaches the project route and does not fall through to static catch-all.
- Malformed JSON body returns the intended `400` envelope.
- Provider/handler failure returns the intended error envelope.
- WS upgrade for unknown project slug returns the intended rejection.

**Tests:**

```bash
pnpm vitest run test/unit/effect test/unit/server
pnpm test:integration
pnpm test:e2e --grep "project"
```

---

## Phase 4: Convert Relay To Hybrid CQRS Ownership

**Goal:** Replace `createProjectRelay()` as an imperative factory with a scoped per-project relay Layer, and make the relay's domain flow command/event/projector/read-model based before more handler/provider migration work piles onto the old shape.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`
- Modify: `src/lib/domain/daemon/Layers/relay-factory-layer.ts`
- Modify: `src/lib/domain/relay/Layers/relay-layer.ts`
- Create or modify: `src/lib/domain/relay/*`
- Create or modify: `src/lib/contracts/*`
- Modify: `src/lib/relay/sse-stream.ts`
- Modify: `src/lib/domain/relay/Services/sse-stream.ts`
- Modify: `src/lib/relay/message-poller.ts`
- Modify: `src/lib/relay/message-poller-impl.ts`
- Modify: `src/lib/relay/pty-manager.ts`
- Modify: `src/lib/relay/pty-upstream.ts`
- Modify: `src/lib/domain/relay/Services/services.ts`

**Approach:**

1. Keep the per-project relay as the deployment unit. Do not introduce a daemon-global engine in this phase.
2. Define the relay domain contracts:
   - `RelayCommand`: user/provider/system commands accepted by a project relay.
   - `RelayEvent`: durable events emitted by command decisions and provider streams.
   - `RelayReadModel`: rebuildable relay state used by command decisions and read APIs.
3. Implement pure domain functions before wiring them to runtime services:
   - `decideRelayCommand(readModel, command) -> readonly RelayEvent[]`
   - `projectRelayEvent(readModel, event) -> RelayReadModel`
   These functions should not depend on Effect, SQL, provider SDKs, WebSockets, clocks, or filesystem state.
4. Use the existing SQLite event store as the source of truth. New domain events should either map onto the existing persisted event model or intentionally extend it through the persistence migration story. Do not create an in-memory-only event history that becomes another truth source.
5. Add a per-relay command gate. Incoming RPC/WS/provider commands are queued or backpressured until persisted replay, initial projection, event subscriptions, and reactors are ready. Dispatch must be ordered.
6. Add a per-relay domain event bus for in-process reactors such as status updates, metrics, snapshot maintenance, and browser fanout. The bus must document its overflow policy:
   - Default target: persisted events plus bounded signal/replay, so slow reactors can catch up from SQLite.
   - `PubSub.unbounded` is allowed only with an explicit written justification in the phase PR because it turns memory into the backpressure buffer.
7. Define a `ProjectRelay` service tag whose methods return Effects for `handleClient`, `dispatchCommand`, `subscribe`, `broadcast`, `stop`, and status/read-model inspection. `ProjectRelayLive` / the scoped relay Layer is the long-term constructor and resource owner.
8. Convert relay-local state to Effect state services:
   - session overrides: `Ref` / existing Effect state module
   - session registry: `Ref<HashMap<...>>`
   - pollers: `FiberMap`
   - PTY sessions: `FiberMap` or scoped service with explicit typed state
9. Replace `Layer.succeed(Tag, instance)` bridge Layers with real `Layer.effect` / `Layer.scoped` constructors.
10. Reduce `createProjectRelay()` to a temporary Promise-shaped compatibility wrapper around the scoped Layer while
   daemon/project-registry consumers are migrated. It must not remain the production owner of relay construction.
11. Convert SSE and polling loops to `Stream` + `Schedule` + scoped fibers.
12. Treat relay shutdown as Scope closure. Manual `stop()` can remain as a public compatibility method during transition, but internally it should close the Scope, not drain a hand-written list of services.
13. Keep all client-driven handlers using the same relay runtime; do not create per-message runtimes.

**Scope ownership rules (state explicitly to avoid invention):**

- The daemon owns the **root Scope**.
- Each project relay owns a **child Scope** rooted in the daemon Scope. Project teardown closes the child Scope only; daemon shutdown closes the root, which transitively closes all project children.
- Browser/WS clients **borrow** the project Scope — they do not own a Scope of their own. A client disconnect does not close the project Scope; it only removes the client from the per-project client `Ref<HashMap>`.
- For the per-project relay cache, use `ScopedRef` per the conventions doc — swapping a project relay (e.g., on config change) must close the old Scope before installing the new one.

**Test isolation reminder:** every `Ref` / `HashMap` / `FiberMap` introduced in this phase is stateful. Every `it.effect` / `it.scoped` that provides a Layer holding such state must wrap it in `Layer.fresh(...)` (see `docs/plans/effect-ts-next-wave/conventions.md` H5). Concurrent vitest workers will share state otherwise.

**High-risk resource pattern:**

Use `Layer.scoped` for every relay service that owns sockets, pollers, intervals, or background work:

```typescript
export const PollerManagerLive = Layer.scoped(
  PollerManagerTag,
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<string>();
    return makePollerManager({ fibers });
  }),
);
```

Do not store `Map<string, RuntimeFiber>` and interrupt manually unless an external library forces it.

**Tests:**

- Pure decider tests for every command branch, including duplicate/idempotent command handling.
- Pure projector tests proving replay rebuilds the same read model from persisted events.
- Command gate tests proving commands sent before relay readiness dispatch after startup, in order, and do not race reactors.
- Event bus tests proving slow reactors either backpressure or catch up from replay according to the documented policy.
- Relay starts and stops without leaked pollers.
- Interrupting the relay scope interrupts SSE and PTY fibers.
- Session lifecycle events still reach the event store and browser clients.
- Run:

  ```bash
  pnpm vitest run test/unit/relay test/unit/effect
  pnpm test:integration
  ```

---

## Phase 5: Migrate Production Persistence To Effect SQL

**Goal:** Make the SQLite event store and projectors Effect-native in production, not just in parallel test modules.

**Files:**
- Modify: `src/lib/persistence/persistence-layer.ts`
- Modify: `src/lib/persistence/sqlite-client.ts`
- Modify: `src/lib/persistence/event-store.ts`
- Modify: `src/lib/persistence/projection-runner.ts`
- Modify: `src/lib/persistence/effect/event-store-effect.ts`
- Modify: `src/lib/persistence/effect/projection-runner-effect.ts`
- Modify consumers in `src/lib/domain/daemon/Layers/daemon-main.ts`, `src/lib/domain/daemon/Layers/relay-factory-layer.ts`, `src/lib/relay/relay-stack.ts`
- Test helpers: `test/helpers/persistence-factories.ts`

**Approach:**

0. **Task 5.0 — schema migration story (do first, blocking).** This is the highest data-risk change in the plan. Before any production consumer is switched:
   - Inventory the existing SQLite schema (`PRAGMA table_info(...)` for every table the daemon writes) and record the current summary in the live progress doc, with detailed output elsewhere if it is large.
   - Compare against what `@effect/sql-sqlite-node` + the new typed services will expect. List every diff (column types, indexes, constraint changes).
   - Use the `@effect/sql` Migrator instead of inventing a custom migration table/checksum system. Follow the t3code-style static migration registry: numbered migration modules imported into one `migrationEntries` record, then run by the Effect SQL migrator during `PersistenceLive` startup.
   - Keep migrations forward-only and transaction-wrapped. If the current Effect 3.x Migrator API shape differs from older examples, verify it against the installed package/source before implementing; do not reach for ad hoc SQL string bookkeeping.
   - Dry-run the migration on a copy of a real production DB before any consumer switch. Record before/after row counts per table.
   - Document the rollback procedure: since migrations are forward-only, rollback = restore from backup. Ship one release with the migration but no consumer switch, so the migration runs and is observed before any read/write path changes.
1. Introduce one production `PersistenceLive` Layer backed by `@effect/sql-sqlite-node`.
2. Move event append, event read, cursor updates, and projector writes into typed Effect services.
3. Use `SqlClient.withTransaction` for append + version update + projection cursor operations that must be atomic.
4. **Delete the mutable version cache.** The plan's earlier draft offered a `Ref<HashMap<StreamId, Version>>` as an alternative; that reintroduces a consistency window across fibers (and across processes if SQLite is opened with WAL elsewhere). `SELECT max(version) FROM events WHERE stream_id = ?` with a composite index on `(stream_id, version)` is cheap. Caching version is a footgun with no measurable win at conduit's scale.
5. Convert projector recovery to `Effect.ensuring` / scoped state instead of `try/finally` around yielded effects.
6. Update production consumers to depend on the Effect persistence services directly.
7. Delete or reduce `PersistenceLayer.open(...)` only after all production consumers are migrated. Per the bridge-deletion policy in the principles section, this deletion happens in the same PR as the last consumer migration, not deferred to Phase 9.

**High-risk transaction rule:**

Version assignment and append must be one transaction. The deletion of the version cache (point 4) means the version `SELECT` and the `INSERT` must be inside the same `SqlClient.withTransaction` block. Do not split them.

**Test isolation reminder:** persistence Layers built on a `:memory:` SQLite are per-test stateful. Wrap in `Layer.fresh(...)` for every `it.effect` that provides them (conventions doc H5).

**Tests:**

- Append increments stream version atomically.
- Concurrent appends to same stream cannot duplicate versions.
- Invalid stored payload fails as typed error.
- Projector recovery resumes from cursor after failure.
- Existing persistence factory tests still pass.

**Verification:**

```bash
pnpm vitest run test/unit/persistence
pnpm test:integration
pnpm test:contract
```

---

## Phase 6: Convert Provider Drivers And Orchestration

**Goal:** Make provider execution Effect-native while keeping OpenCode and Claude SDK quirks at the provider instance edge.

**Files:**
- Modify: `src/lib/provider/types.ts`
- Modify: `src/lib/provider/provider-registry.ts`
- Modify: `src/lib/provider/opencode-provider-instance.ts`
- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Modify: `src/lib/provider/event-sink.ts`
- Modify: `src/lib/provider/relay-event-sink.ts`
- Modify: `src/lib/provider/orchestration-engine.ts`
- Modify: `src/lib/provider/claude/effect-prompt-queue.ts`
- Modify provider consumers in `src/lib/handlers/prompt.ts`, `src/lib/relay/relay-stack.ts`, and orchestration service files

**Approach:**

1. Replace singleton-style provider instance services with a plain-value driver model:
   - `ProviderDriver` is a value registered with `ProviderInstanceRegistry`.
   - `ProviderDriver.create(input)` returns a scoped `ProviderInstance`.
   - `ProviderInstance` methods return Effects and close over instance-local SDK clients, prompt queues, event sinks, and cancellation state.
   - Do not create one `Context.Tag` per driver or provider instance; tags are runtime singletons and are the wrong shape for many instances of the same provider.
2. Change provider instance contracts from Promise-returning methods to Effect-returning methods.
3. Replace `AbortSignal` as the internal cancellation model with fiber interruption. Only create `AbortController` at OpenCode/Claude HTTP/SDK boundaries. **The interrupt → abort translation must be explicit** (see high-risk pattern below) — otherwise interrupted fibers leak in-flight HTTP/SDK calls.
4. Replace ad hoc deferred maps with Effect `Deferred`, `Queue`, `FiberMap`, or scoped `Ref<HashMap<...>>`.
5. Convert `ProviderInstanceRegistry` into the Layer-backed service with typed lookup failures. It owns registered driver values and live instances; the drivers themselves remain plain values.
6. Keep Claude SDK AsyncIterable and permission bridges as external boundaries, but ensure all errors are normalized before entering app logic. For the SDK's AsyncIterable, the canonical bridge is `Stream.fromAsyncIterable(iter, (cause) => new ProviderError({ cause }))` — do **not** hand-roll a `Stream.async` wrapper with manual push/close, as it duplicates what `fromAsyncIterable` already handles correctly.
7. Remove `as unknown` / `as any` assertions unless a third-party SDK type forces one; document the reason inline.

**High-risk pattern (fiber interrupt → AbortController bridge — write code):**

```typescript
const sendTurn = (input: SendTurnInput) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.tryPromise({
        try: () => sdk.send(input, { signal: controller.signal }),
        catch: (cause) => new ProviderError({ providerId, cause }),
      }),
    (controller, exit) =>
      Exit.isInterrupted(exit)
        ? Effect.sync(() => controller.abort())
        : Effect.void,
  );
```

The `acquireUseRelease` finalizer fires on interrupt as well as success/failure; checking `Exit.isInterrupted` ensures `abort()` only fires on interruption (calling `abort()` after a successful response is harmless but noisy). Without this bridge, fiber interruption returns control to the caller while the underlying HTTP/SDK call keeps running until its own timeout — leaks sockets, leaks tokens, possibly delivers a response after the caller has moved on.

**High-risk pattern (Claude SDK AsyncIterable):**

```typescript
const stream = Stream.fromAsyncIterable(
  sdk.streamTurn(input, { signal: controller.signal }),
  (cause) => new ProviderError({ providerId: "claude", cause }),
);
```

Do not wrap in `Stream.async` and re-implement iteration — `fromAsyncIterable` handles backpressure and finalization correctly.

**Test isolation reminder:** provider state (`Deferred` maps, `FiberMap` of in-flight turns, `Ref<HashMap>` of pending requests) is per-test stateful. Wrap every test Layer in `Layer.fresh(...)`.

**High-risk contract shape:**

```typescript
export interface ProviderDriver<R = never> {
  readonly providerId: string;
  readonly create: (
    input: ProviderCreateInput,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
}

export interface ProviderInstance {
  readonly providerId: string;
  readonly discover: Effect.Effect<ProviderDiscovery, ProviderError, never>;
  readonly sendTurn: (
    input: SendTurnInput,
  ) => Effect.Effect<TurnResult, ProviderError | ProviderCancelled, ProviderRuntimeDeps>;
  readonly interruptTurn: (
    sessionId: string,
  ) => Effect.Effect<void, ProviderError, ProviderRuntimeDeps>;
}
```

The exact types can differ, but expected provider failures must be in `E`, and app dependencies must be in `R`.

**Tests:**

- OpenCode provider instance success, API failure, cancellation, and pending-turn cleanup.
- Claude provider instance success, permission question, denial, cancellation, and SDK failure normalization.
- Event sink resolves/rejects deferred requests on completion and interruption.
- Orchestration idempotency still prevents duplicate command processing.

**Verification:**

```bash
pnpm vitest run test/unit/provider test/unit/handlers/prompt*
pnpm test:integration
pnpm test:e2e --grep "prompt"
```

---

## Phase 7: Convert Handler Service Contracts And RPC-Over-WS Protocol

**Goal:** Migrate browser/server operations to shared Effect RPC over WebSocket in vertical slices, converting the service contract behind each operation as part of that slice. Do not continue hardening the legacy handler dispatcher as the long-term shape.

**Files:**
- Modify: `src/lib/contracts/*`
- Modify: `src/lib/domain/relay/Services/services.ts`
- Modify: `src/lib/handlers/index.ts`
- Modify: `src/lib/handlers/session.ts`
- Modify: `src/lib/handlers/model.ts`
- Modify: `src/lib/handlers/files.ts`
- Modify: `src/lib/handlers/terminal.ts`
- Modify: `src/lib/handlers/permissions.ts`
- Modify: `src/lib/handlers/settings.ts`
- Modify: `src/lib/handlers/instance.ts`
- Modify: `src/lib/frontend/transport/*`
- Modify handler test helpers in `test/helpers/mock-factories.ts`

**Approach:**

1. Define the browser-facing operation in `src/lib/contracts/*` before implementing or refactoring its server handler.
2. Add the server RPC handler and contract/client tests for that operation.
3. Convert the service methods needed by that operation from Promise methods to Effect methods in the same vertical slice.
4. Switch the frontend call site to the typed RPC call or stream.
5. Delete the legacy WS message type, decoder branch, dispatcher branch, and bridge mock helpers for that operation before moving to the next one.
6. Replace broad `Effect.catchAll` with `catchTag` where the error is expected and recoverable.
7. Keep WebSocket as the transport. The target is RPC-over-WS, not polling and not a global browser state channel.
8. Use Schema/RPC decoding at handler boundaries, then domain types internally.

**Implementation order:**

1. Read-only OpenCode API calls used by files/model/settings.
2. Session manager methods.
3. Permission/question bridge methods.
4. PTY methods.
5. Instance/project management methods.

**Wire protocol rule:**

Legacy WS handlers that have not moved to RPC yet should remain behavior-preserving maintenance surfaces only; do not spend migration effort converting or hardening them as the target architecture. Focused legacy wire snapshots remain a safety net for bug fixes or branch-local refactors before a handler's RPC slice lands. For handlers moving to RPC, the protocol change is intentional and must be coordinated in one vertical slice:

1. Add the shared RPC declaration.
2. Add server handler tests through the RPC client/test helper.
3. Switch the frontend call site to the typed RPC client/stream.
4. Delete the legacy WS message type, decoder branch, and dispatcher branch.

Do not snapshot the new RPC wire envelope as a substitute for shared contracts; the contract compile/test boundary is the guardrail.

**Tests:**

- Handler tests should use `@effect/vitest`.
- Each converted service gets a test Layer, wrapped in `Layer.fresh(...)` (every handler service holds Refs / Deferreds / FiberMaps).
- Legacy wire snapshots are a migration safety net only. A handler slice that moves to RPC should assert shared contracts and delete the old message instead of preserving the legacy envelope.
- RPC slices need server/client contract tests and at least one frontend transport test proving the typed stream/call is consumed correctly.
- Run a narrow handler slice after each service conversion:

  ```bash
  pnpm vitest run test/unit/handlers
  pnpm check
  ```

---

## Phase 8: Frontend RPC Transport And Effect Boundary Cleanup

**Goal:** Keep the frontend pragmatic: Effect owns shared contract validation, RPC-over-WS transport lifecycle, and long-lived streams, not every Svelte UI timer.

**Files:**
- Modify: `src/lib/frontend/transport/runtime.ts`
- Modify: `src/lib/frontend/stores/ws.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-send.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`
- Modify: `src/lib/frontend/transport/schemas.ts`
- Review only: local UI components with incidental timers

**Approach:**

1. Keep one frontend `ManagedRuntime` for transport.
2. Use the shared contracts/RPC group for browser/server communication. Remove hand-written decoders as each legacy message type is replaced.
3. Preserve per-tab state: active project/session/thread selection belongs in route/Svelte state for that browser tab, while durable data comes from RPC streams/read models.
4. Ensure any remaining legacy WebSocket message parsing never silently swallows schema errors that matter for protocol correctness. Bad server messages should be logged or surfaced in debug state.
5. Make reconnection and active-stream interruption explicit with typed transport errors.
6. Do not migrate local UI timers unless they represent protocol state, connection state, or durable workflow state.

**Tests:**

- RPC calls/streams fail through typed contract errors for malformed payloads.
- Reconnect interrupts old stream before starting new stream.
- Opening a different session in one browser tab does not mutate another tab's active-session state.
- Send queue drain behavior remains unchanged.

**Verification:**

```bash
pnpm check:frontend
pnpm vitest run test/unit/stores test/unit/frontend
pnpm test:e2e --grep "websocket"
```

---

## Phase 9: Confirm Greps, Document Allowed Exceptions, Update Docs

**Goal:** End with a codebase where Effect ownership is true, not decorative. Per the bridge-deletion policy in the principles section, bridges are deleted in the same PR as their last consumer migration — **Phase 9 should not be deleting code**. If this phase finds a bridge still alive, the previous phase missed its exit criteria and must be re-opened.

**Files:**
- Update docs:
  - `docs/agent-guide/architecture.md`
  - `docs/agent-guide/testing.md`
  - live progress doc (mark complete, record final grep counts)
- Audit, do not delete: confirm these are already gone or explicitly reclassified:
  - `src/lib/domain/relay/Layers/relay-layer.ts` should remain only if it has become the scoped `ProjectRelay` owner; it must not be deleted merely because old bridge code lived nearby.
  - bridge-only sections of `src/lib/domain/relay/Services/services.ts` (deleted incrementally Phases 4–7)
  - bridge-only code in `src/lib/relay/relay-stack.ts` (deleted when scoped relay ownership lands)
  - unused class-based persistence wrappers (deleted in Phase 5)

**Required grep gates:**

These commands should return no app-internal violations, with only documented external-boundary exceptions:

```bash
rg -n "startDaemonProcess" src
rg -n "PersistenceLayer\\.open" src
rg -n "Effect\\.promise" src
rg -n "concurrency: \"unbounded\"" src
rg -n "(Effect|Runtime|ManagedRuntime)\\.run(Promise|Sync)|\\.run(Promise|Sync)\\(" src/lib
rg -n "(Effect|Runtime|ManagedRuntime)\\.run(Promise|Sync)|\\.run(Promise|Sync)\\(" src/bin
rg -n "Layer\\.succeed\\([^\\n]+Tag, [a-zA-Z0-9_]+\\)" src/lib/relay src/lib/domain
```

**Allowed external-boundary exceptions (pre-enumerated — reviewers should reject any others):**

| Pattern | Allowed location | Why |
|---|---|---|
| `Effect.runPromise` | `src/lib/instance/sdk-factory.ts` inside the returned `fetch` callback only | OpenCode SDK and GapEndpoints require a standard Promise-shaped Fetch callback; the callback delegates to the Effect retry transport |
| `Effect.runPromise` | `src/lib/provider/claude/claude-permission-bridge.ts` inside the SDK `canUseTool` callback only | Claude Agent SDK requires a Promise-returning permission callback; the EventSink wait remains Effect-returning internally |
| `Effect.runSync` | `src/lib/domain/server/Layers/http-router-layer.ts` inside `makeStandaloneHttpRouterRequestHandler` only | Standalone relay HTTP compatibility adapter; daemon HTTP handler construction must stay inside the router Layer |
| `.runPromise` | `src/lib/frontend/transport/runtime.ts` inside `runTransportEffect` only | Frontend store/transport callers are Promise-shaped; all frontend transport effects share this one app-lifetime runtime boundary |
| `.runPromise` | `src/lib/relay/relay-stack.ts` inside `createProjectRelay()` startup only | Public relay factory API returns a Promise while the startup Effect owns acquisition, wiring, and readiness |
| `NodeRuntime.runMain` | `src/bin/cli-core.ts` daemon process entrypoint only | Process entrypoint owns the top-level Effect runtime; it should not use `Effect.runPromise` / `Effect.runSync` |
| `ws` library callback | `src/lib/domain/server/Layers/ws-routing-layer.ts` | Library callback boundary; immediately hands off to Effect |
| `Effect.promise` | only inside finalizers where the promise is provably non-rejecting, with inline comment | Some Node APIs return `Promise<void>` that cannot reject |
| `concurrency: "unbounded"` | none (every site must be capped or documented as a fixed-size fanout with inline comment naming the size) | Plan rule |
| `Layer.succeed(Tag, instance)` for a pre-constructed imperative instance | none in `src/lib/relay`, `src/lib/domain`; allowed in `src/bin/cli-core.ts` only if wrapping a CLI option object | Bridge anti-pattern |
| AbortController construction | only inside provider instances (`src/lib/provider/opencode-provider-instance.ts`, `src/lib/provider/claude/claude-provider-instance.ts`) | SDK boundary; bridged to fiber interrupt per Phase 6 |

**Known non-exceptions:**

- `Effect.runPromise` inside daemon IPC dispatch is an internal daemon socket-server ownership gap. It must move
  into an Effect-owned IPC server or the top-level daemon runtime before completion.
- `Effect.runSync(NodeHttpServer.makeHandler(...))` in `src/lib/relay/relay-stack.ts` or
  `src/lib/domain/daemon/Layers/daemon-main.ts` is an internal HTTP ownership gap. Do not hide it behind a helper; remove it by
  moving HTTP serving into the scoped server Layer.
- `Effect.runPromise` / `Effect.runSync` in relay callbacks, orchestration, handlers, or daemon services is a blocker
  unless the call site is one of the allowed external-boundary rows above.

For any `Effect.runPromise` / `Effect.runSync` hit not on the allowed table, the PR must eliminate it or explicitly
re-open the owning phase; extending the allowlist is not enough.

**Full verification:**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:e2e --grep "session|websocket|project"
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

---

## Completed Implementation Order

This was the authoritative order used for the final conversion. It superseded the older phase-number order whenever
they conflicted. The corresponding completion state now lives in
`docs/plans/2026-05-14-effect-ts-mainline-live-progress.md`.

1. Effect version freeze and post-migration v4 record.
   - Keep the mainline migration on Effect 3.x and the current package set.
   - Do not introduce `effect@4.0.0-beta.*`, v4 `effect/unstable/*` imports, or v4-only package topology while the
     guardrail checklist is still open.
   - Create a short post-migration follow-up note for evaluating Effect v4 after daemon, relay, RPC, provider, and
     guardrail ownership are complete. That note should preserve the package-shape findings from planning: v4 RPC lives
     under `effect/unstable/rpc`; `@effect/rpc` remains the Effect 3 package; and package availability/versioning for
     `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/vitest`, `@effect/platform`, and
     `@effect/rpc` must be rechecked at the time of the v4 migration.

2. Domain organization move-only PR.
   - Move flat Effect/service files into domain-owned `Services` / `Layers` folders.
   - Keep behavior unchanged. This PR should be reviewable as moves/import rewrites only.
   - Add static guards so new production services do not accumulate in the old flat `src/lib/domain/*` bucket.

3. Persistence migration runner alignment.
   - Use `@effect/sql` Migrator and a static numbered migration registry for future schema changes.
   - Do this before any new durable relay event schema requires SQLite migration.

4. Contracts and RPC boundary.
   - Add the shared contracts boundary for pure schemas, domain protocol declarations, and RPC groups.
   - Use strict `src/lib/contracts/*` for this migration. Do not introduce a workspace contracts package in this plan.
   - Add a static guard preventing contracts from importing daemon, relay runtime, provider implementation, frontend
     stores/components, persistence implementation, or service/Layer implementation code.
   - Define `WsRpcGroup` for browser/server messages and streams before handler migration.
   - Use current Effect 3.x / `@effect/rpc@0.75.1` APIs. Do not use v4 unstable RPC.
   - Prove frontend and server import the same contract declarations.

5. Hybrid relay domain model.
   - Define relay commands, events, and read models.
   - Implement pure deciders and projectors.
   - Rebuild the relay read model from persisted events.
   - Add the command gate so incoming commands cannot race relay replay/reactor startup.
   - Add a per-relay event bus with an explicit bounded/replay/backpressure policy.

6. Router service ownership and HTTP runtime boundary.
   - Replace daemon-state route provider callbacks (`ProjectsProvider`, `HealthProvider`, `SetupInfoProvider`,
     `RemoveProjectProvider`, and equivalents) with Effect services over daemon/project/config state.
   - Move HTTP serving into the scoped server Layer so `src/lib/domain/daemon/Layers/daemon-main.ts` and
     `src/lib/relay/relay-stack.ts` no longer construct Node handlers with app-internal `Effect.runSync(...)`.
   - Keep the `ws` callback as a thin external boundary that immediately hands off to Effect.

7. Scoped project relay ownership.
   - Promote `ProjectRelayLive` / the scoped relay Layer to the production relay constructor around the new relay
     command/event/read-model core.
   - Reduce `createProjectRelay()` to a temporary compatibility wrapper, then delete it once daemon/project-registry
     consumers use the Layer-owned relay service.
   - Remove prebuilt relay object injection from `relay-stack.ts`, especially the live `Layer.succeed(...)` hits for
     OpenCode API, config, logger, WebSocket handler, status poller, and instance management.

8. RPC-over-WS vertical migration.
   - Keep WebSocket transport.
   - Migrate one browser-facing operation at a time to typed RPC declarations, server handlers, and frontend client
     calls/streams.
   - Delete each old WS message type, decoder, and dispatcher branch in the same slice as its RPC replacement.
   - Preserve per-browser-tab route/client state; do not move active-tab focus into daemon state.

9. Provider driver and instance ownership.
   - Move provider execution to the plain `ProviderDriver -> scoped ProviderInstance` shape.
   - Keep only the provider instance registry as a Context service.
   - Normalize OpenCode/Claude SDK errors and cancellation at the provider boundary.

10. IPC socket ownership.
   - Move Unix socket request dispatch out of the callback-local `Effect.runPromise(...)` path in
     `src/lib/daemon/daemon-lifecycle.ts`.
   - The target is either an Effect-owned IPC socket server or a handoff through the same top-level daemon runtime; do
     not hide the bridge behind a helper.

11. Daemon composition readiness.
   - Shrink `DaemonLiveOptions` so `makeDaemonLive(...)` no longer needs externally assembled router or project-relay
     objects.
   - Add or finish `DaemonWiringLive` only for real cross-service subscriptions; do not use it as a bucket for callback
     bridges.
   - Run branch-local daemon parity checks. Do not add a product `--daemon-runtime` flag.

12. Single-owner daemon cutover.
   - Cut `src/bin/cli-core.ts` over to `NodeRuntime.runMain(Layer.launch(...))`.
   - Remove the production `startDaemonProcess` import/calls and delete or quarantine the bridge export in
     `src/lib/domain/daemon/Layers/daemon-main.ts` in the same PR.
   - Re-run the behavior smoke list, integration tests, and daemon E2E before claiming this blocker closed.

13. Final guardrail cleanup.
   - Update static guard tests so internal runtime entry hits cannot be allowlisted except for
     the external callback and compatibility boundaries named in Phase 9.
   - Triage throwing-helper greps by call path. Fix any helper called inside Effect programs with typed errors; explicitly
     reclassify ordinary defect/external-boundary throws.
   - Confirm `PersistenceLayer.open(...)`, rejectable `Effect.promise(...)`, and dynamic `concurrency: "unbounded"` remain
     absent from production `src`.

14. Final docs and verification.
   - Update `docs/agent-guide/architecture.md`, `docs/agent-guide/testing.md`, and the live progress doc with final
     grep counts and the surviving external-boundary exceptions.
   - Run the full verification list in Phase 9.

Each PR should include:

- One ownership boundary changed.
- Tests proving the boundary, not just mocks.
- A short grep summary showing which bridge patterns were reduced.
- No unrelated formatting churn.

## Final Definition Of Done

- CLI daemon startup no longer imports or calls `startDaemonProcess`.
- Production daemon runs through `NodeRuntime.runMain` and a scoped Layer graph.
- HTTP and WebSocket routing have one production owner.
- WebSocket remains the real-time transport, with shared RPC contracts replacing duplicated hand-rolled protocol schemas where browser/server operations have migrated.
- Shared contracts live in a pure contracts boundary imported by both server and frontend.
- Per-project relays remain the deployment unit and use command/event/projector/read-model internally.
- Relay command gates prevent command processing before replay, projection, subscriptions, and reactors are ready.
- Relay services are constructed by Layers, not bridge-wrapped class instances.
- Persistence production path is Effect SQL-backed and typed-error based.
- Provider execution APIs are Effect-returning internally, with provider drivers as plain values and provider instances scoped by Effect.
- Dynamic background work is supervised and scoped.
- Known anti-pattern greps are empty or contain only documented external-boundary exceptions.
- Effect v4 migration is explicitly deferred into a separate post-migration plan.
- Default, integration, contract, targeted E2E, and logged full test suites pass.
