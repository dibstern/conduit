import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

const controls = {
	"session back button": "[data-testid='session-bar-back']",
	"session overflow button": "[data-testid='session-bar-island-overflow']",
	"list Settings cog": "[data-testid='list-bar-settings']",
	"list Select button": "[data-testid='list-bar-select']",
	"settings Done button": "[data-testid='settings-close-btn']",
	"probe button": "#tap-probe",
	"probe row": "#tap-probe-row",
};
type Control = keyof typeof controls;
const control = `(${Object.keys(controls).join("|")})`;
const sheetSelector =
	'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]';
/** Outlasts the 600ms dedupe window, so a late or doubled click has arrived. */
const settle = (page: Page) =>
	// test-waits-allow real-wait: proving a click never arrives has no condition to await.
	page.waitForTimeout(700);
const fingerTaps = new WeakMap<Page, number>();

async function centreOf(
	page: Page,
	name: Control,
): Promise<{ x: number; y: number }> {
	const box = await page.locator(controls[name]).boundingBox();
	if (!box) throw new Error(`The ${name} is not visible`);
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	// Without this a scenario passes whenever layout drifts and the touch misses.
	const hit = await page.evaluate(
		({ x, y, selector }) =>
			document.elementFromPoint(x, y)?.closest(selector) !== null,
		{ ...point, selector: controls[name] },
	);
	if (!hit) throw new Error(`Something covers the ${name}`);
	return point;
}

/** Pointer events only, as iOS sends near the top of the screen. */
async function liftTouch(
	page: Page,
	name: Control,
	{ moveBy = 0, holdMs = 0, pointerType = "touch" } = {},
): Promise<void> {
	const point = await centreOf(page, name);
	await page.evaluate(
		async ({ x, y, moveBy, holdMs, pointerType }) => {
			const target = document.elementFromPoint(x, y);
			if (!target) throw new Error(`Nothing at ${x},${y}`);
			const sequence: [type: string, clientX: number, waitMs: number][] = [
				["pointerdown", x, 0],
				...(moveBy
					? [["pointermove", x + moveBy, 0] as [string, number, number]]
					: []),
				["pointerup", x + moveBy, holdMs],
			];
			// A touch's implicit capture keeps every event on the pressed element.
			for (const [type, clientX, waitMs] of sequence) {
				// test-waits-allow real-wait: the hold is judged from real event timestamps.
				if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
				target.dispatchEvent(
					new PointerEvent(type, {
						bubbles: true,
						cancelable: true,
						composed: true,
						pointerId: 41,
						pointerType,
						isPrimary: true,
						button: type === "pointermove" ? -1 : 0,
						buttons: type === "pointerup" ? 0 : 1,
						clientX,
						clientY: y,
					}),
				);
			}
		},
		{ ...point, moveBy, holdMs, pointerType },
	);
}

