import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { WorkspaceMoveError } from "../../../src/lib/contracts/session-workspace.js";
import type { WorktreeInfo } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

const main = "/workspace/app";
const docs = "/workspace/docs";
const linked = "/workspace/app-draft";
const docsLinked = "/workspace/docs-draft";
const worktrees: readonly WorktreeInfo[] = [
	{ path: main, branch: "main", main: true },
	{ path: linked, branch: "feature/draft", main: false },
	{ path: docs, branch: "main", main: true },
	{ path: docsLinked, branch: "feature/docs", main: false },
];
const controls = new WeakMap<Page, RpcMockControl>();

async function openDraft(page: Page, baseUrl: string, supportsWorktree = true) {
	const provider = supportsWorktree ? "claude" : "opencode";
	const projects = [
		{
			slug: "e2e-replay",
			title: "App",
			folders: [main, docs],
			git: { branch: "main" },
		},
		{
			slug: "other",
			title: "Other",
			folders: ["/workspace/other"],
			git: { branch: "dev" },
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
				capabilities: { supportsMultiFolder: true, supportsWorktree },
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
			ListWorktrees: () => ({ worktrees }),
			CreateSession: ({ projectSlug, worktreePath }) => {
				const selected = worktrees.find(({ path }) => path === worktreePath);
				const folder = selected?.path === docsLinked ? docs : main;
				sessions = [
					{
						id: "draft-session",
						title: "Started from draft",
						status: "idle",
						projectSlug,
						workspace: selected
							? {
									cause: "launch",
									worktrees: { [folder]: selected.path },
									origin: "existing",
								}
							: null,
						git: {
							branch: selected?.branch ?? "main",
							...(selected && !selected.main
								? { worktree: selected.path.split("/").at(-1) }
								: {}),
						},
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
	await page.addInitScript(
		(id) => localStorage.setItem("conduit-selected-instance", id),
		provider,
	);
	await page.goto(`${baseUrl}/new?project=e2e-replay`);
	await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
	return rpc;
}

test.afterEach(async ({ page }, testInfo) => {
	const requests =
		controls
			.get(page)
			?.getRequests()
			.filter(({ tag }) =>
				["ListWorktrees", "CreateSession", "SendMessage"].includes(tag),
			)
			.map(({ tag, payload }) => ({
				tag,
				payload: Object.fromEntries(
					Object.entries(payload)
						.filter(([key]) => key !== "originId" && key !== "commandId")
						.sort(([a], [b]) => a.localeCompare(b)),
				),
			})) ?? [];
	const artifact = testInfo.outputPath("draft-worktree.json");
	writeFileSync(artifact, `${JSON.stringify({ requests }, null, 2)}\n`);
	await testInfo.attach("draft-worktree", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = testInfo.outputPath("draft-worktree.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await testInfo.attach("draft-worktree", {
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

		test("lists the project repositories' worktrees and sends the choice on first creation", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await page.locator("#input").fill("Start in docs");
			await page.getByTestId("draft-start-chip").click();
			await expect(
				page.getByRole("menuitemradio", { name: "Current checkout" }),
			).toHaveAttribute("aria-checked", "true");
			await expect(
				page.getByRole("menuitem", { name: /New worktree/ }),
			).toHaveAttribute("aria-disabled", "true");
			await expect(
				page.getByRole("menuitem", { name: /New branch/ }),
			).toHaveAttribute("aria-disabled", "true");
			await page
				.getByRole("menuitem", { name: "Existing worktree", exact: true })
				.click();
			for (const { path } of worktrees)
				await expect(
					page
						.getByRole("menuitemradio")
						.filter({ hasText: path })
						.filter({ has: page.getByText(path, { exact: true }) }),
				).toBeVisible();
			const list = await rpc.waitForRequest(
				({ tag }) => tag === "ListWorktrees",
			);
			expect(list.payload).toEqual({ projectSlug: "e2e-replay" });
			await page.getByRole("menuitemradio", { name: /feature\/docs/ }).click();
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"feature/docs",
			);
			await expect(page.locator("#input")).toHaveValue("Start in docs");
			expect(rpc.getRequests().some(({ tag }) => tag === "CreateSession")).toBe(
				false,
			);
			await page.getByTestId("draft-start-chip").click();
			await page
				.getByRole("menuitem", { name: "Existing worktree", exact: true })
				.click();
			await expect(
				page.getByRole("menuitemradio", { name: /feature\/docs/ }),
			).toHaveAttribute("aria-checked", "true");
			await page.keyboard.press("Escape");
			await page.locator("#send").click();
			const create = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(create.payload).toMatchObject({
				projectSlug: "e2e-replay",
				worktreePath: docsLinked,
			});
			const send = await rpc.waitForRequest(({ tag }) => tag === "SendMessage");
			expect(send.payload).toMatchObject({
				sessionId: "draft-session",
				text: "Start in docs",
			});
			await expect(page.getByTestId("session-bar-identity")).toContainText(
				"feature/docs",
			);
		});

		test("Current checkout clears the choice and the default sends no worktree path", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await page.getByTestId("draft-start-chip").click();
			await page
				.getByRole("menuitem", { name: "Existing worktree", exact: true })
				.click();
			await page.getByRole("menuitemradio", { name: /feature\/draft/ }).click();
			await page.getByTestId("draft-start-chip").click();
			await page
				.getByRole("menuitemradio", { name: "Current checkout" })
				.click();
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
			await page.locator("#input").fill("Use main");
			await page.locator("#send").click();
			const create = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(create.payload).not.toHaveProperty("worktreePath");
			await rpc.waitForRequest(({ tag }) => tag === "SendMessage");
		});

		test("a project change drops the previous project's worktree choice", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await page.getByTestId("draft-start-chip").click();
			await page
				.getByRole("menuitem", { name: "Existing worktree", exact: true })
				.click();
			await page.getByRole("menuitemradio", { name: /feature\/draft/ }).click();
			await page.getByTestId("draft-project-chip").click();
			await page.getByRole("menuitemradio", { name: /Other/ }).click();
			await expect(page.getByTestId("draft-start-chip")).toHaveText("dev");
			await page.locator("#input").fill("Other project");
			await page.locator("#send").click();
			const create = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(create.payload["projectSlug"]).toBe("other");
			expect(create.payload).not.toHaveProperty("worktreePath");
			await rpc.waitForRequest(({ tag }) => tag === "SendMessage");
		});

		test("a provider without worktree support cannot list or select existing worktrees", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, false);
			await page.getByTestId("draft-start-chip").click();
			await expect(
				page.getByRole("menuitem", { name: /Existing worktree/ }),
			).toHaveAttribute("aria-disabled", "true");
			await expect(
				page.getByRole("menuitem", { name: /Existing worktree/ }),
			).toContainText("Not supported by Draft provider");
			expect(rpc.getRequests().some(({ tag }) => tag === "ListWorktrees")).toBe(
				false,
			);
		});

		test("a removed worktree keeps the draft and explains why it could not start", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			rpc.setHandler("CreateSession", () => {
				throw new WorkspaceMoveError({ path: linked, reason: "missing" });
			});
			await page.locator("#input").fill("Keep this prompt");
			await page.getByTestId("draft-start-chip").click();
			await page
				.getByRole("menuitem", { name: "Existing worktree", exact: true })
				.click();
			await page.getByRole("menuitemradio", { name: /feature\/draft/ }).click();
			await page.locator("#send").click();
			await expect(
				page.getByText(
					"Could not start session: that worktree no longer exists",
					{ exact: true },
				),
			).toBeVisible();
			await expect(page).toHaveURL(/\/new\?project=e2e-replay$/);
			await expect(page.locator("#input")).toHaveValue("Keep this prompt");
			expect(rpc.getRequests().some(({ tag }) => tag === "SendMessage")).toBe(
				false,
			);
		});
	});
}
