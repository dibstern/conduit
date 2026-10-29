# Subagent session viewing

When a turn delegates work to a subagent, the finished turn collapses into a "Worked … · N subagent" head. Expanding it shows the subagent's row with a link that opens the subagent's own session. That view has a "Subagent of <parent>" back bar with **← Parent** and Esc, and shows the subagent's output. Codex and Cursor subagent sessions are read-only.

## Sub-features

- `subagent-head` shows the collapsed "Worked … · 1 subagent" head after the turn.
- `subagent-open` expands the head and opens the child through `.subagent-link`.
- `subagent-view` shows the back bar, the child's reply, and the read-only notice for Codex and Cursor.
- `subagent-back` returns to the parent with **← Parent** or Esc.
- `subagent-running` opens a child while it is still working.
- `subagent-transcript` shows the child's own tool calls (Claude, from transcript reads).
- `subagent-claude`, `subagent-codex`, `subagent-cursor` are the same journey per harness. `subagent-opencode` has no recording (see Gotchas).

## How to get to it (user POV)

- Send a prompt whose turn delegates to a subagent. With replay, the recording decides that, not the prompt.
- After the turn, click the **Worked … subagent** head, then the subagent row's link (`.subagent-link`).
- In the child, use **← Parent** in `.subagent-back-bar`, or press Esc.

## Driving it with playwright-cli

One launch serves all three harnesses:

```bash
D="test-results/verify-conduit/$RUN_ID/subagents"
mkdir -p "$D"
$V up --claude-turns subagent-task-turn --codex-turn subagent-spawn --cursor-trace subagent-foreground-default-fixed
$V new-session
$V send 'Ask a subagent to summarise package.json' --harness claude --model opus --provider claude
$V screenshot --file "$D/01-parent.png"
$V click 'role=button[name=/^Worked .*subagent/]'
$V click '.subagent-link'
$V screenshot --file "$D/02-child.png"
$V snapshot --file "$D/02-child.aria.yml"
$V press Escape
$V store sql "select id, model_provider, parent_id, title from sessions where parent_id is not null" > "$D/03-children.json"
```

Repeat from `new-session` with `--harness codex --model gpt-6.1-sol --provider codex` and `--harness cursor --model composer-2.5 --provider cursor`.

Running child. Hold the replay while the subagent works, open it, then release:

```bash
D="test-results/verify-conduit/$RUN_ID/subagents"
mkdir -p "$D"
$V up --claude-turns subagent-task-turn --codex-turn subagent-stop
$V hold --claude 1:35
$V new-session
$V send 'Ask a subagent to summarise package.json' --harness claude --model opus --provider claude --no-wait
$V click '.subagent-link'          # the arrow on the Delegating row
$V screenshot --file "$D/04-claude-child-running.png"
$V release
$V hold --codex 102
$V new-session
$V send 'Spawn a child' --harness codex --model gpt-6.1-sol --provider codex --no-wait
$V click '.subagent-link'
$V screenshot --file "$D/05-codex-child-running.png"
$V press Escape
$V click '#stop'                   # optional: stop the parent while the child runs
$V release
$V wait-settle
```

Child transcript (Claude). Use a trace that has a `.subagent-reads.json`:

```bash
D="test-results/verify-conduit/$RUN_ID/subagents"
mkdir -p "$D"
$V up --claude-turns foreground-agent-backgrounded-turn   # or concurrent-background-work-turn
$V new-session
$V send 'Delegate to an agent' --harness claude --model opus --provider claude
$V click 'role=button[name=/^Worked .*subagent/]'
$V click '.subagent-link'
$V click 'role=button[name=/^Worked 115ms/]'               # the child's own Worked head
$V screenshot --file "$D/06-child-transcript.png"
```

Check these results:

- The parent reply is Claude `The subagent reports the name field is conduit-replay-fixture.`, Codex `Hello from the mock model.`, and Cursor `done`. The head reads `Worked <duration> · 1 subagent`.
- After the link, the path is the child's `/s/<harness>-subagent-<id>`, and the back bar reads `Subagent of Process harness session Idle ← Parent Esc`.
- Child replies: Claude `conduit-replay-fixture`, Codex `Child inspected the patch.`, and Cursor `All six steps are done: …`.
- Codex and Cursor children have no `#input`. Cursor shows `Subagent sessions are read-only.` (`[data-testid=subagent-readonly-notice]`). Claude children keep the composer.
- Esc or **← Parent** returns to the parent's path.
- Running Claude child: the parent shows `Working · 1 subagent` and a `Delegating Read package.json name field` row. The child view shows `Working` and the back bar reads `Subagent of Process harness session Working`.
- Running Codex child: the child `Inspect the patch` shows `Thought I will inspect the patch.` and `Running printf child`. After Stop and release, `wait-settle` returns `turnStatus:"interrupted"`, and the parent and child turns are both `interrupted`.
- Child transcript: `foreground-agent-backgrounded-turn` opens the child in the background-tasks panel. Its Worked head expands to the recorded steps: `Ran sleep 25; echo f-done`, `ToolSearch`, `Monitor`, `F done.`.
- The store has one child per harness, with `parent_id` set and titles `Read package.json name field` (Claude), `Inspect the patch` (Codex) and `Spike workflow steps` (Cursor).

## Gotchas

- The Worked head is found by accessible name. `click` takes Playwright selectors, so `role=button[name=/^Worked .*subagent/]` works.
- The Claude child's stored turn stays `pending`, with no `run_id`, although the UI shows Idle. This is a real conduit bug, not replay: the live store shows the same since 2026-10-21 (bead `conduit-test-ev71p`). Until it is fixed, `wait-settle` times out in a Claude child, so skip it there.
- Only traces with a `.subagent-reads.json` show the child's tool calls. `subagent-task-turn` has none, so its child shows only the final reply.
- A Claude hold applies to every Claude session, so `hold --claude 1:35` also stops any other Claude session at its first prompt.
- `hold --codex` also stalls Codex usage polls until release.
- OpenCode has no subagent recording. `test/e2e/fixtures/subagent-snapshot.json` is a mocked-WebSocket snapshot, not a recording the launcher can load.
