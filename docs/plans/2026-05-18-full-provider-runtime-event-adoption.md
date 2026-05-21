# Full ProviderRuntimeEvent Adoption Plan

**Date:** 2026-05-18
**Status:** Ready after provider-boundary schemas and `ProviderRuntimeEvent` contracts are green

## Goal

- [ ] Make `ProviderRuntimeEvent` the provider-generated ingress vocabulary for new provider events.
- [ ] Keep durable truth in Conduit-owned domain events. The current durable type may still be named `CanonicalEvent` until a focused rename/reclassification.
- [ ] Stop provider adapters/runtime modules from constructing durable domain events directly.
- [ ] Add a `ProviderRuntimeIngestion` seam that maps decoded `ProviderRuntimeEvent` into domain events before durable append/projection/relay.
- [ ] Sequence: adapter parity -> ingestion/domain-event mapper -> adapter cutover -> relay/projection ownership cleanup -> optional naming cleanup -> provider-instance identity only if tests prove need.

## Architecture Decision

- [ ] `ProviderRuntimeEvent` is not stored as the source of truth.
- [ ] The event store accepts only Conduit domain events. Runtime events are decoded at the provider boundary, ingested, and converted before append.
- [ ] Optional runtime traces are diagnostics only. A `provider_runtime_events` table or NDJSON trace may exist only if it is explicitly non-authoritative, bounded/redacted, and linked to domain events by `providerRefs`/event id.
- [ ] Projectors consume domain semantics, not provider lifecycle semantics.
- [ ] Relay/frontend delivery derives from projected read models and/or sequenced domain events, not raw provider runtime events.

## Agent Rules

- [ ] First look for issues with this plan. If code disagrees, stop.
- [ ] If instructions unclear, ask before editing.
- [ ] If reality differs from the plan, stop, explain expected vs found, and ask.
- [ ] Current `CONTEXT.md` says `ProviderRuntimeEvent` is not stored. This plan preserves that boundary. If implementation appears to require storing runtime events as truth, stop and ask.
- [ ] Do not add a provider-runtime event table/log unless a separate ADR marks it non-authoritative diagnostics.
- [ ] Use TDD. Add scenario-first tests for risky behavior before implementation.

## t3code Patterns To Use

- [ ] Keep runtime contracts schema-first and provider-neutral.
- [ ] Preserve provider refs under `providerRefs`; do not copy native ids into ad hoc payload fields.
- [ ] Use explicit `rawSource` labels aligned with local trace artifacts.
- [ ] Put ingestion/translation in its own service/module, like t3code `ProviderRuntimeIngestion`, not inside adapters/projectors.
- [ ] Add a drain hook for ingestion tests; do not use sleeps.
- [ ] Use bounded TTL caches only for ephemeral correlation state, like t3code's turn/message buffers.
- [ ] Use strict lifecycle guard tests for impossible provider event orderings; make any relaxed mode explicit.
- [ ] Derive internal command/event ids from provider runtime event ids where ingestion creates follow-up work.
- [ ] Use t3code's durable split: provider runtime events are ingress; durable events are application/domain events.
- [ ] Use t3code's relay shape: projected snapshot first, sequenced domain event/replay path second.

## Code Patterns

- [ ] Effect services use `Context.Tag` plus `Layer.effect`/`Layer.scoped`; no `Effect.Service`.
- [ ] Long-running ingestion workers use `Effect.forkScoped`; no `forkDaemon`.
- [ ] Use `Deferred`/drainable worker hooks for tests; no real-time sleeps.
- [ ] Export module-scope decoders from contract/translator modules; do not rebuild decoders on hot paths.
- [ ] Translators are pure or return `Effect`; no injected `runEffect`, `Runtime.runPromise`, or app-internal Promise bridges.
- [ ] Use `Data.TaggedError` for expected failures and `Effect.catchTag` for expected recovery.
- [ ] Keep raw payload trace/persistence behind a named redaction/size policy. No silent `JSON.stringify(raw)` in append paths.
- [ ] Add stable fixture builders for Claude/OpenCode provider runtime events; avoid copy-pasted inline mega fixtures.

## Prereqs

- [ ] `src/lib/contracts/providers/provider-runtime-event.ts` exists.
- [ ] Provider contracts tests pass.
- [ ] Current Claude/OpenCode provider unit suites pass.
- [ ] Current pipeline relay snapshot tests pass.
- [ ] If any prereq fails, stop and rebase/fix earlier work first.

