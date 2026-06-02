# ProviderRuntimeEvent Contracts-Only Plan

**Date:** 2026-05-18
**Status:** Ready after provider-boundary runtime schemas are green

## Goal

- [ ] Add `ProviderRuntimeEvent` as an implementation-free contract between decoded provider SDK envelopes and stored `CanonicalEvent`.
- [ ] Contracts-only PR: schemas, types, tests, docs. No storage, relay, handler, frontend, or provider behavior change.
- [ ] Give Claude runtime refactor a target event vocabulary before moving Claude internals.

## Agent Rules

- [ ] First look for problems with this plan. If the codebase disagrees, stop.
- [ ] If instructions are unclear, ask questions before editing.
- [ ] If reality differs from the plan, stop, explain expected vs found, and ask.
- [ ] Keep `src/lib/contracts/*` implementation-free. No Layers, provider classes, persistence, relay, frontend, or handlers imports.

## Prereqs

- [ ] `src/lib/contracts/providers/claude-agent-sdk.ts` exists and Claude contract tests pass.
- [ ] `src/lib/contracts/providers/opencode-sdk.ts` exists and OpenCode contract tests pass.
- [ ] `pnpm vitest run test/unit/contracts/providers` passes before this PR starts.
- [ ] If any prereq fails or files are missing, stop and rebase/apply the earlier schema work first.

## Contract Shape

- [ ] Create `src/lib/contracts/providers/provider-runtime-event.ts`.
- [ ] Export schemas/types: `ProviderRuntimeEventSchema`, `ProviderRuntimeEvent`, `ProviderRuntimeEventTypeSchema`, `ProviderRuntimeRawSourceSchema`, `ProviderRuntimeProviderRefsSchema`.
- [ ] Base envelope fields: `eventId`, `type`, `providerId`, `sessionId`, optional `turnId`, `providerRefs`, `rawSource`, `createdAt`, `data`, optional `metadata`.
- [ ] `providerRefs` supports optional `providerSessionId`, `providerMessageId`, `providerTurnId`, `providerToolUseId`, `providerRequestId`, `providerTaskId`, `parentProviderTaskId`.
- [ ] `rawSource` is metadata only: `kind`, optional `providerMessageType`, `providerMessageSubtype`, `sdkVariant`, `streamEventType`, `endpoint`, `sourceSchema`.
- [ ] Do not add `raw`, `rawPayload`, `sdkPayload`, or a whole-provider-message field to `rawSource`.
- [ ] Initial `type` vocabulary mirrors current canonical event names: `message.created`, `text.delta`, `thinking.start`, `thinking.delta`, `thinking.end`, `tool.started`, `tool.running`, `tool.completed`, `turn.completed`, `turn.error`, `turn.interrupted`, `session.created`, `session.renamed`, `session.status`, `session.provider_changed`, `permission.asked`, `permission.resolved`, `question.asked`, `question.resolved`.
- [ ] Include `tool.input_updated` only as explicit historical compatibility, with a test explaining that new provider runtimes should not emit it.
- [ ] Provider-owned payload fields stay opaque with `Schema.Unknown` where Conduit does not read internals.

## Implementation Patterns

- [ ] Keep this pure contract code: `effect/Schema`, exported types, constants, and narrow helpers only.
- [ ] Do not add `Context.Tag`, `Layer`, `Effect` services, provider adapters, persistence helpers, relay helpers, or frontend helpers.
- [ ] Use `Schema.Struct`, `Schema.Union`, `Schema.Literal`, `Schema.Record`, `Schema.Unknown`, and exported decode helpers if needed.
- [ ] Do not import `CanonicalEvent`, `ProviderInstance`, `RelayMessage`, provider implementation types, or persistence implementation types.
- [ ] If canonical type coverage is needed, import only pure constants/types from `src/lib/persistence/events.ts`; if that creates implementation coupling, stop and ask.
- [ ] Use `@effect/vitest` only if the test runs Effect programs. Use plain Vitest for pure schema decode tests.
- [ ] Test opaque payload survival by deep equality after decode, not by string matching.
- [ ] Test negative cases with `Schema.decodeUnknownEither(...)` and assert `Either.isLeft(...)`; do not snapshot full parse errors.
- [ ] Keep raw-source metadata shallow and explicit. Never add catch-all spreading from provider SDK messages into `rawSource`.
- [ ] Do not add generated schemas or schema generation plumbing in this PR.

