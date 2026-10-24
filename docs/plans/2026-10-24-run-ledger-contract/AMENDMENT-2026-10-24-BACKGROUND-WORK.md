# Run Ledger amendment: background work, wake turns and goals (82tn.32.2, 2026-10-24)

Supplements AMENDMENT-2026-10-24-FACT-BOOK.md, AMENDMENT-2026-10-23-OUTSTANDING-WORK.md,
AMENDMENT-2026-10-23.md and the rulings files. Where this file and those disagree, this
file wins. The user approved this design on 2026-10-24: joint-planning answers 2B, 3A,
4A, 5A (snapshot rule as corrected below), 6A, 7A, 7D (native keying), 8F with its two
riders, design sections 1-6 as presented, and Q9: Pause only where the provider has a
native goal pause (Codex today); Clear-only with Claude's queue shown for the others
(9F). Goal-probe findings (/tmp/82tn-beads/art-goalprobe/findings.md and
art-goalprobe2/findings.md, SDK 0.3.301, CLI 2.1.301) are folded in.

Also approved on 2026-10-24: the Runner lifecycle section (Q10 = 10A, Q11 = 11A,
Q13 = 13A, sections 1-7) and the Codex goal changes (Q12 = 12A). Codex goal-probe
findings (/tmp/82tn-beads/art-codexgoal/findings2.md, Codex 0.162.1 app-server) are
folded in.

Open items: none. Two Codex behaviours were not probed and are carried as E2E checks
(Decision 5): whether setting a goal on a fresh thread self-starts a turn, and what
Pause, Clear and Stop do to a live background terminal.

## Why

Conduit's background-work plan had several owners of one answer ("may anything still
act?"): the Run Ledger for foreground Runs, an in-memory `background-liveness.ts` for
tasks, the composer for goal Pause/Resume (wired to Stop and to sending "Continue."), and
an idle-Stop goal-pause stopgap. Every competitor surveyed splits this state the same way,
and that code churns constantly (Prior art). The Fact Book already owns outstanding work
for sends; this amendment extends the same owner to the rest.

## Decision 1. Who owns what

**The Run Ledger owns everything about whether work may still act.**

- **Foreground Runs:** `origin: input`, as in the Fact Book.
- **Wake Runs:** `origin: wake`, turns the agent started itself (4A).
- **Background tasks:** facts keyed by task, never Runs, taken from the latest snapshot
  of the current process generation (5A).
- **Process generations:** one per Claude process lifetime (7A). Close, kill, process
  loss and runner retirement each end a generation.
- **One answer** to "may anything still act?": Runs, sends and tasks combined.
- **Lost-work records and destructive-escalation confirms** (6A).
- **Native commands** (goal set, pause, resume, clear): sends that are not Runs. They
  skip the inbox and are never held by conduit (8F rider 1).

**The goal tracker owns the goal**: the condition, its counters, and the phase (Active,
Pausing, Paused, Resuming, Limited, Clearing, Met, Cleared). It asks the ledger to deliver goal
commands and reads the provider's confirmation. It never touches Runs, and the ledger
never reads goal state (3A, 8F). One goal adapter per provider turns the four actions
into native commands: Claude `/goal` text, Codex `thread/goal/set` and
`thread/goal/clear`.

**Pause exists only where the provider has a native goal pause (Q9).** Codex has one
(`thread/goal/set {status:"paused"}`, and `"active"` to resume). Claude does not:
`/goal` only sets, clears and reports status, so conduit offers no Pause for Claude
goals and never emulates one. The goal adapter declares `pause: boolean`; the UI shows
Pause and Resume only when it is true.

**The runner manager stamps the generation** on every output. Output from a retired or
replaced runner is dropped before it reaches the ledger. That is a transport guard, not
a second owner; the Runner lifecycle section defines its mechanism.

**SessionActivity is a read-only view** combining the ledger view and the goal phase into
what the UI shows: the Run label and origin; background tasks (live, unknown or none);
lost work and any pending confirm; the goal phase, including "queued by Claude" (8F
rider 2). It stores nothing.

