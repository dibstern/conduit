// ─── Project Management E2E Tests ────────────────────────────────────────────
// Tests directory autocomplete in the "+Add project" form, and the project
// context menu (rename, delete) in the ProjectSwitcher.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import { singleInstanceInitMessages } from "../fixtures/mockup-state.js";
import { mockRelayWebSocket, type WsMockControl } from "../helpers/ws-mock.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;

// ─── Constants ──────────────────────────────────────────────────────────────

const PROJECT_URL = "/p/myapp/";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Wait for the chat page to be ready (WS connected, input visible). */
async function waitForChatReady(page: Page): Promise<void> {
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	await page.locator(".connect-overlay").waitFor({
		state: "hidden",
		timeout: 10_000,
	});
}

/**
 * Set up WS mock with single-instance init + directory listing handler.
 * Responds to `list_directories` with mock directory entries.
 * Responds to `remove_project` and `rename_project` with updated project lists.
 */
async function setupWithProjectManagement(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: singleInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
		onClientMessage: (parsed, ctrl) => {
			// Respond to list_directories with mock entries
			if (parsed["type"] === "list_directories") {
				const path = parsed["path"] as string;
				const entries = getMockDirectories(path);
				ctrl.sendMessage({
					type: "directory_list",
					path,
					entries,
				});
			}

			// Respond to remove_project with updated project list
			if (parsed["type"] === "remove_project") {
				const slug = parsed["slug"] as string;
				ctrl.sendMessage({
					type: "project_list",
					projects: [
						{
							slug: "myapp",
							title: "myapp",
							directory: "/src/myapp",
						},
						{
							slug: "mylib",
							title: "mylib",
							directory: "/src/mylib",
						},
					].filter((p) => p.slug !== slug),
					current: "myapp",
				});
			}

			// Respond to rename_project with updated project list
			if (parsed["type"] === "rename_project") {
				const slug = parsed["slug"] as string;
				const title = parsed["title"] as string;
				ctrl.sendMessage({
					type: "project_list",
					projects: [
						{
							slug: "myapp",
							title: slug === "myapp" ? title : "myapp",
							directory: "/src/myapp",
						},
						{
							slug: "mylib",
							title: slug === "mylib" ? title : "mylib",
							directory: "/src/mylib",
						},
					],
					current: "myapp",
				});
			}

			// Respond to get_projects with the current list
			if (parsed["type"] === "get_projects") {
				ctrl.sendMessage({
					type: "project_list",
					projects: [
						{
							slug: "myapp",
							title: "myapp",
							directory: "/src/myapp",
						},
						{
							slug: "mylib",
							title: "mylib",
							directory: "/src/mylib",
						},
					],
					current: "myapp",
				});
			}
		},
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

/** Mock directory entries for autocomplete testing. */
function getMockDirectories(path: string): string[] {
	// Simulate directory structure:
	// /src/ -> personal/, work/, projects/
	// /src/p -> personal/, projects/
	// /src/personal/ -> opencode-relay/, my-app/, dotfiles/
	// /src/personal/o -> opencode-relay/
	if (path === "/src/" || path === "/src") {
		return ["/src/personal/", "/src/work/", "/src/projects/"];
	}
	if (path === "/src/p") {
		return ["/src/personal/", "/src/projects/"];
	}
	if (path === "/src/personal/") {
		return [
			"/src/personal/opencode-relay/",
			"/src/personal/my-app/",
			"/src/personal/dotfiles/",
		];
	}
	if (path === "/src/personal/o") {
		return ["/src/personal/opencode-relay/"];
	}
	if (path === "/src/personal/opencode-relay/") {
		return ["/src/personal/opencode-relay/conduit/"];
	}
	// Empty for unknown paths
	return [];
}

/** Open the ProjectSwitcher dropdown. On mobile, opens hamburger first. */
async function openProjectSwitcher(page: Page): Promise<void> {
	const hamburger = page.locator("#hamburger-btn");
	if (await hamburger.isVisible()) {
		await hamburger.click();
		await page.locator("#project-switcher-btn").waitFor({ state: "visible" });
	}
	await page.locator("#project-switcher-btn").click();
	await page
		.locator("[data-testid='project-switcher-dropdown']")
		.waitFor({ state: "visible" });
}

// ─── Group 1: Directory Autocomplete ────────────────────────────────────────

test.describe("Directory Autocomplete", () => {
	test("shows directory suggestions when typing a path", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		// Click "Add project" to show the form
		await page.getByText("Add project").click();

		// Type a path into the autocomplete input
		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/");

		// Wait for the drop-up popup to appear with directory entries
		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// Should show 3 directories
		const items = autocomplete.locator(".dir-item");
		await expect(items).toHaveCount(3);
		await expect(items.nth(0)).toContainText("personal/");
		await expect(items.nth(1)).toContainText("work/");
		await expect(items.nth(2)).toContainText("projects/");
	});

	test("filters directories by prefix as user types", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/p");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// Should show 2 directories matching "p" prefix
		const items = autocomplete.locator(".dir-item");
		await expect(items).toHaveCount(2);
		await expect(items.nth(0)).toContainText("personal/");
		await expect(items.nth(1)).toContainText("projects/");
	});

	test("Enter selects the highlighted directory and closes popup", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// Press Enter to select the first item (personal/)
		await input.press("Enter");

		// Popup should close
		await expect(autocomplete).not.toBeVisible();

		// Input should contain the selected path
		await expect(input).toHaveValue("/src/personal/");
	});

	test("Tab drills into the selected directory (tab-completion)", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// Press Tab to drill into the first item (personal/)
		await input.press("Tab");

		// Input should update to the drilled-into path
		await expect(input).toHaveValue("/src/personal/");

		// Popup should still be visible with the next level's entries
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });
		const items = autocomplete.locator(".dir-item");
		await expect(items).toHaveCount(3); // opencode-relay, my-app, dotfiles
		await expect(items.nth(0)).toContainText("opencode-relay/");
	});

	test("Arrow keys navigate through suggestions", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// First item should be active by default
		const firstItem = autocomplete.locator(".dir-item").nth(0);
		await expect(firstItem).toHaveClass(/dir-item-active/);

		// Press ArrowDown to move to second item
		await input.press("ArrowDown");
		const secondItem = autocomplete.locator(".dir-item").nth(1);
		await expect(secondItem).toHaveClass(/dir-item-active/);

		// Press Enter to select "work/"
		await input.press("Enter");
		await expect(input).toHaveValue("/src/work/");
	});

	test("Escape closes the autocomplete popup", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// Press Escape to close the popup
		await input.press("Escape");
		await expect(autocomplete).not.toBeVisible();

		// Input value should remain unchanged
		await expect(input).toHaveValue("/src/");
	});

	test("sends list_directories WS message on input", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/");

		// Wait for the WS message to be sent (after debounce)
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "list_directories",
		);
		expect(msg).toMatchObject({
			type: "list_directories",
			path: "/src/",
		});
	});

	test("clicking an entry selects it", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
		);
		await input.fill("/src/");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// Click the second entry (work/)
		const workItem = autocomplete.locator(".dir-item").nth(1);
		await workItem.click({ force: true });

		// Input should have the selected path
		await expect(input).toHaveValue("/src/work/");
	});
});

