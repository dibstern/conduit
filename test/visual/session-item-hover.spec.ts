import { expect, test } from "@playwright/test";

// A real pointer hover, not the pseudo-state addon: that addon cannot
// activate Tailwind's nested group-hover rules, which is where the title's
// hover styles live.
const story = (id: string) =>
	`/iframe.html?id=session-sessionitem--${id}&viewMode=story`;

test.describe("Session row hover", () => {
	test("keeps a short pinned title's star in place", async ({ page }) => {
		await page.goto(story("pinned"), { waitUntil: "domcontentloaded" });
		const star = page.getByTitle("Pinned session");
		const starX = async () => (await star.boundingBox())?.x;
		const before = await starX();
		expect(before).toBeDefined();

		await page.locator(".session-item").hover();
		await expect(page.locator(".session-title-inner")).toHaveCSS(
			"animation-name",
			"marquee-scroll",
		);
		expect(await starX()).toBe(before);
	});
});
