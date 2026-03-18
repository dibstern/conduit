# Architecture Guide

Use this guide before changing daemon behavior, project routing, relay wiring, SSE flow, session flow, instance management, or PTY behavior.

## Runtime Shape

| Area | Shape |
|---|---|
| CLI | `src/bin/cli.ts` is the thin entrypoint; `src/bin/cli-core.ts` routes commands. |
| Process model | The CLI either runs a relay in-process with `foreground` or controls a long-lived daemon over Unix socket IPC. |
| Daemon | `src/lib/daemon/daemon.ts` owns lifecycle, persisted config, the shared HTTP and IPC servers, project registration, and OpenCode instance management. |
| Multi-project model | One daemon can host many projects, each mounted under `/p/<slug>`. |

## System Context Diagram

Mermaid Diagram: docs/agent-guide/system-context-diagram.mermaid

## Main Layers

| Layer | Main modules | Responsibility |
|---|---|---|
| CLI / control | `src/bin/*`, `src/lib/cli/*` | Operator-facing commands, setup, watcher, TLS helpers |
| Daemon | `src/lib/daemon/*` | Process lifecycle, persisted state, IPC, project and instance registration |
| HTTP / WS edge | `src/lib/server/*` | Shared HTTP server, auth gate, static assets, project route dispatch, WebSocket upgrades |
| Project relay | `src/lib/relay/*` | OpenCode SSE consumption, event translation, message cache, pollers, PTY upstreams |
| Session domain | `src/lib/session/*` | Active session tracking, history paging, status polling, client-to-session registry |
| OpenCode instances | `src/lib/instance/*` | Managed and unmanaged OpenCode instances, health checks, URL resolution, spawn/stop |
| Browser handlers | `src/lib/handlers/*` | Message-type dispatch into session, prompt, model, file, terminal, and instance actions |
| Frontend SPA | `src/lib/frontend/*` | Svelte 5 app served by the relay |

## Per-Project Relay Flow Diagram

Mermaid diagram: docs/agent-guide/per-project-relay-flow-diagram.mermaid

## Key Boundaries

`src/lib/relay/relay-stack.ts` builds each project relay with `createProjectRelay()`.

| Boundary | Meaning |
|---|---|
| Relay composition | Each relay combines `OpenCodeClient`, `SessionManager`, `SSEConsumer`, event pipeline modules, `WebSocketHandler`, caches, pollers, PTY wiring, and permission/question bridges. |
| Source of truth | Durable conversation state lives in OpenCode, not relay-owned storage. |
| Relay-owned state | Per-project caches exist for responsiveness and recovery, not as the primary record. |
| Daemon-owned state | The config directory holds socket and PID files, daemon config, recent projects, push settings, and caches. |
| Frontend delivery | Frontend assets are built separately with Vite and served as static files by the relay server. |

## Communication Flow

| Flow | Path |
|---|---|
| Browser to relay | Browser loads the SPA over HTTP, `RequestRouter` serves auth/setup/health/info/themes/project routes, project WebSocket upgrades go to `WebSocketHandler`, and `src/lib/handlers/index.ts` dispatches incoming message types to session, instance, file, terminal, and bridge services. |
| OpenCode to relay to browser | Each project relay connects upstream through `SSEConsumer`, pipeline modules translate events, caches and pollers update relay-side view state, and `WebSocketHandler` broadcasts normalized events to relevant clients or session viewers. |
| CLI to daemon | Commands such as `status`, `stop`, `add_project`, and `set_pin` go over IPC; the daemon updates config and registries, mounts new relays on the shared HTTP and WebSocket surface, and rebroadcasts instance status changes. |