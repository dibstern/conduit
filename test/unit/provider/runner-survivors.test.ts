import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Random,
	Scope,
} from "effect";
import { SqlClient } from "effect/sql";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { sendPreparedClaudeTurn } from "../../../src/lib/provider/claude/prepare-turn.js";
import {
	makeProcessSessionRunner,
	type ProcessRunnerDriver,
	stopRegisteredRunners,
} from "../../../src/lib/provider/runner/process-session-runner.js";
import * as RunnerConnection from "../../../src/lib/provider/runner/runner-connection.js";
import {
	type RunnerCommandFailure,
	type RunnerSendAnswer,
	RunnerSocket,
	runnerBuildId,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import * as RunnerRecovery from "../../../src/lib/provider/runner/runner-recovery.js";
import {
	prepareRunnerDirectory,
	type RunnerProcessTable,
	type RunnerRegistration,
	registerRunner,
	runnerProcessTable,
} from "../../../src/lib/provider/runner/runner-registry.js";
import { RunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";
import { failRunnerTurn } from "../../../src/lib/provider/runner/runner-turn-failure.js";
import type {
	SessionCommand,
	SessionOutput,
} from "../../../src/lib/provider/runner/session-runner.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";
import { cleanupTestClaudeRunners } from "../../helpers/claude-runner-cleanup.js";
import {
	admitRunnerCommand,
	makeRunnerAdmission,
} from "../../helpers/runner-provider-admission.js";

const spawned = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: spawned.spawn,
}));

// Failure cases: retirement can be lost on restart; survivor retries can signal a
// reused process or duplicate its notice; an older registration can retain authority.
// These tests exercise the manager with a clock, process table and durable cursors.
const setup = Effect.gen(function* () {
	const root = yield* Effect.acquireRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-survivors-"))),
		(path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
	);
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 1, 1)`;
	const processes = new Map<
		number,
		{
			readonly state: "running" | "zombie" | "unknown" | "gone";
			readonly startTime?: string;
			readonly pgid?: number;
		}
	>();
	const signals: Array<{
		readonly pid: number;
		readonly signal: NodeJS.Signals;
	}> = [];
	const groups = new Map<
		number,
		readonly { readonly pid: number; readonly startTime: string }[]
	>();
	const members = vi.fn<NonNullable<RunnerProcessTable["members"]>>(
		(pgid: number) =>
			groups.get(pgid) ??
			(processes.get(pgid)?.startTime
				? [{ pid: pgid, startTime: processes.get(pgid)?.startTime ?? "" }]
				: []),
	);
	const inspect = vi.fn(
		(pid: number) => processes.get(pid) ?? { state: "gone" as const },
	);
	const inspectMany = vi.fn(
		(pids: readonly number[]) =>
			new Map(
				pids.map((pid) => [
					pid,
					processes.get(pid) ?? { state: "gone" as const },
				]),
			),
	);
	const signal = vi.fn((pid: number, signal: NodeJS.Signals) => {
		signals.push({ pid, signal });
	});
	let spawnedCount = 0;
	const children = new Map<number, ChildProcess>();
	spawned.spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			pid: 100_020 + spawnedCount++,
			exitCode: null,
			signalCode: null,
			connected: false,
			unref: () => {},
			disconnect: () => {},
		});
		processes.set(child.pid, {
			state: "running",
			startTime: `spawned-${child.pid}`,
		});
		queueMicrotask(() =>
			child.emit("message", {
				channel: "conduit-claude-runner",
				type: "listening",
			}),
		);
		const handle = child as unknown as ChildProcess;
		children.set(child.pid, handle);
		return handle;
	});
	const connect = vi.fn<ProcessRunnerDriver["connect"]>(() =>
		Effect.fail(runnerFailure("test connect", "Unexpected adoption")),
	);
	const driver: ProcessRunnerDriver = {
		driverKind: "claude",
		connect,
		settingsDeferredCode: "test-deferred",
		warmCommand: (sessionId, _state, snapshot) => ({
			type: "pre-warm",
			sessionId,
			input: { ...snapshot.input, sessionId },
		}),
		snapshotCommandSettings: () => ({}),
		loginChange: () => "None",
	};
	const directory = prepareRunnerDirectory(root, root);
	const register = (
		id: string,
		pid: number,
		options: {
			readonly sessionId?: string;
			readonly startTime?: string | undefined;
			readonly signalled?: boolean;
			readonly registeredAt?: number;
			readonly retired?: boolean;
			readonly role?: "candidate";
			readonly ownedRunIds?: readonly string[];
		} = {},
	) =>
		Effect.gen(function* () {
			const entry: RunnerRegistration = {
				driverKind: "claude",
				runnerId: id,
				sessionId: options.sessionId ?? "s",
				socketPath: join(directory, id),
				buildId: runnerBuildId(),
				pid,
				...("startTime" in options
					? options.startTime === undefined
						? {}
						: { startTime: options.startTime }
					: { startTime: "original" }),
				registeredAt: options.registeredAt ?? 1,
				...(options.role ? { role: options.role } : {}),
			};
			writeFileSync(`${entry.socketPath}.json`, JSON.stringify(entry));
			processes.set(pid, {
				state: "running",
				...(entry.startTime ? { startTime: entry.startTime } : {}),
			});
			if (options.retired !== false)
				yield* sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, retired_at, pid, start_time, owned_run_ids, signalled)
			VALUES (${id}, 0, ${entry.sessionId}, 1, ${pid}, ${entry.startTime ?? null}, ${JSON.stringify(options.ownedRunIds ?? [])}, ${options.signalled === false ? 0 : 1})`;
			else {
				const [serving] =
					yield* sql`SELECT runner_id FROM claude_runner_cursors WHERE session_id = ${entry.sessionId} AND retired_at IS NULL AND role = 'serving'`;
				yield* sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, pid, start_time, owned_run_ids, role)
				VALUES (${id}, 0, ${entry.sessionId}, ${pid}, ${entry.startTime ?? null}, ${JSON.stringify(options.ownedRunIds ?? [])}, ${options.role ?? (serving ? "candidate" : "serving")})`;
			}
			return entry;
		});
	const makeManager = (
		options: Pick<
			Parameters<typeof makeProcessSessionRunner>[0],
			"accounts"
		> = {},
	) =>
		Effect.gen(function* () {
			const manager = yield* makeProcessSessionRunner(
				{
					...options,
					daemonConfigDir: root,
					projectRootForSession: () => Effect.succeed(root),
					processTable: {
						inspect,
						inspectMany,
						members,
						signal,
					},
				},
				output,
				driver,
			);
			const admission = yield* makeRunnerAdmission(manager);
			return { manager, admission };
		});
	const output = vi.fn<Parameters<typeof makeProcessSessionRunner>[1]>(() =>
		Effect.succeed({}),
	);
	const managerScope = yield* Scope.make();
	yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
	const { manager, admission } = yield* makeManager().pipe(
		Effect.provideService(Scope.Scope, managerScope),
	);
	const recover = Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(manager.recoverEffect);
		yield* TestClock.adjust("2 seconds");
		yield* Fiber.join(fiber);
	});
	const notices = sql<{
		data: string;
	}>`SELECT data FROM events WHERE type = 'turn.notice' ORDER BY sequence`;
	return {
		manager,
		admission,
		managerScope,
		makeManager,
		root,
		register,
		recover,
		connect,
		driver,
		signal,
		signals,
		processes,
		inspect,
		inspectMany,
		groups,
		members,
		children,
		notices,
		output,
		sql,
	};
});

const stopIntentFixture = Effect.gen(function* () {
	const f = yield* setup;
	const ingestion = yield* ProviderRuntimeIngestionTag;
	f.output.mockImplementation((output) =>
		output.type === "event"
			? ingestion.ingest(output.event).pipe(
					Effect.mapError((cause) => runnerFailure("test ingestion", cause)),
					Effect.as({}),
				)
			: Effect.succeed({}),
	);
	const connections: Array<Parameters<ProcessRunnerDriver["connect"]>[0]> = [];
	const commands: Array<{
		runnerId: string;
		type: string;
		runId?: string;
	}> = [];
	f.connect.mockImplementation((options) =>
		Effect.gen(function* () {
			connections.push(options);
			const connection = new RunnerSocket(
				new Socket(),
				() => {},
				() => {},
			);
			vi.spyOn(connection, "destroy").mockImplementation(() => {});
			const journal = new RunnerSendJournal(
				dirname(options.socketPath),
				"s",
				"claude",
			);
			vi.spyOn(connection, "commandEffect").mockImplementation(
				(id, command, attempt) =>
					Effect.gen(function* () {
						commands.push({
							runnerId: options.runnerId,
							type: command.type,
							...(command.type === "send-turn"
								? { runId: command.input.runId }
								: {}),
						});
						return command.type === "send-turn"
							? yield* journal.execute(
									id,
									attempt ?? command.input.commandAttempt ?? 0,
									command.input.nativeResumeFallback === true,
									Effect.succeed({
										status: "accepted" as const,
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 0,
										providerStateUpdates: [],
									}),
								)
							: undefined;
					}),
			);
			yield* options.onHello(
				{
					type: "hello",
					protocolVersion: 1,
					buildId: runnerBuildId(),
					stampsRunIds: true,
					runnerId: options.runnerId,
					sessionId: "s",
					pid: options.pid ?? 0,
					bindings: [],
					sendJournalAnswers: true,
					sendAnswers: [],
				},
				connection,
			);
			return connection;
		}),
	);
	const input = {
		sessionId: "s",
		workspaceRoot: f.root,
		extraFolders: [],
		providerState: {},
		configDir: configuredClaudeConfigDir(f.root),
	};
	yield* f.manager.executeEffect({ type: "pre-warm", sessionId: "s", input });
	const runner = connections[0];
	if (!runner?.pid) return yield* Effect.die("missing stop-intent runner");
	const dispatch = (runId: string) =>
		Effect.gen(function* () {
			const [command] = yield* f.sql<{
				attempt_count: number;
			}>`SELECT attempt_count FROM provider_command_outbox WHERE run_id = ${runId} AND session_id = 's' AND effect_type = 'send_turn' ORDER BY request_sequence DESC LIMIT 1`;
			return yield* admitRunnerCommand(f.admission, f.manager, {
				type: "send-turn",
				sinkId: `sink-${runId}`,
				aborted: false,
				input: {
					...input,
					inputId: `input-${runId}`,
					runId,
					commandAttempt: command?.attempt_count ?? 0,
					prompt: runId,
					history: [],
				},
			});
		});
	const accept = (runId: string) =>
		runner.onOutputCommitted?.({
			type: "event",
			sinkId: `sink-${runId}`,
			event: {
				eventId: `started-${runId}`,
				type: "run.started",
				providerId: "claude",
				sessionId: "s",
				runId,
				providerRefs: {},
				rawSource: { kind: "test" },
				createdAt: 1,
				data: { inputId: `input-${runId}`, requestedRunId: runId },
			},
		});
	const stop = f.manager.executeEffect({ type: "end-session", sessionId: "s" });
	const exitOnSignal = () =>
		f.signal.mockImplementation((pid, signal) => {
			f.signals.push({ pid, signal });
			f.processes.set(Math.abs(pid), { state: "gone" });
		});
	return {
		...f,
		runner,
		connections,
		commands,
		input,
		dispatch,
		accept,
		stop,
		exitOnSignal,
	};
});

it.effect(
	"a delayed retired background cleanup cannot clear a successor snapshot",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* stopIntentFixture;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const background = makeSessionBackgroundLiveness(undefined, () => 1);
				f.output.mockImplementation((output) =>
					Effect.gen(function* () {
						if (output.type === "background-task") {
							if (output.transition.kind === "session-ended") {
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
							}
							background.record(output.transition);
						}
						return {};
					}),
				);
				f.exitOnSignal();
				const stopping = yield* f.stop.pipe(Effect.forkChild);
				yield* Effect.gen(function* () {
					yield* Deferred.await(entered);
					const warming = yield* f.manager
						.executeEffect({ type: "pre-warm", sessionId: "s", input: f.input })
						.pipe(Effect.forkChild);
					yield* TestClock.adjust("2 seconds");
					yield* Fiber.join(warming);
					expect(f.connections).toHaveLength(2);
					const successor = f.connections[1];
					if (!successor) return yield* Effect.die("missing successor");
					yield* successor.emit(
						{
							type: "background-task",
							transition: {
								sessionId: "s",
								kind: "snapshot",
								tasks: [
									{
										id: "successor",
										type: "local_bash",
										description: "New work",
									},
								],
							},
						},
						"s",
					);
					yield* Deferred.succeed(release, undefined);
					yield* TestClock.adjust("2 seconds");
					yield* Fiber.join(stopping);
					expect(
						background.backgroundOf("s")?.tasks.map((task) => task.id),
					).toEqual(["successor"]);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

// Exercise the swap through the same manager/process-table boundary as Stop.
// Gates expose the prepare/commit race without duplicating its state machine.
const swapFixture = Effect.gen(function* () {
	const f = yield* setup;
	const ingestion = yield* ProviderRuntimeIngestionTag;
	f.output.mockImplementation((output) =>
		output.type === "event"
			? ingestion.ingest(output.event).pipe(
					Effect.mapError((cause) => runnerFailure("test ingestion", cause)),
					Effect.as({}),
				)
			: Effect.succeed({}),
	);
	const warming = yield* Deferred.make<void>();
	const warmed = yield* Deferred.make<void>();
	// Keep retries gated while the test inspects its first replacement attempt.
	const retryWarmed = yield* Deferred.make<void>();
	yield* Effect.addFinalizer(() =>
		f.manager
			.executeEffect({ type: "shutdown" })
			.pipe(
				Effect.orDie,
				Effect.ensuring(Deferred.succeed(retryWarmed, undefined)),
				Effect.andThen(TestClock.adjust("4 seconds")),
			),
	);
	const preparing = yield* Deferred.make<void>();
	const prepared = yield* Deferred.make<void>();
	const connections: Array<{
		options: Parameters<ProcessRunnerDriver["connect"]>[0];
		socket: RunnerSocket;
	}> = [];
	const commands: Array<{ runnerId: string; type: string; runId?: string }> =
		[];
	const input = {
		sessionId: "s",
		workspaceRoot: f.root,
		extraFolders: [],
		providerState: {},
		configDir: configuredClaudeConfigDir(f.root),
	};
	f.connect.mockImplementation((options) =>
		Effect.gen(function* () {
			const socket = new RunnerSocket(
				new Socket(),
				() => {},
				() => {},
			);
			const candidate = connections.length !== 0;
			const firstCandidate = connections.length === 1;
			connections.push({ options, socket });
			vi.spyOn(socket, "destroy").mockImplementation(() => {});
			vi.spyOn(socket, "write").mockImplementation((message) => {
				commands.push({ runnerId: options.runnerId, type: message.type });
			});
			vi.spyOn(socket, "retireEffect").mockImplementation(() =>
				Deferred.succeed(preparing, undefined).pipe(
					Effect.andThen(Deferred.await(prepared)),
					Effect.as(true),
				),
			);
			vi.spyOn(socket, "commandEffect").mockImplementation((_id, command) =>
				Effect.gen(function* () {
					commands.push({
						runnerId: options.runnerId,
						type: command.type,
						...(command.type === "send-turn"
							? { runId: command.input.runId }
							: {}),
					});
					if (candidate && command.type === "pre-warm") {
						yield* Deferred.succeed(warming, undefined);
						yield* Deferred.await(firstCandidate ? warmed : retryWarmed);
					}
					if (command.type === "send-turn")
						yield* options.emit(
							{
								type: "event",
								sinkId: command.sinkId,
								event: {
									eventId: `started-${command.input.runId}`,
									type: "run.started",
									providerId: "claude",
									sessionId: "s",
									runId: command.input.runId,
									providerRefs: {},
									rawSource: { kind: "test" },
									createdAt: 1,
									data: {
										inputId: command.input.inputId,
										requestedRunId: command.input.runId,
									},
								},
							},
							"s",
						);
					return command.type === "send-turn"
						? {
								status: "accepted" as const,
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							}
						: undefined;
				}),
			);
			yield* options.onHello(
				{
					type: "hello",
					protocolVersion: 1,
					buildId: candidate ? runnerBuildId() : "previous-build",
					stampsRunIds: true,
					runnerId: options.runnerId,
					sessionId: "s",
					pid: options.pid ?? 0,
					bindings: [],
					sendJournalAnswers: true,
					sendAnswers: [],
					upgradeState: { quiescent: false, revision: 0 },
				},
				socket,
			);
			return socket;
		}),
	);
	yield* f.manager.executeEffect({ type: "pre-warm", sessionId: "s", input });
	const old = connections[0];
	if (!old) return yield* Effect.die("missing swap runner");
	const begin = Effect.sync(() =>
		old.options.onUpgradeState?.({
			quiescent: true,
			revision: 1,
			snapshot: {
				input: { ...input, folderSource: "implicitDefault" },
				options: {},
			},
		}),
	);
	const dispatch = (runId: string) =>
		admitRunnerCommand(f.admission, f.manager, {
			type: "send-turn",
			sinkId: `sink-${runId}`,
			aborted: false,
			input: {
				...input,
				inputId: `input-${runId}`,
				runId,
				prompt: runId,
				history: [],
			},
		});
	return {
		...f,
		old,
		begin,
		warming,
		warmed,
		preparing,
		prepared,
		connections,
		commands,
		dispatch,
		input,
	};
});

for (const race of [
	"commit-fails",
	"send-before",
	"send-after-commit",
	"plain-stop-during-commit",
	"retired-old-row",
	"command-after-prepare",
	"cancel-lost",
	"stop-during-warm",
	"candidate-exits",
	"candidate-exits-before-recovery",
	"serving-row-without-registry",
] as const)
	it.effect(
		`RUNNER-SWAP ${race} preserves one durable serving owner and live-or-terminal runs`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* swapFixture;
					if (race === "send-after-commit") {
						vi.stubEnv("CONDUIT_TEST_RUNNER_SWAP_PAUSE", "after-commit");
						vi.stubEnv(
							"CONDUIT_TEST_PROCESS_PROOF",
							join(f.root, "swap-proof.jsonl"),
						);
						writeFileSync(
							join(f.root, "conduit-test-hold-runner-swap-after-commit"),
							"hold",
						);
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								rmSync(
									join(f.root, "conduit-test-hold-runner-swap-after-commit"),
									{ force: true },
								);
								vi.unstubAllEnvs();
							}),
						);
					}
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('swap-run', 's', 'pending', 1)`;
					yield* f.begin;
					yield* Deferred.await(f.warming);
					const candidate = f.connections[1];
					if (!candidate) return yield* Effect.die("missing swap candidate");
					expect(
						yield* f.sql`SELECT role FROM claude_runner_cursors WHERE runner_id = ${candidate.options.runnerId}`,
					).toEqual([{ role: "candidate" }]);
					if (race === "stop-during-warm") {
						const stopping = yield* f.manager
							.executeEffect({ type: "end-session", sessionId: "s" })
							.pipe(Effect.forkChild);
						yield* TestClock.adjust("4 seconds");
						yield* Fiber.join(stopping);
						expect(
							yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE session_id = 's' AND retired_at IS NULL`,
						).toEqual([]);
						yield* Deferred.succeed(f.warmed, undefined);
					} else {
						if (race === "send-before") yield* f.dispatch("swap-run");
						if (race === "commit-fails") {
							yield* f.sql`CREATE TRIGGER reject_swap BEFORE INSERT ON claude_runner_cursors WHEN NEW.retired_at IS NOT NULL AND NEW.stop_reason LIKE '%Superseded%' BEGIN SELECT RAISE(ABORT, 'injected swap failure'); END`;
						}
						yield* Deferred.succeed(f.warmed, undefined);
						if (race !== "send-before") yield* Deferred.await(f.preparing);
						if (race === "command-after-prepare")
							yield* f.manager.executeEffect({
								type: "set-permission-mode",
								sessionId: "s",
								mode: "default",
							});
						if (race === "retired-old-row")
							// Simulate a committed standalone Stop unseen by this manager's cache.
							yield* f.sql`UPDATE claude_runner_cursors SET retired_at = 2, stop_reason = '{"_tag":"Explicit"}' WHERE runner_id = ${f.old.options.runnerId}`;
						if (race === "cancel-lost") {
							vi.spyOn(f.old.socket, "write").mockImplementation(() => {
								throw runnerFailure(
									"test transport",
									"old runner disconnected",
								);
							});
							f.processes.delete(f.old.options.pid ?? 0);
							f.old.options.onClose(
								runnerFailure("test exit", "old runner exited while reserved"),
							);
						}
						if (race === "plain-stop-during-commit") {
							const writer = yield* makeCommitAndSignal;
							const entered = yield* Deferred.make<void>();
							const release = yield* Deferred.make<void>();
							const holding = yield* writer
								.write(() =>
									Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
									),
								)
								.pipe(Effect.forkChild);
							yield* Deferred.await(entered);
							const stopping = yield* f.manager
								.executeEffect({ type: "end-session", sessionId: "s" })
								.pipe(Effect.result, Effect.forkChild);
							yield* TestClock.adjust(0);
							yield* Deferred.succeed(f.prepared, undefined);
							yield* TestClock.adjust(0);
							yield* Deferred.succeed(release, undefined);
							yield* Fiber.join(holding);
							yield* TestClock.adjust("8 seconds");
							expect((yield* Fiber.join(stopping))._tag).toBe("Success");
							expect(
								yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE retired_at IS NULL`,
							).toEqual([]);
						}
						yield* Deferred.succeed(f.prepared, undefined);
						if (race === "send-after-commit") {
							yield* TestClock.adjust("1 millis");
							const proof = join(f.root, "swap-proof.jsonl");
							expect(
								existsSync(proof) &&
									readFileSync(proof, "utf8").includes("runner-swap-paused"),
							).toBe(true);
							const sending = yield* f
								.dispatch("swap-run")
								.pipe(Effect.forkChild);
							yield* TestClock.adjust(0);
							expect(
								f.commands.some((command) => command.type === "send-turn"),
							).toBe(false);
							rmSync(
								join(f.root, "conduit-test-hold-runner-swap-after-commit"),
							);
							yield* TestClock.adjust("20 millis");
							yield* Fiber.join(sending);
							expect(
								f.commands.filter((command) => command.type === "send-turn"),
							).toEqual([
								{
									runnerId: candidate.options.runnerId,
									type: "send-turn",
									runId: "swap-run",
								},
							]);
							expect(
								yield* f.sql`SELECT status, runner_id FROM provider_runs WHERE id = 'swap-run'`,
							).toEqual([
								{ status: "running", runner_id: candidate.options.runnerId },
							]);
						}
						yield* TestClock.adjust("4 seconds");
						if (
							race === "candidate-exits-before-recovery" ||
							race === "serving-row-without-registry"
						) {
							if (race === "candidate-exits-before-recovery")
								f.processes.delete(candidate.options.pid ?? 0);
							yield* Scope.close(f.managerScope, Exit.void);
							const restarted = yield* f.makeManager();
							yield* restarted.manager.recoverEffect;
							yield* admitRunnerCommand(
								restarted.admission,
								restarted.manager,
								{
									type: "send-turn",
									sinkId: "sink-after-recovery",
									aborted: false,
									input: {
										...f.input,
										inputId: "input-after-recovery",
										runId: "swap-run",
										prompt: "after recovery",
										history: [],
									},
								},
							);
							const delivered = f.commands.filter(
								(command) => command.type === "send-turn",
							);
							expect(delivered).toHaveLength(1);
							if (race === "candidate-exits-before-recovery")
								expect(delivered[0]?.runnerId).not.toBe(
									candidate.options.runnerId,
								);
							else
								expect(delivered[0]?.runnerId).toBe(candidate.options.runnerId);
							expect(
								yield* f.sql`SELECT status, runner_id FROM provider_runs WHERE id = 'swap-run'`,
							).toEqual([
								{ status: "running", runner_id: delivered[0]?.runnerId },
							]);
						} else if (race === "candidate-exits") {
							yield* f.dispatch("swap-run");
							f.processes.delete(candidate.options.pid ?? 0);
							candidate.options.onClose(
								runnerFailure("test exit", "candidate exited after swap"),
							);
							yield* TestClock.adjust("8 seconds");
							expect(
								yield* f.sql`SELECT status FROM provider_runs WHERE id = 'swap-run'`,
							).toEqual([{ status: "error" }]);
						} else if (
							![
								"send-after-commit",
								"plain-stop-during-commit",
								"retired-old-row",
								"cancel-lost",
							].includes(race)
						) {
							expect(
								yield* f.manager.getControlProcessIdEffect?.("s") ??
									Effect.die("missing control process API"),
							).toBe(f.old.options.runnerId);
							if (race !== "send-before")
								expect(f.commands).toContainEqual({
									runnerId: f.old.options.runnerId,
									type: "upgrade-cancel",
								});
							if (race !== "send-before") yield* f.dispatch("swap-run");
							expect(
								yield* f.sql`SELECT status, runner_id FROM provider_runs WHERE id = 'swap-run'`,
							).toEqual([
								{ status: "running", runner_id: f.old.options.runnerId },
							]);
							expect(
								f.commands.filter((command) => command.type === "send-turn"),
							).toEqual([
								{
									runnerId: f.old.options.runnerId,
									type: "send-turn",
									runId: "swap-run",
								},
							]);
						}
						if (race === "cancel-lost") {
							expect(
								yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${f.old.options.runnerId} AND retired_at IS NULL`,
							).toEqual([]);
							expect(
								yield* f.sql`SELECT status FROM provider_runs WHERE id = 'swap-run'`,
							).toEqual([{ status: "pending" }]);
						}
						if (race === "retired-old-row") {
							expect(f.commands).toContainEqual({
								runnerId: f.old.options.runnerId,
								type: "upgrade-cancel",
							});
							expect(
								f.commands.filter(
									(command) =>
										command.runnerId === candidate.options.runnerId &&
										(command.type === "upgrade-activate" ||
											command.type === "send-turn"),
								),
							).toEqual([]);
							expect(
								yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE retired_at IS NULL`,
							).toEqual([]);
							expect(
								yield* f.sql`SELECT stop_reason FROM claude_runner_cursors WHERE runner_id = ${f.old.options.runnerId}`,
							).toEqual([{ stop_reason: '{"_tag":"Explicit"}' }]);
							expect(
								yield* f.sql`SELECT status FROM provider_runs WHERE id = 'swap-run'`,
							).toEqual([{ status: "pending" }]);
						}
					}
					expect(
						(yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE session_id = 's' AND retired_at IS NULL AND role = 'serving'`)
							.length,
					).toBeLessThanOrEqual(1);
				}),
			),
	);

for (const retired of [true, false])
	it.effect(
		`recovers valid retired runners while retaining a malformed ${retired ? "retirement" : "ownership"} row`,
		() => {
			const warnings: unknown[] = [];
			return run(
				Effect.gen(function* () {
					const f = yield* setup;
					const bad = yield* f.register("badbadbadbad", 100_051, { retired });
					if (retired)
						yield* f.sql`UPDATE claude_runner_cursors SET signal_members = '{}' WHERE runner_id = ${bad.runnerId}`;
					else
						yield* f.sql`UPDATE claude_runner_cursors SET owned_run_ids = '{}' WHERE runner_id = ${bad.runnerId}`;
					const before =
						yield* f.sql`SELECT * FROM claude_runner_cursors WHERE runner_id = ${bad.runnerId}`;
					const valid = yield* f.register("abcabcabcabc", 100_052, {
						ownedRunIds: ["valid-run"],
					});
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('valid-run', 's', 'running', 1)`;
					yield* f.recover;
					expect(f.connect).not.toHaveBeenCalled();
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'valid-run'`,
					).toEqual([{ status: "running" }]);
					f.processes.set(valid.pid, { state: "gone" });
					yield* TestClock.adjust("60 seconds");
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'valid-run'`,
					).toEqual([{ status: "interrupted" }]);
					expect(
						yield* f.sql`SELECT * FROM claude_runner_cursors WHERE runner_id = ${bad.runnerId}`,
					).toEqual(before);
					expect(warnings).toHaveLength(1);
					expect(warnings[0]).toEqual(
						expect.arrayContaining([
							expect.stringContaining(bad.runnerId),
							expect.objectContaining({
								_tag: "RunnerRetirementDecodeError",
								runnerId: bad.runnerId,
							}),
						]),
					);
					f.processes.set(valid.pid, { state: "gone" });
					yield* TestClock.adjust("10 seconds");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${valid.runnerId}`,
					).toEqual([]);
					expect(
						yield* f.sql`SELECT * FROM claude_runner_cursors WHERE runner_id = ${bad.runnerId}`,
					).toEqual(before);
				}),
			).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make((options) => {
							if (options.logLevel === "Warn") warnings.push(options.message);
						}),
					]),
				),
			);
		},
	);

it.effect(
	"keeps a corrupted watched retirement untouched until a later valid pass",
	() => {
		const warnings: unknown[] = [];
		return run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("defdefdefdef", 100_053);
				yield* f.recover;
				yield* f.sql`UPDATE claude_runner_cursors SET signal_members = '{}' WHERE runner_id = ${entry.runnerId}`;
				const before =
					yield* f.sql`SELECT * FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`;
				f.processes.set(entry.pid, { state: "gone" });
				yield* TestClock.adjust("10 seconds");
				expect(
					yield* f.sql`SELECT * FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual(before);
				expect(warnings).toHaveLength(1);
				yield* f.sql`UPDATE claude_runner_cursors SET signal_members = '[]' WHERE runner_id = ${entry.runnerId}`;
				yield* TestClock.adjust("20 seconds");
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual([]);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn") warnings.push(options.message);
					}),
				]),
			),
		);
	},
);

