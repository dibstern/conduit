import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const traceName = "subagent-task-turn";
const trace = readFileSync(
	new URL(
		`../../fixtures/claude-sdk-traces/${traceName}.jsonl`,
		import.meta.url,
	),
	"utf8",
)
	.trim()
	.split("\n")
	.map((line) => decodeClaudeSDKMessage(JSON.parse(line)));
const reportLine =
	trace.findIndex(
		(message) =>
			message.type === "system" && message.subtype === "task_updated",
	) + 1;

function ledger(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			commands: db
				.prepare(
					"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
			turns: db
				.prepare(
					"SELECT state, run_id FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId) as Array<{ state: string; run_id: string | null }>,
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId) as Array<{ id: string; status: string }>,
			terminals: db
				.prepare(`SELECT type, json_extract(metadata, '$.runId') AS run_id,
				json_extract(data, '$.error') AS error FROM events
				WHERE session_id = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted') ORDER BY sequence`)
				.all(sessionId),
		};
	} finally {
		db.close();
	}
}

function childId(fixture: ProcessHarness, parentId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const row = db
			.prepare(`SELECT DISTINCT json_extract(part.metadata, '$.childSessionId') AS id
			FROM message_parts part JOIN messages message ON message.id = part.message_id
			WHERE message.session_id = ? AND part.type = 'tool'
			AND json_extract(part.metadata, '$.childSessionId') IS NOT NULL`)
			.get(parentId) as { id: string } | undefined;
		if (!row) throw new Error("Parent has no subagent tool link");
		return row.id;
	} finally {
		db.close();
	}
}

