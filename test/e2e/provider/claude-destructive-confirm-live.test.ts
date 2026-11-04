/**
 * A real Claude turn whose Stop is ignored asks before it ends a real background shell, and the
 * confirm closes it with a lost-work entry that survives a reload (82tn.32.25; CONTRACT.md 8.4
 * 2870-2877, L5 2907-2913). The query's interrupt is acknowledged but never sent
 * (CONDUIT_TEST_REAL_CLAUDE_DEAF_INTERRUPT), because a real Claude obeys it. How it could fail
 * (lane 3225 audit 1, 3, 5, 13, 14): the deadline closes the process unasked; the ask never names
 * the real task; a confirm never closes it; the close leaves no timeline entry, or it is gone after
 * a reload.
 *
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-destructive-confirm-live.test.ts
 * Leaves test-results/82tn-32-25-destructive-confirm-live.json and the session's JSONL trace beside it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser as BrowserClient,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const STOP_WAIT_MS = 3_000;
const PROMPT = [
	"Run this Bash command in the background (run_in_background: true), with the description 'confirm probe sleep': sleep 300",
	// Claude Code refuses a standalone foreground sleep, which would end the turn before the Stop.
	'Then, without waiting for it, run this in the foreground (not in the background): node -e "setTimeout(() => {}, 100000)"',
	"Then reply with only: foreground-finished.",
].join("\n");

type Shown = {
	readonly id: string;
	readonly kind?: string;
	readonly type: string;
	readonly description: string;
	readonly detail?: string;
};
type StopConfirm = {
	readonly snapshotEntry: number;
	readonly tasks?: readonly Shown[];
};

/** The decided copy for a task: "pnpm test (shell)", else "(kind): description". */
const named = ({ kind, type, description, detail }: Shown) =>
	detail ? `${detail} (${kind ?? type})` : `(${kind ?? type}): ${description}`;

const lostNotices = async (browser: BrowserClient, sessionId: string) =>
	(await browser.history(sessionId)).flatMap((message) =>
		(message.parts ?? []).flatMap((part) =>
			part.type === "notice" && part.text?.startsWith("Background work")
				? [part.text]
				: [],
		),
	);

