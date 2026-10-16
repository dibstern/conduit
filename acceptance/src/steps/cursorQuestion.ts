import { expect } from "@playwright/test";
import type { Approval } from "../../../src/lib/shared-types.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const sessionId = "sess-first-send";
const toolId = "cursor-question";
const toolUseId = "cursor-question-call";

export const cursorQuestionHandlers: StepHandler[] = [
	{
		name: "prepare Cursor question relay",
		match: /^the Cursor question relay is ready$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				AnswerQuestion: () => ({ ok: true }),
			});
		},
	},
	{
		name: "ask Cursor question in the parent session",
		match: /^the Cursor relay asks a question headed (.+)$/,
		run: async ({ world, match }) => {
			const approval = {
				_tag: "question",
				sessionId,
				toolId,
				toolUseId,
				providerId: "cursor",
				questions: [
					{
						question: "Which database should I use?",
						header: match[1] ?? "",
						options: [
							{ label: "PostgreSQL", description: "Relational database" },
							{ label: "MongoDB", description: "Document database" },
						],
						multiSelect: false,
						custom: true,
					},
				],
			} satisfies Approval;
			await requireRelayControl(world.page).sendMessages([
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
					input: {
						tool: "AskUserQuestion",
						questions: approval.questions.map((question) => ({
							...question,
							header: "Database",
						})),
					},
				},
			]);
			requireRpcControl(world.page).sendChunk("SubscribeApprovals", [
				{ _tag: "upsert", sequence: 1, item: approval },
			]);
		},
	},
	{
		name: "assert Cursor question content and subagent attribution",
		match: /^the Cursor question shows header (.+)$/,
		run: async ({ world, match }) => {
			const card = world.page.locator(".question-card");
			await expect(
				world.page.locator(`[data-tool-id="${toolUseId}"]`),
			).toHaveAttribute("data-tool-status", "running");
			await expect(card).toHaveCount(1);
			await expect(card).toBeVisible();
			await expect(card.locator(".question-synthetic-warning")).toHaveCount(0);
			await expect(card.locator(".question-header")).toHaveText(match[1] ?? "");
			await expect(card.locator(".question-text")).toHaveText(
				"Which database should I use?",
			);
			await expect(card.locator(".question-option-label")).toHaveText([
				"PostgreSQL",
				"MongoDB",
				"Other",
			]);
			await expect(card.getByPlaceholder("Type your answer")).toBeVisible();
			await expect(card.locator(".question-submit-btn")).toBeDisabled();
		},
	},
	{
		name: "check Cursor question fits the viewport",
		match: /^the Cursor question prompt fits the viewport$/,
		run: async ({ world }) => {
			const card = world.page.locator(".question-card");
			await card.scrollIntoViewIfNeeded();
			const bounds = await card.boundingBox();
			const viewport = world.page.viewportSize();
			if (!bounds || !viewport)
				throw new Error("Cursor question has no bounds");
			expect(bounds.x).toBeGreaterThanOrEqual(0);
			expect(bounds.y).toBeGreaterThanOrEqual(0);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
			expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
		},
	},
	{
		name: "answer Cursor question with an option or custom text",
		match: /^I answer the Cursor question with (option|custom) (.+)$/,
		run: async ({ world, match }) => {
			const card = world.page.locator(".question-card");
			if (match[1] === "custom") {
				await card.getByPlaceholder("Type your answer").fill(match[2] ?? "");
			} else {
				await card.getByText(match[2] ?? "", { exact: true }).click();
			}
			await expect(card.locator(".question-submit-btn")).toBeEnabled();
			await card.locator(".question-submit-btn").click();
		},
	},
	{
		name: "assert Cursor question answer RPC",
		match: /^the relay receives the Cursor question answer (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "AnswerQuestion",
			);
			expect(request.payload["projectSlug"]).toBe("myapp");
			expect(request.payload["toolId"]).toBe(toolId);
			expect(request.payload["answers"]).toEqual({ "0": match[1] });
		},
	},
	{
		name: "assert answered Cursor question leaves the pending form",
		match: /^the Cursor question is cleared after answering$/,
		run: async ({ world }) => {
			await expect(world.page.locator(".question-card")).toHaveCount(0);
			await expect(
				world.page.locator(`[data-tool-id="${toolUseId}"]`),
			).toHaveAttribute("data-tool-status", "completed");
		},
	},
	{
		name: "continue Cursor turn after question answer",
		match: /^the Cursor relay continues after the answer (.+)$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).sendChunk("SubscribeApprovals", [
				{ _tag: "remove", id: toolId, sequence: 2 },
			]);
			await requireRelayControl(world.page).sendMessages([
				{
					type: "tool_result",
					sessionId,
					id: toolUseId,
					content: JSON.stringify({ "0": match[1] }),
					is_error: false,
				},
				{
					type: "delta",
					sessionId,
					messageId: "cursor-turn-assistant",
					text: `Using ${match[1]}.`,
				},
			]);
		},
	},
	{
		name: "assert settled Cursor question controls",
		match: /^the Cursor question has no answer controls$/,
		run: async ({ world }) => {
			await expect(world.page.locator(".question-card")).toHaveCount(0);
			await expect(
				world.page.locator(`[data-tool-id="${toolUseId}"]`),
			).toHaveAttribute("data-tool-status", "completed");
			await expect(
				world.page.locator(".question-card .question-submit-btn"),
			).toHaveCount(0);
			await expect(world.page.locator(".question-card input")).toHaveCount(0);
		},
	},
];
