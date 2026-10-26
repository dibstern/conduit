# Testing Guide

Use this guide before choosing verification beyond the default path in AGENTS.md.

## Default Verification Path

For most changes, run only the narrow default path:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Start there unless the change crosses a boundary that unit tests cannot cover.

## Release gate

Release CI (`.github/workflows/npm-release.yml`) is the authoritative release
gate. It runs every group defined in `scripts/test-all.sh`, the single source
of truth for the `pnpm test:all` stage list. Multiple groups overlap static
checks with builds, then integration/contract with strict Storybook visuals.
Builds finish before any dist/ readers; unit, Storybook interaction and E2E
suites run separately to limit CPU contention. Lane logs and isolated Playwright
artifacts stay in the printed temporary run directory. The summary lists stages
in the original order with results, timings and total wall time; any failure
exits non-zero.

| Group | Stages | Release job | Runner |
| --- | --- | --- | --- |
| `static` | Type check, lint | `lint-and-build` | `ubuntu-latest` |
| `vitest` | Unit, integration, contract | `vitest` | `ubuntu-latest` |
| `build` | Build | `lint-and-build` | `ubuntu-latest` |
| `e2e` | Replay, harness, daemon, preview Playwright configs, including all configured projects | `e2e` | `ubuntu-latest` |
| `storybook` | Storybook build, interaction and a11y | `storybook` | `ubuntu-latest` |
| `visual` | Strict Darwin Storybook visual | `visual` | `macos-latest` |

The release job waits for every verification job. The existing release-only
build-output tests also run in `lint-and-build`, after the `build` group.
Normal CI (`ci.yml`) runs a narrower set of checks.

Run one or more groups locally:

```bash
bash scripts/test-all.sh static
bash scripts/test-all.sh build e2e
bash scripts/test-all.sh storybook visual  # macOS, for Darwin baselines
```

Single groups keep their original commands, order and output locations. Each
selected group runs once. Install Chromium with
`pnpm exec playwright install --with-deps chromium` for the `e2e`,
`storybook`, and `visual` groups. `e2e` needs `dist/` from the `build` group or
CI's build artifact. Some integration tests also read `dist/`, so keep it current
when selecting `vitest` without `build`. `visual` needs `dist/storybook/` from
the `storybook` group or `pnpm storybook:build`, which its macOS job runs as a
prerequisite.

## Pre-commit

Lefthook runs every check in parallel: Biome on staged files, `pnpm lint:rules`,
the three typechecks behind `pnpm check`, `pnpm build`, the `guards` project, and
`vitest related --run {staged_files}`. Leaf-file commits take about 25 s; files
imported widely (core domain, shared test helpers) pull in far more tests.

`related` cannot see filesystem reads, so `forceRerunTriggers` in
`vitest.config.ts` runs the whole unit suite when fixtures, SDK traces,
baselines, the lockfile, tsconfigs, `test/setup.ts`, the theme CSS, or
`scripts/build.mjs` change. Keep the `**/` prefixes: Vitest matches them against
absolute paths. Full suites stay in `pnpm test:all` and CI.

Time a hook run without committing:
`pnpm exec lefthook run pre-commit --file <path>` (add `--command test` for the
tests alone).

## When To Escalate

### Integration

Run this when changing daemon, relay, server, session, or instance behavior that depends on a real relay stack or OpenCode interaction.

```bash
pnpm build
pnpm test:integration
pnpm test:contract
```

Integration files run in parallel in up to 4 fork workers. Set
`CONDUIT_INTEGRATION_WORKERS=<positive integer>` to override the worker cap.

Process harnesses use `dist/` by default in this suite. Rebuild after changing
`src/`. Set `CONDUIT_TEST_DIST` to another build directory, or to an empty string
to use source for fixtures without an explicit build. Tests that verify source
behavior opt out explicitly.
Stale or missing dist fails fast in integration and E2E groups; bypass with `CONDUIT_SKIP_DIST_CHECK=1`.

