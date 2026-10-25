import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	makeProcessSessionRunner,
	type ProcessRunnerDriver,
} from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	RunnerSocket,
	runnerBuildId,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	prepareRunnerDirectory,
	type RunnerRegistration,
	runnerProcessTable,
} from "../../../src/lib/provider/runner/runner-registry.js";
import type { SessionOutput } from "../../../src/lib/provider/runner/session-runner.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";

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
		}
	>();
	const signals: Array<{
		readonly pid: number;
		readonly signal: NodeJS.Signals;
	}> = [];
	const signal = vi.fn((pid: number, signal: NodeJS.Signals) => {
		signals.push({ pid, signal });
	});
	let spawnedCount = 0;
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
		return child as unknown as ChildProcess;
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
		recoverCommands: () => Effect.succeed([]),
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
			return entry;
		});
	const makeManager = () =>
		makeProcessSessionRunner(
			{
				daemonConfigDir: root,
				projectRootForSession: () => Effect.succeed(root),
				processTable: {
					inspect: (pid) => processes.get(pid) ?? { state: "gone" },
					signal,
				},
			},
			output,
			driver,
		);
	const output = vi.fn<Parameters<typeof makeProcessSessionRunner>[1]>(() =>
		Effect.succeed({}),
	);
	const managerScope = yield* Scope.make();
	yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
	const manager = yield* makeManager().pipe(
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
		managerScope,
		makeManager,
		root,
		register,
		recover,
		connect,
		signal,
		signals,
		processes,
		notices,
		output,
		sql,
	};
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return Effect.scoped(effect).pipe(
		Effect.provide(
			Layer.merge(
				persistence,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
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
				expect(f.signals).toEqual([{ pid: first.pid, signal: "SIGKILL" }]);
				yield* TestClock.adjust("19999 millis");
				expect(f.signals).toHaveLength(1);
				yield* TestClock.adjust("1 millis");
				expect(f.signals).toHaveLength(2);
				expect(yield* f.notices).toEqual([]);
				yield* TestClock.adjust("30 seconds");
				expect(f.signals).toHaveLength(3);
				expect((yield* f.notices).map((row) => JSON.parse(row.data))).toEqual([
					{
						text: `The previous run (pid ${first.pid}) was told to stop but hasn't exited yet. It can't make further changes and will exit when the system releases it.`,
					},
				]);
				yield* TestClock.adjust("5 minutes");
				expect(f.signals).toHaveLength(3);
				expect(yield* f.notices).toHaveLength(1);
				expect(
					yield* f.sql`SELECT retired_at, attachment_id FROM claude_runner_cursors WHERE runner_id = ${first.runnerId}`,
				).toEqual([{ retired_at: 1, attachment_id: "" }]);
				f.processes.set(first.pid, { state: "gone" });
				yield* TestClock.adjust("10 seconds");
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
				expect(f.signals.map((s) => s.pid)).toEqual([100_005]);
				yield* TestClock.adjust("5 seconds");
				expect(f.signals.map((s) => s.pid)).toEqual([100_005, 100_006]);
				yield* TestClock.adjust("15 seconds");
				expect(f.signals.map((s) => s.pid)).toEqual([
					100_005, 100_006, 100_005,
				]);
				yield* TestClock.adjust("5 seconds");
				expect(f.signals.map((s) => s.pid)).toEqual([
					100_005, 100_006, 100_005, 100_006,
				]);
				yield* TestClock.adjust("25 seconds");
				expect(f.signals.map((s) => s.pid)).toEqual([
					100_005, 100_006, 100_005, 100_006, 100_005,
				]);
				yield* TestClock.adjust("5 seconds");
				expect(f.signals.map((s) => s.pid)).toEqual([
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
				expect(f.signals).toEqual([{ pid: entry.pid, signal: "SIGKILL" }]);
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
				const restarted = yield* f.makeManager();
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
				const restarted = yield* f.makeManager();
				yield* restarted.recoverEffect;
				yield* TestClock.adjust("60 seconds");
				expect(f.connect).not.toHaveBeenCalled();
				expect(yield* f.notices).toHaveLength(1);
			}),
		),
);

it.effect(
	"retries a transiently failed survivor notice on the next watcher tick without duplicating it",
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
				yield* TestClock.adjust("60 seconds");
				expect(f.signals).toHaveLength(3);
				expect(yield* f.notices).toEqual([]);
				yield* TestClock.adjust("10 seconds");
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
								sendCommands: [],
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
								sendCommands: [],
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
		`adopts the newer live registration and retires the older, cross-directory=${crossDirectory}`,
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
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('old-run', 's', 'running', 1), ('new-run', 's', 'running', 2)`;
					yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, provider_process_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'old-command', 'test-project', 's', 'claude', 'send_turn', 'old-run', NULL, '{}', 'running', 1, 1, 1), (2, 'new-command', 'test-project', 's', 'claude', 'send_turn', 'new-run', NULL, '{}', 'running', 1, 2, 2)`;
					yield* f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, owned_run_ids)
					VALUES (${older.runnerId}, 1, '[]'), (${newer.runnerId}, 1, '[]')`;
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
									runnerId: options.runnerId,
									sessionId: "s",
									pid: options.pid ?? 0,
									bindings: [],
									sendCommands: [
										{
											commandId:
												options.runnerId === older.runnerId
													? "old-command"
													: "new-command",
											attempt: 1,
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
						{ id: "old-run", status: "interrupted" },
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
						{ id: "old-run", status: "interrupted" },
					]);
					expect(
						yield* f.manager.hasLiveProcessEffect("s", retired.runnerId),
					).toBe(false);
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
									bindings: [{ sinkId: "retained-sink", sessionId: "s" }],
									sendCommands: [],
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
						expect(outputs).toEqual([
							{
								type: "background-task",
								transition: { sessionId: "s", kind: "session-ended" },
							},
							{ type: "release-sink", sinkId: "retained-sink" },
						]);
						expect(
							yield* f.manager.hasLiveProcessEffect("s", old.runnerId),
						).toBe(false);
					}
				}),
			),
	);

it.effect(
	"releases a failed force-stop and starts the next message on a fresh runner",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* setup;
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
								sendCommands: [],
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
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('old-run', 's', 'running', 1)`;
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
				).toEqual([{ owned_run_ids: '["old-run"]' }]);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
				).toEqual([{ status: "interrupted" }]);
				expect(f.signals.map((signal) => signal.signal)).toEqual([
					"SIGTERM",
					"SIGKILL",
				]);
				expect(yield* f.manager.hasLiveProcessEffect("s", old?.runnerId)).toBe(
					false,
				);
				yield* f.manager.executeEffect({
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
				if (old?.pid !== undefined) f.processes.set(old.pid, { state: "gone" });
				yield* TestClock.adjust("10 seconds");
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
				f.processes.set(pid, { state: "gone" });
			});
			yield* f.recover;
			yield* TestClock.adjust("60 seconds");
			expect(f.signals).toEqual([{ pid: entry.pid, signal: "SIGKILL" }]);
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
					yield* TestClock.adjust("10 seconds");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${entry.runnerId}`,
					).toEqual([]);
					expect(yield* f.notices).toEqual([]);
				}),
			),
	);

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
