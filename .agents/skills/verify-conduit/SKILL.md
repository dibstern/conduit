---
name: verify-conduit
description: Verify, demo or screenshot conduit's browser UI through an isolated server and launcher-owned browser. Use the conduit-verify control CLI with replayed providers, screenshots, ARIA snapshots and event-store evidence, without touching the user's live server on :2633.
---

# Verify conduit

This skill starts a private `conduit serve` instance through `ProcessHarness` and drives its browser through `conduit-verify`. The launcher owns Chromium and its browser context for the whole run. Browser commands use the launcher's Unix socket; `features check` runs statically. Each invocation prints JSON. Evidence stays under `test-results/verify-conduit/<RUN_ID>/`.

Never drive `http://localhost:2633`. That is the user's live daemon holding their real sessions. Every instance here gets a fresh `/tmp/conduit-verify-*` root, its own HOME, config dir, event store and a free port, so several runs can go side by side with different `RUN_ID`s.

All commands run from the repo root. Each agent shell call may start a fresh shell, so set `V` at the start of every call, and also export the same unique `RUN_ID` or pass `--run <id>` to each command. Without them `$V` is empty and `RUN_ID` silently falls back to `default`, which parallel runs would share. Pick a unique id per run:

```bash
V=.agents/skills/verify-conduit/scripts/conduit-verify.mjs
export RUN_ID=<id>    # or pass --run <id> to any command; default is default
```

Output is one compact JSON value per command. Use `--pretty` for reading, `--help` for command arguments and output shapes, and group help such as `$V store --help`. Exit codes are 0 for success, 1 for failure and 2 for usage errors. Failures include an error and a hint for the next action.

## Launch

```bash
pnpm install          # once per worktree; fresh worktrees have no node_modules
pnpm build            # dist/ must match the code under test; rebuild after every change
$V up
```

`up` runs `scripts/launch.ts` detached and waits up to 120 seconds for readiness. The harness bootstraps an empty config, runs migrations and registers project `process-test`. The launcher then opens Chromium at the private URL and exposes `control.sock` and a CDP endpoint. `up` returns `{baseUrl, runDir, controlSocket, cdpUrl}`, adding `alreadyRunning:true` for an existing run. `instance.json` also records the isolated root, config and project dirs, and launcher/server/browser pids. The browser pid is null if Chromium cannot report it. Inspect `launcher.log` if startup fails.

Chromium is headless at 1440x900 by default. Use `$V up --headed` or `$V up --phone` for a visible browser or the 393x852 mobile viewport with touch enabled. Use `$V up --video` to record every page at the viewport size into `videos/`. Recording costs CPU and produces larger evidence, so keep video runs short and focused on the flow being proved. These are startup choices; relaunch to change them. `info` reports `video:true|false`.

Every harness replays committed recordings, so no real provider, key or network is used:

- **Claude** (account `claude`) replays `test/fixtures/claude-sdk-traces/`. Models `haiku`, `opus`, `sonnet`. A trace's `<name>.subagent-reads.json`, if present, feeds the subagent's own transcript into its child session.
- **OpenCode** (account `opencode`) is a mock server replaying `test/e2e/fixtures/recorded/<name>`. It brings one seeded session titled `New session - 2026-03-27T04:02:14.925Z`.
- **Codex** (account `codex-2`, added automatically by the signed-in discovery trace) replays `test/fixtures/codex-app-server-traces/`. Its usage bars show in the sidebar footer.
- **Cursor** (account `cursor-replay`, added by the launcher) replays `test/fixtures/cursor-sdk-traces/`.
- Project `process-test` at `<root>/process-test`, an empty folder.

Pick recordings with `up` options or the existing env vars, for example `$V up --run x --codex-turn basic`:

| option | env | default | meaning |
|---|---|---|---|
| `--claude-turns a,b` | `CLAUDE_TURNS` | `pong-thinking-text-turn` x3 | one trace per prompt within each Claude session; each new session starts again at the first |
| `--claude-delay-ms n` | `CLAUDE_DELAY_MS` | `0` | wait n ms between replayed Claude messages, to observe in-progress states |
| `--opencode-recording x` | `OPENCODE_RECORDING` | `chat-simple` | OpenCode recording name |
| `--codex-turn x` | `CODEX_TURN` | `two-turns` | trace each Codex session replays from the top; a trace with `thread/fork` is split into a parent slice and one slice per fork (see [fork](features/fork.md)) |
| `--cursor-trace x` | `CURSOR_TRACE` | `basic` | trace whose last turn answers every Cursor prompt |
| `--no-seed-accounts` | `SEED_ACCOUNTS=0` | seeded | skips adding the Cursor account for the add-account flow |
| `--phone` | `VIEWPORT=phone` | desktop | mobile viewport and input capabilities |
| `--headed` | `HEADED=1` | headless | visible Chromium |
| `--video` | `VIDEO=1` | off | record every page; `down` finalizes and lists the videos |

