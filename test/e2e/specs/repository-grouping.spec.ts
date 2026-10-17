import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import type {
	GroupingMode,
	ProjectInfo,
} from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { chooseSettingsOption } from "../helpers/settings.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Failure cases: linked checkouts lose their project qualifiers; lone projects
// retain redundant qualifiers; Off or a missing identity joins another project;
// mode-only edits cannot save; clearing an override omits the explicit null;
// project-list or default-setting updates leave open rows with stale labels;
// a delayed initial read overwrites a newer streamed default.
test.use({ recording: "chat-simple" });

const slug = "e2e-replay";
const repositoryKey = "github.com/acme/myapp";
const controls = new WeakMap<Page, RpcMockControl>();
const observations = new WeakMap<
	Page,
	Array<{
		phase: string;
		defaultMode?: string;
		rows: Array<{ id: string | null; label: string }>;
	}>
>();

function fixtureProjects(): ProjectInfo[] {
	return [
		{
			slug,
			title: "API package",
			folders: ["/workspace/myapp/packages/api"],
			repositoryIdentities: {
				"/workspace/myapp/packages/api": {
					key: repositoryKey,
					name: "myapp",
					root: "/workspace/myapp",
				},
			},
		},
		{
			slug: "web-checkout",
			title: "Web package",
			folders: ["/workspace/myapp-worktree/packages/web"],
			repositoryIdentities: {
				"/workspace/myapp-worktree/packages/web": {
					key: repositoryKey,
					name: "myapp",
					root: "/workspace/myapp-worktree",
				},
			},
		},
		{
			slug: "library",
			title: "Library checkout",
			folders: ["/workspace/library"],
			groupingMode: "repository",
			repositoryIdentities: {
				"/workspace/library": {
					key: "github.com/acme/library",
					name: "library",
					root: "/workspace/library",
				},
			},
		},
		{
			slug: "ungrouped",
			title: "Ungrouped checkout",
			folders: ["/workspace/myapp-unlinked"],
			groupingMode: "off",
			repositoryIdentities: {
				"/workspace/myapp-unlinked": {
					key: repositoryKey,
					name: "myapp",
					root: "/workspace/myapp-unlinked",
				},
			},
		},
		{
			slug: "notes",
			title: "Notes",
			folders: ["/workspace/notes"],
			repositoryIdentities: {},
		},
	];
}

async function openProjectList(page: Page, baseUrl: string) {
	let projects = fixtureProjects();
	let defaultMode: GroupingMode = "repository";
	const sessions = projects.map((project, index) => ({
		accountId: null,
		id: `grouping-${project.slug}`,
		title: `Review ${project.title}`,
		status: "idle" as const,
		projectSlug: project.slug,
		updatedAt: 100 - index,
		messageCount: 0,
	}));
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
			GetDefaultGroupingMode: () => ({ mode: defaultMode }),
			SetDefaultGroupingMode: ({ mode }) => {
				defaultMode = mode;
				projects = projects.map((project) => ({
					...project,
					effectiveGroupingMode: project.groupingMode ?? defaultMode,
				}));
				rpc.setProjectSetting({ _tag: "defaultGroupingMode", mode });
				rpc.setDaemonList("SubscribeProjects", { projects });
				return { mode };
			},
			FindFolders: () => ({ home: "/workspace", entries: [] }),
			ListDaemonSessions: ({ scope }) => ({
				sessions: sessions.filter(
					(session) => !scope || session.projectSlug === scope,
				),
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetProjects: () => ({ projects, current: slug }),
			SaveProject: ({ slug: savedSlug, groupingMode }) => {
				const stored = projects.find((project) => project.slug === savedSlug);
				if (!stored) throw new Error(`Unknown project: ${savedSlug}`);
				if (
					groupingMode !== null &&
					groupingMode !== "repository" &&
					groupingMode !== "repository+subfolder" &&
					groupingMode !== "off"
				)
					throw new Error("SaveProject must explicitly send its grouping mode");
				const { groupingMode: _previous, ...rest } = stored;
				const updated: ProjectInfo = {
					...rest,
					...(groupingMode === null ? {} : { groupingMode }),
					effectiveGroupingMode: groupingMode ?? defaultMode,
				};
				projects = projects.map((project) =>
					project.slug === savedSlug ? updated : project,
				);
				rpc.setDaemonList("SubscribeProjects", { projects });
				return { savedSlug: stored.slug, projects, warnings: [] };
			},
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: slug },
			{
				type: "shell_snapshot",
				roots: true,
				sessions: sessions.filter((session) => session.projectSlug === slug),
			},
		],
		responses: new Map(),
	});
	rpc.setProjectSetting({ _tag: "defaultGroupingMode", mode: defaultMode });
	controls.set(page, rpc);
	await page.goto(baseUrl);
	await expect(page.locator("#session-list")).toBeVisible();
	await expect(page.locator("#session-list a[data-session-id]")).toHaveCount(5);
	return rpc;
}

