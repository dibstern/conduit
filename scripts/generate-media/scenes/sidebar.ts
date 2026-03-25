// ─── Sidebar Scene ───────────────────────────────────────────────────────────
// Generates GENERATE-SIDEBAR.png — Desktop view showing the sidebar with a
// populated session list and the main chat area.

import {
	freezeAnimations,
	waitForFonts,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import { sidebarInit } from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

export const sidebarScene: SceneDefinition = {
	config: {
		name: "sidebar",
		outputFile: "GENERATE-SIDEBAR.png",
		viewport: { width: 1440, height: 900 },
		animated: false,
	},

	async run({ page, previewUrl, phase, assert }) {
		await phase("setup-ws-mock", async () => {
			await mockRelayWebSocket(page, {
				initMessages: sidebarInit,
				responses: new Map(),
			});
		});

		await phase("navigate", async () => {
			// Ensure sidebar is not collapsed
			await page.addInitScript(() => {
				localStorage.removeItem("sidebar-collapsed");
			});
			await page.goto(`${previewUrl}/p/myapp/`);
			await waitForFonts(page);
			await waitForIcons(page);
		});

		await assert("chat-ready", async () => {
			await page
				.locator("textarea")
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await assert("sidebar-visible", async () => {
			await page
				.locator("#sidebar")
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await assert("session-list-populated", async () => {
			// Wait for session items to render in the sidebar
			await page
				.locator("#session-list [data-session-id]")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
			const count = await page
				.locator("#session-list [data-session-id]")
				.count();
			if (count < 5) {
				throw new Error(`Expected at least 5 session items, found ${count}`);
			}
		});

		await phase("hide-overlay", async () => {
			await page.addStyleTag({
				content: "#connect-overlay { display: none !important; }",
			});
		});

		await phase("freeze-animations", async () => {
			await freezeAnimations(page);
			await page.waitForTimeout(200);
		});
	},
};
