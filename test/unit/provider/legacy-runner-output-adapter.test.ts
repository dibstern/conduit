import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it, vi } from "vitest";
import type { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { requeueFailedSteers } from "../../../src/lib/persistence/effect/input-requeue-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { inboxRunStatusQuery } from "../../../src/lib/persistence/inbox-run-status-query.js";
import { recoverClaudeRunnerCommands } from "../../../src/lib/provider/claude/claude-runner-recovery.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	makeProcessSessionRunner,
	type ProcessRunnerDriver,
} from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	RunnerSocket,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { recoverRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";
import {
	prepareRunnerDirectory,
	registerRunner,
} from "../../../src/lib/provider/runner/runner-registry.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
} from "../../../src/lib/provider/runner/session-runner.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";

const transport = vi.hoisted(() => ({
	spawn: vi.fn(),
	discover: vi.fn<
		() => import("../../../src/lib/provider/runner/runner-registry.js").RunnerRegistration[]
	>(() => []),
}));
vi.mock(
	"../../../src/lib/provider/runner/runner-registry.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/provider/runner/runner-registry.js")
		>()),
		discoverRunners: transport.discover,
	}),
);
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: transport.spawn,
}));
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	transport.discover.mockReturnValue([]);
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

// Native output, fallback results, duplicates and stale attempts all use the
// durable projector without manufacturing an intake fact.
for (const provider of ["claude", "cursor"] as const)
	for (const status of [
		"completed",
		"joined",
		"error",
		"interrupted",
		"cancelled",
		"steer-declined",
	] as const)
		it(`adapts a legacy ${provider} sink and its ${status} result without inventing intake`, async () => {
			await withLegacyStore(
				Effect.gen(function* () {
					const f = yield* legacyFixture({
						provider,
						inputs: [
							{
								id: "input",
								fallback: provider === "cursor" && status === "joined",
							},
						],
					});
					yield* f.event("input", "message.created", {
						messageId: "reply",
						role: "assistant",
					});
					yield* f.event("input", "text.delta", {
						messageId: "reply",
						partId: "text",
						text: "Owned reply",
					});
					expect(
						yield* f.sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'text.delta' AND json_extract(data, '$.messageId') = 'reply'`,
					).toEqual([{ run_id: "input" }]);
					expect(
						yield* f.sql`SELECT turn_id FROM messages WHERE id = 'reply'`,
					).toEqual([{ turn_id: "input" }]);
					const error =
						status === "error"
							? {
									code: "provider_error",
									message: "Native failure",
									retryable: false,
								}
							: undefined;
					yield* f.result("input", status, error, 0);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					yield* f.result("input", status, error);
					yield* f.result("input", status, error);
					if (status === "joined") {
						expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
							{ status: "pending" },
						]);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type = 'turn.completed'`,
						).toEqual([]);
						yield* f.event("input", "turn.completed", { messageId: "reply" });
					}
					const terminal =
						status === "joined"
							? "completed"
							: status === "cancelled" || status === "steer-declined"
								? "interrupted"
								: status;
					expect(
						yield* f.sql`SELECT state, run_id, started_at FROM turns`,
					).toEqual([{ state: terminal, run_id: "input", started_at: null }]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: terminal },
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([
						{ status: terminal === "completed" ? "completed" : "failed" },
					]);
					expect(yield* f.sql`SELECT status FROM command_receipts`).toEqual([
						{
							status:
								terminal === "completed"
									? "side_effect_completed"
									: "side_effect_failed",
						},
					]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([{ type: `turn.${terminal}` }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type = 'run.started'`,
					).toEqual([]);
				}),
			);
		});

// The legacy transport is real; only the old process is replaced. Assertions read
// the same projection, command and inbox tables as the daemon.
const legacyFixture = (options: {
	provider: "claude" | "cursor";
	inputs: readonly {
		id: string;
		inputId?: string;
		bindToInput?: boolean;
		placed?: boolean;
		fallback?: boolean;
	}[];
	resume?: "completed" | "error" | "no-retry";
	recoverFailure?: boolean;
}) =>
	Effect.gen(function* () {
		const root = mkdtempSync(join(tmpdir(), "legacy-review-"));
		roots.push(root);
		transport.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				pid: 99_999_999,
				connected: false,
				exitCode: null,
				signalCode: null,
				unref() {},
				disconnect() {},
			});
			queueMicrotask(() =>
				child.emit("message", {
					channel: `conduit-${options.provider}-runner`,
					type: "listening",
				}),
			);
			return child;
		});
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const persist = yield* ClaudeEventPersistEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('s', 'test-project', ${options.provider}, 1, 1)`;
		yield* commit([
			canonicalEvent(
				"session.created",
				"s",
				{ sessionId: "s", title: "Legacy", provider: options.provider },
				{ provider: options.provider },
			),
		]);
		const input = {
			sessionId: "s",
			workspaceRoot: root,
			extraFolders: [],
			providerState: {},
			configDir: configuredClaudeConfigDir(root),
			folderSource: "account" as const,
			prompt: "Prompt",
			history: [],
		};
		const inputId = (id: string) =>
			options.inputs.find((item) => item.id === id)?.inputId ?? id;
		const sink = (id: string) => {
			const item = options.inputs.find((item) => item.id === id);
			return `${item?.bindToInput ? inputId(id) : id}:1${item?.fallback ? ":native-resume-fallback" : ""}`;
		};
		for (const item of options.inputs) {
			yield* commit([
				canonicalEvent(
					"run.requested",
					"s",
					{ runId: item.id, inputId: inputId(item.id) },
					{ provider: options.provider },
				),
			]);
			if (item.placed !== false)
				yield* persist.persistUserMessage("s", "Prompt", {
					messageId: inputId(item.id),
					inputId: inputId(item.id),
					runId: item.id,
					provider: options.provider,
				});
			yield* sql`INSERT INTO provider_command_outbox (command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at) VALUES (${item.id}, 'test-project', 's', ${options.provider}, 'send_turn', ${item.id}, ${JSON.stringify({ ...input, inputId: inputId(item.id), nativeResumeFallback: item.fallback })}, 'running', 1, 1, 1)`;
			yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, command_type, status, created_at, updated_at) VALUES (${item.id}, 's', 'test-project', 'send_turn', 'side_effect_requested', 1, 1)`;
		}
		if (options.resume && options.resume !== "no-retry") {
			const state = yield* ProviderStateEffectTag;
			yield* state.saveUpdates("s", [
				{
					key: "nativeThread:claude",
					value: JSON.stringify({
						resumeSessionId: "old-native",
						configDir: root,
						firstSequence: 0,
						deliveredThrough: 0,
					}),
				},
			]);
			yield* commit([
				canonicalEvent("session.provider_changed", "s", {
					sessionId: "s",
					oldProvider: "other",
					newProvider: "claude",
				}),
			]);
		}
		const resumeCalls: { sink: string; fallback: boolean }[] = [];
		let fallbackDispatchState: readonly Record<string, unknown>[] | undefined;
		let connection: RunnerSocket | undefined;
		let output:
			| ((
					output: SessionOutput,
			  ) => Effect.Effect<SessionOutputReply, SessionFailure>)
			| undefined;
		const results = new Map<string, TurnResult>();
		const driver: ProcessRunnerDriver = {
			driverKind: options.provider,
			coldUpgrade: true,
			connect: (connect) =>
				Effect.gen(function* () {
					const socket = new Socket();
					connection = new RunnerSocket(
						socket,
						() => {},
						() => {},
					);
					vi.spyOn(connection, "write").mockImplementation((frame) => {
						if (frame.type !== "command") return;
						if (options.resume && frame.command.type === "send-turn") {
							const command = frame.command;
							const fallback = command.input.nativeResumeFallback === true;
							resumeCalls.push({ sink: command.sinkId, fallback });
							const result: TurnResult = {
								status:
									fallback && options.resume === "completed"
										? "completed"
										: "error",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 1,
								providerStateUpdates: [],
								...(!fallback || options.resume === "error"
									? {
											nativeResumeRejected: true,
											error: {
												code: fallback ? "fallback_error" : "provider_error",
												message: fallback
													? "Fallback failed before intake"
													: "No conversation found with session ID: old-native",
												retryable: false,
											},
										}
									: {}),
							};
							queueMicrotask(() => {
								void Effect.runPromise(
									Effect.gen(function* () {
										if (fallback) {
											fallbackDispatchState =
												yield* sql`SELECT command.status AS command_status, run.status AS run_status, json_extract(command.payload_json, '$.nativeResumeFallback') AS fallback FROM provider_command_outbox command JOIN provider_runs run ON run.id = command.run_id`;
											if (options.resume === "completed") {
												for (const event of [
													{
														type: "message.created" as const,
														data: {
															messageId: "fallback-reply",
															role: "assistant",
														},
													},
													{
														type: "text.delta" as const,
														data: {
															messageId: "fallback-reply",
															partId: "text",
															text: "Fresh reply",
														},
													},
												])
													yield* connect.emit(
														{
															type: "event",
															sinkId: command.sinkId,
															event: {
																eventId: `fallback-${event.type}`,
																providerId: "claude",
																sessionId: "s",
																...event,
																providerRefs: {},
																rawSource: { kind: "old.sdk" },
																createdAt: Date.now(),
															},
														},
														"s",
													);
											}
										}
										socket.emit(
											"data",
											Buffer.from(
												`${JSON.stringify({ type: "command-reply", commandId: frame.commandId, result })}\n`,
											),
										);
									}),
								);
							});
							return;
						}
						const result =
							frame.command.type === "send-turn"
								? results.get(frame.command.input.inputId)
								: undefined;
						const failure =
							options.recoverFailure && frame.command.type === "send-turn"
								? runnerFailure("replay", "Cached legacy failure")
								: undefined;
						queueMicrotask(() =>
							socket.emit(
								"data",
								Buffer.from(
									`${JSON.stringify({ type: "command-reply", commandId: frame.commandId, result, failure })}\n`,
								),
							),
						);
					});
					output = (received) => connect.emit(received, "s");
					yield* connect.onHello(
						{
							type: "hello",
							protocolVersion: 5,
							buildId: "main",
							runnerId: connect.runnerId,
							sessionId: "s",
							...(connect.pid !== undefined ? { pid: connect.pid } : {}),
							stopsTasks: true,
							sendCommands: options.inputs.map((item) => ({
								commandId: item.id,
								attempt: 1,
							})),
							bindings: options.inputs.map((item) => ({
								commandId: item.id,
								sinkId: sink(item.id),
								sessionId: "s",
							})),
							upgradeState: { quiescent: false, revision: 1 },
						},
						connection,
					);
					return connection;
				}),
			settingsDeferredCode: "settings-deferred",
			warmCommand: () => {
				throw new Error("No legacy warm swap");
			},
			snapshotCommandSettings: () => ({}),
			sameAccountLogin: () => true,
			recoverCommands: (
				store,
				sessionId,
				connected,
				failTurn,
				closing,
				_native,
				resolveSinkId,
			) =>
				options.resume
					? recoverClaudeRunnerCommands(
							store,
							sessionId,
							connected,
							failTurn,
							closing,
							{ workspaceRoot: root, daemonConfigDir: root },
							_native,
							resolveSinkId,
						)
					: recoverRunnerCommands(store, sessionId, options.provider, {
							legacyResult: connected.legacyResult,
							driverForAccount: (id) => id,
							decodeInput: (row) => ({
								...input,
								inputId: row.command_id,
								nativeResumeFallback: options.inputs.some(
									(i) => i.id === row.command_id && i.fallback,
								),
							}),
							replay: (row, turn) =>
								connected.commandEffect(
									row.command_id,
									{
										type: "send-turn",
										sinkId: sink(row.command_id),
										aborted: false,
										input: turn,
									},
									row.attempt_count,
								),
							resolveSinkId,
							closing,
							failTurn,
						}),
		};
		const runner = yield* makeProcessSessionRunner(
			{ workspaceRoot: root, daemonConfigDir: root },
			(received) => {
				if (received.type === "event")
					return ingestion.ingestBatch([received.event]).pipe(
						Effect.as({}),
						Effect.mapError((error) => runnerFailure("ingest", error)),
					);
				if (received.type === "place-user-message")
					return persist
						.persistUserMessage(received.input.sessionId, received.input.text, {
							messageId: received.input.inputId,
							inputId: received.input.inputId,
							...(received.input.runId ? { runId: received.input.runId } : {}),
							provider: options.provider,
						})
						.pipe(
							Effect.as({}),
							Effect.mapError((error) => runnerFailure("place", error)),
						);
				return Effect.succeed({});
			},
			driver,
		);
		if (options.recoverFailure || options.resume) {
			const directory = prepareRunnerDirectory(root, root);
			const registration = {
				runnerId: "abcdef123456",
				sessionId: "s",
				socketPath: join(directory, "abcdef123456"),
				buildId: "main",
				pid: 99_999_999,
				driverKind: options.provider,
			};
			registerRunner(registration);
			transport.discover.mockReturnValue([registration]);
			yield* runner.recoverEffect;
		} else
			yield* runner.executeEffect({ type: "pre-warm", sessionId: "s", input });
		if (!connection || !output) throw new Error("No legacy connection");
		const sendOutput = output;
		const connected = connection;
		let sequence = 0;
		const waits = new Map<
			string,
			Effect.Success<ReturnType<typeof recoverRunnerCommands>>[number]["wait"]
		>();
		return {
			sql,
			resumeCalls,
			fallbackDispatchState: () => fallbackDispatchState,
			runner,
			commit,
			persist,
			event: (
				id: string,
				type: Extract<SessionOutput, { type: "event" }>["event"]["type"],
				data: Record<string, unknown>,
			) =>
				sendOutput({
					type: "event",
					sinkId: sink(id),
					event: {
						eventId: `old-${++sequence}`,
						providerId: options.provider,
						sessionId: "s",
						type,
						data,
						providerRefs: {},
						rawSource: { kind: "old.sdk" },
						createdAt: Date.now(),
					} as Extract<SessionOutput, { type: "event" }>["event"],
				}),
			place: (id: string) =>
				sendOutput({
					type: "place-user-message",
					sinkId: sink(id),
					input: { sessionId: "s", inputId: id, text: "Late placement" },
				}),
			result: (
				id: string,
				status: TurnResult["status"],
				error?: TurnResult["error"],
				attempt = 1,
			) => {
				results.set(id, {
					status,
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 1,
					providerStateUpdates: [],
					...(error ? { error } : {}),
				});
				return Effect.gen(function* () {
					const send = connected.commandEffect(
						id,
						{
							type: "send-turn",
							sinkId: sink(id),
							aborted: false,
							input: { ...input, inputId: inputId(id) },
						},
						attempt,
					);
					if (attempt !== 1) return yield* send;
					let wait = waits.get(id);
					if (!wait) {
						const commands = yield* recoverRunnerCommands(
							sql,
							"s",
							options.provider,
							{
								driverForAccount: (value) => value,
								decodeInput: (row) => ({
									...input,
									inputId: inputId(row.command_id),
								}),
								replay: () => send,
								legacyResult: connected.legacyResult,
								resolveSinkId: (commandId) => sink(commandId),
								closing: () => false,
								failTurn: () => Effect.void,
							},
						);
						wait = commands.find(
							(command) => command.input.inputId === inputId(id),
						)?.wait;
						if (wait) waits.set(id, wait);
					}
					if (wait) yield* wait;
					return undefined;
				});
			},
		};
	});

const withLegacyStore = <A, E>(
	program: Effect.Effect<
		A,
		E,
		Effect.Services<ReturnType<typeof legacyFixture>> | PersistenceProjectTag
	>,
) => {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return Effect.runPromise(
		Effect.scoped(program).pipe(
			Effect.provide(
				Layer.merge(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		),
	);
};

it("attaches an old Claude reply when its retained steer is placed after hello", async () => {
	await withLegacyStore(
		Effect.gen(function* () {
			const f = yield* legacyFixture({
				provider: "claude",
				inputs: [{ id: "B", placed: false }],
			});
			yield* f.place("B");
			yield* f.event("B", "message.created", {
				messageId: "reply-B",
				role: "assistant",
			});
			yield* f.result("B", "completed");
			yield* f.result("B", "completed");
			expect(
				yield* f.sql`SELECT type FROM events WHERE type = 'turn.completed'`,
			).toHaveLength(1);
			expect(
				yield* f.sql`SELECT turn_id FROM messages WHERE id = 'reply-B'`,
			).toEqual([{ turn_id: "B" }]);
			expect(yield* f.sql`SELECT state, run_id, started_at FROM turns`).toEqual(
				[{ state: "completed", run_id: "B", started_at: null }],
			);
		}),
	);
});

for (const native of [true, false])
	it(`preserves legacy Cursor's handled retry policy on ${native ? "native" : "fallback"} errors`, async () => {
		await withLegacyStore(
			Effect.gen(function* () {
				const f = yield* legacyFixture({
					provider: "cursor",
					inputs: [{ id: "A" }],
				});
				if (native)
					yield* f.event("A", "turn.error", {
						messageId: "",
						error: "Limit",
						code: "rate_limit",
						retryable: true,
					});
				yield* f.result("A", "error", {
					message: "Limit",
					code: "rate_limit",
					retryable: true,
					retryHandled: true,
				});
				expect(
					yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "failed", attempt_count: 1 }]);
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
				]);
				expect(yield* f.sql`SELECT status FROM command_receipts`).toEqual([
					{ status: "side_effect_failed" },
				]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type = 'turn.error'`,
				).toHaveLength(1);
			}),
		);
	});

for (const code of [undefined, "model_differs"])
	it(`returns a declined legacy steer without pausing (${code ?? "no error"})`, async () => {
		await withLegacyStore(
			Effect.gen(function* () {
				const f = yield* legacyFixture({
					provider: "cursor",
					inputs: [{ id: "A" }, { id: "B", placed: false }],
				});
				yield* f.commit([
					canonicalEvent(
						"run.started",
						"s",
						{ requestedRunId: "A", inputId: "A" },
						{ provider: "cursor", metadata: { runId: "A" } },
					),
				]);
				yield* f.commit([
					canonicalEvent("input.admitted", "s", {
						sessionId: "s",
						inputId: "B",
						delivery: "steer",
						request: { text: "Bravo" },
					}),
					canonicalEvent("input.sent", "s", {
						sessionId: "s",
						inputId: "B",
						steer: true,
					}),
				]);
				yield* f.result(
					"B",
					"steer-declined",
					code
						? { code, message: "Different settings", retryable: false }
						: undefined,
				);
				yield* requeueFailedSteers(f.sql, f.persist);
				expect(
					yield* f.sql`SELECT error_code FROM provider_command_outbox WHERE command_id = 'B'`,
				).toEqual([{ error_code: "steer-declined" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'input.requeued'`,
				).toEqual([{ reason: "declined" }]);
				expect(
					yield* f.sql`SELECT state FROM pending_inputs WHERE input_id = 'B'`,
				).toEqual([{ state: "queued" }]);
				expect(
					(yield* inboxRunStatusQuery(f.sql, "s")).map((row) => ({
						status: row["status"],
						stopped: Boolean(row["stopped"]),
					})),
				).toEqual([{ status: "running", stopped: false }]);
			}),
		);
	});

it("settles a cached replay failure on a live fallback sink after adoption", async () => {
	await withLegacyStore(
		Effect.gen(function* () {
			const f = yield* legacyFixture({
				provider: "cursor",
				inputs: [{ id: "B", fallback: true }],
				recoverFailure: true,
			});
			for (let tick = 0; tick < 50; tick++) {
				const [row] = yield* f.sql`SELECT status FROM provider_command_outbox`;
				if (row?.["status"] === "failed") break;
				yield* Effect.sleep("10 millis");
			}
			expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
				{ status: "error" },
			]);
			expect(yield* f.sql`SELECT state FROM turns`).toEqual([
				{ state: "error" },
			]);
			expect(yield* f.sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: "failed" },
			]);
			expect(yield* f.sql`SELECT status FROM command_receipts`).toEqual([
				{ status: "side_effect_failed" },
			]);
			expect(yield* inboxRunStatusQuery(f.sql, "s")).toEqual([
				{ status: "error", stopped: 1 },
			]);
		}),
	);
});

