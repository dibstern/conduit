# Durable Receipts Architecture Improvements

Review target:
`docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md`

This is a source-grounded amendment note. It does not replace the target plan.

## Source Grounding

- `CONTEXT.md` defines Conduit as a browser-facing orchestrator with durable conversation state in its own event store while Provider Runtime implementations execute stateless turns.
- `docs/agent-guide/architecture.md` says the SQLite event store is the durable handoff between Provider Runtime instances and browser clients, and projectors maintain materialized views from the append-only event log.
- `docs/agent-guide/testing.md` points this kind of change at focused unit, persistence, Effect guardrail, and selected integration tests.
- `docs/adr` does not exist in this checkout, so there are no ADR constraints to preserve or reopen.
- The legacy OpenCode runtime ingress file is already absent, but direct provider output mapping remains in nearby code.

## Current Architectural Friction

- The target plan has the right direction, but it mostly lists new files and phases. It does not yet name the external Module whose Interface callers and tests should use after the decider/projector work lands. That leaves room for shallow Modules where tests learn queue ordering, receipt lookup, projection order, and side-effect timing separately.
- `OrchestrationEngine` still combines provider lookup, mutable session binding, in-memory command dedupe, command routing, and provider side effects in one Implementation. Its Interface keeps `commandId` optional for mutating commands, while the target plan requires durable `commandId`.
- `websocket-callback-wiring.ts` creates a relay command id for `RelayCommandGate`, but `prompt.ts` and `provider-turn-service.ts` do not carry that id into `OrchestrationEngine.dispatchEffect`. The durable receipt plan needs an explicit command identity Seam before it can make duplicate/retry semantics reliable.
- `CommandReceiptRepository` exists, but it is still a small check/record wrapper with `accepted | rejected` status and no fingerprint, aggregate fields, upsert, or transaction owner. The current deletion test says the Module is not yet deep: deleting it would mostly move one `SELECT` and one `INSERT` into callers.
- `ProviderRuntimeIngestion` exists, but `EventSinkImpl`, `RelayEventSink`, `ClaudeEventPersistEffect`, and Claude subagent materialization still translate or append/project provider output directly. This keeps the provider-output Seam optional even though the target plan says provider output should converge before side-effect reactor work depends on it.
- Event append still depends on `sessions` through the `events.session_id` foreign key, and both `ProviderRuntimeIngestion` and Claude persistence pre-seed `sessions`. The target plan names this, but the transaction owner for append + projection + receipt is not yet a deep Module.

## Deepening Opportunities

### 1. Make Provider Command Identity A First-Class Module

**Files**

- `docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md`
- `src/lib/relay/websocket-callback-wiring.ts`
- `src/lib/relay/ws-message-dispatch-effect.ts`
- `src/lib/handlers/prompt.ts`
- `src/lib/domain/relay/Services/provider-turn-service.ts`
- `src/lib/provider/orchestration-engine.ts`
- `test/unit/provider/orchestration-engine*.test.ts`

**Problem**

The target plan says mutating commands require `commandId`, but live command types still allow missing ids. The WebSocket layer generates a command id for the relay command gate, then the provider turn path drops it before dispatching `send_turn` or `interrupt_turn`. That makes command identity a caller convention instead of an Interface invariant.

**Solution**

Add a small Provider Command Identity Module before Phase 2. Its Interface should define where durable provider command ids come from, how they flow from browser message handling into provider orchestration, and how stable fingerprints are derived without runtime handles. The Implementation can still preserve the old `dispatchEffect` compatibility facade, but it should reject missing ids for mutating commands before provider lookup or provider side effects.

Specific target-plan amendment: add a Phase 0a between preflight and receipt repository: "prove command id propagation from relay command gate or browser origin id into provider command dispatch; mutating provider commands without durable command id fail before provider lookup."

**Benefits**

- **Depth:** callers learn one command identity Interface instead of remembering which fields must be present on each command variant.
- **Leverage:** the same command id and fingerprint logic covers send, interrupt, permission, question, and end-session commands.
- **Locality:** duplicate/retry bugs concentrate in one Module instead of spreading across WebSocket wiring, handlers, provider turn code, and engine tests.
- **deletion test:** if this Module is deleted, command id rules reappear in at least four callers, so it earns its keep.

### 2. Name One Deep Provider Command Orchestration Module

**Files**

- `src/lib/provider/orchestration-engine.ts`
- `src/lib/provider/orchestration-wiring.ts`
- planned `src/lib/provider/orchestration-command-contracts.ts`
- planned `src/lib/provider/orchestration-decider.ts`
- planned `src/lib/provider/orchestration-projector.ts`
- planned `src/lib/provider/orchestration-read-model.ts`
- planned `src/lib/provider/orchestration-side-effect-reactor.ts`
- `src/lib/domain/relay/Services/provider-turn-service.ts`
- `src/lib/domain/relay/Services/services.ts`

**Problem**

