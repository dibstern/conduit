# Amendment 2026-10-28: the run record answers every send question (T + U + V)

Decided autonomously on 2026-10-28 under the AGENTS.md Review Rounds rule, after three consecutive
material review rounds on the SEND-CONTINUATION build of conduit-test-82tn.32.17 (rounds logged on
the bead). This file wins over `AMENDMENT-2026-10-28-SEND-CONTINUATION.md` (C2's feeder, C3's
Settle and Restart wording), `AMENDMENT-2026-10-27-STOP-INTENT.md` (S2's commit failure) and
`AMENDMENT-2026-10-28-RUNNER-SWAP.md` (who serves at release and at a candidate stop). Everything
else in them stands. CONTRACT.md carries the result (2, 4.3-4.5, 4.7-4.9, 4.11, 6.3, 6.4,
6.9, 6.10, 7.1, 7.2, F12, 10.6, 12.2, A.10).

User-visible behaviour: unchanged from SEND-CONTINUATION, plus:
- A send whose runner cannot start fails once, visibly, with its text back in the composer, as on
  main. A start failure that says it is transient (`retryable: true`, such as
  `account_switch_busy`) is re-sent after the 4.8 backoff, as on main.
- Stopping the daemon never fails a send.

## Why

| round | material findings |
|---|---|
| 1 | legacy recovery lost for runs with no dispatch event; journal outcomes not settled before the Gone sweep; a local admission failure left the send held; exit cleanup not retried after a failed Stop commit |
| 2 | a non-retryable owner recovery failure never settled; adoption skipped the shared legacy predicate; cleanup ownership lost for hosts without a cursor row; a failed settlement observation not retried; held indeterminate replies settled by adoption |
| 3 | feeder retried a settled run forever (C1); an unstartable runner retried forever (O-P2); an adopted completion finished the outbox and left the run open (C3); a failed CandidateAbandoned Stop commit was dropped (C4); interruption settled sends failed; the release stop read the in-memory row |

Each round was the same class. R2 answers three questions in memory at the call site, each with
its own copy:
- **(a) Is this send live?** Seven copies: the feeder's `waiting`, `abandoned` and `restoring`
  maps, `cancelledBeforeWrite`, `ownerSends`, `restoringOwners` and `pending.cancelled`.
- **(b) Is this failure terminal?**
  - Seven retry sites decide when to stop: the feeder's inner retry, the `Unserved` repeat,
    `retryRunnerPersistence`, `restore`, `enqueueOwnerSend`, the `settled` poll, and legacy
    recovery's replay retry (`runner-legacy-recovery.ts:226-231`).
  - The feeder and legacy recovery invert main's polarity (`retryable !== false`), so an unset
    flag retries.
- **(c) Who ends the send, and who owns a failed write?**
  - Seven terminal writers, a `settleRun` flag that ends the outbox without the run, and a direct
    outbox `UPDATE` beside the projection that already ends outbox rows with their run.
  - A failed Stop commit is owned by the failing fiber, which logs it and drops it.
  - Five readers of who serves that decide a write: `holdRun`, `releaseRun`, the release stop step
    (memory), `start` (memory) and the upgrade's candidate stop guard (memory,
    `process-session-runner.ts:3468`).

Only the run record answers (a), (b) and (c) correctly after a crash. This amendment makes it
answer them every time.

## Data shape

1. **`Hold` is total.** Every domain answer is a value. Only the store fails.

   ```ts
   type Hold =
     | { _tag: "Held"; runner: RunnerId; transmission: number }
     | { _tag: "Cleaning"; runner: RunnerId } // an unretired candidate, with no serving row
     | { _tag: "Unserved"; predecessor: Option<{ runner: RunnerId; until: Millis }> }
     | { _tag: "Busy" }      // already held: the hold's owner ends or releases it
     | { _tag: "Covered" }
     | { _tag: "Exhausted" }
     | { _tag: "Ended" };    // terminal, no owner send, or a commandId that is not the run's
   holdRun(session, run, commandId): Effect<Hold, StoreFault>
   ```

   `StoreFault = StoreUnavailable | StoreRejected`. Only `StoreUnavailable` schedules a retry.
   `StoreRejected` is the existing typed per-row decode/identity rejection, diagnosed and
   surfaced by that operation's caller without killing the session consumer. Do not invent a
   terminal for an uncorrelated corrupt row. Other queued items still run. There are no
   domain refusals in this error channel. Apply this same distinction to settlement and register.

   `Cleaning` names a durable candidate row, not the in-memory `Committing` state. The feeder
   submits `CandidateAbandoned`, waits for its commit, then calls `holdRun` again. It never
   starts a replacement while that candidate is unretired. A serving registration rechecks the
   same condition in its transaction. With several candidates, choose the lowest row sequence
   and re-read after each commit. A serving row wins over this check, preserving warm upgrades.

   `until` is the predecessor's Stop window end, `(stop_started_at ?? retired_at) + 4 s`: the same
   bound `awaitStop` already gives its callers (`runner-retirement.ts:819-827`). One function in
   the lifecycle module computes it for both, so the park and the wait cannot disagree.

2. **Evidence in, one classifier.** Callers pass what they saw; only `classify` decides what it
   means. No caller can label a failure retryable.

   ```ts
   type SendEvidence =
     | { _tag: "replied"; send: HeldSendRef; result: TerminalTurnResult }
     | { _tag: "journal_finished"; send: HeldSendRef; answer: FinishedJournalAnswer }
     | { _tag: "failed"; send: SendRef; failure: SessionFailure } // proven pre-hold: start refusal, cap, recall before hold
     | { _tag: "covered"; send: SendRef } // stopCovers proved coverage of this unheld run
     | { _tag: "process_lost"; send: HeldSendRef; reason: StopReason }
     | { _tag: "delivery_unknown"; send: HeldSendRef }; // Settle only (4.7, 4.11)
   type SendOutcome = // the Run Effect vocabulary (3.12), plus Stop
     | "succeeded" | "retryable" | "permanent" | "cancelled" | "delivery_unknown";
   classify(evidence: NormalizedTerminalEvidence): SendOutcome
   ```

   Derive these types from existing protocol/store schemas. `SendRef` holds session, run,
   command id, request sequence and claim attempt. `HeldSendRef` adds runner and transmission.
   A reference is part of its evidence, so mismatched arguments cannot name two sends.
   `TerminalTurnResult` narrows `TurnResult.status` to `completed | error | interrupted |
   cancelled | steer-declined`. `accepted`, `joined` and `indeterminate` never enter this type.
   Resume rejection is handled as `ResumeRejected` before classification, including a cached
   journal answer. An `undefined` reply is not terminal evidence. A `journal_finished` answer
   without a terminal result or failure supplies consumption evidence only; it cannot fail a send.

   Before the ledger switch, the outbox adapter normalizes a `journal_finished` answer with a
   terminal result/failure into terminal evidence, preserving the source tag for migration.
   It skips intake-only or missing results. `classify` accepts only this normalized evidence.
   `process_lost` preserves its reason for the phase's existing process-loss settlement.
   `failed` is checked as an unheld refusal; it cannot carry a post-write socket failure.
   Every normalized variant has an explicit classifier branch, checked exhaustively. A missing
   branch must fail type checking, not fall through to permanent.
   `classify` is the existing rule, extracted once from `runner-recovery.ts:266-272` and the
   reactor's `isRetryableProviderFailure` (main, `=== true`):
   - `failed` is `retryable` only when `failure.retryable === true`;
   - `covered` is `cancelled`; `delivery_unknown` is `delivery_unknown`;
   - `replied` is `succeeded` when completed, `cancelled` when interrupted or cancelled, and `retryable` only
     when the status is not `steer-declined`, `error.retryable === true` and
     `error.retryHandled !== true`;
   - everything else is `permanent`.

