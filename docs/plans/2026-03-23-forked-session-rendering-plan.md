# Forked Session Rendering Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** When viewing a forked session, show inherited messages in a collapsible "Prior conversation" block above a fork divider, and hide the SubagentBackBar for user-initiated forks.

**Architecture:** Add `forkMessageId` to session metadata, persisted in `~/.conduit/fork-metadata.json`. The fork handler stores the fork point on creation. The frontend splits messages at the fork point, rendering inherited ones inside a collapsible block and new ones below a divider.

**Tech Stack:** TypeScript, Svelte 5, Tailwind CSS, Vitest

---

### Task 1: Fork metadata persistence module

**Files:**
- Create: `src/lib/daemon/fork-metadata.ts`
- Test: `test/unit/daemon/fork-metadata.test.ts`

**Step 1: Write the failing test**

Create `test/unit/daemon/fork-metadata.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadForkMetadata,
	saveForkMetadata,
} from "../../../src/lib/daemon/fork-metadata.js";

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "fork-meta-test-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe("fork-metadata persistence", () => {
	it("returns empty map when file does not exist", () => {
		const meta = loadForkMetadata(testDir);
		expect(meta).toEqual(new Map());
	});

	it("saves and loads fork metadata", () => {
		const meta = new Map([["ses_1", "msg_a"], ["ses_2", "msg_b"]]);
		saveForkMetadata(meta, testDir);
		const loaded = loadForkMetadata(testDir);
		expect(loaded).toEqual(meta);
	});

	it("saves atomically (tmp + rename)", () => {
		const meta = new Map([["ses_1", "msg_a"]]);
		saveForkMetadata(meta, testDir);
		// No tmp file left behind
		expect(existsSync(join(testDir, ".fork-metadata.json.tmp"))).toBe(false);
		// Final file exists
		expect(existsSync(join(testDir, "fork-metadata.json"))).toBe(true);
	});

	it("returns empty map on corrupt file", () => {
		writeFileSync(join(testDir, "fork-metadata.json"), "not json", "utf-8");
		const meta = loadForkMetadata(testDir);
		expect(meta).toEqual(new Map());
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/fork-metadata.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

Create `src/lib/daemon/fork-metadata.ts`:

```typescript
// ─── Fork Metadata Persistence ──────────────────────────────────────────────
// Stores fork-point message IDs in ~/.conduit/fork-metadata.json.
// Maps sessionId → forkMessageId (the last inherited message in a forked session).

