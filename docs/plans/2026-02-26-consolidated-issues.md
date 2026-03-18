# Consolidated Issue List — 2026-02-26

Post-Svelte-migration audit. Supersedes both prior documents. Every issue verified against the current codebase at commit `af46e0b`.

**Context:** opencode-relay is a stateless translation layer: Browser ←WS→ Server ←HTTP/SSE→ OpenCode (port 4096). A `MessageCache` records translated events per session (JSONL + memory) and replays them on session switch. The frontend is Svelte 5 with rune-based stores.

---

## 🔴 CRITICAL — Causes broken behavior visible to users

### C1. Session switch loses events from background processing

**Files:** `src/lib/relay-stack.ts:1393`, `src/lib/sse-consumer.ts:237-243`, `src/lib/relay-stack.ts:604-607`

**Bug:** When the user switches sessions while OpenCode is still processing, all remaining events from the old session are silently dropped.

**Sequence:**
1. User sends a message in Session A. OpenCode starts streaming back.
2. Relay records events to Session A's cache (`messageCache.recordEvent(activeId, msg)` at line 1393).
3. User switches to Session B mid-stream.
4. `sessionMgr.switchSession("b")` fires `session_changed` → `translator.reset()` + `sseConsumer.setSessionFilter("b")` (lines 604-607).
5. OpenCode continues sending Session A events — it doesn't know we switched.
6. SSE consumer rejects them: `sessionID !== this.sessionFilter` (line 240). **Events are never recorded, never broadcast.**
7. When the user switches back to Session A, the cache has only partial data (everything up to the switch point). The rest of the conversation is gone.
8. REST API fallback (`sessionMgr.loadHistory()`) fetches from OpenCode's database, which DOES have the full conversation. But the history format (structured messages) goes through `_historyPageListeners`, NOT `replayEvents()`. If no HistoryView is mounted, the data is silently dropped.

**Fix options:**
- (a) Record events by their `sessionID` from the SSE event, not `getActiveSessionId()`. Accept events for any session, not just the active one.
- (b) On switch-back, always invalidate the cache and rebuild from REST API + `rebuildStateFromHistory()`.
- (c) Keep SSE filter accepting all sessions; only filter what gets broadcast. Record everything to the correct session's cache.

**Test:** Integration test: send message → switch session mid-stream → wait 0.5s → switch back → verify full conversation is present.

---

### C2. `translateFileEvent()` reads `props.path` — OpenCode sends `props.file`

**File:** `src/lib/event-translator.ts:427-428`

**Bug:** `const props = event.properties as { path?: string }; if (!props.path) return null;`
OpenCode's `file.edited` and `file.watcher.updated` events use `{ file: string }`, not `{ path: string }`. Every file change event returns `null` — file changes are completely broken and silently dropped.

**Fix:** Change `props.path` to `props.file`.

**Test:** Unit test: call `translateFileEvent()` with `{ file: "src/foo.ts" }` and verify non-null result.

---

### C3. `rewind`, `plan_approve`, `plan_reject` not in VALID_MESSAGE_TYPES

**File:** `src/lib/ws-router.ts:41-71`

**Bug:** The frontend sends these three message types, but none are in `VALID_MESSAGE_TYPES`. The router rejects them as `UNKNOWN_MESSAGE_TYPE` at line 119-125. These features are completely non-functional:

| Type | Sent by | Lines |
|------|---------|-------|
| `rewind` | `RewindBanner.svelte` | Line 50 |
| `plan_approve` | `PlanMode.svelte` + `ChatLayout.svelte` | Lines 56, 209 |
| `plan_reject` | `PlanMode.svelte` + `ChatLayout.svelte` | Lines 61, 210 |

**Additional issue with plan_approve/plan_reject:** Even if added to the router, there's no handler in `relay-stack.ts`, no REST endpoint in OpenCode, and a **double-send bug** — `PlanMode.svelte` calls both `onApprove?.()` (which triggers ChatLayout's callback sending `plan_approve`) AND directly sends `plan_approve` via `wsSend()`.