3. **Send Settlement.** The explicit settlement owner for modern owner sends, before each provider switch.

   ```ts
   settleSend(tx, evidence: SendEvidence): Effect<void, StoreFault>
   ```

   `SendRef` carries session, run, command id, request sequence and claim attempt. A reply,
   journal answer or delivery-unknown observation also carries its runner and transmission.
   In the transaction, re-read the exact command/run association and claim, the run status,
   and, for held evidence, `(runner_id, held_transmission)`. A stale claim or transmission
   changes nothing, including duties. A pre-hold start failure applies only while that send is
   still unheld. A reply for a released transmission never settles a later hold. Joined steers
   keep 4.8's separate rule until 32.5; a declined steer never ends its owner's Run.

   - It runs inside the caller's write transaction and appends exactly one run terminal event,
     guarded by the run's status: `turn.completed`, `turn.interrupted` or `turn.error`.
   - The outbox row is ended by the projection of that event (`settleRunCommands`,
     `projectors-effect.ts:1741-1799`), in the same transaction. Send Settlement writes no
     outbox status itself.
   - For `succeeded`, `permanent`, `cancelled` or `delivery_unknown`, the run ends once.
     `delivery_unknown` ends it with a `turn.error` coded `delivery_indeterminate`; the projection
     copies that code to the outbox row, which is the runner-held marker of CONTRACT 2 row 141.
     Settle writes no separate outbox marker, and the row is never re-sent.
   - The event carries `classify`'s answer, not the source's flag. `settleRunCommands` reads
     only the event's `retryable` and `retryHandled`, so a non-retryable outcome's `turn.error`
     never carries `retryable: true` (a steer-declined or `retryHandled` reply flagged retryable
     stays permanent). The projection therefore cannot decide differently from `classify`.
   - For `retryable`, the run ends with a `turn.error` carrying
     `retryable: true` and `retryAt` (the retained evidence's observation time plus 4.8's
     backoff of the outbox row's `attempt_count`, as the reactor computes it today,
     `orchestration-side-effect-reactor.ts:927-934`; a retried write of the same evidence
     therefore produces the same value; the projection uses it, `projectors-effect.ts:1780-1784`); the projection moves the outbox row to
     `retryable_failed`; the reactor re-sends it on a fresh run (`markRunning`), and `holdRun`'s
     cap keeps counting by `commandId` across runs (4.8, F50). Nothing is left open.
   - If the run had already ended, nothing is written. There is no public verdict union.
   - **Wake.** When it appends, the same transaction stamps the session version (today's
     `changed` stamp, `process-session-runner.ts:1915-1958`). After commit, every caller that is
     not the reactor itself (holdRun's feeder step, the Starter outcome, Settle, adoption and
     the attachment's retained reply, Gone-time) calls `wakeReactor` (`drainSideEffects`, idempotent) unconditionally, so a
     `retryable_failed` row is re-sent at `retryAt` without a returned verdict. The periodic
     outbox drain (`daemon-orchestration-layer.ts:279-287`) is the backstop. A projection commit
     alone wakes nothing.
   - Pending evidence (the journal says `running`) is not evidence. Callers do not call
     `settleSend` for it, so the run stays held.

4. **Start.** `start(session): Effect<"Started", StartFailed>`, where `StartFailed` carries a
   `SessionFailure`. Closing the daemon interrupts; it never returns `StartFailed`.

## S1. `holdRun` is the gate, and the feeder keeps no retry loop

- **Where it lives.** `holdRun` is the runner lifecycle module's call (6.10). Its runner SQL (the
  serving row, the retirement rows) lives in that module, inside one `commitAndSignal.write`;
  commit-and-signal keeps no runner columns or runner SQL (32.17's acceptance). `releaseRun`
  moves the same way.
- **Steps.** Steps 1 to 5 of 4.3 stand, with these changes:
  - Steps 1 and 3 settle through Send Settlement (`covered`; `failed` with
    `provider_send_attempts_exhausted`, retryable unset).
  - Step 2 returns `Ended` for a terminal run, a run with no owner send, or a `commandId` that is
    not the run's. It returns `Busy` for a held run.
  - Step 4 reads the session's non-retired `serving` row and its retirement rows in the same
    transaction. With no serving row:
    - any non-retired candidate gives `Cleaning{runner}` before considering retired predecessors;
    - a retired runner of the session that is not confirmed Gone and whose `until` is still in the
      future gives `Unserved{predecessor: Some({runner, until})}`;
    - otherwise `Unserved{None}`.

    The rule reads only the row and the clock, so it agrees with the reconciler for every row,
    a legacy row (written after its window, so `until` is past) and a runner the reconciler has
    not loaded included.
  - Only transient StoreUnavailable retries. Existing per-row rejection is StoreRejected, surfaced once.
- **Feeder memory** is the per-session queue of owner sends, keyed by `(session, run, commandId)`,
  and each send's capability: a live handle to its caller, or `Adopted` (the transmission is built
  from the outbox row when the step is `Held`). Nothing else.
- **The resume mode is durable, not a key part.** Today's feeder key includes
  `nativeResumeFallback`. The mode lives on the outbox payload (`payload_json.nativeResumeFallback`,
  written by fallback preparation, `claude/prepare-turn.ts:746`, before n+1 is enqueued). At
  `Held` the frame is built in the payload's mode. A capability whose mode disagrees with the
  payload is stale and is replaced. For one key a live capability replaces an `Adopted` one,
  never the reverse.
