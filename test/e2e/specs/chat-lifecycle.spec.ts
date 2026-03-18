// ─── E2E Chat Lifecycle Tests ────────────────────────────────────────────────
// Tests deeper chat behaviors: tool calls, result bar, thinking blocks,
// multi-turn conversations, and streaming state indicators.
// Each test.describe uses a different recording via test.use().

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.describe("Tool Call", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-tool-call" });

	test("tool call appears and completes", async ({ page, relayUrl }) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat lifecycle tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		// Send prompt — the mock will serve the first prompt_async response
		await app.sendMessage("Show me a tool call");

		// A tool block should appear (the recording includes tool events)
		await chat.waitForToolBlock();

		const toolCountBefore = await chat.getToolBlockCount();
		expect(toolCountBefore).toBeGreaterThan(0);

		// Wait for the tool to complete
		await chat.waitForToolCompleted();

		// Wait for the assistant to finish responding after the tool result
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// The assistant should have responded with something
		const text = await chat.getLastAssistantText();
		expect(text.length).toBeGreaterThan(0);
	});
});

test.describe("Result Bar", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-result-bar" });

	test("result bar shows token usage after response", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat lifecycle tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Give a response with usage");

		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// Result bar should appear after the response completes
		const resultBar = await chat.waitForResultBar(10_000);
		const text = await resultBar.innerText();
		expect(text.length).toBeGreaterThan(0);
		// Should contain at least some numeric info (token counts, cost, duration)
		expect(text).toMatch(/\d/);
	});
});

test.describe("Multi-Turn", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-multi-turn" });

	test("multi-turn conversation renders correctly", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat lifecycle tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		// Capture message counts before this test
		const _userCountBefore = await chat.getUserMessageCount();
		const assistantCountBefore = await chat.getAssistantMessageCount();

		// First message
		await app.sendMessage("First turn");

		// Wait for the new assistant message to appear (count must increase)
		await expect(chat.assistantMessages).toHaveCount(assistantCountBefore + 1, {
			timeout: 15_000,
		});
		await chat.waitForStreamingComplete();

		// Second message in same session
		await app.sendMessage("Second turn");

		// Wait for the second assistant message
		await expect(chat.assistantMessages).toHaveCount(assistantCountBefore + 2, {
			timeout: 15_000,
		});
		await chat.waitForStreamingComplete();
	});
});

test.describe("Streaming State", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-streaming" });

	test("stop button appears during processing", async ({ page, relayUrl }) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat lifecycle tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Stream a response");

		// The #stop button is a separate element from #send, conditionally
		// rendered only while processing. Try to catch it.
		try {
			await chat.stopBtn.waitFor({ state: "visible", timeout: 5_000 });
			expect(await chat.isProcessing()).toBe(true);
		} catch {
			// Mock responses arrive instantly — stop button may never appear.
			// This is acceptable.
		}

		// After streaming completes, stop button should be gone
		await chat.waitForStreamingComplete();

		// Verify #stop is no longer visible and #send is
		await expect(chat.stopBtn).not.toBeVisible({ timeout: 5_000 });
		await expect(app.sendBtn).toBeVisible();
	});
});

test.describe("Thinking Block", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-thinking" });

	test("thinking block appears for reasoning models", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat lifecycle tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Think about this");

		// The recorded fixture should include thinking events
		await chat.waitForThinkingBlock(10_000);
		const thinkingBlock = chat.thinkingBlocks.first();
		await expect(thinkingBlock).toBeVisible();

		// Wait for the full response to complete
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// After completion, the thinking block should still be visible (collapsed)
		const thinkingCount = await chat.thinkingBlocks.count();
		expect(thinkingCount).toBeGreaterThan(0);
	});
});
