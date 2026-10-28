# Run Ledger contract (conduit-test-82tn.32)

Consolidated 2026-10-28. This file is the single authority for the Run Ledger and the runner
work around it: sends, Stop, runner authority, retirement, restart and background work. It
states the contract as it stands today. The amendments and rulings in this folder are history;
where this file and any of them differ, this file wins.

How to read it:

- Each section ends with a hidden comment naming the source documents and sections it came from.
- **OPEN-n** marks a question the sources left open; all seven were decided on 2026-10-28
  (section 13, A.9).
- **Today** means what ticket 32.17 (runner R2) builds. **Ledger chain** means the unbuilt tickets
  32.2.2 to 32.2.9, 32.2.11 to 32.2.13, 32.3 to 32.14 and 32.21 to 32.28. 32.19 (runner R4) shares
  32.5's protocol bump. Section 12 says which design each ledger ticket builds to.
- **Switch** names the ticket where an owner changes. Every owner change in section 2 names its
  switch ticket, so each piece of state has one owner at every point in the build order.
- Failure modes are numbered F1 to F99 (section 10). Appendix B maps every old id (failure modes,
  invariants, S-, A-, T-, R- and C-numbers) to its place here.

Source names used in the comments:

| Name | File |
|---|---|
| C0 | the 2026-10-23 `CONTRACT.md` this file replaces (git history, commit d242ad7b) |
| SPEC | `spec-82tn32.md` |
| MODEL | `run-ledger-model.ts.txt` (cited as `run-ledger-model.ts`) |
| HLK | `AMENDMENT-2026-10-23.md` (design HL-K, steps 1 to 5) |
| RULINGS | `RULINGS-2026-10-23.md` (R1 to R3) |
| D1 | `RULINGS-2026-10-23-D1.md` |
| OW | `AMENDMENT-2026-10-23-OUTSTANDING-WORK.md` |
| FB | `AMENDMENT-2026-10-24-FACT-BOOK.md` |
| BG | `AMENDMENT-2026-10-24-BACKGROUND-WORK.md` |
| RA | `AMENDMENT-2026-10-25-RUNNER-AUTHORITY.md` |
| AUDIT | `AMENDMENT-2026-10-25-AUDIT.md` (A1 to A12) |
| AUDIT-2 | `AMENDMENT-2026-10-25-AUDIT-2.md` (A13 to A20, T1 to T12) |
| SEND-SCOPE to SEND-SCOPE-6 | `AMENDMENT-2026-10-2x-SEND-SCOPE*.md` (S1 to S10) |
| REAPER | `AMENDMENT-2026-10-27-RUNNER-REAPER.md` |
| STOP-INTENT | `AMENDMENT-2026-10-27-STOP-INTENT.md` |
| SWAP | `AMENDMENT-2026-10-28-RUNNER-SWAP.md` |
| CONT | `AMENDMENT-2026-10-28-SEND-CONTINUATION.md` |
| SETTLE | `AMENDMENT-2026-10-28-SEND-SETTLEMENT.md` |

<!-- src: README (precedence, renamed files); task brief 2026-10-28 -->

## 1. Glossary

- **Run.** One provider execution owned by conduit, with a stable id separate from the provider's
  native execution id. A session has at most one active Run, which can take several Run Inputs.
  Stored Run decisions are Queued, Launched, Interrupting and Ended; the labels Starting, Running
  and Settling are derived (section 3.6). Ended records an outcome and a typed reason.
- **Run Input.** One user message associated with a Run, with its native message id once known.
  States: Queued, Dispatching, Delivered (sent or unknown), Accepted, Declined.
- **Run Effect.** A durable instruction from a ledger decision to an executor (start, steer,
  interrupt, close, kill and respawn, end session, deliver answer, cancel request, probe, stop task,
  send native command). Its outcome returns to the ledger as succeeded, retryable, permanent or
  delivery unknown.
- **Send Token.** Identifies one transmission of a Run Effect. A retry is a new transmission with a
  new token; tokens are never reused. It is an opaque host string, never parsed. Deadlines are not
  sends and carry no token. For a runner-held start or steer it identifies `(commandId, n)`, with
  `n` minted by `holdRun`'s `run.dispatched` (4.11). For an effect with no hold, `ctx.newId` mints it.
- **Steer.** A Run Input admitted while a Run is active, to redirect that Run.
- **Tombstone.** The durable fact that a Run is Ended. Nothing later reopens it or changes it.
- **Run Ledger.** The sole owner of Run state for every provider. Verbs: admit, observe, control,
  settle. Internally a Fact Book: it stores only evidence and its own decisions, and every summary
  is a view.
- **Execution.** One launch of a Run (one start attempt). The outcome fold resets only on a new
  execution.
- **Native session.** The provider's own conversation. **Native-session fence:** holds the next
  start until the native session can accept it.
- **May still act.** The provider may still act on a send's work (section 3.5). **Authority:**
  lifecycle evidence for an execution may change Run state.
- **Label.** The evidence label `runnerId:querySeq` stamped by the runner host on every frame
  (`runnerId` alone for an older host). It replaces "process generation".
- **Runner.** A runner host process (Claude, Cursor, Codex). **runnerId:** minted by the daemon per spawn.
  **querySeq:** the host's count of query replacements. **attachmentId:** the daemon's reconnect
  ownership; rotates on reconnect.
- **Grant.** An opaque capability from `RunnerAuthority` saying what a runner may write.
- **Serving runner.** The runner the database names as serving a session. **Candidate:** a runner
  registered for a session but not serving (a swap's replacement while it warms). **Reserved:** a
  serving runner's reversible reservation on itself during a swap's prepare.
- **Retirement row.** The runner's `claude_runner_cursors` row once `retired_at` is set. It is the
  fence that outlives memory.
- **Request stop.** The one call that stops a runner: one transaction that commits the retirement
  row. **Reconciler:** the one loop that carries out committed stops.
- **Reaper.** A small `/bin/sh` child of a runner, in the runner's process group, that clears the
  group when the runner leader exits.
- **Send (runner).** One `send_turn` command, identified by its stable `commandId`.
  **Owner send:** the send whose run is its own owner (not a steer joined into another run).
- **Transmission.** One attempt to give a send to one runner, identified by `(commandId, n)`.
- **Hold.** A run's open transmission: `provider_runs.runner_id` plus `held_transmission`.
  **Release:** the event that clears a hold, on evidence the transmission was never received.
- **Coverage.** Whether the user's Stop covers a run: the run is in the Stop's committed cohort
  (until 32.13; then the ledger's run state, 5.4). Distinct from a send's coverage in the ledger
  (L1, L2, 3.3): its address retired, a pending kill or session end.
- **Address.** The runner a ledger send is fixed to at issue, or **pending** until the next process
  (L2, 3.3). **Current process:** the session's one live runner (L1). A **retired** runner (L1) is
  distinct from a send retired by project inactive (3.11), which loses authority only.
- **Feeder.** The one per-session caller of `holdRun` for owner sends.
- **Settle (reconciler).** The reconciler's step that resolves the runs a stopped runner held.
  Distinct from the ledger verb **settle**.
- **Send scope / send handle.** The daemon's per-send cleanup scope, and the handle that owns it
  and the send's runner assignment.
- **Journal.** The runner host's send journal, keyed per send. It refuses repeats and answers what
  happened to a send.
- **`delivery_unknown` / `delivery_indeterminate`.** The ledger's evidence that delivery is
  uncertain, and the outbox marker for the same fact today. Either way the send is never re-sent.
- **Wake Run.** A Run the agent started itself (origin `wake`), as opposed to a user input (origin
  `input`).
- **Background task.** A provider task (shell, subagent, workflow, monitor, MCP task) keyed by the
  provider's native id. Classed **monitoring** or **work**.
- **Native command.** A provider command that is a send but not a Run (goal set, pause, resume,
  clear).
- **Lost work.** The durable record that a destruction may have ended background tasks.
  **Pending confirm:** a destructive step waiting for the user to confirm.
- **`anythingMayAct`.** The ledger's one answer to "may anything in this session still act?".
- **Survivor.** A retired runner whose process is not yet confirmed gone.
- **Main-built runner.** A runner started by a build without the current capabilities (no journal
  answers, no reaper). **Legacy row:** a row written before a change, handled by a fallback that
  32.13 deletes.

<!-- src: C0 Sources (CONTEXT.md glossary); HLK step 1, step 3, step 4; FB §1, §2, §3; RA §1, §2; BG Decision 1, 2; STOP-INTENT S1, S3; REAPER R2; SWAP S6, S7, M; CONT Data shape, C1, C2; SEND-SCOPE S1, SEND-SCOPE-2 S5; SEND-SCOPE-5 S9.1; SEND-SCOPE-6 S10; review 2026-10-28 (H1, H10, M1, M8); model-gaps 2026-10-28 -->

## 2. Ownership

Every piece of state has one owner. Writers not listed may not write it. "Today" rows describe the
built runner path; the ledger chain must not add a second owner for them (section 12).

The Switch column names the ticket where an owner changes; "none" means it never does. A
per-provider switch happens at that provider's ledger ticket: Claude 32.6, Cursor 32.10, OpenCode
32.11, Codex 32.21. Rows of a provider not yet switched keep the old owner, rows of a switched
provider have the new one, and no row has both.

| State | Owner | Writers | Readers and caches | Switch |
|---|---|---|---|---|
| Run decisions and Tombstones | Run Ledger; the run's settlement path before the switch, with Send Settlement for explicit modern owner-send evidence and native terminal projection as the existing separate source | `reconcile`, through `record`, under the write permit; before the switch, `settleSend` for explicit modern owner-send evidence | every view; the outbox follows the run terminal projection until the switch | per provider; Send Settlement serves until Claude 32.6, Cursor 32.10 or Codex 32.21; the missing native attempt guard remains a Q26 ledger-chain item (32.2.6/32.6) |
| Run Input records, inbox order, pause | Run Ledger | admit, control | the session inbox is a read view | per provider |
| Steer association with a Run | Run Inputs for a switched provider; `joined_into` for one not yet switched | admit (Run Inputs); run joining (`joined_into`) | `holdRun`'s owner resolution (4.3) | per provider, at the later of 32.7 and its ledger ticket; `joined_into` deleted at 32.13 |
| Send issue decisions and their evidence (sends with no hold) | Run Ledger | `record` | views; a runner-held send stores none: its chains are a view over its hold facts (4.11) | per provider |
| Send Token | opaque host string, never parsed; runner-held start and steer: bound to `(commandId, n)` with `n` from `run.dispatched`; every effect with no hold: Run Ledger | `holdRun` binds the transmission (runner-held); `decide` via `ctx.newId` (no hold) | runner journal (dedup) | none |
| A Run Effect's outcome and status | the run's settlement path and the outbox before the switch; the Run Effects table, written by the ledger's interpreter, after it | one decision per piece of evidence | reactor writes terminal outbox status only from its run's terminal settlement (providers not yet switched) | 32.3 adds the Run Effects table; authoritative per provider at its ledger ticket; the outbox is deleted at 32.13 (3.12) |
| Coverage (did Stop cover this run) | Run Ledger: `stopCovers` over the committed Stop control row's `payload.stop.owners` until 32.13; the ledger's `control` `stop` from 32.13 | the engine's Stop acceptance; `control` `stop` from 32.13 | `stopCovers`: `holdRun`, the reactor's stop-owner read | 32.13, in one step for every provider; 32.8's `control` `stop` records the Stop but is not read for coverage before 32.13 (5.4) |
| Hold: `provider_runs.runner_id`, `held_transmission` | projection of `run.dispatched` and `run.released` | `run.dispatched`: `holdRun`, called only by the feeder; `run.released`: `release` (feeder path, reconciler, adoption) | stop, Settle, swap commit, holder queries; the decider reads hold facts as evidence (4.11) | none |
| Transmission count | the event stream (count of `run.dispatched` per `commandId`) | `holdRun` | the cap: the only cap for a runner-held start or steer (4.8) | none |
| Run end by `process_lost` for a retired runner's runs | the reconciler's Settle at `Gone` before the switch; Run Ledger after it | Settle (before); `requestStop`'s retirement transaction (after, 6.5) | prune (6.8) | per runner-held provider: Claude 32.6, Cursor 32.10, Codex 32.21, each deleting `Gone`-time settlement for its provider; 32.4 builds the mechanism (6.5) |
| `delivery_indeterminate`, runner-held rows | the reconciler's Settle | Settle only | reactor; the decider reads it as a hold fact (4.11) | the marker moves from the outbox to the Run Effects table with its provider's switch; Settle stays its writer |
| `delivery_indeterminate`, direct-provider rows | the reactor's existing marker; the ledger's interpreter after the switch | reactor only; the interpreter after the switch | reactor | 32.11 (OpenCode, the only direct provider); the rule is 32.2.6's `decide` (4.10) |
| `runnerId` | daemon | spawn | runner record, logs | none |
| `querySeq` and the current query | runner host | host | the ledger reads the label only | none |
| Who may write for a runner (grant tag) | `RunnerAuthority`, in memory | `adopt`, `revoke` | `guarded`; never copied | none |
| Serving runner of a session | `claude_runner_cursors.role` (partial unique index) | lifecycle module's register, retire and swap transactions (`register`, `requestStop`) | `serving(session)` (routing cache only); write decisions read the row in their transaction | none |
| Runner role inside the host | runner host (`decideRunnerRole`) | host | reply to `upgrade-retire`, idle exit; not persisted | none |
| Runner retired (fence) | retirement row `retired_at` | request stop (one transaction) | attach, `adopt`, `holdRun`, recovery | none |
| Feeder queue and per-send I/O capabilities | the session's feeder | enqueue by reactor dispatch, committed release and restart; the feeder consumes each write capability once | live handle or `Adopted`; the released-through watermark revokes local I/O only, never persisted delivery or runner assignment | none |
| Per-operation pacing ordinal | the pending store operation | its release/settlement owner, or the failed read's caller | 4.8's backoff only; reset on commit or staleness, never run liveness or transmission count | none |
| `awaitRun` subscription | the live caller | arm the store's commit signal, then re-read the run | includes silent lifecycle commits; no waiter map | none |
| Uncommitted Stop intent (`Committing`) | the reconciler | intent registration and its independently owned commit worker | Stop waiters; identity only, never a durable retirement record | none |
| Retained release/settlement evidence | the evidence source's write owner | feeder write fiber for release or start-refusal settlement; reactor call for a live reply; reconciler cadence for Settle; attachment for adoption and retained replies | retained until commit or staleness; adoption release failure propagates through bounded attachment recovery, then retirement and Settle | none |
| Stop progress (`RunnerStop`) | reconciler module (`runner-retirement.ts`) | the reconciler only | `state`, `awaitStop` (memory is a cache of the row) | none |
| Group snapshot and signal log | retirement row | the reconciler's kill routine | restart recovery | none |
| Survivor notice sent | the deterministic notice event id | reconciler | none | none |
| Duplicate sends at the host | host send journal | host | journal answers to the daemon | none |
| Per-send daemon resources | the send's scope, a child of the provider instance's scope | finalizers registered at allocation | none | none |
| A runner entry's memory (waiters, the close of its dispatched sends) | the runner entry's scope | closed by the stop commit's post-commit step (6.11) and daemon shutdown | none | none |
| A send's runner assignment | send module (`Assignment`) | `dispatch`, `requeue` | every action on the send, via its handle | none |
| Opening send handles | provider instance | its one admission | none | none |
| Replay cursor and attachment | runner's cursor row | receipt store | none | none |
| Registration (socket, pid; identity only) | runner host's `.json` | host | discovery only; never evidence | none |
| Tasks, wake Runs, process facts, lost work, pending confirms, native command delivery | Run Ledger | observe, control, settle | `SessionActivity` (read-only view) | with its background-work ticket (12.2) |
| Goal: confirmed status and pending action id | goal tracker | tracker | `SessionActivity` | none |
| Native command confirmation deadline | Run Ledger (ordinary deadline) | `reconcile` | tracker reacts to `unconfirmed` | none |
| Per-session ledger row (`alarmAt`, open work) | Run Ledger | written only when its value changes | scheduler | none |
| Liveness ("may anything still act") | Run Ledger (`anythingMayAct`) | derived | worktree sweep, archive and delete, status poller, runner record deletion | none |
| Host idle | runner host (`HostIdle`) | host | idle exit | none |

Each layer owns one identity: the daemon owns `runnerId`, the host owns `querySeq`, `holdRun`'s
`run.dispatched` owns a runner-held Send Token's `n`, the ledger owns every other Send Token, the
send module owns the assignment, the database owns the serving runner.

<!-- src: RA §1, §2, §3, §8; AUDIT A2, A3, A4, A8; AUDIT-2 A19, A20, T11; SEND-SCOPE S1, S2; SEND-SCOPE-2 S5; SEND-SCOPE-3 S6; SEND-SCOPE-5 S8, S9.1; STOP-INTENT S1, S2, S3, S5; SWAP S5 refined, S7, M; CONT Data shape, C1, C2, C3; BG Decision 1; FB §1, §2; review 2026-10-28 (H1, H3, H4, H10, H11); model-gaps 2026-10-28; SETTLE Data shape, S1, S2, S3, S5, Verified requirements 5 -->

## 3. Run Ledger model and decider

### 3.1 Interface

- The public interface is `run-ledger-model.ts` plus four functions:

  ```ts
  initialSessionLedgerState(sessionId: string, provider: ProviderKind): SessionLedgerState
  decide(state: SessionLedgerState, command: LedgerCommand, ctx: DecideContext): Decision<LedgerEvent>
  evolve(state: SessionLedgerState, event: LedgerEvent): SessionLedgerState
  viewLedger(state: SessionLedgerState): LedgerView
  ```

  `SessionLedgerState` and `LedgerEvent` are opaque to callers and tests.
  `state' = decision.events.reduce(evolve, state)`. This is the only seam callers and tests cross.
- Four verbs: **admit** (a new user input), **observe** (provider evidence and effect outcomes),
  **control** (user actions and answers), **settle** (alarms, process loss, session end, project
  gate).
- `decide` is pure, never throws and never mutates. A rejection leaves state unchanged and carries
  a diagnostic. Stale evidence is Accepted with no events, no effects and no terminals. An Accepted
  decision may carry a diagnostic.
- In production an illegal transition rejects that input, records a diagnostic and leaves the Run
  unchanged; the Run's deadline still guarantees it ends. Tests treat any illegal transition on
  valid input as a failure.
- One active Run per session, enforced by the decider and by a database uniqueness constraint.
- **Transactions (one permit).** Every verb runs inside the write seam's transaction: read, decide,
  record, under the one write permit. Evidence from a provider event commits in the same
  transaction as that event, so the event store and the ledger never disagree after a crash. In-
  memory caches update after COMMIT and before the permit is released. External effects (sends,
  signals, browser pushes) run after the release. A rollback discards the decision.
- All ledger recording goes through one private `record(tx, evidence)` path. The write seam rejects
  nested entry and runs `afterCommit` outside the permit; a verb that opens its own transaction or
  records from `afterCommit` breaks this rule.
- There is no version check, no retry loop and no `LedgerConflict`: with one permit a concurrent
  ledger writer cannot exist.

<!-- src: C0 Interface; SPEC Implementation Decisions (Run Ledger module, Decider, One active run, Illegal transitions); FB §1, §2 (model changes); AUDIT A5; AUDIT-2 A14 -->

### 3.2 Internal shape (Fact Book)

- One deep module with three private parts:
  - `record(state, entry)`: the only writer. An entry is evidence or a conduit decision. Evidence
    merges by join (order-free, duplicate-safe). Decisions are ordered and validated; an illegal
    decision (such as a second terminal for a Run) is a typed rejection, never a throw.
  - `read(state)`: every summary (Run phase, input outcome and location, inbox order, answer
    delivery, fence, deadlines, `alarmAt`, the view).
  - `reconcile(situation, ctx)`: the next decision or none. It reads only `read`'s output, never
    the triggering command, and runs to a fixpoint with a hard bound of 64 steps; past the bound it
    returns Rejected.
- `decide`: map the command to one entry and record it; run `reconcile` to a fixpoint; return the
  entries, effects, Tombstones and `alarmAt`. A duplicate, or evidence that changes no join, is
  Accepted with no events.
- `LedgerEvent` is one entry and `evolve` is `record`. There are no whole-state snapshot events.
- An evidence table keyed by every `Evidence["kind"]` (a mapped type, so a missing kind is a compile
  error) declares each kind's class, which effects may produce it, and its merge.
- Lookup indexes are caches written only by `record`. Drift is caught through the public interface
  by invariant LI4 (section 11).
- Provider policy is the one real seam, split into **intake** (provider event to evidence; called by
  the interpreter, never by `decide`) and **decision rules** (plain data and pure predicates: what
  ends a Run, what fences, what an idle probe proves, when work has ended, the stop sequence). The
  decider asks the policy and never names a provider. The terminal classifier belongs to the policy;
  there is one.
- Every decision runs in three phases: record facts, recompute views, act only on views.

<!-- src: FB §1, §3; C0 §3; OW Decision 3, rider L; SPEC Implementation Decisions (Decider) -->

### 3.3 Stored state

Only evidence and conduit's decisions, each once:

- **Session:** id, provider, an entry counter, stop/end/resume decisions, project inactive/active
  and session-ended evidence. Paused and the project gate are derived.
- **Send (issue decision):** effect, entry number, time, the Run, admission or interaction it serves,
  its execution, its address (L2: a runner, or pending until it resolves once) and the label fixed
  with that address, an optional deadline. Probes also store the sends they cover,
  captured at issue. Evidence: a transport chain and a consumption chain (sends with no hold only;
  a runner-held send stores no chains, they are a view over its hold facts, 4.11), a probe finding,
  accounting receipts (no values; usage has its own projection owner), and the native message id
  (first write wins; a contradiction is rejected).
- **Execution (launch decision):** Run and its start send; its runner and label are that send's
  (L2), never a second copy. A wake execution has no send: its runner and label are its
  `turn_started` label's (8.3). Evidence: started, latest activity, results keyed by the send they
  answer, query ended.
- **Run (decisions only):** Queued, Launched, Interrupting, Ended. Queued stores the timeout budget
  at reservation, because budgets arrive with each call and can change between calls. Launched
  names its execution. Ended carries the outcome from the fold.
- **Admission:** input, priority, cancelled. **Interaction:** request evidence, an answer decision
  (first wins; user or timeout), resolved evidence.
- **Background facts:** process state per runner (L1), the latest task snapshot per runner with
  its label, task events, lost-work records, pending confirms, native command sends (section 8).
- **Labels, not generations.** The ledger never mints or bumps a generation. It records
  `process_started`, `process_lost` and query-ended evidence, each naming the host's label. For a
  runner-held provider (Claude, Codex, Cursor), a query ending covers that label's `interrupt` and
  `close` sends; it never ends `start` or `steer` work, which ends only by its provider's
  work-ended rule (section 9). OpenCode `abort` and `cancel_request` act on the native session, not
  the query, so a query ending never covers them.
- **L1. Process.** One state per `runnerId`: live, with its latest `querySeq`, or retired. A runner
  is live from its first `process_started`; its latest `querySeq` is the highest one on its
  `process_started` and later unsolicited labels, counting only evidence that is not Rejected (3.4). Before that it is not started: not live, with no
  label, though a `run_dispatched` may already name it (L2); if it retires first, retiring records
  no lost work. This and 3.4 are the only places a label is split into
  `runnerId` and `querySeq`; everywhere else it is opaque. The split is at the last `:` when what
  follows is a decimal `querySeq`; otherwise the whole label is the `runnerId` (an older host). A
  `runnerId` may itself contain `:` (OpenCode, 9). A runner retires at the first of: its
  `process_lost`; an issued kill addressed to it; another runner's `process_started` (only for
  totality: the host reports the loss first, H1, 6.9; it counts as the `process_lost` of every
  other runner, started or not). Retired is final: its labels are older (item 4), so its later
  `process_started` changes nothing, and a host never reuses a `runnerId` (6.1, 9). So a later
  `process_started` of a live runner is the same process reattached: it raises the latest
  `querySeq`, settles tasks as its `reattached` flag says (8.3) and retires nothing; one at or
  below the latest `querySeq` is an older label and changes nothing. Evidence under the label of
  a runner not started has no authority (3.4): it is recorded with a diagnostic and changes
  nothing. The current process is the one live runner, if any. Retiring, in the same decision:
  1. covers every send addressed to it, the kill's own included;
  2. ends its executions: launched Runs end `process_lost` unless Ended; wake executions end;
  3. records lost work (L5, 8.4);
  4. makes its labels older (3.4).
- **L2. Address at issue.** Every send is addressed once, when it issues, and never re-addressed:
  1. an escalation (`close` to kill, `end_session` to kill) whose parent has a runner address goes
     to that runner;
  2. a send for a Run or wake Run with an execution, on a runner-host provider (Claude, Codex,
     Cursor, 4.10), goes to that execution's runner
     (3.3 Execution; pending while a start is, below);
  3. every other send goes to the current process, or to **pending** when there is none. An
     escalation of a parent still pending is this case, and is pending too: an uncovered pending
     parent means no `process_started` since it issued, and a covered one has no deadline left
     to escalate. Every OpenCode send is case 3.

  A pending send resolves, once, at the first of: its own `run_dispatched` (a held send), to the
  runner it names, which covers it at once if that runner is retired; or the next `process_started`, to that runner. A case 2 send follows its
  execution's start: it is pending while the start is, and resolves with it, to the same runner.
  The label fixed with an address is the runner's latest label when the address is fixed; a
  `run_dispatched` naming a runner with no `process_started` yet fixes the label of that runner's
  `process_started`. A kill addressed to pending covers every pending send issued up to it,
  itself included. Those sends never resolve; their executions end as at retirement (L1 item 2),
  and the kill records nothing; the host acts on whatever process they reached (H3, 4.4). Every
  other send is covered when its address is retired, or by session end (3.4). Coverage is
  derived, never stored per send.
- **Wire label.** Only `close`, `kill_and_respawn` and `end_session` carry a label (3.13). It
  projects the address: `close` carries its execution's label; `kill_and_respawn` and
  `end_session` carry their runner's latest label; any of the three whose address has no label yet
  (pending, or a runner not started) carries null. Other effects carry no label; their address
  lives only on the Send. A Queued Run's `interrupt` is addressed (to the
  current process or pending) and carries no label.
- **`hasAuthority(execution)`:** the execution is its Run's current one, the Run is not Ended, its
  runner is live (L1), the project is active, and its native session has not ended. This is the
  single read of Ended.
- Native message id (6C): immutable once known. Evidence that contradicts it is rejected with a
  diagnostic and no state change. A missing id is filled from evidence. Where a provider accepts a
  client-chosen id, the ledger pre-assigns it.
- No in-session pruning. Run Input records, interaction records and send history are kept for the
  session's life and reclaimed when the session is archived.

<!-- src: FB §2; RA §7; HLK step 4, step 5; BG Decision 1, Decision 3; AUDIT-2 T6; review 2026-10-28 (H2); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L1, L2; REDESIGN review r1-1 (03-rewrite-gap-decisions.md); REDESIGN review r1-2; REDESIGN review r2-1; REDESIGN review r2-2 (label split); REDESIGN review r3-1 (runner not started, authority at record); REDESIGN oracle r8; REDESIGN harness r9 (L2 case 2) -->

### 3.4 Correlation and evidence

- Every transmission of a Run Effect is an `IssuedEffect` with a fresh Send Token. A retry is a new
  transmission with a new token. For a runner-held start or steer, `decide` issues the effect under
  its `commandId`, and `holdRun`'s `run.dispatched` mints `n`. The token is an opaque host string,
  never parsed; `run_dispatched{runnerId, commandId, transmission}` binds it by `commandId` and
  transmission, including redispatch of an already-bound issue. Each transmission has its own
  token and chains; the issue folds over its transmissions. `holdRun` alone applies the cap
  (4.3, 4.11). Every effect with no hold gets its token from `ctx.newId()`, and `decide` applies its cap.
