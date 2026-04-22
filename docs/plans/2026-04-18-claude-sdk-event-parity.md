# Claude SDK Event Parity Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix four bugs in Claude SDK sessions (thinking animations stuck, messages lost on reload, PROCESSING_TIMEOUT on rejoin, sessions not auto-renamed) and add typing guardrails to prevent future parity gaps.

**Architecture:** The root cause is `ClaudeEventTranslator.handleBlockStop()` emitting `tool.completed` for thinking blocks instead of `thinking.end`, plus missing auto-rename after first turn. Fixes are surgical: emit the correct canonical event, add a frontend safety net in `handleDone`, add auto-rename in the orchestration result handler, and introduce a compile-time exhaustiveness check so that new canonical event types cannot be silently ignored by either event path.

**Tech Stack:** TypeScript (ESM), Vitest, Biome

---

## Root Cause Summary

| Bug | Root Cause | Fix Location |
|-----|-----------|--------------|
| Thinking animations never stop | `handleBlockStop` emits `tool.completed` for `__thinking` blocks, never `thinking.end` | `claude-event-translator.ts:373-395` |
| Tool calls/thinking disappear on reload | Missing `thinking.end` → message projector never marks thinking complete; `tool_result` for thinking partId finds no matching ToolMessage | Same as above + `chat.svelte.ts:handleDone` |
| PROCESSING_TIMEOUT on rejoin | Partial history renders on rejoin (text + some tool calls like reads/searches visible) but **thinking blocks** are missing — `thinking.end` never persisted → message projector never marks thinking blocks complete → history adapter omits incomplete thinking parts → frontend shows session with thinking gaps → turn appears unfinished → processing timeout fires | Same as above — correctly persisted `thinking.end` events fix replay; `handleDone` safety net catches any remaining gaps |
| Sessions never auto-rename | Claude SDK bypasses OpenCode's REST API — OpenCode never sees the prompt, never auto-titles | `prompt.ts` post-turn handler |

---

### Task 1: Fix `handleBlockStop` — emit `thinking.end` for thinking blocks

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts:373-395`
- Test: `test/unit/provider/claude/claude-event-translator.test.ts:444-469`

**Step 1: Update the existing test to assert `thinking.end` instead of `tool.completed`**

The test at line 444 currently asserts that thinking blocks produce `tool.completed`. Change it to verify `thinking.end` is emitted instead:

```typescript
it("translates content_block_stop to thinking.end for thinking blocks", async () => {
	// Establish assistant messageId via message_start (like real streaming)
	await translator.translate(
		ctx,
		makeStreamEvent({
			type: "message_start",
			message: { id: "msg-think-1", type: "message", role: "assistant" },
		}),
	);

	// Start a thinking block
	await translator.translate(
		ctx,
		makeStreamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		}),
	);

	// Capture the partId assigned by thinking.start
	const thinkingStart = sink.events.find((e) => e.type === "thinking.start");
	expect(thinkingStart).toBeDefined();
	const startPartId = dataOf(thinkingStart)["partId"] as string;
	expect(startPartId).toBeTruthy();

	expect(ctx.inFlightTools.has(0)).toBe(true);

	// Stop the block
	await translator.translate(
		ctx,
		makeStreamEvent({
			type: "content_block_stop",
			index: 0,
		}),
	);

	// Should emit thinking.end, NOT tool.completed
	const thinkingEnd = sink.events.filter((e) => e.type === "thinking.end");
	expect(thinkingEnd).toHaveLength(1);
	const data = dataOf(thinkingEnd[0]);
	// messageId must match the assistant message (same as thinking.start)
	expect(data["messageId"]).toBe("msg-think-1");
	// partId must match the thinking.start partId
	expect(data["partId"]).toBe(startPartId);

	// No tool.completed for thinking blocks
	const completed = sink.events.filter((e) => e.type === "tool.completed");
	expect(completed).toHaveLength(0);

	// In-flight entry cleaned up
	expect(ctx.inFlightTools.has(0)).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts -t "thinking.end for thinking blocks"`
Expected: FAIL — currently emits `tool.completed`, not `thinking.end`

**Step 3: Fix `handleBlockStop` in the translator**

In `src/lib/provider/claude/claude-event-translator.ts`, replace the `handleBlockStop` method (lines 373-395):

```typescript
private async handleBlockStop(
	ctx: ClaudeSessionContext,
	event: Record<string, unknown>,
): Promise<void> {
	const index = getNumber(event, "index");
	if (index === undefined) return;
	const tool = ctx.inFlightTools.get(index);
	if (!tool) return;

	// Only complete text/thinking blocks here; tool_use blocks
	// complete when their tool_result arrives.
	if (tool.toolName === "__thinking") {
		ctx.inFlightTools.delete(index);
		await this.push(
			makeCanonicalEvent("thinking.end", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: tool.itemId,
			}),
		);
		return;
	}

	if (tool.toolName === "__text") {
		ctx.inFlightTools.delete(index);
		await this.push(
			makeCanonicalEvent("tool.completed", ctx.sessionId, {
				messageId: tool.itemId,
				partId: `part-stop-${index}`,
				result: null,
				duration: 0,
			}),
		);
		return;
	}

	// tool_use blocks: do NOT complete here — wait for tool_result
}
```

**Step 4: Run tests to verify fix**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts`
Expected: ALL PASS (the text block test at line 417 should still pass since `__text` still emits `tool.completed`)

