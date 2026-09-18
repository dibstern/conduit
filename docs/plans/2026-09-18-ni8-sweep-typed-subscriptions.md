# Spec — ni8 sweep: the remaining twelve beads of typed streaming subscriptions

> **Scope.** This spec covers the twelve beads left in epic `conduit-test-ni8` after
> `conduit-test-ni8.5` (RPC transport adapter) was specced and ticketed:
> **ni8.8, ni8.9, ni8.10, ni8.11, ni8.12, ni8.13, ni8.14, ni8.15, ni8.16, ni8.22,
> ni8.23, ni8.24**. It does not re-specify ni8.1–ni8.7; it builds on the
> `ReadModelSubscription` seam those delivered.
>
> **Source of record.** The design grill at
> `.scratch/foreman/ni8-sweep/01-grill.md` (three rounds, four parallel code
> explorations, closing argument approved 2026-09-18). Where this spec records a
> rejected alternative, it is because a later reader would otherwise reinstate it.
>
> **Sequencing note (grill fork 1.1 = option G).** The twelve bead bodies were
> re-cut against the exploration findings *before* this spec was written, because
> the bodies were wrong. ni8.15 claimed ten residue arms; it was three; it is one.
> ni8.22's "unbounded reseed" had a one-line cause the bead never mentioned.
> ni8.11 specified a dedicated second socket; fork 2.4 settled otherwise. ni8.14
> assumed a read model and a bus; neither exists. Specifying from the original
> bodies would have specified fiction.

## Problem Statement

A browser connected to conduit learns about the world through a hand-rolled JSON
WebSocket protocol: one long-lived broadcast socket carrying a union of 78 message
types, a switch arm per type, and reactivity assembled by hand on the client.
ni8.1–ni8.7 built the replacement seam. These twelve beads are the remaining
surface, and the grill found that the surface is not what the beads said it was.

What a user actually experiences today:

- **A badge that lies after a reload.** "Finished while you were away" is held in
  browser memory only, so a page refresh clears every one of them. The pending
  question count behind it lives in a process-local `Ref` in the session manager,
  so a daemon restart clears it too, even though the underlying approvals are
  durable in `pending_approvals`.
- **A second tab that goes quietly stale.** Change a model, a variant, a context
  window, a permission mode or a visibility setting in one tab and the other tab
  keeps rendering the old value. Six facts are broadcast today *specifically* to
  reach peer clients, and every one of them is about to be deleted along with the
  push channel unless it gets a home. The strongest surviving invalidation signal
  is an actual socket drop.
- **A rewind that appears to do nothing.** The post-rewind transcript clear and
  toast are wired to a message with no producer anywhere in the repo, so they can
  never fire. The transcript keeps showing messages from past the rewind point.
  (`conduit-test-voya`.)
- **A recovered hiccup fossilised in history.** A provider retry is a transient
  status, but both translators convert it into an error *message* that lands in
  the conversation transcript and replays on every cold load.
  (`conduit-test-j6zn`.)
- **An event log that grows without bound under a persistent projector failure.**
  The synthetic OpenCode `session.created` is minted with a fresh random event id
  on every retry, so the `UNIQUE` constraint that exists to stop exactly this
  never fires.
- **An instance rail that only updates in the tab that caused the change.**
  Instances are daemon-global; the broadcast that announces them is relay-scoped.

What a maintainer experiences: nine of the message types being migrated have no
server producer at all, seven request handlers are defined and unreachable, one
"push" is the frontend calling its own dispatcher, and a whole category of
transport error exists only to reject inbound raw messages of which exactly one
type remains.

## Solution

Finish the migration to typed streaming subscriptions over `@effect/rpc`, and
delete the hand-rolled protocol entirely — not down to a residue, to zero.

One rule decided most of it. It was found three separate times, in three
independent forks, without being looked for:

> **State is re-derivable and never replays. Content is history and always
> replays.**

- A badge is state; a ding is an alert that must fire once and never replay
  (fork 1.3).
- `connection_status` is state the client already holds, so it is derived locally
  and the arm is deleted (fork 3.1).
- A retry is state; a terminal turn failure is content (fork 3.2a).

Every bug this grill turned up is a case of one being built as the other. The
rule is the spec's tie-breaker: anything that must survive a reload is content and
belongs in the event log; anything that must *not* survive a reload is state and
must never become an event.

Concretely the user gets: a badge that survives reload and restart and clears
everywhere when the session is viewed anywhere; peer tabs that stay current
without a refetch or a reconnect; a "retrying, attempt 2, next in 4s" indicator
that lives on the turn and vanishes when the turn completes, instead of an error
bubble that lives forever; a rewind that visibly rewinds; a notification that
reaches them with the tab closed; and an instance rail that is right in every tab.

## User Stories

**Notifications and viewing**

1. As a user who walked away while an agent worked, I want the "finished" badge to
   still be there after I reload the page, so that stepping away does not lose the
   only signal that the work is done.
2. As a user, I want the badge to survive a daemon restart, so that a restart does
   not silently mark everything as seen.
3. As a user, I want opening a session to clear its badge in every tab I have
   open, so that I am not told twice about something I have already looked at.
4. As a user with the tab backgrounded or closed, I want to be told when a session
   needs my attention, so that I can leave conduit and come back.
5. As a user staring at a session, I want an in-app cue rather than an OS
   notification, so that I am not notified about the thing on my screen.
6. As a user, I want the ding to fire exactly once, so that a reconnect or a reload
   does not replay every alert from the last hour.
7. As a user who has denied notification permission, I want the in-app path to
   still work, so that refusing permission degrades the feature rather than
   removing it.

**Peer tabs and other actors**

8. As a user with the same session open in two tabs, I want a model change in one
   to appear in the other, so that the two tabs do not disagree about what is
   running.
9. As a user, I want the same for variant, context window and permission mode, so
   that no per-session setting is a silent exception.
10. As a user, I want a permission mode the provider itself flipped mid-turn to
    show up in the picker, so that the picker is not lying about the mode in
    force.
11. As a user changing visibility settings in one tab, I want another tab on the
    same project to follow, so that hidden agents do not reappear in one window.
12. As a user who changed the default model from the CLI, I want an open browser
    tab to notice, so that the CLI and the browser are one system.
13. As a user, I want these updates without a refetch and without dropping the
    socket, so that staying current is not conditional on a network blip.

**Two tabs, two sessions**

14. As a user with two tabs on two different sessions, I want each to show its own
    session, so that opening a second tab does not hijack the first.
15. As a user, I want which session I am looking at to stay a fact about my tab,
    so that no other client can move me.

**Transcripts, errors and retries**

16. As a user whose provider is retrying, I want a transient "retrying, attempt 2,
    next in 4s" indicator on the turn, so that I know it is working rather than
    stuck.
17. As a user, I want that indicator to vanish when the turn completes, so that a
    recovered hiccup leaves no trace.
18. As a user scrolling back, I want no retry noise in my history, so that the
    transcript reads as what happened rather than what was attempted.
19. As a user whose turn genuinely failed, I want to see that failure when I scroll
    back later, so that history is complete.
20. As a user, I want a failed background auto-title to stay invisible, so that an
    operator concern does not interrupt me.
21. As a user who just rewound a session, I want the transcript to actually clear
    and to be told it worked, so that I can trust the rewind happened.

**Terminal**

22. As a user typing in the terminal, I want keystrokes to arrive with no added
    latency, so that moving PTY onto the RPC transport is invisible to me.
23. As a user watching a command produce a lot of output, I want the rest of the UI
    to stay responsive, so that a build log does not freeze my sidebar.
24. As a user reconnecting to a busy terminal, I want the scrollback to come back
    intact, so that a reconnect does not cost me output.

**Instances and projects**

25. As a user with two projects open, I want an instance added in one to appear in
    the other, so that the instance rail reflects the daemon rather than the tab.
26. As a user, I want the project switcher to update when a project is added or
    removed from the CLI, so that the browser and the daemon agree.

**Fork lineage**

27. As a user looking at a forked session, I want its parent and fork point shown,
    so that I can see where it came from.
28. As a user, I want fork lineage to survive a daemon restart and a read-model
    rebuild, so that the relationship does not live or die with a JSON file in my
    config directory.
29. As a user forking an OpenCode session, I want lineage recorded for that fork
    too, so that lineage is not a Claude-only feature.

