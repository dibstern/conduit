# Notification State Unification — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix three notification bugs by unifying notification state management into a single module and eliminating race conditions in subagent detection.

**Architecture:** Consolidate all notification state transitions (permissions, questions, remote tracking) into `permissions.svelte.ts`. Make `ws-dispatch.ts` a thin router that delegates state changes to the store. Add eager parent map updates on the server to eliminate subagent detection races.

**Tech Stack:** TypeScript, Svelte 5 ($state), Vitest

---

### Task 1: Add `sessionId` to wire types

**Files:**
- Modify: `src/lib/shared-types.ts:296` (add `sessionId?` to `ask_user_resolved`)
- Modify: `src/lib/frontend/types.ts:198-205` (add `sessionId` to `QuestionRequest`)
- Test: `test/unit/stores/permissions-store.test.ts` (verify existing tests still pass)

**Step 1: Add `sessionId` to `ask_user_resolved` in shared-types.ts**

In `src/lib/shared-types.ts`, change line 296:
```typescript
// FROM:
| { type: "ask_user_resolved"; toolId: string }
// TO:
| { type: "ask_user_resolved"; toolId: string; sessionId?: string }
```

**Step 2: Add `sessionId` to `QuestionRequest` in frontend types.ts**

In `src/lib/frontend/types.ts`, change the interface at line 198:
```typescript
export interface QuestionRequest {
	toolId: string;
	toolUseId?: string;
	sessionId: string;  // NEW: which session owns this question
	questions: AskUserQuestion[];
}
```

**Step 3: Run type check**

Run: `pnpm check`
Expected: Type errors in `handleAskUser` (needs to populate `sessionId`), possibly in test helpers and story files.

**Step 4: Fix `handleAskUser` in permissions.svelte.ts to populate `sessionId`**

In `src/lib/frontend/stores/permissions.svelte.ts`, the `handleAskUser` function constructs a `QuestionRequest` at line 239. The `ask_user` RelayMessage doesn't carry an explicit `sessionId` when it arrives via session-scoped delivery — it's implicitly the current session. But we also need it from `notification_event` context. Add the `sessionId` to the `ask_user` message type:

Actually, looking at the `ask_user` type — it doesn't have `sessionId`. For session-scoped delivery, it's implicitly the current session. We need to pass it in. Update `handleAskUser` to accept an optional sessionId parameter:

```typescript
export function handleAskUser(
	msg: Extract<RelayMessage, { type: "ask_user" }>,
	sessionId?: string,
): void {
	const { toolId, questions, toolUseId } = msg;
	if (!toolId || !Array.isArray(questions)) {
		log.warn("handleAskUser: dropped — invalid payload", {
			toolId,
			questionsType: typeof questions,
			msg,
		});
		return;
	}

	const isDuplicate = permissionsState.pendingQuestions.some(
		(q) => q.toolId === toolId,
	);
	if (isDuplicate) return;

	const request: QuestionRequest = {
		toolId,
		sessionId: sessionId ?? "",
		...(toolUseId != null && { toolUseId }),
		questions,
	};
	permissionsState.pendingQuestions = [
		...permissionsState.pendingQuestions,
		request,
	];
}
```

**Step 5: Fix story files and test helpers that construct `QuestionRequest`**

In `src/lib/frontend/components/chat/QuestionCard.stories.ts`, add `sessionId: "test-session"` to each mock `QuestionRequest`.

In `test/unit/stores/permissions-store.test.ts`, update any test data that constructs ask_user messages — the handler now takes `sessionId` as second arg. The tests call `handleAskUser(msg(...))` — add sessionId where needed for verification.

**Step 6: Run type check + tests**

Run: `pnpm check && pnpm test:unit -- --testPathPattern="permissions-store|dispatch-notifications"`
Expected: All pass.

**Step 7: Commit**

```bash
git add -A && git commit -m "feat: add sessionId to ask_user_resolved and QuestionRequest types"
```

---

### Task 2: Unify notification state management in permissions store

**Files:**
- Modify: `src/lib/frontend/stores/permissions.svelte.ts` (3 new methods)
- Test: `test/unit/stores/permissions-store.test.ts` (new test sections)

**Step 1: Write failing tests for `handleAskUserResolved` cleanup**

