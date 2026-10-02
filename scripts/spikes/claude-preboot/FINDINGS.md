# Claude CLI pre-boot spike

Ticket `conduit-test-85kb.2`, measured on 2026-10-02, macOS arm64, Node
`v26.10.0`, installed `@anthropic-ai/claude-agent-sdk` **0.3.280**.
This directory is a throwaway spike, not production provider code.

**Yes, both fresh and resumed streaming-input queries can spawn the Claude CLI
and complete the SDK initialize handshake before any user prompt is enqueued.**
The SDK does this during `query()` construction. The public `system/init`
message arrived only after input in all eight observed runs, so it is unsuitable
as a pre-boot readiness barrier. Use `query.initializationResult()` or the
installed SDK's explicit `startup()` API.

## Installed source evidence

Paths below are relative to the repository root. The installed `sdk.mjs` is
minified; function names identify the relevant code within its long lines.
Its SHA-256 is
`ef4c2c0fc286d8c7dab7771516cf95206f9f670e99e74dc62f245b7fc8224955`.

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:232` exports `DQt` as
  `query` and `LQt` as `startup`.
- `sdk.mjs:229`, `DQt`, calls `MN` to construct the transport and Query, then
  attaches the prompt through `UN`. `sdk.mjs:228`, `MN`, constructs `Jk` with
  `deferSpawn` unset on the normal path, including ordinary `options.resume`.
- `sdk.mjs:127`, `Jk`'s constructor, calls `this.initialize()` immediately unless
  `deferSpawn` was explicitly set. That method constructs CLI arguments, adds
  `--resume=<id>` when requested, and calls the custom spawn hook or
  `spawnLocalProcess`, which calls Node's child-process spawn. This happens before
  `streamInput()` can receive its first user message.
- `sdk.mjs:127`, `VS`'s constructor, starts the internal output reader and
  initialize handshake immediately. `sdk.mjs:129`, `VS.initialize`, sends the
  `initialize` control request. `sdk.mjs:131`, `initializationResult`, returns
  that handshake's cached promise. The control response is different from an
  SDK message with `type: "system", subtype: "init"`.
- `sdk.mjs:131`, `streamInput`, waits in `for await` for input, writes each
  yielded user message, and ends CLI stdin when the iterable finishes. A
  suspended iterable allows the already-spawned CLI to remain alive. An iterable
  that immediately finishes is therefore not an idle queue.
- `sdk.mjs:229`, `LQt`, implements **`startup({ options, initializeTimeoutMs })`**.
  It constructs the same CLI/Query, waits for `initializationResult()` with a
  default **60,000 ms initialization timeout**, and returns a `WarmQuery`.
  `WarmQuery.query(prompt)` attaches input once. `WarmQuery.close()` discards an
  unused warm handle; after attaching input, close the returned Query.
  The exported contract is in `sdk.d.ts:9137-9144` and `sdk.d.ts:9513-9531`;
  `Query.initializationResult()` is declared at `sdk.d.ts:2820`.

The `resume`/`continue` plus external `sessionStore` path is a separate case.
`sdk.mjs:229`, `Nit`, requests deferred spawn while loading/hydrating the saved
session, then calls the transport's `spawn()`. It waits for storage, not the
first input message. Conduit's current query options do not use that path.

Conduit itself currently enqueues the first user message before constructing
the query, at `src/lib/provider/claude/claude-provider-runtime.ts:409` and
`:507`. This spike changes none of that production code.

## Measurements

`measure.ts` creates a suspended async generator and immediately calls `query()`.
The public `spawnClaudeCodeProcess` hook performs the same local native CLI
launch and records both the hook invocation and Node's `spawn` event. It also
places the child in its own process group for cleanup. Times start immediately
before `query()`; SDK import time is excluded.

Each fresh run creates a new session, completes one tiny turn, and closes its
CLI. The matching resume run starts a new CLI with that just-created session
ID and checks that the resulting ID matches. All six turns returned `ok`.
These are fresh sessions/processes, not machine restarts or cleared OS caches.

The input remains empty until the initialize handshake has completed **plus
5,000 ms**. It then receives exactly `reply with ok`. The iterable stays open
until cleanup. First token means the first nonempty streamed `text_delta`, not
a buffered assistant message or thinking token. All figures are milliseconds.

| Mode/run | Query to spawn event | Query to initialize ready | Pre-input system/init | Enqueue to system/init | Enqueue to first token | Query to first token |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Fresh 1 | 10.5 | 896.4 | none | 14.8 | 1813.7 | 7711.6 |
| Resume 1 | 1.7 | 195.2 | none | 10.7 | 2539.2 | 7736.3 |
| Fresh 2 | 1.5 | 187.8 | none | 11.4 | 1040.5 | 6229.7 |
| Resume 2 | 1.5 | 178.2 | none | 17.6 | 1790.9 | 6971.5 |
| Fresh 3 | 1.8 | 199.3 | none | 11.3 | 989.2 | 6190.0 |
| Resume 3 | 1.6 | 178.3 | none | 11.2 | 1551.8 | 6731.1 |

Median initialize readiness was **199.3 ms fresh**, **178.3 ms resumed**.
The first fresh run was substantially slower. Three samples per mode are too
few to estimate a production latency distribution or explain that difference.
Median enqueue-to-first-token was 1040.5 ms fresh and 1790.9 ms resumed.
The query-to-token column includes the deliberate five-second idle hold.
The spawn hook ran synchronously, 3.4 ms into the first `query()` call and
0.3 ms into each remaining call. Node's spawn event is delivered subsequently.

`results.json` contains the unrounded measurements, timestamps, replies, token
usage, session IDs, and PIDs. Every `preInputEvents` array is empty. There were
no pre-input assistant, result, or system/init messages exposed by the SDK.

A separate fresh/resume pair held input empty for **60,000 ms after readiness**.
Both stayed alive and subsequently replied `ok`. Ready times were 929.3 ms fresh
and 208.7 ms resumed; enqueue-to-token was 926.2 ms and 1777.4 ms respectively.
Neither emitted pre-input SDK messages. See `idle-results.json`.

## Environment and scope

The script imports `makeClaudeSdkEnv` directly from
`src/lib/provider/claude/claude-sdk-env.ts:20`. It therefore removes the direct
Anthropic API key/auth token/base URL/custom headers and model-alias overrides,
sets the Conduit client-app identifier, and disables claude.ai MCP connectors.
**No direct `ANTHROPIC_API_KEY` is used.**

Credentials were available. An unexpired OAuth access token was read from the
current profile's Keychain, then passed as `CLAUDE_CODE_OAUTH_TOKEN` to a private
CLI config directory. The script can also read an existing OAuth env token or
profile `.credentials.json`; it never refreshes credentials. No token is
printed or written to an evidence artifact.

Config and working directories are temporary children of this spike directory
and are removed after cleanup. Real Conduit config, projects/event stores, the
daemon, shell files, and service configuration are untouched. `settingSources`
is empty, tools and MCP servers are disabled, thinking is disabled, and
nonessential CLI traffic is disabled. The requested model alias was `sonnet`;
the emitted actual model was `claude-sonnet-5`.
These choices isolate SDK/CLI boot and prevent local hooks from doing other
work. They are not a timing reproduction of Conduit with its normal user,
project, local settings, hooks, tools, and MCP servers.

## Caveats

- **Readiness depth.** The measured barrier proves process boot and SDK control
  initialization. It does not prove that every deferred first-turn operation,
  production MCP connection, history restoration step, or remote model request
  has already completed. The resume turns did reuse the saved session ID and
  had 618 input tokens versus 567 on fresh turns, consistent with the tiny
  saved history. There was no cold-send comparison, so these measurements do
  not quantify total latency saved by pre-warming.
- **Idle timeout.** The installed local `Jk` transport and `VS` Query contain no
  idle-expiry timer. Their timers cover cleanup/stderr drain, not idle eviction.
  The native CLI remained usable after 60 seconds in both modes. Longer idle
  durations and provider-side limits were not verified. `startup()`'s default
  60-second timeout applies to initialization, not subsequent idle time. A
  runner should still enforce its own resource/idle policy and boot deadline.
- **Tokens/quota.** While input was suspended, the SDK sent only its control
  handshake; it exposed no inference or usage messages. The source and runs
  support pre-boot itself requiring no model prompt/tokens. Account-level quota
  counters and billing were not queried, so zero subscription quota consumption
  is not independently established. Startup auth/network activity and any
  configured hook/MCP programs are separate from model-token consumption.
  The requested turns did consume tokens, 567 or 618 input and 4 output each.
  The OAuth runs reported `total_cost_usd: 0`, which is not proof of zero quota
  use. Anthropic documents cost fields as local estimates rather than billing
  truth in [Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
- **Lifetime/cleanup.** Keep the prompt iterator pending while idle; exhaustion
  closes stdin. A pre-booted session retains a CLI process, memory, and pipes;
  RSS and idle CPU were not measured. Explicitly close the Query or unused WarmQuery on eviction,
  cancellation, boot failure, or owner shutdown. `sdk.mjs:127`, `Jk.close`, ends
  stdin, allows 2 seconds, then sends SIGTERM and escalates to SIGKILL 5 seconds
  later on Unix. `sdk.mjs:127`, `JW`, also registers a parent-exit SIGTERM cleanup
  handler; an abruptly killed parent cannot run that JavaScript handler.
  Do not assume crash-proof cleanup from normal close behavior alone.

For the epic, pre-warming can reach a spawned CLI with a completed initialize
handshake, fresh or resumed. No synthetic user prompt is needed. The `startup`
API is the simplest explicit expression of that intent in this installed
version; the existing streaming queue can also be constructed early and checked
with `initializationResult()`. The explicit `startup()` API was checked in
installed source, not separately benchmarked. Runtime integration and its exact
settings remain outside this spike.

## Reproduce and verify

From the repository root, with already-installed dependencies:

```sh
node --import tsx scripts/spikes/claude-preboot/measure.ts > scripts/spikes/claude-preboot/results.json
CLAUDE_PREBOOT_ROUNDS=1 CLAUDE_PREBOOT_IDLE_MS=60000 node --import tsx scripts/spikes/claude-preboot/measure.ts > scripts/spikes/claude-preboot/idle-results.json
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2024 --module ESNext --moduleResolution Bundler --types node scripts/spikes/claude-preboot/measure.ts
./node_modules/.bin/biome check scripts/spikes/claude-preboot/measure.ts
```

Both measurement commands exited **0**. The scoped strict TypeScript check
exited **0**. An earlier ad hoc check without `--strict` did not match the
project's schema nullability settings and failed in imported OpenCode contracts;
the strict check also caught a spawn-hook return type, corrected before passing.
Biome formatted only the spike script; the final check exited **0**, checked
one file, and applied no fixes.
The driver emitted a Node/tsx module-registration deprecation warning, which
did not prevent execution. No pnpm command, install, production build, unit
suite, or visual suite was needed or run.

Cleanup evidence covers **all eight** measured Claude PIDs. The script called
`close()`, awaited exit with bounded escalation, killed any remaining members
of each dedicated process group, checked PID absence, and removed scratch
directories. An independent `ps -eo pid=,ppid=,pgid=` check found no process with
any recorded PID, parent PID, or process-group ID. No spawned Claude process
remained. Evidence artifacts contain `allChildrenTerminated: true`.

Only this spike directory was changed. No commits or Beads writes were made.
The findings are ready for the orchestrator to append to epic notes; the task's
read-only Beads instruction prevents doing that here.
