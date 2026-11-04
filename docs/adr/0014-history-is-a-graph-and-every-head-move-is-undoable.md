# ADR-0014: History is a graph, messages is a view of the head path, and every head move is undoable

- Status: accepted
- Date: 2026-11-01
- Context: conduit-test-3c7y (closed, split into epic conduit-test-82tn);
  conduit-test-82tn.44, conduit-test-82tn.50, conduit-test-82tn.51,
  conduit-test-82tn.52

## Context

Rewind moves the conversation, and only until the next message. The rewound
messages wait behind a pending-rewind column, and the next send commits the
rewind by deleting them. After that the abandoned branch is gone: two attempts
cannot be compared, and a regenerated answer replaces the old one. Readers
carry filters that hide pending-rewind messages, and the busy check and limit
recovery carry exceptions for a pending rewind.

t3code keeps an orchestration graph, but its rewind deletes later checkpoints,
so a rewind there cannot be undone either.

## Decision

**History is a graph per session.** The History Graph is a projection of
canonical events ([ADR-0004](0004-session-mutations-are-canonical-events.md)).
It holds one History Node per Ended Run, whatever its outcome, with the Run's
Run Inputs, its assistant output and its parent node. A Run with a Steer is one
node. A rewind to that Steer targets the Run's parent and restores the Run's
inputs as a draft. A session has one Head.

**`messages` is a view of the head path.** Message rows of every branch are
kept, each tagged with its node. `messages`, and the parts and turns tables
keyed by a message, become views over base tables filtered to the path from the
root to the Head. Only projectors write those tables, so the readers of
`messages` do not change. A Head Move flips path membership in the same
transaction as its `head_moved` event. It never replays events, which avoids
the projector hazards [ADR-0005](0005-event-log-compaction.md) records. Head
Moves are ADR-0005 compaction boundaries.

**One module performs every Head Move**: rewind, undo, edit-and-resend,
regenerate and branch switch. Preview writes nothing and returns a proposal.
Commit revalidates and moves. A move is journalled as `head_move_started` then
`head_moved`, and startup rolls an interrupted move forward. Edit-and-resend
and regenerate are a move followed by a Run Ledger admit keyed by the move id,
so the new Run's node is a sibling of the old one. Admission for a Head Move reads Run
Ledger state (conduit-test-82tn.49).

**Every Head Move is undoable.** Nothing is removed. The Head Log lists every
move with its cause. Undo moves the Head back to where an entry started and is
itself a new entry. The one limit is pruned history (conduit-test-f02e9.13): a
conversation-only move into it is allowed and shows files as unavailable, and
a move that needs files is refused as Pruned.

**The next Run continues from the Head through the resume plan.** The Turn
Launcher's resume plan uses the provider's native resume when the provider's
own session contains the head path, otherwise a recorded context handoff.
Conduit never writes a provider's native transcript.

**Forks, Side Threads and subagents.** A Fork or Side Thread starts a new
session whose root links to a source History Node. Lineage stays separate from
containment ([ADR-0007](0007-containment-and-lineage-are-separate-facts.md)).
A subagent session keeps its own graph, and a parent rewind never edits it.

The pending-rewind column, its commit on the next send and every pending-rewind
exception are deleted. Whether a Head Move also moves files is decided in
[ADR-0015](0015-only-conduit-restores-files-a-whole-folder-at-a-time.md).

## Consequences

- Rewind stops emitting message removals. Abandoned branches take storage
  until retention ([ADR-0013](0013-event-retention-reads-only-the-event-log.md))
  deletes the session.
- Existing sessions migrate to a linear graph whose head path equals their
  current messages. Messages removed by an older rewind become an off-head
  branch where the events allow, otherwise they are marked unavailable.
- The head-path view must be checked for speed on the largest sessions;
  ADR-0005 cites 543k events in one session.
- Desktop and phone committing the same proposal produce one move.
- Resuming OpenCode at a node off its live native transcript needs a native
  fork and a Conduit-to-native id mapping (conduit-test-82tn.52).

## Rejected alternatives

- **Keep the pending rewind and delete on the next send.** A rewind cannot be
  undone after the next message, and every reader keeps its carve-out.
- **t3code's graph.** Its rewind deletes later checkpoints, so it cannot be
  undone, and it refuses after a provider switch.
- **Replay events to rebuild `messages` for the new Head.** It hits ADR-0005's
  projector hazards: user message upserts cascade into turns, and legacy part
  ids are reused across messages.
- **One node per Run Input.** A Run with a Steer has several inputs but one
  execution, so nodes inside it would have no Run boundary to resume or restore
  from.
