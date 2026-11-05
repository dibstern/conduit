/*
 * 82tn.10 acceptance, for 82tn.10.9: the daemon owns sessions and turns.
 * Failure catalogue entries covered: 15-20 (lane audit).
 * Turns run in two projects at once while one client moves between them and
 * project A's relay is replaced. One engine runs every command, each command
 * is claimed and finished once, and each project's commands run under that
 * project's owner scopes, the same ones before and after the replacement.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
			"user.name=Daemon sessions test",
			"-c",
			"user.email=sessions@example.test",
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

interface EngineCommand {
	readonly kind: string;
	readonly engineIdentity?: number;
	readonly commandId?: string;
	readonly commandType?: string;
	readonly ownerScopes?: {
		readonly projectId: string;
		readonly project: number;
		readonly session: number;
	} | null;
}

const engineRecords = (fixture: ProcessHarness): EngineCommand[] => {
	const path = join(fixture.root, "daemon-engine.ndjson");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as EngineCommand)
		: [];
};

// Count real status transitions, so a second claim or finish cannot hide
// behind one final row.
function countTransitions(path: string) {
	const db = new Database(path);
	try {
		db.exec(`CREATE TABLE engine_claims (command_id TEXT NOT NULL);
			CREATE TABLE engine_terminal_receipts (command_id TEXT NOT NULL);
			CREATE TRIGGER count_engine_claim AFTER UPDATE OF status ON provider_command_outbox
			WHEN NEW.status = 'running' AND OLD.status <> 'running'
			BEGIN INSERT INTO engine_claims VALUES (NEW.command_id); END;
			CREATE TRIGGER count_engine_terminal_receipt AFTER UPDATE OF status ON command_receipts
			WHEN NEW.status IN ('side_effect_completed', 'side_effect_failed') AND OLD.status <> NEW.status
			BEGIN INSERT INTO engine_terminal_receipts VALUES (NEW.command_id); END;`);
	} finally {
		db.close();
	}
}

function ledger(path: string, sessionIds: readonly string[]) {
	const db = new Database(path, { readonly: true });
	try {
		const commands = db
			.prepare(
				`SELECT command.command_id, command.session_id, command.project_key,
				command.effect_type, command.status,
				(SELECT COUNT(*) FROM engine_claims WHERE command_id = command.command_id) AS claims,
				receipt.status AS receipt_status,
				(SELECT COUNT(*) FROM engine_terminal_receipts WHERE command_id = command.command_id) AS terminal_receipts
				FROM provider_command_outbox command
				LEFT JOIN command_receipts receipt ON receipt.command_id = command.command_id
				WHERE command.session_id IN (?, ?) ORDER BY command.request_sequence`,
			)
			.all(...sessionIds) as Array<{
			command_id: string;
			session_id: string;
			project_key: string;
			effect_type: string;
			status: string;
			claims: number;
			receipt_status: string | null;
			terminal_receipts: number;
		}>;
		const sessions = Object.fromEntries(
			sessionIds.map((sessionId) => [
				sessionId,
				{
					queued: (
						db
							.prepare(
								"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued'",
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
				},
			]),
		);
		const rows = db
			.prepare("SELECT id, project_id FROM sessions WHERE id IN (?, ?)")
			.all(...sessionIds);
		return { commands, sessions, rows };
	} finally {
		db.close();
	}
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("daemon-owned sessions and turns (82tn.10.9)", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const logs = fixture.logTail;
		const runnerPids = fixture.runnerPids();
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-10-sessions-turns.json",
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.9",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...evidence,
						...(task.result?.errors?.length ? { logs } : {}),
						runnerPids,
						remainingRunnerPids: fixture.remainingRunnerPids(),
						cleanup: fixture.proof(),
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	it("runs both projects' turns on one engine, each command once, under its project's owner scopes", async () => {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		evidence = { scenario: "two-projects-navigate-relay-replace" };
		const fixture = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
			logLevel: "info",
		});
		harness = fixture;
		const serverLog = join(fixture.root, "server.log");
		writeFileSync(serverLog, "");
		writeFileSync(join(fixture.root, "daemon-engine-proof"), "");
		const projectB = join(fixture.root, "project-b");
		seedRepository(fixture.projectDir);
		seedRepository(projectB);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
			logFile: serverLog,
		});
		countTransitions(fixture.daemonStorePath());
		const saved = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		const create = async (projectSlug: string, title: string) =>
			(
				await fixture.requestRpc({
					_tag: "CreateSession",
					projectSlug,
					originId: "daemon-sessions-turns",
					providerId: "claude",
					model: { providerId: "claude", modelId: "sonnet" },
					permissionMode: "ask",
					title,
				})
			).sessionId;
		const sessionA = await create("process-test", "Turn in project A");
		const sessionB = await create(saved.savedSlug, "Turn in project B");
		const projects = {
			[sessionA]: "process-test",
			[sessionB]: saved.savedSlug,
		};

		// One client starts A's turn, moves to B, starts B's turn, and moves back.
		const browser = await fixture.connect(sessionA, undefined, "process-test");
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
		await browser.view(sessionA);
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
		}

		// Project A's relay is replaced while both turns run.
		const extra = join(fixture.root, "added-folder");
		mkdirSync(extra);
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir, extra],
		});
		await browser.close();
		const reconnectedA = await fixture.connect(
			sessionA,
			undefined,
			"process-test",
		);
		await reconnectedA.view(sessionA);
		const reconnectedB = await fixture.connect(
			sessionB,
			undefined,
			saved.savedSlug,
		);

		writeFileSync(join(fixture.root, "release-tool-long"), "release");
		for (const [connection, sessionId] of [
			[reconnectedA, sessionA],
			[reconnectedB, sessionB],
		] as const)
			await connection.waitForTurnEnd(
				sessionId,
				0,
				undefined,
				queued.get(sessionId),
			);

		const { commands, sessions, rows } = ledger(fixture.daemonStorePath(), [
			sessionA,
			sessionB,
		]);
		const dispatched = engineRecords(fixture).filter(
			(record) => record.kind === "engine-command",
		);
		const engineIdentities = [
			...new Set(dispatched.map((record) => record.engineIdentity)),
		];
		const ownerScopes = Object.fromEntries(
			[sessionA, sessionB].map((sessionId) => {
				const ids = new Set(
					commands
						.filter((command) => command.session_id === sessionId)
						.map((command) => command.command_id),
				);
				const ran = dispatched.filter(
					(record) => record.commandId && ids.has(record.commandId),
				);
				return [
					projects[sessionId],
					{
						sessionId,
						commands: ran.map((record) => ({
							commandId: record.commandId,
							commandType: record.commandType,
							ownerScopes: record.ownerScopes,
						})),
						projectScopes: [
							...new Set(ran.map((record) => record.ownerScopes?.project)),
						],
						sessionScopes: [
							...new Set(ran.map((record) => record.ownerScopes?.session)),
						],
					},
				];
			}),
		);
		const log = readFileSync(serverLog, "utf8");
		const interrupted = count(log, "Turn dispatch interrupted");
		evidence = {
			...evidence,
			sessions: { a: sessionA, b: sessionB },
			engineIdentities,
			claimsPerCommand: Object.fromEntries(
				commands.map((command) => [command.command_id, command.claims]),
			),
			receipts: commands,
			turnOutcomes: sessions,
			queued: Object.fromEntries(queued),
			ownerScopes,
			dispatchInterruptions: interrupted,
			sessionRows: rows,
		};

		expect(engineIdentities, "one engine runs every command").toHaveLength(1);
		const sends = commands.filter(
			(command) => command.effect_type === "send_turn",
		);
		expect(sends.length, "two turns per session").toBe(4);
		for (const command of commands) {
			expect(command.claims, `${command.command_id} claimed once`).toBe(1);
			expect(
				command.terminal_receipts,
				`${command.command_id} finished once`,
			).toBe(1);
			expect(command.project_key).toBe(projects[command.session_id]);
		}
		const a = ownerScopes["process-test"];
		const b = ownerScopes[saved.savedSlug];
		for (const project of [a, b]) {
			expect(project?.commands.length).toBeGreaterThan(0);
			for (const command of project?.commands ?? [])
				expect(command.ownerScopes?.projectId).toBe(
					projects[project?.sessionId ?? ""],
				);
			expect(project?.projectScopes, "one project scope").toHaveLength(1);
			expect(project?.sessionScopes, "one session scope").toHaveLength(1);
		}
		expect(a?.projectScopes[0]).not.toBe(b?.projectScopes[0]);
		for (const [id, state] of Object.entries(sessions)) {
			expect(state.queued).toEqual([]);
			expect(state.turns).toEqual(["completed", "completed"]);
			expect(
				state.sent.filter((input) => input === queued.get(id)),
				`${id} sent its queued input once`,
			).toHaveLength(1);
		}
		expect(interrupted, "no turn's dispatch was interrupted").toBe(0);
	});
});
