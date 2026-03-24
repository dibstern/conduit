# Pipeline Resilience Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make the event pipeline more observable, eliminate silent failures, and ensure tool state consistency across all event delivery paths.

**Architecture:** Three layers of improvement: (A) upgrade key decision-point logging from verbose/silent to info so issues are visible without enabling debug mode, (B) route all tool state creation through the ToolRegistry so no code path can bypass the state machine, (C) add integration tests that cover the full pipeline end-to-end including the history+SSE overlap scenario.

**Tech Stack:** TypeScript, Vitest, pino logger, Svelte 5 stores

**Verification:** `pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration`

---

### Task 1: Upgrade pipeline "no viewers" log from verbose to info

The pipeline's event routing drop log is the single most important diagnostic for debugging "tool card not updating" issues. Currently at verbose level, it's invisible in normal operation.

**Files:**
- Modify: `src/lib/relay/event-pipeline.ts:167-170`
- Test: `test/unit/relay/event-pipeline.test.ts` (existing — verify no test asserts on verbose level)

**Step 1: Change log level**

In `src/lib/relay/event-pipeline.ts`, at lines 167-170, change:
```ts
deps.log.verbose(
    `${result.route.reason} — ${result.msg.type} (${result.source})`,
);
```
to:
```ts
deps.log.info(
    `${result.route.reason} — ${result.msg.type} (${result.source})`,
);
```

**Step 2: Update the existing test assertion**

The test at `test/unit/relay/event-pipeline.test.ts:387` asserts `deps.log.verbose` for the "no viewers" log. Update:
- Add `info: vi.fn()` to the `makeDeps()` log mock (alongside existing `verbose`)
- Change the assertion from `deps.log.verbose` to `deps.log.info`
- Update the return type to include `info`

**Step 3: Run existing pipeline tests**

Run: `pnpm test:unit test/unit/relay/event-pipeline.test.ts`
Expected: All pass

**Step 4: Commit**

```
feat(observability): upgrade pipeline event drop log to info level
```

---

### Task 2: Add viewer registration logging to SessionRegistry

The `SessionRegistry` has zero logging. When a client is registered or unregistered for a session, there's no trace. This made the "no viewers" issue invisible.

**Files:**
- Modify: `src/lib/session/session-registry.ts`
- Test: `test/unit/session/session-registry.test.ts` (existing)

**Step 1: Add logger to SessionRegistry**

The `SessionRegistry` constructor doesn't accept a logger. Add an optional logger parameter:

```ts
import type { Logger } from "../logger.js";

export class SessionRegistry {
    private log?: Logger;

    constructor(log?: Logger) {
        this.log = log;
    }
```

**Step 2: Log in setClientSession and removeClient**

In `setClientSession`:
```ts
this.log?.info(`client=${clientId} registered for session=${sessionId}`);
```

In `removeClient`, guard against undefined (client was never registered):
```ts
const sessionId = /* the session returned by the existing removal logic */;
if (sessionId) {
    this.log?.info(`client=${clientId} unregistered from session=${sessionId}`);
}
```
Note: use the actual variable name from `removeClient`'s return value, not `oldSessionId`.

**Step 3: Wire logger in relay-stack.ts**

Where `SessionRegistry` is constructed in the relay stack, pass the logger:
```ts
const registry = new SessionRegistry(log.child("session-registry"));
```

Find the construction site by searching for `new SessionRegistry` in `relay-stack.ts`.

**Step 4: Run existing registry tests**

