# Steering

While a turn runs, a user can steer it: send a message that the agent reads mid-turn instead of after it. Cmd/Ctrl+Enter (or Cmd/Ctrl+click on `#send`) steers the composer text, and **Steer** on a queued row promotes it. The row shows `Steering` until the agent takes it, then the transcript marks the message `Steered`. Claude, Codex and Cursor can steer. OpenCode cannot, so the same keys queue.

## Sub-features

- `steer-keys` steers with Meta+Enter while `#stop` is visible.
- `steer-tray` promotes a queued row with `pending-input-steer`.
- `steer-landed` shows the user message with `user-message-steered` (`Steered`) in the same turn.
- `steer-pending-stop` stops while a steer is still pending (see [stopping.md](./stopping.md)).
- `steer-unsupported` (OpenCode): no steer hint, no Steer button, Meta+Enter queues.
- `steer-refused` shows `composer-steer-refused` ("Not steered. <reason>"). Not reached here, see Gotchas.

## How to get to it (user POV)

- While a reply runs, type a message and press Cmd/Ctrl+Enter, or Cmd/Ctrl+click **Queue message**. The send button's tooltip reads `Queue message · ⌘/Ctrl+Enter or ⌘/Ctrl+click to steer`.
- Or queue it with Enter, then click **Steer** on its row.

## Driving it with playwright-cli

Claude, steering during a tool call:

```bash
D="test-results/verify-conduit/$RUN_ID/steering"
mkdir -p "$D"
$V up --claude-turns steer-during-tool-folds --claude-delay-ms 100
$V new-session
$V send Alpha --harness claude --model opus --provider claude --no-wait
# about 2.5 s later the tool shows
$V fill '#input' Bravo
$V press Meta+Enter
$V screenshot --file "$D/02-steering.png"
$V wait-settle --timeout 60000
$V screenshot --file "$D/03-steered.png"
$V store sql "select role, text, steered from messages order by created_at" > "$D/04-messages.json"
$V store sql "select json_extract(data,'$.delivery') d from events where type='input.admitted'" > "$D/04-admitted.json"
```

Claude, tray Steer: `--claude-turns queued-input-promoted-to-steer`. Queue Bravo with Enter, then `$V click '[data-testid=pending-input-steer]'`.

Codex holds at the trace's `turn/steer`, so no delay is needed:

```bash
$V up --codex-turn steer
$V send 'Say hello' --harness codex --model gpt-6.1-sol --provider codex --no-wait
$V fill '#input' 'Use the steered instruction'
$V press Meta+Enter
$V wait-settle
```

Cursor holds in the trace's custom tool until a steer arrives:

```bash
$V up --cursor-trace steer
$V send 'Call the human custom tool once, then say done.' --harness cursor --model composer-2.5 --provider cursor --no-wait
$V fill '#input' 'After the tool, say STEER_SEEN_7931.'
$V press Meta+Enter
$V wait-settle
```

OpenCode refuses to steer. The recording holds the second prompt in a running bash call:

```bash
D="test-results/verify-conduit/$RUN_ID/steering"
mkdir -p "$D"
$V up --opencode-recording side-thread-mid-turn
$V send "Remember the word 'alpha'. Reply with only: ok, remembered." --harness opencode --model big-pickle --provider opencode
$V send 'Use the bash tool to run: sleep 10; printf mid-turn-marker. Then reply with only its output.' --no-wait
$V fill '#input' Charlie
$V press Meta+Enter
$V snapshot --file "$D/01-queued.aria.yml"
```

Check these results:

- Claude Meta+Enter: `#input` clears and the row reads `Steering Bravo`. The turn completes with user messages `Alpha` and `Steered Bravo`, and the reply `The command finished and printed A-DONE. BANANA`. The store has Bravo `steered=1`, two `completed` turns but one `turn.completed` event, and `input.admitted` deliveries `queue` then `steer`.
- Claude tray Steer: the row goes from `Queued Bravo <time> Steer Run now` to `Steering Bravo`, the reply ends `BANANA`, and Bravo is `steered=1`.
- Codex: user messages `Say hello` and `Steered Use the steered instruction`, reply `Hello from the mock model.`, `steered=1`. `codex-wire.jsonl` has one `turn/steer` carrying `expectedTurnId` and `clientUserMessageId`.
- Cursor: user messages `Call the human custom tool once, then say done.` and `After the tool, say STEER_SEEN_7931.` (`steered=1`), reply `STEER_SEEN_7931`, both turns `completed`, deliveries `queue` then `steer`. `cursor-capture.jsonl` has `steer.call` with the text and `steer.ack` `complete_delivered`.
- OpenCode: `#send` reads `Queue message` with title `Queue message` (no steer hint). Meta+Enter gives `Queued Charlie <time> Run now`, with no `pending-input-steer`.

Evidence from 2026-10-28: `test-results/verify-conduit/b-steer/evidence/` (Claude keys), `b-steer2/evidence/01-*`, `02-*` (Claude tray), `b-codex/evidence/` (Codex), `b-cursor/evidence/01-*` to `04-*` (Cursor), `b-oc/evidence/01-queued.*` (OpenCode).

## Gotchas

- The steer must land while the Claude turn is still in progress. Use `--claude-delay-ms 100` or more, and steer after the tool row shows. Tools fold into the activity row, so do not wait for a new `.tool-item`.
- Each new Claude session starts the `--claude-turns` list again. A trace with several recorded inputs answers several prompts in one session.
- The server's own `no_steering` refusal for OpenCode needs a raw `input.submit` RPC (`test/e2e/specs/opencode-steer.spec.ts`). The browser never sends one, so only the UI side is shown here.
- `composer-steer-refused` was not reached. Its reasons are a different model, agent or effort on the running turn, an open prompt, a slash command, or a provider that can't steer. No recording drives one without a hold control or a rewritten trace (Codex `steer-mismatch` needs the race set up in `test/integration/daemon/codex-control.test.ts`).
- `steer-misses-boundary` and `two-steers-one-boundary` (Claude) and `steer-shell` (Cursor) exist but were not run.
