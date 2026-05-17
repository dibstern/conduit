# Provider Contract Runtime Schemas Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the first provider-contract runtime-schema slice: decode Provider Envelopes at the Provider Runtime Seam, keep Provider-Owned Payloads opaque, fail closed, and make Claude `SDKMessage` drift detection an acceptance criterion.

**Architecture:** This slice implements the prerequisite boundary described in `docs/plans/2026-05-15-provider-boundary-runtime-schemas.md`: schemas live under `src/lib/contracts/providers/`, adapters decode `unknown` provider data before translation or relay consumption, and provider-owned nested payloads remain `Schema.Unknown` or shallow records. The provider adapters stay stateless execution engines; decode failures become typed provider/API failures before malformed envelopes reach translators, projectors, or browser-facing events.

**Tech Stack:** TypeScript, Effect `Schema`, Effect typed errors, Claude Agent SDK, OpenCode SDK/API client, Vitest, `pnpm check`.

---

## Preconditions

- Port or merge `docs/plans/2026-05-15-provider-boundary-runtime-schemas.md` into this branch before implementation if it is not present. This plan depends on its line 8 goal: provider SDK data must not be trusted just because TypeScript types exist.
- Read `docs/agent-guide/architecture.md` before code edits. Provider instances are stateless execution engines, and the SQLite event store is the durable handoff to browser clients.
- Use the installed SDK type definitions as the local contract source of truth:
  - Claude: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  - OpenCode: `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
- Do not introduce schema generation, a broad validation framework, or full modeling of provider-owned payloads in this slice.

## t3code Reference Points

`~/src/personal/conduit-competitors/t3code` has three patterns worth copying into this slice:

- `packages/contracts` is schema-only. Keep Conduit's provider contract modules pure: schemas, types, drift checks, and compiled decoders only; no SDK calls, adapter state, logging, or persistence.
- t3code avoids building Effect Schema compilers inside runtime paths. Export module-scope decoders from the contract modules and have provider loops/API wrappers call those decoders instead of rebuilding `Schema.decodeUnknown...` per SDK message or response.
- t3code's provider runtime events carry compact raw-source metadata such as `claude.sdk.message` and `opencode.sdk.event` while the raw payload stays opaque. Use the same idea for parse failures and native-provider diagnostics: include provider/source/method labels and formatted schema issues, but do not dump large provider payloads into browser events.

## Acceptance Criteria

- `OpenCodeAPI.sdk()` no longer returns unchecked `result.data as T` from `src/lib/instance/opencode-api.ts:113`; every covered SDK response is decoded by a callsite-provided provider contract decoder.
- `GapEndpoints` no longer relies on ad hoc array checks for covered provider envelope responses from `src/lib/instance/gap-endpoints.ts:36`; covered GET/POST responses and request bodies are decoded or encoded by provider contract functions.
- Claude inbound stream items from `ctx.query` in `src/lib/provider/claude/claude-provider-instance.ts:664` are treated as `unknown` and decoded with a module-scope `decodeClaudeSDKMessage` decoder before `ClaudeEventTranslator.translate()` sees them.
- Claude outbound user messages and Conduit-owned JSON-shaped SDK options are validated before they are passed to the Claude Agent SDK.
- Provider-Owned Payloads stay opaque. Claude `BetaMessage`, raw stream events, tool input, structured output, tool results, and OpenCode tool metadata are not deeply modeled unless Conduit reads their internal fields.
- Fail closed on active provider paths. Decode failures stop the active turn or API call with a typed provider/API failure; malformed envelopes do not silently degrade into partial trusted values.
- Static provider schema compilers are hoisted to module scope. Hot paths call named decoder/encoder functions rather than constructing `Schema.decodeUnknown...`, `Schema.decode...`, or `Schema.encode...` inside stream loops or SDK/gap wrappers.
- Decode failures carry compact diagnostic context: provider, raw source label, operation/method, and formatted schema issue. Raw provider payloads remain opaque and are not dumped into browser-facing failure events.
- The Claude `SDKMessage` drift guard is part of the gate, not a follow-up. `pnpm check` or a dedicated type/unit check must fail when the installed SDK message union gains a discriminant that is not represented by `ClaudeSDKMessageSchema` or explicitly documented as intentionally omitted.

## Acceptance Proof Checklist

Run this checklist after Task 8 from the repo root. These commands are the minimum proof that the acceptance criteria are actually covered, not just implemented by inspection.

### 1. Provider contract modules exist and stay pure

Run:

```bash
test -f src/lib/contracts/providers/claude-agent-sdk.ts
test -f src/lib/contracts/providers/opencode-sdk.ts
rg -n '^import .*(@anthropic-ai/claude-agent-sdk|@opencode-ai/sdk)' src/lib/contracts/providers
rg -n 'queryFactory|new Claude|new Opencode|fetch\(|EventSink|EventStore|log\.' src/lib/contracts/providers
rg -n 'export const decodeClaudeSDKMessage|export const decodeOpenCode.*Response|export const encodeOpenCode' src/lib/contracts/providers
```

Expected:

- the two provider contract files exist
- SDK imports in contract modules are type-only or schema-source imports only; no runtime SDK clients are created there
- the runtime-call grep has no matches
- named provider decoders/encoders are exported from contract modules

Proves:

- schemas are in the contract layer
- contracts remain implementation-free
- hot paths can call hoisted decoders instead of compiling schemas inline

### 2. OpenCode SDK responses are decoded before callers see them

Run:

```bash
rg -n 'result\.data as T|return result\.data as|as T;' src/lib/instance/opencode-api.ts
rg -n 'decodeOpenCode|decodeResponse' src/lib/instance/opencode-api.ts
rg -n 'malformed|decode|invalid.*SDK|fails.*decode' test/unit/instance/opencode-api.test.ts
pnpm vitest run test/unit/instance/opencode-api.test.ts
```

Expected:

- the unchecked-cast grep has no matches in `OpenCodeAPI.sdk()`
- `opencode-api.ts` passes named decoders or a `decodeResponse` callback at SDK callsites
- tests include malformed SDK response coverage
- the focused unit test passes

Proves:

- `OpenCodeAPI.sdk()` no longer trusts SDK `result.data`
- SDK transport/API errors still exercise the existing error paths
- malformed provider envelopes fail before downstream relay code receives them

### 3. OpenCode gap endpoints validate request and response envelopes

Run:

```bash
rg -n 'Array\.isArray\(res\) \? res : \[\]|return Array\.isArray\(res\)' src/lib/instance/gap-endpoints.ts
rg -n 'decodeOpenCode|encodeOpenCode|decodeResponse|encodeBody' src/lib/instance/gap-endpoints.ts
rg -n 'malformed|required.*fails|fallback|degrade|question reply|reject request' test/unit/instance/opencode-requests.test.ts
pnpm vitest run test/unit/instance/opencode-requests.test.ts
```

Expected:

- no bare `Array.isArray(res) ? res : []` fallback remains on active provider paths
- any remaining fallback is explicitly named in code and covered by a test that says it is an intentional degrade path
- `GapEndpoints` calls named decoders/encoders for covered request and response bodies
- the focused unit test passes

Proves:

- gap responses do not silently become empty arrays when malformed
- Conduit-constructed gap request bodies are validated before fetch
- existing optional/discovery fallback semantics are preserved only where explicitly intended

### 4. Claude inbound stream decoding happens before translation

Run:

```bash
rg -n 'for await .*ctx\.query|decodeClaudeSDKMessage|translator\.translate|resolveTurn' src/lib/provider/claude/claude-provider-instance.ts
rg -n 'as unknown as SDKResultMessage|translator\.translate\(ctx, message\)' src/lib/provider/claude/claude-provider-instance.ts
rg -n 'malformed|decode|translator.*not.*called|provider failure|fails.*before.*translation' test/unit/provider/claude/claude-provider-instance-send-turn.test.ts test/unit/provider/claude/claude-event-translator.test.ts
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts
```

Expected:

- the stream loop decodes a raw item with `decodeClaudeSDKMessage` before translation
- the old result cast has no matches
- raw `message` is not passed to the translator before decode; if the decoded variable is named `message`, the nearby code must show it came from `decodeClaudeSDKMessage(rawMessage)`
- tests cover malformed stream data failing before translation
- focused Claude provider tests pass

Proves:

- malformed Claude SDK envelopes cannot reach `ClaudeEventTranslator`
- result messages are narrowed by the schema, not by `unknown` casts
- inbound decode failures fail the active provider path

### 5. Claude outbound provider data is validated before SDK handoff

Run:

```bash
rg -n 'decodeClaudeSDKUserMessage|decodeClaudeSDKOptionsJsonShape' src/lib/provider/claude/claude-provider-instance.ts
rg -n 'invalid.*user message|invalid.*options|before.*query|SDKUserMessage' test/unit/provider/claude/claude-provider-instance-send-turn.test.ts test/unit/provider/claude/types.test.ts
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
pnpm vitest run test/unit/provider/claude/types.test.ts
```

Expected:

- outbound user messages and Conduit-owned JSON option shapes call named contract decoders
- tests cover invalid constructed user messages and invalid JSON-shaped options failing before `query`
- runtime handles such as callbacks and `AbortController` are not forced through JSON schemas
- focused tests pass

Proves:

- Conduit validates the provider envelopes it constructs
- validation does not overreach into SDK runtime handles

### 6. Provider-Owned Payloads remain opaque

Run:

```bash
rg -n 'opaque|provider-owned|arbitrary nested|structured output|tool input|tool result|metadata survives|round trip' test/unit/contracts/providers test/unit/provider/claude test/unit/instance
pnpm vitest run test/unit/contracts/providers
```

Expected:

- tests explicitly mention opaque/provider-owned payload survival
- Claude tool input, Claude structured output/tool result payloads, and OpenCode tool metadata can carry arbitrary nested JSON through decoding
- provider contract tests pass

Proves:

- this slice validates envelopes without accidentally modeling provider-owned internals
- future schema tightening has a regression test that catches rejected opaque payloads

### 7. Decode failures are typed and bounded

Run:

```bash
rg -n 'Decode|Validation|ParseError|SchemaIssue|makeFormatter|provider.*source|source.*method|raw source' src/lib/contracts/providers src/lib/instance src/lib/provider/claude
rg -n 'raw provider payload|full provider payload|bounded|formatted schema issue|parse context' test/unit/contracts/providers test/unit/instance test/unit/provider/claude
```

Expected:

- decode failures are converted into typed provider/API failures or existing typed validation errors
- parse diagnostics include provider/source/method or label context
- tests assert bounded diagnostics or explicitly guard against dumping large raw payloads

Proves:

- failure mode is fail-closed and diagnosable
- provider payload opacity is preserved in error surfaces

### 8. Static schema compilers are hoisted out of provider hot paths

Run:

```bash
rg -n 'Schema\.decode(Unknown)?(Effect|Either|Exit|Option|Promise|Sync)?\(' src/lib/instance src/lib/provider/claude
rg -n 'Schema\.encode(Unknown)?(Effect|Either|Exit|Option|Promise|Sync)?\(' src/lib/instance src/lib/provider/claude
rg -n 'Schema\.decode(Unknown)?(Effect|Either|Exit|Option|Promise|Sync)?\(' src/lib/contracts/providers
```

Expected:

- no static schema compiler construction in `src/lib/instance` or `src/lib/provider/claude`
- compiler construction appears in `src/lib/contracts/providers` at module scope
- adapter code calls named decoders/encoders exported from contract modules

Proves:

- the t3code-derived performance guardrail is met
- provider stream/API hot paths do not rebuild Effect Schema compilers per event/request

### 9. Claude `SDKMessage` drift guard is enforced

Run:

```bash
rg -n 'SDKMessage\["type"\]|MissingMessageTypes|ExtraMessageTypes|AssertNever|IntentionallyOmittedClaudeSDKMessageVariants|system.*subtype' src/lib/contracts/providers/claude-agent-sdk.ts
pnpm check
```

Expected:

- the Claude contract module has discriminant coverage checks
- repeated-type variants such as `system` have subtype coverage or an explicit intentional-omission note
- `pnpm check` passes with the guard compiled

Proves:

- installed Claude SDK message drift fails the normal validation gate
- omitted SDK variants are deliberate, documented, and reviewable

### 10. Final focused gate

Run:

```bash
pnpm vitest run test/unit/contracts/providers
pnpm vitest run test/unit/instance/opencode-api.test.ts
pnpm vitest run test/unit/instance/opencode-requests.test.ts
pnpm vitest run test/unit/provider/claude
pnpm check
```

Expected: all pass.

Proves:

- contract schemas, OpenCode SDK/gap decoding, Claude inbound/outbound validation, opaque payload survival, and the Claude drift guard all pass together.

Do not run full E2E by default. Add relay/event-store/E2E validation only if implementation changes browser event shape, event-store schema, or relay wiring beyond provider failure surfacing.

## Task 1: Add Provider Contract Test Harness

**Files:**

- Create: `test/unit/contracts/providers/claude-agent-sdk.test.ts`
- Create: `test/unit/contracts/providers/opencode-sdk.test.ts`
- Create directory if missing: `test/unit/contracts/providers/`

**Step 1: Write failing Claude envelope tests**

Add tests that decode representative Claude SDK messages with `ClaudeSDKMessageSchema`:

- valid `assistant` envelope with opaque `message`
- valid `result` success envelope with `session_id`, `uuid`, and result fields Conduit reads
- valid `system` envelope with a known `subtype`
- invalid envelope missing `type`
- invalid envelope with a malformed routed field, for example non-string `session_id`
- valid message carrying arbitrary nested tool/structured payload that must survive as opaque data

Run:

```bash
pnpm vitest run test/unit/contracts/providers/claude-agent-sdk.test.ts
```

Expected: FAIL because `src/lib/contracts/providers/claude-agent-sdk.ts` does not exist.

**Step 2: Write failing OpenCode envelope tests**

Add tests that decode representative OpenCode SDK/gap response envelopes with `OpenCode*` schemas:

- valid session list response
- valid message-with-parts response
- valid session status map
- invalid session missing fields Conduit reads
- invalid message part missing `type`
- valid part/tool metadata with arbitrary nested JSON that must survive as opaque data

Run:

```bash
pnpm vitest run test/unit/contracts/providers/opencode-sdk.test.ts
```

Expected: FAIL because `src/lib/contracts/providers/opencode-sdk.ts` does not exist.

**Step 3: Commit**

```bash
git add test/unit/contracts/providers
git commit -m "test: add provider contract schema cases"
```

## Task 2: Add OpenCode Provider Contract Schemas

**Files:**

- Create: `src/lib/contracts/providers/opencode-sdk.ts`
- Read/modify later: `src/lib/domain/provider/Services/opencode-response-schemas.ts:55`
- Read: `src/lib/instance/sdk-types.ts`
- Read: `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`

**Step 1: Move schema ownership to contracts**

Create `src/lib/contracts/providers/opencode-sdk.ts` and port the useful schema shapes from `src/lib/domain/provider/Services/opencode-response-schemas.ts:55`.

Initial exports:

- `OpenCodeSessionSchema`
- `OpenCodeSessionDetailSchema`
- `OpenCodeMessageInfoSchema`
- `OpenCodeMessageWithPartsSchema`
- `OpenCodeFlatMessageSchema`
- `OpenCodePartSchema`
- `OpenCodeSessionListResponseSchema`
- `OpenCodeMessageListResponseSchema`
- `OpenCodeSessionStatusMapSchema`
- request-body schemas for permission replies, question replies/rejects, message send, and session operations that Conduit constructs in this slice
- module-scope decoders/encoders for covered hot-path contracts, for example `decodeOpenCodeSessionListResponse`, `decodeOpenCodeMessageListResponse`, `decodeOpenCodeSessionStatusMap`, `decodeOpenCodePermissionReplyBody`, and `decodeOpenCodeQuestionReplyBody`

Keep `OpenCodePartSchema` strict only for envelope fields Conduit reads, such as `id` and `type`; keep nested provider payloads opaque with `Schema.Unknown`.

**Step 2: Add OpenCode drift checks**

Add local type assertions in the contract module. Use bidirectional checks only where the schema claims full coverage. Use one-way checks where the schema intentionally validates only the envelope.

Example shape:

```ts
import type { Session } from "@opencode-ai/sdk/client";
import { Schema } from "effect";

