# macOS service runtime survival

Build the current worktree, then run on a logged-in Mac with a GUI launchd domain:

```sh
eval "$(mise env -s bash)"
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm build
bash test/e2e/macos-service/run.sh
```

The script fails fast without built `dist/`, local tsx, process inspection, or
`/opt/homebrew/bin/opencode` (this Mac has 1.18.34). It runs the worktree's built
CLI through a temporary login-shell profile and launcher. Python 3 at
`/usr/bin/python3` supplies numeric session IDs. The check uses a private
HOME, project, config directory, free loopback ports, and a unique
`dev.conduit.test.*` label. Guards run before any launchctl call, including
cleanup. The real service, port 2633, credentials and config are never used.
No sudo, Docker, SDK substitutions or live-service changes are needed.

The Claude SDK uses the temporary `.claude/settings.json`, a dummy API key and
the Linux test's shared Messages mock. Each stream has 40 deltas, one per second,
ending with `Conduit runtime survival verified.` Marked scenario turns hold
the open stream after three deltas until the driver writes
`<marker>.release` in the shared artifacts directory. Unmarked streams run
without holding. The driver shares project,
session, history and fresh PTY-subscription checks with the Linux driver through
`../service-runtime/driver.ts`. Platform files own service commands, process
inspection and scenario order. The Linux scenarios and negative control retain
their existing behavior.

- **A:** `launchctl kickstart -k gui/<uid>/<label>` during an active turn and
  counter replaces the server while the runner, PTY host and counter survive.
- **B:** SIGKILL of the server exercises launchd KeepAlive with the same checks.
- **C:** `conduit service install` over the existing job exercises bootout and
  bootstrap, again with an active turn and counter.
- **D:** uninstall with a new active turn, counter, PTY host, real managed
  OpenCode and its supervisor. Every process must exit, the plist must disappear,
  and `launchctl print` must report the label absent. A process observer runs
  during the Shutdown RPC and CLI wait, then for at least 15 seconds after all
  recorded owners exit. A replacement server during uninstall fails the check,
  even if it exits before the uninstall command returns. The launcher also
  records every server start synchronously, so a brief respawn between process
  samples fails too. Surviving descendants
  or a server that reappears also fail it.

A, B and C require a completed transcript read back through history RPC and a
fresh PTY subscription containing ticks from before and after the disruption.
Each disruption must start while the marked stream is held. The driver releases
it after reconnection and owner checks, then requires that same stream to finish.
Mock logs record `held` and `released`; driver evidence records the release
request. Driver failure and timeout cleanup release pending markers without
waiting for streams, and a disconnected client clears its mock timer.
Evidence records PID plus
`ps -o lstart=` start time, PGID and numeric SID (`os.getsid`). A reused PID
cannot satisfy the identity check. Runtime owners must sit outside the job's
process group.

The negative control is a plain sleep child started by the temporary launcher
before it executes the server. It must share the server's process group and
must die during A. This checks launchd's group cleanup without changing
KeepAlive, AbandonProcessGroup or how production runtime owners detach.

The EXIT trap boots out only this run's exact label and signals only recorded
PID/start-time pairs. Process ownership comes from the private Claude argument,
temporary cwd, or descent from a recorded owner; global process environments
are never saved. Failed runs retain their temporary directory for diagnosis.
The driver has a ten-minute deadline and shorter operation deadlines.

Every run prints PASS or FAIL and an absolute artifact path under
`artifacts/<UTC timestamp>-<PID>/`, containing:

- `result.json`, `evidence.jsonl`, process identity and isolation records;
- A/B/C transcripts and PTY scrollback before and after each disruption;
- `driver.log`, `mock-server.log`, `mock-requests.jsonl`, service-install log;
- the generated plist, service stdout/stderr, runner, PTY and OpenCode logs,
  plus cleanup logs.

Static checks do not install a job:

```sh
for script in test/e2e/{linux-service,macos-service}/*.sh; do bash -n "$script" || exit; done
node --check test/e2e/linux-service/mock-anthropic.mjs
eval "$(mise env -s bash)"
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm exec tsgo --noEmit --pretty false
pnpm exec vitest run test/unit/cli/cli-service.test.ts
```

The process-group control follows the Mac's `launchd.plist(5)` documentation for
AbandonProcessGroup; `launchctl(1)` defines kickstart, bootstrap and bootout.
Apple's [ps field definitions](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/keyword.c)
map `sess` to a kernel pointer, so it cannot supply the numeric SID.
