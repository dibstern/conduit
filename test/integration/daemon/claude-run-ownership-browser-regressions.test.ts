import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailItemSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const evidenceDirectory =
	process.env["CONDUIT_TEST_ARTIFACT_DIR"] ?? "test-results";

function ledger(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			turns: db
				.prepare(
					"SELECT id, state, run_id FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{
				id: string;
				state: string;
				run_id: string | null;
			}>,
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{ id: string; status: string }>,
			pending: db
				.prepare(
					"SELECT input_id, state FROM pending_inputs WHERE session_id = ? ORDER BY admitted_at, rowid",
				)
				.all(sessionId) as Array<{ input_id: string; state: string }>,
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{ command_id: string; status: string }>,
			events: db
				.prepare(
					"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId)
				.map((row) => {
					const event = row as {
						type: string;
						data: string;
						metadata: string;
					};
					return {
						type: event.type,
						data: JSON.parse(event.data) as Record<string, unknown>,
						metadata: JSON.parse(event.metadata) as Record<string, unknown>,
					};
				}),
		};
	} finally {
		db.close();
	}
}

function normalized(state: ReturnType<typeof ledger>) {
	const runs = new Map(state.runs.map(({ id }, index) => [id, index + 1]));
	return {
		runs: state.runs.map(({ status }) => status),
		turns: state.turns.map(({ state, run_id }) => ({
			state,
			run: run_id ? runs.get(run_id) : null,
		})),
		pending: state.pending.map(({ state }) => state),
		commands: state.commands.map(({ status }) => status),
		ends: state.events
			.filter(({ type }) =>
				["turn.completed", "turn.interrupted", "turn.error"].includes(type),
			)
			.map(({ type, metadata }) => ({
				type,
				run:
					typeof metadata["runId"] === "string"
						? runs.get(metadata["runId"])
						: null,
			})),
	};
}

async function submit(
	browser: ProcessBrowser,
	sessionId: string,
	text: string,
	delivery: "queue" | "steer" = "queue",
) {
	const inputId = randomUUID();
	expect(
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				text,
				delivery,
			}),
		),
	).toMatchObject({ ok: true });
	return inputId;
}

function paused(browser: ProcessBrowser, sessionId: string) {
	return browser.frames
		.flatMap(({ message }) => {
			if (
				message["type"] !== "session_detail" ||
				message["sessionId"] !== sessionId
			)
				return [];
			const items =
				message["_tag"] === "snapshot" ? message["rows"] : [message["item"]];
			return Array.isArray(items)
				? items.flatMap((item: unknown) => {
						const decoded = Schema.decodeUnknownOption(SessionDetailItemSchema)(
							item,
						);
						return decoded._tag === "Some" ? [decoded.value] : [];
					})
				: [];
		})
		.filter((item) => item._tag === "inbox")
		.at(-1)?.inbox.paused;
}

