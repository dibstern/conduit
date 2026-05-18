# Full ProviderRuntimeEvent Adoption Plan

**Date:** 2026-05-18
**Status:** Ready after provider-boundary schemas and `ProviderRuntimeEvent` contracts are green

## Goal

- [ ] Make `ProviderRuntimeEvent` the provider-generated durable event vocabulary for new provider events.
- [ ] Stop new provider/relay runtime paths from emitting `CanonicalEvent` directly.
- [ ] Keep `CanonicalEvent` only as legacy compatibility/upcaster until deleted or explicitly reclassified.
- [ ] Sequence: adapter parity -> compatibility translator -> projector migrations -> relay/frontend cleanup -> provider-instance identity only if tests prove need.

## Agent Rules

- [ ] First look for issues with this plan. If code disagrees, stop.
- [ ] If instructions unclear, ask before editing.
- [ ] If reality differs from the plan, stop, explain expected vs found, and ask.
- [ ] Current `CONTEXT.md` says `ProviderRuntimeEvent` is not stored. This plan intentionally changes that for new provider events. Before code, update docs/ADR or ask.
- [ ] Use TDD. Add scenario-first tests for risky behavior before implementation.

## t3code Patterns To Use

- [ ] Keep runtime contracts schema-first and provider-neutral.
- [ ] Preserve provider refs under `providerRefs`; do not copy native ids into ad hoc payload fields.
- [ ] Use explicit `raw.source` labels aligned with local trace artifacts.
- [ ] Put ingestion/translation in its own service/module, like t3code `ProviderRuntimeIngestion`, not inside adapters/projectors.
- [ ] Add a drain hook for ingestion tests; do not use sleeps.
- [ ] Use bounded TTL caches only for ephemeral correlation state, like t3code's turn/message buffers.
- [ ] Use strict lifecycle guard tests for impossible provider event orderings; make any relaxed mode explicit.
- [ ] Derive internal command/event ids from provider runtime event ids where ingestion creates follow-up work.

## Code Patterns

- [ ] Effect services use `Context.Tag` plus `Layer.effect`/`Layer.scoped`; no `Effect.Service`.
- [ ] Long-running ingestion workers use `Effect.forkScoped`; no `forkDaemon`.
- [ ] Use `Deferred`/drainable worker hooks for tests; no real-time sleeps.
- [ ] Export module-scope decoders from contract/translator modules; do not rebuild decoders on hot paths.
- [ ] Translators are pure or return `Effect`; no injected `runEffect`, `Runtime.runPromise`, or app-internal Promise bridges.
- [ ] Use `Data.TaggedError` for expected failures and `Effect.catchTag` for expected recovery.
- [ ] Keep raw payload persistence behind a named redaction/size policy. No silent `JSON.stringify(raw)` in append paths.
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
- [ ] No broad provider-instance identity migration unless Phase 5 gate fails.
- [ ] No schema generation.
- [ ] No frontend redesign.
- [ ] No paid/live provider E2E requirement.

## Files

- [ ] Create: `src/lib/provider/provider-runtime-event-sink.ts`
- [ ] Create: `src/lib/provider/provider-runtime-event-to-canonical.ts`
- [ ] Create: `src/lib/persistence/provider-runtime-event-store.ts` or rename current event store deliberately.
- [ ] Create: `test/unit/provider/provider-runtime-event-parity.test.ts`
- [ ] Create: `test/unit/persistence/provider-runtime-event-store.test.ts`
- [ ] Modify: `src/lib/provider/types.ts`
- [ ] Modify: `src/lib/provider/relay-event-sink.ts`
- [ ] Modify: `src/lib/provider/claude/*translator*`, `src/lib/provider/claude/*runtime*`
- [ ] Modify: `src/lib/persistence/canonical-event-translator.ts`
- [ ] Modify: `src/lib/persistence/events.ts`
- [ ] Modify: `src/lib/persistence/event-store.ts`
- [ ] Modify: `src/lib/persistence/projection-runner.ts`
- [ ] Modify: `src/lib/persistence/projectors/*`
- [ ] Modify: `src/lib/persistence/read-query-service.ts`, session history adapters if projections change.
- [ ] Modify: `src/lib/shared-types.ts`, `src/lib/frontend/*`, only if relay message shape changes.
- [ ] Modify docs: `CONTEXT.md` and ADR if `ProviderRuntimeEvent` becomes stored.

