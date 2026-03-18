# Codebase Cleanup: 20 Findings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Systematically fix 20 audit findings — dead code, orphaned modules, broken features, duplicate types, and stale wiring — restoring the codebase to a consistent state where every module is either properly wired or removed.

**Architecture:** opencode-relay is a stateless translation layer: Browser <-WS-> Server <-HTTP/SSE-> OpenCode (port 4096). The server side (`src/lib/`) translates SSE events via `event-translator.ts`, routes WS messages via `ws-router.ts`, and wires everything in `relay-stack.ts`. The frontend (`src/lib/public/`) is a Svelte 5 app with rune-based stores. Two separate tsconfig contexts exist: server (NodeNext) and frontend (ESNext/bundler).

**Tech Stack:** TypeScript ESM, Svelte 5, Vitest, Biome, pnpm, Node.js >= 18

**Dependency graph between findings:**
```
#8 (version-check) ──→ #13 (dead banners — update_available needs version-check wired first)
#1 (plan mode wire-up) ──→ #19 (PlanApproval removal — understand plan mode before removing dead types)
#3 (file history cleanup) ──→ #18 (FileVersion removal — do #3 first so #18 is safe)
#2 (rewind→revert) ──→ #15 (rebuildState — revert triggers state rebuild)
#6 (todo_state removal) ──→ #7 (input-sync removal — both are dead code removals, no dependency but batch them)
#16 + #17 + #18 + #19 are all type removals — can be done in parallel, or batched
```