type AssertExtends<A extends B, B> = true;

type _OpenCodeSessionSchemaMatchesSdk = AssertExtends<
	Schema.Schema.Type<typeof OpenCodeSessionSchema>,
	Session
>;
```

**Step 3: Run schema tests**

Run:

```bash
pnpm vitest run test/unit/contracts/providers/opencode-sdk.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/lib/contracts/providers/opencode-sdk.ts test/unit/contracts/providers/opencode-sdk.test.ts
git commit -m "feat: add OpenCode provider contract schemas"
```

## Task 3: Add Claude Agent SDK Provider Contract Schemas

**Files:**

- Create: `src/lib/contracts/providers/claude-agent-sdk.ts`
- Read: `src/lib/provider/claude/types.ts:23`
- Read: `src/lib/provider/claude/claude-event-translator.ts`
- Read: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

**Step 1: Model the SDK message envelopes**

Create `src/lib/contracts/providers/claude-agent-sdk.ts`.

Initial exports:

- `ClaudeSDKMessageSchema`
- variant schemas for every installed `SDKMessage` discriminant that can appear in the query stream
- `ClaudeSDKUserMessageSchema`
- `ClaudeSDKOptionsJsonShapeSchema` for Conduit-owned JSON-like options
- supporting literal schemas for status and subtype fields Conduit reads
- opaque schemas for `BetaMessage`, raw stream events, dynamic tool input, structured output, and tool results
- module-scope decoders for hot paths, especially `decodeClaudeSDKMessage`, `decodeClaudeSDKUserMessage`, and `decodeClaudeSDKOptionsJsonShape`

Do not deeply model Anthropic message internals. If Conduit only forwards or stores a nested payload, keep it opaque.

**Step 2: Add the Claude SDKMessage drift guard**

The guard must fail during `pnpm check` or the contract test command when the installed `SDKMessage` union changes without a schema update.

Use an explicit discriminant coverage check:

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Schema } from "effect";

type SdkMessageType = SDKMessage["type"];
type SchemaMessageType = Schema.Schema.Type<
	typeof ClaudeSDKMessageSchema
>["type"];
type MissingMessageTypes = Exclude<SdkMessageType, SchemaMessageType>;
type ExtraMessageTypes = Exclude<SchemaMessageType, SdkMessageType>;
type AssertNever<T extends never> = T;

type _NoMissingClaudeSdkMessageTypes = AssertNever<MissingMessageTypes>;
type _NoExtraClaudeSdkMessageTypes = AssertNever<ExtraMessageTypes>;
```

