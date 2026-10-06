// Project scope through the session list's pill: URL scoping, switching,
// adding a project through the Add project dialog, and removing one from the
// scope menu.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import { singleInstanceInitMessages } from "../fixtures/mockup-state.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket, type WsMockControl } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;
type ProjectManagementControl = WsMockControl & { rpc: RpcMockControl };
type MockSession = {
	id: string;
	title: string;
	status: string;
	projectSlug: string;
	updatedAt: number;
	messageCount: number;
	settledAt?: number;
};

const PROJECT_URL = "/?p=myapp";

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
 * Folder lookup and project mutations are served through the RPC websocket.
 */
async function setupWithProjectManagement(
	page: Page,
	baseURL?: string,
	path = PROJECT_URL,
	extraSessions: MockSession[] = [],
): Promise<ProjectManagementControl> {
	const sessions: MockSession[] = [
		...extraSessions,
		{
			id: "sess-si-001",
			title: "Test session",
			status: "idle",
			projectSlug: "myapp",
			updatedAt: Date.now(),
			messageCount: 0,
		},
		{
			id: "sess-library-001",
			title: "Library session",
			status: "idle",
			projectSlug: "mylib",
			updatedAt: Date.now(),
			messageCount: 0,
		},
	];
	// The daemon answers AttachProject with the project it attached.
	const rpc = await mockWsRpc(page, {
		handlers: {
			AttachProject: async (params) => {
				// A cold load without ?p attaches the daemon's default project.
				if (typeof params["projectSlug"] !== "string")
					return { projectSlug: "myapp" };
				// A real attach takes a round trip or two; an instant answer would
				// hide anything that races it.
				await new Promise((resolve) => setTimeout(resolve, 300));
				rpc.setShellRows(
					sessions.filter(
						(session) => session.projectSlug === params["projectSlug"],
					),
				);
				return { projectSlug: String(params["projectSlug"]) };
			},
			ListSessions: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				sessions: sessions.filter(
					(session) => session.projectSlug === params["projectSlug"],
				),
				roots: true,
			}),
			ListDaemonSessions: async (params) => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				const limit = Number(params["limit"] ?? Infinity);
				const cursor = params["cursor"] as { id: string } | undefined;
				const scoped = sessions
					.filter(
						(session) =>
							!params["scope"] || session.projectSlug === params["scope"],
					)
					.sort((a, b) => b.updatedAt - a.updatedAt);
				const start = cursor
					? scoped.findIndex((session) => session.id === cursor.id) + 1
					: 0;
				const page = scoped.slice(start, start + limit);
				const last = page.at(-1);
				const hasMore = start + limit < scoped.length;
				return {
					projectSlug: String(params["projectSlug"] ?? "myapp"),
					sessions: page,
					availability: [],
					hasMore,
					nextCursor:
						hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
				};
			},
			// Every query names one existing folder: the one typed.
			FindFolders: (params) => ({
				home: "/home/test",
				entries: [
					{
						path: String(params["query"]),
						isGitRepo: false,
						reason: "match",
						exists: true,
					},
				],
			}),
			SaveProject: (params) => {
				const slug = String(params["slug"] ?? "new-project");
				const title = String(params["title"] ?? "new-project");
				const folders = params["folders"] as string[];
				return {
					projectSlug: String(params["projectSlug"] ?? "myapp"),
					projects: params["slug"]
						? baseProjects().map((project) =>
								project.slug === slug
									? { ...project, title, folders }
									: project,
							)
						: [
								...baseProjects(),
								{
									slug,
									title,
									folders,
								},
							],
					current: "myapp",
					savedSlug: slug,
					warnings: [],
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
		},
	});
	rpc.setShellRows(
		sessions.filter(
			(session) =>
				session.projectSlug ===
				(new URL(path, baseURL ?? "http://localhost:4173").searchParams.get(
					"p",
				) ?? "myapp"),
		),
	);
	const control = await mockRelayWebSocket(page, {
		initMessages: singleInstanceInitMessages.filter(
			(message) => message.type !== "shell_snapshot",
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
			folders: ["/src/myapp"],
		},
		{
			slug: "mylib",
			title: "mylib",
			folders: ["/src/mylib"],
		},
	];
}

/** Add a project with one existing folder through the scope chip's dialog. */
async function addProject(page: Page, folder: string): Promise<void> {
	await page.getByTestId("session-scope-chip").click();
	await page.getByRole("menuitem", { name: "Add a project…" }).click();
	const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
	await dialog.getByRole("combobox", { name: "Add folder" }).fill(folder);
	await dialog.getByRole("option", { name: folder, exact: true }).click();
	await dialog.getByRole("button", { name: /^Add project/ }).click();
	await expect(dialog).toBeHidden();
}

/** A project's row in the open scope menu. */
function scopeRow(page: Page, slug: string) {
	return page.getByRole("menuitemradio", { name: new RegExp(`^${slug}\\b`) });
}

