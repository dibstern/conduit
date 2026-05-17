# Provider Runtime Event Contracts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the contracts-only t3code-style `ProviderRuntimeEvent` schema layer: normalized provider-runtime event vocabulary, raw-source metadata, provider-native refs, opaque raw payloads, module-scope decoders, and focused tests.

**Architecture:** This PR introduces a pure contracts module under `src/lib/contracts/providers/` and proves the event vocabulary with unit tests only. Provider adapters, event storage, projectors, relay messages, frontend stores, and provider behavior keep using the existing `CanonicalEvent` / `RelayMessage` paths until later migration PRs add translators and parity tests.

**Tech Stack:** TypeScript, Effect `Schema`, Vitest, `pnpm check`

---

## Goal

Create the first `ProviderRuntimeEvent` contract slice after `docs/plans/2026-05-17-provider-contract-runtime-schemas.md` lands.

This slice gives Conduit a typed provider-runtime vocabulary without changing runtime behavior. It should define the event envelope, raw-source labels, provider refs, first normalized event families, and import-purity rules needed by later adapter and projector migrations.

The target new files are:

- `src/lib/contracts/providers/provider-runtime-event.ts`
- `test/unit/contracts/providers/provider-runtime-event.test.ts`

Implementation boundary: this plan is contract-only. If implementation touches adapters, event-store schemas, projectors, relay delivery, frontend stores, daemon runtime code, or provider routing, stop and split that behavior into a follow-up PR.

## Motivation

The provider contract runtime-schema plan decodes native Claude/OpenCode Provider Envelopes at the Provider Runtime Seam and fails closed. That protects Conduit from malformed provider input, but it does not yet give Conduit a stable provider-neutral runtime event vocabulary.

t3code's broader model is better because native SDK events are translated into a canonical provider-runtime vocabulary before persistence, browser delivery, or projector concerns. Each event carries:

- a normalized runtime event type, such as `content.delta` or `request.opened`
- compact raw-source metadata, such as `claude.sdk.message` or `opencode.sdk.event`
- provider-native refs, such as provider turn/item/request ids
- opaque raw payloads for diagnostics and replay without deep provider-payload modeling

That model gives Conduit stable runtime events, better testability, provider-neutral replay, bounded diagnostics, and a migration path for projectors and relay delivery.

## Current Shape

Read these files before implementation:

- `docs/agent-guide/architecture.md`
- `docs/agent-guide/testing.md`
- `docs/plans/2026-05-17-provider-contract-runtime-schemas.md`
- `docs/plans/2026-05-17-provider-contract-runtime-schemas.md`, section `Post-Slice Follow-Up: t3code-Style ProviderRuntimeEvent Model`
- `src/lib/persistence/events.ts`
- `src/lib/provider/types.ts`
- `src/lib/provider/event-sink.ts`
- `src/lib/provider/relay-event-sink.ts`
- `src/lib/persistence/canonical-event-translator.ts`
- `src/lib/contracts/providers/claude-agent-sdk.ts`
- `src/lib/contracts/providers/opencode-sdk.ts`

The current runtime path is:

- provider instances emit `CanonicalEvent` through `EventSink.push(event)`
- `src/lib/persistence/events.ts` owns the current durable event union
- projectors consume canonical event names like `message.created`, `text.delta`, `tool.started`, `permission.asked`, and `question.asked`
- `relay-event-sink.ts` translates canonical events to existing browser `RelayMessage` shapes
- provider identity is still mostly a `provider` / `providerId` string, not a driver-kind vs instance-id split

The provider-contract runtime-schema slice already adds provider SDK contract modules under `src/lib/contracts/providers/`. This PR should follow that layer boundary: contracts only, implementation-free, no adapter state, no event store imports, no relay imports, and no SDK clients.

## t3code Lessons

Inspecting `~/src/personal/conduit-competitors/t3code/packages/contracts/src/providerRuntime.ts` and `providerInstance.ts` is useful, but do not copy code verbatim.

