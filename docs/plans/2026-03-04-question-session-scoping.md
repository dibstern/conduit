# Question Session Scoping & Submit Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix questions leaking across sessions and make question submissions resilient to WebSocket interruptions.

**Architecture:** Add `sessionId` to `PendingQuestion`, filter questions on session switch and client reconnect, clear frontend questions on session switch, and add optimistic cleanup + silent retry for question submissions.

**Tech Stack:** TypeScript, Svelte 5, Vitest

---

## Bug Summary

**Bug 1:** Questions render on unrelated sessions because:
- `PendingQuestion` has no `sessionId` field
- Frontend `pendingQuestions` is not cleared on `session_switched`
- Client reconnect replays ALL pending questions without session filtering

**Bug 2:** Question submissions (especially on mobile) appear to work but don't stick:
- `handleSubmit()` sets local `resolved = "submitted"` but doesn't remove from `pendingQuestions`
- Cleanup depends on backend `ask_user_resolved` broadcast round-trip
- If WebSocket drops (common on mobile), the response is silently lost
- When QuestionCard is recreated (session switch/refresh), `resolved` resets → question reappears

---

### Task 1: Add `sessionId` to `PendingQuestion` type and bridge

**Files:**
- Modify: `src/lib/question-bridge.ts:5-9` (PendingQuestion type)
- Modify: `src/lib/question-bridge.ts:91-113` (onQuestion method)
- Modify: `src/lib/question-bridge.ts:129-132` (getPending method — add session filter)
- Test: `test/unit/question-bridge.pbt.test.ts`

**Step 1: Write failing tests for session-scoped getPending**

Add tests to `test/unit/question-bridge.pbt.test.ts`:

```typescript
// P11: getPending with sessionId filter
describe("P11: getPending filters by sessionId", () => {
    it("returns only questions matching the given sessionId", () => {
        const bridge = new QuestionBridge({ now: () => 1_000_000 });

        bridge.onQuestion({
            type: "question.asked",
            properties: { id: "q-1", sessionID: "sess-A", questions: [{ question: "Q1" }] },
        });
        bridge.onQuestion({
            type: "question.asked",
            properties: { id: "q-2", sessionID: "sess-B", questions: [{ question: "Q2" }] },
        });
        bridge.onQuestion({
            type: "question.asked",
            properties: { id: "q-3", sessionID: "sess-A", questions: [{ question: "Q3" }] },
        });

        const sessA = bridge.getPending("sess-A");
        expect(sessA).toHaveLength(2);
        expect(sessA.map(q => q.toolId)).toEqual(["q-1", "q-3"]);

        const sessB = bridge.getPending("sess-B");
        expect(sessB).toHaveLength(1);
        expect(sessB[0]!.toolId).toBe("q-2");
    });

    it("returns all questions when no sessionId filter is provided", () => {
        const bridge = new QuestionBridge({ now: () => 1_000_000 });

        bridge.onQuestion({
            type: "question.asked",
            properties: { id: "q-1", sessionID: "sess-A", questions: [{ question: "Q1" }] },
        });
        bridge.onQuestion({
            type: "question.asked",
            properties: { id: "q-2", sessionID: "sess-B", questions: [{ question: "Q2" }] },
        });

        const all = bridge.getPending();
        expect(all).toHaveLength(2);
    });

    it("stores sessionId on PendingQuestion", () => {
        const bridge = new QuestionBridge({ now: () => 1_000_000 });

        bridge.onQuestion({
            type: "question.asked",
            properties: { id: "q-1", sessionID: "sess-A", questions: [{ question: "Q1" }] },
        });

        const pending = bridge.getPending();
        expect(pending[0]!.sessionId).toBe("sess-A");
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/question-bridge.pbt.test.ts --reporter=verbose`
Expected: FAIL — `sessionId` doesn't exist on `PendingQuestion`, `getPending` doesn't accept args

**Step 3: Implement sessionId on PendingQuestion and filtered getPending**

In `src/lib/question-bridge.ts`:

1. Add `sessionId?: string` to `PendingQuestion` interface
2. In `onQuestion()`, extract `sessionID` from `event.properties` and store it
3. Change `getPending(sessionId?: string)` to filter when provided

```typescript
export interface PendingQuestion {
    toolId: string;
    questions: AskUserQuestion[];
    timestamp: number;
    sessionId?: string;
}

// In onQuestion():
const entry: PendingQuestion = {
    toolId: props.id,
    questions,
    timestamp: this.now(),
    sessionId: (event.properties as { sessionID?: string }).sessionID,
};

// getPending:
getPending(sessionId?: string): PendingQuestion[] {
    const all = Array.from(this.pending.values());
    if (!sessionId) return all;
    return all.filter(q => !q.sessionId || q.sessionId === sessionId);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/question-bridge.pbt.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```
