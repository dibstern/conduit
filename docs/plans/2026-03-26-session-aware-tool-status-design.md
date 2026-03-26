# Session-Aware Tool Status Resolution

## Problem

Subagent (Task) tool cards show "Done" in the UI while the subagent session is still running. This happens when loading a session from history (navigate away+back, new client, page refresh) because two independent code paths produce incorrect tool statuses:

1. **REST history path**: `mapToolStatus()` uses a manual allowlist (`LIVE_STATUS_TOOLS`) that only preserves live status for question tools. Task tools get forced to "completed".
2. **Cache replay path**: `patchMissingDone` injects a synthetic `done` event because `computeAugmentedStatuses` fails to propagate busy from a subagent to its idle parent, causing `isProcessing()` to return false.

The structural weaknesses:
- **Manual allowlist** that must be updated for every new long-running tool type.
- **Multiple divergent paths** (REST, cache replay, live SSE) independently compute tool status with different logic.
- **Implicit intent** in status augmentation (`!augmented[parentId]` mixed "fill missing" with "don't override").
- **Optional dependency** (`statusPoller?`) silently defaults to "not processing" when absent.

## Design

### 1. Wire protocol: `isProcessing` on `session_switched`

Add `isProcessing: boolean` to the `session_switched` message. The server already computes this; it just isn't included in the payload.

```typescript
// shared-types.ts
{
    type: "session_switched";
    id: string;
    isProcessing?: boolean;  // true when session has active work
    // ... existing fields unchanged
}
```

Make `statusPoller` **required** (not optional) in `SessionSwitchDeps`. Tests must provide a stub. No `?.` chaining, no silent fallback to a wrong default.

```typescript
// session-switch.ts
readonly statusPoller: { isProcessing(sessionId: string): boolean };
```

### 2. `mapToolStatus`: session-aware, no allowlist

Replace the `LIVE_STATUS_TOOLS` allowlist with a session-aware decision. Rename to `QUESTION_TOOLS` for its narrow remaining purpose (tools that need user interaction regardless of session state).

```typescript
const QUESTION_TOOLS = new Set(["question", "AskUserQuestion"]);

function mapToolStatus(
    apiStatus: string | undefined,
    toolName: string,
    sessionIsProcessing: boolean,
): ToolMessage["status"] {
    if (apiStatus === "error") return "error";
    if (apiStatus === "completed") return "completed";

    // Session still working — preserve actual tool status
    if (sessionIsProcessing) return apiStatus === "running" ? "running" : "pending";

    // Session idle — only question tools can still be interactive
    if (QUESTION_TOOLS.has(toolName)) return apiStatus === "running" ? "running" : "pending";

    // Idle session, non-interactive tool — treat as done
    return "completed";
}
```

`historyToChatMessages` and `convertAssistantParts` gain a `sessionIsProcessing` parameter. The call sites:
- `session_switched` handler: reads `msg.isProcessing ?? false`
- `history_page` handler: reads current processing state from the session store

### 3. Status augmentation: explicit priority model

Extract an `isProcessingStatus()` helper to make status priority explicit.

```typescript
function isProcessingStatus(s: SessionStatus | undefined): boolean {
    return s?.type === "busy" || s?.type === "retry";
}

// Propagation loop:
if (!parentId) continue;
if (!isProcessingStatus(augmented[parentId])) {
    augmented[parentId] = { type: "busy" };
}
```

If a new `SessionStatus` type is added, the developer must explicitly decide whether it's a processing status — the helper makes that decision visible.

### 4. Cross-path consistency test

Property-based test asserting REST history and cache-replay paths produce identical tool display statuses for the same underlying data.

Generates random combinations of:
- Tool types (`read`, `write`, `task`, `question`, etc.)
- Tool API statuses (`pending`, `running`, `completed`, `error`)
- Session processing state (`true`, `false`)

Runs both conversion paths and asserts the resulting `ToolMessage.status` values match. Catches divergence between loading paths automatically.

## Files Changed

- `src/lib/shared-types.ts` — add `isProcessing` to `session_switched`
- `src/lib/session/session-switch.ts` — make `statusPoller` required, set `isProcessing` on outbound message
- `src/lib/frontend/utils/history-logic.ts` — refactor `mapToolStatus`, rename allowlist, add `sessionIsProcessing` parameter
- `src/lib/frontend/stores/ws-dispatch.ts` — thread `isProcessing` through `convertHistoryAsync`
- `src/lib/session/status-augmentation.ts` — extract `isProcessingStatus` helper
- `test/unit/session/session-switch.test.ts` — update deps to provide required `statusPoller`
- `test/unit/frontend/history-logic.test.ts` — update `mapToolStatus` tests for new signature
- `test/unit/session/status-augmentation.test.ts` — update for `isProcessingStatus` helper
- New: `test/unit/frontend/cross-path-tool-status.test.ts` — property-based consistency test
