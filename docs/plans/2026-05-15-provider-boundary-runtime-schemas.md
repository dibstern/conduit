# Provider Boundary Runtime Schemas Plan

**Date:** 2026-05-15
**Status:** Ready for implementation

## Goal

Add Effect Schema runtime checks at the provider boundaries so Conduit stops treating Claude Agent SDK and OpenCode SDK data as trusted merely because TypeScript types exist.

The target is runtime certainty for the provider envelopes Conduit reads, while keeping provider-owned dynamic payloads opaque unless Conduit actually interprets their internal fields.

## Domain Language

`CONTEXT.md` now defines the relevant terms:

- **Provider Contract:** externally documented and locally installed request, response, and event shapes exposed by a provider runtime.
- **Provider Envelope:** discriminants and fields Conduit reads to route, translate, persist, or display provider messages.
- **Provider-Owned Payload:** nested JSON owned by the provider or model/tool protocol and not interpreted by Conduit.

## Source Of Truth

Use the installed SDK type definitions as the authoritative local contract, with official docs as human-readable guides.

For Claude:

- Start from the official TypeScript Agent SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript.
- Cross-check every schema against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- The installed `SDKMessage` union currently includes more variants than the docs summary, so the `.d.ts` wins where they differ.

For OpenCode:

- Start from the installed generated types in `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`.
- The OpenCode docs state the SDK includes TypeScript definitions generated from the server OpenAPI specification: https://opencode.ai/docs/sdk/.
- Do not add schema generation in the first implementation. Hand-write schemas now; consider OpenAPI-to-Effect generation only after this boundary is working and stable.

For Effect:

- Use `effect/Schema` decode-from-unknown patterns. Effect Schema is explicitly intended for validating and decoding external data from `unknown`: https://effect.website/docs/schema/introduction/.

## Current Boundary Gaps

- `src/lib/instance/opencode-api.ts` has `OpenCodeAPI.sdk()` returning `result.data as T` after checking SDK transport/API errors.
- `src/lib/instance/opencode-api.ts` has `call<T>()` casting SDK promise types into the adapter-local `SdkResult<T>`.
- `src/lib/instance/gap-endpoints.ts` parses gap endpoint JSON as `unknown` and leaves array checks to each method.
- `src/lib/domain/provider/Services/opencode-response-schemas.ts` already contains partial Effect schemas, but they are not wired into `OpenCodeAPI.sdk()` or gap endpoints.
- `src/lib/provider/claude/types.ts` re-exports SDK types but does not provide runtime schemas.
- `src/lib/provider/claude/claude-provider-instance.ts` sends `ctx.query` messages directly to `ClaudeEventTranslator.translate()`.
- `src/lib/provider/claude/claude-event-translator.ts` switches on `message.type` and reads fields from SDK messages, so malformed envelopes can reach translation.

## Decisions

- Store pure provider boundary schemas under `src/lib/contracts/providers/`.
- Add `src/lib/contracts/providers/claude-agent-sdk.ts`.
- Add `src/lib/contracts/providers/opencode-sdk.ts`.
- Keep adapter behavior in `src/lib/provider/*` and `src/lib/instance/*`; schemas should not call provider SDKs or mutate adapter state.
- Fail closed on active provider paths. Decode failures should surface as typed provider/API failures, not unhandled crashes or partially trusted values.
- Allow existing discovery/gap paths to degrade only where the current code already has explicit fallback semantics.
- Keep provider-owned payloads opaque in PR 1 using `Schema.Unknown` or shallow records.
- Add compile-time drift checks proving schema-decoded types line up with installed SDK types.

## Strictness Boundary

Validate strictly:

- Claude `SDKMessage.type`, `subtype`, `uuid`, `session_id`, task IDs, result fields, permission denial shape, status enums, and other fields Conduit routes or translates.
- Claude outgoing `SDKUserMessage` fields that Conduit constructs.
- OpenCode `Session`, `Message`, `Part`, `Event` envelopes and fields Conduit reads.
- OpenCode request bodies that Conduit constructs before sending to the SDK or gap endpoint.

