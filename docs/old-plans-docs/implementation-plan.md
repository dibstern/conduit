# OpenCode-Relay Implementation Plan

> Re-implementing claude-relay's UI/UX to work with OpenCode's REST API + SSE event stream.

## Overview

OpenCode already exposes a full HTTP server (`opencode serve`) with REST endpoints and SSE streaming. This project builds a **WebSocket relay + web UI** that bridges browsers to that API — giving you claude-relay's mobile-friendly experience on top of OpenCode.

### Key Architectural Decision

Claude-relay uses an **in-process SDK** (`@anthropic-ai/claude-agent-sdk`) with async iterables and callbacks. OpenCode-relay will be an **HTTP/SSE client** consuming OpenCode's existing REST API. This is a cleaner separation — the relay is purely a UI layer, not embedded in the agent process.

```
claude-relay:    Browser ←WS→ Server ←SDK (in-process)→ Claude Code
opencode-relay:  Browser ←WS→ Server ←HTTP/SSE (localhost)→ OpenCode Server
```

### Technology Decisions

- **Language**: TypeScript 7 throughout — server-side modules (`src/lib/*.ts`) and frontend (`src/lib/public/**/*.ts`), compiled to JS for execution. Uses **TypeScript 7** (Project Corsa) with the native Go-based compiler (`tsgo`) for ~10x faster type checking via `@typescript/native-preview`. Traditional `tsc` remains available as fallback.
- **Package manager**: **pnpm** via corepack — fast, disk-efficient, strict dependency resolution
- **Frontend bundler**: **Vite** — ESM-native dev server with HMR for frontend development, plus optimised production builds. Configured in ticket 0.4.
- **Linting & formatting**: **Biome** — fast, unified linter and formatter (replaces ESLint + Prettier). Configured in ticket 0.1.
- **TDD approach**: Test infrastructure is set up in **Phase 0** (ticket 0.3), not Phase 6. Every ticket's acceptance criteria are written as tests *before* implementation.

### Testing Strategy

Every ticket has a **Testable Components** table. Each test is categorised as one of three types:

| Test Type | Runner | When to Use | Speed |
|-----------|--------|-------------|-------|
| **Unit** | Vitest | Test a single function/class in isolation. Dependencies are mocked with `vi.fn()`/`vi.spyOn()`. | < 10ms each |
| **Fixture** | Vitest | Test multiple components working together using pre-built test fixtures: mock OpenCode server, mock WebSocket client, canned SSE event sequences. Deterministic — no real API calls. | < 500ms each |
| **E2E** | Playwright | Test the full user experience in a real Chromium browser. The relay + mock server run, Playwright opens the page and interacts with it. Required for all frontend UI tickets (Phase 4–5). | < 5s each |

**Regression prevention**: Every ticket writes its tests *before* implementation (TDD). The full test suite runs on every commit. Fixture tests lock down the event translation contract so changes to the bridge layer can't silently break the frontend. E2E tests catch visual/interaction regressions in the UI.

**Tooling**:
- **Vitest** — Unit + fixture tests. ESM-native, fast, built-in mocking, Jest-compatible API, watch mode.
- **Playwright** — E2E browser tests. Five viewports: iPhone 15, iPhone 17, Pixel 7, iPad Pro 11, Desktop 1440×900. Configured in ticket 0.3.

---

## Key Differences from Claude Code

Understanding the differences between OpenCode and Claude Code is critical for the translation layer and frontend adaptation. These were identified by studying the OpenCode source code and documentation.

### Event Model: Part-Based, Not Stream-Based

Claude Code (via its SDK) emits low-level streaming events: `content_block_start`, `content_block_delta`, `content_block_stop`. The SDK bridge in claude-relay converts these into WebSocket messages.

OpenCode uses a **part-based event model** over SSE. All events have the shape `{ type: string, properties: object }`:

