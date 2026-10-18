import {
	type CDPSession,
	expect,
	type Locator,
	type Page,
} from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const sheets =
	'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]';
const list = (page: Page) =>
	page.getByRole("menu", { name: "Snooze until", exact: true });
const tile = (page: Page) => page.getByTestId("session-ctx-snooze");
const row = (page: Page, id: string) =>
	list(page).locator(`[data-hold-menu-item="${id}"]`);
const gestures = new WeakMap<
	Page,
	{ cdp: CDPSession; start: { x: number; y: number }; scrollTop: number }
>();
const targetSessions = new WeakMap<Page, string>();

async function point(target: Locator) {
	const box = await target.boundingBox();
	if (!box) throw new Error("Snooze touch target is missing");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(page: Page, target: Locator) {
	const at = await point(target);
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ ...at, id: 1 }],
		});
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
	} finally {
		await cdp.detach();
	}
}

function gesture(page: Page) {
	const value = gestures.get(page);
	if (!value) throw new Error("No native snooze touch is active");
	return value;
}

const expectedUntil: Record<string, number | null> = {
	"1h": PINNED_CLOCK_MS + 3_600_000,
	"3h": PINNED_CLOCK_MS + 10_800_000,
	evening: Date.UTC(2026, 0, 1, 18),
	indefinite: null,
	custom: Date.UTC(2026, 0, 3, 14, 30),
};

