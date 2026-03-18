# Session-Scoped Permission Requests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Session-scope permission requests so only the requesting session sees the interactive PermissionCard; other sessions see a notification with a link.

**Architecture:** Add required `sessionId` to the `permission_request` relay message at all type layers. The translator accepts an optional context with sessionId. The frontend holds one permission list and derives local/remote views via pure getters. A new `PermissionNotification` component renders an aggregated notification for remote permissions.

**Tech Stack:** TypeScript, Svelte 5, Vitest

---

### Task 1: Add `sessionId` to type definitions

**Files:**
- Modify: `src/lib/shared-types.ts:261-267`
- Modify: `src/lib/types.ts:124-130`
- Modify: `src/lib/frontend/types.ts:178-183`

**Step 1: Write failing tests**

No dedicated test for this — TypeScript compiler is the test. Adding `sessionId` as required will cause compile errors in code that constructs `permission_request` messages or `PendingPermission` objects without it. We'll fix those in subsequent tasks.

**Step 2: Add `sessionId` to `shared-types.ts` (relay protocol)**

In `src/lib/shared-types.ts`, change the `permission_request` union member:

```typescript
| {
      type: "permission_request";
      requestId: string;
      sessionId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId?: string;
  }
```

**Step 3: Add `sessionId` to `types.ts` (bridge storage)**

In `src/lib/types.ts`, change the `PendingPermission` interface:

```typescript
export interface PendingPermission {
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    always: string[];
    timestamp: number;
}
```

**Step 4: Add `sessionId` to `frontend/types.ts` (frontend)**

In `src/lib/frontend/types.ts`, change the `PermissionRequest` interface:

```typescript
export interface PermissionRequest {
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
    toolUseId?: string;
}
```

**Step 5: Run `pnpm build` to see all compile errors**

Run: `pnpm build`
Expected: Compile errors in event-translator.ts, permission-bridge.ts, client-init.ts, permissions.svelte.ts, and test files that construct these types without `sessionId`.

Do NOT fix them yet — we fix them task by task.

**Step 6: Commit**

```bash
git add src/lib/shared-types.ts src/lib/types.ts src/lib/frontend/types.ts
git commit -m "feat: add required sessionId to permission types (compile errors expected)"
```

---

### Task 2: Update `PermissionBridge` to store `sessionId`

**Files:**
- Modify: `src/lib/bridges/permission-bridge.ts`
- Modify: `test/unit/bridges/permission-bridge.pbt.test.ts`

**Step 1: Update existing tests to pass `sessionId` in events**

In `test/unit/bridges/permission-bridge.pbt.test.ts`, every test that creates a `permission.asked` event needs a `sessionID` property. Add a `sessionId` arbitrary and include it in all test events.

At the top, add an import and arbitrary:

```typescript
const sessionIdArb = fc.stringOf(fc.char(), { minLength: 1, maxLength: 20 });
```

Then in every test that calls `bridge.onPermissionRequest(event)`, change the event shape to include `sessionID`:

```typescript
const event: OpenCodeEvent = {
    type: "permission.asked",
    properties: { id, permission: toolName, sessionID: "test-session" },
};
```

For the recovery test (P8), update the `recoverPending` call to include `sessionId`:

```typescript
const unique = permissions.filter(
    (p, i) => permissions.findIndex((x) => x.id === p.id) === i,
).map(p => ({ ...p, sessionId: "recovered-session" }));
```

**Step 2: Run tests to verify they still fail (type errors)**

Run: `pnpm test -- test/unit/bridges/permission-bridge.pbt.test.ts`
Expected: Compile errors because `onPermissionRequest` doesn't accept/return `sessionId` yet.

**Step 3: Update `PermissionBridge` implementation**

In `src/lib/bridges/permission-bridge.ts`:

`onPermissionRequest` — extract `sessionID` from event properties and store it:

