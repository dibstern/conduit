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
- **Main** means main's code at 1ba91324, the one reference for main's behaviour (D56). A claim
  about main is a citation (file, lines, at commit) with a backticked anchor from those lines,
  never a paraphrase a rule depends on. A rule equal to main says "as main" and cites it; every
  difference from main is a row of 2.1, and nothing else differs. R2 (6c9ff950, 32.29 and 32.17)
  lands on main before the ledger chain; a rule R2 changes cites 6c9ff950. The ledger lives inside
  main's writes (D58): every main unit runs whole, and the ledger is one projector arm in their
  transactions plus three outbox effects and a view. Main's run work is main's alone, and each fact
  has one observer (D59): the ledger keeps no item of main's Stop and owns only the deadline of the
  work main cannot see (L6). 32.2.17's replay differential, not review, finds a difference no row
  names (12.2), and the D59 spike runs before the next review (A.21).
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
  States: Queued, Dispatching, Delivered (sent or unknown), Accepted, Failed.
- **Run Effect.** A durable instruction from a ledger decision to an executor (start, steer,
  interrupt, end session, deliver answer, cancel request, probe, stop task,
  send native command). Its outcome returns to the ledger as succeeded, retryable, permanent or
  delivery unknown.
- **Send Token.** Identifies one transmission of a Run Effect. A retry is a new transmission with a
  new token; tokens are never reused. It is an opaque host string, never parsed. Deadlines are not
  sends and carry no token. Whoever issues an effect names its transmissions (3.4). An effect main
  issues is named by main's `(commandId, n)`: for a runner-held start or steer `n` is minted by
  `holdRun`'s `run.dispatched` (4.11); for any other but a direct start, `n` is its claimed outbox
  row's `attempt_count`, carried by its `effect_outcome`; a direct start's is its `run.requested`
  runId. `ctx.newId` mints only the tokens of the effects decide issues (3.4).
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
  (L1, L2, 3.3): its address retired, or session end.
- **Address.** The runner a ledger send is fixed to at issue, or **pending** until the next process
  (L2, 3.3). **Current process:** the session's one live runner (L1). Only runners
  retire (L1).
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
  provider's native id. Classed **monitoring**, **serving** or **work**.
- **Server.** A process listening on a TCP port that carries a session's marker (8.7). Keyed by
  pid, start time and port, per session, never per label. **Serving:** live but calm.
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

| State | Owner | Writers | Readers and caches |
|---|---|---|---|
| Run decisions and Tombstones | Run Ledger, the arm's fold (3.8); main's run state (`provider_runs`, its terminal projection, Send Settlement) stays main's, run whole (D58) | the arm, from main's projected events in their writer's transaction (D58) | the units 2.1 names, through the ledger view (3.9); main's readers read main's run state, as main |
| Run Input records (an input's Run and its sends) | Run Ledger | the ledger's arm, from main's events in their writer's transaction (D58) | the units 2.1 names, reading the ledger view in their own body (3.9) |
| A Run's id | main: the `runId` of the `run.requested` that reserves it (3.4); a wake Run's, the ledger's `ctx.newId` (8.3) | the send commit and `markRunning` (orchestration-command-commit.ts 308-310; orchestration-side-effect-reactor.ts 1338-1345 at 6c9ff950) | the arm names the Run by it and by any later `run.requested` for its input |
| The inbox: admission, queued inputs, order, the mark, `steering`, the pause | main's inbox module, run whole (D58) | main's arms and code, fed by main's own events (3.9) | main's `readView` and `decideInbox` |
| Steer association with a Run | `joined_into`, main's `run.started` arm (D58) | main's run joining | `holdRun`'s owner resolution (4.3); the arm folds the projected `run.started` that sets it, and never reads or writes the column (3.9) |
| Send issue decisions and their evidence (sends with no hold) | Run Ledger | the arm (3.9) | views; a runner-held send stores none: its chains are a view over its hold facts (4.11) |
| Send Token | opaque host string, never parsed; its issuer's (3.4): an effect main issues is bound to main's `(commandId, n)`, `n` from `run.dispatched` for a runner-held start or steer and the claimed outbox row's `attempt_count` for any other but a direct start, whose token is its `run.requested` runId; `probe`, `stop_task` and `cancel_request`: Run Ledger | `holdRun` binds the transmission (runner-held); `markRunning`'s claim counts `attempt_count` (orchestration-side-effect-reactor.ts 1352 at 6c9ff950); `decide` via `ctx.newId` (the three ledger effects) | runner journal (dedup); the arm, through each transmission's `effect_outcome` (2.1 row 215) |
| A Run Effect's outcome and status | the outbox row (`provider_command_outbox`); its status machine is main's, each writer guarding its own SQL (3.12, D58) | each status writer listed in 3.12; the arm inserts only the three effects' rows (3.12) | the reactor (`nextPendingRequests`), U2's startup restore; never the arm, which reads only events (3.9) |
| Coverage (did Stop cover this run) | main's `stopCovers` over the committed Stop control row's `payload.stop.owners` (session-run-settlement.ts 98 at 6c9ff950), run whole (D58) | the engine's Stop acceptance | `stopCovers`: `holdRun`, the reactor's stop-owner read, runner retirement; the arm reads the stop commit's projected `interrupt.requested` (`commitControl`, orchestration-engine.ts 911-924 at 6c9ff950) only to bound the work outside its owners (L6) |
| Hold: `provider_runs.runner_id`, `held_transmission` | projection of `run.dispatched` and `run.released` | `run.dispatched`: `holdRun`, called only by the feeder; `run.released`: `release` (feeder path, reconciler, adoption) | stop, Settle, swap commit, holder queries; the decider reads hold facts as evidence (4.11) |
| Transmission count | the event stream (count of `run.dispatched` per `commandId`) for a runner-held start or steer; the outbox row's `attempt_count` for any other effect main issues | `holdRun`; `markRunning` | the cap: the only cap for a runner-held start or steer (4.8); `maxControlAttempts` for a control (orchestration-side-effect-reactor.ts 274, 1365 at 6c9ff950) |
| Run end for a retired runner's runs | main's retirement settlement, run whole (D58): per-send Send Settlement at Gone, and `settleRuns` for legacy or sendless owners | the reconciler (`settlement.commit`, runner-retirement.ts 855-910 at 6c9ff950; `settleRuns`, runner-retirement.ts 932-943 at 6c9ff950) | prune (6.8); the arm folds its projected terminals |
| `delivery_indeterminate`, runner-held rows | the reconciler's Settle | Settle only | reactor; the decider reads it as a hold fact (4.11) |
| `delivery_indeterminate`, direct-provider rows | the reactor's marker (D58) | reactor only | reactor; the arm folds only its evidence event (2.1, 3.9) |
| `runnerId` | daemon | spawn | runner record, logs |
| `querySeq` and the current query | runner host | host | the ledger reads the label only |
| Who may write for a runner (grant tag) | `RunnerAuthority`, in memory | `adopt`, `revoke` | `guarded`; never copied |
| Serving runner of a session | `claude_runner_cursors.role` (partial unique index) | lifecycle module's register, retire and swap transactions (`register`, `requestStop`) | `serving(session)` (routing cache only); write decisions read the row in their transaction |
| Runner role inside the host | runner host (`decideRunnerRole`) | host | reply to `upgrade-retire`, idle exit; not persisted |
| Runner retired (fence) | retirement row `retired_at` | the runner receipt store: `requestStop`, `commitStop` and `commitRetirement`, each first set appending `process_lost` in its transaction (6.5) | attach, `adopt`, `holdRun`, recovery |
| Feeder queue and per-send I/O capabilities | the session's feeder | enqueue by reactor dispatch, committed release and restart; the feeder consumes each write capability once | live handle or `Adopted`; the released-through watermark revokes local I/O only, never persisted delivery or runner assignment; the stop commit's possibly-written set (4.5; a hold an earlier daemon made has no written bit and is in it) |
| Per-operation pacing ordinal | the pending store operation | its release/settlement owner, or the failed read's caller | 4.8's backoff only; reset on commit or staleness, never run liveness or transmission count |
| `awaitRun` subscription | the live caller | arm the store's commit signal, then re-read the run | includes silent lifecycle commits; no waiter map |
| Uncommitted Stop intent (`Committing`) | the reconciler | intent registration and its independently owned commit worker | Stop waiters; identity only, never a durable retirement record |
| Retained release/settlement evidence | the evidence source's write owner | feeder write fiber for a release outside a stop commit (including a refusal's release once its stop leaves `Committing`, 4.5) or start-refusal settlement; the reconciler for a release a stop commit carries (6.3); reactor call for a live reply; reconciler cadence for Settle; attachment for adoption and retained replies | retained until commit or staleness; adoption release failure propagates through bounded attachment recovery, then retirement and Settle |
| Stop progress (`RunnerStop`) | reconciler module (`runner-retirement.ts`) | the reconciler only | `state`, `awaitStop`, the write fiber's gate (4.4) (memory is a cache of the row) |
| Connection receipt order (`command-accepted`, `idle-exit` and refusals as read, per connection) | the runner connection, in memory | the daemon's connection reader only | the stop commit's release evidence (4.5, 6.3); gone with the connection |
| Group snapshot and signal log | retirement row | the reconciler's kill routine | restart recovery |
| Survivor notice sent | the deterministic notice event id | reconciler | none |
| Duplicate sends at the host | host send journal | host | journal answers to the daemon |
| Per-send daemon resources | the send's scope, a child of the provider instance's scope | finalizers registered at allocation | none |
| A runner entry's memory (waiters, the close of its dispatched sends) | the runner entry's scope | closed by the stop commit's post-commit step (6.11) and daemon shutdown | none |
| A send's runner assignment | send module (`Assignment`) | `dispatch`, `requeue` | every action on the send, via its handle |
| Opening send handles | provider instance | its one admission | none |
| Replay cursor and attachment | runner's cursor row | receipt store | none |
| Registration (socket, pid; identity only) | runner host's `.json` | host | discovery only; never evidence |
| Tasks, wake Runs, process facts, lost work, pending confirms, native command delivery | Run Ledger | the arm (3.9) | `SessionActivity` (read-only view) |
| Servers (per session) | Run Ledger | PortWatcher (`server_seen`, `server_gone`); declared marks through the CLI (8.7) | `SessionActivity`, `anythingMayAct`, auto-settle, Preview Gate, chat links |
| Server hold candidates (seen under 10s), first-scan readiness | PortWatcher, in memory | PortWatcher | auto-settle reads readiness; a candidate is never a server |
| Conduit's `tailscale serve` ports and gate proxies | Preview Gate | the gate only | none; reconciled to Servers, never evidence |
| Goal: confirmed status and pending action id | goal tracker | tracker | `SessionActivity` |
| Native command confirmation deadline | Run Ledger (ordinary deadline) | `reconcile` | tracker reacts to `unconfirmed` |
| Per-session ledger row (`alarmAt`, open work) | Run Ledger | written only when its value changes | scheduler |
| Liveness ("may anything still act") | Run Ledger (`anythingMayAct`) | derived | worktree sweep, archive and delete, status poller, runner record deletion |
| Host idle | runner host (`HostIdle`) | host | idle exit |

Each layer owns one identity: the daemon owns `runnerId`, the host owns `querySeq`, the issuer of
an effect owns its Send Tokens (main's `(commandId, n)` for every effect main issues, `holdRun`'s
`run.dispatched` minting a runner-held start or steer's `n`, and main's send commit or
`markRunning` every other's; the ledger's `ctx.newId` for the three it issues), the send module owns the assignment, the database
owns the serving runner.

<!-- src: RA §1, §2, §3, §8; AUDIT A2, A3, A4, A8; AUDIT-2 A19, A20, T11; SEND-SCOPE S1, S2; SEND-SCOPE-2 S5; SEND-SCOPE-3 S6; SEND-SCOPE-5 S8, S9.1; STOP-INTENT S1, S2, S3, S5; SWAP S5 refined, S7, M; CONT Data shape, C1, C2, C3; BG Decision 1; FB §1, §2; review 2026-10-28 (H1, H3, H4, H10, H11); model-gaps 2026-10-28; SETTLE Data shape, S1, S2, S3, S5, Verified requirements 5 -->

### 2.1 Deltas from main (D56)

Main's code at 1ba91324, with R2 at 6c9ff950, is the reference for every user-visible behaviour
main has, and every main unit runs whole (D58). The rows below are the only differences; any
other difference is a defect. Each row changes only the unit its Ticket cell names. The unit reads
the view in its own body, inside its write, before the statement it gates and after projecting any
event that statement depends on, and appends main's events or statuses itself; the ledger appends
none. A row that reads the view lands on 25scs, a child of the epic blocked by 32.3; a row of one provider
lands on that provider's ticket (32.6, 32.10, 32.11, 32.21); the core tickets stay public-interface
only. 32.2.17 replays each trace through main's stack and through the ledger's (12.2) and fails on
any difference in main's events, rows or provider calls that no row masks, and on a row that masks
no difference; each row is a typed mask there. Core state no user sees (durable Runs, the seal,
the fence, coverage) is normative; each user-visible effect of it is a row below. A row is named by
its number (rows 203, 204, 208 and 214 are deleted).

| Ledger rule | Main at 1ba91324 | Reason | Ticket |
|---|---|---|---|
| 202. A start issues only once no label has work (3.5): it waits with no clock before a Stop or Run now commit (L6, D54), and the ledger stop deadline bounds the work open at it with no open main run (L6, D59); `markRunning` reads the fence in the view before its claim, and the intake recall is deleted | its intake recall fails a start not taken in after `PROCESSING_TIMEOUT_DURATION` with `processing_timeout`, only when the recall's ack is `cancelled`, otherwise indeterminate (`processing_timeout`, orchestration-side-effect-reactor.ts 790-830; `PROCESSING_TIMEOUT_DURATION`, session-overrides-state.ts 62) | the fence removes the start that collides with a wake turn on the native session, so no start waits on a busy runtime; main's own gates hold where main holds (`turnInFlight`, session-inbox.ts 540-554; `stopping`, provider-turn-service.ts 336, at 1ba91324), and without the bound a hung wake would hold the fence, and so every later start, for good | 25scs: `markRunning` |
| 205. A Stop or Run now commit (L6) resolves an OpenCode interaction Pending on a label with work at that commit (3.10) | resolved only by OpenCode's reply event (`isPermissionRepliedEvent`, opencode-runtime-event-translator.ts 242-266) | OpenCode's abort carries no interaction, so nothing else would resolve it | 32.11: `acceptStopEffect` (`acceptStopEffect`, orchestration-engine.ts 658-669 at 6c9ff950), the commit of a Stop and Run now (`prepareStop`, provider-turn-service.ts 393), an `interrupt_turn` or `end_session` (`end_session`, orchestration-engine.ts 892-894), appends `permission.resolved` after projecting its commit and reading the view |
| 206. A steer that possibly reached the agent when a runner failure ended its Run is placed as sent and never re-sent (`message.created`, projectors-effect.ts 2526-2537 at 1ba91324; D53, F38, F39) | `requeueFailedSteers` returns it to the inbox front after the failure's `runner_stopped` `turn.error` (`requeueFailedSteers`, input-requeue-effect.ts 6-50; `runner_stopped`, provider-runtime-ingestion-service.ts 704-723 at 1ba91324; `admitted_at` MIN-1, projectors-effect.ts 2479-2522), paused (`input.requeued`, inbox-run-status-query.ts 34-46) | a value either reached the agent or is re-sent, never both; at most once | 25scs: `requeueFailedSteers`'s body appends the placement instead of `input.requeued` for a steer the view marks possibly reached (`persistEvents`, input-requeue-effect.ts 44-52 at 6c9ff950); every R2 call site runs that body (`requeueFailedSteers`, commit-and-signal.ts 559-571; `requeueFailedSteers`, session-inbox.ts 842; `requeueFailedSteers`, opencode-runtime-ingress-service.ts 1382), and its query skips a steer with a `messages` row (`messages`, input-requeue-effect.ts 35), so no later sweep requeues a placed steer |
| 207. A steer whose send fails is `failed`, final, with its text back in the composer (3.9): main's requeue and `input.cancelled`, the event main's Cancel arm writes (`input.cancelled`, projectors-effect.ts 2470-2477 at 1ba91324), are one `persistEvents` batch, so no restart sees one without the other; the requeue's pause stays main's (`input.requeued`, inbox-run-status-query.ts 34-46 at 1ba91324) | requeued to the inbox front, paused (`requeueFailedSteers`, input-requeue-effect.ts 6-50; `input.requeued`, projectors-effect.ts 2479-2522 at 1ba91324), in dispatch's own write (`requeueFailedSteers`, provider-turn-dispatch.ts 372 at 1ba91324) and at R2 in the failure's write (`requeueFailedSteers`, commit-and-signal.ts 559-571 at 6c9ff950) | S9.3 as amended: a failed send returns its text to the composer | 25scs: `requeueFailedSteers` takes a typed `{ cancelFinal: true }` option, passed by `commitAndSignal`'s call, and appends `input.cancelled` after the `input.requeued` of each steer the view marks final, in the same batch (`persistEvents`, input-requeue-effect.ts 44-52 at 6c9ff950) |
| 209. The busy-slash hold is deleted; a native command is never submitted to the inbox (8.1) | `steer` marks a slash command other than Codex's `/goal` and stops the turn (`interruptForInput`, session-inbox.ts 214-221) | the goal design (8.1, A4, A17, T4) | 32.26, 32.27: the inbox module (`interruptForInput`, session-inbox.ts 214-221); it reads no view |
| 210. A transient refusal or a declined start is tried again up to the cap (4.8) | retries silently only a runner's idle exit or abandoned recovery before `turn.accepted` (`runner_idle_exit`, process-session-runner.ts 3706-3713), and ends a declined start `interrupted`, neither placing nor requeuing its text (`steer-declined`, orchestration-side-effect-reactor.ts 948-949, 994-998; `sent_sequence`, session-inbox.ts 583-591) | a decline on a busy runtime is transient; the fence (3.5) removes its usual cause | 25scs: the reactor's outcome body (`recordSendReply`, orchestration-side-effect-reactor.ts 1065 at 6c9ff950) writes `retryable_failed` with main's backoff, under its own SQL guard (3.12) |
| 211. A start Claude reports `cancelled` before `started` is Stop's own and returned behind the pause by the reactor's outcome body, which appends `input.requeued` when the cancelled intake lands, in the same write (4.8, D53) | ends it `interrupted` with no retry and its text dropped (`cancelled`, claude-runner-payload.ts 2495-2522; `interrupted`, orchestration-side-effect-reactor.ts 896-966 at 1ba91324) | S9.3 as amended: a stopped input that did not reach the agent returns to the inbox | 25scs: the reactor's outcome body (`recordSendReply`, orchestration-side-effect-reactor.ts 1065-1100 at 6c9ff950) |
| 212. Tries within a reservation are capped at 5 (4.8) | caps controls, never a send (`maxControlAttempts`, orchestration-side-effect-reactor.ts 1216) | a send that always fails ends its input `failed` instead of looping | 25scs: `markRunning` reads the cap before its claim; 32.29: `holdRun`'s cap for a runner-held start or steer |
| 213. A destructive step past the stop's deadline asks the user first while tasks are live or unknown (8.4); after a restart U2's restore asks the same confirm, keyed by the Stop's command id | retires the process without asking (`retireProcess`, provider-turn-service.ts 251-284) | background tasks are lost with the process | 25scs: U2's `retireProcess` reads the view before it retires; 32.25: the confirm (8.4) |
| 215. Evidence events: each fact the arm needs that has no main event gets one, from its one observer (D59, 3.9): the write that writes main's terminal or status for that fact, or with none the write that ingests it: `process_started` (the lifecycle module's `register`, the swap commit's, 6.9, and OpenCode's reporter, 9), `process_lost` (each write that first sets a runner's `retired_at`, in its transaction, once per (runnerId, retiredAt), none for a runner whose session row is gone or has no project: `requestStop`'s raw write, `commitRetirement`'s raw upsert, and `persistRelease`'s `commitStop` inside the release commit; inside a `commitAndSignal` write it is projected with that write, and only a raw write appends it unprojected and marks the store for the next commit's recovery, 6.3, 6.5, 32.4; for OpenCode, `onInstanceStopped`'s `settleSessionRuns` batch, 9), `alarm_fired` (32.3's scheduler, a main-side fiber, 3.7), `effect_outcome` (each ledger effect's executor, with its status update; for every other effect main issues with no hold but a direct start, each writer of its row's outcome, sweeps included, naming the row's `command_id` and `attempt_count`, 0 when no claim reached it (3.4): `recordControlOutcome` where its guarded update changes the row (`recordControlOutcome`, orchestration-side-effect-reactor.ts 2276-2380 at 6c9ff950), and `markCompleted` and `writeFailure` on a non-send row, moved from their raw transaction into the reactor's `write` body, as `recordControlOutcome`'s is (2299), so the event is projected with its status; the refusal sweep, `drain`'s removed-project cancel and pending-prompt retirement, for each control row their update changes, in the write body they already run in (`refuseProjectCommand`, 2607-2642; `drain`, 432-445; `cancelControls`, retire-pending-prompts.ts 30-32, 145-163 at 6c9ff950)), `turn_started` (a Claude wake, where the payload sets `turnInFlight`, claude-runner-payload.ts 2187-2197 at 6c9ff950, while no send's `currentRunId` is set; a Codex successor), `turn_ended` (a Claude wake, at the payload's first clear of the `turnInFlight` its `turn_started` set; its result with no run, `endsCurrentRun`, 2301; its stream's end, `turnInFlight`, 2707; `cleanupSessionEffect`, 3089-3105; which a Stop with no foreground run reaches, `disposeSessionEffect`, 2763-2783 at 6c9ff950; the translator's `endTurn` when the wake's stream fails, claude-event-translator.ts 544-555 at 6c9ff950) and the direct `delivery_indeterminate` marker's event; main's projectors ignore them, and T2 masks them as one class | appends none: a Codex successor starts with no event (`executingTurnId`, codex-turn-lifecycle.ts 322-328 at 6c9ff950), a Claude wake sets and clears only its flag (`turnInFlight`, claude-runner-payload.ts 2187-2197, 2301, 2707, 3103 at 6c9ff950; the translator's `endTurn`, claude-event-translator.ts 544-555 at 6c9ff950), the direct marker writes no event (`delivery_indeterminate`, orchestration-side-effect-reactor.ts 916-955 at 6c9ff950), a runner's retirement sets `retired_at` with no event (`saveStop`, runner-receipts.ts 407-412 at 6c9ff950), a control's outcome writes only its outbox row and receipt (`markCompleted`, orchestration-side-effect-reactor.ts 2253-2274; `recordControlOutcome`, 2276-2380; `writeFailure`, 2753-2783 at 6c9ff950), as does a sweep that ends a control row (`refuseProjectCommand`, orchestration-side-effect-reactor.ts 2556-2660; `drain`, 385-470; `cancelControls`, retire-pending-prompts.ts 23, 145-163 at 6c9ff950), and a managed OpenCode stop settles its runs with no loss event (`settleSessionRuns`, opencode-runtime-ingress-service.ts 1758-1795 at 6c9ff950) | the arm reads only projected events (3.9) | 32.3: a runner's `process_started`, `alarm_fired`, `effect_outcome` (the three ledger effects' and every control's, a sweep's included; a native command's from its executor, 8.5); 32.4: `process_lost` (6.5); 32.6: a Claude wake's `turn_started` and `turn_ended`, and the swap commit's `process_started`; 32.21: a Codex successor; 32.11: OpenCode's `process_started`, `onInstanceStopped`'s `process_lost`, and the direct marker |
| 216. Ledger effects: the reactor gains one executor per ledger effect (`probe`, `stop_task`, `cancel_request`) and a wake after the commit that inserts one, through the write's `afterCommit` (as `SettlementTx`'s `afterCommit`, orchestration-side-effect-reactor.ts 1088-1100 at 6c9ff950); the three are exempt from the session lane and from `armRetryWake` (3.12); T2 masks their three provider calls | rejects an effect type it has no executor for (`unknown_provider_command_effect`, orchestration-side-effect-reactor.ts 2108-2118 at 6c9ff950) and holds a row behind any earlier same-session row (`earlier`, orchestration-side-effect-reactor.ts 1292-1336 at 6c9ff950) | label work and lost work end only by these effects (3.5, 8.3) | 32.3: the reactor |

Main already appends the terminal of every Run end the ledger decides: a retired runner's runs end
through main's retirement settlement, per-send Send Settlement at Gone (`settlement.commit`,
runner-retirement.ts 855-910 at 6c9ff950), and `settleRuns` for legacy or sendless owners
(`settleRuns`, runner-retirement.ts 932-943 at 6c9ff950); an unlaunched start returns by the
projected `run.released`, or `requeueLegacySend` for a legacy send (`requeueLegacySend`,
send-settlement-outbox.ts 511-529 at 6c9ff950), so no row adds a writer for them. Work of a Run
with an open main run is main's alone (D59): it ends as main, and the ledger's stop deadline
reaches only work with none (a wake execution, or a send whose run main has ended, L6), which
needs no main terminal. One exception: an OpenCode process lost by a crash, a replacement or a URL
change ends its Runs `process lost` in the ledger at the next id's `process_started` (L1, 9), while
main settles them nowhere and leaves them open.

<!-- src: REDESIGN-8 (D56: main's code is the reference, deltas only; R7 r3 found the record of main incomplete, poteto r3 P2-1, and the pause anchored apart from main, ub r3 P1-1; main restores its Stop entries after a restart from durable outbox rows, provider-turn-service.ts 376-405 at 1ba91324, so restart durability is no delta); REDESIGN-8 r2 (the Codex and Cursor wake row deleted, D51 `busy` as main; the header claims only what T2 compares; row 203's reason and empty stop, row 207's pause, row 213's tickets; ub r2 P1-2, P3-1, P3-2, poteto r2 P2-3, P2-7, P3-4, P3-11); REDESIGN-9 (D57: rows are typed masks in the wire replay, A.19 T2; row 206 narrowed to a runner failure with a possibly reached steer; rows 207 and 211 name main's writer; row 209 never submits a native command; ub r3 P1-1, poteto r3 P1-1); REDESIGN-9 r1 (T2 compares the read surface and the seam's calls; row 206's main side is `requeueFailedSteers` at the front after `runner_stopped`, provider-runtime-ingestion-service.ts 704-723 at 1ba91324; row 207 names `input.cancelled` as the Cancel arm's event, its stop-term restatement deleted; poteto r1 P1-2, P3-5, P3-7, ub r1 P2-3); REDESIGN-10 (D58: each row's Ticket cell names the unit it changes; the unit reads the ledger view in its own body and appends main's events itself; R9 r3 ub P2-A, poteto P1-1, ub P2-D, P2-E); REDESIGN-10 r1 (the view is read before the statement it gates; rows 206, 207 and 211 in one write; rows 214 to 216 and the terminal line added; cells move to 25scs; ub r1 P1-b, P1-c, P2-1, P2-4, P2-5, P2-6, P2-9, poteto r1 P1-1, P2-1, P2-3, P2-4, P2-10, P2-11); REDESIGN-11 (D59: rows 203, 204 and 214 deleted, row 202 bounded at its commit's `deadlineAt`, row 205 on a label with work at the commit, row 215 from one observer per fact, the OpenCode exception; ub R10 r3 F-B, F-C, F-A, F-F, poteto r3 F1, F3, P3-2) -->

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
- `decide` is pure, never throws and never mutates. A rejection leaves state unchanged and carries
  a diagnostic. Stale evidence is Accepted with no events, no effects and no terminals. An Accepted
  decision may carry a diagnostic.
- In production an illegal transition rejects that input, records a diagnostic and leaves the Run
  unchanged; its evidence, coverage or the user's Stop (L6) still ends it. Tests treat any
  illegal transition on valid input as a failure.
- One active Run per session, enforced by the decider. A violation is a diagnostic, a log line and
  never an event, and never fails main's write.
- **Transactions (one permit, D58).** `decide` runs in the body of the main write that records
  its evidence: the ledger's projector arm runs `decide` and `evolve` inside that body's `project`,
  in its transaction, under the one write permit, so the event store and the ledger never disagree
  after a crash. In-memory caches update after COMMIT and before the permit is released. External
  effects (sends, signals, browser pushes) run after the release. A rollback discards the decision.
- The arm opens no transaction and calls no main function, so it never meets
  `NestedCommitAndSignal` or `ProjectOutsideSeamTransaction` (commit-and-signal.ts 49-50, 67-68 at
  1ba91324). During replay (`replaying`, projectors-effect.ts 45 at 1ba91324) the arm folds and
  inserts no outbox row.
- There is no version check, no retry loop and no `LedgerConflict`: with one permit a concurrent
  ledger writer cannot exist.

<!-- src: C0 Interface; SPEC Implementation Decisions (Run Ledger module, Decider, One active run, Illegal transitions); FB §1, §2 (model changes); AUDIT A5; AUDIT-2 A14; REDESIGN-10 r1 (the four verbs and `record` deleted, the arm is the only caller; the uniqueness constraint deleted, a violation is a log line; ub r1 P3-5, poteto r1 P2-13) -->

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
  the unit that appends the event, never by `decide`) and **decision rules** (plain data and pure predicates: what
  ends a Run, what fences, what an idle probe proves, when work has ended). The stop's deadline
  step is U2's and the ledger stop deadline's alarm is the same for every provider (L6), so the
  policy holds no stop rule. The
  decider asks the policy and never names a provider. The terminal classifier belongs to the policy;
  there is one.
- Every decision runs in three phases: record facts, recompute views, act only on views.

<!-- src: FB §1, §3; C0 §3; OW Decision 3, rider L; SPEC Implementation Decisions (Decider); REDESIGN-7 (the policy's rule is the stop's deadline step, L6); build round 1 (M2: the policy's stop rule deleted, D54) -->

### 3.3 Stored state

Only evidence and conduit's decisions, each once:

- **Session:** id, provider, an entry counter, stop and end decisions and session-ended
  evidence. Paused is derived (3.9). The ledger holds no project state (3.11).
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
- **Admission:** input and priority; a cancel is main's Cancel arm (D55).
  **Interaction:** request evidence, an answer decision
  (first wins; user or timeout), resolved evidence.
- **Background facts:** process state per runner (L1), the latest task snapshot per runner with
  its label, task events, lost-work records, pending confirms, native command sends (section 8).
- **Labels, not generations.** The ledger never mints or bumps a generation. It records
  `process_started`, `process_lost` and query-ended evidence, each naming the host's label. For a
  runner-held provider (Claude, Codex, Cursor), a query ending covers that label's `interrupt`
  sends; it never ends `start` or `steer` work, which ends only by its provider's
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
  `process_lost`; another runner's `process_started` (only for
  totality: the host reports the loss first, H1, 6.9; it counts as the `process_lost` of every
  other runner, started or not). Retired is final: its labels are older (item 4), so its later
  `process_started` changes nothing, and a host never reuses a `runnerId` (6.1, 9). So a later
  `process_started` of a live runner is the same process reattached: it raises the latest
  `querySeq`, settles tasks as its `reattached` flag says (8.3) and retires nothing; one at or
  below the latest `querySeq` is an older label and changes nothing. Evidence under the label of
  a runner not started has no authority (3.4): it is recorded with a diagnostic and changes
  nothing. The current process is the one live runner, if any. Retiring, in the same decision:
  1. covers every send addressed to it, whatever its tries got (a
     `not_sent` try changes no address, H4), with cause `process lost` (3.5);
  2. ends its wake executions;
  3. records lost work (L5, 8.4);
  4. makes its labels older (3.4).

  Retiring moves no Run itself: a Run moves only once its sends are sealed (3.6, 3.8). A stop
  commit's releases (4.5) precede its `process_lost` in that transaction and are read first, each
  as its `run_released`, so a Run they leave not yet delivered relaunches after item 4 and its
  start addresses the next runner (L2).
- **L2. Address at issue.** Every send is addressed once, when it issues, and never re-addressed:
  1. an escalation (U2's retire `end_session`, L6) whose parent has a runner address goes to that
     runner;
  2. a send for a Run or wake Run with an execution, on a runner-host provider (Claude, Codex,
     Cursor, 4.10), goes to that execution's runner
     (3.3 Execution; pending while a start is, below);
  3. every other send goes to the current process, or to **pending** when there is none. An
     escalation of a parent still pending is this case, and is pending too: an uncovered pending
     parent means no `process_started` since it issued, and a covered one has no deadline left
     to escalate. Every OpenCode send is case 3.

  A pending send resolves, once, at the first of: its own `run_dispatched` (a held send, the one
  3.4 binds to it), to the runner it names, which covers it at once if that runner is retired; or
  the next `process_started`, to that runner. A case 2 send follows its execution's start: it is
  pending while the start is, and resolves with it, to the same runner. The sends of an
  execution dropped by an unlaunch (3.6) resolve no further: no later `run_dispatched` or
  `process_started` addresses them. Their work has already ended, so coverage of them (L1 item 1)
  changes nothing.
  The label fixed with an address is the runner's latest label when the address is fixed; a
  `run_dispatched` naming a runner with no `process_started` yet fixes the label of that runner's
  `process_started`. A send is covered when its address is retired, or by session end (3.4). Coverage is
  derived, never stored per send.
- **Wire label.** Only `end_session` carries a label (3.13). It projects the
  address: it carries its runner's latest label, or null while its address has no label yet
  (pending, or a runner not started). Other effects carry no label; their address
  lives only on the Send.
- **`hasAuthority(execution)`:** the execution is its Run's current one, the Run is not Ended, its
  runner is live (L1), and its native session has not ended. This is the
  single read of Ended.
- Native message id (6C): immutable once known. Evidence that contradicts it is rejected with a
  diagnostic and no state change. A missing id is filled from evidence. Where a provider accepts a
  client-chosen id, the ledger pre-assigns it.
- No in-session pruning. Run Input records, interaction records and send history are kept for the
  session's life and reclaimed when the session is archived.

<!-- src: FB §2; RA §7; HLK step 4, step 5; BG Decision 1, Decision 3; AUDIT-2 T6; review 2026-10-28 (H2); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L1, L2; REDESIGN review r1-1 (03-rewrite-gap-decisions.md); REDESIGN review r1-2; REDESIGN review r2-1; REDESIGN review r2-2 (label split); REDESIGN review r3-1 (runner not started, authority at record); REDESIGN oracle r8; REDESIGN harness r9 (L2 case 2); contract r15 (D50); REDESIGN-6 r1 (admission cancel points to D55; poteto r1 P3-4); REDESIGN-7 (`close` deleted from the effects, L2 item 1 and the wire label) -->

### 3.4 Correlation and evidence

- Every transmission of a Run Effect has a fresh Send Token, and whoever issues the effect names
  its transmissions, as main names its Run ids (below). Decide issues only `probe`, `stop_task` and
  `cancel_request` (3.12), each a `Tokened` `IssuedEffect` whose token `ctx.newId` mints. Main
  issues every other effect (D60), which the arm folds into `live` as a `Main` `IssuedEffect` named
  by its `commandId` (3.13), each transmission by main's `(commandId, n)` (below). A retry is a new
  transmission with a new token. Each transmission has one observer (D59). The arm folds
  `run.dispatched` (a hold) as a runner-held send's transmission, `holdRun` minting `n`, and
  `run.requested` (a fresh claim) as a direct send's (OpenCode: the session's driver sets
  `runsOpenCodeServer`, provider-instance.ts 145 at 6c9ff950; read as `runsOpenCodeServer`,
  orchestration-engine.ts 749-751 at 6c9ff950), its token that runId. A runner-held send's
  `run.requested` names the ledger Run its input belongs to and is no transmission; its try before
  any hold has no token (below). A claim whose run is still open writes no event and is not a
  transmission (3.9 item 1).
- **A Run's id is main's.** A user Run's id is the `runId` of the `run.requested` that reserves it:
  main mints it with the send's run (orchestration-command-commit.ts 308-310;
  `markRunning`, orchestration-side-effect-reactor.ts 1338-1345 at 6c9ff950) and appends it after
  `input.sent` in the same write (orchestration-command-commit.ts 206-239 at 6c9ff950), so the
  Run is reserved there, never at admit. A later `run.requested` for an input its Run still
  holds (main's retry on a fresh run, 4.8) reserves nothing and names that Run too; main
  observations and hold facts name a Run by any of its ids, and an unknown one is Accepted with no
  events and a diagnostic. A steer's own Run takes the steer's `runId` (3.9). `ctx.newId` mints
  only a wake Run's id (it has no main run, 8.3) and the tokens of the three effects decide issues.
- The token is an opaque host string, never parsed. `run_dispatched{runId, runnerId, commandId,
  transmission}` binds it: `runId` names the Run (`holdRun`'s owner run, `joined_into` or its
  own, runner-retirement.ts 135-205, 270-282 at 6c9ff950), and `commandId` names the issue in that
  Run, the start or steer of the input whose id it is, as main's send `commandId` is its input id
  (provider-turn-dispatch.ts 679, 853-856; orchestration-command-commit.ts 340-344 at 6c9ff950);
  redispatch of an already-bound issue included. A `commandId` reissued keeps its
  count within its input's reservation (4.8), and a transmission belongs to the latest issue of its
  `commandId` before it was held; one naming a retired runner belongs to the latest issue before
  that runner retired, or to none (an unknown token, below), since no hold is written on a
  retired runner (4.3). Each transmission has its own token and chains; the issue folds over its
  transmissions. `holdRun` alone applies the cap (4.3, 4.11). A runner-held try that ends before any
  hold (a start failure, `StartLost`, a gate answer) has no token: the host names it by its queue
  key's `runId` and `commandId` in `unheld_outcome` (3.13, 4.4, 4.11). It belongs to that Run's
  latest issue of that `commandId`, the one the feeder stepped (it steps one key at a time); with
  no such issue it is an unknown token (below), and for an Ended Run it is late evidence (3.8),
  never another Run's. `unheld_outcome` reads as that try's `effect_outcome` (3.5).
- **An effect main issues with no hold** (`interrupt`, `end_session`, `deliver_answer`,
  `send_native_command`; a direct start is named by its `run.requested` runId, above) is named by
  its outbox row. Its `commandId` is the row's `command_id`, which its commit's event carries
  (`metadata`, orchestration-command-commit.ts 67 at 6c9ff950) and its Control names
  (3.13). Its transmission `n` is the row's `attempt_count`, which each `markRunning` claim
  increments under a guard on the count it read (orchestration-side-effect-reactor.ts 1352, 1364
  at 6c9ff950). A control's commit writes one row under the `command_id` main gave it
  (`commitControl`, orchestration-command-commit.ts 39, 149-160 at 6c9ff950) and is immutable, so
  that `command_id` has one row (207-223), and a recommit carries its `command_id`'s highest count
  forward (295, 324), so a `(commandId, n)` never repeats. So each row is its own issue under its
  own `command_id`, and a Control names only the row its own commit writes: a later row a step
  causes (`end`'s `end_session` after its Stop, U2's retire) is another commit, folded as its own
  Control under the `command_id` main gave that row, which the ledger never derives (8.4). Every
  writer of its row's outcome appends `effect_outcome` naming the row's `command_id` and
  `attempt_count`, with the status it
  writes (2.1 row 215): `completed` reads `succeeded`; `retryable_failed`, `retryable` with
  `retryAt` its `next_attempt_at` and `code` its `error_code`; `failed` or `cancelled`, `permanent`
  with its `error_code`. Its writers are the executor's (`recordControlOutcome`,
  orchestration-side-effect-reactor.ts 2276-2380; `markCompleted`, 2253-2274; `writeFailure`,
  2753-2783 at 6c9ff950) and every sweep that ends an open control row: the refusal sweep
  (`refuseProjectCommand`, 2556-2660), `drain`'s removed-project cancel (431-449) and pending-prompt
  retirement (`cancelControls`, retire-pending-prompts.ts 23, 145-163 at 6c9ff950). So no issue
  stays in `live` after its row ends. Main's project gate runs before its claim and writes nothing
  while the project is not served (`executeRow`, orchestration-side-effect-reactor.ts 782, 794-803,
  before `markRunning` at 815-822 at 6c9ff950), and a claim made before an outage waits inside it
  (`runProviderEffect`, 1440-1456), so no row main's executor runs, a direct start's included,
  gets a `not_sent`: such a try shows nothing and counts nothing (H4), and a `not_sent` or
  `delivery_unknown` outcome naming a transmission is evidence its send cannot produce (below).
  The host composes the token from the pair, as from `run.dispatched`'s. A claim appends no event,
  so a transmission shows only at its outcome, and
  its issue may still act until then (3.5). An outcome written with no live claim (the control
  budget's exhaustion, 698-710, or a sweep of a row not `running`) names the latest claimed
  transmission; another outcome on a transmission joins its chains (3.5). A row no claim reached
  has `attempt_count` 0, so its outcome names `(commandId, 0)`. n 0 names no transmission and needs
  no claim: the arm finds the issue by `commandId` alone and ends it never transmitted (never
  handed over, 3.6), adding no chain. It is never an unknown token (below): an n 0 outcome is
  unknown only when its `commandId` names no issue. No other write ends a
  control row: `acceptStopEffect`'s DELETE and the Run's end touch only send rows
  (orchestration-engine.ts 858; projectors-effect.ts 1774 at 6c9ff950), and a recommit's delete
  never meets a control, whose commit is immutable. `attempt_count` is the one count of these
  transmissions; OPEN-2's rejected second count is one beside `run.dispatched` (4.11).
- An observation **answers** a send (it names that send's token), is **unsolicited**
  (it names only the host label and an event id) or is main's (below). Unsolicited observations are background
  snapshots and task events, a turn start (a wake execution), process events, an
  `interaction_requested` and every `interaction_resolved`, native or confirming an answer (an
  interaction is its label's, 3.10), a native command's `command_lifecycle` and `command_result`,
  named by its `commandId` (8.5), and `activity`, `result`, `query_ended` for a wake execution
  (8.3). A control main issues (`interrupt`, `end_session`, `deliver_answer`,
  `send_native_command`) is answered only by its `effect_outcome` (D61): the resolution of an
  answer's interaction and a native command's receipts name that interaction or command,
  never a transmission, so they read the same before or after that outcome, which alone shows a
  claim (above). No fictitious send is minted. An
  unsolicited observation's identity is its (label, event id) pair; a repeat of the same pair
  is Accepted with no events. Event ids are unique only within a label. Main's run events the arm
  folds, `run.requested` (above), `run.started` (3.9) and main's terminals (3.9, L6), are **main**
  observations, named by main's event id, a repeat Accepted with no events (D60): decide reads
  them and issues no start or steer (3.12).
- Which token an answer names: `started`, `activity`, `query_ended` name the latest start or steer
  transmission delivered on that native query. A `result` naming an input (Claude) names that
  input's send; one naming none is its label's outstanding wake execution's, unsolicited (8.3),
  and with none it names each start and steer that has `started` on that query and no result
  yet, as main ends its current turn's run, steers joined to it included
  (claude-runner-payload.ts 1830-1834, 2262-2297 at 1ba91324). `input_accepted`,
  `input_declined`, `accounting` name the start or steer that carried that input; `effect_outcome` names the effect's own token;
  `probe_result` names the probe's token; its target is read from the issued probe record named by
  that token. The execution is found through the send.
- Lifecycle evidence is always recorded as a fact on the chains of the send it answers, with or
  without authority: `started` and `activity` are Observed. It changes Run state only when,
  in the decision that records it, the send it answers (if any) is not covered (L2) and
  `hasAuthority` holds for its execution; a fact recorded without authority never changes Run state
  later.
- Receipt evidence (input acceptance and decline, accounting, input probe findings) updates only
  the record `receiptAddress(token)` names, and never changes or revives Run lifecycle.
- An unknown or never-issued token: Accepted, no events, a diagnostic. Evidence of a kind the send
  or its provider cannot produce (task evidence from Cursor or OpenCode, 8.1; `command_lifecycle`
  from any provider but Claude, 9, D46; `turn_ended` from any provider but Claude, 2.1 row 215,
  8.3; any but `effect_outcome` on a control main issues, D61), a contradicting
  native id, or a command receipt naming another commandId (D21):
  Rejected, a diagnostic, no state change. A Send Token carries no kind, so this check is
  decide's, never the type's (3.13). No throws
  and no new error types.
- Hold facts (`run_dispatched`, `run_released`, `delivery_indeterminate`, `runner_reply`,
  `journal_answer`) on a send with no hold are Rejected as evidence the send cannot produce.
- **Older labels (L1.4).** A label is older when its runner is retired (L1, 3.3) or its `querySeq`
  is below the latest seen for that runner. Older-label evidence is recorded only where it changes
  a join (3.8), and never gives authority, liveness or a wake Run. A send's own label is never
  older for that send.
- Freshness compares issue order of sends. There are no version counters. A native-session idle
  probe covers only sends issued before it, and only where the native policy can prove the covered
  work can no longer execute.
- Session end (an `end_session` success, `session_ended` (native session vanished; no producer at
  1ba91324 or 6c9ff950, so unbuilt), or a rejected resume, 3.6, which shows the native session is
  gone) ends the native session at that fact. An `end_session` success covers the sends of it issued
  before that `end_session` was issued; `session_ended` and a rejected resume cover those issued
  before the fact; probes included, with cause `session ended` (3.5). Unlike an idle probe it needs
  no proof from the native policy: nothing acts in an ended native session. Admission does not wait
  for an `end_session` in flight: from its issue, and after any session end, it issues `fresh`
  (4.8), so no later send is in the native session being ended.
- A usage limit ends no native session. A same-driver failover rebinds the same runner's query on
  the next send only once that runner holds no input (otherwise `account_switch_busy`, retryable;
  runner-entry-lifecycle.ts 144-176, claude-runner-payload.ts 1103-1129 at 1ba91324), and its
  continuation resumes the native session, falling back to `fresh` only on a rejected resume
  (prepare-turn.ts 166, 185, 207-220); a cross-driver one ends the old session by its `end_session`
  (continuation.ts 690-700). The cut-off Run ends by its result, and the other held tries seal at
  their own answers (3.6).
- Native `run_id` order is unproven. Code must not assume it sorts by time; use arrival order, or
  cite evidence that it sorts.

<!-- src: C0 §1; MODEL Observation doc comment; AUDIT-2 T7, Other changes (run_id); AUDIT A11; OW Decision 3; FB §4; HLK step 1, Rules not tied to one step (9B); review 2026-10-28 (H1); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L1.4; REDESIGN review r3-2 (retired send in the authority test); REDESIGN harness r12; REDESIGN-2 (D48); contract r15 (D49); contract r16 (gap 3, session end; D50 dropped sends); REDESIGN-4 r1 (end_session window from its issue; ub P1-1); REDESIGN-4 r2 (a usage limit is no session end, host facts at 1ba91324; `session_ended` unbuilt; ub P1-1, poteto P1-A; 3.4:387 restatement removed, poteto removable); REDESIGN-6 (a `result` naming no input is the outstanding wake's, else the latest start or steer, as main maps it, claude-runner-payload.ts 2274-2297 at 1ba91324; poteto r3 P2-1); REDESIGN-6 r1 (idle ends work by L6's End; ub r1 P3-4); REDESIGN-6 r2 (interactions unsolicited and their label's; a uuid-less result ends every started send with no result, as main's current run; ub r2 P1-3, P2-6, poteto r2 P1-2, P2-2) -->

### 3.5 Send chains and the views over them

Each transmission has two chains; each merges by join (maximum):

- **Transport:** Issued < Retrying{earliest at} < Failed{lowest code} < Unknown < Sent. A success
  always beats a failure.
- **Consumption:** None < NotConsumed{declined | absent | released | cancelled} < Observed <
  Accepted. `cancelled` is Claude's `cancelled` before `started`, Stop's own (9).
  Acceptance is proof, so it beats an earlier "absent".

Transport and consumption stay separate unions; they are never merged into one machine.

`effect_outcome` maps onto transport: succeeded to Sent, `delivery_unknown` to Unknown, retryable
and `not_sent` to Retrying{at}, permanent to Failed{code}. A `not_sent` try never left conduit
(H4): its consumption stays None, so its own work has ended (below), and it counts toward no cap
(4.8).

**Work ended** is derived: by the execution's evidence under the policy's work-ended rule (a
Claude wake's `turn_ended`, not forced, 8.3), a
covering idle probe the policy trusts, or the send's own outcome (`mayStillAct` no, below); by its
send's coverage (L1, L2, 3.3), cause `process lost` for a retirement and
`session ended` for a session end (3.4); or by an unlaunch dropping its execution (3.6). Coverage
and a drop are work-ended facts only, as is the stop's deadline step (L6): later evidence on the send is recorded as a fact and never
makes it act again, hold the fence or hold a deadline. Neither says whether the agent got the
transmission (3.6). A `stop_task`'s work is its task (8.4): it ends when the task view holds
that task neither live nor unknown (8.3).

`mayStillAct`:

| Consumption | Issued, Unknown, Sent | Retrying, Failed |
| --- | --- | --- |
| work ended | no | no |
| Accepted, Observed | yes | yes |
| NotConsumed | no | no |
| None | yes | no |

- `fenceHolds(nativeSession)`: some label of it has work (L6, 3.7). Membership is per send and wake
  execution (section 9); an admission's outcome never releases it.
- `inputOutcome(admission)`: a fold over that admission's sends. Accepted if any send was accepted;
  refused only when every send ended with no acceptance.
- `receiptAddress(token)`: the record a receipt may update.
- Precedence, inside the views only: native completion beats acceptance; a release is
  NotConsumed{released}, which a later acceptance beats (the join above); acceptance beats a transport
  failure; `delivery_unknown` with no later proof keeps work
  outstanding until a probe settles it or its work ends (a `stop_task` is never probed, 8.4).
  Neither Unknown nor Sent implies Accepted.
- A retryable outcome with consumption None ends that send's work; Observed or Accepted keeps it
  (the table above). A sibling's unsettled
  `delivery_unknown` blocks automatic resend until a probe settles it.
- A refused sibling never releases the fence or ends an interrupt while other work of the same
  admission may still act.

For a runner-held send these chains are never stored: they are a view over the hold events
(section 4.11).

<!-- src: FB §3, §4; OW Decision 2, 3, 4; AUDIT-2 T8, Over-engineering not done; HLK step 3; model-gaps 2026-10-28; REDESIGN harness r12; contract r16 (work ended, one test, refused); REDESIGN-4 r2 (NotConsumed{released}; a release beats acceptance, ub P3-1; poteto P2-E); REDESIGN-5 r2 (NotConsumed{cancelled}; ub r2 F-F); REDESIGN-6 r1 (exhaustion a work-ended fact; poteto r1 P1-B); REDESIGN-6 r2 (exhaustion launches the Queued Run the label blocks, `fence unconfirmed` gone; poteto r2 P2-3) -->

### 3.6 Run machine

- Moved only by `reconcile`, from what main issued and the arm folded into `live` (D60, 3.4):
  reserve to Queued (only with no active Run); launch to Launched (a new execution, at main's start
  entering `live`; the only fold reset); unlaunch back to Queued (below); interrupt to Interrupting
  (Stop's interrupt, only while something of the Run may still act, 5.1); tombstone to
  Ended (absorbing; outcome from the fold at that moment); a wake Run (8.3) and a steer's Run of
  its own (3.9) are recorded Launched outside it, with no start effect.
- **Reached the agent (the one test).** Each transmission has one of three values, read from its
  chains (3.5):
  - **never handed over:** no try of it left conduit (a `not_sent` try, H4; a runner-held try with
    no hold row when it ended or when its runner retired, 3.4), or a release (4.5) or a rejected
    resume shows the host never handed it to the agent. A rejected resume is `run_released
    ResumeRejected` or `effect_outcome` permanent `native_resume_rejected`; a rule on permanent
    outcomes excludes it by name ("a permanent outcome other than a rejected resume"). An issue
    main ended before any claim (its outcome names n 0, 3.4) has no transmission, so none reached.
  - **reached:** consumption Observed or Accepted.
  - **possibly reached:** any other, an issued try with no outcome and a held one with no release
    included. One with consumption NotConsumed{declined | absent | cancelled} (a decline, an absent finding or
    Claude's `cancelled` before `started`, 9),
    or None with a retryable or permanent outcome, is **unconsumed**: a later acceptance still beats
    it (3.5).

  A send takes its strongest transmission's value (reached, then possibly reached, then never
  handed over); a send with no transmission is never handed over. It is unconsumed when that
  value is possibly reached and each of its possibly reached transmissions is unconsumed. An
  execution reached the agent when it has execution evidence (3.3) or a reached send; it was never
  handed over when each of its sends was; otherwise it possibly reached. A release or a rejected
  resume is a fact about its transmission (4.5, 4.8), not lifecycle evidence (3.4). Coverage and a
  drop end a transmission's work (3.5) and, like a lack of authority (3.3), never change its
  value. Every rule on
  delivery cites this test (3.8, 3.9, 4.8, 5.1, 6.5).
- **Sealed (D52).** A transmission is sealed at the first of these recorded facts, and at no
  other: it reached the agent; it has an outcome, a release or a receipt (a hold alone is not one;
  for a runner-held try, its `runner_reply`, its `delivery_indeterminate` marker and a journal
  answer other than `uncertain` are, 4.11); or its runner (the one its hold names, else its
  address, L2) has its `process_lost` recorded, that stop commit's releases read first (4.5;
  another runner's `process_started` counts, carrying none, L1). A send is sealed when its latest
  transmission is; a send with none once a try of it has ended before transmitting (H4, 3.4) or
  its Run's Stop, Run now or `end` has committed, so `holdRun` returns `Covered` (4.3). A retry issues
  only after an outcome or release sealed the latest transmission, so a send's next transmission
  never starts before its latest is sealed. A Run's unlaunch and end reason read each
  transmission's value as it stood at its seal (3.8, D50), so a later fact (a late release, 4.5,
  F51, or a late acceptance) never unlaunches a Run or changes its reason, and after its end moves
  only its input (3.9, 12A); `mayStillAct` and a retry pending read current chains (3.5), so an
  acceptance while the Run is active holds it as any acceptance does. Coverage ends work (3.5) but moves a
  Run only through this value (3.8), so every coverage waits the same way, for its own fact,
  with no deadline (a Stop seals through the `process_lost` of the write that first sets its
  runner's `retired_at`, 6.5): an `end_session` for its runner's exit (4.6); an idle probe for the try's answer, as OpenCode's idle shows the session idle
  now, not that an unaccepted send cannot still run (3.4; at 1ba91324,
  opencode-runtime-ingress-service.ts 972-1011, session-run-settlement.ts 69-76).
- **Not yet delivered (D50).** A Run is not yet delivered while it is Queued, or Launched with an
  execution never handed over. Nothing may act for it, so Stop, Run now or `end` ends it `interrupted`
  at once (a Launched one by 3.8). Otherwise, when 3.8's condition 2 finds a Launched Run not
  yet delivered, it unlaunches, back to Queued, unless a permanent outcome other than a rejected
  resume left it so, which ends it `refused` (3.8): so after a `not_sent` try, a retryable
  runner-held try before any hold, a release (4.5, a stop commit's included, L1), a rejected
  resume of a `resume` start (4.8), or its runner's retirement before any hold of its start. The
  execution is dropped and its sends resolve no further (L2): the drop ends their work (3.5), so a
  late acceptance or `started` on one is recorded and changes nothing. A wake execution on its
  label is no send of it and stays its label's work until its own end (8.3), its coverage or the
  ledger stop deadline's alarm (L6, D47), so the relaunch's start waits at the fence. The unlaunch drops the
  issue's execution in the same decision; main's relaunch claims under the same `commandId`, a
  new transmission of the same Run (3.4). A hold under that key before the relaunch's Effect is claimed finds no
  running send, returns `Ended` and the feeder drops it (H3); after the claim the key names the
  relaunch's Effect, which the hold binds (4.3; at 6c9ff950 runner-retirement.ts 152-178, and an
  ended row is never reopened, orchestration-side-effect-reactor.ts 1337-1375).
  Main appends no terminal for an unlaunch: it returns by the projected `run.released`, or
  `requeueLegacySend` for a legacy send (its row back to `retryable_failed` with its run open,
  `requeueLegacySend`, send-settlement-outbox.ts 511-529 at 6c9ff950), and the arm unlaunches from
  the projected release or `process_lost` event.
  A steer it issued stays its Run's input (3.9), tried again in the relaunched execution after its
  start (L2 case 2). It launches again through admission under the same
  `commandId`, keeping its count (3.4): at the outcome's retry (3.7), otherwise at once (4.8), and
  `fresh` after a session end (3.4). The relaunch is its
  start's retry, so no send of a Run not yet delivered has a retry pending. An unlaunch shows no
  notice; its Queued Run shows the unlaunching outcome's `retryAt`, when it has one, as a field (3.7, 3.13). A full stop or a project removal closes the relay scopes, and so interrupts every feeder
  (4.4), before `stopRegisteredRunners` awaits the Stops; the relaunch its stop commit decides is
  never held during the stop, and the restart scan holds it when the project next serves.
- A Run that reached or possibly reached the agent never unlaunches. Main tries a transmission of
  its start or steer again at its retry, and the arm folds it into `live` (3.4), a new transmission
  of the same ledger Run, whatever main's runId, direct or runner-held, when it never left conduit
  (`not_sent`, or a start failure before any hold, H4), was released or, a start, declined (but not
  a `ResumeRejected` release, Stop's own outcome, or after a session end, 3.4, 4.8), or got a
  retryable outcome with consumption None or an absent finding (3.5): no host fact stops a
  runner-held re-send, which `holdRun` binds as transmission `n + 1` of the same run (4.3). The
  send has a **retry pending** from that outcome until its next transmission issues, or an
  acceptance (3.5), Stop, Run now or `end` (5.1, 8.4), its coverage (3.5), the cap (4.8) or its
  Run's end withdraws it; "due" is only a deadline's time arriving (3.7). A start's retry waits for
  the fence, which `markRunning` reads in the view (below; 2.1 row 202). Stop or Run now withdraws
  an Interrupting Run's retries (5.1).
- Derived labels: Launched with no evidence shows as Starting; with activity, Running. Settling means
  an OpenCode-style policy has a result with no later activity; past Settling's deadline the Run
  shows Running, with no deadline, until its `native_session` probe's finding or its end (3.8).
- `reconcile` rule order: expired deadlines; Run end and unlaunch (3.8, above); interrupts (5.1);
  probes, `stop_task` and `cancel_request`, the only effects decide issues (3.4, D60); advance
  (reserve the Run a reserving `run.requested` names, 3.4, 3.9; launch a Queued Run whose start
  main issued). Starts, steers, retries and answers are main's, and reach `live` only through Main
  observations, `run.dispatched` Answers and Controls (3.4); `reconcile` reads them there and
  issues none. A probe is sent only when a deadline or an OpenCode Stop (5.1) calls for one,
  never at the outcome itself or on every decision.
- The native-session fence (3.5 `fenceHolds`, L6, section 9) holds every start transmission, a
  launched Run's own start retry included, while some label has work; the retried start's own
  earlier tries hold it only while they may still act (3.5), and none may while its retry is
  pending. It never decides a Run's outcome.
- The view's `active` is a union by Run tag, so `by` exists only on Interrupting and the deadline
  owner is tied to the tag (3.7).

<!-- src: FB §3; HLK step 2; SPEC Implementation Decisions (Native-session fence); AUDIT-2 T10; model-gaps 2026-10-28; REDESIGN-2 review r3-2 (unlaunch); contract r15 (D50); contract r16 (D50 never handed over, start retry fence, retry pending); main retries nothing while closing (at 3aa43c60: process-session-runner.ts 3712; project-registry-service.ts 634 before 645; daemon-foreground.ts 481-489); REDESIGN-4 (D52 sealed; declines retried in the execution; advance reads Paused); REDESIGN-4 r1 (D52 closed list; late release; dropped-issue hold; cut-off owner); REDESIGN-4 r2 (sealed per transmission, ub P2-1, poteto P1-B; no usage-limit session end, ub P1-1, poteto P1-A; a release is NotConsumed{released}, poteto P2-E; a declined start retried, poteto P1-C; the unlaunch finishes its dropped issue's row, ub P2-2, poteto P2-H); REDESIGN-5 (a Run reads the sealed value, a late fact moves only the input, D53; a wake is never delivery; a send with no transmission seals at a try that ended before transmitting, ub r3 P2-3; the dropped issue's Effect ends and the relaunch issues a new one, at 6c9ff950 orchestration-side-effect-reactor.ts 1337, 1372; retry pending withdrawn at Run end); REDESIGN-5 r2 (cancelled is unconsumed; a stale 4.8 pointer; ub r2 F-F, P3-a); REDESIGN-6 r1 (Stop's interrupt, not a stop sequence; the fence bullet a pointer, resultReleasesFence gone; ub r1 P3-1, P3-2, poteto r1 P3-1); REDESIGN-7 r1 (coverage waits for its own fact with no deadline; the step seals nothing, its kill seals by its own `process_lost`; ub r1 P2-1) -->

### 3.7 Deadlines and the alarm

- Deadlines are data on the obligation they bound. They are not sends and carry no token.
- Each deadline is tagged by its owner (a Run's Settling, a probe, a delivery recovery, a native
  command, a stop's work, L6) with a required target; a stop's target is its session row, so it
  carries no field (3.13).
- Derived deadlines: the stop's is R2's `deadlineAt`, which U2 fires for its owner runs, and the
  ledger stop deadline's is the opening commit's `stop.deadlineAt`, which the ledger's alarm fires
  for the work outside them (L6); Settling, fixed at the result; each probe (below);
  delivery recovery (below); native command confirmation (which does not run while the provider reports
  the command queued, 8.5).
- Starting, Running and label work have no deadline. Before a Stop or Run now commit (L6) a Run ends
  by its evidence or coverage (3.8) or the user's Stop, as on main, which never ends a silent turn and
  only shows a notice after 2 minutes (provider-turn-dispatch.ts 970-976,
  session-overrides-state.ts 62 at 1ba91324; D54). From a Stop the stop's deadline bounds it
  (L6): U2's step acts then for the owner runs, or waits on a pending confirm (8.4) for the user's
  answer, which the UI asks for, and a Run whose runner the step retires ends by 3.8, at that
  retirement's `process_lost` while a start or steer of it is unsealed (3.6); the ledger's alarm
  ends the work outside them, with no confirm, since it destroys nothing.
- Every probe is an obligation and owns a retry deadline from the moment it is issued. Probe
  transmission `n` owns a retry deadline at its issue plus `max(probeMs, backoff(n))`. A probe
  with no answer by then, or answered `native_busy`, is re-probed in the decision that fires that
  deadline, as a fresh transmission of the same obligation with a fresh token, under its own cap
  of 5, never the probed send's cap (4.8). A probe transmission's provider call is bounded by its
  retry deadline; on timeout its executor records `effect_outcome` `retryable` with `retryAt` its
  retry deadline (3.5, D20). Past the cap, busy or unanswered, the probe ends with
  no finding: an input stays Delivered{unknown} and is never re-sent automatically, and what it
  probed keeps its work until its own evidence, its coverage or the ledger stop deadline's alarm (L6).
- A send's retry timing is main's: the reactor's `next_attempt_at`, with main's backoff
  (`sendRetryBackoff`, send-settlement-outbox.ts 319-323 at 6c9ff950). A send's retry is not a
  ledger deadline. A probe's deadline stays at its issue plus `max(probeMs, backoff(n))`,
  raised to `retryAt` when a retryable outcome names a later one (D20); `n` is the probe's
  transmissions so far; backoff is 1 s, 2 s, 4 s, 8 s, capped at 30 s.
- Delivery recovery probes the input; an answer's outcome is never Unknown (3.4, 3.10). A send's
  Unknown outcome (`delivery_unknown`, `delivery_indeterminate`) opens its recovery deadline (owner
  Send) at that outcome plus `probeMs` (D20); it fires the probe unless the send's consumption is
  Observed or Accepted or its work has ended by then. Idle proof after an OpenCode abort (5.1) or
  Settling's expiry probes `native_session`.
- An Accepted decision carries `alarmAt`: the earliest open deadline after its events, or absent
  when none is open. A Rejected decision leaves the alarm alone.
- 32.3's scheduler, a main-side fiber named in 2.1 row 215, keeps one timer per session row and
  appends `alarm_fired` (a settlement with no token). The decider fires every deadline with `at <= now`, in deadline order; equal-time
  deadlines fire in the issue order of the decisions that opened them. A late or spurious fire
  finds nothing due and is Accepted with no events.
- A deadline is due only when an alarm recorded after it opened reaches its time (the latest alarm
  time seen), so a clock going backwards cannot fire early or twice.
- Finishing an obligation removes its deadline, as activity after a result ends Settling (11A)
  and the stop's end removes the stop's. Nothing else cancels, extends or re-arms a deadline.
- **Label work and the stop (L6).** A label (`runnerId:querySeq`) has work while a fence member
  addressed under it may still act (3.5, section 9) or its wake execution is outstanding (8.3).
  Label work has no clock: it ends by its own evidence (3.5, 8.3) or coverage (L1, 3.4), as main
  bounds no work before a Stop (D54). A session has at most one open **stop**: main's `stopping`
  entry in U2, the provider turn service (provider-turn-service.ts 202-313 at 1ba91324, unchanged
  at 6c9ff950), run whole with its owner runs, window, deadline, retirement and restart restore
  (376-405) (D58). Work of a Run with an open main run is main's alone, and ends as main (D59);
  L1's OpenCode replacement or URL change also ends such Runs in the ledger, a ledger-only delta
  that changes no main event, row or provider call (section 9). The ledger holds no item of the entry, reads none of it, and owns one rule: the deadline of the work
  main's entry cannot see.
  - **Ledger stop deadline.** The arm folds each **Stop or Run now commit**: the projected
    `interrupt.requested` or `session.end_requested` of `acceptStopEffect`, whose `stop` is set and
    which carries no `retireRunIds` (`commitControl`, orchestration-engine.ts 884-898, 911-924 at
    6c9ff950). No other commit adds: every other control commits `stop: null` (`stop`,
    orchestration-command-commit.ts 58-63 at 6c9ff950), a Run-less `end_session` included, and U2's
    retire `end_session` carries `retireRunIds` (`retireRunIds`, provider-turn-service.ts 265-274 at
    6c9ff950). Each Stop or Run now commit adds the label work open at it with no open main run,
    wake executions (8.3) and sends with none (an OpenCode abort with no owner run, or a send whose
    run main has ended, 3.3), to the session row's one ledger stop deadline, opening it at its
    `stop.deadlineAt` when none is open; a later commit joins it and moves nothing, as a joined
    Stop moves none of main's (provider-turn-service.ts 363-374 at 1ba91324). A Stop that opens a
    new main entry while the ledger stop deadline is open adds its work to that deadline, so the
    work can end before the new entry's `deadlineAt`; the fence opens earlier, never later. With
    no such work the arm opens none. Work gained after a commit is bounded only by a later commit,
    as main's entry waits only on the owners its Stop captured (`snapshot.owners`, 207-222).
  - **Deadline step.** The stop's deadline step names both ends: U2's at its entry's `deadlineAt`
    for the owner runs (`retireProcess`, provider-turn-service.ts 251-284 at 1ba91324, confirm-gated by row 213,
    8.4; for OpenCode, `stop_unconfirmed` for its owners, 286-292, whose terminals the arm folds as
    the end of those Runs' work, their aborts' included), and the ledger stop deadline's
    `alarm_fired` at its own time for the rest. The alarm forces only work no observer ended, each as a work-ended
    fact (3.5), forced (3.8): it kills nothing, appends no main event and asks no confirm, since
    nothing is destroyed. A Claude Stop with no foreground run ends its wake at once: `interruptSessionEffect`
    disposes its query (`disposeSessionEffect`, claude-runner-payload.ts 2763-2783 at 6c9ff950), so the wake's
    `turn_ended` (8.3) ends its work by its own end and the alarm finds nothing of it to force; the
    arm reads no `session.status` idle from that dispose, which carries the finished send's `runId`
    (2774-2792). Other providers' wakes end at their evidence or the alarm.
    A retirement U2's step makes ends its runner's work by the `process_lost` of the write that
    first sets its `retired_at` (6.5), the arm folding its coverage (L1). The `process_lost` takes
    its sequence in that write's transaction, so every later fact folds after it (6.5); against the
    alarm, before or after, both are work-ended facts and only `process_lost` seals (3.6), so that
    order changes no Run end, unlaunch or seal, and of the reason only `forced`: work the alarm
    ended first is forced, and work the `process_lost` ended first is not (3.8). A step that cannot retire leaves
    its owner runs as main (`provider_process_gone`, orchestration-side-effect-reactor.ts 1606-1624
    at 6c9ff950), and the alarm still ends the rest.
  - **Restart.** The ledger stop deadline is on the session row (below), so 32.3's scheduler fires it
    after a restart with no U2 restore; U2's restore stays main's, for owner runs only.
  - **End.** The ledger stop deadline closes when its work has ended, by its own end (3.5, 8.3), its
    coverage (L1, 3.4) or the alarm. While it is open a Run with work in it shows its `deadlineAt`,
    and so does a Queued Run whose start waits on that work, never a Claude wake, which ends at
    its Stop's dispose; any other Run shows none from the ledger, and after an unlaunch a Queued
    Run shows its start's retry as the unlaunching outcome's `retryAt`, a view field and no
    deadline (3.6, 3.13). A newer `querySeq` ends no work; it decides only lost work (L5).
- **One alarm per session row.** A decision writes the session's `alarmAt` and whether it has open
  work to a per-session ledger row, in the same transaction, only when the value changes. The row
  is `Quiescent | Open { alarmAt?: number }` with an index on the earliest alarm. The scheduler
  reads the earliest `alarmAt` across sessions. Deadlines with no Run (native commands) are
  covered.
- No in-memory retry or deadline fibers remain.
- Default budgets come from `DecideContext.policy`: the stop budget is not policy, it is the
  commit's `stop.deadlineAt` (`STOP_ABORT_WAIT_MS`, orchestration-engine.ts 871-880 at 6c9ff950, L6);
  `settleMs` is 7 s, main's OpenCode status reconciliation interval (env.ts 147-150,
  session-status-poller.ts 25-26 at 1ba91324); `probeMs` is the minimum retry deadline of a probe
  transmission from its issue; `nativeCommandMs` bounds native command confirmation, paused while
  the provider reports the command queued (8.5).

<!-- src: HLK step 1; RULINGS R1; FB §3, §4; OW Decision 4; AUDIT A4, A8; AUDIT-2 A19, T9, T12; SPEC Implementation Decisions (Deadlines as data); MODEL; model-gaps 2026-10-28; REDESIGN-4 r1 (joined wake wait has no phase clock); REDESIGN-4 r2 (that exception deleted: a joined wake's activity extends the Running clock; ub P1-2, poteto P2-D); REDESIGN-5 (wake execution deadline owner; its activity extends the active Run's phase clock, a Starting one included, ub r3 P1-2); REDESIGN-5 r2 (8.3 owns the wake deadline alone; a Tombstone cleanup only for a member a late acceptance restored; ub r2 F-A, F-B, poteto r2 F1, F2); REDESIGN-6 (L6, D54: one owner of a label's work, deadline, stop sequence and end; the send cleanup with no time, the late acceptance's Tombstone cleanup and the wake deadline deleted; ub r3 N1, P3-3, poteto r3 P2-3, P3-2, P3-3); REDESIGN-6 r1 (the work episode: Stop's naming, the interrupt budget from the latest commit in the episode, the column once per episode, exhaustion ends it, a fired label shows its next step; the interaction pause; livenessMs 30 min; a gated destructive step bounded by the user's answer; ub r1 P1-A, P1-B, P1-C, P2-1, P3-3, poteto r1 P1-A, P1-B, P3-3, P3-6, P3-7, P3-8); REDESIGN-6 r2 (the budget from the first commit, as main's join; no Starting, Running or pre-Stop label deadline, as main; the pause and livenessMs gone; a busy or silent probe re-probed under the cap; none while a step waits on a confirm; exhaustion launches the blocked Queued Run; ub r2 P1-1, P1-2, P2-1, P2-5, poteto r2 P1-1, P2-3, P3-4); REDESIGN-7 (the stop: one per session, opened by the first Stop, Run now or `end` commit or a Run-less `end_session`, deadline fixed at that commit as main's join, adds named at each commit, one deadline step, the end at its items' end; the work episode, its re-anchor, the fence-expiry column, `closeMs` and exhaustion deleted; label work has no clock; `settleMs` is main's 7 s; a capped probe ends with no finding; ub r3 P1-A, P2-B, P2-C, P3, poteto r3 P2-1, P2-2, P3-2); REDESIGN-7 r1 (the stop ends at its items' end or once its deadline step issues, a gated step not issued, and a later commit or `end_session` opens a new stop, as main's `stopping` entry at 1ba91324 provider-turn-service.ts 294-321, 363-373; work gained after a commit stays outside the stop; the OpenCode step ends its Runs' and labels' work issued before the deadline, the commit's abort and `cancel_request` included; an empty commit opens no stop; the pre-confirm bound a pointer to the step; ub r1 P1-1, P3-2, poteto r1 P2-4, P2-5, P3); REDESIGN-7 r2 (the stop's items are work, not Runs, so it ends at its items' end, the step at the latest, and the step clause is deleted; a Stop before a kill's `process_lost` finds nothing to add, as main's join at 1ba91324 provider-turn-service.ts 363-374, orchestration-engine.ts 1158-1161; the step's reach by order, before the step, and the OpenCode step ends the stop's owner work as main's `stop_unconfirmed`, session-run-settlement.ts 68-72; ub r2 P3-3, P3-4, P3-5, P3-6, poteto r2 P2-2, P2-3, P3-1); REDESIGN-10 (D58: the stop is U2's `stopping` entry, run whole, with R2's `deadlineAt` and main's retirement as its deadline step; the ledger owns only its items, recorded in `acceptStopEffect`'s body; the window paragraph deleted as main's by construction; ub R9 r1 P1-2, poteto r1 P2-5, ub r2 P2-E); REDESIGN-11 (D59: the items, their adds, U2's wait and the failed-step end deleted; the ledger deadline per `deadlineAt` over the work with no open main run, ended by its own `alarm_fired`, restart-safe on the session row; the deadline step names U2's step and the alarm; a probe timeout is `retryable`; ub R10 r3 F-B, F-C, F-A, P3 653, P3 635, poteto r3 F1, F3); REDESIGN-11 r1 (one ledger stop deadline per session row, opened by a Stop or Run now commit; forced only at its alarm; the stop budget is the commit's; ub r1 F2, F3, F5, P3-2, poteto r1 F-A, F-B, F-D) -->

### 3.8 Outcome, Tombstones and late evidence

- **Run end (the one rule).** A Launched or Interrupting Run ends at the first of:
  1. its provider's Run-end evidence for its execution, recorded with authority (3.4): for Claude
     the result naming the send's input uuid, or naming none when 3.4 gives it to that send; the
     result for Codex and Cursor; the owned execution's end (`query_ended`) for OpenCode (9); for
     a wake Run, its latest label's wake execution ending by its work (8.3);
  2. **nothing of it may still act:** every start and steer of its execution is sealed (3.6), no
     send of it may still act (`mayStillAct`, 3.5) or has a retry pending (3.6), and none of its
     executions is still acting (one with execution evidence, 3.3, and no Run-end evidence while
     its runner is live, its native session has not ended and neither its `turn_ended` (8.3) nor
     the ledger stop deadline's alarm (L6) has ended its work).

  A Queued Run ends only `interrupted`, at once, by Stop, Run now or `end` (5.1, 3.6 D50).
  Condition 2 needs no authority of its own: outcomes, releases, rejected resumes and coverage
  count as recorded (3.6), and lifecycle evidence as 3.4 says. On a Run not yet delivered it
  unlaunches the Run instead (3.6). The end reason follows the condition that ended the Run:
  1. condition 1: the fold (5C), so a result beats a Stop's interrupt fallback; with no result in
     it, as 2.4;
  2. condition 2: the first that applies:
     1. Stop, Run now or `end` asked (5.1, 8.4), or one of its sends is NotConsumed{cancelled} (9):
        `interrupted`, forced when the ledger stop deadline's alarm ended its work (L6);
     2. each send is never handed over or unconsumed (3.6), and one has a permanent outcome
        other than a rejected resume or reached the cap (4.8): `refused`, the first specific code
        (10A);
     3. a send that reached or possibly reached the agent is covered (3.5), or an execution with
        execution evidence and no Run-end evidence (a wake Run's, 8.3) lost its runner (L1) or its
        session: its covering cause, `session ended` (3.4) before `process lost` (L1), with the
        fold's first specific code when it has one (10A);
     4. otherwise the fold (5C); with no result in it, main's terminal for its run (its outcome
        and code, D60; `error` reads `provider_error`, not retryable), as main ends a turn with no result as an error (claude-runner-payload.ts
        2120-2126, codex-runner-payload.ts 878-892, cursor-runner-payload.ts 922-932 at
        6c9ff950); with neither (a wake Run), `completed`, as main's wake turn (8.3).
- **No result, either order (GAP 5).** A Run with a main run (one its `run.requested` reserved,
  3.4) whose fold has no result ends, by either condition, only once main's terminal for its run
  has folded, unless reason 2.1, 2.2 or 2.3 applies; the reason is then that terminal's. So the
  fold order of OpenCode's `query_ended` and main's `turn.error` in one write never changes the
  end. `query_ended` first: condition 1 holds, the Run waits, and the next fold, the terminal's,
  ends it `provider_error` with main's code. The terminal first: the Run ends at once by
  condition 2 if nothing of it may still act, else at `query_ended`'s fold by condition 1, each
  with that terminal's reason and code, in the same write. A
  Claude, Codex or Cursor user Run has no such pair: its no-result end is main's terminal under
  condition 2, as `query_ended` ends none of its executions (9).
- **Outcome fold (5C)**, within one execution: failure beats success; specific beats generic;
  completion beats an interrupt fallback; a `delivery_unknown` outcome is a failure, code
  `delivery_indeterminate`, as Send Settlement ends it (4.7). The fold is order-independent. Only
  a new execution resets it.
- **First specific code (10A):** keep the specific code with the lowest send number, then the
  lowest code. "First" means first in issue order, not arrival order.
- **OpenCode after a result (11A):** activity after a result (from an unsolicited turn) shows as
  Running again and keeps the fold. An earlier error stays the outcome even if a later turn
  completes.
- **After a Run ends (12A):** evidence for it is recorded only when it changes a join (accounting,
  an acceptance that holds the fence, an outcome that ends a fence member's work, a fact that
  moves an input's place, 3.9; an interaction is its label's, never a Run's, 3.10): no effect for that Run, no change to it. Duplicates produce no events. A frozen execution's fold does not
  change. The decision still runs `reconcile` to its fixpoint over the views (3.2), so a recorded
  fact that releases the fence starts the next Run in that decision.
- Late evidence for an Ended Run never changes its Tombstone. A late acceptance still restores its
  send's work, so its label has work (L6) until that work ends.
- Late accounting receipts are recorded against the ended Run's inputs; usage, cost and token
  values stay in their own projection, outside the ledger.
- A result after process loss changes nothing; its accounting is recorded.
- **Activity throttling.** `activity` changes a join when it is the execution's first activity,
  or when it changes the execution's phase or its order relative to a result. Only repeats within one phase are
  throttled.
- End reasons: completed; provider error (code, retryable); interrupted (by stop, run now or end;
  forced when the ledger stop deadline's alarm ended its work rather than native truth, L6); process lost (for
  every `StopReason`, 6.3, a runner fact with no ledger input, as a project is, D48); session ended (a session end, 3.4: native session vanished, an `end_session` success or a rejected
  resume); refused (code: its sends' own outcomes, including `project_inactive`, 3.11) (3.13
  `EndReason`). Every failed Run shows a specific reason.

<!-- src: HLK step 4; FB §3 (10A, 11A, 12A), §4; AUDIT A6, A10; AUDIT-2 A16; SPEC Implementation Decisions (Tombstones), user story 19; MODEL EndReason; model-gaps 2026-10-28; REDESIGN harness r12; contract r15 (32.2.15); contract r16 (one Run-end rule); REDESIGN-4 (reasons keyed by condition; wake once Stop asked; 5C delivery_unknown); REDESIGN-4 r1 (condition 2 scope; reason 2.2 permanent or cap); REDESIGN-4 r2 (no usage-limit failover end reason; ub P1-1, poteto P1-A); REDESIGN-5 (a wake execution is never the Run's, so the D47 paragraph is deleted; 12A records a fact that moves an input's place); REDESIGN-5 r1 (a wake Run's reason at retirement or session end, reason 2.3; its end at its latest label's wake work, condition 1; ub r1 P1-5); REDESIGN-6 (a late acceptance's work is its label's, L6; condition 2's wake clause deleted; reason 2.1 reads NotConsumed{cancelled}; ub r3 P3-1, P3-6, poteto r3 P2-3, P3-2); REDESIGN-6 r1 (a uuid-less result 3.4 gives to a send ends its Run; poteto r1 P2-C); REDESIGN-6 r2 (a Queued clause makes 3.8 Run end's one owner; EndReason in 3.13; `fence unconfirmed` gone; poteto r2 P2-4, P2-3, P3-2); REDESIGN-7 (condition 3 and `deadline expired` deleted: a Run ends by evidence or nothing of it acting, the stop's deadline step included; ub r3 P2-B); REDESIGN-7 r1 (`end` asks reason 2.1; poteto r1 P2-1); REDESIGN-7 r2 (condition 2 reads the stop's deadline step, so an OpenCode Run ends there; the Queued clause's stop note deleted, a stop holds work; poteto r2 P1-1) -->

### 3.9 Inputs, steers and the inbox

- Input delivery: Queued, then Dispatching (a start or steer issued with no transport evidence yet;
  a `not_sent` try returns it to Queued, H4),
  then Delivered/sent, or Delivered/unknown when the transmission's outcome is unknown.
  Delivered/unknown blocks automatic resend until a probe settles it. Neither implies Accepted.
- **The ledger lives inside main's writes (D58).** Every main unit runs whole, changed only where
  a 2.1 row names it: the inbox module (`SessionInboxLive`, session-inbox.ts 420-437 at 1ba91324,
  with `decideInbox`, `readView`, `steerDeclined`, `requeueFailedSteers` and `readInboxState`; the
  `pending_inputs` arms, projectors-effect.ts 2431-2537); the provider turn service with
  `stopping`, its Stop entries and their restore (provider-turn-service.ts 202-405); dispatch; the
  reactor with its claim and retries; the outbox; ingestion; OpenCode ingress; runner recovery;
  the runner; the lifecycle module; R2's engine. The inbox module is the one owner of admission,
  Run now, Resume, Send now, Steer, `cancel_input` (D55), advance, inbox order, the mark,
  `steering`, `busy`, `promptOpen`, the stop term and the pause; this contract restates none of
  them. The ledger is three things and nothing else, with no Layer, Tag, transaction or fiber:
  1. One projector arm. Each input is a main event a main unit appends in its own
     `commitAndSignal.write` body; the arm, called by that body's `project`, runs `decide` and
     `evolve` in its transaction (3.1). A runner's `process_lost` from a raw retirement write is
     appended outside such a body, unprojected, and the next `commitAndSignal` recovers it before
     it projects its own batch (6.5). The arm reads only projected events and its own tables,
     never outbox status. Main writes that append no event are not evidence: `markRunning`'s
     steer claims and its claims of a row whose run is still open (a claim with no open run mints
     its run and appends `run.requested`, 3.4) (`markRunning`, orchestration-side-effect-reactor.ts
     1338-1424 at 6c9ff950), the direct marker (`delivery_indeterminate`, 916-955),
     `requeueLegacySend` and the resume fallback (`requeueLegacySend`, send-settlement-outbox.ts
     511-529; `settleLegacySend`, 412-475 at 6c9ff950), and `acceptStopEffect`'s
     DELETE of a session's `retryable_failed` send rows (`retryable_failed`, orchestration-engine.ts
     858 at 6c9ff950), in the write that appends each such row's `input.requeued` (812-856). A fact
     the arm needs with no main event gets an evidence event, appended by the unit that observes it
     in the same write as the observation (2.1 row 215); main's projectors ignore them. An effect
     executor's outcome is one, in the same write as its status update, a control's included
     (`markCompleted`, 2253-2274; `recordControlOutcome`, 2276-2380; `writeFailure`, 2753-2783;
     3.4), and so is the outcome of each sweep that ends a control row (the refusal sweep, `drain`
     and pending-prompt retirement, 3.4, 3.12).
  2. Outbox rows for the effects main has no writer for (`probe`, `stop_task`, `cancel_request`):
     the arm inserts each with `command_id` `ledger:<run>:<effect>:<attempt>`,
     INSERT OR IGNORE against a partial unique index on (`project_key`, `command_id`) over those
     three effect types (main's `command_id` is not unique), never during replay. Main's reactor has
     no executor for them and claims a row with no live command only in its background drain
     (`drain`, 385-470 at 6c9ff950); 2.1 row 216 lands them on 32.3, with the lane rule of 3.12;
     until it lands the arm inserts none.
  3. The view. The unit reads the view in its own body, inside its write, before the statement it
     gates and after projecting any event that statement depends on, then appends main's events
     or statuses itself. The arm appends no event and calls no main function.
  Run lifecycle events (`run.requested`, `run.started` with its join, terminals) stay their main
  writers'; `provider_runs` status is main's terminal arm's, first terminal wins
  (projectors-effect.ts 2155-2176), and the Fact Book's Run end is the 3.8 fold over the same
  events: two facts, each with one writer. A wake Run (8.3) has no main run: main writes none for
  a Codex successor (codex-turn-lifecycle.ts 239-245, 339-360) and, for a Claude wake, only a
  `turn.completed` stamped with the prior run's id that leaves `provider_runs` unchanged
  (claude-runner-payload.ts 2274-2299; projectors-effect.ts 2137-2150), all at 1ba91324. The oracle (32.2.3) models no inbox; T2 (32.2.17)
  replays both stacks, and T5-writers (32.3) checks that the arm imports no main write module and holds
  outbox status's transition table (3.12).
- **An input's place (D53).** An input is the latest Run's that reserved it (or that it joined
  as a Run Input) and reads only that Run's sends; a fact about an earlier Run's send is late
  evidence for that Run (12A) and moves nothing. It is its Run's while that Run is active, tried
  again by 3.6, in the relaunched execution when its Run unlaunched: it follows its Run, never a
  runner (L2 case 2). The ledger decides only what its sends' current value is (3.6), and main's
  writer for that value places it, so a fact after its Run's end (D52, 12A) moves it by this
  rule alone: reached, or possibly reached and not unconsumed, it is placed as sent and never
  re-sent (`message.created`, projectors-effect.ts 2526-2537; 2.1 row 206); not reached, it is
  placed by main's writer (3.9); declined, `steerDeclined` returns it. A send fails once, at a permanent
  outcome (`project_inactive` included, 3.11) other than a rejected resume or Stop's own, or
  past the cap (4.8): its input is `failed`, final, its failure shown once and its text back in
  the composer (S9.5; 2.1 rows 207, 212). Stop's own outcomes (4.8, 9) are never retried and
  never fail an input, so either arrival order places it by this rule.
- **A steer that outlives its Run.** A steer its Run's end leaves unconsumed, not declined or
  failed, stays where main's projectors leave it: `steering`, its send's run `pending`. That
  holds at a `completed` end and at a Stop whose host keeps pending steers. From that end it is a
  Run of its own, its reservation's, Launched with its send (3.6), the steer its Run Input: its
  host's `run.started` starts it; its acceptance places it (`message.created`); its decline returns it (`steerDeclined`) and ends
  that Run with main's terminal; 3.8 ends it from its own turn's evidence, and a later Stop
  covers it as any Run. A steer sent while it is active joins it. Each case is as main: (a) a
  Claude steer after `completed` starts (`currentRunId ??=`, claude-runner-payload.ts
  2532-2539); (b) a Claude Stop keeps it (`keepsPendingSteersOnInterrupt`,
  provider-turn-session.ts 301-303, 331-334); (c) undelivered, Claude starts it
  (claude-runner-payload.ts 2524-2539) and Codex declines it with no active turn (`declined`,
  codex-runner-payload.ts 1133-1143); (d) a second steer reads the pending run as busy
  (`run_status`, session-inbox.ts 553-558), is sent as a steer and joins (projectors-effect.ts
  1881); (e) a Codex steer awaiting `turn/steer` is accepted or declined by its answer (`delivered`,
  codex-runner-payload.ts 1146-1167), all at 1ba91324. A steer admitted while only a wake Run is active is
  a Run of its own the same way, Launched with its send and started by its own `run.started`
  (`requestedRunId` = its `runId`), as claude-runner-payload.ts 2561-2580; a Codex steer into an active turn joins the
  original run (`requestedRunId`, codex-runner-payload.ts 1063-1076).

<!-- src: HLK step 3; RULINGS R3; SPEC Implementation Decisions (One active run, Steers when a run ends early), user stories 3, 6, 7, 20; SEND-SCOPE-5 S9.3; AUDIT-2 Other changes (wake admission); RA §8; contract r16 (steer follows its Run, D51 pause: main at 3aa43c60, inbox-run-status-query.ts, session-inbox.ts 245-250); REDESIGN-4 (D51 one reader: main at 1ba91324, session-inbox.ts 241-250); REDESIGN-4 r1 (cut-off and schedule owners: main at 1ba91324, session-inbox.ts 245-250, 526-565); REDESIGN-4 r2 (a declined steer returns, a released one is tried again; ub P2-3); REDESIGN-5 (D53 one place rule for starts and steers, a late fact moves only the input; Stop re-queues behind the pause as main does, at 1ba91324 provider-turn-session.ts 329-388, session-inbox.ts 240-250; amends SEND-SCOPE-5 S9.3 for Stop); REDESIGN-5 r1 (E1: the latest Run that reserved it; possibly seen deleted; a declined steer unpaused; Stop's own; at 1ba91324 runner-turn-failure.ts 85-117, session-inbox.ts 575-600; ub r1 P1-1, P1-2, poteto r1 P1-1, P1-2, P2-D, P3-3); REDESIGN-5 r2 (NotConsumed{cancelled} replaces the by-name list; the permanent outcome's parse; main's unstarted steer, runner-turn-failure.ts 76-84 at 1ba91324; ub r2 F-F, P3-c, poteto r2 P3-1); REDESIGN-6 (D55: `cancel_input` is Cancelled for an input no Run holds, else Rejected, as main's Cancel, src/lib/domain/relay/Services/session-inbox.ts 286-293 at 1ba91324 and 6c9ff950; poteto r3 P2-2); REDESIGN-6 r1 (D55: a Queued Run's reserved input is refused `already started`, as main refuses a claimed input; Stop's outcomes a pointer; ub r1 P3-6, P3-9); REDESIGN-6 r2 (`fence unconfirmed` no longer pauses: it is gone; poteto r2 P2-3); REDESIGN-7 r1 (a message sent while the active Run is Interrupting waits Queued, not a steer; main reserves it past the Stop pause, session-inbox.ts 189-203, 263-276 at 1ba91324, which S9.3 forbids; ub r1 P1-1 trace A); REDESIGN-7 r2 (D51 anchors at admission, not the latest handoff: an explicit send, Run now or a message sent idle or while Interrupting, runs next past the pause and clears nothing, so the stopped inputs wait for Resume, where main's handoff drains them, session-inbox.ts 236-340, 561 at 1ba91324; ub r2 P2-B, poteto r2 P2-4); REDESIGN-8 (D51 is main's `decideInbox` over a ledger view, main's handoff anchor: the latest input Run by reservation, so a new send or Run now that ends `completed` drains the stopped inputs, the user's decision of 2026-10-30; `stopping` is the open stop; the idle send passes `limited`; the admission anchor and the A.17 M11 rows deleted; ub r3 P1-1, P3-1, P3-2); REDESIGN-8 r1 (the view is main's InboxView field for field and the decider the one owner of a send, Run now and Resume; admission a pointer to the Submit arm; `promptOpen` excludes async questions; `stopping` main's whole entry window; `interruptRequested` the oldest queued input ever marked; a stopped input at its admission position, a declined steer at the front, projectors-effect.ts 2479-2521; Resume is main's `input.sendNow` of the head, PendingInputTray.svelte 103; `stoppedSinceHandoff` main's `readInboxState.paused`, read-query-effect.ts 2625-2663, failed-steer clause by send order, inbox-run-status-query.ts 34-46; ub r1 P1-A, P1-B, P1-C, P2-D to P2-F, P2-K, poteto r1 P1-A, P1-B, P2-1 to P2-3, P2-5 to P2-7); REDESIGN-8 r2 (each view field's source is the fact for main's write that sets it: the latest send is every `run.requested`, a steer into a wake Run included, claude-runner-payload.ts 2532-2539, orchestration-command-commit.ts 295-338; `steering` ends at its Run's end, runner-turn-failure.ts 75-84; `promptOpen` resolves at the answer's commit, permissions.ts 700-720; a Codex wake Run is not busy, codex-runner-payload.ts 315, 908; the displayed `paused` is `readInboxState.paused`; a declined steer at the front before or after its Run's end; the drain sentence deleted; D55 a pointer; ub r2 P1-1, P1-2, P3-3, P3-6, poteto r2 P1-1, P1-2, P2-1, P2-2, P2-4, P3-1 to P3-3, P3-6, P3-6b, P3-7, removables); REDESIGN-9 (D57: the inbox is main's module, reused unchanged, and the ledger writes its read surface through main's writers; D51's field-by-field view, the Handoff clause and the stop-term account deleted; a steer started after its Run's `completed` end is a Run of its own, claude-runner-payload.ts 2532-2539 at 1ba91324; ub r3 P1-1, poteto r3 P1-1, the zero-owner late steer); REDESIGN-9 r1 (D57's writer list replaced by the run seam: `ProviderTurnServiceTag`, `run.requested`, `run.started` with the join, a terminal for every Run end, main's projector arms and triggers after them, at 1ba91324 session-inbox.ts 420-437, 826-870, projectors-effect.ts 1845-1900, 2251-2336, provider-turn-session.ts 329-388, provider-runtime-ingestion-service.ts 704-723, orchestration-side-effect-reactor.ts 896-1008; the read surface with its writers; the reuse unit and its services; a steer that outlives its Run in five cases, each as main; D53's not-reached place from the seam's events; ub r1 P1-1, P1-3, P1-4, P2-1, P2-2, P3-1, P3-2, poteto r1 P1-1, P1-2, P2-1, P2-2, P2-4, P3-1, P3-2, P3-7); REDESIGN-9 r2 (the service boundary: each main service that writes or wakes the module's reads, unchanged, replaced by a call to main's own function, or deleted at a named ticket; the module runs in place and T2 checks its closure; one Tag for every caller; the Stop commit calls `prepareStop`; `requeueFailedSteers` at each replaced trigger; `turnEnds` the host's; a wake Run has no main run; at 1ba91324 provider-turn-service.ts 202-374, provider-turn-dispatch.ts 325-415, 868-877, orchestration-side-effect-reactor.ts 517-559, 896-1038, 1143-1225, runner-recovery.ts 228-372, process-session-runner.ts 1521-1526, claude-runner-payload.ts 2235-2246, 2561-2580, codex-turn-lifecycle.ts 239-245, 339-360, session-inbox-attachments.test.ts 29-63; ub r2 P2-A to P2-D, P2-F, P3-1 to P3-4, P3-6, poteto r2 P1-1 to P1-3, P2-1 to P2-4, P2-6); REDESIGN-10 (D58: the ledger is one projector arm in main's write bodies, effect rows main has no writer for, a view the 2.1 units read in their own body, and the outbox's transition function; the run seam, the service boundary table and the read surface deleted; Codex steer cites at 1ba91324 codex-runner-payload.ts 1063-1076, 1133-1143, 1146-1167; ub R9 r3 P2-A to P2-E, poteto r3 P1-1, P1-2, P2-1, P2-3, P2-5, P3) -->

### 3.10 Interactions and answers

- An interaction belongs to the label it was raised on (3.4), never to a Run. It is Pending from
  its request to its resolution whether or not a Run reads that label, and is shown in the
  session's view (3.13) and answerable throughout: its `deliver_answer` names that label and the
  Run that reads it, or null. Main lists and resolves interactions by session and native request
  id, never by run (pending-interaction-service.ts 146, 173;
  orchestration-side-effect-reactor.ts 1564-1577, 1633 at 1ba91324).
- A permission or question is answered once: the first answer decision wins (user or main's
  timeout).
- A permission's timeout is main's: main resolves it rejected and sends that answer as any other
  (`PermissionTimeoutLive`, timer-wiring.ts 20-40; `takeTimedOutPermissions`,
  pending-interaction-service.ts 603-700 at 6c9ff950). The ledger folds it as any answer and holds
  no timeout deadline.
- An answer is delivered exactly once, also across daemon and runner restarts; transient failures
  retry with backoff; delivery is the interaction's work, never a Run's.
- Answer refusal (10B): the interaction stays Pending with `lastRefusal` naming the exact answer
  transmission, main's `(commandId, transmission)` (3.4), and refusal code while its delivery
  retries (below); both are the transmission's `retryable` outcome's, the code main's receipt
  `error_code` (orchestration-side-effect-reactor.ts 2320-2346 at 6c9ff950). The submitted answer
  is kept. Main retries an answer only at a `retryable` outcome; one whose consumption is
  ambiguous (`provider_control_timeout`) fails its row, a `permanent` outcome, and main reopens the
  prompt as a new request only where it finds the answer unconsumed (a runner's `not_received` or
  `gone`, OpenCode's prompt still listed or its process gone; `readFailedControlPrompt`,
  orchestration-side-effect-reactor.ts 2383-2552 at 6c9ff950), so decide probes no answer before a
  retry.
- Answer delivery state (queued, sent, unknown, settled) is derived, not stored.
- An interaction's resolution, by any transmission or natively, ends the work of every
  `deliver_answer` transmission for that interaction.
- An interaction still Pending on a label with work at a Stop or Run now commit (L6) is resolved at
  that commit (a permission rejected, a question with no answers) unless a `deliver_answer`
  transmission of it may still act (3.5), and no `deliver_answer` issues for it after, as main
  cancels only the unanswered ones when it interrupts (pending-interaction-service.ts 400-415,
  449-500; claude-runner-payload.ts 2351, 2997-3002, 3024-3034 at 1ba91324). An answer, in a stop
  or not, resolves its interaction at its delivery's confirmation or the host's own resolution, for
  Claude its native rejection at the interrupted result (4.6), whichever the host reports first, or
  else when its delivery ends with no confirmation: its work ends (a permanent refusal, a sweep's
  included, 3.4, or the cap, 4.8, its coverage, or the stop's deadline step, L6), as main deletes
  the entry when the answer is taken (pending-interaction-service.ts 400-417, 419-430 at
  1ba91324). OpenCode's abort carries no interaction, and main resolves one only by OpenCode's
  reply event (opencode-provider-instance.ts
  702-724, opencode-runtime-event-translator.ts 242-266 at 1ba91324), so for OpenCode the commit's
  resolution is the ledger's (a 2.1 row). One still Pending when its runner is retired or its
  session ends (L1) is resolved then, where nothing can answer it, as main retires a replaced
  process's prompts (retire-pending-prompts.ts 44-58 at 1ba91324). An async question (Codex
  AskUserQuestion, `delivery: async`, answered by a new message) is never resolved by a commit,
  retirement or session end, as main excludes it (pending-interaction-service.ts 481,
  retire-pending-prompts.ts 39; codex-item-mapper.ts 528-585 at 1ba91324). It is resolved, as main,
  by the next accepted send admitted after it (handlers/permissions.ts 443-465;
  ws-rpc/conversation.ts 214-217 at 1ba91324); its answer is a steer that falls back to queue
  (permissions.ts 837-867).

<!-- src: FB §2, §4; RULINGS R2; HLK Rules not tied to one step (10B); SPEC user stories 8 to 12; MODEL InteractionView; model-gaps 2026-10-28; REDESIGN-6 r2 (an interaction is its label's, Pending whether or not a Run reads it, answered with a nullable runId, as main resolves by session; ub r2 P1-3, poteto r2 P1-2; resolved at its runner's retirement or session end, as main at 1ba91324 retire-pending-prompts.ts 44-58, claude-runner-payload.ts 3120-3150, 3174); REDESIGN-7 (a Stop, Run now or `end` commit resolves its stop's Pending interactions, as main at interrupt; delivery never holds a Run open; the settle-expiry consumption deleted; the session-stop citation corrected; poteto r3 P1-1, P2-5, P3-5, ub r3 P3-3); REDESIGN-7 r1 (only an unanswered interaction resolves at the commit; one in delivery by its delivery or the host; an async question never; OpenCode's abort carries no interaction, opencode-provider-instance.ts 702-724, opencode-runtime-event-translator.ts 242-266 at 1ba91324; ub r1 P1-2, poteto r1 P2-3); REDESIGN-7 r2 (the commit resolves every interaction no `deliver_answer` of which may still act, so a refused answer included; an answer resolves at its delivery's confirmation, the host, or its delivery's unconfirmed end, in a stop or not, as main deletes the entry at answer time, pending-interaction-service.ts 400-417, 419-430 at 1ba91324; 10B's Pending only while it retries; poteto r2 P1-2, ub r2 P2-C) -->

### 3.11 Session gates and project removal

- **H4. The daemon refuses the sends of a removed project and defers those of a project it does
  not serve.** The registry's project gate has three answers. Where a send would transmit, the
  feeder spawns nothing and the effect interpreter calls no adapter unless the project is served:
  - **Removed** (not registered, and no removal or registration of it in progress): the send
    gets its permanent outcome, code `project_inactive` (4.7).
  - **Not served** (registered but not ready to serve: registering, its relay being built or
    replaced, a relay load error or its store unavailable; or a removal or registration of it in
    progress, as when a re-add imports its store before it registers): the send gets `not_sent`
    before any hold, spawn or adapter call, a runner-held try as `unheld_outcome` (3.4, 4.4) and an
    effect decide issues as `effect_outcome`; a row main's executor runs gets none, as its gate
    precedes its claim and writes nothing (3.4). A `not_sent` try is a try, not an issue: it
    counts no transmission and ends only its own work (3.5), never a Run, its send's address (L2)
    or its obligation. A start's Run goes back to Queued while not yet delivered, and otherwise
    stays Launched (3.6); an input shows as queued (3.9); and the
    same effect is tried again at the backoff, at most 30 s apart, for as long as the project is
    not served, while the session's later input waits behind it (4.7), as main's inbox waits for
    the relay. Every clock runs, the stop's deadline, probe deadlines and a native command's
    confirmation (L6, 3.7, 8.5), so Stop still ends a Run during an outage. A try shows nothing.
  - **Served**: the send proceeds.

  A transmitted send is never refused; it ends by its runner's retirement or its provider's
  evidence. The gate never applies to a retirement: `requestStop` acts on a conduit process
  (6.3), not on the provider, so U2's deadline step and restart recovery retire whatever the gate
  answers. The registry answers removed only once the removal has finished,
  which includes the committed Stop of every runner of the project (6.3). A daemon killed
  mid-removal restarts with the project registered (Not served, then Served) if no config save
  has run since the removal began, or else removed, with any runner whose Stop never committed
  left alive as Q28 leaves it; either way every refusal precedes any transmission.
  Removal and spawn are serialized per project: a spawn either finishes before removal looks for
  runners or is refused, and a refused spawn is `not_sent` as above, so its next try meets the
  gate again. So no refused send is addressed to a live conduit runner. The gate is read when a
  send is stepped: a waiting send whose project is removed and re-added between two of its
  tries is delivered to the re-added project, as main's inbox drains on re-add. The gate's
  readers (the feeder and the effect interpreter) and the scheduler that fires their retries
  are the daemon's, as the provider adapters are, not a relay's: a project with no relay,
  removed or not served, still has every send stepped and answered. The daemon's project
  registry owns this fact; the ledger holds no project state and has no project input (D48).
- Removal reaches the ledger only through existing inputs. It stops the project's runners (6.3),
  and each write that first sets a runner's `retired_at` appends `process_lost` (L1, 6.5), whose Runs end or unlaunch by
  3.8. A refused start ends its Run `refused (project_inactive)` (3.8), which pauses the inbox
  (3.9). A start or steer H4 refuses (permanent `project_inactive`) fails its input (D53, 3.9),
  as no permanent outcome is re-sent (4.8). A refused native command is
  `Failed` (D34); a refused probe has no answer and is re-probed under its cap (3.7). Deadlines,
  gates and label work (L6) run as they do elsewhere. Other projects keep their ordering.
- Removal does not stop managed OpenCode, which only a full stop ends (then `process_lost`, 9),
  and it disposes the project's relay, so no OpenCode evidence reaches the ledger while the
  project is removed. A transmitted OpenCode send may still act (3.5) until the project returns:
  after a Stop the stop's deadline step ends its work and its Run ends as elsewhere (L6, 3.8),
  and the Stop's interrupt and probe sends are refused. A project that returns needs no input: its OpenCode work reconciles from what
  OpenCode reports (9).
- **Session ended** removes authority over that native session's work. It does not block fresh
  authorized admission, which opens a new native session with start mode `fresh` (4.8).

<!-- src: HLK Rules not tied to one step (9B), step 3; FB §4; SPEC Implementation Decisions (Session-scoped provider failures, Removed project, OpenCode adapter), user stories 22 to 24; model-gaps 2026-10-28; REDESIGN review r1-2; REDESIGN harness r12; REDESIGN-2 (D48); REDESIGN-2 review r3-2; REDESIGN-6 r1 (label work, not stop sequences; ub r1 P3-11); REDESIGN-7 r1 (the outage bound is the stop's deadline and probe deadlines; poteto r1 P2-2); REDESIGN-7 r2 (the removed project's Run ends by 3.8 once the step ends its work; poteto r2 P1-1, P3-5) -->

### 3.12 Persistence

- The ledger's Fact Book tables (Runs, Run Inputs with the native message id, the per-session
  row) are written only by its arm, in the transaction of the main write whose event they fold
  (D58). Main's tables stay main's writers': `provider_runs` (the hold too, `runner_id`,
  `held_transmission`, 4.1), `pending_inputs`, `joined_into` (section 2), receipts and turns.
  There is no version column.
- **The outbox is the Run Effects store (D58).** A Run Effect is a `provider_command_outbox` row and
  the reactor is the effect interpreter (9), for every provider at every point: no second table,
  no per-provider authority flip and no backfill. Main's writers insert main's effects as today;
  the arm inserts only `probe`, `stop_task` and `cancel_request` (3.9).
  The insert's key is a partial unique index on (`project_key`, `command_id`) for those three
  types. The three types are one rule, landed whole in 32.3 (2.1 row 216): the arm's insert, one
  executor per type and a wake after the commit that inserts one. Their rows are exempt from the
  session lane in `nextPendingRequests` and from `armRetryWake` (`nextPendingRequests`,
  orchestration-side-effect-reactor.ts 1292-1336 at 6c9ff950; `armRetryWake`, 504-560). No build
  inserts one without the other two.
  `delivery_indeterminate` stays the row's `error_code`.
- **The outbox's status machine is main's (D58, Q24, Q26).** Its statuses are `pending`,
  `running`, `completed`, `failed`, `retryable_failed` and `cancelled` (`delivery_indeterminate`
  is an `error_code`), with main's transitions at 6c9ff950. Its writers, each in its own body
  and transaction, each guarding `status IN (from)` except `markCompleted` and `writeFailure`
  (below), are the three ledger effects' executors (32.3, 2.1 row 216) and these 15: the command commit (insert `pending`, delete
  a replaced `pending` or `retryable_failed`, orchestration-command-commit.ts 311-325), the arm's
  insert (`pending`), `markRunning` (`running`, its only writer, orchestration-side-effect-reactor.ts
  1338-1424), `markCompleted` and `writeFailure` (from any status, as main), the reactor's outcome
  (`recordControlOutcome`, orchestration-side-effect-reactor.ts 2276-2343), the reactor's control
  recovery (`running` to `pending`, `prepareRecovery`, orchestration-side-effect-reactor.ts
  363-382), the refusal sweep (open rows to `cancelled` or `failed`, it deletes nothing,
  `refuseProjectCommand`, orchestration-side-effect-reactor.ts 2556-2640), project deactivation
  (`drain`, orchestration-side-effect-reactor.ts 385, 441-444) and pending-prompt retirement (open
  rows to `cancelled`, `retirePendingPrompts`, retire-pending-prompts.ts 21, 149-151), the
  runner's settle, resume fallback and legacy requeue (`settleDirectSend`, send-settlement-outbox.ts
  329-376; `settleLegacySend`, 412-475; `requeueLegacySend`, 511-529), the Run's end
  (`settleRunCommands`, projectors-effect.ts 1742-1789), and R2's `acceptStopEffect` (deletes a
  session's `retryable_failed` send rows, orchestration-engine.ts 658, 858). The two migration-time DELETEs (`DELETE
  FROM provider_command_outbox`, migrations.ts 971, 1047) sit outside the machine, and runner
  recovery's lock (`SET status = status`, runner-recovery.ts 356) writes no status. Main's writers
  keep their status transitions. T5-writers (32.3) holds the table of these writers' from and to statuses and fails on
  SQL text that writes outbox status outside it.
  - **`markCompleted` and `writeFailure` keep main's unguarded write.** Neither guards `status`
    (`markCompleted`, `writeFailure`: orchestration-side-effect-reactor.ts 2253-2274, 2753-2789).
    A live run of a non-control, non-send row (`executeRow`, orchestration-side-effect-reactor.ts
    782, 1026-1034) holds no drain lock, so the refusal sweep, project deactivation or control
    recovery can move its `running` row first; main's write then sets the status the waiter
    already returned, and its receipt matches. A `running` guard would leave the row `cancelled`
    beside a `side_effect_completed` receipt, so the T5-writers table allows both writes from every
    status. Their status write is unchanged; only for a control row do they move into the reactor's
    `write` body, as `recordControlOutcome`'s is (2299), to append its `effect_outcome` (2.1 row
    215, 3.4).
  - **A sweep that ends a control row appends its outcome.** The refusal sweep, `drain`'s
    removed-project cancel and pending-prompt retirement already update in a `write` body
    (orchestration-side-effect-reactor.ts 2607-2608, 432; retire-pending-prompts.ts 30-32 at
    6c9ff950). For each control row its update changes, that body appends `effect_outcome` naming
    the row's `command_id` and `attempt_count` (3.4): each `RETURNING` gains `attempt_count`
    (orchestration-side-effect-reactor.ts 2642, 445; retire-pending-prompts.ts 159 at 6c9ff950);
    `drain`'s body takes its `project` handle and appends under each row's `project_key`, as the
    refusal sweep's store does (orchestration-side-effect-reactor.ts 2659-2663 at 6c9ff950); and
    pending-prompt retirement appends before its return on no remaining prompt
    (retire-pending-prompts.ts 43 at 6c9ff950). Their status write is unchanged.
- Typed unions persist as one tag column. New tables add a CHECK on it. Existing tables (SQLite
  cannot add CHECK through ALTER) decode with Schema at the store and reject unknown rows, per row.
- **Load.** On load the ledger rebuilds caches only for sessions with open work: a Run not Ended, an
  unsettled send, a pending interaction or native command, a future alarm, or background tasks live
  or unknown. Other sessions load on first touch. The per-session row is the index. Startup cost is
  proportional to the history of open sessions; checkpoints are added only if measurement shows a
  need.
- During projection replay (the projection runner's `replaying`, 3.1) nothing settles an outcome.
- Replaying a decision's entries through `evolve` from the initial state gives the same view as the
  live state (LI4), so entries are real facts that 32.3 can persist.

<!-- src: SPEC Implementation Decisions (Schema); AUDIT A5, A7; AUDIT-2 A18, Typed states (persistence), Bottlenecks; FB §1, §5 (I4); STOP-INTENT S5; CONT Data shape; SEND-SCOPE-5 S9.1; review 2026-10-28 (H10); REDESIGN-10 (D58: the outbox is the Run Effects store and its status machine the ledger's transition function, called by each writer; the Run Effects table, the authority flips, the backfill, the claim guard and the dispatch deletion removed; ub R9 r3 P1-1, poteto r3 P1-2, P2-5); REDESIGN-10 r1 (the status machine stays main's, checked by T5's table and never called at runtime; the lane exemption is three effects, the kill stays in the lane; ub r1 P1-a, P3-1, removable 4, poteto r1 P2-4, P3-1, P3-6) -->

### 3.13 Model sketch

The reconciled public model. It replaces `run-ledger-model.ts` where they differ; the `.txt`
sketches in this folder are history.

```ts
export type ProviderKind = "claude" | "codex" | "cursor" | "opencode";
// Opaque host string, never parsed; its issuer's (3.4). An effect main issues: each transmission's
// from main's (commandId, transmission), a runner-held start or steer's from its run_dispatched (n
// minted by holdRun, 4.11), any other's from its effect_outcome's `transmission` (n the claimed
// outbox row's attempt_count); a direct start's is its run.requested runId. probe, stop_task and
// cancel_request: from ctx.newId.
export type SendToken = string & { readonly __brand: "SendToken" };
export type Label = string; // `runnerId:querySeq`, or `runnerId` for an older host; split at the last `:` only by L1 and 3.4

export type InputState =
  | { readonly tag: "Queued" }
  | { readonly tag: "Dispatching" }
  | { readonly tag: "Delivered"; readonly certainty: "sent" | "unknown" } // unknown: probe, never resend
  | { readonly tag: "Accepted"; readonly nativeMessageId?: string }
  | { readonly tag: "Failed"; readonly reason: string };

export type LedgerCommand =
  | { readonly verb: "admit"; readonly inputId: string; readonly delivery: "queue" | "steer";
      readonly request: InputRequest } // main's handoff (`input.sent`, D58); InputRequest is main's
  | { readonly verb: "observe"; readonly observation: Observation }
  | { readonly verb: "control"; readonly control: Control }
  | { readonly verb: "settle"; readonly settlement: Settlement };

export type Observation =
  | ({ readonly tag: "Answer"; readonly token: SendToken } & Evidence) // a kind the send cannot produce: Rejected at decide (3.4)
  | ({ readonly tag: "Unsolicited"; readonly label: Label; readonly eventId: string } & Unsolicited)
  // main's run events the arm folds (3.4, D60); run.dispatched and run.released are Answers (4.11)
  | ({ readonly tag: "Main"; readonly eventId: string } & (
      // 3.4: reserves its input's Run under runId, or names the Run that holds it; direct (runsOpenCodeServer) is also a transmission, its token the runId
      | { readonly kind: "run_requested"; readonly runId: string; readonly inputId: string; readonly direct: boolean }
      // 3.9: joins its input to requestedRunId's Run, or starts a steer's own Run
      | { readonly kind: "run_started"; readonly inputId: string; readonly requestedRunId: string }
      // 3.9, L6: turn.completed, turn.error or turn.interrupted, runId its metadata's; ends its Run's work as main (D59)
      | { readonly kind: "run_terminal"; readonly runId: string; readonly outcome: RunOutcome; readonly code?: string }));

export type Unsolicited = Extract<Evidence, { readonly kind:
  | "tasks_snapshot" | "task_event" | "turn_started" | "turn_ended" | "command_lifecycle" | "command_result" // command_*: a native command's, by commandId (D61)
  | "interaction_requested" | "interaction_resolved" // its label's (3.10); resolved: natively or confirming an answer, never an Answer (D61)
  | "activity" | "result" | "query_ended" }>;

export type Evidence =
  | { readonly kind: "started" }
  | { readonly kind: "input_accepted"; readonly nativeMessageId?: string }
  | { readonly kind: "input_declined"; readonly reason: string }
  | { readonly kind: "activity" }
  | { readonly kind: "interaction_requested"; readonly interactionId: string;
      readonly interactionKind: "permission" | "question" }
  | { readonly kind: "interaction_resolved"; readonly interactionId: string }
  | { readonly kind: "result"; readonly outcome: RunOutcome;
      readonly error?: { readonly code: string; readonly retryable: boolean } }
  | { readonly kind: "query_ended" }
  | { readonly kind: "accounting" }
  // transmission: present for an effect main issues with no hold but a direct start, its outbox
  // row's command_id and attempt_count from every writer of its outcome, a sweep's included; n 0
  // when no claim reached the row, which ends the issue never transmitted (3.4); absent for the
  // three effects decide issues
  | { readonly kind: "effect_outcome"; readonly transmission?: MainTransmission; readonly outcome:
      | { readonly tag: "succeeded" }
      | { readonly tag: "retryable"; readonly retryAt: number; readonly code?: string } // code: main's receipt error_code, an answer's lastRefusal (3.10)
      | { readonly tag: "permanent"; readonly code: string } // includes "native_resume_rejected"
      | { readonly tag: "not_sent"; readonly retryAt: number } // host never called the provider (H4): an effect decide issues only, never with a transmission, as main's gate precedes its claim (3.4); retryAt is the outcome time
      | { readonly tag: "delivery_unknown" } }
  | { readonly kind: "probe_result"; readonly finding:
      | { readonly tag: "input_present"; readonly nativeMessageId?: string }
      | { readonly tag: "input_absent" } | { readonly tag: "native_idle" }
      | { readonly tag: "native_busy" } }
  // background work (section 8)
  | { readonly kind: "tasks_snapshot"; readonly tasks: readonly { readonly key: TaskKey;
      readonly taskType: string; readonly subagentType?: string; readonly description: string;
      readonly ambient: boolean }[] }
  | { readonly kind: "task_event"; readonly key: TaskKey;
      readonly event: "started" | "completed" | "failed" | "killed" | "notification" }
  | { readonly kind: "turn_started"; readonly wakeTask?: TaskKey }
  | { readonly kind: "turn_ended" } // a Claude wake's (8.3)
  | { readonly kind: "command_lifecycle"; readonly commandId: string;
      readonly state: "queued" | "started" | "completed" | "cancelled" }
  | { readonly kind: "command_result"; readonly commandId: string }
  // hold facts of a runner-held send (4.11): read from the existing event stream, never copied
  // into a second store. The opaque token identifies this commandId and transmission.
  | { readonly kind: "run_dispatched"; readonly runId: string; readonly runnerId: string;
      readonly commandId: string; readonly transmission: number } // runId names the Run, commandId its issue (3.4)
  | { readonly kind: "run_released";
      readonly reason: { readonly tag: "Refused"; readonly why: "exiting" | "retiring" | "interrupted" }
        | "NotSent" | "JournalAbsent" | "ResumeRejected" }
  | { readonly kind: "delivery_indeterminate" } // the effect row's marker; Settle writes it
  | { readonly kind: "runner_reply"; readonly outcome:
      | { readonly tag: "succeeded" } | { readonly tag: "failed"; readonly code: string } }
  | { readonly kind: "journal_answer"; readonly answer: "running" | "finished" | "uncertain" | "absent" };

export type Control =
  // commandId on each control main issues an effect for: its commit event's metadata.commandId, its outbox row's command_id (3.4)
  | { readonly kind: "stop"; readonly commandId: string; readonly deadlineAt: number | null }
  | { readonly kind: "end"; readonly commandId: string; readonly deadlineAt: number | null } // deadlineAt: the commit's payload.stop.deadlineAt; null for a commit L6 does not fold (no stop, or U2's retire), which opens and joins no deadline (L6)
  | { readonly kind: "run_now"; readonly commandId: string; readonly inputId: string; readonly deadlineAt: number | null } // the interrupt main's `interruptForInput` asks for (5.1, D58); deadlineAt as stop's (L6)
  | { readonly kind: "answer"; readonly commandId: string; readonly interactionId: string; readonly answer: unknown }
  | { readonly kind: "stop_tasks"; readonly tasks: "all" | readonly TaskKey[] }
  | { readonly kind: "confirm_escalation"; readonly snapshotEntry: number }
  | { readonly kind: "native_command"; readonly commandId: string; readonly text: string };

export type Settlement =
  | { readonly kind: "alarm_fired" }
  | { readonly kind: "hold_exhausted"; readonly commandId: string }
  // a runner-held try that ended before any hold (a start failure, StartLost, a gate answer): no token (3.4, 4.4)
  | { readonly kind: "unheld_outcome"; readonly runId: string; readonly commandId: string; readonly outcome:
      | { readonly tag: "retryable"; readonly retryAt: number }
      | { readonly tag: "permanent"; readonly code: string } // includes "project_inactive"
      | { readonly tag: "not_sent"; readonly retryAt: number } }
  | { readonly kind: "process_started"; readonly label: Label; readonly reattached: boolean }
  | { readonly kind: "process_lost"; readonly runnerId: string; readonly retiredAt: number } // retires runnerId (L1, 3.3); one per (runnerId, retiredAt) (6.5); its stop commit's run.released events precede it in that transaction and fold first (4.5)
  | { readonly kind: "session_ended"; readonly cause: "native_session_vanished" }; // no producer at 1ba91324 or 6c9ff950: unbuilt (3.4)

// decide issues only probe, stop_task and cancel_request (3.12), each Tokened; every other kind
// is a main call the arm folds into `live` as Main (3.5, 3.10, 8.4, 8.5), a start or steer from its
// Main observation or its run.dispatched Answer, any other from its Control, and decide never issues
export type RunEffect =
  | { readonly kind: "start"; readonly runId: string; readonly inputId: string;
      readonly mode: "resume" | "fresh" }
  | { readonly kind: "steer"; readonly runId: string; readonly inputId: string }
  // interrupt: a Stop or Run now commit's `payload.stop.owners` (L6), as runIds only (4.6); runId null with no active Run
  | { readonly kind: "interrupt"; readonly runId: string | null; readonly runIds: readonly string[] }
  // label: a projection of the send's address (L2, 3.3); shapes unchanged. end_session: the
  // runner's latest label; null while the address has no label
  | { readonly kind: "end_session"; readonly runId: string | null; readonly label: Label | null }
  // runId null: no Run reads the label (3.10, L6)
  | { readonly kind: "deliver_answer"; readonly runId: string | null; readonly label: Label;
      readonly interactionId: string; readonly answer: unknown }
  | { readonly kind: "cancel_request"; readonly runId: string | null } // OpenCode Stop fallback; fence stays held
  | { readonly kind: "probe"; readonly runId: string | null; readonly target:
      | { readonly tag: "input"; readonly inputId: string }
      | { readonly tag: "native_session" } } // no answer probe: main's answer outcome is never Unknown (3.4, 3.10)
  | { readonly kind: "stop_task"; readonly key: TaskKey }
  | { readonly kind: "send_native_command"; readonly commandId: string; readonly text: string };

export interface DecideContext {
  readonly now: number;
  readonly newId: () => string; // mints a wake Run's id and the tokens of probe, stop_task and cancel_request (3.4) from the folded event's sequence and a counter within the decision, so a replay mints the same ids; never repeats
  readonly policy: { readonly settleMs: number; readonly probeMs: number; readonly nativeCommandMs: number };
}

export type IssuedEffect =
  // Every effect main issues (D60), named by its commandId, each transmission by main's (commandId, transmission) (3.4):
  // a runner-held start or steer from its run.dispatched, under its runId; a direct start by its run.requested runId;
  // any other from its effect_outcome. Hold facts are valid only on a runner-held start or steer.
  | { readonly tag: "Main"; readonly commandId: string; readonly effect: RunEffect }
  // probe, stop_task and cancel_request, which decide issues; each token from ctx.newId().
  | { readonly tag: "Tokened"; readonly token: SendToken; readonly effect: RunEffect };
// main's name for one transmission of an effect it issues: the commandId and its n (3.4); n 0 names
// none, only an issue's end before any claim
export interface MainTransmission { readonly commandId: string; readonly transmission: number }
export interface RunEnded { readonly runId: string; readonly outcome: RunOutcome; readonly reason: EndReason }
export type RunOutcome = "completed" | "error" | "interrupted";
export type EndReason = // 3.8
  | { readonly tag: "completed" }
  | { readonly tag: "process_lost" | "session_ended"; readonly code?: string } // code: the fold's first specific (10A)
  | { readonly tag: "interrupted"; readonly forced: boolean }
  | { readonly tag: "provider_error"; readonly code: string; readonly retryable: boolean }
  | { readonly tag: "refused"; readonly code: string };

export type Decision<Event> =
  | { readonly tag: "Accepted"; readonly events: readonly Event[]; readonly effects: readonly IssuedEffect[];
      readonly ended: readonly RunEnded[]; readonly alarmAt?: number; readonly diagnostic?: string }
  | { readonly tag: "Rejected"; readonly diagnostic: string };

// Send chains (section 3.5): separate unions
type Transport = { tag: "Retrying"; at: number } | { tag: "Failed"; code: SendErrorCode }
               | { tag: "Issued" | "Unknown" | "Sent" };
type Consumption = { tag: "None" }
                 | { tag: "NotConsumed"; why: "declined" | "absent" | "released" | "cancelled" }
                 | { tag: "Observed" } | { tag: "Accepted" };

// Deadlines: tagged by owner, with a required target; alarmAt is the earliest
type DeadlineOwner = "Run" | "Send" | "NativeCommand" | "Stop"; // Run: Settling only; Send: a probe or a delivery recovery (3.7); Stop: the ledger stop deadline, one per session row, its target the row, no field (3.7, L6)

export type InteractionView =
  | { readonly tag: "Pending"; readonly interactionId: string; readonly kind: "permission" | "question";
      readonly lastRefusal?: { readonly attempt: MainTransmission; readonly code: string } } // the refused answer transmission (3.10)
  | { readonly tag: "Answered"; readonly interactionId: string; readonly kind: "permission" | "question";
      readonly delivery: "queued" | "sent" | "unknown" | "settled" };

export interface InputView { readonly inputId: string; readonly state: InputState } // `uncertain` deleted

export interface LedgerView {
  readonly paused: boolean;                 // displayed: main's `readInboxState.paused`, read from main's module (D58)
  readonly active?: ActiveRunView;          // a union by Run tag; `by` only on Interrupting
  readonly inbox: readonly InputView[];
  readonly live: readonly IssuedEffect[];   // work that may still act, in issue order
  readonly tasks: TasksView;                // none | unknown | live (kind, class per task)
  readonly anythingMayAct: boolean;
  readonly pendingConfirm?: PendingConfirm; // step, snapshot entry, tasks it would destroy; its labels are a view (L3)
  readonly lostWork: readonly LostWork[];   // tasks, or "may have been lost"
  readonly nativeCommands: readonly NativeCommandView[];
  readonly interactions: readonly InteractionView[]; // the session's, each its label's (3.10)
}
// ActiveRunView carries runId, tag, deadline, origin ("input" | "wake", waking task if known),
// and inputs in admission order; a Queued Run after an unlaunch carries retryAt?: number, the
// unlaunching outcome's, a field and no Deadline (3.6, 3.7).
// PendingConfirm.step: "retire" | "end_session"; a restart is a retire, then main's relaunch (8.4).

type NativeCommand = Sent | Queued | Started | Unconfirmed | Completed | Cancelled | Failed; // only waiting variants carry a deadline
type TaskKey = { taskId: string; runId?: string };
type Tasks = { tag: "Unknown"; label: Label } | { tag: "Known"; label: Label; tasks: ReadonlyMap<TaskKey, Task> }; // per runner
```

`lastRefusal` names the exact answer transmission, main's `(commandId, transmission)` read from
the `retryable` `effect_outcome` that refused it, and its refusal code (3.4, 3.10).

<!-- src: MODEL; HLK step 1, step 3, Rules (10B); RULINGS R3; FB §2 (model changes: live, project_active, Dispatching, lastRefusal, diagnostic, quarantine removed); D1-1; BG Decision 2; RA §2, §7; AUDIT A1, A3, A11; AUDIT-2 T5, T6, T7, T8, T9, T10; SEND-SCOPE-5 S9.1, S9.4; review 2026-10-28 (H1, H2); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L2, L3; REDESIGN-5 r2 (InputState `Failed`, as a declined steer re-queues, poteto r2 P3-3; NotConsumed{cancelled}, ub r2 F-F); REDESIGN-6 (InputState Cancelled and no `Accepted.cancelled`; DeadlineOwner Label replaces Wake and Tombstone; ub r3 P3-5, poteto r3 P2-2); REDESIGN-6 r1 (livenessMs default; closeMs spaces column steps; `interrupt` carries every label with work and a null runId with no active Run; a column step no Run reads has a null runId; ub r1 P1-A, P1-C, poteto r1 P1-A, P3-6); REDESIGN-6 r2 (livenessMs and the policy comments gone; `probe`, `cancel_request` nullable runId; `deliver_answer` names the label; interaction Unsolicited kinds; EndReason; LedgerView interactions; ub r2 P1-3, P2-1, P2-4, poteto r2 P1-2, P3-1, P3-2); REDESIGN-7 (`close` deleted; `interrupt` names the labels its commit adds with their sends' runs, `latestRunId` gone; `closeMs` gone; `deadline_expired` gone; DeadlineOwner Stop replaces Label, Run is Settling only; ub r3 P1-B, P2-B, poteto r3 P1-2, P2-1); REDESIGN-10 r1 (decide issues only the four ledger effects, the other kinds are main calls the arm folds; the interrupt carries runIds only; a Stop's deadline step is never `kill_and_respawn`; ub r1 P2-8, poteto r1 P2-5, P2-9) -->


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
                    reason: "Refused" | "NotSent" | "JournalAbsent" | "ResumeRejected";
                    why?: "exiting" | "retiring" | "interrupted" } // why: Refused only
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
  | { _tag: "Ended" };    // terminal, no owner send (an unlaunch's dropped issue included, 3.6), or not the run's commandId
holdRun(session, run, commandId): Effect<Hold, StoreFault>
```

One write transaction, in this order:

1. **Covered?** If `stopCovers(session, run)` (5.2): when the run has no hold, settle it through the
   ledger in the same transaction as `interrupted` with one `turn.interrupted` ("Stopped before
   delivery") and return `Covered`. When it has a hold, change nothing and return `Covered`; the
   holder's interrupt or Stop settles it, and if the holder refuses (`interrupted` or `exiting`),
   4.5 releases it and this step settles it. Settlement is idempotent by the run's status guard;
   in the ledger chain the Stop has already ended an unheld (not yet delivered) Run (3.6), and
   this branch is its idempotent backstop. Settlement goes through Send Settlement (4.7) inside
   this transaction.
2. **Dispatchable?** The run is `pending` or `running`, unheld and not terminal. A terminal run,
   a run with no owner send, or a `commandId` that is not the run's returns `Ended`. A held run
   returns `Busy`. At 6c9ff950 these `Ended` checks run before step 1 (runner-retirement.ts
   159-178 before 192-196); the feeder drops the send on either answer (H3), so the order is not
   observable.
   Every domain answer is a value. Only store faults fail: retry unavailable, reject malformed
   rows once through the existing decode error. Never retry all failures as unavailable.
3. **Cap.** If the send already has 5 transmissions, report Settlement
   `hold_exhausted{commandId}` to the ledger, which settles the run `failed` with
   `provider_send_attempts_exhausted` and one `turn.error`, and return `Exhausted`. At most 5
   transmissions per send, the first included, across host runs and restarts within its input's
   reservation (4.8).
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
  runner, or unlaunched if it was never delivered, 3.6) or is refused before the runner sees it.

<!-- src: CONT C2, Confirm before building 1; SWAP S5 refined; STOP-INTENT S5; review 2026-10-28 (H9); model-gaps 2026-10-28; SETTLE Data shape 1, S1, S2; REDESIGN-4 r1 (poteto P2-5); REDESIGN-4 r2 (a dropped issue returns Ended, its effect row finished by the unlaunch; ub P2-3, poteto P2-E) -->

### 4.4 The feeder

- Each session's runner manager has one feeder. It is the only caller of `holdRun` for an owner
  send. Nothing else appends `run.dispatched` and nothing else spawns a runner for a send. From
  32.5 it is also the caller for a joined steer's own transmission (4.11).
- It takes a send when the send is claimed, when a release commits and at restart.
- From 32.6 it also takes `send_native_command` effects, which have no Run:
  with no runner alive it spawns one (8.5).
- **H3. Order.** The feeder transmits in issue order, is the only spawner, and drops a send the
  ledger no longer wants: an owner send when `holdRun` returns `Covered` or `Ended` (a Run
  already Ended, 3.8; an unlaunch's dropped issue, whose relaunch is a new issue, 3.6), a
  `send_native_command` once its send has left `live` (3.5, 8.5).
- The feeder's memory is its queue, keyed by `(session, run, commandId)`, and each send's
  capability (a live handle, or `Adopted`). Every step first reads the registry's project gate
  (H4, 3.11), then calls `holdRun`. A settlement before any hold (a gate answer, a start failure
  or `StartLost`) applies only to a run `holdRun` steps 1 and 2 would pass (not covered, unheld,
  not terminal), checked in its own transaction; any other run goes on to `holdRun`, which settles
  a covered one "Stopped before delivery" (4.3 step 1). A `send_native_command`, which has no Run
  and no hold, is answered as main's outbox row (3.4): removed, the refusal sweep
  ends it `permanent` `project_inactive`; not served, main's gate leaves it unclaimed and it shows
  nothing (H4).
  - removed: settle the send through Send Settlement as a start failure (below), permanent,
    code `project_inactive`, with no hold and no spawn; the ledger reads it as `unheld_outcome`
    (3.4).
  - not served: settle `unheld_outcome` `not_sent` for it, with no hold and no spawn. It appends
    no run terminal; the ledger moves its Run by 3.6 and tries it again (3.7).
  - `Held`: hand the transmission to its write fiber.
  - `Busy`: drop; the hold's owner ends or releases it.
  - `Cleaning`: request candidate retirement, await its commit, then re-enter the gate.
  - `Unserved{Some({runner, until})}`: park until `until` passes, or earlier when that runner's
    in-progress Stop ends it (6.4). Every park end re-enters the gate.
  - `Unserved{None}`: start a serving runner.
  - `Covered`, `Exhausted` and `Ended`: drop.
  - `StoreUnavailable`: one backoff (4.8).

  Every re-entry is a new step. The feeder has no retry loop, no poll and no failure
  handler of its own.
- A start failure, or `Unserved` on the step right after a start (`StartLost`), settles the
  send through Send Settlement (4.7): permanent unless the failure sets `retryable: true`; the
  ledger reads it as `unheld_outcome` (3.4) and moves its Run by 3.6. A spawn the registry
  refuses because a removal is in progress is `not_sent` (H4). It is never retried in the feeder
  (main parity).
- The write fiber runs a release that fails on the store again after one backoff, until it
  commits (4.5's no-op rule makes the repeat safe). A release a stop commit carries is the
  reconciler's (6.3).
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
- The write fiber races its transmission, until the write permission is taken, with the run's
  coverage on the commit signal. A covering Stop or a terminal run takes the permission and
  releases NotSent. Once either side takes the permission the race no longer reads coverage and
  never ends the write. A faulted coverage read takes nothing. This race replaces the readiness
  race in SETTLE S1; SETTLE S1's "the host refuses" sentence now describes only a Stop that
  comes after the permission.
- **Write gate.** The write fiber calls write only while its runner's stop state is `Running`
  (6.4), read in the same synchronous step as the write. Registering a stop intent
  (`Committing`) closes it before the stop transaction; any return to `Running` (6.4) reopens
  it. So the runner's possibly-written set (4.5) is fixed while any stop of that runner
  commits, and the stop commit releases `NotSent` every hold it reads on that runner outside
  that set, including one held after its evidence read. While the gate is closed the write fiber
  waits: it writes after a return to `Running`, and ends without writing once its transmission
  is released (the capability's watermark), the release being its outcome. A runner stop takes
  no write permission; only a covering user Stop or a terminal run does (above).
- The resume mode is the outbox payload's `nativeResumeFallback`, not part of the key; at
  `Held` the frame is built in the payload's mode, and a capability in the other mode is
  replaced.
- The reactor's recall of a still-unheld send settles it `failed` (`processing_timeout`)
  through Send Settlement; a held send is untouched, including its marker. The recall fires when
  its claim's processing timeout passes, and reads durable facts in the settling transaction (the
  exact claim, correlated as in 4.7, and no `run.dispatched` hold for it). It never keys off a
  polled receipt state such as `side_effect_failed`, which a later claim's `run.requested` can
  rewrite. Only Settle writes
  runner-held `delivery_indeterminate`; the reactor's marker remains direct-provider-only. No in-memory
  cancellation of a queued owner send remains. Each write owner retains settlement evidence until commit or
  staleness; a failed settlement never restarts the send. The native-resume preparation
  caller still receives a typed attempt refusal immediately after its release commits.
- A send waits on its run, never on the socket. A socket or write failure leaves it held until
  release evidence (4.5) or the run's settlement.
- Every release, whoever commits it (the feeder's runner, the reconciler, adoption), wakes the
  feeder in the same step, so no release is lost; its restart scan finds the run if the daemon
  dies first. A held run never waits on a loop that has ended.
- A re-hold after a release goes immediately and counts toward the cap. The release queues its
  key again, even while that key is being stepped (a send with no queue entry enqueues as
  `Adopted`), and that enqueue is the re-hold, as on R2, except `ResumeRejected`, whose re-hold is
  the caller's fresh fallback (4.5, 4.8).
- **Adoption is not a transmission.** When restart adopts a live runner that still holds a run, it
  appends nothing, checks no coverage and counts nothing toward the cap (7.2).

<!-- src: CONT C2 (feeder, adoption), C3 (release hands off), closing paragraph on S9.5; review 2026-10-28 (H9); model-gaps 2026-10-28; SETTLE S1, S4; REDESIGN 2026-10-28 (02-options-and-pick.md) H3; 32.29.7 review r2 (P3-3); REDESIGN-3 (write gate, A.13); contract r16 (recall on durable facts) -->

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
    `exiting` and `retiring` the runner is leaving: the refusal joins or raises its stop (6.4),
    and once that stop leaves `Committing` the refusing transmission's write fiber commits the
    release, a no-op if the stop commit carried it (below). Once that stop has committed, the
    next `holdRun` returns `Unserved`, never the same runner; if it returned to `Running` (6.4),
    the re-hold may reach the same runner, and each refusal counts toward the cap (4.8) until its
    confirmed exit stops it (6.3). A Reserved runner never refuses; a
    command cancels its reservation (6.9), so a swap never releases a send. A runner whose build
    predates `command-refused` refuses with `command-reply{failure.code: "runner_idle_exit"}`
    before any `command-accepted` for that transmission; that reply is `Refused{exiting}`. The
    host's `idle-exit` and first `retiring` refusal release by the stop commit (below, 4.6).
    No other reply code is refusal evidence.
  - **NotSent.** The daemon never called write for this frame: the socket was closed, adoption's
    hello reported `not_received`, a covering Stop or a terminal run took the write permission
    before the first byte, or a stop commit reads its hold outside the runner's possibly-written
    set (below).
    A write that was called and failed, or a missing `command-accepted`, is not
    evidence. A Stop that covers a held send before its first byte takes the write permission.
    The daemon then never calls write, so the send is NotSent and is released, and the next `holdRun` returns `Covered`
    and settles it `interrupted` with one `turn.interrupted` ("Stopped before delivery") (4.3
    step 1, 11.1). Once the permission is taken, a Stop leaves the write alone and is answered at
    the host (4.6). If its `interrupt_turn` reaches the host first, the host refuses the send
    `interrupted`, the send is released as Refused, and 4.3 step 1 settles it the same way.
    Otherwise the host accepts the send and the interrupt stops the running turn. If the coverage
    read fails, the daemon logs the fault and the transmission proceeds and writes normally. A
    later Stop is then answered at the host in the same way.
  - **JournalAbsent.** The journal read is typed: `Absent | Present(state) | Unreadable`. Only
    `Absent` from a runner whose process is confirmed exited (the reaper's pid and start-time
    check) and whose build writes the journal before executing releases. A live runner is adopted
    instead. `Unreadable` (unreadable directory, corrupt record) and any older-build runner mean
    `delivery_indeterminate`, never a release. `Present` settles from the journal answer (4.9).
  - **ResumeRejected.** The runner reports that the provider rejected native resume before
    executing the input. `prepare-turn` releases; main issues a new start with mode `fresh` and the
    same `commandId` (D60), which the arm folds into `live` (3.4). The feeder does not re-hold the
    release itself; `holdRun` binds the new decision as transmission `n + 1`, counting toward the
    cap (4.8).
- **A stop commit carries the releases it has evidence for.** Every stop commit, for any
  `StopReason`, appends the release of each transmission held on that runner for which its evidence
  read (before the transaction, 6.3; a store-fault retry reads again) finds evidence: `Refused` for
  each one a refusal read on that runner's connection names (4.6); `NotSent` for each hold its
  transaction reads on that runner outside the possibly-written set (below); `Refused{exiting}` for
  one an `idle-exit` read first covers, `Refused{retiring}` for one a first `retiring` refusal read
  covers (above, 4.6); `JournalAbsent` for an `Absent` one when the
  target is already confirmed exited (the reaper's pid and start-time check, as restart's `recover`
  and failure cleanup stop a dead pid `Exited`, 7.2), from Settle's journal read (7.3) run first.
  The evidence read freezes the **possibly-written set**: each transmission this daemon called write
  for, and each hold an earlier daemon made, which has no write evidence here and waits for
  adoption's hello (`not_received`, 7.2) or Settle's journal (7.3). The set is exact and fixed: the
  closed gate stops every write (4.4), only this daemon's `holdRun` makes a new hold, and none
  commits after the retirement (4.3), so a hold made after the read is unwritten and released. A
  later release of a transmission the commit released is stale. The commit appends these
  `run.released` events, and its `process_lost` (2.1 row 215) follows them in that transaction, so
  the arm folds them first, by sequence (L1). So a start its
  runner never received leaves its Run not yet delivered (3.6), and its relaunch addresses the next
  runner (L2). A later release of one it did not release (a refusal read after its evidence read,
  F40; `JournalAbsent` for a frame written to a runner stopped while alive that exits before reading
  it, F51) finds its transmission sealed (D52) and moves only its input (3.9). This replaces the pre-write `runnerIdleFailure`: an announced idle exit is a stop commit
  (6.3).
- `release` is the lifecycle module's eighth call (6.10). The `Idle` stop reason is written by
  idle exit, and by an `exiting` refusal only if it finds the runner `Running` (6.4).

- A failed release write is retried by its caller's owner: the feeder's write fiber (4.4) for a
  release outside a stop commit, the reconciler for one a stop commit carries (6.3), or the
  reconciler's cadence for Settle. An adoption release failure propagates through attachment
  recovery; bounded reconnect exhaustion retires the runner and hands its held runs to Settle.

<!-- src: CONT C3, Deleted or changed (lifecycle module); review 2026-10-28 (M7, H11); model-gaps 2026-10-28; SETTLE S1, Verified requirements 5; 32.29.7 review r2 (P3-3); REDESIGN-3 (stop-commit releases, A.13); REDESIGN-4 r2 (late release a pointer to D52; poteto P2-F); REDESIGN-5 r2 (the retiring release points to 4.6; poteto r2 removable) -->

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
- **Idle exit is the host's last acceptance (host fact).** The host sets `exiting` and writes
  `idle-exit` in one synchronous step, and reads `exiting` before anything else when a command
  arrives, writing `command-accepted` in that same step. So on one connection every
  `command-accepted` precedes the host's `idle-exit`, and a `send-turn` the host reads after it is
  refused `exiting` (an older build: `runner_idle_exit`, 4.5) or never read before the process
  exits. A reconnect is not read until the previous connection has drained, and the daemon reads
  one connection's frames in order. So a transmission written on that connection with no
  `command-accepted` read before `idle-exit` was never accepted and never will be (4.5).
  `retiring` is the same: the host sets it once, never clears it, and reads it in the step that
  writes `command-accepted` (runner-host.ts 241, 378-381, 819-823, 864-870 at 6c9ff950), so a
  transmission written with no `command-accepted` read before the connection's first `retiring`
  refusal was never accepted and never will be. A runner-initiated retirement's stop is raised by
  that read, so its commit carries those releases and waits for nothing more (6.4, F30, F40).
- **From 32.5 (OPEN-5, section 9).** The run id stays a coverage label, never a send identity.
  `interrupt_turn` carries `payload.stop.owners` as `runIds` only, with no label and no turn;
  label work ends through the ledger's probe (32.3) or the stop's deadline step (L6), not the
  interrupt. On receipt, and only then, it interrupts the turn running on the session's query,
  unless that turn is a `send-turn` of a run the frame does not name, so a late frame never stops a
  newer send's turn. Each accepted, unstarted command of a named run is recalled while unplaced
  (claude-runner-payload.ts 2958-2972 at 1ba91324), else interrupted when its turn starts; that
  mark ends at the command's result or cancellation. Nothing else is interrupted: a later turn (a
  wake's, a newer send's) runs, as main clears its interrupt at the interrupted turn's result
  (claude-runner-payload.ts 2420). The interrupt rejects the interactions still open on that
  query natively, at once while it waits on the user, else once the SDK accepts it, and again at
  the interrupted result (2338-2356, 2997-3002, 3024-3034; 3.10). The host answers a `send-turn` in this order:
  `exiting`, `retiring`, `interrupted` (its `runId` is recorded), a duplicate token (the journal's
  answer, never a second native query), else accept. The `runIds` come from `payload.stop.owners` (5.4).

<!-- src: CONT C3 (host's interrupt refusal), Required work 3; OPEN-5 decision; contract r15 residual fix: main at 3aa43c60, src/lib/provider/runner/runner-host.ts:125-137 (beginExit), :333-342 (a second socket destroyed, a hello refused while exiting), :652-678 (exiting checked, then command-accepted); R2 branch at 6c9ff950, same path, :258-270 (beginExit), :819-840 (refusal order), :864-870 (command-accepted), :1121-1142 (a reconnect waits for the old stream's EOF), src/lib/provider/runner/runner-connection.ts:191-199 at 3aa43c60; REDESIGN-6 r1 (`interrupt_turn` names every label with work; ub r1 P1-A, poteto r1 P1-A); REDESIGN-6 r2 (label-only addressing: the host interrupts every turn on a named label's query until its next accepted `send-turn`, no turn handle; ub r2 P2-3, poteto r2 P2-1); REDESIGN-7 (the interrupt acts at receipt on the running turn and on the named runs' accepted unstarted commands, nothing later; the labels its commit adds, with their sends' runs; `latestRunId` and the until-unrecorded-run mode gone, as main clears its interrupt at the result; ub r3 P1-B, poteto r3 P1-2); REDESIGN-7 r1 (the native rejection is the host's, read by 3.10; ub r1 P1-2) -->

### 4.7 Outcome and the duties committed with it

- **The Run Ledger owns every Run Effect's outcome**, for sends and control effects alike. Until the
  ledger chain lands, the owner is the run's settlement path: for a runner send, a socket failure,
  a write failure or a missing reply is never reported to the reactor as the send's outcome, and
  the reactor writes its terminal outbox status only from its run's terminal settlement.
- **Send Settlement** owns explicit settlement of a modern owner send at every ticket (D58).
  Native terminal projection remains the existing separate source at main's
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
  | hello: runner never got it (`not_received`) | `run.released` `NotSent`, read as Consumption NotConsumed{released} (4.11) |
  | delivery unknown | `observe` `effect_outcome` `delivery_unknown`; runner-held: Settle's `delivery_indeterminate` (4.11) |
  | native resume rejected | `effect_outcome` `permanent`, code `native_resume_rejected`; runner-held: `run.released` `ResumeRejected` (4.11) |
  | daemon refusal (project removed, H4; admission timeout) | the refused send's `effect_outcome` `permanent`; runner-held: Send Settlement's permanent outcome before any hold, read as `unheld_outcome` (4.4, 4.11) |
  | project not served (H4) | an effect decide issues: `effect_outcome` `not_sent`; runner-held: `settle` `unheld_outcome` `not_sent` (4.4), its Run moving by 3.6; a row main's executor runs: none, its gate precedes its claim (3.4) |
  | Stop | `control` `stop` |
  | Cancel | none: main's Cancel arm (D55) |
  | runner lost | `settle` `process_lost` |

- During projection replay (the projection runner's `replaying`, 3.1) nothing settles an outcome.
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

<!-- src: SEND-SCOPE-5 S8, S9.1, S9.2, S9.6; CONT C1 (Outcome stays with the Run Ledger; Delivery is owned by the hold); review 2026-10-28 (H1, H2); SETTLE Data shape 2, 3, S2; REDESIGN-6 r1 (Stop and Cancel rows split; poteto r1 P3-5) -->

### 4.8 Retries, the cap, the resume fallback and steers

- **A message the agent did not accept.** A send is re-sent only while its Run is active, by 3.6's
  retry or relaunch, up to the cap. After its Run ends its input follows its place (D53, 3.9), so
  no Run end re-sends anything. A `delivery_unknown` input stays Delivered{unknown} (3.7, 3.9) and
  is never re-sent. A permanent outcome other than a rejected resume (F65, F67) is never re-sent:
  its input fails (3.9), unless it is Stop's own, `Refused{interrupted}` or
  NotConsumed{cancelled}, which follow Stop, Run now or `end` (4.6, 9) and place their input by D53
  (3.9). This replaces the
  native projection settling undelivered sends with the Run's outcome.
- **Refusals and declines.** A host `Refused` release (4.5) is a fact about its transmission,
  NotConsumed{released} (3.6, 4.11), never a decline: `exiting` and `retiring` are transient;
  `interrupted` is Stop's own (above), never retried. A
  provider decline (`input_declined`) is NotConsumed{declined} (3.5). Codex and Cursor steer a
  send that meets a busy session into the active turn (codex-runner-payload.ts 301;
  cursor-runner-payload.ts 310-313 at 1ba91324) and decline it only when that turn cannot take
  it: Codex `/compact` or a manual compaction, a turn settled, cancelled or not yet executing, or
  a steer it did not deliver (1103-1110, 1133-1142, 1166); Cursor with no steer handler, steers
  not accepted, a cancel requested, or images (310-313, 792-799). Claude never declines: its
  `command_lifecycle` `cancelled` before `started` is NotConsumed{cancelled}, Stop's own (9). OpenCode never declines (it
  queues steers, provider-instance.ts 165-168). A transient refusal or a start's decline is tried again up to the
  cap, a product choice: by its relaunch while its Run is not yet delivered, otherwise in its
  execution, a start's retry waiting for the fence (3.6, D47). Where main differs, a 2.1 row says
  so.
- **Steers.** Until 32.5, a joined steer is carried by its owner's holder: if its runner never
  received it, it is moved to `retryable_failed` with `next_attempt_at = now`, keeping its run and
  `request_sequence`, writing no event, and the reactor re-sends it as a `Fresh` send with an incremented attempt and a new `sinkId`. This is the
  one re-send outside the feeder. Its re-hold resolves to the owner's current runner (4.3), never
  the runner it was first held on, so a swap that releases the owner's start and the steer
  `NotSent` re-sends both, never fails the steer. From 32.5 a joined steer has its own transmissions
  and the feeder re-holds it like any send (4.11). Later sends of the session wait behind it.
- **Backoff and cap.** One backoff function (1 s, 2 s, 4 s, 8 s, capped at 30 s) applies to
  re-sends after a retryable provider failure, anchored at its outcome; `retryAt` is a lower bound
  (3.7). The cap is 5 transmissions per send or control effect. For a runner-held start or steer,
  `holdRun` is the only cap, durable and counted from
  `run.dispatched` (4.3 step 3); for a direct send, `markRunning` reads it before its claim (2.1
  row 212); for a ledger effect, `decide` applies it, counting every issued token but a
  `not_sent` one (3.5). A re-send after `input_absent` or a
  release goes at once but counts. Past the cap, an input's send fails (3.9); probes follow 3.7.
  The same backoff spaces the feeder's re-entries after
  `StoreUnavailable`, the write fiber's repeated release, and the reconciler's retry of a failed
  Stop commit. The ledger folds a retryable outcome (3.6); Send Settlement ends a runner-held run
  on it and the reactor re-sends on a fresh run, as main at every ticket (4.7, F79); a retry is a
  new transmission of the same ledger Run, whatever main's runId (3.4). An input queued again (D53) keeps its `commandId`, as main re-admits a requeued
  input under its input id (provider-turn-session.ts 363-375, session-inbox.ts 670 at 1ba91324).
  The cap counts that `commandId`'s transmissions within its input's reservation, whose fact is
  the input's latest `input.sent` (main's handoff, written at each admission's dispatch,
  provider-turn-dispatch.ts 804-821; read by Stop, provider-turn-session.ts 342-343 at 1ba91324):
  `holdRun` counts the `commandId`'s
  `run.dispatched` with a sequence after that fact (32.29), so a re-queued input gets the full cap
  again. A re-send onto a fresh host run (F50, F79) writes no `input.sent`, so
  it is not a reservation and keeps its count. 6c9ff950 counts `run.dispatched`
  session-wide (runner-retirement.ts 152-215). A start failure precedes any hold and a
  `not_sent` outcome precedes any hold or adapter call; neither counts a transmission, so one that
  keeps recurring re-sends without a bound at the 30 s cap, as on main. A `not_sent` outcome (a
  project not served, H4) ends only its try: a start's Run moves by 3.6.
- **The resume fallback is a new transmission.** A rejected native resume ends that transmission
  (released `ResumeRejected` for a runner send) and is a session end (3.4). On a Run not yet
  delivered main issues a new start under the same `commandId`, mode `fresh` (its relaunch, 3.6;
  D60), which the arm folds into `live`; `holdRun` binds it as `n + 1`. After a transmission that
  possibly reached the agent the Run ends `session ended` (3.8), and its input follows its place
  (3.9), its next start `fresh` (3.4). The feeder does not re-hold the release itself. Until 32.5,
  its existing fallback marker keeps the runner's deduplication key distinct; from 32.5 it is
  transmission `n + 1`, so its token is distinct with no marker (9). A rejection of the fresh
  transmission is terminal and visible. No payload marker decides the outcome.
- **Decided (model-gaps, 2026-10-28): start mode is on the start.** The start effect carries
  `mode: "resume" | "fresh"`. `resume` uses the host's native cursor if it has one; the ledger
  never knows the cursor. Main issues the start (D60), `fresh` after session end (3.4), a rejected
  resume included, and the ledger reads the mode from the start it folds into `live`. The fresh
  transmission starts a new native session and clears the stale cursor. Rejected: the host picks
  mode at dispatch (two owners); inferring mode from `n` (`NotSent` also makes `n + 1`).

<!-- src: SEND-SCOPE-5 S9.3, S9.4, S9.5; SEND-SCOPE-4 S7; CONT Data shape (Scope), C3 (ResumeRejected), closing paragraph, Out of scope, Deleted or changed; CONT failure mode 39; review 2026-10-28 (H1, H9, M6); model-gaps 2026-10-28; SETTLE S1, S3, S4; contract r16 (retryable after leaving conduit, same execution); REDESIGN-4 r1 (decline classification, late release value test); REDESIGN-4 r2 (refusals and declines one distinction; ub P2-3, P2-4, poteto P1-C, P2-E, P3-2); REDESIGN-5 (no Run-end re-send, D53; Codex and Cursor steer a busy send, at 1ba91324 codex-runner-payload.ts 301, 1103-1110, 1133-1142, 1166, cursor-runner-payload.ts 310-313, 792-799; ub r3 P2-7, poteto r3 P2-5); REDESIGN-5 r2 (the reservation fact, `input.sent` before the switch, counted by `holdRun`, 32.29; main caps no send and recommits MAX(attempt_count) over every row left, orchestration-command-commit.ts 274-282, 300-307, provider-turn-session.ts 384-385 at 1ba91324; NotConsumed{cancelled}; ub r2 F-C, F-F, P3-b, poteto r2 F3, P3-4); REDESIGN-10 r1 (the Deleted list removed: main runs whole, D58; ub r1 P2-7) -->

### 4.9 Journal answers

- The runner host's journal is keyed per send, never by input id or run id: by the outbox command
  id and attempt until 32.5, and by the Send Token (4.11) from 32.5 (OPEN-5). It refuses a repeat
  and is not a second owner of delivery.
- A current-build runner reports, for every send its journal retains, one answer computed from its
  own records:

  | Answer | Meaning | Daemon action | Ledger evidence (4.11) |
  |---|---|---|---|
  | `running` | a call in this process owns it | adopt | `journal_answer`, read as `input_present` |
  | `finished` | the send's key (until 32.5 attempt and fallback flag; from 32.5 the token), result or failure | an actual terminal result or failure settles through Send Settlement, main's (4.7); without one, the send's work waits for its own evidence, coverage or the stop (L6) | `journal_answer`, read as Consumption Observed only |
  | `uncertain` | retained record, no outcome, no owning call | at adoption: stays held, nothing written (7.2). At Settle: `delivery_indeterminate` (`runner_send_uncertain`), written by Settle only (4.7, 7.3). Never re-sent | Settle's `delivery_indeterminate`, read as Transport Unknown |
  | `absent` | no record | owner sends: 4.5 (adoption `not_received` is NotSent; an exited runner's `Absent` is JournalAbsent). Joined steers: requeue (4.8) | `run.released` `NotSent` or `JournalAbsent`, read as NotConsumed{released} |

- The hello reports each held transmission's status (7.2). The statuses and the journal answers
  are one vocabulary:

  | Hello status | Journal answer | At adoption (7.2) |
  |---|---|---|
  | `received`, `running` | `running` | adopted |
  | `not_received` | `absent` | released `NotSent` |
  | any other | `finished` | an actual terminal result or failure settles through Send Settlement, main's (4.7); otherwise its evidence, coverage or the stop (L6) ends it |
  | any other | `uncertain` | stays held; only Settle writes `delivery_indeterminate` |

- The daemon maps each answer without inference. The ledger chain (32.6, 32.14) reads these
  answers as evidence from the event stream, never as stored chains (3.13, 4.11), and uses them as
  the runner side of its `probe` effect rather than building another.
- Main-built runners: see 7.4.

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
- Direct-provider uncertainty is 32.2.6's `decide`; the reactor stays the marker's one writer and
  appends that rule's evidence event from 32.11 (2.1 row 215, D58).

<!-- src: CONT C1 (Direct providers); review 2026-10-28 (M1, H10) -->

### 4.11 Runner-held sends in the ledger chain

**Build target (settled).** 32.17 is built against sections 4.1 to 4.10. The ledger chain builds
on the hold, `run.released`, the feeder, `stopCovers` (5.2) and the journal answers (4.9). It may
not add a second owner of the hold, of coverage or of the transmission count. Its `decide` takes
over send outcomes for direct providers, and a retry is a new transmission of the same ledger Run
(3.4, 3.6, 4.8); inputs a Stop or Run end leaves are placed by D53 (3.9, 5.4).

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
  | settled before any hold (a start failure, `StartLost` or a removed gate answer, 4.4) | the run terminal event Send Settlement appends (4.7), `unheld_outcome` to the decider (3.4); its Run moves by 3.6 | Transport Failed{code}, or Retrying when `retryable`; Consumption None |
  | not served before any hold (H4, 4.4) | the feeder's `unheld_outcome` `not_sent` | Transport Retrying; Consumption None; no run terminal; its Run moves by 3.6 |
  | held, no other evidence | `run.dispatched` with no later `run.released` for that transmission | Transport Issued; Consumption None |
  | released `NotSent` or `JournalAbsent` | the `run.released` event | Consumption NotConsumed{released} |
  | released `Refused` (`exiting`, `retiring`, `interrupted`) | the `run.released` event | Consumption NotConsumed{released} |
  | released `ResumeRejected` | the `run.released` event | Transport Failed{`native_resume_rejected`} |
  | `delivery_indeterminate` | the effect row's marker, written by Settle (the outbox row's `error_code`, 3.12) | Transport Unknown |
  | runner reply | the runner's `command-reply` event | `effect_outcome` / `result` |
  | journal `running` | the hello's journal answer event | Consumption Observed (`input_present`) |
  | journal `finished` | the journal answer event | Consumption Observed only |

Adoption appends nothing, so it is not a hold fact. A journal `uncertain` answer changes no chain
by itself; Settle's `delivery_indeterminate` carries it (4.9).

For the ledger, journal `finished` proves consumption only. Outcome comes from the replayed
`runner_reply` or `result`, emitted as separate evidence. Without one, its evidence, coverage or
the stop's deadline step ends it (L6). An actual terminal journal result or failure settles
through Send Settlement, main's at every ticket (4.7, 4.9); missing and intake-only results do
not settle. `ResumeRejected` remains a release. A finished answer never invents `result` or
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
`request_sequence`), and the outbox command id plus a separate attempt counter for a runner-held
start or steer (a second count of the same transmissions). For any other effect main issues, the
outbox `attempt_count` is the only count, so it names them (3.4).

**One minter and one cap.** For a runner-held start or steer, `holdRun`'s `run.dispatched` is the
only minter of `n` and `holdRun` is the only cap (4.3). For any other effect main issues,
`markRunning`'s claim is the only minter of `n` (`attempt_count`, reactor 1352 at 6c9ff950) and
`maxControlAttempts` or main's send budget the only cap (3.4). `ctx.newId` mints only a wake Run's
id and the tokens of probe, stop_task and cancel_request (3.4). Nothing else counts transmissions.

**Joined steers (from 32.5).** A joined steer gets its own `run.dispatched` per transmission, keyed
by the steer's `commandId` and naming its owner's runner; its opaque token identifies that transmission.
The feeder holds it through `holdRun` like any send: coverage is decided for the steer's own run id
(4.1), and its transmissions count against its own cap. Until 32.5 the as-built rule of 4.8
stands: the owner's holder carries it and the reactor re-sends it.

<!-- src: AUDIT-2 T8; FB §3; CONT C1, C2, Data shape, Decisions (O); STOP-INTENT S5 (last bullet); SEND-SCOPE-5 S8, S9.1; SEND-SCOPE-6 S10.1; review 2026-10-28 (H1, H2, H9); model-gaps 2026-10-28; SETTLE S2 (source-aware provider migration); REDESIGN-4 r2 (released maps to NotConsumed{released}; poteto P2-E) -->

## 5. Stop and coverage

### 5.1 What Stop does to a Run

- **Stop always stops.** Stop or Run now withdraws every pending retry of the active Run (3.6)
  and asks for its end, naming its owner runs in `interrupt_turn` (4.6; OpenCode's abort, below),
  with or without an active Run, through main's `stopping` entry; its commit's `deadlineAt` bounds
  the label work with no open main run (L6). The Run-end rule (3.8) then ends it
  `interrupted`,
  at once and with no effect, when nothing of it may still act: a Run not yet delivered (3.6) is
  one, and so is a Run whose only outstanding obligation is its start's retry. Otherwise Stop
  moves the Run to Interrupting under the stop's deadline (L6); an Interrupting Run issues no
  retry, and the same rule ends it `interrupted` once nothing of it may still act (its start
  refused `interrupted`, Stop's own, 4.6, 4.8, or released by a stop commit, 4.5), at its native
  interrupted result, or once the ledger stop deadline's alarm has ended its work (forced, 3.8). A late
  acceptance after either end is late evidence (3.8). The fence holds the next Run while a label
  has work (L6, 3.6). A stopped Run's inputs, start and steers
  alike, follow their place (D53, 3.9): one never handed over or unconsumed (3.6) is placed by
  `acceptStopEffect`'s requeue, paused, as main's (provider-turn-session.ts 329-388 at 1ba91324). This
  amends SEND-SCOPE-5 S9.3 (Q25 = E), which returned a stopped start's text to the composer; the
  user ratified it on 2026-10-30.
- **OpenCode** has no runner to retire. Its Stop is: main issues the native abort; the Stop's
  decision issues `cancel_request` and `probe native_session` together, the probe's retry deadline
  running from that issue (3.7); and the native-session fence holds until `query_ended`, a covering
  idle probe (D26) or the stop's deadline step, which ends its work and so its Run (L6, 3.8).
- **Live or unknown background tasks** put a confirm gate in front of destruction (8.4). An ignored
  interrupt with live or unknown tasks stays Interrupting with a pending confirm, and the stop's
  deadline step alone never destroys them.
- Stop is not a goal action. Stop never pauses or clears a goal (8.6).

<!-- src: SPEC Implementation Decisions (Stop that always stops; quarantine sentence withdrawn by D1-5); D1-1 to D1-5; D1 (OpenCode is unaffected); BG Decision 3 (goal flow separate from Stop), Decision 4; REDESIGN 2026-10-28 (02-options-and-pick.md) L1; contract r15 (D50); contract r16 (Stop at once when nothing may act: main's `prepareStop` returns a stopped send at once and deletes its retry, provider-turn-session.ts 329-388 at 1ba91324; a sent input is re-queued `failed`, 362-377); REDESIGN-5 (stopped inputs follow D53 behind the pause); REDESIGN-5 r1 (Stop interrupts every outstanding wake label through this path, E2; S9.3 amendment ratified by the user 2026-10-30); REDESIGN-5 r2 (the wake deadline a pointer to 8.3; the three-valued test; poteto r2 F1, P3-2); REDESIGN-6 (the forced end runs its labels' one stop sequence, L6, in place of the Run's own close and second deadline; ub r3 N1); REDESIGN-6 r1 (Stop and Run now name every label with work, with or without an active Run; OpenCode's fence also lifts at exhaustion; ub r1 P1-A, poteto r1 P1-A, P1-B); REDESIGN-6 r2 (the fence ends with its label's work; the retry-only Run; the deadline a pointer; with neither Stop issues nothing; ub r2 P3-1, P3-2, poteto r2 P3-1, P3-3); REDESIGN-7 (Stop adds to the session's one stop, whose deadline is fixed at its first commit and whose one deadline step forces the end; the Run's own deadline and the "deadline passes" bullet deleted; OpenCode lifts at the stop's deadline step, as main's `stop_unconfirmed`; ub r3 P1-A, poteto r3 P2-2); REDESIGN-7 r1 (an empty Stop opens no stop; ub r1 P3-2); REDESIGN-7 r2 (a killed Run ends by 3.8, at its kill's `process_lost` while a start or steer is unsealed, and the OpenCode Run at the step; the next Run launches once it ends; ub r2 P2-A, poteto r2 P1-1, P2-1) -->

### 5.2 Coverage

- **Stop coverage is main's (D58).** It is decided per run. It is a different fact
  from a send's coverage (L1, 3.4), which only ends that send's work (3.5) and never says whether
  it reached the agent (3.6). A run is Stop-covered when a committed Stop control row of its
  session lists it in `payload.stop.owners`.
- One predicate, `stopCovers(session, run)`, answers it. It is main's, in session-run-settlement.ts
  (98 at 6c9ff950) beside `sessionRunOwnersQuery`. `holdRun` and the reactor's own stop-owner read both use it.
  Nothing in memory answers coverage.
- `legacyStopOwnersQuery` (outbox order) is a read-only fallback for control rows written before
  `payload.stop` existed. It never decides for a newer row: a recommit re-inserts a send with a new
  `request_sequence` and would escape it. `legacyStopOwnersQuery` stays main's at every ticket;
  R2's replay path reads it (`legacyStopOwnersQuery`, orchestration-engine.ts 740 at 6c9ff950).
- Coverage of a send is decided for the send's own run id (4.1).

<!-- src: CONT C1 (Coverage), Data shape (Scope); CONT failure mode 33; REDESIGN review r1-2 -->

### 5.3 Stop acceptance is one commit

The engine owns control acceptance: R2's `acceptStopEffect` (orchestration-engine.ts 658-940 at
6c9ff950), run whole in one `durable.write` body, as main (D58). Its one difference is 2.1 row
205: the body appends `permission.resolved` after reading the view. The arm reads the control
row's projected `stop` only to open the ledger stop deadline (L6).

- Execution of the accepted command id follows the commit; nothing nests.
- A waiting send is therefore never uncovered between the cohort snapshot and the control row.
- The `interrupt_turn` frame carries `payload.stop.owners` as `runIds` (4.6).

<!-- src: CONT C1 (Stop is accepted in one commit), Confirm before building 3, Required work 1; CONT failure modes 24, 44; REDESIGN-9 r2 (step 4 calls main's Stop write, poteto r2 P2-4); REDESIGN-10 (D58: the steps are R2's `acceptStopEffect` body, with the arm inside its `project`; the nested call deleted; ub R9 r3 P2-A, poteto r3 P1-1) ; REDESIGN-10 r1 (the six steps made a pointer to the 2.1 rows; poteto r1 removable); REDESIGN-11 (D59: rows 203 and 204 deleted; the arm reads the stop only for the ledger deadline) -->

### 5.4 Stop cohorts and run joining in the ledger chain (decided OPEN-3, 2026-10-28)

- Coverage has one owner at every point in the build order, `stopCovers`, for every provider.
- Rejected: the ledger replacing the Stop cohort at 32.13 (OPEN-3's A), because deleting
  `stopCovers` and `payload.stop.owners` changes the reactor, runner retirement and main's
  `stopping` wait, which read them (D58).

<!-- src: SPEC Implementation Decisions (One active run per session), Further Notes on 32.13; CONT C1, Out of scope, Decisions (D, E, F, I/L, M); review 2026-10-28 (H10); REDESIGN-10 (OPEN-3 amended: coverage and run joining stay main's, D58); REDESIGN-11 (the first bullet deleted as a restatement of 5.2; ub R10 r3 removable) -->

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
  the host's labels and its retirements (L1), and addresses each send at issue (L2). Query-ended
  coverage is in 3.3.
- **`process_started` is reported each time a serving runner becomes live**, labelled with its
  hello's `runnerId:querySeq`, before any of its frames reach the ledger. `reattached` is false
  when it first serves: a spawned serving runner at its hello's live adoption (6.2), before the
  hello's send acknowledgements and replays; a candidate in the swap commit (6.9). It is true on
  every `recover()` adoption after a daemon restart (7.2). A candidate, a starting adoption and a
  query replacement report none; a replacement's frames advance the runner's latest `querySeq`
  (L1). A `run_dispatched` may name a spawned runner before its hello (6.9 `register`); L1 and L2
  decide that case. `process_lost` is appended by the write that first sets the runner's `retired_at` (6.5). OpenCode's reporter
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

- **Every way a runner is stopped** (`StopReason` `Explicit`, end-session, project removal,
  supersede or retire, idle exit, a confirmed exit, a refusal with `exiting` or `retiring`, an
  abandoned candidate) makes one call: `requestStop(target, reason)` (6.10).
- It commits one transaction. The transaction reads the target's row, its session and role,
  every hold on the runner (4.5), for `Superseded` the successor, and for any other Stop of a
  serving row every unretired candidate of the session. Its release evidence (4.5) is read before
  it, from owners outside the store: the runner's possibly-written set behind the closed write
  gate (4.4: each transmission this daemon called write for, and each hold an earlier daemon
  made, which adoption or Settle owns from the startup pass, 7.2), the runner connection's
  `idle-exit` and `command-accepted` order and its refusals (4.6), and for a confirmed-exited
  target Settle's journal read (7.3). It writes the retirement
  row with leader identity, reaper identity if any, the group snapshot, `retired_at` and the stop
  reason. The row lists no runs (6.5). Retirement clears `attachment_id` in the same statement.
  Attach requires `retired_at IS NULL`, so a reconnect never revives a retired runner. A
  non-Superseded Stop of a serving row also retires the candidates it read, in the same commit
  (6.9). No caller passes a candidate snapshot.
- `retired_at` is the clock of the attempt that committed, never of an earlier failed attempt.
- The record is written before any signal to the runner, on every path (Stop, retirement, survivor
  retries, restart recovery). A crash after the commit leaves a record restart recovery finds.
- **If the commit fails with a store fault, nothing durable changed:** no fence, no revoke, no
  signal, no shutdown command. The runner keeps running and serving.
- For every reason except `Superseded`, on any store fault, transient or not:
  - the intent stays `Committing`, and the reconciler re-runs the whole commit step after the
    4.8 backoff (capped at 30 s) until it lands, logging each failure;
  - waiters wait, and a second Stop joins;
  - `requestStop` does not fail on a store fault.
- `requestStop` registers the intent before it yields and returns `"Requested" | "Ignored"`. The
  reconciler's scope owns the commit worker; interrupting a caller ends only its wait. A
  `Superseded` caller's wait is uninterruptible, so the upgrade learns whether its promotion
  committed. Restart re-derives the Stop from durable control, candidate and dead-process facts,
  per S3's table. A healthy reattachment cannot recover an uncommitted direct Stop, as on main
  (Q26).
- Startup never waits on a Stop commit. `recover` registers the Stops it re-derives (abandoned
  candidates, dead processes) and returns. Recovery attachment forks the Stops it raises: an
  orphan, an incompatible hello, a disconnected runner (dead or surviving), or a failed
  attachment. Each fork waits for its stop, then releases that runner's waiters. Reattachment of
  live runners goes on while those commits retry.
- A rejected startup Stop fails only that runner's waiters and is logged; startup does not fail
  for it. A Stop still committing when shutdown interrupts it is not logged as failed.
- A restart's orphan (session gone, or already served) commits `EndSession`, which is not
  role-gated, so a serving orphan is stopped.
- A full stop and project removal (`stopRegisteredRunners`) await each runner's Stop. During a
  write outage they keep retrying with no deadline. Killing the daemon then leaves the runners
  alive (Q28).
- `Superseded` (the swap) fails with the existing "stop runner" error on any failure, a store
  fault included. The reconciler does not retry it; the upgrade's backoff retries the swap (6.9).
  A repeated swap passes only if the committed row carries the same `Superseded` reason and the
  successor is the serving, unretired row.
- `CandidateAbandoned` reads the row's role in its commit. If the row is already `serving`, the
  commit writes nothing and returns `Ignored`. A caller that gets `Ignored` never calls
  `awaitStop`.
- **If the commit fails with a decode rejection, an identity rejection (the row's session does not
  match the target), any failure of a `Superseded` Stop (a store fault included; the upgrade
  retries the swap), or a defect**, `requestStop` fails with "stop runner" and logs it. It never
  signals and never sends shutdown. The state returns to `Running` and the waiters fail. That is
  the whole fail set: for a Stop other than `Superseded`, every other store fault, transient or
  not (busy, locked, disk full, I/O, a constraint), stays `Committing`, and the reconciler
  retries it.
- `retired_at` is set-only and is the fence that outlives memory. A daemon starting up never
  re-adopts a retired runner as live; it hands the row to the reconciler.

```ts
type StopReason =
  | { _tag: "Explicit" } | { _tag: "EndSession" } | { _tag: "ProjectRemoved" } | { _tag: "Idle" }
  | { _tag: "Exited" } | { _tag: "CandidateAbandoned" } | { _tag: "Superseded"; successor: RunnerId };
type Identity = { tag: "Verified"; pid: number; startTime: string }
              | { tag: "Unverifiable"; pid?: number };
```

- The row is decoded with Schema at the store. A list read (`recover`, `owners`) rejects a bad
  row alone; the rest of the read stands. A Stop commit decodes the runner's row and also:
  - for a serving Stop other than `Superseded`, every unretired candidate row of the session,
    which it stops with it;
  - for `Superseded`, the successor's row.

  A decode rejection of any of these rows fails that Stop (F13).
- Membership and signals are separate facts on the row. The group snapshot answers "which processes
  are this runner's". The signal log answers "what was sent to whom, and was it delivered". A
  refused or failed signal adds to the log and never removes a member.

<!-- src: STOP-INTENT S1, S5; REAPER R3; RA §4; AUDIT-2 T3, A13; SWAP S7, K; CONT C3 (Refused, one commit for release and stop); SETTLE S3; 32.29.3 (c6d3a44f) -->

### 6.4 The stop state, the reconciler and waiters

```ts
type RunnerStop =
  | { _tag: "Running" }
  | { _tag: "Committing"; waiters: Deferred<"Requested" | "Ignored", StopFailed> } // no record; the commit worker holds target and reason
  | { _tag: "Requested"; record: RunnerRetirement }             // row committed, nothing sent yet
  | { _tag: "Escalating"; record: RunnerRetirement }            // shutdown sent and/or signals in the log
  | { _tag: "Escalated"; record: RunnerRetirement }             // TERM, 3 s, KILL, 1 s window is over
  | { _tag: "Gone"; record: RunnerRetirement }                  // every snapshotted member gone
  | { _tag: "Settled"; record: RunnerRetirement };              // runs settled, evicted, pruned (6.8)
decideRunnerStop(state, observation) -> { state, actions }
// actions: SendShutdown | Signal | Settle | Evict | Prune | Notice
```

- The reconciler module (`runner-retirement.ts`) owns this state. Callers read it; only the
  reconciler changes it. `entry.retirement` is a read of it.
- `Committing` is the only state that is not durable. A second Stop joins it instead of committing
  again. It does not guard dispatch; the database does (4.3). It guards writes: every state but
  `Running` closes the runner's write gate (4.4). For a Stop other than `Superseded`, it stays
  `Committing` on any store fault and the reconciler retries the commit (6.3). A decode
  rejection, an identity rejection (session mismatch), any failure of a `Superseded` Stop (a store
  fault included), or a defect returns it to `Running` and fails its waiters.
- The commit worker starts when the intent is registered and runs in the reconciler's scope. It
  is not a `decideRunnerStop` action, and the durable-row tick never treats `Committing` as
  `Requested`. Only the row the committing transaction returns moves the state on (to `Requested`
  for a new commit), and that same transaction's session rows replace the session's routing
  cache. `Ignored` resolves to `Running` with no Stop wait, and each joiner but a refusal (below)
  then rechecks its own reason.
- A refusal with `exiting` or `retiring` registers no stop form of its own. It joins the runner's
  `Committing` intent, or calls `requestStop` (`Idle` for `exiting`, `Exited` for `retiring`) when
  the runner is `Running`. Once that stop leaves `Committing`, committed or returned to `Running`,
  its write fiber commits the release (4.5); a refusal read after it left commits at once, stale
  if that commit carried it, else a later release (F40). The refusal never rechecks or raises a
  second stop, and the runner's confirmed exit stops it (6.3). The host writes `idle-exit` before
  any `exiting` refusal on a connection, so an `exiting` refusal finds the `Idle` intent or its
  commit; a `retiring` refusal is the daemon's first word of a self-retire (4.6).
- `Requested` to `Settled` map onto the row: its tag plus its signal log. Memory is a cache of the
  row and is rebuilt from it at startup.
- `decideRunnerKill` is the signal part of `decideRunnerStop`.
- **The reconciler is the only code that** sends shutdown, signals, evicts a stopped runner or
  prunes its row, and settles its runs, as main at every ticket (6.5, D58); from each runner-held
  provider's ledger ticket (Claude 32.6, Cursor 32.10, Codex 32.21) that provider's Runs end by the
  `process_lost` of the write that first sets the runner's `retired_at` (6.5). Stop's live path, the survivor watcher and restart recovery are one loop
  over the same rows.
- **Evict** only removes the runner's entry from the manager's map. The entry's scope has already
  closed in the stop commit's post-commit step (6.11).
- Each action is idempotent and keyed by the row. A failed write after the commit (signal log, Gone,
  settlement, prune) leaves the row where it was; the reconciler retries on its cadence and logs.
  It never fails a waiter and never rolls back the fence.
- Settle's settlement goes through Send Settlement (4.7), main's at every ticket. The
  reconciler is not a new writer of a send's outcome. Its Settle reads the journal first (4.5,
  7.3); in the ledger chain its answers are late evidence for an already Ended run (7.3).
- **Waiters.** Callers wait on the state: `awaitStop(runnerId, "Escalated")` for end-session and
  shutdown (the escalation window is over, not that every member is gone); `"Settled"` where a caller
  needs the runs settled. Once the row is committed no waiter sees a failure. Two racing Stops
  share one commit.
- `holdRun` names the stopping predecessor and its window end in `Unserved{predecessor}`; the
  feeder parks until the window ends, then starts a serving runner. The park reads the
  predecessor's Stop state once, when it starts. If that Stop is in progress (`Committing`,
  `Requested` or `Escalating`), the park also ends when `awaitStop(predecessor, "Escalated")`
  returns; since `Escalated` needs the full 4 s, only an early `Gone` can beat the window. A
  rejected Stop commit ends only that wait, and the window still ends the park. Any other state
  at park start (`Running`, not loaded; `Escalated`, a legacy row; `Gone` or `Settled`, the
  durable row not yet caught up) is parked on by the window alone. "No poll" (F82) means the
  feeder runs no retry loop and reads no store while parked; `awaitStop`'s re-reads of the
  reconciler's in-memory state on `runnerRetrySchedule` are the reconciler's own wait, bounded
  by the same window. The park also ends early, and the feeder steps, when the head's run ends or
  a Stop commit covers it (4.4). No other code scans the stop states for a predecessor.
- A refusal's `requestStop` names the refusing runner, and its transaction reads that runner's
  row as every Stop does (6.3). The in-memory registry is a routing cache and is never read for
  who serves.
- **One process watcher.** `RunnerAuthority` owns the only process watcher, over Exiting and Retired
  records; it is the reconciler's cadence. When a process is confirmed gone (exited, pid reused,
  zombie) it emits `runnerGone(runnerId)` once. 32.4 keeps only failed liveness checks, which are
  ledger deadlines.
- **Deleted:** `entry.stopRetryable`, the `nextStopped` swap, `stop()`'s inline cleanup race,
  `killEntry`'s re-read, the recovery and `stopRegisteredRunners` copies of the kill sequence, the
  `settleExitedRuns` await on `entry.stopped`, `evict`'s own revoke cohort, and the authority's
  `ownedRunIds` as a source of what to settle.

<!-- src: STOP-INTENT S2, S3, S4, What is deleted; AUDIT A3; CONT C2 (feeder keeps the ordering against a stopping predecessor), C3 (Settle reads the journal); review 2026-10-28 (H4, H11); SETTLE S1, S2, S3, S5; 32.29.3 (c6d3a44f) -->

### 6.5 Which runner holds a run

- The hold (4.1) is the only durable answer to "which runner holds this run". Nothing copies it.
- The holder write fails if the runner has a retired row, so it and the Stop commit exclude each
  other (4.3).
- At `Gone`, the reconciler settles every non-terminal run held by that runner, read in the
  settlement transaction, as main at every ticket (D58). There is no cohort snapshot to drift.
- A run that moves to another runner gets its new holder only through a release and a new
  `run.dispatched` (4.3, 4.5). A run with no holder was never dispatched and is not the
  reconciler's.
- **Old rows.** Rows written by main or by an earlier phase carry `owned_run_ids`, and runs
  dispatched before the hold existed have no holder. For those rows only, the reconciler settles the
  union of `owned_run_ids` and the holder query, and runs with a commandless `run.dispatched` keep
  legacy recovery (4.1). New rows never write `owned_run_ids`. The fallback is deleted at 32.13.
- **`process_lost` is recorded with `retired_at` (decided OPEN-4, 2026-10-28).** Each transaction
  that first sets a runner's `retired_at` also appends `process_lost{runnerId, retiredAt}` (3.13, 2.1
  row 215), which retires that runner (L1, 3.3), beside main's retirement settlement of its held
  runs, per-send Send Settlement at Gone, and `settleRuns` for legacy or sendless owners
  (`settleRuns`, runner-retirement.ts 932-943 at 6c9ff950), so it cannot be lost between
  retirement and `Gone`.
  - Three writes first set `retired_at`: `requestStop`'s raw write (`flushPendingWrites`,
    runner-receipts.ts 612-628 at 6c9ff950), `persistRelease`'s stop inside the release commit
    (`commitStop`, runner-retirement.ts 1333-1338 at 6c9ff950), and the reconciler kill's upsert
    (`commitRetirement`, runner-receipts.ts 640-650; runner-retirement.ts 1009, 2195, 2207 at
    6c9ff950). Each appends one `process_lost` per (runnerId, retiredAt) in its own transaction,
    and none for a runner whose session row is gone or has no project. One reader in
    runner-receipts.ts, which owns `claude_runner_cursors`, computes the rows for all three
    (32.4). The release commit's `run.released` events precede it in that transaction, so they
    are read first (4.5).
  - Inside a `commitAndSignal` write (the release commit) it is projected with that write, like
    any event in its batch. A raw write appends it unprojected and marks the store; the next
    `commitAndSignal` recovers before it projects, under the commit permit both share
    (`isRecovered`, commit-and-signal.ts 393-396 at 6c9ff950), so no later batch moves a projector
    cursor past it. Startup recovery folds one a crash left. The mark is main-side plumbing the
    arm never reads. Retirement needs no projection (runner-retirement-fence.test.ts 6260).
  - The process may still be running after that commit. It is fenced (6.2), so it accepts no new
    work; evidence it still sends is recorded and folds by 3.8, and never reopens a run.
  - Process cleanup (kill, reaper, discovery files) still waits for `Gone` and runs in the
    background (6.6, 7.1). Settlement does not wait for it.
  - Rejected: recording `process_lost` when the process is confirmed gone (`runnerGone`), which
    matches the as-built reconciler but leaves a retired runner's runs open until the kill
    completes.

<!-- src: STOP-INTENT S5; CONT Data shape, C2, C3; AUDIT A1 (with the ledger), A3; SWAP failure mode 17; review 2026-10-28 (H4, H5); contract r15 (32.2.15); REDESIGN-10 r1 (the per-provider switch deleted: main's retirement settlement and Send Settlement stay at every ticket, the arm folds `process_lost`; ub r1 P2-6, poteto r1 P2-14); REDESIGN-11 (D59: one observer of a runner's loss; ub R10 r3 P3 E); D59 spike gate pass 2 (each write that first sets `retired_at` appends it, projected in its commit or marked for the next commit's recovery) -->

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
- **H2. A kill is final.** Its path is main's retirement: `requestStop` (6.3) commits the
  retirement record before any signal.
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
- **Restart:** a serving row is adopted (`upgrade-activate` first if the host is still Candidate);
  a candidate row is stopped as
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
requestStop(target: StopTarget, reason: StopReason): Effect<"Requested" | "Ignored", StopFailed> // StopFailed only for a decode rejection, an identity rejection (session mismatch), any failure of a Superseded Stop, or a defect
holdRun(session, run, commandId): Effect<Hold, StoreFault>
release(run, runner, commandId, transmission, reason): Effect<void, StoreFault>
serving(session): RunnerId | undefined // a cache for routing a live caller; no write decision reads it
state(runner): RunnerStop
awaitStop(runner, "Escalated" | "Settled"): Effect<void>
recover(): Effect<Recovered>
```

- `StopFailed` is `runnerFailure("stop runner")`. A lost registration race and every hold answer
  are values. A Stop other than `Superseded` never fails on a store fault; it retries until the
  commit lands. A `Superseded` Stop fails on any fault, and the upgrade retries the swap. When
  the runner's row exists, the record keeps the row's identity. The target adds the members it
  observed and a reaper the row does not yet hold (the hello reports it after `register`).
- `StopTarget` is the runner, session, driver kind, identity, reaper and members. It carries no
  `retired_at`, stop progress or signal log, so an uncommitted intent does not type-check as a
  retirement record.
- "Ending a session" is a request stop. The word "release" here means only 4.5's event.

<!-- src: SWAP K; CONT C2, C3, Deleted or changed (lifecycle module); SETTLE Data shape 1, S1, S3, S4, S5; 32.29.3 (c6d3a44f) -->

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
- **Durable teardown has one owner.** At every ticket main's retirement settlement ends a retired
  runner's runs at `Gone` (6.5); the write that first sets its `retired_at` appends `process_lost` (6.5),
  which the arm folds. `session-ended` is part of that settlement, not a runner write.
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
  reading the previous connection to end of file. A `finished` answer with an actual terminal
  result or failure also settles through Send Settlement, main's (4.7, 4.9); missing and
  intake-only results do not settle. An `uncertain` transmission stays held and only
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
  release `JournalAbsent`; the feeder holds the send again. When the process is confirmed exited
  before its stop commits, that commit carries these releases (4.5).
- `Present`: settle from the journal answer (4.9).
- `Unreadable`, or a runner from an older build: `delivery_indeterminate`, never re-sent. Settle is
  the only writer of this marker for runner-held rows.
- Today, and for each runner-held provider until its ledger ticket: every non-terminal run the
  runner held is settled at `Gone` (6.5).
- From that provider's ledger ticket (Claude 32.6, Cursor 32.10, Codex 32.21), Settle settles no
  run. A Run whose start the stop commit released `JournalAbsent` has unlaunched (4.5, 3.6); any
  other is already Ended by the `process_lost` of the write that first set `retired_at` (6.5), and a later `Absent`
  (`JournalAbsent`) returns the pending input to the inbox behind the pause (D53). `Present` answers
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
  process facts (labels, 6.1), servers (8.7), `anythingMayAct`, lost work, pending confirms and
  native commands.
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
| { kind: "turn_ended" } // a Claude wake's end (2.1 row 215)
| { kind: "command_lifecycle"; commandId: string; state: "queued" | "started" | "completed" | "cancelled" }
| { kind: "command_result"; commandId: string }
// Server evidence (8.7): daemon observations naming the session, never a label
| { kind: "server_seen"; server: ServerKey; command: string; cwd: string; taskKey?: TaskKey;
    source: "detected" | "declared"; role?: "serving" | "awaited" }
| { kind: "server_gone"; server: ServerKey }
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
type ServerKey = { pid: number; startedAt: number; port: number };
type Server = { key: ServerKey; command: string; cwd: string; taskKey?: TaskKey;
                source: "detected" | "declared"; role: "serving" | "awaited" };
type Servers = ReadonlyMap<number, Server>; // by port, per session; survives labels, queries and restarts
type Tasks = { tag: "Unknown"; label: Label }
           | { tag: "Known"; label: Label; tasks: ReadonlyMap<TaskKey, Task> };
type NativeCommand = Sent | Queued | Started | Unconfirmed | Completed | Cancelled | Failed;
```

- Task kind comes from `task_type`: `local_bash` is shell, `local_agent` is subagent,
  `local_workflow` is workflow, `monitor`, `mcp_task`; others verbatim. A task is **monitoring** if it
  is ambient or a monitor; **serving** if a live server is linked to it and no declared `awaited`
  covers it; otherwise **work**.
- `server_seen` adds or refreshes one entry per session and port. A declared entry keeps its source
  and role against later detection of the same ServerKey; a new ServerKey on the port starts
  detected. `server_gone` deletes the entry only when its full ServerKey matches, else it is a
  no-op; nothing else removes one.
- A runner event either answers a Send Token or is an unsolicited observation naming only the host
  label: background snapshots and task events, a turn start, process events, a native command's
  receipts (3.4, D61), and `activity`, `result`, `query_ended` for a wake execution (8.3). No
  fictitious send is minted.
- Codex's snapshot is `thread/backgroundTerminals/list`, re-read on turn completion, terminal command
  start or finish, after a stop, and on reconnect. Late command events only update the snapshot
  (terminated is failed, exit -1).
- Native commands are opaque. A zero-turn result correlated by input UUID (`user_message_uuid(s)`)
  completes the command and never starts or ends a Run. Only the waiting variants of
  `NativeCommand` carry a deadline. A late reply moves `Unconfirmed` to `Completed`.
- Native `run_id` order is unproven: use arrival order, or cite evidence that it sorts by time.
- Server evidence, `ServerKey`, `Server`, `Servers` and `LedgerView.servers` land with 82tn.32.33,
  first in 32.33.1 (12.2); 3.13's model has none of them until then.

<!-- src: BG Decision 2; AUDIT A11; AUDIT-2 T5, T6, T7, Other changes (run_id); RA §7 (label replaces generation); model-gaps 2026-10-28 -->

### 8.3 Task certainty and wake Runs

- A fresh launch has no tasks (`Known`, empty). A reattach is `Unknown` until the catch-up snapshot,
  and stays `Unknown` for a CLI declared not to send snapshots. A provider that reports no
  background tasks (OpenCode, Cursor, 8.1) is `Known`, empty, for every label, reattach included.
  An empty `Known` derives no tasks. Cursor starts no unsolicited turn (cursor-runner-payload.ts
  262-264, 314 at 1ba91324).
- The runner host keeps the latest snapshot even when empty, with its label, and replays it after
  the backlog on every attach.
- The host's idle check uses the same reducer, and resets to `Unknown` when the query is replaced.
  Host idle is `Open{commands} | Draining{tokens} | Exiting`; sets keyed by command or token replace
  the turns counter, and the host's task and idle caches are invalidated on query replacement.
- Snapshots replace the set, and so does a `process_started` settlement; an effect's outcome (an
  `end_session` success) never does. Per-task events only name lost work, show outcomes and identify the
  waking task. A task is gone only when a later snapshot omits it.
- Older-label evidence follows L1.4 (3.4): recorded only where it changes a join, never authority,
  liveness or a wake Run.
- **Wake executions (D47).** An unsolicited `turn_started` names no send, so the execution it
  starts for its label is a **wake execution**, outstanding work in its own right that no send's
  chains can end. It is outstanding until the first of these, which clears it even without
  authority and changes Run state only with authority (3.4): its label's `query_ended`; for
  Claude, Codex and Cursor its `result` (3.4), Claude's naming no send's input uuid (D25), where
  main returns to idle while the query lives on and clears the stream's background tasks when it
  ends (claude-runner-payload.ts 2235-2245, 2257-2294, 2413-2414, 2755-2775 at 1ba91324), and
  Codex's held back across a goal chain (9); for Claude its `turn_ended` (2.1 row 215), its own
  end (3.5) and no Run-end evidence, which follows that result or comes alone at its stream's end
  or at Stop's dispose with no foreground run (L6); for OpenCode a covering idle probe (D26); or
  coverage, its runner's retirement (L1) or its session's end (3.4); or the ledger stop
  deadline's alarm (L6). This is its one end rule
  (section 9). While outstanding it holds `anythingMayAct` and is its label's work (L6), so a
  start waits for it as behind a user Run's retained start (D18). Unsolicited `activity`,
  `result` and `query_ended` apply to the wake execution of the observation's label; with none
  they are recorded with a diagnostic and no change. No fictitious token is minted.
- **Stop and wake labels:** 3.7 L6.
- **Wake Runs.** A wake execution with no active Run records a wake Run as Launched, with no start
  effect; its waking task is the one notified just before. One under another label while that wake
  Run is active adds an execution to it. A wake Run reads its executions' activity while it is
  active: it ends when its latest label's wake execution ends (above), by the fold, so `completed`
  at a clean result (3.8 condition 1), `interrupted` at a Claude `turn_ended` after a Stop with no
  result (3.8 reason 2.1), when its runner retires or its session ends (3.8 reason 2.3), or by the
  ledger stop deadline's alarm (L6); any other execution still outstanding then stays
  its label's work (L6). With an active Launched or Interrupting user Run a wake execution is
  never that Run's: it is never delivery (3.6) or work that Run's end waits for (3.8) and never
  moves it, so it changes no unlaunch (LI2). Admission: 3.9.
- **`anythingMayAct`** is true for a non-ended Run, a send that may still act (a probe only reads,
  so it never may act, D31), or tasks live or
  unknown, or a server live (8.7). Tasks and servers never block a new Run. Every liveness reader
  asks it: the worktree cleanup sweep,
  archive and delete `hasLiveWork`, the status poller's idle corrections, and the runner record
  deletion. The physical-process file guard stays.

<!-- src: BG Decision 3; AUDIT A9; AUDIT-2 T6, T11, A20, Other changes (wake admission); OW Decision 3; model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L1; REDESIGN review r2-1; REDESIGN oracle r8; REDESIGN-5 (wake executions own their deadline and cleanup; a user Run reads one only as activity; ub r3 P1-2, P1-3, P2-4, poteto r3 P2-4); REDESIGN-5 r1 (E2: one deadline, end rule and stop sequence per label; the Claude wake ends at a result naming no input uuid, where main returns to idle, claude-runner-payload.ts 2257-2294, 2413-2414 at 1ba91324; Stop interrupts every outstanding wake label; ub r1 P1-4, P2-1, P2-3, poteto r1 P2-A, P2-C); REDESIGN-5 r2 (a wake its reader or its wake Run leaves is the session's, with one deadline before and after Stop; the Claude wake also ends at `query_ended`; ub r2 F-A, F-B, poteto r2 F1, F2); REDESIGN-6 (a wake ends at its label's `query_ended` for every provider, its result or coverage; E2 becomes its label's L6; ub r3 N1, P3-2, poteto r3 P2-1); REDESIGN-6 r1 (wake end at exhaustion; the Stop bullet a pointer; ub r1 removable 1); REDESIGN-6 r2 (a wake's activity extends no clock; ub r2 P2-1); REDESIGN-7 (a wake execution is label work a Stop adds to the stop; its end at an OpenCode stop's deadline step, not exhaustion); REDESIGN-7 r1 (the Stop bullet a pointer; admission steers only into a Launched user Run; ub r1 P3-3); REDESIGN-7 r2 (admission a pointer; ub r2 P3-1); REDESIGN-11 (D59: a wake execution ends at the stop's ledger alarm for every provider, not only OpenCode's step; ub R10 r3 F-B, poteto r3 F1) -->

### 8.4 Stop tasks, the confirm gate and lost work

- **Tasks are read per runner.** `LedgerView.tasks`, `anythingMayAct`'s task term and
  `stop_tasks` `"all"` read the snapshot under the current process's latest label; with no current
  process there are none. A newer `querySeq` has no snapshot until its first one, so its tasks are
  unknown for a provider that reports tasks: the host drops its task cache on query replacement
  (8.3). `"all"` means its live tasks. It is rejected, issuing nothing, when tasks are unknown or
  none, or when the provider has none. `stop_task` runs through the SDK's
  `stopTask(taskId)` or Codex `thread/backgroundTerminals/terminate(processId)`. A failed stop is a
  diagnostic, with no retries. A `stop_task` is never probed: its work is its task (3.5), so it
  may still act only while that task is live or unknown, which the task term already counts. With
  transport Issued, Unknown or Sent it stays live that long (the 3.5 table).
- **Confirm gate (L3).** A destructive step (an ignored interrupt, restart, retirement, end-session, an
  ignored interrupt while paused) with tasks live or unknown waits with a pending confirm. The
  stop's deadline step never destroys on its own. A confirm must match the latest snapshot; a stale
  confirm is rejected. With no snapshot the UI says "background state unknown" and always asks.
  The gate stores its step, never its addresses, tasks or `snapshotEntry`: `end_session`, or
  `retire` for the rest, a restart being a retire, then main's relaunch (3.13). It reads the same tasks as above: by H1 a step's
  address now is the current process, pending or a runner not started (no tasks), or retired. A
  confirm releases it, and so does any decision after which those tasks are neither live nor
  unknown: a snapshot, a `process_started`, or the current process retiring. The step is addressed by L2 when it issues,
  so every release issues the same effects: released by the current process retiring, a Run-less
  `end_session` goes to pending (L2 case 3, D32). Everything the step decides happens when it
  issues, not when it is gated; its Run's end follows by 3.8 (5.1). A step that belongs to a Run
  is dropped when that Run Ends by other evidence, and the stop's deadline step when the stop
  ends (L6, D43): what ends drops what it owns; `end` then continues to its
  `end_session` step. A step whose every address is retired issues nothing:
  its sends were covered at retirement. A step that destroys several member labels waits on one
  confirm. `PendingConfirm`'s labels,
  tasks and `snapshotEntry` are views of now.
- `snapshotEntry` is the 1-based count of changes to what the task view reads (D45): `tasks_snapshot`
  evidence, `process_started` settlements, and the decision that raises the current process's
  latest `querySeq` (a query replacement, after which tasks are unknown), excluding older labels.
  Any of them that leaves a pending confirm open refreshes `snapshotEntry` only (D3), so a
  confirm copied before it is stale. Callers copy it from `pendingConfirm`, never compute it.
- With an active Run, `end` stops the Run (5.1), through a Stop commit (L6), then issues
  `end_session` once the Run is Ended or U2's deadline step has retired its owner runs (L6); with
  no Run, it issues `end_session{runId: null}` at once, which adds nothing to the ledger stop
  deadline (L6, D4). Both steps are confirm-gated with tasks live or unknown. Each step is main's
  own commit and outbox row, folded as its own Control under the `command_id` main gave that row
  (3.4): the Stop commit as a `stop` Control, or an `end` Control with its `deadlineAt` where main
  commits the Stop as an `end_session` (orchestration-engine.ts 884-898 at 6c9ff950); a later
  `end_session` as an `end` Control, `deadlineAt` null, under its own `command_id`
  (session-manager-service.ts 498-509, stop-settled-agents.ts 39-44, reload.ts 52-61; U2's retire,
  its Stop's `commandId` with `:retire` appended, provider-turn-service.ts 262-271 at 6c9ff950),
  opaque to the ledger, which derives no id from another.
  The `end_session` is main's control, run whole: the ledger neither holds nor escalates it, and U2's
  retire `end_session` goes to the stop row's process id, as main (L6), or pending when it went to
  pending (D32).
- **Lost work (L5).** Each label is decided once, in the decision that first ends its scope: the
  label becoming older (a
  newer `querySeq` of its runner, or its runner's retirement, L1 item 4; D44), or `session_ended`
  (for the current process's latest label). That
  decision records the live tasks of the label's latest snapshot; "may have been lost" when the
  label has no snapshot or its tasks are unknown; and nothing when they are `Known` with none live
  (a fresh launch, and every Cursor and OpenCode label, 8.3). A destruction addressed to pending
  records nothing. An `end_session` success and a rejected resume end no label's scope: the
  first exits its runner, whose retirement does (4.6), and the second ran no query. A scope's end
  decides lost work only; a label's work ends by L6.
- A process that dies before confirming a native command: the tracker reloads from the transcript and
  re-sends first on the next launch, only if the confirmed status does not already match.

<!-- src: BG Decision 2, Decision 3, Decision 4; AUDIT Already covered (32.8 defers to 32.25); AUDIT A4 (recovery); model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L2, L3, L5; REDESIGN review r1-1 (03-rewrite-gap-decisions.md); REDESIGN review r1-2; REDESIGN review r2-1; REDESIGN review r2-2 (L5 Known empty); REDESIGN review r3-1 (runner not started); REDESIGN oracle r8 (D43); REDESIGN harness r9 (D44); REDESIGN harness r12; REDESIGN-5 r1 (E1: a wake execution's gated step is dropped when it stops being outstanding; ub r1 P2-4, poteto r1 P1-3); REDESIGN-5 r2 (no Tombstone cleanup of a wake; ub r2 F-B); REDESIGN-6 (a gated step drops with its label's work; a scope's end decides lost work only; ub r3 N1); REDESIGN-6 r1 (`end` stops the Run; ub r1 P3-1, poteto r1 P3-1); REDESIGN-7 (an `end_session` joins or opens the stop, whose deadline step escalates it, so a Run-less end escalates as D4 says; the `close` scope end deleted; a gated step drops with the stop's work; poteto r3 P2-1); REDESIGN-7 r1 (an `end_session` joins the stop before its step, else opens a new one; ub r1 P1-1 trace C); REDESIGN-7 r2 (the step decides at issue and its Run ends by 3.8; the stop's step drops only when the stop ends; the escalation a pointer to L6; ub r2 P2-A, poteto r2 P2-1, removable 8.4); REDESIGN-11 (D59: the `end_session` is main's control, never a ledger item or escalation, as main's U2 escalates only its owners) -->

### 8.5 Native command issue

- **A native command is a session send (L4).** L2 case 3 addresses it: to the current process, or
  to pending when there is none. The ledger never waits for `process_started`; the feeder spawns
  for it (H3, 4.4). Main issues it (D60), named by main's `(commandId, n)` (3.4); it enters
  `live` and `nativeCommands` in the decision
  that folds its `native_command` control, after already-issued sends and ahead of queued inputs,
  so issue order alone puts it first and its confirmation never holds back a start.
- **Its view is a projection of its send:** `Sent` while unfinished; `Queued`, `Started`,
  `Completed` or `Cancelled` from receipts; `Unconfirmed` when its deadline fires; `Failed` with
  the covering cause (`process_lost` or `session_ended`) when covered; `Failed`
  with the outcome's code on a permanent `effect_outcome`, a refusal included (H4), which also
  finishes the send (3.4). The deadline starts at issue and drives only the view.
- The provider may report it queued ("queued by Claude"). The deadline does not run while the
  provider reports it queued, and resumes with the time it had left; a try in a project not
  served shows nothing, so the deadline runs through it (3.4, H4). When it
  fires, the tracker re-reads native state (Claude's transcript, Codex's `thread/goal/get`), with
  no authority needed, and shows "Clear not confirmed" or "Pause not confirmed" with Retry. The
  tracker runs no timer.

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

### 8.7 Servers

- **Detection.** One PortWatcher per daemon scans listening TCP ports owned by the user every 2s
  (`lsof` on macOS, `/proc` on Linux). It reads the session marker from the process environment:
  `CONDUIT_SESSION_ID` (Claude), `CODEX_THREAD_ID` (Codex), `CONDUIT_OPENCODE_SESSION_ID` (OpenCode,
  stamped by conduit's `shell.env` hook). The innermost runner's marker wins; unmarked ports are
  ignored. `CODEX_THREAD_ID` and the OpenCode marker are native ids: each resolves through its
  provider's own lookup to a conduit session. A marker this daemon cannot resolve is ignored, never
  read as deleted. One entry per port: one process's listeners (IPv4 and IPv6) are one server; when
  different processes share a port the earliest started is the server. A port held 10s records
  `server_seen`. The scan is compared against the ledger's Servers,
  not a copy: an entry missing from a successful scan records `server_gone`. A failed scan records
  nothing. After a restart the first successful scan does the same comparison. Until that scan and
  one hold have passed, a session's servers are unknown, not absent: auto-settle waits.
- **Task link.** Claude: the server's stdout is `tasks/<task_id>.output`. Codex: one unique match of
  command and cwd in `thread/backgroundTerminals/list`. Otherwise, and always for OpenCode, the
  server is session-level and no task changes class. Cursor's SDK kills servers at turn end; it is
  out of scope.
- **Declared.** `conduit server mark <port> --serving|--awaited` (CLI socket; Codex falls back to
  conduit's MCP tool) records `server_seen{source: "declared"}`. It is rejected, recording nothing,
  when nothing listens on the port or the port belongs to another session. The caller's session is
  its own marker, resolved as a scan resolves it; a mark skips the hold.
- **Views.** `SessionActivity` reads a serving server or task as background (calm) and an
  `awaited` one as working. A live server pauses auto-settle. Servers are never lost work and never
  confirm-gated on their own; a linked task gates as a task (8.4).
- **Ended sessions have no servers.** Each scan kills the marked listeners of sessions this daemon
  knows as settled, archived or deleted (a deleted session keeps its `session.deleted` event),
  skipping the hold. Settle, Archive and Delete name the count; unsettling starts
  nothing. `server_gone` for a deleted session is dropped.
- **Stop.** One kill routine serves Stop and ended sessions: the process group only when its leader
  is not conduit, a runner host, an agent CLI or a shell; otherwise the server's process tree.
  SIGTERM, then SIGKILL after 5s. Stop names the full ServerKey, and before each signal the routine
  re-checks the pid's start time, sending nothing on a mismatch. Stop intent is not persisted; a
  server that survives a daemon crash mid-Stop stays listed. The entry goes only by the next scan's
  `server_gone`.
- **Preview Gate.** It owns conduit's `tailscale serve` ports and login-checking proxies and removes
  only its own. It reconciles them to Servers, refuses a port with no entry, and answers a dead
  target with a "Server stopped" page. Each new upstream connection checks that the port's listener
  still matches the entry's ServerKey, and fails closed to that page if not. Without Tailscale or consent, Open shows the port and Copy
  link. A chat link to `localhost:<port>` renders as a chip while that server is live, plain text
  otherwise.

<!-- src: SERVERS brainstorm 2026-10-29 (tsp server-badge, Sections 1-6); t3code a27ec88bfa PortScanner.ts, ThreadServersPanel.tsx:97; spec review 2026-10-29 (conduit-test-82tn.32.33.11) -->

## 9. Providers

| Provider | Path | Run end | Background tasks | Goals | Stop |
|---|---|---|---|---|---|
| Claude | runner host (Claude Agent SDK) | result naming the send's input uuid | yes | `/goal` text, no pause | 5.1, retirement at the stop's deadline step (L6) |
| Codex | runner host (Codex app server inside it) | result | yes (`backgroundTerminals`) | `thread/goal/*`, pause | 5.1; interrupt leaves the goal active |
| Cursor | runner host (`makeRunnerProviderInstance`, Cursor driver; ledger rows 32.10) | result | none | none | 5.1, retirement at the stop's deadline step (L6) |
| OpenCode | SDK/API client, direct (4.10) | `query_ended` | none | none | cancel, native abort, fence until a probe confirms idle or the stop's deadline step (L6) |

- **Effect interpreter.** Main's reactor (orchestration-side-effect-reactor.ts at 1ba91324, D58):
  it claims an outbox row (`markRunning`), calls the provider adapter, and appends the outcome as
  main's events in its own body, where the arm folds it; the three ledger effects' executors, wake
  and lane exemption are 32.3's (3.12, 2.1 rows 215, 216). It contains no lifecycle decisions. Outcomes: retryable (backoff), permanent
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
  instance, or when a daemon restart reattaches it; `process_lost` when conduit stops that process,
  in `onInstanceStopped`'s settlement batch (`managedStopped`, sse-wiring.ts 887-891 at 6c9ff950;
  2.1 row 215). A replacement, a URL change or its supervisor reporting it gone, which main settles
  nowhere, retires it at the next id's `process_started` (L1), and its Runs stay open in main, as
  main (2.1); until then its work ends as below. A failed health
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
  - `interrupt_turn` carries the covered runs only, with no label and no turn (4.6).
  - Events that answer no send are unsolicited and name only the host label (3.4). `querySeq` rides
    the same bump (32.19). Runners from older builds are refused new work and their turns settled
    (82tn.31 pattern); their attempt-keyed journal answers read as `Unreadable`, never `Absent`.
  - Rejected: interrupts naming tokens (the Stop must list every live transmission of a covered run,
    and one missed token lets a late frame start a turn after Stop); the as-built outbox attempt with
    highest-attempt acks (two counts of one transmission, OPEN-2); input-id targeting (reusable ids);
    one ordered socket writer instead of a host record (a timing guarantee spread across daemon
    fibers); a Stop epoch (A.8 D).
- **Decided (82tn.32.2.14, 2026-10-28; amended round 16 r2): native-session fence membership and
  idle proof.** Members are sends, never admissions. A member leaves the fence by NotConsumed, its
  coverage (L1, L2, 3.3), or its own work ended (3.5), read from the work-ended column below. A
  wake execution is a member from `turn_started`, as a delivered start send of its execution would
  be, and leaves at its one end rule (8.3). Label work and the stop that bounds it are L6's
  (3.7). Interactions, answers and background tasks are never
  members (8.3).

  | Provider | Members | Work ended | Idle proof |
  |---|---|---|---|
  | Claude | start, steer | a result naming the send's input uuid, or naming none when 3.4 gives it to that send; `command_lifecycle` cancelled before started (NotConsumed{cancelled}, Stop's own, 4.8); journal `absent` with no acceptance | none |
  | Codex (32.2.13) | start, steer | the runner's result, held back across a goal chain until the goal ends or the successor deadline expires | none; `thread/status` idle is not proof |
  | Cursor | start, steer | the native `wait()` result | none |
  | OpenCode | start, steer, `cancel_request`, abort | `query_ended`, then a covering probe (a trusted covering idle probe alone is work ended, 3.5; D26) | `probe native_session` returning `native_idle`; omission from `session.statuses` counts only after `session.get` confirms the identity; `retry` is busy |

  - A Claude, Codex or Cursor interrupt is no member: its work ends when every Run it names has
    ended, as main ends them (D59), and at once when it names none.
  - Claude's `command_lifecycle` for a held start or steer is an Answer naming that
    transmission's token. `cancelled` before any `started` is NotConsumed{cancelled} for that
    transmission, Stop's own: never retried, its input placed by D53 (3.5, 4.8, 3.9); after `started` it is Observed and ends nothing. Its `commandId` must equal
    the hold's. A `command_lifecycle` or `command_result` answer whose `commandId` differs from
    the hold's is Rejected, a diagnostic, no state change (3.4), whether or not the send is
    covered (D21). A native command's receipts answer no token: they are unsolicited, named by
    its `commandId` (3.4, D61).

  - An OpenCode idle probe covers only sends issued before it whose delivery the native
    user-message echo or a native result naming the send confirmed. Abort is session-wide, so
    an abort whose delivery is unknown stays a member until a probe issued after it returns
    `native_idle`, or the stop's deadline step ends it (L6), as main ends its Stop's owner runs
    `stop_unconfirmed` and lifts at the Stop deadline (provider-turn-service.ts 286-313 at
    1ba91324).
  - A Claude result ends only the inputs it names. An input still queued after it, or listed in an
    interrupt's `still_queued`, stays a member. `query_ended` ends no Claude send's work, only a
    wake execution's (8.3): a query that ends with an unstopped turn in flight first reports an
    error `result` naming no input (3.4), as main and R2 end the current run at stream end
    (claude-runner-payload.ts 2169-2174 at 1ba91324, 2121-2126 at 6c9ff950). Journal `finished`
    is consumption proof only (4.11).
  - A Cursor result releases the fence because `wait()` is the only native terminal and settles
    every pending steer. The runner's interrupt-timeout abandonment is not a result: intake records
    it as the Run's outcome (interrupted, not forced: only the ledger stop deadline's alarm forces,
    3.8), and the fence waits for runner retirement to
    cover the label. The runner marks that terminal as abandoned on the wire.
  - Codex's runner withholds its result while a goal successor may start, so a native idle between
    goal turns never reaches the ledger. A successor that starts after the deadline is a wake Run
    (8.3).
  - Open, needs a live check before the owning provider ticket lands: Claude `session_state_changed`
    emission and `still_queued` follow-up; a Cursor steer delivered after `wait()` settles; whether
    killing the Cursor runner stops an abandoned local run; Codex `turn/start` while a goal
    successor is pending, and while a native wake turn runs (main's module hands a message off
    during a Codex wake, D58, and its start waits on the fence, 3.5); OpenCode `prompt_async`/abort executing after the client request ended;
    whether a Claude wake turn's `result` after a uuid-bearing prompt names no `user_message_uuid`
    (3.4); whether Claude emits an unsolicited turn start inside a user turn (3.4 would give that
    turn's uuid-less result to the wake).
  - **Decided (model-gaps, 2026-10-28):** `input_absent` after `delivery_unknown` ends probing
    for that transmission: no probe follows it, and it stays unconsumed, so a later acceptance
    beats it (3.5, 3.6). This holds unless 32.2.14's live check finds late execution; then OpenCode
    requires `native_idle`.
  - Rejected: membership per admission (R5: a refusal releases while a sibling acts); Claude
    releasing on a result (queued inputs run after a result that does not name them); holding a
    Claude member past its own result until `query_ended` (every next start waited and closed the
    live query, D2 amended); Claude
    releasing on `session_state_changed` (not consumed or recorded; it can be adopted later); a
    Cursor idle probe (none exists, and `wait()` already settles); Codex `thread/status` idle (a goal
    successor self-starts after it); OpenCode idle covering unconfirmed sends (a request in flight
    joins the loop after the sample); counting the abandoned Cursor terminal as a result (the native
    run may still act).
<!-- src: 82tn.32.2.14; OW Decision 2; FB §4 (idle covers confirmed delivery); claude-sdk-traces steer-misses-boundary, queued-input-promoted-to-steer; cursor-sdk-traces steer, steer-shell, cancel; codex-app-server-traces goal-chain, steer-race; opencode-wire-traces classic-prompt-during-tool; model-gaps 2026-10-28; REDESIGN review r1-2; REDESIGN-5 r1 (the wake end stated once in 8.3; Claude `cancelled` before `started` is Stop's own, as main ends it `interrupted` with no retry, claude-runner-payload.ts 2495-2522, orchestration-side-effect-reactor.ts 896-966 at 1ba91324; ub r1 P1-4, P3-3); REDESIGN-5 r2 (a member leaves at its own work ended; the result-held member, its column and D2's cleanup deleted, claude-sdk-traces steer-misses-boundary 136-155, second-input-held-to-turn-end 40-54; NotConsumed{cancelled}; ub r2 F-A, F-F, poteto r2 F2); REDESIGN-6 (label work is L6's; Codex's fence-expiry column stated, not a pointer to 5.1; poteto r3 P3-1); REDESIGN-6 r1 (labels with work on `interrupt_turn`; Claude work ended at a uuid-less result 3.4 gives the send; an unknown abort leaves at exhaustion; open: an unsolicited turn start inside a user turn; poteto r1 P2-C, P1-B, ub r1 P3-10); REDESIGN-6 r2 (Claude's column kills send work at the deadline, close only for a wake; stream end reports an error result; the OpenCode lift past 30 s; ub r2 P2-2, P2-3, P3-3, removable 1, poteto r2 P2-1); REDESIGN-7 (the fence-expiry column deleted: the stop's one deadline step is L6's, a kill per runner or the OpenCode lift at main's 30 s; an unknown abort leaves at the stop's deadline step; the late-interrupt test gone, 4.6) -->
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

- F12. The commit of a Stop other than `Superseded` fails with a store fault, transient or not.
  - Nothing durable changes, the runner keeps serving, and the state stays `Committing`.
  - The reconciler re-runs the whole commit after each backoff (capped at 30 s) and logs each
    failure. Until the commit lands it sends no shutdown or signal, and settles and prunes nothing.
  - Once the commit lands, the caller and every joiner see `Requested`, with `retired_at` set to
    that commit's time. Interrupting a caller does not cancel the commit.
  - A decode rejection, an identity rejection (session mismatch), any failure of a `Superseded`
    Stop (a store fault included), or a defect fails request stop with "stop runner" (F13). The
    upgrade retries a swap.
  - A daemon that dies first re-derives the Stop at restart per S3's table, except for a healthy
    runner's direct Stop with no durable control (Q26).
- F13. The Stop commit fails and is not retried:
  - Any row it decodes is rejected on decode: this runner's row, an unretired candidate of its
    session (serving Stop), or its successor (`Superseded`).
  - Or the row's session does not match the target (identity).
  - Or the Stop is `Superseded` and its commit fails for any reason: the swap is refused, or a
    store fault. The upgrade retries the swap.
  - Or the commit dies with a defect.

  Request stop fails with "stop runner". Nothing durable changes, with no shutdown and no signal,
  and the failure is logged. The state returns to `Running` and its waiters fail. The reconciler
  does not retry. A rejection would read the same row and fail the same way, and a `Superseded`
  retry belongs to the upgrade.
- F14. The daemon crashes after the commit and before shutdown: the next daemon does not adopt the
  runner as live; the reconciler continues from `Requested`.
- F15. A write after the commit fails (signal log, Gone, settlement, prune): the row stays, the
  reconciler retries, no waiter fails.
- F16. A send races the Stop commit: it is either held by the runner and settled at `Gone`, or refused
  before the runner sees it. Never settled twice, never stranded. Ledger chain: a held send's run is
  Ended by the `process_lost` of the write that first set `retired_at` (6.5); its pending input returns to the inbox
  behind the pause (D53), delivered at most once; a late runner answer is late evidence (3.8).
- F17. Two Stops race, or a Stop arrives during `Committing`: one commit, both callers see the same
  outcome.
- F18. The runner exits on its own while Stop is `Committing`: the commit still lands; the reconciler
  sees every member gone and settles.
- F19. An unverifiable leader: never signalled; `Escalated` is reached when the window ends; the
  watcher continues with the notice.
- F20. A run handed off to another runner before the first runner stops: it carries the new holder,
  and the first runner's reconciler leaves it alone.
- F21. An old row with `owned_run_ids` and a run with no holder: settled through the fallback.

<!-- src: STOP-INTENT failure modes 1-10; review 2026-10-28 (H5); SETTLE S3; 32.29.3 (c6d3a44f) -->

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
  the write that first set `retired_at` (6.5); pending input returns to the inbox behind the pause (D53), delivered at most once; a
  late answer from R's journal is late evidence (3.8).
- F29. A runner on an older build: the wire is unchanged, its registry role is ignored, `preserveRole`
  is no longer sent, and a Reserved old-build runner clears on hello.

<!-- src: SWAP failure modes 11-18; review 2026-10-28 (H5) -->

### 10.4 Send continuation (F30 to F56)

- F30. A send waits while its runner exits idle: refused `exiting`, released, runner stopped `Idle`,
  `Unserved`, new runner, held, delivered once. Ledger chain: 4.5 and 3.6.
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
  released, the runner stopped, the send delivered once on a new runner. Ledger chain: released
  `Refused{retiring}` by the `Exited` stop's commit (4.5), so the Run unlaunches and relaunches on
  the next runner, showing nothing (3.6); a later refusal is stale or 6.4's later release, placed
  by D53 (3.9).
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
- F50. A send retried onto a fresh run after a retryable failure (as main, 4.8): its transmission count carries over, and re-sends after
  retryable provider failures count toward the cap.
- F51. A live daemon, a held send, the runner exits before reading it: the reconciler releases it
  `JournalAbsent`, the feeder holds it on a new runner, delivered once, no restart needed. Ledger
  chain: when the exit is confirmed before the stop commits, that commit carries the
  `JournalAbsent` release and the Run unlaunches, showing nothing (4.5, 3.6). When a stop of the
  live runner came first, the run is already Ended by the `process_lost` of the write that first set `retired_at` (6.5);
  `JournalAbsent` leaves the pending input to D53: main's code places it from main's own events
  (3.9); a late answer is late evidence (3.8).
- F52. The runner announces idle exit with a send held and unwritten: the write gate keeps it
  unwritten and the `Idle` stop commit releases it `NotSent` (4.4, 4.5), delivered once on a new
  runner, as is one held after the stop's evidence read. A send written with no
  `command-accepted` before the `idle-exit` is released `Refused{exiting}` in the same commit
  (4.6). Ledger chain: its Run unlaunches and relaunches, showing nothing (3.6).
- F53. An older-build runner refuses with `command-reply runner_idle_exit` before
  `command-accepted`: `Refused{exiting}`, delivered once on a new runner.
- F54. Daemon SIGKILL between the hold commit and the write, runner alive: adoption's hello reports
  `not_received`, released `NotSent`, delivered once.
- F55. Stop accepted twice with the same command id after the cohort changed: the replay returns the
  stored payload; no second control row.
- F56. Two continuation sends share a cut-off message id, one covered and one not: only the covered
  one is refused `interrupted`; the other is delivered once.

<!-- src: CONT failure modes 19-45; review 2026-10-28 (H5); REDESIGN-5 r2 (F30 and F40 point to 4.5 and 6.4; poteto r2 removable) -->

### 10.5 Ledger rebuild (F57 to F61)

Behavioural statements the rebuilt decider must make impossible to violate:

- F57. A Run on attempt 2 is stopped (5.1) and successor B queues behind the stop's work (L6). A
  retained acknowledgement from attempt 1 arrives and changes nothing. B must not start until the
  stop's work ends (L6): B waits for the start's result or, after the retirement at the stop's
  deadline step, the retired runner's Run's end (3.8).
- F58. Running A, `run_now(B)` queued, then the project is removed: A's runner retires (L1) and
  the daemon refuses the session's sends (H4). A later receipt for A's input changes nothing; B's
  start is refused and B ends `refused (project_inactive)`. Nothing reaches the agent. A start of
  B stepped while the removal is still in progress gets `not_sent` and B goes back to Queued;
  its next try is refused once the removal has finished. If instead the project is only not
  served (a relay load error), B's start gets `not_sent` before any hold, B goes back to Queued,
  counts no transmission, is tried again at the backoff for as long as the error lasts, and is
  delivered once after the project is served again.
- F59. Question q answered with E; E gets a retryable outcome; result (error ActualFailure); E
  retried; then q's delayed confirmation of the first transmission arrives, then `query_ended`. The
  Run ends as error with ActualFailure, not completed.
- F60. An uncertain send's input probe is scheduled for retry, then the project is
  removed. The retry fires and its probe is refused (H4); nothing is transmitted.
- F61. The settlement deadline after a result is the one armed at the result. No later evidence
  extends it except evidence this contract says extends it.

<!-- src: REAPER failure modes 1-11; STOP-INTENT failure modes 1-10; SWAP failure modes 11-18; CONT failure modes 19-45; C0 Round-10 findings 1-5; SPEC Testing Decisions (failure catalogue); REDESIGN-6 r1 (F57 reads L6: a close ends no Claude work; poteto r1 P2-D); REDESIGN-6 r2 (no close for send work; ub r2 P2-2) -->

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
  `retryable_failed`, the reactor re-sends on a fresh run, and the cap counts across host runs (4.8).
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
  happens before the retirement commit succeeds.
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
  (every `effect_outcome`), settlements, and `alarm_fired` at arbitrary
  times. Evidence targets live, stale and never-issued tokens and arrives after Runs end. Providers:
  Claude, Codex, Cursor and OpenCode.
- **Ledger invariants** against a fake provider as ground truth:
  - LI1: no start enters `live` (from a direct `run_requested` or a `run_dispatched`) while the
    fake holds accepted, unended work or a running wake turn on that native session.
  - LI2: evidence the fake could deliver in either order yields the same `viewLedger` once
    both arrive. When one order decides a Tombstone between the two facts and the other does
    not, that Run may be absent from `active` in one view, and its outcome may differ, and with
    it every field derived from that outcome (Paused, 3.9; where its steers and inputs return,
    3.9, 4.8); every other view field agrees. An unlaunch needs no such allowance: each fact that
    unlaunches (3.6) says its try was never handed over, so the fake never also accepts that try
    (D52). Accounting is checked only by a duplicate accounting
    receipt producing no events; values belong to the usage projection.
  - LI3: at most one terminal per Run; Tombstones are immutable.
  - LI4: replaying a decision's entries through `evolve` from the initial state gives the same view as
    the live state.
  - LI5: live or unknown tasks are never destroyed without a confirm that matches the latest
    snapshot, except unplanned loss; lost work is recorded at most once per label, in the decision
    that ends its scope, and never for a label `Known` to have no live task (L5, 8.4).
  - LI6: a native command enters `live` and `nativeCommands` in the decision that folds its
    `native_command` control, alive process or not.
  - LI7: older-label evidence never changes authority or liveness; a send's own label is never older
    for that send (3.4).
  - LI8: `anythingMayAct` is false only when the fake has no running turn, no unfinished send other
    than a probe (D31) or a `stop_task` whose task is gone (3.5), and no live task; unknown counts
    as true.
  - LI9: each self-started turn on a label that is not older (3.4), with no active Run, yields
    exactly one wake Run.
  - LI10: a zero-turn result never ends or starts a Run.
- **Spec properties**, checked against both the pure decider and the real ledger on SQLite: every Run
  ends exactly once; every deadline 3.7 lists is data on its owner, and Starting,
  Running and label work have none; at most one active Run per
  session; no `delivery_unknown` input is delivered twice; no answer is lost; the inbox drains unless paused (main's module in T2, D58);
  Tombstoned Runs accept no lifecycle events; no illegal transition on valid input; tables and views agree after a rollback.
- **Oracle.** A deliberately naive reference consumes only the public command stream and the
  decider's public outputs (issued effects with tokens, `ended`, `viewLedger`), keeps its own history
  and recomputes expected facts. It never reads `SessionLedgerState`, `LedgerEvent` or any internal
  module. Differential traces compare effects, `alarmAt` (exactly) and the view after every step;
  tokens match by issue order, not value. The fake scheduler fires `alarm_fired` at `alarmAt` and at
  arbitrary other times, before and long after. The oracle is updated by a separate author who reads
  only the contract documents, the spec, the failure catalogue and the public model. It models no
  inbox: T2 runs main's module (3.9, D58). The `pendingCases` ratchet stands.
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
  - R2: native acceptance kept when retryable sends end; process loss reconciled before an
    ended owner is ignored.
  - R3: acceptance-based retention scoped to the accepted transmission.
  - R4: acceptance set by an input probe kept; observed proof kept without upgrading failed delivery.
  - R5: the native fence kept when a sibling start is refused (`run-ledger-r5-fence.test.ts`).
  The R3/R4 split is inferred in the source decision record.
- **Artifact:** JSON of seeds, hit counts per kind and race, and shrunk failures. CI runs a fixed seed
  set; an environment variable enables long runs.
- Each decider step lands as its own commit with the oracle and the differential green.

<!-- src: FB §5; OW Decision 5; HLK Oracle, header; C0 §4; BG Decision 5; SPEC Testing Decisions (property invariants); D1 Testing; model-gaps 2026-10-28; REDESIGN 2026-10-28 (02-options-and-pick.md) L5, LI9; REDESIGN harness r12 -->

### 11.3 The ledger, runners and end to end

- **Ledger on SQLite**, through the arm: atomicity of decision and duties. A guard test
  fails if anything but the arm writes ledger-owned tables. T5-writers (32.3) fails if
  src/lib/provider/run-ledger/** imports a main write module, or if a SQL text that writes
  `provider_command_outbox.status` exists that is not on 3.12's writer list or writes a from or
  to status outside the T5-writers table (3.12).
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
- 32.2.6's `decide` owns what 32.17 deferred: direct-provider uncertainty (4.10).
  `acceptStopEffect` (U9, R2's engine, orchestration-engine.ts 658-669 at 6c9ff950) reads
  `stopCovers` and writes the owners into `payload.stop.owners`. 32.2.6's `decide` reads only the
  folded `interrupt.requested` payload (5.4). The outbox re-send and the Stop rule it deferred are
  gone: a retry is a new transmission of the same ledger Run, whatever main's runId (3.4), and D53
  places every input (3.9).
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
| 32.2.3 | contract-only oracle update for decider rules, background work and provider policies; 3.13 and the oracle are normative for the core state 2.1 names, every owner-table row a typed field with one writer, checked by a test (A.18 T4); it models no inbox, its own inbox fields deleted (D58, A.19) | 11.2, 3, 8, 9, A.18 |
| 32.2.4 | public-interface trace harness, fake provider ground truth, oracle differential, coverage and fixed traces; the input kinds rounds 16 and 17 name, each trace also emitted as provider wire frames for 32.2.17 (A.17, A.18, A.19) | 11.2 |
| 32.2.5 | A6, A16 | 3.8 |
| 32.2.6 | direct-provider uncertainty (4.10); `decide` reads a stop commit's projected `stop` only to open the ledger stop deadline, and coverage stays `stopCovers` (L6, 5.4, D59); the unlaunch dropping its issue's execution, and main's relaunch and every retry folded as a new transmission of the same Run, whatever main's runId, in the model, each from its one observer: `run.dispatched` for a runner-held send, `run.requested` only for a direct one (D50, D59, 3.4); rows 210 and 212 are 25scs's (2.1); Q26: close native terminal projection's missing attempt fence with 32.6 | 2.1, 3.6, 3.12, 4.7, 4.8, 4.10, 5.4 |
| 32.2.7 | core authority, stopping, process labels, session gates and project removal; the one ledger stop deadline per session row, opened at the `stop.deadlineAt` of the first Stop or Run now commit that adds label work with no open main run, which later such commits join without moving it (L6), closed by that work's own ends (a Claude wake's `turn_ended`, 8.3) and, for work no observer ended, by its `alarm_fired` as forced work-ended facts, owner runs left to U2's step as main (L6, D59) | 3.3, 3.6, 3.7 L6, 3.11, 5.1, 6.1 |
| 32.2.8 | core answers, steers, an input's place (D53), a steer that outlives its Run (3.9), the inbox main's module run whole with no pause stored (3.9, D58), OpenCode and Cursor policies; rows 206, 207 and 211 are 25scs's (2.1) | 2.1, 3.6, 3.9, 3.10, 9 |
| 32.2.9 | integrate, verify and land the redesigned ledger | 11.2 |
| 32.2.10 | key Claude background tasks by native `task_id` and `run_id`, without a second counter | 8.2, 8.3 |
| 32.2.11 | A4's deadline as a ledger deadline, A11 unsolicited observations, wake executions (D47) and a Claude wake's end at its `turn_ended` (8.3), a wake execution and label work with no open main run bounded by the ledger stop deadline (L6, D59); the stop's deadline step, U2's for owner runs (for OpenCode their `stop_unconfirmed` terminals end their Runs, 3.8) and the ledger alarm for the rest, so the blocked Queued Run launches, also after a restart and when U2's step cannot retire (L6), label work with no clock (L6, D54), no Starting, Running or pre-Stop deadline (3.7), interactions owned by their label (3.10), AUDIT-2 T5, T7, `run_id` order | 3.4, 3.7, 3.10, 8.2, 8.3, 8.5 |
| 32.2.12 | core destructive confirm and lost work, including stale snapshots and labels; row 213 is 25scs's and 32.25's (2.1) | 8.3, 8.4 |
| 32.2.14 | native-session fence membership and idle proof for each provider; row 202 is 25scs's (2.1); a `result` naming no input is the outstanding wake's, else every started send's with no result (3.4) | 3.4, 9 |
| 32.2.15 | end label per `StopReason`, derived from L5 and 3.6; the oracle and R2 tests agree | 3.8, 6.5 |
| 32.2.17 (new) | the main replay differential and arrival-order permutation gate, needs the D59 spike, 32.3 and 25scs: each catalogue and generator trace (browser commands, provider wire frames, process events) replayed over `:memory:` SQLite through main's real stack at R2 (6c9ff950) and through the same stack with the ledger's arm and 25scs's 2.1 rows (D58); at each step main's events, rows, `readInboxState` and provider calls equal but for the 2.1 rows, each a typed mask (a mask that never applies fails; the evidence events and the three ledger effects' provider calls are mask classes, rows 215, 216), order-independent over every permutation of up to 6 settlements. Its catalogue holds a restart between dispatch's requeue and its `input.cancelled`, impossible by construction (row 207), an OpenCode trace whose label work ends only by a probe, and the D59 spike's three traces (A.21) | 11.2, 2.1, A.19 |
| 32.2.18 (new) | the contract checks, run before a review round: the citation check over every main citation and its anchor (A.18 T1), and the reader sweep over CONTRACT.md and every bead 12.2 names, with the recount check (A.18 T3); the sweep reads the newest note of each bead as live text, never as history by policy (A.21); spec review rounds run after T1 and T3 exit 0 (A.20) | A.18, A.19, A.20, A.21 |
| 32.2.19 (the spike, superseded) | the D58 spike and T5-writers, whose measured result fed REDESIGN-10's review round 1: the arm and a status table built in R2's real Layer graph (6c9ff950) over `:memory:` SQLite, running A.20's two traces. Run 2026-10-31: trace 1 held; trace 2 held with the owner rebuild (2b); the writer-list test against 3.12's 15 writers moves to 32.3's acceptance; the ledger effects' rows, the insert's key, the writer list and T5-writers' form were corrected in 3.9, 3.12 and A.20 | 3.1, 3.9, 3.12, L6, 5.3, A.20 |
| D59 spike (new, child of 32.2) | the D59 spike, run before the next review round: the ledger stop deadline and the retirement's `process_lost` built in R2's real Layer graph (6c9ff950) over `:memory:` SQLite, passing A.21's wake, failed-step and restart traces; blocks 32.3, 32.2.17 and 32.2.9 | L6, 2.1, 6.5, A.21 |
| 32.3 | the arm in the projection runner, folding with no outbox row on replay (3.1, 3.9, D58); the three ledger effects whole (2.1 row 216): the arm's insert keyed by the partial unique index, one reactor executor per type, a wake on the insert, all three exempt from the session lane (3.12); the evidence events `process_started` of a runner, `alarm_fired` and `effect_outcome` (every control's included, from every writer of its row's outcome, sweeps included, named by its row's `command_id` and `attempt_count`, 0 when no claim reached it, 3.4), and the scheduler fiber, which appends only `alarm_fired` and lives outside src/lib/provider (2.1 row 215, 3.7); every row 215 kind registered at each event-kind guard site, the provider tickets only appending theirs (4.1); the T5-writers table of outbox status writers (3.12); A5, A7, A14, A18, A19, T9, T12, the per-session row of A8; owns the SQLite event-order test. Acceptance adds: the T5-writers test against 3.12's 15 writers and the effect executors; a direct send's fresh-run retry `run.requested` for an input already in a ledger Run folds as a transmission, never a reserve, and a runner-held send's only by its `run.dispatched` (3.4, D59); the ledger stop deadline on the session row, its `alarm_fired` from the scheduler after a restart with no U2 restore (L6); a non-terminal Claude `turn.completed` does not end the arm's Run (F18); the full-graph rebuild over a surviving process runner (A.20's trace 2 with the Layer graph rebuilt whole), where U2's restore makes one `stopping` entry with the row's `deadlineAt`, replay inserts no outbox row, and the host's terminal ends the stop and the Run once, with no `runner_stopped` failure and no `provider_process_gone` cancel; a control row the refusal sweep, `drain`'s removed-project cancel or pending-prompt retirement ends appends one `effect_outcome` in that write, `(commandId, 0)` when no claim reached it, and leaves no `live` entry for its issue (3.4, 3.12); the migration and schema inventory snapshots updated deliberately, each diff checked to be the new tables and index only | 3.1, 3.7, 3.9, 3.12, 11.3, A.20 |
| 25scs (new, child of the epic, blocked by 32.3) | the 2.1 rows whose unit reads the view: 202, 206, 207, 210, 211, 212 and 213's view read, in the reactor (`markRunning`, the outcome body), `requeueFailedSteers` and U2's `retireProcess`; R2's `acceptStopEffect` reads no view; 32.11 adds row 205's read (D59); needs 32.3 and the core tickets whose `decide` output a row reads (32.2.6, 32.2.8, 32.2.11, 32.2.12, 32.2.14); blocks 32.2.17 and 32.25 | 2.1 |
| 32.4 | deadlines as data and the process watcher; A1 with the ledger: appends `process_lost` in each write that first sets `retired_at` (`requestStop`'s raw write, the release commit's `commitStop`, `commitRetirement`), its rows from one reader in runner-receipts.ts, and the store mark the next commit's recovery reads (2.1 row 215, 6.5, D59), after the stop commit's releases (L1, 4.5), beside main's settlement, which stays (6.5, D58); A3, A8, A15 with the ledger; Q26: durable process-loss recovery, including the uncommitted direct-Stop/live-reattachment limitation (7.2), with 32.6/32.8 | 3.7, 6.4, 6.5, 6.8, 7.2 |
| 32.5 | stateless runner protocol; A11; the protocol bump with 32.19; Send Token identity on the wire, run ids as coverage labels only, `interrupt_turn` with runIds only, interrupting the turn running at receipt and the named runs' accepted unstarted commands, a later turn never (4.6); a joined steer's own `run.dispatched` and token (4.11) | 4.6, 4.9, 4.11, 9 |
| 32.6 | Claude through the ledger; reuses the journal answers. Lands Claude's 2.1 rows and evidence events (row 215: a Claude wake's `turn_started` and `turn_ended`, and the swap commit's `process_started`); acceptance adds: a Stop over only a wake ends the wake at its dispose's `turn_ended`, not forced, and the Queued Run launches before the alarm, which forces nothing (L6, A.21 trace W); main's run state, Send Settlement and `Gone`-time settlement stay (D58); the swap commit with promote's memory part before the permit's release and a command activating a Candidate host (6.9); needs 32.3 for the probes its label rules use; Q26: close native terminal projection's missing attempt fence with 32.2.6 and durable process-loss/control recovery with 32.4/32.8 | 3.9, 3.12, 4.9, 4.11, 6.1, 6.5, 6.9, L6, 8.3 |
| 32.7, 32.23 | steering as a Run Input; wake admission. steer association stays main's `joined_into`, folded into Run Inputs by the arm (section 2, D58) | 3.9, 3.12, 8.3 |
| 32.8 | Stop, interrupt and Run now; `interrupt_turn` built in R2's `acceptStopEffect` body (5.3) carries `payload.stop.owners` as runIds (4.6); label work ends through the ledger's probe (32.3), not the interrupt; the stop and its deadline step are main's, U2's retire `end_session` run whole and never a ledger item (L6, 8.4, D59); a Stop or Run now commit (L6) resolves the Pending interactions on the labels with work at it, an async question never, and for OpenCode by row 205 (2.1, 3.10). The `control` `stop` opens or joins the ledger stop deadline and is never read for coverage, which stays main's `stopCovers` (5.4, D58); Q26: durable Stop/control reconciliation and recovery with 32.4/32.6 (7.2) | 4.6, 5, 7.2 |
| 32.9 | answers through `control(answer)`; an answer resolves its interaction at its delivery's confirmation, the host's own resolution or its delivery's unconfirmed end (3.10) | 3.10 |
| 32.32 | closed (REDESIGN-10 r2): no unit issues a ledger kill, so the effect is deleted; H2 is main's retirement (6.6) | 6.6 |
| 32.10 | Cursor through the ledger, runner-held; reuses 32.6's runner path. Lands Cursor's 2.1 rows and evidence events; main's run state and Send Settlement stay (D58) | 3.12, 6.5, 9 |
| 32.2.13 | Codex policy in the decider | 3, 8, 9 |
| 32.21 | Codex through the ledger, runner-held; reuses 32.6's runner path. Lands Codex's 2.1 rows and evidence events (row 215: a Codex successor); main's run state and Send Settlement stay (D58) | 3.12, 4, 6.5, 9 |
| 32.11 | OpenCode through the ledger. Lands OpenCode's 2.1 row 205 and evidence events (row 215: OpenCode's `process_started`, labelled with the instance's `promptProcessId`, `onInstanceStopped`'s `process_lost` in its `settleSessionRuns` batch, and the direct marker's event, by 32.2.6's rule, 4.10); main's run state and Send Settlement stay (D58); needs 32.3 for the probes its work-ended rule and an unknown abort use, and 32.2.11, 32.2.14 and 32.2.8 for the `decide` output row 205 reads | 3.9, 3.12, 4.10, 9 |
| 32.12 | session-wide failures and removed projects: one project gate for H4 (removed, not served, served: `not_sent` before any transmission, its Run back to Queued while not yet delivered (3.6), while registered and not served or while a removal or registration runs, a permanent `project_inactive` once removed), removal serialized with spawn per project, `project_inactive` a final refusal | 3.11, 4.4, 4.7, 4.8 |
| 32.13 | deletes the old run-state copies: `owned_run_ids` and the fallback and `newestRunnerFirst`; `payload.stop.owners`, `stopCovers` and `legacyStopOwnersQuery` (5.2, 5.4), main's run joining, the outbox, its dispatch and Send Settlement's status writes stay, the last in the T5-writers table (3.12, D58); the inbox's order and pause have one writer, the inbox module, and the ledger view has none | 3.9, 3.12, 5.4, 6.5, 6.9, 7.4 |
| 32.14 | full crash matrix and two-build upgrade, run once each for Claude, Codex and Cursor; reuses the journal answers | 4.9, 11.3 |
| 32.22 | A9, A20, T6, T11 | 8.3 |
| 32.24 | Stop tasks through per-task effects, without touching a turn | 8.4 |
| 32.25 | destructive confirm and durable lost-work notice; the confirm on 25scs's view read in U2's `retireProcess` (row 213), so it needs 25scs | 8.4 |
| 32.26, 32.27 | A4, A17, T4 | 8.1, 8.4, 8.6 |
| 32.28 | Codex background terminals as tasks | 8, 9 |
| 32.29 | the send settlement redesign (SETTLE S1 to S5) and the split by state owner: send gate and feeder, Send Settlement, Starter, legacy recovery, retirement, live send; the write gate read from the 6.4 stop state (4.4); a stop commit carries the releases it has evidence for, and a refusal joins or raises its stop (4.5, 6.4); `holdRun` counting a `commandId`'s `run.dispatched` within its input's reservation (4.8) | 2, 4.3-4.5, 4.7-4.9, 4.11, 6.3, 6.4, 6.9, 6.10, 7.1-7.2 |
| 32.2.16 (R2 runtime, a 32.29 child) | Gone-time settlement holds again a run never handed over, after the stop commit's releases, for every `StopReason`; flips the R2 label tests | 3.6, 4.5, 6.5, 7.3 |
| 32.30 | SessionActivity as every surface's activity view; bead requires a contract extension before implementation | 2, 8.1 |
| 32.33 (Servers) | servers (8.7): `server_seen` and `server_gone` evidence, `ServerKey`, `Server`, `Servers` and `LedgerView.servers`, first in 32.33.1; 3.13's model has none of them until then | 8.2, 8.7 |

- Lanes paused for this redesign: 82tn.10.6, 10.7, 10.9, 11, 12, 13, 14, 15 and 16. They build on
  the ledger. The ledger is built on the 82tn integration branch after the final 27.3, 10.3 and main
  merges, before 82tn.10.6 onward resumes.
- Background-work tickets depend on runner R1 and R2.

<!-- src: AUDIT Tickets; AUDIT-2 Tickets; RA §9; SEND-SCOPE-5 S8; SEND-SCOPE-6 S10.1; SPEC children list, Implementation Decisions (Placement), Further Notes (paused lanes); CONT Out of scope; review 2026-10-28 (H4, H9, H10, M1); model-gaps 2026-10-28; read-only Beads 2026-10-28; SETTLE S2, S3, Required work, Decisions (AJ); REDESIGN-7 (32.2.11, .2.14, 32.5, 32.8 read the stop; .2.3 owns M8 and M12, .2.4 the R7 input kinds, a new .2.17 the M9 gate and the M10 sweep) -->

## 13. OPEN items

All seven are decided; the decisions live in the cited sections.

| Id | Question | Section |
|---|---|---|
| OPEN-1 | Decided 2026-10-28: derived from the hold, never stored | 4.11 |
| OPEN-2 | Decided 2026-10-28, clarified model-gaps: opaque host string bound by `commandId` and transmission from `run.dispatched` | 4.11 |
| OPEN-3 | Decided 2026-10-28; amended by REDESIGN-10: Stop coverage and run joining stay main's (D58) | 5.4 |
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
| Q9 | 9B | Resume is main's SendNow arm on the inbox head (D58) (`SendNow`, session-inbox.ts 295-321 at 1ba91324; PendingInputTray.svelte 103); the ledger has no project gate, and a removed project's sends are refused by the daemon (3.11, H4, D48) | not recorded |
| Q10 | 10B | a refused answer stays Pending with `lastRefusal` while its delivery retries, then resolves at its delivery's unconfirmed end (3.10) | not recorded |

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
| Q25 | SEND-SCOPE-5 | E: a message that never reached the agent is re-sent up to the cap (4.8); amended by D53: only while its Run is active, else it is queued behind the pause (3.9, A.10 round 16) | | not recorded |
| claim | SEND-SCOPE-5 | B: starting is part of the owner | | not recorded |
| Q26 | SEND-SCOPE-5 | C: the Run Ledger is that owner; R1 and R2 land first (12) | an interim owner would be deleted by 32.13. Q26 forbids a new interim owner; existing owners such as `stopCovers` stay main's (5.4, D58) | not recorded |
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
| OPEN-3 | A: the ledger replaces the Stop cohort at 32.13; `stopCovers` is the interim owner (5.4); amended by REDESIGN-10 to B (D58) | B: keep `stopCovers` and run joining as the ledger's coverage |
| OPEN-4 | A: `process_lost` in the commit that sets `retired_at` (6.5). The recommendation was B | B: at confirmed `Gone` |
| OPEN-5 | token identity; run ids as coverage labels; runIds only on `interrupt_turn` (9, 4.6) | interrupts naming tokens; highest-attempt acks; input-id targeting; one ordered socket writer; a Stop epoch; host-minted ids; daemon-only receipts |
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

- D1: changed by round 16 (Amends D1): query end covers runner-held interrupt, never input work or OpenCode controls (3.3, 6.1); `close` is gone (L6).
- D2: changed by round 16 (Amends D2): a Claude member leaves the fence at its own work ended (9); its work is its label's, bounded only from a Stop by the stop (L6), with no Tombstone cleanup (3.7).
- D3: process starts count as task-set entries and refresh pending confirms (8.4).
- D4: changed by round 16 (Amends D4): a Run-less `end_session` joins the open stop, else opens a new one, whose deadline step escalates it (L6, 8.4).
- D5: tokened command lifecycle addresses a held query transmission and matches its command id (9).
- D6: a named native result confirms delivery for OpenCode idle coverage (9).
- D7: changed by D48: wake execution stays live after Run end (8.3).
- D8: unsolicited identity is the label and event id pair (3.4).
- D9: Queued borrows its blocking obligation's deadline; no fence clock or fenceMs (3.7, 3.13).
- D10: changed by D48: session end covers sends (3.4).
- D11: removed by D48: no probe has a project case; a refused probe is re-probed under its cap (3.7, 3.11).
- D12: interaction resolution ends every answer transmission for it (3.10).
- D13: probe retry fires at issue plus max(probeMs, backoff(n)) in one decision (3.7).
- D14: LI2 permits the Tombstoned Run's absence from active and a different outcome (11.2).
- D15: derived from L5: lost work is recorded under the label whose scope ended, the runner's latest at retirement (8.4). A label `Known` to have no live task records nothing. Reason: the record is the notice that background work was cancelled (32.25); under 8.3 an empty one would follow every fresh-launch kill and every Cursor or OpenCode retirement.

**Decided (integration round 3, attrib-r3)**

- D16: derived from L1: a kill retires its runner at issue, covering its sends, its own included (3.3, 5.1).
- D17: removed by D48: a native command has no project case; it enters `live` in the decision that folds its control (LI6), and a refusal makes it `Failed` (D34, 3.11).
- D18: an outstanding wake execution is a native-session fence member until its work ends, its runner retires or the session ends (8.3, 9).
- D19: derived from L4: a native command is a session send with no Run, so never a Run's barrier; its deadline drives only its view (8.5).
- D20: a retry is anchored where its obligation opens: the outcome for a send, the issue for a probe; `retryAt` only raises it (3.7).
- D21: a command receipt answering a held start or steer and naming another commandId is Rejected, covered or not (3.4, 9); a native command's receipts answer no token (D61).
- D22: derived from L2 case 3 and H3: with no process the command goes to pending, and the feeder spawns (8.5, 4.4). Rejected: waiting for `process_started` (only the feeder spawns, so a lone command deadlocks); a ledger spawn effect (a second spawner).
- D23: derived from L2: pending resolution, which also fixes the send's label (3.3).
- D24: derived from L4: a covered command is `Failed` with its cause, from L1 and 3.4 (8.5).
- D25: changed by round 16 (Amends D25): a Claude wake execution ends, and leaves the fence, at a result naming no send's input uuid or its label's `query_ended`, whichever is first (8.3); a Claude send leaves at a result naming its input (9).
- D26: for OpenCode, a trusted covering idle probe alone is work ended, for start sends and wake executions alike; the table's sequence is the usual path, not a conjunction (3.5, 9).
- D27: changed by D48: derived from L4: the deadline starts at issue (8.5).
- D28: derived from L1.2: under H1 a joining label is a newer `querySeq` of the same runner, and each execution ends at its own work ended, its runner's retirement or its session's end (8.3). A turn joining a wake Run under another label is a wake execution of its own: live and a fence member until then; an execution still outstanding when the wake Run ends is its label's work, bounded from a Stop by the stop's deadline (L6; changed by round 16, Amends D28). Rejected: killing the current process at the wake deadline (destruction would depend on arrival order); moving the wake label to the newest (hides work still running under the first label, LI8).
- D29: changed by REDESIGN (A.11), L3: the gate stores its step; its labels are a view computed when it issues. Reason: the old rule froze labels at gate time, so a confirm after a replacement sent `end_session` to a retired runner (D36's own rejected failure). One confirm for a multi-label step stands (8.4); D48 removed its `project_active` case.
- D30: removed by D48: no command is deferred (8.5).
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
the send 3.4 binds it to, and is an unknown token when no issue of its `commandId` precedes that
retirement (3.3 L2, 3.4); only snapshots and `process_started` replace tasks; older wake
execution labels never end the Run (8.3); the gate's tasks and `snapshotEntry` are views, a gated
step decides at issue, and a release by retirement issues as any release does (8.4).

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
a native command fails it (D34), and an older wake label's
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

**Oracle round 10 (2026-10-29): no new decisions.** Its seven questions follow from 3.4, 8.3, 8.4,
D28 and D47:
- A retirement does not count toward `snapshotEntry`. With no current process there are no tasks
  and no confirm (8.4).
- A start's own Run-end answer under the joined label clears the joined execution. It is that
  label's Run-end evidence (8.3).
- Unsolicited Run-end evidence for a joined input Run clears the execution and leaves the Run, with
  a diagnostic. Liveness clears without authority, state changes need it (8.3).
- The producibility check (D46) comes before the unknown-token rule. Producibility is a property of
  the kind, not the token (3.4).
- A repeated `turn_started` re-arms its execution: there is one per (Run, label) (D28).
- Run-end evidence for a label clears every outstanding execution with that label. 8.3 names the
  label, not one execution.

**Harness round 12 (2026-10-29): no new decisions.** Its four contract questions follow from 3.2,
3.4, 3.5, 3.11, 4.3, 4.8 and 8.3, and are written into those clauses:
- A `stop_task`'s work is its task; it is never probed, so `delivery_unknown` keeps it only while
  the task is live or unknown (3.5, 8.4, LI8).
- Late evidence that releases the fence starts the next Run in its own decision: 12A forbids
  effects for the Ended Run only, and `reconcile` reads views, never the command (3.2, 3.8).
- Evidence on a send without authority still updates its chains, and a retryable outcome after
  `started` keeps work (3.4, 3.5).
- A transmission binds to the latest issue of its `commandId` before it was held (3.4, 4.3, 4.8).

**Decided (oracle round 11, 2026-10-29)**

Six questions from the oracle round against round 13. Two follow from existing clauses: a
`run_dispatched` naming a runner retired before any issue of its `commandId` binds none, an
unknown token (3.3 L2, 3.4, 4.3); a Sent `stop_task` may still act while its task is live or
unknown (3.5, 8.4). The other four (binding of an issue retired by project inactive, evidence on
a retired probe, the deadline of a revived retired send, `activity` without authority) came from
the project seam. D48 (A.12) removes the state they asked about: no send is retired by a project,
so binding is 3.4 alone, a probe's findings apply as for any probe, nothing revives, and
`activity` is ordinary evidence.

**Decided (contract round 15, after REDESIGN-3, 2026-10-29)**

Twelve questions from oracle round 12, harness round 13 and bead 32.2.15, revised after three
review rounds and REDESIGN-3 (A.13). Five follow from H1-H4, L1-L5 and existing clauses and are
written into them: a not-served native command shows `Queued` (8.5); lifecycle evidence is
recorded with or without authority (3.4); backoff counts a `not_sent` try and the cap does not
(3.7, 4.8); retirement covers a send by address whatever its tries got (L1 item 1); a Run's end
reason is the cause of the decision that first ends it, so a retirement ends a Run that reached
the agent `process lost` for every `StopReason` (3.8, 6.5). Two new decisions (D49, D50) and one
amendment to D48 decide the rest. The host's idle-exit order (4.6) is a host fact read from the
runner host on main and the R2 branch, not a decision. Round 15 (contract, after redesign): 2 new
decisions, 2 amend earlier ones, 0 came from new generator input kinds.
- D49: a runner-held try that ends before any hold is named by its queue key, in the settlement
  `unheld_outcome{runId, commandId, outcome}` (3.13), and belongs to that Run's latest issue of
  that `commandId`; for an Ended Run it is late evidence (3.4). It carries start failures,
  `StartLost` and gate answers (4.4, 4.11), and like a gate answer it settles only a run that is
  not covered, so a Stop during a spawn shows "Stopped before delivery" (4.4). Reason: no rule
  names it; `holdRun` mints the token (3.4), so before any hold the model had no input for the
  outcome, and a `commandId` alone binds a late start failure to a re-send on a fresh Run (4.8).
  Rejected: a host-minted try token (a second token source); an Answer keyed by `commandId` (an
  Answer names a token); the latest issue of the `commandId` across Runs (no anchor).
- D50: amends A.11 (L1 item 2, the L2 wire label, and the order of a stop commit's releases),
  D48 (3.6) and the clauses of 3.13 (`process_lost` carries its releases), 4.3 (the switch
  backstop), 4.4 (CONT C3's re-hold after a release, SETTLE S1's write race), 4.5 (SETTLE's
  pre-write idle check, CONT C3's one commit for release and stop), 4.8 (the fresh Run for a
  start that never reached the agent), 5.1 and 6.5 (as-built Gone-time settlement), 6.3 and 6.4
  (the stop commit's release evidence; a refusal joins or raises its stop), 7.3, F40 and F51 (an
  exit confirmed before its stop), each rewritten in place. A Run is
  not yet delivered while it is Queued, or Launched with an execution that never reached the
  agent (the one test, 3.6). Stop, Run now or `end` ends such a Run at once, `interrupted`, with no
  effect; a non-permanent outcome of its start (`not_sent`, retryable, a release, a rejected
  resume) or its runner's retirement unlaunches it, showing nothing, and it relaunches under the
  same `commandId` and count at the retry or at once; a permanent outcome ends it
  `refused (code)`. A Run that reached the agent never unlaunches (3.6, L1, 3.8, 4.4, 4.5, 4.8,
  5.1, 6.5, 8.3). The possibly-written set is fixed at retirement because the stop intent closes
  the write gate before its evidence read (4.4, 6.4), and the stop commit releases `NotSent` every
  hold it reads outside that set, so a hold made after the read is released and an earlier
  daemon's hold, with no write evidence, is not (4.5). One rule replaces round 15's two drafts
  (an unlaunch that `not_sent` and retirement alone triggered, and a separate Stop rule for a
  Queued Run), 4.8's error turn and fresh Run for a retryable start failure, the feeder's
  same-execution re-hold of a released start from the switch (before it the release's enqueue is
  still the re-hold, but for `ResumeRejected`, 4.4), and round 15's first
  `refused (not_sent)`. Reason: no rule decided it; the earlier text gave a start that
  never reached the agent three answers and ended a Run that lost nothing: an idle exit, a swap
  or a refusal before the start was consumed showed a `runner_stopped` error where main retries
  silently at idle exit and recovery abandonment (process-session-runner.ts at 3aa43c60: 975,
  2331-2335,
  3707-3711), and a Stop during a spawn could show `refused` where main shows "Stopped before
  delivery". Rejected: ending the Run and re-sending on a fresh Run (an error turn for nothing
  lost); a new end reason (a try is not an issue, H4); the write fiber releasing an unwritten
  start after the retirement commit (the Run is already Ended `process lost`); a Stop rule for
  Queued Runs only (a Launched Run with a spawn in flight is just as undelivered); the stop
  commit taking write permissions in its transaction (a permission with no owner after a failed
  commit, A.13); a refusal's own stop form with a restore on failure (a second reopen rule, A.13);
  a durable `command-accepted` fact (A.13).
- Amends D48 (H4): a `not_sent` try is a try, not an issue. It ends only its own work, never a
  Run, an address or an obligation, and a native command's confirmation clock resumes with the
  time it had left instead of restarting (H4, 8.5). Reason: L2 addresses a send once, at issue,
  and 8.5 starts the deadline at issue; H4's "re-issues" read as a restart.

**Decided (contract round 19, 2026-10-31)**

Nine questions from harness round 14, oracle round 13 and R2 lanes 9-11, then three review rounds,
REDESIGN-4 (A.14), its three review rounds, REDESIGN-5 (A.15) with its three review rounds,
REDESIGN-6 (A.16) with its three review rounds and REDESIGN-7 (A.17). Two are
decided by the text as it stood: oracle round 13's thirteen ambiguities, and the catalogue
scenarios, which follow D48, D49 and D50 as written. Three are rule changes A.15 counts: the
native-session fence holds every start transmission, a launched Run's own start retry included,
and membership is per send and wake execution, so a retry waits behind an outstanding wake
execution (3.6, 9); a steer follows its Run's execution, so one an unlaunch strands is tried again
in the relaunched execution, never a runner (3.6, 3.9, L2 case 2); every required recall and drop
keys off durable facts read in its transaction (4.4, 4.7), a new rule because no clause said where
those steps read their facts, though it decides no new outcome. Three are decisions, D51 to D53,
and the wake execution is an amendment (of D47). REDESIGN-6 adds D54 (L6) and D55
(`cancel_input`) from review round 3; its review round 1 adds no decision, revises D54 in place,
widens the SPEC Stop, SPEC Deadlines and OW Decision 3 amendments, and adds one, of 82tn.32.2.14;
its review round 2 adds no decision and no amendment, and revises D51, D54 and five amendments
in place (A.16). REDESIGN-7 rewrites D54 in place as the stop, revises D51 and the amendments
that read the work episode, a close or the fence-expiry column, and adds four amendments, of
OPEN-5 (4.6), FB §4 with RULINGS R2 (3.10), D4 and D1; its review round 1 adds one, of SPEC (One
active run, 3.9), and revises D54 and four amendments in place; its review round 2 adds one, of
HLK 10B (3.10), and revises D51, D54 and the SPEC Stop, 82tn.32.2.14, FB §4, D4 and SPEC One
active run amendments in place (A.17). REDESIGN-8 rewrites D51 in place as main's `decideInbox`
over a ledger view, the user's decision of 2026-10-30, adds D56 (main's code is the reference,
2.1), and rewrites the S9.3 and SPEC One active run amendments in place; its review round 1
revises D51, D53, D54 and both amendments in place (A.18). REDESIGN-9 replaces D51 with D57 (the
inbox is main's module, reused unchanged), amends D53 (a steer that outlives its Run is a Run of its
own), and rewrites D56's check as the replay at the provider wire and the S9.3, SPEC One active run,
HLK 9B and AUDIT-2 amendments in place as pointers to D57 (A.19). REDESIGN-10 replaces D57 with
D58 (the ledger lives inside main's writes), revises D54 in place (the stop is main's `stopping`
entry; the ledger owns its items) and adds two amendments, of SPEC (Schema, 3.12) and OPEN-3
(5.4) (A.20). Its spike (32.2.19) corrects D58 in place: the status machine lists its writers
and `cancelled`, and T5 checks each status SQL text (3.9, 3.12). Its review round 1 adds no
decision and no amendment, revises the OPEN-5 and SPEC (Schema) amendments in place, adds five
rules (the four ledger effects landed whole, their lane exemption, evidence events, the OpenCode
deadline step with items and the restart's confirm, 2.1 rows 213 to 216) and deletes four (A.20).
Its review round 2 adds no decision and no amendment, revises D52's coverage list in place, deletes
three rules (the ledger kill, its coverage and its restart recovery) and adds three (a runner
deadline step that cannot retire ends its items, a fresh-run claim folds as a transmission, a
probe's provider call bounded by its retry deadline) (A.20). REDESIGN-11 adds D59 (one model
per piece of running work, one observer per fact), rewrites D54 in place (main's entry owns its
owner runs whole; the ledger owns only the deadline of the work no main run holds) and the SPEC
Stop, D43, SPEC Deadlines, 82tn.32.2.14, D4 and D28 amendments in place, deletes five rules and adds
eight (A.21). Its review round 1 adds no decision, no amendment and no rule: it rewrites in place
the ledger stop deadline (one per session row, opened by a Stop or Run now commit), `forced` (the
ledger stop deadline's alarm only), `process_lost`'s type and the D4 amendment (A.21).
The steer question needs an input kind the generator lacks: a stop commit's `process_lost`,
preceded in its transaction by `run.released` events holding `NotSent` for both a
not-yet-delivered Run's start and its steer. D52 needs four more: `run_dispatched` of a send a pending kill covered (H3);
an `end_session` success before its runner's `exiting` release; a hold between an unlaunch and its
relaunch; a same-driver usage-limit failover with a held try besides the cut-off input, before and
after the cut-off result. D53 and the wake execution need five more: a release after its runner's
`process_lost` for an input already queued; an acceptance after its Run's end; `turn_started`
while the active Run is Queued; Stop with an outstanding wake execution; the stop's
deadline step with a wake execution outstanding (L6). REDESIGN-6 review round 2 needs one more: an
`interaction_requested` on a label no Run reads. REDESIGN-7 needs three more: a second Stop while
the stop is open, with wake work gained since the first; an interaction Pending at a Stop commit;
a Run-less `end` reaching the stop's deadline. Its review round 1 needs five more: a message sent
while the active Run is Interrupting; a wake's `turn_started` on a held label just before and just
after a Stop commit; an answer in delivery at a Stop commit; an async question at a Stop commit
and at a retirement; an `end_session` issued after the stop's deadline step. Its review round 2
needs four more: a Stop between a kill's issue and its `process_lost`; an answer refused
permanently, and one unknown past its probe cap, with no Stop; a message sent with no active Run
while the inbox is Paused; a Run now while Paused whose Run ends `completed`. REDESIGN-8 needs three more: a message sent
after the active Run's end while the stop is still open; a message sent idle while `limited` with
stopped inputs queued; a message sent idle with an unpaused queue, so the oldest runs first. Its
review round 1 needs six more: a message sent after a kill's issue, before its `process_lost`; a
steer during a Claude and during a Codex wake Run; a Codex async question answered by a message;
Run now on an input behind the head, then Stop before its delivery; a steer's send failure before
and after the stop's clean result; Resume while `limited`. REDESIGN-9 needs four more: a Claude
steer its host starts after its Run's `completed` end; a Stop of that steer's turn; a runner
failure with one steer possibly reached and another input queued; a steer's send failure with
other inputs queued. Its review round 1 needs five more: a second steer sent before a late steer
starts; a Claude Stop that keeps a pending steer; a Codex steer awaiting its `turn/steer` answer
at a `completed` end; a runner failure's unreached steer at the inbox front; a Stop and two
sends between a kill's issue and its `process_lost`. Its review round 2 needs five more: a
steer's send failure, ending `removed`; a runner failure with a reached and an unreached steer,
before and after a restart; a decline, and one after a restart; a steer during only a Claude wake
Run; a Stop whose kill's `requestStop` fails. Each is also needed as provider wire frames
for A.19 T2. REDESIGN-10 needs none: the 32.2.19 spike's traces use kinds the generator has. Its
review round 1 needs four more, for 32.2.17's catalogue: a restart between dispatch's requeue and
its cancel; an OpenCode deadline step with items and no owner runs; a send issued after a kill,
before the kill row settles; an OpenCode wake whose label work ends only by a probe. Its review
round 2 drops the kill trace with the effect and needs one more: a runner stop whose deadline step
cannot retire (a restart before reattach, then a hung wake past the deadline). REDESIGN-11 needs
four more, for the D59 spike and 32.2.17: a restart between a Stop commit and its `deadlineAt`
with only a wake execution open; a managed OpenCode stop with open Runs; an OpenCode instance
replaced, or its URL changed, with open Runs; a runner-held fresh-run retry, its `run.requested`
then its `run.dispatched`.
Round 19 (contract, after redesign 11): 7 new decisions, 30 amend earlier ones, 1 came from new
generator input kinds. Against HEAD, a replaced rule counting as one deletion and one addition, a
move or a restatement as neither and a new reader or exception as an addition, it deletes 60 rules
and adds 68: 8 more (A.21).
- D59 (2.1, L6, 3.4, 3.9): one model per piece of running work, one observer per fact. Work of a
  Run with an open main run is main's alone and ends as main: U2's `stopping` entry with its owner
  runs, `deadlineAt`, step and restore, `settleSessionRuns` and the reactor's guards run whole, and
  the ledger holds no item of them; L1's OpenCode replacement or URL change also ends such Runs in
  the ledger, a ledger-only delta that changes no main event, row or provider call (section 9).
  The ledger owns only the deadline of the label work no main run holds, a wake execution or a
  send whose run main has ended: bounded by the one ledger stop deadline per session row, at the
  `stop.deadlineAt` of the Stop or Run now commit that opened it, ended by its own end (a Claude wake's `turn_ended` at its Stop's
  dispose, 8.3) and, for work no observer ended, by its `alarm_fired` as forced work-ended facts,
  and kept on the session row, so a restart needs no U2 restore (L6). Each fact the arm folds has one
  observer, named from the code: the write that writes main's terminal or status for it, or with
  none the write that ingests it (2.1 row 215). So a transmission is `run.dispatched` for a
  runner-held send and `run.requested` only for a direct one (3.4); `process_lost` is each
  write that first sets `retired_at`, in its transaction (6.5); OpenCode's is `onInstanceStopped`'s
  `settleSessionRuns` batch (9). This deletes 2.1 rows 203, 204 and 214, the stop's items, U2's
  wait on them, the failed-step end with its `absent:` case and 3.4's double fold. Reason:
  REDESIGN-10's three rounds each found the ledger's model of running work and main's disagreeing
  on what exists or who observed it: evidence main records with no event (round 1); writes the arm
  read with a second meaning, two transmissions and two `process_lost` writers (round 2); and
  items main's queries cannot see, a wake execution with no `provider_runs` row that
  `settleSessionRuns` never ends (`sessionRunOwnersQuery`, session-run-settlement.ts 27-59 at
  6c9ff950) and whose deadline U2's restore drops (`recovered`, provider-turn-service.ts 376-405
  at 1ba91324) (ub r3 F-A to F-D, F-F, poteto r3 F1, F3). With one model per piece of work no join
  is left to disagree, and the D59 spike, not a review, shows it builds (A.21). Rejected: round 3's
  narrow fixes (a second `stop_unconfirmed` writer, and U2's restore and the retire guard changed);
  every ledger item a main run (main's `provider_runs` readers would see wake rows); the ledger's
  model alone (two machines live per provider); U2's restore over the commit row (changes U2); no
  deadline (a hung wake fences for good); a retire the ledger issues (a second `end_session`
  writer); see A.21.
- D58 (3.9): the ledger lives inside main's writes. Every main unit runs whole (3.9's list),
  changed only where a 2.1 row names it. The ledger is one projector arm that runs `decide` and
  `evolve` in the transaction of the main write whose event it folds; the outbox rows of the
  effects main has no writer for, keyed, never inserted on replay and first inserted by 32.3 with
  their executors; and a view the unit a 2.1 row
  names reads in its own body, inside its write, before the statement it gates and after
  projecting any event that statement depends on. Outbox status stays main's, checked by T5's
  table (3.12). The arm appends no event, calls no main function
  and has no Layer, Tag, transaction or fiber. This replaces D57. Reason: seven redesigns in a
  row each kept a piece of main beside a replaced piece, and each cut split a unit that shares
  private state, a transaction or a status machine; REDESIGN-9's round 3 found `running` with no
  writer once the claim moved, calls into main's own `commit.write` from inside the ledger's
  that die as `NestedCommitAndSignal`, two writers of terminals, `run.started` and `input.sent`,
  and the Tag's closure-private `stopping` with two owners (ub r3 P1-1, P2-A, P2-C to P2-E,
  poteto r3 P1-1, P1-2, P2-1, P2-5). A cut at main's write bodies splits no unit, and the 32.2.19
  spike in R2's graph, not a review, shows it builds (A.20). Rejected: (a) round 3's narrow fixes
  to D57 and its table (each leaves the Tag split from its closure state and the claim from
  `running`); (b) provider-turn-service.ts replaced as one Layer (still splits the outbox status
  machine from the reactor's claim, and its in-commit calls nest); (c) the ledger below the Tag
  (two writers of each terminal with ingestion and the reactor); (d) alone, inside R2's engine
  only (covers the Stop, not ingestion, the reactor or recovery; kept as the pick's Stop half);
  (e) alone, a pure projection (cannot express the 2.1 rows, which change what main appends;
  kept as the pick's read half); (f) a full strangler per provider (rebuilds the reactor,
  dispatch and every `running` reader four times, two machines live during each); (g) narrowing
  to the label rules alone (they need the fence, the stop's items and lost work over every
  evidence kind, so little goes; its cut of the inbox parity work is kept); (h) a sidecar ledger
  committing after main's (two transactions for one fact); (i) the ledger as the event store's
  only writer (rewrites every unit's write body); (j) the outbox as the whole ledger (no row for
  label work, the fence or lost work); see A.20.
- D52 (3.6): a transmission is sealed at the first of these recorded facts, and at no other: it
  reached the agent; it has an outcome, a release or a receipt (a hold alone is not one; for a
  runner-held try, its `runner_reply`, its `delivery_indeterminate` marker and a journal answer
  other than `uncertain` are, 4.11); or its runner's `process_lost` is recorded with that stop
  commit's releases read first. A send is sealed when its latest transmission is, and one with none
  once a try of it ended before transmitting or its Run's Stop, Run now or `end` has committed. A retry
  issues only after an outcome or release sealed the latest transmission. A Run's unlaunch and
  end reason read each transmission's value as it stood at its seal: condition 2 needs every start
  and steer sealed, an unlaunch reads only a sealed never-handed-over value, and a later fact (a
  late release or acceptance) never unlaunches a Run or changes its reason, and after its end moves
  only its input (D53); `mayStillAct` and a retry pending read current chains (3.5), so an
  acceptance while the Run is active holds it as any acceptance does. Coverage still ends work
  at once (3.5), so every coverage waits the same way, for its own fact, with no deadline (a
  Stop seals through the `process_lost` of the write that first sets its runner's `retired_at`,
  6.5): an `end_session` for its
  runner's exit, an idle probe for the try's answer. Reason: three review rounds found
  Run ends and pauses that read the one test before the facts that fix it had arrived: a kill
  retirement before its stop commit's `Refused` release (A.11's wait, its own rule), an
  `end_session` success before the `exiting` release (`session ended` and a pause in one order, a
  silent relaunch in the other), and a pending kill ending Runs while H3 may still transmit their
  sends; each had a cause-keyed patch. A seal per send froze it at its first answered try, so a
  retryable try 1, an accepted try 2 at the cap and then `process_lost` ended `refused` where
  `process lost` was right. Main settles a send at its own answer and its runner's Gone
  (process-session-runner.ts at
  1ba91324, 3706-3713; provider-turn-session.ts 329-388). The idle probe gets no clause of its own:
  OpenCode's idle shows the session idle now, not that an unaccepted send cannot run
  (opencode-runtime-ingress-service.ts 972-1011, session-run-settlement.ts 69-76 at 1ba91324). A
  usage limit covers nothing: a same-driver failover keeps the runner and resumes the native
  session, and a cross-driver one ends it by its `end_session` (3.4). A pending kill gets none
  either: after the next `process_started` the feeder steps the same send again and may hold it (H3;
  runner-send-feeder.ts 214-245 in the split). REDESIGN-5 deleted the late mark a late release set
  for 4.8's re-send: after its Run's end it had no trigger, or re-sent past the pause a text already
  in the composer (A.15). Rejected: a wait per cause (A.11's kill wait plus one for session end, the
  reviewers' fix; it misses the pending kill and a covered send with no try); first event wins
  (arrival order is the defect); a clause per work-ended fact (each needs a host fact no runner
  gives); a seal per send (a retry in its execution changes its value after); a usage-limit
  failover as a session end (main resumes the native session, prepare-turn.ts 166, 185 at
  1ba91324); a seal that waits for Settle (Stop waits on the reaper, A.15); a seal on every reader (an
  acceptance while the Run is active would neither hold it nor withdraw its retry, poteto r1 P2-B);
  see A.14.
- D53 (3.9): an input's place is derived, never decided. An input is the latest Run's that
  reserved it, or that it joined as a Run Input, and reads only that Run's sends; a fact about an earlier
  Run's send is late evidence for that Run (12A). It is its Run's while that Run is active, tried
  again by 3.6, in the relaunched execution after an unlaunch. It leaves its Run only when its
  steer is declined, before or after that Run's end, returned by `steerDeclined`, or its send fails, once,
  at a permanent outcome other than a rejected resume or Stop's own, or past the cap: `failed`, its
  message shown once and its text back in the composer, final. Stop's own outcomes,
  `Refused{interrupted}` and NotConsumed{cancelled}, are never retried and never fail an input (a
  failed steer is a 2.1 row). Any other input whose Run has ended reads its sends' current value (3.6):
  reached, or possibly reached and not unconsumed, it stays with that Run, shown as sent, never
  re-sent; otherwise main's code places it from main's own events (3.9), with no
  error shown. Stop, Run now and every Run end place inputs by this rule, and main's module holds
  what they queue (D58). This replaces
  HEAD's automatic re-send at Run end of a message that never reached the agent (4.8), 3.9's list
  for a steer of a stopped Run and 4.5's re-send on a new Run of a late release's input, and moves
  3.9's declined steer and 4.8's failed send into it. Reason: REDESIGN-4's three review rounds
  found an input's place decided in nine clauses (3.6, 3.9, 4.8, 5.1, D52's late mark, 6.5, 7.3,
  F40, F51): a late release after `process_lost` had no trigger for its re-send, or re-sent past
  the pause while its text was back in the composer, and at Run end a start was re-sent where a
  steer of the same value returned to the inbox. Main re-queues a stopped Run's pending and
  retryable inputs at their admission positions and pauses (provider-turn-session.ts 329-388,
  session-inbox.ts 245-250, projectors-effect.ts 2479-2500 at 1ba91324), requeues a declined steer
  at the front unpaused (session-inbox.ts 575-600; projectors-effect.ts 2501-2521), and keeps a lost
  runner's possibly delivered message in the transcript, never re-sent
  (runner-turn-failure.ts 85-117; it requeues an unstarted steer with no message row, 75-84, a 2.1
  row, F38, F39), so a possibly reached input shown as sent matches main and an unreached one
  queued at its admission position is main's. Stop's own outcomes follow Stop, so neither arrival
  order may fail the input (poteto r1 P1-1). Rejected: a possibly seen input at the inbox front
  that advance skips (an exception in advance and a Run-now path, for a place main never uses, ub
  r1 P1-1, poteto r1 P1-2); see A.15.
- D54 (3.7, L6): label work has no clock, and a Stop's bound has one owner per piece of work
  (D59). Work of a Run with an open main run is main's `stopping` entry's, run whole: its owner
  runs, its deadline main's `deadlineAt`, the opening Stop's `requested_at` plus the interrupt
  budget (orchestration-engine.ts 739 at 6c9ff950), never moved, and one deadline step at that
  time, main's `retireProcess` (provider-turn-service.ts 251-284 at 1ba91324) gated by row 213,
  or for OpenCode `stop_unconfirmed` for its owners (286-292), whose terminals end those Runs'
  work. The label work open at a Stop or Run now commit (L6) with no open main run (a wake
  execution, an OpenCode abort with no owner run, a send whose run main has ended) is added to the
  session row's one ledger stop deadline, opened at the first such commit's `stop.deadlineAt`,
  adding moving no deadline, and ends by its own
  end, its coverage or the alarm's forced work-ended facts; work gained after a commit is bounded
  only by a later commit. A Run's end follows by 3.8. Runs, sends and wake executions feed it
  evidence and own none of it. This replaces HEAD's send cleanup, which had no time (3.7), the late
  acceptance's Tombstone cleanup (3.8), 5.1's forced close and second deadline, round 16's wake
  deadline (E2), the Run's own interrupt deadline with condition 3, and REDESIGN-6's work episode
  with its column, `closeMs` and exhaustion. Reason: each redesign gave what a Stop leaves on a
  label a new holder (a Run's phase, a send's cleanup, a wake, a Tombstone cleanup, a forced close,
  a scope end, an episode, the stop's items), and each holder's anchor or re-arm gave two outcomes
  for one arrival order: REDESIGN-6 r3 found a kill up to 60 s after Stop because a Run end
  re-anchored the budget (ub r3 P1-A, poteto r3 P2-2), a probe cap ending probes other than the
  Stop's (ub r3 P2-C), and a Run-less end with no deadline (poteto r3 P2-1); REDESIGN-10 r3 found
  the stop's items invisible to main's settlement and restore (D59). Main has the same one owner
  for its runs: its `stopping` entry per session, holding only its Stop's owner runs
  (`snapshot.owners`, provider-turn-service.ts 207-222 at 1ba91324; done at once with none and a
  kept steer, 213; the membership is a 2.1 row), joined by later Stops (provider-turn-service.ts
  363-374 at 1ba91324), with one deadline that retires the process for every runner-backed
  provider (251-284) or ends its Stop's owner runs `stop_unconfirmed` and lifts (286-313;
  session-run-settlement.ts 68-72), and whose entry ends as L6 End cites, so the next Stop starts
  a new one. Main bounds no work before a Stop (claude-runner-payload.ts 2235-2245, 2413-2414;
  provider-turn-dispatch.ts 970-976, session-overrides-state.ts 62), so neither does L6. Main's
  one Starting bound, its 2-minute intake recall, fails a start its runtime has not taken in
  (orchestration-side-effect-reactor.ts 790-830, 1945-1975); the fence issues a start only once no
  label has work, so the contract has none. Rejected: every execution a Run (two active Runs,
  A.15); a Run's end waiting for its labels (a Claude Run would wait for the next turn); the runner
  host owning work after a Run ends (two owners of the fence); a deadline per label or episode
  (A.16; its re-anchor is ub r3 P1-A); a later Stop moving the deadline (main joins the first);
  the deadline holding only what its first commit named, as main's join (a Stop pressed while it
  is open would do nothing for a wake started since, and the user would press again after the
  deadline; adding moves no deadline); a Run as an item (its end lags its work's, poteto
  REDESIGN-7 r2 P1-1, ub r2 P2-A); the stop's items beside main's entry (REDESIGN-10's form: a
  wake execution has no `provider_runs` row, so main's settlement never ends it and U2's restore
  drops its deadline, ub R10 r3 F-B, F-C, poteto r3 F1).
- D55 (3.9): `cancel_input` withdraws only an input no Run holds: main's Cancel arm removes it,
  final, with no message and no pause; any other is Rejected, `already started`. Reason: no rule
  said what state it produced, and the code's `Declined{cancelled}` became a send failure when 3.13
  renamed `Declined` to `Failed` (poteto r3 P2-2); main cancels only a queued inbox input and
  refuses the rest `already started` (session-inbox.ts 286-293 at 1ba91324 and 6c9ff950). Rejected:
  withdrawing an unaccepted steer (its later acceptance needs `Accepted{cancelled}`, a value no rule
  reads); Cancelled as a Failed reason (a failure message for the user's own withdrawal).
- D56 (2.1, header): main's code at 1ba91324 is the reference for every user-visible behaviour
  main has. A claim about main is a citation with a backticked anchor from the cited lines; a rule
  equal to main says "as main" and cites it; each difference is a row of 2.1 with its reason and
  ticket, and nothing else differs. Core state no user sees (durable Runs, the seal, the fence,
  coverage) is normative; each user-visible effect of it is a row of 2.1. Reason:
  REDESIGN-4 to -7 each ended with findings that a copy of main or of a rule had not moved with
  its source (R7: about 8 of 21 in the record of main, about 10 stale readers), and only prose
  review compared the copies; a citation can be checked (A.18 T1) and main's code can be run
  (A.19 T2, the replay at the provider wire). Rejected: a cited prose model of main as the reference (R7 M9, M11: complete only
  as far as its author read); recorded wire traces as the reference (needs live providers, A.18);
  the ledger owning inputs and Runs only (two owners of the fence, and OpenCode has no runner
  host).
- Amends SEND-SCOPE-5 S9.3 (Q25 = E; 3.9, 4.8, 5.1): by D53 an input whose Run ended, Stop
  included, and that did not reach the agent returns to the inbox behind the pause, placed by
  main's code from main's own events (D58), neither to the composer nor re-sent on a new Run; only a
  failed send returns its text to the composer. It is sent by main's inbox (D58; the user's decision
  of 2026-10-30). Reason: main re-queues a stopped Run's inputs (provider-turn-session.ts 329-388 at
  1ba91324), and two places for one value was the defect (A.15). Rejected: the composer for a
  stopped start (a start and a steer of one Stop in two places). S9.3 was a user decision: the user
  ratified this amendment on 2026-10-30.
- Amends D50 (3.5, 3.6, 3.8): reaching the agent is one test with three values, never handed over,
  reached and possibly reached; a send with no transmission is never handed over; a send is
  unconsumed when it possibly reached and each of its possibly reached transmissions is unconsumed
  (3.6). Only a sealed never-handed-over value makes a Launched Run not yet delivered and unlaunches
  it: a try that never left conduit, a release, or a rejected resume, whatever its coverage or
  authority (3.6, D52); a wake execution never makes it delivered (8.3). The unlaunch ends its
  dropped issue's Run Effect, and the relaunch issues a new one under the same `commandId` and Run,
  so a hold of the dropped issue finds no owner send and returns `Ended` and the feeder drops it
  (4.3). Coverage and a drop are work-ended
  facts only (3.5). A Run ends by one rule (3.8): at its Run-end evidence with authority; when
  every start and steer of its execution is sealed, no send of it may still act or has a retry
  pending, and none of its own executions still acts (3.8 condition 2). Its reason follows the
  condition: condition 1 takes the fold; condition 2 takes `interrupted` if Stop, Run now or `end` asked,
  else `refused (first code)` if each send is never handed over or unconsumed and one has a
  permanent outcome other than a rejected resume or reached the cap, else the covering cause of a
  send that reached or possibly reached the agent, else the fold (REDESIGN-7 deleted the Run's
  deadline and `deadline expired`, A.17). This deletes round 16's Refused bullet, the per-cause ends of
  retirement, session end, session-scoped failures and removal, the native-policy Run-end bullet of
  3.6, and 3.5's coverage-beats-own. Reason: D50 unlaunched on a retryable outcome, which a later
  acceptance beats (3.5), so the unlaunch did not commute with it and LI2 failed on all four
  providers; reading coverage as delivery unlaunched Runs the agent had accepted; several causes
  ended the Run in one decision with different inputs; reasons keyed by cause ended a completed Run
  `interrupted` and a possibly reached one `refused`; a bare `refused` after a withdrawn retry
  showed a refusal for nothing lost; and a hold in the unlaunch window bound to a dropped issue, so
  a transmission the relaunch repeated could deliver twice. At 6c9ff950 a row that is not
  `running` gives `Ended` (runner-retirement.ts 178) and no ended row is reopened
  (orchestration-side-effect-reactor.ts 1337, 1372), so the relaunch is a new Effect, not the
  dropped one's row finished and reused. Rejected: the late acceptance revives the dropped
  execution (a Queued Run with acting work, and a second relaunch rule); coverage as never handed
  over (it says the address retired, not that the host kept the input); an end clause per cause
  (round 16's first two drafts); one priority list for every condition (a Stop's fallback beats a
  result); binding the hold to the relaunch (it has not issued, so no token exists); a dropped
  issue's own `Covered` (a second coverage source beside `stopCovers`, and a step that contradicts
  `holdRun`'s own order); the unlaunch finishing the dropped issue's row for its relaunch (a
  finished row is never reopened).
- Amends SPEC (Stop that always stops, 5.1): Stop or Run now withdraws every pending retry, asks
  for the Run's end, and adds the Run's owner runs to main's `stopping` entry and every label's
  other work to the ledger stop deadline (L6, D59), naming
  what it adds in `interrupt_turn`, with or without an active Run (4.6, L6); the stop's deadline
  is its first commit plus the interrupt budget, as main joins later Stops to the first; a Run not
  yet delivered ends `interrupted` at once, with no effect, as its sends are sealed when the Stop
  commits (D52); otherwise the Run goes to Interrupting, which issues no retry, and 3.8 ends it. A
  result recorded with authority still ends it by the fold (3.8 condition 1). At the stop's
  deadline U2's step (L6) retires each runner of its owner runs, or for OpenCode ends them
  `stop_unconfirmed`, and the ledger's alarm ends the label work no main run holds and no observer ended (L6, D59), so
  the stop ends at its deadline at the latest and the Run by 3.8, in place of the Run's own close
  and second deadline, so a wake on the
  label gets no second one (ub r3 N1) and no step closes first; main retires the process at the
  Stop deadline for every runner-backed provider, Cursor included, with no close
  (provider-turn-service.ts 251-284 at 1ba91324), and ends its Stop's owner runs
  `stop_unconfirmed` and lifts (286-313). Its inputs follow
  their place (D53), as main re-queues them. Reason: main interrupts the turn in flight, or
  disposes the query when no run is captured (claude-runner-payload.ts 2820-2833 at 1ba91324), so
  a steer past its Run's result is stopped, which naming only the cohort and wake labels missed
  (ub r1 P1-A, poteto r1 P1-A); main's `prepareStop` returns a send waiting on
  its retry at once and deletes the retry (provider-turn-session.ts at 1ba91324, 329-388), the
  earlier rule waited 30 s for nothing and let the retry fire after Stop, and main's first terminal
  event wins (projectors-effect.ts 1737-1756), so a completed turn is not shown stopped. Rejected:
  Interrupting for every Run with a send (a 30 s wait and a retry the user stopped); `interrupted`
  over a result (a completed turn shown stopped); naming a label by `querySeq` alone (a late
  interrupt could stop a newer turn on a persistent Claude query, ub r1).
- Amends A.11 (L1, L2, 3.3): retiring covers sends and ends wake executions but moves no Run; a
  Run moves once its sends are sealed (D52), and a stop commit's releases ride on its
  `process_lost`, read first. A pending kill covers the sends it reached without ending or
  unlaunching their Runs; one held on the process it reached is sealed with that runner. This
  deletes L1's kill-retirement wait and condition 2's retirement clause. Reason: the kill retired
  the runner before its stop commit, so a start the commit then released `Refused` had already
  ended `process lost`, and under H3 a pending kill's covered send may still be transmitted.
  Rejected: ending at retirement and reviving on the release (a second relaunch rule).
- Amends model-gaps (start mode, 3.4, 4.8): the native session ends at a session end (an
  `end_session` success, `session_ended{native_session_vanished}`, unbuilt, or a rejected resume;
  a usage limit is none, 3.4), with the coverage and `fresh` admission 3.4 states: an
  `end_session` success covering the sends issued before that `end_session`, and admission issuing
  `fresh` from the `end_session`'s issue. Its Runs end or unlaunch by 3.8 once their sends are
  sealed (D52), so both arrival orders of an `end_session` success and its runner's `exiting`
  release unlaunch a Run not yet delivered. Reason: 3.4 said both that coverage reads only sends
  issued before and that session end covers sends after the `end_session`; a start resumed into an
  ended native session cost a `ResumeRejected` round trip; and a start issued while the
  `end_session` was in flight was covered by its success, so its Run ended `session ended` and
  paused while the agent ran it, where main holds admission for the whole end
  (process-session-runner.ts 3229-3235, 3514 at 1ba91324). Rejected: covering sends issued after
  the `end_session` (a start the agent may run while the ledger says nothing can act); admission
  waiting for the `end_session` (a stall on a Run-less command).
- Amends SEND-SCOPE-5 S9.4 (the resume fallback, 3.4, 4.8): a rejected resume is a session end.
  On a Run not yet delivered it unlaunches and relaunches `fresh`, as before; after a
  transmission that possibly reached the agent the Run ends `session ended` and its input follows
  its place (D53), its next start `fresh`. Reason: the same host fact relaunched `fresh` on a
  first try and failed the Run with another code on a retry, in a native session already gone.
  Rejected: a `fresh` retry in the same execution (a new native session under an execution that
  may have acted in the old one).
- Amends model-gaps (`input_absent`, section 9): `input_absent` after `delivery_unknown` ends
  probing for that transmission and leaves it unconsumed, so a later acceptance beats it, and the
  send is tried again, a new transmission of its Run (3.4, 3.6). Reason: "final" there meant no more probes, while
  3.6 used it for delivery. Rejected: final for delivery (an absent finding the agent then accepts
  would unlaunch a Run that ran).
- Amends 4.8 (SEND-SCOPE-5 S9, F79): in the ledger chain a retryable outcome, an absent finding
  or a release of a runner-held transmission that left conduit is tried again, a new transmission
  of the same ledger Run whatever main's runId (3.4, REDESIGN-10 r2), while its Run is active, as a direct one is, with a retry pending until acceptance, Stop,
  coverage, its Run's end or the cap withdraws it (3.6). A host `Refused` release is a fact about
  its transmission, NotConsumed{released}, never a decline, and permanent only as `interrupted`. A
  transient refusal or a start's decline is tried again up to the cap, by its relaunch while its
  Run is not yet delivered, otherwise as a new transmission of it; a declined steer's input leaves its Run
  (D53); a `delivery_unknown` input is never re-sent. Send Settlement, main's at every
  ticket, still ends the run and re-sends on a fresh run. Reason: `holdRun` binds the re-send as
  transmission `n + 1` of the same run (4.3), so no host fact forbids it; a fresh Run re-sent an
  input a late acceptance then delivered twice; and a refused start below the cap showed `refused`
  then re-sent, where main retries a runner's idle exit before `turn.accepted` silently
  (process-session-runner.ts at 1ba91324, 3706-3713). Retrying a start's decline is a product
  choice (producers as 4.8). Stop's own outcomes, `Refused{interrupted}` and NotConsumed{cancelled}
  (Claude's `cancelled` before `started`), are never retried, as main ends them `interrupted`. An input queued again keeps
  its `commandId`, and the cap counts within its input's reservation, from its latest `input.sent`, which `holdRun` reads (32.29); main
  caps no send (4.8). A connection's first `retiring` refusal releases, in its stop
  commit, every transmission written on it with no acceptance read before (4.5, 4.6), so F30 and
  F40 relaunch silently, as main does. Rejected: the fresh Run in the ledger chain (two owners of the re-send); a decline ending the Run
  below the cap (a shown refusal for nothing lost); retrying a steer's decline as a steer (main
  requeues it); a `Refused` release read as a decline (a refused steer then had two answers, the
  inbox and a retry in its execution); the cap across Runs (a re-queued input failed sooner than
  on main, ub r1 P1-6); the reservation as a new `runId` (a fresh host run is one too, poteto r2
  F3); Claude's `cancelled` as a decline (a declined start was retried and a declined steer queued
  unpaused, ub r2 F-F).
- Amends D47 (8.3, 3.6, 3.7, 3.8, 9): an unsolicited `turn_started` starts a wake execution, its
  label's work (L6), never a user Run's, with one end rule, its wake Run and its reading by an
  active user Run as 8.3 states. This replaces D47's join (a joined Run had reached the
  agent and never unlaunched) and deletes round 16's joined wake in condition 2, its Running-clock
  reader and its cleanup through its Run's Tombstone. Reason: review round 3 found a Starting Run
  ended `deadline expired` while its joined wake worked, a wake joining a Queued Run so that
  arrival order decided the unlaunch (LI2), and a cleanup worded for a wake Run only. The fence
  holds a start behind it (9), so no start meets the session it keeps busy, and D47's OpenCode
  example cannot occur, as OpenCode queues steers and never declines (provider-instance.ts
  165-168 at 1ba91324; its composer never offers a steer, InputArea.svelte 470). Rejected: the joined turn marking the start Observed (D47's own rejection
  stands); wakes as full Runs (two active Runs, A.15); a joined wake as its Run's work (the three
  findings above); no bound even from a Stop (an unbounded fence, as HEAD's 8.3 held it until
  session end); a wake deadline of its own beside the stop's (two deadlines on one label, ub r1
  P2-3, poteto r1 P2-C, ub r3 N1); Stop making a deadline due at once (a kill where the graceful
  interrupt suffices); activity extending the deadline after Stop (a streaming wake never stopped,
  poteto r2 F1); a `close` issue ending the wake (the fence released onto a query still writing,
  ub r3 N1).
- Amends D43 (8.4): a gated step of the stop's deadline step is dropped when the stop ends, at
  its owner runs' end (L6), as a Run's is at its end: what ends drops what it owns (E1). Reason: a
  step gated at the deadline would otherwise outlive the work and kill the user Run the fence
  released onto that query (poteto r1 P1-3, ub r1 P2-4). Rejected: none.
- Amends D2 (section 9, 3.7, 3.8): a fence member leaves at its own work ended (3.5), so a Claude
  send leaves at a result naming its input and a Claude wake at its end (8.3); the
  `resultReleasesFence` column goes, and a member restored by a late acceptance is its label's
  work (L6), with no Tombstone cleanup. Reason: 32.2.14 decided "no" for Claude to mean a result does not
  release the queued inputs it does not name (c9507a08); integration round 2 (a1473a01) read it as
  holding the named member itself until `query_ended` and added D2 to bound that hold. No SDK
  behaviour needs it: after a result the named input gets only its `completed` answer, and later
  turns belong to queued inputs that are members by their own sends (claude-sdk-traces
  steer-misses-boundary.jsonl 136-138, 154-155, second-input-held-to-turn-end.jsonl 40-43, 54).
  The hold made every next start wait `settleMs` and close the live query, where main enqueues into
  it and goes idle at the result (claude-runner-payload.ts 1853, 2413-2414 at 1ba91324), and gave a
  Claude wake a second cleanup and stop sequence (ub r2 F-A, poteto r2 F2). Rejected: one result
  cleanup per label (keeps a hold nothing needs, poteto r2 F2); Claude releasing on a result for
  inputs it does not name (32.2.14's rejection stands).
- Amends D25 (8.3, 9): a Claude wake execution ends, and leaves the fence, at a result naming no
  send's input uuid or its label's `query_ended`, whichever is first. Reason: D25 held it to
  `query_ended` only through the result-held rule (D2 amended), and a stream that ends with no
  result still ends the wake (ub r2 F-B). Rejected: none.
- Amends D28 (8.3, 8.4): an execution still outstanding when its wake Run ends is its label's
  work, with no clock until a Stop adds it to the ledger stop deadline (L6), and no Tombstone cleanup covers it. Reason: the
  Tombstone cleanup expiry and the execution's own deadline gave the left label two stop
  sequences and two confirms (ub r2 F-B). Rejected: none.
- Amends 5C (the outcome fold, 3.8): a `delivery_unknown` outcome folds as a failure, code
  `delivery_indeterminate`, as Send Settlement ends it (4.7). Reason: the fold had no rank for
  it, so a Run ended by condition 2 with one possibly reached send fell to the refused reason.
  Rejected: `refused` (the agent may have read it).
- Amends D48 (3.11): a refused start ends its Run `refused (project_inactive)`, which pauses the
  inbox (D58), so queued input waits instead of each meeting the same refusal.
  Reason: main ends such a run `error`, which pauses. Rejected: draining the inbox into refusals
  (each queued message shown failed for one removal).
- Amends OW Decision 3 (3.4): a `result` naming no input is its label's outstanding wake
  execution's, and only with none each start and steer that has `started` on that query and no
  result yet, whose work and Runs it ends (3.8 condition 1, 9; poteto r1 P2-C, ub r2 P2-6,
  poteto r2 P2-2). Reason: a Claude wake's
  uuid-less result read as late evidence for the latest start, left the wake outstanding to its
  deadline and closed a live query (poteto r3 P2-1); main ends the wake turn then, and the current
  run when there is one, with every send folded into it (claude-runner-payload.ts 1830-1834,
  2262-2297 at 1ba91324). Rejected: a uuid-less result always unsolicited (a Run whose own result
  lacks a uuid would wait for the user's Stop, where main ends it); only the latest start or steer
  (a start whose steer folded into its turn kept the fence, ub r2 P2-6).
- Amends SPEC (Deadlines as data, 3.7): a send's cleanup has no deadline; its work is label work,
  which only the stop bounds (L6, D54), and Starting, Running and an Interrupting Run have no
  deadline of their own, an Interrupting one with work under the stop showing its `deadlineAt` (3.7, D54). Reason: the cleanup had no stated time (poteto r3
  P2-3), and a clock before a Stop closed a long or silent turn main never ends (ub r1 P1-C, ub r2
  P2-1). Rejected: the send's issue plus settle (the oracle's reading; it closes a long steer turn
  mid-work, which main never does); a liveness budget paused while an interaction is Pending
  (review round 1's rule: a clock main lacks, with an exception for questions, ub r2 P2-1).
- Amends SPEC (Tombstones, 3.8): a late acceptance restores its send's work to its label (L6,
  D54), with no cleanup at the Tombstone time plus settle. Reason: an acceptance later than that
  made the cleanup due at once and closed a label a newer Run used (poteto r3 P2-3). Rejected:
  none.
- Amends 82tn.32.2.14 (section 9, 3.7): an OpenCode abort whose delivery is unknown also leaves
  the fence at the stop's deadline, by U2's `stop_unconfirmed` terminals for its owner runs and the
  ledger's alarm for an abort with none, the commit's own abort and `cancel_request` included (L6,
  D59), so its Runs end (3.8) and a Queued Run the stop blocks launches; a probe
  answered `native_busy` is re-probed under the cap, and past it ends with no finding (3.7).
  Reason: HEAD kept it a member until `native_idle`, so OpenCode busy through five probes fenced
  the instance's one label until the instance restarted (poteto r1 P1-B); main ends its runs
  `stop_unconfirmed` and lifts at the Stop deadline (provider-turn-service.ts 286-313 at
  1ba91324). Rejected: re-arming a probe column per later Run (D54); the lift at the probe cap
  (past main's 30 s, and it ended probes other than the Stop's, ub r3 P2-C).
- Amends OPEN-5 (4.6): `interrupt_turn` carries `payload.stop.owners` as runIds only; the host
  interrupts the turn running at receipt, unless it is a newer run's `send-turn`, and each named
  run's accepted, unstarted commands, and nothing later; label work ends through the ledger's
  probe or the stop's deadline step (L6). REDESIGN-10 review round 1 dropped the labels, a
  provider-call difference no 2.1 row names (poteto r1 P2-9). Reason:
  REDESIGN-6's mode, every turn on the query until an unrecorded run's `send-turn`, interrupted a
  background wake that started after the stopped work had ended and paused the inbox (ub r3 P1-B,
  poteto r3 P1-2); main clears its interrupt at the interrupted turn's result
  (claude-runner-payload.ts 2420 at 1ba91324) and recalls an unplaced input (2958-2972).
  Rejected: a host-minted turn id on the wire (a new identity, A.16 r2-b); interrupting only the
  running turn (a named run's accepted steer would start after it, stopped by nothing until the
  deadline step); naming labels (a wire difference from main with no 2.1 row).
- Amends FB §4 and RULINGS R2 (3.10): a Stop or Run now commit (L6) resolves every interaction
  Pending on a label it adds to the stop unless a `deliver_answer` of it may still act, a
  permission rejected and a question with no answers; an answer, in a stop or not, resolves its
  interaction at its delivery's confirmation or the host's own resolution, whichever comes first,
  or else when its delivery ends with no confirmation (its work ends or its probe ends past the
  cap); an async question (`delivery: async`) is never
  resolved by a commit, retirement or session end; and delivery never holds a Run open. Reason: Stop left an interaction Pending until retirement or
  session end where main rejects it at interrupt (claude-runner-payload.ts 2351, 2997-3002,
  3024-3034 at 1ba91324; poteto r3 P1-1, ub r3 P3-3), and a Run held open for delivery was a
  second owner of Run end (poteto r3 P2-5); rejecting an answer in delivery made two answer
  decisions, where main cancels only unanswered ones (pending-interaction-service.ts 400-415,
  449-500; claude-runner-payload.ts 2995-3034), and main never cancels an async question
  (pending-interaction-service.ts 481, retire-pending-prompts.ts 39 at 1ba91324; REDESIGN-7 r1
  ub P1-2, poteto P2-3); a refused answer, or one unknown past its probe cap, stayed Pending with
  no end, so the user could not answer again, where main deletes the entry when the answer is
  taken (pending-interaction-service.ts 400-417, 419-430; REDESIGN-7 r2 poteto P1-2, ub P2-C).
  Rejected: waiting for the host's native cancellation as evidence (an
  answer the user gives in between would be delivered to a stopped turn).
- Amends HLK 10B (3.10): a refused answer keeps its interaction Pending with `lastRefusal` only
  while its delivery retries; a permanent refusal or the cap ends that delivery, which resolves
  the interaction (3.10). Reason: the FB §4 amendment above. Rejected: Pending for a new answer
  (a second answer decision, where the first wins, 3.10).
- Amends D4 (8.4): a Run-less `end_session` is main's control, run whole, addressed where it went
  (D32); the ledger neither holds nor escalates it, and its commit opens no ledger stop deadline,
  since it commits `stop: null` (`requestedPayload`, orchestration-command-commit.ts 58-63 at 6c9ff950); label work
  open at it ends by its own end or coverage, as main (L6, D59). Reason: HEAD's escalation read an `end_session` deadline that
  REDESIGN-6 deleted (poteto r3 P2-1), and main retries a control to its cap and never escalates
  it (`maxControlAttempts`, orchestration-side-effect-reactor.ts 1216 at 1ba91324). Rejected: a
  deadline of the send's own (a second clock beside the stop's); the stop's deadline step
  escalating it (an item main's settlement cannot see, D59).
- Amends D1 (3.3): `close` is gone, so query end covers only runner-held `interrupt`. Reason: its
  readers were a column step, an escalation and a scope end, each now the stop's deadline step or
  a label becoming older (L5); main has no close before its kill (provider-turn-service.ts 251-284
  at 1ba91324). Rejected: keeping `close` for Codex (a 5 s step main lacks, past its 30 s).
- Amends SPEC (One active run, 3.9): a message sent while `stopping` holds is decided by main's
  inbox (D58). Reason: a steer into an Interrupting Run gave the stop work it never stepped (ub
  REDESIGN-7 r1 P1-1 trace A). Rejected: none.
- Amends HLK 9B (3.9, Q9): Resume is main's inbox's (D58). Reason: D56. Rejected: none.
- Amends AUDIT-2 Other changes (wake admission) (3.9): admission during a wake Run is main's
  inbox's (D58), and a start it hands off during a wake waits on the fence (9, 2.1 row 202).
  Reason: D56. Rejected: none.
- Amends SPEC (Schema, 3.12): there is no Run Effects table; the outbox is the Run Effects store,
  its status machine main's, checked by T5's table, with no per-provider switch or backfill
  (D58). Reason: the switch moved `running` away from `markRunning`, its one writer, and split
  the claim from dispatch (ub R9 r3 P2-C, poteto r3 P1-2). Rejected: the table beside the outbox
  (two status machines for one effect).
- Amends OPEN-3 (5.4): the ledger does not replace the Stop cohort; `stopCovers`,
  `payload.stop.owners`, run joining, steer-declined reservations and `joined_into` stay main's,
  and the arm folds them (D58). Reason: the reactor, runner retirement and main's `stopping`
  wait read them, so deleting them split three units. Rejected: OPEN-3's A (above).
- Amends D53 (3.9): a steer that outlives its Run (its Run's end leaves it unconsumed, not
  declined or failed) stays where main's projectors leave it, `steering`, and is a Run of its own,
  ended by 3.8 from its own evidence (3.9). Reason: main runs it as its own turn while the session
  stays busy (claude-runner-payload.ts 2532-2539, provider-turn-session.ts 301-303 at 1ba91324),
  and REDESIGN-8 ended it at its Run's end, so its Run had no owner (ub r3 P1-1, poteto r3 P1-1);
  review round 1 widened it from a `completed` end to every such end (ub r1 P1-3, P1-4, poteto r1
  P1-1). Rejected: placing it by its Run's end (main queues no such steer);
  joining it to the ended Run (a Run that runs after its end).

**Decided (build round 1, 2026-10-31)**

Eleven gaps from the 32.2.2 model lane (M1 to M7) and the 32.2.4 harness lane (G1 to G4), found
building against REDESIGN-11 with its review round 1 fixes. M7 and G1 are one gap. Three are
decided by the text as it stood: M5, since 82tn.32.33 owns servers and 32.33.1 builds their
evidence and projection, so 8.2 and 12.2 now point there and 3.13 gains nothing; G3, since D47's
amendment made a wake execution its label's work and never a user Run's, so an unlaunch drops only
its Run's sends and the wake keeps fencing the relaunch (3.6, LI1); G4, since every fact that
unlaunches says its try was never handed over, so a truthful fake never also accepts it and LI2
needs no new allowance (11.2, D52). The stale readers it fixes count nothing: 3.12's and
4.7's `ctx.replaying`, 3.6's deadline kind and 3.13's `not_sent` comment. None came from a new generator
input kind; G1 and G2 need two the generator lacks: main's run events as `Main` observations
(`run_requested` direct and not, `run_started` joining and starting a steer's own Run, a main
terminal with no provider evidence such as OpenCode's `stop_unconfirmed`), and a Run now whose
commit opens the ledger stop deadline at its `deadlineAt`.
Build round 1 (contract, after redesign 11): 1 new decision, 5 amend earlier ones, 0 came from new
generator input kinds. Against HEAD, a replaced rule counting as one deletion and one addition, a
move or a restatement as neither and a new reader or exception as an addition, it deletes 60 rules
and adds 69: 9 more (A.21).
- D60 (3.4, 3.13): main's run events the arm folds, `run.requested`, `run.started` and main's
  terminals, enter decide as one Observation member, `Main`, named by main's event id, a repeat
  Accepted with no events; `run.dispatched` and `run.released` stay hold-fact Answers (4.11).
  Decide issues only `probe`, `stop_task` and `cancel_request`, each Tokened; a start or steer
  main dispatched shows in `live` as Held, with no token (3.12). Reason: 3.4 and 3.9 fold these
  events, but `LedgerCommand` had no input for them, so the public interface could not drive how a
  start or steer enters `live` (G1, M7). Rejected: a `LedgerCommand` verb per event (a verb
  each for one fold); the harness's `commandId` on `run_requested` (main's payload is `runId`
  and `inputId`, stored-event.ts 687-689 at 6c9ff950).
- Amends AUDIT-2 T7 (3.4, 3.13): a Send Token carries no kind, and an answer of a kind its send
  cannot produce is Rejected by decide with a diagnostic, as 3.4 already ruled; the type does not
  check it. Reason: the model types every answer as `Evidence` (M1). Rejected: a token branded by
  kind (a generic threaded through every host call for a check decide already makes).
- Amends D54 (3.2): the provider policy holds no stop rule; the stop's deadline step is U2's and
  the alarm is the same for every provider (L6). Reason: 3.2 still named the step a policy rule
  after D59 (M2). Rejected: none.
- Amends D59 (3.7, 3.13): a `Stop` deadline's target is its session row and carries no field, and
  `run_now` carries `deadlineAt: number | null`, as `stop` and `end`, since a Run now commit opens
  the ledger stop deadline (L6). Reason: the target was unnamed (M3) and the input lacked the
  value L6 reads (G2). Rejected: none.
- Amends D50 (3.6, 3.7, 3.13): after an unlaunch a Queued Run shows the unlaunching outcome's
  `retryAt`, when it has one, as a view field, no Deadline and no owner. Reason: 3.7 named the
  start's retry, and no owner covers it (M4). Rejected: a `Send`-owned deadline shown and never
  fired (3.7: a send's retry is not a ledger deadline).
- Amends D43 (8.4, 3.13): `PendingConfirm.step` is `retire` or `end_session`; a restart is a
  retire, then main's relaunch. Reason: 3.13 named no step values, and no effect is a restart (M6).
  Rejected: a `restart` step (a step no effect issues).

**Decided (build round 2, 2026-10-31)**

Twelve gaps from the 32.2.4 harness lane (G5 to G8) and the 32.2.3 oracle lane (GAP 2 to GAP 9),
found building against D60. GAP 9 and G5 are one gap. One is decided by the text as it stood: G8,
since 3.4 rejects evidence of a kind its provider cannot produce and row 215 gives `turn_ended`
one observer, a Claude wake's payload; a Codex wake ends at its result (codex-turn-lifecycle.ts
331-353 at 6c9ff950), Cursor starts no unsolicited turn (9) and OpenCode's wake ends at a covering
idle probe (D26), so 3.4's list now names it and a non-Claude `turn_ended` is Rejected, not ended.
The stale readers it fixes count nothing: 8.5's issue, D17's entry and 3.6's advance. G5, G6 and
G7 came from the new `Main` generator kinds and G8 from the `turn_ended` kind; the oracle's eight
came from catalogue scenarios and contract tests.
Build round 2 (contract, after redesign 11): 0 new decisions, 10 amend earlier ones, 4 came from
new generator input kinds. Against HEAD, a replaced rule counting as one deletion and one addition,
a move or a restatement as neither and a new reader or exception as an addition, it deletes 63
rules and adds 78: 15 more (A.21).
- Amends D60 (3.4, 3.13): `run_dispatched` carries main's `runId`, which names the Run, and its
  `commandId` names the issue in that Run, the start or steer of the input whose id it is; each
  transmission of a `Held` issue gets its token from its `run.dispatched` (G5, GAP 9). Reason:
  the Observation dropped the stored event's `runId` (stored-event.ts 690-696; runner-retirement.ts
  270-282 at 6c9ff950), so nothing bound a hold to its Run. Rejected: a ledger `commandId` map (a
  second store of main's binding); binding by `commandId` alone (a joined steer's hold names its
  owner's Run).
- Amends D60 (2, 3.4, 3.6, 3.13, 4.11): a user Run's id is main's, the `runId` of the
  `run.requested` that reserves it, and the Run is reserved there, never at admit; a later
  `run.requested` for an input its Run holds names that Run; `ctx.newId` mints only a wake Run's
  id and the tokens of effects with no hold other than a direct start (G7). Reason: main mints the
  run and appends `run.requested` after `input.sent` in one write (orchestration-command-commit.ts
  206-239, 308-310 at 6c9ff950), and nothing said who names a Run. Rejected: a ledger-minted Run
  id (a second name for main's run, which every Main observation would need mapped).
- Amends LI1 and LI6 (11.2, 8.5): a start and a native command are read from `live`, as main
  issues them (D60; G6). Reason: both rows expected decide to issue them. Rejected: none.
- Amends D20 (3.7, 3.13): a send's Unknown outcome opens its recovery probe's deadline, owner
  Send, at that outcome plus `probeMs`; it fires unless the send is Observed, Accepted or ended
  (GAP 2). Reason: no deadline opened the first recovery probe, and none may issue at the outcome.
  Rejected: a probe at the outcome (3.6 forbids it).
- Amends the SPEC Stop (5.1, 3.6): OpenCode's Stop decision issues `cancel_request` and `probe
  native_session` together, the probe's deadline from that issue; main issues the abort (GAP 3).
  Reason: 3.6 allowed a probe only at a deadline. Rejected: a probe after the abort's outcome
  (the abort is main's, and its outcome may never come).
- Amends HLK 11A (3.6): past Settling's deadline a Run shows Running, with no deadline, until its
  probe's finding or its end (GAP 4). Reason: Settling needs a Run deadline, and the expired one
  left no view. Rejected: an optional Settling deadline (a type change for one state).
- Amends 5C (3.8): condition 2's last end reason, with no result, is main's terminal for the Run's
  run, `error` read as `provider_error`, and with neither, `completed` (GAP 5). Reason: main ends a
  turn with no result as an error (claude-runner-payload.ts 2120-2126, codex-runner-payload.ts
  878-892, cursor-runner-payload.ts 922-932 at 6c9ff950), and an empty fold had no reading.
  Rejected: `completed` for every Run (the oracle's reading, which differs from main).
- Amends D59 (9): a Claude, Codex or Cursor interrupt is no fence member, and its work ends when
  every Run it names has ended, at once when it names none (GAP 6). Reason: the table gave it no
  rule. Rejected: none.
- Amends RULINGS R2 (3.7, 3.10, 3.13): a permission's timeout is main's, and the ledger holds no
  timeout deadline; `timeoutAt` and the `Interaction` deadline owner are deleted (GAP 7). Reason:
  under D60 decide issues no answer, and main already times permissions out and answers them
  (timer-wiring.ts 20-40; pending-interaction-service.ts 603-700 at 6c9ff950). Rejected: decide
  issuing the timeout answer (a second issuer of main's answer).
- Amends HLK 10B (3.10, 3.13): an `effect_outcome` `retryable` carries main's receipt
  `error_code`, which an answer's `lastRefusal` shows (GAP 8). Reason: main records the code at
  each retryable try (orchestration-side-effect-reactor.ts 2320-2346 at 6c9ff950), and no
  evidence carried it. Rejected: deleting `lastRefusal` (main produces its code).

**Decided (build round 2b, 2026-10-31)**

The three risks build round 2 left open. A separate block, as build round 2 is to build round 1:
each round's header counts only its own bullets, and A.21 carries the running total. Item 3 is
decided by the text as it stood: D60 has decide issue only `probe`, `stop_task` and
`cancel_request`, so 3.6's `reconcile` order, its retry bullets, 4.5's and 4.8's fresh start and
the model-gaps start mode entry were stale readers; they now read main's starts, steers, retries
and answers from `live`. The stale readers it fixes count nothing. None came from a new generator
input kind; the first needs one the generator lacks: a control's `effect_outcome` with main's
`transmission`, and each Control's `commandId`.
Build round 2b (contract, after redesign 11): 0 new decisions, 3 amend earlier ones, 0 came from
new generator input kinds. Against HEAD, a replaced rule counting as one deletion and one addition,
a move or a restatement as neither and a new reader or exception as an addition, it deletes 65
rules and adds 81: 16 more (A.21).
- Amends D60 and G7 (2, 3.4, 3.13, 4.11, 2.1 row 215): whoever issues an effect names its
  transmissions. Every effect main issues is a `Main` `IssuedEffect` named by its `commandId`, each
  transmission by main's `(commandId, n)`: `n` from `run.dispatched` for a runner-held start or
  steer, else the claimed outbox row's `attempt_count`, which `markRunning` increments under a
  guard (orchestration-side-effect-reactor.ts 1352, 1364 at 6c9ff950), and which each control
  outcome's writer carries in `effect_outcome`'s `transmission`; a direct start keeps its
  `run.requested` runId. `ctx.newId` mints only a wake Run's id and the tokens of the three effects
  decide issues. Reason: main issues `interrupt`, `end_session`, `deliver_answer` and
  `send_native_command` (D60), yet 3.13 gave them a ledger token main never sees, and main's
  receipt is keyed by `command_id`, one per control (orchestration-command-commit.ts 207-223 at
  6c9ff950) across its retries. Rejected: main carrying a ledger token (a second name for main's
  transmission, in a payload main never reads); keying by `command_id` alone (not unique across
  retries); a new main counter (`attempt_count` already counts these, and OPEN-2 rejects a second
  count, 4.11).
- Amends HLK 10B (3.10, 3.13): `lastRefusal.attempt` is main's `(commandId, transmission)`, read
  from the `retryable` outcome that refused it, and decide probes no answer, so the probe's
  `interaction` target is deleted (3.7, F60). Reason:
  main retries an answer only at a `retryable` outcome; an ambiguous one fails its row, a
  `permanent` outcome, and main reopens the prompt only where it finds the answer unconsumed
  (`readFailedControlPrompt`, orchestration-side-effect-reactor.ts 2383-2552 at 6c9ff950).
  Rejected: a ledger probe before main's retry (decide issues no answer, D60).
- Amends 5C (3.8): a Run with a main run and no result in its fold ends, by either condition, only
  once main's terminal for its run has folded, unless reason 2.1, 2.2 or 2.3 applies, its reason
  that terminal's; condition 1's no-result reason reads as 2.4. Reason: OpenCode's `query_ended`
  and main's `turn.error` arrive in one write, and with `query_ended` folded first condition 1's
  empty fold had no reading. Rejected: fixing the fold order within a write (an order every
  writer must keep, and the permutation gate, 32.2.17, would have to exempt it).

**Decided (build round 2c, 2026-10-31)**

A control row ended by a sweep. Build round 2b had each control outcome's writer append
`effect_outcome` with main's `(commandId, n)`, but a sweep that ends a control row appended none,
so the ledger kept that issue in `live` as possibly acting until something else ended it. This came
from a contract pass on build round 2b's writer rule, not from a generator input kind; the
generator has none for it yet. `acceptStopEffect`'s DELETE, named with the sweeps when the gap was
raised, deletes only send rows (orchestration-engine.ts 858 at 6c9ff950; main's
provider-turn-session.ts 384-385 at 862c9557), and a recommit's delete never meets an immutable
control, so neither is a control outcome's writer.
Build round 2c (contract, after redesign 11): 0 new decisions, 1 amend earlier ones, 0 came from
new generator input kinds. Against HEAD, a replaced rule counting as one deletion and one addition,
a move or a restatement as neither and a new reader or exception as an addition, it deletes 65
rules and adds 82: 17 more (A.21).
- Amends D60 and G7 (3.4, 3.6, 3.9, 3.12, 3.13, 2.1 row 215), as build round 2b amends them:
  every writer that ends a control row writes its outcome, sweeps included, in one rule. The
  refusal sweep, `drain`'s removed-project cancel and pending-prompt retirement append
  `effect_outcome` in the write that sets the row's status, naming its `command_id` and
  `attempt_count` and mapping the status as the executor's writers do. A row with a claimed
  transmission names its latest; a row no claim reached names `(commandId, 0)`, n 0 naming no
  transmission, and its outcome ends the issue never transmitted. Reason: one rule for all
  row-ending writers leaves no `live` entry stuck, and copying the row's pair needs no branch.
  Rejected: an optional `n` or a second field shape for an unclaimed row (two shapes for one name,
  while the host still composes a token from it); a separate settlement kind for sweeps (a parallel
  rule).

**Decided (build round 2d, 2026-10-31)**

The four gaps the 32.2.3 and 32.2.4 lanes found building round 2b. Two came from the control
`effect_outcome` generator kind: a control's `not_sent` and provider evidence on a control before
its outcome. One came from the oracle's port: an `end` Control's interrupt and `end_session` under
one `commandId`. The fourth is decided by the text as it stood: round 2b deleted the probe's
`interaction` target, so the findings `answer_consumed` and `answer_pending` answer no probe; they
and 3.4's answer probe receipts are deleted as stale readers, counting nothing. 3.4 now rules out
reading a sweep's n 0 outcome as an unknown transmission, counting nothing.
Build round 2d (contract, after redesign 11): 1 new decision, 3 amend earlier ones, 2 came from
new generator input kinds. Against HEAD, a replaced rule counting as one deletion and one addition,
a move or a restatement as neither and a new reader or exception as an addition, it deletes 67
rules and adds 84: 17 more (A.21).
- D61 (3.4, 9, D21): a control main issues (`interrupt`, `end_session`, `deliver_answer`,
  `send_native_command`) is answered only by its `effect_outcome`. Every `interaction_resolved`,
  native or confirming an answer, and a native command's `command_lifecycle` and `command_result`
  are unsolicited, naming that interaction or command, never a transmission; any other kind on a
  control's token is evidence its send cannot produce, and D21 keeps only a held start's or
  steer's receipts. Reason: main's claim appends no event (`markRunning` appends `run.requested`
  only for a send's fresh run, orchestration-side-effect-reactor.ts 1338, 1375-1395 at 6c9ff950), and
  writes the outcome only after the provider call returns (`executeControlRow`, 682-756), while
  the provider's evidence comes in its own ingesting write, so it can precede the outcome, when no
  fold knows its token. The interaction and the native command exist before any claim, so naming
  them makes arrival order not matter, and no fact is lost: 3.13 already lists the
  three kinds as `Unsolicited`. Rejected: binding the token at the claim (a main event per claim,
  which main does not write); earlier evidence as an unknown token (drops a confirmation, so an
  answer's interaction would resolve only at its delivery's end, 3.10); the outcome always first
  (an order no writer keeps).
- Amends D60 and G7 (3.4, 8.4), as build round 2b amends them: each outbox row is its own issue
  under its own `command_id`, and a Control names only the row its own commit writes. `end`'s Stop
  commit is a `stop` Control, or an `end` Control with its `deadlineAt` where main commits the Stop
  as an `end_session` (orchestration-engine.ts 884-898 at 6c9ff950); a later `end_session`, U2's
  retire included, is its own `end` Control under the `command_id` main gave it
  (session-manager-service.ts 498-509, stop-settled-agents.ts 39-44, reload.ts 52-61; its Stop's
  `commandId` with `:retire` appended, provider-turn-service.ts 262-271 at 6c9ff950). It restates round
  2b's one name per row for 8.4, its stale reader, and counts nothing. Reason: `commitControl`
  writes one row per commit (orchestration-command-commit.ts 149-160 at 6c9ff950), and every
  dispatch passes its own `commandId`. Rejected: one `commandId` over both rows with `n` counted
  across them (two rows under one name); an `end_session` id main derives from the Stop's (main
  has no such rule, and U2's `:retire` suffix is opaque, never parsed).
- Amends D48 (H4, 3.4, 3.7, 4.4, 4.7, 8.5) and D60: no row main's executor runs, a direct
  start's included, gets a `not_sent`. Main's project gate runs before its claim and writes
  nothing while the project is not served (`executeRow`, orchestration-side-effect-reactor.ts
  782, 794-803, before `markRunning` at 815-822 at 6c9ff950), and a claim made before an outage waits
  inside it (`runProviderEffect`, 1440-1456), so such a try shows nothing and counts nothing, and a
  `not_sent` or `delivery_unknown` outcome naming a transmission is evidence its send cannot
  produce. `not_sent` stays a runner-held try's `unheld_outcome` and an effect decide issues'
  `effect_outcome`. A native command's confirmation clock runs through an outage, which nothing
  shows. Reason: main writes no `not_sent` status for a control row (`recordControlOutcome`, 2340;
  `refuseProjectCommand`, 2637 at 6c9ff950). Rejected: a `not_sent` naming its
  claim's `(commandId, n)` with main claiming `n + 1` (the lane's reading: a claim per outage poll
  would spend main's control budget of 5, 274, 1365, 698-710, and H4 counts a `not_sent` try as no
  transmission); keeping the clock's pause (it reads a fact no writer produces).
- Amends HLK 10B (3.4, 3.13), as build round 2b amends it: the probe findings `answer_consumed`
  and `answer_pending` and 3.4's answer probe receipts are deleted, as decide probes no answer and
  the probe's `interaction` target is gone (3.7, F60). It removes stale readers of round 2b's
  deletion and counts nothing. Reason: no probe a decider issues can produce them. Rejected:
  keeping them as findings an input probe may return (an input probe answers for an input, never
  an answer, 3.4).

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

### A.12 REDESIGN-2 Project removal (2026-10-29): C + M1 + M3 + M4

Decided autonomously under the Review Rounds rule after round 14's three review rounds with
material findings (r1 5, r2 3, r3 1). Root cause: the daemon's project registry owns whether a
project is served (`isProjectReady`), and the ledger held a second copy as a mode, so every ledger
concept needed a disposition for it and its writer raced the host's refusals. Source:
`02-options-and-pick.md` (REDESIGN-2).

- D48: the ledger has no project state. `project_inactive` and `project_active` leave Settlement,
  Session state has no project field, and `hasAuthority` has no project term. One host fact, H4
  (3.11): the daemon refuses the untransmitted sends of a removed project, each with its permanent
  `effect_outcome` code `project_inactive` (4.7), only after removal has finished and its runners'
  Stops have committed. A registered project that is not served, or whose removal is in
  progress, is never refused: each send gets `not_sent` before any transmission, which counts
  none and ends only that try, never a Run (a start's Run goes back to Queued while not yet
  delivered, and otherwise stays Launched, D50, 3.6), so its input is tried again at the backoff
  until the project is served (4.8), and no try is shown. The gate never applies to a
  retirement (3.11).
  Removal reaches the ledger only as `process_lost` and refusals: launched runner-held Runs end
  `process_lost` when their execution reached the agent and otherwise unlaunch (D50, 3.6), queued
  input ends refused, a refused steer is never re-sent (4.8), native commands `Failed` (D34),
  probes re-probe under their cap, and deadlines and gates are unchanged.
  Replaces round 14's draft (defer at inactive, re-decide at `project_active`) and HEAD's
  retirement. Amends D7, D10, D27, D29 and A.1 Q9; removes D11, D17 and D30; amends the glossary,
  3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.11, 3.13, 4.4, 4.7, 4.8, 4.11, 8.3, 8.4, 8.5, 9, LI6, the
  spec properties, F58, F60, 12.2 and Appendix C. Reason: one owner
  for the fact; the ledger already has an input for each consequence of removal. Risk: removal
  leaves managed OpenCode running with no relay, so a transmitted OpenCode send of a removed
  project stays may-still-act until the project returns (Appendix C).

| Option | Verdict |
|---|---|
| C: project served is a host fact (H4); removal reaches the ledger as `process_lost` and refusals | chosen (basis) |
| M1: one registry-owned project gate read by the feeder, interpreter, admission and sweep | chosen (code shape, 32.12) |
| M3: the ledger's input set has no host modes | chosen (with C) |
| M4: liveness is the ledger's view, never the outbox code `project_inactive` | chosen (code, 32.12 and 32.13) |
| A: defer at inactive, re-decide at `project_active`, refusal settles inactive first | rejected: two writers of one fact, 14 rules, a removed project never bounded |
| B: removal settles every session inactive before unregistering | rejected: rollback, crash, restart and concurrent create each need a host rule; still a mode |
| D': suspend the project's sessions until it returns | rejected: deadlines get a second owner; overdue deadlines fire against untransmitted sends |
| P: park a not-served project's sends in the feeder until the registry marks it ready | rejected (review r2): the Run's deadlines run while parked, so an outage longer than them ends queued input, and the park needs a wake for every gate change (a removal ends with no ready mark) |
| N: a not-served send is `not_sent`, which ends only that try, never a Run; a start's Run unlaunches to Queued (or stays Launched once it reached the agent, D50) and borrows its start's retry deadline | chosen (review r3) |
| R: a not-served try is a retryable start failure that ends its Run, hidden from view | rejected (review r3): every try ends a Run that each user-facing consumer must hide, a waiting input shows Starting or Dispatching, and a Run held Launched through an outage would absorb a self-started turn (8.3) |
| E: removal is `session_ended` | rejected: lies about the native session; hides live OpenCode work from cleanup |
| F: removal is a host Stop per session | rejected: a second writer of stop intent; the same order race; paused input waits forever |
| G: inactive retires every send (HEAD) | rejected: the retired-send state behind harness r12 gap i and oracle r11 |
| M2: removal as one planner module | rejected: orders nothing C needs ordered |
| M5: removal on each session's drain lane | rejected: C is order-free; a lane only adds waiting |

<!-- src: REDESIGN-2 2026-10-29 (/private/tmp/r32-inactive-redesign/02-options-and-pick.md) -->

### A.13 REDESIGN-3 Delivery at the stop commit (2026-10-29): A + M1 + M3 + M5 + N + O

Decided autonomously under the Review Rounds rule after round 15's three review rounds with
material findings (r1 6, r2 4, r3 1). Root cause: whether a runner received a frame is
connection state (the write, `command-accepted`, `idle-exit`, the journal), and the ledger learns
it only as a release. A stop commit turned that state into ledger facts while the write side
could still change it, so each round found a frame whose receipt the retirement read wrong (r1
P1-1, r2 P1-A) or a permission with no owner after a failed commit (r3 P2-1). Chosen: the stop
intent closes the runner's write gate before its transaction, so the commit reads a fixed
possibly-written set and releases every other hold it reads `NotSent`, and every stop commit
carries the releases its evidence already holds (4.4, 4.5, 6.4). The gate
is the reconciler's stop state, so it adds no owner and no reopen rule. Prior art: paseo blocks
new prompts before it stops an idle runtime (packages/server/src/server/agent/agent-manager.ts
at c4b451689), and zeron sets a `retiring` flag under its delivery ledger's lock (crates/engine/
src/sessions.rs at a0468502); diri, monocode and bb also refuse or park writes once a stop
begins. Source: this record.

| Option | Verdict |
|---|---|
| A: the stop intent closes a one-way write gate before its transaction (review r3) | chosen (basis) |
| M1: the gate is a read of `RunnerStop` (6.4), not a new state | chosen (its owner) |
| M3: deletion test on the stop commit's releases | chosen: the permission take and its owner sentence go; `Refused{exiting}` and `JournalAbsent` stay, as deleting either brings back r2 P1-A |
| M5: `requestStop(target, reason)` reads the evidence before its transaction (6.3) | chosen (interface unchanged) |
| B: bind each effect to a target process at issue; lost work only when that process is lost | rejected: that is L2 and L5 already (A.11); it names the process but never says whether it received the frame |
| C: a durable `command-accepted` fact (bb's `turn/input/accepted`) | rejected: one more event per send, and the stop commit still needs the idle-exit order and the journal for a frame with no acceptance read |
| D: decide "reached" at Settle, with Runs awaiting settlement | rejected: a Launched-on-retired state and a settle input, the next Run waits out the escalation, and `Unreadable` or older builds turn main's silent idle retry into `delivery_indeterminate` |
| E: keep the take and add a rule for a stop that fails after it took permissions | rejected: a second owner sentence for a permission a stop never needs |
| F: reached only on agent evidence; re-send every frame without it (t3code's agent-confirmed acceptance, zeron's re-send of unconfirmed messages) | rejected: a frame the agent read before a crash or explicit stop is delivered twice, where main shows `runner_stopped` (F51) |
| G: the daemon defers an idle exit while a frame is unaccepted (paseo refuses to stop with unstarted messages) | rejected: the host decides idle exit and leaves after 2 s without the daemon (runner-host.ts:131-135 at 3aa43c60) |
| H: the host lists what it accepted in `idle-exit` and the shutdown ack | rejected: a protocol change on both builds for a set 4.6's order already gives, and a crash sends nothing |
| I: releases commit first, the stop in a second transaction | rejected: the stop waits on write fibers, and a crash between the two is the r2 P1-A trace |
| M2: a per-connection gate in the write fiber's capability (review r3's literal form) | rejected: a second owner of "this runner is stopping", with its own reopen rule |
| M4: a receipt module behind a per-provider port | rejected: one adapter (one runner host serves Claude, Codex and Cursor; OpenCode holds nothing), a hypothetical seam |
| N (spec r1): a stop commit's `process_lost` carries its releases, read first in one decision, so a relaunch addresses the next runner | chosen |
| N1: reconcile every release once per transaction | rejected: a decider change for one caller |
| N2: `process_lost` before the releases | rejected: it ends the released Runs `process lost` |
| O (spec r1): a refusal registers no stop form; it joins the `Committing` intent or calls `requestStop` (6.4) | chosen: R2's `retiring` refusal is a host self-retire and `exiting` follows `idle-exit` (runner-host.ts:258-270, 369-381, 819-826), so the stop is owed anyway |
| O1: the refusal's own `Committing`, restored on failure (R2 runner-retirement.ts:958-1007) | rejected: a second reopen rule for the gate |
| O2 (spec r2): a stop commit carries the refusals its evidence read finds on the connection, and the refusing write fiber commits the release once the stop leaves `Committing` (a no-op if carried) | chosen: one owner covers a refusal read after the evidence read and a stop that returns to `Running` |
| O3: the refusal rechecks and raises a new stop after a failed one | rejected: a loop on a defect path, and the runner's exit stops it anyway |
| O4: a separate sentence each for the late refusal and the failed stop | rejected: two rules for one owner |
| P (spec r3): the evidence read freezes a possibly-written set (each transmission this daemon called write for, each hold an earlier daemon made), and the commit releases every other hold it reads `NotSent` | chosen: one set answers a hold made after the read (unwritten, so released) and a restart hold with no write evidence (kept for the hello or the journal, as main replays it to the same host, deduped, or never re-sends it: runner-host.ts:683, 713-714 and runner-recovery.ts:125-126 at 3aa43c60) |
| P1: `NotSent` only for the frames the read finds unwritten (spec r2 text) | rejected: a hold made after the read gets neither a release nor a write (spec r3 ub P1-1) |
| P2: `NotSent` for every hold outside the read's written set (ub's literal fix) | rejected: a recovery Stop before the hello releases a frame an earlier daemon wrote, delivered twice (spec r3 poteto P1) |
| P3: `holdRun` reads `RunnerStop` and holds nothing while `Committing` | rejected: an in-memory read in a step that reads only the row and the clock (4.3), with a retry when the stop returns to `Running` |
| P4: the write fiber releases its unwritten frame after the commit | rejected: the Run is then Ended `process lost`, a fresh Run for nothing lost (D50) |

<!-- src: REDESIGN-3 2026-10-29 (/private/tmp/r32-redesign-3); reviews /private/tmp/r32-contract-r15/review-r1.md, r2, r3; REDESIGN-3 spec reviews r1, r2 and r3 (ub, poteto) -->

### A.14 REDESIGN-4 Sealed delivery (2026-10-30): B + M1 + M2 + M3 + M4 + M5

Decided autonomously under the Review Rounds rule after round 16's three review rounds with material
findings (r1 17, r2 12, r3 7). Root cause: every Run end, unlaunch and pause read a send's one-test
value at the moment something ended its work, but coverage (a kill, a pending kill, `process_lost`,
a session end) ends work from a different source than the facts that fix the value (the hold, the
stop commit's releases, the send's own answer). So "never handed over" was read before it was
sealed: r1 merged it with work ended, r2 let each cause end the Run with its own inputs, and r3
found a session-end order that ended a Run `session ended` and paused where the other order
unlaunched it silently, reasons keyed by cause rather than by the condition and the value, and a
pause nothing read. Chosen: a transmission is **sealed** at the first of a closed list of recorded
facts, and a send when its latest transmission is (D52); only a sealed value moves a Run, so every
coverage waits the same way and the order of a coverage fact and the facts that fix a send's value
cannot change an outcome, except a release against its runner's `process_lost`, and Run-end evidence
against a runner's loss or session end, as LI2 allows. The end reasons are keyed by the ending
condition (3.8); the pause is read by D51's decider (Submit, session-inbox.ts 276 at 1ba91324;
Drain); a start's transient refusal or decline is
tried again up to the cap, a product choice: main retries silently only a runner's idle exit or
abandoned recovery before acceptance (process-session-runner.ts 3706-3713 at 1ba91324,
`Refused{exiting}` here, 4.5), ends a busy-declined start `interrupted`, and requeues a declined
steer (4.8). Review round 1 (ub 5, poteto 12 material) found the seam's remaining gaps, which facts
end a send's wait, and fixed each as a clause of D52 or the reason list: a bare `refused` after a
withdrawn retry, a joined wake's phase clock, a late release's value, the cut-off's owner, a hold of
a dropped issue, and the `end_session` window. Review round 2 (ub 9, poteto 9 material) found the
seal frozen at a send's first answered try, a usage-limit failover read as a session end where main
resumes the native session, a host refusal read as a provider decline, starts Codex and Cursor
decline, and second owners of a late release and of `Covered`; each was fixed by narrowing the seal
to a transmission or by deleting the clause: the joined wake's phase clock, the dropped issue's
`Covered`, the `usage_limit_failover` cause and D52's wait for it, two restatements, and 4.5's copy
of the late release, now a pointer.
Rule count against HEAD (round 16 whole; a moved rule counts as neither, a replaced rule as one
deletion and one addition, a new reader or exception as an addition): deleted, retirement ending
a launched Run `process lost` with its kill wait (L1), the pending kill's immediate end (L2),
3.5's coverage-beats-own; replaced, per-cause Run ends by the one Run-end rule, the reason by
first cause by reasons keyed by condition (reason 2.2 a clause of it), the ordinary-Stop pause by
D51, a `NotConsumed` start ending its Run by a refused or declined start tried again, an unlaunch
returning its steer by the steer following its Run, a session end covering every send by the
`end_session` window, S9.4's other code by `session ended`, `input_absent` final by ends probing,
the one test's two values by three with unconsumed, the Interrupting guard on reached by may still
act, the wake fence clearing at session end by Run-end evidence, retirement or session end (8.3),
a release read as absent or declined by a release read as NotConsumed{released} (3.6, 4.11), a
usage-limit failover as a session end by a usage limit ending no native session (3.4); moved, a
late release's re-send (4.5 to D52); added, sealed (D52), retry pending, the fence holding a Run's
own retry, a relaunch is not queued input, 5C `delivery_unknown` a failure, advance reading
Paused, advance reading the cut-off and schedule, a joined wake in condition 2, a joined wake's
activity extending its Run's Running clock (3.7), the unlaunch finishing its dropped issue's effect
row (3.6), the refusal and decline classification (4.8), the recall and drop keyed off durable
facts (4.4), a joined steer's re-hold to its owner's current runner (4.8), an `end_session`
success and a rejected resume ending no label's scope (L5). Review round 2's deletions (the
joined-wake phase clock, the dropped issue's `Covered`, D52's `session_ended` wait, a rejected
resume as its own answer, the restatements at 3.4 and 4.8) were not at HEAD.
Deletions 3 + 13, additions 13 + 14: 11 more; A.15 recounts after REDESIGN-5.
Open risks: the first, a refusal or `JournalAbsent` read after its runner's `process_lost` (F40,
F51) re-sending its input on a new Run after an error, is resolved by D53: the input returns to the
inbox front behind the pause and is sent at Resume (A.15). On a same-driver failover the cut-off
runner's other held inputs seal only at their own answers, as on main, whose result also settles
only the inputs it names (claude-runtime-turn.ts 174-205 at 1ba91324); that the SDK answers them
after a usage limit is unverified, and if it does not they wait for the user's Stop (3.7, L6).
Prior art: zeron, paseo and t3code settle a turn by its first terminal event and bb by a stop
handshake; none re-sends an input the agent may have read, and four of six pause queued input
after a stop. Source: this record.

| Option | Verdict |
|---|---|
| B: a send's value moves its Run only once sealed, a single point that waits for its answer, its runner's stop commit or its Run's committed Stop | chosen (basis): one predicate replaces L1's kill wait and covers session end and the pending kill |
| M1: deletion test on the per-cause waits and ends | chosen: L1's kill wait, condition 2's retirement clause, the pending kill's immediate end and 3.5's coverage-beats-own go |
| M2: seam placement, sealed beside the one test in 3.6 | chosen: the value and its seal have one owner |
| M3: depth, one predicate with three readers (condition 2, unlaunch, Stop of a Run not yet delivered) | chosen |
| M4: design it twice, reasons keyed by condition against one priority list by cause | chosen keyed: condition 1 takes the fold, so a result beats a Stop's fallback (main's first terminal event, projectors-effect.ts 1737-1756 at 1ba91324) |
| M5: the pause seam in advance, read once | chosen: Run now and a relaunch pass it by rule, not prose |
| M6: an owner table for Run end, reason, unlaunch, retry pending, coverage, work ended, sealed and pause | chosen as the check; no new owner; round 1 named the cut-off's owner outside the ledger |
| A: the reviewers' narrow fix (reasons by condition, one stop-commit wait for any coverage, advance reads Paused) | rejected: a wait keyed to a stop commit misses a pending kill's send that H3 may still transmit and a covered send with no try, and leaves a decline's refused-then-resend |
| C: the end reason as a pure fold over sends' sealed facts, no list | rejected: `process lost` would beat a Stop's `interrupted`, and a refused start with a covered sibling gets no code |
| D: session end and retirement as one scope end with one wait | rejected: a partial B; an `end_session` success and a rejected resume end no runner, so the wait still needs B's answer clause |
| E: the pause as a Run field written at Run end | rejected: a second owner of the end reason, the drift t3code's `queueHeld` shows |
| F: the status quo with patches | rejected: a fourth cause-keyed wait, and the next arrival order finds the next patch |
| G: first event wins by compare-and-set (bb, t3code, paseo, zeron) | rejected: for coverage against a release, arrival order is exactly the defect |
| H: a host delivery ledger with silent re-send (zeron) | rejected: a second owner of delivery beside the hold |
| I: a generation token per execution (monocode) | rejected: L1's labels already are one; it says which execution, not whether the host kept the input |
| J: seal only at a confirmed exit, as main's `Gone` | rejected: an `end_session` success or a rejected resume ends no runner, and a same-driver failover keeps it (3.4), so a send its runner answered would still wait out the deadline |
| K: explicit retry only, no automatic re-send (bb, t3code) | rejected: worse than main's silent retry of an idle exit before `turn.accepted` (process-session-runner.ts 3706-3713 at 1ba91324) |
| L: an unconsumed send unlaunches its Run | rejected: a later acceptance beats it, so the unlaunch does not commute (LI2) |
| M: a decline ends the Run and re-sends on a new Run (round 16 r3) | rejected: shows `refused` for nothing lost, then re-sends |
| N: a seal clause per work-ended fact (an idle probe, a pending kill after the next `process_started`; round 1's `session_ended` case is gone, a usage limit covering nothing, 3.4) (round 1) | rejected: each needs a host fact no runner gives (D52), so each waits for its try's answer under the phase deadline |

<!-- src: REDESIGN-4 2026-10-30 (/private/tmp/r32-redesign-4); reviews /private/tmp/r32-contract-r16 (ub and poteto r1 to r3); main at 1ba91324 -->

### A.15 REDESIGN-5 Input place and wake executions (2026-10-30): B + C + D + M1 to M6

Decided autonomously under the Review Rounds rule after REDESIGN-4's three review rounds with
material findings (r1 17, r2 18, r3 23). Root cause: two pieces of state had no owner. An input's
place over its life (inbox, Run, transmission, Run end, then inbox or composer) was decided in nine
clauses (3.6, 3.9, 4.8, 5.1, D52's late mark, 6.5, 7.3, F40, F51), so each fact arriving after a
seal found a clause to patch: r1 a late release's value, r2 a second owner of a late release, r3 a
late release with no trigger or a re-send past the pause while the text was back in the composer,
and a start re-sent where a steer of the same value returned to the inbox. Executions that name no
send (wakes) were folded into Run delivery and Run end (3.6, 3.8 condition 2, D47, 3.7's Running
clock, section 9's cleanup), so r1 found a joined wake's phase clock, r2 its deadline, and r3 a
Starting Run expiring while a wake worked, a wake joining a Queued Run against LI2, and a cleanup
only a wake Run had. REDESIGN-3 and REDESIGN-4 each closed one seam (the stop commit, then the
seal) and the findings moved to the facts after it. Chosen: an input's place is derived from its
Run's activity and its sends' current values by one rule (D53); a Run's unlaunch and end reason
read values only as sealed and a late fact moves only the input (D52); a wake execution is a
session obligation, read by a user Run only as activity (D47, 8.3). Review round 1 (ub 15, poteto
10 material) found its findings in two places and fixed two rules in place: E1, anything that ends
drops what it owns, and an input belongs to exactly the latest Run that reserved it (D53, 8.4
D43); E2, a label has at most one deadline, one end rule and one stop sequence, the active Run's
if a Run reads its activity, else the wake execution's (8.3, 3.7, 4.6, 5.1). Each r3 finding is then a
reading of one rule: a late release or acceptance moves the input by D53 behind D51's pause; the
start and the steer of one Run end share D53; a Starting or Queued Run reads a wake only as
activity and never unlaunches by it; the wake's cleanup is its deadline; a send with no
transmission seals at a try that ended before transmitting; the dropped issue's Run Effect ends
and the relaunch issues a new one; a release is NotConsumed{released} everywhere (4.9).
Review round 2 (ub 5, poteto 4 material) found E2 incomplete in two places and closed both by
deletion: a fence member leaves at its own work ended, so the result-held Claude member and its
cleanup go (D2, D25 amended), and a wake execution its reader or its wake Run leaves is the
session's, with one deadline 8.3 owns, the interrupt budget once Stop has named it (D28 amended).
It also gave Claude's `cancelled` before `started` its own value, NotConsumed{cancelled}, and
`holdRun`'s reservation fact an owner, 32.29.
Rule count against HEAD (round 16 whole; a moved or restated rule counts as neither, a replaced
rule as one deletion and one addition, a new reader or exception as an addition): deleted, L1's
retirement ending a launched Run `process lost` with its kill wait, L2's pending kill's immediate
end, 3.5's coverage-beats-own; replaced, A.14's thirteen (per-cause Run ends, the reason by first
cause, the ordinary-Stop pause, a `NotConsumed` start ending its Run, an unlaunch returning its
steer, a session end covering every send, S9.4's other code, `input_absent` final, the one test's
two values, the Interrupting guard on reached, the wake fence clearing at session end, a release
read as absent or declined, a usage-limit failover as a session end), HEAD's automatic re-send at
Run end of a message that never reached the agent (4.8), 3.9's list for a stopped Run's steer and
4.5's re-send on a new Run of a late release's input, all three by D53, and D47's join by the
session's wake execution; moved, 3.9's declined steer and 4.8's failed send into D53; added,
sealed (D52), retry pending, the fence holding a Run's own retry, 5C `delivery_unknown` a failure,
advance reading Paused, advance reading the cut-off and schedule, a wake's activity extending the
reading Run's Starting or Running clock (3.7), the wake execution's deadline and stop sequence
while no Run reads it (8.3), the unlaunch ending its dropped issue's Run Effect (3.6), the refusal and decline
classification (4.8), the recall and drop keyed off durable facts (4.4), a joined steer's re-hold
to its owner's current runner (4.8), an `end_session` success and a rejected resume ending no
label's scope (L5), D51's pause predicate (HEAD said only that Paused is derived), 12A's
input-place exception (a late fact moves its input); and the second 15, the replacements: A.14's
thirteen (the one Run-end rule, reasons keyed by condition, D51 for the ordinary-Stop pause, a
refused or declined start tried again, the steer following its Run, the `end_session` window,
`session ended` for S9.4's code, `input_absent` ending probing, the three-valued test, may still
act, the wake's end at its work, retirement or session end, NotConsumed{released}, a usage limit
ending no native session), D53 for the three, and the session's wake execution for D47's join.
Review round 1: deleted, 4.8's cap by
`commandId` across runs and 4.8's re-sends into the outbox bullet (32.2.6's owner of re-sends);
added, the cap within an input's reservation (4.8), D43's drop for a wake execution's step (8.4),
the stop commit's release at a connection's first `retiring` refusal (4.5, 4.6), and
`interrupt_turn` naming every outstanding wake label (4.6). Recall and drop keyed off durable
facts is a new rule, not a restatement: no clause at HEAD said where those steps read their facts,
though it decides no new outcome. 3.5's precedence now stating the join completes the counted
deletion of coverage-beats-own. Changes inside a rule new against HEAD (D53's latest Run, Stop's
own, the declined steer's place, reason 2.3's wake Run, the 8.3 end and deadline, the seal scope)
stay inside it. Review round 2: deleted, the Claude result-held fence member (32.2.14's "no" as
a1473a01 read it, with its column and D2's cleanup), D25's Claude wake membership after its
result, and D28's Tombstone cleanup of a wake Run's remaining labels; added none: the session's
deadline for a wake its reader leaves, the interrupt deadline after Stop, NotConsumed{cancelled}
and the reservation fact are changes inside rules new against HEAD (the wake deadline while no
Run reads it, Stop's own, the cap within the reservation), and 4.5's retiring release, F30, F40,
5.1's deadline and `Failed` are restatements. Deletions 3 + 17 + 2 + 3, additions 15 + 15 + 4 + 0:
25 and 34, 9 more, 2 fewer than A.14's text (A.16 recounts after REDESIGN-6). Not at HEAD and deleted here: D52's late mark with its 4.5 pointer and 4.8 parenthetical, "a relaunch or
an automatic re-send is not queued input" (3.6, 3.9, D51), the joined wake in condition 2 and in
3.6's execution line, the joined wake's Running clock and Tombstone cleanup, 3.6's "release beats
acceptance" and "once sealed" sentences, 4.8's declined-steer sentence and its steer sentence
that repeated 3.9; in review round 1, "possibly seen" and its advance exception, 3.9's "next goes
as a start", Stop making a wake deadline due, 3.6's "the unlaunch commutes with any later fact",
5.1's pointer to 3.9, section 9's restated wake end, and the 4.8 amendment's repeated main
sentence and producers; in review round 2, the Claude wake's cleanup at its result plus
`settleMs`, Claude's `cancelled` as NotConsumed{declined}, 4.8's fresh-run count sentence and the
4.8 amendment's "re-admission counts only the rows left".
Owners, open risks and the final count: A.16.
Prior art: main re-queues a stopped Run's pending and retryable inputs and derives its pause
(provider-turn-session.ts 329-388, session-inbox.ts 240-250 at 1ba91324); bb derives its pause;
t3code stores `queueHeld` and runs wakes as runs; paseo has an autonomous run kind and drains its
queue on Stop; zeron re-sends at least once; diri never retries; monocode steers at the queue
head; capy recalls pending messages to the composer. None owns an input's place across a Run end
by one rule. Source: this record.

| Option | Verdict |
|---|---|
| B: an input's place derived by one rule from its Run's activity and its sends' current values (D53) | chosen (basis): one rule for start and steer, Stop and every Run end, and every late fact |
| C: wake executions as session obligations with their own deadline and cleanup, read by a Run only as activity | chosen: the Run never waits for, unlaunches by or cleans up a wake |
| D: a Run reads each value as sealed; a late fact moves only the input | chosen: LI2 holds for the Run, and the input has one owner of its move |
| M1: deletion test on the late mark, "a relaunch is not queued input", the joined wake in condition 2 and its clock | chosen: each goes, derived by B, C or D |
| M2: seam placement, the place rule in 3.9 beside the inbox it fills | chosen |
| M3: depth, one place rule with three readers (Stop, Run end, a late fact) | chosen |
| M4: design it twice, place derived against place decided at Run end | chosen derived: a decided place needs a trigger for every late fact |
| M5: an owner table for every piece of Run, input, wake and fence state | chosen as the check |
| M6: LI2 commutation check of each rule against every late fact | chosen as the check: a wake meeting a Queued Run and a late release after `process_lost` now commute for the Run |
| a: the reviewers' narrow subtractions alone | rejected: a wake meeting a Queued Run stays unbounded or orphaned, Stop leaves it running, and a late-accepted steer stays in the inbox |
| b: a decided disposition written at Run end | rejected: a late release has no trigger, or needs a mark (the defect) |
| c: wakes as full Runs (oracle :4737) | rejected: two active Runs |
| d: the seal final, late evidence 12A only | rejected: worse than main for F40, as an input released after its Run's end is never sent |
| e: only the inbox sends (relaunch and retry as re-admissions) | rejected: an end reason the user never sees, Run churn, backoff on inbox input, and steers split into separate turns |
| f: the status quo with patches | rejected: a fifth statement of late facts |
| g: the seal waits for Settle | rejected: Stop waits on the reaper, and it brings back 6.5's rejected runnerGone |
| r2-a: a fence member leaves at its own work ended, the result-held rule deleted (ub r2 F-A) | chosen: main never holds a Claude follow-up or closes the live query |
| r2-b: one result cleanup per label for a member held by a result (poteto r2 F2) | rejected: keeps a hold no SDK behaviour needs (D2 amended) |
| r2-c: Claude `cancelled` as NotConsumed{released} | rejected: unchecked against D50's unlaunch, and `cancelled` breaks no reader |
| r2-d: the reservation as a new `runId` | rejected: a fresh host run has one too (poteto r2 F3) |
| zeron: at-least-once re-send | rejected: double delivery |
| t3code: `queueHeld` and wakes as runs | rejected: a second owner of the pause, and two active Runs |
| bb: derived pause with retry keyed to accepted ("Please continue") | rejected: a visible re-prompt where main retries silently |
| paseo: an autonomous run kind, the queue drained on Stop | rejected: Stop then runs queued input unattended, worse than main |
| diri: never retry | rejected: worse than main's silent retry |
| monocode: a steer at the queue head | rejected: a steer is its Run's input while active (D53) |
| capy: recall to the composer | rejected: main re-queues, and a start and a steer would go to two places |

<!-- src: REDESIGN-5 2026-10-30 (/private/tmp/r32-redesign-5); REDESIGN-5 review round 1 (ub, poteto, fix-r1, E1 and E2); REDESIGN-5 review round 2 (ub, poteto, fix-r2); REDESIGN-4 reviews r1 to r3 (ub, poteto, /private/tmp/r32-redesign-4); main at 1ba91324; R2 at 6c9ff950 -->

### A.16 REDESIGN-6 Label work (2026-10-30): L6 + M1 to M7

Decided autonomously under the Review Rounds rule after REDESIGN-5's three review rounds with
material findings (r1 25, r2 9, r3 4), the fourth redesign in a row. Root cause: the work still
running on a native query label after the Run that started it (a send past its Run's result, a
member a late acceptance restored, a wake execution) had no owner. Its deadline, stop sequence,
end and fence membership were attached to whichever holder each redesign named (a Run's phase, a
send's cleanup, a wake execution, a Tombstone cleanup, a forced close, a scope end), in 3.4, 3.7,
3.8, 5.1, 8.3, 9 and L5, so every round found a label with no deadline or two stop sequences
(REDESIGN-5: 15 of 29 behaviour findings, 3 of 4 in r3). The other findings were one fact held in
several places (8 prose readers left stale, 9 recount, bead or ticket texts). Chosen: a label owns
its work (L6, D54), with one deadline, one stop sequence and one end, and Runs, sends and wake
executions only feed it evidence. Each r3 finding is a reading of it: a forced end runs the
label's one sequence and the wake on it gets no second (ub N1); a send outstanding after its Run
ended has the label's deadline, a time (poteto P2-3); a uuid-less result is the outstanding
wake's (poteto P2-1, OW Decision 3 amended); `cancel_input` has its own state (poteto P2-2, D55).
E1 is L6's end plus 3.8; E2 is L6; D47's wake is L6's work with its own end rule (8.3); D50 to
D53 read no label state and stand.

Drift check (M7): each value has one defining clause, the owner table below; every other mention
is a pointer. Before each review round, every term whose meaning changed is searched across the
contract and each hit is logged on the bead as rewritten or a pointer. The 3.13 unions are the
normative value names; the model and the oracle switch exhaustively on them, so a renamed or
removed tag fails to compile at each reader.

Rule count against HEAD (A.15's lists as the base, by the same convention): deleted, HEAD's send
cleanup with no time (3.7), the late acceptance's Tombstone cleanup (3.8), 5.1's forced close and
second deadline as the Run's own sequence, and 3.4's uuid-less result naming the latest start
while a wake is outstanding; added, L6 (D54), 3.4's uuid-less result naming the outstanding wake,
and `cancel_input`'s state (D55); removed from A.15's additions, the wake execution's deadline and
stop sequence while no Run reads it, now inside L6. Deletions 25 + 4, additions 34 + 3 - 1: 29 and
36, 7 more, 2 fewer than A.15. Changes inside rules new against HEAD (reason 2.1 reading
NotConsumed{cancelled}, the wake's end at `query_ended` for every provider, a wake Run's end at
retirement or session end) stay inside them; Codex's fence-expiry column, 4.5's retiring release,
F30 and L5's pointer are restatements. Not at HEAD and deleted here: E2's bullet, 3.7's wake
deadline and Tombstone owner, 8.3's "a Tombstone cleanup never covers a wake execution", condition
2's wake clause, 8.3's wake end at a scope end, and A.15's owners and risks (here). `Accepted`'s
`cancelled` flag, dead at HEAD, goes as text. Review round 1 (ub r1, poteto r1): deleted, HEAD's
exhaustion rule (the Queued Run ends, the label stays fenced, 3.7; the abort a member until
`native_idle`, 9), replaced; added, exhaustion ending the episode (L6, 82tn.32.2.14 amended), the
interaction pause (3.7), `livenessMs`'s default (3.7), and a uuid-less result as its send's
work-ended and Run-end evidence (3.8 condition 1, 9). Stop naming every label with work replaces
round 16's wake-label naming one for one; the episode, its interrupt budget and the fired
sequence's reading change L6 inside it; Cursor's forced-end kill was counted with 5.1's forced
close and is now recorded (SPEC Stop amended); 3.6's fence bullet, 3.7's cap clause, 3.4's idle
sentence, 8.3's Stop bullet and 3.9's list of Stop's outcomes become pointers. Deletions 29 + 1,
additions 36 + 4: 30 and 40, 10 more. Review round 2 (ub r2, poteto r2): deleted, HEAD's Starting
deadline, HEAD's Running deadline with activity extending it (with its readers, the throttle's
quarter window and 8.3's wake activity), HEAD's bound on every non-Ended Run (replaced), HEAD's
uuid-less result naming the latest start or steer (3.4, replaced), HEAD's interaction naming the
latest start or steer (3.4, replaced), HEAD's Claude column closing before its kill for send work
(9, replaced) and HEAD's `fence unconfirmed` (3.8); added, the bound from a Stop only (3.7), with
round 1's confirm exception inside it, an addition round 1's count missed (ub r2 P2-8); the
uuid-less result ending every started send with no result (3.4); an interaction owned by its label
(3.10), resolved at its runner's retirement or session end (3.10); Claude's column killing send work at the deadline, a close only for a wake (9); a
`native_busy` probe re-probed (3.7); `closeMs`'s value (3.7); the host interrupting a named label's
turns until that query's next unrecorded run, a late interrupt left alone (4.6), replacing round
1's latest-opened-turn reader, which round 1's count also missed (ub r2 P2-8); and a stream end's
error result for an unstopped turn (9); removed from round 1's additions, the interaction pause and
`livenessMs`'s default. The budget from the first commit, the label's deadline before a Stop going
and exhaustion launching the Queued Run change L6 inside it; D51's trigger goes inside D51; Stop
with no active Run is not new (it replaced round 16's wake-label naming one for one in round 1,
and "with neither, it issues nothing" restates it); 3.8's Queued clause, `EndReason`, LedgerView's
interactions, `deliver_answer`'s label and the nullable run ids are restatements or types.
Deletions 30 + 7, additions 40 + 9 - 2: 37 and 47, 10 more.

A.16's owner table and open risks are superseded by A.17's.
Prior art (bounding work after a turn ends): t3code stores a completed run as waiting while
background work drains, under one per-session idle timer that activity resets, and opens a new run
for a wake; bb holds the turn and bounds no long turn; zeron reaps an idle runtime after 30 minutes,
deferring while tasks run; paseo has an autonomous run kind; diri marks a silent session Unknown
and never kills; monocode has no bound; capy times each waited-on object. None has one normative
spec or a per-label owner; t3code's per-session timer is the nearest. Source: this record.

| Option | Verdict |
|---|---|
| b: one owner per label of work, deadline, stop sequence and end, fed by Runs, sends and wakes (L6) | chosen: every holder's clause becomes evidence, and N1, P2-3 and P3-2 are one reading each |
| a: the round 3 reviews' narrow fixes (a forced-end exception in 8.3, the wake rule copied onto the send) | rejected: two more holder clauses for one deadline, the move each redesign made |
| c: every execution a Run (a wake Run, or a tail Run for a send past its Run's end) | rejected: two active Runs, or a Run held open past its result so a Claude follow-up waits |
| d: a Run's end waits for every execution on its labels | rejected: a Claude Run would wait for the next turn, and a wake would join Runs again |
| e: the typed model or oracle normative, the prose rationale | rejected as the source: the oracle is in another worktree, 14 input kinds are not generated, and host facts and main parity are not types; kept as M7 |
| f: main's tail, no bound after a turn | rejected: a silent wake would hold the fence forever; main has no fence |
| g: the ledger owns inputs and Runs, the runner host the rest | rejected: two owners of the fence, and OpenCode has no runner host |
| h: zeron, an idle reaper deferring on tasks | rejected: an idle reaper is not a fence bound |
| i: paseo, an autonomous run kind | rejected: as c, a second active Run kind |
| j: capy, a timer per waited-on object | rejected: the per-holder deadlines L6 deletes |
| k: diri, Unknown on silence, never kill | rejected: worse than HEAD's bound |
| t3code: a per-session idle timer reset by activity, wakes as runs | timer adopted as L6's shape; wakes as runs rejected (c) |
| r3-a: a `close` issue ends the label's work (L5's reading) | rejected: the fence releases onto a query still writing (ub r3 N1) |
| r3-b: a uuid-less result always unsolicited | rejected: a Run whose own result lacks a uuid waits for its deadline, where main ends it |
| r3-c: `cancel_input` on an unaccepted steer | rejected: needs `Accepted{cancelled}`, a value no rule reads; main refuses it |
| r1-a: a label's work episode keys Stop's naming, the interrupt budget, the column and a reading Run (L6) | chosen: ub P1-A, P1-B, P2-1, P3-8 and poteto P1-A, P1-B are readings of it |
| r1-b: an exhausted column re-armed once per Run reserved later (poteto r1 P1-B) | rejected: a re-arm exception; the label fenced while OpenCode stays busy; each Resume waits a full column, worse than main |
| r1-c: a reserved input's cancel refused `held by a waiting Run` (ub r1 P3-6) | rejected: a code main lacks; main refuses a claimed input `already started` |
| r1-d: Cursor's forced end closes first (poteto r1 P2-G) | rejected: Cursor's column has no close step, and main retires the process with no close |
| r2-a: everything on a native query label (its turns, interactions, results and what Stop reaches) is its episode's, and a Run only reads it | chosen: ub r2 P1-3, P2-3, P2-6 and poteto r2 P1-2, P2-1, P2-2 are readings of it |
| r2-b: a host-minted turn id, or a send token per turn, on `interrupt_turn` (ub r2 P2-3, poteto r2 P2-1) | rejected: a new identity on the wire and in the journal; the label with its latest send's run tells a late interrupt with ids the host already records |
| r2-c: the label alone, its interrupt cleared at the query's next accepted `send-turn` (fix-r2's first try) | rejected: a steer of an ended Run read after the interrupt cleared it and ran, and an interrupt read after a newer send stopped that send's turn (no FIFO, option P) |
| r2-d: keep `fence unconfirmed`, declared as a divergence (poteto r2 P2-3's alternative) | rejected: a pause main lacks, where main sends at its Stop deadline |
| r2-e: a liveness budget before Stop, paused while an interaction is Pending (round 1) | rejected: it ends a silent turn main never ends, and each case it guarded has evidence (9, L1, 3.4) |
| r2-f: Claude closes before its kill for send work | rejected: a close ends no send's work (F57), so it only delays the kill past main's retire |
| r2-g: a Starting deadline as main's 2-minute intake recall | rejected: main's recall ends a start the runner still queues; here the Queued Run shows no clock of its own and the user's Stop bounds it (5.1), and main's 2-minute notice stays a view (32.30) |
| M1: deletion test on the send cleanup, the Tombstone cleanup, the wake deadline and 5.1's second deadline | chosen: each reappears as one clause of L6 |
| M2: seam placement, L6 in 3.7 beside the alarm, keyed by the label the fence, L5 and the gate already use | chosen |
| M3: depth, one rule read by 3.5, 3.8, 5.1, 8.3 and 8.4 | chosen |
| M4: design it twice, a deadline per holder against one per label | chosen per label: per holder needs an exception at every hand-off |
| M5: an owner table for every piece of Run, input, label and fence state | chosen as the check |
| M6: LI2 commutation of L6 against Stop, Run end, late acceptance and result orders | chosen as the check |
| M7: one defining clause per value, a logged reader sweep before each review, exhaustive switches on 3.13 | chosen: the drift check |

<!-- src: REDESIGN-6 2026-10-30 (/private/tmp/r32-redesign-6); REDESIGN-6 review round 1 (ub, poteto, fix-r1); REDESIGN-6 review round 2 (ub, poteto, fix-r2); REDESIGN-5 review round 3 (ub, poteto, /private/tmp/r32-redesign-5); REDESIGN-4 reviews (/private/tmp/r32-redesign-4); main at 1ba91324; R2 at 6c9ff950; competitors t3code 6d450a4284, bb 3bacfac9ed, paseo 1aef1ec66, zeron a0468502, diri 1e1daed3, monocode 97b5939e -->

### A.17 REDESIGN-7 The stop (2026-10-30): the stop + M8 to M12

Decided autonomously under the Review Rounds rule after REDESIGN-6's three review rounds with
material findings (r1 9, r2 13, r3 9), the fifth redesign in a row. Root cause: what a Stop bounds
(its deadline, its step and its end) was owned by what it bounds, a Run's phase, a send, a wake
execution, a label, then a label's work episode, never by the Stop, as main's per-session
`stopping` entry owns it (provider-turn-service.ts 363-371 at 1ba91324). Each holder had its own
anchor, re-arm or exhaustion, so a value had no owner or two (REDESIGN-6: 12 of 31 material
findings), an arrival order between holders gave two outcomes (5) or an outcome worse than main
(3), and each move left a stale reader or ticket (11) that only prose review looked for. Chosen: label work has no clock, and a session has
at most one open stop that owns the deadline, the deadline step and the end (L6, D54); Runs,
sends, wake executions and `end_session` only feed it. Each r3 finding is a reading of it:
- a Run end moves nothing, as the deadline is the opening commit's and never moves (ub P1-A,
  poteto P2-2);
- 4.6's host interrupt acts at receipt on the turns it names and on its runs' accepted, unstarted
  commands, so nothing outlives the interrupted turn, as main clears at the result (ub P1-B,
  poteto P1-2);
- the commit resolves the Pending interactions on the labels it adds (3.10), as main rejects them
  at interrupt (poteto P1-1, ub P3-3);
- a Run-less `end_session` joins the open stop or opens a new one, so a deadline step escalates
  it (poteto P2-1, D4 amended);
- delivery is the interaction's work, never a Run's, so 3.10 holds no Run open (poteto P2-5);
- the probe cap ends only that probe with no finding; the deadline step, not a probe column, ends
  OpenCode work (ub P2-C);
- condition 3 and `deadline expired` are gone with the Run's deadline (ub P2-B);
- `settleMs` is main's 7 s (P3-2); the stale readers are rewritten in the M10 sweep (ub P2-A,
  P2-D, poteto P2-3, P2-4).

Derived: L6 is label work plus the stop (3.7). D54 is the stop. E1, the Run's end after Stop, is
3.8 condition 1 or 2 with reason 2.1, forced when the deadline step ended its work; `end` in
reason 2.1 and in its readers in 3.6, 3.7 and the D50 and D52 amendments reads that clause
(poteto r1 P2-1). E2, one deadline and
one end per label, is now one per session: the stop. D47's wake is label work with its own end
(8.3), bounded from a Stop by the stop. D50 reads the stop's deadline step as a kill (L2 item 1);
D51 loses `deadline expired`; D52's covered send waits on a pending kill with no deadline, its
kill sealing only by its own `process_lost` (3.6); D53 and D55 read no stop state and stand. The
REDESIGN-5 and -6 amendments that read a phase deadline, the episode, a close or the column (SPEC
Stop, SPEC Deadlines, D28, D43, 82tn.32.2.14) are rewritten to the stop in place, and six new
amendments (D1, D4, OPEN-5, FB §4, then SPEC One active run in review round 1 and HLK 10B in
review round 2) are added.

Review round 1 (ub 4 with 2 P1, poteto 7, 8 unique) found one seam: the stop took its end from
its items, not its step, so an item gained after the step was never stepped. Fixed in L6 by a
second end, once the deadline step had issued, which review round 2 deleted (below), and a later
commit or `end_session` opens a new stop. Derived from it:
- an `end_session` after the step opens a new stop and is stepped (8.4; ub P1-1 trace C);
- a late acceptance after the step is outside the ended stop and runs, as on main (ub P1-1 trace
  B; M11);
- the OpenCode step ends every send, execution and wake execution of the stop's Runs and labels
  issued before the step, the commit's own abort and `cancel_request` included, so they need
  no membership rule (ub P1-1, poteto P2-5);
- work gained after a commit is outside that commit's adds in either arrival order, so M9 asserts
  equality for the work each commit adds (poteto P2-4, Fix B);
- 3.11, 3.6 and the D52 amendment lose their false bounds (poteto P2-2, ub P2-1), and 8.4 joins
  the open stop.

Not derivable from L6, so stated: a message sent while the active Run is Interrupting is not a
steer (3.9; the step bounds work, not admission; ub P1-1 trace A); an answer in delivery is not
resolved by the commit and an async question by nothing (3.10; L6 says what the stop holds, not
who answers; ub P1-2, poteto P2-3).

Review round 2 (poteto 8 with 2 P1, ub 5, 8 unique) found one seam: the stop held Runs as items,
but a Run's end lags its work's (at its kill's `process_lost`, or for OpenCode at nothing), and
5.1, 8.4, 3.9, 3.10 and M11 stated what follows the step as if the step finished it. Fixed once
in L6 and 3.8: the stop's items are work, not Runs, so it ends when its items end, the step at
the latest, and the step clause goes; 3.8 condition 2 reads the step, so an OpenCode Run ends
there. Derived from it:
- a killed Run ends by 3.8, at its kill's `process_lost` while a start or steer is unsealed (5.1,
  8.4; ub P2-A, poteto P2-1);
- an OpenCode Run ends once the step ends its work, so 5.1, reason 2.1, section 9 and 3.11
  agree (poteto P1-1);
- a Stop between a kill's issue and its `process_lost` finds none of that runner's work and opens
  no stop, so no dead countdown, as main's Stop joins the pending retirement (poteto P2-2);
- the step reaches by order, before the step: a kill ends all its runner holds by coverage, and
  the OpenCode step all work of a Run or label with an item, as main's `stop_unconfirmed` ends its
  Stop's owner runs (poteto P2-3, ub P3-3, P3-4);
- an Interrupting Run after the step shows no deadline, and nothing asks whether a step that
  issues nothing has issued (ub P3-5, P3-6 moot).

Not derivable, so stated: an answer resolves at its delivery's unconfirmed end too, in a stop or
not, as main deletes the entry when the answer is taken (3.10, 10B amended; poteto P1-2, ub
P2-C); the pause anchors at admission, so an explicit send (Run now, or a message sent idle or
while Interrupting) runs next and the stopped inputs wait for Resume (3.9 D51; poteto P2-4, ub
P2-B).

Methods. Prose review alone found every one of the five kinds below, and each fix moved a value
past readers no one listed. Each kind now has a mechanical check, run before each review round
once its ticket lands (M9 does not exist yet; M10 runs from
/private/tmp/r32-redesign-7/m10-sweep.sh with its allow-list until 32.2.18 checks it in), owned by
a ticket whose acceptance is the check:
- M8 (32.2.3): 3.13's unions and the oracle are normative for state and its owner; the prose is
  rationale and host facts. Acceptance: each owner-table row below that is ledger state is one
  oracle state field with one writing function, and a second writer fails a test (kind K2); the
  host and schedule rows (a native turn, 4.6's interrupt mode, the cut-off and schedule) are
  checked by M11.
- M9 (32.2.17): a bounded arrival-order gate over the oracle decider. For each trace up to 6
  settlements from the input-kind catalogue, every order of independent settlements is decided.
  Acceptance: every order gives the same Run ends, reasons, input states and stop end for the
  work each commit adds (K1); in every order the stop and every label's work end once their
  evidence or the deadline step arrives (K2, an item with no owner never ends); and against a
  model of main (one `stopping` entry per session that ends when its retirement returns or its
  `stop_unconfirmed` settles, a Stop before then joining it, a 30 s deadline, retire or
  `stop_unconfirmed` of its owner runs and lift; its interrupt cleared at the interrupted
  turn's result, claude-runner-payload.ts 2420; its interaction cancel, unanswered only, at once
  while awaiting the user or after an accepted interrupt, 2995-3034, async questions never, at
  1ba91324), no Run ends later, no kill comes later and no input pauses that main would run (K4),
  save the rows of M11's table.
- M10 (32.2.18, no oracle dependency): a reader sweep. A script takes the terms on the latest A
  block's "Terms changed" line and prints every hit in CONTRACT.md outside Appendix A history
  (A.11 to A.16), src comments and Rejected clauses, and in `bd show --long` of the run-ledger
  beads; it exits non-zero on any hit not in a checked allow-list, each entry classed history,
  rejected, unrelated or pointer (K3, K5).
- M11 (32.2.17): the deltas from main, the only differences M9 allows: the fence (a start waits
  for label work, D54; main may fail it after 2 minutes); a stopped Claude start queued behind the
  pause (S9.3, ratified); 4.6 addressing by label and run, where main interrupts its one query
  (equal outcome); after a Run now or a message sent idle or while Interrupting, what a stop or
  failure queued waits for Resume, where main's new handoff drains it (session-inbox.ts 272-284,
  322-337, 561 at 1ba91324; S9.3 kept); a message sent idle waits on `limited`, where main's hands it
off (session-inbox.ts 260-284); work gained on a held label after a commit is not an item,
  as on main; a Stop resolves an OpenCode interaction at its commit, where main shows it until
  OpenCode's reply event (opencode-runtime-event-translator.ts 242-266 at 1ba91324); a later Stop
  while the stop is open adds its work, where main's join adds none, and one between a kill's
  issue and its `process_lost` opens no stop, where main's joins the pending retirement (equal
  deadline and kill).
- M12 (32.2.3): each ticket's acceptance names the owner-table rows it implements, and M10 runs
  over its note (K5).

Terms changed (M10 reads this line; each backticked item is a literal, case-insensitive search;
a live hit of a deleted term is stale, of a changed one a reader to check): deleted or renamed,
`work episode`; `exhaustion ends`; `at exhaustion`; `fence-expiry`; `` `close` ``; `closeMs`;
`livenessMs`; `liveness budget`; `condition 3`; `deadline expired`; `deadline_expired`;
`phase deadline`; `phase clock`; `Running deadline`; `Starting deadline`; `Interrupting deadline`;
`interrupt deadline`; `label deadline`; `wake deadline`; `latestRunId`; `settle expiry`;
`probe column`; `stop sequence`; `issued before the deadline`; `whichever is first`;
`has not issued`; `Ended Interrupted, forced`; `Interrupted forced`; `proceeds normally`;
`ends at its step`; `so it waits for Resume`; `latest handoff`; changed, `settleMs`;
`DeadlineOwner`; `under the cap`; `deadline step`; `has issued`; `before the step`;
`stop ends`; `stop's end`; `open stop`; `new stop`; `joins the stop`; `opens the stop`;
`adds to the stop`; `in the stop`; `stop's Runs`; `outside the stop`; `ended its work`;
`seals nothing`; `steers into`; `is Interrupting`; `while Interrupting`; `past the pause`;
`waits for Resume`; `handoff`; `` Run now or `end` ``; `resolved at that commit`;
`resolves every interaction`; `unanswered`; `in delivery`; `by its delivery`; `lastRefusal`;
`async question`; `delivery: async`; `` `stopping` entry ``; `stop_unconfirmed`;
`owner runs`; `363-371`; `Run-less`; `Stop or Run now`; `32.2.18`; `D54`.

Rule count against HEAD (A.16's lists as the base, by the same convention): deleted from A.16's
additions, the work episode, exhaustion ending it, `closeMs`'s value, Claude's close for a wake,
and 4.6's interrupt until the query's next unrecorded run with its late-interrupt test; deleted
HEAD rules, the `close` effect and its readers, condition 3 with `deadline expired`, 3.10's answer
holding a Run open, 3.10's settle-expiry consumption, the OpenCode fence-expiry probe and its idle
proof, and a Run's own Interrupting deadline; added, the stop (its adds, deadline and end), its
deadline step, 4.6's at-receipt interrupt with its command marks, a Stop resolving its labels'
Pending interactions, `settleMs`'s value, and `end_session` joining or opening the stop; added
by review round 1, a message sent while the active Run is Interrupting queued and not a steer
(3.9), an answer in delivery resolved by its delivery's confirmation or the host (3.10), and an
async question never resolved by a commit, retirement or session end (3.10); added by review round
2, 3.8 condition 2 reading the deadline step (an OpenCode Run's end), a message sent with no
active Run passing the pause (3.9, D51), and an answer resolved at its delivery's unconfirmed end
(3.10, 10B amended). Deletions 37 + 6, additions 47 - 5 + 6 + 3 + 3: 43 deleted and 54 added, 11
net added, against A.16's 10. Net in this redesign: 12 deleted (with round 16's handoff anchor of
the pause), 13 added (with the admission anchor). Rewritten in place with no count against HEAD
(each an addition of this redesign): the stop's items (work, never a Run) and its end (at its
items, the step at the latest, then a new stop; review round 2 deleted the step clause), the
step's reach (before the step), `end_session` joining the open stop, the commit's interaction
resolution (unanswered only), and the Interrupting message running next past the pause.
Restatements: the deadline tags, the Interrupting Run showing the stop's deadline, a capped probe
ending with no finding, the wire label without `close`, section 9's membership without its column,
an empty commit opening no stop, `end` in reason 2.1 and its readers, the seal and outage bounds,
8.3's Stop bullet and admission as pointers, 5.1's and 8.4's killed Run ending by 3.8, 5.1's,
3.11's and section 9's OpenCode Run ending by 3.8, and D4's and 8.4's escalation as pointers.

| State | Owner |
|---|---|
| Run end and its reason | 3.8 (a Queued Run's by its clause there) |
| Unlaunch | 3.6 (D50) |
| Retry pending | 3.6 |
| Coverage | L1, L2, 3.4 (session end); read by 3.5 |
| Seal | 3.6 (D52) |
| Input place | 3.9 (D53) |
| Input state, cancel included | 3.9 (D53, D55); values in 3.13 |
| Pause | 3.9 (D51, anchored at admission) |
| Wake execution, start and end | 8.3 (D47) |
| Label work: whether a label has it, and its end | 3.7 (L6), from 3.5's and 8.3's evidence |
| The stop: its items (work, never a Run), deadline, deadline step and end (at its items' end, the step at the latest) | 3.7 (L6, D54) |
| What a commit names | the stop's adds (3.7); the wire and the turns it reaches, 4.6 |
| Host interrupt mode | 4.6 (at receipt; none outlives the turn it names) |
| A native turn | the runner host; the ledger records only its evidence (3.4) |
| Interaction and its Pending state | 3.10 (its label's; unanswered ones resolved by the stop's commit, retirement or session end; one in delivery by its delivery's confirmation, the host or its delivery's unconfirmed end; async never) |
| Steer or queue for a new message | 3.9 (a steer only into a Launched user Run) |
| Probe and its cap | 3.7 |
| Settling | 3.7 (`settleMs`) |
| Alarm | 3.7 (one per session row) |
| Work ended | 3.5, from 3.4's evidence |
| Fence | section 9 membership; held while a label has work (3.5 `fenceHolds`) |
| Confirm gate | 8.4 (L3, D43) |
| Lost work | 8.4 (L5) |
| Transmission count | `holdRun` within its input's reservation (4.8, 32.29) |
| Cut-off and schedule | outside the ledger (3.9) |

Open risks: before a Stop nothing bounds a Run or label work, as on main; main's 2-minute silence
notice reads no ledger value and stays with the view (32.30). A Queued Run waits for the label work
blocking it, or the user's Stop, where main may fail its start `processing_timeout` after 2
minutes (D54, M11). Work gained after a commit is not an item until the next Stop, Run now or
`end`, though the deadline step reaches it (L6); the fence holds behind it, as main's next send
waits on its busy query. A Pending
interaction on a label the stop does not hold stays Pending until a later commit, retirement or
session end. 4.6's label and run addressing and its command marks are 32.5 host work, absent at
1ba91324 (claude-runner-payload.ts 2892) and 6c9ff950 (2820, 2828), which match input ids; a wake
turn running on a named label at receipt is interrupted, as main's interrupt reaches its one
query. Whether Claude raises a permission or question on a wake turn is uncaptured (3.10 owns it
either way). Whether Claude emits an unsolicited turn start inside a user turn, and whether a wake
turn's `result` after a uuid-bearing prompt names no `user_message_uuid`, are open (9). A Claude
start after a wake's result may reach a query still writing, as on main. A stopped Claude start's
text is queued behind the pause where main drops it (S9.3 as amended, ratified). If the Claude SDK
reports `cancelled` before `started` with no Stop, its Run ends `interrupted` (3.8 reason 2.1),
which pauses (D51), as main's `turn.interrupted`; unobserved on main. The run-ledger model and the
oracle still carry the episode, `close`, `closeMs`, `livenessMs` and `deadline_expired`
(32.2.2, 32.2.3); M9 does not exist yet (32.2.17), and M10 runs from /private/tmp until 32.2.18
checks it in; it finds only listed terms, so a reader of a changed value that shares no listed
term stays unfound. `holdRun` at
6c9ff950 counts `run.dispatched` by `commandId` session-wide (runner-retirement.ts 152-215); 32.29
owns the change. A.14's same-driver failover risk stands with no deadline: the cut-off runner's
other held inputs wait for their answers or the user's Stop. So does a covered send waiting on a
pending kill whose hold never comes (D52). Stop membership of a wake that starts at the commit is
order-dependent; bounded by the next Stop. Whether OpenCode's abort rejects a pending permission
or question natively is unverified (no OpenCode source here); if it does not, main shows it until
OpenCode replies and the ledger resolves it at the commit (M11). After a Run now or a message sent
idle or while Interrupting, what a stop or failure queued waits for Resume where main's new handoff
drains it (D51, M11); an explicit message still waits on a usage-limit cut-off or a schedule, which
Run now passes, where main's message passes `limited` (M11). An Interrupting Run whose stop has ended (its kill issued, its start unsealed)
shows no deadline until its `process_lost`.
Prior art (what a Stop bounds and how an interrupt is scoped): main keeps one `stopping` entry per
session, joined by later Stops, with one 30 s deadline; t3code stores a per-run interrupt flag
never cleared and refuses a later tool call on that run; paseo clears its interrupt at the next
`result` or `system/init`; bb holds a `stopping` state until the stop settles and closes the whole
session; zeron supersedes a command by `based_on.turn_id` and reaps idle runtimes; diri has no Stop
state. Source: /private/tmp/r32-redesign-7/survey.

| Option | Verdict |
|---|---|
| h: one stop per session owns the deadline, step and end; label work has no clock | chosen: every r3 finding is a reading of it, and it is main's `stopping` |
| a: the round 3 reviews' narrow fixes (a fixed anchor, a 4.6 clear, a Stop rejection, an end deadline) | rejected: four more holder clauses, the move each redesign made |
| b: one lifetime per native query turn scoping interrupt, interactions, probes and the budget | rejected as the owner: a Stop bounds a session, not a turn, and the budget must not re-anchor per turn; kept for 4.6, whose interrupt acts on the turn it names |
| c: the ledger owns inputs and Runs, the runner host the rest | rejected: two owners of the fence, and OpenCode has no runner host |
| d: the typed model or oracle normative, the prose rationale | adopted as M8, not as a seam: it checks owners but decides no rule |
| e: arrival-order exploration as the review gate | adopted as M9 |
| f: a contract of deltas from main | adopted as M11 for what M9 allows; the whole contract is not cut, as the ledger's fence and inputs have no main counterpart |
| g: every execution a Run | rejected: two active Runs, or a Run held open past its result |
| i: main's per-session map with no label work | rejected: without label work the fence releases onto a query still writing |
| j: t3code, a per-run interrupt flag never cleared | rejected: a later wake on that run is refused, worse than main |
| k: bb, a stopping state that closes the whole session | rejected: a Stop ends the session's query where main keeps it |
| l: zeron, commands superseded by `based_on` turn ids | rejected: a new identity on the wire; a Stop before the wake's entry still runs |
| h-join: the stop holds only what its first commit named | rejected: a Stop pressed while it is open does nothing for a wake started since |
| deletion test on the episode, column, `closeMs`, exhaustion, condition 3 and the settle consumption | chosen: none reappears, each is a reading of the stop |
| design it twice, a deadline per holder against one per session | chosen per session: per holder needs a re-anchor or re-arm at every hand-off |
| seam placement, the stop in 3.7 beside the alarm, read by 3.8, 4.6, 5.1, 8.3, 8.4 and 9 | chosen |
| depth, one rule with its adds and one step | chosen |
| verification, M8 to M12 as ticket acceptance (32.2.3, 32.2.17) | chosen: the check runs before review, not in it |

<!-- src: REDESIGN-7 2026-10-30 (/private/tmp/r32-redesign-7); REDESIGN-7 review rounds 1 and 2 (ub, poteto; r2 at 1ba91324: provider-turn-service.ts 207-222, 251-320, 363-374; session-run-settlement.ts 68-72; orchestration-engine.ts 1158-1161; orchestration-side-effect-reactor.ts 1417-1424; pending-interaction-service.ts 400-430; session-inbox.ts 236-340, 561); REDESIGN-6 review rounds 1 to 3 (ub, poteto, /private/tmp/r32-redesign-6); REDESIGN-4 and -5 reviews; main at 1ba91324 (provider-turn-service.ts 207-321, 335-336, 363-373; claude-runner-payload.ts 2351, 2420, 2958-2972, 2997-3002, 3024-3034, 3245; retire-pending-prompts.ts 39, 44-58, 131; pending-interaction-service.ts 400-415, 449-500; session-inbox.ts 189-203, 263-276, 300-305; codex-item-mapper.ts 528-585; opencode-provider-instance.ts 702-724; opencode-runtime-event-translator.ts 242-266; env.ts 147-150; session-status-poller.ts 25-26); R2 at 6c9ff950; competitors t3code 6d450a4284, bb 3bacfac9ed, paseo 1aef1ec66, zeron a0468502, diri 1e1daed3, monocode 97b5939e -->

### A.18 REDESIGN-8 Main as the reference (2026-10-30): D56 + T1 to T4

Decided autonomously under the Review Rounds rule after REDESIGN-7's three review rounds with
material findings (r1 8, r2 8, r3 5 unique), the sixth redesign in a row (R4 17, 18, 23; R5 25, 9,
4; R6 9, 13, 9; R7 8, 8, 5). Root cause: unchecked copies. Each value lives in several places,
main's code restated in "as main" clauses, a prose model (M9) and a delta list (M11), and a rule
restated in pointers, other sections, tickets and the recount, and only prose review compared
the copies. Each redesign moved a value and review found the copies that had not moved, or had
copied too little: of R7's 21 material findings about 10 were stale readers or tickets (K3, K5),
about 8 a wrong or incomplete record of main or a result worse than main (K6, K4), and about 4
arrival order or owners in new vocabulary (K1, K2). Neither r3 review found a defect in the stop
itself; the seam moved each redesign (the send wait, the wake owner, label identity, the stop,
the record of main) while the generator, prose checked against prose, stayed.

The user's decision of 2026-10-30, "Match main", is D51 and S9.3 as amended (3.9); the round 1
decisions of the same day are applied in place (3.9, L6, 2.1, this block).

Read as main, each still its own rule and counted: L6, D54, E1 and E2 are main's `stopping` entry
(cited at L6's End and in D54) plus 2.1 rows 203 to 205; D55 is main's Cancel arm; D51's arms are
main's; D53 is main's requeue plus rows 206 and 207; 10B is main's delete on take; the S9.3 and
SPEC One active run amendments read D51. Kept as their own rules, with no main counterpart: D47
(wake executions), D50 (relaunch, as R2 at 6c9ff950: orchestration-side-effect-reactor.ts 1337,
1372), D52 (the seal) and the fence.

Methods. M8 to M12 are replaced by four checks, each a ticket acceptance, each run before a review
round once built:
- T1 citation check (32.2.18): every citation of main or R2 resolves to one file at its commit, is
  in range, and each backticked anchor in its clause occurs in the cited lines (2 lines of slack).
  It exits 1 on any unresolved, out-of-range or anchor-missed citation not on its allow list, each
  entry with a reason. It parses `file.ts 12-34, 56`, `file.ts:12-34`, `file.ts at <sha>: 12`, a
  bare `:12` after a colon form (that form's file), and a bare range in a parenthetical, which
  names a file only when that file is cited in its own parenthetical or clause (back to the latest
  `; `, `. ` or table `|` outside parentheses), a preceding `<file> <range>` in the same list
  included; any other bare range is unbound, listed with no file, never credited to the last file
  named. A section number (`S9.5`, `3.9`), a bare single digit or a row list is never read as
  lines. The commit is an `at <sha>` in the same clause, else the latest sha before it in the
  paragraph, else 1ba91324 (D56). A citation marked `in 3223`, `in 3224` or `in this worktree`, or
  led by `3223 ` or `3224 `, is not main and is skipped; src comments are checked for range only.
  It prints the 2.1 rows' citations. A citation with no anchor, or unbound, is listed, not gated,
  until 32.2.18 anchors them, before the contract commit (233 with no anchor and 29 unbound at
  this round; of the 225 with no anchor before it, 32 are unbound under the binding rule and 6 were
  not citations, and 4 that passed are unbound). Once 32.2.18 anchors every citation with the
  token it claims, T1 checks that each cited range exists and contains its claimed token; it does
  not check that the code supports the sentence. Catches K6 drift.
- T2 (32.2.17): replaced by A.19 T2, the replay at the provider wire; its translation rows, its
  field-by-field view and its gate are deleted (A.19).
- T3 reader sweep (32.2.18): the M10 sweep over CONTRACT.md, A.11 to A.17 included, and every bead
  12.2 names (not only the 32.2 children), with each bead's pending notes read as appended, under
  `bash -o pipefail`; every allow entry is 40 or more characters and names its class. Its recount
  check reads the newest round's header against its bullets, and its rule counts against A.17's
  base plus this block's itemized lists. Catches K3 and K5. Gates the next review round.
- T4 owner check (32.2.3): each owner-table row that is ledger state is one oracle field with one
  writing function; a second writer fails a test. Catches K2. Gates 32.2.9.

Terms changed (T3 reads this line; each backticked item is a literal, case-insensitive search;
a live hit of a deleted term is stale, of a changed one a reader to check): deleted or renamed,
`admitted at or before`; `anchored at admission`; `admission anchor`; `A.17 M`; `M8 to M12`;
`M9`; `M11`; `M12`; `retirement returns or its`; `363-371`; `main's predicate`; `no Resume since`;
`Resume clears`; `resume clears only`; `queues behind a wake`; `kind: "resume"`; `psr.ts`;
`latest input Run`; `never an input Run`; `newer send's Run ends`; `Codex or Cursor wake`;
changed, `front of the inbox`; `Paused`; `pass the pause`; `past the pause`; `passing
the pause`; `waits for Resume`; `wait for Resume`; `latest handoff`; `limited`;
`stoppedSinceHandoff`; `no active Run`; `oldest queued`; `stop is open`; `interruptRequested`;
`decideInbox`; `unconfirmed end`; `promptOpen`; `open_prompts`; `marked`; `inbox front`;
`admission position`; `steerBlocker`; `send_now`; `32.2.17`; `32.2.18`; `D51`; `D56`.

Rule count against HEAD, by A.17's convention, itemized (T3 counts these bullets):
- Base, A.17: 43 deleted, 54 added.
- Deleted from A.17's additions: D51's pause anchor, replaced by D51 as main's decider.
- Deleted HEAD rule: a message steers into an active user Run but waits behind a wake Run (3.9),
  now D51's Submit arm and its `busy` field.
- Deleted HEAD rule: Resume ends only an ordinary pause, now D51's SendNow arm.
- Added: D51 as main's `decideInbox` over main's `InboxView` (3.9).
- Added: D56 with 2.1.
- Result: 45 deleted and 55 added, 10 net added, against A.17's 11.

The review round 1 figure, 43 and 55 with 12 net, is before the two HEAD deletions. Rewritten in
place, counting nothing: D51's Submit and SendNow arms and its view, D53's admission position, the
failed steer, L6's `stopping` window, S9.3 and SPEC One active run (both among round 16's 27).
Restatements: L6's and D54's record of main's entry, the 2.1 rows (each restates the rule it
names), 3.6's advance as a pointer to D51, F51, F57, 4.8's `end`, Q9, Q10 and the 32.8 and 32.9
rows.

Review round 2, itemized, net 0: deleted row 208 (a restatement of a difference, now D51's `busy`
and Handoff, counting nothing); no row added; rewritten in place, counting nothing: D51's view (the
source rule; the stop term's latest send, `steering`, `busy`, `promptOpen`, the displayed `paused`),
its Handoff for a Codex wake Run, D53's late decline and D55 as a pointer; amendment bullets added
for HLK 9B and AUDIT-2 wake admission, 25 to 27, which count no rule. 45, 55 and 10 stand.

The owner table, the expectation changes and the open risks of this round are replaced by
A.19's; under D57 the oracle's inbox expectations are computed by main's module, so A.19's list
confirms them and is not normative.

Prior art (how others specify behaviour against a reference implementation): bb runs a two-checkout
parity over recorded bridge wires with an allowlist whose stale entries fail; diri keeps the old
core beside the new with differential tests until parity; monocode includes the legacy source in
its tests; zeron and monocode keep parity tables of gaps only; paseo cites file and line in MUST
prose that has drifted; t3code states invariants no test reads. None checks citations, links rule
ids to tests, runs the old behaviour as a model, or writes the spec as deltas; bb's allowlist is the
nearest to 2.1. Source: /private/tmp/r32-redesign-8 (survey of t3code aa11ef6783, bb a1bf55b6a0,
paseo deb1bdc26, zeron d643a2ca, diri 4a863c2a, monocode 8ba5863e).

| Option | Verdict |
|---|---|
| b: main at 1ba91324 the only reference, every claim a checked citation | chosen (D56, T1) |
| c1: main's pure `decideInbox` vendored and run against the oracle | chosen (T2): main's own code cannot miss an arm |
| c2: a cited hand model of main's stop and interactions | chosen (T2), with the residual risk above |
| c3: recorded main traces as the reference | rejected as a gate: needs live providers per case |
| d: deltas from main for user-visible behaviour | chosen (2.1); the core state stays normative, having no counterpart |
| e: build the checks now and gate review on them | chosen: T1 and T3 now, T2 after 32.2.3 |
| h-freeze: no new state or vocabulary | chosen: D51 gains a view, no new state |
| a: the r3 reviews' narrow fixes | rejected: more uncited copies, and the per-input hold contradicts the user's decision |
| f: the oracle normative for behaviour | rejected beyond T4: it still carries `close` and `closeMs` |
| g: the ledger owns inputs and Runs only | rejected: two owners of the fence, and OpenCode has no runner host |
| i: bb's recorded parity as the gate | rejected for now: needs recorded wires per provider |
| j: a per-input hold | rejected: contradicts the user's decision |
| k: a stored pause flag cleared at handoff | rejected: two writers of a fact main derives |
| l: diri's shadow mode in the daemon | rejected for now: wiring cost; T2 covers the pure part |
| seam placement: citations at the code boundary, the deltas beside the owners in section 2 | chosen |
| depth: one reference rule and one table | chosen |
| deletion test on the prose model, the delta list and the admission anchor | chosen: none reappears, each is main's code or a 2.1 row |
| design it twice: three pause anchors (admission, per input, handoff) and three reference forms (prose, cited model, main's code) | handoff and main's code chosen |
| verification: T1 to T4 as ticket acceptance | chosen |

<!-- src: REDESIGN-8 2026-10-30 (/private/tmp/r32-redesign-8); user decision 2026-10-30 (Match main, on 82tn.32.2); REDESIGN-7 review rounds 1 to 3 (ub, poteto); main at 1ba91324 (session-inbox.ts 73-106, 166-235, 236-340, 452-573; inbox-run-status-query.ts; projectors-effect.ts 1845-1847; provider-turn-service.ts 198-206, 241-292, 294-320, 335-338, 363-374, 376-405; orchestration-side-effect-reactor.ts 790-830; runner-turn-failure.ts 75-84; opencode-runtime-event-translator.ts 242-266); review round 1 (ub, poteto, /private/tmp/r32-redesign-8/review-*-r1-out.md); review round 2 (ub, poteto, review-*-r2-out.md; session-inbox.ts 538-545; codex-runner-payload.ts 301, 315, 908; claude-runner-payload.ts 2532-2539; read-query-effect.ts 2625-2663; permissions.ts 443-465, 700-720; cursor-runner-payload.ts 262-264, 314) -->

### A.19 REDESIGN-9 The inbox is main's module (2026-10-31): D57 + the wire replay

Decided autonomously under the Review Rounds rule after REDESIGN-8's three review rounds with
material findings (r1 17, r2 18, r3 4 unique), the seventh redesign in a row (R4 17, 18, 23; R5
25, 9, 4; R6 9, 13, 9; R7 8, 8, 5; R8 17, 18, 4). Root cause: the account of main is a copy.
REDESIGN-8 named main's code the reference (D56) but kept a hand derivation of it: D51's view said
which ledger fact matches which main write, field by field, and T2's translation rows said the
same for the facts the oracle could not write; every round found that derivation wrong somewhere,
and round 3's P1 (`steering` ended at its Run's end, where main ends it only at `message.created`,
a requeue or a decline) is the plainest. The seam is the inbox's read surface: what main's module
reads, and who writes it. D57 removes the derivation: the inbox is main's module, unchanged, and
the ledger reaches it only as main's run seam (D57); a replay of the same provider wire through
both stacks, not a review, finds a difference.

Findings of REDESIGN-8 (K1 an arrival order with two outcomes; K2 zero or two owners; K3 a stale
reader; K4 worse than main; K5 a ticket against the contract; K6 a wrong or incomplete record of
main), each with the concept whose absence made it necessary:

| Round, finding | Kind | Missing concept |
|---|---|---|
| r1 1. Admission steers unconditionally (ub P1-A, poteto P2-1) | K6 | main's Submit arm as the one admission owner |
| r1 2. `promptOpen` counts async questions (ub P1-B, poteto P1-B) | K6 | main's `promptOpen` read, not copied |
| r1 3. Resume is not main's command (ub P1-C, poteto P2-5) | K6 | Resume as main's SendNow of the head |
| r1 4. Wake Runs contradict main's decider (ub P2-D) | K6 | main's `busy` per provider |
| r1 5. The stop's membership and length differ from main (ub P2-E) | K6 | main's `stopping` window as a read of L6 |
| r1 6. Deleting Interrupting regresses the kill window (poteto P1-A) | K4 | the window main's entry holds |
| r1 7. A failed steer has no 2.1 row (ub P2-F) | K6 | a writer per ledger outcome |
| r1 8. T1 and T2 cannot fail (ub P2-G, poteto P2-10) | K3 | a check that runs |
| r1 9. 2.1 carve-out and missing rows (ub P2-H, poteto P2-4) | K6 | rows as typed masks a run checks |
| r1 10. Recount (ub P2-I, poteto P2-8) | K3 | a recount a tool reads |
| r1 11. Expectation list (ub P2-J, poteto P2-9) | K6 | expectations computed by main's code |
| r1 12. Restatements contradict the decider (ub P2-K, poteto P2-7) | K3 | pointers, not restatements |
| r1 13. 11.2 contradicts 3.7 (ub P2-L, poteto P2-12) | K3 | one owner per clause |
| r1 14. `interruptRequested` ends early (poteto P2-2) | K6 | main's mark, read |
| r1 15. D53's front placement, order with two owners (poteto P2-3) | K2, K6 | main's projector as the one order owner |
| r1 16. `stoppedSinceHandoff` citation wrong (poteto P2-6) | K6 | main's displayed `paused`, read |
| r1 17. Ticket mismatches (poteto P2-11, ub T-1 to T-10) | K5 | beads that cite, not restate |
| r2 1. A steer into a wake Run is not a send (ub P1-1) | K6 | `run.requested` written for every send |
| r2 2. Row 208 strands a Codex-wake message (ub P1-2) | K4 | main's idle handoff behind the fence |
| r2 3. T1 bare ranges misattributed (ub P2-1) | K3 | a binding rule for bare ranges |
| r2 4. T3 skips the second id (ub P2-2) | K3 | a sweep over every 12.2 id |
| r2 5. T2 compares neither (ub P2-3, poteto P2-3) | K6 | a comparison on main's own output |
| r2 6. The RL-041 note (ub P2-4, poteto P2-5) | K6 | expectations computed by main's code |
| r2 7. Restatements of the pause lift (ub P2-5, poteto P2-1) | K3 | pointers, not restatements |
| r2 8. `steering` never ends (poteto P1-1) | K6 | main's `steering`, read |
| r2 9. `promptOpen` counts answered interactions (poteto P1-2) | K6 | the answer commit as `promptOpen`'s writer |
| r2 10. A late decline has two places (poteto P2-2) | K1 | `steerDeclined` as the one writer |
| r2 11. The displayed paused (poteto P2-4) | K6 | `readInboxState`, read |
| r2 12. Amendment count 27 (poteto P2-6) | K3 | a recount a tool reads |
| r2 13. Row 213's ticket (poteto P2-7) | K5 | beads that cite |
| r2 14. The stop has two owners in 12.2 (poteto P2-8) | K2 | one owner of the stop |
| r2 15. Row 212 has two tickets (poteto P2-9) | K5 | one ticket per row |
| r2 16. Missing edge 32.2.17 to 32.2.4 (poteto P2-10) | K5 | deps from the 12.2 table |
| r2 17. 32.2.17's description stale (poteto P2-11) | K5 | beads that cite |
| r2 18. 32.2.3 sends a stopped start to the front (poteto P2-12) | K5 | the oracle running main's inbox |
| r3 1. `steering` ends at its Run's end (ub P1-1, poteto P1-1) | K6, K1 | main's `steering`, and an owner of a late steer's turn |
| r3 2. The expectation list (ub P2, poteto P2) | K6 | expectations computed by main's code |
| r3 3. 32.2.8 and 32.7 contradict row 206 (poteto P2-1) | K5 | beads that cite |
| r3 4. T3 skips parenthetical 12.2 cells (poteto P2-2) | K3 | a sweep over every 12.2 id |

Totals: K6 19 (r1 15 also K2, r3 1 also K1), K3 9, K5 7, K4 2, K2 1 more, K1 1 more: 39.
Verdicts: pattern 1 (the account is a copy) explains the most, every K6 and both K4; pattern 2
holds: a built wire replay would have caught 22 (every K6 and K4, and the late decline), and not
the 17 K3, K5 and the 12.2 K2, which are T3's and T4's; pattern 3 holds in its first form: the
inbox stays main's module (D57).

Options for the seam, each tried against a reachable trace:
- a: the r3 narrow fixes (`steering` ends at `message.created`, a requeue or a decline; the
  expectation list corrected). Broken by: the next field; three rounds each found a new one.
- b: every view field cites main's write and T1 checks the token. Broken by: T1 checks that a
  token occurs, not that the write sets the field under the same condition (r3 1 cites a real
  write, runner-turn-failure.ts 75-84, for a field it does not end).
- c: T2's translations generated by running main's emitters. Kept as the replay's input side: the
  trace is provider wire frames, and main's own translators make the events both sides read.
- d: the ledger emits main's events and main's `readView` and `decideInbox` run unchanged.
  Kept as D57's write side, limited to the run lifecycle events at the ledger's own commits; a
  pure form that emits every main event re-implements main's ingestion.
- e: the inbox stays main's module and the ledger owns Runs, labels, retries, the fence and lost
  work. Chosen (D57). Broken at: a ledger outcome with no main writer (a failed steer, a stopped
  start Claude cancelled), each now a 2.1 row; a steer that outlives its Run, which had no owner,
  now a Run of its own (3.9).
- f: build T2 first and gate review on it. Chosen: T1 and T3 gate every review round; T2 gates
  none (T2, below).
- g: the oracle or typed model normative. Kept for core state only (T4); for the inbox it is a
  second copy of main in another language.
- h: bb's recorded parity over live wires as the only gate. Needs recorded wires per provider and
  case; kept as recorded fixtures per host fact.
- i: diri's shadow mode in the daemon. Real traffic, but wiring cost before the ledger exists.
- ii: the ledger owns the decision, main's module a library. Two owners of inbox state, and the
  view mapping stays.

Methods: seam placement (at main's run seam, not at main's view); depth (one module, main's, behind
one rule); the deletion test (D51's view, the Handoff clause, the stop-term account and T2's
translation rows are deleted and none reappears: each is main's module or a 2.1 row); design it
twice (the seam at the view, D51, against at the writers, D57; the check by prose, by token, by
replay); verification (T1 and T3 as a gate before review, the replay as ticket acceptance).

T2, the replay at the provider wire: superseded by the 32.2.17 row (12.2). T2 is built after the
spike, 32.3, 32.2.3 and 32.2.4, on main's real stack at R2 (6c9ff950). Spec review rounds run
after T1 and T3 exit 0 (32.2.18), not after T2.

Catchers: K1 by T2's permutations (32.2.17), gating; K2 by T4's one writer per owner-table field
(32.2.3), gating 32.2.9; K3 by T3's terms and recount (32.2.18), gating; K4 and K6 by T2's
comparison and its masks (32.2.17), gating for the inbox, Claude and OpenCode first; K5 by T3
over every bead 12.2 names, beads citing sections, and the `pointer` and `owner` allow classes
(32.2.18), gating.

Terms changed (T3 reads this line; each backticked item is a literal, case-insensitive search;
a live hit of a deleted term is stale, of a changed one a reader to check): deleted or renamed,
`D51`; `field for field`; `field by field`; `read view of the ledger`; `translation row`;
`steering row's end`; `ends every steering`; `whose Run ends before its acceptance`; `returns to
the inbox as the next message`; `Codex wake Run with no Run Input`; `joins it as a Run Input
whatever`; `stoppedSinceHandoff`; `send_now`; `admission position`; `through main's writers`;
`A steer its host starts after`; `joins it into`; `the ledger calls them`; `oracle is not
pure`; `stops being pure`; `imported`; `stop's open and end`; changed, `D57`; `32.2.17`;
`requeueFailedSteers`; `joined_into`; `turnFences`; `inbox front`; `no active Run`; `turnEnds`;
`sendTurn`; `beginStop`; `ProviderTurnServiceTag`; `never claims`; `vendored`; `prepareStop`;
`onSteerDeclined`; `nextPendingRequests`.

Rule count against HEAD, by A.17's convention, itemized (T3 counts these bullets):
- Base, A.18: 45 deleted, 55 added.
- Deleted from A.18's additions: D51 as main's `decideInbox` over a ledger view, replaced by D57.
- Deleted HEAD rule: the session inbox is a read view of the ledger, which owns inbox order and
  the pause (3.9), now main's module (D57).
- Deleted from A.16's additions: `cancel_input`'s own state (D55), the InputState `Cancelled`;
  main's Cancel arm removes the input (D55, D57; review round 1).
- Added: D57, the inbox is main's module and the ledger is its run seam (3.9; the seam rewritten
  in place in review round 1, counting nothing).
- Added: a steer that outlives its Run is a Run of its own (3.9, D53; widened in place in review
  round 1 to a Stop that keeps it, an undelivered steer and a Codex steer awaiting its answer).
- Added: the read surface keeps main's schema and projector arms through 32.13 and after (3.9,
  12.2).
- Added: the service boundary, each main service that writes or wakes the module's reads
  unchanged, replaced by the seam calling main's own function, or deleted at a named ticket, the
  claim guard at each switch ticket included (3.9, 3.12; review round 2).
- Added: a wake Run has no main run, and a steer admitted while only a wake Run is active is a
  Run of its own (3.9; review round 2).
- Result: 46 deleted and 58 added, 12 net added, against A.18's 10.

Net rule change, deleted minus added: -12 (46 minus 58); REDESIGN-9 deletes 1 HEAD rule (the read
view), withdraws 2 earlier additions (D51, `cancel_input`'s state) and adds 3; review round 2 adds
2. Review round 2 rewrote in place, counting nothing: D57 without the seam's `turnEnds` publish
(the host's); the Stop commit's restated writes as a call to `prepareStop`; L6's `stopping`
through a failed `requestStop`, as main's entry; the reuse unit run in place with T2's closure
check; 5.3's fourth step as that call; the oracle's inbox deleted (a 32.2.3 scope cut); D53's placers and D57's bullet as
pointers to 3.9; row 207's order; 3.12, 11.2, 11.3 and the 12.2 rows. Review round 1 rewrote in place, counting nothing: D57's
writer list as the seam (every write it names is main's writer, now on main's trigger); the late
steer's five cases (each as main); L6's `stopping` window (main's, through each kill's
`process_lost`); row 206's main column; row 207 (`input.cancelled`, the one main event that removes
a queued row, projectors-effect.ts 2470-2477, restating 3.9's `failed`); row 209 (it restates 8.1,
"Native commands skip the inbox and are never held"); 3.12's transaction; 5.1, F51, 11.2's oracle
and the 12.2 rows as pointers. 3.10 counts nothing: `pending_approvals` stays main's arms, fed by
3.10's resolutions, and REDESIGN-8 r2's async-question `promptOpen` restated main, now D57's.
REDESIGN-9 itself rewrote in place, counting nothing: D53's writers (an amendment bullet, 27 to 28),
2.1 rows 206, 207, 209 and 211 (each restates the rule it names), D56's check, S9.3, SPEC One active
run, HLK 9B and AUDIT-2 as pointers to D57, 3.6's advance, 3.7's `stopping`, 3.13's comments, 9's
wake turn, F51, 11.2, Q9 and the 32.2.3, 32.2.4, 32.2.8, 32.2.17, 32.2.18 and 32.13 rows. Deleted,
counting nothing: the Handoff clause and the stop-term account (both inside D51), A.18 T2's
translation rows, owner table, expectation list and risks.

| State | Owner |
|---|---|
| Run end and its reason | 3.8 |
| Unlaunch | 3.6 (D50) |
| Retry pending | 3.6 |
| Coverage | L1, L2, 3.4; read by 3.5 |
| Seal | 3.6 (D52) |
| Input place | 3.9 (D53): the ledger decides a send's current value, main's writer places it |
| Input state | queued, steering and removed: main's `pending_inputs` (D57); failed: the ledger's Run Input outcome, written to main as a failed `persistUserMessage` for a start and as main's requeue then `input.cancelled` for a steer (3.9, row 207); cancelled: main's Cancel arm (D55) |
| `input.requeued` | main's code: `prepareStop` at the Stop commit, `requeueFailedSteers` at 3.9's triggers |
| Steering | main's inbox module (D57) |
| Pause, decided and displayed | main's inbox module (D57) |
| Admission, Run now, Resume, the mark | main's inbox module (D57) |
| A steer that outlives its Run | 3.9 (a Run of its own) |
| Wake execution | 8.3 (D47) |
| Label work | 3.7 (L6), from 3.5's and 8.3's evidence |
| The stop: items, deadline, deadline step, end | 3.7 (L6, D54); main's inbox reads it as `stopping` until each kill's `process_lost` or failed `requestStop` |
| Run lifecycle events; the Tag's `sendTurn`, `beginStop` and `turnFences` `stopping` | the ledger, as main's run seam (D57) |
| The Tag's `holdUserTurnsForAccountSwitch`, `turnFences` `switching`, `fenceLifts`, `prepareTurnSession`, `completeRecoveredQuestion` | main's code, unchanged (3.9) |
| `turnEnds`, `hasActiveTurnsEffect` | each provider host, unchanged (3.9) |
| Each main service writing or waking the module's reads | 3.9's service boundary, one state each |
| The reactor's claim of a switched provider's `send_turn` rows | none: each switch ticket's guard (3.9, 3.12) |
| Host interrupt mode | 4.6 |
| Interaction and its Pending state | 3.10 |
| Probe and its cap | 3.7 |
| Fence | section 9 membership; held while a label has work (3.5) |
| Lost work | 8.4 (L5) |
| Cut-off, schedule, account switch | outside the ledger and outside main's inbox decision, as main |
| The view main's decider reads | main's `readView` over the read surface the seam's events feed (D57) |
| The reference for main's behaviour | main's code at 1ba91324 (D56); T2 runs it |
| Trace to main | none: both sides read main's own translators' events, and main's projector arms write the read surface, through 32.13 and after (D57) |

Expectation changes (the 32.2.3 note carries the same list), each read in conduit-82tn3224 and
conduit-82tn3223; under D57 main's module computes them, so this list confirms, not decides:
- The `stop(d)` helper callers: as A.18 listed them, unchanged.
- RL-041 (3224 scenarios.ts 589-620): B's delivery is pinned to `queue`, so the mutation at 3224
  scenarios.test.ts 93 still has a pause to break; C is marked while `stopping` holds, which lifts
  the decided pause by the stop term's marked clause; a steer branch is row 206's, not main's.
- 3224 run-ledger-decider.test.ts 2071-2101 (3223 1839): `later` is marked, so 2100's decided
  `paused` reads false and 2101 hands it off.
- By rule, wherever they occur: a `runNow` admit is Submit then SendNow with `interrupt`: idle, a
  handoff, then `already_started`; busy, queued, then marked; while `stopping` holds, marked at
  Submit; a known id adds nothing. This covers 3224 fake-provider.ts 3297-3311, 3451 and 3457 and
  the runNow admits of 3224 scenarios.ts 176-921. Every `resume` is SendNow of the head; every
  OpenCode steer is a plain queued send; every `run_now` of an unadmitted input is
  `already_started`.
- Known-id re-admits: 3224 run-ledger-decider.test.ts 5152-5165, 5345-5353 and 6018-6023 add
  nothing (3223 1782, 1839, 5788, 5910); 3224 scenarios.ts `resume` at 550 is SendNow.
- A.18's RL-041 steer branch "ends with it" and its trace "a steer whose Run ends before its
  acceptance is not steering" are wrong: a Claude steer not started at its Run's `completed` end
  stays `steering`, the session stays busy until its own turn's result, and a Stop of that turn
  pauses (D53 amended).
- A Codex wake with a plain M: main hands M off as idle and starts a turn that collides with the
  wake (`busy` false, codex-runner-payload.ts 301-315); the ledger reserves M only once the
  wake Run ends (3.6), row 202; the stopped inputs drain after M's Run, where A.18 had M join the
  wake Run.
- With an input queued and `usageResetsAt` set, the decided pause holds and the displayed one
  does not, as main's `readInboxState`.
- Not applied: the 32.2.4 note "adds no pause"; a Stop of a steer's own Run during a wake ends it
  `interrupted` and main's stop term pauses (D57).
- Review round 1: a second steer sent before a late steer starts joins that steer's Run; a Codex
  steer awaiting `turn/steer` at a `completed` end is placed by its acceptance or returned by its
  decline; a Claude Stop that keeps a pending steer leaves it `steering`, a Run of its own; a
  runner failure's unreached steer returns to the inbox front, paused (`requeueFailedSteers`);
  a Stop between a kill's issue and its `process_lost` reads `stopping` and opens no stop.
- The titles at 3224 scenarios.ts 591 and 1381, 3224 contract.test.ts 3339 and
  3224 run-ledger-decider.test.ts 2071 change with their bodies.
- The oracle stays pure and models no inbox (review round 2, reversing round 1); T2 reads its
  decisions through a seam Tag into main's module (3.9).
- The oracle's own inbox (3224 reference.ts priority, `bypassPause`, `possiblySeen`, the stored
  `paused`, admit routing) is deleted; main's module computes it in T2 (32.2.3, 32.2.17).
- Review round 2: a steer's failed send ends `removed` after main's requeue, and the requeue's
  `failed` reason pauses the queue as main's does (inbox-run-status-query.ts 34-46); a runner
  failure's unreached steer returns at the `process_lost` commit, not at a restart; a steer during
  only a Claude wake Run is a Run of its own, and the wake writes no `provider_runs` row; a Stop
  whose kill's `requestStop` fails lifts `stopping`.

Open risks: main's module needs a SQLite read surface and Effect layers in the oracle, so 32.2.3
grows a dependency on main's persistence; the read surface's columns cannot be dropped in 32.13,
so the outbox schema outlives its writer; a ledger outcome with no main writer adds a 2.1 row, and
T2 finds a missing one only for traces it has; T2's input side is generated, so a wire shape no
fixture records stays a gap; core state is still prose, reviewed by hand, with T4 and the
permutation property. From review round 1: the seam writes a terminal for every Run end, so a
ledger end with no main terminal code would need a 2.1 row; the reactor's claim: 3.12. From
review round 2: T2's closure check passes only on a tree whose closure is 1ba91324's but for the
listed files, and about 96 of its roughly 250 runtime files differ or are missing on the oracle
branch (3223 a1473a01) and about 87 on R2, so the ledger chain's base decides how long that list
is; OpenCode ingress's recovery reads `running` rows only
the reactor's claim writes, so after 32.11 it sees none of OpenCode's (inferred); main keeps a
Codex run open through a successor turn while the ledger's input Run may end first (32.2.13); the
held `onSteerDeclined` is lost at a restart, where `runBackgroundRow`'s requeue serves, as main.
Of A.17's and A.18's risks these stand: row 202's
`processing_timeout`, row 205's unverified OpenCode abort, an Interrupting Run with no deadline
until its `process_lost`, the same-driver failover, the covered send with no deadline.

Prior art for this seam (keeping a rewrite equal to the code it replaces): t3code aa11ef6783
replays recorded provider transcripts through its real orchestrator (replayTranscript.ts,
ProviderReplayHarness.ts, arrival gates in replayGate.ts), the nearest to T2, with no
old-to-new differential; bb runs a two-checkout parity whose stale allowlist entries fail; diri
keeps differential tests until parity; monocode hand-ports with no shared fixtures. None reuses
the old module unchanged as a part of the new one, as D57 does.

| Option | Verdict |
|---|---|
| e: the inbox stays main's module | chosen (D57) |
| d: the ledger feeds main's module as its run seam | chosen, as D57's write side |
| c: main's own translators make the replay's events | chosen (T2) |
| f: T1 and T3 gate every review round; T2 gates none (T2, above) | chosen |
| a: the r3 narrow fixes | rejected: they keep the hand account, which three rounds found wrong each time |
| b: each field cites main's write, checked by T1 | rejected: still a prose copy; T1 checks tokens, not semantics |
| g: the oracle normative | rejected for the inbox: a second copy of main in another language; kept for core state (T4) |
| ii: the ledger owns the decision, main's module a library | rejected: two owners of inbox state, and the view mapping stays |
| h: bb's recorded parity as the only gate | rejected: needs live wires per case; kept as fixtures per host fact |
| i: diri's shadow mode in the daemon | rejected for now: wiring cost before the ledger exists |
| below-the-Tag: the seam at the provider instance or the reactor's `executeRow`, main's turn service, dispatch and ingestion unchanged | rejected: main's `stopping` entry and L6 would both own the stop window, and main's reactor would decide issue and retry, so the seal (D52) and row 212's cap would not be the ledger's |
| d-pure: the ledger emits every main event | rejected: the ledger would re-implement main's ingestion. Amended (review round 1): D57's seam emits only the run lifecycle events (`run.requested`, `run.started`, terminals) and 3.10's resolutions at the ledger's own commits, none carrying host content; messages, tools and deltas stay main's ingestion, and the `message.created` of D53 and row 206 carries only the user's own input, as main's runner emits it (`place-user-message`, runner-turn-failure.ts 85-94) |
| seam placement: at main's run seam | chosen |
| depth: one module, main's, behind one rule | chosen |
| deletion test on D51's view, the Handoff clause, the stop-term account and T2's translations | chosen: none reappears |
| design it twice: view against writers, prose against token against replay | chosen: writers and replay |
| verification: T1, T3 and T2 as ticket acceptance and a gate | chosen |

<!-- src: REDESIGN-9 2026-10-31 (/private/tmp/r32-redesign-9); REDESIGN-8 review rounds 1 to 3 (ub, poteto, /private/tmp/r32-redesign-8/review-*-r3-out.md); main at 1ba91324 (session-inbox.ts 236-340, 452-573, 575-600; projectors-effect.ts 2431-2537; input-requeue-effect.ts 6-50; provider-turn-session.ts 329-388; inbox-run-status-query.ts 7-51; runner-turn-failure.ts 75-84; claude-runner-payload.ts 2532-2539); REDESIGN-9 r2 (the service boundary, the below-the-Tag option, the pure oracle; ub r2 P2-A to P2-G, P3-1 to P3-9, poteto r2 P1-1 to P2-6, P3-1 to P3-4); t3code aa11ef6783 (packages/provider-testing, orchestration-v2 testkit) -->

### A.20 REDESIGN-10 The ledger lives inside main's writes (2026-10-31): D58 + the spike

Decided autonomously under the Review Rounds rule after REDESIGN-9's three review rounds with
material findings (r1 13, r2 11, r3 9 unique), the eighth redesign in a row (R4 17, 18, 23; R5
25, 9, 4; R6 9, 13, 9; R7 8, 8, 5; R8 17, 18, 4; R9 13, 11, 9). Named pattern: the cut splits a
unit. Each redesign drew the ledger's edge through a main unit whose halves share closure state, a
transaction or a status machine, kept one half as main's and gave the other to the ledger; each
round then found the half left behind with no writer, two writers or a call it cannot make. The
units, each whole under D58: U1 the inbox module; U2 provider-turn-service.ts (closure-private
`stopping` 202, `lifts` 205-206, the owners wait 207-222, `deadlineAt` 225, `retireProcess`
251-284, `stop_unconfirmed` 286-292, `onExit` 307-313, `existing` 363-374, the restart restore
376-405, at 1ba91324 and unchanged at 6c9ff950); U3 the outbox status machine (`pending`,
`running`, `completed`, `failed`, `retryable_failed`, `cancelled`; `delivery_indeterminate` is an
`error_code`); U4 the reactor
(`markRunning` 1189-1260, the one `running` writer; `nextPendingRequests` 1143-1186); U5
dispatch; U6 ingestion; U7 OpenCode ingress; U8 runner recovery; U9 R2's engine
(`acceptStopEffect`, orchestration-engine.ts 658-940 at 6c9ff950); U10 the runner; U11 the
`provider_runs` terminal arm (projectors-effect.ts 2155-2176 at 1ba91324).

Findings of REDESIGN-9 (K1 an arrival order with two outcomes; K2 zero or two owners; K3 a stale
reader; K4 worse than main; K5 a ticket against the contract; K6 a wrong or incomplete record of
main; K7 unbuildable as written), each with the unit its cut split and the rule that resolves it:

| Round, finding | Kind | Unit split | Resolved by |
|---|---|---|---|
| r1 ub P1-1: `run.started`, main's join writer, omitted | K6 | U6 | D58: main writes it, the arm folds it |
| r1 ub P1-2, poteto P2-5: L6 ends `stopping` before main in the kill window | K4 | U2 | L6: the stop is U2's entry |
| r1 ub P1-3: a second steer before a late steer starts has no answer | K1 | U1, U6 | D58: U1 and U6 whole; D53's own-Run steer as main |
| r1 ub P1-4: a Codex steer awaiting its RPC answer at a `completed` end | K1 | U6 | 3.9's steer rule (`turn/steer`, codex-runner-payload.ts 1146-1167) |
| r1 ub P2-1, poteto P2-1: the module's services unassigned, "imported" unbuildable | K7 | U1, U2 | D58: nothing is imported; units run in their own graph |
| r1 ub P2-2, poteto P2-2: the column list misses read columns | K6 | U1 | D58: main's projector arms write them; no list |
| r1 ub P2-3: `Cancelled` with two owners | K2 | U1 | D55: main's Cancel arm |
| r1 ub P2-4, poteto P2-6: the build order not in the beads | K5 | none | 12.2 and deps; T3 over beads |
| r1 ub P2-5: the gate stated two ways | K5 | none | one gate, T1 and T3 (32.2.18) |
| r1 poteto P1-1: D53 returns a steer main runs as its own turn | K4 | U1, U6 | D53 amendment, main's own-turn run |
| r1 poteto P1-2: a runner failure takes Stop's writer, main `requeueFailedSteers` | K6 | U6 | D58: main's writer runs, in its own body |
| r1 poteto P2-3: ledger-decided Run ends with no writer, not atomic | K2 | U11 | 3.8 fold over main's terminal arm, one transaction |
| r1 poteto P2-4: after 32.13 a hand-written projection | K2 | U1 | D58: main's arms stay through 32.13 and after |
| r2 ub P2-A, poteto P1-1: main's steer requeue triggers not fired | K2 | U2, U6 | D58: every trigger is main's, unchanged |
| r2 ub P2-B, poteto P2-3: Tag members with no owner | K2 | U2 | D58: the Tag is main's, whole |
| r2 ub P2-C, poteto P1-2: `turnEnds` split from its flag | K2 | U2, U10 | D58: both stay the host's |
| r2 ub P2-D: the claim guard on the wrong ticket | K5 | U4 | 3.12: no guard; `markRunning` stays |
| r2 poteto P2-2: the reactor's claim filter with no owner | K2 | U4, U5 | 3.12: the reactor's |
| r2 ub P2-E: L6 contradicts itself on a failed retirement | K1 | U2 | L6: U2's `stop_unconfirmed` |
| r2 ub P2-F, poteto P2-1: vendored and hash-checked unbuildable | K7 | U1 | D58: no vendoring |
| r2 ub P2-G, poteto P2-5: 32.13 deletes a writer the module reads | K5 | U1 | 12.2 32.13 row |
| r2 poteto P1-3: a wake Run has no main run | K6 | U6, U11 | 3.9: the arm records it; main writes none |
| r2 poteto P2-4: two main paths restated by hand | K6 | U9, U6 | 5.3 as R2's steps; no restatement |
| r2 poteto P2-6: writers misattributed | K6 | U1 | D58: no writer list of main |
| r3 ub P1-1, poteto P1-2: `running` with no writer once the claim moved; Stop re-sends a delivered prompt | K4 | U3, U4 | 3.12: `markRunning` stays the one writer |
| r3 ub P2-A, poteto P1-1: calls into `commit.write` inside the ledger's die as `NestedCommitAndSignal` | K7 | U9 | 3.1: the arm runs inside main's `project`; nothing nests |
| r3 ub P2-B, poteto P2-2: the R2 base three ways; R2 writes the Stop twice | K6 | U9 | header: R2 lands first, cited at 6c9ff950; 5.3 one body |
| r3 ub P2-C: closure-private `stopping` with two owners | K2 | U2 | L6: U2's alone |
| r3 ub P2-D: two writers of native terminals and `run.started` | K2 | U6, U11 | D58: main's writers; the arm appends nothing |
| r3 ub P2-E, poteto P2-1: two `input.sent` writers; services missing from the table | K2 | U5, U6 | D58: main's writers; no table |
| r3 ub P2-F, poteto P2-4: A.19's risk against 5437; ticket mismatches | K5 | none | 12.2 rows and notes; T3 |
| r3 poteto P2-3: T2's closure exceptions with no owner | K7 | U1 | D58: no closure check; 32.2.19 builds in R2's graph |
| r3 poteto P2-5: clearing `retryable_failed` with no owner after a switch | K2 | U3, U9 | 3.12: `acceptStopEffect` 858, in T5's table |

Round 3's P3s and removables: ub P3-1 to P3-3, P3-6 and R1 to R4 and poteto P3-2, "Only the
timing", the nesting sentence and 5.3 as a pointer are applied; ub P3-4, P3-5, P3-7 and poteto
P3-1, P3-3 to P3-5 and P3-7 fall with what D58 deletes; ub P3-8 and poteto P3-6 (Terms) are
answered below; ub P3-9 is the 32.2.17 note; ub P3-10 stays moot (no seam publish remains).

Patterns given: 1, the cut splits a unit: adopted as the named pattern; it explains 30 of the 33
rows. 2, inside, not beside: adopted, wider than R2's engine; the arm is inside every main write
body, not only the Stop's. 3, scope drift: adopted in part; the inbox parity work came from owning
the send path and goes with it, and the projection half is kept, but the label rules still need
the fence, the items and lost work. 4, a spike as a hard gate: adopted; 32.2.19's measured result fed
REDESIGN-10's review round 1.

Options (each with the units it splits, the owner of each half, and what proves it builds):

| Option | Units split, owner of each half | Broken at | Verdict |
|---|---|---|---|
| a: round 3's narrow fixes to D57 and its table | U2 (Tag, ledger; closure, main), U4 (claim, ledger; `running`, main) | each fix moves the split; r3 P2-C stays | rejected |
| b: ub's whole Layer, provider-turn-service.ts replaced | U3 (machine, main; claim, ledger), U4 | in-commit calls nest; `running` has no writer | rejected |
| c: poteto's below the Tag, at `executeRow` | U6, U11 (terminals, both) | two writers of terminals and `run.started` | rejected |
| d: the ledger inside R2's engine | none for U9; U6, U8 untouched | covers only the Stop | kept as the Stop half |
| e: a projection over main's events plus minimal commands | none | cannot express the 2.1 rows that change what main appends | kept as the read half |
| f: a full per-provider strangler | U3, U4, U5 per provider, both machines live | four switches, each a two-machine window | rejected |
| g: narrow to the original ask | none | the label rules need the fence, items and lost work over every evidence kind | its scope cut kept |
| h: a sidecar ledger, its own transaction after main's | every unit (fact, main; fold, ledger, later) | a crash between them gives two outcomes (K1) | rejected |
| i: the ledger as the only event writer | every unit | rewrites each write body; one big switch | rejected |
| j: the outbox as the whole ledger | none | no row for label work, the fence or lost work | rejected |
| D58: d plus e, the arm in each main write body | none | the 32.2.19 traces, T5 | chosen |

Methods: M1 seam placement over the unit graph (the cut goes only where no unit spans it: main's
write bodies); M2 the deletion test (deleting D57, the service boundary table, the read list, the
Run Effects switch and the backfill leaves no finding that needs them); M3 depth (one arm, one
view, three effects, behind D58); M4 design it twice (the ledger beside main's writes
against inside them; the Stop as the ledger's entry against U2's); M5 verification by building
(32.2.19 in R2's graph, T5, T2) instead of review; M6 a competitor survey (t3code and bb write the
run record inside the send path's transaction, bb with a transition table; t3code's one switch
churned on Stop; zeron, diri and monocode keep separate writers and have disagreement bugs; capy
derives status); M7 back-propagation per kind (each kind to the rule and the catcher below).

Derived, from D58 and main:
- D57 is deleted: main's units run whole, so nothing reaches main's inbox by a seam.
- D53: the ledger decides a send's value; main's writer places it, in its own body (3.9).
- The service boundary table is deleted: no main service is replaced, so none has a boundary.
- L6: the stop is U2's `stopping` entry; the ledger owns its items, folded in
  `acceptStopEffect`'s projection; the deadline is `deadlineAt`; the step is U2's `retireProcess`.
- The 2.1 rows: each changes only the unit its Ticket cell names. The unit reads the view in its
  own body, inside its write, before the statement it gates and after projecting any event that
  statement depends on, and appends main's events itself.
- The steer rule: main's `joined_into` and Codex join (codex-runner-payload.ts 1063-1076,
  1133-1143, 1146-1167 at 1ba91324); the arm folds them.
- The read list is deleted: main's projector arms write what main reads.
- The Stop commit is R2's `acceptStopEffect` body, run whole (5.3).

| State | Owner |
|---|---|
| Run end | 3.8 (the ledger's rule); main's terminal is U11's |
| End reason | 3.8 |
| Unlaunch | 3.6 (D50) |
| Retry pending | main's reactor (`next_attempt_at`), as main (3.7) |
| Coverage | main's `stopCovers` (5.2, 5.4) |
| Steer association | main's `joined_into`, written by its `run.started` arm, as main (section 2) |
| One active Run | the decider (3.1); a violation is a log line |
| Seal | 3.6 (D52) |
| Input place | main's writer, from the ledger's value (3.9, D53) |
| Input state | main's `pending_inputs`; failed, the Run Input outcome (3.9) |
| Steering | main's inbox module (D58) |
| Pause | main's inbox module (D58) |
| Wake execution | 8.3 (D47), folded by the arm |
| Label work | 3.7 (L6), from 3.5's and 8.3's evidence |
| The stop and `stopping` | U2's entry; its items, the ledger (L6, D54) |
| Outbox status | main's writers, each its own SQL guard (3.12); T5's table checks them |
| Evidence events | the unit that observes each fact, in the same write (2.1 row 215) |
| The transaction | main's write; the arm is inside its `project` (3.1) |
| Run lifecycle events | main's writers; the arm appends none |
| Host interrupt mode | 4.6 |
| Interaction | 3.10 |
| Probe | 3.7, an outbox row of its own |
| Fence | section 9 membership; held while a label has work (3.5) |
| Lost work | 8.4 (L5) |
| The reference for main | main's code at 1ba91324, R2 at 6c9ff950 where it changes main (D56) |

Catchers, by kind: K1 by T2's permutations (32.2.17) and the 32.2.19 traces, gating; K2 by T5's
table (32.3) and T4 (32.2.3, gating 32.2.9), gating; K3 by T3's terms and
recount (32.2.18), gating every review; K4 by T2's comparison of main's events, rows and provider
calls (32.2.17), gating; K5 by T3 over every bead 12.2 names (32.2.18), gating; K6 by T1's cites
(32.2.18) and T2, gating; K7 by 32.2.19 in R2's real Layer graph, whose measured result fed review round 1.

32.2.19, the spike, about 2 days and 600 to 900 lines with its tests, over R2 at 6c9ff950 with
`:memory:` SQLite and the fake runner host: the arm in main's `project`, the effect-row insert
(INSERT OR IGNORE, keyed, never while `replaying`), the view, and a status table. Trace 1,
Stop after delivery: Claude, one start delivered (`markRunning`, then the host's accept), then
Stop; `acceptStopEffect` selects no row (the send is `running`), commits `interrupt_turn` with the
Run in `payload.stop.owners`, the arm folds the items; the host's `interrupted` ends the Run.
Expected: the input stays removed, no `input.requeued`, no second `send_turn`, one provider send
call. Trace 2, restart with a committed `interrupt_turn`: as trace 1 to the commit, then the Layer
graph is rebuilt over the same database before the host answers, the runner surviving (Q28).
Expected: U2's restore (376-405) makes one `stopping` entry with the row's `deadlineAt`; replay
rebuilds the arm and inserts no outbox row; the host's terminal ends the stop and the Run once.
The fixture's in-process runner dies with the graph; trace 2 rebuilds U2's owner over the live
runner, and a full-graph rebuild with a process runner is 32.3's.
Both: no `NestedCommitAndSignal`, and every status write is in T5's table.
T5, measured in 32.2.19 and landed by 32.3: a table of 3.12's writers' from and to statuses and
the effect executors'; it fails on SQL text that writes outbox status outside the table. Run
2026-10-31: trace 1 held; trace 2 held with the owner rebuild (2b); the writer-list test against
3.12's 15 writers is 32.3's acceptance.

Build order: 32.2.19, 32.2.2 and 32.2.5, then 32.3, then 25scs and 32.2.17; the other core
tickets in parallel from 32.3's start.

Expectation changes: T2 compares main's events, rows and provider calls, not a read list or seam
calls (A.19's comparison set shrinks); effect expectations read outbox rows, not a Run Effects
table; coverage expectations read `stopCovers` at every ticket, with no 32.13 switch; the `stop(d)`
helper callers and A.19's inbox expectations are unchanged. Two are added: an OpenCode deadline
step with items and no owners ends the items (2.1 row 214); a runner deadline step that cannot
retire ends its items through `settleSessionRuns` (L6, 2.1 row 214). No generator kind is added.

Risks: R2 changes before it lands, moving the 6c9ff950 cites (T1 catches them); a 2.1 row's unit
body may not have the view's inputs before `project` (the spike measures it for rows 205 and 213
only); 32.13's other deletions (`owned_run_ids`, `newestRunnerFirst`) touch runner units this
redesign did not re-audit; the odds of an eleventh redesign are about one in four, mostly from
rows 202 to 213 that the spike does not trace. Measured by 32.2.19 (3.9, 3.12): the three ledger
effects have no executor on main and block the session's lane, so the arm inserts none before
32.3, and 2.1 row 216 names their provider calls. T2 (32.2.17) waits on 32.3, so it replays the
real arm. An OpenCode trace whose label work ends only by a probe is in its catalogue.

Terms changed (T3 reads this line; each backticked item is a literal, case-insensitive search;
a live hit of a deleted term is stale, of a changed one a reader to check): deleted or renamed,
`D57`; `run seam`; `service boundary`; `read surface`; `Run Effects table`;
`ProviderTurnServiceTag`; `claim guard`; `runs it as any row`; `only the transition function's
module`; `transition function`; changed, `acceptStopEffect`; `markRunning`; `settleRunCommands`;
`stopCovers`; `markCompleted`; `writeFailure`; `refusal sweep`; `INSERT OR IGNORE`; and from
review round 1, deleted, `per provider`; `Switch for`; `outbox path`; `four verbs`; `` `record` ``;
`Deleted:`; `wake labels`; `uniqueness constraint`; `one provider at a time`; `processLost`;
changed, `exempt`; `stopping`; `legacyStopOwnersQuery`; `deadline step`; `process_started`;
`alarm_fired`; `Stop commit`; `retryAt`; and from review round 2, deleted, `kill_and_respawn`;
`retry claims`; `wake_started`; `retirement transaction`; changed, `process_lost`; `retirement
settlement`; `effect_outcome`; `requeueLegacySend`; `requeueFailedSteers`; `deadlineAt`;
`DeadlineOwner`. D58 is new and each of its readers is written here. D58 changes the stopping entry's items and the Stop commit (L6, rows 203 to 205),
so both are listed; the wake Run is not, as D58 changes none of it (ub r1 P3-2, poteto r1 P3-5).

Rule count against HEAD, by A.17's convention, itemized (T3 counts these bullets):
- Base, A.19: 46 deleted, 58 added.
- Deleted HEAD rule: Run Effects replace the outbox one provider at a time, with a table, an
  authority switch and the marker's move (3.12, section 2, 32.3).
- Deleted HEAD rule: the per-provider backfill (3.12).
- Deleted HEAD rule: steer association moves to Run Inputs (section 2, 3.12, 32.7).
- Deleted HEAD rule: the ledger's interpreter writes the direct-provider marker from 32.11 (4.10).
- Deleted HEAD rule: only the ledger's interpreter writes effect status (11.3).
- Deleted HEAD rule: 32.13 replaces the Stop cohort and deletes run joining and steer-declined
  reservations (5.4, OPEN-3).
- Deleted HEAD rule: 32.13 deletes Send Settlement's outbox adapter.
- Deleted HEAD rule: run state and Run ends move to the ledger one provider at a time, each
  switch making `processLost` a no-op (section 2, 6.5, 12.1, 32.6, 32.10, 32.11, 32.21).
- Deleted HEAD rule: 4.8's list of main code the ledger deletes.
- Deleted HEAD rule: the database uniqueness constraint on one active Run (3.1).
- Deleted HEAD rule: `interrupt_turn` names wake labels (4.6, OPEN-5).
- Deleted from A.19's additions: D57, the inbox is main's module and the ledger is its run seam.
- Deleted from A.19's additions: the read list kept through 32.13 and after.
- Deleted from A.19's additions: the boundary over each main service, the claim's guard included.
- Added: D58, the ledger lives inside main's writes (3.9).
- Added: T5's table of the outbox status writers, checked against each writer's SQL text (3.12,
  11.3).
- Added: the three ledger effects landed whole on 32.3, one executor each and a wake on the insert
  (2.1 row 216, 3.12).
- Added: `probe`, `stop_task` and `cancel_request` rows exempt from the session lane and
  `armRetryWake` (3.12).
- Added: evidence events, appended by the unit that observes each fact in the same write, with
  the scheduler's `alarm_fired` (2.1 row 215, 3.9).
- Added: an OpenCode deadline step with items ends them through `settleSessionRuns` (2.1 row 214,
  L6).
- Deleted HEAD rule: the `kill_and_respawn` effect and its executor (5.1, 3.12, 3.13).
- Deleted HEAD rule: a kill's coverage, its issue retiring its runner and a pending kill covering
  the sends it reached (L1, L2, 3.6, H3).
- Deleted HEAD rule: restart recovery of an outstanding issued kill (H2, 6.9, 32.32).
- Added: a runner deadline step that cannot retire ends its items through `settleSessionRuns`
  (L6, 2.1 row 214).
- Added: a fresh-run claim's `run.requested` folds as a transmission of the ledger Run its input
  belongs to (3.4, 3.9).
- Added: a probe transmission's provider call is bounded by its retry deadline, and a timeout is
  its `effect_outcome` (3.7).
- Added: after a restart U2's restore asks row 213's confirm again, keyed by the Stop's command id
  (2.1 row 213).
- Result: 60 deleted and 65 added, 5 net added, against A.19's 12.

Net rule change, deleted minus added: -5 (60 minus 65); REDESIGN-10 deletes 14 HEAD rules,
withdraws 3 of A.19's additions and adds 10, of which review round 1 deletes 4 and adds 5, and
review round 2 deletes 3 and adds 3.
Rewritten in place, counting nothing: D54's stop, deadline and step as main's; 2.1's intro and
Ticket cells; 3.1; L6; 3.9's steer cites and Claude wake; 5.2 and 5.3; section 6's kills; 9;
11.2; 11.3; the 12.2 rows; Q9; Q26; OPEN-3's rows. The amendments of SPEC Schema and OPEN-3 are
counted as amendments, not rules (30, from 28); review round 1 revises the OPEN-5 and SPEC Schema
amendments in place. Also rewritten in place: the spike's corrections (3.9's item 2, 3.12's
effect rows and status machine, section 2's Run Effect row, 11.3's T5, the 32.2.19 and 32.3 rows,
U3, trace 2 and T5 here), and review round 1's rows 206, 207 and 211, the arm's evidence rule
(3.9 item 1), retry timing as main's (3.7), the one owner of the deadline step (L6, 3.13) and
the interrupt's runIds (4.6); the unguarded `markCompleted` and `writeFailure` are main's; and
review round 2's `process_lost` write (row 215, L6), the retirement settlement (row 150, 2.1, 6.5),
the stop's deadline as U2's (3.7, 3.13), start and steer issue as main's (3.4, 3.9, 4.8, 12.1),
the unlaunch's return (3.6), row 216's wake, D52's coverage list and the 12.2 rows.

<!-- src: REDESIGN-10 2026-10-31 (/private/tmp/r32-redesign-10); REDESIGN-9 review rounds 1 to 3 (ub, poteto, /private/tmp/r32-redesign-9/review-*-out.md); main at 1ba91324 (provider-turn-service.ts 202-405; orchestration-side-effect-reactor.ts 1143-1260; commit-and-signal.ts 49-68, 80, 168; projectors-effect.ts 45, 2137-2176; codex-runner-payload.ts 1063-1167; claude-runner-payload.ts 2274-2299); R2 at 6c9ff950 (orchestration-engine.ts 658-940; session-run-settlement.ts 98); competitor survey: t3code, bb, paseo, zeron, diri, monocode, capy ; REDESIGN-10 review round 1 (/private/tmp/r32-redesign-10/review-*-r1-out.md, fix-r1.md: the recount from scratch, the build order, T5 as a table, the evidence events, the OpenCode deadline step, the lane rule) -->

### A.21 REDESIGN-11 One model per piece of running work (2026-10-31): D59 + the spike

Decided autonomously under the Review Rounds rule after REDESIGN-10's three review rounds with
material findings (r1 20, r2 10, r3 7 unique), the ninth redesign in a row (R4 17, 18, 23; R5 25,
9, 4; R6 9, 13, 9; R7 8, 8, 5; R8 17, 18, 4; R9 13, 11, 9; R10 20, 10, 7). Named pattern: two
models of running work side by side. D58 removed the split units but kept main's `provider_runs`
with the outbox and the ledger's Runs with the stop's items as two records of the same work, and
every join between them (a fold, an evidence event, a view read, a settlement through main's
queries) was a place they could disagree on what exists or who observed it: evidence main records
with no event (round 1); a main write the arm read with a second meaning (round 2); ledger items
main's queries cannot see (round 3). 24 of the 37 rows below sit on such a join (J); the other 13
are tickets or text that drifted from the contract, the kinds T3 and T1 exist for.

| Round, finding | Kind | J | Missing concept, and the rule that resolves it |
|---|---|---|---|
| r1 ub P1-a: a lane-exempt send claims before the kill | K4 | J | the one claim writer (3.12); with D59 no ledger effect races main's |
| r1 ub P1-b: the OpenCode step ends no items | K2 | J | one end per work: U2's `stop_unconfirmed` for owner runs, the alarm for the rest (L6) |
| r1 ub P1-c: row 207 is two writes | K1 | J | one write per row (2.1 row 207) |
| r1 ub P2-1: eventless writes | K6 | J | one observer per fact (row 215, D59) |
| r1 ub P2-2: the scheduler has no unit | K2 | J | 32.3's scheduler on the session row (3.7) |
| r1 ub P2-3: retry timing with two owners | K2 | J | the reactor's `next_attempt_at` (3.7) |
| r1 ub P2-4: "after project" | K7 | J | the view read before the statement it gates (2.1) |
| r1 ub P2-5: row 211 | K6 | J | main's writer named (2.1 row 211) |
| r1 ub P2-6: a switch survives | K3 | J | no switch (D58) |
| r1 ub P2-7: the Deleted list | K3 | | T3's Terms |
| r1 ub P2-8: the kill with two owners | K2 | J | no ledger kill (A.20 r2) |
| r1 ub P2-9: no row for effect calls | K6 | J | row 216 |
| r1 ub P2-10: 32.13 | K5 | | the 12.2 row |
| r1 ub P2-11: the build order | K5 | | deps and 12.2 |
| r1 ub P2-12: 32.2.19 | K5 | | its note |
| r1 ub P2-13: the recount | K3 | | T3's recount |
| r1 poteto P2-1: ticket cells | K5 | | 25scs |
| r1 poteto P2-9: wake labels in the payload | K2 | J | U2's payload as main's; no wake label in it (4.6) |
| r1 poteto P2-12: the arm reads outbox status | K2 | J | outbox status is main's (3.12) |
| r1 poteto P2-13: the uniqueness rollback | K4 | J | no constraint (3.1) |
| r2 F1, N2: the kill has no issuer | K2 | J | no ledger kill |
| r2 F2, N3: the `process_lost` write | K6 | J | each write that first sets `retired_at` appends it (6.5, D59) |
| r2 F3: the deadline with two owners | K2 | J | U2's for owner runs, the ledger's for the rest (L6) |
| r2 F4: the 32.3 bead | K5 | | its note |
| r2 F5: the row 213 split | K7 | | row 213 whole |
| r2 N1: `absent:` and the stale step | K2 | J | deleted: no ledger end at U2's step (D59) |
| r2 N4: the token model | K6 | J | one minter per token (3.4) |
| r2 N5: 32.11's edges | K5 | | deps |
| r2 N6: the build order | K5 | | deps and A.21 |
| r2 N7: guard sites | K5 | | 32.3's note |
| r3 ub F-B, poteto F1: a wake item never ends at a failed step | K2 | J | D59: the alarm ends it, with no main run to settle |
| r3 ub F-C: a restart loses a wake-only stop's deadline | K1 | J | D59: the ledger stop deadline on the session row, no U2 restore |
| r3 ub F-A, poteto F3: the observer of a failed step | K6 | J | D59: no ledger end at the step, so no observer is needed |
| r3 ub F-D: a runner-held start as two transmissions | K2 | J | D59: `run.dispatched` alone (3.4) |
| r3 ub F-F: two OpenCode `process_lost` writers | K2 | J | D59: `onInstanceStopped`'s batch; the L1 exception for a replacement |
| r3 ub F-G: stale kill text in three beads | K5 | | notes on 32.2.13, 32.2.3, 32.2.4; T3 over the newest note |
| r3 poteto F2: 32.2.14's acceptance | K5 | | moved to 32.2.11 |

Round 3's P3s and removables: ub E is 32.4's retirement writes (6.5); ub 653 is
3.7's `retryable` with `retryAt`; ub row 215 and poteto P3-2 are section 9's rule: a supervisor's
report, as a replacement, retires the id at the next `process_started` (L1); ub 1166 and poteto
P3-8 are the `IssuedEffect` comments, and with them 3.4, the Send Token and the `SendToken`
comment; poteto P3-3 is the `newId` comment; ub's 32.32 edge, T5's rename to T5-writers is in
deps, and 32.2.19's note marks it superseded; ub 635 is 3.7's "a probe"; poteto P3-1 is the build order below; P3-4
is A.20's Run end cell; P3-5 is the Terms below; P3-6 is 3.12's 6c9ff950 ranges; P3-7 is the 32.2.6
note; ub's report drift is answered by measuring here; ub's allow wrap and T3's live notes are
32.2.18's acceptance. Removables: row 214 and its hand-off, L6's `absent:` case, 5.4's first bullet
(it restates 5.2) and 3.4's double fold are deleted.

Patterns given: 1, two models of running work: confirmed, the generator; 24 of 37 rows sit on a
join, and every earlier redesign's pick kept some join (REDESIGN-4 to -8 a ledger beside main's
inbox, REDESIGN-9 a seam, REDESIGN-10 items beside main's entry). 2, one model, main's: rejected;
main has 78 query sites over `provider_runs` in 23 files at 1ba91324 (19 in the projectors, 9 in
the reactor, 7 in OpenCode ingress, 5 in run settlement, 4 each in the process runner, the engine
and Claude event persistence, 3 in dispatch, and 15 more files), each of which would see a wake
row as a turn (busy, the composer, rewind, recovery); no main command exists for a Codex or Cursor
wake. 3, one model, the ledger's: rejected; every one of those readers moves per provider, so two
machines are live until the last switch, the window REDESIGN-9's (f) and A.20's (f) broke on. 4,
one observer per fact: kept, as D59's second half; it removes F-A, F-D and F-F, and F-B needs no
evidence kind once the ledger ends no work at U2's step. 5, the contract as the generator: kept as
a method and a catcher; 13 of 37 (K3, K5, K6 with no join) would have been caught by T3 over live
notes and T1, and the rest are design, not record.

Options (units split; joins kept, each side's owner; what proves they agree; broken at):

| Option | Units split | Joins kept, owners | Proof | Broken at | Verdict |
|---|---|---|---|---|---|
| a: round 3's narrow fixes to D58 | U2 (restore widened), U4 (control outcome) | items beside the entry (ledger, U2); `stop_step_ended` (reactor, arm) | T2 | a second `stop_unconfirmed` writer; U2's restore and the retire guard (reactor 1517-1524 at 6c9ff950) change | rejected |
| b: every ledger item a main run | none | none | main's tests | 78 readers see wake rows; no main command for a Codex or Cursor wake | rejected |
| c: the ledger's model alone, per provider | U3, U4, U5, U11 per provider | the switch window (both) | T2 per switch | two machines live per provider | rejected |
| d: one observer per fact | none | evidence (the writing unit) | T4 | none alone; leaves the items | kept, in D59 |
| e: the contract cut to rules | none | records of main (T1, T2) | T1, T2 | removes no join | method and catcher |
| f: narrow to the ask, no ledger item | none | none | T2 | no deadline over a hung wake is worse than main's Stop | its cut kept |
| g: the ledger owns its own deadline, U2 untouched | none | the stop commit's `deadlineAt` (R2's engine, read by the arm) | the D59 spike | none found | chosen, with d and f |
| h: U2's restore reads the commit row for wake-only stops | U2 | items (ledger, U2) | spike | changes U2 | rejected |
| i: no deadline for label work | none | none | T2 | a hung wake keeps the fence for good | rejected |
| j: the ledger issues its own retire at its deadline | U2 | the retire (ledger, U2) | spike | a second `end_session` writer | rejected |
| k: one run record with a wake arm (paseo's tagged union) | U11 | none | T2 | is (b) or (c) for main's readers | rejected |

Methods: M1 join counting (each option's joins between two records of running work, against the
J column); M2 the deletion test (deleting the stop's items, row 214, the failed-step end and 3.4's
double fold leaves no case uncovered: owner runs end as main, the rest by their own ends or the alarm); M3 design it
twice (the ledger's deadline beside U2's against U2's restore widened, (g) against (h)); M4
arrival-order enumeration (the alarm against `process_lost`, against a late `turn_ended`, against
a restart, each with one outcome); M5 the competitor survey, extended for this seam (t3code makes
a wake a Run tied to a synthetic message on its one run table; paseo keeps one tagged union of
foreground and autonomous runs; bb and monocode attach a wake to the user's turn and create no run
for unsent work; capy treats a wake as a first-class run; none keeps a second record beside its
run table); M6 building it (the D59 spike's three traces in R2's graph before review); M7
back-propagation per kind (each kind to its catcher below).

Derived, from D59 and main:
- D58 stays: the arm, the three ledger effects and the view are unchanged; D59 removes the items
  from it.
- Row 214 is deleted: no ledger work ends at U2's step, so a step that cannot retire leaves its
  owner runs as main (`provider_process_gone`) and the alarm ends the rest no observer ended.
- Row 215 is the observer rule itself (one observer per fact).
- L6 keeps the stop as U2's entry and adds the ledger stop deadline (3.7).
- 3.4's transmission rule: one per send, from its observer.
- What the view holds: no stop item; coverage stays `stopCovers` (5.4).
- The deadline owner: U2 for owner runs, the ledger's alarm for the rest (3.7).

| State | Owner |
|---|---|
| Run end | 3.8 (the ledger's rule); main's terminal is U11's |
| End reason | 3.8; forced at the ledger stop deadline's alarm |
| Unlaunch | 3.6 (D50) |
| Retry pending | main's reactor (`next_attempt_at`) |
| Coverage | main's `stopCovers` (5.2, 5.4) |
| Seal | 3.6 (D52); only `process_lost` seals |
| Input place | main's writer, from the ledger's value (3.9, D53) |
| Input state | main's `pending_inputs`; failed, the Run Input outcome (3.9) |
| Steering | main's inbox module (D58) |
| Pause | main's inbox module (D58) |
| Wake execution | 8.3 (D47) |
| Label work | 3.7 (L6), from 3.5's and 8.3's evidence |
| The stop and `stopping` | U2's entry, whole, with its owner runs (L6, D59) |
| The stop's deadline and its step | U2's `deadlineAt` and `retireProcess` for owner runs; the ledger stop deadline and its `alarm_fired` for the rest (L6, D59) |
| Outbox status machine | main's writers, each its own SQL guard (3.12); T5-writers checks them |
| `provider_runs` | main's writers; the ledger writes none |
| The transaction | main's write; the arm is inside its `project` (3.1) |
| Run lifecycle events | main's writers; the arm appends none |
| Evidence events | the one observer of each fact (2.1 row 215, D59) |
| Host interrupt mode | 4.6 |
| Interaction | 3.10 |
| Probe | 3.7, an outbox row of its own |
| Fence | section 9 membership; held while a label has work (3.5) |
| Lost work | 8.4 (L5) |
| The reference for main | main's code at 1ba91324, R2 at 6c9ff950 (D56) |

Catchers, by kind: K1 by T2's arrival-order permutations (32.2.17) and the spike's restart trace,
the spike gating; K2 by T4 (32.2.3) and T5-writers (32.3), not gating; K3 by T3's Terms and recount
(32.2.18), gating every review; K4 by T2's comparison of main's events, rows and provider calls
(32.2.17) and the spike's wake and failed-step traces, the spike gating; K5 by T3 over every bead
12.2 names, reading the newest note of each as live text (32.2.18's acceptance), gating; K6 by
T1's anchors (32.2.18), gating; K7 by the D59 spike in R2's real Layer graph, gating.

The D59 spike, a new child of 32.2, about 1 to 2 days and 400 to 700 lines with its tests, over R2
at 6c9ff950 with `:memory:` SQLite and the fake runner host: the arm folding a stop commit's
`stop.deadlineAt` into the session row, the scheduler's `alarm_fired`, and a runner's
`process_lost` in the transaction that sets `retired_at`. Trace W (wake): Claude, a wake execution
running with no main run, then Stop; `acceptStopEffect` commits `interrupt_turn` with no owners;
the dispose ends the wake at once, its
`turn_ended` ending its work not forced, and a Queued Run launches when main's `turnInFlight`
clears, before `deadlineAt`; at `deadlineAt` the alarm forces nothing; no `end_session`, no main
event from the arm. Trace F (failed step): a Stop over an owner run and a
wake, U2's retire `end_session` cancelled `provider_process_gone`; the owner run stays open as main
and the alarm ends the wake's work that no observer ended; no `settleSessionRuns` call from the
ledger. Trace R
(restart): Trace W to the commit, then the Layer graph rebuilt over the same database before
`deadlineAt`; U2's restore restores nothing (no open owner run), the scheduler reads the session
row and the alarm fires once, forcing only the work no observer ended. All three: each write
that first sets `retired_at` appends one `process_lost` in its transaction, and a replay inserts
no outbox row. Pass 2 built it (6.5): its P, P-release, P-restart and P-order traces pass, and
with the mark disabled 7 of 9 go red (measured). Pass 3: the release commit projects it with that
write (P-release, P-T2, red with that projection off) and `commitRetirement`'s raw upsert appends
one per retirement, none on a repeat (P-commitRetirement, red with the mark off; measured).

The retirement's `process_lost`, three options the D59 spike gate turned down, one line each:
- Rejected: one ingestion batch, as a batch fixes its events before `beforeCommit` runs (inferred from the API).
- Rejected: one `commitAndSignal` write for `requestStop`, as retirement then depends on projection health (runner-retirement-fence.test.ts 6260 at 6c9ff950 red, measured).
- Rejected: a fiber that appends it from `retired_at`, as a fact between retirement and its write changes the Run end (measured by the order check).

Build order: the D59 spike, then 32.2.2 and 32.2.5, then 32.3, then 25scs, then 32.2.17 (it is
blocked by 25scs); the other core tickets in parallel from 32.3's start. Before the next review
round: the D59 spike passing W, F and R, T3 reading the newest note per bead as live text, and T1.

Expectation changes: A.20's two added expectations are replaced: an OpenCode or runner deadline
step ends no ledger work through `settleSessionRuns`; the owner runs end as main's step leaves them
and the alarm ends the work outside them that no observer ended, forced. Main's reason: `sessionRunOwnersQuery` selects
only pending or running `provider_runs` (session-run-settlement.ts 27-59 at 6c9ff950), so a wake
has nothing to settle, and U2's restore restores only stops with an open owner run (`recovered`,
provider-turn-service.ts 376-405 at 1ba91324). A runner-held fresh-run retry counts one
transmission, not two: main writes both its `run.requested` and `holdRun`'s `run.dispatched` for
the one send. The oracle's stop deadline issues a destructive step for label work (reference.ts's
forced end); for work with no main run it now issues none and ends what no observer ended forced,
as main retires only an entry's owners. The harness's fake emits one `process_lost` per OpenCode stop, so its counts
are unchanged. A Claude Stop over only a wake ends the wake at its dispose, not at the alarm:
D59's text had the alarm force it and the Queued Run wait for the alarm, but R2's
`interruptSessionEffect` disposes the query at once (`disposeSessionEffect`, claude-runner-payload.ts
2763-2783 at 6c9ff950) and the
Queued Run launched before `deadlineAt` (the D59 spike's trace W, measured); the arm had no
observer of that end, so the payload now appends `turn_ended` (8.3). A runner's retirement now
appends one event: R2's fence test expects none (`before`, runner-retirement-fence.test.ts 9299 at
6c9ff950) and now expects the retirement's `process_lost` after it, because the write that sets
`retired_at` is the loss's one observer (6.5; the D59 spike pass 2, measured).
Build round 2 replaces six: LI1 and LI6 read `live` (main's starts and native commands, folded),
not a start or native command decide issued, since under D60 decide issues neither; another
provider's `turn_ended` is Rejected (3.4), not a wake's end, since only Claude's payload has a wake
turn (row 215); a Run with no result ends with main's terminal for its run (`provider_error` when
main reports an error), not `completed`, since main ends such a turn as an error (claude-runner-payload.ts
2120-2126 at 6c9ff950); a send's Unknown outcome probes at the outcome plus `probeMs`; an OpenCode
Stop's probe goes out in the Stop's decision; and no expectation has the ledger answer a permission
on timeout, since main's `PermissionTimeoutLive` does (timer-wiring.ts 20-40 at 6c9ff950).
Build round 2b replaces three: a control's outcome arrives as `effect_outcome` naming main's
`(commandId, transmission)`, not a `ctx.newId` token, and `lastRefusal.attempt` is that pair; no
expectation has decide probe an answer before a retry; and a Run whose fold has no result ends
only once main's terminal for its run has folded, with that terminal's reason, in either fold
order of `query_ended` and `turn.error`.

Risks: only a Stop or Run now commit opens or joins the ledger stop deadline (L6), and a user
Stop or Run now always makes one: `acceptStopEffect` always sets `stop` with a `deadlineAt`
(`STOP_ABORT_WAIT_MS`, orchestration-engine.ts 871-880 at 6c9ff950, the D59 spike measured), so
label work open only at another control's commit (`stop: null`, a Run-less `end_session`
included), at U2's retire `end_session`, or at a legacy row stored with none
(`legacyStopOwnersQuery`, orchestration-engine.ts 726-753 at 6c9ff950) ends by its own end or
coverage, as main; the OpenCode L1 exception ends Runs main leaves open, a ledger-only delta that
changes no main event, row or provider call; the alarm and a retirement's `process_lost` end the
same work with the same reason in either order, but the work is forced only when the alarm folded
first (L6, 3.8, inferred); a runner whose session row is gone or has no project appends no
`process_lost`, so its Runs stay unsealed (row 215; the D59 spike's reader requires a project,
measured; reach low, a guess); the four input
kinds REDESIGN-11 names are not generated yet; the odds of a twelfth redesign are about one in
four, mostly from the two joins left (the commit's `deadlineAt` the arm reads, and the evidence
events), each with one owner per side and a mechanical check. The raw retirement's mark sits in
commit-and-signal's recover gate, main-side plumbing the arm never reads, so it is no third join.
The retirement's `process_lost` (6.5) carries these, one line each:
- a quiet daemon folds a raw retirement's loss only at its next commit or restart; a Stop's `Gone` settlement commits soon after (T5x, inferred);
- an append defect rolls back the retirement and fails it as any defect does (6.3); both write the same SQLite file, so a store that cannot append cannot retire either, and an append's store fault is the retirement's, retried (T6, inferred);
- event retention could prune a `process_lost`, and its once-per key is the event row (L7, inferred);
- a runner retired before 32.4 lands has none (inferred);
- the mark is per SqlClient: if several projection runners shared one client, only the first to commit would recover (inferred);
- a wake that took a merged steer and is then disposed ends only at the alarm if `turn_ended` keys on no `currentRunId`; row 215 keys it on the first clear of its own `turnInFlight`, and 32.6 traces it (E2, measured); a wake's stream failure ends it at the translator's `endTurn` (E13, measured).

Terms changed (T3 reads this line; each backticked item is a literal, case-insensitive search;
a live hit of a deleted term is stale, of a changed one a reader to check): deleted or renamed,
`D57`; `run seam`; `service boundary`; `read surface`; `Run Effects table`;
`ProviderTurnServiceTag`; `claim guard`; `runs it as any row`; `only the transition function's
module`; `transition function`; `per provider`; `Switch for`; `outbox path`; `four verbs`;
`` `record` ``; `Deleted:`; `wake labels`; `uniqueness constraint`; `one provider at a time`;
`processLost`; `kill_and_respawn`; `retry claims`; `wake_started`; `retirement transaction`; and
from REDESIGN-11, `row 214`; `rows 203`; `stop's items`; `its items`; `escalates it`; `absent:`;
changed, `acceptStopEffect`; `markRunning`; `settleRunCommands`; `stopCovers`; `markCompleted`;
`writeFailure`; `refusal sweep`; `INSERT OR IGNORE`; `exempt`; `stopping`;
`legacyStopOwnersQuery`; `deadline step`; `process_started`; `alarm_fired`; `Stop commit`;
`retryAt`; `process_lost`; `retirement settlement`; `effect_outcome`; `requeueLegacySend`;
`requeueFailedSteers`; `deadlineAt`; `DeadlineOwner`; and from REDESIGN-11, `settleSessionRuns`;
`run.requested`; `recordControlOutcome`; `ledger stop deadline`; `onInstanceStopped`; `T5-writers`;
and from the D59 spike gate, `turn_ended`; `ingestion batch`; `beforeCommit`; `nudge`;
`unprojected`; and from REDESIGN-11 review round 1, `forced`; `` one per `deadlineAt` ``;
`released`; `retirement commit`; `` `end` commit ``; `interruptMs`; `Run-less`; and from build
round 1, deleted, `EvidenceFor`; `SendToken<K>`; `wrong kind for a Send Token`; `ctx.replaying`;
`deadline step does`; changed, `run_now`; `Tokened`; `PendingConfirm.step`; and from build
round 2, deleted, `requesting decision`; `issues in the decision that admits`; `cancel the
in-flight request`; `token minted in that decision`; `mints Run ids`; `mints tokens only`;
`timeoutAt`; `reason: "timeout"`; `permission timeouts`; `"Send" | "Interaction"`; changed,
`run_dispatched{runnerId`; `bound by run_dispatched's`; `Drain arm hands off`;
`"retryable"; readonly retryAt: number }`; and from build round 2b, deleted, `readonly tag:
"Held"`; `attempt: SendToken`; `reconciled by probe`; `retransmit with a fresh token`; `answers,
retries and probes`; `issues a new start decision`; `start mode belongs to the ledger`; `other
than a direct start`; `no 2.1 row names them`; `probes the input or interaction`; `interaction
probe`; changed, `MainTransmission`; `(commandId, n)`;
`newId`; and from build round 2c, deleted, `writer of a claimed transmission's outcome`; `outcome
written with no claim`; `writers are not edited`; changed, `retirePendingPrompts`; `claimed
attempt_count`; and from build round 2d, deleted, `answer_consumed`; `answer_pending`;
`` `deliver_answer` it confirms ``; `answer confirmation`; `answer probe findings`; `latest try
got`; `the effect's for`; `runner-held or not`.
D59 is new and each of its readers is written here; A.20's terms are carried so a stale reader of
them stays swept.

Rule count against HEAD, by A.17's convention, itemized (T3 counts these bullets):
- Base, A.20: 60 deleted, 65 added.
- Deleted from A.20's additions: the stop's items beside main's entry, U2's step retiring their
  runner and its wait on them (D54, L6, 2.1 row 203).
- Deleted from A.20's additions: an OpenCode deadline step with items ends them through
  `settleSessionRuns` (2.1 row 214).
- Deleted from A.20's additions: a runner deadline step that cannot retire ends its items through
  `settleSessionRuns`, the `absent:` case included (L6, 2.1 row 214).
- Deleted from A.20's additions: a fresh-run claim's `run.requested` folds as a transmission (3.4);
  replaced below.
- Deleted from A.20's additions: evidence events from the unit that observes each fact (2.1 row
  215); replaced below.
- Added: D59, one model per piece of running work, one observer per fact (2.1, L6).
- Added: the one ledger stop deadline per session row, at the `stop.deadlineAt` of the Stop or Run
  now commit that opened it, over the label work with no open main run (L6, 3.7).
- Added: the ledger stop deadline's alarm forces only work no observer ended, as forced work-ended
  facts, with no kill, main event or confirm (L6, 3.8).
- Added: a Claude wake ends at its `turn_ended`, from the payload's `turnInFlight` flag, its own
  end and not forced, `interrupted` after a Stop with no result (2.1 row 215, 8.3, 3.5, 3.8).
- Added: a transmission from its one observer, `run.dispatched` for a runner-held send and
  `run.requested` only for a direct one (3.4).
- Added: evidence events from one observer per fact, the write that writes main's terminal or
  status for it, else the ingesting write (2.1 row 215).
- Added: `process_lost` in each write that first sets `retired_at`, in its transaction,
  projected with a commit or marked for the next commit's recovery (6.5, 3.9, 32.4).
- Added: an OpenCode crash, replacement or URL change ends its Runs at the next id's
  `process_started`, while main leaves them open (L1, 9).
- Added: main's run events enter decide as `Main` observations named by main's event id, a repeat
  Accepted with no events (3.4, 3.13, D60); build round 1.
- Deleted HEAD rule: a hold bound to its issue by `commandId` and transmission alone (3.4); build
  round 2, replaced below.
- Deleted HEAD rule: the ledger mints a user Run's id and reserves it at admit (3.4, 3.6, 3.13);
  build round 2, replaced below.
- Deleted HEAD rule: the ledger's permission timeout deadline and answer (3.7, 3.10, 3.13); build
  round 2.
- Added: a hold names its Run by `runId` and its issue by `commandId` (3.4, 3.13, D60); build
  round 2.
- Added: a user Run's id is its reserving `run.requested`'s `runId`, main's, reserved there (3.4,
  3.6, D60); build round 2.
- Added: a send's Unknown outcome opens its recovery probe's deadline at the outcome plus
  `probeMs` (3.7, D20); build round 2.
- Added: OpenCode's Stop decision issues its `native_session` probe with `cancel_request` (5.1,
  3.6); build round 2.
- Added: past Settling's deadline a Run shows Running with no deadline (3.6, 11A); build round 2.
- Added: with no result, condition 2 reads main's terminal for the Run's run (3.8, 5C); build
  round 2.
- Added: with no result and no main terminal, condition 2 reads `completed` (3.8, 5C); build round
  2.
- Added: a runner provider's interrupt's work ends when every Run it names has ended (9, D59);
  build round 2.
- Added: `retryable` carries main's receipt code, which `lastRefusal` shows (3.10, 3.13, 10B);
  build round 2.
- Deleted HEAD rule: the ledger mints the Send Token of each effect with no hold, `ctx.newId`
  (3.4, 3.13, 4.11); build round 2b, replaced below.
- Deleted HEAD rule: an ambiguous answer is reconciled by a probe before its retry, the probe's
  `interaction` target (3.7, 3.10, 3.13); build round 2b.
- Added: whoever issues an effect names its transmissions, so each one main issues is main's
  `(commandId, n)`, `n` the outbox `attempt_count` with no hold (3.4, 3.13, 4.11, D60); build
  round 2b.
- Added: each writer of a control's outcome appends its `effect_outcome` with main's
  `(commandId, n)` and the status it writes, `markCompleted` and `writeFailure` included (2.1 row
  215, 3.9, 3.12); build round 2b.
- Added: a Run with a main run and no result ends only once main's terminal for its run has
  folded, so either fold order gives one end (3.8, 5C); build round 2b.
- Added: every writer that ends a control row appends its `effect_outcome`, the refusal sweep,
  `drain` and pending-prompt retirement included; a row no claim reached names n 0 and ends its
  issue never transmitted (3.4, 3.12, 2.1 row 215, D60); build round 2c.
- Deleted HEAD rule: a native command's confirmation clock stops for a `not_sent` try and resumes
  with the time it had left (H4, 3.7, 8.5); build round 2d.
- Deleted HEAD rule: a native command's receipt answers its send, and one naming another commandId
  is Rejected (9, D21); build round 2d, replaced below.
- Added: a row main's executor runs gets no `not_sent`, its gate preceding its claim, so its try in
  a project not served shows nothing; a `not_sent` or `delivery_unknown` naming a transmission is
  Rejected (3.4, H4, 4.7, D48); build round 2d.
- Added: D61, a control main issues is answered only by its `effect_outcome`; the resolution of an
  answer's interaction and a native command's receipts are unsolicited, naming that interaction or
  command, so they read the same before or after the outcome (3.4, 9, D21); build round 2d.
- Result: 67 deleted and 84 added, 17 net added, against A.20's 5.

Net rule change, deleted minus added: -17 (67 minus 84); REDESIGN-11 withdraws 5 of A.20's
additions and adds 8, net -3, build round 1 adds 1, build round 2 adds 6, build round 2b adds 1,
build round 2c adds 1 and build round 2d deletes 2 and adds 2.
Rewritten in place, counting nothing: 2.1's intro and rows 202 and 205; L6's stop, deadline step,
restart and end; 3.7's derived deadlines and Starting clause; 3.4's Send Token, minter and
`IssuedEffect` comments; 5.4; 6.5; 9; 3.12's writer list; the 12.2 rows; A.20's Run end cell. The
D54, SPEC Stop, D43, SPEC Deadlines, 82tn.32.2.14, D4 and D28 entries are rewritten in place and
stay amendments (30). Review round 1 rewrites in place, counting nothing and adding no decision or
amendment: L6's Stop or Run now commit, its one deadline per session row and its retirement order;
`forced` as the alarm's alone (3.8, 5.1, 8.3); 3.7's stop budget; 3.13's `stop` and `end` inputs,
`process_lost`, policy and `DeadlineOwner`; rows 202 and 205; 3.4's driver read; the 12.2 rows; the
D54, D59, FB §4 and D4 entries. Build round 1 adds D60 and five amendments, and rewrites in place,
counting nothing: 3.2's policy, 3.4's kind check, 3.6's unlaunch view and wake, 3.7's Stop target
and Queued retry, 3.13's comments, `run_now` and `PendingConfirm.step`, 8.2's and 12.2's server
pointer, 8.4's step, LI2's unlaunch sentence, and 3.12's and 4.7's replay. Build round 2 adds ten
amendments, and rewrites in place, counting nothing: 3.4's kind check (`turn_ended`), 3.13's
`SendToken`, `newId`, `IssuedEffect` and `run_requested` comments, 2's Run id row, 4.11's minter,
8.5's issue, D17's entry and LI1 and LI6. Build round 2b adds three amendments, and rewrites in
place, counting nothing: 3.6's `reconcile` order, its `Moved only by` and retry bullets; 4.5's
ResumeRejected, 4.8's resume fallback and the model-gaps start mode entry; 8.5's issue; 3.9 item
1's list of eventless writes; 3.12's unguarded-write note; the glossary's and 2's Send Token,
transmission count and identity rows; 3.13's `SendToken`, `newId`, `RunEffect` and `Control`
comments; and 12.2's 32.3 row. Build round 2c adds one amendment, and rewrites in place, counting
nothing: 3.9 item 1's and 3.12's `acceptStopEffect` DELETE as send rows only; 3.10's answer end;
3.12's `Main's writers` sentence; 3.13's `effect_outcome` and `MainTransmission` comments; and
12.2's 32.3 row. Build round 2d adds D61 and three amendments, and rewrites in place, counting
nothing: 3.4's one row per Control and n 0 sentences, its answer findings and receipt list and its
confirming `interaction_resolved` sentence; 8.4's `end` steps; 3.13's `Unsolicited`, `not_sent`
and `probe_result` lines; 4.4's native command answer; 8.2's runner events; and the D21 entry.

<!-- src: REDESIGN-11 2026-10-31 (/private/tmp/r32-redesign-11); REDESIGN-10 review rounds 1 to 3 (ub, poteto, /private/tmp/r32-redesign-10/review-*-out.md); main at 1ba91324 (provider-turn-service.ts 202-405; 78 `provider_runs` query sites in 23 files); R2 at 6c9ff950 (orchestration-engine.ts 658-940; session-run-settlement.ts 27-59; orchestration-side-effect-reactor.ts 1606-1624; runner-receipts.ts 619-628); competitor survey: t3code, paseo, bb, monocode, capy, zeron (/private/tmp/r32-redesign-6/survey) -->

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
- **A removed project's transmitted OpenCode work is unbounded until the project returns** (3.11,
  D48). Removal leaves managed OpenCode running and disposes the relay, so no OpenCode evidence
  reaches the ledger: the Run ends by its deadlines, but its send may still act. Accepted:
  OpenCode really may still act, and a removed project's worktree is not cleaned up, so nothing
  reads that liveness until a re-add reconciles it (9).
- **A not-served project's input polls at the backoff** (3.11, D48). While a registered project's
  relay stays down (a load error until the next successful load, a folder missing until it
  returns), its session's head input stays Queued and is tried again every 30 s at most (3.6, H4),
  and once the project is served it goes at
  its next backoff, up to 30 s later. Main's inbox waited with no Run and drained when the relay
  started, and main failed a claimed, unstarted send on a relay load error
  (`refuseProjectCommand`), which this contract re-sends instead. Accepted:
  waking it at once needs a project input in the ledger, which D48 removes; no input is lost.
- **Startup can finish before its forked Stops commit** (6.3). Until such a Stop commits, the
  runner's row is unretired, so `holdRun` may hand a recovered owner send to a runner whose Stop
  is still `Committing`. On an older runner build, which does not journal a send before running
  it, that send can settle `delivery_unknown` once the runner is gone (7.3). Accepted: holding sends
  back in memory would break STOP-INTENT S1, since nothing is fenced in memory before the commit;
  the database guards dispatch (4.3).

<!-- src: RA §10 (risks 1-4); AUDIT Bottlenecks inherited; AUDIT-2 Bottlenecks; STOP-INTENT S1, failure mode 3; REAPER failure modes 10, 11; 32.29.3 (c6d3a44f) -->