Bring over these design lessons:

- contract modules are schema-only and export module-scope decoders
- raw native data is preserved under a bounded `raw` envelope, not spread through normalized payloads
- raw-source labels identify the native source and method/message type without dumping provider payloads
- provider-native ids belong in a dedicated `providerRefs` object
- provider driver kind and provider instance id are distinct concepts, even if Conduit initially backfills both from existing provider strings
- event families are provider-neutral and describe runtime semantics, not Claude/OpenCode implementation details

Do not bring over every event type in one oversized schema. Start with the event families Conduit already needs for parity with the current canonical events, plus a small diagnostics family.

## Target Architecture

Add `src/lib/contracts/providers/provider-runtime-event.ts`.

The module should export schemas and types for:

- `ProviderRuntimeEventId`
- `ProviderRuntimeThreadId`
- `ProviderRuntimeTurnId`
- `ProviderRuntimeItemId`
- `ProviderRuntimeRequestId`
- `ProviderRuntimeProviderId`
- `ProviderRuntimeProviderInstanceId`
- `ProviderRuntimeRawSource`
- `ProviderRuntimeRaw`
- `ProviderRuntimeProviderRefs`
- `ProviderRuntimeEventBase`
- first `ProviderRuntimeEvent` union
- `decodeProviderRuntimeEvent`
- `decodeProviderRuntimeEvents`, if useful for tests and later fixture parity
- `isProviderRuntimeEvent`, if consistent with nearby provider-contract modules

Use Effect Schema, with compiled decoders hoisted at module scope. Adapter hot paths in later PRs should call exported decoder functions instead of constructing `Schema.decodeUnknown...` repeatedly.

### Event Base Concepts

`ProviderRuntimeEventBase` should include:

- `eventId`
- `provider`
- optional `providerInstanceId`
- `threadId`
- `createdAt`
- optional `turnId`
- optional `itemId`
- optional `requestId`
- optional `providerRefs`
- optional `raw`

Use constrained non-empty strings for ids. A branded-id helper is acceptable if it stays local to the contract module and avoids a broad shared validation framework. Keep the schema permissive enough for imported historical data and external provider ids, but reject empty or whitespace-only ids.

Recommended initial provider constraints:

- `provider`: non-empty provider driver/runtime label; keep it open, not a closed `opencode | claude` union
- `providerInstanceId`: optional non-empty routing key; future work will formalize this separately

Do not introduce a new persisted provider-instance model in this PR.

### Raw Source Labels

Define a closed initial `ProviderRuntimeRawSource` literal union:

- `claude.sdk.message`
- `claude.sdk.result`
- `claude.sdk.permission`
- `opencode.sdk.event`
- `opencode.sdk.response`
- `opencode.gap.response`
- `conduit.provider.request`
- `conduit.provider.translator`
- `conduit.provider.runtime`

This list must stay aligned with `docs/plans/2026-05-17-local-trace-artifact.md`. Trace records and runtime events should use the same source labels so failures can be correlated without translation tables.

`ProviderRuntimeRaw` should be:

```ts
{
	source: ProviderRuntimeRawSource;
	method?: string;
	messageType?: string;
	payload: unknown;
}
```

Keep `payload` as `Schema.Unknown`. Tests must prove arbitrary nested provider payloads survive decoding.

### Provider Refs

Define `ProviderRuntimeProviderRefs` as:

```ts
{
	providerTurnId?: string;
	providerItemId?: string;
	providerRequestId?: string;
	providerSessionId?: string;
}
```

Use this for native Claude/OpenCode ids. Do not smuggle native ids into ad hoc payload fields unless the id is also part of the normalized runtime payload semantics.

### First Event Families

The first union should cover the event families needed to express current Conduit canonical behavior without changing current behavior:

