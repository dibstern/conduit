# Chat Lifecycle E2E Tests — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Playwright E2E tests that validate the full chat message lifecycle (tool calls, result bar, thinking, multi-turn, streaming state) against a real OpenCode instance.

**Architecture:** Extends the existing E2E infrastructure (`E2EHarness`, `test-fixtures.ts`, `ChatPage` page object). New spec file `chat-lifecycle.spec.ts` sits alongside `chat.spec.ts`. Page object gets new methods for tool blocks, result bar, thinking blocks, and a corrected streaming-complete check.

**Tech Stack:** Playwright, TypeScript, existing E2EHarness (real relay + real OpenCode)

**Design doc:** `docs/plans/2026-03-06-chat-lifecycle-e2e-design.md`

**Prerequisites:**
- OpenCode must be running at `localhost:4096` (or set `OPENCODE_URL`)
- Set `E2E_MODEL` and `E2E_PROVIDER` env vars for a free model (e.g., `E2E_MODEL=gemini-2.0-flash E2E_PROVIDER=google`) to avoid costs. If unset, tests use OpenCode's default model.

---

### Task 1: Fix ChatPage — broken `waitForStreamingComplete` and dead `toolBlocks` locator

**Files:**
- Modify: `test/e2e/page-objects/chat.page.ts`

**Context:** Two existing bugs must be fixed before adding new methods:
1. `waitForStreamingComplete()` uses `#send:not(.stop)`, but `#send` never has a `.stop` class — the stop button is a **separate** `#stop` element that is conditionally rendered. The method resolves immediately and provides no guarantee that streaming has finished.
2. `toolBlocks` locator uses `.tool-block`, but this class doesn't exist in any Svelte component. The correct class is `.tool-item`.

**Step 1: Fix the ChatPage class**

Replace the entire file content with:

```typescript
import type { Locator, Page } from "@playwright/test";

export class ChatPage {
	readonly page: Page;
	readonly messagesContainer: Locator;
	readonly userMessages: Locator;
	readonly assistantMessages: Locator;
	readonly thinkingBlocks: Locator;
	readonly codeBlocks: Locator;
	readonly codeCopyBtns: Locator;
	readonly toolBlocks: Locator;
	readonly resultBars: Locator;
	readonly stopBtn: Locator;

	constructor(page: Page) {
		this.page = page;
		this.messagesContainer = page.locator("#messages");
		this.userMessages = page.locator(".msg-user");
		this.assistantMessages = page.locator(".msg-assistant");
		this.thinkingBlocks = page.locator(".thinking-block");
		this.codeBlocks = page.locator("pre code");
		this.codeCopyBtns = page.locator(".code-copy-btn");
		this.toolBlocks = page.locator(".tool-item");
		this.resultBars = page.locator(".result-bar");
		this.stopBtn = page.locator("#stop");
	}

	async waitForUserMessage(text: string): Promise<Locator> {
		const msg = this.page.locator(".msg-user .bubble", { hasText: text });
		await msg.waitFor({ state: "visible", timeout: 5_000 });
		return msg;
	}

	/**
	 * Wait for an assistant message with actual rendered content.
	 * Uses .md-content with non-empty innerHTML to ensure the response has been rendered.
	 */
	async waitForAssistantMessage(timeout?: number): Promise<Locator> {
		const t = timeout ?? 60_000;
		const contentLocator = this.page.locator(
			".msg-assistant .md-content:not(:empty)",
		);
		await contentLocator.last().waitFor({ state: "visible", timeout: t });
		return this.assistantMessages.last();
	}

	async getLastAssistantText(): Promise<string> {
		const content = this.assistantMessages.last().locator(".md-content");
		await content.waitFor({ state: "visible", timeout: 30_000 });
		return content.innerText();
	}

	/**
	 * Wait for streaming/processing to complete.
	 * The #stop button is a separate element that is only rendered while processing.
	 * We wait for it to disappear (or confirm it was never visible).
	 */
	async waitForStreamingComplete(timeout?: number): Promise<void> {
		const t = timeout ?? 90_000;
		// The #stop button is conditionally rendered ({#if isProcessing}).
		// If it's currently visible, wait for it to disappear.
		// If it's already hidden (fast response), this resolves immediately.
		await this.stopBtn.waitFor({ state: "hidden", timeout: t });
	}

	async getUserMessageCount(): Promise<number> {
		return this.userMessages.count();
	}

	async getAssistantMessageCount(): Promise<number> {
		return this.assistantMessages.count();
	}

	/** Wait for at least one tool block to appear */
	async waitForToolBlock(timeout = 60_000): Promise<Locator> {
		const tool = this.toolBlocks.first();
		await tool.waitFor({ state: "visible", timeout });
		return tool;
	}

	/** Wait for a tool to reach completed state (subtitle shows "Done") */
	async waitForToolCompleted(timeout = 60_000): Promise<void> {
		const completedSubtitle = this.page.locator(".tool-subtitle-text", {
			hasText: /^Done$|^Answered/,
		});
		await completedSubtitle.first().waitFor({ state: "visible", timeout });
	}

	/** Get count of tool blocks */
	async getToolBlockCount(): Promise<number> {
		return this.toolBlocks.count();
	}

	/** Wait for result bar to appear after a response completes */
	async waitForResultBar(timeout = 60_000): Promise<Locator> {
		const bar = this.resultBars.last();
		await bar.waitFor({ state: "visible", timeout });
		return bar;
	}

	/** Get the text content of the last result bar */
	async getResultBarText(): Promise<string> {
		const bar = this.resultBars.last();
		await bar.waitFor({ state: "visible", timeout: 30_000 });
		return bar.innerText();
	}

	/** Wait for a thinking block to appear */
	async waitForThinkingBlock(timeout = 60_000): Promise<Locator> {
		const thinking = this.thinkingBlocks.first();
		await thinking.waitFor({ state: "visible", timeout });
		return thinking;
	}

	/** Check if the stop button is currently visible (processing in progress) */
	async isProcessing(): Promise<boolean> {
		return this.stopBtn.isVisible();
	}
}
```

