# Cursor hardening: make the six bug-hunt bugs hard to reintroduce

Date: 2026-10-23 (v2, after per-ticket design review against 44b2f331). Source: the Cursor bug hunt (six bugs) and
the architecture review (`architecture-review-20261023-104432.html`, candidates C1-C5).

Every ticket is red-first: write the failing test, watch it fail for the stated reason, then change code.
Implementation goes to `gpt-6.1-sol` at xhigh. Codex prompts must forbid `bd` writes. Line numbers are at 44b2f331.

## Baseline

- Local `main` was fast-forwarded to `wt/82tn-int` (44b2f331) on 2026-10-23. Everything lands on main. `origin/main`
  is 151 commits behind and not ours to push.
- The Run Ledger (`conduit-test-82tn.32`) has no runtime code yet: glossary, failure catalogue and red tests only.
  "Recovery" below means today's outbox, send journal and receipts.

## Beads

Epic `conduit-test-tuex`: C1 `tuex.1`, C3 `tuex.2`, C4 `tuex.3`, C5-A `tuex.4` (after C6), C5-B `tuex.5`, C6 `tuex.6`.
C2: slice 1 `huf4.1.1`, slice 2 `huf4.1.2` (blocked by `82tn.32.5`), slice 3 `huf4.1.3` (blocked by `82tn.32.6`).
Follow-ups: other providers write the typed tool outcome `s6td`, OpenCode title default `ksgu`, stable choice keys `hhsq`,
multi-root skills `pz5z`, trace recapture `ie7l`, Cursor usage URL `lnn1`. `jfi4` closed: `account.env` is
already blanked before the outbox payload is written (`orchestration-engine.ts:1306`).

## Bug to ticket map

| Bug | Ticket | Design that prevents recurrence |
|---|---|---|
| 4 stored login used against another backend (1 is already fixed on main) | C1 | Account resources are the only credential resolver; branded backend URL; redacted wire envelope |
| 2 recovered turn loses model params (Codex: effort, skill, revert, continuation prompt) | C2 | Recovery launches through prepare; required, tagged turn facts |
| 3 failed MCP/shell tool calls shown as success | C4 | `Known \| Unknown` tool calls; one Cursor tool-outcome module shared by live and reconcile |
| 5 title picker shows `combinations[0]` while the server sends the cheapest | C3 | One Model Parameter Choice module owns offered, resolve, cheapest |
| 6 skill list differs from what the SDK loads | C5 | Single owner: ask the SDK, or pin the rule with a differential test |

## Ownership principle

Each ticket ends with one writer per piece of state. Where a second owner is unavoidable (the SDK re-implements the
same rule), a contract test pins the copy to the original. The tables below are the target state.

## Order

All five can start now. Only these edges exist:

- C2 slice 2 waits for C2 slice 1, C3, and Run Ledger `82tn.32.5` (protocol version bump).
- C2 slice 3 waits for slice 2 and `82tn.32.6`.
- C5-A waits for C6 (shared skill location type); C5-B waits for C5-A.
- `s6td` waits for C4.

Suggested start: C1, C3, C4, C6, C2 slice 1 in parallel worktrees.

---

## C1 · Cursor Credential: one resolver, backend-checked (bug 4) · M

**Already on main** (do not redo): per-account SDK stores (`cursor-sdk.ts:9-19`), `CursorAccountResources`
(`cursor-account-resources.ts:81-90`), the prepare-time credential on the send command (`cursor-runner-driver.ts:580`),
the `scopedCursorCredentials` runner gate (`runner-protocol.ts:72,372-388`), and the account-env test
(`cursor-account-scopes.test.ts:52`). Bug 1 is fixed.

**Still wrong**

- Nothing reads `CURSOR_BACKEND_URL`; the fingerprint uses `stored?.backendUrl ?? ""` (`cursor-credential.ts:38`).
  Conduit passes `apiKey` explicitly, which skips the SDK's own backend check.
- `resolveCursorCredential` has six callers with four env-merge recipes: resources :83, `cursor-auth.ts:48`,
  `cursor-runner-payload.ts:544`, `cursor-runner-driver.ts:185,315,620`.
- `auth.read` uses `sdk.authStatus()` (`cursor-auth.ts:73`): no expiry or backend check, so it can say "logged in"
  for a login the turn will refuse.
