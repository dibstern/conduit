# ADR-0005: Compact redundant historical events separately from reclaiming disk space

- Status: accepted
- Date: 2026-10-14
- Context: conduit-test-8rdf.19

## Context

Historical subagent polling wrote empty deltas and repeated thinking endings.
These rows occupy most of the ticket's measured event log, but carry no new
text. The writer guards have already landed.

Removing every empty delta would change replay. The message projector inserts
a part on its first delta or `thinking.start`, assigning `MAX(sort_order) + 1`.
An empty opener therefore reserves the part's order and creation time. It must
survive compaction. Legacy part ids can also be reused by another message. An
empty delta can create that later message even when its part id already exists;
removing it can change the ownership of later compaction dividers.

Repeated `thinking.end` events also affect replay. Each one overwrites the
thinking part's `updated_at`; the history adapter exposes that as `time.end`,
which the browser uses to calculate duration. The last ending must survive
to preserve the displayed duration. Compaction must not rewrite that history.

The first deletion predicate failed the real-store parity gate. Replaying
the 20 heaviest sessions, including 543,631 subagent thinking events, loses 62
messages and their parts, changes 64 thinking statuses, and changes 716 message
checkpoints and 697 message timestamps. Another 1,042 thinking timestamps
differed. Those results ruled out the broader predicate. The
[parity artifact](../performance/8rdf19-compaction-parity.json) now requires
exact rendered history, so those timestamps must match too.

