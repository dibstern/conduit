import { writeFile } from "node:fs/promises";
import { Stream } from "effect";
import {
	type GetFileListResponse,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const projectSlug = "e2e-replay";
const seed = "session-seed";
const survivor = "session-survivor";
const created = "session-created";
const forked = "session-forked";
const materialized = "session-materialized";
const otherProject = "other-project";
const notFound = "Session not found. That session no longer exists.";

const rows = [
	{ id: seed, title: "Current", status: "idle", updatedAt: Date.now() },
	{
		id: survivor,
		title: "Survivor",
		status: "idle",
		updatedAt: Date.now() - 1_000,
	},
];

async function setup(
	page: import("@playwright/test").Page,
	stubs: StubTable = {},
	sessionRows: Array<
		(typeof rows)[number] & { projectSlug?: string; accountId?: string }
	> = rows,
	folders: string[] = ["/tmp/e2e-replay"],
) {
	const rpc = await mockWsRpc(page, {
		streams: {
			SubscribeInputDraft: ({ key }) => {
				const { session } = key as { session?: string };
				return [
					{
						_tag: "synchronized",
						...(session && {
							text: session === seed ? "Seed draft" : `Draft for ${session}`,
						}),
					},
				];
			},
		},
		stubs: {
			GetModels: () => ({
				projectSlug,
				instanceId: "opencode",
				defaultOpenCodeInstanceId: "opencode",
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						configured: true,
						models: [
							{ id: "claude-sonnet-4", name: "Sonnet", provider: "anthropic" },
						],
					},
				],
				active: { provider: "anthropic", model: "claude-sonnet-4" },
			}),
			"input.submit": () => ({
				ok: true,
				sessionId: materialized,
				handedOff: true,
			}),
			ResolveSession: () => ({ projectSlug }),
			ViewSession: () => ({ ok: true }),
			CreateSession: () => ({ projectSlug, sessionId: created }),
			ForkSession: () => ({ projectSlug, sessionId: forked, forkedFrom: seed }),
			DeleteSession: () => ({ ok: true }),
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			AttachProject: (payload) => ({
				projectSlug,
				sessionSlug: "sessionId" in payload ? projectSlug : null,
			}),
			...stubs,
		},
	});
	const relay = await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: projectSlug,
						title: projectSlug,
						folders,
					},
					{
						slug: otherProject,
						title: otherProject,
						folders: ["/tmp/other-project"],
					},
				],
				current: projectSlug,
			},
			{ type: "shell_snapshot", roots: true, sessions: sessionRows },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				isDefault: true,
			},
		],
	});
	rpc.setProjectSetting({
		_tag: "defaultModel",
		provider: "anthropic",
		model: "claude-sonnet-4",
		variant: "",
	});
	rpc.setProjectSetting({
		_tag: "harnessDefaults",
		opencode: {
			status: "ok",
			pick: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4",
				effort: "",
				contextWindow: "",
			},
		},
	});
	return { rpc, relay };
}

test("cold session navigation reuses attach resolution; warm navigation needs no resolution", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === seed,
	);
	const cold = [...rpc.getRequests()];
	const placement = (requests: typeof cold) =>
		requests
			.filter((request) =>
				["AttachProject", "ResolveSession", "SubscribeSessionDetail"].includes(
					request.tag,
				),
			)
			.map((request) => request.tag);
	const coldOutput = testInfo.outputPath("cold-navigation-requests.json");
	await writeFile(coldOutput, `${JSON.stringify(cold, null, 2)}\n`);
	await testInfo.attach("cold-navigation-requests", { path: coldOutput });
	expect(placement(cold)).toEqual(["AttachProject", "SubscribeSessionDetail"]);
	expect(
		cold.find((request) => request.tag === "AttachProject")?.payload,
	).toMatchObject({ sessionId: seed });
	expect(
		cold.find((request) => request.tag === "AttachProject")?.payload,
	).not.toHaveProperty("projectSlug");

	rpc.removeShellRow(seed);
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === survivor,
	);
	const warm = rpc.getRequests().slice(cold.length);
	expect(placement(warm)).toEqual(["SubscribeSessionDetail"]);
	const output = testInfo.outputPath("session-navigation-rpc.json");
	await writeFile(output, `${JSON.stringify({ cold, warm }, null, 2)}\n`);
	await testInfo.attach("session-navigation-rpc", { path: output });
});

