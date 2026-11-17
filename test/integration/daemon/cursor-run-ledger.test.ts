// Cursor on the Run Ledger end to end (82tn.32.10; CONTRACT.md 2.1 row 215, 9 at 3113-3117), over
// the isolated process harness and recorded Cursor SDK traces. How it could fail (lane audit
// F140-F152):
// 140. a Cursor send's Run ends twice, or never, in the ledger;
// 141. no process_started for the Cursor runner, or it lands after the runner's first frame;
// 142. a Cursor send's own turn reports turn evidence (Cursor starts no unsolicited turn);
// 143. a delivered steer's Run ends other than once, or the steer causes a second native send;
// 144. a Stop ends its Run other than interrupted, forced by the alarm, or twice;
// 145. an answered question's Run ends other than once, or the answer reaches the SDK twice;
// 146. a Run's ledger end disagrees with main's run status;
// 147. the interrupt-timeout abandonment is unmarked on the wire, so it reads as a native result;
// 148. the abandoned Run ends forced, completed, errored, or twice;
// 149. the fence lets go at the abandonment: the next start is handed to a runner before the
//      abandoned runner's process_lost;
// 150. the fence never lets go: the next start waits forever after the runner retires;
// 151. the mark leaks into a native-cancel Stop;
// 152. the held next start is handed to the retiring runner, or delivered twice; or, unlaunched by
//      that runner's retirement, it is never relaunched (CONTRACT.md 3.6, 3270-3274).
// A Cursor runner's start on reattach and swap, and its loss ending its Runs (CONTRACT.md 6.1, 6.4
// 2330-2332, 6.5 2390-2395, 6.9; lane audit F260-F267):
// 260. a restart that recovers the surviving runner reports no start, one not reattached, a loss,
//      or a second runner;
// 261. the reattach's label is not the runner's hello querySeq;
// 262. a runner killed mid-send leaves its Run open in the ledger, or ends it twice;
// 263. that Run ends other than process_lost, or before the runner's process_lost is folded;
// 264. the killed runner's process_lost is missing, or appended twice;
// 265. the in-flight input is sent again (a blind resend), or the follow-up does not run once on a
//      new runner;
// 266. a swap to a new build misses R's process_started, or lands it before old's process_lost
//      or in another write;
// 267. a Run ends twice across the swap, or the send after it runs on old.
// Retiring a Cursor runner ends its agent's shell commands (82tn.32.10.1; lane audit F240-F253).
// Cursor starts each shell command detached, in its own session and group, so the runner's group
// kill misses it; the stand-in here starts the same way:
// 240. the runner dies first (abandonment exit, crash, SIGKILL), so a list kept only in the runner
//      is lost and the shell, reparented to PID 1, is no longer the runner's descendant;
// 241. the shell's own session and group escape both the group kill and a session sweep;
// 252. retirement completes, or the marker still appears, while the shell is alive.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { proveCrashMatrixCell } from "../../helpers/crash-matrix-cell.js";
import { historicalRunnerBundle } from "../../helpers/historical-runner-bundle.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { proveToolRowsOnLedger } from "../../helpers/tool-rows-proof.js";

interface TraceRow {
	kind?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

const TIMEOUT = 25_000;
// Past the abandonment's 10 s interrupt timeout and the runner's exit.
const SHELL_DELAY_S = 18;
const SHELL_TEST_TIMEOUT = 60_000;
const shellAlive = (pid: number) => {
	try {
		const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
			encoding: "utf8",
		}).trim();
		return state !== "" && !state.startsWith("Z");
	} catch {
		return false;
	}
};
const STEER = "After the tool, say STEER_SEEN_7931.";

const traceRows = (path: string): TraceRow[] =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as TraceRow)
		: [];
