# Architecture Guide

Use this guide before changing daemon behavior, project routing, relay wiring, event store, projectors, provider instances, session flow, instance management, or PTY behavior.

## Runtime Shape

| Area | Shape |
|---|---|
| CLI | `src/bin/cli.ts` is the thin entrypoint; `src/bin/cli-core.ts` routes commands. |
| Process model | `conduit serve` runs the server in the foreground. Other CLI commands use browser RPC over a protected Unix socket. `conduit service install` optionally keeps it running through launchd or systemd. |
| Daemon | Daemon lifecycle is owned by Effect domain services/layers under `src/lib/domain/daemon/*`, with low-level socket/server helpers in `src/lib/daemon/*`. `serve` enters through the Effect-backed foreground starter. |
| Multi-project model | One daemon can host many projects, each mounted under `/p/<slug>`. |

## System Context Diagram

Mermaid Diagram: docs/agent-guide/system-context-diagram.mermaid

## Main Layers

| Layer | Main modules | Responsibility |
|---|---|---|
| CLI / control | `src/bin/*`, `src/lib/cli/*` | Operator-facing commands, setup, watcher, TLS helpers |
| Daemon | `src/lib/daemon/*`, `src/lib/domain/daemon/*` | Process lifecycle, persisted state, local RPC, project and instance registration |
| HTTP / WS edge | `src/lib/server/*` | Shared HTTP server, auth gate, static assets, project route dispatch, WebSocket upgrades |
| Project relay | `src/lib/relay/*`, `src/lib/domain/relay/*` | Per-project relay composition, provider event ingestion, event translation, pollers, PTY upstreams |
| Persistence | `src/lib/persistence/*`, `src/lib/domain/persistence/*` | SQLite event store, projectors (sessions, messages, turns, providers, approvals, activities), migrations |
| Provider instances | `src/lib/provider/*` | Stateless execution engines (OpenCode, Claude Agent SDK) that stream events into the event store |
| Session domain | `src/lib/session/*` | Active session tracking, history paging, status polling, client-to-session registry |
| OpenCode instances | `src/lib/instance/*` | Managed and unmanaged OpenCode SDK/API runtimes, health checks, URL resolution, spawn/stop |
| Browser handlers | `src/lib/handlers/*` | Message-type dispatch into session, prompt, model, file, terminal, and instance actions |
| Contracts | `src/lib/contracts/*` | Implementation-free shared schemas and protocol declarations |
| Frontend SPA | `src/lib/frontend/*` | Svelte 5 app served by the relay |

## Per-Project Relay Flow Diagram

Mermaid diagram: docs/agent-guide/per-project-relay-flow-diagram.mermaid

## Key Boundaries

`src/lib/relay/relay-stack.ts` builds each project relay with `createProjectRelay()`.

| Boundary | Meaning |
|---|---|
| Relay composition | Each relay combines provider instances, session services, event pipeline modules, `WebSocketHandler`, pollers, PTY wiring, and permission/question handling. Legacy relay composition still has bridge layers while the Effect migration is in progress. |
| Source of truth | Durable conversation state lives in conduit's SQLite event store. Provider instances are stateless execution engines that stream events into the store. |
| Relay-owned state | The event store and its projections (sessions, messages, turns, providers, approvals, activities) are the primary record. Projectors maintain materialized views from the append-only event log. |
| Daemon-owned state | The config directory holds the protected local RPC socket, daemon config, recent projects, push settings, and project history at `<configDir>/projects/<slug>/events.db`. |
| Frontend delivery | Frontend assets are built separately with Vite and served as static files by the relay server. |

Before relays start, a one-time migration checkpoints and copies legacy `<project>/.conduit/events.db` stores, verifies each copy, and archives the originals as `events.db.migrated`; failed copies keep using the legacy store and retry on the next startup.
Each storage directory records its main folder in `project.json`, so re-adding that folder reuses its inactive slug and history, while other folders reserve occupied or unowned storage slugs; removing a project keeps its history.

