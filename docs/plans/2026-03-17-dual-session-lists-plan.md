# Dual Session Lists Implementation Plan (v2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Maintain two pre-cached session lists (roots-only and all) so the sidebar loads the right 100 sessions by default and toggling subagent visibility is instant.

**Architecture:** The OpenCode API's `roots=true` query param filters server-side to only root sessions. The relay sends two `session_list` messages (tagged with `roots: boolean`): roots immediately, all in background. The frontend stores both arrays and switches between them based on the `hideSubagentSessions` toggle. A `findSession(id)` helper provides unified lookup across both arrays for all components.

**Tech Stack:** TypeScript, Svelte 5, Vitest

**Design doc:** `docs/plans/2026-03-17-dual-session-lists-design.md`

**Audit findings addressed:** See bottom of this file.

---

### Task 1: Add `roots` to OpenCode client

**Files:**
- Modify: `src/lib/instance/opencode-client.ts:31-33` (SessionListOptions)
- Modify: `src/lib/instance/opencode-client.ts:237-250` (listSessions)

**Step 1: Update `SessionListOptions`**

```typescript
export interface SessionListOptions {
	archived?: boolean;
	roots?: boolean;
}
```

**Step 2: Update `listSessions()` to pass `roots` as query param**

```typescript
async listSessions(options?: SessionListOptions): Promise<SessionDetail[]> {
	const params = new URLSearchParams();
	if (options?.archived !== undefined)
		params.set("archived", String(options.archived));
	if (options?.roots !== undefined)
		params.set("roots", String(options.roots));
	const query = params.toString();
	const path = `/session${query ? `?${query}` : ""}`;
	const res = await this.get(path);
	if (Array.isArray(res)) return res;
	if (typeof res === "object" && res !== null) {
		return Object.values(res as Record<string, SessionDetail>);
	}
	return [];
}
```

**Step 3: Verify + commit**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

```
feat(client): add roots option to SessionListOptions
```

---

### Task 2: Add `roots` to SessionManager (with parentMap safety)

**Files:**
- Modify: `src/lib/session/session-manager.ts:93-117` (listSessions)
- Modify: `src/lib/session/session-manager.ts:187-199` (searchSessions)
- Modify: `src/lib/session/session-manager.ts:284-287` (broadcastSessionList)
- Test: `test/unit/session/session-manager-processing.test.ts`

**Critical constraint:** `listSessions()` rebuilds `cachedParentMap` on every call (lines 98-104). A roots-only fetch returns zero `parentID` entries, which would wipe the map. This breaks subagent busy propagation in the status poller and causes spurious notifications in `relay-stack.ts:570,644`. The map must only be rebuilt from unfiltered fetches.

**Step 1: Write failing tests**

```typescript
it("passes roots option through to client.listSessions", async () => {
	await mgr.listSessions({ roots: true });
	expect(mgr["client"].listSessions).toHaveBeenCalledWith({ roots: true });
});

it("does NOT rebuild cachedParentMap from roots-only fetches", async () => {
	// Populate the parent map first with a full fetch
	const mockClient = mgr["client"] as { listSessions: ReturnType<typeof vi.fn> };
	mockClient.listSessions.mockResolvedValueOnce([
		{ id: "parent", title: "P" },
		{ id: "child", title: "C", parentID: "parent" },
	]);
	await mgr.listSessions();
	expect(mgr.getSessionParentMap().get("child")).toBe("parent");

	// Now do a roots-only fetch — parentMap must NOT be wiped
	mockClient.listSessions.mockResolvedValueOnce([
		{ id: "parent", title: "P" },
	]);
	await mgr.listSessions({ roots: true });
	expect(mgr.getSessionParentMap().get("child")).toBe("parent");
});
```

**Step 2: Update `listSessions` signature**

Use a single options object instead of fragile dual positional optionals:

