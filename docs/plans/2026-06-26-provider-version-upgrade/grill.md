# Provider Version Upgrade Grill

Date: 2026-06-26

## Starting Facts

- Conduit is a browser-facing orchestrator for AI coding assistants. It keeps durable conversation state in its own event store while provider runtimes execute stateless turns.
- The existing glossary term for this work is **Provider Contract**: the externally documented and locally installed request, response, and event shapes that a provider runtime exposes to Conduit.
- Current package versions in `package.json` are `@anthropic-ai/claude-agent-sdk` `^0.2.132` and `@opencode-ai/sdk` `^1.4.3`.
- Current npm latest versions checked during the session are `@anthropic-ai/claude-agent-sdk` `0.3.193`, `@anthropic-ai/claude-code` `2.1.193`, `@opencode-ai/sdk` `1.17.11`, and `opencode-ai` `1.17.11`.
- Claude integration goes through `src/lib/provider/claude/*`, especially `claude-provider-runtime.ts`, `claude-capabilities-probe.ts`, `types.ts`, and `src/lib/contracts/providers/claude-agent-sdk.ts`.
- OpenCode integration goes through `src/lib/instance/*`, `src/lib/provider/opencode-provider-instance.ts`, and `src/lib/contracts/providers/opencode-sdk.ts`.
- The repo already has compile-time SDK conformance checks and runtime schema decoders for provider envelopes, but those need to be refreshed and exercised against the upgraded SDKs.

## Open Questions

### 1. Meaning of "latest"

Decision: "Latest model versions" means the **Provider Model Catalog** exposed by the latest installed provider SDK/runtime libraries, not an exact Conduit-owned catalog of model IDs.

Implication: the migration should update `@anthropic-ai/claude-agent-sdk` and `@opencode-ai/sdk`, refresh the local Provider Contract bindings against those installed versions, and preserve provider discovery as the source of model truth. Conduit should avoid hardcoding exact latest model IDs except for explicit compatibility fallbacks.

Recommended answer accepted: hybrid alias/discovery semantics. Claude models should come from the upgraded Claude Agent SDK capability probe and aliases/settings where the SDK owns them. OpenCode models should come from the upgraded OpenCode SDK/server provider list.

### 2. Upgrade work structure

Decision: use one parent plan with two provider-specific slices and shared final verification.

Implication: the implementation plan should split Claude Agent SDK and OpenCode SDK work into independently reviewable slices. Each slice needs its own contract audit, binding refresh, focused tests, and provider-specific smoke evidence. The final pass should verify that shared model selection, provider discovery, session turn flow, permissions/questions, event ingestion, and UI display still agree across both providers.

Recommended answer accepted: one parent plan, two provider slices, shared final verification.

### 3. Verification bar for missing provider fields

Decision: use contract-first strictness.

Implication: each provider slice should bump the SDK, inspect the installed SDK/API type surface, update Conduit's runtime schemas and adapter bindings, keep compile-time conformance checks for every Conduit-read request/response/event shape, and add fixture/runtime decode tests for changed envelopes. Where Conduit fully normalizes a provider shape, checks should be bidirectional. Where the provider owns nested payloads, Conduit should decode only the envelope fields it reads and keep nested payloads opaque.

The plan should not claim absolute certainty. The acceptable standard is: every field Conduit reads is proved against installed SDK types, decoded at runtime before translation or persistence, covered by focused tests, and smoke-tested against live latest provider behavior.

Recommended answer accepted: contract-first strictness, followed by provider-specific live smoke and shared final verification.

### 4. Live provider smoke tests

Decision: require live smoke tests behind explicit environment and credential gates.

Implication: unit, type, contract, and fixture tests remain mandatory and should run without provider credentials. Completion of the migration also requires opt-in live smoke evidence against the latest Claude Agent SDK behavior and latest OpenCode SDK/server behavior. The live scope should be narrow: provider/model discovery plus one minimal session turn per provider, with permission/question/agent/variant/context-window smoke added only when the upgraded contract surface changes those flows.