**Providers declare what they support.** Claude and Codex report background tasks.
OpenCode and Cursor report none, so for them the answer covers Runs and sends only.
Codex's snapshot is `thread/backgroundTerminals/list`, re-read on turn completion, on a
terminal command's start or finish, after a stop, and on reconnect. Late command events
after the turn ends only update the snapshot: they never reopen a Run and are never an
error (a terminated terminal reports failed, exit -1).

**Deleted:**

- the in-memory `background-liveness.ts` owner;
- the translator filter that drops ambient tasks (now recorded, classed as monitoring);
- the composer wiring of Pause to Stop and Resume to sending "Continue.";
- the session inbox's busy-slash hold (`interruptForInput` for slash commands), which
  kept `/goal clear` in conduit's inbox until the Run settled and coupled it to an
  interrupt;
- on main, the Codex runner's goal commands parsed from chat text in the turn path
  (`parseCodexGoalCommand`), and its Stop path pausing the goal
  (`thread/goal/set {status:"paused"}` on interrupt), which couples Pause to Stop;
- the other session's idle-Stop goal-pause stopgap, once it ships.

## Decision 2. Interface

The ledger keeps its four verbs (`admit`, `observe`, `settle`, `control`) and
`decide`/`evolve`/`viewLedger`. New kinds within them:

```ts
// control (user actions)
| { kind: "stop_tasks"; tasks: "all" | readonly TaskKey[] }
| { kind: "confirm_escalation"; snapshotEntry: number }
| { kind: "native_command"; commandId: string; text: string } // from the goal tracker

// observe (every observation gains `generation`)
| { kind: "tasks_snapshot"; tasks: readonly { key: TaskKey; taskType: string; subagentType?: string; description: string; ambient: boolean }[] }
| { kind: "task_event"; key: TaskKey; event: "started" | "completed" | "failed" | "killed" | "notification" }
| { kind: "turn_started"; wakeTask?: TaskKey }           // the agent began a turn itself
| { kind: "command_lifecycle"; commandId: string; state: "queued" | "started" | "completed" | "cancelled" }
| { kind: "command_result"; commandId: string }          // zero-turn result for that input

// settle
| { kind: "process_started"; generation: Generation; reattached: boolean } // opaque (Runner lifecycle 1)

// effects
| { kind: "stop_task"; key: TaskKey }
| { kind: "send_native_command"; commandId: string; text: string }

type TaskKey = { taskId: string; runId?: string } // 7D: Claude's native ids
```

**Task identity (7D).** A task is keyed by Claude's `(task_id, run_id)`; `task_id` alone
when the CLI omits `run_id`. No conduit-minted task ids.

**Task kind and class.** The kind comes from `task_type` (`local_bash` shell,
`local_agent` subagent, `local_workflow` workflow, `monitor`, `mcp_task`, anything else
kept verbatim). A task is classed **monitoring** when `ambient` is set or its kind is
`monitor`; otherwise **work**.

**The view gains:**

- `active.origin`: `input` or `wake`, plus the waking task if known.
- `tasks`: `none`, `unknown`, or `live` with each task's kind and class.
- `anythingMayAct`: the single answer.
- `pendingConfirm`: the action, the snapshot entry, and the tasks it would destroy.
- `lostWork`: which tasks, or "may have been lost".
- `nativeCommands`: each command's state: sent, queued by Claude, started, completed,
  cancelled or failed.

**Native commands are opaque to the ledger.** It delivers the text at once and tracks
delivery only. A command's own result (`num_turns: 0`, correlated by input UUID through
`user_message_uuid`/`user_message_uuids`) completes the command and is never read as a
Run ending. If a command makes Claude start a turn (an idle `/goal <condition>` does),
that arrives as `turn_started` and becomes a wake Run. No goal special-casing.

**Stop tasks.** `"all"` means the live tasks of the latest snapshot at decision time. When
tasks are `unknown` or `none`, or the provider has no background tasks, the request is
rejected with a reason. A task is gone only when a later snapshot omits it.

