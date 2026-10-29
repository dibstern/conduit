import { expect, type Page } from "@playwright/test";
import { WS_PROTOCOL_VERSION } from "../../../src/lib/shared-types.js";
import type { StepHandler } from "../runtime.js";
import { installAsPwa } from "./duoPose.js";
import { requireRpcControl } from "./shared.js";

/** The controls on each header's first row, and every control in each header. */
const HEADERS = {
	session: {
		row: "#session-bar-back, #session-bar-meta button, #session-bar-more",
		all: "#session-bar button",
	},
	list: { row: "#sidebar-header button", all: "#sidebar-header button" },
};
type Header = keyof typeof HEADERS;

const INTERACTIVE =
	'a[href], button, input, select, textarea, summary, [contenteditable="true"], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"]';

type Box = { top: number; bottom: number; left: number; right: number };

const visibleBoxes = (page: Page, selector: string): Promise<Box[]> =>
	page.locator(selector).evaluateAll((elements) =>
		elements
			.map((element) => element.getBoundingClientRect())
			.filter((rect) => rect.width > 0)
			.map(({ top, bottom, left, right }) => ({ top, bottom, left, right })),
	);

export const duoUnfoldedPortraitHandlers: StepHandler[] = [
	{
		name: "announce a build waiting for a restart",
		match: /^a new conduit build is waiting for a restart$/,
		run: ({ world }) => {
			// The running build ("dev") stays current, so the page does not reload.
			requireRpcControl(world.page).setDaemonList("SubscribeServerStatus", {
				protocolVersion: WS_PROTOCOL_VERSION,
				buildId: "dev",
				restartAvailable: true,
				sessionsRevision: 0,
			});
		},
	},
	{
		name: "see the server update banner in the list",
		match: /^the list shows the server-update banner$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator('#sidebar [data-banner-id="server-update"]'),
			).toBeVisible();
		},
	},
	{
		name: "set an installed portrait iPhone",
		match: /^the viewport is an installed iPhone with a (\d+)pt top inset$/,
		run: async ({ world, match }) => {
			await installAsPwa(world.page);
			await world.driver.setViewport(world.page, {
				name: "iphone-installed",
				width: 393,
				height: 852,
				insets: { top: Number(match[1]), right: 0, bottom: 34, left: 0 },
			});
		},
	},
	{
		name: "assert a header row's centre line and end",
		match:
			/^the (session|list) header row is centred on y (\d+) and ends at x (\d+)$/,
		run: async ({ world, match }) => {
			const header = match[1] as Header;
			const page = world.page;
			await page.locator(HEADERS[header].row).first().waitFor();
			const boxes = await visibleBoxes(page, HEADERS[header].row);
			expect(boxes.length).toBeGreaterThan(0);
			for (const { top, bottom } of boxes)
				expect((top + bottom) / 2).toBeCloseTo(Number(match[2]), 0);
			expect(Math.max(...boxes.map((box) => box.right))).toBeCloseTo(
				Number(match[3]),
				0,
			);
		},
	},
	{
		name: "assert the session title line and divider",
		match:
			/^the session title starts at y (\d+) and the divider sits at y (\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const title = await page.locator("#session-bar-title").boundingBox();
			const bar = await page.locator("#session-bar").boundingBox();
			expect(title?.y).toBeCloseTo(Number(match[1]), 0);
			// The bottom border is the bar's last pixel row.
			expect((bar?.y ?? 0) + (bar?.height ?? 0) - 1).toBeCloseTo(
				Number(match[2]),
				0,
			);
		},
	},
	{
		name: "assert header targets sit low enough to aim at",
		match:
			/^every (session|list) header control is centred at y (\d+) or lower with at least (\d+) pixels of hit area below it$/,
		run: async ({ world, match }) => {
			const header = match[1] as Header;
			const [minCentre, below] = [Number(match[2]), Number(match[3])];
			const misses = await world.page.locator(HEADERS[header].all).evaluateAll(
				(controls, { minCentre, below }) =>
					controls.flatMap((control) => {
						const rect = control.getBoundingClientRect();
						if (rect.width === 0) return [];
						const x = rect.left + rect.width / 2;
						const y = rect.top + rect.height / 2;
						const label = control.getAttribute("aria-label") ?? control.id;
						if (y < minCentre - 0.5) return [`${label} centred at y ${y}`];
						// The band's last pixel row; hit testing rounds to whole pixels.
						const hit = document.elementFromPoint(x, y + below - 1);
						return hit?.closest("button") === control
							? []
							: [
									`${label} has under ${below}px of hit area below y ${y}: ${hit?.id || hit?.tagName} is there`,
								];
					}),
				{ minCentre, below },
			);
			expect(misses).toEqual([]);
		},
	},
	{
		name: "assert nothing tappable in the status row's keep-clear zone",
		match:
			/^no control reaches into the keep-clear zone from x (\d+) rightwards and y (\d+) upwards$/,
		run: async ({ world, match }) => {
			const intrusions = await world.page.evaluate(
				({ left, bottom, interactive }) => {
					const found = new Map<Element, string>();
					for (let y = 0; y <= bottom; y++)
						for (let x = left; x < innerWidth; x++) {
							const control = document
								.elementFromPoint(x, y)
								?.closest(interactive);
							if (control && !found.has(control))
								found.set(
									control,
									`${control.getAttribute("aria-label") || control.id || control.tagName} at ${x},${y}`,
								);
						}
					return [...found.values()];
				},
				{
					left: Number(match[1]),
					bottom: Number(match[2]),
					interactive: INTERACTIVE,
				},
			);
			expect(intrusions).toEqual([]);
		},
	},
];
