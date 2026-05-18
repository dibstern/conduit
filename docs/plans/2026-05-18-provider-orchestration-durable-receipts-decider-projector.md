# Provider Orchestration Durable Receipts And Decider-Projector Plan

**Date:** 2026-05-18
**Status:** Ready after full `ProviderRuntimeEvent` adoption, unless duplicate browser submission/retry bugs become urgent

## Goal

- [ ] Replace in-memory provider command dedupe with durable receipts.
- [ ] Move provider orchestration toward t3code shape: command queue, receipt lookup, pure decider, transactionally appended orchestration events, projector/read model, side-effect reactor.
- [ ] Keep this separate from `ProviderRuntimeEvent`: receipts are durable-command work; runtime events are durable-event vocabulary work.
- [ ] Preserve current provider behavior while making duplicate/retry/restart semantics explicit.

## Agent Rules

- [ ] First look for issues with this plan. If code disagrees, stop.
- [ ] If instructions unclear, ask before editing.
- [ ] If reality differs from the plan, stop, explain expected vs found, and ask.
- [ ] Use TDD. Scenario-first tests before risky behavior changes.
- [ ] Spike crash-window semantics before integrating with handlers.

## t3code Patterns To Use

- [ ] Serialize command handling through an Effect `Queue`; reply with `Deferred`.
- [ ] Check durable receipt before decider.
- [ ] Use pure decider: command + read model -> planned events or typed rejection.
- [ ] Append events, update in-memory command read model, run projection pipeline, and write receipt inside one DB transaction.
- [ ] Bootstrap command read model from projection snapshot before accepting commands.
- [ ] Publish committed events via `PubSub`; each consumer gets its own stream.
- [ ] Reconcile command read model from persisted events after dispatch failure.
- [ ] Record command ack/duration/count metrics and spans with command id/type/session/provider/sequence.
- [ ] Keep side effects in reactor/outbox layer, not decider or DB transaction.

## Code Patterns

- [ ] Effect services use `Context.Tag` plus `Layer.effect`/`Layer.scoped`; no `Effect.Service`.
- [ ] Queue worker uses `Effect.forkScoped`; no `forkDaemon`.
- [ ] Use `Deferred` for same-process duplicate waiters and queue replies.
- [ ] Use `Clock`/`DateTime`/`TestClock` for receipt timestamps and TTL tests; no `Date.now()` in core logic unless injected.
- [ ] Use `Data.TaggedError` for duplicate, fingerprint mismatch, previously rejected, orphaned command, and provider side-effect failures.
- [ ] Use `Effect.catchTag`; broad `catchAll` only for explicit degrade/reconcile paths with logs.
- [ ] Use stable command fingerprint helper that omits runtime handles.
- [ ] Use SQL upsert for receipts; no read-then-insert race.
- [ ] Side-effect reactor is idempotent by durable event sequence + command id.
- [ ] Tests use fake providers with `Deferred` gates; no sleeps.

## Prereqs

- [ ] Full `ProviderRuntimeEvent` adoption is complete or explicitly reclassified.
- [ ] `command_receipts` table exists and current tests pass.
- [ ] Current provider orchestration unit suites pass.
- [ ] Current command receipt/schema persistence tests pass.
- [ ] If urgent duplicate-submit bug bypasses prereq, do receipts-only hotfix first; do not start decider/projector rewrite.

## Out Of Scope

- [ ] No provider runtime event vocabulary changes.
- [ ] No Claude/OpenCode adapter refactor beyond orchestration command API.
- [ ] No frontend redesign.
- [ ] No live provider E2E requirement.
- [ ] No provider-instance identity migration unless command routing tests prove current provider id is ambiguous.

## Files

- [ ] Create: `src/lib/provider/orchestration-command-contracts.ts`
- [ ] Create: `src/lib/provider/orchestration-decider.ts`
- [ ] Create: `src/lib/provider/orchestration-projector.ts`
- [ ] Create: `src/lib/provider/orchestration-read-model.ts`
- [ ] Create: `src/lib/provider/orchestration-side-effect-reactor.ts`
- [ ] Create: `test/unit/provider/orchestration-decider.test.ts`
- [ ] Create: `test/unit/provider/orchestration-projector.test.ts`
- [ ] Create: `test/unit/provider/orchestration-durable-receipts.test.ts`
- [ ] Modify: `src/lib/provider/orchestration-engine.ts`
- [ ] Modify: `src/lib/provider/orchestration-wiring.ts`
- [ ] Modify: `src/lib/provider/provider-registry.ts` if reactor lookup needs service shape.
- [ ] Modify: `src/lib/persistence/command-receipts.ts`
- [ ] Modify: `src/lib/persistence/migrations/0001_current_event_store.sql`
- [ ] Modify: `src/lib/persistence/effect/migrations.ts`
- [ ] Modify: `src/lib/persistence/persistence-layer.ts`
- [ ] Modify call sites: `src/lib/handlers/prompt.ts`, `permissions.ts`, `model.ts`, `settings.ts`, `reload.ts`, `context-window.ts`, `src/lib/domain/relay/Services/*`.
- [ ] Modify tests under `test/unit/handlers`, `test/unit/provider`, `test/unit/persistence`, `test/unit/effect`.

