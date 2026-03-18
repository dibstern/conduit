# Follow-Up Message Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to queue follow-up messages while Claude is processing, with auto-drain on completion, per-session FIFO queues persisted to localStorage.

**Architecture:** Client-side only — no server changes. A `queuedMessages` map (keyed by session ID) lives in the chat store, mirrored to localStorage. The InputArea shows both Send + Stop buttons during processing. Queued messages render as dimmed bubbles in the MessageList. On `done`, the queue auto-drains by sending the next message.

**Tech Stack:** TypeScript (ESM), Svelte 5 (runes: `$state`, `$derived`, `$props`, `$effect`), Vitest, Biome.

**Important Svelte 5 rules:** Use `$props()` not `export let`. Use `$derived()` not `$:`. Use `onclick={}` not `on:click={}`. Use `$state()` not `writable()`.

---

### Task 1: Add QueuedMessage Type and Queue State to Chat Store

**Files:**
- Modify: `src/lib/public/types.ts:53-59` (add QueuedMessage type)
- Modify: `src/lib/public/stores/chat.svelte.ts:17-29` (add queue state)
- Test: `test/unit/svelte-chat-store.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/svelte-chat-store.test.ts`:

```typescript
// ─── Message Queue ──────────────────────────────────────────────────────────

describe("message queue", () => {
	it("enqueueMessage adds to the queue for a session", () => {
		enqueueMessage("session-1", "follow-up text");
		const queue = getQueuedMessages("session-1");
		expect(queue).toHaveLength(1);
		expect(queue[0]!.text).toBe("follow-up text");
		expect(queue[0]!.sessionId).toBe("session-1");
		expect(queue[0]!.id).toBeTruthy();
		expect(queue[0]!.createdAt).toBeGreaterThan(0);
	});

	it("enqueueMessage preserves FIFO order", () => {
		enqueueMessage("s1", "first");
		enqueueMessage("s1", "second");
		enqueueMessage("s1", "third");
		const queue = getQueuedMessages("s1");
		expect(queue).toHaveLength(3);
		expect(queue[0]!.text).toBe("first");
		expect(queue[1]!.text).toBe("second");
		expect(queue[2]!.text).toBe("third");
	});

	it("queues are isolated per session", () => {
		enqueueMessage("s1", "for session 1");
		enqueueMessage("s2", "for session 2");
		expect(getQueuedMessages("s1")).toHaveLength(1);
		expect(getQueuedMessages("s2")).toHaveLength(1);
		expect(getQueuedMessages("s1")[0]!.text).toBe("for session 1");
		expect(getQueuedMessages("s2")[0]!.text).toBe("for session 2");
	});

	it("dequeueMessage removes and returns the first message", () => {
		enqueueMessage("s1", "first");
		enqueueMessage("s1", "second");
		const dequeued = dequeueMessage("s1");
		expect(dequeued!.text).toBe("first");
		expect(getQueuedMessages("s1")).toHaveLength(1);
		expect(getQueuedMessages("s1")[0]!.text).toBe("second");
	});

	it("dequeueMessage returns undefined for empty queue", () => {
		expect(dequeueMessage("s1")).toBeUndefined();
	});

	it("removeQueuedMessage removes by id", () => {
		enqueueMessage("s1", "keep");
		enqueueMessage("s1", "remove");
		const queue = getQueuedMessages("s1");
		const removeId = queue[1]!.id;
		removeQueuedMessage("s1", removeId);
		expect(getQueuedMessages("s1")).toHaveLength(1);
		expect(getQueuedMessages("s1")[0]!.text).toBe("keep");
	});

	it("clearQueueForSession removes all messages for a session", () => {
		enqueueMessage("s1", "a");
		enqueueMessage("s1", "b");
		enqueueMessage("s2", "c");
		clearQueueForSession("s1");
		expect(getQueuedMessages("s1")).toHaveLength(0);
		expect(getQueuedMessages("s2")).toHaveLength(1);
	});

	it("clearMessages also clears the queue for all sessions", () => {
		enqueueMessage("s1", "a");
		enqueueMessage("s2", "b");
		clearMessages();
		expect(getQueuedMessages("s1")).toHaveLength(0);
		expect(getQueuedMessages("s2")).toHaveLength(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/svelte-chat-store.test.ts`
