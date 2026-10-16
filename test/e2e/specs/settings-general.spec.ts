import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { dualDriverProviders } from "../fixtures/mockup-state.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

for (const [viewportName, viewport] of [
	["desktop", { width: 1440, height: 900 }],
	["phone", { width: 390, height: 844 }],
] as const) {
	test.describe(`General settings on ${viewportName}`, () => {
		test.use({ recording: "chat-simple", viewport });

		test("orders the groups and keeps debug in collapsed Advanced", async ({
			page,
			relayUrl,
		}, testInfo) => {
			await page.addInitScript(() => {
				localStorage.setItem("feature-flags", "[]");
				localStorage.setItem(
					"conduit-composer-preferences",
					JSON.stringify({ controls: "icons", contextWarning: 80 }),
				);
			});
			await mockWsRpc(page, {
				stubs: {
					GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
				},
			});
			await mockRelayWebSocket(page, {
				initMessages: [
					{
						type: "project_list",
						projects: [
							{
								slug: "e2e-replay",
								title: "General settings",
								folders: ["/workspace/settings"],
							},
						],
						current: "e2e-replay",
					},
					{
						type: "shell_snapshot",
						roots: true,
						sessions: [
							{
								id: "settings-general",
								title: "General settings",
								status: "idle",
								projectSlug: "e2e-replay",
							},
						],
					},
					{ type: "mock_model_catalog", providers: dualDriverProviders },
				],
				responses: new Map(),
			});
			await gotoRelay(
				page,
				new URL("/s/settings-general?p=e2e-replay", relayUrl).toString(),
			);
			const listOverflow = page.getByTestId("list-bar-overflow");
			const titleMenu = page.getByTestId("session-bar-title-menu");
			if (await listOverflow.isVisible()) {
				await listOverflow.click();
				await page.getByTestId("list-overflow-settings").click();
			} else if (await titleMenu.isVisible()) {
				await titleMenu.click();
				await page.getByTestId("session-title-settings").click();
			} else {
				await page.getByTestId("session-bar-overflow").click();
				await page.getByTestId("overflow-settings").click();
			}
			const panel = page.locator("#settings-panel");
			await expect(panel).toBeVisible();
			await page.getByTestId("settings-tab-general").click();
			await expect(panel.getByRole("heading", { level: 3 })).toHaveText([
				"Notifications",
				"Appearance",
				"Composer",
				"Sessions",
			]);
			await expect(
				panel
					.getByRole("region", { name: "Appearance", exact: true })
					.getByRole("combobox", { name: /^Theme\b/ }),
			).toBeVisible();
			await expect(
				panel
					.getByRole("region", { name: "Sessions", exact: true })
					.getByTestId("settings-auto-settle-select"),
			).toHaveValue("3");
			await expect(panel.getByText("Log level", { exact: true })).toHaveCount(
				0,
			);

			const advanced = panel.getByRole("region", {
				name: "Advanced",
				exact: true,
			});
			const disclosure = advanced.getByRole("button", { name: /^Advanced/ });
			const toggle = advanced.getByRole("switch", {
				name: "Toggle connection debug panel",
			});
			await expect(disclosure).toHaveAttribute("aria-expanded", "false");
			await expect(disclosure).toContainText("Debug off");
			await expect(toggle).toHaveCount(0);
			const artifactDir = resolve("test-results/settings-general");
			await mkdir(artifactDir, { recursive: true });
			await page.evaluate(() => document.fonts.ready);

			for (const state of ["collapsed", "expanded"] as const) {
				if (state === "expanded") {
					await disclosure.click();
					await expect(disclosure).toHaveAttribute("aria-expanded", "true");
					await expect(advanced.getByRole("switch")).toHaveCount(1);
					await expect(advanced.getByRole("combobox")).toHaveCount(0);
					await expect(toggle).toHaveAttribute("aria-checked", "false");
					await toggle.click();
					await expect(toggle).toHaveAttribute("aria-checked", "true");
					await expect(disclosure).toContainText("Debug on");
					expect(
						await page.evaluate(() =>
							JSON.parse(localStorage.getItem("feature-flags") ?? "[]"),
						),
					).toContain("debug");
				}
				await advanced.scrollIntoViewIfNeeded();
				await page.evaluate(() =>
					(document.activeElement as HTMLElement | null)?.blur(),
				);
				const path = resolve(
					artifactDir,
					`${viewportName}-advanced-${state}.png`,
				);
				await page.screenshot({ path, animations: "disabled" });
				await testInfo.attach(`general-${viewportName}-${state}`, {
					path,
					contentType: "image/png",
				});
			}
			await disclosure.click();
			await expect(disclosure).toHaveAttribute("aria-expanded", "false");
			await expect(disclosure).toContainText("Debug on");
			await expect(toggle).toHaveCount(0);
		});
	});
}
