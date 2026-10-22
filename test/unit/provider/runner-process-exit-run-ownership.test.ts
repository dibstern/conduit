import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";
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
	type RunnerSocket,
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
				sameAccountLogin: () => true,
				recoverCommands: () => Effect.succeed([]),
			};
			const runner = yield* makeProcessSessionRunner(
				{ workspaceRoot: root, daemonConfigDir: root },
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
			sameAccountLogin: () => true,
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
					{ workspaceRoot: root, daemonConfigDir: root },
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
