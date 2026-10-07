// A Side Thread started while its parent is mid-turn forks at the parent's
// last completed turn: no dangling tool call, no turn that never ends, and the
// parent's turn keeps running. Real relay and event store; Claude SDK turns
// replay committed traces, OpenCode REST/SSE replays a real capture.

import { DatabaseSync } from "node:sqlite";
import { readNativeThread } from "../../helpers/native-thread.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const parentPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const question =
	"What word did I ask you to remember? Reply with only the word.";

function query(dbPath: string, sql: string, ...params: string[]) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params);
	} finally {
		db.close();
	}
}

function sessionEvents(dbPath: string, sessionId: string) {
	return query(
		dbPath,
		"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
		sessionId,
	).map((row) => ({
		type: String(row["type"]),
		payload: JSON.parse(String(row["data"])) as Record<string, unknown>,
	}));
}

function messages(dbPath: string, sessionId: string) {
	return query(
		dbPath,
		"SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at, id",
		sessionId,
	).map((row) => ({ role: String(row["role"]), text: String(row["text"]) }));
}

const lastStatus = (events: ReturnType<typeof sessionEvents>) =>
	events.filter((event) => event.type === "session.status").at(-1)?.payload[
		"status"
	];

test.describe("Claude Side Thread started mid-turn", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});
	test.use({
		claudeReplay: {
			turns: [
				"pong-thinking-text-turn",
				"extra-folder-read-turn",
				"side-thread-plan-turn",
			],
			holdTurnBeforeToolResult: 2,
		},
	});

	test("forks at the last completed turn while the parent's turn runs on", async ({
		page,
		relayUrl,
		harness,
	}) => {
		test.setTimeout(90_000);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("Claude replay lane is not wired");
		const db = harness.eventsDbPath;
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		const parentId = new URL(page.url()).pathname.split("/").at(-1);
		if (!parentId) throw new Error("Parent session route is missing");

		await app.sendMessage(parentPrompt);
		await expect(chat.assistantMessages).toHaveText([/pong/i]);
		await chat.waitForStreamingComplete();
		const sdkParentId = async () =>
			(await readNativeThread(db, parentId))?.resumeSessionId;
		await expect.poll(sdkParentId).toBeTruthy();
		const firstTurnEnd = sessionEvents(db, parentId).find(
			(event) => event.type === "turn.completed",
		)?.payload["messageId"];
		expect(firstTurnEnd).toEqual(expect.any(String));

		// The second turn stops before its Read result: running, unanswered.
		await app.sendMessage("Read the marker file.");
		await expect
			.poll(() => {
				const events = sessionEvents(db, parentId);
				return {
					status: lastStatus(events),
					started: events.some((event) => event.type === "tool.started"),
					completed: events.some((event) => event.type === "tool.completed"),
				};
			})
			.toEqual({ status: "busy", started: true, completed: false });
		await expect(chat.stopBtn).toBeVisible();

		await app.input.fill(`$btw ${question}`);
		await app.input.press("Enter");
		await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		const sideId = new URL(page.url()).pathname.split("/").at(-1);
		if (!sideId) throw new Error("Side Thread route is missing");
		await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
		await chat.waitForStreamingComplete();

		// The SDK fork cut lands on the last transcript entry of turn one.
		const parentTranscript = replayer.transcript(String(await sdkParentId()));
		const secondPrompt = parentTranscript.findIndex(
			(entry, index) => index > 0 && entry.type === "user",
		);
		expect(secondPrompt).toBeGreaterThan(0);
		expect(replayer.forks).toEqual([
			{
				parentSessionId: await sdkParentId(),
				sessionId: sideId,
				upToMessageId: parentTranscript[secondPrompt - 1]?.uuid,
			},
		]);
		expect(replayer.sentPermissionModes).toEqual([
			"default",
			"default",
			"plan",
		]);

		// History ends at turn one; the Side Thread is idle with no tool call.
		const sideEvents = sessionEvents(db, sideId);
		expect(
			sideEvents.find((event) => event.type === "session.created")?.payload,
		).toMatchObject({
			parentId,
			sideThread: true,
			forkPointMessageId: firstTurnEnd,
		});
		expect(sideEvents.some((event) => event.type.startsWith("tool."))).toBe(
			false,
		);
		expect(lastStatus(sideEvents)).toBe("idle");
		const sideMessages = messages(db, sideId);
		expect(
			sideMessages.filter((row) => row.role === "user").map((row) => row.text),
		).toEqual([parentPrompt, question]);
		expect(JSON.stringify(sideMessages)).not.toContain("CONDUIT-EXTRA-FOLDER");
		await expect(chat.stopBtn).toBeHidden();

		// The parent's turn was untouched and finishes once released, in the
		// background; reopening it then shows it done, not still working.
		expect(lastStatus(sessionEvents(db, parentId))).toBe("busy");
		replayer.release();
		await expect
			.poll(() => {
				const events = sessionEvents(db, parentId);
				return {
					status: lastStatus(events),
					turns: events.filter((event) => event.type === "turn.completed")
						.length,
					toolCompleted: events.some(
						(event) => event.type === "tool.completed",
					),
				};
			})
			.toEqual({ status: "idle", turns: 2, toolCompleted: true });
		await chat.subagentBackBtn.click();
		await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		await expect(chat.assistantMessages.last()).toContainText(
			"CONDUIT-EXTRA-FOLDER-MARKER-7f3a",
		);
		await expect(chat.stopBtn).toBeHidden();
		expect(
			messages(db, parentId)
				.filter((row) => row.role === "user")
				.map((row) => row.text),
		).not.toContain(question);
	});
});