test("a cold session link waits for attach placement before scoped reads", async ({
	page,
	harness,
}, testInfo) => {
	let finishAttach!: (reply: {
		projectSlug: string;
		sessionSlug: string;
	}) => void;
	const { rpc } = await setup(
		page,
		{
			AttachProject: () =>
				new Promise((resolve) => {
					finishAttach = resolve;
				}),
			GetFileList: (payload) => ({
				projectSlug,
				path: payload.path ?? ".",
				entries: [{ name: "placed-session.ts", type: "file" }],
			}),
		},
		[],
	);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}?p=${projectSlug}`);
	const attach = await rpc.waitForRequest(
		(request) => request.tag === "AttachProject",
	);
	expect(attach.payload).toMatchObject({ sessionId: seed });
	expect(attach.payload).not.toHaveProperty("projectSlug");
	await page.getByTestId("views-rail-files").click();
	await expect(page.getByTestId("side-pane-files")).toBeVisible();
	await expect(page.locator("#sidebar-panel-files")).toBeVisible();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	const beforePlacement = [...rpc.getRequests()];
	expect(
		beforePlacement.filter((request) =>
			[
				"ResolveSession",
				"ViewSession",
				"SubscribeSessionDetail",
				"SubscribeSessionTodos",
				"SubscribeInputDraft",
				"SubscribeSessionFamily",
				"GetFileTree",
				"GetFileList",
				"GetModels",
				"GetAgents",
				"GetCommands",
				"SubscribeDraftModels",
			].includes(request.tag),
		),
	).toEqual([]);
	finishAttach({ projectSlug, sessionSlug: projectSlug });
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await rpc.waitForRequest(
		(request) => request.tag === "SubscribeSessionDetail",
	);
	await expect(page.locator("#file-tree")).toContainText("placed-session.ts");
	expect(
		rpc.getRequests().filter((request) => request.tag === "AttachProject"),
	).toHaveLength(1);
	expect(
		rpc.getRequests().filter((request) => request.tag === "ResolveSession"),
	).toHaveLength(0);
	expect(
		rpc.getRequests().filter((request) => request.tag === "ViewSession"),
	).toHaveLength(1);
	const output = testInfo.outputPath("cold-session-placement.json");
	await writeFile(
		output,
		`${JSON.stringify({ beforePlacement, placed: rpc.getRequests(), route: page.url() }, null, 2)}\n`,
	);
	await testInfo.attach("cold-session-placement", { path: output });
});

test("a failed cold attach still reports the failure after the shell reveals its owner", async ({
	page,
	harness,
}, testInfo) => {
	let rejectAttach!: (error: WsRpcError) => void;
	let attachAttempts = 0;
	const { rpc } = await setup(
		page,
		{
			AttachProject: (payload) => {
				if (attachAttempts++ > 0)
					return {
						projectSlug:
							("projectSlug" in payload ? payload.projectSlug : null) ??
							projectSlug,
						sessionSlug: null,
					};
				return new Promise<never>((_resolve, reject) => {
					rejectAttach = reject;
				});
			},
		},
		[],
	);
	const url = `${harness.relayBaseUrl}/s/${seed}`;
	await page.goto(url);
	const attach = await rpc.waitForRequest(
		(request) => request.tag === "AttachProject",
	);
	expect(attach.payload).toMatchObject({ sessionId: seed });
	rpc.setShellRows([
		{
			id: seed,
			title: "Unavailable session",
			status: "idle",
			projectSlug: otherProject,
		},
		{
			id: survivor,
			title: "Survivor",
			status: "idle",
			projectSlug,
		},
	]);
	await expect(
		page.locator(`#session-list [data-session-id="${seed}"]`),
	).toContainText("Unavailable session");
	rejectAttach(new WsRpcError({ message: "Project is unavailable" }));
	await expect(
		page.getByText("Failed to switch projects", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Project is unavailable", { exact: true }),
	).toBeVisible();
	await expect(page).toHaveURL(url);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	expect(
		rpc.getRequests().filter(({ tag }) => tag === "AttachProject"),
	).toEqual([attach]);
	expect(
		rpc.getRequests().filter(({ tag }) => tag === "SubscribeSessionDetail"),
	).toEqual([]);
	const output = testInfo.outputPath("failed-cold-session-attach.json");
	await writeFile(
		output,
		`${JSON.stringify({ requests: rpc.getRequests(), route: page.url() }, null, 2)}\n`,
	);
	await testInfo.attach("failed-cold-session-attach", { path: output });
	await page.locator(`#session-list [data-session-id="${survivor}"]`).click();
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await page.locator(`#session-list [data-session-id="${seed}"]`).click();
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	expect(
		rpc.getRequests().filter(({ tag }) => tag === "AttachProject"),
	).toHaveLength(3);
});

test("a cold attach retries after a dropped socket reconnects without navigation", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(
		page,
		{ AttachProject: () => new Promise<never>(() => {}) },
		[],
	);
	const url = `${harness.relayBaseUrl}/s/${seed}`;
	await page.goto(url);
	const attach = await rpc.waitForRequest(
		(request) => request.tag === "AttachProject",
	);
	expect(attach.payload).toMatchObject({ sessionId: seed });
	rpc.setShellRows([
		{
			id: seed,
			title: "Reconnecting session",
			status: "idle",
			projectSlug: otherProject,
		},
	]);
	await expect(
		page.locator(`#session-list [data-session-id="${seed}"]`),
	).toContainText("Reconnecting session");
	rpc.setStubs({
		AttachProject: () => ({ projectSlug: otherProject, sessionSlug: null }),
	});
	const connections = rpc.connections;
	rpc.closeSockets({ code: 1012, reason: "Server restarting" });
	await expect.poll(() => rpc.connections).toBeGreaterThan(connections);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await expect(page).toHaveURL(url);
	expect(
		rpc.getRequests().filter(({ tag }) => tag === "AttachProject"),
	).toHaveLength(2);
	await testInfo.attach("reconnected-cold-session-attach.json", {
		body: JSON.stringify({ requests: rpc.getRequests(), route: page.url() }),
		contentType: "application/json",
	});
});

