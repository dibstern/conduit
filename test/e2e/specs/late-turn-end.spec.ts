// A turn's end can only finish that same turn (conduit-test-jyr9.10). OpenCode
// reports a turn ending on every completed message.updated, separately from its
// idle status, so an earlier turn's end can land after the next prompt is sent.
// Real relay, SQLite projections and browser over recorded OpenCode.

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { loadOpenCodeRecording } from "../helpers/recorded-loader.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

// One recorded prompt, so a second one gets no reply until the test sends it.
const recording = "chat-streaming";
test.use({ recording });

function sessionId(page: Page): string {
	const id = new URL(page.url()).pathname.split("/").at(-1);
	if (!id) throw new Error("Session route is missing");
	return id;
}

function storedSession(dbPath: string, id: string) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT status, last_turn_end_version, last_turn_end_input_id FROM sessions WHERE id = ?",
			)
			.get(id) as {
			status: string;
			last_turn_end_version: number | null;
			last_turn_end_input_id: string | null;
		};
	} finally {
		db.close();
	}
}

function terminalCount(dbPath: string, id: string, messageId: string): number {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return Number(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'turn.completed' AND json_extract(data, '$.messageId') = ?",
				)
				.get(id, messageId)?.["n"],
		);
	} finally {
		db.close();
	}
}

/** The recorded reply's final message.updated: the event that ends turn A. */
function recordedTurnEnd(): Record<string, unknown> {
	const ends = loadOpenCodeRecording(recording).interactions.flatMap((ix) => {
		if (ix.kind !== "sse" || ix.type !== "message.updated") return [];
		const info = ix.properties["info"] as
			| { role?: string; time?: { completed?: number } }
			| undefined;
		return info?.role === "assistant" && info.time?.completed != null
			? [ix.properties]
			: [];
	});
	const end = ends.at(-1);
	if (!end) throw new Error(`${recording} has no completed assistant message`);
	return end;
}

test.describe("Late turn end", () => {
	test.describe.configure({ timeout: 60_000 });

	test("an earlier turn's late end leaves the next prompt working until its own end", async ({
		page,
		relayUrl,
		harness,
		mockServer,
	}, testInfo) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Runs on the desktop viewport only",
		);
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		// Turn A runs and ends.
		await app.sendMessage("Stream a response");
		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();
		const id = sessionId(page);
		await expect
			.poll(() => storedSession(harness.eventsDbPath, id).status)
			.toBe("idle");
		const endedA = storedSession(harness.eventsDbPath, id);

		// The recording has no second reply. Accept B and hold its terminal event.
		await app.sendMessage("And again");
		await expect(chat.stopBtn).toBeVisible();
		await expect
			.poll(() =>
				mockServer.requestBodies.some(
					(request) =>
						request.path.endsWith("/prompt_async") &&
						request.body.includes("And again"),
				),
			)
			.toBe(true);
		const request = mockServer.requestBodies.find(
			(request) =>
				request.path.endsWith("/prompt_async") &&
				request.body.includes("And again"),
		);
		const { messageID: userMessageId } = JSON.parse(request?.body ?? "{}") as {
			messageID?: string;
		};
		if (!userMessageId)
			throw new Error("B has no reserved provider message ID");
		const row = page.locator(`#session-list [data-session-id="${id}"]`);
		mockServer.injectSSEEvents([
			{
				type: "message.updated",
				properties: {
					info: {
						id: userMessageId,
						role: "user",
						sessionID: id,
						time: { created: Date.now() },
					},
				},
			},
			{
				type: "session.status",
				properties: { sessionID: id, status: { type: "busy" } },
			},
		]);
		await expect(row).toHaveAccessibleName(/^Working/);

		// A's duplicate is ingested while B remains the active run.
		const end = recordedTurnEnd();
		const info = end["info"] as Record<string, unknown>;
		const assistantId = String(info["id"]);
		const beforeDuplicate = terminalCount(
			harness.eventsDbPath,
			id,
			assistantId,
		);
		expect(beforeDuplicate).toBeGreaterThan(0);
		mockServer.injectSSEEvents([
			{
				type: "message.updated",
				properties: { ...end, info: { ...info, sessionID: id } },
			},
		]);
		await expect
			.poll(() => terminalCount(harness.eventsDbPath, id, assistantId))
			.toBeGreaterThan(beforeDuplicate);
		const lateA = storedSession(harness.eventsDbPath, id);
		expect(lateA.status).toBe("busy");
		expect(lateA.last_turn_end_version).toBe(endedA.last_turn_end_version);
		expect(lateA.last_turn_end_input_id).toBe(endedA.last_turn_end_input_id);
		// Observe a later shell row before checking the browser's working state.
		mockServer.injectSSEEvents([
			{
				type: "session.updated",
				properties: { info: { id, title: "Late end reconciled" } },
			},
		]);
		await expect(row).toContainText("Late end reconciled");
		await expect(chat.stopBtn).toBeVisible();
		await expect(row).toHaveAccessibleName(/^Working/);
		const workingAfterLateEnd = await chat.stopBtn.isVisible();
		await page.screenshot({ path: testInfo.outputPath("after-late-end.png") });

		// Only B's own terminal boundary may finish it.
		mockServer.injectSSEEvents([
			{
				type: "message.updated",
				properties: {
					...end,
					info: {
						...info,
						id: "msg_turn_b_end",
						parentID: userMessageId,
						sessionID: id,
					},
				},
			},
			{
				type: "session.status",
				properties: { sessionID: id, status: { type: "idle" } },
			},
		]);
		await expect
			.poll(() => storedSession(harness.eventsDbPath, id).last_turn_end_version)
			.toBeGreaterThan(lateA.last_turn_end_version ?? -1);
		const endedB = storedSession(harness.eventsDbPath, id);
		expect(endedB.status).toBe("idle");
		writeFileSync(
			testInfo.outputPath("late-turn-end.json"),
			JSON.stringify(
				{
					sessionId: id,
					endedA,
					lateA,
					endedB,
					workingAfterLateEnd,
				},
				null,
				2,
			),
		);
		await expect(chat.stopBtn).toBeHidden();
		await expect(row).not.toHaveAccessibleName(/^Working/);
		expect(endedA.last_turn_end_input_id).toEqual(expect.any(String));
		expect(lateA.last_turn_end_input_id).toBe(endedA.last_turn_end_input_id);
		expect(endedB.last_turn_end_input_id).toEqual(expect.any(String));
		expect(endedB.last_turn_end_input_id).not.toBe(
			endedA.last_turn_end_input_id,
		);
		expect(workingAfterLateEnd).toBe(true);
	});
});
