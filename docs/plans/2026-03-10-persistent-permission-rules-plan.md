# Persistent Permission Rules Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist "Always Allow" permission decisions to `opencode.jsonc` via `PATCH /config`, removing the in-memory caches from both the relay's `PermissionBridge` and the frontend's permissions store.

**Architecture:** When the user clicks "Always Allow" on a permission card, the relay replies `"always"` to OpenCode (existing behavior) and additionally calls `PATCH /config` to write the rule to `opencode.jsonc`. The PermissionCard expands to let the user choose tool-level or pattern-level scope. The in-memory `alwaysAllowed` / `alwaysAllowedTools` sets are removed entirely.

**Tech Stack:** TypeScript, Vitest, fast-check (PBT), Svelte 5, Playwright

**Design doc:** `docs/plans/2026-03-10-persistent-permission-rules-design.md`

---

### Task 1: Remove `alwaysAllowed` from PermissionBridge (server-side)

**Files:**
- Modify: `src/lib/bridges/permission-bridge.ts`
- Modify: `test/unit/bridges/permission-bridge.pbt.test.ts`
- Modify: `test/unit/bridges/permission-bridge.stateful.test.ts`
- Modify: `test/helpers/mock-factories.ts`

**Step 1: Update the PBT tests**

In `test/unit/bridges/permission-bridge.pbt.test.ts`, find property P6 ("allow_always adds tool to auto-approve set", around line 173). This test verifies that after an `allow_always` response, a second `onPermissionRequest` for the same tool returns `null`. **Rewrite P6** to verify that after an `allow_always` response, `onPermissionResponse` still returns `{ mapped: "always", toolName }` but `onPermissionRequest` for the same tool now returns a **new PendingPermission** (not `null`):

```typescript
describe("P6: allow_always still maps correctly but does not auto-approve (design change)", () => {
    it("property: allow_always maps to 'always' in response", () => {
        fc.assert(
            fc.property(permissionAskedEvent, (event) => {
                const bridge = new PermissionBridge();
                const pending = bridge.onPermissionRequest(event);
                if (!pending) return; // skip malformed

                const result = bridge.onPermissionResponse(
                    pending.requestId,
                    "allow_always",
                );
                expect(result).not.toBeNull();
                expect(result!.mapped).toBe("always");
                expect(result!.toolName).toBe(pending.toolName);
            }),
            { seed: 42, numRuns: 300, endOnFailure: true },
        );
    });

    it("property: same tool is NOT auto-approved on second request (no in-memory cache)", () => {
        fc.assert(
            fc.property(permissionAskedEvent, idString, (event, newId) => {
                const bridge = new PermissionBridge();
                const pending = bridge.onPermissionRequest(event);
                if (!pending) return;

                bridge.onPermissionResponse(pending.requestId, "allow_always");

                // Create a second event for the same tool with a different ID
                const secondEvent = {
                    ...event,
                    properties: {
                        ...(event.properties as Record<string, unknown>),
                        id: `per_${newId}`,
                    },
                };
                const secondPending = bridge.onPermissionRequest(secondEvent);
                // Should NOT be null — no auto-approve cache
                if (newId && newId.length > 0) {
                    expect(secondPending).not.toBeNull();
                }
            }),
            { seed: 42, numRuns: 300, endOnFailure: true },
        );
    });
});
```

**Step 2: Update the stateful model test**

In `test/unit/bridges/permission-bridge.stateful.test.ts`, remove:
- The `ClearAlwaysCommand` class
- The `alwaysAllowed: Set<string>` from the model
- Any model logic that checks the always-allowed set in `AddPermissionCommand.check()` / `RespondPermissionCommand.check()`

The model should now be just: `{ pending: Map<string, { toolName, timestamp }> }`.

**Step 3: Update mock factories**

In `test/helpers/mock-factories.ts`, remove from `createMockPermissionBridge()` (around line 109):
- `isAlwaysAllowed: vi.fn().mockReturnValue(false),`
- `clearAlwaysAllowed: vi.fn(),`