For repeated `type` values with subtype unions, such as `system`, add subtype-level assertions for the variants Conduit routes or translates. If a variant is intentionally omitted, add a named `IntentionallyOmittedClaudeSDKMessageVariants` type or comment in this module explaining why it is safe.

**Step 3: Run schema tests and type check**

Run:

```bash
pnpm vitest run test/unit/contracts/providers/claude-agent-sdk.test.ts
pnpm check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/lib/contracts/providers/claude-agent-sdk.ts test/unit/contracts/providers/claude-agent-sdk.test.ts
git commit -m "feat: add Claude provider contract schemas"
```

## Task 4: Wire OpenCode Decoding At The SDK Edge

**Files:**

- Modify: `src/lib/instance/opencode-api.ts:113`
- Modify: `test/unit/instance/opencode-api.test.ts`

**Step 1: Write failing OpenCode API decode tests**

Extend `test/unit/instance/opencode-api.test.ts` with cases proving:

- a malformed SDK response fails before reaching callers
- the thrown error includes the API label and response context where available
- existing `result.error` behavior still becomes `OpenCodeApiError`
- existing network throw behavior still becomes `OpenCodeConnectionError`

Run:

```bash
pnpm vitest run test/unit/instance/opencode-api.test.ts
```

Expected: FAIL because `OpenCodeAPI.sdk()` still returns `result.data as T`.