```typescript
onPermissionRequest(event: OpenCodeEvent): PendingPermission | null {
    const props = event.properties as {
        id?: string;
        permission?: string;
        sessionID?: string;
        patterns?: string[];
        metadata?: Record<string, unknown>;
        always?: string[];
    };

    if (!props.id || !props.permission) return null;

    const sessionId = typeof props.sessionID === "string" ? props.sessionID : "";

    if (this.alwaysAllowed.has(props.permission)) {
        return null;
    }

    const entry: PendingPermission = {
        requestId: props.id,
        sessionId,
        toolName: props.permission,
        toolInput: {
            patterns: props.patterns ?? [],
            metadata: props.metadata ?? {},
        },
        always: props.always ?? [],
        timestamp: this.now(),
    };

    this.pending.set(props.id, entry);
    return entry;
}
```

`recoverPending` — accept and store `sessionId`:

```typescript
recoverPending(
    permissions: Array<{
        id: string;
        permission: string;
        sessionId?: string;
        patterns?: string[];
        metadata?: Record<string, unknown>;
        always?: string[];
    }>,
): PendingPermission[] {
    const recovered: PendingPermission[] = [];
    for (const p of permissions) {
        const entry: PendingPermission = {
            requestId: p.id,
            sessionId: p.sessionId ?? "",
            toolName: p.permission,
            toolInput: {
                patterns: p.patterns ?? [],
                metadata: p.metadata ?? {},
            },
            always: p.always ?? [],
            timestamp: this.now(),
        };
        this.pending.set(p.id, entry);
        recovered.push(entry);
    }
    return recovered;
}
```

**Step 4: Run tests**

Run: `pnpm test -- test/unit/bridges/permission-bridge.pbt.test.ts`
Expected: All 10 properties PASS.

**Step 5: Add a new property test — P11: sessionId is preserved**

Add to `test/unit/bridges/permission-bridge.pbt.test.ts`:

```typescript
describe("P11: sessionId is stored and retrievable (session scoping)", () => {
    it("property: onPermissionRequest preserves sessionID from event", () => {
        fc.assert(
            fc.property(
                idString.filter((s) => s.length > 0),
                anyToolName,
                fc.stringOf(fc.char(), { minLength: 1, maxLength: 20 }),
                (id, toolName, sessionId) => {
                    const bridge = new PermissionBridge({ now: () => 1_000_000 });

                    const result = bridge.onPermissionRequest({
                        type: "permission.asked",
                        properties: { id, permission: toolName, sessionID: sessionId },
                    });

                    expect(result).not.toBeNull();
                    expect(result!.sessionId).toBe(sessionId);

                    const pending = bridge.getPending();
                    expect(pending[0]!.sessionId).toBe(sessionId);
                },
            ),
            { seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
        );
    });

    it("property: recoverPending preserves sessionId", () => {
        fc.assert(
            fc.property(
                idString.filter((s) => s.length > 0),
                anyToolName,
                fc.stringOf(fc.char(), { minLength: 1, maxLength: 20 }),
                (id, toolName, sessionId) => {
                    const bridge = new PermissionBridge({ now: () => 1_000_000 });

                    const recovered = bridge.recoverPending([
                        { id, permission: toolName, sessionId },
                    ]);

                    expect(recovered).toHaveLength(1);
                    expect(recovered[0]!.sessionId).toBe(sessionId);
                },
            ),
            { seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
        );
    });
});
```

**Step 6: Run tests**

Run: `pnpm test -- test/unit/bridges/permission-bridge.pbt.test.ts`
Expected: All PASS including P11.

**Step 7: Commit**

```bash
git add src/lib/bridges/permission-bridge.ts test/unit/bridges/permission-bridge.pbt.test.ts
git commit -m "feat: permission bridge stores sessionId on pending permissions"
```

---

### Task 3: Update event translator to include `sessionId`