**Step 4: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/bridges/ --reporter=verbose`

Expected: Tests fail because `PermissionBridge` still has `alwaysAllowed`.

**Step 5: Update PermissionBridge implementation**

In `src/lib/bridges/permission-bridge.ts`:
- Remove `private alwaysAllowed: Set<string> = new Set();` (line 43)
- Remove the auto-approve check in `onPermissionRequest()` (lines 65-68)
- Remove `isAlwaysAllowed()` method (lines 116-119)
- Remove `clearAlwaysAllowed()` method (lines 122-124)
- Remove the "Track always decisions" block in `onPermissionResponse()` (lines 97-100) — the method still maps the decision, just doesn't cache it

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/bridges/ --reporter=verbose`

Expected: All pass.

**Step 7: Commit**

```
feat(permissions): remove in-memory alwaysAllowed from PermissionBridge

Config-driven persistence replaces the session-scoped in-memory cache.
The bridge still maps "allow_always" → "always" for the OpenCode reply
but no longer silently auto-approves subsequent requests.
```

---

### Task 2: Forward `always` field through the event translator

**Files:**
- Modify: `src/lib/shared-types.ts:261-268`
- Modify: `src/lib/relay/event-translator.ts:213-233`
- Modify: `test/unit/relay/event-translator.pbt.test.ts` (P8, around line 479)

**Step 1: Update the translator PBT test**

In `test/unit/relay/event-translator.pbt.test.ts`, find P8 ("permission_request has requestId, toolName, toolInput, sessionId"). Add an assertion that the translated message includes the `always` field:

```typescript
// Inside the existing fc.property callback:
expect(result!.always).toEqual(
    (event.properties as Record<string, unknown>).always ?? [],
);
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/event-translator.pbt.test.ts --reporter=verbose`

Expected: Fails — `result.always` is undefined.

**Step 3: Update shared-types.ts**

In `src/lib/shared-types.ts`, find the `permission_request` message type (lines 261-268). Add `always`:

```typescript
| {
      type: "permission_request";
      sessionId: string;
      requestId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId?: string;
      always?: string[];  // Suggested patterns for "always" auto-approval scope
  }
```

**Step 4: Update translatePermission()**

In `src/lib/relay/event-translator.ts`, update `translatePermission()` (lines 222-232):

```typescript
return {
    type: "permission_request",
    sessionId,
    requestId: props.id,
    toolName: props.permission,
    toolInput: {
        patterns: props.patterns ?? [],
        metadata: props.metadata ?? {},
    },
    always: props.always ?? [],
    ...(props.tool?.callID ? { toolUseId: props.tool.callID } : {}),
};
```

Note: `props.always` is already read in `permission-bridge.ts:60,78` from the SSE event, so the type is available. The translator accesses `event.properties` which includes `always` per the `PermissionAskedEvent` interface — but that interface at `opencode-events.ts:144-150` doesn't declare `always`. Add it:

In `src/lib/relay/opencode-events.ts`, update `PermissionAskedEvent`:

```typescript
export interface PermissionAskedEvent extends OpenCodeEvent {
    type: "permission.asked";
    properties: {
        id: string;
        permission: string;
        patterns?: string[];
        metadata?: Record<string, unknown>;
        always?: string[];   // NEW
        tool?: { callID?: string };
    };
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/event-translator.pbt.test.ts --reporter=verbose`

Expected: Pass.

**Step 6: Commit**

```
feat(permissions): forward 'always' patterns field to frontend

The SSE event's 'always' field (suggested auto-approval patterns) is
now included in the translated permission_request WebSocket message,
enabling the frontend to offer tool-level vs pattern-level scope.
```

---

### Task 3: Add `always` to frontend PermissionRequest type

**Files:**
- Modify: `src/lib/frontend/types.ts:178-184`
- Modify: `test/unit/stores/permissions-store.test.ts`

**Step 1: Update frontend type**

In `src/lib/frontend/types.ts`, add `always` to `PermissionRequest`:

```typescript
export interface PermissionRequest {
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
    toolUseId?: string;
    always?: string[];  // NEW — suggested patterns for "always" scope
}
```

**Step 2: Add a store test for the always field passthrough**

In `test/unit/stores/permissions-store.test.ts`, add a test in the `handlePermissionRequest` describe block:

```typescript
it("preserves the always field from the message", () => {
    handlePermissionRequest({
        type: "permission_request",
        sessionId: "ses-1",
        requestId: "r1",
        toolName: "bash",
        toolInput: { command: "git status" },
        always: ["git *"],
    });
    expect(permissionsState.pendingPermissions).toHaveLength(1);
    expect(permissionsState.pendingPermissions[0]!.always).toEqual(["git *"]);
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/unit/stores/permissions-store.test.ts --reporter=verbose`