it.effect(
	"waits for child exit and batches descendant checks before escalation",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				f.connect.mockImplementation((options) =>
					Effect.gen(function* () {
						const connection = {
							closed: false,
							commandEffect: () => Effect.void,
							destroy: () => {},
							write: () => {},
						} as unknown as RunnerSocket;
						yield* options.onHello(
							{
								type: "hello",
								protocolVersion: 1,
								buildId: runnerBuildId(),
								stampsRunIds: true,
								runnerId: options.runnerId,
								sessionId: "s",
								pid: options.pid ?? 0,
								bindings: [],
								sendJournalAnswers: true,
								sendAnswers: [],
							},
							connection,
						);
						return connection;
					}),
				);
				yield* f.manager.executeEffect({
					type: "pre-warm",
					sessionId: "s",
					input: {
						sessionId: "s",
						workspaceRoot: f.root,
						extraFolders: [],
						providerState: {},
						configDir: configuredClaudeConfigDir(f.root),
					},
				});
				const [pid, child] = [...f.children][0] ?? [];
				if (pid === undefined || !child)
					return yield* Effect.fail(
						runnerFailure("test child", "Missing child"),
					);
				const members = [
					{ pid, startTime: `spawned-${pid}` },
					{ pid: 100_061, startTime: "descendant" },
					{ pid: 100_062, startTime: "reused" },
				];
				f.groups.set(pid, members);
				for (const member of members)
					f.processes.set(member.pid, {
						state: "running",
						startTime: member.startTime,
					});
				f.signal.mockImplementation((target, signal) => {
					f.signals.push({ pid: target, signal });
					if (signal === "SIGKILL") f.processes.set(target, { state: "gone" });
				});
				const stopping = yield* f.manager
					.executeEffect({ type: "end-session", sessionId: "s" })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const inspections = f.inspect.mock.calls.length;
				const batches = f.inspectMany.mock.calls.length;
				yield* TestClock.adjust("2 seconds");
				expect(f.inspect.mock.calls.length).toBe(inspections);
				expect(f.inspectMany.mock.calls.length).toBe(batches);
				f.processes.set(pid, { state: "gone" });
				f.processes.set(100_062, {
					state: "running",
					startTime: "new-process",
				});
				child.emit("exit", 0, null);
				yield* TestClock.adjust("500 millis");
				expect(stopping.pollUnsafe()).toBeUndefined();
				expect(f.inspect.mock.calls.length).toBe(inspections);
				expect(f.inspectMany.mock.calls.length - batches).toBeLessThanOrEqual(
					3,
				);
				expect(f.inspectMany.mock.calls.at(-1)?.[0]).toEqual(
					members.map((member) => member.pid),
				);
				// Observe the four-second Stop bound independently of jittered polling.
				yield* TestClock.adjust("1500 millis");
				expect(stopping.pollUnsafe()).toBeDefined();
				yield* Fiber.join(stopping);
				expect(
					f.signals.filter((signal) => signal.signal === "SIGKILL"),
				).toEqual([{ pid: 100_061, signal: "SIGKILL" }]);
			}).pipe(
				Effect.provideService(Random.Random, {
					nextIntUnsafe: () => 0,
					nextDoubleUnsafe: () => 0.999,
				}),
			),
		),
);

for (const pin of ["leader", "reaper"] as const)
	it.effect(
		`rejects a reused group when the final ${pin} exits during enumeration`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const leader = yield* f.register("abcabcabc099", 100_090);
					const reaper = { pid: 100_091, startTime: "original-reaper" };
					if (pin === "reaper") {
						yield* f.sql`UPDATE claude_runner_cursors SET reaper_pid = ${reaper.pid}, reaper_start_time = ${reaper.startTime} WHERE runner_id = ${leader.runnerId}`;
						f.processes.set(leader.pid, { state: "gone" });
						f.processes.set(reaper.pid, {
							state: "running",
							startTime: reaper.startTime,
							pgid: leader.pid,
						});
					} else
						f.processes.set(leader.pid, {
							state: "running",
							startTime: "original",
							pgid: leader.pid,
						});
					const unrelated = [
						{ pid: leader.pid, startTime: "unrelated-leader" },
						{ pid: 100_092, startTime: "unrelated-child" },
					];
					f.members.mockImplementation(() => {
						if (pin === "reaper")
							f.processes.set(reaper.pid, { state: "gone" });
						for (const member of unrelated)
							f.processes.set(member.pid, {
								state: "running",
								startTime: member.startTime,
								pgid: leader.pid,
							});
						return unrelated;
					});
					yield* f.recover;
					const rows = yield* f.sql<{
						member_snapshot: string;
					}>`SELECT member_snapshot FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`;
					expect(
						rows.some((row) => row.member_snapshot.includes("unrelated")),
					).toBe(false);
					yield* TestClock.adjust("60 seconds");
					expect(f.signals).toEqual([]);
					for (const member of unrelated)
						expect(f.processes.get(member.pid)).toMatchObject({
							state: "running",
							startTime: member.startTime,
						});
				}),
			),
	);

it.effect(
	"finishes committed registered escalation while retaining a descendant that refuses KILL",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const leader = yield* f.register("abcabcabc098", 100_093, {
					retired: false,
				});
				const descendant = { pid: 100_094, startTime: "descendant" };
				f.groups.set(leader.pid, [
					{ pid: leader.pid, startTime: "original" },
					descendant,
				]);
				f.processes.set(leader.pid, {
					state: "running",
					startTime: "original",
					pgid: leader.pid,
				});
				f.processes.set(descendant.pid, {
					state: "running",
					startTime: descendant.startTime,
					pgid: leader.pid,
				});
				const connection = new RunnerSocket(
					new Socket(),
					() => {},
					() => {},
				);
				yield* Effect.acquireRelease(
					Effect.sync(() => [
						vi
							.spyOn(RunnerConnection, "connectRunner")
							.mockReturnValue(Effect.succeed(connection)),
						vi.spyOn(connection, "commandEffect").mockImplementation(() =>
							Effect.sync(() => {
								f.processes.set(leader.pid, { state: "gone" });
								return undefined;
							}),
						),
						vi
							.spyOn(runnerProcessTable, "inspect")
							.mockImplementation(f.inspect),
						vi
							.spyOn(runnerProcessTable, "inspectMany")
							.mockImplementation(f.inspectMany),
						vi
							.spyOn(runnerProcessTable, "members")
							.mockImplementation(f.members),
						vi
							.spyOn(runnerProcessTable, "signal")
							.mockImplementation((pid, signal) => {
								f.signals.push({ pid, signal });
								if (signal === "SIGKILL")
									throw runnerFailure("test signal", "KILL refused");
							}),
					]),
					(values) =>
						Effect.sync(() => {
							for (const spy of values.reverse()) spy.mockRestore();
						}),
				);
				const stopping = yield* Effect.forkChild(
					Effect.result(stopRegisteredRunners(f.root, f.root)),
				);
				yield* TestClock.adjust("6 seconds");
				const result = yield* Fiber.join(stopping);
				// STOP-INTENT S4: a committed waiter cannot fail after escalation.
				expect(result._tag).toBe("Success");
				expect(f.signals).toContainEqual({
					pid: descendant.pid,
					signal: "SIGKILL",
				});
				expect(f.processes.get(descendant.pid)?.state).toBe("running");
				const rows = yield* f.sql<{
					member_snapshot: string;
				}>`SELECT member_snapshot FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`;
				expect(rows).toHaveLength(1);
				expect(rows[0]?.member_snapshot).toContain(descendant.startTime);
			}),
		),
);

