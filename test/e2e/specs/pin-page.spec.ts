// ─── E2E PIN Page Tests ──────────────────────────────────────────────────────
// Tests the PIN login page behavior: verifies no-PIN behavior when PIN is
// not configured. Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { PinPage } from "../page-objects/pin.page.js";

test.use({ recording: "chat-simple" });

test.describe("PIN Page", () => {
	test("no PIN page shown when PIN is not set", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Without a PIN, the main app should load directly
		// (no PIN input should be visible)
		const pin = new PinPage(page);
		const pinVisible = await pin.isVisible();
		expect(pinVisible).toBe(false);

		// The main app should be accessible
		await expect(app.input).toBeVisible();
		await expect(app.statusDot).toBeVisible();
	});

	test("main page loads without auth cookie when PIN is not set", async ({
		page,
		relayUrl,
	}) => {
		// Clear all cookies first
		await page.context().clearCookies();

		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Without PIN set, even without cookies the app should load fine
		await expect(app.connectOverlay).toBeHidden({ timeout: 15_000 });
		await expect(app.input).toBeVisible();
	});

	test("page title is correct on main app", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		await expect(page).toHaveTitle("OpenCode Relay");
	});
});
