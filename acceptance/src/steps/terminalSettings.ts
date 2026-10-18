import { expect } from "@playwright/test";
import { DEFAULT_TERMINAL_KEYS } from "../../../src/lib/contracts/terminal-keys.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

export const terminalSettingsHandlers: StepHandler[] = [
	{
		name: "seed Terminal settings for the device platform",
		match: /^Terminal settings have their defaults on (macOS|iOS)$/,
		run: async ({ world, match }) => {
			let terminalKeys = DEFAULT_TERMINAL_KEYS;
			const rpc = requireRpcControl(world.page);
			rpc.setStubs({
				GetTerminalKeys: () => ({ terminalKeys }),
				SetTerminalKeys: ({ terminalKeys: next }) => {
					terminalKeys = next;
					rpc.setProjectSetting({ _tag: "terminalKeys", terminalKeys });
					return { terminalKeys };
				},
			});
			rpc.setProjectSetting({ _tag: "terminalKeys", terminalKeys });
			// Plain values, not getters: tsx wraps named functions in __name,
			// which does not exist in the page.
			await world.page.evaluate((platform) => {
				Object.defineProperty(navigator, "platform", {
					configurable: true,
					value: platform === "macOS" ? "MacIntel" : "iPhone",
				});
				Object.defineProperty(navigator, "userAgentData", {
					configurable: true,
					value: { platform },
				});
			}, match[1]);
		},
	},
	{
		name: "open Terminal settings",
		match: /^I open settings to the Terminal section$/,
		run: async ({ world }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { section: "terminal" } }),
				),
			);
			await expect(world.page.locator("#settings-panel")).toBeVisible();
			await expect(
				world.page.getByRole("switch", {
					name: "Keys in the tab bar",
					exact: true,
				}),
			).toBeEnabled();
		},
	},
	{
		name: "assert Terminal settings groups and defaults",
		match:
			/^Terminal shows the desktop and phone key groups and behavior controls on (macOS|iOS)$/,
		run: async ({ world, match }) => {
			const panel = world.page.locator("#settings-panel");
			await expect(panel.getByRole("heading", { level: 3 })).toHaveText([
				"Desktop",
				"Phone and tablet",
				"How keys behave",
			]);
			for (const name of [
				"Keys in the tab bar",
				"Paste, esc and tab",
				"Modifiers",
				"Arrows",
				"Show the key row",
				"Flick hints",
				"Tap twice to lock",
				"Paste as one block",
			])
				await expect(
					panel.getByRole("switch", { name, exact: true }),
				).toHaveAttribute("aria-checked", "true");
			const optionKey = world.page.getByTestId("settings-terminal-option-key");
			if (match[1] === "macOS")
				await expect(optionKey).toHaveAttribute("data-value", "characters");
			else await expect(optionKey).toHaveCount(0);
			await expect(
				world.page.getByTestId("terminal-row-preview"),
			).toBeVisible();
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.some(({ tag }) => tag === "GetTerminalKeys"),
			).toBe(true);
		},
	},
	{
		name: "edit the first phone key Tap action",
		match: /^I set the first phone key Tap action to Home$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("terminal-row-key-0")
				.getByRole("button")
				.first()
				.click();
			await expect(world.page.getByTestId("terminal-key-editor")).toBeVisible();
			await expect(
				world.page.getByTestId("terminal-key-slot-tap"),
			).toHaveAttribute("aria-pressed", "true");
			await world.page.getByTestId("terminal-key-action-home").click();
		},
	},
	{
		name: "assert the phone key editor current action",
		match: /^the phone key editor shows Home selected for Tap$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("terminal-key-slot-tap"),
			).toContainText("Home");
			await expect(
				world.page.getByTestId("terminal-key-slot-tap"),
			).toHaveAttribute("aria-pressed", "true");
			await expect(
				world.page.getByTestId("terminal-key-slot-up"),
			).toContainText("Copy");
			await expect(
				world.page.getByTestId("terminal-key-slot-up"),
			).toHaveAttribute("aria-pressed", "false");
			await expect(world.page.getByTestId(/^terminal-key-action-/)).toHaveCount(
				16,
			);
			await expect(
				world.page.getByTestId("terminal-key-action-home"),
			).toHaveAttribute("aria-pressed", "true");
			await expect(
				world.page.getByTestId("terminal-key-action-paste"),
			).toHaveAttribute("aria-pressed", "false");
		},
	},
	{
		name: "open settings section list",
		match: /^I open the settings section list$/,
		run: async ({ world }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(new CustomEvent("settings:open")),
			);
			await expect(
				world.page.getByTestId("settings-tab-terminal"),
			).toBeVisible();
		},
	},
	{
		name: "assert Terminal tile and New tag",
		match: /^the Terminal tile follows General and has a New tag$/,
		run: async ({ world }) => {
			const tabs = world.page.getByRole("tablist", {
				name: "Settings sections",
			});
			expect(
				await tabs
					.getByRole("tab")
					.evaluateAll((elements) =>
						elements
							.slice(0, 2)
							.map((element) => element.getAttribute("data-testid")),
					),
			).toEqual(["settings-tab-general", "settings-tab-terminal"]);
			await expect(
				world.page
					.getByTestId("settings-tab-terminal")
					.getByTestId("settings-terminal-new"),
			).toHaveText("New");
		},
	},
	{
		name: "visit Terminal and return to the phone settings list",
		match: /^I open the Terminal tile and return to the settings section list$/,
		run: async ({ world }) => {
			await world.page.getByTestId("settings-tab-terminal").click();
			await expect(
				world.page.getByRole("switch", {
					name: "Keys in the tab bar",
					exact: true,
				}),
			).toBeVisible();
			await world.page.getByTestId("settings-back-btn").click();
			await expect(
				world.page.getByTestId("settings-tab-terminal"),
			).toBeVisible();
		},
	},
	{
		name: "assert Terminal introduction is dismissed",
		match: /^the Terminal New tag is gone$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("settings-terminal-new")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "turn off desktop Terminal keys",
		match: /^I turn off Keys in the tab bar$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("switch", { name: "Keys in the tab bar", exact: true })
				.click();
			await expect(
				world.page.getByRole("switch", {
					name: "Keys in the tab bar",
					exact: true,
				}),
			).toHaveAttribute("aria-checked", "false");
		},
	},
	{
		name: "assert child desktop key groups are hidden",
		match: /^Terminal hides the desktop key group switches$/,
		run: async ({ world }) => {
			for (const name of ["Paste, esc and tab", "Modifiers", "Arrows"])
				await expect(
					world.page.getByRole("switch", { name, exact: true }),
				).toBeHidden();
		},
	},
];