**Goal tracker interface.** Actions `set(condition)`, `pause()`, `resume()`, `clear()`;
`pause` and `resume` are rejected with a reason when the adapter declares no pause.
Codex inputs: the `thread/goal/set` and `thread/goal/clear` responses and the
`thread/goal/updated` / `thread/goal/cleared` notifications, whose `status` (`active`,
`paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete`) is the goal phase.
The tracker uses the status Codex returns, never the one requested: a Pause can come
back `budgetLimited`. `blocked`, `usageLimited` and `budgetLimited` map to a phase
**Limited** (blocked, usage or budget), distinct from Paused. Budgets must be positive,
and Codex may overshoot them.
Claude inputs: the synthetic assistant reply carrying `local_command_run{command:"goal"}`
(`Goal set:`, `Goal cleared:`, `No goal set`), the matching zero-turn result, the
transcript's `system/local_command` and `goal_status` records, and the delivery state of
its commands. **Not** `active_goal`: CLI 2.1.301 never emits it (probe), though the
tracker still accepts it if a later CLI does.

**Browser actions.** New: `StopTasks`, `ConfirmEscalation`, `PauseGoal`, `ResumeGoal`,
`ClearGoal`, `SetGoal`. They replace the composer sending `/goal` text and "Continue." as
chat messages. `CancelSession` stays as Stop.

## Decision 3. Data flow

Every decision runs in the Fact Book's three phases: record facts, recompute views, act
only on views.

**Process lifecycle and the snapshot rule (5A, corrected).** A launch records
`process_started` with a new generation.

- After a **fresh launch**, tasks are **none**: a new process has no background tasks,
  and Claude emits no snapshot at startup.
- Tasks are **unknown** only when reattaching to an already-running process, until its
  catch-up snapshot arrives (re-initializing a running process yields one immediately),
  or for a CLI version declared not to send snapshots.

Evidence from an older generation is kept only when it changes a join (12A). It never
grants authority and never counts toward liveness.

**Snapshots.** The translator forwards every `background_tasks_changed`, ambient tasks
included. Each payload replaces the set. The live set is the latest snapshot of the
current generation. Per-task events serve only to name lost work, show outcomes, and
identify which task woke the agent.

**Wake turns.** `turn_started` with no active Run creates a wake Run, recorded as Launched
with no start effect. The waking task is the one whose notification came just before. If
a Run is active, the evidence joins it. A wake Run then behaves like any Run: queued
inputs wait behind it, and Stop interrupts it.

**Native commands (8F).** `native_command` records a send with no Run and no admission,
and issues `send_native_command` **in the same decision**, whether the inbox is paused or
a Run is active. It goes after sends already issued and ahead of every queued input. With
no live process it is the first send of the next launch. Conduit never holds it.

When Claude itself queues the command mid-turn (`command_lifecycle: queued`, keyed by the
input UUID), the command's state becomes **queued by Claude** and the UI shows it (8F
rider 2); `started`, `completed` and `cancelled` move it on. Today the runtime ignores
`queued` and `completed`; both now become observations.

**The single answer.** `anythingMayAct` is true when any of these hold: a Run that hasn't
ended; a send that may still act; tasks live or unknown. Background tasks never block a
new Run (5A).

**Stop tasks.** One `stop_task` effect per task: Claude through the SDK's
`stopTask(taskId)`, Codex through `thread/backgroundTerminals/terminate(processId)`. A
task counts as finished only when a later snapshot drops it.

**Goal flow.** Every goal action is a native command (above): delivered at once, never
held by conduit, never a chat message, and fully separate from Stop. Stop never pauses
or clears a goal, and goal actions never interrupt a turn.

**Codex (native pause, probe-confirmed).** `pause()` sends
`thread/goal/set {status:"paused"}` and moves to **Pausing**; Codex's confirmation makes
it **Paused** at once, and no further continuation turn starts. A running turn finishes
on its own. `clear()` sends `thread/goal/clear`; `thread/goal/cleared` makes it Cleared,
again without ending a running turn. Interrupt leaves the goal active.

`resume()` sends `status:"active"` only, never also a host turn: an idle Codex starts a
continuation turn itself, which is a wake Run. A successor turn that wins the race with
a Pause is also a wake Run, and is shown. The goal persists across a Codex restart.

**Goal row wording keys on facts, not provider (12A).**

- Applied, turn still running: "Goal paused. Codex is finishing its current turn." or
  "Goal cleared. Codex is finishing its current turn.", with Stop beside it.