## Phases

- [ ] Phase 0, spike: prove storage/upcaster design with old+new fixtures. No broad integration.
- [ ] Phase 1, adapter parity: Claude/OpenCode produce `ProviderRuntimeEvent` fixtures matching old behavior through translator.
- [ ] Phase 2, compatibility translator: `ProviderRuntimeEvent -> CanonicalEvent` feeds old store/projectors/relay. Runtime behavior unchanged.
- [ ] Phase 3, projector migration: store/project `ProviderRuntimeEvent` directly for new events; historical canonical events upcast on read/replay.
- [ ] Phase 4, relay/frontend cleanup: relay messages derive from projected runtime events/read models; delete old canonical relay translator.
- [ ] Phase 5, provider-instance identity gate: add instance-id routing only if tests prove `provider` string is ambiguous.

## Scenario-First Acceptance Tests

- [ ] Given a Claude assistant stream with text, reasoning, tool start/running/completion, permission, question, and final result, when emitted as `ProviderRuntimeEvent`, then persisted history, projected rows, and relay messages match the current canonical path.
- [ ] Given OpenCode SSE `message.created`, part deltas, tool part updates, permission, question, status, and session title update, when emitted as `ProviderRuntimeEvent`, then projected state and relay snapshots match current behavior.
- [ ] Given old `CanonicalEvent` rows and new `ProviderRuntimeEvent` rows in one SQLite DB, when recovery runs, then both replay and project exactly once.
- [ ] Given duplicate or replayed `content.delta` / reasoning deltas, when recovery runs, then message text is not doubled.
- [ ] Given tool completion arrives without prior item start, when projected, then either compatibility start is synthesized or event is rejected per explicit test.
- [ ] Given partial assistant output then provider decode failure, when appending/projecting, then partial output remains readable and the terminal error/done behavior matches current UI expectations.
- [ ] Given raw provider payload exceeds the selected size/redaction policy, when append runs, then DB does not store unbounded/secret raw content.
- [ ] Given an unknown runtime event type, when append/decode runs, then it fails closed unless an explicit ignore fixture names the reason.

## Acceptance Criteria Matrix

| Criterion | Proof | Expected Assertion |
|---|---|---|
| Runtime providers no longer emit `CanonicalEvent` directly. | Static guard plus provider parity tests. | Provider/relay runtime code has no active `canonicalEvent(` construction; Claude/OpenCode fixtures enter as `ProviderRuntimeEvent`. |
| Compatibility translator preserves old behavior before projector migration. | `provider-runtime-event-parity.test.ts`. | For each Claude/OpenCode fixture, `ProviderRuntimeEvent -> CanonicalEvent` equals the old canonical event sequence. |
| New durable append path accepts only decoded `ProviderRuntimeEvent`. | `provider-runtime-event-store.test.ts`. | Unknown event type or malformed envelope is rejected before SQLite append. |
| Historical canonical rows remain readable. | Mixed old/new SQLite recovery test. | Old rows upcast/replay; projected sessions/messages/turns match pre-migration expectations. |
| Projectors consume runtime semantics, not SDK shapes. | Projector unit tests and import guard. | Projectors do not import Claude/OpenCode SDK types or provider implementation modules. |
| Replay is idempotent for streaming deltas. | Recovery test with overlapping sequence window. | Text/thinking content after replay equals single application, not doubled. |
| Relay/browser behavior remains stable. | Pipeline relay snapshot tests from same fixture corpus. | Existing `RelayMessage` sequence for text, thinking, tools, result, error, permission/question is unchanged or explicitly reclassified. |
| Raw payload persistence is bounded. | Raw policy unit test. | Oversized/secret-looking raw payload is rejected, redacted, or trace-only per Phase 0 decision. |
| Provider refs are first-class. | Translator tests. | Native Claude/OpenCode session/item/request ids land in `providerRefs`, not payload-specific fields. |
| Previous contract-only guard is deliberately replaced. | Contracts boundary test update. | Test explains `ProviderRuntimeEvent` is now imported by ingestion/storage by design. |

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] `EventSink.push(event: CanonicalEvent)` in provider interface. Prove with grep or a static test.
- [ ] Providers constructing canonical events. Prove with grep over `src/lib/provider src/lib/relay`.
- [ ] OpenCode runtime path depends on `CanonicalEventTranslator`. Prove with grep; only legacy compatibility/upcaster allowed.
- [ ] Claude runtime path emits `CanonicalEvent`. Prove with grep over `src/lib/provider/claude`.
- [ ] Relay sink translates canonical events. Prove `translateCanonicalEvent` has no active relay hit.
- [ ] Projectors keyed only by `CANONICAL_EVENT_TYPES`. Prove projectors/projection runner use runtime-event coverage or explicit legacy upcaster.
- [ ] `tool.input_updated` actively emitted. Prove no active provider/relay emitter remains.
- [ ] `ProviderRuntimeEvent` still contract-only. Prove old guard is removed/reclassified with a named test.
- [ ] `startDaemonProcess` imported by CLI. Prove no production hit.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition. Prove runtime boundary guard passes.