- An observation either **answers** a send (it names that send's token) or is **unsolicited**
  (it names only the host label and an event id). Unsolicited observations are background
  snapshots and task events, a turn start with no active Run (a wake Run), process events, and
  `activity`, `result`, `query_ended` for a wake Run (8.3). No fictitious send is minted. An
  unsolicited observation's identity is its (label, event id) pair; a repeat of the same pair
  is Accepted with no events. Event ids are unique only within a label.
- Which token an answer names: `started`, `activity`, `query_ended`, `interaction_requested` name
  the latest start or steer transmission delivered on that native query. Where a native result
  names an input (Claude), `result` names that input's send; otherwise it names the query's latest
  start or steer. `interaction_resolved` names the `deliver_answer` it confirms, or the query's
  latest start or steer when the provider resolved it natively; `input_accepted`, `input_declined`, `accounting`
  name the start or steer that carried that input; `effect_outcome` names the effect's own token;
  `probe_result` names the probe's token; its target is read from the issued probe record named by
  that token. The execution is found through the send.
- Lifecycle evidence is always recorded as a fact. It changes Run state only when, in the decision
  that records it, the send it answers (if any) is neither retired nor covered (3.11) and
  `hasAuthority` holds for its execution; a fact recorded without authority never changes Run state
  later.
- Receipt evidence (input acceptance and decline, accounting, answer confirmation, input and answer
  probe findings) updates only the record `receiptAddress(token)` names, and never changes or
  revives Run lifecycle.
- An unknown or never-issued token: Accepted, no events, a diagnostic. Evidence of a kind the send
  or its provider cannot produce (task evidence from Cursor or OpenCode, 8.1; `command_lifecycle`
  from any provider but Claude, 9, D46), a contradicting native id, or a command receipt naming another commandId (D21):
  Rejected, a diagnostic, no state change. No throws
  and no new error types.
- Hold facts (`run_dispatched`, `run_released`, `delivery_indeterminate`, `runner_reply`,
  `journal_answer`) on a send with no hold are Rejected as evidence the send cannot produce.
- **Older labels (L1.4).** A label is older when its runner is retired (L1, 3.3) or its `querySeq`
  is below the latest seen for that runner. Older-label evidence is recorded only where it changes
  a join (3.8), and never gives authority, liveness or a wake Run. A send's own label is never
  older for that send.
- Freshness compares issue order of sends. There are no version counters. A native-session idle
  probe covers only sends issued before it, and only where the native policy can prove the covered
  work can no longer execute. Idle never leaves a cleanup deadline behind.
- Project inactive retires every send of the session, probes included. Session end covers
  every send of the ended native session, probes included. Retired or covered tokens never
  revive.
- Native `run_id` order is unproven. Code must not assume it sorts by time; use arrival order, or
  cite evidence that it sorts.

<!-- src: C0 §1; MODEL Observation doc comment; AUDIT-2 T7, Other changes (run_id); AUDIT A11; OW Decision 3; FB §4; HLK step 1, Rules not tied to one step (9B); review 2026-10-28 (H1); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L1.4; REDESIGN review r3-2 (retired send in the authority test) -->

### 3.5 Send chains and the views over them

Each transmission has two chains; each merges by join (maximum):

- **Transport:** Issued < Retrying{earliest at} < Failed{lowest code} < Unknown < Sent. A success
  always beats a failure.
- **Consumption:** None < NotConsumed{declined | absent} < Observed < Accepted. Acceptance is proof,
  so it beats an earlier "absent".

Transport and consumption stay separate unions; they are never merged into one machine.

`effect_outcome` maps onto transport: succeeded to Sent, `delivery_unknown` to Unknown, retryable
to Retrying{at}, permanent to Failed{code}.

**Work ended** is derived: the execution's evidence under the policy's work-ended rule, a covering
idle probe the policy trusts, or its send's coverage (L1, L2, 3.3).

`mayStillAct`:

| Consumption | Issued, Unknown, Sent | Retrying, Failed |
| --- | --- | --- |
| work ended | no | no |
| Accepted, Observed | yes | yes |
| NotConsumed | no | no |
| None | yes | no |

- `fenceHolds(nativeSession)`: some send the native policy counts as a fence member may still act
  (section 9, native-session fence). Membership is per send; an admission's outcome never releases it.
- `inputOutcome(admission)`: a fold over that admission's sends. Accepted if any send was accepted;
  refused only when every send ended with no acceptance.
- `receiptAddress(token)`: the record a receipt may update.
- Precedence, inside the views only: native completion or a covering release beats acceptance;
  acceptance beats a transport failure; `delivery_unknown` with no later proof keeps work
  outstanding until a probe settles it. Neither Unknown nor Sent implies Accepted.
- A retryable outcome with no acceptance ends that send's work. A sibling's unsettled
  `delivery_unknown` blocks automatic resend until a probe settles it.
- A refused sibling never releases the fence or retires an interrupt while other work of the same
  admission may still act.

For a runner-held send these chains are never stored: they are a view over the hold events
(section 4.11).

<!-- src: FB §3, §4; OW Decision 2, 3, 4; AUDIT-2 T8, Over-engineering not done; HLK step 3; model-gaps 2026-10-28 -->

### 3.6 Run machine

- Moved only by `reconcile`: reserve to Queued (only with no active Run); launch to Launched (a new
  execution; the only fold reset); interrupt to Interrupting (the policy's stop sequence); tombstone
  to Ended (absorbing; outcome from the fold at that moment).
- Derived labels: Launched with no evidence shows as Starting; with activity, Running. Settling means
  an OpenCode-style policy has a result with no later activity.
- `reconcile` rule order: expired deadlines; end conditions (with authority); interrupts; answers,
  retries and probes; steers; advance (start the next Run if the fence is clear). A probe is sent
  only when a deadline calls for one, never at the outcome itself or on every decision.
- Run end is declared by the native policy: the result naming the send's input uuid for Claude,
  the result for Codex and Cursor; the owned execution's end (`query_ended`) for OpenCode.
- The native-session fence is separate. It holds the next start until the native session can accept
  it (Claude runs one SDK query per session). It never decides a Run's outcome, and Run end never
  releases it unless the policy says the two coincide. A result is outcome evidence and, for
  adapters that declare it so, Run end.
- The view's `active` is a union by Run tag, so `by` exists only on Interrupting and the deadline
  kind is tied to the tag.

<!-- src: FB §3; HLK step 2; SPEC Implementation Decisions (Native-session fence); AUDIT-2 T10; model-gaps 2026-10-28 -->

### 3.7 Deadlines and the alarm

- Deadlines are data on the obligation they bound. They are not sends and carry no token.
- Each deadline is tagged by its owner (Run, send, interaction, native command, Tombstone) with a
  required target.
- Derived deadlines: each Run phase (Starting, Running, Interrupting, Settling) from its
  stored time and budget, with Settling fixed at the result; a Queued Run shows the deadline of
  the obligation that blocks it (the earliest outstanding send cleanup or Tombstone cleanup) and has no clock of its own; each send's cleanup or retry while it
  may still act; permission timeouts; native command confirmation (which does not run while the
  provider reports the command queued).
- Every non-Ended Run is bounded by a deadline, including its answer obligation's deadline while
  delivery is pending after settle expiry (3.10), so "stuck busy" cannot be represented.
- Every probe is an obligation and owns a retry deadline from the moment it is issued. Probe
  transmission `n` owns a retry deadline at its issue plus `max(probeMs, backoff(n))`. A probe
  with no answer by then is re-probed in the decision that fires that deadline, as a fresh
  transmission of the same obligation with a fresh token, under its own cap of 5, never the
  probed send's cap (4.8). Past the cap, the fence path ends `fence_unconfirmed`; an input
  stays Delivered{unknown} and is never re-sent automatically.
- `retryAt` is a lower bound. A retry is anchored where its retry obligation opens. For a send
  whose retryable outcome opens it, the next transmission is at
  `max(retryAt, outcomeTime + backoff(n))`. A probe's obligation opens at its issue (above): its
  deadline stays at issue plus `max(probeMs, backoff(n))`, raised to `retryAt` when a retryable
  outcome names a later one (D20). `n` is the transmissions so far; backoff is 1 s, 2 s, 4 s, 8 s,
  capped at 30 s.
- Delivery recovery probes the input or interaction. Idle proof after interrupt, fence or settle
  expiry probes `native_session`.
- An Accepted decision carries `alarmAt`: the earliest open deadline after its events, or absent
  when none is open. A Rejected decision leaves the alarm alone.
- The scheduler keeps one timer per session row and reports `alarm_fired` (a settlement with no
  token). The decider fires every deadline with `at <= now`, in deadline order; equal-time
  deadlines fire in the issue order of the decisions that opened them. A late or spurious fire
  finds nothing due and is Accepted with no events.
- A deadline is due only when an alarm recorded after it opened reaches its time (the latest alarm
  time seen), so a clock going backwards cannot fire early or twice.
- Finishing an obligation removes its deadline. Nothing else cancels, extends or re-arms a deadline
  unless this contract names that evidence as extending it (activity extends liveness).
- The fence deadline sits on the outstanding send's cleanup obligation, or on the Tombstone
  cleanup of a member held by a result (section 9). Expiry probes where the policy allows,
  otherwise escalates by the provider's fence-expiry column; only when that column is exhausted
  does the Queued Run end with `fence_unconfirmed`.
- **One alarm per session row.** A decision writes the session's `alarmAt` and whether it has open
  work to a per-session ledger row, in the same transaction, only when the value changes. The row
  is `Quiescent | Open { alarmAt?: number }` with an index on the earliest alarm. The scheduler
  reads the earliest `alarmAt` across sessions. Deadlines with no Run (native commands, Tombstone
  obligations) are covered.
- No in-memory retry or deadline fibers remain.
- Default budgets come from `DecideContext.policy`; the interrupt budget is 30 s. `probeMs` is
  the minimum retry deadline of a probe transmission from its issue; `nativeCommandMs` bounds
  native command confirmation, paused while the provider reports the command queued (8.5).

<!-- src: HLK step 1; RULINGS R1; FB §3, §4; OW Decision 4; AUDIT A4, A8; AUDIT-2 A19, T9, T12; SPEC Implementation Decisions (Deadlines as data); MODEL; model-gaps 2026-10-28 -->

### 3.8 Outcome, Tombstones and late evidence

- **Outcome fold (5C)**, within one execution: failure beats success; specific beats generic;
  completion beats an interrupt fallback. The fold is order-independent. Only a new execution
  resets it.
- **First specific code (10A):** keep the specific code with the lowest send number, then the
  lowest code. "First" means first in issue order, not arrival order.
- **OpenCode after a result (11A):** activity after a result (from a steer) shows as Running again
  and keeps the fold. An earlier error stays the outcome even if a later steer completes.
- **After a Run ends (12A):** evidence is recorded only when it changes a join (accounting, an
  acceptance that holds the fence): no effects, no change to the Run. Duplicates produce no events.
  A frozen execution's fold does not change.
- Late evidence for an Ended Run never changes its Tombstone. A late acceptance still restores
  outstanding work, so the native-session fence stays until that work is settled. Its cleanup
  deadline is the Tombstone time plus the settle budget; expiry runs the stop sequence for runner-held policies or probes (OpenCode).
- Late accounting receipts are recorded against the ended Run's inputs; usage, cost and token
  values stay in their own projection, outside the ledger.
- A result after process loss changes nothing; its accounting is recorded.
- **Activity throttling.** `activity` changes a join when it is the execution's first activity,
  when the stored latest activity is older than a quarter of the liveness window, or when it changes
  the execution's phase or its order relative to a result. Only repeats within one phase are
  throttled.
- End reasons: completed; provider error (code, retryable); interrupted (by stop, run now or end;
  forced when it ended on the deadline rather than native truth); process lost; deadline expired;
  session ended (usage-limit failover or native session vanished); refused (code); project
  inactive; fence unconfirmed. Every failed Run shows a specific reason.

<!-- src: HLK step 4; FB §3 (10A, 11A, 12A), §4; AUDIT A6, A10; AUDIT-2 A16; SPEC Implementation Decisions (Tombstones), user story 19; MODEL EndReason; model-gaps 2026-10-28 -->

### 3.9 Inputs, steers and the inbox

- Input delivery: Queued, then Dispatching (a start or steer issued with no transport evidence yet),
  then Delivered/sent, or Delivered/unknown when the transmission's outcome is unknown.
  Delivered/unknown blocks automatic resend until a probe settles it. Neither implies Accepted.
- A message sent during an active Run becomes a Run Input on that Run with a steer effect. The
  common admission interface takes the active Run's origin: admission steers into an active user
  Run and queues behind a wake Run.
- A steer the provider declines returns to the inbox.
- When Stop, Run now or a forced close ends a Run: a steer the provider Accepted stays with the
  ended Run. A steer that provably never reached the agent returns to the inbox as the next
  message, with no error shown. A steer that was Delivered but not Accepted returns to the front of
  the inbox marked possibly seen, is never re-sent automatically, and with ordinary Stop waits
  behind the pause. A steer whose Run is still active, and whose transmission provably never
  reached the agent, is re-sent as a steer.
- Ordinary Stop pauses the inbox. Resume clears only an ordinary pause. Run now stops the current
  Run and starts its input at once, bypassing the pause.
- The session inbox is a read view of the ledger: the ledger owns inbox order and pause. The inbox
  always drains once the active Run ends.

<!-- src: HLK step 3; RULINGS R3; SPEC Implementation Decisions (One active run, Steers when a run ends early), user stories 3, 6, 7, 20; SEND-SCOPE-5 S9.3; AUDIT-2 Other changes (wake admission); RA §8 -->

### 3.10 Interactions and answers

- A permission or question is answered once: the first answer decision wins (user or timeout).
- A permission that times out is answered with exactly `{ decision: "reject", reason: "timeout" }`,
  also across a restart.
- An answer is delivered exactly once, also across daemon and runner restarts; transient failures
  retry with backoff; a Run stays open while its answer waits for delivery.
- Answer refusal (10B): the interaction stays Pending with `lastRefusal` naming the exact answer
  attempt and refusal code. The submitted answer is kept. If consumption of an earlier transmission
  is ambiguous, it is reconciled by probe before a retransmit with a fresh token.
- Answer delivery state (queued, sent, unknown, settled) is derived, not stored.
- A settle deadline that expires while an answer awaits delivery is consumed once, never re-armed.
  The answer obligation owns the next alarm; when it finishes, the Run ends from the outcome fold.
- An interaction's resolution, by any transmission or natively, ends the work of every
  `deliver_answer` transmission for that interaction.

<!-- src: FB §2, §4; RULINGS R2; HLK Rules not tied to one step (10B); SPEC user stories 8 to 12; MODEL InteractionView; model-gaps 2026-10-28 -->

### 3.11 Session and project gates

- **Project inactive** retires every send of the session. **`project_active`** clears the gate;
  reconciliation probes run before any dispatch. Resume never clears this gate. Retired tokens
  never revive.
- Retirement removes authority, never liveness. A retired send that may still act keeps
  `anythingMayAct` true until reconciled.
- Project inactive leaves a sent native command's view, liveness and deadline unchanged: its
  retired send stays in `live`, and its deadline keeps running, until `command_result`,
  NotConsumed or its coverage (L1, L2, 3.3). Inactive never
  fails a native command: its view becomes `Failed` only by coverage (process loss, a kill,
  session end) or a permanent `effect_outcome` (D17, D34).
- A retired probe is finished: it leaves `live` and owns no deadline. `project_active`
  reconciliation issues fresh probes.
- A removed project's pending effects are cancelled with a project-inactive reason; other projects
  keep their ordering. A project that returns reconciles its OpenCode work from what OpenCode
  reports.
- **Session ended** removes authority over that native session's work. It does not block fresh
  authorized admission, which opens a new native session with start mode `fresh` (4.8).
- `session_ended` records lost work by L5 (8.4).
- Session-scoped provider failures (usage-limit failover, vanished native session) settle every open
  Run on the session with its reason.

<!-- src: HLK Rules not tied to one step (9B), step 3; FB §4; SPEC Implementation Decisions (Session-scoped provider failures, Removed project, OpenCode adapter), user stories 22 to 24; model-gaps 2026-10-28; REDESIGN review r1-2 -->

### 3.12 Persistence

- The provider runs table evolves into the runs table. A Run Inputs table holds one row per user
  message, with the native message id. Receipts, turns and inbox busy are derived from ledger state
  in the same transaction. There is no version column.
- **Run Effects replace the outbox, one provider at a time.** 32.3 adds a Run Effects table, written
  only by the ledger, partitioned by provider. It becomes authoritative for a provider at that
  provider's ledger ticket (Claude 32.6, Cursor 32.10, OpenCode 32.11, Codex 32.21); until then the
  provider command outbox stays authoritative for that provider. `delivery_indeterminate` moves
  with its provider. A row is in one store or the other, never both. 32.13 deletes the outbox.
- Steer association moves the same way: Run Inputs own it for a provider from the later of 32.7 and
  that provider's ledger ticket; `joined_into` owns it for providers not yet switched and is deleted
  at 32.13 (section 2).
- `provider_runs` carries the hold (`runner_id`, `held_transmission`; section 4.1). The ledger
  chain builds on these fields rather than defining its own.
- Backfill is per provider, in the migration of the ticket that makes the Run Effects table
  authoritative for that provider (32.6, 32.10, 32.11, 32.21). It reads that provider's outbox,
  receipts, turns and provider runs, and flips the provider's authority in the same transaction, so
  each row has one authoritative store at every point. Each backfill is all-or-nothing; a failure
  stops startup with a typed error. 32.3 adds the table and backfills nothing.
- Typed unions persist as one tag column. New tables add a CHECK on it. Existing tables (SQLite
  cannot add CHECK through ALTER) decode with Schema at the store and reject unknown rows, per row.
- **Load.** On load the ledger rebuilds caches only for sessions with open work: a Run not Ended, an
  unsettled send, a pending interaction or native command, a future alarm, or background tasks live
  or unknown. Other sessions load on first touch. The per-session row is the index. Startup cost is
  proportional to the history of open sessions; checkpoints are added only if measurement shows a
  need.
- During projection replay (`ctx.replaying`) nothing settles an outcome.
- Replaying a decision's entries through `evolve` from the initial state gives the same view as the
  live state (LI4), so entries are real facts that 32.3 can persist.

<!-- src: SPEC Implementation Decisions (Schema); AUDIT A5, A7; AUDIT-2 A18, Typed states (persistence), Bottlenecks; FB §1, §5 (I4); STOP-INTENT S5; CONT Data shape; SEND-SCOPE-5 S9.1; review 2026-10-28 (H10) -->

### 3.13 Model sketch

The reconciled public model. It replaces `run-ledger-model.ts` where they differ; the `.txt`
sketches in this folder are history.

```ts
export type ProviderKind = "claude" | "codex" | "cursor" | "opencode";
// Opaque host string, never parsed. Runner-held start or steer: bound by run_dispatched's
// commandId and transmission, n minted by holdRun (4.11). Every effect with no hold: from ctx.newId.
export type SendToken = string & { readonly __brand: "SendToken" };
export type Label = string; // `runnerId:querySeq`, or `runnerId` for an older host; split at the last `:` only by L1 and 3.4

export type InputState =
  | { readonly tag: "Queued" }
  | { readonly tag: "Dispatching" }
  | { readonly tag: "Delivered"; readonly certainty: "sent" | "unknown" } // unknown: probe, never resend
  | { readonly tag: "Accepted"; readonly nativeMessageId?: string; readonly cancelled?: true }
  | { readonly tag: "Declined"; readonly reason: string };

export type LedgerCommand =
  | { readonly verb: "admit"; readonly inputId: string; readonly runNow: boolean }
  | { readonly verb: "observe"; readonly observation: Observation }
  | { readonly verb: "control"; readonly control: Control }
  | { readonly verb: "settle"; readonly settlement: Settlement };

export type Observation =
  | ({ readonly tag: "Answer"; readonly token: SendToken } & Evidence) // EvidenceFor<K> of the send's kind
  | ({ readonly tag: "Unsolicited"; readonly label: Label; readonly eventId: string } & Unsolicited);

export type Unsolicited = Extract<Evidence, { readonly kind:
  | "tasks_snapshot" | "task_event" | "turn_started" | "command_lifecycle" | "command_result"
  | "activity" | "result" | "query_ended" }>;

export type Evidence =
  | { readonly kind: "started" }
  | { readonly kind: "input_accepted"; readonly nativeMessageId?: string }
  | { readonly kind: "input_declined"; readonly reason: string }
  | { readonly kind: "activity" }
  | { readonly kind: "interaction_requested"; readonly interactionId: string;
      readonly interactionKind: "permission" | "question"; readonly timeoutAt?: number }
  | { readonly kind: "interaction_resolved"; readonly interactionId: string }
  | { readonly kind: "result"; readonly outcome: RunOutcome;
      readonly error?: { readonly code: string; readonly retryable: boolean } }
  | { readonly kind: "query_ended" }
  | { readonly kind: "accounting" }
  | { readonly kind: "effect_outcome"; readonly outcome:
      | { readonly tag: "succeeded" }
      | { readonly tag: "retryable"; readonly retryAt: number }
      | { readonly tag: "permanent"; readonly code: string } // includes "native_resume_rejected"
      | { readonly tag: "delivery_unknown" } }
  | { readonly kind: "probe_result"; readonly finding:
      | { readonly tag: "input_present"; readonly nativeMessageId?: string }
      | { readonly tag: "input_absent" } | { readonly tag: "native_idle" }
      | { readonly tag: "native_busy" } | { readonly tag: "answer_consumed" }
      | { readonly tag: "answer_pending" } }
  // background work (section 8)
  | { readonly kind: "tasks_snapshot"; readonly tasks: readonly { readonly key: TaskKey;
      readonly taskType: string; readonly subagentType?: string; readonly description: string;
      readonly ambient: boolean }[] }
  | { readonly kind: "task_event"; readonly key: TaskKey;
      readonly event: "started" | "completed" | "failed" | "killed" | "notification" }
  | { readonly kind: "turn_started"; readonly wakeTask?: TaskKey }
  | { readonly kind: "command_lifecycle"; readonly commandId: string;
      readonly state: "queued" | "started" | "completed" | "cancelled" }
  | { readonly kind: "command_result"; readonly commandId: string }
  // hold facts of a runner-held send (4.11): read from the existing event stream, never copied
  // into a second store. The opaque token identifies this commandId and transmission.
  | { readonly kind: "run_dispatched"; readonly runnerId: string;
      readonly commandId: string; readonly transmission: number }
  | { readonly kind: "run_released";
      readonly reason: "Refused" | "NotSent" | "JournalAbsent" | "ResumeRejected" }
  | { readonly kind: "delivery_indeterminate" } // the effect row's marker; Settle writes it
  | { readonly kind: "runner_reply"; readonly outcome:
      | { readonly tag: "succeeded" } | { readonly tag: "failed"; readonly code: string } }
  | { readonly kind: "journal_answer"; readonly answer: "running" | "finished" | "uncertain" | "absent" };

export type Control =
  | { readonly kind: "stop" } | { readonly kind: "end" } | { readonly kind: "resume" }
  | { readonly kind: "run_now"; readonly inputId: string }
  | { readonly kind: "cancel_input"; readonly inputId: string }
  | { readonly kind: "answer"; readonly interactionId: string; readonly answer: unknown }
  | { readonly kind: "stop_tasks"; readonly tasks: "all" | readonly TaskKey[] }
  | { readonly kind: "confirm_escalation"; readonly snapshotEntry: number }
  | { readonly kind: "native_command"; readonly commandId: string; readonly text: string };

export type Settlement =
  | { readonly kind: "alarm_fired" }
  | { readonly kind: "hold_exhausted"; readonly commandId: string }
  | { readonly kind: "process_started"; readonly label: Label; readonly reattached: boolean }
  | { readonly kind: "process_lost"; readonly runnerId: string } // retires runnerId (L1, 3.3)
  | { readonly kind: "session_ended"; readonly cause: "usage_limit_failover" | "native_session_vanished" }
  | { readonly kind: "project_inactive" }
  | { readonly kind: "project_active" };

export type RunEffect =
  | { readonly kind: "start"; readonly runId: string; readonly inputId: string;
      readonly mode: "resume" | "fresh" }
  | { readonly kind: "steer"; readonly runId: string; readonly inputId: string }
  | { readonly kind: "interrupt"; readonly runId: string }
  // label: a projection of the send's address (L2, 3.3); shapes unchanged. close: its execution
  // label; kill_and_respawn, end_session: the runner's latest label; null while the address has no label
  | { readonly kind: "close"; readonly runId: string; readonly label: Label | null }
  | { readonly kind: "kill_and_respawn"; readonly runId: string | null; readonly label: Label | null } // runId null: idle End escalation (D4)
  | { readonly kind: "end_session"; readonly runId: string | null; readonly label: Label | null }
  | { readonly kind: "deliver_answer"; readonly runId: string; readonly interactionId: string; readonly answer: unknown }
  | { readonly kind: "cancel_request"; readonly runId: string } // OpenCode Stop fallback; fence stays held
  | { readonly kind: "probe"; readonly runId: string; readonly target:
      | { readonly tag: "input"; readonly inputId: string }
      | { readonly tag: "interaction"; readonly interactionId: string }
      | { readonly tag: "native_session" } }
  | { readonly kind: "stop_task"; readonly key: TaskKey }
  | { readonly kind: "send_native_command"; readonly commandId: string; readonly text: string };

export interface DecideContext {
  readonly now: number;
  readonly newId: () => string; // mints Run ids and the tokens of effects with no hold; never repeats
  readonly policy: { readonly startMs: number; readonly livenessMs: number;
    readonly interruptMs: number; /* 30 s */ readonly closeMs: number;
    readonly settleMs: number;
    readonly probeMs: number; readonly nativeCommandMs: number };
}

export type IssuedEffect =
  // A runner-held start or steer: issued under its commandId; holdRun binds n, so no token yet.
  | { readonly tag: "Held"; readonly commandId: string; readonly effect: RunEffect }
  // Every effect with no hold: its token comes from ctx.newId().
  | { readonly tag: "Tokened"; readonly token: SendToken; readonly effect: RunEffect };
export interface RunEnded { readonly runId: string; readonly outcome: RunOutcome; readonly reason: EndReason }
export type RunOutcome = "completed" | "error" | "interrupted";

export type Decision<Event> =
  | { readonly tag: "Accepted"; readonly events: readonly Event[]; readonly effects: readonly IssuedEffect[];
      readonly ended: readonly RunEnded[]; readonly alarmAt?: number; readonly diagnostic?: string }
  | { readonly tag: "Rejected"; readonly diagnostic: string };

// Send chains (section 3.5): separate unions
type Transport = { tag: "Retrying"; at: number } | { tag: "Failed"; code: SendErrorCode }
               | { tag: "Issued" | "Unknown" | "Sent" };
type Consumption = { tag: "None" } | { tag: "NotConsumed"; why: "declined" | "absent" }
                 | { tag: "Observed" } | { tag: "Accepted" };

// Deadlines: tagged by owner, with a required target; alarmAt is the earliest
type DeadlineOwner = "Run" | "Send" | "Interaction" | "NativeCommand" | "Tombstone";

export type InteractionView =
  | { readonly tag: "Pending"; readonly interactionId: string; readonly kind: "permission" | "question";
      readonly lastRefusal?: { readonly attempt: SendToken; readonly code: string } }
  | { readonly tag: "Answered"; readonly interactionId: string; readonly kind: "permission" | "question";
      readonly delivery: "queued" | "sent" | "unknown" | "settled" };

export interface InputView { readonly inputId: string; readonly state: InputState } // `uncertain` deleted

export interface LedgerView {
  readonly paused: boolean;
  readonly active?: ActiveRunView;          // a union by Run tag; `by` only on Interrupting
  readonly inbox: readonly InputView[];
  readonly live: readonly IssuedEffect[];   // work that may still act, in issue order
  readonly tasks: TasksView;                // none | unknown | live (kind, class per task)
  readonly anythingMayAct: boolean;
  readonly pendingConfirm?: PendingConfirm; // step, snapshot entry, tasks it would destroy; its labels are a view (L3)
  readonly lostWork: readonly LostWork[];   // tasks, or "may have been lost"
  readonly nativeCommands: readonly NativeCommandView[];
}
// ActiveRunView carries runId, tag, deadline, origin ("input" | "wake", waking task if known),
// inputs in admission order, and interactions.

type NativeCommand = Sent | Queued | Started | Unconfirmed | Completed | Cancelled | Failed; // only waiting variants carry a deadline
type TaskKey = { taskId: string; runId?: string };
type Tasks = { tag: "Unknown"; label: Label } | { tag: "Known"; label: Label; tasks: ReadonlyMap<TaskKey, Task> }; // per runner
```

`lastRefusal`'s field names are illustrative; the rule is that it names the exact answer attempt and
refusal code.

<!-- src: MODEL; HLK step 1, step 3, Rules (10B); RULINGS R3; FB §2 (model changes: live, project_active, Dispatching, lastRefusal, diagnostic, quarantine removed); D1-1; BG Decision 2; RA §2, §7; AUDIT A1, A3, A11; AUDIT-2 T5, T6, T7, T8, T9, T10; SEND-SCOPE-5 S9.1, S9.4; review 2026-10-28 (H1, H2); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L2, L3 -->


## 4. Sends, admission and the hold

This section is the runner send path as 32.17 builds it, and the rules the ledger chain inherits
from it. Section 4.11 says how the ledger chain relates to it.

### 4.1 Data shape and events

- **Send:** one `send_turn` command, identified by its stable `commandId`. The id survives a
  recommit, a retry onto a fresh run and a restart.
- **Transmission:** one attempt to give a send to one runner, identified by `(commandId, n)`. `n`
  counts the `run.dispatched` events that carry that `commandId`. Events are the source of truth,
  so the count survives a recommit, a fresh run and a projection rebuild. There is no counter
  column.
- **Hold:** the open transmission of a run. It is `provider_runs.runner_id` plus
  `provider_runs.held_transmission`. Both are projected only from `run.dispatched` and cleared only
  by `run.released`. The `run.started` projector does not write `runner_id`. A joined run's holder
  is its owner's, read through `joined_into`. `held_transmission` exists for the release check: one
  runner can hold the same send twice (a ResumeRejected re-send goes to it), so `runner_id` alone
  cannot tell a stale release from a current one.
- A run with no holder was never dispatched.

```ts
// stored events (extended; old events decode with the new fields absent)
"run.dispatched": { runId; runnerId; commandId?: string; transmission?: number }
"run.released":   { runId; runnerId; commandId; transmission;
                    reason: "Refused" | "NotSent" | "JournalAbsent" | "ResumeRejected" }
```

- A `run.dispatched` without `commandId` was written before this design. Such a run never enters
  4.3 or 4.5. It keeps legacy recovery (`runner-legacy-recovery.ts`), because an unheld legacy run
  is not proof of non-delivery.
- **Scope of 4.3 to 4.5: owner sends.** A steer joined into an owner run is carried by the owner's
  holder and keeps the requeue and retained-steer rules (4.8). Coverage of any send is decided for
  the send's own run id, so a join after a Stop never widens that Stop's cohort.
- Every exhaustive switch over stored event types and runner frames handles the new members.

<!-- src: CONT Data shape, Deleted or changed (Added); STOP-INTENT S5 -->

### 4.2 Send scope, send handle and admission

- **One scope per send.** Every admitted send gets one `Scope`, forked from the owning provider
  instance's scope (`Scope.fork(parent, "sequential")`). The daemon owns it; no runner holds it.
  - It holds the sink binding, the account demand, the pending-send entry (with `turn.pending`,
    which is the same fact), and the provider instance's sink and abort fiber. Each is registered
    as a finalizer when it is allocated, in the same step.
  - It closes exactly once on any ending: the turn completes; the user cancels (before or after
    the sink is bound); the send fails (including a runner that fails before hello); the session
    is evicted mid-send; the runner exits, is superseded or is retired; or the provider instance
    shuts down.
  - Close is unconditional (never guarded by a grant), idempotent and bounded (a hanging finalizer
    is cut off after a timeout and logged). Close writes nothing to session history. The user sees
    each send's outcome exactly once, through the guarded output and evidence paths.
- **A runner may only ask to close its own sends.** A `release-sink` frame is a request. The daemon
  honours it only when the frame's `runnerId` is the one the handle says the send was dispatched
  to. Any other frame closes nothing and is logged once. Grant state does not matter.
- **The send handle.** The provider instance creates one handle per send, once, at admission, and
  passes it down. Nothing looks a send up by `sinkId`. A reused `sinkId` gets a fresh handle.

  ```ts
  type Assignment =
    | { readonly _tag: "Queued" }
    | { readonly _tag: "Dispatched"; readonly runnerId: string }
    | { readonly _tag: "Closed" };
  dispatch(send, runnerId): void // Queued -> Dispatched, before the command frame is written
  requeue(send, runnerId): void  // Dispatched{runnerId} -> Queued
  ```

  The send module owns the assignment. Callers read it and never write it. Every path that writes
  a command frame calls `dispatch` first. An abort, a close-wait, the `release-sink` check and
  `closeRunner` all go through the handle. An abort for a closed handle does nothing. The handle
  has one "closed" signal that completes when its finalizers have run.
- **One admission path.** The provider instance is the only admitter and the only opener of
  handles. `SendOrigin = Fresh | Adopted`. The runner's send command requires the handle; there is
  no `send ?? open(...)` fallback. Admission owns every refusal before the runner accepts the send
  (failure, admission timeout, cancel, interruption, shutdown) and closes the handle. Until 32.5,
  a new `sinkId` is a new send: close the current handle (writing nothing to history) and admit
  again with a new handle. From 32.5 the handle is keyed by `commandId`; a new transmission `n` is
  not a new send.
- **The live handle follows a release.** After any release commits, the feeder returns the send's
  live handle (if this daemon has one) to Queued before any retirement cleanup for the releasing
  runner runs, so `closeRunner` cannot close a send that continues. At restart there is no handle;
  the feeder asks the provider instance to admit the durable send with origin `Adopted`. The send
  module carries this out; it does not decide eligibility.
- Send scopes stay children of the provider instance's scope. When a runner retires or is
  superseded, its runner entry scope closes in the stop commit's post-commit step (6.11). That
  scope holds one finalizer that closes only the sends whose assignment is still
  `Dispatched{this runner}`, so a send already returned to Queued survives. A swap's promote is
  the old runner's stop commit's post-commit step and closes it the same way (6.9).

<!-- src: SEND-SCOPE S1, S2, S3; SEND-SCOPE-2 S5; SEND-SCOPE-3 S6; SEND-SCOPE-4 S7 (Recovered removed); CONT C3 (live handle); SWAP S6 (promote); review 2026-10-28 (H3, H7, H8, H11) -->

### 4.3 `holdRun`: the one gate for a transmission

```ts
type Hold =
  | { _tag: "Held"; runner: RunnerId; transmission: number }
  | { _tag: "Cleaning"; runner: RunnerId } // no serving row; retire this unretired candidate first
  | { _tag: "Unserved"; predecessor: Option<{ runner: RunnerId; until: Millis }> } // no serving runner; a stopping runner of the session, if any
  | { _tag: "Busy" }      // already held: the hold's owner ends or releases it
  | { _tag: "Covered" }   // the user's Stop covers this run
  | { _tag: "Exhausted" } // the fifth transmission failed; the run has been settled failed
  | { _tag: "Ended" };    // terminal, no owner send, or not the run's commandId
holdRun(session, run, commandId): Effect<Hold, StoreFault>
```

One write transaction, in this order:

1. **Covered?** If `stopCovers(session, run)` (5.2): when the run has no hold, settle it through the
   ledger in the same transaction as `interrupted` with one `turn.interrupted` ("Stopped before
   delivery") and return `Covered`. When it has a hold, change nothing and return `Covered`; the
   holder's interrupt or Stop settles it, and if the holder refuses (`interrupted` or `exiting`),
   4.5 releases it and this step settles it. Settlement is idempotent by the run's status guard.
   Settlement goes through Send Settlement (4.7) inside this transaction.
2. **Dispatchable?** The run is `pending` or `running`, unheld and not terminal. A terminal run,
   a run with no owner send, or a `commandId` that is not the run's returns `Ended`. A held run
   returns `Busy`.
   Every domain answer is a value. Only store faults fail: retry unavailable, reject malformed
   rows once through the existing decode error. Never retry all failures as unavailable.
3. **Cap.** If the send already has 5 transmissions, report Settlement
   `hold_exhausted{commandId}` to the ledger, which settles the run `failed` with
   `provider_send_attempts_exhausted` and one `turn.error`, and return `Exhausted`. At most 5
   transmissions per send, the first included, across runs and restarts.
   Settlement goes through Send Settlement (4.7) inside this transaction.
4. **Serving?** Read the session's non-retired `serving` row (6.9), its
   candidates and retirement rows. With no serving row, first return `Cleaning` for an unretired
   candidate in row-sequence order. Otherwise return `Unserved{predecessor}`: a retired runner of the
   session not confirmed Gone whose Stop window end, `(stop_started_at ?? retired_at) + 4 s`, is
   still in the future, or none. The rule reads only the row and the clock.
5. **Bind.** Append `run.dispatched{runId, runnerId, commandId, transmission: n + 1}` and return
   `Held`.

- The transaction is the one `commitAndSignal.write`. `holdRun` resolves a joined run to its owner
  before step 1 and counts the owner send's `commandId` (from 32.5 a joined steer is bound under
  its own `commandId`, 4.11). Settlement in steps 1 and 3 appends events
  through that write's projection handle. It never calls ingestion, `settleSessionRuns` or
  `flushPendingWrites`, which open their own write and would fail nested.
- `holdRun` and `release` are the lifecycle module's calls (6.10); their runner SQL lives there,
  inside the `commitAndSignal.write`.
- The hold commits before the first byte of the transmission is written to the runner's socket, on
  every dispatch path, the legacy and fallback paths included.
- No caller picks a runner; dispatch sends to the runner `holdRun` returns. A send therefore runs on
  exactly one runner, whichever of it and a swap commits first.
- The holder write and a Stop commit exclude each other in the database: a hold on a runner whose
  row is retired cannot be written. A send either lands before the Stop (and is settled with the
  runner) or is refused before the runner sees it.

<!-- src: CONT C2, Confirm before building 1; SWAP S5 refined; STOP-INTENT S5; review 2026-10-28 (H9); model-gaps 2026-10-28; SETTLE Data shape 1, S1, S2 -->

### 4.4 The feeder

- Each session's runner manager has one feeder. It is the only caller of `holdRun` for an owner
  send. Nothing else appends `run.dispatched` and nothing else spawns a runner for a send. From
  32.5 it is also the caller for a joined steer's own transmission (4.11).
- It takes a send when the send is claimed, when a release commits, and at restart.
- From the ledger switch (32.6) it also takes `send_native_command` effects, which have no Run:
  with no runner alive it spawns one (8.5).
- **H3. Order.** The feeder transmits in issue order, is the only spawner, and drops a send the
  ledger no longer wants: an owner send when `holdRun` returns `Covered` or `Ended` (a Run ends when
  its runner retires, L1), a `send_native_command` once its send has left `live` (3.11). A send
  covered by a pending kill may still be transmitted before that kill executes; the kill, issued
  after it, then acts on the process it reached. The ledger relies on this for pending sends (L2,
  3.3).
- The feeder's memory is its queue, keyed by `(session, run, commandId)`, and each send's
  capability (a live handle, or `Adopted`). Every step calls `holdRun`:
  - `Held`: hand the transmission to its write fiber.
  - `Busy`: drop; the hold's owner ends or releases it.
  - `Cleaning`: request candidate retirement, await its commit, then re-enter the gate.
  - `Unserved{Some({runner, until})}`: park until `awaitStop(runner, "Escalated")` returns or
    `until` passes (6.4).
  - `Unserved{None}`: start a serving runner.
  - `Covered`, `Exhausted` and `Ended`: drop.
  - `StoreUnavailable`: one backoff (4.8).

  Every re-entry is a `holdRun` call. The feeder has no retry loop, no poll and no failure
  handler of its own. A key being stepped is queued again when a release commits, so no
  release is lost.
- A start failure, or `Unserved` on the step right after a start (`StartLost`), settles the
  send through Send Settlement (4.7): permanent unless the failure sets `retryable: true`. It
  is never retried in the feeder (main parity).
- The write fiber runs a release that fails on the store again after one backoff, until it
  commits (4.5's no-op rule makes the repeat safe).
- Interruption is not an outcome: an interrupted feeder writes nothing; the restart scan owns
  its unheld sends, and Settle and adoption its held ones.
- The live caller waits with `awaitRun(runId)`, which arms the commit signal and then re-reads
  the run.
- The queue's per-send I/O capability keeps the committed-release watermark and permits one
  synchronous first write only while that held transmission has not been released. It does
  not decide liveness. No waiter maps return.
- Start, cleanup and predecessor waits race the head's run on the commit signal, ending when
  it is terminal or covered by an accepted Stop; the feeder then steps again. Store-read
  failures re-arm after backoff.
- The resume mode is the outbox payload's `nativeResumeFallback`, not part of the key; at
  `Held` the frame is built in the payload's mode, and a capability in the other mode is
  replaced.
- The reactor's recall of a still-unheld send settles it `failed` (`processing_timeout`)
  through Send Settlement; a held send is untouched, including its marker. Only Settle writes
  runner-held `delivery_indeterminate`; the reactor's marker remains direct-provider-only. No in-memory
  cancellation of a queued owner send remains. Each write owner retains settlement evidence until commit or
  staleness; a failed settlement never restarts the send. The native-resume preparation
  caller still receives a typed attempt refusal immediately after its release commits.
- A send waits on its run, never on the socket. A socket or write failure leaves it held until
  release evidence (4.5) or the run's settlement.
- Every release, whoever commits it (the feeder's runner, the reconciler, adoption), wakes the
  feeder in the same step; its restart scan finds the run if the daemon dies first. For
  `ResumeRejected`, the ledger first issues the fresh fallback decision (4.8); the feeder never
  re-holds that release itself. A held run never waits on a loop that has ended. A release of a
  send with no queue entry enqueues it as `Adopted`.
- A re-hold after a release goes immediately and counts toward the cap, once the fresh fallback
  decision has issued when the reason is `ResumeRejected`.
- **Adoption is not a transmission.** When restart adopts a live runner that still holds a run, it
  appends nothing, checks no coverage and counts nothing toward the cap (7.2).

<!-- src: CONT C2 (feeder, adoption), C3 (release hands off), closing paragraph on S9.5; review 2026-10-28 (H9); model-gaps 2026-10-28; SETTLE S1, S4; REDESIGN 2026-10-28 (02-options-and-pick.md) H3 -->

### 4.5 Release and its evidence

```ts
release(run, runner, commandId, transmission, reason): Effect<void, StoreFault>
```

- `release` appends `run.released`. Its projector clears the hold only when
  `(runner_id, held_transmission)` still equals `(runnerId, transmission)`. Projection runs in
  event-sequence order, so a duplicate or stale release is a no-op.
- Losing a hold is a release, never a decision. Four kinds of evidence may release, and nothing
  else:
  - **Refused.** The runner host replies `command-refused{reason}` before `command-accepted` and
    before the command reaches the agent. Reasons: `exiting`, `retiring`, `interrupted` (4.6). For
    `exiting` and `retiring` the runner is leaving, so the release transaction also stops it
    (`Idle` for `exiting`, `Exited` for `retiring`) when its row is still serving. The next
    `holdRun` returns `Unserved`, never the same runner. A Reserved runner never refuses; a
    command cancels its reservation (6.9), so a swap never releases a send. A runner whose build
    predates `command-refused` refuses with `command-reply{failure.code: "runner_idle_exit"}`
    before any `command-accepted` for that transmission; that reply is `Refused{exiting}`. No other
    reply code is refusal evidence.
  - **NotSent.** The daemon never called write for this frame: the socket was closed, the runner
    had announced idle exit (the pre-write `runnerIdleFailure`), or adoption's hello reported
    `not_received`. A write that was called and failed, or a missing `command-accepted`, is not
    evidence. A send cancelled by the user between the hold and the write needs no release: its
    run settles cancelled.
  - **JournalAbsent.** The journal read is typed: `Absent | Present(state) | Unreadable`. Only
    `Absent` from a runner whose process is confirmed exited (the reaper's pid and start-time
    check) and whose build writes the journal before executing releases. A live runner is adopted
    instead. `Unreadable` (unreadable directory, corrupt record) and any older-build runner mean
    `delivery_indeterminate`, never a release. `Present` settles from the journal answer (4.9).
  - **ResumeRejected.** The runner reports that the provider rejected native resume before
    executing the input. `prepare-turn` releases; the ledger issues a new start decision with
    mode `fresh` and the same `commandId`. The feeder does not re-hold the release itself;
    `holdRun` binds the new decision as transmission `n + 1`, counting toward the cap (4.8).
- **One commit for release and stop.** The transaction-bound stop mutation is the body of
  `receipts.requestStop` without its `flushPendingWrites` wrapper: it runs inside the caller's write
  and reads its candidates in that transaction. Both `requestStop` and `release` use it. After the
  outer commit the lifecycle module applies the same post-commit step as `requestStop` (state and
  row cache, route cache, revocation and the runner entry scope's close (6.11), waiters,
  reconcile). A `requestStop` that races a
  release-driven stop joins it.
- `release` is the lifecycle module's eighth call (6.10). The `Idle` stop reason is written by a
  refusal with `exiting` and by idle exit.

- A failed release write is retried by its caller's owner: the feeder's write fiber (4.4), or the
  reconciler's cadence for Settle. An adoption release failure propagates through attachment
  recovery; bounded reconnect exhaustion retires the runner and hands its held runs to Settle.

<!-- src: CONT C3, Deleted or changed (lifecycle module); review 2026-10-28 (M7, H11); model-gaps 2026-10-28; SETTLE S1, Verified requirements 5 -->

### 4.6 The host's interrupt refusal

- The `send-turn` frame carries its `runId`. `interrupt_turn` carries the committed cohort
  (`payload.stop.owners`) as `runIds`.
- The host records those run ids for the rest of its process life and refuses a later `send-turn`
  whose `runId` is recorded with `command-refused{reason: "interrupted"}`. 4.5 releases it and
  4.3 step 1 settles it "Stopped before delivery".
- Run ids are used, not turn ids, because run ids are unique and always present (continuation sends
  share a cut-off message id).
- An `interrupt_turn` without `runIds` (an older daemon) records nothing. `end_session` needs no
  record: the runner is exiting and refuses with `exiting`.
- **From 32.5 (OPEN-5, section 9).** The run id stays a coverage label, never a send identity.
  `interrupt_turn` also names, for a wake Run, the host turn label its opening observation carried
  (3.4), and carries no input ids. The host answers a `send-turn` in this order: `exiting`,
  `retiring`, `interrupted` (its `runId` is recorded), a duplicate token (the journal's answer,
  never a second native query), else accept. It interrupts only running turns whose run or label is
  named, so a late interrupt never stops a newer turn; a payload's turn handle ignores an interrupt
  once its own turn has ended. Until 32.13 the `runIds` come from `payload.stop.owners`; from 32.13,
  from the ledger's `control` `stop` coverage (5.4).

<!-- src: CONT C3 (host's interrupt refusal), Required work 3; OPEN-5 decision -->

### 4.7 Outcome and the duties committed with it

- **The Run Ledger owns every Run Effect's outcome**, for sends and control effects alike. Until the
  ledger chain lands, the owner is the run's settlement path: for a runner send, a socket failure,
  a write failure or a missing reply is never reported to the reactor as the send's outcome, and
  the reactor writes its terminal outbox status only from its run's terminal settlement.
- **Send Settlement** owns explicit settlement of a modern owner send until each provider's
  ledger switch. Native terminal projection remains the existing separate source at main's
  Q26 bar; its attempt fence is assigned to 32.2.6/32.6:
  - **Interface.** `settleSend(tx, evidence)`. The send reference belongs to each evidence variant.
    Evidence is what the caller saw (`replied`, `journal_finished`, `failed`, `covered`,
    `process_lost`, `delivery_unknown`); `classify` maps normalized terminal evidence onto the Run Effect vocabulary
    (`succeeded`, `retryable`, `permanent`, `delivery_unknown`) plus `cancelled`. It returns
    `Effect<void, StoreFault>`. Correlate the exact claim and held transmission inside
    the transaction before any terminal or duty; stale evidence changes nothing.
  - **Callers:** `holdRun` steps 1 and 3, the reactor's runner reply and its recall of an unheld
    send, the feeder's start outcome, Settle (the only caller of `delivery_unknown`), adoption,
    the attachment's retained reply after a reconnect (as `replied`), and Gone-time settlement.
  - **Ending.** It appends one run terminal event, guarded by the run's status, carrying
    `classify`'s flag rather than the source's; `delivery_unknown` is a `turn.error` coded
    `delivery_indeterminate`, Settle's runner-held marker (section 2). The outbox row
    follows in the same projection; no caller writes outbox status for a modern run, and pending
    evidence writes nothing. A retryable outcome is a terminal `turn.error` with `retryable: true` and
    `retryAt`; the reactor re-sends on a fresh run (4.8).
  - **`classify`** decides send retry policy from normalized terminal evidence (`replied`,
    `journal_finished` with a terminal result, `failed`, `covered`, `process_lost`,
    `delivery_unknown`): retryable only when `=== true`, and a reply only when not
    `steer-declined` and not `retryHandled`. Producers set or copy the flag and protocol
    boundaries validate it; neither decides policy.
  - **Wake.** An appending settlement stamps the session version in its transaction; every
    non-reactor caller then wakes the reactor (an idempotent drain). The periodic outbox drain
    is the backstop. A projection commit alone wakes nothing.
  - **Switches.** The outbox adapter serves until 32.6 (Claude), 32.10 (Cursor), or 32.21
    (Codex). That ticket migrates source evidence through 4.11, not a generic outcome-only
    adapter. Journal finished is consumption only, interrupted replies are provider evidence,
    coverage refers to an existing Stop, and process loss is settlement. No observed reply
    creates a user control. Delete the old provider path atomically and the unused outbox
    adapter at 32.13. No unused future adapter is built in R2.
- Every outcome is decided from one piece of evidence and the session state. A Send Token that is no
  longer live changes nothing. Starting an effect (pick the next eligible send, wait behind an
  earlier or `delivery_unknown` send, apply the cap, bind the run, mint the next token) is part of
  the same owner. For a runner-held start or steer the cap, the bind and the token's `n` are
  `holdRun`'s alone (4.3, 4.11); the ledger mints tokens and applies the cap only for effects with
  no hold. The wait-behind rule exists once.
- Evidence maps onto the ledger's inputs. For a runner-held send, the hold facts, the runner's
  reply and the journal answers are evidence kinds the decider reads from the existing event
  stream (3.13, 4.11); nothing copies them into stored chains.

  | Evidence today | Ledger input |
  |---|---|
  | native terminal | `observe` `result` |
  | runner reply | `runner_reply`, read as `effect_outcome` or `result` (4.11) |
  | hello: runner holds it | adoption appends nothing; the journal `running` answer reads as `input_present` (4.11) |
  | hello: runner never got it (`not_received`) | `run.released` `NotSent`, read as Consumption NotConsumed{absent} (4.11) |
  | delivery unknown | `observe` `effect_outcome` `delivery_unknown`; runner-held: Settle's `delivery_indeterminate` (4.11) |
  | native resume rejected | `effect_outcome` `permanent`, code `native_resume_rejected`; runner-held: `run.released` `ResumeRejected` (4.11) |
  | daemon refusal (project inactive, admission timeout) | `settle` `project_inactive`, or `effect_outcome` `permanent` |
  | Stop | `control` `stop` / `cancel_input` |
  | runner lost | `settle` `process_lost` |

- During projection replay (`ctx.replaying`) nothing settles an outcome.
- **Duties commit with the decision**, in one SQLite transaction with the status change, in this
  order: receipt; payload trim; provider state (once, on success); cleared native cursor; input
  back to the inbox; failed message placement; draft restore; transition record. Draft restore
  does not run in its own transaction. Only notifications (wake the reactor, drain the inbox, push
  the restored draft) run after the commit, and every consumer rescans on startup.
- **After any failure** every running effect has exactly one owner: an adopted send, a live call
  in this daemon, or the `delivery_unknown` rule. A failed commit rolls back the status and every
  duty together, and each evidence source delivers again.
- `delivery_indeterminate` keeps its meaning and is never re-sent. For a runner-held transmission
  the reconciler's Settle is its only writer.

<!-- src: SEND-SCOPE-5 S8, S9.1, S9.2, S9.6; CONT C1 (Outcome stays with the Run Ledger; Delivery is owned by the hold); review 2026-10-28 (H1, H2); SETTLE Data shape 2, 3, S2 -->

### 4.8 Retries, the cap, the resume fallback and steers

- **A message that never reached the agent.** When a Run ends, or a runner reconnects, and an
  input's send provably never reached the agent and the user did not press Stop, the send is
  re-sent automatically, up to the cap. Otherwise it ends `failed` or `cancelled`: the failed
  message is shown once and its text returns to the composer. `delivery_unknown` is never re-sent.
  This replaces the native projection settling undelivered sends with the Run's outcome.
- **Steers.** A steer whose Run is still active is re-sent as a steer. A steer whose Run has ended
  returns to the inbox as the next message, with no error shown. Until 32.5, a joined steer is
  carried by its owner's holder: if its runner never received it, it is moved to `retryable_failed`
  with `next_attempt_at = now`, keeping its run and `request_sequence`, writing no event, and the
  reactor re-sends it as a `Fresh` send with an incremented attempt and a new `sinkId`. This is the
  one re-send outside the feeder. From 32.5 a joined steer has its own transmissions and the feeder
  re-holds it like any send (4.11). Later sends of the session wait behind it.
- **Backoff and cap.** One backoff function (1 s, 2 s, 4 s, 8 s, capped at 30 s) applies to
  re-sends after a retryable provider failure, anchored at its outcome; `retryAt` is a lower bound
  (3.7). The cap is 5 transmissions per send or control effect. For a runner-held start or steer,
  `holdRun` is the only cap, durable and counted from
  `run.dispatched` (4.3 step 3); for an effect with no hold, the ledger's `decide` applies it. A
  re-send after `input_absent` or a
  release goes at once but counts. Past the cap, an input send fails, its message is shown once
  and its text returns to the composer; probes follow 3.7. A send retried onto a fresh run keeps
  its transmission count. The same backoff spaces the feeder's re-entries after
  `StoreUnavailable`, the write fiber's repeated release, and the reconciler's retry of a failed
  Stop commit. A runner-held send's retryable outcome ends its run and re-sends on a fresh run; the
  cap counts by `commandId` across runs. A start failure precedes any hold and counts no
  transmission, so a start failure that keeps setting `retryable: true` re-sends without a bound at
  the 30 s cap, as on main.
- **The resume fallback is a new transmission.** A rejected native resume ends that transmission
  (released `ResumeRejected` for a runner send). The ledger issues a new start decision under the
  same `commandId`; `holdRun` binds it as `n + 1`. The feeder does not re-hold the release itself.
  Until 32.5, its existing fallback marker keeps the runner's deduplication key distinct; from
  32.5 it is transmission
  `n + 1`, so its token is distinct with no marker (9). A rejection of the fresh transmission is
  terminal and visible. No payload marker decides the outcome.
- **Decided (model-gaps, 2026-10-28): start mode belongs to the ledger.** The start effect carries
  `mode: "resume" | "fresh"`. `resume` uses the host's native cursor if it has one; the ledger
  never knows the cursor. The ledger issues `fresh` after `run_released ResumeRejected`, after
  `effect_outcome permanent native_resume_rejected`, and after `session_ended`. The fresh
  transmission starts a new native session and clears the stale cursor. Rejected: the host picks
  mode at dispatch (two owners); inferring mode from `n` (`NotSent` also makes `n + 1`).
- **Re-sends into the outbox** (a retryable send row returns to the inbox instead of a loop holding
  it) belong to 32.2.6's `decide`, which owns one Stop rule for inbox rows and claimed rows.
- **Deleted:** `canRetryUnreceivedSend`; `idleExiting` as permission to continue a send; the holder
  refusal's `mapError` that rewrote `runner_stopping` into retryable codes; the handoff deferral in
  `settle`; the committed requeue's, the eviction requeue's and `onIdleExit`'s own retry decisions;
  admission's draining re-selection and its uncapped `Effect.retry`; `retryUnacceptedSend` and every
  other re-send path outside the feeder, except the reactor's joined-steer re-send above until 32.5;
  the reactor's `writeFailure` as a send's outcome; the
  `Recovered` origin, the replay callbacks and per-driver recovery replays.

<!-- src: SEND-SCOPE-5 S9.3, S9.4, S9.5; SEND-SCOPE-4 S7; CONT Data shape (Scope), C3 (ResumeRejected), closing paragraph, Out of scope, Deleted or changed; CONT failure mode 39; review 2026-10-28 (H1, H9, M6); model-gaps 2026-10-28; SETTLE S1, S3, S4 -->

### 4.9 Journal answers

- The runner host's journal is keyed per send, never by input id or run id: by the outbox command
  id and attempt until 32.5, and by the Send Token (4.11) from 32.5 (OPEN-5). It refuses a repeat
  and is not a second owner of delivery.
- A current-build runner reports, for every send its journal retains, one answer computed from its
  own records:

  | Answer | Meaning | Daemon action | Ledger evidence (4.11) |
  |---|---|---|---|
  | `running` | a call in this process owns it | adopt | `journal_answer`, read as `input_present` |
  | `finished` | the send's key (until 32.5 attempt and fallback flag; from 32.5 the token), result or failure | before the provider switch, an actual terminal result/failure may settle through Send Settlement (4.7); after it, replay the runner reply or result separately; without one, the Run's own deadline applies | `journal_answer`, read as Consumption Observed only |
  | `uncertain` | retained record, no outcome, no owning call | at adoption: stays held, nothing written (7.2). At Settle: `delivery_indeterminate` (`runner_send_uncertain`), written by Settle only (4.7, 7.3). Never re-sent | Settle's `delivery_indeterminate`, read as Transport Unknown |
  | `absent` | no record | owner sends: 4.5 (adoption `not_received` is NotSent; an exited runner's `Absent` is JournalAbsent). Joined steers: requeue (4.8) | `run.released` `NotSent` or `JournalAbsent`, read as NotConsumed{absent} |

- The hello reports each held transmission's status (7.2). The statuses and the journal answers
  are one vocabulary:

  | Hello status | Journal answer | At adoption (7.2) |
  |---|---|---|
  | `received`, `running` | `running` | adopted |
  | `not_received` | `absent` | released `NotSent` |
  | any other | `finished` | before the provider switch, an actual terminal result/failure may settle through Send Settlement (4.7); after it, stays held for the separately replayed reply or result, otherwise its own deadline applies |
  | any other | `uncertain` | stays held; only Settle writes `delivery_indeterminate` |

- The daemon maps each answer without inference. The ledger chain (32.6, 32.14) reads these
  answers as evidence from the event stream, never as stored chains (3.13, 4.11), and uses them as
  the runner side of its `probe` effect rather than building another.
- Main-built runners: see 7.4.

- Before its provider switch, a finished journal with an actual terminal result/failure may
  use the existing outbox settlement path through Send Settlement (4.7). Missing and intake-only
  results do not settle. After the switch, 4.11's consumption-only mapping is authoritative:
  finished never invents `result` or `runner_reply` evidence. `ResumeRejected` is a release in
  both phases.

<!-- src: SEND-SCOPE-6 S10.1; RA §8 (32.13 send journal); CONT C2 (adoption), C3 (JournalAbsent); review 2026-10-28 (H2, H6, H9, D1); model-gaps 2026-10-28; SETTLE Data shape 2, S2 -->

### 4.10 Direct providers

- OpenCode, through its SDK/API client, is the only direct provider. Claude, Cursor and Codex all
  run in the runner host (`makeRunnerProviderInstance`, 9). A send to a direct provider never has
  a hold, so 4.3 to 4.5 never apply to it.
- It keeps the adapter's typed indeterminate result and the reactor's nonterminal
  `delivery_indeterminate` marker on its still-running outbox row, which keeps the admission blocker
  and replay.
- The partition is by row: a row is runner-held or direct, never both, so each
  `delivery_indeterminate` row has one writer.
- Moving direct-provider uncertainty into the ledger belongs to 32.2.6's `decide`; the ledger's
  interpreter becomes the marker's writer at OpenCode's switch, 32.11 (section 2).

<!-- src: CONT C1 (Direct providers); review 2026-10-28 (M1, H10) -->

### 4.11 Runner-held sends in the ledger chain

**Build target (settled).** 32.17 is built against sections 4.1 to 4.10. The ledger chain builds
on the hold, `run.released`, the feeder, `stopCovers` (5.2) and the journal answers (4.9). It may
not add a second owner of the hold, of coverage or of the transmission count. Its `decide` takes
over send outcomes for direct providers, re-sends into the outbox, and the one Stop rule for inbox
and claimed rows (4.8, 4.10, 5.4).

**Decided (OPEN-1, 2026-10-28): a runner-held send's chains are derived from the hold, never
stored.** The hold events are the one owner of a runner-held send's delivery. For those sends the
ledger's transport and consumption chains (3.5) are a view over the hold facts, by this mapping.
The hold facts are evidence kinds (3.13) the decider reads from the existing event stream; they
are never copied into a second store. The ledger stores chains only for sends with
no hold (direct providers). Nothing writes a stored chain for a runner-held send, and no reader may
treat the hold as a cache of a ledger chain.

  | Hold fact | Source | Ledger chain value |
  |---|---|---|
  | `run.dispatched{commandId, transmission: n}` | the `run.dispatched` event | the send's issue decision; `(commandId, n)` is the transmission |
  | held, no other evidence | `run.dispatched` with no later `run.released` for that transmission | Transport Issued; Consumption None |
  | released `NotSent` or `JournalAbsent` | the `run.released` event | Consumption NotConsumed{absent} |
  | released `Refused` (`exiting`, `retiring`, `interrupted`) | the `run.released` event | Consumption NotConsumed{declined} |
  | released `ResumeRejected` | the `run.released` event | Transport Failed{`native_resume_rejected`} |
  | `delivery_indeterminate` | the effect row's marker, written by Settle (the outbox until the provider's switch, then Run Effects; section 2) | Transport Unknown |
  | runner reply | the runner's `command-reply` event | `effect_outcome` / `result` |
  | journal `running` | the hello's journal answer event | Consumption Observed (`input_present`) |
  | journal `finished` | the journal answer event | Consumption Observed only |

Adoption appends nothing, so it is not a hold fact. A journal `uncertain` answer changes no chain
by itself; Settle's `delivery_indeterminate` carries it (4.9).

After its provider's switch, journal `finished` proves consumption only. Outcome comes from
the replayed `runner_reply` or `result`, emitted as separate evidence. Without one, the Run's
own deadline applies. Before the switch, an actual terminal journal result/failure may settle
through Send Settlement's outbox path (4.7, 4.9); missing and intake-only results do not settle.
`ResumeRejected` remains a release in both phases. A finished answer never invents `result` or
`runner_reply` evidence for the ledger.

Rejected: two stores (the ledger stores its own chains for every send and the hold becomes a cache
of them, or is retired at 32.13), because it gives one fact two writers.

**Decided (OPEN-2, clarified model-gaps, 2026-10-28): the Send Token is an opaque host string,
never parsed.** `run_dispatched` binds it by `commandId` and `transmission`; `n` is counted from
`run.dispatched` events for that `commandId` (4.3), with no second stored count. Each transmission
has its own token and chains, and the issue folds over its transmissions. The host journal keys
by the token, and `sinkId` carries it. Rejected: a shared `commandId:n` codec (parses the opaque
brand and is ambiguous with `:`); a structural token (breaks equality and map keys);
the outbox `request_sequence` plus attempt (a recommit changes
`request_sequence`), and the outbox command id plus a separate attempt counter (a second count of
the same transmissions).

**One minter and one cap.** For a runner-held start or steer, `holdRun`'s `run.dispatched` is the
only minter of `n` and `holdRun` is the only cap (4.3). `ctx.newId` mints tokens only for effects
with no hold (3.4). Nothing else counts transmissions.

**Joined steers (from 32.5).** A joined steer gets its own `run.dispatched` per transmission, keyed
by the steer's `commandId` and naming its owner's runner; its opaque token identifies that transmission.
The feeder holds it through `holdRun` like any send: coverage is decided for the steer's own run id
(4.1), and its transmissions count against its own cap. Until 32.5 the as-built rule of 4.8
stands: the owner's holder carries it and the reactor re-sends it.

<!-- src: AUDIT-2 T8; FB §3; CONT C1, C2, Data shape, Decisions (O); STOP-INTENT S5 (last bullet); SEND-SCOPE-5 S8, S9.1; SEND-SCOPE-6 S10.1; review 2026-10-28 (H1, H2, H9); model-gaps 2026-10-28; SETTLE S2 (source-aware provider migration) -->

## 5. Stop and coverage

### 5.1 What Stop does to a Run

- **Stop always stops.** Stop moves the active Run to Interrupting with a 30 s deadline. A native
  interrupted result ends the Run.
- If the deadline passes, the Run is ended `interrupted` (forced), tombstoned, and the runner is told
  to close the native query. If the close is not confirmed before a second deadline, the effect is
  `kill_and_respawn`.
- **`kill_and_respawn` counts as released, whatever its outcome.** Issuing it retires the runner
  it is addressed to (L1, 3.3), which covers the kill's own send: a kill never holds
  `anythingMayAct`, and its outcome is a diagnostic. Whether the process still runs belongs to the
  kill routine and the process watcher (6.6). The Run is Ended Interrupted, forced. The
  native-session fence held for that Run's query is released at the same moment, with no
  native-session probe; the next queued start proceeds normally. There is no quarantine. A
  replacement runner that cannot start is the ordinary start refusal of the next start, not a
  ledger concern at kill time. The process watcher still turns runner exit and failed liveness
  checks into `settle` `process_lost`.
- **OpenCode** has no runner to kill. Its Stop is: cancel the in-flight request, issue the native
  abort, and hold the native-session fence until a probe confirms idle.
- **Ordinary Stop pauses the inbox; Run now bypasses the pause.** What happens to steers when Stop
  ends a Run is in 3.9.
- **Live or unknown background tasks** put a confirm gate in front of destruction (8.4). An ignored
  interrupt with live or unknown tasks stays Interrupting with a pending confirm, and the deadline
  alone never destroys them.
- Stop is not a goal action. Stop never pauses or clears a goal (8.6).

<!-- src: SPEC Implementation Decisions (Stop that always stops; quarantine sentence withdrawn by D1-5); D1-1 to D1-5; D1 (OpenCode is unaffected); BG Decision 3 (goal flow separate from Stop), Decision 4; REDESIGN 2026-10-28 (02-options-and-pick.md) L1 -->

### 5.2 Coverage

- **Stop coverage is owned by the Run Ledger.** It is decided per run, apart from a send's
  ledger coverage (L1, L2, 3.3). A run is Stop-covered when a committed Stop control row of its
  session lists it in `payload.stop.owners`.
- One predicate, `stopCovers(session, run)`, answers it. It lives in the ledger's settlement module
  beside `sessionRunOwnersQuery`. `holdRun` and the reactor's own stop-owner read both use it.
  Nothing in memory answers coverage.
- `legacyStopOwnersQuery` (outbox order) is a read-only fallback for control rows written before
  `payload.stop` existed. It never decides for a newer row: a recommit re-inserts a send with a new
  `request_sequence` and would escape it. It is deleted with the legacy paths (32.13).
- Coverage of a send is decided for the send's own run id (4.1).

<!-- src: CONT C1 (Coverage), Data shape (Scope); CONT failure mode 33; REDESIGN review r1-2 -->

### 5.3 Stop acceptance is one commit

The engine owns control acceptance. Its Stop acceptance operation runs inside one `durable.write`:

1. The receipt check. The fingerprint covers the caller's intent (session, command id, requested
   scope), not the derived `stop` or control type. An existing receipt returns its stored payload
   unchanged.
2. The cohort snapshot.
3. The choice between `end_session` and `interrupt_turn`.
4. The whole of the former `prepareStop` write: pending-row settlement ("Stopped before delivery"),
   `input.requeued`, and the `retryable_failed` delete.
5. The interrupt's targets.
6. The control row, committed with `payload.stop`.
7. Projection of its events.

- Execution of the accepted command id follows the commit. `prepareStop` calls this operation and has
  no `commit.write` of its own.
- A waiting send is therefore never uncovered between the cohort snapshot and the control row.
- The `interrupt_turn` frame carries `payload.stop.owners` as `runIds` (4.6).

<!-- src: CONT C1 (Stop is accepted in one commit), Confirm before building 3, Required work 1; CONT failure modes 24, 44 -->

### 5.4 Stop cohorts and run joining in the ledger chain (decided OPEN-3, 2026-10-28)

- **The ledger replaces the Stop cohort at 32.13.** The ledger's `control` `stop` becomes the one
  owner of coverage. In the same ticket `payload.stop.owners`, `stopCovers` and `joined_into` are
  deleted, together with run joining and steer-declined reservations (one active Run per session
  removes them).
- **Until 32.13, `stopCovers` over `payload.stop.owners` is the interim owner (5.2).** Tickets
  before 32.13 build on it and add no second owner of coverage. The one Stop rule for inbox rows and
  claimed rows is 32.2.6's `decide`, which reads `stopCovers` until 32.13 and the ledger's `control`
  `stop` after it.
- Coverage keeps exactly one owner at every point in the build order: `stopCovers` before 32.13,
  the ledger from 32.13 on, for every provider. 32.13 switches the owner in one ticket, with no
  period where both are read. 32.8's `control` `stop` records the Stop but is not read for coverage
  before 32.13; per-provider ledger tickets do not move coverage.
- Rejected: keeping `stopCovers` over the committed cohort as the ledger's coverage, with run
  joining kept for runner sends, because it keeps two Stop models alive after the ledger exists.

<!-- src: SPEC Implementation Decisions (One active run per session), Further Notes on 32.13; CONT C1, Out of scope, Decisions (D, E, F, I/L, M); review 2026-10-28 (H10) -->

## 6. Runner authority, stop and processes

### 6.1 Identity

- **Generation is `runnerId`.** The daemon mints it per spawn and passes it to the host on the
  command line. A surviving host keeps it across a daemon restart; only `attachmentId` rotates.
- **The host fences query replacement.** Rebind, agent change, rewind, fresh native id,
  stop-after-foreground dispose, discarded prewarm and native-resume fallback all replace the SDK
  query while `runnerId` is unchanged, and old and new overlap. Each query's output callbacks capture
  the query object when it is created. A frame from a query that is no longer current is dropped at
  capture, by object identity. Frames travel in order over one socket.
- **Evidence passes the host fence.** Acceptance and terminal facts from a replaced query still go
  to the daemon, so late acceptance reaches the ledger.
- **Label `runnerId:querySeq`.** The host bumps `querySeq` on each query replacement and stamps it
  on every frame; the hello carries the current value. Only the ledger reads it; it splits the
  label only for process state and older labels (L1, 3.4). An older host has no counter, so its frames are labelled `runnerId` alone and it has no
  in-host fence; 32.5's old-runner rule refuses it new work. Logs carry `runnerId` and, where
  present, `querySeq`.
- **The ledger never mints or bumps generations.** It folds one process state per `runnerId` from
  the host's labels and its own kills (L1), and addresses each send at issue (L2). Query-ended
  coverage is in 3.3.
- **`process_started` is reported each time a serving runner becomes live**, labelled with its
  hello's `runnerId:querySeq`, before any of its frames reach the ledger. `reattached` is false
  when it first serves: a spawned serving runner at its hello's live adoption (6.2), before the
  hello's send acknowledgements and replays; a candidate in the swap commit (6.9). It is true on
  every `recover()` adoption after a daemon restart (7.2). A candidate, a starting adoption and a
  query replacement report none; a replacement's frames advance the runner's latest `querySeq`
  (L1). A `run_dispatched` may name a spawned runner before its hello (6.9 `register`); L1 and L2
  decide that case. `process_lost` is recorded in the retirement commit (6.5). OpenCode's reporter
  is in 9.

<!-- src: RA §2, §7; FB §2 ("bumps" replaced by RA §7); REDESIGN 2026-10-28 (02-options-and-pick.md) L1, L2; REDESIGN review r1-2; REDESIGN review r2-1; REDESIGN review r3-1 (one report per serving start; swap commit) -->

### 6.2 `RunnerAuthority`: grants and guarded writes

```ts
type Grant = StartingGrant | LiveGrant; // opaque; only adopt mints
type Write =
  | { readonly kind: "output" }    // session history and live state
  | { readonly kind: "evidence" }; // Run Ledger facts; the ledger judges
type Revocation = "superseded" | "exited" | "retired";

interface RunnerAuthority {
  /** Discovery, spawn, hello, promotion. The only door to a Grant. */
  readonly adopt: (runners: readonly RunnerIdentity[], phase: "starting" | "live") =>
    Effect.Effect<{ grants: ReadonlyMap<string, Grant>; survivors: readonly Survivor[] },
                  AuthorityUnavailable>;
  /** Synchronous: no I/O on the caller's path, cannot fail. */
  readonly revoke: (grant: Grant, reason: Revocation) => Effect.Effect<void>;
  /** Every runner-derived write. Durable ops are rechecked at commit. */
  readonly guarded: <A, E, R>(grant: Grant, write: Write,
                              op: Effect.Effect<A, E, R> | (() => A)) =>
    Effect.Effect<Option.Option<A>, E, R>;
}
authorize(g: Grant, w: Write, now: number): Option<AuthorizedWrite>

type RunnerRecord = Starting | Live | Exiting | Retired; // one variant per tag, required fields
promote(r: Starting): Live
revoke(r: Live, reason: Revocation): Exiting | Retired
```

- The authority exposes read-only snapshots and verbs (`observe`, `markSignalled`, `forget`). No
  caller mutates or deletes a record.
- **Policy** (behind the seam):

  | Grant state | output | evidence |
  |---|---|---|
  | starting | no | yes |
  | live | yes | yes |
  | superseded | no | yes |
  | exited / retired | no | yes |

  There is no `release` write kind; a runner's own sends close through their handles (4.2).
  Warmup replies are protocol replies, not writes, and are not checked.
- **Invariants** (AI1 to AI7):
  - AI1: `revoke` flips the tag synchronously. A guarded write whose final commit hook runs after
    that returns `None`.
  - AI2: no commit through the write seam lands after `revoke` without the tombstone. The seam's
    final hook flushes pending tombstones into the same transaction.
  - AI3: at most one live grant per session. Which runner serves a session is the database's
    serving row (6.9).
  - AI4: a revoked grant never revives. `adopt` refuses any runner whose row has `retired_at` set
    and returns it as a survivor.
  - AI5: `revoke` leaves no write window. A revoked runner's memory is released by its entry
    scope, which its stop commit's post-commit step closes (6.11); it needs no grant.
    Durable settlement never depends on the runner. A cancelled warm candidate emits nothing.
  - AI6: `evidence` passes at any label, even after retirement.
  - AI7: memory thunks run immediately after the check, with no yield in between.
- **Errors.** `guarded` never fails for staleness: it returns `None` and logs once per
  `(runnerId, kind)`; the op's own error passes through. `revoke` cannot fail; a failed tombstone
  flush is logged and retried. `adopt` fails with `AuthorityUnavailable` only when the retired rows
  cannot be read; recovery defers and nothing is adopted.
- **The write seam holds no runner knowledge.** It keeps one generic queue of pending writes per
  SQL client. `revoke` queues the tombstone as an opaque write supplied by `RunnerAuthority`; the
  seam forks one standalone flush and runs pending writes in its final hook. Whichever runs first
  wins; both are idempotent. The cursor row's columns and SQL live with the receipt store.
- **Guard test.** Runner-derived writes may not open `sql.withTransaction` directly; they go through
  the write seam. A runner-derived write that reaches the seam without a grant is a defect. The
  test is proven red with a planted bypass.
- **Deleted:** `withEntryOutput`, `currentCommitGuard`, the receipt `isCurrent` callback,
  ingestion's receipt `beforeCommit`, the f4 stopgap fences, the `.retired` marker and everything
  around it, `runner_generations`, the pre-commit SQL predicate, and `legacy:<runnerId>`.

<!-- src: RA §3, §4, §9 (R1, R2); AUDIT A1 (cleanup grant), A2; AUDIT-2 T1, T2; SEND-SCOPE S3; STOP-INTENT What is deleted (revoke cohort); SWAP S7; review 2026-10-28 (H11); REDESIGN review r3-2 (AI5 wording for the swap) -->

### 6.3 Request stop and the retirement row

- **Every way a runner is stopped** (explicit Stop, end-session, project removal, supersede or retire,
  idle exit, a confirmed exit, a refusal with `exiting` or `retiring`, an abandoned candidate) makes
  one call: `requestStop(runner, reason)`.
- It commits one transaction: the retirement row with leader identity, reaper identity if any, the
  group snapshot, `retired_at` and the stop reason. The row lists no runs (6.5). Retirement clears
  `attachment_id` in the same statement. Attach requires `retired_at IS NULL`, so a reconnect never
  revives a retired runner. A non-Superseded stop also retires the session's candidates in the same
  commit (6.9).
- The record is written before any signal to the runner, on every path (Stop, retirement, survivor
  retries, restart recovery). A crash after the commit leaves a record restart recovery finds.
- **If the commit fails with a store fault, nothing durable changed:** no fence, no revoke, no
  signal, no shutdown command. The runner keeps running and serving.
- For every reason except `Superseded`:
  - the intent stays `Committing`, and the reconciler re-runs the commit step after one backoff
    (4.8) until it lands, logging each failure;
  - waiters wait, and a second Stop joins;
  - `requestStop` does not fail on a store outage. It waits for commit/rejection; a promoted
    candidate returns Ignored, which no caller follows with awaitStop.
- `requestStop` awaits commit or rejection; the reconciler owns its worker independently of
  the waiter. Restart re-derives from durable control/candidate/dead-process facts per S3's
  table. A healthy reattachment cannot recover an uncommitted direct Stop, as on main (Q26).
- `Superseded` (the swap) fails with the existing "stop runner" error, and the upgrade's backoff
  retries it (6.9).
- `CandidateAbandoned` reads the row's role in its commit; a row already `serving` is not
  stopped.
- **If the runner's existing row is rejected on decode**, `requestStop` fails the same way and logs
  the rejection. It never signals and never sends shutdown. The state returns to `Running` and
  the waiters fail.
- `retired_at` is set-only and is the fence that outlives memory. A daemon starting up never
  re-adopts a retired runner as live; it hands the row to the reconciler.
- The transaction-bound form of the stop mutation (4.5) lets a release and a stop commit together.

```ts
type StopReason =
  | { _tag: "Explicit" } | { _tag: "EndSession" } | { _tag: "ProjectRemoved" } | { _tag: "Idle" }
  | { _tag: "Exited" } | { _tag: "CandidateAbandoned" } | { _tag: "Superseded"; successor: RunnerId };
type Identity = { tag: "Verified"; pid: number; startTime: string }
              | { tag: "Unverifiable"; pid?: number };
```

- The row is decoded with Schema at the store; a rejected row is rejected alone and logged.
- Membership and signals are separate facts on the row. The group snapshot answers "which processes
  are this runner's". The signal log answers "what was sent to whom, and was it delivered". A
  refused or failed signal adds to the log and never removes a member.

<!-- src: STOP-INTENT S1, S5; REAPER R3; RA §4; AUDIT-2 T3, A13; SWAP S7, K; CONT C3 (Refused, one commit for release and stop); SETTLE S3 -->

### 6.4 The stop state, the reconciler and waiters

```ts
type RunnerStop =
  | { _tag: "Running" }
  | { _tag: "Committing"; target: StopTarget; reason: StopReason; waiters: Deferred<"Requested" | "Ignored", StopFailed> } // identity only, no retirement/progress fields
  | { _tag: "Requested"; record: RunnerRetirement }             // row committed, nothing sent yet
  | { _tag: "Escalating"; record: RunnerRetirement }            // shutdown sent and/or signals in the log
  | { _tag: "Escalated"; record: RunnerRetirement }             // TERM, 3 s, KILL, 1 s window is over
  | { _tag: "Gone"; record: RunnerRetirement }                  // every snapshotted member gone
  | { _tag: "Settled"; record: RunnerRetirement };              // runs settled, evicted, pruned (6.8)
decideRunnerStop(state, observation) -> { state, actions }
// actions: Commit | SendShutdown | Signal | Settle | Evict | Prune | Notice
```

- The reconciler module (`runner-retirement.ts`) owns this state. Callers read it; only the
  reconciler changes it. `entry.retirement` is a read of it.
- `Committing` is the only state that is not durable. A second Stop joins it instead of committing
  again. It does not guard dispatch; the database does (4.3). On a store fault it stays `Committing`
  and the reconciler retries the commit (6.3). Only a decode rejection or a `Superseded` refusal
  returns it to `Running` and fails its waiters.
- The worker starts at intent registration; `Committing` can only commit or reject. Durable
  stop actions require the successful commit's retirement row. The generic durable-row tick
  never treats `Committing` as `Requested`. `Ignored` resolves to `Running` without a Stop wait.
- `Requested` to `Settled` map onto the row: its tag plus its signal log. Memory is a cache of the
  row and is rebuilt from it at startup.
- `decideRunnerKill` is the signal part of `decideRunnerStop`.
- **The reconciler is the only code that** sends shutdown, signals, evicts a stopped runner or
  prunes its row, and, today, settles its runs. From each runner-held provider's ledger ticket
  (Claude 32.6, Cursor 32.10, Codex 32.21) that provider's runs are settled by the retirement
  commit instead (6.5). Stop's live path, the survivor watcher and restart recovery are one loop
  over the same rows.
- **Evict** only removes the runner's entry from the manager's map. The entry's scope has already
  closed in the stop commit's post-commit step (6.11).
- Each action is idempotent and keyed by the row. A failed write after the commit (signal log, Gone,
  settlement, prune) leaves the row where it was; the reconciler retries on its cadence and logs.
  It never fails a waiter and never rolls back the fence.
- Until each provider's switch, Settle's settlement goes through Send Settlement (4.7). The
  reconciler is not a new writer of a send's outcome. Its Settle reads the journal first (4.5,
  7.3); in the ledger chain its answers are late evidence for an already Ended run (7.3).
- **Waiters.** Callers wait on the state: `awaitStop(runnerId, "Escalated")` for end-session and
  shutdown (the escalation window is over, not that every member is gone); `"Settled"` where a caller
  needs the runs settled. Once the row is committed no waiter sees a failure. Two racing Stops
  share one commit.
- `holdRun` names the stopping predecessor and its window end in `Unserved{predecessor}`; the
  feeder parks until `awaitStop(predecessor, "Escalated")` returns or the window ends, then
  starts a serving runner. The park also ends early, and the feeder steps, when the head's run
  ends or a Stop commit covers it (4.4). No other code scans the stop states for a predecessor.
- The release's stop step receives the `ServingRow` that `release` read in its transaction;
  the in-memory registry is not read for who serves.
- **One process watcher.** `RunnerAuthority` owns the only process watcher, over Exiting and Retired
  records; it is the reconciler's cadence. When a process is confirmed gone (exited, pid reused,
  zombie) it emits `runnerGone(runnerId)` once. 32.4 keeps only failed liveness checks, which are
  ledger deadlines.
- **Deleted:** `entry.stopRetryable`, the `nextStopped` swap, `stop()`'s inline cleanup race,
  `killEntry`'s re-read, the recovery and `stopRegisteredRunners` copies of the kill sequence, the
  `settleExitedRuns` await on `entry.stopped`, `evict`'s own revoke cohort, and the authority's
  `ownedRunIds` as a source of what to settle.

<!-- src: STOP-INTENT S2, S3, S4, What is deleted; AUDIT A3; CONT C2 (feeder keeps the ordering against a stopping predecessor), C3 (Settle reads the journal); review 2026-10-28 (H4, H11); SETTLE S1, S2, S3, S5 -->

### 6.5 Which runner holds a run

- The hold (4.1) is the only durable answer to "which runner holds this run". Nothing copies it.
- The holder write fails if the runner has a retired row, so it and the Stop commit exclude each
  other (4.3).
- Today, and for each runner-held provider until its ledger ticket: at `Gone`, the reconciler
  settles every non-terminal run held by that runner, read in the settlement transaction. There is
  no cohort snapshot to drift.
- A run that moves to another runner gets its new holder only through a release and a new
  `run.dispatched` (4.3, 4.5). A run with no holder was never dispatched and is not the
  reconciler's.
- **Old rows.** Rows written by main or by an earlier phase carry `owned_run_ids`, and runs
  dispatched before the hold existed have no holder. For those rows only, the reconciler settles the
  union of `owned_run_ids` and the holder query, and runs with a commandless `run.dispatched` keep
  legacy recovery (4.1). New rows never write `owned_run_ids`. The fallback is deleted at 32.13.
- **`process_lost` is recorded with `retired_at` (decided OPEN-4, 2026-10-28).** In the ledger
  chain, the transaction that sets a runner's `retired_at` also records `process_lost{runnerId}`,
  which retires that runner (L1, 3.3). Settlement is decided once, in the commit that retires the
  runner, so it cannot be lost between retirement and `Gone`.
  - The process may still be running after that commit. It is fenced (6.2), so it accepts no new
    work; evidence it still sends is recorded and folds by 3.8, and never reopens a run.
  - Process cleanup (kill, reaper, discovery files) still waits for `Gone` and runs in the
    background (6.6, 7.1). Settlement does not wait for it.
  - **The switch is per provider.** 32.17 as built settles a retired runner's held runs at `Gone`
    (4.5, 7). 32.4 builds `process_lost` in the retirement commit for ledger-owned runs. Each
    runner-held provider's runs keep `Gone`-time settlement until its ledger ticket (Claude 32.6,
    Cursor 32.10, Codex 32.21), which moves them to the retirement commit and deletes `Gone`-time
    settlement for that provider in the same change. So each run has one settling writer at every
    point (section 2).
  - **After the switch,** the run is already Ended `process_lost` when Settle reads the journal at
    `Gone`. `Absent` (`JournalAbsent`) means the pending input never reached the agent, so it is
    re-sent on a new Run (3.9, 4.8). `finished` and `uncertain` (`delivery_indeterminate`) are late
    evidence (3.8): recorded where they change a join, never changing the Tombstone, and an
    uncertain input is never re-sent.
  - Rejected: recording `process_lost` when the process is confirmed gone (`runnerGone`), which
    matches the as-built reconciler but leaves a retired runner's runs open until the kill
    completes.

<!-- src: STOP-INTENT S5; CONT Data shape, C2, C3; AUDIT A1 (with the ledger), A3; SWAP failure mode 17; review 2026-10-28 (H4, H5) -->

### 6.6 The reaper and the kill routine

- **Runners outlive the daemon.** A daemon exit, crash or SIGKILL never signals a runner, its reaper
  or its Claude sessions; the next daemon reconnects. Nothing watches the daemon.
- **One reaper per current-build runner.** The host starts it at startup as its own child in the
  runner's process group P (the runner is spawned detached, so its pid is P). It is a small `/bin/sh`
  process. It ignores TERM, HUP and INT and watches only its parent: EOF on a pipe whose write end
  only the leader holds (opened close-on-exec), confirmed by its parent pid. When the leader exits for
  any reason, it sends TERM to group P, waits up to 3 s for every other member, then sends KILL to
  group P, which ends the reaper too. The hello reports the reaper's `{pid, startTime}`.
- A process group id cannot be reused while the group has a member. While a verified reaper or
  verified leader is alive in P, P is still this runner's group, and `-P` may be signalled.
- **Every runner kill signals the group**, after the identity check, never the leader's pid alone.
- **Snapshot.** At TERM, the group's members are snapshotted as `{pid, startTime}` with
  `ps -o pid,pgid,lstart`. While P is pinned, each pass adds P's current members to the snapshot and
  commits it before signalling. Once neither the leader nor the reaper is alive, the snapshot is
  final.
- **Escalation.** At escalation, KILL every snapshotted member whose `{pid, startTime}` still
  matches, whether or not the leader is alive. A member that no longer matches is skipped.
- **One kill routine** serves Stop escalation, the watcher and restart recovery. It takes the
  retirement record and returns the record to commit, then the signals to send.
- **H2. A kill is final.** A `kill_and_respawn` the ledger has issued is executed before its runner
  could be reattached. Its path is the effect interpreter's (9): it claims the kill, and the
  adapter's kill calls `requestStop` (6.3), which commits the retirement record before any signal.
  Restart recovery reads issued, unfinished kills from the Run Effects table and runs each instead
  of reattaching that runner. The ledger treats the runner as retired from the kill's issue (L1,
  3.3).