### Claude process runners

The default server uses Claude runner processes. The process harness isolates
HOME, server config and project directories, injects the fake SDK, and drives
browser RPC and WebSocket endpoints. Runner tests require no mode selector.
Tests that inject an in-process query factory use an explicit runner dependency.

```bash
pnpm build
CONDUIT_TEST_DIST=dist npx --no-install vitest run --config vitest.integration.config.ts \
  test/integration/daemon/claude-runner-upgrade.test.ts \
  test/integration/daemon/claude-runner-restart.test.ts \
  test/integration/daemon/claude-process-runner.test.ts \
  test/integration/daemon/process-harness.test.ts \
  test/integration/daemon/process-harness-build.test.ts
npx --no-install vitest run test/integration/daemon/claude-process-runner-lifecycle.test.ts
CONDUIT_PREWARM_E2E_DIST=dist npx --no-install vitest run --config vitest.integration.config.ts \
  test/integration/daemon/claude-prewarm.test.ts
```

The real-SDK smoke skips by default. Opt in on a machine with network and
keychain access and an existing Claude login:

```bash
RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
  test/e2e/provider/claude-runner-real-sdk.test.ts
```

It writes `test-results/85kb-15-real-sdk.json` with the runner PID and spawn,
first-event and turn-end timings. Only the session query uses the real SDK;
title generation and capability probing use fakes. See
[Claude runners](claude-runners.md) for the default-path latency comparison
against a preserved pre-.15 build.

The worktree contract test uses the same opt-in gate and needs no build:

```bash
RUN_EXPENSIVE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts \
  test/e2e/provider/claude-worktree-trace-capture.test.ts
```

It pins resume/cwd behaviour and captures `enter-worktree-turn.jsonl` and
`exit-worktree-keep-turn.jsonl` under `test/fixtures/claude-sdk-traces/` after
all assertions pass. Review these real wire traces before committing them.
Each run writes `run.json` and raw turn traces to a unique directory under
`test-results/q5u6-1.1-worktree/`, including failures and `CwdChanged` hook
observations. If that hook fires, revisit it as the workspace move signal.

### E2E (Replay — Default)

Run this when changing browser-visible workflows, WebSocket behavior, mobile flows, or end-to-end session lifecycles. Uses recorded WebSocket fixtures — no running OpenCode instance needed.

```bash
pnpm test:e2e                                    # full suite
pnpm test:e2e test/e2e/specs/<spec>.ts            # single spec
pnpm test:e2e --grep "<name>"                     # by test name
```

Prefer a single spec or grep filter over the full suite.

If the frontend is already built or you need to avoid package-script argument forwarding, run Playwright directly:

```bash
pnpm exec playwright test --config test/e2e/playwright-replay.config.ts --grep "<name>"
pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/<spec>.ts --project=desktop
```

### Debugging A Playwright Failure

Every Playwright config captures a trace on first retry and a screenshot on failure. The trace is the tool to reach for — it carries a screencast, DOM snapshots, network and console:

```bash
pnpm exec playwright show-trace test-results/<test-dir>/trace.zip
```

None of them record video, deliberately. Traces already cover what video showed, and `recordVideo` needs Playwright's own ffmpeg binary, downloaded with `playwright install ffmpeg`. Some macOS 26 machines reject its code signature. When it is missing every test fails at `browserContext.newPage`; when it is present but unusable every test instead burns its full timeout in `Tearing down "context"`. Either way all six Playwright legs go red for reasons unrelated to the code under test. Leave `video` off (conduit-test-tj4q).

The media scene runner records a WebM to convert to a GIF. Its test runs only in
the opt-in media lane, outside `pnpm test:integration`:

```bash
pnpm exec playwright install ffmpeg
pnpm test:media
```

