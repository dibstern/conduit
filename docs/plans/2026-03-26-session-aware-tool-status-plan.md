# Session-Aware Tool Status Resolution — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the manual tool-name allowlist for status resolution by threading session processing state through the wire protocol and history conversion, and add a cross-path consistency test.

**Architecture:** Add `isProcessing` to `session_switched` message. Refactor `mapToolStatus` to use session state instead of tool name matching. Extract `isProcessingStatus` helper for status augmentation. Make `statusPoller` required in `SessionSwitchDeps`.

**Tech Stack:** TypeScript, Vitest (fast-check for PBT)

**Design doc:** `docs/plans/2026-03-26-session-aware-tool-status-design.md`

---

### Task 1: Make `statusPoller` required in `SessionSwitchDeps`

**Files:**
- Modify: `src/lib/session/session-switch.ts:60`
- Modify: `test/unit/session/session-switch.test.ts` (update all test deps)

**Step 1: Update the type**

In `src/lib/session/session-switch.ts:60`, change:

```typescript
readonly statusPoller?: { isProcessing(sessionId: string): boolean };
```

to:

```typescript
readonly statusPoller: { isProcessing(sessionId: string): boolean };
```

**Step 2: Remove `?.` from all `statusPoller` usages in the file**

In `src/lib/session/session-switch.ts:130` (`patchMissingDone`), change the parameter type and usage:

```typescript
export function patchMissingDone(
	source: SessionHistorySource,
	statusPoller: { isProcessing(sessionId: string): boolean },
	sessionId: string,
): SessionHistorySource {
	if (source.kind !== "cached-events") return source;
	if (statusPoller.isProcessing(sessionId)) return source;
```

In `src/lib/session/session-switch.ts:276` (`switchClientToSession`), change:

```typescript
status: deps.statusPoller?.isProcessing(sessionId) ? "processing" : "idle",
```

to:

```typescript
status: deps.statusPoller.isProcessing(sessionId) ? "processing" : "idle",
```

**Step 3: Update test deps**

In `test/unit/session/session-switch.test.ts`, every `makeDeps()` or similar factory must provide `statusPoller`. Search for any test that omits it and add:

```typescript
statusPoller: { isProcessing: () => false },
```

For tests that need processing state, use `() => true`.

**Step 4: Run tests**

Run: `pnpm check && pnpm test:unit -- test/unit/session/session-switch.test.ts`
Expected: All pass with no type errors.

**Step 5: Commit**

```
fix: make statusPoller required in SessionSwitchDeps

Removes optional chaining that silently defaulted to "not processing"
when the poller was absent, which is the wrong default for tool status.
```

---

### Task 2: Add `isProcessing` to `session_switched` wire protocol

**Files:**
- Modify: `src/lib/shared-types.ts:308-321`
- Modify: `src/lib/session/session-switch.ts:148-185` (`buildSessionSwitchedMessage`)
- Modify: `src/lib/session/session-switch.ts:247-294` (`switchClientToSession`)
- Test: `test/unit/session/session-switch.test.ts`

**Step 1: Add `isProcessing` to the type**

In `src/lib/shared-types.ts`, inside the `session_switched` variant (around line 309), add:

```typescript
{
    type: "session_switched";
    id: string;
    /** Whether the session has active work (busy/retry). Used by the
     *  frontend to decide whether to preserve live tool statuses. */
    isProcessing?: boolean;
    requestId?: RequestId;
    events?: RelayMessage[];
    history?: {
        messages: HistoryMessage[];
        hasMore: boolean;
        total?: number;
    };
    inputText?: string;
}
```

**Step 2: Thread `isProcessing` into `buildSessionSwitchedMessage`**

Update `buildSessionSwitchedMessage` signature to accept `isProcessing`:

```typescript
export function buildSessionSwitchedMessage(
	sessionId: string,
	source: SessionHistorySource,
	options?: SessionSwitchMessageOptions & { isProcessing?: boolean },
): Extract<RelayMessage, { type: "session_switched" }> {
```

Add `isProcessing` to the optional fields:

```typescript
const optionalFields = {
    ...(options?.draft ? { inputText: options.draft } : {}),
    ...(options?.requestId != null ? { requestId: options.requestId } : {}),
    ...(options?.isProcessing != null ? { isProcessing: options.isProcessing } : {}),
};
```

**Step 3: Set `isProcessing` in `switchClientToSession`**

In `switchClientToSession` (line 267), pass `isProcessing` when building the message:

```typescript
const isProcessing = deps.statusPoller.isProcessing(sessionId);

const message = buildSessionSwitchedMessage(sessionId, patchedSource, {
    ...(draft ? { draft } : {}),
    ...(options?.requestId != null ? { requestId: options.requestId } : {}),
    isProcessing,
});
```

Also update the status message (line 274) to reuse the same variable:

```typescript
deps.wsHandler.sendTo(clientId, {
    type: "status",
    status: isProcessing ? "processing" : "idle",
});
```

**Step 4: Write test**

Add a test in `test/unit/session/session-switch.test.ts`:

```typescript
it("includes isProcessing in session_switched message", async () => {
    const deps = makeDeps({
        statusPoller: { isProcessing: () => true },
    });
    await switchClientToSession(deps, "client1", "ses_1");
    const sent = deps.wsHandler.sendTo.mock.calls[0]![1];
    expect(sent).toMatchObject({
        type: "session_switched",
        isProcessing: true,
    });
});

it("sends isProcessing: false when session is idle", async () => {
    const deps = makeDeps({
        statusPoller: { isProcessing: () => false },
    });
    await switchClientToSession(deps, "client1", "ses_1");
    const sent = deps.wsHandler.sendTo.mock.calls[0]![1];
    expect(sent).toMatchObject({
        type: "session_switched",
        isProcessing: false,
    });
});
```

**Step 5: Run tests**

Run: `pnpm check && pnpm test:unit -- test/unit/session/session-switch.test.ts`
Expected: All pass.

**Step 6: Commit**

```
feat: include isProcessing in session_switched message

The frontend needs to know whether a session is active at switch time
to correctly preserve running tool statuses in history conversion.
```

---

### Task 3: Refactor `mapToolStatus` to be session-aware

**Files:**
- Modify: `src/lib/frontend/utils/history-logic.ts:111-141` (`mapToolStatus`, `LIVE_STATUS_TOOLS`)
- Modify: `src/lib/frontend/utils/history-logic.ts:154-157` (`convertAssistantParts` signature)
- Modify: `src/lib/frontend/utils/history-logic.ts:252-254` (`historyToChatMessages` signature)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:159-179` (`convertHistoryAsync`)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:335-367` (`session_switched` handler)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:450-474` (`history_page` handler)
- Test: `test/unit/frontend/history-logic.test.ts`

**Step 1: Update `mapToolStatus`**

Replace `LIVE_STATUS_TOOLS` and `mapToolStatus` in `history-logic.ts:111-141`:

```typescript
/** Question tools need user interaction regardless of session state.
 *  This is NOT a general "preserve live status" list — session processing
 *  state handles that for all other tool types. */
const QUESTION_TOOLS = new Set(["question", "AskUserQuestion"]);

/**
 * Map a tool status from the REST API to the ToolMessage status used in live rendering.
 *
 * Decision hierarchy:
 * 1. Error status always preserved.
 * 2. Completed status always preserved.
 * 3. Session is processing → preserve actual status (pending/running) for ALL tools.
 * 4. Session is idle, question tool → preserve actual status (needs user interaction).
 * 5. Session is idle, other tool → force to completed.
 */
