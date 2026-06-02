# Claude Provider Runtime And Provider Turn Module Plan

**Date:** 2026-05-18
**Status:** Implemented and verified on 2026-06-02 after merge from `main`

## Completion Update, 2026-06-02

- [x] Merged `main` into `ds/provider-runtime-turn-module`.
- [x] Strengthened the latest-sink proof in `claude-provider-instance-send-turn.test.ts`: a follow-up turn reuses the live SDK query, does not send second-turn completion events to the stale first sink, and does send them to the second sink.
- [x] Added the repeated-interrupt proof in `claude-provider-instance-lifecycle.test.ts`: a second interrupt of an already-interrupted active session is harmless and does not close or interrupt resources twice.
- [x] Ran the current Claude provider unit suite: `pnpm vitest run test/unit/provider/claude`.
- [x] Ran the current Claude provider integration proof: `pnpm exec vitest run --config vitest.integration.config.ts test/integration/flows/claude-provider-instance.integration.ts`. The older direct `pnpm vitest run ...` command does not include integration tests in this repo's default Vitest project set.
- [x] Ran handler and Effect guard proofs, `pnpm check`, `git diff --check`, and the optional live Claude SDK E2E command.

## Goal

- [ ] Make Claude provider execution Effect-owned.
- [ ] Keep `ClaudeProviderInstance` only as a thin `ProviderInstance` facade if the public interface still requires it.
- [ ] Move provider-turn policy out of `src/lib/handlers/prompt.ts`.
- [ ] Use `ProviderRuntimeEvent` in Claude runtime tests or parallel translation vocabulary, without changing storage/relay/frontend behavior.

## Agent Rules

- [ ] First look for problems with this plan. If the codebase disagrees, stop.
- [ ] If instructions are unclear, ask questions before editing.
- [ ] If reality differs from the plan, stop, explain expected vs found, and ask.
- [ ] Use TDD. Add the failing behavior/guard test before the implementation slice.
- [ ] Do not bulk-rewrite Claude. Prove one runtime behavior, make it pass, then continue.

## Prereqs

- [ ] Provider boundary schema work is merged and green.
- [ ] `src/lib/contracts/providers/provider-runtime-event.ts` exists.
- [ ] Baseline passes: `pnpm vitest run test/unit/provider/claude`.
- [ ] Baseline passes: `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts`.
- [ ] If baseline fails, stop and report exact failures before editing.

## Target Shape

- [ ] Add `ClaudeProviderRuntimeTag` / `ClaudeProviderRuntimeLive`.
- [ ] Runtime owns sessions with `Ref<HashMap<sessionId, ClaudeSessionState>>`.
- [ ] Runtime owns setup locks and turn waiters with `Deferred`, not class `Map`s.
- [ ] Runtime owns active SDK stream consumers with `FiberMap` or scoped fibers.
- [ ] Runtime uses `Clock`, `Schedule`, `Effect.sleep`, and finalizers instead of ad hoc timers/promises.
- [ ] SDK `query()` and `canUseTool` remain external callback/Promise boundaries only.
- [ ] Translator writes return `Effect`, not `Promise`, and do not receive `runEffect`.
- [ ] Capabilities cache becomes Layer-owned and testable with `TestClock`.
- [ ] Permission core becomes `ClaudePermissionService`; only the SDK callback adapter returns `Promise`.
- [ ] Provider turn module lives under relay/domain ownership. Recommended path: `src/lib/domain/relay/Services/provider-turn-service.ts`.

## Implementation Patterns

