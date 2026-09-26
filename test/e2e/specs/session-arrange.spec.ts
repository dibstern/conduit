import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

test("status filter and grouping survive reload and follow browser history", async ({
	page,
	relayUrl,
}) => {
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	await new SidebarPage(page).createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	const originalCount = await rows.count();

	const runningCount = Number(
		await page
			.getByTestId("session-filter-chip-running")
			.locator("b")
			.innerText(),
	);
	const filter = runningCount < originalCount ? "running" : "unread";
	const filteredCount = Number(
		await page
			.getByTestId(`session-filter-chip-${filter}`)
			.locator("b")
			.innerText(),
	);
	expect(filteredCount).toBeLessThan(originalCount);
	await page.getByTestId(`session-filter-chip-${filter}`).click();
	await expect(page).toHaveURL(new RegExp(`status=${filter}`));
	await expect(rows).toHaveCount(filteredCount);
	await page.getByTestId(`session-filter-chip-${filter}`).click();
	await expect(rows).toHaveCount(originalCount);

	await page.getByTestId("session-filter-chip-needs-you").click();
	await expect(page).toHaveURL(/status=needs-you/);
	await expect(rows).toHaveCount(0);
	await expect(page.getByTestId("session-filter-empty")).toContainText(
		"Nothing needs you",
	);
	await page.getByTestId("session-filter-clear").click();
	await expect(rows).toHaveCount(originalCount);
	await expect(page).not.toHaveURL(/status=/);

	await page.getByTestId("session-group-button").click();
	await page.getByTestId("session-group-option-time").click();
	await expect(page).toHaveURL(/group=time/);
	await expect(
		page.locator(".session-group-label").filter({ hasText: "Today" }),
	).toBeVisible();

	await page.getByTestId("session-group-button").click();
	await page.getByTestId("session-group-option-project").click();
	await expect(page).toHaveURL(/group=project/);
	await expect(page.getByTestId("session-group-chip")).toContainText(
		"By project",
	);
	await expect(page.locator(".session-group-label").first()).toContainText(
		"e2e-replay",
	);

	await page.getByTestId("session-filter-chip-running").click();
	await expect(page).toHaveURL(/status=running/);
	await page.reload();
	await expect(page.getByTestId("session-filter-chip-running")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("session-group-chip")).toContainText(
		"By project",
	);
	await expect(page).toHaveURL(/group=project/);
	await page.goBack();
	await expect(page).not.toHaveURL(/status=/);
	await expect(page).toHaveURL(/group=project/);
	await expect(rows).toHaveCount(originalCount);
	await page.getByTestId("session-group-chip").click();
	await expect(page).not.toHaveURL(/group=/);
});
