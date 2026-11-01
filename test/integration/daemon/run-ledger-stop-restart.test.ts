// A.20 trace 2 over the full Layer graph (CONTRACT.md 12.2 row 32.3): a Claude Stop commits its
// interrupt_turn, the daemon dies before the host answers, and a new daemon process builds the whole
// graph over the same store while the process runner survives. How it could fail:
// 1. U2's restore misses the committed Stop, or starts a second one (a second interrupt_turn row);
// 2. the arm's replay from zero inserts an outbox row, or folds entries or a deadline other than
//    the ones the live write folded;
// 3. the Run ends twice, or by the deadline's retirement (`runner_stopped`, an `end_session`
//    retire row) or a `provider_process_gone` cancel instead of the host's terminal;
// 4. the stop outlives the host's terminal, so a following send waits for the deadline.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

describe("Run Ledger: a Stop across a full daemon rebuild over a surviving runner", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.dispose();
			harness.assertNoRunners();
		}
	});

	it("restores the committed Stop, replays the arm with no outbox row, and the host's terminal ends the stop and the Run once", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		// The host receives the interrupt and holds its answer until released.
		writeFileSync(
			join(harness.root, "claude", "conduit-test-hold-stop"),
			"hold",
		);
		const before = await harness.connect();
		const sessionId = await before.createSession("A.20 trace 2");
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		const outbox = db.prepare<
			[string],
			{
				command_id: string;
				effect_type: string;
				run_id: string | null;
				status: string;
				error_code: string | null;
			}
		>(
			"SELECT command_id, effect_type, run_id, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
		);
		const ledger = () => ({
			entries: db
				.prepare(
					"SELECT entry_seq, event_sequence, entry_json FROM run_ledger_entries WHERE session_id = ? ORDER BY entry_seq",
				)
				.all(sessionId) as { entry_json: string }[],
			row: db
				.prepare(
					"SELECT provider, state, alarm_at FROM run_ledger_sessions WHERE session_id = ?",
				)
				.get(sessionId),
		});
		try {
			// The turn runs until released; a Stop waits on its Run, so neither is awaited here.
			const turn = before
				.send(sessionId, "upgrade-long-turn")
				.catch(() => undefined);
			await harness.waitForMark((mark) => mark.kind === "assistant-held");
			const stopping = Effect.runPromise(
				before.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
			await harness.waitForMark((mark) => mark.kind === "stop-held");
			const stop = db
				.prepare(
					"SELECT status, json_extract(payload_json, '$.stop.deadlineAt') AS deadline_at, json_extract(payload_json, '$.stop.owners[0].runId') AS run_id FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(commandId) as {
				status: string;
				deadline_at: number;
				run_id: string;
			};
			expect(stop.status).toBe("running");
			const committed = { outbox: outbox.all(sessionId), ledger: ledger() };
			// The live fold holds one Stop control with the row's deadline; the ledger arms no alarm
			// for it while the runner's main run is open.
			expect(
				committed.ledger.entries
					.map(
						({ entry_json }) =>
							JSON.parse(entry_json) as {
								command?: { control?: { kind: string } };
							},
					)
					.filter(({ command }) => command?.control?.kind === "stop"),
			).toMatchObject([
				{ command: { control: { commandId, deadlineAt: stop.deadline_at } } },
			]);
			expect(committed.ledger.row).toMatchObject({
				state: "Open",
				alarm_at: null,
			});

			await harness.kill();
			await Promise.all([turn, stopping]);
			// F16: the arm replays from zero at restart, its cursor and rows gone.
			db.exec(`DELETE FROM projector_cursors WHERE projector_name = 'run-ledger';
				DELETE FROM run_ledger_entries; DELETE FROM run_ledger_sessions;`);
			await harness.restart({ startupTimeoutMs: 60_000 });
			const after = await harness.connect(sessionId);

			// 2: the replay folded what the live write folded and inserted no outbox row.
			const replayed = { outbox: outbox.all(sessionId), ledger: ledger() };
			expect(replayed.ledger).toEqual(committed.ledger);
			expect(
				replayed.outbox.map(({ command_id, effect_type }) => ({
					command_id,
					effect_type,
				})),
			).toEqual(
				committed.outbox.map(({ command_id, effect_type }) => ({
					command_id,
					effect_type,
				})),
			);

			// The surviving host's turn ends on its own; its interrupt is still unanswered.
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await after.waitForTurnEnd(sessionId);
			// 4: a following send runs once the host's terminal ends the stop, before its deadline.
			const next = await after.send(sessionId, "after-trace-2");
			expect(next.chunks.join("")).toContain("after-trace-2");
			const settledAt = Date.now();
			expect(settledAt).toBeLessThan(stop.deadline_at);

			const rows = outbox.all(sessionId);
			// 1: one Stop, completed by the host's terminal; no retirement.
			expect(
				rows.filter(({ effect_type }) => effect_type === "interrupt_turn"),
			).toMatchObject([{ command_id: commandId, status: "completed" }]);
			expect(
				rows.filter(({ effect_type }) => effect_type === "end_session"),
			).toEqual([]);
			expect(
				rows.filter(({ error_code }) => error_code === "provider_process_gone"),
			).toEqual([]);
			// 3: the Run ends once, by the host's terminal.
			const terminals = db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.interrupted', 'turn.error') AND json_extract(metadata, '$.runId') = ?",
				)
				.all(sessionId, stop.run_id) as { type: string; data: string }[];
			expect(terminals).toHaveLength(1);
			expect(terminals[0]?.data).not.toContain("runner_stopped");
			const ends = ledger().entries.filter(({ entry_json }) => {
				const entry = JSON.parse(entry_json) as {
					kind: string;
					runId?: string;
				};
				return entry.kind === "end" && entry.runId === stop.run_id;
			});
			expect(ends).toHaveLength(1);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/run-ledger-a20-trace-2.json",
				`${JSON.stringify(
					{
						sessionId,
						stop: { commandId, ...stop },
						committed,
						replayed,
						settledAt,
						outbox: rows,
						terminals,
						ends,
					},
					null,
					"\t",
				)}\n`,
			);
		} finally {
			db.close();
		}
	});
});
