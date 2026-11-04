// Codex background terminals as background tasks (82tn.32.28; CONTRACT.md 8.2 2791-2793, 8.3
// 2812-2817, 8.4 2860-2867), over the isolated process harness and a recorded Codex trace whose
// command keeps running past its turn. List and terminate payloads copy codex-cli 0.162.1's
// replies to a real app-server probe (lane 3228 audit P1-P7). How it could fail (audit):
// 1. no snapshot is ever sent, so the session reads "checking" and Stop tasks is refused;
// 2. no re-read at turn completion, so a terminal left running is never listed;
// 3. no re-read at a terminal command's start or finish;
// 4. no re-read after a stop, so a terminated terminal stays listed;
// 6. a late command event after the turn ended reopens a Run, ends one, or shows an error;
// 7. a terminal is dropped at its finish event, not when a later list omits it;
// 8. Stop tasks for Codex takes a second path;
// 9. a failed terminate is retried, drops the terminal, or shows nothing;
// 10. terminated: false is read as success;
// 11. a failed list clears the set or fails the turn;
// 14. a late event for a process never listed crashes, errors, or adds a task;
// 18. a snapshot sent while idle is dropped;
// 19. terminate is sent the item id, not the process id;
// 22. traces without list rows break once the runner lists;
// 23. Stop is hidden for Codex, or the driver drops the stop as a no-op success.
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
const LIST = "thread/backgroundTerminals/list";
const TERMINATE = "thread/backgroundTerminals/terminate";
const PROCESS = "26952";
const terminal = {
	itemId: "call_fixture",
	processId: PROCESS,
	command: "sleep 300",
	cwd: "/workspace",
	osPid: null,
	cpuPercent: null,
	rssKb: null,
};

/**
 * A list marker: from here on the trace player answers every list call for `cursor` with `data`
 * (see trace-player.ts), or with Codex's error for a cursor it cannot read (lane 3245 Q2). It
 * sits before the frame that prompts the re-read.
 */
const listed = (
	at: number,
	id: number,
	threadId: string,
	data: unknown[] | "error",
	page: { readonly cursor?: string; readonly nextCursor?: string } = {},
) => [
	{
		dir: "out",
		at,
		message: {
			jsonrpc: "2.0",
			id,
			method: LIST,
			params: { threadId, ...(page.cursor ? { cursor: page.cursor } : {}) },
		},
	},
	{
		dir: "in",
		at,
		message:
			data === "error"
				? {
						id,
						error: {
							code: -32600,
							message: "invalid cursor: invalid digit found in string",
						},
					}
				: { id, result: { data, nextCursor: page.nextCursor ?? null } },
	},
];

/** The recorded command's turn: what follows the turn names it, as a late Codex event does. */
type Turn = {
	readonly threadId: string;
	readonly turnId: string;
	readonly item: Record<string, unknown>;
	readonly at: number;
};

/** A terminate request for the listed terminal and Codex's answer (probe P4, P5). */
const terminate = (at: number, threadId: string, terminated: boolean) => [
	{
		dir: "out",
		at,
		message: {
			jsonrpc: "2.0",
			id: 902,
			method: TERMINATE,
			params: { threadId, processId: PROCESS },
		},
	},
	{ dir: "in", at, message: { id: 902, result: { terminated } } },
];

/**
 * The command's finish after its turn ended (probe P4: failed, the old turnId). A terminated
 * `/bin/zsh -c` command reports exit 137, as the live E2E saw; a bare process reports -1
 * (lane 3245 Q3). The runner reads neither: a finish only prompts a re-read.
 */
const late = (
	at: number,
	{ threadId, turnId, item }: Turn,
	status: string,
	exitCode: number,
) => ({
	dir: "in",
	at,
	message: {
		method: "item/completed",
		params: {
			item: { ...item, status, exitCode, aggregatedOutput: "", durationMs: 1 },
			threadId,
			turnId,
			completedAtMs: at,
		},
	},
});

