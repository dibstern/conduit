# Error Details & Debug Verbosity Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Surface rich error details in the chat UI and make the debug panel + console logs useful for debugging by showing full message payloads and enabling runtime server log level control.

**Architecture:** Three independent workstreams: (1) widen the error wire protocol and render rich errors in SystemMessage, (2) store and display full WS message payloads in the debug panel and console, (3) repurpose the verbose toggle to control server-side log level via a new WS message type. All three are additive and backward-compatible.

**Tech Stack:** TypeScript, Svelte 5, pino logger, ws library.

---

### Task 1: Widen RelayError.toMessage() to include details and statusCode

**Files:**
- Modify: `src/lib/shared-types.ts:404` (RelayMessage error variant)
- Modify: `src/lib/errors.ts:104-111` (toMessage method)
- Modify: `src/lib/errors.ts:95-101` (toWebSocket method)
- Test: `test/unit/frontend/ws-debug.test.ts` (existing), any error-related tests

**Step 1: Update the RelayMessage error type in shared-types.ts**

In `src/lib/shared-types.ts`, change line 404:

```ts
// Before:
| { type: "error"; code: string; message: string }

// After:
| { type: "error"; code: string; message: string; statusCode?: number; details?: Record<string, unknown> }
```

**Step 2: Update toMessage() and toWebSocket() in errors.ts**

In `src/lib/errors.ts`, update `toWebSocket()` (lines 96-101):

```ts
toWebSocket(): { type: "error"; code: string; message: string; statusCode?: number; details?: Record<string, unknown> } {
    const details = Object.keys(this.context).length > 0 ? this.context : undefined;
    return {
        type: "error",
        code: this.code,
        message: this.message,
        ...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
        ...(details ? { details } : {}),
    };
}
```

Update `toMessage()` (lines 105-111) to call `toWebSocket()` instead of duplicating:

```ts
toMessage(): Extract<RelayMessage, { type: "error" }> {
    return this.toWebSocket();
}
```

**Step 3: Run check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS — changes are additive, existing code that constructs `{ type: "error", code, message }` literals still satisfies the type.

**Step 4: Commit**

```bash
git add src/lib/shared-types.ts src/lib/errors.ts
git commit -m "feat: include details and statusCode in RelayError.toMessage()"
```

---

### Task 2: Enrich SystemMessage type and addSystemMessage()

**Files:**
- Modify: `src/lib/frontend/types.ts:130-135` (SystemMessage interface)
- Modify: `src/lib/frontend/stores/chat.svelte.ts:514-528` (handleError)
- Modify: `src/lib/frontend/stores/chat.svelte.ts:609-616` (addSystemMessage)

**Step 1: Add error fields to SystemMessage type**

In `src/lib/frontend/types.ts`, extend the SystemMessage interface:

```ts
export interface SystemMessage {
    type: "system";
    uuid: string;
    text: string;
    variant?: SystemMessageVariant;
    /** Error code (e.g. "SEND_FAILED") — only present for error variant. */
    errorCode?: string;
    /** HTTP status code from the server error. */
    statusCode?: number;
    /** Contextual details from the server error. */
    details?: Record<string, unknown>;
}
```

**Step 2: Update addSystemMessage to accept optional error metadata**

In `src/lib/frontend/stores/chat.svelte.ts`, change addSystemMessage:

```ts
export function addSystemMessage(
    text: string,
    variant: SystemMessageVariant = "info",
    errorMeta?: { code?: string; statusCode?: number; details?: Record<string, unknown> },
): void {
    const uuid = generateUuid();
    const msg: SystemMessage = {
        type: "system",
        uuid,
        text,
        variant,
        ...(errorMeta?.code ? { errorCode: errorMeta.code } : {}),
        ...(errorMeta?.statusCode ? { statusCode: errorMeta.statusCode } : {}),
        ...(errorMeta?.details ? { details: errorMeta.details } : {}),
    };
    setMessages([...getMessages(), msg]);
}
```

**Step 3: Update handleError to pass full error data**

In `src/lib/frontend/stores/chat.svelte.ts`, change handleError:

