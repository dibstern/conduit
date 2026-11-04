# ADR-0015: Only Conduit restores files, a whole folder at a time, and refuses when another session ran there

- Status: accepted
- Date: 2026-11-01
- Context: conduit-test-82tn.43 (spike, no-go), conduit-test-82tn.44,
  conduit-test-82tn.53; replaces the file rewind decision in conduit-test-3c7y

## Context

A Head Move ([ADR-0014](0014-history-is-a-graph-and-every-head-move-is-undoable.md))
can move a session's files as well as its conversation. Sessions often share a
folder, and Local mode is the default, so a restore can destroy another
session's or the user's work.

conduit-test-3c7y chose "revert, don't restore": take a Folder Snapshot around
every write-capable tool call, attribute each changed path to one tool call,
and revert only the moving session's own changes. That needs Claude
PreToolUse and PostToolUse hooks, a per-adapter write classifier and per-tool
snapshots. 3c7y rejected t3code's whole-folder restore because it refuses in
shared folders.

Spike conduit-test-82tn.43 measured whether per-tool attribution is accurate
enough. A scripted two-session harness (seed 4343, 8 scenarios, 30 runs each
with fresh captures and 10 with joined captures) compared each planned row
with ground truth. The artifact is `scripts/spikes/82tn43/results.json` on
branch wt/82tn43 (b1f5fa07). Any wrong revert of the user's or another
session's change was a no-go unless fixed by design.

- **Edit and Write.** Concurrent edits to different files, or to one file,
  gave 0 ambiguous rows and 0 wrong reverts with strict pre-image chaining.
  Run-level attribution was 100% ambiguous.
- **A user save while a shell command runs** was wrongly reverted in 30 of 30
  runs under every per-tool variant. Nothing tells a user save from a shell
  write in the same interval, so no rule fixes it.
- **Overlapping shells** from two sessions were 78% ambiguous with fresh
  captures and 96% with joined captures.
- **A background shell** reverted the other session's work in 21 of 30 runs
  under strict rules. Holding its interval open until the process exits gave 0
  wrong reverts but 60% ambiguous rows.
- **Joined captures**, where a request reuses an in-flight snapshot, caused
  wrong reverts (2 of 10 runs, strict), so every per-tool snapshot would need a
  fresh capture.
- **Cost.** A pre- and post-tool capture around one write took p50 143 ms and
  p95 164 ms on a 7,000-file fixture, and 169 ms and 185 ms on the Conduit
  repository, on a loaded machine (load average about 10). The 3c7y budget was
  150 ms p95 per write tool.

## Decision

**Only Conduit restores files.** Provider file restore stays off: Claude file
checkpointing, OpenCode snapshots and OpenCode revert (conduit-test-82tn.55).

**A restore puts back a whole folder from a run-level Folder Snapshot.** The
Folder Timeline takes a Folder Snapshot of each folder at Run start and Run
end (conduit-test-f02e9.8). A Head Move with files restores every folder the
session ran in to its snapshot at the target History Node, whole. There are no
tool hooks, no write classifier and no per-tool snapshots. Change Units stay
run-level and feed turn diffs. Tool calls carry no writes field.

**A restore is refused when the folder is shared**, following t3code's
`CheckpointRestoreSafety.ts:10`: another session ran in the folder after the
target snapshot, or has a Run open there now. The refusal is typed and names
that session. Sessions that never ran there do not count. The user can then
move the conversation only, or branch into a worktree whose files match the target (conduit-test-82tn.54). No ambiguity
threshold exists because nothing is attributed.

**The Restore Plan lists the paths that change**, per folder, before anything
is written. It has no ambiguous, conflict, merged or user-change rows.

**Apply is crash-safe and undoable.** It writes conditionally under an apply
lock, snapshots each folder first and records a Restore Receipt. Startup
finishes or rolls back an interrupted apply. Undo puts the files back as the
move found them. Conduit never writes the user's repository index, refs or
HEAD.

## Consequences

- In a folder shared by active sessions, a rewind with files is often refused.
  Conversation-only rewind always works, and a branch into a worktree gives the
  target files without touching the shared folder.
- In a folder only this session ran in, a restore overwrites the user's own
  edits made after the target. The Restore Plan lists those paths before
  apply, and undo brings them back.
- Write tools pay no capture cost. Only Run start and Run end capture.
- conduit-test-82tn.46, .47 and .48 are closed, 82tn.53 is rescoped, and
  82tn.45 drops its writes field.

## Rejected alternatives

- **Per-tool attribution and revert (3c7y's choice).** The spike above: a user
  save during a shell was reverted in 30 of 30 runs, overlapping shells were
  78% to 96% ambiguous, and each write tool paid 164 ms to 185 ms p95.
- **No file rewind.** The conversation goes back and the files do not.
- **Provider-native restore.** Claude skips Bash edits, OpenCode restores its
  whole-folder snapshot without refusing and wipes other sessions' work, and
  Codex has no file restore.
- **A worktree or copy-on-write folder per session.** Kept for forks and
  branching into a worktree only: cloning a 2.2 GB node_modules took 30 s, and
  each session would need its own dev servers.
- **A file-watcher journal.** Its events carry no process, are coalesced and
  can be dropped.
- **Edit and Write pre-images only.** Exact, but it misses shell edits and
  needs the tool hooks this decision drops.
- **One writing session per folder.** It stops parallel sessions.
- **A per-folder queue for shell tools.** One agent blocks behind another's
  long test run.
- **An OS overlay, sandbox or syscall tracing.** It needs FUSE or entitlements
  on macOS, and SIP blocks library injection.
- **Moving a session into a worktree automatically on refusal.** Manual only:
  moving a live agent breaks the paths in its context and its running servers.
- **Jujutsu as the engine.** Kept as a model only: its operation log and undo
  shaped the Head Log and Restore Receipt, but it is the wrong dependency.
