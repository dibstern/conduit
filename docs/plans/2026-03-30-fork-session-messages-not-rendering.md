# Fork Session Messages Not Rendering — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix the bug where new messages sent in a forked session (and their LLM responses) are invisible because the fork-split fails when the SSE event cache is used instead of REST history.

**Architecture:** The SSE event cache for a forked session only contains events from *after* the fork was created — it never has the inherited parent history. When `resolveSessionHistory` returns these cached events, the frontend's `splitAtForkPoint` can't find the `forkMessageId` (which exists only in the inherited history), so ALL messages are dumped into the collapsed "inherited" block and `current` is empty. The fix adds fork-awareness to `resolveSessionHistory`: if the session is a fork and the cache doesn't contain the fork-point message, fall through to REST which returns the complete history.

**Tech Stack:** TypeScript, Vitest (unit), Playwright (E2E replay)

---

### Task 1: Unit test — `resolveSessionHistory` falls through to REST for fork sessions with incomplete cache

**Files:**
- Modify: `test/unit/session/session-switch.test.ts`
- Modify: `src/lib/session/session-switch.ts` (types only — add `forkMeta` to deps)

**Step 1: Add `forkMeta` to `SessionSwitchDeps` interface**

In `src/lib/session/session-switch.ts`, add to the `SessionSwitchDeps` interface:

```typescript
readonly forkMeta?: {
    getForkEntry(sessionId: string): { forkMessageId: string; parentID: string } | undefined;
};
```

This is optional (`?`) so existing callers without fork-awareness still work.

**Step 2: Write the failing unit tests**

Add to `test/unit/session/session-switch.test.ts`, in the `resolveSessionHistory` describe block:

```typescript
it("falls through to REST when session is a fork and cache lacks forkMessageId", async () => {
    // Cache has events with delta (would normally trigger cached-events path)
    // but none of them carry the forkMessageId
    const events: RelayMessage[] = [
        { type: "delta", text: "some response", messageId: "msg_other1" },
        { type: "delta", text: "more response", messageId: "msg_other2" },
        { type: "done", code: 0 },
    ];
    const history = { messages: [{ id: "m1", role: "user" as const }], hasMore: false };
    const deps = createMinimalDeps({
        messageCache: { getEvents: vi.fn().mockReturnValue(events) },
        sessionMgr: {
            loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
            seedPaginationCursor: vi.fn(),
        },
    });
    // Add fork metadata — the forkMessageId is NOT in the cached events
    (deps as any).forkMeta = {
        getForkEntry: vi.fn().mockReturnValue({
            forkMessageId: "msg_fork_point",
            parentID: "ses_parent",
        }),
    };

    const result = await resolveSessionHistory("ses_forked", deps);

    expect(result.kind).toBe("rest-history");
    expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith("ses_forked");
});

it("uses cache when session is a fork and cache DOES contain forkMessageId", async () => {
    const forkMsgId = "msg_fork_point";
    const events: RelayMessage[] = [
        { type: "user_message", text: "hello" },
        { type: "delta", text: "response", messageId: forkMsgId },
        { type: "delta", text: "more", messageId: "msg_after_fork" },
    ];
    const deps = createMinimalDeps({
        messageCache: { getEvents: vi.fn().mockReturnValue(events) },
    });
    (deps as any).forkMeta = {
        getForkEntry: vi.fn().mockReturnValue({
            forkMessageId: forkMsgId,
            parentID: "ses_parent",
        }),
    };

    const result = await resolveSessionHistory("ses_forked", deps);

    expect(result.kind).toBe("cached-events");
    expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
});

it("uses cache normally when session is NOT a fork", async () => {
    const events: RelayMessage[] = [
        { type: "delta", text: "response", messageId: "msg_any" },
    ];
    const deps = createMinimalDeps({
        messageCache: { getEvents: vi.fn().mockReturnValue(events) },
    });
    // forkMeta returns undefined — not a fork
    (deps as any).forkMeta = {
        getForkEntry: vi.fn().mockReturnValue(undefined),
    };

    const result = await resolveSessionHistory("ses_normal", deps);

    expect(result.kind).toBe("cached-events");
});

it("uses cache when forkMeta is absent (legacy callers without fork-awareness)", async () => {
    const events: RelayMessage[] = [
        { type: "delta", text: "response", messageId: "msg_any" },
    ];
    // No forkMeta at all — simulates callers that predate the fork fix
    const deps = createMinimalDeps({
        messageCache: { getEvents: vi.fn().mockReturnValue(events) },
    });

    const result = await resolveSessionHistory("ses_legacy", deps);

    expect(result.kind).toBe("cached-events");
});
```

