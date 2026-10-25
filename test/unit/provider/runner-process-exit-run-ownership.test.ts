import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it as effectIt } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ spawn: vi.fn(), alive: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: transport.spawn,
}));
vi.mock(
	"../../../src/lib/provider/runner/runner-registry.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/provider/runner/runner-registry.js")
		>()),
		runnerPidAlive: transport.alive,
	}),
);

import {
	AccountIdSchema,
	type ClaudeAccount,
} from "../../../src/lib/contracts/account.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	makeProcessSessionRunner,
	type ProcessRunnerDriver,
} from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	RUNNER_PROTOCOL_VERSION,
	RunnerSocket,
	runnerBuildId,
	runnerFailure,
	runnerIdleFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { failRunnerTurn } from "../../../src/lib/provider/runner/runner-turn-failure.js";
import type { SessionCommand } from "../../../src/lib/provider/runner/session-runner.js";

class TestChild extends EventEmitter {
	constructor(readonly pid = 99_999_999) {
		super();
	}
	exitCode: number | null = null;
	signalCode = null;
	connected = false;
	unref() {}
	disconnect() {}
}

it("observes a replacement's lower revisions without losing its launch snapshot", async () => {
	vi.stubEnv("CONDUIT_TEST_BUILD_ID", "generation-current-build");
	const root = mkdtempSync(join(tmpdir(), "run-generation-revision-"));
	roots.push(root);
	const children = [new TestChild(), new TestChild(99_999_998)];
	let spawned = 0;
	transport.alive.mockImplementation((pid: number) =>
		children.some((child) => child.pid === pid && child.exitCode === null),
	);
	transport.spawn.mockImplementation(() => {
		const child = children[spawned++];
		if (!child) throw new Error("Unexpected third runner");
		queueMicrotask(() =>
			child.emit("message", {
				channel: "conduit-claude-runner",
				type: "listening",
			}),
		);
		return child;
	});
	const kill = vi.spyOn(process, "kill").mockImplementation(() => {
		throw new Error("Revision fixture must never signal a PID");
	});
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const promoted = yield* Deferred.make<void>();
					const peers: Parameters<ProcessRunnerDriver["connect"]>[0][] = [];
					const input = {
						sessionId: "s",
						workspaceRoot: root,
						extraFolders: [],
						providerState: {},
						configDir: configuredClaudeConfigDir(root),
						folderSource: "account" as const,
					};
					const snapshot = { input, options: {} };
					const retire = vi.fn<RunnerSocket["retireEffect"]>(() =>
						Effect.succeed(true),
					);
					const driver: ProcessRunnerDriver = {
						driverKind: "claude",
						connect: (options) =>
							Effect.gen(function* () {
								const index = peers.length;
								peers.push(options);
								const child = children[index];
								if (!child) throw new Error("Unexpected third attachment");
								const connection = new RunnerSocket(
									new Socket(),
									() => {},
									options.onClose,
								);
								vi.spyOn(connection, "write").mockImplementation(() => {});
								vi.spyOn(connection, "retireEffect").mockImplementation(retire);
								vi.spyOn(connection, "commandEffect").mockImplementation(
									(_id, command) =>
										Effect.sync(() => {
											// The old peer stops only after replacement ownership is published.
											if (index === 0 && command.type === "shutdown")
												Deferred.doneUnsafe(promoted, Effect.void);
											if (index === 1 && command.type === "pre-warm")
												options.onUpgradeState?.({
													quiescent: true,
													revision: 5,
													resumeSessionId: "replacement-5",
												});
											return undefined;
										}),
								);
								const destroy = connection.destroy.bind(connection);
								vi.spyOn(connection, "destroy").mockImplementation(
									(failure) => {
										child.exitCode = 0;
										destroy(failure);
									},
								);
								yield* options.onHello(
									{
										type: "hello",
										protocolVersion: RUNNER_PROTOCOL_VERSION,
										buildId:
											index === 0 ? "generation-old-build" : runnerBuildId(),
										stampsRunIds: true,
										runnerId: options.runnerId,
										sessionId: options.sessionId,
										pid: child.pid,
										upgradeState:
											index === 0
												? {
														quiescent: false,
														revision: 100,
														snapshot,
														resumeSessionId: "source-100",
													}
												: { quiescent: true, revision: 0 },
									},
									connection,
								);
								return connection;
							}),
						settingsDeferredCode: "test-deferred",
						warmCommand: (sessionId, state, launch) => {
							expect(state.revision).toBe(100);
							expect(launch).toEqual(snapshot);
							return {
								type: "pre-warm",
								sessionId,
								input: launch.input,
								settingsSnapshot: launch,
							};
						},
						snapshotCommandSettings: () => ({}),
						loginChange: () => "None",
						recoverCommands: () => Effect.succeed([]),
					};
					const runner = yield* makeProcessSessionRunner(
						{
							projectRootForSession: () => Effect.succeed(root),
							daemonConfigDir: root,
						},
						() => Effect.succeed({}),
						driver,
					);
					if (!runner.getNativeSessionEffect || !runner.hasDemandEffect)
						throw new Error("Missing process runner observations");
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							for (const child of children) child.exitCode = 0;
						}),
					);
					yield* runner.executeEffect({
						type: "pre-warm",
						sessionId: "s",
						input,
					});
					const source = peers[0];
					if (!source?.onUpgradeState)
						throw new Error("Missing source observer");
					source.onUpgradeState({ quiescent: true, revision: 100 });
					yield* Deferred.await(promoted);
					expect(yield* runner.getNativeSessionEffect("s")).toMatchObject({
						configDir: input.configDir,
						resumeSessionId: "replacement-5",
					});
					expect(yield* runner.hasDemandEffect("s")).toBe(false);
					const replacement = peers[1];
					if (!replacement?.onUpgradeState)
						throw new Error("Missing replacement observer");
					replacement.onUpgradeState({
						quiescent: false,
						revision: 6,
						resumeSessionId: "replacement-6",
						snapshot: {
							...snapshot,
							input: {
								...input,
								configDir: configuredClaudeConfigDir(join(root, "replacement")),
							},
						},
					});
					expect(yield* runner.hasDemandEffect("s")).toBe(true);
					expect(yield* runner.getNativeSessionEffect("s")).toMatchObject({
						configDir: configuredClaudeConfigDir(join(root, "replacement")),
						resumeSessionId: "replacement-6",
					});
				}),
			),
		);
		expect(kill).not.toHaveBeenCalled();
	} finally {
		kill.mockRestore();
	}
});

