# Notification Session Navigation Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Clicking push notifications (phone/desktop) and browser notifications should navigate the user to the specific session that triggered the notification.

**Architecture:** Thread `sessionId` and `slug` from existing relay context through the push notification pipeline into payloads. Update the SW click handler to navigate to `/p/<slug>/s/<sessionId>`. Update browser notification click handlers to navigate via `switchToSession()`. Add `sessionId` to cross-session `notification_event` broadcasts.

**Tech Stack:** TypeScript, Web Push API, Service Workers, Svelte 5

---

### Task 1: Add `slug` to `SSEWiringDeps` and `sendPushForEvent()`

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts:59-126` (SSEWiringDeps interface, PushSender interface, sendPushForEvent)
- Modify: `src/lib/relay/relay-stack.ts:492-511` (wireSSEConsumer call - add slug to deps)
- Test: `test/unit/relay/sse-wiring.test.ts`
- Test: `test/helpers/mock-factories.ts`

**Step 1: Write failing tests**

In `test/unit/relay/sse-wiring.test.ts`, update the existing push notification tests to verify `slug` and `sessionId` are included in the push payload:

```typescript
// In the existing "sends push notification for permission.asked" test:
it("sends push notification for permission.asked with slug and sessionId", () => {
    const mockPush = {
        sendToAll: vi.fn().mockResolvedValue(undefined),
    } as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
    const deps = createMockSSEWiringDeps({ pushManager: mockPush, slug: "my-project" });
    vi.mocked(deps.permissionBridge.onPermissionRequest).mockReturnValue({
        requestId: pid("perm-1"),
        sessionId: "sess-abc",
        toolName: "Bash",
        toolInput: {},
        always: [],
        timestamp: Date.now(),
    });

    const event: OpenCodeEvent = {
        type: "permission.asked",
        properties: { id: "perm-1", permission: "Bash" },
    };
    handleSSEEvent(deps, event);

    expect(mockPush.sendToAll).toHaveBeenCalledWith(
        expect.objectContaining({
            type: "permission_request",
            slug: "my-project",
            sessionId: "sess-abc",
        }),
    );
});
```

Add similar tests for `question.asked` and `done`/`error` events verifying slug and sessionId are included.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/sse-wiring.test.ts`
Expected: FAIL — `slug` and `sessionId` not present in push payload.

**Step 3: Implement changes**

In `src/lib/relay/sse-wiring.ts`:

1. Add `slug` to `SSEWiringDeps`:
```typescript
export interface SSEWiringDeps {
    // ... existing fields ...
    /** Project slug for notification routing */
    slug?: string;
}
```

2. Add `slug` and `sessionId` params to `sendPushForEvent()`:
```typescript
export function sendPushForEvent(
    pushManager: PushSender,
    msg: RelayMessage,
    log: Logger,
    context?: { slug?: string; sessionId?: string },
): void {
    const content = notificationContent(msg);
    if (!content) return;
    pushManager
        .sendToAll({
            type: msg.type,
            ...content,
            ...(context?.slug != null && { slug: context.slug }),
            ...(context?.sessionId != null && { sessionId: context.sessionId }),
        })
        .catch((err: unknown) =>
            log.warn(`Push send failed (${msg.type}): ${err}`),
        );
}
```

3. Update all call sites in `sse-wiring.ts` to pass context:

- Line 172-174 (permission.asked with bridge data):
  ```typescript
  sendPushForEvent(pushManager, permMsg, log, {
      slug: deps.slug,
      sessionId: pending.sessionId,
  });
  ```

- Line 183-194 (permission.asked fallback):
  ```typescript
  sendPushForEvent(pushManager, { ... }, log, {
      slug: deps.slug,
      sessionId: eventSessionId,
  });
  ```

- Line 202-208 (question.asked):
  ```typescript
  sendPushForEvent(pushManager, { type: "ask_user", toolId: "", questions: [] }, log, {
      slug: deps.slug,
      sessionId: eventSessionId,
  });
  ```

- Line 324-326 (pipeline done/error):
  ```typescript
  sendPushForEvent(pushManager, msg, log, {
      slug: deps.slug,
      sessionId: targetSessionId,
  });
  ```