it.effect("shared fixture cleanup never signals a reused runner PID", () =>
	run(
		Effect.gen(function* () {
			const f = yield* setup;
			const pid = 100_095;
			let alive = true;
			const signals: Array<string | number> = [];
			const nativeKill = process.kill;
			yield* Effect.acquireRelease(
				Effect.sync(() => [
					vi.spyOn(runnerProcessTable, "inspect").mockReturnValue({
						state: "running",
						startTime: "unrelated-process",
					}),
					vi.spyOn(runnerProcessTable, "inspectMany").mockImplementation(
						(pids) =>
							new Map(
								pids.map((target) => [
									target,
									{
										state: "running" as const,
										startTime: "unrelated-process",
									},
								]),
							),
					),
					vi.spyOn(process, "kill").mockImplementation((target, signal) => {
						if (target !== pid) return nativeKill.call(process, target, signal);
						if (signal === 0) {
							if (alive) return true;
							throw runnerFailure("fixture probe", "Process gone");
						}
						signals.push(signal ?? "SIGTERM");
						alive = false;
						return true;
					}),
				]),
				(spies) =>
					Effect.sync(() => {
						for (const spy of spies.reverse()) spy.mockRestore();
					}),
			);
			const cleaned = yield* Effect.tryPromise(() =>
				cleanupTestClaudeRunners(
					f.root,
					[pid],
					f.root,
					f.root,
					new Map([[pid, "original-process"]]),
				),
			);
			expect(signals).toEqual([]);
			expect(alive).toBe(true);
			expect(cleaned.remainingPids).toEqual([]);
		}),
	),
);

// A failed listing must not make escalation kill only the pins and orphan a child.
for (const pin of ["leader", "reaper", "both"] as const)
	it.effect(
		`kills the whole group with an unavailable listing and ${pin} pin`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const leader = yield* f.register("bcbcbcbcbcbc", 100_096);
					const reaper = { pid: 100_097, startTime: "reaper" };
					const descendant = { pid: 100_098, startTime: "unlisted-child" };
					if (pin !== "leader") {
						yield* f.sql`UPDATE claude_runner_cursors SET reaper_pid = ${reaper.pid}, reaper_start_time = ${reaper.startTime} WHERE runner_id = ${leader.runnerId}`;
						f.processes.set(reaper.pid, {
							state: "running",
							startTime: reaper.startTime,
							pgid: leader.pid,
						});
					}
					f.processes.set(
						leader.pid,
						pin === "reaper"
							? { state: "gone" }
							: {
									state: "running",
									startTime: "original",
									pgid: leader.pid,
								},
					);
					f.processes.set(descendant.pid, {
						state: "running",
						startTime: descendant.startTime,
						pgid: leader.pid,
					});
					f.members.mockReturnValue(undefined);
					f.signal.mockImplementation((pid, signal) => {
						f.signals.push({ pid, signal });
						if (pid === -leader.pid)
							for (const member of [leader, reaper, descendant])
								f.processes.set(member.pid, { state: "gone" });
						else f.processes.set(pid, { state: "gone" });
					});
					yield* f.recover;
					yield* TestClock.adjust("8 seconds");
					expect(f.signals).toEqual([{ pid: -leader.pid, signal: "SIGKILL" }]);
					expect(f.processes.get(descendant.pid)?.state).toBe("gone");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
					).toEqual([]);
				}),
			),
	);

it.effect(
	"uses a verified reaper to pin and refresh the group after its leader exits",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const leader = yield* f.register("acacacacacac", 100_085);
				const reaper = { pid: 100_086, startTime: "reaper" };
				const descendant = { pid: 100_087, startTime: "descendant" };
				yield* f.sql`UPDATE claude_runner_cursors SET reaper_pid = ${reaper.pid}, reaper_start_time = ${reaper.startTime} WHERE runner_id = ${leader.runnerId}`;
				f.processes.set(leader.pid, { state: "gone" });
				f.processes.set(reaper.pid, {
					state: "running",
					startTime: reaper.startTime,
					pgid: leader.pid,
				});
				f.processes.set(descendant.pid, {
					state: "running",
					startTime: descendant.startTime,
					pgid: leader.pid,
				});
				f.groups.set(leader.pid, [reaper, descendant]);
				yield* f.recover;
				const [row] = yield* f.sql<{
					member_snapshot: string;
				}>`SELECT member_snapshot FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`;
				expect(JSON.parse(row?.member_snapshot ?? "[]")).toEqual([
					{ pid: leader.pid, startTime: "original" },
					reaper,
					descendant,
				]);
				f.signal.mockImplementation((pid, signal) => {
					f.signals.push({ pid, signal });
					for (const member of [reaper, descendant])
						f.processes.set(member.pid, { state: "gone" });
				});
				yield* TestClock.adjust("8 seconds");
				expect(f.signals).toEqual([{ pid: -leader.pid, signal: "SIGKILL" }]);
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
				).toEqual([]);
			}),
		),
);

for (const mismatch of ["start", "group", "unknown"])
	it.effect(
		`does not signal or pin a reaper with a ${mismatch} observation`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const leader = yield* f.register("adadadadadad", 100_088);
					yield* f.sql`UPDATE claude_runner_cursors SET reaper_pid = 100089, reaper_start_time = 'reaper' WHERE runner_id = ${leader.runnerId}`;
					f.processes.set(leader.pid, { state: "gone" });
					f.processes.set(
						100_089,
						mismatch === "unknown"
							? { state: "unknown" }
							: {
									state: "running",
									startTime: mismatch === "start" ? "reused" : "reaper",
									pgid: 999_999,
								},
					);
					f.groups.set(leader.pid, []);
					yield* f.recover;
					yield* TestClock.adjust("2 minutes");
					expect(f.signals).toEqual([]);
					if (mismatch !== "start")
						expect(
							yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
						).toHaveLength(1);
				}),
			),
	);

it.effect(
	"delivers a group KILL without waiting for growing membership to stabilize",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const leader = yield* f.register("bdbdbdbdbdbd", 100_099);
				f.processes.set(leader.pid, {
					state: "running",
					startTime: "original",
					pgid: leader.pid,
				});
				yield* f.recover;
				const members = [{ pid: leader.pid, startTime: "original" }];
				let reads = 0;
				let readsAtSignal = 0;
				f.members.mockImplementation(() => {
					// Bound the faulty implementation's recursion so red fails promptly.
					if (!f.signals.length && reads < 12) {
						reads++;
						const child = { pid: 100_100 + reads, startTime: `child-${reads}` };
						members.push(child);
						f.processes.set(child.pid, {
							state: "running",
							startTime: child.startTime,
							pgid: leader.pid,
						});
					}
					return [...members];
				});
				f.signal.mockImplementation((pid, signal) => {
					readsAtSignal = reads;
					f.signals.push({ pid, signal });
					throw runnerFailure("test signal", "Refused");
				});
				yield* TestClock.adjust("8 seconds");
				expect(f.signals).toEqual([{ pid: -leader.pid, signal: "SIGKILL" }]);
				expect(readsAtSignal).toBe(2);
				const [row] = yield* f.sql<{
					member_snapshot: string;
					signal_log: string;
				}>`SELECT member_snapshot, signal_log FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`;
				expect(JSON.parse(row?.member_snapshot ?? "[]")).toEqual(members);
				expect(JSON.parse(row?.signal_log ?? "[]")).toEqual([
					{
						signal: "SIGKILL",
						target: -leader.pid,
						members,
						outcome: "failed",
					},
				]);
			}),
		),
);

// A post-COMMIT fork must survive a failed signal-log append in the durable
// snapshot. Losing the pin during its second commit must fall back to that set.
for (const losePin of [false, true])
	it.effect(
		`commits rechecked descendants before delivery even if the signal log fails, losePin=${losePin}`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const leader = yield* f.register("cdcdcdcdcdcd", 100_110);
					const original = { pid: leader.pid, startTime: "original" };
					const child = { pid: 100_111, startTime: "post-commit-child" };
					f.processes.set(leader.pid, {
						state: "running",
						startTime: original.startTime,
						pgid: leader.pid,
					});
					yield* f.recover;
					let reads = 0;
					f.members.mockImplementation(() => {
						reads++;
						if (reads === 1) return [original];
						if (reads === 2)
							f.processes.set(child.pid, {
								state: "running",
								startTime: child.startTime,
								pgid: leader.pid,
							});
						return [original, child];
					});
					let checks = 0;
					f.inspectMany.mockImplementation((pids) => {
						if (++checks === 3 && losePin)
							f.processes.set(leader.pid, { state: "gone" });
						return new Map(
							pids.map((pid) => [
								pid,
								f.processes.get(pid) ?? { state: "gone" as const },
							]),
						);
					});
					yield* f.sql`CREATE TRIGGER fail_signal_log BEFORE UPDATE OF signal_log ON claude_runner_cursors
					WHEN NEW.signal_log != '[]' BEGIN SELECT RAISE(ABORT, 'signal log unavailable'); END`;
					f.signal.mockImplementation((pid, signal) => {
						f.signals.push({ pid, signal });
						f.processes.set(leader.pid, { state: "gone" });
					});
					yield* TestClock.adjust("8 seconds");
					expect(f.signals).toEqual([
						{ pid: losePin ? child.pid : -leader.pid, signal: "SIGKILL" },
					]);
					const [row] = yield* f.sql<{
						member_snapshot: string;
						signal_log: string;
					}>`SELECT member_snapshot, signal_log FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`;
					expect(JSON.parse(row?.member_snapshot ?? "[]")).toEqual([
						original,
						child,
					]);
					expect(JSON.parse(row?.signal_log ?? "[]")).toEqual([]);
					expect(reads).toBe(2);
					expect(f.processes.get(child.pid)?.state).toBe("running");
					yield* f.sql`DROP TRIGGER fail_signal_log`;
					f.signal.mockImplementation((pid, signal) => {
						f.signals.push({ pid, signal });
						f.processes.set(pid, { state: "gone" });
					});
					yield* TestClock.adjust("20 seconds");
					expect(f.signals).toContainEqual({
						pid: child.pid,
						signal: "SIGKILL",
					});
					expect(f.processes.get(child.pid)?.state).toBe("gone");
				}),
			),
	);

it.effect("commits a fresh watcher snapshot before a refused group KILL", () =>
	run(
		Effect.gen(function* () {
			const f = yield* setup;
			const leader = yield* f.register("fefefefefefe", 100_081);
			const members = [
				{ pid: leader.pid, startTime: "original" },
				{ pid: 100_082, startTime: "descendant" },
			];
			f.groups.set(leader.pid, members);
			f.processes.set(100_082, { state: "running", startTime: "descendant" });
			f.signal.mockImplementation(() => {
				throw runnerFailure("test signal", "Refused");
			});
			yield* f.recover;
			yield* TestClock.adjust("8 seconds");
			const [row] = yield* f.sql<{
				member_snapshot: string;
				signal_log: string;
				retired_at: number;
			}>`SELECT member_snapshot, signal_log, retired_at FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`;
			expect(row?.retired_at).not.toBeNull();
			expect(JSON.parse(row?.member_snapshot ?? "[]")).toEqual(members);
			expect(JSON.parse(row?.signal_log ?? "[]")).toMatchObject([
				{ signal: "SIGKILL", target: -leader.pid, outcome: "failed" },
			]);
			f.processes.set(leader.pid, { state: "gone" });
			f.signal.mockImplementation((pid, signal) => {
				f.signals.push({ pid, signal });
				f.processes.set(pid, { state: "gone" });
			});
			yield* TestClock.adjust("20 seconds");
			expect(f.signals).toContainEqual({ pid: 100_082, signal: "SIGKILL" });
			expect(
				yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
			).toEqual([]);
		}),
	),
);

it.effect("recovers a phase-2 Stop snapshot whose retired_at was NULL", () =>
	run(
		Effect.gen(function* () {
			const f = yield* setup;
			const leader = yield* f.register("edededededed", 100_083);
			const members = [
				{ pid: leader.pid, startTime: "original" },
				{ pid: 100_084, startTime: "descendant" },
			];
			yield* f.sql`UPDATE claude_runner_cursors SET retired_at = NULL, signal_state = 'TermSent', signal_members = ${JSON.stringify(members)} WHERE runner_id = ${leader.runnerId}`;
			f.processes.set(leader.pid, { state: "gone" });
			f.processes.set(100_084, { state: "running", startTime: "descendant" });
			f.signal.mockImplementation((pid, signal) => {
				f.signals.push({ pid, signal });
				f.processes.set(pid, { state: "gone" });
			});
			yield* f.recover;
			yield* TestClock.adjust("8 seconds");
			expect(f.signals).toContainEqual({ pid: 100_084, signal: "SIGKILL" });
			expect(
				yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
			).toEqual([]);
		}),
	),
);

// A failed request has no durable intent. Only another explicit Stop may retry it.
it.effect(
	"STOP-INTENT failed commit leaves accepted runs serving until an explicit retry",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* stopIntentFixture;
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('first-run', 's', 'running', 1), ('second-run', 's', 'running', 2)`;
				yield* f.dispatch("first-run");
				f.accept("first-run");
				yield* f.sql`CREATE TABLE stop_commit_parent (id TEXT PRIMARY KEY)`;
				yield* f.sql`CREATE TABLE stop_commit_check (id TEXT REFERENCES stop_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
				yield* f.sql`CREATE TRIGGER fail_stop_commit BEFORE INSERT ON claude_runner_cursors
		WHEN NEW.retired_at IS NOT NULL BEGIN INSERT INTO stop_commit_check VALUES ('missing'); END`;
				const first = yield* f.stop.pipe(Effect.result, Effect.forkChild);
				const concurrent = yield* f.stop.pipe(Effect.result, Effect.forkChild);
				yield* TestClock.adjust("2 seconds");
				for (const waiter of [first, concurrent]) {
					expect(waiter.pollUnsafe()).toBeDefined();
					const result = yield* Fiber.join(waiter);
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure")
						expect(result.failure).toMatchObject({
							operation: "stop runner",
						});
				}
				expect(f.signals).toEqual([]);
				expect(f.commands.some((command) => command.type === "shutdown")).toBe(
					false,
				);
				expect(
					yield* f.manager.hasLiveProcessEffect("s", f.runner.runnerId),
				).toBe(true);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'first-run'`,
				).toEqual([{ status: "running" }]);
				yield* f.sql`DROP TRIGGER fail_stop_commit`;
				yield* TestClock.adjust("60 seconds");
				expect(f.signals).toEqual([]);
				expect(f.commands.some((command) => command.type === "shutdown")).toBe(
					false,
				);
				yield* f.dispatch("second-run");
				f.accept("second-run");
				expect(f.connections).toHaveLength(1);
				expect(
					f.commands
						.filter((command) => command.type === "send-turn")
						.map((command) => command.runId),
				).toEqual(["first-run", "second-run"]);
				f.exitOnSignal();
				const retry = yield* f.stop.pipe(Effect.result, Effect.forkChild);
				yield* TestClock.adjust("12 seconds");
				expect((yield* Fiber.join(retry))._tag).toBe("Success");
				expect(
					yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "first-run", status: "interrupted" },
					{ id: "second-run", status: "interrupted" },
				]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
				).toHaveLength(2);
			}),
		),
);

it.effect(
	"STOP-INTENT rejected own row fails without shutdown, signals or lost run ownership",
	() => {
		const warnings: unknown[] = [];
		return run(
			Effect.gen(function* () {
				const f = yield* stopIntentFixture;
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('rejected-run', 's', 'running', 1)`;
				yield* f.dispatch("rejected-run");
				f.accept("rejected-run");
				yield* f.sql`UPDATE claude_runner_cursors SET member_snapshot = '{}' WHERE runner_id = ${f.runner.runnerId}`;
				const before =
					yield* f.sql`SELECT * FROM claude_runner_cursors WHERE runner_id = ${f.runner.runnerId}`;
				const stopping = yield* f.stop.pipe(Effect.result, Effect.forkChild);
				yield* TestClock.adjust("6 seconds");
				expect(stopping.pollUnsafe()).toBeDefined();
				const result = yield* Fiber.join(stopping);
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure")
					expect(result.failure).toMatchObject({ operation: "stop runner" });
				expect(f.signals).toEqual([]);
				expect(f.commands.some((command) => command.type === "shutdown")).toBe(
					false,
				);
				expect(
					yield* f.manager.hasLiveProcessEffect("s", f.runner.runnerId),
				).toBe(true);
				expect(
					yield* f.sql`SELECT * FROM claude_runner_cursors WHERE runner_id = ${f.runner.runnerId}`,
				).toEqual(before);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'rejected-run'`,
				).toEqual([{ status: "running" }]);
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('after-rejection', 's', 'running', 2)`;
				yield* f.dispatch("after-rejection");
				f.accept("after-rejection");
				expect(f.connections).toHaveLength(1);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([
					{
						runnerId: f.runner.runnerId,
						type: "send-turn",
						runId: "rejected-run",
					},
					{
						runnerId: f.runner.runnerId,
						type: "send-turn",
						runId: "after-rejection",
					},
				]);
				expect(
					yield* f.sql`SELECT runner_id, status FROM provider_runs WHERE id = 'after-rejection'`,
				).toEqual([{ runner_id: f.runner.runnerId, status: "running" }]);
				expect(f.signals).toEqual([]);
				expect(f.commands.some((command) => command.type === "shutdown")).toBe(
					false,
				);
				expect(
					warnings.some((message) =>
						JSON.stringify(message).includes(f.runner.runnerId),
					),
				).toBe(true);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn") warnings.push(options.message);
					}),
				]),
			),
		);
	},
);

