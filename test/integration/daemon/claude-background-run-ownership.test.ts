import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const shellId = "toolu_01WQY3MCEqQ1GJBXtwPAicoj";

function ledger(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			turns: db
				.prepare(
					"SELECT id, state, run_id, assistant_message_id, cost, completed_at FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as {
				id: string;
				state: string;
				run_id: string;
				assistant_message_id: string | null;
				cost: number | null;
				completed_at: number | null;
			}[],
			messages: db
				.prepare(
					"SELECT id, turn_id, cost FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at, rowid",
				)
				.all(sessionId) as {
				id: string;
				turn_id: string | null;
				cost: number | null;
			}[],
			shell: db
				.prepare(
					"SELECT mp.message_id, m.turn_id, mp.status FROM message_parts mp JOIN messages m ON m.id = mp.message_id WHERE mp.id = ? AND m.session_id = ?",
				)
				.get(shellId, sessionId) as
				| { message_id: string; turn_id: string | null; status: string }
				| undefined,
			events: db
				.prepare(
					"SELECT sequence, type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId)
				.map((row) => {
					const event = row as {
						sequence: number;
						type: string;
						data: string;
						metadata: string;
					};
					return {
						sequence: event.sequence,
						type: event.type,
						data: JSON.parse(event.data) as Record<string, unknown>,
						runId: (JSON.parse(event.metadata) as { runId?: string }).runId,
					};
				}),
			queued: db
				.prepare(
					"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued'",
				)
				.all(sessionId).length,
		};
	} finally {
		db.close();
	}
}

function normalized(state: ReturnType<typeof ledger>) {
	const run = (id: string | undefined) =>
		state.runs.findIndex((row) => row.id === id) + 1 || null;
	const turn = (id: unknown) =>
		state.turns.findIndex((row) => row.id === id) + 1 || null;
	const messageTurn = (id: unknown) =>
		turn(state.messages.find((row) => row.id === id)?.turn_id);
	return {
		runs: state.runs.map((row) => ({ run: run(row.id), status: row.status })),
		turns: state.turns.map((row) => ({
			state: row.state,
			run: run(row.run_id),
			cost: row.cost,
			assistantMessageTurn: messageTurn(row.assistant_message_id),
		})),
		shell: state.shell && {
			turn: turn(state.shell.turn_id),
			status: state.shell.status,
		},
		toolEvents: state.events
			.filter((event) => event.data["partId"] === shellId)
			.map((event) => ({
				type: event.type,
				run: run(event.runId),
				messageTurn: messageTurn(event.data["messageId"]),
			})),
		terminals: state.events
			.filter((event) =>
				["turn.completed", "turn.error", "turn.interrupted"].includes(
					event.type,
				),
			)
			.map((event) => ({ type: event.type, run: run(event.runId) })),
		queued: state.queued,
	};
}