- `session.started`
- `session.state.changed`
- `session.metadata.updated`
- `thread.started`
- `thread.state.changed`
- `turn.started`
- `turn.completed`
- `turn.aborted`
- `item.started`
- `item.updated`
- `item.completed`
- `content.delta`
- `request.opened`
- `request.resolved`
- `user-input.requested`
- `user-input.resolved`
- `runtime.warning`
- `runtime.error`

Recommended state/value unions:

- session state: `starting`, `ready`, `running`, `waiting`, `stopped`, `error`
- thread state: `active`, `idle`, `archived`, `closed`, `compacted`, `error`
- turn terminal state: `completed`, `failed`, `interrupted`, `cancelled`
- item type: `user_message`, `assistant_message`, `reasoning`, `tool_call`, `permission_request`, `question_request`, `error`, `unknown`
- item status: `inProgress`, `completed`, `failed`, `declined`
- content stream kind: `assistant_text`, `reasoning_text`, `tool_output`, `command_output`, `unknown`
- request type: `tool_permission`, `file_permission`, `command_permission`, `provider_permission`, `unknown`
- runtime issue class: `provider`, `transport`, `permission`, `validation`, `unknown`

Use payload schemas that are useful but not over-modeled. Examples:

- `content.delta`: `{ streamKind, text }`
- `turn.completed`: `{ state, durationMs?, cost?, tokens? }`
- `request.opened`: `{ requestType, title?, description?, toolName?, input?: unknown }`
- `user-input.requested`: `{ questions: Array<{ id?, header?, question, options?, multiSelect? }> }`
- `runtime.error`: `{ errorClass, message, code?, retryable? }`

Provider-owned blobs in request input, tool results, raw SDK messages, and structured output remain `unknown`.

### Drift And Compatibility Expectations

This contracts-only PR should not claim all future runtime events are modeled. It should make compatibility explicit:

- the union is versioned by export name and tests, not by a new database schema field
- new event families can be added without changing storage in this PR
- unknown provider drivers should still parse if their string id is well-formed and non-empty
- unknown runtime event types should fail decode, so later translators do not silently accept unsupported event semantics
- `raw.payload` accepts unknown data to preserve native diagnostics across provider SDK drift
- current `CanonicalEvent` names remain the active runtime/storage contract until translator follow-ups land

### Import Purity Guard

The contract module may import:

- `effect/Schema` or `effect`
- TypeScript types from local pure contract helpers if such helpers already exist

The contract module must not import:

- `src/lib/provider/*`
- `src/lib/persistence/*`
- `src/lib/relay/*`
- `src/lib/frontend/*`
- SDK clients from `@anthropic-ai/claude-agent-sdk` or `@opencode-ai/sdk`
- logger modules
- filesystem, network, SQLite, or daemon modules

Tests should include a static import-purity assertion using file text or dependency graph checks, because this file is meant to stay implementation-free.

## Non-Goals

This PR must not change:

- event-store schema
- SQLite migrations
- `CanonicalEvent` schemas in `src/lib/persistence/events.ts`
- projectors
- replay/history adapters
- relay message schemas
- WebSocket messages
- frontend stores or components
- provider adapter behavior
- Claude/OpenCode event translation
- `EventSink` method signatures
- provider instance identity/routing behavior

No storage, relay, frontend, or adapter behavior change belongs in this contracts-only PR. Those are later follow-ups.

## Implementation Tasks

### Task 1: Add Provider Runtime Event Contract Tests

**Files:**

- Create: `test/unit/contracts/providers/provider-runtime-event.test.ts`

**Step 1: Create the test file**

Create `test/unit/contracts/providers/provider-runtime-event.test.ts`.

**Step 2: Add failing base-envelope tests**

Add tests that import:

```ts
import { describe, expect, it } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
```

Cover:

- a minimal `session.started` event decodes
- open provider labels decode, for example `claude`, `opencode`, and `localFork`
- whitespace-only `eventId`, `threadId`, or `provider` rejects
- unknown event type rejects