**Step 3: Run tests to verify they fail**

Run: `pnpm test:unit -- test/unit/session/session-switch.test.ts --grep "fork"`
Expected: The first test FAILS (returns `cached-events` instead of `rest-history`). The other two may pass or fail depending on type errors.

**Step 4: Implement `resolveSessionHistory` fork-awareness**

In `src/lib/session/session-switch.ts`, modify `resolveSessionHistory`:

```typescript
export async function resolveSessionHistory(
    sessionId: string,
    deps: Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "forkMeta">,
): Promise<SessionHistorySource> {
    const events = await deps.messageCache.getEvents(sessionId);
    const classification = classifyHistorySource(events);

    if (classification === "cached-events" && events) {
        // For fork sessions: verify the cache includes the fork-point message.
        // The SSE cache only captures events from AFTER the fork — it never has
        // inherited parent messages. Without the fork-point message, the frontend's
        // splitAtForkPoint fails and puts ALL messages into the collapsed inherited
        // block (current=[]). Fall through to REST which returns the full history.
        const forkEntry = deps.forkMeta?.getForkEntry(sessionId);
        if (forkEntry) {
            const hasForkPoint = events.some(
                (e) =>
                    "messageId" in e &&
                    typeof e.messageId === "string" &&
                    e.messageId === forkEntry.forkMessageId,
            );
            if (!hasForkPoint) {
                deps.log.info(
                    `Fork session ${sessionId.slice(0, 12)}: cache lacks fork-point ` +
                    `${forkEntry.forkMessageId.slice(0, 16)} — falling through to REST`,
                );
                // Fall through to REST below
                try {
                    const history = await deps.sessionMgr.loadPreRenderedHistory(sessionId);
                    return { kind: "rest-history", history };
                } catch (err) {
                    deps.log.warn(
                        `Failed to load history for ${sessionId}: ${err instanceof Error ? err.message : err}`,
                    );
                    return { kind: "empty" };
                }
            }
        }

        const cacheAppearsComplete = events[0]?.type === "user_message";
        return {
            kind: "cached-events",
            events,
            hasMore: !cacheAppearsComplete,
        };
    }

    try {
        const history = await deps.sessionMgr.loadPreRenderedHistory(sessionId);
        return { kind: "rest-history", history };
    } catch (err) {
        deps.log.warn(
            `Failed to load history for ${sessionId}: ${err instanceof Error ? err.message : err}`,
        );
        return { kind: "empty" };
    }
}
```

**Step 5: Run tests to verify they pass**

