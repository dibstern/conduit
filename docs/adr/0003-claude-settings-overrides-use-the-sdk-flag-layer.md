# ADR-0003: Claude settings overrides go through the SDK flag layer, and trust-tiered keys never do

- Status: accepted
- Date: 2026-08-12
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

Conduit stores the user's explicit overrides in its own global relay
settings and, at session start, resolves the effective settings from disk,
layers the overrides on top, and passes the result as the flag layer. The
user's files are read-only input; Conduit never writes them.

`permissions` and `autoMode` are excluded from that snapshot. Re-sending a
repo-derived `auto` through the trusted flag tier would launder past a check
the CLI applies on purpose. The startup permission mode is delivered through
`options.permissionMode` (the CLI-arg tier) from Conduit's own store instead,
and the live mode stays with `setPermissionMode()`.

Conduit persists **overrides**, never the resolved snapshot. Persisting the
resolution would pin every key against future file edits and make
"inherited from `<file>`" a lie.

## Considered options

- **Edit `settings.json` directly.** Rejected: chezmoi ownership, and the
  edit reaches terminal sessions the user did not intend to change.
- **Sparse flag layer (send only overridden keys).** Viable and safe; rejected
  in favour of the full snapshot so that what the panel shows is exactly what
  the session runs, with no separate mental model for untouched keys.
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
  as per-turn options, and stay outside the snapshot.