it("preserves an unaccepted reservation when idle exit retries on a replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "run-idle-retry-"));
	roots.push(root);
	const children = [new TestChild(), new TestChild(99_999_998)];
	let spawned = 0;
	transport.alive.mockImplementation((pid: number) =>
		children.some((child) => child.pid === pid && child.exitCode === null),
	);
	transport.spawn.mockImplementation(() => {
		const child = children[spawned++];
		if (!child) throw new Error("Unexpected third runner");
		queueMicrotask(() =>
			child.emit("message", {
				channel: "conduit-claude-runner",
				type: "listening",
			}),
		);
		return child;
	});
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	const program = Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const replacementEntered = yield* Deferred.make<void>();
			const releaseIntake = yield* Deferred.make<void>();
			yield* Effect.addFinalizer(() =>
				Deferred.succeed(releaseIntake, undefined),
			);
			yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 1, 1)`;
			yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('retry-run', 's', 'pending', 1)`;
			yield* sql`INSERT INTO provider_command_outbox
			(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'retry-input', 'test-project', 's', 'claude', 'send_turn', 'retry-run', '{"inputId":"retry-input"}', 'running', 1, 1, 1)`;
			const driver: ProcessRunnerDriver = {
				driverKind: "claude",
				connect: (options) =>
					Effect.gen(function* () {
						const child = children.find(
							(candidate) => candidate.pid === options.pid,
						);
						if (!child) throw new Error("Unknown runner");
						let closed = false;
						const connection = {
							get closed() {
								return closed;
							},
							write: () => {},
							destroy: () => {
								closed = true;
								options.onClose(runnerFailure("runner socket", "closed"));
							},
							commandEffect: (_id: string, command: SessionCommand) => {
								if (command.type !== "send-turn")
									return Effect.succeed(undefined);
								if (child === children[0]) {
									options.onIdleExit?.();
									queueMicrotask(() => {
										child.exitCode = 0;
										child.emit("exit", 0, null);
									});
									return Effect.fail(runnerIdleFailure());
								}
								return Effect.gen(function* () {
									options.onCommandAccepted?.(command.sinkId);
									yield* Deferred.succeed(replacementEntered, undefined);
									yield* Deferred.await(releaseIntake);
									yield* options.emit(
										{
											type: "event",
											sinkId: command.sinkId,
											event: {
												eventId: "replacement-acceptance",
												providerId: "claude",
												sessionId: "s",
												runId: "retry-run",
												type: "run.started",
												providerRefs: {},
												rawSource: { kind: "claude.sdk" },
												createdAt: 2,
												data: {
													inputId: "retry-input",
													requestedRunId: "retry-run",
												},
											},
										},
										"s",
									);
									return {
										status: "completed" as const,
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 0,
										providerStateUpdates: [],
									};
								});
							},
						} as unknown as RunnerSocket;
						yield* options.onHello(
							{
								type: "hello",
								protocolVersion: 1,
								buildId: runnerBuildId(),
								stampsRunIds: true,
								runnerId: options.runnerId,
								sessionId: "s",
								pid: child.pid,
								sendCommands: [],
								bindings: [],
							},
							connection,
						);
						return connection;
					}),
				settingsDeferredCode: "test-deferred",
				warmCommand: () => {
					throw new Error("No upgrade expected");
				},
				snapshotCommandSettings: () => ({}),
				loginChange: () => "None",
				recoverCommands: () => Effect.succeed([]),
			};
			const runner = yield* makeProcessSessionRunner(
				{
					projectRootForSession: () => Effect.succeed(root),
					daemonConfigDir: root,
				},
				(output) =>
					output.type === "event"
						? ingestion.ingest(output.event).pipe(
								Effect.as({}),
								Effect.mapError((error) => runnerFailure("test output", error)),
							)
						: Effect.succeed({}),
				driver,
			);
			const input = {
				sessionId: "s",
				workspaceRoot: root,
				extraFolders: [],
				providerState: {},
				configDir: configuredClaudeConfigDir(root),
			};
			yield* runner.executeEffect({ type: "pre-warm", sessionId: "s", input });
			const execution = yield* Effect.forkChild(
				runner.executeEffect({
					type: "send-turn",
					sinkId: "retry-sink",
					aborted: false,
					input: {
						...input,
						inputId: "retry-input",
						runId: "retry-run",
						commandAttempt: 1,
						prompt: "retry",
						history: [],
					},
				}),
			);
			yield* Deferred.await(replacementEntered).pipe(
				Effect.timeout("2 seconds"),
			);
			expect(
				yield* sql`SELECT status FROM provider_runs WHERE id = 'retry-run'`,
			).toEqual([{ status: "pending" }]);
			yield* Deferred.succeed(releaseIntake, undefined);
			yield* Fiber.join(execution);
			expect(
				yield* sql`SELECT status FROM provider_runs WHERE id = 'retry-run'`,
			).toEqual([{ status: "running" }]);
			expect(
				yield* sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.interrupted')`,
			).toEqual([]);
			expect(spawned).toBe(2);
		}),
	).pipe(
		Effect.provide(
			Layer.merge(
				persistence,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
			),
		),
	);
	await Effect.runPromise(program);
});

