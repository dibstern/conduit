import { expect, type Page } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

const sheetSelector =
	'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]';

const heldSettles = new WeakMap<
	Page,
	{ url: string; release(): Promise<void> }
>();

/** Holds a touch on a session-list row until its phone sheet opens. */
export async function longPressSessionRow(
	page: Page,
	sessionId: string,
): Promise<void> {
	const row = page.locator(
		`#session-list .session-item[data-session-id="${sessionId}"]`,
	);
	const box = await row.boundingBox();
	if (!box) throw new Error("Session row is not visible");
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
		});
		await expect(page.locator(sheetSelector)).toBeVisible();
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
	} finally {
		await cdp.detach();
	}
}

export const sessionSheetsHandlers: StepHandler[] = [
	{
		name: "hold settle reply",
		match: /^the settle reply is held as (success|failure)$/,
		run: ({ world, match }) => {
			const page = world.page;
			const rpc = requireRpcControl(page);
			let resolve!: () => void;
			const pending = new Promise<void>((done) => {
				resolve = done;
			});
			let delivered = false;
			const previous = rpc.onReply;
			rpc.onReply = (request) => {
				previous?.(request);
				if (request.tag === "SetSessionSettled") delivered = true;
			};
			rpc.setStubs({
				SetSessionSettled: async ({ sessionId, settled }) => {
					expect(settled).toBe(true);
					await pending;
					if (match[1] === "failure")
						throw new WsRpcError({ message: "Relay unavailable" });
					setSessionRowStatus(page, sessionId, "idle", {
						settledAt: PINNED_CLOCK_MS,
					});
					return { ok: true };
				},
			});
			heldSettles.set(page, {
				url: page.url(),
				release: async () => {
					resolve();
					await expect.poll(() => delivered).toBe(true);
					await page.evaluate(
						() =>
							new Promise<void>((done) =>
								requestAnimationFrame(() =>
									requestAnimationFrame(() => done()),
								),
							),
					);
				},
			});
		},
	},
	{
		name: "settle from open session",
		match:
			/^I settle the open session using (header|overflow|shortcut|transcript key)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const sessionId = new URL(page.url()).pathname.split("/")[2];
			if (match[1] === "header") {
				await page.getByTestId("session-bar-settle").click();
			} else if (match[1] === "overflow") {
				await page
					.locator(
						'[data-testid="session-bar-island-overflow"], [data-testid="session-bar-overflow"]',
					)
					.click();
				await page.getByTestId("session-ctx-settle").click();
			} else if (match[1] === "transcript key") {
				await page.locator("#messages").focus();
				await page.keyboard.press("s");
			} else {
				await page.keyboard.press("ControlOrMeta+Shift+s");
			}
			const request = await requireRpcControl(page).waitForRequest(
				(request) => request.tag === "SetSessionSettled",
			);
			expect(request.payload).toMatchObject({ sessionId, settled: true });
		},
	},
	{
		name: "release settle reply",
		match: /^the held settle reply is released$/,
		run: async ({ world }) => {
			const held = heldSettles.get(world.page);
			if (!held) throw new Error("No held settle reply");
			await held.release();
		},
	},
	{
		name: "open session while settle is pending",
		match:
			/^I open (another session while settling|the settling session before the reply)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const held = heldSettles.get(page);
			if (!held) throw new Error("No held settle reply");
			if (match[1] === "another session while settling") {
				setSessionRowStatus(page, "ses_settle_other", "idle", {
					title: "Another session",
					projectSlug: "myapp",
				});
				await page.getByTestId("session-bar-back").click();
			}
			await page
				.locator(
					'#session-list .session-item[data-session-id="ses_settle_other"]',
				)
				.click();
			await expect(page).toHaveURL(/\/s\/ses_settle_other$/);
			held.url = page.url();
		},
	},
	{
		name: "settle another session from sidebar",
		match:
			/^I settle another session using the (row key|bulk bar|phone sheet|phone bulk bar)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			setSessionRowStatus(page, "ses_settle_other", "idle", {
				title: "Another session",
				projectSlug: "myapp",
			});
			const row = page.locator(
				'#session-list .session-item[data-session-id="ses_settle_other"]',
			);
			if (match[1] === "row key") {
				await row.focus();
				await page.keyboard.press("s");
			} else {
				if (match[1]?.startsWith("phone"))
					await longPressSessionRow(page, "ses_settle_other");
				else await row.click({ button: "right" });
				if (match[1] === "phone sheet")
					await page.getByTestId("session-ctx-settle").click();
				else {
					await page.getByTestId("session-ctx-select").click();
					await page.getByTestId("select-bar-settle").click();
				}
			}
			const request = await requireRpcControl(page).waitForRequest(
				(request) => request.tag === "SetSessionSettled",
			);
			expect(request.payload).toMatchObject({
				sessionId: "ses_settle_other",
				settled: true,
			});
		},
	},
	{
		name: "set desktop sidebar",
		match: /^the desktop sidebar is (open|closed)$/,
		run: async ({ world, match }) => {
			const layout = world.page.locator("#layout");
			if (match[1] === "open")
				return expect(layout).not.toHaveClass(/sidebar-collapsed/);
			await world.page.locator("#sidebar-toggle-btn").click();
			await expect(layout).toHaveClass(/sidebar-collapsed/);
		},
	},
	{
		name: "assert new draft with desktop sidebar open",
		match: /^a new draft opens with the desktop sidebar open$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect.poll(() => new URL(page.url()).pathname).toBe("/");
			await expect(page.getByTestId("draft-empty")).toBeVisible();
			await expect(page.locator("#layout")).not.toHaveClass(
				/sidebar-collapsed/,
			);
			await expect(page.locator("#sidebar-panel-sessions")).toBeVisible();
		},
	},
	{
		name: "assert settle keeps open session",
		match: /^the viewed session stays open$/,
		run: async ({ world }) => {
			const url = heldSettles.get(world.page)?.url;
			if (!url) throw new Error("No held settle reply");
			await expect(world.page).toHaveURL(url);
			await expect(world.page.getByTestId("session-bar")).toBeVisible();
		},
	},
	{
		name: "assert settle error",
		match: /^settling shows the relay error$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByText("Couldn't settle session Relay unavailable", {
					exact: true,
				}),
			).toBeVisible();
		},
	},
	{
		name: "clear session sheet branch",
		match: /^the session sheet branch is unknown$/,
		run: async ({ world }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("No session is open");
			setSessionRowStatus(world.page, sessionId, "idle", {
				title: "Session without a branch",
				git: undefined,
			});
		},
	},
	{
		name: "assert unknown branch sheet header",
		match: /^the session sheet header identifies the session without a branch$/,
		run: async ({ world }) => {
			const header = world.page
				.locator(sheetSelector)
				.getByTestId("session-sheet-header");
			await expect(header).toContainText("Session without a branch");
			await expect(header.getByTestId("session-sheet-branch")).toHaveCount(0);
			await expect(header.getByTestId("session-sheet-close")).toBeVisible();
		},
	},
	{
		name: "assert phone view cards",
		match: /^the session sheet shows four view cards$/,
		run: async ({ world }) => {
			const sheet = world.page.locator(sheetSelector);
			const cards = sheet.locator("[data-view-card]");
			await expect(cards).toHaveCount(4);
			const boxes = await cards.evaluateAll((nodes) =>
				nodes.map((node) => {
					const { top, width, height } = node.getBoundingClientRect();
					return { top, width, height };
				}),
			);
			expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
			for (const box of boxes) {
				expect(box.width).toBeGreaterThanOrEqual(44);
				expect(box.height).toBeGreaterThanOrEqual(44);
			}
			await expect(sheet.getByTestId("overflow-view-chat")).toHaveAttribute(
				"aria-checked",
				"true",
			);
			await expect(sheet.getByTestId("overflow-view-diff")).toHaveAttribute(
				"aria-disabled",
				"true",
			);
			await expect(sheet.locator(".shortcut-hint")).toHaveCount(0);
		},
	},
	{
		name: "close phone session sheet",
		match: /^I close the session sheet with its close button$/,
		run: async ({ world }) => {
			await world.page
				.locator(sheetSelector)
				.getByTestId("session-sheet-close")
				.click();
		},
	},
	{
		name: "assert phone session sheet closed",
		match: /^no session sheet is open$/,
		run: async ({ world }) => {
			await expect(world.page.locator(sheetSelector)).toHaveCount(0);
		},
	},
	{
		name: "assert overflow trigger focus",
		match: /^the session overflow trigger has focus$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("session-bar-island-overflow"),
			).toBeFocused();
		},
	},
	{
		name: "set session sheet theme",
		match: /^the session sheet theme is (light|dark)$/,
		run: async ({ world, match }) => {
			await world.page.addInitScript(
				(theme) => localStorage.setItem("conduit-theme", theme),
				match[1] ?? "dark",
			);
		},
	},
	{
		name: "seed phone session sheet state",
		match:
			/^the phone session sheet state is (idle|unread|snoozed|forever|pinned|settled|auto_off)$/,
		run: async ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("No session is open");
			const state = match[1];
			const fields = {
				...(state === "pinned" ? { pinnedAt: PINNED_CLOCK_MS - 60_000 } : {}),
				...(state === "settled" ? { settledAt: PINNED_CLOCK_MS - 60_000 } : {}),
				...(state === "snoozed" || state === "forever"
					? { snoozedAt: PINNED_CLOCK_MS - 60_000 }
					: {}),
				...(state === "snoozed"
					? { snoozedUntil: PINNED_CLOCK_MS + 3_600_000 }
					: {}),
				unread: state === "unread",
				attention: state === "unread" ? "done-unread" : "idle",
				autoSettleDisabled: state === "auto_off",
			} satisfies Partial<SessionInfo>;
			setSessionRowStatus(world.page, sessionId, "idle", fields);
			requireRpcControl(world.page).setStubs({
				GetSessionAutoSettleOutlook: () => {
					if (state === "auto_off") return { kind: "off" as const };
					if (state === "settled") return { kind: "settled" as const };
					if (state === "pinned" || state === "unread")
						return { kind: "paused" as const, reason: state };
					if (state === "snoozed" || state === "forever")
						return { kind: "paused" as const, reason: "snoozed" as const };
					return {
						kind: "scheduled" as const,
						at: PINNED_CLOCK_MS + 2 * 86_400_000,
					};
				},
				SetSessionAutoSettle: ({ disabled }) => {
					setSessionRowStatus(world.page, sessionId, "idle", {
						autoSettleDisabled: disabled,
					});
					return { kind: disabled ? ("off" as const) : ("never" as const) };
				},
			});
		},
	},
	{
		name: "open phone session sheet",
		match: /^I open the (overflow|list) session sheet$/,
		run: async ({ world, match }) => {
			if (match[1] === "list") {
				const sessionId = new URL(world.page.url()).pathname.split("/")[2];
				await world.page.getByTestId("session-bar-back").click();
				if (!sessionId) throw new Error("No session is open");
				await longPressSessionRow(world.page, sessionId);
			} else {
				await world.page.getByTestId("session-bar-island-overflow").click();
			}
			await expect(world.page.locator(sheetSelector)).toBeVisible();
		},
	},
	{
		name: "assert shared session sheet layout",
		match: /^the session sheet has the shared grids and (5|6) Session tiles$/,
		run: async ({ world, match }) => {
			const sheet = world.page.locator(sheetSelector);
			await expect(sheet.getByTestId("session-sheet-header")).toBeVisible();
			const triage = sheet.getByRole("group", { name: "Triage", exact: true });
			const session = sheet.getByRole("group", {
				name: "Session",
				exact: true,
			});
			const auto = sheet.getByTestId("session-ctx-auto-settle");
			await expect(triage).toBeVisible();
			await expect(auto).toBeVisible();
			await expect(session).toBeVisible();
			const tiles = session.locator("[data-menu-tile]");
			await expect(tiles).toHaveCount(Number(match[1]));
			await expect(tiles.first()).toHaveCSS("height", "72px");
			const tops = await tiles.evaluateAll((nodes) =>
				nodes.map((node) => node.getBoundingClientRect().top),
			);
			expect(new Set(tops).size).toBe(2);
			await expect(tiles.first()).toHaveAttribute(
				"data-testid",
				"session-ctx-archive",
			);
			const triageTiles = triage.locator("[data-menu-tile]");
			await expect(triage.getByTestId("session-ctx-archive")).toHaveCount(0);
			const triageTops = await triageTiles.evaluateAll((nodes) =>
				nodes.map((node) => node.getBoundingClientRect().top),
			);
			expect(new Set(triageTops).size).toBe(1);
			const triageBox = await triage.boundingBox();
			const autoBox = await auto.boundingBox();
			const sessionBox = await session.boundingBox();
			if (!triageBox || !autoBox || !sessionBox)
				throw new Error("Session sheet layout is missing");
			expect(triageBox.y + triageBox.height).toBeLessThanOrEqual(autoBox.y);
			expect(autoBox.y + autoBox.height).toBeLessThanOrEqual(sessionBox.y);
		},
	},
	{
		name: "assert phone session sheet state",
		match:
			/^the session sheet displays the (idle|unread|snoozed|forever|pinned|settled|auto_off) commands$/,
		run: async ({ world, match }) => {
			const sheet = world.page.locator(sheetSelector);
			const state = match[1];
			await expect(
				sheet.getByTestId("session-ctx-auto-settle"),
			).toHaveAttribute(
				"aria-checked",
				state === "auto_off" ? "false" : "true",
			);
			if (state === "settled") {
				await expect(sheet.getByTestId("session-ctx-unsettle")).toBeVisible();
				await expect(sheet.getByTestId("session-ctx-snooze")).toHaveCount(0);
			} else if (state === "snoozed" || state === "forever") {
				await expect(sheet.getByTestId("session-ctx-snooze")).toContainText(
					state === "forever" ? "No timer" : "until",
				);
				await expect(sheet.getByTestId("session-ctx-unsnooze")).toBeVisible();
				await expect(sheet.getByTestId("session-ctx-mark-unread")).toHaveCount(
					0,
				);
			} else if (state === "pinned") {
				await expect(sheet.getByTestId("session-ctx-unpin")).toBeVisible();
				await expect(sheet.getByTestId("session-ctx-settle")).toHaveAttribute(
					"aria-disabled",
					"true",
				);
				await expect(sheet.getByTestId("session-ctx-snooze")).toHaveAttribute(
					"aria-disabled",
					"true",
				);
			} else {
				await expect(
					sheet.getByTestId(
						state === "unread"
							? "session-ctx-mark-read"
							: "session-ctx-mark-unread",
					),
				).toBeVisible();
			}
		},
	},
	{
		name: "assert session sheet footer",
		match:
			/^the session sheet footer is (absent|overflow) with Debug (on|off)$/,
		run: async ({ world, match }) => {
			const sheet = world.page.locator(sheetSelector);
			const footer = sheet.locator("[data-sheet-footer]");
			if (match[1] === "absent") {
				await expect(footer).toHaveCount(0);
				await expect(sheet.locator("[data-sheet-body]")).toHaveCSS(
					"padding-bottom",
					"22px",
				);
				return;
			}
			await expect(footer).toBeVisible();
			await expect(footer.getByTestId("overflow-share")).toHaveAccessibleName(
				"Share",
			);
			await expect(
				footer.getByTestId("overflow-settings"),
			).toHaveAccessibleName("Settings");
			const debug = footer.getByTestId("overflow-debug");
			if (match[2] === "on") {
				await expect(debug).toHaveAccessibleName("Debug panel");
				await expect(debug).toHaveText(/Debug\s*dev/);
			} else await expect(debug).toHaveCount(0);
		},
	},
	{
		name: "tap unavailable session tile",
		match: /^I tap the unavailable Snooze tile$/,
		run: async ({ world }) => {
			const tile = world.page.getByTestId("session-ctx-snooze");
			await expect(tile).toHaveAttribute("aria-disabled", "true");
			await tile.scrollIntoViewIfNeeded();
			const box = await tile.boundingBox();
			if (!box) throw new Error("Unavailable Snooze tile is not visible");
			// This tile accepts taps to explain its disabled state.
			const touch = await world.page.context().newCDPSession(world.page);
			try {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [
						{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
					],
				});
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			} finally {
				await touch.detach();
			}
		},
	},
	{
		name: "assert sheet reason toast floats above the open sheet",
		match: /^the session sheet stays open under the reason toast (.+)$/,
		run: async ({ world, match }) => {
			const sheet = world.page.locator(sheetSelector);
			await expect(sheet).toBeVisible();
			const reason = match[1] ?? "";
			const toast = world.page.getByTestId("toast").filter({ hasText: reason });
			await expect(toast).toHaveText(reason);
			expect(await sheet.getByTestId("toast").count()).toBe(0);
			const calls = requireRpcControl(world.page).getRequests();
			expect(
				calls.filter((request) => request.tag === "SnoozeSession"),
			).toHaveLength(0);
		},
	},
	{
		name: "reject auto-settle change",
		match: /^the relay refuses the auto-settle change$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				SetSessionAutoSettle: () => Promise.reject(new Error("Unavailable")),
			});
		},
	},
	{
		name: "toggle phone sheet auto-settle",
		match: /^I toggle Auto-settle in the session sheet$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-ctx-auto-settle").click();
		},
	},
	{
		name: "assert auto-settle keeps phone sheet open",
		match: /^the session sheet stays open with Auto-settle (on|off)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator(sheetSelector)).toBeVisible();
			await expect(
				world.page.getByTestId("session-ctx-auto-settle"),
			).toHaveAttribute("aria-checked", match[1] === "on" ? "true" : "false");
		},
	},
];