## Verification Commands

- [ ] `pnpm vitest run test/unit/contracts/providers`
- [ ] `pnpm vitest run test/unit/provider/provider-runtime-event-parity.test.ts`
- [ ] `pnpm vitest run test/unit/persistence/provider-runtime-event-store.test.ts`
- [ ] `pnpm vitest run test/unit/pipeline/event-translation-snapshots.test.ts`
- [ ] `pnpm vitest run test/unit/frontend/history-to-chat-messages.test.ts test/unit/frontend/ws-reconnect-stream.test.ts`
- [ ] `pnpm vitest run test/unit/effect/runtime-boundary-grep.test.ts`
- [ ] `pnpm check`
- [ ] `git diff --check`

## Risk

- [ ] High risk: storage/projector migration can corrupt history. Spike with in-memory SQLite and old+new mixed rows before touching runtime.
- [ ] High risk: raw payloads may contain secrets/huge blobs. Decide DB-vs-trace policy first; prefer redacted DB, full local trace only if already approved.
- [ ] High risk: relay parity hides subtle UI regressions. Snapshot old and new relay messages from the same fixture corpus.
- [ ] Tradeoff: compatibility translator first is slower but keeps reviewable behavior parity. Direct projector rewrite is too risky.
- [ ] Tradeoff: storing `ProviderRuntimeEvent` directly simplifies future work but requires docs/ADR boundary update.

## Edge Cases

- [ ] Mixed old/new events in one session.
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

- [ ] Does DB persist full `raw.payload`? Recommended: no until redaction/size policy exists; use trace artifact for full raw.
- [ ] Do we rename `CanonicalEvent` types/files or keep legacy names until final cleanup? Recommended: keep until projector migration complete, then rename in one focused cleanup.
- [ ] Does `ProviderRuntimeEvent.createdAt` become number or ISO string in DB? Recommended: keep current DB `created_at` number, schema accepts ISO at boundary only.
- [ ] Should `providerInstanceId` be required before Phase 5? Recommended: no; require only if routing ambiguity is proven.
- [ ] Should relay messages come directly from runtime events or projections? Recommended: projections/read models, except live streaming needs a parity-tested fast path.

## Concrete Steps

1. Run prereq tests.
2. Spike mixed old/new storage and raw policy; update docs/ADR or ask.
3. Add scenario-first parity tests for Claude and OpenCode.
4. Add `ProviderRuntimeEvent -> CanonicalEvent` compatibility translator.
5. Switch adapters to emit `ProviderRuntimeEvent` behind compatibility translator.
6. Add stored `ProviderRuntimeEvent` path and historical upcaster tests.
7. Migrate projectors one family at a time: session, turn, message, approvals, provider, activity.
8. Move relay/frontend mapping off canonical translator.
9. Run guardrails and verification commands; inspect failures directly.