- `{...credential, apiKey}` (`cursor-runner-driver.ts:580`, `cursor-provider-runtime.ts:105`) turns the
  non-enumerable key into a plain field, so any log of the send command contains it.

**Rules** (preserve what main pins)

1. Account `env.CURSOR_API_KEY`. An empty string means "no env key for this account" and falls to the stored login
   (`cursor-account-scopes.test.ts:91`).
2. Launch `process.env.CURSOR_API_KEY` only for the compatibility owner (`cursor-account-resources.ts:79-86`,
   pinned at `cursor-account-scopes.test.ts:462`). Never for other accounts: that would bring bug 1 back.
3. Stored login, only if unexpired and `login.backendUrl === activeBackendUrl` after stripping trailing slashes.
   Active backend: `CURSOR_BACKEND_URL ?? "https://api2.cursor.sh"`, matching the SDK (`pi` in `dist/esm/index.js`).

**Types**

```ts
type CursorBackendUrl = string & Brand<"CursorBackendUrl">;          // normalised once, at construction
type CursorCredentialFingerprint = string & Brand<"CursorCredentialFingerprint">;
type CursorCredentialOwner =
  | { readonly _tag: "Account"; readonly account: CursorAccount; readonly launchEnv: boolean }
  | { readonly _tag: "LoginSlot" };                                    // replaces "__cursor_login__"
type CursorCredentialLookup =
  | { readonly _tag: "Ready"; readonly credential: CursorCredential }
  | { readonly _tag: "LoggedOut" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "OtherBackend"; readonly loginBackendUrl: CursorBackendUrl; readonly activeBackendUrl: CursorBackendUrl };
// Wire: Schema.Struct({ fingerprint, backendUrl, apiKey: Schema.Redacted(Schema.String) })
```

`launchEnv` is set from the adoption marker, replacing the path-equality check at :79.

**Ownership after C1**

| State | Single writer | Readers |
|---|---|---|
| Effective key, fingerprint, lookup | `CursorAccountResources` (only caller of the pure resolver) | prepare, catalog cache, auth status, title |
| Active backend | daemon (resources, and the runner spawn env) | prepare; runner reports in hello, never decides |
| Stored login | SDK login in `sdk-real.ts` | resources only |
| Auth status | `cursor-auth.ts`, mapped from the lookup | UI |

**Changes**

- `resolveCursorCredential` becomes pure: `(envKey, stored, activeBackend, now) => CursorCredentialLookup`.
- `serviceOption(CursorAccountResources)` becomes required (`cursor-provider-runtime.ts:25`). Delete the driver and
  payload fallbacks (`cursor-runner-driver.ts:166-190` and :315/:620 paths, `cursor-runner-payload.ts:541-560`).
- `CursorRunnerDeps.credential` is required. A send-turn without the envelope is `turn_unprepared`.
- The daemon is the only owner of the active backend. The SDK reads `CURSOR_BACKEND_URL` once, at import
  (`executor-common.d.ts:5`), so a runner's backend is fixed by its spawn env. Today runners inherit the daemon's
  env (`process-session-runner.ts:1380`), so a runner spawned by an earlier daemon can disagree. Fix: the daemon sets
  `CURSOR_BACKEND_URL` explicitly in the runner spawn env, the runner reports it in hello, and a runner whose
  backend differs is retired for upgrade like a protocol mismatch. No per-turn check.
- `auth.read` and `replayCommandFields` (until C2 deletes it) map over the lookup union.
- Account-level `CURSOR_BACKEND_URL` is rejected at account validation: the SDK reads process env only.
- `OtherBackend` message tells the user that logging in replaces the stored login for the other backend.
- Guard test: `resolveCursorCredential(` appears only in `cursor-account-resources.ts`.
- CONTEXT.md: add **Cursor Credential** and **Credential Owner**.

**Red tests** (`test/integration/daemon/cursor-auth.test.ts`)

- B: stored login for another backend gives `auth_required` with the OtherBackend message; a trailing-slash variant
  of the same backend is `Ready`. Needs `CURSOR_BACKEND_URL` added to the `serviceEnvironment` allowlist in
  `test/helpers/process-harness.ts` (~690-746).
