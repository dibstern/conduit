# Audit Synthesis: Agent & Model Visibility Settings Plan

Plan: `docs/plans/2026-07-22-agent-model-visibility-settings.md`
Auditors: 6 (one per code-bearing task; Task 7 is verification-only). Per-task reports in `docs/plans/audits/2026-07-22-agent-model-visibility-settings-task-{1..6}.md`.

Totals: **8 Amend Plan** (after dedup), **2 Ask User**, ~25 Accept.

## Amend Plan

1. **[Tasks 2+5, dedup] Frontend transport barrel not updated.** `ws-rpc-client.ts` imports response types from `src/lib/frontend/transport/ws-rpc.ts` (hand-maintained re-export list), not from contracts. Neither task lists that file, so Task 5's `pnpm check` fails.
   → Add the barrel re-export of `SetHiddenEntriesResponse` (and request type if the barrel carries those) to Task 2's file list, steps, and `git add`.

2. **[Task 2] `RelayMessageSchema` union gap is runtime-only.** Frontend `effect-boundary.ts:52-65` throws `ProtocolDecodeError` for a known message type that fails schema decode; no compile-time link between the string list and the schema union, so forgetting `VisibilityInfoSchema` in `RelayMessageSchema` passes `pnpm check` but breaks all clients at runtime.
   → Add a decode assertion for a `visibility_info` message to `test/unit/schema/relay-message.test.ts` in Task 2 and run it.

3. **[Task 3] Wrong regression tests targeted; existing test breaks.** `test/unit/server/ws-rpc-agents.test.ts:32` uses `toEqual` on the whole GetAgents response — adding `hiddenAgents` breaks it. Plan's Step 6 runs `ws-rpc-default-model`/`ws-rpc-model-switch`, which don't cover the edited handlers.
   → Update `ws-rpc-agents.test.ts` expectations in Task 3 and switch the regression step to run `ws-rpc-agents.test.ts` + `ws-rpc-models.test.ts`.

4. **[Task 3] Test isolation.** `makeMockConfig` defaults `configDir: undefined`, so `getHiddenEntries` would read the developer's real `~/.conduit/settings.jsonc` in tests.
   → Tests touching the edited handlers must stub `ConfigTag` with a tempdir `configDir`.

5. **[Task 3] `Effect.sync` swallows fs failures as defects.** A `saveRelaySettings` throw becomes a defect that `Effect.catchAll` can't convert to `WsRpcError`. Repo pattern is `Effect.try` (`saveRelaySettingsEffect`, `src/lib/handlers/model.ts:41-48`).
   → Use `Effect.try` (or reuse/extract `saveRelaySettingsEffect`) in `setHiddenEntriesForRelay`.

6. **[Task 4] Missing tests for the RPC-reply hidden-state paths.** The new test file covers `handleVisibilityInfo` + getters but not the `applyGetModelsResponse`/`applyGetAgentsResponse` additions.
   → Add tests: responses with hidden fields populate state; responses omitting the fields leave state untouched.

7. **[Task 5] Wrong pattern pointer for the RPC helper.** Plan says copy `callSetLogLevel` (yields without return, discards response); the returning pattern is `callGetModels`/`callSetDefaultModel`. Inline snippet is already correct.
   → Retarget the reference.

8. **[Task 6] `showToast` call fails typecheck.** Second arg is an options object and `"error"` is not a `ToastVariant` (`"default" | "warn"`).
   → Use `showToast("Failed to save visibility settings", { variant: "warn" })`.

## Ask User

A. **[Task 6] `visibilityBusy` guard silently drops rapid toggles** and desyncs checkboxes from state. Options: disable inputs while busy, or drop the guard entirely (each RPC sends the absolute list, so last-write-wins is safe).

B. **[Task 6] Native `<input type="checkbox">` vs the panel's `ToggleSetting` component/theming.** Native checkboxes will look unstyled next to the rest of the settings panel.

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| 1. Transport barrel not updated | 2 (+5) | Added `src/lib/frontend/transport/ws-rpc.ts` to Files; new Step 2a re-exports `SetHiddenEntriesResponse`; added to `git add`; Task 5 import retargeted to the barrel |
| 2. RelayMessageSchema runtime gap | 2 | New Step 3a: decode regression test in `test/unit/schema/relay-message.test.ts`; run added to Step 4; CRITICAL note on the union |
| 3. Wrong regression tests / breaking test | 3 | `ws-rpc-agents.test.ts` added to Files with `toEqual` update instruction; Step 6 now runs `ws-rpc-agents` + `ws-rpc-models`; both added to `git add` |
| 4. Test isolation vs real ~/.conduit | 3 | Warning added: all handler tests must stub `ConfigTag` with a tempdir `configDir` (`makeMockConfig` defaults to undefined) |
| 5. Effect.sync defect swallowing | 3 | Snippet changed to `Effect.try` with rationale comment; points at `saveRelaySettingsEffect` pattern |
| 6. Missing RPC-reply state tests | 4 | Three test cases added: hiddenModels/hiddenAgents population + omitted-fields-leave-state-untouched guard |
| 7. Wrong pattern pointer | 5 | Reference retargeted from `callSetLogLevel` to `callGetModels`/`callSetDefaultModel` |
| 8. showToast signature | 6 | Changed to `showToast("...", { variant: "warn" })` with signature note |
| A. Toggle races (user: drop guard) | 6 | `visibilityBusy` removed; comment documents last-write-wins rationale |
| B. Checkbox style (user: ToggleSetting) | 6 | Markup rows switched to compact `ToggleSetting`; instruction to read the component's props first |

## Re-audit (loop 2) — PASSED

Three verifiers over the amended tasks (2+5, 3, 4+6). All 10 amendments confirmed resolved against real source. Three residual minor snippet/pointer fixes applied inline and verified by inspection:
- Step 3a test sketch now uses the file's `Schema.decodeUnknownEither` + `Either.isRight` idiom.
- Task 3 `ConfigTag` import pointer retargeted to `../domain/relay/Services/services.js` (first direct reader in that file; tag confirmed present in the layer env).
- `ws-rpc-models.test.ts` confirmed to need no expectation changes (per-field assertions).

Notable confirmations: inline `Effect.try` beats exporting the module-private `saveRelaySettingsEffect`; `ToggleSetting` props match plan markup exactly; `ToastVariant` fix valid. Remaining notes are Accept-level only. **Audit clean.**

## Accept (informational highlights — no plan change)

- Task 1 fully clean; merge semantics and tests verified against real code.
- `ConfigTag` already available in the server RPC handler environment; `broadcast` accepts the new message type once the union is extended.
- `.svelte.ts` store imports in vitest confirmed by `test/unit/stores/discovery-store.test.ts` precedent; ws-dispatch switch has a permissive `default` (no exhaustiveness break).
- Readonly `Schema.Array` → mutable spread typing checks out everywhere it's used.
- Only the two selectors consume the raw lists; other consumers are legitimate full-list lookups.
- Broadcast echo after optimistic update is idempotent; stale-GetModels-overwrites-broadcast race is low-severity and self-healing.
