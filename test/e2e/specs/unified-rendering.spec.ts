// ─── E2E: Unified Message Rendering ──────────────────────────────────────────
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

// ─── No Duplication ──────────────────────────────────────────────────────────
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

		// Send the first message to establish baseline content
		await app.sendMessage("Show me a tool call");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		const usersBefore = await chat.getUserMessageCount();
		const assistantsBefore = await page.locator(".msg-assistant").count();

		// Send a prompt — triggers mock's SSE events for the next response
		await app.sendMessage("Ping");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// Exactly +1 user message and +1 assistant message — no duplicates
		const usersAfter = await chat.getUserMessageCount();
		const assistantsAfter = await page.locator(".msg-assistant").count();

		expect(usersAfter).toBe(usersBefore + 1);
		expect(assistantsAfter).toBe(assistantsBefore + 1);
	});

	test("no duplicate data-uuid attributes in the DOM", async ({
		page,
		relayUrl,
	}) => {
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

// ─── Beginning of Session Marker ─────────────────────────────────────────────

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

// ─── Markdown Rendering Quality ──────────────────────────────────────────────
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

// ─── Scroll Behavior ─────────────────────────────────────────────────────────
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
		// 100px SCROLL_THRESHOLD — simulates a split-screen or short display
		await page.setViewportSize({ width: 1440, height: 300 });

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		// Send a prompt that produces a code block response (tall content)
		await app.sendMessage("Show me a code example");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// Verify content overflows enough to trigger the scroll button.
		// SCROLL_THRESHOLD is 100px — content must overflow by more than that.
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
		await page.waitForTimeout(300);

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

// ─── Paginated History ───────────────────────────────────────────────────────
// Uses a recording with 26 multi-turn prompts (52 messages), exceeding the
// default 50-message page size. The server returns hasMore:true on the first
// REST history page, enabling pagination via the IntersectionObserver.

test.describe("Unified Rendering: Paginated History", () => {
	test.describe.configure({ timeout: 90_000 });
	test.use({ recording: "chat-paginated-history" });

	test("session with >50 messages loads all pages via REST pagination", async ({
		page,
		relayUrl,
		harness,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		// ── Force REST fallback ──
		// The SSE consumer caches all events in memory. Stop it, then clear
		// the events cache so client-init falls through to REST history
		// which paginates at 50 messages per page (hasMore:true for 52 msgs).
		await harness.stack.sseConsumer.disconnect();
		const sessions = await harness.stack.client.listSessions();
		for (const s of sessions) {
			harness.stack.messageCache.remove(s.id);
		}

		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Wait for messages to fully load via REST pagination.
		// With 52 messages and page size 50, the relay loads 2 pages:
		//   page 1: 50 messages (hasMore=true) → observer fires automatically
		//   page 2: 2 messages (hasMore=false)
		// Both pages load near-instantly from the mock, so we verify the
		// final state: all 26 user messages present and marker visible.
		await page.waitForFunction(
			() => document.querySelectorAll(".msg-user").length >= 26,
			{ timeout: 15_000 },
		);

		const userCount = await page.locator(".msg-user").count();
		expect(userCount).toBe(26);

		// After all pages loaded, "Beginning of session" marker appears
		await expect(page.locator(".history-beginning")).toBeVisible({
			timeout: 5_000,
		});
	});

	test("scrolling up loads more history and 'Beginning of session' appears", async ({
		page,
		relayUrl,
		harness,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Unified rendering tests run on desktop only");

		// Force REST fallback
		await harness.stack.sseConsumer.disconnect();
		const sessions = await harness.stack.client.listSessions();
		for (const s of sessions) {
			harness.stack.messageCache.remove(s.id);
		}

		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Wait for first page
		await page.locator(".msg-user").first().waitFor({
			state: "visible",
			timeout: 15_000,
		});

		const msgsBefore = await page.locator(".msg-user").count();

		// Scroll to the very top to trigger the IntersectionObserver on
		// #history-sentinel, which fires load_more_history
		const messagesEl = page.locator("#messages");
		await messagesEl.evaluate((el) => {
			el.scrollTop = 0;
			el.dispatchEvent(new Event("scroll"));
		});

		// Wait for more messages to appear (history page loaded and prepended)
		await page.waitForFunction(
			(prevCount: number) =>
				document.querySelectorAll(".msg-user").length > prevCount,
			msgsBefore,
			{ timeout: 15_000 },
		);

		const msgsAfter = await page.locator(".msg-user").count();
		expect(msgsAfter).toBeGreaterThan(msgsBefore);

		// After the second page loads (only 2 messages remaining beyond the first
		// 50), "Beginning of session" should appear since hasMore becomes false
		await expect(page.locator(".history-beginning")).toBeVisible({
			timeout: 15_000,
		});
	});
});