Expected: Fails — the store doesn't pass through `always`.

**Step 4: Update the permissions store**

In `src/lib/frontend/stores/permissions.svelte.ts`, update `handlePermissionRequest()` to include `always` when constructing the permission object. Around line 121:

```typescript
const permission: PermissionRequest & { id: string } = {
    id: requestId,
    requestId,
    sessionId: msg.sessionId,
    toolName,
    toolInput,
    always: msg.always,
};
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/stores/permissions-store.test.ts --reporter=verbose`

Expected: Pass.

**Step 6: Commit**

```
feat(permissions): add 'always' field to frontend PermissionRequest type
```

---

### Task 4: Remove `alwaysAllowedTools` from frontend store

**Files:**
- Modify: `src/lib/frontend/stores/permissions.svelte.ts`
- Modify: `test/unit/stores/permissions-store.test.ts`
- Modify: `src/lib/frontend/components/layout/ChatLayout.svelte`

**Step 1: Update the store tests**

In `test/unit/stores/permissions-store.test.ts`:

1. **Remove** the `alwaysAllowTool` import (line 4) and the entire `alwaysAllowTool` describe block (lines 458-471).

2. **Rewrite** the "auto-approves already-allowed tools" test (line 252) to verify that permission requests are **always added to pending** (no auto-approve):

```typescript
it("always adds to pending (no in-memory auto-approve)", () => {
    handlePermissionRequest(
        {
            type: "permission_request",
            sessionId: "ses-1",
            requestId: "r1",
            toolName: "Write",
            toolInput: {},
        },
    );
    // Should always be added to pending — no auto-approve cache
    expect(permissionsState.pendingPermissions).toHaveLength(1);
});
```

3. **Remove** the "auto-approval does nothing without sendFn" test (line 273).

4. **Remove** `permissionsState.alwaysAllowedTools = new Set<string>();` from the `beforeEach` (line 40).

5. **Update** the `clearAll` test to not reference `alwaysAllowedTools`.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/stores/permissions-store.test.ts --reporter=verbose`

Expected: Fails — `alwaysAllowTool` still exported, store still has `alwaysAllowedTools`.

**Step 3: Update the permissions store**

In `src/lib/frontend/stores/permissions.svelte.ts`:

1. **Remove** `alwaysAllowedTools: new Set<string>()` from `permissionsState` (line 16-17).

2. **Remove** the auto-approve check in `handlePermissionRequest()` (lines 111-119). The function now always adds to `pendingPermissions`.

3. **Remove** `alwaysAllowTool()` function (around lines 222-227).

4. **Update** `clearAllPermissions()` (around lines 237-241) — remove `permissionsState.alwaysAllowedTools = new Set<string>();`.

5. **Remove** `alwaysAllowTool` from exports.

6. **Update** `hasPending()` (around line 26-29) if it references `alwaysAllowedTools`.

**Step 4: Remove alwaysAllowTool import from PermissionCard**

In `src/lib/frontend/components/features/PermissionCard.svelte`, line 8:
- Remove `import { alwaysAllowTool } from "../../stores/permissions.svelte.js";`
- Remove `alwaysAllowTool(request.toolName);` from `handleAlwaysAllow()` (line 69)

**Step 5: Update ChatLayout**

In `src/lib/frontend/components/layout/ChatLayout.svelte`, `clearAllPermissions()` is called on project switch (line 243). This still works — it clears pending permissions/questions. Just verify there are no references to `alwaysAllowedTools`.

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/stores/ --reporter=verbose`

Expected: Pass.

**Step 7: Run full unit test suite**

Run: `pnpm test:unit`

Expected: Pass. Check for any compilation errors from removed exports.

**Step 8: Commit**

```
refactor(permissions): remove in-memory alwaysAllowedTools from frontend store

Permission requests always render as cards now. "Always Allow" decisions
will be persisted to opencode.jsonc (next commit) instead of cached in
a per-tab Set.
```

---

### Task 5: Extend permission handler for config persistence

**Files:**
- Modify: `src/lib/handlers/payloads.ts`
- Modify: `src/lib/handlers/permissions.ts`
- Modify: `test/unit/handlers/message-handlers.test.ts`

**Step 1: Write the failing tests**