- **Three sources enqueue**, each idempotent by key: the reactor's dispatch, every committed
  release (4.4; except `ResumeRejected`, whose fallback decision owns the next transmission,
  4.8), and the restart scan. A key already queued is not queued twice; a key being stepped is
  queued again, so a release that commits during a step is never lost.
- **One step per wake.** The feeder calls `holdRun` and switches on the result:
  - `Held`: hand the transmission to its write fiber; the step ends.
  - `Busy`: drop. The hold has an owner: the reply, Settle, adoption, or a release, which
    enqueues the send again.
  - `Cleaning{runner}`: submit `CandidateAbandoned` through the lifecycle module, await its
    commit, then step again. Race this wait and every start/readiness or predecessor park with
    the head's run on the commit signal (arm, then re-read): the race ends when the run is
    terminal or `stopCovers` covers it. Coverage is not a run terminal, so `awaitRun` alone would
    sleep through an accepted Stop until the park ends, where main cancels at once. The feeder
    then steps again; `holdRun` settles `Covered` or returns `Ended`. A settled or covered head
    lets the next queued send run without awaiting a stuck start. No other commit ends the race,
    so a second start is never issued for the same head.
  - `Unserved{Some({runner, until})}`: park until `awaitStop(runner, "Escalated")` returns or
    `until` passes, whichever is first, then step again.
  - `Unserved{None}`: start (S4), then step again.
  - `Covered`, `Exhausted`, `Ended`: drop.
  - `StoreUnavailable`: wait one backoff (4.8), then step again.
- **The write fiber** has three outcomes:
  - the runner replies: the reactor's runner reply settles it (S2);
  - release evidence (4.5): `release`; a `StoreUnavailable` waits one backoff and runs the same
    release again, until it commits (a duplicate or stale release is a no-op, 4.5);
  - a failed write or a lost reply with no evidence: nothing; the send stays held for Settle or
    adoption.
- **Keep the local write revocation guard.** The per-send capability, shared by the queued
  step and its write fiber, retains the existing `releasedTransmission` watermark. Only a
  committed matching release advances it, before retirement cleanup and enqueue. Before the
  first byte, consume the capability once and synchronously reject a hold at or below that
  watermark. The check and socket write have no yield between them. A delayed `Held(n)` result
  after release n therefore cannot write, and a duplicate wake cannot write n twice. This is
  local I/O permission, not send liveness or a second durable transmission counter. It dies
  with the capability; after a daemon restart no old write fiber survives. Do not recreate a
  waiter map or put this value in SQL. Adoption uses the same provider-owned admitted capability.
- **Every re-entry goes through `holdRun`.** The feeder and its write fiber have no
  `Effect.retry`, no `Effect.repeat`, no `catchCause` and no poll. The two backoff waits are the
  only clock waits besides the predecessor's `until`.
- **A failed settlement has an owner too.** The source retains the same immutable evidence
  until its transaction commits or becomes stale. A start refusal's settlement is owned by its
  feeder write fiber; a live reply by the reactor call; Settle by the reconciler; adoption by
  the attachment. Each waits one backoff after `StoreUnavailable` and retries that write with
  fresh correlation checks, without another start or transmission. A crash loses no held
  evidence: reply/journal recovery owns it. An unheld start refusal may be attempted afresh on
  restart, as on main. Store decode rejection, a protocol rejection and defects are never
  relabelled `StoreUnavailable` and retried forever.
- **Interruption is not an outcome.** An interrupted feeder or write fiber writes nothing. The
  restart scan owns every unheld send; Settle and adoption own every held one.
- **Backoff accounting.** Each pending store operation owns its local retry ordinal, used only
  to pace 1 s, 2 s, 4 s and so on up to 30 s. Reset it when that operation commits or is stale.
  A read fault in `awaitRun` has its own ordinal. These are pacing counters, never liveness,
  delivery or transmission counts, and may reset on restart. Use the same pure 4.8 function.
- **The live caller waits on its run.** `awaitRun(runId)` arms the commit signal, then re-reads
  the run's status, and returns when the run is terminal or absent. A failed read backs off,
  re-arms and re-reads. Use the store's commit notification, including silent lifecycle
  writes, not a browser-event-only subscription. Local admission and attempt replies remain
  capability signals, not lifetime decisions. In particular, after a committed
  `ResumeRejected` release the preparation caller receives that refusal immediately so it can
  commit the fresh fallback and enqueue transmission n+1; it must not await a terminal that
  only the fallback can produce. Restart reconstructs this pending fallback from the release
  and durable fallback preparation before sending again. No blind resume re-feed is allowed.
- **Restart** feeds every unheld, non-terminal owner send to the feeder as `Adopted`. There is no
  `restore` retry and no `settled` poll.
- **A user Stop between the hold and the write** needs nothing in memory: the host refuses the
  later `send-turn` as `interrupted` (4.6), 4.5 releases it, and the next step is `Covered`.
- **Other cancellation sources are durable too.** Deleting `pending.cancelled`,
  `cancelledBeforeWrite` and `ownerSends` removes the in-memory paths three non-Stop sources use
  today (main has the same three):
  - the reactor's recall after `PROCESSING_TIMEOUT_DURATION` or a durable-outcome error
    (`orchestration-side-effect-reactor.ts:752-826`): for a send that is still unheld, it calls
    `settleSend(failed{code: processing_timeout, retryable unset})` in a transaction that
    re-reads "not held"; the feeder's next step is `Ended`. For a held send it writes nothing,
    including no uncertainty marker. Settle remains the only writer of a runner-held send's
    `delivery_indeterminate`. The hold's owner (reply, Settle, adoption) ends it. Without the
    unheld rule a queued send recalled at 2 minutes would be
    marked indeterminate and delivered later, where main fails it;
  - the runner's `abort` command (`runner-provider-instance.ts:540-580`, sent on caller
    interruption, on recall and on account revocation): its branch that cancels an undispatched
    owner send in memory (`process-session-runner.ts:4584-4599`) is deleted. An unheld send is
    ended by the recall rule above, by a durable Stop, or by the reactor's own call failure:
    account revocation also fails that call (the invalidation races the operation,
    `runner-provider-instance.ts:976-977`), and for a still-unheld send the reactor passes that
    failure to `settleSend` as `failed`, classified by its flag; for a held send it writes
    nothing. Forwarding `abort` to the host for a
    written turn is unchanged. The `interrupt` loop (4600-4610) already skips owner sends and
    is untouched. A user interrupt is a durable Stop: 5.3 settles pending rows, `holdRun` step 1
    settles a claimed unheld run, and 4.6 refuses a held but unwritten one.

## S2. One Send Settlement module