- Held by the provider until the turn ends: "Clearing after this turn (queued by
  Claude)".
- The note goes when the turn ends.

**Claude (no pause, Q9 = 9F).** `set` sends `/goal <condition>`; it starts a turn, which
is a wake Run. `clear()` sends `/goal clear` and moves to **Clearing**. Probe facts:

- A mid-turn `/goal clear` is queued by Claude until the top-level turn returns a
  result, and meanwhile the goal's Stop hook keeps the agent iterating (42-90 s observed,
  ended only by `maxTurns`). Conduit does not try to shorten this.
- While Claude holds it, the UI shows "Clearing after this turn (queued by Claude)"
  with Stop available. Stop interrupts the turn; the queued clear then runs at once.
- Interrupt alone does not clear a goal. `priority:"now"` was rejected: it abandons the
  turn at the next tool boundary (the input ends `cancelled`), which is a Stop.
- An idle clear completes at once with a zero-turn result.

It reaches **Cleared** only on the `Goal cleared:` reply with its matching zero-turn
result (or the transcript clear record). The same rule covers OpenCode and Cursor if they
gain goals without a native pause: Clear only, the provider's own queue shown.

## Decision 4. Error handling

Bad or late evidence is recorded with a diagnostic and never throws. No new error types.

**An ignored interrupt with tasks still running.** If the next step (close or kill) would
end tasks that are live or unknown, the Run stays Interrupting and `pendingConfirm` lists
those tasks. The interrupt deadline never destroys on its own: the user can confirm, Stop
tasks first, or wait for the turn to settle. With no tasks, escalation stays automatic.
The same gate covers explicit restart, kill, end-session, and an ignored interrupt while
paused.

**Stale confirms.** `confirm_escalation` carries the snapshot entry it was shown. If a
newer snapshot exists, it is rejected and the UI asks again with the current list.

**Lost work is always recorded.** Every destruction records a lost-work fact naming the
tasks, or "may have been lost" when tasks were unknown. Unplanned process loss can't ask
first but still records lost work for that generation's live and unknown tasks.

**Stop task fails.** An SDK rejection or unknown id gives a diagnostic. The task stays
live until a snapshot drops it. No automatic retries.

**Goal command problems.**

- Delivery fails: the goal returns to its previous phase, with a notice.
- The process dies after sending, before confirming: the resumed session reloads Claude's
  goal from the transcript, and the command is resent first on the next launch.
