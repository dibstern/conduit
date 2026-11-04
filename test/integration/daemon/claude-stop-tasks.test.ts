// Stop tasks through the Run Ledger (82tn.32.24; CONTRACT.md 8.4 2860-2867), over the isolated
// process harness and the fake Claude SDK's held task-stop turn. How it could fail (lane 3224
// audit):
// 1. the browser action calls the provider directly, so the ledger issues no stop_task;
// 2. "all" reads the browser's list, not the ledger's latest snapshot;
// 8. a task counts as finished at the SDK's reply, not when a later snapshot drops it;
// 9. an SDK rejection drops the task, retries on its own, or shows nothing;
// 10. one effect for several tasks, or several per task;
// 11. Stop tasks interrupts or ends the foreground turn;
// 17. stop_task rows wait behind the running turn's session lane.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	responseChunks,
	taskStopFixture,
} from "../../helpers/fake-claude-process-sdk.js";
import {
	type ProcessBrowser as BrowserClient,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const foreground = "task-stop-foreground";
const allIds = taskStopFixture.map((task) => task.task_id).sort();

const marks = (harness: ProcessHarness): Record<string, unknown>[] => {
	const file = join(harness.root, "sdk-proof.ndjson");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
};
const stopMarks = (harness: ProcessHarness, phase: string) =>
	marks(harness)
		.filter((mark) => mark["kind"] === "task-stop" && mark["phase"] === phase)
		.map((mark) => String(mark["taskId"]));

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			outbox: db
				.prepare(
					"SELECT command_id AS commandId, status, error_code AS errorCode, json_extract(payload_json, '$.effect.key.taskId') AS taskId, json_extract(payload_json, '$.token') AS token FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'stop_task' ORDER BY request_sequence",
				)
				.all(sessionId) as {
				commandId: string;
				status: string;
				errorCode: string | null;
				taskId: string;
				token: string;
			}[],
			events: db
				.prepare(
					"SELECT sequence, type, data FROM events WHERE session_id = ? AND type IN ('tasks.stop_requested', 'evidence.effect_outcome', 'interrupt.requested', 'session.end_requested') ORDER BY sequence",
				)
				.all(sessionId) as { sequence: number; type: string; data: string }[],
			lastSnapshot: (
				db
					.prepare(
						"SELECT json_extract(data, '$.tasks') AS tasks FROM events WHERE session_id = ? AND type = 'evidence.tasks_snapshot' ORDER BY sequence DESC LIMIT 1",
					)
					.get(sessionId) as { tasks: string } | undefined
			)?.tasks,
		};
	} finally {
		db.close();
	}
};

/** The held turn's query id, once its four tasks show on the session row. */
const startTurn = async (harness: ProcessHarness, browser: BrowserClient) => {
	const sessionId = await browser.createSession("Stop tasks");
	await browser.followSession(sessionId);
	const turn = browser.send(sessionId, foreground);
	void turn.catch(() => undefined);
	await browser.waitFor(
		(message) =>
			message["type"] === "session_row" &&
			message["id"] === sessionId &&
			Array.isArray(message["backgroundTasks"]) &&
			message["backgroundTasks"].length === taskStopFixture.length,
	);
	// test-waits-allow polling: the fake SDK reports its held turn only through sdk-proof.ndjson.
	const held = await vi.waitFor(() => {
		const mark = marks(harness).find(
			(mark) =>
				mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
		);
		expect(typeof mark?.["queryId"]).toBe("string");
		return mark;
	});
	return { sessionId, turn, queryId: String(held?.["queryId"]) };
};

const turnUntouched = (harness: ProcessHarness, queryId: string) =>
	expect(
		marks(harness).filter(
			(mark) =>
				mark["queryId"] === queryId &&
				["query-interrupted", "query-closed"].includes(String(mark["kind"])),
		),
	).toEqual([]);

// The sidebar's row carries the ledger's tasks; the session's own row (it names workspaceMismatch,
// not workspaceHint) never does, so it cannot stand for an emptied list.
const rowTasks =
	(browser: BrowserClient, sessionId: string, cursor: number) =>
	(predicate: (tasks: unknown) => boolean) =>
		browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				"workspaceHint" in message &&
				predicate(message["backgroundTasks"]),
			cursor,
		);

