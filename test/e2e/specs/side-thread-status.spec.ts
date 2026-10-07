// Real relay, SQLite projections and browser family pushes over recorded OpenCode.
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Page, TestInfo } from "@playwright/test";
import type {
	OpenCodeMessage,
	OpenCodeSession,
} from "../../../src/lib/contracts/providers/opencode-sdk.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import type {
	RelayMessage,
	SessionInfo,
} from "../../../src/lib/shared-types.js";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const parentPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const question =
	"What word did I ask you to remember? Reply with only the word.";
const parentFollowUp =
	"What word are you remembering? Reply with only the word.";
const approvalPrompt =
	"Use the bash tool to run printf 'side-thread-approval'. Do not answer without running this command.";
const questionPrompt =
	"Use the question tool to ask me to choose between Alpha and Beta, with header Choice and question Which word should we use? Wait for my answer before continuing.";

function sessionId(page: Page): string {
	const id = new URL(page.url()).pathname.split("/").at(-1);
	if (!id) throw new Error("Session route is missing");
	return id;
}

/** Relay pushes from /ws, and every family row SubscribeSessionFamily delivers. */
function watchPushes(page: Page) {
	const relay: RelayMessage[] = [];
	const family: SessionInfo[] = [];
	page.on("websocket", (socket) => {
		const path = new URL(socket.url()).pathname;
		if (path === "/ws") {
			socket.on("framereceived", ({ payload }) => {
				relay.push(JSON.parse(String(payload)) as RelayMessage);
			});
			return;
		}
		if (!path.endsWith("/rpc")) return;
		const familyRequests = new Set<string>();
		socket.on("framesent", ({ payload }) => {
			for (const line of String(payload).split("\n").filter(Boolean)) {
				const request = JSON.parse(line) as {
					_tag?: string;
					id?: string;
					tag?: string;
				};
				if (
					request._tag === "Request" &&
					request.tag === "SubscribeSessionFamily" &&
					request.id
				)
					familyRequests.add(request.id);
			}
		});
		socket.on("framereceived", ({ payload }) => {
			for (const line of String(payload).split("\n").filter(Boolean)) {
				const chunk = JSON.parse(line) as {
					_tag?: string;
					requestId?: string;
					values?: ReadonlyArray<{
						_tag: string;
						rows?: SessionInfo[];
						item?: SessionInfo;
					}>;
				};
				if (
					chunk._tag !== "Chunk" ||
					!familyRequests.has(chunk.requestId ?? "")
				)
					continue;
				for (const envelope of chunk.values ?? [])
					family.push(
						...(envelope.rows ?? []),
						...(envelope.item ? [envelope.item] : []),
					);
			}
		});
	});
	return { relay, family };
}

function storedFacts(dbPath: string) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return {
			sessions: db
				.prepare(
					"SELECT id, status, parent_id, side_thread FROM sessions ORDER BY id",
				)
				.all(),
			turns: db
				.prepare(
					"SELECT session_id, state FROM turns ORDER BY requested_at, id",
				)
				.all(),
			approvals: db
				.prepare(
					"SELECT id, session_id, type, status FROM pending_approvals ORDER BY created_at, id",
				)
				.all(),
			events: db
				.prepare(
					"SELECT sequence, session_id, type, data FROM events WHERE type IN ('session.created', 'session.status', 'turn.completed', 'permission.asked', 'permission.resolved', 'question.asked', 'question.resolved') ORDER BY sequence",
				)
				.all(),
		};
	} finally {
		db.close();
	}
}

async function completedParent(
	app: AppPage,
	chat: ChatPage,
	harness: ReplayHarness,
	relayUrl: string,
) {
	await app.goto(relayUrl);
	const parentId = sessionId(app.page);
	await app.sendMessage(parentPrompt);
	await chat.waitForAssistantMessage();
	await expect
		.poll(
			() =>
				storedFacts(harness.eventsDbPath).sessions.find(
					(row) => row["id"] === parentId,
				)?.["status"],
		)
		.toBe("idle");
	await chat.waitForStreamingComplete();
	return parentId;
}