- C: the send command written to the runner log or trace does not contain the API key.
- D: auth status reports the OtherBackend error instead of "logged in".

**Will break**: `cursor-account-lifetime.test.ts:830` (fingerprint tuple). Check whether `title-generation.jsonl`
compares fingerprints. Paths: `test/unit/provider/cursor/cursor-run-ownership.test.ts`,
`test/e2e/provider/cursor-sdk-live.test.ts`.

**Risk**: fingerprints change once, so each agent reopens on the next turn and the catalog refetches. No restarts.

---

## C3 · Model Parameter Choice module (bug 5) · M

**Restated bug**: the server already sends the cheapest values for an empty title choice
(`cursor-runner-driver.ts:343-361`, pinned by `cursor-text-generation.test.ts:230`). The frontend shows the default
or `combinations[0]` (`model-parameters.ts:8-10`). The picker and the server disagree.

**Module** (`src/lib/provider/turn-settings.ts`; the frontend already imports it, contracts must stay implementation-free)

```ts
type ModelParameters = NonNullable<WireModelInfo["parameters"]>;
type ParameterChoiceKey = string & Brand<"ParameterChoiceKey">;      // joined label today; hhsq changes the encoding
type ResolvedChoice =
  | { readonly _tag: "Default"; readonly values: readonly ParamValue[] }   // [] when the model has no isDefault
  | { readonly _tag: "Chosen"; readonly key: ParameterChoiceKey; readonly values: readonly ParamValue[] };

export function modelParameterChoices(model: WireModelInfo): {
  offered(): readonly ParameterChoiceKey[];          // parameters.combinations, else legacy variants (Claude, OpenCode)
  resolve(choice: string): Result.Result<ResolvedChoice, ModelParametersUnavailable>;
  cheapest(): ResolvedChoice;                        // title default
  withValue(choice: string, rowId: string, value: string): ParameterChoiceKey | undefined;
};
```

**Rules**

- `""` is the storage encoding of `Default`. Validation never rewrites it: persisting the resolved key would pin
  users to today's default instead of following the provider's (`model.ts:820`).
- Models without `parameters` validate against `variants` as today. Claude and OpenCode effort keep working.
- No `isDefault`: turns get `Default{values: []}` and the provider chooses, as today.
- Titles: an empty title choice means `cheapest()`, on the server and in the picker. Saved `""` title choices keep
  their current meaning; no migration.
- `cheapest()` relies on the SDK listing each row cheapest-first. That is a captured contract for Cursor (ADR-0002).
  For Codex, verify the effort order against a capture or fall back to `Default`.
- A stale key has one outcome everywhere: `ModelParametersUnavailable{reason: "not-offered"}`. The handler that
  silently drops it (`model.ts:133`) surfaces it instead.

**Ownership after C3**

| State | Writer | Readers (all through the module) |
|---|---|---|
| Choice key | `SwitchVariant`, harness default, `SetTitleGeneration`, composer draft | `resolveTurnSettings`, prepare, text generation, picker |
| Choice to values | the module | everyone; nobody reads `combinations` or `isDefault` directly |

**Changes**

- Server: `resolveTurnSettings`, `offeredOptions`, `savedVariantFor`, Cursor prepare (`cursor-runner-driver.ts:553-563`),
  Cursor title block (:343-361), Codex prepare (`codex-runner-driver.ts:93-110`), Codex text generation
  (`codex-text-generation.ts:29,87`). Wire `variants` derivations move to `offered()`: `model-catalog.ts:58-64`,
  `handlers/model.ts:106-118,416`, `catalogFromProviderList` (`turn-settings.ts:244`).
- Frontend: `model-parameters.ts` becomes a presentation adapter over the module. Route `composer-settings.svelte.ts:134`,
  `VisibilitySettingsTab.svelte:78`, `ModelVariant.svelte:30`, `InstanceModelPicker.svelte:167-177`,
  `chooseModel` (`discovery.svelte.ts:1797`) through it. Title target (`title-model-selection-target.svelte.ts`
  :112-117, :189-195) displays `cheapest()` for an empty choice.
- Guard test: no `combinations` or `isDefault` reads outside the module and the discovery builders.
- CONTEXT.md: add **Model Parameter Choice**.

