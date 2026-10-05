// Claude sessions whose SDK turns replay committed Claude SDK traces through
// the runtime's injected queryFactory (see helpers/claude-trace-replayer.ts).
// The replay fixture fails the test unless exactly the planned turns are sent.

import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
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

type Send = { commandId: string; sessionId: string; text: string };

/** Records the browser's input.submit requests. Register before navigation so
 *  even the first RPC socket is observed. */
function recordSends(page: Page): Send[] {
	const sends: Send[] = [];
	page.on("websocket", (ws) => {
		ws.on("framesent", ({ payload }) => {
			if (typeof payload !== "string") return;
			const frame: {
				_tag?: string;
				tag?: string;
				payload?: {
					inputId?: unknown;
					sessionId?: unknown;
					text?: unknown;
				};
			} = JSON.parse(payload);
			if (frame?._tag !== "Request" || frame.tag !== "input.submit") return;
			const input = frame.payload;
			if (
				typeof input?.inputId === "string" &&
				typeof input.sessionId === "string" &&
				typeof input.text === "string"
			) {
				sends.push({
					commandId: input.inputId,
					sessionId: input.sessionId,
					text: input.text,
				});
			}
		});
	});
	return sends;
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
			const sends = recordSends(page);
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
						user.input_id, user.text, turn.id AS turn_id, turn.user_message_id AS turn_user_message_id,
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
							input_id: commandId,
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

	test.describe("two browsers sending identical text", () => {
		test.use({
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
			},
		});

		test("each browser's send is placed once, tagged with its own input id", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			const sessionId = decodeURIComponent(
				harness.projectUrl.slice("/s/".length),
			);
			const context = await browser.newContext({
				viewport: page.viewportSize(),
			});
			try {
				const pages = [page, await context.newPage()];
				const sends = pages.map(recordSends);
				const apps = pages.map((p) => new AppPage(p));
				const chats = pages.map((p) => new ChatPage(p));
				for (const app of apps) await app.goto(relayUrl);

				// Sent back to back, the second send normally lands mid-turn, so the runner
				// holds it and places it when the SDK reports it started.
				for (const app of apps) await app.sendMessage("Same");
				for (const recorded of sends) {
					await expect.poll(() => recorded.length).toBe(1);
				}
				await expect
					.poll(() => countEvents(harness.eventsDbPath, "turn.completed"))
					.toBe(2);
				for (const chat of chats) {
					await chat.waitForStreamingComplete();
					await expect(chat.userMessages).toHaveText([/\bSame\b/, /\bSame\b/]);
					await expect(chat.assistantMessages).toHaveText([/pong/i, /pong/i]);
				}

				const commandIds = sends.map((recorded) => recorded[0]?.commandId);
				const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
				try {
					const rows = db
						.prepare(
							`SELECT id, input_id, text FROM messages
							WHERE session_id = ? AND role = 'user'`,
						)
						.all(sessionId);
					await testInfo.attach("two-browser-input-id-proof.json", {
						body: JSON.stringify({ commandIds, rows }, null, 2),
						contentType: "application/json",
					});
					expect(rows).toHaveLength(2);
					expect(rows).toEqual(
						expect.arrayContaining(
							commandIds.map((id) => ({ id, input_id: id, text: "Same" })),
						),
					);
				} finally {
					db.close();
				}
			} finally {
				await context.close();
			}
		});
	});

	test.describe("two inputs, the second sent mid-turn", () => {
		// Recorded through conduit, whose turn gate holds the mid-turn send until
		// the first turn ends, so the trace queues input 2 after result 1. The
		// replayer holds that queued frame until conduit pushes the second prompt.
		// The delay keeps the first turn running long enough to send into it.
		test.use({
			claudeReplay: { turns: ["second-input-held-to-turn-end"], delayMs: 60 },
		});

		test("both inputs are answered in order, each tagged with its command id", async ({
			page,
			relayUrl,
			harness,
		}, testInfo) => {
			const sessionId = decodeURIComponent(
				harness.projectUrl.slice("/s/".length),
			);
			const sends = recordSends(page);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			await app.sendMessage("First");
			await chat.waitForToolBlock();
			await expect(chat.stopBtn).toBeVisible();
			await app.sendMessage("Second");
			await expect.poll(() => sends.length).toBe(2);
			expect(countEvents(harness.eventsDbPath, "turn.completed")).toBe(0);

			await expect
				.poll(() => countEvents(harness.eventsDbPath, "turn.completed"))
				.toBe(2);
			await chat.waitForStreamingComplete();
			await expect(chat.userMessages).toHaveText([/\bFirst\b/, /\bSecond\b/]);
			await expect(chat.assistantMessages).toHaveText([/A-DONE/, /pong/i]);

			const commandIds = sends.map((send) => send.commandId);
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				const rows = db
					.prepare(
						`SELECT id, input_id, text FROM messages
						WHERE session_id = ? AND role = 'user' ORDER BY rowid`,
					)
					.all(sessionId);
				await testInfo.attach("two-input-id-proof.json", {
					body: JSON.stringify({ commandIds, rows }, null, 2),
					contentType: "application/json",
				});
				expect(rows).toEqual([
					{ id: commandIds[0], input_id: commandIds[0], text: "First" },
					{ id: commandIds[1], input_id: commandIds[1], text: "Second" },
				]);
			} finally {
				db.close();
			}
		});
	});

	test.describe("inputs sent mid-turn queue behind it", () => {
		// The delay keeps A's turn running while B and C are sent into it.
		test.use({
			claudeReplay: {
				turns: [
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
				],
				delayMs: 100,
			},
		});

		test("each queued input is handed off only after the turn before it ends", async ({
			page,
			relayUrl,
			harness,
		}, testInfo) => {
			const sessionId = decodeURIComponent(
				harness.projectUrl.slice("/s/".length),
			);
			const dbPath = harness.eventsDbPath;
			if (!dbPath) throw new Error("Claude replay harness has no event store");
			const query = <T>(sql: string, ...params: string[]): T[] => {
				const db = new DatabaseSync(dbPath, { readOnly: true });
				try {
					return db.prepare(sql).all(...params) as T[];
				} finally {
					db.close();
				}
			};
			const sends = recordSends(page);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			await app.sendMessage("Alpha");
			await expect(chat.stopBtn).toBeVisible();
			await app.sendMessage("Bravo");
			await app.sendMessage("Charlie");
			await expect.poll(() => sends.length).toBe(3);
			await expect.poll(() => countEvents(dbPath, "input.admitted")).toBe(3);
			const [a, b, c] = sends.map((send) => send.commandId);

			// While A runs, B and C are admitted but have no outbox row.
			expect(countEvents(dbPath, "turn.completed")).toBe(0);
			expect(
				query(
					"SELECT command_id FROM provider_command_outbox WHERE command_id IN (?, ?)",
					b ?? "",
					c ?? "",
				),
			).toEqual([]);

			await expect.poll(() => countEvents(dbPath, "turn.completed")).toBe(3);
			await chat.waitForStreamingComplete();
			await expect(chat.userMessages).toHaveText([
				/\bAlpha\b/,
				/\bBravo\b/,
				/\bCharlie\b/,
			]);
			await expect(chat.assistantMessages).toHaveText([
				/pong/i,
				/pong/i,
				/pong/i,
			]);

			const events = query<{ type: string; input_id: string | null }>(
				`SELECT type, json_extract(data, '$.inputId') AS input_id FROM events
				WHERE session_id = ?
					AND type IN ('input.admitted', 'input.sent', 'turn.completed')
				ORDER BY sequence`,
				sessionId,
			);
			const outbox = query<{ command_id: string; payload_json: string }>(
				`SELECT command_id, payload_json FROM provider_command_outbox
				WHERE session_id = ? AND effect_type = 'send_turn'
				ORDER BY request_sequence`,
				sessionId,
			);
			const turns = query<{ id: string; state: string }>(
				`SELECT id, state FROM turns WHERE session_id = ?
				ORDER BY requested_at, rowid`,
				sessionId,
			);
			const [admittedB] = query<{ data: string }>(
				`SELECT data FROM events
				WHERE type = 'input.admitted' AND json_extract(data, '$.inputId') = ?`,
				b ?? "",
			);
			await testInfo.attach("queue-proof.json", {
				body: JSON.stringify(
					{ inputs: { a, b, c }, events, outbox, turns, admittedB },
					null,
					2,
				),
				contentType: "application/json",
			});

			const inputIdsOf = (type: string) =>
				events
					.filter((event) => event.type === type)
					.map((event) => event.input_id);
			expect(inputIdsOf("input.admitted")).toEqual([a, b, c]);
			expect(inputIdsOf("input.sent")).toEqual([a, b, c]);
			// Each handoff (and its outbox row, committed with it) follows the end
			// of the turn before it.
			expect(
				events
					.filter((event) => event.type !== "input.admitted")
					.map((event) => event.type),
			).toEqual([
				"input.sent",
				"turn.completed",
				"input.sent",
				"turn.completed",
				"input.sent",
				"turn.completed",
			]);
			expect(outbox.map((row) => row.command_id)).toEqual([a, b, c]);
			expect(turns).toEqual([
				{ id: a, state: "completed" },
				{ id: b, state: "completed" },
				{ id: c, state: "completed" },
			]);

			// B is handed off with the selection it was queued with. The admitted
			// request carries the browser's model shape; the outbox, the provider's.
			const queued: {
				request: {
					model?: { providerID: string; modelID: string };
					agent?: string;
					variant?: string;
				};
			} = JSON.parse(admittedB?.data ?? "{}");
			const handed: {
				model?: { providerId: string; modelId: string };
				agent?: string;
				variant?: string;
			} = JSON.parse(outbox[1]?.payload_json ?? "{}");
			expect(queued.request.model).toBeDefined();
			expect({
				model: handed.model && {
					providerID: handed.model.providerId,
					modelID: handed.model.modelId,
				},
				agent: handed.agent,
				variant: handed.variant,
			}).toEqual({
				model: queued.request.model,
				agent: queued.request.agent,
				variant: queued.request.variant,
			});
		});
	});

	test.describe("the pending-input tray", () => {
		// 20 messages a turn at 500ms keeps Alpha's turn running for ~10s: long
		// enough to queue two inputs, reload and open a second browser in it.
		test.use({
			claudeReplay: {
				turns: [
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
				],
				delayMs: 500,
			},
		});

		test("shows inputs queued mid-turn until each starts, across reloads and browsers", async ({
			page,
			browser,
			relayUrl,
			harness,
		}, testInfo) => {
			test.setTimeout(120_000);
			const turnsCompleted = () =>
				countEvents(harness.eventsDbPath, "turn.completed");
			const trayRows = (p: Page) =>
				p.locator('[data-testid="pending-input-row"]');
			const trayTexts = (p: Page) =>
				trayRows(p).locator('[data-testid="pending-input-text"]');
			// Every text the tray ever showed in this page load.
			await page.addInitScript(() => {
				const seen = new Set<string>();
				Object.assign(window, { __seenPending: seen });
				new MutationObserver(() => {
					for (const el of document.querySelectorAll(
						'[data-testid="pending-input-text"]',
					)) {
						seen.add(el.textContent ?? "");
					}
				}).observe(document, {
					childList: true,
					subtree: true,
					characterData: true,
				});
			});
			const seenPending = () =>
				page.evaluate(() =>
					[
						...(window as unknown as { __seenPending: Set<string> })
							.__seenPending,
					].sort(),
				);
			const sends = recordSends(page);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			// An idle send is placed at once: its message shows long before the
			// reply, and it never passes through the tray.
			await app.input.fill("Alpha");
			await expect(app.sendBtn).toHaveAccessibleName("Send");
			await app.sendBtn.click();
			await expect(chat.userMessages).toHaveText([/\bAlpha\b/]);
			expect(turnsCompleted()).toBe(0);

			await expect(chat.stopBtn).toBeVisible();
			await app.input.fill("Bravo");
			await expect(app.sendBtn).toHaveAccessibleName("Queue message");
			await app.sendBtn.click();
			await app.sendMessage("Charlie");
			await expect.poll(() => sends.length).toBe(3);
			const [a, b, c] = sends.map((send) => send.commandId);

			const queued = [/^Bravo$/, /^Charlie$/];
			await expect(trayTexts(page)).toHaveText(queued);
			await expect(
				trayRows(page).locator('[data-testid="pending-input-state"]'),
			).toHaveText(["Queued", "Queued"]);
			expect(
				await trayRows(page).evaluateAll((rows) =>
					rows.map((row) => row.getAttribute("data-input-id")),
				),
			).toEqual([b, c]);
			await expect(chat.userMessages).toHaveText([/\bAlpha\b/]);
			const seenBeforeReload = await seenPending();
			expect(seenBeforeReload).toEqual(["Bravo", "Charlie"]);
			const completedBeforeReload = turnsCompleted();

			await page.reload();
			await app.layout.waitFor({ state: "attached" });
			await expect(trayTexts(page)).toHaveText(queued);

			const context = await browser.newContext({
				viewport: page.viewportSize(),
			});
			try {
				const other = await context.newPage();
				await new AppPage(other).goto(relayUrl);
				await expect(trayTexts(other)).toHaveText(queued);
				// Every check above ran while Alpha's turn was still going.
				const completedAfterSecondBrowser = turnsCompleted();
				expect(completedAfterSecondBrowser).toBe(0);

				// Each queued input leaves the tray when its turn starts, which is
				// only after the ~10s turn before it ends.
				await expect(trayTexts(page)).toHaveText([/^Charlie$/], {
					timeout: 20_000,
				});
				const completedWhenBravoLeft = turnsCompleted();
				expect(completedWhenBravoLeft).toBeGreaterThanOrEqual(1);
				await expect(trayRows(page)).toHaveCount(0, { timeout: 20_000 });
				const completedWhenCharlieLeft = turnsCompleted();
				expect(completedWhenCharlieLeft).toBeGreaterThanOrEqual(2);

				await expect.poll(turnsCompleted).toBe(3);
				for (const p of [page, other]) {
					const view = new ChatPage(p);
					await view.waitForStreamingComplete();
					await expect(trayRows(p)).toHaveCount(0);
					await expect(view.userMessages).toHaveText([
						/\bAlpha\b/,
						/\bBravo\b/,
						/\bCharlie\b/,
					]);
					await expect(view.assistantMessages).toHaveText([
						/pong/i,
						/pong/i,
						/pong/i,
					]);
				}

				await testInfo.attach("pending-tray-proof.json", {
					body: JSON.stringify(
						{
							inputs: { a, b, c },
							seenInTrayBeforeReload: seenBeforeReload,
							turnsCompleted: {
								beforeReload: completedBeforeReload,
								afterSecondBrowser: completedAfterSecondBrowser,
								whenBravoLeftTray: completedWhenBravoLeft,
								whenCharlieLeftTray: completedWhenCharlieLeft,
							},
							userMessages: await chat.userMessages.allTextContents(),
						},
						null,
						2,
					),
					contentType: "application/json",
				});
			} finally {
				await context.close();
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