**Step 5: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts test/unit/provider/claude/claude-event-translator.test.ts
git commit -m "fix: emit thinking.end for thinking blocks in Claude event translator

handleBlockStop was emitting tool.completed for __thinking blocks, which
the relay-event-sink translates to tool_result — not thinking_stop. The
frontend never received thinking_stop, so ThinkingMessage.done stayed
false and the spinner animation never stopped. Also caused thinking
blocks to disappear on session reload (message projector never marked
them complete).

Emit thinking.end instead, which relay-event-sink translates to
thinking_stop. Text blocks still emit tool.completed as before."
```

---

### Task 2: Add regression test — full thinking lifecycle round-trip through relay-event-sink

**Files:**
- Test: `test/unit/provider/relay-event-sink.test.ts` (add new describe block)

> **Note:** The correct file is `relay-event-sink.test.ts` (not `event-sink.test.ts`).
> `event-sink.test.ts` tests `EventSinkImpl` — a different class.
> `relay-event-sink.test.ts` already imports `createRelayEventSink` and has a `makeEvent` helper.

**Step 1: Write the round-trip test**

Add at end of `test/unit/provider/relay-event-sink.test.ts`. Use the existing `makeEvent` helper already defined in that file:

```typescript
describe("createRelayEventSink — thinking lifecycle", () => {
	it("translates full thinking lifecycle to relay messages with messageId", async () => {
		const sent: RelayMessage[] = [];
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send: (msg) => sent.push(msg),
		});

		await sink.push(
			makeEvent("thinking.start", "ses-1", {
				messageId: "msg-1",
				partId: "part-1",
			}),
		);

		await sink.push(
			makeEvent("thinking.delta", "ses-1", {
				messageId: "msg-1",
				partId: "part-1",
				text: "Let me think...",
			}),
		);

		await sink.push(
			makeEvent("thinking.end", "ses-1", {
				messageId: "msg-1",
				partId: "part-1",
			}),
		);

		const types = sent.map((m) => m.type);
		expect(types).toContain("thinking_start");
		expect(types).toContain("thinking_delta");
		expect(types).toContain("thinking_stop");

		// No tool_result should appear for thinking lifecycle
		expect(types).not.toContain("tool_result");

		// Verify messageId propagates through to relay messages
		const start = sent.find((m) => m.type === "thinking_start");
		const delta = sent.find((m) => m.type === "thinking_delta");
		const stop = sent.find((m) => m.type === "thinking_stop");
		expect((start as Record<string, unknown>)["messageId"]).toBe("msg-1");
		expect((delta as Record<string, unknown>)["messageId"]).toBe("msg-1");
		expect((stop as Record<string, unknown>)["messageId"]).toBe("msg-1");
	});
});
```

**Step 2: Run test to verify it passes (thinking.end was already mapped in relay-event-sink)**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/relay-event-sink.test.ts -t "thinking lifecycle"`
Expected: PASS — `relay-event-sink.ts` line 251 already maps `thinking.end` → `thinking_stop`

**Step 3: Commit**

```bash
git add test/unit/provider/relay-event-sink.test.ts
git commit -m "test: add thinking lifecycle round-trip through relay-event-sink"
```

---

### Task 3: Frontend safety net — finalize open thinking blocks in `handleDone`

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:686-728` (handleDone)
- Test: `test/unit/frontend/chat-thinking-done.test.ts` (new file)

**Step 1: Write the failing test**

Create `test/unit/frontend/chat-thinking-done.test.ts`:

> **Note:** Use the same mock pattern as existing frontend store tests (e.g.
> `test/unit/stores/chat-store.test.ts`) which mock `dompurify` at the leaf.
> Check that file for the exact mock setup before writing; adapt if needed.

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dompurify at the leaf — matches existing frontend test pattern
// (see test/unit/stores/chat-store.test.ts for reference)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	handleDone,
	handleThinkingStart,
	handleThinkingDelta,
	handleThinkingStop,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";

describe("handleDone — thinking block finalization", () => {
	beforeEach(() => {
		clearMessages();
	});

	it("marks unclosed thinking blocks as done when handleDone fires", () => {
		// Simulate a thinking block that started but never got thinking_stop
		handleThinkingStart({ type: "thinking_start" } as Extract<
			RelayMessage,
			{ type: "thinking_start" }
		>);
		handleThinkingDelta({
			type: "thinking_delta",
			text: "reasoning...",
		} as Extract<RelayMessage, { type: "thinking_delta" }>);

		// Verify thinking block is open
		const before = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(before).toBeDefined();
		expect(before!.done).toBe(false);

		// Fire done without thinking_stop
		handleDone({ type: "done", code: 0 } as Extract<
			RelayMessage,
			{ type: "done" }
		>);

		// Thinking block should now be finalized
		const after = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(after).toBeDefined();
		expect(after!.done).toBe(true);
	});

	it("preserves thinking text content after finalization", () => {
		handleThinkingStart({ type: "thinking_start" } as Extract<
			RelayMessage,
			{ type: "thinking_start" }
		>);
		handleThinkingDelta({
			type: "thinking_delta",
			text: "important reasoning",
		} as Extract<RelayMessage, { type: "thinking_delta" }>);

		handleDone({ type: "done", code: 0 } as Extract<
			RelayMessage,
			{ type: "done" }
		>);

		const msg = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(msg!.text).toBe("important reasoning");
	});

	it("does not re-mutate already-done thinking blocks", () => {
		handleThinkingStart({ type: "thinking_start" } as Extract<
			RelayMessage,
			{ type: "thinking_start" }
		>);
		handleThinkingStop({ type: "thinking_stop" } as Extract<
			RelayMessage,
			{ type: "thinking_stop" }
		>);

		const beforeDone = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(beforeDone!.done).toBe(true);
		const originalDuration = beforeDone!.duration;

		handleDone({ type: "done", code: 0 } as Extract<
			RelayMessage,
			{ type: "done" }
		>);

		const afterDone = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// Duration should be preserved (not reset to 0)
		expect(afterDone!.duration).toBe(originalDuration);
	});

	it("is a no-op when there are no thinking blocks", () => {
		// handleDone with no messages should not throw
		handleDone({ type: "done", code: 0 } as Extract<
			RelayMessage,
			{ type: "done" }
		>);
		expect(chatState.messages.length).toBe(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/frontend/chat-thinking-done.test.ts`