In `test/unit/handlers/message-handlers.test.ts`, add tests in the `handlePermissionResponse` describe block (around line 422):

```typescript
it("persists tool-level permission rule to config on allow_always with persistScope='tool'", async () => {
    deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
        mapped: "always",
        toolName: "read",
    });
    deps.client.getConfig = vi.fn().mockResolvedValue({
        permission: { bash: "ask" },
    });
    deps.client.updateConfig = vi.fn().mockResolvedValue({});

    await handlePermissionResponse(deps, "client-1", {
        requestId: "r1",
        decision: "allow_always",
        persistScope: "tool",
    });

    expect(deps.client.replyPermission).toHaveBeenCalledWith({
        id: "r1",
        decision: "always",
    });
    expect(deps.client.getConfig).toHaveBeenCalled();
    expect(deps.client.updateConfig).toHaveBeenCalledWith({
        permission: { bash: "ask", read: "allow" },
    });
});

it("persists pattern-level permission rule on allow_always with persistScope='pattern'", async () => {
    deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
        mapped: "always",
        toolName: "bash",
    });
    deps.client.getConfig = vi.fn().mockResolvedValue({
        permission: { bash: { "*": "ask" } },
    });
    deps.client.updateConfig = vi.fn().mockResolvedValue({});

    await handlePermissionResponse(deps, "client-1", {
        requestId: "r1",
        decision: "allow_always",
        persistScope: "pattern",
        persistPattern: "git *",
    });

    expect(deps.client.updateConfig).toHaveBeenCalledWith({
        permission: { bash: { "*": "ask", "git *": "allow" } },
    });
});

it("does not call updateConfig when persistScope is absent", async () => {
    deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
        mapped: "always",
        toolName: "read",
    });

    await handlePermissionResponse(deps, "client-1", {
        requestId: "r1",
        decision: "allow_always",
    });

    expect(deps.client.replyPermission).toHaveBeenCalled();
    expect(deps.client.updateConfig).not.toHaveBeenCalled();
});

it("handles config persistence failure gracefully (non-fatal)", async () => {
    deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
        mapped: "always",
        toolName: "read",
    });
    deps.client.getConfig = vi.fn().mockRejectedValue(new Error("network error"));

    await handlePermissionResponse(deps, "client-1", {
        requestId: "r1",
        decision: "allow_always",
        persistScope: "tool",
    });

    // Reply still sent despite config failure
    expect(deps.client.replyPermission).toHaveBeenCalledWith({
        id: "r1",
        decision: "always",
    });
});

it("handles string permission config (simple form) when persisting tool-level", async () => {
    deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
        mapped: "always",
        toolName: "read",
    });
    deps.client.getConfig = vi.fn().mockResolvedValue({
        permission: "ask",
    });
    deps.client.updateConfig = vi.fn().mockResolvedValue({});

    await handlePermissionResponse(deps, "client-1", {
        requestId: "r1",
        decision: "allow_always",
        persistScope: "tool",
    });

    // When the config is a simple string, we need to expand it to an object
    expect(deps.client.updateConfig).toHaveBeenCalledWith({
        permission: { "*": "ask", read: "allow" },
    });
});
```

Note: The mock `deps` object from `createMockHandlerDeps()` already has `deps.client.getConfig` and `deps.client.updateConfig` mocked. If not, add them to the mock factory.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/handlers/message-handlers.test.ts --reporter=verbose --grep "handlePermissionResponse"`

Expected: Fails — handler doesn't support `persistScope`.

**Step 3: Update payloads.ts**

In `src/lib/handlers/payloads.ts`, update the `permission_response` payload type (around line 16):

```typescript
permission_response: {
    requestId: string;
    decision: string;
    persistScope?: "tool" | "pattern";
    persistPattern?: string;
};
```

**Step 4: Update the permission handler**

In `src/lib/handlers/permissions.ts`, extend `handlePermissionResponse` and add `persistPermissionRule`:

```typescript
export async function handlePermissionResponse(
    deps: HandlerDeps,
    clientId: string,
    payload: PayloadMap["permission_response"],
): Promise<void> {
    const { requestId, decision, persistScope, persistPattern } = payload;
    const sessionId = resolveSessionForLog(deps, clientId);
    const result = deps.permissionBridge.onPermissionResponse(
        requestId,
        decision,
    );
    if (!result) return;

    deps.log(
        `   [perm] client=${clientId} session=${sessionId} ${result.toolName}: ${result.mapped}`,
    );
    await deps.client.replyPermission({
        id: requestId,
        decision: result.mapped,
    });
    deps.wsHandler.broadcast({
        type: "permission_resolved",
        requestId,
        decision: result.mapped,
    });

    // Persist to opencode.jsonc if requested
    if (decision === "allow_always" && persistScope) {
        await persistPermissionRule(
            deps,
            result.toolName,
            persistScope,
            persistPattern,
        );
    }
}

