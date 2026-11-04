/**
 * A real Claude background shell wakes the agent, the session row names the wake Run by its task,
 * and Stop interrupts it (82tn.32.23; CONTRACT.md 8.3). How it could fail (lane audit 1, 3, 8, 13):
 * the real SDK wakes with no notification before the turn, or its result names an input, so no wake
 * Run opens; the row never names the task, or keeps it after the wake ends; Stop leaves the wake to
 * the alarm.
 *
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-wake-run-live.test.ts
 * Leaves test-results/82tn-32-23-wake-live.json and the session's JSONL trace beside it.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const PROMPT = [
	"Run this Bash command in the background (run_in_background: true), with the description 'wake probe sleep': sleep 8",
	"Then end your turn at once without waiting for it; reply with only: started.",
	"When it finishes, run `sleep 45` in the foreground (not in the background), then reply with only: done.",
].join("\n");

describe.skipIf(!RUN_EXPENSIVE)("Claude wake Run (real SDK)", () => {
	// test-waits-allow timeout-override: a real SDK turn, its background shell, and the wake take minutes.
	it(
		"wakes on the shell's completion, names it on the row, and Stop interrupts the wake",
		{ timeout: 600_000 },
		async () => {
			const captureDir = mkdtempSync(join(tmpdir(), "conduit-wake-live-"));
			const harness = ProcessHarness.create({
				dist: "dist",
				realSdk: true,
				claudeCaptureDir: captureDir,
			});
			const evidence: Record<string, unknown> = {
				ticket: "82tn.32.23",
				at: new Date().toISOString(),
				outcome: "failed",
			};
			try {
				await harness.restart();
				const browser = await harness.connect();
				await browser.followSessions();
				const sessionId = await browser.createSession("Wake Run live");
				evidence["sessionId"] = sessionId;
				await Effect.runPromise(
					browser.rpc.SwitchPermissionMode({ sessionId, mode: "full" }),
				);
				const row = (predicate: (row: Record<string, unknown>) => boolean) =>
					browser.waitFor(
						(message) =>
							message["type"] === "session_row" &&
							message["id"] === sessionId &&
							predicate(message),
						browser.frames.length,
						240_000,
					);
				const listed = row((message) =>
					Array.isArray(message["backgroundTasks"]),
				);
				const named = row((message) => message["wakeRun"] !== undefined);
				evidence["launchText"] = (
					await browser.send(sessionId, PROMPT, 180_000)
				).chunks.join("");
				evidence["listed"] = (await listed)["backgroundTasks"];
				const woken = await named;
				evidence["wakeRun"] = woken["wakeRun"];
				const after = browser.frames.length;
				await harness.requestRpc({
					_tag: "CancelSession",
					sessionId,
					commandId: randomUUID(),
				});
				const cleared = await browser.waitFor(
					(message) =>
						message["type"] === "session_row" &&
						message["id"] === sessionId &&
						message["wakeRun"] === undefined,
					after,
					120_000,
				);
				evidence["clearedAfterStop"] = { processing: cleared["processing"] };
				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					evidence["turns"] = db
						.prepare(
							"SELECT sequence, type, json_extract(data, '$.wakeTask.taskId') AS wakeTask FROM events WHERE session_id = ? AND type LIKE 'evidence.turn_%' ORDER BY sequence",
						)
						.all(sessionId);
					evidence["ends"] = db
						.prepare(
							"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
						)
						.all(sessionId);
					evidence["runs"] = db
						.prepare("SELECT id FROM provider_runs WHERE session_id = ?")
						.all(sessionId);
				} finally {
					db.close();
				}
				const description = (
					evidence["listed"] as { description?: string }[]
				)[0]?.description;
				expect(description).toBeTruthy();
				expect(woken["wakeRun"]).toEqual({ task: description });
				const runIds = new Set(
					(evidence["runs"] as { id: string }[]).map((run) => run.id),
				);
				expect(
					(
						evidence["ends"] as {
							runId: string;
							reason: string;
							forced: number | null;
						}[]
					).filter((end) => !runIds.has(end.runId)),
				).toEqual([
					expect.objectContaining({ reason: "interrupted", forced: 0 }),
				]);
				evidence["outcome"] = "passed";
			} finally {
				mkdirSync("test-results", { recursive: true });
				const sessionId = evidence["sessionId"];
				if (typeof sessionId === "string")
					try {
						copyFileSync(
							join(captureDir, `${sessionId}.jsonl`),
							"test-results/82tn-32-23-wake-live.jsonl",
						);
					} catch (cause) {
						evidence["traceCopy"] = String(cause);
					}
				writeFileSync(
					"test-results/82tn-32-23-wake-live.json",
					`${JSON.stringify(evidence, null, 2)}\n`,
				);
				await harness.dispose();
			}
		},
	);
});
