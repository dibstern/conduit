// Failure modes: withheld replay blocks identity recovery and native retirement;
// an identity-only observation suppresses prompt retirement when services return.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
let evidence: Record<string, unknown> = {};

afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	const logTail = fixture.logTail;
	try {
		await fixture.dispose();
		fixture.assertNoRunners();
	} finally {
		const artifact = "test-results/m104-r1-awaiting-project.json";
		const previous = existsSync(artifact)
			? (
					JSON.parse(readFileSync(artifact, "utf8")) as {
						scenarios: { scenario: string }[];
					}
				).scenarios
			: [];
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			artifact,
			JSON.stringify(
				{
					scenarios: [
						...previous.filter(({ scenario }) => scenario !== task.name),
						{
							scenario: task.name,
							result: task.result?.state,
							failures: task.result?.errors?.map(({ message }) => message),
							...evidence,
							logTail,
							cleanup: {
								remainingRunnerPids: fixture.remainingRunnerPids(),
								generations: fixture.generations,
							},
						},
					],
				},
				null,
				2,
			),
		);
		harness = undefined;
	}
});

it("P1: retires an awaiting-project Cursor runner without replay or account restoration", async () => {
	evidence = {};
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		restartProof: true,
		runnerLifecycle: { idleTimeoutMs: null },
	});
	const fixture = harness;
	const gate = join(fixture.root, "cursor-stream-gate");
	const capture = join(fixture.root, "cursor-capture.jsonl");
	writeFileSync(gate, "hold");
	const serviceEnvironment = {
		CURSOR_API_KEY: "",
		CONDUIT_CURSOR_SDK_TRACE: resolve(
			"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
		),
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
		CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
		// Keep the native binding unreleased while the detached stream spools.
		CONDUIT_TEST_CURSOR_WAIT_DELAY_MS: "120000",
	};
	await fixture.restart({ serviceEnvironment });
	const { addedInstanceId: accountId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Withheld Cursor account",
		driver: "cursor",
		env: { CURSOR_API_KEY: "[REDACTED:awaiting-project]" },
	});
	if (!accountId) throw new Error("Missing isolated Cursor account");
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Withheld Cursor output",
		accountId,
		"cursor",
		{ modelId: "composer-2.5", contextWindow: "", permissionMode: "full" },
	);
	void browser.send(sessionId, "Say hello", 90_000).catch(() => {});
	const db = new Database(fixture.daemonStorePath());
	try {
		await vi.waitFor(
			() =>
				expect(readFileSync(capture, "utf8")).toContain('"kind":"run.handle"'),
			{ timeout: 30_000 },
		);
		const runner = discoverRunners(fixture.projectDir, fixture.configDir).find(
			(entry) => entry.sessionId === sessionId,
		);
		if (!runner) throw new Error("Missing retained Cursor runner");
		const cursor = db.prepare<[string], { sequence: number }>(
			"SELECT sequence FROM claude_runner_cursors WHERE runner_id = ?",
		);
		const textEvents = db.prepare<[string], { count: number }>(
			"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'text.delta'",
		);
		await vi.waitFor(() => expect(cursor.get(runner.runnerId)).toBeDefined());
		await fixture.kill();
		const before = {
			cursor: cursor.get(runner.runnerId),
			textEvents: textEvents.get(sessionId),
		};
		unlinkSync(gate);
		await vi.waitFor(
			() =>
				expect(
					readFileSync(`${runner.socketPath}.spool`, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { sequence: number })
						.some(({ sequence }) => sequence > (before.cursor?.sequence ?? 0)),
				).toBe(true),
			{ timeout: 15_000 },
		);
		evidence = {
			sessionId,
			accountId,
			runner,
			before,
			unacknowledgedSpool: readFileSync(`${runner.socketPath}.spool`, "utf8"),
		};
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: config.projects.filter(({ slug }) => slug !== "process-test"),
			}),
		);
		let ready = false;
		const restarting = fixture.restart({ serviceEnvironment }).then(() => {
			ready = true;
		});
		void restarting.catch(() => {});
		await vi.waitFor(
			() =>
				expect(
					ready,
					"Identity-only recovery must finish while project output remains withheld",
				).toBe(true),
			{ timeout: 15_000 },
		);
		await restarting;
		await vi.waitFor(
			() => expect(() => process.kill(runner.pid, 0)).toThrow(),
			{ timeout: 15_000 },
		);
		expect(cursor.get(runner.runnerId)).toEqual(before.cursor);
		expect(textEvents.get(sessionId)).toEqual(before.textEvents);
		expect(fixture.logTail).not.toContain("quarantined");
		evidence["after"] = {
			cursor: cursor.get(runner.runnerId),
			textEvents: textEvents.get(sessionId),
			retiredExactRunner: true,
			commands: db
				.prepare(
					"SELECT effect_type, provider_process_id, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
				)
				.all(sessionId),
		};
	} finally {
		if (existsSync(gate)) unlinkSync(gate);
		evidence["finalCursor"] = db
			.prepare(
				"SELECT runner_id, sequence FROM claude_runner_cursors WHERE runner_id IN (SELECT provider_process_id FROM provider_command_outbox WHERE session_id = ?)",
			)
			.all(sessionId);
		db.close();
	}
}, 90_000);

