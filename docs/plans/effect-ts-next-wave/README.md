# Effect.ts Next Wave — Overview

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement each phase document task-by-task.

**Goal:** Complete Effect.ts adoption for all remaining modules. Dissolve the Daemon class, convert 16+ modules from imperative to Effect, eliminate all EventEmitter/setInterval/try-catch/callback patterns, then upgrade the IPC protocol to `@effect/rpc`. Each phase is a self-contained plan document that an executing agent can load without needing the full 37-task context.

**Branch:** All work on `feature/effect-ts-migration` (worktree at `.worktrees/effect-ts-migration/`).

**Conventions:** See [conventions.md](conventions.md) — every phase document references it. Read it ONCE before starting any phase.

---

## Phase Dependency Graph

```
Phase 1: Daemon Core (sequential, Tasks 1-8)
    │
    ├──────────────┬──────────────┐
    ▼              ▼              ▼
Phase 2a:      Phase 2b:     (can start
Session Stack  Services &    after Task 5)
(Tasks 9-12)   Persistence
               (Tasks 13-18)
    │              │
    └──────┬───────┘
           ▼
    Phase 3: Integration & Consumer Migration
    (Tasks 19-22, includes 20a-20m)
           │
           ▼
    Phase 4: Observability & Completeness
    (Tasks 23-29)
           │
           ▼
    Phase 5: Full-Stack Adoption
    (Tasks 30-37)  ← Tasks 30-32 are ATOMIC merge unit
           │
           ▼
    Phase 6: @effect/rpc IPC Protocol
    (NEW — protocol upgrade from cmd → _tag)
```

Phases 2a and 2b are **fully parallel** with each other. All other phases are sequential.

---

## Sub-Plan Documents

| Phase | Document | Tasks | Parallel? | Estimated Scope |
|-------|----------|-------|-----------|-----------------|
| — | [conventions.md](conventions.md) | — | — | Shared reference |
| 1 | [phase-1-daemon-core.md](phase-1-daemon-core.md) | 1-8 | Sequential | DaemonState, config persistence, startup, relay cache, IPC |
| 2a | [phase-2a-session-stack.md](phase-2a-session-stack.md) | 9-12 | Parallel with 2b | SessionManager, SSE, pollers |
| 2b | [phase-2b-services.md](phase-2b-services.md) | 13-18 | Parallel with 2a | InstanceManager, leaf services, persistence, PTY, push |
| 3 | [phase-3-integration.md](phase-3-integration.md) | 19-22 | Sequential | Wire layers, consumer migration (20a-20m), cleanup |
| 4 | [phase-4-observability.md](phase-4-observability.md) | 23-29 | Sequential | PubSub, overrides, supervisor, config, metrics |
| 5 | [phase-5-full-stack.md](phase-5-full-stack.md) | 30-37 | Sequential | HTTP server, Pino logger, WS handler, batching, schemas |
| 6 | [phase-6-effect-rpc.md](phase-6-effect-rpc.md) | NEW | Sequential | @effect/rpc for IPC, `_tag` discriminant, type-safe RPC |

---

## Merge Milestones

| Milestone | After | What's safe | Validation |
|-----------|-------|-------------|------------|
| **M1** | Phase 2b complete (Task 18) | All new Effect modules built + tested. Purely additive — coexists with old code. | `pnpm vitest run test/unit/ && pnpm check` |
| **M2** | Phase 3 complete (Task 22) | All consumers converted, old code deleted. Codebase is fully Effect-native. | `pnpm test && pnpm build && pnpm test:e2e` |
| **M3** | Phase 4 complete (Task 29) | Observability features added (Supervisor, Config, Metrics). | `pnpm test && pnpm build` |
| **M4** | Phase 5 complete (Task 37) | Full-stack adoption (HTTP, WS, schemas). **Tasks 30-32 merge together.** | `pnpm test && pnpm build && pnpm test:e2e && pnpm dev` |
| **M5** | Phase 6 complete | IPC protocol upgraded to @effect/rpc with `_tag` discriminant. | `pnpm test && pnpm build && pnpm test:e2e` |

> **AUDIT FIX:** Milestones M2 and M4 now include `pnpm test:e2e` (Playwright) since they replace user-facing components.

---

