import type { Locator, Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({
	recording: "chat-simple",
	viewport: { width: 390, height: 844 },
	hasTouch: true,
	isMobile: true,
});

// A real finger through Chromium's input pipeline, so native scrolling and
// pointercancel behave as they do on a phone. Playwright's touchscreen only taps.
async function dragDown(
	page: Page,
	sheet: Locator,
	distance: number,
	release = true,
) {
	const box = await sheet.boundingBox();
	if (!box) throw new Error("sheet is not rendered");
	const x = box.x + box.width / 2;
	const startY = box.y + 10;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y: startY }],
	});
	const steps = 12;
	for (let step = 1; step <= steps; step++) {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x, y: startY + (distance * step) / steps }],
		});
		await page.waitForTimeout(16);
	}
	const end = async () => {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
		await cdp.detach();
	};
	if (release) await end();
	return { top: box.y, end };
}

async function openTitleSheet(page: Page, relayUrl: string): Promise<Locator> {
	await gotoRelay(page, relayUrl);
	await page.getByTestId("session-bar-title-menu").tap();
	const sheet = page.getByTestId("session-action-sheet");
	await expect(sheet).toBeVisible();
	await page.waitForTimeout(150);
	return sheet;
}

test("phone: dragging the session sheet down from its top follows the finger and dismisses", async ({
	page,
	relayUrl,
}) => {
	const sheet = await openTitleSheet(page, relayUrl);
	const { top, end } = await dragDown(page, sheet, 200, false);
	// Mid-drag the sheet tracks the finger instead of scrolling its content.
	const moved = await sheet.boundingBox();
	expect(moved?.y ?? top).toBeGreaterThan(top + 120);
	await end();
	await expect(sheet).toHaveCount(0);
});

test("phone: a short drag springs the session sheet back open", async ({
	page,
	relayUrl,
}) => {
	const sheet = await openTitleSheet(page, relayUrl);
	const { top } = await dragDown(page, sheet, 30);
	await page.waitForTimeout(400);
	await expect(sheet).toBeVisible();
	expect((await sheet.boundingBox())?.y).toBeCloseTo(top, 0);
});
