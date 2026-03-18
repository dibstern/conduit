# Session Forking (Ticket 5.3) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to fork a conversation at any point, creating a new session that inherits history up to that message, via OpenCode's `POST /session/:id/fork` endpoint.

**Architecture:** The server already has `OpenCodeClient.forkSession()` (opencode-client.ts:398-406). Add a `fork_session` WS message type that calls it, broadcasts a `session_forked` notification, then switches to the new session using the existing `switchSession` flow. On the frontend, add a fork button that appears on hover over assistant messages (which have `messageId`), and a "Fork" option in the session context menu (forks the entire session). Show a fork indicator in the session list for forked sessions via the `parentID` field.

**Tech Stack:** TypeScript, Svelte 5, Vitest

**Existing code that already supports this:**
- `OpenCodeClient.forkSession(sessionId, { messageID?, title? })` — `src/lib/opencode-client.ts:398-406`
- `SessionDetail.parentID` field — `src/lib/opencode-client.ts:83`
- OpenCode API: `POST /session/{sessionID}/fork` accepts `{ messageID?: string }`, returns `Session`
- OpenCode API: `GET /session/{sessionID}/children` returns `Session[]`

---

## Task 1: Add `parentID` to SessionInfo and `session_forked` to RelayMessage

**Files:**
- Modify: `src/lib/shared-types.ts:55-62` (SessionInfo)
- Modify: `src/lib/shared-types.ts:154` (RelayMessage — after session_list)

**Step 1: Write the failing test**

```typescript
// In test/unit/session-manager.test.ts (or wherever SessionInfo is tested), add:
describe("SessionInfo parentID (ticket 5.3)", () => {
	it("toSessionInfoList propagates parentID from SessionDetail", () => {
		// This test will be written in Task 2 once we know the import path
		// For now, just verify the type change compiles
	});
});
```

Skip this step — type changes don't need a failing test. Move directly to implementation.

**Step 2: Add `parentID` to SessionInfo**

In `src/lib/shared-types.ts`, find the `SessionInfo` interface (lines 55-62):

```typescript
export interface SessionInfo {
	id: string;
	title: string;
	createdAt?: string | number;
	updatedAt?: string | number;
	messageCount?: number;
	processing?: boolean;
}
```

Replace with:

```typescript
export interface SessionInfo {
	id: string;
	title: string;
	createdAt?: string | number;
	updatedAt?: string | number;
	messageCount?: number;
	processing?: boolean;
	/** Parent session ID — set when this session was forked from another. */
	parentID?: string;
}
```

**Step 3: Add `session_forked` variant to RelayMessage**

In `src/lib/shared-types.ts`, find line 154:

```typescript
	| { type: "session_list"; sessions: SessionInfo[] }
```

After it, add:

```typescript
	| { type: "session_list"; sessions: SessionInfo[] }
	| {
			type: "session_forked";
			/** The newly created forked session. */
			session: SessionInfo;
			/** The session this was forked from. */
			parentId: string;
			/** Title of the parent session. */
			parentTitle: string;
	  }
```

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/shared-types.ts
git commit -m "refactor: add parentID to SessionInfo and session_forked to RelayMessage (ticket 5.3)"
```

---

## Task 2: Propagate parentID through SessionManager

**Files:**
- Modify: `src/lib/session-manager.ts:191-199` (toSessionInfoList helper)
- Test: `test/unit/session-manager.test.ts`

**Step 1: Write the failing test**

Add to the existing session manager test file (or create if needed):

```typescript
describe("toSessionInfoList parentID propagation (ticket 5.3)", () => {
	it("includes parentID when present in SessionDetail", async () => {
		const mockClient = {
			listSessions: vi.fn().mockResolvedValue([
				{
					id: "ses_child",
					title: "Forked Session",
					parentID: "ses_parent",
					time: { created: 1000, updated: 2000 },
				},
				{
					id: "ses_parent",
					title: "Original Session",
					time: { created: 500, updated: 1500 },
				},
			]),
		} as unknown as OpenCodeClient;

		const mgr = new SessionManager({ client: mockClient });
		const sessions = await mgr.listSessions();

		const child = sessions.find((s) => s.id === "ses_child");
		expect(child).toBeDefined();
		expect(child!.parentID).toBe("ses_parent");

		const parent = sessions.find((s) => s.id === "ses_parent");
		expect(parent).toBeDefined();
		expect(parent!.parentID).toBeUndefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session-manager.test.ts --grep "parentID propagation"`
Expected: FAIL — `child.parentID` is undefined because `toSessionInfoList` doesn't map it.

**Step 3: Update toSessionInfoList**

In `src/lib/session-manager.ts`, find the `toSessionInfoList` function (lines 191-199):

```typescript
function toSessionInfoList(sessions: SessionDetail[]): SessionInfo[] {
	return sessions
		.map((s) => ({
			id: s.id,
			title: s.title ?? "Untitled",
			updatedAt: s.time?.updated ?? s.time?.created ?? 0,
			messageCount: 0,
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
```

Replace with:

```typescript
function toSessionInfoList(sessions: SessionDetail[]): SessionInfo[] {
	return sessions
		.map((s) => ({
			id: s.id,
			title: s.title ?? "Untitled",
			updatedAt: s.time?.updated ?? s.time?.created ?? 0,
			messageCount: 0,
			parentID: s.parentID,
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session-manager.test.ts --grep "parentID propagation"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/session-manager.ts test/unit/session-manager.test.ts
git commit -m "feat: propagate parentID through SessionManager (ticket 5.3)"
```

---

## Task 3: Add `fork_session` to WS router

**Files:**
- Modify: `src/lib/ws-router.ts:10-40` (IncomingMessageType union)
- Modify: `src/lib/ws-router.ts:42-73` (VALID_MESSAGE_TYPES set)
- Test: `test/unit/ws-router.test.ts`

**Step 1: Write the failing test**

In the existing ws-router test file, there should be a "drift guard" test that asserts the count of valid message types. Find it and update the expected count from N to N+1. Also add:

```typescript
it("accepts fork_session as a valid message type", () => {
	const result = routeMessage(JSON.stringify({ type: "fork_session", sessionId: "ses_123" }));
	expect(result).not.toBeNull();
	expect(result!.type).toBe("fork_session");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/ws-router.test.ts --grep "fork_session"`
Expected: FAIL — `fork_session` is not in VALID_MESSAGE_TYPES.

**Step 3: Add fork_session to both locations**

In `src/lib/ws-router.ts`, add `"fork_session"` to the `IncomingMessageType` union (after `"rename_session"` on line ~19):

```typescript
	| "fork_session"
```

And add `"fork_session"` to the `VALID_MESSAGE_TYPES` set (after `"rename_session"` on line ~51):

```typescript
	"fork_session",
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/ws-router.test.ts`
Expected: PASS (including updated drift guard count)

**Step 5: Commit**

```bash
git add src/lib/ws-router.ts test/unit/ws-router.test.ts
git commit -m "feat: add fork_session to WS router valid message types (ticket 5.3)"
```

---

## Task 4: Implement handleForkSession handler

**Files:**
- Modify: `src/lib/handlers/session.ts` (add handleForkSession)
- Modify: `src/lib/handlers/index.ts:25-33` (export) and `index.ts:90-121` (dispatch table)
- Test: `test/unit/handlers/session.test.ts` (create if needed, or add to existing handler tests)

**Step 1: Write the failing test**

Create or add to `test/unit/handlers-session.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleForkSession } from "../../src/lib/handlers/session.js";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";

describe("handleForkSession (ticket 5.3)", () => {
	let deps: HandlerDeps;
	let broadcastCalls: unknown[];
	let sendToCalls: Array<{ clientId: string; msg: unknown }>;

	beforeEach(() => {
		broadcastCalls = [];
		sendToCalls = [];
		deps = {
			wsHandler: {
				broadcast: (msg: unknown) => broadcastCalls.push(msg),
				broadcastExcept: vi.fn(),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg }),
			},
			client: {
				forkSession: vi.fn().mockResolvedValue({
					id: "ses_forked",
					title: "Forked from Original",
					parentID: "ses_original",
					time: { created: 1000, updated: 1000 },
				}),
			},
			sessionMgr: {
				getActiveSessionId: () => "ses_original",
				listSessions: vi.fn().mockResolvedValue([
					{ id: "ses_forked", title: "Forked from Original", updatedAt: 1000, parentID: "ses_original" },
					{ id: "ses_original", title: "Original", updatedAt: 500 },
				]),
				switchSession: vi.fn(),
			},
			messageCache: { remove: vi.fn() },
			overrides: { clear: vi.fn() },
			log: vi.fn(),
		} as unknown as HandlerDeps;
	});

	it("calls client.forkSession with sessionId and messageID", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
			messageId: "msg_abc",
		});

		expect(deps.client.forkSession).toHaveBeenCalledWith("ses_original", {
			messageID: "msg_abc",
		});
	});

	it("forks without messageID when not provided (forks entire session)", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		expect(deps.client.forkSession).toHaveBeenCalledWith("ses_original", {});
	});

	it("broadcasts session_forked with parent info", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		const forkedMsg = broadcastCalls.find(
			(m: any) => m.type === "session_forked",
		) as any;
		expect(forkedMsg).toBeDefined();
		expect(forkedMsg.session.id).toBe("ses_forked");
		expect(forkedMsg.parentId).toBe("ses_original");
	});

	it("switches to the forked session", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		expect(deps.sessionMgr.switchSession).toHaveBeenCalledWith("ses_forked");
	});

	it("broadcasts updated session list", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		const listMsg = broadcastCalls.find(
			(m: any) => m.type === "session_list",
		) as any;
		expect(listMsg).toBeDefined();
	});

	it("clears overrides for the new session", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		expect(deps.overrides.clear).toHaveBeenCalled();
	});

	it("uses active session when sessionId not provided", async () => {
		await handleForkSession(deps, "client-1", {});

		expect(deps.client.forkSession).toHaveBeenCalledWith("ses_original", {});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers-session.test.ts`
Expected: FAIL — `handleForkSession` is not exported.

**Step 3: Implement handleForkSession**

In `src/lib/handlers/session.ts`, add at the end of the file (before the closing, or after `handleLoadMoreHistory`):

```typescript
/** Fork a session at a specific message point (ticket 5.3). */
export async function handleForkSession(
	deps: HandlerDeps,
	clientId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const sessionId =
		String(payload.sessionId ?? "") ||
		deps.sessionMgr.getActiveSessionId() ||
		"";
	if (!sessionId) return;

	const messageId = payload.messageId ? String(payload.messageId) : undefined;

	const forked = await deps.client.forkSession(sessionId, {
		messageID: messageId,
	});

	deps.overrides.clear();

	// Find the parent title for the notification
	const sessions = await deps.sessionMgr.listSessions();
	const parent = sessions.find((s) => s.id === sessionId);

	// Broadcast the fork notification
	deps.wsHandler.broadcast({
		type: "session_forked",
		session: {
			id: forked.id,
			title: forked.title ?? "Forked Session",
			updatedAt: forked.time?.updated ?? forked.time?.created ?? 0,
			parentID: sessionId,
		},
		parentId: sessionId,
		parentTitle: parent?.title ?? "Unknown",
	});

	// Switch to the new forked session
	await deps.sessionMgr.switchSession(forked.id);

	// Broadcast session_switched so clients load the forked session's messages
	deps.wsHandler.broadcast({
		type: "session_switched",
		id: forked.id,
	});

	// Broadcast updated session list (now includes the fork)
	deps.wsHandler.broadcast({
		type: "session_list",
		sessions,
	});

	deps.log(
		`   [session] client=${clientId} Forked: ${sessionId} → ${forked.id}${messageId ? ` at ${messageId}` : ""}`,
	);
}
```

**Step 4: Wire into dispatch table**

In `src/lib/handlers/index.ts`, add to the exports (after `handleRenameSession` in the session export block, ~line 29):

```typescript
export {
	handleDeleteSession,
	handleForkSession,
	handleListSessions,
	handleLoadMoreHistory,
	handleNewSession,
	handleRenameSession,
	handleSearchSessions,
	handleSwitchSession,
} from "./session.js";
```

And add to the `MESSAGE_HANDLERS` dispatch table (after `rename_session`, ~line 97):

```typescript
	fork_session: handleForkSession,
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/handlers-session.test.ts`
Expected: PASS

**Step 6: Run type check + full unit tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/handlers/session.ts src/lib/handlers/index.ts test/unit/handlers-session.test.ts
git commit -m "feat: implement handleForkSession handler with tests (ticket 5.3)"
```

---

## Task 5: Frontend — handle `session_forked` in WS and session stores

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts:367-401` (handleMessage switch — sessions section)
- Modify: `src/lib/public/stores/session.svelte.ts` (add handleSessionForked)
- Test: `test/unit/svelte-session-store.test.ts` (or existing session store test file)

**Step 1: Write the failing test**

Add to the session store test file:

```typescript
import { handleSessionForked } from "../../src/lib/public/stores/session.svelte.js";

describe("handleSessionForked (ticket 5.3)", () => {
	it("adds the forked session to the session list", () => {
		sessionState.sessions = [
			{ id: "ses_original", title: "Original", updatedAt: 1000 },
		];

		handleSessionForked({
			type: "session_forked",
			session: {
				id: "ses_forked",
				title: "Forked from Original",
				updatedAt: 2000,
				parentID: "ses_original",
			},
			parentId: "ses_original",
			parentTitle: "Original",
		});

		expect(sessionState.sessions).toHaveLength(2);
		const forked = sessionState.sessions.find((s) => s.id === "ses_forked");
		expect(forked).toBeDefined();
		expect(forked!.parentID).toBe("ses_original");
	});

	it("does not duplicate if session already exists", () => {
		sessionState.sessions = [
			{ id: "ses_forked", title: "Already Here", updatedAt: 1000 },
		];

		handleSessionForked({
			type: "session_forked",
			session: {
				id: "ses_forked",
				title: "Forked from Original",
				updatedAt: 2000,
				parentID: "ses_original",
			},
			parentId: "ses_original",
			parentTitle: "Original",
		});

		expect(sessionState.sessions).toHaveLength(1);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/svelte-session-store.test.ts --grep "handleSessionForked"`
Expected: FAIL — function not exported.

**Step 3: Add handleSessionForked to session store**

In `src/lib/public/stores/session.svelte.ts`, add after `handleSessionSwitched` (~line 89):

```typescript
/** Handle a session_forked message — add the new session to the list. */
export function handleSessionForked(
	msg: Extract<RelayMessage, { type: "session_forked" }>,
): void {
	const { session } = msg;
	// Only add if not already present (session_list broadcast may arrive first)
	const exists = sessionState.sessions.some((s) => s.id === session.id);
	if (!exists) {
		sessionState.sessions = [session, ...sessionState.sessions];
	}
}
```

**Step 4: Add session_forked case to ws.svelte.ts handleMessage**

In `src/lib/public/stores/ws.svelte.ts`, find the sessions section of the `handleMessage` switch (after `case "session_list":` at line 367). Add after the session_list case:

```typescript
		case "session_forked": {
			handleSessionForked(msg);
			const parentTitle = msg.parentTitle ?? "session";
			showToast(`Forked from "${parentTitle}"`);
			break;
		}
```

Add the import at the top of the file (where other session store imports are):

```typescript
import {
	handleSessionList,
	handleSessionSwitched,
	handleSessionForked,
} from "./session.svelte.js";
```

And add the `showToast` import if not already present:

```typescript
import { showToast } from "./ui.svelte.js";
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/svelte-session-store.test.ts --grep "handleSessionForked"`
Expected: PASS

**Step 6: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/public/stores/session.svelte.ts src/lib/public/stores/ws.svelte.ts test/unit/svelte-session-store.test.ts
git commit -m "feat: handle session_forked in frontend stores with toast notification (ticket 5.3)"
```

---

## Task 6: Add "Fork" option to session context menu

**Files:**
- Modify: `src/lib/public/components/features/SessionContextMenu.svelte:13-27` (props) and `100-125` (menu items)
- Modify: `src/lib/public/components/features/SessionList.svelte:96-128` (handlers) and `243-251` (context menu rendering)

**Step 1: Add `onfork` prop to SessionContextMenu**

In `src/lib/public/components/features/SessionContextMenu.svelte`, update the props (lines 13-27):

```typescript
let {
	session,
	anchor,
	onrename,
	ondelete,
	oncopyresume,
	onfork,
	onclose,
}: {
	session: SessionInfo;
	anchor: HTMLElement;
	onrename: (id: string) => void;
	ondelete: (id: string, title: string) => void;
	oncopyresume: (id: string) => void;
	onfork: (id: string) => void;
	onclose: () => void;
} = $props();
```

**Step 2: Add Fork menu item**

In the same file, find the menu items section (~lines 100-125). Add a "Fork" button after the "Rename" button (before "Copy resume command"):

```svelte
		<!-- Fork -->
		<button
			class="ctx-item flex items-center gap-2.5 w-full py-[7px] px-3 border-none rounded-lg bg-transparent text-text font-sans text-[13px] cursor-pointer text-left transition-[background,color] duration-100 hover:bg-black/[0.04]"
			onclick={() => {
				onfork(session.id);
				onclose();
			}}
		>
			<Icon name="git-fork" size={15} class="text-text-muted shrink-0" />
			Fork
		</button>
```

**Step 3: Wire onfork in SessionList.svelte**

In `src/lib/public/components/features/SessionList.svelte`, add a handler after `handleCtxCopyResume` (~line 128):

```typescript
	function handleCtxFork(id: string) {
		wsSend({ type: "fork_session", sessionId: id });
	}
```

Update the `SessionContextMenu` rendering (~lines 243-251) to pass the new prop:

```svelte
{#if ctxMenuSession && ctxMenuAnchor}
	<SessionContextMenu
		session={ctxMenuSession}
		anchor={ctxMenuAnchor}
		onrename={handleCtxRename}
		ondelete={handleCtxDelete}
		oncopyresume={handleCtxCopyResume}
		onfork={handleCtxFork}
		onclose={handleCloseContextMenu}
	/>
{/if}
```

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/public/components/features/SessionContextMenu.svelte src/lib/public/components/features/SessionList.svelte
git commit -m "feat: add Fork option to session context menu (ticket 5.3)"
```

---

## Task 7: Add fork button on assistant messages

**Files:**
- Modify: `src/lib/public/components/chat/AssistantMessage.svelte`

**Step 1: Add the fork button**

In `src/lib/public/components/chat/AssistantMessage.svelte`, add the import at the top of the `<script>` block:

```typescript
import { wsSend } from "../../stores/ws.svelte.js";
import Icon from "../shared/Icon.svelte";
```

Add a fork handler function (after the existing `handleClick`/`handleKeydown` functions):

```typescript
function handleFork(e: MouseEvent) {
	e.stopPropagation(); // Don't trigger the copy click handler
	if (message.messageId) {
		wsSend({
			type: "fork_session",
			messageId: message.messageId,
		});
	}
}
```

**Step 2: Add the fork button to the template**

Find the closing `</div>` of the `msg-assistant` container (line ~271). Just before the copy-hint div, add:

```svelte
	<!-- Fork button (hover) — only for finalized messages with a messageId -->
	{#if message.finalized && message.messageId}
		<button
			class="msg-fork-btn absolute top-1.5 right-2 opacity-0 group-hover:opacity-70 hover:!opacity-100 flex items-center justify-center w-7 h-7 rounded-md bg-bg-surface/80 border border-border-subtle/50 text-text-muted cursor-pointer transition-opacity duration-150 z-10 backdrop-blur-sm"
			title="Fork from here"
			onclick={handleFork}
		>
			<Icon name="git-fork" size={14} />
		</button>
	{/if}
```

Note: The `!opacity-100` with `hover:` ensures the button becomes fully opaque when directly hovered, overriding the `group-hover:opacity-70`. The `e.stopPropagation()` in the handler prevents triggering the copy-on-click state machine.

**Step 3: Verify "git-fork" icon exists**

Check that `"git-fork"` is in the Icon component's icon map (`src/lib/public/components/shared/Icon.svelte`). If it's listed as `"git-fork"` in the Lucide mappings, it's ready. If not, check for alternatives like `"git-branch"` or `"split"` and use whichever exists. The Lucide library includes `GitFork`.

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/public/components/chat/AssistantMessage.svelte
git commit -m "feat: add fork-from-here button on assistant messages (ticket 5.3)"
```

---

## Task 8: Show fork indicator in session list

**Files:**
- Modify: `src/lib/public/components/features/SessionItem.svelte:187-196` (after the title, before the more button)

**Step 1: Add fork indicator**

In `src/lib/public/components/features/SessionItem.svelte`, find where the session title is rendered. After the title text, add a fork indicator that shows when the session has a `parentID`:

```svelte
{#if session.parentID}
	<span
		class="ml-1 text-[10px] text-text-dimmer shrink-0"
		title="Forked session"
	>
		<Icon name="git-fork" size={11} class="inline-block align-[-1px]" />
	</span>
{/if}
```

Add the Icon import if not already present:

```typescript
import Icon from "../shared/Icon.svelte";
```

**Step 2: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/public/components/features/SessionItem.svelte
git commit -m "feat: show fork indicator icon in session list (ticket 5.3)"
```

---

## Task 9: Full verification pass

**Step 1: Run full suite**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: All passing with zero type errors.

**Step 2: Verify all ACs against implementation**

- **AC1 (Fork button on messages):** `AssistantMessage.svelte` shows a git-fork icon button on hover for finalized messages with `messageId`. Clicking sends `{ type: "fork_session", messageId }` via WS.
- **AC2 (Fork creates a new session):** `handleForkSession` in `handlers/session.ts` calls `client.forkSession()`, broadcasts `session_forked` (with parent info for the toast), switches to the new session, and broadcasts `session_list` + `session_switched`.
- **AC3 (Fork appears in session list):** `SessionItem.svelte` shows a git-fork icon when `session.parentID` is set. The `toSessionInfoList` mapping propagates `parentID` from `SessionDetail`.
- **AC4 (Fork history is independent):** Handled entirely by OpenCode — the fork creates a new independent session on the server side. No relay changes needed.

**Step 3: Verify the context menu fork path**

- `SessionContextMenu.svelte` has a "Fork" menu item that calls `onfork(session.id)`.
- `SessionList.svelte` handles it with `handleCtxFork` which sends `{ type: "fork_session", sessionId: id }` (no `messageId` — forks the entire session).
- This is distinct from the message-level fork (which includes a `messageId` to fork at a specific point).

**Step 4: Commit any fixups**

```bash
git add -A
git commit -m "test: final verification for ticket 5.3 — session forking complete"
```
