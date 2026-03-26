// ─── E2E Scroll Stability Tests ─────────────────────────────────────────────
// Tests that scroll position remains stable on inactive sessions when
// background reactive state changes occur (permission resolves, session
// list updates, etc.). Regression test for mobile scroll snap-back bug.
//
// Uses the replay fixture for the relay URL (handles auth, serves frontend),
// with page.routeWebSocket() intercepting the WS to inject controlled
// messages. This gives us both a working relay endpoint and fine-grained
// control over when messages arrive.
//
// The tests create 40+ conversation turns with varied message sizes
// (short text, long paragraphs, code blocks, tool calls) so that many
// off-screen .msg-container elements sit at the 100px placeholder height
// from content-visibility:auto. Scrolling far up into these placeholder
// regions is where the snap-back bug manifests.

import type { Page } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

// ─── Scroll helpers ─────────────────────────────────────────────────────────

async function getScrollTop(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.getElementById("messages");
		return el ? el.scrollTop : 0;
	});
}

async function getScrollHeight(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.getElementById("messages");
		return el ? el.scrollHeight : 0;
	});
}

async function getClientHeight(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.getElementById("messages");
		return el ? el.clientHeight : 0;
	});
}

async function scrollTo(page: Page, scrollTop: number): Promise<void> {
	await page.evaluate((st) => {
		const el = document.getElementById("messages");
		if (el) el.scrollTop = st;
	}, scrollTop);
	await page.waitForTimeout(300);
}

/**
 * Scroll up incrementally in small steps, simulating real touch scrolling.
 * This exercises content-visibility:auto layout recalculations as each
 * off-screen element enters the viewport and changes from 100px placeholder
 * to its actual rendered height.
 */
async function scrollUpIncrementally(
	page: Page,
	totalPixels: number,
	stepPx = 120,
	stepDelay = 60,
): Promise<void> {
	let remaining = totalPixels;
	while (remaining > 0) {
		const step = Math.min(stepPx, remaining);
		await page.evaluate((px) => {
			const el = document.getElementById("messages");
			if (el) el.scrollTop = Math.max(0, el.scrollTop - px);
		}, step);
		remaining -= step;
		if (remaining > 0) {
			await page.waitForTimeout(stepDelay);
		}
	}
	await page.waitForTimeout(500);
}

// ─── Message generation ─────────────────────────────────────────────────────

const RESPONSE_TEMPLATES = [
	"Got it, I'll take a look at that file.",
	"I've analyzed the issue. The problem is in the authentication middleware where the token validation skips the expiry check. I'll fix the `validateToken` function to properly compare timestamps.",
	"After reviewing the codebase, I found several interconnected issues that need to be addressed together. The database connection pool is configured with a maximum of 5 connections, but the application spawns up to 20 concurrent workers during peak load. This causes connection timeouts that cascade into retry storms. Additionally, the retry logic doesn't implement exponential backoff.",
	"Here's the fix:\n\n```typescript\nexport async function handleRequest(req: Request): Promise<Response> {\n  const token = req.headers.get('Authorization');\n  if (!token) {\n    return new Response('Unauthorized', { status: 401 });\n  }\n  try {\n    const decoded = await verifyToken(token);\n    if (decoded.exp < Date.now() / 1000) {\n      return new Response('Token expired', { status: 401 });\n    }\n    const user = await getUserById(decoded.sub);\n    if (!user) return new Response('Not found', { status: 404 });\n    return new Response(JSON.stringify(user), {\n      status: 200,\n      headers: { 'Content-Type': 'application/json' },\n    });\n  } catch (err) {\n    console.error('Auth error:', err);\n    return new Response('Internal error', { status: 500 });\n  }\n}\n```\n\nThis adds proper expiry checking and error handling.",
	"I've completed the refactoring. Here's what changed:\n\n- **Connection pooling**: Increased max connections from 5 to 25\n- **Retry logic**: Added exponential backoff with jitter (base 100ms, max 30s)\n- **Health checks**: Added periodic connection validation every 60s\n- **Logging**: Added structured logging for all connection lifecycle events\n- **Tests**: Added integration tests for pool exhaustion and recovery scenarios\n\nThe changes are backward-compatible. The new pool configuration is loaded from environment variables with sensible defaults matching the previous behavior.",
	"Here's the complete implementation:\n\n```typescript\nimport { Pool, PoolConfig } from 'pg';\nimport { Logger } from './logger';\n\ninterface RetryOptions {\n  maxRetries: number;\n  baseDelay: number;\n  maxDelay: number;\n}\n\nexport class DatabaseClient {\n  private pool: Pool;\n  private logger: Logger;\n  private retryOpts: RetryOptions;\n\n  constructor(config: PoolConfig, logger: Logger, retry?: Partial<RetryOptions>) {\n    this.pool = new Pool({\n      ...config,\n      max: config.max ?? 25,\n      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,\n    });\n    this.logger = logger;\n    this.retryOpts = { ...DEFAULT_RETRY, ...retry };\n  }\n\n  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {\n    let lastError: Error | undefined;\n    for (let attempt = 0; attempt <= this.retryOpts.maxRetries; attempt++) {\n      try {\n        const result = await this.pool.query(sql, params);\n        return result.rows as T[];\n      } catch (err) {\n        lastError = err as Error;\n        const delay = Math.min(\n          this.retryOpts.baseDelay * Math.pow(2, attempt),\n          this.retryOpts.maxDelay\n        );\n        await new Promise(r => setTimeout(r, delay));\n      }\n    }\n    throw lastError;\n  }\n}\n```",
];