## Phases

- [ ] Phase 0, spike: fake provider + SQLite + restart/crash windows. Pick receipt states and duplicate return shape before integration.
- [ ] Phase 1, receipt repository: add command fingerprint, aggregate/session fields, upsert/get, migration tests.
- [ ] Phase 2, decider/projector: model current commands as events/read model without provider calls.
- [ ] Phase 3, engine queue: dispatch checks receipt, decides, appends events, projects read model, writes receipt transactionally.
- [ ] Phase 4, side-effect reactor: provider calls execute from durable requested events; idempotent by command id/sequence.
- [ ] Phase 5, handler compatibility: old `dispatchEffect` facade preserves callers until handlers can accept command acknowledgements.
- [ ] Phase 6, cleanup: remove in-memory dedupe/session maps and toy idempotency service.

## Command Scope

- [ ] Mutating commands require `commandId`: `send_turn`, `interrupt_turn`, `resolve_permission`, `resolve_question`, `end_session`.
- [ ] `discover` remains non-durable unless duplicate/race tests prove need.
- [ ] Command fingerprint excludes runtime handles: `eventSink`, `AbortSignal`, callbacks, logger. Include stable command payload only.
- [ ] Same `commandId` + different fingerprint rejects and records rejection.

## Scenario-First Acceptance Tests

- [ ] Given two same-process `send_turn` dispatches with same `commandId`, when fake provider is blocked by `Deferred`, then provider receives one call and both callers resolve from the same command result/ack.
- [ ] Given a persisted accepted receipt and a fresh engine, when the same `send_turn` is dispatched after restart, then provider is not called and the caller receives accepted/replayed status from receipt/read model.
- [ ] Given same `commandId` with a different prompt/session/provider, when dispatched, then fingerprint mismatch is rejected and persisted; provider not called.
- [ ] Given unknown provider at first dispatch, when dispatch fails before side-effect request, then no receipt is consumed and retry after registering provider works.
- [ ] Given receipt accepted but crash occurs before provider side effect, when recovery starts, then Phase 0 selected policy is applied exactly. Recommended: mark orphaned/interrupted; no automatic provider retry unless command says retryable.
- [ ] Given provider completes turn but relay crashes before completion event persists, when recovery starts, then read model/receipt exposes incomplete side effect without double-sending.
- [ ] Given duplicate permission/question resolution after request already resolved, when dispatched, then provider receives at most one resolution and duplicate is a no-op/replayed acceptance.
- [ ] Given interrupt races with turn completion, when both commands process, then read model reaches one terminal state and provider receives at most one interrupt for that command id.
- [ ] Given end session with pending permission/question, when command runs, then pending interactions are cancelled exactly once and session binding is removed if requested.

## Acceptance Criteria Matrix

