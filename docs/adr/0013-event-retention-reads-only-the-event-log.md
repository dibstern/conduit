# ADR-0013: Event retention reads only the event log

- Status: accepted
- Date: 2026-10-21
- Context: conduit-test-hiuf.12, conduit-test-hiuf.15

## Context

[ADR-0005](0005-event-log-compaction.md) allowed the archive sweep to delete
every event in an expired archived tree after committing `session.deleted`.
It excluded Sources with surviving forks using the read model's `forked_from`
links. Deleting a middle fork clears those links, so a surviving grandchild
could lose Source events referenced by its copied parts' `result_event_seq`.
The sweep also removed deletion markers, losing durable proof of death.

Retention must preserve replay even when the read model is incomplete. A
missing session row cannot prove deletion, and a cleared lineage column cannot
prove that nobody needs a Source's history. The retained event log contains
both facts retention needs: lineage and each deleted session's own marker.

## Decision

**Only `EventRetention.drain()` deletes session events at runtime.** This
supersedes ADR-0005's archived-tree exception. The archive sweep still commits
the canonical deletion through `deleteSession`, but deletes no events and no
longer excludes trees referenced by surviving forks. The default 30-day window,
its null setting to disable automatic deletion, pinning, pending-work and
background-work rules, checkout preservation and 50-root sweep limit stay.
ADR-0005's numbered historical compaction migration remains a separate exception.

**A child's own lineage event is its hold.** A retained `session.created`
names its parent or Source through `parentId` or `forkedFrom`; a legacy
`session.forked` names its Source through `parentId`. The newest holding event's
sequence bounds the Source prefix that drain must keep. A held middle fork
keeps its own creation event, which holds the original Source in turn. Deleting
the holding event releases its hold in the same statement. Drain repeats passes
until no more events can be freed, preserving chains without a separate holds
register or recursive lookup.

**A session's own `session.deleted` is the only proof of death.** Drain never
deletes that marker. Delete commits a marker for every removed descendant in
the same transaction. A parent's marker or its historical `childSessionIds`
does not prove the child's death to drain. Markers survive reclamation,
interrupted batches and projection resets, so late ingress cannot resurrect a
reclaimed session. Orphans without their own marker are reported and retained.

Own deletion markers may retain minimal operational worktree metadata: final
canonical launch ownership and authorized branch renames, legacy folder/path
evidence, or a refusal state, each with its discovery paths. Capture this for
each session inside the deletion transaction before cascade. It preserves the
existing deferred checkout policy without retaining conversation, title, setup
output or workspace history; deletion markers remain the only retained event
kind. Markers already drained without this metadata cannot recover lost ownership.

**Born dead, checked by each writer (12A).** Every writer of
`session.created` (session commands, the session manager, provider runtime
ingestion and Claude event persistence) runs the death check inside the
write transaction that appends it. If the new session's own id, parent or
Source is dead, the writer refuses the creation, or, for a late provider
child it cannot refuse, appends the child's own `session.deleted` in the
same transaction and projects both. That derived marker is the one exception
to [ADR-0004](0004-session-mutations-are-canonical-events.md): it does not go
through `applySessionCommand`. The death check accepts only a session's own
marker, or a legacy tombstone for children cascaded before per-descendant
markers. The `session.created` projector writes nothing when the parent or
Source row is missing, so replay matches live. The checks are writer-local
rather than one store-level step, so a new writer of `session.created` must
add the same check.

**The read model may only block deletion.** A session row prevents drain from
deleting its events. A live part's `result_event_seq` prevents deletion of that
event. Neither check authorizes deletion or releases a lineage hold. Drain
rechecks eligibility and the event-derived bound inside each project-scoped,
500-event write transaction, preserving markers and live part pointers.
Every committed `session.deleted`, including a born-dead marker, kicks the
background drain; startup kicks it too. Concurrent kicks collapse into a
rerun. Freed pages remain reusable until the existing physical rewrite runs.

**`sessions.woken_at` and `sessions.woken_reason` are read annotations outside
the log.** This is option 2 for conduit-test-hiuf.15. A child's
`permission.asked` or `question.asked` wakes snoozed ancestors, but the event
lives only in the child's stream. Deleting and draining that child can remove
the event while leaving the ancestor alive. Rebuilding then leaves the ancestor
un-woken. We accept that loss of attention state rather than retaining a dead
child's history or adding ancestor events. `wakeSession` keeps its current
behavior. Replay parity ignores only these wake columns and their serialized
`session_sidebar.row.snooze` mirrors in addition to its existing exclusions;
the snooze itself remains canonical and compared.

## Consequences

- The events-delete guard permits drain's one runtime statement and the
  reviewed numbered migrations. The archive sweep has no exception.
- A Source can disappear from the sidebar while its history remains held for
  surviving forks, including forks of deleted forks. Reclamation follows the
  retained lineage events rather than current sidebar links.
- Descendant markers still use the read-model subtree computed during delete.
  A wrong `parent_id` can mark a live session dead and make its events eligible
  for reclamation. This accepted risk matches the existing cascade and what the
  user deleted. Revisit it if lineage projection bugs appear.
- A rebuild may restore a snoozed ancestor's unwoken attention state after a
  child's wake event is reclaimed. Transcript and snooze history must still
  replay exactly.

## Replay evidence

ADR-0005 requires replay evidence for event deletion. The committed record
is [hiuf-13-retention-dry-run.json](../performance/hiuf-13-retention-dry-run.json),
written by [verify-event-retention.ts](../../scripts/verify-event-retention.ts)
from a backup copy of the live store: it drains every project, checks each
removed event against the deletion rules, rebuilds the drained and undrained
copies and requires identical projections. Rerun it against a fresh copy to
re-check. The relay-harness suites produce repeatable JSON artifacts under
the gitignored `test-results/` on each run:

- [event-retention.integration.ts](../../test/integration/flows/event-retention.integration.ts)
  writes [hiuf-8-event-retention.json](../../test-results/hiuf-8-event-retention.json).
  It records lineage bounds, deleted and kept sequences, drain reports and
  replay parity across deletion orders, plus interruption, projection-failure,
  refusal-after-reset and project-isolation evidence.
- [archived-event-retention.integration.ts](../../test/integration/flows/archived-event-retention.integration.ts)
  writes [hiuf-12-archived-event-retention.json](../../test-results/hiuf-12-archived-event-retention.json).
  Each scenario records the sweep result, events before and after sweep and
  drain, the drain report and replay report. It covers an expired archived
  tree, a Source with a surviving fork, a Source with a surviving grandchild
  through a deleted middle fork, and an ancestor woken by a subsequently
  reclaimed child's approval. Fork scenarios compare messages, parts and every
  referenced result event. The wake scenario also records the differences when
  wake annotations are included in parity.
- [born-dead-sessions.integration.ts](../../test/integration/flows/born-dead-sessions.integration.ts)
  writes `born-dead-sessions/flows.json`: creations racing a delete of
  themselves, their parent or their Source end refused or dead, live and on
  replay, and a foreign-named marker never makes a live session read as dead.

These fixtures require no live store. Successful runs require no replay diffs,
no dangling result pointers and no events kept solely by part pointers. They
prove the exercised scenarios; they do not establish parity for every existing
store or repair historical lineage corruption.