**Files:**
- Modify: `src/lib/relay/event-translator.ts:213-228, 500-501, 586-592`
- Modify: `test/unit/relay/event-translator.pbt.test.ts`
- Modify: `test/unit/relay/event-translator-result.test.ts` (if needed)

**Step 1: Write failing test**

In `test/unit/relay/event-translator.pbt.test.ts`, find the existing `permission_request` property test (~line 480) and update it to verify `sessionId` is present:

```typescript
it("property: permission_request has requestId, sessionId, toolName, toolInput", () => {
    fc.assert(
        fc.property(permissionAskedEvent, fc.string({ minLength: 1 }), (event, sessionId) => {
            const result = translator.translate(event, { sessionId });
            const props = event.properties as { id?: string; permission?: string };
            if (props.id && props.permission) {
                expect(result.ok).toBe(true);
                if (result.ok) {
                    const msg = result.messages[0];
                    if (msg && msg.type === "permission_request") {
                        expect(msg.requestId).toBe(props.id);
                        expect(msg.sessionId).toBe(sessionId);
                        expect(msg.toolName).toBe(props.permission);
                    }
                }
            }
        }),
        { seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
    );
});
```

Add a new test: permission.asked without sessionId in context returns `ok: false`:

```typescript
it("property: permission_request without sessionId context returns ok: false", () => {
    fc.assert(
        fc.property(permissionAskedEvent, (event) => {
            const result = translator.translate(event); // no context
            const props = event.properties as { id?: string; permission?: string };
            if (props.id && props.permission) {
                expect(result.ok).toBe(false);
            }
        }),
        { seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
    );
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- test/unit/relay/event-translator.pbt.test.ts`
Expected: FAIL — translate() doesn't accept context, and permission_request lacks sessionId.

**Step 3: Update translator**

In `src/lib/relay/event-translator.ts`:

Add a context type:

```typescript
export interface TranslateContext {
    sessionId?: string;
}
```

Update the `Translator` interface:

```typescript
export interface Translator {
    translate(event: OpenCodeEvent, context?: TranslateContext): TranslateResult;
    reset(): void;
    getSeenParts(): ReadonlyMap<string, { type: PartType; status?: ToolStatus }>;
    rebuildStateFromHistory(
        messages: Array<{
            parts?: Array<{
                id: string;
                type: PartType;
                state?: { status?: ToolStatus };
            }>;
        }>,
    ): void;
}
```

Update `createTranslator()`:

```typescript
translate(event: OpenCodeEvent, context?: TranslateContext): TranslateResult {
    // ... existing code ...

    // Permission — at the permission.asked case:
    if (eventType === "permission.asked") {
        return wrapResult(
            translatePermission(event, context?.sessionId),
            context?.sessionId
                ? "permission asked: invalid event"
                : "permission asked: no sessionId in context",
        );
    }
```

Update `translatePermission`:

```typescript
export function translatePermission(
    event: OpenCodeEvent,
    sessionId: string | undefined,
): RelayMessage | null {
    if (!isPermissionAskedEvent(event)) return null;
    if (!sessionId) return null;
    const { properties: props } = event;

    return {
        type: "permission_request",
        requestId: props.id,
        sessionId,
        toolName: props.permission,
        toolInput: {
            patterns: props.patterns ?? [],
            metadata: props.metadata ?? {},
        },
        ...(props.tool?.callID ? { toolUseId: props.tool.callID } : {}),
    };
}
```

**Step 4: Run tests**

Run: `pnpm test -- test/unit/relay/event-translator.pbt.test.ts`
Expected: PASS (update any other tests that call translate() for permission events to pass context).

**Step 5: Commit**

```bash
git add src/lib/relay/event-translator.ts test/unit/relay/event-translator.pbt.test.ts
git commit -m "feat: translator accepts context with sessionId for permission events"
```

---