function mapToolStatus(
	apiStatus: string | undefined,
	toolName: string | undefined,
	sessionIsProcessing: boolean,
): ToolMessage["status"] {
	if (apiStatus === "error") return "error";
	if (apiStatus === "completed") return "completed";
	if (sessionIsProcessing) return apiStatus === "running" ? "running" : "pending";
	if (toolName && QUESTION_TOOLS.has(toolName)) {
		return apiStatus === "running" ? "running" : "pending";
	}
	return "completed";
}
```

**Step 2: Thread `sessionIsProcessing` through `convertAssistantParts`**

Update signature at line 154:

```typescript
function convertAssistantParts(
	parts: HistoryMessagePart[],
	renderHtml?: (text: string) => string,
	messageId?: string,
	sessionIsProcessing = false,
): ChatMessage[] {
```

Update the `mapToolStatus` call inside the function (find the existing call and add the parameter):

```typescript
status: mapToolStatus(part.state?.status, part.tool, sessionIsProcessing),
```

**Step 3: Thread `sessionIsProcessing` through `historyToChatMessages`**

Update signature at line 252:

```typescript
export function historyToChatMessages(
	messages: HistoryMessage[],
	renderHtml?: (text: string) => string,
	sessionIsProcessing = false,
): ChatMessage[] {
```

Update the call to `convertAssistantParts` inside (around line 274):

```typescript
result.push(...convertAssistantParts(msg.parts, renderHtml, msg.id, sessionIsProcessing));
```

**Step 4: Thread `sessionIsProcessing` through `convertHistoryAsync`**

In `ws-dispatch.ts:159`, update signature:

```typescript
async function convertHistoryAsync(
	messages: HistoryMessage[],
	render: (text: string) => string,
	sessionIsProcessing = false,
): Promise<ChatMessage[] | null> {
```

Update the inner call at line 169:

```typescript
const converted = historyToChatMessages(slice, render, sessionIsProcessing);
```

**Step 5: Pass `isProcessing` from `session_switched` handler**

In `ws-dispatch.ts`, in the `session_switched` case (around line 345-363), read `isProcessing` from the message and pass it:

```typescript
} else if (msg.history) {
    const historyMsgs = msg.history.messages;
    const hasMore = msg.history.hasMore;
    const msgCount = historyMsgs.length;
    const gen = replayGeneration;
    const isProcessing = msg.isProcessing ?? false;
    convertHistoryAsync(historyMsgs, renderMarkdown, isProcessing)
```

**Step 6: Pass processing state from `history_page` handler**

In `ws-dispatch.ts`, in the `history_page` case (around line 459), the processing state should come from the session store. Import or reference the current processing state:

```typescript
case "history_page": {
    const historyMsg = msg as Extract<RelayMessage, { type: "history_page" }>;
    const rawMessages = historyMsg.messages ?? [];
    const hasMore = historyMsg.hasMore ?? false;
    const gen = replayGeneration;
    const isProcessing = sessionState.isProcessing ?? false;
    convertHistoryAsync(rawMessages, renderMarkdown, isProcessing)
```

Check that `sessionState.isProcessing` exists — it should be set by the `status` handler. If it doesn't exist under that exact name, find the equivalent (e.g. `sessionState.status === "processing"`).

**Step 7: Update tests**

Update `test/unit/frontend/history-logic.test.ts`. Replace the existing "tool status mapping" tests to use the new `sessionIsProcessing` parameter:

```typescript
describe("historyToChatMessages — tool status mapping", () => {
	function makeToolHistory(tool: string, status: string): HistoryMessage[] {
		return [{
			id: "msg_asst",
			role: "assistant",
			parts: [{
				id: "p1",
				type: "tool",
				callID: "toolu_123",
				tool,
				state: { status },
			}],
		}];
	}

	test("session processing: running tool preserves running status", () => {
		const chatMsgs = historyToChatMessages(makeToolHistory("read", "running"), undefined, true);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("running");
	});

	test("session processing: pending task preserves pending status", () => {
		const chatMsgs = historyToChatMessages(makeToolHistory("task", "pending"), undefined, true);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("pending");
	});

	test("session idle: running regular tool forced to completed", () => {
		const chatMsgs = historyToChatMessages(makeToolHistory("read", "running"), undefined, false);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("completed");
	});

	test("session idle: running task tool forced to completed", () => {
		const chatMsgs = historyToChatMessages(makeToolHistory("task", "running"), undefined, false);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("completed");
	});

	test("session idle: running question tool preserves running", () => {
		const chatMsgs = historyToChatMessages(makeToolHistory("question", "running"), undefined, false);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("running");
	});

	test("completed tools stay completed regardless of session state", () => {
		const chatMsgs = historyToChatMessages(makeToolHistory("task", "completed"), undefined, true);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("completed");
	});

	test("error tools stay error regardless of session state", () => {
		const chatMsgs = historyToChatMessages(makeToolHistory("task", "error"), undefined, true);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("error");
	});
});
```

**Step 8: Run tests**

Run: `pnpm check && pnpm test:unit -- test/unit/frontend/history-logic.test.ts test/unit/stores/`
Expected: All pass.

**Step 9: Commit**

```
refactor: session-aware mapToolStatus eliminates tool-name allowlist

mapToolStatus now takes sessionIsProcessing instead of checking tool
names against a manual allowlist. When a session is processing, ALL
tools preserve their actual status. When idle, only question tools
(which need user interaction) preserve status.

No new tool type ever needs special handling.
```

---

### Task 4: Extract `isProcessingStatus` helper in status augmentation

**Files:**
- Modify: `src/lib/session/status-augmentation.ts:45-58`
- Test: `test/unit/session/status-augmentation.test.ts`

**Step 1: Extract helper and refactor**

In `status-augmentation.ts`, add the helper above `computeAugmentedStatuses`:

```typescript
/** Returns true for statuses that represent active processing.
 *  Used to prevent downgrading a parent that is already working. */
function isProcessingStatus(s: SessionStatus | undefined): boolean {
	return s?.type === "busy" || s?.type === "retry";
}
```

Refactor the propagation loop (around line 46-58) to use it:

```typescript
// ── Step 2: Subagent propagation ──────────────────────────────────────
// A parent waiting for a busy subagent IS busy, even if OpenCode's raw
// /session/status reports it as "idle".  Override idle parents but don't
// downgrade parents that are already in a processing state (busy/retry).
for (const busyId of busyIds) {
    let parentId = input.parentMap.get(busyId);
    if (parentId === undefined) {
        parentId = input.childToParentResolved.get(busyId) ?? undefined;
    }
    if (!parentId) continue;
    if (!isProcessingStatus(augmented[parentId])) {
        augmented[parentId] = { type: "busy" };
    }
}
```

**Step 2: Run tests**

Run: `pnpm check && pnpm test:unit -- test/unit/session/status-augmentation.test.ts`
Expected: All 11 tests pass (this is a pure refactor of the existing fix).

**Step 3: Commit**

```
refactor: extract isProcessingStatus helper for explicit priority model

Replaces the ad-hoc `!existing || existing.type === "idle"` condition
with a named helper that makes the decision visible: only processing
statuses (busy/retry) are preserved; idle is always overridden.
```

---

### Task 5: Cross-path consistency property-based test

**Files:**
- Create: `test/unit/frontend/cross-path-tool-status.test.ts`

**Step 1: Write the test**

```typescript
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import {
	historyToChatMessages,
	type HistoryMessage,
} from "../../../src/lib/frontend/utils/history-logic.js";

/**
 * Property-based test: the REST history path (historyToChatMessages) must
 * produce the same tool display status regardless of tool name, given the
 * same apiStatus + sessionIsProcessing input.
 *
 * This catches allowlist-based divergence: if a new tool type gets different
 * treatment, this test fails.
 */
describe("cross-path tool status consistency", () => {
	const toolNames = fc.constantFrom(
		"read", "write", "edit", "bash", "task", "Task",
		"glob", "grep", "lsp", "webfetch", "todowrite",
	);
	const apiStatuses = fc.constantFrom("pending", "running", "completed", "error");
	const sessionProcessing = fc.boolean();

	test("non-question tools produce identical status regardless of tool name", () => {
		fc.assert(
			fc.property(
				toolNames, toolNames, apiStatuses, sessionProcessing,
				(toolA, toolB, apiStatus, isProcessing) => {
					const makeHistory = (tool: string): HistoryMessage[] => [{
						id: "msg_1",
						role: "assistant",
						parts: [{
							id: "p1",
							type: "tool",
							callID: `toolu_${tool}`,
							tool,
							state: { status: apiStatus },
						}],
					}];

					const msgsA = historyToChatMessages(makeHistory(toolA), undefined, isProcessing);
					const msgsB = historyToChatMessages(makeHistory(toolB), undefined, isProcessing);

					const statusA = msgsA.find(m => m.type === "tool");
					const statusB = msgsB.find(m => m.type === "tool");

					expect(statusA?.type === "tool" && statusA.status).toBe(
						statusB?.type === "tool" && statusB.status,
					);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("question tools may differ from non-question when idle (expected)", () => {
		// This test documents the intentional divergence: question tools
		// preserve status when idle, other tools don't.
		const history = (tool: string): HistoryMessage[] => [{
			id: "msg_1",
			role: "assistant",
			parts: [{
				id: "p1",
				type: "tool",
				callID: "toolu_1",
				tool,
				state: { status: "running" },
			}],
		}];

		const questionMsgs = historyToChatMessages(history("question"), undefined, false);
		const regularMsgs = historyToChatMessages(history("read"), undefined, false);

		const qStatus = questionMsgs.find(m => m.type === "tool");
		const rStatus = regularMsgs.find(m => m.type === "tool");

		// Question preserves running; regular forced to completed
		expect(qStatus?.type === "tool" && qStatus.status).toBe("running");
		expect(rStatus?.type === "tool" && rStatus.status).toBe("completed");
	});

	test("when processing, ALL tools (including question) agree", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("read", "task", "question", "AskUserQuestion", "bash"),
				fc.constantFrom("read", "task", "question", "AskUserQuestion", "bash"),
				apiStatuses,
				(toolA, toolB, apiStatus) => {
					const makeHistory = (tool: string): HistoryMessage[] => [{
						id: "msg_1",
						role: "assistant",
						parts: [{
							id: "p1",
							type: "tool",
							callID: `toolu_${tool}`,
							tool,
							state: { status: apiStatus },
						}],
					}];

					const msgsA = historyToChatMessages(makeHistory(toolA), undefined, true);
					const msgsB = historyToChatMessages(makeHistory(toolB), undefined, true);

					const statusA = msgsA.find(m => m.type === "tool");
					const statusB = msgsB.find(m => m.type === "tool");

					expect(statusA?.type === "tool" && statusA.status).toBe(
						statusB?.type === "tool" && statusB.status,
					);
				},
			),
			{ numRuns: 200 },
		);
	});
});
```

**Step 2: Run test**

Run: `pnpm test:unit -- test/unit/frontend/cross-path-tool-status.test.ts`
Expected: All 3 tests pass.

**Step 3: Commit**

```
test: property-based cross-path tool status consistency

Asserts that all non-question tools produce identical display statuses
for the same API status + session processing state, regardless of tool
name. Catches future allowlist-like divergence automatically.
```

---

### Task 6: Final verification

**Step 1: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All pass with no regressions.

**Step 2: Commit any lint/format fixes if needed**