**Step 2: Make `sdk()` decoder-explicit**

Change `OpenCodeAPI.sdk()` from:

```ts
async sdk<T>(fn: () => Promise<SdkResult<T>>, label: string): Promise<T>
```

to:

```ts
async sdk<T>(
	label: string,
	decodeResponse: (raw: unknown) => DecodeResult<T>,
	fn: () => Promise<SdkResult<unknown>>,
): Promise<T>
```

Prefer the concrete return shape from `Schema.decodeUnknownEither(...)` for Promise-based adapters so the adapter can inspect decode failure without introducing a new Effect runtime boundary. Define `DecodeResult<T>` as the actual `Either`/parse-error type returned by the installed Effect version. The important constraint is that static schema compilers are created once in `src/lib/contracts/providers/opencode-sdk.ts`, not rebuilt inside `sdk()` for every call.

Decode `result.data` before returning. Convert parse failures into an existing typed OpenCode error shape, or add the smallest typed parse error needed if `OpenCodeApiError` cannot preserve parse context cleanly. Include provider/source/label and a formatted schema issue.

Do not catch decode failures as connection errors.

**Step 3: Pass decoders at callsites**

Update each namespace method in `src/lib/instance/opencode-api.ts` to pass the exact response decoder:

- session list/detail/message/status methods
- permission/question methods that use SDK responses
- provider/config/app/event methods where Conduit reads response fields

Keep message flattening after decoding the raw message-with-parts envelope. If the flatten helper still needs runtime compatibility checks, keep them local and covered by tests.

**Step 4: Run targeted tests**

Run:

```bash
pnpm vitest run test/unit/instance/opencode-api.test.ts
pnpm vitest run test/unit/contracts/providers/opencode-sdk.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/instance/opencode-api.ts test/unit/instance/opencode-api.test.ts
git commit -m "feat: decode OpenCode SDK responses"
```

## Task 5: Wire OpenCode Gap Endpoint Decoding

**Files:**

- Modify: `src/lib/instance/gap-endpoints.ts:36`
- Modify: `test/unit/instance/opencode-requests.test.ts`
- Modify or replace: `test/unit/instance/opencode-response-schemas.test.ts`

**Step 1: Write failing gap endpoint tests**

Add or update tests proving:

- malformed required gap response data fails closed
- endpoints that intentionally degrade still do so only where current behavior already had fallback semantics
- question reply and reject request bodies are validated before fetch
- arbitrary provider-owned metadata survives decoding

Run:

```bash
pnpm vitest run test/unit/instance/opencode-requests.test.ts
```

Expected: FAIL because `GapEndpoints` currently parses JSON as `unknown` and returns `[]` for non-arrays.

**Step 2: Add decoder/encoder parameters to `get` and `post`**

Change private helpers to accept module-scope contract functions:

```ts
private async get<T>(
	path: string,
	decodeResponse: (raw: unknown) => DecodeResult<T>,
): Promise<T>
private async post<TBody, TResponse>(
	path: string,
	encodeBody: (body: TBody) => EncodeResult<unknown>,
	body: TBody,
	decodeResponse: (raw: unknown) => DecodeResult<TResponse>,
): Promise<TResponse>
```

Use Effect Schema to validate both Conduit-constructed bodies and provider responses, but keep the compiled encoders/decoders hoisted in `src/lib/contracts/providers/opencode-sdk.ts`. `EncodeResult` should mirror the actual return type from the hoisted `Schema.encodeUnknownEither(...)` function.

**Step 3: Preserve explicit fallback semantics**

For methods such as `listPendingPermissions()`, `listPendingQuestions()`, `listSkills()`, and `getMessagesPage()`, make the fallback decision explicit in each public method:

- if malformed data means the active provider path is unsafe, throw a typed decode failure
- if the method already intentionally degrades for discovery or optional capabilities, preserve fallback but add a test naming that behavior

Do not silently convert malformed active-session data to `[]`.

**Step 4: Retire or redirect old schema tests**

Move `test/unit/instance/opencode-response-schemas.test.ts` coverage to `test/unit/contracts/providers/opencode-sdk.test.ts`, or update it to import from `src/lib/contracts/providers/opencode-sdk.ts`. Remove `src/lib/domain/provider/Services/opencode-response-schemas.ts` only after `rg 'opencode-response-schemas' src test` shows no remaining imports.

**Step 5: Run targeted tests**

Run:

```bash
pnpm vitest run test/unit/instance/opencode-requests.test.ts
pnpm vitest run test/unit/contracts/providers/opencode-sdk.test.ts
pnpm vitest run test/unit/instance/opencode-api.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lib/instance/gap-endpoints.ts src/lib/domain/provider/Services/opencode-response-schemas.ts test/unit/instance test/unit/contracts/providers/opencode-sdk.test.ts
git commit -m "feat: decode OpenCode gap endpoint payloads"
```

## Task 6: Wire Claude Inbound Stream Decoding

**Files:**

- Modify: `src/lib/provider/claude/claude-provider-instance.ts:659`
- Modify: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`
- Modify: `test/unit/provider/claude/claude-event-translator.test.ts`

**Step 1: Write failing malformed-stream test**

Add a provider instance test where a mocked `ctx.query` emits a malformed object before any valid result.

Assert:

- `ClaudeEventTranslator.translate()` is not called for the malformed envelope
- the active turn is resolved as a provider failure
- logs/errors include bounded parse context, not the full provider payload

Run:

```bash
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
```

Expected: FAIL because `runStreamConsumer()` passes raw SDK stream items to the translator.

**Step 2: Decode every inbound stream item**

In `runStreamConsumer()`, treat each item from `ctx.query` as `unknown`, decode with the module-scope `decodeClaudeSDKMessage` function, and pass only the decoded message to `translator.translate()`.

Keep this order:

```ts
for await (const rawMessage of ctx.query as AsyncIterable<unknown>) {
	const message = decodeClaudeSDKMessage(rawMessage);
	await translator.translate(ctx, message);
	if (message.type === "result") {
		this.resolveTurn(ctx, message);
	}
}
```

Use existing async style in this class unless the surrounding method is deliberately moved into `Effect`. If a helper is needed to translate `Either`/Effect decode results into the adapter's Promise error path, keep it tiny and local to this file; keep the compiled decoder itself in the provider contract module.

**Step 3: Fail closed on decode errors**

On decode failure:

- stop processing the current stream item
- call the same error-translation and turn-resolution path used for provider failures
- avoid exposing huge raw provider payloads to browser events
- keep stale resume cursor cleanup behavior for actual provider/session errors

**Step 4: Remove the result cast**

After `ClaudeSDKMessageSchema` narrows the result variant, pass the decoded result message to `resolveTurn()` without `as unknown as SDKResultMessage`.

**Step 5: Run targeted tests**

Run:

```bash
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts
pnpm vitest run test/unit/contracts/providers/claude-agent-sdk.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-provider-instance.ts test/unit/provider/claude test/unit/contracts/providers/claude-agent-sdk.test.ts
git commit -m "feat: decode Claude SDK stream messages"
```

## Task 7: Validate Claude Outbound Provider Contract Data

**Files:**

- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Modify: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`
- Modify: `test/unit/provider/claude/types.test.ts`

**Step 1: Write failing outbound validation tests**

Add tests proving:

- `buildUserMessage(input)` output must satisfy `ClaudeSDKUserMessageSchema`
- invalid constructed user message data fails before `query`
- Conduit-owned JSON-shaped options fail validation before `queryFactory()`
- runtime handles such as `AbortController`, callbacks, and SDK objects are not forced through JSON schemas

Run:

```bash
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
pnpm vitest run test/unit/provider/claude/types.test.ts
```

Expected: FAIL because outbound data is not runtime validated yet.

**Step 2: Validate `SDKUserMessage` before enqueue**

Find the user-message construction path in `src/lib/provider/claude/claude-provider-instance.ts` and decode the constructed value with `ClaudeSDKUserMessageSchema` before it is enqueued into the prompt queue.

Convert validation failure into the same typed provider failure path used by inbound decode failures.

**Step 3: Validate Conduit-owned SDK option JSON**

Before `queryFactory()` receives options, validate only the JSON-like fields Conduit constructs and owns. Do not run `AbortController`, permission callbacks, transport callbacks, SDK objects, or other runtime handles through `ClaudeSDKOptionsJsonShapeSchema`.

**Step 4: Run targeted tests**

Run:

```bash
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
pnpm vitest run test/unit/provider/claude/types.test.ts
pnpm vitest run test/unit/contracts/providers/claude-agent-sdk.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/provider/claude/claude-provider-instance.ts test/unit/provider/claude test/unit/contracts/providers/claude-agent-sdk.test.ts
git commit -m "feat: validate Claude outbound SDK envelopes"
```