| OpenCode SSE Event | What It Contains |
|---|---|
| `message.part.updated` | Full Part object (text, tool, reasoning, etc.) with lifecycle state |
| `message.part.delta` | Incremental text/reasoning content: `{ sessionID, messageID, partID, field, delta }` |
| `message.part.removed` | Part deletion notification |
| `message.updated` | Message metadata update (cost, tokens, completion status) |
| `session.status` | Session state: `idle`, `busy`, or `retry` (with attempt/message/next) |
| `permission.asked` | Permission request with `id`, `permission`, `patterns[]`, `metadata`, `always[]` |
| `permission.replied` | Permission resolution: `once`, `always`, or `reject` |
| `question.asked` | Question with `id`, `questions[]` (each with `question`, `header`, `options[]`, `multiple`, `custom`) |
| `question.replied` | Answer: `answers` as `Array<Array<string>>` |
| `question.rejected` | Question was rejected/skipped |
| `pty.created/updated/exited/deleted` | PTY lifecycle events |
| `file.edited`, `file.watcher.updated` | File change notifications |
| `server.connected`, `server.heartbeat` | Connection lifecycle (heartbeat every 10s) |

OpenCode's **Part types** are: `text`, `reasoning`, `tool`, `file`, `snapshot`, `patch`, `agent`, `compaction`, `subtask`, `retry`, `step-start`, `step-finish`. Tool parts have an explicit state machine: `pending` → `running` → `completed` | `error`.

The event translator (ticket 1.3) maps these to claude-relay's WebSocket protocol.

### Tool Names: Different Casing and Set

| Claude Code (PascalCase) | OpenCode (lowercase) | Notes |
|---|---|---|
| `Read` | `read` | Same concept |
| `Edit` | `edit` | Same concept |
| `Write` | `write` | Same concept |
| `Bash` | `bash` | Same concept |
| `Glob` | `glob` | Same concept |
| `Grep` | `grep` | Same concept |
| `WebFetch` | `webfetch` | Same concept |
| `WebSearch` | `websearch` | Same concept |
| `TodoWrite` | `todowrite` | Same concept |
| `AskUserQuestion` | `question` | Different name |
| `EnterPlanMode` | *(none)* | OpenCode uses a "Plan" agent instead |
| `ExitPlanMode` | *(none)* | No plan mode concept |
| `Task` | *(none)* | No subagent-launching tool |
| `TaskCreate` | *(none)* | No task tool family |
| `TaskUpdate` | *(none)* | " |
| `TaskList` | *(none)* | " |
| `TaskGet` | *(none)* | " |
| `NotebookEdit` | *(none)* | Not in OpenCode |
| *(none)* | `lsp` | Code intelligence (experimental) |
| *(none)* | `patch` | Apply patches |
| *(none)* | `skill` | Load SKILL.md files |
| *(none)* | `list` | Directory listing |
| *(none)* | `todoread` | Read existing todo lists |

The translator maps OpenCode tool names to PascalCase for frontend compatibility (e.g., `read` → `Read`). Tools with no equivalent pass through to the frontend's generic `default:` renderer. Claude-Code-only tools (plan mode, Task family) become harmless dead code in the ported frontend.

### Permission Model

| Aspect | Claude Code | OpenCode |
|---|---|---|
| Decisions | `allow`, `deny`, `allow_always` | `once`, `always`, `reject` |
| Scope | Per tool name | Per permission type + glob pattern |
| Request shape | `toolName` + `toolInput` | `permission` + `patterns[]` + `metadata` |
| Reply endpoint | SDK callback | `POST /permission/:requestID/reply` |
| Special types | *(none)* | `doom_loop`, `external_directory`, `.env` |
| List pending | *(in-process)* | `GET /permission/` |

### Question Model

| Aspect | Claude Code | OpenCode |
|---|---|---|
| Multi-select field | `multiSelect` | `multiple` |
| Custom text field | *(always available)* | `custom` (boolean, default true) |
| Answer format | `{ [questionIdx]: "label" }` | `Array<Array<string>>` |
| Reply endpoint | SDK callback | `POST /question/:requestID/reply` |
| Reject/skip | Send `stop` | `POST /question/:requestID/reject` |

