import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

const MODES = ["Light", "Dark", "System"] as const;
const MODE_ICONS = { Light: "sun", Dark: "moon", System: "monitor" } as const;

const trigger = (page: Page) => page.getByTestId("list-bar-theme");
const menu = (page: Page) => page.getByRole("menu", { name: "Theme" });
const capitalise = (mode: string) =>
	mode.charAt(0).toUpperCase() + mode.slice(1);

async function showSessionList(page: Page) {
	await expect(page.locator("#layout")).toBeVisible();
	if (!(await page.locator("#session-list").isVisible()))
		await page.getByTestId("session-bar-back").click();
	await expect(page.locator("#session-list")).toBeVisible();
}

export const themeMenuHandlers: StepHandler[] = [
	{
		name: "seed starting theme and OS scheme",
		match:
			/^the theme starts as (light|dark|system) with the OS in (light|dark) mode$/,
		run: async ({ world, match }) => {
			await world.page.emulateMedia({
				colorScheme: match[2] === "light" ? "light" : "dark",
			});
			// Only seeds an empty store, so a reload keeps the user's choice.
			await world.page.addInitScript((mode) => {
				if (localStorage.getItem("conduit-theme") === null)
					localStorage.setItem("conduit-theme", mode);
			}, match[1] ?? "dark");
		},
	},
	{
		name: "show the session list",
		match: /^the session list is showing$/,
		run: async ({ world }) => {
			await showSessionList(world.page);
		},
	},
	{
		name: "reload with the session list showing",
		match: /^I reload the theme session list$/,
		run: async ({ world }) => {
			await world.page.reload();
			await showSessionList(world.page);
		},
	},
	{
		name: "flip the OS colour scheme",
		match: /^the OS switches to (light|dark) mode$/,
		run: async ({ world, match }) => {
			await world.page.emulateMedia({
				colorScheme: match[1] === "light" ? "light" : "dark",
			});
		},
	},
	{
		name: "assert the theme on screen",
		match: /^the app shows the (light|dark) theme$/,
		run: async ({ world, match }) => {
			const root = world.page.locator("html");
			const other = match[1] === "light" ? "dark" : "light";
			await expect(root).toHaveClass(new RegExp(`\\b${match[1]}-theme\\b`));
			await expect(root).not.toHaveClass(new RegExp(`\\b${other}-theme\\b`));
		},
	},
	{
		name: "assert the theme button icon",
		match: /^the theme button shows a (sun|moon)$/,
		run: async ({ world, match }) => {
			await expect(trigger(world.page)).toBeVisible();
			await expect(
				trigger(world.page).locator(`svg.lucide-${match[1]}`),
			).toHaveCount(1);
		},
	},
	{
		name: "open the theme menu",
		match: /^I open the theme menu$/,
		run: async ({ world }) => {
			await trigger(world.page).click();
			await expect(menu(world.page)).toBeVisible();
		},
	},
	{
		name: "assert the theme menu modes",
		match:
			/^the theme menu offers Light, Dark and System with (light|dark|system) checked$/,
		run: async ({ world, match }) => {
			const checked = capitalise(match[1] ?? "");
			const rows = menu(world.page).getByRole("menuitemradio");
			await expect(rows).toHaveText([...MODES]);
			for (const mode of MODES) {
				const row = menu(world.page).getByRole("menuitemradio", {
					name: mode,
					exact: true,
				});
				await expect(row).toHaveAttribute(
					"aria-checked",
					String(mode === checked),
				);
				await expect(row.locator(`svg.lucide-${MODE_ICONS[mode]}`)).toHaveCount(
					1,
				);
			}
		},
	},
	{
		name: "choose a theme mode",
		match: /^I choose the (light|dark|system) theme$/,
		run: async ({ world, match }) => {
			await menu(world.page)
				.getByRole("menuitemradio", {
					name: capitalise(match[1] ?? ""),
					exact: true,
				})
				.click();
		},
	},
	{
		name: "press Escape in the theme menu",
		match: /^I press Escape in the theme menu$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert the theme menu is closed",
		match: /^the theme menu is closed$/,
		run: async ({ world }) => {
			await expect(menu(world.page)).toHaveCount(0);
			await expect(trigger(world.page)).toHaveAttribute(
				"aria-expanded",
				"false",
			);
		},
	},
	{
		name: "assert the phone list bar fits its actions",
		match: /^the phone list bar fits Theme, Select, New session and Settings$/,
		run: async ({ world }) => {
			const header = world.page.locator("#sidebar-header");
			const actions = ["Theme", "Select sessions", "New session", "Settings"];
			// Retried because the list is still settling from the desktop width.
			await expect(async () => {
				const bar = await header.boundingBox();
				if (!bar) throw new Error("The list bar is not rendered");
				let previousRight = bar.x;
				for (const name of actions) {
					const box = await header
						.getByRole("button", { name, exact: true })
						.boundingBox();
					if (!box) throw new Error(`${name} is not rendered`);
					expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
					expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
					// In this order, left to right, without overlapping.
					expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(
						previousRight,
					);
					previousRight = box.x + box.width;
				}
				expect(previousRight, "last action's right edge").toBeLessThanOrEqual(
					bar.x + bar.width,
				);
			}).toPass();
		},
	},
	{
		name: "assert touch-sized theme menu rows",
		match: /^every theme menu row is at least (\d+) pixels tall$/,
		run: async ({ world, match }) => {
			const rows = menu(world.page).getByRole("menuitemradio");
			await expect(rows).toHaveCount(MODES.length);
			for (const row of await rows.all()) {
				const box = await row.boundingBox();
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(Number(match[1]));
			}
		},
	},
];