**Red tests**

- Acceptance (`features/cursor-model-parameters.feature`, new step in `acceptance/src/steps/cursorModelParameters.ts`):
  a fixture model whose `combinations[0]` is neither the default nor the cheapest; the title picker with an empty
  choice shows the cheapest. The current Grok fixture cannot tell `[0]` from cheapest.
- Unit: a Claude model with `variants` keeps its effort choice through `resolveTurnSettings`.
- `pnpm acceptance:visual` must pass; review any shifted `cursor-parameters-*` baselines.

**Will break**: `cursor-model-parameters.test.ts:246-248`, `turn-settings.test.ts`, `codex-turn.test.ts`, handler tests
asserting `variants` lists. `cursor-text-generation.test.ts:230` must stay green.

---

## C2 · Turn launcher: recovery re-prepares (bug 2) · children of `huf4.1`

**Still present on main**: Cursor recovery restores only `cursor.forkDigest` (`cursor-provider-runtime.ts:92`) and the
runner falls back to `?? []` (`cursor-runner-payload.ts:581-604`). Codex restores only the fork digest
(`codex-provider-runtime.ts:137`): effort, skill, `revertBeforeTurnId` (revert silently skipped), the continuation
prompt and the `instanceId` rewrite (`codex-runner-driver.ts:59-66,243`) are lost.

**Persistence rule**: freeze what an earlier attempt can change; recompute the rest. Prepare reads `input.*` plus the
current catalog, credentials and Daemon Settings, never session settings, so the user's model and variant are
already frozen in the outbox. Unjournaled rows never reached the provider, and Codex rewind removal waits for the
native revert (`orchestration-engine.ts:1327-1331`), so the revert target is still valid. A catalog that no longer
offers the variant fails with `model_parameters_unavailable`; stale params would fail at the provider anyway.

### Slice 1 (S/M, P1, interim until `82tn.32.13`)

- Recovery of unjournaled rows calls the driver's prepare. Delete `replayCommandFields`
  (`runner-command-recovery.ts:20-26`, `cursor-provider-runtime.ts:93-118`) and `providerStateKeys`; the fork digest
  already lives in provider_state (`runner-fork-digest.ts:32-35`).
- Re-resolve the account from the account directory before prepare (`account.env` is blanked in the outbox), as
  Claude recovery does (`claude-runner-recovery.ts:85-97`). Without this Codex prepares as signed out and drops
  effort and skill again, silently.
- Journaled rows reattach unchanged, never re-prepared: a since-logged-out Cursor would turn a reattach into
  `auth_required`. Read the untouched hello list from `connection.retainedSends` (`runner-protocol.ts:271,290`),
  not `pendingSendCommands`, which acks and recovery mutate.
- Prepare runs inside `replayTurn`/`withTurnEffect`, before the replay frame (`process-session-runner.ts:2180-2190`),
  so rows for one session keep their order.
- Re-prepared rows get a `pendingSends` cancellation entry like Claude's (:2312-2321), so Stop during prepare works.
- `auth_required` survives the ProviderInstanceFailure to SessionFailure mapping.
- Red tests: (a) `cursor-recovery.test.ts:697` recovered `model.params` equal the chosen variant; (c) recovered Codex
  effort kept; (d) recovered rewind issues `thread/revert`; (e) recovered Codex continuation sends the historical prompt.
- Will break: fake `recoverCommands` in runner-process-exit-run-ownership, runner-intake-lifetime,
  runner-observation-retirement, cursor-dispatch-interruption tests.

### Slice 2 (S/M, with `82tn.32.5`)

- `TurnFacts` is a Schema TaggedUnion keyed by driver, not per-driver generics (which would leak into
  `RunnerProviderInstance` and the process runner):
  - `Cursor{ model: Resolved{params} | SignedOut, forkDigest? }`
  - `Codex{ effort?, skill: None | Skill{...}, revert: None | Before{turnId}, prompt, forkDigest? }`
  - `Claude{}`
- Daemon side: send-turn commands carry a branded `PreparedTurn` that only `launchRunnerTurn` can build. Runner side:
  facts are required and decoded with Schema; missing is `turn_unprepared`.