describe("Stop tasks through the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[`${task.name} outcome`] =
				task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-24-stop-tasks-proof.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("stops every live task with one effect each and the turn keeps running", async () => {
		const fixture = await ProcessHarness.start({ restartProof: true });
		harness = fixture;
		const browser = await harness.connect();
		await browser.followSessions();
		const { sessionId, turn, queryId } = await startTurn(harness, browser);

		const cursor = browser.frames.length;
		expect(
			await Effect.runPromise(
				browser.rpc.StopTasks({ sessionId, tasks: "all" }),
			),
		).toEqual({ ok: true });
		// test-waits-allow polling: the fake SDK reports each stopTask call only through sdk-proof.ndjson.
		await vi.waitFor(() =>
			expect(stopMarks(fixture, "requested").sort()).toEqual(allIds),
		);
		const issued = read(harness, sessionId);
		proof["all: issued"] = {
			...issued,
			marks: stopMarks(harness, "requested"),
		};
		// One stop_task per task, each its own token, none waiting behind the held turn.
		expect(issued.outbox.map((row) => row.taskId).sort()).toEqual(allIds);
		expect(new Set(issued.outbox.map((row) => row.token)).size).toBe(4);
		expect(issued.outbox.map((row) => row.status)).toEqual(
			Array(4).fill("completed"),
		);
		expect(
			issued.events.filter((event) => event.type === "tasks.stop_requested"),
		).toHaveLength(1);
		expect(
			issued.events.filter((event) =>
				["interrupt.requested", "session.end_requested"].includes(event.type),
			),
		).toEqual([]);
		// The SDK's reply ends nothing: the tasks stay listed until a snapshot drops them.
		expect((JSON.parse(issued.lastSnapshot ?? "[]") as unknown[]).length).toBe(
			4,
		);
		turnUntouched(harness, queryId);

		writeFileSync(join(harness.root, "task-stop-confirm-all"), "release");
		const emptied = await rowTasks(
			browser,
			sessionId,
			cursor,
		)((tasks) => tasks === undefined);
		const ended = read(harness, sessionId);
		proof["all: ended"] = {
			lastSnapshot: ended.lastSnapshot,
			row: emptied["backgroundTasks"] ?? null,
			attention: emptied["attention"],
		};
		expect(JSON.parse(ended.lastSnapshot ?? "null")).toEqual([]);
		turnUntouched(harness, queryId);

		writeFileSync(join(harness.root, "task-stop-release-result"), "release");
		const done = await turn;
		proof["all: turn"] = { chunks: done.chunks };
		expect(done.chunks.join("")).toBe(responseChunks(foreground).join(""));
		turnUntouched(harness, queryId);
		expect(stopMarks(harness, "requested")).toHaveLength(4);
	});

	it("keeps a task whose stop the SDK rejects, shows why, and never retries", async () => {
		harness = await ProcessHarness.start({ restartProof: true });
		const browser = await harness.connect();
		await browser.followSessions();
		const { sessionId, turn, queryId } = await startTurn(harness, browser);
		const [shell] = taskStopFixture;

		writeFileSync(join(harness.root, `task-stop-fail-${shell.task_id}`), "x");
		const failure = await Effect.runPromise(
			Effect.flip(browser.rpc.StopTasks({ sessionId, tasks: [shell.task_id] })),
		);
		const failed = read(harness, sessionId);
		proof["rejected stop"] = {
			message: failure.message,
			outbox: failed.outbox,
			marks: { requested: stopMarks(harness, "requested") },
		};
		expect(failure.message).toMatch(/could not stop/i);
		expect(failed.outbox).toEqual([
			expect.objectContaining({ taskId: shell.task_id, status: "failed" }),
		]);
		// No retry on its own: one call, still one after the reactor has had time to act.
		// test-waits-allow real-wait: no retry is an absence, which only elapsed time can show.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(stopMarks(harness, "requested")).toEqual([shell.task_id]);
		expect(read(harness, sessionId).outbox).toHaveLength(1);
		expect(
			(JSON.parse(read(harness, sessionId).lastSnapshot ?? "[]") as unknown[])
				.length,
		).toBe(4);

		writeFileSync(join(harness.root, "task-stop-release-result"), "release");
		await turn;
		turnUntouched(harness, queryId);
	});
});

