// iOS fires `pagehide` every time the standalone PWA is backgrounded, not just
// on unload. These tests pin down what the app must survive across a
// background → foreground cycle: it must keep handling relay messages, and it
// must not throw away text the user has typed.

import type { Page } from "@playwright/test";
import { WS_PROTOCOL_VERSION } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const SESSION_ID = "sess-pwa";

const initMessages = [
	{ type: "status", status: "idle" },
	{ type: "client_count", count: 1 },
	{
		type: "shell_snapshot",
		roots: true,
		sessions: [
			{
				id: SESSION_ID,
				title: "PWA session",
				status: "idle",
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
}

/** Simulate iOS restoring the app from its page cache. */
async function foreground(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		);
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

test.describe("PWA background/resume", () => {
	test.describe.configure({ timeout: 45_000 });

	test("prompts a stale tab to reload after a daemon upgrade", async ({
		page,
		relayUrl,
	}) => {
		const ws = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(new URL(`/s/${SESSION_ID}`, relayUrl).href);
		await page.locator("#layout").waitFor({ state: "attached" });
		await page
			.locator("#connect-overlay")
			.waitFor({ state: "hidden", timeout: 15_000 });
		ws.sendMessage({ type: "client_count", count: 7 });
		await expect(page.locator("#client-count-badge")).toHaveText("7");
		ws.sendMessage({
			type: "server_status",
			protocolVersion: WS_PROTOCOL_VERSION + 1,
			buildId: "dev",
			restartAvailable: false,
			sessionsRevision: 0,
		});
		const banner = page.locator('[data-banner-id="stale-page"]');
		await expect(banner).toContainText(
			"Conduit was updated. Reload this tab to keep things working.",
		);
		await expect(
			banner.getByRole("button", { name: "Reload" }),
		).toHaveAttribute("data-testid", "banner-action");
	});

	test("keeps handling relay messages after a background/foreground cycle", async ({
		page,
		relayUrl,
	}) => {
		const ws = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});

		await page.goto(new URL(`/s/${SESSION_ID}`, relayUrl).href);
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
});
