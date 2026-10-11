import { expect, test } from "@playwright/test";

// A real pointer hover, not the pseudo-state addon: that addon cannot
// activate Tailwind's nested group-hover rules, which is where the title's
// hover styles live.

const story = (id: string) =>
	`/iframe.html?id=session-sessionitem--${id}&viewMode=story`;

test.describe("Session row hover", () => {
	test("leaves a short pinned title still, with its star in place", async ({
		page,
	}) => {
		await page.goto(story("pinned"), { waitUntil: "domcontentloaded" });
		const star = page.getByTitle("Pinned session");
		const starX = async () => (await star.boundingBox())?.x;
		const before = await starX();
		expect(before).toBeDefined();

		await page.locator(".session-item").hover();

		await expect(page.locator(".session-title-inner > span")).toHaveCSS(
			"animation-name",
			"none",
		);
		expect(await starX()).toBe(before);
	});

	test("scrolls a long title until its last character is visible", async ({
		page,
	}) => {
		await page.goto(story("long-title"), { waitUntil: "domcontentloaded" });
		// The story fills the canvas, where even this title fits; a sidebar does not.
		await page.locator(".session-item").evaluate((row) => {
			if (row.parentElement) row.parentElement.style.width = "260px";
		});
		await page.locator(".session-item").hover();
		await expect(page.locator(".session-title-inner > span")).toHaveCSS(
			"animation-name",
			"marquee-scroll",
		);

		// Seek the marquee to its far end rather than waiting it out.
		const edges = await page.evaluate(() => {
			for (const animation of document.getAnimations()) {
				const { delay = 0, duration } =
					animation.effect?.getComputedTiming() ?? {};
				animation.pause();
				animation.currentTime = delay + Number(duration) * 0.95;
			}
			const clip = document.querySelector(".session-title-inner");
			const text = clip?.querySelector("span")?.firstChild;
			if (!clip || !text?.textContent) throw new Error("title not rendered");
			const lastChar = document.createRange();
			lastChar.setStart(text, text.textContent.length - 1);
			lastChar.setEnd(text, text.textContent.length);
			const char = lastChar.getBoundingClientRect();
			const box = clip.getBoundingClientRect();
			return {
				charLeft: char.left,
				charRight: char.right,
				boxLeft: box.left,
				boxRight: box.right,
			};
		});

		expect(edges.charLeft).toBeGreaterThanOrEqual(edges.boxLeft);
		expect(edges.charRight).toBeLessThanOrEqual(edges.boxRight + 1);
	});
});