**Correctness under failure**

30. As a user deleting a session, I want to be told it failed when it failed, so
    that the UI never reports success over a row that is still there.
31. As a user whose projector hit a persistent failure, I want the event log not to
    grow without bound behind my back, so that a bug does not become a disk
    problem.
32. As a user, I want a crash between the append and the projection to be
    impossible rather than patched up on the next read, so that the read model is
    never transiently wrong.

**Maintainer stories**

33. As a maintainer adding a subscription, I want to write one delta source against
    an existing seam, so that a new live surface is an adapter and not a protocol.
34. As a maintainer, I want every subscription to declare its scope as an argument,
    so that changing what "project" means is a change of argument rather than a
    rewrite of every subscription.
35. As a maintainer, I want the projects-span-many-directories change and the
    retire-per-project-relay change to not be blocked by ambient scope, so that
    both stay tractable.
36. As a maintainer, I want to delete `ws-dispatch.ts` rather than reduce it, so
    that there is no "thin push channel" left to accrete new arms.
37. As a maintainer, I want dead channels deleted rather than ported, so that the
    new transport does not inherit nine types nothing produces.
38. As a maintainer, I want the inbound raw path gone once its last message type
    moves to RPC, so that the parse-error and unknown-type machinery dies with the
    thing it existed to reject.
39. As a maintainer, I want one direct read-model write that bumps the row version,
    so that the one column not derived from the event log still announces itself.
40. As a maintainer, I want the daemon fan-out written as one inlined loop with no
    named abstraction, so that when the subscriber set stops being relays the
    change is the collection the loop walks and nothing else.
41. As a maintainer, I want the deletion order recorded, so that nobody deletes the
    protocol-error path before the last inbound message type has moved.
42. As a maintainer, I want the interim fork-metadata join deleted rather than
    replaced, so that ni8.5's safety rule holds with no exception outstanding.

## Implementation Decisions

### The vocabulary this spec builds on (from ni8.5, do not redefine)

- **`Delta<T>`** — one read-model change tagged with its store-global sequence:
  `upsert` or `remove`.
- **`Envelope<T>`** — what a subscriber receives: `snapshot` (cold start, carrying
  the sequence high-water mark its rows reflect), a single `synchronized` boundary
  marker, then deltas.
- **`SubscriptionSource<T, E>`** — the one adapter a concrete delta source
  implements: `snapshot()`, `replay(afterSequence)`, `live()`. The orchestrator
  depends on nothing else: no bus, no database.
- **The orchestrator** owns only the invariants: subscribe-to-live-first,
  high-water-mark dedup by sequence, exactly one `synchronized` marker, cold start
  versus resume, and scope-based teardown. It never inspects the payload.
  **Burst-smoothing is a delta-source concern, not an orchestrator concern.**
- **The version column** collapses three mechanisms into one number: change
  notification, resume point, and high-water-mark dedup.
- **The safety rule** — *a server-side join is safe if and only if the joined field
  only changes alongside an event on that session.* A field that can change with
  no event has no delta to ride on, so a subscription would serve a stale value
  forever.
- **Socket policy** — ni8.5 establishes two sockets split by traffic class: a
  control socket (unary calls plus low-rate subscriptions) and a stream socket
  (session detail, and PTY when it lands). Two is a ceiling, not a starting point.
  No work item below introduces a third socket class.

### Spec-level constraints (load-bearing; each has its own acceptance line)

**C1 — the session status subscription carries a `retrying` state.** It carries
the attempt count and the next-retry time. **Provider retries are never appended
as events.** Without C1 the fork 3.2a fix has nowhere to live, and "delete the
error arm" would delete the retry display instead of relocating it. The codebase
already encodes the terminal/transient distinction and does not use it for
presentation: terminal failures emit alongside `{ type: "done", code: 1 }`;
retries emit with no `done` at all. Root cause of the bug being fixed is one
conversion, `session.status === "retry"` becoming `{ type: "error", code: "RETRY" }`,
at `event-translator.ts:392-402` and again at `domain-event-to-relay.ts:134-138`.
The comment above it — *"Retry messages are translated for immediate user
feedback"* — has the right intent and the wrong vehicle.

**C2 — `last_viewed_at` is a direct read-model write and MUST bump the row version
column.** It is the first read-model column not derived from the event log. The
version column is what the subscription watches; a direct write that does not bump
it is invisible, and the failure is silent. This is exactly the rule an
implementer gets wrong without noticing, which is why it is acceptance and not
prose.

**C3 — every subscription takes its scope as an explicit argument, and tab
independence is a hard constraint.** Scope is never inherited ambiently from the
relay, the runtime, or the connection the subscription happens to be running
inside. Four scopes, one owner each:

| scope | owns | example |
|---|---|---|
| instance | credentials, provider settings | instance list (ni8.14) |
| project | event store, directory set, command gate | project settings (ni8.12), `client_count` (ni8.15) |
| session | provider session, PTY | approvals (ni8.9), plan/todo (ni8.10), PTY (ni8.11), the ni8.12 session columns, `last_viewed_at` (ni8.23) |
| connection | subscriptions themselves | — (nothing survives here; see ni8.15) |

Why it is load-bearing: two changes already in view move what "project" means —
projects will span multiple code directories, and the per-project relay runtime is
slated for removal (`conduit-test-v3cy`). If scope is ambient, both are
architectural rewrites of every subscription. If scope is an argument, both are a
change of argument.

Tab independence: **a subscription belongs to a connection, which is one browser
tab.** Never to a client id, a project, or a user. Two tabs must be able to view
two different sessions without syncing. This works today only because the server
has no notion of "the current session" — it firehoses the project and each tab
filters. The failure mode to prevent is making "current session" into server
state, which syncs tabs irreversibly. This does not conflict with server-owned
`last_viewed_at`: "has this session been seen" is a global fact about the session
and should clear everywhere; "which session is this tab showing" is client state
in the URL. Different facts, no collision.

---

### Work items

One section per existing bead. No new work items are created here.

---

#### `conduit-test-ni8.22` — deterministic id for the OpenCode synthetic `session.created`

**Decision (fork 1.2 = option G).** Give the synthetic event a deterministic event
id derived from the session id, and insert with `INSERT OR IGNORE`.

**Rationale.** The accumulation has a one-line cause that the bead never mentioned
and fork 1.2 missed until the atomicity exploration returned: the event id is
random on every invocation (`opencode-runtime-event-translator.ts:585-607`,
`eventId: createEventId()` at `:590`). `events.event_id` is `TEXT NOT NULL UNIQUE`
(`0001_current_event_store.sql:21`), so the constraint that would have stopped this
is defeated by the fresh id; and `stream_version` is recomputed as
`COALESCE(MAX(stream_version)+1, 0)` inside the append transaction
(`event-store-effect.ts:127`), so `idx_events_session_version` does not catch it
either. The contrasting path already does it right: `claude-event-persist-effect.ts:92-96`
derives `evt_claude_subagent_session_created_${childSessionId}` and uses
`INSERT OR IGNORE` at `:344`. Copy that shape.

**Why it matters at all.** After ni8.17, the OpenCode ingress only promotes
`seenSessions` after a successful ingest, which is what lets a transient projector
failure recover. Under a *persistent* projector failure, every subsequent event
re-synthesizes `session.created`, and because the durable append succeeds while
only the projection rolls back, each retry leaves another row. Growth is bounded
by the provider's SSE rate, which is to say not bounded.

**Rejected.** The previous bead body accepted this as a trade-off requiring a
bounded-reseed policy. No policy, no new table, no atomicity work is needed. This
is independent of ni8.8 and does not wait for it.

**Seam.** No new seam. The existing event-store append interface is the highest
available seam and already the right one — a seam introduced here would have
exactly one adapter, which is a hypothetical seam.

**Acceptance.**
1. The synthetic event id is deterministic per session id.
2. Force a persistent projection failure, drive N provider events, assert exactly
   one `session.created` row in `events` for that session.
3. Transient-failure recovery (the ni8.17 property) still holds.

---

#### `conduit-test-ni8.8` — atomic append + project

**Decision.** Wrap append and projection in one `sql.withTransaction`. Publish to
`SessionEventBus` only after that single commit.