The plan creates several orchestration files but does not say which Module owns the external Interface. That risks a shallow split where decider, projector, receipt lookup, command read model, and reactor each expose enough details that tests must know the whole Implementation sequence.

**Solution**

Amend the plan to name a single external Provider Command Orchestration Module. Its Interface should accept durable provider commands and expose command acknowledgement/read status through the compatibility facade. The decider, projector, command read model, receipt repository, queue worker, and side-effect reactor should be internal Implementation details unless a second Adapter proves a real Seam.

Specific target-plan amendment: replace the flat "Create" file list with a Module map that names the external Module, its Interface owner, its internal Implementation files, and the tests that cross the Interface. Keep the planned files if useful, but make them private-to-module Implementation files.

**Benefits**

- **Depth:** handler and provider-turn callers get one small orchestration Interface while a large amount of queueing, receipt, read-model, and reactor behavior sits behind it.
- **Leverage:** scenario tests can exercise duplicate, restart, provider lookup, and crash-window behavior through the same Interface.
- **Locality:** changes to receipt statuses or projector internals stay inside the orchestration Module.
- **deletion test:** deleting five shallow files should not make the system simpler; deleting the one external Module should force its complexity back into handlers, provider instances, and persistence callers.

### 3. Make Durable Command Commit A Persistence Module

**Files**

- `src/lib/persistence/event-store.ts`
- `src/lib/persistence/effect/event-store-effect.ts`
- `src/lib/persistence/projection-runner.ts`
- `src/lib/persistence/effect/projection-runner-effect.ts`
- `src/lib/persistence/command-receipts.ts`
- `src/lib/persistence/migrations/0001_current_event_store.sql`
- `src/lib/persistence/effect/migrations.ts`
- planned orchestration engine/receipt tests

**Problem**

The target plan requires event append, projection update, and receipt write to commit transactionally. Live persistence does not yet offer that as a single Interface. `EventStore.appendBatch` owns its own transaction, `ProviderRuntimeIngestion` opens a transaction for pre-seed + append and then projects afterward, and `CommandReceiptRepository` only exposes separate check/record calls.

If the engine has to coordinate these low-level calls, the transaction rules become part of the engine Interface. That is shallow because callers must understand the Implementation order to use the Module correctly.

**Solution**

Add a Durable Command Commit Module after event-log independence and before engine queue integration. Its Interface should commit planned command events plus the command receipt in one SQL transaction, with projection/read-model update inside the same durable commit policy selected by the plan. Provider side effects remain outside this Module and are triggered only after committed side-effect-requested events.

Specific target-plan amendment: add a Phase 2b "durable command commit" before the engine queue phase. It should include rollback/commit tests proving receipt, event append, and command read model projection appear together or not at all.

**Benefits**

- **Depth:** the engine asks for one durable commit instead of learning event store, projection, and receipt ordering.
- **Leverage:** every mutating command gets the same transaction semantics.
- **Locality:** schema and transaction changes stay in persistence and commit tests, not in orchestration handlers.
- **deletion test:** without this Module, transaction complexity moves into the engine queue and future reactor recovery code.

### 4. Make ProviderRuntimeIngestion The Mandatory Provider-Output Seam

**Files**

- `src/lib/domain/relay/Services/provider-runtime-ingestion-service.ts`
- `src/lib/domain/relay/Services/opencode-runtime-ingress-service.ts`
- `src/lib/provider/event-sink.ts`
- `src/lib/provider/relay-event-sink.ts`
- `src/lib/persistence/effect/claude-event-persist-effect.ts`
- `src/lib/provider/claude/claude-subagent-materializer.ts`
- `src/lib/provider/provider-runtime-event-to-domain.ts`
- `test/unit/provider/provider-runtime-ingestion.test.ts`
- `test/unit/provider/relay-event-sink*.test.ts`
- `test/unit/effect/runtime-boundary-grep.test.ts`

**Problem**

The plan currently says provider output enters through `ProviderRuntimeIngestion` unless a compatibility exception is documented, and the Files section says to modify `event-sink.ts` and `relay-event-sink.ts` only "if Phase 5 chooses" that path. Live code still has multiple direct mapper/append/project paths. That weakens the Seam and makes the side-effect reactor easy to wire to the wrong Adapter.

**Solution**

Make `ProviderRuntimeIngestion` mandatory for production provider output before the side-effect reactor is accepted. OpenCode SSE and Claude SDK paths should be Adapters that emit `ProviderRuntimeEvent` into the same ingestion Interface. Any live relay fast path should consume committed domain events or a named transient Adapter whose non-durable role is guarded by tests. Direct production imports of `translateProviderRuntimeEventToDomain` outside ingestion/translator tests should be deleted or explicitly reclassified.

Specific target-plan amendment: change Phase 5 from optional convergence to a hard prerequisite for side-effect reactor completion, and add `ClaudeEventPersistEffect` plus Claude subagent materialization to the provider-output convergence file list.

**Benefits**