// A queued stop/restart must settle its own reservation; a boundary must take
// every delivered steer; a slash interruption must produce only one terminal.
describe("Claude browser run-ownership guarantees through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string;
	let proof: Record<string, unknown>;
	const cases: Array<Record<string, unknown>> = [];

	afterEach(async ({ task }) => {
		mkdirSync(evidenceDirectory, { recursive: true });
		try {
			if (harness && existsSync(harness.daemonStorePath()))
				proof["final"] = normalized(ledger(harness, sessionId));
			if (task.result?.errors?.length && harness) {
				proof["failureLedger"] = ledger(harness, sessionId);
				const runnerLog = join(harness.configDir, "runners.log");
				writeFileSync(
					join(evidenceDirectory, `82tn24-round3-${proof["case"]}.log`),
					harness.logTail +
						(existsSync(runnerLog) ? readFileSync(runnerLog, "utf8") : ""),
				);
				proof["processMarks"] = harness.marks;
			}
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof["outcome"] = task.result?.state === "pass" ? "passed" : "failed";
			writeFileSync(
				join(evidenceDirectory, "82tn24-round3-claude.json"),
				`${JSON.stringify({ cases }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("takes both steers at one tool boundary and ends all three inputs once", async () => {
		proof = { case: "two-steers-one-boundary", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			dist: "dist",
			claudeReplay: { turns: ["two-steers-one-boundary"], delayMs: 100 },
		});
		harness = fixture;
		const browser = await fixture.connect();
		sessionId = await browser.createSession("Two steers share one run");
		await browser.followSession(sessionId);
		const alpha = await submit(browser, sessionId, "Alpha");
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				JSON.stringify(message["parts"]).includes("Bash"),
		);
		const bravo = await submit(browser, sessionId, "Bravo", "steer");
		const charlie = await submit(browser, sessionId, "Charlie", "steer");
		await vi.waitFor(
			() =>
				expect(
					ledger(fixture, sessionId).turns.map(({ state }) => state),
				).toEqual(["completed", "completed", "completed"]),
			{ timeout: 15_000 },
		);
		const state = ledger(fixture, sessionId);
		expect(state.turns.map(({ id }) => id)).toEqual([alpha, bravo, charlie]);
		const runId = state.turns[0]?.run_id;
		expect(runId).toEqual(expect.any(String));
		expect(state.runs.map(({ status }) => status)).toEqual([
			"completed",
			"joined",
			"joined",
		]);
		expect(state.runs[0]?.id).toBe(runId);
		expect(state.turns.map(({ run_id }) => run_id)).toEqual([
			runId,
			runId,
			runId,
		]);
		expect(
			state.events
				.filter(({ type }) => type === "run.started")
				.map(({ data, metadata }) => ({
					inputId: data["inputId"],
					runId: metadata["runId"],
				})),
		).toEqual([
			{ inputId: alpha, runId },
			{ inputId: bravo, runId },
			{ inputId: charlie, runId },
		]);
		const ends = state.events.filter(({ type }) =>
			["turn.completed", "turn.interrupted", "turn.error"].includes(type),
		);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			type: "turn.completed",
			metadata: { runId },
		});
		expect(state.pending.map(({ state }) => state)).toEqual([
			"removed",
			"removed",
			"removed",
		]);
	}, 45_000);

	it("a restart that cuts off its runner closes the turn and pauses the remaining queue", async () => {
		proof = { case: "restart-cutoff-queue", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			dist: "dist",
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				delayMs: 500,
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		sessionId = await browser.createSession("Restart cuts off running turn");
		await browser.followSession(sessionId);
		const alpha = await submit(browser, sessionId, "Alpha");
		await vi.waitFor(
			() => expect(ledger(fixture, sessionId).runs[0]?.status).toBe("running"),
			{ timeout: 10_000 },
		);
		const bravo = await submit(browser, sessionId, "Bravo");
		proof["beforeRestart"] = normalized(ledger(fixture, sessionId));
		const runnerPids = fixture.runnerPids();
		expect(runnerPids).not.toEqual([]);
		await fixture.kill();
		for (const pid of runnerPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch (error) {
				if (
					typeof error !== "object" ||
					error === null ||
					!("code" in error) ||
					error.code !== "ESRCH"
				)
					throw error;
			}
		}
		await fixture.restart();
		const after = await fixture.connect(sessionId);
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(["interrupted", "error"]).toContain(state.turns[0]?.state);
				expect(state.turns).toHaveLength(1);
				expect(state.runs).toHaveLength(1);
				expect(state.runs[0]?.status).toBe(state.turns[0]?.state);
				expect(state.pending).toEqual([
					{ input_id: alpha, state: "removed" },
					{ input_id: bravo, state: "queued" },
				]);
				expect(
					state.events.filter(({ type }) =>
						["turn.completed", "turn.interrupted", "turn.error"].includes(type),
					),
				).toEqual([
					expect.objectContaining({
						metadata: expect.objectContaining({ runId: state.runs[0]?.id }),
					}),
				]);
				expect(paused(after, sessionId)).toBe(true);
				expect(
					state.events
						.filter(({ type }) => type === "input.sent")
						.map(({ data }) => data["inputId"]),
				).toEqual([alpha]);
			},
			{ timeout: 15_000 },
		);
		proof["restarted"] = normalized(ledger(fixture, sessionId));
		proof["resumeRequested"] = true;
		await after.sendNow(sessionId, bravo);
		proof["resumeSubmitted"] = true;
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(state.turns[1]?.state).toBe("completed");
				expect(state.commands.map(({ status }) => status)).toEqual([
					"failed",
					"completed",
				]);
				expect(state.turns.map(({ id }) => id)).toEqual([alpha, bravo]);
				expect(state.runs).toHaveLength(2);
				expect(state.turns.map(({ run_id }) => run_id)).toEqual(
					state.runs.map(({ id }) => id),
				);
				expect(
					state.events.filter(({ type }) => type === "turn.completed"),
				).toHaveLength(1);
				expect(
					state.events
						.filter(({ type }) => type === "input.sent")
						.map(({ data }) => data["inputId"]),
				).toEqual([alpha, bravo]);
			},
			{ timeout: 20_000 },
		);
	}, 45_000);

	it("Stop with a steer pending answers the steer and keeps the remaining queue paused", async () => {
		proof = { case: "stop-with-steer-pending", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			dist: "dist",
			claudeReplay: { turns: ["stop-with-steer-pending"], delayMs: 100 },
		});
		harness = fixture;
		const browser = await fixture.connect();
		sessionId = await browser.createSession("Stop with a pending steer");
		await browser.followSession(sessionId);
		const alpha = await submit(browser, sessionId, "Alpha");
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				JSON.stringify(message["parts"]).includes("Bash"),
		);
		const bravo = await submit(browser, sessionId, "Bravo", "steer");
		const charlie = await submit(browser, sessionId, "Charlie");
		expect(ledger(fixture, sessionId).pending).toEqual([
			{ input_id: alpha, state: "removed" },
			{ input_id: bravo, state: "steering" },
			{ input_id: charlie, state: "queued" },
		]);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(state.turns.map(({ id, state }) => ({ id, state }))).toEqual([
					{ id: alpha, state: "interrupted" },
					{ id: bravo, state: "completed" },
				]);
				expect(state.pending).toEqual([
					{ input_id: alpha, state: "removed" },
					{ input_id: bravo, state: "removed" },
					{ input_id: charlie, state: "queued" },
				]);
				expect(state.commands).toEqual([
					{ command_id: alpha, status: "failed" },
					{ command_id: bravo, status: "completed" },
				]);
				expect(
					state.events
						.filter(({ type }) =>
							["turn.completed", "turn.interrupted", "turn.error"].includes(
								type,
							),
						)
						.map(({ type }) => type),
				).toEqual(["turn.interrupted", "turn.completed"]);
				expect(paused(browser, sessionId)).toBe(true);
			},
			{ timeout: 15_000 },
		);
	}, 45_000);

	it("Stop pauses the queue and Resume sends the oldest before the rest drains", async () => {
		proof = { case: "stop-resume-queue", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			dist: "dist",
			claudeReplay: {
				turns: [
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
				],
				delayMs: 300,
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		sessionId = await browser.createSession("Stop and resume queue");
		await browser.followSession(sessionId);
		const alpha = await submit(browser, sessionId, "Alpha");
		await vi.waitFor(
			() => expect(ledger(fixture, sessionId).runs[0]?.status).toBe("running"),
			{ timeout: 10_000 },
		);
		const bravo = await submit(browser, sessionId, "Bravo");
		const charlie = await submit(browser, sessionId, "Charlie");
		proof["beforeStop"] = normalized(ledger(fixture, sessionId));
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(state.turns.map(({ id, state }) => ({ id, state }))).toEqual([
					{ id: alpha, state: "interrupted" },
				]);
				expect(state.runs).toEqual([
					{ id: state.turns[0]?.run_id, status: "interrupted" },
				]);
				expect(state.pending).toEqual([
					{ input_id: alpha, state: "removed" },
					{ input_id: bravo, state: "queued" },
					{ input_id: charlie, state: "queued" },
				]);
				expect(
					state.events.filter(({ type }) => type === "turn.interrupted"),
				).toHaveLength(1);
				expect(paused(browser, sessionId)).toBe(true);
				expect(
					state.events
						.filter(({ type }) => type === "input.sent")
						.map(({ data }) => data["inputId"]),
				).toEqual([alpha]);
			},
			{ timeout: 15_000 },
		);
		proof["paused"] = normalized(ledger(fixture, sessionId));
		await browser.sendNow(sessionId, bravo);
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(state.turns.map(({ id, state }) => ({ id, state }))).toEqual([
					{ id: alpha, state: "interrupted" },
					{ id: bravo, state: "completed" },
					{ id: charlie, state: "completed" },
				]);
				expect(state.runs.map(({ status }) => status)).toEqual([
					"interrupted",
					"completed",
					"completed",
				]);
				expect(state.commands.map(({ status }) => status)).toEqual([
					"failed",
					"completed",
					"completed",
				]);
				expect(state.turns.map(({ run_id }) => run_id)).toEqual(
					state.runs.map(({ id }) => id),
				);
				expect(
					state.events.filter(({ type }) => type === "turn.completed"),
				).toHaveLength(2);
				expect(
					state.events
						.filter(({ type }) => type === "input.sent")
						.map(({ data }) => data["inputId"]),
				).toEqual([alpha, bravo, charlie]);
				expect(state.pending.map(({ state }) => state)).toEqual([
					"removed",
					"removed",
					"removed",
				]);
			},
			{ timeout: 20_000 },
		);
	}, 45_000);

	it("a steered slash interrupts the running input once and completes on its own run", async () => {
		proof = { case: "steered-slash-interrupt", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			dist: "dist",
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				delayMs: 300,
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		sessionId = await browser.createSession("Slash interrupts its predecessor");
		await browser.followSession(sessionId);
		const alpha = await submit(browser, sessionId, "Alpha");
		await vi.waitFor(
			() => expect(ledger(fixture, sessionId).runs[0]?.status).toBe("running"),
			{ timeout: 10_000 },
		);
		const slash = await submit(browser, sessionId, "/compact", "steer");
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(state.turns.map(({ id, state }) => ({ id, state }))).toEqual([
					{ id: alpha, state: "interrupted" },
					{ id: slash, state: "completed" },
				]);
				expect(state.turns.map(({ run_id }) => run_id)).toEqual(
					state.runs.map(({ id }) => id),
				);
				expect(
					state.events.filter(
						({ type }) => type === "input.interrupt_requested",
					),
				).toHaveLength(1);
				expect(
					state.events.filter(({ type }) => type === "turn.interrupted"),
				).toHaveLength(1);
				expect(
					state.events.filter(({ type }) => type === "turn.completed"),
				).toHaveLength(1);
				expect(
					state.events
						.filter(({ type }) => type === "input.sent")
						.map(({ data }) => data["inputId"]),
				).toEqual([alpha, slash]);
				expect(state.runs.map(({ status }) => status)).toEqual([
					"interrupted",
					"completed",
				]);
				expect(state.commands.map(({ status }) => status)).toEqual([
					"failed",
					"completed",
				]);
				expect(
					state.events
						.filter(({ type }) =>
							["turn.completed", "turn.interrupted", "turn.error"].includes(
								type,
							),
						)
						.map(({ type, metadata }) => ({ type, runId: metadata["runId"] })),
				).toEqual([
					{ type: "turn.interrupted", runId: state.runs[0]?.id },
					{ type: "turn.completed", runId: state.runs[1]?.id },
				]);
			},
			{ timeout: 20_000 },
		);
	}, 45_000);
});