Run: `pnpm test:unit test/unit/session/session-registry.test.ts`
Expected: All pass (constructor is optional, tests don't pass a logger)

**Step 5: Commit**

```
feat(observability): add viewer registration logging to SessionRegistry
```

---

### Task 3: Seed ToolRegistry from history_page (close the gap)

The `session_switched` handler calls `seedRegistryFromMessages` after history conversion, but the `history_page` handler does NOT. This means tools loaded via pagination are not registered, causing "unknown tool" errors when SSE events arrive for them.

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:407-411`
- Test: `test/unit/stores/chat-store.test.ts` (new test)

**Step 1: Add the production fix first (test comes after)**

In `ws-dispatch.ts`, find the `history_page` handler (~line 407). After `prependMessages(chatMsgs)`, add:
```ts
seedRegistryFromMessages(chatMsgs);
```
Ensure `seedRegistryFromMessages` is imported from `chat.svelte.ts` (it should already be imported for the `session_switched` path).

**Step 2: Write a registry-level unit test**

In `test/unit/stores/tool-registry.test.ts`, add a test verifying that seeded tools accept late complete() calls:

```ts
it("seeded tools accept late complete() after history load", () => {
    registry.seedFromHistory([{
        id: "toolu_hist1", name: "Bash", status: "completed", uuid: "uuid-hist-1",
    }]);
    // Late SSE complete should succeed (tool is known)
    const result = registry.complete("toolu_hist1", "updated output", false);
    expect(result.action).toBe("update");
});
```

Note: This is a registry-level unit test, not an end-to-end dispatch test. The dispatch wiring is verified by the integration tests in Task 4/5.

**Step 3: Run tests**

Run: `pnpm test:unit test/unit/stores/chat-store.test.ts`
Expected: All pass

**Step 4: Commit**

```
fix: seed ToolRegistry from history_page to prevent unknown tool errors
```

---

### Task 4: Integration test — full tool lifecycle through pipeline

Test that a tool_start → tool_executing → tool_result sequence from SSE makes it through the relay pipeline to a connected WebSocket client with correct event types and ordering.

**Files:**
- Create: `test/integration/flows/tool-lifecycle-pipeline.integration.ts`

**Step 1: Write the integration test**

Use the existing `RelayHarness` + `TestWsClient` infrastructure. The test should:

1. Start a relay with a mock OpenCode server
2. Connect a WS client and switch to a session
3. Inject SSE events for a tool lifecycle (pending → running → completed)
4. Verify the WS client receives tool_start, tool_executing, tool_result in order
5. Verify tool_result has content and is_error fields

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRelayHarness } from "../helpers/relay-harness.js";

describe("Tool lifecycle through pipeline", () => {
    let harness: Awaited<ReturnType<typeof createRelayHarness>>;

    beforeAll(async () => {
        harness = await createRelayHarness();
    });

    afterAll(async () => {
        await harness.cleanup();
    });

    it("delivers tool_start, tool_executing, tool_result in order", async () => {
        const client = await harness.connectWsClient();
        await client.waitForInitialState();

        // Inject SSE tool events via the mock server
        harness.mock.injectSSEEvents([{
            type: "message.part.updated",
            properties: {
                partID: "part-1",
                messageID: "msg-1",
                sessionID: "test-session",  // Use the session ID from session_switched
                part: {
                    type: "tool",
                    callID: "toolu_test1",
                    tool: "bash",
                    state: { status: "pending" },
                },
            },
        }]);

        const toolStart = await client.waitFor("tool_start");
        expect(toolStart.id).toBe("toolu_test1");

        harness.mock.injectSSEEvents([{
            type: "message.part.updated",
            properties: {
                partID: "part-1",
                messageID: "msg-1",
                sessionID: "test-session",  // Use the session ID from session_switched
                part: {
                    type: "tool",
                    callID: "toolu_test1",
                    tool: "bash",
                    state: { status: "running", input: { command: "ls" } },
                },
            },
        }]);

        const toolExec = await client.waitFor("tool_executing");
        expect(toolExec.id).toBe("toolu_test1");

        harness.mock.injectSSEEvents([{
            type: "message.part.updated",
            properties: {
                partID: "part-1",
                messageID: "msg-1",
                sessionID: "test-session",  // Use the session ID from session_switched
                part: {
                    type: "tool",
                    callID: "toolu_test1",
                    tool: "bash",
                    state: { status: "completed", output: "file1.txt\nfile2.txt" },
                },
            },
        }]);

        const toolResult = await client.waitFor("tool_result");
        expect(toolResult.id).toBe("toolu_test1");
        expect(toolResult.content).toBe("file1.txt\nfile2.txt");
        expect(toolResult.is_error).toBe(false);
    });
});
```

NOTE: Check the relay harness API before implementing — it may use `harness.mockServer.emitSSE()` or similar instead of `harness.injectSSEEvent()`. Adapt the test to match the actual harness API. The relay harness is at `test/integration/helpers/relay-harness.ts`.

**Step 2: Run the integration test**

Run: `pnpm test:integration test/integration/flows/tool-lifecycle-pipeline.integration.ts`
Expected: PASS

**Step 3: Commit**

```
test: add integration test for full tool lifecycle through pipeline
```

---

### Task 5: Integration test — history + SSE overlap scenario

Test the specific scenario that caused the "completed → running" and "unknown tool" errors: loading a session with completed tools from history, then receiving SSE events for those same tools.

**Files:**
- Add to: `test/integration/flows/tool-lifecycle-pipeline.integration.ts`

**Step 1: Write the overlap test**

```ts
it("handles history+SSE overlap without errors", async () => {
    const client = await harness.connectWsClient();
    await client.waitForInitialState();

    // Simulate: session has completed tools in history
    // Then SSE replays the tool lifecycle for those same tools
    // The pipeline should handle this gracefully (no errors)

    // First, inject the complete lifecycle (simulating history cache replay)
    // pending → running → completed
    for (const status of ["pending", "running", "completed"]) {
        harness.mock.injectSSEEvents([{
            type: "message.part.updated",
            properties: {
                partID: "part-overlap",
                messageID: "msg-overlap",
                sessionID: "test-session",  // Use the session ID from session_switched
                part: {
                    type: "tool",
                    callID: "toolu_overlap",
                    tool: "read",
                    state: {
                        status,
                        ...(status === "running" && { input: { path: "/tmp/test" } }),
                        ...(status === "completed" && { output: "file content" }),
                    },
                },
            },
        });
    }

    // Wait for the completed result
    const result = await client.waitFor("tool_result");
    expect(result.id).toBe("toolu_overlap");

    // Now inject STALE SSE events for the same tool (overlap)
    // These should be handled gracefully (no crash, no error)
    harness.mock.injectSSEEvents([{
        type: "message.part.updated",
        properties: {
            partID: "part-overlap",
            messageID: "msg-overlap",
            sessionID: "test-session",  // Use the session ID from session_switched
            part: {
                type: "tool",
                callID: "toolu_overlap",
                tool: "read",
                state: { status: "running", input: { path: "/tmp/test" } },
            },
        },
    });

    // The stale running event should not produce a new tool_executing
    // (translator's seenParts already has this part as completed)
    // Wait briefly and check no tool_executing was sent
    await new Promise((r) => setTimeout(r, 200));
    const staleEvents = client.getReceivedOfType("tool_executing")
        .filter((e: any) => e.id === "toolu_overlap");
    // Should have exactly 1 (from the initial lifecycle), not 2
    expect(staleEvents.length).toBeLessThanOrEqual(1);
});
```

NOTE: The translator's `seenParts` tracks the last status for each partID. When a part transitions to "completed", subsequent "running" events for the same partID will still match `status === "running"` in `translateToolPartUpdated` and emit `tool_executing`. The test should verify that the relay delivers events in order and that the **frontend** (via ToolRegistry) handles the overlap gracefully — not that the translator suppresses stale events. The translator is intentionally stateless about transition validity.

**Step 2: Run the integration test**

Run: `pnpm test:integration test/integration/flows/tool-lifecycle-pipeline.integration.ts`
Expected: PASS

**Step 3: Commit**

```
test: add integration test for history+SSE overlap scenario
```

---

### Task 6: Route history tool creation through ToolRegistry

Currently `convertAssistantParts` in `history-logic.ts` constructs `ToolMessage` objects directly. This bypasses the registry, meaning any tool loaded from history is invisible to the state machine. Instead, history conversion should produce tool data that gets seeded into the registry.

**Files:**
- Modify: `src/lib/frontend/utils/history-logic.ts:189-221`
- Modify: `src/lib/frontend/stores/tool-registry.ts` — enhance `seedFromHistory` to accept full tool data
- Test: `test/unit/frontend/history-logic.test.ts` (existing)
- Test: `test/unit/stores/tool-registry.test.ts` (existing)

**Step 1: Enhance `seedFromHistory` to accept full tool data**

Currently `seedFromHistory` creates bare skeleton entries. Use `Pick` and `Partial<Pick>` from the `ToolMessage` type to keep the parameter in sync with the source type:

```ts
type HistoryToolSeed = Pick<ToolMessage, "id" | "name" | "status" | "uuid"> &
    Partial<Pick<ToolMessage, "result" | "isError" | "input" | "metadata" | "messageId">>;

function seedFromHistory(tools: ReadonlyArray<HistoryToolSeed>): void {
    for (const t of tools) {
        if (entries.has(t.id)) continue;
        entries.set(t.id, {
            uuid: t.uuid,
            status: t.status,
            tool: {
                type: "tool",
                ...t,
            },
        });
    }
}
```

This preserves the existing behavior (accepts minimal fields) while accepting full tool data. The `Pick`/`Partial<Pick>` pattern ensures the type stays in sync with `ToolMessage`.

**Step 2: Update the `ToolRegistry` interface and export the type**

Update the `ToolRegistry` interface's `seedFromHistory` signature to use `HistoryToolSeed`. Export the type for use by callers.

**Step 3: Run tests**

Run: `pnpm test:unit test/unit/stores/tool-registry.test.ts`
Expected: All pass (existing tests pass minimal fields, which still works)

**Step 4: Add a test for full tool data seeding**

```ts
it("seedFromHistory preserves result, input, and metadata", () => {
    registry.seedFromHistory([{
        id: "t1", name: "Bash", status: "completed", uuid: "uuid-h1",
        result: "output text", isError: false,
        input: { command: "ls" },
        metadata: { duration: 100 },
    }]);

    // Complete with new result should override
    const res = registry.complete("t1", "new output", false);
    expect(res.action).toBe("update");
    if (res.action === "update") {
        expect(res.tool.result).toBe("new output");
    }
});
```

**Step 5: Commit**

```
feat: enhance seedFromHistory to accept full tool data
```

---

### Task 7: Final verification

**Step 1: Run full verification suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
```

All must pass.

**Step 2: Commit any final fixes**

If any tests fail, fix and commit.
