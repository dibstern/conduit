# Amendment 2026-10-27: Stop is a durable intent with one reconciler (Q30 = A, C inside; Q31 = C)

Approved 2026-10-27 (Q30 = A with C inside, Q31 = C, Q32 = A). This file wins over every other file in this folder.
It refines `AMENDMENT-2026-10-27-RUNNER-REAPER.md` R3 and R4 (when the retirement record is
written, and who acts on it). R1, R2, R5, A12's notice texts and A15's prune rule are unchanged.
User-visible behaviour is unchanged except that a Stop whose record cannot be saved now
fails with the existing "stop runner" error instead of hanging or settling wrongly.

## Why

Three review rounds in a row on the reaper work (32.17) found material bugs. The snapshot loss
the reaper amendment targeted is gone; the new bugs share one cause: **Stop's intent has about
six in-memory owners**, and the durable record is written later, by the kill routine.

| owner | what it holds |
|---|---|
| `entry.stopped` Deferred | "Stop finished", swapped for a fresh one on retry |
| `entry.lifecycle.stop` | the fence that blocks new sends |
| `entry.stopRetryable` | "the last attempt failed, try again" |
| authority `revoke` cohort | which runs this runner owned |
| `settleExitedRuns` | settles owned runs after awaiting `entry.stopped` |
| end-session, shutdown, watcher, recovery | each re-reads the row, checks rejection and calls `runRunnerKill` its own way |

When the record's commit fails, each owner reacts differently:

| round | what broke |
|---|---|
| 2 | a failed Stop commit left `entry.stopped` failed forever, with no retry |
| 3 | a failed Stop commit aborted `settleExitedRuns`; `evict` then queued an empty cohort and the accepted run stayed `running` forever |
| 3 | `killEntry` returned success on a rejected row, so shutdown woke the reaper with no record |

Patching each owner (option D) or reordering them (B) keeps six owners. A typed state in
memory alone (C) still needs the row after a crash, so it adds a second source of truth.

## S1. Stop is one transaction, then nothing else

- Every way a runner is stopped (explicit Stop, end-session, project removal, supersede or
  retire, idle exit, a confirmed exit) makes one call: **request stop**.
- Request stop commits one transaction: the retirement row (leader identity, reaper identity if
  any, the group snapshot, `retired_at`, the stop reason). The row does not list runs; S5 says
  how a stopped runner's runs are found. The awaited commit replaces today's queued
  `receipts.retire` write for this purpose.
- **If the commit fails, nothing changed.** No fence, no revoke, no Deferred, no signal, no
  shutdown command. Request stop fails with the existing "stop runner" error and the runner
  keeps running and serving. Retrying is just calling request stop again.
- **If this runner's existing row is rejected on decode**, request stop fails the same way and
  logs the rejection (per-row rejection is unchanged). It never signals, never sends shutdown.
- A row with `retired_at` set is the fence. A daemon starting up never re-adopts a runner whose
  row is retired as live; it hands the row to the reconciler (S3). Recovery already loads
  retired rows; this makes the row the only fence that outlives memory.

## S2. One typed state, owned by one module

- Each runner's stop state is one tagged union owned by the reconciler module (the existing
  `runner-retirement.ts` grows into it). Callers read it; only the reconciler changes it.

```ts
type RunnerStop =
  | { _tag: "Running" }
  | { _tag: "Committing"; waiters: Deferred<void, StopFailed> } // joins racing Stops; not durable
  | { _tag: "Requested"; record: RunnerRetirement }             // row committed, nothing sent yet
  | { _tag: "Escalating"; record: RunnerRetirement }            // shutdown sent and/or signals in the log
  | { _tag: "Escalated"; record: RunnerRetirement }             // Stop's TERM, 3 s, KILL, 1 s window is over
  | { _tag: "Gone"; record: RunnerRetirement }                  // every snapshotted member gone
  | { _tag: "Settled"; record: RunnerRetirement };              // owned runs settled, evicted, pruned per A15
```

- `Committing` is the only state that is not durable. It exists so a second Stop joins the
  first instead of committing again. It does not guard dispatch: the database does (S5). On
  commit failure it returns to `Running` in the same step that fails its waiters. That is one
  transition, not a swapped Deferred.
- `Requested` through `Settled` map onto the row: the row's tag plus its signal log. Memory is
  a cache of the row and is rebuilt from it at startup.
- Transitions are a pure function: `decideRunnerStop(state, observation) -> { state, actions }`,
  where actions are `Commit`, `SendShutdown`, `Signal`, `Settle`, `Evict`, `Prune`, `Notice`.
  `decideRunnerKill` becomes its signal part. It is tested through the manager's interface
  with an injected process table, as today.

## S3. One reconciler acts on every committed row

- The reconciler is the only code that sends shutdown, signals, settles a stopped runner's
  runs, evicts it or prunes its row. Stop's live path, the survivor watcher (A3 cadence,
  A12 notice) and restart recovery are the same loop over the same rows. The three
  near-copies of "read row, return on rejection, `runRunnerKill`, cache the result" are deleted.
