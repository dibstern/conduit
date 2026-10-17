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
		const frames: string[] = [];
		page.on("websocket", (ws) =>
			ws.on("framereceived", ({ payload }) => {
				if (typeof payload === "string") frames.push(payload);
			}),
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

		// Prompt B. The recording has no reply for it, so it stays where a real
		// provider sits before reporting busy.
		await app.sendMessage("And again");
		await expect(chat.stopBtn).toBeVisible();

		// A's end is reported again, late.
		const end = recordedTurnEnd();
		const info = end["info"] as Record<string, unknown>;
		mockServer.injectSSEEvents([
			{
				type: "message.updated",
				properties: { ...end, info: { ...info, sessionID: id } },
			},
		]);
		await expect
			.poll(
				() =>
					storedSession(harness.eventsDbPath, id).last_turn_end_version ?? -1,
			)
			.toBeGreaterThan(endedA.last_turn_end_version ?? -1);
		const lateA = storedSession(harness.eventsDbPath, id);
		await expect
			.poll(() =>
				frames.some((frame) =>
					frame.includes(
						`"lastTurnEndVersion":${String(lateA.last_turn_end_version)}`,
					),
				),
			)
			.toBe(true);
		await page.waitForTimeout(500);
		const workingAfterLateEnd = await chat.stopBtn.isVisible();
		await page.screenshot({ path: testInfo.outputPath("after-late-end.png") });

		// B starts, then its own end finishes it.
		const row = page.locator(`#session-list [data-session-id="${id}"]`);
		mockServer.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: id, status: { type: "busy" } },
			},
		]);
		await expect(row).toHaveAccessibleName(/^Working/);
		await expect
			.poll(() =>
				mockServer.requestBodies.some(
					(request) =>
						request.path.endsWith("/prompt_async") &&
						request.body.includes("And again"),
				),
			)
			.toBe(true);
		// The recording has no second reply, so supply B's user echo and end.
		const userMessageId = "msg_turn_b_user";
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
		writeFileSync(
			testInfo.outputPath("late-turn-end.json"),
			JSON.stringify(
				{
					sessionId: id,
					endedA,
					lateA,
					endedB: storedSession(harness.eventsDbPath, id),
					workingAfterLateEnd,
				},
				null,
				2,
			),
		);
		await expect(chat.stopBtn).toBeHidden();
		// The late end names A's send, not B's.
		expect(endedA.last_turn_end_input_id).toEqual(expect.any(String));
		expect(lateA.last_turn_end_input_id).toBe(endedA.last_turn_end_input_id);
		expect(workingAfterLateEnd).toBe(true);
	});
});
