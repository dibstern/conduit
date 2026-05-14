# Effect.ts Mainline Live Progress

Current source of truth for the remaining Effect.ts mainline completion work.

Historical log: `docs/plans/2026-05-11-effect-ts-mainline-completion-progress.md`.

Plan: `docs/plans/2026-05-11-effect-ts-mainline-completion-plan.md`.

Updated: 2026-05-14.

## Update Rules

- Keep this file concise. Do not paste full command logs unless the exact output is the decision evidence.
- Prefer one-line status updates with links to commits, test files, or historical progress sections.
- Keep the old progress doc as append-only history except for banners or index notes.
- If this file grows past roughly 300 lines, archive completed details into a new historical note and keep only live state here.

## Accepted Decisions

- Finish the current migration on Effect 3.x. Effect v4 and `effect/unstable/*` are post-migration work.
- Keep one production daemon owner. Do not add `--daemon-runtime=effect|legacy`.
- Keep per-project relays as deployment, scope, routing, and lifecycle units.
- Adopt command/event/projector/read-model inside each relay now, not later.
- Use a move-only domain organization PR before larger semantic rewrites.
- Use strict `src/lib/contracts/*` for shared schemas, domain protocol declarations, and RPC groups. Do not introduce `packages/contracts/*` in this plan.
- Keep WebSocket as the real-time browser transport. Migrate browser/server operations to Effect RPC over WS in vertical slices.
- Keep per-browser-tab active project/session/thread state in route/Svelte state, not daemon-global mutable state.
- Provider drivers should be plain values that create scoped `ProviderInstance` records. Only the provider instance registry should be a Context service.
- Implement semantic changes test-first, one observable behavior or contract at a time.

## Guardrail Checklist

Every open item must be removed or explicitly reclassified before the migration can be called complete.

