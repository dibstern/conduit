import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl } from "./shared.js";

/** The input id the mock gave each queued text, per page. */
const queuedIds = new WeakMap<Page, Map<string, string>>();

const sessionIdOf = (page: Page): string => {
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	if (!sessionId) throw new Error("No session is open");
	return sessionId;
};

const rows = (page: Page) => page.getByTestId("pending-input-row");

export const pendingInputTrayHandlers: StepHandler[] = [
	{
		name: "queue a pending input",
		match: /^the mock relay queues (.+?)(?: with ([0-9]+) images?)?$/,
		run: async ({ world, match }) => {
			const text = match[1] ?? "";
			const ids = queuedIds.get(world.page) ?? new Map<string, string>();
			queuedIds.set(world.page, ids);
			const inputId = `queued-${ids.size + 1}`;
			ids.set(text, inputId);
			requireRelayControl(world.page).sendMessage({
				type: "mock_pending_input",
				sessionId: sessionIdOf(world.page),
				inputId,
				text,
				images: Array.from(
					{ length: Number(match[2] ?? 0) },
					(_, index) => `data:image/png;base64,${index}`,
				),
			});
			await world.page
				.locator(
					`[data-testid="pending-input-row"][data-input-id="${inputId}"]`,
				)
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "start a queued input",
		match: /^the queued message (.+) starts$/,
		run: async ({ world, match }) => {
			const inputId = queuedIds.get(world.page)?.get(match[1] ?? "");
			if (!inputId) throw new Error(`Nothing was queued as ${match[1]}`);
			requireRelayControl(world.page).sendMessage({
				type: "mock_pending_input_removed",
				sessionId: sessionIdOf(world.page),
				inputId,
			});
		},
	},
	{
		name: "assert tray hidden",
		match: /^the pending-input tray is not visible$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("pending-input-tray")).toHaveCount(0);
		},
	},
	{
		name: "assert tray row count",
		match: /^the pending-input tray has ([0-9]+) rows?$/,
		run: async ({ world, match }) => {
			await expect(rows(world.page)).toHaveCount(Number(match[1]));
		},
	},
	{
		name: "assert tray row text",
		match: /^pending-input row ([0-9]+) reads (.+)$/,
		run: async ({ world, match }) => {
			const row = rows(world.page).nth(Number(match[1]) - 1);
			await expect(row.getByTestId("pending-input-text")).toHaveText(
				match[2] ?? "",
			);
			await expect(row.getByTestId("pending-input-state")).toHaveText("Queued");
		},
	},
	{
		name: "assert tray row images",
		match: /^pending-input row ([0-9]+) shows (no images|[0-9]+ images?)$/,
		run: async ({ world, match }) => {
			const images = rows(world.page)
				.nth(Number(match[1]) - 1)
				.getByTestId("pending-input-images");
			if (match[2] === "no images") await expect(images).toHaveCount(0);
			else await expect(images).toHaveAccessibleName(match[2] ?? "");
		},
	},
	{
		name: "assert send button label",
		match: /^the send button reads (Send|Queue message)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#send")).toHaveAccessibleName(
				match[1] ?? "",
			);
		},
	},
	{
		name: "open session goes idle",
		match: /^the open session goes idle$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "status",
				status: "idle",
				sessionId: sessionIdOf(world.page),
			});
			await world.page.locator("#stop").waitFor({ state: "hidden" });
		},
	},
];