async function persistPermissionRule(
    deps: HandlerDeps,
    toolName: string,
    scope: "tool" | "pattern",
    pattern?: string,
): Promise<void> {
    try {
        const config = await deps.client.getConfig();
        const rawPermission = config.permission;

        // Normalise: if permission is a simple string ("ask"/"allow"/"deny"),
        // expand to { "*": <value> } so we can add tool-level entries.
        let currentPermission: Record<string, unknown>;
        if (typeof rawPermission === "string") {
            currentPermission = { "*": rawPermission };
        } else if (
            rawPermission &&
            typeof rawPermission === "object" &&
            !Array.isArray(rawPermission)
        ) {
            currentPermission = {
                ...(rawPermission as Record<string, unknown>),
            };
        } else {
            currentPermission = {};
        }

        if (scope === "tool") {
            currentPermission[toolName] = "allow";
        } else if (scope === "pattern" && pattern) {
            const currentRule = currentPermission[toolName];
            const ruleObject =
                typeof currentRule === "object" &&
                currentRule !== null &&
                !Array.isArray(currentRule)
                    ? { ...(currentRule as Record<string, unknown>) }
                    : {};
            ruleObject[pattern] = "allow";
            currentPermission[toolName] = ruleObject;
        } else {
            return;
        }

        await deps.client.updateConfig({ permission: currentPermission });
        deps.log(
            `   [perm] persisted: ${toolName} ${scope}=${pattern ?? "*"}`,
        );
    } catch (err) {
        deps.log(`   [perm] config persist failed: ${err}`);
    }
}
```

**Step 5: Update mock factory if needed**

In `test/helpers/mock-factories.ts`, ensure `createMockClient()` has `getConfig` and `updateConfig` mocked. Check around the client mock — they should already exist since the model handler uses them. If not, add:

```typescript
getConfig: vi.fn().mockResolvedValue({}),
updateConfig: vi.fn().mockResolvedValue({}),
```

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/message-handlers.test.ts --reporter=verbose --grep "handlePermissionResponse"`

Expected: All pass.

**Step 7: Commit**

```
feat(permissions): persist "Always Allow" to opencode.jsonc via PATCH /config

When the frontend sends persistScope on a permission_response, the
handler reads the current config, merges the new rule, and writes it
back. Handles both tool-level ("read": "allow") and pattern-level
("bash": { "git *": "allow" }) scopes. Config write failure is
non-fatal — the immediate "always" reply still resolves the request.
```

---

### Task 6: Update PermissionCard UI with scope choice

**Files:**
- Modify: `src/lib/frontend/components/features/PermissionCard.svelte`

**Step 1: Update the component**

Replace the single "Always Allow" button with an expandable scope choice. The component receives `request.always` (the suggested patterns from the SSE event).

