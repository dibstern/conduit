import { expect, type Page } from "@playwright/test";
import type { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockSessionSkills,
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { surfacingHistory } from "./surfacingCard.js";
import { expectShowStop } from "./turnActivityShow.js";

type History = typeof HistoryMessageSchema.Type;
const SESSION = "sess-surfacing";
const fixtures = new WeakMap<Page, History[]>();
const panel = (page: Page) => page.locator("#messages .turn-activity").last();

function publish(page: Page, messages: History[]) {
	fixtures.set(page, messages);
	requireRpcControl(page).setDetailRows(
		SESSION,
		messages.flatMap(detailRowsOf),
	);
}

export const turnPanelHandlers: StepHandler[] = [
	{
		name: "show every step in the open turn log",
		match: /^I show every step in the open turn log$/,
		run: async ({ world }) => {
			const earlier = panel(world.page).getByRole("button", {
				name: /^\+ \d+ earlier steps$/,
			});
			if (await earlier.count()) await earlier.click();
		},
	},
	{
		name: "assert running row design",
		match:
			/^the running log row says Running with an accent striped block and no time$/,
		run: async ({ world }) => {
			const row = panel(world.page).getByTestId("turn-running");
			await expect(row.locator(".tool-name")).toHaveText("Running");
			await expect(row.locator("time")).toHaveCount(0);
			const block = row.getByRole("img", { name: "Running", exact: true });
			await expect(block).toHaveCSS("width", "9px");
			await expect(block).toHaveCSS("height", "9px");
			const paint = await block.evaluate((node) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-accent)";
				node.append(probe);
				const result = {
					stripes: getComputedStyle(node).backgroundImage,
					accent: getComputedStyle(probe).color,
				};
				probe.remove();
				return result;
			});
			expect(paint.stripes).toContain("repeating-linear-gradient");
			expect(paint.stripes).toContain(paint.accent);
		},
	},
	{
		name: "expand the surfaced Turn",
		match: /^I expand the surfaced turn$/,
		run: async ({ world }) => {
			await panel(world.page)
				.getByRole("button", { name: "Expand turn", exact: true })
				.click();
		},
	},
	{
		name: "stream interim text after the latest tool",
		match: /^interim text is streaming in the live Turn$/,
		run: async ({ world }) => {
			publish(
				world.page,
				(fixtures.get(world.page) ?? []).map((message) =>
					message.role === "assistant"
						? {
								...message,
								parts: [
									...(message.parts ?? []),
									{
										id: "live-interim",
										type: "text",
										text: "I am still checking the routing table.",
										time: { start: PINNED_CLOCK_MS - 1000 },
									},
								],
							}
						: message,
				),
			);
			await expect(
				world.page.locator(
					'#messages [data-uuid="surfacing-agent/live-interim"]',
				),
			).toContainText("I am still checking the routing table.");
		},
	},
	{
		name: "assert live head order",
		match: /^the live head orders its chevron, spinner and Working label$/,
		run: async ({ world }) => {
			const head = panel(world.page).getByTestId("surfacing-minimise-toggle");
			await expect(head).toContainText("Working");
			const icons = head.locator("svg");
			await expect(icons.nth(0)).toHaveClass(/chevron-down/);
			await expect(icons.nth(1)).toHaveClass(/loader-circle/);
			const ordered = await head.evaluate((node) => {
				const spinner = node.querySelector("svg:last-of-type");
				const label = [...node.querySelectorAll("span")].find(
					(span) => span.textContent === "Working",
				);
				return (
					!!spinner &&
					!!label &&
					!!(
						spinner.compareDocumentPosition(label) &
						Node.DOCUMENT_POSITION_FOLLOWING
					)
				);
			});
			expect(ordered).toBe(true);
		},
	},
	{
		name: "assert live card following tag",
		match: /^the live card is (not )?tagged Following latest$/,
		run: async ({ world, match }) => {
			const tag = panel(world.page)
				.getByTestId("surfacing-msg-card")
				.getByText("Following latest", { exact: true });
			if (match[1]) await expect(tag).toHaveCount(0);
			else {
				await expect(tag).toBeVisible();
				await expect(
					panel(world.page).getByRole("button", {
						name: "Follow latest",
						exact: true,
					}),
				).toHaveCount(0);
			}
		},
	},
	{
		name: "assert earlier steps design",
		match: /^the earlier steps control uses the Turn log design$/,
		run: async ({ world }) => {
			const button = panel(world.page).getByRole("button", {
				name: "+ 13 earlier steps",
				exact: true,
			});
			await expect(button).toHaveCSS("font-size", "12px");
			await expect(button).toHaveCSS("padding", "7px 6px");
			const colour = await button.evaluate((node) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-text-secondary)";
				node.append(probe);
				const result = {
					actual: getComputedStyle(node).color,
					expected: getComputedStyle(probe).color,
				};
				probe.remove();
				return result;
			});
			expect(colour.actual).toBe(colour.expected);
		},
	},
	{
		name: "assert all live steps",
		match: /^the live log shows all (\d+) steps$/,
		run: async ({ world, match }) => {
			await expect(
				panel(world.page).locator(".step-log [data-log-part]:visible"),
			).toHaveCount(Number(match[1]));
		},
	},
	{
		name: "hide earlier live steps",
		match: /^I hide the earlier live steps$/,
		run: async ({ world }) => {
			await panel(world.page)
				.getByRole("button", { name: "Hide earlier steps", exact: true })
				.click();
		},
	},
	{
		name: "assert collapsed live Turn contents",
		match: /^the collapsed live Turn keeps its Working head and strip only$/,
		run: async ({ world }) => {
			const scope = panel(world.page);
			await expect(
				scope.getByTestId("surfacing-minimise-toggle"),
			).toHaveAccessibleName("Expand turn");
			await expect(scope.getByTestId("turn-live-head")).toContainText(
				"Working",
			);
			await expect(
				scope.locator('[aria-label^="Activity timeline"]'),
			).toBeVisible();
			for (const selector of [
				".step-log",
				'[data-testid="turn-show-bar"]',
				'[data-testid="surfacing-msg-card"]',
			])
				await expect(scope.locator(selector)).toHaveCount(0);
		},
	},
	{
		name: "assert live default Full log and ticker",
		match: /^the Turn defaults to Full log with a three-step ticker$/,
		run: async ({ world }) => {
			await expectShowStop(world.page, "Full log");
			await expect(
				panel(world.page).locator(".step-log [data-log-part]:visible"),
			).toHaveCount(3);
		},
	},
	{
		name: "seed an anchor-only reveal link",
		match:
			/^the skills chip links to the (user message|reply|earlier hand-back message)$/,
		run: ({ world, match }) => {
			const anchor =
				match[1] === "user message"
					? { messageId: "surfacing-user" }
					: match[1] === "reply"
						? { messageId: "surfacing-agent", partId: "surfacing-final" }
						: { messageId: "turn-log-agent", partId: "earlier" };
			mockSessionSkills.set(world.page, [
				{
					name: "reveal-link",
					invokedBy: "agent",
					turnOrdinal: 1,
					at: PINNED_CLOCK_MS,
					anchor,
					running: false,
				},
			]);
		},
	},
	{
		name: "seed a Turn with a reply and no activity",
		match: /^the reveal session has a reply-only turn$/,
		run: async ({ world }) => {
			publish(
				world.page,
				surfacingHistory("settled").map((message) =>
					message.role === "assistant"
						? {
								...message,
								parts: message.parts?.filter(
									(part) => part.id === "surfacing-final",
								),
							}
						: message,
				),
			);
			setSessionRowStatus(world.page, SESSION, "idle", {
				title: "Reply-only reveal",
				accountId: "claude",
			});
			await openSessionRoute(world.page, SESSION);
		},
	},
	{
		name: "assert a reveal outside the Turn panel",
		match:
			/^the revealed (user message|reply) is in view without opening a turn log$/,
		run: async ({ world, match }) => {
			const uuid =
				match[1] === "reply"
					? "surfacing-agent/surfacing-final"
					: "surfacing-user/user";
			await expect(
				world.page.locator(`#messages [data-uuid="${uuid}"]`),
			).toBeInViewport();
			await expect(
				world.page.locator("#messages .step-log:visible"),
			).toHaveCount(0);
			await world.page.evaluate(
				() =>
					new Promise<void>((resolve) => {
						requestAnimationFrame(() =>
							requestAnimationFrame(() =>
								requestAnimationFrame(() =>
									requestAnimationFrame(() => resolve()),
								),
							),
						);
					}),
			);
			await expect(
				world.page.getByText("That skill run is no longer in this session", {
					exact: true,
				}),
			).toHaveCount(0);
		},
	},
	{
		name: "assert never-judged message landing",
		match: /^turn message #(\d+) is focused in the Full log$/,
		run: async ({ world, match }) => {
			const row = panel(world.page).locator(
				`[data-log-part="surfacing-agent/surfacing-part-${match[1]}"]`,
			);
			await expect(row).toBeVisible();
			await expect(row).toBeFocused();
			await expect(row).toBeInViewport();
		},
	},
	{
		name: "open a message through the turn number shortcut",
		match: /^I open turn message #(\d+) with digits and Enter$/,
		run: async ({ world, match }) => {
			await panel(world.page).getByTestId("surfacing-card").focus();
			await world.page.keyboard.type(match[1] ?? "");
			await world.page.keyboard.press("Enter");
		},
	},
	{
		name: "set a turn panel viewport width",
		match: /^the viewport is (\d+) pixels wide$/,
		run: async ({ world, match }) => {
			const width = Number(match[1]);
			await world.driver.setViewport(world.page, {
				name: `${width}x900`,
				width,
				height: 900,
			});
		},
	},
	{
		name: "assert turn summary row and sheet layout",
		match: /^the turn summary uses the (phone|desktop) layout$/,
		run: async ({ world, match }) => {
			const trigger = panel(world.page)
				.getByTestId("surfacing-summary-generate")
				.filter({ visible: true });
			const phone = match[1] === "phone";
			await expect(trigger).toHaveCSS("height", phone ? "38px" : "24px");
			await expect(trigger).toHaveAttribute("aria-expanded", String(!phone));
			const sheet = world.page.getByRole("dialog", {
				name: "Turn summary",
				exact: true,
			});
			if (phone) {
				await trigger.click();
				await expect(sheet).toBeVisible();
			} else await expect(sheet).toHaveCount(0);
		},
	},
	{
		name: "reload the panel choice session",
		match: /^I reload the panel choice session$/,
		run: async ({ world }) => {
			await world.page.reload();
			await expect(panel(world.page)).toBeVisible();
		},
	},
	{
		name: "collapse the Jev-off log",
		match: /^I collapse the plain turn log$/,
		run: async ({ world }) => {
			const toggle = panel(world.page).locator(".turn-activity-toggle");
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			await toggle.click();
		},
	},
	{
		name: "seed panel choice lifecycle",
		match: /^the panel choice session has a (live|settled) turn$/,
		run: async ({ world, match }) => {
			const live = match[1] === "live";
			publish(world.page, surfacingHistory(live ? "live" : "settled"));
			setSessionRowStatus(world.page, SESSION, live ? "busy" : "idle", {
				title: "Turn panel choices",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, SESSION);
			await expect(panel(world.page)).toBeVisible();
		},
	},
	{
		name: "settle panel choice Run",
		match: /^the panel choice Run settles$/,
		run: async ({ world }) => {
			const messages = [...(fixtures.get(world.page) ?? [])];
			const last = messages.at(-1);
			if (!last) throw new Error("Missing panel choice fixture");
			messages[messages.length - 1] = {
				...last,
				time: {
					created: last.time?.created ?? PINNED_CLOCK_MS,
					completed: Math.max(last.time?.created ?? 0, PINNED_CLOCK_MS) + 1000,
				},
			};
			publish(world.page, messages);
			setSessionRowStatus(world.page, SESSION, "idle");
			await expect(
				panel(world.page).locator(".turn-activity-toggle"),
			).toContainText("Worked");
		},
	},
	{
		name: "wake the same Turn",
		match: /^a wake Run starts in the panel choice turn$/,
		run: async ({ world }) => {
			const messages = fixtures.get(world.page) ?? [];
			const id = `panel-wake-${messages.length}`;
			publish(world.page, [
				...messages,
				{
					id,
					role: "assistant",
					parentID: "surfacing-user",
					time: {
						created:
							Math.max(
								PINNED_CLOCK_MS,
								...messages.map(
									(message) =>
										message.time?.completed ?? message.time?.created ?? 0,
								),
							) + 1000,
					},
					parts: [
						{
							id: `${id}-read`,
							type: "tool",
							tool: "Read",
							callID: id,
							state: {
								status: "running",
								input: { _tag: "whole", value: { filePath: "src/wake.ts" } },
							},
						},
					],
				},
			]);
			setSessionRowStatus(world.page, SESSION, "busy");
			await expect(
				panel(world.page).locator(".turn-activity-toggle"),
			).toContainText("Working");
		},
	},
	{
		name: "collapse and reopen a picked panel",
		match: /^I collapse and reopen the panel choice turn$/,
		run: async ({ world }) => {
			const toggle = panel(world.page).getByTestId("surfacing-minimise-toggle");
			await toggle.click();
			await expect(panel(world.page)).toHaveAttribute("data-minimised", "true");
			await toggle.click();
		},
	},
	{
		name: "assert panel log choice",
		match: /^the panel shows the (full log|saved message stop)$/,
		run: async ({ world, match }) => {
			const full = match[1] === "full log";
			if (!full) {
				await expect(
					panel(world.page).getByRole("tab", {
						name: /^(Full log|Log)$/,
						selected: true,
					}),
				).toHaveCount(0);
				const menu = panel(world.page).getByRole("button", {
					name: "Show messages",
					exact: true,
				});
				if (await menu.count())
					await expect(menu).not.toContainText("Full log");
			}
			if (full)
				await expect(
					panel(world.page).locator(".step-log [data-log-part]").first(),
				).toBeVisible();
		},
	},
];
