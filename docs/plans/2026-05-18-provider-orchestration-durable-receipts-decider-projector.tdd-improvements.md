# TDD Improvements For Durable Receipts, Decider, Projector

Source plan: `docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md`

This document amends execution style only. Keep the source plan intact, but execute it as one RED-GREEN vertical tracer bullet at a time. The scenario list is a backlog of behaviors, not a batch of tests to write up front.

## Source-Grounded Constraints

- `CONTEXT.md` defines `Provider Runtime Event` as pre-storage ingress, not durable truth. Runtime traces are diagnostics only.
- `docs/agent-guide/testing.md` says to prefer the smallest test surface, use focused Vitest commands, and escalate only when a boundary requires it.
- Current public seams include `EventStore` / `EventStoreEffectTag`, `ProjectionRunnerEffectTag`, `ReadQueryService`, `ProviderRuntimeIngestionTag.ingestBatch`, `OrchestrationEngine.dispatchEffect`, handler Effect entrypoints, and the relay command gate/domain model.
- Current code still has `events.session_id -> sessions(id)`, `ProviderRuntimeIngestionLive` pre-seeds `sessions`, `CommandReceiptRepository` only stores accepted/rejected sequence/error, and `OrchestrationEngine` still has in-memory `processedCommands` and `sessionBindings`.

## Behavior-First Interfaces To Test

- Event log independence: test through `EventStore.append` or `EventStoreEffectTag.append`, `ProjectionRunner`, and `ReadQueryService`, not by only inspecting schema text.
- Provider output ingestion: test through `ProviderRuntimeIngestionTag.ingestBatch` with real SQLite/effect persistence where possible. Fake only provider-runtime input events and failing external boundaries.
- Command idempotency: test through `OrchestrationEngine.dispatchEffect` or handler/domain service entrypoints. Use fake provider instances as the external provider boundary, not mocked deciders, repositories, or projectors.
- Durable command receipts: verify observable dispatch behavior first. Repository tests are supporting coverage, not the primary proof.
- Decider/projector: expose a small public pure API only when needed, for example command plus read model to planned events, and stored events to read model. Tests should not assert private helper names.
- Side-effect reactor: test a public reactor/outbox service such as `drain` or `runNext` after committed requested events. Fake provider instances and `ProviderRuntimeIngestion`; do not fake the engine internals.
- Handler compatibility: test the public handler/domain service behavior that browser clients depend on, especially command id requirements and old `dispatchEffect` result compatibility.

## Vertical Slice Order

Do not start the next RED until the current slice is GREEN. After each GREEN, refactor only while tests are passing.

### 1. Event Log Appends Before Session Projection

RED:
Add one test proving `session.created` appends in an empty DB without `harness.seedSession`, then projection creates the session read model.

Proof command:

```bash
pnpm vitest run test/unit/persistence/event-store.test.ts test/unit/persistence/projectors/session-projector.test.ts -t "appends session.created without a pre-existing session|projects session.created into sessions"
```

Expected RED shape: SQLite FK/constraint failure on append, or append succeeds but `ReadQueryService.listSessions()` has no projected row.

GREEN:
Remove the event-log dependency on `sessions` and make `session.created` projection own the `sessions` row. Keep event-store APIs domain-event-only.

Refactor proof: remove only test-local pre-seeding that hid the FK. Keep existing seeded tests if they cover other behavior.

### 2. ProviderRuntimeIngestion Stops Pre-Seeding Sessions

RED:
Add one behavior test through `ProviderRuntimeIngestionTag.ingestBatch` where projection fails after append. The event remains readable from the event store, but `ReadQueryService.listSessions()` does not show a session row created by ingestion pre-seeding.

Proof command:

```bash
pnpm vitest run test/unit/provider/provider-runtime-ingestion.test.ts -t "does not pre-seed sessions before projection"
```

Expected RED shape: a `sessions` row exists despite projection failure, because current `ProviderRuntimeIngestionLive` inserts it before append.