Keep opaque at first:

- Claude `message: BetaMessage`.
- Claude `event: BetaRawMessageStreamEvent`.
- Claude `tool_input`, `structured_output`, and tool result payloads.
- OpenCode tool input/output metadata.
- Arbitrary JSON-schema structured output.
- Any provider-owned blob whose internal fields Conduit does not inspect.

## Implementation Plan

### 1. Add Shared Decode Utilities Only If Needed

Prefer direct `Schema.decodeUnknown` at the boundary callsite. Add a tiny shared helper only if two or more callsites need identical parse-error formatting.

If a helper is needed, keep it implementation-free and local to `src/lib/contracts/providers/`, for example:

- `decodeProviderEnvelope(provider, label, schema, value)`
- Returns decoded data or throws/returns a typed parse failure that adapter code converts into the existing provider/API error shape.

Do not create a broad validation framework.

### 2. Add OpenCode Provider Schemas

Create `src/lib/contracts/providers/opencode-sdk.ts`.

Move or fold the useful pieces from `src/lib/domain/provider/Services/opencode-response-schemas.ts` into the new contract module. Remove the old module if no imports remain.

Initial exports:

- `OpenCodeSessionSchema`
- `OpenCodeSessionDetailSchema`, only if Conduit still consumes relay-specific runtime fields not present in SDK `Session`.
- `OpenCodeMessageSchema`
- `OpenCodeMessageWithPartsSchema`
- `OpenCodePartSchema`, strict for `id` and `type`, opaque for provider-owned part payloads until fields are consumed.
- `OpenCodeEventSchema`, with a mapping audit for event types currently consumed by Conduit.
- Request schemas for session create/update, message send, permission replies, questions, and any gap POST body Conduit constructs.

Add type drift checks:

```ts
type AssertExtends<A extends B, B> = true;
type _SessionSchemaMatchesSdk = AssertExtends<
  Schema.Schema.Type<typeof OpenCodeSessionSchema>,
  import("@opencode-ai/sdk").Session
>;
```

Use bidirectional checks where the schema claims full coverage. Use one-way checks where the schema intentionally validates only the envelope.

### 3. Wire OpenCode Decoding At The API Edge

Change `OpenCodeAPI.sdk()` from:

```ts
async sdk<T>(fn, label): Promise<T>
```

to a schema-explicit shape:

```ts
async sdk<T>(label, responseSchema, fn): Promise<T>
```

The method should:

- Preserve current thrown-network-error to `OpenCodeConnectionError` behavior.
- Preserve current `result.error` to `OpenCodeApiError` behavior.
- Decode `result.data` before returning.
- Convert parse failures into a typed OpenCode provider/API error with `label`, endpoint/status if available, and parse details in the error cause/log context.

Update each namespace method in `src/lib/instance/opencode-api.ts` to pass the exact response schema at the callsite.

Change `GapEndpoints` to accept schemas on `get`/`post` or on each public method, for example:

```ts
private async get<T>(path: string, schema: Schema.Schema<T>): Promise<T>
```

For methods like `getPermissions()` and `getMessagesPage()` that currently fall back to `[]`, decide per method whether malformed data is a provider failure or an existing degrade path. Do not silently convert malformed required responses to empty arrays.

### 4. Add Claude Agent SDK Schemas

Create `src/lib/contracts/providers/claude-agent-sdk.ts`.

Initial exports:

- `ClaudeSDKMessageSchema`
- Variant schemas for every installed SDK message variant that can appear in the stream.
- `ClaudeSDKUserMessageSchema`
- `ClaudeSDKOptionsJsonShapeSchema`, limited to JSON-like fields Conduit owns.
- Supporting enums for status/subtype fields Conduit reads.
- Opaque schemas for `BetaMessage`, raw stream events, dynamic tool input, structured output, and tool results.

The docs page is acceptable as the first readable map, but not as the only authority. Compare against the installed `.d.ts`, especially the full `SDKMessage` union.

