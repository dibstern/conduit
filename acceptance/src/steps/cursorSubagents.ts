import { expect, type Page } from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const parentId = "sess-first-send";
const taskId = "cursor-subagents-task";
const childId = `cursor-subagent-${parentId}-${taskId}`;
const childMessageId = "cursor-subagents-child-assistant";
const description = "Inspect the router";
const prompt = "Find how routing reaches the provider";
const childText = "The router forwards requests to the provider adapter.";
const childUpdate = " The relay keeps each project's route separate.";
const thinking = "Checking the routing boundaries.";
const taskRow = (page: Page) =>
	page.locator(`#messages .tool-item[data-tool-id="${taskId}"]`);

export const cursorSubagentsHandlers: StepHandler[] = [
	{
		name: "start Cursor subagent with live child steps",
		match:
			/^the Cursor relay starts a (foreground|background) subagent with live child steps$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const getModels = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			const getAgents = rpc.stubs.GetAgents ?? rpc.catalogStubs().GetAgents;
			rpc.setStubs({
				GetModels: (payload) =>
					"sessionId" in payload && payload.sessionId === childId
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providers: [],
								active: { provider: "cursor", model: "composer-2.5-fast" },
							}
						: getModels(payload),
				GetAgents: (payload) =>
					"sessionId" in payload && payload.sessionId === childId
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providerScope: { id: "cursor", name: "Cursor" },
								agents: [],
							}
						: getAgents(payload),
			});
			const parent = rpc.shellRows?.find(
				(row) => (row as { id?: string }).id === parentId,
			);
			const family = [
				{
					...(parent as object | undefined),
					id: parentId,
					title: "Inspect the routing implementation",
					accountId: "cursor-work",
					status: "busy",
				},
				{
					id: childId,
					parentID: parentId,
					title: description,
					accountId: "cursor-work",
					status: "busy",
					messageCount: 1,
					updatedAt: PINNED_CLOCK_MS,
				},
			];
			rpc.setShellRows([
				...(rpc.shellRows ?? []).filter(
					(row) => !family.some(({ id }) => id === (row as { id?: string }).id),
				),
				...family,
			]);
			rpc.setFamilyRows(family);
			const parentMessages: HistoryMessage[] = [
				{
					id: "cursor-subagents-parent-user",
					role: "user",
					// The send's inputId lets this placed prompt replace the browser's copy.
					inputId: String(
						rpc
							.getRequests()
							.find(
								(request) =>
									request.tag === "input.submit" &&
									request.payload["text"] ===
										"Inspect the routing implementation",
							)?.payload["inputId"],
					),
					time: { created: PINNED_CLOCK_MS - 2 * 60_000 },
					parts: [
						{
							id: "cursor-subagents-parent-prompt",
							type: "text",
							text: "Inspect the routing implementation",
						},
					],
				},
				{
					id: "cursor-turn-assistant",
					role: "assistant",
					time: { created: PINNED_CLOCK_MS - 90_000 },
					parts: [
						{
							id: taskId,
							callID: taskId,
							type: "tool",
							tool: "Task",
							state: {
								status: match[1] === "background" ? "completed" : "running",
								input: {
									_tag: "whole",
									value: {
										tool: "Task",
										description,
										prompt,
										subagentType: "explore",
									},
								},
								...(match[1] === "background" && {
									output: {
										_tag: "whole",
										text: "The task continues in the background.",
									},
								}),
								metadata: {
									cursorToolType: "task",
									childSessionId: childId,
									subagentModel: "composer-2.5-fast",
									subagentMode: "unspecified",
									...(match[1] === "background" && { backgrounded: true }),
								},
							},
						},
					],
				},
			];
			const childMessages: HistoryMessage[] = [
				{
					id: childMessageId,
					role: "assistant",
					time: { created: PINNED_CLOCK_MS - 60_000 },
					parts: [
						{
							id: "cursor-subagents-child-thinking",
							type: "thinking",
							text: thinking,
						},
						{
							id: "cursor-subagents-child-read",
							callID: "cursor-subagents-child-read",
							type: "tool",
							tool: "Read",
							state: {
								status: "completed",
								input: {
									_tag: "whole",
									value: {
										tool: "Read",
										filePath: "src/lib/server/router.ts",
									},
								},
								output: { _tag: "whole", text: "routeProjectRequest(request)" },
								metadata: { cursorToolType: "read" },
							},
						},
						{
							id: "cursor-subagents-child-text",
							type: "text",
							text: childText,
						},
					],
				},
			];
			for (const [sessionId, messages] of [
				[parentId, parentMessages],
				[childId, childMessages],
			] as const) {
				requireRelayControl(world.page).sendMessage({
					type: "mock_transcript_snapshot",
					sessionId,
					history: { hasMore: false, messages },
				});
			}
		},
	},
	{
		name: "assert Cursor subagent card",
		match:
			/^the Cursor subagent card shows its description, type, SDK model and SDK mode$/,
		run: async ({ world, example }) => {
			const row = taskRow(world.page);
			await expect(row).toContainText(description);
			await expect(row).toContainText("explore");
			await expect(row.locator(".subagent-details")).toHaveText(
				"composer-2.5-fast · unspecified",
			);
			await expect(row).toHaveAttribute(
				"data-tool-status",
				example["mode"] === "background" ? "completed" : "running",
			);
			await expect(
				row.getByRole("button", { name: "Open subagent session" }),
			).toBeEnabled();
		},
	},
	{
		name: "open Cursor child session",
		match: /^I open the Cursor subagent's child session$/,
		run: async ({ world }) => {
			await taskRow(world.page)
				.getByRole("button", { name: "Open subagent session" })
				.click();
			await expect(world.page).toHaveURL(new RegExp(`/s/${childId}(?:\\?|$)`));
		},
	},
	{
		name: "assert Cursor child live transcript",
		match:
			/^the Cursor child shows its own live text, thinking and tool steps$/,
		run: async ({ world }) => {
			const messages = world.page.locator("#messages");
			await expect(messages.locator(".msg-user")).toHaveCount(0);
			await expect(messages).toContainText(childText);
			// A live turn names itself in the head; the Final style drops the glow.
			await expect(
				messages.locator('.turn-activity [data-testid="turn-live-head"]'),
			).toBeVisible();
			await expect(messages).not.toContainText(
				"Inspect the routing implementation",
			);
			const toggle = messages.locator(".turn-activity-toggle");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			const childThinking = messages.locator(".thinking-item");
			await childThinking.getByRole("button").click();
			await expect(childThinking).toContainText(thinking);
			await expect(
				messages.locator(
					'.tool-item[data-tool-id="cursor-subagents-child-read"]',
				),
			).toContainText("router.ts");
		},
	},
	{
		name: "assert Cursor child has no composer",
		match: /^the Cursor child is read-only with no composer$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("subagent-readonly-notice"),
			).toBeVisible();
			await expect(world.page.locator("textarea")).toHaveCount(0);
			await expect(world.page.locator("#send")).toHaveCount(0);
			await expect(world.page.locator(".subagent-back-btn")).toBeVisible();
		},
	},
	{
		name: "stream Cursor child text update",
		match: /^the Cursor child streams another live update$/,
		run: ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "delta",
				sessionId: childId,
				messageId: childMessageId,
				partId: "cursor-subagents-child-text",
				text: childUpdate,
			});
		},
	},
	{
		name: "assert Cursor child text updated once",
		match: /^the Cursor child shows the updated text exactly once$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#messages")
					.getByText(childText + childUpdate, { exact: true }),
			).toHaveCount(1);
		},
	},
	{
		name: "return to Cursor parent",
		match: /^I return from the Cursor child to its parent$/,
		run: async ({ world }) => {
			await world.page.locator(".subagent-back-btn").click();
			await expect(world.page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		},
	},
	{
		name: "assert Cursor parent stayed running",
		match: /^the Cursor parent still shows its task and running composer$/,
		run: async ({ world, example }) => {
			const toggle = world.page.locator("#messages .turn-activity-toggle");
			if ((await toggle.getAttribute("aria-expanded")) !== "true")
				await toggle.click();
			await expect(taskRow(world.page)).toContainText(description);
			await expect(taskRow(world.page)).toHaveAttribute(
				"data-tool-status",
				example["mode"] === "background" ? "completed" : "running",
			);
			await expect(world.page.locator("#messages")).not.toContainText(
				childText,
			);
			await expect(world.page.locator("textarea")).toBeVisible();
			await expect(world.page.locator("#stop")).toBeVisible();
			await expect(
				world.page.getByTestId("subagent-readonly-notice"),
			).toHaveCount(0);
		},
	},
];
