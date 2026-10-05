/**
 * bits-ui 2.18.1 locks text selection to the top menu or popover while a
 * finger is down in it: pointerdown sets `user-select: none` on <body> and
 * pointerup restores the old value. It ignores pointercancel, so the next
 * pointerdown saves the locked `none` as the value to restore. On a phone, a
 * press that turned into a scroll inside the session sheet, then a tap on an
 * item, left the whole page unselectable until reload: no chat text could be
 * selected or copied (conduit-test-l1sh). Menu and Popover turn the lock off.
 */
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.use({
	recording: "chat-simple",
	// Short enough that the session sheet, capped at 90vh, scrolls.
	viewport: { width: 375, height: 520 },
	hasTouch: true,
	isMobile: true,
});

// A real finger through Chromium's input pipeline, so the swipe scrolls the
// sheet natively and the browser cancels the press, as on a phone.
async function swipeUp(page: Page, x: number, y: number, distance: number) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y }],
	});
	const steps = 12;
	for (let step = 1; step <= steps; step++) {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x, y: y - (distance * step) / steps }],
		});
		await page.waitForTimeout(16);
	}
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchEnd",
		touchPoints: [],
	});
	await cdp.detach();
}

/** Double-clicks "reply" in the user's message and returns the selection. */
async function selectReplyWord(page: Page): Promise<string> {
	const point = await page.evaluate(() => {
		const transcript = document.getElementById("messages");
		if (!transcript) return null;
		const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const start = node.textContent?.indexOf("reply with just") ?? -1;
			if (start < 0) continue;
			const range = document.createRange();
			range.setStart(node, start);
			range.setEnd(node, start + "reply".length);
			const box = range.getBoundingClientRect();
			return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
		}
		return null;
	});
	if (!point) throw new Error("the user's message is not in the transcript");
	await page.evaluate(() => getSelection()?.removeAllRanges());
	await page.mouse.dblclick(point.x, point.y);
	return page.evaluate(() => getSelection()?.toString().trim() ?? "");
}

test("phone: scrolling the session sheet, then tapping an item, keeps chat text selectable", async ({
	page,
	relayUrl,
}, testInfo) => {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.sendMessage("Hello, reply with just the word pong");
	await new ChatPage(page).waitForStreamingComplete();

	await page.getByTestId("session-bar-title-menu").tap();
	const sheet = page.getByTestId("session-action-sheet");
	await expect(sheet).toBeVisible();
	// Let the sheet finish sliding in so the swipe lands inside it.
	await page.waitForTimeout(400);
	const box = await sheet.boundingBox();
	if (!box) throw new Error("sheet is not rendered");
	await swipeUp(page, box.x + box.width * 0.6, box.y + box.height * 0.8, 100);
	await expect
		.poll(() => sheet.evaluate((node) => node.scrollTop), {
			message: "the swipe must scroll the sheet; that cancels the press",
		})
		.toBeGreaterThan(0);
	await sheet.getByRole("menuitem", { name: /^Mark (un)?read$/ }).tap();
	await expect(sheet).toHaveCount(0);

	const evidence = {
		bodyUserSelect: await page.evaluate(() => document.body.style.userSelect),
		selected: await selectReplyWord(page),
	};
	const evidencePath = testInfo.outputPath("selection-evidence.json");
	writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
	await testInfo.attach("selection-evidence", {
		path: evidencePath,
		contentType: "application/json",
	});
	await page.screenshot({ path: testInfo.outputPath("chat-after-sheet.png") });
	expect(evidence).toEqual({ bodyUserSelect: "", selected: "reply" });
});