- **Callers.** `settleSend` is called by:
  - `holdRun` steps 1 and 3 (inside its transaction);
  - the reactor's runner reply, and its recall of a still-unheld send (S1);
  - the Starter's outcome (S4);
  - Settle (the only caller that passes `delivery_unknown`);
  - adoption's journal answers;
  - the attachment's retained reply after a reconnect (`onCommandReply`,
    `runner-connection.ts:320-344`, today turned into a `finished` journal answer at
    `process-session-runner.ts:2879-2908`). It is passed as `replied` with the held answer's
    runner and transmission, not as `journal_finished`: it is a real provider reply, and after
    the switch `finished` proves consumption only (case 77);
  - Gone-time settlement (`processLost`).

  This is the one explicit settlement module for modern owner sends. Native event projection
  remains an existing terminal source until the ledger switch. Its missing attempt guard
  (`projectors-effect.ts:1749-1799`) is also on main and belongs to 32.2.6 and 32.6 under Q26.
  Do not pull that redesign into R2 or claim that all run terminals already have one writer.
  Nothing writes a modern runner-held row's outbox status except the projection and the
  reactor's claim. Settle's runner-held `delivery_indeterminate` (CONTRACT 2 row 141) is the code
  the projection copies from Settle's `delivery_unknown` terminal, so Settle stays its only
  source without a second outbox write. The reactor's nonterminal uncertainty marker remains
  direct-provider-only (4.10), including on recall. Stop acceptance's
  settlement of still-pending rows in its own commit (5.3 item 4) is an existing separate
  source, as on main; it never touches a claimed run.
- **The `settleRun` flag and the direct outbox `UPDATE` are deleted**
  (`runner-recovery.ts:478-491`). A modern run's outbox row ends only through its run's terminal.
  The duties that sit beside it (receipt, failed message placement, draft restore) commit in the
  same transaction, in 4.7's order.
- **Legacy recovery** keeps its own settle path, keyed by a type no modern caller can build, and
  its replay failure goes through `classify`: its `retryable !== false` retry
  (`runner-legacy-recovery.ts:226-231`) and the `retryable === false` catch
  (`process-session-runner.ts:5795`) are deleted.
- **`classify` decides send retry policy once.** Producers set/copy the flag and protocol
  boundaries validate it. The projection reads event data; native events remain an existing
  separate source until the ledger switch under Q26.
- **Provider migration, with source evidence retained:**
  - the outbox adapter (append the run terminal; the projection ends the outbox row), from now
    until each provider's ledger switch;
  - at 32.6 for Claude, 32.10 for Cursor and 32.21 for Codex, replace the outbox adapter with
    the ledger's source-specific inputs (4.7 and 4.11). A journal `finished` answer proves
    consumption only; its cached result cannot become a fabricated runner reply. A real
    interrupted/cancelled reply is provider result evidence, never a new `control stop`.
    `covered` refers to an already accepted Stop and issues no second control. `processLost`
    records `settle process_lost`; it is never flattened to a generic failed effect. Correlate
    tokens and unbound start refusals through that provider's interpreter. Never mint a token
    for a transmission that was not issued. The policy keeps its one terminal classifier.

  The outbox adapter is deleted with the outbox at 32.13. Switch tickets own these call-site
  changes and delete the old path in the same change. Do not build an unused ledger adapter now.
- **`processLost`** becomes a no-op for a provider at its switch: the retirement commit settles
  the runs (6.5).

## S3. A failed Stop commit is the reconciler's to retry

- **The state.** `Committing` carries `{ target: StopTarget, reason, waiters }`. `StopTarget`
  is the runner/session/driver and verified or unverifiable process identity from the existing
  schemas. It carries no `retired_at`, stop-progress tag or signal log. An uncommitted intent
  must not type-check as a durable retirement record.
- **The change.** `requestStop` registers the intent before yielding, then waits for its commit
  or a decode rejection. The reconciler's scope owns the worker, not the caller's fiber.
  Cancelling a caller cancels only its wait. When the commit step fails with a store fault:
  - the intent stays `Committing`;
  - the reconciler re-runs the whole commit step (candidate snapshot, process observation, row
    write) after one backoff (4.8), until it lands, and logs each failure. It rechecks the row,
    role, identities and candidates inside the transaction. `retired_at` is the successful
    commit's time, not the time of the first failed attempt;
  - waiters wait on it, and a second Stop joins it;
  - the runner keeps serving until the commit lands.
  The reconciler starts tracking Committing immediately. Its Committing branch performs only
  Commit/rejection, never shutdown, signal, Settle or Prune. It does not feed this target through
  `stoppedState` or the durable-row tick. Only the successful transaction's returned retirement
  row permits Requested and post-commit actions. Ignored returns to Running with no such actions.
- **Restart backstop.** `Committing` is not durable. A daemon that dies before the commit lands
  re-derives the stop at restart (7.2), per caller:

  | caller | restart backstop |
  |---|---|
  | upgrade candidate stop, register failure (`CandidateAbandoned`) | `recover` stops every unretired candidate row (`runner-retirement.ts:758-787`) |
  | idle exit, a dead process | `recover` stops a dead pid `Exited` |
  | failure cleanup, dead process | pid/start-time recovery requests `Exited`; failed attachment retries up to four times, then retires the survivor (`process-session-runner.ts:3973-4045`) |
  | durable end-session or explicit user Stop | reactor `prepareRecovery` resets uncompleted running controls to pending (`orchestration-side-effect-reactor.ts:344-363`, bounded by `maxControlAttempts`); their committed control/cohort is replayed. A control is not acknowledged before the retirement commit |
  | live runner after a recoverable transport failure; direct lifecycle Stop with no durable control | if restart reconnects successfully, it cannot recover an uncommitted transient intent. Main also has no such persisted intent. This bounded Q26 limitation is explicit; 32.4/32.6/32.8 own durable process-loss/control reconciliation, not a new R2 intent table |

  An already committed Stop is always recovered from its retirement row. Do not describe the
  last row as a guaranteed restart backstop. End-session's deleted-session case additionally
  retains the exact runner's outstanding end command (`process-session-runner.ts:3835-3854`).

- **A decode rejection** of the runner's row still fails `requestStop` and its waiters (F13);
  retrying cannot fix it. The state returns to `Running`.
- **`Superseded`** (the swap) keeps its failure channel, because the upgrade owns its backoff
  (6.9).
- **`CandidateAbandoned` checks the role in its transaction.** If the row is already `serving`
  (the candidate was promoted), the commit writes nothing and returns `Ignored`. Other
  successful requests return `Requested`, including joins of an already committed Stop.
  `requestStop: Effect<"Requested" | "Ignored", StopFailed>` therefore has one real result
  distinction. A caller that receives `Ignored` never calls `awaitStop` or closes that runner's
  scope. Its state stays Running. Joiners recheck their own reason after an Ignored request;
  a different Stop is not silently discarded. The Committing waiters carry that result.
  This replaces the
  in-memory guard `stops.serving(entry.sessionId) === entry.runnerId`
  (`process-session-runner.ts:3466-3476`).