test("an unknown session link goes home with a not-found notice", async ({
	page,
	harness,
}) => {
	const unknown = "session-unknown";
	const { rpc } = await setup(page, {
		AttachProject: () => ({ projectSlug, sessionSlug: null }),
		ResolveSession: () => ({ projectSlug: null }),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${unknown}`);
	await expect(page).toHaveURL(`${harness.relayBaseUrl}/`);
	await expect(page.getByText(notFound)).toBeVisible();
	expect(
		rpc.getRequests().some((request) => request.tag === "ViewSession"),
	).toBe(false);
	expect(
		rpc
			.getRequests()
			.some((request) => request.tag === "SubscribeSessionDetail"),
	).toBe(false);
});

test("a warm unplaced route sends no file list or preview reads", async ({
	page,
	harness,
}) => {
	const pending = "session-pending-placement";
	let finishResolve!: (reply: { projectSlug: string }) => void;
	const { rpc } = await setup(page, {
		ResolveSession: () =>
			new Promise((resolve) => {
				finishResolve = resolve;
			}),
		GetFileTree: () => ({ projectSlug, entries: ["preview.ts"] }),
		GetFileList: (payload) => ({
			projectSlug,
			path: payload.path ?? ".",
			entries: [{ name: "preview.ts", type: "file" }],
		}),
		GetFileContent: (payload) => ({
			projectSlug,
			path: payload.path,
			content: "export const preview = true;",
		}),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.getByTestId("views-rail-files").click();
	await page
		.locator("#file-tree .fb-entry")
		.filter({ hasText: "preview.ts" })
		.click();
	await expect(page.locator("#file-viewer")).toContainText(
		"export const preview = true;",
	);
	await page.evaluate((path) => {
		window.history.pushState(null, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, `/s/${pending}`);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "ResolveSession" &&
			request.payload["sessionId"] === pending,
	);
	if (
		(await page
			.getByTestId("views-rail-files")
			.getAttribute("aria-pressed")) !== "true"
	)
		await page.getByTestId("views-rail-files").click();
	await expect(page.getByTestId("side-pane-files")).toBeVisible();
	await expect(page.locator("#sidebar-panel-files")).toBeVisible();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	expect(
		rpc
			.getRequests()
			.filter(
				(request) =>
					["GetFileList", "GetFileContent", "GetFileTree"].includes(
						request.tag,
					) && request.payload["sessionId"] === pending,
			),
	).toEqual([]);
	finishResolve({ projectSlug });
	await expect(page.locator("#input")).toHaveValue(`Draft for ${pending}`);
});

test("a warm unplaced route sends no file reads while the previous directory is loading", async ({
	page,
	harness,
}, testInfo) => {
	const pending = "session-pending-directory";
	let finishResolve!: (reply: { projectSlug: string }) => void;
	let finishList!: (reply: GetFileListResponse) => void;
	const { rpc } = await setup(page, {
		ResolveSession: () =>
			new Promise((resolve) => {
				finishResolve = resolve;
			}),
		GetFileTree: () => ({ projectSlug, entries: [] }),
		GetFileList: (payload) =>
			"sessionId" in payload && payload.sessionId === seed
				? new Promise((resolve) => {
						finishList = resolve;
					})
				: {
						projectSlug,
						path: payload.path ?? ".",
						entries: [{ name: "placed-directory.ts", type: "file" }],
					},
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.getByTestId("views-rail-files").click();
	await expect(page.locator("#sidebar-panel-files")).toBeVisible();
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetFileList" && request.payload["sessionId"] === seed,
	);
	await page.evaluate((path) => {
		window.history.pushState(null, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, `/s/${pending}`);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "ResolveSession" &&
			request.payload["sessionId"] === pending,
	);
	if (
		(await page
			.getByTestId("views-rail-files")
			.getAttribute("aria-pressed")) !== "true"
	)
		await page.getByTestId("views-rail-files").click();
	await expect(page.locator("#sidebar-panel-files")).toBeVisible();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	const beforePlacement = [...rpc.getRequests()];
	const output = testInfo.outputPath("pending-directory-navigation-rpc.json");
	await writeFile(output, `${JSON.stringify(beforePlacement, null, 2)}\n`);
	await testInfo.attach("pending-directory-navigation-rpc", { path: output });
	expect(
		beforePlacement.filter(
			(request) =>
				["GetFileList", "GetFileContent", "GetFileTree"].includes(
					request.tag,
				) && request.payload["sessionId"] === pending,
		),
	).toEqual([]);
	finishResolve({ projectSlug });
	await expect(page.locator("#file-tree")).toContainText("placed-directory.ts");
	finishList({
		projectSlug,
		path: ".",
		entries: [{ name: "left-directory.ts", type: "file" }],
	});
	await expect(page.locator("#file-tree")).not.toContainText(
		"left-directory.ts",
	);
});

test("a delayed project attach keeps the target session's transcript and files", async ({
	page,
	harness,
}, testInfo) => {
	const target = "session-other-project";
	let finishAttach!: (reply: {
		projectSlug: string;
		sessionSlug: null;
	}) => void;
	const { rpc } = await setup(
		page,
		{
			AttachProject: (payload) => {
				if (
					("projectSlug" in payload && payload.projectSlug === otherProject) ||
					("sessionId" in payload && payload.sessionId === target)
				) {
					return new Promise((resolve) => {
						finishAttach = resolve;
					});
				}
				return {
					projectSlug,
					sessionSlug: "sessionId" in payload ? projectSlug : null,
				};
			},
			GetFileTree: (payload) => ({
				projectSlug:
					"sessionId" in payload && payload.sessionId === target
						? otherProject
						: projectSlug,
				entries: [
					"sessionId" in payload && payload.sessionId === target
						? "target-session.ts"
						: "README.md",
				],
			}),
			GetFileList: (payload) => ({
				projectSlug:
					"sessionId" in payload && payload.sessionId === target
						? otherProject
						: projectSlug,
				path: payload.path ?? ".",
				entries: [
					{
						name:
							"sessionId" in payload && payload.sessionId === target
								? "target-session.ts"
								: "README.md",
						type: "file",
					},
				],
			}),
		},
		[
			...rows,
			{
				id: target,
				title: "Other project session",
				status: "idle",
				updatedAt: Date.now(),
				projectSlug: otherProject,
			},
		],
	);
	rpc.setDetailRows(target, [
		{
			_tag: "message",
			message: {
				id: "target-message",
				role: "assistant",
				time: { created: 1 },
			},
		},
		{
			_tag: "part",
			messageId: "target-message",
			sortOrder: 0,
			part: {
				id: "target-part",
				type: "text",
				text: "Target project transcript",
			},
		},
	]);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page
		.locator(`#session-list [data-session-id="${target}"]`)
		.click({ position: { x: 48, y: 12 } });
	await expect(page).toHaveURL(new RegExp(`/s/${target}$`));
	await rpc.waitForRequest(
		(request) =>
			request.tag === "AttachProject" &&
			(request.payload["projectSlug"] === otherProject ||
				request.payload["sessionId"] === target),
	);
	const pendingAttach = [...rpc.getRequests()];
	expect(
		pendingAttach.filter(
			(request) =>
				["SubscribeSessionDetail", "GetFileTree"].includes(request.tag) &&
				request.payload["sessionId"] === target,
		),
	).toEqual([]);
	finishAttach({ projectSlug: otherProject, sessionSlug: null });
	// The attach reply is what releases the target's scoped reads.
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === target,
	);
	if (
		(await page
			.getByTestId("views-rail-files")
			.getAttribute("aria-pressed")) !== "true"
	)
		await page.getByTestId("views-rail-files").click();
	await expect(page.locator(".msg-assistant .md-content")).toContainText(
		"Target project transcript",
	);
	await expect(page.locator("#file-tree")).toContainText("target-session.ts");
	const output = testInfo.outputPath("delayed-project-attach.json");
	await writeFile(
		output,
		`${JSON.stringify({ pendingAttach, route: page.url(), requests: rpc.getRequests() }, null, 2)}\n`,
	);
	await testInfo.attach("delayed-project-attach", { path: output });
});

test("choosing a project scope from home attaches that project", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page, {
		AttachProject: (payload) => ({
			projectSlug:
				"projectSlug" in payload
					? (payload.projectSlug ?? projectSlug)
					: projectSlug,
			sessionSlug: null,
		}),
	});
	await page.goto(`${harness.relayBaseUrl}/`);
	await rpc.waitForRequest((request) => request.tag === "AttachProject");
	await page.getByTestId("session-scope-chip").click();
	await page
		.getByRole("menuitemradio", { name: new RegExp(`^${otherProject}\\b`) })
		.click();
	await expect(page).toHaveURL(`${harness.relayBaseUrl}/?p=${otherProject}`);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "AttachProject" &&
			request.payload["projectSlug"] === otherProject,
	);
	await expect(page.getByTestId("session-scope-chip")).toHaveText(otherProject);
	expect(
		rpc
			.getRequests()
			.filter((request) => request.tag === "AttachProject")
			.at(-1)?.payload,
	).not.toHaveProperty("sessionId");
});

