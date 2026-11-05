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
// 233. Stop while it runs sends no turn/interrupt, or the alarm ends it;
// 237. its evidence carries no runner-stamped label;
// 242. its start reaches the store only when its end follows at once (held-gate variant);
// 270. a send admitted while only a wake runs never starts, or starts no Run of its own,
//      or starts before the wake ends (CONTRACT 992-995, 215).
// Box 5, a daemon restart (CONTRACT 9 at 3141-3145: a daemon exit never ends a Codex session):
// 240. a restart mid-turn ends the Codex runner, its app-server or its turn;
// 241. the held Run ends twice across the restart, or never;
// 274. the send reaches Codex twice (a second turn/start after the restart);
// 275. the surviving runner reports no reattached start, or a loss;
// 276. a wake running at the restart is lost, ends twice, or its output lands nowhere;
// 277. a restart inside a goal's successor window ends the Run early, twice, or reads the
//      successor as a wake;
// 278. a send the daemon claimed but had not yet handed to the runner when it died never runs,
//      or runs twice;
// 279. output the runner sent before the restart is lost or lands twice.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect, Fiber, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import { proveCrashMatrixCell } from "../../helpers/crash-matrix-cell.js";
import { historicalRunnerBundle } from "../../helpers/historical-runner-bundle.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { proveToolRowsOnLedger } from "../../helpers/tool-rows-proof.js";

