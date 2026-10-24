# Amendment 2026-10-25: design audit (Q17 = A)

Approved 2026-10-25. An audit of the whole contract for facts with more than one owner,
bottlenecks, and deepening not yet taken. This file wins over every other file in this
folder, including `AMENDMENT-2026-10-25-RUNNER-AUTHORITY.md` (RA). BG is
`AMENDMENT-2026-10-24-BACKGROUND-WORK.md`; FB is `AMENDMENT-2026-10-24-FACT-BOOK.md`.

User-facing behaviour is unchanged except where a section says otherwise. The survivor
notice wording (D1: "It can't make further changes") is still open: BG's Limit says a
surviving process can still edit files.

## Supersedes

- RA section 5 step 3 ("Settle owned runs ... under the cleanup grant") and invariant
  I5's role in settlement: replaced by A1.
- RA section 1's row "Survivor identity and owned runs": `owned_run_ids` becomes a
  pending obligation (A1) and is dropped when the ledger lands.
- RA section 4's "Tombstone flush" content: the seam no longer knows runner columns (A2).
- BG "Runner lifecycle" and ticket 32.4: "a process watcher turns ... Retired records ...
  into settle(processLost)": replaced by A3.
- BG Decision 4 "No confirmation within a deadline: the tracker re-reads": the deadline
  moves to the ledger (A4).
- FB section 4 "No pruning ... rebuild on load is proportional to history": rebuild is
  limited to open sessions (A7). History is still not pruned.
- 32.3's "each one transaction with a version check, up to three retries, then a typed
  LedgerConflict": replaced by A5.
