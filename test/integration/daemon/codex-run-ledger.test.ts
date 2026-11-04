// Codex on the Run Ledger end to end (82tn.32.21; CONTRACT.md 2.1 row 215, 9 at 3080-3119), over
// the isolated process harness and recorded Codex app-server traces. How it could fail (lane audit
// F220-F226):
// 220. a Codex send's Run ends twice, or never, in the ledger;
// 221. no process_started for the Codex runner, or it lands after the runner's first frame;
// 222. a requested turn reports turn evidence (only a turn Codex starts by itself is a wake);
// 223. a delivered steer's Run ends other than once, or the steer opens a second turn/start;
// 224. a Stop ends its Run other than interrupted, by the alarm, or twice;
// 225. a Run's ledger end disagrees with main's run status;
// 226. a goal chain ends its Run more than once, or a successor inside the window reads as a wake.
// Box 2, a turn Codex starts while idle (successor after the window):
// 230. it is dropped: no wake Run in the ledger;
// 231. the wake Run never ends, or ends other than once at its own result;
// 232. its output is lost or lands on no message;
// 233. (open) Stop while it runs sends no turn/interrupt, or the alarm ends it;
// 237. its evidence carries no runner-stamped label.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 60_000;
const STEER = "Use the steered instruction";

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare(
					"SELECT sequence, type, coalesce(json_extract(data, '$.runId'), json_extract(metadata, '$.runId')) AS runId, json_extract(data, '$.label') AS label, json_extract(data, '$.result.outcome') AS result, json_extract(data, '$.messageId') AS messageId FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				runId: string | null;
				label: string | null;
				result: string | null;
				messageId: string | null;
			}[],
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.outcome') AS outcome, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				runId: string;
				outcome: string;
				reason: string;
				forced: number | null;
			}[],
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			turns: (
				db
					.prepare(
						"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
					)
					.all(sessionId) as { state: string }[]
			).map(({ state }) => state),
		};
	} finally {
		db.close();
	}
};
type Ledger = ReturnType<typeof read>;

/** Each Run main started ends in the ledger once, with main's outcome (F220, F225). */
const endsOnce = (ledger: Ledger) => {
	expect(ledger.runs.length).toBeGreaterThan(0);
	expect(
		ledger.runs.map((run) => ({
			runId: run.id,
			ends: ledger.ends
				.filter((end) => end.runId === run.id)
				.map((end) => end.outcome),
		})),
	).toEqual(
		ledger.runs.map((run) => ({
			runId: run.id,
			ends: run.status === "joined" ? [] : [run.status],
		})),
	);
};

/** One Codex runner, its start before its first frame (F221), no turn evidence (F222, F226). */
const oneRunnerStartedFirst = (ledger: Ledger) => {
	const started = ledger.events.filter(
		(event) => event.type === "evidence.process_started",
	);
	expect(started).toHaveLength(1);
	const firstFrame = ledger.events.find(
		(event) =>
			event.type === "run.dispatched" || event.type === "message.created",
	);
	expect(started[0]?.sequence).toBeLessThan(
		firstFrame?.sequence ?? Number.POSITIVE_INFINITY,
	);
	expect(
		ledger.events.filter((event) => event.type.startsWith("evidence.turn_")),
	).toEqual([]);
};

