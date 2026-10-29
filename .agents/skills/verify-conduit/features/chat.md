# Chat: create a session and send

A user opens a draft, picks a harness and model, sends a prompt, and sees the session appear with the provider's reply. Nothing is stored until the first send. Every harness (Claude, OpenCode, Codex, Cursor) goes through the same composer.

## Sub-features

- `chat-draft` opens a draft prefilled with a project.
- `chat-model` picks the harness and model in the composer.
- `chat-send` sends the first prompt, which creates the session and navigates to `/s/<id>`.
- `chat-reply` renders the assistant reply and stores both messages.
- `chat-claude`, `chat-opencode`, `chat-codex`, `chat-cursor` are the same journey per harness.

## How to get to it (user POV)

- Load the app root. With no session open, the main pane is already a draft ("What should happen in process-test?").
- From a session, choose back (`[data-testid=session-bar-back]`), then `New session` (`#new-session-btn`).
- Type into the composer of an existing session to continue it.

## Driving it with playwright-cli

Preconditions:

- Baseline from the README, with a draft open. The draft's project chip reads `process-test`.

Use the control CLI on the launcher-owned page. For one Claude send:

```bash
D="test-results/verify-conduit/$RUN_ID/chat"
mkdir -p "$D"
mkdir -p "$D/chat-claude"
$V new-session
$V fill '#input' 'Say hello'
$V pick-model --harness claude --model opus --provider claude
$V screenshot --file "$D/chat-claude/01-draft-ready.png"
$V snapshot --file "$D/chat-claude/01-draft-ready.aria.yml"
$V send 'Say hello'
$V screenshot --file "$D/chat-claude/02-reply.png"
$V snapshot --file "$D/chat-claude/02-reply.aria.yml"
$V store sessions > "$D/chat-claude/03-sessions.json"
```

Repeat from `new-session` with each row's harness, model and provider. `send` can also pick the model in one command: `$V send 'Say hello' --harness codex --model gpt-6.1-sol --provider codex`.

| harness | model | provider | picker state | reply |
|---|---|---|---|---|
| `claude` | `opus` | `claude` | `claude claude opus false` | `pong` |
| `opencode` | `claude-opus-4-6` | `anthropic` | `opencode anthropic claude-opus-4-6 false` | `pong` |
| `codex` | `gpt-6.1-sol` | `codex` | `codex-2 codex gpt-6.1-sol false` | `Hello from the mock model.` |
| `cursor` | `composer-2.5` | `cursor` | `cursor-replay cursor composer-2.5 false` | `Hi David — good to meet you. What would you like to work on today?` |

Check these results:

- After `fill`, the path is `/draft/<uuid>?project=process-test`.
- `pick-model` returns `{instanceId, shownProvider, shownModel, sendDisabled}`. These values match the picker-state table in that order, with `sendDisabled:false`.
- `send` returns `{path, sessionId, reply, turnStatus, ms}`. The path is `/s/<sessionId>` and the reply matches the table. `reply` is `null` when the turn produced no new assistant text, such as a failed turn; check `turnStatus`. It waits for the stored turn and composer to finish and for the DOM to become quiet. Use `--no-wait` and a later `wait-settle` when verifying an in-progress turn.
- `store sessions` includes the matching `model_provider` and `model_id`. Use the returned `sessionId` with `$V store messages --session <id>` and save the JSON too. Each send stores a user message and an assistant reply.

## Gotchas

- Replies are replayed, not generated. Only request shape is matched, never prompt text, so any prompt gets the reply in the table.
- `sessions.provider` holds the account id (`claude`, `opencode`, `codex-2`, `cursor-replay`). The harness is in `model_provider`, except OpenCode, where it is the upstream provider (`anthropic`). Filter on `model_provider`.
- Titles: OpenCode's is always `Greeting`; the others are always `Process harness session`.
- How many prompts each harness replays:
  - **Claude** replays `CLAUDE_TURNS` (three by default) from the top in every new session: the Nth prompt in a session gets the Nth trace, and a prompt past the end fails its turn. A new draft works again.
  - **Codex** replays `CODEX_TURN` (`two-turns` by default) from the top in every new session: two prompts per session, and the third fails with `Trace expected thread/start; received thread/resume`. A new draft works again.
  - **Cursor** repeats its last recorded turn forever.
  - **OpenCode** answers every prompt with `pong`.
- OpenCode stores the recording's prompt (`Hello, reply with just the word pong`), not the text you typed, and its session id is always `ses_2d28b1bd2ffeSjhBHLSlb2SRue`. The other harnesses store your text and mint fresh ids.
- The seeded `New session - 2026-03-27…` OpenCode row comes from the recording and has no messages. Do not count it as created by your send.
- OpenCode's turn footer shows an absurd duration such as `309270m 25s` because the recording's timestamps are from March 2026. Not a bug.
- Quote model ids in selectors (`[data-model-id='gpt-6.1-sol']`). Unquoted dots make the CSS invalid.
- The Cursor harness only appears in the picker once a Cursor account exists. `SEED_ACCOUNTS=0` leaves it out.
- `.md-content` also matches the user's own message. `send` selects the last assistant message; use its `reply` rather than reading the last unqualified `.md-content`.
- The `?feats=debug` WS panel covers `#send` at 1440x900 and swallows the click. Use `$V ws-log` instead.
- `$V info` prints a `playwrightAttach` command for tools such as `requests`, `video-start` and `run-code`. Attach to the launcher's page. Late attachment only sees new requests; `requests` shows HTTP, while `$V ws-log` shows WebSocket traffic.
- `store`, `logs --level` and `eval` observe or debug the result. They are not a way to reach the user-visible end state.
- Replay does not verify real logins, real model output, or real provider CLIs and binaries.