- **Callers lose their own retries.** These keep no `retryRunnerPersistence` and no
  `catchCause(logError)` around the call:
  - the upgrade's candidate stop;
  - register's failure cleanup (`process-session-runner.ts:3110-3115`);
  - failure cleanup (`stopRunner(..., "failure")`);
  - end-session;
  - idle exit.

## S4. A start outcome is classified as on main

- `StartFailed` goes to Send Settlement as `failed{failure}`. `classify` makes it `permanent`
  unless the failure sets `retryable: true` (main's rule, which re-sends `account_switch_busy`
  at its backoff). Permanent: one `turn.error`, and its text returns to the composer; the next
  message tries again.
- **`StartLost`** is `Unserved{None}` on the step right after `Started`: the runner
  started and was gone before the bind. It settles as `failed` with code `runner_start_lost`,
  retryable unset, so it is `permanent`.
  A `Cleaning` result or a stopping predecessor is not `StartLost`: perform that prerequisite
  and re-read. Preserve main's explicitly transient idle/recovery conditions through release
  evidence or an explicitly retryable start failure; do not turn them into `runner_start_lost`.
- A start is never retried inside the feeder, and no start budget exists in memory. A failure
  that is `retryable: true` forever is re-sent forever at the 30 s cap, as on main (Q26).
- **Register.** `register(runner, session, role)` returns `Registered | Lost` and fails only on
  the store. `Lost` (the session's partial-unique serving row names another runner) stops the
  loser `CandidateAbandoned` and `start` returns `Started`; the next `holdRun` binds to the
  winner. A store fault fails the start through the classification below.
  The registration transaction also refuses a serving insert while an unretired candidate
  remains and no serving row exists. Return `Lost`, clean up the unused spawned process, and
  re-enter the gate's `Cleaning` branch. A definite store-unavailable registration failure is
  explicitly retryable; a rejected row or permanent spawn failure is final. Do not infer this
  from an absent retry flag.

## S5. Who serves is read in the write transaction

- `releaseRun` passes the `ServingRow` it read in its transaction to the release's stop step.
- The candidate stop reads the role in its commit (S3).
- `start` reads nothing about serving (S4).
- The in-memory registry (`serving`, `currentEntry`) is a cache for routing a live caller to its
  entry. No write decision reads it: no hold, no release stop, no Stop commit, no start.

## Deleted or changed

- **`runner-send-feeder.ts`:**
  - deleted: the inner `Effect.retry({ while: retryable !== false })`, the `Unserved` repeat, the
    transmit fork's `catchCause` to `failed`, `retryRunnerPersistence` around `release` and
    `failed`, the `settled` observation, and the `waiting`, `abandoned`, `restoring`,
    `cancelledBeforeWrite` maps. Keep `releasedTransmission` only on the shared I/O capability;
  - changed: the feeder becomes the S1 step; `released` becomes the enqueue of a committed
    release; the queue key drops `nativeResumeFallback` (the payload carries the mode).
- **`orchestration-side-effect-reactor.ts`:** the recall settles a still-unheld modern owner send
  through `settleSend` (S1). A held send is untouched. Keep the direct-provider uncertainty path
  separate; it never writes a runner-held marker.
- **`process-session-runner.ts`:**
  - deleted: `settleOwnerSendFailure`, `enqueueOwnerSend`'s retry and final settle,
    `recoverOwnerSends`' restore retry and settled polls, the `ownerSends` and `restoringOwners`
    maps, the `authority.records` predecessor scan in `start`, `servingEffect`/`currentEntry` in
    `start`, the candidate stop's in-memory guard and `catchCause(logError)`, the `abort`
    command's in-memory cancel of an undispatched owner send with its `pending.cancelled`
    signal (4584-4599), and the `retryable === false` catch at 5795;
  - changed: adoption's `settleRun: !modern` becomes a `settleSend` call; Settle's and adoption's
    held-run queries (1361, 2533) select by the held run and drop `command.status = 'running'`.
- **`commit-and-signal.ts`:** `holdRun` and `releaseRun` move to the lifecycle module (S1);
  their two "Run is not dispatchable" throws and `HoldCommandIdMismatch` become `Ended` or
  `Busy`.
- **`runner-recovery.ts`:** `settleRunnerCommandReply`'s classifier moves to `classify`; its
  direct outbox `UPDATE` and `settleRun` are deleted; it is called only by the outbox adapter.
- **`runner-legacy-recovery.ts`:** the replay retry (226-231) is deleted; a replay failure is
  classified.
- **`runner-retirement.ts`:** `requestStop`'s `CommitFailed` reset to `Running` (with failed
  waiters) is replaced by S3. `release`'s `refreshRows()` lookup for the stop step is replaced by
  S5. `register` returns `Lost` as a value.
- **`runner-retry.ts`:** `retryRunnerPersistence` and `runnerRetrySchedule` have no send-path
  caller.

## Out of scope

- **Reading a dead runner's retained spool (round 3, C2).**
  - Contract 3.8 says a result after process loss changes nothing; 6.7 and 7.2 drop a retired
    runner's spool before replay.
  - Main deletes it too (`runner-registry` `removeRunner`), so R2 is no worse than main (Q26).
  - Gone-time settlement, where R2 would read it, is deleted at 32.6.
  - A runner holding unacknowledged spool does not exit idle, so the loss needs the runner to die
    while detached.
  - Follow-up bead (needs-triage, after 32.6): reopen 3.8 if output produced while detached
    should be kept.
  - Prune deletes a retired runner's spool explicitly, after Settle. 7.1's "stay for startup's
    Settle" wording is corrected (CONTRACT edits). A live runner's spool is still replayed at
    adoption.
- **Outbox re-sends:** 32.2.6, unchanged.
- **Run Effects and the interpreter:** 32.3 and 32.6, unchanged.

## Verified requirements and remaining implementation checks

1. **Resolved. Pre-warm opens the native query.** `in-process-session-runner.ts:232-234` calls
   the pre-warm payload; `claude-warmed-query.ts:277-330` constructs the SDK query and calls
   `initializationResult()`. Keep never-served candidates in the predecessor set. A failed
   candidate Stop leaves its row unretired (`runner-retirement.ts:555-581`), so the old
   retired-only query cannot see it. S1's durable `Cleaning` branch and registration recheck
   close this gap without making in-memory `Committing` another dispatch authority.
