# Effect.ts Mainline Completion Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Migrate the remaining high-value conduit runtime surfaces on `main` to idiomatic Effect.ts, and remove bridge code that gives false confidence that a path is Effect-native.

**Architecture:** Move ownership to one scoped Effect composition root, then convert each runtime boundary from the outside in. Use typed errors, Context Tags, Layers, `Ref` / `HashMap` / `FiberMap`, Streams, and scoped finalizers. Keep imperative code only at external callback boundaries such as Node process entry, `ws`, browser events, and third-party SDK adapters.

**Tech Stack:** `effect 3.21.x`, `@effect/platform`, `@effect/platform-node`, `@effect/sql`, `@effect/sql-sqlite-node`, `@effect/vitest`, Vitest, Svelte 5, Node.js, SQLite.

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
- External APIs may remain Promise/callback based only at the adapter edge; normalize them immediately with `Effect.tryPromise`, `Effect.async`, `Stream.async`, or `Effect.acquireRelease`.
- Expected failures are typed errors. Throwing, `Effect.die`, and plain `Error` are for defects or last-resort foreign errors.
- No `Effect.promise` for rejectable promises.
- No unbounded concurrency for collections whose size can grow with sessions, projects, instances, clients, or messages.
- No permanent bridge Layers that wrap already-constructed imperative instances with `Layer.succeed(Tag, instance)`.
- All long-lived resources are scoped. Shutdown should happen by Scope interruption, not hand-maintained `stop()` chains.
- Use `@effect/vitest` for Effect tests; use `Layer.fresh(...)` for stateful test Layers.

## Non-Goals

- Do not force incidental Svelte UI timers, debounce timers, copy-flash timers, or local animation state into Effect. Keep Effect on the frontend at protocol, schema, transport, and long-lived connection boundaries.
- Do not rewrite business behavior while migrating. Preserve wire protocol, project routing, persisted event format, and daemon CLI behavior unless a task explicitly says otherwise.
- Do not keep compatibility wrappers after a consumer is converted. Delete old imports and old implementations in the same PR whenever the change surface is local enough. **Bridge deletion is incremental, per phase.** Phase 9 only confirms the greps are clean and updates docs — its bridge-deletion list should already be empty by the time it runs. If a phase ends with a bridge still alive, that phase did not meet its own exit criteria.

## Current Mainline Targets

The audit found these primary migration islands:

- Daemon entrypoint and lifecycle: `src/bin/cli-core.ts`, `src/lib/effect/daemon-main.ts`, `src/lib/effect/daemon-layers.ts`
- HTTP/WS routing ownership: `src/lib/effect/ws-routing-layer.ts`, `src/lib/server/*`, `src/lib/effect/http-server-layer.ts`
- Relay composition and event sources: `src/lib/relay/relay-stack.ts`, `src/lib/relay/sse-stream.ts`, `src/lib/relay/message-poller*.ts`, `src/lib/relay/pty-*`
- Persistence: `src/lib/persistence/persistence-layer.ts`, `src/lib/persistence/effect/event-store-effect.ts`, `src/lib/persistence/effect/projection-runner-effect.ts`
- Provider adapters and orchestration: `src/lib/provider/types.ts`, `src/lib/provider/opencode-adapter.ts`, `src/lib/provider/claude/claude-adapter.ts`, `src/lib/provider/event-sink.ts`, `src/lib/provider/orchestration-engine.ts`
- Handler bridge services: `src/lib/effect/services.ts`, `src/lib/handlers/*`
- Known best-practice violations: `Effect.promise` in `src/lib/relay/session-lifecycle-wiring.ts`, throwing row decoders in persistence, dynamic `concurrency: "unbounded"` in pollers/registry code.

---

## Phase 0: Baseline, Guardrails, And Inventory

**Goal:** Make the migration measurable before changing behavior.

**Files:**
- Create: `docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md`
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

2. Capture baseline grep output in the progress doc, not as a committed generated artifact:

   ```bash
   rg -n "startDaemonProcess|Layer\\.succeed\\(|PersistenceLayer\\.open|Effect\\.promise|concurrency: \"unbounded\"|Effect\\.run(Promise|Sync)|throw new .*Error" src
   ```

3. Run the narrow baseline:

   ```bash
   pnpm check
   pnpm lint
   pnpm test:unit
   ```

