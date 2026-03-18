# Codebase Cleanup Plan — Consolidated Audit Report

> **Purpose:** Line-by-line verification of every detail in `2026-02-25-codebase-cleanup-20-findings.md` against the actual codebase and OpenCode API. Every error, omission, and risk is documented below.

---

## 🔴 SHOW-STOPPERS (must fix before implementing)

These are errors in the plan that would cause implementation to fail or produce incorrect behavior.

### 1. Finding #6: Plan misses test files that import dead code

**Problem:** The plan says to remove `extractTodoFromToolResult()` and check "event-translator.stateful.test.ts or event-translator.pbt.test.ts" for tests. But the actual test file containing `extractTodoFromToolResult` imports and tests is `test/unit/m4-backend.test.ts`. There is also a `get_todo` test in `test/integration/flows/ws-handler-coverage.integration.ts`. Implementing the plan as written would leave broken imports in those files.

**Fix:** Add to the plan:
- Remove `extractTodoFromToolResult` tests from `test/unit/m4-backend.test.ts`
- Remove `get_todo` test from `test/integration/flows/ws-handler-coverage.integration.ts`
- Update `test/unit/ws-router.pbt.test.ts:519` hardcoded `toHaveLength(28)` assertion (decrement after removing types)
- Note: `ws-router.pbt.test.ts` is already missing `add_project` from its test arrays — fix that too

### 2. Finding #5: CRITICAL — `handlePartRemoved` will never match (callID vs partID mismatch)

**Problem:** The plan's proposed `handlePartRemoved` implementation filters `chatState.messages` by `(m as ToolMessage).id === partId`. But:
- `ToolMessage.id` stores the **callID** (set by `translateToolPartUpdated` using `part.callID ?? partID`)
- `part_removed.partId` comes from `translatePartRemoved` which uses `props.partID` (the OpenCode **part ID**)
- These are **different IDs**. `callID` is the AI SDK tool call identifier; `partID` is OpenCode's internal part identifier.
- The filter will **never match** when `callID !== partID`, which is the common case.

**Fix:** Either:
- (a) Include `callID` in the `part_removed` message from the translator (look it up in `seenParts`), OR
- (b) Maintain a reverse mapping `partID → callID` in the chat store, OR
- (c) Always use `partID` as the canonical tool ID everywhere (breaking change to `handleToolStart`)

### 3. Finding #5: `clearMessages()` on `message_removed` has destructive side effects

**Problem:** The plan says `handleMessageRemoved` should call `clearMessages()`. But `clearMessages()` (chat.svelte.ts:278-288) resets `streaming`, `processing`, `currentAssistantText`, and `messages`. During active streaming, this would destroy the current response. During compaction (which triggers `message.removed`), this would blank the UI mid-conversation.