- Each action's effect is idempotent and keyed by the row. A failed write after the commit
  (signal log, Gone, settlement, prune) leaves the row where it was; the reconciler retries on
  its cadence and logs. It never fails a waiter and never rolls back the fence.
- Settlement goes through the existing settlement path. The reconciler is not a new writer of a
  send's outcome; the Run Ledger owns those (SEND-SCOPE-5).

## S5. The run record says which runner holds it (Q31 = C)

- The ledger's run record (`provider_runs`, from run ownership 82tn.24) gains the run's holder:
  the runner id it was dispatched to. It is written through the path that already writes that
  record, committed before the command reaches the runner. It is the only durable answer to
  "which runner holds this run"; nothing copies it.
- The holder write and the Stop commit are mutually exclusive in the database. The holder write
  fails if runner X has a retired row; the Stop commit happens in its own transaction. SQLite
  runs one writer at a time, so a send either lands before the Stop (and is settled with the
  runner) or is refused before the runner sees it, and is handled like any send refused by a
  stopping runner today.
- At `Gone`, the reconciler settles "every non-terminal run held by runner X", read in the
  settlement transaction. There is no cohort snapshot to drift.
- A run that moves to another runner (handoff, retry on a new runner) gets the new holder in the
  same commit that moves it. A run with no holder was never dispatched and is not the
  reconciler's.
- Old rows: rows written by main or by phase 2 carry `owned_run_ids`, and runs dispatched before
  this change have no holder. For those rows only, the reconciler settles the union of
  `owned_run_ids` and the holder query. New rows never write `owned_run_ids`. The fallback is
  deleted with the other legacy paths (32.13).
- 32.2.1 and the rest of the ledger chain build on this field rather than defining their own.

## S4. Waiters

- Callers wait on the state, not on a Deferred they own: `awaitStop(runnerId, "Escalated")` for
  end-session and shutdown (today's semantics: the escalation window is over, not that every
  member is gone), `"Settled"` where a caller needs the runs settled.
- Once the row is committed a waiter never sees a failure; only `Committing` can fail.
- Two Stops race (end-session and an explicit Stop): the second joins the first's state. No
  second commit.

## What is deleted

`entry.stopRetryable`, the `nextStopped` swap, `stop()`'s inline cleanup race, `killEntry`'s
re-read, the recovery and `stopRegisteredRunners` copies of the kill sequence, the
`settleExitedRuns` await on `entry.stopped`, `evict`'s own revoke cohort, and the authority's
`ownedRunIds` as a source of what to settle (new rows stop writing `owned_run_ids`). `entry.retirement`
becomes a read of the reconciler's state.

## Failure modes this must handle

The reaper amendment's 11 still apply. Added:

1. The Stop commit fails: nothing changes, the runner keeps serving, request stop fails with the
   "stop runner" error, and a retry works. (round 3, finding 1)
2. This runner's row is rejected on decode: request stop fails, no shutdown, no signal, logged.
   (round 3, finding 2)
3. The daemon crashes after the commit and before shutdown: the next daemon does not adopt the
   runner as live; the reconciler continues from `Requested`.
4. A write after the commit fails (signal log, Gone, settlement, prune): the row stays, the
   reconciler retries, no waiter fails.
5. A send races the Stop commit: it is either held by the runner and settled at `Gone`, or
   refused before the runner sees it. Never settled twice, never stranded.
6. Two Stops race, or a Stop arrives during `Committing`: one commit, both callers see the same
   outcome.
7. The runner exits on its own while Stop is `Committing`: the commit still lands, the
   reconciler sees every member gone and settles.
8. An unverifiable leader (A12): unchanged. `Escalated` is reached when the window ends; the
   watcher keeps going with the notice.
9. A run handed off to another runner before the first runner stops: it carries the new holder
   and the first runner's reconciler leaves it alone.
10. An old row with `owned_run_ids` and a run with no holder: settled through the fallback.

## Tests

- End to end with real processes, reusing the reaper amendment's harness and JSON artifacts:
  failure mode 3, and a Stop with an accepted run that settles to a terminal state.
- Through the manager's interface with an injected process table and an injected commit
  failure: failure modes 1, 2, 4, 5, 6, 7, 9 and 10. Each asserts the runner's runs reach a terminal
  state or keep running, never a stuck `running`.

## Prior art

Kubernetes deletion: a delete request sets `deletionTimestamp` (one durable write) and changes
nothing else; controllers reconcile toward it; finalizers hold the object until cleanup is
done, and the object is removed when the last finalizer is cleared. Here the row is the
object, `retired_at` is the timestamp, the reconciler is the controller, and A15's prune is the
last finalizer. The competitors surveyed for the reaper amendment (paseo, paperclip, diri) stop
imperatively and persist nothing before signalling, so none of them hits this class of bug
and none of them survives a daemon crash mid-Stop.

## Decisions

Q30 = A, with C as its internal shape: Stop is a durable intent carried out by one reconciler,
and the stop state is one typed union with pure transitions.

Q31 = C: the run record names its holder, so the stop row carries no list of runs.
