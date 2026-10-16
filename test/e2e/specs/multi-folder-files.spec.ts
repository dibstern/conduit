import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple", viewport: { width: 1440, height: 900 } });

for (const multiple of [true, false]) {
	test(
		multiple
			? "Files shows labelled folders and opens the second without sharing caches"
			: "a single folder has no extra root row",
		async ({ page, harness }, testInfo) => {
			const projectSlug = "e2e-replay";
			const primary = "/workspace/web";
			const secondary = "/workspace/api";
			const folders = multiple ? [primary, secondary] : [primary];
			const projects = [
				{ slug: projectSlug, title: "Folders project", folders },
			];
			const session = {
				accountId: null,
				id: "folders-session",
				title: "Folders session",
				status: "idle",
				projectSlug,
			};
			let moved = false;
			const rpc = await mockWsRpc(page, {
				handlers: {
					GetModels: ({ projectSlug }) => ({ projectSlug, providers: [] }),
					GetProjects: () => ({ projects, current: projectSlug }),
					GetAgents: () => ({
						projectSlug,
						agents: [],
						providerScope: { id: "claude", name: "Claude" },
						instanceId: "claude",
					}),
					ListDaemonSessions: () => ({
						sessions: [session],
						availability: [],
						hasMore: false,
						nextCursor: null,
					}),
					GetFileTree: () => ({
						projectSlug,
						entries: ["primary-only.txt", "src/", "src/index.ts"],
						...(multiple
							? {
									roots: [
										{ root: primary, label: "web" },
										{ root: secondary, label: "api" },
									],
								}
							: {}),
					}),
					GetFileList: ({ root, path = "." }) => ({
						projectSlug,
						path,
						...(root ? { root } : {}),
						entries:
							path === "src"
								? [{ name: "index.ts", type: "file" }]
								: [
										{ name: "src", type: "directory" },
										{
											name:
												root === secondary
													? "secondary-only.txt"
													: "primary-only.txt",
											type: "file",
										},
									],
					}),
					GetFileContent: ({ root, path }) => ({
						projectSlug,
						path,
						...(root ? { root } : {}),
						content:
							root === secondary
								? moved
									? "secondary worktree content"
									: "secondary content"
								: "primary content",
					}),
				},
			});
			await mockRelayWebSocket(page, {
				initMessages: [
					{ type: "project_list", projects, current: projectSlug },
					{ type: "shell_snapshot", roots: true, sessions: [session] },
				],
				responses: new Map(),
			});
			await page.goto(`${harness.relayBaseUrl}/s/folders-session`);
			await expect(page.getByTestId("session-bar-title")).toHaveText(
				"Folders session",
			);
			await page.getByTestId("views-rail-files").click();
			const pane = page.getByTestId("side-pane-files");
			if (multiple) {
				const roots = pane.locator("[data-file-root]");
				await expect(roots).toHaveCount(2);
				await expect(roots).toHaveText(["web", "api"]);
				const api = roots.nth(1);
				await api.click();
				const apiTree = api.locator("..");
				await apiTree.getByRole("button", { name: "src", exact: true }).click();
				await apiTree
					.getByRole("button", { name: "index.ts", exact: true })
					.click();
				await expect(pane.locator(".fv-content")).toContainText(
					"secondary content",
				);
				await pane.getByRole("button", { name: "File browser" }).click();
				const web = roots.nth(0);
				await web.click();
				const webTree = web.locator("..");
				await expect(
					webTree.getByRole("button", { name: "src", exact: true }),
				).toHaveAttribute("aria-expanded", "false");
				await webTree.getByRole("button", { name: "src", exact: true }).click();
				await webTree
					.getByRole("button", { name: "index.ts", exact: true })
					.click();
				await expect(pane.locator(".fv-content")).toContainText(
					"primary content",
				);
				// Changing only the secondary workspace must invalidate its cached file.
				moved = true;
				rpc.upsertShellRow({
					...session,
					workspace: {
						cause: "user",
						origin: "existing",
						worktrees: {
							[secondary]: "/workspace/api-worktree",
							[primary]: primary,
						},
					},
				});
				await expect(pane.locator("#file-viewer")).toHaveCount(0);
				await api.click();
				await apiTree.getByRole("button", { name: "src", exact: true }).click();
				await apiTree
					.getByRole("button", { name: "index.ts", exact: true })
					.click();
				await expect(pane.locator(".fv-content")).toContainText(
					"secondary worktree content",
				);
				const contentRequests = rpc
					.getRequests()
					.filter(({ tag }) => tag === "GetFileContent");
				expect(
					contentRequests.map(({ payload }) => ({
						root: payload["root"],
						path: payload["path"],
					})),
				).toEqual([
					{ root: secondary, path: "src/index.ts" },
					{ root: primary, path: "src/index.ts" },
					{ root: secondary, path: "src/index.ts" },
				]);
			} else {
				await expect(
					pane.getByText("primary-only.txt", { exact: true }),
				).toBeVisible();
				await expect(pane.locator("[data-file-root]")).toHaveCount(0);
				await pane
					.getByRole("button", { name: "primary-only.txt", exact: true })
					.click();
				await expect(pane.locator(".fv-content")).toContainText(
					"primary content",
				);
				expect(
					rpc
						.getRequests()
						.filter(
							({ tag }) => tag === "GetFileList" || tag === "GetFileContent",
						)
						.every(({ payload }) => payload["root"] === undefined),
				).toBe(true);
			}
			const requests = rpc
				.getRequests()
				.filter(({ tag }) =>
					["GetFileTree", "GetFileList", "GetFileContent"].includes(tag),
				)
				.map(({ tag, payload }) => ({
					tag,
					root: payload["root"] ?? null,
					path: payload["path"] ?? null,
					sessionId: payload["sessionId"] ?? null,
				}));
			await testInfo.attach("folder-file-requests", {
				body: `${JSON.stringify(requests, null, 2)}\n`,
				contentType: "application/json",
			});
			await page.screenshot({
				path: testInfo.outputPath("folder-file-preview.png"),
				animations: "disabled",
			});
		},
	);
}
