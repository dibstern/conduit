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
| Persistence | `src/lib/persistence/*`, `src/lib/domain/persistence/*` | SQLite event store, projectors (sessions, messages, turns, providers, approvals), migrations |
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
| Relay composition | Each relay requires the daemon's `ProviderAdapters` registry and combines project-owned session services, event pipeline modules, `WebSocketHandler`, pollers, PTY wiring, and permission/question handling. Relays never construct, recover or shut down driver adapters. |
| Source of truth | Durable conversation state lives in conduit's SQLite event store. Provider instances are stateless execution engines that stream events into the store. |
| Relay-owned state | Project services, provider activity and client subscriptions borrow the daemon store. Projectors maintain materialized views from the append-only event log. |
| Daemon-owned state | The config directory holds the protected local RPC socket, daemon config, recent projects, push settings, and all project history in one daemon store at `<configDir>/events.db`. Relays borrow this store for their lifetime. |
| Frontend delivery | Frontend assets are built separately with Vite and served as static files by the relay server. |

Before relays start, offline startup migration imports registered and retained per-project stores from `<configDir>/projects/<slug>/events.db`, including legacy `<project>/.conduit/events.db` sources. Runtime `SaveProject` registration prepares and imports its primary folder's history before publishing the project or opening its relay. It reserves the live store's SQL connection without starting a transaction while the importer commits through its own connection. The importer normalizes private copies, commits history to the daemon store, and archives the sources as described in [ADR-0006](../adr/0006-daemon-store-import-normalises-copies-and-keeps-the-first-owner.md). A failed preparation or import makes only its project unavailable until restart retries it; committed imports with backup-only failures remain usable, as specified in [ADR-0008](../adr/0008-a-failed-import-blocks-its-project-and-removed-history-stays-hidden.md).
Each project storage directory retains its main folder in `project.json`, so re-adding that folder reuses its inactive slug and history, while other folders reserve occupied or unowned storage slugs. Removing a project disposes its relay and retains its rows in the daemon store; the history stays hidden until the project is registered again.

`SessionDirectory` exposes only `projectOf(sessionId)`. The daemon queries `sessions.project_id` in the shared store at lookup time and returns an owner only while that project is registered. Session IDs are primary keys, so each stored session has one owner. Standalone test fixtures supply an adapter owner and share its store; their WebSocket routing resolves only rows whose `project_id` matches the relay slug.

Read-model subscribers detect dropped advance publications after a bus overflow.
Catch-up sources read a shared window through the newest queued advance, including
unrouted advances, and send row deltas plus durable tombstones. They replace the
view with a snapshot only when tombstones cannot cover the cursor or the source
requires a rebase. `CONDUIT_TEST_ADVANCE_BUS_CAPACITY` changes only the advances
buffer capacity, and only with `NODE_ENV=test`.
Detail windows include message and part removals retained across message
recreation, so overflowing open session views catch up with deltas. Ordinary
detail resumes keep their existing policy.

## Effect Ownership Guardrails

- The codebase runs on Effect 4, pinned to an exact `effect` version. RPC, SQL, HTTP and socket modules come from `effect/*` subpaths; only platform-node and opentelemetry remain separate `@effect/*` packages.
- Daemon and relay internals should be owned by scoped Effect Layers and services. Do not add app-internal `Effect.runPromise`, `Effect.runSync`, `Runtime.runPromise`, `Runtime.runSync`, or object `.runPromise` / `.runSync` calls.
- The surviving runtime boundaries are explicit compatibility edges: standalone HTTP handler construction, OpenCode SDK fetch, Claude SDK permission callback, frontend transport Promise API, and the public `createProjectRelay()` startup Promise API.
- `relay-stack.ts` must not regain `Layer.succeed(Tag, alreadyConstructedInstance)` bridge composition. Relay state belongs in self-constructing domain Layers under `src/lib/domain/relay/*`.
- CLI commands use the same `WsRpcGroup` and daemon handlers over a filesystem-protected Unix socket with NDJSON framing. Browser PIN authentication remains required on network WebSockets.
- Browser real-time transport remains WebSocket-based. Effect RPC runs over the WebSocket protocol for migrated browser operations; raw PTY input remains the terminal data-plane path.