2. **Inventory of the retry sites.** Every `runnerRetrySchedule`, `retryRunnerPersistence`,
   `Effect.retry` and `Effect.repeat` in `src/lib/provider/runner/` is listed with one owner and
   one of: send path (deleted by S1 to S4), reconciler cadence, or upgrade backoff.
   - The admission `do { ... } while (draining)` loop is 4.8's deleted "draining re-selection".
     It becomes a park on the entry's readiness or is deleted.
   - The other sites to classify: the upgrade drain wait, the orphan-cleanup poll, reconnect,
     `awaitStop`'s own repeats, and `runner-upgrade.ts`.
3. **No producer of a transient runner failure leaves `retryable` unset.** Producers to check:
   `runnerFailure` (copies the flag only when boolean, `runner-protocol.ts:370-391`), the socket
   connect, the spawn, `register`, the runner's `busy` refusal, `runnerIdleFailure` (sets `true`,
   393-398), `account_switch_busy` (sets `true`, 4807 and 4913), the legacy replay, and every
   `turn.error` the runner host emits. Main's inline retry of `runner_idle_exit` and
   `runner_recovery_abandoned` (main `process-session-runner.ts:3661-3667`) must still retry.
   The inventory is a build deliverable, not permission to assume every unset error is final:

   | producer/boundary | required treatment |
   |---|---|
   | `runner-protocol.ts` `runnerFailure`, `RunnerSocket` closed/write/decode paths; `runner-connection.ts` hello/replay/attach/ACK errors | preserve flags at the boundary; after a hold, raw socket/write/missing-reply errors stay held, never become a failed send |
   | `process-session-runner.ts` spawn, startup timeout, readiness, register, account-demand invalidation, busy/account-switch admission | permanent binary/config/auth/startup rejection is final; unavailable store registration is explicitly transient; `account_switch_busy` remains true |
   | `runnerIdleFailure`, legacy pre-accept `runner_idle_exit`, recovery `runner_recovery_abandoned` at 4021-4036 | NotSent/Refused evidence releases when proved; otherwise preserve main's transient unaccepted recovery case explicitly, never classify by code after possible delivery |
   | `runner-host.ts` execute/send-journal catch and account-switch refusal; `runner-turn-failure.ts` | normalize actual host terminal failures once; terminal event flag matches classification; never send raw defects or interruptions through `failed` |
   | `runner-legacy-recovery.ts` decode, attachment resolution, prepare/send/replay catch | retain explicit false for malformed/missing input; true retries require a live legacy key and evidence that replay is safe, with its immutable dedup key unchanged |
   | `claude-runner-payload.ts` and `claude-runner-launch.ts`, `claude/prepare-turn.ts`, runner provider-instance refusal adapter, Cursor/Codex runtime error translators | preserve upstream retryability and `retryHandled`; native-resume refusal goes to fallback; `accepted`, `joined` and `indeterminate` never become permanent merely because retryable is unset |

   Search all constructors, spreads, `mapError` and host-produced `turn.error` routes in these
   modules, including lower adapter errors they forward. Record the source code and observed
   wire/event outcome for each family. The legacy path keeps safe explicitly transient replay
   after backoff through its owner; deleting its generic inverted retry must not delete that
   main-parity behaviour. Any newly found producer joins this inventory before the polarity flips.
4. **Resolved. Restart backstops have limits.** S3 names the durable controls, candidate and
   dead-process rules, plus the live reattachment limitation shared with main. A healthy live
   process and an uncommitted direct lifecycle request do not have a guaranteed restart Stop.
   Keep that Q26 limitation explicit and assign it to 32.4/32.6/32.8.
5. **Resolved. Release retry has two owners by source, not one cadence for both.** Settle's
   failure propagates from `process-session-runner.ts:1393-1401` into `safeTick`
   (`runner-retirement.ts:343-352`), which retries before Prune. Adoption's release
   (`process-session-runner.ts:2577-2584`) fails the attachment. Its existing bounded
   attach/recovery sequence (3973-4045) retries the hello; after exhaustion the runner is
   retired and its still-held runs go to Settle. Keep the release error propagating; never
   swallow it or invent a second adoption retry loop. Source evidence remains until commit.
6. **Resolved. `Verdict` reduces to void.** The one boolean reader, adoption
   (`process-session-runner.ts:1915-1958`), uses `changed` only to stamp the session version and
   fork `wakeReactor` (`engine.drainSideEffects()`, `provider-adapters-layer.ts:143`). No path
   runs from a projection commit to a reactor drain, so the projection cannot supply that wake.
   Instead `settleSend` stamps in its own transaction when it appends, and every non-reactor
   caller wakes the reactor unconditionally after commit (data shape 3, Wake); the drain is
   idempotent and the periodic drain is the backstop. No consumer needs Ended/Requeued/Stale
   branching. Stale logging stays inside settlement. The retry time is event data, never a
   return-value owner.

## Required work

The order is the build order under 32.29: S2 (with the Settle query change), then S1 and S4, then
S3 and S5, then stress/E2E verification and the module split. Each child writes and sees its regression test fail at the named seam before its production edit; tests are not postponed until after S1-S5. R2 phase 2 is committed on `wt/82tn3216` as a
checkpoint first (the 2026-10-28 user note on 32.29).

## Failure modes this must handle

SEND-CONTINUATION's 19 to 45, RUNNER-SWAP's 11 to 18, STOP-INTENT's 1 to 10 and the reaper's 1 to
11 still apply. Added:

46. A hold attempt fails with a store fault, then the user's Stop settles the run: the next step
    returns `Ended` and the feeder takes the next send (round 3, C1).
47. A held run is fed again (a release raced the restart scan): `Busy`, dropped, one
    transmission, no error.
48. A run settled while queued (Stop, reply, Settle): `Ended`, dropped, no write.
49. The runner start fails with `retryable` unset: the send fails once, permanent, with its text
    back in the composer, and no second start for it (O-P2).
50. A runner starts and is gone before the bind: `StartLost`, the send fails once.
51. A failure with `retryable` unset anywhere on the send path is permanent.
52. The daemon shuts down while the feeder is mid-step: no send is settled; the restart scan feeds
    every unheld owner send.
53. Adoption reads a journal `finished` answer for a modern run before its retained terminal frame
    replays: the run ends and the outbox follows in one transaction; then the connection fails
    before replay: nothing is left for Settle (C3).
54. Adoption reads `running`: nothing is written, and the run stays held.
55. The `CandidateAbandoned` Stop commit fails, then the store recovers: the reconciler commits
    it, and the candidate is retired, signalled and pruned (C4).