const fixtureTrace = (source: string) =>
	traceRows(resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`));

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare(
					"SELECT sequence, type, coalesce(json_extract(data, '$.runId'), json_extract(metadata, '$.runId')) AS runId, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.code') AS code, json_extract(data, '$.label') AS label, json_extract(data, '$.reattached') AS reattached FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				runId: string | null;
				runnerId: string | null;
				code: string | null;
				label: string | null;
				reattached: number | null;
			}[],
			ends: db
				.prepare(
					"SELECT event_sequence AS sequence, json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.outcome') AS outcome, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				sequence: number;
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
			runners: db
				.prepare(
					"SELECT runner_id AS runnerId, retired_at AS retiredAt FROM claude_runner_cursors WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { runnerId: string; retiredAt: number | null }[],
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

/**
 * Each Run main started ends in the ledger once, with main's outcome (F140, F146); a steer's run
 * that joined another has no Run of its own (3.9).
 */
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

/** One Cursor runner, its start before its first frame (F141), and no turn evidence (F142). */
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

describe("Cursor on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	let capturePath = "";
	const proofs: Record<string, unknown>[] = [];
	const shellProofs: Record<string, unknown>[] = [];
	const standIns: number[] = [];
	afterEach(async () => {
		const fixture = harness;
		harness = undefined;
		const findings = probeFindings(fixture);
		await fixture?.dispose();
		expect(findings).toBe(0);
		// A surviving stand-in is this test's own process group; end it so a red run leaves nothing.
		for (const pid of standIns.splice(0))
			if (shellAlive(pid)) process.kill(-pid, "SIGKILL");
		expect(fixture?.remainingRunnerPids() ?? []).toEqual([]);
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-10-cursor-ledger.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.10", proofs }, null, 2)}\n`,
		);
		if (shellProofs.length > 0)
			writeFileSync(
				"test-results/82tn-32-10-1-cursor-shell-retirement.json",
				`${JSON.stringify({ ticket: "conduit-test-82tn.32.10.1", proofs: shellProofs }, null, 2)}\n`,
			);
	});

	const start = async (
		name: string,
		source: string,
		environment: Record<string, string> = {},
		buildId?: string,
		dist = process.env["CONDUIT_TEST_DIST"] ?? "dist",
	) => {
		// main's session detail feed fails this build's schema (82tn.51 dropped its rewind row),
		// so a browser on main's daemon leaves the session unviewed.
		const view = dist === (process.env["CONDUIT_TEST_DIST"] ?? "dist");
		const fixture = ProcessHarness.create({
			dist,
			...(buildId ? { buildId } : {}),
			// The send-continuation pause writes its mark to the process proof.
			...(environment["CONDUIT_TEST_SEND_CONTINUATION_PAUSE"]
				? { restartProof: true }
				: {}),
		});
		harness = fixture;
		const tracePath = join(fixture.root, "cursor-replay.jsonl");
		capturePath = join(fixture.root, "cursor-capture.jsonl");
		const rows = fixtureTrace(source);
		const catalog = fixtureTrace("basic").find(
			({ kind }) => kind === "models.list",
		);
		if (!catalog) throw new Error("Basic capture has no model catalog");
		rows.splice(
			1,
			0,
			{
				kind: "credential.store",
				data: {
					apiKey: "[REDACTED]",
					backendUrl: "https://api2.cursor.sh",
					createdAtMs: 0,
				},
			},
			...(rows.some(({ kind }) => kind === "models.list") ? [] : [catalog]),
		);
		writeFileSync(
			tracePath,
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		const restart = (nextBuildId?: string, nextDist?: string) =>
			fixture.restart({
				...(nextDist ? { dist: nextDist } : {}),
				startupTimeoutMs: TIMEOUT,
				runnerStartupTimeoutMs: TIMEOUT,
				...(nextBuildId ? { buildId: nextBuildId } : {}),
				serviceEnvironment: {
					CONDUIT_CURSOR_SDK_TRACE: tracePath,
					CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
					CONDUIT_TEST_CURSOR_DELTA_DELAY_MS: "2",
					...environment,
				},
			});
		await restart();
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor ledger replay",
			driver: "cursor",
		});
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			view,
		);
		const sessionId = await browser.createSession(
			name,
			added.addedInstanceId,
			"cursor",
			{
				modelId: "composer-2.5",
				contextWindow: "",
				permissionMode: "ask",
				view,
			},
		);
		return { fixture, browser, sessionId, restart };
	};
	const submit = (
		browser: ProcessBrowser,
		sessionId: string,
		text: string,
		delivery: "queue" | "steer" = "queue",
		inputId: string = randomUUID(),
	) =>
		Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery,
				text,
			}),
		);
	const turns = (
		fixture: ProcessHarness,
		sessionId: string,
		states: string[],
	) =>
		vi.waitFor(() => expect(read(fixture, sessionId).turns).toEqual(states), {
			timeout: TIMEOUT,
			interval: 100,
		});
	const captured = (kind: string) =>
		traceRows(capturePath).filter((row) => row.kind === kind);
	const thinking = (fixture: ProcessHarness, sessionId: string) =>
		vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.some(
						({ type }) => type === "thinking.delta",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
	const stop = (browser: ProcessBrowser, sessionId: string) =>
		Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
	const prove = (name: string, ledger: Ledger, extra = {}) =>
		proofs.push({
			case: name,
			ends: ledger.ends,
			runs: ledger.runs,
			evidence: ledger.events.filter(({ type }) =>
				type.startsWith("evidence.process_"),
			),
			...extra,
		});

	it("ends a send's Run once, its runner's start reported before its first frame", async () => {
		const { fixture, browser, sessionId } = await start("send", "basic");
		await submit(browser, sessionId, "Replay the captured basic turn.");
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		prove("send", ledger);
	});

	// 82tn.32.50 (lane 3250 audit 11): a Stop while the send waits before its hold, with no Cursor
	// process to signal, ends the Run interrupted at once and the agent never gets the prompt
	// (CONTRACT 664-666, D50).
	it("ends a send stopped before its hold interrupted at once, never sending it (82tn.32.50)", async () => {
		const { fixture, browser, sessionId } = await start(
			"stop-before-hold",
			"basic",
			{ CONDUIT_TEST_SEND_CONTINUATION_PAUSE: "before-hold" },
		);
		const gate = join(
			fixture.root,
			"conduit-test-send-continuation-before-hold",
		);
		writeFileSync(gate, "hold");
		await submit(browser, sessionId, "Replay the captured basic turn.");
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "send-continuation-paused" &&
				mark["point"] === "before-hold",
		);
		await stop(browser, sessionId);
		rmSync(gate, { force: true });
		await turns(fixture, sessionId, ["interrupted"]);
		expect(captured("send.options")).toEqual([]);
		// 82tn.83: the stopped send's end names its input, so the browser settles it with no later turn.
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		const end = db
			.prepare(
				"SELECT sessions.last_turn_end_input_id AS ended, pending.input_id AS stopped FROM sessions JOIN pending_inputs pending ON pending.session_id = sessions.id WHERE sessions.id = ? AND pending.text = ?",
			)
			.get(sessionId, "Replay the captured basic turn.") as {
			ended: string | null;
			stopped: string;
		};
		db.close();
		expect(end.ended).toBe(end.stopped);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.ends).toEqual([
			expect.objectContaining({ outcome: "interrupted" }),
		]);
		prove("stop-before-hold", ledger);
	});

	it("stamps every tool row, a subagent's too, with its Run's id and the project folder (82tn.45)", async () => {
		const { fixture, browser, sessionId } = await start(
			"tool-rows",
			"subagent-foreground-default-fixed",
		);
		await submit(browser, sessionId, "Replay the captured subagent turn.");
		await turns(fixture, sessionId, ["completed"]);
		endsOnce(read(fixture, sessionId));
		proveToolRowsOnLedger("cursor", fixture);
	});

	// 92 (AMENDMENT-2026-11-16): each capture's complete_delivered answer, not
	// its user-message delta, joins the steer to the running turn's Run.
	it.each([
		"steer",
		"steer-shell",
	] as const)("ends a delivered steer's Run once, in the one native send (%s)", async (source) => {
		const { fixture, browser, sessionId } = await start(source, source);
		await submit(browser, sessionId, "Replay the captured running turn.");
		await vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.some(
						({ type }) => type === "tool.started",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		await submit(browser, sessionId, STEER, "steer");
		await turns(fixture, sessionId, ["completed", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(captured("steer.call")).toHaveLength(1);
		expect(captured("send.options")).toHaveLength(1);
		prove(source, ledger);
	});

	it("ends a Stopped Run interrupted once, not forced and not marked abandoned", async () => {
		const { fixture, browser, sessionId } = await start("stop", "cancel");
		await submit(
			browser,
			sessionId,
			"Call the human custom tool once, then say done.",
		);
		await thinking(fixture, sessionId);
		await stop(browser, sessionId);
		await turns(fixture, sessionId, ["interrupted"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(
			ledger.ends.map(({ reason, forced }) => ({ reason, forced })),
		).toEqual([{ reason: "interrupted", forced: 0 }]);
		expect(
			ledger.events
				.filter(({ type }) => type === "turn.interrupted")
				.map(({ code }) => code),
		).toEqual([null]);
		prove("stop", ledger);
	});

	// 82tn.45: a tool the Stop leaves running (the trace cancels inside its call). How it could fail:
	// the row stays running after its Run ends; it reads as failed; it ends under another Run.
	it("shows a tool still running when its Run is Stopped as ended by the run, not failed (82tn.45)", async () => {
		const { fixture, browser, sessionId } = await start(
			"tool-run-end",
			"cancel",
		);
		await browser.followSession(sessionId);
		await submit(
			browser,
			sessionId,
			"Call the human custom tool once, then say done.",
		);
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				JSON.stringify(message["parts"]).includes('"type":"tool"'),
		);
		await stop(browser, sessionId);
		await turns(fixture, sessionId, ["interrupted"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		const tools = db
			.prepare(
				"SELECT p.tool_name AS tool, p.status, p.run_id AS runId, p.ended_at AS endedAt, p.ended_by AS endedBy FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND p.type = 'tool'",
			)
			.all(sessionId);
		db.close();
		writeFileSync(
			resolve("test-results/82tn-45-ended-by-run.json"),
			`${JSON.stringify({ tools, ends: ledger.ends }, null, 2)}\n`,
		);
		expect(tools).toEqual([
			{
				tool: "mcp__custom-user-tools__human",
				status: "completed",
				runId: ledger.ends[0]?.runId,
				endedAt: expect.any(Number),
				endedBy: "run",
			},
		]);
	});

	it("ends an answered question's Run once, the answer reaching the SDK once", async () => {
		const { fixture, browser, sessionId } = await start(
			"answer",
			"question-basic",
		);
		const cursor = browser.frames.length;
		await submit(
			browser,
			sessionId,
			"Ask me which deployment to use with ask_user.",
		);
		const question = await browser.waitFor(
			(message) =>
				message["type"] === "question_pending" &&
				message["sessionId"] === sessionId,
			cursor,
			TIMEOUT,
		);
		expect(
			await Effect.runPromise(
				browser.rpc.AnswerQuestion({
					projectSlug: "process-test",
					originId: browser.originId,
					commandId: randomUUID(),
					toolId: String(question["toolId"]),
					answers: { "0": "Blue" },
				}),
			),
		).toEqual({ ok: true });
		await turns(fixture, sessionId, ["completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(captured("custom.result")).toHaveLength(1);
		prove("answer", ledger);
	});

	it("marks an abandoned Run on the wire and ends it interrupted, not forced", async () => {
		const { fixture, browser, sessionId } = await start("abandoned", "cancel", {
			CONDUIT_TEST_CURSOR_CANCEL_NEVER_SETTLES: "1",
		});
		await submit(
			browser,
			sessionId,
			"Call the human custom tool once, then say done.",
		);
		await thinking(fixture, sessionId);
		await stop(browser, sessionId);
		await turns(fixture, sessionId, ["interrupted"]);
		await submit(browser, sessionId, "Say cancel followup.");
		await turns(fixture, sessionId, ["interrupted", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const [abandoned, next] = ledger.runs;
		// F147: the runner marks the abandonment terminal on the wire (CONTRACT.md 3117).
		expect(
			ledger.events
				.filter(({ type }) => type === "turn.interrupted")
				.map(({ runId, code }) => ({ runId, code })),
		).toEqual([{ runId: abandoned?.id, code: "abandoned" }]);
		// F148: its Run's outcome is interrupted, not forced (CONTRACT.md 3114-3116).
		expect(ledger.ends[0]).toMatchObject({
			runId: abandoned?.id,
			reason: "interrupted",
			forced: 0,
		});
		// F149, F152: the next start is handed over once, to a new runner, after the abandoned
		// runner's process_lost.
		const lost = ledger.events.filter(
			({ type }) => type === "evidence.process_lost",
		);
		const handed = ledger.events.filter(
			({ type, runId }) => type === "run.dispatched" && runId === next?.id,
		);
		expect(lost).toHaveLength(1);
		expect(handed).toHaveLength(1);
		expect(handed[0]?.sequence).toBeGreaterThan(lost[0]?.sequence ?? 0);
		expect(handed[0]?.runnerId).not.toBe(lost[0]?.runnerId);
		// F150: the next start runs, and its Run ends once (endsOnce above).
		expect(ledger.ends[1]).toMatchObject({
			runId: next?.id,
			reason: "completed",
		});
		expect(captured("send.options")).toHaveLength(2);
		prove("abandoned", ledger, { lost, handed });
	});

	const processEvidence = (ledger: Ledger) =>
		ledger.events
			.filter(({ type }) => type.startsWith("evidence.process_"))
			.map(({ type, runnerId, label, reattached }) => ({
				type,
				runnerId,
				label,
				reattached,
			}));
	const runnerPid = (fixture: ProcessHarness, sessionId: string) => {
		const mark = fixture.marks.find(
			(candidate) =>
				candidate.kind === "runner-started" &&
				candidate.sessionId === sessionId,
		);
		if (mark?.kind !== "runner-started") throw new Error("no runner hello");
		return mark.pid;
	};

	it("reports reattached true when a daemon restart recovers the surviving runner", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"reattach",
			"basic",
		);
		await submit(browser, sessionId, "Replay the captured basic turn.");
		await turns(fixture, sessionId, ["completed"]);
		const [runner] = read(fixture, sessionId).runners;
		if (!runner) throw new Error("no runner row");
		await fixture.kill();
		await restart();
		await submit(
			await fixture.connect(sessionId),
			sessionId,
			"Replay the captured basic turn again.",
		);
		await turns(fixture, sessionId, ["completed", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		// F260, F261: one runner served both sends; a fresh start, then the reattach, same label.
		const { runnerId } = runner;
		expect(ledger.runners.map((row) => row.runnerId)).toEqual([runnerId]);
		expect(processEvidence(ledger)).toEqual([
			{
				type: "evidence.process_started",
				runnerId,
				label: `${runnerId}:0`,
				reattached: 0,
			},
			{
				type: "evidence.process_started",
				runnerId,
				label: `${runnerId}:0`,
				reattached: 1,
			},
		]);
		prove("reattach", ledger);
	});

	it("ends a killed runner's Run process_lost at its loss, and runs the next send once on a new runner", async () => {
		const gate = join(mkdtempSync(join(tmpdir(), "cursor-gate-")), "gate");
		writeFileSync(gate, "hold");
		const { fixture, browser, sessionId } = await start("killed", "basic", {
			CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
		});
		await submit(browser, sessionId, "Replay the captured basic turn.");
		await thinking(fixture, sessionId);
		expect(captured("send.options")).toHaveLength(1);
		const [killed] = read(fixture, sessionId).runs;
		const killedRunner = read(fixture, sessionId).events.find(
			({ type, runId }) => type === "run.dispatched" && runId === killed?.id,
		)?.runnerId;
		expect(
			fixture.signalOwnedRunner(runnerPid(fixture, sessionId), "SIGKILL"),
		).toBe(true);
		await turns(fixture, sessionId, ["error"]);
		rmSync(gate);
		await submit(browser, sessionId, "Replay the captured basic turn again.");
		await turns(fixture, sessionId, ["error", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const lost = ledger.events.filter(
			({ type }) => type === "evidence.process_lost",
		);
		// F264: one loss, the killed runner's.
		expect(killedRunner).toEqual(expect.any(String));
		expect(lost.map(({ runnerId }) => runnerId)).toEqual([killedRunner]);
		// F262, F263: the killed send's Run ends once, process_lost, folded from that loss
		// (CONTRACT.md 6.4 2330-2332, 6.5 2390-2395).
		expect(ledger.ends.filter(({ runId }) => runId === killed?.id)).toEqual([
			expect.objectContaining({
				runId: killed?.id,
				reason: "process_lost",
				sequence: lost[0]?.sequence,
			}),
		]);
		// F265: no blind resend; the follow-up goes once to a new runner after the loss.
		const next = ledger.runs.at(-1);
		const handed = ledger.events.filter(
			({ type, runId }) => type === "run.dispatched" && runId === next?.id,
		);
		expect(handed).toHaveLength(1);
		expect(handed[0]?.runnerId).not.toBe(lost[0]?.runnerId);
		expect(handed[0]?.sequence).toBeGreaterThan(lost[0]?.sequence ?? 0);
		expect(captured("send.options")).toHaveLength(2);
		prove("killed", ledger, { lost, handed });
	});

	// Failure modes (32.8, lane audit F373-F378): F373 the Run stays running when the runner never
	// answers the Stop; F374 the deadline step leaves the frozen runner alive; F375 the Run ends
	// twice; F376 something before the deadline ends it, so the step never does; F377 the next send
	// waits on the dead stop or goes to the frozen runner; F378 the next send is delivered twice or
	// the stopped input is re-sent. The SDK-never-settles case ends at the runner's own abandonment
	// (above); here the runner itself is frozen, so only the stop's deadline step can end the Run.
	// test-waits-allow timeout-override: the Stop's 30 s deadline runs on the daemon's wall clock.
	it("ends a Stopped Run its frozen runner never answers at the stop's deadline step, and runs the next send once on a new runner", async () => {
		const gate = join(mkdtempSync(join(tmpdir(), "cursor-gate-")), "gate");
		writeFileSync(gate, "hold");
		const { fixture, browser, sessionId } = await start(
			"stop-frozen",
			"basic",
			{
				CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
			},
		);
		await submit(browser, sessionId, "Replay the captured basic turn.");
		await thinking(fixture, sessionId);
		const frozen = runnerPid(fixture, sessionId);
		expect(fixture.signalOwnedRunner(frozen, "SIGSTOP")).toBe(true);
		const stoppedAt = Date.now();
		await stop(browser, sessionId);
		// test-waits-allow polling: the deadline step's retirement reaches only the store and the process table.
		await vi.waitFor(
			() => {
				expect(read(fixture, sessionId).turns).not.toContain("running");
				expect(fixture.remainingRunnerPids()).toEqual([]);
			},
			{ timeout: 60_000, interval: 200 },
		);
		const endedAfter = Date.now() - stoppedAt;
		// F376: the commit lands after stoppedAt, so its deadline is at least 30 s later.
		expect(endedAfter).toBeGreaterThanOrEqual(30_000);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT effect_type AS effect FROM provider_command_outbox WHERE session_id = ? AND command_id LIKE '%:retire'",
					)
					.all(sessionId),
			).toEqual([{ effect: "end_session" }]);
		} finally {
			db.close();
		}
		rmSync(gate);
		await submit(browser, sessionId, "Replay the captured basic turn again.");
		// test-waits-allow polling: the next Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).turns.at(-1)).toBe("completed"),
			{ timeout: TIMEOUT },
		);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const [stopped, next] = ledger.runs;
		expect(ledger.runs.map((run) => run.status)).toEqual([
			"interrupted",
			"completed",
		]);
		const lost = ledger.events.filter(
			({ type }) => type === "evidence.process_lost",
		);
		const handed = ledger.events.filter(
			({ type, runId }) => type === "run.dispatched" && runId === next?.id,
		);
		expect(lost).toHaveLength(1);
		expect(handed).toHaveLength(1);
		expect(handed[0]?.runnerId).not.toBe(lost[0]?.runnerId);
		expect(handed[0]?.sequence).toBeGreaterThan(lost[0]?.sequence ?? 0);
		expect(captured("send.options")).toHaveLength(2);
		prove("stop-frozen", ledger, {
			endedAfter,
			stopped: ledger.ends.find(({ runId }) => runId === stopped?.id),
			lost,
			handed,
		});
	}, 120_000);

	// Failure modes (32.8): F379 Run now steers or sends without cancelling; F380 the active
	// Run ends twice or not interrupted; F381 the queued input launches twice or never; F382 it
	// launches before the active Run ends; F383 Run now retires the runner; F384 the queued
	// input stays in the tray.
	it("ends the active Run interrupted on Run now and launches the queued input once, on the same runner", async () => {
		// cancel.jsonl's captured follow-up is the send after its cancelled turn.
		const { fixture, browser, sessionId } = await start("run-now", "cancel");
		await submit(
			browser,
			sessionId,
			"Call the human custom tool once, then say done.",
		);
		await thinking(fixture, sessionId);
		const queued = randomUUID();
		await submit(browser, sessionId, "Say cancel followup.", "queue", queued);
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
		expect(captured("send.options")).toHaveLength(1);
		await browser.sendNow(sessionId, queued, true);
		await turns(fixture, sessionId, ["interrupted", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		oneRunnerStartedFirst(ledger);
		expect(ledger.runs.map((run) => run.status)).toEqual([
			"interrupted",
			"completed",
		]);
		expect(
			ledger.ends.map(({ reason, forced }) => ({ reason, forced })),
		).toEqual([
			{ reason: "interrupted", forced: 0 },
			expect.objectContaining({ reason: "completed" }),
		]);
		expect(
			ledger.events
				.filter(({ type }) => type === "turn.interrupted")
				.map(({ code }) => code),
		).toEqual([null]);
		expect(captured("cancel.call")).toHaveLength(1);
		expect(captured("steer.call")).toEqual([]);
		const sends = captured("send.options");
		expect(sends).toHaveLength(2);
		expect(JSON.stringify(sends[1]?.data)).toContain("Say cancel followup.");
		// The queued input was sent only after the cancelled wait settled.
		const capture = traceRows(capturePath);
		const cancelled = capture.findIndex(
			(row) =>
				row.kind === "wait.result" &&
				(row.data as { status?: string } | undefined)?.status === "cancelled",
		);
		expect(cancelled).toBeGreaterThan(-1);
		expect(cancelled).toBeLessThan(
			capture.map(({ kind }) => kind).lastIndexOf("send.options"),
		);
		expect(tray()).toEqual([{ state: "removed" }]);
		prove("run-now", ledger);
	});

	it("lands old's process_lost and R's process_started together when a new build swaps the runner", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"swap",
			"basic",
			{},
			"82tn-32-10-before",
		);
		await submit(browser, sessionId, "Replay the captured basic turn.");
		await turns(fixture, sessionId, ["completed"]);
		const [old] = read(fixture, sessionId).runners;
		if (!old) throw new Error("no runner row");
		const oldPid = runnerPid(fixture, sessionId);
		await fixture.kill();
		await restart("82tn-32-10-after");
		// The idle old runner swaps on the new build's restart, before any send.
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "runner-upgrade" &&
				mark.phase === "switched" &&
				mark.oldPid === oldPid,
		);
		await submit(
			await fixture.connect(sessionId),
			sessionId,
			"Replay the captured basic turn again.",
		);
		await turns(fixture, sessionId, ["completed", "completed"]);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const replacement = ledger.runners.find(
			(runner) => runner.runnerId !== old.runnerId && runner.retiredAt === null,
		);
		if (!replacement) throw new Error("no serving replacement");
		// F266: the restart reattaches old, then the swap commit retires it and starts R.
		expect(processEvidence(ledger)).toEqual([
			{
				type: "evidence.process_started",
				runnerId: old.runnerId,
				label: `${old.runnerId}:0`,
				reattached: 0,
			},
			{
				type: "evidence.process_started",
				runnerId: old.runnerId,
				label: `${old.runnerId}:0`,
				reattached: 1,
			},
			{
				type: "evidence.process_lost",
				runnerId: old.runnerId,
				label: null,
				reattached: null,
			},
			{
				type: "evidence.process_started",
				runnerId: replacement.runnerId,
				label: `${replacement.runnerId}:0`,
				reattached: 0,
			},
		]);
		// One write: R's start directly follows old's loss in the session's stream (6.9).
		const lost = ledger.events.findIndex(
			({ type }) => type === "evidence.process_lost",
		);
		expect(ledger.events[lost + 1]).toMatchObject({
			type: "evidence.process_started",
			runnerId: replacement.runnerId,
		});
		// F267: the send after the swap ran on R.
		const next = ledger.runs.at(-1);
		expect(
			ledger.events
				.filter(
					({ type, runId }) => type === "run.dispatched" && runId === next?.id,
				)
				.map(({ runnerId }) => runnerId),
		).toEqual([replacement.runnerId]);
		prove("swap", ledger, {
			old: old.runnerId,
			replacement: replacement.runnerId,
		});
	});

	const shellStandIn = async (marker: string) => {
		// test-waits-allow polling: the stand-in reports its pid only through this file.
		const pid = await vi.waitFor(
			() => {
				const text = existsSync(`${marker}.pid`)
					? readFileSync(`${marker}.pid`, "utf8").trim()
					: "";
				expect(text).toMatch(/^\d+$/);
				return Number(text);
			},
			{ timeout: TIMEOUT, interval: 50 },
		);
		standIns.push(pid);
		const [parent, group] = execFileSync(
			"ps",
			["-o", "ppid=,pgid=", "-p", String(pid)],
			{
				encoding: "utf8",
			},
		)
			.trim()
			.split(/\s+/)
			.map(Number);
		// F241: the stand-in leads its own group, outside its runner's.
		expect(group).toBe(pid);
		return { pid, runnerPid: parent ?? 0, startedAt: Date.now() };
	};
	/** Waits past the stand-in's marker time, then proves it never wrote the marker (F252). */
	const shellNeverFinished = async (
		name: string,
		marker: string,
		standIn: { pid: number; startedAt: number },
		extra = {},
	) => {
		await new Promise((done) =>
			// test-waits-allow real-wait: the claim is that nothing happens by the marker time; only that time proves it.
			setTimeout(
				done,
				standIn.startedAt + SHELL_DELAY_S * 1000 + 1500 - Date.now(),
			),
		);
		const proof = {
			case: name,
			shellPid: standIn.pid,
			shellAlive: shellAlive(standIn.pid),
			markerWritten: existsSync(marker),
			...extra,
		};
		shellProofs.push(proof);
		expect(proof).toMatchObject({ shellAlive: false, markerWritten: false });
	};
	const shellEnvironment = (marker: string) => ({
		CONDUIT_TEST_CURSOR_SHELL_MARKER: marker,
		CONDUIT_TEST_CURSOR_SHELL_DELAY_S: String(SHELL_DELAY_S),
	});
	const markerPath = () =>
		join(mkdtempSync(join(tmpdir(), "cursor-shell-")), "marker");

	// test-waits-allow timeout-override: the abandonment's 10 s interrupt timeout plus the stand-in's 18 s delay.
	it(
		"ends an abandoned run's shell command when its runner retires",
		async () => {
			const marker = markerPath();
			const { fixture, browser, sessionId } = await start(
				"abandoned-shell",
				"cancel",
				{
					CONDUIT_TEST_CURSOR_CANCEL_NEVER_SETTLES: "1",
					...shellEnvironment(marker),
				},
			);
			await submit(
				browser,
				sessionId,
				"Call the human custom tool once, then say done.",
			);
			const standIn = await shellStandIn(marker);
			await thinking(fixture, sessionId);
			await stop(browser, sessionId);
			await turns(fixture, sessionId, ["interrupted"]);
			// F240: the abandoning runner exits on its own; retirement records its loss.
			// test-waits-allow polling: the runner's loss reaches the browser as no frame.
			await vi.waitFor(
				() =>
					expect(
						read(fixture, sessionId).events.filter(
							({ type }) => type === "evidence.process_lost",
						),
					).toHaveLength(1),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await shellNeverFinished("abandoned", marker, standIn, {
				runnerPid: standIn.runnerPid,
				retiredAt: Date.now() - standIn.startedAt,
			});
		},
		SHELL_TEST_TIMEOUT,
	);

	// test-waits-allow timeout-override: the stand-in's 18 s delay runs on the wall clock.
	it(
		"ends a shell command when its runner is killed outright",
		async () => {
			const marker = markerPath();
			const { fixture, browser, sessionId } = await start(
				"killed-shell",
				"basic",
				shellEnvironment(marker),
			);
			await submit(browser, sessionId, "Replay the captured basic turn.");
			const standIn = await shellStandIn(marker);
			// F240: SIGKILL gives the runner no chance to act; only what outlives it can.
			expect(fixture.signalOwnedRunner(standIn.runnerPid, "SIGKILL")).toBe(
				true,
			);
			await shellNeverFinished("killed", marker, standIn, {
				runnerPid: standIn.runnerPid,
			});
		},
		SHELL_TEST_TIMEOUT,
	);
	// The crash matrix's Cursor cells (82tn.32.14; CONTRACT.md 4.9, 11.3). How they could fail:
	// M1 a Run ends twice, or never; M2 an effect is left running or held with no owner (S9.6);
	// M3 an input or an answer lands twice, or a requeued input twice; M4 a turn or the session stays
	// busy, or a steer stays steering; M5 a send, steer or answer reaches the SDK again after the
	// kill; M6 the next send after a runner's death never runs, or runs on the dead runner.
	const cellRuns = (fixture: ProcessHarness, sessionId: string) => {
		const ledger = read(fixture, sessionId);
		return ledger.runs.map((run) => ({
			status: run.status,
			ends: ledger.ends
				.filter((end) => end.runId === run.id)
				.map((end) => end.outcome),
		}));
	};
	const held = () => {
		const gate = join(mkdtempSync(join(tmpdir(), "cursor-gate-")), "gate");
		writeFileSync(gate, "hold");
		return gate;
	};
	const answerQuestion = async (browser: ProcessBrowser, sessionId: string) => {
		const cursor = browser.frames.length;
		await submit(
			browser,
			sessionId,
			"Ask me which deployment to use with ask_user.",
		);
		const question = await browser.waitFor(
			(message) =>
				message["type"] === "question_pending" &&
				message["sessionId"] === sessionId,
			cursor,
			TIMEOUT,
		);
		expect(
			await Effect.runPromise(
				browser.rpc.AnswerQuestion({
					projectSlug: "process-test",
					originId: browser.originId,
					commandId: randomUUID(),
					toolId: String(question["toolId"]),
					answers: { "0": "Blue" },
				}),
			),
		).toEqual({ ok: true });
		// test-waits-allow polling: the SDK's take of the answer reaches only its capture file.
		await vi.waitFor(() => expect(captured("custom.result")).toHaveLength(1), {
			timeout: TIMEOUT,
		});
	};
	// The runner holds each turn's terminal this long after its stream, so a kill lands inside it.
	const WAIT_HELD = { CONDUIT_TEST_CURSOR_WAIT_DELAY_MS: "4000" };
	// The SDK settles a Stop's cancel this long after it, so a kill lands with the Stop in flight.
	const CANCEL_HELD = { CONDUIT_TEST_CURSOR_CANCEL_TERMINAL_DELAY_MS: "4000" };
	const CANCEL_PROMPT = "Call the human custom tool once, then say done.";

	// test-waits-allow timeout-override: a daemon restart and the held terminal each take seconds.
	it("settles a send its runner finished while the daemon was down once, from the runner's journal (finished)", async () => {
		const gate = held();
		const { fixture, browser, sessionId, restart } = await start(
			"matrix-finished",
			"basic",
			{ CONDUIT_TEST_CURSOR_STREAM_GATE: gate },
		);
		await submit(browser, sessionId, "Replay the captured basic turn.");
		await thinking(fixture, sessionId);
		await fixture.kill();
		rmSync(gate);
		// test-waits-allow polling: the runner's finish reaches only its capture file while the daemon is down.
		await vi.waitFor(() => expect(captured("stream.end")).toHaveLength(1), {
			timeout: TIMEOUT,
		});
		await restart();
		await turns(fixture, sessionId, ["completed"]);
		expect(cellRuns(fixture, sessionId)).toEqual([
			{ status: "completed", ends: ["completed"] },
		]);
		expect(captured("send.options")).toHaveLength(1);
		proveCrashMatrixCell(
			"cursor/journal/finished",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: a new runner's start and the next send each take seconds.
	it("never re-sends a send its runner held before streaming when the runner died (uncertain)", async () => {
		const gate = held();
		const { fixture, browser, sessionId } = await start(
			"matrix-uncertain",
			"basic",
			{ CONDUIT_TEST_CURSOR_SEND_GATE: gate },
		);
		await submit(browser, sessionId, "Replay the captured basic turn.");
		// test-waits-allow polling: the SDK's take of the send reaches only its capture file.
		await vi.waitFor(() => expect(captured("send.options")).toHaveLength(1), {
			timeout: TIMEOUT,
		});
		expect(
			fixture.signalOwnedRunner(runnerPid(fixture, sessionId), "SIGKILL"),
		).toBe(true);
		await turns(fixture, sessionId, ["error"]);
		rmSync(gate);
		await submit(browser, sessionId, "Replay the captured basic turn again.");
		await turns(fixture, sessionId, ["error", "completed"]);
		expect(cellRuns(fixture, sessionId)).toEqual([
			{ status: "error", ends: ["error"] },
			{ status: "completed", ends: ["completed"] },
		]);
		expect(captured("send.options")).toHaveLength(2);
		proveCrashMatrixCell(
			"cursor/journal/uncertain",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// Two-build upgrade (82tn.32.14, 32.47; CONTRACT.md 7.4): the ledger build's daemon holds a
	// Cursor turn, is SIGKILLed, and the current build restarts on its store and adopts its runner.
	// test-waits-allow timeout-override: a cold cache builds the ledger build's tree before the test runs.
	it("finishes a Cursor turn the ledger build's runner held through an upgrade once, never re-sent", async (context) => {
		const historical = await historicalRunnerBundle(
			"4b2fe6eee9b9d44974e82471857196c8afeee830",
		);
		if (!historical.available) context.skip(historical.reason);
		if (!historical.available) return;
		const gate = held();
		const { fixture, browser, sessionId, restart } = await start(
			"two-build",
			"basic",
			{ CONDUIT_TEST_CURSOR_STREAM_GATE: gate },
			undefined,
			historical.dist,
		);
		await submit(browser, sessionId, "Replay the captured basic turn.");
		// test-waits-allow polling: the SDK's take of the send reaches only its capture file.
		await vi.waitFor(() => expect(captured("send.options")).toHaveLength(1), {
			timeout: TIMEOUT,
		});
		await fixture.kill();
		await restart(undefined, process.env["CONDUIT_TEST_DIST"] ?? "dist");
		await fixture.connect(sessionId);
		rmSync(gate);
		await turns(fixture, sessionId, ["completed"]);
		expect(cellRuns(fixture, sessionId)).toEqual([
			{ status: "completed", ends: ["completed"] },
		]);
		expect(captured("send.options")).toHaveLength(1);
		proveCrashMatrixCell(
			"two-build/cursor",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 300_000);

	// test-waits-allow timeout-override: a daemon restart and the steered turn each take seconds.
	it("delivers a steer once when the daemon dies with the steer handed to the SDK, unacknowledged", async () => {
		const gate = held();
		const { fixture, browser, sessionId, restart } = await start(
			"matrix-steer-daemon",
			"steer",
			{ CONDUIT_TEST_CURSOR_STREAM_GATE: gate },
		);
		await submit(browser, sessionId, "Replay the captured running turn.");
		await thinking(fixture, sessionId);
		await submit(browser, sessionId, STEER, "steer", "matrix-steer");
		// test-waits-allow polling: the SDK's take of the steer reaches only its capture file.
		await vi.waitFor(() => expect(captured("steer.call")).toHaveLength(1), {
			timeout: TIMEOUT,
		});
		await fixture.kill();
		rmSync(gate);
		await restart();
		await turns(fixture, sessionId, ["completed", "completed"]);
		expect(captured("steer.call")).toHaveLength(1);
		expect(captured("send.options")).toHaveLength(1);
		proveCrashMatrixCell(
			"cursor/steer/daemon",
			fixture.daemonStorePath(),
			sessionId,
			["matrix-steer"],
		);
	}, 120_000);

	// test-waits-allow timeout-override: a daemon restart and the held cancel each take seconds.
	it("ends a Stop's Run interrupted once when the daemon dies with the cancel unsettled", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"matrix-stop-daemon",
			"cancel",
			CANCEL_HELD,
		);
		await submit(browser, sessionId, CANCEL_PROMPT);
		await thinking(fixture, sessionId);
		await stop(browser, sessionId);
		await fixture.kill();
		await restart();
		await turns(fixture, sessionId, ["interrupted"]);
		expect(cellRuns(fixture, sessionId)).toEqual([
			{ status: "interrupted", ends: ["interrupted"] },
		]);
		proveCrashMatrixCell(
			"cursor/stop/daemon",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: a new runner's start and the next send each take seconds.
	it("ends a Stop's Run interrupted once when its runner dies with the cancel unsettled, and runs the next send once", async () => {
		const { fixture, browser, sessionId } = await start(
			"matrix-stop-runner",
			"cancel",
			CANCEL_HELD,
		);
		await submit(browser, sessionId, CANCEL_PROMPT);
		await thinking(fixture, sessionId);
		await stop(browser, sessionId);
		expect(
			fixture.signalOwnedRunner(runnerPid(fixture, sessionId), "SIGKILL"),
		).toBe(true);
		// test-waits-allow polling: the killed Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).turns).not.toContain("running"),
			{ timeout: TIMEOUT },
		);
		await submit(browser, sessionId, "Say cancel followup.");
		// test-waits-allow polling: the next Run's end reaches only the store's ledger.
		await vi.waitFor(
			() => expect(read(fixture, sessionId).turns.at(-1)).toBe("completed"),
			{ timeout: TIMEOUT },
		);
		// A Stop asked ends its Run interrupted before its lost runner's error (CONTRACT 857-859).
		expect(cellRuns(fixture, sessionId).map(({ ends }) => ends)).toEqual([
			["interrupted"],
			["completed"],
		]);
		expect(captured("send.options")).toHaveLength(2);
		proveCrashMatrixCell(
			"cursor/stop/runner",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: a daemon restart and the held terminal each take seconds.
	it("ends an answered question's Run once when the daemon dies after the SDK took the answer", async () => {
		const { fixture, browser, sessionId, restart } = await start(
			"matrix-answer-daemon",
			"question-basic",
			WAIT_HELD,
		);
		await answerQuestion(browser, sessionId);
		await fixture.kill();
		await restart();
		await turns(fixture, sessionId, ["completed"]);
		expect(cellRuns(fixture, sessionId)).toEqual([
			{ status: "completed", ends: ["completed"] },
		]);
		expect(captured("custom.result")).toHaveLength(1);
		proveCrashMatrixCell(
			"cursor/answer/daemon",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);

	// test-waits-allow timeout-override: the held terminal and the loss each take seconds.
	it("ends an answered question's Run once when its runner dies after the SDK took the answer, never answering again", async () => {
		const { fixture, browser, sessionId } = await start(
			"matrix-answer-runner",
			"question-basic",
			WAIT_HELD,
		);
		await answerQuestion(browser, sessionId);
		expect(
			fixture.signalOwnedRunner(runnerPid(fixture, sessionId), "SIGKILL"),
		).toBe(true);
		await turns(fixture, sessionId, ["error"]);
		expect(cellRuns(fixture, sessionId)).toEqual([
			{ status: "error", ends: ["error"] },
		]);
		expect(captured("custom.result")).toHaveLength(1);
		expect(captured("send.options")).toHaveLength(1);
		proveCrashMatrixCell(
			"cursor/answer/runner",
			fixture.daemonStorePath(),
			sessionId,
		);
	}, 120_000);
});