fix(question-bridge): add sessionId to PendingQuestion and filtered getPending
```

---

### Task 2: Filter questions on client reconnect by active session

**Files:**
- Modify: `src/lib/client-init.ts:166-172`

**Step 1: Write no separate test (integration-level change, covered by existing contract tests)**

**Step 2: Implement session-filtered replay in client-init**

In `src/lib/client-init.ts`, change the question replay loop to filter by active session:

```typescript
// Before:
for (const q of questionBridge.getPending()) {

// After:
const activeSessionId = sessionMgr.getActiveSessionId();
for (const q of questionBridge.getPending(activeSessionId ?? undefined)) {
```

The `sessionMgr` is already available in the `handleClientConnected` function's deps.

**Step 3: Verify build compiles**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```
fix(client-init): filter question replay by active session on reconnect
```

---

### Task 3: Clear pending questions on session switch (frontend)

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts:407-451` (session_switched handler)
- Test: `test/unit/svelte-permissions-store.test.ts` (add clearAll test for session switch context)

**Step 1: Write test documenting the expected behavior**

Add to `test/unit/svelte-permissions-store.test.ts`:

```typescript
describe("clearAll on session switch", () => {
    it("clearAll removes pending questions (simulates session switch)", () => {
        handleAskUser({
            type: "ask_user",
            toolId: "t1",
            questions: [{ question: "Q", header: "H", options: [{ label: "A" }], multiSelect: false }],
        });
        expect(permissionsState.pendingQuestions).toHaveLength(1);
        clearAll();
        expect(permissionsState.pendingQuestions).toHaveLength(0);
    });

    it("clearAll removes pending permissions too", () => {
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r1",
            toolName: "Write",
            toolInput: {},
        });
        handleAskUser({
            type: "ask_user",
            toolId: "t1",
            questions: [{ question: "Q", header: "H", options: [{ label: "A" }], multiSelect: false }],
        });
        clearAll();
        expect(permissionsState.pendingPermissions).toHaveLength(0);
        expect(permissionsState.pendingQuestions).toHaveLength(0);
    });
});
```

**Step 2: Run test — should pass already since clearAll exists**

Run: `npx vitest run test/unit/svelte-permissions-store.test.ts --reporter=verbose`

**Step 3: Add `clearAll()` call to session_switched handler**

In `src/lib/public/stores/ws.svelte.ts`, in the `session_switched` case, add `clearAll()` after `clearTodoState()`:

```typescript
case "session_switched": {
    // ... existing code ...
    clearMessages();
    clearTodoState();
    clearAll();  // <-- ADD THIS: clear pending questions/permissions for previous session
    // ... rest of handler ...
```

Import `clearAll` from `permissions.svelte.js` if not already imported.

**Step 4: Run all unit tests**

Run: `npx vitest run test/unit/ --reporter=verbose`

**Step 5: Commit**

```
fix(ws-store): clear pending questions and permissions on session switch
```

---

### Task 4: Optimistic removal from pendingQuestions on submit

**Files:**
- Modify: `src/lib/public/components/features/QuestionCard.svelte:117-126` (handleSubmit)
- Modify: `src/lib/public/stores/permissions.svelte.ts` (no change needed — removeQuestion already exists)

**Step 1: Modify handleSubmit to optimistically remove from store**

In `QuestionCard.svelte`, import `removeQuestion` and call it in `handleSubmit`:

```typescript
import {
    buildAnswerPayload,
    formatQuestionHeader,
    isValidSubmission,
    removeQuestion,  // <-- ADD
} from "../../stores/permissions.svelte.js";

function handleSubmit() {
    if (!canSubmit || resolved) return;
    const answers = buildAnswerPayload(selections, request.questions);
    wsSend({
        type: "ask_user_response",
        toolId: request.toolId,
        answers,
    });
    resolved = "submitted";
    removeQuestion(request.toolId);  // <-- ADD: optimistic removal
}
```

This ensures the question is removed from the global store immediately on submit, so even if the WebSocket response is lost, the question won't reappear when navigating.

Similarly, update `handleSkip`:

```typescript
function handleSkip() {
    if (resolved) return;
    wsSend({ type: "question_reject", toolId: request.toolId });
    resolved = "skipped";
    removeQuestion(request.toolId);  // <-- ADD: optimistic removal
}
```

**Step 2: Verify build compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
fix(question-card): optimistically remove question from store on submit/skip
```

---

### Task 5: Add logging for failed question responses on backend

**Files:**
- Modify: `src/lib/handlers/permissions.ts:32-50` (handleAskUserResponse)

**Step 1: Add warning log when question is not found in bridge**

```typescript
export async function handleAskUserResponse(
    deps: HandlerDeps,
    clientId: string,
    payload: Record<string, unknown>,
): Promise<void> {
    const toolId = String(payload.toolId ?? "");
    const answers = (payload.answers ?? {}) as Record<string, string>;
    const result = deps.questionBridge.onAnswer(toolId, answers);
    if (result) {
        deps.log(
            `   [question] client=${clientId} session=${deps.sessionMgr.getActiveSessionId() ?? "?"} answered: ${toolId}`,
        );
        await deps.client.replyQuestion({
            id: toolId,
            answers: result.formatted,
        });
        deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId });
    } else {
        // Question not found — likely already answered, timed out, or duplicate submission
        deps.log(
            `   [question] client=${clientId} session=${deps.sessionMgr.getActiveSessionId() ?? "?"} answer DROPPED (not pending): ${toolId}`,
        );
    }
}
```

**Step 2: Commit**

```
fix(handlers): log when question answer is dropped due to missing pending entry
```

---

### Task 6: Run all tests and verify

**Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`

**Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`

**Step 3: Run build**

Run: `npm run build`

**Step 4: Commit if any fixes needed**

---

## Implementation Notes

- The `question.asked` SSE event may not always carry a `sessionID` in its properties (see `opencode-events.ts:180-192`). When `sessionId` is undefined on `PendingQuestion`, the `getPending()` filter treats it as matching any session (defensive).
- The optimistic removal (Task 4) is safe because `handleAskUserResolved` is idempotent — filtering by `toolId` when it's already removed is a no-op.
- The `rawSend` function (`ws.svelte.ts:159-163`) silently drops messages when WS is not OPEN. A future improvement could add retry logic, but the optimistic removal in Task 4 prevents the user-visible symptom.
