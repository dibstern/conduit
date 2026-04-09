# OpenCode-Relay — Progress Tracker

> Last updated: 2026-02-28

## Current Status: Svelte 5 Migration — Phase S8 Complete (Cutover Done)

**1481 unit/fixture tests + 108 integration tests + 280 Playwright E2E tests across 5 viewports. 44/44 core tickets + 20/20 Phase 7 UI parity tickets + 26/26 Phase 8 tickets complete. Svelte 5 migration complete (S0-S8).** Vanilla frontend code fully removed. SPA serves all pages. Integration tests and E2E tests run against real OpenCode (no mocks). Docker image ready for deployment.

---

## Phase 0: Project Scaffolding

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 0.1 | Init Node.js/TypeScript Project | ✅ Done | package.json, tsconfig, biome config |
| 0.2 | Directory Structure & Shared Types | ✅ Done | `src/lib/types.ts` — 170 lines |
| 0.3 | Test Infrastructure (Vitest + Playwright) | ✅ Done | 19 test files, PBT with fast-check, helpers |
| 0.4 | Frontend Build Pipeline (Vite) | ✅ Done | `vite.config.ts`, `src/lib/public/index.html`, `main.ts` |
| 0.5 | Error Handling Foundation | ✅ Done | `errors.ts` — structured errors, redaction |
| 0.6 | CI/CD Pipeline | ✅ Done | `.github/workflows/ci.yml`, `lefthook.yml`, prepare script, 12 tests |
| 0.7 | Walking Skeleton | ✅ Done | `src/skeleton.ts` — end-to-end vertical slice |

## Phase 1: OpenCode Bridge — Core

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 1.0 | API Contract Tests | ✅ Done | 7 contract test files, 68 tests against live OpenCode v1.2.6, OpenAPI snapshot, version pinning |
| 1.1 | OpenCode Process Manager | ✅ Done | `opencode-process.ts` ~230 lines, spawn/health-check/crash-recovery/graceful-shutdown, 36 tests |
| 1.2 | SSE Event Consumer | ✅ Done | `sse-consumer.ts` + `sse-backoff.ts` — full SSE client with reconnection, 34 tests |
| 1.3 | Event Translator | ✅ Done | `event-translator.ts` — 459 lines, 46 tests |
| 1.4 | REST API Client | ✅ Done | `opencode-client.ts` — 40+ typed methods, 17 tests |
| 1.5 | Permission Bridge | ✅ Done | `permission-bridge.ts` — 171 lines, 12 tests |
| 1.6 | Question Bridge | ✅ Done | `question-bridge.ts` — 158 lines, 25 tests |

## Phase 2: Server & WebSocket Layer

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 2.1 | HTTP Server | ✅ Done | `server.ts` — static serving, auth, slug routing, directory traversal protection, 14 tests |
| 2.2 | WebSocket Handler | ✅ Done | `ws-handler.ts` + `ws-router.ts` — full I/O layer, heartbeat, 25 tests |
| 2.3 | Session Management Layer | ✅ Done | `session-manager.ts` — CRUD proxy, history pagination, 16 tests |
| 2.4 | PIN Authentication & Rate Limiting | ✅ Done | `auth.ts` — 149 lines, 19 tests |
| 2.5 | Input Synchronisation | ✅ Done | `input-sync.ts` — 28 lines, 5 tests |
| 2.6 | Onboarding HTTP Redirect | ✅ Done | `onboarding.ts` — ~130 lines, HTTP->HTTPS redirect + cert-help page, 17 tests |
| 2.7 | PTY WebSocket Proxy | ✅ Done | `pty-proxy.ts` — ~280 lines, bidirectional WS proxy with resize, auth, cursor reconnection, 21 tests |

## Phase 3: Daemon & CLI (Deferred to M5)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 3.1 | Daemon Process | ✅ Done | `daemon.ts` ~490 lines, Daemon class with HTTP+IPC server, crash counter, signal handlers, PID/socket management, `buildSpawnConfig()`, clientCount bug fixed, 53 tests |
| 3.2 | IPC Protocol | ✅ Done | `ipc-protocol.ts` — 163 lines, 11 tests |
| 3.3 | CLI Interface | ✅ Done | `cli-core.ts` ~556 lines + `cli.ts` ~10 lines, parseArgs, run() with injectable deps, IPC client, network detection, QR generation, 91 tests |
| 3.4 | Version Check | ✅ Done | `version-check.ts` ~190 lines, VersionChecker class with periodic npm registry checks, `isNewer()` semver comparison, `fetchLatestVersion()`, 52 tests |
| 3.5 | Keep-Awake Management | ✅ Done | `keep-awake.ts` ~135 lines, KeepAwake class with caffeinate spawn/kill, platform detection, enable/disable toggle, 39 tests |
| 3.6 | Recent Projects Tracking | ✅ Done | `recent-projects.ts` — 69 lines, 9 tests |

## Phase 4: Frontend UI

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 4.1 | Core Chat UI | ✅ Done | `main.ts` ~700 lines — markdown streaming, code blocks w/ copy, thinking blocks, tool display, auto-scroll, Tailwind CSS |
| 4.2 | Permission Approval UI | ✅ Done | Allow/Always Allow/Deny cards, resolved state, title blink, auto-approve, mobile-friendly, 12 tests |
| 4.3 | Session Management UI | ✅ Done | `session-ui.ts` ~290 lines, sidebar with CRUD/search/date groups/inline rename, 30 tests |
| 4.4 | File Browser | ✅ Done | `filebrowser-ui.ts` ~500 lines, slide-in panel with tree/breadcrumbs/modal preview, 68 tests |
| 4.5 | Terminal Tabs | ✅ Done | `terminal-ui.ts` ~426 lines, TerminalAdapter interface (decoupled from xterm.js), tab management, WS protocol (pty_create/input/output/resize/close/exited), max 10 tabs, 62 tests |
| 4.6 | PWA & Push Notifications | ✅ Done | `push.ts` ~200 lines, `notifications.ts` ~120 lines, `sw.ts` ~140 lines, `manifest.json`, 49 tests in 2 files |
| 4.7 | Todo / Progress Overlay | ✅ Done | `todo-ui.ts` ~300 lines, sticky overlay with progress bar/auto-hide, 28 tests |
| 4.8 | Progressive History Loading | ✅ Done | `history-ui.ts` ~310 lines + `history-logic.ts` ~103 lines, CSS appended to `style.css`, 18 tests in `history-ui.test.ts` |
| 4.9 | Slash Command Autocomplete | ✅ Done | `command-ui.ts` ~270 lines, keyboard nav + mouse, filter/preview, 35 tests |
| 4.10 | Image & Paste Preview | ✅ Done | `paste-ui.ts` ~340 lines, clipboard/drag-drop, large text modal, 36 tests |
| 4.11 | Thinking Visualisation | ✅ Done | Implemented in `chat.ts` — animated spinner, collapsible thinking blocks, streaming text |
| 4.12 | Project Switcher Dropdown | ✅ Done | `project-ui.ts` ~245 lines, header dropdown with slug routing, 21 tests |

## Phase 5a: OpenCode-Specific Features — Core (Not started)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 5.1 | Agent Selector | ✅ Done | `agent-ui.ts` ~183 lines, CSS appended to `style.css`, 15 tests in `agent-ui.test.ts` |
| 5.2 | Model / Provider Picker | ✅ Done | `model-ui.ts` ~275 lines, CSS appended to `style.css`, 24 tests in `model-ui.test.ts` |
| 5.5 | Question / Ask-User UI | ✅ Done | `question-ui.ts` ~325 lines, CSS appended to `style.css`, 19 tests in `question-ui.test.ts` |

## Phase 5b: OpenCode-Specific Features — Aspirational (Not started)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 5.3 | Session Forking | ✅ | Fork from assistant messages or session context menu; fork indicator in session list |
| 5.4 | Rewind / Revert Support | ⬜ | |
| 5.6 | Session Sharing | ⬜ | |
| 5.7 | Advanced Search | ⬜ | |
| 5.8 | MCP Support | ⬜ | |
| 5.9 | Session Summarisation | ⬜ | |
| 5.10 | Session Diff Viewer | ⬜ | |

## Phase 6: Testing & Polish (Not started)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 6.1 | Integration Test Scenarios | ✅ Done | 51 tests across 8 files, real OpenCode (no mocks), relay-stack.ts extraction, Docker image + compose |
| 6.2 | Error Handling & Edge Cases | ✅ Done | 5 error handling integration tests, graceful degradation for all edge cases |
| 6.3 | Documentation | ⬜ | |

## Phase 7: UI Parity with Claude Relay

> Bring conduit's web UI to visual and functional parity with the claude-relay reference implementation.

### Wave 0 — Foundation (no deps)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 7.0 | Playwright E2E Infrastructure | ✅ Done | 175 tests, 5 viewports, 7 page objects, 6 spec files, real OpenCode (no mocks), free-tier model (gemini-2.0-flash) |
| 7.1 | CDN Dependencies & Design System Foundation | ✅ Done | Inter font, 15px base, scrollbar, icons.ts (19 tests), cdn-types.d.ts, DOMPurify in renderMarkdown, 9 CDN scripts + 4 CSS links |

### Wave 1 — Layout + Standalone Features (depend on 7.1)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 7.2 | Desktop Sidebar Layout | ✅ Done | `sidebar.ts` ~88 lines, HTML restructured (#layout > #sidebar + #overlay + #app), CSS layout/sidebar/header/mobile, 21 tests |
| 7.5 | Connection Overlay | ✅ Done | `connect-overlay.ts` ~124 lines, pixel-art mascot (84 pixels), scatter/settle animation, verb cycling with shimmer, show/hide wired to WS lifecycle, 43 tests |
| 7.6 | Message Display Parity | ✅ Done | User bubble 20/20/4/20 radius, assistant copy-on-click (two-step), Lucide tool chevrons+status icons, thinking chevron+spinner, turn-meta, tool subtitles |
| 7.7 | Syntax Highlighting & Markdown Safety | ✅ Done | `markdown.ts` ~99 lines, hljs integration, mermaid diagram rendering with dark theme, error handling, 17 tests |
| 7.10 | Modal System | ✅ Done | `modal.ts` ~121 lines, openModal/closeModal/confirm, backdrop blur, Escape to close, backdrop click to close, image lightbox HTML, 23 tests |
| 7.11 | Banner System | ✅ Done | `banners.ts` ~98 lines, update/onboarding/skip-permissions variants, dismiss with localStorage, handler registration, 34 tests |
| 7.12 | Enhanced Tool Display | ✅ Done | `diff.ts` ~114 lines, LCS-based diff algorithm, unified diff HTML rendering, diffStats, escapeHtml, CSS in `style.css`, shimmer animation, 26 tests |
| 7.13 | Toast Notification Component | ✅ Done | `toast.ts` ~70 lines, showToast() with warn variant, auto-dismiss, 13 tests |
| 7.17 | PWA Assets & File Icons | ✅ Done | `file-icons.ts` ~76 lines, file-icons-js CSS class with emoji fallback, favicon SVG, apple-touch-icon, 3 manifest icons (192, 512, mono), 22 tests |

