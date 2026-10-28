# Amendment 2026-10-28: a waiting send continues only through `holdRun` (C + J + K)

Decided autonomously on 2026-10-28 under the AGENTS.md Review Rounds rule, after three consecutive
material review rounds on conduit-test-82tn.32.17 (rounds logged on the bead). This file wins over
every other file in this folder. It refines `AMENDMENT-2026-10-28-RUNNER-SWAP.md` (S5 refined,
`holdRun`, the lifecycle module), `AMENDMENT-2026-10-27-STOP-INTENT.md` (S1, S5),
`AMENDMENT-2026-10-26-SEND-SCOPE-5.md` (S9.3-S9.5) and `AMENDMENT-2026-10-26-SEND-SCOPE-6.md`
(journal reads). Everything else in them stands.

User-visible behaviour: a send the user did not stop always reaches an agent, even when the runner it
was waiting on exits idle, retires itself or the daemon restarts. A send covered by the user's Stop
never reaches an agent after the Stop; it ends as "Stopped before delivery". A send that may have
reached the agent is never sent twice.

## Why

The three rounds were one bug in three places:

| round | finding |
|---|---|
| 1 | a plain Stop refusal was reclassified as idle exit and re-sent; delayed cleanup erased the successor's snapshot |
| 2 | the idle flag overrode a winning EndSession |
| 3 | draining admission re-selection created a successor after a winning Stop |

The question "may a waiting send continue on a new runner?" has seven in-memory owners in the runner
manager: the holder refusal mapping (which rewrites `runner_stopping` into retryable
`runner_idle_exit` / `runner_recovery_abandoned`), `canRetryUnreceivedSend`, the committed requeue,
the handoff deferral in `settle`, `onIdleExit`, the eviction requeue, and admission's draining
re-selection with its uncapped `Effect.retry`. Restart has an eighth: `settleUnclaimedRunnerCommands`
fails every running send in an unclaimed session. Each answers from runner lifecycle state
(`idleExiting`, stop reason, failure code).

Runner lifecycle state is a proxy for two facts:

- **(a) Coverage:** did the user's Stop cover this send?
- **(b) Delivery:** could the agent have received this transmission, now or later?

Every round was a case where the proxy and the fact disagreed.

## Data shape

- **Send:** one `send_turn` command, identified by its stable `commandId` (survives recommit, retry
  onto a fresh run, and restart).
- **Transmission:** one attempt to give a send to one runner, identified by `(commandId, n)`. `n`
  counts `run.dispatched` events carrying that `commandId`; events are the source of truth, so the
  count survives recommit, a fresh run and a projection rebuild. No counter column.
- **Hold:** the open transmission of a run. `provider_runs.runner_id` (STOP-INTENT S5) plus
  `provider_runs.held_transmission`, both projected only from `run.dispatched` and cleared only by
  `run.released`. The `run.started` projector stops writing `runner_id`; a joined run's holder is its
  owner's, read through `joined_into`. `held_transmission` exists for the release check: one runner
  can hold the same send twice (ResumeRejected re-sends to it), so `runner_id` alone cannot tell a
  stale release from a current one.

```ts
// stored events (extended; old events decode with the fields absent)
"run.dispatched": { runId; runnerId; commandId?: string; transmission?: number }
"run.released":   { runId; runnerId; commandId; transmission;
                    reason: "Refused" | "NotSent" | "JournalAbsent" | "ResumeRejected" }
```

A `run.dispatched` without `commandId` was written before this amendment. Such a run never enters C2
or C3; it keeps today's legacy recovery (`runner-legacy-recovery.ts`), because an unheld legacy run is
not proof of non-delivery (STOP-INTENT S5 preserved holderless dispatched runs).

**Scope:** C2 and C3 move **owner sends**, the send whose run is its own owner. A steer joined into an
owner run is carried by the owner's holder and keeps SEND-SCOPE-4/5's rules (requeue, retained
steers). Coverage of any send is decided for the send's own run id, so a join after a Stop never
widens that Stop's cohort.

## C1. Two facts, two owners

