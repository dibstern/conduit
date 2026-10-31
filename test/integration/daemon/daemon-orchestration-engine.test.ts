import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { DurableCommandCommitRepository } from "../../../src/lib/provider/orchestration-command-commit.js";
import { decideDurableSendTurnCommand } from "../../../src/lib/provider/orchestration-decider.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface Observation {
	daemonPid: number;
	kind: string;
	engineIdentity?: number;
	commandId?: string;
	driver?: string;
	projectId?: string;
	sessionIds?: string[];
}

interface CommandOutcome {
	command_id: string;
	project_key: string;
	status: string;
	error_code: string | null;
	attempt_count: number;
	claim_count: number;
	receipt_count: number;
	receipt_status: string;
	receipt_error_code: string | null;
	terminal_receipt_count: number;
}

// Public seams: isolated daemon process, browser RPC, and its durable command
// ledger. Count real status transitions so duplicate claims cannot hide behind
// one final outbox row. Failure modes include a second project engine/drain,
// replacement disposal cancelling shared work, and retained project heads
// blocking commands for a live project.
describe("one daemon orchestration engine", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];

	const observations = (fixture: ProcessHarness): Observation[] => {
		const path = join(fixture.root, "daemon-engine.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Observation)
			: [];
	};
	const sdkRows = (fixture: ProcessHarness) => {
		const path = join(fixture.root, "sdk-proof.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { kind: string; request?: string })
			: [];
	};

	function prepare(
		holdRunnerAck?: "place-user-message",
		managedOpenCode = false,
	) {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			managedOpenCode,
			runnerLifecycle: { idleTimeoutMs: null },
			...(holdRunnerAck ? { holdRunnerAck } : {}),
		});
		harness = fixture;
		evidence = {};
		writeFileSync(join(fixture.root, "daemon-engine-proof"), "");
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					{
						path: fixture.projectDir,
						folders: [fixture.projectDir],
						slug: "process-test",
						addedAt: 1,
					},
					{
						path: projectB,
						folders: [projectB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			} satisfies DaemonConfig),
		);
		return fixture;
	}

	function countTransitions(db: Database.Database) {
		db.exec(`CREATE TABLE engine_claims (command_id TEXT NOT NULL);
			CREATE TABLE engine_terminal_receipts (command_id TEXT NOT NULL);
			CREATE TRIGGER count_engine_claim AFTER UPDATE OF status ON provider_command_outbox
			WHEN NEW.status = 'running' AND OLD.status <> 'running'
			BEGIN INSERT INTO engine_claims VALUES (NEW.command_id); END;
			CREATE TRIGGER count_engine_terminal_receipt AFTER UPDATE OF status ON command_receipts
			WHEN NEW.status IN ('side_effect_completed', 'side_effect_failed') AND OLD.status <> NEW.status
			BEGIN INSERT INTO engine_terminal_receipts VALUES (NEW.command_id); END;`);
	}

	function outcomes(db: Database.Database, commandIds: string[]) {
		const query = db.prepare<
			[string],
			CommandOutcome
		>(`SELECT command.command_id,
			command.project_key, command.status, command.error_code, command.attempt_count,
			(SELECT COUNT(*) FROM engine_claims WHERE command_id = command.command_id) AS claim_count,
			(SELECT COUNT(*) FROM command_receipts WHERE command_id = command.command_id) AS receipt_count,
			receipt.status AS receipt_status, receipt.error_code AS receipt_error_code,
			(SELECT COUNT(*) FROM engine_terminal_receipts WHERE command_id = command.command_id) AS terminal_receipt_count
			FROM provider_command_outbox command JOIN command_receipts receipt
			ON receipt.command_id = command.command_id WHERE command.command_id = ?`);
		return commandIds.map((id) => query.get(id));
	}

	async function submit(
		browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
		sessionId: string,
		text: string,
	) {
		const inputId = randomUUID();
		const result = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text,
			}),
		);
		expect(result.ok).toBe(true);
		return inputId;
	}

	async function completed(
		db: Database.Database,
		ids: string[],
		timeout = 20_000,
	) {
		await vi.waitFor(
			() => {
				for (const row of outcomes(db, ids))
					expect(row).toMatchObject({
						status: "completed",
						error_code: null,
						attempt_count: 1,
						claim_count: 1,
						receipt_count: 1,
						receipt_status: "side_effect_completed",
						terminal_receipt_count: 1,
					});
			},
			{ timeout },
		);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const rows = observations(fixture);
		if (task.result?.errors?.length) {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				evidence["failureLedger"] = db
					.prepare(
						"SELECT command_id, project_key, session_id, effect_type, status, attempt_count, provider_process_id, error_code FROM provider_command_outbox ORDER BY request_sequence",
					)
					.all();
				evidence["failureSdk"] = sdkRows(fixture);
				evidence["failureLog"] = fixture.logTail;
			} finally {
				db.close();
			}
		}
		await fixture.dispose();
		fixture.assertNoRunners();
		scenarios.push({
			scenario: task.name,
			result: task.result?.state,
			failures: task.result?.errors?.map(({ message }) => message),
			observations: rows,
			...evidence,
			cleanup: {
				remainingRunnerPids: fixture.remainingRunnerPids(),
				generations: fixture.generations,
			},
		});
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-10-4-daemon-engine.json",
			JSON.stringify({ bead: "conduit-test-82tn.10.4", scenarios }, null, 2),
		);
		if (task.name.startsWith("round 15:"))
			writeFileSync(
				"test-results/82tn-10-4-round15-e2e.json",
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.4",
						scenarios: scenarios.filter(({ scenario }) =>
							String(scenario).startsWith("round 15:"),
						),
					},
					null,
					2,
				),
			);
		if (task.name.startsWith("hands off detached intake ownership"))
			writeFileSync(
				"test-results/82tn-10-4-round14-handoff.json",
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.4",
						scenarios: scenarios.filter(({ scenario }) =>
							String(scenario).startsWith(
								"hands off detached intake ownership",
							),
						),
					},
					null,
					2,
				),
			);
		harness = undefined;
	});

	it("shares the engine across projects, relay replacement, and runtime registration", async () => {
		const fixture = prepare();
		await fixture.restart();
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionA = await a.createSession("Daemon engine project A");
		const sessionB = await b.createSession("Daemon engine project B");
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			const commands = await Promise.all([
				submit(a, sessionA, "Daemon sends in project A"),
				submit(b, sessionB, "Daemon sends in project B"),
			]);
			await completed(db, commands);
			const initialRows = observations(fixture);
			evidence = { initialCommands: outcomes(db, commands) };
			expect(
				initialRows.filter(({ kind }) => kind === "engine-observed"),
			).toHaveLength(1);
			expect(
				initialRows.filter(({ kind }) => kind === "engine-constructed"),
			).toHaveLength(1);
			expect(
				initialRows.filter(({ kind }) => kind === "engine-drain-started"),
			).toHaveLength(1);
			const firstDrain = initialRows.findIndex(
				({ kind }) => kind === "outbox-drain",
			);
			expect(firstDrain).toBeGreaterThan(-1);
			expect(
				initialRows
					.slice(0, firstDrain)
					.filter(({ kind }) => kind === "recovery-end"),
			).toHaveLength(3);
			const extra = join(fixture.root, "added-folder");
			mkdirSync(extra);
			const heldId = await submit(
				a,
				sessionA,
				"tool-long-replace-daemon-engine",
			);
			await vi.waitFor(() =>
				expect(outcomes(db, [heldId])[0]).toMatchObject({ status: "running" }),
			);
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(
							({ kind, request }) =>
								kind === "enqueue" &&
								request === "tool-long-replace-daemon-engine",
						),
					).toBe(true),
				{ timeout: 15_000 },
			);
			await fixture.requestRpc({
				_tag: "SaveProject",
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			});
			const replacement = await fixture.connect(sessionA);
			const stopId = randomUUID();
			const stop = fixture.requestRpc({
				_tag: "CancelSession",
				sessionId: sessionA,
				commandId: stopId,
			});
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(({ kind }) => kind === "query-interrupted"),
					).toBe(true),
				{ timeout: 5_000 },
			);
			writeFileSync(join(fixture.root, "release-tool-long"), "release");
			await stop;
			await vi.waitFor(() =>
				expect(outcomes(db, [heldId])[0]).toMatchObject({
					claim_count: 1,
					receipt_count: 1,
					terminal_receipt_count: 1,
				}),
			);
			commands.push(
				await submit(replacement, sessionA, "After relay replacement"),
			);
			const projectC = join(fixture.root, "project-c");
			mkdirSync(projectC);
			const registered = await fixture.requestRpc({
				_tag: "SaveProject",
				folders: [projectC],
			});
			const c = await fixture.connect(
				undefined,
				undefined,
				registered.savedSlug,
			);
			const sessionC = await c.createSession("Runtime project C");
			db.exec(`CREATE TRIGGER hold_runtime_send BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.session_id = '${sessionC}' AND NEW.effect_type = 'send_turn' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			const runtimeId = await submit(c, sessionC, "Runtime project drained");
			commands.push(runtimeId);
			await vi.waitFor(() =>
				expect(outcomes(db, [runtimeId])[0]).toMatchObject({
					status: "pending",
					claim_count: 0,
				}),
			);
			db.exec("DROP TRIGGER hold_runtime_send");
			await completed(db, commands);
			const finalRows = observations(fixture);
			expect(
				finalRows.filter(({ kind }) => kind === "engine-observed"),
			).toHaveLength(1);
			expect(
				finalRows.filter(({ kind }) => kind === "engine-drain-started"),
			).toHaveLength(1);
			expect(
				new Set(
					finalRows
						.filter(({ kind }) => kind === "outbox-drain")
						.map(({ engineIdentity }) => engineIdentity),
				),
			).toEqual(
				new Set([
					initialRows.find(({ kind }) => kind === "engine-observed")
						?.engineIdentity,
				]),
			);
			expect(outcomes(db, commands).map((row) => row?.project_key)).toEqual([
				"process-test",
				"project-b",
				"process-test",
				registered.savedSlug,
			]);
			evidence = {
				...evidence,
				commands: outcomes(db, commands),
				replacedWhileRunning: outcomes(db, [heldId, stopId]),
				runtimeProject: registered.savedSlug,
				replacementReusedEngine: true,
			};
		} finally {
			db.close();
		}
	}, 90_000);

	// A recommit retains the command's attempts but reserves a new, unclaimed run.
	// Neither a removed nor an unavailable project may leave that reservation live.
	it.each([
		"removed",
		"unavailable",
	] as const)("settles unclaimed retries across providers with project %s", async (projectState) => {
		const fixture = prepare();
		await fixture.restart();
		await fixture.kill();
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const repository = new DurableCommandCommitRepository(sql, "project-b");
				let sequence = 100;
				for (const driver of ["opencode", "claude", "cursor"] as const) {
					const sessionId = `retry-${driver}`;
					yield* commit([
						canonicalEvent("session.created", sessionId, {
							sessionId,
							provider: driver,
							title: "Retry before intake",
						}),
					]);
					const reserve = () =>
						commit.write((project) =>
							repository
								.commit(
									decideDurableSendTurnCommand({
										commandId: sessionId,
										sessionId,
										providerId: driver,
										fingerprintHash: "retry-fixture",
										nowMs: Date.now(),
										requestSequence: sequence++,
										events: [],
										payloadJson: JSON.stringify({
											sessionId,
											inputId: sessionId,
											prompt: "Retry before intake",
											workspaceRoot: join(fixture.root, "project-b"),
											extraFolders: [],
											providerState: {},
										}),
									}),
								)
								.pipe(Effect.flatMap(project)),
						);
					yield* reserve();
					yield* sql`UPDATE provider_command_outbox SET status = 'failed', attempt_count = 1 WHERE command_id = ${sessionId}`;
					yield* sql`UPDATE provider_runs SET status = 'error', completed_at = 2 WHERE session_id = ${sessionId}`;
					yield* reserve();
				}
			}).pipe(
				Effect.provide(
					makePersistenceEffectLayer(fixture.daemonStorePath(), "project-b"),
				),
			),
		);
		const db = new Database(fixture.daemonStorePath());
		try {
			const reservations = () =>
				db
					.prepare(`SELECT command.provider_id, command.status,
				command.attempt_count, run.status AS run_status, run.started_at,
				receipt.status AS receipt_status, command.error_code,
				(SELECT COUNT(*) FROM events WHERE type = 'turn.error'
					AND json_extract(metadata, '$.runId') = run.id) AS errors
				FROM provider_command_outbox command JOIN provider_runs run ON run.id = command.run_id
				JOIN command_receipts receipt ON receipt.command_id = command.command_id
				WHERE command.request_sequence IN (101, 103, 105) ORDER BY command.request_sequence`)
					.all();
			expect(reservations()).toEqual(
				["opencode", "claude", "cursor"].map((driver) => ({
					provider_id: driver,
					status: "pending",
					attempt_count: 1,
					run_status: "pending",
					started_at: null,
					receipt_status: "side_effect_requested",
					error_code: null,
					errors: 0,
				})),
			);
			evidence["unclaimedRetries"] = reservations();
			if (projectState === "removed") {
				const configPath = join(fixture.configDir, "daemon.json");
				const config = JSON.parse(
					readFileSync(configPath, "utf8"),
				) as DaemonConfig;
				writeFileSync(
					configPath,
					JSON.stringify({
						...config,
						projects: config.projects.filter(
							({ slug }) => slug !== "project-b",
						),
					}),
				);
			} else {
				mkdirSync(join(fixture.root, "project-b", ".conduit"), {
					recursive: true,
				});
				writeFileSync(
					join(fixture.root, "project-b", ".conduit", "events.db"),
					"fixture corrupt history",
				);
			}
			await fixture.restart({
				serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
			});
			await vi.waitFor(
				() =>
					expect(reservations()).toEqual(
						["opencode", "claude", "cursor"].map((driver) => ({
							provider_id: driver,
							status: projectState === "removed" ? "cancelled" : "failed",
							attempt_count: 1,
							run_status: "error",
							started_at: null,
							receipt_status: "side_effect_failed",
							errors: 1,
							error_code:
								projectState === "removed"
									? "project_inactive"
									: "project_unavailable",
						})),
					),
				{ timeout: 5000 },
			);
			const settled = reservations();
			const sweeps = observations(fixture).filter(
				({ kind }) => kind === "outbox-drain",
			).length;
			await vi.waitFor(() =>
				expect(
					observations(fixture).filter(({ kind }) => kind === "outbox-drain")
						.length,
				).toBeGreaterThan(sweeps + 2),
			);
			expect(reservations()).toEqual(settled);
			await fixture.kill();
			await fixture.restart();
			expect(reservations()).toEqual(settled);
			evidence["settledRetriesAfterRestart"] = settled;
		} finally {
			db.close();
		}
	}, 90_000);

	// Placement is durable before run.started, but the surviving runner already
	// owns intake. Projection lag must not authorize a synthetic turn terminal.
	it.each([
		"removed",
		"unavailable",
	] as const)("recovers claimed intake before run.started with project %s", async (projectState) => {
		const fixture = prepare("place-user-message");
		await fixture.restart();
		const browser = await fixture.connect(undefined, undefined, "project-b");
		const sessionId = await browser.createSession(
			"Claimed intake before start",
		);
		const db = new Database(fixture.daemonStorePath());
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		const legacy = join(fixture.root, "project-b", ".conduit", "events.db");
		try {
			countTransitions(db);
			const id = await submit(browser, sessionId, "upgrade-long-turn");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT id FROM messages WHERE session_id = ? AND role = 'user'",
							)
							.get(sessionId),
					).toBeDefined(),
				{ timeout: 10_000 },
			);
			const run = db
				.prepare<
					[string],
					{ id: string; status: string; started_at: number | null }
				>(`SELECT run.id, run.status, run.started_at FROM provider_runs run
				JOIN provider_command_outbox command ON command.run_id = run.id WHERE command.command_id = ?`)
				.get(id);
			expect(run).toMatchObject({ status: "pending", started_at: null });
			const terminals = () =>
				db
					.prepare<
						[string],
						{ type: string; code: string | null }
					>(`SELECT type, json_extract(data, '$.code') AS code FROM events
				WHERE session_id = ? AND json_extract(metadata, '$.runId') = '${run?.id}' AND type IN ('turn.error', 'turn.completed', 'turn.cancelled', 'turn.interrupted') ORDER BY sequence`)
					.all(sessionId);
			const runner = await fixture.waitForMark(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			if (runner.kind !== "runner-started")
				throw new Error("Missing fixture runner");
			await fixture.kill();
			expect(() => process.kill(runner.pid, 0)).not.toThrow();
			evidence["beforeRecovery"] = {
				run,
				commands: outcomes(db, [id]),
				terminals: terminals(),
			};
			if (projectState === "removed")
				writeFileSync(
					configPath,
					JSON.stringify({
						...config,
						projects: config.projects.filter(
							({ slug }) => slug !== "project-b",
						),
					}),
				);
			else {
				mkdirSync(join(fixture.root, "project-b", ".conduit"), {
					recursive: true,
				});
				writeFileSync(legacy, "fixture corrupt history");
			}
			const restart = () =>
				fixture.restart({
					serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
				});
			await restart();
			await vi.waitFor(
				() =>
					expect(
						observations(fixture).filter(
							({ daemonPid, kind }) =>
								daemonPid === fixture.generations.at(-1)?.pid &&
								kind === "outbox-drain",
						).length,
					).toBeGreaterThan(2),
				{ timeout: 10_000 },
			);
			await vi.waitFor(
				() =>
					expect(outcomes(db, [id])[0]).toMatchObject(
						projectState === "removed"
							? {
									status: "cancelled",
									error_code: "project_inactive",
									receipt_status: "side_effect_failed",
									terminal_receipt_count: 1,
								}
							: {
									status: "running",
									receipt_status: "side_effect_requested",
									terminal_receipt_count: 0,
								},
					),
				{ timeout: 15_000 },
			);
			expect(terminals()).toEqual([]);
			if (projectState === "removed")
				await vi.waitFor(
					() => expect(() => process.kill(runner.pid, 0)).toThrow(),
					{ timeout: 10_000 },
				);
			else expect(() => process.kill(runner.pid, 0)).not.toThrow();
			const refused = outcomes(db, [id]);
			await fixture.kill();
			await restart();
			expect(outcomes(db, [id])).toEqual(refused);
			expect(terminals()).toEqual([]);
			evidence["afterSweepReplay"] = {
				commands: refused,
				terminals: terminals(),
				runnerPid: runner.pid,
				runnerRetired: projectState === "removed",
			};
			await fixture.kill();
			writeFileSync(configPath, JSON.stringify(config));
			if (projectState === "unavailable") unlinkSync(legacy);
			await restart();
			const restored = await fixture.connect(sessionId, undefined, "project-b");
			writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
			await vi.waitFor(() => expect(terminals()).toHaveLength(1), {
				timeout: 15_000,
			});
			expect(terminals()[0]?.type).toBe(
				projectState === "removed" ? "turn.error" : "turn.completed",
			);
			expect(outcomes(db, [id])[0]).toMatchObject({
				claim_count: 1,
				receipt_count: 1,
				terminal_receipt_count: 1,
			});
			if (projectState === "unavailable") await completed(db, [id]);
			expect(
				(await restored.history(sessionId))
					.filter(({ role }) => role === "user")
					.map(({ text }) => text),
			).toEqual(["upgrade-long-turn"]);
			expect(terminals()).toHaveLength(1);
			evidence["afterProjectRecovery"] = {
				commands: outcomes(db, [id]),
				terminals: terminals(),
				sdk: sdkRows(fixture),
			};
		} finally {
			db.close();
		}
	}, 90_000);

	it.each([
		{ projectState: "removed", started: false },
		{ projectState: "unavailable", started: false },
		{ projectState: "removed", started: true },
		{ projectState: "unavailable", started: true },
	])("settles retained running sends after crash with project $projectState (started=$started)", async ({
		projectState,
		started,
	}) => {
		const fixture = prepare();
		await fixture.restart();
		const browser = await fixture.connect(undefined, undefined, "project-b");
		const sessionId = await browser.createSession("Retained claim after crash");
		let db = new Database(fixture.daemonStorePath());
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		const legacy = join(fixture.root, "project-b", ".conduit", "events.db");
		const prompt = started
			? "upgrade-long-turn"
			: "Claimed but never delivered";
		try {
			countTransitions(db);
			if (!started)
				db.exec(`CREATE TRIGGER hold_retained_send BEFORE UPDATE OF status ON provider_command_outbox
					WHEN NEW.session_id = '${sessionId}' AND NEW.status = 'running'
					BEGIN SELECT RAISE(IGNORE); END`);
			const id = await submit(browser, sessionId, prompt);
			if (started) {
				await fixture.waitForMark((mark) => mark.kind === "assistant-held");
				await vi.waitFor(() =>
					expect(outcomes(db, [id])[0]).toMatchObject({ status: "running" }),
				);
			}
			const laterId = await submit(
				browser,
				sessionId,
				"Later send in same session",
			);
			await fixture.kill();
			if (!started) {
				const gate = join(fixture.root, "hold-claimed-account");
				writeFileSync(gate, id);
				db.exec("DROP TRIGGER hold_retained_send");
				await fixture.restart();
				await vi.waitFor(() =>
					expect(
						observations(fixture).some(
							({ kind }) => kind === "claimed-account-gap",
						),
					).toBe(true),
				);
				await fixture.kill();
				unlinkSync(gate);
			} else {
				const runner = await fixture.waitForMark(
					(mark) =>
						mark.kind === "runner-started" && mark.sessionId === sessionId,
				);
				if (runner.kind !== "runner-started")
					throw new Error("Missing fixture runner");
				process.kill(runner.pid, "SIGKILL");
				await vi.waitFor(() =>
					expect(() => process.kill(runner.pid, 0)).toThrow(),
				);
			}
			// Queue admission normally waits to materialize this send. Reproduce
			// the retained outbox head from the review through the real commit seam.
			const laterPayload = db
				.prepare<[string, string, string], { payload: string }>(
					"SELECT json_set(payload_json, '$.inputId', ?, '$.prompt', ?) AS payload FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(laterId, "Later send in same session", id);
			if (!laterPayload) throw new Error("Missing retained send payload");
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const write = yield* makeCommitAndSignal;
					const [next] = yield* sql<{
						sequence: number;
					}>`SELECT MAX(request_sequence) + 1 AS sequence FROM provider_command_outbox`;
					if (!next)
						return yield* Effect.fail(new Error("Missing outbox sequence"));
					yield* write.write((project) =>
						new DurableCommandCommitRepository(sql, "project-b")
							.commit({
								receipt: {
									commandId: laterId,
									commandType: "send_turn",
									sessionId,
									status: "side_effect_requested",
									fingerprintHash: "retained-send-fixture",
									fingerprintVersion: 2,
									createdAt: Date.now(),
									updatedAt: Date.now(),
								},
								outboxRequests: [
									{
										requestSequence: next.sequence,
										commandId: laterId,
										sessionId,
										providerId: "claude",
										effectType: "send_turn",
										payloadJson: laterPayload.payload,
									},
								],
								readModelRows: [],
								events: [
									canonicalEvent(
										"input.sent",
										sessionId,
										{ sessionId, inputId: laterId },
										{ provider: "claude" },
									),
								],
							})
							.pipe(Effect.flatMap(project)),
					);
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(fixture.daemonStorePath(), "project-b"),
					),
				),
			);
			db.close();
			db = new Database(fixture.daemonStorePath());
			const run = db
				.prepare<
					[string],
					{
						id: string;
						status: string;
						started_at: number | null;
						joined_into: string | null;
					}
				>(
					`SELECT run.id, run.status, run.started_at, run.joined_into FROM provider_runs run
				JOIN provider_command_outbox command ON command.run_id = run.id WHERE command.command_id = ?`,
				)
				.get(id);
			expect(run).toMatchObject(
				started
					? { status: "running", started_at: expect.any(Number) }
					: { status: "pending", started_at: null, joined_into: null },
			);
			expect(outcomes(db, [id, laterId])).toMatchObject([
				{
					status: "running",
					attempt_count: 1,
					claim_count: 1,
					terminal_receipt_count: 0,
				},
				{
					status: "pending",
					attempt_count: 0,
					claim_count: 0,
					terminal_receipt_count: 0,
				},
			]);
			const terminalEvents = () =>
				db
					.prepare<[string], { type: string; run_id: string | null }>(
						`SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events
				WHERE session_id = ? AND type IN ('turn.error', 'turn.completed', 'turn.cancelled', 'turn.interrupted') ORDER BY sequence`,
					)
					.all(sessionId);
			expect(terminalEvents()).toEqual([]);
			evidence["beforeCrashRecovery"] = {
				run,
				commands: outcomes(db, [id, laterId]),
			};
			if (projectState === "removed")
				writeFileSync(
					configPath,
					JSON.stringify({
						...config,
						projects: config.projects.filter(
							({ slug }) => slug !== "project-b",
						),
					}),
				);
			else {
				mkdirSync(join(fixture.root, "project-b", ".conduit"), {
					recursive: true,
				});
				writeFileSync(legacy, "fixture corrupt history");
			}
			const restart = () =>
				fixture.restart({
					serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
				});
			await restart();
			const code =
				projectState === "removed" ? "project_inactive" : "project_unavailable";
			const status = projectState === "removed" ? "cancelled" : "failed";
			const retainedForRecovery = started && projectState === "unavailable";
			await vi.waitFor(
				() => {
					expect(outcomes(db, [id])[0]).toMatchObject(
						retainedForRecovery
							? {
									status: "running",
									receipt_status: "side_effect_requested",
									terminal_receipt_count: 0,
								}
							: {
									status,
									error_code: code,
									receipt_status: "side_effect_failed",
									receipt_error_code: code,
									terminal_receipt_count: 1,
								},
					);
					expect(outcomes(db, [laterId])[0]).toMatchObject({
						status,
						error_code: code,
						receipt_status: "side_effect_failed",
						terminal_receipt_count: 1,
					});
				},
				{ timeout: 10_000 },
			);
			// The started run belongs to provider recovery. Only unstarted inputs
			// receive a failed prompt and turn.error from the project sweep.
			const terminals = terminalEvents();
			expect(terminals).toHaveLength(started ? 1 : 2);
			expect(terminals.every(({ type }) => type === "turn.error")).toBe(true);
			if (started)
				expect(terminals.some(({ run_id }) => run_id === run?.id)).toBe(false);
			expect(
				db
					.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
					.get(laterId),
			).toEqual({ state: "removed" });
			const refused = outcomes(db, [id, laterId]);
			const sweepCount = observations(fixture).filter(
				({ kind }) => kind === "outbox-drain",
			).length;
			await vi.waitFor(() =>
				expect(
					observations(fixture).filter(({ kind }) => kind === "outbox-drain")
						.length,
				).toBeGreaterThan(sweepCount + 2),
			);
			expect(outcomes(db, [id, laterId])).toEqual(refused);
			expect(terminalEvents()).toEqual(terminals);
			await fixture.kill();
			await restart();
			expect(outcomes(db, [id, laterId])).toEqual(refused);
			expect(terminalEvents()).toEqual(terminals);
			evidence["afterRefusalAndSecondRestart"] = {
				commands: refused,
				terminals,
			};
			await fixture.kill();
			writeFileSync(configPath, JSON.stringify(config));
			if (projectState === "unavailable") unlinkSync(legacy);
			await restart();
			const repaired = await fixture.connect(sessionId, undefined, "project-b");
			const history = await repaired.history(sessionId);
			expect(
				history.filter(({ role }) => role === "user").map(({ text }) => text),
			).toEqual([prompt, "Later send in same session"]);
			await completed(db, [
				await submit(repaired, sessionId, "Fresh send after project recovery"),
			]);
			expect(outcomes(db, [id])[0]).toMatchObject({
				terminal_receipt_count: 1,
				claim_count: 1,
				receipt_count: 1,
			});
			expect(outcomes(db, [laterId])[0]).toMatchObject({
				terminal_receipt_count: 1,
				claim_count: 0,
				receipt_count: 1,
			});
			evidence["afterProjectRecovery"] = outcomes(db, [id, laterId]);
		} finally {
			db.close();
		}
	}, 90_000);

	it.each([
		"attach",
		"restart",
		"remove",
	] as const)("keeps commands pending during a relay gap until %s", async (finish) => {
		const fixture = prepare();
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionA = await a.createSession("Pending during replacement");
		const sessionB = await b.createSession("Other project during replacement");
		const controlSessionB = await b.createSession(
			"Shared process queue during replacement",
		);
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			db.exec(`CREATE TRIGGER hold_gap_send BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.session_id = '${sessionA}' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			const pending = await submit(
				a,
				sessionA,
				"Prompt accepted before replacement",
			);
			await vi.waitFor(() =>
				expect(outcomes(db, [pending])[0]).toMatchObject({
					status: "pending",
					claim_count: 0,
				}),
			);
			const gate = join(fixture.root, "hold-relay-process-test");
			writeFileSync(gate, "");
			const extra = join(fixture.root, "replacement-folder");
			mkdirSync(extra);
			if (finish === "remove")
				writeFileSync(join(fixture.root, "detach-relay"), "process-test");
			const save =
				finish === "remove"
					? Promise.resolve()
					: fixture
							.requestRpc({
								_tag: "SaveProject",
								slug: "process-test",
								folders: [fixture.projectDir, extra],
							})
							.catch((error: unknown) => String(error));
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(({ kind }) => kind === "relay-gap"),
				).toBe(true),
			);
			const controlIds = [randomUUID(), randomUUID()];
			db.transaction(() => {
				for (const [index, id] of controlIds.entries()) {
					const project = index === 0 ? "process-test" : "project-b";
					const session = index === 0 ? sessionA : controlSessionB;
					db.prepare(
						"INSERT INTO command_receipts (command_id, project_key, session_id, status, created_at) VALUES (?, ?, ?, 'side_effect_requested', 1)",
					).run(id, project, session);
					db.prepare(`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at)
						VALUES (?, ?, ?, ?, 'opencode', 'interrupt_turn', ?, 'gap-shared-process', 'pending', 1, 1)`).run(
						index - 2,
						id,
						project,
						session,
						JSON.stringify({
							type: "interrupt_turn",
							sessionId: session,
							providerProcessId: "gap-shared-process",
						}),
					);
				}
			})();
			db.exec("DROP TRIGGER hold_gap_send");
			const other = await submit(
				b,
				sessionB,
				"Other project still drains during replacement",
			);
			await completed(db, [other]);
			const sweeps = observations(fixture).filter(
				({ kind }) => kind === "outbox-drain",
			).length;
			await vi.waitFor(() =>
				expect(
					observations(fixture).filter(({ kind }) => kind === "outbox-drain")
						.length,
				).toBeGreaterThan(sweeps + 2),
			);
			expect(outcomes(db, [pending])[0]).toMatchObject({
				status: "pending",
				attempt_count: 0,
				claim_count: 0,
				receipt_status: "side_effect_requested",
				terminal_receipt_count: 0,
			});
			for (const row of outcomes(db, controlIds))
				expect(row).toMatchObject({
					status: "pending",
					attempt_count: 0,
					claim_count: 0,
					terminal_receipt_count: 0,
				});
			evidence["duringGap"] = outcomes(db, [pending, other]);
			evidence["processFifoDuringGap"] = outcomes(db, controlIds);
			if (finish === "restart") {
				await fixture.kill();
				unlinkSync(gate);
				await save;
				await fixture.restart();
			} else if (finish === "remove") {
				await fixture.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
				await vi.waitFor(() =>
					expect(outcomes(db, [pending])[0]).toMatchObject({
						status: "cancelled",
						error_code: "project_inactive",
						attempt_count: 0,
						claim_count: 0,
						terminal_receipt_count: 1,
					}),
				);
				await vi.waitFor(() =>
					expect(outcomes(db, [controlIds[1] ?? ""])[0]).toMatchObject({
						status: "cancelled",
						error_code: "provider_process_gone",
						claim_count: 1,
						terminal_receipt_count: 1,
					}),
				);
				await fixture.requestRpc({ _tag: "RemoveProject", slug: "project-b" });
				unlinkSync(gate);
				await save;
				await fixture.kill();
				await fixture.restart();
				expect(
					(await fixture.requestRpc({ _tag: "GetProjects" })).projects,
				).toEqual([]);
			} else {
				unlinkSync(gate);
				await save;
			}
			if (finish !== "remove") await completed(db, [pending]);
			else
				expect(outcomes(db, [pending])[0]).toMatchObject({
					terminal_receipt_count: 1,
					claim_count: 0,
				});
			evidence["afterGap"] = outcomes(db, [pending, other]);
			await vi.waitFor(() => {
				for (const [index, row] of outcomes(db, controlIds).entries()) {
					expect(row).toMatchObject({
						status: "cancelled",
						error_code:
							finish === "remove" && index === 0
								? "project_inactive"
								: "provider_process_gone",
						terminal_receipt_count: 1,
					});
					expect(row?.claim_count).toBeLessThanOrEqual(1);
					expect(row?.attempt_count).toBe(row?.claim_count);
				}
			});
			evidence["processFifoAfterGap"] = outcomes(db, controlIds);
		} finally {
			db.close();
		}
	}, 90_000);

	// Removal interrupts lazy attachment. Re-adding must retry, while a later
	// genuine attachment failure must still make the project unavailable.
	it.each([
		"healthy",
		"failure",
	] as const)("retries interrupted lazy attachment before %s recovery", async (outcome) => {
		const fixture = prepare();
		await fixture.restart();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Interrupted attachment");
		const gate = join(fixture.root, "hold-attachment");
		const fail = join(fixture.root, "fail-attachment");
		try {
			for (let round = 0; round < 2; round++) {
				await fixture.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
				const saved = await fixture.requestRpc({
					_tag: "SaveProject",
					folders: [fixture.projectDir],
				});
				expect(saved.savedSlug).toBe("process-test");
				expect(
					saved.projects.find(({ slug }) => slug === "process-test")
						?.unavailableReason,
				).toBeUndefined();
				const entered = observations(fixture).filter(
					({ kind }) => kind === "attachment-gap",
				).length;
				writeFileSync(gate, sessionId);
				const connecting = fixture
					.connect(sessionId)
					.catch((error: unknown) => String(error));
				await vi.waitFor(
					() =>
						expect(
							observations(fixture).filter(
								({ kind }) => kind === "attachment-gap",
							).length,
						).toBeGreaterThan(entered),
					{ timeout: 10_000 },
				);
				await fixture.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
				expect(await connecting).toEqual(
					expect.stringContaining("invalidated"),
				);
				unlinkSync(gate);
			}
			const saved = await fixture.requestRpc({
				_tag: "SaveProject",
				folders: [fixture.projectDir],
			});
			evidence["afterAttachmentInterrupts"] = saved;
			expect(
				saved.projects.find(({ slug }) => slug === "process-test")
					?.unavailableReason,
			).toBeUndefined();
			if (outcome === "failure") {
				const entered = observations(fixture).filter(
					({ kind }) => kind === "attachment-gap",
				).length;
				writeFileSync(gate, sessionId);
				writeFileSync(fail, "");
				const connecting = fixture
					.connect(sessionId)
					.catch((error: unknown) => String(error));
				await vi.waitFor(
					() =>
						expect(
							observations(fixture).filter(
								({ kind }) => kind === "attachment-gap",
							).length,
						).toBeGreaterThan(entered),
					{ timeout: 10_000 },
				);
				unlinkSync(gate);
				expect(await connecting).toEqual(
					expect.stringContaining("Fixture attachment failure"),
				);
				const projects = await fixture.requestRpc({ _tag: "GetProjects" });
				evidence["afterGenuineAttachmentFailure"] = projects;
				expect(
					projects.projects.find(({ slug }) => slug === "process-test")
						?.unavailableReason,
				).toBe("Provider attachment recovery failed");
			} else {
				const restored = await fixture.connect(sessionId);
				const db = new Database(fixture.daemonStorePath());
				try {
					countTransitions(db);
					const id = await submit(
						restored,
						sessionId,
						"Send after interrupted attachment",
					);
					await completed(db, [id]);
					evidence["afterAttachmentRetrySend"] = outcomes(db, [id]);
				} finally {
					db.close();
				}
			}
		} finally {
			for (const path of [gate, fail]) if (existsSync(path)) unlinkSync(path);
		}
	}, 90_000);

	// Recovery snapshots before this gate. New claims must wait until it finishes,
	// including repeated replacements; a failed attachment must not strand work.
	it.each([
		"twice",
		"failure",
	] as const)("withholds claims during attachment recovery: %s", async (replacement) => {
		const fixture = prepare();
		await fixture.restart({
			// Cold fixture module loading under load is outside the attachment fence.
			runnerStartupTimeoutMs: 30_000,
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Attachment claim fence");
		const db = new Database(fixture.daemonStorePath());
		const gate = join(fixture.root, "hold-attachment");
		const accountGate = join(fixture.root, "hold-claimed-account");
		const accountEntered = join(fixture.root, "claimed-account-entered");
		try {
			countTransitions(db);
			for (let round = 0; round < (replacement === "twice" ? 2 : 1); round++) {
				if (existsSync(accountEntered)) unlinkSync(accountEntered);
				db.exec(`CREATE TRIGGER hold_attachment_send BEFORE UPDATE OF status ON provider_command_outbox
					WHEN NEW.session_id = '${sessionId}' AND NEW.status = 'running'
					BEGIN SELECT RAISE(IGNORE); END`);
				const prompt = `Retained pending prompt ${round}`;
				const id = await submit(
					await fixture.connect(sessionId),
					sessionId,
					prompt,
				);
				await vi.waitFor(() =>
					expect(outcomes(db, [id])[0]).toMatchObject({
						status: "pending",
						attempt_count: 0,
					}),
				);
				writeFileSync(gate, sessionId);
				writeFileSync(accountGate, id);
				if (replacement === "failure")
					writeFileSync(join(fixture.root, "fail-attachment"), "");
				const extra = join(fixture.root, `attachment-folder-${round}`);
				mkdirSync(extra);
				const entered = observations(fixture).filter(
					({ kind }) => kind === "attachment-gap",
				).length;
				const saving = fixture
					.requestRpc({
						_tag: "SaveProject",
						slug: "process-test",
						folders: [fixture.projectDir, extra],
					})
					.catch((error: unknown) => String(error));
				await vi.waitFor(
					() =>
						expect(
							observations(fixture).filter(
								({ kind }) => kind === "attachment-gap",
							).length,
						).toBeGreaterThan(entered),
					{ timeout: 10_000 },
				);
				db.exec("DROP TRIGGER hold_attachment_send");
				const sweeps = observations(fixture).filter(
					({ kind }) => kind === "outbox-drain",
				).length;
				await vi.waitFor(() =>
					expect(
						observations(fixture).filter(({ kind }) => kind === "outbox-drain")
							.length,
					).toBeGreaterThan(sweeps + 2),
				);
				const during = outcomes(db, [id]);
				// Release both gates even on a regression, so teardown never waits on us.
				unlinkSync(gate);
				await saving;
				if (replacement === "twice" && during[0]?.status === "running")
					await vi.waitFor(() =>
						expect(outcomes(db, [id])[0]).toMatchObject({
							status: "failed",
							error_code: "runner_stopped",
						}),
					);
				else if (replacement === "twice")
					await vi.waitFor(
						() => expect(existsSync(accountEntered)).toBe(true),
						{
							timeout: 10_000,
						},
					);
				const afterRecovery = outcomes(db, [id]);
				unlinkSync(accountGate);
				evidence[`attachment-${round}`] = { during, afterRecovery };
				expect(during[0]).toMatchObject({
					status: "pending",
					attempt_count: 0,
					claim_count: 0,
				});
				if (replacement === "failure") {
					await vi.waitFor(
						() =>
							expect(outcomes(db, [id])[0]).toMatchObject({
								status: "failed",
								error_code: "project_unavailable",
								attempt_count: 0,
							}),
						{ timeout: 10_000 },
					);
				} else {
					await completed(db, [id], 45_000);
					expect(
						db
							.prepare(
								"SELECT text FROM messages WHERE session_id = ? AND role = 'user' AND text = ?",
							)
							.all(sessionId, prompt),
					).toHaveLength(1);
					expect(
						sdkRows(fixture).filter(
							({ kind, request }) => kind === "enqueue" && request === prompt,
						),
					).toHaveLength(1);
				}
				evidence[`attachment-${round}`] = {
					during,
					afterRecovery,
					after: outcomes(db, [id]),
					prompt,
					history: db
						.prepare("SELECT role, text FROM messages WHERE session_id = ?")
						.all(sessionId),
				};
			}
		} finally {
			for (const path of [gate, accountGate])
				if (existsSync(path)) unlinkSync(path);
			db.close();
		}
	}, 90_000);

	it.each([
		"registration before release",
		"release before registration",
	] as const)("hands off detached intake ownership: %s", async (order) => {
		const fixture = prepare();
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Detached intake handoff");
		const db = new Database(fixture.daemonStorePath());
		const detachmentGate = join(fixture.root, "hold-detachment-error");
		const registrationGate = join(fixture.root, "hold-relay-process-test");
		let save: Promise<unknown> | undefined;
		try {
			countTransitions(db);
			const prompt = "relay-replacement-before-intake";
			const id = await submit(browser, sessionId, prompt);
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(({ kind }) => kind === "intake-held"),
					).toBe(true),
				{ timeout: 45_000 },
			);
			const runnerPids = fixture.runnerPids();
			expect(runnerPids).toHaveLength(1);
			writeFileSync(detachmentGate, "");
			// Repeat the recovery call after attachment to verify its idempotence.
			writeFileSync(join(fixture.root, "repeat-attachment"), "");
			if (order === "release before registration")
				writeFileSync(registrationGate, "");
			const extra = join(fixture.root, "handoff-folder");
			mkdirSync(extra);
			save = fixture
				.requestRpc({
					_tag: "SaveProject",
					slug: "process-test",
					folders: [fixture.projectDir, extra],
				})
				.catch((error: unknown) => error);
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(
						({ kind }) => kind === "detachment-error-gap",
					),
				).toBe(true),
			);
			if (order === "registration before release") {
				expect(await save).toMatchObject({ savedSlug: "process-test" });
				await fixture.connect(sessionId);
				expect(
					observations(fixture).filter(
						({ kind, commandId }) =>
							kind === "pending-send-owner" && commandId === id,
					),
				).toContainEqual(expect.objectContaining({ owned: true }));
			}
			unlinkSync(detachmentGate);
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(
						({ kind }) => kind === "detachment-error-released",
					),
				).toBe(true),
			);
			if (order === "release before registration") {
				unlinkSync(registrationGate);
				expect(await save).toMatchObject({ savedSlug: "process-test" });
				await fixture.connect(sessionId);
				expect(
					observations(fixture).filter(
						({ kind, commandId }) =>
							kind === "pending-send-owner" && commandId === id,
					),
				).toContainEqual(expect.objectContaining({ owned: false }));
			}
			expect(fixture.remainingRunnerPids()).toEqual(runnerPids);
			writeFileSync(join(fixture.root, "release-stop-intake"), "");
			await completed(db, [id]);
			const drains = observations(fixture).filter(
				({ kind }) => kind === "outbox-drain",
			).length;
			await vi.waitFor(() =>
				expect(
					observations(fixture).filter(({ kind }) => kind === "outbox-drain")
						.length,
				).toBeGreaterThanOrEqual(drains + 3),
			);
			const starts = db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? AND type = 'run.started'",
				)
				.all(sessionId);
			expect(starts).toEqual([{ type: "run.started" }]);
			expect(
				db
					.prepare(
						"SELECT started_at FROM provider_runs WHERE id = (SELECT run_id FROM provider_command_outbox WHERE command_id = ?)",
					)
					.get(id),
			).toMatchObject({ started_at: expect.any(Number) });
			expect(
				sdkRows(fixture).filter(
					({ kind, request }) => kind === "enqueue" && request === prompt,
				),
			).toHaveLength(1);
			expect(
				observations(fixture).filter(
					({ kind, driver, sessionIds }) =>
						kind === "attachment" &&
						driver === "claude" &&
						sessionIds?.includes(sessionId),
				),
			).toHaveLength(1);
			expect(
				observations(fixture).filter(
					({ kind, driver, sessionIds }) =>
						kind === "attachment-repeated" &&
						driver === "claude" &&
						sessionIds?.includes(sessionId),
				),
			).toHaveLength(1);
			evidence["handoff"] = {
				order,
				command: outcomes(db, [id]),
				starts,
				runnerPids,
			};
		} finally {
			for (const gate of [detachmentGate, registrationGate])
				if (existsSync(gate)) unlinkSync(gate);
			writeFileSync(join(fixture.root, "release-stop-intake"), "");
			await save?.catch(() => undefined);
			db.close();
		}
	}, 120_000);

	// Reuse review14-handoff's detachment/attachment gates. Once attachment
	// fails, unavailable-project recovery must own the claim and other work must
	// still drain. A live runner retains provider truth until restart reattaches.
	it("round 15: recovers failed detached attachment through project unavailability", async () => {
		const fixture = prepare();
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Failed handoff attachment");
		const db = new Database(fixture.daemonStorePath());
		const detachment = join(fixture.root, "hold-detachment-error");
		const attachment = join(fixture.root, "hold-attachment");
		const failure = join(fixture.root, "fail-attachment");
		try {
			countTransitions(db);
			const id = await submit(
				browser,
				sessionId,
				"relay-replacement-before-intake",
			);
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(({ kind }) => kind === "intake-held"),
					).toBe(true),
				{ timeout: 45_000 },
			);
			writeFileSync(detachment, "");
			const extra = join(fixture.root, "failed-handoff-folder");
			mkdirSync(extra);
			await fixture.requestRpc({
				_tag: "SaveProject",
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			});
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(
						({ kind }) => kind === "detachment-error-gap",
					),
				).toBe(true),
			);
			await fixture.connect(sessionId);
			writeFileSync(attachment, sessionId);
			writeFileSync(failure, "");
			unlinkSync(detachment);
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(({ kind }) => kind === "attachment-gap"),
				).toBe(true),
			);
			unlinkSync(attachment);
			await vi.waitFor(
				async () => {
					const projects = await fixture.requestRpc({ _tag: "GetProjects" });
					expect(
						projects.projects.find(({ slug }) => slug === "process-test")
							?.unavailableReason,
					).toBe("Provider attachment recovery failed");
				},
				{ timeout: 10_000 },
			);
			const drains = observations(fixture).filter(
				({ kind }) => kind === "outbox-drain",
			).length;
			await vi.waitFor(() =>
				expect(
					observations(fixture).filter(({ kind }) => kind === "outbox-drain")
						.length,
				).toBeGreaterThanOrEqual(drains + 3),
			);
			// A ready sibling still executes while the unavailable project's live
			// runner retains its command. No attachment retry owner is introduced.
			const sibling = await fixture.connect(undefined, undefined, "project-b");
			const siblingSession = await sibling.createSession(
				"Sibling after failed attachment",
			);
			const siblingId = await submit(
				sibling,
				siblingSession,
				"Sibling still drains",
			);
			await completed(db, [siblingId]);
			evidence["unavailableClaim"] = outcomes(db, [id]);
			expect(outcomes(db, [id])[0]).toMatchObject({
				status: "running",
				claim_count: 1,
				terminal_receipt_count: 0,
			});
			expect(
				observations(fixture).filter(
					({ kind, sessionIds }) =>
						kind === "attachment" && sessionIds?.includes(sessionId),
				),
			).toHaveLength(1);
			unlinkSync(failure);
			writeFileSync(join(fixture.root, "release-stop-intake"), "");
			await fixture.kill();
			await fixture.restart({
				serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
			});
			await fixture.connect(sessionId);
			await completed(db, [id]);
			evidence["recoveredClaim"] = outcomes(db, [id]);
			evidence["siblingCommand"] = outcomes(db, [siblingId]);
			expect(
				(await fixture.requestRpc({ _tag: "GetProjects" })).projects.find(
					({ slug }) => slug === "process-test",
				)?.unavailableReason,
			).toBeUndefined();
		} finally {
			for (const gate of [detachment, attachment, failure])
				if (existsSync(gate)) unlinkSync(gate);
			writeFileSync(join(fixture.root, "release-stop-intake"), "");
			db.close();
		}
	}, 120_000);

	// Reuse review14-sinks' clock advance. The old relay's sweep is disposed;
	// only registration in the replacement relay can expire this permission.
	it("round 15: times out foreground approval on the current relay after replacement", async () => {
		const fixture = prepare();
		const clockFile = join(fixture.root, "advance-clock");
		const clockModule = join(fixture.root, "clock.mjs");
		writeFileSync(
			clockModule,
			`import { existsSync } from 'node:fs';
const now = Date.now;
Date.now = () => now() + (existsSync(new URL('./advance-clock', import.meta.url)) ? 360000 : 0);
`,
		);
		await fixture.restart({
			serviceEnvironment: {
				CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30",
				NODE_OPTIONS: `--import=${pathToFileURL(clockModule).href}`,
			},
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Approval after relay replacement",
		);
		const gate = join(fixture.root, "hold-provider-intake");
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			writeFileSync(gate, sessionId);
			const id = await submit(
				browser,
				sessionId,
				"approval-stale-after-replacement",
			);
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(
						({ kind }) => kind === "provider-intake-gap",
					),
				).toBe(true),
			);
			const extra = join(fixture.root, "approval-replacement-folder");
			mkdirSync(extra);
			await fixture.requestRpc({
				_tag: "SaveProject",
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			});
			const current = await fixture.connect(sessionId);
			unlinkSync(gate);
			const approval = db.prepare<
				[string],
				{ status: string; resolved_at: number | null }
			>(
				"SELECT status, resolved_at FROM pending_approvals WHERE session_id = ?",
			);
			await vi.waitFor(
				() => expect(approval.get(sessionId)?.status).toBe("pending"),
				{ timeout: 30_000 },
			);
			const controlSession = await current.createSession(
				"Current relay approval control",
			);
			const controlId = await submit(
				current,
				controlSession,
				"approval-current-control",
			);
			await vi.waitFor(
				() => expect(approval.get(controlSession)?.status).toBe("pending"),
				{ timeout: 30_000 },
			);
			evidence["beforeClock"] = [
				approval.get(sessionId),
				approval.get(controlSession),
			];
			// Detaching a waiter must mark the sink that owns that request, so
			// replacement preserves both approvals for the new relay's sweep.
			const pendingExtra = join(fixture.root, "pending-approval-folder");
			mkdirSync(pendingExtra);
			await fixture.requestRpc({
				_tag: "SaveProject",
				slug: "process-test",
				folders: [fixture.projectDir, extra, pendingExtra],
			});
			await fixture.connect(sessionId);
			expect(approval.get(sessionId)?.status).toBe("pending");
			expect(approval.get(controlSession)?.status).toBe("pending");
			writeFileSync(clockFile, "");
			await vi.waitFor(
				() => {
					expect(approval.get(controlSession)).toMatchObject({
						status: "resolved",
						resolved_at: expect.any(Number),
					});
					expect(approval.get(sessionId)).toMatchObject({
						status: "resolved",
						resolved_at: expect.any(Number),
					});
				},
				{ timeout: 40_000, interval: 100 },
			);
			await completed(db, [id, controlId]);
			const resolutions = db
				.prepare(
					"SELECT session_id, json_extract(metadata, '$.source') AS source FROM events WHERE type = 'permission.resolved' AND session_id IN (?, ?)",
				)
				.all(sessionId, controlSession);
			expect(resolutions).toHaveLength(2);
			expect(resolutions).toEqual(
				expect.arrayContaining([
					{ session_id: sessionId, source: "permission-timeout" },
					{ session_id: controlSession, source: "permission-timeout" },
				]),
			);
			evidence["afterClock"] = [
				approval.get(sessionId),
				approval.get(controlSession),
			];
			evidence["resolutions"] = resolutions;
			evidence["commands"] = outcomes(db, [id, controlId]);
		} finally {
			if (existsSync(gate)) unlinkSync(gate);
			db.close();
		}
	}, 120_000);

	it("preserves a live runner send when relay replacement precedes native intake", async () => {
		const fixture = prepare();
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Runner held before intake");
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			const id = await submit(
				browser,
				sessionId,
				"load-stream-stop-before-intake",
			);
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(({ kind }) => kind === "intake-held"),
					).toBe(true),
				{ timeout: 15_000 },
			);
			const runnerPids = fixture.runnerPids();
			expect(runnerPids).toHaveLength(1);
			expect(
				db
					.prepare(
						"SELECT started_at FROM provider_runs WHERE id = (SELECT run_id FROM provider_command_outbox WHERE command_id = ?)",
					)
					.get(id),
			).toEqual({ started_at: null });
			const extra = join(fixture.root, "before-native-intake");
			mkdirSync(extra);
			await fixture.requestRpc({
				_tag: "SaveProject",
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			});
			await fixture.connect(sessionId);
			expect(fixture.remainingRunnerPids()).toEqual(runnerPids);
			evidence["runnerHeldAfterReplacement"] = outcomes(db, [id]);
			expect(outcomes(db, [id])[0]).toMatchObject({
				status: "running",
				error_code: null,
				attempt_count: 1,
				claim_count: 1,
				terminal_receipt_count: 0,
			});
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type = 'turn.error'",
					)
					.all(sessionId),
			).toEqual([]);
			writeFileSync(join(fixture.root, "release-stop-intake"), "release");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT started_at FROM provider_runs WHERE id = (SELECT run_id FROM provider_command_outbox WHERE command_id = ?)",
							)
							.get(id),
					).toMatchObject({ started_at: expect.any(Number) }),
				{ timeout: 15_000 },
			);
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type = 'run.started'",
					)
					.all(sessionId),
			).toHaveLength(1);
			evidence["runnerStartedAfterReplacement"] = outcomes(db, [id]);
		} finally {
			writeFileSync(join(fixture.root, "release-stop-intake"), "release");
			db.close();
		}
	}, 90_000);

	it.each([
		"cursor",
		"opencode",
	] as const)("preserves a %s send across relay replacement during execution", async (driver) => {
		const fixture = prepare(undefined, driver === "opencode");
		const gate = join(fixture.root, "cursor-send-gate");
		const capture = join(fixture.root, "cursor-capture.jsonl");
		if (driver === "cursor") writeFileSync(gate, "hold");
		await fixture.restart({
			serviceEnvironment: {
				CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30",
				...(driver === "cursor"
					? {
							CONDUIT_CURSOR_SDK_TRACE: resolve(
								"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
							),
							CONDUIT_CURSOR_SDK_CAPTURE: capture,
							CONDUIT_TEST_CURSOR_SEND_GATE: gate,
							CURSOR_API_KEY: "[REDACTED:test-account]",
						}
					: {}),
			},
		});
		let accountId = "managed-test";
		if (driver === "cursor") {
			const account = await fixture.requestRpc({
				_tag: "AddInstance",
				name: "Replacement Cursor",
				driver,
			});
			if (!account.addedInstanceId) throw new Error("Missing Cursor account");
			accountId = account.addedInstanceId;
		}
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			`${driver} during replacement`,
			accountId,
			driver,
			driver === "cursor" ? { modelId: "composer-2.5", contextWindow: "" } : {},
		);
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			if (driver === "opencode")
				writeFileSync(
					join(fixture.configDir, "fake-opencode-hold-turn"),
					"hold",
				);
			const id = await submit(
				browser,
				sessionId,
				"Held during relay replacement",
			);
			await vi.waitFor(
				() =>
					expect(
						driver === "cursor"
							? existsSync(capture) &&
									readFileSync(capture, "utf8").includes('"send.options"')
							: fixture
									.opencodeRequestBodies()
									.some(
										({ path }) => path === `/session/${sessionId}/prompt_async`,
									),
					).toBe(true),
				{ timeout: 30_000 },
			);
			if (driver === "opencode") {
				const request = fixture
					.opencodeRequestBodies()
					.find(({ path }) => path === `/session/${sessionId}/prompt_async`);
				const { messageID } = JSON.parse(request?.body ?? "{}") as {
					messageID?: string;
				};
				expect(messageID).toBeTruthy();
				await fixture.emitOpenCodeEvent(
					{
						directory: fixture.projectDir,
						payload: {
							id: randomUUID(),
							type: "message.updated",
							properties: {
								info: {
									id: messageID,
									sessionID: sessionId,
									role: "user",
									time: { created: Date.now() },
								},
							},
						},
					},
					accountId,
				);
				await vi.waitFor(() =>
					expect(
						db
							.prepare(
								"SELECT started_at FROM provider_runs WHERE id = (SELECT run_id FROM provider_command_outbox WHERE command_id = ?)",
							)
							.get(id),
					).toMatchObject({ started_at: expect.any(Number) }),
				);
			}
			const extra = join(fixture.root, "sibling-replacement-folder");
			mkdirSync(extra);
			await fixture.requestRpc({
				_tag: "SaveProject",
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			});
			await fixture.connect(sessionId);
			expect(outcomes(db, [id])[0]).toMatchObject({
				status: "running",
				error_code: null,
				claim_count: 1,
				terminal_receipt_count: 0,
			});
			evidence["siblingHeldAfterReplacement"] = outcomes(db, [id]);
			if (driver === "cursor") unlinkSync(gate);
			else
				await fixture.setOpenCodeStatus(
					fixture.projectDir,
					sessionId,
					{ type: "idle" },
					accountId,
				);
			await completed(db, [id], 30_000);
			expect(
				driver === "cursor"
					? readFileSync(capture, "utf8").split('"send.options"').length - 1
					: fixture
							.opencodeRequestBodies()
							.filter(
								({ path }) => path === `/session/${sessionId}/prompt_async`,
							).length,
			).toBe(1);
			evidence["siblingCompletedAfterReplacement"] = outcomes(db, [id]);
		} finally {
			if (existsSync(gate)) unlinkSync(gate);
			db.close();
		}
	}, 90_000);

	it("keeps mid-intake ownership across two relay replacements", async () => {
		const fixture = prepare();
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Mid-intake replacement");
		const db = new Database(fixture.daemonStorePath());
		const gate = join(fixture.root, "hold-provider-intake");
		try {
			countTransitions(db);
			const prompt = "Prompt claimed before replacement intake";
			writeFileSync(gate, sessionId);
			const id = await submit(browser, sessionId, prompt);
			await vi.waitFor(
				() =>
					expect(
						observations(fixture).some(
							({ kind }) => kind === "provider-intake-gap",
						),
					).toBe(true),
				{ timeout: 10_000 },
			);
			evidence["beforeMidIntake"] = {
				runs: db
					.prepare(
						"SELECT id, status, started_at FROM provider_runs WHERE session_id = ?",
					)
					.all(sessionId),
				events: db
					.prepare(
						"SELECT type, data, metadata FROM events WHERE session_id = ? AND type LIKE 'run.%'",
					)
					.all(sessionId),
			};
			for (let round = 0; round < 2; round++) {
				const extra = join(fixture.root, `mid-intake-folder-${round}`);
				mkdirSync(extra);
				await fixture.requestRpc({
					_tag: "SaveProject",
					slug: "process-test",
					folders: [fixture.projectDir, extra],
				});
				expect(outcomes(db, [id])[0]).toMatchObject({
					status: "running",
					attempt_count: 1,
					claim_count: 1,
					terminal_receipt_count: 0,
				});
			}
			evidence["midIntake"] = outcomes(db, [id]);
			unlinkSync(gate);
			await completed(db, [id]);
			expect(
				db
					.prepare(
						"SELECT text FROM messages WHERE session_id = ? AND role = 'user' AND text = ?",
					)
					.all(sessionId, prompt),
			).toHaveLength(1);
			expect(
				sdkRows(fixture).filter(
					({ kind, request }) => kind === "enqueue" && request === prompt,
				),
			).toHaveLength(1);
			evidence["afterMidIntake"] = outcomes(db, [id]);
		} finally {
			if (existsSync(gate)) unlinkSync(gate);
			db.close();
		}
	}, 90_000);

	it("waits for project services when detach races a claimed send", async () => {
		const fixture = prepare();
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionA = await a.createSession("Claim before detach");
		const sessionB = await b.createSession(
			"Other project during claimed detach",
		);
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			db.exec(`CREATE TRIGGER hold_claimed_send BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.session_id = '${sessionA}' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			const id = await submit(
				a,
				sessionA,
				"Claimed before project services detach",
			);
			await fixture.kill();
			const gate = join(fixture.root, "hold-claimed-account");
			writeFileSync(gate, id);
			db.exec("DROP TRIGGER hold_claimed_send");
			await fixture.restart({
				serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
			});
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(
						({ kind }) => kind === "claimed-account-gap",
					),
				).toBe(true),
			);
			writeFileSync(join(fixture.root, "detach-relay"), "process-test");
			await vi.waitFor(
				() =>
					expect(
						observations(fixture).some(({ kind }) => kind === "relay-gap"),
					).toBe(true),
				{ timeout: 5_000 },
			);
			unlinkSync(gate);
			const other = await fixture.connect(sessionB, undefined, "project-b");
			await completed(db, [
				await submit(other, sessionB, "Other project during pre-intake detach"),
			]);
			const sweeps = observations(fixture).filter(
				({ kind }) => kind === "outbox-drain",
			).length;
			await vi.waitFor(() =>
				expect(
					observations(fixture).filter(({ kind }) => kind === "outbox-drain")
						.length,
				).toBeGreaterThan(sweeps + 2),
			);
			expect(outcomes(db, [id])[0]).toMatchObject({
				status: "running",
				attempt_count: 1,
				claim_count: 1,
				terminal_receipt_count: 0,
			});
			evidence["claimedDuringGap"] = outcomes(db, [id]);
			await fixture.connect(sessionA);
			await completed(db, [id]);
			expect(
				sdkRows(fixture).filter(
					({ kind, request }) =>
						kind === "enqueue" &&
						request === "Claimed before project services detach",
				),
			).toHaveLength(1);
			evidence["claimedAfterAttach"] = outcomes(db, [id]);
		} finally {
			db.close();
		}
	}, 90_000);

	it("prepares runtime-imported controls without resetting another project's live claim", async () => {
		const fixture = prepare();
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
		});
		const a = await fixture.connect();
		const sessionA = await a.createSession("Live control during import");
		const db = new Database(fixture.daemonStorePath());
		try {
			await submit(a, sessionA, "tool-long-live-control-during-import");
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(
							({ kind, request }) =>
								kind === "enqueue" &&
								request === "tool-long-live-control-during-import",
						),
					).toBe(true),
				{ timeout: 15_000 },
			);
			const gate = join(fixture.root, "hold-control-delivery");
			writeFileSync(gate, "");
			const liveId = randomUUID();
			const live = fixture
				.requestRpc({
					_tag: "CancelSession",
					sessionId: sessionA,
					commandId: liveId,
				})
				.catch((error: unknown) => String(error));
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(({ kind }) => kind === "control-gap"),
				).toBe(true),
			);
			expect(
				db
					.prepare(
						"SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(liveId),
			).toMatchObject({ status: "running", attempt_count: 1 });
			const folder = join(fixture.root, "late-project");
			mkdirSync(join(folder, ".conduit"), { recursive: true });
			const sessionId = "ses_runtime_imported_control";
			const ids = [randomUUID(), randomUUID()];
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, project_id, provider, title, created_at, updated_at) VALUES (${sessionId}, 'late-project', 'opencode', 'Imported controls', 1, 1)`;
					for (const [index, id] of ids.entries()) {
						yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at) VALUES (${id}, ${sessionId}, 'late-project', 'side_effect_requested', 1)`;
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, attempt_count, requested_at, updated_at)
						VALUES (${index + 1}, ${id}, 'late-project', ${sessionId}, 'opencode', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId, providerProcessId: "imported-old-process" })}, 'imported-old-process', ${index === 0 ? "running" : "pending"}, ${index === 0 ? 1 : 0}, 1, 1)`;
					}
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(
							join(folder, ".conduit", "events.db"),
							"late-project",
						),
					),
				),
			);
			const importGate = join(fixture.root, "hold-import-publication");
			const b = await fixture.connect(undefined, undefined, "project-b");
			const sessionB = await b.createSession(
				"Send while import awaits publication",
			);
			writeFileSync(importGate, "");
			const save = fixture.requestRpc({
				_tag: "SaveProject",
				folders: [folder],
			});
			void save.catch(() => {});
			await vi.waitFor(() =>
				expect(
					observations(fixture).some(({ kind }) => kind === "import-gap"),
				).toBe(true),
			);
			countTransitions(db);
			const sweeps = observations(fixture).filter(
				({ kind }) => kind === "outbox-drain",
			).length;
			await vi.waitFor(() =>
				expect(
					observations(fixture).filter(({ kind }) => kind === "outbox-drain")
						.length,
				).toBeGreaterThan(sweeps + 2),
			);
			for (const [index, row] of outcomes(db, ids).entries())
				expect(row).toMatchObject({
					status: index === 0 ? "running" : "pending",
					terminal_receipt_count: 0,
					claim_count: 0,
				});
			evidence["beforeImportPublication"] = outcomes(db, ids);
			await completed(db, [
				await submit(b, sessionB, "Import does not block another project"),
			]);
			unlinkSync(importGate);
			const saved = await save;
			await fixture.connect(sessionId, undefined, saved.savedSlug);
			await vi.waitFor(
				() => {
					for (const row of outcomes(db, ids))
						expect(row).toMatchObject({
							status: "cancelled",
							error_code: "provider_process_gone",
							receipt_status: "side_effect_failed",
							terminal_receipt_count: 1,
						});
				},
				{ timeout: 5_000 },
			);
			expect(outcomes(db, [liveId])[0]).toMatchObject({
				status: "running",
				attempt_count: 1,
				claim_count: 0,
				terminal_receipt_count: 0,
			});
			evidence["importedControls"] = outcomes(db, ids);
			evidence["liveDuringImport"] = outcomes(db, [liveId]);
			unlinkSync(gate);
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(({ kind }) => kind === "query-interrupted"),
					).toBe(true),
				{ timeout: 5_000 },
			);
			writeFileSync(join(fixture.root, "release-tool-long"), "release");
			await live;
			await vi.waitFor(() =>
				expect(outcomes(db, [liveId])[0]).toMatchObject({
					status: "completed",
					attempt_count: 1,
					claim_count: 0,
					terminal_receipt_count: 1,
				}),
			);
			evidence["liveAfterImport"] = outcomes(db, [liveId]);
		} finally {
			db.close();
		}
	}, 90_000);

	it("settles crash orphans in both projects in one recovery pass", async () => {
		const fixture = prepare();
		await fixture.restart();
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			const sessions: Array<{
				projectId: string;
				sessionId: string;
				commandId: string;
				pid: number;
			}> = [];
			for (const projectId of ["process-test", "project-b"]) {
				const browser = await fixture.connect(undefined, undefined, projectId);
				const sessionId = await browser.createSession(
					`Crash orphan ${projectId}`,
				);
				const commandId = await submit(
					browser,
					sessionId,
					`tool-long-crash-orphan-${projectId}`,
				);
				const runner = await fixture.waitForMark(
					(mark) =>
						mark.kind === "runner-started" && mark.sessionId === sessionId,
				);
				if (runner.kind !== "runner-started")
					throw new Error("Missing fixture runner");
				await vi.waitFor(() =>
					expect(outcomes(db, [commandId])[0]).toMatchObject({
						status: "running",
						claim_count: 1,
					}),
				);
				await vi.waitFor(
					() =>
						expect(
							sdkRows(fixture).some(
								({ kind, request }) =>
									kind === "enqueue" &&
									request === `tool-long-crash-orphan-${projectId}`,
							),
						).toBe(true),
					{ timeout: 15_000 },
				);
				sessions.push({ projectId, sessionId, commandId, pid: runner.pid });
			}
			const firstPid = observations(fixture)[0]?.daemonPid;
			await fixture.kill();
			for (const { pid } of sessions) process.kill(pid, "SIGKILL");
			await vi.waitFor(() => {
				for (const { pid } of sessions)
					expect(() => process.kill(pid, 0)).toThrow();
			});
			await fixture.restart();
			const ids = sessions.map(({ commandId }) => commandId);
			await vi.waitFor(
				() => {
					for (const row of outcomes(db, ids))
						expect(row).toMatchObject({
							status: "failed",
							claim_count: 1,
							receipt_count: 1,
							receipt_status: "side_effect_failed",
							terminal_receipt_count: 1,
						});
				},
				{ timeout: 20_000 },
			);
			const restarted = observations(fixture).filter(
				({ daemonPid }) => daemonPid !== firstPid,
			);
			expect(
				restarted
					.filter(({ kind }) => kind === "recovery-start")
					.map(({ driver }) => driver)
					.sort(),
			).toEqual(["claude", "codex", "cursor"]);
			expect(
				restarted
					.filter(({ kind }) => kind === "recovery-end")
					.map(({ driver }) => driver)
					.sort(),
			).toEqual(["claude", "codex", "cursor"]);
			expect(
				restarted.filter(({ kind }) => kind === "engine-observed"),
			).toHaveLength(1);
			const proof = sdkRows(fixture);
			for (const { projectId } of sessions)
				expect(
					proof.filter(
						({ kind, request }) =>
							kind === "enqueue" &&
							request === `tool-long-crash-orphan-${projectId}`,
					),
				).toHaveLength(1);
			evidence = {
				sessions,
				recoveredCommands: outcomes(db, ids),
				recovery: restarted,
			};
		} finally {
			db.close();
		}
	}, 90_000);

	it.each([
		false,
		true,
	])("preserves the failed prompt in a typed durable refusal for an unavailable project (rollback=%s)", async (blockWrite) => {
		const fixture = prepare();
		await fixture.restart();
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionA = await a.createSession("Available after restart");
		const sessionB = await b.createSession("Unavailable relay after restart");
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			db.exec(`CREATE TRIGGER hold_engine_send BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.effect_type = 'send_turn' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			const [availableId, unavailableId] = await Promise.all([
				submit(a, sessionA, "Available pending command"),
				submit(b, sessionB, "Unavailable pending command"),
			]);
			const ids = [availableId, unavailableId];
			await vi.waitFor(() => {
				for (const row of outcomes(db, ids))
					expect(row).toMatchObject({ status: "pending", claim_count: 0 });
			});
			await fixture.kill();
			db.exec("DROP TRIGGER hold_engine_send");
			const controlId = randomUUID();
			db.prepare(
				"INSERT INTO command_receipts (command_id, project_key, session_id, status, created_at) VALUES (?, 'project-b', ?, 'side_effect_requested', 1)",
			).run(controlId, sessionB);
			db.prepare(`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at)
				VALUES (-1, ?, 'project-b', ?, 'opencode', 'interrupt_turn', ?, 'unavailable-process', 'pending', 1, 1)`).run(
				controlId,
				sessionB,
				JSON.stringify({
					type: "interrupt_turn",
					sessionId: sessionB,
					providerProcessId: "unavailable-process",
				}),
			);
			const legacy = join(fixture.root, "project-b", ".conduit");
			mkdirSync(legacy, { recursive: true });
			writeFileSync(join(legacy, "events.db"), "fixture corrupt history");
			if (blockWrite)
				db.exec(`CREATE TRIGGER fail_refusal_text BEFORE INSERT ON events
				WHEN NEW.session_id = '${sessionB}' AND NEW.type = 'text.delta'
				BEGIN SELECT RAISE(ABORT, 'fixture refusal persistence failure'); END`);
			await fixture.restart({
				serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "30" },
			});
			const projects = (await fixture.requestRpc({ _tag: "GetProjects" }))
				.projects;
			expect(
				projects.find(({ slug }) => slug === "project-b")?.unavailableReason,
			).toEqual(expect.any(String));
			await completed(db, [availableId]);
			await vi.waitFor(() =>
				expect(outcomes(db, [controlId])[0]).toMatchObject({
					status: "failed",
					error_code: "project_unavailable",
					claim_count: 0,
					terminal_receipt_count: 1,
				}),
			);
			evidence["unavailableControl"] = outcomes(db, [controlId]);
			if (blockWrite) {
				const sweeps = observations(fixture).filter(
					({ kind }) => kind === "outbox-drain",
				).length;
				await vi.waitFor(() =>
					expect(
						observations(fixture).filter(({ kind }) => kind === "outbox-drain")
							.length,
					).toBeGreaterThan(sweeps + 2),
				);
				expect(outcomes(db, [unavailableId])[0]).toMatchObject({
					status: "pending",
					attempt_count: 0,
					terminal_receipt_count: 0,
					receipt_status: "side_effect_requested",
				});
				expect(
					db
						.prepare("SELECT id FROM messages WHERE session_id = ?")
						.all(sessionB),
				).toEqual([]);
				evidence["atomicRollback"] = outcomes(db, [unavailableId]);
				db.exec("DROP TRIGGER fail_refusal_text");
			}
			await vi.waitFor(
				() =>
					expect(outcomes(db, [unavailableId])[0]).toMatchObject({
						status: "failed",
						error_code: "project_unavailable",
						receipt_count: 1,
						receipt_status: "side_effect_failed",
						receipt_error_code: "project_unavailable",
						terminal_receipt_count: 1,
					}),
				{ timeout: 20_000 },
			);
			const receipt = db
				.prepare("SELECT error FROM command_receipts WHERE command_id = ?")
				.get(unavailableId) as { error: string };
			expect(JSON.parse(receipt.error)).toMatchObject({
				_tag: "ProviderInstanceFailure",
				code: "project_unavailable",
			});
			evidence = {
				...evidence,
				projects,
				commands: outcomes(db, ids),
				refusal: JSON.parse(receipt.error),
			};
			await fixture.kill();
			unlinkSync(join(legacy, "events.db"));
			await fixture.restart();
			const repaired = await fixture.connect(sessionB, undefined, "project-b");
			const history = await repaired.history(sessionB);
			expect(
				history.filter(({ role }) => role === "user").map(({ text }) => text),
			).toEqual(["Unavailable pending command"]);
			expect(
				db
					.prepare("SELECT state FROM turns WHERE session_id = ?")
					.all(sessionB),
			).toEqual([{ state: "error" }]);
			expect(
				db
					.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
					.get(unavailableId),
			).toEqual({ state: "removed" });
			for (let retry = 0; retry < 2; retry++) {
				await Effect.runPromise(
					repaired.rpc["input.submit"]({
						sessionId: sessionB,
						originId: b.originId,
						inputId: unavailableId,
						delivery: "queue",
						text: "Unavailable pending command",
					}),
				);
			}
			expect(
				(await repaired.history(sessionB)).filter(
					({ role }) => role === "user",
				),
			).toHaveLength(1);
			expect(outcomes(db, [unavailableId])[0]).toMatchObject({
				terminal_receipt_count: 1,
				claim_count: 0,
			});
			evidence["repairedHistory"] = await repaired.history(sessionB);
			evidence["retryOutcome"] = outcomes(db, [unavailableId]);
		} finally {
			db.close();
		}
	}, 90_000);

	it("cancels a removed project's retained process head without stopping another project's drain", async () => {
		const fixture = prepare();
		await fixture.restart();
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionA = await a.createSession("Active project during removal");
		const sessionB = await b.createSession("Retained project during removal");
		const db = new Database(fixture.daemonStorePath());
		try {
			countTransitions(db);
			const sendId = await submit(
				a,
				sessionA,
				"tool-long-remove-other-project",
			);
			await vi.waitFor(() =>
				expect(outcomes(db, [sendId])[0]).toMatchObject({ status: "running" }),
			);
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(
							({ kind, request }) =>
								kind === "enqueue" &&
								request === "tool-long-remove-other-project",
						),
					).toBe(true),
				{ timeout: 15_000 },
			);
			db.exec(`CREATE TRIGGER hold_engine_control BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.effect_type <> 'send_turn' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			const inactiveId = randomUUID();
			const activeId = randomUUID();
			const control = fixture
				.requestRpc({
					_tag: "CancelSession",
					sessionId: sessionA,
					commandId: activeId,
				})
				.catch((error: unknown) => {
					evidence["controlError"] = String(error);
				});
			await vi.waitFor(
				() =>
					expect(outcomes(db, [activeId])[0]).toMatchObject({
						status: "pending",
						claim_count: 0,
					}),
				{ timeout: 10_000 },
			);
			const target = db
				.prepare<
					[string],
					{ provider_id: string; provider_process_id: string }
				>(
					"SELECT provider_id, provider_process_id FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(activeId);
			if (!target?.provider_process_id)
				throw new Error("Missing admitted control process");
			db.prepare(`INSERT INTO command_receipts (command_id, command_type, project_key, session_id, status, fingerprint_hash, fingerprint_version, created_at, updated_at)
				VALUES (?, 'interrupt_turn', 'project-b', ?, 'side_effect_requested', 'fixture-retained-process-head', 2, 1, 1)`).run(
				inactiveId,
				sessionB,
			);
			db.prepare(`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at)
				VALUES (-1, ?, 'project-b', ?, ?, 'interrupt_turn', ?, ?, 'pending', 1, 1)`).run(
				inactiveId,
				sessionB,
				target.provider_id,
				JSON.stringify({
					type: "interrupt_turn",
					sessionId: sessionB,
					providerProcessId: target.provider_process_id,
				}),
				target.provider_process_id,
			);
			await fixture.requestRpc({ _tag: "RemoveProject", slug: "project-b" });
			await vi.waitFor(
				() =>
					expect(outcomes(db, [inactiveId])[0]).toMatchObject({
						status: "cancelled",
						error_code: "project_inactive",
						claim_count: 0,
						receipt_count: 1,
						receipt_status: "side_effect_failed",
						receipt_error_code: "project_inactive",
						terminal_receipt_count: 1,
					}),
				{ timeout: 10_000 },
			);
			db.exec("DROP TRIGGER hold_engine_control");
			await vi.waitFor(
				() =>
					expect(
						sdkRows(fixture).some(({ kind }) => kind === "query-interrupted"),
					).toBe(true),
				{ timeout: 5_000 },
			);
			writeFileSync(join(fixture.root, "release-tool-long"), "release");
			await control;
			await completed(db, [activeId]);
			await vi.waitFor(() =>
				expect(outcomes(db, [sendId])[0]).toMatchObject({
					terminal_receipt_count: 1,
				}),
			);
			const beforeRestart = outcomes(db, [inactiveId, activeId]);
			await fixture.kill();
			const retainedId = randomUUID();
			db.prepare(`INSERT INTO command_receipts (command_id, command_type, project_key, session_id, status, fingerprint_hash, fingerprint_version, created_at, updated_at)
				SELECT ?, command_type, project_key, session_id, 'side_effect_requested', fingerprint_hash, fingerprint_version, created_at, updated_at
				FROM command_receipts WHERE command_id = ?`).run(
				retainedId,
				inactiveId,
			);
			db.prepare(`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at)
				SELECT -2, ?, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, 'pending', requested_at, updated_at
				FROM provider_command_outbox WHERE command_id = ?`).run(
				retainedId,
				inactiveId,
			);
			await fixture.restart();
			const restarted = await fixture.connect(sessionA);
			const afterId = await submit(
				restarted,
				sessionA,
				"After restart with removed project history",
			);
			await completed(db, [afterId]);
			await vi.waitFor(() =>
				expect(outcomes(db, [retainedId])[0]).toMatchObject({
					status: "cancelled",
					error_code: "project_inactive",
					claim_count: 0,
					receipt_status: "side_effect_failed",
					receipt_error_code: "project_inactive",
					terminal_receipt_count: 1,
				}),
			);
			expect(outcomes(db, [inactiveId, activeId])).toEqual(beforeRestart);
			expect(
				(await fixture.requestRpc({ _tag: "GetProjects" })).projects.map(
					({ slug }) => slug,
				),
			).toEqual(["process-test"]);
			evidence = {
				retainedHead: beforeRestart,
				afterRestart: outcomes(db, [inactiveId, activeId, retainedId, afterId]),
				removedWhileOtherProjectRunning: true,
			};
		} finally {
			db.close();
		}
	}, 90_000);
});
