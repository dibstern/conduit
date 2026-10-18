import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

const terminalKey = (page: Page, name: string) =>
	page
		.getByRole("toolbar", { name: "Terminal keys" })
		.getByRole("button", { name, exact: true });

const PRESSED = { off: "false", waiting: "mixed", locked: "true" } as const;

export const terminalKeysHandlers: StepHandler[] = [
	{
		name: "assert the desktop terminal keys",
		match:
			/^the terminal keys are paste, esc, tab, the four modifiers and the four arrows$/,
		run: async ({ world }) => {
			const keys = world.page
				.getByRole("toolbar", { name: "Terminal keys" })
				.getByRole("button");
			await expect(keys).toHaveCount(11);
			expect(
				await keys.evaluateAll((buttons) =>
					buttons.map((button) => button.getAttribute("aria-label")),
				),
			).toEqual([
				"Paste",
				"Escape",
				"Tab",
				"Control",
				"Option",
				"Command",
				"Shift",
				"Left arrow",
				"Up arrow",
				"Down arrow",
				"Right arrow",
			]);
		},
	},
	{
		name: "click a terminal key",
		match: /^I click the (\w+) terminal key$/,
		run: async ({ world, match }) => {
			await terminalKey(world.page, match[1] ?? "").click();
		},
	},
	{
		name: "type on the keyboard",
		match: /^I type "(.+)" on the keyboard$/,
		run: async ({ world, match }) => {
			await world.page.keyboard.type(match[1] ?? "");
		},
	},
	{
		name: "assert the terminal find bar's query",
		match: /^the terminal find bar is open, searching for "(.+)"$/,
		run: async ({ world, match }) => {
			const field = world.page.getByRole("textbox", {
				name: "Find in terminal",
			});
			await expect(field).toBeFocused();
			await expect(field).toHaveValue(match[1] ?? "");
		},
	},
	{
		name: "assert a modifier's state",
		match: /^the (\w+) terminal key is (off|waiting|locked)$/,
		run: async ({ world, match }) => {
			const state = match[2] as keyof typeof PRESSED;
			await expect(terminalKey(world.page, match[1] ?? "")).toHaveAttribute(
				"aria-pressed",
				PRESSED[state],
			);
		},
	},
];
