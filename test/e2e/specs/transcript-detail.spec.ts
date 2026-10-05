import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const project = "e2e-replay";
const a = "transcript-a";
const b = "transcript-b";
const reply = (text: string) => ({
	_tag: "transcriptMessage",
	message: {
		id: "assistant-a",
		role: "assistant",
		parentID: "user-a",
		time: { created: 1 },
		parts: [{ id: "part-a", type: "text", text }],
	},
});

test("detail feed renders streamed text once and resumes cached content across switches", async ({
	page,
	harness,
}) => {
	const rpc = await mockWsRpc(page, {
		handlers: {
			ResolveSession: () => ({ projectSlug: project }),
			ViewSession: () => ({ ok: true }),
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
		},
		streams: {
			SubscribeSessionDetail: ({ resumeFromSequence }) =>
				resumeFromSequence === undefined
					? [
							{ _tag: "snapshot", rows: [], sequence: 0, hasMore: false },
							{ _tag: "synchronized" },
						]
					: [{ _tag: "synchronized" }],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{ slug: project, title: project, folders: ["/tmp/e2e-replay"] },
				],
				current: project,
			},
			{
				type: "shell_snapshot",
				roots: true,
				sessions: [
					{
						id: a,
						title: "Session A",
						status: "idle",
						updatedAt: Date.now(),
						messageCount: 1,
					},
					{
						id: b,
						title: "Session B",
						status: "idle",
						updatedAt: Date.now(),
						messageCount: 0,
					},
				],
			},
		],
		responses: new Map(),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${a}`);
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === a,
	);
	rpc.sendChunk(
		"SubscribeSessionDetail",
		[{ _tag: "upsert", item: reply("Hel"), sequence: 1 }],
		a,
	);
	await expect(page.locator(".msg-assistant .md-content")).toContainText("Hel");
	rpc.sendChunk(
		"SubscribeSessionDetail",
		[{ _tag: "upsert", item: reply("Hello world"), sequence: 2 }],
		a,
	);
	await expect(page.locator(".msg-assistant")).toHaveCount(1);
	await expect(page.locator(".msg-assistant .md-content")).toContainText(
		"Hello world",
	);
	await page.locator(`#session-list [data-session-id="${b}"]`).click();
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === b,
	);
	await page.locator(`#session-list [data-session-id="${a}"]`).click();
	await expect
		.poll(
			() =>
				rpc
					.getRequests()
					.filter(
						(request) =>
							request.tag === "SubscribeSessionDetail" &&
							request.payload["sessionId"] === a,
					).length,
		)
		.toBe(2);
	const resumed = rpc
		.getRequests()
		.filter(
			(request) =>
				request.tag === "SubscribeSessionDetail" &&
				request.payload["sessionId"] === a,
		)[1];
	expect(resumed?.payload["resumeFromSequence"]).toBe(2);
	await expect(page.locator(".msg-assistant .md-content")).toContainText(
		"Hello world",
	);
});

test("detail catch-up removes a message after returning to a session", async ({
	page,
	harness,
}) => {
	const rpc = await mockWsRpc(page, {
		handlers: {
			ResolveSession: () => ({ projectSlug: project }),
			ViewSession: () => ({ ok: true }),
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
		},
		streams: {
			SubscribeSessionDetail: ({ sessionId, resumeFromSequence }) =>
				sessionId === a && resumeFromSequence === undefined
					? [
							{
								_tag: "snapshot",
								rows: [reply("Remove me")],
								sequence: 1,
								hasMore: false,
							},
							{ _tag: "synchronized" },
						]
					: sessionId === a
						? [
								{ _tag: "remove", id: "assistant-a", sequence: 2 },
								{ _tag: "synchronized" },
							]
						: [
								{ _tag: "snapshot", rows: [], sequence: 0, hasMore: false },
								{ _tag: "synchronized" },
							],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{ slug: project, title: project, folders: ["/tmp/e2e-replay"] },
				],
				current: project,
			},
			{
				type: "shell_snapshot",
				roots: true,
				sessions: [
					{
						id: a,
						title: "Session A",
						status: "idle",
						updatedAt: Date.now(),
						messageCount: 1,
					},
					{
						id: b,
						title: "Session B",
						status: "idle",
						updatedAt: Date.now(),
						messageCount: 0,
					},
				],
			},
		],
		responses: new Map(),
	});
	await page.goto(`${harness.relayBaseUrl}/s/${a}`);
	await expect(page.locator(".msg-assistant .md-content")).toContainText(
		"Remove me",
	);
	await page.locator(`#session-list [data-session-id="${b}"]`).click();
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === b,
	);
	await page.locator(`#session-list [data-session-id="${a}"]`).click();
	await expect
		.poll(
			() =>
				rpc
					.getRequests()
					.filter(
						(request) =>
							request.tag === "SubscribeSessionDetail" &&
							request.payload["sessionId"] === a,
					).length,
		)
		.toBe(2);
	await expect(page.locator(".msg-assistant")).toHaveCount(0);
});
