// Failure modes: hello deadlines interrupt healthy replay, receipt retries look
// like progress, dead runners strand replay, and replay-settled sinks leak or
// release twice when command waiters also finish. Empty replay must stay usable.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const scenarios: Record<string, unknown>[] = [];
let evidence: Record<string, unknown> = {};

afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	evidence = { ...evidence, logTail: fixture.proof().logTail.slice(-10_000) };
	await fixture.dispose();
	scenarios.push({
		scenario: task.name,
		result: task.result?.state,
		failures: task.result?.errors?.map(({ message }) => message),
		evidence,
		remainingRunners: fixture.remainingRunnerPids(),
	});
	writeFileSync(
		"/tmp/82tn9-5-round5-replay.json",
		JSON.stringify({ scenarios }, null, 2),
	);
	harness = undefined;
});

it.each([
	"progressing",
	"stalled",
	"death-mid-replay",
	"offline-completion",
	"empty-running",
] as const)("recovers Cursor replay (%s)", async (mode) => {
	evidence = { mode };
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		upgradeSinkProof: true,
		runnerLifecycle: { idleTimeoutMs: null },
	});
	const fixture = harness;
	const capture = join(fixture.root, "capture.jsonl");
	const gate = join(fixture.root, "stream.gate");
	writeFileSync(gate, "hold");
	const serviceEnvironment = {
		CURSOR_API_KEY: "",
		CONDUIT_CURSOR_SDK_TRACE: resolve(
			"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
		),
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
		CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
		CONDUIT_TEST_RUNNER_HELLO_WITHOUT_BINDING_RELEASE_STATE: "1",
	};
	await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
	const { addedInstanceId: accountId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Replay owner",
		driver: "cursor",
		env: { CURSOR_API_KEY: "[REDACTED:replay]" },
	});
	if (!accountId) throw new Error("No account allocated");
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Replay owner",
		accountId,
		"cursor",
		{ modelId: "composer-2.5", contextWindow: "", permissionMode: "full" },
	);
	void browser.send(sessionId, "Say hello", 90_000).catch(() => {});
	const db = new Database(fixture.daemonStorePath());
	try {
		const turn = db.prepare<[string], { state: string }>(
			"SELECT state FROM turns WHERE session_id = ?",
		);
		const terminals = db.prepare<[string], { type: string }>(
			"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted') ORDER BY sequence",
		);
		const command = db.prepare<[string], { status: string }>(
			"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
		);
		await vi.waitFor(() => expect(turn.get(sessionId)?.state).toBe("running"), {
			timeout: 30_000,
		});
		await vi.waitFor(() =>
			expect(readFileSync(capture, "utf8")).toContain('"kind":"run.handle"'),
		);
		const runner = fixture.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (runner?.kind !== "runner-started")
			throw new Error("No verified runner");
		await fixture.terminate();
		if (mode === "empty-running") {
			expect(readFileSync(`${runner.socketPath}.spool`, "utf8").trim()).toBe(
				"",
			);
		} else {
			rmSync(gate);
			await vi.waitFor(() =>
				expect(readFileSync(capture, "utf8")).toContain(
					'"kind":"store.disposed"',
				),
			);
			expect(readFileSync(`${runner.socketPath}.spool`, "utf8")).toContain(
				'"type":"turn.completed"',
			);
		}
		const cursor = db.prepare<
			[],
			{ runner_id: string; sequence: number; attachment_id: string }
		>("SELECT runner_id, sequence, attachment_id FROM claude_runner_cursors");
		const before = cursor.get();
		if (!before) throw new Error("No runner cursor");
		const blocked = !["offline-completion", "empty-running"].includes(mode);
		if (blocked) {
			db.exec("CREATE TABLE replay_gate (runner_id TEXT, allowed INTEGER)");
			db.prepare("INSERT INTO replay_gate VALUES (?, ?)").run(
				before.runner_id,
				before.sequence + 1,
			);
			db.exec(`CREATE TRIGGER block_replay BEFORE UPDATE OF sequence ON claude_runner_cursors
				WHEN NEW.runner_id = (SELECT runner_id FROM replay_gate)
				AND NEW.sequence > (SELECT allowed FROM replay_gate)
				BEGIN SELECT RAISE(FAIL, 'replay temporarily unavailable'); END`);
		}
		const markCursor = fixture.marks.length;
		const restarting = fixture.restart({
			startupTimeoutMs: 90_000,
			serviceEnvironment,
		});
		void restarting.catch(() => {});
		try {
			if (blocked) {
				await vi.waitFor(
					() => expect(cursor.get()?.sequence).toBe(before.sequence + 1),
					{ timeout: 15_000 },
				);
				if (mode === "progressing") {
					const progress: {
						elapsedMs: number;
						sequence: number | undefined;
					}[] = [];
					const started = Date.now();
					// More than one inactivity window in total, with real commits in between.
					for (const allowed of [before.sequence + 2, before.sequence + 3]) {
						await setTimeout(16_000);
						db.prepare("UPDATE replay_gate SET allowed = ?").run(allowed);
						await vi.waitFor(
							() => expect(cursor.get()?.sequence).toBe(allowed),
							{ timeout: 5000 },
						);
						progress.push({
							elapsedMs: Date.now() - started,
							sequence: cursor.get()?.sequence,
						});
					}
					evidence = { ...evidence, progress };
				} else if (mode === "stalled") {
					const attachment = cursor.get()?.attachment_id;
					const started = Date.now();
					await vi.waitFor(
						() => expect(cursor.get()?.attachment_id).not.toBe(attachment),
						{ timeout: 35_000 },
					);
					expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
					evidence = {
						...evidence,
						stalledMs: Date.now() - started,
						attachment,
						retryAttachment: cursor.get()?.attachment_id,
					};
				} else {
					process.kill(runner.pid, "SIGKILL");
					await vi.waitFor(() =>
						expect(fixture.remainingRunnerPids()).toEqual([]),
					);
				}
			}
		} finally {
			if (blocked) db.exec("DROP TRIGGER block_replay");
			await restarting;
		}
		const { projects } = await fixture.requestRpc({ _tag: "GetProjects" });
		expect(
			projects.find(({ slug }) => slug === "process-test")?.unavailableReason,
		).toBeUndefined();
		expect(fixture.proof().logTail).not.toContain("Runner handshake timed out");
		if (mode === "empty-running") {
			expect(turn.get(sessionId)?.state).toBe("running");
			expect(command.get(sessionId)?.status).toBe("running");
			expect(terminals.all(sessionId)).toEqual([]);
			rmSync(gate);
		}
		await vi.waitFor(
			() =>
				expect(turn.get(sessionId)?.state).toBe(
					mode === "death-mid-replay" ? "error" : "completed",
				),
			{ timeout: 15_000 },
		);
		expect(terminals.all(sessionId)).toHaveLength(1);
		expect(command.get(sessionId)?.status).toBe(
			mode === "death-mid-replay" ? "failed" : "completed",
		);
		const sinkMarks = () =>
			fixture.marks
				.slice(markCursor)
				.filter(
					(mark) =>
						mark.kind === "runtime-sink" && mark.sessionId === sessionId,
				);
		await vi.waitFor(() =>
			expect(sinkMarks().at(-1)).toMatchObject({
				phase: "released",
				activeSinks: 0,
			}),
		);
		// A second adoption replays no terminal or release and must keep the sink gone.
		await fixture.terminate();
		await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
		const releases = sinkMarks().filter(
			(mark) => mark.kind === "runtime-sink" && mark.phase === "released",
		);
		expect(releases).toHaveLength(1);
		expect(terminals.all(sessionId)).toHaveLength(1);
		evidence = {
			...evidence,
			before,
			after: cursor.get(),
			terminals: terminals.all(sessionId),
			outbox: command.get(sessionId),
			sinkMarks: sinkMarks(),
		};
	} finally {
		if (existsSync(gate)) rmSync(gate);
		db.close();
	}
}, 150_000);