4. If the baseline is not green, record exact failures in the progress doc and do not mix baseline repair with migration work.

5. Capture a behavior smoke checklist in the progress doc. Tests catch regressions in tested code; this migration mostly touches glue between tested units, so functional smoke must be re-run after every phase. Minimum list:

   - Cold daemon start, IPC `ping` round-trip, clean shutdown (no orphan processes).
   - Single-project chat round-trip with one provider (OpenCode or Claude).
   - Daemon restart preserves an in-flight session (event store rehydrates correctly).
   - Project relay disconnect + reconnect from a browser client.
   - Multi-instance: two projects active concurrently, no cross-talk.

   Record current pass/fail observations as the baseline, including the exact daemon CLI invocation used. Re-run after each phase before opening the PR.

6. Pin the Node version and `pnpm` version used for the baseline (`node --version`, `pnpm --version`) and record both in the progress doc. Effect minor versions are already pinned in `package.json`; the plan must not relax that pinning.

**Commit:**

```bash
git add docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md
git commit -m "docs(effect): add mainline migration progress checklist"
```

---

## Phase 1: Fix Best-Practice Violations First

**Goal:** Remove the risky Effect anti-patterns that can hide failures before broad rewiring begins.

### Task 1.1: Replace Rejectable `Effect.promise`

**Files:**
- Modify: `src/lib/relay/session-lifecycle-wiring.ts` (line ~234, `rebuildTranslatorFromHistory`)
- Modify: `src/lib/effect/daemon-layers.ts` (line ~91 `Effect.promise(close)` and line ~196 `Effect.promise(() => instance.drain())`)
- Audit: re-run `rg -n "Effect\\.promise\\(" src` and confirm every remaining hit is documented as non-rejecting at its call site.

**Approach:**

- Replace `Effect.promise(() => rebuildTranslatorFromHistory(...))` with `Effect.tryPromise`.
- Map rejection to a typed relay/session lifecycle error.
- For finalizers, do not just swap to `Effect.tryPromise` — finalizers cannot propagate failure to callers. Wrap the typed error in `Effect.catchAll(Effect.logError(...))` so a failing `close()` / `drain()` is logged at shutdown instead of silently swallowed.
- Keep any `Effect.promise` uses only where the promise is genuinely non-rejecting (e.g., adapters that only ever `resolve`), and add an inline comment explaining why.

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
- Modify: `src/lib/effect/session-status-poller.ts` (line ~294)
- Modify: `src/lib/effect/project-registry-service.ts` (line ~480)
- Modify or document: `src/lib/handlers/session.ts` (line ~217)

**Approach:**

- Replace dynamic `concurrency: "unbounded"` with a named limit. Source the limit from `DaemonConfig` if it scales with deployment (e.g., max instances), or from a local module-scoped constant if it is a code-level invariant.
- Use `{ discard: true }` whenever results are unused (broadcast loops, fire-and-forget side effects). Saves an `Array<void>` allocation each iteration.
- Fixed-size fanouts where the size is statically obvious from the call site (e.g., zipping four independent reads) can remain unbounded. Add a one-line comment naming the fixed size so a future reader does not have to count.

**Suggested limits (start values, tune via config later):**

| Site | Reason it grows | Suggested cap |
|---|---|---|
| `session-status-poller.ts:~294` | One per active instance | `daemonConfig.maxConcurrentInstances` (existing config), default 8 |
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
- Modify: `src/lib/effect/daemon-main.ts`
- Modify: `src/lib/effect/daemon-layers.ts`
- Modify: `src/lib/effect/daemon-config-ref.ts`
- Review: `docs/plans/2026-05-07-daemon-effect-phase8-plan.md`
- Review: `docs/plans/2026-05-07-daemon-effect-phase8-audit-r2.md`

**Approach:**

