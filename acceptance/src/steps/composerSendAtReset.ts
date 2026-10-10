import { expect } from "@playwright/test";
import type { LimitRecovery } from "../../../src/lib/contracts/limit-recovery.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";
import { themeColour } from "./usageFooterMeter.js";
import { currentSessionId, projectLimit } from "./usageLimitStrip.js";
import { snapshot } from "./usageSettings.js";

export const composerSendAtResetHandlers: StepHandler[] = [
	{
		name: "assert the composer's usage send mode",
		match: /^the composer send mode is (normal|warning|at-reset)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#send")).toHaveAttribute(
				"data-send-mode",
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert a gapped theme amber ring without send words",
		match: /^the send button has a gapped amber ring and no words$/,
		run: async ({ world }) => {
			const button = world.page.locator("#send");
			await expect(button).toHaveCSS(
				"box-shadow",
				`${await themeColour(world.page, "--color-bg")} 0px 0px 0px 2px, ${await themeColour(world.page, "--color-status-amber")} 0px 0px 0px 3.5px`,
			);
			await expect(button).toHaveText("");
			await expect(button.locator("svg")).toHaveCount(1);
			await expect(
				world.page.getByTestId("composer-send-at-label"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert the ordinary send button",
		match: /^the composer has a plain Send button$/,
		run: async ({ world }) => {
			const button = world.page.locator("#send");
			await expect(button).toHaveAccessibleName("Send");
			await expect(button).toHaveText("");
			await expect(button).toHaveCSS("box-shadow", "none");
			await expect(
				world.page.getByTestId("composer-send-at-label"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert reset send label and clock icon",
		match: /^the reset send label reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("composer-send-at-label")).toHaveText(
				match[1] ?? "",
			);
			await expect(world.page.locator("#send svg")).toHaveCount(1);
		},
	},
	{
		name: "assert the phone reset button's compact height",
		match: /^the phone reset send button is 32 pixels tall$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#send")).toHaveCSS("height", "32px");
		},
	},
	{
		name: "project a scheduled reset continuation without a cut-off",
		match: /^the session has a scheduled reset continuation at (\S+)$/,
		run: ({ world, match }) => {
			const scheduledAt = Date.parse(match[1] ?? "") / 1000;
			if (!Number.isFinite(scheduledAt))
				throw new Error("Invalid scheduled composer reset time");
			projectLimit(world.page, {
				instanceId: "claude",
				rateLimitType: "five_hour",
				rearms: 0,
				continued: false,
				scheduledAt,
			} satisfies LimitRecovery);
		},
	},
	{
		name: "queue submitted inputs through the existing pending-input projection",
		match: /^the mock relay queues submitted messages for reset$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const relay = requireRelayControl(world.page);
			rpc.setHandler("input.submit", (request) => {
				const { sessionId, inputId, text } = request;
				if (
					typeof sessionId !== "string" ||
					typeof inputId !== "string" ||
					typeof text !== "string"
				)
					throw new Error("Incomplete reset queue submission");
				const row = rpc.shellRows?.find(
					(candidate) => (candidate as { id?: string }).id === sessionId,
				) as { limitRecovery?: LimitRecovery } | undefined;
				const resetsAt = snapshot(world.page)
					.find((reading) => reading.accountId === "claude")
					?.windows.find(
						(window) => window.utilization >= 100 && window.resetsAt,
					)?.resetsAt;
				if (row?.limitRecovery?.scheduledAt === undefined && resetsAt)
					projectLimit(world.page, {
						instanceId: "claude",
						rateLimitType: "five_hour",
						rearms: 0,
						continued: false,
						scheduledAt: Date.parse(resetsAt) / 1000,
					} satisfies LimitRecovery);
				relay.sendMessage({
					type: "mock_pending_input",
					sessionId,
					inputId,
					text,
				});
				return { ok: true, sessionId };
			});
			rpc.setHandler("input.cancel", ({ sessionId, inputId }) => {
				relay.sendMessage({
					type: "mock_pending_input_removed",
					sessionId,
					inputId,
				});
				return { ok: true };
			});
		},
	},
	{
		name: "send at reset through the unchanged click or keyboard path",
		match: /^I send the reset-bound message with (the button|the keyboard)$/,
		run: async ({ world, match }) => {
			const input = world.page.locator("#input");
			const text = await input.inputValue();
			if (match[1] === "the keyboard") await input.press("Enter");
			else await world.page.locator("#send").click();
			const rpc = requireRpcControl(world.page);
			await rpc.waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["text"] === text &&
					request.payload["sessionId"] === currentSessionId(world.page) &&
					request.payload["delivery"] === "queue",
			);
			expect(
				rpc
					.getRequests()
					.filter((request) => request.tag === "ContinueSession"),
			).toHaveLength(0);
			await expect(input).toHaveValue("");
		},
	},
	{
		name: "assert a queued input's release caption",
		match: /^pending-input row ([0-9]+) has the reset caption (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId("pending-input-row")
					.nth(Number(match[1]) - 1)
					.getByTestId("pending-input-sends-at"),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "edit or remove the queued reset input",
		match: /^I (Edit|Remove) pending reset input row ([0-9]+)$/,
		run: async ({ world, match }) => {
			const row = world.page
				.getByTestId("pending-input-row")
				.nth(Number(match[2]) - 1);
			const inputId = await row.getAttribute("data-input-id");
			await row
				.getByTestId(
					match[1] === "Edit" ? "pending-input-edit" : "pending-input-remove",
				)
				.click();
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.cancel" &&
					request.payload["inputId"] === inputId,
			);
			await expect(
				world.page.locator(
					`[data-testid="pending-input-row"][data-input-id="${inputId}"]`,
				),
			).toHaveCount(0);
		},
	},
];