GREEN:
Delete ingestion pre-seeding and let append happen before projection. Add a narrow static guard only after the behavior test is GREEN.

Refactor proof: `ProviderRuntimeIngestion` remains the single provider-output ingress owner and does not import/project by hand outside its boundary.

### 3. Same-Process Duplicate Send Turn Shares One In-Flight Result

RED:
Add one test through `OrchestrationEngine.dispatchEffect` with a fake provider instance gated by `Deferred`. Submit two `send_turn` commands with the same `commandId` while the first is blocked.

Proof command:

```bash
pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "shares one in-flight send_turn result for duplicate command id"
```

Expected RED shape: provider `sendTurnEffect` is called twice, or the second caller gets an in-memory duplicate rejection instead of the same accepted result.

GREEN:
Serialize command handling, store same-process waiters with `Deferred`, and return the same accepted ack/result without a second provider side effect.

Refactor proof: no sleeps, no call-order timing assertions, fake provider only at the provider boundary.

### 4. Restart Duplicate Replays From Durable Receipt

RED:
Use real SQLite. Dispatch an accepted `send_turn`, create a fresh engine over the same DB, register a fake provider, and dispatch the same command again.

Proof command:

```bash
pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts -t "replays accepted send_turn after restart without provider call"
```

Expected RED shape: fresh engine calls provider again because current idempotency is in-memory.

GREEN:
Write accepted receipt transactionally with accepted event/read-model changes, then satisfy duplicate restart dispatch from receipt/read model.

Refactor proof: command receipt schema tests cover only columns/indexes needed by the public duplicate behavior.

### 5. Fingerprint Mismatch And Lookup Failure

RED:
Add two separate tests, not one batch:

- Same `commandId` with changed stable payload rejects and persists rejection; provider is not called.
- Unknown provider lookup fails before receipt consumption; retry after provider registration can succeed.

Proof commands:

```bash
pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts -t "rejects reused command id with different fingerprint"
pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts -t "provider lookup failures do not consume command receipts"
```

Expected RED shape: changed payload either calls provider or is treated as a plain duplicate; lookup failure leaves an in-memory-only state or consumes a receipt.

GREEN:
Fingerprint stable command payload only. Exclude `eventSink`, `AbortSignal`, callbacks, loggers, and runtime handles.

Refactor proof: no test reaches into fingerprint helper internals unless the helper is deliberately exported as the command contract.

### 6. Decider And Projector Become Public Behavior Units

RED:
Create only the first missing public behavior test, for example: a bound-session read model plus `send_turn` command plans a durable side-effect-requested event and no provider call.

Proof command:

```bash
pnpm vitest run test/unit/provider/orchestration-decider.test.ts -t "plans send_turn side effect from command and read model"
```

Expected RED shape: module or API missing, or current engine can only prove behavior by calling a provider instance.

GREEN:
Add the smallest decider/read-model/projector API needed for that behavior. Keep the decider pure and side-effect free.

Refactor proof:

```bash
pnpm vitest run test/unit/provider/orchestration-decider.test.ts test/unit/provider/orchestration-projector.test.ts
```

Expected GREEN shape: current command behavior is represented as planned events/read-model state without persistence, provider registry, network, process, or SDK imports.

### 7. Accepted Command Transaction Is Atomic

RED:
Use real SQLite and force one write in the accept path to fail. Verify through `EventStore` and `CommandReceiptRepository` public reads that event append, projection update, and receipt are all present together or all absent.

Proof command:

```bash
pnpm vitest run test/unit/provider/orchestration-durable-receipts.test.ts -t "commits accepted event projection and receipt atomically"
```

Expected RED shape: partial event, read model, or receipt state survives after failure.

GREEN:
Move append, in-memory command read-model update, projection, and receipt write into one SQLite transaction. Keep provider side effects outside it.

Refactor proof: no repository mocks in this test; real SQLite is the public persistence boundary.

### 8. Reactor Runs Side Effects After Commit

