import {
	existsSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

async function retainDeletedSessionRunner(
	activity: "turn" | "prewarm",
	separateProject = false,
) {
	const fixture = ProcessHarness.create();
	harness = fixture;
	writeFileSync(join(fixture.root, "claude-end-session-failure-fixture"), "");
	await fixture.restart();
	let projectKey = separateProject ? "cleanup-project" : "process-test";
	const projectDir = separateProject
		? join(fixture.root, projectKey)
		: fixture.projectDir;
	if (separateProject) {
		mkdirSync(projectDir);
		const saved = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectDir],
		});
		projectKey = saved.savedSlug;
	}
	const browser = await fixture.connect(undefined, undefined, projectKey);
	const sessionId = await browser.createSession("Deleted cleanup replay");
	if (activity === "turn")
		await browser.send(sessionId, "before-cleanup-replay");
	else await browser.preWarmSession(sessionId);
	const runner = await fixture.waitForMark(
		(mark) => mark.kind === "runner-started",
	);
	if (runner?.kind !== "runner-started")
		throw new Error("Missing runner proof");
	const registration = discoverRunners(projectDir, fixture.configDir).find(
		(entry) => entry.sessionId === sessionId,
	);
	if (!registration) throw new Error("Missing persisted runner registration");
	expect(registration.pid).toBe(runner.pid);
	expect(registration.socketPath).toBe(runner.socketPath);
	const providerProcessId = registration.runnerId;
	const store = new Database(fixture.daemonStorePath(), { readonly: true });
	let runIds: string[];
	try {
		runIds = store
			.prepare<[string], { id: string }>(
				"SELECT id FROM provider_runs WHERE session_id = ?",
			)
			.all(sessionId)
			.map(({ id }) => id);
	} finally {
		store.close();
	}
	const failure = join(fixture.root, `fail-end-session-${sessionId}`);
	writeFileSync(failure, "");
	await browser.deleteSession(sessionId);
	expect(existsSync(runner.socketPath)).toBe(true);
	await fixture.kill();
	unlinkSync(failure);
	return {
		fixture,
		projectKey,
		projectDir,
		sessionId,
		runner,
		providerProcessId,
		runIds,
	};
}

// Cleanup can outlive both the session projection and the daemon that admitted it.
it.each([
	"turn",
	"prewarm",
] as const)("replays end_session after its session row is gone (%s)", async (activity) => {
	const { fixture, sessionId, runner, providerProcessId } =
		await retainDeletedSessionRunner(activity);
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
			 ?, 'process-test', ?, 'claude', 'end_session', ?, ?, 'pending', ?, ?)`).run(
			commandId,
			sessionId,
			JSON.stringify({
				type: "end_session",
				commandId,
				sessionId,
				providerProcessId,
				targetProviderId: "claude",
			}),
			providerProcessId,
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
				{
					sessionId,
					runner,
					providerProcessId,
					outcome,
					proof: fixture.proof(),
				},
				null,
				2,
			),
		);
	}
}, 45_000);

it.each([
	"exhausted",
	"ended-cohort",
	"missing-folder",
] as const)("retires a deleted-session runner when its End cannot deliver (%s)", async (scenario) => {
	const {
		fixture,
		projectKey,
		projectDir,
		sessionId,
		runner,
		providerProcessId,
		runIds,
	} = await retainDeletedSessionRunner(
		scenario === "ended-cohort" ? "turn" : "prewarm",
		scenario === "missing-folder",
	);
	const commandId = `orphan-end-${scenario}`;
	const db = new Database(fixture.daemonStorePath());
	try {
		expect(
			db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId),
		).toBeUndefined();
		if (scenario === "ended-cohort") {
			expect(runIds.length).toBeGreaterThan(0);
			expect(
				db
					.prepare("SELECT id FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
			).toEqual([]);
		}
		// Discard the deliberately failed DeleteSession delivery, leaving one replay owner.
		db.prepare(
			"DELETE FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'end_session'",
		).run(sessionId);
		db.prepare(`INSERT INTO provider_command_outbox
			(request_sequence, command_id, project_key, session_id, provider_id, effect_type,
			 payload_json, provider_process_id, status, attempt_count, requested_at, updated_at)
			VALUES ((SELECT COALESCE(MAX(request_sequence), 0) + 1 FROM provider_command_outbox),
			 ?, ?, ?, 'claude', 'end_session', ?, ?, ?, ?, ?, ?)`).run(
			commandId,
			projectKey,
			sessionId,
			JSON.stringify({
				type: "end_session",
				commandId,
				sessionId,
				providerProcessId,
				targetProviderId: "claude",
				...(scenario === "ended-cohort"
					? { retireProcess: true, retireRunIds: runIds }
					: {}),
			}),
			providerProcessId,
			scenario === "exhausted" ? "running" : "pending",
			scenario === "exhausted" ? 5 : 0,
			Date.now(),
			Date.now(),
		);
	} finally {
		db.close();
	}
	const movedProjectDir = `${projectDir}-unavailable`;
	if (scenario === "missing-folder") renameSync(projectDir, movedProjectDir);
	let outcome: unknown;
	const observations: { status: string; elapsedMs: number }[] = [];
	try {
		await fixture.restart({ skipBrowserProbe: true });
		const read = new Database(fixture.daemonStorePath(), { readonly: true });
		const started = performance.now();
		let terminalAt: number | undefined;
		try {
			await vi.waitFor(
				() => {
					const row = read
						.prepare<[string], { status: string; error_code: string | null }>(
							"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
						)
						.get(commandId);
					outcome = row;
					if (row && observations.at(-1)?.status !== row.status)
						observations.push({
							status: row.status,
							elapsedMs: performance.now() - started,
						});
					if (row && ["completed", "failed", "cancelled"].includes(row.status))
						terminalAt ??= performance.now();
					expect(outcome).toMatchObject({
						status:
							scenario === "exhausted"
								? "failed"
								: scenario === "ended-cohort"
									? "completed"
									: "pending",
					});
					expect(() => process.kill(runner.pid, 0)).toThrow();
					expect(existsSync(runner.socketPath)).toBe(false);
					if (terminalAt !== undefined)
						expect(performance.now() - terminalAt).toBeLessThan(5000);
				},
				{ timeout: 35_000, interval: 100 },
			);
			expect(
				read.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId),
			).toBeUndefined();
		} finally {
			read.close();
		}
	} finally {
		if (scenario === "missing-folder") renameSync(movedProjectDir, projectDir);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/intfix-r2-${scenario}.json`,
			JSON.stringify(
				{
					scenario,
					sessionId,
					commandId,
					providerProcessId,
					runner,
					outcome,
					observations,
					socketExists: existsSync(runner.socketPath),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					proof: fixture.proof(),
				},
				null,
				2,
			),
		);
	}
}, 90_000);