// Failure modes: missing run ownership, guessed success without a report, lost
// daemon memory on adoption, child-only recovery, and parent_id catching forks.
describe("durable Claude subagent child runs through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let proof: Record<string, unknown>;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			if (proof) {
				proof["result"] = task.result?.state;
				proof["remainingRunnerPids"] = harness?.remainingRunnerPids();
				proofs.push(proof);
			}
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ev71p-child-runs.json",
				`${JSON.stringify(proofs, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	for (const [report, expected, updatedOnly = false] of [
		["completed", "completed"],
		["failed", "error"],
		["stopped", "interrupted"],
		["killed", "interrupted", true],
		["failed", "error", true],
	] as const) {
		it(`settles a ${report} task as ${expected} with durable run ownership (${updatedOnly ? "task_updated" : "task_notification"})`, async () => {
			proof = { case: report, updatedOnly };
			const replay = { turns: [traceName] as const, tracesDir: "" };
			const fixture = ProcessHarness.create({ claudeReplay: replay });
			harness = fixture;
			replay.tracesDir = join(fixture.root, "traces");
			mkdirSync(replay.tracesDir);
			// Exercise notification summaries and task_updated's own error field.
			const variant = trace
				.filter(
					(message) =>
						message.type !== "system" ||
						((message.subtype !== "task_updated" ||
							report === "completed" ||
							updatedOnly) &&
							(message.subtype !== "task_notification" || !updatedOnly)),
				)
				.map((message) => {
					if (message.type === "system" && message.subtype === "task_updated")
						return JSON.stringify({
							...message,
							patch: {
								...message.patch,
								status: report,
								...(report === "failed"
									? { error: "child report summary" }
									: {}),
							},
						});
					if (
						message.type === "system" &&
						message.subtype === "task_notification"
					)
						return JSON.stringify({
							...message,
							status: report,
							summary: "child report summary",
						});
					return JSON.stringify(message);
				});
			writeFileSync(
				join(replay.tracesDir, `${traceName}.jsonl`),
				variant.join("\n"),
			);
			await fixture.restart();
			const browser = await fixture.connect();
			const parent = await browser.createSession(`Child ${report}`);
			await browser.send(parent, "Ask a subagent to summarise package.json");
			const child = childId(fixture, parent);
			await vi.waitFor(
				() => {
					const state = ledger(fixture, child);
					expect(state.runs).toHaveLength(1);
					const runId = state.runs[0]?.id;
					expect(runId).toEqual(expect.any(String));
					expect(state.turns).toEqual([{ state: expected, run_id: runId }]);
					expect(state.runs).toEqual([{ id: runId, status: expected }]);
					expect(state.terminals).toEqual([
						{
							type: `turn.${expected}`,
							run_id: runId,
							error: report === "failed" ? "child report summary" : null,
						},
					]);
				},
				{ timeout: 10_000 },
			);
			proof["child"] = ledger(fixture, child);
		});
	}

	for (const phase of ["live", "adopted", "offline"] as const) {
		it(`interrupts an open child when the ${phase} runner dies and preserves a Side Thread`, async () => {
			proof = { case: phase };
			const fixture = ProcessHarness.create({
				claudeReplay: { turns: [traceName] },
			});
			harness = fixture;
			writeFileSync(
				join(fixture.root, "claude-replay-hold"),
				JSON.stringify({ turn: 1, message: reportLine, id: 1 }),
			);
			await fixture.restart();
			let browser = await fixture.connect();
			const parent = await browser.createSession(
				"Runner loss with an open child",
			);
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: parent,
					originId: browser.originId,
					inputId: randomUUID(),
					text: "Ask a subagent to summarise package.json",
					delivery: "queue",
				}),
			);
			let child = "";
			await vi.waitFor(
				() => {
					expect(
						existsSync(join(fixture.root, "claude-replay-hold.reached")),
					).toBe(true);
					child = childId(fixture, parent);
					expect(ledger(fixture, child).runs.map((run) => run.status)).toEqual([
						"running",
					]);
				},
				{ timeout: 15_000 },
			);
			const mark = await fixture.waitForMark(
				(item) => item.kind === "runner-started" && item.sessionId === parent,
			);
			if (mark.kind !== "runner-started")
				throw new Error("Missing runner start");
			const side = await browser.createSession("Independent Side Thread");
			const nested = await browser.createSession("Nested subagent");
			const inherited = await browser.createSession("Source runner's subagent");
			const db = new Database(fixture.daemonStorePath());
			try {
				db.prepare("UPDATE sessions SET parent_id = ? WHERE id = ?").run(
					parent,
					side,
				);
				db.prepare(
					"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (?, ?, 'running', 1)",
				).run("side-run", side);
				db.prepare(
					"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('side-prompt', ?, 'user', 1, 1)",
				).run(side);
				db.prepare(
					"INSERT INTO turns (id, session_id, user_message_id, run_id, state, requested_at) VALUES ('side-prompt', ?, 'side-prompt', 'side-run', 'running', 1)",
				).run(side);
				// Nested tool links belong to their issuing child, while lineage
				// still points at the root runner's session.
				db.prepare("UPDATE sessions SET parent_id = ? WHERE id = ?").run(
					parent,
					nested,
				);
				expect(
					db
						.prepare(`INSERT INTO message_parts (id, message_id, type, metadata, sort_order, created_at, updated_at)
					SELECT 'nested-link', id, 'tool', ?, 99, 1, 1 FROM messages
					WHERE session_id = ? AND role = 'assistant' LIMIT 1`)
						.run(JSON.stringify({ childSessionId: nested }), child).changes,
				).toBe(1);
				db.prepare(
					"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('nested-run', ?, 'running', 1)",
				).run(nested);
				db.prepare(
					"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('nested-prompt', ?, 'user', 1, 1)",
				).run(nested);
				db.prepare(
					"INSERT INTO turns (id, session_id, user_message_id, run_id, state, requested_at) VALUES ('nested-prompt', ?, 'nested-prompt', 'nested-run', 'running', 1)",
				).run(nested);
				// A fork copies its source's launchers, but their children belong
				// to the source runner, so this runner's exit must not settle them.
				db.prepare(
					"INSERT INTO messages (id, session_id, role, created_at, updated_at, is_inherited) VALUES ('inherited-launcher', ?, 'assistant', 1, 1, 1)",
				).run(parent);
				db.prepare(
					"INSERT INTO message_parts (id, message_id, type, metadata, sort_order, created_at, updated_at) VALUES ('inherited-link', 'inherited-launcher', 'tool', ?, 0, 1, 1)",
				).run(JSON.stringify({ childSessionId: inherited }));
				db.prepare(
					"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('inherited-run', ?, 'running', 1)",
				).run(inherited);
			} finally {
				db.close();
			}
			proof["before"] = ledger(fixture, child);
			if (phase !== "live") {
				await fixture.kill();
				expect(() => process.kill(mark.pid, 0)).not.toThrow();
				if (phase === "adopted") {
					const cursor = fixture.marks.length;
					await fixture.restart();
					browser = await fixture.connect(parent);
					const adopted = await fixture.waitForMark(
						(item) =>
							item.kind === "runner-started" && item.sessionId === parent,
						cursor,
					);
					expect(adopted).toMatchObject({ pid: mark.pid });
					expect(ledger(fixture, child)).toEqual(proof["before"]);
					expect(ledger(fixture, nested)).toMatchObject({
						runs: [{ id: "nested-run", status: "running" }],
						terminals: [],
					});
				}
			}
			process.kill(mark.pid, "SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(mark.pid, 0)).toThrow(),
				{ timeout: 5000 },
			);
			if (phase === "offline") await fixture.restart();
			await vi.waitFor(
				() => {
					const state = ledger(fixture, child);
					expect(state.runs.map((run) => run.status)).toEqual(["interrupted"]);
					expect(state.turns).toEqual([
						{ state: "interrupted", run_id: state.runs[0]?.id },
					]);
					expect(state.terminals).toEqual([
						{
							type: "turn.interrupted",
							run_id: state.runs[0]?.id,
							error: null,
						},
					]);
					expect(ledger(fixture, nested)).toMatchObject({
						runs: [{ id: "nested-run", status: "interrupted" }],
						turns: [{ state: "interrupted", run_id: "nested-run" }],
					});
				},
				{ timeout: 15_000 },
			);
			expect(ledger(fixture, side)).toMatchObject({
				runs: [{ id: "side-run", status: "running" }],
				turns: [{ state: "running", run_id: "side-run" }],
				terminals: [],
			});
			expect(ledger(fixture, inherited)).toMatchObject({
				runs: [{ id: "inherited-run", status: "running" }],
				terminals: [],
			});
			proof["after"] = ledger(fixture, child);
			proof["side"] = ledger(fixture, side);
		});
	}

	it("recovers an undelivered child terminal after the parent command completed and its runner died offline", async () => {
		proof = { case: "completed-parent-with-undelivered-child-terminal" };
		const fixture = await ProcessHarness.start({
			claudeReplay: { turns: [traceName] },
		});
		harness = fixture;
		const browser = await fixture.connect();
		const parent = await browser.createSession(
			"Completed parent with a lost child terminal",
		);
		await browser.send(parent, "Ask a subagent to summarise package.json");
		const child = childId(fixture, parent);
		const mark = await fixture.waitForMark(
			(item) => item.kind === "runner-started" && item.sessionId === parent,
		);
		if (mark.kind !== "runner-started") throw new Error("Missing runner start");
		await vi.waitFor(
			() =>
				expect(ledger(fixture, parent).commands).toEqual([
					{ status: "completed" },
				]),
			{ timeout: 10_000 },
		);
		await fixture.kill();
		// Reproduce durable state left by a timed-out terminal delivery. There
		// is no parent command to recover and no daemon-owned child cohort.
		const db = new Database(fixture.daemonStorePath());
		try {
			expect(
				db
					.prepare(
						"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
					)
					.all(parent),
			).toEqual([{ status: "completed" }]);
			db.prepare(
				"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('undelivered-run', ?, 'running', ?)",
			).run(child, Date.now());
			db.prepare(
				"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('undelivered-prompt', ?, 'user', 1, 1)",
			).run(child);
			db.prepare(
				"INSERT INTO turns (id, session_id, user_message_id, run_id, state, requested_at) VALUES ('undelivered-prompt', ?, 'undelivered-prompt', 'undelivered-run', 'running', 1)",
			).run(child);
		} finally {
			db.close();
		}
		process.kill(mark.pid, "SIGKILL");
		await vi.waitFor(() => expect(() => process.kill(mark.pid, 0)).toThrow(), {
			timeout: 5000,
		});
		await fixture.restart();
		await vi.waitFor(
			() => {
				const state = ledger(fixture, child);
				expect(
					state.runs.find((run) => run.id === "undelivered-run")?.status,
				).toBe("interrupted");
				expect(
					state.turns.filter((turn) => turn.run_id === "undelivered-run"),
				).toEqual([{ state: "interrupted", run_id: "undelivered-run" }]);
				expect(
					state.runs.some(
						(run) => run.status === "pending" || run.status === "running",
					),
				).toBe(false);
				expect(
					state.turns.some(
						(turn) => turn.state === "pending" || turn.state === "running",
					),
				).toBe(false);
			},
			{ timeout: 10_000 },
		);
		proof["after"] = ledger(fixture, child);
	});
});