```svelte
<script lang="ts">
    import type { PermissionRequest } from "../../types.js";
    import { wsSend } from "../../stores/ws.svelte.js";
    let { request }: { request: PermissionRequest } = $props();

    let resolved = $state<"allow" | "allow_always" | "deny" | null>(null);
    let showAlwaysOptions = $state(false);

    // Format tool input for display (unchanged logic)
    const inputDisplay = $derived.by(() => {
        if (!request.toolInput) return "";
        const toolInput = request.toolInput;
        const toolName = request.toolName.toLowerCase();

        if (toolName === "bash" || toolName === "command") {
            const cmd = toolInput.command ?? toolInput.cmd ?? toolInput.input;
            if (typeof cmd === "string") return cmd;
        }
        if (toolName === "edit" || toolName === "write" || toolName === "read") {
            const path = toolInput.file_path ?? toolInput.path ?? toolInput.file;
            if (typeof path === "string") return path;
        }

        const entries = Object.entries(toolInput).filter(
            ([_, v]) => v !== undefined && v !== null,
        );
        if (entries.length === 0) return "";
        return entries
            .map(
                ([k, v]) =>
                    `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
            )
            .join("\n")
            .slice(0, 500);
    });

    const resolvedText = $derived.by(() => {
        if (!resolved) return "";
        if (resolved === "deny") return "Denied \u2717";
        if (resolved === "allow_always") return "Approved \u2713 (always)";
        return "Approved \u2713";
    });

    const resolvedClass = $derived(
        resolved === "deny" ? "text-error" : "text-success",
    );

    const alwaysPatterns = $derived(request.always ?? []);
    const hasPatterns = $derived(alwaysPatterns.length > 0);

    function handleAllow() {
        if (resolved) return;
        wsSend({
            type: "permission_response",
            requestId: request.requestId,
            decision: "allow",
        });
        resolved = "allow";
    }

    function handleAlwaysAllowTool() {
        if (resolved) return;
        wsSend({
            type: "permission_response",
            requestId: request.requestId,
            decision: "allow_always",
            persistScope: "tool",
        });
        resolved = "allow_always";
        showAlwaysOptions = false;
    }

    function handleAlwaysAllowPattern(pattern: string) {
        if (resolved) return;
        wsSend({
            type: "permission_response",
            requestId: request.requestId,
            decision: "allow_always",
            persistScope: "pattern",
            persistPattern: pattern,
        });
        resolved = "allow_always";
        showAlwaysOptions = false;
    }

    function handleAlwaysAllow() {
        if (resolved) return;
        if (hasPatterns) {
            showAlwaysOptions = !showAlwaysOptions;
        } else {
            // No patterns available — default to tool-level
            handleAlwaysAllowTool();
        }
    }

    function handleDeny() {
        if (resolved) return;
        wsSend({
            type: "permission_response",
            requestId: request.requestId,
            decision: "deny",
        });
        resolved = "deny";
    }
</script>

<div
    class="my-2 mx-auto max-w-[760px] px-4"
    data-request-id={request.requestId}