| Guardrail | Status | Live note |
|---|---|---|
| `startDaemonProcess` imported by CLI | Open | Blocked by router, relay, and IPC ownership. Cut over only after branch-local smoke parity. |
| `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition | Done | Recheck before final guardrail close. Production `relay-stack.ts` now composes relay-owned Layers for OpenCode API, config, logger, WebSocket handler, status poller, and instance management. |
| `PersistenceLayer.open(...)` in daemon or relay production paths | Done | Recheck before final guardrail close. |
| `Effect.promise(` on rejectable operations | Done | Recheck before final guardrail close. |
| `concurrency: "unbounded"` on dynamic collections | Done | Recheck before final guardrail close. Fixed-size fanouts need inline justification. |
| Throwing helpers called from Effect programs | Open | Broad grep needs call-path triage; defects and external boundaries can be reclassified. |
| App-internal `Effect.runPromise` / `Effect.runSync` | Open | Daemon HTTP handler construction moved to `src/lib/domain/server/Layers/http-router-layer.ts`; tagged IPC dispatch now uses the daemon layer runtime at the socket boundary. Remaining blockers are relay-stack transitional runtime bridges and any final grep hits. |

## Current Blockers

1. RPC-over-WS is partly started: `CancelSession`, `CreateSession`, `DeleteSession`, `ForkSession`, `GetAgents`, `GetCommands`, `GetFileContent`, `GetFileList`, `GetFileTree`, `GetModels`, `GetProjects`, `GetTodo`, `GetToolContent`, `ListDirectories`, `ListSessions` including search, `LoadMoreHistory`, `ReloadProviderSession`, `RenameSession`, `RewindSession`, `SendMessage`, `SetDefaultModel`, `SwitchAgent`, `SwitchContextWindow`, `SwitchModel`, `SwitchVariant`, `SyncInputDraft`, and `ViewSession` have moved through Effect RPC, but the remaining browser operations still use the legacy WS protocol.
2. Project relay construction still has transitional app-internal runtime bridge calls in `relay-stack.ts`.
3. Provider architecture has the first plain-driver cut, but downstream naming still says adapter in several compatibility APIs.
4. CLI still imports/calls `startDaemonProcess`.

## Remaining Order

This mirrors the plan's authoritative order. Update this list only when an item is done or re-scoped.

1. Effect version freeze and post-migration v4 record.
2. Domain organization move-only PR. Done locally; pending commit/review.
3. Persistence migration runner alignment. Done locally; pending commit/review. Real production DB dry-run remains required before any persistence consumer switch.
4. Contracts and RPC boundary. Started locally: shared `WsRpcGroup`, import guard, and server/frontend re-export wrappers are in place.
5. Hybrid relay domain model. Started locally: pure relay command/event/read-model, bounded command gate, and bounded sliding relay event bus are in place.
6. Router service ownership and HTTP runtime boundary. Done locally for daemon and standalone relay HTTP handler ownership.
7. Scoped project relay ownership. Started locally: prebuilt relay object injection is gone from `relay-stack.ts`; runtime bridge cleanup remains.
8. RPC-over-WS vertical migration. Started locally with end-to-end `CancelSession`, `CreateSession`, `DeleteSession`, `ForkSession`, `GetAgents`, `GetCommands`, `GetFileContent`, `GetFileList`, `GetFileTree`, `GetModels`, `GetProjects`, `GetTodo`, `GetToolContent`, `ListDirectories`, `ListSessions` including search, `LoadMoreHistory`, `ReloadProviderSession`, `RenameSession`, `RewindSession`, `SendMessage`, `SetDefaultModel`, `SwitchAgent`, `SwitchContextWindow`, `SwitchModel`, `SwitchVariant`, `SyncInputDraft`, and `ViewSession`; broader browser operation slices remain.
9. Provider driver and instance ownership. Started locally: `ProviderDriver` / `ProviderInstance` exist and production orchestration runtime creates OpenCode/Claude instances through plain driver values.
10. IPC socket ownership. Started locally: tagged IPC dispatch no longer uses app-internal `Effect.runPromise`; legacy cmd-format IPC still uses the old promise router.
11. Daemon composition readiness.
12. Single-owner daemon cutover.
13. Final guardrail cleanup.
14. Final docs and verification.

## Verification Commands

Use narrow tests for each slice, then widen at the slice boundary.

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:e2e --grep "session|websocket|project"
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

For docs-only edits, `git diff --check` is sufficient unless the edit changes commands or planned behavior.

## Latest Update

2026-05-14:

- Created this live progress file to reduce context load from the historical progress log.
- Main plan now points ongoing progress updates here.
- Historical progress doc should only be consulted for baseline evidence, detailed command output, or old phase notes.

2026-05-14, Phase 0.5:

- Moved the flat `src/lib/effect/*` bucket into `src/lib/domain/{daemon,relay,provider,persistence,server}/{Services,Layers}` plus `src/lib/contracts/*`.
- Added `test/unit/effect/domain-organization-guard.test.ts` so production files cannot be added back to `src/lib/effect/*`.
- Split owner tags out of the relay services index: daemon management tags now live under `src/lib/domain/daemon/Services/*`, and the raw OpenCode API tag lives under `src/lib/domain/provider/Services/*`.
- Added a guard so `src/lib/domain/relay/Services/services.ts` cannot become a cross-domain export barrel for daemon, provider, persistence, or server owners.
- Kept behavior unchanged: this was file moves, import rewrites, and guide/progress updates only.

2026-05-14, persistence migration runner alignment:

- Added `src/lib/persistence/effect/migrations.ts`: static `effectMigrationEntries`, registry validation, and `@effect/sql` Migrator execution against `effect_sql_migrations`.
- Switched `makePersistenceServiceLive` startup migration off the custom sync `_migrations` runner and deleted the `runMigrationsEffect()` bridge; legacy `runMigrations()` remains only for the old sync persistence layer and tests.
- Baseline schema inventory: 12 event-store tables and 21 explicit indexes from `0001_current_event_store.sql`; the Effect baseline verifies existing table, index, and column names before adopting a legacy-created schema.
- Added `test/unit/persistence/effect-migrations.test.ts` and updated `test/unit/persistence/persistence-effect.test.ts` for Effect migrator history, idempotency, in-memory SQLite support, readonly failure, static registry gaps, and legacy baseline adoption.
- Rollback policy unchanged: forward-only migrations mean restore the DB from backup. Real production DB copy dry-run with before/after row counts is still required before any persistence consumer switch.

2026-05-14, contracts/RPC, relay model, and router ownership:

- Added `src/lib/contracts/ws-rpc.ts`, frontend/server re-export wrappers, and contract import guards. `test/unit/contracts/ws-rpc-contract.test.ts` exercises the real `@effect/rpc` test client against `WsRpcGroup`.
- Added relay command/event/read-model primitives plus `RelayCommandGate`; browser WS dispatch now goes through the gate and the relay marks it ready only after relay wiring and SSE connection succeed.
- Moved daemon HTTP handler construction out of `daemon-main.ts` into `src/lib/domain/server/Layers/http-router-layer.ts`; `makeHttpServerLive` now owns `ctx.router` assignment/cleanup.
- Added server-side `CancelSession` RPC handling through `WsRpcServerLayer`, reusing the existing OpenCode/Claude cancel behavior and preserving the legacy `done` push event. Browser transport cutover is still open.
- Verified locally with `pnpm check` plus targeted contract, server, relay, router, and layer wiring tests.

2026-05-14, provider and IPC ownership:

- Added `ProviderDriver<Input>` and `ProviderInstance` types. `OpenCodeDriver` and `ClaudeDriver` are plain values; `makeOrchestrationRuntimeLayer()` now creates scoped provider instances through those drivers and registers instances with `ProviderRegistry`.
- Kept existing adapter class exports and `registerAdapter()` as compatibility APIs; later cleanup should rename downstream "adapter" wording where it no longer reflects ownership.
- Split tagged IPC dispatch into `dispatchTaggedRequestEffect()` and pass the daemon layer runtime into `startIPCServer()` from `makeIpcServerLive()`. `daemon-lifecycle.ts` no longer has an `Effect.runPromise` guardrail hit for tagged IPC.
- Verified locally with `pnpm check`, `test/unit/provider/orchestration-wiring.test.ts`, `test/unit/daemon/daemon-lifecycle-ipc.test.ts`, and `test/unit/effect/runtime-boundary-grep.test.ts`.

2026-05-14, RPC cancel, standalone HTTP, and relay event bus:

- Moved standalone relay HTTP request handling into `src/lib/domain/server/Layers/http-router-layer.ts`; `relay-stack.ts` no longer constructs a Node HTTP handler with app-internal `Effect.runSync(...)`.
- Added an RPC WebSocket upgrade path for daemon and standalone project relays at `/p/:slug/rpc`, switched the browser stop action to `cancelSessionRpc()`, and deleted the legacy `cancel` WS message type/decoder/dispatcher branch.
- Added `src/lib/domain/relay/Services/relay-event-bus.ts` and wired `RelayEventBusLive` into `RelayStateLive`. Policy: bounded sliding buffer, capacity 256; durable relay events remain the replay source.
- Verified locally with `pnpm check`, targeted WS/router/handler/RPC tests, `test/unit/relay/relay-event-bus.test.ts`, and `test/unit/effect/relay-stack-layers.test.ts`.

2026-05-14, RPC GetModels slice:

- Implemented `GetModels` in `WsRpcServerLayer` via shared model discovery logic, switched initial browser model loading to `getModelsRpc()`, and applied the typed response through the discovery store.
- Deleted the legacy browser `get_models` WS message type from payload schemas, router types, dispatch table, frontend outbound schemas, and old wire snapshot coverage. Server-pushed `model_list` / `model_info` messages remain only for still-legacy operations such as provider-session reload.
- Verified locally with `pnpm check`, `pnpm lint`, and targeted RPC, frontend store, router, schema, and model-handler tests.

2026-05-14, RPC ListSessions slice:

- Implemented `ListSessions` in `WsRpcServerLayer` through `SessionManagerServiceTag`, including roots/all-session views and search responses.
- Switched initial browser session loading to `listSessionsRpc()` for both root and all-session lists, then applied the typed response through the session store.
- Deleted the legacy browser `list_sessions` WS message type from payload schemas, router types, dispatch table, frontend outbound schemas, and old wire snapshot/integration coverage.
- Verified locally with `pnpm check`, `pnpm lint`, and targeted RPC, frontend store, router, schema, and session-handler tests.

2026-05-14, RPC SendMessage slice:

- Implemented `SendMessage` in `WsRpcServerLayer` through the shared prompt dispatch path, preserving status updates, activity recording, server-side rate limiting, provider routing, and per-session broadcast behavior.
- Switched the browser input path to `sendMessageRpc()` with a per-tab `originId`; same-tab optimistic user messages are no longer duplicated by server echo while other tabs still receive `user_message`.
- Deleted the legacy browser `message` WS command from payload schemas, router types, dispatch table, frontend outbound schemas, integration helpers, and old rate-limit tests. The client-side chat rate limiter now wraps the RPC send callback instead of raw WS messages.
- Fixed the RPC upgrade handler to use Effect's socket protocol over WebSocket rather than the stdio protocol; integration tests now exercise real RPC-over-WS sends/cancels.
- Verified locally with `pnpm check`, targeted RPC/unit tests, and patched send/cancel/session/model/SSE/error integration flows.

2026-05-14, RPC GetAgents slice:

- Implemented `GetAgents` in `WsRpcServerLayer` through `AgentServiceTag`, including per-session active-agent state.
- Switched initial browser agent loading, session-switch agent refresh, and post-model-switch agent refresh to `getAgentsRpc()`.
- Deleted the legacy browser `get_agents` WS command from payload schemas, router types, dispatch table, frontend outbound schemas, and WS coverage tests.
- Verified locally with `pnpm check`, targeted RPC/router/frontend/unit tests, and focused discovery/error/multi-client integration flows.

2026-05-14, RPC GetCommands slice:

- Implemented `GetCommands` in `WsRpcServerLayer` through shared command discovery logic, preserving active-provider command selection for session-scoped requests.
- Switched initial browser command loading and session-switch command refresh to `getCommandsRpc()`.
- Deleted the legacy browser `get_commands` WS command from production payload schemas, router types, dispatch table, frontend outbound schemas, and WS coverage tests. The direct `handleGetCommands()` helper remains only as reusable command-list emission logic for provider-session reload.
- Verified locally with `pnpm check`, targeted RPC/router/frontend/unit tests, and focused discovery/error/multi-client integration flows.

2026-05-14, RPC GetProjects slice:

- Implemented `GetProjects` in `WsRpcServerLayer` through `ProjectManagementServiceTag`, preserving current-project metadata and project instance/count fields.
- Switched initial browser project loading to `getProjectsRpc()` and applied the typed response through the project store.
- Deleted the legacy browser `get_projects` WS command from production payload schemas, router types, dispatch table, frontend outbound schemas, and WS coverage tests. Project mutation commands still emit `project_list` pushes.
- Verified locally with `pnpm check`, targeted RPC/router/schema unit tests, and focused discovery/error/multi-client integration flows.

2026-05-14, RPC GetFileTree slice:

- Implemented `GetFileTree` in `WsRpcServerLayer` through shared file-tree walk logic and switched initial browser file-tree preload to `getFileTreeRpc()`.
- Deleted the legacy browser `get_file_tree` WS command from production payload schemas, router types, dispatch table, and WS coverage tests. The `file_tree` store envelope remains an internal application shape.
- Fixed the shared file walker to honor `.gitignore` directory patterns such as `node_modules/` by checking directory paths with a trailing slash.
- Tightened the integration `input_sync` coverage so both clients explicitly view the same session before asserting session-scoped draft broadcast behavior.
- Verified locally with `pnpm check`, targeted RPC/file/router/frontend unit tests, and focused discovery/error/multi-client integration flows.

2026-05-14, RPC GetToolContent slice:

- Implemented `GetToolContent` in `WsRpcServerLayer` through `ToolContentServiceTag`, returning typed full-content responses and typed not-found failures.
- Switched truncated tool-card expansion in both standalone and grouped tool cards to `getToolContentRpc()`, applying content through the existing chat-store update path and clearing loading state immediately on success/failure.
- Deleted the legacy browser `get_tool_content` WS command from production payload schemas, router types, dispatch table, and frontend callsites. The pushed `tool_content` event remains the internal chat-store update shape.
- Verified locally with `pnpm check` and targeted RPC/tool-content/router/frontend-store unit tests.

2026-05-14, RPC GetFileList/GetFileContent slice:

- Implemented `GetFileList` and `GetFileContent` in `WsRpcServerLayer` through shared file-service helpers, preserving `.gitignore` filtering, file sizes, paths, content, and binary metadata.
- Switched sidebar file browsing, file viewer loads, and `@` input file/directory reads to typed RPC calls. RPC responses are applied through the existing file-browser listener shape so the UI update path stays shared.
- Deleted the legacy browser `get_file_list` and `get_file_content` WS commands from production payload schemas, router types, dispatch table, frontend callsites, and handler-error snapshot coverage.
- Verified locally with `pnpm check`, targeted RPC/file/router/frontend unit tests, and focused discovery/error/multi-client integration flows.

2026-05-14, scoped relay ownership started:

- Removed the daemon `InstanceMgmtTag` bridge from production relay composition. `InstanceManagementServiceFromConfigLive` now derives the relay instance-management service from complete `ProjectRelayConfig` callbacks, and `relay-stack.ts` no longer imports or `Layer.succeed`s `InstanceMgmtTag`.
- Added a runtime-boundary guard for this bridge so it cannot be reintroduced in `relay-stack.ts`.
- Verified locally with `pnpm check` plus targeted runtime-boundary, instance-management, and instance-handler tests.

2026-05-14, scoped relay ownership bridge cleanup:

- Moved `StatusPollerTag` construction into `StatusPollerLive`; `relay-stack.ts` no longer builds `createStatusPollerService()` or late-attaches a deferred status-poller runtime.
- Moved WebSocket handler construction into `WebSocketHandlerLive`; relay viewer checks now read the Effect-backed handler state directly, and the legacy relay-local `SessionRegistry` is no longer constructed by `relay-stack.ts`.
- Moved core relay ports into relay-owned Layers: `makeProjectRelayConfigLive`, `ProjectRelayLoggerLive`, and `OpenCodeAPILive`. `makeOrchestrationRuntimeLayer()` now depends on `OpenCodeAPITag` instead of accepting a prebuilt OpenCode API instance.
- Added runtime-boundary guards so these bridge injections cannot return to `relay-stack.ts`.
- Verified locally with `pnpm check`, targeted runtime-boundary/websocket/provider/relay unit tests, and focused relay/send/cancel integration flows.

2026-05-14, RPC directory and model-control cluster:

- Implemented `ListDirectories`, `SwitchAgent`, `SwitchContextWindow`, `SwitchVariant`, `SwitchModel`, `SetDefaultModel`, and `ReloadProviderSession` in `WsRpcServerLayer`, switched the corresponding Svelte controls/helpers to typed RPC calls, and deleted each old legacy WS command in the same slice.
- Preserved server-pushed model, variant, command, and provider-session state messages as internal update events where other flows still consume them; the browser command path is now RPC-owned for the converted operations.
- Added `test/e2e/helpers/rpc-mock.ts` using Effect RPC's JSON socket frame shape (`_tag`, `tag`, `payload`) instead of JSON-RPC-style method envelopes, and fixed `test:project-management` so it builds the frontend before running Playwright.
- Verified locally with `pnpm check`, `pnpm lint`, targeted RPC/router/component/integration tests, and `pnpm build:frontend && pnpm exec playwright test --config test/e2e/playwright-variant.config.ts --workers=1 --retries=0`.

2026-05-14, RPC session-manager read/mutation cluster:

- Implemented `GetTodo`, `RenameSession`, and `LoadMoreHistory` in `WsRpcServerLayer`; switched todo loading, session renaming, search requests through `ListSessions`, and history pagination to typed RPC calls.
- Deleted the legacy `get_todo`, `rename_session`, `search_sessions`, and `load_more_history` browser WS commands from payload schemas, router types, dispatch tables, frontend callsites, integration helpers, and old wire snapshots.
- Fixed the history pagination path so `LoadMoreHistory` RPC responses flow through `history_page` handling and clear per-session `historyLoading` / update per-session pagination state, not only the old global compatibility state.
- Verified locally with `pnpm check`, `pnpm lint`, targeted RPC/contract/component/store/handler tests, and focused session lifecycle plus WS handler coverage integration flows.

2026-05-14, RPC input draft sync slice:

- Implemented `SyncInputDraft` in `WsRpcServerLayer`; the browser input box now sends debounced and immediate-clear drafts through typed RPC with explicit `sessionId` and per-tab `originId`.
- Deleted the legacy incoming `input_sync` WS command from payload schemas, router types, dispatch tables, and incoming-message schema coverage. The server-pushed `input_sync` event remains as the cross-tab draft update message.
- Preserved per-tab semantics by making the frontend ignore `input_sync` echoes whose `from` matches the current browser tab id, while other tabs on the same session still receive the draft.
- Verified locally with `pnpm check`, `pnpm lint`, targeted RPC/router/dispatch/handler unit tests, and focused multi-client/per-tab integration flows.

2026-05-14, RPC rewind slice:

- Implemented `RewindSession` in `WsRpcServerLayer`; browser rewind confirmation now calls typed RPC with explicit `projectSlug`, `sessionId`, and `messageId`.
- Moved the rewind implementation into the shared `rewindSessionToMessage()` Effect helper so RPC and handler tests exercise the same OpenCode revert and pagination-cursor cleanup behavior.
- Deleted the legacy incoming `rewind` WS command from payload schemas, router types, dispatch tables, and incoming-message schema coverage. The UI rewind selection state remains tab-local Svelte state.
- Verified locally with targeted RPC/contract/component/handler/router unit tests.

2026-05-14, browser tab client-id prerequisite:

- Added a browser tab id to the legacy event WebSocket handshake (`/ws?client=...`) and taught `EffectWsHandler` to use the validated id as its server-side client id.
- This makes RPC `originId` and legacy event-socket client ids converge, which is required before session navigation RPCs can bind per-tab session state and target direct `sendTo` responses without a parallel client registry.
- Verified locally with `test/unit/server/effect-ws-handler.test.ts`.

2026-05-14, RPC create/view session slice:

- Implemented `CreateSession` and `ViewSession` in `WsRpcServerLayer`, sharing the existing Effect session-switch path so server-pushed `session_switched`, status, metadata, and session-list events still flow through the event WebSocket.
- Switched browser new-session and session-navigation callsites to typed RPC with the stable browser tab id as `originId`; direct `switch_session` frontend sends are gone.
- Kept legacy raw `new_session` / `view_session` / `switch_session` handlers in place for the next cleanup pass and integration helpers.
- Verified locally with targeted RPC contract/server, session store, and attention banner tests.

2026-05-14, RPC delete session slice:

- Implemented `DeleteSession` in `WsRpcServerLayer` through the shared Effect delete-session path, preserving viewer reassignment, `session_deleted`, and session-list broadcast behavior.
- Switched SessionList context-menu and cleanup-mode deletes to typed RPC with browser tab `originId`.
- Kept the legacy raw `delete_session` handler until integration helpers are moved off raw session lifecycle commands.
- Verified locally with targeted RPC contract/server tests.

2026-05-14, RPC fork session slice:

- Implemented `ForkSession` in `WsRpcServerLayer` through the shared Effect fork-session path, preserving fork metadata, source cursor cleanup, `session_forked`, client switch, and session-list broadcast behavior.
- Switched the session context-menu fork and assistant-message fork button to typed RPC with browser tab `originId`.
- Kept the legacy raw `fork_session` handler until integration helpers and fork E2E setup move off raw session lifecycle commands.
- Verified locally with targeted RPC contract/server tests.