**Fix for rewind:** Add `"rewind"` to `VALID_MESSAGE_TYPES` and add a handler in relay-stack that calls `client.revertSession()`.

**Fix for plan mode:** Per the audit report (finding #9), plan mode approval is handled through the existing Question flow (`Question.ask()`). Remove the dead `plan_approve`/`plan_reject` sends. PlanMode's approve/reject buttons should trigger through the Question UI. Or: defer plan mode entirely since it requires `OPENCODE_EXPERIMENTAL_PLAN_MODE=true`.

**Test:** Integration test: send `rewind` message → verify it reaches a handler and calls the correct OpenCode API.

---

### C4. `messageID` not passed through event translator

**Files:** `src/lib/event-translator.ts:39-67` (translatePartDelta), `src/lib/public/stores/chat.svelte.ts`

**Bug:** `translatePartDelta()` extracts `messageID` from the event properties (line 45) but never includes it in the returned `RelayMessage`. The frontend has no concept of OpenCode message IDs. This blocks:
- **Revert:** The revert API requires a `messageID`. Without it, the frontend can't know which message to revert to.
- **Message-level operations:** Any future feature needing per-message targeting.

**Fix:** Include `messageID` in all translated messages that have one. Add `messageID?: string` to relevant `RelayMessage` variants. Store it in the chat store alongside messages.

**Test:** Unit test: `translatePartDelta()` with a `messageID` in properties → verify it appears in the output.

---

### C5. Translator state not rebuilt after session switch

**Files:** `src/lib/relay-stack.ts:604-607,740`, `src/lib/event-translator.ts:615-617`

**Bug:** When switching to a session:
1. `translator.reset()` clears `seenParts` (line 605).
2. Cached events are sent to the client (line 740-748).
3. New SSE events arrive for the switched-to session.
4. The translator has empty `seenParts`, so every part it sees emits `tool_start` as if new — even parts that are already in the cached events the client just replayed.

This causes duplicate `tool_start` messages if OpenCode is still actively processing in the session being switched to.

**Fix:** After switching, call `translator.rebuildStateFromHistory()` with the REST API response. Or: record the original `OpenCodeEvent` alongside the `RelayMessage` in the cache so the translator can rebuild from it.

**Test:** Integration test: start a tool in Session A → switch away → switch back → send new event for the same tool → verify no duplicate `tool_start`.

---

## 🟡 HIGH — Causes bugs, data loss, or stuck UI

### H1. SSE consumer fire-and-forget error swallowing

**File:** `src/lib/sse-consumer.ts:74`

**Bug:** `this.startStream().catch(() => {})` swallows all errors. If `startStream()` throws before the try/catch inside it can emit an error event (e.g., `fetch` itself throws due to DNS resolution failure), the error is silently lost. The relay stack has no way to know the SSE connection failed.

**Fix:** Change to `.catch((err) => { this.emit("error", err); this.scheduleReconnect(); })` or await the promise in `connect()`.

**Test:** Unit test: mock `fetch` to throw before returning → verify `error` event is emitted.

---

### H2. Permission/question timeout checks never called

**File:** `src/lib/permission-bridge.ts:125-137`, `src/lib/question-bridge.ts:135-148`, `src/lib/relay-stack.ts` (no call site)

**Bug:** Both bridges have `checkTimeouts()` methods that identify timed-out entries. But nobody calls them — no `setInterval`, no periodic check. Permissions and questions that the user never responds to stay pending forever, blocking OpenCode's execution.

**Fix:** Add a periodic timer in relay-stack that calls `permissionBridge.checkTimeouts()` and `questionBridge.checkTimeouts()` every 30-60 seconds, and auto-denies or broadcasts the timeout to clients.

**Test:** Unit test: create a permission with a low timeout → advance time → call `checkTimeouts()` → verify it's removed.

---

### H3. `input_sync` broadcast echoes back to sender, missing `from` field

**File:** `src/lib/relay-stack.ts:1282-1288`

**Bug:** Two issues:
1. Uses `wsHandler.broadcast()` instead of `wsHandler.broadcastExcept(msg, clientId)`. The sender receives their own typing text back.
2. No `from: clientId` in the broadcast. Receivers can't tell who's typing.

```typescript
// CURRENT
wsHandler.broadcast({ type: "input_sync", text: String(payload.text ?? "") });

// SHOULD BE
wsHandler.broadcastExcept(
  { type: "input_sync", text: String(payload.text ?? ""), from: clientId },
  clientId
);
```

**Fix:** Use `broadcastExcept` and include `from`.

**Test:** Integration test: two clients connected → client A sends `input_sync` → verify client A does NOT receive it, client B does with `from` populated.

---

### H4. `file_changed` routed to `_fileHistoryListeners` instead of `_fileBrowserListeners`

**File:** `src/lib/public/stores/ws.svelte.ts:424`

**Bug:** `file_changed` messages are dispatched to `_fileHistoryListeners` but FileBrowser.svelte only subscribes to `_fileBrowserListeners`. File change notifications never reach the file browser UI.

Additionally, `FileBrowser.svelte` has no `file_changed` handler — it only handles `file_list` and `file_content`. Even if routing were fixed, the component wouldn't act on the event.

**Fix:** Route `file_changed` to `_fileBrowserListeners`. Add a handler in FileBrowser.svelte that triggers a file list refresh when a file change is detected.

**Test:** Unit test: dispatch `file_changed` → verify `_fileBrowserListeners` called. Integration test: file change event → FileBrowser refreshes.

---

### H5. `todo.updated` SSE events silently dropped

**Files:** `src/lib/event-translator.ts` (no handler), `src/lib/relay-stack.ts:1291-1293`

**Bug:** OpenCode has a fully functional todo API:
- `GET /session/:sessionID/todo` REST endpoint
- `todo.updated` SSE event with `{ sessionID, todos: Todo.Info[] }`

The event translator has no case for `todo.updated` — these events return `null` and are silently dropped. The `get_todo` handler (line 1291) returns a hardcoded empty array `{ type: "todo_state", items: [] }`. Meanwhile, the dead code `extractTodoFromToolResult()` (line 448) and `normalizeTodoItem()` (line 494) still exist.

**Fix:**
1. Remove dead extraction code (`extractTodoFromToolResult`, `normalizeTodoItem`).
2. Add `todo.updated` case to translator that emits `{ type: "todo_state", items }`.
3. Fix `get_todo` handler to call `client.getTodos(sessionId)` (or equivalent).

**Test:** Unit test: `translate({ type: "todo.updated", properties: { todos: [...] }})` → verify `todo_state` output.

---

### H6. Version hardcoded in 6 places

**Files:** `src/lib/version-check.ts:11`, `src/lib/daemon.ts:857,872`, `src/lib/server.ts:318,445`, `package.json`

**Bug:** `"0.1.0"` is copy-pasted into every file. Version bumps require manual updates in 6 places. API responses always report the wrong version.

**Fix:** Create a `getVersion()` utility that reads from `package.json` at startup. Import it everywhere.

**Test:** Unit test: `getVersion()` returns the value from `package.json`.

---

### H7. MessageCache grows unbounded

**File:** `src/lib/message-cache.ts`

**Bug:** Every translated event is appended to an in-memory array and a JSONL file, forever. No max size, no TTL, no eviction on session delete (the `remove()` method exists but is only called on explicit `delete_session`). Long sessions with hundreds of tool calls accumulate significant memory. JSONL files on disk grow indefinitely.

**Fix:** Add a max event count per session (e.g., 5000 events). Evict oldest events when the limit is reached. Consider expiring cache entries for sessions not accessed in > 1 hour.

**Test:** Unit test: record 6000 events → verify only 5000 remain.

---

### H8. `session_switched` broadcast affects ALL clients

**File:** `src/lib/relay-stack.ts:743`

**Bug:** When one client switches sessions, the server calls `wsHandler.broadcast({ type: "session_switched", ... })`. Every connected client receives this and switches to the new session, clearing their messages.

This is by design for single-user relay usage. But with multi-client support (phone + laptop), one device switching sessions hijacks the other. This was a known design decision but is increasingly problematic now that the relay supports multi-device usage via the daemon.

**Fix:** Consider `wsHandler.sendTo(clientId, ...)` for the `session_switched` message. Requires rethinking the active session model (per-client vs. per-relay).

**Test:** Integration test: two clients connected → client A switches session → verify client B is NOT affected.

---

## 🟢 MEDIUM — Should fix, won't cause crashes

### M1. `consumeStream()` has a try-finally but errors from `reader.read()` propagate uncaught

**File:** `src/lib/sse-consumer.ts:159-189`

**Bug:** The `try` block in `consumeStream()` has no `catch` — only `finally`. If `reader.read()` throws (e.g., network error mid-stream), the error propagates to `startStream()` which catches it. Actually this IS caught by the `catch` in `startStream()` (line 144), so this is not a real bug but an indirect error path.

**Reassessment:** The error path works: `consumeStream()` throws → caught by `startStream()`'s `catch` → emits `disconnected` + `error` → schedules reconnect. The agent report overestimated this; it's actually fine.

---

### M2. `plan-mode.css` not imported

**File:** `src/lib/public/plan-mode.css`

**Bug:** Contains `.plan-banner`, `.plan-card`, `.plan-approval` styles. No explicit `@import` found in `style.css` or any component. The plan mode components may be unstyled.

**Fix:** Either import in `style.css` or convert to component-level `<style>` blocks in PlanMode.svelte.

---

### M3. `installation.update-available` SSE events ignored

**File:** `src/lib/event-translator.ts`

**Bug:** OpenCode emits `installation.update-available` with `{ version: string }` and `installation.updated` events. The translator silently drops them. This would provide update notifications for OpenCode itself (separate from relay version checks).

**Fix:** Add handler: `if (eventType === "installation.update-available") return { type: "update_available", version: props.version }`.

---

### M4. `part_removed` and `message_removed` have no frontend handlers

**File:** `src/lib/public/stores/ws.svelte.ts` (no case for these types)

**Bug:** The event translator generates `part_removed` and `message_removed` messages. The server broadcasts them. But the frontend's message dispatcher has no case for either — they fall through to the `default` debug log. Tool parts removed during compaction won't disappear. Messages removed after revert won't disappear.

**Fix:** Add cases to the message dispatcher. `part_removed` → remove the tool message from `chatState.messages`. `message_removed` → remove the corresponding message (requires messageID tracking — see C4).

---

### M5. `pnpm check` doesn't validate frontend types

**File:** `tsconfig.json`, `src/lib/public/tsconfig.json`

**Bug:** `pnpm check` runs `tsc --noEmit` using root `tsconfig.json`, which excludes `src/lib/public/`. Frontend type errors are only caught by `pnpm build` (Vite). Developers can introduce type errors in Svelte stores/utils that pass CI if only `pnpm check` is run.

**Fix:** Add `pnpm check:frontend` script, or update CI to run both `pnpm check` and `pnpm build`.

---

### M6. `FileEntry.children` and `SessionInfo.processing` may become dead fields

**Files:** `src/lib/public/types.ts:147,74`

**Status:** Both fields are currently used — `children` by `FileTreeNode.stories.ts` and `stories/mocks.ts`; `processing` by `SessionItem.svelte:67`. These are NOT dead code. The original audit's recommendation to remove them was wrong; they should be kept.

---

### M7. VersionChecker output format mismatches frontend expectation

**Files:** `src/lib/version-check.ts:247-250`, `src/lib/public/stores/ws.svelte.ts:531`

**Bug:** VersionChecker emits `{ current, latest }`. Frontend `handleBannerMessage` reads `msg.version`. These formats don't match — the frontend would receive `undefined` for `version`. Not currently visible because the VersionChecker is never wired into the daemon's broadcast.

**Fix:** When wiring VersionChecker, ensure the message format includes `version: latest`.

---

### M8. No deduplication of cached events on replay

**File:** `src/lib/message-cache.ts`, `src/lib/public/stores/ws.svelte.ts:458-506`

**Bug:** If the MessageCache somehow records duplicate events (e.g., due to reconnection or retry), `replayEvents()` will process them all, creating duplicate messages in the chat UI. There's no dedup logic.

**Fix:** Low priority — add a `Set<string>` of event hashes during replay, or dedup in the cache on write.

---

### M9. KeepAwake `setEnabled(true)` does not auto-activate

**File:** `src/lib/keep-awake.ts` (if it exists in current form)

**Bug:** `setEnabled(true)` only enables future `activate()` calls — it does NOT spawn the caffeinate process. The IPC handler needs to call both `setEnabled(enabled)` and `if (enabled) activate()`.

**Status:** KeepAwake is currently a config flag in daemon.ts (`this.keepAwake = options?.keepAwake ?? false`), not a class instantiation. This issue may be dormant depending on current implementation.

---

### M10. OpenCode revert does not immediately remove messages

**Bug:** The original audit's Finding #2 assumed `message.removed` fires during revert. In reality, revert sets a marker on the session; messages are removed later during cleanup/compaction. The frontend needs to handle revert differently: listen for `session.updated` with a `revert` field, and hide messages past the revert point using `session.revert.messageID`.

**Status:** Blocked by C4 (messageID not passed through). Can be addressed when rewind/revert is properly implemented.

---

## Cross-Reference: Original Audit Findings

| Original # | Status | This Doc |
|-------------|--------|----------|
| #1 (plan mode) | Nature changed — approval is via Question flow | C3 |
| #2 (revert) | Blocked by C4 | M10 |
| #3 (file history) | Still broken | C2, H4 |
| #4 (input sync) | Still broken | H3 |
| #5 (part_removed) | Frontend handler missing | M4 |
| #6 (todo) | Still broken, dead code remains | H5 |
| #7 (input sync) | Merged into H3 | H3 |
| #8 (version check) | Worse — now 6 files | H6 |
| #9 (keepawake) | Dormant | M9 |
| #10 (dead types) | Reassessed — not dead | M6 |
| #11 (messageID) | Still missing | C4 |
| #12 (daemon config) | Unchanged | — |
| #13 (version broadcast) | Still mismatched | M7 |
| #14 (input sync from) | Merged into H3 | H3 |
| #15 (rebuildState) | New dimension: cache vs translator | C5 |
| #16 (SessionInfo.processing) | Not dead — still used | M6 |
| #17 (pnpm check) | Still true | M5 |
| #18 (FileVersion) | Deferred | — |
| #19 (PlanApproval) | Superseded by C3 | C3 |
| #20 (terminal_command) | Working; `terminal_command list` is functional | — |
| Session switching | **NEW** — root cause identified | C1 |
| SSE error handling | **NEW** | H1 |
| Permission timeouts | **NEW** | H2 |
| Cache unbounded | **NEW** | H7 |
| Multi-client session | **NEW** | H8 |

---

## Suggested Fix Order

**Phase 1: Session switching (highest user impact)**
1. C1 — Fix event recording to use event's sessionID, not active session
2. C5 — Rebuild translator state after switch
3. H8 — Consider per-client session model (or document as known limitation)

**Phase 2: Broken features**
4. C2 — `props.path` → `props.file` (one-line fix)
5. C3 — Add `rewind` to router + handler; clean up plan mode dead sends
6. H4 — Route `file_changed` to correct listeners
7. H3 — Fix `input_sync` echo + missing `from`

**Phase 3: Data pipeline**
8. C4 — Pass `messageID` through translator
9. H5 — Wire `todo.updated` SSE events, remove dead code
10. H6 — Centralize version string

**Phase 4: Robustness**
11. H1 — Fix SSE error swallowing
12. H2 — Add periodic timeout checks
13. H7 — Add cache eviction

**Phase 5: Polish**
14. M2-M10 — Medium issues as time allows
