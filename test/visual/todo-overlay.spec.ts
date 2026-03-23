// ─── TodoOverlay / TodoHeader / TodoProgressBar / TodoItemRow Tests ──────────
// Playwright tests that navigate to Storybook story iframes and assert
// component behavior for the todo overlay and its sub-components.

import { expect, test } from "@playwright/test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STORY_URL = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

async function navigateToStory(
	page: import("@playwright/test").Page,
	storyId: string,
): Promise<void> {
	await page.goto(STORY_URL(storyId), { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(800);
	await page.waitForSelector(".todo-overlay", { timeout: 5_000 });
}

// ─── TodoHeader ──────────────────────────────────────────────────────────────

test.describe("TodoHeader", () => {
	test("shows Tasks label", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const label = page.locator(".todo-header-label");
		await expect(label).toBeVisible();
		await expect(label).toHaveText("Tasks");
	});

	test("shows correct completion count", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--mixed-progress");
		const count = page.locator(".todo-header-count");
		await expect(count).toBeVisible();
		await expect(count).toHaveText("2/4");
	});

	test("shows 0/4 for all pending", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const count = page.locator(".todo-header-count");
		await expect(count).toHaveText("0/4");
	});

	test("shows 4/4 for all complete", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-complete");
		const count = page.locator(".todo-header-count");
		await expect(count).toHaveText("4/4");
	});

	test("collapses items on header click", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const header = page.locator(".todo-header");
		const items = page.locator(".todo-items");

		// Items visible before click
		await expect(items).toBeVisible();

		// Click header to collapse
		await header.click();
		await expect(items).toBeHidden();
	});

	test("expands items on second header click", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const header = page.locator(".todo-header");
		const items = page.locator(".todo-items");

		// Collapse
		await header.click();
		await expect(items).toBeHidden();

		// Expand
		await header.click();
		await expect(items).toBeVisible();
	});

	test("toggles on Enter key", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const header = page.locator(".todo-header");
		const items = page.locator(".todo-items");

		// Focus the header and press Enter to collapse
		await header.focus();
		await header.press("Enter");
		await expect(items).toBeHidden();

		// Press Enter again to expand
		await header.press("Enter");
		await expect(items).toBeVisible();
	});

	test("chevron has rotate-90 when expanded", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const chevron = page.locator(".todo-chevron");
		const header = page.locator(".todo-header");

		// Expanded by default — chevron should have rotate-90
		await expect(chevron).toHaveClass(/rotate-90/);

		// Collapse — chevron should lose rotate-90
		await header.click();
		await expect(chevron).not.toHaveClass(/rotate-90/);
	});
});

// ─── TodoProgressBar ─────────────────────────────────────────────────────────

test.describe("TodoProgressBar", () => {
	test("shows 0% width for all pending", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const fill = page.locator(".todo-progress-bar-fill");
		// At 0% width the element exists but has no visible area
		await expect(fill).toBeAttached();
		await expect(fill).toHaveAttribute("style", /width: 0%/);
	});

	test("shows 50% width for 2/4 completed", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--mixed-progress");
		const fill = page.locator(".todo-progress-bar-fill");
		await expect(fill).toHaveAttribute("style", /width: 50%/);
	});

	test("shows 100% width for all complete", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-complete");
		const fill = page.locator(".todo-progress-bar-fill");
		await expect(fill).toHaveAttribute("style", /width: 100%/);
	});
});

// ─── TodoItemRow ─────────────────────────────────────────────────────────────

test.describe("TodoItemRow", () => {
	test("renders all items with correct subjects", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const items = page.locator(".todo-item");
		await expect(items).toHaveCount(4);

		const subjects = page.locator(".todo-subject");
		await expect(subjects.nth(0)).toHaveText("Set up project scaffolding");
		await expect(subjects.nth(1)).toHaveText("Implement authentication module");
		await expect(subjects.nth(2)).toHaveText("Write unit tests for auth");
		await expect(subjects.nth(3)).toHaveText("Deploy to staging");
	});

	test("shows description when present", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const descriptions = page.locator(".todo-description");

		// Items 0 and 2 have descriptions; items 1 and 3 do not
		await expect(descriptions).toHaveCount(2);
		await expect(descriptions.nth(0)).toHaveText(
			"Create directory structure and config files",
		);
		await expect(descriptions.nth(1)).toHaveText(
			"Cover login, logout, and token refresh flows",
		);
	});

	test("pending items have pending icon style", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-pending");
		const pendingIcons = page.locator(".todo-icon-pending");
		// All 4 items are pending
		await expect(pendingIcons).toHaveCount(4);
	});

	test("in-progress items have spinning icon", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--mixed-progress");
		const progressIcons = page.locator(".todo-icon-progress");
		await expect(progressIcons).toHaveCount(1);
		// The in-progress icon should have the spin animation class
		await expect(progressIcons.first()).toHaveClass(/animate-todo-spin/);
	});

	test("completed items have check icon", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--mixed-progress");
		const completedIcons = page.locator(".todo-icon-completed");
		// MixedProgress has 2 completed items
		await expect(completedIcons).toHaveCount(2);
	});

	test("completed items have strikethrough text", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--mixed-progress");
		const doneSubjects = page.locator(".todo-subject-done");
		// 2 completed items should have the line-through class
		await expect(doneSubjects).toHaveCount(2);
		await expect(doneSubjects.first()).toHaveClass(/line-through/);
		await expect(doneSubjects.nth(1)).toHaveClass(/line-through/);
	});

	test("all-complete story marks all items done", async ({ page }) => {
		await navigateToStory(page, "todo-todooverlay--all-complete");
		const completedIcons = page.locator(".todo-icon-completed");
		const doneSubjects = page.locator(".todo-subject-done");
		await expect(completedIcons).toHaveCount(4);
		await expect(doneSubjects).toHaveCount(4);
	});
});
