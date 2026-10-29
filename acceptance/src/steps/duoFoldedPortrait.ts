import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

/** The rail's controls, found by what they are, not by where the rail put them. */
const railControls: Record<string, string> = {
	Settle: "[data-testid='session-bar-settle']",
	More: "[data-testid='session-bar-island-overflow']",
	Send: "#send",
	Stop: "#stop",
	Permissions: "[data-testid='permission-mode-badge']",
	Model: "[data-testid='model-picker-trigger']",
	Attach: "#attach-btn",
	New: "#new-session-btn",
	Select: "[data-testid='list-bar-select']",
	Theme: "[data-testid='list-bar-theme']",
	Settings: "[data-testid='list-bar-settings']",
};
const RAIL_LEFT = 396;
const SLOT = 44;
/** The status column: camera, island and glyphs, worst case with two Live Activities. */
const STATUS_COLUMN = { left: 394, bottom: 253 };
/** iOS draws its 5pt home bar 8pt above the screen's bottom edge. */
const HOME_INDICATOR_FROM_BOTTOM = 13;
const INTERACTIVE =
	'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(page: Page, selector: string): Promise<Box> {
	const box = await page.locator(selector).boundingBox();
	if (!box) throw new Error(`${selector} is not laid out`);
	return box;
}

/** Every rendered interactive element's box, keyed by a readable name. */
function interactiveBoxes(
	page: Page,
	within: string,
): Promise<{ name: string; box: Box }[]> {
	return page.locator(within).evaluate((root, selector) => {
		return [root, ...root.querySelectorAll(selector)]
			.filter((element) => element.matches(selector))
			.filter((element) =>
				element.checkVisibility({
					visibilityProperty: true,
					opacityProperty: true,
				}),
			)
			.map((element) => {
				const { x, y, width, height } = element.getBoundingClientRect();
				const name = element.id
					? `#${element.id}`
					: (element.getAttribute("data-testid") ??
						element.getAttribute("aria-label") ??
						element.outerHTML.slice(0, 80));
				return { name, box: { x, y, width, height } };
			})
			.filter(({ box }) => box.width > 0 && box.height > 0);
	}, INTERACTIVE);
}

export const duoFoldedPortraitHandlers: StepHandler[] = [
	{
		name: "nothing tappable under the status column",
		match: /^no control reaches into the status column$/,
		run: async ({ world }) => {
			const intruders = (await interactiveBoxes(world.page, "body"))
				.filter(
					({ box }) =>
						box.x + box.width > STATUS_COLUMN.left &&
						box.y < STATUS_COLUMN.bottom,
				)
				.map(({ name, box }) => `${name} at x${box.x} y${box.y}`);
			expect(intruders).toEqual([]);
		},
	},
	{
		name: "header targets sit low with room below",
		match:
			/^the (session|list) header controls are centred at y (\d+) or lower with (\d+) pixels below$/,
		run: async ({ world, match }) => {
			const header =
				match[1] === "session" ? "#session-bar" : "#sidebar-header";
			const controls = await interactiveBoxes(world.page, header);
			expect(controls.length).toBeGreaterThan(0);
			const misplaced = controls
				.filter(
					({ box }) =>
						box.y + box.height / 2 < Number(match[2]) ||
						box.height / 2 < Number(match[3]),
				)
				.map(({ name, box }) => `${name} at y${box.y}, ${box.height} tall`);
			expect(misplaced).toEqual([]);
		},
	},
	{
		name: "rail slots",
		match: /^the rail reads (.+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			for (const slot of (match[1] ?? "").split(", ")) {
				const [, name = "", top = ""] = /^(\w+) at (\d+)$/.exec(slot) ?? [];
				const selector = railControls[name];
				if (!selector) throw new Error(`Unknown rail slot: ${slot}`);
				const box = await boxOf(page, selector);
				expect({
					name,
					x: box.x,
					y: box.y,
					width: box.width,
					height: box.height,
				}).toEqual({
					name,
					x: RAIL_LEFT,
					y: Number(top),
					width: SLOT,
					height: SLOT,
				});
				const reachable = await page.evaluate(
					({ x, y, selector }) =>
						document.elementFromPoint(x, y)?.closest(selector) !== null,
					{ x: box.x + SLOT / 2, y: box.y + SLOT / 2, selector },
				);
				expect(reachable, `${name} is covered`).toBe(true);
			}
		},
	},
	{
		name: "message field geometry",
		match: /^the message field spans x (\d+) to (\d+) and y (\d+) to (\d+)$/,
		run: async ({ world, match }) => {
			const field = await boxOf(world.page, "#input-row");
			const [left, right, top, bottom] = match.slice(1, 5).map(Number);
			expect({
				left: field.x,
				right: field.x + field.width,
				top: field.y,
				bottom: field.y + field.height,
			}).toEqual({ left, right, top, bottom });
		},
	},
	{
		name: "context hairline reading",
		match: /^the context hairline reads (\d+)% context in (grey|amber)$/,
		run: async ({ world, match }) => {
			const hairline = world.page.getByTestId("context-hairline");
			await expect(hairline).toHaveText(`${match[1]}% context`);
			const amber = match[2] === "amber";
			if (amber) await expect(hairline).toHaveAttribute("data-warning", "true");
			else await expect(hairline).not.toHaveAttribute("data-warning", /.*/);
			const colours = await hairline.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-status-amber)";
				element.append(probe);
				const amberColour = getComputedStyle(probe).color;
				probe.remove();
				return { own: getComputedStyle(element).color, amber: amberColour };
			});
			expect(colours.own === colours.amber).toBe(amber);
		},
	},
	{
		name: "context hairline clears the home indicator",
		match: /^the context hairline ends (\d+) pixels above the home indicator$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const hairline = await boxOf(page, "[data-testid='context-hairline']");
			const height = await page.evaluate(() => innerHeight);
			expect(hairline.y + hairline.height).toBe(
				height - HOME_INDICATOR_FROM_BOTTOM - Number(match[1]),
			);
		},
	},
];