### Server & API

- **Default port**: 4096 (not 3000)
- **Health endpoint**: `GET /global/health` → `{ healthy: true, version: string }`
- **Auth**: HTTP Basic Auth via `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` env vars
- **OpenAPI spec**: Available at `GET /doc`
- **PTY**: OpenCode exposes PTY via WebSocket at `GET /pty/:ptyID/connect` — the relay can proxy this instead of managing its own PTY processes with node-pty
- **Sessions**: Stored in SQLite (not JSONL). OpenCode is always the source of truth. The relay should NOT duplicate session storage.
- **Message sending**: `POST /session/:sessionID/message` (streaming JSON response) or `POST /session/:sessionID/prompt_async` (returns 204 immediately, events via SSE)
- **Commands/Skills**: Fetched via `GET /command` and `GET /skill` REST endpoints, not pushed via SSE
- **Agents**: First-class concept with `GET /agent/`. Agents have names, models, tools, permissions, prompts
- **Providers**: Multi-provider support (75+) with `GET /provider/` and per-provider auth
- **Web UI**: OpenCode already has `opencode web` — the relay adds multi-project, push notifications, PIN auth, and mobile optimization on top

### Frontend Adaptation Notes

The ported claude-relay frontend will need these changes:

1. **Tool name mapping**: Map in translator (`read` → `Read`) — one place, ~10 lines.
2. **Plan mode code**: `EnterPlanMode`/`ExitPlanMode` handling in tools.js (~180 lines) becomes dead code. Leave it — it's harmless. Remove later if desired.
3. **Task tools**: `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` handling (~40 lines) becomes dead code. Same approach.
4. **New tool renderers**: Add `toolSummary()` and `toolActivityText()` cases for `lsp`, `patch`, `skill`, `list`, `todoread` (~30 lines).
5. **Placeholder text**: "Message Claude Code..." → "Message OpenCode..."
6. **Plan file path**: `.claude/plans/` → not applicable (remove or make configurable).
7. **PTY terminal**: Can proxy OpenCode's PTY WebSocket instead of spawning our own node-pty processes (removes `@lydell/node-pty` dependency).

---

## Ticket Index

Each ticket is a self-contained file in [`tickets/`](./tickets/) with full acceptance criteria and BDD-testable components.

### Phase 0: Project Scaffolding

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [0.1](./tickets/0.1-init-nodejs-project.md) | Initialise Node.js/TypeScript Project | Critical | — |
| [0.2](./tickets/0.2-directory-structure.md) | Directory Structure & Shared Types | Critical | 0.1 |
| [0.3](./tickets/0.3-test-infrastructure.md) | Test Infrastructure (Vitest + Playwright + Mocks) | Critical | 0.1, 0.2 |
| [0.4](./tickets/0.4-frontend-build-pipeline.md) | Frontend Build Pipeline (Vite) | Critical | 0.1, 0.2 |
| [0.5](./tickets/0.5-error-handling-foundation.md) | Error Handling Foundation | High | 0.1 |
| [0.6](./tickets/0.6-ci-cd-pipeline.md) | CI/CD Pipeline | High | 0.1, 0.3 |
| [0.7](./tickets/0.7-walking-skeleton.md) | Walking Skeleton | Critical | 0.1, 0.2, 0.3, 0.4 |

### Phase 1: OpenCode Bridge (Core)