**Step 3: Add raw-source and provider-ref tests**

Cover:

- `raw.source: "claude.sdk.message"` with `messageType: "assistant"` decodes
- `raw.source: "claude.sdk.result"` with `messageType: "result"` decodes
- `raw.source: "claude.sdk.permission"` decodes
- `raw.source: "opencode.sdk.event"` with `method: "message.part.delta"` decodes
- `raw.source: "opencode.sdk.response"` with `method: "session.create"` decodes
- `raw.source: "opencode.gap.response"` with `method: "GET /session"` decodes
- `raw.source: "conduit.provider.request"` with `method: "sendTurn"` decodes
- `raw.source: "conduit.provider.translator"` decodes
- `raw.source: "conduit.provider.runtime"` decodes
- nested `raw.payload` with arrays/objects/null survives unchanged
- `providerRefs.providerTurnId`, `providerRefs.providerItemId`, `providerRefs.providerRequestId`, and `providerRefs.providerSessionId` decode

**Step 4: Add event-family tests**

Cover representative events:

- `content.delta` with `streamKind: "assistant_text"`
- `content.delta` with `streamKind: "reasoning_text"`
- `item.started` for a tool call
- `item.completed` for a completed assistant message
- `request.opened` for a permission request with opaque `input`
- `request.resolved` for a permission decision
- `user-input.requested` with structured questions
- `user-input.resolved` with an answer map
- `turn.completed` with token/cost/duration fields
- `runtime.error` with `errorClass: "validation"`

**Step 5: Add import-purity tests**

Read `src/lib/contracts/providers/provider-runtime-event.ts` as text and assert it does not import forbidden layers:

```ts
expect(source).not.toMatch(/from ["'].*\/provider\//);
expect(source).not.toMatch(/from ["'].*\/persistence\//);
expect(source).not.toMatch(/from ["'].*\/relay\//);
expect(source).not.toMatch(/from ["'].*\/frontend\//);
expect(source).not.toMatch(/@anthropic-ai\/claude-agent-sdk|@opencode-ai\/sdk/);
expect(source).not.toMatch(/createLogger|sqlite|fetch\(|EventSink|CanonicalEvent|RelayMessage/);
```

Keep the test targeted to this new contract file. Do not add broad repo dependency tooling in this PR.

**Step 6: Run the focused test and confirm it fails**

```bash
pnpm exec vitest run test/unit/contracts/providers/provider-runtime-event.test.ts
```

Expected before implementation: fails because `provider-runtime-event.ts` does not exist.

### Task 2: Add Provider Runtime Event Contract Module

**Files:**

- Create: `src/lib/contracts/providers/provider-runtime-event.ts`

**Step 1: Add local primitive schemas**

Create local helper schemas for:

- trimmed non-empty strings
- runtime ids
- timestamps
- token usage snapshots
- opaque records only where a record shape is required

Prefer local helpers over a new shared framework. This PR should not move common schema utilities unless the repo already has a suitable pure helper.

**Step 2: Add raw-source and refs schemas**

Add:

- `ProviderRuntimeRawSourceSchema`
- `ProviderRuntimeRawSchema`
- `ProviderRuntimeProviderRefsSchema`

Export corresponding types with `Schema.Schema.Type<typeof ...>`.

**Step 3: Add base event schema**

Add `ProviderRuntimeEventBaseSchema` with the base concepts listed above.

Use `Schema.optionalWith(..., { exact: true })` only if it matches the surrounding provider-contract module style. Consistency with `claude-agent-sdk.ts` and `opencode-sdk.ts` matters more than inventing a new schema style.

**Step 4: Add payload schemas**

Add small payload schemas for each first event family.

Keep these payloads normalized and provider-neutral. Do not include Claude or OpenCode native fields except under `raw` or `providerRefs`.

**Step 5: Add discriminated event schemas**

Define one schema per event type and compose them into:

- `ProviderRuntimeEventSchema`
- exported type `ProviderRuntimeEvent`

Prefer a discriminated union style that makes invalid event types fail clearly.

**Step 6: Add module-scope decoders**

Compile decoders once at module scope:

```ts
const decodeProviderRuntimeEventSync = Schema.decodeUnknownSync(
	ProviderRuntimeEventSchema,
);

export function decodeProviderRuntimeEvent(
	value: unknown,
): ProviderRuntimeEvent {
	return decodeProviderRuntimeEventSync(value);
}
```

If the existing provider contract modules use Effect-returning or Either-returning decoders, follow that local pattern instead. The key requirement is that decoder construction happens at module scope, not inside adapter hot paths.

**Step 7: Run the focused test**

```bash
pnpm exec vitest run test/unit/contracts/providers/provider-runtime-event.test.ts
```

Expected: all tests pass.

### Task 3: Add Drift And Compatibility Tests

**Files:**

- Modify: `test/unit/contracts/providers/provider-runtime-event.test.ts`

**Step 1: Test event type closure**

Assert that unsupported legacy/current event names fail:

- `message.created`
- `text.delta`
- `thinking.delta`
- `tool.started`
- `permission.asked`
- `question.asked`

This proves this module is not a loose alias for existing `CanonicalEvent`.

**Step 2: Test compatibility for unknown provider drivers**

Assert well-formed but unknown provider labels decode:

- `claudeAgentNext`
- `opencode_work`
- `local-provider`

Assert malformed labels reject only if the chosen slug schema is intentionally constrained. At minimum, empty and whitespace-only labels must reject.

**Step 3: Test raw payload opacity**

Add a payload with provider-owned fields that the runtime schema should not inspect:

```ts
payload: {
	message: { content: [{ type: "tool_use", input: { deeply: ["nested"] } }] },
	providerAddedField: { any: ["shape"] },
}
```

Expected: decode succeeds and `raw.payload` remains present.

**Step 4: Keep canonical mapping notes useful without fake tests**

Add a nearby comment/table in the test file that documents first expected mappings:

- `text.delta` becomes `content.delta`
- `thinking.delta` becomes `content.delta` with `streamKind: "reasoning_text"`
- `tool.started` becomes `item.started`
- `tool.completed` becomes `item.completed`
- `permission.asked` becomes `request.opened`
- `question.asked` becomes `user-input.requested`

Do not implement a translator in this PR. Do not add a test that merely asserts a local fixture table equals itself. If executable mapping coverage is needed, wait for the adapter parity or compatibility-translator PR where a real translator function exists.

**Step 5: Run focused tests again**

```bash
pnpm exec vitest run test/unit/contracts/providers/provider-runtime-event.test.ts
```

Expected: all tests pass.

### Task 4: Add Contract Export Only If Required

**Files:**

- Modify only if already present and clearly used: `src/lib/contracts/providers/index.ts`

**Step 1: Check whether a provider contracts barrel exists**

Run:

```bash
test -f src/lib/contracts/providers/index.ts && sed -n '1,160p' src/lib/contracts/providers/index.ts || true
rg -n "contracts/providers/(claude-agent-sdk|opencode-sdk)" src test
```

**Step 2: Decide whether to export from a barrel**

If there is no existing barrel, do not create one just for this PR.

If there is an existing barrel that already exports `claude-agent-sdk.ts` and `opencode-sdk.ts`, add `provider-runtime-event.ts` there.

**Step 3: Keep ownership narrow**

If adding a barrel export would touch a file outside the planned new module/test and is not required by existing patterns, skip it. Direct imports from `src/lib/contracts/providers/provider-runtime-event.ts` are acceptable in this contracts-only PR.

### Task 5: Run Static Contract Proofs

**Files:**

- No code changes expected unless a test or typecheck failure points to the two new files

**Step 1: Run the contract test**

