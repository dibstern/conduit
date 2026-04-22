# Claude Session Persistence — Gaps Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix the 7 gaps the original persistence plan missed, so Claude SDK sessions behave identically to OpenCode sessions: history survives session switching with tool calls intact, permissions replay on return, and processing status is accurate.

**Context:** The original plan (`2026-04-17-claude-session-persistence.md`) wired `RelayEventSink → EventStore → ProjectionRunner → SQLite` for the `push()` path. Its audit caught 2 critical issues (recover() and try/catch scope). But neither the plan nor the audit examined the full session lifecycle — they assumed "once rows exist in SQLite, the existing history resolution path works." That assumption was wrong in 7 ways.

**Tech Stack:** TypeScript (ESM), Vitest, SQLite (better-sqlite3), Biome

---

## Gap 1: `currentAssistantMessageId` empty during streaming → fragmented messages

**Root cause:** `claude-event-translator.ts` line 452: `this.currentAssistantMessageId || tool?.itemId || randomUUID()`. The `currentAssistantMessageId` is only set in `translateAssistantSnapshot()` which fires AFTER streaming completes. During streaming, every content block (text, tool_use, thinking) gets a different per-block UUID as messageId. Result: dozens of single-part "messages" in SQLite instead of one cohesive assistant message.

**Fix:** Capture the assistant message ID from the `message_start` stream event at the START of streaming. In `translateStreamEvent()`, add handling for `eventType === "message_start"` before the `content_block_start` handler. Extract `event.message.id` and set `this.currentAssistantMessageId`.

**Files:**
- `src/lib/provider/claude/claude-event-translator.ts` — Add `message_start` handler in `translateStreamEvent()`
- `test/unit/provider/claude/claude-event-translator.test.ts` — Test that all content blocks share the message ID from `message_start`

**What the audit should have caught:** Implicit Assumptions — the plan assumed the translator's messageId was correct without checking.

---

## Gap 2: Defensive INSERT missing for `tool.started` and `thinking.start` → FK violations

**Root cause:** The Claude adapter never emits `message.created`. The original fix added a defensive `INSERT OR IGNORE INTO messages` to the `text.delta` handler, but not to `tool.started` or `thinking.start`. When the model's first content block is a tool call (no preamble text), the `INSERT INTO message_parts` violates the FK constraint (`message_id REFERENCES messages(id)`) and the bare `catch {}` silently swallows it.

**Fix:** Add the same defensive `INSERT OR IGNORE INTO messages` to the `tool.started` and `thinking.start` handlers in `MessageProjector`, before the `INSERT INTO message_parts`.

**Files:**
- `src/lib/persistence/projectors/message-projector.ts` — Add defensive INSERT to `tool.started` and `thinking.start`
- `test/unit/persistence/projectors/message-projector.test.ts` — Test tool.started and thinking.start before message.created

**What the audit should have caught:** Missing Wiring — the plan added defensive INSERT for text.delta but not the other event types that also insert into message_parts.

---

## Gap 3: User messages not persisted for Claude sessions

**Root cause:** The Claude adapter only emits assistant-side events. User messages are sent via `handleMessage` → orchestration engine dispatch, but never recorded to the event store. When loading history from SQLite, user turns are missing.

**Fix:** In `handleMessage` (prompt.ts), before dispatching to the orchestration engine, persist user messages by appending `message.created` + `text.delta` events to the event store for Claude provider sessions.

**Files:**
- `src/lib/handlers/prompt.ts` — Add user message persistence block before Claude dispatch
- Test coverage via the integration test

**What the audit should have caught:** Implicit Assumptions — assumed the Claude adapter would emit user-side events like the OpenCode SSE path does.

---

## Gap 4: `readQuery` not wired through session switch paths

**Root cause:** `toSessionSwitchDeps()` in `handlers/session.ts` and the `switchClientToSession` call in `client-init.ts` did not include `readQuery`. Even though `handler-deps-wiring.ts` correctly propagated `readQuery` to `handlerDeps`, the two call sites that build `SessionSwitchDeps` omitted it. Result: `resolveSessionHistory()` always took the REST fallback path instead of reading from SQLite.

**Fix:**
- `handlers/session.ts` `toSessionSwitchDeps()`: Add `...(deps.readQuery != null && { readQuery: deps.readQuery })`
- `client-init.ts` `switchClientToSession` call: Add `...(deps.readQuery != null && { readQuery: deps.readQuery })`