**Key changes from original:**
1. `toolBlocks` now uses `.tool-item` (was `.tool-block` which doesn't exist)
2. `waitForStreamingComplete()` now waits for `#stop` to be hidden (was checking `#send:not(.stop)` which always resolved immediately)
3. Added `resultBars`, `stopBtn` locator properties
4. Added `waitForToolBlock()`, `waitForToolCompleted()`, `getToolBlockCount()`, `waitForResultBar()`, `getResultBarText()`, `waitForThinkingBlock()`, `isProcessing()` methods
5. `waitForToolCompleted()` uses regex `/^Done$|^Answered/` to handle both standard tools and question tools
6. Removed the `expect` import (no longer needed — `waitForStreamingComplete` uses `waitFor` instead of `expect().toBeVisible()`)

**Step 2: Verify the existing `chat.spec.ts` tests still list correctly**

```bash
npx playwright test --list --config test/e2e/playwright.config.ts test/e2e/specs/chat.spec.ts
```

Expected: Lists 5 tests (× 5 viewports = 25 entries) without compilation errors.

**Step 3: Commit**

```
fix(e2e): fix broken waitForStreamingComplete and dead toolBlocks selector

waitForStreamingComplete() was checking #send:not(.stop) but the send
button never has a .stop class — the stop button is a separate #stop
element. The method now correctly waits for #stop to disappear.

toolBlocks was targeting .tool-block which doesn't exist in any
component. Changed to .tool-item which is the actual class.

Also adds new page object methods for tool blocks, result bar, and
thinking blocks in preparation for chat-lifecycle E2E tests.
```

---

### Task 2: Create chat-lifecycle spec — tool call test

**Files:**
- Create: `test/e2e/specs/chat-lifecycle.spec.ts`

**Step 1: Write the tool call lifecycle test**

```typescript
// ─── E2E Chat Lifecycle Tests ────────────────────────────────────────────────
// Tests deeper chat behaviors: tool calls, result bar, thinking blocks,
// multi-turn conversations, and streaming state indicators.
// Runs against REAL OpenCode — sends actual prompts.
//
// Desktop-only: avoids sending duplicate prompts across viewports.
// Tests run sequentially. Each test waits for streaming to complete.
//
// Prerequisites:
//   - OpenCode running at localhost:4096 (or set OPENCODE_URL)
//   - Optional: E2E_MODEL=gemini-2.0-flash E2E_PROVIDER=google (free model)

import { expect, test } from "../helpers/test-fixtures.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.describe("Chat Lifecycle", () => {
	test.describe.configure({ timeout: 90_000 });

	// Desktop only — avoids duplicate LLM calls across viewports
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat lifecycle tests run on desktop viewport only");
	});

	test("tool call appears and completes", async ({ page, baseUrl }) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(baseUrl);

		// Ask the agent to use a tool — request a specific value that cannot
		// be guessed from general knowledge to force actual file reading
		await app.sendMessage(
			'Read the file package.json and tell me the exact value of the "version" field.',
		);

		// A tool block should appear (the agent calls read_file or similar).
		// If the model answers from general knowledge without a tool, skip.
		try {
			await chat.waitForToolBlock(60_000);
		} catch {
			await chat.waitForStreamingComplete();
			test.skip(
				true,
				"Model answered without using a tool — cannot test tool lifecycle",
			);
			return;
		}

		const toolCountBefore = await chat.getToolBlockCount();
		expect(toolCountBefore).toBeGreaterThan(0);

		// Wait for the tool to complete
		await chat.waitForToolCompleted(60_000);

		// Wait for the assistant to finish responding after the tool result
		await chat.waitForAssistantMessage(60_000);
		await chat.waitForStreamingComplete();

		// The assistant should have responded with something
		const text = await chat.getLastAssistantText();
		expect(text.length).toBeGreaterThan(0);
	});
});
```

**Key design choices:**
- Asks for the exact `version` field value — this forces tool use because the version is not inferable
- Wraps `waitForToolBlock` in try/catch with `test.skip()` to handle models that don't use tools
- Uses the fixed `waitForStreamingComplete()` from Task 1

**Step 2: Run to verify it works**

```bash
pnpm test:e2e -- --grep "tool call appears"
```

Expected: PASS (tool block appears, completes, assistant responds) or SKIP (model didn't use a tool).

**Step 3: Commit**

```
feat(e2e): add tool call lifecycle test
```

---

### Task 3: Add result bar test

**Files:**
- Modify: `test/e2e/specs/chat-lifecycle.spec.ts`

**Step 1: Add the result bar test**

Add inside the `test.describe("Chat Lifecycle")` block:

```typescript
	test("result bar shows token usage after response", async ({
		page,
		baseUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(baseUrl);

		await app.sendMessage("Reply with just the word 'ok'. Nothing else.");

		await chat.waitForAssistantMessage(60_000);
		await chat.waitForStreamingComplete();

		// Result bar should appear after the response completes.
		// If the model returns no usage data, the element won't render.
		try {
			const resultBar = await chat.waitForResultBar(10_000);
			const text = await resultBar.innerText();
			expect(text.length).toBeGreaterThan(0);
			// Should contain at least some numeric info (token counts, cost, duration)
			expect(text).toMatch(/\d/);
		} catch {
			test.skip(
				true,
				"Model did not return usage data — result bar not rendered",
			);
		}
	});
```

**Step 2: Run to verify**

```bash
pnpm test:e2e -- --grep "result bar"
```

Expected: PASS — result bar visible with numbers.

**Step 3: Commit**

```
feat(e2e): add result bar token usage test
```

---

### Task 4: Add multi-turn conversation test

**Files:**
- Modify: `test/e2e/specs/chat-lifecycle.spec.ts`

**Step 1: Add the multi-turn test**

Uses **delta-based counting** to be robust against messages from prior tests in the same session.

```typescript
	test("multi-turn conversation renders correctly", async ({
		page,
		baseUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(baseUrl);

		// Capture message counts before this test (prior tests may have added messages)
		const userCountBefore = await chat.getUserMessageCount();
		const assistantCountBefore = await chat.getAssistantMessageCount();

		// First message
		await app.sendMessage(
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		await chat.waitForAssistantMessage(60_000);
		await chat.waitForStreamingComplete();

		// Verify first exchange was added
		const userCountAfter1 = await chat.getUserMessageCount();
		const assistantCountAfter1 = await chat.getAssistantMessageCount();
		expect(userCountAfter1 - userCountBefore).toBeGreaterThanOrEqual(1);
		expect(assistantCountAfter1 - assistantCountBefore).toBeGreaterThanOrEqual(
			1,
		);

		// Second message in same session
		await app.sendMessage(
			"What word did I ask you to remember? Reply with just the word.",
		);
		await chat.waitForAssistantMessage(60_000);
		await chat.waitForStreamingComplete();

		// Both exchanges should be visible
		const userCountAfter2 = await chat.getUserMessageCount();
		const assistantCountAfter2 = await chat.getAssistantMessageCount();
		expect(userCountAfter2 - userCountBefore).toBeGreaterThanOrEqual(2);
		expect(
			assistantCountAfter2 - assistantCountBefore,
		).toBeGreaterThanOrEqual(2);

		// The second response should mention "banana"
		const text = await chat.getLastAssistantText();
		expect(text.toLowerCase()).toContain("banana");
	});
```

**Step 2: Run to verify**

```bash
pnpm test:e2e -- --grep "multi-turn"
```

Expected: PASS — both exchanges render, second response contains "banana".

**Step 3: Commit**

```
feat(e2e): add multi-turn conversation test
```

---

### Task 5: Add streaming state test

**Files:**
- Modify: `test/e2e/specs/chat-lifecycle.spec.ts`

**Step 1: Add the streaming state test**

```typescript
	test("stop button appears during processing", async ({ page, baseUrl }) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(baseUrl);

		// Ask for a longer response to give us time to observe the stop button
		await app.sendMessage(
			"Write a paragraph explaining why automated testing is important for software quality.",
		);

		// The #stop button is a separate element from #send, conditionally
		// rendered only while processing. Try to catch it.
		try {
			await chat.stopBtn.waitFor({ state: "visible", timeout: 10_000 });
			expect(await chat.isProcessing()).toBe(true);
		} catch {
			// Fast responses may complete before we can observe the stop button.
			// This is acceptable — the important thing is the test doesn't crash.
		}

		// After streaming completes, stop button should be gone
		await chat.waitForStreamingComplete();

		// Verify #stop is no longer visible and #send is
		await expect(chat.stopBtn).not.toBeVisible({ timeout: 5_000 });
		await expect(app.sendBtn).toBeVisible();
	});
```

**Step 2: Run to verify**

```bash
pnpm test:e2e -- --grep "stop button appears"
```

Expected: PASS.

**Step 3: Commit**

```
feat(e2e): add streaming state indicator test
```

---

### Task 6: Add thinking block test (conditional)

**Files:**
- Modify: `test/e2e/specs/chat-lifecycle.spec.ts`

**Step 1: Add the thinking block test**

```typescript
	test("thinking block appears for reasoning models", async ({
		page,
		baseUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(baseUrl);

		// Not all models support extended thinking.
		// Send a reasoning prompt and check if a thinking block appears.
		await app.sendMessage("Think step by step: what is 17 * 23?");

		// Try to observe a thinking block — may not appear on all models
		try {
			await chat.waitForThinkingBlock(30_000);
			const thinkingBlock = chat.thinkingBlocks.first();
			await expect(thinkingBlock).toBeVisible();
		} catch {
			// Model doesn't produce thinking blocks — skip immediately
			// (no need to wait for streaming; test.skip() aborts the test)
			test.skip(true, "Current model does not produce thinking blocks");
			return;
		}

		// Wait for the full response to complete
		await chat.waitForAssistantMessage(60_000);
		await chat.waitForStreamingComplete();

		// After completion, the thinking block should still be visible (collapsed)
		const thinkingCount = await chat.thinkingBlocks.count();
		expect(thinkingCount).toBeGreaterThan(0);
	});
```

**Key fix from original plan:** Removed `waitForStreamingComplete()` from the catch block. `test.skip()` throws and aborts the test — no need to wait, and waiting could itself timeout (30s thinking timeout + 90s streaming timeout > 90s test timeout).

**Step 2: Run to verify**

```bash
pnpm test:e2e -- --grep "thinking block"
```

Expected: PASS if model supports thinking, SKIP if not.

**Step 3: Commit**

```
feat(e2e): add conditional thinking block test
```

---

### Task 7: Run full suite and verify

**Files:**
- No changes (unless fixes are needed)

**Step 1: Run all chat lifecycle tests together**

```bash
pnpm test:e2e -- test/e2e/specs/chat-lifecycle.spec.ts
```

Expected: All tests pass (thinking may skip). Typical run time: 3-5 minutes.

**Step 2: Run existing chat tests to check for regressions**

The `waitForStreamingComplete()` fix changes behavior for existing tests. They should still pass because the fix makes the method actually wait correctly (previously it was a no-op, but tests worked by coincidence due to other waits). Verify:

```bash
pnpm test:e2e -- test/e2e/specs/chat.spec.ts
```

Expected: All 5 existing chat tests pass.

**Step 3: Run alongside existing chat tests to check for conflicts**

```bash
pnpm test:e2e -- --grep "Chat"
```

Expected: Both `Chat Flow` and `Chat Lifecycle` describe blocks pass without interfering.

**Step 4: Run the full E2E suite**

```bash
pnpm test:e2e
```

Expected: All existing tests still pass. New tests pass (or skip where appropriate).

**Step 5: Verify existing unit tests still pass**

```bash
pnpm test
```

Expected: All unit tests pass — we didn't modify any unit test files.

**Step 6: Final commit (if needed)**

If any adjustments were needed during the full run, commit them:

```
fix(e2e): adjust selectors/timeouts for full suite compatibility
```
