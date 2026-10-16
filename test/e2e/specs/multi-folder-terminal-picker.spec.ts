import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Failure modes: the picker requires an open file panel; folder order or labels
// change; selection sends a worktree path instead of its root; default creates
// gain a root; single-folder projects gain UI; phone controls are unreachable.
test.use({ recording: "chat-simple" });

for (const scenario of [
	{
		name: "desktop",
		viewport: { width: 1440, height: 900 },
		roots: [
			{ root: "/workspace/web", label: "web" },
			{ root: "/workspace/api", label: "api" },
		],
	},
	{
		name: "phone",
		viewport: { width: 390, height: 844 },
		roots: [
			{ root: "/workspace/web", label: "web" },
			{ root: "/workspace/api", label: "api" },
		],
	},
	{
		name: "colliding folder names",
		viewport: { width: 1440, height: 900 },
		roots: [
			{ root: "/workspace/one/app", label: "/workspace/one/app" },
			{ root: "/workspace/two/app", label: "/workspace/two/app" },
		],
	},
	{
		name: "single folder",
		viewport: { width: 1440, height: 900 },
		roots: [{ root: "/workspace/web", label: "web" }],
	},
]) {
	test.describe(scenario.name, () => {
		test.use({ viewport: scenario.viewport });
		test("new terminals keep their default and offer the session's folders", async ({
			page,
			harness,
		}, testInfo) => {
			const projectSlug = "e2e-replay";
			const primary = scenario.roots[0]?.root ?? "";
			const secondary = scenario.roots[1]?.root;
			const projects = [
				{
					slug: projectSlug,
					title: "Terminal folders project",
					folders: scenario.roots.map(({ root }) => root),
				},
			];
			const session = {
				accountId: null,
				id: "terminal-folders-session",
				title: "Terminal folders session",
				status: "idle" as const,
				projectSlug,
				workspace: {
					cause: "user" as const,
					origin: "existing" as const,
					worktrees: {
						[primary]: "/workspace/web-worktree",
						...(secondary ? { [secondary]: "/workspace/api-worktree" } : {}),
					},
				},
			};
			let terminalCount = 0;
			let rpc: RpcMockControl;
			rpc = await mockWsRpc(page, {
				stubs: {
					GetFileTree: () => ({
						projectSlug,
						entries: [],
						...(secondary ? { roots: scenario.roots } : {}),
					}),
					ListDaemonSessions: () => ({
						sessions: [session],
						availability: [],
						hasMore: false,
						nextCursor: null,
					}),
					GetModels: ({ projectSlug }) => ({
						defaultOpenCodeInstanceId: "opencode",
						projectSlug,
						providers: [],
					}),
					GetAgents: () => ({
						projectSlug,
						agents: [],
						providerScope: { id: "claude", name: "Claude" },
						instanceId: "claude",
					}),
				},
				handlers: {
					GetProjects: () => ({ projects, current: projectSlug }),
					CreatePty: ({ root }) => {
						const id = `pty-${++terminalCount}`;
						rpc.sendChunk("SubscribePtys", [
							{
								_tag: "upsert",
								item: {
									id,
									title: "Terminal",
									command: "sh",
									cwd:
										root && root === secondary
											? "/workspace/api-worktree"
											: "/workspace/web-worktree",
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
					{ type: "shell_snapshot", roots: true, sessions: [session] },
				],
				responses: new Map(),
			});
			await page.goto(`${harness.relayBaseUrl}/s/${session.id}`);
			await expect(page.getByTestId("session-bar-title")).toHaveText(
				session.title,
			);
			await expect(page.getByTestId("side-pane-files")).toBeHidden();
			if (scenario.viewport.width <= 480) {
				await page.getByTestId("session-bar-island-overflow").click();
				await page.getByTestId("overflow-view-terminal").click();
			} else {
				await page.getByTestId("views-rail-terminal").click();
			}
			await expect(page.locator(".term-tab")).toHaveCount(1);
			await page.locator(".term-new-btn").click();
			await expect(page.locator(".term-tab")).toHaveCount(2);
			const picker = page.getByTestId("new-terminal-folder-picker");
			if (secondary) {
				await expect(picker).toHaveAccessibleName("New terminal in folder");
				await picker.scrollIntoViewIfNeeded();
				await expect(picker).toBeInViewport();
				await picker.click();
				const items = page.getByTestId("new-terminal-folder-item");
				await expect(items).toHaveText(
					scenario.roots.map(({ label }) => label),
				);
				await page.screenshot({
					path: testInfo.outputPath("terminal-folder-picker.png"),
					animations: "disabled",
				});
				await items.nth(1).click();
				await expect(page.locator(".term-tab")).toHaveCount(3);
				await expect(items).toHaveCount(0);
			} else {
				await expect(picker).toHaveCount(0);
			}
			const creates = rpc
				.getRequests()
				.filter(({ tag }) => tag === "CreatePty")
				.map(({ payload }) => ({
					sessionId: payload["sessionId"],
					root: payload["root"] ?? null,
				}));
			expect(creates).toEqual([
				{ sessionId: session.id, root: null },
				{ sessionId: session.id, root: null },
				...(secondary ? [{ sessionId: session.id, root: secondary }] : []),
			]);
			await testInfo.attach("terminal-folder-creates", {
				body: `${JSON.stringify(creates, null, 2)}\n`,
				contentType: "application/json",
			});
		});
	});
}