```typescript
async listSessions(
	options?: {
		statuses?: Record<string, SessionStatus>;
		roots?: boolean;
	},
): Promise<SessionInfo[]> {
	const clientOpts = options?.roots !== undefined ? { roots: options.roots } : undefined;
	const sessions = await this.client.listSessions(clientOpts);

	// Only rebuild parent map from unfiltered fetches — a roots-only
	// fetch returns no parentIDs and would wipe the map, breaking
	// subagent busy propagation in the status poller.
	if (!options?.roots) {
		this.cachedParentMap = new Map<string, string>();
		for (const s of sessions) {
			if (s.parentID) {
				this.cachedParentMap.set(s.id, s.parentID);
			}
		}
	}

	const resolvedStatuses = options?.statuses ?? this.getStatuses?.();
	this.log.verbose(
		`listSessions: directory=${this.directory ?? "none"} roots=${options?.roots ?? "all"} returned=${sessions.length}`,
	);
	return toSessionInfoList(sessions, resolvedStatuses, this.lastMessageAt);
}
```

**Step 3: Fix all call sites for the new signature**

Every existing call like `this.listSessions(statuses)` must change to `this.listSessions({ statuses })`. Every call like `deps.sessionMgr.listSessions()` stays as-is. Grep and fix all:

- `session-manager.ts:285` (`broadcastSessionList`) — `this.listSessions()`  → no change
- `session-manager.ts:251` (`getDefaultSessionId`) — `this.listSessions()` → no change
- `session.ts:197` (`handleViewSession`) — `deps.sessionMgr.listSessions()` → no change
- `session.ts:230` (`handleNewSession`) — `deps.sessionMgr.listSessions()` → no change
- `session.ts:272` (`handleDeleteSession`) — `deps.sessionMgr.listSessions()` → no change
- `session.ts:306` (`handleListSessions`) — `deps.sessionMgr.listSessions()` → no change
- `session.ts:359` (`handleForkSession`) — `deps.sessionMgr.listSessions()` → no change
- `client-init.ts:172` — `sessionMgr.listSessions(statuses)` → `sessionMgr.listSessions({ statuses })`
- `sse-wiring.ts:219` — `sessionMgr.listSessions(statuses)` → `sessionMgr.listSessions({ statuses })`
- `relay-stack.ts:504` — `sessionMgr.listSessions(statuses)` → `sessionMgr.listSessions({ statuses })`

**Step 4: Update `searchSessions` to accept `roots`**

```typescript
async searchSessions(query: string, options?: { roots?: boolean }): Promise<SessionInfo[]> {
	const sessions = await this.client.listSessions(
		options?.roots !== undefined ? { roots: options.roots } : undefined,
	);
	const q = query.toLowerCase();
	const matches = sessions.filter((s) => {
		return (
			(s.title ?? "").toLowerCase().includes(q) ||
			s.id.toLowerCase().includes(q)
		);
	});
	return toSessionInfoList(matches, this.getStatuses?.(), this.lastMessageAt);
}
```

Note: `searchSessions` does NOT rebuild `cachedParentMap` (it calls `client.listSessions` directly, not `this.listSessions`). This is correct.

**Step 5: Update `broadcastSessionList()` to send dual lists (10th send point)**

This private method is called by `renameSession()` (always), `createSession(silent:false)`, and `deleteSession(silent:false)`. Currently it sends a single untagged `session_list`. Update it to send both:

```typescript
private async broadcastSessionList(): Promise<void> {
	const roots = await this.listSessions({ roots: true });
	this.emit("broadcast", { type: "session_list", sessions: roots, roots: true });

	this.listSessions()
		.then((all) => {
			this.emit("broadcast", { type: "session_list", sessions: all, roots: false });
		})
		.catch((err) => {
			this.log.warn(`Background all-sessions broadcast failed: ${err}`);
		});
}
```

**Step 6: Verify + commit**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

```
feat(session-manager): add roots option, protect cachedParentMap, dual-send broadcastSessionList
```

---

### Task 3: Add `roots` field to protocol types

**Files:**
- Modify: `src/lib/shared-types.ts:320`
- Modify: `src/lib/handlers/payloads.ts:33`

**Step 1: Add `roots` to `session_list` message (required, not optional)**

Making `roots` required turns missed send points into compile errors:

```typescript
| { type: "session_list"; sessions: SessionInfo[]; roots: boolean }
```

**Step 2: Add `roots` to `search_sessions` payload**

```typescript
search_sessions: { query: string; roots?: boolean };
```

**Step 3: Fix all send points that now have type errors**

Adding `roots: boolean` (required) will cause compile errors at every inline `{ type: "session_list", sessions }` construction that lacks `roots`. Fix each by adding the `roots` field. This guarantees no send point is missed.

**Step 4: Verify + commit**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