1. Treat the Phase 8 plan as the detailed implementation reference, but re-check every code snippet against current `main`.
2. Finish `DaemonConfigRef` / runtime daemon state so mutable daemon state is held in `Ref`, not local `let` variables.
3. Move config persistence, startup, crash counting, keep-awake, TLS, version checking, storage monitor, and port scanner into scoped Layers.
4. Add a `DaemonWiringLive` Layer for cross-service subscriptions. Do not hide bus subscriptions inside unrelated services.
5. Compose with `Layer.provideMerge` where downstream services still need foundation tags. Do not accidentally strip transitive dependencies with `Layer.provide`.
6. **Do not big-bang the entrypoint switch.** Introduce both daemon entry paths in parallel, gated by a runtime flag. Default stays `legacy` until CI matrix is green on `effect`. This is the highest-blast-radius commit in the plan; a flag gives a code-free revert.
   - Add CLI flag `--daemon-runtime=effect|legacy` (default `legacy`) and matching env var `CONDUIT_DAEMON_RUNTIME`.
   - In `cli-core.ts`, branch once on the flag: `effect` → `NodeRuntime.runMain(Layer.launch(makeDaemonLive(options)))`; `legacy` → existing `startDaemonProcess(options)`.
   - Run CI on both values until at least one full release cycle. Document the flag in the progress doc and in `docs/agent-guide/architecture.md`.
   - Flip default to `effect` only after the behavior smoke list (Phase 0 step 5) passes on `effect` and integration + daemon E2E suites are green.
   - Delete the `legacy` branch and `startDaemonProcess` only after the default has been `effect` for one release cycle with no regressions reported.
7. Delete or quarantine `startDaemonProcess` after the CLI no longer imports it on either branch.

**High-risk entrypoint rule:**

Use `NodeRuntime.runMain(Layer.launch(makeDaemonLive(options)))` for the daemon process. `Layer.launch` alone is not enough because it does not install process signal handling.

**Branch gate (high-risk, write code):**

```typescript
// src/bin/cli-core.ts
const runtime =
  options.daemonRuntime ?? process.env.CONDUIT_DAEMON_RUNTIME ?? "legacy";

if (runtime === "effect") {
  await NodeRuntime.runMain(Layer.launch(makeDaemonLive(options)));
} else {
  await startDaemonProcess(options);
}
```

Both branches must converge on the same observable behavior — the smoke list in Phase 0 step 5 is the contract.

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
- Modify: `src/lib/effect/ws-routing-layer.ts`
- Modify: `src/lib/effect/http-server-layer.ts`
- Modify: `src/lib/effect/ws-transport-layer.ts`
- Modify: `src/lib/effect/static-file-handler.ts`
- Modify: `src/lib/effect/auth-middleware.ts`
- Modify: `src/lib/effect/daemon-layers.ts`
- Delete or stop using equivalent imperative routing in `src/lib/effect/daemon-main.ts`

**Approach:**

1. Make `WebSocketRoutingLive` attach the actual upgrade behavior, or remove it from production composition until it does.
2. Own `/p/<slug>` project dispatch inside the Effect route graph.
3. Keep the `ws` library callback boundary thin: callback receives socket/request, immediately hands off to an Effect program using the daemon runtime.
4. Auth, static files, health, info, setup, project routes, and project WS upgrades should be one route graph with typed errors and one top-level error renderer.
5. Do not keep both `RequestRouter` and Effect routes serving the same behavior in production.

**Transition slice order (mandatory — do not collapse into one PR):**

Each slice = (a) move route to Effect, (b) remove from `RequestRouter`, (c) probe green, (d) commit. Smaller surface first.

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
pnpm test:e2e -- --grep "project"
```

---

## Phase 4: Convert Relay Composition And Event Sources

**Goal:** Replace `createProjectRelay()` as an imperative factory with a scoped relay Layer whose streams and fibers stop by Scope interruption.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`
- Modify: `src/lib/effect/relay-factory-layer.ts`
- Modify: `src/lib/effect/relay-layer.ts`
- Modify: `src/lib/relay/sse-stream.ts`
- Modify: `src/lib/effect/sse-stream.ts`
- Modify: `src/lib/relay/message-poller.ts`
- Modify: `src/lib/relay/message-poller-impl.ts`
- Modify: `src/lib/relay/pty-manager.ts`
- Modify: `src/lib/relay/pty-upstream.ts`
- Modify: `src/lib/effect/services.ts`

**Approach:**

1. Define a `ProjectRelay` service tag whose methods return Effects for `handleClient`, `broadcast`, `stop`, and status inspection.
2. Convert relay-local state to Effect state services:
   - session overrides: `Ref` / existing Effect state module
   - session registry: `Ref<HashMap<...>>`
   - pollers: `FiberMap`
   - PTY sessions: `FiberMap` or scoped service with explicit typed state