const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

// A confirmed exit must settle its exact durable commands even without a sink.
// Joined commands resolve to their accepted owner; a replacement's unadmitted
// reservation must survive. Before intake, the exact placed input (including a
// continuation's cut-off turn) must fail even if exit wins the failRunnerTurn
// race; leaving it pending loses the inbox's error pause. No OS signals are sent.
for (const [
	joined,
	pendingCompletion,
	unaccepted,
	continuation,
	acknowledged,
] of [
	[false, false, false, false, false],
	[true, false, false, false, false],
	[false, true, false, false, false],
	[true, true, false, false, false],
	[false, false, true, false, false],
	[false, false, true, true, false],
	[false, false, false, false, true],
] as const) {
	it(`${pendingCompletion ? "preserves an in-flight completion for" : "settles only"} the exited runner's ${unaccepted ? (continuation ? "pre-intake continuation" : "pre-intake input") : joined ? "joined" : acknowledged ? "acknowledged" : "own"} run without a binding`, async () => {
		const root = mkdtempSync(join(tmpdir(), "run-exit-"));
		roots.push(root);
		const child = new TestChild();
		transport.alive.mockImplementation(() => child.exitCode === null);
		transport.spawn.mockImplementation(() => {
			queueMicrotask(() =>
				child.emit("message", {
					channel: "conduit-claude-runner",
					type: "listening",
				}),
			);
			return child;
		});
		let completeNative: (() => Effect.Effect<void>) | undefined;
		const driver: ProcessRunnerDriver = {
			driverKind: "claude",
			connect: (options) =>
				Effect.gen(function* () {
					completeNative = () =>
						options
							.emit(
								{
									type: "event",
									sinkId: "old-sink",
									event: {
										eventId: "native-completion",
										type: "turn.completed",
										providerId: "claude",
										sessionId: "s",
										runId: "old-run",
										providerRefs: {},
										rawSource: { kind: "claude.sdk" },
										createdAt: 10,
										data: { messageId: "", userMessageId: "old-command" },
									},
								},
								"s",
							)
							.pipe(Effect.ignore);
					let closed = false;
					const connection = {
						get closed() {
							return closed;
						},
						write: () => {},
						destroy() {
							closed = true;
							options.onClose(runnerFailure("runner socket", "closed"));
						},
						commandEffect: () => Effect.succeed(undefined),
					} as unknown as RunnerSocket;
					yield* options.onHello(
						{
							type: "hello",
							protocolVersion: 1,
							buildId: runnerBuildId(),
							stampsRunIds: true,
							runnerId: options.runnerId,
							sessionId: options.sessionId,
							pid: child.pid,
							sendCommands: [{ commandId: "old-command", attempt: 1 }],
							bindings: [],
						},
						connection,
					);
					if (acknowledged)
						options.onCommandsSettled?.([
							{ commandId: "old-command", attempt: 1 },
						]);
					return connection;
				}),
			settingsDeferredCode: "test-deferred",
			warmCommand: () => {
				throw new Error("No upgrade expected");
			},
			snapshotCommandSettings: () => ({}),
			loginChange: () => "None",
			recoverCommands: () => Effect.succeed([]),
		};
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const program = Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const events = yield* EventStoreEffectTag;
				const completionEntered = yield* Deferred.make<void>();
				const releaseCompletion = yield* Deferred.make<void>();
				const failureCleanup = yield* Deferred.make<void>();
				const syntheticTerminalCommitted = yield* Deferred.make<void>();
				yield* Effect.addFinalizer(() =>
					Deferred.succeed(releaseCompletion, undefined),
				);
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
				VALUES ('s', 'test-project', 'claude', 1, 1)`;
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at)
				VALUES ('old-run', 's', ${unaccepted ? "pending" : "running"}, 1), ('future-run', 's', 'pending', 2)`;
				const reservation = joined ? "joined-reservation" : "old-run";
				const userMessageId = continuation ? "cut-off-input" : "old-command";
				if (unaccepted) {
					yield* sql`INSERT INTO messages (id, session_id, role, text, input_id, created_at, updated_at)
						VALUES (${userMessageId}, 's', 'user', 'placed before intake', ${userMessageId}, 1, 1)`;
					yield* sql`INSERT INTO turns (id, session_id, user_message_id, run_id, state, requested_at)
						VALUES (${userMessageId}, 's', ${userMessageId}, 'old-run', 'pending', 1)`;
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("input.admitted", "s", {
							sessionId: "s",
							inputId: "queued-b",
							delivery: "queue",
							request: { text: "send after recovery" },
						}),
					]);
				}
				if (joined)
					yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at)
				VALUES (${reservation}, 's', 'pending', 1)`;
				if (joined) {
					for (const inputId of ["sibling-command", "old-command"]) {
						const base = {
							providerId: "claude",
							sessionId: "s",
							providerRefs: {},
							rawSource: { kind: "claude.sdk" },
							createdAt: 2,
						};
						yield* ingestion.ingest({
							...base,
							eventId: `placed-${inputId}`,
							type: "message.created",
							runId: inputId === "old-command" ? reservation : "old-run",
							data: {
								sessionId: "s",
								messageId: inputId,
								inputId,
								role: "user",
							},
						});
						yield* ingestion.ingest({
							...base,
							eventId: `accepted-${inputId}`,
							type: "run.started",
							runId: "old-run",
							data: {
								inputId,
								requestedRunId:
									inputId === "old-command" ? reservation : "old-run",
							},
						});
					}
					expect(
						yield* sql`SELECT state, run_id FROM turns ORDER BY id`,
					).toEqual([
						{ state: "running", run_id: "old-run" },
						{ state: "running", run_id: "old-run" },
					]);
				}
				if (!unaccepted && !joined)
					yield* events.appendBatch([
						canonicalEvent(
							"run.started",
							"s",
							{ inputId: "old-command", requestedRunId: reservation },
							{ metadata: { runId: "old-run" } },
						),
					]);
				yield* sql`INSERT INTO provider_command_outbox
				(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'old-command', 'test-project', 's', 'claude', 'send_turn',
					${reservation}, ${JSON.stringify({ inputId: "old-command", ...(continuation ? { continuation: { cutOffMessageId: userMessageId } } : {}) })}, 'running', 1, 1, 1),
				(2, 'future-command', 'test-project', 's', 'claude', 'send_turn',
					'future-run', '{"inputId":"future-command"}', 'pending', 0, 2, 2)`;
				const runner = yield* makeProcessSessionRunner(
					{
						projectRootForSession: () => Effect.succeed(root),
						daemonConfigDir: root,
					},
					(output) =>
						Effect.gen(function* () {
							if (output.type === "event") {
								if (
									pendingCompletion &&
									output.event.type === "turn.completed"
								) {
									yield* Deferred.succeed(completionEntered, undefined);
									yield* Deferred.await(releaseCompletion);
								}
								yield* ingestion.ingest(output.event);
							} else if (
								output.type === "background-task" &&
								output.transition.kind === "session-ended"
							)
								yield* Deferred.succeed(failureCleanup, undefined);
							return {};
						}).pipe(
							Effect.mapError((error) => runnerFailure("test output", error)),
						),
					driver,
				).pipe(
					Effect.provideService(ProviderRuntimeIngestionTag, {
						...ingestion,
						ingestBatch: (batch, options) =>
							ingestion
								.ingestBatch(batch, options)
								.pipe(
									Effect.tap(() =>
										batch.some((event) => event.type === "turn.error")
											? Deferred.succeed(syntheticTerminalCommitted, undefined)
											: Effect.void,
									),
								),
					}),
				);
				yield* runner.executeEffect({
					type: "pre-warm",
					sessionId: "s",
					input: {
						sessionId: "s",
						workspaceRoot: root,
						extraFolders: [],
						providerState: {},
						configDir: configuredClaudeConfigDir(root),
					},
				});
				if (pendingCompletion) {
					if (!completeNative)
						throw new Error("Runner connection was not established");
					yield* Effect.forkChild(completeNative());
					yield* Deferred.await(completionEntered);
				}
				child.exitCode = 0;
				child.emit("exit", 0, null);
				if (pendingCompletion) {
					// A pending native commit owns the output permit. Give exit settlement
					// a chance to contend for it before allowing that commit to finish.
					yield* Effect.raceFirst(
						Deferred.await(syntheticTerminalCommitted),
						Effect.sleep(50),
					);
					yield* Deferred.succeed(releaseCompletion, undefined);
					yield* Deferred.await(failureCleanup);
				}
				yield* Effect.promise(() =>
					vi.waitFor(
						async () => {
							expect(
								await Effect.runPromise(
									sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
								),
							).toEqual([
								{ status: pendingCompletion ? "completed" : "error" },
							]);
						},
						{ timeout: 1000, interval: 10 },
					),
				);
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = 'future-run'`,
				).toEqual([{ status: "pending" }]);
				if (unaccepted) {
					const ended =
						yield* sql`SELECT run.completed_at AS run_end, turn.completed_at AS turn_end
						FROM provider_runs run JOIN turns turn ON turn.id = ${userMessageId}
						WHERE run.id = 'old-run'`;
					// Repeated failure delivery cannot append another run terminal.
					yield* failRunnerTurn(
						(output) =>
							output.type === "event"
								? ingestion.ingest(output.event).pipe(
										Effect.as({}),
										Effect.mapError((error) =>
											runnerFailure("test output", error),
										),
									)
								: Effect.succeed({}),
						"old-sink",
						{
							sessionId: "s",
							runId: "old-run",
							messageId: "",
						},
						runnerFailure("runner exit", "runner stopped"),
						"claude",
					);
					expect(
						yield* sql`SELECT state, run_id FROM turns WHERE id = ${userMessageId}`,
					).toEqual([{ state: "error", run_id: "old-run" }]);
					expect(
						yield* sql`SELECT run.completed_at AS run_end, turn.completed_at AS turn_end
							FROM provider_runs run JOIN turns turn ON turn.id = ${userMessageId}
							WHERE run.id = 'old-run'`,
					).toEqual(ended);
					expect(
						yield* sql`SELECT json_extract(data, '$.userMessageId') AS user_message_id FROM events WHERE type = 'turn.error'`,
					).toEqual([{ user_message_id: null }]);
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
					).toEqual([]);
					expect(
						yield* sql`SELECT started_at FROM provider_runs WHERE id = 'old-run'`,
					).toEqual([{ started_at: null }]);
					const read = yield* ReadQueryEffectTag;
					expect(yield* read.readInboxState("s")).toMatchObject({
						// Busy and paused are independent: the failure after that
						// handoff must keep queued work paused even when it completes.
						paused: true,
					});
					expect(
						yield* sql`SELECT input_id, state FROM pending_inputs WHERE input_id = 'queued-b'`,
					).toEqual([{ input_id: "queued-b", state: "queued" }]);
				}
				expect(
					yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'turn.error'`,
				).toEqual(pendingCompletion ? [] : [{ run_id: "old-run" }]);
				if (joined) {
					child.emit("exit", 0, null);
					expect(
						yield* sql`SELECT id, state, run_id FROM turns WHERE completed_at IS NOT NULL ORDER BY id`,
					).toEqual(
						["old-command", "sibling-command"].map((id) => ({
							id,
							state: pendingCompletion ? "completed" : "error",
							run_id: "old-run",
						})),
					);
					expect(
						yield* sql`SELECT COUNT(*) AS count FROM events
						WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([{ count: 1 }]);
				}
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		);
		await Effect.runPromise(program);
	});
}