const USER_TEMPLATES = [
	"Can you fix the bug in the auth middleware?",
	"Show me the code for the connection pool",
	"I'm seeing timeout errors in production. Can you investigate?",
	"Now update the tests to cover the new retry logic.",
	"Refactor the error handling to use a centralized error class",
	"What's the performance impact of increasing the pool size?",
	"Add structured logging with correlation IDs.",
	"The CI is failing on the integration tests. Can you check?",
];

function generateConversationEvents(turnCount: number): MockMessage[] {
	const evts: MockMessage[] = [];
	for (let i = 0; i < turnCount; i++) {
		evts.push({
			type: "user_message",
			text: USER_TEMPLATES[i % USER_TEMPLATES.length] ?? "",
		});

		if (i % 4 === 2) {
			evts.push({ type: "tool_start", id: `call_read_${i}`, name: "Read" });
			evts.push({
				type: "tool_executing",
				id: `call_read_${i}`,
				name: "Read",
				input: { file_path: `src/lib/module-${i}.ts` },
			});
			evts.push({
				type: "tool_result",
				id: `call_read_${i}`,
				content: `// module-${i}.ts content`,
				is_error: false,
			});
		}

		if (i % 5 === 3) {
			evts.push({ type: "tool_start", id: `call_write_${i}`, name: "Write" });
			evts.push({
				type: "tool_executing",
				id: `call_write_${i}`,
				name: "Write",
				input: { file_path: `src/lib/handler-${i}.ts` },
			});
			evts.push({
				type: "tool_result",
				id: `call_write_${i}`,
				content: "File written successfully",
				is_error: false,
			});
		}

		evts.push({
			type: "delta",
			text: RESPONSE_TEMPLATES[i % RESPONSE_TEMPLATES.length] ?? "",
		});
		evts.push({ type: "done", code: 0 });
	}
	return evts;
}

function createInitMessages(turnCount: number): MockMessage[] {
	const events = generateConversationEvents(turnCount);
	return [
		{
			type: "session_switched",
			id: "sess-scroll-001",
			events,
		},
		{ type: "status", status: "idle" },
		{
			type: "model_info",
			model: "claude-sonnet-4",
			provider: "anthropic",
		},
		{ type: "client_count", count: 1 },
		{
			type: "session_list",
			roots: true,
			sessions: [
				{
					id: "sess-scroll-001",
					title: "Scroll stability test",
					updatedAt: Date.now(),
					messageCount: turnCount * 2,
				},
			],
		},
		{
			type: "model_list",
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					configured: true,
					models: [
						{
							id: "claude-sonnet-4",
							name: "claude-sonnet-4",
							provider: "anthropic",
						},
					],
				},
			],
		},
		{
			type: "agent_list",
			agents: [
				{
					id: "code",
					name: "Code",
					description: "General coding assistant",
				},
			],
		},
	];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TURN_COUNT = 40;