- Compat rides the `RUNNER_PROTOCOL_VERSION` 5 bump in `82tn.32.5`. If it must ship earlier, copy the
  `scopedCursorCredentials` gate exactly (refuse non-retained sends, mark the runner for upgrade). An old runner
  ignores `facts`, so without the gate bug 2 returns silently.
- `cursor-session-config.ts`: `modelParams` required, delete `?? []`. Cursor model resolution uses C3.
- Red test (b): a variant that vanished between send and recovery fails with `model_parameters_unavailable`.
- Will break: codex-skills-fork and cursor-runner-live-sdk tests that read the old `providerState` keys.

### Slice 3 (with `82tn.32.6`)

Claude launch planning moves into the launcher. 32.6 rewrites the reactor's Claude path anyway, so do it there.

**Ownership after C2**

| State | Writer | Reader |
|---|---|---|
| User choice (model, variant, rewind, continuation) | admission, frozen in outbox | prepare |
| Turn facts (params, effort, skill, revert, prompt) | prepare, via `launchRunnerTurn` only | runner payload |
| Fork digest | `resolveRunnerForkDigest`, provider_state | prepare |
| Claude handoff | prepare, frozen via `json_set` | Claude recovery |

---

## C4 · Cursor tool outcome (bug 3) · M

**Facts checked**: 17 kinds in 1.0.40; `ToolType` is exported (`index.d.ts:14`); `imageData` is dead (the SDK's
generateImage converter returns `{filePath}` only). `complete()` has no `default`; `cursorToolInput` does (:174),
and it is what handles `generateImage` and `recordScreen` today. Unknown kinds are real: the delta decoder accepts
any string (`cursor-turn-events.ts:42`) and reconcile sees non-public kinds (`getMcpToolsToolCall` in
`subagent-reconcile.jsonl`).

**Module** (`cursor-tool-events.ts`)

```ts
type CursorToolCall =
  | { readonly _tag: "Known"; readonly kind: CursorToolKind; readonly call: KnownToolCall }
  | { readonly _tag: "Unknown"; readonly type: string; readonly raw: unknown };
type ToolOutcome = { readonly _tag: "Succeeded" } | { readonly _tag: "Failed"; readonly reason: string };

export function cursorToolOutcome(call: CursorToolCall): {
  toolName: string; input: unknown; outcome: ToolOutcome; result: unknown; metadata: Record<string, unknown>;
};
export function fromConversationStep(step: ProtobufStep): CursorToolCall | null;   // mirrors SDK converters
```

**Rules**

- Failed: error envelope; shell `timeout`, `rejected`, `spawnError`; shell exit code other than 0; MCP
  `value.isError === true`. This mirrors the SDK shell converter (`qI`) and MCP converter (`eR`).
- `assertNever` covers `Known` only. `Unknown` renders as a generic tool (ADR-0001: degrade one message, never end
  the turn). `assertNever` throws, so deleting the generic path would end turns on any new SDK kind.
- `fromConversationStep` returns `null` for non-public kinds, matching the live path and the SDK. Update
  `cursor-subagents.test.ts:289-298`, which expects three `getMcpTools` rows.
- `generateImage` and `recordScreen` get explicit cases that keep their current tool names (`cursor-tools.test.ts:39-40`).
- Live finish, subagent child finish (`cursor-turn-events.ts:646-659`) and reconcile (:798-821) all go through
  `cursorToolOutcome`. It is the only writer of `metadata.isError` in the Cursor adapter. The second vocabulary
  `metadata.outcome: "failed"` (:894-899) is derived from the same outcome.

**Typed outcome (pulled in from `s6td`)**: without this, failure keeps five owners downstream. `tool.completed` gets an
optional typed `outcome: "succeeded" | "failed"` (`stored-event.ts:622-635` already decodes `result` with a default;
use the same pattern). The decoder fills a missing `outcome` from legacy `metadata.isError === true`, so old events
need no migration. The Cursor adapter writes `outcome`; `metadata.isError` and `metadata.outcome: "failed"` are no
longer written. Every reader below reads `outcome` only and loses its own rule:
projector (`projectors-effect.ts:1316-1320`, gated on `cursorToolType`), history adapter
(`session-history-adapter.ts:188-195,365`), and four frontend readers (`ActivityRow.svelte:95`, `activity-style.ts:94`,
`turns.ts:423`, `ToolSubagentCard.svelte:119`). The projector's `cursorToolType` gate and the history adapter's
non-Cursor strip are deleted.

