import { expect, type Page } from "@playwright/test";
import { Stream } from "effect";
import type { MessageSurfacingStatus } from "../../../src/lib/contracts/message-surfacing.js";
import type { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockMessageSurfacing,
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { surfacingHistory } from "./surfacingCard.js";

type History = typeof HistoryMessageSchema.Type;
const SESSION = "sess-surfacing";
const fixtures = new WeakMap<Page, History[]>();
const modes = {
	Expanded: "expanded",
	Auto: "auto",
	Minimised: "minimised",
} as const;
const panel = (page: Page, turn: string) =>
	page.locator(`.turn-activity[data-turn-id="surfacing-user-${turn}/user"]`);

function publish(page: Page, messages: History[]) {
	fixtures.set(page, messages);
	requireRpcControl(page).setDetailRows(
		SESSION,
		messages.flatMap(detailRowsOf),
	);
}

export const surfacingMinimiseHandlers: StepHandler[] = [
	{
		name: "seed Turns open and theme",
		match:
			/^minimising uses the (dark|light) theme with Turns open (Expanded|Auto|Minimised)$/,
		run: async ({ world, match }) => {
			const previous = mockMessageSurfacing.get(world.page);
			if (!previous) throw new Error("Seed surfacing first");
			const status: MessageSurfacingStatus = {
				...previous,
				turnsOpen: modes[match[2] as keyof typeof modes],
			};
			mockMessageSurfacing.set(world.page, status);
			requireRpcControl(world.page).setStubs({
				GetMessageSurfacing: () =>
					mockMessageSurfacing.get(world.page) ?? status,
				ListRecaps: () => [],
				SubscribeRecaps: () =>
					Stream.succeed({ versions: [], generating: false, error: null }),
			});
			await world.page.evaluate(
				(theme) => localStorage.setItem("conduit-theme", theme),
				match[1] ?? "dark",
			);
			await world.page.reload();
		},
	},
	{
		name: "seed two settled turns and a live turn",
		match: /^the minimising session has three turns$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.clock.install({ time: PINNED_CLOCK_MS });
			await page.clock.pauseAt(PINNED_CLOCK_MS + 1_000);
			const messages = [1, 2, 3].flatMap((number) =>
				surfacingHistory(number === 3 ? "live" : "settled").map((message) => ({
					...message,
					id: `${message.id}-${number}`,
					time: {
						created:
							(message.time?.created ?? PINNED_CLOCK_MS) +
							(number - 3) * 100_000,
						...(message.time?.completed !== undefined
							? { completed: message.time.completed + (number - 3) * 100_000 }
							: {}),
					},
					...(message["parentID"]
						? { parentID: `${message["parentID"]}-${number}` }
						: {}),
					parts: message.parts?.map((part) => ({
						...part,
						id: `${part.id}-${number}`,
						time:
							typeof part.time === "object" && part.time !== null
								? Object.fromEntries(
										Object.entries(part.time).map(([key, value]) => [
											key,
											typeof value === "number"
												? value + (number - 3) * 100_000
												: value,
										]),
									)
								: part.time,
						...(part.type === "text" && part.surfacingOrdinal !== undefined
							? { surfacingRead: number !== 3 }
							: {}),
					})),
				})),
			);
			publish(page, messages);
			setSessionRowStatus(page, SESSION, "busy", {
				title: "Turn minimising acceptance",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(page, SESSION);
			await expect(panel(page, "3")).toBeVisible();
		},
	},
	{
		name: "minimise via the head chevron",
		match: /^I minimise turn (\d+) by chevron$/,
		run: async ({ world, match }) => {
			// The visual capture waits a frame, which a paused clock never paints.
			await world.page.clock.resume();
			await panel(world.page, match[1] ?? "")
				.getByRole("button", { name: "Minimise turn", exact: true })
				.click();
			await world.page.mouse.move(0, 0);
		},
	},
	{
		name: "toggle the focused turn with h",
		match: /^I toggle turn (\d+) with h$/,
		run: async ({ world, match }) => {
			await panel(world.page, match[1] ?? "")
				.getByTestId("surfacing-card")
				.focus();
			await world.page.keyboard.press("h");
		},
	},
	{
		name: "assert minimised turn contents and thin geometry",
		match: /^turn (\d+) is minimised with a 4px strip$/,
		run: async ({ world, match }) => {
			const scope = panel(world.page, match[1] ?? "");
			await expect(scope).toHaveAttribute("data-minimised", "true");
			await expect(
				scope.getByRole("button", { name: "Expand turn", exact: true }),
			).toHaveAttribute("aria-expanded", "false");
			for (const id of [
				"surfacing-pins",
				"surfacing-msg-card",
				"surfacing-axis",
				"surfacing-summary",
			])
				await expect(scope.getByTestId(id)).toHaveCount(0);
			await expect(scope.locator(".step-log")).toHaveCount(0);
			await expect(scope.locator(".surface-axis")).toHaveCount(0);
			await expect(scope.getByTestId("surfacing-thin-track")).toHaveCSS(
				"height",
				"4px",
			);
			await expect(scope.locator("[data-step-id]").first()).toHaveCSS(
				"height",
				"4px",
			);
			await expect(scope.getByTestId("surfacing-head-unread")).toBeVisible();
			await expect(
				scope.getByTestId("surfacing-summary-generate"),
			).toBeVisible();
		},
	},
	{
		name: "assert expansion and optional selected message",
		match: /^turn (\d+) is expanded(?: on message (\d+))?$/,
		run: async ({ world, match }) => {
			const scope = panel(world.page, match[1] ?? "");
			await expect(scope).toHaveAttribute("data-minimised", "false");
			await expect(
				scope.getByRole("button", { name: "Minimise turn", exact: true }),
			).toHaveAttribute("aria-expanded", "true");
			if (match[2])
				await expect(scope.getByTestId("surfacing-msg-card")).toHaveAttribute(
					"data-ordinal",
					match[2],
				);
		},
	},
	{
		name: "reload with a different global default",
		match:
			/^I reload the minimising session with Turns open (Expanded|Auto|Minimised)$/,
		run: async ({ world, match }) => {
			const previous = mockMessageSurfacing.get(world.page);
			if (!previous) throw new Error("Missing surfacing settings");
			mockMessageSurfacing.set(world.page, {
				...previous,
				turnsOpen: modes[match[1] as keyof typeof modes],
			});
			await world.page.reload();
			await expect(panel(world.page, "3")).toBeVisible();
		},
	},
	{
		name: "point at a message by its actual strip position",
		match: /^I (hover|click|tap) the strip at message 1 in turn (\d+)$/,
		run: async ({ world, match }) => {
			const scope = panel(world.page, match[2] ?? "");
			await scope.scrollIntoViewIfNeeded();
			const box = await scope
				.locator('[data-step-id^="surfacing-agent-"]')
				.first()
				.boundingBox();
			if (!box) throw new Error("Missing activity segment");
			const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			if (match[1] === "hover") {
				await world.page.clock.resume();
				await world.page.mouse.move(point.x, point.y);
			} else if (match[1] === "click")
				await world.page.mouse.click(point.x, point.y);
			else {
				// The shared context has no hasTouch flag; CDP still sends native touch.
				const cdp = await world.page.context().newCDPSession(world.page);
				try {
					await cdp.send("Input.dispatchTouchEvent", {
						type: "touchStart",
						touchPoints: [point],
					});
					await cdp.send("Input.dispatchTouchEvent", {
						type: "touchEnd",
						touchPoints: [],
					});
				} finally {
					await cdp.detach();
				}
			}
			await world.page.clock.runFor(32);
		},
	},
	{
		name: "assert one-line peek without opening the turn",
		match: /^turn (\d+) peeks at message 1 with Click to open$/,
		run: async ({ world, match }) => {
			const scope = panel(world.page, match[1] ?? "");
			await expect(scope).toHaveAttribute("data-minimised", "true");
			const peek = scope.getByTestId("surfacing-minimised-peek");
			await expect(peek).toBeInViewport();
			await expect(peek).toHaveCSS("white-space", "nowrap");
			await expect(peek).toHaveAttribute("data-ordinal", "1");
			await expect(peek).toContainText(
				"The routing table has three consumers.",
			);
			await expect(peek).toContainText("Click to open");
		},
	},
	{
		name: "change hidden message read state through the detail feed",
		match: /^message (\d+) in turn (\d+) becomes (read|unread)$/,
		run: ({ world, match }) => {
			publish(
				world.page,
				(fixtures.get(world.page) ?? []).map((message) => ({
					...message,
					parts: message.parts?.map((part) =>
						part.id === `surfacing-part-${match[1]}-${match[2]}`
							? { ...part, surfacingRead: match[3] === "read" }
							: part,
					),
				})),
			);
		},
	},
	{
		name: "retain every unread dot and the open Ask ring",
		match: /^the minimised turn keeps its unread and open Ask dots$/,
		run: async ({ world }) => {
			const scope = panel(world.page, "3");
			await expect(scope.getByTestId("surfacing-minimised-unread")).toHaveCount(
				7,
			);
			await expect(scope.getByTestId("surfacing-minimised-ask")).toHaveCount(1);
			await expect(scope.getByTestId("surfacing-ask-chip")).toHaveText("? #2");
		},
	},
	{
		name: "open a destination from a minimised head or keyboard",
		match: /^I open turn 3 by (unread|u|Ask)$/,
		run: async ({ world, match }) => {
			const scope = panel(world.page, "3");
			if (match[1] === "u") {
				await scope.getByTestId("surfacing-card").focus();
				await world.page.keyboard.press("u");
			} else
				await scope
					.getByTestId(
						match[1] === "Ask" ? "surfacing-ask-chip" : "surfacing-head-unread",
					)
					.click();
			await world.page.clock.runFor(32);
		},
	},
];