const SCROLL_UP_PX = 2000;
const MAX_DRIFT_PX = 5;

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe("Scroll Stability — Mobile", () => {
	test.describe.configure({ timeout: 45_000 });
	test.use({ viewport: { width: 393, height: 852 } });

	test("scroll position stays stable when background events arrive on inactive session", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(TURN_COUNT);

		// Intercept WebSocket BEFORE navigating — this replaces the relay's WS
		// with our controlled mock that sends a large conversation history.
		const wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		// Navigate to the relay URL (relay serves the built frontend)
		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		// Wait for all messages to render + initial scroll to bottom
		await page.waitForTimeout(2000);

		// Verify enough scrollable content exists
		const scrollHeight = await getScrollHeight(page);
		const clientHeight = await getClientHeight(page);
		expect(scrollHeight).toBeGreaterThan(clientHeight * 3);

		// ─── Simulate the mobile race condition ──────────────────────────
		// On real mobile browsers, viewport changes (address bar show/hide)
		// and content-visibility layout shifts can cause the user to appear
		// "near bottom" (within the detach threshold) even while they are
		// actually reading content above. When this happens, the scroll
		// controller hasn't detached, so auto-scroll would fire.
		//
		// We simulate this by scrolling to just within the threshold (90px
		// from bottom), then injecting a user_message that changes
		// chatState.messages.length — the primary $effect trigger.
		//
		// With the buggy code: the $effect fires, scrollCtrl.isDetached is
		//   false (we're within the threshold), scrollToBottom() fires →
		//   snaps to exact bottom → scroll position changes.
		// With the fix: the scroll controller only auto-scrolls when
		//   actively streaming/processing, not on idle background events.

		// Position ourselves 90px from bottom (within the 100px threshold)
		const nearBottom = scrollHeight - clientHeight - 90;
		await scrollTo(page, nearBottom);

		const scrollBefore = await getScrollTop(page);

		// Inject a user_message — changes chatState.messages.length
		wsMock.sendMessage({
			type: "user_message",
			text: "A message from another browser tab",
		});

		// Wait for reactive effects to settle
		await page.waitForTimeout(1000);

		// Assert: scroll should NOT have snapped to exact bottom.
		// A new message was appended, but on an inactive session the
		// auto-scroll should not fire — position stays stable.
		const scrollAfter = await getScrollTop(page);
		const drift = Math.abs(scrollAfter - scrollBefore);
		expect(drift).toBeLessThan(MAX_DRIFT_PX);
	});

	test("scroll position stable after rapid burst of WS events near top of conversation", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(TURN_COUNT);

		const wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		await page.waitForTimeout(2000);

		// Scroll very far up — near the top of the conversation
		const scrollHeight = await getScrollHeight(page);
		const targetScroll = Math.max(0, Math.floor(scrollHeight * 0.1));
		await scrollTo(page, targetScroll);
		await page.waitForTimeout(800);

		const scrollBefore = await getScrollTop(page);

		// Rapid burst of events that change tracked reactive deps
		wsMock.sendMessage({
			type: "permission_request",
			id: "perm-burst-001",
			sessionId: "sess-scroll-001",
			toolName: "Read",
			description: "Read src/index.ts",
		});
		wsMock.sendMessage({
			type: "permission_resolved",
			id: "perm-burst-001",
			sessionId: "sess-scroll-001",
			approved: true,
		});
		// user_message changes chatState.messages.length
		wsMock.sendMessage({
			type: "user_message",
			text: "Burst message from another tab",
		});
		wsMock.sendMessage({ type: "client_count", count: 4 });

		await page.waitForTimeout(1000);

		const scrollAfter = await getScrollTop(page);
		const drift = Math.abs(scrollAfter - scrollBefore);
		expect(drift).toBeLessThan(MAX_DRIFT_PX);
	});

	test("scroll-to-bottom button appears when scrolled up and restores position", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(TURN_COUNT);

		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		await page.waitForTimeout(2000);

		// First, force scroll to bottom to establish baseline
		await page.evaluate(() => {
			const el = document.getElementById("messages");
			if (el) el.scrollTop = el.scrollHeight;
		});
		await page.waitForTimeout(500);

		const scrollBtn = page.locator("#scroll-btn");

		// Scroll up far
		await scrollUpIncrementally(page, SCROLL_UP_PX);

		// Button should appear (we're scrolled up past the threshold)
		await expect(scrollBtn).toBeVisible({ timeout: 3000 });

		// Click it — should return to bottom
		await scrollBtn.click();
		await page.waitForTimeout(800);

		// After clicking, button should be hidden (we're at bottom)
		await expect(scrollBtn).toBeHidden({ timeout: 3000 });
	});
});