Duplicate user `message.created` events explain the missing rows. The turn
projector uses `INSERT OR REPLACE`, which
[deletes the conflicting turn](https://www.sqlite.org/lang_conflict.html).
The message foreign key cascades that deletion. Later empty deltas recreate
those messages and parts; a repeated ending completes the recreated thinking
part. Those events are necessary under the current projector behavior.

Preserving the final thinking status alone is insufficient. A retained
`tool.running` event reads the part's current status when updating a child
session. Removing an intermediate ending can mark that child busy even when a
later ending restores the part's completed status. Retained events must see
the same input state during replay.

## Decision

The migration preserves the existing projector behavior, including its turn
replacement cascades. No projector or producer changes are part of this decision.

**A numbered migration may delete these redundant events.** Migration
`0057_compact_redundant_events.sql`, registered at Effect id 58, splits the log
into intervals at every event that can delete or replace a message, part or turn:

- `message.created` with `role = user` replaces a turn, cascading to messages
  and their parts (`projectors-effect.ts:1184`).
- `message.removed` deletes a message and cascades to its parts
  (`projectors-effect.ts:475`).
- `message.part.removed` deletes a part (`projectors-effect.ts:626`).
- `message.snapshot` replaces provider parts (`projectors-effect.ts:565`).
- `session.deleted` deletes a session and cascades through descendant sessions,
  turns, messages and parts (`session-handlers.ts:446`, schema migration 0010).

Boundaries apply globally because entity ids are global keys and a session
deletion can affect its descendants. `tool.running` also bounds intervals for
its globally keyed part, so its intermediate thinking-status reads observe the
same values. Unrelated tool updates do not bound that part's interval. Other status
readers either inspect tool parts or unconditionally complete the thinking part.
Snapshots already bound the message timestamp aggregate. Within each interval,
session, message, part and authority class, retain the first opener and ending
and the last delta and ending. REST-authoritative events form a separate class:
the snapshot guard can skip native events while accepting a REST event's first
effective insertion. Delete only empty deltas after the first opener and before
the last delta, and endings
strictly between the first and last ending. This keeps resurrection events,
part order, final timestamps, status and message replay checkpoints. Other rows
retain their bytes, ids, sequences and stream versions. The migration runs in
the existing migration transaction and adds no index.

**Message bookkeeping is compared, not waived.** `last_applied_seq` controls
delta replay idempotence. `messages.updated_at` supplies history completion time
when `completed_at` is absent and contributes to turn totals on a message
snapshot. Paging and rewind use `created_at` and id, and sync uses row versions,
but those independent clocks do not make the two message fields disposable.
The parity script compares all eleven projection-owned tables, ignores only
`version` (including the serialized sidebar row's version), compares rendered
history without normalizing thinking times, and requires exact part statuses.

**Logical deletion and physical reclamation are separate operations.** The
migration frees SQLite pages. Startup may reclaim them with a verified
`VACUUM INTO` copy before opening the long-lived store. The physical rewrite
must pass `quick_check` and preserve every table count before promotion.
Both SQLite connections close before the copy is synced and renamed. The
legacy storage move uses the same rewrite operation. SQLite documents
[`VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html) as producing the same
logical content in a compacted file.

**Event ids are not deletion tombstones.** The event-id uniqueness constraint
does not prevent a deleted id from being appended again. The subagent
materializer's offsets suppress repeated polling within a session context,
but those offsets are in memory. Its id hash includes `createdAt`, sampled from
`Date.now()`, so polling after context recreation can emit new ids for old
content. The guards stop empty thinking deltas and repeated endings within
that context; they do not establish a durable deduplication guarantee across
every producer or restart. This migration accepts that limitation rather than
adding a new tombstone protocol.

The live guard also assumes a cached part still exists. If a turn replacement
deletes it after the cursor records its offset, a later unchanged poll emits
no thinking opener or ending to restore it. The visible result can be a missing
completed thinking block. This migration does not change that writer behavior.

## Consequences

Archived-tree retention (conduit-test-iujk.7) is another exception to the permanent
event log. After a root has been archived for the configured window (30 days by
default; null disables), and no member of its parent/descendant tree is pinned
or active, retention commits the canonical `session.deleted` command, then removes
all events for that tree. A deleted tree replays to nothing. Trees referenced by
any surviving fork are kept because fork history reads source events live.
The window counts from the root's archive time; descendants need no archive stamp.
Automatic deletion keeps checkouts and processes at most 50 roots per project
per sweep; freed SQLite pages are reusable without a physical store rewrite.

- This is a bounded exception to the append-only event-log policy. Future
  deletions require their own replay evidence and migration.
- Existing read models remain unchanged. Fresh replay must preserve their
  history semantics, including historical thinking durations. Physical
  reclamation never changes read-model rows.
- Gaps in sequence and stream version are allowed. Appends compute the next
  stream version from the maximum retained value, and recovery scans by
  sequence rather than assuming consecutive rows.
- Reclaim is optional when fewer than 20% of pages are free or free
  space on the store's volume is less than twice the estimated compacted size.
  Skipped reclamation logs a warning when disk space is insufficient; SQLite
  can reuse the freed pages.
- The migration fixture verifies deletion and exact preservation of every
  retained event row, including empty openers, legacy part-id reuse, and a
  duplicate user creation followed by an empty delta that resurrects a message.
  It also preserves an intermediate ending read by a later tool update.
  It cannot establish replay safety by itself: the real-store artifact is the
  acceptance gate.
- Global boundaries and final-value anchors deliberately retain extra rows.
  Full-store size after compaction is estimated from row counts, average payload
  sizes and index sizes. The measured artifact records subset size, migration
  runtime, strict replay differences and free-space checks. No full-store copy
  is required, and every intermediate database is removed.

The accepted parity run used the 20 heaviest sessions: 1,096,565 events,
including 543,631 subagent-sourced thinking events. It removed 359,106 rows in
6.148 seconds. All eleven compared tables matched, including 6,189 messages,
72,237 parts and 579 turns. Both message bookkeeping columns, thinking status,
thinking timestamps and rendered history matched exactly. There were zero
unexpected differences and zero projection failures. Repeating recovery replayed
zero events on both stores.

The subset shrank from 1,040,048,128 to 746,782,720 bytes after physical rewrite.
The full-source predicate took 14.532 seconds without an added index and found
880,908 deletable rows: 439,649 empty thinking deltas and 441,259 thinking endings.
Potential full-store savings are estimated at 677,901,014 bytes, reducing
5,731,659,776 to approximately 5,053,758,762 bytes after rewrite. The rejected
predicate estimated 1,849,352,822 bytes from 2,403,081 deletions, but changed
history. The smaller saving preserves replay. These estimates do not guarantee
startup reclamation: the free-page threshold still controls whether it runs.

No full-store replay or copy was performed. Events outside the selected sessions
can add boundaries and cascades, so the subset does not prove every full-store
interaction. The source-wide count uses the full event log. Minimum observed
free space was 13,574,197,248 bytes (12.64 GiB), above the 8 GiB floor, and all
intermediate databases were deleted.
