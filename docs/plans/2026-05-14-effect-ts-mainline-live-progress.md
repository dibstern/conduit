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
| App-internal `Effect.runPromise` / `Effect.runSync` | Open | Daemon HTTP handler construction moved to `src/lib/domain/server/Layers/http-router-layer.ts`; tagged and legacy-format IPC dispatch now use the daemon layer runtime at the socket boundary, and `daemon-lifecycle.ts` no longer owns a default runtime dispatcher. Client-init, default-session startup state, relay session-count status, and SSE shutdown no longer build Promise/sync session-service bridges in `relay-stack.ts`; the sole relay-stack `runPromise` is explicitly reclassified as the public `createProjectRelay()` startup boundary. Remaining blockers are final grep hits outside accepted external boundaries. |

## Current Blockers

1. Project relay construction no longer has hidden startup/session/shutdown bridges; the only relay-stack `runPromise` is the explicit `createProjectRelay()` Promise boundary.
2. CLI still imports/calls `startDaemonProcess`.

## Remaining Order

This mirrors the plan's authoritative order. Update this list only when an item is done or re-scoped.

1. Effect version freeze and post-migration v4 record.
2. Domain organization move-only PR. Done locally; pending commit/review.
3. Persistence migration runner alignment. Done locally; pending commit/review. Real production DB dry-run remains required before any persistence consumer switch.
4. Contracts and RPC boundary. Started locally: shared `WsRpcGroup`, import guard, and server/frontend re-export wrappers are in place.
5. Hybrid relay domain model. Started locally: pure relay command/event/read-model, bounded command gate, and bounded sliding relay event bus are in place.
6. Router service ownership and HTTP runtime boundary. Done locally for daemon and standalone relay HTTP handler ownership.
7. Scoped project relay ownership. Started locally: prebuilt relay object injection is gone from `relay-stack.ts`, client init now forks one Effect-owned bootstrap at the WebSocket callback boundary, startup service acquisition and relay callback/monitoring/poller/SSE setup are consolidated into one Effect program, API/WebSocket handler acquisition no longer uses separate startup `runSync` calls, SSE connect/command-gate readiness runs inside startup, SSE shutdown drain and command-gate stop are scoped finalizers, SSE pending question writes use the owned session service surface, SSE pending permission writes run inside the Effect-owned SSE handler, message/status-poller callbacks now use Effect-owned paths, the standalone/E2E default-session API reads the startup snapshot instead of re-entering the session service, daemon/router session counts read a relay status snapshot instead of a sync runtime bridge, daemon IPC default-agent/model updates use the `ProjectRelay` public surface instead of reaching into the relay runtime, the deferred status-poller runtime facade is deleted after `StatusPollerLive` became the only production owner, and the sole relay-stack `runPromise` is guarded as the public startup Promise boundary.
8. RPC-over-WS vertical migration. Done locally for ordinary browser operations. `pty_input` is explicitly reclassified as the raw terminal data-plane command until a persistent RPC stream/client design replaces it.
9. Provider driver and instance ownership. Started locally: `ProviderDriver` / `ProviderInstance` / `ProviderCapabilities` / `ProviderInstanceFailure` exist, production orchestration runtime creates `OpenCodeProviderInstance` / `ClaudeProviderInstance` through plain driver values, `ProviderRegistry` now exposes only instance-first APIs, provider implementation/test naming is instance-first, provider wait state now uses Effect `Deferred` for `EventSinkImpl`, OpenCode pending turns, Claude setup locks, and Claude turn queues, and the old provider Promise-deferred helper is deleted.
10. IPC socket ownership. Done locally pending final recheck: tagged IPC dispatch no longer uses app-internal `Effect.runPromise` or a `Runtime.defaultRuntime` fallback in `daemon-lifecycle.ts`; legacy cmd-format IPC validates with the old semantics, converts to tagged payloads, and dispatches through the same daemon runtime-owned RPC path.
11. Daemon composition readiness. Started locally: IPC status reads now live on the IPC context instead of passing a separate `DaemonLiveOptions.getStatus` callback through the Layer graph, keep-awake/PIN/shutdown IPC now run through native Effect handlers, restart-config IPC now mutates `DaemonConfigRefTag` natively, and legacy ManagedRuntime shutdown/restart scheduling is isolated to the IPC socket post-response hook instead of `DaemonIPCContext`.
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