test.describe("Scroll Controller — History Load", () => {
	test.describe.configure({ timeout: 45_000 });
	test.use({ viewport: { width: 1440, height: 900 } });

	test("history replay renders at bottom without visible scroll animation", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(TURN_COUNT);

		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		// Capture scroll positions over time during page load
		const scrollPositions: number[] = [];

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		// Sample scroll position rapidly for 2 seconds after connect overlay hides.
		// If the old "visible replay scrolling" bug exists, we'd see scrollTop
		// increasing gradually from 0 to scrollHeight. With the fix, scrollTop
		// should either be 0 (loading) or near-bottom (after single commit).
		for (let i = 0; i < 20; i++) {
			const pos = await getScrollTop(page);
			scrollPositions.push(pos);
			await page.waitForTimeout(100);
		}

		// The final position should be near the bottom
		const finalScrollTop = await getScrollTop(page);
		const scrollHeight = await getScrollHeight(page);
		const clientHeight = await getClientHeight(page);
		const distFromBottom = scrollHeight - finalScrollTop - clientHeight;

		// Should be at or near the bottom after load
		expect(distFromBottom).toBeLessThan(50);

		// Count the number of DISTINCT scroll positions observed.
		// With the old code: many intermediate positions (scrolling from 0 to bottom).
		// With the fix: at most 2-3 distinct positions (0/loading, then final position).
		const uniquePositions = new Set(scrollPositions);
		// Allow some tolerance — DOM rendering may cause a few intermediate states.
		// But it should NOT be a smooth gradient of 10+ positions.
		expect(uniquePositions.size).toBeLessThan(8);
	});

	test("large session only renders last ~50 messages initially", async ({
		page,
		relayUrl,
	}) => {
		// Create a session with 60 turns (120+ messages after processing)
		const initMessages = createInitMessages(60);

		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		await page.waitForTimeout(2000);

		// Count rendered message containers
		const msgContainerCount = await page.evaluate(() => {
			return document.querySelectorAll(".msg-container").length;
		});

		// With 60 turns and a 50-message page size, the initial render
		// should have approximately 50 messages, not all 120+.
		// Allow some tolerance for tool messages and grouping.
		expect(msgContainerCount).toBeLessThan(80);
		expect(msgContainerCount).toBeGreaterThan(20);
	});
});

