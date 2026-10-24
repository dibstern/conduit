// A Claude session whose turn has ended while a backgrounded shell still runs
// reads as monitoring in the sidebar until the shell ends, and lists the shell
// in the session header's tasks row (with a dot on the composer), whose "Stop
// all" ends the whole session. Bug: it read as done, because the shell's
// liveness lives in memory and nothing re-sent the row.
// Specs: conduit-test-0mmk, conduit-test-nvv6, conduit-test-od8e, conduit-test-va96.1.
//
// Replays a captured trace (no model call): Bash `sleep 8` with
// run_in_background, the turn's result, then the shell ending and the SDK's
// wake-up turn. The replay holds after the result, so "turn over, shell
// alive" is a state the test holds rather than races.
//
// The row is read in a second window with no session open: an open session
// gets its own push, which would mask the sidebar stream this is about. Its
// spoken status at each step is attached as a report, with a screenshot.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { responseChunks } from "../../helpers/fake-claude-process-sdk.js";
import { test as processTest } from "../helpers/process-harness-fixture.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.describe("Claude background work", () => {
	test.use({
		claudeReplay: { turns: ["background-shell-turn"], holdAfterResult: true },
	});

	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"The sidebar is checked on desktop only",
		);
	});

	test("keeps the session monitoring until its background shell ends", async ({
		page,
		browser,
		relayUrl,
		harness,
	}, testInfo) => {
		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		// The stored row: its status and how many turns have ended.
		const stored = () => {
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				const row = db
					.prepare(
						"SELECT status, (SELECT COUNT(*) FROM events WHERE session_id = s.id AND type = 'turn.completed') AS turnEnds FROM sessions s WHERE id = ?",
					)
					.get(sessionId);
				return { status: row?.["status"], turnEnds: Number(row?.["turnEnds"]) };
			} finally {
				db.close();
			}
		};
		const report: {
			step: string;
			label: string | null;
			stored: ReturnType<typeof stored>;
		}[] = [];
		const record = async (step: string) => {
			report.push({
				step,
				label: await row.getAttribute("aria-label"),
				stored: stored(),
			});
			const path = testInfo.outputPath(`${step}.png`);
			await sidebar.screenshot({ path, animations: "disabled" });
			await testInfo.attach(`${step}.png`, { path, contentType: "image/png" });
		};

		const sidebar = await (
			await browser.newContext({ viewport: page.viewportSize() })
		).newPage();
		const row = sidebar.locator(
			`#session-list [data-session-id="${sessionId}"]`,
		);

		try {
			const app = new AppPage(page);
			await app.goto(relayUrl);
			await gotoRelay(sidebar, `${harness.relayBaseUrl}/p/e2e-replay/`);
			await expect(row).not.toHaveClass(/(?:^|\s)active(?:\s|$)/);
			await app.sendMessage("Run sleep 8 in the background");

			// The idle status is written just after the turn end, not with it.
			// Wait for both, or the row is read while still busy from the turn.
			await expect.poll(stored).toEqual({ status: "idle", turnEnds: 1 });
			// The sidebar stream is ordered, so once the second window shows a
			// rename made after that, it has had the idle status too.
			await page.getByTestId("session-bar-overflow").click();
			await page.getByTestId("session-ctx-rename").click();
			const name = page.getByRole("textbox", { name: "Session name" });
			await name.fill("Background shell");
			await name.press("Enter");
			await expect(row).toHaveAttribute("aria-label", /Background shell/);
			await expect(
				row,
				"the turn ended but the sidebar stopped saying monitoring while its background shell ran",
			).toHaveAttribute("aria-label", /^Monitoring/);
			await expect(
				page
					.getByTestId("background-tasks-row")
					.getByTestId("background-task-chip"),
			).toContainText("sleep 8");
			const tasksButton = page.getByRole("button", {
				name: "1 background task",
				exact: true,
			});
			const age = page
				.getByTestId("background-tasks-panel")
				.getByTestId("background-task-age");
			await tasksButton.click();
			// Ages count from when the relay first saw the task, so a reload
			// must not restart them.
			const seconds = async () =>
				Number.parseInt((await age.textContent()) ?? "", 10);
			await expect.poll(seconds).toBeGreaterThanOrEqual(2);
			const before = await seconds();
			await page.reload();
			await tasksButton.click();
			await expect(age).toBeVisible();
			expect(
				await seconds(),
				"reloading the page restarted the background task's age",
			).toBeGreaterThanOrEqual(before);
			await tasksButton.click();
			await record("turn-ended-shell-running");
			const composer = testInfo.outputPath("composer-monitoring.png");
			await page.locator("#input-area").screenshot({
				path: composer,
				animations: "disabled",
			});
			await testInfo.attach("composer-monitoring.png", {
				path: composer,
				contentType: "image/png",
			});

			// The shell ending wakes the SDK into a turn of its own. Read the row
			// once that has settled too, not in the gap before it starts.
			harness.claudeReplayer?.release();
			await expect.poll(stored).toEqual({ status: "idle", turnEnds: 2 });
			await expect(
				row,
				"the background shell ended but the sidebar still says working",
			).toHaveAttribute("aria-label", /^Done, unread/);
			await expect(page.getByTestId("background-tasks-row")).toBeHidden();
			await expect(
				page.getByRole("button", { name: /^\d+ background tasks?$/ }),
			).toHaveCount(0);
			await record("shell-ended");
		} finally {
			const path = testInfo.outputPath("background-work-report.json");
			writeFileSync(path, JSON.stringify({ sessionId, report }, null, 2));
			await testInfo.attach("background-work-report.json", {
				path,
				contentType: "application/json",
			});
		}
	});

	// Stop all stops the tasks, not the turn (conduit-test-va96.2). Recorded
	// replay has no stopTask replies, so the stop, the row clearing and the
	// sidebar leaving Monitoring are proven in harness-background-task-stop.spec.ts.
});