Expected: FAIL — `enqueueMessage`, `dequeueMessage`, `removeQueuedMessage`, `clearQueueForSession`, `getQueuedMessages` are not exported.

**Step 3: Add QueuedMessage type**

In `src/lib/public/types.ts`, after the `SystemMessage` interface (line 114), add:

```typescript
// ─── Queued Message Types ────────────────────────────────────────────────────

export interface QueuedMessage {
	id: string;
	sessionId: string;
	text: string;
	createdAt: number;
}
```

**Step 4: Add queue state and functions to chat store**

In `src/lib/public/stores/chat.svelte.ts`:

Add import of `QueuedMessage` type at top:
```typescript
import type { QueuedMessage } from "../types.js";
```

After the `chatState` declaration (line 29), add:

```typescript
// ─── Message Queue State ────────────────────────────────────────────────────
// Per-session FIFO queue for follow-up messages sent while processing.

const queuedMessages = new Map<string, QueuedMessage[]>();

/** Get the queue for a given session (returns empty array if none). */
export function getQueuedMessages(sessionId: string): QueuedMessage[] {
	return queuedMessages.get(sessionId) ?? [];
}

/** Add a message to the queue for a session. */
export function enqueueMessage(sessionId: string, text: string): void {
	const msg: QueuedMessage = {
		id: generateUuid(),
		sessionId,
		text,
		createdAt: Date.now(),
	};
	const queue = queuedMessages.get(sessionId) ?? [];
	queue.push(msg);
	queuedMessages.set(sessionId, queue);
}

/** Remove and return the first message from a session's queue. */
export function dequeueMessage(sessionId: string): QueuedMessage | undefined {
	const queue = queuedMessages.get(sessionId);
	if (!queue || queue.length === 0) return undefined;
	return queue.shift();
}

/** Remove a specific queued message by ID. */
export function removeQueuedMessage(sessionId: string, messageId: string): void {
	const queue = queuedMessages.get(sessionId);
	if (!queue) return;
	const idx = queue.findIndex((m) => m.id === messageId);
	if (idx >= 0) queue.splice(idx, 1);
	if (queue.length === 0) queuedMessages.delete(sessionId);
}

/** Clear all queued messages for a session. */
export function clearQueueForSession(sessionId: string): void {
	queuedMessages.delete(sessionId);
}
```

Also modify `clearMessages()` to clear all queues:

```typescript
export function clearMessages(): void {
	chatState.messages = [];
	chatState.currentAssistantText = "";
	chatState.streaming = false;
	chatState.processing = false;
	toolUuidMap.clear();
	queuedMessages.clear();
	if (renderTimer !== null) {
		clearTimeout(renderTimer);
		renderTimer = null;
	}
}
```

**Step 5: Update test imports**

Add to the import block in `test/unit/svelte-chat-store.test.ts`:

```typescript
import {
	// ...existing imports...
	enqueueMessage,
	dequeueMessage,
	removeQueuedMessage,
	clearQueueForSession,
	getQueuedMessages,
} from "../../src/lib/public/stores/chat.svelte.js";
```

**Step 6: Run test to verify it passes**

Run: `pnpm vitest run test/unit/svelte-chat-store.test.ts`
Expected: All tests PASS.

**Step 7: Run full test suite and lint**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass.

**Step 8: Commit**

```bash
git add src/lib/public/types.ts src/lib/public/stores/chat.svelte.ts test/unit/svelte-chat-store.test.ts
git commit -m "feat: add message queue state to chat store"
```

---

### Task 2: localStorage Persistence for the Queue