- [ ] Define services with `Context.Tag` plus `Layer.effect` / `Layer.scoped`. Do not use `Effect.Service`.
- [ ] Use `Layer.scoped`, `Effect.addFinalizer`, and `Effect.forkScoped` for Claude stream lifecycle. Do not use `Effect.forkDaemon` for SDK consumers.
- [ ] Use `FiberMap` for per-session Claude stream fibers. Avoid `Map<string, Fiber>` and manual interrupt loops unless documented inline.
- [ ] Use `Ref` or `SynchronizedRef` with `HashMap` for session/runtime state. Use native `Map` only when values contain mutable Effect primitives, and document the exception inline.
- [ ] Use `Deferred` for setup locks, turn waiters, shutdown coordination, and one-shot SDK/result waits.
- [ ] Do not add hand-rolled `new Promise`, `Promise.race`, timeout promises, or runtime `setTimeout` for app-owned coordination.
- [ ] Use `Clock`, `Duration`, `Schedule`, `Effect.sleep`, and `TestClock` for time and TTL behavior.
- [ ] Keep SDK Promise boundaries tiny and named. The SDK `canUseTool` adapter may return `Promise`; the permission core must return `Effect`.
- [ ] The SDK callback adapter should be the only Claude production `Effect.runPromise` edge. Update the runtime-boundary allowlist if the adapter file/name changes.
- [ ] Use `Data.TaggedError` for expected failures. Expose expected failures in the `E` channel.
- [ ] Use `Effect.catchTag` for expected errors. Use broad `catchAll` only for deliberate degrade paths with warning/error logging.
- [ ] Use `@effect/vitest` `it.effect` / `it.scoped` for tests that run Effect programs. Do not wrap with manual `Effect.runPromise`.
- [ ] Use `Layer.fresh(testLayer)` for stateful test Layers.
- [ ] Use `TestClock.adjust(...)` for time-dependent tests. Do not sleep real time in unit tests.
- [ ] Use `Effect.annotateLogs` and `Effect.withSpan` around send turn, stream consume, permission, capability probe, interrupt, shutdown. Include provider id, session id, and turn id where available.
- [ ] Make Claude capabilities cache Layer-owned. No module-level singleton `TTLCache`; use `Clock`/`TestClock` and in-flight dedupe with `Deferred`.
- [ ] Keep provider-turn policy separate from Claude SDK runtime. `ProviderTurnService` owns relay policy; Claude runtime owns SDK session execution.
- [ ] Translators must be pure or return `Effect`. Do not inject a Promise-shaped `runEffect` callback into translator code.
- [ ] Use `ProviderRuntimeEvent` only as pre-storage vocabulary or test target. Do not replace `CanonicalEvent`, `RelayEventSink`, event-store schemas, or frontend messages in this PR.
- [ ] Build explicit fake SDK stream fixtures for blocking streams, malformed items, result messages, stream errors, abort, and subagent events. Avoid generic happy-path async generators.

## Provider Turn Module Scope

- [ ] Move from `prompt.ts`: provider selection, Claude prior-history load, first-Claude title start, Claude user-message persistence, event sink creation, provider-state load/save, `SendTurnInput` assembly, dispatch result/failure handling.
- [ ] Keep in `prompt.ts`: client message adapter, missing-session error, input draft clear/sync, user echo to other clients, processing status broadcast, high-level call into provider turn module.
- [ ] Preserve current OpenCode behavior: no-op sink, REST fallback only if orchestration engine absent.
- [ ] Preserve current Claude behavior: first-message title starts only when history loaded empty and user-message persistence succeeded.

## Files

- [ ] Create: `src/lib/provider/claude/claude-provider-runtime.ts`
- [ ] Create: `src/lib/provider/claude/claude-translation-service.ts` or equivalent tested Effect translator module.
- [ ] Create: `src/lib/provider/claude/claude-permission-service.ts`
- [ ] Create: `src/lib/provider/claude/claude-capabilities-service.ts`
- [ ] Create: `src/lib/domain/relay/Services/provider-turn-service.ts`
- [ ] Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- [ ] Modify: `src/lib/provider/claude/claude-event-translator.ts`
- [ ] Modify: `src/lib/provider/claude/claude-permission-bridge.ts`
- [ ] Modify: `src/lib/provider/claude/claude-capabilities-probe.ts`
- [ ] Modify: `src/lib/provider/claude/types.ts`
- [ ] Modify: `src/lib/provider/claude/index.ts`
- [ ] Modify: `src/lib/provider/orchestration-wiring.ts`
- [ ] Modify: `src/lib/handlers/prompt.ts`
- [ ] Modify if wiring needs it: `src/lib/domain/relay/Services/services.ts`, `src/lib/domain/relay/Layers/relay-core-layers.ts`, `src/lib/relay/relay-stack.ts`
- [ ] Tests: `test/unit/provider/claude/*`, `test/integration/flows/claude-provider-instance.integration.ts`, `test/unit/handlers/*prompt*`, `test/unit/effect/runtime-boundary-grep.test.ts`

## Phases

