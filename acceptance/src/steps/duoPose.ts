import { expect, type Page } from "@playwright/test";
import type { Viewport } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";

/** Measured on the device (Duo Probe, iOS 27, standalone, dpr 3). */
const DUO_POSES = {
	"folded portrait": { width: 466, height: 657, top: 0, right: 84 },
	"folded landscape": { width: 678, height: 445, top: 0, right: 84 },
	"unfolded landscape": { width: 951, height: 648, top: 0, right: 84 },
	"unfolded portrait": { width: 669, height: 930, top: 61, right: 0 },
};

/**
 * The only stub in the pose path: Chromium cannot emulate (display-mode:
 * standalone), so the page gets iOS's navigator.standalone instead. The init
 * script covers later navigations, the evaluate the page already loaded. A
 * string, because tsx names functions with a helper the page does not have.
 */
async function installAsPwa(page: Page): Promise<void> {
	const stub =
		'Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true })';
	await page.addInitScript(stub);
	await page.evaluate(stub);
}

export const duoPoseHandlers: StepHandler[] = [
	{
		name: "set a measured Duo pose",
		match:
			/^the viewport is a duo (folded portrait|folded landscape|unfolded landscape|unfolded portrait)( in a Safari tab)?$/,
		run: async ({ world, match }) => {
			const pose = match[1] as keyof typeof DUO_POSES;
			const { width, height, top, right } = DUO_POSES[pose];
			if (!match[2]) await installAsPwa(world.page);
			await world.driver.setViewport(world.page, {
				name: `duo-${pose.replace(" ", "-")}`,
				width,
				height,
				insets: { top, right, bottom: 34, left: 0 },
			} satisfies Viewport);
		},
	},
	{
		name: "set an installed landscape iPhone",
		match:
			/^the viewport is an installed landscape iPhone with (\d+)pt side insets$/,
		run: async ({ world, match }) => {
			const side = Number(match[1]);
			await installAsPwa(world.page);
			await world.driver.setViewport(world.page, {
				name: "iphone-landscape",
				width: 852,
				height: 393,
				insets: { top: 0, right: side, bottom: 21, left: side },
			});
		},
	},
	{
		name: "open the keyboard",
		match: /^the keyboard opens, taking (\d+) pixels of the visual viewport$/,
		run: async ({ world, match }) => {
			// iOS shrinks only the visual viewport for the keyboard. Chromium cannot
			// shorten it alone, so zoom in until it is that much shorter: the layout
			// viewport stays put and visualViewport fires resize, as on the device.
			const page = world.page;
			const height = await page.evaluate(() => innerHeight);
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setPageScaleFactor", {
				pageScaleFactor: height / (height - Number(match[1])),
			});
			await expect
				.poll(() =>
					page.evaluate(() => Math.round(visualViewport?.height ?? 0)),
				)
				.toBe(height - Number(match[1]));
		},
	},
	{
		name: "assert the layout pose",
		match: /^the layout pose is ([a-z-]+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#layout")).toHaveAttribute(
				"data-pose",
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert compact layout",
		match: /^the layout is (compact|wide)$/,
		run: async ({ world, match }) => {
			const layout = world.page.locator("#layout");
			if (match[1] === "compact")
				await expect(layout).toHaveClass(/\blayout-compact\b/);
			else await expect(layout).not.toHaveClass(/\blayout-compact\b/);
		},
	},
];