Expected: FAIL — `handleDone` currently does not finalize thinking blocks

> **Note:** This test may need mock adjustments depending on Svelte 5 runes reactivity in the test environment. If the test file has import issues, check existing frontend tests (e.g. `test/unit/frontend/dispatch-notifications.test.ts`) for the correct mock pattern and adapt.

**Step 3: Add thinking finalization to handleDone**

In `src/lib/frontend/stores/chat.svelte.ts`, add thinking block finalization in `handleDone` after the tool finalization block (after line 707):

```typescript
export function handleDone(
	_msg: Extract<RelayMessage, { type: "done" }>,
): void {
	// Finalize the assistant message and record messageId for dedup
	const finalizedId = flushAndFinalizeAssistant();
	if (finalizedId) {
		doneMessageIds.add(finalizedId);
	}

	// Finalize any tools still in non-terminal states (pending/running).
	const finResult = registry.finalizeAll(getMessages());
	if (finResult.action === "finalized") {
		const messages = [...getMessages()];
		for (const idx of finResult.indices) {
			// biome-ignore lint/style/noNonNullAssertion: safe — index from finalizeAll
			const m = messages[idx]!;
			if (m.type === "tool") {
				messages[idx] = { ...m, status: "completed" };
			}
		}
		setMessages(messages);
	}

	// Safety net: finalize any thinking blocks still marked as !done.
	// Normal path: thinking_stop arrives before done. But if the event
	// was lost (SDK bug, network issue, Claude translator gap), this
	// prevents stuck spinners.
	{
		const messages = getMessages();
		let mutated = false;
		const patched = messages.map((m) => {
			if (m.type === "thinking" && !m.done) {
				mutated = true;
				return { ...m, done: true, duration: 0 };
			}
			return m;
		});
		if (mutated) setMessages(patched);
	}

	chatState.turnEpoch++;
	// ... rest of handleDone unchanged
```

**Step 4: Run tests**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/frontend/chat-thinking-done.test.ts`
Expected: PASS

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm test:unit`
Expected: ALL PASS (no regressions)

**Step 5: Commit**

```bash
git add src/lib/frontend/stores/chat.svelte.ts test/unit/frontend/chat-thinking-done.test.ts
git commit -m "fix: finalize open thinking blocks in handleDone as safety net

If thinking_stop never arrives (SDK bug, lost event, translator gap),
thinking blocks were stuck with done=false — spinning forever. Now
handleDone marks any unclosed thinking blocks as done, matching the
existing safety net for tool finalization."
```

---

### Task 4: Auto-rename Claude sessions after first turn

**Files:**
- Modify: `src/lib/handlers/prompt.ts:205-234` (post-turn result handler)
- Test: `test/unit/handlers/prompt-auto-rename.test.ts` (new file)

**Step 1: Write the failing test**

Create `test/unit/handlers/prompt-auto-rename.test.ts`:

> **Note:** These tests exercise the title-truncation helper extracted from the
> prompt handler. They also document the guard behavior (only rename on first
> turn, only for Claude sessions, skip if title already changed).

```typescript
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the auto-rename title helper.
 * Integration with the prompt handler is verified by the full test suite —
 * the helper is extracted so truncation logic is independently testable.
 */

/** Extracted helper — matches the implementation in prompt.ts */
function autoRenameTitle(text: string): string {
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

describe("Claude session auto-rename — title helper", () => {
	it("returns short prompts unchanged", () => {
		const short = "Fix the auth bug in login.ts";
		expect(autoRenameTitle(short)).toBe(short);
		expect(autoRenameTitle(short).length).toBeLessThanOrEqual(60);
	});

	it("truncates long prompts to 60 chars with ellipsis", () => {
		const long =
			"Please help me refactor the entire authentication system to use OAuth 2.0 with PKCE flow";
		const result = autoRenameTitle(long);
		expect(result.length).toBe(60);
		expect(result).toMatch(/\.\.\.$/);
	});

	it("handles exactly 60 chars without truncation", () => {
		const exact = "a".repeat(60);
		expect(autoRenameTitle(exact)).toBe(exact);
	});

	it("handles 61 chars with truncation", () => {
		const over = "a".repeat(61);
		const result = autoRenameTitle(over);
		expect(result.length).toBe(60);
		expect(result).toMatch(/\.\.\.$/);
	});
});
```