**Ownership after C4**: one writer per provider adapter, one typed field, every reader reads it. `s6td` then only
changes the other writers: Codex (`codex-item-mapper.ts:72,91`), Claude (`block.is_error` dropped at
`claude-event-translator.ts:1819-1830`), OpenCode (no flag at `opencode-runtime-event-translator.ts:686-691`).

**SDK version**

- `sdk-real.ts` exports `cursorSdkVersion()`, reading the resolved package's `package.json` from disk
  (`@cursor/sdk/package.json` is not an exported subpath).
- The capture writer stamps the real version (`sdk-trace.ts:72` stamps 1.0.37 under 1.0.40 today).
- Player and `check-cursor-sdk-traces.mjs` accept a declared `SUPPORTED_TRACE_VERSIONS` list, not any semver.
- Guard: the installed version must have at least one live-captured trace, or a README line saying why not. That keeps
  `ie7l` honest.

**Red tests**

- `tool-mcp-error.jsonl` (derived, labelled per README) in `cursor-tools.test.ts`, asserting part status `error` in
  the projected history, not only event metadata.
- `tool-generateImage.jsonl` corrected to `filePath`.
- `subagent-reconcile-failures.jsonl` in `cursor-subagents.test.ts`.
- A reconcile containing an unknown kind does not end the turn.
- `tool-unknown` and `turn-unknown-tool` stay green.

**Accepted gap**: projections rebuilt from stored events keep old MCP failures as `completed`.

**CONTEXT.md**: add **Tool Outcome**.

---

## C5 · Skill list: one owner (bug 6) · two tickets

**The SDK's actual rule in 1.0.40** (`dist/esm/331.js`, `OP`/`NP`): a local skill is kept only if the realpath of its
`SKILL.md` is under a realpath'd root:

- the workspace roots: the git toplevel of `cwd` when there is one root, else `[cwd, ...dirs]` deduplicated;
- `homedir()` when the `user` source is on;
- `~/.cursor/skills-cursor` only if managed sync succeeded (team source plus dashboard transport, network). Offline
  it is excluded.

Plugin skills are not filtered. The walker follows symlinked directories into their contents with no containment
check. Conduit sends `dirs = {workspaceRoot, ...extraFolders} - cwd` (`cursor-session-config.ts:33`).

So the v1 rule ("inside realpath(workspaceRoot) or homedir") was wrong in three ways: it ignores the git toplevel
when the session is in a repo subdirectory, it ignores extra folders, and conduit's "never the target's descendants"
(`cursor-skill-discovery.ts:150`) contradicts the walker. The test fixture's `linked` target sits inside the git
toplevel, so the SDK **would** load it. Removing `linked` would encode a new bug.

### C5-A (M): spike, then one owner

- Spike (half a day), costing two options:
  1. **Single owner**: a `listSkills` port method in `sdk-real.ts`, reaching `getAgentSkills` through the same private
     executor route `primeSandbox` already uses (`sdk-real.ts:425`), reusing the keyed executor cache that
     `prewarmLocalWorkspace` warms. Conduit's scanner is deleted. No boundary exemption.
  2. **Pinned copy**: keep conduit's scanner with the rule above, plus a differential test against the SDK.
  Verify that building the executor makes no network calls. If neither option works offline, commit a captured
  request context from a live run as the fixture.
- Prefer option 1 if the private route is stable enough to sit behind the port with a contract test. It removes the
  second owner instead of watching it drift.
- Types: internal `SkillRoot = workspace | nested | home | managed | plugin` with a table of which rule applies to each.
  Do not widen the wire `CommandSource` enum.
- Fixture: move one symlink target outside both git root and home and assert it is absent; keep an inside-repo
  positive control; decide `must-not-walk` from what the SDK does.
- Realpath `homedir()` too: on macOS a temp HOME under `/var` resolves to `/private/var`.
- Delete the `464.js` citation (`cursor-skill-discovery.ts:8`). Each 1.0.37 quirk comment (`cursor-questions.ts:81`,
  `sdk-real.ts:218,290,425`, `sdk-error.ts:103`, `cursor-tool-events.ts:20`, `cursor-turn-events.ts:277`) must cite a
  test row or be deleted. Leave `sdk-trace*` to C4.