**Files:**
- Create: `src/lib/public/stores/queue-persistence.ts`
- Modify: `src/lib/public/stores/chat.svelte.ts` (wire persistence into enqueue/dequeue/remove/clear)
- Test: `test/unit/queue-persistence.test.ts`

**Step 1: Write the failing test**

Create `test/unit/queue-persistence.test.ts`:

```typescript
// ─── Queue Persistence Tests ─────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../../src/lib/public/types.js";

// Mock localStorage
const store = new Map<string, string>();
const mockLocalStorage = {
	getItem: vi.fn((key: string) => store.get(key) ?? null),
	setItem: vi.fn((key: string, value: string) => store.set(key, value)),
	removeItem: vi.fn((key: string) => store.delete(key)),
};
vi.stubGlobal("localStorage", mockLocalStorage);

import {
	STORAGE_KEY,
	saveQueue,
	loadQueue,
	EXPIRY_MS,
} from "../../src/lib/public/stores/queue-persistence.js";

beforeEach(() => {
	store.clear();
	vi.clearAllMocks();
});

describe("saveQueue", () => {
	it("serializes queue map to localStorage", () => {
		const map = new Map<string, QueuedMessage[]>();
		map.set("s1", [
			{ id: "a", sessionId: "s1", text: "hello", createdAt: 1000 },
		]);
		saveQueue(map);
		expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
			STORAGE_KEY,
			expect.any(String),
		);
		const saved = JSON.parse(store.get(STORAGE_KEY)!);
		expect(saved).toHaveLength(1);
		expect(saved[0].text).toBe("hello");
	});

	it("removes key when map is empty", () => {
		const map = new Map<string, QueuedMessage[]>();
		saveQueue(map);
		expect(mockLocalStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
	});

	it("flattens all sessions into a single array", () => {
		const map = new Map<string, QueuedMessage[]>();
		map.set("s1", [
			{ id: "a", sessionId: "s1", text: "one", createdAt: 1000 },
		]);
		map.set("s2", [
			{ id: "b", sessionId: "s2", text: "two", createdAt: 2000 },
		]);
		saveQueue(map);
		const saved = JSON.parse(store.get(STORAGE_KEY)!);
		expect(saved).toHaveLength(2);
	});
});

describe("loadQueue", () => {
	it("returns empty map when nothing in storage", () => {
		const map = loadQueue();
		expect(map.size).toBe(0);
	});

	it("restores messages grouped by sessionId", () => {
		store.set(
			STORAGE_KEY,
			JSON.stringify([
				{ id: "a", sessionId: "s1", text: "one", createdAt: Date.now() },
				{ id: "b", sessionId: "s1", text: "two", createdAt: Date.now() },
				{ id: "c", sessionId: "s2", text: "three", createdAt: Date.now() },
			]),
		);
		const map = loadQueue();
		expect(map.get("s1")).toHaveLength(2);
		expect(map.get("s2")).toHaveLength(1);
	});

	it("filters out entries older than 1 week", () => {
		const oldTime = Date.now() - EXPIRY_MS - 1000;
		const newTime = Date.now();
		store.set(
			STORAGE_KEY,
			JSON.stringify([
				{ id: "old", sessionId: "s1", text: "old", createdAt: oldTime },
				{ id: "new", sessionId: "s1", text: "new", createdAt: newTime },
			]),
		);
		const map = loadQueue();
		expect(map.get("s1")).toHaveLength(1);
		expect(map.get("s1")![0]!.id).toBe("new");
	});

	it("handles corrupt JSON gracefully", () => {
		store.set(STORAGE_KEY, "not json");
		const map = loadQueue();
		expect(map.size).toBe(0);
	});

	it("handles non-array JSON gracefully", () => {
		store.set(STORAGE_KEY, JSON.stringify({ wrong: "shape" }));
		const map = loadQueue();
		expect(map.size).toBe(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/queue-persistence.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the persistence module**

Create `src/lib/public/stores/queue-persistence.ts`:

```typescript
// ─── Queue Persistence ───────────────────────────────────────────────────────
// Mirrors the in-memory message queue to localStorage for crash recovery.
// Flat array format: all sessions' messages in one JSON array.

