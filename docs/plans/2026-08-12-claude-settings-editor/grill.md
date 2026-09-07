# Grill: Claude settings.json editor in conduit's settings panel

Goal (as stated): let conduit edit the Claude Agent SDK `settings.json` from the settings
panel, with a dropdown or input per setting — starting with autocompact and the settings
used by `~/dotfiles` for `ccw1`, `ccp`, etc.

## Ground truth gathered before round 1

**Conduit today**
- `SettingsPanel.svelte` (`src/lib/frontend/components/overlays/SettingsPanel.svelte`) has five
  tabs: Alerts, Theme, Agents & Models, Instances, Debug. Svelte 5 runes, hand-rolled fields,
  no form library.
- Three persistence pipelines: browser `localStorage` (theme/notifs/flags); relay settings via
  @effect/rpc → `~/.conduit/settings.jsonc`; instances/projects via relay → daemon IPC →
  `~/.conduit/daemon.json`. There is **no per-project conduit config file**.
- Claude SDK options are built once per `query()` in
  `src/lib/provider/claude/claude-provider-runtime.ts:900` with `settingSources:
  ["user","project","local"]`, `settings: { showThinkingSummaries: true }`, and `env` from
  `claude-sdk-env.ts` (sets `CLAUDE_CONFIG_DIR` when the instance has a `configDir`).
  Only `permissionMode` can change mid-session; everything else needs a session reload
  (`src/lib/handlers/reload.ts` → `end_session`).
- `src/lib/contracts/providers/claude-agent-sdk.ts` already mirrors the SDK `Options` type as
  Effect schemas with compile-time keyof checks — the natural plug-in point.

**Dotfiles today**
- `ccw1`/`ccw2`/`ccp`/`cce` are zsh functions that set `CODEX_HOME` and call
  `ccs <account> --enable-auto-mode`. ccs sets `CLAUDE_CONFIG_DIR=~/.ccs/instances/<account>`,
  so the user-scope settings file per lane is `~/.ccs/instances/{work,personal,extra}/settings.json`.
  `ccw1` and `ccw2` share the same settings file.
- All three instance files and `~/.claude/settings.json` render from one chezmoi template,
  `home/.chezmoitemplates/claude-settings.json`. Keys in use: `attribution`,
  `includeCoAuthoredBy`, `permissions.defaultMode`, `model`, `hooks`, `statusLine`,
  `enabledPlugins`, `extraKnownMarketplaces`, `effortLevel`, `pluginConfigs`, `outputStyle`,
  `skipWorkflowUsageWarning`, `verbose`, **`autoCompactEnabled`**, **`autoCompactWindow`**,
  `switchModelsOnFlag`, `remoteControlAtStartup`, `tui`, `theme`, `agentPushNotifEnabled`.
- Instance files use chezmoi's `create_` prefix — write-once, so `chezmoi apply` never
  clobbers them, but `just refresh-ccs-settings` re-renders and **discards runtime edits**.
  `~/.claude/settings.json` is a plain template + bidirectional-listed; hand edits round-trip
  badly.

## Explore: which settings.json keys the Agent SDK actually honours

The SDK ships the full Claude Code binary and spawns it, so `settingSources` feeds the same
merge engine as the CLI. Nothing is dropped at parse time — verified by calling the SDK's own
exported `resolveSettings()` against this machine; every key in the dotfiles template resolves,
with provenance. The discriminator is whether the *consuming feature* exists headless.

- **Honoured by SDK sessions**: `model`, `permissions.*`, `hooks`, `env`, `disableAllHooks`,
  `apiKeyHelper`, `effortLevel`, `alwaysThinkingEnabled`, **`autoCompactEnabled`**,
  **`autoCompactWindow`** (100k–1M), `cleanupPeriodDays`, `attribution` /
  `includeCoAuthoredBy` (latter deprecated), `enabledPlugins`, `extraKnownMarketplaces`,
  `pluginConfigs`, `forceLoginMethod`.
- **CLI/TUI-only**: `statusLine`, `theme`, `tui`, `verbose`, `spinnerTipsEnabled`,
  `remoteControlAtStartup`, `agentPushNotifEnabled`.
