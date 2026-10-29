import { expect, type Page } from "@playwright/test";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { surfacingHistory } from "./surfacingCard.js";
import { chooseShowStop } from "./turnActivityShow.js";

const panel = (page: Page) => page.locator("#messages .turn-activity").last();

export const turnUsageHandlers: StepHandler[] = [
	{
		name: "open a step from the Usage strip",
		match: /^selecting a Usage strip step opens its Full log row$/,
		run: async ({ world }) => {
			const turn = panel(world.page);
			const step = turn.locator(
				'.surface-strip [data-step-id="surfacing-agent/surfacing-tool-1"]',
			);
			await step.focus();
			await world.page.keyboard.press("Enter");
			const row = turn.locator(
				'.step-log [data-log-part="surfacing-agent/surfacing-tool-1"]',
			);
			await expect(row).toBeVisible();
			await expect(row).toBeFocused();
		},
	},
	{
		name: "assert centred Usage category dots",
		match: /^Usage shows centred category dots instead of pins$/,
		run: async ({ world }) => {
			const dots = panel(world.page).locator(".unread-dot");
			await expect(dots).toHaveCount(8);
			for (const dot of await dots.all()) {
				const geometry = await dot.evaluate((element) => {
					const box = element.getBoundingClientRect();
					const track = element.parentElement?.getBoundingClientRect();
					return {
						height: box.height,
						middle: box.y + box.height / 2,
						track: track ? track.y + track.height / 2 : 0,
					};
				});
				expect(geometry.height).toBe(7);
				expect(Math.abs(geometry.middle - geometry.track)).toBeLessThan(1);
			}
		},
	},
	{
		name: "assert footer cost, context and divider",
		match:
			/^the Usage footer has a divider and (\$[\d.]+) with (a|no) context gauge$/,
		run: async ({ world, match }) => {
			const bar = panel(world.page).getByTestId("turn-show-bar");
			await expect(bar.locator(".turn-meta > span").first()).toHaveText(
				match[1] ?? "",
			);
			await expect(bar.getByTestId("quota-meter")).toHaveCount(
				match[2] === "a" ? 1 : 0,
			);
			if (match[2] === "a")
				await expect(bar.getByTestId("quota-meter")).toHaveText(/ctx\s*41%/);
			const tabs = bar.getByRole("tablist");
			await expect(tabs).toHaveCount(1);
			const divider = tabs.locator('[aria-hidden="true"]').last();
			await expect(divider).toHaveCSS("width", "1px");
			const colour = await divider.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.backgroundColor = "var(--color-border)";
				element.append(probe);
				const result = {
					actual: getComputedStyle(element).backgroundColor,
					expected: getComputedStyle(probe).backgroundColor,
				};
				probe.remove();
				return result;
			});
			expect(colour.actual).toBe(colour.expected);
		},
	},
	{
		name: "assert Usage gauge and skill paint",
		match:
			/^the Usage panel uses a 6px gauge and a coloured sparkles skill pill$/,
		run: async ({ world }) => {
			const usage = panel(world.page).getByRole("region", {
				name: "Turn usage",
			});
			await expect(
				usage.getByTestId("quota-meter").locator('[aria-hidden="true"]'),
			).toHaveCSS("height", "6px");
			const skill = usage.getByRole("listitem").filter({ hasText: "tdd" });
			await expect(skill.locator(".lucide-sparkles")).toBeVisible();
			const colours = await skill
				.getByText("tdd", { exact: true })
				.evaluate((element) => {
					const probe = document.createElement("span");
					probe.style.color = "var(--color-act-other)";
					element.append(probe);
					const result = {
						actual: getComputedStyle(element).color,
						expected: getComputedStyle(probe).color,
					};
					probe.remove();
					return result;
				});
			expect(colours.actual).toBe(colours.expected);
		},
	},
	{
		name: "assert shared Usage tab keyboard navigation",
		match: /^Usage and the Show stops share keyboard navigation$/,
		run: async ({ world }) => {
			const turn = panel(world.page);
			const usage = turn.getByRole("tab", { name: "Usage", exact: true });
			await usage.focus();
			if (
				await turn.getByRole("tab", { name: "Full log", exact: true }).count()
			) {
				await world.page.keyboard.press("ArrowLeft");
				await expect(
					turn.getByRole("tab", { name: "Full log", selected: true }),
				).toBeFocused();
				await world.page.keyboard.press("End");
				await expect(usage).toBeFocused();
				await expect(usage).toHaveAttribute("aria-selected", "true");
			}
		},
	},
	{
		name: "assert economics leave the head and log",
		match: /^the head tooltip and Full log leave the bill in the footer$/,
		run: async ({ world }) => {
			const turn = panel(world.page);
			await turn
				.getByRole("button", { name: "Collapse turn", exact: true })
				.hover();
			const tooltip = world.page.getByRole("tooltip");
			await expect(tooltip).toBeVisible();
			await expect(tooltip).not.toContainText(/\$|tokens|ctx|41%/);
			await chooseShowStop(world.page, "Full log");
			await expect(turn.locator(".step-log")).toBeVisible();
			await expect(turn.locator(".step-log .turn-meta")).toHaveCount(0);
			await expect(
				turn.getByRole("region", { name: "Turn usage" }),
			).toHaveCount(0);
			await expect(
				turn.getByTestId("turn-show-bar").locator(".turn-meta"),
			).toBeVisible();
		},
	},
	{
		name: "seed turn Usage economics and notable events",
		match:
			/^the Usage turn is (settled|live) with reported economics and notable events$/,
		run: async ({ world, match }) => {
			const live = match[1] === "live";
			const messages = surfacingHistory("settled");
			const start = messages[0]?.time?.created ?? 0;
			const history: typeof messages = messages.map((message) =>
				message.role !== "assistant"
					? message
					: {
							...message,
							cost: 0.4123,
							contextTokens: 82_000,
							tokens: {
								input: 1_200_000,
								output: 18_000,
								context_window: 200_000,
							},
							parts: [
								{
									id: "usage-skill",
									type: "tool",
									tool: "Skill",
									callID: "usage-skill",
									time: { start: start + 2000, end: start + 2200 },
									state: {
										status: "completed",
										input: { _tag: "whole" as const, value: { name: "tdd" } },
										output: { _tag: "whole" as const, text: "Done" },
									},
								},
								{
									id: "usage-failed",
									type: "tool",
									tool: "Bash",
									callID: "usage-failed",
									time: { start: start + 3000, end: start + 3200 },
									state: {
										status: "error",
										input: {
											_tag: "whole" as const,
											value: { command: "pnpm check" },
										},
										error: "Type check failed",
									},
								},
								{
									id: "usage-compact",
									type: "compaction",
									text: "Context compacted",
									preTokens: 182_000,
									postTokens: 41_000,
									time: { start: start + 4000 },
								},
								...(message.parts ?? []),
							],
						},
			);
			if (live)
				history.push({
					id: "usage-wake",
					role: "assistant",
					parentID: "surfacing-user",
					time: { created: PINNED_CLOCK_MS - 2000 },
					parts: [
						{
							id: "wake-read",
							type: "tool",
							tool: "Read",
							callID: "wake-read",
							time: { start: PINNED_CLOCK_MS - 2000 },
							state: {
								status: "running",
								input: { _tag: "whole", value: { filePath: "src/wake.ts" } },
							},
						},
					],
				});
			requireRpcControl(world.page).setDetailRows(
				"sess-surfacing",
				history.flatMap(detailRowsOf),
			);
			setSessionRowStatus(
				world.page,
				"sess-surfacing",
				live ? "busy" : "idle",
				{
					title: "Turn Usage",
					accountId: "claude",
					updatedAt: PINNED_CLOCK_MS,
				},
			);
			await openSessionRoute(world.page, "sess-surfacing");
			await expect(panel(world.page)).toBeVisible();
			const expand = panel(world.page).getByRole("button", {
				name: "Expand turn",
				exact: true,
			});
			if (await expand.count()) await expand.click();
		},
	},
	{
		name: "select a turn footer tab",
		match: /^I select the turn (Usage|Log) tab$/,
		run: async ({ world, match }) => {
			await panel(world.page)
				.getByRole("tab", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "assert Usage replaces the card and log",
		match: /^Usage replaces the card and log without selecting a Show stop$/,
		run: async ({ world }) => {
			const turn = panel(world.page);
			await expect(
				turn.getByRole("tab", { name: "Usage", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await expect(turn.getByTestId("surfacing-msg-card")).toHaveCount(0);
			await expect(turn.locator(".step-log:visible")).toHaveCount(0);
			await expect(turn.getByRole("tab", { selected: true })).toHaveCount(1);
			await expect(turn.locator(".pin-chip")).toHaveCount(0);
			await expect(turn.locator('[data-x][aria-pressed="true"]')).toHaveCount(
				0,
			);
		},
	},
	{
		name: "assert Usage content and event offsets",
		match:
			/^Usage lists the reported cost, tokens, context, skills and notable events$/,
		run: async ({ world }) => {
			const usage = panel(world.page).getByRole("region", {
				name: "Turn usage",
				exact: true,
			});
			await expect(usage).toBeVisible();
			for (const label of [
				"Cost",
				"Tokens",
				"Context at end",
				"Skills loaded",
				"Worth a look",
			])
				await expect(usage.getByText(label, { exact: true })).toBeVisible();
			await expect(usage).toContainText("$0.4123");
			await expect(usage).toContainText("1.2M in · 18k out");
			await expect(usage).toContainText("41% · 82k / 200k");
			await expect(usage.getByTestId("quota-meter")).toBeVisible();
			await expect(usage).toContainText("Context compacted · 141k saved");
			for (const [text, time] of [
				["tdd", "at 0:02"],
				["1 failed step · pnpm check", "at 0:03"],
				["Context compacted · 141k saved", "at 0:04"],
			] as const) {
				const row = usage.getByRole("listitem").filter({ hasText: text });
				await expect(row).toBeVisible();
				await expect(row).toContainText(time);
			}
			await expect(
				usage.locator("code").filter({ hasText: "pnpm check" }),
			).toBeVisible();
		},
	},
];
