// ─── Question Flow E2E Tests ─────────────────────────────────────────────────
// Tests the full question/answer lifecycle via WS mock:
//   1. Agent asks a question → QuestionCard appears
//   2. User selects an option and submits
//   3. Frontend sends ask_user_response back to the relay
//   4. Agent continues processing after the answer → more deltas/done arrive
//
// Uses WS mock — no real OpenCode or relay needed.
// Reproduces: "When I answer a question in a session, the agent doesn't respond."

import { expect, test } from "@playwright/test";
import { initMessages, type MockMessage } from "../fixtures/mockup-state.js";
import { mockRelayWebSocket, type WsMockControl } from "../helpers/ws-mock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;

const PROJECT_URL = "/p/myapp/";

/** Wait for the chat page to be ready (WS connected, input visible). */
async function waitForChatReady(page: Page): Promise<void> {
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	await page.locator(".connect-overlay").waitFor({
		state: "hidden",
		timeout: 10_000,
	});
}

// ─── Question messages ──────────────────────────────────────────────────────

/** Messages that simulate the agent asking a question */
const questionResponseMessages: MockMessage[] = [
	{ type: "status", status: "processing" },
	{
		type: "tool_start",
		id: "toolu_question_001",
		name: "AskUserQuestion",
	},
	{
		type: "tool_executing",
		id: "toolu_question_001",
		name: "AskUserQuestion",
		input: {
			questions: [
				{
					question: "Which database should I use?",
					header: "Database",
					options: [
						{
							label: "PostgreSQL",
							description: "Relational database",
						},
						{ label: "MongoDB", description: "Document database" },
					],
				},
			],
		},
	},
	{
		type: "ask_user",
		toolId: "que_question_001",
		questions: [
			{
				question: "Which database should I use?",
				header: "Database",
				options: [
					{
						label: "PostgreSQL",
						description: "Relational database",
					},
					{ label: "MongoDB", description: "Document database" },
				],
				multiSelect: false,
				custom: true,
			},
		],
	},
];

/** Messages that simulate the agent continuing after the answer */
const postAnswerMessages: MockMessage[] = [
	{
		type: "ask_user_resolved",
		toolId: "que_question_001",
	},
	{
		type: "tool_result",
		id: "toolu_question_001",
		content: "User selected: PostgreSQL",
		is_error: false,
	},
	{
		type: "delta",
		text: "Great choice! I'll set up PostgreSQL for your project.",
	},
	{ type: "done", code: 0 },
	{ type: "status", status: "idle" },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe("Question/Answer Flow", () => {
	let control: WsMockControl;

	test("question card appears when agent asks a question", async ({
		page,
		baseURL,
	}) => {
		control = await mockRelayWebSocket(page, {
			initMessages: [...initMessages],
			responses: new Map([
				["Ask me about databases", questionResponseMessages],
			]),
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Send a user message that triggers the question
		await page.locator("#input").fill("Ask me about databases");
		await page.locator("#input").press("Enter");

		// Wait for the question card to appear
		const questionCard = page.locator(".question-card");
		await expect(questionCard).toBeVisible({ timeout: 10_000 });

		// Verify question content is rendered
		await expect(questionCard).toContainText("Database");
		await expect(questionCard).toContainText("Which database should I use?");
		await expect(questionCard).toContainText("PostgreSQL");
		await expect(questionCard).toContainText("MongoDB");

		// Verify Submit and Skip buttons exist
		await expect(questionCard.locator(".question-submit-btn")).toBeVisible();
		await expect(questionCard.locator(".question-skip-btn")).toBeVisible();
	});

	test("user can select an option and submit an answer", async ({
		page,
		baseURL,
	}) => {
		control = await mockRelayWebSocket(page, {
			initMessages: [...initMessages],
			responses: new Map([
				["Ask me about databases", questionResponseMessages],
			]),
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Send a user message
		await page.locator("#input").fill("Ask me about databases");
		await page.locator("#input").press("Enter");

		// Wait for question card
		const questionCard = page.locator(".question-card");
		await expect(questionCard).toBeVisible({ timeout: 10_000 });

		// Submit button should be disabled initially (no selection)
		const submitBtn = questionCard.locator(".question-submit-btn");
		await expect(submitBtn).toBeDisabled();

		// Select PostgreSQL
		await questionCard
			.locator(".question-option-label", { hasText: "PostgreSQL" })
			.click();

		// Submit button should now be enabled
		await expect(submitBtn).toBeEnabled();

		// Click submit
		await submitBtn.click();

		// Verify the frontend sent ask_user_response
		const answerMsg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as Record<string, unknown>)["type"] === "ask_user_response",
		);

		expect(answerMsg).toMatchObject({
			type: "ask_user_response",
			toolId: "que_question_001",
			answers: { "0": "PostgreSQL" },
		});

		// Card should show "Answered ✓"
		await expect(questionCard.locator(".question-resolved-ok")).toBeVisible();
	});

	test("agent continues responding after user answers a question", async ({
		page,
		baseURL,
	}) => {
		// This test reproduces the bug: "When I answer a question, the agent
		// doesn't respond." The ws-mock is set up so that when the frontend
		// sends ask_user_response, we inject the post-answer messages
		// (simulating the agent continuing).

		control = await mockRelayWebSocket(page, {
			initMessages: [...initMessages],
			responses: new Map([
				["Ask me about databases", questionResponseMessages],
			]),
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Send a user message
		await page.locator("#input").fill("Ask me about databases");
		await page.locator("#input").press("Enter");

		// Wait for question card
		const questionCard = page.locator(".question-card");
		await expect(questionCard).toBeVisible({ timeout: 10_000 });

		// Select PostgreSQL and submit
		await questionCard
			.locator(".question-option-label", { hasText: "PostgreSQL" })
			.click();
		await questionCard.locator(".question-submit-btn").click();

		// Wait for the frontend to send the answer
		await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as Record<string, unknown>)["type"] === "ask_user_response",
		);

		// NOW simulate the agent continuing after the answer
		// (in the real system, the relay receives OpenCode SSE events
		// and forwards them to the browser)
		await control.sendMessages(postAnswerMessages, 50);

		// The assistant should show the post-answer response text
		const assistantMessage = page.locator(".md-content").last();
		await expect(assistantMessage).toContainText(
			"Great choice! I'll set up PostgreSQL",
			{ timeout: 10_000 },
		);

		// The processing indicator should be cleared (done received)
		// Verify the stop button is NOT visible (processing ended)
		await expect(page.locator("#stop")).not.toBeVisible({ timeout: 5_000 });
	});

	test("user can skip a question", async ({ page, baseURL }) => {
		control = await mockRelayWebSocket(page, {
			initMessages: [...initMessages],
			responses: new Map([
				["Ask me about databases", questionResponseMessages],
			]),
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Send a user message
		await page.locator("#input").fill("Ask me about databases");
		await page.locator("#input").press("Enter");

		// Wait for question card
		const questionCard = page.locator(".question-card");
		await expect(questionCard).toBeVisible({ timeout: 10_000 });

		// Click Skip
		await questionCard.locator(".question-skip-btn").click();

		// Verify the frontend sent question_reject
		const rejectMsg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as Record<string, unknown>)["type"] === "question_reject",
		);
		expect(rejectMsg).toMatchObject({
			type: "question_reject",
			toolId: "que_question_001",
		});

		// Card should show "Skipped ✗"
		await expect(questionCard.locator(".question-resolved-skip")).toBeVisible();
	});
});