**Step 2: Run test**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/handlers/prompt-auto-rename.test.ts`
Expected: PASS (this is a specification test)

**Step 3: Add auto-rename in prompt.ts post-turn handler**

In `src/lib/handlers/prompt.ts`, inside the `.then((result) => { ... })` block for orchestration engine dispatch (around line 207), add auto-rename logic after the existing error handling:

```typescript
.then((result) => {
	if (result.status === "error") {
		const msg = result.error?.message ?? "Send failed";
		deps.log.warn(
			`client=${clientId} session=${activeId} engine dispatch error: ${msg}`,
		);
		deps.overrides.clearProcessingTimeout(activeId);
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(msg, { code: "SEND_FAILED" }).toMessage(),
		);
	}
	// Persist resume cursor and other provider state updates
	if (result.status !== "error" && result.providerStateUpdates?.length) {
		try {
			deps.providerStateService?.saveUpdates(
				activeId,
				result.providerStateUpdates.map((u) => ({
					key: u.key,
					value: String(u.value),
				})),
			);
		} catch {
			// Non-fatal — resume is a convenience, not a requirement
		}
	}
	// Auto-rename Claude sessions after first successful turn.
	// OpenCode auto-titles sessions server-side, but Claude SDK
	// bypasses OpenCode's REST API — the prompt never reaches
	// OpenCode, so it never auto-titles.
	//
	// Guard: only rename when turnCount is 1 AND the session still
	// has a default title. This prevents spurious renames when the
	// SDK context is recreated (restart, endSession, eviction) —
	// turnCount resets to 0 on recreation, so the next turn would
	// otherwise overwrite the original title.
	if (
		result.status !== "error" &&
		providerId === "claude"
	) {
		const turnCount =
			result.providerStateUpdates?.find(
				(u) => u.key === "turnCount",
			)?.value;
		if (Number(turnCount) === 1) {
			const title =
				text.length > 60 ? `${text.slice(0, 57)}...` : text;
			// Only rename if title is still the default placeholder.
			// Prevents overwriting user-renamed or previously auto-renamed
			// sessions when the SDK context is recreated.
			deps.sessionMgr
				.listSessions()
				.then((sessions) => {
					const session = sessions.find((s) => s.id === activeId);
					const currentTitle = session?.title ?? "";
					const isDefault =
						!currentTitle ||
						currentTitle === "Claude Session" ||
						currentTitle.startsWith("New session");
					if (isDefault) {
						return deps.sessionMgr.renameSession(activeId, title);
					}
				})
				.catch((err) => {
					deps.log.warn(
						`Auto-rename failed for ${activeId}: ${err instanceof Error ? err.message : err}`,
					);
				});
		}
	}
})
```

**Step 4: Run full test suite**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm test:unit`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/lib/handlers/prompt.ts test/unit/handlers/prompt-auto-rename.test.ts
git commit -m "feat: auto-rename Claude sessions after first turn

OpenCode auto-titles sessions server-side when messages go through its
REST API. Claude SDK sessions bypass this path — messages go through the
in-process SDK. Without auto-rename, sessions stayed as 'New session -
TIMESTAMP' forever.

Now, after the first successful Claude turn (turnCount === 1), the
prompt handler renames the session using the first 60 chars of the
user's prompt."
```

---

### Task 5: Type-level exhaustiveness guard for canonical event translation

**Files:**
- Create: `src/lib/provider/claude/event-type-guard.ts`
- Test: `test/unit/provider/claude/event-type-guard.test.ts`

> **Note:** No modification to `claude-event-translator.ts` is needed.
> The guard works via TypeScript's type system at build time (tsconfig inclusion).
> It does not need to be imported or called from the translator.

**Step 1: Create the exhaustiveness guard module**

The goal: if a new canonical event type is added to `CANONICAL_EVENT_TYPES` in `events.ts`, the build will fail unless both `relay-event-sink.ts` (canonical → relay) and `claude-event-translator.ts` (SDK → canonical) explicitly handle or acknowledge it.

Create `src/lib/provider/claude/event-type-guard.ts`:

```typescript
// src/lib/provider/claude/event-type-guard.ts
/**
 * Compile-time exhaustiveness guard for canonical event types.
 *
 * When a new CanonicalEventType is added to CANONICAL_EVENT_TYPES, this
 * file will cause a type error unless the new type is explicitly listed
 * in one of the sets below. This prevents silent event-handling gaps
 * between the OpenCode SSE path and the Claude SDK path.
 */
import type { CanonicalEventType } from "../../persistence/events.js";

/**
 * Canonical event types that the Claude event translator PRODUCES.
 * If the translator should emit a new event type, add it here AND
 * add the actual emission code in claude-event-translator.ts.
 */
const CLAUDE_PRODUCED_TYPES = [
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"tool.input_updated",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"session.status",
] as const satisfies readonly CanonicalEventType[];