The launcher also writes `codex-wire.jsonl`, `codex-trace-report.jsonl` (consumed rows and mismatches) and `cursor-capture.jsonl` to the run dir. Codex wire capture appends across all processes and transports, including discovery and delayed usage polls. Each transport adds a header with its scenario and recordedAt. Concurrent transports can interleave rows. The isolated server and its children load `scripts/codex-capture.mjs` through `NODE_OPTIONS` to make only this capture file append. Read these files when a replay misbehaves.

## Doctor

Run this first, and again whenever anything looks off:

```bash
$V doctor
```

It is read-only and returns `{healthy, checks:[{name, ok, detail}]}`, with exit 1 if unhealthy. It checks the launcher pid, an isolated `/tmp/conduit-verify-*` or `/private/tmp/conduit-verify-*` root, a port other than 2633, `/health`, `/info` buildId against `dist/src/lib/build-id.js`, that `dist/frontend` was bundled with the same id, the control socket and the attached page. A `buildId` mismatch means you rebuilt after launching. A `frontendBuildId` failure means a partial rebuild such as `pnpm build:server`: the page would reload itself and show a different-builds banner. Fix either with a full `pnpm build`, then `down` and `up`. `up` refuses to start on a partial build for the same reason.

## Drive

Use the control CLI for the user path:

```bash
$V home
$V new-session
$V send "Say hello" --harness claude --model opus --provider claude
$V snapshot
```

`home` navigates to the app root. `reload` reloads the current URL. Both wait for the composer input to be visible and return `{path}`. On `--phone` the root shows the session list with the composer hidden, so there they also accept a visible `#new-session-btn`.

`send` optionally picks the harness/model/provider, fills the composer, clicks send and waits for the reply to settle. Picking the model first avoids leaving a new prompt behind if selection fails. It returns `{path, sessionId, reply, turnStatus, ms}` and reads the last assistant message. Use `--no-wait` to inspect a running turn, then `$V wait-settle --timeout 30000`.

`wait-settle` requires inactive stored turns, no Stop control and an empty or explicitly paused pending-input queue. It also requires 300 ms without DOM mutations and 750 ms without turn or queue changes. A new turn resets that quiet window, so the gap between queued turns does not count as settled. On a draft, the same queue and quiet checks apply without stored turns. `--timeout` defaults to 60000 ms. Timeout errors include the last observed turn, queue and DOM state.

`pick-model --harness ... --model ... --provider ...` exposes the picker step separately and returns `{instanceId, shownProvider, shownModel, sendDisabled}`. A failed pick closes the picker and sheet before reporting the error. Both `send` and `pick-model` support Icons and Words controls on desktop and phone. They use the desktop Words model word or open the phone Composer sheet, then close the picker and sheet after selecting.

For other actions, use `click <selector>`, `hover <selector>`, `fill <selector> <text>`, `type <text>`, `press <key>`, `upload-image <file>` and `open-session <id>`. `click` accepts `--double` and `--button left|right|middle`, with left as the default. The flags can be combined. Locator commands reject zero or multiple matches and suggest `snapshot` to find a stable handle.

`scroll <selector>` scrolls the matched element into view. `--to top|bottom` moves its own scroll container or the nearest scrollable ancestor. `--by <pixels>` uses a real mouse wheel over the element. Use only one of these options. The result is `{scrollTop, scrollHeight, clientHeight}`.

`select-project <name|slug>` opens the session scope chip and selects the matching project from its menu. It waits for `?p=<slug>` and returns `{slug, path}` with the actual resulting pathname and query string. Desktop keeps the pathname and open session or draft. On phone, the scope menu lives on the session list, so the command lands there; the open session or draft is not kept. Unknown projects report available names and slugs; use a slug when names repeat.

`feature-flag <name> on|off` uses `?feats=` and persisted flags, keeping the current path and waiting like `reload`. Valid names come from the frontend flag source. It returns `{flags:[...]}` read from the page. `feature-flag debug on` opens the debug panel, which overlays `#send` at 1440x900. Turn it off before sending.