- [ ] Phase 0, spike: prove runtime service + thin facade + fake SDK stream design. No broad integration until this passes.
- [ ] Phase 1, Provider Turn Module: extract prompt policy behind tests, keep behavior identical.
- [ ] Phase 2, Claude runtime state: move sessions, locks, turn waiters, ended-stream state into Effect runtime.
- [ ] Phase 3, SDK stream fiber: replace `streamConsumer: Promise<void>` with scoped fiber ownership and abort finalizers.
- [ ] Phase 4, translator/permission/capabilities: remove Promise bridges from Claude internals except SDK callback adapter.
- [ ] Phase 5, ProviderRuntimeEvent assertions: Claude runtime tests assert emitted/planned runtime events match contract before canonical translation.
- [ ] Phase 6, guardrails and integration tests.

## Acceptance Criteria

Regular validation is not acceptance. Every criterion below needs a named proof with exact assertions.

| Criterion | Proof | Expected Assertion |
|---|---|---|
| `prompt.ts` no longer owns provider-turn policy. | Static guard plus provider-turn service tests. | `prompt.ts` has no Claude history/persistence/event-sink/provider-state policy imports or branches; it delegates one high-level provider-turn call. |
| Provider-turn extraction preserves Claude first-turn behavior. | `provider-turn-service.test.ts`: "dispatches first Claude turn". | Empty persisted history + successful user-message persistence starts title, builds RelayEventSink, loads provider state, dispatches `send_turn`. |
| Provider-turn extraction preserves non-first Claude behavior. | `provider-turn-service.test.ts`: "does not title non-first Claude turn". | Non-empty history dispatches turn and does not call `startForFirstClaudeMessage`. |
| Provider-turn extraction preserves non-fatal persistence behavior. | `provider-turn-service.test.ts`: "user-message persistence failure is non-fatal". | Dispatch still runs; title is not started; warning is logged. |
| Provider-turn extraction preserves provider-state behavior. | `provider-turn-service.test.ts`: "loads and persists provider state". | Existing state is passed into `SendTurnInput`; successful result updates are saved; save failure logs and does not fail turn. |
| Provider-turn extraction preserves OpenCode behavior. | `provider-turn-service.test.ts`: "dispatches OpenCode without Claude services". | No Claude history/persistence/title/event-sink creation; no-op sink is used; existing fallback behavior remains if orchestration engine is absent. |
| Claude runtime state is Effect-owned. | Static guard in `claude-provider-runtime-boundary.test.ts`. | No production class-owned `sessions`, `sessionLocks`, `turnDeferredQueues`, `endedSessionStreams`, or `streamConsumer: Promise`. |
| Concurrent same-session first sends create one SDK query. | `claude-provider-runtime.test.ts`: "serializes concurrent first sends". | Fake SDK query called once; second send waits/enqueues; both turns resolve in order. |
| Follow-up turns reuse live session and latest sink. | `claude-provider-runtime.test.ts`: "uses latest event sink for follow-up". | No second query; second turn events go to second sink, not stale first sink. |
| Stream result resolves exactly one waiting turn. | `claude-provider-runtime.test.ts`: "resolves oldest waiter on result". | First `result` completes oldest waiter, updates resume state, leaves later waiter pending until next result. |
| Malformed SDK stream item fails before translation. | `claude-provider-runtime.test.ts`: "rejects malformed SDK message before translation". | Decoder failure returns typed provider failure; translator is not called; pending turn rejects/resolves error; stream finalizes. |
| Interrupt is idempotent and finalizes resources. | `claude-provider-runtime.test.ts`: "interrupt aborts active session". | Abort controller fired once, prompt queue closed, pending interactions cancelled, pending turn rejected/interrupted; second interrupt is no-op. |
| Shutdown interrupts all active Claude work. | `claude-provider-runtime.test.ts`: "shutdown interrupts all stream fibers". | All active stream fibers interrupted; all prompt queues closed; all pending turns rejected; no session state remains. |
| Permission logic is Effect-owned except SDK callback adapter. | Permission service tests plus runtime-boundary grep. | Approval, rejection, suggestions, questions, and abort outcomes match current bridge behavior; only SDK adapter has `Effect.runPromise`. |
| Capabilities cache is Layer-owned. | `claude-capabilities-service.test.ts` with `TestClock`. | TTL expiry uses `TestClock`; concurrent same-workspace probes dedupe in-flight query; cache is isolated per Layer. |
| Claude can target `ProviderRuntimeEvent` vocabulary. | Runtime/translator contract test. | Claude SDK fixtures decode to `ProviderRuntimeEventSchema` before canonical translation; provider refs and raw-source metadata are present. |
| Existing Claude behavior remains green. | Existing Claude unit/integration suites. | Current provider-instance and integration behavior tests pass without weakening assertions. |