**Rationale and established facts (do not re-derive).**
- Nesting works: `@effect/sql` tracks depth in the fiber context and emits
  `SAVEPOINT effect_sql_<id>` instead of `BEGIN` for depth > 0
  (`@effect/sql/src/internal/client.ts:134-167`).
- Precedent is in tree: `ensureClaudeSubagentSession` wraps everything in
  `sql.withTransaction` (`claude-event-persist-effect.ts:284-370`) and calls
  `projectEvent` at `:368`, which nests as a savepoint. Copy this shape.
- No projector is expensive. All six are pure SQL on the same connection; a grep
  for `fetch|http|tryPromise|readFile|setTimeout|spawn|exec(` across
  `projectors-effect.ts` returns zero hits. The heaviest work is JSON merging on
  metadata columns.
- `projectBatch` already advances every projector's cursor to the batch's last
  event (`:212-216`), so cursor semantics are already batch-scoped and aligned
  with one transaction.
- Blast radius is eight production append sites. Seven already do
  append-then-project as two transactions. One appends deliberately without
  projecting — the `session.provider_cleanup_failed` audit receipt at
  `session-manager-service.ts:729-743` — and stays as it is.

**Also in scope: delete the hand-rolled compensating rollback.**
`session-manager-service.ts:1563-1578` issues a compensating `DELETE FROM sessions`
when establish fails. It is a manual patch for exactly this gap, and it removes the
read-model row but **not** the appended `session.created` event. That deletion is
the proof this bead is right, and removing it belongs here.

**Constraint: publish ordering is load-bearing.** All three publish sites are
*after* projection (`commit-and-signal.ts:46`, `session-command.ts:257`).
Documented at `shell-subscription.ts:20-23`: *"Re-query is sound because every
producer choke point projects BEFORE it publishes: at signal time the row already
reflects the signalling event."* Preserve this. Note that `applySessionCommand` is
**not** wrapped in `Effect.uninterruptible`, unlike `commitAndSignal` (`:33`).

**Hazard to carry into implementation.** Two `better-sqlite3` connections open the
same file: the Effect layer (`live.ts:68`) and the legacy sync path
(`orchestration-wiring.ts:144-147`, for `DurableCommandCommitRepository`). Savepoint
nesting cannot span them and they contend for the SQLite write lock. Mitigating:
the only production caller passes `events: []`
(`orchestration-engine.ts:500-511`), so it appends no canonical events today.

**Explicitly NOT in scope: making the projector total.** Fork 1.2 option E was
rejected. `recover()` (`projection-runner-effect.ts:311-344`) already logs, records
the failure, writes `projection_failures`, and advances the cursor past the failed
event — on **replay**. The live path is deliberately the opposite
(`:152-159`): *"Failures propagate. A caller here is applying one known event and
can act on the result — a user deleting a session must not be told it worked when
the row is still there."* And `session-command.ts:161-164`: *"The local write is
authoritative and strict — if the projection fails, so does this effect."* Option E
means reversing a documented, deliberate policy, i.e. making the live path as lossy
as replay. `projection_failures` being write-only in production — exactly one
writer at `projection-runner-effect.ts:331-335`, zero readers in `src/`, the only
`SELECT`s are in three test files, and `getFailures()` at `:385-386` returns an
in-memory ring capped at 100 with no production caller — is real, confirmed, and a
separate bead.

**Seam.** The existing persistence choke point (event store append + projection
runner). Highest available seam; the deletion test passes because if the
transaction wrapper is removed the `recover()`-on-the-read-path complexity
reappears in every reader.

**Acceptance.**
1. Append + project is observably atomic: a kill-between-transactions test no
   longer produces a projector gap.
2. `recover()` is no longer needed on the live path (it may remain for
   legacy/backfill).
3. The compensating `DELETE FROM sessions` at `session-manager-service.ts:1563-1578`
   is gone.
4. Publish still happens strictly after projection at all three sites.

---

#### `conduit-test-ni8.24` — event-source the fork point, delete the sidecar

**Decision (fork 1.4 = option G).** One migration writes `parent_id` and
`fork_point_event` into the `sessions` rows from `~/.conduit/fork-metadata.json`,
then the sidecar is deleted.

**Rationale.** The event log stays honest: no event claims a time it was not
appended at, so ADR-0004 is untouched. A migration writing a projection is
ordinary — that is what migrations do. It is one-shot with no lingering sidecar
reader, so there is no dual-source period to reason about. And it writes exactly
the columns the subscription already reads, so ni8.5's interim join is *deleted*
rather than replaced.

**Why this is load-bearing, not tidy-up.** `forkPointTimestamp` comes from a live
provider REST call made at fork time and written out-of-band; it never enters the
event log and is not backfillable from it. `sessions.fork_point_event` is never
written in production — nothing in `src/` writes it and the session projector
explicitly preserves rather than sets it. OpenCode forks never receive `parent_id`
at all: `establishOpenCodeSession` appends `session.created` without a parent, so
the link exists only in that JSON file. ni8.5 ships an interim server-side join
from the in-memory fork-metadata `Ref` so the subscription is not lossier than the
`ListSessions` call it replaces, and that join is a knowing violation of ni8.5's
own safety rule. This bead is its expiry condition.

**Also in scope.** New forks must write `parent_id` and `fork_point_event` at fork
time on **both** provider paths, not just the Claude subagent path. A migration
that fixes history but leaves the OpenCode path writing nothing re-opens the hole
on the next fork.

**Rejected.** Option D — synthesising canonical fork events at migration time dated
at the original fork time — is disqualified outright: ADR-0004 makes the event log a
record of what happened when, and a synthesised 2026-07 event appended in 2026-09
is a lie in the one place that must not lie. Option E (synthesise dated now, marked
`backfilled`) is honest but orders every synthetic event after everything it
preceded. Option B (no backfill at all) was the recommendation until the user's
standing preference for the better product settled it.

**Seam.** The migration plus the fork write path, verified through the existing
session subscription: fork fields arrive on the session envelope with no
fork-metadata `Ref` in the graph. Testing at the subscription is the highest seam
because it is where the fields are consumed.

**Acceptance.**
1. A migration populates `sessions.parent_id` and `sessions.fork_point_event` from
   the sidecar, and `~/.conduit/fork-metadata.json` is deleted afterwards. Nothing
   in `src/` reads it.
2. A new fork on the OpenCode path writes `parent_id` and `fork_point_event`; so
   does a new Claude fork.
3. ni8.5's interim server-side join from the fork-metadata `Ref` is deleted, and
   ni8.5's safety rule holds with no exception remaining.
4. No new event type is appended and no event is back-dated.

---

#### `conduit-test-ni8.9` — approvals subscription

**Decision.** A projection-backed `SubscriptionSource` over the `pending_approvals`
read model, re-querying the changed row(s) on a bus event and emitting
`upsert`/`remove`. Low rate, so it is a safe multiplex tenant on the control
socket alongside unary calls and shell.

**Arms retired (5).** `permission_request`, `permission_resolved`, `ask_user`,
`ask_user_resolved`, `ask_user_error`.

**Scope (C3).** SESSION-scoped, taken as an explicit argument.

**Relationship to ni8.23.** ni8.23 derives notification state from the same
`pending_approvals` table, indexed on `(session_id, status)`. Both read the same
source; neither owns it. Keep the query shape shared rather than duplicated, but
do not couple the beads: ni8.23's concern is notification state on its own seam,
this bead's is the approvals list itself.

**Seam.** The existing `SubscriptionSource` interface. This is the third adapter
across that seam (detail, shell, approvals), so the seam is demonstrably real
rather than hypothetical. Tested through `ReadModelSubscription`'s interface with
a fake bus and a fake snapshot query — no WS, no RPC. Prior art:
`test/unit/relay/shell-subscription.test.ts`.

**Acceptance.**
1. The adapter is wired into `ReadModelSubscription`.
2. Raise an approval, resolve it; assert `snapshot → synchronized → upsert →
   remove` with no duplicate by sequence.
3. The five arms are retired from `ws-dispatch`.
4. The subscription's scope is a parameter, verifiable by calling it with a scope
   it does not ambiently sit in.

---

#### `conduit-test-ni8.10` — plan and todo subscriptions