it.effect(
	"STOP-INTENT racing Stops join one blocked commit and settle their held run once",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* stopIntentFixture;
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('joined-run', 's', 'running', 1)`;
				yield* f.dispatch("joined-run");
				f.accept("joined-run");
				const receipts = f.runner.receipts;
				if (!receipts) return yield* Effect.die("missing stop-intent receipts");
				const request = vi.spyOn(receipts, "requestStop");
				const writer = yield* makeCommitAndSignal;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const held = yield* writer
					.write(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				f.exitOnSignal();
				yield* Effect.gen(function* () {
					const first = yield* f.stop.pipe(Effect.result, Effect.forkChild);
					const second = yield* f.stop.pipe(Effect.result, Effect.forkChild);
					yield* TestClock.adjust(0);
					expect(first.pollUnsafe()).toBeUndefined();
					expect(second.pollUnsafe()).toBeUndefined();
					expect(f.signals).toEqual([]);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(held);
					yield* TestClock.adjust("12 seconds");
					expect((yield* Fiber.join(first))._tag).toBe("Success");
					expect((yield* Fiber.join(second))._tag).toBe("Success");
					expect(request).toHaveBeenCalledTimes(1);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'joined-run'`,
					).toEqual([{ status: "interrupted" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
					).toHaveLength(1);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

// Failures after the intent commits retain its fence and retry on the same manager.
for (const write of ["signal log", "Gone", "settlement", "prune"] as const)
	it.effect(
		`STOP-INTENT retries a failed ${write} write without failing committed Stop waiters`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* stopIntentFixture;
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('retry-run', 's', 'running', 1)`;
					yield* f.dispatch("retry-run");
					f.accept("retry-run");
					yield* f.sql`CREATE TABLE postcommit_parent (id TEXT PRIMARY KEY)`;
					yield* f.sql`CREATE TABLE postcommit_check (id TEXT REFERENCES postcommit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
					if (write === "signal log")
						yield* f.sql`CREATE TRIGGER fail_postcommit AFTER UPDATE OF signal_log ON claude_runner_cursors
			WHEN OLD.retired_at IS NOT NULL AND NEW.signal_log <> OLD.signal_log BEGIN INSERT INTO postcommit_check VALUES ('missing'); END`;
					if (write === "Gone")
						yield* f.sql`CREATE TRIGGER fail_postcommit AFTER UPDATE OF stop_state ON claude_runner_cursors
			WHEN NEW.stop_state = 'Gone' BEGIN INSERT INTO postcommit_check VALUES ('missing'); END`;
					if (write === "settlement")
						yield* f.sql`CREATE TRIGGER fail_postcommit AFTER UPDATE OF status ON provider_runs
			WHEN NEW.id = 'retry-run' AND NEW.status <> 'running' BEGIN INSERT INTO postcommit_check VALUES ('missing'); END`;
					if (write === "prune")
						yield* f.sql`CREATE TRIGGER fail_postcommit BEFORE DELETE ON claude_runner_cursors
			BEGIN INSERT INTO postcommit_check VALUES ('missing'); END`;
					f.exitOnSignal();
					const stopping = yield* f.stop.pipe(Effect.result, Effect.forkChild);
					yield* TestClock.adjust("12 seconds");
					expect(stopping.pollUnsafe()).toBeDefined();
					expect((yield* Fiber.join(stopping))._tag).toBe("Success");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${f.runner.runnerId} AND retired_at IS NOT NULL`,
					).toHaveLength(1);
					yield* f.sql`DROP TRIGGER fail_postcommit`;
					yield* TestClock.adjust("70 seconds");
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'retry-run'`,
					).toEqual([{ status: "interrupted" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
					).toHaveLength(1);
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${f.runner.runnerId}`,
					).toEqual([]);
				}),
			),
	);

it.effect(
	"STOP-INTENT a runner exiting during Committing settles its held run after the commit",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* stopIntentFixture;
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('exit-run', 's', 'running', 1)`;
				yield* f.dispatch("exit-run");
				f.accept("exit-run");
				const writer = yield* makeCommitAndSignal;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const held = yield* writer
					.write(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* Effect.gen(function* () {
					const stopping = yield* f.stop.pipe(Effect.result, Effect.forkChild);
					yield* TestClock.adjust(0);
					const pid = f.runner.pid;
					if (!pid) return yield* Effect.die("missing stop-intent PID");
					f.processes.set(pid, { state: "gone" });
					const child = f.children.get(pid);
					if (!child) return yield* Effect.die("missing stop-intent child");
					Object.assign(child, { exitCode: 0 });
					child.emit("exit", 0, null);
					yield* TestClock.adjust(0);
					expect(f.signals).toEqual([]);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(held);
					yield* TestClock.adjust("12 seconds");
					expect((yield* Fiber.join(stopping))._tag).toBe("Success");
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'exit-run'`,
					).toEqual([{ status: "interrupted" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
					).toHaveLength(1);
					expect(f.signals).toEqual([]);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

it.effect(
	"STOP-INTENT preserves a native success whose SQL write entered before Stop",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* stopIntentFixture;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('native-run', 's', 'running', 1)`;
				yield* f.dispatch("native-run");
				f.accept("native-run");
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				f.output.mockImplementation((output) =>
					Effect.gen(function* () {
						if (output.type === "event")
							yield* ingestion
								.ingestBatch([output.event], {
									beforeProject: Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
									),
								})
								.pipe(
									Effect.mapError((cause) =>
										runnerFailure("test ingest", cause),
									),
								);
						return {};
					}),
				);
				const native = yield* f.runner
					.emit(
						{
							type: "event",
							sinkId: "sink-native-run",
							event: {
								eventId: "native-before-stop",
								type: "turn.completed",
								providerId: "claude",
								sessionId: "s",
								runId: "native-run",
								providerRefs: {},
								rawSource: { kind: "test" },
								createdAt: 2,
								data: {},
							},
						},
						"s",
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				f.exitOnSignal();
				yield* Effect.gen(function* () {
					const stopping = yield* f.stop.pipe(Effect.result, Effect.forkChild);
					yield* TestClock.adjust("5 seconds");
					expect(stopping.pollUnsafe()).toBeUndefined();
					expect(f.signals).toEqual([]);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(native);
					yield* TestClock.adjust("12 seconds");
					expect((yield* Fiber.join(stopping))._tag).toBe("Success");
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'native-run'`,
					).toEqual([{ status: "completed" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.interrupted', 'turn.error')`,
					).toEqual([{ type: "turn.completed" }]);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

for (const first of ["send", "Stop"] as const)
	it.effect(
		`STOP-INTENT ${first} wins the SQL writer before a racing ${first === "send" ? "Stop" : "send"}`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* stopIntentFixture;
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('racing-run', 's', 'running', 1)`;
					yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'input-racing-run', 'test-project', 's', 'claude', 'send_turn', 'racing-run', '{"sessionId":"s","inputId":"input-racing-run"}', 'running', 1, 1, 1)`;
					if (first === "Stop")
						yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
						VALUES (2, 'stop-racing-run', 'test-project', 's', 'claude', 'end_session', '{"type":"end_session","sessionId":"s","commandId":"stop-racing-run","stop":{"owners":[{"runId":"racing-run"}],"targets":[],"retained":[]}}', 'running', 1, 2, 2)`;
					const writer = yield* makeCommitAndSignal;
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const held = yield* writer
						.write(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						)
						.pipe(Effect.forkChild);
					yield* Deferred.await(entered);
					f.exitOnSignal();
					yield* Effect.gen(function* () {
						const sending =
							first === "send"
								? yield* f
										.dispatch("racing-run")
										.pipe(Effect.result, Effect.forkChild)
								: undefined;
						yield* TestClock.adjust(0);
						if (first === "Stop") f.runner.onIdleExit?.();
						const stopping = yield* f.stop.pipe(
							Effect.result,
							Effect.forkChild,
						);
						yield* TestClock.adjust(0);
						const lateSend =
							first === "Stop"
								? yield* f
										.dispatch("racing-run")
										.pipe(Effect.result, Effect.forkChild)
								: undefined;
						yield* TestClock.adjust(0);
						expect(
							f.commands.some((command) => command.type === "send-turn"),
						).toBe(false);
						expect(f.signals).toEqual([]);
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.join(held);
						yield* TestClock.adjust("12 seconds");
						expect((yield* Fiber.join(stopping))._tag).toBe("Success");
						const send = sending ?? lateSend;
						if (!send) return yield* Effect.die("missing racing send");
						yield* Fiber.join(send);
						const received = f.commands.filter(
							(command) =>
								command.type === "send-turn" && command.runId === "racing-run",
						);
						if (first === "send") {
							expect(received).toEqual([
								{
									runnerId: f.runner.runnerId,
									type: "send-turn",
									runId: "racing-run",
								},
							]);
							expect(
								yield* f.sql`SELECT status, runner_id FROM provider_runs WHERE id = 'racing-run'`,
							).toEqual([
								{ status: "interrupted", runner_id: f.runner.runnerId },
							]);
							expect(
								yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
							).toHaveLength(1);
						} else {
							expect(received).toEqual([]);
							expect(
								yield* f.sql`SELECT status, runner_id FROM provider_runs WHERE id = 'racing-run'`,
							).toEqual([{ status: "interrupted", runner_id: null }]);
							expect(
								yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
							).toHaveLength(1);
						}
					}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
				}),
			),
	);

it.effect(
	"STOP-INTENT a transferred run survives its former holder and legacy unheld runs still settle",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* stopIntentFixture;
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('moved-run', 's', 'running', 1), ('legacy-run', 's', 'running', 2), ('held-run', 's', 'running', 3)`;
				yield* f.dispatch("moved-run");
				f.accept("moved-run");
				yield* f.dispatch("held-run");
				f.accept("held-run");
				yield* f.sql`UPDATE provider_runs SET runner_id = 'replacement-holder' WHERE id = 'moved-run'`;
				// Only pre-amendment rows use this compatibility cohort, and it can contain moved runs.
				yield* f.sql`UPDATE claude_runner_cursors SET owned_run_ids = '["legacy-run"]' WHERE runner_id = ${f.runner.runnerId}`;
				f.exitOnSignal();
				const stopping = yield* f.stop.pipe(Effect.result, Effect.forkChild);
				yield* TestClock.adjust("12 seconds");
				expect((yield* Fiber.join(stopping))._tag).toBe("Success");
				expect(
					yield* f.sql`SELECT id, status, runner_id FROM provider_runs ORDER BY id`,
				).toEqual([
					{
						id: "held-run",
						status: "interrupted",
						runner_id: f.runner.runnerId,
					},
					{ id: "legacy-run", status: "interrupted", runner_id: null },
					{
						id: "moved-run",
						status: "running",
						runner_id: "replacement-holder",
					},
				]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
				).toHaveLength(2);
				yield* TestClock.adjust("70 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'moved-run'`,
				).toEqual([{ status: "running" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
				).toHaveLength(2);
			}),
		),
);

for (const restart of [false, true])
	it.effect(
		`retains an unsignalled descendant for ${restart ? "restart recovery" : "watcher retry"} after refused TERM and KILL`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					let runnerId = "";
					f.connect.mockImplementation((options) =>
						Effect.gen(function* () {
							runnerId = options.runnerId;
							const connection = new RunnerSocket(
								new Socket(),
								() => {},
								() => {},
							);
							vi.spyOn(connection, "commandEffect").mockReturnValue(
								Effect.succeed(undefined),
							);
							yield* options.onHello(
								{
									type: "hello",
									protocolVersion: 1,
									buildId: runnerBuildId(),
									stampsRunIds: true,
									runnerId,
									sessionId: "s",
									pid: options.pid ?? 0,
									bindings: [],
									sendJournalAnswers: true,
									sendAnswers: [],
								},
								connection,
							);
							return connection;
						}),
					);
					yield* f.manager.executeEffect({
						type: "pre-warm",
						sessionId: "s",
						input: {
							sessionId: "s",
							workspaceRoot: f.root,
							extraFolders: [],
							providerState: {},
							configDir: configuredClaudeConfigDir(f.root),
						},
					});
					const [pid, child] = [...f.children][0] ?? [];
					if (pid === undefined || !child)
						return yield* Effect.fail(
							runnerFailure("test child", "Missing child"),
						);
					const descendant = { pid: 100_063, startTime: "descendant" };
					const members = [{ pid, startTime: `spawned-${pid}` }, descendant];
					f.groups.set(pid, members);
					f.processes.set(descendant.pid, {
						state: "running",
						startTime: descendant.startTime,
					});
					let kills = 0;
					f.signal.mockImplementation((target, signal) => {
						f.signals.push({ pid: target, signal });
						if (signal === "SIGTERM" || ++kills === 1)
							throw runnerFailure("test signal", "Signal refused");
						f.processes.set(target, { state: "gone" });
					});
					const stopping = yield* f.manager
						.executeEffect({ type: "end-session", sessionId: "s" })
						.pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					expect(f.signals).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
					f.processes.set(pid, { state: "gone" });
					child.emit("exit", 0, null);
					yield* TestClock.adjust("4 seconds");
					yield* Fiber.join(stopping);
					const retired =
						yield* f.sql`SELECT signal_state, signal_members, signal_sent_members, signalled FROM claude_runner_cursors WHERE runner_id = ${runnerId} AND retired_at IS NOT NULL`;
					expect(retired).toEqual([
						{
							signal_state: "None",
							signal_members: JSON.stringify(members),
							signal_sent_members: "[]",
							signalled: 0,
						},
					]);
					expect(f.processes.get(descendant.pid)?.state).toBe("running");
					expect(f.signals).toEqual([
						{ pid: -pid, signal: "SIGTERM" },
						{ pid: descendant.pid, signal: "SIGKILL" },
					]);
					if (restart) {
						yield* Scope.close(f.managerScope, Exit.void);
						const recovered = yield* f.makeManager();
						yield* recovered.manager.recoverEffect;
						expect(
							yield* f.sql`SELECT signal_state, signal_members, signal_sent_members, signalled FROM claude_runner_cursors WHERE runner_id = ${runnerId}`,
						).toEqual(retired);
					}
					yield* TestClock.adjust("10 seconds");
					expect(f.signals).toEqual([
						{ pid: -pid, signal: "SIGTERM" },
						{ pid: descendant.pid, signal: "SIGKILL" },
						{ pid: descendant.pid, signal: "SIGKILL" },
					]);
					expect(f.processes.get(descendant.pid)?.state).toBe("gone");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${runnerId}`,
					).toEqual([]);
				}),
			),
	);

it.effect(
	"escalates snapshotted descendants after their leader has exited",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("abababab7878", 100_041);
				const members = [
					{ pid: entry.pid, startTime: "original" },
					{ pid: 100_042, startTime: "child-start" },
				];
				f.groups.set(entry.pid, members);
				f.processes.set(100_042, {
					state: "running",
					startTime: "child-start",
				});
				yield* f.sql`UPDATE claude_runner_cursors SET signal_state = 'TermSent', signal_members = ${JSON.stringify(members)} WHERE runner_id = ${entry.runnerId}`;
				f.processes.set(entry.pid, { state: "gone" });
				yield* f.recover;
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toHaveLength(1);
				f.signal.mockImplementation((pid, signal) => {
					f.signals.push({ pid, signal });
					f.processes.set(Math.abs(pid), { state: "gone" });
				});
				yield* TestClock.adjust("8 seconds");
				expect(f.signals).toEqual([{ pid: 100_042, signal: "SIGKILL" }]);
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual([]);
			}),
		),
);

it.effect(
	"skips a reused snapshot member instead of signalling its replacement",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("abababab9090", 100_043);
				yield* f.sql`UPDATE claude_runner_cursors SET signal_state = 'TermSent', signal_members = '[{"pid":100044,"startTime":"old-child"}]' WHERE runner_id = ${entry.runnerId}`;
				f.processes.set(entry.pid, { state: "gone" });
				f.processes.set(100_044, {
					state: "running",
					startTime: "replacement",
				});
				yield* f.recover;
				yield* TestClock.adjust("1 minute");
				expect(f.signals).toEqual([]);
				expect(yield* f.notices).toEqual([]);
			}),
		),
);

it.effect(
	"checks a noticed survivor once per minute without stacking watchers",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				yield* f.register("abababab1212", 100_031);
				yield* f.recover;
				yield* f.manager.recoverEffect;
				yield* TestClock.adjust("58 seconds");
				const checks = f.inspectMany.mock.calls.length;
				yield* TestClock.adjust("59 seconds");
				expect(f.inspectMany.mock.calls).toHaveLength(checks);
				yield* TestClock.adjust("1 second");
				expect(f.inspectMany.mock.calls.length).toBeGreaterThan(checks);
				expect(yield* f.notices).toHaveLength(1);
			}),
		),
);

it.effect(
	"keeps a dead retirement through rollback and settles it after restart",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("abababab3434", 100_032, {
					ownedRunIds: ["old-run"],
				});
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('old-run', 's', 'running', 1)`;
				yield* f.sql`CREATE TABLE retirement_parent (id TEXT PRIMARY KEY)`;
				yield* f.sql`CREATE TABLE retirement_commit_check (id TEXT REFERENCES retirement_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
				yield* f.sql`CREATE TRIGGER fail_retirement_settlement AFTER UPDATE OF owned_run_ids ON claude_runner_cursors
			WHEN NEW.runner_id = 'abababab3434' AND NEW.owned_run_ids = '[]'
			BEGIN INSERT INTO retirement_commit_check VALUES ('missing'); END`;
				yield* f.recover;
				f.processes.set(entry.pid, { state: "gone" });
				yield* TestClock.adjust("8 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
				).toEqual([{ status: "running" }]);
				expect(
					yield* f.sql`SELECT owned_run_ids FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual([{ owned_run_ids: '["old-run"]' }]);
				expect(
					yield* f.sql`SELECT event_id FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([]);
				yield* f.sql`DROP TRIGGER fail_retirement_settlement`;
				yield* Scope.close(f.managerScope, Exit.void);
				const { manager } = yield* f.makeManager();
				yield* manager.recoverEffect;
				yield* TestClock.adjust("10 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
				).toEqual([{ status: "interrupted" }]);
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual([]);
				expect(
					yield* f.sql`SELECT event_id FROM events WHERE type = 'turn.interrupted'`,
				).toHaveLength(1);
			}),
		),
);

it.effect(
	"redrives settlement after the cleanup deadline while the commit permit is held",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("abababab5656", 100_033, {
					ownedRunIds: ["old-run"],
				});
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('old-run', 's', 'running', 1)`;
				const writer = yield* makeCommitAndSignal;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const held = yield* writer
					.write(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				const recovery = yield* f.manager.recoverEffect.pipe(Effect.forkChild);
				yield* TestClock.adjust("5 seconds");
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(held);
				yield* Fiber.join(recovery);
				yield* TestClock.adjust("10 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
				).toEqual([{ status: "running" }]);
				expect(
					yield* f.sql`SELECT owned_run_ids FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual([{ owned_run_ids: '["old-run"]' }]);
				f.processes.set(entry.pid, { state: "gone" });
				yield* TestClock.adjust("20 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
				).toEqual([{ status: "interrupted" }]);
				expect(
					yield* f.sql`SELECT owned_run_ids FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual([]);
				yield* TestClock.adjust("2 minutes");
				expect(
					yield* f.sql`SELECT owned_run_ids FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
				).toEqual([]);
				expect(
					yield* f.sql`SELECT event_id FROM events WHERE type = 'turn.interrupted'`,
				).toHaveLength(1);
			}),
		),
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"test-project",
		undefined,
		SessionEventBusLive,
	);
	return Effect.scoped(effect).pipe(
		Effect.provide(
			Layer.mergeAll(
				persistence,
				SessionEventBusLive,
				ProviderRuntimeIngestionLive.pipe(
					Layer.provide(persistence),
					Layer.provide(SessionEventBusLive),
				),
			),
		),
	);
};

it.effect(
	"retries retired runners independently at 10, 30 and 60 seconds and notices once",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const first = yield* f.register("111111111111", 100_001);
				yield* f.recover;
				expect(f.connect).not.toHaveBeenCalled();
				expect(
					yield* f.manager.getSessionFailureEffect?.("s") ??
						Effect.succeed(undefined),
				).toBeUndefined();
				expect(yield* f.manager.hasLiveProcessEffect("s", first.runnerId)).toBe(
					false,
				);
				yield* TestClock.adjust("7999 millis");
				expect(f.signals).toEqual([]);
				yield* TestClock.adjust("1 millis");
				expect(f.signals).toEqual([{ pid: -first.pid, signal: "SIGKILL" }]);
				yield* TestClock.adjust("19999 millis");
				expect(f.signals).toHaveLength(1);
				yield* TestClock.adjust("1 millis");
				expect(f.signals).toHaveLength(2);
				expect(yield* f.notices).toEqual([]);
				yield* TestClock.adjust("30 seconds");
				expect(f.signals).toHaveLength(3);
				expect((yield* f.notices).map((row) => JSON.parse(row.data))).toEqual([
					{
						text: `The previous run (pid ${first.pid}) was told to stop but hasn't exited yet. It can't change this session any more and will exit when the system releases it.`,
					},
				]);
				yield* TestClock.adjust("5 minutes");
				expect(f.signals).toHaveLength(3);
				expect(yield* f.notices).toHaveLength(1);
				expect(
					yield* f.sql`SELECT retired_at, attachment_id FROM claude_runner_cursors WHERE runner_id = ${first.runnerId}`,
				).toEqual([{ retired_at: 1, attachment_id: "" }]);
				f.processes.set(first.pid, { state: "gone" });
				yield* TestClock.adjust("60 seconds");
				expect(yield* f.notices).toHaveLength(1);
			}),
		),
);

it.effect(
	"keeps each survivor's deadlines relative to its own retirement",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				yield* f.register("555555555555", 100_005);
				yield* f.recover;
				yield* TestClock.adjust("3 seconds");
				yield* f.register("666666666666", 100_006, { sessionId: "other" });
				yield* f.manager.recoverEffect;
				yield* TestClock.adjust("5 seconds");
				expect(f.signals.map((s) => -s.pid)).toEqual([100_005]);
				yield* TestClock.adjust("5 seconds");
				expect(f.signals.map((s) => -s.pid)).toEqual([100_005, 100_006]);
				yield* TestClock.adjust("15 seconds");
				expect(f.signals.map((s) => -s.pid)).toEqual([
					100_005, 100_006, 100_005,
				]);
				yield* TestClock.adjust("5 seconds");
				expect(f.signals.map((s) => -s.pid)).toEqual([
					100_005, 100_006, 100_005, 100_006,
				]);
				yield* TestClock.adjust("25 seconds");
				expect(f.signals.map((s) => -s.pid)).toEqual([
					100_005, 100_006, 100_005, 100_006, 100_005,
				]);
				yield* TestClock.adjust("5 seconds");
				expect(f.signals.map((s) => -s.pid)).toEqual([
					100_005, 100_006, 100_005, 100_006, 100_005, 100_006,
				]);
			}),
		),
);

it.effect(
	"keeps a retirement authoritative when a child overwrites its registration",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("777777777777", 100_007);
				writeFileSync(`${entry.socketPath}.json`, JSON.stringify(entry));
				yield* f.recover;
				expect(f.connect).not.toHaveBeenCalled();
			}),
		),
);

it.effect(
	"restarts the survivor schedule from a retired row without a registration",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("abababababab", 100_015);
				rmSync(`${entry.socketPath}.json`);
				yield* f.recover;
				expect(f.connect).not.toHaveBeenCalled();
				expect(yield* f.manager.hasLiveProcessEffect("s", entry.runnerId)).toBe(
					false,
				);
				yield* TestClock.adjust("8 seconds");
				expect(f.signals).toEqual([{ pid: -entry.pid, signal: "SIGKILL" }]);
				yield* TestClock.adjust("50 seconds");
				expect(f.signals).toHaveLength(3);
				expect(yield* f.notices).toHaveLength(1);
			}),
		),
);

it.effect("does not retry another driver's retired process", () =>
	run(
		Effect.gen(function* () {
			const f = yield* setup;
			const entry = yield* f.register("bbbbbbbbbbbb", 100_011);
			writeFileSync(
				`${entry.socketPath}.json`,
				JSON.stringify({ ...entry, driverKind: "cursor" }),
			);
			yield* f.sql`UPDATE sessions SET provider = 'cursor' WHERE id = 's'`;
			yield* f.sql`UPDATE claude_runner_cursors SET driver_kind = 'cursor' WHERE runner_id = ${entry.runnerId}`;
			yield* f.recover;
			yield* TestClock.adjust("60 seconds");
			expect(f.signals).toEqual([]);
			expect(yield* f.notices).toEqual([]);
		}),
	),
);

it.effect(
	"does not grant an unverified registration process authority across restart",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("cccccccccccc", process.pid, {
					startTime: undefined,
					signalled: false,
				});
				f.processes.set(entry.pid, runnerProcessTable.inspect(entry.pid));
				yield* f.recover;
				yield* TestClock.adjust("60 seconds");
				expect(f.signals).toEqual([]);
				yield* Scope.close(f.managerScope, Exit.void);
				const { manager: restarted } = yield* f.makeManager();
				yield* restarted.recoverEffect;
				yield* TestClock.adjust("60 seconds");
				expect(f.signals).toEqual([]);
			}),
		),
);

it.effect(
	"does not repeat an already persisted notice after manager restart",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				yield* f.register("888888888888", 100_008);
				yield* f.recover;
				yield* TestClock.adjust("60 seconds");
				expect(yield* f.notices).toHaveLength(1);
				yield* Scope.close(f.managerScope, Exit.void);
				const { manager: restarted } = yield* f.makeManager();
				yield* restarted.recoverEffect;
				yield* TestClock.adjust("60 seconds");
				expect(f.connect).not.toHaveBeenCalled();
				expect(yield* f.notices).toHaveLength(1);
			}),
		),
);

it.effect(
	"retries a transiently failed survivor notice on the shared backoff without duplicating it",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const ingest = vi
					.spyOn(ingestion, "ingest")
					.mockImplementationOnce(() =>
						Effect.fail(
							new SqlError({
								reason: new UnknownError({
									cause: "transient survivor notice failure",
								}),
							}),
						),
					);
				yield* f.register("343434343434", 100_016);
				yield* f.recover;
				// Recovery already advanced two seconds; reach the first notice deadline.
				yield* TestClock.adjust("58 seconds");
				expect(f.signals).toHaveLength(3);
				expect(yield* f.notices).toEqual([]);
				expect(ingest).toHaveBeenCalledTimes(1);
				// The first retry is jittered around 100 ms, within this bound.
				yield* TestClock.adjust("1 second");
				expect(yield* f.notices).toHaveLength(1);
				expect(ingest).toHaveBeenCalledTimes(2);
				yield* TestClock.adjust("2 minutes");
				expect(yield* f.notices).toHaveLength(1);
				expect(ingest).toHaveBeenCalledTimes(2);
			}),
		),
);

it.effect(
	"scoped attachment leaves another session's newer registration and current runner untouched",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				yield* f.sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('other', 'test-project', 'claude', 1, 1)`;
				yield* f.register("565656565656", 100_017, { retired: false });
				const currentOther = yield* f.register("575757575757", 100_018, {
					sessionId: "other",
					retired: false,
				});
				f.connect.mockImplementation((options) =>
					Effect.gen(function* () {
						const connection = {
							closed: false,
							commandEffect: () => Effect.void,
							destroy: () => {},
							write: () => {},
						} as unknown as RunnerSocket;
						yield* options.onHello(
							{
								type: "hello",
								protocolVersion: 1,
								buildId: runnerBuildId(),
								stampsRunIds: true,
								runnerId: options.runnerId,
								sessionId: options.sessionId,
								pid: options.pid ?? 0,
								bindings: [],
								sendJournalAnswers: true,
								sendAnswers: [],
							},
							connection,
						);
						return connection;
					}),
				);
				yield* f.recover;
				expect(
					yield* f.manager.getControlProcessIdEffect?.("other") ??
						Effect.succeed(undefined),
				).toBe(currentOther.runnerId);
				f.connect.mockClear();
				const newerOther = yield* f.register("585858585858", 100_019, {
					sessionId: "other",
					registeredAt: 2,
					retired: false,
				});
				if (!f.manager.attachSessionsEffect)
					return yield* Effect.fail(
						runnerFailure("test", "No scoped attach interface"),
					);
				yield* f.manager.attachSessionsEffect(["s"]);
				yield* TestClock.adjust(0);
				expect(
					yield* f.manager.getControlProcessIdEffect?.("other") ??
						Effect.succeed(undefined),
				).toBe(currentOther.runnerId);
				expect(
					f.connect.mock.calls.some(
						([options]) => options.runnerId === newerOther.runnerId,
					),
				).toBe(false);
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id IN (${currentOther.runnerId}, ${newerOther.runnerId}) AND retired_at IS NOT NULL`,
				).toEqual([]);
			}),
		),
);

it.effect(
	"recovery keeps the active registration live while retiring an older warm candidate",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const active = yield* f.register("676767676767", 100_017, {
					registeredAt: 2,
					retired: false,
				});
				const candidate = yield* f.register("686868686868", 100_018, {
					registeredAt: 1,
					retired: false,
					role: "candidate",
				});
				f.connect.mockImplementation((options) =>
					Effect.gen(function* () {
						const connection = {
							closed: false,
							commandEffect: () => Effect.void,
							destroy: () => {},
							write: () => {},
						} as unknown as RunnerSocket;
						yield* options.onHello(
							{
								type: "hello",
								protocolVersion: 1,
								buildId: runnerBuildId(),
								stampsRunIds: true,
								runnerId: options.runnerId,
								sessionId: options.sessionId,
								pid: options.pid ?? 0,
								bindings: [],
								sendJournalAnswers: true,
								sendAnswers: [],
							},
							connection,
						);
						return connection;
					}),
				);
				const recovering = yield* Effect.forkChild(f.manager.recoverEffect);
				yield* TestClock.adjust("6 seconds");
				yield* Fiber.join(recovering);
				expect(
					yield* f.manager.getControlProcessIdEffect?.("s") ??
						Effect.succeed(undefined),
				).toBe(active.runnerId);
				expect(
					yield* f.manager.hasLiveProcessEffect("s", candidate.runnerId),
				).toBe(false);
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${active.runnerId} AND retired_at IS NOT NULL`,
				).toEqual([]);
				expect(
					f.output.mock.calls.some(
						([output]) =>
							output.type === "background-task" &&
							output.transition.kind === "session-ended",
					),
				).toBe(false);
			}),
		),
);

for (const crossDirectory of [false, true])
	it.effect(
		`adopts the durable serving row and retires the candidate, cross-directory=${crossDirectory}`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const older = yield* f.register("999999999999", 100_009, {
						registeredAt: 1,
						retired: false,
					});
					const newer = yield* f.register("aaaaaaaaaaaa", 100_010, {
						registeredAt: 2,
						retired: false,
					});
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at, started_at) VALUES ('old-run', 's', 'running', 1, 1), ('new-run', 's', 'running', 2, 2)`;
					yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, provider_process_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'old-command', 'test-project', 's', 'claude', 'send_turn', 'old-run', NULL, '{}', 'running', 1, 1, 1), (2, 'new-command', 'test-project', 's', 'claude', 'send_turn', 'new-run', NULL, '{}', 'running', 1, 2, 2)`;
					yield* f.sql`UPDATE claude_runner_cursors SET role = 'candidate', sequence = 1, owned_run_ids = '["old-run"]' WHERE runner_id = ${older.runnerId}`;
					yield* f.sql`UPDATE claude_runner_cursors SET role = 'serving', sequence = 1 WHERE runner_id = ${newer.runnerId}`;
					let moved: RunnerRegistration | undefined;
					if (crossDirectory) {
						const other = prepareRunnerDirectory(`${f.root}/moved`, f.root);
						const move = other < older.socketPath ? older : newer;
						const socketPath = join(other, move.runnerId);
						moved = { ...move, socketPath };
						renameSync(`${move.socketPath}.json`, `${socketPath}.json`);
						writeFileSync(
							`${socketPath}.json`,
							JSON.stringify({ ...move, socketPath }),
						);
					}
					// The host journal records the process and command attempt before send.
					// Unlike control commands, production send_turn rows have no process ID.
					for (const [host, commandId] of [
						[older, "old-command"],
						[newer, "new-command"],
					] as const) {
						const directory = join(
							dirname(
								moved?.runnerId === host.runnerId
									? moved.socketPath
									: host.socketPath,
							),
							"sends",
							"s",
						);
						mkdirSync(directory, { recursive: true });
						const key = createHash("sha256")
							.update(JSON.stringify(["claude", "s", commandId, 1, false]))
							.digest("hex");
						writeFileSync(
							join(directory, `${key}.json`),
							JSON.stringify({
								commandId,
								attempt: 1,
								runnerPid: host.pid,
								startedAt: 3,
								nativeResumeFallback: false,
							}),
						);
					}
					f.connect.mockImplementation((options) =>
						Effect.gen(function* () {
							const connection = {
								closed: false,
								commandEffect: () => Effect.void,
								destroy: () => {},
								write: () => {},
							} as unknown as RunnerSocket;
							yield* options.onHello(
								{
									type: "hello",
									protocolVersion: 1,
									buildId: runnerBuildId(),
									stampsRunIds: true,
									crossAttemptNativeResumeFallback: true,
									runnerId: options.runnerId,
									sessionId: "s",
									pid: options.pid ?? 0,
									bindings: [],
									sendJournalAnswers: true,
									sendAnswers: [
										{
											commandId:
												options.runnerId === older.runnerId
													? "old-command"
													: "new-command",
											attempt: 1,
											nativeResumeFallback: false,
											status: "running",
										},
									],
								},
								connection,
							);
							return connection;
						}),
					);
					const recovered = yield* Effect.forkChild(f.manager.recoverEffect);
					yield* TestClock.adjust("5 seconds");
					yield* Fiber.join(recovered);
					expect(
						yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
					).toEqual([
						{ id: "new-run", status: "running" },
						{ id: "old-run", status: "running" },
					]);
					expect(
						yield* f.manager.hasLiveProcessEffect("s", newer.runnerId),
					).toBe(true);
					expect(
						yield* f.manager.hasLiveProcessEffect("s", older.runnerId),
					).toBe(false);
					expect(
						yield* f.sql`SELECT attachment_id FROM claude_runner_cursors WHERE runner_id = ${older.runnerId} AND retired_at IS NOT NULL`,
					).toEqual([{ attachment_id: "" }]);
					f.processes.set(older.pid, { state: "gone" });
					yield* TestClock.adjust("10 seconds");
					expect(
						yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
					).toEqual([
						{ id: "new-run", status: "running" },
						{ id: "old-run", status: "interrupted" },
					]);
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${older.runnerId}`,
					).toEqual([]);
				}),
			),
	);

for (const processState of ["running", "gone", "zombie"] as const)
	it.effect(
		`settles only the retired registration's persisted runs when its process is ${processState}`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const retired = yield* f.register("fafafafafafa", 100_014, {
						ownedRunIds: ["old-run"],
					});
					f.processes.set(retired.pid, {
						state: processState,
						startTime: "original",
					});
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('old-run', 's', 'running', 1), ('new-run', 's', 'running', 2)`;
					yield* f.recover;
					expect(
						yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
					).toEqual([
						{ id: "new-run", status: "running" },
						{
							id: "old-run",
							status: processState === "running" ? "running" : "interrupted",
						},
					]);
					expect(
						yield* f.manager.hasLiveProcessEffect("s", retired.runnerId),
					).toBe(false);
					if (processState === "running") {
						f.processes.set(retired.pid, { state: "gone" });
						yield* TestClock.adjust("10 seconds");
					}
					expect(
						yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
					).toEqual([
						{ id: "new-run", status: "running" },
						{ id: "old-run", status: "interrupted" },
					]);
					expect(
						yield* f.sql`SELECT event_id FROM events WHERE type = 'turn.interrupted'`,
					).toHaveLength(1);
				}),
			),
	);

for (const outcome of ["retired", "exited"] as const)
	it.effect(
		`fences delayed failure cleanup by ownership when the old runner is ${outcome}`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const old = yield* f.register("121212121212", 100_019, {
						retired: false,
					});
					const connections: Array<
						Parameters<ProcessRunnerDriver["connect"]>[0]
					> = [];
					f.connect.mockImplementation((options) =>
						Effect.gen(function* () {
							connections.push(options);
							const connection = new RunnerSocket(
								new Socket(),
								() => {},
								options.onClose,
							);
							vi.spyOn(connection, "write").mockImplementation(() => {});
							vi.spyOn(connection, "commandEffect").mockReturnValue(
								Effect.succeed(undefined),
							);
							vi.spyOn(connection, "destroy").mockImplementation(() => {});
							yield* options.onHello(
								{
									type: "hello",
									protocolVersion: 1,
									buildId: runnerBuildId(),
									stampsRunIds: true,
									runnerId: options.runnerId,
									sessionId: "s",
									pid: options.pid ?? 0,
									bindings: [
										{
											sinkId: "retained-sink",
											sessionId: "s",
											released: false,
										},
										...(options.runnerId === old.runnerId
											? [{ sinkId: "blocked", sessionId: "s", released: false }]
											: []),
									],
									sendJournalAnswers: true,
									sendAnswers: [],
								},
								connection,
							);
							return connection;
						}),
					);
					yield* f.recover;
					const attachment = connections[0];
					if (!attachment)
						return yield* Effect.fail(runnerFailure("test", "No attachment"));
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const background = makeSessionBackgroundLiveness(undefined, () => 1);
					const outputs: SessionOutput[] = [];
					f.output.mockImplementation((output) =>
						Effect.gen(function* () {
							if (
								output.type === "release-sink" &&
								output.sinkId === "blocked"
							) {
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
								return {};
							}
							outputs.push(output);
							if (output.type === "background-task")
								background.record(output.transition);
							return {};
						}),
					);
					yield* attachment.emit(
						{
							type: "background-task",
							transition: {
								sessionId: "s",
								kind: "snapshot",
								tasks: [
									{ id: "old", type: "local_bash", description: "Old task" },
								],
							},
						},
						"s",
					);
					const blocked = yield* Effect.forkChild(
						attachment.emit({ type: "release-sink", sinkId: "blocked" }, "s"),
					);
					yield* Deferred.await(entered);
					if (outcome === "exited") f.processes.set(old.pid, { state: "gone" });
					attachment.onClose(
						runnerFailure("test socket", "Unexpected disconnect"),
					);
					yield* TestClock.adjust("4 seconds");
					if (outcome === "retired") {
						yield* f.manager.executeEffect({
							type: "pre-warm",
							sessionId: "s",
							input: {
								sessionId: "s",
								workspaceRoot: f.root,
								extraFolders: [],
								providerState: {},
								configDir: configuredClaudeConfigDir(f.root),
							},
						});
						expect(connections).toHaveLength(2);
						const replacement = connections[1];
						if (!replacement)
							return yield* Effect.fail(
								runnerFailure("test", "No replacement"),
							);
						yield* replacement.emit(
							{
								type: "background-task",
								transition: {
									sessionId: "s",
									kind: "snapshot",
									tasks: [
										{ id: "new", type: "local_bash", description: "New task" },
									],
								},
							},
							"s",
						);
					}
					if (outcome === "exited") {
						expect(
							outputs.filter(
								(output) =>
									output.type === "release-sink" &&
									output.sinkId === "retained-sink",
							),
						).toHaveLength(1);
						expect(background.backgroundOf("s")).toBeUndefined();
					}
					outputs.length = 0;
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(blocked);
					yield* TestClock.adjust(0);
					if (outcome === "retired") {
						expect(background.backgroundOf("s")).toEqual({
							work: "monitoring",
							tasks: [
								{
									id: "new",
									type: "local_bash",
									description: "New task",
									firstSeenAt: 1,
								},
							],
						});
						expect(outputs).toEqual([]);
						expect(
							yield* f.manager.hasLiveProcessEffect(
								"s",
								connections[1]?.runnerId,
							),
						).toBe(true);
					} else {
						expect(background.backgroundOf("s")).toBeUndefined();
						expect(outputs).toEqual([]);
						expect(
							yield* f.manager.hasLiveProcessEffect("s", old.runnerId),
						).toBe(false);
					}
				}),
			),
	);

for (const deniedTerm of [false, true])
	it.effect(
		`releases a failed force-stop and starts the next message on a fresh runner (TERM refused: ${deniedTerm})`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					if (deniedTerm)
						f.signal.mockImplementationOnce((pid, signal) => {
							f.signals.push({ pid, signal });
							throw runnerFailure("test signal", "TERM refused");
						});
					const connections: Array<
						Parameters<ProcessRunnerDriver["connect"]>[0]
					> = [];
					f.connect.mockImplementation((options) =>
						Effect.gen(function* () {
							connections.push(options);
							const connection = {
								closed: false,
								commandEffect: (
									_id: string,
									command: { readonly type: string },
								) =>
									command.type === "send-turn"
										? Effect.succeed({
												status: "accepted",
												cost: 0,
												tokens: { input: 0, output: 0 },
												durationMs: 0,
												providerStateUpdates: [],
											})
										: Effect.void,
								destroy: () => {},
								write: () => {},
							} as unknown as RunnerSocket;
							yield* options.onHello(
								{
									type: "hello",
									protocolVersion: 1,
									buildId: runnerBuildId(),
									stampsRunIds: true,
									runnerId: options.runnerId,
									sessionId: "s",
									pid: options.pid ?? 0,
									bindings: [],
									sendJournalAnswers: true,
									sendAnswers: [],
								},
								connection,
							);
							return connection;
						}),
					);
					const input = {
						sessionId: "s",
						workspaceRoot: f.root,
						extraFolders: [],
						providerState: {},
						configDir: configuredClaudeConfigDir(f.root),
					};
					yield* f.manager.executeEffect({
						type: "pre-warm",
						sessionId: "s",
						input,
					});
					const old = connections[0];
					expect(old).toBeDefined();
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id) VALUES ('old-run', 's', 'running', 1, ${old?.runnerId ?? ""})`;
					old?.onOutputCommitted?.({
						type: "event",
						sinkId: "old-sink",
						event: {
							eventId: "old-start",
							type: "run.started",
							sessionId: "s",
							providerId: "claude",
							runId: "old-run",
							providerRefs: {},
							rawSource: { kind: "test" },
							createdAt: 1,
							data: { inputId: "old-input", requestedRunId: "old-run" },
						},
					});
					const lateOutput = old?.emit(
						{
							type: "event",
							sinkId: "old",
							event: {
								eventId: "late",
								type: "turn.notice",
								sessionId: "s",
								providerId: "claude",
								providerRefs: {},
								rawSource: { kind: "test" },
								createdAt: 1,
								data: { text: "Late output" },
							},
						},
						"s",
					);
					const ending = yield* Effect.forkChild(
						f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
					);
					yield* TestClock.adjust("4 seconds");
					expect(ending.pollUnsafe()).toMatchObject({ _tag: "Success" });
					yield* Fiber.join(ending);
					expect(
						yield* f.sql`SELECT owned_run_ids FROM claude_runner_cursors WHERE runner_id = ${old?.runnerId ?? ""} AND retired_at IS NOT NULL`,
					).toEqual([{ owned_run_ids: "[]" }]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
					).toEqual([{ status: "running" }]);
					expect(f.signals.map((signal) => signal.signal)).toEqual([
						"SIGTERM",
						"SIGKILL",
					]);
					expect(
						yield* f.manager.hasLiveProcessEffect("s", old?.runnerId),
					).toBe(false);
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('new-run', 's', 'pending', 2)`;
					yield* admitRunnerCommand(f.admission, f.manager, {
						type: "send-turn",
						sinkId: "new-sink",
						aborted: false,
						input: {
							...input,
							inputId: "new-input",
							runId: "new-run",
							prompt: "follow up",
							history: [],
							resumeSessionId: "native-conversation",
						},
					});
					expect(connections).toHaveLength(2);
					expect(connections[1]?.runnerId).not.toBe(old?.runnerId);
					if (old?.pid !== undefined)
						f.processes.set(old.pid, { state: "gone" });
					yield* TestClock.adjust("10 seconds");
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
					).toEqual([{ status: "interrupted" }]);
					expect(
						yield* f.sql`SELECT event_id FROM events WHERE type = 'turn.interrupted'`,
					).toHaveLength(1);
					const emitted = f.output.mock.calls.length;
					yield* lateOutput ?? Effect.void;
					expect(f.output.mock.calls).toHaveLength(emitted);
				}),
			),
	);

it.effect(
	"keeps a restarted survivor visible to session liveness without owning runs",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("dddddddddddd", 100_012);
				yield* f.recover;
				expect(yield* f.manager.hasLiveProcessEffect("s")).toBe(true);
				expect(yield* f.manager.hasLiveProcessEffect("s", entry.runnerId)).toBe(
					false,
				);
			}),
		),
);

it.effect("stops without a notice when a retry makes the process exit", () =>
	run(
		Effect.gen(function* () {
			const f = yield* setup;
			const entry = yield* f.register("eeeeeeeeeeee", 100_013);
			f.signal.mockImplementation((pid, signal) => {
				f.signals.push({ pid, signal });
				f.processes.set(Math.abs(pid), { state: "gone" });
			});
			yield* f.recover;
			yield* TestClock.adjust("60 seconds");
			expect(f.signals).toEqual([{ pid: -entry.pid, signal: "SIGKILL" }]);
			expect(yield* f.notices).toEqual([]);
		}),
	),
);

for (const stopped of ["gone", "zombie", "reused"] as const)
	it.effect(`stops retries for a ${stopped} process without a notice`, () =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("222222222222", 100_002);
				yield* f.recover;
				f.processes.set(
					entry.pid,
					stopped === "reused"
						? { state: "running", startTime: "replacement" }
						: { state: stopped },
				);
				yield* TestClock.adjust("2 minutes");
				expect(f.signals).toEqual([]);
				expect(yield* f.notices).toEqual([]);
			}),
		),
	);

it.effect(
	"prunes an unverifiable leader once its verified snapshot identity is reused",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const leader = yield* f.register("cfcfcfcfcfcf", 100_114, {
					startTime: undefined,
				});
				const member = { pid: leader.pid, startTime: "original" };
				const reaper = { pid: 100_115, startTime: "reaper" };
				yield* f.sql`UPDATE claude_runner_cursors SET reaper_pid = ${reaper.pid}, reaper_start_time = ${reaper.startTime} WHERE runner_id = ${leader.runnerId}`;
				f.processes.set(leader.pid, {
					state: "running",
					startTime: member.startTime,
					pgid: leader.pid,
				});
				f.processes.set(reaper.pid, {
					state: "running",
					startTime: reaper.startTime,
					pgid: leader.pid,
				});
				f.groups.set(leader.pid, [member, reaper]);
				yield* f.recover;
				f.processes.set(leader.pid, {
					state: "running",
					startTime: "unrelated",
				});
				f.processes.set(reaper.pid, { state: "gone" });
				yield* TestClock.adjust("60 seconds");
				expect(f.signals).toEqual([]);
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
				).toEqual([]);
				expect(yield* f.notices).toEqual([]);
			}),
		),
);

// A dead verified reaper cannot stand in for an unverifiable leader's liveness.
for (const state of ["running", "unknown"] as const)
	it.effect(
		`keeps an unverifiable ${state} leader after its only snapshotted member exits`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const leader = yield* f.register("cececececece", 100_112, {
						startTime: undefined,
						signalled: false,
					});
					const reaper = { pid: 100_113, startTime: "reaper" };
					yield* f.sql`UPDATE claude_runner_cursors SET reaper_pid = ${reaper.pid}, reaper_start_time = ${reaper.startTime}, member_snapshot = ${JSON.stringify([reaper])} WHERE runner_id = ${leader.runnerId}`;
					f.processes.set(leader.pid, { state });
					f.processes.set(reaper.pid, { state: "gone" });
					f.members.mockReturnValue(undefined);
					yield* f.recover;
					yield* TestClock.adjust("60 seconds");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
					).toHaveLength(1);
					expect(f.signals).toEqual([]);
					expect((yield* f.notices).map((row) => JSON.parse(row.data))).toEqual(
						[
							{
								text: `Conduit couldn't confirm pid ${leader.pid} is the previous run, so it didn't stop it. It may still be running. Stop it manually if it is.`,
							},
						],
					);
					f.processes.set(leader.pid, { state: "zombie" });
					yield* TestClock.adjust("60 seconds");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${leader.runnerId}`,
					).toEqual([]);
				}),
			),
	);

it.effect(
	"never signals an unverified process and uses the honest notice wording",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const entry = yield* f.register("333333333333", 100_003, {
					signalled: false,
				});
				f.processes.set(entry.pid, { state: "unknown" });
				yield* f.recover;
				yield* TestClock.adjust("60 seconds");
				expect(f.signals).toEqual([]);
				expect((yield* f.notices).map((row) => JSON.parse(row.data))).toEqual([
					{
						text: `Conduit couldn't confirm pid ${entry.pid} is the previous run, so it didn't stop it. It may still be running. Stop it manually if it is.`,
					},
				]);
			}),
		),
);