56. The same with a daemon crash before recovery: restart stops the candidate row (7.2).
57. Failure cleanup's Stop commit fails: same as 55, with no caller retry.
58. A user Stop's commit fails: the runner keeps serving, the Stop waits, the reconciler commits
    it, and coverage holds through `holdRun` step 1.
59. A release commits while the in-memory registry still shows a replaced runner as serving: the
    stop step stops the row read in the transaction (O-P3).
60. A send arrives while the session's previous runner is stopping and survives TERM:
    `Unserved{predecessor}`, park, then TERM, 3 s, KILL, 1 s, `Escalated`, start, held, delivered
    once. If the head settles or a user Stop's commit covers it during the park, the feeder steps
    at once and starts nothing for it.
61. Two sends queued behind one stopping predecessor: one park; both are delivered in order.
62. A store outage lasting longer than the backoff cap: the feeder retries at 30 s through
    `holdRun`, and the session's later sends wait behind the head.
63. A held transmission fails with `retryable: true`: the run ends with a retryable
    `turn.error` and `retryAt`, the outbox row is `retryable_failed`, the reactor re-sends on a
    fresh run at `retryAt`, and the sixth transmission across runs is `Exhausted`.
64. A release fails with a store fault: the write fiber runs the same release after one backoff;
    the send is re-held once and delivered once. With a daemon crash first, adoption or Settle
    answers the held run.
65. Adoption or Settle releases a run (`NotSent`, `JournalAbsent`) that has no queue entry: the
    release enqueues it as `Adopted`; it is held again and delivered once. A `ResumeRejected`
    release is not enqueued; the fallback decision sends once.
66. A predecessor the reconciler has no state for (a legacy row, or before `recover` loads it):
    `holdRun` names it only until `until`; the feeder parks until `until`, never polls, then
    starts.
67. A start loses the serving-row race: `Lost`, the loser is stopped `CandidateAbandoned`,
    `Started`, the next step holds on the winner, delivered once.
68. A start fails with `retryable: true` (`account_switch_busy`): retryable settlement at the 4.8 backoff,
    as on main.
69. A legacy replay fails with `retryable` unset: settled failed once through the legacy path, not
    retried.
70. The upgrade stops a candidate that memory still shows as a candidate but whose row is already
    `serving`: the commit writes nothing, and the serving runner keeps serving.
71. A start or live reply is permanently refused, then its settlement commit fails transiently:
    the same evidence is committed after recovery, with no new start/transmission and one terminal.
72. A queued head settles, or a user Stop's commit covers it, while a readiness or `Cleaning`
    wait is pending (the predecessor park is 60): the feeder steps at once (`Ended`, or `Covered` settled by
    `holdRun`), not when the park ends, and the next send proceeds without waiting for that
    head's start or cleanup to finish. An unrelated commit does not end the wait or issue a
    second start. Cancelling its wait never cancels the reconciler's Stop obligation.
73. Native resume is refused: release commits, the caller receives the attempt refusal before
    run end, and fresh preparation sends n+1 once. Crash between release and fresh preparation:
    restart reconstructs fresh mode; a fresh refusal ends visibly.
74. A late reply/finished answer from a released transmission or earlier claim arrives after
    a re-hold/recommit: no terminal, receipt or draft mutation for the new transmission.
75. Candidate cleanup is `Committing` during an outage and no serving row remains: `Cleaning`
    prevents a new serving registration until cleanup commits; then the retired predecessor
    window applies. A covered/ended send leaves the wait. Normal make-before-break with a
    serving row still warms its candidate concurrently.
76. `requestStop` is cancelled by its caller before commit: the reconciler still commits and
    cleans up; another waiter joins. Decode rejection fails its waiters without signalling.
77. Before the ledger switch a journal terminal result may settle through the outbox adapter.
    After the switch, `finished` proves consumption only, an interrupted reply records provider
    evidence, and neither invents a Stop, changes coverage or interrupts a newer Run.
78. `accepted`, `joined`, `indeterminate`, a missing result and resume rejection never pass as
    generic permanent terminal evidence. An explicit `cancelled` reply becomes interrupted.
79. An unavailable registration/store read retries its owned write; a corrupt row or protocol
    rejection is diagnosed once rather than becoming an endless `StoreUnavailable` retry.
80. A release commits while Held(n) or its write fiber is delayed: that capability cannot write
    n later. Duplicate enqueue sources never write the same transmission twice. A matching
    release does not close the handle of its n+1 transmission, even on the same runner.
81. A promoted candidate receives CandidateAbandoned: `Ignored`, no awaitStop on Running, no
    scope close, no signal, continued service. A different concurrent Stop rechecks its reason.
82. While a Stop commit is unavailable, the Committing worker runs but sends no shutdown or
    signal and performs no settlement or prune. Only the successful commit unlocks those actions.
83. The reactor recalls a send after `PROCESSING_TIMEOUT_DURATION`: still unheld (queued behind
    a stuck head), its run ends once `processing_timeout`, permanent, text back in the composer,
    and the feeder later drops it as `Ended` with no write. Held (hold committed first): no run
    change and no marker write by the reactor; the hold's owner ends it once. Only Settle may
    write a runner-held delivery-indeterminate marker. Account revocation that fails the
    reactor's call follows the same split: an unheld send ends once `failed`, classified by the
    revocation failure's flag; a held one is untouched.

## Tests

