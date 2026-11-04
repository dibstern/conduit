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
		const restart = () =>
			fixture.restart({
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
		return { fixture, browser, sessionId, restart };
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
		await browser.send(sessionId, "$goal Say hello", TIMEOUT);
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
	const wake = async (name: string, trace: TraceRow[]) => {
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
		const sendTurn = chain
			.slice(first)
			.filter(
				({ message }) =>
					[
						"turn/start",
						"thread/goal/set",
						"turn/started",
						"item/started",
						"item/completed",
					].includes(String(message?.method)) ||
					[4, 5].includes(Number(message?.id)),
			)
			.slice(0, 7);
		// A send in a goal session re-arms the goal after its turn/start, as turn 1 does.
		expect(sendTurn.map(({ message }) => message?.method ?? "result")).toEqual([
			"turn/start",
			"result",
			"thread/goal/set",
			"turn/started",
			"result",
			"item/started",
			"item/completed",
		]);
		const completed = chain.find(
			({ message }) => message?.method === "turn/completed",
		);
		// The send's turn is turn 1's rows, renamed so no id is shared with the goal's turns.
		const renamed = (row: TraceRow | undefined) => ({
			...row,
			at,
			message: JSON.parse(
				JSON.stringify(row?.message)
					.replaceAll("01a15f39-35ab-78e0-a2c4-5bbb92ceb680", turnId)
					.replaceAll("01a15f39-35dc-7c31-ab4c-020b1f2b6415", "wake-send-user")
					.replaceAll("msg_mock_1", "msg_wake_send")
					.replaceAll('"Say hello"', JSON.stringify(STEER))
					.replaceAll('"id":4,', '"id":900,')
					.replaceAll('"id":5,', '"id":901,'),
			),
		});
		// The app-server exits inside the send's goal successor window: the send's Run still completes.
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
	});

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
		await submit(browser, sessionId, "$goal Say hello");
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
	});
});