Add drift checks:

- Bidirectional checks for fully represented envelope variants.
- One-way checks for intentionally shallow variants with opaque nested payloads.
- A documented list of any installed SDK variants omitted from decoding, with a reason. Prefer including unknown-but-valid variants as strict envelopes plus opaque payloads so the stream decoder does not reject provider messages Conduit can safely ignore.

### 5. Wire Claude Decoding Before Translation

In `src/lib/provider/claude/claude-provider-instance.ts`:

- Treat `ctx.query` as `AsyncIterable<unknown>` at the provider boundary.
- Decode every inbound item with `ClaudeSDKMessageSchema` before calling `ClaudeEventTranslator.translate()`.
- Keep `ClaudeEventTranslator.translate()` typed as accepting decoded `SDKMessage`.
- When a decoded message has `type === "result"`, pass the decoded result message to `resolveTurn()` without casting through `unknown`.
- On inbound decode failure, stop the active turn and surface a provider failure. Include enough parse context for logs, but do not expose huge provider payloads to browser events.
- Validate `buildUserMessage(input)` output with `ClaudeSDKUserMessageSchema` before enqueueing.
- Validate Conduit-owned JSON-shaped options before `queryFactory()` where practical. Leave `AbortController`, callbacks such as `canUseTool`, SDK objects, and other runtime handles to TypeScript or shallow checks.

### 6. Preserve Dynamic Tool Payloads

Add explicit tests that prove opaque payloads survive decoding:

- Claude tool input with arbitrary nested JSON.
- Claude structured output with arbitrary nested JSON.
- OpenCode part/tool metadata with arbitrary nested JSON.

This prevents future schema tightening from accidentally rejecting provider-owned data.

### 7. Tests

Add focused tests only:

- Schema unit tests for representative valid/invalid Claude messages.
- Schema unit tests for representative valid/invalid OpenCode SDK responses and gap endpoint responses.
- Claude provider test with a mocked async generator emitting malformed provider data, verifying the turn fails as a provider failure before translation.
- Claude outbound test where an invalid constructed `SDKUserMessage` fails before `query`.
- OpenCode API tests proving malformed SDK/gap responses fail decode instead of leaking casted partial values.
- Opaque payload survival tests for Claude and OpenCode.

Suggested commands:

```bash
pnpm vitest run test/unit/contracts/providers
pnpm vitest run test/unit/instance/opencode-api.test.ts
pnpm vitest run test/unit/provider/claude
pnpm check
```

Do not run full E2E for this change unless implementation reaches relay/event-store behavior beyond provider failure surfacing.

## Rollout Order

1. Add schema modules and schema-only tests.
2. Wire OpenCode SDK response decoding.
3. Wire OpenCode gap endpoint response/request decoding.
4. Wire Claude inbound stream decoding.
5. Wire Claude outbound user message/options decoding.
6. Remove or relocate obsolete partial schema modules.
7. Run targeted tests and `pnpm check`.

This order keeps each provider independently reviewable and gives fast feedback if an installed SDK type does not match the runtime payloads already seen in tests.

## Non-Goals

- Do not generate Effect schemas from TypeScript or OpenAPI in PR 1.
- Do not fully model Anthropic `BetaMessage` or `BetaRawMessageStreamEvent`.
- Do not fully model arbitrary provider tool input/output JSON.
- Do not rewrite provider adapters beyond boundary decoding and error propagation.
- Do not change event-store schemas unless provider failure surfacing requires a narrowly scoped update.

## Open Follow-Ups

- Decide whether OpenCode's generated client `requestValidator` and `responseValidator` hooks should eventually host these decoders directly. For PR 1, callsite-explicit decoding in `OpenCodeAPI` is clearer.
- Revisit generation once the hand-written schemas have stabilized and the OpenCode OpenAPI source is easy to locate in the installed package or upstream.
- Consider adding a small CI guard that fails when the installed Claude `SDKMessage` union gains a new discriminant not represented by `ClaudeSDKMessageSchema`.
