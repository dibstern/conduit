import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { settleTransitions } from "./shared.js";

/**
 * Where iOS draws the camera, Dynamic Island and status glyphs in each pose,
 * in CSS px of the pose's layout viewport; each zone runs to the right edge.
 * The folded landscape emulation insets the right edge, so its zone is the
 * mirrored one at the bottom right; the other orientation, with the inset on
 * the left, keeps x22-74 clear above y138.
 */
const KEEP_CLEAR: Record<
	string,
	{ left: number; top: number; bottom: number }
> = {
	"duo-folded-portrait": { left: 394, top: 0, bottom: 253 },
	"duo-folded-landscape": { left: 604, top: 328, bottom: Infinity },
	"duo-unfolded-landscape": { left: 873, top: 0, bottom: 191 },
	"duo-unfolded-portrait": { left: 465, top: 0, bottom: 79 },
};

/** Each header drop-down's trigger, found by what it is. */
const DROP_DOWNS: Record<string, string> = {
	tasks: "[data-testid='background-tasks-row']",
	goal: "[data-testid='session-goal-subtitle']",
	"Side Threads": "[data-testid='side-threads-control']",
	sessions: "#session-bar-more",
	skills: "[data-testid='session-skills-chip']",
};

const TOP_SHEET = "[data-sheet-edge='top']";
const FLOATING = `[data-testid='toast'], ${TOP_SHEET}, [data-testid$='scrim']`;

type Box = { left: number; top: number; right: number; bottom: number };

/** The bottom edge of the header on screen: the session's, or the list's. */
const headerBottom = (page: Page): Promise<number> =>
	page.evaluate(() => {
		const header = ["session-bar", "sidebar-header"]
			.map((id) => document.getElementById(id))
			.find((element) => element?.getClientRects().length);
		if (!header) throw new Error("No header is on screen");
		return header.getBoundingClientRect().bottom;
	});

const boxes = (page: Page, selector: string): Promise<Box[]> =>
	page.locator(selector).evaluateAll((elements) =>
		elements.map((element) => {
			const { left, top, right, bottom } = element.getBoundingClientRect();
			return { left, top, right, bottom };
		}),
	);

export const duoAlertsHandlers: StepHandler[] = [
	{
		name: "open a header drop-down",
		match: /^I open the (tasks|goal|Side Threads|sessions|skills) drop-down$/,
		run: async ({ world, match }) => {
			await world.page.locator(DROP_DOWNS[match[1] ?? ""] ?? "").click();
			await expect(
				world.page.locator("[aria-expanded='true']"),
			).not.toHaveCount(0);
			await settleTransitions(world.page);
		},
	},
	{
		name: "assert the toast stack under the header",
		match:
			/^(\d) toasts stack 8 pixels under the header, newest on top, at most 400 pixels wide and centred between x (\d+) and x (\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const count = Number(match[1]);
			const centre = (Number(match[2]) + Number(match[3])) / 2;
			// Polled: cards drop in, and the stack reflows as each one arrives.
			await expect
				.poll(async () => {
					const cards = await boxes(page, "[data-testid='toast']");
					const header = await headerBottom(page);
					return cards.map((card, index) => ({
						gap: Math.round(card.top - (cards[index - 1]?.bottom ?? header)),
						offCentre: Math.round((card.left + card.right) / 2 - centre),
						narrow: card.right - card.left <= 400,
					}));
				})
				.toEqual(
					Array.from({ length: count }, (_, index) => ({
						gap: index === 0 ? 8 : 6,
						offCentre: 0,
						narrow: true,
					})),
				);
		},
	},
	{
		name: "assert the newest toast",
		match: /^the top toast says (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("toast").first()).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert a top sheet under the header",
		match:
			/^the drop-down hangs from the header's bottom edge across x (\d+) to (\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await expect(page.locator(TOP_SHEET)).toBeVisible();
			await settleTransitions(page);
			const [sheet] = await boxes(page, TOP_SHEET);
			expect(sheet?.top).toBeCloseTo(await headerBottom(page), 0);
			expect(sheet?.left).toBeCloseTo(Number(match[1]), 0);
			expect(sheet?.right).toBeCloseTo(Number(match[2]), 0);
		},
	},
	{
		name: "assert an anchored popover, not a sheet",
		match: /^the drop-down is anchored to its control, not a sheet$/,
		run: async ({ world }) => {
			await expect(world.page.locator("[data-sheet-edge]")).toHaveCount(0);
		},
	},
	{
		name: "assert floating layers clear the keep-clear zone",
		match: /^no toast, sheet or scrim covers the status glyphs$/,
		run: async ({ world }) => {
			const page = world.page;
			const pose =
				(await page.locator("#layout").getAttribute("data-pose")) ?? "";
			const zone = KEEP_CLEAR[pose];
			if (!zone) throw new Error(`${pose} is not a Duo pose`);
			const intrusions = (await boxes(page, FLOATING)).filter(
				(box) =>
					box.right > zone.left + 0.5 &&
					box.bottom > zone.top + 0.5 &&
					box.top < zone.bottom - 0.5,
			);
			expect(intrusions).toEqual([]);
		},
	},
];