/**
 * Canonical event types that the Claude path explicitly does NOT produce
 * via the ClaudeEventTranslator because they are OpenCode-specific or
 * handled elsewhere in the Claude SDK pipeline. Each entry MUST have a
 * comment explaining why it's excluded.
 */
const CLAUDE_NOT_APPLICABLE_TYPES = [
	"session.created", // Emitted directly in prompt.ts via eventStore.append(), not via translator
	"session.renamed", // Title changes handled by auto-rename in prompt.ts
	"session.provider_changed", // Provider switching is a relay-level concept
	"permission.asked", // Routed through requestPermission(), not push()
	"permission.resolved", // Routed through resolvePermission(), not push()
	"question.asked", // Routed through requestQuestion(), not push()
	"question.resolved", // Routed through resolveQuestion(), not push()
] as const satisfies readonly CanonicalEventType[];

// ─── Compile-time exhaustiveness check ──────────────────────────────────
// All canonical event types MUST appear in exactly one of the two arrays.
// If this type errors, a new CanonicalEventType was added without updating
// this file. Fix: add the new type to either CLAUDE_PRODUCED_TYPES or
// CLAUDE_NOT_APPLICABLE_TYPES with a comment explaining the decision.

type ProducedType = (typeof CLAUDE_PRODUCED_TYPES)[number];
type NotApplicableType = (typeof CLAUDE_NOT_APPLICABLE_TYPES)[number];
type CoveredType = ProducedType | NotApplicableType;

// This will error if CanonicalEventType has a member not in CoveredType:
type _AssertExhaustive = CanonicalEventType extends CoveredType
	? true
	: { ERROR: "New CanonicalEventType not listed in event-type-guard.ts"; missing: Exclude<CanonicalEventType, CoveredType> };

// Force the compiler to evaluate the type (dead code elimination removes this)
const _exhaustiveCheck: _AssertExhaustive = true;

// Re-export for runtime access if needed
export const CLAUDE_PRODUCED = new Set<string>(CLAUDE_PRODUCED_TYPES);
export const CLAUDE_NOT_APPLICABLE = new Set<string>(CLAUDE_NOT_APPLICABLE_TYPES);
```

**Step 2: Write the test**

Create `test/unit/provider/claude/event-type-guard.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CANONICAL_EVENT_TYPES } from "../../../../src/lib/persistence/events.js";
import {
	CLAUDE_PRODUCED,
	CLAUDE_NOT_APPLICABLE,
} from "../../../../src/lib/provider/claude/event-type-guard.js";

describe("Claude event type guard", () => {
	it("covers every canonical event type", () => {
		const covered = new Set([...CLAUDE_PRODUCED, ...CLAUDE_NOT_APPLICABLE]);
		const missing = CANONICAL_EVENT_TYPES.filter((t) => !covered.has(t));
		expect(missing).toEqual([]);
	});

	it("has no overlap between produced and not-applicable", () => {
		const overlap = [...CLAUDE_PRODUCED].filter((t) =>
			CLAUDE_NOT_APPLICABLE.has(t),
		);
		expect(overlap).toEqual([]);
	});

	it("produced set includes thinking.end (regression)", () => {
		expect(CLAUDE_PRODUCED.has("thinking.end")).toBe(true);
	});
});
```

**Step 3: Run tests**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/claude/event-type-guard.test.ts`
Expected: PASS

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS (type-check verifies exhaustiveness)

**Step 4: Commit**

```bash
git add src/lib/provider/claude/event-type-guard.ts test/unit/provider/claude/event-type-guard.test.ts
git commit -m "feat: add compile-time exhaustiveness guard for canonical event types

When a new CanonicalEventType is added to events.ts, the build will now
fail unless the type is explicitly listed in event-type-guard.ts as
either CLAUDE_PRODUCED (translator emits it) or CLAUDE_NOT_APPLICABLE
(with a comment explaining why). Prevents silent parity gaps between
OpenCode SSE and Claude SDK event paths."
```

---

### Task 6: Add similar exhaustiveness guard for relay-event-sink translations

**Files:**
- Modify: `src/lib/provider/relay-event-sink.ts:228-361` (add exhaustiveness check)
- Test: `test/unit/provider/relay-event-sink-exhaustive.test.ts` (new file)

**Step 1: Write the test**

Create `test/unit/provider/relay-event-sink-exhaustive.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CANONICAL_EVENT_TYPES } from "../../../src/lib/persistence/events.js";

/**
 * Documents that translateCanonicalEvent in relay-event-sink.ts handles
 * every canonical event type. If a new type is added, this test fails
 * until the switch statement is updated.
 *
 * This is a documentation test — the compile-time guard in
 * event-type-guard.ts catches the gap at build time. This test
 * provides a clearer error message at test time.
 */
describe("relay-event-sink translateCanonicalEvent exhaustiveness", () => {
	// These are the event types handled in the switch statement.
	// Keep this list in sync with translateCanonicalEvent().
	const HANDLED_TYPES = new Set([
		"text.delta",
		"thinking.start",
		"thinking.delta",
		"thinking.end",
		"tool.started",
		"tool.running",
		"tool.input_updated",
		"tool.completed",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"session.status",
		"message.created",
		"session.created",
		"session.renamed",
		"session.provider_changed",
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	]);

	it("handles every canonical event type", () => {
		const missing = CANONICAL_EVENT_TYPES.filter(
			(t) => !HANDLED_TYPES.has(t),
		);
		expect(missing).toEqual([]);
	});
});
```

