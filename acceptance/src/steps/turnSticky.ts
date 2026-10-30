import { expect, type Page } from "@playwright/test";
import { Stream } from "effect";
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
import { chooseShowStop } from "./turnActivityShow.js";

const panel = (page: Page) => page.locator("#messages .turn-activity").first();
const head = (page: Page) => panel(page).locator(".turn-activity-head");
const fixtures = new WeakMap<Page, (typeof HistoryMessageSchema.Type)[]>();

async function openFullLog(page: Page) {
	await expect(panel(page)).toBeVisible();
	const expand = panel(page).getByRole("button", {
		name: "Expand turn",
		exact: true,
	});
	if (await expand.count()) await expand.click();
	if (await panel(page).getByTestId("surfacing-level").count())
		await chooseShowStop(page, "Full log");
	await expect(panel(page).locator(".step-log")).toBeVisible();
	await expect(page.locator("#connect-overlay")).toBeHidden();
}

async function transcriptTop(page: Page) {
	return page.locator("#messages").evaluate((root) => {
		const chrome = document.querySelector("#session-chrome");
		return Math.max(
			root.getBoundingClientRect().top +
				Number.parseFloat(getComputedStyle(root).paddingTop),
			chrome?.getBoundingClientRect().bottom ?? 0,
		);
	});
}