async function attachEvidence(
	testInfo: TestInfo,
	page: Page,
	harness: ReplayHarness,
	pushes: ReturnType<typeof watchPushes>,
	name: string,
) {
	const screenshot = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path: screenshot, fullPage: true });
	await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
	const evidence = testInfo.outputPath(`${name}.json`);
	await writeFile(
		evidence,
		JSON.stringify(
			{
				url: page.url(),
				store: storedFacts(harness.eventsDbPath),
				family: pushes.family,
				pushes: pushes.relay.filter((message) =>
					["status", "session_list", "permission_request", "ask_user"].includes(
						message.type,
					),
				),
				mockDiagnostics: harness.mock.diagnostics,
			},
			null,
			2,
		),
	);
	await testInfo.attach(`${name}-store-and-websocket`, {
		path: evidence,
		contentType: "application/json",
	});
}

test.describe("OpenCode Side Thread status", () => {
	test.use({ recording: "side-thread-status" });
	test.describe.configure({ timeout: 90_000 });

	test("an answering Side Thread leaves its parent idle in the sidebar, back bar and session-open response", async ({
		page,
		harness,
		mockServer,
		relayUrl,
	}, testInfo) => {
		const pushes = watchPushes(page);
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const parentId = await completedParent(app, chat, harness, relayUrl);
		const release = mockServer.holdNextPrompt();
		try {
			await app.sendMessage(`$btw ${question}`);
			await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			const sideId = sessionId(page);
			await expect
				.poll(
					() =>
						storedFacts(harness.eventsDbPath).sessions.find(
							(row) => row["id"] === sideId,
						)?.["status"],
				)
				.toBe("busy");
			await expect(chat.stopBtn).toBeVisible();
			await expect(page.getByTestId("parent-session-status")).toHaveText(
				"Idle",
			);
			const parentRow = page.locator(
				`#session-list [data-session-id="${parentId}"]`,
			);
			await expect(parentRow).toBeVisible();
			await expect(parentRow).not.toHaveAccessibleName(/^Working/);
			await expect(parentRow.locator(".session-status-glyph")).toHaveClass(
				/text-session-idle/,
			);
			await expect(
				page.locator(`#session-list [data-session-id="${sideId}"]`),
			).toHaveCount(0);
			await attachEvidence(
				testInfo,
				page,
				harness,
				pushes,
				"side-working-parent-idle",
			);

			await chat.subagentBackBtn.click();
			await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			// The parent's shell row is its only busy signal (conduit-test-ni8.35):
			// opening it must not show a running turn while the side thread works.
			await expect(parentRow.locator(".session-status-glyph")).toHaveClass(
				/text-session-idle/,
			);
			await expect(chat.stopBtn).toBeHidden();
			await expect(chat.userMessages.filter({ hasText: question })).toHaveCount(
				0,
			);
			expect(
				storedFacts(harness.eventsDbPath).sessions.find(
					(row) => row["id"] === sideId,
				)?.["status"],
			).toBe("busy");
			await attachEvidence(
				testInfo,
				page,
				harness,
				pushes,
				"parent-opened-idle-with-side-busy",
			);
			release();
			await expect
				.poll(
					() =>
						storedFacts(harness.eventsDbPath).sessions.find(
							(row) => row["id"] === sideId,
						)?.["status"],
				)
				.toBe("idle");
		} finally {
			release();
		}
	});

	test("the back bar follows its working parent through completion while viewing an existing Side Thread", async ({
		page,
		harness,
		mockServer,
		relayUrl,
	}, testInfo) => {
		const pushes = watchPushes(page);
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const parentId = await completedParent(app, chat, harness, relayUrl);
		await app.sendMessage(`$side ${question}`);
		await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		const sideId = sessionId(page);
		await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
		await chat.waitForStreamingComplete();
		await chat.subagentBackBtn.click();
		await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		const release = mockServer.holdNextPrompt();
		try {
			await app.sendMessage(parentFollowUp);
			await expect(chat.stopBtn).toBeVisible();
			await expect
				.poll(
					() =>
						storedFacts(harness.eventsDbPath).sessions.find(
							(row) => row["id"] === parentId,
						)?.["status"],
				)
				.toBe("busy");
			await app.goto(`${harness.relayBaseUrl}/s/${sideId}`);
			await expect(page.getByTestId("parent-session-status")).toHaveText(
				"Working",
			);
			await expect(
				page.locator(`#session-list [data-session-id="${parentId}"]`),
			).toHaveAccessibleName(/^Working/);
			await expect(chat.stopBtn).toBeHidden();
			await expect
				.poll(() =>
					pushes.family.filter((session) => session.id === parentId).at(-1),
				)
				.toMatchObject({ processing: true });
			await attachEvidence(
				testInfo,
				page,
				harness,
				pushes,
				"parent-working-from-side",
			);
			release();
			await expect(page.getByTestId("parent-session-status")).toHaveText(
				"Idle",
			);
			await expect
				.poll(
					() =>
						storedFacts(harness.eventsDbPath).sessions.find(
							(row) => row["id"] === parentId,
						)?.["status"],
				)
				.toBe("idle");
			await expect
				.poll(() => {
					const parent = pushes.family
						.filter((session) => session.id === parentId)
						.at(-1);
					return parent?.status === "idle" && !parent.processing;
				})
				.toBe(true);
			await expect(page).toHaveURL(new RegExp(`/s/${sideId}(?:\\?|$)`));
			await expect(
				chat.userMessages.filter({ hasText: parentFollowUp }),
			).toHaveCount(0);
			await attachEvidence(
				testInfo,
				page,
				harness,
				pushes,
				"parent-completed-from-side",
			);
		} finally {
			release();
		}
	});
});

