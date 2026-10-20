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
	startOffset = 10,
) {
	const box = await sheet.boundingBox();
	if (!box) throw new Error("sheet is not rendered");
	const x = box.x + box.width / 2;
	const startY = box.y + startOffset;
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
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
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

test("phone: dragging the session sheet down from its top follows the finger and dismisses", async ({
	page,
	relayUrl,
}) => {
	const sheet = await openOverflowSheet(page, relayUrl);
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
	const sheet = await openOverflowSheet(page, relayUrl);
	const { top } = await dragDown(page, sheet, 30);
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
		.toBeGreaterThan(40);
	await body.evaluate((node) => {
		node.scrollTop = 40;
	});
	const top = (await sheet.boundingBox())?.y;
	await dragDown(page, body, 30, true, 30);
	await expect(sheet).toBeVisible();
	expect((await sheet.boundingBox())?.y).toBeCloseTo(top ?? 0, 0);
	await expect
		.poll(() => body.evaluate((node) => node.scrollTop))
		.toBeLessThan(40);
	await testInfo.attach("scrolled-sheet-body", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});