test.describe("OpenCode Side Thread started mid-turn", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});
	// Recorded by test/e2e/scripts/capture-side-thread-status.ts mid-turn.
	test.use({ recording: "side-thread-mid-turn" });

	test("forks before the in-flight prompt while the parent's tool runs", async ({
		page,
		relayUrl,
		harness,
		mockServer,
	}) => {
		test.setTimeout(90_000);
		const db = harness.eventsDbPath;
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		const parentId = new URL(page.url()).pathname.split("/").at(-1);
		if (!parentId) throw new Error("Parent session route is missing");

		await app.sendMessage(parentPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			/ok, remembered/i,
		);
		await expect
			.poll(() => lastStatus(sessionEvents(db, parentId)))
			.toBe("idle");
		await chat.waitForStreamingComplete();

		// The recording stops in the parent's running bash call until the Side
		// Thread prompts, as it did live.
		await app.sendMessage(
			"Use the bash tool to run: sleep 10; printf mid-turn-marker. Then reply with only its output.",
		);
		await expect
			.poll(() => {
				const events = sessionEvents(db, parentId);
				return {
					status: lastStatus(events),
					started: events.some((event) => event.type === "tool.started"),
					completed: events.some((event) => event.type === "tool.completed"),
				};
			})
			.toEqual({ status: "busy", started: true, completed: false });
		const inFlight = sessionEvents(db, parentId)
			.filter(
				(event) =>
					event.type === "message.created" && event.payload["role"] === "user",
			)
			.at(-1)?.payload["messageId"];
		expect(inFlight).toEqual(expect.any(String));

		await app.input.fill(`$btw ${question}`);
		await app.input.press("Enter");
		await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		const sideId = new URL(page.url()).pathname.split("/").at(-1);
		if (!sideId) throw new Error("Side Thread route is missing");
		await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
		await chat.waitForStreamingComplete();

		// OpenCode copies the messages before messageID: the in-flight prompt.
		const fork = mockServer.requestBodies.find(
			(request) =>
				request.method === "POST" &&
				request.path === `/session/${parentId}/fork`,
		);
		expect(JSON.parse(fork?.body ?? "null")).toEqual({ messageID: inFlight });
		const sideEvents = sessionEvents(db, sideId);
		expect(sideEvents.some((event) => event.type.startsWith("tool."))).toBe(
			false,
		);
		expect(lastStatus(sideEvents)).toBe("idle");
		const sideMessages = messages(db, sideId);
		expect(
			sideMessages.filter((row) => row.role === "user").map((row) => row.text),
		).toEqual([parentPrompt, question]);
		expect(JSON.stringify(sideMessages)).not.toContain("mid-turn-marker");
		await expect(chat.stopBtn).toBeHidden();

		// The parent's turn finishes; reopening it shows it done.
		await expect
			.poll(() => {
				const events = sessionEvents(db, parentId);
				return {
					status: lastStatus(events),
					toolCompleted: events.some(
						(event) => event.type === "tool.completed",
					),
				};
			})
			.toEqual({ status: "idle", toolCompleted: true });
		await chat.subagentBackBtn.click();
		await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		await expect(chat.assistantMessages.last()).toContainText(
			"mid-turn-marker",
		);
		await expect(chat.stopBtn).toBeHidden();
		expect(
			messages(db, parentId)
				.filter((row) => row.role === "user")
				.map((row) => row.text),
		).not.toContain(question);
	});
});
