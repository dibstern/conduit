# ADR-0012: The runtime split already exists; the thin daemon means retiring per-project relays

- Status: accepted
- Date: 2026-10-18
- Context: epic conduit-test-m379, bead conduit-test-m379.12

## Context

Epic conduit-test-m379 asks for a thin daemon that handles agent processes and
other long-running processes, with the server as a regular node service.

Most of that split has shipped:

- Claude and Cursor turns run in detached per-session runners. A runner keeps
  working when `conduit serve` stops, holds its output, and is adopted again at
  startup; the server replays from its last persisted acknowledgement.
- Terminals live in a detached per-user PTY host. The server only holds
  proxies, and reattaching restores up to 50 KiB of scrollback.
- Managed OpenCode servers run under a detached supervisor and are adopted
  again at startup.
- `conduit serve` is the server: HTTP and WebSocket, the CLI socket, the
  SQLite store and its projectors, pollers and sweeps. It is the only SQLite
  writer. `conduit service install` runs it under launchd
  `KeepAlive.SuccessfulExit=false` or systemd `Restart=on-failure`. A full
  Shutdown exits 0 and stays stopped, so uninstall cannot race a respawn; a
  supervised restart or handled signal exits 75 and is restarted with its
  runtime owners intact. Units written before this need one
  `conduit service install` before uninstall is race-free.
- SIGINT, SIGTERM and a restart leave runners, the PTY host and OpenCode
  running. Only an explicit full stop ends them.

What is not split is the session runtime inside the server: every project
still gets its own relay, welded to one folder, and the browser still attaches
to a project.

t3code (16918b57) runs one server process. A restart kills running turns and
terminals; its service launcher adds readiness checks and a SQLite backup with
rollback, and after a restart it sends a "continue where you left off" turn.

## Decision

**The detached runtime owners are the thin daemon, and `conduit serve` is the
regular node service.** No new supervisor process is added, and the server
stays the only SQLite writer.

**The main missing piece is retiring per-project relays**, tracked by epic
conduit-test-82tn: one daemon orchestrator, and each session resolves its own
working directory. Epic conduit-test-m379 depends on it.

**The service units must let the runtime owners survive the server.**

- Linux: the generated systemd unit uses the default `KillMode=control-group`,
  so stopping, restarting or crashing the service kills every runner, the PTY
  host and OpenCode in its control group. It needs `KillMode=process`.
- macOS: launchd kills the job's process group, and the detached owners start
  their own, so they should survive. Restart, reinstall and crash are untested.

Rejected:

- A supervisor that owns the runtimes and proxies their traffic to the server.
  It adds a streaming hop for agent output and terminal bytes, and the
  supervisor gets its own upgrade problem, while today's direct connections
  already survive a server restart.
- A supervisor that also owns the store, leaving the server a stateless edge.
  The "thin" supervisor becomes the application core, and its schema
  migrations and upgrades are the same problem moved.

## Consequences

- Once the units are fixed, restarting or upgrading the server keeps turns and
  terminals running, which t3code cannot do.
- While the server is down, event ingestion, the shell feed, sweeps and push
  notifications pause, and browsers reconnect when it returns.
- A runner keeps unacknowledged output in memory, so a runner and the server
  dying together can lose output that was never committed.
