# Amendment 2026-10-28: a runner swap is prepare, one commit, promote (Q33 = A + E + M, built as J + K + M)

Approved 2026-10-28 (Q33; design sections 1-5 approved in turn). This file wins over every other
file in this folder. It refines `AMENDMENT-2026-10-27-STOP-INTENT.md` (S1, S2, S5) for the runner
upgrade of 85kb.13 (make-before-break at turn end). Everything else in STOP-INTENT stands.
User-visible behaviour is unchanged: an upgrade still happens only at turn end on a fully idle
runner, the replacement is still warmed with the frozen settings snapshot, and a racing send
still stays on the old runner.

## Why

Implementing STOP-INTENT stopped at the upgrade path (`/private/tmp/r2-stop-intent/impl-report.md`,
"Blocking upgrade contract conflict"). The report read `upgrade-retire` as a fence before the Stop
commit. It is not: the runner's own comment says "Retirement is a reservation until the server
commits its route", and any command cancels it. It refuses nothing; it only keeps the runner's
quiescence sticky and blocks its idle exit. The real gaps are two:

| gap | today |
|---|---|
| Stop after the point of no return | the swap promotes the replacement, then forks `stopRunner(old)` unawaited. Under S1 that commit can fail, leaving the old runner unrouted with idle exit blocked until the next daemon restart |
| two owners of "which runner serves this session" | after a crash, restart picks between old and new runner by roles the runners write into their registry files (`newestRunnerFirst`, `preserveRole`), beside the database |

## S6. A swap is prepare, then one commit, then promote

- **Prepare.** The old runner takes a reservation on itself (`Reserved{revision}`), granted only when
  it is quiescent: no turn, no background work, no held spool frames, no subagent finalizers. It
  refuses no command; any command cancels it. A reservation the runner holds on itself that refuses
  no command is not a fence in S1's sense.
