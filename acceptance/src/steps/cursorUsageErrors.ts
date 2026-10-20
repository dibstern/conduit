import { expect } from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, setSessionRowStatus } from "./shared.js";

const sessionId = "sess-first-send";

export const cursorUsageErrorsHandlers: StepHandler[] = [
	{
		name: "report completed Cursor usage",
		match:
			/^the Cursor relay reports a completed turn with (unavailable|[0-9.]+) cost$/,
		run: ({ world, match }) => {
			const message: HistoryMessage = {
				id: "cursor-usage-assistant",
				role: "assistant",
				time: { created: 2_000, completed: 3_000 },
				parts: [
					{
						id: "cursor-usage-text",
						type: "text",
						text: "Usage reported.",
					},
				],
				tokens: {
					input: 1_200,
					output: 340,
					cache: { read: 118_800, write: 0 },
				},
				contextTokens: 120_000,
				...(match[1] === "unavailable" ? {} : { cost: Number(match[1]) }),
			};
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: {
					messages: [
						{
							id: "cursor-usage-user",
							role: "user",
							time: { created: 1_000 },
							parts: [
								{
									id: "cursor-usage-prompt",
									type: "text",
									text: "Explain usage",
								},
							],
						},
						message,
					],
					hasMore: false,
				},
			});
			// Ends the sent turn like the relay does; createdAt keeps the row time pinned.
			requireRelayControl(world.page).sendMessage({
				type: "done",
				sessionId,
				messageId: "cursor-usage-assistant",
				createdAt: 3_000,
				code: 0,
			});
			setSessionRowStatus(world.page, sessionId, "idle");
		},
	},
	{
		name: "assert Cursor token counts",
		match: /^the Cursor turn shows (\S+) input tokens and (\S+) output tokens$/,
		run: async ({ world, match }) => {
			const usage = world.page.locator("#messages .turn-meta");
			const input = usage.getByTitle("Fresh input tokens", { exact: true });
			const output = usage.getByTitle("Output tokens", { exact: true });
			await expect(input).toBeVisible();
			await expect(input).toHaveText(`${match[1]} in`);
			await expect(output).toBeVisible();
			await expect(output).toHaveText(`${match[2]} out`);
		},
	},
	{
		name: "assert Cursor absolute context without invented capacity",
		match:
			/^the Cursor turn shows (\S+) context tokens without a reported capacity$/,
		run: async ({ world, match }) => {
			const usage = world.page.locator("#messages .turn-meta");
			const context = usage.getByTitle(
				`${match[1]} tokens in context; context window not reported`,
				{ exact: true },
			);
			await expect(context).toBeVisible();
			await expect(context).toHaveText(`${match[1]} ctx`);
			await expect(usage).not.toContainText("%");
		},
	},
	{
		name: "assert Cursor reported or unavailable cost",
		match: /^the Cursor turn cost is (unavailable|[0-9.]+)$/,
		run: async ({ world, match }) => {
			const usage = world.page.locator("#messages .turn-meta");
			await expect(usage).toBeVisible();
			if (match[1] === "unavailable") {
				await expect(usage).not.toContainText("$");
			} else {
				await expect(
					usage.getByText(`$${Number(match[1]).toFixed(4)}`, { exact: true }),
				).toBeVisible();
			}
		},
	},
	{
		name: "report Cursor provider error",
		match: /^the Cursor relay fails with (.+) and (.+)$/,
		run: ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: {
					messages: [
						{
							id: "cursor-error-user",
							role: "user",
							time: { created: 1_000 },
							parts: [
								{
									id: "cursor-error-prompt",
									type: "text",
									text: "Try this turn",
								},
							],
						},
						{
							id: "cursor-error-assistant",
							role: "assistant",
							time: { created: 2_000, completed: 3_000 },
							parts: [
								{
									id: "cursor-error-part",
									type: "error",
									text: `${match[1]}\n\n${match[2]}`,
								},
							],
						},
					],
					hasMore: false,
				},
			});
			// Ends the sent turn like the relay does; createdAt keeps the row time pinned.
			requireRelayControl(world.page).sendMessage({
				type: "done",
				sessionId,
				messageId: "cursor-error-assistant",
				createdAt: 3_000,
				code: 0,
			});
			setSessionRowStatus(world.page, sessionId, "idle");
		},
	},
	{
		name: "assert Cursor provider diagnostic and retry guidance",
		match: /^the Cursor error notice contains (.+)$/,
		run: async ({ world, match }) => {
			const notice = world.page.getByTestId("system-error-notice");
			await expect(notice).toBeVisible();
			await expect(notice).toContainText(match[1] ?? "");
		},
	},
	{
		name: "assert no Cursor error notice",
		match: /^the Cursor transcript has no error notice$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("system-error-notice")).toHaveCount(
				0,
			);
		},
	},
];