2026-05-14, RPC permission and question response slice:

- Implemented `RespondPermission`, `AnswerQuestion`, and `RejectQuestion` in `WsRpcServerLayer` through the existing Effect permission/question handlers.
- Switched permission cards and ask-user question cards to typed RPC with browser tab `originId`; no production frontend callsite sends raw `permission_response`, `ask_user_response`, or `question_reject`.
- Kept the legacy raw handlers until WS mock/E2E helpers move to RPC-aware assertions.
- Verified locally with targeted RPC contract/server tests, `pnpm check`, `pnpm lint`, and `git diff --check`.

2026-05-14, RPC project management slice:

- Implemented `AddProject`, `RemoveProject`, `RenameProject`, and `SetProjectInstance` in `WsRpcServerLayer` through `ProjectManagementServiceTag`.
- Switched the project switcher add/remove/rename flows and header instance rebinding to typed RPC, applying the typed response through the project store.
- Kept the legacy raw project mutation handlers for integration/E2E helpers and old WS mock coverage until those move to RPC-aware project-management assertions.
- Verified locally with targeted RPC contract/server tests and `pnpm check`.

2026-05-14, RPC instance management and discovery slice:

- Implemented `StartInstance`, `StopInstance`, `RemoveInstance`, `RenameInstance`, `ScanNow`, and `DetectProxy` in `WsRpcServerLayer`.
- Switched SettingsPanel and ConnectOverlay instance lifecycle, scan, and proxy-detection callsites to typed RPC and applied responses through the instance store.
- Kept legacy raw instance/discovery handlers and frontend store send helpers as compatibility surfaces for existing WS mock/tests until those are migrated.
- Verified locally with targeted RPC contract/server/store tests, `pnpm check`, `pnpm lint`, and `git diff --check`.

2026-05-14, RPC terminal control slice:

- Implemented `ListPtys`, `CreatePty`, `ResizePty`, and `ClosePty` in `WsRpcServerLayer` through `OpenCodeTerminalServiceTag`.
- Switched terminal list/create/resize/close browser callsites and terminal integration helpers to typed RPC, while keeping `pty_input` on raw WS as the high-throughput terminal data-plane operation.
- Deleted the legacy incoming `terminal_command`, `pty_create`, `pty_resize`, and `pty_close` browser WS commands from payload schemas, router types, dispatch tables, incoming-message schemas, frontend callsites, and integration helpers.
- Verified locally with targeted RPC/router/store/terminal unit tests, `test/integration/flows/terminal.integration.ts`, `pnpm check`, `pnpm lint`, and `git diff --check`.

2026-05-14, legacy project/instance WS cleanup:

- Deleted the legacy incoming `add_project`, `remove_project`, `rename_project`, `instance_add`, `instance_remove`, `instance_start`, `instance_stop`, `instance_update`, `instance_rename`, `set_project_instance`, `proxy_detect`, and `scan_now` browser WS commands from the production router, payload schemas, incoming-message schema, dispatch table, and dead handler modules.
- Removed frontend raw-WS send helpers/offline queue for instance discovery and management; those flows now rely on the existing typed RPC clients.
- Updated project-management and multi-instance Playwright mocks/assertions to record Effect RPC requests instead of raw browser WS command envelopes.
- Verified locally with `pnpm check`, `pnpm lint`, targeted RPC/router/frontend unit tests, `pnpm build:frontend`, project-management Playwright, and multi-instance Playwright.

2026-05-14, legacy permission/question WS cleanup:

- Deleted the legacy incoming `permission_response`, `ask_user_response`, and `question_reject` browser WS commands from the production router, payload schemas, incoming-message schema, and dispatch table.
- Kept the shared permission/question Effect helpers for `RespondPermission`, `AnswerQuestion`, and `RejectQuestion` RPC server handlers.
- Updated question-flow Playwright coverage to drive user prompts through `SendMessage` RPC and assert `AnswerQuestion` / `RejectQuestion` RPC requests instead of raw browser WS command envelopes.
- Verified locally with `pnpm check`, `pnpm lint`, targeted router/schema/store/RPC unit tests, `pnpm build:frontend`, question-flow Playwright, and `git diff --check`.