```
feat(types): add roots field to session_list message and search_sessions payload
```

---

### Task 4: Update frontend store — dual arrays, findSession helper, search isolation

**Files:**
- Modify: `src/lib/frontend/stores/session.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:161` (done notification gate)
- Modify: `src/lib/frontend/stores/permissions.svelte.ts:48` (getDescendantSessionIds)
- Modify: `src/lib/frontend/components/chat/SubagentBackBar.svelte:12,19`
- Modify: `src/lib/frontend/components/features/PermissionNotification.svelte:41`
- Test: `test/unit/stores/session-store.test.ts`

**Step 1: Update session state shape**

```typescript
export const sessionState = $state({
	rootSessions: [] as SessionInfo[],
	allSessions: [] as SessionInfo[],
	currentId: null as string | null,
	searchQuery: "",
	searchResults: null as SessionInfo[] | null,
	hasMore: false,
});
```

Key addition: `searchResults` as a separate field so search results don't overwrite the main arrays.

**Step 2: Add `findSession(id)` helper**

Unified lookup across both arrays. Prefers `allSessions` (more complete/recent), falls back to `rootSessions` (available earlier on load):

```typescript
/** Find a session by ID across both cached arrays. */
export function findSession(id: string): SessionInfo | undefined {
	return (
		sessionState.allSessions.find((s) => s.id === id) ??
		sessionState.rootSessions.find((s) => s.id === id)
	);
}
```

**Step 3: Update `handleSessionList`**

Use strict equality (`=== true`) to route. Untagged messages (from any code path missed during migration) update both arrays as a safety net:

```typescript
export function handleSessionList(
	msg: Extract<RelayMessage, { type: "session_list" }>,
): void {
	const { sessions, roots } = msg;
	if (!Array.isArray(sessions)) return;
	if (roots === true) {
		sessionState.rootSessions = sessions;
	} else if (roots === false) {
		sessionState.allSessions = sessions;
	}
	// Clear search results when a fresh full list arrives (not during active search)
	if (!sessionState.searchQuery.trim()) {
		sessionState.searchResults = null;
	}
}
```

Note: with Task 3 making `roots: boolean` required, the `else` (untagged) branch is unreachable in production, but guards against test fixtures or legacy messages.

**Step 4: Update `getFilteredSessions`**

Handle search results separately from the main arrays. Fall back to `rootSessions` when `allSessions` hasn't loaded yet (prevents empty-state flash):

```typescript
export function getFilteredSessions(): SessionInfo[] {
	// Active search results take priority (already filtered by server)
	if (sessionState.searchResults !== null) {
		return sessionState.searchResults;
	}
	let sessions: SessionInfo[];
	if (uiState.hideSubagentSessions) {
		sessions = sessionState.rootSessions;
	} else {
		// Fall back to rootSessions while allSessions hasn't loaded yet
		sessions = sessionState.allSessions.length > 0
			? sessionState.allSessions
			: sessionState.rootSessions;
	}
	const query = sessionState.searchQuery.toLowerCase().trim();
	if (!query) return sessions;
	return sessions.filter((s) => s.title.toLowerCase().includes(query));
}
```

**Step 5: Update `getActiveSession`**

```typescript
export function getActiveSession(): SessionInfo | undefined {
	return findSession(sessionState.currentId ?? "");
}
```

**Step 6: Update `handleSessionForked`**

Forked sessions always have `parentID` (the fork source), so they only go into `allSessions`:

```typescript
export function handleSessionForked(
	msg: Extract<RelayMessage, { type: "session_forked" }>,
): void {
	const { session } = msg;
	if (!sessionState.allSessions.some((s) => s.id === session.id)) {
		sessionState.allSessions = [session, ...sessionState.allSessions];
	}
	// Forked sessions always have parentID, so never added to rootSessions.
	// The next session_list broadcast will update both arrays authoritatively.
}
```

**Step 7: Update `clearSessionState`**

```typescript
export function clearSessionState(): void {
	resetSessionCreation();
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
}
```

**Step 8: Update `ws-dispatch.ts` done notification gate (line 161)**

```typescript
const doneSession = findSession(sessionState.currentId ?? "");
if (!doneSession?.parentID) {
	triggerNotifications(msg);
}
```

Import `findSession` from `./session.svelte.js`.

**Step 9: Update `permissions.svelte.ts` `getDescendantSessionIds` (line 48)**