## Out Of Scope

- [ ] No durable command receipts.
- [ ] No orchestration command decider/projector rewrite.
- [ ] No provider-runtime event store as source of truth.
- [ ] No broad provider-instance identity migration unless Phase 5 gate fails.
- [ ] No schema generation.
- [ ] No frontend redesign.
- [ ] No paid/live provider E2E requirement.

## Files

- [ ] Create: `src/lib/domain/relay/Services/provider-runtime-ingestion-service.ts`
- [ ] Create: `src/lib/domain/relay/Services/opencode-runtime-ingress-service.ts` for production OpenCode SSE ingress into `ProviderRuntimeIngestion`.
- [ ] Do not keep a sync legacy OpenCode ingress shim; production and tests use `EffectOpenCodeRuntimeIngress` plus `ProviderRuntimeIngestion`.
- [ ] Create: `src/lib/provider/provider-runtime-event-to-domain.ts` or, during naming transition, `src/lib/provider/provider-runtime-event-to-canonical.ts`.
- [ ] Create: `test/unit/provider/provider-runtime-event-parity.test.ts`
- [ ] Create: `test/unit/provider/provider-runtime-ingestion.test.ts`
- [ ] Create or update: static guard test proving `ProviderRuntimeEvent` is not imported by persistence storage/projectors.
- [ ] Modify: `src/lib/provider/types.ts`
- [ ] Modify: `src/lib/provider/event-sink.ts`
- [ ] Modify: `src/lib/provider/relay-event-sink.ts` only to remove provider-owned direct relay translation or move it behind the new domain-event owner.
- [ ] Modify: `src/lib/provider/claude/*translator*`, `src/lib/provider/claude/*runtime*`
- [ ] Modify: OpenCode provider runtime path currently depending on `CanonicalEventTranslator`.
- [ ] Modify: `src/lib/persistence/events.ts` only if domain-event metadata needs `providerRefs`/`rawSource`/ingestion fields.
- [ ] Do not modify `src/lib/persistence/event-store.ts` to accept `ProviderRuntimeEvent`.
- [ ] Do not modify `src/lib/persistence/projectors/*` to import `ProviderRuntimeEvent`.
- [ ] Modify: `src/lib/persistence/read-query-service.ts`, session history adapters if projections change.
- [ ] Modify: `src/lib/shared-types.ts`, `src/lib/frontend/*`, only if relay message shape changes.
- [ ] Modify docs: `CONTEXT.md` and ADR to state `ProviderRuntimeEvent` is provider ingress, not durable truth.

## Phases

- [ ] Phase 0, spike: prove ingestion/domain-event parity, historical canonical recovery, and optional diagnostics policy. No broad integration.
- [ ] Phase 1, adapter parity: Claude/OpenCode produce `ProviderRuntimeEvent` fixtures matching old behavior through the ingestion mapper.
- [ ] Phase 2, ingestion mapper: `ProviderRuntimeEvent -> domain event(s)` feeds the current store/projectors/relay. Runtime behavior unchanged.
- [ ] Phase 3, adapter cutover: providers emit `ProviderRuntimeEvent` into ingestion; providers no longer construct durable domain events.
- [ ] Phase 4, relay/frontend cleanup: relay messages derive from projected read models or sequenced domain events; remove provider-owned relay translation.
- [ ] Phase 5, provider-instance identity gate: add instance-id routing only if tests prove `provider` string is ambiguous.

## Scenario-First Acceptance Tests

- [ ] Given a Claude assistant stream with text, reasoning, tool start/running/completion, permission, question, and final result, when emitted as `ProviderRuntimeEvent`, then ingestion persists the same domain history, projected rows, and relay messages as the current path.
- [ ] Given OpenCode SSE `message.created`, part deltas, tool part updates, permission, question, status, and session title update, when emitted as `ProviderRuntimeEvent`, then ingestion persists the same domain state and relay snapshots as current behavior.
- [ ] Given historical `CanonicalEvent` rows in SQLite, when recovery runs after this migration, then they replay/project exactly once without requiring provider runtime rows.
- [ ] Given duplicate or replayed `content.delta` / reasoning deltas entering ingestion, when domain events are appended/projected, then message text is not doubled.
- [ ] Given tool completion arrives without prior item start, when ingested/projected, then either compatibility start is synthesized or event is rejected per explicit test.
- [ ] Given partial assistant output then provider decode failure, when ingestion/appending/projecting runs, then already accepted domain output remains readable and the terminal error/done behavior matches current UI expectations.
- [ ] Given raw provider payload exceeds the selected size/redaction policy, when ingestion or trace writing runs, then durable domain rows do not store unbounded/secret raw content.
- [ ] Given diagnostics/runtime traces are absent, expired, or disabled, when recovery, projection, and relay replay run, then they still reconstruct behavior from durable domain events only.
- [ ] Given an unknown runtime event type, when ingestion decode runs, then it fails closed before durable append unless an explicit ignore fixture names the reason.

