# Amendment 2026-10-27: one durable owner for a stopped runner's processes (Q28 = A + C)

Approved 2026-10-27 (Q29 = A). This file wins over every other file in this folder.
It refines AUDIT A12 and AUDIT-2 A13 (how escalation reaches a runner's descendants) and
RUNNER-AUTHORITY's retirement row (when it is written). A15 and the notice texts are
unchanged. User-visible behaviour is unchanged.

## Why

Three review rounds in a row on R2 phase 2 (32.17) found material bugs in one place: the
snapshot of a stopping runner's process group (`{pid, startTime}` per member, A13).

| round | how the snapshot was lost |
|---|---|
| 2 | TERM was refused, then the leader exited: the snapshot lived only in a local |
| 3 | the watcher's group KILL was refused: a fresh snapshot was kept only if a signal landed |
| 3 | the daemon crashed in Stop's TERM grace: the snapshot was on a cursor row whose `retired_at` was still NULL, so recovery never saw it |

The snapshot had no owner. It was saved only as a side effect of a signal being delivered,
or of a retirement row that is written after escalation. Each path that skipped one of
those dropped it.

## R1. The runner keeps running when the daemon dies (unchanged, restated)

Runners outlive the daemon. A daemon exit, crash or SIGKILL never signals a runner, its
reaper or its Claude sessions; the next daemon reconnects to them as today. Nothing in
this amendment watches the daemon.

## R2. Each current-build runner has a reaper

- The runner host starts one reaper at startup, as its own child, in the runner's process
  group (the runner is spawned detached, so its pid is the group id P). The reaper is a
  small `/bin/sh` process, about 1 MB, not a second Node process (about 40 MB).
- The reaper ignores TERM, HUP and INT and watches only its parent, the runner leader. It
  learns of the leader's exit without polling where it can (EOF on a pipe whose write end
  only the leader holds; libuv opens it close-on-exec, so the Claude CLI does not inherit
  it), and confirms with its parent pid.
- When the leader exits for any reason (Stop, retirement, crash, idle exit), the reaper
  sends TERM to group P, waits up to 3 s for every other member to exit, then sends KILL
  to group P, which ends the reaper too.
- The runner reports the reaper's `{pid, startTime}` in its hello. A runner without one
  (main-built) uses R5.

Why this is safe: a process group id cannot be reused while the group has a member
(A13). While the verified reaper is alive and in group P, P is still this runner's group,
so the reaper and the daemon can signal `-P` without a member list.

## R3. The retirement record is written before the first signal

- Before any signal to a runner (Stop's TERM and KILL, retirement, watcher retries,
  restart recovery), the daemon commits the retirement record: leader identity, reaper
  identity if any, the group snapshot, `owned_run_ids` and `retired_at`. A crash after
  that commit leaves a record that restart recovery finds.
- Membership and signals are separate facts. The snapshot answers "which processes are
  this runner's"; the signal log answers "what was sent to whom, and was it delivered".
  A refused or failed signal adds to the log and never removes a member.
- While P is pinned (verified leader or verified reaper alive in P), each pass adds
  P's current members to the snapshot and commits it before signalling. Once neither is
  alive, the snapshot is final.

## R4. One kill routine

- Stop escalation, the watcher (A3, including its 60 s cadence after the third failed
  kill) and restart recovery all call one routine. It takes the retirement record and
  returns the record to commit, then the signals to send.
- A member counts as gone when its pid is gone, a zombie, or has a different start time.
  The runner is gone when every member in the snapshot is gone; the reaper is one of
  them, so a live reaper keeps the record open.
- Unverifiable processes are never signalled (A12). A15's prune rule and A12's notice
  texts are unchanged.

## R5. Main-built runners

A runner whose hello has no reaper gets the same write-ahead record and kill routine,
with P pinned only by the verified leader. Selected by the hello capability alone; deleted
with the other legacy paths (32.13).

## Failure modes this must handle

1. Daemon killed at any point: runner, reaper and Claude sessions keep running; the next
   daemon reconnects and the session continues.
2. Leader ignores TERM; a descendant ignores TERM.
3. Leader exits before escalation while a descendant ignores TERM.
4. TERM refused; first KILL refused; signalling later works.
5. Daemon crash between the record's commit and TERM, during the grace, and after KILL.
6. Reaper killed first (by a user or the OS), then the leader stops.
7. Leader crashes on its own with no Stop: the reaper clears the group; the daemon later
   finds every member gone and prunes per A15.
8. A pid in the snapshot is reused by an unrelated process: never signalled.
9. A malformed record: rejected per row and logged; other rows recover.
10. A child forked after the last refresh, after the reaper and leader are gone: the
    inherited limit (A12), not fixed here.
11. A descendant that leaves group P (`setsid`, `setpgid`): outside the group, so neither
    the reaper nor the snapshot reaches it. Unchanged from main; not fixed here.

## Tests

End to end with real processes, each writing a JSON artifact:

- daemon SIGKILL mid-turn, a new daemon starts: the turn continues on the same runner and
  native session, with reaper and Claude CLI alive throughout (R1);
- cases 2, 3, 6 and 7 with a TERM-ignoring descendant: no member of the group survives;
- case 5 at each crash point: restart recovery kills the recorded members.

Through the manager's interface with an injected process table: cases 4, 8 and 9, and a
main-built runner (R5).

## Prior art

Evidence: `~/src/personal/conduit-competitors`.

| competitor | revision | how it stops a process tree |
|---|---|---|
| paseo | d0fd2e532 | `tree-kill` walks the tree at kill time (`packages/server/src/utils/tree-kill.ts`); nothing persisted, children lost if the daemon dies |
| paperclip | 98337f5b | persists a process-group id and signals `-pgid` (`server/src/services/local-service-supervisor.ts:262`); no identity check; escalation ends on the leader's exit |
| diri | e280a76d | a per-session guard (`run_process_guard`, `diri/crates/diri-remote/src/holder.rs:284`) waits for EOF on a pipe only the Holder holds, then kills the Agent's process group; the guard runs in its own session (`setsid`, :325) so a Holder group kill cannot remove it; the group kill is unchecked |

Conduit takes diri's guard (a tiny process woken by the kernel closing a pipe, so it works
even when the leader is SIGKILLed) and paperclip's persisted group, and keeps its own rule
that nothing unverifiable is signalled. It differs on purpose in two ways. The reaper lives
inside the runner's group, not its own session: that pins the group id, so the reaper's and
the daemon's group signals can never reach a reused group, which diri's unchecked kill can.
The cost is that a group KILL also ends the reaper, which is harmless because that KILL
already reaches every member. And the record is written before any signal, which no
competitor does.

## Decisions

Q28 = A + C, with R1 as the user's constraint: the daemon dying must not kill Claude
sessions that should keep running and that the daemon reconnects to on startup.

Q29 = A: approved as written (reaper inside the runner's group, in `/bin/sh`).
