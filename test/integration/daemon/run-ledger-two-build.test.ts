// Two-build upgrade (82tn.32.14; CONTRACT.md 7.4, SEND-SCOPE-5 S9.6): a daemon built from
// main holds a turn mid-flight, is SIGKILLed, and the current build restarts on its store.
// The old build writes its own legacy rows; nothing is seeded.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proveCrashMatrixCell } from "../../helpers/crash-matrix-cell.js";
import { historicalRunnerBundle } from "../../helpers/historical-runner-bundle.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// main's merge-base for the Run Ledger branch.
const MAIN_COMMIT = "020678548921ff6419796274482a1a9ecc5dfc69";
const TIMEOUT = 120_000;
const CURRENT_DIST = process.env["CONDUIT_TEST_DIST"] ?? "dist";

const query = <T>(
	harness: ProcessHarness,
	sql: string,
	...params: string[]
) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
};

describe("two-build upgrade from main", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.dispose();
	});

	// test-waits-allow timeout-override: a cold cache builds main's tree before the test runs.
	it("keeps a Claude turn main held through SIGKILL and an upgrade, with main's resume marker and steer", async (context) => {
		const historical = await historicalRunnerBundle(MAIN_COMMIT);
		if (!historical.available) context.skip(historical.reason);
		if (!historical.available) return;
		const harness = ProcessHarness.create({
			dist: historical.dist,
			restartProof: true,
		});
		harnesses.push(harness);
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
		});
		// main's session detail feed fails this build's schema (82tn.51 dropped its rewind row),
		// so the browser leaves main's session unviewed and the store shows each turn.
		const browser = await harness.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const sessionId = await browser.createSession(
			"Two-build Claude",
			undefined,
			"claude",
			{ view: false },
		);
		const submit = (text: string, delivery: "queue" | "steer" = "queue") =>
			Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery,
					text,
				}),
			);
		const turnStates = () =>
			query<{ state: string }>(
				harness,
				"SELECT state FROM turns WHERE session_id = ?",
				sessionId,
			).map(({ state }) => state);
		await submit("Say hello");
		// test-waits-allow polling: an unviewed session's turn end reaches only the store.
		await vi.waitFor(() => expect(turnStates()).toEqual(["completed"]), {
			timeout: TIMEOUT,
		});
		// A fresh runner resumes the native session; main falls back from the refusal and
		// marks its command with the old resume marker.
		writeFileSync(
			join(harness.root, "claude", "conduit-test-resume-drops-turn"),
			"",
		);
		for (const pid of harness.runnerPids())
			expect(harness.signalOwnedRunner(pid, "SIGKILL")).toBe(true);
		// test-waits-allow polling: a killed runner reports only through the process table.
		await vi.waitFor(() => expect(harness.remainingRunnerPids()).toEqual([]), {
			timeout: TIMEOUT,
		});
		const prompt = "upgrade-long-turn";
		await submit(prompt);
		await harness.waitForMark(
			(mark) => mark.kind === "assistant-held" && mark.prompt.endsWith(prompt),
		);
		const steerId = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: steerId,
				delivery: "steer",
				text: "Use the steered instruction",
			}),
		);
		// test-waits-allow polling: main's steer row reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					query(
						harness,
						"SELECT state FROM pending_inputs WHERE session_id = ? AND state <> 'removed'",
						sessionId,
					),
				).toEqual([{ state: "steering" }]),
			{ timeout: TIMEOUT },
		);
		expect(
			query(
				harness,
				"SELECT json_extract(payload_json, '$.nativeResumeFallback') AS marker FROM provider_command_outbox WHERE session_id = ? AND status = 'running'",
				sessionId,
			),
		).toContainEqual({ marker: 1 });
		await harness.kill();
		await harness.restart({
			dist: CURRENT_DIST,
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
		});
		await (await harness.connect()).followSession(sessionId);
		// main's runner speaks an older protocol, so the current build retires it: its send is
		// settled and never re-sent (CONTRACT.md 2695, 3051, F39), and main's steer goes back to
		// the inbox front, paused, as main's requeue leaves it (CONTRACT.md 217, row 206).
		// test-waits-allow polling: the retired runner's settle reaches only the store.
		await vi.waitFor(
			() => expect(turnStates()).toEqual(["completed", "error"]),
			{ timeout: TIMEOUT },
		);
		// test-waits-allow polling: the requeued steer reaches only the store's inbox.
		await vi.waitFor(
			() =>
				expect(
					query(
						harness,
						"SELECT input_id, state FROM pending_inputs WHERE session_id = ? AND state <> 'removed'",
						sessionId,
					),
				).toEqual([{ input_id: steerId, state: "queued" }]),
			{ timeout: TIMEOUT },
		);
		expect(
			query(
				harness,
				"SELECT effect_type FROM provider_command_outbox WHERE session_id = ? AND status = 'running'",
				sessionId,
			),
		).toEqual([]);
		expect(
			harness.marks.filter(
				(mark) =>
					mark.kind === "assistant-held" && mark.prompt.endsWith(prompt),
			),
		).toHaveLength(1);
		proveCrashMatrixCell(
			"two-build/claude",
			harness.daemonStorePath(),
			sessionId,
		);
	}, 900_000);
});