- A member is gone when its pid is gone, a zombie, or has a different start time. The runner is gone
  when every snapshotted member is gone; the reaper is a member, so a live reaper keeps the record
  open.
- An unverifiable process is never signalled.
- **Main-built runners** (no reaper in the hello) get the same write-ahead record and kill routine,
  with P pinned only by the verified leader. Selected by the hello capability alone; deleted at
  32.13.
- **Limits, not fixed:** a descendant that leaves group P (`setsid`, `setpgid`), a child forked
  after the last refresh once the reaper and leader are gone, and a process stuck in the kernel can
  outlive the kill. Retired and confirmed-dead stay separate.

<!-- src: REAPER R1, R2, R3, R4, R5, failure modes 10, 11; AUDIT A12; AUDIT-2 A13; D1 Runner manager (kill sequence); REDESIGN 2026-10-28 (02-options-and-pick.md) H2 -->

### 6.7 Survivors and the notice

- A stopped runner whose process is still alive after the escalation window is a survivor. The
  session does not wait for it: its runs settle through 6.5 and the next message starts a serving
  runner that resumes the same native conversation silently.
- **Retries at 10, 30 and 60 s**, identity-checked and logged. Gone, reused or zombie counts as
  exited: retries stop, no notice. Verified alive: the kill routine runs again. Unverifiable: never
  signalled. Either way the attempt count goes up. Each survivor has its own schedule. After the
  third failure and the notice, the watcher checks every 60 s.