**Files:**
- `src/lib/handlers/session.ts`
- `src/lib/bridges/client-init.ts`
- `test/unit/regression-claude-history-wiring.test.ts` — Regression tests verifying SQLite is used

**What the audit should have caught:** Missing Wiring — the audit verified the relay-stack → handler-deps chain but not the handler-deps → session-switch chain.

---

## Gap 5: Permission bridge not integrated with RelayEventSink

**Root cause:** `RelayEventSink.requestPermission()` sends `permission_request` to WebSocket and stores a deferred in its local `pendingPermissions` map, but never registers with the `PermissionBridge`. When the user switches sessions, `handleViewSession` calls `permissionBridge.getPending()` which returns nothing for Claude permissions. The OpenCode SSE path works because `sse-wiring.ts` registers permissions with the bridge.

**Fix:**
- Add `trackPending()` method to `PermissionBridge`
- Add optional `permissionBridge` dep to `RelayEventSinkDeps`
- In `requestPermission()`, call `permissionBridge.trackPending()` before sending to WebSocket
- Wire `permissionBridge` through prompt.ts → createRelayEventSink()

**Files:**
- `src/lib/bridges/permission-bridge.ts` — Add `trackPending()` method
- `src/lib/provider/relay-event-sink.ts` — Add `permissionBridge` to deps, call `trackPending()` in `requestPermission()`
- `src/lib/handlers/prompt.ts` — Pass `deps.permissionBridge` to `createRelayEventSink()`

**What the audit should have caught:** Missing Wiring — the audit checked the persistence path but not the permission replay path.

---

## Gap 6: Processing status always "idle" for Claude sessions on switch

**Root cause:** `switchClientToSession()` sends `{ type: "status", status: statusPoller.isProcessing(sessionId) ? "processing" : "idle" }`. The `statusPoller` only monitors OpenCode sessions via REST polling. It has no visibility into Claude SDK turns. When a Claude turn is in progress and the user switches away and back, the session always shows "idle."

**Fix:**
- Add `hasActiveProcessingTimeout()` method to `SessionOverrides` (the processing timeout timer is already tracked per-session)
- Add optional `overrides` to `SessionSwitchDeps`
- In `switchClientToSession`, check both `statusPoller.isProcessing()` and `overrides.hasActiveProcessingTimeout()`
- Wire through `toSessionSwitchDeps()` and `client-init.ts`

**Files:**
- `src/lib/session/session-overrides.ts` — Add `hasActiveProcessingTimeout()`
- `src/lib/session/session-switch.ts` — Add `overrides` to deps, check in status send
- `src/lib/handlers/session.ts` — Wire `overrides` in `toSessionSwitchDeps()`
- `src/lib/bridges/client-init.ts` — Wire `overrides` in `switchClientToSession` call

**What the audit should have caught:** State Issues — the status on session switch is stale for Claude sessions because the poller doesn't track them.

---

## Gap 7: Silent error swallowing hides all persistence failures

**Root cause:** The bare `catch {}` in `RelayEventSink.push()` swallows every persistence error with zero logging. FK violations, disk full, DB locked, projection guard failures — all invisible. This made gaps 2-4 extremely hard to diagnose.

**Fix:** Add `log.debug()` in the catch block so persistence failures are visible when debug logging is enabled.

**Files:**
- `src/lib/provider/relay-event-sink.ts` — Change `catch {}` to `catch (err) { log.debug(...) }`

**What the audit should have caught:** Fragile Code — bare catch with no logging.

---

## Summary of what the audit process missed

| Gap | Audit Category | Why missed |
|-----|---------------|------------|
| 1. messageId fragmentation | Implicit Assumptions | Auditors checked plan code but not the translator's messageId logic |
| 2. FK violations for tool/thinking | Missing Wiring | Only checked text.delta path, not other message_parts inserters |
| 3. User messages not persisted | Implicit Assumptions | Assumed Claude adapter emits user events like OpenCode SSE does |
| 4. readQuery not wired | Missing Wiring | Verified relay-stack→handlerDeps but not handlerDeps→sessionSwitch |
| 5. Permissions not bridged | Missing Wiring | Persistence-focused scope excluded permission lifecycle |
| 6. Status stale on switch | State Issues | Assumed statusPoller covers all providers |
| 7. Silent error swallowing | Fragile Code | Accepted the catch pattern without checking observability |

The common thread: **the audit was scoped to the plan's scope.** The plan said "persist events to SQLite" and the audit verified that chain. Neither examined the downstream consumers of that data (history resolution, permission replay, status reporting) or the upstream producers (translator messageId logic, user message emission).