Run: `pnpm test:unit -- test/unit/session/session-switch.test.ts`
Expected: ALL pass (including existing tests — `forkMeta` is optional so they don't break).

**Step 6: Commit**

```bash
git add src/lib/session/session-switch.ts test/unit/session/session-switch.test.ts
git commit -m "fix: fork sessions fall through to REST when cache lacks fork-point message"
```

---

### Task 2: Add `getForkEntry` to `SessionManager`

**Files:**
- Modify: `src/lib/session/session-manager.ts`

**Step 1: Add the public method**

After the existing `setForkEntry` method (line ~472):

```typescript
/** Look up fork-point metadata for a session. Returns undefined if not a fork. */
getForkEntry(sessionId: string): ForkEntry | undefined {
    return this.forkMeta.get(sessionId);
}
```

**Step 2: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/session/session-manager.ts
git commit -m "feat: expose getForkEntry on SessionManager for fork-aware cache validation"
```

---

### Task 3: Thread `forkMeta` through handler deps → session switch deps

**Files:**
- Modify: `src/lib/handlers/types.ts` (add `getForkEntry` to `forkMeta`)
- Modify: `src/lib/relay/handler-deps-wiring.ts` (wire `getForkEntry`)
- Modify: `src/lib/handlers/session.ts` (`toSessionSwitchDeps` — pass `forkMeta`)
- Modify: `src/lib/bridges/client-init.ts` (wire `forkMeta` in inline SessionSwitchDeps)

**Step 1: Extend `HandlerDeps.forkMeta` interface**

In `src/lib/handlers/types.ts`, change the `forkMeta` field:

```typescript
forkMeta: {
    setForkEntry: (
        sessionId: string,
        entry: { forkMessageId: string; parentID: string },
    ) => void;
    getForkEntry: (
        sessionId: string,
    ) => { forkMessageId: string; parentID: string } | undefined;
};
```

**Step 2: Wire `getForkEntry` in handler-deps-wiring**

In `src/lib/relay/handler-deps-wiring.ts`, update the `forkMeta` object (line ~137):

```typescript
forkMeta: {
    setForkEntry: (sid, entry) => sessionMgr.setForkEntry(sid, entry),
    getForkEntry: (sid) => sessionMgr.getForkEntry(sid),
},
```

**Step 3: Pass `forkMeta` through `toSessionSwitchDeps`**

In `src/lib/handlers/session.ts`, update `toSessionSwitchDeps` (line ~135):

```typescript
function toSessionSwitchDeps(deps: HandlerDeps): SessionSwitchDeps {
    return {
        messageCache: deps.messageCache,
        sessionMgr: deps.sessionMgr,
        wsHandler: deps.wsHandler,
        statusPoller: deps.statusPoller,
        pollerManager: deps.pollerManager,
        log: deps.log,
        getInputDraft: getSessionInputDraft,
        forkMeta: {
            getForkEntry: deps.forkMeta.getForkEntry,
        },
    };
}
```

**Step 4: Wire `forkMeta` in `client-init.ts` inline deps**

In `src/lib/bridges/client-init.ts`, the inline `SessionSwitchDeps` object at line ~101 also needs `forkMeta`. This path is used on initial WS connect (page refresh, bookmark, `?session=` param). Without it, opening a fork session directly would still hit the buggy cache path.

Add `forkMeta` to the object passed to `switchClientToSession`:

```typescript
await switchClientToSession(
    {
        messageCache,
        sessionMgr,
        wsHandler,
        ...(deps.statusPoller != null && { statusPoller: deps.statusPoller }),
        log: deps.log,
        getInputDraft: getSessionInputDraft,
        forkMeta: {
            getForkEntry: (sid: string) => sessionMgr.getForkEntry(sid),
        },
    } satisfies SessionSwitchDeps,
    clientId,
    activeId,
    { skipPollerSeed: true },
);
```

**Step 5: Run type check and existing tests**

Run: `pnpm check && pnpm test:unit`
Expected: ALL pass. The optional `forkMeta` on `SessionSwitchDeps` means existing test helpers that don't provide it still work.

**Step 6: Commit**

```bash
git add src/lib/handlers/types.ts src/lib/relay/handler-deps-wiring.ts src/lib/handlers/session.ts src/lib/bridges/client-init.ts
git commit -m "feat: thread forkMeta.getForkEntry through handler deps to session switch"
```

---

### Task 4: Remove debug logging added during investigation

**Files:**
- Modify: `src/lib/handlers/prompt.ts` (remove `[fork-debug]` log)
- Modify: `src/lib/handlers/session.ts` (remove `[fork-debug]` log)
- Modify: `src/lib/session/session-switch.ts` (remove `[fork-debug]` logs, keep the new fork-fallthrough log)
- Modify: `src/lib/relay/event-pipeline.ts` (remove `[fork-debug]` log)
- Modify: `src/lib/relay/sse-wiring.ts` (revert echo log to `log.debug`)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (remove all `[fork-debug]` console logs)
- Modify: `src/lib/frontend/utils/fork-split.ts` (keep the existing `console.warn` for split failure, remove the success `console.debug`)
- Modify: `src/lib/frontend/components/chat/MessageList.svelte` (remove `$effect` debug log)

**Step 1: Remove all debug logging**

Remove every `[fork-debug]` log line added during the investigation. Keep the operational log in the new fork-fallthrough path (`Fork session ${sessionId}: cache lacks fork-point`).

**Step 2: Run build and lint**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove fork debugging instrumentation"
```

---

### Task 5: E2E replay test — fork session renders new messages after fork divider

**Files:**
- Create: `test/e2e/specs/fork-session-messages.spec.ts`
- Modify: `test/e2e/playwright-replay.config.ts` (add to `testMatch`)

**Step 1: Write the failing E2E test**

Create `test/e2e/specs/fork-session-messages.spec.ts`:

```typescript
// ─── Fork Session Message Rendering (Replay E2E) ────────────────────────────
// Proves that messages sent in a forked session appear AFTER the fork divider
// (in the "current" section), not hidden inside the collapsed inherited block.
//
// Uses the fork-session recording. The test verifies that after forking and
// sending a message, the user message AND the assistant response appear
// below the fork divider — not collapsed into the "Prior conversation" block.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

/**
 * Send a raw JSON message through the browser's open WebSocket.
 */
async function sendWsMessage(
    page: import("@playwright/test").Page,
    payload: Record<string, unknown>,
): Promise<void> {
    await page.evaluate((msg) => {
        const allSockets = (window as unknown as { __testWs?: WebSocket[] })
            .__testWs;
        if (allSockets && allSockets.length > 0) {
            const ws = allSockets[allSockets.length - 1];
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg));
                return;
            }
        }
        throw new Error("No WebSocket found. Ensure WS capture is set up.");
    }, payload);
}

/**
 * Install a WebSocket capture hook before the page navigates.
 */
async function installWsCapture(
    page: import("@playwright/test").Page,
): Promise<void> {
    await page.addInitScript(() => {
        const allSockets: WebSocket[] = [];
        (window as unknown as { __testWs: WebSocket[] }).__testWs = allSockets;
        const OrigWs = window.WebSocket;
        const WsProxy = function (
            this: WebSocket,
            ...args: ConstructorParameters<typeof WebSocket>
        ) {
            const ws = new OrigWs(...args);
            allSockets.push(ws);
            return ws;
        } as unknown as typeof WebSocket;
        WsProxy.prototype = OrigWs.prototype;
        Object.defineProperty(WsProxy, "CONNECTING", { value: OrigWs.CONNECTING });
        Object.defineProperty(WsProxy, "OPEN", { value: OrigWs.OPEN });
        Object.defineProperty(WsProxy, "CLOSING", { value: OrigWs.CLOSING });
        Object.defineProperty(WsProxy, "CLOSED", { value: OrigWs.CLOSED });
        (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = WsProxy;
    });
}

test.describe("Fork Session — New Message Rendering", () => {
    test.describe.configure({ timeout: 60_000 });
    test.use({ recording: "fork-session" });

    test("messages sent in forked session appear after fork divider", async ({
        page,
        relayUrl,
    }) => {
        const app = new AppPage(page);
        const chat = new ChatPage(page);

        await installWsCapture(page);
        await app.goto(relayUrl);

        // ── Turn 1 + Turn 2 in original session ──
        await app.sendMessage(
            "Remember the word 'alpha'. Reply with only: ok, remembered.",
        );
        await chat.waitForAssistantMessage();
        await chat.waitForStreamingComplete();

        await app.sendMessage(
            "Now remember 'beta' too. Reply with only: ok, remembered.",
        );
        await chat.waitForAssistantMessage();
        await chat.waitForStreamingComplete();

        // ── Fork ──
        await sendWsMessage(page, { type: "fork_session" });

        // Wait for URL to update to forked session
        const currentPath = new URL(page.url()).pathname;
        await page.waitForFunction(
            (prevPath) => {
                const p = window.location.pathname;
                return p !== prevPath && /\/s\/ses_/.test(p);
            },
            currentPath,
            { timeout: 15_000 },
        );

        // ── Send message in forked session ──
        await app.sendMessage(
            "What words did I ask you to remember? Reply with just the words.",
        );

        // Wait for fork divider to appear
        const forkDivider = page.locator(".fork-divider");
        await forkDivider.waitFor({ state: "visible", timeout: 30_000 });

        // ── KEY ASSERTION: user message and assistant response appear AFTER fork divider ──
        // Strategy: use Playwright's page.evaluate to check DOM order.
        // The .fork-divider element separates inherited from current messages.
        // We verify that at least one .msg-user and one .msg-assistant appear
        // AFTER the .fork-divider in DOM order (i.e., they are siblings that
        // come later, not inside .fork-context-block).
        //
        // NOTE: We cannot use CSS :not(.fork-context-messages .msg-user) because
        // .fork-context-messages is only in the DOM when the block is expanded
        // (collapsed by default). Instead we check DOM sibling order.

        // Wait for assistant response to complete (proves the response rendered)
        await chat.waitForStreamingComplete(30_000);

        // Check that messages exist after the fork divider in DOM order
        const result = await page.evaluate(() => {
            const container = document.querySelector("#messages > div");
            if (!container) return { error: "no container" };

            const divider = container.querySelector(".fork-divider");
            if (!divider) return { error: "no fork-divider" };

            // Walk siblings after the divider
            let userAfter = 0;
            let assistantAfter = 0;
            let el = divider.nextElementSibling;
            while (el) {
                if (el.querySelector(".msg-user") || el.classList.contains("msg-container") && el.querySelector(".bubble")) {
                    userAfter++;
                }
                if (el.querySelector(".msg-assistant") || el.querySelector(".md-content")) {
                    assistantAfter++;
                }
                // Also check the element itself
                if (el.matches(".msg-container")) {
                    const user = el.querySelector(".msg-user");
                    const assistant = el.querySelector(".msg-assistant");
                    if (user) userAfter++;
                    if (assistant) assistantAfter++;
                }
                el = el.nextElementSibling;
            }
            return { userAfter, assistantAfter };
        });

        // Verify no errors
        expect(result).not.toHaveProperty("error");
        const { userAfter, assistantAfter } = result as { userAfter: number; assistantAfter: number };

        // At least one user message after the divider (the "What words" prompt)
        expect(userAfter).toBeGreaterThanOrEqual(1);
        // At least one assistant message after the divider (the response)
        expect(assistantAfter).toBeGreaterThanOrEqual(1);
    });
});
```

**Step 2: Register the spec in playwright config**

In `test/e2e/playwright-replay.config.ts`, add to the `testMatch` array:

```typescript
"fork-session-messages.spec.ts",
```

**Step 3: Run the E2E test to verify it fails (before fix is wired)**

Run: `pnpm test:e2e -- test/e2e/specs/fork-session-messages.spec.ts`
Expected: FAIL — the user message after the fork divider is inside the inherited block (currentUserCount = 0).

Note: This test will fail until Task 1-3 changes are in place AND the frontend build picks them up. If running with the fix already applied, it should pass.

**Step 4: Build frontend and re-run**

Run: `pnpm build:frontend && pnpm test:e2e -- test/e2e/specs/fork-session-messages.spec.ts`
Expected: PASS — the fork-session recording's REST fallback returns the full history with the fork-point message, the fork split succeeds, and the user message renders after the divider.

**Step 5: Run the full E2E and unit suites to confirm no regressions**

Run: `pnpm check && pnpm lint && pnpm test:unit && pnpm test:e2e`
Expected: ALL pass.

**Step 6: Commit**

```bash
git add test/e2e/specs/fork-session-messages.spec.ts test/e2e/playwright-replay.config.ts
git commit -m "test: E2E test proving fork session messages render after fork divider"
```

---

### Task 6: Verify existing fork-session E2E tests still pass

**Files:** None — verification only.

**Step 1: Run the existing fork tests**

Run: `pnpm test:e2e -- test/e2e/specs/fork-session.spec.ts`
Expected: ALL 3 existing fork tests pass (collapsible context, expanding inherited, SubagentBackBar hidden).

**Step 2: Run full default verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: ALL pass.