for (const removed of ["deleted", "archived"] as const)
	it.effect(
		`keeps cleanup retries and prunes a later exit without a notice for a ${removed} session`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					const entry = yield* f.register("444444444444", 100_004);
					yield* f.recover;
					if (removed === "deleted")
						yield* f.sql`DELETE FROM sessions WHERE id = 's'`;
					else yield* f.sql`UPDATE sessions SET archived_at = 1 WHERE id = 's'`;
					yield* TestClock.adjust("60 seconds");
					expect(f.signals).toHaveLength(3);
					expect(yield* f.notices).toEqual([]);
					f.processes.set(entry.pid, { state: "gone" });
					yield* TestClock.adjust("60 seconds");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
					).toEqual([]);
					expect(yield* f.notices).toEqual([]);
				}),
			),
	);

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

// C2/C3 failure cases: a release races cleanup/reconciliation; every replacement
// refuses; provider retry changes runs; journal evidence is uncertain or corrupt;
// legacy holderless work must not enter the new transmission gate.
const continuationFixture = (
	options: {
		readonly journalCapable?: boolean;
		readonly drainsConnections?: boolean;
		readonly adoptionAnswer?: RunnerSendAnswer;
	} = {},
) =>
	Effect.gen(function* () {
		const f = yield* setup;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		f.output.mockImplementation((output) =>
			output.type === "event"
				? ingestion.ingest(output.event).pipe(
						Effect.mapError((cause) => runnerFailure("test ingestion", cause)),
						Effect.as({}),
					)
				: Effect.succeed({}),
		);
		type Connection = Parameters<ProcessRunnerDriver["connect"]>[0];
		const connections: Connection[] = [];
		const sends: {
			readonly runnerId: string;
			readonly command: Extract<SessionCommand, { type: "send-turn" }>;
		}[] = [];
		const delivered: string[] = [];
		const statuses = vi.fn<RunnerSocket["commandStatusEffect"]>(() =>
			Effect.succeed("not_received" as const),
		);
		const accepted = {
			status: "accepted" as const,
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		};
		const complete = (
			connection: Connection,
			command: Extract<SessionCommand, { type: "send-turn" }>,
		) =>
			Effect.gen(function* () {
				delivered.push(command.input.inputId);
				connection.onCommandAccepted?.(command.sinkId);
				for (const type of ["run.started", "turn.completed"] as const) {
					const output: SessionOutput = {
						type: "event",
						sinkId: command.sinkId,
						event: {
							eventId: `${type}-${command.input.runId}`,
							type,
							providerId: "claude",
							sessionId: "s",
							runId: command.input.runId,
							providerRefs: {},
							rawSource: { kind: "test.continuation" },
							createdAt: 10,
							data:
								type === "run.started"
									? {
											inputId: command.input.inputId,
											requestedRunId: command.input.runId,
										}
									: { messageId: "" },
						},
					};
					yield* connection.emit(output, "s");
					connection.onOutputCommitted?.(output);
				}
				return accepted;
			});
		let behavior: (
			connection: Connection,
			command: Extract<SessionCommand, { type: "send-turn" }>,
		) => ReturnType<RunnerSocket["commandEffect"]> = complete;
		f.connect.mockImplementation((connection) =>
			Effect.gen(function* () {
				connections.push(connection);
				const socket = new RunnerSocket(
					new Socket(),
					() => {},
					() => {},
				);
				vi.spyOn(socket, "destroy").mockImplementation(() => {});
				vi.spyOn(socket, "commandStatusEffect").mockImplementation(statuses);
				vi.spyOn(socket, "commandEffect").mockImplementation((_id, command) => {
					if (command.type !== "send-turn") return Effect.succeed(undefined);
					sends.push({ runnerId: connection.runnerId, command });
					return behavior(connection, command);
				});
				yield* connection.onHello(
					{
						type: "hello",
						protocolVersion: 1,
						buildId:
							options.journalCapable === false
								? "historical-build"
								: runnerBuildId(),
						stampsRunIds: true,
						runnerId: connection.runnerId,
						sessionId: "s",
						pid: connection.pid ?? 0,
						bindings: [],
						...(options.journalCapable === false
							? {}
							: {
									sendJournalAnswers: true,
									...(options.drainsConnections
										? { drainsConnections: true as const }
										: {}),
									sendAnswers:
										connections.length > 1 && options.adoptionAnswer
											? [options.adoptionAnswer]
											: [],
								}),
					},
					socket,
				);
				return socket;
			}),
		);
		const input = {
			sessionId: "s",
			workspaceRoot: f.root,
			extraFolders: [],
			providerState: {},
			configDir: configuredClaudeConfigDir(f.root),
		};
		yield* f.manager.executeEffect({ type: "pre-warm", sessionId: "s", input });
		let sequence = 0;
		const seed = (runId: string, commandId = "send") =>
			Effect.gen(function* () {
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (${runId}, 's', 'pending', 1)`;
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id)
			VALUES (${++sequence}, ${commandId}, 'test-project', 's', 'claude', 'send_turn', ${JSON.stringify({ inputId: commandId, prompt: commandId, history: [] })}, 'running', 1, 1, 1, ${runId})`;
			});
		const dispatch = (
			runId: string,
			commandId = "send",
			nativeResumeFallback = false,
		) =>
			admitRunnerCommand(f.admission, f.manager, {
				type: "send-turn",
				sinkId: `${commandId}:${runId}:${nativeResumeFallback}`,
				aborted: false,
				input: {
					...input,
					inputId: commandId,
					runId,
					prompt: commandId,
					history: [],
					...(nativeResumeFallback ? { nativeResumeFallback: true } : {}),
				},
			});
		const refuse = (reason: "exiting" | "retiring" | "interrupted") =>
			Effect.fail<RunnerCommandFailure>({
				...runnerFailure("test refusal", reason),
				delivery: { _tag: "Refused", reason },
			});
		f.signal.mockImplementation((pid, signal) => {
			f.signals.push({ pid, signal });
			f.processes.set(Math.abs(pid), { state: "gone" });
		});
		return {
			...f,
			connections,
			sends,
			delivered,
			statuses,
			accepted,
			input,
			complete,
			seed,
			dispatch,
			refuse,
			respond: (next: typeof behavior) => {
				behavior = next;
			},
		};
	});

