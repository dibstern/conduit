import { writeFile } from "node:fs/promises";
import type { GetFileListResponse } from "../../../src/lib/contracts/ws-rpc.js";
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
	sessionRows: Array<(typeof rows)[number] & { projectSlug?: string }> = rows,
) {
	const rpc = await mockWsRpc(page, {
		stubs: {
			"input.submit": () => ({
				ok: true,
				sessionId: materialized,
				handedOff: true,
			}),
			ResolveSession: () => ({ projectSlug }),
			ViewSession: ({ sessionId }) => ({
				ok: true,
				draft: sessionId === seed ? "Seed draft" : `Draft for ${sessionId}`,
			}),
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
						folders: ["/tmp/e2e-replay"],
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
	const projectReadsBeforeAttach = rpc
		.getRequests()
		.filter((request) => request.tag === "GetProjects").length;
	finishAttach({ projectSlug: otherProject, sessionSlug: null });
	await expect
		.poll(
			() =>
				rpc.getRequests().filter((request) => request.tag === "GetProjects")
					.length,
		)
		.toBeGreaterThan(projectReadsBeforeAttach);
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

test("a draft's first send creates the session in its project and sends into it", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#new-session-btn").click();
	await expect(page).toHaveURL(
		new RegExp(`/new\\?(?:.*&)?project=${projectSlug}`),
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
		projectSlug,
		sessionId: created,
		text: "Hello",
	});
});

test("ForkSession response selects the fork and restores its draft", async ({
	page,
	harness,
}) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	const item = page.locator(`[data-session-id="${seed}"]`);
	await item.hover();
	await item.locator(".session-more-btn").click();
	await page.getByTestId("session-ctx-fork").click();
	await rpc.waitForRequest((request) => request.tag === "ForkSession");
	await expect(page).toHaveURL(new RegExp(`/s/${forked}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${forked}`);
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
}) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#input").fill("Dispatch to OpenCode");
	await page.locator("#send").click();
	await rpc.waitForRequest((request) => request.tag === "input.submit");
	await expect(page).toHaveURL(new RegExp(`/s/${materialized}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${materialized}`);
	await page.goBack();
	await expect(page).not.toHaveURL(new RegExp(`/s/${seed}$`));
});
