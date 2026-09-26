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

test.describe("phone session state chip", () => {
	test.use({ viewport: { width: 375, height: 740 } });

	test("settlement, auto-settle and un-settle stay in sync with the list", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, new URL("/", relayUrl).toString());
		const row = page.locator("#session-list .session-item").first();
		await expect(row).toBeVisible();
		const id = await row.getAttribute("data-session-id");
		const liveRow = page.locator(`#session-list [data-session-id="${id}"]`);
		const shelfRow = page.locator(
			`#settled-shelf-rows [data-session-id="${id}"]`,
		);
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-settle").click();
		await page.getByTestId("settled-shelf-toggle").click();
		await shelfRow.click();

		const chip = page.getByTestId("session-bar-state-chip");
		await expect(chip).toHaveAttribute("data-state", "settled");
		await expect(chip).toContainText("Settled");
		await expect(page.locator("#input")).toHaveAttribute(
			"placeholder",
			"Message to un-settle…",
		);
		await chip.click();
		const autoSettle = page.getByTestId("session-bar-auto-settle");
		await expect(autoSettle).toHaveAttribute("aria-checked", "true");
		await autoSettle.click();
		await chip.click();
		await expect(autoSettle).toHaveAttribute("aria-checked", "false");
		await page.keyboard.press("Escape");
		await page.getByTestId("session-bar-back").click();
		await shelfRow.click({ button: "right" });
		await expect(page.getByTestId("session-ctx-auto-settle")).toHaveAttribute(
			"aria-checked",
			"false",
		);
		await page.keyboard.press("Escape");
		await shelfRow.click();
		await chip.click();
		await page.getByTestId("session-bar-unsettle").click();
		await expect(chip).toHaveCount(0);
		await page.getByTestId("session-bar-back").click();
		await expect(liveRow).toBeVisible();
	});

	test("snooze time and Wake now", async ({ page, relayUrl }) => {
		await gotoRelay(page, new URL("/", relayUrl).toString());
		const row = page.locator("#session-list .session-item").first();
		await expect(row).toBeVisible();
		const id = await row.getAttribute("data-session-id");
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-snooze").click();
		await page.getByTestId("snooze-option-1h").click();
		await page.getByTestId("snoozed-shelf-toggle").click();
		await page.locator(`#snoozed-shelf-rows [data-session-id="${id}"]`).click();
		const chip = page.getByTestId("session-bar-state-chip");
		await expect(chip).toHaveAttribute("data-state", "snoozed");
		await expect(chip).toContainText(/\d{1,2}:\d{2}/);
		await expect(page.locator("#input")).toHaveAttribute(
			"placeholder",
			"Message to wake…",
		);
		await chip.click();
		await page.getByTestId("session-bar-wake").click();
		await expect(chip).toHaveCount(0);
		await page.getByTestId("session-bar-back").click();
		await expect(
			page.locator(`#session-list [data-session-id="${id}"]`),
		).toBeVisible();
	});
});