### Task 4: Update `sse-wiring.ts` to pass sessionId context

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts:192`
- Modify: `test/unit/relay/sse-wiring.test.ts`

**Step 1: Write failing test**

In `test/unit/relay/sse-wiring.test.ts`, find the test "routes permission.asked events to permissionBridge" (~line 337) and add/modify a test to verify the broadcast message includes sessionId:

```typescript
it("broadcasts permission_request with sessionId from event", () => {
    const event: OpenCodeEvent = {
        type: "permission.asked",
        properties: { id: "perm-1", permission: "Bash", sessionID: "sess-abc" },
    };
    handleSSEEvent(deps, event);
    
    // Find the broadcast call with permission_request
    const broadcastCalls = (deps.wsHandler.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const permMsg = broadcastCalls.find(
        ([msg]: [RelayMessage]) => msg.type === "permission_request",
    );
    expect(permMsg).toBeDefined();
    expect(permMsg![0].sessionId).toBe("sess-abc");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- test/unit/relay/sse-wiring.test.ts`
Expected: FAIL — sessionId not present on broadcast message.

**Step 3: Update sse-wiring.ts**

In `src/lib/relay/sse-wiring.ts`, change the `translator.translate(event)` call (~line 192) to pass context:

```typescript
const translateResult = translator.translate(event, { sessionId: eventSessionId });
```

That's the only change needed. The translator now includes `sessionId` in the `permission_request` message it produces.

**Step 4: Run tests**

Run: `pnpm test -- test/unit/relay/sse-wiring.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/relay/sse-wiring.ts test/unit/relay/sse-wiring.test.ts
git commit -m "feat: pass sessionId context to translator in SSE wiring"
```

---

### Task 5: Update `client-init.ts` to include `sessionId` in replayed permissions

**Files:**
- Modify: `src/lib/bridges/client-init.ts:173-180`
- Modify: `test/unit/bridges/client-init.test.ts`

**Step 1: Write failing test**

In `test/unit/bridges/client-init.test.ts`, find existing permission replay tests and add a test that verifies `sessionId` is included in replayed messages:

```typescript
it("replayed permission_request includes sessionId", async () => {
    // Setup a pending permission with sessionId in the bridge
    deps.permissionBridge.onPermissionRequest({
        type: "permission.asked",
        properties: { id: "perm-1", permission: "Bash", sessionID: "sess-xyz" },
    });
    
    await initializeClient(deps);
    
    const sentMessages = /* extract messages sent via wsHandler.sendTo */;
    const permMsg = sentMessages.find((m: RelayMessage) => m.type === "permission_request");
    expect(permMsg).toBeDefined();
    expect(permMsg!.sessionId).toBe("sess-xyz");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- test/unit/bridges/client-init.test.ts`
Expected: FAIL — sessionId not included in replayed message.

**Step 3: Update client-init.ts**

In `src/lib/bridges/client-init.ts`, update the permission replay loop (~line 173-180):

```typescript
for (const perm of permissionBridge.getPending()) {
    wsHandler.sendTo(clientId, {
        type: "permission_request",
        requestId: perm.requestId,
        sessionId: perm.sessionId,
        toolName: perm.toolName,
        toolInput: perm.toolInput,
    });
}
```

**Step 4: Run tests**

Run: `pnpm test -- test/unit/bridges/client-init.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/bridges/client-init.ts test/unit/bridges/client-init.test.ts
git commit -m "feat: include sessionId in replayed permission requests on client init"
```

---

### Task 6: Update frontend permissions store with derived getters

**Files:**
- Modify: `src/lib/frontend/stores/permissions.svelte.ts`
- Modify: `test/unit/stores/permissions-store.test.ts`

**Step 1: Write failing tests**

In `test/unit/stores/permissions-store.test.ts`, add tests for the new getters and update existing `handlePermissionRequest` tests to include `sessionId`:

```typescript
// Update existing test:
describe("handlePermissionRequest", () => {
    it("adds a permission request with sessionId", () => {
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r1",
            sessionId: "sess-1",
            toolName: "Write",
            toolInput: { path: "/foo/bar.ts" },
        });
        expect(permissionsState.pendingPermissions).toHaveLength(1);
        expect(permissionsState.pendingPermissions[0]!.sessionId).toBe("sess-1");
    });
});

// New tests:
describe("getLocalPermissions", () => {
    it("returns only permissions matching the current session", () => {
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r1",
            sessionId: "sess-1",
            toolName: "Write",
            toolInput: {},
        });
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r2",
            sessionId: "sess-2",
            toolName: "Bash",
            toolInput: {},
        });
        const local = getLocalPermissions("sess-1");
        expect(local).toHaveLength(1);
        expect(local[0]!.requestId).toBe("r1");
    });

    it("returns empty array when currentSessionId is null", () => {
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r1",
            sessionId: "sess-1",
            toolName: "Write",
            toolInput: {},
        });
        expect(getLocalPermissions(null)).toHaveLength(0);
    });
});