function projectLabel(page: Page, projectSlug: string) {
	return page
		.locator(`#session-list a[data-session-id="grouping-${projectSlug}"]`)
		.locator(".session-item-context > span")
		.last();
}

async function recordLabels(page: Page, phase: string) {
	const rows = await page
		.locator("#session-list a[data-session-id]")
		.evaluateAll((elements) =>
			elements
				.map((element) => ({
					id: element.getAttribute("data-session-id"),
					label: (
						element.querySelector(".session-item-context > span:last-child")
							?.textContent ?? ""
					)
						.replace(/\s+/g, " ")
						.trim(),
				}))
				.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")),
		);
	const recorded = observations.get(page) ?? [];
	const defaultField = page.getByRole("button", {
		name: /^Default repository grouping\b/,
	});
	recorded.push({
		phase,
		rows,
		...((await defaultField.count())
			? { defaultMode: (await defaultField.getAttribute("data-value")) ?? "" }
			: {}),
	});
	observations.set(page, recorded);
}

async function openEdit(page: Page) {
	await page.getByTestId("session-scope-chip").click();
	const row = page
		.getByRole("menu", { name: "Project scope" })
		.getByRole("menuitemradio")
		.filter({ hasText: `project:${slug}` });
	await row.hover();
	await row.getByTestId("session-scope-edit").click();
	const dialog = page.getByRole("dialog", {
		name: "Edit project",
		exact: true,
	});
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openSettings(page: Page) {
	const listOverflow = page.getByTestId("list-bar-overflow");
	const titleMenu = page.getByTestId("session-bar-title-menu");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
	} else {
		await page.getByTestId("session-bar-overflow").click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-general").click();
	const panel = page.locator("#settings-panel");
	await expect(panel).toBeVisible();
	return panel.getByRole("button", {
		name: /^Default repository grouping\b/,
	});
}

test.afterEach(async ({ page }, info) => {
	await recordLabels(page, "final");
	const requests =
		controls
			.get(page)
			?.getRequests()
			.filter(({ tag }) =>
				[
					"SaveProject",
					"GetDefaultGroupingMode",
					"SetDefaultGroupingMode",
				].includes(tag),
			)
			.map(({ tag, payload }) => ({
				tag,
				payload: Object.fromEntries(
					Object.entries(payload)
						.filter(([key]) => key !== "originId" && key !== "commandId")
						.sort(([a], [b]) => a.localeCompare(b)),
				),
			})) ?? [];
	const artifact = info.outputPath("repository-grouping.json");
	writeFileSync(
		artifact,
		`${JSON.stringify({ viewport: page.viewportSize(), requests, observations: observations.get(page) ?? [] }, null, 2)}\n`,
	);
	await info.attach("repository-grouping-state", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = info.outputPath("repository-grouping.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("repository-grouping", {
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

		test("repository rows qualify linked projects and leave standalone projects distinct", async ({
			page,
			harness,
		}) => {
			await openProjectList(page, harness.relayBaseUrl);
			await expect(projectLabel(page, slug)).toHaveText("myapp · API package");
			await expect(projectLabel(page, "web-checkout")).toHaveText(
				"myapp · Web package",
			);
			await expect(projectLabel(page, "library")).toHaveText("library");
			await expect(projectLabel(page, "ungrouped")).toHaveText(
				"Ungrouped checkout",
			);
			await expect(projectLabel(page, "notes")).toHaveText("Notes");
			await recordLabels(page, "repository");
		});

		test("ProjectDialog saves mode-only edits and explicitly clears its override", async ({
			page,
			harness,
		}) => {
			const rpc = await openProjectList(page, harness.relayBaseUrl);
			const timeOrigin = await page.evaluate(() => performance.timeOrigin);
			let dialog = await openEdit(page);
			let field = dialog.getByRole("combobox", {
				name: "Repository grouping",
				exact: true,
			});
			await expect(field).toHaveValue("");
			await expect(field.locator("option")).toHaveText([
				"Use global default",
				"By repository",
				"By repository and subfolder",
				"Off",
			]);
			await expect(
				dialog.getByRole("button", { name: "Save", exact: true }),
			).toBeDisabled();
			for (const [value, apiLabel, webLabel] of [
				["off", "API package", "myapp"],
				["repository+subfolder", "myapp", "myapp"],
				["repository", "myapp · API package", "myapp · Web package"],
				["", "myapp · API package", "myapp · Web package"],
			] as const) {
				await field.selectOption(value);
				await dialog.getByRole("button", { name: "Save", exact: true }).click();
				await expect(dialog).toBeHidden();
				expect(
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "SaveProject")
						.at(-1)?.payload,
				).toMatchObject({
					_tag: "SaveProject",
					slug,
					groupingMode: value || null,
				});
				await expect(projectLabel(page, slug)).toHaveText(apiLabel);
				await expect(projectLabel(page, "web-checkout")).toHaveText(webLabel);
				await recordLabels(page, value || "inherited");
				dialog = await openEdit(page);
				field = dialog.getByRole("combobox", {
					name: "Repository grouping",
					exact: true,
				});
				await expect(field).toHaveValue(value);
			}
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
			expect(await page.evaluate(() => performance.timeOrigin)).toBe(
				timeOrigin,
			);
		});

		test("global default changes relabel inherited rows without changing explicit modes", async ({
			page,
			harness,
		}) => {
			const rpc = await openProjectList(page, harness.relayBaseUrl);
			const timeOrigin = await page.evaluate(() => performance.timeOrigin);
			let field = await openSettings(page);
			await expect(field).toHaveAttribute("data-value", "repository");
			await rpc.waitForRequest(({ tag }) => tag === "GetDefaultGroupingMode");
			expect(
				rpc.getRequests().find(({ tag }) => tag === "GetDefaultGroupingMode")
					?.payload,
			).toMatchObject({ _tag: "GetDefaultGroupingMode" });
			await field.click();
			await expect(page.getByRole("menuitemradio")).toHaveText([
				"By repository",
				"By repository and subfolder",
				"Off",
			]);
			await page.keyboard.press("Escape");
			for (const [value, apiLabel, webLabel] of [
				["repository+subfolder", "myapp", "myapp"],
				["off", "API package", "Web package"],
				["repository", "myapp · API package", "myapp · Web package"],
			] as const) {
				await chooseSettingsOption(page, field, value);
				await expect
					.poll(
						() =>
							rpc
								.getRequests()
								.filter(({ tag }) => tag === "SetDefaultGroupingMode")
								.at(-1)?.payload,
					)
					.toMatchObject({ _tag: "SetDefaultGroupingMode", mode: value });
				await expect(field).toBeEnabled();
				await page.getByTestId("settings-close-btn").click();
				await expect(projectLabel(page, slug)).toHaveText(apiLabel);
				await expect(projectLabel(page, "web-checkout")).toHaveText(webLabel);
				await expect(projectLabel(page, "library")).toHaveText("library");
				await expect(projectLabel(page, "ungrouped")).toHaveText(
					"Ungrouped checkout",
				);
				await recordLabels(page, value);
				field = await openSettings(page);
				await expect(field).toHaveAttribute("data-value", value);
			}
			await page.getByTestId("settings-close-btn").click();
			expect(await page.evaluate(() => performance.timeOrigin)).toBe(
				timeOrigin,
			);
		});

		test("live project and default-setting feeds relabel the already open list", async ({
			page,
			harness,
		}) => {
			const rpc = await openProjectList(page, harness.relayBaseUrl);
			const timeOrigin = await page.evaluate(() => performance.timeOrigin);
			await rpc.waitForRequest(({ tag }) => tag === "SubscribeProjectSettings");
			rpc.setProjectSetting({
				_tag: "defaultGroupingMode",
				mode: "repository+subfolder",
			});
			await expect(projectLabel(page, slug)).toHaveText("myapp");
			await expect(projectLabel(page, "web-checkout")).toHaveText("myapp");
			await recordLabels(page, "live-default");
			rpc.setDaemonList("SubscribeProjects", {
				projects: fixtureProjects().map((project) =>
					project.slug === slug ? { ...project, groupingMode: "off" } : project,
				),
			});
			await expect(projectLabel(page, slug)).toHaveText("API package");
			await expect(projectLabel(page, "web-checkout")).toHaveText("myapp");
			await recordLabels(page, "live-project");
			expect(await page.evaluate(() => performance.timeOrigin)).toBe(
				timeOrigin,
			);
		});

		test("a delayed initial read cannot replace a newer streamed default", async ({
			page,
			harness,
		}) => {
			const rpc = await openProjectList(page, harness.relayBaseUrl);
			const timeOrigin = await page.evaluate(() => performance.timeOrigin);
			let resolveRead: ((response: { mode: GroupingMode }) => void) | undefined;
			const delayedRead = new Promise<{ mode: GroupingMode }>((resolve) => {
				resolveRead = resolve;
			});
			rpc.setStubs({ GetDefaultGroupingMode: () => delayedRead });

			// Routed sockets do not emit Playwright frame events. Observe their
			// browser message dispatch and wait for the stale reply's next render.
			await page.evaluate(() => {
				const send = WebSocket.prototype.send;
				WebSocket.prototype.send = function (data) {
					if (typeof data === "string") {
						const parsed = JSON.parse(data) as
							| { tag?: string; id?: string }
							| Array<{ tag?: string; id?: string }>;
						for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
							if (frame.tag === "GetDefaultGroupingMode" && frame.id)
								document.documentElement.dataset["groupingReadRequestId"] =
									frame.id;
						}
					}
					send.call(this, data);
				};
				const dispatch = WebSocket.prototype.dispatchEvent;
				WebSocket.prototype.dispatchEvent = function (event: Event) {
					const result = dispatch.call(this, event);
					if (event instanceof MessageEvent && typeof event.data === "string") {
						const parsed = JSON.parse(event.data) as
							| { _tag?: string; requestId?: string }
							| Array<{ _tag?: string; requestId?: string }>;
						const frames = Array.isArray(parsed) ? parsed : [parsed];
						if (
							frames.some(
								(frame) =>
									frame._tag === "Exit" &&
									frame.requestId ===
										document.documentElement.dataset["groupingReadRequestId"],
							)
						)
							requestAnimationFrame(() => {
								document.documentElement.dataset["groupingStaleReadRendered"] =
									"true";
							});
					}
					return result;
				};
			});
			const field = await openSettings(page);
			await rpc.waitForRequest(({ tag }) => tag === "GetDefaultGroupingMode");
			await rpc.waitForRequest(({ tag }) => tag === "SubscribeProjectSettings");
			if (!resolveRead)
				throw new Error("The initial grouping read was not captured");
			rpc.setProjectSetting({ _tag: "defaultGroupingMode", mode: "off" });
			rpc.setDaemonList("SubscribeProjects", {
				projects: fixtureProjects().map((project) => ({
					...project,
					effectiveGroupingMode: project.groupingMode ?? "off",
				})),
			});
			await expect(field).toHaveAttribute("data-value", "off");
			await expect(projectLabel(page, slug)).toHaveText("API package");
			await expect(projectLabel(page, "web-checkout")).toHaveText(
				"Web package",
			);
			await recordLabels(page, "peer-default-before-stale-read");

			resolveRead({ mode: "repository" });
			await page.waitForFunction(
				() =>
					document.documentElement.dataset["groupingStaleReadRendered"] ===
					"true",
			);
			await expect(field).toHaveAttribute("data-value", "off");
			await expect(projectLabel(page, slug)).toHaveText("API package");
			await expect(projectLabel(page, "web-checkout")).toHaveText(
				"Web package",
			);
			await expect(projectLabel(page, "library")).toHaveText("library");
			await recordLabels(page, "peer-default-after-stale-read");
			await page.getByTestId("settings-close-btn").click();
			expect(await page.evaluate(() => performance.timeOrigin)).toBe(
				timeOrigin,
			);
		});
	});
}