## Acceptance Criteria Matrix

| Criterion | Proof | Expected Assertion |
|---|---|---|
| `ProviderRuntimeEvent` is ingress only. | Static import guard plus docs/ADR update. | `ProviderRuntimeEvent` is imported by provider/ingestion code, not event-store, projection-runner, or projectors. |
| OpenCode runtime ingress is not persistence-owned. | Static guard plus relay-stack wiring test. | The old `src/lib/persistence/*dual-write*` files do not exist; production OpenCode SSE ingress lives under relay/domain ownership, calls `ProviderRuntimeIngestion.ingestBatch`, and has no sync legacy shim. |
| Runtime providers no longer emit durable domain events directly. | Static guard plus provider parity tests. | Provider runtime code has no active `canonicalEvent(` construction; Claude/OpenCode fixtures enter as `ProviderRuntimeEvent`. |
| Ingestion preserves old behavior before relay cleanup. | `provider-runtime-event-parity.test.ts`. | For each Claude/OpenCode fixture, `ProviderRuntimeEvent -> domain event(s)` equals the old durable event sequence. |
| Durable append still accepts only decoded domain events. | Event-store unit/static test. | Malformed runtime envelopes cannot be appended directly to SQLite. |
| Historical canonical rows remain readable. | Existing recovery tests plus migration regression. | Old rows replay; projected sessions/messages/turns match pre-migration expectations without runtime rows. |
| Projectors consume domain semantics, not SDK/runtime shapes. | Projector unit tests and import guard. | Projectors do not import Claude/OpenCode SDK types, provider implementation modules, or `ProviderRuntimeEvent`. |
| Replay is idempotent for streaming deltas. | Ingestion/recovery test with overlapping sequence window. | Text/thinking content after replay equals single application, not doubled. |
| Relay/browser behavior remains stable. | Pipeline relay snapshot tests from same fixture corpus. | Existing `RelayMessage` sequence for text, thinking, tools, result, error, permission/question is unchanged or explicitly reclassified. |
| Raw payload persistence is bounded and non-authoritative. | Raw policy unit test. | Oversized/secret-looking raw payload is rejected, redacted, or trace-only; durable domain rows do not silently store full raw payloads. |
| Diagnostics/runtime traces are optional and non-authoritative. | Recovery/projection/relay replay test with trace storage disabled or cleared. | Recovery, projection, and relay output match the baseline using only durable domain events. |
| Provider refs are first-class. | Ingestion mapper tests. | Native Claude/OpenCode session/item/request ids land in `providerRefs`/domain metadata, not payload-specific fields. |
| Previous contract-only guard is deliberately reclassified. | Contracts boundary test update. | Test explains `ProviderRuntimeEvent` may be imported by provider ingestion, but not by storage/projectors as durable truth. |

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] `EventSink.push(event: CanonicalEvent)` in provider interface. Prove with grep or a static test.
- [ ] Providers constructing canonical events. Prove with grep over `src/lib/provider src/lib/relay`.
- [ ] OpenCode runtime path depends on `CanonicalEventTranslator`. Prove with grep; only the new ingestion mapper may convert runtime events to domain events.
- [ ] OpenCode runtime ingress physically lives under `src/lib/persistence` or has a sync legacy shim. Prove old dual-write files and `opencode-runtime-ingress-legacy.ts` are gone and production relay wiring uses `makeEffectOpenCodeRuntimeIngress` with `ProviderRuntimeIngestion`.
- [ ] Claude runtime path emits `CanonicalEvent`. Prove with grep over `src/lib/provider/claude`.
- [ ] Provider-owned relay sink translates provider events directly. Prove relay delivery is owned by read models/domain events, or explicitly justify any parity-tested live fast path.
- [ ] Projectors import `ProviderRuntimeEvent` or provider SDK types. Prove projectors/projection runner remain domain-event-only.
- [ ] `tool.input_updated` actively emitted. Prove no active provider/relay emitter remains.
- [ ] `ProviderRuntimeEvent` imported by persistence storage as durable truth. Prove no active event-store/projector import remains.
- [ ] `provider_runtime_events` table is authoritative. Prove no such table exists, or docs/tests mark it diagnostics-only.
- [ ] `startDaemonProcess` imported by CLI. Prove no production hit.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition. Prove runtime boundary guard passes.

