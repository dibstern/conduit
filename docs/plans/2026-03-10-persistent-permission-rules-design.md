# Persistent Permission Rules via opencode.jsonc

## Problem

When a user clicks "Always Allow" in the relay's permission UI, the decision is stored only in-memory (a `Set<string>` in the frontend Svelte store and a parallel `Set<string>` in the server-side `PermissionBridge`). These caches are lost on page reload, relay restart, or project switch. The user must re-approve the same tools every session.

Additionally, the in-memory `alwaysAllowed` cache silently auto-approves requests without the user seeing them, and cannot be inspected or revoked without restarting.

## Design

### Principle

OpenCode already has a config-driven permission system in `opencode.jsonc` with `PATCH /config` to update it. Use that as the single source of truth. Remove the relay's parallel in-memory caches.

### Approach

When the user clicks "Always Allow", the relay:
1. Replies `"always"` to OpenCode via `POST /permission/{id}/reply` (existing — handles the current request and OpenCode's session-scoped memory)
2. Calls `PATCH /config` to persist the permission rule to `opencode.jsonc` (new — handles all future sessions/restarts)

The user chooses the scope: tool-level (`"read": "allow"`) or pattern-level (`"read": { "~/*": "allow" }`). The `always` field from the SSE event provides the suggested patterns.

After the config is updated, OpenCode itself stops emitting `permission.asked` for matching tools/patterns. No relay-side caching needed.

### Why no in-memory cache

- OpenCode blocks per-goroutine while waiting for a permission reply. Multiple pending requests for the same tool can exist (parallel tool calls), but the user resolves them one by one naturally.
- After `PATCH /config` returns, OpenCode's in-memory config is already updated. The next tool invocation won't trigger `permission.asked`.
- Removing the cache means: no stale state, no conflict with manual `opencode.jsonc` edits (after OpenCode restart), and no silent auto-approval the user can't see.

## OpenCode API Schemas (from API snapshot)

### PermissionRequest SSE event (`permission.asked`)

```typescript
{
  id: string;          // "per_..."
  sessionID: string;   // "ses_..."
  permission: string;  // tool name: "read", "bash", "edit", etc.
  patterns: string[];  // tool input patterns (e.g., file paths, glob patterns)
  metadata: Record<string, unknown>;
  always: string[];    // suggested patterns for "always" auto-approval
  tool?: { messageID: string; callID: string };
}
```

The `always` field is the key new data — it contains what OpenCode suggests as the scope for an "always" decision (e.g., `"git status*"` for bash, a file glob for read). Currently stored on `PendingPermission` but not forwarded to the frontend.

### PermissionConfig (in opencode.jsonc)

```typescript
// Simple — all tools:
"permission": "allow"

// Per-tool:
"permission": {
  "read": "allow",            // PermissionActionConfig
  "bash": {                   // PermissionObjectConfig (granular)
    "*": "ask",
    "git *": "allow"
  }
}
```

Where `PermissionActionConfig = "allow" | "deny" | "ask"` and `PermissionObjectConfig = Record<string, PermissionActionConfig>`.

### PATCH /config

- Request: partial `Config` object (merged into existing config)
- Response: `200` with full updated `Config`, or `400` on error
- **Synchronous**: in-memory config and file are both updated before the 200 response

## Config Write Strategy: Read-Modify-Write

`PATCH /config` merges at the top level, but nested objects may be replaced. To safely add a rule without clobbering existing ones:

1. `GET /config` — read current `permission` object
2. Merge the new rule into the existing structure
3. `PATCH /config` with the merged `permission` object

Example: user clicks "Always allow `read`" (tool-level):

```typescript
// GET /config returns: { permission: { read: { "*": "allow", "*.env": "deny" }, bash: "ask" } }
// User wants: read → "allow" (tool-level override)
// Merged result:
{ permission: { read: "allow", bash: "ask" } }
// Note: replaces the granular read object with a simple "allow"
```

Example: user clicks "Always allow `~/config/*`" (pattern-level) for read:

```typescript
// GET /config returns: { permission: { read: { "*": "allow", "*.env": "deny" } } }
// User wants: add "~/config/*": "allow" to read rules
// Merged result:
{ permission: { read: { "*": "allow", "*.env": "deny", "~/config/*": "allow" } } }
```

## Type Changes

### `shared-types.ts` — permission_request message

Add `always` field:

```typescript
| {
    type: "permission_request";
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId?: string;
    always?: string[];  // NEW — suggested patterns for "always" scope
  }
```

### `frontend/types.ts` — PermissionRequest

```typescript
export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  always?: string[];  // NEW
}
```

### `types.ts` — FrontendDecision

Add a new decision type for persistent always-allow:

```typescript
export type FrontendDecision = "allow" | "deny" | "allow_always";

// permission_response payload gains an optional scope:
export interface PermissionResponsePayload {
  requestId: string;
  decision: FrontendDecision;
  persistScope?: "tool" | "pattern";  // NEW — if present, persist to config
  persistPattern?: string;            // NEW — the pattern (when scope is "pattern")
}
```

## Relay Changes

### `event-translator.ts`

`translatePermission()` — forward the `always` field:

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
  always: props.always ?? [],  // NEW
  ...(props.tool?.callID ? { toolUseId: props.tool.callID } : {}),
};
```

### `permission-bridge.ts`

Remove:
- `alwaysAllowed: Set<string>` field
- `isAlwaysAllowed()` method
- `clearAlwaysAllowed()` method (already dead code)
- Auto-approve check in `onPermissionRequest()` (lines 65-68)

Keep everything else (pending map, timeout logic, decision mapping).

### `handlers/permissions.ts`

Extend `handlePermissionResponse` to persist when `persistScope` is present:

```typescript
export async function handlePermissionResponse(
  deps: HandlerDeps,
  clientId: string,
  payload: PermissionResponsePayload,
): Promise<void> {
  const { requestId, decision, persistScope, persistPattern } = payload;
  const result = deps.permissionBridge.onPermissionResponse(requestId, decision);
  if (!result) return;

  // Reply to OpenCode for the immediate request
  await deps.client.replyPermission({ id: requestId, decision: result.mapped });
  deps.wsHandler.broadcast({
    type: "permission_resolved",
    requestId,
    decision: result.mapped,
  });

  // Persist to opencode.jsonc if requested
  if (decision === "allow_always" && persistScope) {
    await persistPermissionRule(deps, result.toolName, persistScope, persistPattern);
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
    const currentPermission = (config.permission ?? {}) as Record<string, unknown>;

    let updatedPermission: Record<string, unknown>;

    if (scope === "tool") {
      // Tool-level: "read": "allow"
      updatedPermission = { ...currentPermission, [toolName]: "allow" };
    } else if (scope === "pattern" && pattern) {
      // Pattern-level: "read": { ..., "~/config/*": "allow" }
      const currentRule = currentPermission[toolName];
      const ruleObject = typeof currentRule === "object" && currentRule !== null
        ? { ...(currentRule as Record<string, unknown>) }
        : {};
      ruleObject[pattern] = "allow";
      updatedPermission = { ...currentPermission, [toolName]: ruleObject };
    } else {
      return;
    }

    await deps.client.updateConfig({ permission: updatedPermission });
    deps.log(`   [perm] persisted: ${toolName} ${scope}=${pattern ?? "*"}`);
  } catch (err) {
    deps.log(`   [perm] config persist failed: ${err}`);
    // Non-fatal — the immediate "always" reply already handled the current request
  }
}
```

### `handlers/payloads.ts`

Extend the payload type:

```typescript
permission_response: {
  requestId: string;
  decision: string;
  persistScope?: "tool" | "pattern";
  persistPattern?: string;
};
```

### `sse-wiring.ts`

Remove the `permissionBridge.onPermissionRequest()` return-value check that was never acted on. The call still happens (to track pending state), but no auto-approve path.

## Frontend Changes

### `stores/permissions.svelte.ts`

Remove:
- `alwaysAllowedTools: Set<string>` from state
- `alwaysAllowTool()` function
- Auto-approve check in `handlePermissionRequest()` (lines 111-119)
- `alwaysAllowedTools` reset from `clearAllPermissions()`

The `handlePermissionRequest()` always adds to `pendingPermissions` now. No silent auto-approval.

### `PermissionCard.svelte`

Replace the single "Always Allow" button with an expandable choice:

**Collapsed state (default):**
```
[Allow]  [Always Allow ▾]  [Deny]
```

**Expanded state (after clicking "Always Allow ▾"):**
```
[Allow]                                    [Deny]