/**
 * turn-command with its command left running past the turn, as Codex reports one (probe P2): its
 * item starts with a process id and never completes inside the turn. No exit row: the app-server
 * stays up after the turn. `after` follows the turn's completion.
 */
const terminalTrace = (after: (turn: Turn) => TraceRow[] = () => []) => {
	const trace = fixtureRows("turn-command").filter(
		(row) =>
			row.dir !== "exit" &&
			row.message?.params?.["itemId"] !== "call_fixture" &&
			!(
				row.message?.method === "item/completed" &&
				(row.message.params?.["item"] as { id?: string } | undefined)?.id ===
					"call_fixture"
			),
	);
	const index = trace.findIndex(
		(row) =>
			row.message?.method === "item/started" &&
			(row.message.params?.["item"] as { id?: string } | undefined)?.id ===
				"call_fixture",
	);
	const started = trace[index];
	const params = started?.message?.params;
	const threadId = params?.["threadId"];
	const turnId = params?.["turnId"];
	if (
		!started ||
		!params ||
		typeof threadId !== "string" ||
		typeof turnId !== "string"
	)
		throw new Error("Missing the recorded command");
	const item = {
		...(params["item"] as Record<string, unknown>),
		command: "/bin/zsh -c 'sleep 300'",
		processId: PROCESS,
		source: "unifiedExecStartup",
		commandActions: [{ type: "unknown", command: "sleep 300" }],
	};
	started.message = { ...started.message, params: { ...params, item } };
	trace.splice(
		index,
		0,
		...listed(Number(started["at"]), 901, threadId, [terminal]),
	);
	const at = Number(trace.at(-1)?.["at"]) + 1;
	return [...trace, ...after({ threadId, turnId, item, at })];
};

/** The app-server exits once its turn is done (a crash or a closed connection between turns). */
const exit = (at: number) => ({ dir: "exit", at, code: 0, signal: null });

/**
 * A later app-server for the same thread, as a reconnect opens one: it resumes the thread and
 * lists `data` as it answers the resume. `held` is that answer's time; a gate there holds the turn.
 */
const resumedTrace = (data: unknown[]) => {
	const trace = fixtureRows("turn-command").filter((row) => row.dir !== "exit");
	const index = trace.findIndex(
		(row) => row.message?.method === "thread/start",
	);
	const request = trace[index];
	const reply = trace[index + 1];
	const threadId = (reply?.message?.result?.["thread"] as { id?: string })?.id;
	if (!request?.message || !reply || typeof threadId !== "string")
		throw new Error("Missing the recorded thread");
	request.message = { ...request.message, method: "thread/resume" };
	const held = Number(reply["at"]);
	trace.splice(index + 2, 0, ...listed(held, 904, threadId, data));
	return { trace, held };
};

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			snapshots: (
				db
					.prepare(
						"SELECT json_extract(data, '$.tasks') AS tasks FROM events WHERE session_id = ? AND type = 'evidence.tasks_snapshot' ORDER BY sequence",
					)
					.all(sessionId) as { tasks: string }[]
			).map(({ tasks }) => JSON.parse(tasks) as unknown[]),
			errors: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('turn.error', 'session.error') ORDER BY sequence",
				)
				.all(sessionId),
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.outcome') AS outcome FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as { runId: string; outcome: string }[],
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			outbox: db
				.prepare(
					"SELECT status, json_extract(payload_json, '$.effect.key.taskId') AS taskId FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'stop_task' ORDER BY request_sequence",
				)
				.all(sessionId) as { status: string; taskId: string }[],
			// The recorded command's tool row (82tn.45).
			command: db
				.prepare(
					"SELECT p.status, p.run_id AS runId, p.ended_by AS endedBy, json_extract(p.metadata, '$.providerTaskId') AS taskId FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND p.call_id = 'call_fixture'",
				)
				.get(sessionId),
		};
	} finally {
		db.close();
	}
};

