import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { headerTargetMisses } from "./shared.js";

/** The rail's controls, found by what they are, not by where the rail put them. */
export const railControls: Record<string, string> = {
	Settle: "[data-testid='session-bar-settle']",
	More: "[data-testid='session-bar-island-overflow']",
	Send: "#send",
	Stop: "#stop",
	Permissions: "[data-testid='permission-mode-badge']",
	Model: "[data-testid='model-picker-trigger']",
	Attach: "#attach-btn",
	Effort: "[data-testid='variant-badge']",
	Directory: "[data-testid='composer-checkout']",
	New: "#new-session-btn",
	Select: "[data-testid='list-bar-select']",
	Theme: "[data-testid='list-bar-theme']",
	Settings: "[data-testid='list-bar-settings']",
};
export const RAIL_LEFT = 396;
export const SLOT = 44;
/** The status column: camera, island and glyphs, worst case with two Live Activities. */
const STATUS_COLUMN = { left: 394, bottom: 253 };
/** The home bar's top edge: y665 on the 678pt screen, 8pt below the 657pt viewport. */
const HOME_INDICATOR_BELOW_VIEWPORT = 8;
export const INTERACTIVE =
	'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

type Box = { x: number; y: number; width: number; height: number };

export async function boxOf(page: Page, selector: string): Promise<Box> {
	const box = await page.locator(selector).boundingBox();
	if (!box) throw new Error(`${selector} is not laid out`);
	return box;
}

/** An icon's size, and how far its centre sits from its slot's, 0 within 1px. */
async function iconInSlot(page: Page, slot: string, icon: string) {
	const outer = await boxOf(page, slot);
	const inner = await page.locator(slot).locator(icon).boundingBox();
	if (!inner) throw new Error(`${slot} ${icon} is not laid out`);
	const off = (a: number, b: number) =>
		Math.abs(a - b) <= 1 ? 0 : Math.round((a - b) * 10) / 10;
	return {
		width: Math.round(inner.width),
		height: Math.round(inner.height),
		offCentreX: off(inner.x + inner.width / 2, outer.x + outer.width / 2),
		offCentreY: off(inner.y + inner.height / 2, outer.y + outer.height / 2),
	};
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
			expect(await interactiveBoxes(world.page, header)).not.toEqual([]);
			expect(
				await headerTargetMisses(
					world.page,
					`${header} :is(${INTERACTIVE})`,
					Number(match[2]),
					Number(match[3]),
				),
			).toEqual([]);
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
		name: "bare rail icons",
		match:
			/^the rail's (.+) sit bare, each icon (\d+) px and centred in its slot$/,
		run: async ({ world, match }) => {
			const size = Number(match[2]);
			for (const name of (match[1] ?? "").split(" and ")) {
				const icon = {
					Permissions: "svg",
					Model: "[data-testid='harness-logo']",
				}[name];
				if (!icon) throw new Error(`No bare rail icon: ${name}`);
				const slot = railControls[name] ?? "";
				await expect(world.page.locator(slot)).toHaveCSS(
					"background-color",
					"rgba(0, 0, 0, 0)",
				);
				expect({ name, ...(await iconInSlot(world.page, slot, icon)) }).toEqual(
					{ name, width: size, height: size, offCentreX: 0, offCentreY: 0 },
				);
			}
		},
	},
	{
		name: "goal icon alone in Send's slot",
		match: /^Send shows the goal icon alone, centred in its slot$/,
		run: async ({ world }) => {
			const send = world.page.locator("#send");
			await expect(send).toHaveAttribute("data-goal", "true");
			await expect(send).toHaveText("");
			const { offCentreX, offCentreY } = await iconInSlot(
				world.page,
				"#send",
				"svg.lucide-target",
			);
			expect({ offCentreX, offCentreY }).toEqual({
				offCentreX: 0,
				offCentreY: 0,
			});
		},
	},
	{
		name: "session filters clear the list header",
		match: /^the session filters start (\d+) pixels below the list header$/,
		run: async ({ world, match }) => {
			const header = await boxOf(world.page, "#sidebar-header");
			const filters = await boxOf(world.page, "#session-search > :first-child");
			expect(filters.y - (header.y + header.height)).toBe(Number(match[1]));
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
				height + HOME_INDICATOR_BELOW_VIEWPORT - Number(match[1]),
			);
		},
	},
];