- **Coverage is owned by the Run Ledger.** A run is covered when a committed Stop control row of its
  session lists it in `payload.stop.owners`. One predicate, `stopCovers(session, run)`, lives in the
  ledger's settlement module beside `sessionRunOwnersQuery`. `legacyStopOwnersQuery` (outbox order) is
  a read-only fallback for control rows written before `payload.stop` existed and never decides for a
  newer row: a recommit re-inserts a send with a new `request_sequence` and would escape it. The
  reactor's own stop-owner read uses `stopCovers` too. Nothing in memory answers coverage.
- **Stop is accepted in one commit.** Today `prepareStop` snapshots the cohort in one transaction
  (`provider-turn-session.ts`, the `commit.write` that calls `sessionRunOwnersQuery`) and
  `engine.dispatchEffect` accepts the control row in a later one, so a waiting send is uncovered in
  between. The engine gains one Stop acceptance operation. Inside one `durable.write` it runs the
  receipt check first; the fingerprint covers the caller's intent (session, command id, requested
  scope), not the derived `stop` or control type, and an existing receipt returns its stored payload
  unchanged. It then computes the cohort snapshot and the `end_session` / `interrupt_turn` choice,
  performs all of today's `prepareStop` write (pending-row settlement "Stopped before delivery",
  `input.requeued`, the `retryable_failed` delete), reads the interrupt's targets, commits the control
  row with `payload.stop`, and projects its events. Execution of the accepted command id follows the
  commit. The engine stays the one owner of control acceptance; `prepareStop` calls it and keeps no
  `commit.write` of its own.
- **Delivery is owned by the hold.** `holdRun` commits the hold before the first byte of the
  transmission is written to the runner's socket. An owner send whose transmissions are all released
  was never received. A held transmission may have been received, now or later; only C3's evidence
  turns it back into "never". `delivery_indeterminate` keeps its meaning and is never re-sent. For a
  runner-held transmission the reconciler's Settle is its only writer.
- **Outcome stays with the Run Ledger** (SEND-SCOPE-5). For a runner send, a socket failure, a write
  failure or a missing reply is never reported to the reactor as the send's outcome; the reactor
  writes its terminal outbox status only from its run's terminal settlement.
- **Direct providers are out of this amendment's scope.** A send to a provider with no runner
  (OpenCode through its SDK/API client) never has a hold, so C2 and C3 never apply to it. It keeps
  today's behaviour unchanged: the adapter's typed indeterminate result, and the reactor's existing
  nonterminal `delivery_indeterminate` marker on its still-running outbox row, which preserves the
  admission blocker and replay. The partition is by row: a row is runner-held or direct, never both,
  so each `delivery_indeterminate` row still has one writer. Moving direct-provider uncertainty into
  the ledger belongs to 32.2.6's `decide`.

## C2. `holdRun` is the one gate for a transmission

```ts
type Hold =
  | { _tag: "Held"; runner: RunnerId; transmission: number }
  | { _tag: "Unserved" }    // no live serving runner: start one, then call holdRun again
  | { _tag: "Covered" }     // the user's Stop covers this run (settled now, or by its holder's Stop)
  | { _tag: "Exhausted" };  // the send's fifth transmission failed; the run has been settled failed
holdRun(session, run, commandId): Effect<Hold, HoldFailed>
```

One write transaction, in this order:

1. **Covered?** If `stopCovers(session, run)`: when the run has no hold, settle it through the ledger
   in the same transaction as `interrupted` with one `turn.interrupted` ("Stopped before delivery",
   the outcome a pending send gets from Stop today) and return `Covered`. When it has a hold, change
   nothing and return `Covered`; the holder's interrupt or Stop settles it, and if the holder refuses
   (`interrupted` or `exiting`), C3 releases it and this step settles it. Settlement is idempotent by
   the run's status guard.
2. **Dispatchable?** The run is `pending` or `running`, unheld, and not terminal; otherwise return
   the existing refusal.
