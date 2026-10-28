import { expect, type Page } from "@playwright/test";
import type { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { surfacingHistory } from "./surfacingCard.js";

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
			await expect(
				panel(world.page).locator(".turn-activity-toggle"),
			).toHaveAttribute("aria-expanded", String(full));
			if (full)
				await expect(
					panel(world.page).locator(".step-log [data-log-part]").first(),
				).toBeVisible();
		},
	},
];