## Effect Ownership Guardrails

- Daemon and relay internals should be owned by scoped Effect Layers and services. Do not add app-internal `Effect.runPromise`, `Effect.runSync`, `Runtime.runPromise`, `Runtime.runSync`, or object `.runPromise` / `.runSync` calls.
- The surviving runtime boundaries are explicit compatibility edges: standalone HTTP handler construction, OpenCode SDK fetch, Claude SDK permission callback, frontend transport Promise API, and the public `createProjectRelay()` startup Promise API.
- `relay-stack.ts` must not regain `Layer.succeed(Tag, alreadyConstructedInstance)` bridge composition. Relay state belongs in self-constructing domain Layers under `src/lib/domain/relay/*`.
- CLI commands use the same `WsRpcGroup` and daemon handlers over a filesystem-protected Unix socket with NDJSON framing. Browser PIN authentication remains required on network WebSockets.
- Browser real-time transport remains WebSocket-based. Effect RPC runs over the WebSocket protocol for migrated browser operations; raw PTY input remains the terminal data-plane path.

## PTY lifetime

Local terminals belong to a detached per-user PTY host, not the server. The host
entrypoint is `src/bin/pty-host.ts`, emitted by the server build as
`dist/src/bin/pty-host.js`. It imports the same stamped build ID as the server.
`LocalPtyServiceLive` connects lazily and starts the host when creating the first
terminal. Each project discovers its terminals by cwd and attaches to a snapshot
of up to 50 KiB of UTF-8 scrollback followed by live output. Replay uses
`pty_output` with `replace: true`, including empty history, so the browser resets
its buffer and renderer before accepting live output. Replacing a disconnected
proxy resynchronizes browsers already attached to that terminal. A lost host
connection emits `pty_exited`; the next host list removes missing terminals with
`pty_deleted`. Replacement replay for a confirmed running local terminal carries
`restored: true`, allowing the browser to clear its exit flag. Ordinary lists
preserve exit flags, including when an older RPC response arrives after an exit
event. Unavailable input returns a `PTY_INPUT_FAILED` system error. Relay shutdown
detaches its proxies; it does not kill hosted shells.

Discovery errors preserve cached tabs until a successful host list or confirmed
socket absence. Closing a disconnected or undiscovered terminal first discovers
and closes the surviving hosted shell. Close and restore share a lock so a pending
attach cannot reintroduce a closed terminal.

The protected `pty.sock` and `pty-host.log` live in the Conduit
config directory, respecting `CONDUIT_CONFIG_DIR`. An atomic directory election
and a generation-specific socket ensure one host.
`pty.sock` points to that generation's socket. Paths exceeding macOS's 103 usable
socket-path bytes use a persistent user-owned hashed symlink under `/tmp` to the
config directory, budgeting for the private UUID socket too. IPC paths use
private permissions while PTY shells retain the inherited umask. The host uses
versioned NDJSON over the socket and
refuses incompatible protocol versions. A different build is replaced only if
the host atomically confirms that no terminal tabs remain, including exited tabs
with saved scrollback. Otherwise the compatible old host stays alive and the
server logs the mismatch.

`SIGINT`, `SIGTERM`, and restart RPC leave live terminals running. `conduit stop`
terminates all hosted terminals and the host. A host with no live
terminals and no connected clients exits after 30 seconds; set
`CONDUIT_PTY_HOST_IDLE_TIMEOUT_MS` to a positive timeout in milliseconds to change
the grace period. Saved exited tabs can expire with an idle host. A live terminal
keeps its host running through server downtime. Test harnesses explicitly stop
their own hosts before removing temporary configuration directories. To kill
all hosted terminals and stop the host, run
`node dist/src/bin/pty-host.js stop`. To force a host upgrade, killing its
terminals, run `node dist/src/bin/pty-host.js restart`. These commands use the
same config-directory environment override as the server. Ordinary server
restarts never require them. The NDJSON `hello`/`stop`/`stopped` control envelope
must remain stable across protocol versions: explicit forced control may retry
once with the reported host version, without exposing an incompatible terminal
connection or signaling a PID. Incompatible control framing fails safely.

