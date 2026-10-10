import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

function ledger(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.projectStorePath(), { readonly: true });
	try {
		return {
			queued: (
				db
					.prepare(
						"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at",
					)
					.all(sessionId) as Array<{ input_id: string }>
			).map((row) => row.input_id),
			sent: (
				db
					.prepare(
						"SELECT json_extract(data, '$.inputId') AS input_id FROM events WHERE session_id = ? AND type = 'input.sent' ORDER BY sequence",
					)
					.all(sessionId) as Array<{ input_id: string }>
			).map((row) => row.input_id),
			turns: (
				db
					.prepare(
						"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
					)
					.all(sessionId) as Array<{ state: string }>
			).map((row) => row.state),
		};
	} finally {
		db.close();
	}
}

// The Claude runner is its own process and outlives a server restart, so only
// this lane can restart with a turn that still finishes normally afterwards.
// Failure cases: the queued input is lost, the startup sweep sends it while
// the adopted turn still runs, or the queue stays stuck once that turn ends.
describe("queued input across a restart", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("carries on once the turn that survived the restart ends normally", async () => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
		});
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Queue across restart");
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				providerId: "claude",
				modelId: "claude-sonnet-4",
			}),
		);
		// This fixture pauses after its first delta until release-upgrade-turn.
		void browser.send(sessionId, "upgrade-long-turn").catch(() => undefined);
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["role"] === "assistant" &&
				message["sessionId"] === sessionId &&
				(
					message["parts"] as { type: string; text?: string }[] | undefined
				)?.some((part) => part.type === "text" && Boolean(part.text)) === true,
		);
		const queuedId = randomUUID();
		await Effect.runPromise(
			browser.rpc.input.submit({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				inputId: queuedId,
				delivery: "queue",
				text: "after the restart",
			}),
		);
		const running = harness;
		await vi.waitFor(() =>
			expect(ledger(running, sessionId).queued).toEqual([queuedId]),
		);
		const before = ledger(harness, sessionId);
		const [first] = before.sent;

		await harness.signal("SIGINT");
		await harness.restart();
		const reconnected = await harness.connect(sessionId);
		// Startup has run its sweep; the adopted turn still holds the queue.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const restarted = ledger(harness, sessionId);
		expect(restarted).toEqual({
			queued: [queuedId],
			sent: [first],
			turns: ["running"],
		});

		const done = reconnected.waitForTurnEnd(
			sessionId,
			reconnected.frames.length,
		);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		expect((await done)["status"]).toBe("idle");
		const resumed = harness;
		await vi.waitFor(
			() =>
				expect(ledger(resumed, sessionId)).toEqual({
					queued: [],
					sent: [first, queuedId],
					turns: ["completed", "completed"],
				}),
			{ timeout: 15_000 },
		);

		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-jyr9-queue-restart.json",
			JSON.stringify(
				{
					sessionId,
					queuedId,
					before,
					restarted,
					final: ledger(harness, sessionId),
				},
				null,
				2,
			),
		);
	}, 45_000);
});
