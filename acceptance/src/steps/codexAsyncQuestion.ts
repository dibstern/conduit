import { expect } from "@playwright/test";
import type { Approval } from "../../../src/lib/shared-types.js";
import type { StepHandler } from "../runtime.js";
import {
	mockInstances,
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const sessionId = "sess-first-send";
const toolId = "codex-async-question";
const toolUseId = "codex-async-question-call";
const titles = [
	"Which database should I use?",
	"What else should I consider?",
] as const;
const questions = [
	{
		question: titles[0],
		header: "",
		options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
		multiSelect: false,
		custom: true,
	},
	{
		question: titles[1],
		header: "",
		options: [],
		multiSelect: false,
		custom: true,
	},
];

export const codexAsyncQuestionHandlers: StepHandler[] = [
	{
		name: "prepare Codex async question relay",
		match: /^the Codex async question relay is ready$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const relay = requireRelayControl(world.page);
			const instances = [
				...(mockInstances.get(world.page) ?? []),
				{
					id: "codex-work",
					name: "Codex work",
					driver: "codex",
					isDefault: true,
					usageEligible: false,
					available: true,
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				},
			];
			mockInstances.set(world.page, instances);
			rpc.setDaemonList("SubscribeInstances", { instances });
			rpc.setProjectSetting({
				_tag: "providerModels",
				accountId: "codex-work",
				providers: [
					{
						id: "codex",
						name: "Codex",
						configured: true,
						models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "codex" }],
					},
				],
			});
			const getModels = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			const getAgents = rpc.stubs.GetAgents ?? rpc.catalogStubs().GetAgents;
			rpc.setStubs({
				GetModels: (payload) =>
					payload.instanceId === "codex-work" ||
					("sessionId" in payload && payload.sessionId === sessionId)
						? {
								projectSlug: "myapp",
								instanceId: "codex-work",
								providers: [],
								active: { provider: "codex", model: "gpt-5.5" },
							}
						: getModels(payload),
				GetAgents: (payload) =>
					payload.instanceId === "codex-work" ||
					("sessionId" in payload && payload.sessionId === sessionId)
						? {
								projectSlug: "myapp",
								instanceId: "codex-work",
								providerScope: { id: "codex", name: "Codex" },
								agents: [],
							}
						: getAgents(payload),
				AnswerQuestion: ({ answers }) => {
					// Mirror the daemon's normal user-message echo after AnswerQuestion.
					// Daemon integration tests verify the actual steer/start handoff.
					const text = questions
						.map(
							(question, index) =>
								`${question.question}\n${answers[String(index)]}`,
						)
						.join("\n\n");
					rpc.sendChunk("SubscribeApprovals", [
						{ _tag: "remove", id: toolId, sequence: 2 },
					]);
					relay.sendMessage({
						type: "tool_result",
						sessionId,
						id: toolUseId,
						content: text,
						is_error: false,
					});
					relay.sendMessage({
						type: "user_message",
						sessionId,
						messageId: "codex-async-answer",
						text,
					});
					return { ok: true };
				},
				RejectQuestion: () => {
					rpc.sendChunk("SubscribeApprovals", [
						{ _tag: "remove", id: toolId, sequence: 2 },
					]);
					relay.sendMessage({
						type: "tool_result",
						sessionId,
						id: toolUseId,
						content: "null",
						is_error: false,
					});
					return { ok: true };
				},
			});
		},
	},
	{
		name: "ask Codex async questions during the sent turn",
		match: /^the Codex relay asks two async questions$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) =>
					candidate.tag === "input.submit" &&
					candidate.payload["sessionId"] === sessionId,
			);
			const created = await rpc.waitForRequest(
				(candidate) => candidate.tag === "CreateSession",
			);
			expect(created.payload["instanceId"]).toBe("codex-work");
			setSessionRowStatus(world.page, sessionId, "busy", {
				attention: "working",
				pendingQuestionCount: 0,
			});
			await requireRelayControl(world.page).sendMessages([
				{
					type: "user_message",
					sessionId,
					messageId: "codex-async-user",
					text: request.payload["text"],
					inputId: request.payload["inputId"],
				},
				{
					type: "delta",
					sessionId,
					messageId: "codex-async-agent",
					text: "I will keep investigating while you decide.",
				},
				{
					type: "tool_start",
					sessionId,
					id: toolUseId,
					name: "AskUserQuestion",
				},
				{
					type: "tool_executing",
					sessionId,
					id: toolUseId,
					name: "AskUserQuestion",
					input: { delivery: "async", questions },
				},
				{
					type: "tool_result",
					sessionId,
					id: toolUseId,
					content: "null",
					is_error: false,
				},
			]);
			const approval = {
				_tag: "question",
				sessionId,
				toolId,
				toolUseId,
				providerId: "codex",
				delivery: "async",
				questions,
			} satisfies Approval;
			rpc.sendChunk("SubscribeApprovals", [
				{ _tag: "upsert", sequence: 1, item: approval },
			]);
		},
	},
	{
		name: "assert non-blocking Codex async question card",
		match: /^the Codex async card says Answer anytime$/,
		run: async ({ world }) => {
			const card = world.page.locator(".question-card");
			await expect(card).toHaveCount(1);
			await expect(card.locator(".question-title")).toHaveText(
				"Answer anytime",
			);
			await expect(card.locator(".question-text")).toHaveText(titles);
			await expect(card.locator(".question-synthetic-warning")).toHaveCount(0);
			await expect(
				card.getByRole("button", { name: "Dismiss question" }),
			).toBeVisible();
			await expect(card.getByRole("button", { name: "Skip" })).toHaveCount(0);
			await expect(
				world.page.getByText("I will keep investigating while you decide.", {
					exact: true,
				}),
			).toBeVisible();
		},
	},
	{
		name: "finish Codex turn with async questions pending",
		match:
			/^the Codex relay completes the turn with the async question pending$/,
		run: ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "done",
				sessionId,
				messageId: "codex-async-agent",
				code: 0,
			});
			setSessionRowStatus(world.page, sessionId, "idle", {
				attention: "idle",
				pendingQuestionCount: 0,
			});
		},
	},
	{
		name: "assert Codex async question does not block the composer",
		match: /^the Codex async question leaves the composer idle$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#stop")).toBeHidden();
			await expect(world.page.locator("#send")).toHaveAttribute(
				"aria-label",
				"Send",
			);
			await expect(world.page.locator(".question-submit-btn")).toBeVisible();
		},
	},
	{
		name: "answer both Codex async questions",
		match:
			/^I answer the Codex async question with (option|custom) (.+) and context (.+)$/,
		run: async ({ world, match }) => {
			const card = world.page.locator(".question-card");
			if (match[1] === "custom")
				await card
					.getByPlaceholder("Type your answer")
					.nth(0)
					.fill(match[2] ?? "");
			else await card.getByText(match[2] ?? "", { exact: true }).click();
			await card
				.getByPlaceholder("Type your answer")
				.nth(1)
				.fill(match[3] ?? "");
			await card.locator(".question-submit-btn").click();
		},
	},
	{
		name: "assert Codex async answer becomes a formatted user message",
		match: /^the Codex async answer is sent as (.+) with context (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "AnswerQuestion",
			);
			expect(request.payload["toolId"]).toBe(toolId);
			expect(request.payload["answers"]).toEqual({
				"0": match[1],
				"1": match[2],
			});
			await expect(
				world.page.locator("#messages .msg-user").last(),
			).toContainText(`${titles[0]}\n${match[1]}\n\n${titles[1]}\n${match[2]}`);
			await expect(world.page.locator(".tool-subtitle-text")).toContainText(
				"Answered",
			);
		},
	},
	{
		name: "dismiss Codex async question",
		match: /^I dismiss the Codex async question$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Dismiss question" })
				.click();
		},
	},
	{
		name: "assert Codex async dismissal sends nothing",
		match: /^the Codex async question is dismissed without a message$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "RejectQuestion",
			);
			expect(request.payload["toolId"]).toBe(toolId);
			expect(
				rpc
					.getRequests()
					.filter((candidate) => candidate.tag === "AnswerQuestion"),
			).toHaveLength(0);
			expect(
				rpc
					.getRequests()
					.filter((candidate) => candidate.tag === "input.submit"),
			).toHaveLength(1);
			await expect(world.page.locator("#messages .msg-user")).toHaveCount(1);
			await expect(
				world.page.getByText("Dismissed", { exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "assert resolved Codex async question controls are hidden",
		match: /^the Codex async question has no answer controls$/,
		run: async ({ world }) => {
			await expect(world.page.locator(".question-card")).toHaveCount(0);
			await expect(
				world.page.getByRole("button", { name: "Dismiss question" }),
			).toHaveCount(0);
			await expect(world.page.locator(".question-submit-btn")).toHaveCount(0);
		},
	},
];
