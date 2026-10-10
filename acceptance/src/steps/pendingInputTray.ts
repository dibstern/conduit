import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

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
		name: "queue or steer a pending input",
		match: /^the mock relay (queues|steers) (.+?)(?: with ([0-9]+) images?)?$/,
		run: async ({ world, match }) => {
			const text = match[2] ?? "";
			const ids = queuedIds.get(world.page) ?? new Map<string, string>();
			queuedIds.set(world.page, ids);
			const inputId = `queued-${ids.size + 1}`;
			ids.set(text, inputId);
			requireRelayControl(world.page).sendMessage({
				type: "mock_pending_input",
				sessionId: sessionIdOf(world.page),
				inputId,
				text,
				...(match[1] === "steers" ? { state: "steering" } : {}),
				images: Array.from(
					{ length: Number(match[3] ?? 0) },
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
		name: "pause or resume the queue",
		match: /^the queue (pauses|resumes)$/,
		run: async ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: "mock_inbox",
				sessionId: sessionIdOf(world.page),
				paused: match[1] === "pauses",
			});
		},
	},
	{
		name: "assert tray paused header",
		match: /^the pending-input tray (shows|does not show) Paused$/,
		run: async ({ world, match }) => {
			const header = world.page.getByTestId("pending-input-paused");
			if (match[1] === "shows") {
				await expect(header).toContainText("Paused");
				await expect(header.getByTestId("pending-input-resume")).toHaveText(
					"Resume",
				);
			} else await expect(header).toHaveCount(0);
		},
	},
	{
		name: "assert tray row actions",
		match: /^pending-input row ([0-9]+) offers Edit and Remove$/,
		run: async ({ world, match }) => {
			const row = rows(world.page).nth(Number(match[1]) - 1);
			await expect(row.getByTestId("pending-input-edit")).toBeVisible();
			await expect(row.getByTestId("pending-input-remove")).toBeVisible();
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
	{
		name: "assert steering row",
		match: /^pending-input row ([0-9]+) is Steering (.+)$/,
		run: async ({ world, match }) => {
			const row = rows(world.page).nth(Number(match[1]) - 1);
			await expect(row.getByTestId("pending-input-text")).toHaveText(
				match[2] ?? "",
			);
			await expect(row.getByTestId("pending-input-state")).toHaveText(
				"Steering",
			);
			await expect(row.getByTestId("pending-input-steer")).toHaveCount(0);
		},
	},
	{
		name: "assert row Steer action",
		match: /^pending-input row ([0-9]+) offers (an enabled|a disabled) Steer$/,
		run: async ({ world, match }) => {
			const steer = rows(world.page)
				.nth(Number(match[1]) - 1)
				.getByTestId("pending-input-steer");
			await expect(steer).toHaveText("Steer");
			if (match[2] === "an enabled") await expect(steer).toBeEnabled();
			else await expect(steer).toBeDisabled();
		},
	},
	{
		name: "hover row Steer for its tooltip",
		match: /^hovering Steer on row ([0-9]+) explains (.+)$/,
		run: async ({ world, match }) => {
			await rows(world.page)
				.nth(Number(match[1]) - 1)
				.getByTestId("pending-input-steer")
				.hover({ force: true });
			await expect(world.page.getByRole("tooltip")).toHaveText(match[2] ?? "", {
				timeout: 3000,
			});
		},
	},
	{
		name: "open a prompt",
		match: /^a prompt opens in the running turn$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "mock_inbox",
				sessionId: sessionIdOf(world.page),
				steer: "prompt_open",
			});
		},
	},
	{
		name: "refuse steers",
		match: /^the relay refuses steers with ([a-z_]+)$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).setResponse("input.submit", {
				ok: false,
				reason: match[1],
			});
		},
	},
	{
		name: "steer the composer draft",
		match:
			/^I steer the composer message with (a modified click|the keyboard)$/,
		run: async ({ world, match }) => {
			if (match[1] === "the keyboard")
				await world.page.locator("#input").press("ControlOrMeta+Enter");
			else
				await world.page
					.locator("#send")
					.click({ modifiers: ["ControlOrMeta"] });
		},
	},
	{
		name: "assert steer request",
		match: /^the relay is asked to steer (.+)$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["text"] === match[1] &&
					request.payload["delivery"] === "steer",
			);
		},
	},
	{
		name: "assert steer refusal notice",
		match: /^the composer says Not steered\. (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("composer-steer-refused")).toHaveText(
				`Not steered. ${match[1] ?? ""}`,
			);
		},
	},
	{
		name: "assert composer draft",
		match: /^the composer still holds (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#input")).toHaveValue(match[1] ?? "");
		},
	},
	{
		name: "assert send and stop titles",
		match: /^the (send|stop) button title reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator(`#${match[1]}`)).toHaveAttribute(
				"title",
				match[2] ?? "",
			);
		},
	},
	{
		name: "deliver a steered user message",
		match: /^the transcript receives the steered message (.+)$/,
		run: async ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: "user_message",
				sessionId: sessionIdOf(world.page),
				text: match[1],
				steered: true,
			});
		},
	},
	{
		name: "assert steered label",
		match: /^the last user message is labelled Steered$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#messages .msg-user")
					.last()
					.getByTestId("user-message-steered"),
			).toHaveText("Steered");
		},
	},
];
