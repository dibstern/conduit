# Stopping a turn

While a turn runs, the send button becomes **Stop** (`#stop`, title `Stop generating`). Clicking it interrupts the turn and returns the composer to **Send**. If messages are queued, conduit does not send them: the tray shows `Paused · you stopped the turn` with **Resume**. Run now and a pending steer interact with Stop too.

## Sub-features

- `stop-plain` interrupts a running turn. The turn ends `interrupted` and `#send` reads `Send` again.
- `stop-paused` stops with a queue. The tray shows `pending-input-paused` and keeps the rows.
- `stop-resume` sends the paused queue with `pending-input-resume`.
- `stop-steer-pending` stops while a steer is still pending. The steered turn ends `interrupted`, and a queued row stays paused.
- `stop-background-toast` shows "Turn stopped. N tasks still running" only when background tasks exist (see [background-tasks.md](./background-tasks.md)).
- `stop-claude`, `stop-codex`, `stop-cursor`, `stop-opencode` are the same journey per harness.

## How to get to it (user POV)

- Send a prompt and click **Stop** while it runs.
- With messages queued, Stop pauses the queue. Click **Resume** to send it.

## Driving it with playwright-cli

Claude, with a queue:

```bash
D="test-results/verify-conduit/$RUN_ID/stopping"
mkdir -p "$D"
$V up --claude-turns pong-thinking-text-turn,pong-thinking-text-turn,pong-thinking-text-turn --claude-delay-ms 500
$V new-session
$V send Alpha --harness claude --model opus --provider claude --no-wait
$V fill '#input' Bravo;   $V press Enter
$V fill '#input' Charlie; $V press Enter
$V eval '() => new Promise(r => setTimeout(r, 1600))'   # see Gotchas
$V click '#stop'
$V wait-settle
$V screenshot --file "$D/07-paused.png"
$V snapshot --file "$D/07-paused.aria.yml"
$V click '[data-testid=pending-input-resume]'
$V wait-settle --timeout 60000
$V store sql "select id, state from turns" > "$D/08-turns.json"
```

Claude, stop with a steer pending: `--claude-turns queued-input-promoted-to-steer,stop-with-steer-pending --claude-delay-ms 100`. In one session, finish the first trace (Alpha, then Bravo by tray Steer), then send Charlie, steer Delta with Meta+Enter, queue Echo with Enter, wait 1.6 s and click `#stop`.

Codex holds at the trace's `turn/interrupt`:

```bash
$V up --codex-turn stop-queued
$V send 'Say hello' --harness codex --model gpt-6.1-sol --provider codex --no-wait
$V fill '#input' 'Queued after stop'; $V press Enter
$V click '#stop'
$V wait-settle
```

Cursor uses `--cursor-trace steer` and the prompt `Call the human custom tool once, then say done.`. OpenCode uses `--opencode-recording side-thread-mid-turn` and its two prompts (see [steering.md](./steering.md)), then queue `Charlie` and click `#stop`.

Check these results:

- Claude plain Stop: `wait-settle` returns `turnStatus:"interrupted"`, `#send` reads `Send`, no toast shows, and the transcript has only `Alpha` with no reply.
- Claude with a queue: the tray reads `Paused · you stopped the turn Resume` with rows Bravo and Charlie, and `#stop` is gone. After Resume the tray holds Charlie, then empties. Turns are `interrupted`, `completed`, `completed`, and users Alpha, Bravo, Charlie, with two `pong` replies.
- Claude stop with a steer pending: the tray is paused with `[Echo]`. Users are Alpha, `Steered Bravo`, Charlie, Delta. Charlie's turn is `interrupted`, Delta's `completed` with `steered=0`, and Echo stays `queued`. The last reply reads `The command was cancelled, so it never ran ... BANANA`.
- Codex: `wait-settle` returns `turnStatus:"interrupted"`, the tray is paused with `[Queued after stop]`, and `codex-wire.jsonl` has `turn/interrupt` with `threadId` and `turnId`.
- Cursor: `cursor-capture.jsonl` has `cancel.call` with the run id about 3 s after the send. The turn still ends `completed` (see Gotchas).
- OpenCode: the tray is paused with `[Charlie]`, but the turn ends `error` with `stop_unconfirmed`, `Stop unconfirmed: OpenCode did not report a terminal event`, exactly 30 s after `interrupt.requested`. The sidebar row reads `Failed`.

Evidence from 2026-10-28: `test-results/verify-conduit/b-queue/evidence/06-*` to `10-*` (Claude), `b-steer2/evidence/03-*` to `05-*` (steer pending), `b-codex-stop/` (Codex), `b-cursor/evidence/06-stopped.png`, `07-cancel-capture.txt` (Cursor), `b-oc/evidence/02-*` to `04-*` (OpenCode).

## Gotchas

- **Stop is ignored for 1.5 s after a Send click on an idle composer.** This is on purpose, against double clicks. `send --no-wait` followed at once by `click '#stop'` does nothing, and the queue then drains. Wait 1.6 s first.
- `wait-settle` after the OpenCode Stop times out at 30 s, because the turn only ends when the stop confirmation gives up. Use `--timeout 40000`.
- Cursor Stop is not proven end to end. The launcher replays the trace's last turn for every prompt, and `steer`'s last turn finishes `STEER_SEEN_7931` whatever the cancel. So the turn completes and the queue drains instead of pausing. `cancel.jsonl`'s held cancel is not its last turn and needs a test-only wait delay.
- OpenCode's `stop_unconfirmed` is a replay limit: the mock answers `/abort` with `true` but sends no idle or abort event (`test/helpers/mock-opencode-server.ts:1256`). Real OpenCode Stop is unverified.
- Codex Resume was not tried: `stop-queued` has no second `turn/start` to answer it.
- Run now also stops the turn. On Claude it ends `error`, not `interrupted` (see [queued-messages.md](./queued-messages.md)).
- The background-task toast was not seen in these runs, which had no background tasks.