test("a first send from home places the session in the chosen draft project", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page, {
		AttachProject: (payload) => ({
			projectSlug:
				"projectSlug" in payload
					? (payload.projectSlug ?? projectSlug)
					: projectSlug,
			sessionSlug: null,
		}),
		GetModels: (payload) => ({
			projectSlug:
				"projectSlug" in payload ? payload.projectSlug : otherProject,
			instanceId: "opencode",
			defaultOpenCodeInstanceId: "opencode",
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					configured: true,
					models: [
						{ id: "claude-sonnet-4", name: "Sonnet", provider: "anthropic" },
					],
				},
			],
			active: { provider: "anthropic", model: "claude-sonnet-4" },
		}),
		CreateSession: (payload) => {
			expect(payload.projectSlug).toBe(otherProject);
			return { projectSlug: otherProject, sessionId: created };
		},
		"input.submit": ({ sessionId }) => ({
			ok: true,
			sessionId,
			handedOff: true,
		}),
		ViewSession: () => ({ ok: true }),
		ResolveSession: () => new Promise(() => {}),
	});
	await page.goto(
		`${harness.relayBaseUrl}/?p=${projectSlug}&project=${otherProject}`,
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "AttachProject" &&
			request.payload["projectSlug"] === projectSlug,
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "GetModels" &&
			request.payload["projectSlug"] === otherProject,
	);
	await page.locator("#input").fill("Send from home into the chosen project");
	await page.locator("#send").click();
	const create = await rpc.waitForRequest(
		(request) => request.tag === "CreateSession",
	);
	expect(create.payload["projectSlug"]).toBe(otherProject);
	await expect(page).toHaveURL(new RegExp(`/s/${created}(?:\\?|$)`));
	await rpc.waitForRequest(
		(request) =>
			request.tag === "ViewSession" && request.payload["sessionId"] === created,
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "AttachProject" &&
			request.payload["projectSlug"] === otherProject,
	);
	expect(
		rpc.getRequests().filter((request) => request.tag === "ResolveSession"),
	).toEqual([]);
	await page
		.locator("#input")
		.fill("The placed session accepts another message");
	await expect(page.locator("#send")).toBeEnabled();
});

test("a draft's first send creates the session in its project and sends into it", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#new-session-btn").click();
	await expect(page).toHaveURL(
		new RegExp(`/draft/[^/?]+\\?(?:.*&)?project=${projectSlug}`),
	);
	await expect(page.locator("#input")).toHaveValue("");
	expect(
		rpc.getRequests().some((request) => request.tag === "CreateSession"),
	).toBe(false);

	await page.locator("#input").fill("Hello");
	await page.locator("#send").click();
	const create = await rpc.waitForRequest(
		(request) => request.tag === "CreateSession",
	);
	expect(create.payload["projectSlug"]).toBe(projectSlug);
	const send = await rpc.waitForRequest(
		(request) => request.tag === "input.submit",
	);
	expect(send.payload).toMatchObject({
		sessionId: created,
		text: "Hello",
	});
	expect(send.payload).not.toHaveProperty("projectSlug");
});

test("a draft's first send shows working before its session row arrives", async ({
	page,
	harness,
}, testInfo) => {
	let accept!: (reply: {
		ok: true;
		sessionId: string;
		handedOff: boolean;
	}) => void;
	const { rpc } = await setup(page, {
		"input.submit": () =>
			new Promise((resolve) => {
				accept = resolve;
			}),
		SubscribeInputDraft: () =>
			Stream.concat(
				Stream.make({ _tag: "synchronized", text: "" }),
				Stream.never,
			),
	});
	await page.goto(`${harness.relayBaseUrl}/new?project=${projectSlug}`);
	await page.locator("#input").fill("First draft send");
	await page.locator("#send").click();
	await rpc.waitForRequest((request) => request.tag === "input.submit");
	await expect(page).toHaveURL(new RegExp(`/s/${created}$`));
	await expect(page.locator("#stop")).toBeVisible();
	await testInfo.attach("draft-working-before-row", {
		body: await page.screenshot({
			path: testInfo.outputPath("draft-working-before-row.png"),
		}),
		contentType: "image/png",
	});
	accept({ ok: true, sessionId: created, handedOff: true });
});