4. In `src/lib/relay/relay-stack.ts`, add `slug` to the wireSSEConsumer deps (line ~502):
```typescript
wireSSEConsumer(
    {
        // ... existing deps ...
        slug: config.slug,
    },
    sseConsumer,
);
```

5. Update the two `sendPushForEvent` calls in `relay-stack.ts`:

- Line 557 (status poller done):
  ```typescript
  sendPushForEvent(config.pushManager, doneMsg, sseLog, {
      slug: config.slug,
      sessionId,
  });
  ```

- Line 691 (message poller):
  ```typescript
  sendPushForEvent(config.pushManager, msg, pollerLog, {
      slug: config.slug,
      sessionId: polledSessionId ?? undefined,
  });
  ```

6. Update `test/helpers/mock-factories.ts` `createMockSSEWiringDeps()` to accept and pass through `slug`:
```typescript
export function createMockSSEWiringDeps(
    overrides?: Partial<SSEWiringDeps>,
): SSEWiringDeps {
    return {
        // ... existing fields ...
        slug: "test-project",
        ...overrides,
    };
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/sse-wiring.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/relay/sse-wiring.ts src/lib/relay/relay-stack.ts test/
git commit -m "feat: thread slug and sessionId into push notification payloads"
```

---

### Task 2: Add `sessionId` to `notification_event` and `notification-policy.ts`

**Files:**
- Modify: `src/lib/shared-types.ts:433-439` (notification_event type)
- Modify: `src/lib/relay/notification-policy.ts` (resolveNotifications)
- Modify: `src/lib/relay/sse-wiring.ts:330-337` (notification_event broadcast)
- Modify: `src/lib/relay/relay-stack.ts:700-709` (notification_event broadcast)
- Test: `test/unit/relay/sse-wiring.test.ts`
- Test: `test/unit/relay/notification-policy.test.ts` (if exists)

**Step 1: Write failing tests**

In `test/unit/relay/sse-wiring.test.ts`, update the cross-session notification tests:

```typescript
it("broadcasts notification_event with sessionId when done is dropped", () => {
    const deps = createMockSSEWiringDeps();
    vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
    const translated: RelayMessage = { type: "done", code: 0 };
    vi.mocked(deps.translator.translate).mockReturnValue({
        ok: true,
        messages: [translated],
    });

    const event: OpenCodeEvent = {
        type: "session.status",
        properties: { sessionID: "other-session" },
    };
    handleSSEEvent(deps, event);

    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
        type: "notification_event",
        eventType: "done",
        sessionId: "other-session",
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/sse-wiring.test.ts`
Expected: FAIL — `sessionId` not present.

**Step 3: Implement changes**

1. In `src/lib/shared-types.ts`, add `sessionId` to `notification_event`:
```typescript
| {
    type: "notification_event";
    eventType: string;
    message?: string;
    sessionId?: string;
}
```

2. In `src/lib/relay/notification-policy.ts`, update `resolveNotifications` to accept and include `sessionId`:
```typescript
export function resolveNotifications(
    msg: RelayMessage,
    route: RouteDecision,
    isSubagent: boolean,
    sessionId?: string,
): NotificationResolution {
    // ... existing logic ...
    if (broadcastCrossSession) {
        const payload: NotificationResolution["crossSessionPayload"] = {
            type: "notification_event",
            eventType: msg.type,
            ...(errorMessage !== undefined ? { message: errorMessage } : {}),
            ...(sessionId != null ? { sessionId } : {}),
        };
        return { sendPush, broadcastCrossSession, crossSessionPayload: payload };
    }
    // ...
}
```

Also update the `crossSessionPayload` type to include `sessionId?`.

3. In `src/lib/relay/sse-wiring.ts` (line ~332), add `sessionId` to the `notification_event` broadcast:
```typescript
wsHandler.broadcast({
    type: "notification_event",
    eventType: msg.type,
    ...(msg.type === "error" ? { message: msg.message } : {}),
    ...(targetSessionId != null ? { sessionId: targetSessionId } : {}),
});
```