3. Replace `Layer.succeed(Tag, instance)` bridge Layers with real `Layer.effect` / `Layer.scoped` constructors.
4. Convert SSE and polling loops to `Stream` + `Schedule` + scoped fibers.
5. Treat relay shutdown as Scope closure. Manual `stop()` can remain as a public compatibility method during transition, but internally it should close the Scope, not drain a hand-written list of services.
6. Keep all client-driven handlers using the same relay runtime; do not create per-message runtimes.

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
- Modify consumers in `src/lib/effect/daemon-main.ts`, `src/lib/effect/relay-factory-layer.ts`, `src/lib/relay/relay-stack.ts`
- Test helpers: `test/helpers/persistence-factories.ts`

**Approach:**

0. **Task 5.0 — schema migration story (do first, blocking).** This is the highest data-risk change in the plan. Before any production consumer is switched:
   - Inventory the existing SQLite schema (`PRAGMA table_info(...)` for every table the daemon writes) and record it in the progress doc.
   - Compare against what `@effect/sql-sqlite-node` + the new typed services will expect. List every diff (column types, indexes, constraint changes).
   - Add a migration runner: a `migrations` table tracking applied versions, forward-only SQL files in `src/lib/persistence/migrations/`, and an Effect that runs pending migrations on `PersistenceLive` startup inside a transaction.
   - Dry-run the migration on a copy of a real production DB before any consumer switch. Record before/after row counts per table.
   - Document the rollback procedure: since migrations are forward-only, rollback = restore from backup. Make the daemon refuse to start if a checksum check on `migrations` fails. Ship one release with the migration but no consumer switch, so the migration runs and is observed before any read/write path changes.
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

## Phase 6: Convert Provider Adapters And Orchestration

**Goal:** Make provider execution Effect-native while keeping OpenCode and Claude SDK quirks at the adapter edge.

**Files:**
- Modify: `src/lib/provider/types.ts`
- Modify: `src/lib/provider/provider-registry.ts`
- Modify: `src/lib/provider/opencode-adapter.ts`
- Modify: `src/lib/provider/claude/claude-adapter.ts`
- Modify: `src/lib/provider/event-sink.ts`
- Modify: `src/lib/provider/relay-event-sink.ts`
- Modify: `src/lib/provider/orchestration-engine.ts`
- Modify: `src/lib/provider/claude/effect-prompt-queue.ts`
- Modify provider consumers in `src/lib/handlers/prompt.ts`, `src/lib/relay/relay-stack.ts`, and orchestration service files

**Approach:**