test("an unplaced session disables send until it is resolved", async ({
	page,
	harness,
}) => {
	let placed!: (reply: { projectSlug: string }) => void;
	const { rpc } = await setup(page, {
		ResolveSession: () =>
			new Promise((resolve) => {
				placed = resolve;
			}),
		ViewSession: () => ({ ok: true }),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toBeVisible();
	await page.evaluate(() => {
		window.history.pushState(null, "", "/s/session-unplaced-send");
		window.dispatchEvent(new PopStateEvent("popstate"));
	});
	await rpc.waitForRequest((request) => request.tag === "ResolveSession");
	await page.locator("#input").fill("Cannot send before placement");
	await expect(page.locator("#send")).toBeDisabled();
	expect(
		rpc.getRequests().filter((request) => request.tag === "input.submit"),
	).toEqual([]);
	placed({ projectSlug });
	await expect(page.locator("#send")).toBeEnabled();
});

test("a draft with no model pick for its account cannot send", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page, {
		GetModels: () => ({ projectSlug, providers: [] }),
	});
	rpc.setProjectSetting({
		_tag: "harnessDefaults",
		opencode: { status: "missing" },
	});
	await page.goto(`${harness.relayBaseUrl}/new?project=${projectSlug}`);
	await page.locator("#input").fill("Wait for a model pick");
	await expect(page.locator("#send")).toBeDisabled();
	expect(
		rpc.getRequests().filter((request) => request.tag === "CreateSession"),
	).toEqual([]);
});

test("a draft on an account without multi-folder support cannot send", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page, {}, rows, [
		"/tmp/e2e-replay",
		"/tmp/second-root",
	]);
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				isDefault: true,
				capabilities: { supportsMultiFolder: false, supportsWorktree: false },
			},
		],
	});
	await page.goto(`${harness.relayBaseUrl}/new?project=${projectSlug}`);
	await page.locator("#input").fill("Cannot send multiple folders");
	await expect(page.locator("#send")).toBeDisabled();
	expect(
		rpc.getRequests().filter((request) => request.tag === "CreateSession"),
	).toEqual([]);
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				isDefault: true,
				capabilities: { supportsMultiFolder: true, supportsWorktree: false },
			},
		],
	});
	await expect(page.locator("#send")).toBeEnabled();
});

test("send stays disabled while switching the account before the send", async ({
	page,
	harness,
}) => {
	let switched!: (reply: { ok: true }) => void;
	const { rpc } = await setup(
		page,
		{
			GetUsageLimitsSetting: () => ({
				usageLimits: {
					autoResume: false,
					autoSwitch: true,
					warnAt: 80,
					order: ["claude-one", "claude-two"],
				},
			}),
			ContinueSession: () =>
				new Promise((resolve) => {
					switched = resolve;
				}),
			ViewSession: () => ({ ok: true }),
			"input.submit": ({ sessionId }) => ({
				ok: true,
				sessionId,
				handedOff: true,
			}),
		},
		rows.map((row) => ({ ...row, accountId: "claude-one" })),
	);
	rpc.setDaemonList("SubscribeInstances", {
		instances: ["claude-one", "claude-two"].map((id, index) => ({
			id,
			name: id,
			driver: "claude",
			usageEligible: true,
			available: true,
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 1,
			isDefault: index === 0,
		})),
	});
	rpc.setUsageReadings([
		{
			accountId: "claude-one",
			harness: "claude",
			status: "limited",
			windows: [
				{
					kind: "five_hour",
					utilization: 100,
					resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
				},
			],
			readAt: Date.now(),
			stale: false,
		},
		{
			accountId: "claude-two",
			harness: "claude",
			status: "available",
			windows: [{ kind: "five_hour", utilization: 20 }],
			readAt: Date.now(),
			stale: false,
		},
	]);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await page.locator("#input").fill("Switch then send");
	await expect(page.locator("#send")).toHaveAttribute(
		"data-send-mode",
		"switch",
	);
	await expect(page.locator("#send")).toBeEnabled();
	await page.locator("#send").click();
	const request = await rpc.waitForRequest(
		(request) => request.tag === "ContinueSession",
	);
	expect(request.payload).toMatchObject({
		sessionId: seed,
		instanceId: "claude-two",
		expectedInstanceId: "claude-one",
	});
	await expect(page.locator("#send")).toBeDisabled();
	await expect(page.locator("#input")).toHaveValue("Switch then send");
	expect(
		rpc.getRequests().filter((request) => request.tag === "input.submit"),
	).toEqual([]);
	switched({ ok: true });
	await rpc.waitForRequest((request) => request.tag === "input.submit");
});

test("a placed session only enables send for nonempty input", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page, { ViewSession: () => ({ ok: true }) });
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	// The seed session restores a saved draft; wait for it so the empty check
	// below cannot pass before the draft arrives.
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await expect(page.locator("#send")).toBeEnabled();
	await page.locator("#input").fill("");
	await expect(page.locator("#send")).toBeDisabled();
	await page.locator("#input").fill("   ");
	await expect(page.locator("#send")).toBeDisabled();
	await page.locator("#input").fill("Send this");
	await expect(page.locator("#send")).toBeEnabled();
	await page.locator("#input").fill("");
	await expect(page.locator("#send")).toBeDisabled();
	expect(
		rpc.getRequests().filter((request) => request.tag === "input.submit"),
	).toEqual([]);
});

