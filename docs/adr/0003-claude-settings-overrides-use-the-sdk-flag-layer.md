# ADR-0003: Claude settings overrides go through the SDK flag layer, and trust-tiered keys never do

- Status: accepted
- Date: 2026-08-12 (amended 2026-09-10)
- Context: `docs/plans/2026-08-12-claude-settings-editor/grill.md`

## Context

Conduit wants to let the user change Claude Agent SDK settings (autocompact,
always-thinking, attribution, …) from its settings panel, and have those
changes persist across Conduit sessions. The obvious route is to edit the
user's `settings.json`. That file is owned by chezmoi and by the user's
terminal lanes, and a Conduit edit would be either clobbered or would leak
into sessions Conduit doesn't run.

The SDK resolves settings in tiers, low to high: `user < project < local <
flag < managed policy`. The flag tier is what `options.settings` populates,
and Conduit already occupies it. The CLI trusts the flag tier unconditionally
but ignores `permissions.defaultMode: "auto"` and `autoMode` when they come
from `project` or `local`, because those files are repo-controllable.

## Decision

Conduit stores the user's explicit overrides in its own global relay settings
and passes **only those overrides** as the flag layer at session start. The
user's files are read-only input; Conduit never writes them.

Conduit does not resolve the lower tiers itself for this purpose. The SDK
subprocess already resolves `user`/`project`/`local` — `settingSources` is set
— using the config dir Conduit gave it. Layering only the overrides on top
therefore yields exactly the same effective settings as layering them on a
Conduit-resolved snapshot would, with less machinery and one less way to be
wrong.

`permissions` and `autoMode` are excluded from what Conduit sends. Re-sending a
repo-derived `auto` through the trusted flag tier would launder past a check
the CLI applies on purpose. The startup permission mode is delivered through
`options.permissionMode` (the CLI-arg tier) from Conduit's own store instead,
and the live mode stays with `setPermissionMode()`.

Conduit persists **overrides**, never a resolved snapshot. Persisting the
resolution would pin every key against future file edits and make
"inherited from `<file>`" a lie.

The panel still needs the resolved-from-disk values to show effective value
and provenance. That resolution is a **display** concern, computed when the
panel asks for it, and is not on the session-start path.

## Considered options

- **Edit `settings.json` directly.** Rejected: chezmoi ownership, and the
  edit reaches terminal sessions the user did not intend to change.
- **Send a full effective snapshot through the flag layer** (resolve the files
  in-process, layer overrides, send the merged result) so that what the panel
  shows is literally the object the session runs. Rejected on correctness:
  `resolveSettings()` accepts `cwd`, `settingSources`, `managedSettings` and
  `serverManagedSettings` — there is no config-dir parameter, so it reads
  `CLAUDE_CONFIG_DIR` from the *calling* process. The daemon sets that once at
  startup to a single value, while each Claude instance may carry its own
  `configDir`, which Conduit applies only to the spawned subprocess env. An
  in-process resolution would therefore read the daemon's user tier for every
  session, and sending that through the *trusted* flag tier would override the
  session's genuinely-correct values rather than merely fail to reflect them.
  Redundant when right, corrupting when wrong.
- **Route `permissions.allow/deny/ask` through the flag layer too.** Rejected:
  an `allow` match short-circuits before `canUseTool`, so a rule editor would
  be a UI for silently disabling Conduit's own approval prompts. Rule editing
  is out of scope entirely.

## Consequences

- Almost nothing in the panel applies mid-session. `applyFlagSettings()`
  live-applies only `agent`, `viewMode`, `model`, `effortLevel`, `ultracode`;
  everything the panel owns is startup-bound. Edits take effect on the next
  session, and a reload command restarts the query with a fresh snapshot.
- The exclusion list is a security boundary and must track the pinned SDK
  version, not this document.
- `model` and `effortLevel` are Conduit's existing session defaults, passed
  as per-turn options, and stay outside the overrides object.
- Conduit's flag layer contains only keys the user explicitly set (plus
  `showThinkingSummaries`), so an untouched key is never pinned — not even for
  the duration of a session.
- "What the panel shows is what runs" holds by construction rather than by
  identity of objects: the panel shows `resolve(files) + overrides`, the
  session runs `files resolved by the subprocess + the same overrides`.
  Whatever mechanism the panel uses to resolve must use the session's config
  dir, or the provenance it displays will be wrong even though the session is
  right.