**Fix:** `handleMessageRemoved` should NOT call `clearMessages()`. Instead:
- Track `messageID` in chat messages (requires Finding #11)
- Filter out only the specific removed message
- Or: request a full state refresh from the server instead of clearing locally

### 4. Finding #9: `setEnabled(true)` does NOT auto-activate

**Problem:** The plan says "The `setKeepAwake` IPC handler should call `keepAwake.setEnabled(enabled)` which handles activate/deactivate internally." This is **wrong**:
- `setEnabled(true)` only enables future `activate()` calls — it does NOT spawn caffeinate
- `setEnabled(false)` DOES deactivate if currently active
- The asymmetry means the IPC handler calling only `setEnabled(true)` would silently do nothing

**Fix:** The IPC handler must call both:
```typescript
keepAwakeInstance.setEnabled(enabled);
if (enabled) keepAwakeInstance.activate();
```

### 5. Finding #12: Daemon does NOT import `loadDaemonConfig`

**Problem:** The plan says "The daemon already has `loadDaemonConfig()`." But checking the actual imports in `daemon.ts`, it only imports `clearCrashInfo`, `clearDaemonConfig`, `saveDaemonConfig`, and `syncRecentProjects`. There is no `loadDaemonConfig` import.

**Fix:** Add `loadDaemonConfig` to the import statement in daemon.ts, or use `buildConfig()` if that's the intended config reader.

### 6. Finding #13: VersionChecker lives in daemon.ts, not relay-stack.ts

**Problem:** The plan says "modify relay-stack.ts — Broadcast `update_available` when VersionChecker emits." But per Finding #8, the VersionChecker is wired into the **daemon**, not relay-stack. The daemon manages version checking and would need to broadcast through its project relays.

**Fix:** The `update_available` broadcast should be wired in `daemon.ts` (where the VersionChecker lives), not in `relay-stack.ts`. The daemon iterates its project relay instances and broadcasts to each.

### 7. Finding #13: VersionChecker output format mismatches frontend expectation

**Problem:**
- `version-check.ts:247-250` emits `update_available` with `{ current, latest }`
- Frontend `ws.svelte.ts:446-478` `handleBannerMessage` expects `msg.version` for `update_available`
- These formats don't match — the frontend would receive `undefined` for `version`

**Fix:** Either change the VersionChecker to emit `{ version: latest }` or change the frontend to read `msg.latest`.

### 8. OpenCode API: TODO API EXISTS — plan incorrectly says it's dead code

**Problem:** The plan (Finding #6) says "The original plan was to extract todo items server-side from tool results, but the implementation went client-side instead" and recommends removing the server-side todo code. But **OpenCode has a fully functional todo API**:
- `GET /session/:sessionID/todo` REST endpoint
- `todo.updated` SSE event (type: `"todo.updated"`, payload: `{ sessionID, todos: Todo.Info[] }`)
- `Todo.Info` schema: `{ content: string, status: string, priority: string }`

The relay's event translator silently drops `todo.updated` events. The `extractTodoFromToolResult` code IS dead (it was the wrong approach), but the correct fix is to **wire up OpenCode's native todo API**, not remove all server-side todo support.

**Fix:**
- Still remove `extractTodoFromToolResult()` and `normalizeTodoItem()` (dead extraction code)
- Still remove the `get_todo` stub handler
- But ADD handling for `todo.updated` SSE events in the event translator
- Note the schema difference: OpenCode `Todo.Info` has `priority` field; relay `TodoItem` has `activeForm` field

### 9. OpenCode API: Plan mode tool names are WRONG and approval is already handled

**Problem:** Finding #1 says "plan mode is implemented as a tool use pattern (the LLM calls `EnterPlanMode` and `ExitPlanMode` tools)." This is **wrong on multiple levels**:

1. **Wrong tool names:** The actual tools are `plan_enter` and `plan_exit` (defined in `opencode/src/tool/plan.ts`), NOT `EnterPlanMode`/`ExitPlanMode`. They are snake_case, not PascalCase.
2. **Plan approval already works through the existing Question flow:** Both `plan_enter` and `plan_exit` call `Question.ask()` during execution, which emits standard `question.asked` SSE events. The relay's existing `QuestionBridge` and `ask_user_response`/`question_reject` handlers already handle this. No separate `plan_approve`/`plan_reject` mechanism is needed.
3. **PlanMode.svelte's `wsSend({ type: "plan_approve" })` is dead-on-arrival:** It sends no question ID or context, so even if a server handler existed, it couldn't know which Question to answer.
4. **CLI-only restriction:** Plan tools are only registered when `OPENCODE_EXPERIMENTAL_PLAN_MODE && OPENCODE_CLIENT === "cli"` (registry.ts:120). In server mode (how the relay connects), these tools may not be available at all.
5. **No `plan_approve`/`plan_reject` REST endpoint** exists in OpenCode — the plan's proposal to add server handlers for these is unnecessary.
6. **Config schema has `agent: { plan: Agent.optional(), ... }`** — plan mode is a first-class agent concept, not just a tool pattern.

**Fix:** Finding #1 needs a complete rewrite:
- Use correct tool names: `plan_enter` and `plan_exit`
- Do NOT add `plan_approve`/`plan_reject` to `VALID_MESSAGE_TYPES` or relay-stack — approval is handled by the existing Question bridge
- Detect plan mode via `tool_start` with name `plan_enter` or `plan_exit` — no special translator logic needed since these flow through the normal tool lifecycle
- Document that plan mode requires `OPENCODE_EXPERIMENTAL_PLAN_MODE=true` and may not work in server mode
- The existing `PlanMode.svelte` component's approval buttons should be removed or rewired to trigger through the Question UI instead

### 10. OpenCode API: Revert does NOT immediately remove messages

**Problem:** Finding #2 says "After calling revert, OpenCode will emit `message.removed` events for the reverted messages." This is **partially wrong**:
- `revert()` sets a `revert` marker on the session and reverts file snapshots
- Messages are NOT removed at revert time
- Messages are removed later by `cleanup()` (called during compaction/summarize)
- The `session.updated` event after revert includes the `revert.messageID` field

**Fix:** The frontend needs to handle revert differently:
- After revert API call, listen for `session.updated` with `revert` field
- Hide messages past the revert point using `session.revert.messageID`
- Don't wait for `message.removed` events (they come much later during cleanup)

---

## 🟡 HIGH-PRIORITY ISSUES (will cause bugs or incomplete features)

### 11. Finding #3: PRE-EXISTING BUG — `translateFileEvent()` reads `props.path` but OpenCode uses `file`

**Problem:** The event translator at `event-translator.ts:427` reads `props.path`:
```typescript
const props = event.properties as { path?: string };
if (!props.path) return null;
```
But BOTH OpenCode file events use `file` as the property name, not `path`:
- `file.edited` properties: `{ file: string }`
- `file.watcher.updated` properties: `{ file: string, event: "add"|"change"|"unlink" }`

This means `props.path` is ALWAYS `undefined`, and `translateFileEvent()` ALWAYS returns `null`. **File change events are completely broken and silently dropped.** This is a pre-existing bug that Finding #3 should fix but the plan doesn't identify at all.

**Fix:** Change `props.path` to `props.file` in `translateFileEvent()`. This is the actual root cause — the routing bug (sending to `_fileHistoryListeners`) is a secondary issue.

### 12. Finding #3: FileBrowser.svelte does NOT handle `file_changed` messages

**Problem:** The plan correctly identifies that `file_changed` should be routed to `_fileBrowserListeners` instead of `_fileHistoryListeners`. But it doesn't verify that `FileBrowser.svelte` actually handles `file_changed` messages when received. If FileBrowser only handles `file_list` and `file_content`, the rerouting alone won't fix anything.

**Fix:** Check `FileBrowser.svelte` for a `file_changed` handler. If missing, add one that triggers a refresh (re-fetch file list). Also check `FileViewer.svelte`.

### 13. Finding #4: `from` field not populated in broadcast message

**Problem:** The plan identifies the broadcast bug (`broadcast()` → `broadcastExcept()`) but doesn't mention that the `input_sync` message in `types.ts:120` has `from?: string` which is never populated by the server. Without a `from` field, the receiving client has no way to know who's typing.

**Fix:** When broadcasting `input_sync`, include `from: clientId` in the message.

### 14. Finding #4: Missing `inputSyncText` reset in `resetProjectUI()`

**Problem:** The plan adds `inputSyncText` to `ui.svelte.ts` state but doesn't mention resetting it in `resetProjectUI()`. When switching projects, stale sync text from the previous project would persist.

**Fix:** Add `uiState.inputSyncText = ""` to `resetProjectUI()`.

### 15. Finding #10: Removing `children` from `FileEntry` breaks existing code

**Problem:** The plan says "remove dead `children` field from `FileEntry`." But `children?: FileEntry[]` is used by:
- `src/lib/public/components/features/FileTreeNode.stories.ts` (Storybook stories)
- `src/lib/public/stories/mocks.ts` (test mocks)

**Fix:** Either keep `children` or update both files when removing it.

### 16. Finding #10: Removing `processing` from `SessionInfo` breaks existing code

**Problem:** The plan says "remove dead `processing` field from `SessionInfo`." But `processing` is read at `SessionItem.svelte:67`. Removing it would cause a TypeScript error.

**Fix:** Either keep `processing` on `SessionInfo` or update `SessionItem.svelte` to read processing state from `chatState.processing` instead.

### 17. Finding #10: `pnpm check` only checks server context

**Problem:** The plan says "Run `pnpm check` after each incremental change" and claims this verifies "both tsconfig contexts." But `pnpm check` runs `tsc --noEmit` which uses the root `tsconfig.json` — this excludes `src/lib/public/`. Frontend type errors would be caught only by `pnpm build` (Vite build).

**Fix:** The verification step should run BOTH `pnpm check` AND `pnpm build` (or add a separate `pnpm check:frontend` script).

### 18. Finding #11: `rebuildStateFromHistory()` NOT listed in files to modify

**Problem:** Finding #11 changes the `seenParts` value type to include `messageID`. But `rebuildStateFromHistory()` also populates `seenParts` and does NOT currently set `messageID`. The plan lists this as a "thing to be careful of" but doesn't include it in "Files to modify."

**Fix:** Add `rebuildStateFromHistory()` to the files to modify list. It needs to extract `messageID` from each message when populating seenParts.

### 19. Finding #2: Frontend has no way to know OpenCode message IDs

**Problem:** The plan says "The revert UI needs to know the OpenCode message ID for each turn." But currently:
- `handlePartUpdated` in `event-translator.ts` does NOT include `messageID` in its output properties type (lines 649-664)
- `translatePartDelta` extracts `messageID` (line 45) but does NOT pass it through to relay messages
- The chat store has no concept of OpenCode message IDs
- This means the revert button cannot know which `messageID` to send to OpenCode

**Fix:** This is a fundamental blocker for Finding #2. Before implementing revert:
- Pass `messageID` through the translator pipeline in every message
- Store `messageID` in the chat store alongside each message group
- Map frontend message UUIDs to OpenCode message IDs

### 20. Finding #1: Double-send of plan_approve/plan_reject

**Problem:** The plan doesn't mention that both `PlanMode.svelte` AND `ChatLayout.svelte` would send `plan_approve`/`plan_reject`:
- PlanMode.svelte: calls `onApprove?.()` (ChatLayout's callback) AND `wsSend({ type: "plan_approve" })`
- ChatLayout.svelte: the `onApprove` callback ALSO calls `wsSend({ type: "plan_approve" })`
- Result: the message would be sent **twice**

**Fix:** Remove one of the send paths. Either PlanMode should only call the callback (not wsSend directly), or ChatLayout should not send in the callback.

### 21. Finding #20: `terminal_command list` is actively used and critical

**Problem:** The plan suggests removing `terminal_command` but doesn't clearly flag that:
- `ChatLayout.svelte:177` sends `terminal_command` with `action: "list"` on EVERY WebSocket connection
- The `list` handler (lines 1054-1078) has unique reconnection logic for running PTYs
- This reconnection logic does NOT exist in any `pty_*` handler
- Removing `terminal_command` without replacement would silently break terminal reconnection after relay restart

**Fix:** Either:
- Keep `terminal_command` for the `list` action only (remove create/close/delete sub-actions)
- OR migrate ChatLayout to send `pty_list` and create a new handler with the reconnection logic

### 21. Finding #15: `switch_session` does NOT fetch message history

**Problem:** The plan says (line 708): "The switch_session handler already calls `clearMessages()` and fetches history." But the actual `switch_session` handler (relay-stack.ts:675-703) calls `sessionMgr.switchSession(id)` and `client.getSession(id)` — it does NOT fetch message history. There is no `client.getMessages(id)` call. The history fetch would need to be **added** as a new step.

Similarly, the SSE reconnect handler (`sseConsumer.on("connected", ...)` at line 1230) is just a log statement — no existing reconnect infrastructure to hook into. Both call sites need to be written from scratch.

**Fix:** Add `const messages = await client.getMessages(id)` to the `switch_session` handler, then call `translator.rebuildStateFromHistory(messages)`.

### 22. Finding #15: Race condition during async rebuild

**Problem:** The plan dismisses race conditions because "JS is single-threaded." But `client.getMessages()` is async. During the `await`:
1. Call `translator.reset()` — seenParts now empty
2. `await client.getMessages()` — SSE events can fire during this await
3. Events arrive with empty seenParts → all parts treated as new → duplicate `tool_start` emissions
4. Call `rebuildStateFromHistory()` — too late, duplicates already emitted

**Fix:** Either:
- Pause SSE processing during the rebuild window
- Accept transient duplicates (document this as known behavior)
- Buffer SSE events during rebuild and replay after

### 23. Finding #8: Version hardcoded in 5+ files, not just version-check.ts

**Problem:** The plan mentions `CURRENT_VERSION = "0.1.0"` in `version-check.ts:11`. But the same version is hardcoded in at least 5 other files. There's no central version constant.

**Fix:** Create a single `getVersion()` utility that reads from `package.json` and use it everywhere, or ensure `version-check.ts` is the canonical source that others import.

### 24. OpenCode API: `installation.update-available` SSE events exist but relay ignores them

**Problem:** OpenCode emits `installation.update-available` events with `{ version: string }` and `installation.updated` events. The relay's event translator silently drops these. The plan discusses wiring the relay's own npm version check but doesn't mention consuming OpenCode's update events.

**Fix:** The event translator should handle `installation.update-available` events and forward them to the frontend. This provides update notifications for OpenCode itself, separate from relay updates.

---

## 🟢 MEDIUM/LOW ISSUES (should fix but won't cause failures)

### 25. Finding #1: `plan-mode.css` is orphaned and not mentioned in plan

**Problem:** `src/lib/public/plan-mode.css` (105 lines) contains styles for `.plan-banner`, `.plan-card`, `.plan-approval`. It is never imported anywhere — not by `style.css`, not by any Svelte component, not by any HTML file. The plan doesn't mention this file.

**Fix:** If wiring up plan mode (Finding #1), import `plan-mode.css` in `style.css`. If removing plan mode, delete the file.

### 26. Finding #1: PlanMode.stories.ts exists

**Problem:** `src/lib/public/components/features/PlanMode.stories.ts` imports PlanMode for Storybook visual testing. The plan doesn't mention it. If plan mode is reworked or removed, this file needs updating.

### 27. Finding #2: OpenCode revert supports optional `partID` parameter

**Problem:** The plan says "OpenCode's revert is turn-based — you revert to a specific message ID." But `RevertInput` also accepts an optional `partID` for part-level granularity. The plan omits this parameter.

**Fix:** Note this capability for future enhancement. The initial implementation can omit it.

### 28. Finding #2: Extensive rewind CSS and logic not mentioned

**Problem:** The plan lists files to modify for rewind→revert but misses:
- `style.css` lines ~613-702: `.rewind-banner`, `.rewind-point`, `.rewind-dimmed`, `.rewind-timeline-*` CSS
- `MessageList.svelte` lines 94, 127-137: rewind mode click handling and CSS classes
- `RewindBanner.stories.ts`: Storybook stories for visual testing

### 29. Finding #2: `opencode-client.ts` already has revert methods

**Problem:** The plan says "Add `revertSession()` and `unrevertSession()` methods if not already present." They ARE already present at lines 389-394. The plan's phrasing is misleading.

### 30. Finding #3: Line number off by 1

**Problem:** Plan says `onFileHistory()` end line is 514. Actual is 515.

### 31. Finding #8: Path resolution concern for package.json

**Problem:** When reading version from `package.json`, the path resolution must account for the compiled output. After `tsc` compiles to `dist/`, `import.meta.url` points to `dist/lib/version-check.js`, so a relative path to `../../package.json` must be correct from the dist location.

### 32. Finding #8: Standalone relay gets no version checking

**Problem:** The plan says "Start with daemon-only" for version checking. But standalone relay users (dev-server, skeleton mode) would never get update notifications.

### 33. Finding #9: KeepAwake should be created in constructor, not start()

**Problem:** The KeepAwake instance should be created in the daemon constructor (alongside other instance members) and activated in `start()`. Creating it in `start()` means the field would be undefined before start is called.

### 34. Finding #9: `detached: false` doesn't guarantee child dies on SIGKILL

**Problem:** The plan says "the process is spawned with `detached: false` so it dies with the parent." `detached: false` only means the child is in the parent's process group. If the parent is killed with SIGKILL (kill -9), the child process may survive as an orphan. This is an edge case but worth documenting.

### 35. Finding #12: PIN change doesn't invalidate existing sessions

**Problem:** When SIGHUP reloads config and changes the PIN hash, existing authenticated sessions/cookies remain valid. This is a security concern — a PIN change should arguably invalidate existing sessions.

### 36. Finding #12: `dangerouslySkipPermissions` and `debug` fields not discussed

**Problem:** The plan's SIGHUP reload doesn't mention which config fields are safe vs unsafe to hot-reload. `dangerouslySkipPermissions` and `debug` are config fields that could be safely hot-reloaded but aren't discussed.

### 37. Finding #13: `skip_permissions` has no OpenCode counterpart

**Problem:** OpenCode does NOT have `dangerouslySkipPermissions` or any equivalent. The concept is from Claude Code / Claude Agent SDK. The plan correctly hedges but should be definitive: this cannot be implemented.

### 38. Finding #15: Plan conflates server/client behavior

**Problem:** The plan says "The switch_session handler already calls `clearMessages()` and fetches history." But `clearMessages()` is called on the **frontend** (via `handleSessionSwitched` in `ws.svelte.ts`), not on the server. The server calls `translator.reset()` and `sseConsumer.setSessionFilter()`.

### 39. Finding #19: Line ranges off

**Problem:** Plan says `resetProjectUI()` plan mode reset is at "lines 287-291." Lines 287-288 are rewind reset; 289-291 are plan mode reset.

### 40. Finding #20: All line numbers off by ~10-12 lines

**Problem:** Every line reference for relay-stack.ts in Finding #20 is off by 10-12 lines:
- `terminal_command` create: plan says 979-1034, actual is 989-1046
- `pty_create`: plan says 1071-1131, actual is 1083-1143
- `file_command`: plan says 947-973, actual is 959-986
- All appear to be from an older version of the file

### 41. Finding #20: Integration test not mentioned

**Problem:** `test/integration/flows/terminal.integration.ts` lines 595+609 has a test "terminal_command list returns existing PTYs after creation." Removing `terminal_command` would break this test. The plan mentions ws-router tests but not this integration test.

### 42. Finding #10: `AskUserQuestion` has required-vs-optional differences

**Problem:** The plan doesn't list `AskUserQuestion` type differences between server and frontend types. There are field optionality differences that could cause runtime issues.

### 43. Finding #10: `SessionInfo` and `ProjectInfo` have structural differences

**Problem:** Beyond `processing`, there are other structural differences between server and frontend `SessionInfo`/`ProjectInfo` types not discussed in the plan.

---

## Cross-Cutting: OpenCode API Alignment Summary

| Area | Plan's Assumption | Reality | Impact |
|------|-------------------|---------|--------|
| Todo API | Dead, remove | **Exists**: `GET /session/:id/todo` + `todo.updated` SSE | 🔴 Plan recommends wrong action |
| Plan mode | Tool-based (`EnterPlanMode`/`ExitPlanMode`) | **Tools are `plan_enter`/`plan_exit`**; they call `Question.ask()` for approval | 🔴 Finding #1 needs rewrite; approval already handled by Question bridge |
| Plan approval | Maps to REST endpoint | **No endpoint** — uses existing Question flow via `Question.ask()` | 🔴 `plan_approve`/`plan_reject` handlers are unnecessary |
| Revert timing | Immediate message removal | **Deferred** — removal at cleanup time | 🔴 Frontend handling wrong |
| Revert granularity | Message-level only | Supports optional `partID` | 🟢 Enhancement opportunity |
| Skip permissions | May exist in config | **Does not exist** in OpenCode | 🟡 Plan correctly hedges |
| Version updates | Relay checks npm independently | OpenCode emits `installation.update-available` | 🟡 Missing opportunity |
| Session processing | `processing` field dead | Correct — uses `session.status` events | 🟢 Plan is correct |
| File events | `translateFileEvent` reads `props.path` | **Property is `file`, not `path`** — events silently dropped | 🔴 Pre-existing bug; file changes completely broken |
| PTY API | Duplicate creation paths | Correct — internal relay issue | 🟢 Plan is correct |
| Input sync | Relay-only feature | Correct — no OpenCode counterpart | 🟢 Plan is correct |
| `message.removed` | Fires during revert/compaction | Only fires during **revert cleanup**, NOT compaction | 🟡 Plan overstates when this fires |
| `message.part.removed` | Exists with `partID`, `messageID` | Correct, but callID mismatch | 🔴 See show-stopper #2 |
| `Message` wire format | Flat `{ id, role, parts }` | **Nested** `{ info: { id, role }, parts }` | 🟡 `message.id` returns undefined; `parts` works |

---

## Updated Phase Recommendations

Given these audit findings, the phase order should be reconsidered:

### Phase A: Safe Deletions — MOSTLY SAFE
- **#6:** Proceed with removing dead extraction code, BUT add `todo.updated` SSE handling as a separate follow-up ticket. Don't remove `TodoItem`/`TodoStatus` types (they'll be needed for the SSE handler).
- **#7, #14, #16, #17:** Safe as written.

### Phase B: Type Cleanup — NEEDS CARE
- **#10:** Must update `FileTreeNode.stories.ts`, `stories/mocks.ts`, and `SessionItem.svelte` when removing `children`/`processing`. Must run `pnpm build` not just `pnpm check`.
- **#18:** Safe after #3.
- **#19:** DEFER until Finding #1 design is finalized (plan mode architecture is different than assumed).

### Phase C: Wire Up Orphans — HAS ERRORS
- **#8:** Fix version reading, add `installation.update-available` SSE handling.
- **#9:** Fix `setEnabled`/`activate` confusion.
- **#12:** Add missing `loadDaemonConfig` import.
- **#13:** Fix broadcast location (daemon not relay-stack), fix message format, mark `skip_permissions` as not implementable.

### Phase D: Fix Broken Features — HAS CRITICAL BUG
- **#3:** Also update FileBrowser.svelte to handle `file_changed`.
- **#4:** Also populate `from` field, reset `inputSyncText` in `resetProjectUI()`.
- **#5:** CRITICAL — rewrite `handlePartRemoved` to handle callID/partID mismatch. Do NOT use `clearMessages()` for `handleMessageRemoved`.
- **#11:** Also update `rebuildStateFromHistory()`.

### Phase E: Major Feature Rewiring — NEEDS REDESIGN
- **#1:** Needs complete rewrite — agent-based detection, no REST approval endpoint.
- **#2:** Needs adjustment — deferred message removal, missing messageID pipeline.
- **#15:** Address race condition explicitly.
- **#20:** Keep `terminal_command list`, update integration test.

---

## Files Missing from Plan's Impact Map

The plan's "Quick Reference: File Impact Map" is incomplete. Missing entries:

| File | Finding | What's needed |
|------|---------|---------------|
| `test/unit/m4-backend.test.ts` | #6 | Remove extractTodoFromToolResult tests |
| `test/integration/flows/ws-handler-coverage.integration.ts` | #6 | Remove get_todo test |
| `test/unit/ws-router.pbt.test.ts` | #6, #20 | Update type count assertions |
| `test/integration/flows/terminal.integration.ts` | #20 | Update terminal_command tests |
| `src/lib/public/plan-mode.css` | #1 | Import or delete |
| `src/lib/public/components/features/PlanMode.stories.ts` | #1 | Update if plan mode changes |
| `src/lib/public/components/overlays/RewindBanner.stories.ts` | #2 | Update if rewind→revert |
| `src/lib/public/components/chat/MessageList.svelte` | #2 | Update rewind click handling |
| `src/lib/public/style.css` (lines 613-702, 823-884) | #2, #18 | Rewind CSS + file history CSS |
| `src/lib/public/components/features/FileTreeNode.stories.ts` | #10 | Update if children removed |
| `src/lib/public/stories/mocks.ts` | #10 | Update if children removed |
| `src/lib/public/components/chat/ChatLayout.svelte` | #1, #19 | Plan mode subscription removal |
| `src/lib/public/components/sessions/SessionItem.svelte` | #10 | Update if processing removed |
| `test/e2e/specs/advanced-ui.spec.ts` | #18 | Remove dead file history test |
