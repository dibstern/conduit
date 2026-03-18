# Hide Subagent Sessions + Fix Subagent Navigation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent toggle to hide/show subagent sessions in the sidebar, and fix the broken "navigate into subagent / back to parent" flow.

**Architecture:** The hide-toggle adds `hideSubagentSessions` to `uiState` (localStorage-backed) and makes `getFilteredSessions()` conditional. The navigation fix sends a targeted `session_list` to the requesting client inside `handleViewSession`, so the client always has the navigated session's `parentID` available for `SubagentBackBar`.

**Tech Stack:** SvelteKit 2 / Svelte 5, TypeScript, Vitest, localStorage

---

## Bug Context

`SubagentBackBar` (`src/lib/public/components/chat/SubagentBackBar.svelte`) derives `parentId` from `activeSession?.parentID` by looking up the current session in `sessionState.sessions`. But `handleViewSession` (`src/lib/handlers/session.ts:11-86`) only sends `session_switched` + history to the requesting client — never an updated `session_list`. If the child session wasn't already in `sessionState.sessions` with `parentID` set (e.g. spawned autonomously by OpenCode, not via relay fork), the back-bar is invisible. Fix: send `session_list` to the requesting client inside `handleViewSession`.

---

## Task 1: Add `hideSubagentSessions` to `uiState`

**Files:**
- Modify: `src/lib/public/stores/ui.svelte.ts`

**Step 1: Add the storage key constant and initial state**

In `ui.svelte.ts`, add after the existing key constants (line 11, after `FILE_VIEWER_WIDTH_KEY`):

```typescript
const HIDE_SUBAGENT_SESSIONS_KEY = "hide-subagent-sessions";
```

In the `uiState` object (line 33, after the `sidebarWidth` block, before the `// Scroll` comment at line 35), add:

```typescript
	// Subagent sessions filter
	hideSubagentSessions:
		typeof localStorage !== "undefined"
			? localStorage.getItem(HIDE_SUBAGENT_SESSIONS_KEY) !== "false"
			: true,
```

Note: default is `true` (hidden). We use `!== "false"` so that an unset key also defaults to `true`.

**Step 2: Add the toggle action**

After the `setSidebarWidth` function (line 139), add:

```typescript
export function toggleHideSubagentSessions(): void {
	uiState.hideSubagentSessions = !uiState.hideSubagentSessions;
	try {
		localStorage.setItem(
			HIDE_SUBAGENT_SESSIONS_KEY,
			String(uiState.hideSubagentSessions),
		);
	} catch {
		/* ignore */
	}
}
```

**Step 3: Run tests**

```bash
pnpm test:unit
```
Expected: all pass (no changes to logic yet).

**Step 4: Commit**

```bash
git add src/lib/public/stores/ui.svelte.ts
git commit -m "feat: add hideSubagentSessions toggle to uiState with localStorage persistence"
```

---

## Task 2: Make `getFilteredSessions` respect the toggle

**Files:**
- Modify: `src/lib/public/stores/session.svelte.ts`
- Modify: `test/unit/svelte-session-store.test.ts`

**Step 1: Write the failing test**

In `test/unit/svelte-session-store.test.ts`, add a new `describe` block at the end of the file. The test file already imports `sessionState` and helpers from `session.svelte.js`. You need to additionally import `getFilteredSessions` (already exported but not imported in the test file) and `uiState`:

Add to the imports at the top (line 3-11):
```typescript
import {
	getFilteredSessions,  // ← add this
	groupSessionsByDate,
	handleSessionForked,
	handleSessionList,
	handleSessionSwitched,
	sessionState,
	setCurrentSession,
	setSearchQuery,
} from "../../src/lib/public/stores/session.svelte.js";
```

Add a new import for `uiState`:
```typescript
import { uiState } from "../../src/lib/public/stores/ui.svelte.js";
```

Then add the test block at the end:

```typescript
// ─── getFilteredSessions — subagent toggle ──────────────────────────────────

describe("getFilteredSessions — hideSubagentSessions toggle", () => {
	beforeEach(() => {
		uiState.hideSubagentSessions = true; // reset to default
	});

	it("excludes subagent sessions when hideSubagentSessions is true", () => {
		sessionState.sessions = [
			makeSession({ id: "a", title: "Parent", updatedAt: 1000 }),
			makeSession({ id: "b", title: "Child", parentID: "a", updatedAt: 2000 }),
		];
		uiState.hideSubagentSessions = true;
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["a"]);
	});

	it("includes subagent sessions when hideSubagentSessions is false", () => {
		sessionState.sessions = [
			makeSession({ id: "a", title: "Parent", updatedAt: 1000 }),
			makeSession({ id: "b", title: "Child", parentID: "a", updatedAt: 2000 }),
		];
		uiState.hideSubagentSessions = false;
		const ids = getFilteredSessions().map((s) => s.id);
		expect(ids).toContain("a");
		expect(ids).toContain("b");
	});

	it("still applies search filter when subagents are visible", () => {
		sessionState.sessions = [
			makeSession({ id: "a", title: "Parent Session", updatedAt: 1000 }),
			makeSession({ id: "b", title: "Child Session", parentID: "a", updatedAt: 2000 }),
		];
		uiState.hideSubagentSessions = false;
		sessionState.searchQuery = "child";
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b"]);
	});
});
```

Note: The `beforeEach` at the top of the file (line 58-63) already resets `sessionState`. The new `beforeEach` inside this describe only resets `uiState.hideSubagentSessions`.

**Step 2: Run to confirm failure**

```bash
pnpm test:unit -- svelte-session-store --reporter=verbose
```
Expected: The "includes subagent sessions" test fails (current code always filters).

**Step 3: Update `getFilteredSessions`**

In `src/lib/public/stores/session.svelte.ts`:

Add the import for `uiState` (after line 5):
```typescript
import { uiState } from "./ui.svelte.js";
```

Replace lines 19-26 (the `getFilteredSessions` function):

Old (lines 19-26):
```typescript
/** Get sessions filtered by search query (case-insensitive title match).
 *  Subagent sessions (those with a parentID) are excluded from the list. */
export function getFilteredSessions(): SessionInfo[] {
	const rootSessions = sessionState.sessions.filter((s) => !s.parentID);
	const query = sessionState.searchQuery.toLowerCase().trim();
	if (!query) return rootSessions;
	return rootSessions.filter((s) => s.title.toLowerCase().includes(query));
}
```

New:
```typescript
/** Get sessions filtered by search query (case-insensitive title match).
 *  Subagent sessions (those with a parentID) are excluded when the
 *  hideSubagentSessions UI toggle is active (default). */
export function getFilteredSessions(): SessionInfo[] {
	const sessions = uiState.hideSubagentSessions
		? sessionState.sessions.filter((s) => !s.parentID)
		: sessionState.sessions;
	const query = sessionState.searchQuery.toLowerCase().trim();
	if (!query) return sessions;
	return sessions.filter((s) => s.title.toLowerCase().includes(query));
}
```

**Step 4: Run tests to confirm pass**

```bash
pnpm test:unit -- svelte-session-store --reporter=verbose
```
Expected: all pass.

**Step 5: Commit**

```bash
git add src/lib/public/stores/session.svelte.ts test/unit/svelte-session-store.test.ts
git commit -m "feat: make getFilteredSessions conditional on hideSubagentSessions toggle"
```

---

## Task 3: Add toggle button to `SessionList.svelte`

**Files:**
- Modify: `src/lib/public/components/features/SessionList.svelte`

**Step 1: Update the import from `ui.svelte.js`**

In `SessionList.svelte`, line 17 currently reads:
```typescript
import { closeMobileSidebar, confirm } from "../../stores/ui.svelte.js";
```

Change to:
```typescript
import { closeMobileSidebar, confirm, toggleHideSubagentSessions, uiState } from "../../stores/ui.svelte.js";
```

**Step 2: Add the toggle button**

In the header toolbar `<div class="session-list-header-actions ...">` (line 269), add a new button between the search button (line 278-286) and the cleanup button (line 287-294).

Insert after line 286 (`</button>` closing the search button), before line 287 (`<button` opening the cleanup button):

```svelte
					<button
						type="button"
						title={uiState.hideSubagentSessions ? "Show subagent sessions" : "Hide subagent sessions"}
					class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text {uiState.hideSubagentSessions ? 'text-text-dimmer' : 'text-accent'}"
					onclick={toggleHideSubagentSessions}
					>
						<Icon name="git-fork" size={14} />
					</button>
```

Notes:
- Uses `git-fork` icon (registered in `Icon.svelte` at line 179). `git-branch` is NOT registered.
- Button is muted (`text-text-dimmer`) when subagents are hidden (default), accent-coloured (`text-accent`) when subagents are visible.
- Follows the exact same class pattern as the adjacent `plus`, `search`, and `trash-2` buttons.