- **After the third failure**, exactly one session-scoped `turn.notice` with no Run (the existing
  info banner), keyed by a deterministic notice event id:
  - signalled but not exited: "The previous run (pid P) was told to stop but hasn't exited yet. It
    can't change this session any more and will exit when the system releases it."
  - never signalled: "Conduit couldn't confirm pid P is the previous run, so it didn't stop it. It
    may still be running. Stop it manually if it is."
- The notice is skipped for deleted or archived sessions; retries still run. The banner stays if the
  survivor exits later.
- At restart a retired row restarts the schedule. A retired row with no registration is a survivor
  until its process is confirmed gone. A retired runner's spooled output is dropped before replay.
- A replacement that cannot start is the ordinary start refusal on the next message.
- **Removed:** `runner_quarantined`, its non-retryable send path, the "quarantined entry still owns
  the session" rule, the 11A "Couldn't retire the old runner safely" hold, its Retry and its refusal
  of sends.

<!-- src: BG Runner lifecycle §5; D1 Runner manager (survivor set, notice texts); AUDIT A3, A12; RA §4, §5 (no hold), §6; STOP-INTENT S3 -->

### 6.8 Pruning

- A retirement row is pruned only when the process is confirmed gone and the runner's runs are
  settled: today, every run the holder query (and, for old rows, `owned_run_ids`) returns is terminal;
  with the ledger, the loss evidence for its open work is committed.