> This is the heart of the project. Replaces claude-relay's `sdk-bridge.js`.
>
> **Parallelism note**: 1.0, 1.1, 1.2, 1.3, and 1.4 can all start simultaneously after 0.2/0.3. They depend on shared types (`OpenCodeEvent`, `RelayMessage` from `types.ts`), not on each other's implementations. Each takes a `baseUrl` string or typed event objects — the wiring between them happens at the orchestrator level (project/daemon), not via direct imports. The process manager (1.1) decides the port; the SSE consumer (1.2) and REST client (1.4) receive it as a string. The translator (1.3) is a pure mapping function over event shapes. Tests use the mock server from 0.3.

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [1.0](./tickets/1.0-api-contract-tests.md) | OpenCode API Contract Tests | Critical | 0.1, 0.2, 0.3 |
| [1.1](./tickets/1.1-opencode-process-manager.md) | OpenCode Process Manager | Critical | 0.1, 0.2 |
| [1.2](./tickets/1.2-sse-event-consumer.md) | SSE Event Consumer | Critical | 0.2 |
| [1.3](./tickets/1.3-event-translator.md) | Event Translator | Critical | 0.2 |
| [1.4](./tickets/1.4-rest-api-client.md) | REST API Client | Critical | 0.2 |
| [1.5](./tickets/1.5-permission-bridge.md) | Permission Bridge | Critical | 1.2, 1.4 |
| [1.6](./tickets/1.6-question-bridge.md) | Question / Ask-User Bridge | High | 1.2, 1.4 |

### Phase 2: Server & WebSocket Layer

> **Parallelism note**: 2.1 depends only on 0.2 — it can start at the same time as all Phase 1 tickets. 2.2 depends only on 2.1 (not on any bridge ticket). The WebSocket handler broadcasts `RelayMessage` objects defined in `types.ts`; it does not import or call the event translator. The bridge and server layers are fully independent tracks that get wired together at integration time.

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [2.1](./tickets/2.1-http-server.md) | HTTP Server | Critical | 0.2 |
| [2.2](./tickets/2.2-websocket-handler.md) | WebSocket Handler | Critical | 2.1 |
| [2.3](./tickets/2.3-session-management-layer.md) | Session Management Layer | Critical | 1.4, 2.2 |
| [2.4](./tickets/2.4-pin-rate-limiting.md) | PIN Authentication & Rate Limiting | High | 2.1 |
| [2.5](./tickets/2.5-input-sync.md) | Input Synchronisation | Low | 2.2 |
| [2.6](./tickets/2.6-onboarding-http-redirect.md) | Onboarding HTTP Redirect | Medium | 2.1 |
| [2.7](./tickets/2.7-pty-websocket-proxy.md) | PTY WebSocket Proxy | Medium | 2.1, 1.4 |

### Phase 3: Daemon & CLI

> **Deferral note**: Phase 3 is **deferred** until after a working foreground relay exists (Phases 0–2, 4.1–4.2). The daemon, IPC, and CLI are polish features — complex, OS-specific, and not needed for the core use case. The relay runs perfectly well as a foreground process via `tsx src/bin/cli.ts`. Daemonisation adds multi-project support, background persistence, and CLI management, but none of these block a usable product. Phase 3 is now part of M5 (production ready), not M3.

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [3.1](./tickets/3.1-daemon-process.md) | Daemon Process | High | 2.1 |
| [3.2](./tickets/3.2-ipc-protocol.md) | IPC Protocol | High | 3.1 |
| [3.3](./tickets/3.3-cli-interface.md) | CLI Interface | High | 3.1, 3.2 |
| [3.4](./tickets/3.4-version-check.md) | Version Check | Low | 3.1 |
| [3.5](./tickets/3.5-keep-awake.md) | Keep-Awake Management | Low | 3.1 |
| [3.6](./tickets/3.6-recent-projects.md) | Recent Projects Tracking | Low | 3.1, 3.2 |

