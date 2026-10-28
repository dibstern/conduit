# Background tasks

A turn can start work that keeps running alongside it: a background shell command (Claude), or a subagent (Codex, Cursor). While it runs, the composer shows a chip named after the task and a "N background task(s)" toggle that opens a panel with one row per task and its elapsed time. **Stop** (`#stop`) interrupts the turn and its running children. The chip and toggle disappear when the task ends.

## Sub-features

- `bg-chip` shows `[data-testid=background-task-chip]` with the task's name while it runs.
- `bg-panel` opens the panel with `[data-testid=background-tasks-toggle]`. Rows (`background-task`) read `<name> shell · <command> <N>s` and count up.
- `bg-done` removes the chip, the toggle and `#stop` when the task ends.
- `bg-stop` interrupts the parent and a running subagent with `#stop`.
- `bg-stop-one` stops one task from its row in the panel.
- `bg-claude` (shell task), `bg-codex` (running subagent, then Stop), `bg-cursor` (background subagent). `bg-opencode` has no recording.

## How to get to it (user POV)

- Send a prompt that starts background work. With replay, the recording decides that.
- While it runs, the chip and toggle sit above the composer. Click the toggle for the panel.
- Click **Stop** to interrupt the turn.

## Driving it with playwright-cli

Claude shell task. The replay is too fast to see the chip without `--claude-delay-ms`: the task shows only between roughly message 56 and 85 of the trace, so a 300 ms delay gives about 9 s.

```bash
D="test-results/verify-conduit/$RUN_ID/background-tasks"
mkdir -p "$D"
$V up --claude-turns background-shell-turn --claude-delay-ms 300
$V send 'Run sleep in the background' --harness claude --model opus --provider claude --no-wait
# poll until the chip shows (about 15 s in)
$V eval '() => document.querySelector("[data-testid=background-task-chip]")?.textContent.trim()'
$V screenshot --file "$D/01-chip.png"
$V click '[data-testid=background-tasks-toggle]'
$V screenshot --file "$D/02-panel.png"
$V snapshot --file "$D/02-panel.aria.yml"
$V wait-settle --timeout 60000
```

Codex running subagent, then Stop:

```bash
D="test-results/verify-conduit/$RUN_ID/background-tasks"
mkdir -p "$D"
$V up --codex-turn subagent-stop
$V send 'Spawn a subagent' --harness codex --model gpt-6.1-sol --provider codex --no-wait
# poll until a "Running 1" button shows
$V screenshot --file "$D/03-codex-running.png"
$V click '#stop'
$V wait-settle
$V store sql "select session_id, state from turns" > "$D/04-codex-turns.json"
```

Holding instead of slowing down. `hold --claude 1:85` stops the replay after the reply `started` and before the task ends, so the chip stays as long as you need:

```bash
D="test-results/verify-conduit/$RUN_ID/background-tasks"
mkdir -p "$D"
$V up --claude-turns background-shell-turn
$V hold --claude 1:85
$V send 'Run sleep in the background' --harness claude --model opus --provider claude --no-wait
$V click '[data-testid=background-tasks-toggle]'
$V click '[aria-label="Stop background task sleep 8"]'   # per-task Stop, see Gotchas
$V screenshot --file "$D/05-stop-one.png"
$V release
$V wait-settle
```

Cursor uses `--cursor-trace subagent-background-follow-up` and the same send with `--harness cursor --model composer-2.5 --provider cursor`.

Check these results:

- Claude: the chip reads `sleep 8`, the toggle `1 background task`, and the panel row `sleep 8 shell · sleep 8 0s` counts up. `#stop` is visible meanwhile. The reply is `started`, then the chip, toggle and `#stop` disappear.
- Codex: the turn shows `Running 1` and `Working <N>s · 1 subagent`. After `#stop`, `wait-settle` returns `turnStatus:"interrupted"`, and the store has both the parent turn and the `codex-subagent-…` child turn `interrupted`.
- Cursor: `Running 1` shows for a moment, then the head reads `Worked <duration> · 1 subagent` and the reply is `done`. Parent and child sessions end `idle`.

## Gotchas

- Without `--claude-delay-ms` or a hold, the Claude task starts and ends inside one poll, so the chip is never seen. `wait-settle` passing proves nothing about the chip.
- Per-task Stop reaches the provider but cannot succeed under replay. The click shows the toast `Failed to stop background task … Claude trace replay: Query.stopTask is not replayed`. No recording captures a per-task stop, and only Claude implements it. The task then ends on its own after `release`.
- Cursor shows no background-task chip. Its background subagent finishes within a second under replay, so only the `Running 1` head is briefly seen. `CONDUIT_TEST_CURSOR_WAIT_DELAY_MS` did not stretch it.
- `foreground-agent-backgrounded-turn` and `concurrent-background-work-turn` (Claude) load subagent transcript reads. See [subagents](./subagents.md) for the child view.
- OpenCode has no background-task recording.