it("never completes the effective target from a legacy joined result", async () => {
	await withLegacyStore(
		Effect.gen(function* () {
			const f = yield* legacyFixture({
				provider: "cursor",
				inputs: [{ id: "A" }, { id: "B" }],
			});
			yield* f.commit([
				canonicalEvent(
					"run.started",
					"s",
					{ requestedRunId: "A", inputId: "A" },
					{ provider: "cursor", metadata: { runId: "A" } },
				),
				canonicalEvent(
					"run.started",
					"s",
					{ requestedRunId: "B", inputId: "B" },
					{ provider: "cursor", metadata: { runId: "A" } },
				),
			]);
			yield* f.result("B", "joined");
			expect(
				yield* f.sql`SELECT id, status, joined_into FROM provider_runs ORDER BY id`,
			).toEqual([
				{ id: "A", status: "running", joined_into: null },
				{ id: "B", status: "joined", joined_into: "A" },
			]);
			expect(
				yield* f.sql`SELECT type FROM events WHERE type = 'turn.completed'`,
			).toEqual([]);
			yield* f.event("A", "turn.completed", { messageId: "" });
			expect(
				yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY command_id`,
			).toEqual([
				{ command_id: "A", status: "completed" },
				{ command_id: "B", status: "completed" },
			]);
			expect(
				yield* f.sql`SELECT type FROM events WHERE type = 'turn.completed'`,
			).toHaveLength(1);
		}),
	);
});

for (const terminal of ["completed", "error", "interrupted"] as const)
	it(`keeps a legacy Cursor joined reservation open until the retained reply ${terminal}`, async () => {
		await withLegacyStore(
			Effect.gen(function* () {
				const f = yield* legacyFixture({
					provider: "cursor",
					inputs: [{ id: "A" }, { id: "B" }],
				});
				yield* f.commit([
					canonicalEvent(
						"run.started",
						"s",
						{ requestedRunId: "A", inputId: "A" },
						{ provider: "cursor", metadata: { runId: "A" } },
					),
				]);
				yield* f.result("B", "joined");
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'B'`,
				).toEqual([{ status: "pending" }]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'B'`,
				).toEqual([{ status: "running" }]);
				yield* f.event("A", "text.delta", {
					messageId: "reply-A",
					partId: "text",
					text: "Still streaming",
				});
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'B'`,
				).toEqual([{ status: "pending" }]);
				yield* f.event("A", `turn.${terminal}`, {
					messageId: "",
					error: "Native end",
				});
				yield* f.result("B", "joined");
				expect(
					yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "A", status: terminal },
					{ id: "B", status: terminal },
				]);
				const commandStatus = terminal === "completed" ? "completed" : "failed";
				expect(
					yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY command_id`,
				).toEqual([
					{ command_id: "A", status: commandStatus },
					{ command_id: "B", status: commandStatus },
				]);
				expect(
					yield* f.sql`SELECT status FROM command_receipts ORDER BY command_id`,
				).toEqual([
					{
						status:
							terminal === "completed"
								? "side_effect_completed"
								: "side_effect_failed",
					},
					{
						status:
							terminal === "completed"
								? "side_effect_completed"
								: "side_effect_failed",
					},
				]);
				expect(
					yield* f.sql`SELECT state, run_id, started_at FROM turns WHERE id = 'B'`,
				).toEqual([{ state: terminal, run_id: "B", started_at: null }]);
				expect(
					yield* f.sql`SELECT json_extract(metadata, '$.runId') AS run, COUNT(*) AS ends FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted') GROUP BY run ORDER BY run`,
				).toEqual([
					{ run: "A", ends: 1 },
					{ run: "B", ends: 1 },
				]);
			}),
		);
	});