// ─── Group 2: Project Context Menu ──────────────────────────────────────────

test.describe("Project Context Menu", () => {
	test("shows ... button on project items", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		// Each project item should have a more button
		const moreButtons = page.locator(
			"[data-testid='project-switcher-dropdown'] .proj-more-btn",
		);
		await expect(moreButtons.first()).toBeVisible();
	});

	test("clicking ... opens context menu with Rename and Remove", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		// Click the more button on the second project (mylib)
		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		const moreBtn = mylibItem.locator(".proj-more-btn");
		await moreBtn.click();

		// Context menu should appear with Rename and Remove options
		const renameBtn = page.locator("button:has-text('Rename')");
		const removeBtn = page.locator("button:has-text('Remove')");
		await expect(renameBtn).toBeVisible();
		await expect(removeBtn).toBeVisible();
	});

	test("Escape closes the context menu", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const moreBtn = projectItems.nth(1).locator(".proj-more-btn");
		await moreBtn.click();

		const renameBtn = page.locator("button:has-text('Rename')");
		await expect(renameBtn).toBeVisible();

		// Press Escape
		await page.keyboard.press("Escape");

		// Context menu should be gone
		await expect(renameBtn).not.toBeVisible();
	});
});

// ─── Group 3: Project Rename ────────────────────────────────────────────────