import type { QueuedMessage } from "../types.js";

export const STORAGE_KEY = "opencode-relay:queued-messages";
export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

/** Save the entire queue map to localStorage. */
export function saveQueue(map: Map<string, QueuedMessage[]>): void {
	const all: QueuedMessage[] = [];
	for (const queue of map.values()) {
		all.push(...queue);
	}
	if (all.length === 0) {
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch {
			// Ignore storage errors (e.g. private browsing)
		}
		return;
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
	} catch {
		// Ignore storage errors
	}
}

/** Load the queue from localStorage, filtering out expired entries. */
export function loadQueue(): Map<string, QueuedMessage[]> {
	const map = new Map<string, QueuedMessage[]>();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return map;

		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return map;

		const cutoff = Date.now() - EXPIRY_MS;
		for (const entry of parsed) {
			if (
				typeof entry !== "object" ||
				entry === null ||
				typeof entry.id !== "string" ||
				typeof entry.sessionId !== "string" ||
				typeof entry.text !== "string" ||
				typeof entry.createdAt !== "number"
			) {
				continue;
			}
			if (entry.createdAt < cutoff) continue;

			const msg: QueuedMessage = {
				id: entry.id,
				sessionId: entry.sessionId,
				text: entry.text,
				createdAt: entry.createdAt,
			};
			const queue = map.get(msg.sessionId) ?? [];
			queue.push(msg);
			map.set(msg.sessionId, queue);
		}
	} catch {
		// Corrupt or unavailable — return empty
	}
	return map;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/queue-persistence.test.ts`
Expected: All PASS.

**Step 5: Wire persistence into chat store**

In `src/lib/public/stores/chat.svelte.ts`, import the persistence module:

```typescript
import { saveQueue, loadQueue } from "./queue-persistence.js";
```

Initialize `queuedMessages` from localStorage on module load:

```typescript
const queuedMessages = loadQueue();
```

Add `saveQueue(queuedMessages)` at the end of `enqueueMessage`, `dequeueMessage`, `removeQueuedMessage`, `clearQueueForSession`, and in the `queuedMessages.clear()` call in `clearMessages()`.

**Step 6: Run full test suite**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/lib/public/stores/queue-persistence.ts src/lib/public/stores/chat.svelte.ts test/unit/queue-persistence.test.ts
git commit -m "feat: add localStorage persistence for message queue"
```

---

### Task 3: Auto-Drain on Done Event

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts:358-361` (add drain logic after handleDone)
- Test: `test/unit/svelte-chat-store.test.ts` (add drain tests)

**Step 1: Write the failing test**

Add to `test/unit/svelte-chat-store.test.ts`:

```typescript
describe("auto-drain on done", () => {
	it("drainQueue sends first queued message and returns it", () => {
		enqueueMessage("s1", "follow-up");
		const drained = dequeueMessage("s1");
		expect(drained).toBeDefined();
		expect(drained!.text).toBe("follow-up");
		expect(getQueuedMessages("s1")).toHaveLength(0);
	});

	it("drainQueue returns undefined when queue is empty", () => {
		const drained = dequeueMessage("s1");
		expect(drained).toBeUndefined();
	});
});
```

These tests verify the dequeue primitive. The actual drain wiring (calling `wsSend` + `addUserMessage` on `done`) needs an integration-level test.

**Step 2: Run test to verify it passes (these use existing primitives)**

Run: `pnpm vitest run test/unit/svelte-chat-store.test.ts`
Expected: PASS (these test existing dequeue behavior).

**Step 3: Wire drain into ws.svelte.ts**

In `src/lib/public/stores/ws.svelte.ts`, add imports:

```typescript
import {
	// ...existing...
	dequeueMessage,
	addUserMessage,
} from "./chat.svelte.js";
import { sessionState } from "./session.svelte.js";
```

In the `case "done":` handler (around line 358-361), modify to:

```typescript
case "done":
	handleDone(msg);
	triggerNotifications(msg);
	// Auto-drain: if the active session has queued follow-up messages,
	// send the next one after a brief delay to let the UI settle.
	if (sessionState.currentId) {
		const next = dequeueMessage(sessionState.currentId);
		if (next) {
			addUserMessage(next.text);
			wsSend({ type: "message", text: next.text });
		}
	}
	break;