2026-05-14, session lifecycle integration RPC migration:

- Added `TestWsClient` helpers for `CreateSession`, `ViewSession` / `SwitchSession`, `DeleteSession`, and `ForkSession` over the existing Effect RPC socket.
- Moved the main relay integration flows off raw `new_session`, `switch_session`, `view_session`, and `delete_session` browser WS sends while preserving event-WS assertions for pushed `session_switched`, status, history, and session-list messages.
- Left `test/integration/relay/sse-aware-poller-gating.test.ts` on raw `view_session` for now; its custom accelerated relay harness timed out when moved to the generic RPC helper and needs a separate harness-specific RPC pass.
- Verified locally with `pnpm check`, `pnpm lint`, `git diff --check`, and the targeted 7-file relay integration subset. The attempted `sse-aware-poller-gating` RPC conversion failed by timeout and was reverted.

2026-05-14, SSE-aware relay harness RPC routing:

- Converted the accelerated `sse-aware-poller-gating` relay integration harness from raw `view_session` sends to the shared `TestWsClient.viewSession()` RPC helper.
- Fixed the harness to use explicit production-like upgrade routing with `noServer: true`, `/ws` for relay events, and `/rpc` for Effect RPC; the previous bare server let the raw WS handler swallow RPC upgrades.
- Verified locally with `pnpm vitest run --config vitest.integration.config.ts test/integration/relay/sse-aware-poller-gating.test.ts`.

2026-05-14, legacy session lifecycle WS cleanup:

- Deleted the legacy incoming `new_session`, `view_session`, `switch_session`, `delete_session`, and `fork_session` browser WS commands from the production router, incoming-message schemas, payload schemas, dispatch table, frontend raw-send helpers, and stale raw-send unit tests.
- Kept the shared Effect session lifecycle helpers for the typed `CreateSession`, `ViewSession`, `DeleteSession`, and `ForkSession` RPC server handlers.
- Updated notification, scroll, subagent, fork, and snapshot-recorder E2E harnesses to drive session lifecycle through Effect RPC while keeping `/ws` as the server-push event channel.
- Verified locally with `pnpm check`, `pnpm lint`, `git diff --check`, targeted router/session unit tests, `pnpm build:frontend`, notification-nav Playwright, notification-reducer Playwright, subagent Playwright, targeted replay Playwright for notification/fork/scroll, and a serial fork replay rerun. The targeted replay run exited 0 with four Playwright retries under high parallelism; the serial fork rerun passed cleanly.

2026-05-14, RPC log-level cleanup and raw terminal reclassification:

- Implemented `SetLogLevel` in the shared `WsRpcGroup` and `WsRpcServerLayer`.
- Switched the debug panel verbose toggle to typed RPC and deleted the legacy incoming `set_log_level` raw WS command from router/schema/relay dispatch.
- Reclassified the sole remaining raw production browser WS command, `pty_input`, as the terminal data-plane path pending a persistent RPC stream/client design.
- Verified locally with `pnpm check`, `pnpm lint`, targeted RPC/router/schema/relay/store unit tests, `pnpm build:frontend`, `git diff --check`, and the pre-commit build/lint/full-unit/typecheck hook.

2026-05-14, provider registry instance API:

- Added `ProviderRegistry` instance-first APIs (`registerInstance`, `getInstance*`, `hasInstance`, `removeInstance`) and moved production orchestration dispatch/wiring to them.
- Removed adapter-named registry compatibility shims after moving local callers to the instance-first API.
- Added guard coverage so adapter-named registry methods cannot return; remaining provider cleanup is naming debt in adapter class/error/test surfaces.
- Verified locally with targeted provider registry, orchestration engine, orchestration wiring, scoped-layer, and Claude provider wiring tests.

2026-05-14, client-init runtime bridge cleanup:

- Added `handleClientConnectedEffect()` as the production client bootstrap path; it consumes relay services directly from the runtime Layer graph and owns history resolution, session switching, reconnect replay, model/agent bootstrap, terminal replay, instance list, and cached update emission.
- Removed the `ClientInitDeps` / `clientInitDeps` Promise-shaped bridge and `resolveClientInitHistory` adapter from `relay-stack.ts`; the `client_connected` WebSocket callback now forks one Effect program.
- Added a runtime-boundary guard so the client-init bridge cannot return to `relay-stack.ts`, and tightened bootstrap ordering coverage around `session_list` before `markClientBootstrapped`.
- Verified locally with `pnpm check`, `pnpm lint`, focused client-init/runtime-boundary/relay-stack tests, and `test/integration/flows/initial-state.integration.ts`.

2026-05-14, relay startup acquisition cleanup:

- Consolidated session initialization, orchestration view acquisition, poller state/pubsub touch, default override seeding, status poller acquisition, and poller manager acquisition into one startup Effect.
- Removed `sessionServiceBridge.initialize()` and piecemeal startup `runSync(StatusPollerTag)` / `runPromise(PollerManagerTag)` calls from `relay-stack.ts`.
- Added a runtime-boundary guard so startup service acquisition cannot drift back to multiple relay-stack runtime calls.
- Verified locally with `pnpm check`, `pnpm lint`, focused relay-stack/runtime-boundary tests, and `test/integration/flows/initial-state.integration.ts`.

2026-05-14, relay SSE readiness bridge cleanup:

- Sequenced `sseStream.connectEffect()` and `RelayCommandGate.markReady()` inside one relay startup Effect program so command-gate readiness cannot be bridged through a second runtime call.
- Added a runtime-boundary guard that rejects the retired separate SSE connect and gate-readiness runtime calls.
- Verified locally with `test/unit/effect/runtime-boundary-grep.test.ts`; wider slice verification runs before commit.

2026-05-14, SSE pending-question bridge cleanup:

- Removed the duplicate `pendingQuestionCounts` dependency from `SSEWiringDeps` and the corresponding ad hoc runtime bridge in `relay-stack.ts`.
- `question.asked` events and reconnect rehydration now update pending question counts through the existing session service surface.
- Added a runtime-boundary guard so `pendingQuestionCounts` cannot reappear as a parallel SSE wiring bridge.
- Verified locally with focused SSE wiring, reconnect-race, runtime-boundary, typecheck, lint, and diff hygiene checks.

2026-05-14, SSE pending-interaction bridge cleanup:

- Replaced the bespoke `pendingPermissions` SSE wiring dependency with `pendingInteractions`, using the real pending-interaction service method names for permission record/reply/recover flows.
- Updated relay-stack wiring and tests so permission state is no longer described as a separate permission-only bridge.
- Added a runtime-boundary guard against reintroducing `pendingPermissions` as an SSE wiring dependency.
- Verified locally with focused SSE wiring, reconnect-race, runtime-boundary, mock-factory, typecheck, lint, and diff hygiene checks.

2026-05-14, relay startup handle acquisition cleanup:

- Moved `OpenCodeAPITag` and `WebSocketHandlerTag` acquisition into one startup Effect instead of separate `relayManagedRuntime.runSync(...)` calls.
- Kept OpenCode reachability/config probing after acquisition and before SSE connection.
- Extended the startup runtime-boundary guard so API and WebSocket handler acquisition cannot drift back to piecemeal `runSync`.
- Verified locally with focused runtime-boundary, relay-stack layer/default override, typecheck, lint, and diff hygiene checks.

2026-05-14, relay shutdown drain cleanup:

- Replaced the bare shutdown `runPromise(sseStream.drainEffect())` bridge with a shutdown Effect that drains SSE and stops the relay command gate before runtime disposal.
- Added a runtime-boundary guard so relay shutdown cannot regress to a bare SSE drain bridge.
- Verified locally with focused runtime-boundary, command-gate, typecheck, lint, and diff hygiene checks.

2026-05-14, SSE pending-interaction runtime cleanup:

- Added `wireSSEConsumerEffect()` so production SSE event callbacks run pending permission record/reply/recovery through `PendingInteractionServiceTag` inside the relay runtime.
- Removed the inline `PendingInteractionServiceTag` / `relayManagedRuntime.runSync(...)` pending-interaction bridge from `relay-stack.ts`; sync `wireSSEConsumer()` remains only for direct unit-test wiring.
- Added a runtime-boundary guard so pending-interaction SSE writes cannot move back into relay-stack runtime calls.
- Verified locally with focused SSE wiring, SSE rehydration race, runtime-boundary, typecheck, lint, and diff hygiene checks.

2026-05-14, message-poller callback ownership cleanup:

- Added `applyPipelineResultEffect()` and `wirePollersEffect()` so production message-poller events run timeout side effects through the relay Effect context instead of the `processingTimeouts` runFork bridge.
- Moved message-poller parent-map reads to `SessionManagerServiceTag` inside the Effect callback path; the sync `wirePollers()` function remains for direct unit-test wiring.
- Added runtime-boundary coverage so `relay-stack.ts` cannot return to production `wirePollers({ ...sessionServiceBridge, processingTimeouts })` wiring.
- Verified locally with focused poller/event-pipeline/runtime-boundary tests, typecheck, lint, diff hygiene, and the initial-state plus SSE-aware poller integration tests.

2026-05-14, status-poller monitoring ownership cleanup:

- Added `wireMonitoringEffect()` so production status-poller `changed` callbacks broadcast session lists, start/stop message pollers, emit synthetic done events, and clear timeout/activity state through relay Effect services.
- Removed production monitoring's direct `sessionServiceBridge` and `processingTimeouts` dependencies from `relay-stack.ts`; sync `wireMonitoring()` remains for direct unit-test wiring.
- Added runtime-boundary coverage so production monitoring cannot move back to `wireMonitoring({ ...sessionServiceBridge, processingTimeouts })`.
- Verified locally with focused monitoring/effect-executor/event-pipeline/runtime-boundary tests, typecheck, lint, diff hygiene, and the initial-state plus SSE-aware poller integration tests.

2026-05-14, SSE processing-timeout ownership cleanup:

- Moved production SSE pipeline timeout side effects from relay-stack's `processingTimeouts` bridge into `handleSSEEventEffect()` via `applyPipelineResultEffect()`.
- Removed the relay-stack `clearProcessingTimeout` / `resetProcessingTimeout` `runFork` bridge; sync `handleSSEEvent()` still owns direct unit-test wiring through `SSEWiringDeps`.
- Added runtime-boundary and Effect-path behavior coverage so production SSE wiring cannot depend on relay-stack timeout bridges.
- Verified locally with focused SSE/event-pipeline/runtime-boundary tests, typecheck, lint, diff hygiene, and the initial-state plus SSE-aware poller integration tests.

2026-05-14, SSE session-service ownership cleanup:

- Removed production SSE wiring's `sessionServiceBridge` and parent-map callbacks from `relay-stack.ts`.
- Moved SSE message activity, pending-question counts, session-list refresh, parent-map reads, and question-count increments to `SessionManagerServiceTag` inside the Effect SSE callback path.
- Kept sync `SSEWiringDeps.sessionService` only for direct unit-test wiring while production `wireSSEConsumerEffect()` consumes the relay runtime service graph.
- Verified locally with focused SSE/rehydration/event-pipeline/runtime-boundary tests, typecheck, lint, diff hygiene, and the initial-state plus SSE-aware poller integration tests.

2026-05-14, relay session-service bridge object cleanup:

- Deleted the broad `sessionServiceBridge` object from `relay-stack.ts` after production SSE, poller, and monitoring paths stopped using it.
- Left only explicit runtime calls for the still-synchronous public `ProjectRelay.getLastKnownSessionCount()` and Promise-returning `ProjectRelay.getDefaultSessionId()` compatibility methods.
- Added a runtime-boundary guard so broad relay-stack session service bridge objects cannot return.
- Verified locally with focused runtime-boundary and SSE Effect tests, typecheck, lint, and diff hygiene.

2026-05-14, relay WebSocket callback wiring cleanup:

- Added `websocket-callback-wiring.ts` so client connect/disconnect and browser message callbacks are registered from the relay setup Effect and fork against the relay runtime there.
- Removed direct `relayManagedRuntime.runFork(...)` calls from `relay-stack.ts`; the `ws` callback remains the external boundary.
- Added a runtime-boundary guard so relay-stack cannot directly fork WebSocket callback programs again.
- Verified locally with focused runtime-boundary, client-init, relay-stack, per-tab routing tests, typecheck, lint, diff hygiene, and `test/integration/flows/initial-state.integration.ts`.

2026-05-14, relay startup acquisition cleanup:

- Collapsed the API/WebSocket handler acquisition bridge and the session/orchestration/poller startup bridge into one relay startup Effect program.
- Moved OpenCode reachability probing and project-config default-model discovery into that startup Effect while preserving the existing warning-and-continue behavior for config API failures.
- Added a runtime-boundary guard so API/WebSocket acquisition cannot split back into a separate `startupHandles` runtime bridge.
- Verified locally with focused runtime-boundary and relay-stack default override tests, typecheck, lint, diff hygiene, and `test/integration/flows/initial-state.integration.ts`.

2026-05-14, relay startup/setup bridge cleanup:

- Collapsed relay callback wiring, monitoring, poller wiring, SSE consumer wiring, SSE connect, and command-gate readiness into the startup Effect program.
- Removed the late `doneDeliveredRef` callback bridge by wiring poller and SSE done callbacks directly to the monitoring Effect result.
- Added a runtime-boundary guard so relay wiring setup cannot split back into a second `relayManagedRuntime.runPromise(...)` program.
- Verified locally with focused runtime-boundary, relay-stack default override, per-tab routing, and status-poller tests, plus typecheck, lint, and diff hygiene.

2026-05-14, IPC tagged-dispatch runtime ownership:

- Removed the default `Runtime.defaultRuntime` tagged IPC dispatcher from `daemon-lifecycle.ts`.
- `startIPCServer()` now requires its caller to pass the tagged dispatcher; production passes the daemon Layer runtime from `makeIpcServerLive()`, and direct lifecycle tests pass an explicit test dispatcher.
- Added daemon lifecycle guard coverage so the default runtime fallback cannot return.
- Verified locally with focused daemon lifecycle IPC/boundary tests and typecheck.

2026-05-14, IPC legacy command dispatch cleanup:

- Removed `createCommandRouter()` from `daemon-lifecycle.ts`'s socket dispatch path.
- Legacy `cmd` IPC lines still parse and validate with the old `validateCommand()` semantics, then convert through `commandToTaggedRequestPayload()` and dispatch via the same tagged RPC handler as `_tag` requests.
- Added daemon lifecycle guard coverage so legacy socket dispatch cannot return to the old promise router.
- Verified locally with focused daemon lifecycle, IPC dispatch, RPC group, schema command, typecheck, lint, and diff hygiene checks.

2026-05-14, relay default-session bridge cleanup:

- Replaced `ProjectRelay.getDefaultSessionId()` / `RelayStack.getDefaultSessionId()` with an `initialSessionId` startup snapshot produced by the existing relay startup Effect.
- Moved the E2E harness cleanup seed to that snapshot and updated relay test factories to match the new public shape.
- Added a runtime-boundary guard so relay-stack cannot restore the Promise-shaped default-session accessor or `runSessionServicePromise()` helper.
- Verified locally with focused runtime-boundary, relay-stack default override, project-registry tests, typecheck, lint, and diff hygiene checks.

2026-05-14, relay status snapshot cleanup:

- Added `RelayStatusSnapshotLive`, owned by the relay Effect graph, and wired session-count updates from session list, initialize, create, and delete paths.
- Replaced `ProjectRelay.getLastKnownSessionCount()` with `ProjectRelay.getStatusSnapshot()` so daemon config, IPC project lists, and router project metadata read one snapshot without re-entering the relay runtime.
- Updated standalone relay project metadata to use the same snapshot for sessions, clients, and processing state.
- Added behavior coverage for session-count snapshot updates and a runtime-boundary guard so `runSessionServiceSync()` / the old count accessor cannot return to `relay-stack.ts`.
- Verified locally with focused runtime-boundary, session-manager-service, daemon status, layer wiring, project-registry, status-poller, relay-stack default override, typecheck, lint, and diff hygiene checks.

