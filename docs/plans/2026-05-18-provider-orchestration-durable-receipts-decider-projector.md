# Provider Orchestration Durable Receipts And Decider-Projector Plan

**Date:** 2026-05-18
**Status:** Ready after full `ProviderRuntimeEvent` adoption and the legacy OpenCode runtime ingress deletion plan, unless duplicate browser submission/retry bugs become urgent
**Review Inputs:** `2026-05-18-provider-orchestration-durable-receipts-decider-projector.architecture-improvements.md` and `2026-05-18-provider-orchestration-durable-receipts-decider-projector.tdd-improvements.md`
**Latest t3code Review:** `/Users/dstern/src/personal/conduit-competitors/t3code` checked-out `main` through `4f0f24f0` and local `origin/main` through `cf07d063`, especially provider-instance options, effective dispatch identity, deterministic runtime seams, command snapshot tombstones, bounded retry/diagnostics, and command hot-path query shape.
**Execution Model:** Beads-backed issue graph, TDD vertical slices, and parallel subagent streams only where write sets are disjoint.

## Goal

- [ ] Replace in-memory provider command dedupe with durable receipts.
- [ ] Move provider orchestration toward t3code shape: command queue, receipt lookup, pure decider, durably committed orchestration events, projector/read model, side-effect reactor.
- [ ] Keep this separate from `ProviderRuntimeEvent`: receipts are durable-command work; runtime events are durable-event vocabulary work.
- [ ] Make the durable event log independent of read-model/projection tables before command receipts rely on append+projection+receipt transactions.
- [ ] Decide the long-term provider-output ingress path for orchestration side effects and converge production provider output behind that path.
- [ ] Preserve current provider behavior while making duplicate/retry/restart semantics explicit.
- [ ] Preserve effective provider dispatch identity in durable idempotency: provider instance, selected model after aliases/version gates, normalized provider-specific options/defaults, runtime/interaction mode, prompt-injected/settings-backed modes, and execution cwd/worktree when they affect provider execution.
- [ ] Use injected time/id generation for core orchestration so restart, duplicate, and receipt tests can prove exact behavior without global randomness or wall-clock state.
- [ ] Ensure browser resume/reconnect and optional diagnostics observe durable orchestration state without becoming command recovery sources of truth.

## Agent Rules

- [ ] First look for issues with this plan. If code disagrees, stop.
- [ ] If instructions unclear, ask before editing.
- [ ] If reality differs from the plan, stop, explain expected vs found, and ask.
- [ ] Run `bd prime` before execution. Use Beads for task state, blockers, follow-ups, and handoff; do not create markdown TODO lists as project state.
- [ ] Create or claim a Beads issue for the parent plan, then create child Beads issues for the execution streams below. Add dependencies in Beads before implementation starts.
- [ ] Use TDD as one RED-GREEN vertical tracer bullet at a time. The scenario list is a behavior backlog, not permission to write all tests first.
- [ ] A "slice" means one observable behavior and one expected RED. If a listed slice contains multiple examples, implement the first representative example, get GREEN, refactor, then add the remaining examples as separate RED-GREEN cycles.
- [ ] Do not start the next RED until the current slice is GREEN. Refactor only while GREEN.
- [ ] Tests should exercise public interfaces and behavior: `EventStore`/`EventStoreEffectTag`, `ProviderRuntimeIngestionTag.ingestBatch`, `OrchestrationEngine.dispatchEffect` or its replacement interface, handler/domain-service entrypoints, and reactor/outbox entrypoints.
- [ ] Do not mock internal orchestration modules, repositories, projectors, or deciders in behavior tests. Use real SQLite for durable behavior and fake only external Provider Runtime adapters or failing external seams.
- [ ] Async reactor tests must wait through a public test harness seam such as `drain` or a test-only milestone stream. Do not use sleeps or infer reactor completion from unrelated DB polling.
- [ ] Resolve Phase 0 crash-window decisions before any handler integration or parallel implementation stream. Record the chosen policy in the parent Beads issue design/notes.
- [ ] Keep Phase 0 limited to Interface-shaping blockers: command id source, receipt states, duplicate return shape, crash policy, effective fingerprint inputs, deterministic id/time policy, and command read-model storage contract. Reactor backoff, reconnect freshness, diagnostics, and performance details are later RED-GREEN slices unless they change one of those Interfaces.
- [ ] Use parallel subagents only after the sequential gates are GREEN and only with disjoint file ownership. Each subagent prompt must include: Beads issue id, owned files/modules, forbidden files, validation command, expected output, and reminder not to revert others' work.
- [ ] Parent agent owns Beads mutations during parallel work. Pre-create child issues and dependencies before dispatch; subagents report status and do not run `bd update`, `bd close`, `bd create`, or export-changing Beads commands unless the parent assigns a serialized Beads-only step.
- [ ] Parent agent owns integration. After subagents return, review diffs, run the stream's focused validation, update/close the Beads child issue, then continue.

## t3code Patterns To Use

- [ ] Serialize command handling through an Effect `Queue`; reply with `Deferred`.
- [ ] Check durable receipt before decider.
- [ ] Use pure decider: command + read model -> planned events or typed rejection.
- [ ] Commit durable command events, durable command read-model/outbox rows, and command receipt inside one SQL transaction. UI/relay projector rows may stay separately isolated unless command decision state depends on them. Any in-memory command cache is updated only after commit or reconciled from durable state; it is not part of the transaction contract.
- [ ] Bootstrap command read model from projection snapshot before accepting commands.
- [ ] Publish committed events via `PubSub`; each consumer gets its own stream.
- [ ] Reconcile command read model from persisted events after dispatch failure.
- [ ] Split command read-model bootstrap from full UI/relay snapshots. Engine startup should read the smallest snapshot needed for command decisions and recovered session/provider bindings.
- [ ] Keep the command read model tombstone-aware. It must retain deleted/terminal project, thread, session, pending-interaction, and turn state needed to reject stale commands after restart without leaking those tombstones into normal UI/shell snapshots.
- [ ] Include effective provider dispatch identity in command fingerprints: provider instance, selected model after aliases/version gating, normalized option values, material defaults, prompt-injected/settings-backed modes, runtime mode, interaction mode, and execution cwd/worktree when those fields affect provider behavior.
- [ ] Generate command, receipt, and orchestration ids/timestamps through injected `Clock`/`DateTime` and `Crypto`/ID services. If id generation can fail, fail before receipt consumption and map the failure to a typed dispatch error.
- [ ] Treat provider readiness, probe timeout, and probe teardown failure as provider lookup failures before receipt consumption. Tests must prove any spawned probe/runtime scope is closed or force-killed on failure.
- [ ] Back off retryable side-effect reactor failures with deterministic `Clock`/`TestClock` proof. Reactor failure handling should be observable and bounded, not a tight retry loop.
- [ ] On browser resume/reconnect, reattach to durable state and fresh transport heartbeat before deciding to reconnect streams. Reconnect must not create a new mutating provider command unless the user submits a new command id.
- [ ] If adding orchestration diagnostics, expose bounded, read-only snapshots/history for reactor/ingestion queue depth, backoff, and recent failures. Diagnostics are operator visibility only, not recovery state.
- [ ] Record command ack/duration/count metrics and spans with command id/type/session/provider/sequence. Command ack means: dispatch enters orchestration engine -> first committed durable domain event for that command is published. It is not browser receipt and not provider completion.
- [ ] Expose deterministic reactor quiescence for tests through a public internal Interface (`drain`) or test-only milestone stream, following the `t3code` runtime receipt pattern without making those milestones production state.
- [ ] Keep side effects in reactor/outbox layer, not decider or DB transaction.
- [ ] Treat event append as the durable boundary. Projection/read-model tables may depend on events, but the event log must not require pre-existing projection rows.
- [ ] Route provider side-effect output through one durable ingestion path before relaying. Do not let new live provider paths translate runtime events to domain events ad hoc.
- [ ] Keep command snapshot/query hot paths narrow. Prefer targeted SQL and single-pass maps/indexes over hydrating full snapshots or repeated filter/map chains when command bootstrap, tombstones, or duplicate replay become hot.

## t3code Patterns Not To Copy

- [ ] Do not copy fingerprintless receipts. `t3code` receipts key by command id only; Conduit receipts must include a stable command fingerprint or equivalent stable payload hash so same id with different payload is rejected.
- [ ] Do not key provider model/options state by provider driver alone. Multiple provider instances of the same driver can have different reasoning/options and must remain distinct when they affect command execution.
- [ ] Do not make per-process TTL caches authoritative for provider side-effect dedupe. A short in-memory cache can be a performance guard only after durable idempotence by event sequence + command id is GREEN.
- [ ] Do not make test-only runtime milestone receipts a recovery source of truth. They are synchronization aids for tests; durable domain events and command receipts remain authoritative.
- [ ] Do not make heartbeat freshness, reconnect heuristics, process resource samples, or diagnostics history authoritative for command recovery. They can explain state; they cannot decide idempotency.
- [ ] Do not retry provider side effects in a tight loop. Backoff and failure state belong in the reactor/outbox layer, never in the decider.
- [ ] Do not fingerprint raw UI draft state, unsorted option objects, transient provider handles, or provider-driver-only option maps. Fingerprint the effective normalized dispatch request.
- [ ] Do not use global `crypto.randomUUID()`, `Math.random()`, or `Date.now()` inside core orchestration. Push randomness and time behind injected services.
- [ ] Do not copy t3code build/dependency migrations, VCS backoff constants, broad reconnect UX, or diagnostics dashboard work into this migration unless a local RED test requires it.

