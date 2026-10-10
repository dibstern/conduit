# OpenCode steering and the v2 engine (conduit-test-jyr9.11)

**Decision: OpenCode doesn't steer yet.** `OpenCodeProviderInstance.steering`
stays `false`. Steer is hidden on OpenCode sessions, and the server refuses a
steer with `no_steering`.

The checks:

- `test/e2e/specs/opencode-steer.spec.ts` (replay lane).
- `test/e2e/provider/opencode-steer-wire-capture.test.ts`: "shows the v2 engine
  can't stand in for the classic one" is the live lane, gated by
  `RUN_EXPENSIVE_E2E`. It writes `test-results/jyr9-11-opencode-v2-gaps.json`.

## Background

OpenCode 1.18.34 steers only through `POST /api/session/{id}/prompt` with
`delivery: "steer"`. That call runs on the v2 engine, which:

- emits only `session.next.*` events;
- has no `message.updated` or `message.part.*` events, and no
  `session.status` or `session.idle`;
- keeps its history at `/api/session/{id}/message`.

Conduit drives the classic engine:

- `prompt_async`;
- classic SSE;
- `/session/{id}/message`;
- `/session/status`.

## Evidence (real `opencode serve`, free `opencode/big-pickle`)

**What v2 does support:**

- Incremental streaming of text, reasoning and tool calls (`session.next.text.delta`, etc.).
- Session-level model and variant (`POST /api/session/{id}/model`).
- Agent switching.
- Data-URI image files.

**What v2 lacks that the classic path relies on:**

1. **Separate history (mixed mode fails).**
   - Run a classic turn ("remember PINEAPPLE"), then send a v2 prompt on the same session. The v2 answer was `NONE`.
   - The v2 history holds only the v2 turn.
   - The classic history still reads `user, assistant`.
   - Neither classic events nor classic status report the v2 turn.
2. **Ignores permissions.**
   - Config used: `"permission": {"bash": "ask"}`.
   - Classic: emits `permission.asked` before running bash.
   - v2: runs bash with no permission event, and `/api/permission` stays empty.
   - Conduit's per-session permission rules (`session.update`) are presumably bypassed the same way (not probed).
3. **No turn status.**
   - During a v2 turn, `/session/status` is `{}`; only `/api/session/active` shows `running`.
   - The status poller and the managed-instance idle reconcile both read `/session/status`. They would see an idle session mid-turn and could stop the instance.
   - Interrupt yields only `tool.failed` plus `step.ended` with `finish: "tool-calls"`. There is no turn-level end.
4. **No system prompt field.** Conduit sends extra-folder context as `system`.
5. **No v2 equivalents** of fork (Side Threads), share, diff or summarize.

## Options

| Option | Result |
| --- | --- |
| A. Mixed: classic turns, v2 only for steers | The steer has no context and is invisible to conduit's stream and history (1). |
| B. Move OpenCode to v2 | Regresses permissions, status/idle, extra folders, Side Threads and existing sessions' context (1-5). Also needs a new translator, history reader and completion detection. |
| C. Per-session engine choice | Option B's gaps for v2 sessions, plus two code paths. |
| D. Keep classic, no steering | No regression. Steer hidden, Queue works as today. |

**Choice: D.** Revisit when OpenCode's v2 engine can do all of the following:

- honour permissions;
- report turn status and idle;
- accept a system prompt;
- share history with classic sessions, or ship fork.

## Aside

`OpenCodeAPI.prompt` (`src/lib/instance/opencode-api.ts`) forwards only `text`,
`system`, `model` and `agent`. It drops the `images` and `variant` fields that
`PromptOptions` carries. This bug predates this work and is tracked as conduit-test-p2f2.