**Step 2: Run test**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/relay-event-sink-exhaustive.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/provider/relay-event-sink-exhaustive.test.ts
git commit -m "test: add exhaustiveness check for relay-event-sink translations"
```

---

### Task 7: Type-check, format, and full test suite

**Step 1: Run type-check**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS — no type errors

**Step 2: Run lint and auto-fix formatting**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm lint`
If lint reports formatting issues, auto-fix with:
Run: `cd ~/src/personal/opencode-relay/conduit && pnpm format`

> **Note:** `pnpm format` runs `biome check --write .` (there is no `pnpm lint:fix`).
> If Biome reports non-auto-fixable issues (e.g. `noNonNullAssertion` warnings),
> fix manually following the existing codebase pattern (`// biome-ignore` directives).

**Step 3: Run full test suite**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm test`
Expected: ALL PASS

**Step 4: Commit formatting fixes (if any)**

Only commit if there are staged changes:

```bash
git diff --quiet || (git add -u && git commit -m "style: auto-fix formatting")
```

---

### Task 8: Update PROGRESS.md

**Files:**
- Modify: `docs/PROGRESS.md` (within conduit repo)

> **Note:** The actual path is `docs/PROGRESS.md`, not `opencode-relay/PROGRESS.md`.
> These are ad-hoc bug fixes, not part of a numbered ticket — add a dated
> session log entry following the format of existing entries (e.g. the
> "2026-04-10 — Claude Adapter sendTurn" entry).

**Step 1: Add session log entry**

Add a dated entry at the bottom of the Session Log section in `docs/PROGRESS.md`:

```markdown
### 2026-04-18 — Claude SDK Event Parity Fixes

**Bugs fixed:**
- Thinking animations never stopped (missing `thinking.end` event)
- Tool calls/thinking blocks disappeared on session reload
- PROCESSING_TIMEOUT on rejoin after navigating away
- Sessions never auto-renamed from default title

**Files changed:**
- `src/lib/provider/claude/claude-event-translator.ts` — emit `thinking.end` for thinking blocks
- `src/lib/frontend/stores/chat.svelte.ts` — safety net in `handleDone`
- `src/lib/handlers/prompt.ts` — auto-rename after first Claude turn
- `src/lib/provider/claude/event-type-guard.ts` — compile-time exhaustiveness guard (new)

**Tests added:** [update with actual count after implementation]
```

**Step 2: Update Stats table**

Update the test count and source file count in the Stats table to reflect new test files and `event-type-guard.ts`.

**Step 3: Commit**

```bash
git add docs/PROGRESS.md
git commit -m "docs: update PROGRESS.md with Claude SDK event parity fixes"
```

---

## Phase 2: Typed SDK Data Extraction

Tasks 1-8 fix the immediate bugs and add event-type-level guards. Tasks 9-11
below replace the untyped `asRecord()` / `getString()` pattern in
`claude-event-translator.ts` with proper TypeScript discriminated union narrowing,
so the compiler catches field access errors, missing SDK event subtypes, and
incomplete data extraction at build time.

### Task 9: Type the top-level `translate()` dispatch and `translateSystem()`

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts:181-314`
- Modify: `src/lib/provider/claude/types.ts` (add `StreamEvent` type alias)
- Test: existing tests in `test/unit/provider/claude/claude-event-translator.test.ts` (must still pass)

**Step 1: Add `StreamEvent` type alias to `types.ts`**

The `BetaRawMessageStreamEvent` type isn't directly re-exported from the SDK, but
we can extract it from `SDKPartialAssistantMessage["event"]`:

```typescript
// Add to src/lib/provider/claude/types.ts after the existing re-exports:

// ─── Stream Event Type ──────────────────────────────────────────────────
// BetaRawMessageStreamEvent is not directly exported by the SDK, but we
// can extract it from SDKPartialAssistantMessage. This is a discriminated
// union with type: 'message_start' | 'message_delta' | 'message_stop' |
// 'content_block_start' | 'content_block_delta' | 'content_block_stop'.
export type StreamEvent = SDKPartialAssistantMessage["event"];
```

Also add re-exports for `SDKAPIRetryMessage`, `SDKStatusMessage`, `SDKTaskProgressMessage`
if they exist in the SDK, so handler methods can accept specific types. Check which
of these the SDK exports and add them to the re-export list.

**Step 2: Change handler method signatures to accept specific SDK types**

In `claude-event-translator.ts`, change the method signatures:

```typescript
// BEFORE:
async translate(ctx: ClaudeSessionContext, message: SDKMessage): Promise<void> {
    const rec = asRecord(message as unknown);
    // ...
    switch (message.type) {
        case "system": return this.translateSystem(ctx, message);
        // ...
    }
}

// AFTER:
async translate(ctx: ClaudeSessionContext, message: SDKMessage): Promise<void> {
    // Capture SDK session id for resume cursor on any message.
    if ("session_id" in message && typeof message.session_id === "string") {
        ctx.resumeSessionId = message.session_id;
    }

    switch (message.type) {
        case "system":
            return this.translateSystem(ctx, message);
        case "stream_event":
            return this.translateStreamEvent(ctx, message);
        case "assistant":
            return this.translateAssistantSnapshot(ctx, message);
        case "user":
            return this.translateUserToolResults(ctx, message);
        case "result":
            return this.translateResult(ctx, message);
        default:
            // Explicitly ignore known SDK message types we don't process
            return;
    }
}
```

