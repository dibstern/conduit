import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import {
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const sessionId = "sess-first-send";
const messageId = "cursor-turn-assistant";

export const cursorTurnHandlers: StepHandler[] = [
	{
		name: "prepare Cursor turn relay",
		match: /^the Cursor turn relay is ready$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const getModels = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			const getAgents = rpc.stubs.GetAgents ?? rpc.catalogStubs().GetAgents;
			rpc.setStubs({
				GetModels: (payload) =>
					("sessionId" in payload && payload.sessionId === sessionId) ||
					payload.instanceId === "cursor-work"
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providers: [],
								active: { provider: "cursor", model: "composer-2.5" },
							}
						: getModels(payload),
				GetAgents: (payload) =>
					("sessionId" in payload && payload.sessionId === sessionId) ||
					payload.instanceId === "cursor-work"
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providerScope: { id: "cursor", name: "Cursor" },
								agents: [],
							}
						: getAgents(payload),
			});
			rpc.setStubs({ CancelSession: () => ({ ok: true }) });
		},
	},
	{
		name: "assert Cursor turn selection",
		match: /^the relay creates a Cursor session with model (\S+)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "CreateSession",
			);
			expect(request.payload["instanceId"]).toBe("cursor-work");
			expect(request.payload["model"]).toMatchObject({
				providerId: "cursor",
				modelId: match[1],
			});
			await rpc.waitForRequest(
				(candidate) =>
					candidate.tag === "input.submit" &&
					candidate.payload["sessionId"] === sessionId,
			);
		},
	},
	{
		name: "assert Cursor approval notice",
		match: /^the Cursor notice reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("composer-provider-notice"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "start sent Cursor turn",
		match: /^the Cursor relay starts the sent turn$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) =>
					candidate.tag === "input.submit" &&
					candidate.payload["sessionId"] === sessionId,
			);
			requireRelayControl(world.page).sendMessage({
				type: "user_message",
				sessionId,
				messageId: "cursor-turn-user",
				text: request.payload["text"],
				inputId: request.payload["inputId"],
			});
			setSessionRowStatus(world.page, sessionId, "busy");
			await expect(world.page.locator("#stop")).toBeVisible();
		},
	},
	{
		name: "stream Cursor text or thinking",
		match: /^the Cursor relay streams (text|thinking) (.+)$/,
		run: ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: match[1] === "thinking" ? "thinking_delta" : "delta",
				sessionId,
				messageId,
				text: match[2],
			});
		},
	},
	{
		name: "assert streamed Cursor thinking",
		match: /^the Cursor thinking contains (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.locator("#messages .thinking-item"),
			).toContainText(match[1] ?? "");
		},
	},
	{
		name: "finish Cursor turn",
		match: /^the Cursor relay (completes the turn|confirms the interrupt)$/,
		run: ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: "done",
				sessionId,
				messageId,
				code: match[1] === "confirms the interrupt" ? 130 : 0,
			});
			setSessionRowStatus(world.page, sessionId, "idle");
		},
	},
	{
		name: "interrupt Cursor turn",
		match: /^I interrupt the Cursor turn$/,
		run: async ({ world }) => {
			await world.page.locator("#stop").click();
		},
	},
	{
		name: "assert Cursor interrupt request",
		match: /^the relay receives the Cursor interrupt$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "CancelSession" &&
					request.payload["sessionId"] === sessionId,
			);
		},
	},
	{
		name: "assert idle Cursor composer",
		match: /^the Cursor composer is idle$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#stop")).toBeHidden();
			await expect(world.page.locator("#send")).toBeVisible();
		},
	},
];
