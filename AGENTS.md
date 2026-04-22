# AGENTS.md

The opencode instance at localhost:4096 is running and accessible.
NEVER stash changes, you are interrupting other sessions and work. 

## Purpose

`conduit` is a web UI orchestrator for AI coding assistants. It lets one long-lived daemon expose sessions to browser clients across multiple projects. Provider adapters (OpenCode, Claude Agent SDK) are stateless execution engines that stream events into conduit's SQLite event store.

## Architecture At A Glance

- `src/bin/cli.ts` is the thin CLI entrypoint; `src/bin/cli-core.ts` routes commands.
- The CLI either runs a relay in-process with `foreground` or manages a long-lived `Daemon` over Unix socket IPC.
- `src/lib/daemon/daemon.ts` owns process lifecycle, persisted config, the shared HTTP and IPC servers, project registration, and the OpenCode instance registry.
- One daemon can host many projects. Each project gets its own relay stack mounted under `/p/<slug>`.
- `src/lib/relay/relay-stack.ts` builds the per-project relay around `OpenCodeClient`, `SessionManager`, `SSEConsumer`, `WebSocketHandler`, pollers, and PTY wiring.
- `src/lib/server/*` handles the shared HTTP and WebSocket edge; `src/lib/handlers/*` dispatch browser messages into focused domain handlers.
- The SQLite event store is the source of truth for sessions and messages. Provider adapters are stateless execution engines that stream events into the store.

Read `docs/agent-guide/architecture.md` before changing daemon behavior, project routing, relay wiring, event store, projectors, provider adapters, session flow, instance management, or PTY behavior.

## Source Map

- `src/bin/`: CLI entrypoints.
- `src/lib/daemon/`: daemon lifecycle, IPC,  config persistence, projects.
- `src/lib/server/`: HTTP and WebSocket server, router, static files, push.
- `src/lib/relay/`: OpenCode event pipeline, pollers, PTY upstream wiring.
- `src/lib/persistence/`: SQLite event store, projectors, migrations.
- `src/lib/provider/`: Provider adapters (OpenCode, Claude SDK).
- `src/lib/session/`: session orchestration and status polling.
- `src/lib/instance/`: OpenCode instance management and client access.
- `src/lib/handlers/`: browser message handlers.
- `src/lib/frontend/`: Svelte 5 SPA.
- `docs/plans/`: design and implementation records. Check here before changing behavior that may already be planned or explained.

## Verification

Default verification path for most changes:

```bash
pnpm check
pnpm lint
pnpm test:unit
# Needs to be logged since the output is large and gets truncated.
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

Read `docs/agent-guide/testing.md` before choosing broader verification. Use the narrowest integration, E2E, daemon, multi-instance, or visual command that matches the changed surface.

## Deeper Docs

- `docs/agent-guide/architecture.md`: deeper runtime architecture and request or event flow.
- `docs/agent-guide/testing.md`: verification selection guidance and targeted commands.
- `docs/plans/`: historical design and implementation context for features and refactors.

## Development Tips

- When writing frontend code, default to the standard Svelte 5 best practice and patterns.

## Troubleshooting Tips

- Local conduit: It runs at `http://localhost:2633/`.
- Local opencode instance Debug: You can hit the local instance of opencode, running on port 4096, using:
    - Authorized: `curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" http://localhost:4096/<DESIRED-PATH> 2>&1 | python3 -m json.tool`
    - Or just open `http://localhost:4096` in a browser and use dev
        tools to inspect requests, responses, and WebSocket messages.
- Check the daemon logs in `~/.opencode/daemon.log` for errors or unexpected behavior.
- You can use `playwright-cli console` (see the playwright-cli skill) to inspect the console logs to help debug the frontend.
- Don't remove temporary debug logging until you're confident you've fixed the issue.
