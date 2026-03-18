// ─── E2E Dashboard Tests ─────────────────────────────────────────────────────
// Tests the dashboard page behavior: URL structure, page content, project name.
// Uses real relay backed by MockOpenCodeServer — no real OpenCode needed.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

test.describe("Dashboard", () => {
	test("project slug appears in the URL path", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		const url = page.url();
		// The URL should contain /p/<slug>/
		expect(url).toMatch(/\/p\/[a-z0-9-]+\//);
	});

	test("page title is present", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		await expect(page).toHaveTitle("OpenCode Relay");
	});

	test("project name is displayed in header", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		await expect(app.projectName).toBeVisible();
		const name = await app.projectName.innerText();
		expect(name.length).toBeGreaterThan(0);
	});
});
