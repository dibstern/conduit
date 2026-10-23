import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function sdkProof(harness: ProcessHarness): ProcessMark[] {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProcessMark);
}

function sessionStatus(db: Database.Database, sessionId: string) {
	return db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId);
}

// Failures: Stop misses the runner's input, canUseTool never settles, cleanup
// retires the runner, the next send wedges, or reconciliation hides the wait.
describe("Stop releases a Claude turn awaiting user input", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness?.assertNoRunners();
		const record = evidence.at(-1);
		if (record) record["remainingRunnerPids"] = harness?.remainingRunnerPids();
		harness = undefined;
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/u1y3i-3-blocked-stop.json",
			JSON.stringify(evidence, null, 2),
		);
	});

	it.each([
		"question",
		"permission",
	] as const)("preserves a successor %s when an earlier idle Stop arrives late", async (interaction) => {
		const record: Record<string, unknown> = {
			interaction,
			scenario: "delayed-idle-stop",
			passed: false,
		};
		evidence.push(record);
		harness = ProcessHarness.create({ restartProof: true });
		const active = harness;
		record["root"] = active.root;
		await active.restart({ startupTimeoutMs: 60_000 });
		const browser = await active.connect();
		const sessionId = await browser.createSession(
			`Delayed Stop ${interaction}`,
		);
		record["sessionId"] = sessionId;
		await browser.send(sessionId, "seed-idle-stop");
		const db = new Database(active.daemonStorePath());
		const oldCommandId = randomUUID();
		try {
			db.exec(`CREATE TRIGGER hold_idle_stop BEFORE UPDATE OF status ON provider_command_outbox
					WHEN NEW.command_id = '${oldCommandId}' AND NEW.status = 'running'
					BEGIN SELECT RAISE(IGNORE); END`);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId: oldCommandId }),
			);
			const send = browser
				.send(
					sessionId,
					`${interaction === "question" ? "question" : "approval"}-fixed-later-turn`,
				)
				.catch(() => undefined);
			await browser.waitFor(
				(frame) =>
					frame["type"] ===
					(interaction === "question"
						? "question_pending"
						: "permission_pending"),
				0,
				15_000,
			);
			db.exec("DROP TRIGGER hold_idle_stop");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(oldCommandId),
					).toEqual({ status: "completed" }),
				{ timeout: 5_000 },
			);
			expect(
				sdkProof(active).filter((mark) => mark.kind === "prompt-answer"),
			).toHaveLength(0);
			expect(sessionStatus(db, sessionId)).toEqual({ status: "busy" });
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
			);
			await send;
			const reply = await browser.send(sessionId, "after-fresh-stop");
			expect(reply.chunks.join("")).toBe(
				responseChunks("after-fresh-stop").join(""),
			);
			record["passed"] = true;
		} finally {
			record["sdk"] = sdkProof(active);
			record["events"] = db
				.prepare(
					"SELECT sequence, type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId);
			db.close();
		}
	}, 90_000);

	it.each([
		...(["question", "permission"] as const).flatMap((interaction) =>
			(["matching", "empty", "mismatched"] as const).map((ids) => ({
				interaction,
				ids,
				acknowledgement: "immediate",
				snapshot: "current",
			})),
		),
		...(["question", "permission"] as const).map((interaction) => ({
			interaction,
			ids: "matching" as const,
			acknowledgement: "after-decision",
			snapshot: "current",
		})),
		...(["question", "permission"] as const).map((interaction) => ({
			interaction,
			ids: "empty" as const,
			acknowledgement: "immediate",
			snapshot: "legacy",
		})),
	])("ends a pending $interaction with $ids IDs, $acknowledgement acknowledgement and $snapshot snapshot", async ({
		interaction,
		ids,
		acknowledgement,
		snapshot,
	}) => {
		const record: Record<string, unknown> = {
			interaction,
			ids,
			acknowledgement,
			snapshot,
			passed: false,
		};
		evidence.push(record);
		harness = ProcessHarness.create({ restartProof: true });
		const active = harness;
		await active.restart({ startupTimeoutMs: 60_000 });
		const browser = await active.connect();
		const sessionId = await browser.createSession(
			`Blocked ${interaction} ${ids}`,
		);
		const prompt = `${interaction === "question" ? "question" : "approval"}-fixed-stop-${ids}-${acknowledgement}`;
		const send = browser.send(sessionId, prompt).then(
			() => ({ ok: true }),
			(error: unknown) => ({ error: String(error) }),
		);
		const request = await browser.waitFor(
			(frame) =>
				frame["type"] ===
				(interaction === "question"
					? "question_pending"
					: "permission_pending"),
			0,
			15_000,
		);
		const runnerPids = active.runnerPids();
		expect(runnerPids).toHaveLength(1);
		const db = new Database(active.daemonStorePath());
		record["sessionId"] = sessionId;
		record["request"] = request;
		record["runnerPidsBefore"] = runnerPids;
		try {
			expect(
				sdkProof(active).filter((mark) => mark.kind === "prompt-answer"),
			).toHaveLength(0);
			if (ids !== "matching") {
				// Fault-inject the daemon's captured IDs at its durable delivery boundary.
				// Preserve run ownership so the normal Stop fence still awaits a terminal.
				const captured =
					ids === "empty" ? "json_array()" : "json_array('unknown-input')";
				const original =
					snapshot === "legacy"
						? "json_remove(payload_json, '$.stop')"
						: "payload_json";
				db.exec(`CREATE TRIGGER stop_ids AFTER INSERT ON provider_command_outbox
					WHEN NEW.effect_type = 'interrupt_turn'
					BEGIN UPDATE provider_command_outbox
					SET payload_json = json_set(${original}, '$.turnIds', ${captured})
					WHERE command_id = NEW.command_id; END`);
			}
			const commandId = randomUUID();
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			).then(
				() => ({ ok: true }),
				(error: unknown) => ({ error: String(error) }),
			);
			await vi.waitFor(
				() => {
					const answers = sdkProof(active).filter(
						(mark) => mark.kind === "prompt-answer" && mark.prompt === prompt,
					);
					expect(answers).toHaveLength(1);
					expect(answers[0]).toMatchObject({ response: { behavior: "deny" } });
					expect(sessionStatus(db, sessionId)).toEqual({ status: "idle" });
				},
				{ timeout: 5_000 },
			);
			expect(await stop).toEqual({ ok: true });
			expect(await send).toEqual({ ok: true });
			const payload = db
				.prepare(
					"SELECT payload_json FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(commandId) as { payload_json: string };
			const delivered = JSON.parse(payload.payload_json) as {
				turnIds: string[];
			};
			if (snapshot === "legacy") expect(delivered).not.toHaveProperty("stop");
			expect(delivered.turnIds).toEqual(
				ids === "matching"
					? [expect.any(String)]
					: ids === "empty"
						? []
						: ["unknown-input"],
			);
			record["stopPayload"] = delivered;
			const reply = await browser.send(sessionId, "after-blocked-stop");
			expect(reply.chunks.join("")).toBe(
				responseChunks("after-blocked-stop").join(""),
			);
			expect(active.runnerPids()).toEqual(runnerPids);
			expect(active.remainingRunnerPids()).toEqual(runnerPids);
			record["runnerPidsAfter"] = active.runnerPids();
			record["reply"] = reply;
			record["passed"] = true;
		} finally {
			record["sdk"] = sdkProof(active);
			record["events"] = db
				.prepare(
					"SELECT sequence, type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId);
			db.close();
		}
	}, 90_000);

	it.each([
		"question",
		"permission",
	] as const)("keeps a pending %s busy beyond the stale-busy window", async (interaction) => {
		const record: Record<string, unknown> = {
			interaction,
			scenario: "stale-busy",
			passed: false,
		};
		evidence.push(record);
		harness = ProcessHarness.create({ restartProof: true });
		const active = harness;
		await active.restart({ startupTimeoutMs: 60_000 });
		const browser = await active.connect();
		const sessionId = await browser.createSession(`Stale ${interaction}`);
		const controlId = await browser.createSession(
			"Stale reconciliation control",
		);
		const send = browser
			.send(
				sessionId,
				`${interaction === "question" ? "question" : "approval"}-fixed-stale`,
			)
			.catch(() => undefined);
		await browser.waitFor(
			(frame) =>
				frame["type"] ===
				(interaction === "question"
					? "question_pending"
					: "permission_pending"),
			0,
			15_000,
		);
		const db = new Database(active.daemonStorePath());
		const corrections = (id: string) =>
			db
				.prepare(
					`SELECT sequence, data, metadata FROM events WHERE session_id = ?
				AND type = 'session.status' AND json_extract(metadata, '$.source') = 'reconciliation-loop'`,
				)
				.all(id);
		try {
			const before = sessionStatus(db, sessionId);
			expect(before).toEqual({ status: "busy" });
			const staleAt = Date.now() - 31 * 60_000;
			db.prepare(
				"UPDATE sessions SET status = 'busy', updated_at = ? WHERE id IN (?, ?)",
			).run(staleAt, sessionId, controlId);
			await vi.waitFor(() => expect(corrections(controlId)).toHaveLength(1), {
				timeout: 20_000,
			});
			expect(sessionStatus(db, controlId)).toEqual({ status: "idle" });
			expect(sessionStatus(db, sessionId)).toEqual(before);
			expect(corrections(sessionId)).toEqual([]);
			expect(
				sdkProof(active).filter((mark) => mark.kind === "prompt-answer"),
			).toHaveLength(0);
			record["staleAt"] = staleAt;
			record["waitingStatus"] = before;
			record["controlCorrections"] = corrections(controlId);
			record["waitingCorrections"] = corrections(sessionId);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
			);
			await send;
			record["passed"] = true;
		} finally {
			record["sdk"] = sdkProof(active);
			record["events"] = db
				.prepare(
					"SELECT sequence, type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId);
			db.close();
		}
	}, 90_000);
});