`test/media/media-generation.test.ts` runs `pnpm generate:media setup`, which
rebuilds `dist/frontend` and starts its own preview on a free loopback port.
It checks both ffmpeg binaries by running them and skips if either cannot run.
The runner stops only the preview process group it spawned.

### iOS Safari (Simulator)

Run this when changing touch gestures, long-press, or text selection on phones. Chromium cannot see these bugs: it treats `-webkit-user-select` as an alias of `user-select` and has no native text-selection hold. Every Playwright lane passed while iPhones selected text in the session action sheet (conduit-test-wmzr). This lane drives Safari in the iOS Simulator through `safaridriver`, which sends real UIKit touches.

```bash
pnpm test:e2e:ios
```

Needs Xcode with an iOS simulator runtime. `safaridriver` boots a simulator itself. Verified on iPhone 17e, iOS 26.5, with no extra setup. An iOS 27.0 simulator refused automation sessions ("Could not find any session hosts"), so pin a working device with `IOS_SIMULATOR_UDID=<udid>` from `xcrun simctl list devices`. Evidence goes to `test-results/ios-long-press/`: `result.json` and a screenshot after each hold. The script also builds Storybook and drives `UI/HoldMenu` (Device Probe) through tap, dim-tap, hold-slide-release on and off the list, and hold-release in place; its `result.json` and twelve step screenshots go to `test-results/ios-hold-menu/`. A swipe that turns into a native scroll hangs safaridriver, so swipe cases live in the Chromium touch spec (`test/visual/hold-menu.spec.ts`). If a run hangs or reports "already paired with a different session", stop the stale `safaridriver` you started, then `xcrun simctl terminate <udid> com.apple.mobilesafari`.

WebDriver lifts the finger at (0,0), which drags any live selection toward the top-left, so a screenshot can show a bigger highlight than a person would get. The assertions count only selections made while the finger is still down.

### Live E2E

Run this for full-pipeline validation against a real, ephemeral OpenCode instance. Requires `opencode` on `$PATH` and valid API credentials. Do not assume the instance uses port `4096`; tests and logs report the active URL.

```bash
pnpm test:e2e:live
```

### Updating Recorded Fixtures

The recorder (`pnpm test:record-snapshots`) spoke the retired `/ws` relay protocol and was removed
with it. The committed fixtures still replay through the E2E mock, which projects their legacy
messages into RPC. Until an `/rpc` recorder exists, edit fixtures by hand.

### Daemon E2E

Run this only when changing daemon lifecycle or daemon-specific flows that are covered by the dedicated Playwright config.

```bash
OPENCODE_SERVER_PASSWORD=<password> pnpm test:daemon
```

For foreground startup, full stop, and restart preservation, use the isolated
process harness. It starts the built CLI with temporary HOME, config and project
directories, a fake Claude SDK, and managed OpenCode stand-ins. It does not need
the user's running server or provider credentials.

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm build
CONDUIT_TEST_DIST=dist npx --no-install vitest run --config vitest.integration.config.ts \
  test/integration/daemon/serve-foreground.test.ts \
  test/integration/daemon/process-harness.test.ts \
  test/integration/daemon/process-harness-build.test.ts \
  test/integration/daemon/claude-runner-restart.test.ts \
  test/integration/daemon/pty-host.test.ts \
  test/integration/daemon/managed-opencode-restart.test.ts \
  test/integration/daemon/managed-opencode-cli-restart.test.ts
npx vitest run test/integration/daemon/claude-process-runner-lifecycle.test.ts
```

`serve-foreground.test.ts` verifies that `conduit serve` exits 0 on signal shutdown
with independent runners, terminals and managed OpenCode
available for the next server to re-adopt. It also verifies full `conduit stop`,
occupied-port rejection, the hidden `--foreground` alias and bare project
registration. Evidence and cleanup results go to
`test-results/85kb-16-serve.json`. Inspect `ps -axo pid,command` for processes
started by the tests; never signal processes belonging to the user's live server.

#### Daemon git and event-loop budgets

Run the isolated process-harness budget test on an otherwise quiet machine:

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm test:budget </dev/null
```

