// Project scope through the session list's pill: URL scoping, switching,
// adding a project through the Add project dialog, and removing one from the
// scope menu.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import { singleInstanceInitMessages } from "../fixtures/mockup-state.js";
import {
	mockWsRpc,
	type RpcMockControl,
	sendMockDaemonList,
} from "../helpers/rpc-mock.js";
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

// The names deliberately differ from driver names: support is a wire fact,
// not a frontend assumption about a provider. Both built-in drivers support
// multi-folder sessions today; the unsupported state models a future adapter.
const capabilityInstances = [
	{
		id: "claude",
		name: "Across folders",
		driver: "claude",
		port: 0,
		managed: false,
		status: "healthy",
		restartCount: 0,
		createdAt: 0,
		capabilities: { supportsMultiFolder: true, supportsWorktree: true },
	},
	{
		id: "opencode",
		name: "Main only",
		driver: "opencode",
		port: 0,
		managed: false,
		status: "healthy",
		restartCount: 0,
		createdAt: 0,
		capabilities: { supportsMultiFolder: false, supportsWorktree: false },
	},
];

test("explains only unsupported providers while adding several folders", async ({
	page,
	baseURL,
}, testInfo) => {
	await setupWithProjectManagement(page, baseURL);
	sendMockDaemonList(page, "SubscribeInstances", {
		instances: capabilityInstances,
	});
	await page.getByTestId("session-scope-chip").click();
	await page.getByRole("menuitem", { name: "Add a project…" }).click();
	const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
	const input = dialog.getByRole("combobox", { name: "Add folder" });
	await input.fill("/src/client");
	await dialog
		.getByRole("option", { name: "/src/client", exact: true })
		.click();
	const support = dialog.getByTestId("project-provider-capabilities");
	await expect(support).toHaveCount(0);
	await input.fill("/src/server");
	await dialog
		.getByRole("option", { name: "/src/server", exact: true })
		.click();
	await expect(support).toHaveText("Main only works in the main folder only.");
	await expect(support.locator("p")).toHaveCount(1);
	await expect(
		dialog.getByText("Folders · Sessions run in main and can edit all", {
			exact: true,
		}),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("provider-folder-support.png"),
	});
	sendMockDaemonList(page, "SubscribeInstances", {
		instances: capabilityInstances.map((instance) => ({
			...instance,
			capabilities: { ...instance.capabilities, supportsMultiFolder: true },
		})),
	});
	await expect(support).toHaveCount(0);
	sendMockDaemonList(page, "SubscribeInstances", {
		instances: [],
		providerCapabilities: {},
	});
	await expect(support).toHaveCount(0);
	sendMockDaemonList(page, "SubscribeInstances", {
		instances: capabilityInstances,
	});
	await expect(support).toHaveText("Main only works in the main folder only.");
	await dialog
		.getByRole("button", { name: "Remove folder: /src/server" })
		.click();
	await expect(support).toHaveCount(0);
});

test("a draft only blocks providers that explicitly reject extra folders", async ({
	page,
	baseURL,
}, testInfo) => {
	const control = await setupWithProjectManagement(
		page,
		baseURL,
		"/new?project=myapp",
	);
	sendMockDaemonList(page, "SubscribeInstances", {
		instances: capabilityInstances,
	});
	sendMockDaemonList(page, "SubscribeProjects", {
		projects: baseProjects().map((project) =>
			project.slug === "myapp"
				? { ...project, folders: ["/src/myapp", "/src/server"] }
				: project,
		),
	});
	const picker = page.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
	);
	await picker.click();
	await page.getByTestId("picker-row-harness").click();
	await page.getByTestId("picker-instance-opencode").click();
	await page.keyboard.press("Escape");
	const startChip = page.getByTestId("draft-start-chip");
	const explanation = page.getByTestId("draft-provider-explanation");
	await expect(startChip).toHaveText("Current folder");
	await expect(explanation).toHaveText(
		"Main only works in the main folder only. Pick another provider to use every folder.",
	);
	await expect(startChip).toHaveAttribute(
		"aria-describedby",
		(await explanation.getAttribute("id")) ?? "",
	);
	const input = page.locator("#input");
	await input.fill("Read both folders");
	await expect(
		page.getByRole("button", { name: "Send message", exact: true }),
	).toBeDisabled();
	await input.press("Enter");
	await startChip.click();
	const startMenu = page.getByRole("menu", {
		name: "Where the session starts",
	});
	await expect(startMenu).toContainText("New worktree");
	await expect(startMenu).toContainText("Not supported by Main only");
	await expect(startMenu).not.toContainText("Across folders");
	await expect(startMenu).not.toContainText("Provider folder support");
	await page.screenshot({
		path: testInfo.outputPath("unsupported-provider-start.png"),
	});
	await page.keyboard.press("Escape");
	await picker.click();
	await page.getByTestId("picker-row-harness").click();
	await page.getByTestId("picker-instance-claude").click();
	await page.keyboard.press("Escape");
	await expect(startChip).toHaveText("Current folder");
	await expect(startChip).not.toHaveAttribute("aria-describedby");
	await expect(explanation).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Send message", exact: true }),
	).toBeEnabled();
	await page.screenshot({
		path: testInfo.outputPath("supported-provider-start.png"),
	});
	expect(
		control.rpc
			.getRequests()
			.filter((request) => request.tag === "CreateSession"),
	).toEqual([]);

	// Missing capabilities must not block sending into a multi-folder draft.
	sendMockDaemonList(page, "SubscribeInstances", {
		instances: [],
		providerCapabilities: {},
	});
	sendMockDaemonList(page, "SubscribeProjects", {
		projects: baseProjects().map((project) =>
			project.slug === "myapp"
				? { ...project, folders: ["/src/myapp", "/src/server"] }
				: project,
		),
	});
	await expect(startChip).toHaveText("Current folder");
	await expect(startChip).not.toHaveAttribute("aria-describedby");
	await expect(explanation).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Send message", exact: true }),
	).toBeEnabled();
	await startChip.click();
	await expect(startMenu).toContainText("New worktree soon");
	await page.keyboard.press("Escape");
	await page.screenshot({
		path: testInfo.outputPath("unknown-provider-start.png"),
	});
	control.rpc.setResponse("CreateSession", {
		projectSlug: "myapp",
		sessionId: "sess-unknown-capabilities",
	});
	await input.press("Enter");
	await expect
		.poll(() =>
			control.rpc
				.getRequests()
				.filter((request) => request.tag === "CreateSession"),
		)
		.toHaveLength(1);
	await expect
		.poll(() =>
			control.rpc
				.getRequests()
				.filter((request) => request.tag === "input.submit"),
		)
		.toHaveLength(1);
});

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
