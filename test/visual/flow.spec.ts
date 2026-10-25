import { expect, test } from "@playwright/test";

const port = process.env["STORYBOOK_PORT"] ?? "6007";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
	test.describe(`Flow motion ${reducedMotion}`, () => {
		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ reducedMotion });
		});

		test("overlay hero keeps its mark and one ripple", async ({ page }) => {
			await page.goto(
				`http://localhost:${port}/iframe.html?id=overlays-connectoverlay--connecting&viewMode=story`,
			);
			const hero = page.locator("[data-flow-hero]");
			await expect(hero).toBeVisible();
			await expect(hero.locator("[data-conduit-mark]")).toHaveCount(1);
			await expect(hero.locator("[data-conduit-mark]")).toHaveCSS(
				"width",
				"96px",
			);
			await expect(hero.locator("[data-conduit-mark]")).toHaveCSS(
				"height",
				"96px",
			);
			await expect(hero.locator("[data-flow-ripple]")).toHaveCount(1);
			await expect(hero.locator("[data-flow-sparkle]")).toHaveCount(0);
			await expect(hero.locator("[data-flow-packet]")).toHaveCount(1);
			for (const selector of ["[data-flow-ripple]", "[data-flow-packet]"]) {
				for (const part of await hero.locator(selector).all()) {
					if (reducedMotion === "reduce")
						await expect(part).toHaveCSS("animation-name", "none");
					else await expect(part).not.toHaveCSS("animation-name", "none");
				}
			}
			if (reducedMotion === "no-preference") {
				await expect(hero.locator("[data-flow-ripple]").first()).toHaveCSS(
					"animation-duration",
					"2.4s",
				);
				await expect(hero.locator("[data-flow-packet]")).toHaveCSS(
					"animation-duration",
					"1.4s",
				);
			}
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
