import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

export const settingsGeneralHandlers: StepHandler[] = [
	{
		name: "seed General auto-settle",
		match: /^General auto-settle is set to 3 days$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				GetAutoSettleSetting: () => ({
					autoSettleAfterDays: 3,
				}),
			});
		},
	},
	{
		name: "assert General headings in order",
		match:
			/^the General headings are Notifications, Appearance, Composer and Sessions in order$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#settings-panel")
					.getByRole("heading", { level: 3 }),
			).toHaveText(["Notifications", "Appearance", "Composer", "Sessions"]);
		},
	},
	{
		name: "assert Theme and auto-settle groups",
		match: /^General keeps Theme in Appearance and auto-settle in Sessions$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#settings-panel");
			await expect(
				panel
					.getByRole("region", { name: "Appearance", exact: true })
					.getByRole("button", { name: /^Theme\b/ }),
			).toBeVisible();
			await expect(
				panel
					.getByRole("region", { name: "Sessions", exact: true })
					.getByTestId("settings-auto-settle-select"),
			).toHaveAttribute("data-value", "3");
		},
	},
	{
		name: "assert General omits log level",
		match: /^General has no log level control$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#settings-panel")
					.getByText("Log level", { exact: true }),
			).toHaveCount(0);
		},
	},
	{
		name: "assert Advanced state and debug summary",
		match:
			/^the General Advanced group is (collapsed|expanded) with Debug (off|on)$/,
		run: async ({ world, match }) => {
			const advanced = world.page.getByRole("region", {
				name: "Advanced",
				exact: true,
			});
			const expanded = match[1] === "expanded";
			const disclosure = advanced.getByRole("button", { name: /^Advanced/ });
			await expect(disclosure).toHaveAttribute(
				"aria-expanded",
				String(expanded),
			);
			await expect(disclosure).toContainText(`Debug ${match[2]}`);
			await expect(advanced.getByRole("switch")).toHaveCount(expanded ? 1 : 0);
			await expect(advanced.getByRole("combobox")).toHaveCount(0);
			if (expanded) {
				await expect(
					advanced.getByRole("switch", {
						name: "Toggle connection debug panel",
					}),
				).toHaveAttribute("aria-checked", String(match[2] === "on"));
			}
			await advanced.scrollIntoViewIfNeeded();
			await world.page.evaluate(() =>
				(document.activeElement as HTMLElement | null)?.blur(),
			);
		},
	},
	{
		name: "expand General Advanced",
		match: /^I expand General Advanced$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("region", { name: "Advanced", exact: true })
				.getByRole("button", { name: /^Advanced/ })
				.click();
		},
	},
	{
		name: "toggle General connection debug panel",
		match: /^I toggle the General connection debug panel$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("region", { name: "Advanced", exact: true })
				.getByRole("switch", { name: "Toggle connection debug panel" })
				.click();
		},
	},
];