**Decision.** Projection-backed delta source(s) for plan-mode state and the
todo/activity panel: re-query the plan/todo projection row(s) on relevant bus
events, coalesced like shell because these are low-rate. If plan and todo project
to the same session-scoped row set, one adapter with two snapshot queries; if not,
two thin adapters.

**Arms retired (5).** `plan_enter`, `plan_exit`, `plan_content`, `plan_approval`,
`todo_state`.

**Scope (C3).** SESSION-scoped, explicit argument.

**Seam.** The same `SubscriptionSource` seam; fourth adapter. Coalescing lives in
the delta source, per the orchestrator's stated contract that burst-smoothing is a
delta-source concern.

**Acceptance.**
1. Adapter(s) wired.
2. Plan enter → content → approval → exit, and a `todo_state` update, each land as
   ordered upserts.
3. The five arms are retired.
4. Scope is a parameter, not ambient.

---

#### `conduit-test-ni8.11` — PTY over `stream: true` with 50 ms coalescing

**Decision (fork 2.4 = option D).** PTY moves to a `stream: true` RPC member on the
existing ni8.5 socket policy — no third socket class — **plus a 50 ms coalescing
window**. The previous bead body specified a dedicated second socket and was wrong.

**Why coalescing is part of the decision, not an optimisation.** PTY has zero
batching, throttling or coalescing anywhere today: one broadcast per `onData`
callback (`terminal-service.ts:274-277`), one `xterm.write` per message inline
(`TerminalTab.svelte:79-81`). The caps that exist are retention, not rate — 50 KB
scrollback rings on both ends. `@effect/rpc`'s `supportsAck: true` makes the server
block after every chunk until the client acks, so an unbatched byte firehose under
ack becomes one network round trip per write, which is **strictly worse than the
raw socket it replaces**. The exact window already exists, written and wired to
nothing, at `shell-subscription.ts:66` (`SHELL_COALESCE_WINDOW = Duration.millis(50)`)
and `:194` (`Stream.groupedWithin`).

**The head-of-line premise behind the old "own socket" body is retracted.** ni8.7's
spike (closed 2026-07-31) **disproved** socket-wide HOL blocking:
`Socket.fromWebSocket` forks each frame into a `FiberSet`, so a full mailbox blocks
only its own stream's response fiber. The surviving justification for any socket
split is blast radius, which ni8.5 already settled at two sockets. Nothing in the
repo has ever measured `pty_output` rate or size.

**`pty_input` is the load-bearing half, and the old body never mentioned it.** It
is the **only** remaining non-RPC inbound message type in the entire protocol
(`ws-router.ts:10-13`, `handlers/index.ts:60-66`); `VALID_MESSAGE_TYPES` holds
exactly one entry. When this bead lands that set empties and the raw inbound socket
has nothing left to carry. That is what makes the protocol-error category *vanish*
rather than get ported: the `PARSE_ERROR` and unknown-type `system_error` paths at
`effect-ws-handler.ts:306-326` exist only to reject inbound raw messages.

**Arms retired.** Outbound: `pty_list`, `pty_created`, `pty_output`, `pty_exited`,
`pty_deleted` (5). Inbound: `pty_input`.

**Known property of PTY to preserve or deliberately change.** PTY is currently
project-scoped, not session-scoped: `PtyManager` is one map per relay
(`pty-manager-layer.ts:25`), `pty_output` broadcasts to every client of the project
and carries no `sessionId`, and reconnect replays the whole ring as one ~50 KB
frame (`pty-manager.ts:96-100`). The subscription is SESSION-scoped by C3 — the
session owns its PTY — so this is a change in delivery scope and must be handled
explicitly, not inherited.

**Delta source.** Snapshot is the current PTY list/state; live is raw PTY events by
sequence. Reuse the detail delta source (raw passthrough, not re-query) with a PTY
filter; the differences are the snapshot query and the coalescing window.

**Seam.** `SubscriptionSource` (detail-shaped) for the outbound stream, and the
existing WS-RPC group for inbound `pty_input`. Both are existing seams; the
coalescing is asserted at the adapter seam, where the window lives.

**Acceptance.**
1. PTY streams over `@effect/rpc` with a 50 ms `groupedWithin` window, on the
   ni8.5 socket policy, with no third socket class introduced.
2. `pty_input` arrives as an RPC call; `VALID_MESSAGE_TYPES` is empty and the
   allowlist is deleted.
3. A `pty_output` storm does not stall unary calls or the sidebar. Prove it:
   measure round trips under a sustained write and show coalescing is actually
   engaged, not one ack per write.
4. The five outbound arms are retired.
5. PTY delivery scope is session-scoped by explicit argument (C3).

---

#### `conduit-test-ni8.12` — capability/config arms: three delete, six are peer-notification facts

**The previous framing was wrong.** This is not a pull sweep. The push→pull
conversion happened long ago: every client→server request the bead described is
already an RPC method. What remains are orphaned push arms, and two thirds of them
are not pulls at all.

**Group 1 — already pure RPC, the push arm is dead weight (3).** `agent_list`
(→ `GetAgents`), `model_list` (→ `GetModels`), `command_list` (→ `GetCommands`).
Delete the arm, nothing else changes.

**Group 2 — the six holes, where deleting the arm loses a fact nothing else
carries.**
1. `default_model_info` — sole carrier of `defaultModelId` / `defaultProviderId` /
   `defaultVariant`. `GetModelsResponseSchema` (`ws-rpc.ts:198-208`) has `active`
   but no `default*` fields. One producer is IPC/CLI (`relay-stack.ts:517`), so no
   browser action can trigger a refetch.
2. `visibility_info` — one broadcast (`handlers/visibility.ts:70`). The read path
   refetches only on connect, on session switch, or when the Settings tab opens
   with empty lists. A second tab goes stale silently.
3. `permission_mode_info` — `domain-event-to-relay.ts:167-172` fires on the Claude
   SDK's own `session.permission_mode_changed` mid-turn. Nothing else tells the
   picker the mode flipped.
4. `model_info` / `variant_info` / `context_window_info` — sent via `sendToSession`
   *specifically* to reach other clients viewing the same session. The initiating
   client learns from its own RPC response; peers learn from nothing.

**Every one of the six is a peer-notification problem, not a request/response
problem.** Some other actor — another tab, the CLI, the provider itself — changed a
fact, and this client has no way to hear about it. That is precisely what a
subscription is for, which is why a pull sweep would have silently deleted six live
facts.

**Decision (fork 2.2 = A + C).**
- **A, for the four per-session facts.** `model_info`, `variant_info`,
  `context_window_info` and `permission_mode_info` become **columns on the session
  read-model row**. They change only alongside an event on that session, so ni8.5's
  safety rule holds and the existing session subscription carries them with no new
  stream.
- **C, for the two project-global facts.** `default_model_info` and
  `visibility_info` are not per-session and would be duplicated onto every session
  row under A. They get their own small **project-settings subscription**.

**Rejected.** B (one combined settings blob) loses per-field versioning and forces a
full re-render on any change. D (leave them on the push channel) keeps
`wsMessageStream` alive, which ni8.16 exists to kill.

**Also found, fix or file.** Seven handlers are defined, some re-exported, and
**unreachable** — absent from the dispatch table: `handleGetFileList`,
`handleGetFileContent`, `handleGetFileTree`, `handleGetCommands`, `handleGetAgents`,
`handleGetProjects`, `handleSwitchContextWindow`.

**Invalidation context worth knowing.** The strongest surviving invalidation signal
is WS reconnect → `onConnect` (`ws.svelte.ts:264`, handler
`ChatLayout.svelte:340-395`), which refetches seven RPCs but requires an actual
socket drop. Second is `switchToSession` (`session.svelte.ts:493-505`). Note that
`session_switched` triggers **no** refetch, so a server-initiated switch
invalidates nothing (`ws-dispatch.ts:771-871`).

**Scope (C3).** The four columns ride the SESSION-scoped subscription; the
project-settings subscription is PROJECT-scoped. Both take scope as an explicit
argument.

**Seam.** Two: the existing session (shell) `SubscriptionSource` for the four
columns — no new seam, they are columns on a row that is already streamed — and a
new project-settings `SubscriptionSource`, which is the fifth adapter across the
same seam.

**Acceptance.**
1. `agent_list`, `model_list`, `command_list` push arms are deleted; the RPCs
   remain authoritative.