- A dead row with unsettled runs stays until settlement succeeds.
- The row is pruned with the cursor row; the record leaves the authority's map.

<!-- src: AUDIT-2 A15; REAPER R4 (A15 unchanged); RA §4, §6; STOP-INTENT S2 (Settled), S5 -->

### 6.9 The serving runner and the swap

- **The database names the serving runner.** `claude_runner_cursors` gains `role`
  (`candidate` | `serving`, default `serving`) with a partial unique index on
  `session_id WHERE retired_at IS NULL AND role = 'serving'`.
- `register(runner, session, role)` runs once the runner's pid and start time are known, before
  warming. `serving(session)` is a cache of the row.
- The registration transaction refuses a new serving row while an unretired candidate exists
  without a serving row. It returns `Lost` and re-enters `holdRun`, which returns `Cleaning`;
  the unused spawned process is stopped. The check does not block a candidate warming alongside
  an existing serving runner. Request-stop commit owns its full in-transaction row/role and
  candidate snapshot recheck, including on retries; no stale outside snapshot decides retirement.
- **The runner's role inside the host** is one typed state, not persisted, with an unchanged wire:

  ```ts
  type RunnerRole = { _tag: "Serving" } | { _tag: "Reserved"; revision: string } | { _tag: "Candidate" };
  decideRunnerRole(role, Retire{revision, quiescent} | Cancel | Activate | Command | Hello)
  ```

  A hello turns Reserved into Serving. Activate, or any command but a shutdown, turns Candidate into
  Serving: only the serving row's runner is held a send (4.3), so such a command reaching a
  Candidate means its swap has committed, and `upgrade-activate` may arrive after it. Activate
  changes no other role.
- **A swap is prepare, one commit, promote.**
  - *Prepare:* the old runner takes `Reserved{revision}` only when quiescent (no turn, no background
    work, no held spool frames, no subagent finalizers). Reserved refuses no command; any command
    cancels the reservation. Every command bumps the activity counter under the lock.
  - *Commit*, under the lock after the re-check: `requestStop(old, Superseded{successor: R})`. One
    transaction checks that old is not retired, that no non-terminal run is held by old, and that R is
    a non-retired candidate. It retires old, sets R serving and records R's `process_started`
    after old's `process_lost` (6.1).
  - On failure or refusal: `upgrade-cancel` to old, stop R as `CandidateAbandoned`, mark the upgrade
    failed, back off.
  - *Promote* is the post-commit step of old's stop commit; it is not a second closer. Its memory
    part runs in the commit's cache step, after COMMIT and before the permit is released (3.1):
    revoke old, then make R's grant live (the commit has just checked R is not retired, AI4) and
    route the session to R. So no hold binds R while R's grant is starting (6.2), and AI3 holds
    throughout. The commit has checked that old holds no non-terminal run, so there is no release
    to requeue first. After the release: `upgrade-activate` to R, mark switched, and close old's
    entry scope as any stop does (6.11). Nothing is forked unawaited.
- A send that commits its hold before the swap commit makes the swap refuse; a swap that commits
  first means the send is held by R. A plain Stop that wins makes the swap refuse.
- `runner-upgrade.ts` owns no stop logic.
- **Restart:** a serving row is adopted (`upgrade-activate` first if the host is still Candidate),
  unless the ledger has an outstanding issued kill for it (H2, 6.6); a candidate row is stopped as
  `CandidateAbandoned`; a retired row goes to the reconciler.
- **Crash table:**

  | Crash during | Restart result |
  |---|---|
  | spawn, register, warm | old adopted, R stopped |
  | prepare | the hello clears Reserved; old adopted, R stopped |
  | commit | old retired, reconciler from Requested; R adopted, activated if Candidate |
  | promote | same as commit |
  | after promote | the reconciler stops old |

- **Migration:** add `role` (default `serving`) through the existing ALTER path. Before the index,
  backfill sessions with more than one non-retired row once, with the old ranking (registry role, then
  `newestRunnerFirst`; without a registry file, the newest row by sequence): the winner stays
  `serving` and the others become `candidate`, so `recover()` stops them. Then create the index. The
  daemon store import carries `role`.
- **Deleted:** the registry role as truth, the `newestRunnerFirst` role ranking (32.13), `preserveRole`,
  the daemon-side hello retiring reset. The registry keeps identity only; older runners' roles are
  ignored. "Two live registrations, the newer wins" is replaced by the serving row.
- Standalone shutdown after the manager is disposed is out of scope.
- **H1. One process.** A session has at most one serving process. A new process's `process_started`
  is reported only after its predecessor's `process_lost`, and before any of its frames (6.1): the
  serving index above, the swap commit records old's `process_lost` before R's `process_started`,
  the retiring commit records `process_lost` (6.5), and a candidate reports nothing (AI5, 6.2). OpenCode has one current server instance per session. The
  ledger relies on this (L1, 3.3).

<!-- src: SWAP S6, S7, S5 refined, J, K, M, crash table, Migration, What is deleted; RA §6; D1 Runner manager (restart); review 2026-10-28 (H11); SETTLE S3, S4, S5; REDESIGN 2026-10-28 (02-options-and-pick.md) H1, H2; REDESIGN review r3-1 (swap commit records process_started); REDESIGN review r3-2 (promote memory part in the commit cache step; a command activates a Candidate) -->

### 6.10 The runner lifecycle module

The module has eight calls:

```ts
register(runner, session, role: "serving" | "candidate"): Effect<"Registered" | "Lost", StoreFault>
requestStop(runner, reason: StopReason): Effect<"Requested" | "Ignored", StopFailed> // StopFailed only for Superseded or a decode rejection
holdRun(session, run, commandId): Effect<Hold, StoreFault>
release(run, runner, commandId, transmission, reason): Effect<void, StoreFault>
serving(session): RunnerId | undefined // a cache for routing a live caller; no write decision reads it
state(runner): RunnerStop
awaitStop(runner, "Escalated" | "Settled"): Effect<void>
recover(): Effect<Recovered>
```

- `StopFailed` is `runnerFailure("stop runner")`. A lost registration race and every hold answer are values.
  StoreFault distinguishes transient unavailability from the existing per-row rejection.
  Only unavailability retries.
- "Ending a session" is a request stop. The word "release" here means only 4.5's event.

<!-- src: SWAP K; CONT C2, C3, Deleted or changed (lifecycle module); SETTLE Data shape 1, S1, S3, S4, S5 -->

### 6.11 Teardown after revoke (decided OPEN-7, 2026-10-28)

- There is no cleanup grant and no `cleanup` write kind. `revoke` takes no cohort and returns
  nothing. From the tag flip (AI1) a revoked runner's writes are `evidence` (recorded, folded by
  3.8) or refused.
- **Memory teardown needs no authority.** Each runner entry has one scope. Its finalizers are the
  entry's waiters (ready, drained, the end latch, delivery and prompt waiters) and one more that
  closes only the send scopes still `Dispatched{this runner}`. Send scopes (4.2) stay children of
  the provider instance's scope, not of the entry, because a send outlives the runner it was
  dispatched to: a released send is re-held for a successor.
- **Who closes the entry scope:** the stop commit's post-commit step, together with `revoke` and
  after the release's requeue (4.5, 6.2), and daemon shutdown. A swap's promote is the old runner's
  stop commit's post-commit step and closes it the same way; only its revoke runs earlier, in the
  commit's cache step (6.9). The reconciler's Evict (6.4) only
  removes the map entry; it closes nothing.
- A finalizer touches only its own runner's resources and does no I/O on the runner socket, so it is
  safe at any label and runs whether or not the process ever answers. A finalizer still running
  after the bounded close is logged; it never blocks Settle.
- **Durable teardown has one owner per phase.** Today, and for each runner-held provider until its
  ledger ticket, the reconciler settles by the holder query at `Gone` (6.5). From that provider's
  ledger ticket (Claude 32.6, Cursor 32.10, Codex 32.21), `requestStop`'s retirement transaction
  ends its runs `process_lost` (6.5, OPEN-4), and the reconciler's Settle only records late
  evidence. `session-ended` is part of whichever of these settles, not a runner write.
- So process cleanup is invisible to the user: memory goes with the scope, runs are settled by the
  phase's one owner, and the process is killed in the background (6.6).
- Rejected: a cohort captured at `revoke` (revoke does no I/O, and the cohort copies what the hold
  answers, 6.5); a cleanup grant without a cohort (a write kind with no caller, for teardown that
  needs no permission); a time-bounded cleanup window (a timer with no write behind it).
- Deleted in 32.17: `CleanupGrant`, `CohortTarget`, `cleanupFor`, the 3 s expiry, the `cleanup` and
  `cancelled-cleanup` phases and the record's cleanup sub-state, the `cleanup` write kind and its
  policy column, and `revoke`'s cohort argument. The row's `owned_run_ids` fallback is unaffected and
  goes at 32.13 (6.5).

<!-- src: AUDIT-2 T1; RA §3 (I5); SEND-SCOPE S3; AUDIT A1; STOP-INTENT S5, What is deleted; OPEN-7 decision; review 2026-10-28 (H3, H4, H11, W2); REDESIGN review r3-2 (swap revoke) -->

## 7. Restart, adoption and Settle

### 7.1 What survives

- Runners, their reapers and their Claude sessions survive a daemon exit (6.6). Nothing durable is
  lost at a daemon crash: the hold, the retirement row, the runner's journal and its unacknowledged
  spool all stay.
- **Discovery is not evidence.** A runner's socket and registration file only find a live runner.
  Once full daemon shutdown confirms an owned runner `Gone`, it removes that runner's socket and
  registration and nothing else. The retirement row and the send journal stay for
  startup's Settle, so removing discovery files never changes a Settle outcome. A retired
  runner's unacknowledged spool stays on disk until Prune deletes it after Settle; nothing
  reads it (3.8, 6.7). A live runner's spool is replayed at adoption. A runner not confirmed
  `Gone` keeps its discovery files.

<!-- src: REAPER R1; CONT Restart, Discovery is not evidence; SETTLE Out of scope (retired spool) -->

### 7.2 `recover()`

At startup, in one recovery pass:

- **Rows.** A serving row is adopted live (6.9). A candidate row is stopped `CandidateAbandoned`. A
  retired row is the reconciler's, from the state its row and signal log give (6.4); its runner is
  never re-adopted, and its spool is dropped before replay.
- **Adoption.** Discovery adopts every registration through `adopt` (6.2). Adopting a runner that
  still holds runs appends nothing, checks no coverage and counts nothing toward the cap. It asks the
  runner for each held transmission's status from the hello: `received` or `running` is adopted;
  `not_received` is released `NotSent`; anything else stays held (the mapping to journal answers is
  in 4.9). `not_received` is final because the host answers a new connection's hello only after
  reading the previous connection to end of file. Before the provider switch, a `finished` answer with an actual
  terminal result/failure may also settle through Send Settlement (4.7, 4.9); missing and
  intake-only results do not settle. After the switch, only `not_received` writes at adoption;
  terminal evidence is replayed separately. An `uncertain` transmission stays held and only
  Settle writes its marker.
- **The feeder's scan** takes every owner send whose outbox row is `running` and whose run is
  non-terminal and unheld, and holds it again (4.4). A send has no live handle at restart; the feeder
  asks the provider instance to admit the durable send with origin `Adopted` (4.2). A released
  `ResumeRejected` transmission with unfinished fallback preparation resumes that preparation
  in fresh mode before enqueue, reconstructed from the release and existing durable fallback
  data. Ordinary unheld sends still enqueue as `Adopted`.
- **Held transmissions of exited runners** go to the reconciler's Settle; those of live runners go to
  adoption. `settleUnclaimedRunnerCommands` no longer settles held transmissions itself; it hands
  those of exited runners to Settle.
- **Legacy.** A run whose `run.dispatched` has no `commandId` keeps legacy recovery
  (`runner-legacy-recovery.ts`), never the feeder.
- A main-built runner (no journal answers in its hello) gets main's own recovery for its sends (7.4).
- The reactor re-sends nothing on its own, except, until 32.5, a joined steer it moved to
  `retryable_failed` (4.8). Replay callbacks and per-driver recovery replays are gone (4.8).

- **Stop restart backstops.** `Committing` is not durable. Restart re-derives an uncommitted
  Stop per source:

  | caller | restart backstop |
  |---|---|
  | upgrade candidate stop, register failure (`CandidateAbandoned`) | `recover` stops every unretired candidate row (`runner-retirement.ts:758-787`) |
  | idle exit, a dead process | `recover` stops a dead pid `Exited` |
  | failure cleanup, dead process | pid/start-time recovery requests `Exited`; failed attachment retries up to four times, then retires the survivor (`process-session-runner.ts:3973-4045`) |
  | durable end-session or explicit user Stop | reactor `prepareRecovery` resets uncompleted running controls to pending (`orchestration-side-effect-reactor.ts:344-363`, bounded by `maxControlAttempts`); their committed control/cohort is replayed. A control is not acknowledged before the retirement commit |
  | live runner after a recoverable transport failure; direct lifecycle Stop with no durable control | if restart reconnects successfully, it cannot recover an uncommitted transient intent. Main also has no such persisted intent. This bounded Q26 limitation is explicit; 32.4/32.6/32.8 own durable process-loss/control reconciliation, not a new R2 intent table |

  An already committed Stop is always recovered from its retirement row. A healthy live
  reattachment cannot recover an uncommitted direct Stop, as on main (Q26); 32.4/32.6/32.8 own
  durable process-loss/control reconciliation. End-session's deleted-session case additionally
  retains the exact runner's outstanding end command (`process-session-runner.ts:3835-3854`).

<!-- src: CONT C2 (Adoption is not a transmission), C3 (live handle), Restart, Required work 2; SWAP S7 (restart), K (recover); STOP-INTENT S1, S2; RA §4; SEND-SCOPE-4 S7; SEND-SCOPE-6 S10.1, S10.2; review 2026-10-28 (H6, H7, M6); SETTLE S1 (fallback restart), S2, S3 (restart backstops) -->

### 7.3 Settle for an exited runner

- Settle reads the journal first, typed `Absent | Present(state) | Unreadable` (4.5).
- `Absent`, with the process confirmed exited and a build that writes the journal before executing:
  release `JournalAbsent`; the feeder holds the send again.
- `Present`: settle from the journal answer (4.9).
- `Unreadable`, or a runner from an older build: `delivery_indeterminate`, never re-sent. Settle is
  the only writer of this marker for runner-held rows.
- Today, and for each runner-held provider until its ledger ticket: every non-terminal run the
  runner held is settled at `Gone` (6.5).
- From that provider's ledger ticket (Claude 32.6, Cursor 32.10, Codex 32.21), the run is already
  Ended `process_lost` in the retirement commit (6.5), so Settle settles no run. `Absent`
  (`JournalAbsent`) means the pending input is re-sent on a new Run (3.9, 4.8). `Present` answers
  and `delivery_indeterminate` are late evidence (3.8); an uncertain input is never re-sent.

<!-- src: CONT C1 (Delivery), C3 (JournalAbsent), Restart; STOP-INTENT S5; review 2026-10-28 (H4, H5) -->

### 7.4 Main-built runners

- A runner without the journal-answer capability gets main's own recovery for its sends: replay the
  same key, and main's journal returns the saved result, refuses an unfinished key as uncertain, or
  runs a send it never received. This meets the "no worse than main" bar.
- That path lives in one module, selected by the capability check alone. No other code reads legacy
  hello fields. The hello normalizer is deleted.
- A host that predates the refusal frame refuses with `command-reply{failure.code:
  "runner_idle_exit"}` (4.5). A host with no `querySeq` is refused new work by 32.5 (6.1). A host with
  no reaper uses the main-built kill path (6.6).
- Every main-built path is deleted at 32.13, once no main-built runner can still be alive.
- **The bar for runner work before the ledger:** no worse than main. Every Run Effect outcome beyond
  that belongs to the ledger chain.

<!-- src: SEND-SCOPE-6 S10.2; SEND-SCOPE-5 S8; CONT C3 (Refused); RA §2; REAPER R5 -->

## 8. Background work, wake Runs and goals

### 8.1 Ownership and provider support

- The Run Ledger owns foreground Runs (origin `input`), wake Runs (origin `wake`), background tasks,
  process facts (labels, 6.1), `anythingMayAct`, lost work, pending confirms and native commands.
  Native commands skip the inbox and are never held.
- The goal tracker owns the goal's condition, counters, confirmed status and pending action id only.
  Displayed phases (Pausing, Clearing, Resuming) are derived from the pending action. A failed action
  leaves the confirmed status showing.
- `SessionActivity` is a read-only view over both.
- Providers declare what they support. Claude and Codex report background tasks; OpenCode and Cursor
  report none. Pause exists only where it is native (Codex); the goal adapter declares
  `pause: boolean`. Goal adapters: Claude through `/goal` text; Codex through `thread/goal/set` and
  `thread/goal/clear`.
- **Deleted:** `background-liveness.ts`; the ambient filter; the composer's Pause mapped to Stop and
  Resume mapped to "Continue."; the busy-slash hold (`interruptForInput`); main's Codex
  `parseCodexGoalCommand` and Stop pausing the goal; the idle-Stop goal-pause stopgap.

<!-- src: BG Decision 1; RA §8 (32.26, 32.27); AUDIT-2 T4 -->

### 8.2 Evidence and effects

```ts
// Evidence additions
| { kind: "tasks_snapshot"; tasks: readonly { key: TaskKey; taskType: string; subagentType?: string;
                                               description: string; ambient: boolean }[] }
| { kind: "task_event"; key: TaskKey; event: "started" | "completed" | "failed" | "killed" | "notification" }
| { kind: "turn_started"; wakeTask?: TaskKey }
| { kind: "command_lifecycle"; commandId: string; state: "queued" | "started" | "completed" | "cancelled" }
| { kind: "command_result"; commandId: string }
// Settlement additions
| { kind: "process_started"; label: Label; reattached: boolean }
// Control additions
| { kind: "stop_tasks"; tasks: "all" | readonly TaskKey[] }
| { kind: "confirm_escalation"; snapshotEntry: number }
| { kind: "native_command"; commandId: string; text: string }
// Effect additions
| { kind: "stop_task"; key: TaskKey }
| { kind: "send_native_command"; commandId: string; text: string }
type TaskKey = { taskId: string; runId?: string };
type Tasks = { tag: "Unknown"; label: Label }
           | { tag: "Known"; label: Label; tasks: ReadonlyMap<TaskKey, Task> };
type NativeCommand = Sent | Queued | Started | Unconfirmed | Completed | Cancelled | Failed;
```

- Task kind comes from `task_type`: `local_bash` is shell, `local_agent` is subagent,
  `local_workflow` is workflow, `monitor`, `mcp_task`; others verbatim. A task is **monitoring** if it
  is ambient or a monitor, otherwise **work**.
- A runner event either answers a Send Token or is an unsolicited observation naming only the host
  label: background snapshots and task events, a turn start with no active Run, process events, and
  `activity`, `result`, `query_ended` for a wake Run (8.3). No fictitious send is minted.
- Codex's snapshot is `thread/backgroundTerminals/list`, re-read on turn completion, terminal command
  start or finish, after a stop, and on reconnect. Late command events only update the snapshot
  (terminated is failed, exit -1).
- Native commands are opaque. A zero-turn result correlated by input UUID (`user_message_uuid(s)`)
  completes the command and never starts or ends a Run. Only the waiting variants of
  `NativeCommand` carry a deadline. A late reply moves `Unconfirmed` to `Completed`.
- Native `run_id` order is unproven: use arrival order, or cite evidence that it sorts by time.

<!-- src: BG Decision 2; AUDIT A11; AUDIT-2 T5, T6, T7, Other changes (run_id); RA §7 (label replaces generation); model-gaps 2026-10-28 -->

### 8.3 Task certainty and wake Runs

- A fresh launch has no tasks (`Known`, empty). A reattach is `Unknown` until the catch-up snapshot,
  and stays `Unknown` for a CLI declared not to send snapshots. A provider that reports no
  background tasks (OpenCode, Cursor, 8.1) is `Known`, empty, for every label, reattach included.
  An empty `Known` derives no tasks.
- The runner host keeps the latest snapshot even when empty, with its label, and replays it after
  the backlog on every attach.
- The host's idle check uses the same reducer, and resets to `Unknown` when the query is replaced.
  Host idle is `Open{commands} | Draining{tokens} | Exiting`; sets keyed by command or token replace
  the turns counter, and the host's task and idle caches are invalidated on query replacement.
- Snapshots replace the set, and so does a `process_started` settlement; an effect's outcome (a
  `close` or `end_session` success) never does. Per-task events only name lost work, show outcomes and identify the
  waking task. A task is gone only when a later snapshot omits it.
- Older-label evidence follows L1.4 (3.4): recorded only where it changes a join, never authority,
  liveness or a wake Run.
- **Wake Runs.** A `turn_started` with no active Run records a wake Run as Launched, with no start
  effect. Its waking task is the one notified just before. With an active Run it joins that Run.
  Admission steers into an active user Run but queues behind a wake Run.
- Unsolicited `activity`, `result`, `query_ended` apply only to a wake Run whose execution label
  equals the observation's label; otherwise they are recorded with a diagnostic and no change.
  A matching wake Run completes by its provider's Run-end policy (3.6, 9), including Codex's result
  policy. No fictitious token is minted.
- An unsolicited `turn_started` names no send, so the execution it starts is outstanding work in
  its own right (D47), whether it records a wake Run or joins an active Run: no send's chains can
  end it, so a joined Run's start being NotConsumed (declined or absent) ends the Run but not this
  execution. From
  `turn_started` until its runner retires (L1) or its provider's Run-end evidence for that label
  is recorded, `anythingMayAct` is true, whether or not the Run has Ended (by its start NotConsumed, deadline,
  `project_inactive` or `session_ended`). Run-end evidence clears this liveness even without
  authority; it changes Run state only with authority (3.4). Below, "wake execution" means any
  such unsolicited execution, joined or not. An outstanding wake execution also holds
  the native-session fence (section 9) until session end, so admission after its Run has Ended
  waits for it as it would behind a user Run's retained start (D18). A `turn_started` that joins a wake
  Run under another label adds a wake execution for that label: every execution label of a wake
  Run is outstanding work and a fence member by these rules, each cleared by its own Run-end
  evidence or its runner's retirement (and, for membership only, session end). Run-end evidence
  for an older execution label clears only that execution; the Run ends by its latest execution
  label's evidence (3.4). The deadline stop
  sequence acts on the wake Run's first execution label; once the Run has Ended, the Tombstone
  cleanup expiry runs the provider's fence-expiry column against every execution label still a
  member (D28). A wake Run's deadline expiry runs
  its provider's stop sequence against it (Claude and Codex `close`, Cursor `kill_and_respawn`,
  OpenCode `probe native_session`), confirm-gated as in 8.4. While the project is inactive it
  issues nothing, and `project_active` reconciliation settles it, acting on every execution label
  still a member as the Tombstone cleanup expiry does (D29). `turn_started` with no active
  Run records a wake Run even while the project is inactive (LI9); having no authority, it
  issues no effect.
