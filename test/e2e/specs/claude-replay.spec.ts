// Claude sessions whose SDK turns replay committed Claude SDK traces through
// the runtime's injected queryFactory (see helpers/claude-trace-replayer.ts).
// The replay fixture fails the test unless exactly the planned turns are sent.

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

function countEvents(dbPath: string | undefined, type: string): number {
	if (!dbPath) throw new Error("Claude replay harness has no event store");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?")
			.get(type);
		return Number(row?.["n"]);
	} finally {
		db.close();
	}
}

test.describe("Claude replay lane", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});

	test.describe("same trace three times", () => {
		test.use({
			claudeReplay: {
				turns: [
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
				],
			},
		});

		test("yields three turn ends", async ({
			page,
			relayUrl,
			harness,
			claudeReplay,
		}, testInfo) => {
			const prompts = ["One", "Two", "Three"];
			expect(claudeReplay?.turns).toHaveLength(prompts.length);
			const sessionId = decodeURIComponent(
				harness.projectUrl.slice("/s/".length),
			);
			const sends: { commandId: string; sessionId: string; text: string }[] =
				[];
			// Register before navigation so even the first RPC socket is observed.
			page.on("websocket", (ws) => {
				ws.on("framesent", ({ payload }) => {
					if (typeof payload !== "string") return;
					const frame: {
						_tag?: string;
						tag?: string;
						payload?: {
							commandId?: unknown;
							sessionId?: unknown;
							text?: unknown;
						};
					} = JSON.parse(payload);
					if (frame?._tag !== "Request" || frame.tag !== "SendMessage") return;
					const input = frame.payload;
					if (
						typeof input?.commandId === "string" &&
						typeof input.sessionId === "string" &&
						typeof input.text === "string"
					) {
						sends.push({
							commandId: input.commandId,
							sessionId: input.sessionId,
							text: input.text,
						});
					}
				});
			});
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			for (const [index, text] of prompts.entries()) {
				await app.sendMessage(text);
				await expect.poll(() => sends.length).toBe(index + 1);
				expect(sends[index]).toMatchObject({ sessionId, text });
				expect(sends[index]?.commandId).toMatch(/\S/);
				await expect(chat.assistantMessages).toHaveCount(index + 1);
				await chat.waitForStreamingComplete();
			}

			await expect(chat.assistantMessages).toHaveText([
				/pong/i,
				/pong/i,
				/pong/i,
			]);
			await expect
				.poll(() => countEvents(harness.eventsDbPath, "turn.completed"))
				.toBe(prompts.length);
			expect(sends).toHaveLength(prompts.length);
			expect(new Set(sends.map(({ commandId }) => commandId)).size).toBe(
				prompts.length,
			);

			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				// Canonical completions name the assistant message. Its turn_id
				// links the completion back to this browser input in the same session.
				const stored = db.prepare(`
					SELECT outbox.command_id, outbox.session_id, user.id AS user_message_id,
						user.text, turn.id AS turn_id, turn.user_message_id AS turn_user_message_id,
						assistant.id AS assistant_message_id, assistant.turn_id AS completed_turn_id,
						completion.sequence AS completion_sequence
					FROM provider_command_outbox outbox
					JOIN messages user ON user.id = outbox.command_id
						AND user.session_id = outbox.session_id AND user.role = 'user'
					JOIN turns turn ON turn.user_message_id = user.id AND turn.session_id = user.session_id
					JOIN messages assistant ON assistant.id = turn.assistant_message_id
						AND assistant.session_id = turn.session_id AND assistant.role = 'assistant'
					JOIN events completion ON completion.session_id = turn.session_id
						AND completion.type = 'turn.completed'
						AND json_extract(completion.data, '$.messageId') = assistant.id
					WHERE outbox.command_id = ? AND outbox.session_id = ?
						AND outbox.effect_type = 'send_turn' AND turn.state = 'completed'
				`);
				const proof = sends.map((send) => ({
					...send,
					rows: stored.all(send.commandId, send.sessionId),
				}));
				await testInfo.attach("input-id-proof.json", {
					body: JSON.stringify(
						{ traces: claudeReplay?.turns, inputs: proof },
						null,
						2,
					),
					contentType: "application/json",
				});
				for (const { commandId, sessionId, text, rows } of proof) {
					expect(
						rows,
						`Stored identity for browser input ${commandId}`,
					).toEqual([
						{
							command_id: commandId,
							session_id: sessionId,
							user_message_id: commandId,
							text,
							turn_id: commandId,
							turn_user_message_id: commandId,
							assistant_message_id: expect.any(String),
							completed_turn_id: commandId,
							completion_sequence: expect.any(Number),
						},
					]);
				}
			} finally {
				db.close();
			}
		});
	});

	test.describe("sub-agent trace", () => {
		test.use({ claudeReplay: { turns: ["subagent-task-turn"] } });

		test("replays a Task sub-agent turn", async ({ page, relayUrl }) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			await app.sendMessage("Ask a subagent to summarise package.json");
			await chat.waitForAssistantMessage();
			await chat.waitForStreamingComplete();

			// The Task sub-agent lands in the (collapsed) turn activity summary.
			await expect(chat.turnActivityToggles.last()).toContainText("1 subagent");
			expect(await chat.getLastAssistantText()).toContain(
				"The subagent reports",
			);
		});
	});
});
