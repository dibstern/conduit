import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const project = "e2e-replay";
const a = "transcript-a";
const b = "transcript-b";

test.describe("message calendar timestamps", () => {
	test.use({
		timezoneId: "Australia/Melbourne",
		locale: "en-AU",
		viewport: { width: 390, height: 844 },
		hasTouch: true,
	});

	test("dates survive DST, roll over at midnight, and expose the full date on tap", async ({
		page,
		harness,
	}, testInfo) => {
		// Melbourne entered daylight saving on 4 October. Calendar days must not
		// be computed by dividing elapsed milliseconds into 24-hour periods.
		await page.clock.install({ time: new Date("2026-10-05T23:59:58+11:00") });
		await page.clock.pauseAt(new Date("2026-10-05T23:59:58+11:00"));
		const cases = [
			["2026-10-05T10:42:00+11:00", "Today · 10:42 am"],
			["2026-10-04T00:30:00+10:00", "Yesterday · 12:30 am"],
			["2026-10-03T23:30:00+10:00", "2 days ago · 11:30 pm"],
			["2026-09-29T10:42:00+10:00", "6 days ago · 10:42 am"],
			["2026-09-28T10:42:00+10:00", "28 Sept · 10:42 am"],
			["2025-10-05T10:42:00+11:00", "5 Oct 2025 · 10:42 am"],
			["2026-10-06T10:42:00+11:00", "6 Oct · 10:42 am"],
		] as const;
		const rows = [
			...cases.flatMap(([instant], index) => [
				{
					_tag: "message",
					message: {
						id: `dated-${index}`,
						role: "user",
						time: { created: Date.parse(instant) },
					},
				},
				{
					_tag: "part",
					messageId: `dated-${index}`,
					sortOrder: 0,
					part: {
						id: `text-${index}`,
						type: "text",
						text: `Timestamp example ${index}`,
					},
				},
			]),
			...reply("Timestamped assistant response"),
			{
				_tag: "message",
				message: { id: "undated", role: "user" },
			},
			{
				_tag: "part",
				messageId: "undated",
				sortOrder: 0,
				part: { id: "undated-text", type: "text", text: "No timestamp" },
			},
		];
		await mockWsRpc(page, {
			stubs: {
				ResolveSession: () => ({ projectSlug: project }),
				ViewSession: () => ({ ok: true }),
			},
			streams: {
				SubscribeSessionDetail: () => [
					{ _tag: "snapshot", rows, sequence: 1, hasMore: false },
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
							title: "Message dates",
							status: "idle",
							updatedAt: Date.now(),
							messageCount: rows.length,
						},
					],
				},
			],
			responses: new Map(),
		});
		await page.goto(`${harness.relayBaseUrl}/s/${a}`);
		for (const [index, [instant, label]] of cases.entries()) {
			const time = page
				.locator(".msg-user")
				.filter({ hasText: `Timestamp example ${index}` })
				.locator("time");
			await expect(time).toHaveText(label);
			await expect(time).toHaveAttribute(
				"datetime",
				new Date(instant).toISOString(),
			);
		}
		await expect(
			page.locator(".msg-user").filter({ hasText: "No timestamp" }),
		).toHaveCount(1);
		await expect(
			page
				.locator(".msg-user")
				.filter({ hasText: "No timestamp" })
				.locator("time"),
		).toHaveCount(0);
		await expect(page.locator(".assistant-header time")).toContainText("1970");
		const trigger = page
			.locator(".msg-user")
			.filter({ hasText: "Timestamp example 1" })
			.getByRole("button")
			.filter({ has: page.locator("time") });
		await trigger.tap();
		const details = page.getByRole("dialog", { name: "Message timestamp" });
		await expect(details).toContainText("Sunday, 4 October 2026");
		await expect(details).toContainText("AEST");
		await page.keyboard.press("Escape");
		await expect(trigger).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(details).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Space");
		await expect(details).toBeVisible();
		await page.keyboard.press("Escape");
		await page.clock.runFor(3000);
		await expect(
			page
				.locator(".msg-user")
				.filter({ hasText: "Timestamp example 0" })
				.locator("time"),
		).toHaveText("Yesterday · 10:42 am");
		await page
			.locator(".msg-user")
			.filter({ hasText: "Timestamp example 0" })
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: testInfo.outputPath("message-calendar-timestamps-phone.png"),
		});
	});
});
// A message travels as its header, then each part as a row of its own.
const reply = (text: string) => [
	{
		_tag: "message",
		message: {
			id: "assistant-a",
			role: "assistant",
			parentID: "user-a",
			time: { created: 1 },
		},
	},
	{
		_tag: "part",
		messageId: "assistant-a",
		sortOrder: 0,
		part: { id: "part-a", type: "text", text },
	},
];

test("detail feed renders streamed text once and resumes cached content across switches", async ({
	page,
	harness,
}) => {
	const rpc = await mockWsRpc(page, {
		stubs: {
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
		reply("Hel").map((item) => ({ _tag: "upsert", item, sequence: 1 })),
		a,
	);
	await expect(page.locator(".msg-assistant .md-content")).toContainText("Hel");
	rpc.sendChunk(
		"SubscribeSessionDetail",
		reply("Hello world").map((item) => ({ _tag: "upsert", item, sequence: 2 })),
		a,
	);
	await expect(page.locator(".msg-assistant")).toHaveCount(1);
	await expect(page.locator(".msg-assistant .md-content")).toContainText(
		"Hello world",
	);
	// The title end: the row's hover actions cover its centre.
	await page
		.locator(`#session-list [data-session-id="${b}"]`)
		.click({ position: { x: 48, y: 12 } });
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === b,
	);
	await page
		.locator(`#session-list [data-session-id="${a}"]`)
		.click({ position: { x: 48, y: 12 } });
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
		stubs: {
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
								rows: reply("Remove me"),
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
	// The title end: the row's hover actions cover its centre.
	await page
		.locator(`#session-list [data-session-id="${b}"]`)
		.click({ position: { x: 48, y: 12 } });
	await rpc.waitForRequest(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			request.payload["sessionId"] === b,
	);
	await page
		.locator(`#session-list [data-session-id="${a}"]`)
		.click({ position: { x: 48, y: 12 } });
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