### Wave 2 — Content + Interaction (depend on 7.1 + 7.2)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 7.3 | Sidebar Content Parity | ✅ Done | `session-ui.ts` rewritten ~420 lines, HTML restructured with action buttons/search/file panel, context menu with Rename/Copy/Delete, processing dot, inline rename, 58 tests (30 existing + 28 new) |
| 7.4 | Header Bar Parity | ✅ Done | Header rebuilt: icon buttons (debug/terminal/QR share/notif settings) with Lucide icons, client count badge (hidden when <=1), terminal count badge, status dot (green/red/pulsing), setStatus() uses dot classes, session-select hidden, agent/model preserved, 45 tests |
| 7.8 | Rich Input Area | ✅ Done | `input.ts` ~100 lines, HTML restructured (#input-row > #context-mini + textarea + #input-bottom), 24px border-radius (20px mobile), Lucide arrow-up send icon (36px), attach popup with Take Photo + Add Photos, context mini-bar with color thresholds (green/yellow/red), 38 tests |
| 7.9 | Info Panels | ✅ Done | `info-panels.ts` ~180 lines, 3 panels (Usage/Status/Context) with open/close/closeAll, progress bar with green/yellow/red thresholds, context minimize to mini-bar, outside-click-to-close, handler for result/status messages, mobile bottom positioning, 62 tests |
| 7.14 | Terminal xterm.js Integration | ✅ Done | `xterm-adapter.ts` ~130 lines, XtermAdapter class implementing TerminalAdapter, ANSI theme (8 design-system colors), FitAddon auto-sizing, mobile touch toolbar HTML (Tab/Ctrl/Esc/arrows), touch toolbar CSS, 44 tests |

### Wave 3 — Integration (multiple deps)

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 7.15 | QR Code & Sharing | ✅ Done | `qr.ts` ~120 lines, getShareUrl() with LAN substitution, Web Share API on mobile, QR overlay on desktop via qrcode-generator, URL click-to-copy with "Copied!" feedback, backdrop/Escape close, 18 tests |
| 7.16 | Notification Settings UI | ✅ Done | `notif-settings.ts` ~155 lines, dropdown menu with 3 toggle switches (push/browser/sound), custom 34x20 track+thumb CSS, localStorage persistence, push permission request, blocked hint, outside-click close, 25 tests |
| 7.18 | Rewind UI | ✅ Done | `rewind.ts` ~228 lines, enterRewindMode/exitRewindMode/handleRewindClick/executeRewind, rewind banner + modal HTML, rewind CSS (banner/point/dimmed/dialog/modes), data-uuid on user messages in main.ts, rewind_result handler, 36 tests |

## Phase 8: Full Feature & Interface Parity

### Wave 0 — Foundation

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 8.0 | Terminal Rendering Engine | ✅ Done | `terminal-render.ts` ~147 lines, ANSI constants, gradient (#DA7756->#D4A574), symbols, clearUp, log, formatStatusLine, wrapColor, isBasicTerm. 25 tests |
| 8.1 | Interactive Prompt Components | ✅ Done | `prompts.ts` ~500 lines, 5 prompt types (toggle, pin, text, select, multi-select), injectable stdin/stdout/exit, tab-completion with injectable FS, 61 tests |
| 8.2 | TLS Certificate Management | ✅ Done | `tls.ts` ~277 lines, 7 exported functions (isRoutableIP, getAllIPs, getTailscaleIP, hasTailscale, hasMkcert, getMkcertCaRoot, ensureCerts), injectable deps for testing, 32 tests |
| 8.3 | Config Persistence Module | ✅ Done | `config-persistence.ts` ~120 lines, daemon.json atomic writes (tmp+rename), crash.json read/write/clear, syncRecentProjects integrating with recent-projects module, 21 tests |
| 8.4 | PIN Hashing | ✅ Done | `auth.ts` modified: hashPin(), setPinHash(), getPinHash(), authenticate() hashes before compare. 8 new tests, all 19 existing auth tests pass |

### Wave 1 — Server & Daemon Upgrades

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 8.5 | HTTPS Server Mode | ✅ Done | `server.ts` TLS fields + `createHttpsServer`, `isTls()`, `/info`, `/ca/download` routes; `relay-stack.ts` TLS passthrough + protocol-aware `getBaseUrl()`; 14 new tests |
| 8.6 | Onboarding HTTP Server Enhancement | ✅ Done | `onboarding.ts` +~60 lines (setup/ca-download/info routes, HandleRequestOptions), 12 new tests (30 total) |
| 8.7 | Enhanced Daemon Status & Config | ✅ Done | `daemon.ts` +~80 lines (pinHash/tlsEnabled/keepAwake fields, buildConfig, config persistence on start/stop/addProject/removeProject, setPin/setKeepAwake/restartWithConfig IPC handlers), `ipc-protocol.ts` +~20 lines (restart_with_config command), 20 new daemon tests + 5 new IPC tests |
| 8.8 | HTML Pages (PIN, Setup, Dashboard) | ✅ Done | `pages.ts` ~600 lines, 4 exports (escapeHtml, pinPageHtml, setupPageHtml, dashboardPageHtml), DashboardProject interface, 53 tests |

### Wave 2 — CLI Interactive UI

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 8.9 | First-Run Setup Flow | ✅ Done | `cli-setup.ts` ~280 lines, printLogo + runSetup wizard (disclaimer/port/PIN/keep-awake/restore), 28 tests |
| 8.10 | Main Menu Loop | ✅ Done | `cli-menu.ts` ~250 lines, showMainMenu + renderStatus + DaemonInfo/MenuOptions types, hotkey "o" for browser open, shutdown confirm, 33 tests |
| 8.11 | Projects Submenu | ✅ Done | `cli-projects.ts` ~270 lines, showProjectsMenu + showProjectDetail + getStatusIcon, add cwd/other/detail/back, injectable fs, 26 tests |
| 8.12 | Settings Menu | ✅ Done | `cli-settings.ts` ~200 lines, showSettingsMenu with detection lines (Tailscale/mkcert/HTTPS/PIN/keep-awake), PIN set/change/remove, keep-awake toggle, view logs, 22 tests |
| 8.13 | Daemon Health Watcher | ✅ Done | `cli-watcher.ts` ~150 lines, DaemonWatcher class with poll interval, crash detection via crashInfo, auto-restart (max 5 in 60s), counter reset after backoff window, 22 tests |
| 8.14 | Notifications Setup Wizard | ✅ Done | `cli-notifications.ts` ~250 lines, showNotificationWizard two-toggle wizard (remote access + push notifications), Tailscale/mkcert detection, TLS restart logic, QR setup URL, injectable deps, 22 tests |
| 8.15 | CLI Rewrite | ✅ Done | `cli-core.ts` rewritten ~680 lines, interactive mode (setup wizard -> daemon -> main menu), 3 new flags (-y/--yes, --no-https, --dangerously-skip-permissions), ParsedArgs + CLIOptions + InteractiveContext types, legacy non-TTY fallback preserved, 19 new tests (110 total CLI tests) |

### Wave 3 — Web UI Features

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 8.16 | PIN Login Page | ✅ Done | `server.ts` serves `pinPageHtml()` when PIN set + no auth cookie, rate limit display in HTML, 8 tests |
| 8.17 | Dashboard Page | ✅ Done | `server.ts` serves `dashboardPageHtml()` with project cards, status icons, session/client counts, single-project auto-redirect, 6 tests |
| 8.18 | Setup Page Integration | ✅ Done | `server.ts` +12 lines (import + /setup route), 10 new tests in `server.pbt.test.ts` |
| 8.19 | Plan Mode UI | ✅ Done | `plan-ui.ts` ~190 lines, enterPlanMode/exitPlanMode banners, renderPlanCard (collapsible markdown, copy), showPlanApproval (approve/reject), WS handlers for plan_enter/exit/content/approval, 26 tests |
| 8.20 | Split Diff View | ✅ Done | `diff.ts` +~155 lines (renderSplitDiff, renderDiffWithToggle, buildSplitRows), side-by-side table with change/add/remove/equal rows, inline toggle script, 29 tests |
| 8.21 | Rewind Timeline Track | ✅ Done | `timeline.ts` ~220 lines, buildTimeline/removeTimeline/addTimelineMarker/updateViewportIndicator, markers with scroll-to-message, viewport indicator, CSS in style.css, rewind.ts integration, 20 tests |

### Wave 4 — Integration & Polish

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 8.22 | Push Subscription Persistence | ✅ Done | `push.ts` +~80 lines (saveSubscriptions/loadSubscriptions/purgeDeadSubscriptions), push-subs.json persistence with VAPID key validation, 12 new tests (41 total) |
| 8.23 | File Edit History & Compare | ✅ Done | `file-history.ts` ~290 lines, FileHistory class, renderHistoryPanel, renderCompareView, formatRelativeTime, handler registration, CSS in `style.css`, 29 tests |
| 8.24 | Minor UI Polish Bundle | ✅ Done | 5 items: paste chips (`paste-ui.ts` +25 lines), notif help modal (`notif-help.ts` ~80 lines), mermaid expand (`markdown.ts` +10 lines, `modal.ts` +55 lines), terminal tab rename (`terminal-ui.ts` +40 lines), terminal scrollback (`terminal-ui.ts` +35 lines), 28 tests |
| 8.25 | E2E Tests for Phase 8 | ✅ Done | 3 spec files (21 tests x 5 viewports = 105), 2 page objects, ~626 lines |

## Svelte 5 Migration

> Migrating frontend from 41 vanilla TypeScript modules to Svelte 5 with reactive stores, components, and Storybook.

### Phase S0 — Svelte + Storybook Infrastructure

| # | Item | Status | Notes |
|---|------|--------|-------|
| S0.1 | Svelte 5 + Vite plugin | ✅ Done | `svelte.config.js`, `@sveltejs/vite-plugin-svelte`, dual entry points |
| S0.2 | `app.html` + `app-entry.ts` + `App.svelte` | ✅ Done | Minimal shell, mounts Svelte alongside vanilla |
| S0.3 | Storybook 9 setup | ✅ Done | `.storybook/main.ts`, `preview.ts`, `preview-head.html` |
| S0.4 | npm dependencies | ✅ Done | `@lucide/svelte`, `dompurify`, `highlight.js`, `mermaid`, `@xterm/xterm`, `@xterm/addon-fit`, `@castlenine/svelte-qrcode` |
| S0.5 | Test infrastructure | ✅ Done | `svelte-runes-mock` Vitest plugin, `test/svelte-ambient.d.ts`, proof-of-concept story |

### Phase S1 — State Layer & Utilities

| # | Item | Status | Notes |
|---|------|--------|-------|
| S1.1 | `types.ts` — shared client types | ✅ Done | ChatMessage union, TabEntry, PermissionRequest, SessionInfo, etc. |
| S1.2 | `stores/ws.svelte.ts` — WebSocket + dispatch | ✅ Done | Centralized `handleMessage()` for all 37+ message types, listener registries |
| S1.3 | `stores/chat.svelte.ts` — chat messages | ✅ Done | messages[], streaming, debounced render, tool/thinking/result handlers |
| S1.4 | `stores/session.svelte.ts` — sessions | ✅ Done | session list, current session, search, `groupSessionsByDate()` |
| S1.5 | `stores/terminal.svelte.ts` — PTY tabs | ✅ Done | tabs Map, scrollback buffers (50KB cap), callback pattern for output |
| S1.6 | `stores/discovery.svelte.ts` — agents/models | ✅ Done | agents, models, providers, commands, selected agent/model |
| S1.7 | `stores/permissions.svelte.ts` — permissions | ✅ Done | pending permissions/questions, auto-approve with WS response |
| S1.8 | `stores/ui.svelte.ts` — UI state | ✅ Done | sidebar, toasts, confirm dialog, scroll, banners, client count |
| S1.9 | `stores/router.svelte.ts` — client routing | ✅ Done | pathname, slug, navigate(), popstate listener |
| S1.10 | 8 utility modules | ✅ Done | format, markdown, diff, clipboard, history-logic, notifications, file-icons, xterm-adapter |
| S1.11 | 367 unit tests across 12 test files | ✅ Done | All stores + utilities tested, field names audited against server protocol |

### Phase S2 — App Shell

| # | Item | Status | Notes |
|---|------|--------|-------|
| S2.1 | `App.svelte` router | ✅ Done | Routes: chat, dashboard, auth, setup. Uses `$derived(getCurrentRoute())` |
| S2.2 | `ChatLayout.svelte` | ✅ Done | Sidebar + Header + Messages + InputArea, WS connect/disconnect lifecycle |
| S2.3 | `Header.svelte` | ✅ Done | Status dot, terminal/client badges, action buttons, all IDs preserved |
| S2.4 | `Sidebar.svelte` | ✅ Done | Session list, file browser, search, mobile slide-over overlay |
| S2.5 | `InputArea.svelte` | ✅ Done | Auto-resize textarea, send/stop toggle, attach menu, context bar |
| S2.6 | `Icon.svelte` | ✅ Done | 79 Lucide icon mappings + legacy aliases, dynamic component rendering |
| S2.7 | Storybook stories | ✅ Done | 6 story files: Icon (3 stories), Header (7), Sidebar (3), InputArea (5), ChatLayout (3), App (1) |
| S2.8 | `$derived` → getter pattern | ✅ Done | All 8 stores converted: removed module-level `$derived`, compute in getter functions for testability |

### Phase S3 — Chat & Streaming Components

| # | Item | Status | Notes |
|---|------|--------|-------|
| S3.1 | `UserMessage.svelte` | ✅ Done | Right-aligned bubble, `.msg-user`, `data-uuid` |
| S3.2 | `AssistantMessage.svelte` | ✅ Done | Streaming markdown, code block headers + hljs, mermaid, copy-on-click state machine |
| S3.3 | `ThinkingBlock.svelte` | ✅ Done | Collapsible with spinner, random verb, timer, `.thinking-block` |
| S3.4 | `ToolItem.svelte` | ✅ Done | Status state machine (pending/running/completed/error), expandable result, `.tool-item` |
| S3.5 | `ResultBar.svelte` | ✅ Done | Cost/duration/tokens display, `.result-bar .turn-meta` |
| S3.6 | `SystemMessage.svelte` | ✅ Done | Info/error variants |
| S3.7 | `MessageList.svelte` | ✅ Done | Auto-scroll, scroll detection, scroll-to-bottom button, `#messages` |
| S3.8 | Svelte `class:` fix | ✅ Done | Tailwind classes with `/` converted from `class:` directives to dynamic class strings |
| S3.9 | Storybook stories (7 files, 30 stories) | ✅ Done | UserMessage (3), AssistantMessage (7), ThinkingBlock (3), ToolItem (6), ResultBar (4), SystemMessage (2), MessageList (5) |
| S3.10 | Mock data enrichment | ✅ Done | `stories/mocks.ts` expanded with 25+ typed mock variants |

### Phase S4 — Feature Panels

| # | Item | Status | Notes |
|---|------|--------|-------|
| S4.1 | `SessionItem.svelte` + `SessionList.svelte` | ✅ Done | Date groups, search filter, context menu, inline rename, processing indicator |
| S4.2 | `FileBrowser.svelte` + `FileTreeNode.svelte` | ✅ Done | Recursive `<svelte:self>`, breadcrumbs, file preview, directory caching |
| S4.3 | `TerminalPanel.svelte` + `TerminalTab.svelte` | ✅ Done | XTerm.js lifecycle, PTY callback pattern, ResizeObserver, tab rename, multi-tab |
| S4.4 | `QuestionCard.svelte` | ✅ Done | Radio/checkbox/free-text, submit/reject |
| S4.5 | `TodoOverlay.svelte` | ✅ Done | Sticky overlay, progress bar, checkmarks |
| S4.6 | `HistoryView.svelte` + `DiffView.svelte` | ✅ Done | IntersectionObserver infinite scroll, unified diff rendering |
| S4.7 | `AgentSelector.svelte` + `ModelSelector.svelte` | ✅ Done | Pill/dropdown, provider groups, switch via WS |
| S4.8 | `CommandMenu.svelte` | ✅ Done | Slash command palette, keyboard nav |
| S4.9 | `PastePreview.svelte` | ✅ Done | Large text confirm, image preview |
| S4.10 | `PermissionCard.svelte` | ✅ Done | Allow/Deny/Always Allow buttons |
| S4.11 | `PlanMode.svelte` | ✅ Done | Entry/exit banners, approve UI |
| S4.12 | `ProjectSwitcher.svelte` | ✅ Done | Dropdown, navigate to different slug |
| S4.13 | Storybook stories (16 files, ~62 stories) | ✅ Done | All feature components have stories with multiple variants |
| S4.14 | Lint fix — `Error` story names + template literals | ✅ Done | Renamed to `ErrorState`, biome-ignore for template strings in DiffView |

### Phase S5 — Overlays, Modals & Peripheral UI

| # | Item | Status | Notes |
|---|------|--------|-------|
| S5.1 | `ConnectOverlay.svelte` | ✅ Done | Pixel mascot scatter→settle animation, verb cycling with shimmer effect |
| S5.2 | `QrModal.svelte` | ✅ Done | `@castlenine/svelte-qrcode`, share URL with LAN host, copy-to-clipboard |
| S5.3 | `ConfirmModal.svelte` | ✅ Done | Promise-based from `uiState.confirmDialog`, backdrop + Escape close |
| S5.4 | `ImageLightbox.svelte` | ✅ Done | Fullscreen preview from `uiState.lightboxSrc`, dark backdrop |
| S5.5 | `Toast.svelte` | ✅ Done | Auto-dismiss, default + warn variants, slide-up animation |
| S5.6 | `InfoPanels.svelte` | ✅ Done | Usage/Status/Context panels, progress bar with color thresholds |
| S5.7 | `Banners.svelte` | ✅ Done | Update (green)/onboarding (orange)/skip-permissions (red) variants |
| S5.8 | `RewindBanner.svelte` | ✅ Done | Rewind mode banner + confirmation modal with radio modes |
| S5.9 | `NotifSettings.svelte` | ✅ Done | 3 toggle switches, localStorage persistence, push permission handling |
| S5.10 | Storybook stories (9 files, ~29 stories) | ✅ Done | All overlay components have stories with multiple variants |

### Phase S6 — Server-Rendered Pages → Svelte Components

| # | Item | Status | Notes |
|---|------|--------|-------|
| S6.1 | `pages/PinPage.svelte` | ✅ Done | Centered card, 4-8 digit PIN input, auto-submit at 8, lockout timer, POST /auth |
| S6.2 | `pages/SetupPage.svelte` | ✅ Done | Multi-step wizard (Tailscale/Certificate/PWA/Push/Done), platform detection, fetches /api/setup-info |
| S6.3 | `pages/DashboardPage.svelte` | ✅ Done | Project grid, fetches /api/projects, standalone PWA check, version footer |
| S6.4 | `App.svelte` routing | ✅ Done | Routes to PinPage, SetupPage, DashboardPage, ChatLayout based on pathname |
| S6.5 | `GET /api/auth/status` | ✅ Done | Returns `{ hasPin, authenticated }` — before auth check for client routing |
| S6.6 | `GET /api/projects` | ✅ Done | Returns project list JSON with slugs, paths, titles, version |
| S6.7 | `GET /api/setup-info` | ✅ Done | Returns `{ httpsUrl, httpUrl, hasCert, lanMode }` — replaces server-rendered setup data |
| S6.8 | Server routing changes | ✅ Done | `/`, `/setup`, `/auth` → serve `app.html` (Svelte SPA); unauthenticated → 302 redirect to `/auth`; removed `pages.ts` imports |
| S6.9 | Test updates | ✅ Done | 17 tests updated: dashboard/setup/PIN tests now test API endpoints + SPA shell serving instead of HTML content; 2618 total tests pass |
| S6.10 | Storybook stories (3 files, ~10 stories) | ✅ Done | PinPage (3), DashboardPage (3), SetupPage (4) |

### Phase S8 — Cutover & Cleanup

| # | Item | Status | Notes |
|---|------|--------|-------|
| S8.1 | Replace `index.html` with Svelte shell | ✅ Done | 38KB vanilla shell → 2KB Svelte shell (merged from `app.html`) |
| S8.2 | Delete `app.html` | ✅ Done | Content merged into `index.html` |
| S8.3 | Update `vite.config.ts` | ✅ Done | Removed `app` entry from rollupOptions, single `index` entry remains |
| S8.4 | Update `server.ts` references | ✅ Done | All `app.html` → `index.html` |
| S8.5 | Delete 37 vanilla `.ts` files | ✅ Done | All 37 frontend modules + `cdn-types.d.ts` removed from `src/lib/public/` |
| S8.6 | Delete 36 vanilla test files | ✅ Done | All 36 unit test files removed from `test/unit/` |
| S8.7 | Fix TypeScript DOM type errors | ✅ Done | Added `DOM`, `DOM.Iterable` to root tsconfig lib (needed by tests importing browser code) |
| S8.8 | Fix dead import in ConnectOverlay | ✅ Done | Replaced `import { randomThinkingVerb } from "../../icons.js"` with local function |
| S8.9 | Lint cleanup | ✅ Done | Fixed unused imports, template literal warnings |
| S8.10 | `pages.ts` removal | ✅ Done | `pages.ts` deleted. Daemon + server both delegate to `RequestRouter` which serves SPA shell. `onboarding.ts` also removed. |

---

## Phase 10: Feature Parity Enhancements

> Features from claude-relay that conduit doesn't have yet.

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 10.1 | Theme System | ⬜ | 12+ Base16 themes, custom themes, terminal/mermaid sync, FOUC prevention |
| 10.2 | Sidebar File Browser Integration | ⬜ | Move file browser from floating overlay into sidebar sub-panel |
| 10.3 | Live File Watching | ⬜ | fs.watch for auto-refresh file tree and file preview |
| 10.4 | In-App Auto-Update Execution | ⬜ | One-click "Update now" with hot daemon restart |
| 10.5 | Resume OpenCode CLI Sessions | ⬜ | Browse/resume sessions started in OpenCode CLI |
| 10.6 | Compaction Status Display | ⬜ | Show "Compacting conversation..." indicator |
| 10.7 | Session Draft Persistence | ⬜ | Save/restore unsent input per-session |
| 10.8 | Onboarding HTTP Server for TLS | ⬜ | HTTP server on port+1 for CA cert download |

## Phase 11: UI/UX Polish

> Bug fixes, missing functionality, and UI improvements identified during claude-relay comparison.

### High Priority

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 11.1 | Fix Image Attachment | ⬜ | File inputs have no onchange handler — images never sent |
| 11.2 | History Tool & Thinking Block Rendering | ✅ | Implemented historyToChatMessages() converter; HistoryView now renders via same components as live streaming |
| 11.13 | Fix InfoPanels Data Props | ⬜ | Usage/Status/Context panels always show "--" (no data piped) |

### Medium Priority

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 11.3 | Terminal Mobile Touch Toolbar | ⬜ | CSS exists but no component renders it; implement Tab/Ctrl/Esc/arrow keys |
| 11.4 | Empty State for New Chat | ⬜ | Blank message area when no messages; add welcome/hint state |
| 11.5 | Keyboard Shortcuts | ⬜ | Cmd/Ctrl+B (sidebar), +` (terminal), +N (new session), +Shift+F (files), Escape |
| 11.6 | Favicon & Tab Title Activity Indicators | ⬜ | Color cycling favicon, "⚠ Input needed" title prefix |
| 11.7 | Mermaid Diagram Modal + PNG Export | ⬜ | Click to zoom, download as PNG |

### Low Priority

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 11.8 | RTL Text Support | ⬜ | dir="auto" for Arabic/Hebrew text |
| 11.9 | iOS PWA Guided Install Flow | ⬜ | "Add to Home Screen" instructions for iOS Safari |
| 11.10 | Tool Shimmer Animation | ⬜ | Apply existing CSS shimmer to running tool items |
| 11.11 | Double-Click/Tap to Copy Messages | ⬜ | Quick copy entire assistant message |
| 11.12 | Notification Sounds | ⬜ | Web Audio API sine wave for done/permission events |
| 11.14 | Responsive Content Width | ⬜ | Wider max-w on large screens (>1280px) |
| 11.15 | Permission Notification Urgency | ⬜ | Browser Notification API for permissions (in addition to push) |

---

## Milestone Roadmap

| Milestone | Tickets | Status |
|-----------|---------|--------|
| **M1 — Walking Skeleton** | 0.1–0.5, 0.7 | ✅ Complete |
| **M2 — Proof of Concept** | 0.6, 1.0–1.4, 2.1–2.2 | ✅ Complete |
| **M3 — Functional Relay** | 1.5–1.6, 2.3–2.4, 4.1–4.2 | ✅ Complete |
| **M4 — Feature Parity** | 4.3–4.12, 2.7, 5.1–5.2, 5.5 | ✅ Complete |
| **M5 — Production Ready** | 3.1–3.6, 2.5–2.6, 6.1–6.3 | 🟡 6.1-6.2 done. 6.3 (docs) remaining. |
| **M6 — OpenCode Extras** | 5.3–5.4, 5.6–5.10 | 🟡 5.3 done. 5.4, 5.6–5.10 remaining. |
| **M7 — UI Parity** | 7.0–7.18 | ✅ Complete |
| **M8 — Full Feature Parity** | 8.0–8.25 | ✅ Complete |
| **M9 — Svelte 5 Migration** | S0–S8 | ✅ Complete (S0–S6 + S8 done. S7 skipped — visual parity validated via Storybook stories. pages.ts deleted, daemon fully on SPA.) |
| **M10 — Feature Parity Enhancements** | 10.1–10.8 | ⬜ Not started |
| **M11 — UI/UX Polish** | 11.1–11.15 | ⬜ Not started |

---

## What's Next — Recommended Priority

1. 6.3 — Documentation
2. 11.1 — Fix Image Attachment (non-functional, high priority bug)
3. ~~11.2 — History Tool & Thinking Block Rendering~~ ✅ DONE
4. 11.13 — Fix InfoPanels Data Props (panels always show "--")
5. 10.1 — Theme System (dark mode + 12 themes)
6. 10.2 — Sidebar File Browser Integration (move from overlay to sidebar)
7. 5.3–5.4, 5.6–5.10 — Session Forking, Rewind, Sharing, Search, MCP, Summarisation, Diff Viewer
8. Remaining M10/M11 tickets by priority

---

## Stats

| Metric | Value |
|--------|-------|
| Production code | ~15,600 lines across 60 server modules |
| Svelte frontend | ~12,400 lines across 102 modules (8 stores, 8 utils, 41 components, 3 pages, types, App, 41 story files, mocks) |
| Frontend bundle | 379KB JS + 64KB CSS (Svelte 5 SPA) |
| Test code (unit/fixture) | ~16,000 lines across 56 test files |
| Test code (integration) | ~1,200 lines across 8 test files + 2 helpers |
| Test code (contract) | ~680 lines across 7 test files |
| Storybook stories | 41 story files, ~153 stories total |
| Tests passing (unit/fixture) | 1481 / 1481 |
| Tests passing (integration) | 108 / 108 |
| Tests (Playwright E2E) | 280 across 9 spec files × 5 viewports |
| Tests total | 1869 (1481 unit + 108 integration + 280 E2E) |
| Test duration (unit) | ~3.6s |
| Test duration (integration) | ~91s |
| E2E test code | ~1,950 lines across 21 files (3 helpers, 9 page objects, 9 specs) |
| Type-check | Clean (tsc --noEmit) |
| Docker image | Node 20 Alpine, ~60MB, healthcheck |
| Docker Compose | Self-contained: official OpenCode image + relay, no host deps |
| Svelte migration | ✅ Complete (S0–S8). 37 vanilla modules + 36 vanilla test files deleted. |
| Tickets complete | 49 / 50 (6.3 remaining) + 20/20 Phase 7 + 26/26 Phase 8 |

---

## New Files Created This Session

| File | Lines | Purpose |
|------|-------|---------|
| `src/lib/opencode-client.ts` | ~310 | REST API client for OpenCode (40+ typed methods) |
| `src/lib/sse-consumer.ts` | ~210 | SSE HTTP client with reconnection, event filtering |
| `src/lib/server.ts` | ~310 | HTTP server: static files, auth, project routing |
| `src/lib/ws-handler.ts` | ~210 | WebSocket I/O layer with client tracking |
| `src/lib/public/index.html` | ~120 | Mobile-friendly chat UI template |
| `src/lib/public/main.ts` | ~200 | Frontend WebSocket client + message rendering |
| `src/lib/public/tsconfig.json` | ~15 | Frontend-specific TypeScript config (DOM types) |
| `src/skeleton.ts` | ~200 | Walking skeleton — end-to-end vertical slice |
| `vite.config.ts` | ~25 | Vite build config with dev proxy |
| `test/unit/opencode-client.pbt.test.ts` | ~185 | REST client tests (12 tests) |
| `test/unit/sse-consumer.pbt.test.ts` | ~210 | SSE consumer tests (7 tests) |
| `test/unit/server.pbt.test.ts` | ~170 | HTTP server tests (11 tests) |
| `test/unit/ws-handler.pbt.test.ts` | ~210 | WebSocket handler tests (8 tests) |

---

## Session Log

### 2026-02-22 — Session 1
- Created PROGRESS.md
- Assessed all 44 tickets against actual implementation
- Identified next work: 0.4 (Vite) → 0.7 (walking skeleton) → M2 server layer

### 2026-02-22 — Session 2
- **Ticket 0.4**: Created Vite config, frontend HTML entry point, frontend main.ts, separate tsconfig for browser code
- **Ticket 1.4**: Implemented full REST API client (`opencode-client.ts`) with 40+ typed methods, retry logic, auth
- **Ticket 1.2**: Implemented SSE event consumer (`sse-consumer.ts`) with fetch-based streaming, reconnection, session filtering
- **Ticket 2.1**: Implemented HTTP server (`server.ts`) with static file serving, PIN auth, CORS, slug-based project routing
- **Ticket 2.2**: Implemented WebSocket handler (`ws-handler.ts`) with client tracking, broadcast, heartbeat, message routing
- **Ticket 0.7**: Built walking skeleton (`skeleton.ts`) wiring all components end-to-end
- Added Vite as dev dependency, updated package.json scripts
- Wrote 38 new tests across 4 test files (opencode-client, sse-consumer, server, ws-handler)
- All 181 tests passing, type-check clean, lint clean
- M1 and M2 milestones complete

### 2026-02-22 — Session 3 (continued)
- **M4 Wave 2 — Phase 2 Backend Prep**: Added `get_projects`, `get_file_list`, `get_file_content` to ws-router; added `listDirectory()`, `getFileContent()`, `getFileStatus()` to opencode-client; added `FileEntry`, `FileContentResult` types; created stubs and main.ts imports
- **Ticket 4.9**: Slash Command Autocomplete — `command-ui.ts` ~270 lines, keyboard nav (ArrowUp/Down/Enter/Escape), mouse click, prefix filtering, lazy fetch, 26 tests
- **Ticket 4.10**: Image & Paste Preview — `paste-ui.ts` ~340 lines, clipboard paste handling, drag-drop with drop zone, large text modal, thumbnail preview bar with remove buttons, 36 tests
- **Ticket 4.11**: Thinking Visualisation — already implemented in `chat.ts` (animated spinner, collapsible thinking blocks, streaming text, "Thought" end state). Marked as done.
- **Ticket 4.12**: Project Switcher — `project-ui.ts` ~245 lines, header dropdown with slug-based routing, multi/single project modes, outside-click close, 21 tests
- **Ticket 4.4**: File Browser — `filebrowser-ui.ts` ~500 lines, slide-in panel from right, directory tree with breadcrumbs, file preview modal with line numbers, binary detection, collapse-by-default for node_modules, directory caching, 68 tests
- All 515 tests passing across 32 test files, TypeScript clean, Biome clean
- 33/44 tickets complete

### 2026-02-22 — Session 3
- **Skeleton smoke test**: Added `test/unit/skeleton.smoke.test.ts` — 12 tests covering imports, constructors, API surfaces, EADDRINUSE handling, and full end-to-end wiring
- **EADDRINUSE fix**: skeleton.ts now catches port-in-use with actionable guidance instead of raw stack trace
- **Ticket 2.3**: Implemented `session-manager.ts` — SessionManager class with create/switch/delete/rename/search/history, 16 PBT tests
- **Ticket 4.1**: Full chat UI rewrite — markdown streaming via `marked`, code blocks with copy, thinking blocks, tool display with collapsible results, auto-scroll with "Latest" button, session selector, cost display, stop button
- **Tailwind CSS**: Converted all CSS to Tailwind v4 (CSS-first with `@theme` tokens), installed `tailwindcss` + `@tailwindcss/vite`
- **Ticket 4.2**: Permission approval UI — Allow/Always Allow/Deny cards, resolved state display, always-allow tracking, title blink on pending permissions, mobile-friendly buttons
- All 209 tests passing, frontend builds to 53KB JS + 19KB CSS
- M3 milestone complete

### 2026-02-22 — Session 4 (Wave 1 — 5 parallel agents, 7 tickets)
- **Ticket 0.6**: CI/CD Pipeline — `.github/workflows/ci.yml` (GitHub Actions: checkout, setup-node, pnpm, cache, check, lint, test, build), `lefthook.yml` (pre-commit: lint + typecheck), `@evilmartians/lefthook` devDependency, `prepare` script, 16 tests in `ci.test.ts`
- **Ticket 2.6**: Onboarding HTTP Redirect — `onboarding.ts` ~130 lines, `OnboardingServer` class + exported `handleRequest()` for testing, HTTP->HTTPS 301 redirect preserving path/query, `/cert-help` HTML page with iOS + Android instructions, 20 tests in `onboarding.test.ts`
- **Ticket 4.6**: PWA & Push Notifications — `push.ts` ~200 lines (server-side VAPID key management, subscription tracking, push delivery with auto-cleanup), `notifications.ts` ~120 lines (preference management, service worker registration, push subscription), `sw.ts` ~140 lines (app shell caching, network-first with cache fallback, push event handling, notification click), `manifest.json` (PWA manifest with SVG icons), updated `index.html` with manifest link. 47 tests across `push.test.ts` (27) and `notifications.test.ts` (20)
- **Ticket 1.1**: OpenCode Process Manager — `opencode-process.ts` ~230 lines, `OpenCodeProcess` class extending EventEmitter. Spawns `opencode serve` as detached child, health-check polling with exponential backoff, existing-instance detection, crash recovery, graceful shutdown (SIGTERM → 5s → SIGKILL), port conflict detection. 36 tests in `opencode-process.test.ts`
- **Ticket 2.7**: PTY WebSocket Proxy — `pty-proxy.ts` ~280 lines, `PtyProxy` class extending EventEmitter. Bidirectional WebSocket proxy between browser and OpenCode PTY endpoint (`/pty/:ptyID/connect`). Resize forwarding, HTTP Basic Auth, cursor-based reconnection, 5+ concurrent proxies. 19 tests in `pty-proxy.test.ts`
- **Ticket 3.1**: Daemon Process — `daemon.ts` ~490 lines, `Daemon` class with HTTP+IPC server. Crash counter (3 in 60s → give up), signal handlers (SIGTERM/SIGINT/SIGHUP), PID file lifecycle, stale detection, `buildSpawnConfig()`, project CRUD with slug generation. 43 tests in `daemon.test.ts` including IPC integration via real Unix socket
- All 696 tests passing across 39 test files, type-check clean
- 39/44 tickets complete

### 2026-02-22 — Session 5 (Wave 2 — 4 parallel agents, 4 tickets)
- **Ticket 4.5**: Terminal Tabs — `terminal-ui.ts` ~426 lines. `TerminalAdapter` interface decouples from xterm.js for testability. `initTerminalTabs()` returns `TerminalTabs` with `handleMessage()`, `createTab()`, `closeTab()`, `switchTab()`, `getTabCount()`, `destroy()`. WS message protocol: `pty_create`, `pty_created`, `pty_input`, `pty_output`, `pty_resize`, `pty_close`, `pty_exited`, `pty_deleted`. Max 10 tabs, auto-close panel when last tab closes. 62 tests in `terminal-ui.test.ts` (jsdom environment).
- **Ticket 3.3**: CLI Interface — `cli-core.ts` ~556 lines with all testable logic (`parseArgs()`, `run()`, `sendIPCCommand()`, `getNetworkAddress()`, `generateQR()`). Thin entry point `cli.ts` ~10 lines. Fully injectable via `CLIOptions` for testing. Supports: `--status`, `--stop`, `--pin`, `--add`, `--remove`, `--list`, `--title`, `--port`, `--oc-port`, `--no-update`, `--debug`, `--help`. 82 tests in `cli.test.ts` including 7 PBT properties.
- **Ticket 3.4**: Version Check — `version-check.ts` ~190 lines, `VersionChecker` class with periodic npm registry checks, `isNewer()` semver comparison, injectable fetch. 47 tests in `version-check.test.ts` including PBT.
- **Ticket 3.5**: Keep-Awake Management — `keep-awake.ts` ~135 lines, `KeepAwake` class. Spawns `caffeinate -di` on macOS, no-op on other platforms. 38 tests in `keep-awake.test.ts` including PBT state machine tests.
- All 925 tests passing across 43 test files, type-check clean, lint clean
- M4 complete, M5 Phase 3 complete. 43/44 tickets done.

### 2026-02-22 — Session 7 (Ticket 1.0 — API Contract Tests)
- **Ticket 1.0**: API Contract Tests against live OpenCode v1.2.6 instance
- **Infrastructure**: `vitest.contract.config.ts` (separate vitest config with sequential pool), `.opencode-version` (pinned to 1.2.6), `test:contract` npm script, `test/fixtures/opencode-api-snapshot.json` (135KB OpenAPI spec snapshot)
- **Helpers**: `test/contract/helpers/server-connection.ts` (~160 lines: health check, apiGet/Post/Patch/Delete, SSE connect, version pinning), `test/contract/helpers/session-helpers.ts` (~130 lines: create/delete test sessions, message retrieval, SSE event collection)
- **AC7 — Version Pinning**: 4 tests — `.opencode-version` validation, server connectivity, version match, health endpoint shape (`{ healthy, version }` not `{ ok, version }`)
- **AC2 — REST Endpoints**: 25 tests — health, path, sessions (list/create/get/patch/messages), agents (shape: `name` identifier, no `id`), providers (shape: `{ all, default, connected }` where `all` is array not keyed-object), commands, permissions, questions, config, doc, projects, PTY, VCS, session status
- **AC1 — SSE Events**: 6 tests — global stream (`/global/event` wraps in `{ payload }`) vs project stream (`/event` direct `{ type, properties }`), `server.connected` shape, wire format validation
- **AC5 — OpenAPI Snapshot**: 10 tests — no endpoint removals, no method removals, no schema removals, core endpoint existence, session sub-endpoint existence, permission/question reply patterns, new endpoint reporting
- **AC3 — Permission Flow**: 6 tests — empty-state array, OpenAPI spec endpoint/body validation, schema existence
- **AC4 — Question Flow**: 7 tests — empty-state array, reply/reject endpoints in spec, schema existence
- **AC6 — Tool State Machine**: 10 tests — message part schema, part type definitions, event types, tool status values (`pending/running/completed/error`), message/part endpoints, prompt/abort endpoints
- **API shape discrepancies found**: (1) health returns `{ healthy }` not `{ ok }`, (2) providers `all` is array not keyed-object, (3) agents have no `id` field (name is identifier), (4) `/doc` not listed in its own spec, (5) agent `description` field is optional
- All 68 contract tests passing across 7 files, all 1086 unit tests still passing
- **44/44 tickets complete**

### 2026-02-22 — Session 6 (Test Quality Audit)
- **Audit**: Comprehensive test quality audit across all 45 production modules. Identified coverage theatre (inline code duplication, tautology tests), untested production files, critical untested behaviors, and a production bug.
- **Coverage theatre fixed**: Session-UI and notifications tests rewrote to import from production modules instead of duplicating functions inline. Removed tautology tests in opencode-client (P7 circular assertion) and sse-consumer (P6 trivial check). Removed duplicate getPort tests from onboarding.
- **Security tests added**: Directory traversal protection tests for server.ts (raw paths, encoded paths, property-based pattern testing). WS-handler heartbeat test (P7: terminates dead connections, emits client_disconnected).
- **Production bug fixed**: `daemon.ts` IPC socket error handler removed client from `ipcClients` but never decremented `clientCount`. Fixed with cleanup guard pattern preventing double-decrement when both `error` and `close` fire.
- **Core behavior tests**: question-bridge timeouts/remove/convertAnswers (+17 tests), ws-router all 23 message types + drift guard (+13 tests), event-translator PTY/file events (+24 tests), auth getRemainingAttempts/lockout expiry (+9 tests).
- **Resilience tests**: opencode-client retry 5xx/no-retry 4xx/normalization (+6 tests), sse-consumer connect idempotency/HTTP 403/isConnected (+3 tests), pty-proxy HTTPS→WSS/CLOSING state (+2 tests), push corrupted vapid.json (+2 tests), keep-awake spawn throws (+1 test), onboarding EADDRINUSE (+1 test).
- **CLI/daemon gaps**: CLI parseArgs edge cases, IPC error paths (+9 tests), daemon IPC command routing integration (remove_project, set_project_title, shutdown, invalid JSON, HTTP endpoint) (+5 tests), opencode-process restart window expiry/health check 500 (+3 tests), version-check edge cases (+5 tests).
- **Frontend behavioral tests**: NEW `permissions-ui.test.ts` (12 tests: card rendering, Allow/Deny/Always Allow clicks, auto-approve, resolved state). NEW `ws-client.test.ts` (9 tests: connection URL, status callbacks, reconnection timing, message handlers). Command-UI keyboard navigation tests (ArrowUp/Down/Enter/Escape). Session-UI tests using production imports. Notifications tests using production imports.
- **TypeScript fixes**: NodeListOf iterator issues in `history-ui.ts` and `permissions-ui.test.ts` (Array.from wrapping). BufferSource type cast in `notifications.ts`.
- All 1086 tests passing across 45 test files, type-check clean
- Test count: 925 → 1086 (+161 tests). Test files: 43 → 45 (+2 new files).

### 2026-02-22 — Session 8 (Integration Tests + Docker + Bug Fixes)
- **Bug fixes discovered via integration testing**:
  - **Bug A**: `sendMessageAsync` sent `{ text }` instead of `{ parts: [{ type: "text", text }] }` → 400 errors from OpenCode. Fixed in `opencode-client.ts`.
  - **Bug B**: 13 of 23 WebSocket message types had no handler in skeleton.ts → silently dropped. Fixed by wiring all handlers.
  - **Bug C**: No initial state (agents, models, providers) sent on client connect → broken UI. Fixed in `relay-stack.ts`.
  - **Bug D**: `listProviders()` expected array but OpenCode returns `{ all: [...] }` → always empty providers. Fixed.
  - **Bug E**: `listDirectory()` called `GET /file` without required `path` param → 400 error. Fixed to default to `"."`.
  - **Bug F**: Provider `models` is `Record<string, Model>` (keyed object), not array → `.map()` crash. Fixed with `Object.values()`.
- **Refactoring**: Extracted `relay-stack.ts` (~580 lines) from `skeleton.ts` → thin CLI wrapper (~60 lines). Tests use exact same wiring as production.
- **Integration test infrastructure**: `test-ws-client.ts` (typed WS test client with `waitFor`, `waitForInitialState`), `relay-harness.ts` (starts real relay on port 0, silenced logs, auto-cleanup)
- **51 integration tests across 8 files** — all against real OpenCode, no mocks:
  - `initial-state.integration.ts` (6) — Bug C: session, status, agents, models on connect
  - `send-message.integration.ts` (3) — Bug A: real prompt, streaming deltas, no 400 errors
  - `ws-handler-coverage.integration.ts` (12) — Bug B: all 12 handler types verified
  - `session-lifecycle.integration.ts` (8) — create, switch, rename, delete, search
  - `multi-client.integration.ts` (5) — broadcast, input sync, disconnect isolation
  - `error-handling.integration.ts` (5) — invalid JSON, unknown types, graceful degradation
  - `sse-to-ws-pipeline.integration.ts` (6) — SSE → translator → WS broadcast, multi-client
  - `discovery-endpoints.integration.ts` (6) — data quality: agents, providers, commands, files
- **Docker**: `Dockerfile` (multi-stage: deps → build → frontend → production), `.dockerignore`, env var support in skeleton.ts
- **Docker Compose**: Self-contained stack using official `ghcr.io/anomalyco/opencode` image + relay. `docker compose up` spins up both OpenCode server (port 4096) and relay (port 2633) with no external dependencies. Healthcheck on OpenCode ensures relay starts only after OpenCode is ready.
- **Vitest config**: `vitest.integration.config.ts` (sequential forks pool, 30s timeout), `test:integration` and `test:all` scripts
- All 1088 unit + 51 integration tests passing, type-check clean, Docker image builds and runs
- Bugs D/E/F discovered and fixed through integration testing — exactly what the tests were designed to catch

### 2026-02-22 — Session 9 (Ticket 7.7 — Syntax Highlighting & Mermaid)
- **Ticket 7.7**: Syntax Highlighting & Markdown Safety
- **New file**: `src/lib/public/markdown.ts` (~99 lines) — `highlightCodeBlocks()` calls hljs on unprocessed `pre code` elements (skips `.hljs`, `.language-mermaid`, `.tool-result`), `renderMermaidBlocks()` replaces mermaid code blocks with SVG diagrams (error fallback with red border + hint), `initMermaid()` configures dark theme matching design system
- **Updated**: `src/lib/public/chat.ts` — imports `highlightCodeBlocks` and `renderMermaidBlocks` from `markdown.js`, calls both after `addCodeBlockHeaders` in the debounced render callback
- **CSS**: Added mermaid diagram styles to `style.css` — `.mermaid-diagram` (centered SVG container), `.mermaid-error` (red border), `.mermaid-error-hint` (italic error text)
- **Tests**: `test/unit/markdown.test.ts` — 17 tests covering all exported functions: hljs highlighting (7 tests: basic, skip .hljs, skip mermaid, skip .tool-result, undefined hljs, multiple blocks, no-lang blocks), mermaid rendering (6 tests: SVG replacement, error styling, undefined mermaid, skip rendered, calls initMermaid, unique IDs), initMermaid (4 tests: calls once, no double-init, undefined mermaid, re-init after reset)
- All 1158 tests passing (49 test files), type-check clean

### 2026-02-22 — Session 10 (Ticket 7.12 — Enhanced Tool Display)
- **Ticket 7.12**: Enhanced Tool Display — Diff Viewer
- **New file**: `src/lib/public/diff.ts` (~105 lines) — `DiffOp` interface, `computeDiff()` LCS-based diff algorithm with backtracking, `renderUnifiedDiff()` HTML renderer with line numbers/gutters/markers/colored add/remove, `diffStats()` addition/deletion counter, `escapeHtml()` XSS protection
- **CSS**: Appended diff viewer styles to `style.css` — `.diff-viewer` (mono font, code bg, border-radius), `.diff-line` (flex row), `.diff-gutter` (line numbers, old/new columns), `.diff-marker` (+/-/space), `.diff-text`, `.diff-add` (green bg), `.diff-remove` (red bg), `.diff-equal` (secondary text), `@keyframes tool-shimmer` animation, `.tool-activity-shimmer` (gradient text effect)
- **Tests**: `test/unit/diff.test.ts` — 13 tests: computeDiff (6: empty, identical, all-add, all-remove, mixed, single-line), renderUnifiedDiff (5: structure, add class, remove class, equal class, HTML escaping), diffStats (2: correct counts, identical=zero)
- All 13 tests passing, type-check clean

### 2026-02-22 — Session 11 (Ticket 7.3 — Sidebar Content Parity)
- **Ticket 7.3**: Sidebar Content Parity
- **Rewritten**: `src/lib/public/session-ui.ts` (~420 lines) — migrated from dynamic `buildSidebar()` HTML to static DOM elements. New features: action buttons (New session, Resume with ID, File browser, Terminal), three-dot context menu (Rename/Copy resume command/Delete) with click-outside-close, processing indicator (pulsing orange dot), "Sessions" header with search icon toggle, inline rename (Enter saves, Escape cancels, blur commits), file browser panel switching. Exports: `buildContextMenuItemHtml()`, `buildResumeCommand()`, `closeContextMenu()`, `startInlineRename()`
- **Updated**: `src/lib/public/index.html` — sidebar nav restructured with `#sidebar-panel-sessions` (action buttons, session list header, search box, session list) and `#sidebar-panel-files` (back button, refresh, file tree)
- **CSS**: Replaced Session Sidebar section in `style.css` (~330 lines) — `.sidebar-panel`, `#session-actions`/`.session-action-btn`, `.session-list-header`, `.session-search`, `.session-processing-dot` (pulse animation), `.session-more-btn`, `.session-context-menu`/`.session-ctx-item`, `#file-panel-header`/`.file-panel-back-btn`
- **Tests**: 28 new tests added to `session-ui.test.ts` (58 total, 30 existing preserved): `buildContextMenuItemHtml` (3), `buildResumeCommand` (3), `closeContextMenu` (2), action buttons (4), search toggle (4), file panel switch (2), inline rename (6), processing indicator (1), session list structure (3)
- All 1523 tests passing across 58 test files, type-check clean (pre-existing xterm-adapter errors only)

### 2026-02-23 — Session 12 (Ticket 7.0 — Playwright E2E Infrastructure)
- **Ticket 7.0**: Playwright E2E Infrastructure — 175 tests across 5 viewports, real OpenCode (no mocks), free-tier model
- **Dependency**: `@playwright/test` ^1.58.2, Chromium browser installed
- **Infrastructure** (3 helpers + 1 config):
  - `test/e2e/helpers/e2e-harness.ts` (~113 lines) — starts real relay via `createRelayStack()` pointed at real OpenCode (localhost:4096), switches to free-tier model (gemini-2.0-flash/google) via temporary WS `switch_model` message, auto-cleanup on stop
  - `test/e2e/helpers/test-fixtures.ts` (~32 lines) — Playwright custom `test.extend()` with worker-scoped `harness`/`baseUrl` and test-scoped `isNarrow` (viewport < 769px), checks OpenCode availability before starting
  - `test/e2e/helpers/viewport-presets.ts` (~24 lines) — 5 viewport definitions with `isMobileViewport()`/`isTabletViewport()`/`isDesktopViewport()` helpers
  - `test/e2e/playwright.config.ts` (~44 lines) — 5 projects (iPhone 15/17, Pixel 7, iPad Pro 11, Desktop 1440x900), Chromium-only, sequential (workers: 1), 30s timeout, trace/screenshot/video on failure
- **Page Objects** (7 files, ~380 lines total):
  - `app.page.ts` (88) — header, sidebar, input, status dot, `goto()`, `waitForConnected()`, `sendMessage()`, `isMobileViewport()`
  - `chat.page.ts` (55) — messages, streaming, `waitForUserMessage()`, `waitForAssistantMessage()`, `getLastAssistantText()`, `waitForStreamingComplete()`
  - `sidebar.page.ts` (73) — session list, actions, search, file browser panel, `getSessionCount()`, `createNewSession()`, `searchSessions()`
  - `permission.page.ts` (36) — permission cards, Allow/Deny/Always Allow buttons
  - `modal.page.ts` (37) — confirm dialog, lightbox, rewind modal, QR overlay
  - `input.page.ts` (52) — textarea, send/stop button, attach menu, context mini-bar
  - `overlay.page.ts` (39) — connection overlay, banners, notification menu
- **Test Specs** (6 files, ~731 lines, 35 tests x 5 viewports = 175 total):
  - `smoke.spec.ts` (78) — 4 tests: page load+connect, input area, session list, header elements
  - `chat.spec.ts` (105) — 5 tests: send message, streamed response, stop button, markdown rendering, code blocks (90s timeout)
  - `permissions.spec.ts` (73) — 2 tests: permission card on tool use, card structure (120s timeout)
  - `sessions.spec.ts` (133) — 5 tests: session list, create, search, action buttons, file browser panel
  - `sidebar-layout.spec.ts` (121) — 6 tests: desktop sidebar visible/toggle, mobile hidden/hamburger/overlay close, header elements
  - `ui-features.spec.ts` (221) — 13 tests: connection overlay, attach menu, input state, modals, info panels, notification settings, slash commands, todo overlay
- **npm scripts**: `test:e2e`, `test:e2e:ui`, `test:e2e:headed`, `test:e2e:debug`
- **Key decisions**: Real OpenCode (user requested no mocks), free-tier model via env vars (`E2E_MODEL`/`E2E_PROVIDER`), `isNarrow` fixture (avoids Playwright built-in `isMobile` conflict), `test.describe.configure({ timeout })` for Playwright timeouts
- TypeScript clean, all 175 E2E tests discoverable, requires running OpenCode server
- **M7 UI Parity milestone complete** (20/20 tickets)

### 2026-02-23 — Session 13 (Ticket 8.0 — Terminal Rendering Engine)
- **Ticket 8.0**: Terminal Rendering Engine
- **New file**: `src/lib/terminal-render.ts` (~147 lines) — pure-function terminal rendering primitives ported from `claude-relay/bin/cli.js` lines 200-245. ANSI constants object `a` (reset/bold/dim/cyan/green/yellow/red), `isBasicTerm()` with injectable env, `gradient()` with RGB interpolation (#DA7756 -> #D4A574) and basic-term yellow fallback, `sym` object (pointer/done/bar/end/warn with Unicode + ANSI), `clearUp()` with injectable stdout, `log()` with 2-space indent, `formatStatusLine()` with dimmed middle-dot separator, `wrapColor()` with reset suffix. All functions accept injectable dependencies for testing.
- **New file**: `test/unit/terminal-render.test.ts` (~218 lines) — 25 tests across 9 describe blocks: gradient basic output (5), symbols (5), clearUp (3), log (2), isBasicTerm (2), gradient fallback (3), formatStatusLine (3), wrapColor (2)
- All 25 tests passing, TypeScript type-check clean, Biome lint clean

### 2026-02-23 — Session 14 (Ticket 8.3 — Config Persistence Module)
- **Ticket 8.3**: Config Persistence Module
- **New file**: `src/lib/config-persistence.ts` (~120 lines) — `DaemonConfig` and `CrashInfo` interfaces, `loadDaemonConfig()` / `saveDaemonConfig()` with atomic writes (tmp+rename), `clearDaemonConfig()` removes daemon.json/relay.sock/daemon.pid, `readCrashInfo()` / `writeCrashInfo()` / `clearCrashInfo()` for crash.json, `syncRecentProjects()` integrating with existing `recent-projects.ts` module (addRecent/deserializeRecent/serializeRecent), `getConfigDir()` returning `~/.conduit`
- **Tests**: `test/unit/config-persistence.test.ts` — 21 tests across 6 describe blocks: loadDaemonConfig (4), saveDaemonConfig (4), clearDaemonConfig (2), CrashInfo (4), syncRecentProjects (6), getConfigDir (1). All use temp directories via `mkdtempSync`, cleaned up in afterEach
- All 21 tests passing, TypeScript clean, Biome clean

### 2026-02-23 — Session 15 (Ticket 8.2 — TLS Certificate Management)
- **Ticket 8.2**: TLS Certificate Management
- **New file**: `src/lib/tls.ts` (~277 lines) — 7 exported functions: `isRoutableIP()` (private/CGNAT range detection for 10.x, 192.168.x, 172.16-31.x, 100.64-127.x), `getAllIPs()` (routable IPv4 from network interfaces), `getTailscaleIP()` (tailscale0/utun preference with 100.x fallback), `hasTailscale()`, `hasMkcert()` (mkcert availability check), `getMkcertCaRoot()` (CA root path), `ensureCerts()` (main function: generate/validate/regenerate mkcert certs with openssl SAN validation). All functions accept injectable dependencies via `TlsOptions` (exec, fs, networkInterfaces, configDir) for full testability without real mkcert/openssl. Types: `TlsCerts`, `TlsFs`, `TlsOptions`.
- **New file**: `test/unit/tls.test.ts` (~580 lines) — 32 tests: isRoutableIP (8: private ranges true, public false, boundary cases), getAllIPs (4: routable collection, loopback filtering, empty handling), getTailscaleIP (4: tailscale0 preference, utun fallback, 100.x fallback, null), hasTailscale (3: true/false/passthrough), hasMkcert (3: success/throws/command verification), getMkcertCaRoot (2: trimmed path/null), ensureCerts (8: no mkcert returns null, first run generates, existing match reuses, IP change regenerates, mkdir on missing, correct TlsCerts shape, exec failure graceful, domain list complete)
- All 32 tests passing, type-check clean (tsc --noEmit), lint clean (biome check)

### 2026-02-23 — Session 16 (Tailwind CSS Migration Phase 4 — Message Display & Tool Styles)
- **Phase 4.1**: Message Display CSS to Tailwind — converted `.msg-user`, `.msg-user .bubble`, `.msg-assistant`, `.msg-copy-hint`, `.turn-meta` from CSS rules to inline Tailwind utility classes. State classes (`copy-primed`, `copy-done`) now toggle Tailwind classes directly in JS (`bg-white/[0.04]`, `cursor-pointer`, `bg-[rgba(87,171,90,0.06)]`, `opacity-100`, `text-accent`, `text-success`). Touch variant via `touch:opacity-100`. Group hover via `group-hover:opacity-100`.
- **Phase 4.2**: Tool/Thinking/Permission/Send/Code styles to Tailwind — converted `.tool-item`, `.tool-header`, `.tool-chevron`, `.tool-bullet`, `.tool-name`, `.tool-desc`, `.tool-subtitle`, `.tool-connector`, `.tool-result`, `.tool-status-icon`, `.thinking-item`, `.thinking-header`, `.thinking-chevron`, `.thinking-spinner`, `.thinking-duration`, `.thinking-content`, `.permission-card`, `.send-btn`, `.code-header`, `.code-copy-btn`. Used `group` on parent elements with `group-[.expanded]:rotate-90`, `group-[.expanded]:block`, `group-[.done]:hidden` variants. Bullet status uses Tailwind color classes (`bg-text-muted`, `bg-accent animate-pulse-dot`, `bg-success`, `bg-error`). Send button stop state uses `!bg-error`.
- **Files modified**: `style.css` (~280 lines of CSS removed), `chat.ts` (all element creation updated with Tailwind classes), `main.ts` (user message + send button stop toggle), `index.html` (send button), `permissions-ui.ts` (permission-card)
- **Preserved**: `md-content` markdown styles untouched, semantic class names kept as hooks for querySelector/e2e tests
- All 1688 tests passing, build clean, lint clean

### 2026-02-23 — Session 17 (Tailwind CSS Migration Phase 5 — Session Sidebar & Agent Selector)
- **Phase 5.1**: Session Sidebar CSS to Tailwind — converted ~400 lines of `@layer components` CSS to inline Tailwind utility classes. Updated `session-ui.ts` (all dynamic elements: `.session-context-menu`, `.session-ctx-item`, `.session-ctx-delete`, `.session-empty`, `.session-group-label`, `.session-item` with active variant, `.session-processing-dot`, `.session-item-title`, `.session-item-meta`, `.session-more-btn` with group-hover/touch visibility, `.session-rename-input`). Updated `index.html` (static elements: `#sidebar-panel-sessions`, `#session-actions`, `.session-action-btn` ×4, `.session-list-header`, search button with `[&.active]`, `.session-search` + input with focus, `#session-list`, `#sidebar-panel-files`, `#file-panel-header`, `.file-panel-back-btn`, refresh button, `#file-tree`). Used `group`/`group-hover:opacity-100` for more-button reveal, `touch:opacity-100` for mobile, `[&_.lucide]` for icon sizing, `[&_span]` for text truncation.
- **Phase 5.2**: Agent Selector CSS to Tailwind — converted ~70 lines of `@layer components` CSS to inline Tailwind utility classes. Updated `agent-ui.ts`: `.agent-selector` (flex container), `.agent-tab` (pill button with hover/active states, `max-sm:` prefix for mobile responsive), `.agent-tab-label` (pointer-events-none). Mobile `.agent-selector { display: none; }` rule in general responsive section preserved.
- **CSS removed**: Both `@layer components` blocks (~470 lines total) removed from `style.css`. Preserved: `@keyframes session-slide-in`, `@keyframes session-fade-in`, `.session-search input::placeholder` rule, mobile `.agent-selector { display: none; }` rule.
- **Tests updated**: `session-ui.test.ts` session-search element setup updated to include Tailwind classes.
- **Files modified**: `style.css`, `session-ui.ts`, `agent-ui.ts`, `index.html`, `session-ui.test.ts`
- All 1688 tests passing, build clean, lint clean

### 2026-02-23 — Session 18 (Ticket 8.1: Interactive Prompt Components)
- **New file**: `src/lib/prompts.ts` (~667 lines) — 5 interactive terminal prompt primitives ported from claude-relay/bin/cli.js: `promptToggle` (Yes/No toggle with arrow/Tab/y/n), `promptPin` (masked 4-8 digit PIN entry), `promptText` (text input with Tab directory completion and validation), `promptSelect` (single-choice with arrow navigation, hotkeys, back item), `promptMultiSelect` (multi-choice with Space toggle, A=all, Escape=none). All prompts accept injectable `stdin`/`stdout`/`exit` via `PromptOptions`. Tab-completion uses injectable `TabCompleteFs` interface for testability.
- **New file**: `test/unit/prompts.test.ts` (~1121 lines) — 61 tests across all 5 prompts using mock EventEmitter stdin, mock stdout, and mock exit. Tests cover: rendering, keyboard navigation, confirmation, cancellation, validation, tab-completion with mock FS, backspace, hotkeys, select-all, escape behavior.
- **Exports**: `PromptOptions`, `SelectItem`, `MultiSelectItem`, `TabCompleteFs`, `TextPromptOptions`, `SelectPromptOptions`, `promptToggle`, `promptPin`, `promptText`, `promptSelect`, `promptMultiSelect`
- All 1749 tests passing across 66 test files, type-check clean, lint clean

### 2026-02-23 — Session 19 (Ticket 8.11 — Projects Submenu)
- **Ticket 8.11**: Projects Submenu
- **New file**: `src/lib/cli-projects.ts` (~270 lines) — Projects submenu ported from claude-relay/bin/cli.js lines 1487-1679. Exports: `ProjectStatus` interface (slug/path/title/sessions/clients/isProcessing), `ProjectsMenuOptions` interface (extends PromptOptions with getProjects/cwd/addProject/removeProject/setProjectTitle/onBack/injectable fs), `getStatusIcon()` (lightning/green/pause icons), `showProjectsMenu()` (project list with status icons, add cwd/add other/detail/back menu, directory validation via injectable fs), `showProjectDetail()` (project info header with slug/path, session/client counts, set/change title, remove, back). All prompts callback-based wrapped in Promises following cli-menu.ts pattern.
- **New file**: `test/unit/cli-projects.test.ts` (~760 lines) — 26 tests across 4 describe blocks: getStatusIcon (3: processing/active/idle icons), showProjectsMenu rendering (7: status icons, session counts, dim paths, add cwd visibility, empty list, project ordering), showProjectsMenu actions (6: add_cwd calls addProject, success/error messages, add_other directory prompt, back callback, detail navigation), showProjectDetail (10: project info display, sessions/clients counts, singular forms, set title prompt+success, remove project call+success, back returns to list, change/set title label).
- All 26 tests passing, TypeScript type-check clean, Biome lint clean

### 2026-02-23 — Session 20 (Ticket 8.14 — Notifications Setup Wizard)
- **Ticket 8.14**: Notifications Setup Wizard
- **New file**: `src/lib/cli-notifications.ts` (~250 lines) — Notifications setup wizard ported from claude-relay/bin/cli.js lines 1684-1851 (showSetupGuide). Exports: `NotificationWizardOptions` interface (extends PromptOptions with onBack/getTailscaleIP/hasMkcert/getAllIPs/config/restartWithTLS/platform), `showNotificationWizard()` async function. Two-toggle flow: remote access (Tailscale) + push notifications (HTTPS/mkcert). Conditional sections: `renderTailscale()` (Tailscale detection with re-check loop), `renderHttps()` (mkcert detection with platform-specific install hints, TLS restart), `showSetupQR()` (setup URL with port+1 for TLS, ?mode=lan for local, Tailscale IP for remote). All system detection injectable via options for testability.
- **New file**: `test/unit/cli-notifications.test.ts` (~450 lines) — 22 tests across 5 describe blocks: header and toggles (3: logo/header, toggle labels, toggle subtitles), neither selected path (1: "All set!" message + back), Tailscale section (5: detected IP display, install instructions when not found, re-check loop, phone setup instructions, back from not-found), HTTPS section (6: mkcert detected flow, mkcert not found with install hints, platform-specific hints darwin/win32/linux, re-check loop, TLS restart call, back from not-found), Setup QR section (7: URL construction, port+1 for TLS, ?mode=lan for local, Tailscale IP for remote, localhost fallback, LAN IP selection skipping 100.x, "Setup complete" message).
- All 22 tests passing, TypeScript type-check clean

### 2026-02-24 — Session 21 (Cancel/Abort, Quota Error Surfacing, E2E Lifecycle Tests)
- **Cancel/Abort fix**: Added `cancel` message type to `ws-router.ts`, cancel handler in `relay-stack.ts` calling `client.abortSession()`, frontend sends `{ type: "cancel" }` instead of `{ type: "message", text: "/abort" }`. Processing timeout failsafe (120s).
- **Quota error surfacing**: `session.error` SSE events (e.g., `insufficient_quota`) were silently ignored by event-translator.ts. Added handler: `session.error` → `{ type: "error", code, message }`. Browser's existing error handler now displays quota/model errors instead of silent empty turns.
- **Deleted 4 mock integration tests**: `cancel-abort.test.ts`, `regression-model-override.test.ts`, `skeleton.smoke.test.ts`, `terminal-integration.test.ts` — replaced by live E2E tests.
- **4 new E2E lifecycle tests** against real OpenCode:
  - `message-lifecycle.integration.ts` — send→processing→delta→done, sequential messages, state reset
  - `cancel-lifecycle.integration.ts` — cancel during processing→done, send after cancel, cancel when idle
  - `model-selection.integration.ts` — configured providers only, model_info, switch_model, message after switch, new_session reset
  - `terminal.integration.ts` — PTY create/input/resize/close lifecycle (ALL 5 PASSED)
- **Test results**: 2277 unit tests passing (82 files). 67/67 integration tests passing (all 12 files green).
- **Free model auto-detection**: relay-harness.ts now auto-detects free-tier models (OpenCode Zen `gpt-5-nano`, `glm-5-free`, etc.) from the model_list, falling back to Google free-tier or GitHub Copilot flash models. Supports `INTEGRATION_MODEL`/`INTEGRATION_PROVIDER` env vars for explicit override. Solves quota-exhaustion failures on default models. Build, type-check, lint all clean.

### 2026-02-24 — Session 22 (Terminal Panel Fix + PTY Upstream WS Manager)
- **Terminal panel positioning fix**: Moved terminal container from inside `#app` (flex-col, bottom) to inside `#layout` (flex-row, right side). Changed from `border-t`/`height:300px` to `border-l`/`width:400px`. Added drag-to-resize handle (mouse+touch), width persistence to localStorage, ResizeObserver for auto-refit, mobile bottom-sheet fallback at 768px.
- **Terminal mount fix**: `TerminalAdapter` interface extended with `mount(container)` and `resize()` methods. Added `mount(containerEl)` call in `setupTab()` — fixes the black-box bug where xterm.js never rendered.
- **Terminal panel UX**: Added `resizeAll()` to `TerminalTabs` API, `onClose` callback with close-panel button, `terminal:toggle-open` custom event to avoid circular imports between session-ui and main.
- **PTY upstream WS manager (Approach A)**: Implemented multiplexed PTY I/O over the main WebSocket in `relay-stack.ts`. One upstream WS per PTY session to OpenCode's `/pty/:id/connect`. Output broadcast to ALL browser clients (multi-tab support). Input from any browser tab forwarded to shared upstream WS. PTYs persist across browser show/hide toggles — only killed on explicit tab close (X button).
- **API fixes**: `resizePty()` changed from broken `POST /pty/:id/resize` to correct `PUT /pty/:id` with `{ size: { cols, rows } }`. Removed `writePty()` (no such REST endpoint in OpenCode — PTY I/O is WebSocket-only). Added `put()` HTTP method to `OpenCodeClient`. Added `pty_output` to `RelayMessage` type.
- **Binary cursor metadata filtering**: Upstream WS sends binary frames starting with `0x00` (cursor position metadata) — these are filtered out and not forwarded to browsers.
- **Files modified**: `relay-stack.ts` (+80 lines: upstream WS manager, connect/wire/close functions), `opencode-client.ts` (resizePty fix, writePty removed, put method added), `types.ts` (pty_output added), `terminal-ui.ts` (mount/resize interface, resizeAll, onClose), `main.ts` (side panel positioning, drag resize, matchMedia), `style.css` (side panel + drag handle + mobile bottom-sheet), `session-ui.ts` (custom event dispatch)
- **Tests**: 17 new tests in `pty-upstream.test.ts` (mock OpenCode server with REST+WS+SSE, full relay stack integration): pty_create opens upstream WS, pty_input forwards to upstream, pty_output broadcast to all browsers, ANSI preserved, pty_resize via REST, pty_close closes upstream, upstream close broadcasts pty_exited, multiple PTYs independent, closing one doesn't affect others, browser disconnect does NOT close PTY, multi-tab input/output, binary cursor metadata filtered, terminal_command create/close, nonexistent PTY silently dropped, relay stop closes all upstreams. Also: 7 new tests in `terminal-ui.test.ts` (mount, resizeAll, onClose).
- All 2301 tests passing (83 test files), type-check clean, lint clean

### 2026-02-25 — Session 23 (Svelte 5 Migration — Phases S0 + S1)
- **Phase S0**: Svelte + Storybook infrastructure — `svelte.config.js`, `@sveltejs/vite-plugin-svelte` in vite.config.ts, dual entry (`index.html` + `app.html`), `app-entry.ts`, `App.svelte`, `.storybook/` config (main.ts, preview.ts, preview-head.html), `svelte.d.ts` type shim, frontend tsconfig updated
- **Phase S1**: State layer & utilities — 8 reactive stores (ws, chat, session, terminal, discovery, permissions, ui, router) using Svelte 5 `$state`/`$derived` runes, 8 utility modules (format, markdown, diff, clipboard, history-logic, notifications, file-icons, xterm-adapter), shared `types.ts`
- **Testing infrastructure**: `svelte-runes-mock` Vitest plugin that transforms runes for non-Svelte test runner, `test/svelte-ambient.d.ts` ambient declarations
- **Phase S1 audit**: Identified and fixed 8+ field name mismatches between stores and server protocol (`src/lib/types.ts`): `handleToolResult` (result→content, isError→is_error), `handleResult` (flat→nested usage), `handleSessionSwitched` (sessionId→id), `handleModelInfo` (modelId→model, providerId→provider), `handlePtyCreated` (flat→nested pty object), `handlePtyError` (hardcoded→server message), permissions auto-approval (now sends WS response). Removed dead `handleSessionCreated` (no such server message type). Updated all 12 test files to match.
- **Stats**: 25 new source files (~2,826 lines), 12 new test files (~3,367 lines, 367 tests)
- All 2609 tests passing (91 test files), type-check clean, lint clean

### 2026-02-25 — Session 24 (Svelte 5 Migration — Phase S2: App Shell)
- **Phase S2**: App shell components — 6 Svelte components + 6 Storybook story files
- **Components created**: `App.svelte` (router with 4 routes), `ChatLayout.svelte` (main layout), `Header.svelte` (status dot, badges, action buttons), `Sidebar.svelte` (session list, file browser, mobile overlay), `InputArea.svelte` (auto-resize textarea, send/stop, attach menu, context bar), `Icon.svelte` (79 Lucide icon mappings with legacy aliases)
- **Storybook stories**: Icon (Default/Large/Small), Header (Connected/Disconnected/Processing/Error/MultipleClients/TerminalBadge/SidebarCollapsed), Sidebar (Default/FileBrowserPanel/MobileOpen), InputArea (Empty/Processing/WithContextBar/HighContext/CriticalContext), ChatLayout (Default/SidebarCollapsed/WithRewindBanner), App (Default)
- **Critical fix — `$derived` module export restriction**: Svelte 5 prohibits exporting `$derived` values from `.svelte.ts` modules. Initial fix: `const _X = $derived(...) + export function getX() { return _X; }`. But `$derived` evaluates once in test mocks (no reactivity). Final fix: removed ALL module-level `$derived`, compute directly in getter functions. All 8 stores converted (router, chat, session, terminal, discovery, permissions, ws, ui).
- **Other Svelte 5 fixes**: `|preventDefault` event modifier removed (use `e.preventDefault()`), `<svelte:component>` deprecated (use direct component rendering), Biome overrides for `.svelte` files (disable `noUnusedImports`/`noUnusedVariables`/assist/formatter)
- **vitest.config.ts**: Fixed `$derived.by` mock — changed from `(fn)` (function, not value) to `((fn) => fn())(fn)` (IIFE that calls the function)
- All 2617 tests passing (91 files), Storybook builds successfully (22 stories), TypeScript clean, Biome clean

### 2026-02-25 — Session 25 (Svelte 5 Migration — Phase S3: Chat & Streaming)
- **Phase S3**: Chat & streaming components — 7 new Svelte components + 7 Storybook story files
- **Components created**: `UserMessage.svelte` (right-aligned bubble), `AssistantMessage.svelte` (streaming markdown, code block headers + hljs, mermaid diagrams, copy-on-click state machine), `ThinkingBlock.svelte` (collapsible with spinner, random verb, timer), `ToolItem.svelte` (status state machine, expandable result), `ResultBar.svelte` (cost/tokens/duration), `SystemMessage.svelte` (info/error variants), `MessageList.svelte` (auto-scroll, scroll detection, keyed each blocks, scroll-to-bottom button)
- **Svelte `class:` directive fix**: Tailwind classes containing `/` (e.g., `bg-white/[0.04]`, `border-error/30`) are invalid in Svelte's `class:` directive. Converted to `$derived` dynamic class strings in AssistantMessage.svelte (containerCopyClass) and ToolItem.svelte (resultErrorClass)
- **Storybook stories**: 7 story files with 30 stories total: UserMessage (3: Default/Short/Long), AssistantMessage (7: SimpleParagraph/WithCodeBlock/MultipleCodeBlocks/Streaming/WithMermaid/RichMarkdown/Empty), ThinkingBlock (3: Active/Completed/LongDuration), ToolItem (6: Pending/Running/Completed/Error/WithDiff/LongResult), ResultBar (4: Full/NoCost/Minimal/Expensive), SystemMessage (2: Info/Error), MessageList (5: Empty/SingleUser/SingleAssistant/FullConversation/MixedTypes)
- **Mock data**: `stories/mocks.ts` expanded with 25+ typed mock variants across all message types, plus `mockConversation` mixed message array
- **Store update**: Added `resetChatState` export to `chat.svelte.ts` for story/test state management
- All 2617 tests passing (91 files), Storybook builds successfully (52 stories), TypeScript clean, Biome clean

### 2026-02-25 — Session 26 (Svelte 5 Migration — Phase S4: Feature Panels)
- **Phase S4**: Feature panels — 17 new Svelte components + 16 Storybook story files (~62 stories)
- **Components created**: `SessionItem.svelte` + `SessionList.svelte` (date groups, search, context menu, inline rename), `FileBrowser.svelte` + `FileTreeNode.svelte` (recursive tree, breadcrumbs, file preview, directory caching), `TerminalPanel.svelte` + `TerminalTab.svelte` (XTerm.js lifecycle, PTY callback pattern, ResizeObserver per-tab, tab rename via double-click, multi-tab), `QuestionCard.svelte` (radio/checkbox/free-text), `TodoOverlay.svelte` (progress bar, checkmarks), `HistoryView.svelte` (IntersectionObserver infinite scroll), `DiffView.svelte` (unified diff rendering), `AgentSelector.svelte` + `ModelSelector.svelte` (pill/dropdown with provider groups), `CommandMenu.svelte` (slash command palette, keyboard nav), `PastePreview.svelte` (large text confirm, image preview), `PermissionCard.svelte` (Allow/Deny/Always Allow), `PlanMode.svelte` (entry/exit banners, approve UI), `ProjectSwitcher.svelte` (dropdown, slug routing)
- **Terminal deep-dive**: TerminalTab creates own ResizeObserver (no parent-driven resize needed), subscribes to PTY output via store's `onOutput()` callback pattern (bypasses Svelte reactivity for high-throughput data), replays scrollback on mount, sends initial dimensions to server. TerminalPanel manages tab bar with rename (double-click → inline input), new/close/switch tabs via store actions
- **6 parallel background agents**: Built most components concurrently (SessionItem+SessionList, PermissionCard+QuestionCard, AgentSelector+ModelSelector, CommandMenu+TodoOverlay, PastePreview+PlanMode, ProjectSwitcher+DiffView)
- **Lint fixes**: Renamed `Error` story exports to `ErrorState` (avoids shadowing global), biome-ignore for template curly strings in DiffView, unused import cleanup
- All 2617 tests passing (91 files), Storybook builds successfully (114 stories), TypeScript clean, Biome warnings only

### 2026-02-25 — Session 26 continued (Svelte 5 Migration — Phase S5: Overlays & Modals)
- **Phase S5**: Overlays, modals & peripheral UI — 9 new Svelte components + 9 Storybook story files (~29 stories)
- **Components created**: `ConnectOverlay.svelte` (pixel mascot scatter→settle, verb shimmer), `QrModal.svelte` (@castlenine/svelte-qrcode, LAN share URL, clipboard copy), `ConfirmModal.svelte` (promise-based from uiState.confirmDialog), `ImageLightbox.svelte` (fullscreen from uiState.lightboxSrc), `Toast.svelte` (auto-dismiss, default/warn variants, slide-up), `InfoPanels.svelte` (usage/status/context, progress bar with color thresholds), `Banners.svelte` (update/onboarding/skip-permissions variants), `RewindBanner.svelte` (rewind banner + modal with radio modes), `NotifSettings.svelte` (3 toggles, localStorage, push permission)
- **4 parallel background agents**: Built all components concurrently in isolated worktrees (ConnectOverlay+QrModal, ConfirmModal+ImageLightbox+Toast, InfoPanels+Banners, RewindBanner+NotifSettings)
- All 2617 tests passing (91 files), Storybook builds successfully (143 stories across 38 files), TypeScript clean, Biome warnings only
- **Cumulative Svelte migration**: 38 components, 8 stores, 8 utils, 38 story files = 96 modules, ~11,100 lines

### 2026-02-25 — Session 27 (Svelte 5 Migration — Phase S6: Server Pages → Svelte)
- **Phase S6**: Server-rendered pages converted to Svelte components + 3 new API endpoints
- **Page components created**: `PinPage.svelte` (centered PIN entry, auto-submit at 8 digits, lockout handling), `SetupPage.svelte` (multi-step wizard: Tailscale→Certificate→PWA→Push→Done, platform detection, fetches /api/setup-info), `DashboardPage.svelte` (project card grid, fetches /api/projects, standalone PWA check)
- **Server API endpoints** (in `server.ts`): `GET /api/auth/status` (hasPin + authenticated status, before auth check), `GET /api/projects` (project list JSON with slugs/paths/titles/version), `GET /api/setup-info` (httpsUrl/httpUrl/hasCert/lanMode, replaces server-rendered template data)
- **Server routing changes**: `/`, `/setup`, `/auth` now serve `app.html` (Svelte SPA shell) instead of pages.ts HTML strings. Unauthenticated browser routes redirect to `/auth` (302) instead of serving inline PIN HTML (401). `/setup` remains accessible without auth. Removed all `pages.ts` imports from server.ts.
- **Test updates**: 17 tests in `server.pbt.test.ts` updated: dashboard tests now verify `/api/projects` JSON responses, setup tests verify `/api/setup-info` JSON, PIN tests verify 302 redirect behavior, auth roundtrip tests updated for redirect flow. 2 new tests added (auth status endpoint). Total: 2618 unit tests passing.
- **Storybook stories**: 3 new story files (PinPage 3, DashboardPage 3, SetupPage 4 = 10 stories)
- **2 parallel background agents** for page components, server changes done directly
- All 2618 tests passing (91 files), Storybook builds (153 stories across 41 files), TypeScript clean, Biome warnings only
- **Cumulative Svelte migration**: 41 components + 3 pages, 8 stores, 8 utils, 41 story files = 102 modules, ~12,400 lines

### 2026-02-25 — Session 28 (Svelte 5 Migration — Phase S8: Cutover & Cleanup)
- **Phase S8**: Vanilla frontend code fully removed, Svelte SPA is now the only frontend
- **index.html replaced**: 38KB vanilla shell with CDN scripts → 2KB Svelte shell (merged from `app.html`)
- **37 vanilla .ts files deleted**: All 37 frontend modules from `src/lib/public/` (main.ts, shared.ts, chat.ts, ws-client.ts, sidebar.ts, input.ts, terminal-ui.ts, session-ui.ts, etc.) + `cdn-types.d.ts`
- **36 vanilla test files deleted**: All 36 unit test files from `test/unit/` (corresponding to vanilla modules)
- **vite.config.ts**: Removed `app` entry from rollupOptions (single `index` entry remains)
- **server.ts**: All `app.html` references → `index.html`
- **TypeScript fix**: Added `DOM`, `DOM.Iterable` to root `tsconfig.json` lib — required because Svelte unit tests import browser code from `src/lib/public/` which uses DOM globals (`window`, `document`, `navigator`)
- **Dead import fix**: `ConnectOverlay.svelte` imported `randomThinkingVerb` from deleted `../../icons.js` → replaced with local function
- **Lint cleanup**: Fixed unused `Turn` import, unused `mockFileTree` import, `useOptionalChain` in file-icons.ts
- **`pages.ts` retained**: Still used by `daemon.ts` and `onboarding.ts` (daemon needs same SPA migration — future task)
- **Final stats**: 1520 unit tests passing (55 files), frontend builds (379KB JS + 64KB CSS), Storybook builds (153 stories), TypeScript clean, Biome clean (2 warnings in ambient .d.ts only)
- **Svelte 5 migration complete** (Phases S0–S8)

### 2026-02-25 — Session 29 (Bug Fix: Agent Output Disappears on Session Switch)
- **Bug**: When typing into a session with agent output, switching to another session and switching back caused the agent's output to disappear
- **Root cause (server)**: `switch_session` handler loaded history but discarded the returned `HistoryPage` — never sent to clients
- **Root cause (client — 3 bugs)**: (1) Template read `parts[].content` but OpenCode returns `parts[].text` — messages loaded but rendered as empty strings, (2) `handleHistoryPage()` reversed already-chronological messages, breaking `groupIntoTurns()` pairing, (3) `loadMore()` sent `before` (string cursor) but server expected `offset` (integer) — pagination always returned offset 0
- **Root cause (API format mismatch)**: OpenCode returns messages as `{ info: { id, role, ... }, parts: [...] }` but relay assumed flat `{ id, role, parts, ... }`. `message.role` was always undefined → `groupIntoTurns()` treated every message as orphan assistant. Integration tests masked this with defensive `getRole()` helper.
- **Fix 1 — Server (`relay-stack.ts`)**: Broadcast `history_page` on `switch_session`
- **Fix 2 — Server (`session-manager.ts`)**: Changed `loadHistory()` pagination to load from END backwards (offset=0 → most recent N messages), matching chat UI expectations
- **Fix 3 — Server (`opencode-client.ts`)**: Added `normalizeMessage()` that flattens `{ info: {...}, parts }` → `{ id, role, parts, ... }`. Applied to `getMessages()`, `getMessage()`, `getMessagesPage()`
- **Fix 4 — Client (`HistoryView.svelte`)**: Fixed `.content` → `.text` in template, removed incorrect `.reverse()` call, changed `loadMore()` to send `offset: historyMessages.length`, added `$effect` for session-change auto-load with `untrack()` and deduplication
- **Fix 5 — Client (`types.ts`)**: Changed `HistoryMessagePart.content` → `.text` to match OpenCode's `TextPart` schema
- **Unit regression test**: `test/unit/regression-session-switch-history.test.ts` — 7 tests
- **Integration test**: `test/integration/flows/session-switch-history.integration.ts` — 5 tests against real OpenCode: core regression, mid-stream switch with content preservation, empty session, multi-client broadcast, rapid switches
- All 1476 unit tests passing (57 test files), type-check clean (pre-existing `import.meta.env.DEV` error only), lint clean

### 2026-02-26 — Session 31 (Bug Fix: Notification Toggle UI & Permission Handling)
- **Bug 1 — Toggle thumb visual**: `left-[16px]` and `transition-[left]` are Tailwind JIT arbitrary values that aren't generated when they appear inside Svelte template ternaries. The class was applied to the DOM but had no CSS effect. Fixed all 3 toggle thumbs in `NotifSettings.svelte` to use inline styles: `style="left: {val ? '16px' : '2px'}; transition: left 0.2s ease-in-out;"`.
- **Bug 2 — Browser alerts never fired**: `toggleBrowser()` was synchronous and never called `Notification.requestPermission()`. Users who hadn't previously granted permission got silently-failing alerts. Fixed: made `toggleBrowser()` async; when enabling, if permission is `"default"` it calls `requestPermission()` and only sets the toggle on if granted; if permission is `"denied"` shows `browserBlocked` hint and returns without changing state.
- **Bug 3 — Push confirmation notification**: After enabling push there was no feedback to confirm it worked. Added `reg.showNotification("Push Enabled ✓", {...})` after successful subscription so users immediately see that push is working end-to-end.
- **Bug fix — TypeScript error in ws.svelte.ts**: New test file `regression-session-switch-history.test.ts` imports `ws.svelte.ts`, pulling it into the server tsconfig's type-check scope. `import.meta.env.DEV` (Vite-specific) failed with `Property 'env' does not exist on type 'ImportMeta'`. Fixed with type-safe cast: `(import.meta as { env?: { DEV?: boolean } }).env?.DEV`.
- All 1481 unit tests passing (57 test files), type-check clean, lint clean

### 2026-02-26 — Session 30 (Bug Fix: $effect Race Condition in HistoryView)
- **Bug**: History still disappeared on session switch despite Session 29 fixes. Messages loaded but were immediately wiped by a race condition.
- **Root cause**: $effect/handleHistoryPage race condition. On session switch, server sends `session_switched` then `history_page`. The Svelte `$effect` (triggered by `session_switched`) runs as a microtask BETWEEN the two WebSocket message events. The effect's unconditional `reset()` call wiped `historyMessages` that handleHistoryPage had just populated (or was about to populate).
- **Investigation**: Studied how OpenCode's own frontend handles session switching — it uses a per-session message cache (`sync.data.message[sessionID]`) and never clears globally. When switching, it reads from the cache. Our relay used a single array that was wiped and reloaded, creating the race.
- **Fix (`HistoryView.svelte`)**: Added `_displayedSessionId` tracker variable that coordinates between `$effect` and `handleHistoryPage`. The `$effect` now checks `_id !== _displayedSessionId` before resetting — if `handleHistoryPage` already loaded data for the new session (from the proactive broadcast), the effect is a no-op. `handleHistoryPage` resets internally when it detects a session change (`sessionId !== _displayedSessionId`), making it self-contained.
- **Two timing scenarios both work**: (1) Effect fires before proactive data → resets and requests via loadMore, proactive data arrives and is applied. (2) Proactive data arrives first → handleHistoryPage resets and applies data, effect runs later and sees data is already loaded → no-op.
- **Regression tests**: 5 new tests in `regression-session-switch-history.test.ts` (wrong session dispatch, normalized format verification, switch-back-and-forth scenario) + 2 new tests in `svelte-history-logic.test.ts` (groupIntoTurns with OpenCode normalized format)
- All 1481 unit tests passing (57 test files), type-check clean, lint clean

### 2026-04-09 — Orchestrator Task 50.5 (Strip MessageCache/ToolContentStore/PendingUserMessages from test fixtures)
- **Goal**: Remove all in-memory store references from test files in preparation for Task 51 deletion
- **Files modified** (12 test files + 1 deleted):
  - `test/unit/session/session-switch.test.ts` — removed 27+ `messageCache` mock fields from `createMinimalDeps()`, deleted broken placeholder describe blocks (584-839 lines), removed all `messageCache.getEvents` assertions
  - `test/unit/relay/event-pipeline.test.ts` — removed `toolContentStore`/`messageCache` from `makeDeps()`, deleted 5 tests that verified in-memory store writes
  - `test/unit/relay/per-tab-routing-e2e.test.ts` — deleted "SSE events are cached even when no client views that session" test
  - `test/unit/daemon/project-registry.test.ts` — removed unused `ProjectRelay` import
  - 9 other test files with minor `messageCache`/`toolContentStore` field removals from mock factories
  - `test/unit/relay/regression-deduplication-e2e.test.ts` — deleted (MessageCache-coupled)
- **Commit**: `33e0909` — 15 files changed, 81 insertions, 1125 deletions; 243 test files, 4389 tests

### 2026-04-10 — Orchestrator Task 51 (Remove MessageCache + JSONL files — replaced by SQLite event store)
- **Source files deleted**: `src/lib/relay/message-cache.ts` (411 lines), `src/lib/relay/cold-cache-repair.ts` (69 lines)
- **New file**: `src/lib/persistence/eviction.ts` — `EventStoreEviction` class with `evictSync()`, `evictAsync()` (yields between batches via `setImmediate`), `cascadeProjections()` (FK-safe cleanup of fully-evicted sessions)
- **Wiring**: `PersistenceLayer` gets `readonly eviction: EventStoreEviction`; `ProjectRelay` interface gets `persistence?: PersistenceLayer`; `ProjectRegistry.evictOldestSessions()` now calls `relay.persistence?.eviction.evictSync()` per relay; daemon low-disk-space handler logs eviction summaries
- **Rename**: `CACHEABLE_EVENT_TYPES` → `PERSISTED_EVENT_TYPES`, `CacheableEventType` → `PersistedEventType` (deprecated aliases kept); updated `cache-events.ts`, `dispatch-coverage.test.ts`, `ws-dispatch.ts`, `regression-mid-stream-switch.test.ts`
- **Test files deleted** (5): `message-cache.test.ts`, `cold-cache-repair.test.ts`, `cache-replay-contract.test.ts`, `regression-server-cache-pipeline.test.ts`, `daemon-eviction-chain.test.ts`
- **New test file**: `test/unit/persistence/eviction.test.ts` — 12 tests covering sync/async batching, yield counts, receipt cleanup, cascade projections
- **Commit**: `d7c7042` — 19 files changed (+ 2 new, 7 deleted); 239 test files, 4330 tests passing

### 2026-04-10 — Orchestrator Task 52 (Remove ToolContentStore + PendingUserMessages — replaced by SQLite tables)
- **Source files deleted**: `src/lib/relay/tool-content-store.ts` (77 lines), `src/lib/relay/pending-user-messages.ts` (82 lines)
- **Test files deleted**: `test/unit/relay/tool-content-store.test.ts`, `test/unit/relay/pending-user-messages.test.ts`
- **Comments updated**: `src/lib/handlers/tool-content.ts` and `src/lib/relay/truncate-content.ts` — "ToolContentStore" → "SQLite tool_content table"
- **Handler already rewritten** (Task 50.5): `handleGetToolContent` uses `deps.readAdapter?.getToolContent(toolId)` — no further changes needed
- **Handler test kept**: `test/unit/handlers/get-tool-content-handler.test.ts` (7 tests) — already tests SQLite ReadAdapter path
- **Snapshot harmless**: `test/e2e/fixtures/subagent-snapshot.json` references old filenames in historical traces — no test failures
- **Verification**: `pnpm check` clean, `pnpm lint` clean (warnings only), 237 test files, 4304 tests passing