## Verification Commands

- [ ] `pnpm vitest run test/unit/contracts/providers`
- [ ] `pnpm vitest run test/unit/provider/provider-runtime-event-parity.test.ts`
- [ ] `pnpm vitest run test/unit/provider/provider-runtime-ingestion.test.ts`
- [ ] `pnpm vitest run test/unit/domain/relay/opencode-runtime-ingress-effect.test.ts test/unit/domain/relay/opencode-runtime-ingress-projection.test.ts test/unit/relay/opencode-runtime-ingress-integration.test.ts test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts`
- [ ] `pnpm vitest run test/unit/persistence/event-store.test.ts test/unit/persistence/projection-runner*.test.ts`
- [ ] `pnpm vitest run test/unit/pipeline/event-translation-snapshots.test.ts`
- [ ] `pnpm vitest run test/unit/frontend/history-to-chat-messages.test.ts test/unit/frontend/ws-reconnect-stream.test.ts`
- [ ] `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts`
- [ ] `pnpm check`
- [ ] `git diff --check`

## Risk

- [ ] High risk: provider ingestion can produce subtly different domain events. Prove parity from the same Claude/OpenCode fixture corpus before adapter cutover.
- [ ] High risk: raw payloads may contain secrets/huge blobs. Decide trace policy first; prefer redacted/bounded diagnostics, never authoritative raw DB rows.
- [ ] High risk: relay parity hides subtle UI regressions. Snapshot old and new relay messages from the same fixture corpus.
- [ ] Tradeoff: ingestion mapper first is slower than direct provider-to-store wiring, but keeps projectors and replay on stable domain semantics.
- [ ] Tradeoff: not storing `ProviderRuntimeEvent` as truth loses raw-provider replay as a primary recovery mechanism. Use explicit non-authoritative trace artifacts if diagnostics need it.

## Edge Cases

- [ ] Mixed old provider-derived domain events and new ingestion-derived domain events in one session.
- [ ] Unknown provider driver string.
- [ ] Missing `turnId` on session/thread events.
- [ ] Provider event with item id but no message id.
- [ ] Partial assistant output followed by decode failure.
- [ ] Permission/question opened then provider stream aborts.
- [ ] Duplicate or replayed deltas.
- [ ] Tool completes without prior `item.started`.
- [ ] Reasoning delta before reasoning item start.
- [ ] Provider refs collide across providers.
- [ ] Frontend receives terminal `done` after error/interruption.

## Unresolved Questions

- [ ] Does diagnostics persist full `raw.payload`? Recommended: no until redaction/size policy exists; use bounded/redacted trace artifact for raw.
- [ ] Do we rename `CanonicalEvent` types/files or keep current durable names? Recommended: keep names for this plan; rename domain events in one focused cleanup after ingestion is stable.
- [ ] Does `ProviderRuntimeEvent.createdAt` become number or ISO string in domain events? Recommended: keep current DB `created_at` number; convert at ingestion boundary if needed.
- [ ] Should `providerInstanceId` be required before Phase 5? Recommended: no; require only if routing ambiguity is proven.
- [ ] Should relay messages come directly from runtime events or projections? Recommended: projections/read models/domain events, except live streaming needs a parity-tested fast path.

## Concrete Steps

1. Run prereq tests.
2. Update docs/ADR to state `ProviderRuntimeEvent` is ingress, not durable truth.
3. Add scenario-first parity tests for Claude and OpenCode.
4. Add import/static guard tests for provider/runtime, storage, projectors, and relay ownership.
5. Add `ProviderRuntimeEvent -> domain event(s)` ingestion mapper with explicit provider refs/raw policy.
6. Add `ProviderRuntimeIngestion` Effect service with scoped workers and a drain hook for tests.
7. Switch adapters to emit `ProviderRuntimeEvent` into ingestion; provider runtime code stops constructing durable domain events.
8. Keep `EventStore` and projectors domain-event-only; add metadata fields only if parity tests require provider refs.
9. Move relay/frontend mapping off provider-owned direct translation and onto projections/read models/domain events.
10. Run guardrails and verification commands; inspect failures directly.