RED:
Append/project a committed provider-side-effect-requested event, run the public reactor once, and assert the fake provider receives one call. Its provider output must enter `ProviderRuntimeIngestionTag.ingestBatch`.

Proof command:

```bash
pnpm vitest run test/unit/provider/orchestration-side-effect-reactor.test.ts -t "executes committed side effect once and ingests provider output"
```

Expected RED shape: no reactor API exists, provider call happens inline during dispatch, or output bypasses `ProviderRuntimeIngestion`.

GREEN:
Add the smallest reactor/outbox API and make it idempotent by durable event sequence plus command id.

Refactor proof: add the static guard only after the behavior passes, proving no new production reactor/sink path calls `translateProviderRuntimeEventToDomain` directly.

### 9. Handler Compatibility And Command Id Requirements

RED:
For each mutating browser command, add one handler/domain-service test only when that command is being wired. Start with prompt/send turn.

Proof command:

```bash
pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts -t "requires commandId for mutating provider commands|preserves prompt dispatch compatibility"
```

Expected RED shape: handler accepts a mutating command without `commandId`, or compatibility facade no longer returns the shape existing callers expect.

GREEN:
Require `commandId` for mutating commands while preserving the old facade result until callers are migrated.

Refactor proof: migrate one handler at a time; do not batch prompt, permission, question, model, settings, reload, and context-window changes.

### 10. Cleanup Guards Last

RED:
Only after behavior tests prove replacement paths, add guards for deleted in-memory paths and forbidden imports.

Proof command:

```bash
pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts test/unit/provider/orchestration-dispatch-boundary.test.ts
```

Expected RED shape: `processedCommands`, toy idempotency, mutable authoritative `sessionBindings`, or provider-output bypass imports still exist.

GREEN:
Delete obsolete code. If a compatibility facade remains, document the behavior it preserves and guard that it is not authoritative.

## Anti-Patterns To Remove From The Plan Execution

- Do not implement "add scenario-first durable receipt and event-store independence tests" as one large RED. Pick one scenario, make it fail, make it pass, then continue.
- Do not create all listed test files before behavior exists. File names in the source plan are ownership hints, not a horizontal test-writing phase.
- Do not verify durable command behavior mainly through `CommandReceiptRepository.check/record`; those tests are supporting proof only.
- Do not mock `CommandReceiptRepository`, `EventStore`, `ProjectionRunner`, or the decider inside orchestration behavior tests. Use real SQLite and fake only provider/runtime boundaries.
- Do not use sleeps or real timers for queue/concurrency tests. Use `Deferred`, `Fiber`, and `TestClock` where time matters.
- Do not let static grep guards substitute for behavior. Use them after the behavior is green to prevent architectural drift.
- Do not assert internal call order unless it is the public behavior, such as "provider is called only after a committed requested event."
- Do not pre-seed `sessions` in new event-log independence tests. That hides the target failure.
- Do not run broad suites as acceptance proof for each cycle. Use focused Vitest commands, then run broader checks only at phase boundaries.

## Risks And Uncertainty

- Crash policy is still unresolved. Spike accepted-before-side-effect and provider-completed-before-persisted-completion as public recovery behavior before wiring handlers.
- Duplicate return shape is still unresolved. Decide whether duplicates return prior `TurnResult`, command ack, or read-model status before broad handler migration.
- The current receipt schema is too small for fingerprint and side-effect state. Let the first failing behavior drive the minimum schema expansion.
- Event-store FK removal can affect eviction and read-model cleanup. Keep migration tests focused on old DBs, empty DBs, and replay from persisted events.
- `ProviderRuntimeIngestionLive` currently owns a pre-seed workaround. Removing it may surface projector assumptions that should be fixed at the projector/read-model boundary.
- External provider calls cannot be rolled back. The reactor/outbox tests must prove retry/idempotency policy without pretending SQLite covers provider execution.
- Existing relay command gate code already has a decider/projector shape for relay commands. Reuse its lessons, but do not couple durable provider orchestration tests to relay internals unless the public interface becomes shared.
