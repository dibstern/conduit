import { expect } from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const sourceId = "sess-fork-source";
const forkId = "sess-portable-fork";
const forkPointId = "fork-source-reply";
const forkPointTimestamp = PINNED_CLOCK_MS - 90_000;
const sourceTitle = "Remember a marker";
const markerPrompt = "Remember the marker violet-cascade.";
const markerReply = "I will remember violet-cascade.";
const laterPrompt = "Keep this later exchange in the source.";
const laterReply = "This exchange belongs only to the source.";
const forkPrompt = "Which marker did I ask you to remember?";
const forkReply = "The marker was violet-cascade.";

const sourceMessages: HistoryMessage[] = [
	{
		id: "fork-source-prompt",
		role: "user",
		time: { created: forkPointTimestamp - 1_000 },
		parts: [
			{ id: "fork-source-prompt-text", type: "text", text: markerPrompt },
		],
	},
	{
		id: forkPointId,
		parentID: "fork-source-prompt",
		role: "assistant",
		time: { created: forkPointTimestamp, completed: forkPointTimestamp + 100 },
		parts: [{ id: "fork-source-reply-text", type: "text", text: markerReply }],
	},
	{
		id: "fork-source-later-prompt",
		role: "user",
		time: { created: forkPointTimestamp + 1_000 },
		parts: [
			{ id: "fork-source-later-prompt-text", type: "text", text: laterPrompt },
		],
	},
	{
		id: "fork-source-later-reply",
		parentID: "fork-source-later-prompt",
		role: "assistant",
		time: {
			created: forkPointTimestamp + 2_000,
			completed: forkPointTimestamp + 2_100,
		},
		parts: [
			{ id: "fork-source-later-reply-text", type: "text", text: laterReply },
		],
	},
];

