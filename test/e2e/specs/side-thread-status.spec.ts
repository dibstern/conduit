// Real relay, SQLite projections and browser family pushes over recorded OpenCode.
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Page, TestInfo } from "@playwright/test";
import type { RelayMessage } from "../../../src/lib/shared-types.js";
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

function watchPushes(page: Page): RelayMessage[] {
	const messages: RelayMessage[] = [];
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/ws") return;
		socket.on("framereceived", ({ payload }) => {
			messages.push(JSON.parse(String(payload)) as RelayMessage);
		});
	});
	return messages;
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
	pushes: RelayMessage[],
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
				pushes: pushes.filter((message) =>
					[
						"status",
						"session_family",
						"session_list",
						"permission_request",
						"ask_user",
					].includes(message.type),
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
					pushes.some(
						(message) =>
							message.type === "session_family" &&
							message.sessions.some(
								(session) =>
									session.id === parentId && session.processing === true,
							),
					),
				)
				.toBe(true);
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
				.poll(() =>
					pushes.some(
						(message) =>
							message.type === "session_family" &&
							message.sessions.some(
								(session) =>
									session.id === parentId &&
									session.status === "idle" &&
									!session.processing,
							),
					),
				)
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
					.poll(() =>
						pushes.some(
							(message) =>
								message.type === "session_family" &&
								message.sessions.some(
									(session) =>
										session.id === parentId &&
										(session[counter] ?? 0) > 0 &&
										!session.processing,
								),
						),
					)
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