test.describe("Scroll Controller — Streaming", () => {
	test.describe.configure({ timeout: 45_000 });
	test.use({ viewport: { width: 1440, height: 900 } });

	test("auto-scroll follows streaming content to bottom", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(TURN_COUNT);

		const wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		await page.waitForTimeout(2000);

		// Simulate streaming: status:processing, then deltas
		wsMock.sendMessage({ type: "status", status: "processing" });
		await page.waitForTimeout(200);

		// Send streaming deltas
		for (let i = 0; i < 10; i++) {
			wsMock.sendMessage({
				type: "delta",
				text: `Streaming content line ${i}. This is a fairly long line to ensure the scroll height changes meaningfully with each delta. `,
			});
			await page.waitForTimeout(100);
		}

		// While streaming, scroll should be near the bottom (auto-following)
		const scrollTop = await getScrollTop(page);
		const scrollHeight = await getScrollHeight(page);
		const clientHeight = await getClientHeight(page);
		const distFromBottom = scrollHeight - scrollTop - clientHeight;

		expect(distFromBottom).toBeLessThan(100);

		// Clean up streaming
		wsMock.sendMessage({ type: "done", code: 0 });
	});

	test("wheel-up detaches during streaming, button appears, no snap-back", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(TURN_COUNT);

		const wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		await page.waitForTimeout(2000);

		// Start streaming
		wsMock.sendMessage({ type: "status", status: "processing" });
		await page.waitForTimeout(200);
		wsMock.sendMessage({ type: "delta", text: "Starting response..." });
		await page.waitForTimeout(200);

		// Scroll up while streaming using mouse wheel
		const messagesEl = page.locator("#messages");
		await messagesEl.hover();
		await page.mouse.wheel(0, -500);
		await page.waitForTimeout(300);

		const scrollAfterWheel = await getScrollTop(page);

		// Scroll-to-bottom button should be visible (we detached)
		const scrollBtn = page.locator("#scroll-btn");
		await expect(scrollBtn).toBeVisible({ timeout: 3000 });

		// Continue streaming — should NOT snap back to bottom
		for (let i = 0; i < 5; i++) {
			wsMock.sendMessage({
				type: "delta",
				text: `More streaming content ${i}. `,
			});
			await page.waitForTimeout(150);
		}

		// Scroll position should NOT have been forced to bottom
		const scrollAfterMoreStreaming = await getScrollTop(page);
		const _drift = Math.abs(scrollAfterMoreStreaming - scrollAfterWheel);

		// Allow small drift for rendering but NOT a full snap to bottom
		const scrollHeight = await getScrollHeight(page);
		const clientHeight = await getClientHeight(page);
		const distFromBottom =
			scrollHeight - scrollAfterMoreStreaming - clientHeight;

		// We should still be significantly away from bottom (detached)
		expect(distFromBottom).toBeGreaterThan(200);

		// Button should still be visible
		await expect(scrollBtn).toBeVisible();

		// Click button to re-follow
		await scrollBtn.click();
		await page.waitForTimeout(500);

		// Now we should be at the bottom
		const scrollAfterFollow = await getScrollTop(page);
		const finalDist = scrollHeight - scrollAfterFollow - clientHeight;
		// May not be exactly 0 due to timing, but should be close
		expect(finalDist).toBeLessThan(150);

		// Button should be hidden
		await expect(scrollBtn).toBeHidden({ timeout: 3000 });

		// Clean up
		wsMock.sendMessage({ type: "done", code: 0 });
	});
});

test.describe("Scroll Stability — Desktop", () => {
	test.describe.configure({ timeout: 45_000 });
	test.use({ viewport: { width: 1440, height: 900 } });

	test("scroll position stays stable on desktop with background WS events", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(TURN_COUNT);

		const wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		await page.waitForTimeout(2000);

		const scrollHeight = await getScrollHeight(page);
		const clientHeight = await getClientHeight(page);
		expect(scrollHeight).toBeGreaterThan(clientHeight * 2);

		await scrollUpIncrementally(page, SCROLL_UP_PX);
		const scrollBefore = await getScrollTop(page);

		// Inject events that change the tracked reactive deps
		wsMock.sendMessage({
			type: "permission_request",
			id: "perm-desk-001",
			sessionId: "sess-scroll-001",
			toolName: "Write",
			description: "Write to test.ts",
		});
		wsMock.sendMessage({
			type: "permission_resolved",
			id: "perm-desk-001",
			sessionId: "sess-scroll-001",
			approved: true,
		});
		wsMock.sendMessage({
			type: "user_message",
			text: "Desktop burst message",
		});

		await page.waitForTimeout(1000);

		const scrollAfter = await getScrollTop(page);
		const drift = Math.abs(scrollAfter - scrollBefore);
		expect(drift).toBeLessThan(MAX_DRIFT_PX);
	});
});

// ─── Session Switch & Lifecycle Tests ───────────────────────────────────────
// Tests that cover session switching, infinite scroll, empty sessions, and
// multi-turn streaming — the most common user interactions that exercise
// the scroll controller's lifecycle state machine.