3. **Cap.** If the send already has 5 transmissions, settle the run `failed` with
   `provider_send_attempts_exhausted` and one `turn.error`, and return `Exhausted`. At most 5
   transmissions per send, the first included, across runs and restarts (S9.5's cap, now durable).
4. **Serving?** Read the session's non-retired `serving` row. None: return `Unserved`.
5. **Bind.** Append `run.dispatched{runId, runnerId, commandId, transmission: n + 1}` and return
   `Held`.

**The transaction.** It is the one `commitAndSignal.write`. `holdRun` resolves a joined run to its
owner before step 1 and counts the owner send's `commandId`. Settlement in steps 1 and 3 appends
events through that write's projection handle; it never calls ingestion, `settleSessionRuns` or
`flushPendingWrites`, which open their own write and would fail nested. The unheld check, the count
and the coverage read are new to `holdRun`; all use the transaction's own SQL.

**One feeder moves owner sends.** Each session's runner manager has one feeder, the only caller of
`holdRun` for an owner send. It takes a send when it is claimed, when a release commits, and at
restart. `Held` writes to that runner and returns the send to waiting on its run; `Unserved` starts a
serving runner (keeping today's ordering against a stopping predecessor, STOP-INTENT S4) and calls
`holdRun` again; `Covered` and `Exhausted` drop it. Nothing else spawns a runner for a send, and
nothing else appends `run.dispatched`. A send waits on its run, never on the socket: a socket or write
failure leaves it held until C3's evidence or the run's settlement.

**Adoption is not a transmission.** When restart adopts a live runner that still holds a run (today's
re-holds of pending sends and the active turn at adoption), it appends nothing. It neither checks
coverage nor counts toward the cap. It does ask the runner for each held transmission's status (the
hello's command status, SEND-SCOPE-6): `received` or `running` is adopted, `not_received` is NotSent
(C3) because the host answers a new connection's hello only after reading the previous connection to
end of file, and anything else stays held. Adoption is part of RUNNER-SWAP's `recover()`.

## C3. Losing a hold is a release, never a decision

```ts
release(run, runner, commandId, transmission, reason): Effect<void>
```

`release` appends `run.released`. Its projector clears the hold only when `(runner_id,
held_transmission)` still equals `(runnerId, transmission)`. Projection is in event-sequence order, so
the check makes a duplicate or stale release a no-op (it does not make arbitrary replay order safe,
and need not). Every release, whoever commits it (the feeder's runner, the reconciler, adoption),
hands the run to C2's feeder in the same step: the commit wakes the feeder, and the feeder's restart
scan finds it if the daemon dies first. A held run never waits on a loop that has ended. Four kinds of
evidence may release, and nothing else:

- **Refused.** The runner host replies with a typed `command-refused{reason}` before it sends
  `command-accepted` and before the command reaches the agent. Reasons: `exiting`, `retiring` and
  `interrupted` (below). This replaces matching on stop reasons and the shared `runner_idle_exit`
  code. For `exiting` and `retiring` the runner is leaving, so the release transaction also stops it
  (`Idle` for `exiting`, `Exited` for `retiring`) when its row is still serving. The next `holdRun`
  therefore returns `Unserved`, never the same runner: no refusal loop. A Reserved runner never
  refuses; a command cancels its reservation (RUNNER-SWAP M), so a swap never releases a send.
  A runner whose build predates `command-refused` refuses with `command-reply{failure.code:
  "runner_idle_exit"}` before any `command-accepted` for that transmission; that reply is
  `Refused{exiting}`. No other reply code is refusal evidence.
- **NotSent.** The daemon never called write for this frame: the socket was closed, the runner had
  announced idle exit (today's pre-write `runnerIdleFailure`), or adoption's hello reported
  `not_received` (C2). A write that was called and failed, or a missing `command-accepted`, is not
  evidence: the transmission stays held until other evidence or a settlement decides it. A send
  cancelled by the user between the hold and the write needs no release: its run settles cancelled.
- **JournalAbsent.** The journal read is typed: `Absent | Present(state) | Unreadable`. Bytes can
  sit unread in a live runner's socket after a daemon crash, so absence proves nothing while the
  process may still run. Only `Absent` from a runner whose process is confirmed exited (the reaper's
  pid and start-time check, RUNNER-REAPER) and whose build writes the journal before executing
  (SEND-SCOPE-6) releases. A live runner is adopted instead. `Unreadable` (unreadable directory,
  corrupt record) and any older-build runner mean `delivery_indeterminate`, never a release.
  `Present` settles as today. The reconciler's Settle reads the journal first: it releases `Absent`
  transmissions instead of settling their runs.
- **ResumeRejected.** The runner reports that the provider rejected native resume before executing
  the input (today's `nativeResumeRejected` / `isClaudeResumeRefused`, S9.4). The release precedes the
  fresh-prepare fallback in `prepare-turn`, which then transmits through C2 like any send and counts
  toward the cap. Its existing fallback marker keeps the runner deduplication key distinct.

**The host's interrupt refusal.** `interrupt_turn` acts on inputs the host already has. A covered
transmission bound before the Stop but written after the interrupt would otherwise start after the
Stop. The `send-turn` frame carries its `runId`, and `interrupt_turn` carries the committed cohort
(`payload.stop.owners`) as `runIds`. The host records those run ids for the rest of its process life
and refuses a later `send-turn` whose `runId` is recorded with `command-refused{reason:
"interrupted"}`. C3 releases it and C2 step 1 settles it "Stopped before delivery". Run ids, unlike
turn ids, are unique (continuation sends share a cut-off message id) and always present. An
`interrupt_turn` without `runIds` (an older daemon) records nothing. `end_session` needs no record:
the runner is exiting and refuses with `exiting`.

**The live handle follows the release.** After any release commits, the feeder returns the send's
live handle (if this daemon has one) to queued attribution (`send-scope`) before any retirement
cleanup for the releasing runner runs, so `closeRunner` cannot close a send that continues. At restart
there is no handle and the feeder builds one from the durable send. `send-scope` carries this out; it
does not decide eligibility.

**One commit for release and stop.** The transaction-bound stop mutation is the body of today's
`receipts.requestStop` without its `flushPendingWrites` wrapper: it runs inside the caller's write and
reads its candidates in that transaction. Both `requestStop` and `release` use it. After the outer
commit, the lifecycle module applies the same post-commit step as `requestStop` (state and row cache,
route cache, revocation, waiters, reconcile). A `requestStop` that races a release-driven stop joins
it, as it joins `Committing` today.

**Restart.** The feeder's scan takes every owner send whose outbox row is `running` and whose run is
non-terminal and unheld. Held transmissions of exited runners go to the reconciler's Settle
(JournalAbsent or `delivery_indeterminate`); of live runners, to adoption.
`settleUnclaimedRunnerCommands` no longer settles held transmissions itself: it hands those of exited
runners to the reconciler's Settle.

S9.5's backoff still applies to re-sends after a retryable provider failure; a re-hold after a
release goes immediately and counts toward the cap.

## Deleted or changed

- Deleted: `canRetryUnreceivedSend`; `idleExiting` as permission to continue a send; the holder
  refusal's `mapError` that rewrites `runner_stopping` into retryable codes ("no serving runner" is
  now `Unserved`); the handoff deferral in `settle`; the committed requeue's, the eviction requeue's
  and `onIdleExit`'s own retry decisions; admission's draining re-selection and its uncapped
  `Effect.retry`; `retryUnacceptedSend` and every other re-send path outside the feeder; the
  reactor's `writeFailure` as a send's outcome on socket or write failure; `prepareStop`'s own
  `commit.write`; the `run.started` projector's `runner_id` write. The draining wait is replaced by "a refusal
  stops the refusing runner" (C3), so it must not be deleted without that.
- Changed: adoption's re-holds become status reads (C2); the reconciler's Settle reads the journal
  before settling (C3); the reactor's stop-owner read uses `stopCovers` (C1); `settleUnclaimedRunnerCommands` (C3, Restart);
  `prepareStop` calls the engine's Stop acceptance (C1); `holdRun` takes the `commandId` and returns
  `Hold`; the resume fallback releases before re-transmitting.
- Added: `run.released` and its projector; `commandId` and `transmission` on `run.dispatched`;
  `provider_runs.held_transmission`; `runId` on the `send-turn` frame and `runIds` on
  `interrupt_turn`; the host's `command-refused` frame and interrupted-run record; the per-session
  feeder; the typed journal read; the transaction-bound stop mutation; the engine's Stop acceptance. Every
  exhaustive switch over stored event types and runner frames handles the new members.
- The lifecycle module (`runner-retirement.ts`, RUNNER-SWAP) gains `release` as its eighth call. The
  `Idle` stop reason is now written: by a refusal with `exiting`, and by idle exit.

## Out of scope, on purpose

Moving re-sends into the outbox (a retryable send row returns to the inbox instead of a loop holding
it) is deferred to 32.2.6. It needs one Stop rule for both inbox rows and claimed rows, which 32.2.6's
`decide` owns. Doing it here would create a second Stop rule beside `stopCovers`.

## Confirm before building

If any of these is false, stop and report it with file:line and options; do not improvise.

1. The hold commits before the first byte is written to the runner's socket on every dispatch path,
   the legacy and fallback paths included. (Spec review found this true today: dispatch calls
   `holdRun` before the write, `process-session-runner.ts` `dispatch`; keep it.)
2. The host refuses an exiting or retiring runner's command before `command-accepted` and before it
   reaches the agent. (Found true today for the explicit branch.)
3. The engine's control acceptance (receipt dedup, sequence allocation, `commitControl`,
   `registerControl`, projection) runs inside one `durable.write`. (Found true in spec review;
   `commit`'s `sql.withTransaction` nests as a savepoint.)

## Required work the design depends on

These are false today and are part of this amendment, not preconditions:

1. Stop acceptance in the engine, with the intent-only fingerprint and all of `prepareStop`'s write
   (C1).
2. The host answers a new connection's hello only after reading the previous connection to end of
   file, so `not_received` in that hello is final (C2, Adoption). If the host cannot do this, stop and
   report: adoption then keeps such holds until the runner exits.
3. The interrupt frame carries the committed cohort as `runIds`, and `send-turn` carries its `runId`
   (C3).

## Failure modes this must handle

RUNNER-SWAP's 18, STOP-INTENT's 10 and the reaper's 11 still apply. Added:

19. A send waits while its runner exits idle: refused `exiting`, released, the runner is stopped
    `Idle`, `Unserved`, new runner, held, delivered once.
20. A plain Stop refusal on a runner the user stopped: released, `Covered`, settled "Stopped before
    delivery", no new runner (round 1).
21. Idle exit and a winning EndSession race: `Covered` wins whatever the runner's idle flag (round 2).
22. A waiting send during admission after a winning Stop: `Covered`, no successor (round 3).
23. A send after the Stop (not in the cohort): held on a new runner, delivered once.
24. A send waits while Stop is being accepted: impossible to fall between, Stop is one commit (C1).
25. The live release and the reconciler release race: one clears the hold, the other is a no-op.
26. Daemon SIGKILL with an unheld running owner send: restart feeds it to the feeder; delivered once or
    `Covered`.
27. The runner received the send, then died: `delivery_indeterminate`, settled, never re-sent.
28. The journal is unreadable or corrupt, or the runner is an older build: indeterminate, not re-sent.
29. A runner retires itself after an abandoned run while a send waits: refused `retiring`, released,
    the runner is stopped, the send moves to a new runner and is delivered once.
30. Repeated daemon restarts during one long turn: adoption appends nothing; never `Exhausted`.
31. Every new runner refuses: the fifth transmission's refusal ends `Exhausted`, one `turn.error`.
32. A projection rebuild after a release: the run is unheld, as before the rebuild.
33. A send recommitted after a Stop: `stopCovers` reads the cohort, not outbox order.
34. Daemon SIGKILL with a transmission unread in a live runner's socket: the runner is adopted and
    executes it once; nothing re-sends it.
35. A covered transmission bound before the Stop reaches the host after its `interrupt_turn`: refused
    `interrupted`, released, settled "Stopped before delivery"; the agent never starts it. (Current-
    build runners only; an older runner keeps today's behaviour.)
36. A refusal while the refusing runner's retirement cleanup is pending: the send's handle survives
    and the send is delivered on the next runner.
37. Native resume rejected: released `ResumeRejected`, fresh fallback transmitted once through C2.
38. A legacy holderless dispatched run at restart: legacy recovery, never C2.
39. A send retried onto a fresh run after a retryable failure: its transmission count carries over,
    and re-sends after retryable provider failures count toward the cap (S9.5).
40. A live daemon, a held send, the runner exits before reading it: the reconciler releases it
    `JournalAbsent`, the feeder re-holds it on a new runner, delivered once, no restart needed.
41. The runner announces idle exit, then a send reaches the pre-write check: `NotSent`, released,
    delivered once on a new runner.
42. An older-build runner refuses with `command-reply runner_idle_exit` before `command-accepted`:
    `Refused{exiting}`, delivered once on a new runner.
43. Daemon SIGKILL between the hold commit and the write, runner alive: adoption's hello reports
    `not_received`, released `NotSent`, delivered once.
44. Stop accepted twice with the same command id after the cohort changed: the replay returns the
    stored payload; no second control row.
45. Two continuation sends sharing a cut-off message id, one covered and one not: only the covered one
    is refused `interrupted`; the other is delivered once.

## Tests

Assertions are exact, not "terminal or delivered": an uncovered never-received send reaches the agent
exactly once; a covered never-received send produces one `turn.interrupted` and no delivery; an
uncertain send is never retransmitted; no run is left `running`.

- **Fixture change, cited.** runner-survivors.test.ts "STOP-INTENT Stop wins the SQL writer before a
  racing send" seeds production's durable facts: a send_turn outbox row (lower `request_sequence`,
  `run_id` = the racing run, status `running`) and an `end_session` control row whose
  `payload.stop.owners` lists the racing run. Its Stop-first expectation changes from `error` /
  `turn.error` to `interrupted` plus one `turn.interrupted` ("Stopped before delivery"), `runner_id`
  null, `received = []`. C2 step 1 replaces the behaviour it asserted.
- **End to end with real processes**, extending runner-forced-stop and the claude-runner-* tests, each
  writing a JSON evidence artifact under `CONDUIT_RUNNER_EVIDENCE_DIR`: failure modes 19, 20, 26, 29,
  30, 34, 35, 40 and 43. Race and crash points use the existing `NODE_ENV=test` pause hook.
- **Provider service through the engine, real SQLite and a real runner host:** 21-24, 33, 44 and retained
  steers, so Stop acceptance, cohort creation and control choice are the production ones, not seeded.
- **Through the manager's interface** with the injected process table: 25, 27, 28, 31, 36-39, 41.
- **Persistence:** 32 through the existing projector rebuild tests; `held_transmission` and the
  extended event decoding (old `run.dispatched` without the new fields) through the migration tests.
- **Runner host wire protocol:** `command-refused` for each reason, the interrupted-run record, 42
  and 45, and hello after draining the previous connection.

## Prior art

Competitor manifest (2026-10-28): t3code dde3fdb5a6, bb c6c23be71f, paseo 2c23cd4927, zeron
636b165169, diri 19e981e848, monocode 26465c6209, capy docs snapshot 2026-10-27. Reports:
`/private/tmp/r2-continue-survey/<name>/report.md`.

| competitor | who decides a waiting send may continue | durable Stop boundary checked at re-dispatch |
|---|---|---|
| t3code | replacement startup re-checks persisted run/attempt ownership just before the adapter call (`Orchestrator.ts:10135`, `EffectWorker.ts:745`) | yes for ownership; a later send can release the Stop queue hold |
| zeron | exit path redispatches accepted-but-unconfirmed sends (`sessions.rs:4955`) | command order is durable, the Stop pointer is in memory; inferred orphan-replay race (`doc_host.rs:5957`) |
| bb | transactional eligibility check before dispatch (`queued-messages.ts:558`) | partly; Stop can overtake a queued submit (inferred) |
| monocode | in-memory generations (`App.tsx:8201-8407`) | no recheck after preparation |
| paseo | waiting send resumes on the replacement (`agent-manager.ts:2756`) | none |
| diri | in-memory current session by id; durable "unknown" receipts | no |
| capy | docs only | not documented |

- **Convergence:** every competitor guards re-dispatch in memory, and each has a hole between Stop and
  the replacement. zeron's history shows repeated fixes in exactly this path.
- **Taken:** t3code's re-check of durable run/attempt ownership immediately before the adapter call
  (our hold and transmission number); zeron's "every replacement dispatch rechecks one durable Stop
  boundary"; zeron's preserved message identity across replay (our stable `commandId`); diri's durable
  "unknown" receipts (our `delivery_indeterminate`) as the line never re-sent.
- **Different on purpose:** the Stop boundary is the committed cohort, read in the same transaction
  that binds the hold, and a hold is cleared only by evidence, so no ordering of Stop, idle exit, swap
  or crash can let a covered send start or a received one be re-sent.

## Decisions

Chosen: **C + J + K**. The Run Ledger answers coverage; the hold, committed before transmission and
cleared only by evidence, answers delivery; `holdRun` is the one typed gate; losing a hold is a
release event.

Spec review changed the first draft. Round 1: the hold replaced an `input_absent` outbox code, a
refusal stops the refusing runner, release became an event, adoption stopped counting. Round 2: a
transmission is keyed by the stable `commandId` (the run-level counter reset on a fresh run and
merged joined steers); JournalAbsent needs a confirmed-exited process; legacy holderless runs stay on
legacy recovery; Stop acceptance moved into the engine; the host records interrupted turns; resume
fallback releases explicitly; release and stop share a transaction-bound mutation. Round 3: one
per-session feeder re-drives every release, whoever commits it (the live loop no longer owns
continuation); sends wait on their run, never the socket; NotSent covers the pre-write idle check and
adoption's `not_received`; older runners' idle reply counts as `Refused`; the host's record is keyed
by run id; Stop acceptance absorbs all of `prepareStop`'s write with an intent-only fingerprint; the
hold, `delivery_indeterminate` and the serving-row cache each got one named writer. Implementation
found the `delivery_indeterminate` writer rule too wide: direct providers (no runner, no hold) keep
the reactor's existing marker, partitioned by row.

| option | verdict |
|---|---|
| A: patch the third round in place | rejected: keeps seven owners; the fourth round would find the eighth |
| B: one in-memory admission decision in the manager | rejected: not durable, infers user intent from runner state, misses the window between the Stop press and the manager's Stop |
| C: ledger coverage checked inside `holdRun` | **chosen** (core) |
| D: a session Stop epoch | rejected: a second copy of the cohort; does not fit an interrupt that lists turns or retained steers |
| E: Stop settles its cohort at once | rejected: makes Stop an outcome writer before the provider confirms |
| F: a `stop_requested` column on runs | rejected: duplicates the cohort |
| G: the runner decides | rejected: the runner does not know the user's intent |
| H: pull the ledger's `decide` forward | rejected: 32.2.x depends on 32.17's runner authority, not the reverse |
| I/L: the outbox owns re-sends | deferred to 32.2.6: needs one Stop rule for inbox and claimed rows, which `decide` owns |
| J: `holdRun` returns a typed `Hold` | **chosen** (C's interface) |
| K: durable delivery evidence | **chosen**, as the hold plus `run.released` (not a new outbox code) |
| M: runner authority owns the coverage predicate | rejected: coverage is the user's Stop, which the ledger records |
| N: a `Draining` hold outcome that waits for the refusing runner | rejected: a second wait loop; stopping the refusing runner in the release commit makes it unnecessary |
| O: a transmission counter column on the run or outbox row | rejected: resets on a fresh run or merges joined steers; counting `run.dispatched` by `commandId` is already durable |
| Q: the live send loop re-holds after its own releases, restart re-feeds the rest | rejected: two re-drivers, and a release made by the reconciler in a live daemon has neither (round 3's P1) |
| P: per-runner FIFO ordering of hold and control frames instead of the host's interrupted-run record | rejected: ordering must hold across the commit, the write queue and reconnects; the record is local to the host and typed |