test.describe("Project Rename", () => {
	test("rename shows inline input with current title", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		// Click more on mylib, then Rename
		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Rename')").click();

		// Inline rename input should appear with current title
		const renameInput = mylibItem.locator("input[type='text']");
		await expect(renameInput).toBeVisible();
		await expect(renameInput).toHaveValue("mylib");
	});

	test("Enter commits rename and sends rename_project WS message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Rename')").click();

		const renameInput = mylibItem.locator("input[type='text']");
		await renameInput.fill("My Library");
		await renameInput.press("Enter");

		// Input should disappear
		await expect(renameInput).not.toBeVisible();

		// Verify the rename_project WS message
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "rename_project",
		);
		expect(msg).toMatchObject({
			type: "rename_project",
			slug: "mylib",
			title: "My Library",
		});
	});

	test("Escape cancels rename without sending message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Rename')").click();

		const renameInput = mylibItem.locator("input[type='text']");
		await renameInput.fill("Cancelled Name");
		await renameInput.press("Escape");

		// Input should disappear
		await expect(renameInput).not.toBeVisible();

		// Verify no rename_project message was sent
		// Wait a bit to ensure no message arrives
		await page.waitForTimeout(300);
		const messages = control.getClientMessages();
		const renameMessages = messages.filter(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "rename_project",
		);
		expect(renameMessages).toHaveLength(0);
	});

	test("renamed project shows new title after server responds", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Rename')").click();

		const renameInput = mylibItem.locator("input[type='text']");
		await renameInput.fill("My Library");
		await renameInput.press("Enter");

		// After server responds with updated project_list, title should update
		// (the onClientMessage handler sends back the updated list)
		await expect(
			page.locator("[data-testid='project-item']").nth(1),
		).toContainText("My Library", { timeout: 5_000 });
	});
});

// ─── Group 4: Project Delete ────────────────────────────────────────────────

test.describe("Project Delete", () => {
	test("Remove shows confirmation modal", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Remove')").click();

		// Confirmation modal should appear
		const confirmModal = page.locator("#confirm-modal");
		await expect(confirmModal).toBeVisible();
		await expect(confirmModal).toContainText("mylib");
		await expect(confirmModal).toContainText("conduit");
	});

	test("confirming removal sends remove_project WS message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Remove')").click();

		// Click the confirm button in the modal
		await page.click("#confirm-modal button:has-text('Remove')");

		// Verify the remove_project WS message
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "remove_project",
		);
		expect(msg).toMatchObject({
			type: "remove_project",
			slug: "mylib",
		});
	});

	test("cancelling removal does not send message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Remove')").click();

		// Click Cancel
		await page.click("#confirm-modal button:has-text('Cancel')");

		// Modal should close
		await expect(page.locator("#confirm-modal")).not.toBeVisible();

		// Verify no remove_project message was sent
		await page.waitForTimeout(300);
		const messages = control.getClientMessages();
		const removeMessages = messages.filter(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "remove_project",
		);
		expect(removeMessages).toHaveLength(0);
	});

	test("removed project disappears from the list", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectSwitcher(page);

		// Verify 2 projects initially
		const projectItems = page.locator("[data-testid='project-item']");
		await expect(projectItems).toHaveCount(2);

		// Remove mylib
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.locator("button:has-text('Remove')").click();
		await page.click("#confirm-modal button:has-text('Remove')");

		// After server responds, only 1 project should remain
		await expect(projectItems).toHaveCount(1, { timeout: 5_000 });
		await expect(projectItems.first()).toContainText("myapp");
	});
});
