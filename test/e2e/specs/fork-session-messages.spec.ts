// ─── Fork Session Message Rendering (Replay E2E) ────────────────────────────
// Proves that messages sent in a forked session appear AFTER the fork divider
// (in the "current" section), not hidden inside the collapsed inherited block.
//
// Uses the fork-session recording. The test verifies that after forking and
// sending a message, the user message AND the assistant response appear
// below the fork divider — not collapsed into the "Prior conversation" block.

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

test.describe("Fork Session — New Message Rendering", () => {
	test.describe.configure({ timeout: 60_000 });
	test.use({ recording: "fork-session" });

	test("messages sent in forked session appear after fork divider", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		await installWsCapture(page);
		await app.goto(relayUrl);

		// ── Turn 1 + Turn 2 in original session ──
		await app.sendMessage(
			"Remember the word 'alpha'. Reply with only: ok, remembered.",
		);
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		await app.sendMessage(
			"Now remember 'beta' too. Reply with only: ok, remembered.",
		);
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// ── Fork ──
		await sendWsMessage(page, { type: "fork_session" });

		// Wait for URL to update to forked session
		const currentPath = new URL(page.url()).pathname;
		await page.waitForFunction(
			(prevPath) => {
				const p = window.location.pathname;
				return p !== prevPath && /\/s\/ses_/.test(p);
			},
			currentPath,
			{ timeout: 15_000 },
		);

		// ── Send message in forked session ──
		await app.sendMessage(
			"What words did I ask you to remember? Reply with just the words.",
		);

		// Wait for fork divider to appear
		const forkDivider = page.locator(".fork-divider");
		await forkDivider.waitFor({ state: "visible", timeout: 30_000 });

		// ── KEY ASSERTION: user message and assistant response appear AFTER fork divider ──
		// Strategy: use Playwright's page.evaluate to check DOM order.
		// The .fork-divider element separates inherited from current messages.
		// We verify that at least one .msg-user and one .msg-assistant appear
		// AFTER the .fork-divider in DOM order (i.e., they are siblings that
		// come later, not inside .fork-context-block).
		//
		// NOTE: We cannot use CSS :not(.fork-context-messages .msg-user) because
		// .fork-context-messages is only in the DOM when the block is expanded
		// (collapsed by default). Instead we check DOM sibling order.

		// Wait for assistant response to complete (proves the response rendered)
		await chat.waitForStreamingComplete(30_000);

		// Check that messages exist after the fork divider in DOM order.
		// The #messages element has multiple child divs (sentinel, loader, wrapper).
		// The fork divider lives inside the wrapper div that also holds messages.
		// We search the entire #messages subtree for .fork-divider, then walk
		// its subsequent siblings for user and assistant messages.
		const result = await page.evaluate(() => {
			const messages = document.querySelector("#messages");
			if (!messages) return { error: "no #messages" };

			const divider = messages.querySelector(".fork-divider");
			if (!divider) return { error: "no fork-divider" };

			// Walk siblings after the divider within its parent
			let userAfter = 0;
			let assistantAfter = 0;
			let el = divider.nextElementSibling;
			while (el) {
				// Check for user messages
				if (el.querySelector(".msg-user")) {
					userAfter++;
				}
				// Check for assistant messages
				if (el.querySelector(".msg-assistant")) {
					assistantAfter++;
				}
				el = el.nextElementSibling;
			}
			return { userAfter, assistantAfter };
		});

		// Verify no errors
		expect(result).not.toHaveProperty("error");
		const { userAfter, assistantAfter } = result as {
			userAfter: number;
			assistantAfter: number;
		};

		// At least one user message after the divider (the "What words" prompt)
		expect(userAfter).toBeGreaterThanOrEqual(1);
		// At least one assistant message after the divider (the response)
		expect(assistantAfter).toBeGreaterThanOrEqual(1);
	});
});