Always allow:
  [All {toolName} operations]
  [{pattern 1}]                  ← from always[] field
  [{pattern 2}]                  ← from always[] field
```

Each option sends a `permission_response` with the appropriate `persistScope` and `persistPattern`.

If `always` is empty or not provided, fall back to a single "Always Allow" button that defaults to tool-level scope.

**Behavior:**
- Clicking "All {toolName} operations" → `{ decision: "allow_always", persistScope: "tool" }`
- Clicking a specific pattern → `{ decision: "allow_always", persistScope: "pattern", persistPattern: "git status*" }`
- Both immediately resolve the card (show "Approved (always)" confirmation)

### `ws-dispatch.ts`

No changes — the `permission_request` message is already dispatched to the store. The new `always` field flows through automatically since `toolInput` and message fields aren't filtered.

## Files Touched

| File | Change |
|------|--------|
| `src/lib/shared-types.ts` | Add `always` to `permission_request` message type |
| `src/lib/types.ts` | Remove `alwaysAllowed`-related types if any |
| `src/lib/frontend/types.ts` | Add `always?: string[]` to `PermissionRequest` |
| `src/lib/relay/event-translator.ts` | Forward `always` field in `translatePermission()` |
| `src/lib/bridges/permission-bridge.ts` | Remove `alwaysAllowed` set and auto-approve logic |
| `src/lib/relay/sse-wiring.ts` | Remove unused return-value check |
| `src/lib/handlers/permissions.ts` | Add `persistPermissionRule()`, extend handler |
| `src/lib/handlers/payloads.ts` | Add `persistScope`, `persistPattern` to payload |
| `src/lib/frontend/stores/permissions.svelte.ts` | Remove `alwaysAllowedTools` and auto-approve |
| `src/lib/frontend/components/features/PermissionCard.svelte` | Expandable "Always Allow" with scope choice |

## Bug Resistance

| Risk | Mitigation |
|------|-----------|
| `PATCH /config` fails | Non-fatal — the `"always"` reply already handled the current request + OpenCode's session. Log the error. User sees "Approved (always)" either way. |
| Concurrent `PATCH /config` calls (user clicks "Always Allow" on multiple permissions rapidly) | Read-modify-write with latest `GET /config` each time. Last write wins. All rules are additive ("allow"), so ordering doesn't matter. |
| `always` field is empty | Fall back to tool-level "Always Allow" button (no pattern choice). |
| Existing granular rules in config | Read-modify-write preserves them. Tool-level override intentionally replaces granular rules (user is saying "allow all"). |
| User wants to revoke a persisted rule | Edit `opencode.jsonc` directly and restart OpenCode. Out of scope for this change. |
| Multiple in-flight permissions for same tool | User resolves them naturally. Each "Always Allow" click is idempotent (same config write). Each "Allow" click sends `"once"` and doesn't touch config. |
