import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const TRACES = [
	"concurrent-background-work-turn",
	"concurrent-background-work-after-restart-turn",
] as const;
const traceResults = TRACES.flatMap((trace) =>
	readFileSync(
		join(process.cwd(), "test/fixtures/claude-sdk-traces", `${trace}.jsonl`),
		"utf8",
	)
		.trim()
		.split("\n")
		.map((line) => decodeClaudeSDKMessage(JSON.parse(line)))
		.flatMap((message) =>
			message.type === "result"
				? [
						{
							trace,
							providerSessionId: message.session_id,
							total: message.total_cost_usd,
						},
					]
				: [],
		),
);

test.describe("Claude turn cost", () => {
	test.use({ claudeReplay: { turns: TRACES, holdAfterResult: true } });

	test("shows and stores each turn's spend across wake-ups and a restart", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const parentId = decodeURIComponent(harness.projectUrl.slice("/s/".length));
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("No Claude replayer");
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		// A turn with tools bills in its step log, so open every log first.
		const shownCosts = page
			.locator(".turn-meta > span")
			.filter({ hasText: /^\$/ });
		const stored = () => {
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				return {
					turns: db
						.prepare(
							"SELECT id, cost FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
						)
						.all(parentId)
						.map((row) => ({
							id: String(row["id"]),
							cost: row["cost"] === null ? null : Number(row["cost"]),
						})),
					results: db
						.prepare(`SELECT e.sequence, e.type, m.turn_id,
						json_extract(e.data, '$.providerSessionId') AS provider_session_id,
						json_extract(e.data, '$.providerCostTotalUsd') AS running_total,
						json_extract(e.data, '$.cost') AS cost
						FROM events e LEFT JOIN messages m ON m.id = json_extract(e.data, '$.messageId')
							WHERE e.session_id = ? AND e.type IN ('turn.completed', 'message.completed') ORDER BY e.sequence`)
						.all(parentId)
						.map((row) => ({
							sequence: Number(row["sequence"]),
							type: String(row["type"]),
							turnId: String(row["turn_id"]),
							providerSessionId: String(row["provider_session_id"]),
							runningTotal:
								row["running_total"] === null
									? null
									: Number(row["running_total"]),
							cost: row["cost"] === null ? null : Number(row["cost"]),
						})),
					runs: db
						.prepare(
							"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
						)
						.all(parentId)
						.map((row) => row["status"]),
				};
			} finally {
				db.close();
			}
		};
		const observations: {
			step: string;
			shownCosts: string[];
			stored: ReturnType<typeof stored>;
		}[] = [];
		const record = async (step: string) => {
			observations.push({
				step,
				shownCosts: await shownCosts.allTextContents(),
				stored: stored(),
			});
		};
		try {
			await app.goto(relayUrl);
			await app.sendMessage("Launch the background work");
			await replayer.held();
			await expect.poll(() => stored().results.length).toBe(1);
			// The store can lead the browser: wait for the delivered turn, since
			// the empty Working placeholder it replaces drops its expansion.
			await expect(chat.turnActivityToggles.last()).toContainText("Worked");
			await chat.expandTurnActivity();
			await expect(shownCosts).toHaveText(["$0.2982"]);
			await record("first-result");

			replayer.release();
			await expect
				.poll(() => stored().results.length, { timeout: 60_000 })
				.toBe(4);
			await chat.waitForStreamingComplete();
			await expect(
				chat.assistantMessages.filter({
					hasText: "The top-level 40-second shell finished.",
				}),
			).toBeVisible();
			await chat.expandTurnActivity();
			await expect(shownCosts.last()).toHaveText("$0.4128");
			expect(stored().turns).toHaveLength(1);
			expect(stored().runs).toEqual(["completed"]);
			expect(stored().results.map((result) => result.type)).toEqual([
				"turn.completed",
				"message.completed",
				"message.completed",
				"message.completed",
			]);
			expect(stored().turns[0]?.cost).toBeCloseTo(0.4127606, 12);
			await record("wake-ups-finished");

			await harness.restart();
			await gotoRelay(page, relayUrl);
			await chat.expandTurnActivity();
			await expect(shownCosts.last()).toHaveText("$0.4128");
			await app.sendMessage("Reply with only: ok, still here.");
			await expect
				.poll(() => stored().results.length, { timeout: 30_000 })
				.toBe(5);
			await chat.waitForStreamingComplete();
			await chat.expandTurnActivity();
			await expect(shownCosts.last()).toHaveText("$0.0070");
			await record("resumed-result");

			// Check the persisted transcript on a fresh browser load as well as live.
			await gotoRelay(page, relayUrl);
			await chat.expandTurnActivity();
			await expect(shownCosts).toHaveText(["$0.4128", "$0.0070"]);
			await record("reloaded");
			const final = stored();
			expect(final.turns).toHaveLength(2);
			expect(final.runs).toEqual(["completed", "completed"]);
			expect(final.results.map((result) => result.type)).toEqual([
				"turn.completed",
				"message.completed",
				"message.completed",
				"message.completed",
				"turn.completed",
			]);
			expect(final.results.map((result) => result.runningTotal)).toEqual(
				traceResults.map((result) => result.total),
			);
			expect(
				new Set(traceResults.map((result) => result.providerSessionId)).size,
			).toBe(1);
			expect(
				new Set(final.results.map((result) => result.providerSessionId)).size,
			).toBe(1);
			for (const [index, result] of final.results.entries()) {
				const total = traceResults[index]?.total ?? 0;
				const previous = traceResults[index - 1]?.total ?? 0;
				expect(result.cost).not.toBeNull();
				expect(result.cost).toBeCloseTo(total - previous, 12);
			}
			for (const providerSessionId of new Set(
				final.results.map((result) => result.providerSessionId),
			)) {
				const results = final.results.filter(
					(result) => result.providerSessionId === providerSessionId,
				);
				const turnIds = new Set(results.map((result) => result.turnId));
				const turnCosts = final.turns.filter((turn) => turnIds.has(turn.id));
				expect(turnCosts).toHaveLength(2);
				const total = turnCosts.reduce(
					(sum, turn) => sum + (turn.cost ?? 0),
					0,
				);
				expect(Math.abs(total - 0.4197188)).toBeLessThanOrEqual(1e-9);
				expect(total).toBeCloseTo(results.at(-1)?.runningTotal ?? 0, 12);
			}
			expect(final.turns[1]?.cost).toBeCloseTo(0.0069582, 12);
		} finally {
			const path = testInfo.outputPath("claude-turn-cost-report.json");
			const final = stored();
			const shown = await shownCosts.allTextContents();
			writeFileSync(
				path,
				JSON.stringify(
					{
						parentId,
						traceResults,
						observations,
						final,
						perTurn: final.turns.map((turn, index) => ({
							turnId: turn.id,
							storedCost: turn.cost,
							shownCost: shown[index] ?? null,
						})),
					},
					null,
					2,
				),
			);
			await testInfo.attach("claude-turn-cost-report.json", {
				path,
				contentType: "application/json",
			});
			const screenshot = testInfo.outputPath("claude-turn-cost.png");
			await page.screenshot({
				path: screenshot,
				animations: "disabled",
				fullPage: true,
			});
			await testInfo.attach("claude-turn-cost.png", {
				path: screenshot,
				contentType: "image/png",
			});
		}
	});
});