## Scenario Acceptance Tests

Write these as Given/When/Then tests before implementation for each risky slice.

- [ ] Given a Claude first message in an empty persisted session, when provider-turn service sends it, then it persists the user message, starts automatic title generation, builds the RelayEventSink with pending-interaction hooks, loads provider state, and dispatches `send_turn`.
- [ ] Given Claude history load fails, when sending a message, then dispatch still runs with empty history, warning is logged, and first-title generation does not start.
- [ ] Given Claude user-message persistence fails, when sending the first message, then dispatch still runs, title generation does not start, and the failure is logged as non-fatal.
- [ ] Given provider-state save fails after a successful turn, when dispatch result returns updates, then the turn remains successful, warning is logged, and no error is sent to the browser.
- [ ] Given OpenCode is the selected provider, when sending a prompt, then no Claude persistence/history/title/event-sink policy is touched and OpenCode behavior is unchanged.
- [ ] Given two concurrent first sends for the same Claude session, when both enter the runtime, then exactly one SDK query is created and the second prompt is serialized through the same prompt queue.
- [ ] Given a second Claude turn uses a different sink, when SDK events arrive for that turn, then events are delivered to the latest sink only.
- [ ] Given the SDK stream ends naturally after a result, when another same-agent turn is sent, then the runtime creates a fresh query and uses a valid resume cursor if present.
- [ ] Given a stale resume cursor error from the SDK, when the stream fails, then the cursor is cleared and the next send starts fresh.
- [ ] Given the SDK yields malformed data after partial assistant output, when the decoder fails, then translation stops before the bad item, pending turn gets provider failure, and browser-facing error behavior matches current `turn.error`/`done` expectations.
- [ ] Given `interruptTurnEffect` runs during an active turn, when the SDK is blocked on stream output, then the stream fiber is interrupted, the abort controller fires, prompt queue closes, pending interactions cancel, and repeated interrupt is harmless.
- [ ] Given shutdown runs with multiple active Claude sessions, when finalizers execute, then all stream fibers and prompt queues close and no pending waiter remains unresolved.
- [ ] Given Claude asks for permission suggestions, when the user chooses a remembered destination, then only the selected SDK permission updates are returned to Claude.
- [ ] Given capability discovery is called concurrently for one workspace, when the first probe is still in flight, then only one SDK initialization probe runs and all callers receive the same result.
- [ ] Given a Claude SDK message fixture is mapped to provider runtime vocabulary, when decoded, then `ProviderRuntimeEventSchema` accepts it with provider refs/raw-source metadata and no raw SDK payload.

## TDD Process

- [ ] Add the failing scenario or static guard for one criterion.
- [ ] Implement the smallest slice to pass it.
- [ ] Run the narrow proof.
- [ ] Repeat. Do not write broad runtime code without a failing proof first.

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] `startDaemonProcess` imported by CLI. Prove: `rg -n "startDaemonProcess" src test` has no production hit.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition. Prove: `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts` passes.
- [ ] Provider-turn policy still in `prompt.ts`. Prove: `rg -n "persistUserMessage|createRelayEventSink|ProviderStateEffectTag|ReadQueryEffectTag|ClaudeEventPersistEffectTag|SessionTitleServiceTag|providerId === \"claude\"" src/lib/handlers/prompt.ts` returns no policy hit.
- [ ] Claude session state still class-owned. Prove: `rg -n "sessions = new Map|sessionLocks|turnDeferredQueues|endedSessionStreams|streamConsumer: Promise" src/lib/provider/claude` returns no production hit outside deleted compatibility comments.
- [ ] Translator Promise bridge still present. Prove: `rg -n "makeRuntimeEffectRunner|runEffect:|new ClaudeEventTranslator" src/lib/provider/claude` returns no production hit.
- [ ] Permission core still Promise-owned. Prove: only the SDK callback adapter has `Effect.runPromise`; update the runtime-boundary allowlist if the adapter file/name changes.
- [ ] Capability cache still global Promise state. Prove: `rg -n "getCachedClaudeCapabilities|new TTLCache|TTLCache" src/lib/provider/claude` returns no production hit except deleted compatibility exports explicitly reclassified.
- [ ] Ad hoc Claude timers/promises remain. Prove: `rg -n "Promise\\.race|new Promise|setTimeout|clearTimeout" src/lib/provider/claude/claude-provider-instance.ts src/lib/provider/claude/claude-provider-runtime.ts` returns no production hit, or each hit is an SDK/test adapter with a written reason.
- [ ] ProviderRuntimeEvent contract unused by Claude tests. Prove: at least one Claude runtime/translator test imports `ProviderRuntimeEventSchema` and decodes planned runtime events.
- [ ] Existing Claude behavior regressed. Prove: current Claude unit and integration suites pass.

