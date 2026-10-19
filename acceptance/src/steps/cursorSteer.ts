import { expect } from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import type { StepHandler } from "../runtime.js";
import {
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const sessionId = "sess-first-send";
const inputId = "cursor-pending-steer";
const shellId = "cursor-background-shell";

export const cursorSteerHandlers: StepHandler[] = [
	{
		name: "hold a Cursor steer",
		match: /^the Cursor relay holds the steer (.+)$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["delivery"] === "steer" &&
					request.payload["text"] === match[1],
			);
			requireRelayControl(world.page).sendMessage({
				type: "mock_pending_input",
				sessionId,
				inputId,
				text: match[1],
				state: "steering",
			});
		},
	},
	{
		name: "deliver a Cursor steer or requeued input",
		match:
			/^the Cursor relay (delivers the steer|starts the requeued input) (.+)$/,
		run: ({ world, match }) => {
			const relay = requireRelayControl(world.page);
			relay.sendMessage({
				type: "user_message",
				sessionId,
				messageId: "cursor-steered-user",
				text: match[2],
				steered: match[1] === "delivers the steer",
			});
			relay.sendMessage({
				type: "mock_pending_input_removed",
				sessionId,
				inputId,
			});
			setSessionRowStatus(world.page, sessionId, "busy");
		},
	},
	{
		name: "decline a Cursor steer",
		match: /^the Cursor relay declines the steer (.+)$/,
		run: ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: "mock_pending_input",
				sessionId,
				inputId,
				text: match[1],
				state: "queued",
			});
		},
	},
	{
		name: "assert one Cursor user message",
		match: /^the Cursor transcript contains (.+) exactly once$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.locator("#messages .msg-user").filter({
					has: world.page.getByText(match[1] ?? "", { exact: true }),
				}),
			).toHaveCount(1);
		},
	},
	{
		name: "assert requeued Cursor user message is not steered",
		match: /^the last Cursor user message has no Steered label$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#messages .msg-user")
					.last()
					.getByTestId("user-message-steered"),
			).toHaveCount(0);
		},
	},
	{
		name: "publish a backgrounded Cursor shell",
		match: /^the Cursor relay reports a shell moved to the background$/,
		run: ({ world }) => {
			const messages: HistoryMessage[] = [
				{
					id: "cursor-shell-user",
					role: "user",
					parts: [
						{ id: "cursor-shell-prompt", type: "text", text: "Keep working" },
					],
				},
				{
					id: "cursor-turn-assistant",
					role: "assistant",
					parts: [
						{
							id: shellId,
							callID: shellId,
							type: "tool",
							tool: "Bash",
							state: {
								status: "completed",
								input: {
									_tag: "whole",
									value: { tool: "Bash", command: "sleep 10" },
								},
								output: { _tag: "whole", text: "" },
								metadata: {
									cursorToolType: "shell",
									movedToBackground: true,
									exitCode: 0,
								},
							},
						},
					],
				},
			];
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: { hasMore: false, messages },
			});
		},
	},
	{
		name: "assert collapsed backgrounded Cursor shell",
		match: /^the collapsed Cursor shell says Moved to background$/,
		run: async ({ world }) => {
			const row = world.page.locator(`.tool-item[data-tool-id="${shellId}"]`);
			await expect(row.locator("button").first()).toContainText(
				"Moved to background",
			);
			await expect(row.locator(".tool-result")).toHaveCount(0);
		},
	},
	{
		name: "expand backgrounded Cursor shell",
		match: /^I expand the backgrounded Cursor shell$/,
		run: async ({ world }) => {
			await world.page
				.locator(`.tool-item[data-tool-id="${shellId}"] button`)
				.first()
				.click();
		},
	},
	{
		name: "assert Cursor shell background handoff detail",
		match: /^the Cursor shell detail explains the background handoff$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("tool-moved-to-background"),
			).toHaveText("Moved to background. The command may still be running.");
			await expect(
				world.page.locator(
					`.tool-item[data-tool-id="${shellId}"] .tool-result`,
				),
			).toContainText("sleep 10");
		},
	},
	{
		name: "assert backgrounded Cursor shell does not claim an exit code",
		match: /^the backgrounded Cursor shell does not claim an exit code$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("tool-exit-code")).toHaveCount(0);
		},
	},
];