- 32.4's "reads the earliest deadline from the runs table": replaced by A8.
- 32.6's "Late events for an ended run are ignored": replaced by A10.
- Stale lines that RA already superseded, listed so readers stop tripping on them: FB
  section 2 "Process generation: each kill or process loss bumps it"; BG line 38 (the
  ledger owns generations), line 58 (the runner manager stamps the generation), lines
  45-46 (stored transitional goal phases), line 268 ("the goal returns to its previous
  phase"); `quarantine` in `run-ledger-model.ts`.

## A1. Retirement settles durably

A retired runner's runs were settled by a detached step under a cleanup grant of about
3 s. If SQL was busy past the deadline, settlement was lost; 32.4's watcher settled them
a second time once the process died; and `owned_run_ids` copied what the ledger knows.

- **Before the ledger (R2):** `owned_run_ids` on the cursor row is the pending
  settlement obligation, written with `retired_at`. Settling a run clears it from the list
  in the same transaction. Every watcher tick and every restart re-drive settlement while
  the list is non-empty. Settlement is idempotent.
- **With the ledger (32.4):** the tombstone write that sets `retired_at` also records
  `process_lost{runnerId}` in the same transaction (RA section 7: it covers every label of
  that `runnerId`). Settlement cannot be lost and happens once. `owned_run_ids` is
  dropped in 32.13.
- The cleanup grant still bounds memory releases (admission, sinks, in-memory prompt
  waiters) at the shared deadline. Durable settlement no longer depends on it.

## A2. The write seam holds no runner knowledge

The seam keeps one generic queue of pending writes per SQL client. `revoke` queues the
tombstone as an opaque write supplied by `RunnerAuthority`; the seam forks one standalone
flush and runs pending writes in its final hook, as RA section 4 says. The cursor row's
columns and SQL live with the receipt store, not in the seam. One owner per table.

## A3. One process watcher

`RunnerAuthority` owns the records, so it owns the only process watcher, over Exiting and
Retired records. When a process is confirmed gone (exited, PID reused, zombie) it emits
`runnerGone(runnerId)` once; the ledger records it as `process_lost{runnerId}`. The
survivor retries (10 s, 30 s, 60 s) are this watcher's schedule. After the third failure
and the notice, it checks every 60 s (today: every 10 s, forever). 32.4 keeps only failed
liveness checks, which are ledger deadlines.

Prior art: diri checks process ids in one place when a process exits.

## A4. Goal commands: one deadline owner, one ordering rule

- **Deadline.** A native command's confirmation deadline is an ordinary ledger deadline
  (in `alarmAt`). It does not run while the provider reports the command queued. When it
  fires, `nativeCommands` shows the command `unconfirmed`; the goal tracker reacts by
  re-reading native state (Claude's transcript, Codex's `thread/goal/get`) and shows
  "Clear not confirmed" or "Pause not confirmed" with Retry. The tracker runs no timer.
- **Ordering.** The tracker keeps at most one pending goal action. A new action while one
  is pending supersedes it: the tracker stores the new action's id. Only a reply
  correlated to the current pending id (Claude: input UUID; Codex: request id) clears it.
  Native status reads (transcript `goal_status`, `thread/goal/get`) always update the
  confirmed status, whichever action is pending.
- **Recovery.** After process death, the tracker reconciles native state first and
  resends the pending action only if the confirmed status does not already match its
  target.

## A5. Ledger decisions ride the event's transaction

Every ledger verb runs inside the write seam's transaction: read, decide, record, under
the one permit. When evidence comes from a provider event, the decision commits in the
same transaction as that event, so the event store and the ledger never disagree after a
crash, and each event costs one permit acquisition, not two. `decide` is pure and bounded
(64 steps), so it is safe under the permit. Effects run after COMMIT. The in-memory
caches update after COMMIT; a rollback discards the decision.

Deleted: the version check, the three retries and `LedgerConflict`. With one permit, a
concurrent ledger writer cannot exist.

## A6. Activity at coarse steps

`activity` evidence changes a join only when it is the execution's first activity, or when
the stored latest activity is older than a quarter of the liveness window. Other activity
frames are Accepted with no events. While frames keep arriving, the liveness deadline is
always at least three quarters of a window away, and a streaming turn costs about four
ledger writes per window, not one per frame.

## A7. Rebuild only open sessions

On load, the ledger rebuilds caches only for sessions with open work: a Run not Ended, an
unsettled send, a pending interaction or native command, or a future alarm. Other
sessions load on first touch. The per-session row of A8 is the index. Startup cost is
proportional to open work, not to the history of every project in the daemon-wide store.

## A8. One alarm per session

Every decision writes the session's `alarmAt` to a per-session ledger row in the same
transaction, together with whether the session has open work (A7). The scheduler reads
the earliest `alarmAt` across sessions. Deadlines with no Run (native commands, Tombstone
obligations) are covered.

## A9. The catch-up snapshot always arrives

The runner host keeps the latest background-task snapshot even when it is empty, with
its query label, and replays it after the backlog on every attach. Without this, a
reattach to a process with no tasks shows "Checking tasks..." forever (the host dropped
empty snapshots).

## A10. Late evidence after a Tombstone

Late evidence for an Ended Run never changes its Tombstone. A late acceptance still
restores outstanding work (FB section 4), so the native-session fence stays until that
work is settled.

## A11. Events that answer no send

A runner event either answers a Send Token or is an unsolicited observation that names
only the host label (`runnerId:querySeq`): background snapshots and task events, a turn
start with no active Run (a wake Run), process events. No fictitious send is minted.

## Already covered

- 32.8's unconditional escalation at the interrupt deadline: 32.8 already defers the
  confirm before destroying live tasks to 32.25.

## Bottlenecks inherited, not fixed here

- One daemon-wide store, so one write permit for every project, and a synchronous
  `busy_timeout` of 5 s that blocks the event loop. A5, A6 and A7 keep the ledger from
  adding to it. Moving SQLite off the main thread is a separate decision.
- Goal transcript reads scan the whole file; host send deduplication keeps its history.

## Tickets

| Ticket | Change |
|---|---|
| 32.17 (R2) | A1 before-ledger obligation, A2, A3's 60 s cadence |
| 32.2.5 | A6 |
| 32.2.11 | A4 deadline as a ledger deadline; A11 unsolicited observations |
| 32.3 | A5, A7, the per-session row of A8 |
| 32.4 | A1 with the ledger, A3, A8 |
| 32.5 | A11 |
| 32.6 | A10 |
| 32.13 | drop `owned_run_ids` |
| 32.22 | A9 |
| 32.26, 32.27 | A4 |