// Box 2: a Stop tasks with nothing to stop is refused with its reason and records nothing. How it
// could fail (lane 3224 audit): 5. no tasks is accepted silently or refused without a reason;
// 6. a provider with none fails generically or calls a missing method; 7. named ids that are not
// live are sent to stopTask, or refused without a reason; 18. the reason names contract ids.
describe("Stop tasks refuses what it cannot stop, with its reason", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[`${task.name} outcome`] =
				task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-24-stop-tasks-refused.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	/** The refusal's message, after checking it appended no request and issued no stop. */
	const refused = async (
		fixture: ProcessHarness,
		browser: BrowserClient,
		sessionId: string,
		tasks: "all" | readonly [string, ...string[]],
	) => {
		const before = read(fixture, sessionId);
		const { message } = await Effect.runPromise(
			Effect.flip(browser.rpc.StopTasks({ sessionId, tasks })),
		);
		const after = read(fixture, sessionId);
		expect(after.outbox).toEqual(before.outbox);
		expect(
			after.events.filter((event) => event.type === "tasks.stop_requested"),
		).toEqual(
			before.events.filter((event) => event.type === "tasks.stop_requested"),
		);
		return message;
	};

	it("refuses no tasks and ids that are not running, and stops only the live ones it names", async () => {
		const fixture = await ProcessHarness.start({ restartProof: true });
		harness = fixture;
		const browser = await fixture.connect();
		await browser.followSessions();

		const idle = await browser.createSession("No tasks");
		const fresh = await refused(fixture, browser, idle, "all");
		proof["no tasks"] = { message: fresh };
		expect(fresh).toBe("No background tasks are running");

		const { sessionId, turn, queryId } = await startTurn(fixture, browser);
		const [shell] = taskStopFixture;
		const missing = {
			one: await refused(fixture, browser, sessionId, ["no-such-task"]),
			several: await refused(fixture, browser, sessionId, [
				"no-such-task",
				"another-missing-task",
			]),
		};
		proof["ids not running"] = missing;
		expect(missing).toEqual({
			one: "That background task is not running",
			several: "Those background tasks are not running",
		});
		expect(stopMarks(fixture, "requested")).toEqual([]);

		// A live id among unknown ones is stopped; the unknown ones are left out.
		expect(
			await Effect.runPromise(
				browser.rpc.StopTasks({
					sessionId,
					tasks: [shell.task_id, "no-such-task"],
				}),
			),
		).toEqual({ ok: true });
		const mixed = read(fixture, sessionId);
		proof["live among unknown"] = {
			outbox: mixed.outbox,
			requested: stopMarks(fixture, "requested"),
		};
		expect(mixed.outbox.map((row) => row.taskId)).toEqual([shell.task_id]);
		expect(stopMarks(fixture, "requested")).toEqual([shell.task_id]);

		// Once a snapshot drops it, the shell is no longer a task to stop.
		const cursor = browser.frames.length;
		writeFileSync(join(fixture.root, "task-stop-confirm-all"), "release");
		await rowTasks(
			browser,
			sessionId,
			cursor,
		)((tasks) => Array.isArray(tasks) && tasks.length === 3);
		const finished = await refused(fixture, browser, sessionId, [
			shell.task_id,
		]);
		proof["after a snapshot drops it"] = { message: finished };
		expect(finished).toBe("That background task is not running");

		writeFileSync(join(fixture.root, "task-stop-release-result"), "release");
		await turn;
		turnUntouched(fixture, queryId);
		expect(stopMarks(fixture, "requested")).toEqual([shell.task_id]);
	});

	it("refuses a provider that has no background tasks", async () => {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"OpenCode",
			"opencode",
			"opencode",
		);
		const none = {
			all: await refused(fixture, browser, sessionId, "all"),
			named: await refused(fixture, browser, sessionId, ["any-task"]),
		};
		proof["provider has none"] = none;
		expect(none).toEqual({
			all: "This session's provider has no background tasks",
			named: "This session's provider has no background tasks",
		});
	});
});
