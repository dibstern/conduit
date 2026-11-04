// Claude background tasks from the Run Ledger (82tn.32.22; CONTRACT.md 8.1-8.3), over the isolated
// process harness and the recorded background-shell-turn trace. How it could fail (lane audit 160-167):
// 160. Claude's task snapshot never reaches the store as evidence;
// 161. it is stored without its runner's label, so the ledger cannot place it;
// 162. the arm does not fold it, so the ledger never learns of the task;
// 163. the empty snapshot after the shell ends is dropped, so the task lingers;
// 164. the session row reads another copy, so the UI disagrees with the ledger;
// 165. it lands before its runner's process_started and the ledger refuses it;
// 166. the task's kind is not the ledger's (local_bash is a shell);
// 167. the session row is not re-sent when the ledger's tasks change.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			started: db
				.prepare(
					"SELECT sequence, json_extract(data, '$.label') AS label FROM events WHERE session_id = ? AND type = 'evidence.process_started' ORDER BY sequence",
				)
				.all(sessionId) as { sequence: number; label: string }[],
			snapshots: (
				db
					.prepare(
						"SELECT sequence, data FROM events WHERE session_id = ? AND type = 'evidence.tasks_snapshot' ORDER BY sequence",
					)
					.all(sessionId) as { sequence: number; data: string }[]
			).map((row) => ({
				sequence: row.sequence,
				...(JSON.parse(row.data) as {
					label: string;
					tasks: { key: { taskId: string }; taskType: string }[];
				}),
			})),
			folded: (
				db
					.prepare(
						"SELECT event_sequence AS sequence, json_extract(entry_json, '$.command.observation.tasks') AS tasks FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.command.observation.kind') = 'tasks_snapshot' ORDER BY entry_seq",
					)
					.all(sessionId) as { sequence: number; tasks: string }[]
			).map((row) => ({
				sequence: row.sequence,
				taskIds: (JSON.parse(row.tasks) as { key: { taskId: string } }[]).map(
					(task) => task.key.taskId,
				),
			})),
		};
	} finally {
		db.close();
	}
};

describe("Claude background tasks reach the UI through the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof["outcome"] = task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-22-background-tasks-proof.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("lists a background shell with its kind from the ledger and empties it when the shell ends", async () => {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: {
				turns: ["background-shell-turn"],
				holdBeforeResult: true,
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession("Background tasks");
		await browser.followSession(sessionId);
		const row = (cursor: number, tasks: (value: unknown) => boolean) =>
			browser.waitFor(
				(message) =>
					message["type"] === "session_row" &&
					message["id"] === sessionId &&
					tasks(message["backgroundTasks"]),
				cursor,
			);
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: randomUUID(),
					text: "Run sleep 8 in the background",
					delivery: "queue",
				}),
			),
		).toMatchObject({ ok: true, handedOff: true });

		const listed = await row(0, (tasks) => Array.isArray(tasks));
		expect(listed["backgroundTasks"]).toEqual([
			expect.objectContaining({
				id: "bxtrbpf91",
				type: "local_bash",
				kind: "shell",
				description: "sleep 8",
			}),
		]);
		const live = read(fixture, sessionId);
		proof["live"] = { ...live, row: listed["backgroundTasks"] };
		const label = live.started.at(-1)?.label;
		expect(label).toMatch(/^.+:\d+$/);
		expect(live.snapshots.at(-1)).toMatchObject({
			label,
			tasks: [{ key: { taskId: "bxtrbpf91" }, taskType: "local_bash" }],
		});
		expect(live.snapshots.at(-1)?.sequence).toBeGreaterThan(
			live.started.at(-1)?.sequence ?? Infinity,
		);
		expect(live.folded.at(-1)).toEqual({
			sequence: live.snapshots.at(-1)?.sequence,
			taskIds: ["bxtrbpf91"],
		});

		const cursor = browser.frames.length;
		writeFileSync(join(fixture.root, "claude-replay-release"), "release");
		const emptied = await row(cursor, (tasks) => tasks === undefined);
		const ended = read(fixture, sessionId);
		proof["ended"] = { ...ended, row: emptied["backgroundTasks"] ?? null };
		expect(ended.snapshots.at(-1)).toMatchObject({ label, tasks: [] });
		expect(ended.folded.at(-1)).toEqual({
			sequence: ended.snapshots.at(-1)?.sequence,
			taskIds: [],
		});
	});

	// 8.2 (CONTRACT.md 2778-2781): any other task_type is its own kind, verbatim. How it could fail
	// (lane audit 182-184): 182. the unknown task_type is dropped or renamed on its way to the row;
	// 183. it shows but is not counted, so the session reads as idle; 184. the header names it
	// differently from the row (features/session-background-tasks.feature).
	it("shows a task of an unknown kind under its raw name and counts it as work", async () => {
		harness = await ProcessHarness.start({});
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Unknown task kind");
		const tasks = [
			{
				task_id: "future-task",
				task_type: "future_task",
				description: "Sync the remote index",
			},
		];
		await browser.send(sessionId, `background-tasks:${JSON.stringify(tasks)}`);
		const row = await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				Array.isArray(message["backgroundTasks"]),
		);
		proof["unknownKind"] = {
			backgroundWork: row["backgroundWork"],
			backgroundTasks: row["backgroundTasks"],
			attention: row["attention"],
		};
		expect(row["backgroundTasks"]).toEqual([
			expect.objectContaining({
				id: "future-task",
				type: "future_task",
				kind: "future_task",
			}),
		]);
		expect(row["backgroundWork"]).toBe("working");
		expect(row["attention"]).toBe("working");
	});
});