- No confirmation within a deadline: the tracker re-reads native state (Claude's
  transcript through `readClaudeGoalStatus`, Codex's `thread/goal/get`). If the action
  still hasn't taken effect, it shows "Pause not confirmed" or "Clear not confirmed" with
  a retry. While the provider reports the command queued, the deadline does not run.

**Evidence from an old generation, a retired runner, or an unknown task** is recorded
only when it changes a join (12A), with a diagnostic, and gives no authority or liveness.

**No snapshot ever arrives** on a CLI declared not to send them: tasks stay unknown,
destructive steps always ask first, and the UI says "background state unknown".

## Decision 5. Testing

Extends Decision 5 of the outstanding-work amendment.

**Model-based tests through the public interface only**, fast-check, per provider. The
alphabet adds snapshots, task events, `turn_started`, `command_lifecycle`,
`command_result`, `process_started` (fresh and reattached), `stop_tasks`,
`confirm_escalation` and `native_command`. The fake provider gains background tasks, wake
turns, a CLI command queue that holds slash commands until the turn's result, and a goal
hook that keeps the agent going until a clear runs.

**New invariants, checked against the fake** (numbered after the Fact Book's I1-I4):

- I5: live or unknown tasks are never destroyed without a confirm matching the latest
  snapshot, except on unplanned process loss; every destruction yields a lost-work fact.
- I6: a native command is issued in the decision that requests it whenever a process is
  alive, never behind the inbox or queued inputs; with none alive, it is the next
  launch's first send.
- I7: evidence from an older generation never changes authority or liveness.
- I8: `anythingMayAct` is false only when the fake has no running turn, no unfinished
  send and no live task. Unknown counts as true.
- I9: each self-started turn with no active Run yields exactly one wake Run.
- I10: a command's zero-turn result never ends or starts a Run.

**Coverage gate adds:** a wake turn while an input is queued; a snapshot during
Interrupting; a stale confirm; a generation change mid-interrupt; a goal clear sent
mid-turn and held by Claude; an idle clear; a Codex Pause that returns `budgetLimited`.

**Fixed traces:** the other session's bug (Pause on an idle session did nothing), every
probe finding, and main's Codex coupling (Stop pausing the goal) as a must-not-happen
trace.

**End-to-end against the real Claude SDK.** The probe becomes a checked-in E2E test: set
a goal, start a long turn, clear, and check Clearing, "queued by Claude", then Cleared
once the turn ends; check Stop during Clearing ends the turn and the clear runs; check
Pause is not offered; start a background task, Stop tasks, and check the
snapshot empties; restart with a live task, check the confirm appears and lost work is
recorded. Artifacts: a JSONL trace plus a JSON report.

**End-to-end against a real Codex app-server**, pinned to the probed behaviour: set,
pause mid-turn (Paused at once, the turn finishes, no continuation), resume from idle
(Codex self-starts a wake Run, no host turn sent), clear mid-turn, interrupt (goal stays
active), a Pause returning `budgetLimited` (Limited), and a background terminal listed
then terminated. Each phase must come from the native notification, and no goal action
may interrupt the turn. Two unprobed checks: whether setting a goal on a fresh thread
self-starts a turn, and what Pause, Clear and Stop do to a live background terminal.
Artifacts: a JSONL trace plus a JSON report.

**Visual acceptance:** new feature files and baselines for the goal phases (including
queued by Claude), Stop tasks, the destructive confirm and the lost-work notice. The gate
runs before merging.

## Runner lifecycle (approved 2026-10-24: Q10 = 10A, Q11 = 11A, Q13 = 13A)

Replaces the 32.16 per-call-site fences with one runner record, one write checkpoint
and one ordered retirement. Evidence: /tmp/82tn-beads/art-runnergen/findings.md.

### 1. Identity

- **One generation per Claude process.** An opaque id minted by the runner before any
  write made for that process, including user-message placement before the SDK spawns.
- Every output frame is stamped with its generation **at capture**, before spooling.
- Replacing the query inside one runner (rebind, agent change, rewind, fresh native id,
  stop-after-foreground dispose, discarded prewarm, native-resume fallback) mints a new
  generation and revokes the old one while `runnerId` is unchanged. The SDK closes
  asynchronously, so old and new processes overlap.
- `runnerId` is the Node host identity (signalling, the retired marker). `attachmentId`
  is the daemon's reconnect ownership. A surviving process keeps its generation across a
  daemon restart; only `attachmentId` rotates. Logs carry `runnerId` with the generation.

### 2. Runner record

One record per runner process: `{runnerId, pid, startTime, sessionId, generation?, tag}`,
in one `records` map keyed by `runnerId`. It replaces children, candidates,
supersededEntries, survivors, retiredEntries, exiting and observedProcesses.
**Invariant:** at most one Live and one Starting record per session.

| Tag | May write | Own-sink release | Session evidence |
|---|---|---|---|
| Starting | warmup replies only | no | latest buffered, applied at promotion |
| Live | all | yes | applied |
| Exiting(superseded, ended, idle, failed, cancelled) | no output | yes | logged and dropped |
| Retired | no output | no (retirement releases) | logged and dropped |

**Transitions:**

- spawn makes Starting. Promotion makes it Live and the old Live Exiting(superseded) in
  one step.
- Query replacement in Live mints a new generation and revokes the old one; prompt
  retirement is keyed by generation.
- Stop during warmup makes Exiting(cancelled).
- End, idle or failure makes Exiting; the record leaves the map when the PID is
  confirmed gone.
- A failed kill makes Retired (section 4).
- Daemon restart: a retired marker makes Retired; any other registration is Starting
  until its hello is verified, and its generation is restored from the hello, never
  minted.

Revocation survives deletion: delayed callbacks hold the record and their captured
generation. Readiness, in-flight commands, idle exit, pending End and upgrade revision
stay in the existing lifecycle; the tag only answers "who may write".

### 3. Write checkpoint

`authorize(authority, operation) → Authorized | Stale{reason}`. Stale is logged once
(runnerId, generation, operation) and dropped (12A). It never throws.

**Authority is explicit at every write entry.** A runner-originated path without one
does not compile. Kinds:

- **RunnerOutput** `{record, generation, attachmentId}`, captured at frame capture.
- **Admission** `{send, attempt, binding}`, before a runner exists.
- **Transition** `{exit | retire | upgrade | recover, captured cohort of runs, sinks,
  requests}`.

User and daemon writes are not checked.

**Operations:**

- Session-history writes (events, projections, receipts, command and outbox rows) and
  live-state changes (task snapshot, permission-mode override, waiters, sinks) need Live
  current-generation output or a Transition covering the cohort. Live-state changes are
  rechecked at the change.
- Own-sink release needs ownership and not Retired.
- Historical accounting (late ledger accounting, usage readings) accepts any generation
  and never reopens work.

**Enforcement.** Durable runner-originated writes are checked inside their transaction at
one pre-commit hook. Receipt use, append, projection and command/outbox rows share that
transaction. Memory changes are checked at the change; a check before an `await` does
not carry over. `withEntryOutput`'s four exceptions become policy rows: no call-site
exceptions.

**Coverage.** Every write site routes through it except the retired marker (written by
the retirement transition) and the host spool and send journal (local bookkeeping,
generation-stamped, checked when consumed). A guard test fails on any runner-originated
writer that bypasses it.

**Limit.** It stops stale changes to conduit state, not a surviving process editing
files. Retired and confirmed-dead stay separate facts.

### 4. Retirement as one ordered transition

1. Tag the record Retired (in memory, synchronous).
2. Write the durable `.retired` marker with the known run ids: atomic rename plus fsync
   of the file and its directory. Steps 1 and 2 are one step; nothing interleaves.
3. Revoke in SQL: rotate the receipt, record retired status, read ownership. On timeout,
   continue; the tag and the pre-commit check still reject stale writes.
4. Release admission and sinks in parallel, with Transition authority.
5. Settle owned runs and process-specific prompts and controls, detached and revocable;
   the commit guard is revoked at the deadline.
6. Schedule the survivor watcher and notice, whatever happened in steps 3-5.

Steps 3-5 share one deadline of about **3 s** (replacing the N+3 s waits). Recovery runs
the same path with the same bounds.

**Marker write fails (11A): fail closed on that session.** Admission stays held, sends
are refused, and the UI shows "Couldn't retire the old runner safely" with Retry. Step 3
still runs. Every watcher tick and every Retry attempts both the marker and the kill;
whichever succeeds first releases the hold.

### 5. Survivors

A retired record carries survivor state: identity `{pid, startTime}` or unverifiable;
attempts 0-3; nextAt; signalled; noticed; marker written or failed. Clock and process
table are injected.

- **Stop:** Live to Exiting(stopped). Exit confirmed: the normal path. Alive after
  SIGTERM, SIGKILL and the exit deadline: retired through section 4, which releases
  admission; the next message spawns a new runner that silently resumes the same native
  conversation.
- **Retry ticks at 10, 30 and 60 s**, identity-checked. Gone, reused or zombie counts as
  exited: record and marker removed, no notice, SQL revocation kept. Verified alive:
  SIGKILL again. Unverifiable: never signalled. Either way attempts goes up.
- **After the third failure:** exactly one session-scoped `turn.notice` with no Run,
  worded by whether it was signalled. Skipped for deleted or archived sessions (retries
  continue). The banner stays if the survivor exits later.
- **Restart:** marker means Retired and the schedule restarts. Two live registrations for
  one session: the newer is Starting, the older is retired through section 4. A retired
  generation is never re-adopted.
- A replacement that can't start is the ordinary start refusal on the next message.
- **Removed:** `runner_quarantined`, its non-retryable classification, and the
  "quarantined entry still owns the session" rule.
- **The f4 stopgap is deleted, not merged:** bounded retirement is section 4's deadline;
  marker before SQL is section 4's order; the cancelled warm candidate's session-ended is
  Exiting(cancelled) emitting nothing; the subagent-session write fence is section 3.

### 6. The durable half

1. A new table `runner_generations {generation, session, runner, status current|revoked}`
   with a unique index allowing one current generation per session.
   `claude_runner_cursors` stays the replay de-duplication record only.
2. `claude_runner_cursors.retired_at`, set-only (section 4 step 3). Attach adds
   `WHERE retired_at IS NULL`: reconnect never revives a retired runner.
3. The pre-commit hook runs one SQL predicate in the same transaction: attachment
   matches, runner not retired, generation current. This covers an old write holding SQL
   while retirement waits, and brings direct user-message persistence, command-state
   writes and restored output under the rule. Historical accounting checks only that the
   generation exists.
4. The runner mints generations; the daemon registers them. A new generation becomes
   current and revokes the session's previous one in one Transition. Reconnect matches
   the hello's generation: current is restored; unknown is registered unless the runner
   is retired; revoked output is dropped and logged. A fresh attachment never mints.
5. **Restart:** a runner is retired if its marker **or** `retired_at` says so. Discovery
   reads markers, then ensures `retired_at` for each. A retired runner's spooled output
   is dropped before replay.
6. Deletion never erases revocation: revoked rows and `retired_at` are pruned only with
   the cursor row, after the process is confirmed gone.
7. **Old runners that can't stamp** get one synthetic generation `legacy:<runnerId>`,
   current or revoked like any other, and are hot-upgraded at first idle. The rule is
   removable by deletion once no old runners remain.

One migration adds the table and column; existing rows start not retired, covered by the
legacy rule.

**Residual risk:** a file plus a SQL row is not one atomic commit. If both fail before a
crash, a survivor could be re-adopted; 11A narrows that window but can't close it.

### 7. Slices (13A)

Estimate: +450 to 1,000 / -200 to 500 production lines, 8-14 files, 500-1,600 test lines.

- **R1 Runner record and transitions** (32.16): sections 2, 4 and 5 on today's identity
  (runnerId plus attachmentId). Built on the committed f4 stopgap in wt/82tn3216, which
  it deletes; merged to main once. Main never carries the stopgap.
- **R2 Single checkpoint** (section 3). Blocked by R1.
- **R3 Durable owner rows** (section 6, one legacy generation per runner). Blocked by R2.
- **R4 Per-process generations** (section 1, section 6 items 4 and 7). Blocked by R3.
- **R5 Remove the legacy rule.** Blocked by R4 and a release with no old runners.

Background-work tickets depend on R1. Those that read generations (stale confirm, a
generation change mid-interrupt) also depend on R4.

## Prior art (manifest 2026-10-24)

t3code 9828cad49f, bb 1e80ca7b44, paseo fed19f3d29, zeron dd0c36fa3e, diri e280a76d3f,
monocode 26465c6209, capy docs fetched 2026-10-23T14:04:26Z. Evidence:
/tmp/82tn-beads/art-ownersurvey/ and /tmp/82tn-beads/art-jointsurvey/.

**What competitors do.** All six code competitors split this state across two or more
owners, and callers combine the liveness answers themselves. Changes to that code since
June: t3code 445, bb 328, paseo 494, zeron 189, diri 269, monocode 199. capy (docs only)
has a single thread status, and wake events start turns.

**What conduit takes:**

- Self-started turns go through the same Run owner (t3code, paseo, capy): the wake Run.
- Task identity is Claude's native task id, separate from Runs (all).
- Stop treats a self-started turn exactly like a user turn (all).
- A durable note when background work is cancelled, after t3code's
  `run.background-work-cancelled`: the lost-work record.
- Per-task stop before escalating, after monocode's `stop_task`: Stop tasks.
- Keeping the old session when termination isn't confirmed, after diri: the confirm gate
  and generations.

**What conduit does differently, on purpose:**

- One owner and one answer to "may anything still act?". No competitor has this.
- A confirm before destroying tasks, tied to the snapshot shown. No competitor asks.
- Stop tasks for any or all tasks, with no turn involved. No competitor has this.
- Goal pause fully separate from Stop, offered only where the provider pauses natively.
  t3code and paseo likewise offer pause only for Codex goals and none for Claude; conduit
  follows that convergence and does not emulate a Claude pause.
- Background tasks never block new input.
- Order independence proven with model-based tests. Every competitor uses scenarios only.