/** Ask to remove mylib with the row's hover ✕. */
async function requestRemoveMylib(page: Page): Promise<void> {
	await page.getByTestId("session-scope-chip").click();
	const row = scopeRow(page, "mylib");
	await row.hover();
	await row.getByTestId("session-scope-remove").click();
	await expect(page.locator("#confirm-modal")).toBeVisible();
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

	control.rpc.setShellRows([
		{
			id: "sess-si-001",
			title: "Test session",
			status: "idle",
			projectSlug: "myapp",
			updatedAt: Date.now(),
			messageCount: 0,
		},
	]);
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

test("adds a project through the Add project dialog", async ({
	page,
	baseURL,
}) => {
	const control = await setupWithProjectManagement(page, baseURL);
	await addProject(page, "/src/new-project");
	const request = await control.rpc.waitForRequest(
		(req) => req.tag === "SaveProject",
	);
	expect(request.payload).toMatchObject({
		title: "new-project",
		folders: ["/src/new-project"],
	});
	await expect(page.getByTestId("session-scope-chip")).toHaveText(
		"new-project",
	);
	await page.getByTestId("session-scope-chip").click();
	await expect(scopeRow(page, "new-project")).toBeVisible();
});

test("clearing the scope after adding a project lists every project's sessions", async ({
	page,
	baseURL,
}) => {
	const control = await setupWithProjectManagement(page, baseURL);
	await addProject(page, "/src/new-project");
	await control.rpc.waitForRequest(
		(request) =>
			request.tag === "AttachProject" &&
			request.payload["projectSlug"] === "new-project",
	);
	await expect(page.getByTestId("session-scope-chip")).toHaveText(
		"new-project",
	);

	await page.getByRole("button", { name: "Clear project scope" }).click();
	const sessions = page.locator("#session-list .session-item");
	await expect(sessions.filter({ hasText: "Test session" })).toHaveCount(1);
	await expect(sessions.filter({ hasText: "Library session" })).toHaveCount(1);
});

test("clearing the scope after adding a project pages in every session", async ({
	page,
	baseURL,
}) => {
	const now = Date.now();
	// Mostly settled, so the first page leaves few rows on screen.
	const many = Array.from({ length: 45 }, (_, index) => ({
		id: `sess-many-${String(index).padStart(2, "0")}`,
		title: `Many ${index}`,
		status: "idle",
		projectSlug: "myapp",
		updatedAt: now - 1000 - index,
		messageCount: 0,
		...(index % 9 === 0 ? {} : { settledAt: now - 500 }),
	}));
	await setupWithProjectManagement(page, baseURL, "/", many);
	const sessions = page.locator("#session-list .session-item");
	await expect(sessions.filter({ hasText: "Library session" })).toHaveCount(1);
	const before = await sessions.allTextContents();

	await addProject(page, "/src/new-project");
	await expect(page.getByTestId("session-scope-chip")).toHaveText(
		"new-project",
	);
	await page.getByRole("button", { name: "Clear project scope" }).click();
	await expect(sessions.filter({ hasText: "Library session" })).toHaveCount(1);
	await expect(sessions).toHaveCount(before.length);
});

test("switching projects while the list pages does not fail the switch", async ({
	page,
	baseURL,
}) => {
	const now = Date.now();
	// Mostly settled, so each page leaves the pager's sentinel on screen and
	// paging keeps going while the switch is in flight.
	const many = ["myapp", "mylib"].flatMap((projectSlug) =>
		Array.from({ length: 45 }, (_, index) => ({
			id: `sess-${projectSlug}-${String(index).padStart(2, "0")}`,
			title: `${projectSlug} ${index}`,
			status: "idle",
			projectSlug,
			updatedAt: now - 1000 - index,
			messageCount: 0,
			...(index % 9 === 0 ? {} : { settledAt: now - 500 }),
		})),
	);
	const control = await setupWithProjectManagement(
		page,
		baseURL,
		PROJECT_URL,
		many,
	);
	for (const target of ["mylib", "myapp", "mylib"]) {
		await page.getByTestId("session-scope-chip").click();
		await page
			.getByRole("menuitemradio", { name: new RegExp(`^${target}\\b`) })
			.click();
		await control.rpc.waitForRequest(
			(request) =>
				request.tag === "AttachProject" &&
				request.payload["projectSlug"] === target,
		);
		await expect(page.getByTestId("session-scope-chip")).toHaveText(target);
		await page.waitForTimeout(800);
	}
	await expect(page.getByText("Failed to switch projects")).toHaveCount(0);
});

test.describe("Project Delete", () => {
	test("Remove shows confirmation modal", async ({ page, baseURL }) => {
		await setupWithProjectManagement(page, baseURL);
		await requestRemoveMylib(page);

		const confirmModal = page.locator("#confirm-modal");
		await expect(confirmModal).toContainText("mylib");
		await expect(confirmModal).toContainText("conduit");
	});

	test("confirming removal sends RemoveProject RPC", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await requestRemoveMylib(page);

		await page.click("#confirm-modal button:has-text('Remove')");

		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "RemoveProject",
		);
		expect(request.payload).toMatchObject({ slug: "mylib" });
	});

	test("cancelling removal does not send message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithProjectManagement(page, baseURL);
		await requestRemoveMylib(page);

		await page.click("#confirm-modal button:has-text('Cancel')");
		await expect(page.locator("#confirm-modal")).not.toBeVisible();

		// No RemoveProject RPC may arrive during this observation window.
		await page.waitForTimeout(300);
		const removeRequests = control.rpc
			.getRequests()
			.filter((request) => request.tag === "RemoveProject");
		expect(removeRequests).toHaveLength(0);
	});

	test("Delete on a focused row removes the project from the menu", async ({
		page,
		baseURL,
	}) => {
		await setupWithProjectManagement(page, baseURL);
		await page.getByTestId("session-scope-chip").click();
		await expect(scopeRow(page, "myapp")).toBeVisible();
		await scopeRow(page, "mylib").focus();
		await page.keyboard.press("Delete");
		await page.click("#confirm-modal button:has-text('Remove')");
		await expect(page.locator("#confirm-modal")).not.toBeVisible();

		await page.getByTestId("session-scope-chip").click();
		await expect(scopeRow(page, "myapp")).toBeVisible();
		await expect(scopeRow(page, "mylib")).toHaveCount(0);
	});
});