// Failure modes: a late start borrows the active run/message, an update moves
// the old part or assistant pointer, completion reopens run 1, or run 2 loses
// its terminal/cost and strands queued input. Sources and derivation live
// beside background-shell-during-next-turn.jsonl.
describe("Claude background tools retain their launching run through the isolated daemon", () => {
	let harness: ProcessHarness | undefined;
	const cases: Record<string, unknown>[] = [];
	let proof: Record<string, unknown>;

	afterEach(async ({ task }) => {
		try {
			if (task.result?.errors?.length && harness)
				writeFileSync(`/tmp/82tn25-${proof["case"]}.log`, harness.logTail);
			await harness?.dispose();
			harness?.assertNoRunners();
			proof["cleanup"] = "no fixture runners remain";
		} finally {
			proof["outcome"] = task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn25-background-run-proof.json",
				`${JSON.stringify({ cases }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	for (const trace of [
		"background-shell-during-next-turn",
		"background-shell-during-next-turn-metadata-only",
	] as const) {
		it(`keeps turn 1's shell on turn 1 while turn 2 streams (${trace})`, async () => {
			proof = { case: trace };
			cases.push(proof);
			const fixture = await ProcessHarness.start({
				claudeReplay: { turns: [trace], holdBeforeResult: true },
			});
			harness = fixture;
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"Overlapping background completion",
			);
			await browser.followSession(sessionId);
			const submit = async (text: string) => {
				const inputId = randomUUID();
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
				).toMatchObject({ ok: true, handedOff: true });
				return inputId;
			};
			await submit("Run sleep 8 in the background");
			const release = join(fixture.root, "claude-replay-release");
			writeFileSync(release, "release first result");
			await vi.waitFor(
				() =>
					expect(
						ledger(fixture, sessionId).runs.map((row) => row.status),
					).toEqual(["completed"]),
				{ timeout: 15_000 },
			);
			const first = ledger(fixture, sessionId);
			proof["firstCompleted"] = normalized(first);
			unlinkSync(release);
			await submit("ping");
			await vi.waitFor(
				() => {
					const state = ledger(fixture, sessionId);
					expect(state.turns.map((row) => row.state)).toEqual([
						"completed",
						"running",
					]);
					expect(
						state.events.some(
							(event) =>
								event.type === "tool.completed" &&
								event.data["partId"] === shellId &&
								event.sequence > (first.events.at(-1)?.sequence ?? 0),
						),
					).toBe(true);
				},
				{ timeout: 15_000 },
			);
			const overlapping = ledger(fixture, sessionId);
			proof["whileSecondStreams"] = normalized(overlapping);
			// Always finish run 2 before asserting ownership, including on the red run.
			writeFileSync(release, "release second result");
			await vi.waitFor(
				() =>
					expect(
						ledger(fixture, sessionId).runs.map((row) => row.status),
					).toEqual(["completed", "completed"]),
				{ timeout: 15_000 },
			);
			const completed = ledger(fixture, sessionId);
			proof["completed"] = normalized(completed);
			const [alpha, bravo] = completed.turns;
			expect(alpha).toBeDefined();
			expect(bravo).toBeDefined();
			const tools = completed.events.filter(
				(event) => event.data["partId"] === shellId,
			);
			expect(tools.length).toBeGreaterThan(0);
			expect
				.soft(tools.every((event) => event.runId === alpha?.run_id))
				.toBe(true);
			expect
				.soft(
					tools.every(
						(event) => event.data["messageId"] === first.messages[0]?.id,
					),
				)
				.toBe(true);
			expect.soft(completed.shell?.turn_id).toBe(alpha?.id);
			expect
				.soft(
					first.shell === undefined ||
						completed.shell?.message_id === first.shell.message_id,
				)
				.toBe(true);
			expect.soft(completed.shell?.status).toBe("completed");
			expect.soft(overlapping.turns[0]).toEqual(first.turns[0]);
			expect.soft(completed.turns[0]).toEqual(first.turns[0]);
			expect
				.soft(
					completed.events.filter(
						(event) =>
							event.type === "run.started" && event.runId === alpha?.run_id,
					),
				)
				.toHaveLength(1);
			const secondMessage = completed.events.find(
				(event) =>
					event.type === "message.created" &&
					event.data["role"] === "assistant" &&
					event.runId === bravo?.run_id,
			)?.data["messageId"];
			expect.soft(bravo?.assistant_message_id).toBe(secondMessage);
			expect
				.soft(overlapping.turns[1]?.assistant_message_id)
				.toBe(secondMessage);
			expect.soft(overlapping.turns[1]?.cost).toBeNull();
			const ends = completed.events.filter((event) =>
				["turn.completed", "turn.error", "turn.interrupted"].includes(
					event.type,
				),
			);
			expect
				.soft(ends.map((event) => ({ type: event.type, run: event.runId })))
				.toEqual(
					completed.runs.map((row) => ({
						type: "turn.completed",
						run: row.id,
					})),
				);
			expect
				.soft(completed.turns.map((row) => row.state))
				.toEqual(["completed", "completed"]);
			expect.soft(completed.queued).toBe(0);
			const secondEnd = ends[1];
			expect.soft(bravo?.cost).toBe(secondEnd?.data["cost"]);
			// The captures report cumulative totals 0.0328057 and 0.278217.
			expect.soft(bravo?.cost).toBeCloseTo(0.2454113, 10);
			expect
				.soft(completed.messages.find((row) => row.id === secondMessage)?.cost)
				.toBe(bravo?.cost);
			const lateStart = tools.find(
				(event) =>
					event.type === "tool.started" &&
					event.sequence > (ends[0]?.sequence ?? Infinity),
			);
			expect.soft(lateStart).toBeDefined();
			const secondStart = completed.events.find(
				(event) =>
					event.type === "run.started" && event.runId === bravo?.run_id,
			);
			expect
				.soft(lateStart?.sequence)
				.toBeGreaterThan(secondStart?.sequence ?? Infinity);
			expect.soft(lateStart?.sequence).toBeLessThan(secondEnd?.sequence ?? 0);
		}, 60_000);
	}
});