| Criterion | Proof | Expected Assertion |
|---|---|---|
| Mutating commands have durable idempotency. | Durable receipts tests. | Same command id never causes a second provider side effect after acceptance. |
| Command fingerprints prevent accidental id reuse. | Fingerprint mismatch scenario test. | Same id with different stable payload records rejection and does not call provider. |
| Provider lookup failure does not consume idempotency. | Unknown-provider retry test. | Failed lookup leaves no receipt; retry after registration can succeed. |
| Decider is side-effect free. | Import/static guard and decider tests. | Decider imports no provider registry/instance, no persistence implementation, no network/process modules. |
| Receipt write is transactional with accepted event append. | SQLite rollback/commit test. | Event append, projection update, and receipt appear together or not at all. |
| Side effects are outside DB transaction. | Reactor test with transaction spy/fake provider. | Provider call occurs only after durable side-effect-requested event is committed. |
| Queue order is deterministic. | Queue test with `Deferred` gates. | Same-session commands process in submit order; no timing sleeps required. |
| Read model recovers session bindings. | Restart test using persisted events. | `getProviderForSession` compatibility facade reads recovered projection, not mutable map. |
| Duplicate after restart is safe. | Fresh-engine duplicate test. | Provider call count is zero after restart duplicate; result/ack comes from receipt/read model. |
| Existing handler behavior preserved during compatibility phase. | Handler tests. | Prompt/permission/question/model/settings/reload/context-window call sites still receive expected compatibility results/errors. |
| Observability exists for command lifecycle. | Span/metric/log assertion or static test. | Command id, type, session/provider, outcome, ack sequence are annotated without high-cardinality payloads. |
| In-memory idempotency is removed. | Static guard. | `processedCommands`, toy `IdempotencySetTag`, and mutable `sessionBindings` are gone or explicitly reclassified. |

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] In-memory processed command set. Prove no active `processedCommands`, `PROCESSED_COMMANDS_MAX`, `IdempotencySetTag`, `makeIdempotencySetLive`, or `routeCommand` orchestration hit.
- [ ] Mutable `sessionBindings = new Map`. Prove only compatibility facade remains or no output.
- [ ] `CommandReceiptRepository` orphaned from engine. Prove orchestration engine tests fail if repository mock is absent.
- [ ] `command_receipts` lacks fingerprint/result status needed by tests. Prove schema tests assert all required columns/indexes.
- [ ] Mutating command without `commandId`. Prove handler/orchestration tests reject missing id for scoped mutating commands.
- [ ] Provider call inside decider. Prove decider imports no provider registry/instance modules.
- [ ] Provider side effects inside SQLite transaction. Prove side-effect reactor tests show provider call after durable requested event.
- [ ] Duplicate accepted command calls provider again. Prove duplicate/restart tests assert provider call count is `1` same-process or `0` after restart duplicate.
- [ ] `startDaemonProcess` imported by CLI. Prove no production hit.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition. Prove runtime boundary guard passes.

## Verification Commands

- [ ] `pnpm vitest run test/unit/provider/orchestration-decider.test.ts`
- [ ] `pnpm vitest run test/unit/provider/orchestration-projector.test.ts`
- [ ] `pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts`
- [ ] `pnpm vitest run test/unit/provider/orchestration-engine.test.ts test/unit/provider/orchestration-engine-effect.test.ts`
- [ ] `pnpm vitest run test/unit/persistence/command-receipts.test.ts test/unit/persistence/schema.test.ts`
- [ ] `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/handlers/effect-handlers.test.ts`
- [ ] `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts`
- [ ] `pnpm check`
- [ ] `git diff --check`

## Risk

- [ ] High risk: provider calls are external side effects and cannot be rolled back with SQLite. Use outbox/reactor pattern; do not pretend DB transaction covers provider execution.
- [ ] High risk: current `dispatchEffect(send_turn)` returns `TurnResult`; durable command dispatch may need ack-first semantics. Keep compatibility facade until handlers migrate.
- [ ] High risk: crash after accept before side effect. Spike first; make policy explicit before code.
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
- [ ] AbortSignal cannot be replayed after restart.

## Unresolved Questions

- [ ] Exact receipt statuses. Recommended: `accepted`, `rejected`, `side_effect_requested`, `side_effect_completed`, `side_effect_failed`, or simpler equivalent proven in spike.
- [ ] Duplicate accepted return shape. Recommended: compatibility facade returns prior `TurnResult` only if available; otherwise command ack/read-model status.
- [ ] Do receipts store command result payload or only sequence/status? Recommended: sequence/status only; derive state from projections.
- [ ] Is `discover` receipted? Recommended: no, unless tests expose user-visible duplicate/race bug.
- [ ] Recovery for orphaned accepted command. Recommended: mark interrupted/error, no automatic retry by default.
- [ ] How long to retain receipts? Recommended: current eviction plus explicit test for retry after eviction behavior.
- [ ] Should command contracts live under `src/lib/contracts/providers/`? Recommended: no unless they cross process/wire boundary; start under provider orchestration.

## Concrete Steps

1. Run prereq tests.
2. Spike receipt states and crash windows with fake provider + SQLite.
3. Add scenario-first durable receipt tests.
4. Add receipt repository/migration tests, then implement.
5. Add decider/projector tests for current command behavior.
6. Add queued engine tests for receipt lookup/transaction/read-model update.
7. Add side-effect reactor tests for idempotent provider calls.
8. Wire compatibility `dispatchEffect` facade and update handlers incrementally.
9. Remove in-memory dedupe/session maps and toy idempotency service.
10. Run guardrails and verification commands; inspect failures directly.