test("a draft's first send places the session before any navigation frame", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page, {
		"input.submit": ({ sessionId }) => ({
			ok: true,
			sessionId,
			handedOff: true,
		}),
		ViewSession: () => ({ ok: true }),
		ResolveSession: () => new Promise(() => {}),
	});
	await page.goto(`${harness.relayBaseUrl}/new?project=${projectSlug}`);
	await page.locator("#input").fill("First send without a session row");
	const frames = page.evaluate(async () => {
		const samples: Array<{
			path: string;
			composer: boolean;
			home: boolean;
			stop: boolean;
		}> = [];
		let placedFrames = 0;
		const until = performance.now() + 15_000;
		while (placedFrames < 5 && performance.now() < until) {
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			if (location.pathname === "/s/session-created") placedFrames++;
			samples.push({
				path: location.pathname,
				composer: document.querySelector("#input") !== null,
				home: document.querySelector('[data-testid="draft-empty"]') !== null,
				stop: document.querySelector("#stop") !== null,
			});
		}
		return samples;
	});
	await page.locator("#send").click();
	await expect(page).toHaveURL(new RegExp(`/s/${created}$`));
	await rpc.waitForRequest(
		(request) =>
			request.tag === "ViewSession" && request.payload["sessionId"] === created,
	);
	await page.locator("#input").fill("Ready for the next message");
	await expect(page.locator("#send")).toBeEnabled();
	const sampled = await frames;
	expect(sampled.some((frame) => frame.path === `/s/${created}`)).toBe(true);
	expect(
		sampled.every(
			(frame) =>
				frame.path.startsWith("/draft/") ||
				(frame.path === `/s/${created}` &&
					frame.composer &&
					!frame.home &&
					frame.stop),
		),
	).toBe(true);
	expect(
		rpc.getRequests().filter((request) => request.tag === "ResolveSession"),
	).toEqual([]);
	const output = testInfo.outputPath("draft-first-send-frames.json");
	await writeFile(output, `${JSON.stringify(sampled, null, 2)}\n`);
	await testInfo.attach("draft-first-send-frames", {
		path: output,
		contentType: "application/json",
	});
	await page.goBack();
	await expect(page).toHaveURL(
		new RegExp(`/draft/[^/?]+\\?(?:.*&)?project=${projectSlug}`),
	);
});

for (const changed of ["unchanged", "text", "images"] as const) {
	test(`a side-thread start follows the parent and ${changed === "unchanged" ? "clears the unchanged" : `keeps edited ${changed} in the`} composer on Back`, async ({
		page,
		harness,
	}) => {
		let started!: (reply: { sessionId: string }) => void;
		const { rpc } = await setup(page, {
			StartSideThread: () =>
				new Promise((resolve) => {
					started = resolve;
				}),
			ViewSession: () => ({ ok: true }),
			// No stored draft; the mock does not persist the parent's cleared draft.
			SubscribeInputDraft: () =>
				Stream.concat(Stream.make({ _tag: "synchronized" }), Stream.never),
		});
		await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
		await expect(page.locator("#input")).toBeVisible();
		await page.locator("#input").fill("$btw What changed?");
		await page.locator("#send").click();
		const request = await rpc.waitForRequest(
			(request) => request.tag === "StartSideThread",
		);
		expect(request.payload).toEqual({
			_tag: "StartSideThread",
			sessionId: seed,
			title: "What changed?",
			inputId: expect.any(String),
			text: "What changed?",
			originId: expect.any(String),
		});
		expect(
			rpc.getRequests().filter((request) => request.tag === "input.submit"),
		).toEqual([]);
		if (changed === "text")
			await page.locator("#input").fill("Keep this edited parent prompt");
		if (changed === "images") {
			await page.locator("#attach-btn").click();
			const chooser = page.waitForEvent("filechooser");
			await page.locator("#attach-photos").click();
			await (await chooser).setFiles({
				name: "kept.png",
				mimeType: "image/png",
				buffer: Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
					"base64",
				),
			});
			await expect(
				page.locator('#image-preview img[alt="kept.png"]'),
			).toBeVisible();
		}
		started({ sessionId: forked });
		await expect(page).toHaveURL(new RegExp(`/s/${forked}$`));
		await expect(page.locator("#input")).toHaveValue("");
		if (changed === "images")
			await expect(
				page.locator('#image-preview img[alt="kept.png"]'),
			).toBeVisible();
		await expect(page.locator("#stop")).toBeHidden();
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`/s/${seed}$`));
		await expect(page.locator("#input")).toHaveValue(
			changed === "text"
				? "Keep this edited parent prompt"
				: changed === "images"
					? "$btw What changed?"
					: "",
		);
	});
}

