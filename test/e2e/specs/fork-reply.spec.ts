// Forking from a reply keeps that reply: OpenCode's fork is cut after it, so
// the fork holds the first turn and nothing of the second. The fork point is
// the fork's own copy of the reply, so the prior context block holds exactly
// that turn. OpenCode REST/SSE replays a real capture.

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const firstPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const secondPrompt =
	"Now remember the word 'beta' too. Reply with only: ok, remembered.";
const forkPrompt =
	"Which words did I ask you to remember? Reply with only the words.";

function query(dbPath: string, sql: string, ...params: string[]) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params);
	} finally {
		db.close();
	}
}

function messages(dbPath: string, sessionId: string) {
	return query(
		dbPath,
		"SELECT id, role, text, created_at FROM messages WHERE session_id = ? ORDER BY created_at, id",
		sessionId,
	).map((row) => ({
		id: String(row["id"]),
		role: String(row["role"]),
		text: String(row["text"]),
		createdAt: Number(row["created_at"]),
	}));
}

test.describe("OpenCode fork from a reply", () => {
	test.use({ recording: "fork-reply" });
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});

	test("keeps the reply and drops the later turn", async ({
		page,
		relayUrl,
		harness,
		mockServer,
	}) => {
		test.setTimeout(90_000);
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const db = harness.eventsDbPath;
		await app.goto(relayUrl);
		const parentId = new URL(page.url()).pathname.split("/").at(-1);
		if (!parentId) throw new Error("Parent session route is missing");

		await app.sendMessage(firstPrompt);
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();
		await app.sendMessage(secondPrompt);
		await expect(chat.assistantMessages).toHaveCount(2, { timeout: 30_000 });
		await chat.waitForStreamingComplete();
		await expect
			.poll(() => messages(db, parentId).map((message) => message.role))
			.toEqual(["user", "assistant", "user", "assistant"]);
		const parentHistory = messages(db, parentId);
		const firstReply = parentHistory[1];
		const secondTurn = parentHistory[2];
		if (!firstReply || !secondTurn) throw new Error("Parent turns missing");

		const reply = chat.assistantMessages.first();
		await reply.hover();
		await reply.getByRole("button", { name: "Fork from here" }).click();
		await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
		const forkId = new URL(page.url()).pathname.split("/").at(-1);
		if (!forkId) throw new Error("Fork session route is missing");

		// OpenCode copies the messages before messageID: everything through the reply.
		const fork = mockServer.requestBodies.find(
			(request) =>
				request.method === "POST" &&
				request.path === `/session/${parentId}/fork`,
		);
		expect(JSON.parse(fork?.body ?? "null")).toEqual({
			messageID: secondTurn.id,
		});

		await app.sendMessage(forkPrompt);
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();
		await expect
			.poll(() =>
				messages(db, forkId).map(({ role, text }) => ({ role, text })),
			)
			.toEqual([
				{ role: "user", text: firstPrompt },
				{ role: "assistant", text: firstReply.text },
				{ role: "user", text: forkPrompt },
				{ role: "assistant", text: expect.stringContaining("alpha") },
			]);
		expect(JSON.stringify(messages(db, forkId))).not.toContain("beta'");

		// The fork point is the fork's own copy of the reply, read from the fork
		// itself: no parent lookup, no fallback, no warning.
		const forkCopy = messages(db, forkId)[1];
		const [row] = query(
			db,
			"SELECT fork_point_event, fork_point_timestamp FROM sessions WHERE id = ?",
			forkId,
		);
		expect(row?.["fork_point_event"]).toBe(forkCopy?.id);
		expect(row?.["fork_point_event"]).not.toBe(firstReply.id);
		expect(row?.["fork_point_timestamp"]).toBe(forkCopy?.createdAt);

		// The inherited turn sits in the prior context; the new turn after it.
		await expect(page.locator(".fork-divider")).toContainText("Forked from");
		const toggle = page.locator(".fork-context-toggle");
		await expect(toggle).toContainText("Prior conversation");
		await toggle.click();
		const inherited = page.locator(".fork-context-messages");
		await expect(inherited).toBeVisible();
		await expect(inherited.locator(".msg-user")).toHaveCount(1);
		await expect(inherited.locator(".msg-user")).toContainText(firstPrompt);
		await expect(inherited.locator(".msg-assistant")).toHaveCount(1);
		await expect(inherited.locator(".msg-assistant")).toContainText(
			firstReply.text,
		);
		await expect(inherited).not.toContainText("beta");
		await expect(chat.userMessages).toHaveCount(2);
		await expect(chat.userMessages.last()).toContainText(forkPrompt);
		await expect(chat.assistantMessages.last()).toContainText("alpha");
	});
});
