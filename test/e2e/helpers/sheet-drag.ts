import type { Locator, Page } from "@playwright/test";

// Chromium's trusted input pipeline includes native scrolling and pointercancel;
// dispatchEvent would bypass both, and Playwright's touchscreen only taps.
export async function dragDown(
	page: Page,
	sheet: Locator,
	distance: number,
	release = true,
	startOffset = 10,
	timing?: { durationMs: number; steps?: number },
) {
	const box = await sheet.boundingBox();
	if (!box) throw new Error("sheet is not rendered");
	const x = box.x + box.width / 2;
	const startY = box.y + startOffset;
	const cdp = await page.context().newCDPSession(page);
	const timestamp = Date.now() / 1000;
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y: startY }],
		...(timing ? { timestamp } : {}),
	});
	const steps = timing?.steps ?? 12;
	for (let step = 1; step <= steps; step++) {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x, y: startY + (distance * step) / steps }],
			...(timing
				? { timestamp: timestamp + (timing.durationMs * step) / steps / 1000 }
				: {}),
		});
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
	}
	const end = async (cancel = false) => {
		await cdp.send("Input.dispatchTouchEvent", {
			type: cancel ? "touchCancel" : "touchEnd",
			touchPoints: [],
			...(timing ? { timestamp: timestamp + timing.durationMs / 1000 } : {}),
		});
		await cdp.detach();
	};
	if (release) await end();
	return { top: box.y, end };
}