```

**Step 4: Run full test suite**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/lib/public/stores/ws.svelte.ts
git commit -m "feat: auto-drain message queue on done event"
```

---

### Task 4: Drain on Session Switch to Idle

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts:380-411` (session_switched handler)
- Test: `test/unit/regression-session-switch-history.test.ts` (or new test file)

**Step 1: Write the failing test**

This is best tested as an integration test in the existing session-switch regression test file. Add to `test/unit/regression-session-switch-history.test.ts`:

```typescript
describe("queue drain on session switch", () => {
	it("drains queue when switching to session with queued messages and idle state", () => {
		// Setup: queue a message for session-b while it's not active
		enqueueMessage("session-b", "follow-up for b");

		// Switch to session-b (which is idle — no processing status in events)
		handleMessage({
			type: "session_switched",
			id: "session-b",
		} as RelayMessage);

		// The queued message should have been sent
		expect(getQueuedMessages("session-b")).toHaveLength(0);
	});
});
```

**Step 2: Implement drain on session switch**

In `src/lib/public/stores/ws.svelte.ts`, in the `case "session_switched":` handler, after the existing replay/history logic (around line 410), add:

```typescript
// Drain queue if the switched-to session is idle and has queued messages
if (msg.id && !chatState.processing) {
	const next = dequeueMessage(msg.id);
	if (next) {
		addUserMessage(next.text);
		wsSend({ type: "message", text: next.text });
	}
}
```

**Step 3: Run tests**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/lib/public/stores/ws.svelte.ts test/unit/regression-session-switch-history.test.ts
git commit -m "feat: drain message queue on session switch to idle"
```

---

### Task 5: InputArea — Show Send + Stop Buttons During Processing

**Files:**
- Modify: `src/lib/public/components/layout/InputArea.svelte:30-101,270-295`
- Test: Manual verification + existing E2E tests should still pass

**Step 1: Modify InputArea to support queueing**

In `src/lib/public/components/layout/InputArea.svelte`:

Add imports:

```typescript
import {
	chatState,
	addUserMessage,
	enqueueMessage,
	getQueuedMessages,
} from "../../stores/chat.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
```

Replace the derived values (lines 32-34):

```typescript
const isProcessing = $derived(chatState.processing);
const canSend = $derived(inputText.trim().length > 0);
const canSendDirect = $derived(canSend && !isProcessing);
```

Replace `sendMessage()` (lines 77-89):

```typescript
function sendMessage() {
	const text = inputText.trim();
	if (!text) return;

	if (isProcessing) {
		// Queue the message for later
		const sessionId = sessionState.currentId;
		if (sessionId) {
			enqueueMessage(sessionId, text);
		}
	} else {
		// Send immediately
		addUserMessage(text);
		wsSend({ type: "message", text });
	}

	inputText = "";
	if (textareaEl) {
		textareaEl.style.height = "auto";
	}
}
```

Replace `handleSendClick()` (lines 95-101) — now it only sends/queues:

```typescript
function handleSendClick() {
	sendMessage();
}
```

Add a separate stop handler for the stop button:

```typescript
function handleStopClick() {
	handleStop();
}
```

Replace the button section (lines 274-295) with both buttons:

```svelte
<!-- Send / Stop buttons -->
<button
	id="send"
	class="send-btn shrink-0 w-9 h-9 rounded-full border-none bg-accent text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:bg-accent-hover disabled:opacity-25 disabled:cursor-default active:not-disabled:opacity-70"
	disabled={!canSend}
	title={isProcessing ? "Queue message" : "Send message"}
	onclick={handleSendClick}
>
	<Icon name="arrow-up" size={18} />
</button>
{#if isProcessing}
	<button
		id="stop"
		class="shrink-0 w-9 h-9 rounded-full bg-transparent border border-border text-text-muted cursor-pointer flex items-center justify-center transition-[background,color,opacity] duration-150 touch-manipulation hover:bg-black/[0.04] hover:text-text active:opacity-70"
		title="Stop generating"
		onclick={handleStopClick}
	>
		<Icon name="square" size={18} />
	</button>
{/if}
```

**Step 2: Update Enter key handler**

The `handleKeydown` function (line 67-74) calls `sendMessage()` which now handles both direct send and queue. No change needed here — the `sendMessage()` refactor covers it.

**Step 3: Run tests**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass. Some E2E tests that look for `#send` by ID may need attention if they expect the stop button behavior, but the `#send` ID is still on the send button.

**Step 4: Commit**

```bash
git add src/lib/public/components/layout/InputArea.svelte
git commit -m "feat: show Send + Stop buttons during processing, queue follow-ups"
```

---

### Task 6: QueuedMessage Bubble Component

**Files:**
- Create: `src/lib/public/components/chat/QueuedMessageBubble.svelte`
- Test: Visual inspection (component is presentational)

**Step 1: Create the component**

Create `src/lib/public/components/chat/QueuedMessageBubble.svelte`:

```svelte
<!-- ─── Queued Message Bubble ──────────────────────────────────────────────── -->
<!-- Dimmed user bubble for queued follow-up messages. Shows cancel button. -->

<script lang="ts">
	import type { QueuedMessage } from "../../types.js";
	import { escapeHtml } from "../../utils/format.js";
	import Icon from "../shared/Icon.svelte";

	let { message, onCancel }: {
		message: QueuedMessage;
		onCancel: (id: string) => void;
	} = $props();
</script>

<div
	class="msg-queued flex justify-end max-w-[760px] mx-auto mb-4 px-5 opacity-50"
	data-queued-id={message.id}
>
	<div class="relative group">
		<div
			class="bubble bg-user-bubble rounded-[20px_20px_4px_20px] py-3 px-[18px] max-w-[85%] text-[15px] leading-[1.55] break-words whitespace-pre-wrap text-text border border-dashed border-border max-md:max-w-[90%]"
		>
			{@html escapeHtml(message.text)}
		</div>
		<div class="flex items-center justify-end gap-2 mt-1 pr-1">
			<span class="text-text-muted text-xs font-sans">queued</span>
			<button
				class="w-5 h-5 rounded-full bg-transparent border-none text-text-muted cursor-pointer flex items-center justify-center transition-[color,background] duration-150 hover:text-text hover:bg-black/[0.06] max-md:opacity-100 opacity-0 group-hover:opacity-100"
				title="Remove from queue"
				onclick={() => onCancel(message.id)}
			>
				<Icon name="x" size={12} />
			</button>
		</div>
	</div>
</div>
```

**Step 2: Run lint and type check**

Run: `pnpm check && pnpm lint`
Expected: Pass.

**Step 3: Commit**

```bash
git add src/lib/public/components/chat/QueuedMessageBubble.svelte
git commit -m "feat: add QueuedMessageBubble component"
```

---

### Task 7: Render Queued Messages in MessageList

**Files:**
- Modify: `src/lib/public/components/chat/MessageList.svelte:130-157`
- Modify: `src/lib/public/stores/chat.svelte.ts` (need reactive getter for active session queue)

**Step 1: Make queue state reactive**

The `queuedMessages` Map is not reactive because Svelte 5 `$state` doesn't deeply track Maps. We need a reactive signal that components can depend on. Add to `src/lib/public/stores/chat.svelte.ts`:

```typescript
// ─── Reactive Queue Version ──────────────────────────────────────────────────
// Components can depend on this to re-render when the queue changes.
// Bump after every mutation.

let _queueVersion = $state(0);

/** Reactive getter: returns queued messages for a session. Tracks changes. */
export function getQueuedMessagesReactive(sessionId: string): QueuedMessage[] {
	// Touch version to create reactive dependency
	const _v = _queueVersion;
	return queuedMessages.get(sessionId) ?? [];
}
```

Then add `_queueVersion++` at the end of `enqueueMessage`, `dequeueMessage`, `removeQueuedMessage`, `clearQueueForSession`, and the clear in `clearMessages`.

**Step 2: Modify MessageList to render queued bubbles**

In `src/lib/public/components/chat/MessageList.svelte`:

Add imports:

```typescript
import { getQueuedMessagesReactive, removeQueuedMessage } from "../../stores/chat.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import QueuedMessageBubble from "./QueuedMessageBubble.svelte";
```

Add derived for queued messages:

```typescript
const queuedForSession = $derived(
	sessionState.currentId ? getQueuedMessagesReactive(sessionState.currentId) : []
);
```

After the live message list `</div>` (around line 157), before the pending permission requests, add:

```svelte
<!-- Queued follow-up messages (pending send) -->
{#each queuedForSession as qMsg (qMsg.id)}
	<QueuedMessageBubble
		message={qMsg}
		onCancel={(id) => {
			if (sessionState.currentId) {
				removeQueuedMessage(sessionState.currentId, id);
			}
		}}
	/>
{/each}
```

Also update the auto-scroll `$effect` to track queued messages:

```typescript
$effect(() => {
	const _len = chatState.messages.length;
	const _permLen = permissionsState.pendingPermissions.length;
	const _qLen = permissionsState.pendingQuestions.length;
	const _queued = queuedForSession.length;
	tick().then(scrollToBottom);
});
```

**Step 3: Run full test suite**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/lib/public/stores/chat.svelte.ts src/lib/public/components/chat/MessageList.svelte
git commit -m "feat: render queued messages in MessageList"
```

---

### Task 8: Integration Test — Full Queue Flow

**Files:**
- Create: `test/unit/message-queue-flow.test.ts`

**Step 1: Write integration tests**

Create `test/unit/message-queue-flow.test.ts`:

```typescript
// ─── Message Queue Flow Integration Tests ────────────────────────────────────
// Tests the full enqueue → done → auto-drain flow through the ws dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	enqueueMessage,
	getQueuedMessages,
	handleStatus,
} from "../../src/lib/public/stores/chat.svelte.js";
import { sessionState } from "../../src/lib/public/stores/session.svelte.js";
import { handleMessage } from "../../src/lib/public/stores/ws.svelte.js";
import type { RelayMessage } from "../../src/lib/public/types.js";

beforeEach(() => {
	clearMessages();
	sessionState.currentId = "test-session";
});

afterEach(() => {
	clearMessages();
	sessionState.currentId = null;
});

