---
name: provider-sdk-upgrade
description: Upgrade conduit's provider SDKs contract-first, one slice per provider - the Claude Agent SDK with its transitive @anthropic-ai/sdk, and the OpenCode SDK with its matching server binary. Use when asked to bump, update or upgrade a provider SDK, or when a provider release adds models or fields conduit needs.
---

# Provider SDK upgrade

Conduit's **Provider Contract** (`src/lib/contracts/providers/*`) hand-describes every shape conduit reads from a provider SDK: compile-time `AssertExtends` conformance plus fail-closed Effect Schema decoders. An upgrade is **contract-first**: audit what the new types changed, then move the pins, then prove the contract against the installed SDK and the live runtime. The design and its strictness policy live in `docs/plans/2026-06-26-provider-version-upgrade/spec.md`; read it when a change goes beyond a version move.

Each provider is a **slice** with its own audit, pins and smoke:

| slice | pins | live runtime |
|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` (exact, `package.json`); `@anthropic-ai/sdk` (`overrides` in `pnpm-workspace.yaml`) | the Claude Code CLI bundled in the SDK |
| OpenCode | `@opencode-ai/sdk` (exact, `package.json`); `.opencode-version` | the `opencode` server on PATH |

`test/unit/contracts/providers/sdk-version-lock.test.ts` asserts every pin, so each bump edits its expectations too.

Work in a worktree, with a bead claimed per the repo's `CLAUDE.md`. Scratch goes under `/tmp/sdk-upgrade/`.

## 1. Pick targets

`npm view <pkg> version` for `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `@opencode-ai/sdk` and `opencode-ai`. The OpenCode SDK and server release together; target the same version for both.

pnpm enforces a one-day `minimumReleaseAge`. Check `npm view <pkg> time --json` for each target: installing a release under a day old makes pnpm append `minimumReleaseAgeExclude` entries to `pnpm-workspace.yaml` (11 entries for the Claude SDK's per-platform binaries plus the others). When any target is that fresh, ask the user: commit the entries, wait a day, or step back one release. Delete entries left by earlier bumps; they name versions no longer installed.

Done when every target version is written in the bead.

## 2. Audit the type surface

Before installing, fetch both versions of each package into scratch (`npm pack <pkg>@<version> --pack-destination <dir>`, then `tar -xzf`) and diff them by declaration:

```bash
python3 -I .agents/skills/provider-sdk-upgrade/scripts/dts-diff.py <old>/package/sdk.d.ts <new>/package/sdk.d.ts  # Claude
python3 -I .agents/skills/provider-sdk-upgrade/scripts/dts-diff.py <old>/package/dist <new>/package/dist          # OpenCode
```

Map each changed declaration onto the contract and classify it:

- **Additive** (new optional field, widened union conduit doesn't mirror): no contract change; the decoders ignore excess properties.
- **New variant or subtype** of something conduit enumerates (`CLAUDE_SDK_MESSAGE_VARIANTS`, the subtype unions, `OPEN_CODE_CONSUMED_EVENT_TYPES`): add it, keeping `CLAUDE_SDK_OMITTED_MESSAGE_VARIANTS` empty or recording the omission.
- **Removed, renamed or narrowed** on a field conduit reads: a contract and adapter change, in this slice.

Done when every changed declaration has a class, and the summary is in the bead.

## 3. Move the pins

Edit the pins in the table, the version-lock test expectations, and the version named in `pnpm-workspace.yaml`'s override comment. Then `pnpm install` and `pnpm check`. Compile errors in the contract files are the contract drifting; fix them per the spec's strictness policy.

## 4. Check the model catalogs

Model ids come from the providers, never from a conduit list.

- **Claude:** run `node .agents/skills/provider-sdk-upgrade/scripts/claude-catalog.mjs <sdk.mjs>` against the old version (`npm install --prefix /tmp/sdk-upgrade/claude-old <pkg>@<old>`) and the new one in `node_modules`, and compare. Check each new id survives `normalizeModelId` and has a context-window row in `src/lib/provider/claude/claude-api-model-id.ts`. Test models must be ids the catalog lists: `haiku` is listed, bare `claude-haiku-4-5` never was.
- **OpenCode:** `opencode models opencode` must still list the model in `test/contract/helpers/session-helpers.ts`.

## 5. Run the gates

```bash
pnpm lint
pnpm test:unit
npm install --prefix /tmp/sdk-upgrade/oc opencode-ai@<version>
env PATH="/tmp/sdk-upgrade/oc/node_modules/.bin:$PATH" pnpm test:contract
pnpm build
RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
  test/e2e/provider/claude-runner-real-sdk.test.ts \
  test/e2e/provider/claude-provider-instance-real-sdk.test.ts
```

- The contract suite spawns the first `opencode` on PATH and requires its version to equal `.opencode-version`, which is why it runs against the exact npm build rather than the brew one.
- The real-SDK tests spend real tokens with the reviewer's login; the runner test runs `dist/`, hence the build. `test/setup.ts` hands `CLAUDE_CONFIG_DIR` to them as `CONDUIT_TEST_REAL_CLAUDE_CONFIG_DIR`.
- An auth failure ("OAuth session expired") is the login, not the bump. Confirm by running one turn directly against the new SDK outside the harness, then ask the user to log in. Leave credentials and keychains alone.
- For any other failure, run the same test on an untouched worktree at the base commit. Fixing what fails there too is a separate bead.

Done when every gate is green, or each red one is shown to fail on the base too and has a bead.

## 6. Record and land

Write the evidence into the bead: versions old to new, the bundled `claude_code_version`, the audit summary, catalog changes, and each gate's result. Commit as `chore(deps): bump Claude Agent SDK <v> and OpenCode SDK <v> (<bead>)`. The local daemon runs the brew `opencode`; `just update-harnesses` in `~/dotfiles` upgrades it.

---

Maintenance: before editing this skill, read [`history/README.md`](history/README.md).