Assertions are exact, as SEND-CONTINUATION requires. Each failure mode is tested at the highest
seam that can inject its fault: the session send interface (the reactor's dispatch into a real
runner manager with a fake runner process and a fault-injected store) for 46 to 54, 60 to 69
(69 through a runner restart that replays a legacy recovery);
the lifecycle module's interface for 55 to 59 and 70. Cases 71-75, 78-79 and 83
use the session send interface with real SQLite (83 with the reactor's recall clock advanced);
80 uses the same seam; 76, 81 and 82 use the
lifecycle interface; 77 belongs to each provider switch's contract tests. Assert run events, outbox and receipt where a send is
involved, and process/retirement state for stops. Fault injection must roll back the real write.
The normal real-process runner restart/upgrade suites also exercise 73 and 75 with JSON evidence
under `CONDUIT_RUNNER_EVIDENCE_DIR`, using temporary config and ephemeral ports.

1. **Gate.** `holdRun` returns `Ended`, `Busy` and `Unserved{predecessor}` as values for 46, 47,
   48, 60 and 66, and never fails with "not dispatchable". A test fails if any domain refusal
   reaches the error channel.
2. **Feeder.** A real gate with a fault-injected store: four failed attempts, a settle, then the
   next send held (the round-3 probe as a test). Shutdown mid-step writes nothing (52). A release
   that commits during a step is not lost (64, 65).
3. **Settlement.** For each caller in S2, one test shows that the run and the outbox row end in
   one transaction or not at all. 53 and 54 run through adoption; 63 and 68 through the reactor.
   Case 53 is the pre-switch outbox path. Settle finds no open run after its terminal commits;
   a failed transaction leaves both open. Do not also require that terminal run to stay held.
   Native projection versus explicit settlement races are characterized at main's Q26 bar;
   the missing native attempt fence is assigned to 32.2.6/32.6, not asserted fixed by R2.
4. **Starting-candidate, survived=true** (`runner-retirement-fence.test.ts:6290-6497`):
   - the test observes the park (reconciler state `Requested` or `Escalating`) and advances the
     TestClock while the send is parked;
   - it passes 200 consecutive runs;
   - a failure writes the feeder's parks and the reconciler's states as a JSON artifact under
     `CONDUIT_RUNNER_EVIDENCE_DIR`.
5. **Stop commit.** 55 to 58 through the upgrade, failure-cleanup and Stop interfaces, with
   an injected store fault, asserting one commit, one shutdown request and no caller retry. 70
   asserts that the commit writes nothing and the runner keeps serving.
6. **Restored assertions.** The forced-stop tests that round 3 weakened assert exact outcomes
   again.
7. **Guards.**
   - Only the outbox adapter imports `settleRunnerCommandReply`.
   - No module on the send path (feeder, Starter, Send Settlement, legacy recovery) imports
     `runnerRetrySchedule` or `retryRunnerPersistence`, or calls `Effect.retry` or
     `Effect.repeat`.
   - Only `classify` decides retry policy on the runner send path. Producers may set/copy the
     flag, protocol boundaries may validate it, and the native projection reads event data.
   - Only Settle constructs `delivery_unknown` evidence, and only `holdRun` constructs `covered`
     (Stop acceptance's 5.3 settlement of pending rows is a separate existing source, not
     `covered` evidence).
   - No `pending.cancelled`, `cancelledBeforeWrite` or in-memory owner-send cancel remains; an
     unheld send is ended only through `settleSend` or a durable Stop.
   - No `UPDATE provider_command_outbox SET status` remains in Send Settlement.
   - commit-and-signal holds no runner SQL.
   - The legacy classification exists in one module (32.29).
8. **I/O revocation and ignored Stop.** Force a committed release between a hold commit and
   delivery of its Held result, and again between delivery and first write. Assert no bytes for
   n, exactly one write for n+1, and one outcome. Case 81 asserts `Ignored`, no Stop wait,
   continued service and no scope close. These are behavioural tests through manager/lifecycle
   interfaces, not mock counts of internal helper calls.

## Prior art

Competitor manifest (2026-10-28, not refreshed: read at the current clone HEADs, possibly stale):
t3code 9c6429d74b, bb 81825aa985, paseo de4590265, zeron ab189159, diri a74e3233, monocode
26465c62, capy docs snapshot.

| competitor | who ends a send | failed cleanup owner | start failure |
|---|---|---|---|
| t3code | many writers behind `writeIfRunCurrent` CAS | durable outbox effects | 5 attempts, then failed |
| zeron | one `resolve_command` writer | dead-command sweep | 3 attempts plus 1, then failed |
| bb | `decideRetry` typed union, transactional | entity status reconciled at hello | fails to the user |
| paseo | in-memory; stuck pending becomes `outcome_unknown` | none | fails to the user |
| diri | durable receipts; never retries after bytes are written | log deleted only after the record removal persists | fails to the user |
| monocode | one host `settled()` builder | in memory | fails to the user |
| capy | docs only | not documented | fails to the user |

- **Convergence:** bounded start, then a visible failure (all); cleanup re-derived from durable
  state (bb, zeron, t3code, diri); an unknown outcome is never retried (diri, paseo, zeron).
- **Taken:** t3code's arm-then-re-read for the live waiter; zeron's one explicit settlement owner; bb's typed
  retry decision; main's `=== true` polarity.
- **Different on purpose:** none of them has a typed retryable-or-permanent decision at the send
  seam, and none guards re-dispatch in the database. Here the hold and the gate are one
  transaction, and the settlement interface is the one the ledger switch flips. A start failure
  that says it is transient is re-sent without a bound, as on main, rather than capped as in
  t3code and zeron.

## Decisions

Chosen: **T + U + V**, with AH, AB and AD-main. The run record answers every send question, one
module ends a send, and the reconciler owns every failed Stop commit. 32.29 carries the build as
the split by state owner.

Options came from the three passes:
- brainstorm: R, S, W, X, Z, AA, AB;
- four Design-It-Twice designs (minimal, flexible, common caller, ports and adapters): T, U, V,
  V2, AD, AE, AF, AG, AH, AI;
- the architecture pass: Y, AJ, AC.

The letters continue SEND-CONTINUATION's A to Q.

| option | verdict |
|---|---|
| R: patch the six findings in place | rejected: keeps seven copies of liveness and seven retry sites |
| S: narrow R2 to main's send path | rejected: the hold and the feeder are permanent (12.1), so they would be rebuilt |
| T: total `holdRun`; feeder with no retry loop | **chosen** |
| U: one Send Settlement module, two adapters | **chosen** |
| V: the reconciler retries a failed Stop commit | **chosen** |
| V2: sweep unclaimed candidate rows | rejected: fixes one Stop caller; V fixes all |
| W: pull Run Effects forward | rejected: inverts 32.17 then 32.x (decision H) |
| X: outbox re-sends | deferred to 32.2.6 (decision I/L) |
| Y: Opus's five-module split | partly taken as AJ; its wrapper over `holdRun` is not |
| Z: at most once, the user retries | rejected: breaks "always reaches an agent"; its polarity is taken |
| AA: in-memory send epoch | rejected: another copy of liveness |
| AB: arm the signal, then re-read | **chosen** for `awaitRun` |
| AC: salvage the spool in R2 | rejected for R2: 3.8 and 7.2 decide drop, main drops, and its integration point is deleted at 32.6; follow-up bead |
| AD-main: a start failure is classified as on main (unset is permanent; `StartLost` is permanent) | **chosen** |
| AD-budget: in-memory start budget | rejected: resets at restart |
| AD-durable: `run.unserved` counted to 5 | rejected: a second transmission counter beside `run.dispatched` |
| AE: pure feeder decider with its own state | rejected: copies SQL facts into memory |
| AF: a `Pacer` service | rejected: Effect's `Clock` is already the port |
| AG: `SpoolConsumed`/`Settled` token on Prune | rejected: nothing consumes the spool without AC |
| AH: `ServingRow` from the transaction | **chosen** |
| AI: `RunnerHeldProvider` port | rejected: layers over the driver seam |
| AJ: 32.29 carries the build | **chosen** |