Must iterate `allSessions` to traverse the parent-child tree:

```typescript
for (const s of sessionState.allSessions) {
```

Import `sessionState` if not already imported (check — it's likely already imported).

**Step 10: Update `SubagentBackBar.svelte` (lines 12, 19)**

Replace `sessionState.sessions.find(...)` with `findSession()`:

```svelte
<script lang="ts">
import { findSession, sessionState } from "../../stores/session.svelte.js";
// ...
const activeSession = $derived(findSession(sessionState.currentId ?? ""));
const parentId = $derived(activeSession?.parentID ?? null);
const parentSession = $derived(parentId ? findSession(parentId) : null);
</script>
```

**Step 11: Update `PermissionNotification.svelte` (line 41)**

```typescript
const session = findSession(sessionId);
```

Import `findSession` from the session store.

**Step 12: Fix ALL test files that reference `sessionState.sessions`**

Complete list of files and what to change:

| Test file | Occurrences | Change to |
|-----------|-------------|-----------|
| `test/unit/stores/session-store.test.ts:73` | `beforeEach` reset | Reset `rootSessions`, `allSessions`, `searchResults` |
| `test/unit/stores/session-store.test.ts` | All `sessionState.sessions =` assignments | Use `rootSessions` or `allSessions` as appropriate for each test |
| `test/unit/stores/session-store.test.ts` | All `sessionState.sessions` assertions | Assert against correct array |
| `test/unit/stores/permissions-store.test.ts:47` | `beforeEach` reset | Reset both arrays |
| `test/unit/stores/permissions-store.test.ts` | 11 test setups setting `sessionState.sessions` | Set `allSessions` (BFS needs all sessions) |
| `test/unit/stores/regression-mid-stream-switch.test.ts:65` | `beforeEach` reset | Reset both arrays |
| `test/unit/stores/regression-session-switch-history.test.ts:68` | `beforeEach` reset | Reset both arrays |
| `test/unit/components/chat-layout-ws.test.ts:137` | `vi.mock` shape | Update mock to use `rootSessions`/`allSessions` |
| `src/lib/frontend/components/features/SessionList.stories.ts:7,35,44` | Storybook story setups | Set both arrays |

**Step 13: Verify no stale references remain**

```bash
grep -r 'sessionState\.sessions' src/ test/ --include='*.ts' --include='*.svelte'
```

This must return zero matches (excluding the grep command itself).

**Step 14: Verify + commit**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

```
feat(frontend): dual session arrays with findSession helper and search isolation
```

---

### Task 5: Update server send points for dual lists

**Files:**
- Modify: `src/lib/session/session-manager.ts` (add `sendDualSessionLists` helper)
- Modify: `src/lib/handlers/session.ts` (6 external send points)
- Modify: `src/lib/bridges/client-init.ts` (1 send point)
- Modify: `src/lib/relay/sse-wiring.ts` (1 send point)
- Modify: `src/lib/relay/relay-stack.ts` (1 send point)
- Test: `test/unit/handlers/handlers-session.test.ts`, `test/unit/bridges/client-init.test.ts`

Note: The 10th send point (`broadcastSessionList()`) was already updated in Task 2.

**Step 1: Add `sendDualSessionLists` helper to SessionManager**

Uses the canonical `RelayMessage` type for the callback to stay in sync with protocol changes:

```typescript
/**
 * Send roots-only session list immediately, then all-sessions in background.
 * Used by all broadcast/unicast send points.
 */
async sendDualSessionLists(
	send: (msg: Extract<RelayMessage, { type: "session_list" }>) => void,
	options?: { statuses?: Record<string, SessionStatus> },
): Promise<void> {
	const roots = await this.listSessions({ roots: true, statuses: options?.statuses });
	send({ type: "session_list", sessions: roots, roots: true });

	this.listSessions({ statuses: options?.statuses })
		.then((all) => {
			send({ type: "session_list", sessions: all, roots: false });
		})
		.catch((err) => {
			this.log.warn(`Background all-sessions fetch failed: ${err}`);
		});
}
```

Import `RelayMessage` from `../shared-types.js` if not already imported.

**Step 2: Update `client-init.ts`**

```typescript
try {
	const statuses = deps.statusPoller?.getCurrentStatuses();
	await sessionMgr.sendDualSessionLists(
		(msg) => wsHandler.sendTo(clientId, msg),
		{ statuses },
	);
} catch (err) {
	sendInitError(err, "Failed to list sessions");
}
```

**Step 3: Update `session.ts` handlers**

**`handleViewSession`** (lines 196-203): The comment at line 193 explains this send exists so SubagentBackBar has `parentID` metadata. The `roots: false` background fetch ensures subagent sessions are included:

```typescript
try {
	await deps.sessionMgr.sendDualSessionLists(
		(msg) => deps.wsHandler.sendTo(clientId, msg),
	);
} catch (err) {
	deps.log.warn(
		`Failed to send session list to ${clientId}: ${err instanceof Error ? err.message : err}`,
	);
}
```

**`handleNewSession`** (lines 229-238):

```typescript
deps.sessionMgr
	.sendDualSessionLists((msg) => deps.wsHandler.broadcast(msg))
	.catch((err) => {
		deps.log.warn(`Failed to broadcast session list after new_session: ${err}`);
	});
```

**`handleDeleteSession`** (lines ~270-284): Keep the existing unfiltered `listSessions()` call for viewer redirect logic (it needs ALL sessions to find a redirect target). Only replace the broadcast:

```typescript
// Keep existing unfiltered fetch for viewer redirect:
const sessions = await deps.sessionMgr.listSessions();
if (sessions.length > 0) {
	for (const viewerClientId of viewers) {
		await handleViewSession(deps, viewerClientId, {
			sessionId: sessions[0]!.id,
		});
	}
}
// Replace the broadcast with dual-send:
await deps.sessionMgr.sendDualSessionLists(
	(msg) => deps.wsHandler.broadcast(msg),
);
```

**`handleListSessions`** (lines 300-307):

```typescript
export async function handleListSessions(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_sessions"],
): Promise<void> {
	await deps.sessionMgr.sendDualSessionLists(
		(msg) => deps.wsHandler.sendTo(clientId, msg),
	);
}
```

**`handleSearchSessions`** (lines 309-320): Search sends a single list with the specified `roots` value. Results go into `searchResults` on the frontend, not into the main arrays (handled in Task 6):

```typescript
export async function handleSearchSessions(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["search_sessions"],
): Promise<void> {
	const { query, roots } = payload;
	const results = await deps.sessionMgr.searchSessions(
		query,
		roots !== undefined ? { roots } : undefined,
	);
	deps.wsHandler.sendTo(clientId, {
		type: "session_list",
		sessions: results,
		roots: roots ?? false,
	});
}
```

**`handleForkSession`** (lines 358-386): Keep the `listSessions()` call at line 359 for the parent title lookup. Only replace the broadcast at lines 382-386:

```typescript
// Line 359 — keep for parent title lookup:
const sessions = await deps.sessionMgr.listSessions();
const parent = sessions.find((s) => s.id === sessionId);
// ... (fork notification code unchanged) ...

// Replace lines 382-386:
await deps.sessionMgr.sendDualSessionLists(
	(msg) => deps.wsHandler.broadcast(msg),
);
```

**Step 4: Update `sse-wiring.ts`**

```typescript
if (event.type === "session.updated") {
	const statuses = deps.getSessionStatuses?.();
	sessionMgr
		.sendDualSessionLists(
			(msg) => wsHandler.broadcast(msg),
			{ statuses },
		)
		.catch((err) =>
			log.warn(`Failed to refresh sessions after session.updated: ${err}`),
		);
}
```

**Step 5: Update `relay-stack.ts`**

```typescript
statusPoller.on("changed", async (statuses) => {
	try {
		await sessionMgr.sendDualSessionLists(
			(msg) => wsHandler.broadcast(msg),
			{ statuses },
		);
	} catch (err) {
		statusLog.warn(
			`Failed to broadcast session list: ${err instanceof Error ? err.message : err}`,
		);
	}
```

**Step 6: Update handler and bridge test mocks**

Add `sendDualSessionLists` to mock `sessionMgr` in:
- `test/unit/handlers/handlers-session.test.ts`
- `test/unit/bridges/client-init.test.ts`
- `test/helpers/mock-factories.ts` (if `sessionMgr` is built there)

**Step 7: Verify + commit**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

```
feat(relay): send dual session lists (roots + all) at all broadcast points
```

---

### Task 6: Update frontend search to use `searchResults`

**Files:**
- Modify: `src/lib/frontend/components/features/SessionList.svelte:100-114` (search handler)
- Modify: `src/lib/frontend/stores/session.svelte.ts` (add handleSearchResults)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (route search results)

**Step 1: Add `search_results` message type or tag search responses**

Search responses are still `session_list` messages. Add a handler in `handleSessionList` to detect when a search is active and route to `searchResults`:

Actually, simpler: the server sends search results as `session_list` tagged with `roots`. The frontend's `handleSessionList` already routes by `roots`. To separate search results, add a `search?: boolean` tag to `session_list`:

Alternative (simpler, no protocol change): Let the frontend detect search state. When `searchQuery` is non-empty, incoming `session_list` messages go to `searchResults` instead of the main arrays. When `searchQuery` is empty, they go to the main arrays.

Best approach: since the server sends search results as a single `session_list` message (not a dual-send), and the client knows when it's searching, let the client route based on `searchQuery`:

Update `handleSessionList`:

```typescript
export function handleSessionList(
	msg: Extract<RelayMessage, { type: "session_list" }>,
): void {
	const { sessions, roots } = msg;
	if (!Array.isArray(sessions)) return;

	// During active search, route single (non-dual) responses to searchResults
	if (sessionState.searchQuery.trim()) {
		sessionState.searchResults = sessions;
		return;
	}

	if (roots === true) {
		sessionState.rootSessions = sessions;
	} else if (roots === false) {
		sessionState.allSessions = sessions;
	}
}
```

Wait — this has a problem: during search, background dual-send broadcasts from other events (SSE, status poller) would also be routed to `searchResults`. We need to distinguish search responses from broadcasts.

Better approach: handle search results in a separate path. Add `search?: boolean` to the `session_list` message type:

```typescript
| { type: "session_list"; sessions: SessionInfo[]; roots: boolean; search?: boolean }
```

In `handleSessionList`:

```typescript
if (msg.search) {
	sessionState.searchResults = sessions;
	return;
}
sessionState.searchResults = null; // Clear search results on non-search list
if (roots === true) {
	sessionState.rootSessions = sessions;
} else if (roots === false) {
	sessionState.allSessions = sessions;
}
```

In `handleSearchSessions` on the server:

```typescript
deps.wsHandler.sendTo(clientId, {
	type: "session_list",
	sessions: results,
	roots: roots ?? false,
	search: true,
});
```

**Step 2: Update search send to pass `roots`**

In `SessionList.svelte:109-112`:

```svelte
debounceTimer = setTimeout(() => {
	wsSend({
		type: "search_sessions",
		query: localSearchValue,
		roots: uiState.hideSubagentSessions ? true : undefined,
	});
}, 300);
```

**Step 3: Update `closeSearch` to clear searchResults and request fresh list**

In `SessionList.svelte`, update `closeSearch()` to also request a fresh session list so the sidebar is immediately restored:

```typescript
function closeSearch() {
	localSearchValue = "";
	setSearchQuery("");
	sessionState.searchResults = null;
	// Request fresh list to restore sidebar after search overwrote it
	wsSend({ type: "list_sessions" });
}
```

Actually, with `searchResults` as a separate field, `closeSearch` only needs to null it out — the main arrays were never overwritten:

```typescript
function closeSearch() {
	localSearchValue = "";
	setSearchQuery("");
	sessionState.searchResults = null;
}
```

Import `sessionState` if not already imported.

**Step 4: Re-send search on toggle change during active search**

When the user toggles `hideSubagentSessions` during an active search, the search needs to be re-run with the new `roots` value. In `SessionList.svelte`, add a reactive statement:

```svelte
$effect(() => {
	const _hide = uiState.hideSubagentSessions; // track dependency
	if (localSearchValue.trim()) {
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		wsSend({
			type: "search_sessions",
			query: localSearchValue,
			roots: uiState.hideSubagentSessions ? true : undefined,
		});
	}
});
```

**Step 5: Verify + commit**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

```
feat(frontend): isolate search results from main session arrays
```

---

### Task 7: Update E2E fixtures and integration tests

**Files:**
- Modify: `test/e2e/fixtures/mockup-state.ts` (6 occurrences)
- Modify: `test/e2e/specs/subagent-sessions.spec.ts:62`
- Modify: `test/integration/helpers/test-ws-client.ts` (waitForInitialState)
- Check: `test/integration/flows/session-lifecycle.integration.ts`

**Step 1: Update E2E fixtures to send tagged `session_list` messages**

In `mockup-state.ts`, every `{ type: "session_list", sessions: [...] }` needs a `roots` field. Send two messages where needed: one `roots: true` with root sessions only, one `roots: false` with all sessions.

**Step 2: Update subagent E2E spec**

In `subagent-sessions.spec.ts:62`, the fixture sends a single `session_list`. Update to send both tagged variants.

**Step 3: Update integration test client helper**

`waitForInitialState` in `test-ws-client.ts:99` waits for a single `session_list`. After dual-send, it may need to wait for the `roots: true` message (or both). Check if assertions on session count need adjusting.

**Step 4: Verify + commit**

```bash
pnpm test:unit && pnpm test:e2e
```

```
test: update fixtures and integration tests for dual session lists
```

---

### Task 8: Final verification and smoke test

**Step 1: Run complete verification**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

**Step 2: Verify no stale references**

```bash
grep -r 'sessionState\.sessions[^R]' src/ test/ --include='*.ts' --include='*.svelte' | grep -v 'node_modules'
```

Must return zero matches.

**Step 3: Manual smoke test**

1. Open the relay UI in browser
2. Sidebar shows root sessions (should be ~100 instead of ~8)
3. Toggle "show subagent sessions" — list updates instantly
4. Toggle back — switches back instantly
5. Search with subagents hidden — results are root-only
6. Search with subagents shown — results include subagents
7. Clear search — full list is restored immediately (no waiting for broadcast)
8. Navigate into a subagent session — SubagentBackBar appears with parent title
9. Navigate back — returns to parent session
10. Rename a session — title updates in sidebar regardless of toggle
11. Fork a session — fork appears in sidebar when showing subagents

**Step 4: Commit any remaining fixes**

---

## Appendix: Audit Findings Addressed

| Finding | Severity | How addressed |
|---------|----------|---------------|
| 10th send point: `broadcastSessionList()` | CRITICAL | Task 2 Step 5 — updated to dual-send |
| `cachedParentMap` wiped by roots-only fetch | CRITICAL | Task 2 Step 2 — guard: only rebuild from unfiltered fetches |
| `SubagentBackBar.svelte` reads `sessionState.sessions` | CRITICAL | Task 4 Step 10 — uses `findSession()` |
| `permissions.svelte.ts` `getDescendantSessionIds` | CRITICAL | Task 4 Step 9 — reads `allSessions` |
| `PermissionNotification.svelte` | HIGH | Task 4 Step 11 — uses `findSession()` |
| `ws-dispatch.ts` done notification gate | HIGH | Task 4 Step 8 — uses `findSession()` |
| Search results overwrite main arrays | HIGH | Task 4 Step 1 (`searchResults` field) + Task 6 |
| Empty state flash when `hideSubagentSessions=false` | HIGH | Task 4 Step 4 — falls back to `rootSessions` |
| `handleDeleteSession` viewer redirect | HIGH | Task 5 Step 3 — keeps unfiltered fetch for redirect |
| `handleForkSession` parent title lookup | HIGH | Task 5 Step 3 — preserves `listSessions()` call for lookup |
| Fragile `listSessions(statuses?, options?)` | MEDIUM | Task 2 Step 2 — single options object |
| `if (roots)` truthiness conflation | MEDIUM | Task 4 Step 3 — uses `roots === true` |
| `roots` optional on protocol → missed sends | MEDIUM | Task 3 Step 1 — `roots: boolean` required |
| Callback type drift from RelayMessage | MEDIUM | Task 5 Step 1 — `Extract<RelayMessage, ...>` |
| Toggle during search doesn't re-send | MEDIUM | Task 6 Step 4 — `$effect` re-sends on toggle |
| 7 test files reference `sessionState.sessions` | MEDIUM | Task 4 Step 12 — full list with migration table |
| E2E fixtures send untagged `session_list` | MEDIUM | Task 7 — updated fixtures |
| `getActiveSession` stale from rootSessions | LOW | Task 4 Step 5 — uses `findSession()` (prefers allSessions) |
| `handleSessionForked` dead rootSessions branch | LOW | Task 4 Step 6 — only adds to allSessions with comment |