## Code Patterns

- [ ] Effect services use `Context.Tag` plus `Layer.effect`/`Layer.scoped`; no `Effect.Service`.
- [ ] Queue worker uses `Effect.forkScoped`; no `forkDaemon`.
- [ ] Use `Deferred` for same-process duplicate waiters and queue replies.
- [ ] Use `Clock`/`DateTime`/`TestClock` for receipt timestamps and TTL tests; use injected `Crypto`/ID generation for command/receipt/orchestration ids; no `Date.now()`, global `crypto.randomUUID()`, or `Math.random()` in core logic unless injected.
- [ ] Use `Data.TaggedError` for duplicate, fingerprint mismatch, previously rejected, orphaned command, and provider side-effect failures.
- [ ] Use `Effect.catchTag`; broad `catchAll` only for explicit degrade/reconcile paths with logs.
- [ ] Use stable command fingerprint helper that omits runtime handles and accepts the normalized effective provider dispatch request, not raw UI/provider option objects.
- [ ] Command fingerprint canonicalization sorts provider option entries and includes only stable effective dispatch fields: provider instance id, selected model after aliases/version gates, normalized option id/value pairs, material defaults, prompt-injected/settings-backed modes, runtime mode, interaction mode, stable command payload, and execution cwd/worktree when used by provider calls.
- [ ] ID generation failures are typed dispatch failures before receipt consumption. Tests should prove a failing ID service leaves no consumed receipt and performs no provider lookup.
- [ ] Use SQL upsert for receipts; no read-then-insert race.
- [ ] Side-effect reactor is idempotent by durable event sequence + command id.
- [ ] Side-effect reactor retry policy uses `Schedule`/`Clock` or an equivalent injectable policy; tests use `TestClock`, not sleeps.
- [ ] Diagnostics state is bounded by retention/count and redacts high-cardinality payloads. Treat it like `Runtime Trace`, not durable orchestration state.
- [ ] Tests use fake providers with `Deferred` gates; no sleeps.
- [ ] Reactor and ingestion Modules expose deterministic quiescence to tests; no timing sleeps, arbitrary polling loops, or provider-log inference.
- [ ] Do not add pass-through Modules to make the file list true. A new Module must pass the deletion test: deleting it would force real command, transaction, projection, retry, or ingestion rules back into multiple callers.

## Prereqs

- [ ] Full `ProviderRuntimeEvent` adoption is complete or explicitly reclassified.
- [ ] `docs/plans/2026-05-20-delete-legacy-opencode-runtime-ingress.md` is complete: the sync OpenCode runtime ingress shim and its compatibility tests are deleted or explicitly reclassified outside this branch.
- [ ] `command_receipts` table exists and current tests pass.
- [ ] Current provider orchestration unit suites pass.
- [ ] Current command receipt/schema persistence tests pass.
- [ ] If urgent duplicate-submit bug bypasses prereq, do receipts-only hotfix first; do not start decider/projector rewrite.

## Out Of Scope

- [ ] No provider runtime event vocabulary changes.
- [ ] No Claude/OpenCode adapter refactor beyond orchestration command API and provider-output ingress convergence required by Phase 5.
- [ ] No frontend redesign.
- [ ] No broad reconnect UX redesign. Only transport/orchestration idempotency tests and narrow handler changes are in scope if needed.
- [ ] No production diagnostics dashboard requirement. A bounded diagnostics read Interface is optional and must be non-authoritative.
- [ ] No live provider E2E requirement.
- [ ] No provider-instance identity migration unless command routing tests prove current provider id is ambiguous.
- [ ] No build/dependency/runtime migration from t3code, including TSGo, Effect beta upgrades, or VCS backoff constants.
- [ ] No command snapshot performance refactor beyond narrow query-shape fixes proven by the current RED slice.

## Files

This is a write-set map, not a checklist to create every file up front. Create a file only when the current RED behavior needs a stable Interface or when the deletion test says the Module earns its keep. Prefer extending an existing deep Module over adding a one-call wrapper.

- [ ] Create when forced by the command identity and deterministic id/time slice: `src/lib/provider/orchestration-command-contracts.ts`, or export the equivalent Interface from the existing orchestration Module.
- [ ] Create when the pure planning slice goes RED: `src/lib/provider/orchestration-decider.ts`.
- [ ] Create when projection behavior needs a named owner: `src/lib/provider/orchestration-projector.ts`.
- [ ] Create when bootstrap/restart behavior proves the need for a narrow command snapshot Interface: `src/lib/provider/orchestration-read-model.ts`.
- [ ] Create when provider side effects move out of dispatch: `src/lib/provider/orchestration-side-effect-reactor.ts`.
- [ ] Create only if it hides transaction rules from multiple callers: `src/lib/provider/orchestration-command-commit.ts`.
- [ ] Create only if active-provider recovery would otherwise remain spread across handlers/engine/session code: `src/lib/provider/orchestration-session-bindings.ts`.
- [ ] Create only if rollout needs operator visibility: `src/lib/provider/orchestration-diagnostics.ts` for bounded non-authoritative reactor/ingestion diagnostics.
- [ ] Create only if reactor tests cannot use the production `drain` Interface directly: `test/unit/provider/orchestration-reactor-harness.ts` or equivalent deterministic reactor milestone harness.
- [ ] Create tests one behavior at a time under `test/unit/provider/orchestration-decider.test.ts`, `test/unit/provider/orchestration-projector.test.ts`, and `test/unit/provider/orchestration-durable-receipts.test.ts`.
- [ ] Create `test/unit/provider/orchestration-dispatch-boundary.test.ts` only when handler/domain-service behavior needs a public orchestration compatibility seam.
- [ ] Create `test/unit/provider/orchestration-side-effect-reactor.test.ts` only when side-effect reactor work starts.
- [ ] Extend `test/unit/provider/provider-runtime-ingestion.test.ts` and `test/unit/provider/relay-event-sink.test.ts` or equivalent focused tests only when proving provider-output ingestion publishes browser-visible relay messages.
- [ ] Create `test/unit/provider/orchestration-diagnostics.test.ts` only if diagnostics are implemented.
- [ ] Modify: `src/lib/provider/orchestration-engine.ts`
- [ ] Modify: `src/lib/provider/orchestration-wiring.ts`
- [ ] Modify: `src/lib/provider/provider-registry.ts` if reactor lookup needs service shape.
- [ ] Modify: `src/lib/domain/relay/Services/provider-runtime-ingestion-service.ts` to remove session pre-seeding once event append no longer depends on `sessions`.
- [ ] Modify: `src/lib/provider/event-sink.ts` and `src/lib/provider/relay-event-sink.ts` to converge production provider output behind `ProviderRuntimeIngestion` and prove browser-visible relay publication, or explicitly reclassify any non-durable compatibility adapter outside the reactor path.
- [ ] Modify: `src/lib/persistence/effect/claude-event-persist-effect.ts` and `src/lib/provider/claude/claude-subagent-materializer.ts` if they remain production provider-output paths that bypass ingestion.
- [ ] Modify: `src/lib/persistence/command-receipts.ts`
- [ ] Modify: `src/lib/persistence/migrations/0001_current_event_store.sql`
- [ ] Modify: `src/lib/persistence/effect/migrations.ts`
- [ ] Modify: `src/lib/persistence/event-store.ts` and `src/lib/persistence/effect/event-store-effect.ts` if schema/API changes are needed to remove read-model FK preconditions.
- [ ] Modify: `src/lib/persistence/persistence-layer.ts`
- [ ] Modify call sites: `src/lib/handlers/prompt.ts`, `permissions.ts`, `model.ts`, `settings.ts`, `reload.ts`, `context-window.ts`, `src/lib/domain/relay/Services/*`.
- [ ] Modify tests under `test/unit/handlers`, `test/unit/provider`, `test/unit/persistence`, `test/unit/effect`.

## Architecture Module Map

The implementation should deepen one external provider command orchestration Module instead of exposing a shallow set of files. The Interface is what callers and behavior tests cross; the Implementation files are allowed to change as long as the Interface behavior holds.

Use this map to decide ownership, not to justify premature seams. One adapter is only a hypothetical seam; two adapters or repeated caller complexity make the seam real. If a planned Module would only pass data through to another Module, delete it from the design and keep the behavior behind the existing Interface.

