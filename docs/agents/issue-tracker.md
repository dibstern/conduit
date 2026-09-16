# Issue tracker: Beads

Issues, specs, and tickets for this repo live in Beads (the `bd` CLI). Issues live in Dolt; `.beads/*.jsonl` is a passive git export. Run `bd prime` for the full command reference.

GitHub Issues at `dibstern/conduit` are **not** the tracker. Existing GitHub issues #10–#16 predate this decision and are mirrored as beads with `--external-ref gh-N`; do not create new ones.

## Conventions

- **Spec / PRD** → one bead of `--type epic`. Put the spec body in `--description` (or `--body-file`), design notes in `--design`, acceptance criteria in `--acceptance`.
- **Tickets** → one bead each, `--parent <epic-id>`, `--type feature|task|chore|bug`. The ticket's "What to build" is the description; its checklist is `--acceptance`.
- **Blocking edges** → `bd dep <blocker> --blocks <blocked>`. Add edges one at a time and verify each with `bd dep list <id>`; batch `bd` operations can partially fail without error.
- **Triage state** → a label from `triage-labels.md`, applied with `bd label add <id> <label>`. `bd ready` is the frontier: open, unblocked, not deferred.
- **Claiming** → `bd update <id> --claim` before starting work; `bd close <id> --reason "..."` when done, then confirm with `bd show <id>`.
- **Feature grouping** → tag every bead in a feature with a shared label (e.g. `claude-settings`) so `bd list -l <label>` shows the whole tree.
- **Comments / handoff** → `bd update <id> --append-notes "..."`.

## When a skill says "publish to the issue tracker"

Create beads. For a spec, one epic. For tickets, one child bead per ticket in dependency order (blockers first) so each edge can reference a real id, then add the edges.

## When a skill says "fetch the relevant ticket"

`bd show <id>`. The user will normally pass the bead id directly.

## When a skill says "apply the triage label"

`bd label add <id> <label>` using the strings in `triage-labels.md`.