- Extend the existing `test/e2e/provider/cursor-skills-real-sdk.test.ts` rather than adding live rows elsewhere.

### C5-B (S): credential rows, errors, upgrade wiring

- Credential rows pin only stored-login usability (backend match, expiry). Conduit always passes an explicit
  `apiKey` (`sdk-real.ts:113`), so the SDK's own precedence never runs in production. Observe the Authorization
  header against a loopback `CURSOR_BACKEND_URL` server, as child processes with a temp HOME.
- Conduit's empty-key fall-through is a deliberate difference from the SDK (which throws); a row records it.
- Error-class table test.
- If a test file must import the SDK, add a named, `test/**`-only allowance mechanism to
  `check-cursor-sdk-boundary.mjs` (it has none today).
- In the upgrade gate (`upgrade.mjs`, provider-sdk-upgrade `SKILL.md`), a missing SDK fails instead of skipping:
  `@cursor/sdk` is an optional dependency, so `skipIf` passes silently.
- ADR-0002 addendum: skill loading is local filesystem behaviour, not wire traffic; a real-SDK differential is the
  equivalent pin.

**Caveats**: integration tests run only in `npm-release.yml` (ubuntu), not on pull requests. The SDK's git toplevel
lookup caches for 5 seconds. Windows: the SDK compares case-sensitively; `path.relative` on win32 does not.

---

## C6 · Skill location: discovery is the only owner · M

**Problem**: three modules each decide where a skill lives.

- Discovery, per provider: Codex asks the app server (`skills/list`, `codex-discovery.ts`), Claude enumerates
  `<config dir>/skills` and `<workspace>/.claude/skills` (`claude-runtime-discovery.ts:111-162`), Cursor scans
  (`cursor-skill-discovery.ts`).
- Skill content (`handlers/skill-content.ts:15-18`) searches by name only in `<project>/.claude/skills` and
  `~/.claude/skills`. Opening a Cursor or Codex skill finds nothing, or a same-named Claude skill. A Claude account
  with its own config dir is ignored.
- `CommandInfo` (`types.ts:363-368`) carries no location, so the content lookup has to guess.

**Design**

- Discovery returns skills with a location. Internal type
  `DiscoveredSkill = { name; source; location: { _tag: "File"; path } | { _tag: "Provider" } }`; the wire
  `CommandInfo` gains only an opaque `skillRef` (not a path), so the browser cannot ask for arbitrary files.
- `GetSkillContentForSession` resolves `skillRef` through the session's provider capabilities, then reads with the
  existing realpath containment check against the root discovery recorded. `GetSkillContent` (project-scoped)
  goes through the default provider's discovery the same way.
- `skill-content.ts` loses its hardcoded roots.

**Red tests**: E2E: open a Cursor skill's content from the skills chip and see its SKILL.md; a Claude account with a
non-default config dir shows its own skill, not `~/.claude`'s.

**Coordination**: C5-A option 1 (SDK `listSkills`) produces `Provider` or `File` locations in this shape. Land C6
first or agree the type up front.

## Follow-ups

- `s6td` Codex, Claude and OpenCode write the typed `tool.completed` outcome (readers converge in C4).
- `ksgu` OpenCode title default (`opencode-provider-instance.ts:283-291`).
- `hhsq` stable choice keys by native values; two variants with the same joined label collapse today.
- `pz5z` multi-root skill scanning (may fold into C5-A option 1).
- `ie7l` live trace recapture on 1.0.40.
- Cursor usage URL hardcodes api2 (`cursor-usage.ts:76`).

## Remaining multiple owners, accepted

- Runner send list: `pendingSendCommands` (mutated) and `retainedSends` (hello snapshot) are two copies. C2 reads
  only `retainedSends`; the Run Ledger deletes the journal (`82tn.32.13`).
- Claude handoff: prepare rewrites admission's outbox row via `json_set`. Moves with C2 slice 3 into `82tn.32.6`.

## Open decisions

1. C5-A: if the spike shows the private `getAgentSkills` route works offline, adopt it (delete conduit's scanner)?
   Default: yes.