| Module | Interface Owner | Implementation Files | Adapters / Seams | Tests Cross | Forbidden Imports / Coupling |
|---|---|---|---|---|---|
| Provider Command Identity | `orchestration-command-contracts.ts` or the replacement command interface exported by orchestration | command id validation, stable payload extraction, effective provider dispatch identity canonicalization, injected id/time service use | browser/relay command id source, compatibility command builder, normalized provider settings/options adapter | handler/domain-service tests, deterministic id/time tests, provider-instance/model-option fingerprint tests, and orchestration dispatch tests | runtime handles in fingerprints: `eventSink`, `AbortSignal`, callbacks, loggers; raw UI option objects; provider-driver-only option maps; global random/time |
| Provider Command Orchestration | `OrchestrationEngine.dispatchEffect` during compatibility, then the new orchestration Module interface | queue worker, receipt lookup, decider, command read model, side-effect request emission | provider registry adapter, persistence commit adapter, reactor adapter | duplicate, restart, lookup failure, handler compatibility tests | direct SQL in handlers; direct provider call from decider |
| Durable Command Commit | new commit interface under provider or persistence ownership, only if it hides real transaction complexity | durable command event append, durable command read-model/outbox rows, receipt write, post-commit publication handoff | SQLite adapter, Effect persistence adapter | rollback/commit tests with real SQLite | provider side effects inside SQL transaction; UI/relay projector failure treated as command commit failure unless command decision state depends on it; treating in-memory state as rollbackable transaction state |
| Provider Output Ingestion | `ProviderRuntimeIngestionTag.ingestBatch` | runtime-event mapper, append/projection/replay ownership, browser-visible relay publication proof | OpenCode SSE adapter, Claude SDK adapter, reactor provider-output adapter | ingestion, relay snapshot, live relay publication, reactor output tests | production reactor/sink calls to `translateProviderRuntimeEventToDomain` directly; second live relay mapper for provider output |
| Provider Session Binding Read Model | read-query/effect facade or orchestration compatibility facade | session/provider projection, command read model recovery | handler compatibility adapter while call sites migrate | fresh-engine restart and handler active-provider tests | authoritative `sessionBindings = new Map` in orchestration |
| Command Read-Model Snapshot | read-query/effect facade returning the minimal command decision state | narrow SQL query shape, projection-state cursor, session/provider binding rows, active turn/approval state, command metadata, deleted/terminal tombstones needed for stale-command rejection | SQLite projection adapter, test fake that fails on full snapshot hydration | engine bootstrap/restart/tombstone tests, query-shape/performance guard if the path becomes hot | loading full relay/UI snapshot or message history just to decide provider commands; repeated filter/map chains over full snapshots; leaking tombstones into UI shell snapshots |
| Reactor Quiescence Harness | public internal test seam such as `drain` or test-only milestone stream | side-effect reactor worker queue, ingestion worker queue, optional test-only runtime receipt publisher | production no-op adapter, test PubSub adapter | reactor/ingestion integration tests | durable recovery, relay replay, or production UI depending on test milestone receipts |
| Side-Effect Retry Policy | side-effect reactor Interface | retry classification, backoff schedule, failure event/receipt update, recent failure diagnostics | Provider Runtime adapter, `Clock`/`TestClock`, optional retry policy adapter | reactor failure/backoff tests | retry loops in decider; unbounded retry state; sleeps in tests |
| Orchestration Diagnostics Snapshot | optional read Interface under provider orchestration | bounded queue/backoff/recent failure summaries, redaction, retention | production in-memory adapter, test adapter | diagnostics tests if implemented | recovery/projection/relay replay depending on diagnostics; high-cardinality payload storage |

## Phases

- [ ] Phase 0, Interface-shaping hard gate: fake provider + SQLite + restart/crash windows. Pick receipt states, duplicate return shape, stable command id source, effective provider dispatch fingerprint fields, deterministic id/time policy, command read-model storage contract, and crash-window recovery policy before integration. Do not include reactor backoff, reconnect UX/freshness, diagnostics, or broad performance work here unless it changes one of those Interfaces. Do not dispatch parallel streams or migrate handlers until the hard decisions below are recorded in Beads.
- [ ] Phase 0a, command identity propagation: prove browser/relay-origin command id reaches provider command dispatch for `send_turn` and `interrupt_turn`. Mutating provider commands without durable `commandId` fail before provider lookup or provider side effects.
- [ ] Phase 1, event-log independence: remove durable event-store dependency on projection/read-model tables; projection owns creating/updating sessions from `session.created`.
- [ ] Phase 1b, provider-runtime ingestion cleanup: remove `ProviderRuntimeIngestion` session pre-seeding after event-log independence is GREEN.
- [ ] Phase 2, receipt repository: add command fingerprint, effective provider dispatch identity fields, aggregate/session fields, upsert/get, migration tests. Repository tests are supporting proof, not the primary behavior proof.
- [ ] Phase 2b, durable command commit: add one Interface only if needed to hide transaction rules from the engine. It must commit planned command events, durable command read-model/outbox rows, and command receipt in one SQL transaction. UI/relay projector writes stay isolated unless command decision state depends on them. Provider side effects and in-memory cache updates stay outside this transaction; post-commit code may publish events or refresh/reconcile in-memory state.
- [ ] Phase 3, decider/projector: model current commands as events/read model without provider calls. Split command read-model bootstrap/query from full UI/relay snapshots, keep command tombstones out of shell/UI snapshots, and prove engine startup does not hydrate message history it does not need.
- [ ] Phase 4, engine queue: dispatch checks receipt, serializes command handling, decides, commits events/read-model/receipt, and resolves same-process duplicate waiters.
- [ ] Phase 4b, restart duplicate behavior: a fresh engine over the same DB replays accepted duplicate commands from durable receipts/read models without a provider call.
- [ ] Phase 5, side-effect reactor: provider calls execute from durable requested events; idempotent by command id/sequence; retryable failures use deterministic bounded backoff; provider output enters through `ProviderRuntimeIngestion`; and one live relay proof shows ingested provider output becomes browser-visible through the existing relay owner. Reactor and ingestion tests wait through deterministic `drain`/milestone Interfaces, not sleeps. This is mandatory before reactor completion unless a compatibility exception is explicitly reclassified and statically guarded outside production provider output.
- [ ] Phase 5b, optional diagnostics: if reactor/ingestion diagnostics are added, expose bounded read-only queue/backoff/recent-failure summaries and prove recovery ignores them.
- [ ] Phase 6, provider session binding read-model cutover: active provider lookup comes from recovered projection/read-model state, with `getProviderForSession` kept only as a compatibility read if still needed.
- [ ] Phase 7, handler/reconnect compatibility: old `dispatchEffect` facade preserves callers until handlers can accept command acknowledgements and command id requirements directly. Browser resume/reconnect must reattach to durable state without redriving mutating provider commands.
- [ ] Phase 8, cleanup: remove in-memory dedupe/session maps, toy idempotency service, direct provider-output mapper bypasses, and obsolete compatibility adapters.

## Phase 0 Hard Decisions

These decisions are not implementation trivia. They determine the public Interface and the recovery behavior. Keep this gate narrow: resolve only the blockers below with a fake-provider + SQLite spike, record the result in the parent Beads issue, and only then start Phase 1 or any parallel stream.

- [ ] Receipt state model. Decide the minimum durable states needed for command acknowledgement, rejection, side-effect request, side-effect completion, and side-effect failure. Avoid storing provider result payloads unless a behavior test proves projection cannot derive the needed status.
- [ ] Duplicate accepted return shape. Decide what the compatibility facade returns for same-process duplicates, restart duplicates with a prior `TurnResult`, and restart duplicates with only command ack/read-model status available.
- [ ] Stable command id source. Decide whether durable provider command id comes from browser `originId`, a new client-supplied id, or a persisted relay-generated id. A process-local relay command id is not acceptable unless it is persisted before dispatch and survives reconnect.
- [ ] Crash after accepted receipt before provider side effect. Recommended default: mark the command interrupted/orphaned and do not automatically retry provider execution unless the committed command explicitly declares retryable semantics.
- [ ] Crash after provider completion before completion event persists. Recommended default: expose incomplete side-effect state from durable receipt/read model and require explicit retry/reconciliation behavior; never silently send the same provider side effect twice.
- [ ] Effective provider dispatch fingerprint fields. Decide which normalized provider options and defaults are material after alias/version gates and settings/prompt injection. Include provider instance, selected model, runtime mode, interaction mode, and cwd/worktree only when they affect provider execution.
- [ ] Deterministic id/time generation policy. Decide the injected `Clock`/`DateTime` and `Crypto`/ID service ownership for command ids, receipt ids, timestamps, and test-controlled failures. Prove ID generation failure fails before receipt consumption.
- [ ] Command read-model storage contract. Decide which durable rows are part of the command decision transaction, which UI/relay projector writes stay isolated, and which narrow query shape the engine can use at bootstrap.
- [ ] Receipt retention interface, only if eviction changes the duplicate/retry contract for this migration. If not, create a Beads follow-up and do not block Phase 1 on retention tuning.