it("P2: retires stale prompts when an awaiting project's services return", async () => {
	evidence = {};
	harness = await ProcessHarness.start({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		restartProof: true,
		runnerLifecycle: { idleTimeoutMs: null },
	});
	const fixture = harness;
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Prompt retirement after project return",
	);
	await browser.send(sessionId, "seed-completed-owner");
	const runner = discoverRunners(fixture.projectDir, fixture.configDir).find(
		(entry) => entry.sessionId === sessionId,
	);
	if (!runner) throw new Error("Missing retained Claude runner");
	const db = new Database(fixture.daemonStorePath());
	try {
		await fixture.kill();
		for (const type of ["permission", "question"] as const)
			for (const owner of ["old-process", runner.runnerId])
				db.prepare(`INSERT INTO pending_approvals
					(id, session_id, type, status, provider_process_id, provider_request_id, created_at)
					VALUES (?, ?, ?, 'pending', ?, ?, 1)`).run(
					`${owner}-${type}`,
					sessionId,
					type,
					owner,
					`native-${owner}-${type}`,
				);
		const prompts = db.prepare<[string], { id: string; status: string }>(
			"SELECT id, status FROM pending_approvals WHERE session_id = ? ORDER BY id",
		);
		const resolutions = db.prepare<[string], { type: string; id: string }>(
			"SELECT type, json_extract(data, '$.id') AS id FROM events WHERE session_id = ? AND type IN ('permission.resolved', 'question.resolved') ORDER BY type, id",
		);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: config.projects.filter(({ slug }) => slug !== "process-test"),
			}),
		);
		await fixture.restart();
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		expect(
			prompts.all(sessionId).every(({ status }) => status === "pending"),
		).toBe(true);
		expect(resolutions.all(sessionId)).toEqual([]);
		evidence = {
			sessionId,
			runner,
			identityOnlyPrompts: prompts.all(sessionId),
		};
		const registration = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [fixture.projectDir],
		});
		expect(registration.savedSlug).toBe("process-test");
		await fixture.connect(sessionId);
		await vi.waitFor(
			() =>
				expect(
					prompts
						.all(sessionId)
						.filter(({ id }) => id.startsWith("old-process-")),
					"Returning project services must retire prompts from the replaced process",
				).toEqual([
					{ id: "old-process-permission", status: "resolved" },
					{ id: "old-process-question", status: "resolved" },
				]),
			{ timeout: 10_000 },
		);
		const expected = [
			{ type: "permission.resolved", id: "old-process-permission" },
			{ type: "question.resolved", id: "old-process-question" },
		];
		expect(resolutions.all(sessionId)).toEqual(expected);
		expect(
			prompts.all(sessionId).filter(({ id }) => id.startsWith(runner.runnerId)),
		).toEqual([
			{ id: `${runner.runnerId}-permission`, status: "pending" },
			{ id: `${runner.runnerId}-question`, status: "pending" },
		]);
		const extra = join(fixture.root, "extra-folder");
		mkdirSync(extra);
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir, extra],
		});
		await fixture.connect(sessionId);
		expect(resolutions.all(sessionId)).toEqual(expected);
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		evidence["after"] = {
			prompts: prompts.all(sessionId),
			resolutions: resolutions.all(sessionId),
			retainedSameRunner: true,
		};
	} finally {
		evidence["finalPrompts"] = db
			.prepare(
				"SELECT id, status, provider_process_id FROM pending_approvals WHERE session_id = ? ORDER BY id",
			)
			.all(sessionId);
		evidence["finalResolutions"] = db
			.prepare(
				"SELECT type, data FROM events WHERE session_id = ? AND type IN ('permission.resolved', 'question.resolved') ORDER BY sequence",
			)
			.all(sessionId);
		db.close();
	}
}, 90_000);