### Phase 4: Frontend UI

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [4.1](./tickets/4.1-core-chat-ui.md) | Core Chat UI | Critical | 2.2 |
| [4.2](./tickets/4.2-permission-approval-ui.md) | Permission Approval UI | Critical | 4.1, 1.5 |
| [4.3](./tickets/4.3-session-management-ui.md) | Session Management UI | High | 4.1, 2.3 |
| [4.4](./tickets/4.4-file-browser.md) | File Browser | Medium | 4.1, 1.4 |
| [4.5](./tickets/4.5-terminal-tabs.md) | Terminal Tabs | Medium | 2.2, 2.7 |
| [4.6](./tickets/4.6-pwa-and-notifications.md) | PWA & Push Notifications | High | 2.1, 4.1 |
| [4.7](./tickets/4.7-todo-progress-overlay.md) | Todo / Progress Overlay | Medium | 4.1 |
| [4.8](./tickets/4.8-progressive-history-loading.md) | Progressive History Loading | Medium | 4.1, 2.3 |
| [4.9](./tickets/4.9-slash-command-autocomplete.md) | Slash Command Autocomplete | Medium | 4.1 |
| [4.10](./tickets/4.10-image-and-paste-preview.md) | Image & Paste Preview | Medium | 4.1 |
| [4.11](./tickets/4.11-thinking-visualisation.md) | Thinking Visualisation | Medium | 4.1 |
| [4.12](./tickets/4.12-project-switcher.md) | Project Switcher Dropdown | Medium | 4.1, 2.1 |

### Phase 5a: OpenCode-Specific Features (Core)

> These features are needed for OpenCode feature parity — without them, the relay can't leverage OpenCode's key differentiators.

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [5.1](./tickets/5.1-agent-selector.md) | Agent Selector | High | 1.4, 4.1 |
| [5.2](./tickets/5.2-model-provider-picker.md) | Model / Provider Picker | High | 1.4, 4.1 |
| [5.5](./tickets/5.5-question-ui.md) | Question / Ask-User UI | High | 1.6, 4.1 |

### Phase 5b: OpenCode-Specific Features (Aspirational)

> These features are nice-to-haves. Each is a mini-project that could take as long as all of Phase 1. **Evaluate after M4** — do a 2-hour spike per feature to determine if OpenCode's API supports it well enough to build. Do not commit to these until the core relay is working.

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [5.3](./tickets/5.3-session-forking.md) | Session Forking | Medium | 2.3, 4.3 |
| [5.4](./tickets/5.4-rewind-revert.md) | Rewind / Revert Support | Medium | 2.3, 4.1 |
| [5.6](./tickets/5.6-session-sharing.md) | Session Sharing | Low | 2.3 |
| [5.7](./tickets/5.7-advanced-search.md) | Advanced Search | Medium | 1.4, 4.4 |
| [5.8](./tickets/5.8-mcp-support.md) | MCP Support | Low | 1.4 |
| [5.9](./tickets/5.9-session-summarisation.md) | Session Summarisation | Low | 2.3 |
| [5.10](./tickets/5.10-session-diff-viewer.md) | Session Diff Viewer | Low | 2.3, 1.4 |

### Phase 6: Testing & Polish

> **Note**: Integration testing (6.1) is delivered incrementally at each milestone, not saved until the end. See the milestone checkpoint table in the ticket.

| Ticket | Title | Priority | Depends on |
|--------|-------|----------|------------|
| [6.1](./tickets/6.1-integration-testing.md) | Integration Test Scenarios | High | 0.3 (incremental from M1 onward) |
| [6.2](./tickets/6.2-error-handling.md) | Error Handling & Edge Cases | High | Phase 1-5 |
| [6.3](./tickets/6.3-documentation.md) | Documentation | Medium | All |

---

## Milestones

> **Key changes from original plan**:
> - M1 is now a **walking skeleton** (vertical slice proving the full pipeline) — not just backend plumbing
> - Phase 3 (daemon/CLI) is **deferred** to M5 — the relay runs as a foreground process until then
> - Phase 5 is **split** into 5a (core, needed for OpenCode parity) and 5b (aspirational, evaluate after M4)
> - Integration tests are written **incrementally at each milestone** (see ticket 6.1)
> - Contract tests (1.0) validate our API assumptions against a real OpenCode server

