# Claude Capabilities Probe Plan Audit

Source plan: `docs/plans/2026-05-11-claude-capabilities-probe.md`

Dispatched 9 task auditors across 9 top-level tasks.

## Resolution Update

After user follow-up on 2026-05-11, the source plan was amended to support mid-session effort changes by restarting/resuming the Claude SDK query before the next turn. The Ask User item below is therefore resolved in the current source plan; the remaining audit bullets are retained as the original audit record.

## Result

- Amend Plan: 34 findings
- Ask User: 1 finding
- Accept: 0 findings

The plan is not ready for execution. Most findings are concrete plan amendments around the SDK probe shape, cache semantics, variant wiring, tests, and verification safety. One lifecycle decision is blocked on user input.

## Ask User

1. Task 8: Claude SDK `options.effort` is only set when a new long-lived SDK query is created. Later turns in an existing conduit session go through `enqueueTurn()` and ignore a changed `variant`.
   - Question: should effort changes apply only at SDK session creation, or should switching effort mid-session restart/fork/resume the Claude SDK session so later turns use the new effort?

## Amend Plan

### Task 1: TTL cache primitive

- Add generation/epoch handling so `invalidate()` invalidates pending lookups and stale resolutions cannot repopulate the cache.
- Store cached state as an explicit entry object so `undefined` can be cached safely, or explicitly forbid `undefined`.
- Add concurrent rejection coverage: multiple pending callers reject, `inFlight` clears, and a later call retries.

### Task 2: Capability probe function

- Fix fake SDK model type to include `supportedEffortLevels`.
- Use an empty/no-yield async iterable for the zero-turn probe if SDK initialization works with it; do not yield a query-triggering dummy user message.
- If any dummy message is unavoidable, use `shouldQuery: false` and test that no prompt message is yielded before initialization resolves.
- Replace `allowedTools: []` as the disabling mechanism with `tools: []`; keep `allowedTools` only if separately needed.
- Clarify that Task 2 only creates provider-side variant metadata; later tasks must map it through `model_list` and `variant_info`.
- Remove double casts to `SDKUserMessage` / `SDKOptions`; type options with `satisfies SDKOptions` or a direct SDK type.
- Add a test proving the probe submits no user turn while waiting for initialization.
- Fix stale test count text: the pasted file has 9 tests, not 7.

### Task 3: Cached probe singleton

- Add a prerequisite note: Task 3 requires Tasks 1 and 2 to have created `ttl-cache.ts` and `claude-capabilities-probe.ts`; direct execution from the current checkout otherwise fails with module-not-found.

### Task 4: Wire probe into `ClaudeAdapter.discover()`

- Add an explicit precondition that Task 1-3 files and probe testing exports exist before editing `ClaudeAdapter`.
- In `claude-adapter-discover.test.ts`, set a deterministic default probe override and reset cache state in top-level test setup so tests do not spawn the real Claude binary.
- Add fallback coverage for `{ models: [] }`.
- Add a direct guard that first `sendTurn()` no longer calls `query.supportedModels()`, or a static check requiring `dynamicModels`, `refreshModels`, `sdkModelToConduit`, and `query.supportedModels(` to be absent from `claude-adapter.ts`.

### Task 5: Regression check

- Add a send-turn regression asserting `supportedModels()` is not called.
- Move probe-call expectations to `claude-adapter-discover.test.ts`; lifecycle/send-turn tests should prove stale lazy refresh was removed.
- Replace deleted-symbol-only failure triage with deterministic source/test checks for old symbols and `supportedModels()` calls.

### Task 6: Forward `variants`

- State that the `dynamicModels` / `refreshModels` / `sdkModelToConduit` search applies after Task 4 cleanup.
- Add a `client-init.ts` bridge test for Claude variants.
- Assert user-visible `variant_info.variants`, not only `model_list.models[].variants`.
- Fix file list: `model.ts` and `client-init.ts` are modified files, not "verify only".

### Task 7: Claude-aware `switch_variant`

- Add a provider-aware variant resolver shared by `handleSwitchModel`, `handleSetDefaultModel`, and `handleSwitchVariant`; otherwise model/default switches can still clear Claude variants.
- Use per-test temp config directories for tests that persist default variants.
- Replace unsafe `wsMessages.find(...) as ...` casts with a `variant_info` type guard.
- Strengthen OpenCode regression: assert exact variant keys, `client.provider.list` call, and no Claude discovery dispatch.

### Task 8: Pass effort to SDK options

- Add explicit validation/guarding for `"low" | "medium" | "high" | "xhigh" | "max"` before passing `options.effort`; remove the incorrect `EffortLevel | number` statement.
- Rewrite test snippets to use actual helpers in `claude-adapter-send-turn.test.ts`.
- Add `variant: ""` coverage and invalid-string coverage for the chosen behavior.

### Task 9: Full verification gate

- Add a targeted real Claude probe smoke for the no-persistence/no-API path, with skip reason if local Claude binary/auth is unavailable.
- Add explicit `pnpm test:all` failure triage for `FAILED`, `FAIL`, `EADDRINUSE`, and `address already in use`; rerun failed suites before accepting a known flake.
- Replace global test-count heuristics with a manifest of expected new/changed test files and named cases.
- Delete or scope the final cleanup step; never use `git add -A` in this shared dirty worktree.

## Audit Files

- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-1.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-2.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-3.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-4.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-5.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-6.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-7.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-8.md`
- `docs/plans/audits/2026-05-11-claude-capabilities-probe-task-9.md`