effectIt.effect(
	"dispatches an account switch after delivery completes during hello replay",
	() => {
		vi.stubEnv("CONDUIT_TEST_BUILD_ID", "hello-current-build");
		const root = mkdtempSync(join(tmpdir(), "run-hello-delivery-"));
		roots.push(root);
		const child = new TestChild();
		transport.alive.mockImplementation(() => child.exitCode === null);
		transport.spawn.mockImplementation(() => {
			queueMicrotask(() =>
				child.emit("message", {
					channel: "conduit-claude-runner",
					type: "listening",
				}),
			);
			return child;
		});
		const accountA: ClaudeAccount = {
			driver: "claude",
			id: AccountIdSchema.make("account-a"),
			name: "Account A",
			folder: configuredClaudeConfigDir(join(root, "account-a")),
			usageEligible: true,
		};
		const accountB: ClaudeAccount = {
			...accountA,
			id: AccountIdSchema.make("account-b"),
			name: "Account B",
			folder: configuredClaudeConfigDir(join(root, "account-b")),
		};
		const input = {
			sessionId: "s",
			workspaceRoot: root,
			extraFolders: [],
			providerState: {},
			account: accountA,
			configDir: accountA.folder,
			folderSource: "account" as const,
		};
		const result = {
			status: "completed" as const,
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		};
		const dispatch = vi.fn<RunnerSocket["commandEffect"]>((_id, command) =>
			Effect.succeed(command.type === "send-turn" ? result : undefined),
		);
		const restored: string[] = [];
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		return Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const selected = yield* Deferred.make<void>();
				const loginChange = vi.fn<ProcessRunnerDriver["loginChange"]>(() => {
					Deferred.doneUnsafe(selected, Effect.void);
					return "Account";
				});
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
					VALUES ('s', 'test-project', 'claude', 1, 1)`;
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at, started_at, completed_at)
					VALUES ('source-run', 's', 'completed', 1, 1, 2)`;
				yield* sql`INSERT INTO turns (id, session_id, user_message_id, run_id, state, requested_at, completed_at)
					VALUES ('source-turn', 's', 'source-input', 'source-run', 'completed', 1, 2)`;
				yield* sql`INSERT INTO messages (id, session_id, turn_id, input_id, role, text, created_at, updated_at)
					VALUES ('source-input', 's', 'source-turn', 'source-input', 'user', 'source', 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'source-command', 'test-project', 's', ${accountA.id}, 'send_turn', 'source-run', '{"inputId":"source-input"}', 'completed', 1, 1, 2)`;
				const driver: ProcessRunnerDriver = {
					driverKind: "claude",
					withAccountScope: (_accountId, work) => work,
					connect: (options) =>
						Effect.gen(function* () {
							const connection = new RunnerSocket(
								new Socket(),
								() => {},
								options.onClose,
							);
							vi.spyOn(connection, "write").mockImplementation(() => {});
							vi.spyOn(connection, "commandEffect").mockImplementation(
								dispatch,
							);
							const destroy = connection.destroy.bind(connection);
							vi.spyOn(connection, "destroy").mockImplementation((failure) => {
								child.exitCode = 0;
								destroy(failure);
							});
							const helloState = {
								quiescent: false,
								revision: 7,
								snapshot: { input, options: {} },
								sourceDelivery: {
									sessionId: options.sessionId,
									runnerId: options.runnerId,
									commandId: "source-command",
									sinkId: "source-command:1",
									inputId: "source-input",
									runId: "source-run",
									generation: 1,
								},
							};
							yield* options.onHello(
								{
									type: "hello",
									protocolVersion: RUNNER_PROTOCOL_VERSION,
									buildId: runnerBuildId(),
									stampsRunIds: true,
									rebindsAccount: true,
									runnerId: options.runnerId,
									sessionId: options.sessionId,
									pid: child.pid,
									upgradeState: helloState,
									sendCommands: [],
									// The completed turn's native query still owns its sink.
									bindings: [
										{
											sinkId: "source-command:1",
											sessionId: options.sessionId,
											commandId: "source-command",
											released: false,
										},
									],
								},
								connection,
								Effect.gen(function* () {
									yield* options.emit(
										{
											type: "event",
											sinkId: "source-command:1",
											event: {
												eventId: "source-idle",
												type: "session.status",
												providerId: "claude",
												sessionId: options.sessionId,
												runId: "source-run",
												providerRefs: {},
												rawSource: { kind: "claude.sdk" },
												createdAt: 3,
												data: { sessionId: options.sessionId, status: "idle" },
											},
										},
										options.sessionId,
									);
									restored.push("replayed-output");
									if (!options.onUpgradeState)
										throw new Error("Missing upgrade-state observer");
									options.onUpgradeState({ quiescent: true, revision: 8 });
									restored.push("newer-state");
								}),
							);
							restored.push("hello-returned");
							return connection;
						}),
					settingsDeferredCode: "test-deferred",
					warmCommand: () => {
						throw new Error("No upgrade expected");
					},
					snapshotCommandSettings: () => ({}),
					loginChange,
					recoverCommands: () => Effect.succeed([]),
				};
				const runner = yield* makeProcessSessionRunner(
					{
						projectRootForSession: () => Effect.succeed(root),
						daemonConfigDir: root,
					},
					(output) =>
						output.type === "event"
							? ingestion.ingest(output.event).pipe(
									Effect.as({}),
									Effect.mapError((error) =>
										runnerFailure("test output", error),
									),
								)
							: Effect.succeed({}),
					driver,
				);
				// Even a failed assertion must never signal the fake child's PID.
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						child.exitCode = 0;
					}),
				);
				yield* runner.executeEffect({
					type: "pre-warm",
					sessionId: "s",
					input,
				});
				expect(restored).toEqual([
					"replayed-output",
					"newer-state",
					"hello-returned",
				]);
				expect(dispatch).toHaveBeenCalledExactlyOnceWith(
					expect.any(String),
					expect.objectContaining({ type: "pre-warm", input }),
					undefined,
				);
				const target = yield* Effect.forkChild(
					runner.executeEffect({
						type: "send-turn",
						sinkId: "target-sink",
						aborted: false,
						input: {
							...input,
							account: accountB,
							configDir: accountB.folder,
							inputId: "target-input",
							runId: "target-run",
							prompt: "target",
							history: [],
						},
					}),
				);
				yield* Effect.addFinalizer(() => Fiber.interrupt(target));
				yield* Effect.raceFirst(Deferred.await(selected), Fiber.await(target));
				// Selection precedes dispatch; await the owned send and its cleanup.
				const targetExit = yield* Fiber.await(target);
				expect(loginChange).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						account: accountA,
						configDir: accountA.folder,
					}),
					expect.objectContaining({
						account: accountB,
						configDir: accountB.folder,
					}),
				);
				if (dispatch.mock.calls.length !== 2 || targetExit?._tag !== "Success")
					console.log(
						JSON.stringify({
							case: "hello-restoration",
							restored,
							accounts: [accountA.id, accountB.id],
							dispatched: dispatch.mock.calls.map(
								([, command]) => command.type,
							),
							targetExit: targetExit?._tag ?? "Pending",
						}),
					);
				if (targetExit && Exit.isFailure(targetExit))
					return yield* Effect.failCause(targetExit.cause);
				expect(dispatch).toHaveBeenCalledTimes(2);
				expect(dispatch).toHaveBeenLastCalledWith(
					"target-input",
					expect.objectContaining({
						type: "send-turn",
						input: expect.objectContaining({
							account: accountB,
							configDir: accountB.folder,
						}),
					}),
					undefined,
				);
				expect(target.pollUnsafe()).toEqual(Exit.succeed(result));
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		);
	},
);