4. In `src/lib/relay/relay-stack.ts` (line ~700), add `sessionId` to the message poller `notification_event`:
```typescript
wsHandler.broadcast({
    type: "notification_event",
    eventType: msg.type,
    ...(msg.type === "error" ? { message: ... } : {}),
    ...(polledSessionId != null ? { sessionId: polledSessionId } : {}),
});
```

5. Update the status poller `resolveNotifications` call (relay-stack.ts ~551) to pass `sessionId`:
```typescript
const notification = resolveNotifications(
    doneMsg,
    doneResult.route,
    isSubagent,
    sessionId,
);
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/sse-wiring.test.ts test/unit/relay/notification-policy.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/shared-types.ts src/lib/relay/notification-policy.ts src/lib/relay/sse-wiring.ts src/lib/relay/relay-stack.ts test/
git commit -m "feat: include sessionId in notification_event broadcasts"
```

---

### Task 3: Update SW click handler to navigate to session

**Files:**
- Modify: `src/lib/frontend/sw.ts:31-39,86-116` (PushPayload interface, notificationclick handler)
- Test: `test/unit/frontend/sw.test.ts` (create if needed)

**Step 1: Write failing test**

Create or update `test/unit/frontend/sw.test.ts` to verify the click handler builds the correct URL:

Since the SW uses `self.clients.matchAll()` which is hard to test in Vitest, the best approach is to test the URL construction logic. Extract the URL construction into a testable function or verify the SW integration via the existing push test infrastructure.

If no SW unit tests exist, the simplest approach is to verify the URL construction logic manually and test via the E2E test infrastructure or visual inspection. The SW change is small and mechanical.

**Step 2: Implement changes**

In `src/lib/frontend/sw.ts`:

1. Add `sessionId` to the `PushPayload` interface:
```typescript
interface PushPayload {
    type?: string;
    title?: string;
    body?: string;
    tag?: string;
    url?: string;
    requestId?: PermissionId;
    slug?: string;
    sessionId?: string;
}
```

2. Update the `notificationclick` handler URL construction:
```typescript
self.addEventListener("notificationclick", (event: NotificationEvent) => {
    const data: PushPayload = event.notification.data ?? {};
    event.notification.close();

    const baseUrl = self.registration.scope || "/";

    // Build target URL with session specificity when available
    let targetUrl: string;
    if (data.url) {
        targetUrl = data.url;
    } else if (data.slug && data.sessionId) {
        targetUrl = `${baseUrl}p/${data.slug}/s/${data.sessionId}`;
    } else if (data.slug) {
        targetUrl = `${baseUrl}p/${data.slug}/`;
    } else {
        targetUrl = baseUrl;
    }

    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then((clientList) => {
                // Prefer a client already on this project
                const projectPrefix = data.slug ? `${baseUrl}p/${data.slug}/` : null;

                // First: client already on the exact URL
                for (const client of clientList) {
                    if (client.url.includes(targetUrl)) {
                        return client.focus();
                    }
                }
                // Second: client on the same project — navigate it to the session
                if (projectPrefix) {
                    for (const client of clientList) {
                        if (client.url.includes(projectPrefix)) {
                            client.postMessage({
                                type: "navigate_to_session",
                                sessionId: data.sessionId,
                                slug: data.slug,
                            });
                            return client.focus();
                        }
                    }
                }
                // Third: any visible client — navigate it
                for (const client of clientList) {
                    if (client.visibilityState !== "hidden") {
                        client.postMessage({
                            type: "navigate_to_session",
                            sessionId: data.sessionId,
                            slug: data.slug,
                        });
                        return client.focus();
                    }
                }
                // Fourth: any client
                if (clientList.length > 0) {
                    clientList[0].postMessage({
                        type: "navigate_to_session",
                        sessionId: data.sessionId,
                        slug: data.slug,
                    });
                    return clientList[0].focus();
                }
                // Last: open new window
                return self.clients.openWindow(targetUrl);
            }),
    );
});
```

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/frontend/sw.ts
git commit -m "feat: SW click handler navigates to session URL"
```

---

### Task 4: Handle SW `navigate_to_session` postMessage in the frontend

**Files:**
- Modify: `src/lib/frontend/stores/ws.svelte.ts` or `src/lib/frontend/App.svelte` (wherever global message listeners live)
- Modify: `src/lib/frontend/stores/session.svelte.ts` (may need to export `switchToSession`)

**Step 1: Identify where to add the listener**

Search for existing `navigator.serviceWorker` or `message` event listeners in the frontend to find the right place to add the SW message handler.

**Step 2: Implement the listener**

Add a service worker message listener that handles `navigate_to_session`:

```typescript
// In the appropriate initialization file
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "navigate_to_session") {
            const { sessionId, slug } = event.data;
            if (sessionId && slug) {
                // Navigate to the session using the existing switchToSession or URL nav
                const currentSlug = getCurrentSlug();
                if (currentSlug === slug) {
                    switchToSession(sessionId, wsSend);
                } else {
                    navigate(`/p/${slug}/s/${sessionId}`);
                }
            }
        }
    });
}
```

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/frontend/
git commit -m "feat: handle SW navigate_to_session for notification click routing"
```