## TDD Vertical Slice Order

Execute each slice as RED -> GREEN -> refactor. Do not write tests for later slices while the current slice is RED.

Granularity rules for every slice:

- [ ] Start with the smallest representative behavior. If the row names several command families, tombstone kinds, provider fields, or handler files, pick the first one and make it GREEN before adding the rest.
- [ ] Do not create all listed test files for a slice before the first RED is GREEN. Add the next file only when the next public behavior needs that file.
- [ ] Repository, projector, and static-guard tests are supporting proof. The primary proof for orchestration behavior is through the public Interface that callers use.
- [ ] If a slice wants a new Module only for test convenience, stop and try to test through the existing public Interface first.

1. [ ] Command identity propagates before provider lookup and missing ids are rejected. Test `send_turn` first, then `interrupt_turn`; the browser/relay-origin command id must reach orchestration dispatch unchanged.
   - Run: `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts -t "propagates commandId to provider command dispatch|requires commandId for mutating provider commands"`
   - Expected RED: prompt dispatch drops `originId`/command id, generates only a process-local id, or provider lookup/provider side effects can happen before durable id validation.
2. [ ] Core orchestration uses injected id/time generation. Test with deterministic `Clock`/`DateTime` and ID service; then test a failing ID generator.
   - Run: `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts test/unit/provider/orchestration-durable-receipts.test.ts -t "uses injected id and time sources|id generation failure does not consume command receipt"`
   - Expected RED: `Date.now()`, global `crypto.randomUUID()`, or random ids appear in core dispatch/receipt code; failing ID generation consumes a receipt or reaches provider lookup.
3. [ ] Event log appends before session projection. Test `session.created` append in an empty DB without pre-seeding, then projection creates the session read model.
   - Run: `pnpm vitest run test/unit/persistence/event-store.test.ts test/unit/persistence/projectors/session-projector.test.ts -t "appends session.created without a pre-existing session|projects session.created into sessions"`
   - Expected RED: SQLite FK/constraint failure on append, or append succeeds but read query has no projected session.
4. [ ] `ProviderRuntimeIngestion` stops pre-seeding sessions. Test through `ProviderRuntimeIngestionTag.ingestBatch` with real persistence and forced projection failure.
   - Run: `pnpm vitest run test/unit/provider/provider-runtime-ingestion.test.ts -t "does not pre-seed sessions before projection"`
   - Expected RED: `sessions` row exists despite projection failure.
5. [ ] Engine bootstraps from a narrow command read-model snapshot. Test a fake snapshot query that fails if the engine asks for the full relay/UI snapshot or message history.
   - Run: `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "bootstraps from command read model without loading full relay snapshot"`
   - Expected RED: engine bootstraps from the full snapshot, or no command-read-model query Interface exists.
6. [ ] Command read-model snapshot carries stale-command tombstones without becoming the UI snapshot. Start with one stale deleted-session or terminal-turn case; after GREEN, add project, thread, approval/question, and pending-turn examples as separate RED-GREEN cycles only if command decisions need each tombstone.
   - Run: `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "command read model includes tombstones for stale command decisions"`
   - Expected RED: tombstones are absent from the command snapshot, or shell/UI snapshot hydration is required to reject a stale command.
7. [ ] Same-process duplicate `send_turn` shares one in-flight result.
   - Run: `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "shares one in-flight send_turn result for duplicate command id"`
   - Expected RED: provider called twice, or duplicate gets rejected instead of sharing accepted result.
8. [ ] Restart duplicate replays from durable receipt/read model.
   - Run: `pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts -t "replays accepted send_turn after restart without provider call"`
   - Expected RED: fresh engine calls provider again.
9. [ ] Effective provider dispatch identity is part of command fingerprinting. Start with same command id and changed provider instance. Add selected model after alias/version gating, normalized provider option values, material defaults, runtime mode, interaction mode, prompt-injected/settings-backed modes, and execution cwd/worktree as separate examples only after the provider-instance case is GREEN.
   - Run: `pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts -t "rejects reused command id when effective provider dispatch identity changes"`
   - Expected RED: changed effective dispatch identity replays an accepted receipt, calls the provider, or hashes raw unsorted UI option objects.
10. [ ] Provider lookup failure does not consume command receipts. Include unknown provider, readiness failure, probe timeout, and probe teardown failure as separate RED-GREEN examples.
   - Run: `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "provider lookup failures do not consume command receipts|provider readiness failure closes probe scope"`
   - Expected RED: lookup/readiness failure consumes a receipt, prevents retry after provider registration, or leaves a spawned probe/runtime scope open.
11. [ ] Decider and projector become behavior units.
   - Run: `pnpm vitest run test/unit/provider/orchestration-decider.test.ts -t "plans send_turn side effect from command and read model"`
   - Expected RED: module/API missing, or behavior can only be proven by calling a provider instance.
12. [ ] Accepted command durable commit is atomic for command state. Commit planned command events, durable command read-model/outbox rows, and receipt together; keep UI/relay projector failures isolated unless command decision state depends on them.
   - Run: `pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts -t "commits accepted command state and receipt atomically"`
   - Expected RED: partial durable command event, command read-model/outbox row, or receipt survives after failure. Do not assert rollback of in-memory cache or unrelated UI projector state; prove in-memory state updates after commit or reconciles from durable state.
13. [ ] Command ack metrics use first committed durable event publication. Test through the orchestration dispatch Interface with metrics/spans captured by the test layer.
   - Run: `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "records command ack when the first committed event is published"`
   - Expected RED: no ack metric/span exists, or ack waits for provider completion/browser delivery instead of first durable event publish.
14. [ ] Reactor runs side effects after commit and ingests provider output.
   - Run: `pnpm vitest run test/unit/provider/orchestration-side-effect-reactor.test.ts -t "executes committed side effect once and ingests provider output"`
   - Expected RED: no reactor API exists, provider call happens inline during dispatch, output bypasses `ProviderRuntimeIngestion`, or tests need sleeps/polling to observe quiescence.
15. [ ] Provider output ingestion publishes browser-visible relay messages through one owner. Test one live relay path around `ProviderRuntimeIngestion`/`RelayEventSink` so ingested provider output reaches browser-visible messages without a second mapper.
   - Run: `pnpm vitest run test/unit/provider/provider-runtime-ingestion.test.ts test/unit/provider/relay-event-sink.test.ts -t "ingested provider output is relayed to browser clients"`
   - Expected RED: provider output is only persisted/drained and never published to relay clients, or a production sink bypasses `ProviderRuntimeIngestion` to translate provider events directly.
16. [ ] Reactor exposes deterministic quiescence without sleeps. Add only after the first side-effect reactor behavior is GREEN.
   - Run: `pnpm vitest run test/unit/provider/orchestration-side-effect-reactor.test.ts -t "drains committed side effects without sleeps"`
   - Expected RED: test must sleep, poll unrelated DB state, or infer completion from provider logs instead of awaiting a public `drain` or milestone Interface.
17. [ ] Reactor backs off retryable provider failures without hot looping. Use `TestClock` to advance retry time and prove failure state is visible through the reactor/outbox, not the decider.
   - Run: `pnpm vitest run test/unit/provider/orchestration-side-effect-reactor.test.ts -t "backs off retryable provider failures without hot looping"`
   - Expected RED: repeated provider failures retry immediately, require sleeps to test, or failure state is hidden from the reactor/outbox.
18. [ ] Browser resume/reconnect reattaches to durable command state without redriving mutating provider commands. Start with one prompt/send-turn reconnect path; only then add stale heartbeat, missing heartbeat, and completed/running variants.
   - Run: `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts -t "reconnect replays durable command state without redispatching provider command"`
   - Expected RED: reconnect creates a new command id, resends the provider side effect, or depends on transport heartbeat as command recovery state.
19. [ ] Handler compatibility and command id requirements migrate one command family at a time. Start with prompt/send turn. Then add interrupt. Then permission/question. Then model/settings/reload/context-window only if those remain mutating provider commands.
   - Run: `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts -t "requires commandId for mutating provider commands|preserves prompt dispatch compatibility"`
   - Expected RED: mutating command accepted without `commandId`, or compatibility result shape regresses.
20. [ ] Optional diagnostics stay bounded and non-authoritative. Add this slice only if `orchestration-diagnostics.ts` is created.
   - Run: `pnpm vitest run test/unit/provider/orchestration-diagnostics.test.ts -t "reports bounded reactor status without recovery dependency"`
   - Expected RED: diagnostics are unbounded, include provider payloads, or a recovery/projection path reads diagnostics.
21. [ ] Cleanup guards last. Add static grep guards only after behavior replacement paths are GREEN.
   - Run: `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts`
   - Expected RED: `processedCommands`, toy `IdempotencySetTag`, authoritative `sessionBindings`, fingerprintless receipts, raw UI option fingerprinting, provider-driver-only option maps, global random/time in core orchestration, authoritative TTL dedupe, heartbeat/diagnostics recovery dependencies, tight reactor retry loops, or provider-output bypass imports still exist.

