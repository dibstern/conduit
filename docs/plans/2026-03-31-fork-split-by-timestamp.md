# Fork Split by Timestamp — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix fork session rendering so new messages appear below the fork divider by splitting inherited vs current messages using the fork-point message's timestamp.

**Architecture:** OpenCode assigns new message IDs when forking (`MessageID.ascending()`), so ID-based matching is unreliable. Instead, we anchor to the fork-point message's `time.created` timestamp. OpenCode preserves original timestamps when copying messages during fork (`...msg.info` spread). Inherited messages have `createdAt < forkPointTimestamp`; current messages have `createdAt >= forkPointTimestamp`. This is self-describing per message, so it works naturally with pagination (any page, any message) and live messages (no `createdAt` = always current). One timestamp stored per fork session.

**Tech Stack:** TypeScript, Svelte 5, Vitest (unit), Playwright (E2E replay)

---

### Task 1: Add `forkPointTimestamp` to `ForkEntry` and capture at fork time

**Files:**
- Modify: `src/lib/daemon/fork-metadata.ts:9-12` (extend `ForkEntry`)
- Modify: `src/lib/handlers/session.ts:340-375` (capture timestamp at fork time)
- Modify: `src/lib/handlers/types.ts:87-95` (update `HandlerDeps.forkMeta` types)
- Modify: `test/unit/handlers/handlers-session.test.ts` (update mock types + add assertion)

**Step 1: Extend `ForkEntry` with `forkPointTimestamp`**

In `src/lib/daemon/fork-metadata.ts`, add to the interface:

```typescript
export interface ForkEntry {
	forkMessageId: string;
	parentID: string;
	/** Unix-ms timestamp of the fork-point message. Messages with
	 *  time.created < this value are inherited from the parent session. */
	forkPointTimestamp?: number;
}
```

Optional (`?`) for backward compat with existing persisted metadata.

**Step 2: Update `HandlerDeps.forkMeta` types to use `ForkEntry`**

In `src/lib/handlers/types.ts`, import `ForkEntry` and use it instead of inline types:

```typescript
import type { ForkEntry } from "../daemon/fork-metadata.js";

// In HandlerDeps:
	forkMeta: {
		setForkEntry: (sessionId: string, entry: ForkEntry) => void;
		getForkEntry: (sessionId: string) => ForkEntry | undefined;
	};
```

This replaces the inline `{ forkMessageId: string; parentID: string }` duplications.

**Step 3: Capture fork-point timestamp in `handleForkSession`**

In `src/lib/handlers/session.ts`, in `handleForkSession`, after the fork is created, determine the fork-point timestamp.

For **specific-message forks** (`messageId` provided): fetch the message from the parent session to get its `time.created`.
For **whole-session forks** (no `messageId`): use the forked session's `time.created`.

Replace the "Determine the fork-point messageId" block (current lines ~353-375) with:

```typescript
	// Determine fork-point metadata.
	// forkPointTimestamp is the primary split anchor (reliable across ID changes).
	// forkMessageId is kept for backward compat / debugging.
	let forkMessageId: string | undefined = messageId;
	let forkPointTimestamp: number | undefined;

	if (messageId) {
		// Specific-message fork: look up the fork-point message's timestamp from the parent.
		// getMessage fetches exactly one message by ID (no pagination needed).
		try {
			const forkMsg = await deps.client.getMessage(sessionId, messageId);
			if (forkMsg?.time?.created) {
				forkPointTimestamp = forkMsg.time.created;
			}
		} catch {
			deps.log.warn(`Could not look up fork-point message ${messageId} in ${sessionId}`);
		}
	} else {
		// Whole-session fork: use the forked session's creation time as the boundary.
		// All inherited messages have time.created < this value.
		forkPointTimestamp = forked.time?.created ?? forked.time?.updated;

		// Also capture the last message ID for backward compat.
		try {
			const msgs = await deps.client.getMessagesPage(forked.id, { limit: 1 });
			if (msgs.length > 0) {
				forkMessageId = msgs[msgs.length - 1]!.id;
			}
		} catch {
			deps.log.warn(`Could not determine fork-point for ${forked.id}`);
		}
	}

	// Persist fork-point metadata
	if (forkMessageId || forkPointTimestamp) {
		deps.forkMeta.setForkEntry(forked.id, {
			forkMessageId: forkMessageId ?? "",
			parentID: sessionId,
			...(forkPointTimestamp != null && { forkPointTimestamp }),
		});
	}
```