Recommended answer accepted: live smoke required, but only through explicit commands that document the needed credentials, binaries, and environment variables.

### 5. Dependency version policy

Decision: commit exact installed latest provider SDK versions in `package.json` and `pnpm-lock.yaml`.

Implication: `@anthropic-ai/claude-agent-sdk` and `@opencode-ai/sdk` should be treated as volatile Provider Contract dependencies. The migration evidence should correspond to exact installed versions, not a semver range that may resolve differently later. Future provider SDK upgrades should repeat this contract-first process deliberately.

Recommended answer accepted: exact installed latest versions for both provider SDKs.

### 6. Reusable upgrade tooling

Decision: add narrow provider-contract audit scripts/tests.

Implication: the migration should add small repo-local tooling that verifies installed provider SDK versions, enumerates the Conduit-read contract surfaces, and runs focused provider contract decode suites. The tooling should support deliberate future provider SDK upgrades without adding noisy CI freshness checks or broad code generation.

Recommended answer accepted: reusable narrow provider-contract audit scripts are in scope.

### 7. OpenCode runtime for live smoke

Decision: live smoke must run against the latest `opencode-ai` CLI/server, but Conduit only commits the `@opencode-ai/sdk` dependency.

Implication: the OpenCode slice should update and pin `@opencode-ai/sdk` in Conduit. The live smoke instructions must verify that the OpenCode server under test is latest `opencode-ai` and record that version as evidence. The implementation should not add `opencode-ai` as a repo dependency unless PATH-based smoke proves too loose or unreproducible.

Recommended answer accepted: latest OpenCode runtime is required for live smoke evidence; committed dependency remains the SDK.

### 8. Claude Code package scope

Decision: update only `@anthropic-ai/claude-agent-sdk`; do not add `@anthropic-ai/claude-code` as a separate Conduit dependency.

Implication: the Claude slice should pin the latest Agent SDK package and verify the SDK's bundled or advertised Claude Code runtime version as part of live smoke evidence. Conduit should not introduce a separate Claude Code CLI dependency unless the upgraded Agent SDK no longer provides the needed runtime behavior.

Recommended answer accepted: committed dependency scope remains the Agent SDK.

### 9. Compatibility boundary

Decision: preserve Conduit durable data compatibility, but require latest provider runtimes for active execution.

Implication: existing SQLite events, provider refs, session bindings, stored provider state, and replay/projector behavior must keep working after the migration. Active provider execution, model discovery, permission/question handling, session turns, and provider runtime smoke tests should target the latest installed SDK/runtime contracts only. The plan should not add old-runtime active compatibility shims unless a durable-data migration explicitly requires them.

Recommended answer accepted: durable Conduit state remains compatible; active provider runtime compatibility is latest-only.

### 10. Strictness for new provider fields or variants

Decision: use strict runtime validation for provider envelopes and every nested field Conduit reads, plus upgrade-time inventory for provider-owned nested payload shapes.

Conflict to resolve: today, Conduit distinguishes provider envelopes that it reads from nested provider/model/tool payloads that it preserves opaquely. Full nested schemas would make Conduit responsible for provider-owned payload structure and may cause unrelated provider/model/tool changes to break Conduit.

User rationale for full nested schemas: agents could update the schemas during future SDK upgrades, and full schemas would keep the project aware of the latest data available from provider/model payloads.

Resolution: do not make production reject unknown nested provider-owned payloads that Conduit does not read. Instead, add contract fixtures/live-smoke inventories that capture nested provider-owned payload shapes during upgrades and report newly observed shapes. When Conduit starts reading a nested field, promote that field into the strict runtime schema and tests.

Recommended answer accepted: runtime fail-closed for Conduit-read envelopes and fields; upgrade-time awareness for opaque nested provider/model/tool payload shapes.