it("settles a legacy Claude joined reservation once when its retained reply already ended", async () => {
	await withLegacyStore(
		Effect.gen(function* () {
			const f = yield* legacyFixture({
				provider: "claude",
				inputs: [{ id: "A" }, { id: "B" }],
			});
			yield* f.event("B", "turn.completed", { messageId: "" });
			yield* f.result("A", "joined");
			yield* f.result("A", "joined");
			expect(
				yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
			).toEqual([
				{ id: "A", status: "completed" },
				{ id: "B", status: "completed" },
			]);
			expect(
				yield* f.sql`SELECT json_extract(metadata, '$.runId') AS run, COUNT(*) AS ends FROM events WHERE type = 'turn.completed' GROUP BY run ORDER BY run`,
			).toEqual([
				{ run: "A", ends: 1 },
				{ run: "B", ends: 1 },
			]);
		}),
	);
});

it("does not guess among retained roots and settles the unresolved join at retirement", async () => {
	await withLegacyStore(
		Effect.gen(function* () {
			const f = yield* legacyFixture({
				provider: "cursor",
				inputs: [{ id: "A" }, { id: "B" }, { id: "C" }],
			});
			yield* f.result("B", "joined");
			yield* f.event("A", "turn.completed", { messageId: "" });
			expect(
				yield* f.sql`SELECT status FROM provider_runs WHERE id = 'B'`,
			).toEqual([{ status: "pending" }]);
			yield* f.runner.inputAdmission.afterStop("s");
			for (let tick = 0; tick < 50; tick++) {
				const [row] =
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'B'`;
				if (row?.["status"] === "error") break;
				yield* Effect.sleep("10 millis");
			}
			expect(
				yield* f.sql`SELECT status FROM provider_runs WHERE id = 'B'`,
			).toEqual([{ status: "error" }]);
			expect(
				yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'B'`,
			).toEqual([{ status: "failed" }]);
			expect(
				yield* f.sql`SELECT status FROM command_receipts WHERE command_id = 'B'`,
			).toEqual([{ status: "side_effect_failed" }]);
			expect(
				yield* f.sql`SELECT status FROM provider_runs WHERE id = 'A'`,
			).toEqual([{ status: "completed" }]);
		}),
	);
});