describe("getRemotePermissions", () => {
    it("returns only permissions NOT matching the current session", () => {
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r1",
            sessionId: "sess-1",
            toolName: "Write",
            toolInput: {},
        });
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r2",
            sessionId: "sess-2",
            toolName: "Bash",
            toolInput: {},
        });
        const remote = getRemotePermissions("sess-1");
        expect(remote).toHaveLength(1);
        expect(remote[0]!.requestId).toBe("r2");
    });

    it("returns all permissions when currentSessionId is null", () => {
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r1",
            sessionId: "sess-1",
            toolName: "Write",
            toolInput: {},
        });
        expect(getRemotePermissions(null)).toHaveLength(1);
    });
});

describe("session switch re-derives", () => {
    it("same permission list, different session → different local/remote split", () => {
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r1",
            sessionId: "sess-1",
            toolName: "Write",
            toolInput: {},
        });
        handlePermissionRequest({
            type: "permission_request",
            requestId: "r2",
            sessionId: "sess-2",
            toolName: "Bash",
            toolInput: {},
        });

        // Viewing sess-1: r1 is local, r2 is remote
        expect(getLocalPermissions("sess-1")).toHaveLength(1);
        expect(getRemotePermissions("sess-1")).toHaveLength(1);

        // Viewing sess-2: r2 is local, r1 is remote
        expect(getLocalPermissions("sess-2")).toHaveLength(1);
        expect(getRemotePermissions("sess-2")).toHaveLength(1);
        expect(getLocalPermissions("sess-2")[0]!.requestId).toBe("r2");
        expect(getRemotePermissions("sess-2")[0]!.requestId).toBe("r1");
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- test/unit/stores/permissions-store.test.ts`
Expected: FAIL — `getLocalPermissions` and `getRemotePermissions` don't exist yet. Also, existing tests that construct permission_request without sessionId will have type errors.

**Step 3: Update the store**

In `src/lib/frontend/stores/permissions.svelte.ts`:

Update `handlePermissionRequest` to destructure `sessionId`:

```typescript
export function handlePermissionRequest(
    msg: Extract<RelayMessage, { type: "permission_request" }>,
    sendFn?: (data: Record<string, unknown>) => void,
): void {
    const { requestId, sessionId, toolName, toolInput } = msg;

    if (!requestId || !toolName) return;

    if (permissionsState.alwaysAllowedTools.has(toolName)) {
        sendFn?.({
            type: "permission_response",
            requestId,
            decision: "allow",
        });
        return;
    }

    const permission: PermissionRequest & { id: string } = {
        id: requestId,
        requestId,
        sessionId,
        toolName,
        toolInput,
    };

    permissionsState.pendingPermissions = [
        ...permissionsState.pendingPermissions,
        permission,
    ];
}
```

Add the derived getters:

```typescript
/** Permissions for the session the user is currently viewing → full PermissionCard. */
export function getLocalPermissions(
    currentSessionId: string | null,
): (PermissionRequest & { id: string })[] {
    if (!currentSessionId) return [];
    return permissionsState.pendingPermissions.filter(
        (p) => p.sessionId === currentSessionId,
    );
}

/** Permissions for OTHER sessions → notification component. */
export function getRemotePermissions(
    currentSessionId: string | null,
): (PermissionRequest & { id: string })[] {
    if (!currentSessionId) return permissionsState.pendingPermissions;
    return permissionsState.pendingPermissions.filter(
        (p) => p.sessionId !== currentSessionId,
    );
}
```

**Step 4: Fix all existing tests** that construct `permission_request` messages without `sessionId`. Add `sessionId: "test-session"` to every test that creates such a message.

**Step 5: Run tests**

Run: `pnpm test -- test/unit/stores/permissions-store.test.ts`
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/lib/frontend/stores/permissions.svelte.ts test/unit/stores/permissions-store.test.ts
git commit -m "feat: add getLocalPermissions and getRemotePermissions derived getters"
```

---

### Task 7: Update `MessageList.svelte` to use local permissions

**Files:**
- Modify: `src/lib/frontend/components/chat/MessageList.svelte:16, 66, 200`

**Step 1: Update imports**

Add import of `getLocalPermissions` from the permissions store and `sessionState` (already imported).

```typescript
import { permissionsState, getLocalPermissions } from "../../stores/permissions.svelte.js";
```

**Step 2: Replace direct array access with derived getter**

Change the `{#each}` block (~line 200) from:

```svelte
{#each permissionsState.pendingPermissions as perm (perm.id)}
```

to:

```svelte
{#each localPermissions as perm (perm.id)}
```

Add the derived variable in the `<script>` block:

```typescript
const localPermissions = $derived(getLocalPermissions(sessionState.currentId));
```

**Step 3: Update auto-scroll tracking**

Around line 66, the scroll tracking currently watches `permissionsState.pendingPermissions.length`. Change to watch `localPermissions.length` instead (or keep watching the full list — both local and remote trigger scrolls, which is fine for the requesting session).

**Step 4: Run `pnpm build` to verify no type errors**

Run: `pnpm build`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/frontend/components/chat/MessageList.svelte
git commit -m "feat: MessageList renders only local-session permission cards"
```

---

### Task 8: Create `PermissionNotification.svelte` component

**Files:**
- Create: `src/lib/frontend/components/features/PermissionNotification.svelte`

**Step 1: Create the component**

```svelte
<!-- ─── Permission Notification ───────────────────────────────────────────── -->
<!-- Aggregated notification for permission requests in OTHER sessions.        -->
<!-- Shows session count + clickable session titles. Fixed top-right.          -->

<script lang="ts">
    import { getRemotePermissions } from "../../stores/permissions.svelte.js";
    import { sessionState } from "../../stores/session.svelte.js";
    import { getCurrentSlug, navigate } from "../../stores/router.svelte.js";

    const remotePermissions = $derived(getRemotePermissions(sessionState.currentId));

    /** Group remote permissions by sessionId. */
    const sessionGroups = $derived.by(() => {
        const groups = new Map<string, number>();
        for (const perm of remotePermissions) {
            groups.set(perm.sessionId, (groups.get(perm.sessionId) ?? 0) + 1);
        }
        return groups;
    });

    const sessionCount = $derived(sessionGroups.size);
    const hasRemote = $derived(remotePermissions.length > 0);

    function getSessionTitle(sessionId: string): string {
        const session = sessionState.sessions.find((s) => s.id === sessionId);
        return session?.title ?? sessionId.slice(0, 8) + "\u2026";
    }

    function goToSession(sessionId: string) {
        const slug = getCurrentSlug();
        if (slug) {
            navigate(`/p/${slug}/s/${sessionId}`);
        }
    }
</script>

{#if hasRemote}
    <div
        class="fixed top-16 right-4 z-[350] max-w-[320px] animate-[slideInRight_200ms_ease-out_both]"
        role="status"
        aria-live="polite"
    >
        <div class="bg-bg-alt border border-border rounded-xl p-3 shadow-lg">
            <div class="text-[13px] font-medium mb-2 text-text">
                {sessionCount === 1 ? "1 session" : `${sessionCount} sessions`} need{sessionCount === 1 ? "s" : ""} permission
            </div>
            <div class="flex flex-col gap-1.5">
                {#each [...sessionGroups] as [sessionId, count] (sessionId)}
                    <button
                        class="text-left text-xs text-accent hover:text-accent/80 hover:underline cursor-pointer truncate px-1 py-0.5 rounded transition-colors"
                        onclick={() => goToSession(sessionId)}
                    >
                        {getSessionTitle(sessionId)}{count > 1 ? ` (${count})` : ""}
                    </button>
                {/each}
            </div>
        </div>
    </div>
{/if}

<style>
    @keyframes slideInRight {
        from {
            opacity: 0;
            transform: translateX(16px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }
</style>
```

**Step 2: Run `pnpm build` to verify no type errors**

Run: `pnpm build`
Expected: PASS (component compiles but isn't mounted yet).

**Step 3: Commit**

```bash
git add src/lib/frontend/components/features/PermissionNotification.svelte
git commit -m "feat: add PermissionNotification component for remote session permissions"
```

---

### Task 9: Mount `PermissionNotification` in `ChatLayout.svelte`

**Files:**
- Modify: `src/lib/frontend/components/layout/ChatLayout.svelte`

**Step 1: Import and mount**

In `ChatLayout.svelte`, import the component:

```typescript
import PermissionNotification from "../features/PermissionNotification.svelte";
```

Add it to the template, at the top level (not inside MessageList). Place it after the header/before the main content area so it overlays correctly:

```svelte
<PermissionNotification />
```

**Step 2: Run `pnpm build` to verify**

Run: `pnpm build`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/lib/frontend/components/layout/ChatLayout.svelte
git commit -m "feat: mount PermissionNotification in ChatLayout"
```

---

### Task 10: Fix remaining test compilation errors and run full suite

**Files:**
- Modify: Various test files that construct `permission_request` messages or `PendingPermission` objects

**Step 1: Run full build**

Run: `pnpm build`
Expected: Should PASS if all source files are updated. If there are remaining errors, fix them.

**Step 2: Run full test suite**

Run: `pnpm test`

Fix any test failures. Common fixes:
- Add `sessionId: "test-session"` to any test that constructs `permission_request` messages
- Add `sessionId: "test-session"` to any test that constructs `PendingPermission` objects
- Update SSE wiring tests that verify `translate()` calls for permission events

Files likely needing updates:
- `test/unit/relay/sse-wiring.test.ts` — permission broadcast tests
- `test/unit/relay/event-translator-result.test.ts` — if it tests permission translation
- `test/unit/relay/event-pipeline.test.ts` — if it constructs permission events
- `test/unit/relay/regression-server-cache-pipeline.test.ts` — permission event handling
- `test/unit/bridges/client-init.test.ts` — permission replay
- `test/unit/relay/per-tab-routing-e2e.test.ts` — if it tests permissions

**Step 3: Run full test suite again**

Run: `pnpm test`
Expected: ALL PASS.

**Step 4: Commit**

```bash
git add -A
git commit -m "fix: update all tests to include sessionId in permission types"
```

---

### Task 11: Final verification

**Step 1: Clean build**

Run: `pnpm build`
Expected: PASS, no type errors.

**Step 2: Full unit tests**

Run: `pnpm test`
Expected: ALL PASS.

**Step 3: Lint**

Run: `pnpm lint`
Expected: PASS.

**Step 4: Squash into feature commit (optional)**

If desired, squash the intermediate commits into a single feature commit:

```bash
git rebase -i HEAD~11
# squash all into first commit
# message: "feat: session-scope permission requests with notification for remote sessions"
```