## Prerequisites (run ONCE before any phase)

```bash
# Install @effect/vitest — required for it.effect / it.scoped test helpers
pnpm add -D @effect/vitest
```

Verify: `pnpm vitest --version` should succeed and `@effect/vitest` should appear in `node_modules/`.

> **AUDIT FIX:** Pin exact versions in package.json — no caret. Change `"effect": "^3.21.2"` to `"effect": "3.21.2"` (and similarly for @effect/* packages).

---

## Checkpoint Strategy

Create checkpoint branches before high-risk phases:

```bash
# Before Phase 3 (consumer migration — touches every module):
git branch checkpoint/pre-consumer-migration

# Before Phase 2b Task 15 (persistence layer switch):
git branch checkpoint/pre-persistence-migration
```

If a phase fails after partial conversion, restore: `git checkout checkpoint/<name> -- .`

Delete checkpoints after the next merge milestone passes verification.

---

## What the Branch Already Provides

The `feature/effect-ts-migration` branch (51 commits ahead of main) includes:
- 27 Context.Tag definitions in `src/lib/effect/services.ts`
- Bridge Layer factories in `src/lib/effect/layers.ts`
- Daemon lifecycle Layers in `src/lib/effect/daemon-layers.ts`
- Schema.TaggedError error classes in `src/lib/errors.ts`
- `DaemonConfigSchema` and `ServerConfigLive` Layer
- `IPCCommandSchema` (19-command Schema.Union with `cmd` discriminant)
- Effect handler versions for all 40+ message types
- `@effect/platform` and `@effect/platform-node` dependencies
- Proof-of-concept `@effect/platform` HTTP router
- `TrackedService` and `AsyncTracker` deleted (commit `a70d53b`)

---

## Audit Fixes Incorporated

### Round 1 (original audit)

1. **E2E test checkpoints** — added to merge milestones M2 and M4
2. **Version pinning** — prerequisites section fixes caret → exact
3. **Persistence rollback** — checkpoint branch added before Task 15
4. **Daemon class scope** — Phase 1 notes actual field count (~56, not 41)
5. **Consumer migration grep counts** — Phase 3 adds expected counts per sub-task
6. **HashMap consistency** — Phase 4 Task 16 fixed to use HashMap or document Map exception
7. **Frontend ManagedRuntime** — Phase 5 Task 36 reconciles with existing branch state

### Round 2 (re-audit 2026-04-25)

**Critical (would block correct execution):**
- **C1** — Phase 1 Task 6 `daemon-main.ts` imported modules from Phases 2b/4 that don't exist yet. Fixed: minimal DaemonDeps type with expansion notes per phase.
- **C2** — Phase 2b Task 13 used native `Map.get()` on a `HashMap`. Fixed: `HashMap.get()` + `.value` unwrap.
- **C3** — Phase 6 Task 40 passed a function to `Effect.annotateLogs` (expects string). Fixed: use `req.id` directly.
- **C4** — Phase 1 Task 8 SetAgent/SetModel used `cmd.sessionId` but existing protocol uses `cmd.slug`. Fixed: aligned with protocol.
- **C5** — Phase 1 Task 6 used `Effect.forkDaemon` (survives shutdown). Fixed: `Effect.forkScoped`.

**High (best practice violations):**
- **H1** — MessagePoller used HashMap for Fiber values, violating conventions. Fixed: native Map with documented exception.
- **H2/H3** — OrchestrationEngine and PushService used native Map without documenting exceptions. Fixed: added inline documentation.
- **H4** — SessionManagerServiceTag had no Live Layer. Fixed: added `SessionManagerServiceLive`.
- **H5** — No `Layer.fresh` in tests for state isolation. Fixed: added convention rule.
- **H6** — Relay cache had race condition in concurrent `get()`. Fixed: added Semaphore guard.
- **H7** — `loadConfig` silently swallowed errors, returning defaults. Fixed: logs warning. Added convention for error channel hygiene.

**Medium (deferred work, now addressed):**
- **M1** — `Effect.Service` pattern deferred as "future cleanup". Fixed: conventions now mandate adoption for simple services. *(Corrected in Round 4: `Effect.Service` does not exist in Effect 3.21.2. Convention rewritten to use `Context.Tag` pattern. See C-NEW-2.)*
- **M2** — No OpenTelemetry exporter despite `Effect.withSpan` throughout. Fixed: added Task 29b with `@effect/opentelemetry` + dev-mode exporter.
- **M3** — Phase 6 had no backward-compatible transition period for wire format change. Fixed: added `cmd`-format fallback with deprecation warning.
- **M4** — FiberStatus returned hardcoded empty data despite Supervisor being available. Fixed: reads real Supervisor data via `Effect.serviceOption`.
- **M5** — Phase 3 Task 20i depended on Phase 4 Task 23 PubSub. Fixed: move PubSub Layer creation to Phase 3 Task 19.
- **M6** — No task to convert existing branch tests to `@effect/vitest`. Fixed: added Task 0 prerequisite.
- **M7** — PersistenceService was a trivial wrapper adding no value. Fixed: added migration management, health check, and eviction methods.
- **M8** — Push Task 18 title said "Pool" but implementation used `forEach`. Fixed: corrected title to "bounded concurrency" (Pool doesn't fit fire-and-forget sends).
- **M10** — `loadConfig` error type was `never` with no logging. Fixed: logs warning on failure.

**Under-specified tasks fleshed out:**
- **L4** — Tasks 33, 34, 35 had one-paragraph descriptions. Fixed: full test + implementation code added for Request/RequestResolver (batched API), WS message Schema.Union, and API response schemas.

**Conventions updated:**
- No Forward References rule (C1)
- `forkScoped` vs `forkDaemon` rule (C5)
- `Layer.fresh` for test isolation with example (H5)
- Error channel logging requirement (H7)
- `Effect.Service` adoption guidance (M1)

### Round 3 (re-audit 2026-04-25, comprehensive)

**Critical (would cause compilation/runtime failures):**
- **C6** — Phase 6 entire `@effect/rpc` API pattern is wrong. `Rpc.effect()`, `RpcRouter.make()`, `RpcRouter.toHandler()` do NOT exist in `@effect/rpc`. The actual API uses `Rpc.make(tag, options)`, `RpcGroup.make(...rpcs)`, `RpcGroup.toHandlersContext()` / `RpcGroup.toLayer()`, and `RpcClient.make(group)`. Fixed: added warning banner to Phase 6. *(Code samples were NOT actually rewritten until Round 4 — see C-NEW-3.)*
- **C7** — `Stream.timeoutFail` uses wrong API. Plan used `Stream.timeoutFail({ onTimeout, duration })` (options object) but actual API uses positional args: `Stream.timeoutFail(() => error, duration)`. Fixed: all 3 call sites (Tasks 10, 11 test, 17 test).
- **C8** — `ScopedRef.make` takes `LazyArg<A>` (thunk returning plain value), NOT a function returning Effect. Plan used `ScopedRef.make(() => Effect.succeed(null))`. Fixed: use `ScopedRef.fromAcquire(Effect.succeed(null))` in Task 4.
- **C9** — Task 6 `daemon-main.ts` `sessionPrefetch` and `pushInit` functions reference `SessionManagerTag`, `PushManagerTag`, `OpenCodeAPITag` — Tags whose Live Layers don't exist until Phases 2a/2b. Violates the "No Forward References" convention. Fixed: move these function definitions to stub comments, expand when the Tags are created.
- **C10** — Phase 6 Task 40 `InstanceStatus` handler uses `req.id` in `.pipe()` chain outside the callback scope where `req` is defined. Fixed: move annotation inside `Effect.gen`.

**High (best practice violations / missing Effect.ts features):**
- **H8** — Tasks 12 (MessagePoller) and 13 (InstanceManager) manually manage `Map<string, Fiber>` with manual interrupt loops. Effect 3.x provides `FiberMap<K, A, E>` which auto-interrupts on scope close, provides `run()` for fork-and-register, and eliminates race conditions. Fixed: replace manual fiber maps with `FiberMap.make()`.
- **H9** — Task 2 manually writes `serializeState()`/`deserializeConfig()` instead of using `Schema.transform` for type-safe bidirectional transformations. Fixed: added convention note to prefer `Schema.transform` for domain↔wire conversions.
- **H10** — Task 23 `DaemonEvent` uses plain interfaces with `readonly _tag` strings. `Data.TaggedEnum` provides compile-time exhaustiveness checking and proper value constructors. Fixed: use `Data.TaggedEnum` for DaemonEvent.
- **H11** — Task 33 defines Request/RequestResolver without configuring `Effect.withRequestCaching`. Without it, the batching scheduler is not activated for individual `Effect.request` calls. Fixed: add `RequestResolver.DataLoader` configuration at the Layer level.
- **H12** — Task 33 combined `OpenCodeResolver` uses `RequestResolver.fromEffect` that calls `Effect.request` internally, creating infinite recursion. Fixed: provide individual resolvers via Layers instead of a combined resolver.

**Medium (under-specified tasks — now fleshed out):**
- **M9** — Task 34 only defines 16 of ~40+ WS message schemas, deferring the rest. Fixed: added instruction to enumerate ALL types from `shared-types.ts` at implementation time with mechanical completeness check.
- **M10** — Tasks 24-29 are stubs referencing "original plan." Fixed: phase documents must be self-contained. Added note that executing agent must read the monolithic plan file for Tasks 24-29 implementation details. *(Fully resolved in Round 4: all stub tasks replaced with complete inline implementations. See H-NEW-1.)*
- **M11** — Task 20h (Daemon dissolution, highest risk) has no implementation code. Fixed: added CLI entry point pattern with `Layer.launch`, `Effect.Deferred` server-ready signals.
- **M12** — Task 36 (Frontend boundary) is a placeholder with no code. Fixed: added lazy import pattern and code-split guidance.
- **M13** — Tasks 20i-20m lack implementation detail. Fixed: added minimum grep counts and consumer conversion checklist per sub-task.
- **M14** — Daemon field count: plan says ~56, actual is **33** (6 public + 27 private on feature branch). Fixed: DaemonState interface verified against actual class. *(Re-verified in Round 4: actual count is **47 fields** — M14's 33 was also wrong. See C-NEW-5.)*

**Low:**
- **L5** — Task 14c PortScanner uses native `Set<number>`/`Map<number, number>` in Ref without a documented exception. Fixed: document as exception (iteration-order-dependent eviction logic).
- **L6** — Task 6 `catchAllDefect` on background tasks prevents defect propagation to supervisor. Fixed: use `Effect.tapDefect(Effect.logError(...))` instead.
- **L7** — Task 31 PinoLoggerLive drops log annotations, spans, and cause. Fixed: forward annotations as Pino child logger bindings.

**Conventions updated:**
- `FiberMap`/`FiberSet` for managed fiber collections (H8)
- `Schema.transform` preference for domain↔wire (H9)
- `Data.TaggedEnum` for event discriminated unions (H10)
- `Stream.timeoutFail` positional args (C7)
- `ScopedRef.fromAcquire` vs `ScopedRef.make` (C8)
- `@effect/rpc` actual API patterns (C6)

### Round 4 (re-audit 2026-04-26, API verification + branch state reconciliation)

Verified all Effect 3.21.2 APIs against installed type definitions on the feature branch. Explored actual branch state (47-field Daemon class, 5 existing Effect modules, 27 Tags).

**Critical (would cause compilation/runtime failures):**
- **C-NEW-1** — `conventions.md` line 101 contradicted lines 117-120 about `Stream.timeoutFail`. Line 101 said options object; lines 117-120 said positional args (correct). Fixed: corrected line 101 to match.
- **C-NEW-2** — `Effect.Service` does NOT exist in Effect 3.21.2. Conventions referenced it as a real API. Fixed: replaced entire "Effect.Service Pattern" section with correct `Context.Tag` guidance.
- **C-NEW-3** — Phase 6 Tasks 40-44 code samples STILL used `Rpc.effect()`, `RpcRouter.make()`, `RpcRouter.toHandler()` despite C6 audit warning. The warning was a banner only; the code was never rewritten. Fixed: complete rewrite of Tasks 40-44 to use `Rpc.make()` + `RpcGroup.make()` + `RpcGroup.handle()` + `RpcGroup.toLayer()` pattern.
- **C-NEW-4** — Task 13 `InstanceManagerState` interface was missing `healthPollers` field that the implementation referenced. Fixed: removed `healthPollers` from state, wired `PollerFibersTag` (FiberMap) separately via Layer, updated all CRUD operations to use `FiberMap.run`/`FiberMap.remove`.
- **C-NEW-5** — `DaemonState` interface captured ~16 fields; actual Daemon class has **47 fields** (not 33 as M14 claimed). Fixed: expanded interface with runtime-observable fields (host, startTime, configDir, socketPath, logPath, pidPath, staticDir, TLS paths). Documented that remaining fields (server handles, managers) are managed by individual Layers.
- **C-NEW-6** — `makeInstanceManagerStateLive` `Ref.make` included `healthPollers` field not in the interface type. TypeScript would reject. Fixed: removed from initial state, split into `Layer.mergeAll` with separate FiberMap.

**High (best practice violations / significant gaps):**
- **H-NEW-1** — Phase 4 Tasks 24-29 were stubs saying "read the monolithic plan." Fixed: all tasks now self-contained with full test + implementation code. Added new Tasks 25b (shutdown tests) and 25c (retry behavior tests with TestClock).
- **H-NEW-2** — Task 33 `OpenCodeResolverLayer` used `Layer.succeed(RequestResolver.toLayer(...))` which is wrong. Fixed: use `RequestResolver.toLayer(resolver)` directly, compose with `Layer.mergeAll`.
- **H-NEW-3** — No shutdown path testing anywhere in the plan. Fixed: added Task 25b with Layer finalizer ordering tests and fiber interruption tests.
- **H-NEW-4** — Task 2 manually wrote `serializeState()`/`deserializeConfig()` despite H9 convention recommending `Schema.transform`. Noted in conventions.
- **H-NEW-5** — Task 11 test used `HashMap.make()` and `HashMap.unsafeGet()` without importing `HashMap`. Fixed: added to import.
- **H-NEW-6** — Plan didn't account for existing branch Effect modules (5 files, 27 Tags, bridge Layers). Fixed: added "Integration with Existing Branch Modules" section to conventions.md explaining how new modules relate to existing ones.
- **H-NEW-7** — PubSub creation boundary unclear between Task 19 and Task 23. Fixed: Task 19 now creates `DaemonEventBusLive` (PubSub + Tag only); Task 23 adds publishers, subscribers, and WS broadcasting.

**Medium (work that should not be deferred):**
- **M-NEW-1** — No retry behavior tests despite Schedule.exponential used everywhere. Fixed: added Task 25c with TestClock-based retry verification.
- **M-NEW-2** — `persistConfig` used direct JS recursion (not tail-call optimized in `Effect.gen`). Fixed: extracted `doSave` helper with `Effect.yieldNow` for stack safety.
- **M-NEW-3** — `HttpServerLive` uses `Layer.unwrapEffect` with config dependency but Layer ordering not documented. Fixed: added ordering note explaining it must appear after `DaemonEnvConfigLive` and `NodeFileSystem.layer`.
- **M-NEW-4** — Task 34 WS schemas covered only 16 of 40+ message types. Fixed: added complete enumeration of all message types by category with verification grep.
- **M-NEW-5** — No `Effect.withRequestBatching(true)` in daemon entry point. Fixed: added note to Task 33 and conventions.

**Low:**
- **L-NEW-1** — `IpcHandlerDeps` type included `FileSystem.FileSystem` but no IPC handler uses filesystem. Fixed: removed from type.
- **L-NEW-2** — Task 17 PTY test used `Effect.runPromiseExit` instead of `it.effect`. Fixed: converted to `it.effect` pattern.
- **L-NEW-3** — Task 3 mock `InstanceMgmtTag` missing `updateInstance`, `startInstance`, `stopInstance`, `getInstance`. Fixed: added all methods.

**Conventions updated:**
- Corrected `Stream.timeoutFail` line 101 to match positional args (C-NEW-1)
- Removed `Effect.Service` section, replaced with `Context.Tag` guidance (C-NEW-2)
- Added "Request Batching" section with `withRequestBatching` requirement (M-NEW-5)
- Added "Integration with Existing Branch Modules" section (H-NEW-6)
- Updated branch context with verified 47-field Daemon class count (C-NEW-5)

### Round 5 (re-audit 2026-04-26, full plan + Effect.ts completeness)

Re-audited all 9 plan files, reconciled with actual branch state (explored via worktree), and assessed Effect.ts best-practice completeness.

**Critical (would cause compilation/runtime failures):**
- **C-R5-1** — Task 1 field count still said 33 (stale from M14), contradicting C-NEW-5's 47. Fixed: updated to 47.
- **C-R5-2** — Task 3 error isolation test used plain `Error` (no `_tag`), but `rehydrateInstances` only catches tagged errors. Test would fail. Fixed: use `OpenCodeConnectionError` in mock.
- **C-R5-3** — Task 13 test referenced removed `healthPollers` field on `InstanceManagerState` (was split to `PollerFibersTag` in C-NEW-4). Fixed: test checks `instances` HashMap only.
- **C-R5-4** — Task 24 `clearSession` had comments about interrupting timeout fibers but no actual `Fiber.interrupt` call — fibers would leak. Fixed: read fiber ref, remove from state, then interrupt.
- **C-R5-5** — Task 6 Step 4 said "3 tests PASS" but only 2 tests defined. Fixed: corrected to 2.
- **C-R5-6** — Task 39 `RestartWithConfig` had empty `payload: {}`, losing config override capability that Phase 1 Task 8 handler uses (`...cmd.config`). Fixed: added `config` optional field.
- **C-R5-7** — Task 40 `InstanceStatus` handler used `req.id` in span attributes outside `Effect.gen`. Simplified to avoid scope ambiguity.

**High (best practice violations / significant gaps):**
- **H-R5-1** — Task 2 still used manual serialize/deserialize despite H9 `Schema.transform` convention. Fixed: added `DaemonConfigToState` Schema.transform with bidirectional encode/decode.
- **H-R5-2** — Task 34 only coded 16 of 40+ WS message schemas, deferring rest. Fixed: all message types now defined inline (session lifecycle, messages, files, agents, tools, instances, daemon, PTY).
- **H-R5-3** — Task 42 RPC client used generic `RpcResponse` and manual `Object.entries`. Fixed: typed `Schema.TaggedRequest.All` client with `Schema.encode` serialization and preserved success type parameter.
- **H-R5-4** — Task 43 backward-compatible `cmd`-format fallback was described in M3 notes but not in actual server code. Fixed: added lazy import fallback in `decodeAndDispatchRpc`, kept `ipc-dispatch.ts` during transition.
- **H-R5-5** — Task 9 `SessionManagerServiceLive` used `Layer.succeed` leaking deps to consumers. Fixed: `Layer.effect` captures deps at construction time.
- **H-R5-6** — Task 14 said "5 separate commits" but Step 7 showed single commit. Fixed: clarified per-sub-task commit pattern.
- **H-R5-7** — Multiple `Effect.forEach` calls ignore return values without `{ discard: true }`. Fixed: added convention with code example.
- **H-R5-8** — Task 25b shutdown ordering test had no assertion. Fixed: use explicit `Scope.make`/`Scope.close` with `expect(events)` assertion.

**Medium (all fixed — no remaining deferred work):**
- **M-R5-1** — Task 30 HTTP route expansion under-specified. Fixed: added complete route-by-route implementation with `@effect/platform` HttpRouter.
- **M-R5-2** — Task 36 frontend boundary deferred research to execution time. Fixed: added test, implementation, and WS transport integration guidance.
- **M-R5-3** — Task 23 publisher wiring described but not coded. Fixed: added per-service code changes for all 4 services.
- **M-R5-4** — Task 15 `withTransaction` re-export used non-existent static API. Fixed: helper function accesses `SqlClient` from context.
- **M-R5-5** — `Effect.withRequestCaching` not considered. Fixed: added to conventions alongside `withRequestBatching`.
- **M-R5-6** — `FiberMap.has` return type unverified. Added verification note to conventions.

**Low (all fixed):**
- **L-R5-1** — Task 7 used `require()` in ESM test. Fixed: dynamic `import()`.
- **L-R5-3** — Task 14 KeepAwakeLive used inconsistent `Command.start`. Fixed: use `CommandExecutor.start` pattern matching Task 13.

---

## Reference

- Design doc: `docs/plans/2026-04-24-effect-ts-next-wave-design.md`
- Original monolithic plan (superseded): `docs/plans/2026-04-24-effect-ts-next-wave-plan.md`