export const cursorForkHandlers: StepHandler[] = [
	{
		name: "prepare completed conversation for forking",
		match:
			/^a completed (Cursor|Claude|OpenCode) conversation is ready to fork$/,
		run: async ({ world, match }) => {
			const driver = (match[1] ?? "").toLowerCase();
			const accountId = driver === "cursor" ? "cursor-work" : driver;
			const model =
				driver === "cursor"
					? { provider: "cursor", model: "composer-2.5" }
					: driver === "claude"
						? { provider: "claude", model: "claude-sonnet-4-5" }
						: { provider: "anthropic", model: "claude-sonnet-4" };
			const rpc = requireRpcControl(world.page);
			const relay = requireRelayControl(world.page);
			const getModels = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			const getAgents = rpc.stubs.GetAgents ?? rpc.catalogStubs().GetAgents;
			const sourceRow = {
				id: sourceId,
				title: sourceTitle,
				accountId,
				model,
				status: "idle",
				messageCount: sourceMessages.length,
				updatedAt: PINNED_CLOCK_MS,
			};
			rpc.setStubs({
				GetModels: (payload) =>
					"sessionId" in payload &&
					(payload.sessionId === sourceId || payload.sessionId === forkId)
						? {
								projectSlug: "myapp",
								instanceId: accountId,
								providers: [],
								active: model,
							}
						: getModels(payload),
				GetAgents: (payload) =>
					driver === "cursor" &&
					"sessionId" in payload &&
					(payload.sessionId === sourceId || payload.sessionId === forkId)
						? {
								projectSlug: "myapp",
								instanceId: accountId,
								providerScope: { id: driver, name: match[1] ?? "" },
								agents: [],
							}
						: getAgents(payload),
				ForkSession: () => {
					const forkMessages = sourceMessages.slice(0, 2).map((message) => ({
						...message,
						id: `${message.id}_${forkId}`,
						...(message.parentID && {
							parentID: `${message.parentID}_${forkId}`,
						}),
						parts: message.parts?.map((part) => ({
							...part,
							id: `${part.id}_${forkId}`,
						})),
					}));
					const forkRow = {
						...sourceRow,
						id: forkId,
						title: "Marker fork",
						forkedFrom: sourceId,
						forkMessageId: forkPointId,
						forkPointMessageId: `${forkPointId}_${forkId}`,
						forkPointTimestamp,
						messageCount: 2,
					};
					rpc.upsertShellRow(forkRow);
					rpc.setFamilyRows([sourceRow, forkRow]);
					relay.sendMessage({
						type: "mock_transcript_snapshot",
						sessionId: forkId,
						history: { hasMore: false, messages: forkMessages },
					});
					return {
						projectSlug: "myapp",
						sessionId: forkId,
						forkedFrom: sourceId,
						forkMessageId: forkPointId,
						forkPointTimestamp,
					};
				},
			});
			rpc.upsertShellRow(sourceRow);
			rpc.setFamilyRows([sourceRow]);
			relay.sendMessage({
				type: "mock_transcript_snapshot",
				sessionId: sourceId,
				history: { hasMore: false, messages: sourceMessages },
			});
			await openSessionRoute(world.page, sourceId);
			await expect(world.page.locator("#messages .msg-assistant")).toHaveCount(
				2,
			);
		},
	},
	{
		name: "assert completed reply fork affordance",
		match: /^the completed reply offers Fork from here$/,
		run: async ({ world }) => {
			const reply = world.page.locator("#messages .msg-assistant").first();
			await reply.hover();
			await expect(
				reply.getByRole("button", { name: "Fork from here" }),
			).toBeEnabled();
		},
	},
	{
		name: "fork completed reply",
		match: /^I fork the completed reply$/,
		run: async ({ world }) => {
			await world.page
				.locator("#messages .msg-assistant")
				.first()
				.getByRole("button", { name: "Fork from here" })
				.click();
		},
	},
	{
		name: "assert selected fork boundary",
		match: /^the relay receives the selected fork point$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "ForkSession",
			);
			expect(request.payload).toMatchObject({
				sessionId: sourceId,
				messageId: forkPointId,
			});
			expect(request.payload["originId"]).toEqual(expect.any(String));
		},
	},
	{
		name: "assert existing fork view",
		match:
			/^the fork opens with collapsed prior conversation and a source link$/,
		run: async ({ world }) => {
			await expect(world.page).toHaveURL(new RegExp(`/s/${forkId}(?:\\?|$)`));
			await expect(world.page.locator(".fork-context-toggle")).toHaveAttribute(
				"aria-expanded",
				"false",
			);
			await expect(world.page.locator(".fork-context-messages")).toHaveCount(0);
			await expect(world.page.locator(".fork-divider")).toContainText(
				"Forked from",
			);
			await expect(
				world.page
					.locator(".fork-divider")
					.getByRole("button", { name: sourceTitle, exact: true }),
			).toBeVisible();
			await expect(world.page.locator(".subagent-back-btn")).toHaveCount(0);
		},
	},
	{
		name: "assert fork account stays bound",
		match: /^the fork composer keeps the (Cursor|Claude|OpenCode) account$/,
		run: async ({ world, match }) => {
			const driver = (match[1] ?? "").toLowerCase();
			const trigger = world.page
				.locator(
					'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
				)
				.first();
			await expect(trigger).toHaveAttribute(
				"data-instance-id",
				driver === "cursor" ? "cursor-work" : driver,
			);
			await expect(trigger).toHaveAttribute("data-shown-harness", driver);
			await expect(world.page.locator("#input")).toBeEditable();
		},
	},
	{
		name: "expand inherited fork messages",
		match: /^I expand the fork's prior conversation$/,
		run: async ({ world }) => {
			await world.page.locator(".fork-context-toggle").click();
			await expect(world.page.locator(".fork-context-toggle")).toHaveAttribute(
				"aria-expanded",
				"true",
			);
		},
	},
	{
		name: "assert fork inherits selected context",
		match: /^the fork shows only context through the selected reply$/,
		run: async ({ world }) => {
			const inherited = world.page.locator(".fork-context-messages");
			await expect(inherited).toContainText(markerPrompt);
			await expect(inherited).toContainText(markerReply);
			await expect(inherited.locator(".msg-user")).toHaveCount(1);
			await expect(inherited.locator(".msg-assistant")).toHaveCount(1);
			await expect(world.page.locator("#messages")).not.toContainText(
				laterPrompt,
			);
			await expect(world.page.locator("#messages")).not.toContainText(
				laterReply,
			);
		},
	},
	{
		name: "continue fork with marker question",
		match: /^I continue the fork with a marker question$/,
		run: async ({ world }) => {
			await world.page.locator("#input").fill(forkPrompt);
			await world.page.locator("#send").click();
			const request = await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["sessionId"] === forkId &&
					request.payload["text"] === forkPrompt,
			);
			const relay = requireRelayControl(world.page);
			relay.sendMessage({
				type: "user_message",
				sessionId: forkId,
				messageId: "fork-question",
				text: forkPrompt,
				inputId: request.payload["inputId"],
			});
			setSessionRowStatus(world.page, forkId, "busy");
			relay.sendMessage({
				type: "delta",
				sessionId: forkId,
				messageId: "fork-answer",
				text: forkReply,
			});
			relay.sendMessage({
				type: "done",
				sessionId: forkId,
				messageId: "fork-answer",
				code: 0,
			});
			setSessionRowStatus(world.page, forkId, "idle");
		},
	},
	{
		name: "assert fork continuation is separate from context",
		match: /^the fork reply appears outside its prior conversation$/,
		run: async ({ world }) => {
			const inherited = world.page.locator(".fork-context-messages");
			await expect(
				world.page.locator("#messages").getByText(forkReply, { exact: true }),
			).toHaveCount(1);
			await expect(inherited).not.toContainText(forkPrompt);
			await expect(inherited).not.toContainText(forkReply);
			await expect(world.page.locator("#messages .msg-user")).toHaveCount(2);
			await expect(world.page.locator("#messages .msg-assistant")).toHaveCount(
				2,
			);
			await expect(world.page.locator("#stop")).toBeHidden();
		},
	},
	{
		name: "return to source through fork divider",
		match: /^I return through the fork's source link$/,
		run: async ({ world }) => {
			await world.page
				.locator(".fork-divider")
				.getByRole("button", { name: sourceTitle, exact: true })
				.click();
			await expect(world.page).toHaveURL(new RegExp(`/s/${sourceId}(?:\\?|$)`));
		},
	},
	{
		name: "assert source conversation remains unchanged",
		match: /^the source conversation still has its original messages$/,
		run: async ({ world }) => {
			const transcript = world.page.locator("#messages");
			for (const text of [markerPrompt, markerReply, laterPrompt, laterReply]) {
				await expect(transcript).toContainText(text);
			}
			await expect(transcript.locator(".msg-user")).toHaveCount(2);
			await expect(transcript.locator(".msg-assistant")).toHaveCount(2);
			await expect(transcript).not.toContainText(forkPrompt);
			await expect(transcript).not.toContainText(forkReply);
			await expect(transcript.locator(".fork-context-block")).toHaveCount(0);
		},
	},
];