```bash
pnpm exec vitest run test/unit/contracts/providers/provider-runtime-event.test.ts
```

Expected: pass.

**Step 2: Run typecheck**

```bash
pnpm check
```

Expected: pass.

**Step 3: Run import-purity greps**

```bash
if rg -n "from ['\\\"].*\\.\\./.*(provider|persistence|relay|frontend)|@anthropic-ai/claude-agent-sdk|@opencode-ai/sdk|createLogger|EventSink|CanonicalEvent|RelayMessage|sqlite|fetch\\(" src/lib/contracts/providers/provider-runtime-event.ts; then
  echo "provider-runtime-event.ts crossed the contracts-only boundary"
  exit 1
fi
```

Expected: no matches.

**Step 4: Run behavior-change guard greps**

```bash
git diff -- src/lib/persistence src/lib/provider src/lib/relay src/lib/frontend src/lib/contracts/ws-message-schemas.ts src/lib/types.ts
git status --short
```

Expected:

- no diff under persistence, provider adapters, relay, frontend, websocket schemas, or shared runtime types
- `git status --short` shows only:
  - `src/lib/contracts/providers/provider-runtime-event.ts`
  - `test/unit/contracts/providers/provider-runtime-event.test.ts`
  - optionally `src/lib/contracts/providers/index.ts` if an existing barrel required it
  - optionally this plan file if the implementation branch intentionally carries planning docs

## Test/Verification Plan

Default verification for this contracts-only PR:

```bash
pnpm exec vitest run test/unit/contracts/providers/provider-runtime-event.test.ts
pnpm check
```

Optional broader default repo path if the change unexpectedly touches shared contract exports:

```bash
pnpm lint
pnpm test:unit
```

Do not run E2E, daemon, visual, live OpenCode, or relay tests for this PR unless the implementation accidentally crosses into runtime behavior. If it crosses that boundary, stop and split the behavior change into a later PR instead of expanding this contracts-only PR.

## Acceptance Criteria

- `src/lib/contracts/providers/provider-runtime-event.ts` exists.
- `test/unit/contracts/providers/provider-runtime-event.test.ts` exists.
- The new contract module exports the first `ProviderRuntimeEvent` union, raw-source schema, raw envelope schema, provider refs schema, base schema, types, and module-scope decoder functions.
- `raw.payload` is opaque and accepts arbitrary nested provider-owned values.
- Raw-source labels include every literal listed under `Raw Source Labels`, including Claude SDK, OpenCode SDK/gap, and Conduit provider request/translator/runtime sources.
- Provider-native ids are represented under `providerRefs`.
- First event families cover session, thread, turn, item, content delta, permission request, user-input request, warning, and error concepts.
- Unknown runtime event types fail decode.
- Unknown but non-empty provider labels can decode, so future provider drivers do not require a contract-layer release just to preserve event envelopes.
- Import-purity tests prove the contract module does not import provider adapters, persistence, relay, frontend, SDK clients, logging, network, or database code.
- Decoder construction is hoisted to module scope.
- `pnpm exec vitest run test/unit/contracts/providers/provider-runtime-event.test.ts` passes.
- `pnpm check` passes.
- No event-store schema, projectors, relay messages, frontend stores, or provider adapter behavior changes are made.

## Acceptance Proof Matrix