## Task 8: Final Drift, Opaqueness, And Cleanup Gate

**Files:**

- Modify as needed: `src/lib/contracts/providers/claude-agent-sdk.ts`
- Modify as needed: `src/lib/contracts/providers/opencode-sdk.ts`
- Delete if unused: `src/lib/domain/provider/Services/opencode-response-schemas.ts`
- Update if imports moved: `test/unit/instance/opencode-response-schemas.test.ts`

**Step 1: Run import and cast checks**

Run:

```bash
rg -n 'opencode-response-schemas|result\.data as T|as unknown as SDKResultMessage|ClaudeEventTranslator\.translate\(ctx, message\)' src test
rg -n 'Schema\.decode(Unknown)?(Effect|Either|Exit|Option|Promise|Sync)?\(' src/lib/instance src/lib/provider/claude
```

Expected:

- no imports from the old OpenCode schema module unless it intentionally remains as a compatibility re-export
- no unchecked `result.data as T` in `OpenCodeAPI.sdk()`
- no `as unknown as SDKResultMessage` in the Claude result path
- no raw `message` passed to `ClaudeEventTranslator.translate()` before schema decoding
- no static provider schema compiler construction in `src/lib/instance` or `src/lib/provider/claude`; those directories should call named contract decoders/encoders instead

**Step 2: Verify Claude drift guard is part of the gate**

Run:

```bash
pnpm check
```

Expected: PASS with the drift guard compiled. Temporarily adding a fake missing `SDKMessage["type"]` locally should produce a type failure; do not commit that temporary change.

**Step 3: Run focused unit suites**

Run:

```bash
pnpm vitest run test/unit/contracts/providers
pnpm vitest run test/unit/instance/opencode-api.test.ts
pnpm vitest run test/unit/instance/opencode-requests.test.ts
pnpm vitest run test/unit/provider/claude
```

Expected: PASS.

**Step 4: Decide whether broader validation is warranted**

Do not run full E2E by default. Run broader relay/event-store tests only if implementation changes browser event shape, event-store schema, or relay wiring beyond provider failure surfacing.

**Step 5: Commit cleanup**

```bash
git add src/lib/contracts/providers src/lib/instance src/lib/provider/claude test/unit
git commit -m "chore: finish provider contract runtime schema slice"
```

## Non-Goals

- Do not generate Effect schemas from TypeScript or OpenAPI.
- Do not fully model Anthropic `BetaMessage` or `BetaRawMessageStreamEvent`.
- Do not fully model arbitrary provider tool input/output JSON.
- Do not rewrite provider adapters beyond boundary decoding and typed error propagation.
- Do not change event-store schemas unless provider failure surfacing has no existing compatible event path.
- Do not turn this into a general validation framework.

## Review Checklist

- Provider Contract schemas are pure and live under `src/lib/contracts/providers/`.
- Provider Contract modules may export compiled decoders/encoders, but no SDK calls, logging, persistence, or adapter state.
- Provider adapters remain responsible for SDK calls, state, and error propagation.
- Decode happens at the Provider Runtime Seam, before translation or relay consumption.
- Static provider decoders are hoisted and named; hot paths do not rebuild Effect Schema compilers.
- Provider-Owned Payloads remain opaque and have explicit survival tests.
- Active provider paths fail closed on malformed Provider Envelopes.
- The Claude `SDKMessage` drift guard is enforced by the normal validation gate.
- Error messages include useful provider, source, method/label, endpoint, and parse context without dumping large provider payloads.

## Post-Slice Follow-Up: t3code-Style ProviderRuntimeEvent Model

This is deliberately after the Provider Contract runtime-schema slice. Do not start this broader migration until Provider Envelopes are decoded at the provider boundary and malformed Claude/OpenCode data fails closed.

t3code's broader model is not just "more schemas." It is a canonical provider-runtime event layer that sits between native provider SDK events and browser/persistence projections. The useful parts to consider next are:

- a schema-only `ProviderRuntimeEvent` union in the contracts layer
- a normalized event base with provider, provider instance, thread/session, turn, item, request, raw-source, and provider-native reference fields
- typed event families for session, thread, turn, item, content, request, user input, task, hook, tool, auth, account, MCP, model reroute, warning, and error events
- opaque native payload preservation through a `raw` envelope instead of deep provider-payload modeling
- a split between provider driver kind and provider instance id so routing keys are not confused with implementation kinds

### What t3code's Model Contains

t3code's `packages/contracts/src/providerRuntime.ts` defines these pieces:

- `RuntimeEventRawSource`, with native source labels such as `claude.sdk.message`, `claude.sdk.permission`, and `opencode.sdk.event`.
- `RuntimeEventRaw`, shaped as `{ source, method?, messageType?, payload: unknown }`.
- `ProviderRefs`, shaped as `{ providerTurnId?, providerItemId?, providerRequestId? }`.
- normalized state enums:
  - session: `starting`, `ready`, `running`, `waiting`, `stopped`, `error`
  - thread: `active`, `idle`, `archived`, `closed`, `compacted`, `error`
  - turn: `completed`, `failed`, `interrupted`, `cancelled`
  - item: `inProgress`, `completed`, `failed`, `declined`
  - content stream kind: assistant text, reasoning text, plan text, command output, file-change output, unknown
  - runtime error class: provider, transport, permission, validation, unknown
- a shared event base:
  - `eventId`
  - `provider`
  - `providerInstanceId`
  - `threadId`
  - `createdAt`
  - optional `turnId`, `itemId`, `requestId`
  - optional `providerRefs`
  - optional `raw`