test.describe("OpenCode child family idle", () => {
	test.use({ recording: "chat-simple" });
	test.describe.configure({ timeout: 90_000 });

	test("a completed child leaves Working when its held family idle arrives", async ({
		page,
		harness,
		mockServer,
		relayUrl,
	}, testInfo) => {
		const pushes = watchPushes(page);
		const family: Envelope<SessionInfo>[] = [];
		const shell: Envelope<SessionInfo>[] = [];
		page.on("websocket", (socket) => {
			if (new URL(socket.url()).pathname !== "/rpc") return;
			const subscriptions = new Map<string, string>();
			socket.on("framesent", ({ payload }) => {
				const frame = JSON.parse(String(payload)) as {
					_tag?: string;
					id?: string;
					tag?: string;
				};
				if (
					frame._tag === "Request" &&
					frame.id !== undefined &&
					(frame.tag === "SubscribeSessionFamily" ||
						frame.tag === "SubscribeShell")
				)
					subscriptions.set(frame.id, frame.tag);
			});
			socket.on("framereceived", ({ payload }) => {
				const frame = JSON.parse(String(payload)) as {
					_tag?: string;
					requestId?: string;
					values?: Envelope<SessionInfo>[];
				};
				if (frame._tag !== "Chunk" || !frame.requestId || !frame.values) return;
				const tag = subscriptions.get(frame.requestId);
				if (tag === "SubscribeSessionFamily") family.push(...frame.values);
				if (tag === "SubscribeShell") shell.push(...frame.values);
			});
		});

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const parentId = await completedParent(app, chat, harness, relayUrl);
		const childId = "ses_family_idle_child";
		const messageId = "msg_family_idle_completed";
		const answer = "Child completed before idle.";
		const created = Date.now();
		const child = {
			id: childId,
			parentID: parentId,
			title: "Child with held idle",
			projectID: "e2e-replay",
			directory: process.cwd(),
			version: "1.17.18",
			time: { created, updated: created },
		} satisfies OpenCodeSession;
		const assistant = {
			id: messageId,
			sessionID: childId,
			role: "assistant",
			parentID: "msg_family_idle_user",
			modelID: "claude-sonnet-4-5",
			providerID: "anthropic",
			mode: "build",
			path: { cwd: process.cwd(), root: process.cwd() },
			cost: 0,
			tokens: {
				input: 1,
				output: 1,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			},
			time: { created },
		} satisfies OpenCodeMessage;
		mockServer.setExactResponse("GET", `/session/${childId}`, 200, child);
		mockServer.setExactResponse("GET", `/session/${childId}/message`, 200, []);
		await expect
			.poll(() =>
				mockServer.diagnostics.some(({ event }) => event === "sse_connect"),
			)
			.toBe(true);
		mockServer.injectSSEEvents([
			{ type: "session.created", properties: { info: child } },
			{
				type: "session.status",
				properties: { sessionID: childId, status: { type: "busy" } },
			},
		]);
		await expect
			.poll(() =>
				storedFacts(harness.eventsDbPath).sessions.find(
					(row) => row["id"] === childId,
				),
			)
			.toMatchObject({ status: "busy", parent_id: parentId });
		await app.goto(`${harness.relayBaseUrl}/s/${childId}`);
		await expect(chat.stopBtn).toBeVisible();
		mockServer.injectSSEEvents([
			{
				type: "message.updated",
				properties: { sessionID: childId, info: assistant },
			},
			{
				type: "message.part.updated",
				properties: {
					sessionID: childId,
					part: {
						id: "prt_family_idle_answer",
						messageID: messageId,
						sessionID: childId,
						type: "text",
						text: answer,
						time: { start: created, end: created + 1 },
					},
				},
			},
			{
				type: "message.updated",
				properties: {
					sessionID: childId,
					info: {
						...assistant,
						finish: "stop",
						time: { ...assistant.time, completed: created + 1 },
					} satisfies OpenCodeMessage,
				},
			},
		]);
		await expect
			.poll(() =>
				pushes.relay.some(
					(message) =>
						message.type === "result" &&
						message.sessionId === childId &&
						message.messageId === messageId,
				),
			)
			.toBe(true);
		await expect
			.poll(() =>
				storedFacts(harness.eventsDbPath).events.some(
					(row) =>
						row["session_id"] === childId && row["type"] === "turn.completed",
				),
			)
			.toBe(true);

		// Reopening creates a fresh activity slot. The child's own busy family
		// snapshot must seed Working with its completed transcript already loaded.
		// OpenCode translates idle to done; drop only that child's late
		// terminal notification so the real /rpc family feed has to clear it.
		const suppressedDone: RelayMessage[] = [];
		const delivered: RelayMessage[] = [];
		await page.routeWebSocket(
			(url) => url.pathname === "/ws",
			(socket) => {
				const server = socket.connectToServer();
				server.onMessage((payload) => {
					const message = JSON.parse(String(payload)) as RelayMessage;
					if (message.type === "done" && message.sessionId === childId) {
						suppressedDone.push(message);
						return;
					}
					delivered.push(message);
					socket.send(payload);
				});
			},
		);
		const familyBeforeOpen = family.length;
		const shellBeforeOpen = shell.length;
		await app.goto(`${harness.relayBaseUrl}/s/${childId}`);
		await expect
			.poll(() =>
				family
					.slice(familyBeforeOpen)
					.some(
						(envelope) =>
							envelope._tag === "snapshot" &&
							envelope.rows.some(
								(row) => row.id === childId && row.status === "busy",
							),
					),
			)
			.toBe(true);
		const busySnapshot = family
			.slice(familyBeforeOpen)
			.find(
				(envelope) =>
					envelope._tag === "snapshot" &&
					envelope.rows.some(
						(row) => row.id === childId && row.status === "busy",
					),
			);
		if (busySnapshot?._tag !== "snapshot")
			throw new Error("Missing busy family snapshot");
		await expect
			.poll(() =>
				shell
					.slice(shellBeforeOpen)
					.some((envelope) => envelope._tag === "snapshot"),
			)
			.toBe(true);
		expect(
			shell
				.slice(shellBeforeOpen)
				.flatMap((envelope) =>
					envelope._tag === "snapshot" ? envelope.rows : [],
				)
				.some((row) => row.id === childId),
		).toBe(false);
		await expect(
			page.locator(`#session-list [data-session-id="${childId}"]`),
		).toHaveCount(0);
		await expect(chat.assistantMessages.last()).toContainText(answer);
		await expect(chat.stopBtn).toBeVisible();
		await expect(page.getByTestId("composer-status-header")).toContainText(
			"Working",
		);

		// Only idle crosses this gate. No completion or text is released.
		const familyBeforeIdle = family.length;
		const completionsBeforeIdle = storedFacts(
			harness.eventsDbPath,
		).events.filter(
			(row) =>
				row["session_id"] === childId && row["type"] === "turn.completed",
		).length;
		mockServer.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: childId, status: { type: "idle" } },
			},
		]);
		await expect
			.poll(() =>
				family
					.slice(familyBeforeIdle)
					.some(
						(envelope) =>
							envelope._tag === "upsert" &&
							envelope.sequence > busySnapshot.sequence &&
							envelope.item.id === childId &&
							envelope.item.status === "idle",
					),
			)
			.toBe(true);
		await expect.poll(() => suppressedDone.length).toBeGreaterThan(0);
		await expect(chat.stopBtn).toBeHidden();
		await expect(page.getByTestId("composer-status-header")).toHaveCount(0);
		await expect(page).toHaveURL(new RegExp(`/s/${childId}(?:\\?|$)`));
		expect(
			delivered.filter(
				(message) => message.type === "done" && message.sessionId === childId,
			),
		).toEqual([]);
		expect(
			storedFacts(harness.eventsDbPath).events.filter(
				(row) =>
					row["session_id"] === childId && row["type"] === "turn.completed",
			),
		).toHaveLength(completionsBeforeIdle);
		await attachEvidence(
			testInfo,
			page,
			harness,
			pushes,
			"child-family-idle-cleared-working",
		);
		const evidence = testInfo.outputPath("child-family-idle-feed.json");
		await writeFile(
			evidence,
			JSON.stringify(
				{
					childId,
					completionsBeforeIdle,
					busySnapshot,
					family: family.slice(familyBeforeOpen),
					shell: shell.slice(shellBeforeOpen),
					delivered,
					suppressedDone,
				},
				null,
				2,
			),
		);
		await testInfo.attach("child-family-idle-feed", {
			path: evidence,
			contentType: "application/json",
		});
	});
});

