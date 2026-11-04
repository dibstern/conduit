import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { STOP_ABORT_WAIT_MS } from "../../../src/lib/provider/orchestration-command-contracts.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Cases and source evidence: docs/plans/2026-10-22-run-ledger-failure-catalogue.md.
// Implement with the isolated process harness, recorded traces and per-case JSON artifacts.
describe("Run Ledger e2e regressions", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.dispose();
			harness.assertNoRunners();
		}
	});

	it.todo("RL-005: Probe OpenCode in the native session directory");
	it.todo(
		"RL-009: Settle migrated legacy results including folded joined inputs",
	);
	it.todo(
		"RL-020: Do not turn transport timeout into proof of native cancellation",
	);
	it.todo(
		"RL-029: Do not authorize shared OpenCode abort with stale local exclusivity",
	);
	it.todo("RL-032: Fence in-flight OpenCode delivery across Stop");
	it.todo("RL-048: Bound the entire replacement warm-up attempt");
	it.todo("RL-052: Expose restart rejection and timeout despite cleanup");
	it.todo(
		"RL-053: Preserve interaction support on a retried background delivery",
	);
	it.todo(
		"RL-058: Defer recoverable resume failure until authorized fallback resolves",
	);
	it.todo("RL-059: Keep Stop visible for a delivery-unknown retained steer");
	it.todo(
		"RL-065: Release the native-session fence when killing a runner fails",
	);
	it.todo("RL-078: Recover Stop deadlines independently of delivery receipts");
	// RL-081, how it could fail: 41. the replacement's submit waits on the interrupt that never answers;
	// 42. A stays running past the Stop's deadline, or ends twice (at the deadline and at its runner's
	// loss); 43. the replacement is dropped or runs before A ends; 44. the question stays Pending.
	// test-waits-allow timeout-override: the Stop's 30 s interrupt deadline runs on the daemon's wall clock.
	it("RL-081: Bound question-replacement interruption", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		// The SDK takes the interrupt and never acknowledges it.
		writeFileSync(
			join(harness.root, "claude", "conduit-test-hold-stop"),
			"hold",
		);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("RL-081");
		const asking = browser
			.send(sessionId, "question-hold-rl081")
			.catch(() => undefined);
		await browser.waitFor((message) => message["type"] === "question_pending");
		const cursor = browser.frames.length;
		const inputId = randomUUID();
		const prompt = "after-question-rl081";
		const submittedAt = Date.now();
		const submitted = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: prompt,
			}),
		);
		const submitMs = Date.now() - submittedAt;
		await harness.waitForMark((mark) => mark.kind === "stop-held");
		const done = await browser
			.waitForTurnEnd(sessionId, cursor, 60_000, inputId)
			.catch((error: unknown) => ({ error: String(error) }));
		const doneMs = Date.now() - submittedAt;
		await asking;
		const db = new Database(harness.daemonStorePath(), { readonly: true });
		try {
			const evidence = {
				submitted,
				submitMs,
				doneMs,
				done,
				ends: db
					.prepare(
						"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.outcome') AS outcome, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
					)
					.all(sessionId),
				questions: db
					.prepare(
						"SELECT type, json_extract(metadata, '$.runId') AS runId FROM events WHERE session_id = ? AND type IN ('question.asked', 'question.resolved') ORDER BY sequence",
					)
					.all(sessionId),
				state: db
					.prepare("SELECT state FROM run_ledger_sessions WHERE session_id = ?")
					.get(sessionId),
				outbox: db
					.prepare(
						"SELECT effect_type AS effect, status, error_code AS code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
					)
					.all(sessionId),
				marks: harness.marks
					.filter((mark) => mark.kind !== "runner-started")
					.map((mark) => mark.kind),
				history: (await browser.history(sessionId)).map((message) => ({
					role: message.role,
					text: message.text,
				})),
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/run-ledger-rl-081.json",
				`${JSON.stringify(evidence, null, "\t")}\n`,
			);
			// 41: the reply is admitted at once, not after the interrupt's deadline.
			expect(submitted).toMatchObject({ ok: true, handedOff: false });
			expect(submitMs).toBeLessThan(STOP_ABORT_WAIT_MS);
			// 42, 43: A ends once, interrupted at the deadline, its runner is retired, then the
			// replacement runs once on a fresh runner.
			expect(done).toMatchObject({ lastTurnEndInputId: inputId });
			expect(
				evidence.ends.map((end) => (end as { outcome: string }).outcome),
			).toEqual(["interrupted", "completed"]);
			expect(evidence.outbox).toEqual([
				{ effect: "send_turn", status: "failed", code: "interrupted" },
				{
					effect: "interrupt_turn",
					status: "failed",
					code: "provider_control_timeout",
				},
				{ effect: "end_session", status: "completed", code: null },
				{ effect: "send_turn", status: "completed", code: null },
			]);
			const closed = evidence.marks.indexOf("query-closed");
			expect(closed).toBeGreaterThan(evidence.marks.indexOf("stop-held"));
			expect(evidence.marks.filter((kind) => kind === "enqueue")).toHaveLength(
				2,
			);
			expect(evidence.marks.lastIndexOf("enqueue")).toBeGreaterThan(closed);
			expect(evidence.history.slice(-2)).toEqual([
				{ role: "user", text: prompt },
				{
					role: "assistant",
					text: `Echo(${prompt}): stream(${prompt}) done(${prompt}).`,
				},
			]);
			// 44: the question resolves and the session reads quiet.
			expect(
				evidence.questions.map((event) => (event as { type: string }).type),
			).toEqual(["question.asked", "question.resolved"]);
			expect(evidence.state).toEqual({ state: "Quiescent" });
		} finally {
			db.close();
		}
	}, 120_000);
	// A guard, not a red proof: a single refused reply already failed before the Stop entry
	// redesign. How it could fail: 70. the refused reply is admitted, or resolves the question;
	// 71. the refusal leaves an interrupt row or an open Stop that blocks the next reply;
	// 72. the next reply waits on the refused Stop instead of being admitted at once.
	// test-waits-allow timeout-override: the held question turn ends at the Stop's 30 s deadline on the daemon's wall clock.
	it("RL-081: a question reply fails when main refuses its Stop", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const refuseGate = join(harness.root, "conduit-test-stop-refuse");
		writeFileSync(refuseGate, "refuse");
		const browser = await harness.connect();
		const sessionId = await browser.createSession("RL-081 refused");
		const asking = browser
			.send(sessionId, "question-hold-refused")
			.catch(() => undefined);
		const askedAt = Date.now();
		await browser.waitFor((message) => message["type"] === "question_pending");
		const askedMs = Date.now() - askedAt;
		const reply = (inputId: string, text: string) =>
			Effect.runPromise(
				Effect.result(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId,
						delivery: "queue",
						text,
					}),
				),
			);
		const db = new Database(harness.daemonStorePath(), { readonly: true });
		try {
			const read = (inputIds: readonly string[]) => ({
				questions: db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type IN ('question.asked', 'question.resolved') ORDER BY sequence",
					)
					.all(sessionId)
					.map((row) => (row as { type: string }).type),
				admitted: inputIds.map(
					(inputId) =>
						(
							db
								.prepare(
									"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'input.admitted' AND json_extract(data, '$.inputId') = ?",
								)
								.get(sessionId, inputId) as { n: number }
						).n,
				),
				outbox: db
					.prepare(
						"SELECT effect_type AS effect, status FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
					)
					.all(sessionId),
			});
			const refusedId = randomUUID();
			const refusingAt = Date.now();
			const refused = await reply(refusedId, "refused-reply");
			const refusedMs = Date.now() - refusingAt;
			await harness.waitForMark((mark) => mark.kind === "stop-refused");
			const afterRefusal = read([refusedId]);
			rmSync(refuseGate);
			const cursor = browser.frames.length;
			const acceptedId = randomUUID();
			const submittedAt = Date.now();
			const accepted = await reply(acceptedId, "accepted-reply");
			const submitMs = Date.now() - submittedAt;
			const done = await browser
				.waitForTurnEnd(sessionId, cursor, 60_000, acceptedId)
				.catch((error: unknown) => ({ error: String(error) }));
			const doneMs = Date.now() - submittedAt;
			await asking;
			const evidence = {
				askedMs,
				refused,
				refusedMs,
				afterRefusal,
				accepted,
				submitMs,
				doneMs,
				done,
				afterAcceptance: read([refusedId, acceptedId]),
				marks: harness.marks
					.filter((mark) => mark.kind !== "runner-started")
					.map((mark) => mark.kind),
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/run-ledger-stop-refused.json",
				`${JSON.stringify(evidence, null, "\t")}\n`,
			);
			// 70: the refused reply fails, is not admitted and leaves the question pending.
			expect(refused._tag).toBe("Failure");
			expect(afterRefusal).toMatchObject({
				questions: ["question.asked"],
				admitted: [0],
			});
			// 71: the refusal writes no interrupt row.
			expect(
				afterRefusal.outbox.map((row) => (row as { effect: string }).effect),
			).not.toContain("interrupt_turn");
			// 72: with main accepting, the next reply is admitted at once and runs; the question resolves.
			expect(accepted).toMatchObject({
				_tag: "Success",
				success: { ok: true, handedOff: false },
			});
			expect(submitMs).toBeLessThan(STOP_ABORT_WAIT_MS);
			expect(done).toMatchObject({ lastTurnEndInputId: acceptedId });
			expect(evidence.afterAcceptance).toMatchObject({
				questions: ["question.asked", "question.resolved"],
				admitted: [0, 1],
			});
		} finally {
			db.close();
		}
	}, 120_000);
	it.todo("RL-085: Retain undelivered forced retirement across downtime");
	it.todo("RL-087: Keep shared OpenCode abort fenced through execution");
	it.todo(
		"RL-091: Preserve every process-proof scenario under concurrent writers",
	);
	it.todo(
		"RL-092: Preserve accepted effects during temporary relay replacement",
	);
	it.todo(
		"RL-096: Verify surviving native ownership before synthetic project refusal",
	);
	it.todo("RL-105: Preserve the admitted idle policy on daemon replay");
	it.todo("RL-106: Preserve retained idle policy when a legacy send omits it");
	it.todo(
		"RL-108: Preserve admitted idle policy across warm runner replacement",
	);
	it.todo(
		"RL-109: Do not seed replacement policy from a send refused before admission",
	);
	it.todo(
		"RL-110: Respect a newer legacy admission before restoring an old policy",
	);
	it.todo(
		"RL-111: Reconcile journal admission before choosing replacement idle policy",
	);
	it.todo(
		"RL-112: Forward the shared config snapshot to dynamically added projects",
	);
	it.todo("RL-114: Settle recovered failures for fallback-suffixed bindings");
});
