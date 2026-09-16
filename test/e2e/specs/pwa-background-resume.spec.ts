// ─── PWA Background / Resume ────────────────────────────────────────────────
// iOS fires `pagehide` every time the standalone PWA is backgrounded, not just
// on unload. These tests pin down what the app must survive across a
// background → foreground cycle: it must keep handling relay messages, and it
// must not throw away text the user has typed.

import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const SESSION_ID = "sess-pwa";

const initMessages = [
	{ type: "session_switched", id: SESSION_ID, events: [] },
	{ type: "status", status: "idle" },
	{ type: "client_count", count: 1 },
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: SESSION_ID,
				title: "PWA session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
];

/** Simulate iOS suspending the app: pagehide with the page kept in memory. */
async function background(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.dispatchEvent(
			new PageTransitionEvent("pagehide", { persisted: true }),
		);
	});
	await page.waitForTimeout(300);
}

/** Simulate iOS restoring the app from its page cache. */
async function foreground(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		);
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.waitForTimeout(500);
}

test.describe("PWA background/resume", () => {
	test.describe.configure({ timeout: 45_000 });

	test("keeps handling relay messages after a background/foreground cycle", async ({
		page,
		relayUrl,
	}) => {
		const ws = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page
			.locator("#connect-overlay")
			.waitFor({ state: "hidden", timeout: 15_000 });

		// Baseline: the client-count badge tracks relay messages.
		const badge = page.locator("#client-count-badge");
		ws.sendMessage({ type: "client_count", count: 3 });
		await expect(badge).toHaveText("3", { timeout: 5_000 });

		await background(page);
		await foreground(page);

		// The user's symptom: after coming back the app is mute, so nothing the
		// relay says lands and the only way out is a reload.
		ws.sendMessage({ type: "client_count", count: 7 });
		await expect(badge).toHaveText("7", { timeout: 5_000 });
	});

	test("does not clobber typed text with a stale server draft", async ({
		page,
		relayUrl,
	}) => {
		const ws = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(relayUrl);
		await page
			.locator("#connect-overlay")
			.waitFor({ state: "hidden", timeout: 15_000 });

		const composer = page.locator("#input");
		await composer.fill("the newest thing I typed");

		// A reconnect replays the server's draft, which lags the last keystrokes
		// by at least the 300 ms sync debounce.
		ws.sendMessage({
			type: "input_sync",
			text: "the newest thi",
			from: "other",
		});
		await page.waitForTimeout(500);

		await expect(composer).toHaveValue("the newest thing I typed");
	});
});