describe("Codex background terminals", () => {
	let harness: ProcessHarness | undefined;
	let reportPath = "";
	let capturePath = "";
	let gatePath = "";
	let tracePath = "";
	const proofs: Record<string, unknown>[] = [];
	const followUps: Record<string, unknown>[] = [];
	const toolRows: Record<string, unknown>[] = [];

	const writeTrace = (trace: TraceRow[]) =>
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	const captured = (method: string) =>
		rows<TraceRow>(capturePath).filter(
			(row) => row.message?.method === method && row.dir === "out",
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
			"test-results/82tn-32-28-codex-terminals.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.28", proofs }, null, 2)}\n`,
		);
		writeFileSync(
			"test-results/82tn-32-45-codex-terminals.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.45", proofs: followUps }, null, 2)}\n`,
		);
		writeFileSync(
			"test-results/82tn-45-codex-terminals.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.45", proofs: toolRows }, null, 2)}\n`,
		);
	});

	const start = async (name: string, trace: TraceRow[]) => {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		harness = fixture;
		tracePath = join(fixture.root, "codex-replay.jsonl");
		gatePath = join(fixture.root, "codex-replay-gate");
		const artifacts = resolve(
			`test-results/codex-background-terminals/${name}`,
		);
		mkdirSync(artifacts, { recursive: true });
		reportPath = join(artifacts, "trace-report.jsonl");
		capturePath = join(artifacts, "capture.jsonl");
		writeFileSync(reportPath, "");
		writeFileSync(capturePath, "");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeTrace(signedInCodexDiscoveryTrace());
		const discoveryPath = join(fixture.root, "codex-discovery.jsonl");
		const traceMap = join(fixture.root, "codex-trace-map.json");
		writeFileSync(discoveryPath, readFileSync(tracePath, "utf8"));
		writeFileSync(
			traceMap,
			JSON.stringify({ "*": { "codex-discovery": { trace: discoveryPath } } }),
		);
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
				CONDUIT_TEST_CODEX_TRACE_MAP: traceMap,
			},
		});
		const browser = await fixture.connect();
		await browser.followSessions();
		// test-waits-allow polling: the Codex account appears only through the instances list.
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
			permissionMode: "full",
		});
		writeTrace(trace);
		await browser.followSession(sessionId);
		return { fixture, browser, sessionId };
	};
	const submit = async (browser: ProcessBrowser, sessionId: string) => {
		const result = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "Say hello",
			}),
		);
		expect(result.ok).toBe(true);
	};
	// The sidebar's row carries the ledger's tasks (claude-stop-tasks.test.ts).
	const rowTasks = (
		browser: ProcessBrowser,
		sessionId: string,
		predicate: (tasks: unknown) => boolean,
		cursor = 0,
	) =>
		browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				"workspaceHint" in message &&
				predicate(message["backgroundTasks"]),
			cursor,
		);
	const runEnded = (fixture: ProcessHarness, sessionId: string) =>
		// test-waits-allow polling: the Run's end reaches only the store's ledger.
		vi.waitFor(
			() => {
				const ledger = read(fixture, sessionId);
				expect(ledger.runs).toHaveLength(1);
				expect(ledger.ends.map(({ outcome }) => outcome)).toEqual([
					ledger.runs[0]?.status,
				]);
				return ledger;
			},
			{ timeout: TIMEOUT, interval: 100 },
		);

	it("lists a terminal left running after its turn, and keeps it listed", async () => {
		const { fixture, browser, sessionId } = await start(
			"listed",
			terminalTrace(),
		);
		await submit(browser, sessionId);
		const row = await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		const ledger = await runEnded(fixture, sessionId);
		expect(row["backgroundTasks"]).toEqual([
			expect.objectContaining({
				id: PROCESS,
				type: "local_bash",
				kind: "shell",
				description: "sleep 300",
			}),
		]);
		expect(ledger.snapshots.at(-1)).toEqual([
			expect.objectContaining({ key: { taskId: PROCESS } }),
		]);
		expect(ledger.errors).toEqual([]);
		// Re-read at the command's start and at turn completion (8.2).
		expect(captured(LIST).length).toBeGreaterThanOrEqual(2);
		proofs.push({
			case: "listed",
			row: row["backgroundTasks"],
			snapshots: ledger.snapshots,
			ends: ledger.ends,
			listCalls: captured(LIST).length,
		});
	});

	it("stops a listed terminal through Stop tasks, and drops it when the next list omits it", async () => {
		const { fixture, browser, sessionId } = await start(
			"stopped",
			terminalTrace((turn) => [
				...terminate(turn.at, turn.threadId, true),
				...listed(turn.at + 1, 903, turn.threadId, []),
				late(turn.at + 2, turn, "failed", 137),
			]),
		);
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		await runEnded(fixture, sessionId);
		const lists = captured(LIST).length;
		const cursor = browser.frames.length;
		// Also fails if the Codex runner launch stops declaring it can stop tasks: the dispatcher
		// then refuses every stop (lane 3245 audit 13, proved by removing the declaration).
		expect(
			await Effect.runPromise(
				browser.rpc.StopTasks({ sessionId, tasks: [PROCESS] }),
			),
		).toEqual({ ok: true });
		const row = await rowTasks(
			browser,
			sessionId,
			(tasks) => tasks === undefined,
			cursor,
		);
		// Re-read after the stop and at the late finish; the finish only updates the set (8.2).
		// test-waits-allow polling: the runner's list calls reach only the app-server capture.
		await vi.waitFor(() =>
			expect(captured(LIST).length).toBeGreaterThanOrEqual(lists + 2),
		);
		const ledger = await runEnded(fixture, sessionId);
		expect(captured(TERMINATE).map((row) => row.message?.params)).toEqual([
			{ threadId: expect.any(String), processId: PROCESS },
		]);
		expect(ledger.outbox).toEqual([{ status: "completed", taskId: PROCESS }]);
		expect(ledger.snapshots.at(-1)).toEqual([]);
		expect(ledger.errors).toEqual([]);
		proofs.push({
			case: "stopped",
			row: row["backgroundTasks"] ?? null,
			terminate: captured(TERMINATE).map((row) => row.message?.params),
			outbox: ledger.outbox,
			snapshots: ledger.snapshots,
			ends: ledger.ends,
			listCalls: captured(LIST).length,
		});
	});

	it("keeps a terminal Codex did not stop, shows why, and never retries", async () => {
		const { fixture, browser, sessionId } = await start(
			"refused",
			terminalTrace((turn) => terminate(turn.at, turn.threadId, false)),
		);
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		await runEnded(fixture, sessionId);
		const failure = await Effect.runPromise(
			Effect.flip(browser.rpc.StopTasks({ sessionId, tasks: [PROCESS] })),
		);
		expect(failure.message).toMatch(/could not stop/i);
		// No retry on its own: one terminate, still one after the reactor has had time to act.
		// test-waits-allow real-wait: no retry is an absence, which only elapsed time can show.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const ledger = read(fixture, sessionId);
		expect(captured(TERMINATE)).toHaveLength(1);
		expect(ledger.outbox).toEqual([{ status: "failed", taskId: PROCESS }]);
		expect(ledger.snapshots.at(-1)).toEqual([
			expect.objectContaining({ key: { taskId: PROCESS } }),
		]);
		expect(ledger.errors).toEqual([]);
		proofs.push({
			case: "refused",
			message: failure.message,
			terminate: captured(TERMINATE).map((row) => row.message?.params),
			outbox: ledger.outbox,
			snapshots: ledger.snapshots,
		});
	});

	it("lets late command events after the turn only update the set", async () => {
		let held = 0;
		const { fixture, browser, sessionId } = await start(
			"late",
			terminalTrace((turn) => {
				held = turn.at - 1;
				const other = { ...turn.item, id: "call_other", processId: "99999" };
				return [
					...listed(turn.at, 903, turn.threadId, []),
					late(turn.at, turn, "completed", 0),
					late(turn.at + 1, { ...turn, item: other }, "failed", 137),
				];
			}),
		);
		// The late events wait until the turn has ended (probe P6).
		writeFileSync(gatePath, String(held));
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		const ended = await runEnded(fixture, sessionId);
		const cursor = browser.frames.length;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const row = await rowTasks(
			browser,
			sessionId,
			(tasks) => tasks === undefined,
			cursor,
		);
		// test-waits-allow polling: the runner's list calls reach only the app-server capture.
		await vi.waitFor(() =>
			expect(captured(LIST).length).toBeGreaterThanOrEqual(4),
		);
		const ledger = await runEnded(fixture, sessionId);
		expect(ledger.ends).toEqual(ended.ends);
		expect(ledger.runs).toEqual(ended.runs);
		expect(ledger.snapshots.at(-1)).toEqual([]);
		expect(ledger.errors).toEqual([]);
		proofs.push({
			case: "late",
			row: row["backgroundTasks"] ?? null,
			snapshots: ledger.snapshots,
			runs: ledger.runs,
			ends: ledger.ends,
			listCalls: captured(LIST).length,
		});
	});

	it("re-reads the set when a new app-server connection opens, before the next turn runs", async () => {
		let held = 0;
		const { fixture, browser, sessionId } = await start(
			"reconnect",
			terminalTrace((turn) => {
				held = turn.at - 1;
				return [exit(turn.at)];
			}),
		);
		// The app-server exits only once its terminal is listed and its turn has ended.
		writeFileSync(gatePath, String(held));
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		await runEnded(fixture, sessionId);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		// test-waits-allow polling: the app-server's exit reaches only its capture.
		await vi.waitFor(() =>
			expect(rows<TraceRow>(capturePath).at(-1)?.dir).toBe("exit"),
		);
		// The next turn opens a new app-server, which no longer runs the terminal. Its turn is held
		// at the resume, so only the connection's own re-read can drop the terminal (8.2, 2792).
		const resumed = resumedTrace([]);
		writeTrace(resumed.trace);
		writeFileSync(gatePath, String(resumed.held));
		const cursor = browser.frames.length;
		await submit(browser, sessionId);
		const row = await rowTasks(
			browser,
			sessionId,
			(tasks) => tasks === undefined,
			cursor,
		);
		const reconnected = read(fixture, sessionId);
		expect(reconnected.ends).toHaveLength(1);
		expect(captured("thread/resume")).toHaveLength(1);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		// test-waits-allow polling: the second Run's end reaches only the store's ledger.
		const ledger = await vi.waitFor(
			() => {
				const ledger = read(fixture, sessionId);
				expect(ledger.ends.map(({ outcome }) => outcome)).toEqual([
					"completed",
					"completed",
				]);
				return ledger;
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
		expect(ledger.snapshots).toEqual([
			[expect.objectContaining({ key: { taskId: PROCESS } })],
			[],
		]);
		expect(ledger.errors).toEqual([]);
		followUps.push({
			case: "reconnect",
			rowWhileHeld: row["backgroundTasks"] ?? null,
			endsWhileHeld: reconnected.ends,
			snapshots: ledger.snapshots,
			ends: ledger.ends,
			listCallsOnNewConnection: captured(LIST).length,
		});
	});

	it("follows list pages and sends the whole set once", async () => {
		const second = {
			...terminal,
			itemId: "call_second",
			processId: "33819",
			command: "sleep 301",
		};
		const trace = terminalTrace();
		const index = trace.findIndex((row) => row.message?.method === LIST);
		const marker = trace[index];
		const threadId = marker?.message?.params?.["threadId"];
		if (!marker || typeof threadId !== "string")
			throw new Error("Missing the list marker");
		// Codex pages by process id; the next cursor is the last one listed (lane 3245 Q1).
		const at = Number(marker["at"]);
		trace.splice(
			index,
			2,
			...listed(at, 901, threadId, [terminal], { nextCursor: PROCESS }),
			...listed(at, 905, threadId, [second], { cursor: PROCESS }),
		);
		const { fixture, browser, sessionId } = await start("paged", trace);
		await submit(browser, sessionId);
		const row = await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 2,
		);
		const ledger = await runEnded(fixture, sessionId);
		expect(row["backgroundTasks"]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: PROCESS }),
				expect.objectContaining({ id: "33819" }),
			]),
		);
		// One snapshot with both pages: a page alone never replaces the set (8.3, 2816).
		expect(ledger.snapshots).toEqual([
			[
				expect.objectContaining({ key: { taskId: PROCESS } }),
				expect.objectContaining({ key: { taskId: "33819" } }),
			],
		]);
		expect(
			captured(LIST).filter(
				(row) => row.message?.params?.["cursor"] === PROCESS,
			).length,
		).toBeGreaterThanOrEqual(1);
		expect(ledger.errors).toEqual([]);
		followUps.push({
			case: "paged",
			row: row["backgroundTasks"],
			snapshots: ledger.snapshots,
			listCalls: captured(LIST).map((row) => row.message?.params ?? null),
		});
	});

	it("keeps a terminal's row open past its Run's end, linked by its process id, until its own finish (82tn.45)", async () => {
		let held = 0;
		const { fixture, browser, sessionId } = await start(
			"tool-row",
			terminalTrace((turn) => {
				held = turn.at - 1;
				return [
					...listed(turn.at, 903, turn.threadId, []),
					late(turn.at, turn, "completed", 0),
				];
			}),
		);
		writeFileSync(gatePath, String(held));
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		const ended = await runEnded(fixture, sessionId);
		// The Run has ended while Codex still lists the terminal: its row is background work.
		expect(ended.command).toEqual({
			status: "running",
			runId: ended.ends[0]?.runId,
			endedBy: null,
			taskId: PROCESS,
		});
		const cursor = browser.frames.length;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				Array.isArray(message["parts"]) &&
				message["parts"].some(
					(part: { callID?: string; state?: { status?: string } }) =>
						part.callID === "call_fixture" &&
						part.state?.status === "completed",
				),
			cursor,
		);
		const finished = read(fixture, sessionId);
		expect(finished.command).toEqual({
			status: "completed",
			runId: ended.ends[0]?.runId,
			endedBy: null,
			taskId: PROCESS,
		});
		expect(finished.ends).toEqual(ended.ends);
		expect(finished.errors).toEqual([]);
		toolRows.push({
			case: "terminal row outlives its Run",
			atRunEnd: ended.command,
			finished: finished.command,
			ends: finished.ends,
			snapshots: finished.snapshots,
		});
	});

	it("keeps the set when a list fails, shows nothing new, and recovers at the next list", async () => {
		let held = 0;
		const trace = terminalTrace((turn) => {
			held = turn.at - 1;
			return [
				...listed(held, 903, turn.threadId, "error"),
				...listed(turn.at, 904, turn.threadId, []),
				late(turn.at, turn, "completed", 0),
			];
		});
		const started = Number(
			trace.find((row) => row.message?.method === LIST)?.["at"],
		);
		const { fixture, browser, sessionId } = await start("list-fails", trace);
		// The list at turn completion fails; one at the command's start may fail too, by timing.
		const failed = () => {
			const all = rows<TraceRow>(capturePath);
			const done = all.findIndex(
				(row) => row.message?.method === "turn/completed",
			);
			return done < 0
				? []
				: all
						.slice(done)
						.filter((row) => row.dir === "in" && row.message?.error);
		};
		// The turn's first lists name the terminal; the list at turn completion then fails.
		writeFileSync(gatePath, String(started));
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		writeFileSync(gatePath, String(held));
		const ended = await runEnded(fixture, sessionId);
		// test-waits-allow polling: the failed list's reply reaches only the app-server capture.
		await vi.waitFor(() => expect(failed()).toHaveLength(1));
		// Gap (2817): no outcome is named for a failed list; the set stays as last sent.
		const kept = read(fixture, sessionId);
		expect(kept.snapshots).toEqual([
			[expect.objectContaining({ key: { taskId: PROCESS } })],
		]);
		expect(ended.ends.map(({ outcome }) => outcome)).toEqual(["completed"]);
		expect(kept.errors).toEqual([]);
		// The command's late finish prompts the next list, which drops the terminal.
		const cursor = browser.frames.length;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		await rowTasks(browser, sessionId, (tasks) => tasks === undefined, cursor);
		const ledger = await runEnded(fixture, sessionId);
		expect(ledger.ends).toEqual(ended.ends);
		expect(ledger.snapshots).toEqual([
			[expect.objectContaining({ key: { taskId: PROCESS } })],
			[],
		]);
		expect(ledger.errors).toEqual([]);
		followUps.push({
			case: "list fails",
			failedReplies: failed().map((row) => row.message?.error),
			snapshotsAfterFailure: kept.snapshots,
			snapshots: ledger.snapshots,
			ends: ledger.ends,
		});
	});

	it("fails a stop at once when the app-server has exited, keeps the terminal, and opens nothing", async () => {
		let held = 0;
		const { fixture, browser, sessionId } = await start(
			"dead-stop",
			terminalTrace((turn) => {
				held = turn.at - 1;
				return [exit(turn.at)];
			}),
		);
		writeFileSync(gatePath, String(held));
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		await runEnded(fixture, sessionId);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		// test-waits-allow polling: the app-server's exit reaches only its capture.
		await vi.waitFor(() =>
			expect(rows<TraceRow>(capturePath).at(-1)?.dir).toBe("exit"),
		);
		const asked = Date.now();
		const failure = await Effect.runPromise(
			Effect.flip(browser.rpc.StopTasks({ sessionId, tasks: [PROCESS] })),
		);
		const elapsed = Date.now() - asked;
		expect(failure.message).toMatch(/could not stop 1 background task/i);
		// 8.4 (2866): a failed stop is a diagnostic at once, not after the handler's 10s wait.
		expect(elapsed).toBeLessThan(5_000);
		const ledger = read(fixture, sessionId);
		expect(ledger.outbox).toEqual([{ status: "failed", taskId: PROCESS }]);
		// No terminate to the dead transport, and no new app-server opened for the stop.
		expect(captured(TERMINATE)).toEqual([]);
		expect(rows<TraceRow>(capturePath).at(-1)?.dir).toBe("exit");
		// 8.3 (2817): no later list omitted the terminal, so it stays listed.
		expect(ledger.snapshots).toEqual([
			[expect.objectContaining({ key: { taskId: PROCESS } })],
		]);
		expect(ledger.errors).toEqual([]);
		followUps.push({
			case: "dead stop",
			message: failure.message,
			elapsedMs: elapsed,
			outbox: ledger.outbox,
			snapshots: ledger.snapshots,
		});
	});

	it("counts a stop as done when Codex finds the terminal already gone and the next list omits it", async () => {
		const { fixture, browser, sessionId } = await start(
			"already-gone",
			terminalTrace((turn) => [
				...terminate(turn.at, turn.threadId, false),
				...listed(turn.at + 1, 903, turn.threadId, []),
			]),
		);
		await submit(browser, sessionId);
		await rowTasks(
			browser,
			sessionId,
			(tasks) => Array.isArray(tasks) && tasks.length === 1,
		);
		await runEnded(fixture, sessionId);
		const cursor = browser.frames.length;
		// The reply comes from the runner's own post-stop list, not from whether that list's
		// snapshot reached the ledger before the handler looked (G8, 2866).
		expect(
			await Effect.runPromise(
				browser.rpc.StopTasks({ sessionId, tasks: [PROCESS] }),
			),
		).toEqual({ ok: true });
		const row = await rowTasks(
			browser,
			sessionId,
			(tasks) => tasks === undefined,
			cursor,
		);
		const ledger = read(fixture, sessionId);
		expect(captured(TERMINATE)).toHaveLength(1);
		expect(ledger.outbox).toEqual([{ status: "completed", taskId: PROCESS }]);
		expect(ledger.snapshots.at(-1)).toEqual([]);
		expect(ledger.errors).toEqual([]);
		followUps.push({
			case: "already gone",
			row: row["backgroundTasks"] ?? null,
			outbox: ledger.outbox,
			snapshots: ledger.snapshots,
		});
	});
});