const TIMEOUT = 60_000;
const STEER = "Use the steered instruction";

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare(
					"SELECT sequence, type, coalesce(json_extract(data, '$.runId'), json_extract(metadata, '$.runId'), json_extract(data, '$.requestedRunId')) AS runId, json_extract(data, '$.label') AS label, json_extract(data, '$.result.outcome') AS result, json_extract(data, '$.messageId') AS messageId, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.reattached') AS reattached FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				runId: string | null;
				label: string | null;
				result: string | null;
				messageId: string | null;
				runnerId: string | null;
				reattached: number | null;
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

/** A recorded trace replayed as a thread/resume of `threadId`, as codex-goals' resume does. */
const resumeTrace = (trace: TraceRow[], threadId: string) => {
	const original = trace.find(({ message }) => message?.method === "turn/start")
		?.message?.params?.["threadId"];
	if (typeof original !== "string")
		throw new Error("Missing recorded thread id");
	const resumed = JSON.parse(
		JSON.stringify(trace).replaceAll(original, threadId),
	) as TraceRow[];
	const start = resumed.find(
		({ message }) => message?.method === "thread/start",
	)?.message;
	if (!start) throw new Error("Missing recorded thread/start");
	start.method = "thread/resume";
	start.params = { ...start.params, threadId, excludeTurns: true };
	return resumed;
};

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

// 82tn.32.35: only an OpenCode probe records what it read; this provider's probes record nothing.
const probeFindings = (fixture: ProcessHarness | undefined) => {
	if (!fixture) return 0;
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return (
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM events WHERE type = 'evidence.probe_result'",
				)
				.get() as { n: number }
		).n;
	} finally {
		db.close();
	}
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
		const findings = probeFindings(fixture);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await fixture.dispose();
		expect(findings).toBe(0);
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
		options: Parameters<typeof ProcessHarness.create>[0] = {},
		view = true,
	) => {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			...options,
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
		// A restarted daemon discovers again before its next send: keep discovery on its own trace.
		const discoveryPath = join(fixture.root, "codex-discovery.jsonl");
		const traceMap = join(fixture.root, "codex-trace-map.json");
		writeFileSync(discoveryPath, readFileSync(tracePath, "utf8"));
		writeFileSync(
			traceMap,
			JSON.stringify({ "*": { "codex-discovery": { trace: discoveryPath } } }),
		);
		const restart = (dist?: string) =>
			fixture.restart({
				...(dist ? { dist } : {}),
				startupTimeoutMs: TIMEOUT,
				runnerStartupTimeoutMs: TIMEOUT,
				serviceEnvironment: {
					CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
					CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
					CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
					CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
					CONDUIT_TEST_CODEX_TRACE_MAP: traceMap,
					...environment,
				},
			});
		await restart();
		const browser = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			view,
		);
		// main's account list fails this build's schema, so read main's account from its config.
		const account = await vi.waitFor(
			async () => {
				const found = (
					options.dist
						? (
								JSON.parse(
									readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
								) as { instances: { id: string; driver: string }[] }
							).instances
						: (await browser.instances()).instances
				).find(({ driver }) => driver === "codex");
				expect(found).toBeDefined();
				return found;
			},
			{ timeout: TIMEOUT },
		);
		if (!account) throw new Error("Missing Codex account");
		if (!options.dist) await codexModels(browser, account.id);
		const sessionId = await browser.createSession(name, account.id, "codex", {
			modelId: "gpt-6.1-sol",
			contextWindow: "",
			permissionMode: "ask",
			view,
		});
		writeTrace(trace);
		return { fixture, browser, sessionId, restart };
	};
	const submit = async (
		browser: ProcessBrowser,
		sessionId: string,
		text: string,
		delivery: "queue" | "steer" = "queue",
		inputId: string = randomUUID(),
		view = true,
	) => {
		if (view) await browser.followSession(sessionId);
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
	/** Sets the goal (it goes to Codex first at the next launch), then sends its prompt. */
	const goalSubmit = async (
		browser: ProcessBrowser,
		sessionId: string,
		view = true,
	) => {
		const set = await Effect.runPromise(
			browser.rpc.SetGoal({
				sessionId,
				commandId: randomUUID(),
				condition: "Say hello",
			}),
		);
		expect(set).toEqual({ ok: true });
		await submit(browser, sessionId, "Say hello", "queue", randomUUID(), view);
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

	it("stamps every tool row with its Run's id and the project folder (82tn.45)", async () => {
		const { fixture, browser, sessionId } = await start(
			"tool-rows",
			fixtureRows("turn-command"),
		);
		await submit(browser, sessionId, "Run the command");
		await turns(fixture, sessionId, ["completed"]);
		endsOnce(read(fixture, sessionId));
		proveToolRowsOnLedger("codex", fixture);
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

	// 32.7 box 3 (CONTRACT.md 3.9, 2.1 row 206): a steer whose turn/steer went out with no answer
	// before its runner died possibly reached Codex. How it could fail:
	// 280. the steer goes out again on the new runner (a second turn/steer, or its text in a turn/start);
	// 281. it returns to the queue (input.requeued) and runs as its own turn;
	// 282. it stays steering after its Run ends, or lands as two user messages;
	// 283. the next send never starts, or its Run or the killed Run ends other than once.
	it("places a steer whose delivery is unknown when its runner dies as sent, never re-sent", async () => {
		const { fixture, browser, sessionId } = await start(
			"steer-crash",
			fixtureRows("steer"),
		);
		// Hold the replay before turn/steer's answer (at 591): its delivery stays unknown.
		writeFileSync(gatePath, "590");
		await submit(browser, sessionId, "Say hello");
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("item/agentMessage/delta")).not.toEqual([]),
			{ timeout: TIMEOUT },
		);
		await submit(browser, sessionId, STEER, "steer", "fixture-steer");
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("turn/steer", "out")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		const { threadId } = JSON.parse(
			readFileSync(
				join(fixture.configDir, "codex", "stores", sessionId, "session.json"),
				"utf8",
			),
		) as { threadId: string };
		for (const pid of fixture.remainingRunnerPids())
			process.kill(pid, "SIGKILL");
		const inputs = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return {
					pending: db
						.prepare(
							"SELECT input_id, state FROM pending_inputs WHERE session_id = ? AND input_id = 'fixture-steer'",
						)
						.all(sessionId),
					messages: db
						.prepare(
							"SELECT steered FROM messages WHERE session_id = ? AND role = 'user' AND input_id = 'fixture-steer'",
						)
						.all(sessionId),
					requeued: db
						.prepare(
							"SELECT sequence FROM events WHERE session_id = ? AND type = 'input.requeued' AND json_extract(data, '$.inputId') = 'fixture-steer'",
						)
						.all(sessionId),
				};
			} finally {
				db.close();
			}
		};
		// test-waits-allow polling: the runner's death and the steer's place reach only the store.
		await vi.waitFor(
			() => {
				expect(fixture.remainingRunnerPids()).toEqual([]);
				expect(read(fixture, sessionId).turns).not.toContain("running");
				expect(inputs()).toEqual({
					pending: [
						expect.not.objectContaining({
							state: expect.stringMatching(/^(steering|queued)$/),
						}),
					],
					messages: [{ steered: 1 }],
					requeued: [],
				});
			},
			{ timeout: TIMEOUT },
		);
		// The next send resumes the thread on a new runner (F283).
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeTrace(resumeTrace(fixtureRows("basic"), threadId));
		await submit(browser, sessionId, "Say hello again");
		// test-waits-allow polling: the next Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).turns.at(-1)).toBe("completed"),
			{ timeout: TIMEOUT },
		);
		const ledger = read(fixture, sessionId);
		// The steer is a Run Input of the Run it steered: its own main run's terminal is the steer's
		// alone and ends no Run (3.9, 4.8). The killed Run ends once, at its loss; the next one once.
		expect(
			ledger.runs.map((run) => ({
				status: run.status,
				ends: ledger.ends
					.filter((end) => end.runId === run.id)
					.map((end) => end.outcome),
			})),
		).toEqual([
			{ status: "error", ends: ["error"] },
			{ status: "error", ends: [] },
			{ status: "completed", ends: ["completed"] },
		]);
		// The new runner's app-server writes its own capture: one turn/start, no steer (F280).
		const starts = captured("turn/start", "out");
		expect(starts).toHaveLength(1);
		expect(JSON.stringify(starts[0]?.message?.params)).not.toContain(STEER);
		expect(captured("turn/steer", "out")).toEqual([]);
		expect(inputs()).toMatchObject({
			messages: [{ steered: 1 }],
			requeued: [],
		});
		prove("steer-crash", ledger, { lost: processEvidence(ledger) });
		proveCrashMatrixCell(
			"codex/steer/runner/uncertain",
			fixture.daemonStorePath(),
			sessionId,
			["fixture-steer"],
		);
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

	// Failure modes (32.8): F300 the Run stays running when turn/interrupt is never answered;
	// F301 it ends twice, at the deadline step and again at its runner's loss; F302 the runner
	// outlives the deadline step; F303 the next send waits on the dead stop or its old runner;
	// F304 the next send re-sends the stopped input or starts a new thread.
	// test-waits-allow timeout-override: the Stop's 30 s interrupt deadline runs on the daemon's wall clock.
	it("ends a Stopped Run its app-server never acknowledges at the deadline, and the next send resumes once", async () => {
		// The app-server takes turn/interrupt and never answers it, nor ends the turn.
		const silent = fixtureRows("stop-queued");
		const interrupt = silent.findIndex(
			(row) => row.message?.method === "turn/interrupt",
		);
		const { fixture, browser, sessionId } = await start(
			"stop-silent",
			silent.slice(0, interrupt + 1),
		);
		await submit(browser, sessionId, "Say hello");
		await turns(fixture, sessionId, ["running"]);
		const { threadId } = JSON.parse(
			readFileSync(
				join(fixture.configDir, "codex", "stores", sessionId, "session.json"),
				"utf8",
			),
		) as { threadId: string };
		writeTrace(resumeTrace(fixtureRows("basic"), threadId));
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
		// test-waits-allow polling: the deadline step's retirement reaches only the store and the process table.
		await vi.waitFor(
			() => {
				expect(read(fixture, sessionId).turns).not.toContain("running");
				expect(fixture.remainingRunnerPids()).toEqual([]);
			},
			{ timeout: TIMEOUT, interval: 200 },
		);
		expect(captured("turn/interrupt", "out")).toHaveLength(1);
		await submit(browser, sessionId, "Say hello again");
		// test-waits-allow polling: the next Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).turns.at(-1)).toBe("completed"),
			{ timeout: TIMEOUT },
		);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.runs.map((run) => run.status)).toEqual([
			"interrupted",
			"completed",
		]);
		// The new runner's app-server writes its own capture: one turn/start, of the new message.
		const starts = captured("turn/start", "out");
		expect(starts).toHaveLength(1);
		expect(JSON.stringify(starts[0]?.message?.params)).toContain(
			"Say hello again",
		);
		expect(processEvidence(ledger).map(({ type }) => type)).toEqual([
			"evidence.process_started",
			"evidence.process_lost",
			"evidence.process_started",
		]);
		prove("stop-silent", ledger, { lost: processEvidence(ledger) });
	}, 120_000);

	// Failure modes (32.8): F379 Run now steers or starts a second turn without interrupting;
	// F380 the active Run ends twice or not interrupted; F381 the queued input launches twice
	// or never; F382 it launches before the active Run ends; F383 Run now retires the runner;
	// F384 the queued input stays in the tray.
	it("ends the active Run interrupted on Run now and launches the queued input once, on the same runner", async () => {
		// two-turns with stop-queued's derivation on its first turn (README): the schema's
		// turn/interrupt and its answer after turn/started, and the first terminal interrupted.
		const recorded = fixtureRows("two-turns");
		const started = recorded.findIndex(
			(row) => row.message?.method === "turn/started",
		);
		const ended = recorded.findIndex(
			(row) => row.message?.method === "turn/completed",
		);
		const stopQueued = fixtureRows("stop-queued");
		const interrupt = stopQueued.findIndex(
			(row) => row.message?.method === "turn/interrupt",
		);
		const terminal = structuredClone(recorded[ended]);
		const turn = terminal?.message?.params?.["turn"] as Record<string, unknown>;
		turn["status"] = "interrupted";
		const { fixture, browser, sessionId } = await start("run-now", [
			...recorded.slice(0, started + 1),
			...stopQueued.slice(interrupt, interrupt + 2),
			...(terminal ? [terminal] : []),
			...recorded.slice(ended + 1),
		]);
		await submit(browser, sessionId, "Say hello");
		await turns(fixture, sessionId, ["running"]);
		const queued = randomUUID();
		await submit(browser, sessionId, "Say hello again", "queue", queued);
		const tray = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db
					.prepare(
						"SELECT state FROM pending_inputs WHERE session_id = ? AND input_id = ?",
					)
					.all(sessionId, queued) as { state: string }[];
			} finally {
				db.close();
			}
		};
		// test-waits-allow polling: the queued input's tray state reaches only the store.
		await vi.waitFor(() => expect(tray()).toEqual([{ state: "queued" }]), {
			timeout: TIMEOUT,
		});
		expect(captured("turn/start", "out")).toHaveLength(1);
		await browser.sendNow(sessionId, queued, true);
		await turns(fixture, sessionId, ["interrupted", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(ledger.runs.map((run) => run.status)).toEqual([
			"interrupted",
			"completed",
		]);
		expect(ledger.ends[0]?.forced).not.toBe(1);
		expect(captured("turn/interrupt", "out")).toHaveLength(1);
		expect(captured("turn/steer", "out")).toEqual([]);
		const starts = captured("turn/start", "out");
		expect(starts).toHaveLength(2);
		expect(JSON.stringify(starts[1]?.message?.params)).toContain(
			"Say hello again",
		);
		// The queued input launched only after the interrupted terminal reached the runner.
		const order = rows<TraceRow>(capturePath).map(
			({ dir, message }) =>
				`${dir}:${message?.method ?? ""}:${String(
					(message?.params?.["turn"] as { status?: string } | undefined)
						?.status ?? "",
				)}`,
		);
		expect(order.indexOf("in:turn/completed:interrupted")).toBeLessThan(
			order.lastIndexOf("out:turn/start:"),
		);
		expect(tray()).toEqual([{ state: "removed" }]);
		prove("run-now", ledger);
	});

	it("ends a goal chain's Run once; its in-window successors are no wake (row 215)", async () => {
		const { fixture, browser, sessionId } = await start(
			"goal-chain",
			fixtureRows("goal-chain"),
		);
		await goalSubmit(browser, sessionId);
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(captured("turn/started", "in").length).toBeGreaterThan(1);
		prove("goal-chain", ledger);
	});

	/** The goal chain with its wake cut to one turn that completes the goal, so no window races its end. */
	const oneWake = (chain: TraceRow[]) => {
		const ends = chain.flatMap(({ message }, index) =>
			message?.method === "turn/completed" ? [index] : [],
		);
		const wakeEnd = Number(ends[1]);
		return [
			...chain
				.slice(0, wakeEnd + 1)
				.map((row, index) =>
					index > Number(ends[0]) &&
					row.message?.method === "thread/goal/updated"
						? JSON.parse(
								JSON.stringify(row).replace(
									'"status":"active"',
									'"status":"complete"',
								),
							)
						: row,
				),
			...chain.slice(chain.findIndex(({ dir }) => dir === "exit")),
		] as TraceRow[];
	};
	/** A goal send whose successor misses the window, so Codex starts it while conduit is idle. */
	const wake = async (name: string, trace: TraceRow[], view = true) => {
		const firstEnd = trace.find(
			({ message }) => message?.method === "turn/completed",
		)?.["at"];
		if (typeof firstEnd !== "number") throw new Error("Missing turn end");
		const started = await start(
			name,
			trace,
			{ CONDUIT_TEST_CODEX_GOAL_SUCCESSOR_TIMEOUT_MS: "500" },
			{},
			view,
		);
		writeFileSync(gatePath, String(firstEnd));
		await goalSubmit(started.browser, started.sessionId, view);
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

	it.each([
		["at once", false],
		["after its start is stored", true],
	])("reports a successor Codex starts while idle as a wake Run that ends once at its result (gate opens %s)", async (_, held) => {
		const { fixture, sessionId, trace } = await wake(
			held ? "wake-held" : "wake",
			oneWake(fixtureRows("goal-chain")),
		);
		const [send] = read(fixture, sessionId).ends;
		if (held) {
			// F242: hold the wake before its end, so its start must reach the store on its own.
			const wakeEnd = trace.filter(
				({ message }) => message?.method === "turn/completed",
			)[1]?.["at"];
			if (typeof wakeEnd !== "number") throw new Error("Missing wake end");
			writeFileSync(gatePath, String(wakeEnd - 1));
			// test-waits-allow polling: the wake's start reaches only the store.
			await vi.waitFor(
				() =>
					expect(
						read(fixture, sessionId).events.map(({ type }) => type),
					).toContain("evidence.turn_started"),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(read(fixture, sessionId).ends).toEqual([send]);
		}
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
		prove(held ? "wake-held" : "wake", ledger);
	});

	// 82tn.32.30 mode 37: a Codex wake (a turn Codex starts by itself) ends with zero or two dones.
	// With no tab viewing the session, every done reaches the project's alerts.
	it("sends one done alert for a Codex wake, at its end", async () => {
		const chain = oneWake(fixtureRows("goal-chain"));
		// No tab ever views the session: closing a viewer is not seen by the daemon at once,
		// so a wake ending first would route its done to that viewer, not to the alerts.
		const { fixture, sessionId } = await wake("wake-done", chain, false);
		const wakeEnd = chain.filter(
			({ message }) => message?.method === "turn/completed",
		)[1]?.["at"];
		if (typeof wakeEnd !== "number") throw new Error("Missing wake end");
		writeFileSync(gatePath, String(wakeEnd - 1));
		// test-waits-allow polling: the wake's start reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.map(({ type }) => type),
				).toContain("evidence.turn_started"),
			{ timeout: TIMEOUT, interval: 100 },
		);
		// Follows the sidebar only, so it never views the session.
		const watcher = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const alerts: {
			kind: string;
			sessionId: string | undefined;
			endsBefore: number;
		}[] = [];
		// The waits resolve on the feed's own envelopes, so the test's limit is their one deadline.
		let opened = () => {};
		let alerted = () => {};
		const synchronized = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const firstDone = new Promise<void>((resolve) => {
			alerted = resolve;
		});
		const alertFiber = Effect.runFork(
			Stream.runForEach(watcher.rpc.SubscribeAlerts({}), (envelope) =>
				Effect.sync(() => {
					if (envelope._tag === "synchronized") opened();
					if (envelope._tag !== "alert") return;
					alerts.push({
						kind: envelope.kind,
						sessionId: envelope.sessionId,
						// How many Runs the store had ended when this alert arrived.
						endsBefore: read(fixture, sessionId).ends.length,
					});
					if (envelope.kind === "done" && envelope.sessionId === sessionId)
						alerted();
				}),
			),
		);
		// The feed is live-only, so it must be open before the wake can end.
		await synchronized;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const done = () =>
			alerts.filter(
				(alert) => alert.kind === "done" && alert.sessionId === sessionId,
			);
		await firstDone;
		const ledger = read(fixture, sessionId);
		await Effect.runPromise(Fiber.interrupt(alertFiber));
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-30-codex-wake-done.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.30", sessionId, alerts, ends: ledger.ends, evidence: ledger.events.filter(({ type }) => type.startsWith("evidence.")) }, null, 2)}\n`,
		);
		expect(wakeEvidence(ledger)[1]?.result).toBe("completed");
		expect(ledger.ends).toHaveLength(2);
		expect(done()).toEqual([{ kind: "done", sessionId, endsBefore: 2 }]);
	});

	it("Stops a wake Run with turn/interrupt, not the alarm", async () => {
		const { fixture, browser, sessionId, trace } = await wake(
			"wake-stop",
			fixtureRows("goal-interrupt"),
		);
		const interrupt = trace.find(
			({ dir, message }) =>
				dir === "out" && message?.method === "turn/interrupt",
		)?.["at"];
		if (typeof interrupt !== "number") throw new Error("Missing interrupt");
		writeFileSync(gatePath, String(interrupt - 1));
		// test-waits-allow polling: the wake's start reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.map(({ type }) => type),
				).toContain("evidence.turn_started"),
			{ timeout: TIMEOUT, interval: 100 },
		);
		const stopping = Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
		// The replay answers the interrupt only once conduit sends it.
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await stopping;
		// test-waits-allow polling: a wake Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).ends).toHaveLength(2),
			{ timeout: TIMEOUT, interval: 100 },
		);
		expect(captured("turn/interrupt", "out")).toHaveLength(1);
		const ledger = read(fixture, sessionId);
		expect(wakeEvidence(ledger)[1]?.result).toBe("interrupted");
		expect(ledger.ends[1]).toEqual(
			expect.objectContaining({ outcome: "interrupted" }),
		);
		expect(ledger.ends[1]?.forced).not.toBe(1);
		prove("wake-stop", ledger);
	});

	it("runs a message sent while only a wake runs as its own Run after the wake (CONTRACT 992-995)", async () => {
		// Gap (CONTRACT 992-995 against its 997 note "a Codex wake Run is not busy"): main's
		// inbox reads a Codex wake as idle (session-inbox.ts 540-545), so the send is no steer.
		// It waits at the start fence (CONTRACT 215) and opens its own turn once the wake ends.
		const chain = oneWake(fixtureRows("goal-chain"));
		const first = chain.findIndex(
			({ message }) => message?.method === "turn/start",
		);
		const exit = chain.findIndex(({ dir }) => dir === "exit");
		const at = Number(chain[exit - 1]?.["at"]) + 1;
		const turnId = "wake-send-turn";
		const turnStart = chain[first]?.message;
		const sendTurn = chain
			.slice(first)
			.filter(
				({ message }) =>
					[
						"turn/start",
						"turn/started",
						"item/started",
						"item/completed",
					].includes(String(message?.method)) ||
					(message?.id === turnStart?.id && !message?.method),
			)
			.slice(0, 5);
		// A send in a goal session is a plain turn: no goal request goes with it.
		expect(sendTurn.map(({ message }) => message?.method ?? "result")).toEqual([
			"turn/start",
			"result",
			"turn/started",
			"item/started",
			"item/completed",
		]);
		const completed = chain.find(
			({ message }) => message?.method === "turn/completed",
		);
		const turn1 = (
			sendTurn[2]?.message?.params?.["turn"] as { id: string } | undefined
		)?.id;
		const user1 = (
			sendTurn[3]?.message?.params?.["item"] as { id: string } | undefined
		)?.id;
		if (!turn1 || !user1) throw new Error("Missing turn 1 ids");
		// The send's turn is turn 1's rows, renamed so no id is shared with the goal's turns.
		const renamed = (row: TraceRow | undefined) => ({
			...row,
			at,
			message: JSON.parse(
				JSON.stringify(row?.message)
					.replaceAll(turn1, turnId)
					.replaceAll(user1, "wake-send-user")
					.replaceAll("msg_mock_1", "msg_wake_send")
					.replaceAll('"Say hello"', JSON.stringify(STEER))
					.replaceAll(`"id":${String(turnStart?.id)},`, '"id":900,'),
			),
		});
		// The app-server exits after the send's turn ends: the send's Run still completes.
		const trace = [
			...chain.slice(0, exit),
			...sendTurn.map(renamed),
			renamed(completed),
			{ ...chain[exit], at },
		] as TraceRow[];
		const wakeEnd = chain.filter(
			({ message }) => message?.method === "turn/completed",
		)[1]?.["at"];
		const { fixture, browser, sessionId } = await wake("wake-send", trace);
		writeFileSync(gatePath, String(Number(wakeEnd) - 1));
		// test-waits-allow polling: the wake's start reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.map(({ type }) => type),
				).toContain("evidence.turn_started"),
			{ timeout: TIMEOUT, interval: 100 },
		);
		await submit(browser, sessionId, STEER, "steer");
		// test-waits-allow polling: the send's admission reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.filter(
						({ type }) => type === "run.requested",
					),
				).toHaveLength(2),
			{ timeout: TIMEOUT, interval: 100 },
		);
		expect(captured("turn/start", "out")).toHaveLength(1);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		// test-waits-allow polling: the wake's and the send's ends reach only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).ends).toHaveLength(3),
			{ timeout: TIMEOUT, interval: 100 },
		);
		const ledger = read(fixture, sessionId);
		const [, wakeEnded] = wakeEvidence(ledger);
		endsOnce(ledger);
		expect(ledger.runs).toHaveLength(2);
		const sendRun = ledger.runs[1]?.id;
		const sendStarted = ledger.events.filter(
			({ type, runId }) => type === "run.started" && runId === sendRun,
		);
		expect(sendStarted).toHaveLength(1);
		expect(sendStarted[0]?.sequence).toBeGreaterThan(
			Number(wakeEnded?.sequence),
		);
		expect(ledger.ends[2]).toEqual(
			expect.objectContaining({ runId: sendRun, outcome: "completed" }),
		);
		expect(captured("turn/start", "out")).toHaveLength(2);
		expect(captured("turn/steer", "out")).toHaveLength(0);
		prove("wake-send", ledger);
	});

	/** Each runner start, in order (F275). */
	const processEvidence = (ledger: Ledger) =>
		ledger.events
			.filter(({ type }) => type.startsWith("evidence.process_"))
			.map(({ type, runnerId, reattached }) => ({
				type,
				runnerId,
				reattached,
			}));
	const reattachedOnce = (ledger: Ledger) => {
		const [first] = processEvidence(ledger);
		expect(processEvidence(ledger)).toEqual([
			{
				type: "evidence.process_started",
				runnerId: first?.runnerId,
				reattached: 0,
			},
			{
				type: "evidence.process_started",
				runnerId: first?.runnerId,
				reattached: 1,
			},
		]);
	};

	it("keeps a Codex turn running through a daemon restart; its Run ends once on the same runner", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"restart-mid-turn",
			fixtureRows("basic"),
		);
		const delta = fixtureRows("basic").find(
			({ message }) => message?.method === "item/agentMessage/delta",
		)?.["at"];
		writeFileSync(gatePath, String(delta));
		const inputId = randomUUID();
		await submit(browser, sessionId, "Say hello", "queue", inputId);
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("item/agentMessage/delta")).not.toEqual([]),
			{ timeout: TIMEOUT },
		);
		expect(read(fixture, sessionId).ends).toEqual([]);
		await fixture.kill();
		await restart();
		await (await fixture.connect()).followSession(sessionId);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "completed" }),
		]);
		reattachedOnce(ledger);
		expect(captured("turn/start", "out")).toHaveLength(1);
		// F279: output the runner sent before the restart lands once, not again on reattach.
		expect(
			ledger.events.filter(
				({ type, messageId }) => type === "text.delta" && messageId !== inputId,
			),
		).toHaveLength(
			fixtureRows("basic").filter(
				({ message }) => message?.method === "item/agentMessage/delta",
			).length,
		);
		prove("restart-mid-turn", ledger);
		proveCrashMatrixCell(
			"codex/send/daemon/running",
			fixture.daemonStorePath(),
			sessionId,
		);
	});

	// Two-build upgrade (CONTRACT.md 3051): main's daemon holds a Codex turn, is SIGKILLed, and
	// the current build restarts on its store.
	// test-waits-allow timeout-override: a cold cache builds main's tree before the test runs.
	it("settles a Codex turn main's runner held through an upgrade once, never re-sent", async (context) => {
		const historical = await historicalRunnerBundle(
			"020678548921ff6419796274482a1a9ecc5dfc69",
		);
		if (!historical.available) context.skip(historical.reason);
		if (!historical.available) return;
		const { fixture, browser, sessionId, restart } = await start(
			"two-build",
			fixtureRows("basic"),
			{},
			{ dist: historical.dist },
		);
		const delta = fixtureRows("basic").find(
			({ message }) => message?.method === "item/agentMessage/delta",
		)?.["at"];
		writeFileSync(gatePath, String(delta));
		await submit(browser, sessionId, "Say hello");
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("item/agentMessage/delta")).not.toEqual([]),
			{ timeout: TIMEOUT },
		);
		expect(captured("turn/start", "out")).toHaveLength(1);
		await fixture.kill();
		await restart(process.env["CONDUIT_TEST_DIST"] ?? "dist");
		await (await fixture.connect()).followSession(sessionId);
		// main's runner is an older build: this build retires it and ends its turn once, never
		// re-sending it (CONTRACT.md 3051, F39).
		await turns(fixture, sessionId, ["error"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "error" }),
		]);
		expect(ledger.runs).toHaveLength(1);
		proveCrashMatrixCell(
			"two-build/codex",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 300_000);
	it("keeps a wake running through a daemon restart; it ends once at its own result", async () => {
		const { fixture, sessionId, trace, restart } = await wake(
			"restart-wake",
			oneWake(fixtureRows("goal-chain")),
		);
		const [send] = read(fixture, sessionId).ends;
		const wakeEnd = trace.filter(
			({ message }) => message?.method === "turn/completed",
		)[1]?.["at"];
		writeFileSync(gatePath, String(Number(wakeEnd) - 1));
		// test-waits-allow polling: the wake's start reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.map(({ type }) => type),
				).toContain("evidence.turn_started"),
			{ timeout: TIMEOUT, interval: 100 },
		);
		await fixture.kill();
		await restart();
		await (await fixture.connect()).followSession(sessionId);
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
		expect(ledger.ends[1]?.forced).not.toBe(1);
		expect(
			ledger.events.filter(
				({ sequence, type, messageId }) =>
					sequence > (started?.sequence ?? 0) &&
					sequence < (ended?.sequence ?? 0) &&
					type.startsWith("message.") &&
					messageId,
			),
		).not.toEqual([]);
		reattachedOnce(ledger);
		expect(captured("turn/start", "out")).toHaveLength(1);
		prove("restart-wake", ledger);
	});

	it("keeps a goal chain's Run open through a daemon restart inside its successor window", async () => {
		const chain = fixtureRows("goal-chain");
		const { fixture, browser, sessionId, restart } = await start(
			"restart-successor",
			chain,
		);
		const firstEnd = chain.find(
			({ message }) => message?.method === "turn/completed",
		)?.["at"];
		writeFileSync(gatePath, String(firstEnd));
		await goalSubmit(browser, sessionId);
		// test-waits-allow polling: the app-server's turn end reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("turn/completed", "in")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		await fixture.kill();
		expect(read(fixture, sessionId).ends).toEqual([]);
		await restart();
		await (await fixture.connect()).followSession(sessionId);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "completed" }),
		]);
		expect(
			ledger.events.filter(({ type }) => type.startsWith("evidence.turn_")),
		).toEqual([]);
		expect(captured("turn/started", "in").length).toBeGreaterThan(1);
		reattachedOnce(ledger);
		prove("restart-successor", ledger);
	});

	it("runs a send the daemon claimed but never handed to the runner once after a restart", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"restart-unheld",
			fixtureRows("basic"),
			{},
			{ restartProof: true, holdRunnerOutput: "send-turn" },
		);
		await submit(browser, sessionId, "Say hello");
		// test-waits-allow polling: the held hand-off is reported only in the runner's proof file.
		await vi.waitFor(
			() =>
				expect(
					rows<{ kind: string; type: string }>(
						join(fixture.root, "sdk-proof.ndjson"),
					),
				).toContainEqual({ kind: "held-output", type: "send-turn" }),
			{ timeout: TIMEOUT },
		);
		expect(captured("turn/start", "out")).toEqual([]);
		await fixture.kill();
		await restart();
		await (await fixture.connect()).followSession(sessionId);
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.runs).toHaveLength(1);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "completed" }),
		]);
		expect(captured("turn/start", "out")).toHaveLength(1);
		prove("restart-unheld", ledger, {
			lost: processEvidence(ledger),
		});
		proveCrashMatrixCell(
			"codex/send/daemon/absent",
			fixture.daemonStorePath(),
			sessionId,
		);
	});

	// The crash matrix (82tn.32.14; CONTRACT.md 4.9 1914-1945, 9, 11.3). How a cell could fail:
	// M1. a Run ends twice, never, or other than main's status says;
	// M2. an effect is left running or held with no Run or runner to own it (S9.6);
	// M3. an input lands twice, returns to the queue twice, or never lands when it should;
	// M4. a turn or the session stays busy, or a steer stays steering;
	// M5. a send or control goes out again after the kill (a second turn/start, turn/steer,
	//     turn/interrupt or approval reply), or past five transmissions;
	// M6. the next send after a runner's death never runs, or carries the lost send's text.
	const threadOf = (fixture: ProcessHarness, sessionId: string) =>
		(
			JSON.parse(
				readFileSync(
					join(fixture.configDir, "codex", "stores", sessionId, "session.json"),
					"utf8",
				),
			) as { threadId: string }
		).threadId;
	/** After a runner's death the next send resumes the thread once, with only its own text (M6). */
	const nextSendResumes = async (
		fixture: ProcessHarness,
		browser: ProcessBrowser,
		sessionId: string,
		threadId: string,
	) => {
		// test-waits-allow polling: the runner's death reaches only the store and the process table.
		await vi.waitFor(
			() => {
				expect(fixture.remainingRunnerPids()).toEqual([]);
				expect(read(fixture, sessionId).turns).not.toContain("running");
			},
			{ timeout: TIMEOUT, interval: 200 },
		);
		writeTrace(resumeTrace(fixtureRows("basic"), threadId));
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await submit(browser, sessionId, "Say hello again");
		// test-waits-allow polling: the next Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).turns.at(-1)).toBe("completed"),
			{ timeout: TIMEOUT },
		);
		const starts = captured("turn/start", "out");
		expect(starts).toHaveLength(1);
		expect(JSON.stringify(starts[0]?.message?.params)).toContain(
			"Say hello again",
		);
	};
	/** stop-queued with turn/started and turn/interrupt behind gate 1, the interrupt's answer and
	 * the turn's end behind gate 2: at gate 1 the Stop goes out and stays unanswered. */
	const stopTrace = () => {
		let at = 0;
		return fixtureRows("stop-queued").map((row) => {
			if (row.message?.method === "turn/started") at = 1;
			if (at === 1 && row.dir === "in" && row.message?.id === 99) at = 2;
			return { ...row, at };
		});
	};
	const stopInFlight = async (name: string) => {
		const started = await start(name, stopTrace());
		writeFileSync(gatePath, "0");
		await submit(started.browser, started.sessionId, "Say hello");
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() =>
				expect(
					rows<TraceRow>(capturePath).some(
						(row) => row.message?.result?.["turn"],
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		const stopping = Effect.runPromiseExit(
			started.browser.rpc.CancelSession({
				sessionId: started.sessionId,
				commandId: randomUUID(),
			}),
		);
		writeFileSync(gatePath, "1");
		// test-waits-allow polling: the app-server's input reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("turn/interrupt", "out")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		return { ...started, stopping };
	};

	// test-waits-allow timeout-override: a daemon restart and a resumed send each take seconds.
	it("ends a Stop's Run interrupted once when the daemon dies with turn/interrupt unanswered", async () => {
		const { fixture, sessionId, restart, stopping } =
			await stopInFlight("matrix-stop-daemon");
		await fixture.kill();
		await stopping;
		await restart();
		await (await fixture.connect()).followSession(sessionId);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await turns(fixture, sessionId, ["interrupted"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "interrupted" }),
		]);
		reattachedOnce(ledger);
		expect(captured("turn/interrupt", "out")).toHaveLength(1);
		expect(captured("turn/start", "out")).toHaveLength(1);
		proveCrashMatrixCell(
			"codex/stop/daemon",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: a daemon restart and a resumed send each take seconds.
	it("ends a Stop's Run once when its runner dies with turn/interrupt unanswered, and the next send resumes once", async () => {
		const { fixture, browser, sessionId, stopping } =
			await stopInFlight("matrix-stop-runner");
		const threadId = threadOf(fixture, sessionId);
		for (const pid of fixture.remainingRunnerPids())
			process.kill(pid, "SIGKILL");
		await stopping;
		await nextSendResumes(fixture, browser, sessionId, threadId);
		const ledger = read(fixture, sessionId);
		// A Stop asked ends its Run interrupted before its lost runner's error (CONTRACT 857-859),
		// though main's row reads error: the ledger owns the Run's outcome (5774-5776).
		expect(
			ledger.runs.map((run) => ({
				status: run.status,
				ends: ledger.ends
					.filter((end) => end.runId === run.id)
					.map((end) => end.outcome),
			})),
		).toEqual([
			{ status: "error", ends: ["interrupted"] },
			{ status: "completed", ends: ["completed"] },
		]);
		proveCrashMatrixCell(
			"codex/stop/runner",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: a daemon restart and a resumed send each take seconds.
	it("delivers a steer once when the daemon dies with its turn/steer unanswered", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"matrix-steer-daemon",
			fixtureRows("steer"),
		);
		writeFileSync(gatePath, "590");
		await submit(browser, sessionId, "Say hello");
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("item/agentMessage/delta")).not.toEqual([]),
			{ timeout: TIMEOUT },
		);
		await submit(browser, sessionId, STEER, "steer", "matrix-steer");
		// test-waits-allow polling: the app-server's input reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("turn/steer", "out")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		await fixture.kill();
		await restart();
		await (await fixture.connect()).followSession(sessionId);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await turns(fixture, sessionId, ["completed", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		reattachedOnce(ledger);
		expect(captured("turn/steer", "out")).toHaveLength(1);
		expect(captured("turn/start", "out")).toHaveLength(1);
		proveCrashMatrixCell(
			"codex/steer/daemon",
			fixture.daemonStorePath(),
			sessionId,
			["matrix-steer"],
		);
	}, 120_000);

	// test-waits-allow timeout-override: a daemon restart and a resumed send each take seconds.
	it("ends an answered approval's Run once when its runner dies before the app-server takes the reply, never replying again", async () => {
		const { fixture, browser, sessionId } = await start(
			"matrix-answer-runner",
			fixtureRows("approval-command-once"),
		);
		// Hold the replay after the approval request (134), before the app-server resolves it (135).
		writeFileSync(gatePath, "134");
		const cursor = browser.frames.length;
		await submit(browser, sessionId, "Run the command");
		const card = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["sessionId"] === sessionId,
			cursor,
			TIMEOUT,
		);
		const threadId = threadOf(fixture, sessionId);
		await browser.answerApproval(card, "allow");
		const replied = () =>
			rows<TraceRow>(capturePath).filter(
				(row) => row.dir === "out" && row.message?.id === 0,
			);
		// test-waits-allow polling: the app-server's input reaches only its capture file.
		await vi.waitFor(() => expect(replied()).toHaveLength(1), {
			timeout: TIMEOUT,
		});
		for (const pid of fixture.remainingRunnerPids())
			process.kill(pid, "SIGKILL");
		await nextSendResumes(fixture, browser, sessionId, threadId);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.runs).toHaveLength(2);
		expect(replied()).toEqual([]);
		proveCrashMatrixCell(
			"codex/answer/runner",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: a daemon restart and a resumed send each take seconds.
	it("settles a send its runner finished while the daemon was down once, from the runner's journal (finished)", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"matrix-journal-finished",
			fixtureRows("basic"),
		);
		writeFileSync(gatePath, "383");
		await submit(browser, sessionId, "Say hello");
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("item/agentMessage/delta")).not.toEqual([]),
			{ timeout: TIMEOUT },
		);
		await fixture.kill();
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		// test-waits-allow polling: the app-server's output reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("turn/completed", "in")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		await restart();
		await (await fixture.connect()).followSession(sessionId);
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "completed" }),
		]);
		reattachedOnce(ledger);
		expect(captured("turn/start", "out")).toHaveLength(1);
		proveCrashMatrixCell(
			"codex/journal/finished",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: a daemon restart and a resumed send each take seconds.
	it("never re-sends a send whose turn/start went out unanswered when its runner died (uncertain)", async () => {
		const { fixture, browser, sessionId } = await start(
			"matrix-journal-uncertain",
			fixtureRows("basic"),
		);
		// Hold the replay before turn/start's answer (183): its delivery stays unknown.
		writeFileSync(gatePath, "182");
		await submit(browser, sessionId, "Say hello");
		// test-waits-allow polling: the app-server's input reaches only its capture file.
		await vi.waitFor(
			() => expect(captured("turn/start", "out")).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		const threadId = threadOf(fixture, sessionId);
		for (const pid of fixture.remainingRunnerPids())
			process.kill(pid, "SIGKILL");
		await nextSendResumes(fixture, browser, sessionId, threadId);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.runs.map(({ status }) => status)).toEqual([
			"error",
			"completed",
		]);
		proveCrashMatrixCell(
			"codex/journal/uncertain",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);
});
