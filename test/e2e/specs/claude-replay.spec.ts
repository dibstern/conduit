// Claude sessions whose SDK turns replay committed Claude SDK traces through
// the runtime's injected queryFactory (see helpers/claude-trace-replayer.ts).
// The replay fixture fails the test unless exactly the planned turns are sent.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
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

function queryDb<T>(dbPath: string, sql: string, ...params: string[]): T[] {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
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

/** Records every `done` the page receives for the session, in arrival order.
 *  Register before navigation. */
// The status poller can repeat a turn's done under the same alertId, which the
// browser treats as one; count each alertId once.
function recordDones(page: Page, sessionId: string): unknown[] {
	const dones: unknown[] = [];
	const seen = new Set<unknown>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (record["type"] === "done" && record["sessionId"] === sessionId) {
			const alertId = record["alertId"];
			if (alertId === undefined || !seen.has(alertId)) dones.push(record);
			seen.add(alertId);
			return;
		}
		Object.values(record).forEach(visit);
	};
	page.on("websocket", (ws) => {
		ws.on("framereceived", ({ payload }) => {
			if (typeof payload === "string" && payload.includes('"done"'))
				visit(JSON.parse(payload));
		});
	});
	return dones;
}

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient = Effect.Effect.Success<typeof makeWsRpcClient>;

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

				// Charlie's own ~10s turn runs from here.
				await expect.poll(turnsCompleted, { timeout: 20_000 }).toBe(3);
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

	test.describe("managing the queue", () => {
		const trayRows = (p: Page) => p.getByTestId("pending-input-row");
		const trayTexts = (p: Page) =>
			trayRows(p).getByTestId("pending-input-text");
		const row = (p: Page, text: string) =>
			trayRows(p).filter({
				has: p.getByTestId("pending-input-text").getByText(text, {
					exact: true,
				}),
			});
		const sessionOf = (harness: { projectUrl: string }) =>
			decodeURIComponent(harness.projectUrl.slice("/s/".length));
		/** Event, outbox and turn rows of the session, for assertions and proof. */
		const ledger = (dbPath: string, sessionId: string) => ({
			events: queryDb<{ type: string; input_id: string | null }>(
				dbPath,
				`SELECT type, json_extract(data, '$.inputId') AS input_id FROM events
				WHERE session_id = ? AND type IN ('input.admitted', 'input.sent',
					'input.cancelled', 'turn.completed', 'turn.interrupted', 'turn.error')
				ORDER BY sequence`,
				sessionId,
			),
			outbox: queryDb<{ command_id: string }>(
				dbPath,
				`SELECT command_id FROM provider_command_outbox
				WHERE session_id = ? AND effect_type = 'send_turn'
				ORDER BY request_sequence`,
				sessionId,
			).map((r) => r.command_id),
			turns: queryDb<{ state: string; user_message_id: string }>(
				dbPath,
				`SELECT state, user_message_id FROM turns WHERE session_id = ?
				ORDER BY requested_at, rowid`,
				sessionId,
			),
		});
		const inputsOf = (
			rows: readonly { type: string; input_id: string | null }[],
			type: string,
		) => rows.filter((r) => r.type === type).map((r) => r.input_id);

		test.describe("remove and edit", () => {
			// One planned turn: the replayer fails the test if a removed or
			// edited input is ever sent.
			test.use({
				claudeReplay: { turns: ["pong-thinking-text-turn"], delayMs: 500 },
			});

			test("Remove and Edit drop queued rows on every client and send neither", async ({
				page,
				browser,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(90_000);
				const sessionId = sessionOf(harness);
				const sends = recordSends(page);
				const app = new AppPage(page);
				const chat = new ChatPage(page);
				await app.goto(relayUrl);
				const context = await browser.newContext({
					viewport: page.viewportSize(),
				});
				try {
					const other = await context.newPage();
					await new AppPage(other).goto(relayUrl);

					await app.sendMessage("Alpha");
					await expect(chat.stopBtn).toBeVisible();
					await app.sendMessage("Bravo");
					await app.sendMessage("Charlie");
					await expect.poll(() => sends.length).toBe(3);
					const [a, b, c] = sends.map((send) => send.commandId);
					for (const p of [page, other])
						await expect(trayTexts(p)).toHaveText([/^Bravo$/, /^Charlie$/]);

					await row(page, "Bravo").getByTestId("pending-input-remove").click();
					for (const p of [page, other])
						await expect(trayTexts(p)).toHaveText([/^Charlie$/]);

					await expect(app.input).toHaveValue("");
					await row(page, "Charlie").getByTestId("pending-input-edit").click();
					await expect(app.input).toHaveValue("Charlie");
					for (const p of [page, other])
						await expect(trayRows(p)).toHaveCount(0);
					// Both left the tray while Alpha's turn was still running.
					expect(countEvents(harness.eventsDbPath, "turn.completed")).toBe(0);

					await expect
						.poll(() => countEvents(harness.eventsDbPath, "turn.completed"))
						.toBe(1);
					await chat.waitForStreamingComplete();
					await expect(chat.userMessages).toHaveText([/\bAlpha\b/]);
					const proof = ledger(harness.eventsDbPath, sessionId);
					await testInfo.attach("queue-remove-edit-proof.json", {
						body: JSON.stringify({ inputs: { a, b, c }, ...proof }, null, 2),
						contentType: "application/json",
					});
					expect(proof.outbox).toEqual([a]);
					expect(inputsOf(proof.events, "input.sent")).toEqual([a]);
					expect(inputsOf(proof.events, "input.cancelled")).toEqual([b, c]);
				} finally {
					await context.close();
				}
			});
		});

		test.describe("stop and resume", () => {
			test.use({
				claudeReplay: {
					turns: [
						"pong-thinking-text-turn",
						"pong-thinking-text-turn",
						"pong-thinking-text-turn",
					],
					delayMs: 300,
				},
			});

			test("Stop with a queue pauses it; Resume sends the oldest and the rest drains", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(90_000);
				const dbPath = harness.eventsDbPath;
				const sessionId = sessionOf(harness);
				const sends = recordSends(page);
				const app = new AppPage(page);
				const chat = new ChatPage(page);
				await app.goto(relayUrl);

				await app.sendMessage("Alpha");
				await expect(chat.stopBtn).toBeVisible();
				await app.sendMessage("Bravo");
				await app.sendMessage("Charlie");
				await expect.poll(() => sends.length).toBe(3);
				const [a, b, c] = sends.map((send) => send.commandId);
				await expect(trayTexts(page)).toHaveText([/^Bravo$/, /^Charlie$/]);
				await expect(page.getByTestId("pending-input-paused")).toHaveCount(0);

				await chat.stopBtn.click();
				await expect
					.poll(() => countEvents(dbPath, "turn.interrupted"))
					.toBe(1);
				await expect(page.getByTestId("pending-input-paused")).toContainText(
					"Paused",
				);
				// Nothing drains on its own while paused.
				await page.waitForTimeout(1_500);
				const paused = ledger(dbPath, sessionId);
				expect(inputsOf(paused.events, "input.sent")).toEqual([a]);
				await expect(trayTexts(page)).toHaveText([/^Bravo$/, /^Charlie$/]);

				await page.getByTestId("pending-input-resume").click();
				await expect(trayTexts(page)).toHaveText([/^Charlie$/]);
				await expect(page.getByTestId("pending-input-paused")).toHaveCount(0);
				// Bravo's normal end un-pauses the queue: Charlie follows unprompted.
				await expect
					.poll(() => countEvents(dbPath, "turn.completed"), {
						timeout: 30_000,
					})
					.toBe(2);
				await chat.waitForStreamingComplete();
				await expect(trayRows(page)).toHaveCount(0);
				await expect(chat.userMessages).toHaveText([
					/\bAlpha\b/,
					/\bBravo\b/,
					/\bCharlie\b/,
				]);
				const proof = ledger(dbPath, sessionId);
				await testInfo.attach("queue-stop-resume-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b, c }, whilePaused: paused, final: proof },
						null,
						2,
					),
					contentType: "application/json",
				});
				expect(proof.outbox).toEqual([a, b, c]);
				expect(proof.turns.map((t) => t.state)).toEqual([
					"interrupted",
					"completed",
					"completed",
				]);
			});
		});

		test.describe("a failed turn", () => {
			// Alpha's result reports an upstream API failure.
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
					delayMs: 300,
					failTurns: [0],
				},
			});

			test("pauses the queue until Resume", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const dbPath = harness.eventsDbPath;
				const sessionId = sessionOf(harness);
				const sends = recordSends(page);
				const app = new AppPage(page);
				const chat = new ChatPage(page);
				await app.goto(relayUrl);

				await app.sendMessage("Alpha");
				await expect(chat.stopBtn).toBeVisible();
				await app.sendMessage("Bravo");
				await expect.poll(() => sends.length).toBe(2);
				const [a, b] = sends.map((send) => send.commandId);
				await expect(trayTexts(page)).toHaveText([/^Bravo$/]);

				await expect.poll(() => countEvents(dbPath, "turn.error")).toBe(1);
				await expect(page.getByTestId("pending-input-paused")).toBeVisible();
				await page.waitForTimeout(1_500);
				const paused = ledger(dbPath, sessionId);
				expect(inputsOf(paused.events, "input.sent")).toEqual([a]);
				await expect(trayTexts(page)).toHaveText([/^Bravo$/]);

				await page.getByTestId("pending-input-resume").click();
				await expect.poll(() => countEvents(dbPath, "turn.completed")).toBe(1);
				await chat.waitForStreamingComplete();
				await expect(trayRows(page)).toHaveCount(0);
				const proof = ledger(dbPath, sessionId);
				await testInfo.attach("queue-failed-turn-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b }, whilePaused: paused, final: proof },
						null,
						2,
					),
					contentType: "application/json",
				});
				expect(proof.turns.map((t) => t.state)).toEqual(["error", "completed"]);
				expect(proof.outbox).toEqual([a, b]);
			});
		});

		test.describe("a row that already started", () => {
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
					delayMs: 100,
				},
			});

			test("Remove and Edit say it started, leave the composer alone and send it once", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const dbPath = harness.eventsDbPath;
				const sessionId = sessionOf(harness);
				// A lagging client: while held, nothing the server sends reaches the
				// page, so Bravo's row stays on screen after Bravo has started.
				let holding = false;
				const held: (() => void)[] = [];
				let replies = 0;
				await page.routeWebSocket(/\/rpc$/, (ws) => {
					const server = ws.connectToServer();
					server.onMessage((message) => {
						if (
							typeof message === "string" &&
							message.includes("already_started")
						)
							replies += 1;
						if (holding) held.push(() => ws.send(message));
						else ws.send(message);
					});
				});
				const app = new AppPage(page);
				const chat = new ChatPage(page);
				await app.goto(relayUrl);

				await app.sendMessage("Alpha");
				await expect(chat.stopBtn).toBeVisible();
				await app.sendMessage("Bravo");
				const admitted = () =>
					inputsOf(ledger(dbPath, sessionId).events, "input.admitted");
				await expect.poll(() => admitted().length).toBe(2);
				const [a, b] = admitted();
				await expect(trayTexts(page)).toHaveText([/^Bravo$/]);

				holding = true;
				await expect
					.poll(() => inputsOf(ledger(dbPath, sessionId).events, "input.sent"))
					.toEqual([a, b]);
				await expect(trayTexts(page)).toHaveText([/^Bravo$/]);
				await row(page, "Bravo").getByTestId("pending-input-remove").click();
				await row(page, "Bravo").getByTestId("pending-input-edit").click();
				await expect.poll(() => replies).toBe(2);
				holding = false;
				for (const send of held.splice(0)) send();

				await expect(
					page.getByText("That message already started").first(),
				).toBeVisible();
				await expect(trayRows(page)).toHaveCount(0);
				await expect(app.input).toHaveValue("");
				await expect.poll(() => countEvents(dbPath, "turn.completed")).toBe(2);
				await chat.waitForStreamingComplete();
				await expect(chat.userMessages).toHaveText([/\bAlpha\b/, /\bBravo\b/]);
				const proof = ledger(dbPath, sessionId);
				await testInfo.attach("queue-already-started-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b }, replies, ...proof },
						null,
						2,
					),
					contentType: "application/json",
				});
				expect(proof.outbox).toEqual([a, b]);
				expect(inputsOf(proof.events, "input.sent")).toEqual([a, b]);
				expect(inputsOf(proof.events, "input.cancelled")).toEqual([]);
			});
		});

		test.describe("a restart that cuts the running turn off", () => {
			// The in-process runner dies with the relay, so the running turn can
			// never finish. (The daemon lane covers a turn that survives a restart.)
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
					delayMs: 500,
				},
			});

			test("closes the turn and pauses the queue it leaves behind", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(90_000);
				const dbPath = harness.eventsDbPath;
				const sessionId = sessionOf(harness);
				const sends = recordSends(page);
				const app = new AppPage(page);
				const chat = new ChatPage(page);
				await app.goto(relayUrl);

				await app.sendMessage("Alpha");
				await expect(chat.stopBtn).toBeVisible();
				await app.sendMessage("Bravo");
				await expect.poll(() => sends.length).toBe(2);
				const [a, b] = sends.map((send) => send.commandId);
				await expect(trayTexts(page)).toHaveText([/^Bravo$/]);
				const before = ledger(dbPath, sessionId);

				await harness.restart();
				await expect(page.getByTestId("pending-input-paused")).toBeVisible({
					timeout: 30_000,
				});
				await expect(trayTexts(page)).toHaveText([/^Bravo$/]);
				await expect(chat.stopBtn).toBeHidden();
				await page.waitForTimeout(1_500);
				const restarted = ledger(dbPath, sessionId);
				// Shutdown may interrupt the turn first; otherwise recovery closes it
				// as an error. Either way it was cut off and the queue pauses.
				const cutOff = restarted.turns.map((t) => t.state);
				expect(cutOff).toHaveLength(1);
				expect(["interrupted", "error"]).toContain(cutOff[0]);
				expect(inputsOf(restarted.events, "input.sent")).toEqual([a]);

				await page.getByTestId("pending-input-resume").click();
				await expect
					.poll(() => countEvents(dbPath, "turn.completed"), {
						timeout: 30_000,
					})
					.toBe(1);
				await chat.waitForStreamingComplete();
				await expect(trayRows(page)).toHaveCount(0);
				const proof = ledger(dbPath, sessionId);
				await testInfo.attach("queue-restart-cut-off-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b }, before, restarted, final: proof },
						null,
						2,
					),
					contentType: "application/json",
				});
				expect(proof.outbox).toEqual([a, b]);
				expect(proof.turns.map((t) => t.state)).toEqual([
					...cutOff,
					"completed",
				]);
			});
		});

		test.describe("a late done for the turn before", () => {
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
					delayMs: 300,
				},
			});

			test("does not end the queued turn that started after it", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const dbPath = harness.eventsDbPath;
				const sessionId = sessionOf(harness);
				const sends = recordSends(page);
				const app = new AppPage(page);
				const chat = new ChatPage(page);
				await app.goto(relayUrl);

				await app.sendMessage("Alpha");
				await expect(chat.stopBtn).toBeVisible();
				await app.sendMessage("Bravo");
				await expect.poll(() => sends.length).toBe(2);
				const [a, b] = sends.map((send) => send.commandId);

				// Bravo is streaming once its assistant message shows.
				await expect(chat.assistantMessages).toHaveCount(2, {
					timeout: 20_000,
				});
				const [alphaTurn] = queryDb<{ assistant_message_id: string }>(
					dbPath,
					"SELECT assistant_message_id FROM turns WHERE user_message_id = ?",
					a ?? "",
				);
				const alphaAssistant = alphaTurn?.assistant_message_id;
				expect(alphaAssistant).toMatch(/\S/);
				expect(countEvents(dbPath, "turn.completed")).toBe(1);
				await expect(chat.stopBtn).toBeVisible();

				// The monitoring layer's synthetic done for Alpha, arriving late.
				harness.stack.wsHandler.sendToSession(sessionId, {
					type: "done",
					sessionId,
					code: 0,
					alertId: JSON.stringify([sessionId, alphaAssistant, "done"]),
					...(alphaAssistant ? { messageId: alphaAssistant } : {}),
				});
				await page.waitForTimeout(1_000);
				const stopAfterLateDone = await chat.stopBtn.isVisible();
				const completedAfterLateDone = countEvents(dbPath, "turn.completed");
				expect(completedAfterLateDone).toBe(1);
				expect(stopAfterLateDone).toBe(true);

				await expect.poll(() => countEvents(dbPath, "turn.completed")).toBe(2);
				await chat.waitForStreamingComplete();
				await expect(chat.assistantMessages).toHaveText([/pong/i, /pong/i]);
				await testInfo.attach("late-done-proof.json", {
					body: JSON.stringify(
						{
							inputs: { a, b },
							lateDoneMessageId: alphaAssistant,
							stopAfterLateDone,
							completedAfterLateDone,
							final: ledger(dbPath, sessionId),
						},
						null,
						2,
					),
					contentType: "application/json",
				});
			});
		});
	});

	test.describe("steering a running turn", () => {
		const turnsOf = ["turn.completed", "turn.interrupted", "turn.error"];
		/** Everything the steer scenarios assert on, in store order. */
		const ledger = (dbPath: string, sessionId: string) => ({
			events: queryDb<{
				sequence: number;
				type: string;
				input_id: string | null;
				message_id: string | null;
				role: string | null;
			}>(
				dbPath,
				`SELECT sequence, type, json_extract(data, '$.inputId') AS input_id,
					json_extract(data, '$.messageId') AS message_id,
					json_extract(data, '$.role') AS role
				FROM events WHERE session_id = ? AND type IN ('input.admitted',
					'input.sent', 'input.cancelled', 'message.created', 'tool.completed',
					'turn.completed', 'turn.interrupted', 'turn.error')
				ORDER BY sequence`,
				sessionId,
			),
			outbox: queryDb<{ command_id: string }>(
				dbPath,
				`SELECT command_id FROM provider_command_outbox
				WHERE session_id = ? AND effect_type = 'send_turn'
				ORDER BY request_sequence`,
				sessionId,
			).map((r) => r.command_id),
			turns: queryDb<{ id: string; state: string; completed_at: number }>(
				dbPath,
				`SELECT id, state, completed_at FROM turns WHERE session_id = ?
				ORDER BY requested_at, rowid`,
				sessionId,
			),
			userMessages: queryDb<{
				id: string;
				steered: number;
				created_at: number;
			}>(
				dbPath,
				`SELECT id, steered, created_at FROM messages
				WHERE session_id = ? AND role = 'user' ORDER BY rowid`,
				sessionId,
			),
			pending: queryDb<{ input_id: string; state: string }>(
				dbPath,
				"SELECT input_id, state FROM pending_inputs WHERE session_id = ? ORDER BY admitted_at",
				sessionId,
			),
		});
		const pendingState = (dbPath: string, inputId: string) =>
			queryDb<{ state: string }>(
				dbPath,
				"SELECT state FROM pending_inputs WHERE input_id = ?",
				inputId,
			)[0]?.state;

		/** A browser on the replayed session, plus a second client that steers
		 *  over the typed RPC (the composer's steer UI is not built yet). */
		async function open(
			page: Page,
			relayUrl: string,
			harness: { projectUrl: string; relayPort: number; eventsDbPath: string },
		) {
			const sessionId = decodeURIComponent(
				harness.projectUrl.slice("/s/".length),
			);
			const target = { projectSlug: "e2e-replay", sessionId };
			const rpc = <A, E>(call: (client: WsRpcClient) => Effect.Effect<A, E>) =>
				Effect.runPromise(
					Effect.scoped(Effect.flatMap(makeWsRpcClient, call)).pipe(
						Effect.provide(RpcClient.layerProtocolSocket()),
						Effect.provide(
							Socket.layerWebSocket(`ws://127.0.0.1:${harness.relayPort}/rpc`),
						),
						Effect.provide(Socket.layerWebSocketConstructorGlobal),
						Effect.provide(RpcSerialization.layerJson),
					),
				);
			const sends = recordSends(page);
			const dones = recordDones(page, sessionId);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);
			return {
				sessionId,
				dbPath: harness.eventsDbPath,
				sends,
				dones,
				app,
				chat,
				submit: (text: string, delivery: "queue" | "steer") => {
					const inputId = randomUUID();
					return rpc((client) =>
						client.input.submit({ ...target, inputId, text, delivery }),
					).then((response) => ({ inputId, response }));
				},
				sendNow: (inputId: string) =>
					rpc((client) => client.input.sendNow({ ...target, inputId })),
				switchModel: (modelId: string) =>
					rpc((client) =>
						client.SwitchModel({ ...target, providerId: "claude", modelId }),
					),
				/** Each provider result ends one turn; Stop adds no turn end. */
				turnEnds: () =>
					turnsOf.reduce(
						(n, type) => n + countEvents(harness.eventsDbPath, type),
						0,
					),
			};
		}

		const sequenceOf = (
			events: ReturnType<typeof ledger>["events"],
			match: (event: ReturnType<typeof ledger>["events"][number]) => boolean,
		) => events.find(match)?.sequence ?? Number.NaN;

		test.describe("a steer during a tool", () => {
			test.use({
				claudeReplay: { turns: ["steer-during-tool-folds"], delayMs: 100 },
			});

			test("joins at the tool boundary: one result, two turns, one done", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const s = await open(page, relayUrl, harness);
				await s.app.sendMessage("Alpha");
				await s.chat.waitForToolBlock();
				const { inputId: b, response } = await s.submit("Bravo", "steer");
				expect(response).toEqual({ ok: true, sessionId: s.sessionId });
				const steering = pendingState(s.dbPath, b);

				await expect.poll(s.turnEnds).toBe(1);
				await s.chat.waitForStreamingComplete();
				await expect(s.chat.userMessages).toHaveText([
					/\bAlpha\b/,
					/\bBravo\b/,
				]);
				await expect(s.chat.assistantMessages.last()).toContainText("BANANA");
				const a = s.sends[0]?.commandId ?? "";
				const proof = ledger(s.dbPath, s.sessionId);
				await testInfo.attach("steer-during-tool-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b }, steering, dones: s.dones, ...proof },
						null,
						2,
					),
					contentType: "application/json",
				});

				expect(steering).toBe("steering");
				expect(proof.pending).toEqual([
					{ input_id: a, state: "removed" },
					{ input_id: b, state: "removed" },
				]);
				expect(proof.outbox).toEqual([a, b]);
				// The steer's message lands after the tool's result and before the
				// reply that answers both inputs.
				const bPlaced = sequenceOf(
					proof.events,
					(e) => e.type === "message.created" && e.message_id === b,
				);
				expect(
					sequenceOf(proof.events, (e) => e.type === "tool.completed"),
				).toBeLessThan(bPlaced);
				expect(
					proof.events.filter(
						(e) =>
							e.type === "message.created" &&
							e.role === "assistant" &&
							e.sequence > bPlaced,
					),
				).toHaveLength(1);
				// One result: one turn end and one done, yet two turns — Alpha's
				// closed by the steer's message, which is marked steered.
				expect(
					proof.events
						.filter((e) => turnsOf.includes(e.type))
						.map((e) => e.type),
				).toEqual(["turn.completed"]);
				expect(s.dones).toHaveLength(1);
				const bMessage = proof.userMessages.find((m) => m.id === b);
				expect(proof.userMessages.map((m) => [m.id, m.steered])).toEqual([
					[a, 0],
					[b, 1],
				]);
				expect(proof.turns).toEqual([
					{ id: a, state: "completed", completed_at: bMessage?.created_at },
					{ id: b, state: "completed", completed_at: expect.any(Number) },
				]);
			});
		});

		test.describe("a steer that misses the boundary", () => {
			test.use({
				claudeReplay: { turns: ["steer-misses-boundary"], delayMs: 30 },
			});

			test("runs as its own turn after the first: two results, two dones", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const s = await open(page, relayUrl, harness);
				await s.app.sendMessage("Alpha");
				// Alpha is replying (no tool, so no boundary to read the steer at).
				await expect(s.chat.assistantMessages).toHaveCount(1);
				const { inputId: b, response } = await s.submit("Bravo", "steer");
				expect(response).toEqual({ ok: true, sessionId: s.sessionId });
				const steering = pendingState(s.dbPath, b);

				await expect.poll(s.turnEnds, { timeout: 30_000 }).toBe(2);
				await s.chat.waitForStreamingComplete();
				await expect(s.chat.userMessages).toHaveText([
					/\bAlpha\b/,
					/\bBravo\b/,
				]);
				await expect(s.chat.assistantMessages.last()).toContainText("BANANA");
				const a = s.sends[0]?.commandId ?? "";
				const proof = ledger(s.dbPath, s.sessionId);
				await testInfo.attach("steer-misses-boundary-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b }, steering, dones: s.dones, ...proof },
						null,
						2,
					),
					contentType: "application/json",
				});

				expect(steering).toBe("steering");
				expect(proof.pending).toEqual([
					{ input_id: a, state: "removed" },
					{ input_id: b, state: "removed" },
				]);
				expect(proof.outbox).toEqual([a, b]);
				expect(
					proof.events
						.filter((e) => turnsOf.includes(e.type))
						.map((e) => e.type),
				).toEqual(["turn.completed", "turn.completed"]);
				expect(s.dones).toHaveLength(2);
				// Alpha had ended when Bravo started, so Bravo closed no turn.
				expect(proof.userMessages.map((m) => [m.id, m.steered])).toEqual([
					[a, 0],
					[b, 0],
				]);
				expect(proof.turns.map((t) => [t.id, t.state])).toEqual([
					[a, "completed"],
					[b, "completed"],
				]);
			});
		});

		test.describe("two steers at one boundary", () => {
			test.use({
				claudeReplay: { turns: ["two-steers-one-boundary"], delayMs: 100 },
			});

			test("both join: one result answers all three inputs", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const s = await open(page, relayUrl, harness);
				await s.app.sendMessage("Alpha");
				await s.chat.waitForToolBlock();
				const bravo = await s.submit("Bravo", "steer");
				const charlie = await s.submit("Charlie", "steer");
				const [b, c] = [bravo.inputId, charlie.inputId];
				expect([bravo.response, charlie.response]).toEqual([
					{ ok: true, sessionId: s.sessionId },
					{ ok: true, sessionId: s.sessionId },
				]);
				const steering = [pendingState(s.dbPath, b), pendingState(s.dbPath, c)];

				await expect.poll(s.turnEnds).toBe(1);
				await s.chat.waitForStreamingComplete();
				await expect(s.chat.userMessages).toHaveText([
					/\bAlpha\b/,
					/\bBravo\b/,
					/\bCharlie\b/,
				]);
				await expect(s.chat.assistantMessages.last()).toContainText("CHERRY");
				const a = s.sends[0]?.commandId ?? "";
				const proof = ledger(s.dbPath, s.sessionId);
				await testInfo.attach("two-steers-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b, c }, steering, dones: s.dones, ...proof },
						null,
						2,
					),
					contentType: "application/json",
				});

				expect(steering).toEqual(["steering", "steering"]);
				expect(proof.pending).toEqual([
					{ input_id: a, state: "removed" },
					{ input_id: b, state: "removed" },
					{ input_id: c, state: "removed" },
				]);
				expect(proof.outbox).toEqual([a, b, c]);
				const toolDone = sequenceOf(
					proof.events,
					(e) => e.type === "tool.completed",
				);
				for (const id of [b, c])
					expect(toolDone).toBeLessThan(
						sequenceOf(
							proof.events,
							(e) => e.type === "message.created" && e.message_id === id,
						),
					);
				expect(
					proof.events
						.filter((e) => turnsOf.includes(e.type))
						.map((e) => e.type),
				).toEqual(["turn.completed"]);
				expect(s.dones).toHaveLength(1);
				expect(proof.userMessages.map((m) => [m.id, m.steered])).toEqual([
					[a, 0],
					[b, 1],
					[c, 1],
				]);
				const placedAt = (id: string) =>
					proof.userMessages.find((m) => m.id === id)?.created_at;
				expect(proof.turns).toEqual([
					{ id: a, state: "completed", completed_at: placedAt(b) },
					{ id: b, state: "completed", completed_at: placedAt(c) },
					{ id: c, state: "completed", completed_at: expect.any(Number) },
				]);
			});
		});

		test.describe("Stop with a steer pending", () => {
			test.use({
				claudeReplay: { turns: ["stop-with-steer-pending"], delayMs: 100 },
			});

			test("interrupts the running turn, still answers the steer and pauses the queue", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const s = await open(page, relayUrl, harness);
				await s.app.sendMessage("Alpha");
				await s.chat.waitForToolBlock();
				const { inputId: b, response } = await s.submit("Bravo", "steer");
				expect(response).toEqual({ ok: true, sessionId: s.sessionId });
				const steering = pendingState(s.dbPath, b);
				const charlie = await s.submit("Charlie", "queue");
				const c = charlie.inputId;
				await expect(
					page
						.getByTestId("pending-input-row")
						.getByTestId("pending-input-text"),
				).toHaveText([/^Bravo$/, /^Charlie$/]);

				await s.chat.stopBtn.click();
				await expect
					.poll(() => countEvents(s.dbPath, "turn.interrupted"))
					.toBe(1);
				await expect.poll(s.turnEnds).toBe(2);
				await s.chat.waitForStreamingComplete();
				await expect(page.getByTestId("pending-input-paused")).toContainText(
					"Paused",
				);
				// Nothing drains on its own while paused.
				await page.waitForTimeout(1_500);
				await expect(
					page
						.getByTestId("pending-input-row")
						.getByTestId("pending-input-text"),
				).toHaveText([/^Charlie$/]);
				await expect(s.chat.userMessages).toHaveText([
					/\bAlpha\b/,
					/\bBravo\b/,
				]);
				await expect(s.chat.assistantMessages.last()).toContainText("BANANA");
				const a = s.sends[0]?.commandId ?? "";
				const proof = ledger(s.dbPath, s.sessionId);
				await testInfo.attach("stop-with-steer-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b, c }, steering, dones: s.dones, ...proof },
						null,
						2,
					),
					contentType: "application/json",
				});

				expect(steering).toBe("steering");
				expect(proof.pending).toEqual([
					{ input_id: a, state: "removed" },
					{ input_id: b, state: "removed" },
					{ input_id: c, state: "queued" },
				]);
				expect(proof.outbox).toEqual([a, b]);
				expect(
					proof.events
						.filter((e) => turnsOf.includes(e.type))
						.map((e) => e.type),
				).toEqual(["turn.interrupted", "turn.completed"]);
				// One done per result, plus the one Stop sends itself.
				expect(s.dones).toHaveLength(3);
				// Alpha was interrupted before Bravo started: Bravo closed no turn.
				expect(proof.userMessages.map((m) => [m.id, m.steered])).toEqual([
					[a, 0],
					[b, 0],
				]);
				expect(proof.turns.map((t) => [t.id, t.state])).toEqual([
					[a, "interrupted"],
					[b, "completed"],
				]);
			});
		});

		test.describe("Send now on a queued input", () => {
			test.use({
				claudeReplay: {
					turns: ["queued-input-promoted-to-steer"],
					delayMs: 100,
				},
			});

			test("promotes the queued row to a steer", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const s = await open(page, relayUrl, harness);
				await s.app.sendMessage("Alpha");
				await s.chat.waitForToolBlock();
				const { inputId: b, response } = await s.submit("Bravo", "queue");
				expect(response).toEqual({ ok: true, sessionId: s.sessionId });
				const queued = pendingState(s.dbPath, b);
				expect(await s.sendNow(b)).toEqual({ ok: true });
				const steering = pendingState(s.dbPath, b);

				await expect.poll(s.turnEnds).toBe(1);
				await s.chat.waitForStreamingComplete();
				await expect(s.chat.userMessages).toHaveText([
					/\bAlpha\b/,
					/\bBravo\b/,
				]);
				await expect(s.chat.assistantMessages.last()).toContainText("BANANA");
				const a = s.sends[0]?.commandId ?? "";
				const proof = ledger(s.dbPath, s.sessionId);
				await testInfo.attach("send-now-steer-proof.json", {
					body: JSON.stringify(
						{ inputs: { a, b }, queued, steering, dones: s.dones, ...proof },
						null,
						2,
					),
					contentType: "application/json",
				});

				expect([queued, steering]).toEqual(["queued", "steering"]);
				expect(proof.pending).toEqual([
					{ input_id: a, state: "removed" },
					{ input_id: b, state: "removed" },
				]);
				expect(proof.outbox).toEqual([a, b]);
				expect(
					proof.events
						.filter((e) => turnsOf.includes(e.type))
						.map((e) => e.type),
				).toEqual(["turn.completed"]);
				expect(s.dones).toHaveLength(1);
				expect(proof.userMessages.map((m) => [m.id, m.steered])).toEqual([
					[a, 0],
					[b, 1],
				]);
				expect(proof.turns.map((t) => [t.id, t.state])).toEqual([
					[a, "completed"],
					[b, "completed"],
				]);
			});
		});

		test.describe("a steer that cannot join", () => {
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn"],
					delayMs: 300,
					models: [
						{
							id: "claude-fable-5",
							name: "Claude Fable 5",
							providerId: "claude",
						},
						{
							id: "claude-sonnet-5",
							name: "Claude Sonnet 5",
							providerId: "claude",
						},
					],
				},
			});

			test("is refused with its reason and admits nothing", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				test.setTimeout(60_000);
				const s = await open(page, relayUrl, harness);
				await s.app.sendMessage("Alpha");
				await expect(s.chat.stopBtn).toBeVisible();
				const slash = await s.submit("/compact", "steer");
				await s.switchModel("claude-sonnet-5");
				const otherModel = await s.submit("Bravo", "steer");

				await expect.poll(s.turnEnds).toBe(1);
				await s.chat.waitForStreamingComplete();
				const a = s.sends[0]?.commandId ?? "";
				const proof = ledger(s.dbPath, s.sessionId);
				await testInfo.attach("steer-refused-proof.json", {
					body: JSON.stringify({ a, slash, otherModel, ...proof }, null, 2),
					contentType: "application/json",
				});

				expect(slash.response).toEqual({ ok: false, reason: "slash_command" });
				expect(otherModel.response).toEqual({
					ok: false,
					reason: "model_differs",
				});
				// Only Alpha's own row (sent on idle): the refused steers left none.
				expect(proof.pending).toEqual([{ input_id: a, state: "removed" }]);
				expect(proof.outbox).toEqual([a]);
				expect(
					proof.events
						.filter((e) => e.type.startsWith("input."))
						.map((e) => [e.type, e.input_id]),
				).toEqual([
					["input.admitted", a],
					["input.sent", a],
				]);
				await expect(s.chat.userMessages).toHaveText([/\bAlpha\b/]);
			});
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