- **Depth:** provider output has one durable ingestion Interface hiding mapping, append, projection, and replay expectations.
- **Leverage:** both OpenCode and Claude output use the same recovery and replay tests.
- **Locality:** provider event vocabulary changes concentrate in the translator and ingestion Module.
- **Adapter clarity:** OpenCode SSE and Claude SDK become real Adapters at the same Seam; direct mapper callers are not additional accidental Seams.
- **deletion test:** deleting direct sink paths should not remove behavior; it should move behavior behind `ProviderRuntimeIngestion`.

### 5. Move Provider Session Binding Behind A Read Model Module

**Files**

- `src/lib/provider/orchestration-engine.ts`
- `src/lib/domain/relay/Services/provider-turn-service.ts`
- `src/lib/domain/relay/Services/session-manager-service.ts`
- `src/lib/handlers/model.ts`
- `src/lib/handlers/settings.ts`
- `src/lib/handlers/permissions.ts`
- `src/lib/domain/relay/Services/agent-service.ts`
- `src/lib/persistence/projectors/provider-projector.ts`
- `src/lib/persistence/projectors/session-projector.ts`
- `src/lib/persistence/effect/read-query-effect.ts`

**Problem**

The target plan says the read model should recover session bindings and the mutable map should disappear, but it does not name the owner. Live code writes provider binding state in several places: `OrchestrationEngine.sessionBindings`, provider turn preparation, session materialization, model/settings handlers, permissions, and agent lookup paths.

**Solution**

Add a Provider Session Binding Read Model Module. Its Interface should answer the active provider for a session and expose the compatibility facade used by current handlers. Its Implementation should be driven from durable events such as `session.created`, `session.provider_changed`, and accepted command events. The orchestration engine should not be the owner of binding mutation after this phase.

Specific target-plan amendment: split Phase 7 cleanup into an earlier "binding read model cutover" phase before handler compatibility is considered done. Add acceptance tests where a fresh engine recovers provider binding from persisted events and handlers never observe the mutable map.

**Benefits**

- **Depth:** callers get active-provider lookup without knowing whether it came from session projection, provider projection, or command read model.
- **Leverage:** permission, question, model, settings, agent, and interrupt flows all share recovered binding semantics.
- **Locality:** provider-switch bugs move to one projection/read-model Module.
- **deletion test:** deleting the read model should force provider lookup rules back into every handler that currently asks the engine map.

## Specific Edits To Fold Into The Target Plan

1. Add an "Architecture Module Map" after `Files` with columns: Module, Interface owner, Implementation files, Adapters, tests crossing the Seam, forbidden imports.
2. Add Phase 0a: command identity propagation and fingerprint spike. Require mutating command ids to reach provider orchestration before receipt work.
3. Add Phase 2b: Durable Command Commit Module. Prove append + projection/read-model update + receipt write commit or roll back together.
4. Change `src/lib/provider/event-sink.ts` and `src/lib/provider/relay-event-sink.ts` wording from "if Phase 5 chooses" to "must converge or be explicitly reclassified outside production provider output before side-effect reactor completion."
5. Add `src/lib/persistence/effect/claude-event-persist-effect.ts` and `src/lib/provider/claude/claude-subagent-materializer.ts` to the provider-output convergence list.
6. Add a static guard that production imports of `translateProviderRuntimeEventToDomain` are limited to translator/ingestion ownership, with any exception named in the plan.
7. Change the mutating command tests from "allows commands without commandId" to "rejects mutating commands without commandId before provider lookup."
8. Add a handler-to-orchestration test proving the WebSocket or browser-origin command id becomes the provider command id for `send_turn` and `interrupt_turn`.
9. Add a binding read-model cutover phase before final cleanup. The done state should say `getProviderForSession` is a compatibility read over recovered projection state, not an engine-owned map.
10. Add a short note that `docs/adr` is absent in this checkout; if the parent wants the provider-output Seam or command commit policy recorded as an ADR later, create ADR infrastructure separately.

## Risks Or Uncertainty

- The current relay command id is process-local (`clientId:sequence`). It may not be stable enough for browser retry after reconnect. The plan should decide whether durable provider command id comes from browser `originId`, a new client-supplied id, or a deterministic relay-generated id persisted before dispatch.
- Projection inside the same SQL transaction as event append and receipt write may conflict with current projector recovery assumptions. The spike should decide whether "projection update inside transaction" means all projection tables or only the command read model needed for receipts.
- Removing the `events.session_id -> sessions.id` foreign key is a real migration, not a cosmetic schema edit. Existing DB migration and recovery tests need to cover old and empty databases.
- Claude user-message persistence and Claude subagent materialization may not be pure provider output. If they are not moved through `ProviderRuntimeIngestion`, the plan should explicitly classify their Module role and guard that they cannot be copied by the side-effect reactor.
- The target plan is ready only if full `ProviderRuntimeEvent` adoption and the legacy OpenCode ingress deletion are complete or reclassified. The legacy OpenCode file is absent in this checkout, but direct provider-output mapper paths still exist.
