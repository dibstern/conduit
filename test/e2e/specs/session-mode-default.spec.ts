import { writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import type { SessionMode } from "../../../src/lib/contracts/project-file.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Failure cases, written before implementation: a lower default replaces a
// higher one; invalid files hide their warning; worktree defaults bypass Git or
// provider capabilities; a delayed default replaces an explicit Local choice;
// switching projects accepts the old response; provider changes do not resolve;
// a global edit changes the open draft or misses the next one; project saves
// omit the explicit override or clear, including Add and mode-only edits.
// A first send must wait for an unresolved default unless the user chose a mode.
// Leaving and returning to a project must invalidate a send waiting in its old draft.
test.use({ recording: "chat-simple" });

const slug = "e2e-replay";
type Resolution = {
	mode: SessionMode;
	source: "project" | "file" | "global";
	warning?: string;
};
const controls = new WeakMap<Page, RpcMockControl>();
const modelProviders = ["claude", "anthropic"].map((id) => ({
	id,
	name: id === "claude" ? "Claude" : "Anthropic",
	configured: true,
	models: [
		{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: id },
	],
}));

async function openDraft(
	page: Page,
	baseUrl: string,
	options: {
		resolve?: (projectSlug: string) => Resolution | Promise<Resolution>;
		git?: boolean;
		supportsNewWorktree?: boolean;
		sessionMode?: SessionMode;
	} = {},
) {
	let projects: ProjectInfo[] = [
		{
			slug,
			title: "Default project",
			folders: ["/workspace/app"],
			...(options.git === false ? {} : { git: { branch: "main" } }),
			...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
		},
		{
			slug: "second",
			title: "Second project",
			folders: ["/workspace/second"],
			git: { branch: "develop" },
		},
	];
	let globalMode: SessionMode = "local";
	const instances = {
		instances: ["claude", "opencode"].map((id) => ({
			id,
			name: id === "claude" ? "Claude" : "OpenCode",
			driver: id,
			isDefault: true,
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 0,
			capabilities: {
				supportsMultiFolder: true,
				supportsWorktree: id === "claude",
				supportsNewWorktree: options.supportsNewWorktree ?? true,
			},
		})),
	};
	const rpc = await mockWsRpc(page, {
		stubs: {
			FindFolders: ({ query }) => ({
				home: "/workspace",
				entries: query
					? [{ path: query, isGitRepo: true, exists: true, reason: "match" }]
					: [],
			}),
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			CreateSession: ({ projectSlug }) => ({
				projectSlug,
				sessionId: "created-session",
			}),
			PreWarmSession: () => undefined,
			PreWarmDraft: () => undefined,
			GetModels: (input) => ({
				defaultOpenCodeInstanceId: "opencode",
				projectSlug: "projectSlug" in input ? input.projectSlug : slug,
				providers: modelProviders.filter(
					({ id }) =>
						id === (input.instanceId === "claude" ? "claude" : "anthropic"),
				),
			}),
			GetAgents: (input) => ({
				projectSlug: "projectSlug" in input ? input.projectSlug : slug,
				instanceId: input.instanceId,
				providerScope: { id: input.instanceId ?? "claude", name: "Provider" },
				agents: [],
			}),
			ResolveSessionMode: ({ projectSlug }) =>
				options.resolve?.(String(projectSlug)) ?? {
					mode: globalMode,
					source: "global",
				},
			SetDefaultSessionMode: ({ mode }) => {
				if (mode !== "local" && mode !== "worktree")
					throw new Error("Unexpected session mode");
				globalMode = mode;
				rpc.setProjectSetting({ _tag: "defaultSessionMode", mode });
				return { mode };
			},
			GetProjects: () => ({ projects, current: slug }),
			SaveProject: ({ slug: editedSlug, sessionMode, title, folders }) => {
				const savedSlug = typeof editedSlug === "string" ? editedSlug : "added";
				const previous = projects.find((project) => project.slug === savedSlug);
				const { sessionMode: _previousMode, ...rest } = previous ?? {
					slug: savedSlug,
					folders: [],
				};
				const saved: ProjectInfo = {
					...rest,
					title: String(title),
					folders: folders as ProjectInfo["folders"],
					...(sessionMode === "local" || sessionMode === "worktree"
						? { sessionMode }
						: sessionMode === undefined && previous?.sessionMode
							? { sessionMode: previous.sessionMode }
							: {}),
				};
				projects = [...projects.filter((p) => p.slug !== savedSlug), saved];
				return { savedSlug, projects, warnings: [] };
			},
		},
		handlers: {
			GetInstances: () => instances,
			GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: slug },
			{ type: "shell_snapshot", roots: true, sessions: [] },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", instances);
	for (const account of instances.instances.filter(
		({ driver }) => driver === "claude",
	))
		rpc.setProjectSetting({
			_tag: "providerModels",
			accountId: account.id,
			providers: modelProviders.filter(({ id }) => id === "claude"),
		});
	rpc.setProjectSetting({
		_tag: "harnessDefaults",
		claude: {
			status: "ok",
			pick: {
				providerId: "claude",
				modelId: "claude-sonnet-4-5",
				effort: "",
				contextWindow: "",
			},
		},
		opencode: {
			status: "ok",
			pick: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-5",
				effort: "",
				contextWindow: "",
			},
		},
	});
	rpc.setProjectSetting({
		_tag: "defaultModel",
		model: "claude-sonnet-4-5",
		provider: "claude",
		variant: "",
	});
	rpc.setProjectSetting({ _tag: "defaultSessionMode", mode: globalMode });
	controls.set(page, rpc);
	await page.goto(`${baseUrl}/new?project=${slug}`);
	await expect(page.getByTestId("draft-start-chip")).toBeVisible();
	await rpc.waitForRequest(({ tag }) => tag === "ResolveSessionMode");
	return rpc;
}

test.afterEach(async ({ page }, info) => {
	const requests =
		controls
			.get(page)
			?.getRequests()
			.filter(({ tag }) =>
				[
					"ResolveSessionMode",
					"SaveProject",
					"SetDefaultSessionMode",
					"CreateSession",
					"PreWarmDraft",
				].includes(tag),
			) ?? [];
	const artifact = info.outputPath("session-mode-default.json");
	writeFileSync(artifact, `${JSON.stringify({ requests }, null, 2)}\n`);
	await info.attach("session-mode-default-state", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = info.outputPath("session-mode-default.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("session-mode-default", {
		path: screenshot,
		contentType: "image/png",
	});
});

for (const viewport of [
	{ name: "desktop", size: { width: 1440, height: 900 }, phone: false },
	{ name: "phone", size: { width: 390, height: 844 }, phone: true },
]) {
	test.describe(viewport.name, () => {
		test.use({ viewport: viewport.size, hasTouch: viewport.phone });
		const press = (target: Locator) =>
			viewport.phone ? target.tap() : target.click();

		async function openEdit(page: Page) {
			const back = page.getByTestId("session-bar-back");
			if (await back.isVisible()) await press(back);
			await press(page.getByTestId("session-scope-chip"));
			const row = page
				.getByRole("menu", { name: "Project scope" })
				.getByRole("menuitemradio")
				.filter({ hasText: `project:${slug}` });
			if (!viewport.phone) await row.hover();
			await press(row.getByTestId("session-scope-edit"));
			return page.getByRole("dialog", { name: "Edit project", exact: true });
		}

		for (const mode of ["local", "worktree"] as const) {
			test(`starts in the resolved ${mode} mode and sends that workspace`, async ({
				page,
				harness,
			}) => {
				const rpc = await openDraft(page, harness.relayBaseUrl, {
					resolve: () => ({ mode, source: "file" }),
				});
				await expect(page.getByTestId("draft-start-chip")).toHaveText(
					mode === "worktree" ? "New worktree" : "main",
				);
				await page.locator("#input").focus();
				const warm =
					mode === "local"
						? await rpc.waitForRequest(({ tag }) => tag === "PreWarmDraft")
						: undefined;
				if (mode === "worktree") {
					await page.waitForTimeout(175);
					expect(
						rpc.getRequests().filter(({ tag }) => tag === "PreWarmDraft"),
					).toHaveLength(0);
				}
				await page.locator("#input").fill("Use the default workspace");
				await press(page.locator("#send"));
				const request = await rpc.waitForRequest(
					({ tag }) => tag === "CreateSession",
				);
				expect(request.payload).toMatchObject({
					_tag: "CreateSession",
					projectSlug: slug,
				});
				if (mode === "worktree")
					expect(request.payload).toHaveProperty("newWorktree", true);
				else expect(request.payload).not.toHaveProperty("newWorktree");
				if (warm)
					expect(request.payload).toEqual({
						...warm.payload,
						_tag: "CreateSession",
					});
			});
		}

		test("draft prewarm keeps its token through a failed create and rotates it after success", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			const input = page.locator("#input");
			await input.focus();
			const warm = await rpc.waitForRequest(
				({ tag }) => tag === "PreWarmDraft",
			);
			expect(warm.payload["draftId"]).toEqual(expect.any(String));
			rpc.setStubs({
				CreateSession: () => {
					throw new WsRpcError({ message: "simulated create failure" });
				},
			});
			await input.fill("Keep this message after failure");
			await press(page.locator("#send"));
			await expect(
				page.getByText("Failed to create session", { exact: true }),
			).toBeVisible();
			await expect(input).toHaveValue("Keep this message after failure");
			const failed = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(failed.payload).toEqual({
				...warm.payload,
				_tag: "CreateSession",
			});

			rpc.setStubs({
				CreateSession: () => ({
					projectSlug: slug,
					sessionId: "created-session",
				}),
			});
			await press(page.locator("#send"));
			await expect
				.poll(
					() =>
						rpc.getRequests().filter(({ tag }) => tag === "CreateSession")
							.length,
				)
				.toBe(2);
			const created = rpc
				.getRequests()
				.filter(({ tag }) => tag === "CreateSession")
				.at(-1);
			expect(created?.payload).toEqual({
				...warm.payload,
				_tag: "CreateSession",
			});
			await expect(page).toHaveURL(/\/s\/created-session$/);
			const back = page.getByTestId("session-bar-back");
			if (await back.isVisible()) await press(back);
			await press(page.locator("#new-session-btn:visible"));
			await expect(page).toHaveURL(/\/new\?/);
			await input.focus();
			const next = await rpc.waitForRequest(
				({ tag, payload }) =>
					tag === "PreWarmDraft" &&
					payload["draftId"] !== warm.payload["draftId"],
			);
			expect(next.payload).toEqual({
				...warm.payload,
				draftId: expect.any(String),
			});
		});

		for (const chooseLocal of [false, true]) {
			test(`a first send ${chooseLocal ? "uses an explicit Local choice" : "waits for the worktree default"} while resolution is pending`, async ({
				page,
				harness,
			}) => {
				let deliver = (_result: Resolution) => {};
				const pending = new Promise<Resolution>((resolve) => {
					deliver = resolve;
				});
				const rpc = await openDraft(page, harness.relayBaseUrl, {
					resolve: () => pending,
				});
				if (chooseLocal) {
					await press(page.getByTestId("draft-start-chip"));
					await press(
						page.getByRole("menuitemradio", { name: "Current checkout" }),
					);
				}
				await page.locator("#input").fill("Start with the intended workspace");
				await press(page.locator("#send"));
				if (chooseLocal) {
					const request = await rpc.waitForRequest(
						({ tag }) => tag === "CreateSession",
					);
					expect(request.payload).not.toHaveProperty("newWorktree");
				} else {
					expect(
						rpc.getRequests().filter(({ tag }) => tag === "CreateSession"),
					).toHaveLength(0);
				}
				deliver({ mode: "worktree", source: "project" });
				const request = await rpc.waitForRequest(
					({ tag }) => tag === "CreateSession",
				);
				expect(request.payload).toMatchObject({
					_tag: "CreateSession",
					projectSlug: slug,
				});
				if (!chooseLocal)
					expect(request.payload).toHaveProperty("newWorktree", true);
			});
		}

		test("a send waiting in an earlier draft is abandoned when the user switches away and back", async ({
			page,
			harness,
		}) => {
			let deliverFirst = (_result: Resolution) => {};
			let deliverCurrent = (_result: Resolution) => {};
			const first = new Promise<Resolution>((resolve) => {
				deliverFirst = resolve;
			});
			const current = new Promise<Resolution>((resolve) => {
				deliverCurrent = resolve;
			});
			let returned = false;
			const rpc = await openDraft(page, harness.relayBaseUrl, {
				resolve: (project) =>
					project === slug
						? returned
							? current
							: first
						: { mode: "local", source: "global" },
			});
			await page.locator("#input").fill("Keep this draft");
			await press(page.locator("#send"));
			await press(page.getByTestId("draft-project-chip"));
			await press(page.getByRole("menuitemradio", { name: /Second project/ }));
			await expect(page.getByTestId("draft-start-chip")).toHaveText("develop");
			const before = rpc
				.getRequests()
				.filter(({ tag }) => tag === "ResolveSessionMode").length;
			returned = true;
			await press(page.getByTestId("draft-project-chip"));
			await press(page.getByRole("menuitemradio", { name: /Default project/ }));
			await expect
				.poll(
					() =>
						rpc.getRequests().filter(({ tag }) => tag === "ResolveSessionMode")
							.length,
				)
				.toBeGreaterThan(before);
			deliverFirst({ mode: "local", source: "file" });
			await expect(
				rpc.waitForRequest(({ tag }) => tag === "CreateSession", 1000),
			).rejects.toThrow("Timed out waiting for RPC request");
			deliverCurrent({ mode: "worktree", source: "project" });
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				_tag: "CreateSession",
				projectSlug: slug,
				newWorktree: true,
			});
		});

		test("shows the invalid-file warning near the chip", async ({
			page,
			harness,
		}) => {
			await openDraft(page, harness.relayBaseUrl, {
				resolve: () => ({
					mode: "local",
					source: "global",
					warning:
						"Invalid conduit.json: sessionMode must be local or worktree",
				}),
			});
			await expect(page.getByTestId("draft-session-mode-warning")).toHaveText(
				"Invalid conduit.json: sessionMode must be local or worktree",
			);
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
		});

		for (const limitation of ["git", "provider"] as const) {
			test(`a file worktree default falls back to Local without ${limitation} support`, async ({
				page,
				harness,
			}) => {
				await openDraft(page, harness.relayBaseUrl, {
					git: limitation !== "git",
					supportsNewWorktree: limitation !== "provider",
					resolve: () => ({ mode: "worktree", source: "file" }),
				});
				await expect(page.getByTestId("draft-start-chip")).toHaveText(
					limitation === "git" ? "Current folder" : "main",
				);
				await press(page.getByTestId("draft-start-chip"));
				const choice = page.getByRole("menuitem", { name: /New worktree/ });
				await expect(choice).toHaveAttribute("aria-disabled", "true");
				await expect(choice).toContainText(
					limitation === "git"
						? "Requires a Git folder"
						: "Not supported by Claude",
				);
			});
		}

		test("a Local choice made before resolution survives the late worktree default", async ({
			page,
			harness,
		}) => {
			let deliver = (_result: Resolution) => {};
			const pending = new Promise<Resolution>((resolve) => {
				deliver = resolve;
			});
			await openDraft(page, harness.relayBaseUrl, { resolve: () => pending });
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "Current checkout" }),
			);
			deliver({
				mode: "worktree",
				source: "project",
				warning: "Invalid conduit.json: malformed JSON",
			});
			await expect(
				page.getByTestId("draft-session-mode-warning"),
			).toBeVisible();
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveCount(0);
		});

		test("a project switch re-resolves and ignores the previous project's late result", async ({
			page,
			harness,
		}) => {
			let deliver = (_result: Resolution) => {};
			const pending = new Promise<Resolution>((resolve) => {
				deliver = resolve;
			});
			const rpc = await openDraft(page, harness.relayBaseUrl, {
				resolve: (project) =>
					project === slug ? pending : { mode: "worktree", source: "project" },
			});
			await page.locator("#input").fill("Keep this draft");
			await press(page.getByTestId("draft-project-chip"));
			await press(page.getByRole("menuitemradio", { name: /Second project/ }));
			await rpc.waitForRequest(
				({ tag, payload }) =>
					tag === "ResolveSessionMode" && payload["projectSlug"] === "second",
			);
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			deliver({
				mode: "local",
				source: "file",
				warning: "Stale project warning",
			});
			await page.setViewportSize(
				viewport.phone
					? { width: 1440, height: 900 }
					: { width: 390, height: 844 },
			);
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			await expect(page.getByTestId("draft-session-mode-warning")).toHaveCount(
				0,
			);
			await expect(page.locator("#input")).toHaveValue("Keep this draft");
		});

		test("a provider change re-resolves without replacing an explicit Local choice", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, {
				resolve: () => ({ mode: "worktree", source: "file" }),
			});
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "Current checkout" }),
			);
			const before = rpc
				.getRequests()
				.filter(({ tag }) => tag === "ResolveSessionMode").length;
			await press(
				page.locator(
					'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
				),
			);
			const back = page.getByTestId("picker-back");
			if (await back.isVisible()) await press(back);
			await press(page.getByTestId("picker-harness-opencode"));
			await page.keyboard.press("Escape");
			await expect
				.poll(
					() =>
						rpc.getRequests().filter(({ tag }) => tag === "ResolveSessionMode")
							.length,
				)
				.toBeGreaterThan(before);
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
		});

		test("a global settings edit applies to the next draft", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
			const before = rpc
				.getRequests()
				.filter(({ tag }) => tag === "ResolveSessionMode").length;
			await press(
				page.locator(
					'[data-testid="session-bar-overflow"]:visible, [data-testid="session-bar-island-overflow"]:visible',
				),
			);
			await press(page.getByTestId("overflow-settings"));
			const panel = page.locator("#settings-panel");
			await press(page.getByTestId("settings-tab-general"));
			await panel
				.getByRole("combobox", { name: "Default session mode" })
				.selectOption("worktree");
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "SetDefaultSessionMode",
			);
			expect(request.payload).toMatchObject({
				_tag: "SetDefaultSessionMode",
				mode: "worktree",
			});
			await expect(
				panel.getByRole("combobox", { name: "Default session mode" }),
			).toHaveValue("worktree");
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
			await page.keyboard.press("Escape");
			await page.goto(`${harness.relayBaseUrl}/new?project=${slug}`);
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "ResolveSessionMode")
					.length,
			).toBeGreaterThan(before);
		});

		test("ProjectDialog saves a mode-only edit and explicitly clears the override", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, {
				sessionMode: "local",
			});
			let dialog = await openEdit(page);
			const field = dialog.getByRole("combobox", {
				name: "Default session mode",
			});
			await expect(field).toHaveValue("local");
			await expect(
				dialog.getByRole("button", { name: "Save", exact: true }),
			).toBeDisabled();
			await field.selectOption("worktree");
			await press(dialog.getByRole("button", { name: "Save", exact: true }));
			await expect(dialog).toBeHidden();
			expect(
				rpc
					.getRequests()
					.filter(({ tag }) => tag === "SaveProject")
					.at(-1)?.payload,
			).toEqual({
				_tag: "SaveProject",
				slug,
				title: "Default project",
				folders: ["/workspace/app"],
				sessionMode: "worktree",
			});
			await press(page.getByTestId("session-scope-chip"));
			const row = page
				.getByRole("menu", { name: "Project scope" })
				.getByRole("menuitemradio")
				.filter({ hasText: `project:${slug}` });
			if (!viewport.phone) await row.hover();
			await press(row.getByTestId("session-scope-edit"));
			dialog = page.getByRole("dialog", { name: "Edit project", exact: true });
			await expect(
				dialog.getByRole("combobox", { name: "Default session mode" }),
			).toHaveValue("worktree");
			await dialog
				.getByRole("combobox", { name: "Default session mode" })
				.selectOption("");
			await press(dialog.getByRole("button", { name: "Save", exact: true }));
			await expect(dialog).toBeHidden();
			expect(
				rpc
					.getRequests()
					.filter(({ tag }) => tag === "SaveProject")
					.at(-1)?.payload,
			).toEqual({
				_tag: "SaveProject",
				slug,
				title: "Default project",
				folders: ["/workspace/app"],
				sessionMode: null,
			});
		});

		test("ProjectDialog includes the chosen mode when adding a project", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			const back = page.getByTestId("session-bar-back");
			if (await back.isVisible()) await press(back);
			await press(page.getByTestId("session-scope-chip"));
			await press(page.getByRole("menuitem", { name: "Add a project…" }));
			const dialog = page.getByRole("dialog", {
				name: "Add project",
				exact: true,
			});
			await dialog
				.getByRole("combobox", { name: "Add folder" })
				.fill("/workspace/new-app");
			await press(
				dialog.getByRole("option", { name: "/workspace/new-app", exact: true }),
			);
			await dialog
				.getByRole("combobox", { name: "Default session mode" })
				.selectOption("worktree");
			await press(
				dialog.getByRole("button", { name: "Add project", exact: true }),
			);
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "SaveProject",
			);
			expect(request.payload).toEqual({
				_tag: "SaveProject",
				title: "new-app",
				folders: ["/workspace/new-app"],
				sessionMode: "worktree",
			});
		});
	});
}
