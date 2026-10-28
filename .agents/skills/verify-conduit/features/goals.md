# Goals

A user sets a goal (a condition the agent works toward) with **Attach → Set goal** or by typing `$goal <condition>`. Conduit keeps the turn going, checks the condition after each step, and ends the goal as met, paused or cleared. The session bar shows the goal's state, and its details sheet has Pause, Edit and Clear. Only Claude and Codex support goals.

## Sub-features

- `goal-set` sets a goal from the Attach menu. The composer shows the goal hint and a **Set goal** button.
- `goal-met` chains steps until the condition holds, then shows "Goal met".
- `goal-details` opens the details sheet from the session bar subtitle.
- `goal-clear` clears a running goal with **Clear goal**, which offers Undo.
- `goal-pause-button` pauses with **Pause**, which stops the turn.
- `goal-pause-typed` pauses by steering `/goal pause` with Cmd+Enter.
- `goal-unsupported` disables Set goal for Cursor and OpenCode.

## How to get to it (user POV)

- **Attach** (`[aria-label=Attach]`) → **Set goal** (`attach-set-goal`). This prefills `$goal ` in the composer. Type the condition after it, then click **Set goal** (`#send`).
- While the goal runs, click the session bar subtitle (`session-goal-subtitle`) for the details sheet (`goal-details`): `goal-details-pause`, `goal-details-edit`, `goal-details-clear`.
- To pause by typing, enter `/goal pause` and press Cmd+Enter (steer).

## Driving it with playwright-cli

```bash
D="test-results/verify-conduit/$RUN_ID/goals"
mkdir -p "$D"
$V up --codex-turn goal-chain      # or goal-cleared, goal-stop, goal-paused
$V new-session
$V pick-model --harness codex --model gpt-6.1-sol --provider codex
$V click '[aria-label=Attach]'
$V click '[data-testid=attach-set-goal]'
$V click '#input'
$V type 'Say hello'                # appends to the $goal prefix; fill would erase it
$V screenshot --file "$D/01-composer.png"
$V click '#send'
$V wait-settle --timeout 60000     # goal-chain only; the other traces hold the turn open
```

For the held traces, act while the turn runs, then `wait-settle`:

```bash
# goal-cleared
$V click '[data-testid=session-goal-subtitle]'
$V click '[data-testid=goal-details-clear]'
# goal-stop
$V click '[data-testid=session-goal-subtitle]'
$V click '[data-testid=goal-details-pause]'
# goal-paused
$V click '#input'; $V type '/goal pause'; $V press Meta+Enter
```

Then capture state:

```bash
D="test-results/verify-conduit/$RUN_ID/goals"
mkdir -p "$D"
$V screenshot --file "$D/02-after.png"
$V store sql "select goal_state from sessions" > "$D/03-goal-state.json"
$V store sql "select condition, iterations, turn_index from session_goal_checks" > "$D/04-checks.json"
```

Check these results:

- Before sending, `#input` holds `$goal Say hello`, `#send` reads `Set goal`, and `composer-goal-hint` is shown. The stored user message is `/goal Say hello`.
- `goal-chain`: the reply is `Hello from the mock model.` three times in one turn, `completed`. `composer-goal-met` reads `Goal met · Say hello … 1 turns · 3 checks`. `goal_state` has `ended:"met"`, `endedGoal.iterations:3`, and `session_goal_checks` has iterations 1, 2 and 3 on turn 1.
- While a held goal runs: `#stop` is visible, the subtitle reads `Pursuing · Say hello`, and `session-goal-notice` reads `Goal set · Say hello`.
- `goal-cleared` with **Clear goal**: the turn completes, a `/goal clear` user message is stored, `composer-goal-cleared` reads `Goal cleared Undo`, and `goal_state` has `ended:"cleared"`.
- `goal-stop` with **Pause**: `wait-settle` returns `turnStatus:"interrupted"`, the subtitle reads `Paused · Say hello`, and `goal_state` keeps the goal with `pausedReason:"Interrupted"`.
- `goal-paused` with typed `/goal pause`: both turns complete, the subtitle reads `Paused · Say hello`, and `pausedReason` is `"Paused"`.
- Cursor (and OpenCode): `attach-set-goal` has `aria-disabled="true"`.

## Gotchas

- **Set goal prefills `$goal `.** `fill '#input' …` replaces it, so the send becomes a plain turn and the Codex replay fails with `Trace expected thread/goal/set; received turn/start`. Click the input and `type` instead, or fill `$goal <condition>` yourself.
- The condition must be `Say hello` for the Codex traces, which were recorded with it.
- Elapsed time reads about `152h 40m`, because `setAt` comes from the recording's timestamp. It is a replay artifact.
- Claude has one fixture, `--claude-turns goal-not-met-status-clear`. One prompt replays the whole trace: set, nine checks, status and clear. The goal ends `cleared` with nine checks, under the recording's own condition about `tick.txt`, not the typed one. Status and clear can't be driven step by step.
- **Resume** (`goal-details-resume`) sends `Continue.`, which no Codex trace answers. It is unverified.
- Restarting the daemon mid-goal needs rewritten traces (`test/integration/daemon/codex-goals.test.ts:269`). It is not covered.

## Copy issues seen (not fixed)

- `composer-goal-hint` says `Claude keeps working until this is true` in a Codex session (`src/lib/frontend/components/input/InputArea.svelte:1291`).
- The disabled menu item says `Claude only`, but Codex supports goals too (`src/lib/frontend/components/input/AttachMenu.svelte:91`).
- `composer-goal-met` says `1 turns`.