- **Commit.** Under the lock, after the existing re-check: `requestStop(old, Superseded{successor: R})`.
  One transaction checks that the old runner's row is not retired, that **no non-terminal run is
  held by the old runner** (S5's holder), and that R's row is a non-retired candidate; it then
  writes the old runner's retirement and sets R's role to `serving` (S7).
- **If the commit fails or is refused, nothing changed.** The daemon sends `upgrade-cancel` (the old
  runner returns to Serving), stops R with `CandidateAbandoned`, marks the upgrade failed and backs
  off as today.
- **Promote** (in-memory route, `upgrade-activate`, adopt R live, close the old runner's send scopes,
  mark switched) happens only after the commit. The old runner's Stop is then carried out by the
  reconciler like any Stop (S3). Nothing is forked unawaited.
- Every command the daemon sends to a runner bumps that runner's activity counter under the lock,
  so the re-check cancels a swap that a non-run command (settings change, MCP toggle) raced.

## S7. The database names each session's serving runner

- The runner row (`claude_runner_cursors`) gains `role`: `candidate` or `serving`. A partial unique
  index allows at most one non-retired `serving` row per session. Two serving runners are refused
  by SQLite, not by code.
- `register(runner, session, role)` creates the row when the process exists (pid and start time
  known), before warming.
- Restart is a read of the rows: a non-retired `serving` row is adopted live (sending
  `upgrade-activate` first if the runner still reports Candidate); a `candidate` row is stopped
  (`CandidateAbandoned`); a retired row goes to the reconciler.
- Stopping a session's serving runner for any reason other than `Superseded` retires that session's
  candidates in the same commit. There are no orphan candidates by construction.
- Deleted: the registry `role` field as a source of truth, the role ranking in `newestRunnerFirst`,
  `preserveRole`, and the hello-time retiring reset on the daemon side. The registry file keeps
  identity only. Older runners that still write a role are ignored.

## S5 refined: the module chooses the holder

`holdRun(session, run) -> runnerId` reads the serving row inside the same transaction that writes
the holder. No caller picks a runner; dispatch sends to the id it gets back. `HoldRefused` covers
"no serving runner" and "serving runner retired", handled like a refusal from a stopping runner
today. A send therefore runs on exactly one runner whichever of it and the swap commits first:
send first, the swap is refused (85kb.13's "racing send stays on the old runner", now enforced by
the database); commit first, the send is held by R.

## One module, seven calls (K)

The slot and the STOP-INTENT reconciler share one commit and its join semantics, so they are one
module: `runner-retirement.ts` grows into it.

```ts
register(runner, session, role: "serving" | "candidate"): Effect<void, RegisterFailed>
requestStop(runner, reason: StopReason): Effect<void, StopFailed>
holdRun(session, run): Effect<RunnerId, HoldRefused>
serving(session): RunnerId | undefined     // read of the cached row
state(runner): RunnerStop                  // read only
awaitStop(runner, "Escalated" | "Settled"): Effect<void>
recover(): Effect<Recovered>               // startup: serve / stop / reconcile

type StopReason =
  | { _tag: "Explicit" } | { _tag: "EndSession" } | { _tag: "ProjectRemoved" }
  | { _tag: "Idle" } | { _tag: "Exited" } | { _tag: "CandidateAbandoned" }
  | { _tag: "Superseded"; successor: RunnerId };
```

- (J) A swap is `requestStop(old, Superseded{R})`. Racing Stops on the old runner join its
  `Committing` state as in STOP-INTENT S2; if a plain Stop wins, the swap is refused and the session
  has no serving runner.
- No `release`: ending a session is a request stop on its serving runner; retired rows do not count
  for the unique index.
- The upgrade module (`runner-upgrade.ts`) owns no Stop logic: retire, re-check, `requestStop(old,
  Superseded{R})`, then promote on success or cancel on failure.
- Errors reuse today's: `StopFailed` is `runnerFailure("stop runner")`; `RegisterFailed` and
  `HoldRefused` reuse the existing runner failures.

## M. The runner's role is one typed state

```ts
type RunnerRole = { _tag: "Serving" } | { _tag: "Reserved"; revision: string } | { _tag: "Candidate" };
decideRunnerRole(role, event: Retire{revision, quiescent} | Cancel | Activate | Command | Hello): RunnerRole
```

It replaces the runner host's `retiring` boolean, `role` string and three scattered resets. The
reply to `upgrade-retire` is whether the role became `Reserved`; idle exit reads `_tag ===
"Reserved"`; Hello turns `Reserved` back into `Serving` (a daemon restart dropped the swap);
`upgrade-activate` only clears `Candidate`. The runner persists nothing about its role. The wire
protocol does not change.

## Swap flow and crash points

| step | crash right after it |
|---|---|
| 1. spawn R, `register(R, S, candidate)`, warm | old adopted live; R stopped |
| 2. prepare: re-check, `upgrade-retire`, old is Reserved | old's hello clears Reserved; old adopted live; R stopped |
| 3. commit: `requestStop(old, Superseded{R})` | old retired, reconciler continues from Requested; R adopted live, activated if still Candidate |
| 4. promote | same as 3 |
| 5. reconciler stops old (Requested to Settled; nothing held) | per STOP-INTENT |

## Failure modes this must handle

STOP-INTENT's 10 and the reaper amendment's 11 still apply. Added:

11. The swap commit fails: nothing changes, upgrade-cancel, R stopped, upgrade failed with backoff.
12. A send lands before the commit: the swap is refused, the send runs on the old runner, the
    upgrade retries at the next turn end.
13. A send lands after the commit, before activate: R holds it, and the command reaches R only after
    `upgrade-activate` (dispatch writes under the lock promote holds). After a crash, adoption
    activates R before replay.
14. A plain Stop races the swap: one commit wins, the other fails cleanly; never two serving rows.
15. A command that holds no run reaches the old runner after prepare: its activity bump makes the
    re-check cancel the swap. The implementation must confirm every command path bumps the counter.
16. Upgrade-cancel is lost because the old runner disconnected: its hello clears Reserved; if it
    never reconnects, the liveness watcher stops it with reason `Exited`.
17. R dies after the commit: Stop with reason `Exited`; the session has no serving runner and the
    next send spawns one. Anything R held settles at `Gone` through the existing settlement path.
18. A runner on an older build: the wire protocol is unchanged; its registry role is ignored;
    `preserveRole` is no longer sent; a Reserved old-build runner clears on hello.

## Migration

- Add `role TEXT NOT NULL DEFAULT 'serving'` through `claude_runner_cursors`' existing ALTER path,
  then the partial unique index on `session_id WHERE retired_at IS NULL AND role = 'serving'`.
- Before creating the index, backfill sessions with more than one non-retired row using today's
  ranking once (registry role, then `newestRunnerFirst`): the winner stays `serving`, losers become
  `candidate` so `recover()` stops them. Without a registry file, the newest row by sequence wins.
  A wrong pick is safe: that runner was idle and the next send resumes the session.
- The daemon store import carries `role` beside the `stop_*` columns.
- The backfill's ranking code is deleted with the other legacy paths (32.13).

## Tests

- End to end with real processes, extending `claude-runner-upgrade`, `claude-runner-restart` and
  `runner-forced-stop`, each writing a JSON evidence artifact under `CONDUIT_RUNNER_EVIDENCE_DIR`:
  (a) daemon SIGKILL after the commit, before activate: R adopted live, old retired and reaped, the
  next send runs on R with the warmed query reused; (b) daemon SIGKILL after prepare, before the
  commit: old adopted live, R stopped, the next send runs on old; (c) a send racing the commit runs
  on exactly one runner and reaches a terminal state. Crash points use a test-only pause hook in the
  existing env-var style, honoured only under `NODE_ENV=test`. All reaper end-to-end tests still pass.
- Through the manager's interface with the injected process table and an injected commit failure:
  failure modes 11-17 and "a session Stop retires its candidates". Each asserts runs reach a terminal
  state or keep running, never a stuck `running`.
- Migration: two live rows for one session end as one `serving` and one `candidate`; the index
  exists; a second `serving` insert is refused.
- The runner role through the runner's wire protocol in the existing runner-host tests: retire while
  busy is refused, a command cancels the reservation, hello clears Reserved.
- The two upgrade failures that also fail on main ("notification-driven parent turn ...
  before-restart / during-warm", adf36036) are in this path: fix their cause, do not skip them.

## Prior art

Competitor manifest (update-competitors, 2026-10-28): t3code 5e9d56416f, bb 7125b90a6f,
paseo de50243885, zeron 31d26eeb6b, diri 19e981e848, monocode 26465c6209, capy docs snapshot 2026-10-27.

| competitor | live upgrade | stop recorded before signal | what names the serving process |
|---|---|---|---|
| t3code | kill all, start the new build as a trial, commit on "prepared" or roll back a DB backup (`apps/server/src/serviceLauncher.ts:678-817`) | no; written after the kill, startup reconcile (`ProviderSessionManager.ts:966-1022`) | SQLite exclusive lock (`serverOwnership.ts:177-240`), in-memory map |
| bb | daemon kills all; one bridge restarts when its threads are idle (`packages/agent-runtime/src/runtime.ts:926-1050`) | yes: commit `stopping`, then RPC, reconcile on reconnect (`thread-lifecycle.ts:1332-1395`) | DB session row + `instanceId` fence (`session-owner-side-effects.ts:79-114`) |
| zeron | wait for idle, re-check right before the swap, restart (`crates/update/src/lib.rs:1231-1352`) | marker file for user Stop only (`sessions.rs:1388-1415`) | OS lock file + run-id checks (`instance_lock.rs`, `sessions.rs:1878-1882`) |
| diri | never: sessions keep their build, versioned binaries (`REMOTE_PORT.md:387-404`) | no; kill then persist (`registry.rs:1516-1536`) | flock + incarnation + epoch (`holder.rs:856-884`) |
| paseo | kill, lazy resume (`scripts/supervisor.ts:458-467`) | no (`agent-manager.ts:1923-1966`) | pid lock file, in-memory map |
| monocode | stop the world (`src-tauri/src/remote_bootstrap.sh`) | no; running rows settled on boot (`host/engine.ts:266-287`) | SQLite `BEGIN EXCLUSIVE` + `runId` (`host/owner.ts`) |
| capy | not documented | not documented | not documented |

- **Convergence:** no competitor hot-swaps a live worker. Conduit's warm make-before-break is ahead
  of the field, so the commit point has no direct model.
- **Taken:** t3code's trial-then-commit shape (commit only once the new build is ready, otherwise
  roll back); zeron's re-check immediately before the swap; bb's "commit the stop, then act" and its
  database row naming the serving process; diri's lesson that identity, not a role file, decides
  ownership.
- **Different on purpose:** conduit keeps the swap rather than kill-and-resume (paseo, zeron, bb,
  monocode) because 85kb.13's warm query and frozen settings snapshot are user-visible value; and it
  makes the database refuse a swap while the old runner holds a run, where competitors rely on a
  single worker at a time.

## Decisions

Q33 = A + E + M, built as J + K + M: the runner's retire is a reversible prepare; one commit stops
the old runner and makes the replacement the session's serving runner; promote follows the commit;
the database names the serving runner; the runner's role is one typed state.
