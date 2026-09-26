// ─── Project Management E2E Tests ────────────────────────────────────────────
// Tests directory autocomplete in the "+Add project" form, and the project
// context menu (rename, delete) in the ProjectManagerPanel.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import { singleInstanceInitMessages } from "../fixtures/mockup-state.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket, type WsMockControl } from "../helpers/ws-mock.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;
type ProjectManagementControl = WsMockControl & { rpc: RpcMockControl };

// ─── Constants ──────────────────────────────────────────────────────────────

const PROJECT_URL = "/?p=myapp";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Wait for the list route and WebSocket connection on every viewport. */
async function waitForChatReady(page: Page): Promise<void> {
	await page
		.locator("#session-list")
		.waitFor({ state: "visible", timeout: 10_000 });
	await page.locator(".connect-overlay").waitFor({
		state: "detached",
		timeout: 10_000,
	});
}

/**
 * Set up WS mock with single-instance init + project management handlers.
 * Directory autocomplete and project mutations are served through the RPC
 * websocket.
 */
async function setupWithProjectManagement(
	page: Page,
	baseURL?: string,
	path = PROJECT_URL,
): Promise<ProjectManagementControl> {
	const sessions = [
		{
			id: "sess-si-001",
			title: "Test session",
			projectSlug: "myapp",
			updatedAt: Date.now(),
			messageCount: 0,
		},
		{
			id: "sess-library-001",
			title: "Library session",
			projectSlug: "mylib",
			updatedAt: Date.now(),
			messageCount: 0,
		},
	];
	const rpc = await mockWsRpc(page, {
		handlers: {
			ListSessions: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				sessions: sessions.filter(
					(session) => session.projectSlug === params["projectSlug"],
				),
				roots: true,
			}),
			ListDaemonSessions: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				sessions: sessions.filter(
					(session) =>
						!params["scope"] || session.projectSlug === params["scope"],
				),
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			ListDirectories: (params) => {
				const path = String(params["path"] ?? "");
				return {
					projectSlug: String(params["projectSlug"] ?? "myapp"),
					path,
					entries: getMockDirectories(path),
				};
			},
			RenameProject: (params) => {
				const slug = String(params["slug"] ?? "");
				const title = String(params["title"] ?? "");
				return {
					projectSlug: String(params["projectSlug"] ?? "myapp"),
					projects: baseProjects().map((project) =>
						project.slug === slug ? { ...project, title } : project,
					),
					current: "myapp",
				};
			},
			RemoveProject: (params) => {
				const slug = String(params["slug"] ?? "");
				return {
					projectSlug: String(params["projectSlug"] ?? "myapp"),
					projects: baseProjects().filter((project) => project.slug !== slug),
					current: "myapp",
				};
			},
			AddProject: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				projects: [
					...baseProjects(),
					{
						slug: "new-project",
						title: "new-project",
						directory: String(params["directory"] ?? "/src/new-project"),
						...(typeof params["instanceId"] === "string"
							? { instanceId: params["instanceId"] }
							: {}),
					},
				],
				current: "myapp",
				addedSlug: "new-project",
			}),
		},
	});
	const control = await mockRelayWebSocket(page, {
		initMessages: singleInstanceInitMessages.filter(
			(message) => message.type !== "session_list",
		),
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${path}`);
	await waitForChatReady(page);
	return Object.assign(control, { rpc });
}

function baseProjects() {
	return [
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
	];
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
	// Very long paths for truncation testing
	if (path === "/Users/dstern/src/personal/") {
		return [
			"/Users/dstern/src/personal/very-long-deeply-nested-project-directory-name/",
			"/Users/dstern/src/personal/opencode-relay/",
		];
	}
	// Empty for unknown paths
	return [];
}

/** Open project management from the desktop sidebar or phone list bar. */
async function openProjectsPanel(page: Page): Promise<void> {
	const overflow = page.getByTestId("list-bar-overflow");
	if (await overflow.isVisible()) {
		await overflow.click();
		await page.getByTestId("list-overflow-projects").click();
	} else {
		await page.locator("#sidebar-projects-btn").click();
	}
	await expect(page.getByTestId("sidebar-projects-panel")).toBeVisible();
}

test("direct project URL scopes the list and another URL switches projects", async ({
	page,
	baseURL,
}) => {
	const control = await setupWithProjectManagement(page, baseURL, "/?p=mylib");
	await control.rpc.waitForRequest(
		(request) =>
			request.tag === "ListDaemonSessions" &&
			request.payload["scope"] === "mylib",
	);
	await expect(page.getByTestId("session-scope-chip")).toHaveText("mylib");
	const sessions = page.locator("#session-list .session-item");
	await expect(sessions).toHaveCount(1);
	await expect(sessions.first()).toContainText("Library session");
	await expect(sessions.filter({ hasText: "Test session" })).toHaveCount(0);

	await page.getByRole("button", { name: "Clear project scope" }).click();
	await expect(sessions).toHaveCount(2);
	await expect(sessions.filter({ hasText: "Test session" })).toHaveCount(1);
	await expect(sessions.filter({ hasText: "Library session" })).toHaveCount(1);

	await page.goto(`${baseURL ?? "http://localhost:4173"}/?p=myapp`);
	await waitForChatReady(page);
	await control.rpc.waitForRequest(
		(request) =>
			request.tag === "ListDaemonSessions" &&
			request.payload["scope"] === "myapp",
	);
	await expect(page.getByTestId("session-scope-chip")).toHaveText("myapp");
	await expect(sessions).toHaveCount(1);
	await expect(sessions.first()).toContainText("Test session");
	await expect(sessions.filter({ hasText: "Library session" })).toHaveCount(0);
});

test("adds a project through the projects panel", async ({ page, baseURL }) => {
	const control = await setupWithProjectManagement(page, baseURL);
	await openProjectsPanel(page);
	const panel = page.getByTestId("sidebar-projects-panel");
	await panel.getByRole("button", { name: "Add project", exact: true }).click();
	await panel.getByRole("combobox").fill("/src/new-project");
	await panel.getByRole("button", { name: "Add", exact: true }).click();
	const request = await control.rpc.waitForRequest(
		(req) => req.tag === "AddProject",
	);
	expect(request.payload).toMatchObject({ directory: "/src/new-project" });
	await expect(panel).toBeHidden();
	await openProjectsPanel(page);
	await expect(panel.getByTestId("project-item")).toHaveCount(3);
	await expect(panel.locator('[data-slug="new-project"]')).toContainText(
		"/src/new-project",
	);
});

// ─── Group 1: Directory Autocomplete ────────────────────────────────────────

test.describe("Directory Autocomplete", () => {
	test("shows directory suggestions when typing a path", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		// Click "Add project" to show the form
		await page.getByText("Add project").click();

		// Type a path into the autocomplete input
		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
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
		await openProjectsPanel(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
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
		await openProjectsPanel(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
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
		await openProjectsPanel(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
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
		await openProjectsPanel(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
		);
		await input.fill("/src/");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// aria-selected, not a class: the `dir-item-active` class this used to
		// assert stopped existing when the active row became `bg-accent-bg`, and
		// nothing failed, because the class simply never matched. The ARIA state
		// is what the listbox actually contracts to expose.
		const firstItem = autocomplete.locator(".dir-item").nth(0);
		await expect(firstItem).toHaveAttribute("aria-selected", "true");

		// Press ArrowDown to move to second item
		await input.press("ArrowDown");
		const secondItem = autocomplete.locator(".dir-item").nth(1);
		await expect(secondItem).toHaveAttribute("aria-selected", "true");
		await expect(firstItem).toHaveAttribute("aria-selected", "false");

		// Press Enter to select "work/"
		await input.press("Enter");
		await expect(input).toHaveValue("/src/work/");
	});

	test("Escape closes the autocomplete popup", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
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

	test("clicking an entry selects it", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
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

	test("long paths truncate the prefix, not the directory name", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);
		await page.getByText("Add project").click();

		const input = page.locator(
			"[data-testid='sidebar-projects-panel'] input[type='text']",
		);
		await input.fill("/Users/dstern/src/personal/");

		const autocomplete = page.locator(".dir-autocomplete-list");
		await expect(autocomplete).toBeVisible({ timeout: 5_000 });

		// The first entry has a long path. The directory name at the end
		// ("very-long-deeply-nested-project-directory-name/") must remain
		// fully visible — the parent path prefix should be what gets clipped.
		const firstItem = autocomplete.locator(".dir-item").first();
		const dirName = firstItem.locator("span.text-text");
		const container = firstItem.locator("span.flex-1");

		// Get bounding boxes to verify the directory name is not clipped
		const dirBox = await dirName.boundingBox();
		const containerBox = await container.boundingBox();

		expect(dirBox).not.toBeNull();
		expect(containerBox).not.toBeNull();

		// The directory name's right edge must be within (or at) the
		// container's right edge — i.e. not pushed off-screen.
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect(dirBox).not.toBeNull() above
		const dirRight = dirBox!.x + dirBox!.width;
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect(containerBox).not.toBeNull() above
		const containerRight = containerBox!.x + containerBox!.width;
		expect(dirRight).toBeLessThanOrEqual(containerRight + 1);
	});
});

// ─── Group 2: Project Context Menu ──────────────────────────────────────────

test.describe("Project Context Menu", () => {
	test("shows ... button on project items", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		// Each project item should have a more button
		const moreButtons = page.locator(
			"[data-testid='sidebar-projects-panel'] .proj-more-btn",
		);
		await expect(moreButtons.first()).toBeVisible();
	});

	test("clicking ... opens context menu with Rename and Remove", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		// Click the more button on the second project (mylib)
		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		const moreBtn = mylibItem.locator(".proj-more-btn");
		await moreBtn.click();

		// Context menu should appear with Rename and Remove options
		const renameBtn = page.getByRole("menuitem", { name: "Rename" });
		const removeBtn = page.getByRole("menuitem", { name: "Remove" });
		await expect(renameBtn).toBeVisible();
		await expect(removeBtn).toBeVisible();
	});

	test("Escape closes the context menu", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const moreBtn = projectItems.nth(1).locator(".proj-more-btn");
		await moreBtn.click();

		const renameBtn = page.getByRole("menuitem", { name: "Rename" });
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
		await openProjectsPanel(page);

		// Click more on mylib, then Rename
		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Rename" }).click();

		// Inline rename input should appear with current title
		const renameInput = mylibItem.locator("input[type='text']");
		await expect(renameInput).toBeVisible();
		await expect(renameInput).toHaveValue("mylib");
	});

	test("Enter commits rename through RPC", async ({ page, baseURL }) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Rename" }).click();

		const renameInput = mylibItem.locator("input[type='text']");
		await renameInput.fill("My Library");
		await renameInput.press("Enter");

		// Input should disappear
		await expect(renameInput).not.toBeVisible();

		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "RenameProject",
		);
		expect(request.payload).toMatchObject({
			slug: "mylib",
			title: "My Library",
		});
	});

	test("Escape cancels rename without sending message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Rename" }).click();

		const renameInput = mylibItem.locator("input[type='text']");
		await renameInput.fill("Cancelled Name");
		await renameInput.press("Escape");

		// Input should disappear
		await expect(renameInput).not.toBeVisible();

		// Wait a bit to ensure no rename request arrives.
		await page.waitForTimeout(300);
		const renameRequests = control.rpc
			.getRequests()
			.filter((request) => request.tag === "RenameProject");
		expect(renameRequests).toHaveLength(0);
	});

	test("renamed project shows new title after server responds", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Rename" }).click();

		const renameInput = mylibItem.locator("input[type='text']");
		await renameInput.fill("My Library");
		await renameInput.press("Enter");

		// After RPC responds with the updated project list, title should update.
		await expect(
			page.locator("[data-testid='project-item']").nth(1),
		).toContainText("My Library", { timeout: 5_000 });
	});
});

// ─── Group 4: Project Delete ────────────────────────────────────────────────

test.describe("Project Delete", () => {
	test("Remove shows confirmation modal", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Remove" }).click();

		// Confirmation modal should appear
		const confirmModal = page.locator("#confirm-modal");
		await expect(confirmModal).toBeVisible();
		await expect(confirmModal).toContainText("mylib");
		await expect(confirmModal).toContainText("conduit");
	});

	test("confirming removal sends RemoveProject RPC", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Remove" }).click();

		// Click the confirm button in the modal
		await page.click("#confirm-modal button:has-text('Remove')");

		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "RemoveProject",
		);
		expect(request.payload).toMatchObject({
			slug: "mylib",
		});
	});

	test("cancelling removal does not send message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		const projectItems = page.locator("[data-testid='project-item']");
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Remove" }).click();

		// Click Cancel
		await page.click("#confirm-modal button:has-text('Cancel')");

		// Modal should close
		await expect(page.locator("#confirm-modal")).not.toBeVisible();

		// Verify no RemoveProject RPC was sent.
		await page.waitForTimeout(300);
		const removeRequests = control.rpc
			.getRequests()
			.filter((request) => request.tag === "RemoveProject");
		expect(removeRequests).toHaveLength(0);
	});

	test("removed project disappears from the list", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await openProjectsPanel(page);

		// Verify 2 projects initially
		const projectItems = page.locator("[data-testid='project-item']");
		await expect(projectItems).toHaveCount(2);

		// Remove mylib
		const mylibItem = projectItems.nth(1);
		await mylibItem.locator(".proj-more-btn").click();
		await page.getByRole("menuitem", { name: "Remove" }).click();
		await page.click("#confirm-modal button:has-text('Remove')");

		// After server responds, only 1 project should remain
		await expect(projectItems).toHaveCount(1, { timeout: 5_000 });
		await expect(projectItems.first()).toContainText("myapp");
	});
});
