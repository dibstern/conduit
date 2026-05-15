# Architecture Guide

Use this guide before changing daemon behavior, project routing, relay wiring, event store, projectors, provider instances, session flow, instance management, or PTY behavior.

## Runtime Shape

| Area | Shape |
|---|---|
| CLI | `src/bin/cli.ts` is the thin entrypoint; `src/bin/cli-core.ts` routes commands. |
| Process model | The CLI either runs a relay in-process with `foreground` or controls a long-lived daemon over Unix socket IPC. |
| Daemon | Daemon lifecycle is owned by Effect domain services/layers under `src/lib/domain/daemon/*`, with low-level socket/server helpers still living in `src/lib/daemon/*`. CLI foreground and child-daemon startup enter through Effect-backed starter facades. |
| Multi-project model | One daemon can host many projects, each mounted under `/p/<slug>`. |

## System Context Diagram

Mermaid Diagram: docs/agent-guide/system-context-diagram.mermaid

## Main Layers

| Layer | Main modules | Responsibility |
|---|---|---|
| CLI / control | `src/bin/*`, `src/lib/cli/*` | Operator-facing commands, setup, watcher, TLS helpers |
| Daemon | `src/lib/daemon/*`, `src/lib/domain/daemon/*` | Process lifecycle, persisted state, IPC, project and instance registration |
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
| Daemon-owned state | The config directory holds socket and PID files, daemon config, recent projects, and push settings. |
| Frontend delivery | Frontend assets are built separately with Vite and served as static files by the relay server. |

## Effect Ownership Guardrails

- Daemon and relay internals should be owned by scoped Effect Layers and services. Do not add app-internal `Effect.runPromise`, `Effect.runSync`, `Runtime.runPromise`, `Runtime.runSync`, or object `.runPromise` / `.runSync` calls.
- The surviving runtime boundaries are explicit compatibility edges: standalone HTTP handler construction, OpenCode SDK fetch, Claude SDK permission callback, frontend transport Promise API, and the public `createProjectRelay()` startup Promise API.
- `relay-stack.ts` must not regain `Layer.succeed(Tag, alreadyConstructedInstance)` bridge composition. Relay state belongs in self-constructing domain Layers under `src/lib/domain/relay/*`.
- Browser real-time transport remains WebSocket-based. Effect RPC runs over the WebSocket protocol for migrated browser operations; raw PTY input remains the terminal data-plane path.

## Communication Flow

| Flow | Path |
|---|---|
| Browser to relay | Browser loads the SPA over HTTP, `RequestRouter` serves auth/setup/health/info/themes/project routes, project WebSocket upgrades go to `WebSocketHandler`, and `src/lib/handlers/index.ts` dispatches incoming message types to session, instance, file, terminal, and bridge services. |
| Provider to event store to browser | Provider instances stream events into the SQLite event store. Projectors update materialized views (sessions, messages, turns). Pollers reconcile provider-side status. `WebSocketHandler` broadcasts normalized events to relevant clients or session viewers. |
| CLI to daemon | Commands such as `status`, `stop`, `add_project`, and `set_pin` go over IPC; the daemon updates config and registries, mounts new relays on the shared HTTP and WebSocket surface, and rebroadcasts instance status changes. |

## Provider Runtime Notes

- Do not assume a fixed OpenCode HTTP server or debug port. Managed OpenCode test instances can run on dynamic ports, and the active base URL should come from daemon/project config, logs, or test output.
- OpenCode integration goes through the OpenCode SDK/API client in `src/lib/instance/*` and `src/lib/provider/opencode-provider-instance.ts`.
- Claude integration goes through the Claude Agent SDK provider instance in `src/lib/provider/claude/*`; Claude flows normally expose SDK events rather than a separate localhost debug server.
- The SQLite event store is the durable handoff between provider instances and browser clients. Provider instances should not become another source of UI state.