- **Flagged, unverified**: `outputStyle`, `switchModelsOnFlag`, `skipWorkflowUsageWarning`.

Three mechanics that drive the design:

1. **Precedence, low → high: `user < project < local < flag < managed policy`.** The SDK's
   `settings` option (`string | Settings`) is the *flag* layer, so it beats all three files.
   Conduit already occupies it with `settings: { showThinkingSummaries: true }`.
2. **The flag layer replaces whole top-level keys.** Sending `{ permissions: {...} }` discards
   the file's entire `permissions` object; `null` clears a key back to the file value.
3. **Settings are read once at `query()` creation — there is no `reloadSettings`.** File edits
   need a session reload. `query.applyFlagSettings()` changes the flag layer live, mid-session,
   but is documented as streaming-input-mode only.

Also: `resolveSettings()` runs the real merge engine without spawning the CLI, returning the
effective value plus per-key provenance — the honest way to show "inherited" values in the UI.
Caveats: it does not execute `policyHelper`, and reports `permissions.defaultMode` unfiltered
(pipe through `filterEscalatingDefaultMode`).

## Rounds

### Round 1 — resolved

**Fork 1 — what is the panel for? → A + D: control conduit's own Claude sessions, via a
conduit-owned flag layer.** Terminal persistence is explicitly a non-goal; conduit does not
write the user's `settings.json`. The hard requirement attached to this choice: **conduit's own
settings must persist across sessions.** Options rejected: B (remote editor for the config
files) and C (both, badged) — no interest in driving the terminal lanes; E (preset profiles) —
too coarse.

Consequence: the CLI-only key list above is out of scope entirely. The panel covers only keys
that change a conduit session.

**Question 2 — chezmoi ownership → (a), which under Fork 1 D collapses to "not applicable".**
Conduit never writes a chezmoi-managed file, so `just refresh-ccs-settings` cannot wipe its
state and no promote-back-to-template mechanism is needed. The files remain read-only input to
the merge, visible in the UI as inherited values.

**Question 3 — coverage → (b): scalars plus `permissions.allow` / `deny` / `ask` list
editors.** Nested config (`hooks`, `enabledPlugins`, `extraKnownMarketplaces`,
`pluginConfigs`) is out of the first cut.