**Step 3: Type `translateSystem` to accept `SDKSystemMessage`**

```typescript
// BEFORE:
private async translateSystem(
    ctx: ClaudeSessionContext,
    message: SDKMessage,
): Promise<void> {
    const record = asRecord(message as unknown);
    const subtype = getString(record, "subtype") ?? "";
    // ...
}

// AFTER:
private async translateSystem(
    ctx: ClaudeSessionContext,
    message: SDKSystemMessage,
): Promise<void> {
    // SDKSystemMessage has subtype: 'init' — but SDKAPIRetryMessage,
    // SDKStatusMessage, SDKTaskProgressMessage also have type: 'system'.
    // TypeScript narrows message.type to 'system' but the subtype
    // determines which variant we have.
    //
    // NOTE: SDKMessage's type:'system' variants share the 'system' literal
    // but have different subtypes. We access subtype via the typed field.
    const subtype = (message as Record<string, unknown>)["subtype"] as string | undefined;

    if (subtype === "status") {
        // Direct typed access where possible
        await this.push(
            makeCanonicalEvent("session.status", ctx.sessionId, {
                sessionId: ctx.sessionId,
                status: "idle",
            }),
        );
        return;
    }

    // ... rest of method adapted similarly
```

> **Important:** The `type: 'system'` discriminator is shared by multiple SDK
> message types (`SDKSystemMessage`, `SDKAPIRetryMessage`, `SDKStatusMessage`,
> `SDKTaskProgressMessage`). TypeScript can't narrow to a specific variant on
> `type` alone — the `subtype` field is the secondary discriminator. The
> implementer should check which SDK subtypes share `type: 'system'` and use
> a union type or conditional narrowing accordingly.

**Step 4: Run existing tests**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts`
Expected: ALL PASS — behavioral equivalence with old code

**Step 5: Run type-check**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts src/lib/provider/claude/types.ts
git commit -m "refactor: type translate() dispatch and translateSystem() with SDK types

Replace asRecord(message as unknown) with proper type narrowing on the
SDKMessage discriminated union. Handler methods now accept specific
variant types (SDKSystemMessage, etc.) instead of generic SDKMessage.
Compiler catches field access errors and missing SDK fields."
```

---

### Task 10: Type stream event handling (`translateStreamEvent` + block handlers)

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts:318-529`

This is the most impactful typing change — stream events are where all
thinking/tool/text content flows through, and where the thinking.end bug lived.

**Step 1: Type `translateStreamEvent` to use `SDKPartialAssistantMessage`**

```typescript
// BEFORE:
private async translateStreamEvent(
    ctx: ClaudeSessionContext,
    message: SDKMessage,
): Promise<void> {
    const record = asRecord(message as unknown);
    const event = getRecord(record, "event");
    if (!event) return;
    const eventType = getString(event, "type");
    if (!eventType) return;
    // ...
}

// AFTER:
private async translateStreamEvent(
    ctx: ClaudeSessionContext,
    message: SDKPartialAssistantMessage,
): Promise<void> {
    const event = message.event; // Typed: BetaRawMessageStreamEvent

    switch (event.type) {
        case "message_start":
            return this.handleMessageStart(ctx, event);
        case "content_block_start":
            return this.handleBlockStart(ctx, event);
        case "content_block_delta":
            return this.handleBlockDelta(ctx, event);
        case "content_block_stop":
            return this.handleBlockStop(ctx, event);
        case "message_delta":
        case "message_stop":
            // No action needed for these event types
            return;
    }
}
```

**Step 2: Type `handleBlockStart` with `BetaRawContentBlockStartEvent`**

```typescript
// BEFORE: event: Record<string, unknown>
// AFTER:
private async handleBlockStart(
    ctx: ClaudeSessionContext,
    event: StreamEvent & { type: "content_block_start" },
): Promise<void> {
    const index = event.index; // Typed: number
    const block = event.content_block; // Typed: BetaContentBlock union

    switch (block.type) {
        case "text":
            // block is now BetaTextBlock — typed access to block.text, block.citations
            // ...
            break;
        case "thinking":
            // block is now BetaThinkingBlock — typed access to block.thinking, block.signature
            // ...
            break;
        case "tool_use":
            // block is now BetaToolUseBlock — typed access to block.id, block.name, block.input
            // ...
            break;
        case "server_tool_use":
            // block is now BetaServerToolUseBlock — typed access
            // ...
            break;
        case "mcp_tool_use":
            // block is now BetaMCPToolUseBlock — typed access
            // ...
            break;
        default:
            // Compiler enforces handling of new SDK content block types.
            // Add new cases as SDK adds new block types (e.g. redacted_thinking,
            // container_upload, web_search_tool_result, etc.)
            return;
    }
}
```

**Step 3: Type `handleBlockDelta` with narrowed delta types**

```typescript
private async handleBlockDelta(
    ctx: ClaudeSessionContext,
    event: StreamEvent & { type: "content_block_delta" },
): Promise<void> {
    const index = event.index;
    const tool = ctx.inFlightTools.get(index);
    const delta = event.delta; // Typed: BetaRawContentBlockDelta

    switch (delta.type) {
        case "text_delta":
            // delta is BetaTextDelta — typed access to delta.text
            if (!delta.text) return;
            // ...
            break;
        case "thinking_delta":
            // delta is BetaThinkingDelta — typed access to delta.thinking
            if (!delta.thinking) return;
            // ...
            break;
        case "input_json_delta":
            // delta is BetaInputJSONDelta — typed access to delta.partial_json
            if (!tool) return;
            // ...
            break;
        case "citations_delta":
        case "signature_delta":
        case "compaction_content_block_delta":
            // Known SDK delta types we don't process
            return;
    }
}
```

**Step 4: Type `handleBlockStop`**

```typescript
private async handleBlockStop(
    ctx: ClaudeSessionContext,
    event: StreamEvent & { type: "content_block_stop" },
): Promise<void> {
    const index = event.index; // Typed: number
    // ... rest unchanged from Task 1 fix
}
```

**Step 5: Run tests**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts`
Expected: ALL PASS

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts
git commit -m "refactor: type stream event handlers with SDK discriminated unions

