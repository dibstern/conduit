// ─── E2E Permission Tests ────────────────────────────────────────────────────
// Tests the permission approval flow: permission cards appear when the agent
// needs to use tools, and the user can Allow/Deny.
// Uses the advanced-diff recording which triggers external_directory permissions.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { PermissionPage } from "../page-objects/permission.page.js";

test.use({ recording: "advanced-diff" });

test.describe("Permissions", () => {
	test.describe.configure({ timeout: 60_000 });

	test("permission card appears when agent uses a tool", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const perm = new PermissionPage(page);
		await app.goto(relayUrl);

		// Send a prompt that triggers an external_directory permission
		await app.sendMessage(
			"Create a file called /tmp/e2e-test-diff.txt with the text 'hello world'",
		);

		// Wait for the permission card to appear
		await perm.waitForCard(30_000);

		// Permission card should be visible
		const cardCount = await perm.getCardCount();
		expect(cardCount).toBeGreaterThan(0);
	});

	test("permission card structure has expected elements", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const perm = new PermissionPage(page);
		await app.goto(relayUrl);

		// Trigger a permission request
		await app.sendMessage(
			"Create a file called /tmp/e2e-test-diff.txt with the text 'hello world'",
		);

		// Wait for the permission card
		const card = await perm.waitForCard(30_000);

		// Card should have Allow button
		const allowBtn = card.locator("button", { hasText: /^Allow$/ });
		await expect(allowBtn).toBeVisible();

		// Card should have Deny button
		const denyBtn = card.locator("button", { hasText: "Deny" });
		await expect(denyBtn).toBeVisible();
	});
});