export const sessionSheetSnoozeHandlers: StepHandler[] = [
	{
		name: "stub snooze result",
		match: /^the snooze relay (accepts|refuses) changes$/,
		run: ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("No session is open");
			targetSessions.set(world.page, sessionId);
			requireRpcControl(world.page).setStubs({
				SnoozeSession: () => {
					if (match[1] === "refuses")
						return Promise.reject(
							new WsRpcError({ message: "Relay unavailable" }),
						);
					return { ok: true as const };
				},
				UnsnoozeSession: () => ({ ok: true as const }),
			});
		},
	},
	{
		name: "open snooze hold tile by tap",
		match: /^I tap the Snooze hold tile$/,
		run: async ({ world }) => {
			await expect(tile(world.page)).toHaveAttribute("data-hold-menu-trigger");
			await tap(world.page, tile(world.page));
		},
	},
	{
		name: "assert sticky snooze list",
		match: /^the snooze times stay open$/,
		run: async ({ world }) => {
			await expect(list(world.page)).toBeVisible();
			await expect(tile(world.page)).toHaveAttribute(
				"data-hold-menu-phase",
				"open",
			);
			await expect(world.page.locator(sheets)).toBeVisible();
		},
	},
	{
		name: "assert snooze choices and resolved times",
		match: /^the snooze choices keep their preset order and resolved times$/,
		run: async ({ world }) => {
			const options = list(world.page).locator("[data-hold-menu-item]");
			expect(
				await options.evaluateAll((nodes) =>
					nodes.map((node) => node.getAttribute("data-hold-menu-item")),
				),
			).toEqual([
				"1h",
				"3h",
				"evening",
				"tomorrow",
				"next-week",
				"pick",
				"indefinite",
			]);
			await expect(row(world.page, "1h")).toContainText("10:41");
			await expect(row(world.page, "3h")).toContainText("12:41");
			await expect(row(world.page, "tomorrow")).toContainText("Fri 9:00");
			await expect(row(world.page, "next-week")).toContainText("Mon 9:00");
			await expect(row(world.page, "indefinite").locator("small")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "choose snooze option",
		match: /^I choose snooze option (1h|3h|evening|pick|indefinite)$/,
		run: async ({ world, match }) => {
			await row(world.page, match[1] ?? "").click();
		},
	},
	{
		name: "assert one snooze request and sheet dismissal",
		match:
			/^exactly one snooze request sets (1h|3h|evening|indefinite|custom) and closes the session sheet$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(request) => request.tag === "SnoozeSession",
			);
			expect(request.payload).toMatchObject({
				sessionId: targetSessions.get(world.page),
				until: expectedUntil[match[1] ?? ""],
			});
			expect(
				rpc.getRequests().filter((request) => request.tag === "SnoozeSession"),
			).toHaveLength(1);
			await expect(world.page.locator(sheets)).toHaveCount(0);
			await expect(world.page.getByTestId("snooze-pick-input")).toHaveCount(0);
		},
	},
	{
		name: "assert snooze success toast",
		match: /^the snooze success toast offers Undo$/,
		run: async ({ world }) => {
			const toast = world.page
				.getByRole("status")
				.filter({ hasText: /Snoozed .+ until / });
			await expect(toast).toBeVisible();
			await expect(toast.getByTestId("toast-action")).toHaveText("Undo");
		},
	},
	{
		name: "undo sheet snooze",
		match: /^I undo the sheet snooze$/,
		run: async ({ world }) => {
			await world.page.getByTestId("toast-action").click();
		},
	},
	{
		name: "assert sheet snooze undo",
		match: /^the snooze undo restores (idle|snoozed|forever)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest((request) =>
				match[1] === "idle"
					? request.tag === "UnsnoozeSession"
					: request.tag === "SnoozeSession" &&
						request.payload["until"] ===
							(match[1] === "forever" ? null : PINNED_CLOCK_MS + 3_600_000),
			);
			expect(request.payload["sessionId"]).toBe(targetSessions.get(world.page));
		},
	},
	{
		name: "keyboard open snooze submenu",
		match: /^I open the Snooze hold tile with ArrowRight$/,
		run: async ({ world }) => {
			await tile(world.page).focus();
			await world.page.keyboard.press("ArrowRight");
		},
	},
	{
		name: "assert snooze keyboard focus",
		match: /^the first snooze time has focus$/,
		run: async ({ world }) => {
			await expect(row(world.page, "1h")).toBeFocused();
		},
	},
	{
		name: "assert disabled snooze is a plain tile",
		match: /^the Snooze tile has no hold menu or hint$/,
		run: async ({ world }) => {
			await expect(tile(world.page)).not.toHaveAttribute(
				"data-hold-menu-trigger",
			);
			await expect(
				tile(world.page).getByText("hold", { exact: true }),
			).toHaveCount(0);
			await expect(list(world.page)).toHaveCount(0);
		},
	},
	{
		name: "assert expanded snooze date picker",
		match: /^the snooze date and time field is open$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("snooze-pick-input")).toBeVisible();
			await expect(world.page.getByTestId("snooze-pick-submit")).toBeDisabled();
			await expect(list(world.page)).toHaveCount(0);
		},
	},
	{
		name: "submit a custom snooze time",
		match: /^I enter a future snooze date and time$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("snooze-pick-input")
				.fill("2026-01-03T14:30");
			await world.page.getByTestId("snooze-pick-submit").click();
		},
	},
	{
		name: "assert snooze failure toast",
		match: /^the snooze error toast is visible$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByText(/Couldn't snooze session/),
			).toBeVisible();
		},
	},
	{
		name: "hold snooze with native touch",
		match: /^I hold the Snooze tile with a native touch$/,
		run: async ({ world }) => {
			const page = world.page;
			const start = await point(tile(page));
			const cdp = await page.context().newCDPSession(page);
			const scrollTop = await page
				.locator(sheets)
				.locator("[data-sheet-body]")
				.evaluate((node) => node.scrollTop);
			gestures.set(page, { cdp, start, scrollTop });
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ ...start, id: 1 }],
			});
			await expect(tile(page)).toHaveAttribute(
				"data-hold-menu-phase",
				"following",
			);
		},
	},
	{
		name: "slide native snooze touch",
		match: /^I slide the held touch to snooze option (evening|1h)$/,
		run: async ({ world, match }) => {
			const target = row(world.page, match[1] ?? "");
			await gesture(world.page).cdp.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ ...(await point(target)), id: 1 }],
			});
			await expect(target).toHaveAttribute("data-followed", "true");
		},
	},
	{
		name: "move snooze touch off list",
		match: /^I slide the held touch off the snooze list$/,
		run: async ({ world }) => {
			const { cdp, start } = gesture(world.page);
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ ...start, id: 1 }],
			});
			await expect(list(world.page).locator("[data-followed]")).toHaveCount(0);
		},
	},
	{
		name: "assert snooze slide suppresses scroll and sheet drag",
		match: /^the held snooze gesture has not scrolled or dragged the sheet$/,
		run: async ({ world }) => {
			const sheet = world.page.locator(sheets);
			await expect(sheet.locator("[data-sheet-body]")).toHaveJSProperty(
				"scrollTop",
				gesture(world.page).scrollTop,
			);
			expect(
				await sheet.evaluate((node) => (node as HTMLElement).style.transform),
			).toBe("");
		},
	},
	{
		name: "release native snooze touch",
		match: /^I release the held snooze touch$/,
		run: async ({ world }) => {
			const { cdp } = gesture(world.page);
			try {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			} finally {
				await cdp.detach();
				gestures.delete(world.page);
			}
		},
	},
	{
		name: "assert no snooze write",
		match: /^no snooze request has been sent$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "SnoozeSession"),
			).toHaveLength(0);
		},
	},
	{
		name: "dismiss only snooze times",
		match: /^I tap outside the snooze list$/,
		run: async ({ world }) => {
			await tap(world.page, world.page.getByTestId("session-sheet-header"));
		},
	},
	{
		name: "assert parent sheet survives snooze dismissal",
		match: /^only the snooze list closes$/,
		run: async ({ world }) => {
			await expect(list(world.page)).toHaveCount(0);
			await expect(world.page.locator(sheets)).toBeVisible();
		},
	},
	{
		name: "assert snooze dimming",
		match: /^the snooze list leaves the header clear and footer dimmed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("session-sheet-header")).toHaveCSS(
				"opacity",
				"1",
			);
			await expect(
				world.page.locator(sheets).locator("[data-sheet-footer]"),
			).toHaveCSS("opacity", "0.28");
			await expect(
				world.page.locator(sheets).locator("[data-hold-menu-dim]"),
			).toHaveCSS("opacity", "0.28");
		},
	},
	{
		name: "short viewport for native sheet scrolling",
		match: /^the session sheet viewport is short$/,
		run: async ({ world }) => {
			await world.page.setViewportSize({ width: 393, height: 480 });
		},
	},
	{
		name: "swipe from snooze before hold opens",
		match: /^I swipe up from the Snooze tile before the hold threshold$/,
		run: async ({ world }) => {
			const start = await point(tile(world.page));
			const cdp = await world.page.context().newCDPSession(world.page);
			try {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ ...start, id: 1 }],
				});
				for (let step = 1; step <= 8; step++) {
					await cdp.send("Input.dispatchTouchEvent", {
						type: "touchMove",
						touchPoints: [{ x: start.x, y: start.y - step * 12, id: 1 }],
					});
					await world.page.waitForTimeout(20);
				}
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
				await world.page.waitForTimeout(500);
			} finally {
				await cdp.detach();
			}
		},
	},
	{
		name: "assert native snooze swipe scrolls",
		match: /^the sheet scrolls without opening snooze times$/,
		run: async ({ world }) => {
			await expect(list(world.page)).toHaveCount(0);
			await expect(world.page.locator(sheets)).toBeVisible();
			await expect
				.poll(() =>
					world.page
						.locator(sheets)
						.locator("[data-sheet-body]")
						.evaluate((node) => node.scrollTop),
				)
				.toBeGreaterThan(0);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "SnoozeSession"),
			).toHaveLength(0);
		},
	},
];