## Command Scope

- [ ] Mutating commands require `commandId`: `send_turn`, `interrupt_turn`, `resolve_permission`, `resolve_question`, `end_session`.
- [ ] `discover` remains non-durable unless duplicate/race tests prove need.
- [ ] Command fingerprint excludes runtime handles: `eventSink`, `AbortSignal`, callbacks, logger. Include stable command payload and stable effective provider dispatch identity only.
- [ ] Command fingerprint includes provider instance id, selected model after alias/version gates, canonical normalized provider option id/value pairs, material defaults, prompt-injected/settings-backed modes, runtime mode, interaction mode, and execution cwd/worktree when those fields affect provider calls.
- [ ] Same `commandId` + different fingerprint rejects and records rejection. This includes changed provider instance/model/options/defaults/runtime mode/interaction mode/workspace, not only changed prompt text.
- [ ] Browser reconnect/resume may resend an existing durable command id to observe status, but must not mint a new mutating command id or invoke a provider side effect unless the user submits a new command.
- [ ] Command read model keeps stale-command tombstones needed for duplicate/reconnect/restart decisions; shell/UI snapshots must not expose those tombstones by accident.
- [ ] Command identity must come from a stable browser/relay origin. If the current relay command id is process-local, decide whether durable provider command id comes from browser `originId`, a new client-supplied id, or a persisted relay-generated id before durable retry semantics are called complete.
- [ ] Core orchestration must accept injected time/id generation. Tests control timestamps and ids; failures from that seam must occur before receipt consumption or provider lookup.

## Parallel Execution Streams

Use subagents for parallel implementation only after the sequential gates below are GREEN:

- [ ] Gate A: prereqs pass and Beads parent/child issues exist.
- [ ] Gate B: command identity propagation is defined and has one GREEN tracer test.
- [ ] Gate C: event-log independence and `ProviderRuntimeIngestion` pre-seed removal are GREEN, because later streams depend on durable append semantics.
- [ ] Gate D: command read-model snapshot Interface is agreed and has one GREEN bootstrap test plus one tombstone/stale-command test before engine queue work fans out.
- [ ] Gate E: Phase 0 hard decisions are recorded in Beads, especially crash-window policy and duplicate accepted return shape.
- [ ] Gate F: command read-model storage contract, durable command transaction scope, deterministic id/time seams, and effective provider dispatch fingerprint inputs are recorded in Beads before Wave 1 A/B can edit persistence or read-model files.

After Gates C, D, E, and F, run Wave 1 streams in parallel only if each stream has its own pre-created Beads child issue and the parent agent gives each subagent a disjoint write set. The parent agent performs all Beads updates/closures while subagents are running; subagents return evidence for the parent to record. Later waves depend on Wave 1 contracts and must not be dispatched speculatively.

| Stream | Beads Child | Owned Files / Modules | Depends On | Focused Validation | Must Not Touch |
|---|---|---|---|---|---|
| Wave 1 A. Receipt schema and durable commit | `bd create --parent <parent> --title "Durable command commit"` | `src/lib/persistence/command-receipts.ts`, migrations, optional `orchestration-command-commit.ts`, persistence tests | Gates C, D, E, F | `pnpm vitest run test/unit/persistence/command-receipts.test.ts test/unit/persistence/schema.test.ts test/unit/provider/orchestration-durable-receipts.test.ts -t "commits accepted command state and receipt atomically|rejects reused command id when effective provider dispatch identity changes"` | handler files, provider adapters, reactor |
| Wave 1 B. Decider/projector/read model | `bd create --parent <parent> --title "Provider command decider and projector"` | `orchestration-decider.ts`, `orchestration-projector.ts`, `orchestration-read-model.ts`, related tests, one tombstone example at a time | Gates C, D, E, F | `pnpm vitest run test/unit/provider/orchestration-decider.test.ts test/unit/provider/orchestration-projector.test.ts test/unit/provider/orchestration-engine-effect.test.ts -t "command read model includes tombstones for stale command decisions"` | persistence migrations, handlers, provider runtime adapters |
| Wave 1 D. Provider-output ingestion convergence | `bd create --parent <parent> --title "Provider output ingestion convergence"` | `provider-runtime-ingestion-service.ts`, `event-sink.ts`, `relay-event-sink.ts`, Claude persist/materializer paths, ingestion/reactor output tests | Gates C, E | `pnpm vitest run test/unit/provider/provider-runtime-ingestion.test.ts test/unit/provider/relay-event-sink.test.ts test/unit/effect/runtime-boundary-grep.test.ts` | command receipt schema, engine queue internals |
| Wave 2 C. Engine queue and duplicate waiters | `bd create --parent <parent> --title "Durable orchestration engine queue"` | `orchestration-engine.ts`, `orchestration-wiring.ts`, engine tests | Wave 1 A and B interface contracts agreed | `pnpm vitest run test/unit/provider/orchestration-engine.test.ts test/unit/provider/orchestration-engine-effect.test.ts` | migrations except agreed interfaces, handler migration, provider-output sinks |
| Wave 3 E. Side-effect reactor | `bd create --parent <parent> --title "Provider side-effect reactor"` | `orchestration-side-effect-reactor.ts`, reactor tests, provider registry adapter if needed, optional test harness, optional `orchestration-diagnostics.ts` | Wave 1 A, B, D plus Wave 2 C ack/queue contract | `pnpm vitest run test/unit/provider/orchestration-side-effect-reactor.test.ts test/unit/provider/orchestration-diagnostics.test.ts` if diagnostics are implemented | handlers, event-store schema |
| Wave 4 F1. Prompt/send-turn handler and reconnect compatibility | `bd create --parent <parent> --title "Prompt command handler compatibility"` | `src/lib/handlers/prompt.ts`, provider-turn-service prompt path, prompt/reconnect tests | Wave 2 C and Wave 3 E | `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/domain/relay/provider-turn-service.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts -t "reconnect replays durable command state without redispatching provider command|requires commandId for mutating provider commands|preserves prompt dispatch compatibility"` | decider/projector internals, migrations |
| Wave 4 F2. Interrupt/end-session handler compatibility | `bd create --parent <parent> --title "Interrupt and end-session command compatibility"` | interrupt/end-session handler or domain-service paths and focused tests | F1 or explicit non-overlap proof | focused handler/domain-service command-id and duplicate tests for interrupt/end-session | prompt compatibility, migrations, decider/projector internals |
| Wave 4 F3. Permission/question handler compatibility | `bd create --parent <parent> --title "Permission and question command compatibility"` | `permissions.ts`, question resolution path, focused handler/domain-service tests | F1 or explicit non-overlap proof | focused duplicate/no-op tests for resolved permission/question commands | prompt compatibility, migrations, decider/projector internals |
| Wave 4 F4. Model/settings/reload/context-window compatibility | `bd create --parent <parent> --title "Provider settings command compatibility"` | `model.ts`, `settings.ts`, `reload.ts`, `context-window.ts`, domain service tests | F1 or explicit non-overlap proof | focused command-id and compatibility tests only for paths that remain mutating provider commands | prompt compatibility, migrations, decider/projector internals |

Subagent prompt template:

```text
Parent has assigned Beads issue <id> in /Users/dstern/src/personal/conduit.
You are not alone in the codebase. Do not revert others' edits. Never stash.
Owned files/modules: <list>.
Forbidden files/modules: <list>.
Goal: <one behavior slice>.
Use TDD: write one failing behavior test, run it and capture the expected failure, implement the smallest code, run the focused validation, then stop.
Do not run bd create/update/close or other Beads mutation commands unless this prompt explicitly says you own a serialized Beads-only step.
Return: files inspected, files changed, validation run with outcome, Beads issue id, risks/uncertainty, and any Beads update text the parent should record.
```

The parent agent must not dispatch two subagents that can edit the same file. If two streams need the same file, serialize them or split a smaller interface contract first.

Do not dispatch all Wave 4 handler streams by default. Start with F1. Dispatch F2-F4 in parallel only if F1 proves the compatibility shape and the remaining write sets are disjoint.

## Beads Execution Protocol

Before implementation:

```bash
bd prime
bd show <parent-id>
bd update <parent-id> --claim
bd update <parent-id> --append-notes "Phase 0 hard decisions must be resolved before parallel streams or handler migration."
bd create --parent <parent-id> --title "Phase 0 durable command policy decisions" --type=decision --priority=1 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Command identity propagation" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Deterministic orchestration id and time seams" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Event-log independence" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Command read-model snapshot bootstrap" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Command read-model storage contract" --type=decision --priority=1 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Durable command commit" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Provider command decider and projector" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Provider output ingestion convergence" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Durable orchestration engine queue" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Provider side-effect reactor" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd create --parent <parent-id> --title "Prompt command handler compatibility" --type=task --priority=2 --spec-id "docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md"
bd dep add <child-that-depends> <blocking-child>
bd dep cycles
```