## Short-lived subprocesses

`Subprocess` is an Effect `Context.Reference` with one shared default owner.
`makeDaemonLive` supplies a scoped override, shared by its project relays.
Standalone callers use the default; tests can supply an isolated owner.
`run(command, args, { cwd, timeoutMs, key?, priority? })` returns an Effect with
`stdout`, `stderr`, and `exitCode`. Nonzero exit codes are results; spawn,
timeout, signal, output-limit and owner-shutdown failures are typed
`SubprocessError`s. Commands share four slots. Queued interactive commands run
before background commands, with FIFO ordering within each priority. Keys share
only pending work, and cancelling one waiter leaves other waiters intact.

Session git belongs to one daemon module, exposed by
`domain/daemon/Services/session-git.ts`. Its interface is `read(sessionId)`,
`changes`, and `invalidate(target)`. Canonical folder keys share git reads across
sessions and projects. Viewed folders refresh every 5 seconds and running
folders every 15 seconds. Listed folders older than 30 seconds get a safety-net
refresh for changes outside the probe targets, at most one every 20 seconds daemon-wide,
oldest first, so idle cost does not grow with listed sessions; dormant folders
refresh on hints. Reads only refresh a folder that was never published. Hints
have a two-second leading/trailing throttle. Viewed folders can read at that
throttle; other tiers retain their cadence. Tool results request a hint without
refreshing lineage.
Run ends, presence changes and ref changes force a refresh; a worktree's ref
changes are its own branch and the default branches, not other worktrees'. One
scoped daemon fiber probes directories sequentially using async stat calls, every
500 ms viewed, 1 second running, 5 seconds listed and 10 seconds dormant. Targets
are the checkout directory, HEAD, index, packed-refs in the git and common
directories, and exact loose refs for the current branch, main and master.
HEAD changes update the branch target, including nested branch names. Stat
changes to HEAD and refs trigger async content comparisons before forcing a
read; index and checkout-directory changes are hints. A hinted folder's presence
is checked once per hint, before the scheduler reads the clock. Releasing an
owner drops its probe targets and interrupts in-flight work without waiting for
native filesystem requests. Directory and session membership use `OwnerScopes`;
commands use the shared Subprocess owner at background priority.

Readers consume `session_git_published` in the same SQL snapshot as the session
row. Git, missing-workspace recovery state and session/sidebar versions commit
together. RPC list reads serve the publication, including absence, and leave
membership and refresh scheduling to the daemon coordinator. A first non-RPC
read may await publication. Canonical folder identities are memoized; the owner
forgets them on presence changes. Project rows have folder identities rather than
session IDs, so they read the same published SQL view directly. Repository
identity discovery runs during registration and save, not project-list reads.

Read RPC dispatch supplies `ReadRequest`, an Effect 4 `Context.Reference` inherited
by request fibers. The owner warns at most once per minute when reads request
commands. `CONDUIT_STRICT_READ_SPAWN=1` turns this into a defect. The legacy
Promise runner also rejects before enqueueing; session git's existing best-effort
catches still return no git state. Strict mode remains opt-in while existing
read paths still refresh git state.

`Subprocess.metrics` returns a JSON-serializable snapshot of spawn counts and
cumulative wall and synchronous spawn time, globally and by command, plus active,
queued and peak active counts. Snapshots also publish on the Node diagnostics
channel `conduit:subprocess-metrics` when commands finish. Synchronous spawn time
measures only time spent calling Node's `spawn`; wall time excludes queueing and
ends after the child closes. The idle-budget E2E can subscribe before daemon
startup and retain the last snapshot. Worker-thread hosting is deferred until
that representative E2E measures the remaining main-thread cost after the
session-git changes. Short-command tests alone do not settle that decision.