**Step 4: Update test mock types**

In `test/unit/handlers/handlers-session.test.ts`, the inline `forkMeta` mocks use inline types. Update them to accept the new `ForkEntry` shape. The `setForkEntry` mocks should accept `forkPointTimestamp`. In the test "stores forkMessageId from messageId payload" (line ~186), add a `getMessage` mock for the parent session that returns the fork-point message with `time: { created: 1000 }`, and assert `forkPointTimestamp` is stored correctly.

In `test/helpers/mock-factories.ts`, `forkMeta` already uses `vi.fn()` — no type change needed there since the mock factory returns `HandlerDeps` which will pick up the new type via the `ForkEntry` import.

Note: the plan uses `deps.client.getMessage(sessionId, messageId)` — ensure the mock client factory includes `getMessage`.

**Step 5: Run type check and tests**

Run: `pnpm check && pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: PASS

---

### Task 2: Thread `forkPointTimestamp` to frontend via `SessionInfo`

**Files:**
- Modify: `src/lib/shared-types.ts:139-152` (add to `SessionInfo`)
- Modify: `src/lib/session/session-manager.ts:~577-585` (wire in `toSessionInfoList`)
- Modify: `src/lib/handlers/session.ts:~387-395` (include in `session_forked` broadcast)

**Step 1: Add to `SessionInfo`**

In `src/lib/shared-types.ts`, add to `SessionInfo`:

```typescript
	/** Unix-ms timestamp of the fork-point message. Messages created before
	 *  this time are inherited context from the parent session. */
	forkPointTimestamp?: number;
```

**Step 2: Wire in `toSessionInfoList`**

In `src/lib/session/session-manager.ts`, in `toSessionInfoList` (around line 583), after the `forkMessageId` spread:

```typescript
				...(forkEntry?.forkPointTimestamp != null && {
					forkPointTimestamp: forkEntry.forkPointTimestamp,
				}),
```

**Step 3: Include in `session_forked` broadcast**

In `src/lib/handlers/session.ts`, in the `session_forked` broadcast (line ~387), add to the session object:

```typescript
			...(forkPointTimestamp != null && { forkPointTimestamp }),
```

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

---

### Task 3: Propagate `createdAt` through `historyToChatMessages`

**Files:**
- Modify: `src/lib/frontend/types.ts` (add `createdAt` to ChatMessage types)
- Modify: `src/lib/frontend/utils/history-logic.ts:154-310` (propagate `time.created`)
- Test: `test/unit/frontend/history-logic.test.ts` (add assertion)

**Step 1: Add `createdAt` to ChatMessage types**

In `src/lib/frontend/types.ts`, add `createdAt?: number` to the relevant message types. The types that need it are those produced by `historyToChatMessages`: `UserMessage`, `AssistantMessage`, `ThinkingMessage`, `ToolMessage`, `ResultMessage`.

The cleanest approach: add it to each individual type (since they don't share a base interface). For each type that `historyToChatMessages` produces, add:

```typescript
	/** Unix-ms timestamp from the source HistoryMessage. Used for timestamp-based fork splitting. */
	createdAt?: number;
```

Add to: `UserMessage`, `AssistantMessage`, `ThinkingMessage`, `ToolMessage`, `ResultMessage`.
Do NOT add to: `SystemMessage` (not from history).

**Step 2: Propagate in `historyToChatMessages`**

In `src/lib/frontend/utils/history-logic.ts`, the main `historyToChatMessages` function iterates `HistoryMessage[]`. Each message has `msg.time?.created`. Pass it through to all ChatMessages produced from that HistoryMessage.

For user messages (line ~266):
```typescript
			result.push({
				type: "user",
				uuid: generateUuid(),
				text: extractDisplayText(text),
				...(msg.time?.created != null && { createdAt: msg.time.created }),
			} satisfies UserMessage);