## Verification Commands

These commands run the acceptance proofs. They are not acceptance criteria.

- [x] `pnpm vitest run test/unit/provider/claude`
- [x] `pnpm exec vitest run --config vitest.integration.config.ts test/integration/flows/claude-provider-instance.integration.ts`
- [x] `pnpm vitest run test/unit/handlers/prompt*.test.ts test/unit/handlers/effect-handlers.test.ts`
- [x] `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts`
- [x] `pnpm check`
- [x] `git diff --check`
- [x] Optional only with local Claude auth: `RUN_EXPENSIVE_E2E=1 pnpm vitest run --config vitest.e2e.config.ts test/e2e/provider/claude-provider-instance-real-sdk.test.ts`

## Risk

- [ ] High risk: Claude SDK stream lifetime mixes AsyncIterable, abort, subagent polling, and pending turn resolution. Spike first with fake AsyncIterable that blocks until abort; assert fiber interruption aborts and finalizes.
- [ ] High risk: extracting provider-turn policy touches the hot send-message path. Add golden behavior tests around `prompt.ts` before extraction.
- [ ] High risk: translator state is per stream, not global. Prefer Effect-owned state keyed by session/stream; avoid singleton mutable translator state.
- [ ] Tradeoff: pure translator returning events is simpler, but an Effect translation service can own sink writes and state. Pick the smallest shape that removes Promise bridges and keeps tests readable.
- [ ] Tradeoff: keep `ClaudeProviderInstance` facade if `ProviderInstance` consumers still expect a class-like object. Do not let the facade own live state.

## Out Of Scope

- [ ] No `OrchestrationEngine` rewrite.
- [ ] No `ProviderRegistry` rewrite.
- [ ] No OpenCode runtime refactor.
- [ ] No event-store schema or projector changes.
- [ ] No frontend protocol/UI changes.
- [ ] No replacement of `CanonicalEvent` or `RelayEventSink`.
- [ ] No required paid/live Claude E2E.

## Unresolved Questions

- [ ] Provider turn module location. Recommended: `src/lib/domain/relay/Services/provider-turn-service.ts`, because it owns relay policy, not Claude SDK behavior.
- [ ] Should Claude emit `ProviderRuntimeEvent` in production now? Recommended: no storage/relay changes; use contract in tests or internal parallel translation only.
- [ ] Should permission adapter remain in `claude-permission-bridge.ts`? Recommended: keep name if minimizing diff; rename only if runtime-boundary guard is updated in same PR.
- [ ] How should decode failure after partial assistant output resolve? Recommended: current behavior plus typed provider failure; pending turn resolves error, stream finalizes, no browser crash.
- [ ] How should stale resume cursor be cleared? Preserve current regex behavior for invalid/expired session errors, but cover it with a runtime test.
- [ ] How are subagent finalization failures handled? Preserve non-fatal warning behavior and pending child-session materialization best effort.
- [ ] What if event sink changes while stream is active? Preserve latest-sink-wins behavior.
- [ ] What if agent changes mid-turn? Preserve error result; no restart during active turn.
- [ ] What if provider state save fails after successful turn? Preserve non-fatal warning and do not fail turn.
- [ ] What if history load fails for Claude? Preserve empty-history fallback with warning and no first-title start.
- [ ] What if images, variant, context window, or agent are absent? Preserve current optional field behavior.

## Concrete Steps

1. Run prereq and baseline tests.
2. Spike fake SDK stream runtime service and facade; stop if finalization semantics are unclear.
3. Add provider-turn module failing tests, then extract prompt policy.
4. Add Claude runtime failing tests, then move session/turn state into Effect runtime.
5. Move stream consumer into scoped fiber ownership.
6. Convert translator, permission, and capabilities to Effect-owned services.
7. Add ProviderRuntimeEvent contract assertions in Claude tests.
8. Run verification commands and inspect acceptance proof failures directly.
9. Commit focused runtime, prompt-policy, tests, and docs changes.
