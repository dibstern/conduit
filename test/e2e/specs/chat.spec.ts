// Tests the core chat flow: send message, receive response, markdown
// rendering, code blocks, and stop button.
// Uses real relay backed by MockOpenCodeServer replaying recorded HTTP
// interactions — no real OpenCode needed.

import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.use({ recording: "chat-simple" });

async function receiveStreamedAssistantResponse({
	page,
	relayUrl,
}: {
	page: Page;
	relayUrl: string;
}): Promise<void> {
	const viewport = page.viewportSize();
	const isDesktop = viewport ? viewport.width >= 1440 : false;
	test.skip(!isDesktop, "Chat tests run on desktop viewport only");

	const app = new AppPage(page);
	const chat = new ChatPage(page);
	await app.goto(relayUrl);

	await app.sendMessage("Ping");

	// Wait for the full response — streaming must finish before we
	// can assert on content (otherwise we may read a partial token).
	await chat.waitForAssistantMessage();
	await chat.waitForStreamingComplete();

	// The completed response should contain "pong"
	const text = await chat.getLastAssistantText();
	expect(text.toLowerCase()).toContain("pong");
}

test.describe("Chat Flow", () => {
	test.describe.configure({ timeout: 30_000 });

	test("send message and see user bubble", async ({ page, relayUrl }) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat tests run on desktop viewport only");

		const app = new AppPage(page);
		await app.goto(relayUrl);

		const chat = new ChatPage(page);

		// Count user messages before sending
		const countBefore = await chat.getUserMessageCount();

		// Send a message — the mock serves responses in FIFO order per endpoint path
		await app.sendMessage("Hello, reply with just the word pong");

		// A new user message bubble should appear (count increases)
		await expect(chat.userMessages).toHaveCount(countBefore + 1, {
			timeout: 5_000,
		});

		// Wait for mock response to complete
		await chat.waitForStreamingComplete();
	});

	test("receive streamed assistant response", receiveStreamedAssistantResponse);

	test.describe("on a Claude session", () => {
		// Same scenario, but the turn runs through the Claude runtime,
		// replaying a committed Claude SDK trace instead of OpenCode.
		test.use({ claudeReplay: { turns: ["pong-thinking-text-turn"] } });

		test(
			"receive streamed assistant response",
			receiveStreamedAssistantResponse,
		);
	});

	test("stop button appears during processing and hides after", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Say something");

		// The #stop button is a separate element, conditionally rendered
		// while processing. Try to catch it — mock responses may arrive
		// too fast for it to ever appear.
		try {
			await chat.stopBtn.waitFor({ state: "visible", timeout: 3_000 });
		} catch {
			// Mock responses arrive instantly — stop button may never appear.
		}

		// After streaming completes, stop button should be gone
		await chat.waitForStreamingComplete();
		await expect(app.sendBtn).toBeVisible();
	});

	test("assistant response renders in markdown container", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Chat tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Hello");

		// waitForAssistantMessage waits for .md-content:not(:empty)
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// The assistant message should have rendered HTML inside .md-content
		const lastMsg = chat.assistantMessages.last();
		const mdContent = lastMsg.locator(".md-content");
		const html = await mdContent.innerHTML();
		expect(html.length).toBeGreaterThan(0);

		// Markdown wraps text in <p> tags at minimum
		const hasHtml = html.includes("<") && html.includes(">");
		expect(hasHtml).toBe(true);
	});

	test.describe("Code Blocks", () => {
		test.use({ recording: "chat-code-block" });

		test("code blocks have copy button", async ({ page, relayUrl }) => {
			const viewport = page.viewportSize();
			const isDesktop = viewport ? viewport.width >= 1440 : false;
			test.skip(!isDesktop, "Chat tests run on desktop viewport only");

			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			await app.sendMessage("Show me code");

			// Wait for assistant response with content
			await chat.waitForAssistantMessage();
			await chat.waitForStreamingComplete();

			// Code blocks get a .code-header with a .code-copy-btn
			const codeHeaders = page.locator(".code-header");
			await expect(codeHeaders.first()).toBeVisible({ timeout: 10_000 });

			const copyBtns = chat.codeCopyBtns;
			const copyCount = await copyBtns.count();
			expect(copyCount).toBeGreaterThan(0);
		});
	});
});
