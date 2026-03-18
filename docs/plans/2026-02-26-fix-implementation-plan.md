# Fix Implementation Plan

Implements all fixes from `2026-02-26-consolidated-issues.md`.

## Phase 1: Session Switching (C1 + C5)

### Design: Remove session filter, record by event's sessionID

The root cause is that the SSE consumer filters out events from non-active sessions. Instead: accept ALL events from OpenCode, record them by the event's own `sessionID`, and only broadcast events for the active session.

**`src/lib/sse-consumer.ts`:**
- Remove the `sessionFilter` field entirely. Remove `setSessionFilter()`. Remove the filter check in `processSSEMessage()` (lines 237-243). Instead, include the parsed `sessionID` on every emitted event so callers can route correctly.

**`src/lib/relay-stack.ts` — SSE event handler (lines 1335-1423):**
- Extract `sessionID` from the raw event at the top: `const eventSessionId = (event.properties as { sessionID?: string }).sessionID`
- Record to the correct session: `if (eventSessionId) messageCache.recordEvent(eventSessionId, msg)` (instead of `getActiveSessionId()`)
- Only broadcast events for the active session: `if (!eventSessionId || eventSessionId === sessionMgr.getActiveSessionId()) { wsHandler.broadcast(msg); }`
- Events for background sessions are silently recorded to cache but not broadcast.

**`src/lib/relay-stack.ts` — session_changed handler (lines 604-607):**
- Keep `translator.reset()`. Remove `sseConsumer.setSessionFilter(sid)`.
- After reset, rebuild translator state: fetch messages from REST API and call `translator.rebuildStateFromHistory()`.
- This solves C5 (translator state not rebuilt).

**`src/lib/relay-stack.ts` — switch_session handler (lines 729-791):**
- After `sessionMgr.switchSession(id)`, the translator is reset (via session_changed handler).
- Then `rebuildStateFromHistory()` runs (from session_changed handler).
- Then the switch_session handler sends `session_switched` with cache or history as before.

**`src/lib/session-manager.ts`:**
- `switchSession()` is now synchronous-enough (just sets ID + emits). No changes needed.

### Tests
- Unit test: SSE consumer no longer has `setSessionFilter`. Events for any session are emitted.
- Integration test: send message in session A → switch to B mid-stream → switch back → verify A's cache has full data.

---

## Phase 2: Broken Features (C2 + C3 + H3 + H4)

### C2: `props.path` → `props.file`

**`src/lib/event-translator.ts` line 427:**
```
- const props = event.properties as { path?: string };
- if (!props.path) return null;
+ const props = event.properties as { file?: string };
+ if (!props.file) return null;
```
And update `props.path` → `props.file` on lines 431, 435.

### C3: Add `rewind` to router; remove dead plan sends

**`src/lib/ws-router.ts`:**
- Add `"rewind"` to `IncomingMessageType` union and `VALID_MESSAGE_TYPES` set.
- Do NOT add `plan_approve`/`plan_reject` — plan approval goes through the existing Question flow.

**`src/lib/relay-stack.ts` — add rewind handler:**
```typescript
case "rewind": {
    const messageId = String(payload.messageId ?? payload.uuid ?? "");
    const activeId = sessionMgr.getActiveSessionId();
    if (messageId && activeId) {
        await client.revertSession(activeId, messageId);
        // Invalidate cache — revert changes message history
        messageCache.remove(activeId);
        log(`   [session] Reverted to message: ${messageId}`);
    }
    break;
}
```

**`src/lib/public/components/features/PlanMode.svelte` — fix double-send:**
- Remove the direct `wsSend()` calls. Only call the callback:
```typescript
function handleApprove() { onApprove?.(); }
function handleReject() { onReject?.(); }
```
The callbacks from ChatLayout already send the message. But since `plan_approve` is not a valid server message type anyway, the sends are currently no-ops. Leave ChatLayout's callbacks as-is for now (they'll be dead code until plan mode is properly wired through the Question flow).

### H3: Fix `input_sync`

**`src/lib/relay-stack.ts` line 1282-1288:**
```typescript
case "input_sync": {
    wsHandler.broadcastExcept(
        { type: "input_sync", text: String(payload.text ?? ""), from: clientId },
        clientId,
    );
    break;
}
```

### H4: Route `file_changed` to correct listeners

**`src/lib/public/stores/ws.svelte.ts` line 423-427:**
Split `file_changed` to go to BOTH listener sets (browser needs refresh, history UI needs notification):
```typescript
case "file_changed":
    for (const fn of _fileBrowserListeners) fn(msg);
    for (const fn of _fileHistoryListeners) fn(msg);
    break;
case "file_history_result":
    for (const fn of _fileHistoryListeners) fn(msg);
    break;
```

**`src/lib/public/components/features/FileBrowser.svelte`:**
Add `file_changed` handling in the subscription — trigger a re-fetch of the current directory:
```typescript
if (msg.type === "file_changed") {
    // Refresh the current directory listing
    if (currentPath) {
        wsSend({ type: "get_file_list", path: currentPath });
    }
}
```

---

## Phase 3: Data Pipeline (C4 + H5 + H6)

### C4: Pass `messageID` through translator

