/**
 * A real Claude background shell is stopped by Stop tasks while the turn that started it keeps
 * running (82tn.32.24; CONTRACT.md 8.4 2860-2867). How it could fail (lane 3224 audit 1, 8, 11):
 * the stop never reaches the SDK's stopTask; the row drops the task at the SDK's reply rather than
 * at the snapshot that leaves it out; the stop interrupts or ends the foreground turn.
 *
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-stop-tasks-live.test.ts
 * Leaves test-results/82tn-32-24-stop-tasks-live.json and the session's JSONL trace beside it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const PROMPT = [
	"Run this Bash command in the background (run_in_background: true), with the description 'stop probe sleep': sleep 300",
	"Then, without waiting for it, run this in the foreground (not in the background): node -e \"setTimeout(() => console.log('waited'), 40000)\"",
	"Then reply with only: foreground-finished.",
].join("\n");

describe.skipIf(!RUN_EXPENSIVE)("Claude Stop tasks (real SDK)", () => {
	// test-waits-allow timeout-override: a real SDK turn with a foreground sleep takes minutes.
	it(
		"stops the background shell, the snapshot empties, and the turn keeps running",
		{ timeout: 600_000 },
		async () => {
			const captureDir = mkdtempSync(join(tmpdir(), "conduit-stop-live-"));
			const harness = ProcessHarness.create({
				dist: "dist",
				realSdk: true,
				claudeCaptureDir: captureDir,
			});
			const evidence: Record<string, unknown> = {
				ticket: "82tn.32.24",
				at: new Date().toISOString(),
				outcome: "failed",
			};
			try {
				await harness.restart();
				const browser = await harness.connect();
				await browser.followSessions();
				const sessionId = await browser.createSession("Stop tasks live");
				evidence["sessionId"] = sessionId;
				await Effect.runPromise(
					browser.rpc.SwitchPermissionMode({ sessionId, mode: "full" }),
				);
				// The sidebar's row carries the ledger's tasks; the session's own row never does.
				const row = (
					predicate: (row: Record<string, unknown>) => boolean,
					cursor = browser.frames.length,
				) =>
					browser.waitFor(
						(message) =>
							message["type"] === "session_row" &&
							message["id"] === sessionId &&
							"workspaceHint" in message &&
							predicate(message),
						cursor,
						240_000,
					);
				const listed = row((message) =>
					Array.isArray(message["backgroundTasks"]),
				);
				const turn = browser.send(sessionId, PROMPT, 300_000);
				let turnEnded = false;
				void turn.then(
					() => {
						turnEnded = true;
					},
					() => {
						turnEnded = true;
					},
				);
				evidence["listed"] = (await listed)["backgroundTasks"];
				const after = browser.frames.length;
				evidence["stop"] = await Effect.runPromise(
					browser.rpc.StopTasks({ sessionId, tasks: "all" }),
				);
				evidence["turnEndedBeforeEmptied"] = turnEnded;
				const emptied = await row(
					(message) => message["backgroundTasks"] === undefined,
					after,
				);
				evidence["emptied"] = {
					processing: emptied["processing"],
					turnEnded,
				};
				evidence["text"] = (await turn).chunks.join("");
				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					evidence["outbox"] = db
						.prepare(
							"SELECT command_id AS commandId, status, error_code AS errorCode, json_extract(payload_json, '$.effect.key.taskId') AS taskId FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'stop_task' ORDER BY request_sequence",
						)
						.all(sessionId);
					evidence["snapshots"] = db
						.prepare(
							"SELECT sequence, json_array_length(data, '$.tasks') AS tasks FROM events WHERE session_id = ? AND type = 'evidence.tasks_snapshot' ORDER BY sequence",
						)
						.all(sessionId);
					evidence["stops"] = db
						.prepare(
							"SELECT sequence, type FROM events WHERE session_id = ? AND type IN ('tasks.stop_requested', 'interrupt.requested', 'session.end_requested') ORDER BY sequence",
						)
						.all(sessionId);
					evidence["turns"] = db
						.prepare(
							"SELECT sequence, type FROM events WHERE session_id = ? AND type LIKE 'evidence.turn_%' ORDER BY sequence",
						)
						.all(sessionId);
				} finally {
					db.close();
				}
				const listedIds = (evidence["listed"] as { id: string }[]).map(
					(task) => task.id,
				);
				expect(listedIds.length).toBeGreaterThan(0);
				expect(evidence["stop"]).toEqual({ ok: true });
				expect(
					(evidence["outbox"] as { taskId: string; status: string }[]).map(
						(entry) => [entry.taskId, entry.status],
					),
				).toEqual(listedIds.map((id) => [id, "completed"]));
				// The stop came while the turn ran, and the turn was neither interrupted nor ended.
				expect(evidence["emptied"]).toMatchObject({ turnEnded: false });
				expect(evidence["stops"]).toEqual([
					expect.objectContaining({ type: "tasks.stop_requested" }),
				]);
				expect(
					(evidence["snapshots"] as { tasks: number }[]).at(-1)?.tasks,
				).toBe(0);
				expect(String(evidence["text"])).toContain("foreground-finished");
				evidence["outcome"] = "passed";
			} finally {
				mkdirSync("test-results", { recursive: true });
				const sessionId = evidence["sessionId"];
				if (typeof sessionId === "string")
					try {
						copyFileSync(
							join(captureDir, `${sessionId}.jsonl`),
							"test-results/82tn-32-24-stop-tasks-live.jsonl",
						);
					} catch (cause) {
						evidence["traceCopy"] = String(cause);
					}
				writeFileSync(
					"test-results/82tn-32-24-stop-tasks-live.json",
					`${JSON.stringify(evidence, null, 2)}\n`,
				);
				await harness.dispose();
			}
		},
	);
});