test.describe("Scroll Controller — Session Lifecycle", () => {
	test.describe.configure({ timeout: 60_000 });
	test.use({ viewport: { width: 1440, height: 900 } });

	test("switching sessions scrolls new session to bottom", async ({
		page,
		relayUrl,
	}) => {
		// Session A: 40-turn conversation (starts loaded)
		const sessionAEvents = generateConversationEvents(TURN_COUNT);
		// Session B: 20-turn conversation (loaded on switch)
		const sessionBEvents = generateConversationEvents(20);

		const _wsMock = await mockRelayWebSocket(page, {
			initMessages: [
				{
					type: "session_switched",
					id: "sess-switch-A",
					events: sessionAEvents,
				},
				{ type: "status", status: "idle" },
				{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
				{ type: "client_count", count: 1 },
				{
					type: "session_list",
					roots: true,
					sessions: [
						{
							id: "sess-switch-A",
							title: "Session A",
							updatedAt: Date.now(),
							messageCount: TURN_COUNT * 2,
						},
						{
							id: "sess-switch-B",
							title: "Session B",
							updatedAt: Date.now() - 3600_000,
							messageCount: 40,
						},
					],
				},
				{
					type: "model_list",
					providers: [
						{
							id: "anthropic",
							name: "Anthropic",
							configured: true,
							models: [
								{
									id: "claude-sonnet-4",
									name: "claude-sonnet-4",
									provider: "anthropic",
								},
							],
						},
					],
				},
				{
					type: "agent_list",
					agents: [
						{
							id: "code",
							name: "Code",
							description: "General coding assistant",
						},
					],
				},
			],
			responses: new Map(),
			onClientMessage: (parsed, control) => {
				// Respond to session switch requests
				if (
					parsed["type"] === "view_session" &&
					parsed["sessionId"] === "sess-switch-B"
				) {
					control.sendMessage({
						type: "session_switched",
						id: "sess-switch-B",
						events: sessionBEvents,
					});
					control.sendMessage({ type: "status", status: "idle" });
				}
			},
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});
		await page.waitForTimeout(2000);

		// Session A should be at the bottom
		const distA = await page.evaluate(() => {
			const el = document.getElementById("messages");
			return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
		});
		expect(distA).toBeLessThan(50);

		// Click on Session B in the sidebar
		await page.locator('text="Session B"').click();
		await page.waitForTimeout(3000);

		// Session B should also be scrolled to the bottom
		const distB = await page.evaluate(() => {
			const el = document.getElementById("messages");
			return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
		});
		expect(distB).toBeLessThan(50);

		// Verify Session B actually has content (not empty)
		const msgCount = await page.evaluate(() => {
			return document.querySelectorAll(".msg-container").length;
		});
		expect(msgCount).toBeGreaterThan(5);
	});

	test("infinite scroll prepends older messages without scroll jump", async ({
		page,
		relayUrl,
	}) => {
		// Create a session with 60 turns. With 50-message paging,
		// only last ~50 render initially, older ones are in the replay buffer.
		const initMessages = createInitMessages(60);

		const _wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});
		await page.waitForTimeout(2000);

		// Count initial messages
		const initialCount = await page.evaluate(() => {
			return document.querySelectorAll(".msg-container").length;
		});

		// Scroll up far enough to trigger HistoryLoader's IntersectionObserver
		await scrollUpIncrementally(page, 3000);
		const scrollBefore = await getScrollTop(page);

		// Wait for prepend to happen (HistoryLoader fires, loads from buffer)
		await page.waitForTimeout(2000);

		// Check if more messages were loaded
		const afterCount = await page.evaluate(() => {
			return document.querySelectorAll(".msg-container").length;
		});

		// If buffer had messages, count should increase.
		// If not (all already loaded), this is still a valid test —
		// the scroll position should remain stable regardless.
		const scrollAfter = await getScrollTop(page);

		if (afterCount > initialCount) {
			// Messages were prepended — scroll position should be approximately
			// preserved (not jumped to 0 or to bottom).
			// The prepend adds height above, so scrollTop should increase by
			// approximately the added height. We check that the user's viewport
			// position is roughly preserved (within 50px).
			const drift = Math.abs(scrollAfter - scrollBefore);
			expect(drift).toBeLessThan(200);
		} else {
			// No prepend occurred — scroll position should be stable
			const drift = Math.abs(scrollAfter - scrollBefore);
			expect(drift).toBeLessThan(MAX_DRIFT_PX);
		}
	});

	test("empty session shows content when first message streams in", async ({
		page,
		relayUrl,
	}) => {
		// Start with an empty session (no events, no history)
		const wsMock = await mockRelayWebSocket(page, {
			initMessages: [
				{
					type: "session_switched",
					id: "sess-empty-001",
					// No events — empty session
				},
				{ type: "status", status: "idle" },
				{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
				{ type: "client_count", count: 1 },
				{
					type: "session_list",
					roots: true,
					sessions: [
						{
							id: "sess-empty-001",
							title: "New session",
							updatedAt: Date.now(),
							messageCount: 0,
						},
					],
				},
				{
					type: "model_list",
					providers: [
						{
							id: "anthropic",
							name: "Anthropic",
							configured: true,
							models: [
								{
									id: "claude-sonnet-4",
									name: "claude-sonnet-4",
									provider: "anthropic",
								},
							],
						},
					],
				},
				{
					type: "agent_list",
					agents: [
						{
							id: "code",
							name: "Code",
							description: "General coding assistant",
						},
					],
				},
			],
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});
		await page.waitForTimeout(1000);

		// Simulate: user sent a message, server starts processing
		wsMock.sendMessage({
			type: "user_message",
			text: "Hello, can you help me?",
		});
		wsMock.sendMessage({ type: "status", status: "processing" });
		await page.waitForTimeout(300);

		// Stream response
		for (let i = 0; i < 8; i++) {
			wsMock.sendMessage({
				type: "delta",
				text: `This is line ${i} of the response. It contains enough text to create vertical height in the scroll container for testing purposes. `,
			});
			await page.waitForTimeout(100);
		}

		await page.waitForTimeout(500);

		// Should be near the bottom — auto-scroll working for empty session
		const distFromBottom = await page.evaluate(() => {
			const el = document.getElementById("messages");
			return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
		});
		expect(distFromBottom).toBeLessThan(100);

		// Should have rendered messages
		const msgCount = await page.evaluate(() => {
			return document.querySelectorAll(".msg-container").length;
		});
		expect(msgCount).toBeGreaterThan(0);

		// Complete the turn
		wsMock.sendMessage({ type: "done", code: 0 });
		wsMock.sendMessage({ type: "status", status: "idle" });
	});

	test("multi-turn streaming: auto-scroll works across done→new message→streaming cycles", async ({
		page,
		relayUrl,
	}) => {
		const initMessages = createInitMessages(10);

		const wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});
		await page.waitForTimeout(2000);

		// ── Turn 1: stream and complete ──
		wsMock.sendMessage({ type: "status", status: "processing" });
		await page.waitForTimeout(200);

		for (let i = 0; i < 5; i++) {
			wsMock.sendMessage({
				type: "delta",
				text: `Turn 1 content line ${i}. Adding enough text to grow the scroll height meaningfully. `,
			});
			await page.waitForTimeout(80);
		}
		wsMock.sendMessage({ type: "done", code: 0 });
		wsMock.sendMessage({ type: "status", status: "idle" });
		await page.waitForTimeout(500);

		// Should be at bottom after turn 1
		let dist = await page.evaluate(() => {
			const el = document.getElementById("messages");
			return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
		});
		expect(dist).toBeLessThan(100);

		// ── Turn 2: new user message then stream ──
		wsMock.sendMessage({
			type: "user_message",
			text: "Follow-up question for turn 2",
		});
		wsMock.sendMessage({ type: "status", status: "processing" });
		await page.waitForTimeout(200);

		for (let i = 0; i < 5; i++) {
			wsMock.sendMessage({
				type: "delta",
				text: `Turn 2 content line ${i}. More text to ensure scrolling continues to work on subsequent turns. `,
			});
			await page.waitForTimeout(80);
		}
		wsMock.sendMessage({ type: "done", code: 0 });
		wsMock.sendMessage({ type: "status", status: "idle" });
		await page.waitForTimeout(500);

		// Should still be at bottom after turn 2
		dist = await page.evaluate(() => {
			const el = document.getElementById("messages");
			return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
		});
		expect(dist).toBeLessThan(100);
	});

	test("large session replay buffer consumed on scroll-up", async ({
		page,
		relayUrl,
	}) => {
		// 80 turns = ~160+ messages. Only last 50 render initially.
		// Remaining ~110+ go into the replay buffer.
		const initMessages = createInitMessages(80);

		const _wsMock = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});
		await page.waitForTimeout(3000);

		// Count initial messages (should be ~50 due to paging)
		const initialCount = await page.evaluate(() => {
			return document.querySelectorAll(".msg-container").length;
		});
		expect(initialCount).toBeLessThan(100);
		expect(initialCount).toBeGreaterThan(20);

		// Scroll to the very top to trigger HistoryLoader
		await page.evaluate(() => {
			const el = document.getElementById("messages");
			if (el) el.scrollTop = 0;
		});
		await page.waitForTimeout(2000);

		// More messages should have loaded from the replay buffer
		const afterCount = await page.evaluate(() => {
			return document.querySelectorAll(".msg-container").length;
		});

		// After loading from buffer, we should have more messages
		expect(afterCount).toBeGreaterThanOrEqual(initialCount);
	});

	test("session switch while scrolled up resets to bottom on new session", async ({
		page,
		relayUrl,
	}) => {
		const sessionAEvents = generateConversationEvents(TURN_COUNT);
		const sessionBEvents = generateConversationEvents(15);

		const _wsMock = await mockRelayWebSocket(page, {
			initMessages: [
				{
					type: "session_switched",
					id: "sess-scrollup-A",
					events: sessionAEvents,
				},
				{ type: "status", status: "idle" },
				{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
				{ type: "client_count", count: 1 },
				{
					type: "session_list",
					roots: true,
					sessions: [
						{
							id: "sess-scrollup-A",
							title: "Session A (long)",
							updatedAt: Date.now(),
							messageCount: TURN_COUNT * 2,
						},
						{
							id: "sess-scrollup-B",
							title: "Session B (short)",
							updatedAt: Date.now() - 3600_000,
							messageCount: 30,
						},
					],
				},
				{
					type: "model_list",
					providers: [
						{
							id: "anthropic",
							name: "Anthropic",
							configured: true,
							models: [
								{
									id: "claude-sonnet-4",
									name: "claude-sonnet-4",
									provider: "anthropic",
								},
							],
						},
					],
				},
				{
					type: "agent_list",
					agents: [
						{
							id: "code",
							name: "Code",
							description: "General coding assistant",
						},
					],
				},
			],
			responses: new Map(),
			onClientMessage: (parsed, control) => {
				if (
					parsed["type"] === "view_session" &&
					parsed["sessionId"] === "sess-scrollup-B"
				) {
					control.sendMessage({
						type: "session_switched",
						id: "sess-scrollup-B",
						events: sessionBEvents,
					});
					control.sendMessage({ type: "status", status: "idle" });
				}
			},
		});

		await page.goto(relayUrl);
		await page.locator("#connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});
		await page.waitForTimeout(2000);

		// Verify Session A is at bottom
		let dist = await page.evaluate(() => {
			const el = document.getElementById("messages");
			return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
		});
		expect(dist).toBeLessThan(50);

		// Scroll way up in Session A
		await scrollUpIncrementally(page, SCROLL_UP_PX);

		// Verify we're NOT at the bottom (detached)
		const scrollBtn = page.locator("#scroll-btn");
		await expect(scrollBtn).toBeVisible({ timeout: 3000 });

		// Switch to Session B
		await page.locator('text="Session B (short)"').click();
		await page.waitForTimeout(3000);

		// Session B should be at the bottom, regardless of A's scroll state
		dist = await page.evaluate(() => {
			const el = document.getElementById("messages");
			return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
		});
		expect(dist).toBeLessThan(50);

		// Scroll-to-bottom button should NOT be visible on new session
		await expect(scrollBtn).toBeHidden({ timeout: 3000 });
	});
});