`scripts/check-subprocess-boundary.mjs`, run by `pnpm lint:rules`, restricts direct
child-process imports to the owner and explicit long-lived process owners. Its
separate list of remaining one-shot callers must only shrink.

## PTY lifetime

Local terminals belong to a detached per-user PTY host, not the server. The host
entrypoint is `src/bin/pty-host.ts`, emitted by the server build as
`dist/src/bin/pty-host.js`. It imports the same stamped build ID as the server.
`LocalPtyServiceLive` connects lazily and starts the host when creating the first
terminal. Each project discovers its terminals by their owning project folder,
recorded separately from their start cwd so session worktree terminals remain
discoverable after a move or restart. Legacy creates use cwd as the owning folder.
Hosts advertise support for a separate owning folder. A retained older host can
continue serving its terminals and creating terminals in the project folder;
worktree creates fail before spawning until that host is restarted.
The relay attaches to a snapshot
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

## OpenCode lifecycle

The daemon-level OpenCode Instances module
(`src/lib/domain/daemon/Layers/opencode-instances-layer.ts`) owns each
instance's lifetime. Managed OpenCode starts lazily on the first `use` (a user
action such as creating a session, sending, or answering a prompt) through one
shared start. Background paths (pollers, startup) use the non-starting
`ifRunning` client and never start it. Start Instance is a `use` with an empty
scope.

An instance has demand while a `use` scope is open, or while OpenCode reports a
busy or retrying session, or a pending permission or question, in any
subscribed directory. The module derives this from its shared event stream and
reconcile results; nothing registers holds and no Conduit projection is read.
The stream is open exactly while there is demand or a grace timer runs.

An open OpenCode draft retains a scoped `borrow` through `SubscribeDraftModels`.
It starts the selected instance and refreshes that instance's catalog on every
connection, without binding a project or creating a session. Switching harness,
closing or sending the draft, or disconnecting the browser releases its hold.
The same instance owner stops a server started exclusively for inventory 30
seconds after its last hold releases. A real `use` or observed session activity
permanently returns that start to the ordinary idle policy. A server already
running when borrowed keeps the ordinary policy too. Instance aliases resolve
to one registered identity before demand is counted. A borrow released during
startup still arms grace when the shared start finishes.

`GetModels.defaultOpenCodeInstanceId` identifies the project's configured
OpenCode instance for initial draft selection, including a named instance beside
the lazy Default. The browser waits for the instance and default snapshots before
holding an initial pick. Draft inventory errors surface even when an older
in-memory catalog exists; passive discovery retains its cached fallback.

`CONDUIT_TEST_OPENCODE_BORROW_IDLE_TIMEOUT_MS` is a test-only positive integer
millisecond override for that 30-second inventory grace. It leaves
`CONDUIT_OPENCODE_IDLE_TIMEOUT_MS` unchanged. The process harness exposes it as
`opencodeBorrowIdleTimeoutMs`; the draft borrow guards use 1,000 milliseconds.

When demand reaches zero a grace timer arms (10 minutes;
`CONDUIT_OPENCODE_IDLE_TIMEOUT_MS` overrides it). New demand cancels it. On
expiry the connect-time reconcile runs again, so a missed busy event is caught,
and the instance stops only if demand is still zero. While a session is busy
the reconciler polls `/session/status`, so a missed idle event only delays the
stop. An idle stop closes the stream, then terminates a managed instance's
process group; external instances only lose their stream. A `use` during a stop
waits for it, then starts again. Stop Instance stops regardless of demand.

`SIGINT`, `SIGTERM` and restart RPC leave managed OpenCode running. The next
server re-adopts it and reconciles; with no demand its grace timer arms.
`conduit stop` terminates it.

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
It also runs Vite, proxied to that server, for instant UI hot reload.
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

