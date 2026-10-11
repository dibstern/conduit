import { writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { WorktreeCreationError } from "../../../src/lib/contracts/worktree.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

const main = "/workspace/app";
const isolated = "/conduit/worktrees/e2e-replay/draft-session/app";
const branch = "conduit/session-draft";
const controls = new WeakMap<Page, RpcMockControl>();

async function openDraft(
	page: Page,
	baseUrl: string,
	options: {
		provider?: "claude" | "opencode";
		folders?: number;
		fail?: boolean;
	} = {},
) {
	const provider = options.provider ?? "claude";
	const projects = [
		{
			slug: "e2e-replay",
			title: "App",
			instanceId: provider,
			folders: options.folders === 2 ? [main, "/workspace/docs"] : [main],
			git: { branch: "main" },
		},
	];
	const instances = {
		instances: [
			{
				id: provider,
				name: "Draft provider",
				driver: provider,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
				capabilities: {
					supportsMultiFolder: true,
					supportsWorktree: provider === "claude",
				},
			},
		],
	};
	let sessions: readonly Record<string, unknown>[] = [];
	const rpc = await mockWsRpc(page, {
		handlers: {
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			GetInstances: () => instances,
			GetModels: () => ({ projectSlug: "e2e-replay", providers: [] }),
			GetAgents: () => ({
				projectSlug: "e2e-replay",
				instanceId: provider,
				providerScope: { id: provider, name: "Draft provider" },
				agents: [],
			}),
			ListDaemonSessions: () => ({
				sessions,
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			CreateSession: ({ projectSlug, newWorktree }) => {
				if (options.fail)
					throw new WorktreeCreationError({
						reason: "git-failed",
						path: main,
						message: "Could not create worktree: simulated Git failure",
					});
				sessions = [
					{
						id: "draft-session",
						title: "New workspace",
						status: "idle",
						projectSlug,
						workspace: newWorktree
							? {
									cause: "launch",
									origin: "conduit",
									worktrees: { [main]: isolated },
								}
							: null,
						git: newWorktree ? { branch, worktree: "app" } : { branch: "main" },
					},
				];
				rpc.setShellRows(sessions);
				return { projectSlug, sessionId: "draft-session" };
			},
			PreWarmSession: () => ({ ok: true }),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions: [] },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", instances);
	controls.set(page, rpc);
	await page.goto(`${baseUrl}/new?project=e2e-replay`);
	await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
	return rpc;
}

test.afterEach(async ({ page }, info) => {
	const requests =
		controls
			.get(page)
			?.getRequests()
			.filter(({ tag }) => ["CreateSession", "input.submit"].includes(tag))
			.map(({ tag, payload }) => ({
				tag,
				payload: Object.fromEntries(
					Object.entries(payload)
						.filter(([key]) => key !== "originId" && key !== "commandId")
						.sort(([a], [b]) => a.localeCompare(b)),
				),
			})) ?? [];
	const artifact = info.outputPath("new-worktree.json");
	writeFileSync(artifact, `${JSON.stringify({ requests }, null, 2)}\n`);
	await info.attach("new-worktree", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = info.outputPath("new-worktree.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("new-worktree", {
		path: screenshot,
		contentType: "image/png",
	});
});

for (const mode of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
	test.describe(mode.name, () => {
		test.use({ viewport: mode.viewport, hasTouch: mode.hasTouch });
		const press = (target: Locator) =>
			mode.hasTouch ? target.tap() : target.click();

		test("New worktree starts on a generated branch and renders the worktree pill", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await page.locator("#input").fill("Work in isolation");
			await press(page.getByTestId("draft-start-chip"));
			const choice = page.getByRole("menuitem", {
				name: "New worktree",
				exact: true,
			});
			await expect(choice).not.toHaveAttribute("aria-disabled", "true");
			await press(choice);
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			await expect(page.locator("#input")).toHaveValue("Work in isolation");
			expect(rpc.getRequests().some(({ tag }) => tag === "CreateSession")).toBe(
				false,
			);
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				projectSlug: "e2e-replay",
				newWorktree: true,
			});
			expect(request.payload).not.toHaveProperty("worktreePath");
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
			const pill = page.getByTestId("session-bar-identity");
			await expect(pill).toContainText(branch);
			await expect(pill.locator('[data-icon="worktree"]')).toBeVisible();
		});

		test("Current checkout clears New worktree and keeps the Local request", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "Current checkout" }),
			);
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
			await page.locator("#input").fill("Stay local");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).not.toHaveProperty("newWorktree");
			expect(request.payload).not.toHaveProperty("worktreePath");
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		});

		test("creation errors preserve the draft and never submit a turn", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, { fail: true });
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await page.locator("#input").fill("Keep this draft");
			await press(page.locator("#send"));
			await expect(
				page.getByText("Could not create worktree: simulated Git failure", {
					exact: true,
				}),
			).toBeVisible();
			await expect(page.locator("#input")).toHaveValue("Keep this draft");
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "input.submit"),
			).toEqual([]);
		});

		for (const options of [{ provider: "opencode" as const }, { folders: 2 }]) {
			test(`New worktree stays disabled for ${options.provider ?? "multiple folders"}`, async ({
				page,
				harness,
			}) => {
				const rpc = await openDraft(page, harness.relayBaseUrl, options);
				await press(page.getByTestId("draft-start-chip"));
				await expect(
					page.getByRole("menuitem", { name: /New worktree/ }),
				).toHaveAttribute("aria-disabled", "true");
				expect(
					rpc.getRequests().filter(({ tag }) => tag === "CreateSession"),
				).toEqual([]);
			});
		}
	});
}