// A recoverable rejection is preparation, not an ended attempt. Exercise the
// actual recovery wrapper and socket, including distinct command/input aliases.
for (const bindToInput of [false, true])
	for (const outcome of ["completed", "error", "no-retry"] as const)
		it(`settles only the final legacy Claude preparation outcome (${outcome}, ${bindToInput ? "input" : "command"} sink)`, async () => {
			await withLegacyStore(
				Effect.gen(function* () {
					const f = yield* legacyFixture({
						provider: "claude",
						inputs: [{ id: "command", inputId: "user", bindToInput }],
						resume: outcome,
					});
					for (let tick = 0; tick < 100; tick++) {
						const [row] = yield* f.sql`SELECT status FROM command_receipts`;
						if (
							row?.["status"] ===
								(outcome === "completed"
									? "side_effect_completed"
									: "side_effect_failed") &&
							f.resumeCalls.length === (outcome === "no-retry" ? 1 : 2)
						)
							break;
						yield* Effect.sleep("10 millis");
					}
					expect(f.resumeCalls).toEqual([
						{ sink: `${bindToInput ? "user" : "command"}:1`, fallback: false },
						...(outcome === "no-retry"
							? []
							: [{ sink: "command:1:native-resume-fallback", fallback: true }]),
					]);
					if (outcome !== "no-retry")
						expect(f.fallbackDispatchState()).toEqual([
							{ command_status: "running", run_status: "pending", fallback: 1 },
						]);
					const terminal = outcome === "completed" ? "completed" : "error";
					expect(
						yield* f.sql`SELECT status, started_at FROM provider_runs`,
					).toEqual([{ status: terminal, started_at: null }]);
					expect(
						yield* f.sql`SELECT state, run_id, started_at FROM turns`,
					).toEqual([{ state: terminal, run_id: "command", started_at: null }]);
					expect(
						yield* f.sql`SELECT status, attempt_count, error_code FROM provider_command_outbox`,
					).toEqual([
						{
							status: outcome === "completed" ? "completed" : "failed",
							attempt_count: 1,
							error_code:
								outcome === "completed"
									? null
									: outcome === "error"
										? "fallback_error"
										: "provider_error",
						},
					]);
					expect(yield* f.sql`SELECT status FROM command_receipts`).toEqual([
						{
							status:
								outcome === "completed"
									? "side_effect_completed"
									: "side_effect_failed",
						},
					]);
					expect(
						yield* f.sql`SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events WHERE type IN ('turn.completed', 'turn.error')`,
					).toEqual([{ type: `turn.${terminal}`, run_id: "command" }]);
					if (outcome === "completed") {
						expect(
							yield* f.sql`SELECT turn_id FROM messages WHERE id = 'fallback-reply'`,
						).toEqual([{ turn_id: "user" }]);
						expect(
							yield* f.sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE event_id IN ('fallback-message.created', 'fallback-text.delta') ORDER BY sequence`,
						).toEqual([{ run_id: "command" }, { run_id: "command" }]);
					}
				}),
			);
		});
