// Failures to guard: same-session panes sharing a body window or cancellation,
// and an older navigation completing after a newer target has been selected.
import { writeFileSync } from "node:fs";
import { Effect, Stream } from "effect";
import type {
	SessionDetailEnvelope,
	SessionDetailWindowRequest,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import { makeRpcStream } from "../../helpers/rpc-wire.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, sendMockFamily } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const sessionId = "claude-subagent-navigation";
const rootId = "navigation-parent";
const projectSlug = "e2e-replay";
const createdAt = Date.UTC(2026, 9, 27);
const promptId = (index: number) => `prompt-${index}`;
type Item = Extract<
	SessionDetailEnvelope,
	{ _tag: "snapshot" }
>["rows"][number];

function turn(index: number): Item[] {
	return [
		{
			_tag: "message",
			message: {
				id: promptId(index),
				role: "user",
				time: { created: createdAt + index * 1000 },
			},
		},
		{
			_tag: "part",
			messageId: promptId(index),
			sortOrder: 0,
			part: {
				id: `question-${index}`,
				type: "text",
				text: `Prompt ${index}: inspect this step.`,
			},
		},
		{
			_tag: "message",
			message: {
				id: `answer-${index}`,
				role: "assistant",
				parentID: promptId(index),
				time: {
					created: createdAt + index * 1000 + 1,
					completed: createdAt + index * 1000 + 2,
				},
			},
		},
		{
			_tag: "part",
			messageId: `answer-${index}`,
			sortOrder: 0,
			part: {
				id: `reply-${index}`,
				type: "text",
				text: `Answer ${index}.\n\nA separate paragraph keeps each transcript scrollable.`,
			},
		},
	];
}

function snapshot(
	first: number,
	last: number,
	historical: boolean,
): SessionDetailEnvelope {
	return {
		_tag: "snapshot",
		sequence: 1,
		hasMore: first > 1,
		rows: [
			{
				_tag: "window",
				window: {
					kind: historical ? "historical" : "latest",
					firstMessageId: promptId(first),
					lastMessageId: `answer-${last}`,
					hasEarlier: first > 1,
					hasLater: last < 120,
				},
			},
			...Array.from({ length: last - first + 1 }, (_, offset) =>
				turn(first + offset),
			).flat(),
		],
	};
}

function makeDetail(window: SessionDetailWindowRequest | undefined) {
	const queue = Effect.runSync(
		makeRpcStream<SessionDetailEnvelope, WsRpcError>(),
	);
	let closed = false;
	return {
		window,
		get closed() {
			return closed;
		},
		stream: queue.stream.pipe(
			Stream.ensuring(
				Effect.sync(() => {
					closed = true;
				}),
			),
		),
		emit: (...frames: SessionDetailEnvelope[]) =>
			Effect.runSync(queue.emit(...frames)),
	};
}

test.use({ viewport: { width: 1440, height: 900 } });

test("same-session panes navigate independently and discard superseded targets", async ({
	page,
	harness,
}, testInfo) => {
	const details: ReturnType<typeof makeDetail>[] = [];
	await mockWsRpc(page, {
		stubs: {
			ResolveSession: () => ({ projectSlug }),
			ViewSession: () => ({ ok: true }),
			SubscribeSessionDetail: ({ window }) => {
				const detail = makeDetail(window);
				details.push(detail);
				if (!window)
					detail.emit(snapshot(101, 120, false), { _tag: "synchronized" });
				return detail.stream;
			},
		},
		streams: {
			SubscribeSessionPromptIndex: () => [
				{
					_tag: "snapshot",
					sequence: 1,
					rows: Array.from({ length: 120 }, (_, index) => ({
						id: promptId(index + 1),
						createdAt: createdAt + (index + 1) * 1000,
						preview: `Prompt ${index + 1}: inspect this step.`,
						isInherited: false,
					})),
				},
				{ _tag: "synchronized" },
			],
		},
	});
	const root = {
		id: rootId,
		title: "Navigation parent",
		status: "idle",
		updatedAt: createdAt,
		backgroundTasks: [
			{
				id: "navigation-task",
				type: "local_agent",
				description: "Review navigation",
				firstSeenAt: createdAt,
				childSessionId: sessionId,
			},
		],
	};
	const child = {
		id: sessionId,
		title: "Navigation child",
		status: "idle",
		updatedAt: createdAt,
		parentID: rootId,
		// Adversarial, schema-valid metadata exposes the same session in both
		// views through normal clicks; this is not a normal server task tree.
		backgroundTasks: root.backgroundTasks,
		messageCount: 240,
	};
	await mockRelayWebSocket(page, {
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
			{ type: "shell_snapshot", roots: true, sessions: [root, child] },
		],
		responses: new Map(),
	});
	sendMockFamily(page, [root, child]);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${harness.relayBaseUrl}/s/${sessionId}`);
	const main = page.locator("#messages");
	const mainRail = main
		.locator("..")
		.getByRole("slider", { name: "User messages" });
	await expect(mainRail).toHaveAttribute("aria-valuemax", "120");
	await expect(main.locator(".msg-user").last()).toContainText("Prompt 120:");
	await page
		.getByRole("button", { name: "1 background task", exact: true })
		.click();
	await page
		.getByTestId("background-tasks-panel")
		.getByRole("button", { name: "Open Review navigation", exact: true })
		.click();
	const drawer = page.getByTestId("task-drawer-transcript");
	const drawerRail = drawer.getByRole("slider", { name: "User messages" });
	await expect.poll(() => details.length).toBe(2);

	await expect(drawerRail).toHaveAttribute("aria-valuemax", "120");
	const mainInitial = details[0];
	const drawerInitial = details[1];
	if (!mainInitial || !drawerInitial)
		throw new Error("Missing independent subscriptions");

	await mainRail.focus();
	await page.keyboard.press("Home");
	await expect.poll(() => details.length).toBe(3);
	const mainOld = details[2];
	if (!mainOld) throw new Error("Missing main target subscription");
	expect(mainOld.window?.anchorMessageId).toBe(promptId(1));
	mainOld.emit(snapshot(1, 20, true), { _tag: "synchronized" });
	await expect(main.locator(".msg-user").first()).toContainText("Prompt 1:");
	await expect(drawer.locator(".msg-user").last()).toContainText("Prompt 120:");
	expect(drawerInitial.closed).toBe(false);

	await drawerRail.focus();
	await page.keyboard.press("Home");
	await expect.poll(() => details.length).toBe(4);
	const superseded = details[3];
	if (!superseded) throw new Error("Missing drawer target subscription");
	// The preview follows the requested target while the old window remains shown.
	await expect(drawer.getByTestId("message-rail-preview")).toContainText(
		"Prompt 1:",
	);
	await expect(drawer.locator(".msg-user").last()).toContainText("Prompt 120:");
	await page.keyboard.press("PageDown");
	await expect.poll(() => details.length).toBe(5);
	const drawerOld = details[4];
	if (!drawerOld) throw new Error("Missing replacement drawer subscription");
	expect(drawerOld.window?.anchorMessageId).toBe(promptId(11));
	drawerOld.emit(snapshot(11, 30, true), { _tag: "synchronized" });
	await expect(drawer.locator(".msg-user").first()).toContainText("Prompt 11:");
	await expect(drawerRail).toHaveAttribute("aria-valuenow", "11");
	await expect.poll(() => superseded.closed).toBe(true);
	// A late response for the cancelled request must not replace either pane.
	superseded.emit(snapshot(1, 20, true), { _tag: "synchronized" });
	function refreshMain(text: string, sequence: number) {
		const page = snapshot(1, 20, true);
		if (page._tag !== "snapshot")
			throw new Error("Expected historical snapshot");
		mainOld?.emit(
			{
				...page,
				sequence,
				rows: page.rows.map((item) =>
					item._tag === "part" && item.part.id === "reply-1"
						? { ...item, part: { ...item.part, text } }
						: item,
				),
			},
			{ _tag: "synchronized" },
		);
	}
	refreshMain("Main window remains connected.", 2);
	await expect(main).toContainText("Main window remains connected.");
	await expect(drawer.locator(".msg-user").first()).toContainText("Prompt 11:");
	await expect(main.locator(".msg-user").first()).toContainText("Prompt 1:");
	expect(mainOld.closed).toBe(false);
	await page.screenshot({
		path: testInfo.outputPath("independent-windows.png"),
	});

	await page.getByTestId("task-drawer-close").click();
	await expect(page.getByTestId("task-drawer")).toHaveCount(0);
	await expect.poll(() => drawerOld.closed).toBe(true);
	expect(mainOld.closed).toBe(false);
	refreshMain("Main window survives drawer disposal.", 3);
	await expect(main).toContainText("Main window survives drawer disposal.");
	await expect(mainRail).toHaveAttribute("aria-valuemax", "120");
	expect(errors).toEqual([]);
	const evidence = testInfo.outputPath("navigation-concurrency.json");
	writeFileSync(
		evidence,
		JSON.stringify(
			{
				windows: details.map((detail) => ({
					window: detail.window ?? "latest",
					closed: detail.closed,
				})),
				errors,
			},
			null,
			2,
		),
	);
	await testInfo.attach("navigation-concurrency", {
		path: evidence,
		contentType: "application/json",
	});
});

// Skill links name an assistant part, not a user prompt. They must load its
// bounded window in either direction before expanding the exact activity row.
test("skill links reveal unloaded parts before and after the current window", async ({
	page,
	harness,
}, testInfo) => {
	const requested: (SessionDetailWindowRequest | undefined)[] = [];
	function skillPage(first: number, last: number, historical: boolean) {
		const body = snapshot(first, last, historical);
		if (body._tag !== "snapshot") throw new Error("Expected snapshot");
		return {
			...body,
			rows: body.rows.flatMap((row): Item[] => {
				if (
					row._tag !== "part" ||
					!["answer-1", "answer-110"].includes(row.messageId)
				)
					return [row];
				const index = Number(row.messageId.slice("answer-".length));
				return [
					{
						_tag: "part",
						messageId: row.messageId,
						sortOrder: 0,
						part: {
							id: `skill-${index}`,
							type: "tool",
							tool: "Skill",
							callID: `call-${index}`,
							state: {
								status: "completed",
								input: {
									_tag: "whole",
									value: { tool: "Skill", name: `review-${index}` },
								},
								output: { _tag: "whole", text: "Loaded." },
							},
							time: {
								start: createdAt + index * 1000,
								end: createdAt + index * 1000 + 1,
							},
						},
					},
					{ ...row, sortOrder: 1 },
				];
			}),
		} satisfies SessionDetailEnvelope;
	}
	await mockWsRpc(page, {
		stubs: {
			ResolveSession: () => ({ projectSlug }),
			ViewSession: () => ({ ok: true }),
			GetSessionSkills: () => ({
				loads: [1, 110].map((index) => ({
					name: `review-${index}`,
					invokedBy: "agent" as const,
					turnOrdinal: index,
					at: createdAt + index * 1000,
					anchor: { messageId: `answer-${index}`, partId: `skill-${index}` },
					running: false,
				})),
			}),
			SubscribeSessionDetail: ({ window }) => {
				requested.push(window);
				const first = window?.anchorMessageId === "answer-1" ? 1 : 101;
				return Stream.make(skillPage(first, first + 19, !!window), {
					_tag: "synchronized",
				} as const).pipe(Stream.concat(Stream.never));
			},
		},
		streams: {
			SubscribeSessionPromptIndex: () => [
				{
					_tag: "snapshot",
					sequence: 1,
					rows: Array.from({ length: 120 }, (_, index) => ({
						id: promptId(index + 1),
						createdAt: createdAt + index * 1000,
						preview: `Prompt ${index + 1}`,
						isInherited: false,
					})),
				},
				{ _tag: "synchronized" },
			],
		},
	});
	const session = {
		id: sessionId,
		title: "Skill navigation",
		status: "idle",
		updatedAt: createdAt,
		messageCount: 240,
	};
	await mockRelayWebSocket(page, {
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
			{ type: "shell_snapshot", roots: true, sessions: [session] },
		],
		responses: new Map(),
	});
	sendMockFamily(page, [session]);
	await page.goto(`${harness.relayBaseUrl}/s/${sessionId}`);
	await expect(page.locator("#messages .msg-user").last()).toContainText(
		"Prompt 120:",
	);
	for (const index of [1, 110]) {
		const target = page.locator(
			`#messages [data-part="answer-${index}/skill-${index}"]`,
		);
		await expect(target).toHaveCount(0);
		await page.getByTestId("session-skills-chip").click();
		await page
			.locator(
				`[data-testid="session-skills-row"][data-skill="review-${index}"]`,
			)
			.click();
		await expect(target).toBeVisible();
		await expect(target).toBeInViewport();
		expect(requested.at(-1)?.anchorMessageId).toBe(`answer-${index}`);
	}
	await page.screenshot({
		path: testInfo.outputPath("skill-anchor-navigation.png"),
		animations: "disabled",
	});
	writeFileSync(
		testInfo.outputPath("skill-anchor-navigation.json"),
		JSON.stringify(requested, null, 2),
	);
});
