// ─── ToolItem Interaction Tests ──────────────────────────────────────────────
// Tests the ToolItem dispatcher and its three sub-components:
// ToolGenericCard, ToolQuestionCard, and ToolSubagentCard.

import { expect, test } from "@playwright/test";

const STORYBOOK = "http://localhost:6007";

function storyUrl(storyId: string): string {
	return `${STORYBOOK}/iframe.html?id=${storyId}&viewMode=story`;
}

// ─── ToolGenericCard ────────────────────────────────────────────────────────

test.describe("ToolGenericCard", () => {
	test("renders tool name and status", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--completed"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Tool name should be visible
		const toolName = page.locator(".tool-name");
		await expect(toolName).toBeVisible();
		await expect(toolName).toHaveText("Read");

		// Completed tools show the status icon (check), not the subtitle row
		const statusIcon = page.locator(".tool-status-icon");
		await expect(statusIcon).toBeVisible();
	});

	test("expands result on click", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--completed"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Result should not be visible initially
		await expect(page.locator(".tool-result")).toBeHidden();

		// Click the header to expand
		await page.locator(".tool-header").click();
		await expect(page.locator(".tool-result")).toBeVisible();
	});

	test("collapses result on second click", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--completed"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Click to expand
		await page.locator(".tool-header").click();
		await expect(page.locator(".tool-result")).toBeVisible();

		// Click again to collapse
		await page.locator(".tool-header").click();
		await expect(page.locator(".tool-result")).toBeHidden();
	});

	test("shows bash command in expanded result", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--bash-with-description"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Tool name should be Bash
		await expect(page.locator(".tool-name")).toHaveText("Bash");

		// Expand to see the command
		await page.locator(".tool-header").click();
		const result = page.locator(".tool-result");
		await expect(result).toBeVisible();

		// Should show the bash command prefixed with $
		await expect(result).toHaveText(/\$ git rev-parse HEAD/);
	});

	test("shows running shimmer animation", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--running"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Running state shows a subtitle with "Running…"
		const subtitle = page.locator(".tool-subtitle-text");
		await expect(subtitle).toBeVisible();
		await expect(subtitle).toHaveText("Running…");

		// The shimmer div should be present (pointer-events-none overlay)
		const shimmer = page.locator(".tool-item div[style*='tool-shimmer-slide']");
		await expect(shimmer).toBeAttached();
	});

	test("shows error styling for error state", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--error-state"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Tool name should be Bash
		await expect(page.locator(".tool-name")).toHaveText("Bash");

		// Subtitle should say "Error"
		const subtitle = page.locator(".tool-subtitle-text");
		await expect(subtitle).toBeVisible();
		await expect(subtitle).toHaveText("Error");

		// The status icon should have the error class
		const statusIcon = page.locator(".tool-status-icon");
		await expect(statusIcon).toHaveClass(/text-error/);

		// Expand to verify error result content
		await page.locator(".tool-header").click();
		const result = page.locator(".tool-result");
		await expect(result).toBeVisible();
		await expect(result).toHaveText(/ENOENT/);
	});
});

// ─── ToolQuestionCard ───────────────────────────────────────────────────────

test.describe("ToolQuestionCard", () => {
	test("renders interactive question card for running question", async ({
		page,
	}) => {
		await page.goto(storyUrl("chat-toolitem--question-running"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Running question with no matching pending question in store renders
		// as a synthetic interactive QuestionCard (not the read-only summary)
		const questionCard = page.locator(".question-card");
		await expect(questionCard).toBeVisible();

		// Should show the question text
		await expect(questionCard).toHaveText(/Which model would you like to use/);
	});

	test("shows answered state with answer text", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--question-answered"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Subtitle should show "Answered ✓"
		const subtitle = page.locator(".tool-subtitle-text");
		await expect(subtitle).toBeVisible();
		await expect(subtitle).toHaveText(/Answered/);

		// Should display the answer result
		const answerText = page.locator(".font-mono.whitespace-pre-wrap");
		await expect(answerText).toBeVisible();
		await expect(answerText).toHaveText(/Yes, fix it/);
	});

	test("shows skipped state", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--question-skipped"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Subtitle should show "Skipped ✗"
		const subtitle = page.locator(".tool-subtitle-text");
		await expect(subtitle).toBeVisible();
		await expect(subtitle).toHaveText(/Skipped/);
	});

	test("renders options list for answered question", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--question-answered"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Completed questions render read-only with options visible
		const options = page.locator(".question-tool-section .rounded-lg");
		expect(await options.count()).toBeGreaterThanOrEqual(2);

		// Check option labels are visible
		await expect(options.first()).toHaveText(/Production/);
	});
});

// ─── ToolSubagentCard ───────────────────────────────────────────────────────

test.describe("ToolSubagentCard", () => {
	test("renders agent type and description", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--subagent-running"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Should show the subagent header
		const header = page.locator(".subagent-header");
		await expect(header).toBeVisible();

		// Agent title should show the agent type
		const agentTitle = page.locator(".agent-title");
		await expect(agentTitle).toBeVisible();
		await expect(agentTitle).toHaveText(/explore Agent/i);

		// Description should be visible
		const description = page.locator(".subagent-link");
		await expect(description).toBeVisible();
		await expect(description).toHaveText(/Explore test infrastructure/);
	});

	test("shows navigation arrow when session available", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--subagent-completed"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Completed subagent has a session ID in result ("task_id: ses_abc123")
		// so it should show a navigation arrow
		const header = page.locator(".subagent-header");
		await expect(header).toBeVisible();

		// The arrow-right icon should be rendered
		const arrow = header.locator("svg").last();
		await expect(arrow).toBeVisible();

		// The button should be enabled (not disabled) when session is available
		await expect(header).not.toBeDisabled();
	});

	test("shows running state with block grid", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--subagent-running"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Running state should show "Running…" subtitle
		const subtitle = page.locator(".tool-subtitle-text");
		await expect(subtitle).toBeVisible();
		await expect(subtitle).toHaveText("Running…");

		// Should show the block grid animation instead of a static icon
		// BlockGrid renders as a div with inline grid styles
		const blockGrid = page.locator(".subagent-header [style*='grid']");
		await expect(blockGrid).toBeAttached();
	});
});

// ─── ToolItem group positioning ─────────────────────────────────────────────

test.describe("ToolItem group positioning", () => {
	test("first in group has top rounded corners", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--first-in-group"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// The inner card div (first child of .tool-item) should have rounded-t class
		const card = page.locator(".tool-item > div");
		await expect(card).toHaveClass(/rounded-t-\[10px\]/);
		// Should NOT have bottom rounding
		await expect(card).not.toHaveClass(/rounded-b-\[10px\]/);
	});

	test("middle of group has no rounded corners", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--middle-of-group"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// Middle items should have no rounding classes
		const card = page.locator(".tool-item > div");
		await expect(card).not.toHaveClass(/rounded-t-\[10px\]/);
		await expect(card).not.toHaveClass(/rounded-b-\[10px\]/);
		await expect(card).not.toHaveClass(/rounded-\[10px\]/);
	});

	test("last in group has bottom rounded corners", async ({ page }) => {
		await page.goto(storyUrl("chat-toolitem--last-in-group"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".tool-item");
		await page.waitForTimeout(200);

		// The inner card div should have rounded-b class
		const card = page.locator(".tool-item > div");
		await expect(card).toHaveClass(/rounded-b-\[10px\]/);
		// Should NOT have top rounding
		await expect(card).not.toHaveClass(/rounded-t-\[10px\]/);
	});
});