---

### Task 5: Update browser notification click handler to navigate to session

**Files:**
- Modify: `src/lib/frontend/stores/ws-notifications.ts:47-81` (triggerNotifications)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:398-403` (notification_event handling)
- Test: `test/unit/frontend/dispatch-notifications.test.ts`

**Step 1: Write failing test**

Update `test/unit/frontend/dispatch-notifications.test.ts` to verify that `notification_event` with `sessionId` passes the sessionId through to triggerNotifications:

```typescript
it("passes sessionId through notification_event to triggerNotifications", () => {
    handleMessage({
        type: "notification_event",
        eventType: "done",
        sessionId: "sess-123",
    });
    expect(triggerNotificationsMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "done", sessionId: "sess-123" }),
    );
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/frontend/dispatch-notifications.test.ts`
Expected: FAIL — `sessionId` not present.

**Step 3: Implement changes**

1. In `src/lib/frontend/stores/ws-dispatch.ts` (line ~398), pass `sessionId` through:
```typescript
case "notification_event":
    triggerNotifications({
        type: msg.eventType,
        ...(msg.message != null ? { message: msg.message } : {}),
        ...(msg.sessionId != null ? { sessionId: msg.sessionId } : {}),
    } as RelayMessage);
    break;
```

2. In `src/lib/frontend/stores/ws-notifications.ts`, update `triggerNotifications()` to use sessionId for browser notification click navigation:

```typescript
export function triggerNotifications(msg: RelayMessage): void {
    if (!NOTIF_TYPES.has(msg.type)) return;

    const settings = getNotifSettings();

    if (settings.sound) {
        playDoneSound();
    }

    if (settings.browser && !_pushActive) {
        const content = notificationContent(msg);
        if (
            content &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
        ) {
            try {
                // Extract sessionId from the message if available
                const sessionId = "sessionId" in msg ? (msg as { sessionId?: string }).sessionId : undefined;

                const n = new Notification(content.title, {
                    body: content.body,
                    tag: content.tag,
                });
                n.onclick = () => {
                    window.focus();
                    if (sessionId) {
                        // Navigate to the session that triggered the notification
                        window.dispatchEvent(
                            new CustomEvent("conduit:navigate-session", {
                                detail: { sessionId },
                            }),
                        );
                    }
                    n.close();
                };
                setTimeout(() => n.close(), NOTIFICATION_DISMISS_MS);
            } catch {
                // Non-fatal
            }
        }
    }
}
```

Then add a listener in the same initialization code from Task 4 that handles `conduit:navigate-session` custom events and calls `switchToSession()`.

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/frontend/dispatch-notifications.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/stores/ test/
git commit -m "feat: browser notification click navigates to session"
```

---

### Task 6: Full verification

**Step 1: Run type checker**

Run: `pnpm check`
Expected: PASS

**Step 2: Run linter**

Run: `pnpm lint`
Expected: PASS (or auto-fixable warnings)

**Step 3: Run full unit test suite**

Run: `pnpm test:unit`
Expected: All tests pass, no regressions.

**Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address lint/type issues from notification session nav"
```
