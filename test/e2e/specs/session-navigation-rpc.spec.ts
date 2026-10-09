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

async function setup(page: import("@playwright/test").Page) {
	const rpc = await mockWsRpc(page, {
		handlers: {
			ResolveSession: () => ({ projectSlug }),
			ViewSession: ({ sessionId }) => ({
				ok: true,
				draft: sessionId === seed ? "Seed draft" : `Draft for ${sessionId}`,
			}),
			CreateSession: () => ({ projectSlug, sessionId: created }),
			ForkSession: () => ({ projectSlug, sessionId: forked, parentId: seed }),
			"input.submit": () => ({ ok: true, sessionId: materialized }),
			DeleteSession: () => ({ ok: true }),
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
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
	return { rpc, relay };
}

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
