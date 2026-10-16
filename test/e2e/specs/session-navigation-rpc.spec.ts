import { writeFile } from "node:fs/promises";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
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
) {
	const rpc = await mockWsRpc(page, {
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
				],
				current: projectSlug,
			},
			{ type: "shell_snapshot", roots: true, sessions: rows },
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
	expect(placement(cold)).toEqual(["AttachProject", "SubscribeSessionDetail"]);

	rpc.removeShellRow(seed);
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === survivor,
	);
	const warm = rpc.getRequests().slice(cold.length);
	// Deleting the viewed session switches to the survivor in place, so the
	// route change that follows has nothing left to resolve.
	expect(placement(warm)).toEqual(["SubscribeSessionDetail"]);
	const output = testInfo.outputPath("session-navigation-rpc.json");
	await writeFile(output, `${JSON.stringify({ cold, warm }, null, 2)}\n`);
	await testInfo.attach("session-navigation-rpc", { path: output });
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
		ViewSession: () => ({ ok: true, draft: "" }),
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
		page.getByText("Waiting in the inbox", { exact: true }),
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
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	rpc.removeShellRow(seed);
	await expect(page).toHaveURL(new RegExp(`/s/${survivor}$`));
	await expect(page.locator("#input")).toHaveValue(`Draft for ${survivor}`);
	await page.goBack();
	await expect(page).not.toHaveURL(new RegExp(`/s/${seed}$`));
});

test("input.submit response selects a materialized OpenCode session", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await setup(page);
	await page.goto(`${harness.relayBaseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue("Seed draft");
	await page.locator("#input").fill("Dispatch to OpenCode");
	rpc.upsertShellRow({
		...rows[0],
		id: seed,
		title: "Source with history",
		lastTurnEndVersion: 200,
		lastTurnEndInputId: "older-input",
	});
	await expect(page.locator(`[data-session-id="${seed}"]`)).toContainText(
		"Source with history",
	);
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
	await expect(page).not.toHaveURL(new RegExp(`/s/${seed}$`));
});
