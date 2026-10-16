import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple", viewport: { width: 1440, height: 900 } });

test("files, mentions and new terminals follow a session move and navigation", async ({
	page,
	harness,
}, testInfo) => {
	const projectSlug = "e2e-replay";
	const main = "/workspace/main";
	const worktree = "/workspace/worktree";
	const projects = [
		{ slug: projectSlug, title: "Workspace project", folders: [main] },
	];
	let moved = false;
	let terminalCount = 0;
	const sessions = [
		{
			accountId: null,
			id: "workspace-session",
			title: "Workspace session",
			status: "idle",
			projectSlug,
		},
		{
			accountId: null,
			id: "main-session",
			title: "Main session",
			status: "idle",
			projectSlug,
		},
	];
	let rpc: RpcMockControl;
	const folder = (sessionId: unknown) =>
		moved && sessionId === "workspace-session" ? worktree : main;
	rpc = await mockWsRpc(page, {
		stubs: {
			GetFileTree: ({ sessionId }) => ({
				projectSlug,
				entries: [
					folder(sessionId) === worktree
						? "worktree-only.txt"
						: "main-only.txt",
					"shared.txt",
					"nested/",
					"nested/child.txt",
				],
			}),
			GetFileList: ({ sessionId, path = "." }) => ({
				projectSlug,
				path,
				entries:
					path === "nested"
						? [{ name: "child.txt", type: "file" }]
						: [
								{
									name:
										folder(sessionId) === worktree
											? "worktree-only.txt"
											: "main-only.txt",
									type: "file",
								},
								{ name: "shared.txt", type: "file" },
								{ name: "nested", type: "directory" },
							],
			}),
			GetFileContent: ({ sessionId, path }) => ({
				projectSlug,
				path,
				content: `${folder(sessionId) === worktree ? "worktree" : "main"} content`,
			}),
		},
		handlers: {
			GetModels: ({ projectSlug }) => ({ projectSlug, providers: [] }),
			GetProjects: () => ({
				projects,
				current: projectSlug,
			}),
			GetAgents: () => ({
				projectSlug,
				agents: [],
				providerScope: { id: "claude", name: "Claude" },
				instanceId: "claude",
			}),
			ListDaemonSessions: () => ({
				sessions,
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			CreatePty: ({ sessionId }) => {
				const id = `pty-${++terminalCount}`;
				rpc.sendChunk("SubscribePtys", [
					{
						_tag: "upsert",
						item: {
							id,
							title: "Terminal",
							command: "sh",
							cwd: folder(sessionId),
							status: "running",
							pid: terminalCount,
						},
					},
				]);
				return { ok: true };
			},
		},
		streams: {
			SubscribePtys: () => [
				{ _tag: "snapshot", rows: [] },
				{ _tag: "synchronized" },
			],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: projectSlug },
			{ type: "shell_snapshot", roots: true, sessions },
		],
		responses: new Map(),
	});
	await page.goto(`${harness.relayBaseUrl}/s/workspace-session`);
	await expect(page.getByTestId("session-bar-title")).toHaveText(
		"Workspace session",
	);
	await page.getByTestId("views-rail-files").click();
	const pane = page.getByTestId("side-pane-files");
	await expect(pane.getByText("main-only.txt", { exact: true })).toBeVisible();
	await pane.getByRole("button", { name: "shared.txt", exact: true }).click();
	await expect(pane.locator(".fv-content")).toContainText("main content");
	// A live row update, as another browser's or the agent's move would arrive.
	moved = true;
	rpc.upsertShellRow({
		...sessions[0],
		id: "workspace-session",
		workspace: {
			cause: "user",
			origin: "existing",
			worktrees: { [main]: worktree },
		},
	});
	await expect(pane.locator("#file-viewer")).toHaveCount(0);
	await expect(
		pane.getByText("worktree-only.txt", { exact: true }),
	).toBeVisible();
	await expect(pane.getByText("main-only.txt", { exact: true })).toHaveCount(0);
	await pane.getByRole("button", { name: "nested", exact: true }).click();
	await pane.getByRole("button", { name: "child.txt", exact: true }).click();
	await expect(pane.locator(".fv-content")).toContainText("worktree content");
	await pane.getByRole("button", { name: "File browser" }).click();
	await page.getByTestId("views-rail-terminal").click();
	await expect(page.locator(".term-tab")).toHaveCount(1);
	await page.locator(".term-new-btn").click();
	await expect(page.locator(".term-tab")).toHaveCount(2);
	const creates = rpc.getRequests().filter(({ tag }) => tag === "CreatePty");
	expect(creates.map(({ payload }) => payload["sessionId"])).toEqual([
		"workspace-session",
		"workspace-session",
	]);
	await page.getByTestId("views-rail-terminal").click();
	await page.locator("#input").fill("@worktree-only");
	await expect(
		page
			.locator("#file-menu")
			.getByRole("option", { name: "worktree-only.txt" }),
	).toBeVisible();
	await page.locator("#input").fill("");
	await page.goto(`${harness.relayBaseUrl}/s/main-session`);
	await expect(page.getByTestId("session-bar-title")).toHaveText(
		"Main session",
	);
	await page.getByTestId("views-rail-files").click();
	await expect(pane.getByText("main-only.txt", { exact: true })).toBeVisible();
	await expect(
		pane.getByText("worktree-only.txt", { exact: true }),
	).toHaveCount(0);
	const requests = rpc
		.getRequests()
		.filter(({ tag }) =>
			["GetFileTree", "GetFileList", "GetFileContent", "CreatePty"].includes(
				tag,
			),
		)
		.map(({ tag, payload }) => ({
			tag,
			sessionId: payload["sessionId"] ?? null,
			path: payload["path"] ?? null,
		}))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	expect(
		requests
			.filter(({ tag }) => tag === "GetFileContent")
			.every(({ sessionId }) => sessionId === "workspace-session"),
	).toBe(true);
	expect(
		requests.some(
			({ tag, sessionId }) =>
				tag === "GetFileTree" && sessionId === "main-session",
		),
	).toBe(true);
	await testInfo.attach("workspace-file-terminal-requests", {
		body: `${JSON.stringify(requests, null, 2)}\n`,
		contentType: "application/json",
	});
	await page.screenshot({
		path: testInfo.outputPath("main-session-files.png"),
		animations: "disabled",
	});
});