- a large discriminated union of typed event names:
  - `session.started`, `session.configured`, `session.state.changed`, `session.exited`
  - `thread.started`, `thread.state.changed`, `thread.metadata.updated`, `thread.token-usage.updated`
  - realtime thread events
  - `turn.started`, `turn.completed`, `turn.aborted`, `turn.plan.updated`, `turn.proposed.delta`, `turn.proposed.completed`, `turn.diff.updated`
  - `item.started`, `item.updated`, `item.completed`
  - `content.delta`
  - `request.opened`, `request.resolved`
  - `user-input.requested`, `user-input.resolved`
  - task, hook, tool, auth, account, MCP, model reroute, config warning, deprecation, files persisted, runtime warning, runtime error events

t3code's `packages/contracts/src/providerInstance.ts` also separates:

- `ProviderDriverKind`: the implementation selector, intentionally an open branded slug
- `ProviderInstanceId`: the user/config routing key
- opaque driver config in the shared contract layer, with driver-owned schemas decoded by the runtime registry

That split is worth considering for Conduit, but it is broader than provider-envelope runtime schemas. Conduit currently has `providerId` on provider instances and provider selection, so this needs a separate routing and persistence migration plan.

### Why This Is A Separate Follow-Up

The current slice protects Conduit from malformed native provider envelopes. A t3code-style `ProviderRuntimeEvent` model changes the normalized event vocabulary that flows through the rest of Conduit.

That broader work touches:

- provider adapter translation
- Conduit's canonical event union
- event-store payload schemas
- projectors
- relay-to-browser message translation
- replay/history adapters
- frontend stores and rendering assumptions
- provider identity and multi-instance routing

Do not hide that inside the runtime-schema slice. The right next step is to make it an explicit follow-up plan after this plan lands.

### Proposed Conduit Scope

Add a future plan, likely named:

```text
docs/plans/YYYY-MM-DD-provider-runtime-event-model.md
```

The follow-up should cover these implementation areas.

#### 1. Contract Layer

Create:

- `src/lib/contracts/providers/provider-runtime-event.ts`
- `test/unit/contracts/providers/provider-runtime-event.test.ts`

Initial contents:

- branded or constrained ids for runtime event ids, turn ids, item ids, request ids, and provider-native refs
- `ProviderRuntimeRawSource`
- `ProviderRuntimeRaw`
- `ProviderRuntimeProviderRefs`
- `ProviderRuntimeEventBase`
- first `ProviderRuntimeEvent` union
- module-scope decoders such as `decodeProviderRuntimeEvent`

Keep this module schema-only. It may import Effect Schema and shared schema helpers, but it must not import provider adapters, persistence, relay, frontend, or SDK clients.

#### 2. Event Vocabulary Mapping

Map Conduit's current canonical event names in `src/lib/persistence/events.ts` to a future runtime-event vocabulary:

| Current Conduit event | Candidate ProviderRuntimeEvent |
|---|---|
| `message.created` | `item.started` or `thread.started`, depending on whether it creates a durable assistant/user item |
| `text.delta` | `content.delta` with `streamKind: "assistant_text"` |
| `thinking.start` / `thinking.delta` / `thinking.end` | `item.started`, `content.delta` with `streamKind: "reasoning_text"`, then `item.completed` |
| `tool.started` / `tool.running` / `tool.completed` | `item.started`, `item.updated`, `item.completed` with a tool lifecycle item type |
| `turn.completed` | `turn.completed` |
| `turn.error` | `turn.completed` with `state: "failed"` or `runtime.error`, depending on whether the failure belongs to a turn or runtime |
| `turn.interrupted` | `turn.aborted` or `turn.completed` with `state: "interrupted"` |
| `session.status` | `session.state.changed` |
| `permission.asked` / `permission.resolved` | `request.opened` / `request.resolved` |
| `question.asked` / `question.resolved` | `user-input.requested` / `user-input.resolved` |

This mapping is not purely mechanical. The follow-up must decide whether Conduit's durable event log should store the new model directly or whether adapters should emit `ProviderRuntimeEvent` and then a compatibility translator should continue writing current `CanonicalEvent` during migration.

#### 3. Provider Adapter Translation

Touch:

- `src/lib/provider/claude/claude-event-translator.ts`
- `src/lib/provider/claude/claude-provider-instance.ts`
- `src/lib/persistence/canonical-event-translator.ts`
- `src/lib/provider/opencode-provider-instance.ts`
- `src/lib/provider/relay-event-sink.ts`
- `src/lib/provider/types.ts`

Expected direction:

- Claude and OpenCode adapters produce `ProviderRuntimeEvent` or pass through a narrow adapter-to-runtime translator.
- Native payloads are preserved only under `raw: { source, method?, messageType?, payload }`.
- Provider-native identifiers are copied to `providerRefs`, not smuggled into arbitrary payload fields.
- Provider-owned payloads stay opaque unless Conduit renders or routes by their internals.
- Existing `EventSink.push(event: CanonicalEvent)` either becomes `EventSink.pushRuntime(event: ProviderRuntimeEvent)` or is wrapped by a compatibility adapter while projectors are migrated.

Do not migrate every provider and projector in one hidden step. Start by emitting runtime events in tests alongside current canonical events and prove parity.

#### 4. Persistence And Projectors

Touch:

- `src/lib/persistence/events.ts`
- `src/lib/persistence/event-store.ts`
- `src/lib/persistence/effect/event-store-effect.ts`
- `src/lib/persistence/effect/stored-event-row.ts`
- `src/lib/persistence/projectors/session-projector.ts`
- `src/lib/persistence/projectors/message-projector.ts`
- `src/lib/persistence/projectors/turn-projector.ts`
- `src/lib/persistence/projectors/approval-projector.ts`
- `src/lib/persistence/projectors/provider-projector.ts`
- `src/lib/persistence/projectors/activity-projector.ts`
- `src/lib/persistence/session-history-adapter.ts`
- `src/lib/persistence/session-list-adapter.ts`
- `src/lib/persistence/migrations/*`, only if the stored row shape or indexed fields change