This builds the daemon, seeds 30 sessions in real linked git worktrees across
two projects, deletes one worktree folder, and holds the browser shell feed
open. It measures 30 seconds idle, an external commit's arrival in that feed,
16 seconds of status/add churn in ten worktrees, and project/session list reads.
The cold project is never opened in a session view. Churn includes one running
fake Claude turn, one viewed session, and eight listed sessions.

The normalized report is `test-results/daemon-budget.json`; the daemon log is
`test-results/daemon-budget.log`. The report includes all command counts and
rates, loop p50/p99/max in milliseconds, slow-RPC counts per phase, per-worktree
git reads and tier limits, and cleanup evidence. The isolated daemon subscribes
to the subprocess owner's `conduit:subprocess-metrics` diagnostics channel.
Start events include command arguments and the working directory, so one
`git status` counts one git read and long-running processes count in the phase
where they start. Fixture git commands run outside that owner and are excluded.
Idle measurement starts after all workspace and project-folder publications
exist and the subprocess owner has finished its startup work.
The external commit's pending refreshes settle in a separately recorded phase
before the test establishes Running and Viewed activity for churn.

The targets in `test/budget/daemon-idle.test.ts` are intentionally red until
conduit-test-g43i.4/.5 land. They are 6 idle spawns/minute, loop p99 below 50 ms
against a 500 ms slow-RPC threshold, external commit visibility within 1 second,
at most one churn read per tier interval plus the leading read, and zero spawns
during each list RPC's actual start/end interval, including background spawns
that overlap it. The report also preserves every raw control-phase spawn and
counts those outside the RPC, including up to 50 ms spent polling for the end
acknowledgment after the RPC has returned. Run again on a quiet
machine to investigate timing variance; do not loosen the budgets.

This suite has its own Vitest config. It is excluded from default unit,
integration, E2E and `scripts/test-all.sh` release groups. Its expected red
baseline must not block unrelated commits or releases.

The [post-c329db13 baseline](../../test/budget/baselines/post-c329db13.json)
measured 655 idle spawns/minute, idle loop p50/p99/max of 10.854/18.203/71.827 ms,
and a 5,024 ms external commit arrival. Churn loop p99 was 45.580 ms; reads were
2 Running, 1 Viewed, and 1 per Listed worktree. Project/warm-session/cold-session/
missing-worktree list reads spawned 28/38/12/1 processes. No measured phase
logged a slow RPC. Idle and churn p99 passed in this run; the spawn and arrival
budgets failed. Timing and poll alignment vary between runs.

Daemon loop monitoring runs by default. Slow-RPC lines include `loopActiveMs`
and `loopUtilization`, the main thread's busy time over the request; near
`totalMs` means synchronous work, not I/O, filled it. A native loop-delay
histogram is checked every second and logs `event loop blocked` when a stall
passes 250 ms, at most once every 30 seconds.

#### Restart and create latency under load

`harness-restart-load.spec.ts` seeds approximately 10,000 sessions, connects
browser devices and streams fake Claude writes while checking restart and
read-sharing behaviour. Run it with one worker to keep timings comparable:

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm build </dev/null
CONDUIT_TEST_DIST=dist pnpm exec playwright test --config test/e2e/playwright-harness.config.ts \
  --project=desktop --workers=1 harness-restart-load.spec.ts </dev/null
```

The create-latency gate reuses that isolated store and fake streams. It sends
raw CreateSession RPCs while four desktop devices hold the sidebar open,
waiting for two newly persisted ticks from each stream between creates.
This preserves the background work of the former 200 ms cadence under load.
Devices use chronological grouping so the new idle sessions enter the rendered
page ahead of the 5,001 seeded unread roots.
Its clock includes the first rendered row on each device, measured by observers
armed before each RPC.

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm test:perf:create </dev/null
```