describe("full queue flow", () => {
	it("queued message is sent when done event arrives", () => {
		// Simulate processing state
		chatState.processing = true;

		// Queue a follow-up
		enqueueMessage("test-session", "follow-up question");
		expect(getQueuedMessages("test-session")).toHaveLength(1);

		// Receive done event
		handleMessage({ type: "done", code: 0 } as RelayMessage);

		// Queue should be drained
		expect(getQueuedMessages("test-session")).toHaveLength(0);

		// User message should appear in chat
		const userMessages = chatState.messages.filter((m) => m.type === "user");
		expect(userMessages).toHaveLength(1);
		expect(userMessages[0]!.text).toBe("follow-up question");
	});

	it("multiple queued messages drain one at a time", () => {
		chatState.processing = true;

		enqueueMessage("test-session", "first");
		enqueueMessage("test-session", "second");
		enqueueMessage("test-session", "third");

		// First done — drains "first"
		handleMessage({ type: "done", code: 0 } as RelayMessage);
		expect(getQueuedMessages("test-session")).toHaveLength(2);
		expect(chatState.messages.filter((m) => m.type === "user")).toHaveLength(1);

		// Second done — drains "second"
		handleMessage({ type: "done", code: 0 } as RelayMessage);
		expect(getQueuedMessages("test-session")).toHaveLength(1);

		// Third done — drains "third"
		handleMessage({ type: "done", code: 0 } as RelayMessage);
		expect(getQueuedMessages("test-session")).toHaveLength(0);
		expect(chatState.messages.filter((m) => m.type === "user")).toHaveLength(3);
	});

	it("does not drain for a different session", () => {
		chatState.processing = true;
		enqueueMessage("other-session", "queued for other");

		handleMessage({ type: "done", code: 0 } as RelayMessage);

		// Should not drain — different session
		expect(getQueuedMessages("other-session")).toHaveLength(1);
	});

	it("stop + drain: abort triggers auto-send of queued message", () => {
		chatState.processing = true;
		enqueueMessage("test-session", "after stop");

		// Simulate abort done (code 1)
		handleMessage({ type: "done", code: 1 } as RelayMessage);

		// Queue should drain even after abort
		expect(getQueuedMessages("test-session")).toHaveLength(0);
		const userMessages = chatState.messages.filter((m) => m.type === "user");
		expect(userMessages).toHaveLength(1);
		expect(userMessages[0]!.text).toBe("after stop");
	});

	it("empty queue on done does nothing", () => {
		chatState.processing = true;
		handleMessage({ type: "done", code: 0 } as RelayMessage);
		expect(chatState.messages.filter((m) => m.type === "user")).toHaveLength(0);
	});
});
```

**Step 2: Run tests**

Run: `pnpm vitest run test/unit/message-queue-flow.test.ts`
Expected: All PASS.

**Step 3: Run full suite**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass.

**Step 4: Commit**

```bash
git add test/unit/message-queue-flow.test.ts
git commit -m "test: add integration tests for message queue flow"
```

---

### Task 9: Final Polish and Edge Cases

**Files:**
- Modify: `src/lib/public/components/layout/InputArea.svelte` (Enter key hint)
- Verify: All tests pass, lint clean

**Step 1: Update Enter key hint during processing**

In `InputArea.svelte`, make the `enterkeyhint` dynamic on the textarea:

```svelte
<textarea
	...
	enterkeyhint={isProcessing ? "send" : "send"}
></textarea>
```

Actually, `enterkeyhint="send"` is correct in both cases — we're always sending (either directly or to queue). No change needed.

**Step 2: Verify the title on the send button updates**

Already handled in Task 5 — `title={isProcessing ? "Queue message" : "Send message"}`.

**Step 3: Run the full test suite one final time**

Run: `pnpm test && pnpm check && pnpm lint`
Expected: All pass.

**Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: final polish for follow-up message queue"
```

---

## Summary of Files Changed

| File | Action |
|------|--------|
| `src/lib/public/types.ts` | Add `QueuedMessage` interface |
| `src/lib/public/stores/chat.svelte.ts` | Add queue state, enqueue/dequeue/remove/clear functions, reactive version, localStorage wiring |
| `src/lib/public/stores/queue-persistence.ts` | NEW — save/load queue to/from localStorage |
| `src/lib/public/stores/ws.svelte.ts` | Add auto-drain on `done`, drain on `session_switched` |
| `src/lib/public/components/layout/InputArea.svelte` | Show Send + Stop buttons, queue during processing |
| `src/lib/public/components/chat/QueuedMessageBubble.svelte` | NEW — dimmed pending bubble with cancel |
| `src/lib/public/components/chat/MessageList.svelte` | Render queued bubbles from queue state |
| `test/unit/svelte-chat-store.test.ts` | Add queue operation tests |
| `test/unit/queue-persistence.test.ts` | NEW — localStorage persistence tests |
| `test/unit/message-queue-flow.test.ts` | NEW — integration tests for full flow |