- **`anythingMayAct`** is true for a non-ended Run, a send that may still act (a probe only reads,
  so it never may act, D31), or tasks live or
  unknown. Tasks never block a new Run. Every liveness reader asks it: the worktree cleanup sweep,
  archive and delete `hasLiveWork`, the status poller's idle corrections, and the runner record
  deletion. The physical-process file guard stays.

<!-- src: BG Decision 3; AUDIT A9; AUDIT-2 T6, T11, A20, Other changes (wake admission); OW Decision 3; model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L1; REDESIGN review r2-1; REDESIGN oracle r8 -->

### 8.4 Stop tasks, the confirm gate and lost work

- **Tasks are read per runner.** `LedgerView.tasks`, `anythingMayAct`'s task term and
  `stop_tasks` `"all"` read the snapshot under the current process's latest label; with no current
  process there are none. A newer `querySeq` has no snapshot until its first one, so its tasks are
  unknown for a provider that reports tasks: the host drops its task cache on query replacement
  (8.3). `"all"` means its live tasks. It is rejected, issuing nothing, when tasks are unknown or
  none, or when the provider has none. `stop_task` runs through the SDK's
  `stopTask(taskId)` or Codex `thread/backgroundTerminals/terminate(processId)`. A failed stop is a
  diagnostic, with no retries.
- **Confirm gate (L3).** A destructive step (an ignored interrupt, restart, kill, end-session, an
  ignored interrupt while paused) with tasks live or unknown waits with a pending confirm. The
  interrupt deadline never destroys on its own. A confirm must match the latest snapshot; a stale
  confirm is rejected. With no snapshot the UI says "background state unknown" and always asks.
  The gate stores its step, never its addresses, tasks or `snapshotEntry`. It reads the same tasks as above: by H1 a step's
  address now is the current process, pending or a runner not started (no tasks), or retired. A
  confirm releases it, and so does any decision after which those tasks are neither live nor
  unknown: a snapshot, a `process_started`, or the current process retiring. The step is addressed by L2 when it issues,
  so every release issues the same effects: released by the current process retiring, a Run-less
  `end_session` goes to pending (L2 case 3, D32). Everything the step decides, such as ending its
  Run Interrupted forced (5.1), happens when it issues, not when it is gated. A step that belongs
  to a Run is dropped when that Run Ends by other evidence (D43); `end` then continues to its
  `end_session` step. A step whose every address is retired issues nothing:
  its sends were covered at retirement. A step that destroys several member labels (Tombstone
  cleanup expiry, `project_active` reconciliation) waits on one confirm. `PendingConfirm`'s labels,
  tasks and `snapshotEntry` are views of now.
- `snapshotEntry` is the 1-based count of changes to what the task view reads (D45): `tasks_snapshot`
  evidence, `process_started` settlements, and the decision that raises the current process's
  latest `querySeq` (a query replacement, after which tasks are unknown), excluding older labels.
  Any of them that leaves a pending confirm open refreshes `snapshotEntry` only (D3), so a
  confirm copied before it is stale. Callers copy it from `pendingConfirm`, never compute it.
- With an active Run, `end` runs the stop sequence, then issues `end_session` once the Run is
  Ended or its interrupt deadline expired. Both steps are confirm-gated with tasks live or
  unknown. With no Run, `end` issues `end_session{runId: null}`; its deadline belongs to the
  send. When that deadline expires unconfirmed, the ledger issues `kill_and_respawn{runId: null}`,
  confirm-gated with tasks live or unknown and addressed by L2 (3.3): where the `end_session` went,
  or pending when it went to pending. Only runner-held providers escalate; OpenCode has no runner
  to kill (5.1).