```ts
export function handleError(
    msg: Extract<RelayMessage, { type: "error" }>,
): void {
    const { code, message, statusCode, details } = msg;
    const errorMeta = { code, statusCode, details };

    if (code === "RETRY") {
        addSystemMessage(message, "info");
    } else {
        addSystemMessage(message, "error", errorMeta);
        chatState.processing = false;
        chatState.streaming = false;
    }
}
```

**Step 4: Run check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/types.ts src/lib/frontend/stores/chat.svelte.ts
git commit -m "feat: pass error code, statusCode, details through to SystemMessage"
```

---

### Task 3: Render error code and expandable details in SystemMessage.svelte

**Files:**
- Modify: `src/lib/frontend/components/chat/SystemMessage.svelte`

**Step 1: Add expandable details UI**

Replace the entire SystemMessage.svelte with:

```svelte
<!-- ─── System Message ──────────────────────────────────────────────────────── -->
<!-- Displays system info/error messages with left-border accent. -->

<script lang="ts">
    import type { SystemMessage } from "../../types.js";
    import Icon from "../shared/Icon.svelte";

    let { message }: { message: SystemMessage } = $props();

    const isError = $derived(message.variant === "error");
    const hasDetails = $derived(
        !!(message.errorCode || message.statusCode || (message.details && Object.keys(message.details).length > 0)),
    );

    let showDetails = $state(false);

    const containerClasses = $derived(
        isError
            ? "glow-tool-error text-error bg-bg-surface"
            : "bg-bg-surface text-text-muted",
    );
</script>

