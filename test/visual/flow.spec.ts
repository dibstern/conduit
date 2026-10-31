import { expect, test } from "@playwright/test";

const port = process.env["STORYBOOK_PORT"] ?? "6007";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
	test.describe(`Flow motion ${reducedMotion}`, () => {
		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ reducedMotion });
		});

		test("overlay hero keeps its mark and rains instead of rippling", async ({
			page,
		}) => {
			// Paused fake clock: the rain runs on Date.now and timers, so the swap happens only when the test advances time.
			await page.clock.install();
			await page.clock.pauseAt(Date.now());
			await page.goto(
				`http://localhost:${port}/iframe.html?id=overlays-connectoverlay--connecting&viewMode=story`,
			);
			const hero = page.locator("[data-flow-hero]");
			await expect(hero).toBeVisible();
			const mark = hero.locator("[data-conduit-mark]");
			await expect(mark).toHaveCount(1);
			await expect(mark).toHaveCSS("width", "96px");
			await expect(mark).toHaveCSS("height", "96px");
			await expect(mark).toHaveCSS("background-color", "rgb(67, 82, 210)");
			await expect(hero.locator("[data-flow-ripple]")).toHaveCount(0);
			await expect(hero.locator("[data-flow-packet]")).toHaveAttribute(
				"stroke-dasharray",
				"100 200",
			);
			// A tile drop lands every 2.6-3.6s and swaps the verb; reduced motion keeps it still.
			// The visible word, not the steady screen-reader label beside it.
			const status = page.locator(
				"#connect-overlay [role=status] [aria-hidden=true]",
			);
			await expect(status).toContainText("Connecting…");
			await page.clock.runFor(4_000);
			if (reducedMotion === "no-preference")
				await expect(status).not.toContainText("Connecting…");
			else await expect(status).toHaveText("Connecting…");
		});

		for (const [story, variant] of [
			["running", "running"],
			["unread", "unread"],
			["idle", "idle"],
		] as const) {
			test(`${variant} status uses the shared mark`, async ({ page }) => {
				await page.goto(
					`http://localhost:${port}/iframe.html?id=ui-sessionstatusglyph--${story}&viewMode=story`,
				);
				const glyph = page.locator(`[data-flow-glyph="${variant}"]`);
				await expect(glyph).toBeVisible();
				await expect(glyph).toHaveCSS("width", "16px");
				await expect(glyph).toHaveCSS("height", "16px");
				const packet = glyph.locator("[data-flow-packet]");
				if (variant === "running") {
					await expect(packet).toHaveAttribute("pathLength", "100");
					await expect(packet).toHaveAttribute("stroke-dasharray", "30 100");
					if (reducedMotion === "reduce")
						await expect(packet).toHaveCSS("animation-name", "none");
					else await expect(packet).not.toHaveCSS("animation-name", "none");
				} else await expect(packet).toHaveCount(0);
			});
		}
	});
}