## Files

- [ ] Create: `src/lib/contracts/providers/provider-runtime-event.ts`
- [ ] Create: `test/unit/contracts/providers/provider-runtime-event.test.ts`
- [ ] Modify if needed: `test/unit/contracts/contracts-boundary.test.ts`
- [ ] Modify if needed: `CONTEXT.md`
- [ ] Do not modify: `src/lib/persistence/*`, `src/lib/relay/*`, `src/lib/handlers/*`, `src/lib/frontend/*`, `src/lib/provider/*`

## Phases

- [ ] Phase 0, contract spike: map current `CanonicalEventType` names to the runtime-event vocabulary. If a provider-runtime event needs a new type name, stop and ask.
- [ ] Phase 1, TDD: add failing contract tests before implementation.
- [ ] Phase 2, schema implementation: add the schema union and exported inferred types.
- [ ] Phase 3, guardrails: prove no behavior imports or runtime code changed.

## Acceptance Criteria

Regular validation is not acceptance. Every criterion below needs a named proof with exact assertions.

| Criterion | Proof | Expected Assertion |
|---|---|---|
| `ProviderRuntimeEvent` is contract-only, not behavior. | Static guard in `provider-runtime-event.test.ts` or `contracts-boundary.test.ts`. | `ProviderRuntimeEvent` has no production imports outside `src/lib/contracts/providers/provider-runtime-event.ts`; no storage/relay/handler/frontend/provider file imports it in this PR. |
| Contract module is implementation-free. | `contracts-boundary.test.ts` extended only if current guard misses the new file. | Contract imports do not point at provider implementation, domain Layers/Services, persistence implementation, relay, handlers, or frontend runtime. |
| Every runtime event has required envelope identity. | `provider-runtime-event.test.ts`: "rejects missing base envelope identity". | Decode fails when any of `eventId`, `type`, `providerId`, `sessionId`, `providerRefs`, `rawSource`, `createdAt`, or `data` is missing. |
| Runtime event vocabulary is complete for current canonical bridge vocabulary. | `provider-runtime-event.test.ts`: "covers every canonical event type or explicit reclassification". | `CANONICAL_EVENT_TYPES` minus `ProviderRuntimeEventTypeSchema` is empty, except documented reclassifications in the test fixture. |
| Unknown event names fail closed. | `provider-runtime-event.test.ts`: "rejects unknown runtime event type". | Decode fails for `type: "made.up"`. |
| `tool.input_updated` is historical compatibility only. | `provider-runtime-event.test.ts`: "marks tool.input_updated as historical compatibility". | The schema accepts it only because canonical history contains it; the test asserts new runtimes should not emit it. |
| Raw-source metadata cannot become a raw SDK payload tunnel. | `provider-runtime-event.test.ts`: "rejects raw payload fields in rawSource". | Decode fails for `rawSource.raw`, `rawSource.rawPayload`, `rawSource.sdkPayload`, `rawSource.providerPayload`. |
| Claude provider refs are representable without provider payload. | `provider-runtime-event.test.ts`: "decodes Claude refs". | Valid event carries `providerSessionId`, `providerMessageId`, `providerToolUseId`, `providerTaskId`; no raw SDK message required. |
| OpenCode provider refs are representable without provider payload. | `provider-runtime-event.test.ts`: "decodes OpenCode refs". | Valid event carries `providerSessionId`, `providerMessageId`, `providerRequestId`; no raw SSE/REST body required. |
| Provider-owned payloads survive unchanged. | `provider-runtime-event.test.ts`: "preserves opaque provider-owned payloads". | Nested tool input/result/question JSON after decode equals the original object. |

