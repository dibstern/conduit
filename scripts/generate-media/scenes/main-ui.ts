// ─── Main UI Scene ───────────────────────────────────────────────────────────
// Generates GENERATE-MAIN-UI.png — iPhone chat with a completed conversation
// showing tool calls and assistant response.

import {
	freezeAnimations,
	waitForFonts,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import { mainUiInit, mainUiTurn1 } from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

export const mainUiScene: SceneDefinition = {
	config: {
		name: "main-ui",
		outputFile: "GENERATE-MAIN-UI.png",
		viewport: { width: 393, height: 852 },
		isMobile: true,
		hasTouch: true,
		animated: false,
	},

	async run({ page, previewUrl, phase, assert }) {
		await phase("setup-ws-mock", async () => {
			await mockRelayWebSocket(page, {
				initMessages: mainUiInit,
				responses: new Map([
					[
						"Build me a landing page with hero, features, and footer",
						mainUiTurn1,
					],
				]),
			});
		});

		await phase("navigate", async () => {
			await page.goto(`${previewUrl}/p/myapp/`);
			await waitForFonts(page);
			await waitForIcons(page);
		});

		await assert("chat-ready", async () => {
			await page
				.locator("textarea")
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await phase("send-message", async () => {
			await page
				.locator("textarea")
				.fill("Build me a landing page with hero, features, and footer");
			await page.keyboard.press("Enter");
		});

		await assert("response-rendered", async () => {
			await page
				.locator("[data-tool-id]")
				.first()
				.waitFor({ state: "visible", timeout: 10000 });
			await page.waitForFunction(
				() =>
					document.querySelectorAll("[data-status='processing']").length === 0,
				{ timeout: 10000 },
			);
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