2. The four per-session facts are columns on the session row and arrive via the
   existing session subscription. Changing one in tab A is visible in tab B viewing
   the same session, with no refetch and no reconnect.
3. `default_model_info` and `visibility_info` arrive via a project-settings
   subscription. Changing visibility in one tab is visible in another tab on the
   same project.
4. A CLI/IPC-originated model change (`relay-stack.ts:517`) reaches an open browser
   tab.
5. No push arm remains for any of the nine types in `ws-dispatch`.

---

#### `conduit-test-ni8.13` — delete seven orphaned arms, route `file_changed`

**The previous framing was wrong.** This bead described moving seven payloads to
unary RPC. They are already there. This is pure deletion plus one routing decision.

**Already pure RPC, the push arm is dead weight (3).** `file_tree` → `GetFileTree`,
`file_list` → `GetFileList`, `file_content` → `GetFileContent`.

**Already frontend-synthesized from an RPC response (2).** `history_page`
(`HistoryLoader.svelte:97-110`) and `scan_result` (`instance.svelte.ts:120-127`) —
the "push" is the frontend calling `handleMessage` on itself. No server producer
exists.

**Fully dead, both ends (1).** `file_history_result` — no producer anywhere, and
its listener list has zero subscribers.

**Dead, and a real behavioural bug (1).** `rewind_result` — no producer.
`RewindSession` returns `{ok:true}` only, so `ChatLayout.svelte:453-461` (the
post-rewind `clearMessages()` plus toast) **can never fire**. That is a live bug,
not dead code. Deleting the arm without fixing the behaviour ships the bug
permanently. **This bead depends on `conduit-test-voya`**, which owns the fix:
`RewindSession`'s reply carries what the UI needs and the clear is driven from the
RPC response.

**`file_changed` — the one routing decision.** It is a relayed OpenCode SSE event
(`event-translator.ts:530-545`), **not** an fs-watch; there is no filesystem watcher
in conduit at all (zero hits for `chokidar|fs.watch|FSWatcher`). It fans out to
`fileBrowserListeners` and `fileHistoryListeners`, but both subscribers filter on
`file_list` / `file_content` and the second list is empty, so `file_changed` has
**zero effective consumers today**. Side effect to trace before deleting: it is
deliberately absent from `METADATA_TYPES` (`poller-pre-filter.ts:7-34`), so removing
it changes poller batch classification.

**Seam.** Deletion is asserted at the type/schema seam (the `RelayMessage` union)
plus the existing poller-pre-filter unit seam for the classification consequence.
`rewind_result` is asserted at the WS-RPC contract seam
(`test/unit/contracts/ws-rpc-contract.test.ts` prior art), because the behaviour
moves into the RPC reply.

**Acceptance.**
1. All seven arms are removed from `ws-dispatch` with no behaviour change, except
   `rewind_result`.
2. `rewind_result`: the post-rewind clear and toast work via the RPC response, per
   `conduit-test-voya`.
3. `file_changed` has an explicitly decided home, and the
   `METADATA_TYPES`/poller-pre-filter classification consequence is checked and
   stated.
4. The unreachable handlers that overlap with ni8.12 (`handleGetFileList`,
   `handleGetFileContent`, `handleGetFileTree`) are deleted rather than left
   defined-and-unreachable.

---

#### `conduit-test-ni8.14` — instance and project state: two arms, daemon fans out

**The previous body assumed a read model and a bus. Neither exists.**

**There is nothing for a `ReadModelSubscription` to subscribe to.** `instance_list`
and `project_list` are read straight out of in-memory `Ref<HashMap>` state seeded
from `~/.conduit/daemon.json` (`instance-manager-service.ts:86-95`,
`project-registry-service.ts:117-120`). Not SQLite, not the event store.

**`instance_status` has no production producer at all.** A repo-wide grep for
`type: "instance_status"` finds the schema, the frontend handler
(`instance.svelte.ts:169-190`), and tests. The only server-side `instance_status` is
a daemon **IPC** command (`ipc-protocol.ts:177`), CLI-to-daemon, never on the WS. So
"three arms" is really two; delete `instance_status` outright.

**A daemon event bus exists and reaches nobody.** `DaemonEventBusTag` is a
`PubSub.sliding(256)` over a 12-variant tagged enum (`daemon-pubsub.ts:14-41`) with
exactly three subscribers: a config-flush filter, a one-shot `waitForRelay` filter
on slug, and relay session-lifecycle wiring. Nothing subscribes to `InstanceAdded`,
`InstanceRemoved`, `InstanceError`, `StatusChanged`, `VersionUpdate`,
`DiskSpaceLow` or `DiskSpaceOk` — those publishes land in a sliding buffer and are
dropped. Worse: each relay gets its own private bus under the same tag.
`RelayStateLive` merges `DaemonEventBusLive` (`relay-layer.ts:9,31`) and each relay
builds its layer graph fresh in its own `ManagedRuntime` (`relay-stack.ts:860`), so
`DaemonEventBusTag` inside a relay is a **namesake**, not the daemon's bus. Daemon
state crosses into a relay only as injected Promise-returning callbacks
(`relay-factory-layer.ts:183-265`): no Tag, no PubSub, no Ref.

**Decision (fork 2.5 = C, fan out).** The daemon publishes once and each subscriber
receives. No daemon Tag crosses the relay boundary.