**Decided without asking** (assumptions, logged per the skill's Decide rule):

- Validation reuses the existing Effect schemas in
  `src/lib/contracts/providers/claude-agent-sdk.ts`, which already keyof-check against the real
  SDK `Options` type.
- Changes broadcast to other connected browsers using the existing `visibility_info` pattern in
  `src/lib/handlers/visibility.ts` (optimistic local write, absolute values, last-write-wins).

### Explore: conduit's flag-layer seams

- **Streaming input mode, confirmed.** `claude-provider-runtime.ts:382` types the prompt as
  `AsyncIterable<SDKUserMessage>` and `:927` passes the Effect prompt queue. One `query()` per
  *session*, not per turn. `applyFlagSettings()` is therefore available.
- **Precedent already exists.** Commit `d1e162b4` ("Keep Claude settings effective across
  turns") added `query.applyFlagSettings({ effortLevel })` at `:1030`, passing `null` to fall
  back to the file default. `setModel` (`:1016`) and `setPermissionMode` (`:993`) are also
  already called. `setMaxThinkingTokens` and `resolveSettings` are not called anywhere.
- **No project or instance identifier reaches the provider runtime.** `SendTurnInput`
  (`src/lib/provider/types.ts:169`) carries `sessionId`, `turnId`, `workspaceRoot`, `configDir`,
  `model`, `variant`, `permissionMode`, `agent` — no `projectSlug`, no `instanceId`.
  `this.providerId` inside the runtime is the literal `"claude"`. `configDir` is a usable
  instance key today; `workspaceRoot` a usable project key. Real per-project scoping means
  threading `slug` through `provider-turn-service.ts` (~:594-621).
- **`relay-settings.ts` is global-only**, and `relay-stack.ts:1294` hands every project relay
  the same daemon `configDir`, so all projects already share one `settings.jsonc`. No
  per-project settings store exists anywhere in the codebase.
- **Broadcast pattern confirmed**: save → re-read merged view → `wsHandler.broadcast(...)`
  (`handlers/visibility.ts:45-75`), fanned out per relay, i.e. per project. Note initial state
  is *replayed* by piggybacking on existing RPC responses (`ws-rpc.ts:220`, `:834`), not by a
  dedicated message — a new store needs its own replay path.

### Round 2 — resolved

**Fork 2 — scope → B: global only.** One settings layer for all conduit sessions, reusing the
existing `~/.conduit/settings.jsonc` store. Rejected: A (global + per-project) and D
(per-project), which would require a net-new per-project store and threading `slug` into
`SendTurnInput`; C (per-instance), free via `configDir` but not how the user thinks about it;
E (three layers) as over-built for v1.

**Fork 3 — what conduit sends → C: full snapshot.** `resolveSettings()` at session start,
conduit's overrides applied on top, the complete effective object sent as the flag layer.
Conduit is the single source of truth: what the panel shows is what runs. **Amendment from the
user: conduit's existing `canUseTool` bridge and permission handling stay.** Rejected: A
(sparse + deep merge) and B (sparse, no merge) as leaving the displayed value and the running
value able to disagree; D (permissions routed away from the flag layer) since the bridge is
being kept anyway.

**Fork 4 — display → A: effective value plus provenance.** Each control shows the resolved
value and the file it came from; editing creates an override; "reset to inherited" clears it.
Requires a `resolveSettings()` call and a tri-state input.

**Question 5 — timing → (a): live where the SDK allows, next-query otherwise, labelled in the
UI.** Confirmed feasible — this extends the `applyFlagSettings` mechanism `d1e162b4` already
established rather than building a new one. *Superseded in round 3 (revised): only five keys
live-apply, so in practice everything in the panel is next-session.*

### Explore: permission-layer precedence in the SDK

Evidence from `sdk.d.ts`, `sdk.mjs`, and the native CLI binary (readable minified JS past byte
~226,000,000), plus code.claude.com docs.

- **Mode precedence at startup**: `--dangerously-skip-permissions` > `options.permissionMode` >
  agent frontmatter > merged settings `permissions.defaultMode`. Settings tiers order
  managed > flag > local > project > user (`sdk.d.ts:2360`).
- **`applyFlagSettings` live-applies exactly five keys**: `agent`, `viewMode`, `model`,
  `effortLevel`, `ultracode`. Everything else lands in the layer with no live effect.
  `defaultMode` is startup-only; `setPermissionMode()` is the only live mode control, and the
  two paths never meet — so no stomp hazard.
- **`applyFlagSettings` shallow-merges top-level keys** (`sdk.d.ts:2352-2375`); `null` clears a
  key, `undefined` is dropped. `{effortLevel}` leaves `showThinkingSummaries` intact. Nested
  objects are replaced wholesale.
- **Trust filter — real escalation path.** The CLI gates only `auto`, and distrusts
  `projectSettings` *and* `localSettings` while explicitly trusting `flagSettings`. Re-sending
  a file-derived `auto` through the flag layer launders a repo-controllable escalation into a
  trusted tier. `filterEscalatingDefaultMode` does not help: its untrusted set is `project`
  only, and `resolveSettings()` hard-codes the flag tier to null so the helper never sees it.
- **`canUseTool` ordering**: hooks → deny → ask → mode → allow → callback. An `allow` match
  short-circuits and the callback never fires; `deny` rejects without it; `ask` forces it even
  under `bypassPermissions`. Escalating modes suppress it for what they auto-approve.
- **Unknown keys pass through** (zod `.passthrough()`); known-but-invalid keys are dropped with
  a warning, and a few security-relevant fields fail closed.
- **Unverified, load-bearing**: whether flag-layer `permissions.allow`/`deny`/`ask` take effect
  mid-session. Evidence suggests no-op (rules built into session state at startup) but the
  negative is unproven. Worth an empirical test before building.

### Round 3 — resolved

**Fork 8 (reopened Fork 3) — full snapshot, excluding `permissions`, and saying so in the UI.**
`resolveSettings()` at session start, conduit's overrides on top, sent as the flag layer — but
`permissions` never goes through it. That closes the laundering path at the source and matches
the "keep the `canUseTool` bridge" amendment.

**Fork 5 — mode → A: the panel sets the startup default; the session dropdown overrides it live
via `setPermissionMode`.** This is already how conduit behaves; the panel only gives the startup
value a UI.

*Reconciliation (decided, not asked):* Fork 5 A and Fork 8 D appear to conflict — if
`permissions` is excluded from the flag layer, how does the panel set a startup default mode?
Via `options.permissionMode`, the CLI-arg tier, which beats every settings tier including flag.
Conduit already passes it (`claude-provider-runtime.ts:~920`). No flag layer involved and no
laundering, because the value comes from conduit's own store rather than from a repo file.

**Fork 6 — model and effort → the panel owns them as *defaults for new sessions*; the
contextual session UI overrides them per session.** Stated as "A but not excluded", which is
option B in substance. Resolution: these map onto conduit's existing
`defaultModel` / `defaultVariants` in `settings.jsonc`, which already mean exactly this. They
are conduit options passed per turn, not SDK settings keys, so they stay out of the flag-layer
snapshot entirely.

**Question 7 — staleness → B: the panel distinguishes *inherited* (still tracking the file)
from *pinned by conduit* (an explicit override).** Plus: an in-session command to reload
settings from disk.


### Round 4 — resolved

**Fork 9 — permission rules → abandoned.** Conduit does not edit `permissions.allow` /
`deny` / `ask`. This supersedes Round 1's Question 3 answer (b): coverage is **scalars only**,
i.e. what (a) originally described. Two consequences fall out. First, the unverified item —
whether flag-layer permission rules take effect mid-session — is now moot; nothing depends on
it. Second, the Round 1 contradiction dissolves: the settings panel writes no files at all.
The permission card keeps writing rules through the SDK exactly as it does today, unchanged
and out of scope.

**Question 10 — reload → (a).** "Reload settings from disk" restarts the underlying `query()`
with a fresh snapshot while preserving conversation history, reusing the existing reload seam
(`src/lib/handlers/reload.ts` → `end_session`). Rejected: (b) re-running `applyFlagSettings`,
which would change five keys and silently ignore the rest; (c) staleness tracking across open
sessions, as more machinery than the value warrants.

**Refinement to Fork 8, not a reopening.** Excluding `permissions` is necessary but not
sufficient. `autoMode` is a separate top-level key with the same trust shape — project and
local values are ignored by the CLI, flag values are trusted — so it launders identically and
must be excluded too. The principle is "exclude every key whose trust depends on which tier it
came from"; the exact list needs verifying against the pinned SDK at build time. Also note the
fail-closed set (`allowedMcpServers`, `allowManagedMcpServersOnly`, `availableModels`,
`forceLoginOrgUUID`, `sandbox.credentials`), which is safe to pass through verbatim from
`resolveSettings()` but must not be reconstructed by hand.

## Closing argument

Conduit gets a settings surface that controls **conduit's own Claude sessions**, and nothing
else. It is not a remote editor for the config files on disk. Those files stay exactly where
they are, owned by chezmoi and by the terminal lanes (`ccp`, `ccw1`, `cce`), and conduit reads
them without ever writing them. That single choice — Fork 1, A plus D — is what makes the rest
of the design small.

The mechanism is the SDK's **flag settings layer**. It sits above `user`, `project`, and
`local` in the precedence chain, which means conduit can override anything the files say
without touching them. Conduit is already in that layer today, passing
`settings: { showThinkingSummaries: true }`, so this is an extension of something real rather
than a new seam. At session start conduit calls `resolveSettings()` to get the effective value
of every key plus the file each one came from, applies the user's stored overrides on top, and
sends the whole object as the flag layer. What the panel shows is what the session runs.

Conduit stores those overrides in **one global place** — the existing
`~/.conduit/settings.jsonc` — because that is where relay settings already live and because
every project relay is handed the same config dir anyway. There is no per-project settings
store in conduit and this feature does not create one. The provider runtime never sees a
project slug or an instance id, only `workspaceRoot` and `configDir`, so per-project scoping
would have meant threading new fields through `SendTurnInput`; global scope needs none of that.

Two keys are excluded from the flag layer entirely, for reasons of safety rather than tidiness.
The CLI trusts the flag tier and distrusts `project` and `local` for `permissions.defaultMode`
and for `autoMode`, precisely because those files are repo-controllable. If conduit read `auto`
out of a repo's `.claude/settings.local.json` and echoed it back through the flag layer, the
value the CLI meant to drop would be honoured — conduit would be laundering a permission
escalation on the user's behalf. So `permissions` and `autoMode` never go through the snapshot.

Permission mode is still a panel control; it just travels a different road. The panel sets the
**startup default**, delivered through `options.permissionMode`, which is the CLI-arg tier and
outranks every settings tier including flag. Conduit already passes it. Once a session is
running, the existing dropdown owns the mode through `setPermissionMode()`, which is the only
live control there is — `defaultMode` is a startup-only input, so the two never collide. And
conduit's `canUseTool` bridge is untouched, because nothing in the panel writes permission
rules that could short-circuit it.

Permission **rules** are out. The panel does not edit `allow`, `deny`, or `ask`. This is the
one place the design contracted during the grill: rules were in scope at Round 1 and dropped at
Round 4, on the grounds that an `allow` match short-circuits before `canUseTool` fires, so a
rule editor would be a UI for silently disabling conduit's own approval prompts. The permission
card already writes rules through the SDK when you choose "always allow"; that keeps working
and stays out of scope. Coverage is therefore **scalars only**.

Two of the scalars are not SDK settings at all. `model` and `effortLevel` map onto conduit's
existing `defaultModel` and `defaultVariants`, which already mean "default for a new session,
overridable per session from the contextual UI". The panel surfaces the fields that exist
rather than introducing a second home for the same value, and because they are conduit options
passed per turn, they stay out of the flag-layer snapshot and the two mechanisms never tangle.

Everything else the panel touches is genuinely startup-bound. `applyFlagSettings()` live-applies
exactly five keys — `agent`, `viewMode`, `model`, `effortLevel`, `ultracode` — and every key the
panel owns falls outside that set. Autocompact, the setting that started this, cannot be changed
mid-session at all. So the honest framing is that panel edits take effect on the **next
session**, and the UI says so rather than pretending otherwise. The escape hatch is an
in-session **reload settings from disk** command that restarts the underlying `query()` with a
fresh snapshot while preserving history, reusing the reload path conduit already has.

The panel shows, for every key, the **effective value and where it came from** — "150000, from
`~/.ccs/instances/personal/settings.json`" — with editing creating an override and a reset
clearing it back. Each key reads as either *inherited*, meaning it is re-resolved from disk at
every session start and file edits still reach it, or *pinned*, meaning the user set it here and
it wins until cleared. That distinction is the whole mental model, and it holds because conduit
persists the user's **overrides**, never the resolution. Persisting a resolved snapshot would
freeze every key against future file edits and turn the provenance labels into fiction; that is
the trap this design avoids by construction.

Assumptions settled without asking: validation reuses the Effect schemas in
`contracts/providers/claude-agent-sdk.ts`, which already keyof-check against the SDK's `Options`
type; changes broadcast to other browser clients on the `visibility_info` pattern from
`handlers/visibility.ts`, with a replay path of its own since initial state currently
piggybacks on unrelated RPC responses; and keys conduit does not model are carried through the
snapshot verbatim, since the SDK's settings schema passes unknown keys through and dropping
them would silently break anything the SDK adds later.

What is left uncertain is small and bounded. `outputStyle`, `switchModelsOnFlag`, and
`skipWorkflowUsageWarning` were not confirmed to affect headless sessions and should be left out
until they are. The exact set of trust-sensitive keys to exclude needs checking against the
pinned SDK version rather than taken from this document. And the resulting v1 is honestly
narrow — autocompact on/off and window, always-thinking, disable-all-hooks, cleanup period,
commit attribution, permission-mode default, plus the two existing model defaults. That is a
short list, and it is the correct list: everything else in the dotfiles template is either
terminal-only, nested config the first cut excludes, or already has better UI elsewhere in
conduit.

**Closing argument approved** (user moved to `/to-spec`). ADR recorded at
`docs/adr/0003-claude-settings-overrides-use-the-sdk-flag-layer.md`.