1. Change provider contracts from Promise-returning methods to Effect-returning methods.
2. Replace `AbortSignal` as the internal cancellation model with fiber interruption. Only create `AbortController` at OpenCode/Claude HTTP/SDK boundaries. **The interrupt → abort translation must be explicit** (see high-risk pattern below) — otherwise interrupted fibers leak in-flight HTTP/SDK calls.
3. Replace ad hoc deferred maps with Effect `Deferred`, `Queue`, `FiberMap`, or scoped `Ref<HashMap<...>>`.
4. Convert `ProviderRegistry` into a Layer-backed service with typed lookup failures.
5. Keep Claude SDK AsyncIterable and permission bridges as external boundaries, but ensure all errors are normalized before entering app logic. For the SDK's AsyncIterable, the canonical adapter is `Stream.fromAsyncIterable(iter, (cause) => new ProviderError({ cause }))` — do **not** hand-roll a `Stream.async` wrapper with manual push/close, as it duplicates what `fromAsyncIterable` already handles correctly.
6. Remove `as unknown` / `as any` assertions unless a third-party SDK type forces one; document the reason inline.

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
export interface ProviderAdapter {
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

- OpenCode adapter success, API failure, cancellation, and pending-turn cleanup.
- Claude adapter success, permission question, denial, cancellation, and SDK failure normalization.
- Event sink resolves/rejects deferred requests on completion and interruption.
- Orchestration idempotency still prevents duplicate command processing.

**Verification:**

```bash
pnpm vitest run test/unit/provider test/unit/handlers/prompt*
pnpm test:integration
pnpm test:e2e -- --grep "prompt"
```

---

## Phase 7: Convert Handler Service Contracts

**Goal:** Stop wrapping Promise-shaped services inside Effect handlers; make handlers compose typed Effect services directly.

**Files:**
- Modify: `src/lib/effect/services.ts`
- Modify: `src/lib/handlers/index.ts`
- Modify: `src/lib/handlers/session.ts`
- Modify: `src/lib/handlers/model.ts`
- Modify: `src/lib/handlers/files.ts`
- Modify: `src/lib/handlers/terminal.ts`
- Modify: `src/lib/handlers/permissions.ts`
- Modify: `src/lib/handlers/settings.ts`
- Modify: `src/lib/handlers/instance.ts`
- Modify handler test helpers in `test/helpers/mock-factories.ts`

**Approach:**

1. Convert one service tag at a time from Promise methods to Effect methods.
2. Update all handlers using that service before moving to the next service.
3. Replace broad `Effect.catchAll` with `catchTag` where the error is expected and recoverable.
4. Keep one top-level handler error renderer that turns typed errors into WebSocket error messages.
5. Use Schema decoding at handler boundaries, then domain types internally.
6. Delete bridge mock helpers as services become Effect-native test Layers.

**Implementation order:**

1. Read-only OpenCode API calls used by files/model/settings.
2. Session manager methods.
3. Permission/question bridge methods.
4. PTY methods.
5. Instance/project management methods.

**Wire compatibility (do this before touching handlers):**

Handler responses are observed by the Svelte frontend via WebSocket. Subtle changes to error envelopes or response shapes will silently break clients — type checks won't catch it because the wire format is `unknown` over the WS boundary. Before converting any handler, snapshot the WS message envelopes that handler produces (success, every typed error path) into `test/snapshots/handlers/<handler>.json`. After conversion, the snapshot must match exactly. If it must change, that is a separate, intentional commit with a frontend-coordinated update — not a side effect of migration.

**Tests:**

- Handler tests should use `@effect/vitest`.
- Each converted service gets a test Layer, wrapped in `Layer.fresh(...)` (every handler service holds Refs / Deferreds / FiberMaps).
- Wire snapshot per handler must match before/after conversion.
- Run a narrow handler slice after each service conversion:

  ```bash
  pnpm vitest run test/unit/handlers
  pnpm check
  ```

---

## Phase 8: Frontend Effect Boundary Cleanup

**Goal:** Keep the frontend pragmatic: Effect owns schema validation and long-lived transport fiber lifecycle, not every Svelte UI timer.

**Files:**
- Modify: `src/lib/frontend/transport/runtime.ts`
- Modify: `src/lib/frontend/stores/ws.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-send.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`
- Modify: `src/lib/frontend/transport/schemas.ts`
- Review only: local UI components with incidental timers

**Approach:**

1. Keep one frontend `ManagedRuntime` for transport.
2. Ensure WebSocket message parsing never silently swallows schema errors that matter for protocol correctness. Bad server messages should be logged or surfaced in debug state.
3. Make reconnection and active-stream interruption explicit with typed transport errors.
4. Do not migrate local UI timers unless they represent protocol state, connection state, or durable workflow state.

**Tests:**

- WS message schema decode rejects malformed protocol messages.
- Reconnect interrupts old stream before starting new stream.
- Send queue drain behavior remains unchanged.

**Verification:**

```bash
pnpm check:frontend
pnpm vitest run test/unit/stores test/unit/frontend
pnpm test:e2e -- --grep "websocket"
```

---

## Phase 9: Confirm Greps, Document Allowed Exceptions, Update Docs

**Goal:** End with a codebase where Effect ownership is true, not decorative. Per the bridge-deletion policy in the principles section, bridges are deleted in the same PR as their last consumer migration — **Phase 9 should not be deleting code**. If this phase finds a bridge still alive, the previous phase missed its exit criteria and must be re-opened.

**Files:**
- Update docs:
  - `docs/agent-guide/architecture.md`
  - `docs/agent-guide/testing.md`
  - progress doc from Phase 0 (mark complete, record final grep counts)
- Audit, do not delete: confirm these are already gone:
  - `src/lib/effect/relay-layer.ts` (deleted in Phase 4)
  - bridge-only sections of `src/lib/effect/services.ts` (deleted incrementally Phases 4–7)
  - bridge-only code in `src/lib/relay/relay-stack.ts` (deleted in Phase 4)
  - unused class-based persistence wrappers (deleted in Phase 5)

**Required grep gates:**

These commands should return no app-internal violations, with only documented external-boundary exceptions:

```bash
rg -n "startDaemonProcess" src
rg -n "PersistenceLayer\\.open" src
rg -n "Effect\\.promise" src
rg -n "concurrency: \"unbounded\"" src
rg -n "Effect\\.run(Promise|Sync)" src/lib
rg -n "Effect\\.run(Promise|Sync)" src/bin
rg -n "Layer\\.succeed\\([^\\n]+Tag, [a-zA-Z0-9_]+\\)" src/lib/relay src/lib/effect
```

**Allowed external-boundary exceptions (pre-enumerated — reviewers should reject any others):**

| Pattern | Allowed location | Why |
|---|---|---|
| `Effect.runPromise` / `Effect.runSync` | `src/bin/cli-core.ts` only, after the entrypoint switch is complete | Process entrypoint must run an Effect at the top |
| `Effect.runPromise` (frontend) | `src/lib/frontend/transport/runtime.ts` | Browser entrypoint, owned by `ManagedRuntime` |
| `Effect.promise` | only inside finalizers where the promise is provably non-rejecting, with inline comment | Some Node APIs return `Promise<void>` that cannot reject |
| `concurrency: "unbounded"` | none (every site must be capped or documented as a fixed-size fanout with inline comment naming the size) | Plan rule |
| `Layer.succeed(Tag, instance)` for a pre-constructed imperative instance | none in `src/lib/relay`, `src/lib/effect`; allowed in `src/bin/cli-core.ts` only if wrapping a CLI option object | Bridge anti-pattern |
| AbortController construction | only inside provider adapters (`src/lib/provider/opencode-adapter.ts`, `src/lib/provider/claude/claude-adapter.ts`) | SDK boundary; bridged to fiber interrupt per Phase 6 |
| `ws` library callback | `src/lib/effect/ws-transport-layer.ts` | Library callback boundary; immediately hands off to Effect |
| `NodeRuntime.runMain` | `src/bin/cli-core.ts` | Daemon entrypoint, signal handling |

For any hit not on this list, the PR must either eliminate it or extend this table with justification approved in review.

**Full verification:**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:e2e -- --grep "session|websocket|project"
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

---

## Suggested PR Order

1. Best-practice cleanup: `Effect.promise` (call sites + finalizers), typed row decoding via `Schema.decodeUnknown`, bounded concurrency.
2. Daemon state + config Layers (`DaemonStateTag`, `DaemonConfigRef`, config persistence).
3. Daemon TLS + startup + crash counter + storage monitor + port scanner Layers.
4. Daemon composition wiring (`DaemonWiringLive`) **and** the parallel `--daemon-runtime=effect` entrypoint behind the flag (default still `legacy`).
5. CI matrix run on both runtime values; flip default to `effect` once green; delete `legacy` branch + `startDaemonProcess` once stable.
6. HTTP/WS routing ownership, sliced per Phase 3 transition order (one PR per slice: WS upgrade → unauthenticated routes → project dispatch → auth + protected → static).
7. Relay scoped Layer migration.
8. Persistence schema migration runner (Task 5.0) shipped without consumer switch.
9. Persistence consumer migration to Effect SQL services.
10. Provider adapter and orchestration migration (with explicit AbortController bridge per Phase 6).
11. Handler service contract migration, one service tag at a time.
12. Frontend transport cleanup.
13. Phase 9: confirm grep gates, update docs. Should be a docs-only PR.

Steps 2 and 3 were one bullet in the previous version of this plan; they were split because reviewing 4 service Layers in one PR caused reviewer fatigue and missed regressions on prior attempts.

Each PR should include:

- One ownership boundary changed.
- Tests proving the boundary, not just mocks.
- A short grep summary showing which bridge patterns were reduced.
- No unrelated formatting churn.

## Final Definition Of Done

- CLI daemon startup no longer imports or calls `startDaemonProcess`.
- Production daemon runs through `NodeRuntime.runMain` and a scoped Layer graph.
- HTTP and WebSocket routing have one production owner.
- Relay services are constructed by Layers, not bridge-wrapped class instances.
- Persistence production path is Effect SQL-backed and typed-error based.
- Provider execution APIs are Effect-returning internally.
- Dynamic background work is supervised and scoped.
- Known anti-pattern greps are empty or contain only documented external-boundary exceptions.
- Default, integration, contract, targeted E2E, and logged full test suites pass.