**Rationale.** A (plumb the daemon `PubSub` through the relay's `ManagedRuntime`)
and C produce identical user-visible behaviour, so the standing "always take the
better product" preference has nothing to buy between them, and the decision is
purely which shape ages well. The recorded architecture history settles it: the
per-project `ManagedRuntime` is not a design principle and was never decided — it
fell out of `createProjectRelay` already being called once per project during the
Effect migration, and `docs/agent-guide/architecture.md:53` classifies it as a
*"compatibility edge"*, while
`2026-05-16-effect-ts-remaining-ownership-breakdown.md:359` sets the exit criterion
*"No new app-internal `ManagedRuntime` usage appears outside public startup
adapters."* A is an investment in a boundary being removed; C is a loop that gets
deleted when the boundary goes. A is not a stepping stone to C — it threads the
daemon `PubSub` through the very callback bundle that unification removes.

**Implementation note that is part of the decision, not a detail.** Write the
fan-out as a **single inlined loop over the current subscriber set. No helper, no
`RelayBroadcaster`, no named abstraction.** When the subscriber set stops being
"relays" and becomes "connections" (`conduit-test-v3cy`), the change must be the
collection the loop walks and nothing else. A named abstraction here calcifies the
wrong noun.

**Rejected.** E (defer into the relay-unification bead) was legitimate and was
declined because the residue arms block ni8.16, and ni8.16 blocks the deletion of
`wsMessageStream`.

**Existing bugs to name.** `wsHandler.broadcast` is relay-scoped
(`relay-stack.ts:831`), so an `instance_list` broadcast reaches only clients on
`/p/<that-slug>/ws` even though instances are daemon-global — a second project's tab
never learns. And `ProjectInfo.clientCount` is declared and rendered
(`ProjectSwitcher.svelte:390,458`) but no server code ever sets it.

**Scope (C3).** The instance list is INSTANCE-scoped (it owns credentials and
provider settings); the project list is daemon-global. Both take scope as an
explicit argument.

**Seam.** The daemon→relay fan-out call site — deliberately *not* a named seam,
because the decision forbids one. The highest testable seam is the daemon boundary
itself: register two projects, change instance state via one, and assert a
connection on the other receives it. The `SubscriptionSource` seam does **not**
apply here; there is no read model behind these arms.

**Acceptance.**
1. `instance_status` is deleted; two arms remain.
2. The instance rail and project switcher update in a tab on project A when the
   change originated on project B or from the CLI.
3. The fan-out is one inlined loop with no named abstraction around it.
4. The relay-scoped-broadcast bug is fixed or explicitly filed.

---

#### `conduit-test-ni8.15` — the residue is one arm, not ten

**The previous body was wrong twice.** It claimed ten arms must stay push and that
a thin push channel survives migration. The count was ten, then three, and is now
**one**. No push channel survives.

**The ten, by verdict.**

| Arm | Verdict |
|---|---|
| `banner` | No producer anywhere in the repo. Dead channel, delete. |
| `skip_permissions` | No producer anywhere in the repo. Dead channel, delete. |
| `proxy_detected` | No server producer; synthesized client-side from the `DetectProxy` RPC reply (`instance.svelte.ts:71-78`). Vestigial, delete. |
| `instance_status` | Dead (see ni8.14). Delete. |
| `update_available` | Path (a) never fires — the real daemon never supplies `versionCheck`, so `daemon-layers.ts:811-816` installs the null stub. Path (b) is OpenCode-SSE only. Delete; version notification, if wanted, is new work, not a port. |
| `input_sync` | Client-initiated, server-relayed. Already an RPC in disguise. Not server-originated, so not residue. **See "Unassigned" — its server→client fan-out has no declared home after ni8.16.** |
| `system_error` | Deleted entirely (fork 3.2). |
| `error` | Deleted entirely (fork 3.2). |
| `connection_status` | Deleted (fork 3.1 = C). |
| `notification_event` | Split by fork 1.3: state (derived, arm deleted) and alert (routed via push, see ni8.23). |

**What survives: `client_count`.** Genuinely server-initiated — an in-memory
`Set<clientId>`, pushed on connect/disconnect, with no RPC exposing it.
PROJECT-scoped. It becomes **one** new member on a project-scoped subscription.
That is the entire residue.

**Why `connection_status` deletes (fork 3.1 = C).** The client owns its own socket.
`@effect/rpc` over `Socket.layerWebSocket` already surfaces open, close and failure
client-side. This arm is the server telling you something you already know.

**Why 2.3 = A was reopened.** Round 2 answered the residue with one project-scoped
member carrying all three then-surviving arms. The scope taxonomy adopted at the end
of Round 2 (C3) invalidated it: `client_count` is project-scoped,
`connection_status` is connection-scoped, and the ding is session-scoped. One member
cannot carry three scopes without over-delivering or inventing a union grab-bag.
Rejected alongside it: B (three members — correct, but ports arms that should die);
D (fold the ding into the session stream — partly undoes fork 1.3, because a
reconnect replays the snapshot and can re-fire the ding); E (one connection-scoped
multiplexed feed — the right long-term shape, but it is literally the "single
canonical activity feed" that
`2026-05-11-effect-ts-mainline-completion-plan.md:39` names as the trigger to redo
the relay model, so it belongs in `conduit-test-v3cy`, not here).

**Why `error` and `system_error` both delete (fork 3.2 = B + E).** Five producers in
four categories; three dissolve with no decision needed.
1. **Protocol errors** (`effect-ws-handler.ts:306-326`) — unparseable JSON, unknown
   message type. They exist only to reject inbound **raw** messages.
   `VALID_MESSAGE_TYPES` holds exactly one entry, `pty_input`, and **ni8.11 moves
   it to RPC**. After ni8.11 there are zero inbound raw types left to reject. The
   category dies with the socket.
2. **Errors already inside a `messages: []` array** (`event-translator.ts:401,722`,
   `domain-event-to-relay.ts:120,137`) — message parts, not transport signals. Never
   were an arm.
3. **Turn errors** (`provider-turn-service.ts:520`) — carry a `sessionId`. Real.
   Resolution **B**: appended as canonical events and delivered as content. Replay
   becomes correct rather than hazardous, because "this turn failed" *is* history.
   Reuses the existing `turn.error` shape; no new event type.
4. **Request-reply errors** (`tool-content.ts:26,45`) — become the typed RPC error
   channel. Free.
5. **Background-task errors** (`session-title-service.ts:309`) — resolution **E**:
   logged, never surfaced. A failed background auto-title is an operator concern.

An escape-hatch `system_error` member was generated and found unnecessary: after
categories 1, 2 and 4 dissolve, no surviving error lacks a session. Relay startup
failures predate any client; projection failures already land in
`projection_failures`.

**The retry refinement (fork 3.2a) — raised by the user mid-fork, and easy to get
wrong.** Appending terminal errors as events is only safe if **retries are not
appended**. Today retries are rendered as errors in the chat log
(`conduit-test-j6zn`): `event-translator.ts:392-402` and
`domain-event-to-relay.ts:134-138` both convert `session.status === "retry"` into
`{ type: "error", code: "RETRY" }` — a status turned into content. Appending that
as an event would fossilise a recovered hiccup in the user's history and replay it
on every cold load.

The cut is **two axes**, not one:
- **terminal vs transient** decides *content or status*
- **foreground vs background** decides *shown or logged*

Applied: turn failed = terminal + foreground → **content**, appended, replays.
Retry in progress = transient + foreground → **status**, never persisted, never
replays. Auto-title failed = terminal + background → **log only**. That covers all
five producers with nothing left over, and it preserves the original
immediate-feedback intent: the user still sees "retrying, attempt 2, next in 4s",
rendered as a status indicator on the turn rather than an error bubble in the
transcript, and it vanishes when the turn completes. **This is spec constraint C1.**

**Scope (C3).** `client_count` rides a PROJECT-scoped subscription, taken as an
explicit argument. Tab independence is a hard constraint.

**Seam.** The project-scoped `SubscriptionSource` (sixth adapter) for
`client_count`; the session status subscription for the `retrying` state — an
existing stream gaining a state, not a new seam. Deletions are asserted at the
schema seam: the types are gone from the `RelayMessage` union, so a reintroduction
fails to compile rather than failing a grep.

**Acceptance.**
1. Exactly one new member exists (`client_count`) and it is project-scoped by
   argument.
2. `banner`, `skip_permissions`, `proxy_detected`, `instance_status`,
   `update_available`, `connection_status`, `error` and `system_error` are all gone
   from the schema, the server and `ws-dispatch`.
3. The notification ding fires via push notifications and works with the tab
   backgrounded (see ni8.23).
4. **(C1)** A provider retry renders as a transient status on the turn carrying
   attempt count and next-retry time, is **not** written to the event log, and is
   absent after a page reload. A terminal turn failure **is** written and **is**
   present after reload.
5. No "thin push channel" remains. There is nothing left for `wsMessageStream` to
   carry.

---

#### `conduit-test-ni8.23` — split `notification_event`: badge state is derived, the ding goes via push

**The finding that reframed this.** `notification_event` is already two things
wearing one name, which is exactly why the reducer at `ws-dispatch.ts:713-732`
needed a `reconcile` action:
- **STATE**: a badge. Must be re-derivable on every reload.
- **ALERT**: a ding. Must fire exactly once and never on replay.

One message carrying both cannot satisfy both rules. The reducer's own type already
half-discovered this: `notification-reducer.svelte.ts:16-19` distinguishes
`{ kind: "attention"; questions; permissions }` — both server facts, both durable in
`pending_approvals` — from `{ kind: "done-unviewed" }`, which has no server fact
behind it at all, and the reducer's `reconcile` arm says so in a comment at `:123`.

**Decision 1.3 = E + G — delete the reducer.** The reducer's whole job is
reconciling push arms that arrive out of order, and `reconcile` is the tell. A
subscription delivers snapshot-then-deltas in order, so there is nothing left to
reconcile and the reducer is dead weight. The badge arm is deleted outright,
because all three notification facts become server-derived; the alert becomes a
fire-once side effect.

**Decision 1.3b = C — server-owned viewing.** Chosen on the standing preference
*"I always want the better product even if it's harder to get there"*, then found
**cheaper than priced**. conduit is single-tenant: `src/lib/auth.ts` is a single
shared PIN (`hashPin`/`verifyPin`, `AuthManager`) and there are **zero** occurrences
of `userId` / `user_id` / `principal` anywhere in `src/lib/server`,
`src/lib/domain/server` or `src/lib/daemon`. So no durable browser client id is
needed: `last_viewed_at` is one nullable column on `sessions`, and viewing anywhere
clears the badge everywhere.

Consequences: (a) the client-local viewed-set disappears — all three notification
facts are server-derived; (b) `last_viewed_at` changes only alongside a view of that
session, so ni8.5's safety rule holds and the session subscription stays shareable
across clients with no per-client join; (c) the trigger already exists at
`handlers/session.ts:419-423` — it currently broadcasts and needs to write instead.

**Decision 2.1 = B — a direct read-model write, not a canonical event.** ADR-0004
governs session *mutations*. Viewing a session does not change the session, so it
is outside the ADR's scope rather than an exception to it. Appending a
`session_viewed` event would write to the log on the single highest-frequency user
action in the app, for entries no projector needs to replay. **This is the one place
the spine rule has to do defensive work**, and it is consistent because viewing is
state, not history: nobody scrolling back wants to see when they looked at
something.

**Named cost, accepted, and easy to get wrong silently — this is C2.**
`last_viewed_at` is the first read-model column not derived from the event log. It
**MUST** still bump the row's version column, or the ni8.5 subscription will not
notice the change.

**Decision 3.1 = F — the ding goes through push notifications, not the WS.** conduit
already has push infrastructure. Fire-once is native to it, and it reaches the user
when the tab is backgrounded or closed, which a WebSocket never will. This is the
better-product answer, not merely the cheaper one. **Accepted cost, stated
explicitly by the user: two code paths for one signal** — an in-app ding when the
tab is focused and push when it is not. An OS notification for a session you are
staring at is bad UX, so the split is real work and not an implementation detail.

**The count itself.** Today it lives in an in-memory `Ref` in the session manager,
so it does not survive a daemon restart. It is already durable in
`pending_approvals`, indexed on `(session_id, status)`, so it is derivable with zero
migration and the restart-safety hole closes as a side effect. ni8.9 reads the same
table.

**Scope (C3).** `last_viewed_at` is SESSION-scoped state on the session row. No
conflict with tab independence: "has this session been seen" is a global fact about
the session and should clear everywhere; "which session is this tab showing" is
client state in the URL. Different facts.

**Seam.** The read-model write path for `last_viewed_at`, verified **through an open
ni8.5 subscription** — that is the highest seam and it is also the acceptance,
because the failure mode of C2 is silence. The badge count rides ni8.9's approvals
adapter (shared query shape, not shared bead). The ding crosses the existing push
seam.

**Acceptance.**
1. The streamed session type no longer carries `pendingQuestionCount`.
2. The notification reducer at `ws-dispatch.ts:713-732` is deleted, along with its
   `reconcile` action.
3. **(C2)** `last_viewed_at` exists as a nullable column on `sessions`, is written
   directly with no canonical event, and the write **bumps the row version**. Test
   this explicitly: write `last_viewed_at` and assert an open ni8.5 subscription
   emits.
4. The badge count derives from `pending_approvals`, not a `Ref`. Restart with
   outstanding approvals and assert the count is non-zero with no new events.
5. Viewing a session in tab A clears its badge in tab B.
6. The ding fires via push, arrives with the tab backgrounded, fires exactly once,
   and does not re-fire on reload or reconnect.

---

#### `conduit-test-ni8.16` — closeout

**Decision.** After every subscription, deletion and residue item above lands,
remove the hand-rolled dispatch machinery and the legacy relay-message WebSocket.
**`ws-dispatch.ts` is deleted, not reduced.**

**What changed since the original body.** The original said the closeout leaves
"only the intentional meta-signal channel". There is no such channel. ni8.15's
residue is one arm and it becomes a member on a project-scoped subscription.
Likewise `VALID_MESSAGE_TYPES` empties when ni8.11 moves `pty_input` to RPC, so the
inbound raw path goes too, and with it the `PARSE_ERROR` / unknown-type handling at
`effect-ws-handler.ts:306-326`.

**Why there is no partial-migration seam.** `wsMessageStream`
(`transport/runtime.ts:104-158`) has exactly one production consumer
(`ws.svelte.ts:303-344`) and no per-type routing upstream. It is inseparable from
the single `_ws`: deleting it also removes `hasActiveStreamFiber()`
(`runtime.ts:72-74`), the PWA resume-reconnect liveness signal
(`ws.svelte.ts:384`), the self-heal branch (`:312-327`) and `handleProtocolError`.
Those capabilities must be re-established on the RPC transport or explicitly
retired as part of this item.

**Work.**
1. Delete the retired `handleMessage` switch arms and the two-tier router in
   `ws-dispatch.ts`. All of it, not a residue.
2. Retire `wsMessageStream`; the single `_ws` dies with it.
3. Delete the inbound raw path: `VALID_MESSAGE_TYPES`,
   `parseIncomingMessage`/`routeMessage`, and the `PARSE_ERROR` / unknown-type
   `system_error` responses.
4. Remove now-dead `RelayMessage` variants and the `GLOBALLY_COORDINATED_TYPES`
   coordination that subscriptions subsumed.
5. Frontend gate: `pnpm acceptance:visual` green.

**Seam.** The transport edge as a whole. The assertion is **absence**, proved
against the enumerated arm table rather than by spot-check, plus the visual
acceptance gate for the frontend consequence.

**Acceptance.**
1. `ws-dispatch.ts` is deleted, not reduced.
2. `wsMessageStream` is removed; the single `_ws` dies with it.
3. Every previously-listed arm is provably rehomed or provably deleted, enumerated
   against the table in this spec. Do not spot-check.
4. No dead `RelayMessage` variants remain.
5. `pnpm check`, `pnpm lint`, `pnpm test:unit` and `pnpm acceptance:visual` are
   green.

---

### Ordering and dependencies

**The deletion order is load-bearing: ni8.11 → ni8.15 → ni8.16.**

- **ni8.11 must land before ni8.15** because the `system_error` deletion depends on
  `pty_input` moving to RPC. `VALID_MESSAGE_TYPES` holds exactly one entry; the
  protocol-error category at `effect-ws-handler.ts:306-326` exists only to reject
  inbound raw messages. Delete `system_error` first and you delete error handling
  for a path that is still live.
- **ni8.15 must land before ni8.16** because ni8.16's acceptance is that nothing is
  left for `wsMessageStream` to carry. Until the residue is down to one member on a
  subscription, the stream still has a job.
- **ni8.16 is last overall**, gated on ni8.9, ni8.10, ni8.11, ni8.12, ni8.13,
  ni8.14 and ni8.15.
- **ni8.13 depends on `conduit-test-voya`** (the post-rewind UI reset that can never
  fire). Deleting the `rewind_result` arm before voya fixes the behaviour ships the
  bug permanently.
- **ni8.24 depends on `conduit-test-ni8.5.15`** (the interim fork-metadata join),
  which it deletes.
- **ni8.22 is independent of ni8.8** and of everything else; it is one line.
- **ni8.8 has no dependency on the transport items** and can land at any point;
  it is the one persistence item that the subscriptions do not wait on.

### The contradiction the grill resolved, recorded so it is not reopened

ni8.15 said ten arms must stay push; ni8.16 said `wsMessageStream` dies. If the
residue rode `wsMessageStream`, ni8.16 could not pass its own acceptance. **ni8.15's
count was the thing that was wrong**, not ni8.16's acceptance. Four dead channels
delete outright, three are already RPC or client-synthesized, `input_sync` is an RPC
in disguise, `connection_status` is state the client already holds, and the ding
moves to push. One arm survives and it becomes a subscription member.

## Testing Decisions

**What makes a good test here.** It asserts externally observable behaviour at an
interface — an envelope sequence a consumer receives, a store's settled state, the
number of rows in `events`, whether a badge is present after reload — never a call
count, an internal field name, or the shape of a private fold.

**Seam discipline for this spec.** The fewer seams the better. ni8.1–ni8.5
established the seams this work needs, and almost every item below tests through an
existing one. Where an item names no seam, that is deliberate: a seam with one
adapter is a hypothetical seam, and the two items that would need one (ni8.22,
ni8.14) are explicitly told not to build one.

**The `SubscriptionSource` seam is the workhorse.** It already has two adapters
(detail, shell) and this spec adds four more (approvals, plan/todo, project
settings, PTY), so the seam is real by the two-adapter test rather than
hypothetical. Every adapter is tested through `ReadModelSubscription`'s interface
with a fake bus and a fake snapshot query — no WebSocket, no RPC. Prior art:
`test/unit/relay/shell-subscription.test.ts` and
`test/unit/relay/read-model-subscription.test.ts`.

**Seam per work item.**

| Bead | Seam | Existing or new |
|---|---|---|
| ni8.8 | persistence choke point (event store append + projection runner) | existing |
| ni8.22 | same; no new seam, one adapter would be hypothetical | existing |
| ni8.9 | `SubscriptionSource` (approvals adapter, 3rd) | existing |
| ni8.10 | `SubscriptionSource` (plan/todo adapter, 4th) | existing |
| ni8.11 | `SubscriptionSource` (PTY, detail-shaped, coalescing at the adapter) + the WS-RPC group for inbound `pty_input` | existing ×2 |
| ni8.12 | session (shell) `SubscriptionSource` for the four columns; new project-settings adapter (5th) at the same seam | existing |
| ni8.13 | schema seam (`RelayMessage` union) for deletion; poller-pre-filter unit seam for `file_changed`; WS-RPC contract seam for `rewind_result` | existing |
| ni8.14 | the daemon boundary. Deliberately **no** named seam — the decision forbids a `RelayBroadcaster`. Test at the daemon: two projects, one change, assert both receive | existing |
| ni8.15 | project-scoped `SubscriptionSource` (6th adapter) for `client_count`; the session status subscription for `retrying`; schema seam for the eight deletions | existing |
| ni8.16 | the transport edge as a whole; assertion is absence plus the visual acceptance gate | existing |
| ni8.23 | the read-model write path, asserted **through an open subscription** | existing |
| ni8.24 | the migration plus the fork write path, asserted through the session subscription | existing |

**Tests the three load-bearing constraints demand.**

- **C1 (retry as status).** Drive a provider retry and assert: the transcript
  contains no error part; the turn carries a `retrying` state with attempt count and
  next-retry time; `events` gains no row for the retry; after a simulated reload the
  indicator is gone. Then drive a terminal failure and assert the inverse: a
  `turn.error` row exists and the content is present after reload.
- **C2 (`last_viewed_at` bumps the version).** Open a subscription, write
  `last_viewed_at` directly, assert the subscription emits. This is the *only* test
  that catches the failure, because the failure is silence.
- **C3 (explicit scope).** For every subscription added by this spec, call it with a
  scope it does not ambiently sit in and assert it serves that scope. Plus a tab
  independence test: two connections on two sessions, assert neither moves the
  other, and assert no server-side "current session" exists to move.

**Higher-level seams inherited from ni8.5, reused not rebuilt.** `RpcTest.makeClient`
against the real server layer for stream semantics (prior art:
`test/unit/contracts/ws-rpc-contract.test.ts`); a real serialization round trip
through a fake socket server for **every new streaming member and every changed
schema**, because `RpcTest` wires both halves with no-serialization and structurally
cannot catch an encode failure — and a mid-stream parse failure is a *defect*, not a
failure, so an unencodable schema reaches the user as a crash; and drop-and-resume
at the shared client, asserting the re-issued request carries the last delivered
sequence.

**Item-specific tests worth naming.**

- **ni8.8** — a kill-between-transactions test that no longer produces a projector
  gap; and an assertion that publish still happens strictly after projection.
- **ni8.22** — force a *persistent* projection failure, drive N provider events,
  assert exactly one `session.created` row; and re-assert the ni8.17
  transient-recovery property still holds.
- **ni8.11** — measure round trips under a sustained PTY write and show coalescing
  is engaged rather than one ack per write. This is a performance assertion, and it
  is acceptance because the un-coalesced version is *worse* than what it replaces.
- **ni8.12** — two connections on the same session: change a model in one, assert
  the other sees it with no refetch and no reconnect. And a CLI/IPC-originated
  change reaching an open browser connection.
- **ni8.13** — before deleting `file_changed`, assert the poller batch
  classification consequence (`METADATA_TYPES` / `poller-pre-filter.ts:7-34`)
  explicitly rather than discovering it later.
- **ni8.14** — two projects registered; change instance state via one; assert a
  connection on the other receives it. This is the relay-scoped-broadcast bug turned
  into a test.
- **ni8.23** — restart the daemon with outstanding approvals and assert a non-zero
  badge count with no new events; view in one connection and assert the badge clears
  in another.
- **ni8.16** — enumerate every arm in this spec's tables and prove each rehomed or
  deleted. Plus `pnpm acceptance:visual`.

## Out of Scope

- **`conduit-test-v3cy` — the unified connection-scoped feed.** The right long-term
  shape, and literally the "single canonical activity feed" that
  `2026-05-11-effect-ts-mainline-completion-plan.md:39` names as the trigger to redo
  the relay model. It is **parked, not decided**, with eight open questions gating
  any ticket, and four bugs found along the way are filed against it. Nothing in
  this spec expands it. The design lives at
  `docs/plans/2026-09-17-retire-per-project-relay-design.md` and is reference only.
- **Making the projector total.** Fork 1.2 option E, rejected. Reversing the
  documented live-path policy is not in this epic.
- **Making `projection_failures` readable.** Real (one writer, zero readers in
  `src/`), confirmed, and a separate bead.
- **Version-update notification.** `update_available` deletes. If version
  notification is wanted it is new work, not a port.
- **Backfilling fork lineage from anything other than the existing sidecar.** No
  synthesized events, no back-dating.
- **Changing unary RPC semantics.** The subscriptions are additive to the existing
  group.
- **A third socket class.** ni8.5's two-socket ceiling holds throughout.
- **`conduit-test-ni8.5` itself and its 27 sub-tickets.** This spec builds on that
  seam; it does not re-specify it.

## Further Notes

### Unassigned — has no bead, needs a decision

- **`input_sync`'s server→client fan-out.** ni8.15 classifies `input_sync` as
  "client-initiated, server-relayed… not server-originated, so not residue" and
  therefore assigns it to nobody. But the outbound half is genuinely a server→client
  push: the RPC writes to a process-local `Map<sessionId, string>`
  (`prompt.ts:238-265`, `:30`) and then `sendTo`s every client viewing that session
  including the originator, which drops its own echo client-side via
  `isOwnBrowserClientId` (`ws-dispatch.ts:945-947`). A 1 s `SYNC_GRACE_MS` guard
  stops a stale sync clobbering fresh keystrokes (`InputArea.svelte:352-362`). It is
  not durable; it is read back on session switch as a `draft` field on
  `session_switched` (`session-switch.ts:362-366`). **After ni8.16 deletes
  `ws-dispatch` and `wsMessageStream`, that fan-out has no declared transport.**
  Either it needs a home (a session-scoped subscription member, or a field on the
  session row) or the cross-tab draft sync is deliberately dropped. No bead covers
  it.
- **The `wsMessageStream` capabilities that die with it.** `hasActiveStreamFiber()`
  (`runtime.ts:72-74`), the PWA resume-reconnect liveness signal
  (`ws.svelte.ts:384`), the self-heal branch (`:312-327`) and
  `handleProtocolError`. ni8.16's work list says to retire the stream; it does not
  say what replaces these four. They are named in this spec's ni8.16 section but
  carry no separate acceptance line and no bead.
- **The in-app ding path.** ni8.23 accepts "two code paths for one signal" but only
  the push path has an acceptance line. The focused-tab path has no named transport
  now that `notification_event` is deleted.

### Assumptions logged, not asked

- **Push permission.** If the user denies push, backgrounded dings are lost.
  Standard web behaviour, and the in-app path still covers the focused case, so this
  was decided rather than forked. Noted because it is a real behaviour change from
  today.
- **Terminal errors reuse `turn.error`.** No new event type; the shape already
  exists.

### Facts established by the explorations, recorded so they are not re-derived

- There is no filesystem watcher in conduit at all — zero hits for
  `chokidar|fs.watch|FSWatcher`.
- There are 53 transient RPC sockets today, one per call
  (`ws-rpc-client.ts:602-613` repeated 53 times), plus the one broadcast socket
  (`ws.svelte.ts:234`, the only `new WebSocket` in the frontend).
  `ws-rpc-handler.ts:38-59` builds a fresh `RpcServer` per connection, each with its
  own `concurrency: 32` semaphore.
- The server edge splits by URL path only — `^\/p\/([^/]+)\/(ws|rpc)(?:\?|$)`. Query
  params and handshake messages are not consulted. A new socket class would need a
  third regex alternative and a third handler on `RelayEntry`. None is added.
- `permessage-deflate` is on (level 1) on the browser socket.
- ni8.7's spike disproved socket-wide head-of-line blocking. Do not reinstate the
  HOL argument as a justification for anything.

### Contradiction check from the grill

The only pair that pulled against each other was decision 2.1 (direct read-model
write) versus ADR-0004, and the spine rule reconciles them rather than papering
over them: ADR-0004 governs session mutations, and viewing is not a mutation.
