/*
 * 82tn.10.7 acceptance: the daemon owns running turns.
 * Failure catalogue entries covered: 1-7, 10 (lane audit).
 * A turn in each of two projects runs while one client moves between the
 * projects and project A's relay is replaced. Neither turn is interrupted,
 * the daemon runs exactly one continuation sweep, and each session's queued
 * input is sent once.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];

function seedRepository(directory: string): void {
	mkdirSync(directory, { recursive: true });
	for (const args of [
		["init", "-b", "main", directory],
		[
			"-C",
			directory,
			"-c",
			"user.name=Daemon turns test",
			"-c",
			"user.email=turns@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Fixture",
		],
	])
		execFileSync("git", args, { env: gitEnv, stdio: "pipe" });
}

function ledger(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			queued: (
				db
					.prepare(
						"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at",
					)
					.all(sessionId) as Array<{ input_id: string }>
			).map((row) => row.input_id),
			sent: (
				db
					.prepare(
						"SELECT json_extract(data, '$.inputId') AS input_id FROM events WHERE session_id = ? AND type = 'input.sent' ORDER BY sequence",
					)
					.all(sessionId) as Array<{ input_id: string }>
			).map((row) => row.input_id),
			turns: (
				db
					.prepare(
						"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
					)
					.all(sessionId) as Array<{ state: string }>
			).map((row) => row.state),
		};
	} finally {
		db.close();
	}
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("daemon-owned turns (82tn.10.7)", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const logs = fixture.logTail;
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-10-7-daemon-turns-${evidence["scenario"]}.json`,
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.7",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...evidence,
						...(task.result?.errors?.length ? { logs } : {}),
						cleanup: fixture.proof(),
						remainingRunnerPids: fixture.remainingRunnerPids(),
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	it("keeps both projects' turns through a project switch and a relay replacement", async () => {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		evidence = { scenario: "two-projects-relay-replace" };
		const fixture = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
			continuationSweepIntervalMs: 200,
			logLevel: "info",
		});
		harness = fixture;
		const serverLog = join(fixture.root, "server.log");
		writeFileSync(serverLog, "");
		writeFileSync(join(fixture.root, "daemon-adapters-proof"), "");
		const projectB = join(fixture.root, "project-b");
		seedRepository(fixture.projectDir);
		seedRepository(projectB);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
			logFile: serverLog,
		});
		const saved = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		const create = async (projectSlug: string, title: string) =>
			(
				await fixture.requestRpc({
					_tag: "CreateSession",
					projectSlug,
					originId: "daemon-turns",
					providerId: "claude",
					model: { providerId: "claude", modelId: "sonnet" },
					permissionMode: "ask",
					title,
				})
			).sessionId;
		const sessionA = await create("process-test", "Turn in project A");
		const sessionB = await create(saved.savedSlug, "Turn in project B");

		// One client starts A's turn, moves to B and starts B's turn there.
		const browser = await fixture.connect(sessionA, undefined, "process-test");
		// A relay replacement ends that relay's browser streams (browser routing
		// is 82tn.13), so the sends are not awaited; the ledger is the evidence.
		void browser
			.send(sessionA, "tool-long-project-a", 90_000)
			.catch(() => undefined);
		await fixture.waitForMark(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionA,
		);
		await browser.view(sessionB);
		void browser
			.send(sessionB, "tool-long-project-b", 90_000)
			.catch(() => undefined);
		await fixture.waitForMark(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionB,
		);
		for (const sessionId of [sessionA, sessionB])
			await browser.waitFor(
				(message) =>
					message["type"] === "transcript_message" &&
					message["sessionId"] === sessionId &&
					JSON.stringify(message["parts"]).includes('"status":"running"'),
			);

		// A second input waits behind each running turn.
		const queued = new Map<string, string>();
		for (const sessionId of [sessionA, sessionB]) {
			const inputId = randomUUID();
			queued.set(sessionId, inputId);
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
					delivery: "queue",
					text: `queued behind ${sessionId}`,
				}),
			);
			// The submit answers once the admission is durable.
			expect(ledger(fixture, sessionId).queued).toEqual([inputId]);
		}

		// Project A's relay is replaced while both turns run.
		const extra = join(fixture.root, "added-folder");
		mkdirSync(extra);
		expect(
			(
				await fixture.requestRpc({
					_tag: "SaveProject",
					slug: "process-test",
					folders: [fixture.projectDir, extra],
				})
			).savedSlug,
		).toBe("process-test");
		// The client reconnects to A, and a fresh connection attaches to B.
		await browser.close();
		const reconnectedA = await fixture.connect(
			sessionA,
			undefined,
			"process-test",
		);
		await reconnectedA.view(sessionA);
		const reconnected = await fixture.connect(
			sessionB,
			undefined,
			saved.savedSlug,
		);

		writeFileSync(join(fixture.root, "release-tool-long"), "release");
		for (const [connection, sessionId] of [
			[reconnectedA, sessionA],
			[reconnected, sessionB],
		] as const)
			await connection.waitForTurnEnd(
				sessionId,
				0,
				undefined,
				queued.get(sessionId),
			);
		const final = Object.fromEntries(
			[sessionA, sessionB].map((id) => [id, ledger(fixture, id)]),
		);
		for (const [id, state] of Object.entries(final)) {
			expect(state.queued).toEqual([]);
			expect(state.turns).toEqual(["completed", "completed"]);
			expect(
				state.sent.filter((input) => input === queued.get(id)),
				`${id} sent its queued input once`,
			).toHaveLength(1);
		}
		expect(
			(await reconnected.history(sessionB)).length,
			"a fresh connection reads B's finished turns",
		).toBeGreaterThan(0);

		const log = readFileSync(serverLog, "utf8");
		const sweeps = count(log, "Continuation sweep started");
		const interrupted = count(log, "Turn dispatch interrupted");
		evidence = {
			...evidence,
			sessions: { a: sessionA, b: sessionB },
			queued: Object.fromEntries(queued),
			ledger: final,
			sweepFibersStarted: sweeps,
			dispatchInterruptions: interrupted,
		};
		expect(sweeps, "exactly one continuation sweep in the daemon").toBe(1);
		expect(interrupted, "no turn's dispatch was interrupted").toBe(0);
	});
});
