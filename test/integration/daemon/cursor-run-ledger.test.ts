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
//      abandoned runner's process_lost (open: holding it needs a decider change, see 82tn.32.10);
// 150. the fence never lets go: the next start waits forever after the runner retires;
// 151. the mark leaks into a native-cancel Stop;
// 152. the held next start is handed to the retiring runner, or delivered twice (open, as 149).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	afterEach(async () => {
		const fixture = harness;
		harness = undefined;
		await fixture?.dispose();
		expect(fixture?.remainingRunnerPids() ?? []).toEqual([]);
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-10-cursor-ledger.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.10", proofs }, null, 2)}\n`,
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
		// F150: the next start runs, and its Run ends once (endsOnce above).
		expect(ledger.ends[1]).toMatchObject({
			runId: next?.id,
			reason: "completed",
		});
		expect(captured("send.options")).toHaveLength(2);
		prove("abandoned", ledger, {
			dispatched: ledger.events.filter(({ type }) => type === "run.dispatched"),
		});
	});
});