processTest.describe("Claude wake-up turn inbox", () => {
	processTest.use({ harnessOptions: { restartProof: true } });

	processTest(
		"queues a send visibly until the wake-up turn ends, then answers it",
		async ({ page, harness }, testInfo) => {
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Wake-up inbox");
			const foreground = "notification-parent-turn";
			const text = "queued-during-wake-up";
			const inputId = randomUUID();
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			const ledger = () => {
				const db = new DatabaseSync(join(harness.configDir, "events.db"), {
					readOnly: true,
				});
				try {
					return {
						runs: db
							.prepare(
								"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
							)
							.all(sessionId),
						input: db
							.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
							.get(inputId),
						sent: db
							.prepare(
								"SELECT sequence FROM events WHERE session_id = ? AND type = 'input.sent' AND json_extract(data, '$.inputId') = ?",
							)
							.all(sessionId, inputId),
					};
				} finally {
					db.close();
				}
			};
			const report: Record<string, unknown> = {
				bead: "conduit-test-s7zo",
				sessionId,
				inputId,
				assertionsPassed: false,
			};
			try {
				await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
				await app.sendMessage(foreground);
				await expect
					.poll(() => ledger().runs)
					.toEqual([{ status: "completed" }]);
				await expect(page.getByTestId("background-task-chip")).toBeVisible();
				writeFileSync(
					join(harness.root, "release-notification-parent"),
					"release",
				);
				await expect(
					chat.assistantMessages.filter({
						hasText: "Notification parent message.",
					}),
				).toBeVisible();
				// The wake-up is held before its result and has no provider run of its own.
				report["wakeUp"] = ledger();
				expect(ledger().runs).toEqual([{ status: "completed" }]);
				expect(
					await Effect.runPromise(
						browser.rpc["input.submit"]({
							sessionId,
							originId: browser.originId,
							inputId,
							text,
							delivery: "queue",
						}),
					),
				).toMatchObject({ ok: true });
				await expect(page.getByTestId("pending-input-text")).toHaveText(text);
				await expect(page.getByTestId("pending-input-state")).toHaveText(
					"Queued",
				);
				await expect(chat.userMessages.filter({ hasText: text })).toHaveCount(
					0,
				);
				report["queued"] = {
					...ledger(),
					chip: await page.getByTestId("pending-input-row").innerText(),
				};
				expect(ledger()).toMatchObject({
					runs: [{ status: "completed" }],
					input: { state: "queued" },
					sent: [],
				});
				await page.reload();
				await expect(page.getByTestId("pending-input-text")).toHaveText(text);
				await expect(page.getByTestId("pending-input-state")).toHaveText(
					"Queued",
				);
				writeFileSync(
					join(harness.root, "release-notification-result"),
					"release",
				);
				await expect(chat.userMessages.filter({ hasText: text })).toHaveCount(
					1,
				);
				await expect(
					chat.assistantMessages.filter({
						hasText: responseChunks(text).join("").trim(),
					}),
				).toBeVisible();
				await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
				await expect
					.poll(() => ledger().runs)
					.toEqual([{ status: "completed" }, { status: "completed" }]);
				expect(ledger().sent).toHaveLength(1);
				const transcript = await browser.history(sessionId);
				expect(
					transcript.filter((message) => message.text === text),
				).toHaveLength(1);
				expect(
					transcript.filter(
						(message) => message.text === responseChunks(text).join(""),
					),
				).toHaveLength(1);
				report["answered"] = {
					...ledger(),
					transcript: transcript.map(({ role, text }) => ({ role, text })),
				};
				report["assertionsPassed"] = true;
			} finally {
				const path = testInfo.outputPath("wake-up-inbox.json");
				writeFileSync(path, JSON.stringify(report, null, 2));
				await testInfo.attach("wake-up-inbox", {
					path,
					contentType: "application/json",
				});
			}
		},
	);
});

