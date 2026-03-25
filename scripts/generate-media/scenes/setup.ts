// ─── Setup Scene ─────────────────────────────────────────────────────────────
// Generates GENERATE-SETUP.gif — Animated walkthrough of the setup wizard,
// showing the cert step, then simulating HTTPS redirect and walking through
// PWA, push, and done steps.

import path from "node:path";
import {
	waitForFonts,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { setupInfo } from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

export const setupScene: SceneDefinition = {
	config: {
		name: "setup",
		outputFile: "GENERATE-SETUP.gif",
		viewport: { width: 393, height: 852 },
		animated: true,
		isMobile: true,
		hasTouch: true,
	},

	async run({ page, previewUrl, phase, assert, hold }) {
		// Phase 1: Show cert step with hasCert: true
		let serveCert = true;

		await phase("setup-routes", async () => {
			await page.route("**/api/setup-info", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(
						serveCert ? setupInfo : { ...setupInfo, hasCert: false },
					),
				}),
			);

			// Mock HTTPS cert verification endpoint
			await page.route("**/info", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: '{"ok":true}',
				}),
			);

			// Mock push notification APIs so "Enable Push" succeeds cleanly
			await page.route("**/sw.js", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/javascript",
					body: "self.addEventListener('install', () => self.skipWaiting());",
				}),
			);

			await page.route("**/api/push/vapid-key", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						publicKey:
							"BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkOs-cF0LMNKU5dmPfV0lDh3SkWa3M8dyTcIx8Fk2s",
					}),
				}),
			);

			await page.route("**/api/push/subscribe", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: '{"ok":true}',
				}),
			);
		});

		await phase("mock-push-apis", async () => {
			await page.addInitScript({
				path: path.join(import.meta.dirname, "../fixtures/push-mock.js"),
			});
		});

		await phase("navigate", async () => {
			await page.goto(`${previewUrl}/setup`);
			await page.addInitScript({
				content:
					"localStorage.removeItem('setup-done'); localStorage.removeItem('setup-pending');",
			});
			await page.reload();
			await waitForFonts(page);
			await waitForIcons(page);
		});

		// Cert step
		await assert("cert-step-loaded", async () => {
			await page
				.getByText("certificate")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await hold(2500, "cert-step");

		// Phase 2: Simulate the HTTPS redirect by switching to hasCert: false
		// (so cert step is skipped) and using ?completed=1 to carry forward
		// the step numbering. This mimics what the user sees after the cert
		// step redirects to HTTPS.
		await phase("simulate-https-redirect", async () => {
			serveCert = false;
			await page.goto(`${previewUrl}/setup?completed=1`);
			await waitForFonts(page);
			await waitForIcons(page);
		});

		// PWA step (displayed as step 2 of N)
		await assert("pwa-step-loaded", async () => {
			const pwaOrSkip = page.locator("button").filter({
				hasText: /skip|add to home|install/i,
			});
			await pwaOrSkip.first().waitFor({ state: "visible", timeout: 5000 });
		});

		await hold(2000, "pwa-step");

		// Walk through remaining steps
		await phase("walk-remaining", async () => {
			let stepNum = 0;
			for (let i = 0; i < 5; i++) {
				const doneVisible = await page
					.getByText("All set")
					.first()
					.isVisible()
					.catch(() => false);
				if (doneVisible) break;

				const skipBtn = page
					.locator("button")
					.filter({ hasText: /skip|finish anyway/i });
				const enableBtn = page
					.locator("button")
					.filter({ hasText: /enable push/i });

				if ((await skipBtn.count()) > 0) {
					await skipBtn.first().click();
				} else if ((await enableBtn.count()) > 0) {
					await enableBtn.first().click();
					await page.waitForTimeout(2000);
					const finishBtn = page
						.locator("button")
						.filter({ hasText: /finish anyway/i });
					if ((await finishBtn.count()) > 0) {
						await finishBtn.first().click();
					}
				} else {
					break;
				}

				stepNum++;
				await page.waitForTimeout(500);
				await hold(1800, `step-${stepNum}`);
			}
		});

		await assert("wizard-complete", async () => {
			await page
				.getByText("All set")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		await hold(1500, "done-screen");
	},
};