it.effect(
	"SEND-CONTINUATION 31 fifth refused transmission exhausts once without delivery",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				f.respond(() => f.refuse("exiting"));
				const send = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust("30 seconds");
				yield* Fiber.join(send);
				expect(f.delivered).toEqual([]);
				expect(f.sends).toHaveLength(5);
				expect(f.connections).toHaveLength(5);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
				).toEqual([1, 2, 3, 4, 5].map((n) => ({ n })));
				expect(
					yield* f.sql`SELECT json_extract(data, '$.code') AS code FROM events WHERE type = 'turn.error'`,
				).toEqual([{ code: "provider_send_attempts_exhausted" }]);
			}),
		),
);

it.effect(
	"SEND-CONTINUATION 36 refusal requeues its handle before pending retirement cleanup",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const original = f.output.getMockImplementation();
				f.output.mockImplementation((output) =>
					output.type === "background-task" &&
					output.transition.kind === "session-ended"
						? Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as({}),
							)
						: (original?.(output) ?? Effect.succeed({})),
				);
				let refused = false;
				f.respond((connection, command) => {
					if (!refused) {
						refused = true;
						return f.refuse("exiting");
					}
					return f.complete(connection, command);
				});
				const send = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* Effect.gen(function* () {
					yield* Deferred.await(entered);
					yield* TestClock.adjust("2 seconds");
					yield* Fiber.join(send);
					expect(f.delivered).toEqual(["send"]);
					expect(f.sends).toHaveLength(2);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
					).toEqual([{ status: "completed" }]);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

for (const variant of ["flag", "failure", "result"] as const)
	it.effect(
		`SEND-CONTINUATION 37 ${variant} resume refusal releases before prepare-turn's fresh fallback`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* continuationFixture();
					yield* f.seed("run");
					const error = {
						code: "claude_resume_refused",
						message:
							"Resume rejected by --resume-drops-turn: native context rejected",
						retryable: false,
					};
					f.respond((connection, command) => {
						if (command.input.nativeResumeFallback)
							return f.complete(connection, command);
						if (variant === "failure")
							return Effect.fail<RunnerCommandFailure>({
								...runnerFailure("native resume", error.message),
								...error,
								replied: true,
							});
						return Effect.succeed({
							...f.accepted,
							status: "error" as const,
							error,
							...(variant === "flag" ? { nativeResumeRejected: true } : {}),
						});
					});
					const preparation: (string | undefined)[] = [];
					yield* f.admission.admitSendEffect(
						{
							origin: { _tag: "Fresh" },
							sinkId: "prepared-send",
							input: { ...f.input, inputId: "send", runId: "run" },
						},
						(send) =>
							sendPreparedClaudeTurn({
								sessionId: "s",
								instanceId: "claude",
								commandId: "send",
								userText: "send",
								options: {
									folderSource: "account",
									configDir: configuredClaudeConfigDir(f.root),
									workspaceRoot: f.root,
									liveSession: {
										instanceId: "claude",
										resumeSessionId: "native",
										configDir: configuredClaudeConfigDir(f.root),
									},
								},
								send: (prepared, fallback) =>
									Effect.gen(function* () {
										preparation.push(prepared.resumeSessionId);
										if (fallback)
											expect(
												yield* f.sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
											).toEqual([{ runner_id: null, held_transmission: null }]);
										return yield* f.manager.executeEffect(
											{
												type: "send-turn",
												sinkId: send.sinkId,
												aborted: false,
												input: {
													...f.input,
													inputId: "send",
													runId: "run",
													prompt: prepared.prompt,
													history: [],
													...(prepared.resumeSessionId
														? { resumeSessionId: prepared.resumeSessionId }
														: {}),
													...(fallback ? { nativeResumeFallback: true } : {}),
												},
											},
											send,
										);
									}),
							}),
					);
					expect(preparation).toEqual(["native", undefined]);
					expect(f.delivered).toEqual(["send"]);
					expect(f.connections).toHaveLength(1);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
					).toEqual([{ reason: "ResumeRejected" }]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
					).toEqual([{ n: 1 }, { n: 2 }]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
					).toEqual([{ status: "completed" }]);
				}),
			),
	);