Recommended migration path:

1. Add `ProviderRuntimeEvent` schemas and tests without changing storage.
2. Add a pure compatibility translator from `ProviderRuntimeEvent` to current `CanonicalEvent`.
3. Run both translators in tests and assert replay/projector parity for Claude and OpenCode fixtures.
4. Migrate projectors one at a time to read runtime events directly.
5. Only then consider changing stored event schemas or migrations.

Avoid a first PR that rewrites the event store and all projectors at once. This affects replay, history, session list projections, approvals/questions, activity projections, and browser delivery.

#### 5. Relay And Browser Delivery

Touch:

- `src/lib/provider/relay-event-sink.ts`
- `src/lib/relay/event-pipeline.ts`
- `src/lib/relay/event-translator.ts`
- `src/lib/relay/opencode-events.ts`
- `src/lib/relay/message-poller.ts`
- `src/lib/domain/relay/Services/message-poller.ts`
- `src/lib/contracts/ws-message-schemas.ts`
- `src/lib/shared-types.ts`
- `src/lib/frontend/stores/*`
- `src/lib/frontend/components/*` that render message, reasoning, tool, permission, or question state

Expected direction:

- Keep browser `RelayMessage` compatibility initially.
- Add a `ProviderRuntimeEvent -> RelayMessage[]` translator next to the current `CanonicalEvent -> RelayMessage[]` path.
- Use `content.delta` plus `streamKind` to remove separate text/thinking/tool-output special cases over time.
- Use `item.started/updated/completed` for tool/message lifecycle rendering.
- Use `request.opened/resolved` and `user-input.requested/resolved` to unify permission and question flows without losing their UX differences.

The frontend should not need to understand raw Claude or OpenCode payloads. It should consume normalized runtime events or existing relay messages derived from them.

#### 6. Provider Identity And Multi-Instance Routing

Touch:

- `src/lib/provider/provider-registry.ts`
- `src/lib/provider/types.ts`
- `src/lib/provider/orchestration-engine.ts`
- `src/lib/provider/orchestration-wiring.ts`
- `src/lib/contracts/ws-rpc.ts`
- provider/session persistence fields that currently store provider ids
- frontend provider selectors and session/provider display code

t3code's `ProviderDriverKind` / `ProviderInstanceId` split is relevant if Conduit wants multiple instances of the same driver, for example `claude_personal`, `claude_work`, or multiple OpenCode runtimes.

Do not force this into the event-model PR unless it is already required. A safer sequence is:

1. Add optional `providerInstanceId` to runtime-event schemas.
2. Continue filling it from existing `providerId` where possible.
3. Add a separate provider-instance routing plan before changing persisted routing keys.

#### 7. Native Event Logging And Diagnostics

Touch:

- `src/lib/provider/claude/claude-event-translator.ts`
- `src/lib/provider/claude/claude-provider-instance.ts`
- `src/lib/persistence/events.ts`
- any native provider event log or debug trace files if present

Expected direction:

- Use `raw.source` values like `claude.sdk.message` and `opencode.sdk.event`.
- Use `raw.method` or `raw.messageType` for provider-native event names.
- Keep `raw.payload` as `unknown`.
- Bound logs and browser-visible errors. Do not expose full provider payloads in browser events.

This complements the current plan's parse-failure diagnostics, but the follow-up applies it to all normalized provider runtime events.

### Suggested Follow-Up PR Sequence

1. **Contracts-only PR**
   - Add `ProviderRuntimeEvent` schemas, raw-source types, provider refs, and tests.
   - No adapter, persistence, relay, or frontend behavior changes.

2. **Adapter parity PR**
   - Add Claude/OpenCode mapping functions that produce `ProviderRuntimeEvent`.
   - Keep existing `CanonicalEvent` writes.
   - Add fixture tests proving current canonical outputs and future runtime outputs match intent.

3. **Compatibility translator PR**
   - Add `ProviderRuntimeEvent -> CanonicalEvent` and `ProviderRuntimeEvent -> RelayMessage[]` translators.
   - Keep storage unchanged.
   - Add replay/projector parity tests.

4. **Projector migration PRs**
   - Move one projector family at a time: session, message, turn, approval/question, provider/activity.
   - Keep compatibility aliases until all readers are migrated.

5. **Relay/frontend cleanup PR**
   - Switch relay rendering paths to runtime-event-derived relay messages or directly normalized event state.
   - Remove old event-specific branching only when replay and live streams match.

6. **Provider-instance identity PR**
   - Add or formalize provider instance ids separately from driver kinds if the runtime model needs it.
   - Migrate persisted provider routing only after compatibility tests cover older sessions.

### Follow-Up Acceptance Proof

The future ProviderRuntimeEvent plan should include these proof gates:

```bash
pnpm vitest run test/unit/contracts/providers/provider-runtime-event.test.ts
pnpm vitest run test/unit/provider/claude
pnpm vitest run test/unit/provider/opencode-provider-instance-actions.test.ts
pnpm vitest run test/unit/persistence
pnpm vitest run test/unit/relay
pnpm check
```

Add targeted greps:

```bash
rg -n 'ProviderRuntimeEvent|ProviderRuntimeRaw|providerRefs|raw: \{' src/lib/contracts src/lib/provider src/lib/persistence src/lib/relay
rg -n 'message\.created|text\.delta|thinking\.delta|tool\.started|permission\.asked|question\.asked' src/lib/provider src/lib/persistence src/lib/relay
rg -n 'providerInstanceId|ProviderDriverKind|ProviderInstanceId' src/lib
```

Expected:

- runtime event schemas are contract-only
- native provider payloads only appear under `raw.payload`
- provider-native ids are carried in `providerRefs`
- old event names disappear from provider adapters before they disappear from compatibility translators
- projectors and replay tests pass before storage shape changes