- **Lost work (L5).** Each label is decided once, in the decision that first ends its scope: a
  `close` issued for its query (at issue, for its execution label), the label becoming older (a
  newer `querySeq` of its runner, or its runner's retirement, L1 item 4; D44), or `session_ended`
  (for the current process's latest label). That
  decision records the live tasks of the label's latest snapshot; "may have been lost" when the
  label has no snapshot or its tasks are unknown; and nothing when they are `Known` with none live
  (a fresh launch, and every Cursor and OpenCode label, 8.3). A destruction addressed to pending
  records nothing.
- A process that dies before confirming a native command: the tracker reloads from the transcript and
  re-sends first on the next launch, only if the confirmed status does not already match.

<!-- src: BG Decision 2, Decision 3, Decision 4; AUDIT Already covered (32.8 defers to 32.25); AUDIT A4 (recovery); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L2, L3, L5; REDESIGN review r1-1 (03-rewrite-gap-decisions.md); REDESIGN review r1-2; REDESIGN review r2-1; REDESIGN review r2-2 (L5 Known empty); REDESIGN review r3-1 (runner not started); REDESIGN oracle r8 (D43); REDESIGN harness r9 (D44) -->

### 8.5 Native command issue

- **A native command is a session send (L4).** L2 case 3 addresses it: to the current process, or
  to pending when there is none. The ledger never waits for `process_started`; the feeder spawns
  for it (H3, 4.4). It issues in the decision that admits it, after already-issued sends and ahead
  of queued inputs, so issue order alone puts it first and its confirmation never holds back a
  start.
- **D17.** A sent command under project inactive follows 3.11. One admitted while the project is
  inactive is recorded and issued in the `project_active` decision, after that decision's
  reconciliation probes and ahead of any start or steer.
- **Its view is a projection of its send:** `Sent` while unfinished; `Queued`, `Started`,
  `Completed` or `Cancelled` from receipts; `Unconfirmed` when its deadline fires; `Failed` with
  the covering cause (`process_lost`, `kill_and_respawn` or `session_ended`) when covered; `Failed`
  with the outcome's code on a permanent `effect_outcome`, which also finishes the send (3.4). The
  deadline starts at issue and drives only the view. A deferred command is an unissued send:
  session end covers it, so it is `Failed{session_ended}` and never issued.
- The provider may report it queued ("queued by Claude"). The deadline does not run while the
  provider reports it queued. When it fires, the tracker re-reads native state (Claude's
  transcript, Codex's `thread/goal/get`), with no authority needed, and shows "Clear not confirmed"
  or "Pause not confirmed" with Retry. The tracker runs no timer.

<!-- src: BG Decision 3; AUDIT A4; AUDIT-2 T5; REDESIGN 2026-10-28 (02-options-and-pick.md) L4; REDESIGN review r2-1 -->

### 8.6 Goals

- **Tracker state.** `Confirmed = Active | Paused | Limited | Met | Cleared`;
  `Pending = None | { tag: "Pending"; id: CommandId }`; `confirm(goal, orderedObservation)`.
- **Ordering.** At most one pending action. A new action supersedes it. Only a reply correlated to the
  current pending id (Claude: input UUID; Codex: request id) clears it. Native status reads always
  update the confirmed status. Every native read carries an order (transcript byte offset, or native
  revision) and is applied only if newer than the last applied. Recovery compares the condition as
  well as the status: `Active(A)` does not confirm `Set(B)`.
- **Actions:** set, pause, resume, clear. Browser actions: StopTasks, ConfirmEscalation, PauseGoal,
  ResumeGoal, ClearGoal, SetGoal. CancelSession stays Stop.
- **Codex.** Statuses `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete`; use
  the returned status; `blocked`, `usageLimited` and `budgetLimited` show as Limited. Budgets are
  positive and Codex may overshoot. Pause goes Pausing then Paused, with no continuation. Clear goes
  to Cleared. An interrupt leaves the goal active. Resume sends status `active` only; an idle Codex
  then self-starts a wake Run. The goal persists across restart. Wording with Stop: "Goal paused.
  Codex is finishing its current turn." and "Goal cleared. Codex is finishing its current turn."
- **Claude.** Inputs: the `local_command_run{command: "goal"}` reply (`Goal set:`, `Goal cleared:`,
  `No goal set`), the zero-turn result, transcript `system/local_command` and `goal_status`, and
  delivery state. `active_goal` is not an input. Set starts a wake Run. Clear shows Clearing. A
  mid-turn clear is queued by Claude until the turn's result (42 to 90 s, ended only by `maxTurns`;
  conduit does not shorten it) and shows "Clearing after this turn (queued by Claude)"; the note goes
  when the turn ends. Stop interrupts and then the clear runs. An interrupt alone does not clear.
  `priority: "now"` is rejected. An idle clear completes at once. Cleared only on `Goal cleared:`
  plus the zero-turn result, or the transcript record. The same rule applies to OpenCode and Cursor
  if they gain goals.
- Goal flow is separate from Stop. Stop never pauses a goal.

<!-- src: BG Decision 1, Decision 2, Decision 3; RA §8 (32.26, 32.27); AUDIT A4; AUDIT-2 A17, T4 -->

## 9. Providers

| Provider | Path | Run end | Background tasks | Goals | Stop |
|---|---|---|---|---|---|
| Claude | runner host (Claude Agent SDK) | result naming the send's input uuid | yes | `/goal` text, no pause | 5.1, kill and respawn |
| Codex | runner host (Codex app server inside it) | result | yes (`backgroundTerminals`) | `thread/goal/*`, pause | 5.1; interrupt leaves the goal active |
| Cursor | runner host (`makeRunnerProviderInstance`, Cursor driver; ledger switch 32.10) | result | none | none | 5.1, kill and respawn |
| OpenCode | SDK/API client, direct (4.10) | `query_ended` | none | none | cancel, native abort, fence until a probe confirms idle |

- **Effect interpreter.** It claims a Run Effect, calls the provider adapter, and reports the outcome
  through `observe`. It contains no lifecycle decisions. Outcomes: retryable (backoff), permanent
  (typed reason), delivery unknown (never re-sent blindly; the decider probes).
- **OpenCode adapter.** Prompt message ids become Run Inputs; busy and idle and message events go to
  `observe`; a project that returns reconciles from what OpenCode reports. It is the process
  reporter for the session's one server instance (H1, 6.9), to every session bound to it. The
  label is `<promptProcessId>:0`: the instance's existing `promptProcessId`,
  `openCodePromptProcessId(instanceId, identity)` (the id the control path already checks), as
  `runnerId`, with `querySeq` 0. For a managed instance `identity` is the per-spawn token the
  daemon persists in `ManagedOpenCodeRecord.processIdentity.token`, so `restartInstance` (same
  instance id, new process) gets a new id, and a daemon restart that reuses the running server
  (`canReuseManagedOpenCode`) keeps it and reports `reattached` true. For an unmanaged instance
  (a configured URL) `identity` is the URL. No second id is stored. `process_started` is reported when a session binds the
  instance, or when a daemon restart reattaches it; `process_lost` when conduit stops or replaces
  that process (a URL change replaces it), or its supervisor reports it gone. A failed health
  check alone is not loss. An unmanaged server exposes no process token, so conduit cannot see
  it restart: its id stays live, and work the restart dropped ends only by OpenCode's work-ended
  rule (`query_ended`, or a covering idle probe, D26). L1 and `hasAuthority` read these as for
  any runner; without them no OpenCode execution has a live runner.
- **Runner protocol (32.5).** Runners from older builds are refused new work and their turns are
  settled, using the 82tn.31 compatibility pattern; the protocol version is bumped, together with
  `querySeq` on frames and hello (32.19). The host journal stays as the duplicate check (4.9). 82tn.31
  compatibility is removed once every registration shows the new build.
- **Decided (OPEN-5, 2026-10-28): the Send Token is the only send identity on the runner wire;
  the run id travels only as a coverage label.** From 32.5's protocol bump:
  - `send-turn` (start or steer) carries an opaque string `token` (4.11), `runId` and the start's
    `mode` (`resume` or `fresh`). `sinkId` carries the token, never a parsed codec. There is no outbox `attempt`,
    no fallback marker in any key and no input id used for identity: a fresh-prepare fallback is
    transmission `n + 1` (4.8).
  - Every frame that answers a send (`command-accepted`, `command-refused`, `command-reply`,
    `command-status`, the hello's journal answers) names its token only. `settled-commands` lists
    exact tokens; there is no "highest attempt seen".
  - The host uses `runId` for one thing: membership in its interrupted set (4.6). It never keys
    dedup, the journal or an answer by it, and never compares run ids for order. The binding from
    token to run is immutable (`run.dispatched`), so the host's copy cannot drift.
  - `interrupt_turn` names the covered runs and wake labels and no input ids (4.6). A late
    interrupt never stops a newer turn.
  - Events that answer no send are unsolicited and name only the host label (3.4). `querySeq` rides
    the same bump (32.19). Runners from older builds are refused new work and their turns settled
    (82tn.31 pattern); their attempt-keyed journal answers read as `Unreadable`, never `Absent`.
  - Rejected: interrupts naming tokens (the Stop must list every live transmission of a covered run,
    and one missed token lets a late frame start a turn after Stop); the as-built outbox attempt with
    highest-attempt acks (two counts of one transmission, OPEN-2); input-id targeting (reusable ids);
    one ordered socket writer instead of a host record (a timing guarantee spread across daemon
    fibers); a Stop epoch (A.8 D).
- **Decided (82tn.32.2.14, 2026-10-28): native-session fence membership and idle proof.**
  Members are sends, never admissions. A member leaves the fence by NotConsumed, its coverage
  (L1, L2, 3.3), or its own work ended (3.5). Where `resultReleasesFence` is no, work ended by a
  result does not release membership; that member leaves at its label's `query_ended` or its
  coverage. A member held only by this rule has one cleanup obligation, its
  Run's Tombstone cleanup (3.8: the Tombstone time plus `settleMs`), and its expiry runs the
  provider's fence-expiry column. A wake execution is a member from `turn_started`, as a
  delivered start send of its execution would be: it leaves by its provider's work-ended rule for
  its label (with `resultReleasesFence` applied), its runner's retirement, or session end. Once its
  wake Run has Ended, its cleanup obligation is that Run's Tombstone cleanup, and expiry runs the
  provider's fence-expiry column, confirm-gated as in 8.4 (D18). Interactions, answers and
  background tasks are never members
  (8.3).

  | Provider | Members | Work ended | `resultReleasesFence` | Idle proof | Fence expiry |
  |---|---|---|---|---|---|
  | Claude | start, steer | a result naming the send's input uuid; `command_lifecycle` cancelled before started (NotConsumed); journal `absent` with no acceptance | no | none | close, then `kill_and_respawn` |
  | Codex (32.2.13) | start, steer | the runner's result, held back across a goal chain until the goal ends or the successor deadline expires | yes | none; `thread/status` idle is not proof | stop sequence |
  | Cursor | start, steer | the native `wait()` result | yes | none | `kill_and_respawn` |
  | OpenCode | start, steer, `cancel_request`, abort | `query_ended`, then a covering probe (a trusted covering idle probe alone is work ended, 3.5; D26) | no | `probe native_session` returning `native_idle`; omission from `session.statuses` counts only after `session.get` confirms the identity; `retry` is busy | probe |

  - Claude's `command_lifecycle` for a held start or steer is an Answer naming that
    transmission's token. `cancelled` before any `started` is NotConsumed for that
    transmission; after `started` it is Observed and ends nothing. Its `commandId` must equal
    the hold's. A `command_lifecycle` or `command_result` answer whose `commandId` differs from
    its send's (the hold's for a held start or steer, the effect's for `send_native_command`) is
    Rejected, a diagnostic, no state change (3.4), whether or not the send is retired (D21).

  - An OpenCode idle probe covers only sends issued before it whose delivery the native
    user-message echo or a native result naming the send confirmed. Abort is session-wide, so
    an abort whose delivery is unknown stays a member until a probe issued after its cleanup
    deadline returns `native_idle`.
  - A Claude result ends only the inputs it names. An input still queued after it, or listed in an
    interrupt's `still_queued`, stays a member. `query_ended` does not end Claude work; journal
    `finished` is consumption proof only (4.11). `resultReleasesFence` stays no.
  - A Cursor result releases the fence because `wait()` is the only native terminal and settles
    every pending steer. The runner's interrupt-timeout abandonment is not a result: intake records
    it as the Run's outcome (interrupted, forced), and the fence waits for runner retirement to
    cover the label. The runner marks that terminal as abandoned on the wire.
  - Codex's runner withholds its result while a goal successor may start, so a native idle between
    goal turns never reaches the ledger. A successor that starts after the deadline is a wake Run
    (8.3).
  - Open, needs a live check before the owning switch ticket lands: Claude `session_state_changed`
    emission and `still_queued` follow-up; a Cursor steer delivered after `wait()` settles; whether
    killing the Cursor runner stops an abandoned local run; Codex `turn/start` while a goal
    successor is pending; OpenCode `prompt_async`/abort executing after the client request ended.
  - **Decided (model-gaps, 2026-10-28):** `input_absent` after `delivery_unknown` is final for that
    transmission, unless 32.2.14's live check finds late execution; then OpenCode requires
    `native_idle`.
  - Rejected: membership per admission (R5: a refusal releases while a sibling acts); Claude
    releasing on a result (queued inputs run after a result that does not name them); Claude
    releasing on `session_state_changed` (not consumed or recorded; it can be adopted later); a
    Cursor idle probe (none exists, and `wait()` already settles); Codex `thread/status` idle (a goal
    successor self-starts after it); OpenCode idle covering unconfirmed sends (a request in flight
    joins the loop after the sample); counting the abandoned Cursor terminal as a result (the native
    run may still act).
<!-- src: 82tn.32.2.14; OW Decision 2; FB §4 (idle covers confirmed delivery); claude-sdk-traces steer-misses-boundary, queued-input-promoted-to-steer; cursor-sdk-traces steer, steer-shell, cancel; codex-app-server-traces goal-chain, steer-race; opencode-wire-traces classic-prompt-during-tool; model-gaps 2026-10-28; REDESIGN review r1-2 -->
- **Decided (OPEN-6, 2026-10-28): Codex is a ledger provider, runner-held.** Codex runs in the
  runner host like Claude and Cursor (`makeRunnerProviderInstance` with the Codex runner driver), so
  its sends take the hold, the feeder, the journal, the reaper and the swap (4, 6, 7) unchanged, and
  a daemon exit never ends a Codex session. Its provider policy (32.2.13): `result` ends a Run;
  interrupt leaves a goal active; a `turn_started` that matches no pending host turn request is a
  wake Run (Codex sends no continuation marker); background terminals are tasks; command events
  after a turn ends update the snapshot only and never reopen a Run. Turn routing of app-server
  notifications stays inside the Codex payload, which emits the same typed observations as the
  other payloads. Every per-provider table is exhaustive for Codex. Rejected: keeping Codex run
  state outside the ledger (a second owner; 32.13's empty allowlist fails); Codex as a direct
  provider (a daemon exit would end its sessions); Claude's policy with capability flags (Codex's
  goal, interrupt and wake rules differ).

<!-- src: SPEC Implementation Decisions (Effect interpreter, Runner protocol, OpenCode adapter), Further Notes (82tn.31 compatibility); RA §2, §8, §9 (R4); CONT C3 (host's interrupt refusal), Required work 3; FB §5; OW Decision 5; BG Decision 1, 2, 5; D1 (OpenCode unaffected); review 2026-10-28 (M1, M2); model-gaps 2026-10-28; REDESIGN review r2-1 (OpenCode process id); REDESIGN review r2-2 (process id is promptProcessId; unmanaged restart) -->

## 10. Failure-mode catalogue

Every mode below must be handled. Old ids are mapped in Appendix B. The 116-case Run Ledger
catalogue (`docs/plans/2026-10-22-run-ledger-failure-catalogue.md`, ids RL-n) stands beside it for
the ledger chain.

<!-- src: SPEC Testing Decisions (failure catalogue); RL catalogue 2026-10-22 -->

### 10.1 Processes (F1 to F11)

- F1. The daemon is killed at any point: runner, reaper and Claude sessions keep running; the next
  daemon reconnects and the session continues.
- F2. The leader ignores TERM; a descendant ignores TERM.
- F3. The leader exits before escalation while a descendant ignores TERM.
- F4. TERM refused; first KILL refused; signalling later works.
- F5. The daemon crashes between the record's commit and TERM, during the grace, and after KILL.
- F6. The reaper is killed first (by a user or the OS), then the leader stops.
- F7. The leader crashes on its own with no Stop: the reaper clears the group; the daemon later finds
  every member gone and prunes (6.8).
- F8. A pid in the snapshot is reused by an unrelated process: never signalled.
- F9. A malformed record: rejected per row and logged; other rows recover.
- F10. A child forked after the last refresh, after the reaper and leader are gone: the known limit,
  not fixed.
- F11. A descendant that leaves group P (`setsid`, `setpgid`): neither the reaper nor the snapshot
  reaches it. Not fixed.

<!-- src: REAPER failure modes 1-11 -->

### 10.2 Stop intent (F12 to F21)

- F12. The Stop commit fails with a store fault: nothing durable changes, the runner keeps
  serving, the reconciler retries the commit, and the waiters see the commit when it lands. For
  `Superseded`, request stop fails with "stop runner" and the upgrade retries.
- F13. This runner's row is rejected on decode: request stop fails, no shutdown, no signal, logged.
- F14. The daemon crashes after the commit and before shutdown: the next daemon does not adopt the
  runner as live; the reconciler continues from `Requested`.
- F15. A write after the commit fails (signal log, Gone, settlement, prune): the row stays, the
  reconciler retries, no waiter fails.
- F16. A send races the Stop commit: it is either held by the runner and settled at `Gone`, or refused
  before the runner sees it. Never settled twice, never stranded. Ledger chain: a held send's run is
  Ended `process_lost` in the retirement commit (6.5); its pending input is re-sent on a new Run
  (3.9, 4.8), delivered once; a late runner answer is late evidence (3.8).
- F17. Two Stops race, or a Stop arrives during `Committing`: one commit, both callers see the same
  outcome.
- F18. The runner exits on its own while Stop is `Committing`: the commit still lands; the reconciler
  sees every member gone and settles.
- F19. An unverifiable leader: never signalled; `Escalated` is reached when the window ends; the
  watcher continues with the notice.
- F20. A run handed off to another runner before the first runner stops: it carries the new holder,
  and the first runner's reconciler leaves it alone.
- F21. An old row with `owned_run_ids` and a run with no holder: settled through the fallback.

<!-- src: STOP-INTENT failure modes 1-10; review 2026-10-28 (H5); SETTLE S3 -->

### 10.3 Swap (F22 to F29)

- F22. The swap commit fails: nothing changes, `upgrade-cancel`, R stopped, upgrade failed with
  backoff.
- F23. A send lands before the commit: the swap is refused, the send runs on the old runner, the
  upgrade retries at the next turn end.
- F24. A send lands after the commit, before activate: R holds it, and the command reaches R only
  after `upgrade-activate` (dispatch writes under the lock promote holds). After a crash, adoption
  activates R before replay.
- F25. A plain Stop races the swap: one commit wins, the other fails cleanly; never two serving rows.
- F26. A command that holds no run reaches the old runner after prepare: its activity bump makes the
  re-check cancel the swap. Every command path must bump the counter.
- F27. `upgrade-cancel` is lost because the old runner disconnected: its hello clears Reserved; if it
  never reconnects, the liveness watcher stops it with reason `Exited`.
- F28. R dies after the commit: stopped `Exited`; the session has no serving runner and the next send
  spawns one. Anything R held settles at `Gone`. Ledger chain: R's runs are Ended `process_lost` in
  the retirement commit (6.5); pending input is re-sent on a new Run (3.9, 4.8), delivered once; a
  late answer from R's journal is late evidence (3.8).
- F29. A runner on an older build: the wire is unchanged, its registry role is ignored, `preserveRole`
  is no longer sent, and a Reserved old-build runner clears on hello.

<!-- src: SWAP failure modes 11-18; review 2026-10-28 (H5) -->

### 10.4 Send continuation (F30 to F56)

- F30. A send waits while its runner exits idle: refused `exiting`, released, runner stopped `Idle`,
  `Unserved`, new runner, held, delivered once. Ledger chain: the run is already Ended `process_lost` in the retirement commit (6.5); the
  pending input is re-sent on a new Run (3.9, 4.8), delivered once; a late answer is late evidence
  (3.8).
- F31. A plain Stop refusal on a runner the user stopped: released, `Covered`, settled "Stopped before
  delivery", no new runner.
- F32. Idle exit and a winning EndSession race: `Covered` wins whatever the runner's idle flag.
- F33. A waiting send during admission after a winning Stop: `Covered`, no successor.
- F34. A send after the Stop (not in the cohort): held on a new runner, delivered once.
- F35. A send waits while Stop is being accepted: it cannot fall between; Stop is one commit.
- F36. The live release and the reconciler's release race: one clears the hold, the other is a no-op.
- F37. Daemon SIGKILL with an unheld running owner send: restart feeds it to the feeder; delivered
  once or `Covered`.
- F38. The runner received the send, then died: `delivery_indeterminate`, settled, never re-sent.
- F39. The journal is unreadable or corrupt, or the runner is an older build: indeterminate, never
  re-sent.
- F40. A runner retires itself after an abandoned run while a send waits: refused `retiring`,
  released, the runner stopped, the send delivered once on a new runner. Ledger chain: the run is already Ended `process_lost` in the retirement commit (6.5);
  the pending input is re-sent on a new Run (3.9, 4.8), delivered once; a late answer is late
  evidence (3.8).
- F41. Repeated daemon restarts during one long turn: adoption appends nothing; never `Exhausted`.
- F42. Every new runner refuses: the fifth transmission's refusal ends `Exhausted`, one `turn.error`.
- F43. A projection rebuild after a release: the run is unheld, as before the rebuild.
- F44. A send recommitted after a Stop: `stopCovers` reads the cohort, not outbox order.
- F45. Daemon SIGKILL with a transmission unread in a live runner's socket: the runner is adopted and
  executes it once; nothing re-sends it.
- F46. A covered transmission bound before the Stop reaches the host after its `interrupt_turn`:
  refused `interrupted`, released, settled "Stopped before delivery"; the agent never starts it.
  Current-build runners only; an older runner keeps the earlier behaviour.
- F47. A refusal while the refusing runner's retirement cleanup is pending: the send's handle survives
  and the send is delivered on the next runner.
- F48. Native resume rejected: released `ResumeRejected`, the fresh fallback transmitted once through
  `holdRun`.
- F49. A legacy holderless dispatched run at restart: legacy recovery, never the feeder.
- F50. A send retried onto a fresh run after a retryable failure: its transmission count carries
  over, and re-sends after retryable provider failures count toward the cap.
- F51. A live daemon, a held send, the runner exits before reading it: the reconciler releases it
  `JournalAbsent`, the feeder holds it on a new runner, delivered once, no restart needed. Ledger
  chain: the run is already Ended `process_lost` in the retirement commit (6.5); `JournalAbsent` means the pending input is re-sent on a
  new Run (3.9, 4.8), delivered once; a late answer is late evidence (3.8).
- F52. The runner announces idle exit, then a send reaches the pre-write check: `NotSent`, released,
  delivered once on a new runner.
- F53. An older-build runner refuses with `command-reply runner_idle_exit` before
  `command-accepted`: `Refused{exiting}`, delivered once on a new runner.
- F54. Daemon SIGKILL between the hold commit and the write, runner alive: adoption's hello reports
  `not_received`, released `NotSent`, delivered once.
- F55. Stop accepted twice with the same command id after the cohort changed: the replay returns the
  stored payload; no second control row.
- F56. Two continuation sends share a cut-off message id, one covered and one not: only the covered
  one is refused `interrupted`; the other is delivered once.

<!-- src: CONT failure modes 19-45; review 2026-10-28 (H5) -->

### 10.5 Ledger rebuild (F57 to F61)

Behavioural statements the rebuilt decider must make impossible to violate:

- F57. A Run on attempt 2 expires; successor B queues behind the new close. A retained close
  acknowledgement from attempt 1 arrives. B must not start until attempt 2's close is confirmed or its
  deadline settles.
- F58. Running A, `run_now(B)` queued, then `project_inactive`. A later receipt for A's input must not
  start B; nothing starts until the project returns.
- F59. Question q answered with E; E gets a retryable outcome; result (error ActualFailure); E
  retried; then q's delayed confirmation of the first transmission arrives, then `query_ended`. The
  Run ends as error with ActualFailure, not completed.
- F60. An uncertain answer's interaction probe is scheduled for retry, then `project_inactive`.
  Firing the old retry timer must not transmit anything.
- F61. The settlement deadline after a result is the one armed at the result. No later evidence
  extends it except evidence this contract says extends it.

<!-- src: REAPER failure modes 1-11; STOP-INTENT failure modes 1-10; SWAP failure modes 11-18; CONT failure modes 19-45; C0 Round-10 findings 1-5; SPEC Testing Decisions (failure catalogue) -->

### 10.6 Send settlement (F62 to F99)

- F62. A hold attempt fails on the store, then Stop settles the run: the next step is `Ended`; the
  next send is held.
- F63. A held run is fed again: `Busy`, dropped, one transmission.
- F64. A run settled while queued: `Ended`, no write.
- F65. The runner start fails with `retryable` unset: the send fails once, permanent; no second
  start for it.
- F66. A runner starts and is gone before the bind: the send fails once.
- F67. A failure with `retryable` unset on the send path is permanent.
- F68. Shutdown mid-step: no send is settled; restart feeds every unheld owner send.
- F69. An adopted `finished` answer before replay: the run ends and the outbox follows in one
  transaction; a failed connection before replay leaves nothing for Settle.
- F70. An adopted `running` answer: nothing written; the run stays held.
- F71. A failed `CandidateAbandoned` Stop commit: the reconciler commits it after the store
  recovers.
- F72. The same with a daemon crash first: restart stops the candidate row.
- F73. A failed failure-cleanup Stop commit: as F71, with no caller retry.
- F74. A failed user Stop commit: the runner serves until the commit lands; coverage holds.
- F75. A release while memory shows a replaced runner as serving: the stop step stops the
  transaction's row.
- F76. A send behind a predecessor that survives TERM: `Unserved{predecessor}`, park, `Escalated`,
  start, delivered once. A head that settles or is Stop-covered during the park is stepped at once.
- F77. Two sends behind one stopping predecessor: both delivered, in order.
- F78. A store outage past the backoff cap: re-entry every 30 s through `holdRun`; later sends wait
  behind the head.
- F79. A held transmission fails with `retryable: true`: the run ends retryable, the outbox row is
  `retryable_failed`, the reactor re-sends on a fresh run, and the cap counts across runs.
- F80. A release fails on the store: the write fiber repeats it after one backoff; delivered once.
- F81. Adoption or Settle releases a send with no queue entry: it is enqueued and delivered once;
  `ResumeRejected` is not enqueued.
- F82. A predecessor the reconciler has not loaded, or a legacy row: parked only until its window
  end, no poll.
- F83. A start loses the serving-row race: the loser is stopped, the send is held on the winner.
- F84. A start fails with `retryable: true`: re-sent at the backoff, as on main.
- F85. A legacy replay fails with `retryable` unset: settled failed once, not retried.
- F86. A candidate stop for a row already `serving`: nothing written; the runner keeps serving.
- F87-F95. Apply SEND-SETTLEMENT 71-79 in order: settlement write retry, run-end wake during a
  readiness or cleanup wait, native-resume fallback and its crash window, stale claim/transmission evidence,
  uncommitted candidate cleanup, cancelled Stop waiter, source-aware provider migration,
  nonterminal reply normalization, and permanent-versus-transient boundary errors.
- F96. A delayed Held result after release has no local write capability; duplicate wakes
  cannot write a transmission twice or close the handle of n+1 on the same runner.
- F97. CandidateAbandoned of a promoted candidate returns Ignored, never awaits a Stop on
  Running and leaves that runner serving. Other Stop reasons recheck instead of inheriting Ignored.
- F98. Committing permits commit/rejection only; no shutdown, signal, settlement or prune
  happens before the retirement transaction succeeds.
- F99. The reactor recalls a still-unheld modern owner send: it fails once `processing_timeout`,
  permanent, and is dropped as `Ended` with no write. A held send is untouched. The reactor
  writes no runner-held uncertainty marker; only Settle may do so. An account revocation that
  fails the reactor's call ends an unheld send once, by its flag, and leaves a held one alone.

<!-- src: SETTLE failure modes 46-83 -->

## 11. Testing

### 11.1 Principles

- A good test crosses the module's interface and asserts behaviour, not internals. Retirement tests
  that counted transaction entries assert rollback and restart behaviour instead. Targeted fault
  injection stays.
- Write the failure modes down before the code. Assertions are exact, not "terminal or delivered":
  an uncovered never-received send reaches the agent exactly once; a covered never-received send
  produces one `turn.interrupted` and no delivery; an uncertain send is never retransmitted; no run
  is left `running`.
- Existing suites stay unless removed with a written reason.

<!-- src: SPEC Testing Decisions; AUDIT-2 Other changes (tests cross the interface); CONT Tests; SEND-SCOPE-5 Tests -->

### 11.2 The decider: property traces, ground truth and the oracle

- **Traces.** fast-check model-based traces (`fc.commands`, `fc.modelRun`) through the public
  interface only, per provider, over the full public alphabet: user commands, every evidence kind
  (every `effect_outcome` and `kill_and_respawn` outcome), settlements, and `alarm_fired` at arbitrary
  times. Evidence targets live, stale and never-issued tokens and arrives after Runs end. Providers:
  Claude, Codex, Cursor and OpenCode.
- **Ledger invariants** against a fake provider as ground truth:
  - LI1: no start while the fake holds accepted, unended work or a running wake turn on that
    native session.
  - LI2: evidence the fake could deliver in either order yields the same `viewLedger` once
    both arrive. When one order decides a Tombstone between the two facts and the other does
    not, that Run may be absent from `active` in one view and its outcome may differ; every
    other view field agrees. Accounting is checked only by a duplicate accounting receipt
    producing no events; values belong to the usage projection.
  - LI3: at most one terminal per Run; Tombstones are immutable.
  - LI4: replaying a decision's entries through `evolve` from the initial state gives the same view as
    the live state.
  - LI5: live or unknown tasks are never destroyed without a confirm that matches the latest
    snapshot, except unplanned loss; lost work is recorded at most once per label, in the decision
    that ends its scope, and never for a label `Known` to have no live task (L5, 8.4).
  - LI6: a native command is issued in the requesting decision when the project is active, alive
    process or not; requested while the project is inactive, it is issued in the `project_active`
    decision, ahead of any start or steer, unless its native session ends first (then it is
    `Failed{session_ended}` and never issued, D30).
  - LI7: older-label evidence never changes authority or liveness; a send's own label is never older
    for that send (3.4).
  - LI8: `anythingMayAct` is false only when the fake has no running turn, no unfinished send other
    than a probe (D31) and no live task; unknown counts as true.
  - LI9: each self-started turn on a label that is not older (3.4), with no active Run, yields
    exactly one wake Run.
  - LI10: a zero-turn result never ends or starts a Run.
- **Spec properties**, checked against both the pure decider and the real ledger on SQLite: every Run
  ends exactly once; every unfinished Run has a deadline; at most one active Run per session; no
  `delivery_unknown` input is delivered twice; no answer is lost; the inbox drains; Tombstoned Runs
  accept no lifecycle events; no illegal transition on valid input; tables and views agree after a
  rollback.
- **Oracle.** A deliberately naive reference consumes only the public command stream and the
  decider's public outputs (issued effects with tokens, `ended`, `viewLedger`), keeps its own history
  and recomputes expected facts. It never reads `SessionLedgerState`, `LedgerEvent` or any internal
  module. Differential traces compare effects, `alarmAt` (exactly) and the view after every step;
  tokens match by issue order, not value. The fake scheduler fires `alarm_fired` at `alarmAt` and at
  arbitrary other times, before and long after. The oracle is updated by a separate author who reads
  only the contract documents, the spec, the failure catalogue and the public model. The
  `pendingCases` ratchet stands.
- **Coverage gate.** The run fails if any evidence kind or these races have zero hits: start refused
  with an accepted sibling; process loss mid-Run; runner release; late acceptance after a Tombstone;
  unknown delivery settled by a probe; evidence on both sides of a Tombstone; a wake turn while an
  input is queued; a snapshot during Interrupting; a stale confirm; a label change mid-interrupt; a
  clear held by Claude; an idle clear; Pause native command plus wake Run leaves foreground
  authority unchanged. Codex Pause then `budgetLimited` belongs to the goal tracker (32.27),
  outside this ledger coverage gate.
- **Fixed traces:** the ten findings of HL-K step 2 review rounds R1 to R5 below (R5 red on the
  pre-redesign tree first), the six seed `82_103_204` evidence-order permutations in
  `run-ledger-evidence-order.test.ts`, F57 to F61, "Pause on idle did nothing", every probe finding,
  "Stop pauses the goal" as must-not-happen, and every shrunk failure. Each finding is expressed in
  new-model terms; a deleted mechanism's trace checks the behaviour that replaced it.
  - R1: quarantine kept when a completed query's fence is released; retained transport failures kept
    apart from successor admissions; late native results reconciled for retained OpenCode sends;
    a fence-release path for retained retryable sends.
  - R2: native acceptance kept when retryable sends are retired; process loss reconciled before an
    ended owner is ignored.
  - R3: acceptance-based retention scoped to the accepted transmission.
  - R4: acceptance set by an input probe kept; observed proof kept without upgrading failed delivery.
  - R5: the native fence kept when a sibling start is refused (`run-ledger-r5-fence.test.ts`).
  The R3/R4 split is inferred in the source decision record.
- **Artifact:** JSON of seeds, hit counts per kind and race, and shrunk failures. CI runs a fixed seed
  set; an environment variable enables long runs.
- Each decider step lands as its own commit with the oracle and the differential green.

<!-- src: FB §5; OW Decision 5; HLK Oracle, header; C0 §4; BG Decision 5; SPEC Testing Decisions (property invariants); D1 Testing; model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L5, LI9 -->

### 11.3 The ledger, runners and end to end

- **Ledger on SQLite**, through the four verbs: atomicity of decision and duties, the backfill
  migration. A guard test fails if anything but the ledger writes ledger-owned tables. From each
  provider's ledger ticket (Claude 32.6, Cursor 32.10, OpenCode 32.11, Codex 32.21), a test fails if
  anything but the ledger's interpreter writes the status of that provider's effects; after 32.13 it
  covers every effect.
- **Event-order test** (32.3), through the public interface on real SQLite: every ordering of up to
  six events for a session with one send and one steer (claim, native terminal, reply in current, old
  and attemptless forms, hello in holds, completed and unknown forms, restart, Stop, refusal, runner
  lost, native resume rejected). Check invariants: one terminal per effect and one settlement per
  token; no running effect without an owner; an input returns to the inbox at most once and only if
  never shown; a draft is restored at most once and only if the message was never shown; receipts
  match the final status; at most 5 transmissions; a later send never starts before an earlier one
  settles. Each run writes a report artifact with the smallest failing sequence.
- **End to end with real processes**, each writing a JSON artifact:
  - processes: SIGKILL of the daemon mid-turn continues (F1); F2, F3, F6, F7 with a TERM-ignoring
    descendant; F5 at each crash point; a SIGTERM-ignoring runner is SIGKILLed and a follow-up message
    resumes the same conversation (pids, signals, timings, resumed native id);
  - stop: F14, and a Stop with an accepted run that settles to a terminal state;
  - swap: the scenarios of the swap design, with the pause hook;
  - sends: restart mid-send, a steer that arrives as the Run ends, the fallback after a restart;
  - continuation: F30, F31, F37, F40, F41, F45, F46, F51 and F54, with JSON under
    `CONDUIT_RUNNER_EVIDENCE_DIR`; race and crash points use the `NODE_ENV=test` pause hook;
  - providers: Claude SDK E2E with JSONL and a JSON report; Codex app-server E2E (set, pause mid-turn,
    resume from idle, clear mid-turn, interrupt, `budgetLimited`, a terminal listed then terminated;
    phases from native notifications; no goal action interrupts), plus two unprobed checks:
    whether setting a goal on a fresh thread self-starts a turn, and what Pause, Clear and Stop do
    to a live background terminal;
  - ledger crash matrix and two-build upgrade on built dist with recorded Claude, Codex, Cursor and
    OpenCode trace fakes (ADR 0002), with a JSON artifact.
- **Through the manager's interface** with an injected clock, process table and commit failure: F4,
  F8, F9 and the main-built kill path; F12, F13, F15 to F18, F20, F21; F22 to F28 and "a session Stop
  retires its candidates"; F36, F38, F39, F42, F47 to F50, F52; the survivor schedule (10/30/60 s,
  mismatch and zombie stop without notice, one notice with the right wording, retired registration
  never re-adopted). Each asserts runs reach a terminal state or keep running, never a stuck
  `running`.
- **Provider service through the engine**, real SQLite and a real runner host: F32 to F35, F44, F55
  and retained steers, so Stop acceptance, cohort creation and control choice are production code.
- **Persistence and migration:** F43 through the projector rebuild tests; `held_transmission`, old
  `run.dispatched` decoding, the `role` backfill (two live rows end as one serving and one candidate;
  a second serving insert is refused).
- **Runner wire:** `command-refused` per reason, the interrupted-run record, F53, F56, hello after
  draining the previous connection; the runner role (retire while busy refused, a command cancels the
  reservation, hello clears Reserved); one test per journal answer, including a key inherited from a
  predecessor and a fallback send; main-built runners against main's journal semantics.
- **Send scopes:** one test per ending, through the provider instance: every held resource released
  exactly once and the outcome seen exactly once; a `release-sink` from another runner closes nothing.
- **Projector:** a session-scoped `turn.notice` persists and replays as the info banner.
- **Fixture change:** `runner-survivors.test.ts` "STOP-INTENT Stop wins the SQL writer before a racing
  send" seeds a `send_turn` outbox row (lower `request_sequence`, the racing run, `running`) and an
  `end_session` control row whose `payload.stop.owners` lists the racing run. It expects
  `interrupted` with one `turn.interrupted` ("Stopped before delivery"), `runner_id` null and
  `received = []`.
- **Known failures fixed, not skipped:** the two upgrade failures that also fail on main
  ("notification-driven parent turn ... before-restart / during-warm", adf36036).
- **Visual acceptance:** feature files and baselines for goal phases, Stop tasks, the destructive
  confirm and the lost-work notice.
- **Guard test:** runner-derived writes go through the write seam (6.2).

<!-- src: SPEC Testing Decisions; SEND-SCOPE S4; SEND-SCOPE-5 Tests; SEND-SCOPE-6 Tests; REAPER Tests; STOP-INTENT Tests; SWAP Tests; CONT Tests; D1 Testing; BG Decision 5; RA §3 (guard test); review 2026-10-28 (H10, M5); model-gaps 2026-10-28 -->

## 12. Build target per ticket

### 12.1 The settled target

- 32.17 is built against sections 4.1 to 4.10, 5.1 to 5.3, 6 and 7, judged against the bar "no worse
  than main" (7.4).
- The ledger chain (32.2.2 to 32.2.9, 32.2.11 to 32.2.13, 32.3 to 32.14 and 32.21 to 32.28) builds
  on the hold, `run.released`, the feeder, `stopCovers` and the journal answers. It may not add a
  second owner of the hold, of coverage or of the transmission count.
- Owners move one provider at a time (section 2, Switch): Claude 32.6, Cursor 32.10, OpenCode 32.11,
  Codex 32.21. 32.13 deletes the legacy copies once every provider has switched.
- 32.2.6's `decide` owns three things deferred from 32.17: direct-provider uncertainty (4.10),
  re-sends through the outbox (4.8), and one Stop rule for inbox rows and claimed rows (5.4).
- Findings that exist only because several writers still decide an outcome, and that main also has,
  are recorded for the ledger chain, not fixed in 32.17.

<!-- src: CONT Decisions (I/L), Out of scope, C1 (Direct providers); SEND-SCOPE-5 S8; task brief (build target); review 2026-10-28 (H10, M4) -->

### 12.2 Per ticket

| Ticket | Builds | Sections |
|---|---|---|
| 32.1 | failure catalogue and glossary | 1, 10 |
| 32.15 | runner entry lifecycle as one tagged state; bead scope, state tags not specified here | 6.4, 6.9, 6.11 |
| 32.16 (runner R1) | runner record and authority, `adopt` and `revoke`, survivors; deletes the `.retired` marker, the 11A hold and `runner_quarantined`. R3 is folded in. Merges to main together with 32.17 | 6.2, 6.7 |
| 32.17 (runner R2, phase 1) | guarded writes, the policy table, the guard test and the listed deletions; grants (T1) as Starting and Live only, with the cleanup grant deleted (6.11), runner records (T2), the stop state (T3 as replaced); A1 before the ledger, A2, A3's 60 s cadence, A12, A13, A15 before the ledger; the Stop idle with no Run id; retirement tests through the interface; the reaper, stop intent, the swap and send continuation; the send-path settlement, gate and stop-commit owner per SETTLE (built under 32.29) | 4.1 to 4.10, 5.1 to 5.3, 6, 7, 11 |
| 32.18 (runner R3) | durable owner rows; folded into 32.16, with the older generation scheme superseded by runner authority | 6.1, 6.2, 6.8 |
| 32.19 (runner R4) | the in-host query fence and `querySeq` on frames and hello; one protocol bump shared with 32.5. Readers of labels (stale confirm, a label change mid-interrupt) depend on it | 6.1, 9 |
| 32.20 (runner R5) | remove the legacy generation rule; `legacy:<runnerId>` is deleted under runner authority | 6.1, 6.2, 9 |
| 32.2 | the pure decider and tagged-union run state | 3 |
| 32.2.1 | checkpoint the pre-redesign tree and prove the refused-sibling R5 trace red | 11.2, 3.5 |
| 32.2.2 | T6, T7, T8 (chains derived from the hold for runner-held sends), T9, T10 | 3.3 to 3.7, 4.11 |
| 32.2.3 | contract-only oracle update for decider rules, background work and provider policies | 11.2, 3, 8, 9 |
| 32.2.4 | public-interface trace harness, fake provider ground truth, oracle differential, coverage and fixed traces | 11.2 |
| 32.2.5 | A6, A16 | 3.8 |
| 32.2.6 | direct-provider uncertainty, outbox re-sends, one Stop rule for inbox and claimed rows, reading `stopCovers` (5.4); Q26: close native terminal projection's missing attempt fence with 32.6 | 4.7, 4.8, 4.10, 5.4 |
| 32.2.7 | core authority, stopping, process labels, session and project gates | 3.3, 3.6, 3.11, 5.1, 6.1 |
| 32.2.8 | core answers, steers, OpenCode and Cursor policies | 3.6, 3.9, 3.10, 9 |
| 32.2.9 | integrate, verify and land the redesigned ledger | 11.2 |
| 32.2.10 | key Claude background tasks by native `task_id` and `run_id`, without a second counter | 8.2, 8.3 |
| 32.2.11 | A4's deadline as a ledger deadline, A11 unsolicited observations, T5, T7, `run_id` order | 3.4, 3.7, 8.2, 8.5 |
| 32.2.12 | core destructive confirm and lost work, including stale snapshots and labels | 8.3, 8.4 |
| 32.2.14 | per-provider native-session fence membership, idle proof and `resultReleasesFence` | 9 |
| 32.3 | ledger on SQLite with four verbs; the Run Effects table, empty and not yet authoritative for any provider (the outbox stays authoritative); A5, A7, A14, A18, A19, T9, T12, the per-session row of A8; owns the SQLite event-order test | 3.1, 3.7, 3.12, 11.3 |
| 32.4 | deadlines as data and the process watcher; A1 with the ledger: builds `process_lost` with `retired_at` in the retirement commit for ledger-owned runs, while runner-held providers keep `Gone`-time settlement until their own ticket (6.5); A3, A8, A15 with the ledger; Q26: durable process-loss recovery, including the uncommitted direct-Stop/live-reattachment limitation (7.2), with 32.6/32.8 | 3.7, 6.4, 6.5, 6.8, 7.2 |
| 32.5 | stateless runner protocol; A11; the protocol bump with 32.19; Send Token identity on the wire, run ids as coverage labels only, wake labels on `interrupt_turn`; a joined steer's own `run.dispatched` and token (4.11) | 4.6, 4.9, 4.11, 9 |
| 32.6 | Claude send and run end through the ledger; reuses the journal answers. Switch for Claude: Run Effects, run state and `delivery_indeterminate` become the ledger's; `process_lost` settlement moves to the retirement commit and `Gone`-time settlement is deleted for Claude; migrate Send Settlement's Claude callers to the ledger's source-specific inputs (4.7, 4.11) and delete their outbox path; `processLost` is a no-op for Claude; Claude's `process_started` reporter (6.1), the swap commit's included, with promote's memory part before the permit's release and a command activating a Candidate host (6.9); Q26: close native terminal projection's missing attempt fence with 32.2.6 and durable process-loss/control recovery with 32.4/32.8 | 3.12, 4.9, 4.11, 6.1, 6.5, 6.9 |
| 32.7, 32.23 | steering as a Run Input; wake admission. Run Inputs own steer association for each switched provider; `joined_into` stays for the rest until 32.13 | 3.9, 3.12, 8.3 |
| 32.8 | Stop, interrupt and Run now; `interrupt_turn` built from the Stop commit, with wake labels and no input ids. The `control` `stop` records the Stop but is not read for coverage before 32.13; Q26: durable Stop/control reconciliation and recovery with 32.4/32.6 (7.2) | 4.6, 5, 7.2 |
| 32.9 | answers through `control(answer)` | 3.10 |
| 32.32 | H2: restart recovery runs an issued, unfinished `kill_and_respawn` from the Run Effects table instead of reattaching its runner; needs 32.3, and blocks the first ledger switch that issues kills (32.6, 32.10) | 6.6, 6.9 |
| 32.10 | Cursor on the ledger, runner-held; reuses 32.6's runner path. Switch for Cursor, as 32.6 does for Claude; migrate Send Settlement's Cursor callers to the ledger's source-specific inputs (4.7, 4.11) and delete their outbox path; `processLost` is a no-op for Cursor | 3.12, 6.5, 9 |
| 32.2.13 | Codex policy in the decider | 3, 8, 9 |
| 32.21 | Codex on the ledger, runner-held; reuses 32.6's runner path. Switch for Codex, as 32.6 does for Claude; migrate Send Settlement's Codex callers to the ledger's source-specific inputs (4.7, 4.11) and delete their outbox path; `processLost` is a no-op for Codex | 3.12, 4, 6.5, 9 |
| 32.11 | OpenCode on the ledger. Switch for OpenCode: Run Effects, run state and the direct-provider `delivery_indeterminate` marker (written by the interpreter) become the ledger's; the OpenCode process reporter, labelled with the instance's `promptProcessId` (9) | 3.12, 4.10, 9 |
| 32.12 | session-wide failures and removed projects | 3.11 |
| 32.13 | deletes the old run-state copies: `owned_run_ids` and the fallback, main-built paths, `newestRunnerFirst`, run joining, `payload.stop.owners`, `stopCovers`, `joined_into` and the outbox; the ledger's `control` `stop` takes over coverage (5.4); Send Settlement's outbox adapter and its `settleRunnerCommandReply` call path | 3.12, 5.4, 6.5, 6.9, 7.4 |
| 32.14 | full crash matrix and two-build upgrade, run once each for Claude, Codex and Cursor; reuses the journal answers | 4.9, 11.3 |
| 32.22 | A9, A20, T6, T11 | 8.3 |
| 32.24 | Stop tasks through per-task effects, without touching a turn | 8.4 |
| 32.25 | destructive confirm and durable lost-work notice | 8.4 |
| 32.26, 32.27 | A4, A17, T4 | 8.1, 8.4, 8.6 |
| 32.28 | Codex background terminals as tasks | 8, 9 |
| 32.29 | the send settlement redesign (SETTLE S1 to S5) and the split by state owner: send gate and feeder, Send Settlement, Starter, legacy recovery, retirement, live send | 2, 4.3-4.5, 4.7-4.9, 4.11, 6.3, 6.4, 6.9, 6.10, 7.1-7.2 |
| 32.30 | SessionActivity as every surface's activity view; bead requires a contract extension before implementation | 2, 8.1 |

- Lanes paused for this redesign: 82tn.10.6, 10.7, 10.9, 11, 12, 13, 14, 15 and 16. They build on
  the ledger. The ledger is built on the 82tn integration branch after the final 27.3, 10.3 and main
  merges, before 82tn.10.6 onward resumes.
- Background-work tickets depend on runner R1 and R2.

<!-- src: AUDIT Tickets; AUDIT-2 Tickets; RA §9; SEND-SCOPE-5 S8; SEND-SCOPE-6 S10.1; SPEC children list, Implementation Decisions (Placement), Further Notes (paused lanes); CONT Out of scope; review 2026-10-28 (H4, H9, H10, M1); model-gaps 2026-10-28; read-only Beads 2026-10-28; SETTLE S2, S3, Required work, Decisions (AJ) -->

## 13. OPEN items

All seven are decided; the decisions live in the cited sections.

| Id | Question | Section |
|---|---|---|
| OPEN-1 | Decided 2026-10-28: derived from the hold, never stored | 4.11 |
| OPEN-2 | Decided 2026-10-28, clarified model-gaps: opaque host string bound by `commandId` and transmission from `run.dispatched` | 4.11 |
| OPEN-3 | Decided 2026-10-28: the ledger replaces the Stop cohort at 32.13 | 5.4 |
| OPEN-4 | Decided 2026-10-28: recorded with `retired_at` | 6.5 |
| OPEN-5 | Decided 2026-10-28: Send Token identity; run id as a coverage label only | 9, 4.6 |
| OPEN-6 | Decided 2026-10-28: yes, runner-held, with its own policy | 9 |
| OPEN-7 | Decided 2026-10-28: no cleanup grant; scopes release memory, the reconciler settles | 6.11 |

<!-- src: this file, sections 4.11, 5.4, 6.5, 6.11, 9; model-gaps 2026-10-28 -->

## Appendix A. Decisions

Question numbers were reused across documents (HLK Q8 and FB Q8, HLK Q9, FB Q9 and BG Q9, HLK Q10
and BG Q10, FB rulings 10A to 12A and BG Q10 to Q12, D1's own answers 2A to 6A). Each decision is
named with its document. "Not recorded" means the source names the chosen letter but not the
rejected options.

<!-- src: HLK, OW, FB, BG, D1 headers (question numbering) -->

### A.1 HLK (2026-10-23)

Why, from the source: Q1, Q4, Q7 and Q8 were symptoms of one fact having two owners; Q3, Q5, Q6, Q9
and Q10 were real rules.

| Q | Chosen | Effect | Rejected |
|---|---|---|---|
| Q1 | 1D | each obligation owns its deadline; one projected alarm (3.7) | not recorded |
| Q2 | 2C | Run end is adapter-declared; the native-session fence is separate (3.6) | not recorded |
| Q3 | 3B | input delivery Queued, Dispatching, Delivered/sent or Delivered/unknown (3.5) | not recorded |
| Q4 | 4B | Accepted decisions carry `alarmAt` (3.7) | not recorded |
| Q5 | 5C | the outcome fold within one execution (3.8) | not recorded |
| Q6 | 6C | native id immutable once known; one execution per start attempt (3.4) | not recorded |
| Q7 | 7B | one module for correlation and transmissions; refined by OW Q7 | not recorded |
| Q8 | 8C | no in-session pruning (3.12) | not recorded |
| Q9 | 9B | resume clears only an ordinary pause; the project returns through reconciliation probes (3.11) | not recorded |
| Q10 | 10B | a refused answer stays Pending with `lastRefusal` (3.10) | not recorded |

<!-- src: HLK header, Why, steps 1-5, Rules not tied to one step -->

### A.2 RULINGS and D1 (2026-10-23)

- RULINGS R1: every probe owns a retry deadline from issue; the oracle changes. R2: a timed-out
  permission is answered `{ decision: "reject", reason: "timeout" }`; the oracle changes. R3: an
  issued send with no transport evidence is Dispatching. No options recorded.
- D1: answers 2A, 3A, 4A with notice option 5A, 5A, 6A. Chosen: a failed kill never quarantines
  (D1-1 to D1-5, 5.1, 6.6, 6.7). Rejected: quarantine plus a native-session probe after a failed
  kill (the earlier open item and the withdrawn spec rule).

<!-- src: RULINGS R1-R3; D1 header, D1-1 to D1-5; RULINGS (D1 open) -->

### A.3 OW (2026-10-23)

- Q7 = B + J with C folded in; riders K and L. Chosen because step 2 as built had five holders of one
  answer and every review finding sat on their seams. HLK steps 2 and 3 merge with the D1 change.
- Rider K was later superseded by FB (executions are stored directly). Rider L stands as the policy
  seam. Rejected options: not recorded.

<!-- src: OW header, Why, Decision 1, Riders; FB What stays -->

### A.4 FB (2026-10-24)

- Q8 = A, the whole ledger as one Fact Book: store only evidence and conduit's own decisions, each
  once; every summary is a view. It replaced OW's single implementation ticket with a sequence.
- Q9 = A + I + J. Effect: the design of FB sections 1 to 5. Rejected options: not recorded.
- 10A: the fold keeps the specific code with the lowest send number, then the lowest code. 11A: on
  OpenCode, activity after a result shows as Running and keeps the fold. 12A: evidence after a Run
  ends is recorded only when it changes a join (3.8). Rejected options: not recorded.

<!-- src: FB header, Why, What stays, §3 rulings 10A-12A -->

### A.5 BG (2026-10-24)

| Q | Chosen | Effect | Rejected |
|---|---|---|---|
| 2 | 2B | approved; its effect is not named in the text | not recorded |
| 3 | 3A | the ledger never reads goal state (8.6) | not recorded |
| 4 | 4A | wake Runs (8.3) | not recorded |
| 5 | 5A, corrected | tasks from the latest snapshot of the current process (8.3) | not recorded |
| 6 | 6A | lost-work records and destructive confirms (8.4) | not recorded |
| 7 | 7A, 7D | one generation per process lifetime (later replaced by labels, 3.3); tasks keyed by Claude's `(task_id, run_id)` | not recorded |
| 8 | 8F with two riders | native commands skip the inbox; the goal shows "queued by Claude" (8.5, 8.6) | not recorded |
| Q9 | 9F | Pause only where the provider has a native goal pause; Clear-only for the others (8.6) | `priority:"now"` for clear: it abandons the turn, which is a Stop |
| Q10, Q11, Q13 | 10A, 11A, 13A | the runner lifecycle sections 1 to 7, later replaced by RA | not recorded |
| Q12 | 12A | the Codex goal changes (8.6) | not recorded |

<!-- src: BG header, Decision 1, Decision 2 (7D), Decision 3 (Claude goals), Runner lifecycle header; RA header -->

### A.6 Runner authority, audits and send scopes (2026-10-25 and 2026-10-26)

| Q | Document | Chosen | One-line reason | Rejected |
|---|---|---|---|---|
| Q15, Q16 | RA | B, A: one module owns who may write for a runner | five stores of runner authority gave different answers | not recorded |
| Q17 | AUDIT | A: A1 to A12 | facts with more than one owner | not recorded |
| Q18 | AUDIT | D: kill the process group; the notice promises only what conduit controls (6.6, 6.7) | the CLI and its commands outlived a pid kill | not recorded |
| Q19 | AUDIT-2 | A: A13 to A20, T1 to T12 | a second audit, adding implicit states | not recorded |
| Q20 | SEND-SCOPE | A: one scope per send (4.2) | six of seven findings were per-send resources never freed | not recorded |
| Q21 | SEND-SCOPE-2 | A: the handle owns its assignment (4.2) | mutable assignment fields leaked | not recorded |
| Q22 | SEND-SCOPE-3 | A: one admission path (4.2) | recovery admitted sends on its own | not recorded |
| Q23 | SEND-SCOPE-4 | A: requeue, don't replay (4.8, 7.2) | two things decided a recovered send's fate | not recorded |
| Q24 | SEND-SCOPE-5 | A + J + K + L + M + N + Q: one owner for every effect outcome, commit-only, fallback as a new transmission, duties as data in the same transaction, exhaustive event-order test (4.7, 11.3) | several writers decided one outcome | not recorded |
| Q25 | SEND-SCOPE-5 | E: a message that never reached the agent is re-sent up to the cap (4.8) | | not recorded |
| claim | SEND-SCOPE-5 | B: starting is part of the owner | | not recorded |
| Q26 | SEND-SCOPE-5 | C: the Run Ledger is that owner; R1 and R2 land first (12) | an interim owner would be deleted by 32.13. Q26 forbids a new interim owner; existing owners such as `stopCovers` stay until their deletion ticket (5.4) | not recorded |
| Q27 | SEND-SCOPE-6 | A: the journal answers per send; main-built runners get main's recovery in one module (4.9, 7.4) | the daemon classified sends | not recorded |

<!-- src: RA header, Why; AUDIT header, A12; AUDIT-2 header; SEND-SCOPE to SEND-SCOPE-4 headers, Why; SEND-SCOPE-5 Decisions, S7 (interim owner); SEND-SCOPE-6 Decisions; review 2026-10-28 (W1) -->

### A.7 Reaper, stop intent and swap (2026-10-27 and 2026-10-28)

| Q | Document | Chosen | One-line reason | Rejected |
|---|---|---|---|---|
| Q28 | REAPER | A + C, with R1 as the user's constraint (6.6) | the daemon dying must not kill sessions it reconnects to | not recorded |
| Q29 | REAPER | A: the reaper inside the runner's group, in `/bin/sh` | approved as written | not recorded |
| Q30 | STOP-INTENT | A with C as its internal shape: a durable intent, one reconciler, one typed stop state (6.3, 6.4) | one owner that survives a crash | D: patching each owner keeps six owners. B: reordering them keeps six owners. C alone: memory still needs the row after a crash, a second source of truth |
| Q31 | STOP-INTENT | C: the run record names its holder (6.5) | the stop row lists no runs | not recorded |
| Q32 | STOP-INTENT | A | its effect is not named in the text | not recorded |
| Q33 | SWAP | A + E + M, built as J + K + M: reversible prepare, one commit, promote; the database names the serving runner; the role is one typed state (6.9, 6.10) | | not recorded |

<!-- src: REAPER header, Decisions; STOP-INTENT header, Why, Decisions; SWAP header, Decisions -->

### A.8 Send continuation (2026-10-28): C + J + K

| Option | Verdict |
|---|---|
| C: ledger coverage checked inside `holdRun` | chosen (core) |
| J: `holdRun` returns a typed `Hold` | chosen (C's interface) |
| K: durable delivery evidence | chosen, as the hold plus `run.released`, not a new outbox code |
| A: patch the third round in place | rejected: keeps seven owners; a fourth round would find an eighth |
| B: one in-memory admission decision in the manager | rejected: not durable, infers intent from runner state, misses the window between the Stop press and the manager's Stop |
| D: a session Stop epoch | rejected: a second copy of the cohort; does not fit an interrupt that lists turns or retained steers |
| E: Stop settles its cohort at once | rejected: Stop would write outcomes before the provider confirms |
| F: a `stop_requested` column on runs | rejected: duplicates the cohort |
| G: the runner decides | rejected: the runner does not know the user's intent |
| H: pull the ledger's `decide` forward | rejected: 32.2.x depends on 32.17's runner authority, not the reverse |
| I/L: the outbox owns re-sends | deferred to 32.2.6: needs one Stop rule for inbox and claimed rows, which `decide` owns |
| M: runner authority owns the coverage predicate | rejected: coverage is the user's Stop, which the ledger records |
| N: a `Draining` hold outcome | rejected: a second wait loop; stopping the refusing runner in the release commit makes it unnecessary |
| O: a transmission counter column | rejected: resets on a fresh run or merges joined steers; counting `run.dispatched` by `commandId` is durable already |
| Q: the live loop re-holds its own releases, restart re-feeds the rest | rejected: two re-drivers, and a reconciler release in a live daemon has neither |
| P: per-runner FIFO ordering instead of the host's record | rejected: ordering would have to hold across the commit, the write queue and reconnects; the record is local and typed |

### A.9 The OPEN items (2026-10-28)

The user ruled OPEN-1 to OPEN-4 directly. For OPEN-5 to OPEN-7 the user asked for brainstorm,
codebase-design and architecture passes on each seam, choosing the best long-term option under one
criterion: temporary process cleanup happens in the background, never something the user notices or
worries about. Competitor evidence came from t3code, bb, paseo, zeron, diri and monocode (main at
2026-10-23 to 2026-10-28) and capy's docs.

| Item | Chosen | Rejected |
|---|---|---|
| OPEN-1 | A: a runner-held send's chains are derived from the hold (4.11) | B: the ledger stores its own chains and the hold becomes a cache |
| OPEN-2 | A, clarified model-gaps: opaque host string bound by `commandId` and transmission from `run.dispatched`; journal key; `sinkId` carries it (4.11) | `request_sequence` plus attempt; command id plus a separate attempt count; shared `commandId:n` codec; structural token |
| OPEN-3 | A: the ledger replaces the Stop cohort at 32.13; `stopCovers` is the interim owner (5.4) | B: keep `stopCovers` and run joining as the ledger's coverage |
| OPEN-4 | A: `process_lost` in the commit that sets `retired_at` (6.5). The recommendation was B | B: at confirmed `Gone` |
| OPEN-5 | token identity; run ids as coverage labels; wake labels on `interrupt_turn` (9, 4.6) | interrupts naming tokens; highest-attempt acks; input-id targeting; one ordered socket writer; a Stop epoch; host-minted ids; daemon-only receipts |
| OPEN-6 | Codex is a runner-held ledger provider with its own policy (9) | Codex outside the ledger; Codex as a direct provider; Claude's policy plus capability flags; deferring past 32.13 |
| OPEN-7 | no cleanup grant; scopes release memory, the reconciler settles (6.11) | a cohort at `revoke`; a cohortless cleanup grant; a time-bounded cleanup window; a durable cleanup effect |

<!-- src: HLK header, Why, steps 1-5, Rules not tied to one step; RULINGS R1-R3; D1 header, D1-1 to D1-5; OW header, Why, Decision 1, Riders; FB header, Why, What stays, §3 rulings; BG header, Decision 1, Decision 3 (Claude goals); RA header, Why; AUDIT header, A12; AUDIT-2 header; SEND-SCOPE to SEND-SCOPE-6 headers, Why, Decisions; REAPER Decisions; STOP-INTENT header, Why, Decisions; SWAP header, Decisions; CONT Decisions; model-gaps 2026-10-28 -->

### A.10 Send settlement (2026-10-28): T + U + V

Decided autonomously under the Review Rounds rule after three material rounds on the
SEND-CONTINUATION build of 32.17. Every round answered "is this send live", "is this failure
terminal" or "who ends it, and who owns a failed write" in memory at a call site. Chosen: the gate
returns every domain answer as a value and the feeder has no retry loop (T); one Send Settlement
module ends a modern owner send by appending its run's terminal, with the outbox following in the
projection until each provider switch moves its sources to the ledger's inputs (U); the reconciler retries a failed
Stop commit (V); who serves is read in the transaction (AH); a start failure is classified as on
main (AD-main). Rejected: patching in place, narrowing R2 to main, a candidate sweep, pulling Run
Effects forward, at most once, an in-memory epoch, salvaging the spool in R2 (follow-up bead), a
start budget, a `run.unserved` event, a pure feeder decider, a `Pacer`, Prune tokens, a provider
port.

<!-- src: SETTLE header, Why, Decisions -->

**Decided (integration round 2, attrib-r2)**

- D1: query end covers runner-held interrupt and close, never input work or OpenCode controls (3.3, 6.1).
- D2: Claude result-held fence members use Tombstone cleanup and provider escalation (9).
- D3: process starts count as task-set entries and refresh pending confirms (8.4).
- D4: idle end-session expiry escalates to confirm-gated Run-less kill and respawn (8.4).
- D5: tokened command lifecycle addresses a held query transmission and matches its command id (9).
- D6: a named native result confirms delivery for OpenCode idle coverage (9).
- D7: wake execution stays live after Run end and is recorded while the project is inactive (8.3).
- D8: unsolicited identity is the label and event id pair (3.4).
- D9: Queued borrows its blocking obligation's deadline; no fence clock or fenceMs (3.7, 3.13).
- D10: session end covers sends; project inactive retires them (3.4).
- D11: retired probes finish and lose their deadlines (3.11).
- D12: interaction resolution ends every answer transmission for it (3.10).
- D13: probe retry fires at issue plus max(probeMs, backoff(n)) in one decision (3.7).
- D14: LI2 permits the Tombstoned Run's absence from active and a different outcome (11.2).
- D15: derived from L5: lost work is recorded under the label whose scope ended, the runner's latest at retirement (8.4). A label `Known` to have no live task records nothing. Reason: the record is the notice that background work was cancelled (32.25); under 8.3 an empty one would follow every fresh-launch kill and every Cursor or OpenCode retirement.

**Decided (integration round 3, attrib-r3)**

- D16: derived from L1: a kill retires its runner at issue, covering its sends, its own included (3.3, 5.1).
- D17: a native command admitted while the project is inactive issues in the `project_active` decision; inactive leaves a sent command's view, liveness and deadline unchanged (3.11, 8.5).
- D18: an outstanding wake execution is a native-session fence member until its work ends, its runner retires or the session ends (8.3, 9).
- D19: derived from L4: a native command is a session send with no Run, so never a Run's barrier; its deadline drives only its view (8.5).
- D20: a retry is anchored where its obligation opens: the outcome for a send, the issue for a probe; `retryAt` only raises it (3.7).
- D21: a command receipt naming another commandId is Rejected, retired or not (3.4, 9).
- D22: derived from L2 case 3 and H3: with no process the command goes to pending, and the feeder spawns (8.5, 4.4). Rejected: waiting for `process_started` (only the feeder spawns, so a lone command deadlocks); a ledger spawn effect (a second spawner).
- D23: derived from L2: pending resolution, which also fixes the send's label (3.3).
- D24: derived from L4: a covered command is `Failed` with its cause, from L1 and 3.4 (8.5).
- D25: a Claude wake member leaves at its label's `query_ended` with or without a result, as section 9 already says for `resultReleasesFence` no (9).
- D26: for OpenCode, a trusted covering idle probe alone is work ended, for start sends and wake executions alike; the table's sequence is the usual path, not a conjunction (3.5, 9).
- D27: derived from L4: the deadline starts at issue and runs while inactive, because D17 leaves a sent command's deadline unchanged (8.5).
- D28: derived from L1.2: under H1 a joining label is a newer `querySeq` of the same runner, and each execution ends at its own Run-end evidence or its runner's retirement. A turn joining a wake Run under another label is a wake execution of its own: live and a fence member until then; the Tombstone cleanup expiry runs fence expiry against every remaining member label (8.3). Rejected: killing the current process at the wake deadline (destruction would depend on arrival order); moving the wake label to the newest (hides work still running under the first label, LI8).
- D29: changed by REDESIGN (A.11), L3: the gate stores its step; its labels are a view computed when it issues. Reason: the old rule froze labels at gate time, so a confirm after a replacement sent `end_session` to a retired runner (D36's own rejected failure). One confirm for a multi-label step, and `project_active` acting on every member label, stand (8.3, 8.4).
- D30: derived from L4: a deferred command is an unissued send; session end covers it (8.5).
- D31: a probe only reads, so it never counts as a send that may still act; LI8 exempts unfinished probes (8.3). Rejected: counting probes (a read would hold worktree cleanup and archive).
- D32: derived from L2: the escalation goes where its `end_session` went (case 1), or to pending when that went to pending (case 3) (3.3, 8.4). Rejected: the current process (a later, unrelated runner would be killed).
- D33: changed by REDESIGN (A.11), L2 projection: process-wide sends carry the runner's latest label, not the execution label; `PendingConfirm` labels are a view (L3). Reason: the two differ only after a reattach, where lost work and identity are under the newer label (D35's reason) (3.3, 3.13).
- D34: derived from L4: a permanent outcome makes the command `Failed` with its code (8.5).
- D35: derived from L2: the wire label projection (3.3).
- D36: derived from L3: a confirm and clearing evidence issue the same step, addressed when it issues (8.4). Rejected: the gate-time labels (they can name a replaced process, so the step is covered at issue and the session never ends).
- D37: changed by REDESIGN (A.11), L2: an OpenCode steer goes to the current instance (case 3), not the execution's instance; runner-held Run sends use case 2 (D42). Reason: the old label put its coverage on the wrong process (opencode-82103301) (3.3).
- D38: derived from L5 and L1: a pending destruction records nothing, and a retired runner takes no destruction (8.4).
- D39: removed by REDESIGN (A.11): confirm labels are a view (L3), so nothing moves on refresh. D3's `snapshotEntry` refresh stays (8.4).
- D40: derived from L2: a pending kill covers the pending `end_session` issued before it, so there is no second expiry (3.3, 8.4).
- D41: derived from L1: a kill retires its runner, and a retired runner's labels are older (3.4). Rejected: waking from a killed label (a Run opens for a process conduit already destroyed).
- D42: derived from L2 case 2 (3.3). Rejected: the current process for every send (an interrupt would reach a process not running the Run's query).

**Decided (oracle round 8, 2026-10-29)**

Eleven questions from the first oracle round against REDESIGN-1. Ten follow from L1 to L3 and are
written into their clauses, not added as decisions: a `process_started` retires every other
runner, started or not; a later `process_started` of a live runner is a reattach; evidence from a
runner not started has no authority (3.3 L1); a `run_dispatched` naming a retired runner covers
its send (3.3 L2); only snapshots and `process_started` replace tasks; older wake execution labels
never end the Run (8.3); the gate's tasks and `snapshotEntry` are views, a gated step decides at
issue, and a release by retirement issues as any release does (8.4).

- D43: a confirm-gated step that belongs to a Run is dropped when that Run Ends by other evidence; the step existed to end it (5.1, 8.4). Rejected: issuing it against the Ended Run (a `close` would record lost work, L5, for a query that may already serve the next Run).

**Decided (harness round 9, 2026-10-29)**

Ten questions from the first harness round against REDESIGN-1. Nine follow from existing clauses:
case 2 of L2 is every Run send on a runner-host provider (4.10), so OpenCode Held inputs stay as
Rejected-path robustness inputs (3.4); task evidence from Cursor or OpenCode is evidence its
provider cannot produce, Rejected (3.4); a late receipt for a covered send is recorded with no
state change (3.4); a kill to pending never resolves (L2); its wire label is null (3.3); a
multi-label destruction issues one effect per address, so one kill per runner under H1 (L2, D28);
a gate released by `process_lost` issues at the loss (8.4); a same-runner `process_started` is a
reattach (L1). A replaced query's sends are covered by its own `query_ended` (3.3), which passes
the host fence (6.1).

- D44: amends L5. A label's lost-work scope also ends when it becomes older by a newer `querySeq` of its runner (a query replacement, 6.1), so retirement is one case of "becoming older" rather than its own trigger; the newer label's tasks are unknown until its first snapshot (8.4). Reason: the host drops its task cache on replacement (8.3), so the old query's tasks would otherwise vanish with no record. Rejected: carrying the old label's tasks to the newer one (contradicts the host's cache reset); recording nothing at replacement (LI8 work vanishes silently). Risk: a provider that keeps tasks across a replacement would show a spurious notice; 32.25 checks this per provider.

**Oracle round 9 (2026-10-29): no new decisions.** Its five questions follow from 3.4, 8.1, 8.4
and L5: Rejected evidence never raises a label (L1); Cursor and OpenCode task events are Rejected,
so they mark no waking task; a wake joined under a newer label is confirm-gated until that label's
first snapshot (8.4, D44); a newer label retiring before any snapshot records "may have been lost"
(L5).

**Decided (harness round 10, 2026-10-29)**

The generator now produces every input kind the model can represent, including query replacement.
Two of five findings were oracle bugs that need no contract change: a permanent `effect_outcome` on
a native command after `project_inactive` fails it (3.11, D34), and an older wake label's
`query_ended` keeps the Run queued behind the fence (8.3, D18).

- D45: amends D3 and 8.4. `snapshotEntry` counts every change to what the task view reads,
  including a query replacement, not just snapshots and `process_started`. Reason: after a
  replacement the tasks are unknown (8.4), but a confirm copied from the replaced query's snapshot
  still matched and opened the destruction gate (LI5). One principle replaces a list of two events.
  Rejected: dropping the pending confirm at a replacement (the step is still wanted; only the
  user's view is stale).
- D46: `command_lifecycle` from any provider but Claude is evidence its provider cannot produce,
  Rejected (3.4). Reason: section 9 defines it only for Claude, and only Claude source emits it; a
  Codex or Cursor one read as NotConsumed ended a Run whose start the host still held (LI8).
  Rejected: adding it to those providers' Work ended (invents a host behaviour).
- D47: amends 8.3. Every unsolicited `turn_started` is outstanding work in its own right, whether
  it records a wake Run or joins an active Run. Reason: an OpenCode turn joined to a Starting Run,
  then the start declined: the Run Ends (its send was not consumed and returns to the inbox), but
  the native turn still runs (LI8). Rejected: the joined turn marking the start Observed (loses
  the declined message); not joining unsolicited turns (8.3's join exists because OpenCode cannot
  name the start).

### A.11 REDESIGN-1 Process and address (2026-10-28): C + M1

Decided autonomously under the Review Rounds rule after the harness rounds that added D15 to D42.
Root cause: the host allows one serving runner (6.9, 6.5), but the ledger let several runners be
live and a killed runner stay live, so one label did four jobs (target, coverage unit, lost-work
key, freshness) and each guess became a decision. Chosen: one live process, addressed at issue
(H1 to H3 in 4.4, 6.6, 6.9; L1 to L5 in 3.3, 3.4, 8.4, 8.5), built as one deep process module
(`address`, `retire`, `older`). Source: `02-options-and-pick.md`.

| Option | Verdict |
|---|---|
| C: one live process, addressed at issue | chosen (basis) |
| M1: one deep process module | chosen (its shape) |
| A: address once, with live, doomed and gone | rejected: models two live runners and a revivable doomed state the host forbids; one `next` slot misbinds across two spawns |
| B: a process table with numbered slots | rejected: slot numbers and the doomed or lost split are redundant under one process. Its per-runner tasks and gate by target are kept |
| D: the host names the process per send | rejected: a new port on four adapters and a fence and liveness split, to learn what H1 and H2 already make exact |
| E: a Dying state plus `kill_failed` | rejected: the feeder deadlocks on a Dying runner. Its two good halves are in the pick |
| F: the ledger names only run or session; resolve at transmit | rejected: coverage and lost work become host-only facts, so `anythingMayAct` is not pure |
| G: the ledger mints a generation | rejected: `runnerId` already is a per-spawn id; a ledger copy is a sixth owner |
| H: keep patching | rejected: six rounds, still four or more decisions per round |
| M2: targeting in the interpreter | rejected: four adapters would implement the same guess |
| M3: a native-command state machine | rejected: as a projection of its send it holds no state |
| M4: a Run ledger and a Process ledger | rejected: coverage of Run sends would have two owners |

<!-- src: REDESIGN 2026-10-28 (02-options-and-pick.md) -->

## Appendix B. Old-id mapping

Every old id maps here. Ids were reused across documents, so each is named with its document.

<!-- src: section src comments of this file -->

### B.1 Failure modes

| Old | New |
|---|---|
| REAPER 1 to 11 | F1 to F11 |
| STOP-INTENT 1 to 10 | F12 to F21 |
| SWAP 11 to 18 | F22 to F29 |
| CONT 19 to 45 | F30 to F56 (add 11) |
| C0 round-10 findings 1 to 5 | F57 to F61 |
| RL-001 to RL-116 | unchanged, in the Run Ledger failure catalogue |

<!-- src: REAPER, STOP-INTENT, SWAP, CONT failure modes; C0 Round-10 findings; RL catalogue -->

### B.2 Invariants

| Old | New |
|---|---|
| FB I1 to I4 | LI1 to LI4 (11.2) |
| BG I5 to I10 | LI5 to LI10 (11.2) |
| RA I1 to I7 | AI1 to AI7 (6.2); RA I3 "newer wins" is replaced by the serving row (6.9) |

<!-- src: FB §5 (I1-I4); BG Decision 5 (I5-I10); RA §3 (I1-I7); SWAP S7 -->

### B.3 Section ids

| Old | New |
|---|---|
| SEND-SCOPE S1, S2, S3 | 4.2; S3 also 6.2, 6.11 |
| SEND-SCOPE S4 (tests) | 11.3 |
| SEND-SCOPE-2 S5 | 4.2 |
| SEND-SCOPE-3 S6 | 4.2 |
| SEND-SCOPE-4 S7 | 4.2, 4.8, 7.2 |
| SEND-SCOPE-5 S8 | 12 |
| SEND-SCOPE-5 S9.1 to S9.6 | 4.7, 4.8; S9.1 also 3.12 |
| SEND-SCOPE-6 S10.1, S10.2 | 4.9, 7.2, 7.4 |
| STOP-INTENT S1 | 6.3 |
| STOP-INTENT S2, S3, S4 | 6.4; S3 also 6.7 |
| STOP-INTENT S5 | 4.1, 4.3, 6.5 |
| SWAP S5 refined, S6, S7, K, M | 6.9, 6.10 |
| CONT C1 | 4.7, 5.2, 5.3, 4.10 |
| CONT C2 | 4.3, 4.4, 4.9 |
| CONT C3 | 4.5, 4.6, 7.2, 7.3 |
| AUDIT A1 | 6.5 (before the ledger, and with the ledger per the OPEN-4 decision) |
| AUDIT A2 | 6.2 |
| AUDIT A3 | 6.4, 6.7 |
| AUDIT A4 | 3.7, 8.4 to 8.6 |
| AUDIT A5, A7 | 3.1, 3.12 |
| AUDIT A6, A10 | 3.8 |
| AUDIT A8 | 3.7 |
| AUDIT A9 | 8.3 |
| AUDIT A11 | 3.4, 8.2 |
| AUDIT A12 | 6.6, 6.7 |
| AUDIT-2 A13 | 6.3, 6.6 |
| AUDIT-2 A14 | 3.1 |
| AUDIT-2 A15 | 6.8 |
| AUDIT-2 A16 | 3.8 |
| AUDIT-2 A17 | 8.6 |
| AUDIT-2 A18 | 3.12 |
| AUDIT-2 A19 | 3.7 |
| AUDIT-2 A20 | 8.3 |
| AUDIT-2 T1, T2 | 6.2; T1's cleanup grant is deleted (6.11) |
| AUDIT-2 T3 | 6.3, 6.4 (Retirement replaced by `RunnerStop` and the row tag; Signal refined by the signal log) |
| AUDIT-2 T4 | 8.1, 8.6 |
| AUDIT-2 T5 | 8.5 |
| AUDIT-2 T6 | 3.3, 8.2, 8.3 |
| AUDIT-2 T7 | 3.4 |
| AUDIT-2 T8 | 3.5, 4.11 |
| AUDIT-2 T9, T12 | 3.7 |
| AUDIT-2 T10 | 3.6 |
| AUDIT-2 T11 | 8.3 |
| D1-1 to D1-5 | 5.1, 6.6, 6.7 |
| HLK steps 1 to 5 | 3.7, 3.6, 3.5, 3.4, 3.12 |

<!-- src: section src comments of this file; the source documents headings -->

### B.4 R-ids (four separate sets)

| Old | New |
|---|---|
| OW and FB review findings R1 to R5 | fixed traces (11.2) |
| RA slices R1 to R5 | 12.2 (R1 is 32.16, R2 is 32.17, R4 is 32.19; R3 folded into R1; R5 not needed) |
| REAPER R1 to R5 | 6.6, 7.1, 7.4 (R1 7.1; R2, R3, R4 6.6; R5 7.4) |
| RULINGS R1 to R3 | 3.7, 3.10, 3.9 |

<!-- src: section src comments of this file; the source documents' headings -->

## Appendix C. Residual risks and bottlenecks

- **Grants travel on fiber context.** A fork with an empty context loses the grant. The guard test's
  "runner write without a grant is a defect" catches it.
- **A failing retirement insert fails closed for every seam write**, daemon-wide. Only disk-level
  errors cause that, and those already fail every write.
- **SQLite's 5 s busy wait is synchronous** and blocks the event loop. Nothing here bounds it.
  Follow-up outside 32: a time budget on transactions held by the write seam.
- **One daemon-wide store**, so one write permit for every project. The ledger keeps from adding to it
  (3.12). Moving SQLite off the main thread is a separate decision.
- Goal transcript reads scan the whole file; host send deduplication keeps its history.
- Startup is proportional to the history of open sessions, not to open work. Checkpoints are added
  only if measurement shows a need.
- The crash window between revoke and the flush (RA risk 1) is closed: the retirement row commits
  before any signal (6.3, F14).
- Known limits: F10 and F11.

<!-- src: RA §10 (risks 1-4); AUDIT Bottlenecks inherited; AUDIT-2 Bottlenecks; STOP-INTENT S1, failure mode 3; REAPER failure modes 10, 11 -->
