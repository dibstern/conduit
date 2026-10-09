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

## When To Escalate

### Integration

Run this when changing daemon, relay, server, session, or instance behavior that depends on a real relay stack or OpenCode interaction.

```bash
pnpm test:integration
pnpm test:contract
```

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

None of them record video, deliberately. Traces already cover what video showed, and `recordVideo` needs the ffmpeg Playwright downloads for itself — a binary only a full `playwright install` fetches, and one whose published macOS build will not run on macOS 26. When it is missing every test fails at `browserContext.newPage`; when it is present but unusable every test instead burns its full timeout in `Tearing down "context"`. Either way all six Playwright legs go red for reasons unrelated to the code under test. Leave `video` off (conduit-test-tj4q).

The one place that genuinely needs that binary is the media scene runner, which records a WebM to convert to a GIF. Its test checks both ffmpeg binaries by running them, so it skips honestly on a machine that cannot do it.

### iOS Safari (Simulator)

Run this when changing touch gestures, long-press, or text selection on phones. Chromium cannot see these bugs: it treats `-webkit-user-select` as an alias of `user-select` and has no native text-selection hold. Every Playwright lane passed while iPhones selected text in the session action sheet (conduit-test-wmzr). This lane drives Safari in the iOS Simulator through `safaridriver`, which sends real UIKit touches.

```bash
pnpm test:e2e:ios
```

Needs Xcode with an iOS simulator runtime. `safaridriver` boots a simulator itself. Verified on iPhone 17e, iOS 26.5, with no extra setup. An iOS 27.0 simulator refused automation sessions ("Could not find any session hosts"), so pin a working device with `IOS_SIMULATOR_UDID=<udid>` from `xcrun simctl list devices`. Evidence goes to `test-results/ios-long-press/`: `result.json` and a screenshot after each hold.

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

`opencode-real-lifecycle.test.ts` runs the real `opencode` (PATH or `CONDUIT_TEST_REAL_OPENCODE`; skipped unless it
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

Run the static guardrail suite when touching Effect ownership, daemon/relay composition, provider adapters, persistence, or transport boundaries:

```bash
pnpm exec vitest run test/unit/effect/runtime-boundary-grep.test.ts
```

Final guardrail expectations as of 2026-05-15:

- `startDaemonProcess`, `PersistenceLayer.open(...)`, rejectable `Effect.promise(...)`, and dynamic `concurrency: "unbounded"` have zero production hits under `src`.
- Runtime entry grep has explicitly accepted hits: standalone HTTP compatibility, OpenCode SDK fetch, Claude SDK permission callback, frontend transport, local CLI RPC, and relay startup.
- `relay-stack.ts` has zero `Layer.succeed(...)` relay bridge composition hits.