## Scenario Acceptance Tests

- [ ] Given a Claude `tool.started` runtime event with nested tool input, when decoded through `ProviderRuntimeEventSchema`, then envelope fields are validated and the nested provider-owned input is byte-for-byte structurally equal after decode.
- [ ] Given an OpenCode permission runtime event with provider refs, when decoded, then Conduit can identify session/provider/request ids without reading provider-owned payload internals.
- [ ] Given a runtime event with a whole SDK message hidden under `rawSource`, when decoded, then it fails closed.
- [ ] Given a new `CanonicalEventType` is added later, when contract tests run, then the coverage test fails until the type is added or explicitly reclassified.
- [ ] Given a behavior module imports `ProviderRuntimeEvent`, when static guards run in this PR, then the guard fails because this PR is contract-only.

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] `ProviderRuntimeEvent` imported by behavior code. Prove: `rg -n "ProviderRuntimeEvent" src/lib | rg -v "src/lib/contracts/providers/provider-runtime-event.ts"` returns no output.
- [ ] Runtime import inside contracts. Prove: `pnpm vitest run test/unit/contracts/contracts-boundary.test.ts` passes.
- [ ] Storage/relay/frontend/handler behavior changed. Prove: `git diff --name-only` has no files under those directories.
- [ ] Raw provider payload stored in `rawSource`. Prove: contract test rejects `raw`, `rawPayload`, `sdkPayload`, and `providerPayload` fields.
- [ ] Missing current canonical event coverage. Prove: test compares current `CANONICAL_EVENT_TYPES` to runtime-event types and fails on drift.
- [ ] `tool.input_updated` treated as active new vocabulary. Prove: test labels it historical compatibility only.

## Verification Commands

These commands run the acceptance proofs. They are not acceptance criteria.

- [ ] `pnpm vitest run test/unit/contracts/providers/provider-runtime-event.test.ts`
- [ ] `pnpm vitest run test/unit/contracts/contracts-boundary.test.ts`
- [ ] `pnpm vitest run test/unit/schema/canonical-events.test.ts`
- [ ] `pnpm check`
- [ ] `git diff --check`
- [ ] `git diff --name-only` shows only planned contract, test, and docs files.

## Risk

- [ ] Risk: this can become a duplicate event-store contract. Keep it pre-storage, contract-only, and unused by runtime code in this PR.
- [ ] Risk: raw-source metadata may tempt later code to persist whole SDK messages. Reject raw payload fields now.
- [ ] Tradeoff: mirror canonical event names now for low migration cost; introduce new provider-runtime names only after a concrete translator test proves the old vocabulary is insufficient.

## Out Of Scope

- [ ] No event-store schema changes.
- [ ] No relay/browser message changes.
- [ ] No Claude runtime refactor.
- [ ] No OpenCode translator refactor.
- [ ] No provider event persistence.
- [ ] No generated schemas.

## Unresolved Questions

- [ ] Should `providerId` be a literal union or string? Recommended: string schema, tests cover `claude` and `opencode`, avoid importing persistence types into contracts.
- [ ] Should `rawSource` ever include redacted payload excerpts? Recommended: no for this PR.
- [ ] Should runtime events include new names like `content.started` instead of canonical names? Recommended: no until a failing Claude runtime test proves need.
- [ ] How should subagent child sessions be represented? Recommended: `providerRefs.providerTaskId`, `parentProviderTaskId`, plus normal `sessionId`.
- [ ] What if an SDK event has no turn id? Recommended: optional `turnId`; test session/status events without it.
- [ ] What if provider decode fails before event type is known? Recommended: future runtime maps to `turn.error` with `rawSource.kind = "decode_failure"` if needed; not implemented here.

## Concrete Steps

1. Run prereq contract tests.
2. Add failing `provider-runtime-event.test.ts`.
3. Add `provider-runtime-event.ts` schemas/types.
4. Update contract boundary test only if needed.
5. Run verification commands and inspect acceptance proof failures directly.
6. Commit only contract, test, and docs files.