During implementation:

- [ ] Parent or serialized single agent claims exactly one child issue before editing: `bd update <child-id> --claim`.
- [ ] Parallel subagents do not mutate Beads. They return evidence and status text; the parent updates/blocks/closes Beads issues after integration.
- [ ] Put chosen Phase 0 policies in the decision issue with `bd update <decision-id> --design "<policy summary>"` before closing it.
- [ ] Record blockers in Beads, not markdown TODOs.
- [ ] If a new durable follow-up appears, create a Beads issue immediately with `--parent <parent-id>` or a dependency on the current child.
- [ ] Close a child only after its focused validation passes or the plan explicitly reclassifies the behavior.
- [ ] Keep `.beads/*.jsonl` changes scoped to this task's Beads state.

At session close:

- [ ] Run `bd list --status=in_progress` and ensure only intentionally active work remains.
- [ ] Close completed child issues and update the parent with remaining blockers.
- [ ] Follow `bd prime` close protocol for commit/push when this plan is executed as code work.

## Scenario-First Acceptance Tests

- [ ] Given a browser/relay-origin `commandId`, when `send_turn` or `interrupt_turn` reaches orchestration dispatch, then the same id is used for receipt lookup/fingerprint and missing ids fail before provider lookup.
- [ ] Given deterministic test `Clock`/ID services, when orchestration accepts or rejects a command, then receipt timestamps and generated ids are test-controlled; when the ID service fails, then no receipt is consumed and no provider lookup occurs.
- [ ] Given an empty SQLite DB with no `sessions` row, when `EventStore.append(session.created)` runs, then append succeeds and the session row appears only after projection.
- [ ] Given `ProviderRuntimeIngestion.ingestBatch([session.created, message.created])` runs against an empty DB, then ingestion does not pre-seed `sessions`; append succeeds first and projection creates the read model.
- [ ] Given diagnostics/runtime traces are absent, expired, or disabled, when command recovery/projection/relay replay runs, then it uses durable domain events and receipts only.
- [ ] Given the orchestration engine starts over existing projections, when it bootstraps command handling, then it reads a minimal command read-model snapshot and does not hydrate full UI/relay snapshot message history.
- [ ] Given deleted or terminal project/thread/session/pending-interaction rows exist, when the orchestration engine starts, then command handling can reject stale commands from a tombstone-aware command snapshot while shell/UI snapshots omit those tombstones.
- [ ] Given two same-process `send_turn` dispatches with same `commandId`, when fake provider is blocked by `Deferred`, then provider receives one call and both callers resolve from the same command result/ack.
- [ ] Given a persisted accepted receipt and a fresh engine, when the same `send_turn` is dispatched after restart, then provider is not called and the caller receives accepted/replayed status from receipt/read model.
- [ ] Given same `commandId` with a different prompt/session/provider, when dispatched, then fingerprint mismatch is rejected and persisted; provider not called.
- [ ] Given same `commandId` with a different effective provider dispatch identity, including provider instance, selected model after alias/version gates, normalized provider option, material default, runtime mode, interaction mode, prompt-injected/settings-backed mode, or execution cwd/worktree, when dispatched, then fingerprint mismatch is rejected and persisted; provider not called.
- [ ] Given unknown provider, provider readiness failure, probe timeout, or probe teardown failure at first dispatch, when dispatch fails before side-effect request, then no receipt is consumed, any spawned probe/runtime scope is closed or force-killed, and retry after registering a ready provider works.
- [ ] Given receipt accepted but crash occurs before provider side effect, when recovery starts, then Phase 0 selected policy is applied exactly. Recommended: mark orphaned/interrupted; no automatic provider retry unless command says retryable.
- [ ] Given provider completes turn but relay crashes before completion event persists, when recovery starts, then read model/receipt exposes incomplete side effect without double-sending.
- [ ] Given the side-effect reactor receives provider output after a requested side effect, then the output is handed to `ProviderRuntimeIngestion.ingestBatch`; no new production reactor/sink path calls `translateProviderRuntimeEventToDomain` directly.
- [ ] Given provider output is ingested through `ProviderRuntimeIngestion`, when browser clients are subscribed through the relay, then browser-visible messages are published by one relay owner without adding a second provider-output mapper.
- [ ] Given side-effect reactor or ingestion work is queued, when tests wait for completion, then they wait through `drain` or a test-only milestone stream and use no timing sleeps.
- [ ] Given a retryable provider side-effect failure, when the reactor handles it, then retries use bounded backoff proven with `TestClock`, failure state is visible through reactor/outbox state, and the decider remains side-effect free.
- [ ] Given command ack observability is captured, when dispatch commits the first durable event, then ack duration stops at that publication point and does not wait for provider completion or browser receipt.
- [ ] Given the browser resumes or reconnects while a command is accepted/running/completed, when the client reattaches, then it observes durable command/session state and does not mint a new mutating command id or trigger another provider side effect.
- [ ] Given orchestration diagnostics are enabled, when recovery/projection/relay replay runs with diagnostics removed, truncated, or stale, then behavior is unchanged; diagnostics only show bounded queue/backoff/recent-failure visibility.
- [ ] Given duplicate permission/question resolution after request already resolved, when dispatched, then provider receives at most one resolution and duplicate is a no-op/replayed acceptance.
- [ ] Given interrupt races with turn completion, when both commands process, then read model reaches one terminal state and provider receives at most one interrupt for that command id.
- [ ] Given end session with pending permission/question, when command runs, then pending interactions are cancelled exactly once and session binding is removed if requested.

## Acceptance Criteria Matrix