it.effect(
	"SEND-CONTINUATION 39 retry on a fresh run keeps the stable send transmission count",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("first");
				f.respond(() =>
					Effect.fail<RunnerCommandFailure>({
						...runnerFailure("provider send", "retry later"),
						code: "provider_retry",
						retryable: true,
						replied: true,
					}),
				);
				expect((yield* Effect.result(f.dispatch("first")))._tag).toBe(
					"Failure",
				);
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"turn.error",
						"s",
						{
							messageId: "",
							error: "retry later",
							code: "provider_retry",
							retryable: true,
						},
						{ provider: "claude", metadata: { runId: "first" }, createdAt: 10 },
					),
				]);
				yield* f.seed("second");
				f.respond(f.complete);
				yield* f.dispatch("second");
				expect(f.delivered).toEqual(["send"]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.commandId') AS command, json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
				).toEqual([
					{ command: "send", n: 1 },
					{ command: "send", n: 2 },
				]);
				expect(
					yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "first", status: "error" },
					{ id: "second", status: "completed" },
				]);
			}),
		),
);

it.effect(
	"SEND-CONTINUATION 25 live refusal racing reconciler release delivers once and preserves the successor hold",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				const release = yield* Deferred.make<void>();
				f.respond((connection, command) =>
					connection === f.connections[0]
						? Deferred.await(release).pipe(Effect.andThen(f.refuse("exiting")))
						: f.complete(connection, command),
				);
				const send = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const first = f.connections[0];
				if (!first?.pid)
					return yield* Effect.die("missing continuation runner");
				f.processes.set(first.pid, { state: "gone" });
				f.children.get(first.pid)?.emit("exit", 1, null);
				first.onClose(
					runnerFailure("test exit", "runner exited before receipt"),
				);
				yield* Deferred.succeed(release, undefined);
				yield* TestClock.adjust("12 seconds");
				yield* Fiber.join(send);
				expect(f.delivered).toEqual(["send"]);
				expect(f.sends).toHaveLength(2);
				expect(f.connections).toHaveLength(2);
				expect(
					yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([
					{
						status: "completed",
						runner_id: f.connections[1]?.runnerId,
						held_transmission: 2,
					},
				]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
				).toEqual([{ n: 1 }, { n: 2 }]);
			}),
		),
);

// Discovery can disappear at full shutdown. Settle must classify exactly the
// same durable transmission with and without its registration, after restart.
for (const discovery of [true, false])
	for (const evidence of [
		"absent",
		"received",
		"corrupt",
		"older-build",
	] as const)
		it.effect(
			`SEND-CONTINUATION discovery-independent Settle: ${evidence}, registration=${discovery}`,
			() =>
				run(
					Effect.gen(function* () {
						const f = yield* continuationFixture();
						yield* f.seed("run");
						yield* f.sql`UPDATE provider_command_outbox SET payload_json = ${JSON.stringify({ inputId: "send", prompt: "send", history: [], workspaceRoot: f.root, extraFolders: [], configDir: configuredClaudeConfigDir(f.root), folderSource: "account" })} WHERE command_id = 'send'`;
						f.respond(() => Effect.never);
						yield* f.dispatch("run").pipe(Effect.forkChild);
						yield* TestClock.adjust(0);
						const first = f.connections[0];
						if (!first?.pid) return yield* Effect.die("missing held runner");
						registerRunner({
							runnerId: first.runnerId,
							sessionId: "s",
							socketPath: first.socketPath,
							pid: first.pid,
							startTime: `spawned-${first.pid}`,
							driverKind: "claude",
							buildId:
								evidence === "older-build"
									? "historical-build"
									: runnerBuildId(),
						});
						const directory = dirname(first.socketPath);
						if (evidence === "received") {
							const journal = new RunnerSendJournal(directory, "s", "claude");
							yield* journal
								.execute("send", 1, false, Effect.never)
								.pipe(Effect.forkChild);
							yield* TestClock.adjust(0);
						} else if (evidence === "corrupt") {
							const folder = join(directory, "sends", "s");
							mkdirSync(folder, { recursive: true });
							const digest = createHash("sha256")
								.update(JSON.stringify(["claude", "s", "send", 1, false]))
								.digest("hex");
							writeFileSync(join(folder, `${digest}.json`), "{corrupt");
						}
						writeFileSync(
							`${first.socketPath}.spool`,
							"retained unacknowledged output\n",
						);
						yield* Scope.close(f.managerScope, Exit.void);
						if (!discovery) rmSync(`${first.socketPath}.json`);
						expect(readFileSync(`${first.socketPath}.spool`, "utf8")).toBe(
							"retained unacknowledged output\n",
						);
						f.processes.set(first.pid, { state: "gone" });
						f.respond(f.complete);
						const recovered = yield* f.makeManager();
						const recovering = yield* recovered.manager.recoverEffect.pipe(
							Effect.forkChild,
						);
						yield* TestClock.adjust("12 seconds");
						yield* Fiber.join(recovering);
						expect(
							yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
						).toEqual([
							{
								status: evidence === "absent" ? "completed" : "failed",
								error_code:
									evidence === "absent" ? null : "delivery_indeterminate",
							},
						]);
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
						).toEqual([
							{ status: evidence === "absent" ? "completed" : "error" },
						]);
						expect(
							yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
						).toEqual(
							evidence === "absent" ? [{ reason: "JournalAbsent" }] : [],
						);
						expect(f.delivered).toEqual(evidence === "absent" ? ["send"] : []);
						expect(f.sends).toHaveLength(evidence === "absent" ? 2 : 1);
					}),
				),
		);

for (const evidence of ["received", "corrupt", "older-build"] as const)
	it.effect(
		`SEND-CONTINUATION ${evidence === "received" ? 27 : 28} ${evidence} journal never retransmits uncertain delivery`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* continuationFixture({
						journalCapable: evidence !== "older-build",
					});
					yield* f.seed("run");
					f.respond(() => Effect.never);
					const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					const first = f.connections[0];
					if (!first?.pid)
						return yield* Effect.die("missing continuation runner");
					const directory = dirname(first.socketPath);
					if (evidence === "received") {
						const journal = new RunnerSendJournal(directory, "s", "claude");
						yield* journal
							.execute("send", 1, false, Effect.never)
							.pipe(Effect.forkChild);
						yield* TestClock.adjust(0);
					} else if (evidence === "corrupt") {
						const folder = join(directory, "sends", "s");
						mkdirSync(folder, { recursive: true });
						const digest = createHash("sha256")
							.update(JSON.stringify(["claude", "s", "send", 1, false]))
							.digest("hex");
						writeFileSync(join(folder, `${digest}.json`), "{corrupt");
					}
					f.processes.set(first.pid, { state: "gone" });
					f.children.get(first.pid)?.emit("exit", 1, null);
					first.onClose(
						runnerFailure("test exit", "runner died after possible delivery"),
					);
					yield* TestClock.adjust("12 seconds");
					expect(f.delivered).toEqual([]);
					expect(f.sends).toHaveLength(1);
					expect(f.connections).toHaveLength(1);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
					).toEqual([{ status: "error" }]);
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
					).toEqual([
						{ status: "failed", error_code: "delivery_indeterminate" },
					]);
					expect(
						yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
					).toEqual([{ n: 0 }]);
					expect(
						yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.error'`,
					).toEqual([{ n: 1 }]);
					yield* Fiber.interrupt(sending);
				}),
			),
	);

it.effect(
	"SEND-CONTINUATION 38 legacy holderless dispatched work keeps legacy recovery and never enters C2",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
				const old = yield* f.register("legacy", 100_350, {
					ownedRunIds: ["legacy-run"],
				});
				f.processes.set(old.pid, { state: "gone" });
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('legacy-run', 's', 'running', 1)`;
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id, provider_process_id)
		VALUES (1, 'legacy-send', 'test-project', 's', 'claude', 'send_turn', '{"inputId":"legacy-send","prompt":"legacy"}', 'running', 1, 1, 1, 'legacy-run', ${old.pid})`;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"run.dispatched",
						"s",
						{ runId: "legacy-run", runnerId: "legacy" },
						{ provider: "claude", metadata: { runId: "legacy-run" } },
					),
				]);
				// Historical imports already projected this event before runner_id
				// existed; migration adds NULL and does not infer its delivery.
				yield* f.sql`UPDATE provider_runs SET runner_id = NULL WHERE id = 'legacy-run'`;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				f.output.mockImplementation((output) =>
					output.type === "event"
						? ingestion.ingest(output.event).pipe(
								Effect.mapError((cause) =>
									runnerFailure("test ingestion", cause),
								),
								Effect.as({}),
							)
						: Effect.succeed({}),
				);
				yield* f.recover;
				yield* TestClock.adjust("12 seconds");
				expect(f.connect).not.toHaveBeenCalled();
				expect(f.children.size).toBe(0);
				expect(
					yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'legacy-run'`,
				).toEqual([
					{ status: "interrupted", runner_id: null, held_transmission: null },
				]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.commandId') AS command FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ command: null }]);
				expect(
					yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
				).toEqual([{ n: 0 }]);
			}),
		),
);

it.effect(
	"SEND-CONTINUATION 41 idle pre-write NotSent evidence immediately re-holds on a successor",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				let announced = false;
				let mayExit = false;
				f.signal.mockImplementation((pid, signal) => {
					f.signals.push({ pid, signal });
					if (mayExit) f.processes.set(Math.abs(pid), { state: "gone" });
				});
				f.respond((connection, command) => {
					if (!announced) {
						announced = true;
						connection.onIdleExit?.();
						return Effect.fail<RunnerCommandFailure>({
							...runnerFailure("pre-write idle", "No socket write was called"),
							delivery: { _tag: "NotSent" },
						});
					}
					return f.complete(connection, command);
				});
				const send = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust("1 second");
				expect(
					yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
				).toEqual([{ reason: "NotSent" }]);
				mayExit = true;
				yield* TestClock.adjust("12 seconds");
				yield* Fiber.join(send);
				expect(f.delivered).toEqual(["send"]);
				expect(f.sends).toHaveLength(2);
				expect(f.connections).toHaveLength(2);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "completed" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
				).toEqual([{ reason: "NotSent" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
				).toEqual([{ n: 1 }, { n: 2 }]);
			}),
		),
);

it.effect(
	"SEND-CONTINUATION older-build unknown adoption never replays a modern held transmission through legacy recovery",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture({ journalCapable: false });
				yield* f.seed("run");
				f.respond(() => Effect.never);
				const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(f.sends).toHaveLength(1);
				const old = f.connections[0];
				if (!old?.pid) return yield* Effect.die("missing older-build runner");
				yield* Fiber.interrupt(sending);
				yield* Scope.close(f.managerScope, Exit.void);
				const recovered = yield* f.makeManager();
				const recovering = yield* recovered.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust("2 seconds");
				yield* Fiber.join(recovering);
				expect(f.delivered).toEqual([]);
				expect(f.sends).toHaveLength(1);
				expect(f.connections).toHaveLength(2);
				expect(f.connections[1]?.runnerId).toBe(old.runnerId);
				expect(f.processes.get(old.pid)?.state).toBe("running");
				expect(
					yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([
					{ status: "pending", runner_id: old.runnerId, held_transmission: 1 },
				]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
				).toEqual([{ status: "running", error_code: null }]);
				expect(
					yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 1 }]);
				expect(
					yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
				).toEqual([{ n: 0 }]);
			}),
		),
);

// A retained receive journal outranks the host's in-memory command map. Only
// a missing retained answer on a connection-draining host can prove NotSent.
it.effect(
	"SEND-CONTINUATION restart prepares an unheld running owner from durable input before feeding once",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				yield* f.sql`UPDATE provider_runs SET status = 'running' WHERE id = 'run'`;
				expect(
					yield* f.manager.ownsRetirementCleanupEffect?.("s", "run") ??
						Effect.die("missing retirement ownership seam"),
				).toBe(true);
				const payload = {
					inputId: "send",
					prompt: "send",
					workspaceRoot: f.root,
					extraFolders: [],
					configDir: configuredClaudeConfigDir(f.root),
					folderSource: "account",
					resumeSessionId: "obsolete-prepared-resume",
					history: [],
				};
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = ${JSON.stringify(payload)} WHERE command_id = 'send'`;
				yield* Scope.close(f.managerScope, Exit.void);
				const recovered = yield* f.makeManager();
				const recovering = yield* recovered.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust("2 seconds");
				yield* Fiber.join(recovering);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'send'`,
				).toEqual([{ status: "completed" }]);
				expect(f.delivered).toEqual(["send"]);
				expect(f.sends).toHaveLength(1);
				expect(f.sends[0]?.command.input).toMatchObject({
					workspaceRoot: f.root,
					configDir: configuredClaudeConfigDir(f.root),
					startFreshNativeSession: true,
				});
				expect(f.sends[0]?.command.input.resumeSessionId).toBeUndefined();
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "completed" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 1 }]);
			}),
		),
);

for (const exited of [false, true])
	for (const variant of ["flag", "failure", "result"] as const)
		it.effect(
			`SEND-CONTINUATION 37 restart ${variant} rejection releases before fresh preparation (exited=${exited})`,
			() =>
				run(
					Effect.gen(function* () {
						const failure = {
							...runnerFailure(
								"native resume",
								"Resume rejected by --resume-drops-turn: stale",
							),
							code: "claude_resume_refused",
						};
						const result = {
							status: "error" as const,
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
							error: { code: failure.code, message: failure.message },
							...(variant === "flag" ? { nativeResumeRejected: true } : {}),
						};
						const f = yield* continuationFixture({
							drainsConnections: true,
							adoptionAnswer: {
								commandId: "send",
								attempt: 1,
								nativeResumeFallback: false,
								status: "finished",
								...(variant === "failure" ? { failure } : { result }),
							},
						});
						yield* f.seed("run");
						yield* f.sql`UPDATE provider_command_outbox SET payload_json = ${JSON.stringify({ ...f.input, inputId: "send", prompt: "send", history: [] })} WHERE command_id = 'send'`;
						f.respond(() => Effect.never);
						const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
						yield* TestClock.adjust(0);
						const old = f.connections[0];
						if (!old?.pid) return yield* Effect.die("missing rejected runner");
						const journal = new RunnerSendJournal(
							dirname(old.socketPath),
							"s",
							"claude",
						);
						yield* journal
							.execute(
								"send",
								1,
								false,
								variant === "failure"
									? Effect.fail(failure)
									: Effect.succeed(result),
							)
							.pipe(Effect.result);
						yield* Fiber.interrupt(sending);
						yield* Scope.close(f.managerScope, Exit.void);
						if (exited) f.processes.set(old.pid, { state: "gone" });
						f.respond(f.complete);
						const recovered = yield* f.makeManager();
						const recovering = yield* recovered.manager.recoverEffect.pipe(
							Effect.forkChild,
						);
						yield* TestClock.adjust("12 seconds");
						yield* Fiber.join(recovering);
						expect(f.delivered).toEqual(["send"]);
						expect(f.sends).toHaveLength(2);
						expect(f.sends[1]?.command.input).toMatchObject({
							nativeResumeFallback: true,
							startFreshNativeSession: true,
						});
						expect(f.sends[1]?.command.input.resumeSessionId).toBeUndefined();
						expect(
							yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
						).toEqual([{ reason: "ResumeRejected" }]);
						expect(
							yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
						).toEqual([{ n: 1 }, { n: 2 }]);
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
						).toEqual([{ status: "completed" }]);
						expect(
							yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'send'`,
						).toEqual([{ status: "completed" }]);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type = 'turn.error'`,
						).toEqual([]);
					}),
				),
		);

it.effect(
	"SEND-CONTINUATION 37/43 adoption probes the unwritten fallback instead of its completed primary",
	() =>
		run(
			Effect.gen(function* () {
				const failure = {
					...runnerFailure("native resume", "stale"),
					code: "claude_resume_refused",
				};
				const f = yield* continuationFixture({
					drainsConnections: true,
					adoptionAnswer: {
						commandId: "send",
						attempt: 1,
						nativeResumeFallback: false,
						status: "finished",
						failure,
					},
				});
				yield* f.seed("run");
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = ${JSON.stringify({ ...f.input, inputId: "send", prompt: "send", history: [] })} WHERE command_id = 'send'`;
				f.respond(() =>
					Effect.succeed({
						...f.accepted,
						status: "error",
						nativeResumeRejected: true,
						error: { code: failure.code, message: failure.message },
					}),
				);
				yield* f.dispatch("run");
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.nativeResumeFallback', json('true')) WHERE command_id = 'send'`;
				f.respond(() => Effect.never);
				const sending = yield* f
					.dispatch("run", "send", true)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const old = f.connections[0];
				if (!old?.pid) return yield* Effect.die("missing fallback runner");
				const journal = new RunnerSendJournal(
					dirname(old.socketPath),
					"s",
					"claude",
				);
				yield* journal
					.execute("send", 1, false, Effect.fail(failure))
					.pipe(Effect.result);
				yield* Fiber.interrupt(sending);
				yield* Scope.close(f.managerScope, Exit.void);
				f.statuses.mockImplementation((_command, _attempt, fallback) =>
					Effect.succeed(fallback ? "not_received" : "completed"),
				);
				f.respond(f.complete);
				const recovered = yield* f.makeManager();
				const recovering = yield* recovered.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust("12 seconds");
				yield* Fiber.join(recovering);
				expect(f.statuses).toHaveBeenCalledWith("send", 1, true);
				expect(f.delivered).toEqual(["send"]);
				expect(f.sends).toHaveLength(3);
				expect(f.sends[2]?.command.input.nativeResumeFallback).toBe(true);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released' ORDER BY sequence`,
				).toEqual([{ reason: "ResumeRejected" }, { reason: "NotSent" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
				).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "completed" }]);
			}),
		),
);

