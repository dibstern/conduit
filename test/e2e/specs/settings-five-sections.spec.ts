import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { UsageReading } from "../../../src/lib/contracts/limit-recovery.js";
import { dualDriverProviders } from "../fixtures/mockup-state.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const sections = [
	["general", "General", "[data-testid=settings-composer-controls-icons]"],
	[
		"models",
		"Models & agents",
		"p:has-text('Hidden models stay out of the model picker')",
	],
	[
		"claude",
		"Claude",
		"[data-testid=claude-setting-defaultPermissionMode-select]",
	],
	["usage", "Usage", "#usage-settings"],
	["server", "Server", "#instances-settings"],
] as const;

async function openSettingsPanel(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
		return;
	}
	const titleMenu = page.getByTestId("session-bar-title-menu");
	if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
		return;
	}
	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
}

for (const [viewportName, viewport] of [
	["desktop", { width: 1440, height: 900 }],
	["phone", { width: 390, height: 844 }],
] as const) {
	test.describe(`Settings five sections on ${viewportName}`, () => {
		test.use({ recording: "chat-simple", viewport });

		test("visits every section with computer grouping, scroll and focus preserved", async ({
			page,
			relayUrl,
		}, testInfo) => {
			const now = Date.now();
			const instances = [
				{
					id: "personal",
					name: "Personal",
					driver: "claude",
					port: 0,
					managed: false,
					usageEligible: true,
					status: "healthy",
					restartCount: 0,
					createdAt: now,
				},
				{
					id: "work",
					name: "Work",
					driver: "claude",
					port: 0,
					managed: false,
					usageEligible: true,
					status: "unhealthy",
					restartCount: 0,
					createdAt: now,
				},
			];
			const readings: UsageReading[] = instances.map((instance, index) => ({
				accountId: instance.id,
				harness: "claude",
				status: index === 0 ? "limited" : "available",
				planLabel: "Claude Max",
				windows: [
					{
						kind: "five_hour",
						utilization: index === 0 ? 100 : 12,
						resetsAt: new Date(now + 3 * 3_600_000).toISOString(),
					},
					{
						kind: "seven_day",
						utilization: 22,
						resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
					},
				],
				readAt: now,
				stale: false,
			}));
			const rpc = await mockWsRpc(page, {
				stubs: {
					GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
					GetClaudeSettings: () => ({
						projectSlug: "e2e-replay",
						overrides: {},
					}),
					ResolveClaudeSettings: () => ({
						projectSlug: "e2e-replay",
						instanceId: "personal",
						resolved: {
							attribution: {},
							autoCompactEnabled: {},
							autoCompactWindow: {},
							cleanupPeriodDays: {},
							disableAllHooks: {},
							alwaysThinkingEnabled: {},
						},
					}),
					GetUsageLimitsSetting: () => ({
						usageLimits: {
							autoResume: false,
							autoSwitch: false,
							warnAt: 80,
							order: ["personal", "work"],
						},
					}),
				},
			});
			await mockRelayWebSocket(page, {
				initMessages: [
					{
						type: "project_list",
						projects: [
							{
								slug: "e2e-replay",
								title: "Settings shell",
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
								id: "settings-shell",
								title: "Settings shell",
								status: "idle",
								projectSlug: "e2e-replay",
							},
						],
					},
					{ type: "mock_model_catalog", providers: dualDriverProviders },
				],
				responses: new Map(),
			});
			rpc.setDaemonList("SubscribeInstances", { instances });
			rpc.setUsageReadings(readings);
			await gotoRelay(
				page,
				new URL("/s/settings-shell?p=e2e-replay", relayUrl).toString(),
			);
			await openSettingsPanel(page);

			const panel = page.locator("#settings-panel");
			const content = panel.locator(".settings-content");
			const back = page.getByTestId("settings-back-btn");
			await expect(panel).toBeVisible();
			await expect(panel.locator('[data-testid^="settings-tab-"]')).toHaveCount(
				5,
			);
			expect(
				await panel
					.locator('[data-testid^="settings-tab-"]')
					.evaluateAll((tabs) =>
						tabs.map((tab) => tab.getAttribute("data-testid")),
					),
			).toEqual(sections.map(([section]) => `settings-tab-${section}`));
			const computer = panel.getByTestId("tabs-group-label");
			await expect(computer).toHaveText("This computer");
			const [claudeBox, computerBox, usageBox, serverBox] = await Promise.all([
				page.getByTestId("settings-tab-claude").boundingBox(),
				computer.boundingBox(),
				page.getByTestId("settings-tab-usage").boundingBox(),
				page.getByTestId("settings-tab-server").boundingBox(),
			]);
			if (!claudeBox || !computerBox || !usageBox || !serverBox)
				throw new Error("Missing settings rail positions");
			expect(claudeBox.y + claudeBox.height).toBeLessThanOrEqual(computerBox.y);
			expect(computerBox.y + computerBox.height).toBeLessThanOrEqual(
				usageBox.y,
			);
			expect(usageBox.y + usageBox.height).toBeLessThanOrEqual(serverBox.y);
			await expect(page.getByTestId("settings-tab-usage")).toHaveAccessibleName(
				"Usage",
			);
			await expect(page.getByTestId("settings-usage-dot")).toHaveClass(
				/bg-fill-red/,
			);
			await expect(page.getByTestId("settings-server-dot")).toHaveClass(
				/bg-red-500/,
			);
			if (viewportName === "phone") {
				await expect(content).toHaveCount(0);
				await expect(panel.locator("#settings-panel-title")).toHaveText(
					"Settings",
				);
			} else {
				await expect(page.getByTestId("settings-tab-general")).toHaveAttribute(
					"aria-selected",
					"true",
				);
			}

			const artifactDir = resolve("test-results/settings-five-sections");
			await mkdir(artifactDir, { recursive: true });
			await page.evaluate(() => document.fonts.ready);
			for (const [section, label, selector] of sections) {
				await page.getByTestId(`settings-tab-${section}`).click();
				await expect(content.locator(selector)).toBeVisible();
				await expect
					.poll(() => content.evaluate((element) => element.scrollTop))
					.toBe(0);
				if (viewportName === "phone") {
					await expect(panel.locator("#settings-panel-title")).toHaveText(
						label,
					);
					await expect(back).toBeFocused();
					await expect(
						panel.locator('[data-testid^="settings-tab-"]'),
					).toHaveCount(0);
				} else {
					await expect(
						page.getByTestId(`settings-tab-${section}`),
					).toHaveAttribute("aria-selected", "true");
				}
				if (section === "usage")
					await expect(
						page.getByTestId("usage-settings-headline"),
					).toContainText("Personal is limited");
				const path = resolve(artifactDir, `${section}-${viewportName}.png`);
				await page.screenshot({ path, animations: "disabled" });
				await testInfo.attach(`${section}-${viewportName}`, {
					path,
					contentType: "image/png",
				});
				if (section === "general") {
					await content.evaluate((element) => {
						element.scrollTop = element.scrollHeight;
					});
					await expect
						.poll(() => content.evaluate((element) => element.scrollTop))
						.toBeGreaterThan(0);
				}
				if (viewportName === "phone") {
					await back.click();
					await expect(
						page.getByTestId(`settings-tab-${section}`),
					).toBeFocused();
					await expect(computer).toBeVisible();
				}
			}

			rpc.setDaemonList("SubscribeInstances", {
				instances: instances.map((instance) => ({
					...instance,
					status: "healthy",
				})),
			});
			rpc.setUsageReadings(
				readings.map((reading) => ({
					...reading,
					status: "available",
					windows: reading.windows.map((window) => ({
						...window,
						utilization: 41,
						...(reading.accountId === "personal" && window.kind === "five_hour"
							? { forecast: { kind: "runs_out" as const, at: now + 3_600_000 } }
							: {}),
					})),
				})),
			);
			await expect(page.getByTestId("settings-server-dot")).toHaveCount(0);
			await expect(page.getByTestId("settings-usage-dot")).toHaveClass(
				/bg-fill-amber/,
			);
			await page.getByTestId("settings-tab-usage").click();
			await expect(page.getByTestId("usage-settings-headline")).toContainText(
				"Personal runs out of its 5h window",
			);
			rpc.setUsageReadings(
				readings.map((reading) => ({
					...reading,
					status: "available",
					windows: reading.windows.map((window) => ({
						...window,
						utilization: 41,
					})),
				})),
			);
			await expect(page.getByTestId("usage-settings-headline")).toContainText(
				"All 2 accounts are on pace",
			);
			if (viewportName === "phone") await back.click();
			await expect(page.getByTestId("settings-usage-dot")).toHaveCount(0);

			await page.getByTestId("settings-tab-general").click();
			await expect
				.poll(() => content.evaluate((element) => element.scrollTop))
				.toBe(0);
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", {
						detail: { section: "server", anchor: "instances" },
					}),
				),
			);
			await expect(page.locator("#instances-settings")).toBeInViewport();
			// The anchor scrolls to the top unless the section is too short to
			// scroll that far, in which case it scrolls to the end.
			const { anchorOffset, atScrollEnd } = await page
				.locator("#instances-settings")
				.evaluate((element) => {
					const scroller = element.closest(".settings-content");
					if (!scroller) throw new Error("no .settings-content");
					return {
						anchorOffset:
							element.getBoundingClientRect().top -
							scroller.getBoundingClientRect().top,
						atScrollEnd:
							scroller.scrollTop + scroller.clientHeight >=
							scroller.scrollHeight - 1,
					};
				});
			// scrollIntoView lands on a whole pixel, so a fractional layout above
			// the anchor leaves it up to 1px under the top edge.
			expect(anchorOffset).toBeGreaterThanOrEqual(-1);
			if (!atScrollEnd) expect(anchorOffset).toBeLessThanOrEqual(15);
			await page.getByTestId("settings-close-btn").click();
			await expect(panel).toBeHidden();
		});
	});
}
