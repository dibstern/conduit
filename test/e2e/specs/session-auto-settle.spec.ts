import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

test("auto-settle toggle and idle window survive reload", async ({
	page,
	relayUrl,
}) => {
	await gotoRelay(page, relayUrl);
	const row = page.locator("#session-list .session-item").first();
	await expect(row).toBeVisible();
	await row.click({ button: "right" });
	const toggle = page.getByTestId("session-ctx-auto-settle");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await toggle.click();
	await row.click({ button: "right" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await page.reload();
	await expect(row).toBeVisible();
	await row.click({ button: "right" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");

	await page.locator("#header-settings-btn").click();
	await page.getByTestId("settings-tab-appearance").click();
	const select = page.getByTestId("settings-auto-settle-select");
	await expect(select).toHaveValue("3");
	await select.selectOption("7");
	await expect(select).toBeEnabled();
	await page.getByTestId("settings-close-btn").click();
	await page.locator("#header-settings-btn").click();
	await page.getByTestId("settings-tab-appearance").click();
	await expect(select).toHaveValue("7");
	await page.reload();
	await page.locator("#header-settings-btn").click();
	await page.getByTestId("settings-tab-appearance").click();
	await expect(select).toHaveValue("7");
});