| Criterion | Proof | Expected Assertion |
|---|---|---|
| Durable event log does not depend on read-model rows. | Empty-DB append/projection tests plus schema guard. | `session.created` appends without pre-seeding `sessions`; projection creates/updates `sessions`; no event-store FK requires a projection row. |
| Runtime traces are diagnostics only. | Recovery/projection/relay replay tests with runtime traces absent/disabled. | Domain events plus receipts are sufficient; no recovery path queries `provider_runtime_events` or NDJSON traces. |
| Mutating commands have durable idempotency. | Durable receipts tests. | Same command id never causes a second provider side effect after acceptance. |
| Command fingerprints prevent accidental id reuse. | Fingerprint mismatch scenario test. | Same id with different stable payload records rejection and does not call provider. |
| Effective provider dispatch identity is part of durable idempotency. | Provider-instance/model/options/defaults fingerprint tests. | Same id with changed provider instance, selected model after aliases/version gates, normalized options, material defaults, prompt-injected/settings-backed modes, runtime mode, interaction mode, or execution cwd/worktree records rejection and does not call provider. |
| Provider lookup/readiness failure does not consume idempotency. | Unknown-provider, readiness, probe timeout, and teardown failure retry tests. | Failed lookup/readiness leaves no receipt, closes or force-kills probe/runtime scope, and retry after registration can succeed. |
| Decider is side-effect free. | Import/static guard and decider tests. | Decider imports no provider registry/instance, no persistence implementation, no network/process modules. |
| Receipt write is transactional with accepted command state. | SQLite rollback/commit test. | Durable command event append, durable command read-model/outbox rows, and receipt appear together or not at all; UI/relay projectors are isolated unless command decision state depends on them; in-memory caches update only after commit or reconcile from durable state. |
| Side effects are outside DB transaction. | Reactor test with transaction spy/fake provider. | Provider call occurs only after durable side-effect-requested event is committed. |
| Queue order is deterministic. | Queue test with `Deferred` gates. | Same-session commands process in submit order; no timing sleeps required. |
| Read model recovers session bindings. | Restart test using persisted events. | `getProviderForSession` compatibility facade reads recovered projection, not mutable map. |
| Command read model is a narrow Interface. | Engine bootstrap test with fake snapshot query that fails on full snapshot reads. | Engine reads minimal command decision state and does not hydrate full relay/UI message history during startup. |
| Command read model is tombstone-aware. | Command snapshot tombstone test plus shell/UI snapshot assertion. | Deleted/terminal project, thread, session, turn, approval, and question state remains available for command rejection while normal UI snapshots omit it. |
| Duplicate after restart is safe. | Fresh-engine duplicate test. | Provider call count is zero after restart duplicate; result/ack comes from receipt/read model. |
| Command identity is stable before provider dispatch. | Handler/domain-service test plus orchestration dispatch test. | Browser/relay-origin command id reaches `send_turn`/`interrupt_turn`; missing id fails before provider lookup. |
| Core id/time generation is deterministic and injected. | Orchestration/receipt tests with deterministic and failing ID/time services. | Receipt timestamps and generated ids are test-controlled; failing id generation leaves no consumed receipt and no provider lookup. |
| Durable command commit is a deep Module. | Transaction behavior tests through one commit Interface. | Engine does not know low-level event append/projection/receipt ordering. |
| Provider output has one durable ingress and relay owner. | Reactor/provider sink tests, live relay publication proof, and static guard. | New production provider output routes through `ProviderRuntimeIngestion`; browser-visible messages are published through the relay owner; mapper imports outside ingestion/translator tests are deleted or explicitly reclassified. |
| Reactor quiescence is deterministic in tests. | Reactor/ingestion tests wait on `drain` or test-only milestone stream. | No sleeps, arbitrary polling loops, or provider-log inference are required to prove side-effect completion. |
| Reactor retry is bounded and testable. | Reactor failure/backoff test using `TestClock`. | Retryable provider failures do not hot-loop; next retry/failure status is visible through reactor/outbox state; decider remains side-effect free. |
| Browser reconnect is idempotent. | Reconnect/handler test using existing durable command id. | Reconnect observes command/session state without minting a new mutating command id or invoking provider side effects again. |
| Diagnostics are non-authoritative. | Optional diagnostics test and recovery test with diagnostics removed. | Diagnostics are bounded and redacted; no recovery, projection, replay, or idempotency path reads them as source of truth. |
| Existing handler behavior preserved during compatibility phase. | Handler tests. | Prompt/permission/question/model/settings/reload/context-window call sites still receive expected compatibility results/errors. |
| Observability exists for command lifecycle. | Span/metric/log assertion or static test. | Command id, type, session/provider, outcome, ack sequence are annotated without high-cardinality payloads; ack ends at first committed durable event publication. |
| In-memory idempotency is removed. | Static guard. | `processedCommands`, toy `IdempotencySetTag`, and mutable `sessionBindings` are gone or explicitly reclassified. |

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] In-memory processed command set. Prove no active `processedCommands`, `PROCESSED_COMMANDS_MAX`, `IdempotencySetTag`, `makeIdempotencySetLive`, or `routeCommand` orchestration hit.
- [ ] Mutable `sessionBindings = new Map`. Prove only compatibility facade remains or no output.
- [ ] Event log coupled to projection/read-model tables. Prove `events.session_id` does not require an existing `sessions` row, and `ProviderRuntimeIngestion` no longer inserts into `sessions` before appending domain events.
- [ ] Durable receipt persistence orphaned from behavior. Prove a real SQLite deletion/regression test fails if durable receipt persistence is removed from the dispatch path: duplicate same-process/restart behavior must call the provider twice or lose replay if receipts are absent.
- [ ] `command_receipts` lacks fingerprint/result status needed by tests. Prove schema tests assert all required columns/indexes.
- [ ] Fingerprintless t3code-style receipt copied into Conduit. Prove schema and dispatch tests reject same `commandId` with a different stable payload.
- [ ] Effective provider dispatch identity omitted from fingerprint. Prove schema/dispatch tests reject same `commandId` when provider instance, selected model after aliases/version gates, normalized provider options, material defaults, prompt-injected/settings-backed modes, runtime mode, interaction mode, or execution cwd/worktree changes.
- [ ] Raw UI/provider option objects fingerprinted directly. Prove option order, alias resolution, version gating, and default injection are normalized before hashing.
- [ ] Provider options keyed by driver instead of instance. Prove multiple same-driver provider instances keep distinct options when command execution depends on them.
- [ ] Command snapshot drops stale-command tombstones or shares UI snapshot shape. Prove stale/deleted/terminal command decisions work after restart and shell/UI snapshots still hide tombstones.
- [ ] Mutating command without `commandId`. Prove handler/orchestration tests reject missing id for scoped mutating commands.
- [ ] Command id dropped between relay/browser ingress and provider orchestration. Prove prompt/send-turn and interrupt tests observe the same command id at orchestration dispatch.
- [ ] Global random/time used in core orchestration. Prove static or behavior tests catch `Date.now()`, global `crypto.randomUUID()`, and `Math.random()` in the command/receipt/dispatch core unless explicitly injected.
- [ ] Provider readiness/probe failure consumes receipt or leaks scope. Prove readiness failure, probe timeout, and teardown failure leave no consumed receipt and close/force-kill spawned probe/runtime scopes.
- [ ] Browser reconnect mints a fresh mutating command id for accepted/running commands. Prove reconnect uses durable command state and does not redrive provider side effects.
- [ ] Provider call inside decider. Prove decider imports no provider registry/instance modules.
- [ ] Provider side effects inside SQLite transaction. Prove side-effect reactor tests show provider call after durable requested event.
- [ ] Reactor retry hot loop. Prove retryable provider failures use bounded backoff with deterministic `TestClock` tests.
- [ ] Per-process TTL cache is authoritative for provider side-effect dedupe. Prove any cache is optional and correctness comes from durable event sequence + command id.
- [ ] Provider output bypasses durable ingestion or relay owner. Prove new production provider side-effect output does not import/call `translateProviderRuntimeEventToDomain` directly, does not append/project by hand, and still publishes ingested output to browser clients through the relay owner.
- [ ] Test-only runtime milestone receipts become production state. Prove production recovery/projection/relay replay ignores quiescence milestones and uses domain events plus command receipts only.
- [ ] Diagnostics become recovery state or unbounded storage. Prove recovery/projection/replay ignore diagnostics and diagnostic retention/count/redaction limits are enforced.
- [ ] Duplicate accepted command calls provider again. Prove duplicate/restart tests assert provider call count is `1` same-process or `0` after restart duplicate.
- [ ] `startDaemonProcess` imported by CLI. Prove no production hit.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition. Prove runtime boundary guard passes.

## Verification Commands

- [ ] `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts -t "propagates commandId to provider command dispatch|requires commandId for mutating provider commands"`
- [ ] `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts test/unit/provider/orchestration-durable-receipts.test.ts -t "uses injected id and time sources|id generation failure does not consume command receipt"`
- [ ] `pnpm vitest run test/unit/provider/orchestration-decider.test.ts`
- [ ] `pnpm vitest run test/unit/provider/orchestration-projector.test.ts`
- [ ] `pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts`
- [ ] `pnpm vitest run test/unit/provider/orchestration-engine.test.ts test/unit/provider/orchestration-engine-effect.test.ts`
- [ ] `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "bootstraps from command read model without loading full relay snapshot|command read model includes tombstones for stale command decisions|records command ack when the first committed event is published"`
- [ ] `pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts -t "rejects reused command id when effective provider dispatch identity changes|replays accepted send_turn after restart without provider call"`
- [ ] `pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "provider lookup failures do not consume command receipts|provider readiness failure closes probe scope"`
- [ ] `pnpm vitest run test/unit/provider/orchestration-side-effect-reactor.test.ts -t "executes committed side effect once and ingests provider output|drains committed side effects without sleeps|backs off retryable provider failures without hot looping"`
- [ ] `pnpm vitest run test/unit/provider/provider-runtime-ingestion.test.ts test/unit/provider/relay-event-sink.test.ts -t "ingested provider output is relayed to browser clients"`
- [ ] `pnpm vitest run test/unit/provider/orchestration-dispatch-boundary.test.ts test/unit/handlers/prompt*.test.ts -t "reconnect replays durable command state without redispatching provider command"`
- [ ] `pnpm vitest run test/unit/provider/orchestration-diagnostics.test.ts -t "reports bounded reactor status without recovery dependency"` if diagnostics are implemented.
- [ ] `pnpm vitest run test/unit/provider/provider-runtime-ingestion.test.ts test/unit/persistence/event-store.test.ts test/unit/persistence/events.test.ts`
- [ ] `pnpm vitest run test/unit/persistence/command-receipts.test.ts test/unit/persistence/schema.test.ts`
- [ ] `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/handlers/effect-handlers.test.ts`
- [ ] `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts`
- [ ] `pnpm check`
- [ ] `git diff --check`

## Risk