## Communication Flow

| Flow | Path |
|---|---|
| Browser to relay | Browser loads the SPA over HTTP, `RequestRouter` serves auth/setup/health/info/themes/project routes, the daemon upgrades `/ws` and attaches sockets to relay `WebSocketHandler`s, and `src/lib/handlers/index.ts` dispatches incoming message types to session, instance, file, terminal, and bridge services. |
| Provider to event store to browser | Provider instances stream events into the SQLite event store. Projectors update materialized views (sessions, messages, turns). Pollers reconcile provider-side status. `WebSocketHandler` broadcasts normalized events to relevant clients or session viewers. |
| CLI to daemon | Commands such as `status`, `stop`, `AddProject`, and `SetPin` use the browser RPC contract over the protected Unix socket; the daemon updates config and registries, mounts new relays on the shared HTTP and WebSocket surface, and rebroadcasts instance status changes. |

## Running the server

Start `conduit serve` in a terminal, or use `conduit service install` for an
optional login service. New service units run `conduit serve` through the login
shell. The hidden `--foreground` alias keeps older units working.

The server owns the HTTP/WS edge, project registry, config persistence, event
store writes and projections, outbox and reactor, attachment to Claude runners,
and supervision of the PTY host and managed OpenCode. Claude runners own their
lifetime; relay disposal detaches started runners and stops unfinished spawns.
Explicit full stop and project
removal terminate registered runners after relay disposal. The server refuses
an occupied configured port before acquiring runtime resources.

`pnpm dev:all` rebuilds on save and restarts the running Conduit while sessions
keep running. It drives an existing supervised service, or owns a foreground
child when no service returns after restart. Ctrl-C stops that child and leaves
an existing service running. Failed builds leave the current server running.
Use `pnpm dev:frontend` for instant UI hot reload against the running server.
For a child server, pass options with `pnpm dev:all -- --port 2700`.

`SIGINT` and `SIGTERM` flush config and dispose the server while preserving
independent runners, terminals and managed OpenCode for re-adoption. The process
exits 0 after shutdown; a second `SIGINT` exits immediately. `conduit stop` uses
RPC for a full stop of the server and those processes. With no server it exits 0.

Bare `conduit` registers the current project over RPC and prints its URL. When
the server is unavailable it prints guidance to run `conduit serve` or
`conduit service install` and exits 1.

## Browser Routes

Browser session addresses are `/s/<id>`; `/` opens the session list without
selecting or creating a session. `/?p=<slug>` hints which project to attach.
The daemon accepts browser sockets only at `/ws` and `/rpc`, including query
strings. The `/ws` socket follows explicit session navigation, with `?p=<slug>`
as an initial project hint. Relays receive attached sockets and never handle
browser upgrades. The test-only relay server also owns its `/ws` upgrade and
preserves default-session bootstrap when attaching to its initial relay.

`GET /api/projects` remains only as a liveness probe, used by
`test/integration/flows/daemon-lifecycle.integration.ts`,
`test/unit/effect/http-router-layer.test.ts`, and the router/server tests under
`test/unit/server/`. Browser project lists and project removal use daemon RPC.
The dashboard's `DELETE /api/projects/:slug` endpoint has been removed.

## Provider Runtime Notes

- Do not assume a fixed OpenCode HTTP server or debug port. Managed OpenCode test instances can run on dynamic ports, and the active base URL should come from daemon/project config, logs, or test output.
- OpenCode integration goes through the OpenCode SDK/API client in `src/lib/instance/*` and `src/lib/provider/opencode-provider-instance.ts`.
- Claude integration goes through the Claude Agent SDK provider instance in `src/lib/provider/claude/*`; Claude flows normally expose SDK events rather than a separate localhost debug server.
- The SQLite event store is the durable handoff between provider instances and browser clients. Provider instances should not become another source of UI state.
