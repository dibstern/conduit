/**
 * A real Claude goal cleared mid-turn (82tn.32.26; CONTRACT.md 8.6). The row the browser follows
 * reads Clearing, then queued by Claude, then Cleared once the turn ends; the clear goes to
 * Claude as `/goal clear` with priority "next", never "now", and never interrupts the turn.
 * How it could fail (lane 3226 audit): the row skips the queued step or never reaches Cleared;
 * the clear is sent with priority "now" or interrupts the turn; the clear lands before the turn ends.
 *
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-goals-live.test.ts
 * Leaves test-results/82tn-32-26-goals-live.json, the session's SDK trace and the SDK inputs
 * beside it (and copies the JSON to LANE_EVIDENCE_DIR when set).
 */
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const EVIDENCE = "test-results/82tn-32-26-goals-live.json";
const COMMAND = "node -e \"setTimeout(() => console.log('waited'), 45000)\"";
const CONDITION = `You ran this exact command in the foreground (not in the background) and it printed waited: ${COMMAND}`;
const PROMPT = `Run this in the foreground (not in the background): ${COMMAND}\nThen reply with only: long-turn-finished.`;

type Row = Record<string, unknown> & {
	goalPhase?: { tag: string; action?: { kind: string }; send?: string };
	goalState?: { goal?: unknown };
	processing?: boolean;
};

/**
 * What the session bar and composer show for a row: the bar reads Clearing for any pending
 * clear (SessionBar.svelte), and the composer adds "after this turn (queued by Claude)" while
 * Claude holds it (InputArea.svelte).
 */
const shown = (row: Row) => {
	const phase = row.goalPhase;
	if (phase?.tag === "Pending" && phase.action?.kind === "clear")
		return phase.send === "Sent"
			? "Clearing"
			: phase.send === "Queued"
				? "Clearing, queued by Claude"
				: `Clearing, ${phase.send}`;
	return row.goalState?.goal ? "Pursuing" : "Cleared";
};

const jsonl = (file: string) =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];