>
    <div
        class="permission-card bg-bg-alt border border-border rounded-xl p-3"
    >
        <div class="text-[13px] font-medium mb-2 text-text">
            Permission Required
        </div>

        <div class="font-mono text-xs text-accent mb-1 break-all">
            {request.toolName}
        </div>

        {#if inputDisplay}
            <div
                class="font-mono text-xs text-text-secondary mb-2.5 bg-code-bg rounded-md p-2 max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all"
            >
                {inputDisplay}
            </div>
        {/if}

        {#if !resolved}
            <div class="perm-actions flex gap-2 max-sm:flex-col">
                <button
                    class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border cursor-pointer font-sans text-sm font-medium bg-success/10 border-success/20 text-success hover:bg-success/15"
                    onclick={handleAllow}
                >
                    Allow
                </button>
                <button
                    class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border cursor-pointer font-sans text-sm font-medium bg-success/[0.08] border-success/15 text-success/70 hover:bg-success/15"
                    onclick={handleAlwaysAllow}
                >
                    Always Allow{hasPatterns ? " \u25BE" : ""}
                </button>
                <button
                    class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border border-border cursor-pointer font-sans text-sm font-medium text-error hover:bg-error/[0.08]"
                    onclick={handleDeny}
                >
                    Deny
                </button>
            </div>

            {#if showAlwaysOptions}
                <div class="mt-2 flex flex-col gap-1.5">
                    <div class="text-xs text-text-secondary mb-0.5">Always allow:</div>
                    <button
                        class="w-full text-left px-3 py-2 rounded-lg border border-success/15 cursor-pointer font-sans text-xs font-medium text-success/80 hover:bg-success/[0.06]"
                        onclick={handleAlwaysAllowTool}
                    >
                        All <span class="font-mono">{request.toolName}</span> operations
                    </button>
                    {#each alwaysPatterns as pattern}
                        <button
                            class="w-full text-left px-3 py-2 rounded-lg border border-border cursor-pointer font-mono text-xs text-text-secondary hover:bg-success/[0.06] hover:text-success/80 hover:border-success/15 break-all"
                            onclick={() => handleAlwaysAllowPattern(pattern)}
                        >
                            {pattern}
                        </button>
                    {/each}
                </div>
            {/if}
        {:else}
            <div class="perm-resolved text-sm py-2">
                <span class={resolvedClass}>{resolvedText}</span>
            </div>
        {/if}
    </div>
</div>
```

**Step 2: Run type check**

Run: `pnpm tsc --noEmit -p src/lib/frontend/tsconfig.json` (or whatever the frontend tsconfig is — check `package.json` for the build command)

Expected: No type errors.

**Step 3: Build the frontend**

Run: `pnpm build:frontend`

Expected: Successful build.

**Step 4: Commit**

```
feat(permissions): expandable "Always Allow" with tool/pattern scope choice

When patterns are available from the SSE event, "Always Allow" expands
to show "All [tool] operations" and individual pattern buttons. When no
patterns are available, defaults to tool-level. The chosen scope is sent
as persistScope/persistPattern on the permission_response message.
```

---

### Task 7: Update E2E permission page object

**Files:**
- Modify: `test/e2e/page-objects/permission.page.ts`

**Step 1: Update the page object**

In `test/e2e/page-objects/permission.page.ts`, update `clickAlwaysAllow()` to handle both the simple case (no patterns → direct click) and the expanded case (patterns → click to expand, then choose):

```typescript
/** Click "Always Allow" — defaults to tool-level if options expand */
async clickAlwaysAllow() {
    const btn = this.page.locator("button", { hasText: /^Always Allow/ });
    await btn.click();
    // If options appeared, click "All ... operations" (tool-level)
    const toolOption = this.page.locator("button", {
        hasText: /^All .+ operations$/,
    });
    if (await toolOption.isVisible({ timeout: 1000 }).catch(() => false)) {
        await toolOption.click();
    }
}

/** Click a specific pattern option from the "Always Allow" expansion */
async clickAlwaysAllowPattern(pattern: string) {
    const btn = this.page.locator("button", { hasText: /^Always Allow/ });
    await btn.click();
    const patternBtn = this.page.locator("button", { hasText: pattern });
    await patternBtn.click();
}
```

**Step 2: Commit**

```
test(e2e): update permission page object for expanded Always Allow UI
```

---

### Task 8: Clean up dead code references

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts` (remove unused return-value check if any)
- Run: full test suite

**Step 1: Check sse-wiring.ts**

In `src/lib/relay/sse-wiring.ts:110`, the call `permissionBridge.onPermissionRequest(event)` previously returned `null` for auto-approved tools. Since there's no auto-approve anymore, verify the return value isn't checked. The call should still happen (to track pending state) but the return value should be unused for the auto-approve path. If the return value is used elsewhere (e.g., for conditional broadcast), keep that logic.

**Step 2: Search for any remaining references to removed APIs**

Run: `pnpm vitest run test/unit/ --reporter=verbose` to catch any compilation errors or test failures from removed exports (`alwaysAllowTool`, `isAlwaysAllowed`, `clearAlwaysAllowed`).

**Step 3: Run full test suite**

Run: `pnpm test:unit`

Expected: All pass.

**Step 4: Run the build**

Run: `pnpm build`

Expected: Clean build, no type errors.

**Step 5: Commit**

```
chore: clean up dead permission cache references
```

---

### Task 9: Manual smoke test

This task verifies the feature end-to-end with a real OpenCode instance.

**Step 1: Start OpenCode and the relay**

Ensure OpenCode is running at `localhost:4096`.

**Step 2: Trigger a permission request**

Send a prompt that requires tool approval (e.g., "Read the file ~/.zshrc").

**Step 3: Test "Always Allow" with tool-level scope**

1. Click "Always Allow" on the permission card
2. Verify the expansion shows "All read operations" and any pattern options
3. Click "All read operations"
4. Verify the card resolves with "Approved (always)"
5. Check `opencode.jsonc` — confirm `permission.read` is now `"allow"`

**Step 4: Test persistence**

1. Restart the relay
2. Send another prompt that would trigger the same permission
3. Verify NO permission card appears (OpenCode's config-driven auto-approval)

**Step 5: Test pattern-level scope**

1. Reset `opencode.jsonc` (remove the permission rule)
2. Restart OpenCode
3. Trigger a bash permission (e.g., "Run git status")
4. Click "Always Allow" → choose a specific pattern like "git *"
5. Check `opencode.jsonc` — confirm `permission.bash` has `{ "git *": "allow" }`
