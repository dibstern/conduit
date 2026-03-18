// ─── E2E Smoke Test ──────────────────────────────────────────────────────────
// Structural smoke test proving the UI renders correctly with a real relay
// backed by MockOpenCodeServer. No real OpenCode needed.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

test.describe("E2E Smoke Test", () => {
	test("page loads and connects to relay", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Page title
		await expect(page).toHaveTitle("OpenCode Relay");

		// Connection overlay should be hidden (WS connected)
		await expect(app.connectOverlay).toBeHidden();

		// Status dot should show connected
		await app.waitForConnected();
	});

	test("input area is visible and functional", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Textarea is visible and enabled
		await expect(app.input).toBeVisible();
		await expect(app.input).toBeEditable();

		// Send button is visible but disabled when textarea is empty
		await expect(app.sendBtn).toBeVisible();
		await expect(app.sendBtn).toBeDisabled();

		// Typing into the input works — and enables the send button
		await app.input.fill("test");
		const value = await app.input.inputValue();
		expect(value).toBe("test");
		await expect(app.sendBtn).toBeEnabled();
	});

	test("session list is populated on connect", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// On desktop, sidebar is visible directly
		// On mobile, we need to open it first
		if (await app.isMobileViewport()) {
			await app.hamburgerBtn.click();
			await expect(app.sidebar).toBeVisible();
		}

		// Session list should have at least one session
		const sessionItems = page.locator("#session-list .session-item");
		await expect(sessionItems.first()).toBeVisible({ timeout: 10_000 });
		const count = await sessionItems.count();
		expect(count).toBeGreaterThan(0);
	});

	test("header elements are present", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Project name
		await expect(app.projectName).toBeVisible();

		// Status dot
		await expect(app.statusDot).toBeVisible();

		// QR share button
		await expect(app.qrBtn).toBeVisible();
	});
});