it.effect(
	"SEND-CONTINUATION released resume rejection survives delayed restart preparation",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = ${JSON.stringify({ ...f.input, inputId: "send", prompt: "send", history: [] })} WHERE command_id = 'send'`;
				f.respond(() => Effect.never);
				const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const old = f.connections[0];
				if (!old?.pid) return yield* Effect.die("missing rejected runner");
				const journal = new RunnerSendJournal(
					dirname(old.socketPath),
					"s",
					"claude",
				);
				yield* journal
					.execute(
						"send",
						1,
						false,
						Effect.fail({
							...runnerFailure("native resume", "stale"),
							code: "claude_resume_refused",
						}),
					)
					.pipe(Effect.result);
				yield* Fiber.interrupt(sending);
				yield* Scope.close(f.managerScope, Exit.void);
				f.processes.set(old.pid, { state: "gone" });
				const preparing = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				f.respond(f.complete);
				const recovered = yield* f.makeManager({
					accounts: Effect.gen(function* () {
						if (
							(yield* f.sql`SELECT 1 FROM events WHERE type = 'run.released'`)
								.length
						) {
							yield* Deferred.succeed(preparing, undefined);
							yield* Deferred.await(resume);
						}
						return accountsStateFromInstances(
							[],
							configuredClaudeConfigDir(f.root),
						);
					}).pipe(Effect.orDie),
				});
				yield* Effect.gen(function* () {
					const recovering = yield* recovered.manager.recoverEffect.pipe(
						Effect.forkChild,
					);
					yield* Deferred.await(preparing);
					yield* TestClock.adjust("1 second");
					expect(
						yield* f.sql`SELECT status, runner_id FROM provider_runs WHERE id = 'run'`,
					).toEqual([{ status: "pending", runner_id: null }]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'send'`,
					).toEqual([{ status: "running" }]);
					expect(f.delivered).toEqual([]);
					yield* Deferred.succeed(resume, undefined);
					yield* TestClock.adjust("12 seconds");
					yield* Fiber.join(recovering);
					expect(f.delivered).toEqual(["send"]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
					).toEqual([{ status: "completed" }]);
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			}),
		),
);

for (const answer of [
	"uncertain",
	"running",
	"finished",
	"absent",
	"undrained",
] as const)
	it.effect(
		`SEND-CONTINUATION adoption ${answer} keeps journal ownership before status absence`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* continuationFixture({
						drainsConnections: answer !== "undrained",
						...(answer === "absent" || answer === "undrained"
							? {}
							: {
									adoptionAnswer: {
										commandId: "send",
										attempt: 1,
										nativeResumeFallback: false,
										status: answer,
										...(answer === "finished"
											? {
													failure: {
														...runnerFailure(
															"retained journal",
															"native refusal",
														),
														code: "retained_native_refusal",
													},
												}
											: {}),
									},
								}),
					});
					yield* f.seed("run");
					f.respond(() => Effect.never);
					const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					const old = f.connections[0];
					if (!old?.pid) return yield* Effect.die("missing adoption runner");
					if (answer !== "absent" && answer !== "undrained") {
						const journal = new RunnerSendJournal(
							dirname(old.socketPath),
							"s",
							"claude",
						);
						if (answer === "finished")
							yield* journal
								.execute(
									"send",
									1,
									false,
									Effect.fail({
										...runnerFailure("retained journal", "native refusal"),
										code: "retained_native_refusal",
									}),
								)
								.pipe(Effect.result);
						else {
							yield* journal
								.execute("send", 1, false, Effect.never)
								.pipe(Effect.forkChild);
							yield* TestClock.adjust(0);
						}
					}
					yield* Fiber.interrupt(sending);
					yield* Scope.close(f.managerScope, Exit.void);
					f.respond(f.complete);
					const recovered = yield* f.makeManager();
					const recovering = yield* recovered.manager.recoverEffect.pipe(
						Effect.forkChild,
					);
					yield* TestClock.adjust("2 seconds");
					yield* Fiber.join(recovering);
					expect(f.statuses).toHaveBeenCalledTimes(answer === "absent" ? 1 : 0);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
					).toEqual(answer === "absent" ? [{ reason: "NotSent" }] : []);
					expect(f.delivered).toEqual(answer === "absent" ? ["send"] : []);
					expect(f.sends).toHaveLength(answer === "absent" ? 2 : 1);
					expect(
						yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
					).toEqual([
						{
							status:
								answer === "absent"
									? "completed"
									: answer === "finished"
										? "error"
										: "pending",
							runner_id: old.runnerId,
							held_transmission: answer === "absent" ? 2 : 1,
						},
					]);
					if (answer === "finished")
						expect(
							yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
						).toEqual([
							{ status: "failed", error_code: "retained_native_refusal" },
						]);
				}),
			),
	);

it.effect(
	"REVIEW R1 pre-upgrade started holderless owner stays on legacy recovery",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("legacy-run", "legacy-send");
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"run.started",
						"s",
						{ inputId: "legacy-send", requestedRunId: "legacy-run" },
						{ provider: "claude", metadata: { runId: "legacy-run" } },
					),
				]);
				expect(
					yield* f.manager.ownsRetirementCleanupEffect?.("s", "legacy-run") ??
						Effect.die("missing retirement ownership seam"),
				).toBe(false);
				yield* Scope.close(f.managerScope, Exit.void);
				const recovered = yield* f.makeManager();
				yield* recovered.manager.recoverEffect;
				yield* TestClock.adjust("2 seconds");
				expect(f.sends).toEqual([]);
				expect(
					yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 0 }]);
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* RunnerRecovery.settleUnclaimedRunnerCommands(
					f.sql,
					new Set(),
					"claude",
					() => "claude",
					(sinkId, turn, failure, beforeProject) =>
						failRunnerTurn(
							(output) =>
								output.type === "event"
									? ingestion
											.ingestBatch([output.event], { beforeProject })
											.pipe(
												Effect.mapError((cause) =>
													runnerFailure("test legacy recovery", cause),
												),
												Effect.as({}),
											)
									: Effect.succeed({}),
							sinkId,
							turn,
							failure,
							"claude",
						),
					undefined,
					undefined,
					undefined,
					(sessionId, runId) =>
						recovered.manager.ownsRetirementCleanupEffect?.(sessionId, runId) ??
						Effect.succeed(false),
				);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'legacy-run'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'legacy-send'`,
				).toEqual([{ status: "failed", error_code: "runner_stopped" }]);
				expect(f.sends).toEqual([]);
			}),
		),
);

for (const status of ["accepted", "completed"] as const)
	it.effect(
		`REVIEW R1 Gone journal ${status} settles one consistent run and command terminal`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* continuationFixture();
					yield* f.seed("run");
					f.respond(() => Effect.never);
					const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					const first = f.connections[0];
					if (!first?.pid) return yield* Effect.die("missing held runner");
					const journal = new RunnerSendJournal(
						dirname(first.socketPath),
						"s",
						"claude",
					);
					yield* journal.execute(
						"send",
						1,
						false,
						Effect.succeed({ ...f.accepted, status }),
					);
					f.processes.set(first.pid, { state: "gone" });
					f.children.get(first.pid)?.emit("exit", 1, null);
					first.onClose(
						runnerFailure("test exit", "runner exited after journal reply"),
					);
					yield* TestClock.adjust("12 seconds");
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
					).toEqual([
						{
							status: status === "completed" ? "completed" : "failed",
							error_code:
								status === "completed" ? null : "delivery_indeterminate",
						},
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
					).toEqual([
						{ status: status === "completed" ? "completed" : "error" },
					]);
					expect(
						yield* f.sql`SELECT type, json_extract(data, '$.code') AS code FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`,
					).toEqual([
						{
							type: status === "completed" ? "turn.completed" : "turn.error",
							code: status === "completed" ? null : "delivery_indeterminate",
						},
					]);
					expect(f.sends).toHaveLength(1);
					yield* Fiber.interrupt(sending);
				}),
			),
	);

it.effect(
	"REVIEW R1 runner exit retries its initial Stop persistence without retransmitting",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				f.respond(() => Effect.never);
				const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const first = f.connections[0];
				if (!first?.pid) return yield* Effect.die("missing held runner");
				const journal = new RunnerSendJournal(
					dirname(first.socketPath),
					"s",
					"claude",
				);
				yield* journal
					.execute("send", 1, false, Effect.never)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				yield* f.sql`CREATE TRIGGER reject_exit_stop BEFORE UPDATE OF retired_at ON claude_runner_cursors WHEN NEW.retired_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'initial Stop temporarily unavailable'); END`;
				f.processes.set(first.pid, { state: "gone" });
				f.children.get(first.pid)?.emit("exit", 1, null);
				first.onClose(
					runnerFailure(
						"test exit",
						"runner exited with persistence unavailable",
					),
				);
				yield* TestClock.adjust("1 second");
				expect(
					yield* f.sql`SELECT status, runner_id FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "pending", runner_id: first.runnerId }]);
				yield* f.sql`DROP TRIGGER reject_exit_stop`;
				yield* TestClock.adjust("12 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
				).toEqual([{ status: "failed", error_code: "delivery_indeterminate" }]);
				expect(
					yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.error'`,
				).toEqual([{ n: 1 }]);
				expect(f.sends).toHaveLength(1);
				yield* Fiber.interrupt(sending);
			}),
		),
);

for (const provenance of ["direct", "joined"] as const)
	it.effect(
		`R2 SQL legacy cohort ${provenance} survives missing event timestamps and malformed neighbors`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					yield* f.register("cdcdcdcdcdcd", 100_901, {
						ownedRunIds: [provenance === "direct" ? "old-owner" : "old-joined"],
					});
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('old-owner','s','running',1)`;
					if (provenance === "joined")
						yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at, joined_into) VALUES ('old-joined','s','joined',1,'old-owner')`;
					yield* f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, owned_run_ids, retired_at) VALUES ('bad-json',0,'s','not-json',1),('bad-object',0,'s','{"run":"object-only"}',1)`;
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('object-only','s','pending',1)`;
					expect(
						yield* RunnerRecovery.legacyRunnerRunQuery(f.sql, "s", "old-owner"),
					).toBe(true);
					expect(
						yield* RunnerRecovery.legacyRunnerRunQuery(
							f.sql,
							"s",
							"object-only",
						),
					).toBe(false);
				}),
			),
	);

for (const reason of ["ResumeRejected", "JournalAbsent"] as const)
	it.effect(
		`R2 SQL legacy cohort cannot override modern ${reason} or pending owner provenance`,
		() =>
			run(
				Effect.gen(function* () {
					const f = yield* setup;
					yield* f.register("cececececece", 100_902, {
						ownedRunIds: ["released", "modern"],
					});
					yield* f.sql`INSERT INTO provider_runs (id,session_id,status,requested_at) VALUES ('released','s','running',1),('modern','s','pending',1),('queued','s','pending',1),('discovered','s','running',1)`;
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("run.dispatched", "s", {
							runId: "released",
							runnerId: "cececececece",
							commandId: "released-send",
							transmission: 1,
						}),
						canonicalEvent("run.released", "s", {
							runId: "released",
							runnerId: "cececececece",
							commandId: "released-send",
							transmission: 1,
							reason,
						}),
						canonicalEvent("run.dispatched", "s", {
							runId: "modern",
							runnerId: "cececececece",
							commandId: "modern-send",
							transmission: 1,
						}),
					]);
					// Discovery-only ownership cannot enter this SQL-backed classification.
					const directory = prepareRunnerDirectory(f.root, f.root);
					const runnerId = "cfcfcfcfcfcf";
					const socketPath = join(directory, runnerId);
					writeFileSync(
						`${socketPath}.json`,
						JSON.stringify({
							runnerId,
							sessionId: "s",
							driverKind: "claude",
							socketPath,
							pid: 100_903,
							buildId: runnerBuildId(),
							ownedRunIds: ["discovered"],
						}),
					);
					for (const runId of ["released", "modern", "queued", "discovered"])
						expect(
							yield* RunnerRecovery.legacyRunnerRunQuery(f.sql, "s", runId),
						).toBe(false);
				}),
			),
	);

it.effect(
	"REVIEW R1 startup Gone Settle keeps retrying after its first transaction fails",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				f.respond(() => Effect.never);
				yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const first = f.connections[0];
				if (!first?.pid) return yield* Effect.die("missing held runner");
				registerRunner({
					runnerId: first.runnerId,
					sessionId: "s",
					socketPath: first.socketPath,
					pid: first.pid,
					startTime: `spawned-${first.pid}`,
					driverKind: "claude",
					buildId: runnerBuildId(),
				});
				const journal = new RunnerSendJournal(
					dirname(first.socketPath),
					"s",
					"claude",
				);
				yield* journal
					.execute("send", 1, false, Effect.never)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				yield* Scope.close(f.managerScope, Exit.void);
				f.processes.set(first.pid, { state: "gone" });
				yield* f.sql`CREATE TRIGGER reject_startup_settle BEFORE UPDATE OF status ON provider_runs WHEN NEW.status = 'error' BEGIN SELECT RAISE(FAIL, 'Settle temporarily unavailable'); END`;
				const recovered = yield* f.makeManager();
				yield* recovered.manager.recoverEffect;
				yield* TestClock.adjust("1 second");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "pending" }]);
				yield* f.sql`DROP TRIGGER reject_startup_settle`;
				yield* TestClock.adjust("12 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
				).toEqual([{ status: "failed", error_code: "delivery_indeterminate" }]);
				expect(
					yield* f.sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.error'`,
				).toEqual([{ n: 1 }]);
				expect(f.sends).toHaveLength(1);
			}),
		),
);

it.effect(
	"REVIEW R1 a live release wakes its feeder without launching a recovery scan",
	() =>
		run(
			Effect.gen(function* () {
				const scans = vi.spyOn(RunnerRecovery, "runningRunnerCommands");
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => scans.mockRestore()),
				);
				const f = yield* continuationFixture();
				yield* f.seed("run");
				let refused = false;
				f.respond((connection, command) => {
					if (!refused) {
						refused = true;
						return f.refuse("exiting");
					}
					return f.complete(connection, command);
				});
				const before = scans.mock.calls.length;
				const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust("12 seconds");
				yield* Fiber.join(sending);
				expect(f.delivered).toEqual(["send"]);
				expect(scans.mock.calls.length).toBe(before);
				expect(
					yield* f.manager.ownsRetirementCleanupEffect?.("s", "run") ??
						Effect.die("missing retirement ownership seam"),
				).toBe(false);
				expect(scans.mock.calls.length).toBe(before);
			}),
		),
);

it.effect(
	"REVIEW R1 accepted journal Stop settlement retains the exact process-stop event protocol",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* continuationFixture();
				yield* f.seed("run");
				f.respond(() => Effect.never);
				const sending = yield* f.dispatch("run").pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const first = f.connections[0];
				if (!first?.pid) return yield* Effect.die("missing held runner");
				const journal = new RunnerSendJournal(
					dirname(first.socketPath),
					"s",
					"claude",
				);
				yield* journal.execute("send", 1, false, Effect.succeed(f.accepted));
				f.processes.set(first.pid, { state: "gone" });
				const stopping = yield* f.manager
					.executeEffect({ type: "end-session", sessionId: "s" })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("12 seconds");
				yield* Fiber.join(stopping);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: "interrupted" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.status') AS status FROM events WHERE type = 'session.status' AND json_extract(data, '$.status') = 'idle'`,
				).toEqual([{ status: "idle" }]);
				const terminals = yield* f.sql<{
					type: string;
					data: string;
				}>`SELECT type, data FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`;
				expect(
					terminals.map(({ type, data }) => {
						const payload: unknown = JSON.parse(data);
						return { type, data: payload };
					}),
				).toEqual([
					{
						type: "turn.interrupted",
						data: { messageId: "", reason: "Provider process stopped" },
					},
				]);
				expect(f.sends).toHaveLength(1);
				yield* Fiber.interrupt(sending);
			}),
		),
);