```

For `convertAssistantParts`, add a `createdAt?: number` parameter and spread it into every ChatMessage the function produces:

Change the signature:
```typescript
function convertAssistantParts(
	parts: HistoryMessagePart[],
	renderHtml?: (text: string) => string,
	messageId?: string,
	createdAt?: number,
): ChatMessage[] {
```

And in each `result.push(...)` within the function (for `"text"` / AssistantMessage and `"reasoning"` / ThinkingMessage), add:
```typescript
				...(createdAt != null && { createdAt }),
```

For `"tool"` parts: tool messages are created via `createToolMessage()` in `src/lib/frontend/utils/tool-message-factory.ts`. Update that factory to accept and pass through `createdAt?: number`. Add it to the factory's input parameter type and spread it into the returned ToolMessage.

At the call site (line ~274):
```typescript
				result.push(
					...convertAssistantParts(msg.parts, renderHtml, msg.id, msg.time?.created),
				);
```

For ResultMessage (line ~289):
```typescript
				...(msg.time?.created != null && { createdAt: msg.time.created }),
```

**Step 3: Add test assertion**

In `test/unit/frontend/history-logic.test.ts`, find an existing test for `historyToChatMessages` and add an assertion that `createdAt` is propagated:

```typescript
		expect(result[0]).toHaveProperty("createdAt", 1000);
```

(Use the timestamp from the test fixture's HistoryMessage.)

**Step 4: Run type check and tests**

Run: `pnpm check && pnpm vitest run test/unit/frontend/history-logic.test.ts`
Expected: PASS

---

### Task 4: Rewrite `splitAtForkPoint` to use timestamp-based split

**Files:**
- Modify: `src/lib/frontend/utils/fork-split.ts` (rewrite)
- Modify: `src/lib/frontend/components/chat/MessageList.svelte:182-186` (update call site)
- Test: `test/unit/frontend/fork-split.test.ts` (add/update tests)

**Step 1: Rewrite `splitAtForkPoint`**

Replace the current implementation:

```typescript
/**
 * Split messages at the fork boundary using the fork-point timestamp.
 *
 * Messages with `createdAt < forkPointTimestamp` are inherited from the parent.
 * Messages with `createdAt >= forkPointTimestamp` (or no `createdAt`, e.g. live
 * messages from SSE) are current (new in the fork).
 *
 * Falls back to forkMessageId matching for sessions without forkPointTimestamp.
 */
export function splitAtForkPoint(
	messages: ChatMessage[],
	forkMessageId?: string,
	forkPointTimestamp?: number,
): ForkSplit {
	// Primary: timestamp-based split (reliable — each message self-identifies).
	// Assumes messages are in chronological order (REST history is chronological;
	// live messages are appended in order; pagination prepends older messages).
	if (forkPointTimestamp != null) {
		// Find the last message that is inherited (createdAt < forkPointTimestamp).
		// Messages without createdAt (live SSE messages) are always current.
		// Note: the fork-point message itself is EXCLUDED from the forked session
		// by OpenCode (id >= messageID → break), so no message will have
		// createdAt === forkPointTimestamp. Strict < is correct.
		let splitIndex = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]!;
			if ("createdAt" in msg && typeof msg.createdAt === "number" && msg.createdAt < forkPointTimestamp) {
				splitIndex = i + 1; // include this message in inherited
			}
		}
		return {
			inherited: messages.slice(0, splitIndex),
			current: messages.slice(splitIndex),
		};
	}

	// Fallback: ID-based matching for sessions created before timestamp tracking.
	if (!forkMessageId) {
		return { inherited: messages, current: [] };
	}

	let splitIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if ("messageId" in msg && msg.messageId === forkMessageId) {
			splitIndex = i;
			break;
		}
	}

	if (splitIndex === -1) {
		return { inherited: messages, current: [] };
	}

	// Include the full turn (up to next user message).
	let endOfTurn = splitIndex;
	for (let i = splitIndex + 1; i < messages.length; i++) {
		if (messages[i]?.type === "user") break;
		endOfTurn = i;
	}

	return {
		inherited: messages.slice(0, endOfTurn + 1),
		current: messages.slice(endOfTurn + 1),
	};
}
```

**Step 2: Update MessageList.svelte call site**

```svelte
	const forkSplit = $derived(
		isFork
			? splitAtForkPoint(
					chatState.messages,
					activeSession?.forkMessageId,
					activeSession?.forkPointTimestamp,
				)
			: null,
	);
```

The `isFork` check should also consider `forkPointTimestamp`:

```svelte
	const isFork = $derived(!!activeSession?.forkMessageId || !!activeSession?.forkPointTimestamp);
```

Also update `SubagentBackBar.svelte` — its visibility check at line 22 only checks `!activeSession?.forkMessageId`. Update it to also check `forkPointTimestamp`:

```svelte
	const visible = $derived(!!parentId && !activeSession?.forkMessageId && !activeSession?.forkPointTimestamp);