2026-05-14, scoped SSE shutdown cleanup:

- Added `SSEStreamLive` / `SSEStreamTag` so the relay Layer graph constructs the SSE stream and drains it from a scoped finalizer.
- Removed `new SSEStream(...)` and the shutdown `relayManagedRuntime.runPromise(...)` bridge from `relay-stack.ts`; `ProjectRelay.stop()` now disposes the relay runtime and lets scoped finalizers stop SSE and the command gate.
- Added a guard so relay-stack cannot reintroduce manual SSE construction or runtime-owned SSE drain.
- Verified locally with focused SSE boundary, runtime-boundary, relay-stack default override, status-poller tests, typecheck, lint, and diff hygiene checks.

2026-05-14, provider public type naming cleanup:

- Renamed the public provider contract from `ProviderAdapter` / `AdapterCapabilities` / `ProviderAdapterFailure` to `ProviderInstance` / `ProviderCapabilities` / `ProviderInstanceFailure`.
- Added guard coverage so the old adapter-named provider type/error exports cannot return.
- Verified locally with focused provider type, registry, orchestration, OpenCode, Claude, typecheck, lint, and diff hygiene checks.

2026-05-14, provider implementation naming cleanup:

- Renamed OpenCode/Claude provider implementation classes and source files from adapter naming to provider instance naming.
- Renamed orchestration wiring's public OpenCode instance field and SSE wiring method to instance terminology.
- Added production source guard so adapter-named provider implementation exports cannot return.
- Verified locally with focused provider/orchestration tests, typecheck, lint, and diff hygiene checks.

2026-05-14, provider test/doc naming cleanup:

- Renamed provider implementation test files from `*-adapter-*` to `*-provider-instance-*` and cleaned provider-local test wording.
- Updated current architecture and main migration docs to point at `OpenCodeProviderInstance` / `ClaudeProviderInstance` paths.
- Added guard coverage so provider implementation tests cannot drift back to `opencode-adapter` / `claude-adapter` filenames.
- Verified locally with focused provider/orchestration tests, `pnpm check`, `pnpm lint`, and `git diff --check`.

2026-05-14, relay startup boundary reclassification:

- Reclassified the remaining `relayManagedRuntime.runPromise(...)` in `relay-stack.ts` as the public `createProjectRelay()` Promise boundary rather than an app-internal relay service bridge.
- Added guard coverage requiring exactly one relay-stack startup `runPromise` and requiring it to stay marked as relay acquisition/wiring/readiness owned by one startup Effect.
- Verified locally with focused runtime-boundary guard coverage.

2026-05-14, EventSink deferred cleanup:

- Replaced `EventSinkImpl`'s Promise-backed permission/question deferred waits with Effect `Deferred`.
- Kept `AbortSignal` abort as a synchronous callback boundary using `Deferred.unsafeDone` instead of adding an app-internal runtime bridge.
- Added guard and interruption coverage so EventSink waits cannot return to `createDeferred` / `deferred.promise` / `Effect.tryPromise` and interrupted waiters clear pending state.
- Verified locally with focused EventSink tests.

2026-05-14, OpenCode provider deferred cleanup:

- Replaced `OpenCodeProviderInstance`'s Promise-backed pending-turn waits with Effect `Deferred`.
- Kept SSE completion, end-session, and shutdown as synchronous callback/reset boundaries using `Deferred.unsafeDone` instead of adding app-internal runtime bridges.
- Reworked end-session tests to drive the public `sendTurnEffect()` behavior instead of injecting private deferreds.
- Added guard coverage so OpenCode pending turns cannot return to `createDeferred` / `deferred.promise` / `Effect.tryPromise` waits.
- Verified locally with focused OpenCode provider tests and `pnpm check`.

2026-05-14, Claude setup-lock deferred cleanup:

- Replaced `ClaudeProviderInstance`'s Promise-backed per-session setup lock with Effect `Deferred`.
- Left Claude turn queues on the old deferred utility for the next provider cleanup slice.
- Added guard coverage so setup locks cannot return to `Promise<void>` / `setupLock.promise`.
- Verified locally with focused Claude concurrent setup tests and `pnpm check`.

2026-05-14, Claude turn-queue deferred cleanup:

- Replaced `ClaudeProviderInstance`'s Promise-backed turn deferred queues with Effect `Deferred`.
- Completed SDK result, error, stream-end, interrupt, end-session, and shutdown turn waits through `Deferred.unsafeDone` / `Deferred.fail` at the existing synchronous callback/reset boundaries.
- Updated lifecycle tests to use Effect `Deferred` waits instead of the old provider deferred helper.
- Added guard coverage so Claude turn queues cannot return to `createDeferred` / `PromiseDeferred` / `deferred.promise`.
- Verified locally with focused Claude provider lifecycle and send-turn tests plus `pnpm check`.

2026-05-14, provider deferred helper deletion:

- Deleted the unused provider Promise-deferred helper and its unit tests after all provider waiters moved to Effect `Deferred`.
- Added guard coverage so `src/lib/provider/deferred.ts` cannot return.

2026-05-14, IPC status callback consolidation:

- Moved daemon status reads into `DaemonIPCContext` so `DaemonLiveOptions` no longer carries a separate `getStatus` callback for IPC server wiring.
- Updated IPC lifecycle/unit fixtures to use the single IPC context surface.
- Added guard coverage so `DaemonLiveOptions.getStatus`, `options.getStatus`, and the old `buildIPCHandlers(ctx, getStatus)`/`startIPCServer(..., getStatus, ...)` signatures cannot return.

2026-05-14, relay public default override surface:

- Added `ProjectRelay.setDefaultAgent()` and `ProjectRelay.setDefaultModel()` so daemon IPC handlers no longer call `relay.effectRuntime.runtime.runPromise(...)` directly.
- Kept default-model persistence/broadcast behavior inside the relay-owned Effect runtime.
- Added guard coverage so daemon-main cannot reach into relay runtime internals for IPC default override updates.

2026-05-14, deferred status-poller facade deletion:

- Deleted the unused `makeDeferredStatusPollerRuntime()` late-attach bridge and its focused tests.
- Simplified `createStatusPollerService()` so subscriptions and timers start against the scoped `StatusPollerLive` runtime immediately.
- Added guard coverage so the deferred status-poller runtime facade cannot return.

2026-05-14, daemon scheduled-shutdown bridge cleanup:

- Removed the legacy `scheduleShutdown()` call back into `ShutdownSignalTag`; the legacy daemon path now schedules `stop()` and lets `ManagedRuntime.dispose()` tear down the Layer graph.
- Added guard coverage so scheduled shutdown cannot re-enter `daemonRuntime.runPromise(...)`.

2026-05-14, daemon keep-awake IPC bridge cleanup:

- Routed tagged and legacy-converted keep-awake IPC requests through the native Effect IPC handlers instead of `DaemonIPCContext` callbacks.
- Moved `ConfigPersistenceLive` and `KeepAwakeTag` earlier in daemon Layer composition so IPC can use the owned services directly.
- Updated keep-awake handlers to update both `DaemonStateTag` and `DaemonConfigRefTag`, then request persistence through `ConfigPersistenceTag`.
- Added guard coverage so `daemon-main.ts` cannot reintroduce keep-awake runtime callbacks.

2026-05-14, daemon IPC post-response shutdown cleanup:

- Removed shutdown/restart scheduling from `DaemonIPCContext` and isolated it behind `IpcPostResponseActions`.
- `Shutdown` and `RestartWithConfig` now run only the native Effect IPC handlers before the socket response; the socket layer schedules legacy shutdown after a successful response write.
- Added guard coverage so post-response shutdown scheduling cannot return to `DaemonIPCContext`.
- Verified locally with focused daemon IPC tests, runtime-boundary guard coverage, `pnpm check`, `pnpm lint`, and diff hygiene checks.