describe("Codex on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	let reportPath = "";
	let capturePath = "";
	let gatePath = "";
	let tracePath = "";
	const proofs: Record<string, unknown>[] = [];

	const writeTrace = (trace: TraceRow[]) =>
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);

	afterEach(async () => {
		const fixture = harness;
		harness = undefined;
		if (!fixture) return;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await fixture.dispose();
		const reports = rows<AppServerTraceReport>(reportPath);
		expect(reports.length).toBeGreaterThan(0);
		for (const report of reports) {
			expect(report.consumed).toBe(report.total);
			expect(report.mismatches).toEqual([]);
			expect(report.unconsumed).toEqual([]);
		}
		expect(fixture.remainingRunnerPids()).toEqual([]);
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-21-codex-ledger.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.21", proofs }, null, 2)}\n`,
		);
	});

	const start = async (
		name: string,
		trace: TraceRow[],
		environment: Record<string, string> = {},
	) => {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		harness = fixture;
		tracePath = join(fixture.root, "codex-replay.jsonl");
		gatePath = join(fixture.root, "codex-replay-gate");
		const artifacts = resolve(`test-results/codex-run-ledger/${name}`);
		mkdirSync(artifacts, { recursive: true });
		reportPath = join(artifacts, "trace-report.jsonl");
		capturePath = join(artifacts, "capture.jsonl");
		writeFileSync(reportPath, "");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeTrace(signedInCodexDiscoveryTrace());
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
				...environment,
			},
		});
		const browser = await fixture.connect();
		const account = await vi.waitFor(
			async () => {
				const found = (await browser.instances()).instances.find(
					({ driver }) => driver === "codex",
				);
				expect(found).toBeDefined();
				return found;
			},
			{ timeout: TIMEOUT },
		);
		if (!account) throw new Error("Missing Codex account");
		await codexModels(browser, account.id);
		const sessionId = await browser.createSession(name, account.id, "codex", {
			modelId: "gpt-6.1-sol",
			contextWindow: "",
			permissionMode: "ask",
		});
		writeTrace(trace);
		return { fixture, browser, sessionId };
	};
	const submit = async (
		browser: ProcessBrowser,
		sessionId: string,
		text: string,
		delivery: "queue" | "steer" = "queue",
		inputId: string = randomUUID(),
	) => {
		await browser.followSession(sessionId);
		const result = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery,
				text,
			}),
		);
		expect(result.ok).toBe(true);
	};
	const turns = (
		fixture: ProcessHarness,
		sessionId: string,
		states: string[],
	) =>
		vi.waitFor(() => expect(read(fixture, sessionId).turns).toEqual(states), {
			timeout: TIMEOUT,
			interval: 100,
		});
	const captured = (method: string, dir?: "in" | "out") =>
		rows<TraceRow>(capturePath).filter(
			(row) =>
				row.message?.method === method &&
				(dir === undefined || row.dir === dir),
		);
	const prove = (name: string, ledger: Ledger, extra = {}) =>
		proofs.push({
			case: name,
			ends: ledger.ends,
			runs: ledger.runs,
			evidence: ledger.events.filter(({ type }) =>
				type.startsWith("evidence."),
			),
			...extra,
		});

	it("ends a send's Run once, its runner's start reported before its first frame", async () => {
		const { fixture, browser, sessionId } = await start(
			"send",
			fixtureRows("basic"),
		);
		await submit(browser, sessionId, "Say hello");
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		prove("send", ledger);
	});

	it("ends a delivered steer's Run once, on the one turn/start", async () => {
		const { fixture, browser, sessionId } = await start(
			"steer",
			fixtureRows("steer"),
		);
		// Hold the replay after the steer's acknowledgement, as codex-control's steer case does.
		writeFileSync(gatePath, "591");
		await submit(browser, sessionId, "Say hello");
		await vi.waitFor(
			() => expect(captured("item/agentMessage/delta")).not.toEqual([]),
			{ timeout: TIMEOUT },
		);
		await submit(browser, sessionId, STEER, "steer", "fixture-steer");
		await vi.waitFor(
			() => expect(captured("turn/steer", "out")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await turns(fixture, sessionId, ["completed", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(captured("turn/start", "out")).toHaveLength(1);
		prove("steer", ledger);
	});

	it("ends a Stopped Run interrupted once, by the native interrupt and not the alarm", async () => {
		let begun = false;
		const { fixture, browser, sessionId } = await start(
			"stop",
			fixtureRows("stop-queued").map((row) => {
				if (row.message?.method === "turn/started") begun = true;
				return { ...row, at: begun ? 1 : 0 };
			}),
		);
		writeFileSync(gatePath, "0");
		await submit(browser, sessionId, "Say hello");
		await vi.waitFor(
			() =>
				expect(
					rows<TraceRow>(capturePath).some(
						(row) => row.message?.result?.["turn"],
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		const stopping = Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
		writeFileSync(gatePath, "1");
		await stopping;
		await turns(fixture, sessionId, ["interrupted"]);
		await vi.waitFor(
			() => expect(captured("turn/interrupt", "out")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "interrupted" }),
		]);
		expect(ledger.ends[0]?.forced).not.toBe(1);
		prove("stop", ledger);
	});

	it("ends a goal chain's Run once; its in-window successors are no wake (row 215)", async () => {
		const { fixture, browser, sessionId } = await start(
			"goal-chain",
			fixtureRows("goal-chain"),
		);
		await browser.send(sessionId, "$goal Say hello", TIMEOUT);
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(captured("turn/started", "in").length).toBeGreaterThan(1);
		prove("goal-chain", ledger);
	});

	/** A goal send whose successor misses the window, so Codex starts it while conduit is idle. */
	const wake = async (name: string, fixture: string) => {
		const trace = fixtureRows(fixture);
		const firstEnd = trace.find(
			({ message }) => message?.method === "turn/completed",
		)?.["at"];
		if (typeof firstEnd !== "number") throw new Error("Missing turn end");
		const started = await start(name, trace, {
			CONDUIT_TEST_CODEX_GOAL_SUCCESSOR_TIMEOUT_MS: "500",
		});
		writeFileSync(gatePath, String(firstEnd));
		await submit(started.browser, started.sessionId, "$goal Say hello");
		// test-waits-allow polling: the window closing reaches only the store's ledger.
		await vi.waitFor(
			() =>
				expect(read(started.fixture, started.sessionId).ends).toHaveLength(1),
			{ timeout: TIMEOUT, interval: 100 },
		);
		return { ...started, trace };
	};
	const wakeEvidence = (ledger: Ledger) => {
		const evidence = ledger.events.filter(({ type }) =>
			type.startsWith("evidence.turn_"),
		);
		expect(evidence.map(({ type }) => type)).toEqual([
			"evidence.turn_started",
			"evidence.turn_ended",
		]);
		for (const { label } of evidence) expect(label).toMatch(/^.+:\d+$/);
		expect(evidence[0]?.label).toBe(evidence[1]?.label);
		return evidence;
	};

	it("reports a successor Codex starts while idle as a wake Run that ends once at its result", async () => {
		const { fixture, sessionId } = await wake("wake", "goal-chain");
		const [send] = read(fixture, sessionId).ends;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		// test-waits-allow polling: a wake Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).ends).toHaveLength(2),
			{ timeout: TIMEOUT, interval: 100 },
		);
		const ledger = read(fixture, sessionId);
		const [started, ended] = wakeEvidence(ledger);
		expect(ended?.result).toBe("completed");
		expect(ledger.ends).toEqual([
			send,
			expect.objectContaining({ outcome: "completed" }),
		]);
		expect(ledger.ends[1]?.runId).not.toBe(send?.runId);
		expect(ledger.ends[1]?.forced).not.toBe(1);
		// F232: the wake's output lands on its own assistant message, between its evidence.
		const output = ledger.events.filter(
			({ sequence, type, messageId }) =>
				sequence > (started?.sequence ?? 0) &&
				sequence < (ended?.sequence ?? 0) &&
				type.startsWith("message.") &&
				messageId,
		);
		expect(output).not.toEqual([]);
		expect(captured("turn/start", "out")).toHaveLength(1);
		prove("wake", ledger);
	});
});