**Execution order (5 phases):**
- **Phase A:** Safe deletions (#6, #7, #14, #16, #17)
- **Phase B:** Type cleanup (#10, #18, #19)
- **Phase C:** Wire up orphans (#8, #9, #12, #13)
- **Phase D:** Fix broken features (#3, #4, #5, #11)
- **Phase E:** Major feature rewiring (#1, #2, #15, #20)

---

## Phase A: Safe Deletions

---

### Finding #6: Remove Dead `todo_state` Code Path

**What's wrong:** The server has a `get_todo` handler in `relay-stack.ts:1201-1203` that always returns `{ type: "todo_state", items: [] }`. The `extractTodoFromToolResult()` function in `event-translator.ts:448-492` is never called. The `todo_state` type is defined in `types.ts` but never emitted. Meanwhile, the *working* todo path is client-side derivation — `ChatLayout.svelte` parses `TodoWrite` tool results directly from chat messages.

**Why it's dead:** The original plan was to extract todo items server-side from tool results, but the implementation went client-side instead. The server stub and extraction function were never wired together, and even if they were, the data flow is backwards (the translator would need to intercept tool_result events and emit a separate todo_state, but the frontend already does this).

**Files to modify:**
- `src/lib/ws-router.ts:27` — Remove `"get_todo"` from `IncomingMessageType` union
- `src/lib/ws-router.ts:58` — Remove `"get_todo"` from `VALID_MESSAGE_TYPES` set
- `src/lib/relay-stack.ts:1200-1204` — Remove the `case "get_todo"` handler
- `src/lib/event-translator.ts:448-514` — Remove `extractTodoFromToolResult()` and `normalizeTodoItem()`
- `src/lib/types.ts` — Verify `TodoItem` and `TodoStatus` are still used elsewhere (they ARE used by the frontend types, so keep them in types.ts; just remove the dead extraction code)

**Things to be careful of:**
1. The `TodoItem` and `TodoStatus` types in `src/lib/types.ts:211-220` are still imported by `event-translator.ts` for the extraction function. After removing the extraction function, check if anything else imports `TodoItem`/`TodoStatus` from the server types. If not, the types can stay (they're also in `src/lib/public/types.ts:260-269` which is the frontend's copy).
2. The `normalizeTodoItem` helper function at line 494-514 is only called by `extractTodoFromToolResult` — safe to remove both.
3. Confirm `ChatLayout.svelte` still has the working client-side todo derivation before removing the server path.

**Mitigations:**
- Search for any other callers of `extractTodoFromToolResult` before removing (expect: none besides tests).
- Run `pnpm check` after removal to catch any broken imports.

**Verification:**
```bash
# After changes:
pnpm check                    # No type errors
pnpm test:unit                # All unit tests pass
pnpm lint                     # No lint errors

# Confirm dead code is gone:
grep -r "get_todo" src/       # Should return nothing
grep -r "extractTodoFromToolResult" src/   # Should return nothing
grep -r "normalizeTodoItem" src/           # Should return nothing
grep -r "todo_state" src/lib/types.ts      # Should return nothing
```

**Test impact:** `test/unit/event-translator.stateful.test.ts` or `event-translator.pbt.test.ts` may have tests for `extractTodoFromToolResult`. Remove those test cases too. The `ws-router.pbt.test.ts` may test `get_todo` as a valid message type — update the valid types list in those tests.

---

### Finding #7: Remove Orphaned `input-sync.ts` Module

**What's wrong:** `src/lib/input-sync.ts` defines `getSyncTargets()` and `createSyncMessage()` but is never imported by any production code. Its logic (exclude sender from broadcast targets) is already handled inline by the `broadcastExcept` method on `WebSocketHandler` in `ws-handler.ts:124`.

**Files to delete:**
- `src/lib/input-sync.ts`
- `test/unit/input-sync.pbt.test.ts`

**Things to be careful of:**
1. Verify that relay-stack.ts input_sync handler (line 1192-1198) currently uses `wsHandler.broadcast()` not `broadcastExcept()`. This is a **separate bug** (Finding #4) — the module deletion here is safe regardless.
2. Don't accidentally delete the *test* for the input sync *feature* if one exists in fixture/integration tests — we're only removing the unit test for the orphaned module.

**Mitigations:**
- `grep -r "input-sync" src/` to confirm zero production imports (only test file should appear).
- `grep -r "getSyncTargets\|createSyncMessage" src/` to double-check.

**Verification:**
```bash
pnpm check                    # No type errors (module was never imported)
pnpm test:unit                # Pass (test file removed)
pnpm lint                     # Clean
```

---

### Finding #14: Delete 9 Unused Mockup HTML Variants

**What's wrong:** `src/lib/public/` contains 10 `mockup*.html` files. Only `mockup.html` is used — it's a Vite rollup entry (`vite.config.ts:17`) and referenced by visual convergence tests (`test/e2e/specs/visual-mockup.spec.ts`). The other 9 variants were design explorations that are no longer referenced anywhere:
- `mockup-v1-docs-yuzu.html`
- `mockup-v2-cobalt.html`
- `mockup-v3-compact.html`
- `mockup-v4-spacious.html`
- `mockup-v5-flat.html`
- `mockup-v6-elevated.html`
- `mockup-v7-mono.html`
- `mockup-v8-ember.html`
- `mockup-opencode.html`

**Files to delete:** All 9 listed above.

**Things to be careful of:**
1. Verify `vite.config.ts` rollup input only references `mockup.html` (confirmed: line 17).
2. Search test files for references to any variant filenames — they may have been in visual regression tests at some point.
3. Check git history isn't needed — these are static HTML, not generated.

**Mitigations:**
- `grep -r "mockup-v\|mockup-opencode" .` in the project root to confirm zero references.
- Keep `mockup.html` (the one that's actually used).

**Verification:**
```bash
pnpm build:frontend           # Vite build succeeds (only uses mockup.html)
pnpm check                    # No type errors
ls src/lib/public/mockup*.html  # Only mockup.html remains
```

---

### Finding #16: Remove Orphaned `FileContentResult` Type

**What's wrong:** `FileContentResult` in `src/lib/types.ts:259-263` is never used. The `get_file_content` handler in `relay-stack.ts:933-945` uses inline casts like `(result as { content: string }).content` instead of the defined type.

**Files to modify:**
- `src/lib/types.ts:259-263` — Remove the `FileContentResult` interface

**Things to be careful of:**
1. Search for `FileContentResult` across the entire codebase (including tests) to confirm it's truly unused.
2. Optionally, the inline casts in relay-stack.ts could be cleaned up to use a proper type, but that's a separate improvement (not required for this fix).

**Mitigations:**
- `grep -r "FileContentResult" src/ test/` — expect zero matches.

**Verification:**
```bash
pnpm check                    # No type errors
pnpm test:unit                # Pass
```

---

### Finding #17: Remove Orphaned `ModelEntry` Type

**What's wrong:** `ModelEntry` in `src/lib/types.ts:137-141` has three fields (`id`, `name`, `provider`) which are a strict subset of `ModelInfo` at `types.ts:237-242` (which adds `cost`). `ModelEntry` was likely the original type before `ModelInfo` superseded it. Nothing imports `ModelEntry`.

**Files to modify:**
- `src/lib/types.ts:137-141` — Remove the `ModelEntry` interface

**Things to be careful of:**
1. Search for `ModelEntry` across codebase and tests.
2. The frontend has its own `ModelInfo` in `src/lib/public/types.ts:116-121` which is the one actually used by components.

**Mitigations:**
- `grep -r "ModelEntry" src/ test/` — expect zero matches.

**Verification:**
```bash
pnpm check                    # No type errors
pnpm test:unit                # Pass
```

---

## Phase B: Type Cleanup

---

### Finding #10: Deduplicate Server and Frontend Types

**What's wrong:** 6+ types are defined identically in both `src/lib/types.ts` (server) and `src/lib/public/types.ts` (frontend):
- `TodoItem` / `TodoStatus` — identical
- `AgentInfo` — identical
- `ModelInfo` — server has `cost?: { input?: number; output?: number }`, frontend has `cost?: ModelCost` where `ModelCost = { input?: number; output?: number }` — structurally identical
- `ProviderInfo` — identical
- `CommandInfo` — identical
- `FileEntry` — frontend has extra `children?: FileEntry[]` field (unused, Finding #3 removes it)

**Approach:** Create `src/lib/shared-types.ts` as the single source of truth for wire-contract types. Both `src/lib/types.ts` and `src/lib/public/types.ts` re-export from it.

**Files to create:**
- `src/lib/shared-types.ts` — New file with the canonical definitions

**Files to modify:**
- `src/lib/types.ts` — Replace duplicate definitions with re-exports
- `src/lib/public/types.ts` — Replace duplicate definitions with re-exports; remove dead `children` field from `FileEntry`, remove dead `processing` field from `SessionInfo`

**Things to be careful of:**
1. **Two tsconfig contexts.** Server uses `tsconfig.json` (NodeNext module resolution). Frontend uses its own config (ESNext/bundler). The shared-types file must be importable by both. Since it only contains `interface` and `type` declarations (no runtime code, no Node.js imports), it should work in both contexts. Place it in `src/lib/` (inside the server context) and import from `src/lib/public/types.ts` using a relative path like `../shared-types.js`.
2. **Import path differences.** Server files use `.js` extensions (ESM). Frontend files also use `.js` extensions. The shared-types module must use `.ts` → `.js` extension mapping.
3. **Don't break Svelte components.** They import from `../types.js` (the frontend types). The frontend types.ts should re-export the shared types so no component import paths change.
4. **`ModelCost` type.** The frontend has a standalone `ModelCost` interface. Either keep it in frontend types or move it to shared types. Since the server types currently inline `{ input?: number; output?: number }` in `ModelInfo.cost`, moving `ModelCost` to shared would clean this up.
5. **Removing `children` from `FileEntry`.** Verify no component uses `entry.children`. The field was for a tree view that was never built.
6. **Removing `processing` from `SessionInfo`.** Verify no component reads `session.processing`. Session processing state is tracked in `chatState.processing`, not on the session object.

**Mitigations:**
- Run `pnpm check` after each incremental change.
- Run `pnpm build` (both tsc and vite) to confirm both contexts compile.
- Run full test suite.

**Verification:**
```bash
pnpm check                    # Both tsconfig contexts pass
pnpm build                    # tsc + vite succeed
pnpm test                     # All tests pass
pnpm lint                     # Clean

# Confirm deduplication:
grep -c "interface AgentInfo" src/lib/types.ts src/lib/public/types.ts src/lib/shared-types.ts
# shared-types.ts: 1, others: 0 (they re-export)
```

---

### Finding #18: Remove Orphaned `FileVersion` Type + Dead CSS/Tests

**What's wrong:** `FileVersion` in `src/lib/public/types.ts:296-304` is never used. OpenCode has no file history/versioning API. Related dead artifacts:
- CSS classes like `.file-history-*` in stylesheets (if any)
- `test/e2e/specs/advanced-ui.spec.ts` may have a dead file history test

**Prerequisite:** Finding #3 (file history cleanup) should be done first to ensure the `file_history_result` handler and listener registry are already removed.

**Files to modify:**
- `src/lib/public/types.ts:294-304` — Remove `FileVersion` interface

**Things to be careful of:**
1. Grep for `FileVersion` across all source and test files.
2. Check `style.css` or Tailwind for any `.file-history` classes that can be removed.
3. Check `advanced-ui.spec.ts` for dead file history E2E tests.

**Mitigations:**
- `grep -r "FileVersion\|file-history\|fileHistory" src/ test/` to find all references.

**Verification:**
```bash
pnpm check
pnpm test
grep -r "FileVersion" src/ test/   # Should return nothing
```

---

### Finding #19: Remove Orphaned `PlanApproval` Type + Dead Plan Mode State

**What's wrong:** `PlanApproval` in `src/lib/public/types.ts:326-329` is never imported by any component. The plan mode state in `ui.svelte.ts` (`planApproval`, `planContent`, `planMode`) exists but is only set by store functions that are never called from the WS message handler. The `PlanMode.svelte` component sends `plan_approve` and `plan_reject` WS messages that the server doesn't recognize (not in `VALID_MESSAGE_TYPES`).

**Important:** This finding is about removing the dead *type* and identifying the dead *state*. The actual plan mode *feature* is addressed in Finding #1. **If Finding #1 is being implemented (wiring up plan mode), do NOT remove the state/type here — instead, wire it up.**

**If Finding #1 is NOT being implemented (deferring plan mode):**

**Files to modify:**
- `src/lib/public/types.ts:324-329` — Remove `PlanApproval` interface
- `src/lib/public/stores/ui.svelte.ts:47-52` — Remove `planMode`, `planContent`, `planApproval` from state
- `src/lib/public/stores/ui.svelte.ts:212-233` — Remove `enterPlanMode()`, `exitPlanMode()`, `setPlanContent()`, `setPlanApproval()`
- `src/lib/public/stores/ui.svelte.ts:287-291` — Remove plan mode reset from `resetProjectUI()`
- `src/lib/public/stores/ws.svelte.ts:386-391` — Remove plan mode cases from `handleMessage()`
- `src/lib/public/stores/ws.svelte.ts:487,500-502` — Remove `_planModeListeners` set and `onPlanMode()` function

**Things to be careful of:**
1. `PlanMode.svelte` component would become dead code too — but it's a complete UI component that should be kept if plan mode will be wired up later (Finding #1).
2. `ChatLayout.svelte` subscribes to `onPlanMode()` — that subscription code would need to be removed.
3. If you remove plan mode state but keep `PlanMode.svelte`, the component will still compile (it receives props, doesn't read store directly).

**Mitigations:**
- Decide first: is Finding #1 happening? If yes, skip this finding entirely.
- If removing, grep for all imports of `enterPlanMode`, `exitPlanMode`, `setPlanContent`, `setPlanApproval`, `onPlanMode`, `PlanApproval`.

**Verification:**
```bash
pnpm check
pnpm build
pnpm test
grep -r "PlanApproval" src/   # Nothing
grep -r "planMode\|planContent\|planApproval" src/lib/public/stores/ui.svelte.ts  # Nothing
```

---

## Phase C: Wire Up Orphan Modules

---

### Finding #8: Wire Up `version-check.ts` in Daemon

**What's wrong:** `src/lib/version-check.ts` is a complete, tested module (`test/unit/version-check.test.ts` exists) with a `VersionChecker` class that checks npm for updates. But no production code ever imports it. The daemon's `start()` method doesn't instantiate it. The `update_available` banner handler in the frontend (`ws.svelte.ts:375`) exists but never receives messages.

**Additional issue:** `CURRENT_VERSION` is hardcoded as `"0.1.0"` on line 11. It should read from `package.json`.

**Files to modify:**
- `src/lib/version-check.ts:11` — Read version from package.json instead of hardcoding
- `src/lib/daemon.ts` — Import and instantiate `VersionChecker` in `start()`, wire `update_available` event to broadcast, clean up in `stop()`

**Things to be careful of:**
1. **Version reading.** The module is ESM, so `require` isn't available. Use `createRequire(import.meta.url)` (already used in relay-stack.ts) or read package.json with `fs.readFileSync`. The daemon already imports from `node:fs`, so this is straightforward.
2. **Broadcast target.** The VersionChecker emits `update_available` events. The daemon needs to broadcast this to all connected WS clients across all projects. The daemon has access to each project's `wsHandler` via the relay instances.
3. **Cleanup.** Call `versionChecker.stop()` in the daemon's `stop()` method to clear the interval.
4. **The standalone relay (relay-stack.ts) also needs this.** For non-daemon usage (dev-server, skeleton), consider adding version checking there too, or only in daemon mode. Start with daemon-only.
5. **npm registry access.** The check fetches from `registry.npmjs.org`. Ensure the daemon doesn't crash if the network is unavailable — the VersionChecker already handles this (errors are emitted, not thrown).

**Mitigations:**
- Test the wiring with a mock fetch to avoid hitting npm in tests.
- Verify the existing `version-check.test.ts` passes unchanged.
- Manually test: start daemon, verify no crash, check logs for version check.

**Verification:**
```bash
pnpm check
pnpm test:unit -- version-check   # Existing tests still pass
pnpm test:unit -- daemon           # Daemon tests still pass

# Manual verification:
# Start daemon, wait 5 seconds, check logs for "[version] Checked: current=X.Y.Z, latest=..."
# Or "[version] Update available: ..."
```

---

### Finding #9: Wire Up `keep-awake.ts` in Daemon

**What's wrong:** `src/lib/keep-awake.ts` is a complete, tested module (`test/unit/keep-awake.test.ts` exists) with a `KeepAwake` class that spawns `caffeinate` on macOS. But no production code imports it. The daemon's `setKeepAwake` IPC handler (line 1139-1143) just sets a boolean — it never starts or stops the `caffeinate` process.

**Files to modify:**
- `src/lib/daemon.ts` — Import `KeepAwake`, instantiate in constructor or `start()`, wire to `setKeepAwake` IPC handler, clean up in `stop()`

**Things to be careful of:**
1. **Daemon already tracks `this.keepAwake` as a boolean.** The `KeepAwake` class has its own `enabled` state. Don't create conflicting state — use the class as the source of truth and set `this.keepAwake = enabled` for config persistence.
2. **Initial state.** When daemon starts, check `this.keepAwake` from the loaded config. If true, call `keepAwake.activate()` on startup.
3. **IPC handler wiring.** The `setKeepAwake` handler should call `keepAwake.setEnabled(enabled)` which handles activate/deactivate internally.
4. **Non-macOS.** The `KeepAwake` class already handles non-macOS as a no-op. No platform checks needed in daemon.
5. **Cleanup.** Call `keepAwake.deactivate()` in `stop()` to kill the caffeinate process.
6. **Process lifetime.** The caffeinate process should not outlive the daemon. `deactivate()` kills it, and the process is spawned with `detached: false` so it dies with the parent.

**Mitigations:**
- Existing `keep-awake.test.ts` tests the class in isolation — they should pass unchanged.
- Add a simple daemon integration test: create daemon with keepAwake=true, verify the class is activated.

**Verification:**
```bash
pnpm check
pnpm test:unit -- keep-awake      # Existing tests pass
pnpm test:unit -- daemon           # Daemon tests pass

# Manual verification (macOS):
# Start daemon with keepAwake enabled
# Check: ps aux | grep caffeinate  → should see a caffeinate process
# Stop daemon
# Check: ps aux | grep caffeinate  → process should be gone
```

---

### Finding #12: Implement SIGHUP Config Reload in Daemon

**What's wrong:** The daemon's SIGHUP handler at `daemon.ts:1294-1297` is a no-op placeholder. The comment says "reload config" but it does nothing.

**Files to modify:**
- `src/lib/daemon.ts:1294-1297` — Implement `reload()` to re-read `daemon.json` and apply changes

**Things to be careful of:**
1. **What's safe to reload.** PIN hash and keepAwake state are safe. Port, TLS, and project list are NOT safe to hot-reload (would require restarting HTTP server/WS connections).
2. **Config reading.** The daemon already has `loadDaemonConfig()` and `buildConfig()`. The reload should call `loadDaemonConfig()`, diff with current state, and apply safe changes.
3. **Auth enforcement.** If PIN hash changes, call `this.auth.setPinHash(newHash)` — the auth middleware will pick up the change on next request.
4. **KeepAwake.** If `keepAwake` changes, call `this.keepAwakeInstance.setEnabled(newValue)`.
5. **Don't crash on errors.** If `daemon.json` has invalid JSON or is missing, log a warning and keep current config. SIGHUP should never crash the daemon.
6. **Signal safety.** Node.js signal handlers can run at any time. The reload should be async-safe. Since `loadDaemonConfig` is synchronous (reads file), this is fine.

**Mitigations:**
- Wrap in try/catch, log warnings on failure.
- Test: modify daemon.json PIN while running, send SIGHUP, verify new PIN works.

**Verification:**
```bash
pnpm check
pnpm test:unit -- daemon

# Manual verification:
# 1. Start daemon with --pin 1234
# 2. Edit daemon.json to change PIN to 5678
# 3. kill -HUP <daemon-pid>
# 4. Verify old PIN rejected, new PIN accepted
```

---

### Finding #13: Wire Up Banner Message Types

**What's wrong:** The frontend's `ws.svelte.ts:373-377` handles `banner`, `skip_permissions`, and `update_available` message types, but the server never sends them. The `showBanner()` function and `BannerConfig` type are fully implemented.

**Dependency:** `update_available` requires Finding #8 (version-check wiring). `skip_permissions` requires detecting OpenCode's permission skip config.

**Files to modify:**
- `src/lib/relay-stack.ts` — Broadcast `update_available` when VersionChecker emits (if wired from #8)
- `src/lib/relay-stack.ts` — Optionally detect OpenCode's skip-permissions setting and broadcast `skip_permissions`
- `src/lib/types.ts` — Add `update_available` and `skip_permissions` to `RelayMessage` type union if not already present

**Things to be careful of:**
1. **`update_available` depends on #8.** If #8 isn't done, this half of #13 can't be wired. The frontend handler already works — it just needs messages.
2. **`skip_permissions` detection.** OpenCode's config API may expose whether permissions are being skipped (e.g., `--dangerously-skip-permissions` flag). Check `client.getConfig()` or similar. If no API exists, defer this.
3. **`banner` type is generic.** It's for arbitrary banners from the server. No specific source exists yet — this is future-proofing. Leave the handler in place but don't add a source.
4. **Message type safety.** The `RelayMessage` union in `types.ts` may not include these types. Add them so TypeScript catches any mismatches.

**Mitigations:**
- Implement `update_available` first (clear source from #8).
- Log `skip_permissions` as a TODO if OpenCode's API doesn't expose it.

**Verification:**
```bash
pnpm check
pnpm test

# Manual: start relay, check that update_available banner appears if a new version exists on npm
```

---

## Phase D: Fix Broken Features

---

### Finding #3: Fix File History Dead Handlers + `file_changed` Routing Bug

**What's wrong:** Three issues:
1. The `file_history_result` case in `ws.svelte.ts:401` routes to `_fileHistoryListeners` — but nothing ever subscribes to this set, so the messages are silently dropped.
2. The `file_changed` case in `ws.svelte.ts:400` also routes to `_fileHistoryListeners` — but it should route to `_fileBrowserListeners` so the file browser can refresh when files change.
3. OpenCode has no file history API, so `file_history_result` messages are never sent anyway. The entire file history listener infrastructure is dead.

**Files to modify:**
- `src/lib/public/stores/ws.svelte.ts:399-403` — Change `file_changed` routing from `_fileHistoryListeners` to `_fileBrowserListeners`
- `src/lib/public/stores/ws.svelte.ts:399-403` — Remove `file_history_result` case entirely
- `src/lib/public/stores/ws.svelte.ts:489,512-514` — Remove `_fileHistoryListeners` set and `onFileHistory()` function
- Check if any component imports `onFileHistory` — if so, remove those imports

**Things to be careful of:**
1. **The `file_changed` rerouting is a real bug fix.** When OpenCode edits a file, it emits `file.edited` SSE → translator produces `{ type: "file_changed" }` → frontend should refresh the file browser. Currently this message arrives but goes to a dead listener set. After fixing, verify the file browser actually handles it.
2. **`FileBrowser.svelte` subscription.** Check that `FileBrowser.svelte` (or `FileViewer.svelte`) subscribes to `onFileBrowser()` and handles `file_changed` messages. If it doesn't handle this message type yet, a handler needs to be added.
3. **`onFileHistory()` removal.** Grep for any imports of `onFileHistory`. If `ChatLayout.svelte` or any component imports it, remove that import and subscription.

**Mitigations:**
- Read `FileBrowser.svelte` to verify it subscribes to `onFileBrowser` and can handle `file_changed` messages. If it only handles `file_list` and `file_content`, add handling for `file_changed` (trigger a refresh).
- Write a unit test: when `handleMessage({ type: "file_changed", path: "foo.ts" })` is called, verify the message reaches `_fileBrowserListeners`.

**Verification:**
```bash
pnpm check
pnpm test

# Functional test:
# 1. Open relay in browser, open file browser
# 2. Have Claude edit a file via OpenCode
# 3. File browser should refresh (previously it would NOT because of routing bug)
```

---

### Finding #4: Fix Input Sync — Three Bugs

**What's wrong:** The input sync feature (multi-client input synchronization) has three bugs preventing it from working:
1. **Server bug:** `relay-stack.ts:1192-1198` uses `wsHandler.broadcast()` which sends to ALL clients including the sender. Should use `wsHandler.broadcastExcept(msg, clientId)`.
2. **Frontend bug (send):** No component ever sends `{ type: "input_sync", text: "..." }` when the user types.
3. **Frontend bug (receive):** `ws.svelte.ts` has no `case "input_sync"` in `handleMessage()`, so incoming sync messages are silently dropped.

**Files to modify:**
- `src/lib/relay-stack.ts:1192-1198` — Change `wsHandler.broadcast(...)` to `wsHandler.broadcastExcept(...)` with `clientId`
- `src/lib/public/stores/ws.svelte.ts` — Add `case "input_sync"` to `handleMessage()` that calls a new handler
- `src/lib/public/stores/ui.svelte.ts` — Add `inputSyncText` to state and a `setInputSyncText()` action
- `src/lib/public/components/chat/InputArea.svelte` — On input change, debounce and send `input_sync` via WS; also listen for incoming sync and show remote text

**Things to be careful of:**
1. **The clientId is available in the WS message handler.** The relay-stack message handler callback receives `(clientId, handler, payload)`. Check the exact callback signature to confirm `clientId` is available.
2. **Debouncing.** Don't send an input_sync on every keystroke. Debounce to ~200ms. The `input-sync.ts` orphan module (Finding #7) had no debounce logic — this needs to be implemented in the component.
3. **Feedback loop.** When receiving an `input_sync` from the server, the component should update a "remote typing indicator" but NOT update the local input field (that would be confusing). Or, if the goal is to sync the actual input text, make sure updating the input doesn't trigger another sync message (guard against loops).
4. **Multi-client UX.** With 3+ clients, input sync gets complex. Start simple: broadcast the current input text, show it as a "typing indicator" on other clients.
5. **`broadcastExcept` method.** Verify `wsHandler.broadcastExcept(message, excludeClientId)` exists and has the right signature. Confirmed: `ws-handler.ts:124`.

**Mitigations:**
- Add the `from` field to the input_sync message so the frontend knows who's typing.
- Guard the send path: only send if connected and there are >1 clients.
- Don't break existing input behavior — the sync is additive.

**Verification:**
```bash
pnpm check
pnpm test

# Functional test:
# 1. Open relay in two browser tabs
# 2. Type in tab A's input area
# 3. Tab B should show a "typing indicator" or see the synced text
# 4. Tab A should NOT receive its own sync back
```

---

### Finding #5: Add `part_removed` and `message_removed` WS Handlers

**What's wrong:** The event translator correctly produces `{ type: "part_removed" }` and `{ type: "message_removed" }` messages (event-translator.ts:361-385), and these are broadcast to clients. But the frontend's `ws.svelte.ts handleMessage()` has no cases for them — they fall through to the `default` case (logged only in dev mode).

**When these fire:**
- `part_removed`: OpenCode removes a message part (e.g., during retraction or edit)
- `message_removed`: OpenCode removes an entire message (happens during revert/compaction)

**Files to modify:**
- `src/lib/public/stores/chat.svelte.ts` — Add `handlePartRemoved(msg)` and `handleMessageRemoved(msg)` handlers
- `src/lib/public/stores/ws.svelte.ts` — Add `case "part_removed"` and `case "message_removed"` in `handleMessage()`

**Implementation for `handlePartRemoved`:**
```typescript
export function handlePartRemoved(msg: WsMessage): void {
    const partId = msg.partId as string;
    if (!partId) return;
    // Remove the tool message matching this part ID
    chatState.messages = chatState.messages.filter(
        (m) => !(m.type === "tool" && (m as ToolMessage).id === partId)
    );
    toolUuidMap.delete(partId);
}
```

**Implementation for `handleMessageRemoved`:**
```typescript
export function handleMessageRemoved(msg: WsMessage): void {
    // When a message is removed (revert/compaction), clear all messages
    // and let the client re-fetch state. This is safer than trying to
    // remove individual messages since we don't track messageIDs in the
    // chat state.
    clearMessages();
}
```

**Things to be careful of:**
1. **`part_removed` matching.** The WS message has `partId` (the part ID, which is the `callID` or part ID). The chat store tracks tools by their tool `id` (which maps to `callID`). Verify the IDs match: in `handleToolStart`, `id = msg.id` where `msg.id` comes from `tool_start.id` which is the `callID` from `translateToolPartUpdated`. And `part_removed.partId` comes from `translatePartRemoved` which uses `props.partID` (the OpenCode part ID). **These might be different!** The `callID` and `partID` are different fields. Check the translator: `translateToolPartUpdated` uses `part.callID ?? partID` as the `id`. So the tool message id is the callID (if present) or the partID. The `part_removed` message uses the partID. This means if callID exists and differs from partID, the filter won't match. **Fix:** also include the callID in the `part_removed` message, or always use partID as the canonical ID.
2. **`message_removed` aggressive clear.** Clearing all messages on any `message_removed` is aggressive but safe — the alternative (tracking messageID → chat messages) requires adding messageID tracking to the chat store, which is more complex.
3. **Thinking messages.** `part_removed` could also refer to a reasoning part. The filter above only removes tool messages. Extend it to also check thinking messages if needed.

**Mitigations:**
- Test both handlers with unit tests in a new test file or by extending `svelte-chat-store.test.ts`.
- Verify the ID mapping between translator output and chat store by tracing through a real event flow.

**Verification:**
```bash
pnpm check
pnpm test

# Unit test: call handlePartRemoved({ type: "part_removed", partId: "xyz" })
# after adding a tool message with id "xyz" → message should be removed
# Unit test: call handleMessageRemoved({ type: "message_removed" })
# → all messages should be cleared
```

---

### Finding #11: Fix `message.removed` Memory Leak in seenParts Map

**What's wrong:** In `event-translator.ts:563-570`, the `message.removed` handler has an empty loop:
```typescript
if (props.messageID) {
    for (const [_partID, _] of seenParts) {
        // We'd need message→part mapping, but for now just let the map grow
        // Real impl would track messageID→partIDs
    }
}
```
The seenParts map grows unboundedly because parts are never cleaned up when their parent message is removed. This is a slow memory leak in long-running relay sessions.

**Approach:** Store the `messageID` alongside each part entry in seenParts. When `message.removed` fires, iterate and delete matching entries.

**Files to modify:**
- `src/lib/event-translator.ts` — Change `seenParts` value type from `{ type: PartType; status?: ToolStatus }` to `{ type: PartType; status?: ToolStatus; messageID?: string }`
- `src/lib/event-translator.ts:674` (`handlePartUpdated`) — Store `messageID` from `event.properties.messageID` when setting seenParts entries
- `src/lib/event-translator.ts:563-570` — Replace empty loop with actual deletion of matching entries
- `src/lib/event-translator.ts:521` (`getSeenParts` return type) — Update the ReadonlyMap type

**Things to be careful of:**
1. **Performance.** Iterating the entire seenParts map on each `message.removed` is O(n). For typical sessions (<1000 parts), this is negligible. If perf matters later, build an inverted index (messageID → Set<partID>).
2. **Missing messageID.** Some `message.part.updated` events might not include `messageID` in their properties. Check the OpenCode SSE format — `messageID` should be present on all part events. If not, parts without messageID won't be cleaned up (safe but not ideal).
3. **The seenParts map is also exposed via `getSeenParts()`.** The return type needs updating. Check if any tests or callers depend on the exact shape.
4. **`rebuildStateFromHistory()` also populates seenParts.** It currently doesn't set messageID — update it too if message-level IDs are available in the history response.

**Mitigations:**
- Add a unit test: create translator, feed several part.updated events for message A, feed message.removed for A, verify seenParts is empty.
- Check existing event-translator tests for seenParts assertions.

**Verification:**
```bash
pnpm check
pnpm test

# Specific test:
pnpm vitest run test/unit/event-translator.stateful.test.ts
pnpm vitest run test/unit/event-translator.pbt.test.ts

# Verify: after message.removed, seenParts should have N fewer entries
```

---

## Phase E: Major Feature Rewiring

---

### Finding #1: Wire Up Plan Mode Server-Side Translation

**What's wrong:** The frontend has a complete `PlanMode.svelte` component and plan mode state in `ui.svelte.ts`. The `ws.svelte.ts` message handler has cases for `plan_enter`, `plan_exit`, `plan_content`, `plan_approval`. But the server never produces these messages. OpenCode doesn't have explicit "plan mode" SSE events — instead, plan mode is implemented as a tool use pattern (the LLM calls `EnterPlanMode` and `ExitPlanMode` tools).

**Files to modify:**
- `src/lib/event-translator.ts` — Detect plan mode tool names in `translateToolPartUpdated()` and emit plan-specific messages alongside the tool lifecycle messages
- `src/lib/types.ts` — Add plan mode message types to `RelayMessage` union
- `src/lib/ws-router.ts` — Add `"plan_approve"` and `"plan_reject"` to `IncomingMessageType` and `VALID_MESSAGE_TYPES`
- `src/lib/relay-stack.ts` — Add handlers for `plan_approve` and `plan_reject` (these map to answering a question or providing input to the session)

**Things to be careful of:**
1. **Tool name detection.** OpenCode's plan mode tools are `EnterPlanMode` and `ExitPlanMode`. The tool names in SSE events may be lowercase (`enterplanmode`) or camelCase. Normalize before checking.
2. **Plan content delivery.** The plan content is the text output of the planning session, delivered as regular `delta` messages. The frontend needs to distinguish between regular assistant text and plan content. This may require a state flag in the translator.
3. **Plan approval flow.** When the LLM exits plan mode, it typically waits for user approval. In OpenCode, this might manifest as a `question.asked` event or a specific tool pattern. Research how OpenCode handles this.
4. **This is behind an experimental flag in OpenCode.** Plan mode may not be available in all OpenCode versions. The translation should gracefully no-op if the tools aren't present.
5. **Frontend already has plan mode state.** The `ui.svelte.ts` plan mode state (Finding #19) should be KEPT (not removed) since this finding wires it up.
6. **The PlanMode.svelte sends `plan_approve`/`plan_reject`.** These need to be valid message types and handled server-side. The server handler would need to map these to an OpenCode API call (e.g., answering a pending question with "approved" or "rejected").

**Mitigations:**
- Start by researching OpenCode's actual plan mode implementation: look at `opencode/packages/opencode/src/` for how plan tools work.
- Implement a minimal version: detect `EnterPlanMode` tool start → emit `plan_enter`, detect `ExitPlanMode` tool result → emit `plan_exit`. Plan content comes through normal deltas.
- Test with a mock SSE stream that includes plan mode tool events.

**Verification:**
```bash
pnpm check
pnpm test

# Functional test:
# 1. Ask Claude to plan something (triggers EnterPlanMode)
# 2. Frontend should show plan mode banner
# 3. Plan content should appear in the plan card
# 4. Approve/reject buttons should work
```

---

### Finding #2: Replace Claude-Relay Rewind with OpenCode Revert

**What's wrong:** `RewindBanner.svelte` sends `{ type: "rewind", uuid, mode }` (line 50) — a message type inherited from claude-relay. The server doesn't recognize this type (it's not in `VALID_MESSAGE_TYPES`). OpenCode uses a completely different API for reverting: `POST /session/:id/revert` and `POST /session/:id/unrevert` REST endpoints.

**Fundamental mismatch:** Claude-relay's rewind is message-UUID-based and supports "both/conversation/files" modes. OpenCode's revert is turn-based — you revert to a specific message ID (not UUID), and it always reverts both conversation and files.

**Files to modify:**
- `src/lib/ws-router.ts` — Add `"revert"` and `"unrevert"` to valid message types (replacing/supplementing dead rewind)
- `src/lib/relay-stack.ts` — Add `case "revert"` handler that calls `client.revertSession(sessionId, messageId)` and `case "unrevert"` that calls `client.unrevertSession(sessionId)`
- `src/lib/public/components/overlays/RewindBanner.svelte` — Rewrite to use revert semantics: select a turn to revert to, show revert/unrevert actions. Remove the "both/conversation/files" radio buttons (OpenCode doesn't support mode selection).
- `src/lib/public/stores/ui.svelte.ts` — Simplify rewind state (rename to revert state)
- `src/lib/public/stores/ws.svelte.ts:406-408` — Update `rewind_result` handling or replace with `revert_result`
- `src/lib/opencode-client.ts` — Add `revertSession()` and `unrevertSession()` methods if not already present

**Things to be careful of:**
1. **OpenCode revert API.** Verify the exact endpoints and parameters. Check `opencode/packages/opencode/src/server/` for the revert route handlers.
2. **Message ID vs UUID.** OpenCode uses message IDs (from its SQLite database), not the frontend's generated UUIDs. The revert UI needs to know the OpenCode message ID for each turn. This means the translator needs to pass through `messageID` in its messages, and the chat store needs to track it.
3. **State after revert.** After calling revert, OpenCode will emit `message.removed` events for the reverted messages. The frontend should handle these (Finding #5) and clear the affected messages.
4. **Unrevert.** OpenCode supports unreverting (undoing a revert). The UI should have an "unrevert" button after a revert.
5. **No partial revert.** Unlike claude-relay's "conversation only" / "files only" modes, OpenCode always reverts everything. Don't offer mode selection.
6. **This depends on Finding #5 (`message_removed` handler) and Finding #15 (`rebuildStateFromHistory`)** — revert triggers `message.removed` events, and the client may need to rebuild state.

**Mitigations:**
- Read OpenCode's revert implementation to understand the exact protocol.
- Implement server-side revert/unrevert handlers first, test with curl.
- Then update the UI component.

**Verification:**
```bash
pnpm check
pnpm test

# Functional test:
# 1. Have a conversation with a few turns
# 2. Click "revert" on an earlier turn
# 3. Later messages should disappear
# 4. "Unrevert" button should appear
# 5. Clicking unrevert should restore the messages
```

---

### Finding #15: Wire Up `rebuildStateFromHistory`

**What's wrong:** The translator has a complete `rebuildStateFromHistory()` method (event-translator.ts:623-639) that populates `seenParts` from a list of historical messages. But nothing calls it. This means:
- After a session switch, `seenParts` is stale (has parts from the old session)
- After SSE reconnect, `seenParts` is empty (lost during disconnect)

In both cases, the translator can't correctly detect new vs. existing parts, causing duplicate tool_start events or missed thinking_start/stop lifecycle events.

**Files to modify:**
- `src/lib/relay-stack.ts` — Call `translator.rebuildStateFromHistory(messages)` in two places:
  1. After `switch_session` handler (after fetching the new session's message history)
  2. On SSE reconnect (in the `sseConsumer.on("connected", ...)` handler)
- `src/lib/opencode-client.ts` — Verify a `getMessages(sessionId)` method exists (or add one)

**Things to be careful of:**
1. **Message format.** `rebuildStateFromHistory()` expects `Array<{ parts?: Array<{ id, type, state? }> }>`. OpenCode's message history API returns messages with parts. Verify the shape matches.
2. **Performance.** For sessions with many messages (1000+), rebuilding is O(n * m) where m is parts per message. This should be fast enough (typically <100 parts per message, <100 messages fetched).
3. **Session switch timing.** The switch_session handler already calls `clearMessages()` and fetches history. Insert `rebuildStateFromHistory()` AFTER fetching history but BEFORE resuming SSE event processing. The SSE consumer may need to be paused briefly, or the translator reset with `translator.reset()` before rebuilding.
4. **SSE reconnect.** On reconnect, the translator may still have stale seenParts from before the disconnect. Call `translator.reset()` then `rebuildStateFromHistory()` with the current session's messages.
5. **The client needs a getMessages API.** Check if `opencode-client.ts` has this. OpenCode's API should have `GET /session/:id/messages`. If not, add it.
6. **Race conditions.** SSE events may arrive while rebuilding. The seenParts map is synchronous, so this should be safe (JS is single-threaded), but verify no async gap between rebuild and resuming event processing.

**Mitigations:**
- Add a test: create translator, rebuild from mock history, then feed a part.updated for an existing part → should NOT emit tool_start (it's not new).
- Test session switch: switch sessions, verify no duplicate tool_start messages in the new session.

**Verification:**
```bash
pnpm check
pnpm test

# Specific test:
pnpm vitest run test/unit/event-translator.stateful.test.ts

# Functional test:
# 1. Start a session, have Claude use some tools
# 2. Switch to a different session and back
# 3. Have Claude use more tools → should NOT see duplicate tool starts
```

---

### Finding #20: Deduplicate PTY Creation Logic + Remove Dead Command Handlers

**What's wrong:** `relay-stack.ts` has **two nearly identical PTY creation code paths:**
1. `terminal_command` with `action: "create"` (lines 979-1034) — 55 lines
2. `pty_create` (lines 1071-1131) — 60 lines

Both do the same thing: call `client.createPty()`, build a pty info object, broadcast `pty_created`, connect upstream WS, handle errors. They're copy-pasted with minor variable name differences.

**Additional dead code:**
- `terminal_command` with `action: "close"` / `action: "delete"` (lines 1035-1041) — duplicates `pty_close` handler (lines 1162-1170)
- `file_command` handler (lines 947-973) — duplicates `get_file_list` and `get_file_content` handlers (lines 918-945)
- `terminal_command` in `ws-router.ts` — should be removed or renamed

**Files to modify:**
- `src/lib/relay-stack.ts` — Extract `createAndConnectPty(clientId)` helper, replace both call sites
- `src/lib/relay-stack.ts` — Remove `file_command` handler entirely (lines 947-974)
- `src/lib/relay-stack.ts` — Simplify `terminal_command`: keep only `action: "list"` (rename handler if desired), remove create/close/delete sub-actions
- `src/lib/ws-router.ts` — Remove `"file_command"` from valid types, optionally remove `"terminal_command"` if replaced by direct types

**Things to be careful of:**
1. **Frontend sends `terminal_command`.** Check which message types `ChatLayout.svelte` or terminal components actually send. If they send `terminal_command` with `action: "create"`, we can't just remove the handler — we need to either keep it as a thin redirect or update the frontend.
2. **`file_command` usage.** Check if any frontend component sends `file_command`. If not, safe to remove. The frontend should use `get_file_list` and `get_file_content` directly.
3. **The `list` sub-action of `terminal_command`** reconnects upstream WS for running PTYs (lines 1047-1065). This reconnection logic doesn't exist in the `pty_create` path. The extracted helper should only handle creation; the reconnection logic should stay in the list handler.
4. **Error handling differences.** Compare error handling in both creation paths — ensure the extracted helper preserves the most complete error handling from both.
5. **`pty_close` vs `terminal_command close`.** These are identical. After extracting, keep only `pty_close`.

**Mitigations:**
- Search frontend for all WS message sends: `wsSend({` in Svelte components. Verify which message types are actually used.
- Extract the helper incrementally: first extract, then remove duplicates, then remove dead command handlers.
- Run `pnpm test:unit -- ws-router` after each change.

**Verification:**
```bash
pnpm check
pnpm test

# Specific tests:
pnpm vitest run test/unit/ws-router.pbt.test.ts
pnpm vitest run test/unit/ws-router-pty.test.ts

# Functional test:
# 1. Open terminal tab → should create PTY (via pty_create path)
# 2. Close terminal tab → should delete PTY (via pty_close path)
# 3. Open file browser → should list files (via get_file_list path)
```

---

## Cross-Cutting Concerns

### After All Findings

**Run the full verification suite:**
```bash
cd /Users/dstern/src/workspaces/opencode-relay/opencode-relay

# Type checking (both contexts)
pnpm check

# All unit tests
pnpm test:unit

# All fixture tests
pnpm test:fixture

# Lint + format
pnpm lint

# Full build (tsc + vite)
pnpm build

# Integration tests (if available)
pnpm test:integration 2>/dev/null || echo "No integration config"
```

**Check for orphaned imports:**
```bash
# After all removals, verify no broken imports remain
pnpm check   # tsc will catch these
```

**Check for dead test files:**
```bash
# Tests for removed modules should also be removed:
# - test/unit/input-sync.pbt.test.ts (Finding #7)
# - Any extractTodoFromToolResult tests (Finding #6)
```

**Update PROGRESS.md** after completing each finding per project requirements.

---

## Quick Reference: File Impact Map

| File | Findings |
|------|----------|
| `src/lib/relay-stack.ts` | #4, #6, #8, #9, #13, #15, #20 |
| `src/lib/event-translator.ts` | #1, #6, #11, #15 |
| `src/lib/ws-router.ts` | #1, #2, #6, #20 |
| `src/lib/types.ts` | #1, #10, #13, #16, #17 |
| `src/lib/daemon.ts` | #8, #9, #12 |
| `src/lib/public/stores/ws.svelte.ts` | #3, #4, #5, #19 |
| `src/lib/public/stores/ui.svelte.ts` | #2, #4, #19 |
| `src/lib/public/stores/chat.svelte.ts` | #5 |
| `src/lib/public/types.ts` | #10, #18, #19 |
| `src/lib/public/components/overlays/RewindBanner.svelte` | #2 |
| `src/lib/public/components/features/PlanMode.svelte` | #1 |
| `src/lib/input-sync.ts` | #7 (delete) |
| `src/lib/version-check.ts` | #8 |
| `src/lib/keep-awake.ts` | #9 |
| `src/lib/public/mockup-*.html` | #14 (delete 9 files) |