describe.skipIf(!RUN_EXPENSIVE)("Claude stuck Stop confirm (real SDK)", () => {
	// test-waits-allow timeout-override: a real SDK turn with a background and a foreground shell takes minutes.
	it(
		"asks with the real background shell past the deadline, and the confirm closes it with a lost-work entry",
		{ timeout: 600_000 },
		async () => {
			const captureDir = mkdtempSync(join(tmpdir(), "conduit-confirm-live-"));
			const harness = ProcessHarness.create({
				dist: "dist",
				realSdk: true,
				claudeCaptureDir: captureDir,
			});
			const evidence: Record<string, unknown> = {
				ticket: "82tn.32.25",
				at: new Date().toISOString(),
				outcome: "failed",
			};
			try {
				await harness.restart({
					serviceEnvironment: {
						CONDUIT_TEST_STOP_ABORT_WAIT_MS: String(STOP_WAIT_MS),
						CONDUIT_TEST_REAL_CLAUDE_DEAF_INTERRUPT: "1",
					},
				});
				const browser = await harness.connect();
				await browser.followSessions();
				const sessionId = await browser.createSession("Stuck Stop live");
				evidence["sessionId"] = sessionId;
				await Effect.runPromise(
					browser.rpc.SwitchPermissionMode({ sessionId, mode: "full" }),
				);
				// The sidebar's row carries the ledger's tasks and the ask.
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
				const listed = row(
					(message) =>
						Array.isArray(message["backgroundTasks"]) &&
						message["backgroundTasks"].length > 0,
				);
				const turn = browser.send(sessionId, PROMPT, 300_000);
				void turn.catch(() => undefined);
				const tasks = (await listed)["backgroundTasks"] as Shown[];
				evidence["listed"] = tasks;

				const askedFrom = browser.frames.length;
				const stopped = Effect.runPromise(
					browser.rpc.CancelSession({
						sessionId,
						commandId: crypto.randomUUID(),
					}),
				);
				void stopped.catch(() => undefined);
				const asked = (await row(
					(message) => message["stopConfirm"] !== undefined,
					askedFrom,
				)) as { stopConfirm: StopConfirm };
				evidence["asked"] = asked.stopConfirm;
				expect(asked.stopConfirm.tasks?.map((task) => task.id)).toEqual(
					tasks.map((task) => task.id),
				);
				// test-waits-allow real-wait: nothing closing is an absence past the deadline.
				await new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS));
				expect(harness.remainingRunnerPids().length).toBeGreaterThan(0);

				// Any newer snapshot makes a confirm stale (D45); like the UI, confirm the newest ask.
				const answers: unknown[] = [];
				evidence["answers"] = answers;
				let confirmed: StopConfirm | undefined;
				// test-waits-allow polling: each try reads the newest ask the browser has.
				await vi.waitFor(
					async () => {
						const newest = browser.frames
							.slice(askedFrom)
							.filter(
								({ message }) =>
									message["type"] === "session_row" &&
									message["id"] === sessionId &&
									"workspaceHint" in message,
							)
							.at(-1)?.message["stopConfirm"] as StopConfirm | undefined;
						// A gone ask means the turn ended by itself, which this check cannot use.
						if (newest === undefined) {
							answers.push({ gone: true });
							throw new Error("The ask is gone before a confirm landed");
						}
						const answer = await Effect.runPromise(
							Effect.result(
								browser.rpc.ConfirmEscalation({
									sessionId,
									snapshotEntry: newest?.snapshotEntry ?? 0,
								}),
							),
						);
						answers.push({ entry: newest?.snapshotEntry, answer });
						expect(answer._tag).toBe("Success");
						confirmed = newest;
					},
					{ timeout: 30_000, interval: 500 },
				);
				evidence["stop"] = await stopped;

				// test-waits-allow polling: the notice is read back as history, which has no push to wait on.
				const lost = await vi.waitFor(
					async () => {
						const found = await lostNotices(browser, sessionId);
						expect(found).toHaveLength(1);
						return found;
					},
					{ timeout: 60_000, interval: 500 },
				);
				evidence["notice"] = lost;
				// The entry names the tasks as the confirmed ask showed them; a later snapshot may add the command.
				expect(confirmed?.tasks?.map((task) => task.id)).toEqual(
					tasks.map((task) => task.id),
				);
				for (const task of confirmed?.tasks ?? [])
					expect(lost[0]).toContain(named(task));
				const reloaded = await harness.connect(sessionId);
				const afterReload = await lostNotices(reloaded, sessionId);
				evidence["afterReload"] = afterReload;
				expect(afterReload).toEqual(lost);

				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					evidence["events"] = db
						.prepare(
							"SELECT sequence, type, json_extract(data, '$.snapshotEntry') AS snapshotEntry FROM events WHERE session_id = ? AND type IN ('interrupt.requested', 'escalation.confirmed', 'session.end_requested', 'evidence.process_exited') ORDER BY sequence",
						)
						.all(sessionId);
				} finally {
					db.close();
				}
				expect(
					(evidence["events"] as { type: string }[]).map((event) => event.type),
				).toContain("escalation.confirmed");
				evidence["outcome"] = "passed";
			} finally {
				mkdirSync("test-results", { recursive: true });
				const sessionId = evidence["sessionId"];
				if (typeof sessionId === "string")
					try {
						copyFileSync(
							join(captureDir, `${sessionId}.jsonl`),
							"test-results/82tn-32-25-destructive-confirm-live.jsonl",
						);
					} catch (cause) {
						evidence["traceCopy"] = String(cause);
					}
				if (typeof sessionId === "string" && evidence["outcome"] !== "passed")
					try {
						const db = new Database(harness.daemonStorePath(), {
							readonly: true,
						});
						evidence["trail"] = db
							.prepare(
								"SELECT sequence, type, substr(data, 1, 160) AS data FROM events WHERE session_id = ? AND sequence >= (SELECT MIN(sequence) FROM events WHERE session_id = ? AND type = 'interrupt.requested') - 2 ORDER BY sequence LIMIT 60",
							)
							.all(sessionId, sessionId);
						db.close();
					} catch (cause) {
						evidence["trail"] = String(cause);
					}
				writeFileSync(
					"test-results/82tn-32-25-destructive-confirm-live.json",
					`${JSON.stringify(evidence, null, 2)}\n`,
				);
				await harness.dispose();
			}
		},
	);
});