export const turnStickyHandlers: StepHandler[] = [
	{
		name: "reveal a work row from the stuck strip preview",
		match: /^I open the first work step from the stuck strip$/,
		run: async ({ world }) => {
			await head(world.page)
				.locator('[data-step-id="surfacing-agent/surfacing-tool-1"]')
				.hover();
			await panel(world.page).getByTestId("turn-step-popover").click();
		},
	},
	{
		name: "assert strip navigation exposes its highlighted row",
		match: /^the highlighted work row is exposed below the stuck head$/,
		run: async ({ world }) => {
			const row = panel(world.page).locator(
				'[data-log-part="surfacing-agent/surfacing-tool-1"]',
			);
			await expect(row).toBeFocused();
			await expect(row).toBeInViewport();
			await expect
				.poll(async () => {
					const box = await row.boundingBox();
					const controls = await head(world.page).boundingBox();
					return box && controls
						? box.y - controls.y - controls.height
						: -Infinity;
				})
				.toBeGreaterThanOrEqual(0);
			expect(
				await row.evaluate((node) => {
					const box = node.getBoundingClientRect();
					return node.contains(
						document.elementFromPoint(
							box.left + box.width / 2,
							box.top + box.height / 2,
						),
					);
				}),
			).toBe(true);
		},
	},
	{
		name: "seed a long expanded turn with room to scroll beyond it",
		match:
			/^the sticky session has a long expanded turn followed by a long reply$/,
		run: async ({ world }) => {
			const messages = surfacingHistory("dense").map((message) => ({
				...message,
				parts: message.parts?.map((part) =>
					part.id === "surfacing-final"
						? {
								...part,
								text: Array.from(
									{ length: 90 },
									(_, i) => `Reply paragraph ${i + 1}. The review is complete.`,
								).join("\n\n"),
							}
						: part,
				),
			}));
			fixtures.set(world.page, messages);
			requireRpcControl(world.page).setDetailRows(
				"sess-surfacing",
				messages.flatMap(detailRowsOf),
			);
			setSessionRowStatus(world.page, "sess-surfacing", "idle", {
				title: "Long turn sticky acceptance",
				accountId: "claude",
			});
			await openSessionRoute(world.page, "sess-surfacing");
			await openFullLog(world.page);
		},
	},
	{
		name: "seed long inline content ahead of the full log",
		match: /^the sticky turn has a long (selected message|summary)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const text = Array.from(
				{ length: 30 },
				(_, i) =>
					`Analysis paragraph ${i + 1}. The routing review found another detail to explain.`,
			).join("\n\n");
			if (match[1] === "selected message") {
				const messages = (fixtures.get(page) ?? []).map((message) => ({
					...message,
					parts: message.parts?.map((part) =>
						part.id === "surfacing-part-56" ? { ...part, text } : part,
					),
				}));
				requireRpcControl(page).setDetailRows(
					"sess-surfacing",
					messages.flatMap(detailRowsOf),
				);
			} else {
				const previous = mockMessageSurfacing.get(page);
				if (!previous) throw new Error("Missing surfacing fixture");
				const status = {
					...previous,
					summariesEnabled: true,
					recap: { model: "sonnet", when: "on-request" },
				} as const;
				mockMessageSurfacing.set(page, status);
				const recap = {
					sessionId: "sess-surfacing",
					turnId: "surfacing-user",
					version: 1,
					scope: "whole",
					firstOrdinal: 1,
					lastOrdinal: 56,
					text,
					model: "sonnet",
					durationMs: 1600,
					createdAt: PINNED_CLOCK_MS - 1000,
				} as const;
				requireRpcControl(page).setStubs({
					GetMessageSurfacing: () => status,
					ListRecaps: () => [recap],
					SubscribeRecaps: () =>
						Stream.succeed({
							versions: [recap],
							generating: false,
							error: null,
						}),
				});
			}
			await page.reload();
			const content = panel(page).getByTestId(
				match[1] === "selected message"
					? "surfacing-msg-card"
					: "surfacing-summary",
			);
			await expect(content).toContainText("Analysis paragraph 30");
			await openFullLog(page);
			const contentBox = await content.boundingBox();
			const root = await page.locator("#messages").boundingBox();
			if (!contentBox || !root) throw new Error("Missing long inline content");
			expect(contentBox.height).toBeGreaterThan(root.height);
		},
	},
	{
		name: "assert the log can be read beneath the pinned controls",
		match: /^log rows are exposed below the stuck head$/,
		run: async ({ world }) => {
			const root = await world.page.locator("#messages").boundingBox();
			const box = await head(world.page).boundingBox();
			if (!root || !box) throw new Error("Missing sticky geometry");
			expect(box.y + box.height).toBeLessThan(root.y + root.height - 100);
			expect(
				await world.page.evaluate(
					({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".step-log"),
					{ x: root.x + root.width / 2, y: box.y + box.height + 100 },
				),
			).toBe(true);
		},
	},
	{
		name: "scroll to the point where the turn starts releasing its head",
		match:
			/^I scroll until the turn pushes its head slightly above the transcript top$/,
		run: async ({ world }) => {
			const top = await transcriptTop(world.page);
			await panel(world.page)
				.locator(".turn-head-card")
				.evaluate((card, top) => {
					const root = card.closest("#messages");
					const head = card.querySelector(".turn-activity-head");
					if (!root || !head) throw new Error("Missing releasing head");
					root.scrollTop +=
						card.getBoundingClientRect().bottom -
						top -
						head.getBoundingClientRect().height +
						5;
				}, top);
		},
	},
	{
		name: "assert the partly released head can still be collapsed",
		match: /^the releasing head still has a clickable collapse control$/,
		run: async ({ world }) => {
			const top = await transcriptTop(world.page);
			const box = await head(world.page).boundingBox();
			if (!box) throw new Error("Missing releasing head");
			expect(box.y).toBeLessThan(top - 1);
			expect(box.y).toBeGreaterThan(top - 10);
			const button = panel(world.page).getByRole("button", {
				name: "Collapse turn",
				exact: true,
			});
			await expect(button).toBeInViewport({ ratio: 1 });
			await button.click({ trial: true });
		},
	},
	{
		name: "scroll well into the long turn log",
		match: /^I scroll into the middle of the long turn log$/,
		run: async ({ world }) => {
			const page = world.page;
			const top = await transcriptTop(page);
			await panel(page)
				.locator(".step-log")
				.evaluate((log, top) => {
					const root = log.closest("#messages");
					if (!root) throw new Error("Missing transcript");
					if (log.clientHeight < root.clientHeight * 2)
						throw new Error("The test needs a log taller than two viewports");
					root.scrollTop +=
						log.getBoundingClientRect().top + log.clientHeight / 2 - top;
				}, top);
		},
	},
	{
		name: "assert the head is pinned below transcript chrome",
		match:
			/^the turn head and strip stay at the transcript top with the collapse control visible$/,
		run: async ({ world }) => {
			const page = world.page;
			const top = await transcriptTop(page);
			await expect
				.poll(async () => (await head(page).boundingBox())?.y)
				.toBeCloseTo(top, 0);
			const collapse = panel(page).getByRole("button", {
				name: "Collapse turn",
				exact: true,
			});
			await expect(collapse).toBeInViewport({ ratio: 1 });
			await expect(
				head(page).locator('[aria-label^="Activity timeline"]'),
			).toBeInViewport({ ratio: 1 });
			const button = await collapse.boundingBox();
			if (!button) throw new Error("Missing collapse control");
			expect(button.y).toBeGreaterThanOrEqual(top);
			// A log row must not paint over the control or intercept its click.
			expect(
				await collapse.evaluate((node) => {
					const box = node.getBoundingClientRect();
					return node.contains(
						document.elementFromPoint(
							box.left + box.width / 2,
							box.top + box.height / 2,
						),
					);
				}),
			).toBe(true);
		},
	},
	{
		name: "assert hover cards still paint and receive input above the log",
		match:
			/^the stuck strip keeps its (active|inactive) hover previews usable$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await head(page)
				.locator('[data-step-id="surfacing-agent/surfacing-tool-1"]')
				.hover();
			const popover = panel(page).getByTestId("turn-step-popover");
			await expect(popover).toBeInViewport({ ratio: 1 });
			await expect(popover).toContainText("Step 2 of 112");
			expect(
				await popover.evaluate((node) => {
					const box = node.getBoundingClientRect();
					return node.contains(
						document.elementFromPoint(
							box.left + box.width / 2,
							box.top + box.height / 2,
						),
					);
				}),
			).toBe(true);
			await page.mouse.move(0, 0);
			if (match[1] === "active") {
				await head(page).getByTestId("surfacing-pin-1").hover();
				await expect(
					panel(page).getByTestId("surfacing-hover-preview"),
				).toBeInViewport({ ratio: 1 });
				await expect(
					panel(page).getByTestId("surfacing-hover-preview"),
				).toHaveAttribute("data-ordinal", "1");
			}
		},
	},
	{
		name: "collapse using the visible stuck control without auto-scrolling",
		match: /^I collapse the stuck turn$/,
		run: async ({ world }) => {
			const box = await panel(world.page)
				.getByRole("button", { name: "Collapse turn", exact: true })
				.boundingBox();
			if (!box) throw new Error("Missing stuck collapse control");
			await world.page.mouse.click(
				box.x + box.width / 2,
				box.y + box.height / 2,
			);
			await world.page.mouse.move(0, 0);
		},
	},
	{
		name: "assert collapse preserves the turn at the reading position",
		match:
			/^the collapsed turn stays in view at the transcript top without a gap$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect(panel(page)).toHaveAttribute("data-minimised", "true");
			await expect(panel(page).locator(".step-log")).toHaveCount(0);
			await expect(
				panel(page).getByRole("button", { name: "Expand turn", exact: true }),
			).toBeInViewport({ ratio: 1 });
			const top = await transcriptTop(page);
			await expect
				.poll(async () => (await head(page).boundingBox())?.y)
				.toBeCloseTo(top, 0);
			const box = await panel(page).boundingBox();
			const reply = await page
				.locator("#messages .msg-assistant")
				.last()
				.boundingBox();
			if (!box || !reply) throw new Error("Missing collapsed turn or reply");
			expect(reply.y - (box.y + box.height)).toBeLessThan(60);
		},
	},
	{
		name: "scroll beyond the turn into its final reply",
		match: /^I scroll past the long turn$/,
		run: async ({ world }) => {
			const top = await transcriptTop(world.page);
			await panel(world.page).evaluate((turn, top) => {
				const root = turn.closest("#messages");
				if (!root) throw new Error("Missing transcript");
				root.scrollTop += turn.getBoundingClientRect().bottom - top + 50;
			}, top);
		},
	},
	{
		name: "assert the head is bounded by its turn",
		match:
			/^the long turn head and its collapse control are outside the transcript viewport$/,
		run: async ({ world }) => {
			const top = await transcriptTop(world.page);
			await expect
				.poll(async () => {
					const box = await head(world.page).boundingBox();
					return box ? box.y + box.height : Infinity;
				})
				.toBeLessThanOrEqual(top);
			await expect(
				panel(world.page).getByRole("button", {
					name: "Collapse turn",
					exact: true,
				}),
			).not.toBeInViewport();
		},
	},
];