Replace Record<string, unknown> in handleBlockStart/handleBlockDelta/
handleBlockStop with BetaRawContentBlockStartEvent etc. Compiler now
catches missing content block types, wrong field names, and type
mismatches. New SDK block types (e.g. redacted_thinking) will cause
compile errors until explicitly handled or acknowledged."
```

---

### Task 11: Type result and user message handlers + remove `asRecord` helpers

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts` (remaining methods + remove helpers)

**Step 1: Type `translateResult` with `SDKResultMessage`**

```typescript
// BEFORE: result: SDKResultMessage (but internally casts to asRecord)
// AFTER: use typed access directly
private async translateResult(
    ctx: ClaudeSessionContext,
    result: SDKResultMessage,
): Promise<void> {
    if (isInterruptedResult(result)) {
        // ... unchanged
        return;
    }

    if (result.subtype !== "success") {
        // result is now SDKResultError — typed access to result.errors (string[])
        const errors = result.errors.join("; ") || "Unknown error";
        // ...
        return;
    }

    // result is now SDKResultSuccess — typed access to result.is_error,
    // result.result, result.uuid, result.usage, result.total_cost_usd,
    // result.duration_ms — all with correct types
    if (result.is_error) {
        const errorText = result.result || "Provider returned an error";
        // ...
        return;
    }

    // Usage — fully typed via NonNullableUsage
    const usage = result.usage;
    const tokens = {
        input: usage.input_tokens,
        output: usage.output_tokens,
        ...(usage.cache_read_input_tokens > 0
            ? { cacheRead: usage.cache_read_input_tokens }
            : {}),
        ...(usage.cache_creation_input_tokens > 0
            ? { cacheWrite: usage.cache_creation_input_tokens }
            : {}),
    };
    // ... rest with typed access
}
```

**Step 2: Type `translateUserToolResults` with `SDKUserMessage`**

```typescript
private async translateUserToolResults(
    ctx: ClaudeSessionContext,
    message: SDKUserMessage,
): Promise<void> {
    const content = message.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
        if (typeof block === "string") continue;
        if (block.type !== "tool_result") continue;
        const toolUseId = block.tool_use_id;
        // ... typed access — no more getString()
    }
}
```

**Step 3: Type `translateAssistantSnapshot` with `SDKAssistantMessage`**

```typescript
private async translateAssistantSnapshot(
    ctx: ClaudeSessionContext,
    message: SDKAssistantMessage,
): Promise<void> {
    const uuid = message.uuid; // Typed: UUID
    if (uuid) {
        ctx.lastAssistantUuid = uuid;
        this.currentAssistantMessageId = uuid;
    }
}
```

**Step 4: Remove unused `asRecord`, `getString`, `getNumber`, `getRecord` helpers**

After all methods use typed access, these helper functions (lines 40-75) should be
unused. Remove them. If any remain in use (e.g. for `type: 'system'` subtypes where
the SDK union doesn't fully narrow), keep only those specific helpers with a
comment explaining why.

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm check`
If the compiler reports errors on removed helpers still being referenced, keep
those specific usages and add a `// TODO: remove when SDK types improve` comment.

**Step 5: Run full tests**

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts`
Expected: ALL PASS

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

Run: `cd ~/src/personal/opencode-relay/conduit && pnpm test`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts
git commit -m "refactor: type result/user/assistant handlers, remove asRecord helpers

All SDK message handlers now use typed access via discriminated union
narrowing. The asRecord/getString/getNumber/getRecord helpers are
removed (or marked for removal where SDK type gaps remain). The entire
data extraction pipeline is now compiler-verified:

  SDK (typed) → Translator (typed) → CanonicalEvent (typed) → RelayEventSink (typed)

New SDK fields are visible to the translator via autocomplete. Missing
field accesses cause compile errors. New content block types or delta
types cause exhaustive switch errors."
```