```bash
$V hover '#attach-btn'
$V click '#input' --double
$V click '#input' --button right
$V reload
$V upload-image /tmp/example.png
```

`upload-image` opens Attach if needed, selects Add Photos (`#attach-photos`) and sets the filechooser to the local image path. It closes the Attach menu and waits for the attachment chip to finish saving before returning its state.

Prefer `data-testid`, then the element ids from `test/e2e/page-objects/`, such as `#input`, `#send`, `#new-session-btn`, `#session-search-input` and `#terminal-panel`. Quote attribute values, especially model ids containing dots: `[data-model-id='gpt-6.1-sol'][data-provider-id='codex']`. Read state with `$V eval '() => document.querySelector("#send").disabled'`.

Use `$V ws-log` for WebSocket frames, including the RPCs sent by the browser. Entries include `direction: "in"` or `"out"`, `time`, `event`, `detail`, `state` and the socket `url`. The launcher records up to 2000 frames from page creation across reloads. `--last` defaults to 300; `--payloads` adds parsed JSON or raw text. The `?feats=debug` panel sits over `#send` at 1440x900 and swallows its click.

Feature recipes live in [features/README.md](features/README.md). Read the index, then the feature file you need.

Inspect the event store before `down`, because teardown deletes the root:

```bash
$V store sessions
$V store messages --session <id>
$V store turns --session <id>
$V store sql "select id, model_provider, model_id, title, status from sessions"
```

For tools the CLI does not wrap, such as `run-code`, run `$V info` and use its `playwrightAttach` command. It attaches `playwright-cli -s=verify-<id>` to the same launcher-owned page over CDP. Attaching late only shows requests from that moment on. Use `network-log` for HTTP history from context creation, and `ws-log` for WebSocket traffic.

## Keep the feature map current

Run `$V features check` after any UI, selector or CLI change, and before trusting a recipe. It statically checks `SKILL.md` and every `features/*.md` selector, command, option and relative link against this checkout. Fix stale entries in the same change. Dynamic values are counted as skipped; a green check does not prove those selectors or the UI flow.

### Hold and release

Replay runs to the end of a recording at once, so in-progress states are gone before you can look. `hold` stops a replay at a chosen point and `release` lets it go on:

```bash
$V hold --claude 2:21          # every Claude session, prompt 2, before trace line 21
$V hold --codex 102            # Codex: hold inbound trace rows whose at is above 102
$V hold --opencode permission.asked   # OpenCode: next prompt, after its first event of that type
$V release                     # all providers; or --claude, --codex, --opencode
```

- Set the hold before the send that should stop. Pass exactly one provider per `hold`.
- Claude `T:M`: `T` is the prompt number within each Claude session, and `M` is the line number in the trace, counting non-empty lines from 1. Every Claude session that reaches that point stops there, including side threads and forks.
- Codex `N` compares against each row's `at` in the trace. It also holds usage polls, so the usage bars freeze until release.
- OpenCode takes `session.status`, `permission.asked` or `question.asked`. Only one OpenCode hold can be armed at a time.
- `release` returns `claudeReached`, one entry per Claude runner that stopped at the hold. An empty list means the hold point was never reached.
- Hold on a line after the trace's leading `system` lines. `--claude 1:3` on `pong-thinking-text-turn` was never reached, while `1:14` held.
- `down` releases everything.

## Evidence

Keep artifacts under the run dir, which is gitignored:

- `$V screenshot` returns `{file}` and writes `shots/NNN.png`. Use `--file <path>` for before/after names.
- `$V up --video` records every page into `videos/`. Include a short video showing the action and result with change proof. After `$V down`, its `videos` array contains the absolute finalized `.webm` paths.
- `$V snapshot --file <path>` saves an ARIA snapshot. Without `--file`, the inline snapshot is capped at 20 KB with a truncation note.
- `$V store ...` returns read-only rows. Save the JSON beside the screenshots to prove the stored result.
- `$V console --level error` reads console messages and page errors buffered since the page was created. `$V ws-log --last 20` reads incoming and outgoing WS frames; add `--payloads` only when needed.
- `$V network-log` reads HTTP requests from context creation across reloads and pages, excluding WebSocket upgrades. The buffer holds 2000 requests; `--last` defaults to 100. Use `--failed` for HTTP errors or transport failures, `--grep <regex>` for URLs, and `--summary` for status and method/path counts plus failures. Entries include timing, status and resource type; pending requests have null status or duration.
- `$V logs --bytes 8000 --grep 'pattern'` reads full server stdout/stderr from `server.log`. `logs --level verbose|info|warn` changes the running server's log level through `SetLogLevel` before reading. It does not filter existing lines. Use `--grep` to filter.
- `$V perf-metrics` returns CDP performance metrics. `$V trace start`, then `$V trace stop` saves `traces/NNN.zip` and returns `{file, viewCommand}` for Playwright's trace viewer.
- `down` adds `daemon.log` and `harness-proof.json`, recording pids observed and cleaned up. The full `server.log` survives teardown too.