**Step 3: Verify in browser (manual)**

```bash
pnpm dev
```
Open sidebar, confirm `git-fork` icon appears in the session list header. Click it: subagent sessions appear/disappear. Reload page: preference is remembered.

**Step 4: Commit**

```bash
git add src/lib/public/components/features/SessionList.svelte
git commit -m "feat: add subagent session visibility toggle button to session list header"
```

---

## Task 4: Fix `handleViewSession` — send session_list to requesting client

**Files:**
- Modify: `src/lib/handlers/session.ts`
- Modify: `test/unit/handlers-session.test.ts`

**Step 1: Write the failing test**

In `test/unit/handlers-session.test.ts`, add a new test inside the existing `describe("handleViewSession — per-tab session viewing")` block (after the last `it` at line 315):

```typescript
	it("sends session_list to the requesting client after viewing", async () => {
		const sessions = [
			{ id: "child-1", title: "Child", parentID: "parent-1", updatedAt: 1000, messageCount: 0 },
			{ id: "parent-1", title: "Parent", updatedAt: 500, messageCount: 0 },
		];
		vi.mocked(deps.sessionMgr.listSessions).mockResolvedValue(sessions);

		await handleViewSession(deps, "client-1", { sessionId: "child-1" });

		const sessionListMsg = sendToCalls.find(
			(c) =>
				c.clientId === "client-1" &&
				(c.msg as Record<string, unknown>)["type"] === "session_list",
		);
		expect(sessionListMsg).toBeDefined();
		expect(
			(sessionListMsg!.msg as { type: string; sessions: unknown[] }).sessions,
		).toEqual(sessions);
	});
```

Note: The test uses `createMockHandlerDeps` from `test/helpers/mock-factories.ts` which provides `deps.sessionMgr.listSessions` as a mock returning `[{ id: "s1", ... }]` by default. The test overrides it with sessions that include `parentID`.

**Step 2: Run to confirm failure**

```bash
pnpm test:unit -- handlers-session --reporter=verbose
```
Expected: FAIL — `sendTo` was not called with a `session_list` message.

**Step 3: Add `session_list` send inside `handleViewSession`**

In `src/lib/handlers/session.ts`, inside `handleViewSession`, add before the final `deps.log(...)` call at line 85:

```typescript
	// Send updated session list to this client so parentID is available
	// for SubagentBackBar (subagent sessions may not be in the sidebar but
	// the client needs their metadata to render back-navigation).
	try {
		const sessions = await deps.sessionMgr.listSessions();
		deps.wsHandler.sendTo(clientId, { type: "session_list", sessions });
	} catch {
		/* non-fatal */
	}
```

Insert this after the `questionBridge.getPending` loop (after line 83, before `deps.log`).

**Step 4: Run tests to confirm pass**

```bash
pnpm test:unit -- handlers-session --reporter=verbose
```
Expected: all pass.

**Step 5: Check existing test expectations**

The existing test `"does NOT broadcast"` (line 272) asserts `expect(deps.wsHandler.broadcast).not.toHaveBeenCalled()`. Our change uses `sendTo` (not `broadcast`), so this test should still pass. Verify by running the full handler test suite.

**Step 6: Commit**

```bash
git add src/lib/handlers/session.ts test/unit/handlers-session.test.ts
git commit -m "fix: send session_list to requesting client in handleViewSession so SubagentBackBar can resolve parentID"
```

---

## Task 5: Verify end-to-end (manual smoke test)

With a running OpenCode instance:

```bash
pnpm dev
```

1. Start a session and send a message that triggers the `Task` tool (spawns a subagent).
2. In `ToolItem`, click the subagent session link / arrow button (the description text or the arrow-right icon at line 500-508 of `ToolItem.svelte`).
3. Confirm you navigate into the child session and the chat content loads.
4. Confirm `SubagentBackBar` appears at the top of the message list: "Back to [parent title]".
5. Click the back bar and confirm navigation back to the parent session.
6. Open sidebar, click the `git-fork` toggle icon: subagent sessions appear in the session list (button turns accent colour).
7. Click again: subagent sessions disappear (button becomes muted).
8. Reload page: toggle state is preserved.

---

## Task 6: Run full test suite

```bash
pnpm test
```
Expected: all unit and fixture tests pass.

**If any failures:** Fix before proceeding.

**Final commit (if any fixups needed):**
```bash
git add -A
git commit -m "fix: address test failures from subagent navigation feature"
```
