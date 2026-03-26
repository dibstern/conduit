// ─── Fork Session E2E Tests ──────────────────────────────────────────────────
// Tests fork-point rendering: collapsible prior context, fork divider,
// SubagentBackBar hidden for user forks.
//
// Uses replay fixture with MockOpenCodeServer replaying the fork-session
// recording — no real OpenCode needed.
//
// Recording structure:
// 1. Two-turn conversation (alpha, beta) in the original session
// 2. Whole-session fork (no messageId)
// 3. Prompt in the forked session ("What words did I remember?")
//
// After the fork, the relay sends session_switched WITHOUT history.
// The third prompt triggers SSE events that populate the chat with at
// least a user message. Combined with the session's forkMessageId metadata,
// the fork UI (context block + divider) renders.
//
// The recording's delta events for the third prompt's assistant response
// are attached to a later REST queue entry. We don't wait for the full
// response to complete — we wait for the fork UI elements instead.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

/**
 * Send a raw JSON message through the browser's open WebSocket.
 */
async function sendWsMessage(
	page: import("@playwright/test").Page,
	payload: Record<string, unknown>,
): Promise<void> {
	await page.evaluate((msg) => {
		const allSockets = (window as unknown as { __testWs?: WebSocket[] })
			.__testWs;
		if (allSockets && allSockets.length > 0) {
			const ws = allSockets[allSockets.length - 1];
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(msg));
				return;
			}
		}
		throw new Error("No WebSocket found. Ensure WS capture is set up.");
	}, payload);
}

/**
 * Install a WebSocket capture hook before the page navigates.
 */
async function installWsCapture(
	page: import("@playwright/test").Page,
): Promise<void> {
	await page.addInitScript(() => {
		const allSockets: WebSocket[] = [];
		(window as unknown as { __testWs: WebSocket[] }).__testWs = allSockets;
		const OrigWs = window.WebSocket;
		const WsProxy = function (
			this: WebSocket,
			...args: ConstructorParameters<typeof WebSocket>
		) {
			const ws = new OrigWs(...args);
			allSockets.push(ws);
			return ws;
		} as unknown as typeof WebSocket;
		WsProxy.prototype = OrigWs.prototype;
		Object.defineProperty(WsProxy, "CONNECTING", { value: OrigWs.CONNECTING });
		Object.defineProperty(WsProxy, "OPEN", { value: OrigWs.OPEN });
		Object.defineProperty(WsProxy, "CLOSING", { value: OrigWs.CLOSING });
		Object.defineProperty(WsProxy, "CLOSED", { value: OrigWs.CLOSED });
		(window as unknown as { WebSocket: typeof WebSocket }).WebSocket = WsProxy;
	});
}

/**
 * Run the setup: two prompts, fork, then send the third prompt.
 * Does NOT wait for the third prompt's assistant response to complete
 * (the mock's SSE events for the response text are deeply queued).
 * Instead, waits for the fork UI to appear.
 */
async function setupForkSession(
	page: import("@playwright/test").Page,
	app: AppPage,
	chat: ChatPage,
	relayUrl: string,
): Promise<void> {
	await installWsCapture(page);
	await app.goto(relayUrl);

	// ── Turn 1: Remember alpha ──
	await app.sendMessage(
		"Remember the word 'alpha'. Reply with only: ok, remembered.",
	);
	await chat.waitForAssistantMessage();
	await chat.waitForStreamingComplete();

	// ── Turn 2: Remember beta ──
	await app.sendMessage(
		"Now remember 'beta' too. Reply with only: ok, remembered.",
	);
	await chat.waitForAssistantMessage();
	await chat.waitForStreamingComplete();

	// ── Fork: whole-session fork (no messageId) ──
	await sendWsMessage(page, { type: "fork_session" });

	// Wait for the fork to process — URL should update to a different session.
	const currentPath = new URL(page.url()).pathname;
	await page.waitForFunction(
		(prevPath) => {
			const p = window.location.pathname;
			return p !== prevPath && /\/s\/ses_/.test(p);
		},
		currentPath,
		{ timeout: 15_000 },
	);

	// ── Turn 3: Send message in forked session ──
	// This triggers SSE events that add at least a user_message to the chat.
	// Combined with forkMessageId on the session, the fork UI renders.
	await app.sendMessage(
		"What words did I ask you to remember? Reply with just the words.",
	);

	// Wait for fork UI instead of waiting for the full assistant response.
	// The fork divider appears once chatState.messages has content and
	// the session's forkMessageId is set.
	const forkDivider = page.locator(".fork-divider");
	await forkDivider.waitFor({ state: "visible", timeout: 30_000 });
}

test.describe("Fork Session Rendering", () => {
	test.describe.configure({ timeout: 60_000 });
	test.use({ recording: "fork-session" });

	test("fork creates collapsible prior context and divider", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// Fork context block should be visible (collapsed by default)
		const contextBlock = page.locator(".fork-context-block");
		await expect(contextBlock).toBeVisible();

		// The toggle button should say "Prior conversation"
		const toggle = page.locator(".fork-context-toggle");
		await expect(toggle).toContainText("Prior conversation");

		// Context messages should NOT be visible (collapsed)
		const contextMessages = page.locator(".fork-context-messages");
		await expect(contextMessages).not.toBeVisible();

		// Fork divider should contain "Forked from"
		const forkDivider = page.locator(".fork-divider");
		await expect(forkDivider).toContainText("Forked from");

		// SubagentBackBar should NOT be visible for user forks
		await expect(chat.subagentBackBar).not.toBeVisible();
	});

	test("expanding prior context shows inherited messages", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// Click the toggle to expand
		const toggle = page.locator(".fork-context-toggle");
		await toggle.click();

		// Context messages should now be visible
		const contextMessages = page.locator(".fork-context-messages");
		await expect(contextMessages).toBeVisible({ timeout: 5_000 });

		// The inherited area should contain message elements
		const inheritedMsgs = contextMessages.locator(".msg-user, .msg-assistant");
		const count = await inheritedMsgs.count();
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test("SubagentBackBar hidden for user forks", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await setupForkSession(page, app, chat, relayUrl);

		// SubagentBackBar should NOT be visible for user forks
		// (it only shows for subagent sessions with parentID but no forkMessageId)
		await expect(chat.subagentBackBar).not.toBeVisible();
	});
});