```

This ensures fork sessions with only `forkPointTimestamp` don't show BOTH the subagent back bar AND the fork divider.

**Step 3: Write unit tests**

In `test/unit/frontend/fork-split.test.ts`, add tests:

```typescript
describe("splitAtForkPoint — timestamp-based", () => {
	it("splits by timestamp: inherited < forkPointTimestamp, current >= forkPointTimestamp", () => {
		const messages: ChatMessage[] = [
			{ type: "user", uuid: "u1", text: "inherited q", createdAt: 1000 },
			{ type: "assistant", uuid: "a1", rawText: "inherited a", html: "", finalized: true, createdAt: 1000 },
			{ type: "user", uuid: "u2", text: "current q", createdAt: 2000 },
			{ type: "assistant", uuid: "a2", rawText: "current a", html: "", finalized: true, createdAt: 2000 },
		];
		const result = splitAtForkPoint(messages, undefined, 1500);
		expect(result.inherited).toHaveLength(2);
		expect(result.current).toHaveLength(2);
	});

	it("messages without createdAt (live SSE) are always current", () => {
		const messages: ChatMessage[] = [
			{ type: "user", uuid: "u1", text: "inherited", createdAt: 1000 },
			{ type: "assistant", uuid: "a1", rawText: "inherited", html: "", finalized: true, createdAt: 1000 },
			{ type: "user", uuid: "u2", text: "live msg" }, // no createdAt
			{ type: "assistant", uuid: "a2", rawText: "live resp", html: "", finalized: true }, // no createdAt
		];
		const result = splitAtForkPoint(messages, undefined, 1500);
		expect(result.inherited).toHaveLength(2);
		expect(result.current).toHaveLength(2);
	});

	it("all messages inherited when all have createdAt < forkPointTimestamp", () => {
		const messages: ChatMessage[] = [
			{ type: "user", uuid: "u1", text: "old", createdAt: 500 },
			{ type: "assistant", uuid: "a1", rawText: "old", html: "", finalized: true, createdAt: 500 },
		];
		const result = splitAtForkPoint(messages, undefined, 1000);
		expect(result.inherited).toHaveLength(2);
		expect(result.current).toHaveLength(0);
	});

	it("all messages current when none have createdAt < forkPointTimestamp", () => {
		const messages: ChatMessage[] = [
			{ type: "user", uuid: "u1", text: "new", createdAt: 2000 },
		];
		const result = splitAtForkPoint(messages, undefined, 1000);
		expect(result.inherited).toHaveLength(0);
		expect(result.current).toHaveLength(1);
	});

	it("works with pagination (older inherited messages prepended)", () => {
		const messages: ChatMessage[] = [
			// Paginated older messages
			{ type: "user", uuid: "u0", text: "very old", createdAt: 100 },
			{ type: "assistant", uuid: "a0", rawText: "very old", html: "", finalized: true, createdAt: 100 },
			// Initial page
			{ type: "user", uuid: "u1", text: "inherited", createdAt: 900 },
			{ type: "assistant", uuid: "a1", rawText: "inherited", html: "", finalized: true, createdAt: 900 },
			// Current (post-fork)
			{ type: "user", uuid: "u2", text: "current", createdAt: 2000 },
		];
		const result = splitAtForkPoint(messages, undefined, 1000);
		expect(result.inherited).toHaveLength(4);
		expect(result.current).toHaveLength(1);
	});

	it("falls back to ID matching when forkPointTimestamp is undefined", () => {
		const messages: ChatMessage[] = [
			{ type: "assistant", uuid: "a1", rawText: "old", html: "", finalized: true, messageId: "msg_fork" },
			{ type: "user", uuid: "u1", text: "new" },
		];
		const result = splitAtForkPoint(messages, "msg_fork", undefined);
		expect(result.inherited).toHaveLength(1);
		expect(result.current).toHaveLength(1);
	});
});
```

**Step 4: Run tests**

Run: `pnpm check && pnpm vitest run test/unit/frontend/fork-split.test.ts`
Expected: PASS

---

### Task 5: Remove debug logging and prefix-matching bandaid

**Files:**
- Modify: `src/lib/frontend/utils/fork-split.ts` (remove `MIN_PREFIX_MATCH` constant and prefix-matching pass)
- Modify: `src/lib/session/session-switch.ts` (remove `[fork-debug]` logs)
- Modify: `src/lib/handlers/session.ts` (remove `[fork-debug]` logs)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (remove `[fork-debug]` console.debug logs)
- Modify: `src/lib/frontend/components/chat/MessageList.svelte` (remove `[fork-debug]` `$effect`)
- Modify: `src/lib/frontend/utils/fork-split.ts` (remove debug `console.warn` dump of all messageIds — keep a brief warning)

**Step 1: Remove prefix-matching pass from `splitAtForkPoint`**

The rewrite in Task 4 already replaces this. Verify the `MIN_PREFIX_MATCH` constant and prefix-matching code are gone.

**Step 2: Remove all `[fork-debug]` log lines**

Search for `[fork-debug]` across the codebase and remove:
- `src/lib/session/session-switch.ts`: all `[fork-debug]` log.info lines
- `src/lib/handlers/session.ts`: the `[fork-debug]` log.info line
- `src/lib/frontend/stores/ws-dispatch.ts`: all `console.debug` lines with `[fork-debug]`
- `src/lib/frontend/components/chat/MessageList.svelte`: the `$effect` block with `[fork-debug]`
- `src/lib/frontend/utils/fork-split.ts`: the verbose `console.warn` with messageId dump (replace with a brief one-line warning)

Keep the operational `Fork session ... falling through to REST` log in `session-switch.ts` (it's useful for debugging in production).

**Step 3: Run build and lint**

Run: `pnpm check && pnpm lint`
Expected: PASS

---

### Task 6: Remove `resolveSessionHistory` fork-awareness (no longer needed)

**Files:**
- Modify: `src/lib/session/session-switch.ts:250-293` (remove fork cache check)
- Modify: `src/lib/session/session-switch.ts:78-82` (remove `forkMeta` from `SessionSwitchDeps`)
- Modify: `src/lib/handlers/session.ts` (remove `forkMeta` from `toSessionSwitchDeps`)
- Modify: `src/lib/bridges/client-init.ts` (remove `forkMeta` from inline deps)
- Modify: `test/unit/session/session-switch.test.ts` (remove fork-aware cache tests)

The earlier plan added fork-awareness to `resolveSessionHistory` — checking if the cache contains the fork-point message and falling through to REST if not. With timestamp-based splitting, this is no longer needed. The timestamp split works correctly with BOTH cached events (which have `createdAt` from when the events were recorded) and REST history (which has `time.created` from OpenCode). The cache-vs-REST decision can remain based on its existing heuristics.

**Step 1: Remove `forkMeta` from `SessionSwitchDeps`**

Delete the `forkMeta?` field from the interface.

**Step 2: Remove the fork cache validation block from `resolveSessionHistory`**

Remove the `forkEntry` check and the `hasForkPoint` logic. Restore the simple flow: classification → cached-events or REST fallback.

**Step 3: Remove `forkMeta` wiring from `toSessionSwitchDeps` and `client-init.ts`**

**Step 4: Remove fork-aware cache unit tests**

Remove the `describe("resolveSessionHistory — fork-aware cache validation")` block from `test/unit/session/session-switch.test.ts`.

**Step 5: Run type check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS (all 3800+ tests)

---

### Task 7: Build frontend, verify with Playwright on live app

**Files:** None — verification only.

**Step 1: Build frontend**

Run: `pnpm build:frontend`

**Step 2: Open live app in Playwright, navigate to existing fork session**

```bash
playwright-cli open https://localhost:2633/p/conduit --browser=chrome
# Navigate to a fork session in the sidebar
playwright-cli console debug
# Look for: [fork-split] split OK or absence of "not found" warnings
```

If the existing fork session doesn't have `forkPointTimestamp` (created before this change), the fallback ID-based path runs. That's expected. To test the timestamp path, create a fresh fork.

**Step 3: Create a fresh fork and verify**

Fork the current session, check that:
- The fork divider appears
- Inherited messages are in the collapsible "Prior conversation" block
- The fork divider separates inherited from current
- New messages (user + assistant) appear below the fork divider

**Step 4: Run full verification**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: ALL pass.

---

### Task 8: Run E2E tests

**Files:** None — verification only.

**Step 1: Run new fork-session-messages E2E test**

```bash
pnpm test:e2e -- test/e2e/specs/fork-session-messages.spec.ts
```

Expected: PASS

**Step 2: Run existing fork E2E tests**

```bash
pnpm test:e2e -- test/e2e/specs/fork-session.spec.ts
```

Expected: ALL 3 pass.