<div class="max-w-[760px] mx-auto my-2 px-5">
    <div
        class="flex flex-col gap-1 py-2 px-3 text-base rounded-[10px] {containerClasses}"
    >
        <div class="flex items-start gap-2">
            <span class="shrink-0 mt-0.5 [&_.lucide]:w-3 [&_.lucide]:h-3">
                {#if isError}
                    <Icon name="circle-alert" size={12} />
                {:else}
                    <Icon name="info" size={12} />
                {/if}
            </span>
            <div class="flex-1 min-w-0">
                <span>
                    {#if message.errorCode}
                        <span class="font-mono text-xs opacity-70 mr-1.5">{message.errorCode}</span>
                    {/if}
                    {message.text}
                </span>
                {#if hasDetails}
                    <button
                        class="ml-2 text-xs opacity-60 hover:opacity-100 cursor-pointer underline"
                        onclick={() => showDetails = !showDetails}
                    >
                        {showDetails ? "Hide details" : "Show details"}
                    </button>
                {/if}
            </div>
        </div>

        {#if showDetails && hasDetails}
            <div class="ml-5 mt-1 p-2 rounded bg-black/20 text-xs font-mono space-y-0.5 overflow-x-auto">
                {#if message.statusCode}
                    <div><span class="opacity-60">status:</span> {message.statusCode}</div>
                {/if}
                {#if message.details}
                    {#each Object.entries(message.details) as [key, value]}
                        <div class="break-all">
                            <span class="opacity-60">{key}:</span>
                            {typeof value === "string" ? value : JSON.stringify(value)}
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}
    </div>
</div>
```

**Step 2: Run check**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/frontend/components/chat/SystemMessage.svelte
git commit -m "feat: render error code badge and expandable details in SystemMessage"
```

---

### Task 4: Add payload to debug store and console logs

**Files:**
- Modify: `src/lib/frontend/stores/ws-debug.svelte.ts`
- Modify: `src/lib/frontend/stores/ws.svelte.ts:287` (call site)
- Test: `test/unit/frontend/ws-debug.test.ts`

**Step 1: Add payload field to WsDebugEvent and increase ring buffer**

In `src/lib/frontend/stores/ws-debug.svelte.ts`:

Update interface (lines 10-17):
```ts
export interface WsDebugEvent {
    time: number;
    event: string;
    detail?: string | undefined;
    state: string;
    verbose?: boolean | undefined;
    /** Full parsed message payload (for ws:message events). Always stored. */
    payload?: unknown;
}
```

Change MAX_EVENTS constant (line 27):
```ts
const MAX_EVENTS = 300;
```

**Step 2: Update wsDebugLogMessage to accept and store payload**

Update the function signature and body (lines 112-137):

```ts
export function wsDebugLogMessage(state: string, msgType?: string, payload?: unknown): void {
    _messageCount++;
    const isSampled = _messageCount === 1 || _messageCount % 100 === 0;
    const detail = msgType ? `#${_messageCount} ${msgType}` : `#${_messageCount}`;

    const entry: WsDebugEvent = {
        time: Date.now(),
        event: "ws:message",
        detail,
        state,
        ...(isSampled ? {} : { verbose: true }),
        ...(payload !== undefined ? { payload } : {}),
    };

    _events.push(entry);
    if (_events.length > MAX_EVENTS) {
        _events = _events.slice(-MAX_EVENTS);
    }

    wsDebugState.eventCount++;

    // Console output when debug is enabled (respect verbose setting for console)
    if (featureFlags.debug && (wsDebugState.verboseMessages || isSampled)) {
        const prefix = "[ws] ws:message";
        if (payload !== undefined) {
            console.debug(prefix, detail, payload);
        } else {
            console.debug(prefix, detail);
        }
    }
}
```

**Step 3: Pass parsed message at call site**

In `src/lib/frontend/stores/ws.svelte.ts`, line 287:

```ts
// Before:
wsDebugLogMessage(wsState.status, msg.type);

// After:
wsDebugLogMessage(wsState.status, msg.type, msg);
```

**Step 4: Update tests**

In `test/unit/frontend/ws-debug.test.ts`, add a test that payload is stored:

```ts
it("stores payload when provided", () => {
    wsDebugLogMessage("connected", "error", { type: "error", code: "SEND_FAILED", message: "fail" });
    const events = getDebugSnapshot().events;
    const last = events[events.length - 1]!;
    expect(last.payload).toEqual({ type: "error", code: "SEND_FAILED", message: "fail" });
});
```

And update the MAX_EVENTS test to use 300 instead of 200.

**Step 5: Run tests**

Run: `pnpm check && pnpm test:unit -- --testPathPattern ws-debug`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/frontend/stores/ws-debug.svelte.ts src/lib/frontend/stores/ws.svelte.ts test/unit/frontend/ws-debug.test.ts
git commit -m "feat: store full message payload in debug events and log to console"
```

---

### Task 5: Add expandable payload display to DebugPanel

**Files:**
- Modify: `src/lib/frontend/components/debug/DebugPanel.svelte`

**Step 1: Add per-entry expand/collapse for payload**

In the event log section of DebugPanel.svelte (lines 330-338), update the event rendering to include an expand toggle and payload display.

Replace lines 330-338:

```svelte
{#each events as evt}
    <div>
        <div class="flex gap-1.5 py-px items-start">
            <span class="text-gray-600 shrink-0 w-[84px] text-right">{fmtTime(evt.time)}</span>
            <span class="{eventColor(evt.event)} shrink-0">{evt.event}</span>
            {#if evt.detail}
                <span class="text-gray-500 truncate">{evt.detail}</span>
            {/if}
            {#if evt.payload}
                <button
                    class="text-gray-600 hover:text-gray-300 text-[10px] ml-auto shrink-0 cursor-pointer"
                    onclick={() => { evt._expanded = !evt._expanded; }}
                >
                    {evt._expanded ? '[-]' : '[+]'}
                </button>
            {/if}
        </div>
        {#if evt._expanded && evt.payload}
            <pre class="text-[10px] text-green-300/70 ml-[90px] whitespace-pre-wrap break-all max-h-40 overflow-y-auto mb-1">{JSON.stringify(evt.payload, null, 2)}</pre>
        {/if}
    </div>
{/each}
```

Note: `_expanded` is a transient UI property added directly to the event object. Since events are proxied via `$state`, Svelte 5 reactivity tracks the mutation of `evt._expanded` automatically — no need for any manual reactivity trigger.

Add `_expanded` to the WsDebugEvent interface as optional:

```ts
/** Transient UI flag (not persisted). */
_expanded?: boolean;
```

**Step 2: Run check**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/frontend/components/debug/DebugPanel.svelte src/lib/frontend/stores/ws-debug.svelte.ts
git commit -m "feat: add expandable payload display to debug panel entries"
```

---

### Task 6: Add set_log_level WS message type and server handler

**Files:**
- Modify: `src/lib/server/ws-router.ts` (add message type)
- Modify: `src/lib/relay/relay-stack.ts` (handle in dispatch)
- Modify: `src/lib/logger.ts` (add getLogLevel)

**Step 1: Add set_log_level to ws-router**

In `src/lib/server/ws-router.ts`:

Add `"set_log_level"` to the `IncomingMessageType` union (after `"scan_now"`):

```ts
| "set_log_level";
```

Add `"set_log_level"` to the `VALID_MESSAGE_TYPES` set (after `"scan_now"`):

```ts
"set_log_level",
```

**Step 2: Add getLogLevel to logger.ts**

In `src/lib/logger.ts`, after `setLogLevel()` (around line 160):

```ts
/** Get the current log level. */
export function getLogLevel(): LogLevel {
    return currentLevel;
}
```

**Step 3: Handle set_log_level in relay-stack.ts**

In `src/lib/relay/relay-stack.ts`, in the `wsHandler.on("message", ...)` callback (around line 499), add a special case before the clientQueue.enqueue call:

```ts
// Handle log level changes directly (no queue needed, synchronous)
if (handler === "set_log_level") {
    const level = payload.level;
    const validLevels = new Set(["debug", "verbose", "info", "warn", "error"]);
    if (typeof level === "string" && validLevels.has(level)) {
        setLogLevel(level as LogLevel);
        wsLog.info(`Log level changed to ${level} by client ${clientId}`);
    }
    return;
}
```

Add the import for `setLogLevel` and `LogLevel` from `../logger.js` at the top of the file.

**Step 4: Run check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/server/ws-router.ts src/lib/relay/relay-stack.ts src/lib/logger.ts
git commit -m "feat: add set_log_level WS message type for runtime log level control"
```

---

### Task 7: Repurpose verbose toggle to control server log level

**Files:**
- Modify: `src/lib/frontend/components/debug/DebugPanel.svelte` (update toggle)

Note: No new registration pattern is needed. The existing `rawSend()` from `ws-send.svelte.ts` already has a WebSocket readyState guard and survives reconnects — use it directly.

**Step 1: Update toggleVerbose in DebugPanel**

In `src/lib/frontend/components/debug/DebugPanel.svelte`, add import for rawSend and update toggleVerbose:

```ts
import { rawSend } from "../../stores/ws-send.svelte.js";

function toggleVerbose() {
    const newValue = !wsDebugState.verboseMessages;
    wsDebugState.verboseMessages = newValue;
    rawSend({ type: "set_log_level", level: newValue ? "verbose" : "info" });
}
```

**Step 2: Update toggle label and tooltip in DebugPanel**

Change the button (around line 273-279) to:

```svelte
<button
    class="cursor-pointer text-xs px-2 py-1.5 {wsDebugState.verboseMessages ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300'}"
    onclick={toggleVerbose}
    title={wsDebugState.verboseMessages ? "Verbose: showing all messages + server verbose logging" : "Normal: sampled messages + server info logging"}
>
    {wsDebugState.verboseMessages ? "verbose:on" : "verbose:off"}
</button>
```

**Step 3: Run check**

Run: `pnpm check`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/frontend/components/debug/DebugPanel.svelte
git commit -m "feat: repurpose verbose toggle to control server log level at runtime"
```

---

### Task 8: Verification

**Step 1: Full verification suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 2: Manual smoke test**

1. Open browser to localhost:2633
2. Trigger an error (e.g. send a message when OpenCode is down)
3. Verify the error shows error code badge and expandable details
4. Open debug panel (Ctrl+Shift+D)
5. Verify each WS message entry has a [+] expand button showing full JSON
6. Verify console.debug output includes full payload objects
7. Toggle verbose — verify server logs switch to verbose level
8. Toggle verbose off — verify server logs revert
