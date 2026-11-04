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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

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
					"SELECT sequence, type, coalesce(json_extract(data, '$.runId'), json_extract(metadata, '$.runId')) AS runId, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.code') AS code FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				runId: string | null;
				runnerId: string | null;
				code: string | null;
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

describe("Cursor on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	let capturePath = "";
	const proofs: Record<string, unknown>[] = [];
	const shellProofs: Record<string, unknown>[] = [];
	const standIns: number[] = [];
	afterEach(async () => {
		const fixture = harness;
		harness = undefined;
		await fixture?.dispose();
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
	) => {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
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
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				CONDUIT_TEST_CURSOR_DELTA_DELAY_MS: "2",
				...environment,
			},
		});
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor ledger replay",
			driver: "cursor",
		});
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			name,
			added.addedInstanceId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "", permissionMode: "ask" },
		);
		return { fixture, browser, sessionId };
	};
	const submit = (
		browser: ProcessBrowser,
		sessionId: string,
		text: string,
		delivery: "queue" | "steer" = "queue",
	) =>
		Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
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

	it("ends a delivered steer's Run once, in the one native send", async () => {
		const { fixture, browser, sessionId } = await start("steer", "steer");
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
		prove("steer", ledger);
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
});
