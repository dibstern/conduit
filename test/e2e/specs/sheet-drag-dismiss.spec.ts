import type { Locator, Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { dragSheet, settleSheet } from "../helpers/sheet-drag.js";

test.use({
	recording: "chat-simple",
	viewport: { width: 390, height: 844 },
	hasTouch: true,
	isMobile: true,
});

async function openOverflowSheet(
	page: Page,
	relayUrl: string,
): Promise<Locator> {
	await gotoRelay(page, relayUrl);
	await page.getByTestId("session-bar-island-overflow").tap();
	const sheet = page.getByTestId("session-bar-island-menu");
	await expect(sheet).toBeVisible();
	await expect(page.getByTestId("menu-sheet-scrim")).toHaveCSS(
		"pointer-events",
		"auto",
	);
	return sheet;
}

test("phone: dragging the session sheet up from its handle follows the finger and dismisses", async ({
	page,
	relayUrl,
}) => {
	const sheet = await openOverflowSheet(page, relayUrl);
	const { top, end } = await dragSheet(page, sheet, -200, false, -10);
	// Mid-drag the sheet tracks the finger instead of scrolling its content.
	const moved = await sheet.boundingBox();
	expect(moved?.y ?? top).toBeLessThan(top - 120);
	await end();
	await expect(sheet).toHaveCount(0);
});

test("phone: a short drag springs the session sheet back open", async ({
	page,
	relayUrl,
}) => {
	const sheet = await openOverflowSheet(page, relayUrl);
	const { top } = await dragSheet(page, sheet, -30, true, -10);
	await expect(sheet).toBeVisible();
	await expect
		.poll(async () => (await sheet.boundingBox())?.y)
		.toBeCloseTo(top, 0);
});

test("phone: dragging a scrolled sheet body scrolls without dismissing", async ({
	page,
	relayUrl,
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 320 });
	const sheet = await openOverflowSheet(page, relayUrl);
	const body = sheet.locator("[data-sheet-body]");
	await expect
		.poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight))
		.toBeGreaterThan(80);
	await body.evaluate((node) => {
		node.scrollTop = 40;
	});
	await settleSheet(page);
	const top = (await sheet.boundingBox())?.y;
	await dragSheet(page, body, -30, true, -30);
	await expect(sheet).toBeVisible();
	expect((await sheet.boundingBox())?.y).toBeCloseTo(top ?? 0, 0);
	await expect
		.poll(() => body.evaluate((node) => node.scrollTop))
		.toBeGreaterThan(40);
	await testInfo.attach("scrolled-sheet-body", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});