| Criterion | Required proof |
|---|---|
| New contract and test files exist | `test -f src/lib/contracts/providers/provider-runtime-event.ts` and `test -f test/unit/contracts/providers/provider-runtime-event.test.ts` |
| Event union, raw schema, refs schema, base schema, types, and decoders export | focused contract test imports every intended export and `pnpm check` typechecks those imports |
| `raw.payload` is opaque | focused test decodes deeply nested provider-looking payloads and asserts they survive unchanged |
| Raw-source labels match the shared trace vocabulary | focused test covers every literal listed under `Raw Source Labels` |
| Provider-native ids live under `providerRefs` | focused test decodes provider turn/item/request/session ids and verifies normalized payloads do not require native-id side channels |
| First event families are covered | focused test has at least one representative event from each family in `First Event Families` |
| Unknown runtime event types fail | focused test rejects current canonical names such as `message.created`, `text.delta`, and `permission.asked` |
| Unknown but non-empty provider labels decode | focused test decodes future/fork provider labels such as `claudeAgentNext`, `opencode_work`, and `local-provider` |
| Import purity holds | import-purity unit test plus the `if rg ...; then exit 1; fi` grep in Task 5 |
| Decoder construction is module-scoped | focused source-text test or code review check that decoder constants are declared outside exported functions; `pnpm check` must pass |
| No runtime behavior changed | `git diff -- src/lib/persistence src/lib/provider src/lib/relay src/lib/frontend src/lib/contracts/ws-message-schemas.ts src/lib/types.ts` has no output and `git status --short` lists only the allowed contract/test/barrel files plus any intentionally carried plan doc |
| Focused verification passes | `pnpm exec vitest run test/unit/contracts/providers/provider-runtime-event.test.ts` |
| Typecheck passes | `pnpm check` |

## Risks

- **Over-modeling provider payloads:** Deeply modeling Claude/OpenCode tool input or raw messages would recreate provider drift risk. Keep raw payloads unknown.
- **Under-modeling runtime semantics:** A too-small union may be useless for follow-up translators. Include enough event families to map today's canonical events.
- **Provider identity confusion:** `provider` and `providerInstanceId` are related but not the same. This PR should allow both fields without changing routing.
- **Accidental behavior change:** Importing this module into adapters, projectors, or relay paths in the same PR turns a contracts slice into a runtime migration. Do not do that.
- **Schema strictness drift:** Closing provider labels to `claude | opencode` would make future/fork events fail unnecessarily. Keep the provider label open and validate only basic id hygiene.
- **Hot-path decoder construction:** Later adapter PRs should not compile decoders per event. Export module-scope decoder functions now.

## Rollout Order

This is priority #3 after the provider contract runtime-schema plan.

Recommended sequence:

1. Land `docs/plans/2026-05-17-provider-contract-runtime-schemas.md` implementation first, so native Provider Envelopes decode at the Provider Runtime Seam and malformed data fails closed.
2. Land this contracts-only `ProviderRuntimeEvent` PR.
3. Add adapter parity PRs for Claude and OpenCode mapping functions that produce `ProviderRuntimeEvent` alongside current `CanonicalEvent` expectations.
4. Add a compatibility translator from `ProviderRuntimeEvent` to current `CanonicalEvent` and, later, `RelayMessage`.
5. Migrate projectors one family at a time.
6. Clean up relay/frontend event-specific branches after replay/live parity proves the runtime-event-derived path matches existing behavior.
7. Formalize provider instance identity separately from driver kind when routing/storage needs it.

This contracts PR can happen before or alongside Claude runtime ownership work because it does not change execution behavior. Adapter adoption should wait until runtime-schema decoding is in place.

## Follow-Up Boundaries

Later PRs should be split as:

- **Adapter parity:** add pure Claude/OpenCode native-event-to-`ProviderRuntimeEvent` mapping functions, keep existing canonical writes, add fixture parity tests.
- **Compatibility translator:** add `ProviderRuntimeEvent -> CanonicalEvent` and `ProviderRuntimeEvent -> RelayMessage[]` translators, keep event-store schema unchanged.
- **Projector migrations:** migrate session, message, turn, approval/question, provider, and activity projectors one at a time.
- **Relay/frontend cleanup:** remove old event-specific relay and frontend branching only after replay and live-stream parity.
- **Provider instance identity:** split provider driver kind from provider instance id in routing and persistence after compatibility tests cover old sessions.

Do not combine those follow-ups into this PR. This plan's deliverable is only the contract vocabulary and tests that make those later migrations possible.
