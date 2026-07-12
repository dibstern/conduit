# Spec — Provider Version Upgrade (contract-first)

Synthesized from `.scratch/foreman/provider-version-upgrade/01-grill.md` and the
resolved grill at `docs/plans/2026-06-26-provider-version-upgrade/grill.md`,
grounded in the live contract surfaces. Planning only — no code changed.

| package | current | target (exact) |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.132` | `0.3.207` |
| `@opencode-ai/sdk` | `^1.4.3` | `1.17.18` |

## Problem Statement

Conduit binds to two provider SDKs whose type surfaces and runtime envelopes drift
between releases. The pinned versions are far behind latest. Conduit maintains a
hand-authored **Provider Contract** (Effect `Schema` decoders + compile-time
`AssertExtends` conformance) that must track the *installed* SDK types exactly; a
stale SDK means the contract silently describes shapes the runtime no longer emits,
and new provider fields/variants either go undecoded or fail-closed unexpectedly.
The upgrade must be done contract-first, not as a blind version bump.

## Solution

Bump each SDK to the exact latest version and refresh Conduit's local contract
bindings against the installed type surface, one provider slice at a time. For every
Conduit-read request/response/event shape: keep compile-time conformance
(`AssertExtends`, bidirectional where Conduit fully normalizes), keep fail-closed
runtime decoders over the envelope + every nested field Conduit reads, and add
fixture/runtime decode coverage for changed envelopes. Provider-owned nested payloads
Conduit does not read stay opaque (`Schema.Unknown`) but are inventoried at upgrade
time so newly-observed shapes are reported, not silently dropped. Live smoke
(discovery + one minimal turn per provider) is credential-gated; unit/type/contract/
fixture tests stay credential-free and mandatory. "Latest models" means the provider's
own model catalog (Claude SDK `initializationResult()`, OpenCode `/provider`), never a
Conduit-owned hardcoded ID list.

## User Stories

1. As a Conduit maintainer, I want the two provider SDKs pinned to exact latest
   versions in `package.json` + `pnpm-lock.yaml`, so that active execution targets
   current provider runtimes.
2. As a Conduit maintainer, I want the Claude Agent SDK contract file refreshed
   against the installed `0.3.207` types, so that every `AssertExtends` conformance
   assertion still compiles and describes real shapes.
3. As a Conduit maintainer, I want the OpenCode SDK contract file refreshed against
   installed `1.17.18` types, so that the bidirectional `NormalizeSchemaType` coverage
   holds for every fully-normalized shape.
4. As a Conduit maintainer, I want fail-closed runtime decoders to reject malformed
   provider envelopes before adapter translation or persistence, so that bad data
   never reaches the event store.
5. As a Conduit maintainer, I want new provider message variants / event types /
   fields that Conduit reads promoted into the strict schema, so that the contract
   stays exhaustive.
6. As a Conduit maintainer, I want provider-owned nested payloads Conduit does not
   read to remain opaque yet inventoried, so that unknown shapes are reported without
   fail-closing the pipeline.
7. As a Conduit maintainer, I want an installed-SDK-version assertion for both
   packages, so that the committed contract and the resolved dependency can never
   silently diverge.
8. As a Conduit maintainer, I want the OpenCode audit artifacts (`.opencode-version`,
   committed OpenAPI snapshot) refreshed to the upgraded server, so that the contract
   suite validates against the real API surface.
9. As a Conduit maintainer, I want a credential-gated live smoke per provider that
   records the exact runtime version as evidence, so that I can confirm the upgraded
   contract works end to end without live creds in CI.
10. As a Conduit maintainer, I want the model catalog to remain provider-discovered,
    so that new models appear without a Conduit code change.
11. As a Conduit maintainer, I want durable Conduit data compatibility preserved
    (SQLite events, provider refs, session bindings, replay/projectors), so that the
    upgrade does not break existing stored sessions.
12. As a Conduit maintainer, I want each provider slice independently reviewable
    (contract audit → binding refresh → focused tests → smoke), so that the two
    upgrades can be reviewed and merged separately.
13. As a Conduit maintainer, I want a single shared final-verification gate that runs
    type + unit + contract suites and both smokes, so that the combined upgrade is
    proven before it lands.
14. As a Conduit maintainer, I want the Claude `Options` shape (`ClaudeSDKOptionsJsonShape`)
    re-checked against the installed `Options` type, so that request construction stays
    within the SDK's accepted fields.
15. As a Conduit maintainer, I want the OpenCode request bodies (session create/update/
    prompt, permission reply, question reply/reject) re-checked against the SDK `*Data`
    types, so that Conduit never sends a body the server rejects.

## Implementation Decisions

- **Two provider slices + shared verification + shared audit tooling.** Parent epic
  tracks the whole upgrade; each slice bumps one SDK and refreshes one contract file;
  a shared audit-tooling task supplies reusable version assertions and surface
  enumeration; a shared verification task gates the combined result.
- **Claude slice — modules touched:** contract `src/lib/contracts/providers/claude-agent-sdk.ts`
  (the `AssertExtends` block, the `CLAUDE_SDK_MESSAGE_VARIANTS` inventory, the subtype
  literal unions, the message-variant schemas, `ClaudeSDKOptionsJsonShapeSchema`, and
  the three decoders `decodeClaudeSDKMessage` / `decodeClaudeSDKUserMessage` /
  `decodeClaudeSDKOptionsJsonShape`); consumers `claude-provider-runtime.ts` (decoder
  call sites), `claude-capabilities-probe.ts` (the `initializationResult()` subset
  interfaces feeding `ModelInfo`/`CommandInfo`/`ProviderAgentInfo`), and `types.ts`.
- **OpenCode slice — modules touched:** contract `src/lib/contracts/providers/opencode-sdk.ts`
  (the `AssertExtends` + `NormalizeSchemaType` conformance pairs, `OpenCodeEventSchema`
  union + `OPEN_CODE_CONSUMED_EVENT_TYPES`, `OpenCodeProviderListResponseSchema` model
  catalog, the request-body schemas, and the ~35 `decodeOpenCode*` decoders);
  consumers `src/lib/instance/opencode-api.ts`, `gap-endpoints.ts`, `sdk-factory.ts`,
  `sdk-types.ts`, and `opencode-provider-instance.ts`.
- **Strictness policy (fail-closed with opaque escape hatch):** every Conduit-read
  envelope field and every nested field Conduit reads is strictly validated; unknown
  provider-owned nested payloads Conduit does not read stay `Schema.Unknown` /
  `Schema.Record(String, Unknown)`. Promote a nested field into the strict schema only
  when Conduit starts reading it.
- **Conformance direction:** bidirectional (`SDK extends Schema` *and*
  `NormalizeSchemaType<Schema> extends SDK`) where Conduit fully normalizes a shape;
  envelope-only (`SDK extends Schema`) where the provider owns opaque nested payloads
  (e.g. Claude `assistant.message`, OpenCode `Part`).
- **Version policy:** commit exact installed versions in `package.json` +
  `pnpm-lock.yaml`; treat both as volatile Provider Contract deps.
- **Audit tooling:** assert the *installed* SDK version for both packages equals the
  committed target, and enumerate the Conduit-read contract surfaces (the message
  variant list, the consumed event-type list, the decoder set) so drift is a test
  failure, not a runtime surprise. No noisy CI freshness polling, no broad codegen.
- **Model catalog stays provider-owned:** Claude via SDK `initializationResult()`,
  OpenCode via `OpenCodeProviderListResponseSchema` decoded from `/provider`. No
  Conduit-owned hardcoded latest-model-ID list beyond explicit fallbacks.
- **Runtime scope:** update only `@anthropic-ai/claude-agent-sdk` (verify the bundled/
  advertised Claude Code runtime version in smoke via the `system_init`
  `claude_code_version` field; do not add `@anthropic-ai/claude-code`). OpenCode smoke
  runs against the latest `opencode-ai` CLI/server and records its version; the
  committed dep stays `@opencode-ai/sdk` only.

## Testing Decisions

- **Good test = external behavior, not implementation.** Decode tests assert that a
  captured/real provider envelope is accepted (or fail-closed rejected) — they do not
  assert schema internals. Conformance is enforced at compile time by `AssertExtends`,
  so `pnpm check` is itself a test of the contract.
- **Seams (prefer existing, highest point):**
  1. *Compile-time conformance* — `pnpm check` over the `AssertExtends` assertions in
     both contract files. One seam, already the highest point; no new seam needed.
  2. *Runtime decode* — the exported `decode*` functions. OpenCode already has decode
     coverage via `test/unit/relay/opencode-events.test.ts` and
     `test/unit/provider/opencode-*`; Claude currently has **no** decode fixture suite —
     add one at the decoder boundary (`decodeClaudeSDKMessage` etc.) rather than a new
     internal seam.
  3. *Contract suite* — `pnpm test:contract` (`test/contract/**/*.contract.ts`) spawns
     an ephemeral OpenCode via `test/contract/global-setup.ts` and exercises REST/SSE/
     permission/question/tool flows; refresh `version-check.contract.ts` (reads
     `.opencode-version` via `getPinnedVersion`) and `openapi-snapshot.contract.ts`
     (reads `test/fixtures/opencode-api-snapshot.json`).
  4. *Live smoke* — opt-in, credential-gated. Extend the existing
     `test/e2e/provider/claude-provider-instance-real-sdk.test.ts` for Claude; add/keep
     an OpenCode discovery + one-turn smoke. Records exact runtime versions as evidence.
- **Prior art:** OpenCode decode/event tests under `test/unit/relay` and
  `test/unit/provider`; the whole `test/contract` suite; the real-SDK e2e test for
  Claude. New Claude decode fixtures should mirror the OpenCode event-test style.
- **Upgrade-time inventory:** capture opaque nested payload shapes seen during smoke/
  fixtures and report newly-observed shapes (does not fail the build).

## Out of Scope

- Adding `@anthropic-ai/claude-code` or `opencode-ai` as committed Conduit deps.
- Old-runtime active-compatibility shims (durable-data compat is preserved; active
  execution targets latest only).
- Full nested schemas for provider-owned payloads Conduit does not read.
- A Conduit-owned hardcoded latest-model-ID catalog.
- Noisy CI freshness checks / broad code generation.

## Further Notes

- The Claude contract already declares zero omitted variants
  (`CLAUDE_SDK_OMITTED_MESSAGE_VARIANTS = []`) and decodes ignored variants as strict
  envelopes with opaque payloads — the refresh must keep that invariant or explicitly
  record any new omission.
- OpenCode's live `/provider` payload has historically drifted ahead of the published
  SDK type for model capabilities (see the note near `OpenCodeProviderListResponseSchema`);
  expect the model-catalog schema to need the most attention on the OpenCode side.
- Since OpenCode v1.14.x the live `/doc` endpoint only serves global routes; the
  committed snapshot carries the full API surface — validate the snapshot directly.
