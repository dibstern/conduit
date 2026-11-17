// Two-build upgrade (82tn.32.14, 32.47; CONTRACT.md 7.4, SEND-SCOPE-5 S9.6): a daemon built from
// the ledger build holds a turn mid-flight with a steer, is SIGKILLed, and the current build
// restarts on its store. The old build writes its own rows; nothing is seeded.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proveCrashMatrixCell } from "../../helpers/crash-matrix-cell.js";
import { historicalRunnerBundle } from "../../helpers/historical-runner-bundle.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// The Run Ledger build as it landed on main (82tn.32, 4b2fe6ee).
const LEDGER_COMMIT = "4b2fe6eee9b9d44974e82471857196c8afeee830";
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

describe("two-build upgrade from the ledger build", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.dispose();
	});

	// test-waits-allow timeout-override: a cold cache builds the ledger build's tree before the test runs.
	it("adopts the ledger build's runner mid-turn through SIGKILL and an upgrade, finishing its turn and steer once", async (context) => {
		const historical = await historicalRunnerBundle(LEDGER_COMMIT);
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
		const submit = (
			inputId: string,
			text: string,
			delivery: "queue" | "steer" = "queue",
		) =>
			Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
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
		const prompt = "upgrade-long-turn";
		const promptId = randomUUID();
		await submit(promptId, prompt);
		await harness.waitForMark(
			(mark) => mark.kind === "assistant-held" && mark.prompt.endsWith(prompt),
		);
		const [runner] = harness.runnerPids();
		const steerId = randomUUID();
		await submit(steerId, "Use the steered instruction", "steer");
		// test-waits-allow polling: the ledger build's steer hold reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					query(
						harness,
						"SELECT 1 FROM provider_command_outbox WHERE session_id = ? AND status = 'running'",
						sessionId,
					),
				).toHaveLength(2),
			{ timeout: TIMEOUT },
		);
		await harness.kill();
		await harness.restart({
			dist: CURRENT_DIST,
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
		});
		await (await harness.connect()).followSession(sessionId);
		// The ledger build's runner speaks this build's protocol: this build adopts it, and the
		// held turn and its steer finish there, never re-sent.
		expect(harness.remainingRunnerPids()).toContain(runner);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		// test-waits-allow polling: an unviewed session's turn ends reach only the store.
		await vi.waitFor(
			() => {
				expect(turnStates()).not.toEqual([]);
				expect(turnStates().every((state) => state === "completed")).toBe(true);
				expect(
					query<{ inputId: string }>(
						harness,
						"SELECT input_id AS inputId FROM messages WHERE session_id = ? AND role = 'user' AND input_id IS NOT NULL",
						sessionId,
					)
						.map(({ inputId }) => inputId)
						.sort(),
				).toEqual([promptId, steerId].sort());
			},
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
			[promptId, steerId],
		);
	}, 900_000);
});
