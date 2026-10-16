# ADR-0006: Containment and lineage are separate facts

- Status: accepted
- Date: 2026-10-16
- Context: conduit-test-extp (forks disappear from the sidebar); closes
  conduit-test-rdmq and conduit-test-cv2l
- Supersedes: the outcome of ADR-0004's conduit-test-o5vp consequence, not its
  mechanism

## Context

`sessions.parent_id` carried two facts. For subagents and Side Threads it meant
"this session is contained by that one". For forks it meant "this session was
started from that one". The column was set the same way for both.

Every top-level check, server and browser, asks "has no parent": the shell
feed's roots, the sidebar projection's root walk, the family queries, the
browser's sidebar, search and cross-project filters, busy propagation, alert
muting and the attention mark. So every fork failed all of them. It vanished
from the sidebar, its busy state lit up its Source's row, and its alerts were
muted as if it were a subagent.

The column also carries `ON DELETE CASCADE`. Widening the top-level check to
"no parent, or has a fork point" would have made forks visible and then
silently deleted every one of them with its Source.

A local model that kept forks parentless, with a `forked_from` column, existed
once. A later migration folded that column back into `parent_id` during a
merge, and forks have been hidden since.

## Decision

**Parent means containment, and cascades.** `sessions.parent_id` holds only
"contained by". A Family is a session plus everything it contains,
transitively. Deleting a session deletes its Family, exactly as ADR-0004's
schema cascade already does.

**Forked-from means lineage, and is set to null on delete.** A new
`sessions.forked_from` column, indexed, references `sessions(id)` with
`ON DELETE SET NULL`. Deleting a Source never deletes a Fork; the Fork keeps its
transcript and fork point, and its lineage points at a real row or at nothing.

**A Family Root is a session with no parent.** The definition every consumer
already uses is unchanged, so those consumers become correct without an edit.

| kind          | `parent_id` | `forked_from` | `side_thread` |
|---------------|-------------|---------------|---------------|
| plain session | none        | none          | 0             |
| Fork          | none        | Source        | 0             |
| Side Thread   | Source      | Source        | 1             |
| subagent      | owner       | none          | 0             |

**One placement module decides.** A pure function inside the session projector
maps a `session.created` or `session.forked` payload to
`{ parentId, forkedFrom, sideThread }`. It is the only code that decides
containment or lineage. `session.forked` records lineage only; its stored field
is still named `parentId` and now means the Source, because stored events keep
their shape forever.

**The write seam makes mixed placements unrepresentable.** `session.created`
gains an optional `forkedFrom` in a flat stored struct, so every old event still
decodes. The command type narrows placement to the four rows above, and both
fork commands, OpenCode and Claude, build theirs through one fork-placement
builder. A fork path can give a session a parent only when it is a Side Thread.

## Consequences

- Existing top-level checks stay as they are. The browser's three root filters
  share one Family Root check that reads containment only. The attention mark's
  fork clause can now match only Side Threads, so it says so.
- Old events are read by a legacy rule in the placement module: a
  `session.created` with a parent, a fork point and no Side Thread flag is a
  Fork of that parent. One migration applies the same rule to existing rows,
  recomputes roots and sidebar rows for moved subtrees, and must produce the
  same read model as replaying the log.
- The shell feed tracks membership changes, not just deletions. A row that
  stops being a Family Root gets a remove; one that becomes a Family Root gets
  an upsert. A Fork never changes membership after creation, so this matters
  for an OpenCode Side Thread seen on the provider stream before its
  `session.created` lands.
- The wire session row gains `forkedFrom`. The fork divider, prior context and
  Source navigation read it, never `parentID`. A Fork whose Source was deleted
  says so, without a link.
- Upstream sync for lineage stays a no-op, as ADR-0004 says.

## Rejected alternatives

- **Keep forks as children and widen the root check to "no parent, or has a
  fork point".** Visible Forks would be cascade-deleted with their Source, every
  top-level check would need the new predicate and could drift, and busy,
  alert and roll-up misattribution would remain.
- **Drop lineage from the read model and derive it from fork points.** OpenCode
  forks of an empty session have no fork point, and the divider needs the
  Source id anyway.
- **Store lineage without a foreign key, keeping the id after a delete.** The
  divider could then show a stale Source id. `ON DELETE SET NULL` keeps lineage
  pointing at a real row and leaves delete behaviour in the schema, as ADR-0004
  wants.
- **Change the stored event shape to a tagged placement union.** It would create
  two stored shapes forever for no gain. A flat stored struct plus a narrowed
  command type gives the same write-time safety.
