import { type CDPSession, expect, type Page } from "@playwright/test";
import { PHONE_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";

/** A key by the name it's announced by. A phone flick key is announced as
 *  "Control, flick up for Command", so its tap name finds it too. */
const terminalKey = (page: Page, name: string) =>
	page.getByRole("toolbar", { name: "Terminal keys" }).getByRole("button", {
		name: new RegExp(`^${name}(, flick up for \\w+)?$`),
	});

/** A real finger on a key: CDP touch events, which the page also sees as
 *  pointer events, starting at the key's centre. */
async function touchKey(page: Page, name: string) {
	const box = await terminalKey(page, name).boundingBox();
	if (!box) throw new Error(`The ${name} terminal key is not visible`);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	const cdp = await page.context().newCDPSession(page);
	const touch = (type: "touchStart" | "touchMove", dy: number) =>
		cdp.send("Input.dispatchTouchEvent", {
			type,
			touchPoints: [{ x, y: y + dy }],
		});
	await touch("touchStart", 0);
	return {
		async flick() {
			for (let step = 1; step <= 6; step++) await touch("touchMove", -5 * step);
		},
		async lift() {
			try {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			} finally {
				await cdp.detach();
			}
		},
	};
}

/** The finger still down on a key, so a step can look at the held state. */
const heldFingers = new WeakMap<Page, Awaited<ReturnType<typeof touchKey>>>();

/** Emulation lasts as long as the session that set it, so it stays open. */
const touchEmulation = new WeakMap<Page, CDPSession>();

const PRESSED = { off: "false", waiting: "mixed", locked: "true" } as const;

export const terminalKeysHandlers: StepHandler[] = [
	{
		name: "set touch phone viewport",
		match: /^the viewport is a touch phone$/,
		run: async ({ world }) => {
			const cdp = await world.page.context().newCDPSession(world.page);
			await cdp.send("Emulation.setTouchEmulationEnabled", {
				enabled: true,
				maxTouchPoints: 5,
			});
			touchEmulation.set(world.page, cdp);
			await world.driver.setViewport(world.page, PHONE_VIEWPORT);
			expect(
				await world.page.evaluate(
					() => matchMedia("(pointer: coarse)").matches,
				),
			).toBe(true);
		},
	},
	{
		name: "assert the phone terminal key row",
		match:
			/^the terminal key row is paste or copy, esc or tab, ⌃ or ⌘, ⌥ or ⇧, the arrow pad and the keyboard toggle$/,
		run: async ({ world }) => {
			const keys = world.page
				.getByRole("toolbar", { name: "Terminal keys" })
				.getByRole("button");
			expect(
				await keys.evaluateAll((buttons) =>
					buttons.map((button) => button.getAttribute("aria-label")),
				),
			).toEqual([
				"Paste, flick up for Copy",
				"Copy",
				"Escape, flick up for Tab",
				"Tab",
				"Control, flick up for Command",
				"Command",
				"Option, flick up for Shift",
				"Shift",
				"Left arrow",
				"Up arrow",
				"Down arrow",
				"Right arrow",
				"Keyboard",
			]);
		},
	},
	{
		name: "tap a phone terminal key",
		match: /^I tap the (\w+) terminal key$/,
		run: async ({ world, match }) => {
			await (await touchKey(world.page, match[1] ?? "")).lift();
		},
	},
	{
		name: "flick a phone terminal key",
		match: /^I flick up on the (\w+) terminal key( and hold)?$/,
		run: async ({ world, match }) => {
			const finger = await touchKey(world.page, match[1] ?? "");
			await finger.flick();
			if (match[2]) heldFingers.set(world.page, finger);
			else await finger.lift();
		},
	},
	{
		name: "lift the held finger",
		match: /^I lift my finger$/,
		run: async ({ world }) => {
			await heldFingers.get(world.page)?.lift();
			heldFingers.delete(world.page);
		},
	},
	{
		name: "assert the flick bubble",
		match: /^the flick bubble shows (\w+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator(".flick-bubble")).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert the keyboard toggle",
		match: /^the keyboard is (up|down)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByRole("button", { name: "Keyboard", exact: true }),
			).toHaveAttribute("aria-pressed", String(match[1] === "up"));
		},
	},
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
