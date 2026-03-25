// ─── Dashboard Scene ─────────────────────────────────────────────────────────
// Generates GENERATE-DASHBOARD.png — Desktop multi-project dashboard showing
// four project cards with status indicators.

import {
	freezeAnimations,
	waitForFonts,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { dashboardProjects } from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

export const dashboardScene: SceneDefinition = {
	config: {
		name: "dashboard",
		outputFile: "GENERATE-DASHBOARD.png",
		viewport: { width: 1440, height: 900 },
		animated: false,
	},

	async run({ page, previewUrl, phase, assert }) {
		await phase("setup-routes", async () => {
			await page.route("**/api/projects", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						projects: dashboardProjects,
						version: "0.1.0",
					}),
				}),
			);
		});

		await phase("navigate", async () => {
			await page.goto(`${previewUrl}/`);
			await page.evaluate(() => localStorage.setItem("setup-done", "1"));
			await page.reload();
			await waitForFonts(page);
			await waitForIcons(page);
		});

		await assert("project-cards-rendered", async () => {
			await page
				.locator("a[href*='/p/']")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
			const count = await page.locator("a[href*='/p/']").count();
			if (count < 4) {
				throw new Error(`Expected at least 4 project cards, found ${count}`);
			}
		});

		await phase("freeze-animations", async () => {
			await freezeAnimations(page);
			await page.waitForTimeout(200);
		});
	},
};