Proof standards:

- Drive the real UI path a user takes. `store`, `logs --level` and `eval` are for observing and debugging. They are not the user path and must not be used to reach an end state. Do not call RPCs or set store rows to reach that state.
- Capture the action and the resulting state, plus a second view of the stored result: the store rows, or a reload, or a second browser context.
- The replayed providers stand in for external model APIs and CLIs, which is the existing production boundary. Everything from the browser to SQLite is real code from `dist/`.
- Replay leaves real logins, real model output, and real provider CLIs and binaries unverified.
- The `CONDUIT_TEST_*`, `CONDUIT_CODEX_*` and `CONDUIT_CURSOR_*` env vars only pick fixtures. They are not a user path; do not cite them as proof.

## Cleanup

```bash
$V down --dry-run    # reports launcher/server/browser pids, root and socket; changes nothing
$V down              # returns {stopped, evidenceDir, videos}
```

`down` sends SIGTERM to the recorded launcher pid and waits for `STOPPED`. SIGINT and SIGHUP use the same shutdown handler. The launcher closes the context before Chromium, waits for every page's video to finalize, and writes `videos.json` with existing, non-empty files. A missing or empty recording makes shutdown fail; pages that produced no frames are skipped. Without recording, `videos` is `[]`. It closes the control server, saves `daemon.log`, then disposes the harness. Disposal stops the server, Claude runners, PTY host and mock OpenCode, deletes the temporary root, and writes `harness-proof.json`. Never kill by name. If cleanup fails, inspect `ps -axo pid,command | rg conduit-verify-` with a byte cap and act only on pids your run started.

Run `down` after failed attempts too, so broken runs don't strand ports and processes. Evidence in `test-results/verify-conduit/` survives `down`. Delete it only when the user says so.

## Helpers

The skill lives in `.agents/skills/verify-conduit/`, which Codex, Cursor and OpenCode read. `.claude/skills/verify-conduit` is a symlink to it for Claude Code. Edit the `.agents` copy.

- `scripts/conduit-verify.mjs`: executable plain-JS ESM client. Start with `--help`, then command or group help. It uses Node directly, without tsx startup overhead.
- `scripts/features-check.mjs`: static feature-map checker used by `features check`. It needs no server or browser.
- `scripts/launch.ts`: what `up` runs (`node --import tsx scripts/launch.ts <run-dir>`). Use the env vars above first. Change the `ProcessHarness` options here only when a feature needs something they can't select, and note it in the feature's Gotchas.
- `scripts/codex-capture.mjs`: isolated preload that changes the configured Codex capture file from overwrite to append. Other files keep their normal open mode.
- `$V selftest`: runs `features check` first, launches with `--video`, toggles debug on and off, checks the HTTP load summary, proves scrolling on a temporary overflow fixture and selects `process-test` through the scope menu. It tests chat and stored model/reply rows across all four harnesses, inspection tools and dry-run immutability, then checks non-empty `.webm` files, teardown evidence and process cleanup, including Chromium when its pid is known. It defaults to run id `selftest` and always attempts `down` after a launch attempt. See [features/chat.md](features/chat.md) for replay limits.

## Other surfaces

- CLI (`conduit status`, `conduit project add`, and so on) talks to the daemon over a Unix socket in the config dir. `ProcessHarness.runCli` drives it, but this skill does not cover it yet.
- Phone layout: launch with `up --phone`. Some controls move into sheets. `pick-model` and `send` handle the Composer sheet in both Icons and Words modes.
- Runtime projects share the launcher's provider fixtures. Codex discovery with cached authentication and OpenCode's shared replay inventory and prompt counter still limit second-project verification. Causes and proposed fixes are tracked in bead `conduit-test-9jmlm`.