- [ ] High risk: provider calls are external side effects and cannot be rolled back with SQLite. Use outbox/reactor pattern; do not pretend DB transaction covers provider execution.
- [ ] High risk: in-memory command read-model/cache updates can be mistaken for transactional state. Durable command event append, durable command read-model/outbox rows, and receipt write are the command transaction. UI/relay projector writes stay isolated unless command decision state depends on them. In-memory state updates after commit or reconciles from the durable store.
- [ ] High risk: event-store schema changes can corrupt replay if projection/read-model FK removal is treated as cosmetic. Test old and new DBs, empty DBs, and recovery from persisted events.
- [ ] High risk: current `dispatchEffect(send_turn)` returns `TurnResult`; durable command dispatch may need ack-first semantics. Keep compatibility facade until handlers migrate.
- [ ] High risk: crash after accept before side effect. This is a Phase 0 blocker; do not write handler migration code or dispatch parallel streams until the policy is chosen and recorded in Beads.
- [ ] High risk: Phase 0 can become a horizontal architecture spike. Keep it to Interface-shaping blockers; move reactor backoff, reconnect freshness, diagnostics, and performance details to later behavior slices or Beads follow-ups.
- [ ] Risk: provider option canonicalization can cause false mismatches if option order, defaults, provider aliases, model version gates, or settings/prompt injection are unstable. Canonicalize the effective dispatch request and decide whether default options are material before adding receipt tests.
- [ ] Risk: global id/time generation can make restart/duplicate tests flaky or unprovable. Require injected `Clock`/ID services before durable receipt behavior is considered GREEN.
- [ ] Risk: parallel subagents can race on `.beads`/Dolt exports. Parent owns Beads mutations while subagents run; subagents return Beads note text instead of updating issues directly.
- [ ] Risk: command snapshot bootstrap can become an accidental full relay snapshot hydration path. Keep narrow SQL and single-pass maps/indexes for hot query paths, adding performance/query-shape guards only where a test exposes over-fetching.
- [ ] Risk: command tombstones can leak into UI if command snapshot and shell/UI snapshot share shape too aggressively. Keep separate read Interfaces and prove shell/UI snapshots omit tombstones.
- [ ] Risk: browser reconnect code can accidentally look like a duplicate command replay while actually minting a new id. Test reconnect through the handler/domain-service entrypoint that owns command id creation.
- [ ] Risk: reactor backoff can hide stuck provider work. Pair bounded retry with visible failure/outbox state and optional diagnostics; do not silently swallow repeated failures.
- [ ] Risk: a test-only quiescence Interface can accidentally become a production replay contract. Name it as test-only, use production no-op/test PubSub adapters if needed, and statically guard recovery against it.
- [ ] Risk: diagnostics history can grow into a shadow event store. Keep it bounded, redacted, disposable, and absent from replay/recovery code.
- [ ] Tradeoff: converging provider output behind `ProviderRuntimeIngestion` reduces duplicated mapping logic, but may require a short compatibility adapter for existing provider event sinks. Keep that adapter outside production reactor wiring and guard it.
- [ ] Tradeoff: receipts-only hotfix is smaller for urgent duplicate bugs; full decider/projector shape is better but larger.
- [ ] Tradeoff: per-session queue is simpler for ordering; global queue matches t3code and is easier for deterministic receipt handling. Prefer global queue first.

## Edge Cases

- [ ] Browser retries after network disconnect.
- [ ] Browser submits same command id with changed prompt.
- [ ] Relay restarts with command accepted but provider still running externally.
- [ ] Provider completes turn but relay crashes before completion event persists.
- [ ] Permission resolved after request already cancelled.
- [ ] Question resolved after session ended.
- [ ] Interrupt races with turn completion.
- [ ] End session races with pending permission/question.
- [ ] Provider lookup unavailable at first dispatch, later registered.
- [ ] Receipt retention deletes old receipt but old browser retries command.
- [ ] Multi-provider session switch while command in flight.
- [ ] Same provider driver with two instances and different model/options.
- [ ] Same `commandId` retried after provider option default changes or option order changes.
- [ ] Thread/project deleted while browser retries an accepted command.
- [ ] Browser resumes with healthy heartbeat, stale heartbeat, and missing heartbeat.
- [ ] Repeated provider side-effect failure across process restart.
- [ ] Diagnostics retention truncates old failure samples while durable receipts remain.
- [ ] AbortSignal cannot be replayed after restart.

## Phase 0 And Follow-Up Decisions

Resolve the blocker decisions before Phase 1 implementation. Non-blocker decisions can become Beads follow-ups if they are not needed by the current slice.

Blocker decisions:

- [ ] Exact receipt statuses. Recommended: `accepted`, `rejected`, `side_effect_requested`, `side_effect_completed`, `side_effect_failed`, or simpler equivalent proven in spike.
- [ ] Duplicate accepted return shape. Recommended: compatibility facade returns prior `TurnResult` only if available; otherwise command ack/read-model status.
- [ ] Do receipts store command result payload or only sequence/status? Recommended: sequence/status only; derive state from projections.
- [ ] Stable provider command id source. Recommended: browser/client-origin id or persisted relay-generated id; process-local relay id only if persisted before dispatch and replayable after reconnect.
- [ ] Recovery for orphaned accepted command. Recommended: mark interrupted/error, no automatic retry by default.
- [ ] Recovery for provider-completed-before-completion-event-persisted. Recommended: expose incomplete side-effect status and require explicit retry/reconcile path; no automatic duplicate provider send.
- [ ] Which effective provider dispatch fields are material to a command fingerprint? Recommended: include provider instance, selected model after aliases/version gates, canonical explicit options, prompt-injected/settings-backed modes, and material defaults only after a red test proves defaults affect provider execution.
- [ ] Deterministic id/time seams. Recommended: orchestration receives injected `Clock`/`DateTime` and `Crypto`/ID service; failing ID generation maps to typed dispatch error before receipt lookup/upsert.
- [ ] Command read-model storage contract. Recommended: command decision rows/outbox/receipt commit atomically; UI/relay projector writes remain isolated unless command decision state depends on them.
- [ ] Does execution cwd/worktree belong in every fingerprint or only commands that call providers from that cwd? Recommended: include when provider calls receive or derive cwd/worktree.

Non-blocker decisions, unless the current slice proves otherwise:

- [ ] Is `discover` receipted? Recommended: no, unless tests expose user-visible duplicate/race bug.
- [ ] How long to retain receipts? Recommended: current eviction plus explicit test for retry after eviction behavior; if not needed for rollout, file a Beads follow-up.
- [ ] Should command contracts live under `src/lib/contracts/providers/`? Recommended: no unless they cross process/wire boundary; start under provider orchestration.
- [ ] Should reactor quiescence use a `drain` Interface, a test-only milestone stream, or both? Recommended: start with `drain` for worker queues and add a test-only milestone stream only when a test must await a named post-provider milestone.
- [ ] What is the initial reactor backoff policy? Recommended: exponential with cap, injectable policy, and `TestClock` tests for first failure, repeated failure, reset after success, and cap.
- [ ] What is the reconnect freshness signal? Recommended: transport heartbeat freshness may decide whether to reconnect streams, but never command idempotency or recovery.
- [ ] Do we need orchestration diagnostics in this migration or a follow-up? Recommended: add only if reactor backoff or ingestion failures need operator visibility during rollout; otherwise create a Beads follow-up.
- [ ] Do command snapshot hot paths need extra performance work? Recommended: defer until the narrow snapshot exists and a test or measurement shows full hydration/repeated filtering; then prefer targeted SQL and single-pass maps/indexes.

## Concrete Steps

1. Run `bd prime`, claim/create the parent Beads issue, and pre-create child Beads issues for the Phase 0 decision gate, command identity, deterministic id/time seams, Gate A, Gate B, Gate C, Gate D, Gate F, and each Wave 1 stream. Parent owns Beads updates while parallel subagents run.
2. Run prereq tests and prove `docs/plans/2026-05-20-delete-legacy-opencode-runtime-ingress.md` is complete or explicitly reclassified.
3. Spike only Interface-shaping Phase 0 blockers with fake provider + SQLite: receipt states, duplicate return shape, stable command id source, effective provider dispatch fingerprint fields, deterministic id/time policy, command read-model storage contract, and crash windows. Record blocker decisions in the Phase 0 Beads decision issue before implementation proceeds.
4. Execute TDD vertical slice 1: command identity propagation and missing-id rejection for prompt/send-turn, then interrupt.
5. Execute TDD vertical slice 2: deterministic id/time seams and failing ID service behavior.
6. Execute TDD vertical slices 3 and 4: event log appends before session projection, then `ProviderRuntimeIngestion` stops pre-seeding sessions.
7. Execute TDD vertical slices 5 and 6: engine bootstraps from narrow command read-model snapshot, then carries one stale-command tombstone without leaking it into shell/UI snapshots.
8. Execute TDD vertical slices 7 and 8: same-process duplicate `send_turn`, then restart duplicate replay from durable receipt/read model.
9. Execute TDD vertical slices 9 and 10: effective provider dispatch fingerprint mismatch one field at a time, then provider lookup/readiness/probe failures without receipt consumption or leaked scopes.
10. After Gates C, D, E, and F are GREEN, dispatch Wave 1 subagents for A, B, and D only if their Beads issues, owned files, forbidden files, and validation commands are explicit and disjoint.
11. Integrate Wave 1, then dispatch Wave 2 C for engine queue and duplicate waiters.
12. Integrate Wave 2, then dispatch Wave 3 E for side-effect reactor with deterministic quiescence, backoff proof, and provider-output ingestion/relay proof.
13. Add optional diagnostics only if the reactor/backoff rollout needs bounded operator visibility and the diagnostics Module passes the deletion test; otherwise file a Beads follow-up.
14. Migrate handler and reconnect compatibility as Wave 4, starting with F1 prompt/send turn. Dispatch F2-F4 only after F1 proves the compatibility shape and their write sets are disjoint.
15. Run cleanup guards only after behavior tests prove replacements.
16. Close completed Beads children, update blockers/follow-ups in Beads, and run the verification commands selected by changed surface.
