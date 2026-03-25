// ─── Approval Scene ──────────────────────────────────────────────────────────
// Generates GENERATE-APPROVAL.png — iPhone showing a permission request card
// for a Bash command that needs user approval, after some chat context.

import {
	freezeAnimations,
	waitForFonts,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import {
	approvalInit,
	approvalPermission,
	approvalTurn2Start,
	mainUiTurn1,
} from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

export const approvalScene: SceneDefinition = {
	config: {
		name: "approval",
		outputFile: "GENERATE-APPROVAL.png",
		viewport: { width: 393, height: 852 },
		isMobile: true,
		hasTouch: true,
		animated: false,
	},

	async run({ page, previewUrl, phase, assert }) {
		let wsMock: Awaited<ReturnType<typeof mockRelayWebSocket>>;

		await phase("setup-ws-mock", async () => {
			wsMock = await mockRelayWebSocket(page, {
				initMessages: approvalInit,
				responses: new Map([
					["Help me build the landing page with a hero section", mainUiTurn1],
					["Now deploy it to staging", approvalTurn2Start],
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

		// Send first message to build chat context
		await phase("send-first-message", async () => {
			await page
				.locator("textarea")
				.fill("Help me build the landing page with a hero section");
			await page.keyboard.press("Enter");
		});

		await assert("turn1-complete", async () => {
			// Wait for tool calls to render
			await page
				.locator("[data-tool-id]")
				.first()
				.waitFor({ state: "visible", timeout: 10000 });
			// Wait for idle status (turn complete)
			await page.waitForFunction(
				() =>
					document.querySelectorAll("[data-status='processing']").length === 0,
				{ timeout: 10000 },
			);
		});

		// Send second message that triggers the permission
		await phase("send-second-message", async () => {
			await page.locator("textarea").fill("Now deploy it to staging");
			await page.keyboard.press("Enter");
		});

		// Brief wait for the turn2 thinking to start rendering
		await phase("wait-for-thinking", async () => {
			await page.waitForTimeout(300);
		});

		// Inject the permission request
		await phase("inject-permission", async () => {
			// biome-ignore lint/style/noNonNullAssertion: wsMock is assigned in the prior sequential phase
			wsMock!.sendMessage(approvalPermission);
		});

		await assert("permission-card-visible", async () => {
			await page
				.locator("[data-request-id]")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
			await page
				.locator("text=Bash")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		// Scroll to bottom so the permission card is fully visible
		await phase("scroll-to-bottom", async () => {
			await page.evaluate(() => {
				const chat = document.querySelector("#chat-messages");
				if (chat) chat.scrollTop = chat.scrollHeight;
			});
			await page.waitForTimeout(200);
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