**`src/lib/types.ts` — add `messageId` to relevant RelayMessage variants:**
Add `messageId?: string` to: `delta`, `thinking_start`, `thinking_delta`, `thinking_stop`, `tool_start`, `tool_executing`, `tool_result`, `done`, `result`.

**`src/lib/event-translator.ts`:**
- `translatePartDelta()`: include `messageID` from props in the return.
- `handlePartUpdated()` / `translateToolPartUpdated()`: include `messageID`.
- `translateSessionStatus()`: include `messageID` if present.
- Use a shared helper to extract messageID: `const messageId = (props as { messageID?: string }).messageID;`

**`src/lib/public/stores/chat.svelte.ts`:**
- Add `messageId?: string` to `AssistantMessage`, `ToolMessage` types.
- In `handleDelta()`, read `msg.messageId` and store it on the assistant message.
- In `handleToolStart()`, read `msg.messageId` and store it on the tool message.

### H5: Wire `todo.updated`, remove dead code

**`src/lib/event-translator.ts`:**
- Remove `extractTodoFromToolResult()` and `normalizeTodoItem()` (dead code).
- Add `todo.updated` handler in `translate()`:
```typescript
if (eventType === "todo.updated") {
    const props = event.properties as { todos?: Array<{ content: string; status: string; priority?: string }> };
    const items: TodoItem[] = (props.todos ?? []).map((t, i) => ({
        id: `todo-${i}`,
        subject: t.content,
        status: (t.status as TodoStatus) ?? "pending",
    }));
    return { type: "todo_state", items };
}
```

**`src/lib/relay-stack.ts` — fix `get_todo` handler (line 1291):**
```typescript
case "get_todo": {
    // TODO: OpenCode has GET /session/:id/todo but no client method yet.
    // For now, return empty. Wire up when client.getTodos() is added.
    wsHandler.sendTo(clientId, { type: "todo_state", items: [] });
    break;
}
```

### H6: Centralize version

**New file `src/lib/version.ts`:**
```typescript
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function getVersion(): string {
    if (cached) return cached;
    try {
        const dir = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(join(dir, "../../package.json"), "utf8"));
        cached = pkg.version ?? "0.0.0";
    } catch {
        cached = "0.0.0";
    }
    return cached;
}
```

**Update consumers:**
- `src/lib/version-check.ts`: Replace `CURRENT_VERSION` with `getVersion()`.
- `src/lib/daemon.ts`: Replace `"0.1.0"` literals with `getVersion()`.
- `src/lib/server.ts`: Replace `"0.1.0"` literals with `getVersion()`.

---

## Phase 4: Robustness (H1 + H2 + H7)

### H1: SSE error swallowing

**`src/lib/sse-consumer.ts` line 74:**
```typescript
- this.startStream().catch(() => {});
+ this.startStream().catch((err) => {
+     if (!this.running) return;
+     const error = err instanceof Error ? err : new Error(String(err));
+     this.emit("error", error);
+     this.scheduleReconnect();
+ });
```

### H2: Permission/question timeout checks

**`src/lib/relay-stack.ts` — add timeout timer after component creation:**
```typescript
const timeoutTimer = setInterval(() => {
    const timedOutPerms = permissionBridge.checkTimeouts();
    for (const id of timedOutPerms) {
        wsHandler.broadcast({ type: "permission_resolved", requestId: id, decision: "timeout" });
    }
    const timedOutQuestions = questionBridge.checkTimeouts();
    for (const id of timedOutQuestions) {
        questionBridge.remove(id);
        wsHandler.broadcast({ type: "ask_user_resolved", toolId: id });
    }
}, 30_000);
```
Clear it in the `stop()` function.

### H7: MessageCache eviction

**`src/lib/message-cache.ts`:**
- Add `MAX_EVENTS = 5000` constant.
- In `recordEvent()`, after push: if `session.events.length > MAX_EVENTS`, trim the oldest 20% (keep newest 4000). Rewrite the JSONL file when trimming.
- Add `sessionCount()` getter for monitoring.

---

## Phase 5: Medium Issues (M2 + M3 + M4)

### M2: Import plan-mode.css
Add `@import './plan-mode.css';` to `src/lib/public/style.css`.

### M3: Handle `installation.update-available`
Add to translator's `translate()`:
```typescript
if (eventType === "installation.update-available") {
    const props = event.properties as { version?: string };
    return { type: "update_available" as any, version: props.version };
}
```
Add `| { type: "update_available"; version?: string }` to `RelayMessage`.

### M4: Frontend handlers for `part_removed` / `message_removed`
Add to `ws.svelte.ts` message dispatcher:
```typescript
case "part_removed":
    handlePartRemoved(msg);
    break;
case "message_removed":
    handleMessageRemoved(msg);
    break;
```

In `chat.svelte.ts`:
```typescript
export function handlePartRemoved(msg: WsMessage): void {
    const partId = msg.partId as string;
    if (!partId) return;
    chatState.messages = chatState.messages.filter(
        (m) => m.type !== "tool" || (m as ToolMessage).toolId !== partId
    );
}

export function handleMessageRemoved(msg: WsMessage): void {
    const messageId = msg.messageId as string;
    if (!messageId) return;
    chatState.messages = chatState.messages.filter(
        (m) => !("messageId" in m) || m.messageId !== messageId
    );
}
```