for (const attention of ["permission", "question"] as const) {
	test.describe(`OpenCode Side Thread pending ${attention}`, () => {
		test.use({ recording: `side-thread-${attention}` });
		test.describe.configure({ timeout: 90_000 });
		test(`a pending ${attention} crosses the Side Thread edge to its parent's sidebar`, async ({
			page,
			harness,
			mockServer,
			relayUrl,
		}, testInfo) => {
			const pushes = watchPushes(page);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			const parentId = await completedParent(app, chat, harness, relayUrl);
			const release = mockServer.holdNextPrompt(`${attention}.asked`);
			try {
				await app.sendMessage(
					`$btw ${attention === "permission" ? approvalPrompt : questionPrompt}`,
				);
				await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
				const sideId = sessionId(page);
				await expect
					.poll(() =>
						storedFacts(harness.eventsDbPath).approvals.some(
							(row) =>
								row["session_id"] === sideId &&
								row["type"] === attention &&
								row["status"] === "pending",
						),
					)
					.toBe(true);
				const parentRow = page.locator(
					`#session-list [data-session-id="${parentId}"]`,
				);
				await expect(parentRow).toHaveAccessibleName(
					attention === "permission" ? /^Needs approval/ : /^Needs reply/,
				);
				await expect(parentRow).toContainText(
					attention === "permission" ? "Approve" : "Reply",
				);
				await expect(page.getByTestId("parent-session-status")).toHaveText(
					"Idle",
				);
				await expect(
					page.locator(`#session-list [data-session-id="${sideId}"]`),
				).toHaveCount(0);
				const counter =
					attention === "permission"
						? "pendingPermissionCount"
						: "pendingQuestionCount";
				await expect
					.poll(() => {
						const parent = pushes.family
							.filter((session) => session.id === parentId)
							.at(-1);
						return (parent?.[counter] ?? 0) > 0 && !parent?.processing;
					})
					.toBe(true);
				await attachEvidence(
					testInfo,
					page,
					harness,
					pushes,
					`${attention}-visible-on-parent`,
				);
				release();
				await expect
					.poll(() =>
						storedFacts(harness.eventsDbPath).approvals.some(
							(row) =>
								row["session_id"] === sideId &&
								row["type"] === attention &&
								row["status"] === "pending",
						),
					)
					.toBe(false);
				await expect(parentRow).not.toHaveAccessibleName(
					/^Needs (approval|reply)/,
				);
				await attachEvidence(
					testInfo,
					page,
					harness,
					pushes,
					`${attention}-resolved-on-parent`,
				);
			} finally {
				release();
			}
		});
	});
}