| Milestone | Scope | Tickets | Integration Tests |
|-----------|-------|---------|-------------------|
| **M1 — Walking skeleton** | End-to-end vertical slice: spawn OpenCode → SSE → translate → WebSocket → text in browser. Validates the architecture in days, not weeks. | 0.1–0.5, 0.7 | 1-2 smoke tests |
| **M2 — Proof of concept** | Production-quality bridge layer, HTTP server, WebSocket handler. Full message streaming with proper event translation. Contract tests validate API assumptions. | 0.6, 1.0–1.4, 2.1, 2.2 | 2-3 (message flow, reconnection) |
| **M3 — Functional relay** | Full message flow with permissions, questions, session management, PIN auth. Usable product for single-project foreground use. | 1.5, 1.6, 2.3–2.4, 4.1–4.2 | 4-5 (permission, question, session, multi-client) |
| **M4 — Feature parity** | Full UI: file browser, terminal, push notifications, PWA, all chat features. Agent selector, model picker, question UI. | 4.3–4.12, 2.7, 5.1, 5.2, 5.5 | 3-5 (error scenarios, E2E frontend) |
| **M5 — Production ready** | Daemon, CLI, IPC. Error handling polish, docs. Input sync, onboarding flow. | 3.1–3.6, 2.5–2.6, 6.1–6.3 | Full suite |
| **M6 — OpenCode extras** *(aspirational)* | Session forking, rewind, sharing, search, MCP, summarisation, diff viewer. Each preceded by a 2-hour spike to validate feasibility. | 5.3, 5.4, 5.6–5.10 | Per-feature |

---

## Risk Mitigations Built Into This Plan

| Risk | Mitigation | Where |
|------|-----------|-------|
| No vertical slice → late discovery of architecture flaws | Walking skeleton (0.7) validates full pipeline in M1 | Ticket 0.7, M1 |
| OpenCode API changes silently break the relay | Contract tests (1.0) + version pinning in `.opencode-version` | Ticket 1.0, 0.1 |
| Frontend port takes longer than expected (JS → TS rewrite) | Explicit rewrite warning in 4.1; snapshot tests in 1.3 lock the contract | Tickets 4.1, 1.3 |
| Translator state corrupted on SSE reconnection | AC15 in 1.3: reset + rebuild from REST on reconnect | Ticket 1.3 |
| TypeScript 7 (tsgo) bleeding-edge bugs | `tsc` is CI gatekeeper; `tsgo` is local speed tool only | Ticket 0.1 |
| Daemon complexity delays usable product | Phase 3 deferred to M5; foreground relay works fine | Milestones |
| Permission requests lost on relay crash | AC9 in 1.5: recovery via `GET /permission/` on restart | Ticket 1.5 |
| Phase 5 scope creep (mini-projects disguised as tickets) | Split into 5a (core) and 5b (aspirational with spikes) | Phase 5a/5b |
| Integration bugs compound across phases | Checkpoint integration tests at each milestone | Ticket 6.1 |
| EventSource doesn't support HTTP Basic Auth | Spike task in 1.2; fall back to fetch-based SSE if needed | Ticket 1.2 |

---

## Summary

- **44 tickets** across 7 phases (Phase 5 split into 5a and 5b)
- **19 Critical**, **10 High**, **12 Medium**, **3 Low** priority
- **TypeScript 7** (native Go compiler via `tsgo` for local dev, `tsc` for CI), **Vite** (frontend build), **Biome** (lint/format), **Vitest** (unit + fixture + contract) + **Playwright** (E2E), **TDD** from Phase 0, **pnpm** via corepack
- Core new work is Phase 1 (the bridge layer — 7 tickets including contract tests)
- Phases 2–4 are rewritten from claude-relay (TypeScript, not a copy-paste port)
- Phase 5a adds core OpenCode-specific capabilities; 5b is aspirational (evaluate after M4)
- Phase 3 (daemon/CLI) deferred to M5 — foreground relay is fully usable without it
- Risk mitigations are embedded throughout: walking skeleton, contract tests, snapshot tests, version pinning, incremental integration testing