Parameters are `CREATE_LATENCY_DEVICES` (4), `CREATE_LATENCY_CREATES` (50),
`CREATE_LATENCY_ARRIVAL_TIMEOUT_MS` (5000), and `CREATE_LATENCY_P90_CEILING_MS` (250). The test always uses three existing
100 ms fake Claude streams, `CONDUIT_SLOW_RPC_MS=1`, and
`CONDUIT_TRACE_MIN_MS=5` in its isolated daemon. Before the measured phase, it
creates a stream session and restarts with `CONDUIT_TRACE_SESSION` set to that
session's ID, retaining its short successful spans while filtering other sessions.

The regression gate counts rows materialized per live sidebar read. Each read
must contain at most the created sessions plus the three streaming sessions,
even when several changes coalesce into one window. Reading the whole sidebar
from the 10,000-session store fails this bound independently of machine load.
Latency has only a loose p90 ceiling, about 4x the worst p90 seen under heavy
load, because a tight limit also measures OS scheduling delays.

The attached `create-latency.json` in each test's output directory records
parameters, the row budget, every RPC and device arrival, p50/p90/max, achieved
persisted write rate, sidebar row counts, shell read and replacement counts,
and CreateSession/SubscribeShell slow logs. Separate output directories preserve
every project's and repeat's evidence. An arrival failure means creates failed
to reach all sidebars before their deadline.
A stream-progress failure means the intended background work was not sustained;
replacement reads indicate a shell subscription regression. Missing slow logs
or short successful spans outside the debugged session indicate broken request
logging or file sampling. Missing short spans for the debugged session indicate
broken session tracing.

`opencode-real-lifecycle.test.ts` runs the pinned `opencode-ai` executable (`CONDUIT_TEST_REAL_OPENCODE` overrides it; skipped unless it
matches `@opencode-ai/sdk`) behind a logging proxy, never prompting: lazy spawn, one process and `/global/event` stream
for two projects, per-project routing, idle stop. Evidence: `test-results/pa3r-10-real-lifecycle.json`.

### Multi-Instance

Run this when changing instance switching, registry behavior, or multi-instance UI and routing.

```bash
pnpm test:multi-instance
```

### Visual Regression

Run this only for deliberate UI or rendering changes where screenshot coverage matters.

```bash
pnpm test:visual
pnpm test:storybook-visual
```

## Selection Heuristics

- Prefer the smallest test surface that proves the change.
- Do not run full E2E or visual suites for pure refactors, docs changes, or isolated backend logic.
- If a change affects both runtime logic and UI, use the default path first, then add the narrowest relevant integration or E2E command.
- If you need alternate modes or helper variants, check `package.json` rather than copying the full script inventory into AGENTS.md.

## Effect Migration Guardrails

Static source guards live in `*.guard.test.ts` files and run in the `guards`
project. Run them on every pre-commit check: `vitest related` cannot track files
these tests read as text. Select related behavioral tests from the `unit`,
`unit-sqlite`, and `components` projects separately.

```bash
pnpm exec vitest run --project guards
pnpm exec vitest related --run --project unit --project unit-sqlite --project components <changed-files>
```

Run the static guardrail suite when touching Effect ownership, daemon/relay composition, provider adapters, persistence, or transport boundaries:

```bash
pnpm exec vitest run test/unit/effect/runtime-boundary-grep.guard.test.ts
```

Final guardrail expectations as of 2026-05-15:

- `startDaemonProcess`, `PersistenceLayer.open(...)`, rejectable `Effect.promise(...)`, and dynamic `concurrency: "unbounded"` have zero production hits under `src`.
- Runtime entry grep has explicitly accepted hits: standalone HTTP compatibility, OpenCode SDK fetch, Claude SDK permission callback, frontend transport, local CLI RPC, and relay startup.
- `relay-stack.ts` has zero `Layer.succeed(...)` relay bridge composition hits.