export const headerTapOnLiftHandlers: StepHandler[] = [
	{
		name: "count clicks on a header control",
		match: new RegExp(`^I count clicks on the ${control}$`),
		run: async ({ world, match }) => {
			const name = match[1] as Control;
			await world.page.locator(controls[name]).evaluate((element, name) => {
				const page = window as Window & { tapClicks?: Record<string, number> };
				const counts = (page.tapClicks ??= {});
				counts[name] = 0;
				element.addEventListener("click", () => {
					counts[name] = (counts[name] ?? 0) + 1;
				});
			}, name);
		},
	},
	{
		name: "assert header control click count",
		match: new RegExp(`^the ${control} received (\\d+) clicks?$`),
		run: async ({ world, match }) => {
			await settle(world.page);
			const count = await world.page.evaluate(
				(name) =>
					(window as Window & { tapClicks?: Record<string, number> })
						.tapClicks?.[name],
				match[1] ?? "",
			);
			expect(count).toBe(Number(match[2]));
		},
	},
	{
		name: "lift a touch that never becomes a click",
		match: new RegExp(
			`^I lift a touch on the ${control} that never becomes a click$`,
		),
		run: async ({ world, match }) => {
			await liftTouch(world.page, match[1] as Control);
		},
	},
	{
		name: "lift a touch after moving",
		match: new RegExp(
			`^I lift a touch on the ${control} after moving (\\d+) pixels$`,
		),
		run: async ({ world, match }) => {
			await liftTouch(world.page, match[1] as Control, {
				moveBy: Number(match[2]),
			});
		},
	},
	{
		name: "lift a touch after holding",
		match: new RegExp(
			`^I lift a touch on the ${control} after holding it for (\\d+) milliseconds$`,
		),
		run: async ({ world, match }) => {
			await liftTouch(world.page, match[1] as Control, {
				holdMs: Number(match[2]),
			});
		},
	},
	{
		name: "press a header control with a pen",
		match: new RegExp(`^I press the ${control} with a pen for (\\d+)ms$`),
		run: async ({ world, match }) => {
			await liftTouch(world.page, match[1] as Control, {
				holdMs: Number(match[2]),
				pointerType: "pen",
			});
		},
	},
	{
		name: "tap a header control with a finger",
		match: new RegExp(`^I tap the ${control} with a finger$`),
		run: async ({ world, match }) => {
			const page = world.page;
			const point = await centreOf(page, match[1] as Control);
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setTouchEmulationEnabled", {
				enabled: true,
				maxTouchPoints: 1,
			});
			// Chromium follows this touch with a real click, as iOS does below y64.
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [point],
			});
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchEnd",
				touchPoints: [],
			});
			fingerTaps.set(page, Date.now());
			await cdp.detach();
		},
	},
	{
		name: "click a header control with a mouse",
		match: new RegExp(`^I click the ${control} with a mouse$`),
		run: async ({ world, match }) => {
			await world.page.locator(controls[match[1] as Control]).click();
		},
	},
	{
		name: "press Enter on a header control",
		match: new RegExp(`^I press Enter on the ${control}$`),
		run: async ({ world, match }) => {
			const page = world.page;
			await page.locator(controls[match[1] as Control]).press("Enter");
			const tappedAt = fingerTaps.get(page);
			// Only a key inside the dedupe window proves the window spares keys.
			if (tappedAt !== undefined && Date.now() - tappedAt > 550)
				throw new Error(
					`Enter came ${Date.now() - tappedAt}ms after the tap, outside the window`,
				);
		},
	},
	{
		name: "click a header control with no touch",
		match: new RegExp(`^a click with no touch arrives on the ${control}$`),
		run: async ({ world, match }) => {
			await world.page
				.locator(controls[match[1] as Control])
				.dispatchEvent("click");
		},
	},
	{
		name: "add a probe to the session header",
		match:
			/^the session header holds a (disabled probe button|probe button inside a probe row)$/,
		run: async ({ world, match }) => {
			await world.page.locator("#session-bar").evaluate((bar, disabled) => {
				const button = document.createElement("button");
				button.id = "tap-probe";
				button.type = "button";
				button.textContent = "Probe";
				button.disabled = disabled;
				const row = document.createElement("div");
				row.id = "tap-probe-row";
				row.setAttribute("role", "button");
				row.tabIndex = 0;
				row.style.cssText =
					"position:fixed;top:90px;left:100px;z-index:2147483647;padding:12px;background:#888";
				row.append(button);
				bar.append(disabled ? button : row);
				if (disabled)
					button.style.cssText =
						"position:fixed;top:90px;left:100px;z-index:2147483647;padding:12px";
			}, match[1] === "disabled probe button");
		},
	},
	{
		name: "settings Done covers the list Settings cog",
		match: /^the settings Done button sits over the list Settings cog$/,
		run: async ({ world }) => {
			const done = await world.page
				.locator(controls["settings Done button"])
				.boundingBox();
			const cog = await world.page
				.locator(controls["list Settings cog"])
				.boundingBox();
			if (!done || !cog) throw new Error("Done or the cog is not laid out");
			const x = done.x + done.width / 2;
			const y = done.y + done.height / 2;
			// Otherwise a click left over from Done would land on nothing and prove nothing.
			expect(x >= cog.x && x <= cog.x + cog.width).toBe(true);
			expect(y >= cog.y && y <= cog.y + cog.height).toBe(true);
		},
	},
	{
		name: "settings stays closed",
		match: /^settings stays closed$/,
		run: async ({ world }) => {
			await settle(world.page);
			await expect(
				world.page.getByRole("dialog", { name: "Settings" }),
			).toBeHidden();
		},
	},
	{
		name: "overflow session sheet stays open",
		match: /^the overflow session sheet stays open$/,
		run: async ({ world }) => {
			await settle(world.page);
			await expect(world.page.locator(sheetSelector)).toBeVisible();
		},
	},
	{
		name: "session list is selecting",
		match: /^the session list is selecting$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("button", { name: "Exit selection" }),
			).toBeVisible();
		},
	},
];