describe.skipIf(!RUN_EXPENSIVE)("Claude goals (real SDK)", () => {
	// test-waits-allow timeout-override: a real goal turn with a foreground sleep takes minutes.
	it(
		"shows a mid-turn clear as Clearing, queued by Claude, then Cleared after the turn",
		{ timeout: 600_000 },
		async () => {
			const captureDir = mkdtempSync(join(tmpdir(), "conduit-goals-live-"));
			const harness = ProcessHarness.create({
				dist: "dist",
				realSdk: true,
				claudeCaptureDir: captureDir,
			});
			const evidence: Record<string, unknown> = {
				ticket: "82tn.32.26",
				at: new Date().toISOString(),
				outcome: "failed",
			};
			try {
				await harness.restart();
				const browser = await harness.connect();
				await browser.followSessions();
				const sessionId = await browser.createSession("Goals live");
				evidence["sessionId"] = sessionId;
				await Effect.runPromise(
					browser.rpc.SwitchPermissionMode({ sessionId, mode: "full" }),
				);
				// The browser reads the sidebar's row first (findSession), so that is the one followed.
				const isRow = (message: Record<string, unknown>): message is Row =>
					message["type"] === "session_row" &&
					message["id"] === sessionId &&
					"workspaceHint" in message;
				const row = (predicate: (row: Row) => boolean, cursor: number) =>
					browser.waitFor(
						(message) => isRow(message) && predicate(message),
						cursor,
						300_000,
					) as Promise<Row>;

				await Effect.runPromise(
					browser.rpc.SetGoal({
						sessionId,
						commandId: randomUUID(),
						condition: CONDITION,
					}),
				);
				// With no live Claude process the goal waits for the next launch (8.5), which this
				// long turn makes; the goal command goes first and its turn runs the command.
				const sentAt = browser.frames.length;
				const turn = browser.send(sessionId, PROMPT, 400_000).then(
					(result) => result.chunks.join(""),
					(cause: unknown) => `turn failed: ${String(cause)}`,
				);
				// The goal is confirmed only with the turn's result, so the clear goes in once
				// Claude has started the 45 s command: mid-turn.
				await browser.waitFor(
					(message) =>
						message["type"] === "transcript_message" &&
						message["sessionId"] === sessionId &&
						message["role"] === "assistant" &&
						JSON.stringify(message["parts"] ?? []).includes("setTimeout"),
					sentAt,
					300_000,
				);
				const clearAt = browser.frames.length;
				const clearId = randomUUID();
				await Effect.runPromise(
					browser.rpc.ClearGoal({ sessionId, commandId: clearId }),
				);
				// The goal is unconfirmed until the turn's result, so an early row reads Cleared too;
				// only an idle one is the end.
				await row(
					(message) =>
						shown(message) === "Cleared" && message.processing !== true,
					clearAt,
				);

				const rows = browser.frames
					.slice(clearAt)
					.map(({ message }) => message)
					.filter(isRow);
				const steps = rows
					.map((message) => ({
						shown: shown(message),
						processing: message.processing === true,
					}))
					.filter(
						(step, index, all) =>
							index === 0 ||
							step.shown !== all[index - 1]?.shown ||
							step.processing !== all[index - 1]?.processing,
					);
				evidence["steps"] = steps;
				evidence["text"] = await turn;
				const inputs = jsonl(join(captureDir, "inputs.jsonl"));
				evidence["inputs"] = inputs.map((input) => ({
					uuid: input["uuid"],
					priority: input["priority"],
					content: (input["message"] as { content?: unknown } | undefined)
						?.content,
				}));
				const clears = inputs.filter(
					(input) =>
						(input["message"] as { content?: unknown } | undefined)?.content ===
						"/goal clear",
				);
				const clearUuids = new Set(clears.map((input) => input["uuid"]));
				const trace = jsonl(join(captureDir, `${sessionId}.jsonl`));
				// Claude starts the clear only after the long turn's result.
				evidence["clearStartedAfterResult"] =
					trace.findIndex(
						(message) =>
							message["type"] === "command_lifecycle" &&
							message["state"] === "started" &&
							clearUuids.has(message["command_uuid"]),
					) > trace.findIndex((message) => message["type"] === "result");
				evidence["clearLifecycle"] = trace
					.filter(
						(message) =>
							message["type"] === "command_lifecycle" &&
							clearUuids.has(message["command_uuid"]),
					)
					.map((message) => message["state"]);
				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					evidence["events"] = db
						.prepare(
							"SELECT sequence, type FROM events WHERE session_id = ? AND (type LIKE 'evidence.turn_%' OR type IN ('native_command.requested', 'interrupt.requested', 'session.end_requested')) ORDER BY sequence",
						)
						.all(sessionId);
				} finally {
					db.close();
				}

				const labels = steps
					.map((step) => step.shown)
					.filter((label, index, all) => label !== all[index - 1]);
				// Rows before the clear's hand-over read the unconfirmed goal. Then the bar reads
				// Clearing, queued by Claude while the turn runs, until Cleared once it has ended.
				const fromClear = labels.slice(
					labels.findIndex((label) => label.startsWith("Clearing")),
				);
				expect(fromClear.at(0)?.startsWith("Clearing")).toBe(true);
				expect(fromClear.at(-1)).toBe("Cleared");
				expect(
					fromClear.slice(0, -1).every((label) => label.startsWith("Clearing")),
				).toBe(true);
				expect(
					steps.find((step) => step.shown === "Clearing, queued by Claude")
						?.processing,
				).toBe(true);
				expect(steps.at(-1)).toEqual({ shown: "Cleared", processing: false });
				expect(evidence["clearStartedAfterResult"]).toBe(true);
				// 8.6: one `/goal clear`, priority "next" and never "now".
				expect(clears.map((input) => input["priority"])).toEqual(["next"]);
				expect(evidence["clearLifecycle"]).toEqual(
					expect.arrayContaining(["queued", "completed"]),
				);
				expect(evidence["clearLifecycle"]).not.toContain("cancelled");
				expect(
					(evidence["events"] as { type: string }[]).map(({ type }) => type),
				).not.toContain("interrupt.requested");
				evidence["outcome"] = "passed";
			} finally {
				mkdirSync("test-results", { recursive: true });
				const sessionId = evidence["sessionId"];
				for (const [from, to] of [
					[`${sessionId}.jsonl`, "82tn-32-26-goals-live.jsonl"],
					["inputs.jsonl", "82tn-32-26-goals-live-inputs.jsonl"],
				] as const)
					try {
						copyFileSync(join(captureDir, from), join("test-results", to));
					} catch (cause) {
						evidence[`copy ${from}`] = String(cause);
					}
				writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
				const scratch = process.env["LANE_EVIDENCE_DIR"];
				if (scratch)
					copyFileSync(EVIDENCE, join(scratch, "82tn-32-26-goals-live.json"));
				await harness.dispose();
			}
		},
	);
});
