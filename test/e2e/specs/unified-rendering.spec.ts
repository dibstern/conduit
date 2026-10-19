// Validates that the unified rendering path works correctly in a real browser:
// - No duplicate messages after session load + prompt
// - "Beginning of session" marker appears
// - Markdown renders as HTML (real DOMPurify, not mock)
// - Scroll-to-bottom button works
//
// Uses replay fixture with MockOpenCodeServer — no real OpenCode needed.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

// The original bug: events cache replay + IntersectionObserver race caused the
// entire conversation to render twice. These tests verify each message appears
// exactly once in the DOM.

test.describe("Unified Rendering: No Duplication", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-simple" });

	test("prompt produces exactly one new user message and one new assistant response", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		// Baseline: no messages before first prompt
		const usersBefore = await chat.userMessages.count();
		const assistantsBefore = await chat.assistantMessages.count();

		// Send the recording's own prompt: the mock replays the recorded user
		// message, and a bubble only reconciles with a row of the same text.
		await app.sendMessage("Hello, reply with just the word pong");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		const usersAfter = await chat.userMessages.count();
		const assistantsAfter = await chat.assistantMessages.count();

		expect(usersAfter).toBe(usersBefore + 1);
		expect(assistantsAfter).toBe(assistantsBefore + 1);
	});

	test("no duplicate data-uuid attributes in the DOM", async ({
		page,
		relayUrl,
	}) => {
		// This test sends two messages (double the work of other tests in this
		// describe block), so the default 30 s timeout can be too tight in CI.
		test.setTimeout(60_000);

		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		// Send a message to populate the DOM
		await app.sendMessage("Show me a tool call");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// Send a prompt to add more content
		await app.sendMessage("Ping");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// Every message element should have a unique UUID.
		const allUuids = await page
			.locator("[data-uuid]")
			.evaluateAll((els) =>
				els.map((el) => el.getAttribute("data-uuid")).filter(Boolean),
			);
		const uniqueUuids = new Set(allUuids);
		expect(allUuids.length).toBeGreaterThan(0);
		expect(uniqueUuids.size).toBe(allUuids.length);
	});
});

test.describe("Unified Rendering: Session Markers", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-simple" });

	test("'Beginning of session' marker is visible", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		const app = new AppPage(page);
		await app.goto(relayUrl);

		const marker = page.locator(".history-beginning");
		await expect(marker).toBeVisible({ timeout: 10_000 });
		await expect(marker).toContainText("Beginning of session");
	});

	test("loading indicator is not visible when not loading", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		const app = new AppPage(page);
		await app.goto(relayUrl);

		await page.locator(".history-beginning").waitFor({ timeout: 10_000 });

		const loading = page.locator(".history-loading");
		await expect(loading).not.toBeVisible();
	});
});

// Unit tests use a mock DOMPurify. These E2E tests exercise the real rendering
// pipeline in a real browser with real DOMPurify.

test.describe("Unified Rendering: Markdown", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "chat-code-block" });

	test("assistant response renders markdown as HTML, not raw text", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Show me a code example");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		const mdContent = page.locator(".msg-assistant .md-content").last();
		await expect(mdContent).toBeVisible();

		const hasHtmlChildren = await mdContent.evaluate((el) => {
			return el.querySelectorAll("p, pre, code, ul, ol, h1, h2, h3").length > 0;
		});
		expect(hasHtmlChildren).toBe(true);
	});

	test("code blocks render with pre/code structure", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Show me code");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		const codeBlocks = page.locator(".msg-assistant pre code");
		const count = await codeBlocks.count();
		expect(count).toBeGreaterThan(0);

		const firstBlock = codeBlocks.first();
		await expect(firstBlock).toBeVisible();
		const text = await firstBlock.innerText();
		expect(text.length).toBeGreaterThan(0);
	});
});

// Verifies the scroll-to-bottom button appears when scrolled up and works when
// clicked. Uses chat-code-block recording which produces tall code blocks, and
// a 400px viewport height to guarantee content overflows (simulates split-screen
// or short laptop display — a real usage scenario).

test.describe("Unified Rendering: Scroll", () => {
	test.describe.configure({ timeout: 60_000 });
	test.use({ recording: "chat-code-block" });

	test("scroll-to-bottom button appears when scrolled up and works when clicked", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		// Use 300px height to guarantee content overflows well past the
		// 50px SCROLL_THRESHOLD — simulates a split-screen or short display
		await page.setViewportSize({ width: 1440, height: 300 });

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		// Send a prompt that produces a code block response (tall content)
		await app.sendMessage("Show me a code example");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// Verify content overflows enough to trigger the scroll button.
		// SCROLL_THRESHOLD is 50px — content must overflow by more than that.
		// If this fails, the recording doesn't produce enough content or the
		// viewport is too tall.
		const messagesEl = page.locator("#messages");
		const overflow = await messagesEl.evaluate(
			(el) => el.scrollHeight - el.clientHeight,
		);
		expect(overflow).toBeGreaterThan(100);

		// Scroll to top — set scrollTop AND dispatch scroll event so the
		// onscroll handler fires (Playwright evaluate doesn't always trigger
		// synthetic scroll events from programmatic scrollTop changes)
		await messagesEl.evaluate((el) => {
			el.scrollTop = 0;
			el.dispatchEvent(new Event("scroll"));
		});

		// Scroll button should appear
		const scrollBtn = page.locator("#scroll-btn");
		await expect(scrollBtn).toBeVisible({ timeout: 5_000 });

		// Click it
		await scrollBtn.click();

		// Should scroll to bottom and hide the button
		await expect(scrollBtn).not.toBeVisible({ timeout: 5_000 });

		// Verify we're actually at the bottom
		const isAtBottom = await messagesEl.evaluate((el) => {
			const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			return distFromBottom < 50;
		});
		expect(isAtBottom).toBe(true);
	});
});
