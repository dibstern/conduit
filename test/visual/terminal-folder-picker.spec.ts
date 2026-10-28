import { expect, test } from "@playwright/test";

test.use({
	viewport: { width: 393, height: 852 },
	hasTouch: true,
	isMobile: true,
});
test.describe.configure({ retries: 0 });

test("a phone tap opens the terminal folder picker and selects a folder", async ({
	page,
}, testInfo) => {
	await page.goto(
		"/iframe.html?id=terminal-terminalpanel--multi-folder-picker-closed&viewMode=story",
	);
	await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
	expect(
		await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
	).toBe(true);
	const trigger = page.getByTestId("new-terminal-folder-picker");
	const menu = page.getByRole("menu", { name: "New terminal in folder" });
	await trigger.tap();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(menu).toBeVisible();
	await expect(menu.getByTestId("new-terminal-folder-item")).toHaveText([
		"web",
		"api",
	]);
	await menu.getByRole("menuitem", { name: "api", exact: true }).tap();
	await expect(menu).toBeHidden();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await testInfo.attach("terminal after folder tap", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});
