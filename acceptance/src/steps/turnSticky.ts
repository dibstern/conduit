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
const barStates = new WeakMap<Page, string | null>();
const scrollPositions = new WeakMap<Page, number>();

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
			root.getBoundingClientRect().top + root.clientTop,
			chrome?.getBoundingClientRect().bottom ?? 0,
		);
	});
}

export const turnStickyHandlers: StepHandler[] = [
	{
		name: "open phone chrome before collapsing a fitting transcript",
		match: /^I open and remember the phone bar$/,
		run: async ({ world }) => {
			const bar = world.page.locator("#session-bar");
			if ((await bar.getAttribute("data-collapsed")) === "true")
				await bar.getByRole("button", { name: /expand/i }).click();
			await expect(bar).toHaveAttribute("data-collapsed", "false");
		},
	},
	{
		name: "assert bottom clamping does not close phone chrome",
		match:
			/^the collapsed transcript fits its viewport and preserves the phone bar$/,
		run: async ({ world }) => {
			await expect(panel(world.page)).toHaveAttribute("data-minimised", "true");
			await expect
				.poll(() =>
					world.page
						.locator("#messages")
						.evaluate((root) => root.scrollHeight - root.clientHeight),
				)
				.toBe(0);
			await expect(world.page.locator("#session-bar")).toHaveAttribute(
				"data-collapsed",
				"false",
			);
		},
	},
	{
		name: "follow before a pin reveal",
		match: /^I follow the bottom before picking the tall pin$/,
		run: async ({ world }) => {
			await world.page.locator("#messages").evaluate((root) => {
				root.scrollTop = root.scrollHeight;
			});
			await expect(world.page.getByTestId("jump-to-latest")).toBeHidden();
		},
	},
	{
		name: "assert pin reveal survives later detail feed content",
		match: /^the tall selected card stays revealed through a detail update$/,
		run: async ({ world }) => {
			const page = world.page;
			const card = panel(page).getByTestId("surfacing-msg-card");
			await expect(card.locator(".card-head")).toBeInViewport({ ratio: 1 });
			const top = await page
				.locator("#messages")
				.evaluate((root) => root.scrollTop);
			requireRpcControl(page).setDetailRows(
				"sess-surfacing",
				(fixtures.get(page) ?? [])
					.map((message) => ({
						...message,
						parts: message.parts?.map((part) =>
							part.id === "surfacing-final"
								? {
										...part,
										text: "A new detail arrived after selecting the tall card.",
									}
								: part,
						),
					}))
					.flatMap(detailRowsOf),
			);
			await expect(
				page.locator("#messages .msg-assistant").last(),
			).toContainText("A new detail arrived");
			await expect(page.getByTestId("jump-to-latest")).toBeVisible();
			await expect(card.locator(".card-head")).toBeInViewport({ ratio: 1 });
			expect(
				await page.locator("#messages").evaluate((root) => root.scrollTop),
			).toBeCloseTo(top, 0);
		},
	},
	{
		name: "cover an unread card with the sticky head",
		match: /^I hide the unread selected card behind the stuck head$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.clock.install({ time: PINNED_CLOCK_MS });
			await page.clock.pauseAt(PINNED_CLOCK_MS + 1000);
			const messages = (fixtures.get(page) ?? []).map((message) => ({
				...message,
				parts: message.parts?.map((part) => ({
					...part,
					surfacingRead: false,
				})),
			}));
			requireRpcControl(page).setDetailRows(
				"sess-surfacing",
				messages.flatMap(detailRowsOf),
			);
			const card = panel(page).getByTestId("surfacing-msg-card");
			await expect(card).toHaveAttribute("data-ordinal", "56");
			await expect(page.getByTestId("surfacing-read-toggle")).not.toBeChecked();
			const top = await transcriptTop(page);
			const height = (await head(page).boundingBox())?.height;
			if (!height) throw new Error("Missing sticky head");
			await card.evaluate(
				(node, bottom) => {
					const root = node.closest("#messages");
					if (!root) throw new Error("Missing transcript");
					root.scrollTop += node.getBoundingClientRect().bottom - bottom;
				},
				top + height - 1,
			);
			await page.clock.runFor(32);
			await card.evaluate((node) => {
				const root = node.closest("#messages");
				const head = node
					.closest(".turn-head-card")
					?.querySelector(".turn-activity-head");
				if (!root || !head) throw new Error("Missing stuck head");
				root.scrollTop +=
					node.getBoundingClientRect().bottom -
					head.getBoundingClientRect().bottom +
					1;
			});
			await page.clock.runFor(32);
			const box = await card.boundingBox();
			const controls = await head(page).boundingBox();
			if (!box || !controls) throw new Error("Missing covered card geometry");
			expect(box.y + box.height).toBeGreaterThan(controls.y);
			expect(box.y + box.height).toBeLessThanOrEqual(
				controls.y + controls.height,
			);
			expect(
				await card.evaluate((node) => {
					const box = node.getBoundingClientRect();
					return node.contains(
						document.elementFromPoint(
							box.left + box.width / 2,
							box.top + box.height / 2,
						),
					);
				}),
			).toBe(false);
			await expect(card).toBeInViewport({ ratio: 1 });
		},
	},
	{
		name: "assert occluded card does not accrue read dwell",
		match: /^dwell does not mark the covered card read$/,
		run: async ({ world }) => {
			await world.page.clock.runFor(1200);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "SetMessagesRead"),
			).toHaveLength(0);
		},
	},
	{
		name: "expose the unread card below sticky chrome",
		match: /^I expose the covered card below the stuck head$/,
		run: async ({ world }) => {
			await world.page.locator("#messages").evaluate((root) => {
				root.scrollTop = 0;
			});
			await world.page.clock.runFor(32);
			await expect(
				panel(world.page).getByTestId("surfacing-msg-card"),
			).toBeInViewport({ ratio: 1 });
		},
	},
	{
		name: "assert exposed card accrues a new read dwell",
		match: /^dwell marks the exposed card read$/,
		run: async ({ world }) => {
			await world.page.clock.runFor(1200);
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.filter((request) => request.tag === "SetMessagesRead")
						.map((request) => request.payload),
				)
				.toEqual([
					{
						_tag: "SetMessagesRead",
						sessionId: "sess-surfacing",
						partIds: ["surfacing-part-56"],
						read: true,
					},
				]);
		},
	},
	{
		name: "remember a fully visible card at scroll zero",
		match:
			/^I remember the fully visible card position at the transcript start$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.locator("#messages").evaluate((root) => {
				root.scrollTop = 0;
			});
			const card = await panel(page)
				.getByTestId("surfacing-msg-card")
				.boundingBox();
			const controls = await head(page).boundingBox();
			const root = await page.locator("#messages").boundingBox();
			if (!card || !controls || !root)
				throw new Error("Missing visible card geometry");
			expect(card.y).toBeGreaterThanOrEqual(controls.y + controls.height);
			expect(card.y + card.height).toBeLessThanOrEqual(root.y + root.height);
			scrollPositions.set(
				page,
				await page.locator("#messages").evaluate((node) => node.scrollTop),
			);
		},
	},
	{
		name: "assert a visible pin reveal does not scroll",
		match: /^the fully visible selected card has not moved the transcript$/,
		run: async ({ world }) => {
			await world.page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			expect(
				await world.page
					.locator("#messages")
					.evaluate((root) => root.scrollTop),
			).toBe(scrollPositions.get(world.page));
			await expect(
				panel(world.page).getByTestId("surfacing-msg-card"),
			).toBeInViewport({ ratio: 1 });
		},
	},
	{
		name: "assert no empty space before the plain log",
		match: /^the plain log starts immediately below the turn controls$/,
		run: async ({ world }) => {
			const controls = await head(world.page).boundingBox();
			const log = await panel(world.page).locator(".step-log").boundingBox();
			if (!controls || !log) throw new Error("Missing plain log geometry");
			expect(log.y - controls.y - controls.height).toBeLessThanOrEqual(1);
		},
	},
	{
		name: "remember phone bar presentation",
		match: /^I remember the phone bar state$/,
		run: async ({ world }) => {
			barStates.set(
				world.page,
				await world.page.locator("#session-bar").getAttribute("data-collapsed"),
			);
		},
	},
	{
		name: "assert collapse preserves phone bar presentation",
		match: /^the phone bar state is unchanged$/,
		run: async ({ world }) => {
			const previous = barStates.get(world.page);
			if (previous == null) return;
			await expect(world.page.locator("#session-bar")).toHaveAttribute(
				"data-collapsed",
				previous,
			);
		},
	},
	{
		name: "assert selected message clearance below turn controls",
		match: /^the selected message header is exposed below the turn head$/,
		run: async ({ world }) => {
			const page = world.page;
			const card = panel(page).getByTestId("surfacing-msg-card");
			await expect(card.locator(".card-head")).toBeInViewport({ ratio: 1 });
			await expect
				.poll(async () => {
					const box = await card.boundingBox();
					const controls = await head(page).boundingBox();
					return box && controls
						? box.y - controls.y - controls.height
						: -Infinity;
				})
				.toBeGreaterThanOrEqual(6);
			const caret = panel(page).locator(".turn-card-caret");
			await expect
				.poll(async () => {
					const box = await caret.boundingBox();
					const controls = await head(page).boundingBox();
					return box && controls
						? box.y - controls.y - controls.height
						: -Infinity;
				})
				.toBeGreaterThanOrEqual(0);
		},
	},
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
			/^the sticky session has a long expanded turn followed by a (long|short) reply$/,
		run: async ({ world, match }) => {
			const messages = surfacingHistory("dense").map((message) => ({
				...message,
				parts: message.parts?.map((part) =>
					part.id === "surfacing-final" && match[1] === "long"
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
		match:
			/^the sticky turn has a long (selected message|first message|summary)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const text = Array.from(
				{ length: 30 },
				(_, i) =>
					`Analysis paragraph ${i + 1}. The routing review found another detail to explain.`,
			).join("\n\n");
			if (match[1] !== "summary") {
				const messages = (fixtures.get(page) ?? []).map((message) => ({
					...message,
					parts: message.parts?.map((part) =>
						(part.id === "surfacing-part-56" && match[1] !== "first message") ||
						part.id === "surfacing-part-1"
							? { ...part, text }
							: part,
					),
				}));
				fixtures.set(page, messages);
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
			if (match[1] === "first message") {
				await openFullLog(page);
				return;
			}
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
			await expect
				.poll(
					async () =>
						((await head(page).boundingBox())?.y ?? Infinity) -
						(await transcriptTop(page)),
				)
				.toBeCloseTo(0, 0);
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
			await expect
				.poll(
					async () =>
						((await collapse.boundingBox())?.y ?? -Infinity) -
						(await transcriptTop(page)),
				)
				.toBeGreaterThanOrEqual(0);
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
			await expect
				.poll(
					async () =>
						((await head(page).boundingBox())?.y ?? Infinity) -
						(await transcriptTop(page)),
				)
				.toBeCloseTo(0, 0);
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
