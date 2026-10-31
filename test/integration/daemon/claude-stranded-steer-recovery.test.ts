import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const read = (harness: ProcessHarness, sessionId: string, steerId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			steer: db
				.prepare(
					"SELECT state FROM pending_inputs WHERE session_id = ? AND input_id = ?",
				)
				.get(sessionId, steerId) as { state: string } | undefined,
			dispatches: db
				.prepare(
					"SELECT json_extract(data, '$.runnerId') AS runner FROM events WHERE session_id = ? AND type = 'run.dispatched' AND json_extract(data, '$.commandId') = ? ORDER BY sequence",
				)
				.all(sessionId, steerId) as Array<{ runner: string }>,
		};
	} finally {
		db.close();
	}
};

let harness: ProcessHarness | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

it("returns a steer stranded when its runner exits to the inbox instead of running it on a new runner", async () => {
	harness = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		logLevel: "warn",
	});
	await harness.restart();
	const running = harness;
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Served steer");
	void browser.send(sessionId, "upgrade-long-turn").catch(() => undefined);
	await browser.waitFor(
		(message) =>
			message["type"] === "transcript_message" &&
			message["role"] === "assistant" &&
			message["sessionId"] === sessionId,
	);
	const pid = running
		.claudeOptions()
		.filter(({ prompt }) => prompt?.includes("upgrade-long-turn"))
		.at(-1)?.pid;
	if (pid === undefined) throw new Error("Missing prompt consumer PID");
	const runner = await running.waitForMark(
		(mark) =>
			mark.kind === "runner-started" &&
			mark.sessionId === sessionId &&
			mark.pid === pid,
	);
	if (runner?.kind !== "runner-started")
		throw new Error("Missing verified runner PID");
	// A stopped runner never reads the steer, so its journal stays absent.
	process.kill(runner.pid, "SIGSTOP");
	const steerId = randomUUID();
	const result = await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			originId: browser.originId,
			inputId: steerId,
			delivery: "steer",
			text: "steer for a served runner",
		}),
	);
	expect(result.ok).toBe(true);
	await vi.waitFor(
		() => expect(read(running, sessionId, steerId).dispatches).toHaveLength(1),
		{ timeout: 10_000 },
	);
	process.kill(runner.pid, "SIGKILL");
	await browser.preWarmSession(sessionId).catch(() => undefined);
	const freshTurn = () =>
		running
			.claudeOptions()
			.some(
				(option) =>
					option.pid !== runner.pid &&
					option.prompt?.includes("steer for a served runner"),
			);
	// The steer either returns to the inbox or runs as a fresh turn; wait for
	// whichever happens first, then require the inbox.
	await vi.waitFor(
		() =>
			expect(
				freshTurn() ||
					read(running, sessionId, steerId).steer?.state === "queued",
			).toBe(true),
		{ timeout: 15_000 },
	);
	expect(freshTurn()).toBe(false);
	expect(read(running, sessionId, steerId)).toMatchObject({
		steer: { state: "queued" },
		dispatches: [{ runner: expect.any(String) }],
	});
}, 60_000);