The sidebar Scope is one project selected by `?p=<slug>`, or all projects when
`p` is absent. Search, paging and live rows filter by project slug. Project
arrangement shows one heading per project using its title, even when projects
share Repository Identity. Identity belongs to folders and remains visible in
the project dialog. Project Groups and their settings have retired; old group
scope URLs are replaced with an unscoped URL at the router boundary. Existing
configuration ignores retired settings and drops them on the next save.

## Provider Runtime Notes

- `ProviderAdapters` owns one Claude, OpenCode and Cursor adapter for the daemon's lifetime. `DaemonOrchestration` owns one engine, command read model, reactor and outbox drain for every project. Commands resolve their project through `SessionDirectory`; streamed output and interactions use the current project services lent through `ProviderAdapters.registerProject`. Recovery relays finish startup and the shared adapter recovery pass before the daemon drain starts. Replacement relays borrow the same engine and reattach only their own retained sessions. Registered projects awaiting a relay keep their commands pending without an attempt; explicitly unavailable projects receive durable `project_unavailable` refusals, and removed projects receive `project_inactive`. Runtime relay registration prepares imported controls only for that project's rows, preserving other projects' live claims. While a save holds the existing project save lock, imported rows awaiting registry publication also stay pending; control refusal uses registration truth rather than the sidebar's filtered project list. Unstarted refused sends persist their failed user message and error atomically with the refusal. Claimed intake counts as started even before its start projection; unavailable projects retain it for recovery, while removal retires the verified session runner before cancelling its command. Runners awaiting project services keep their output unacknowledged until reattachment. Run ownership admits one terminal per run; later Claude background message accounting uses nonterminal `message.completed` events. Standalone relays keep their own engine and drain. Project disposal releases adapter attachments; daemon shutdown closes the shared engine and adapters.
- Adapter constructors take daemon services and SDK dependencies, never a project folder, extra folders or shell environment. Session launches and project discovery receive an explicit `ProviderCall`. It carries the project and session IDs, admitted account, effective workspace root, extra folders and frozen shell environment. The shared engine resolves these fields before adapter entry; durable commands re-resolve environment values rather than storing credentials. Account-scoped one-shot text generation uses its selected account and an isolated scratch folder.
- Account resources have a separate lifetime from adapters and sessions. `AccountResourceScopes` lazily shares one resource per exact account ID and generation. Concurrent callers join the same open; invalidation interrupts that account's work and waits for its resource to close. A later open gets a new generation. Turns, pending prompts and background work hold demand through `use`; idle resources close after grace. Cursor uses these scopes for its SDK credential stores. OpenCode's account servers belong to `OpenCodeInstances`, whose scoped `use` is the adapter's only client route. Removing an account leaves other account resources and the three adapters alive.
- `AccountDirectory` resolves Claude login folders when loading and changing accounts. Relative folders use the daemon's launch cwd; `~` and `~/` use its home. An account without a configured folder keeps the captured launch login and its SDK-default or configured kind. The original configured spelling remains in persisted settings. Runs, discovery and scratch text generation receive the same absolute account folder, regardless of project or query cwd. The legacy config resolver uses the same rule.
- Session-owned provider state remains in the event store when account resources close. Claude query rebinding and Claude account-scope adoption are separate migration slices, 82tn.9.3 and 82tn.9.4. The current driver contract exposes cross-account native continuation only for Claude; Cursor and OpenCode reject `ContinueSession`. The process proof records that limitation explicitly.
- Do not assume a fixed OpenCode HTTP server or debug port. Managed OpenCode test instances can run on dynamic ports, and the active base URL should come from daemon/project config, logs, or test output.
- OpenCode integration goes through the OpenCode SDK/API client in `src/lib/instance/*` and `src/lib/provider/opencode-provider-instance.ts`.
- Claude integration goes through the Claude Agent SDK provider instance in `src/lib/provider/claude/*`; Claude flows normally expose SDK events rather than a separate localhost debug server.
- The SQLite event store is the durable handoff between provider instances and browser clients. Provider instances should not become another source of UI state.
