import type { Locator, Page } from "@playwright/test";

/** Drop-down sheets glide in; geometry read mid-glide is not the resting place. */
export async function settleSheet(page: Page) {
	await page.evaluate(async () => {
		// The entry glide starts next frame, so an earlier animation snapshot can be empty.
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await Promise.allSettled(
			document
				.getAnimations()
				.filter(
					(animation) =>
						animation instanceof CSSTransition &&
						animation.playState === "running",
				)
				.map((animation) => animation.finished),
		);
		// Header ResizeObserver placement follows the transition's final layout.
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
}

// Chromium's trusted input pipeline includes native scrolling and pointercancel;
// dispatchEvent would bypass both, and Playwright's touchscreen only taps.
// A negative `distance` drags up; a negative `startOffset` counts from the bottom
// edge, where a drop-down sheet's handle sits.
export async function dragSheet(
	page: Page,
	sheet: Locator,
	distance: number,
	release = true,
	startOffset = 10,
	timing?: { durationMs: number; steps?: number },
) {
	await settleSheet(page);
	const box = await sheet.boundingBox();
	if (!box) throw new Error("sheet is not rendered");
	const x = box.x + box.width / 2;
	const startY =
		startOffset < 0 ? box.y + box.height + startOffset : box.y + startOffset;
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
