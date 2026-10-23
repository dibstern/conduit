---
name: provider-sdk-upgrade
description: Upgrade conduit's provider SDKs contract-first, one slice per provider - the Claude Agent SDK with its transitive @anthropic-ai/sdk, the OpenCode SDK with its matching server binary, and the Cursor SDK with its platform helpers. Use when asked to bump, update or upgrade a provider SDK, or when a provider release adds models or fields conduit needs.
---

# Provider SDK upgrade

Conduit's **Provider Contract** (`src/lib/contracts/providers/*`) hand-describes every shape conduit reads from a provider SDK: compile-time `AssertExtends` conformance plus fail-closed Effect Schema decoders. An upgrade is **contract-first**: audit what the new types changed, then move the pins, then prove the contract against the installed SDK and the live runtime. The design and its strictness policy live in `docs/plans/2026-06-26-provider-version-upgrade/spec.md`; read it when a change goes beyond a version move.

| slice | pins | live runtime |
|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` (exact, `package.json`) | the Claude Code CLI bundled in the SDK |
| `anthropic` | `@anthropic-ai/sdk` (`overrides` in `pnpm-workspace.yaml`, plus the Claude version its comment names) | none; reaches conduit only through the Claude SDK's types |
| `opencode` | `@opencode-ai/sdk` (exact, `package.json`); `.opencode-version`, always the same version | the `opencode` server on PATH |
| `cursor` | `@cursor/sdk` and its five `@cursor/sdk-<platform>` helpers (exact, `optionalDependencies` in `package.json`); no transitive overrides | the SDK's local Node runtime, driven by the detached session runner |

`test/unit/contracts/providers/sdk-version-lock.guard.test.ts` asserts every pin.

`scripts/upgrade.mjs` does every mechanical step and prints the next command; your job is the judgment between them. Work in a worktree, with a bead claimed per the repo's `CLAUDE.md`. Run from the worktree root:

```bash
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
U=.agents/skills/provider-sdk-upgrade/scripts/upgrade.mjs
```

State lands in `/tmp/sdk-upgrade/` (`targets.json`, `audit-<slice>.txt`, `catalog.json`, `gates.json`, `gates/<name>.log`).
Run node and pnpm through `mise exec --` (the repo pins Node 26). `--only <slice>` limits every command to one slice; the printed next commands keep it. `--scratch <dir>` moves the state elsewhere when another upgrade is using `/tmp/sdk-upgrade`.

## 1. Pick targets

`node $U targets [--claude V] [--anthropic V] [--opencode V] [--cursor V]` defaults each slice to npm's latest, and confirms the matching `opencode-ai` server release exists.

A Cursor target also checks that the SDK release names its five platform helpers at the same version.

pnpm refuses releases younger than its `minimumReleaseAge` (one day) unless `pnpm-workspace.yaml` lists them under `minimumReleaseAgeExclude`, which `pnpm install` then writes for you (11 entries for a Claude bump). When the table marks a target **FRESH**, ask the user: commit those entries, wait, or step back a release with `--<slice>`. Exclude entries from earlier bumps are listed as stale; `pin` deletes them.

Done when the target versions are in the bead.

## 2. Audit the type surface

`node $U audit` diffs each bumped Claude and OpenCode SDK's declarations against the current version, grouped by declaration and tagged:

- `[comment]` (doc changes only) and `[additive]` (only new optional members): no contract change; the decoders ignore excess properties. Skim them.
- `[review]`: everything else. Read each against the contract:
  - **New variant or subtype** of something conduit enumerates (`CLAUDE_SDK_MESSAGE_VARIANTS`, the subtype unions, `OPEN_CODE_CONSUMED_EVENT_TYPES`): add it, keeping `CLAUDE_SDK_OMITTED_MESSAGE_VARIANTS` empty or recording the omission.
  - **Removed, renamed or narrowed** on a field conduit reads: a contract and adapter change, in this slice.
  - Anything else conduit doesn't read: no change.
- `[contract]`: the declaration's name appears in a contract file. Read these first. It is a whole-word match, so common names can be false hits.

Cursor's contract is `src/lib/provider/cursor/sdk-port.ts`: every SDK call crosses it, and `sdk-real.ts` and `sdk-trace-player.ts` implement it. `audit` diffs `dist/esm` and marks names used in the port or the player. A changed SDK call means changing both adapters together. `audit` cannot see one private call: `primeSandbox` in `sdk-real.ts` calls the agent's internal `getExecutor()` to prime the sandbox without a billable send. Confirm it still exists in the new `dist/esm`; if it is gone, every turn fails with "Cursor SDK sandbox initialization API changed".

Done when every `[review]` group has a class, and the summary is in the bead.

## 3. Move the pins

`node $U pin` rewrites every pin, the override comment and the version-lock test literals, and deletes stale excludes. It checks every edit before writing any, so a failure means a file's layout changed: fix the script, not the file. Then `pnpm install` and `pnpm check`. Compile errors in the contract files are the contract drifting; fix them per the spec's strictness policy.

For Cursor, `pin` moves the SDK and its five helpers (`optionalDependencies`) together; `--dry-run` previews. It refuses to run without `publicHoistPattern: '@cursor/sdk-*'`: the SDK finds `cursorsandbox` and `rg` by walking up from the runner entry, and the availability probe in `sdk-real.ts` reports a missing one.

## 4. Check the model catalogs

`node $U catalog` compares the Claude catalog before and after the bump, using your real login, and checks the OpenCode contract model on an isolated, logged-out home. It exits 1 when that model is missing.

- **Added or removed Claude ids:** model ids come from the providers, never from a conduit list. Test models must be ids the catalog lists: `haiku` is listed, bare `claude-haiku-4-5` never was.
- **`GAP <id>`:** no context-window row in `src/lib/provider/claude/claude-api-model-id.ts`. Add one when the id is a real model with a known window; aliases and gateway ids can stay gaps. Note which in the bead.
- **OpenCode `MISSING`:** pick a free model from the listed catalog for `test/contract/helpers/session-helpers.ts`.
- **Cursor `MISSING`:** the catalog runs conduit's own discovery with `CURSOR_API_KEY`, else the SDK login. It checks the model ids in `test/integration/daemon/cursor-discovery.test.ts` (`composer-2.5`, also in the trace fixtures); pick a listed replacement if one retires.

## 5. Run the gates

`node $U gates` runs check, lint, unit and contract; `--live` adds build and the real-SDK E2E tests, which spend real tokens with your login. `--dry-run` prints the commands. Every gate runs even after one fails; failing logs' tails are printed.

Cursor's `cursor-sdk-contract` gate always runs the offline real-SDK skill differential,
stored-login credential rows and error-class/code table in `test/e2e/provider/cursor-{skills,credentials,errors}-real-sdk.test.ts`.
Credential rows compare only backend match and expiry, observing Authorization at a loopback
`CURSOR_BACKEND_URL` in child processes with a temporary HOME. Conduit passes its resolved key
explicitly; SDK key precedence is outside this contract. The empty-key row pins Conduit's
deliberate fall-through where the SDK throws. The paid skill-activation smoke stays opt-in.
The gates require the installed `@cursor/sdk` optional dependency even with `--dry-run`;
a missing SDK is a failure. Run these rows on every Cursor upgrade, without `--live`.

- The contract suite needs the exact npm `opencode` build matching `.opencode-version` first on PATH, not the brew one; the script installs and checks it.
- An auth failure ("OAuth session expired") is the login, not the bump. Confirm by running one turn directly against the new SDK outside the harness, then ask the user to log in. Leave credentials and keychains alone.
- For any other failure, run the same gate on an untouched worktree at the base commit (`node $U gates --root <that worktree>`). Fixing what fails there too is a separate bead.
- Cursor's gates replay the trace fixtures (`test/fixtures/cursor-sdk-traces/README.md`) through the port, so they need no credential. The fixtures, the capture stamp in `sdk-trace.ts`, the player and `scripts/check-cursor-sdk-traces.mjs` all say SDK `1.0.37`; before capturing on a new version, move all four together.
- Cursor `--live` also lists models against the real service, and needs `CURSOR_API_KEY`. "Cursor has no credential" is a missing key or an expired login, not the bump. "Cursor model list failed" is auth, network or SDK drift: if replay passes and live fails on the base too, it is the credential. Ask the user to renew it; leave the login store alone.

Done when every gate is green, or each red one is shown to fail on the base too and has a bead.

## 6. Record and land

Write the evidence into the bead: versions old to new, the bundled `claudeCodeVersion` from `catalog.json`, the audit summary, catalog changes, and each gate's result. Commit as `chore(deps): bump Claude Agent SDK <v> and OpenCode SDK <v> (<bead>)`. The local daemon runs the brew `opencode`; `just update-harnesses` in `~/dotfiles` upgrades it.

A Cursor-only bump commits as `chore(deps): bump Cursor SDK <v> (<bead>)`.

---

Maintenance: before editing this skill, read [`history/README.md`](history/README.md).
