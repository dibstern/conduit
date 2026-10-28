# Queued messages

While a turn runs, a user can keep typing. Enter adds the message to a queue above the composer instead of interrupting. Each queued row can be steered, run now, edited back into the composer or removed. When the turn ends, conduit sends the queue in order, one turn each.

## Sub-features

- `queue-add` queues with Enter (or `#send`, which reads `Queue message`) while `#stop` is visible.
- `queue-tray` shows `pending-input-tray` with one `pending-input-row` per message: `pending-input-state` (`Queued`), `pending-input-text` and the row actions.
- `queue-drain` sends the queue in order after the running turn ends.
- `queue-remove` drops a row with `pending-input-remove` ("Remove queued message").
- `queue-edit` moves a row's text back into `#input` with `pending-input-edit` ("Edit queued message"). Sending it queues it again at the end.
- `queue-run-now` stops the running turn and sends this row next with `pending-input-run-now`.
- `queue-image` shows `pending-input-images` ("1 image") on a row that carries a photo.
- `queue-claude`, `queue-codex`, `queue-cursor`, `queue-opencode` are the same journey per harness.

## How to get to it (user POV)

- Send a prompt. While the reply runs, type the next message and press Enter or click **Queue message**.
- The rows sit in the tray above the composer. Use the row's buttons to steer, run now, edit or remove it.

## Driving it with playwright-cli

Claude. The default trace is too fast to queue into, so slow it down:

```bash
D="test-results/verify-conduit/$RUN_ID/queued-messages"
mkdir -p "$D"
$V up --claude-turns pong-thinking-text-turn,pong-thinking-text-turn,pong-thinking-text-turn --claude-delay-ms 500
$V new-session
$V send Alpha --harness claude --model opus --provider claude --no-wait
$V fill '#input' Bravo;   $V press Enter
$V fill '#input' Charlie; $V press Enter
$V screenshot --file "$D/01-queued.png"
$V snapshot --file "$D/01-queued.aria.yml"
$V wait-settle --timeout 60000
$V store sql "select text, state from pending_inputs order by admitted_at" > "$D/02-pending.json"
$V store sql "select id, state from turns" > "$D/02-turns.json"
```

Remove and edit, in a fresh session with Alpha running and Bravo, Charlie, Delta queued:

```bash
id=$($V eval '() => [...document.querySelectorAll("[data-testid=pending-input-row]")].find(r => r.innerText.includes("Bravo")).dataset.inputId' | tr -d '"')
$V click "[data-input-id='$id'] [data-testid=pending-input-remove]"
# same lookup for Charlie, then:
$V click "[data-input-id='$id'] [data-testid=pending-input-edit]"
$V fill '#input' 'Charlie edited'; $V press Enter
```

Run now: with Alpha running and Bravo queued, click `pending-input-run-now` on Bravo's row, then `wait-settle`.

Codex uses `--codex-turn steer`, which holds the turn open, and `--harness codex --model gpt-6.1-sol --provider codex`. Cursor uses `--cursor-trace steer` with the prompt `Call the human custom tool once, then say done.` and `--harness cursor --model composer-2.5 --provider cursor`. OpenCode uses `--opencode-recording side-thread-mid-turn` (see [steering.md](./steering.md) for its two prompts).

Check these results:

- While Alpha runs, `#send` reads `Queue message` and `#stop` is visible.
- Claude rows read `Queued Bravo <time>` with Steer, Run now, Edit queued message and Remove queued message. OpenCode rows have no Steer: `Queued Charlie <time> Run now`.
- Claude drain: three `completed` turns, user messages Alpha, Bravo, Charlie, and Bravo's `input.sent` event comes after the first `turn.completed`.
- Remove and edit: the tray shows only `Delta`, `#input` holds `Charlie`, and `#stop` stays visible. After the requeue, user messages are Alpha, Delta, `Charlie edited`. The store has two `input.cancelled` events, and removed rows keep state `removed`.
- Codex: two rows queue, removing one adds one `input.cancelled`, and tray Steer delivers the other with `steered=1`.
- Cursor: two rows queue with Steer and Run now, and removing one leaves `Queued one`.
- An image row shows `pending-input-images` with `aria-label="1 image"`. After it drains, its stored message has a `text` part and a `file` part (`red8.png`).
- Run now (Claude): Bravo replies `pong`, but Alpha's turn ends `error` (see Gotchas).

Evidence from 2026-10-28: `test-results/verify-conduit/b-queue/evidence/` (Claude), `b-codex/evidence/04-*`, `05-*` (Codex), `b-cursor/evidence/05-queued.*` (Cursor), `b-oc/evidence/01-queued.*` (OpenCode).

## Gotchas

- `wait-settle` waits for the pending-input tray to empty or pause, then requires a 750 ms quiet window without turn or queue changes. One call covers the queue drain.
- Without `--claude-delay-ms`, the default Claude trace finishes before you can queue.
- **Run now on Claude ends the first turn `error` with `{"error":"cancelled","code":"cancelled"}`**, and the transcript shows a red `cancelled cancelled` banner. Plain Stop on the same harness ends `interrupted`, and `test/integration/relay/pending-input-run-now.test.ts:1240` expects `interrupted` for Claude. Likely a product bug, possibly a replay artifact (`b-queue/evidence/11-run-now-*`). Not fixed.
- Cursor: Stop with a queue under `--cursor-trace steer` lets the trace finish, so the queue drains instead of pausing (see [stopping.md](./stopping.md)).
- OpenCode: the stored user text is the recording's prompt, not what you typed. Type the recording's prompts exactly.
- `pending-input-send-now` shows only for usage-limit or scheduled queues. No recording reaches it here, so it is unverified.
- `InputArea.svelte` still holds `[DEBUG-st33r]` code that opens a `/__debug-st33r` WebSocket when a queued row has had no Steer button for 1.5 s. It fires on every OpenCode queue, since OpenCode never offers Steer. Committed as temporary in `39fc7d44`. Not fixed.
