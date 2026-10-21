# Linux service runtime survival

Run from the repository root on Docker Desktop with cgroup v2:

```sh
bash test/e2e/linux-service/run.sh
```

The script builds Debian with Node 26.10.0, the repository's pnpm version and
matching OpenCode 1.19.1. It copies the current worktree without `.git`, host
dependencies, build output, local agent/config folders, or `.env` files, then
installs and builds inside Linux. No host directories, ports, credentials or
PID namespaces are shared. Images and containers use `conduit-m37913-` names.
The container is always removed at exit; its uniquely tagged image is retained
as a build cache. Repeated runs write separate artifact directories.

Systemd runs as PID 1 in a privileged container with a private cgroup namespace.
The init script verifies cgroup v2 and writable cgroups before starting systemd.
A non-root `conduit` user (UID 1001) has lingering enabled and uses its real
systemd user manager. The built CLI installs the generated service on container
port 27331. The test asserts `KillMode=process` in that generated unit.

The real Claude SDK and detached session runner use a local Messages API mock
through the user's `~/.claude/settings.json` environment block, including a
dummy API key. Streaming requests produce 40 text deltas, one per second,
ending with `Conduit runtime survival verified.` Marked scenario turns hold
the open stream after three deltas until the driver writes
`<marker>.release` in the shared artifacts directory. Unmarked streams run
without holding. Non-streaming requests return
a short message; other paths return a JSON 404. No SDK substitution, fixtures,
or loader hooks are injected into the server or runners. Only the driver is
executed with tsx, through `node node_modules/tsx/dist/cli.mjs`.

The driver uses production `sendRpcRequest` for project, session, input, history,
terminal and instance commands. It reads terminal scrollback with the browser's
`SubscribePtys` streaming RPC over the same protected IPC socket. It verifies:

- **A:** `systemctl --user restart conduit` during a real streaming turn changes
  the server PID while retaining the runner, PTY host and counter process
  identities. The completed transcript is read back through history RPC, and a
  fresh PTY subscription contains ticks from before and after the restart.
- **B:** SIGKILL of the server produces the same result through `Restart=on-failure`.
- **Negative control:** removing `KillMode`, reloading the unit and repeating A
  must kill the active runner. The original unit is restored in `finally`.
- **C:** a new active Claude turn, counter, PTY host and real managed OpenCode
  are present before `conduit service uninstall`. All their processes must exit,
  the unit file must disappear, and the service must stay inactive beyond its
  five-second restart delay.

PID evidence includes Linux process start times and cgroup membership, so a
reused PID cannot pass and the negative control must exercise the service's
actual cgroup. Each disruption starts while the marked stream is held. Survival
checks release it only after reconnection and owner checks, then require the
same stream to finish and persist its final sentence. Mock logs record `held`
and `released`; driver evidence records the release request. Driver cleanup
releases pending markers without waiting for the streams, and a disconnected
client clears its mock timer. The driver has a ten-minute outer timeout; individual
operations have shorter deadlines.

On success the host prints:

```text
PASS: Linux service runtime survival (restart, crash, uninstall, negative control).
Artifacts: /absolute/path/to/test/e2e/linux-service/artifacts/<UTC timestamp>-<PID>
```

On failure it prints the failing step, exit code and artifact path, followed by
the driver log tail when available. Required log collection or container cleanup
failures also fail the run. `artifacts/<run>/` contains:

- `result.json`, `evidence.jsonl` (PIDs before/after each step and transcripts),
  `A-transcript.txt`, `B-transcript.txt`, and PTY scrollback before/after A and B;
- `driver.log`, `mock-server.log`, `mock-requests.jsonl`, `service-install.log`,
  the original generated unit and all Conduit runtime log files;
- the user service journal, system journal, user-manager status, process table,
  Docker build/boot/inspect/log output, and collection/cleanup logs.

No Docker commands are needed for static validation:

```sh
for script in test/e2e/linux-service/*.sh; do bash -n "$script" || exit; done
node --check test/e2e/linux-service/mock-anthropic.mjs
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm exec tsgo --noEmit --pretty false
```

The container configuration follows [Docker's cgroup v2 documentation](https://docs.docker.com/engine/containers/runmetrics/)
and [systemd's container interface](https://systemd.io/CONTAINER_INTERFACE/).
The mock follows Anthropic's documented [Messages streaming event sequence](https://platform.claude.com/docs/en/build-with-claude/streaming).