// The shell ending between turns, before the SDK's wake-up turn (the trace is
// background-shell-turn cut there), restarts its Bash tool under a message id
// no turn owns. Bug (conduit-test-jyr9.14): that reopened the finished turn
// with no reply to close it, so the inbox queued every later message.
// Failure cases: the turn reads as running again; the next message queues
// instead of sending.
test.describe("Claude background shell ending between turns", () => {
	test.use({
		claudeReplay: {
			turns: ["background-shell-ends-between-turns", "pong-thinking-text-turn"],
		},
	});

	test("leaves the finished turn finished, so the next message sends", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		const ledger = () => {
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				const column = (sql: string) =>
					db
						.prepare(sql)
						.all(sessionId)
						.map((row) => String(row["value"]));
				return {
					turns: column(
						"SELECT state AS value FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
					),
					toolsStartedAfterTurnEnd: column(
						"SELECT json_extract(data, '$.toolName') AS value FROM events WHERE session_id = ?1 AND type = 'tool.started' AND sequence > (SELECT MIN(sequence) FROM events WHERE session_id = ?1 AND type = 'turn.completed')",
					),
					queued: column(
						"SELECT input_id AS value FROM pending_inputs WHERE session_id = ? AND state = 'queued'",
					),
					sent: column(
						"SELECT json_extract(data, '$.inputId') AS value FROM events WHERE session_id = ? AND type = 'input.sent'",
					).length,
				};
			} finally {
				db.close();
			}
		};
		const report: Record<string, ReturnType<typeof ledger>> = {};
		try {
			const app = new AppPage(page);
			await app.goto(relayUrl);
			await app.sendMessage("Run sleep 8 in the background");
			await expect
				.poll(() => ledger().toolsStartedAfterTurnEnd)
				.toHaveLength(1);
			report["shellEnded"] = ledger();
			expect(
				report["shellEnded"],
				"the shell ending between turns reopened the finished turn",
			).toMatchObject({ turns: ["completed"], queued: [], sent: 1 });

			await app.sendMessage("ping");
			await expect
				.poll(ledger, { message: "the next message queued behind the turn" })
				.toMatchObject({
					turns: ["completed", "completed"],
					queued: [],
					sent: 2,
				});
			report["nextSent"] = ledger();
		} finally {
			const path = testInfo.outputPath("between-turns-report.json");
			writeFileSync(path, JSON.stringify({ sessionId, report }, null, 2));
			await testInfo.attach("between-turns-report.json", {
				path,
				contentType: "application/json",
			});
		}
	});
});