Add to `test/unit/stores/permissions-store.test.ts`:
```typescript
describe("handleAskUserResolved — remoteQuestionSessions cleanup", () => {
	it("removes sessionId from remoteQuestionSessions when resolving", () => {
		permissionsState.remoteQuestionSessions = new Set(["s1", "s2"]);
		permissionsState.pendingQuestions = [
			{ toolId: "q1", sessionId: "s1", questions: [] },
		];
		handleAskUserResolved(msg({ type: "ask_user_resolved", toolId: "q1", sessionId: "s1" }));
		expect(permissionsState.pendingQuestions).toHaveLength(0);
		expect(permissionsState.remoteQuestionSessions.has("s1")).toBe(false);
		expect(permissionsState.remoteQuestionSessions.has("s2")).toBe(true);
	});

	it("cleans up remoteQuestionSessions even without matching pendingQuestion", () => {
		permissionsState.remoteQuestionSessions = new Set(["s1"]);
		handleAskUserResolved(msg({ type: "ask_user_resolved", toolId: "q1", sessionId: "s1" }));
		expect(permissionsState.remoteQuestionSessions.has("s1")).toBe(false);
	});

	it("handles missing sessionId gracefully (no remote cleanup)", () => {
		permissionsState.remoteQuestionSessions = new Set(["s1"]);
		permissionsState.pendingQuestions = [
			{ toolId: "q1", sessionId: "s1", questions: [] },
		];
		handleAskUserResolved(msg({ type: "ask_user_resolved", toolId: "q1" }));
		expect(permissionsState.pendingQuestions).toHaveLength(0);
		// Without sessionId, can't clean remote — this is backward compat
		expect(permissionsState.remoteQuestionSessions.has("s1")).toBe(true);
	});
});
```

**Step 2: Run to verify they fail**

Run: `pnpm test:unit -- --testPathPattern="permissions-store" --reporter=verbose 2>&1 | tail -30`
Expected: FAIL (remoteQuestionSessions not cleaned up).

**Step 3: Update `handleAskUserResolved` to also clean `remoteQuestionSessions`**

In `src/lib/frontend/stores/permissions.svelte.ts`:
```typescript
export function handleAskUserResolved(
	msg: Extract<RelayMessage, { type: "ask_user_resolved" }>,
): void {
	const { toolId } = msg;
	if (!toolId) return;

	// Remove from pending questions
	permissionsState.pendingQuestions = permissionsState.pendingQuestions.filter(
		(q) => q.toolId !== toolId,
	);

	// Also clean up remote tracking (fixes stale AttentionBanner)
	const sessionId = "sessionId" in msg ? (msg as { sessionId?: string }).sessionId : undefined;
	if (sessionId) {
		removeRemoteQuestion(sessionId);
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- --testPathPattern="permissions-store"`
Expected: PASS.

**Step 5: Write failing tests for `handleNotificationEvent`**

Add to the test file:
```typescript
describe("handleNotificationEvent", () => {
	it("adds remote question for ask_user notification", () => {
		handleNotificationEvent({ eventType: "ask_user", sessionId: "s1" });
		expect(permissionsState.remoteQuestionSessions.has("s1")).toBe(true);
	});

	it("removes remote question for ask_user_resolved notification", () => {
		permissionsState.remoteQuestionSessions = new Set(["s1"]);
		handleNotificationEvent({ eventType: "ask_user_resolved", sessionId: "s1" });
		expect(permissionsState.remoteQuestionSessions.has("s1")).toBe(false);
	});

	it("no-ops for non-question event types", () => {
		handleNotificationEvent({ eventType: "done", sessionId: "s1" });
		expect(permissionsState.remoteQuestionSessions.size).toBe(0);
	});

	it("no-ops when sessionId is missing", () => {
		handleNotificationEvent({ eventType: "ask_user" });
		expect(permissionsState.remoteQuestionSessions.size).toBe(0);
	});
});
```

**Step 6: Run to verify they fail**

Run: `pnpm test:unit -- --testPathPattern="permissions-store" --reporter=verbose 2>&1 | tail -20`
Expected: FAIL (handleNotificationEvent not defined).

**Step 7: Implement `handleNotificationEvent`**

Add to `src/lib/frontend/stores/permissions.svelte.ts`:
```typescript
/** Notification event state parameters. */
export interface NotificationEventParams {
	eventType: string;
	sessionId?: string;
}

/**
 * Handle notification_event state effects.
 * Single entry point for all remote question tracking from cross-session broadcasts.
 */
export function handleNotificationEvent(params: NotificationEventParams): void {
	if (!params.sessionId) return;
	if (params.eventType === "ask_user") {
		addRemoteQuestion(params.sessionId);
	} else if (params.eventType === "ask_user_resolved") {
		removeRemoteQuestion(params.sessionId);
	}
}
```

**Step 8: Run tests**

Run: `pnpm test:unit -- --testPathPattern="permissions-store"`
Expected: PASS.

**Step 9: Write failing tests for `onSessionSwitch`**