test("a side-thread reply after opening another session leaves its route and composer alone", async ({
	page,
	harness,
}) => {
	let started!: (reply: { sessionId: string }) => void;
	const { rpc } = await setup(page, {
		StartSideThread: () =>
			new Promise((resolve) => {
				started = resolve;
			}),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#input").fill("$btw Delayed side thread");
	await page.locator("#send").click();
	await rpc.waitForRequest((request) => request.tag === "StartSideThread");
	await page.evaluate((path) => {
		window.history.pushState(null, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, `/s/${survivor}`);
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await page.locator("#input").fill("New text in the other session");
	started({ sessionId: forked });
	await page.evaluate(async () => {
		for (let frame = 0; frame < 10; frame++)
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
	});
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
	await expect(page.locator("#input")).toHaveValue(
		"New text in the other session",
	);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SyncInputDraft" &&
			(request.payload["key"] as { session?: string })?.session === survivor &&
			request.payload["text"] === "New text in the other session",
	);
});

test("a side-thread prepared after opening another session still belongs to its parent", async ({
	page,
	harness,
}) => {
	let loaded!: (reply: {
		projectSlug: string;
		path: string;
		content: string;
	}) => void;
	let started!: (reply: { sessionId: string }) => void;
	const { rpc } = await setup(page, {
		GetFileContent: () =>
			new Promise((resolve) => {
				loaded = resolve;
			}),
		StartSideThread: () =>
			new Promise((resolve) => {
				started = resolve;
			}),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#input").fill("$btw Explain @notes.md");
	await page.locator("#send").click();
	await rpc.waitForRequest((request) => request.tag === "GetFileContent");
	await page.evaluate((path) => {
		window.history.pushState(null, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, `/s/${survivor}`);
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await page.locator("#input").fill("Keep the other session prompt");
	loaded({
		projectSlug,
		path: "notes.md",
		content: "Reference content for the parent",
	});
	const request = await rpc.waitForRequest(
		(request) => request.tag === "StartSideThread",
	);
	expect(request.payload).toMatchObject({
		sessionId: seed,
		title: "Explain @notes.md",
	});
	expect(request.payload["text"]).toContain("Reference content for the parent");
	started({ sessionId: forked });
	await page.evaluate(async () => {
		for (let frame = 0; frame < 10; frame++)
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
	});
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
	await expect(page.locator("#input")).toHaveValue(
		"Keep the other session prompt",
	);
});

test("a redirect after opening another session leaves its route and composer alone", async ({
	page,
	harness,
}) => {
	let accept!: (reply: {
		ok: true;
		sessionId: string;
		handedOff: boolean;
	}) => void;
	const { rpc } = await setup(page, {
		"input.submit": () =>
			new Promise((resolve) => {
				accept = resolve;
			}),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#send").click();
	await rpc.waitForRequest((request) => request.tag === "input.submit");
	await page.evaluate((path) => {
		window.history.pushState(null, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, `/s/${survivor}`);
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	accept({ ok: true, sessionId: materialized, handedOff: true });
	await page.evaluate(async () => {
		for (let frame = 0; frame < 10; frame++)
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
	});
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
});

test("a failed send restores composer text and shows the RPC failure toast", async ({
	page,
	harness,
}, testInfo) => {
	await setup(page, {
		"input.submit": () => {
			throw new WsRpcError({ message: "Send denied by server" });
		},
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#input").fill("Keep this message");
	await page.locator("#send").click();
	await expect(page.locator("#input")).toHaveValue("Keep this message");
	await expect(
		page.getByText("Failed to send message", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Send denied by server", { exact: true }),
	).toBeVisible();
	await expect(page.locator("#stop")).toBeHidden();
	await testInfo.attach("send-failed-restored", {
		body: await page.screenshot({
			path: testInfo.outputPath("send-failed-restored.png"),
		}),
		contentType: "image/png",
	});
});

test("a draft creation failure restores text and shows the RPC failure toast", async ({
	page,
	harness,
}, testInfo) => {
	await setup(page, {
		CreateSession: () => {
			throw new WsRpcError({ message: "Creation denied by server" });
		},
	});
	await page.goto(`${harness.relayBaseUrl}/new?project=${projectSlug}`);
	await page.locator("#input").fill("Keep my draft");
	await page.locator("#send").click();
	await expect(
		page.getByText("Failed to create session", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Creation denied by server", { exact: true }),
	).toBeVisible();
	await expect(page.locator("#input")).toHaveValue("Keep my draft");
	await testInfo.attach("create-failed-restored", {
		body: await page.screenshot({
			path: testInfo.outputPath("create-failed-restored.png"),
		}),
		contentType: "image/png",
	});
});

test("a refused steer keeps the text and shows the server's reason", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page, {
		"input.submit": () => ({ ok: false, reason: "model_differs" }),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	rpc.upsertShellRow({ ...rows[0], id: seed, status: "busy" });
	rpc.sendChunk(
		"SubscribeSessionDetail",
		[
			{
				_tag: "upsert",
				sequence: 50,
				item: { _tag: "inbox", inbox: { paused: false, steer: null } },
			},
		],
		seed,
	);
	await expect(page.locator("#stop")).toBeVisible();
	await page.locator("#input").fill("Keep this steer");
	await expect(page.locator("#send")).toHaveAttribute("title", /steer/);
	await page.locator("#send").click({ modifiers: ["Meta"] });
	await rpc.waitForRequest(
		(request) =>
			request.tag === "input.submit" && request.payload["delivery"] === "steer",
	);
	await expect(page.getByTestId("composer-steer-refused")).toContainText(
		"The running turn uses a different model.",
	);
	await expect(page.locator("#input")).toHaveValue("Keep this steer");
	await testInfo.attach("steer-refused-restored", {
		body: await page.screenshot({
			path: testInfo.outputPath("steer-refused-restored.png"),
		}),
		contentType: "image/png",
	});
	await page.locator("#input").fill("A revised steer");
	await expect(page.getByTestId("composer-steer-refused")).toBeHidden();
});

test("an inbox-queued reply clears guessed working and renders the queued message", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page, {
		"input.submit": (input) => {
			rpc.sendChunk(
				"SubscribeSessionDetail",
				[
					{
						_tag: "upsert",
						sequence: 50,
						item: {
							_tag: "pendingInput",
							input: {
								inputId: input.inputId,
								request: { text: input.text },
								state: "queued",
								admittedAt: Date.now(),
							},
						},
					},
				],
				seed,
			);
			return { ok: true, sessionId: seed, handedOff: false };
		},
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#input").fill("Waiting in the inbox");
	await page.locator("#send").click();
	await expect(
		page
			.getByRole("list", { name: "Queued messages", exact: true })
			.getByText("Waiting in the inbox", { exact: true }),
	).toBeVisible();
	await expect(page.locator("#stop")).toBeHidden();
	await testInfo.attach("queued-without-working", {
		body: await page.screenshot({
			path: testInfo.outputPath("queued-without-working.png"),
		}),
		contentType: "image/png",
	});
});

test("ForkSession response selects the fork and restores its draft", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	const item = page.locator(`#session-list [data-session-id="${seed}"]`);
	await item.hover();
	await item.locator(".session-more-btn").click();
	await page.getByTestId("session-ctx-fork").click();
	await rpc.waitForRequest((request) => request.tag === "ForkSession");
	await expect(page).toHaveURL(new RegExp(`/s/${forked}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${forked}`);
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`/s/${seed}$`));
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await testInfo.attach("fork-back-to-parent", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});

test("a fork reply after opening another session leaves its route and composer alone", async ({
	page,
	harness,
}, testInfo) => {
	let completeFork!: (reply: {
		projectSlug: string;
		sessionId: string;
		forkedFrom: string;
	}) => void;
	const { rpc } = await setup(page, {
		ForkSession: () =>
			new Promise((resolve) => {
				completeFork = resolve;
			}),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	const item = page.locator(`#session-list [data-session-id="${seed}"]`);
	await item.hover();
	await item.locator(".session-more-btn").click();
	await page.getByTestId("session-ctx-fork").click();
	await rpc.waitForRequest((request) => request.tag === "ForkSession");
	await page
		.locator(`#session-list [data-session-id="${survivor}"]`)
		.click({ position: { x: 48, y: 12 } });
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await page.locator("#input").fill("Keep the other session open");
	completeFork({ projectSlug, sessionId: forked, forkedFrom: seed });
	await expect(
		page.getByRole("status").filter({ hasText: 'Forked from "Current"' }),
	).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
	await expect(page.locator("#input")).toHaveValue(
		"Keep the other session open",
	);
	expect(
		rpc
			.getRequests()
			.filter(
				(request) =>
					request.tag === "ViewSession" &&
					request.payload["sessionId"] === forked,
			),
	).toEqual([]);
	await testInfo.attach("late-fork-keeps-selection", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});

test("New session pushes from a session and replaces an existing draft entry", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}?keep=draft-history`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#new-session-btn").click();
	await expect(page).toHaveURL(
		new RegExp(`/draft/[^/?]+\\?keep=draft-history&project=${projectSlug}`),
	);
	const draftPath = new URL(page.url()).pathname;
	await expect(page.getByTestId("draft-project-chip")).toContainText(
		projectSlug,
	);
	await page.goBack();
	await expect(page).toHaveURL(
		`${harness.relayBaseUrl}/s/${seed}?keep=draft-history`,
	);
	await page.goForward();
	// An unpinned draft is a valid link; New pins the project's default.
	await page.evaluate((path) => {
		window.history.replaceState(null, "", `${path}?keep=draft-history`);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, draftPath);
	await expect(page.getByTestId("draft-project-chip")).toContainText(
		projectSlug,
	);
	await page.locator("#new-session-btn").click();
	await expect(page).toHaveURL(
		`${harness.relayBaseUrl}${draftPath}?keep=draft-history&project=${projectSlug}`,
	);
	await page.goBack();
	await expect(page).toHaveURL(
		`${harness.relayBaseUrl}/s/${seed}?keep=draft-history`,
	);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	expect(
		rpc.getRequests().filter((request) => request.tag === "CreateSession"),
	).toEqual([]);
	await testInfo.attach("draft-back-to-session", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});

test("deleting the viewed session selects the next sidebar row and replaces history", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page, {}, [
		...rows,
		{
			id: "outside-scope",
			title: "Outside scope",
			status: "idle",
			updatedAt: Date.now() + 1_000,
			projectSlug: otherProject,
		},
	]);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}?p=${projectSlug}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	rpc.removeShellRow(seed);
	await expect(page).toHaveURL(
		new RegExp(`/s/${survivor}\\?p=${projectSlug}$`),
	);
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await expect(page.getByText(notFound)).toHaveCount(0);
	await page.goBack();
	await expect(page).not.toHaveURL(new RegExp(`/s/${seed}$`));
});

test("deleting the last session in the filtered list goes home without not-found", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page, {}, [
		...rows.slice(0, 1),
		{
			id: "outside-scope",
			title: "Outside scope",
			status: "idle",
			updatedAt: Date.now() + 1_000,
			projectSlug: otherProject,
		},
	]);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}?p=${projectSlug}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	rpc.removeShellRow(seed);
	await expect(page).toHaveURL(`${harness.relayBaseUrl}/?p=${projectSlug}`);
	await expect(page.getByText(notFound)).toHaveCount(0);
	await expect(page.locator(`[data-session-id="${seed}"]`)).toHaveCount(0);
});

test("deleting a session moves every tab showing it without not-found", async ({
	page,
	harness,
}, testInfo) => {
	const secondPage = await page.context().newPage();
	const tabs = await Promise.all(
		[page, secondPage].map(async (tab) => {
			const { rpc } = await setup(tab);
			await tab.goto(`${harness.relayBaseUrl}/s/${seed}`);
			await expect(tab.locator("#input")).toHaveValue("Seed draft");
			return { tab, rpc };
		}),
	);
	for (const { rpc } of tabs) rpc.removeShellRow(seed);
	for (const { tab } of tabs) {
		await expect(tab).toHaveURL(new RegExp(`/s/${survivor}$`));
		await expect(tab.locator("#input")).toHaveValue(`Draft for ${survivor}`);
		await expect(tab.getByText(notFound)).toHaveCount(0);
	}
	const output = testInfo.outputPath("delete-session-tabs.json");
	await writeFile(
		output,
		`${JSON.stringify(
			tabs.map(({ tab, rpc }) => ({
				route: tab.url(),
				requests: rpc.getRequests(),
			})),
			null,
			2,
		)}\n`,
	);
	await testInfo.attach("delete-session-tabs", { path: output });
});

test("input.submit response selects a materialized OpenCode session", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${survivor}`);
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await page.evaluate((path) => {
		window.history.pushState(null, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, `/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#input").fill("Dispatch to OpenCode");
	rpc.upsertShellRow({
		...rows[0],
		id: seed,
		title: "Source with history",
		lastTurnEndVersion: 200,
		lastTurnEndInputId: "older-input",
	});
	await expect(
		page.locator(`#session-list [data-session-id="${seed}"]`),
	).toContainText("Source with history");
	await page.locator("#send").click();
	const submitted = await rpc.waitForRequest(
		(request) => request.tag === "input.submit",
	);
	await expect(page).toHaveURL(new RegExp(`/s/${materialized}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${materialized}`);
	await expect(page.locator("#stop")).toBeVisible();
	rpc.upsertShellRow({
		id: materialized,
		title: "Materialized",
		status: "idle",
		lastTurnEndVersion: 99,
		lastTurnEndInputId: submitted.payload["inputId"],
	});
	await expect(page.locator("#stop")).toBeHidden();
	await testInfo.attach("redirect-turn-settled", {
		body: await page.screenshot({
			path: testInfo.outputPath("redirect-turn-settled.png"),
		}),
		contentType: "image/png",
	});
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
});
