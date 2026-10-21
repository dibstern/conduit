import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

// Cleanup can outlive both the session projection and the daemon that admitted it.
it.each([
	"turn",
	"prewarm",
] as const)("replays end_session after its session row is gone (%s)", async (activity) => {
	const fixture = ProcessHarness.create();
	harness = fixture;
	writeFileSync(join(fixture.root, "claude-end-session-failure-fixture"), "");
	await fixture.restart();
	const browser = await fixture.connect();
	const sessionId = await browser.createSession("Deleted cleanup replay");
	if (activity === "turn")
		await browser.send(sessionId, "before-cleanup-replay");
	else await browser.preWarmSession(sessionId);
	await vi.waitFor(() =>
		expect(fixture.marks.some((mark) => mark.kind === "runner-started")).toBe(
			true,
		),
	);
	const runner = fixture.marks.find((mark) => mark.kind === "runner-started");
	if (runner?.kind !== "runner-started")
		throw new Error("Missing runner proof");
	const failure = join(fixture.root, `fail-end-session-${sessionId}`);
	writeFileSync(failure, "");
	await browser.deleteSession(sessionId);
	expect(existsSync(runner.socketPath)).toBe(true);
	await fixture.kill();
	unlinkSync(failure);
	const db = new Database(fixture.daemonStorePath());
	const commandId = `deleted-cleanup-${activity}`;
	try {
		expect(
			db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId),
		).toBeUndefined();
		// A committed control remains after its session projection is deleted.
		db.prepare(`INSERT INTO provider_command_outbox
			(request_sequence, command_id, project_key, session_id, provider_id, effect_type,
			 payload_json, provider_process_id, status, requested_at, updated_at)
			VALUES ((SELECT COALESCE(MAX(request_sequence), 0) + 1 FROM provider_command_outbox),
			 ?, 'process-test', ?, 'claude', 'end_session', ?, 'cleanup-process', 'pending', ?, ?)`).run(
			commandId,
			sessionId,
			JSON.stringify({
				type: "end_session",
				commandId,
				sessionId,
				providerProcessId: "cleanup-process",
				targetProviderId: "claude",
			}),
			Date.now(),
			Date.now(),
		);
	} finally {
		db.close();
	}
	await fixture.restart();
	const read = new Database(fixture.daemonStorePath(), { readonly: true });
	let outcome: unknown;
	try {
		await vi.waitFor(
			() => {
				outcome = read
					.prepare(
						"SELECT project_key, status, attempt_count, error_code FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(commandId);
				expect(outcome).toMatchObject({
					project_key: "process-test",
					status: "completed",
					error_code: null,
				});
			},
			{ timeout: 10_000 },
		);
		expect(
			read.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId),
		).toBeUndefined();
		await vi.waitFor(
			() => expect(() => process.kill(runner.pid, 0)).toThrow(),
			{ timeout: 5000 },
		);
		expect(existsSync(runner.socketPath)).toBe(false);
	} finally {
		read.close();
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/82tn-10-1-cleanup-replay-${activity}.json`,
			JSON.stringify(
				{ sessionId, runner, outcome, proof: fixture.proof() },
				null,
				2,
			),
		);
	}
}, 45_000);
