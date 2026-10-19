/**
 * iOS 26+ blurs the status-bar area unless WebKit finds a fixed or sticky box
 * at (width / 2, 4). #compact-top-edge is that box. While sampling, WebKit
 * skips any layer with no fixed or sticky element inside it or around it, so
 * a box painted over the strip is harmless until it holds one. #scroll-btn is
 * sticky, so once the transcript was scrolled up, #app (painted over the strip)
 * was sampled instead, and the blur came back on the next overlay close
 * (conduit-test-mi97). Chromium shares the paint order but not the sampler,
 * so this asserts the sampler's rule; test/e2e/ios/top-scroll-pocket.test.ts
 * checks the real thing.
 */
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({
	recording: "chat-simple",
	viewport: { width: 390, height: 844 },
	hasTouch: true,
	isMobile: true,
});

/** What WebKit's sampler would hit before the strip, as "covering element (pinned element inside its layer)". */
function sampledOverStrip(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		// The sampler's first pass ignores pointer-events.
		const override = document.createElement("style");
		override.textContent = "* { pointer-events: auto !important; }";
		document.head.append(override);
		const stack = document.elementsFromPoint(innerWidth / 2, 4);
		override.remove();

		const name = (element: Element) =>
			element.tagName.toLowerCase() + (element.id ? `#${element.id}` : "");
		const isPinned = (element: Element) => {
			const style = getComputedStyle(element);
			return (
				(style.position === "fixed" || style.position === "sticky") &&
				element.checkVisibility()
			);
		};
		const strip = stack.findIndex(
			(element) => element.id === "compact-top-edge",
		);
		if (strip < 0) return ["#compact-top-edge is not at the sample point"];
		return stack.slice(0, strip).flatMap((element) => {
			// Inside a fixed or sticky box, the sampler finds an edge anyway.
			for (let at: Element | null = element; at; at = at.parentElement)
				if (isPinned(at)) return [];
			// Its nearest positioned ancestor stands in for its layer: the real layer
			// is that box or one inside it, so this can only over-report.
			let layer: Element | null = element;
			while (
				layer &&
				layer !== document.body &&
				getComputedStyle(layer).position === "static"
			)
				layer = layer.parentElement;
			if (!layer || layer === document.body) return [];
			const pinned = [...layer.querySelectorAll("*")].find(isPinned);
			return pinned ? [`${name(element)} (${name(pinned)})`] : [];
		});
	});
}

async function scrollTranscriptUp(page: Page): Promise<void> {
	const messages = page.locator("#messages");
	await messages.evaluate((scroller) => {
		for (let index = 0; index < 30; index++) {
			const filler = document.createElement("div");
			filler.style.height = "120px";
			scroller.append(filler);
		}
		scroller.scrollTop = scroller.scrollHeight;
	});
	// Leave the bottom only once the transcript has settled there.
	await expect
		.poll(() =>
			messages.evaluate(
				(scroller) =>
					scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
			),
		)
		.toBeLessThanOrEqual(1);
	await messages.evaluate((scroller) => {
		scroller.scrollTop = 0;
	});
	await expect(page.locator("#scroll-btn")).toBeVisible();
}

test("nothing the iOS sampler reads covers the top-edge strip", async ({
	page,
	relayUrl,
}, testInfo) => {
	const samples: Record<string, string[]> = {};
	await gotoRelay(page, relayUrl);
	await expect(page.locator("#session-bar-more")).toBeVisible();
	samples["chat"] = await sampledOverStrip(page);

	await scrollTranscriptUp(page);
	samples["chat, scrolled up"] = await sampledOverStrip(page);

	await page.locator("#messages").dispatchEvent("wheel", { deltaY: 120 });
	await expect(page.getByTestId("session-bar")).toHaveAttribute(
		"data-collapsed",
		"true",
	);
	samples["island, scrolled up"] = await sampledOverStrip(page);

	await page.locator("#session-bar-back").click();
	await expect(page.locator("#list-bar-more")).toBeVisible();
	samples["session list"] = await sampledOverStrip(page);

	writeFileSync(
		testInfo.outputPath("samples.json"),
		JSON.stringify(samples, null, "\t"),
	);
	expect(samples).toEqual(
		Object.fromEntries(Object.keys(samples).map((state) => [state, []])),
	);
});