Add to the test file:
```typescript
describe("onSessionSwitch", () => {
	it("clears previous session permissions and all pending questions", () => {
		permissionsState.pendingPermissions = [
			{ id: "p1", requestId: pid("p1"), sessionId: "old-session", toolName: "bash", toolInput: {} },
			{ id: "p2", requestId: pid("p2"), sessionId: "other-session", toolName: "edit", toolInput: {} },
		];
		permissionsState.pendingQuestions = [
			{ toolId: "q1", sessionId: "old-session", questions: [] },
		];
		permissionsState.questionErrors.set("q1", "error");
		permissionsState.remoteQuestionSessions = new Set(["new-session", "other"]);

		onSessionSwitch("old-session", "new-session");

		// Previous session permissions removed, other session kept
		expect(permissionsState.pendingPermissions).toHaveLength(1);
		expect(permissionsState.pendingPermissions[0]?.sessionId).toBe("other-session");
		// All pending questions cleared (they belong to the previous session view)
		expect(permissionsState.pendingQuestions).toHaveLength(0);
		// Question errors cleared
		expect(permissionsState.questionErrors.size).toBe(0);
		// New session removed from remote tracking (now viewing it)
		expect(permissionsState.remoteQuestionSessions.has("new-session")).toBe(false);
		expect(permissionsState.remoteQuestionSessions.has("other")).toBe(true);
	});
});
```

**Step 10: Run to verify they fail**

Expected: FAIL (onSessionSwitch not defined).

**Step 11: Implement `onSessionSwitch`**

Add to `src/lib/frontend/stores/permissions.svelte.ts`:
```typescript
/**
 * Consolidate all notification state cleanup for a session switch.
 * - Clears previous session's permissions from pending
 * - Clears all pending questions (they belong to previous session view)
 * - Clears question errors
 * - Removes new session from remote tracking (now viewing it)
 */
export function onSessionSwitch(
	previousSessionId: string | null,
	newSessionId: string,
): void {
	clearSessionLocal(previousSessionId);
	removeRemoteQuestion(newSessionId);
}
```

**Step 12: Run tests + type check**

Run: `pnpm check && pnpm test:unit -- --testPathPattern="permissions-store"`
Expected: PASS.

**Step 13: Commit**

```bash
git add -A && git commit -m "feat: unify notification state management — handleNotificationEvent, onSessionSwitch, symmetric cleanup"
```

---

### Task 3: Thin out ws-dispatch.ts — delegate state to store

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (session_switched + notification_event handlers)
- Test: `test/unit/frontend/dispatch-notifications.test.ts` (verify no regressions)
- Test: `test/unit/stores/permissions-store.test.ts` (already covered above)

**Step 1: Update `session_switched` handler to use `onSessionSwitch`**

In `src/lib/frontend/stores/ws-dispatch.ts`, replace the scattered calls at lines 342-343:

```typescript
// FROM (lines 342-343):
clearSessionLocal(previousSessionId); // Keep remote permissions
if (msg.id) removeRemoteQuestion(msg.id); // Now viewing this session — no longer remote

// TO:
if (msg.id) onSessionSwitch(previousSessionId, msg.id);
```

Update imports: add `onSessionSwitch`, remove `clearSessionLocal` and `removeRemoteQuestion` from imports (if they are no longer used elsewhere in this file).

**Step 2: Update `notification_event` handler to use `handleNotificationEvent`**

In `src/lib/frontend/stores/ws-dispatch.ts`, replace the inline state management at lines 570-573:

```typescript
// FROM (lines 568-574):
// Track cross-session question notifications so the
// AttentionBanner component can show them.
if (msg.eventType === "ask_user" && msg.sessionId) {
	addRemoteQuestion(msg.sessionId);
} else if (msg.eventType === "ask_user_resolved" && msg.sessionId) {
	removeRemoteQuestion(msg.sessionId);
}

// TO:
handleNotificationEvent(msg);
```

Update imports: add `handleNotificationEvent`, remove `addRemoteQuestion` and `removeRemoteQuestion` from imports.

**Step 3: Pass sessionId to handleAskUser**

In `src/lib/frontend/stores/ws-dispatch.ts`, the `ask_user` handler at line 434-436 should pass the current session:

```typescript
// FROM:
case "ask_user":
	handleAskUser(msg);
	triggerNotifications(msg);
	break;

// TO:
case "ask_user":
	handleAskUser(msg, sessionState.currentId ?? "");
	triggerNotifications(msg);
	break;
```

**Step 4: Run type check + full test suite**

Run: `pnpm check && pnpm test:unit -- --testPathPattern="permissions-store|dispatch-notifications"`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: delegate notification state management from ws-dispatch to permissions store"
```

---

### Task 4: Server-side — include `sessionId` in `ask_user_resolved` broadcast

**Files:**
- Modify: `src/lib/handlers/permissions.ts:160,178,217,234` (add sessionId to broadcasts)
- Test: existing handler tests (if any), else manual verification

**Step 1: Update `handleAskUserResponse` to include sessionId**

In `src/lib/handlers/permissions.ts`, at line 160:
```typescript
// FROM:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId });

// TO:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId, sessionId });
```

Also at line 178 (fallback path):
```typescript
// FROM:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId: queId });

// TO:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId: queId, sessionId });
```

**Step 2: Update `handleQuestionReject` to include sessionId**

At line 217:
```typescript
// FROM:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId });

// TO:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId, sessionId });
```

At line 234 (fallback):
```typescript
// FROM:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId: queId });

// TO:
deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId: queId, sessionId });
```

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS (sessionId is `string`, matching the optional `sessionId?: string` on the type).

**Step 4: Commit**

```bash
git add -A && git commit -m "fix: include sessionId in ask_user_resolved broadcasts for cross-session cleanup"
```

---

### Task 5: Server-side — eager parent map update for subagent detection

**Files:**
- Modify: `src/lib/session/session-manager.ts:119` (add `addToParentMap` method)
- Modify: `src/lib/relay/sse-wiring.ts:256` (eagerly update on session.updated)
- Modify: `src/lib/relay/sse-wiring.ts:56` (add `sessionMgr` to SSEWiringDeps)
- Test: new test for eager parent map update

**Step 1: Write failing test for `addToParentMap`**

Create or add to test for SessionManager. Since there may not be a dedicated test file, add a focused test:

In `test/unit/relay/notification-policy.test.ts` (or a new file `test/unit/session/session-manager-parent-map.test.ts`):

Actually, `addToParentMap` is simple enough to test through the existing notification policy integration. Let's write a focused test file:

Create `test/unit/session/eager-parent-map.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
// Test the eager parent map update behavior through the public API.
// SessionManager.addToParentMap should immediately make getSessionParentMap
// return the child→parent mapping.

// We can't easily test the full SSE wiring here, but we can verify the
// SessionManager method works correctly.
```

For now, the `addToParentMap` method is trivially correct (one line). Focus testing on the integration.

**Step 2: Add `addToParentMap` to SessionManager**

In `src/lib/session/session-manager.ts`, after `getSessionParentMap()` at line 121:
```typescript
/**
 * Eagerly add a child→parent mapping.
 * Called from SSE wiring on `session.updated` to eliminate the race
 * between subagent creation and the async listSessions() refresh.
 */
addToParentMap(childId: string, parentId: string): void {
	this.cachedParentMap.set(childId, parentId);
}
```

**Step 3: Add `sessionMgr` to SSEWiringDeps (if not already there)**

Check the SSEWiringDeps interface. Looking at the deps, `sessionMgr` is already available (it's used for `recordMessageActivity` at line 183 and `sendDualSessionLists` at line 259). Good — no interface change needed. The `sessionMgr` is accessed as `deps.sessionMgr` in the existing code.

Wait — looking at the interface at line 56-91, `sessionMgr` IS there (line 58). Good.

**Step 4: Eagerly update parent map in SSE handler**

In `src/lib/relay/sse-wiring.ts`, in the `session.updated` handler around line 256:
```typescript
// FROM:
if (event.type === "session.updated") {
	const statuses = deps.getSessionStatuses?.();
	sessionMgr
		.sendDualSessionLists((msg) => wsHandler.broadcast(msg), { statuses })
		.catch((err) =>
			log.warn(`Failed to refresh sessions after session.updated: ${err}`),
		);
}

// TO:
if (event.type === "session.updated") {
	// Eagerly update parent map from SSE event to eliminate the race
	// between subagent creation and the async listSessions() refresh.
	// Without this, a fast subagent could complete before getSessionParentMap()
	// knows about it, causing its "done" to be treated as a root session event.
	if (hasInfoWithSessionID(event.properties)) {
		const info = event.properties.info;
		const childId = info.sessionID ?? info.id;
		const parentId =
			typeof info["parentID"] === "string" ? info["parentID"] : undefined;
		if (childId && parentId) {
			sessionMgr.addToParentMap(childId, parentId);
		}
	}

	const statuses = deps.getSessionStatuses?.();
	sessionMgr
		.sendDualSessionLists((msg) => wsHandler.broadcast(msg), { statuses })
		.catch((err) =>
			log.warn(`Failed to refresh sessions after session.updated: ${err}`),
		);
}
```

**Step 5: Run type check + all tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS.

**Step 6: Commit**

```bash
git add -A && git commit -m "fix: eagerly update parent map on session.updated to prevent subagent notification race"
```

---

### Task 6: Final verification and cleanup

**Step 1: Run full verification suite**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: All pass, no regressions.

**Step 2: Review imports**

Check that `ws-dispatch.ts` no longer imports `addRemoteQuestion`, `removeRemoteQuestion`, or `clearSessionLocal` if they're fully delegated to the store. If some are still used, keep them.

**Step 3: Commit any cleanup**

```bash
git add -A && git commit -m "chore: clean up unused imports after notification state unification"
```
