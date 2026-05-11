# Claude Subscription + 1M Context Plan Audit

Source plan: `docs/plans/2026-05-11-claude-subscription-1m-context.md`

Dispatched 6 task auditors across 6 top-level tasks.

## Resolution Update

After user follow-up on 2026-05-11, the source plan was amended to use t3code's effective model-id suffix (`"<model>[1m]"`) and live `query.setModel(...)` switching instead of a creation-only `betas` header. The Ask User item below is therefore resolved in the current source plan; the remaining audit bullets are retained as the original audit record.

## Result

- Amend Plan: 29 findings
- Ask User: 1 finding
- Accept: 0 findings

The plan is not ready for execution. Main problems are PR1 base-state assumptions, shared relay schema gaps, incomplete WebSocket/router wiring, stale context-window state on model/session changes, long-lived Claude query lifecycle, frontend source-of-truth ambiguity, and unsafe verification/staging steps.

## Ask User

1. Task 4: Claude SDK `betas` are supplied only when `query()` is created. Later turns normally reuse the existing SDK query, so selecting `1m` after the first turn will not apply the beta header.
   - Question: is context window latched at SDK session creation, should `switch_context_window` end/recreate the provider session, or should the selector be disabled once a Claude query exists?

## Amend Plan

### Task 1: Probe result + context-window options

- Add a PR1 preflight: execute only on top of PR1 after `claude-capabilities-probe.ts`, `ttl-cache.ts`, and probe tests exist.
- Replace broad Sonnet-family matching with `supportsOneMillionContext(modelId)` that explicitly allows Sonnet 4 / Sonnet 4.5 IDs or documented aliases.
- Add `ContextWindowValue = "200k" | "1m"` and type `ContextWindowOption.value` with it.
- Add negative coverage for unsupported older Sonnet-shaped IDs; add a positive alias test only if a bare alias is intentionally mapped to Sonnet 4/4.5.

### Task 2: Forward options through `model_list`

- Add shared relay type/schema wiring: `ContextWindowOption`, `ModelInfo.contextWindowOptions`, nested `ProviderInfoSchema`, and a relay schema decode test proving the field is preserved.
- Add a `client-init.ts` test for initial `model_list` payloads containing Claude `contextWindowOptions`.
- Add a PR1 preflight for variants forwarding and the expected handler test harness.
- Make test fixtures strict with `satisfies AdapterCapabilities`; do not use loose placeholder casts.

### Task 3: Per-session override + WebSocket plumbing

- Add `switch_context_window` to `src/lib/server/ws-router.ts` and router property tests.
- Add `SwitchContextWindowMsg` to `src/lib/effect/ws-message-schemas.ts` and coverage tests.
- Add `context_window_info` to `RelayMessageSchema`, not only the manual union.
- Emit `context_window_info` when model/options are refreshed: `handleGetModels`, client init, session metadata/session switch paths as appropriate.
- Clear or normalize stale `contextWindow` overrides when switching to a model that has no matching options, or make the adapter defensively ignore incompatible values.
- Define no-active-session behavior for `switch_context_window`; do not copy variant's global default unless adding and testing a `defaultContextWindow`.
- Add direct tests for imperative and Effect session override stores.

### Task 4: SDK `betas` header

- Add a prompt-handler test proving `overrides.getContextWindow(activeId)` is copied into `SendTurnInput`.
- Rewrite negative adapter tests so absent and `"200k"` cases create fresh SDK queries with full `SendTurnInput` values.
- Replace the beta-header array cast with a typed SDK literal constant.
- Update shared handler mock factories with context-window override methods.

### Task 5: Frontend selector

- Choose one source of truth for options. Preferred: derive `getActiveContextWindowOptions()` from `getActiveModel()?.contextWindowOptions ?? []`; keep `currentContextWindow` as selected override state.
- Make three-dropdown coordination concrete in `ModelSelector`: model dropdown, `ModelVariant`, and `ContextWindowSelector` must close each other.
- Specify context-window selection display semantics: current option falls back to model default; clicking default should clear override or explicitly send default value per chosen policy.
- Ensure `ContextWindowOption` is exported through shared/frontend types before frontend store/component imports.
- Add automated coverage: discovery-store tests, story/visual states, dropdown mutual exclusion, and E2E/component test for `switch_context_window`.

### Task 6: Verification gate

- Replace the fake focused variant commands with the real variant Playwright gate, e.g. `pnpm build:frontend && pnpm exec playwright test --config test/e2e/playwright-variant.config.ts`, plus context-window selector coverage.
- Replace missing `test/unit/handlers/switch-variant.test.ts` with real new handler/schema files.
- Include prompt-handler handoff coverage in focused verification.
- Tighten `EADDRINUSE` handling: identify failed suite, confirm exact known failure, clean/free port where practical, rerun failed suite.
- Replace `git add -A` with scoped staging of intended files only.

## Audit Files

- `docs/plans/audits/2026-05-11-claude-subscription-1m-context-task-1.md`
- `docs/plans/audits/2026-05-11-claude-subscription-1m-context-task-2.md`
- `docs/plans/audits/2026-05-11-claude-subscription-1m-context-task-3.md`
- `docs/plans/audits/2026-05-11-claude-subscription-1m-context-task-4.md`
- `docs/plans/audits/2026-05-11-claude-subscription-1m-context-task-5.md`
- `docs/plans/audits/2026-05-11-claude-subscription-1m-context-task-6.md`