import {
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { DEFAULT_CONFIG_DIR } from "../env.js";

const FILENAME = "fork-metadata.json";
const TMP_FILENAME = ".fork-metadata.json.tmp";

function resolveDir(configDir?: string): string {
	return configDir ?? DEFAULT_CONFIG_DIR;
}

/** Load all fork metadata from disk. Returns empty map on missing/corrupt file. */
export function loadForkMetadata(
	configDir?: string,
): Map<string, string> {
	try {
		const dir = resolveDir(configDir);
		const data = readFileSync(join(dir, FILENAME), "utf-8");
		const obj = JSON.parse(data) as Record<string, string>;
		return new Map(Object.entries(obj));
	} catch {
		return new Map();
	}
}

/** Atomic write of fork metadata to disk. */
export function saveForkMetadata(
	meta: Map<string, string>,
	configDir?: string,
): void {
	const dir = resolveDir(configDir);
	mkdirSync(dir, { recursive: true });
	const obj = Object.fromEntries(meta);
	const tmpPath = join(dir, TMP_FILENAME);
	const finalPath = join(dir, FILENAME);
	writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf-8");
	renameSync(tmpPath, finalPath);
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/fork-metadata.test.ts`
Expected: All 7 tests pass.

**Step 5: Commit**

```bash
git add src/lib/daemon/fork-metadata.ts test/unit/daemon/fork-metadata.test.ts
git commit -m "feat: add fork-metadata.json persistence for fork-point tracking"
```

---

### Task 2: Add forkMessageId to SessionInfo and session_forked

**Files:**
- Modify: `src/lib/shared-types.ts:139-148` (SessionInfo interface)
- Modify: `src/lib/shared-types.ts:328-336` (session_forked message type)
- Test: existing tests in `test/unit/stores/session-store.test.ts`

**Step 1: Add `forkMessageId` to `SessionInfo`**

In `src/lib/shared-types.ts`, add the field to `SessionInfo`:

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
	/** The message ID at the fork point — messages up to this ID are inherited context. */
	forkMessageId?: string;
}
```

**Step 2: Run type check**

Run: `pnpm check`
Expected: Pass (new optional field doesn't break existing code).

**Step 3: Commit**

```bash
git add src/lib/shared-types.ts
git commit -m "feat: add forkMessageId to SessionInfo for fork-point tracking"
```

---

### Task 3: Store fork point in handleForkSession

**Files:**
- Modify: `src/lib/handlers/session.ts:367-416` (handleForkSession)
- Modify: `src/lib/handlers/types.ts:23-47` (HandlerDeps — add forkMeta access)
- Test: `test/unit/handlers/handlers-session.test.ts`

**Step 1: Read existing fork handler tests**

Read `test/unit/handlers/handlers-session.test.ts` to understand the test patterns for `handleForkSession`. Look for the describe block and the mock setup.

**Step 2: Add forkMeta to HandlerDeps**

In `src/lib/handlers/types.ts`, add an optional `forkMeta` field to `HandlerDeps`:

```typescript
/** Optional fork-point metadata store — used to persist forkMessageId */
forkMeta?: {
	setForkMessageId: (sessionId: string, messageId: string) => void;
};
```

This keeps it injectable for testing without importing the file I/O module directly.

**Step 3: Update handleForkSession to store fork point**

In `src/lib/handlers/session.ts`, after the fork succeeds:

1. For "fork from here" (has `messageId`): store `messageId` directly.
2. For whole-session fork (no `messageId`): fetch messages from the forked session and use the last one's ID.
3. Include `forkMessageId` in the `session_forked` broadcast.

Replace the handleForkSession function:

```typescript
/** Fork a session at a specific message point (ticket 5.3). */
export async function handleForkSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["fork_session"],
): Promise<void> {
	const sessionId = payload.sessionId || resolveSession(deps, clientId) || "";
	if (!sessionId) return;

	const { messageId } = payload;

	const forked = await deps.client.forkSession(sessionId, {
		...(messageId != null && { messageID: messageId }),
	});

	deps.overrides.clearSession(sessionId);

	// Determine the fork-point messageId
	let forkMessageId: string | undefined = messageId;
	if (!forkMessageId) {
		// Whole-session fork: get all messages in the forked session and use the last one.
		// At this point the fork just happened, so all messages are inherited.
		try {
			const msgs = await deps.client.getMessages(forked.id);
			if (msgs.length > 0) {
				forkMessageId = msgs[msgs.length - 1].id;
			}
		} catch {
			deps.log.warn(`Could not determine fork-point for ${forked.id}`);
		}
	}

	// Persist fork-point metadata
	if (forkMessageId && deps.forkMeta) {
		deps.forkMeta.setForkMessageId(forked.id, forkMessageId);
	}

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
			...(forkMessageId && { forkMessageId }),
		},
		parentId: sessionId,
		parentTitle: parent?.title ?? "Unknown",
	});

	// Associate the requesting client with the forked session
	deps.wsHandler.setClientSession(clientId, forked.id);
	deps.wsHandler.sendTo(clientId, {
		type: "session_switched",
		id: forked.id,
	});

	// Broadcast updated session list (now includes the fork)
	await deps.sessionMgr.sendDualSessionLists((msg) =>
		deps.wsHandler.broadcast(msg),
	);

	deps.log.info(
		`client=${clientId} Forked: ${sessionId} → ${forked.id}${messageId ? ` at ${messageId}` : ""}`,
	);
}
```

**Step 4: Write tests for fork-point storage**

Add tests in `test/unit/handlers/handlers-session.test.ts` within the existing `handleForkSession` describe block:

```typescript
it("stores forkMessageId from messageId payload", async () => {
	let storedSessionId: string | undefined;
	let storedMessageId: string | undefined;
	const forkMeta = {
		setForkMessageId: (sid: string, mid: string) => {
			storedSessionId = sid;
			storedMessageId = mid;
		},
	};
	const depsWithMeta = { ...deps, forkMeta };
	await handleForkSession(depsWithMeta, "client-1", {
		sessionId: "ses_original",
		messageId: "msg_42",
	});
	expect(storedSessionId).toBe("ses_forked");
	expect(storedMessageId).toBe("msg_42");
});

it("includes forkMessageId in session_forked broadcast", async () => {
	const depsWithMeta = { ...deps, forkMeta: { setForkMessageId: () => {} } };
	await handleForkSession(depsWithMeta, "client-1", {
		sessionId: "ses_original",
		messageId: "msg_42",
	});
	const forkedMsg = broadcastCalls.find(
		(m) => (m as Record<string, unknown>).type === "session_forked",
	) as Record<string, unknown> | undefined;
	expect((forkedMsg?.session as Record<string, unknown>)?.forkMessageId).toBe("msg_42");
});
```

Note: Uses existing mock variable names from the test file: `broadcastCalls`, `deps`, `"client-1"`, `"ses_original"`. The mock `forkSession` returns `{ id: "ses_forked" }`.

**Step 5: Run tests**

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/lib/handlers/session.ts src/lib/handlers/types.ts test/unit/handlers/handlers-session.test.ts
git commit -m "feat: store fork-point messageId on fork creation"
```

---

### Task 4: Include forkMessageId in session lists

**Files:**
- Modify: `src/lib/session/session-manager.ts:366-393` (toSessionInfoList)
- Modify: `src/lib/session/session-manager.ts` (constructor/init — load fork metadata)

**Step 1: Wire fork metadata into SessionManager**

The `SessionManager` needs access to the fork metadata map so `toSessionInfoList` can include `forkMessageId` on sessions that have one.

Add a `forkMeta` parameter to the `toSessionInfoList` function (or pass it as a Map):

In the `toSessionInfoList` function, add an optional `forkMeta` parameter:

```typescript
function toSessionInfoList(
	sessions: SessionDetail[],
	statuses?: Record<string, SessionStatus>,
	lastMessageAt?: ReadonlyMap<string, number>,
	forkMeta?: ReadonlyMap<string, string>,
): SessionInfo[] {
	return sessions
		.map((s) => {
			const lastMsgTime = lastMessageAt?.get(s.id);
			const displayTime = lastMsgTime ?? s.time?.created ?? 0;
			const forkMessageId = forkMeta?.get(s.id);

			const info: SessionInfo = {
				id: s.id,
				title: s.title ?? "Untitled",
				updatedAt: displayTime,
				messageCount: 0,
				...(s.parentID != null && { parentID: s.parentID }),
				...(forkMessageId != null && { forkMessageId }),
			};
			if (statuses) {
				const status = statuses[s.id];
				if (status && (status.type === "busy" || status.type === "retry")) {
					info.processing = true;
				}
			}
			return info;
		})
		.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
}
```

Then update `listSessions()` in `SessionManager` to pass the fork metadata:

```typescript
return toSessionInfoList(sessions, resolvedStatuses, this.lastMessageAt, this.forkMeta);
```

The `SessionManager` should load fork metadata on construction or initialization, and expose a setter for the fork handler to call.

Add to `SessionManager`:
- A `forkMeta: Map<string, string>` property
- Initialized from `loadForkMetadata(configDir)` during construction
- A `setForkMessageId(sessionId, messageId)` method that updates the map AND saves to disk

**Step 2: Run type check and tests**

Run: `pnpm check && pnpm vitest run test/unit/session/`
Expected: Pass.

**Step 3: Commit**

```bash
git add src/lib/session/session-manager.ts
git commit -m "feat: include forkMessageId in session list responses"
```

---

### Task 5: Wire forkMeta through the relay stack

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — pass forkMeta to handler deps
- Modify: `src/lib/daemon/daemon.ts` — load fork metadata on startup

**Step 1: Find where HandlerDeps is constructed**

Read `src/lib/relay/relay-stack.ts` to find where `HandlerDeps` is built. Add `forkMeta` from the session manager.

**Step 2: Update daemon startup**

In `src/lib/daemon/daemon.ts`, load fork metadata early in `start()` and pass it to the session manager constructor (or call a setter after construction).

**Step 3: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/lib/relay/relay-stack.ts src/lib/daemon/daemon.ts
git commit -m "feat: wire fork metadata through relay stack and daemon startup"
```

---

### Task 6: Frontend — ForkDivider component

**Files:**
- Create: `src/lib/frontend/components/chat/ForkDivider.svelte`

**Step 1: Create the component**

```svelte
<!-- ─── Fork Divider ─────────────────────────────────────────────────────────── -->
<!-- Horizontal rule with centered label showing the fork origin. -->
<!-- Clicking the parent title navigates to the parent session. -->

<script lang="ts">
	import { wsSend } from "../../stores/ws.svelte.js";

	interface Props {
		parentTitle: string;
		parentId: string;
	}

	let { parentTitle, parentId }: Props = $props();

	function navigateToParent() {
		wsSend({ type: "switch_session", sessionId: parentId });
	}
</script>

<div class="fork-divider flex items-center gap-3 my-4 max-w-[760px] mx-auto px-5">
	<div class="flex-1 h-px bg-border"></div>
	<span class="text-[11px] text-text-dimmer font-mono whitespace-nowrap">
		Forked from
		<button
			type="button"
			class="text-text-muted hover:text-text-secondary underline decoration-dotted cursor-pointer bg-transparent border-none p-0 font-mono text-[11px] transition-colors"
			onclick={navigateToParent}
			title="Go to parent session"
		>
			{parentTitle}
		</button>
	</span>
	<div class="flex-1 h-px bg-border"></div>
</div>
```

**Step 2: Commit**

```bash
git add src/lib/frontend/components/chat/ForkDivider.svelte
git commit -m "feat: add ForkDivider component for fork-point visualization"
```

---

### Task 7: Frontend — ForkContextBlock component

**Files:**
- Create: `src/lib/frontend/components/chat/ForkContextBlock.svelte`

**Step 1: Create the component**

This component wraps inherited messages in a collapsible block. It receives a `messages` array (already grouped) and renders them when expanded.

```svelte
<!-- ─── Fork Context Block ───────────────────────────────────────────────────── -->
<!-- Collapsible block showing inherited messages from the parent session. -->
<!-- Collapsed by default. Expand/collapse state stored in sessionStorage. -->

<script lang="ts">
	import { sessionState } from "../../stores/session.svelte.js";
	import Icon from "../shared/Icon.svelte";

	interface Props {
		children: import("svelte").Snippet;
	}

	let { children }: Props = $props();

	const storageKey = $derived(
		`fork-collapsed-${sessionState.currentId ?? ""}`,
	);

	// Default to collapsed; read from sessionStorage if available
	let collapsed = $state(true);

	$effect(() => {
		const key = storageKey;
		if (key) {
			const stored = sessionStorage.getItem(key);
			collapsed = stored !== "false";
		}
	});

	function toggle() {
		collapsed = !collapsed;
		const key = storageKey;
		if (key) {
			sessionStorage.setItem(key, String(collapsed));
		}
	}
</script>

<div class="fork-context-block max-w-[760px] mx-auto px-5 mt-2">
	<button
		type="button"
		class="fork-context-toggle flex items-center gap-2 w-full py-2 px-3 rounded-lg bg-bg-surface/50 border border-border/50 text-text-dimmer text-xs font-mono cursor-pointer hover:bg-bg-surface transition-colors"
		onclick={toggle}
	>
		<Icon
			name="chevron-right"
			size={12}
			class="transition-transform duration-200 {collapsed ? '' : 'rotate-90'}"
		/>
		<span>Prior conversation</span>
	</button>

	{#if !collapsed}
		<div class="fork-context-messages mt-2 pl-3 border-l-2 border-border/40 opacity-75">
			{@render children()}
		</div>
	{/if}
</div>
```

**Step 2: Commit**

```bash
git add src/lib/frontend/components/chat/ForkContextBlock.svelte
git commit -m "feat: add ForkContextBlock collapsible component for inherited messages"
```

---

### Task 8: Frontend — Split messages at fork point in MessageList

**Files:**
- Modify: `src/lib/frontend/components/chat/MessageList.svelte`
- Create: `src/lib/frontend/utils/fork-split.ts`

**Step 1: Create fork-split utility**

Create `src/lib/frontend/utils/fork-split.ts`:

```typescript
// ─── Fork Split Utility ─────────────────────────────────────────────────────
// Splits a ChatMessage array at the fork point for rendering inherited
// vs new messages in a forked session.

import type { ChatMessage } from "../types.js";

export interface ForkSplit {
	/** Messages inherited from the parent session (before and including the fork point). */
	inherited: ChatMessage[];
	/** New messages created in this fork (after the fork point). */
	current: ChatMessage[];
}

/**
 * Split messages at the fork point identified by forkMessageId.
 * Scans for the last ChatMessage whose messageId matches forkMessageId.
 * Returns all messages up to and including that point as "inherited",
 * and the rest as "current".
 *
 * If forkMessageId is not found in the messages (e.g. messages haven't
 * loaded yet), all messages are returned as "inherited" (conservative).
 */
export function splitAtForkPoint(
	messages: ChatMessage[],
	forkMessageId: string,
): ForkSplit {
	// Find the last index where any message has this messageId.
	// Assistant and tool messages carry messageId; we need the LAST
	// occurrence because a single OpenCode message can produce multiple
	// ChatMessages (text + thinking + tools + result).
	let splitIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if ("messageId" in msg && msg.messageId === forkMessageId) {
			splitIndex = i;
			break;
		}
	}

	if (splitIndex === -1) {
		// Fork point not found — treat all as inherited (conservative)
		return { inherited: messages, current: [] };
	}

	// Include all messages in the same "turn" after the matched message.
	// A turn ends when we hit the next user message or the end of the array.
	let endOfTurn = splitIndex;
	for (let i = splitIndex + 1; i < messages.length; i++) {
		if (messages[i].type === "user") break;
		// Include trailing thinking, tool, result messages from the same turn
		endOfTurn = i;
	}

	return {
		inherited: messages.slice(0, endOfTurn + 1),
		current: messages.slice(endOfTurn + 1),
	};
}
```

**Step 2: Write tests for fork-split**

Create `test/unit/frontend/fork-split.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";

function user(uuid: string): ChatMessage {
	return { type: "user", uuid, text: "hello" };
}

function assistant(uuid: string, messageId?: string): ChatMessage {
	return { type: "assistant", uuid, rawText: "hi", html: "hi", finalized: true, messageId };
}

function result(uuid: string): ChatMessage {
	return { type: "result", uuid };
}

function tool(uuid: string, messageId?: string): ChatMessage {
	return { type: "tool", uuid, id: "t1", name: "Bash", status: "completed", messageId } as ChatMessage;
}

describe("splitAtForkPoint", () => {
	it("splits at the matching assistant messageId", () => {
		const msgs = [user("u1"), assistant("a1", "msg_1"), user("u2"), assistant("a2", "msg_2")];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "a1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2", "a2"]);
	});

	it("includes trailing result/tool messages in the same turn", () => {
		const msgs = [user("u1"), assistant("a1", "msg_1"), result("r1"), user("u2")];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "a1", "r1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2"]);
	});

	it("treats all as inherited when forkMessageId not found", () => {
		const msgs = [user("u1"), assistant("a1", "msg_1")];
		const split = splitAtForkPoint(msgs, "msg_unknown");
		expect(split.inherited).toEqual(msgs);
		expect(split.current).toEqual([]);
	});

	it("handles empty messages array", () => {
		const split = splitAtForkPoint([], "msg_1");
		expect(split.inherited).toEqual([]);
		expect(split.current).toEqual([]);
	});

	it("matches on tool messageId too", () => {
		const msgs = [user("u1"), tool("t1", "msg_1"), user("u2")];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "t1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2"]);
	});

	it("splits at end when fork point is the last message", () => {
		const msgs = [user("u1"), assistant("a1", "msg_1")];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited).toEqual(msgs);
		expect(split.current).toEqual([]);
	});
});
```

**Step 3: Run tests**

Run: `pnpm vitest run test/unit/frontend/fork-split.test.ts`
Expected: All pass.

**Step 4: Integrate into MessageList.svelte**

In `MessageList.svelte`, import the fork-split utility and the new components. Add derived state that computes the split when a fork is active:

In the `<script>` section, add:

```typescript
import { findSession } from "../../stores/session.svelte.js";
import { splitAtForkPoint } from "../../utils/fork-split.js";
import ForkContextBlock from "./ForkContextBlock.svelte";
import ForkDivider from "./ForkDivider.svelte";
```

Add derived state:

```typescript
// Fork context: detect if current session is a user fork
const activeSession = $derived(findSession(sessionState.currentId ?? ""));
const isFork = $derived(!!activeSession?.forkMessageId);
const forkSplit = $derived(
	isFork
		? splitAtForkPoint(chatState.messages, activeSession!.forkMessageId!)
		: null,
);
const parentSession = $derived(
	activeSession?.parentID ? findSession(activeSession.parentID) : null,
);
// Memoize grouped messages for fork rendering (avoid inline groupMessages calls)
const inheritedGrouped = $derived(
	forkSplit ? groupMessages(forkSplit.inherited) : [],
);
const currentGrouped = $derived(
	forkSplit ? groupMessages(forkSplit.current) : [],
);
```

Then update the template:

**Suppress "Beginning of session" for forks.** Change the existing marker at line ~226:

```svelte
{#if !historyState.hasMore && !historyState.loading && !isFork}
```

Replace the main message loop (inside the rewind click-delegation `<div>`) with fork-aware rendering:

```svelte
{#if forkSplit && forkSplit.inherited.length > 0}
	<!-- Forked session: show collapsible prior context -->
	<ForkContextBlock>
		{#each inheritedGrouped as msg (msg.uuid)}
			{@render messageItem(msg)}
		{/each}
	</ForkContextBlock>

	<ForkDivider
		parentTitle={parentSession?.title ?? "parent session"}
		parentId={activeSession?.parentID ?? ""}
	/>

	<!-- Render only current (post-fork) messages -->
	{#each currentGrouped as msg, i (msg.uuid)}
		{@render messageItem(msg)}
	{/each}
{:else}
	<!-- Normal (non-fork) rendering -->
	{#each groupedMessages as msg, i (msg.uuid)}
		{@render messageItem(msg)}
	{/each}
{/if}
```

**Important:** This block must remain inside the existing rewind click-delegation `<div onclick={...}>` wrapper.

Extract the message rendering into a Svelte snippet to avoid duplicating the switch logic:

```svelte
{#snippet messageItem(msg: GroupedMessage)}
	{#if msg.type === "user"}
		<div class="msg-container" class:rewind-point={uiState.rewindActive}>
			<UserMessage message={msg as UserMsg} />
		</div>
	{:else if msg.type === "assistant"}
		<div class="msg-container" class:rewind-point={uiState.rewindActive}>
			<AssistantMessage message={msg as AssistantMsg} />
		</div>
	{:else if msg.type === "thinking"}
		<div class="msg-container">
			<ThinkingBlock message={msg as ThinkingMessage} />
		</div>
	{:else if msg.type === "tool-group"}
		<div class="msg-container">
			<ToolGroupCard group={msg as ToolGroup} />
		</div>
	{:else if msg.type === "tool" && (msg as ToolMessage).name === "Skill"}
		<div class="msg-container">
			<SkillItem message={msg as ToolMessage} />
		</div>
	{:else if msg.type === "tool"}
		<div class="msg-container">
			<ToolItem message={msg as ToolMessage} />
		</div>
	{:else if msg.type === "result"}
		<div class="msg-container">
			<ResultBar message={msg as ResultMessage} />
		</div>
	{:else if msg.type === "system"}
		<div class="msg-container">
			<SystemMessage message={msg as SystemMsg} />
		</div>
	{/if}
{/snippet}
```

**Step 5: Run type check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: Pass.

**Step 6: Commit**

```bash
git add src/lib/frontend/utils/fork-split.ts test/unit/frontend/fork-split.test.ts src/lib/frontend/components/chat/MessageList.svelte
git commit -m "feat: split messages at fork point with collapsible inherited context"
```

---

### Task 9: Hide SubagentBackBar for user forks

**Files:**
- Modify: `src/lib/frontend/components/chat/SubagentBackBar.svelte:20`

**Step 1: Update visibility logic**

Change the `visible` derived to exclude user forks (sessions with `forkMessageId`):

```typescript
// Show for subagent sessions (parentID but no forkMessageId).
// Hide for user forks (parentID + forkMessageId) — they get the fork divider instead.
const visible = $derived(!!parentId && !activeSession?.forkMessageId);
```

**Step 2: Run type check**

Run: `pnpm check`
Expected: Pass.

**Step 3: Commit**

```bash
git add src/lib/frontend/components/chat/SubagentBackBar.svelte
git commit -m "feat: hide SubagentBackBar for user forks (show fork divider instead)"
```

---

### Task 10: Handle forkMessageId in frontend session store

**Files:**
- Modify: `src/lib/frontend/stores/session.svelte.ts:288-299` (handleSessionForked)
- Test: `test/unit/stores/session-store.test.ts`

**Step 1: Update handleSessionForked to capture forkMessageId**

The `session_forked` message from the server now includes `forkMessageId` on the session object. The existing `handleSessionForked` already adds the session to `allSessions` — the `forkMessageId` field will be carried through automatically since `SessionInfo` now has it.

Verify this by reading the code. If `handleSessionForked` destructures specific fields (losing `forkMessageId`), update it to spread the full session object.

**Step 2: Add test**

In `test/unit/stores/session-store.test.ts`, add a test in the `handleSessionForked` describe block:

```typescript
it("preserves forkMessageId on forked session", () => {
	handleSessionForked({
		type: "session_forked",
		session: {
			id: "fork-1",
			title: "Forked",
			updatedAt: Date.now(),
			parentID: "parent-1",
			forkMessageId: "msg_42",
		},
		parentId: "parent-1",
		parentTitle: "Parent",
	});
	const found = sessionState.allSessions.find((s) => s.id === "fork-1");
	expect(found?.forkMessageId).toBe("msg_42");
});
```

**Step 3: Run tests**

Run: `pnpm vitest run test/unit/stores/session-store.test.ts`
Expected: Pass.

**Step 4: Commit**

```bash
git add src/lib/frontend/stores/session.svelte.ts test/unit/stores/session-store.test.ts
git commit -m "feat: preserve forkMessageId in frontend session store"
```

---

### Task 11: Final verification

**Step 1: Run full verification suite**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: All pass.

**Step 2: Manual smoke test**

1. Fork a session using "Fork from here" on an assistant message
2. Verify the forked session shows:
   - Collapsible "Prior conversation (N messages)" block (collapsed by default)
   - Fork divider with "Forked from {parent title}" label
   - New messages below the divider
   - No SubagentBackBar
3. Expand the prior conversation block — inherited messages should render with a left border and slight dimming
4. Click the parent title in the fork divider — should navigate to parent session
5. Verify a subagent session still shows SubagentBackBar (no fork divider)
6. Restart the daemon and verify fork metadata survives (reload forked session, fork divider still works)
