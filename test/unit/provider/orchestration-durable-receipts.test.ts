import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import {
	effectiveDispatchFingerprint,
	fingerprintHash,
} from "../../../src/lib/provider/orchestration-command-fingerprint.js";
import {
	type DurableCommandStoreOptions,
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	ProviderInstance,
	TurnResult,
} from "../../../src/lib/provider/types.js";
import { createMockEventSink } from "../../helpers/mock-sdk.js";

const COMPLETED: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 1, output: 1 },
	durationMs: 1,
	providerStateUpdates: [],
};

// Receipts can strand if fixtures return an adapter result without provider
// intake/end, skip projection, or omit the committed command's reservation.
function finishTurn(
	input: SendTurnCommand["input"],
	providerId: string,
	result = COMPLETED,
	createdAt = 1000,
) {
	return Effect.gen(function* () {
		const base = {
			providerId,
			sessionId: input.sessionId,
			runId: input.runId,
			providerRefs: {},
			rawSource: { kind: "test.provider-runtime" },
			createdAt,
		};
		yield* input.eventSink.push({
			...base,
			eventId: `${input.runId}:started`,
			type: "run.started",
			data: { inputId: input.inputId, requestedRunId: input.runId },
		});
		yield* input.eventSink.push({
			...base,
			eventId: `${input.runId}:ended`,
			type:
				result.status === "error"
					? "turn.error"
					: providerId === "opencode"
						? "session.status"
						: "turn.completed",
			data:
				result.status === "error"
					? {
							messageId: "",
							error: result.error?.message ?? "Failed",
							code: result.error?.code,
							retryable: result.error?.retryable,
							retryHandled: result.error?.retryHandled,
						}
					: providerId === "opencode"
						? { sessionId: input.sessionId, status: "idle" }
						: { messageId: "", duration: result.durationMs },
		});
		return result;
	}).pipe(Effect.orDie);
}

function makeStubInstance(
	providerId: string,
	createdAt = 1000,
): ProviderInstance & {
	sendTurnEffect: ReturnType<typeof vi.fn>;
} {
	return {
		providerId,
		discoverEffect: vi.fn(() =>
			Effect.succeed({
				models: [],
				supportsTools: false,
				supportsThinking: false,
				supportsPermissions: false,
				supportsQuestions: false,
				supportsAttachments: false,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
		),
		sendTurnEffect: vi.fn((input: SendTurnCommand["input"]) =>
			finishTurn(input, providerId, COMPLETED, createdAt),
		),
		interruptTurnEffect: vi.fn(() => Effect.void),
		resolvePermissionEffect: vi.fn(() => Effect.void),
		resolveQuestionEffect: vi.fn(() => Effect.void),
		shutdownEffect: vi.fn(() => Effect.void),
		endSessionEffect: vi.fn(() => Effect.void),
	};
}

function sendTurnCommand(
	overrides: {
		commandId?: string;
		prompt?: string;
		providerId?: string;
		configDir?: SendTurnCommand["input"]["configDir"];
		abortSignal?: AbortSignal;
	} = {},
): SendTurnCommand {
	return {
		type: "send_turn",
		commandId: overrides.commandId ?? "cmd-durable-1",
		providerId: overrides.providerId ?? "opencode",
		input: {
			sessionId: "session-1",
			inputId: "turn-1",
			prompt: overrides.prompt ?? "hello",
			history: [],
			providerState: {},
			workspaceRoot: "/tmp/project",
			extraFolders: [],
			configDir: configuredClaudeConfigDir("/tmp/g4zp-test-claude"),
			folderSource: "account",
			...(overrides.configDir === undefined
				? {}
				: { configDir: overrides.configDir }),
			eventSink: createMockEventSink(),
			abortSignal: overrides.abortSignal ?? new AbortController().signal,
		},
	};
}

function makeFixtureLayer() {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return Layer.merge(
		persistence,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
	);
}

function makeDurableOptions(fixture: {
	readonly sql: SqlClient.SqlClient;
	readonly now?: () => number;
	readonly generateId?: () => string;
}) {
	return Effect.gen(function* () {
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const commit = yield* makeCommitAndSignal;
		yield* fixture.sql`INSERT OR IGNORE INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session-1', 'test-project', 'opencode', 1000, 1000)`;
		const snapshot = yield* new CommandReadModelRepository(
			fixture.sql,
			"test-project",
		).bootstrap();
		return {
			sql: fixture.sql,
			snapshot,
			projectKey: "test-project",
			now: fixture.now ?? (() => 1000),
			generateId: fixture.generateId ?? (() => "disp-1"),
			ingestion,
			write: commit.write,
		} satisfies DurableCommandStoreOptions;
	});
}

function makeEngine(
	instance: ProviderInstance,
	fixture: Parameters<typeof makeDurableOptions>[0],
) {
	return Effect.map(
		makeDurableOptions(fixture),
		(durableCommands) =>
			new OrchestrationEngine({
				registry: new ProviderRegistry([instance]),
				durableCommands,
			}),
	);
}

function seedReceipt(
	sql: SqlClient.SqlClient,
	command: SendTurnCommand,
	options: {
		status?: "side_effect_requested" | "side_effect_completed";
		version?: number;
	} = {},
) {
	const hash = fingerprintHash(effectiveDispatchFingerprint(command));
	return sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type,
		project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
		VALUES (${command.commandId}, 'session-1', ${options.status ?? "side_effect_requested"}, 1000, 'send_turn',
		'test-project', ${hash}, ${options.version ?? 2}, 1, 1000)`;
}

function receiptRow(sql: SqlClient.SqlClient, commandId: string) {
	return sql<{
		readonly status: string;
		readonly fingerprint_hash: string | null;
		readonly updated_at: number | null;
	}>`SELECT status, fingerprint_hash, updated_at FROM command_receipts WHERE command_id = ${commandId}`.pipe(
		Effect.map((rows) => rows[0]),
	);
}

describe("OrchestrationEngine durable receipts", () => {
	it.effect(
		"releases foreground admission so C drains after the indeterminate run's own end",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockImplementationOnce(() =>
					Effect.succeed({ ...COMPLETED, status: "indeterminate" }),
				);
				const engine = yield* makeEngine(instance, { sql });
				expect((yield* engine.dispatchEffect(sendTurnCommand())).status).toBe(
					"indeterminate",
				);
				const command = sendTurnCommand({ commandId: "command-c" });
				const next = yield* Effect.forkChild(
					engine.dispatchEffect({
						...command,
						input: { ...command.input, inputId: "input-c" },
					}),
				);
				yield* TestClock.adjust("10 millis");
				expect(instance.sendTurnEffect).toHaveBeenCalledOnce();
				const first = instance.sendTurnEffect.mock
					.calls[0]?.[0] as SendTurnCommand["input"];
				yield* finishTurn(first, "opencode");
				yield* engine.drainSideEffects();
				expect(instance.sendTurnEffect).toHaveBeenCalledTimes(2);
				yield* TestClock.adjust("1 second");
				expect((yield* Fiber.join(next)).status).toBe("completed");
				expect(
					yield* sql`SELECT status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([{ status: "completed" }, { status: "completed" }]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
	it.effect(
		"replays an indeterminate reservation after restart without interrupting or resending",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockReturnValue(
					Effect.succeed({ ...COMPLETED, status: "indeterminate" }),
				);
				const command = sendTurnCommand();
				const first = yield* makeEngine(instance, { sql });
				expect((yield* first.dispatchEffect(command)).status).toBe(
					"indeterminate",
				);
				const restarted = yield* makeEngine(instance, { sql });
				expect((yield* restarted.dispatchEffect(command)).status).toBe(
					"indeterminate",
				);
				yield* restarted.drainSideEffects();
				expect(instance.sendTurnEffect).toHaveBeenCalledOnce();
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "running", error_code: "delivery_indeterminate" },
				]);
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs`,
				).toEqual([{ status: "pending", started_at: null }]);
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
	// A drain must not steal the commit-to-claim gap, replace the caller's
	// result/sink/signal, or impose the receipt poll timeout on a long live turn.
	it.effect(
		"concurrent immediate Resumes retry a returned handoff exactly once while its old caller unwinds",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const committed = yield* Deferred.make<void>();
				const allowClaim = yield* Deferred.make<void>();
				const instance = makeStubInstance("opencode", 4000);
				let now = 1000;
				const engine = yield* makeEngine(instance, { sql, now: () => now });
				const command = sendTurnCommand();
				const original = yield* Effect.forkChild(
					engine.dispatchEffect({
						...command,
						onAccepted: Deferred.succeed(committed, undefined).pipe(
							Effect.andThen(Deferred.await(allowClaim)),
						),
					}),
				);
				yield* Deferred.await(committed);
				const [row] = yield* sql<{
					run_id: string;
				}>`SELECT run_id FROM provider_command_outbox`;
				if (!row) throw new Error("No committed handoff");
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"turn.interrupted",
						"session-1",
						{
							messageId: "",
							code: "interrupted",
							reason: "Stopped before delivery",
						},
						{ createdAt: 2000, metadata: { runId: row.run_id } },
					),
				]);
				now = 3000;
				const resumed = yield* Effect.forkChild(engine.dispatchEffect(command));
				const duplicate = yield* Effect.forkChild(
					engine.dispatchEffect(command),
				);
				yield* TestClock.adjust("1 millis");
				yield* Deferred.succeed(allowClaim, undefined);
				yield* TestClock.adjust("1 second");
				expect((yield* Fiber.join(original)).status).toBe("interrupted");
				expect((yield* Fiber.join(resumed)).status).toBe("completed");
				expect((yield* Fiber.join(duplicate)).status).toBe("completed");
				expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs ORDER BY requested_at`,
				).toEqual([
					{ status: "interrupted", started_at: null },
					{ status: "completed", started_at: 4000 },
				]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
	it.effect("keeps a committed live command out of overlapping drains", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const committed = yield* Deferred.make<void>();
			const allowClaim = yield* Deferred.make<void>();
			const started = yield* Deferred.make<SendTurnCommand["input"]>();
			const instance = makeStubInstance("opencode");
			const cancellation = new AbortController();
			const command = sendTurnCommand({ abortSignal: cancellation.signal });
			let signal: AbortSignal | undefined;
			const result: TurnResult = { ...COMPLETED, cost: 7 };
			instance.sendTurnEffect.mockImplementation(
				(input: SendTurnCommand["input"]) =>
					Effect.gen(function* () {
						signal = input.abortSignal;
						yield* input.eventSink.push({
							eventId: "live-intake",
							type: "run.started",
							providerId: "opencode",
							sessionId: input.sessionId,
							runId: input.runId,
							providerRefs: {},
							rawSource: { kind: "test.native" },
							createdAt: 1000,
							data: { inputId: input.inputId, requestedRunId: input.runId },
						});
						yield* Deferred.succeed(started, input);
						return { ...COMPLETED, status: "accepted" as const };
					}),
			);
			const engine = yield* makeEngine(instance, { sql });
			const live = yield* Effect.forkChild(
				engine.dispatchEffect({
					...command,
					onAccepted: Deferred.succeed(committed, undefined).pipe(
						Effect.andThen(Deferred.await(allowClaim)),
					),
				}),
			);
			yield* Deferred.await(committed);
			const drain = yield* Effect.forkChild(engine.drainSideEffects());
			yield* TestClock.adjust("16 minutes");
			expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			yield* Fiber.join(drain);
			yield* Deferred.succeed(allowClaim, undefined);
			const input = yield* Deferred.await(started);
			expect(signal?.aborted).toBe(false);
			yield* TestClock.adjust("16 minutes");
			expect(live.pollUnsafe()).toBeUndefined();
			yield* finishTurn(input, "opencode", result);
			yield* TestClock.adjust("500 millis");
			expect(yield* Fiber.join(live)).toEqual({
				...COMPLETED,
				durationMs: 0,
				tokens: { input: 0, output: 0 },
			});
			yield* engine.drainSideEffects();
			expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
			cancellation.abort();
			expect(signal?.aborted).toBe(true);
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	// Caller-supplied command ids are globally unique keys, not ownership proof.
	it.effect("rejects replay of another project's orphaned command", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const command = sendTurnCommand();
			const hash = fingerprintHash(effectiveDispatchFingerprint(command));
			yield* sql`INSERT INTO command_receipts (
				command_id, session_id, project_key, status, created_at,
				fingerprint_hash, fingerprint_version, updated_at
			) VALUES (${command.commandId}, 'session-b', 'project-b',
				'side_effect_requested', 1000, ${hash}, 2, 1000)`;
			yield* sql`INSERT INTO provider_command_outbox (
				request_sequence, command_id, project_key, session_id, provider_id,
				effect_type, payload_json, status, attempt_count, requested_at, updated_at
			) VALUES (1, ${command.commandId}, 'project-b', 'session-b', 'opencode',
				'send_turn', '{}', 'pending', 0, 1000, 1000)`;
			const before = JSON.stringify({
				receipts: yield* sql`SELECT * FROM command_receipts`,
				outbox: yield* sql`SELECT * FROM provider_command_outbox`,
			});
			const instance = makeStubInstance("opencode");
			const engine = yield* makeEngine(instance, { sql });
			const result = yield* Effect.result(engine.dispatchEffect(command));
			expect(result._tag).toBe("Failure");
			expect(
				JSON.stringify({
					receipts: yield* sql`SELECT * FROM command_receipts`,
					outbox: yield* sql`SELECT * FROM provider_command_outbox`,
				}),
			).toBe(before);
			expect(instance.sendTurnEffect).not.toHaveBeenCalled();
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	for (const providerId of ["claude", "opencode"]) {
		it.effect(
			`commits ${providerId} send_turn without a transcript in the outbox`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const instance = makeStubInstance(providerId);
					const engine = yield* makeEngine(instance, { sql });
					const command = sendTurnCommand({ providerId });
					yield* engine.dispatchEffect({
						...command,
						input: {
							...command.input,
							inputId: "current-user",
							history: [{ role: "assistant", text: "prior transcript" }],
						},
					});

					const [row] = yield* sql<{ payload_json: string }>`
					SELECT payload_json FROM provider_command_outbox
					WHERE command_id = ${command.commandId}`;
					expect(row).toBeDefined();
					const payload: unknown = JSON.parse(row?.payload_json ?? "null");
					expect(payload).not.toHaveProperty("history");
					expect(payload).toMatchObject({
						prompt: "hello",
						inputId: "current-user",
					});
					expect(instance.sendTurnEffect).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(makeFixtureLayer())),
		);
	}

	it.effect("uses injected id and time sources", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const now = vi.fn(() => 4242);
			const generateId = vi.fn(() => "disp-xyz");
			const instance = makeStubInstance("opencode", 4242);
			const engine = yield* makeEngine(instance, { sql, now, generateId });

			const result = yield* engine.dispatchEffect(sendTurnCommand());

			expect(result).toMatchObject({ status: "completed" });
			expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
			expect(now).toHaveBeenCalled();
			expect(generateId).toHaveBeenCalled();
			const row = yield* receiptRow(sql, "cmd-durable-1");
			expect(row?.status).toBe("side_effect_completed");
			expect(row?.fingerprint_hash).toMatch(/^sha256:/);
			expect(row?.updated_at).toBe(4242);
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect("preserves a Claude config dir through durable dispatch", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const instance = makeStubInstance("claude");
			const engine = yield* makeEngine(instance, { sql });

			yield* engine.dispatchEffect(
				sendTurnCommand({
					providerId: "claude",
					configDir: configuredClaudeConfigDir("/instances/work-claude"),
				}),
			);

			expect(instance.sendTurnEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					configDir: configuredClaudeConfigDir("/instances/work-claude"),
				}),
			);
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"routes committed send_turn through the reactor to provider runtime ingestion",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const runtimeEvent = decodeProviderRuntimeEvent({
					eventId: "runtime-text-1",
					type: "text.delta",
					providerId: "opencode",
					sessionId: "session-1",
					turnId: "turn-1",
					providerRefs: {},
					rawSource: { kind: "test.provider-runtime" },
					createdAt: 1000,
					data: { messageId: "message-1", partId: "text-1", text: "streamed" },
				});
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const ingest = vi.fn((event: ProviderRuntimeEvent) =>
					ingestion.ingest(event),
				);
				const command = sendTurnCommand();
				const commandSinkPush = vi.spyOn(command.input.eventSink, "push");
				const instance = makeStubInstance("opencode");
				// Provider streams output through the sink it is handed; the reactor's
				// sink routes to ProviderRuntimeIngestion, not the command's sink.
				instance.sendTurnEffect.mockImplementation((input) =>
					input.eventSink
						.push(runtimeEvent)
						.pipe(Effect.andThen(finishTurn(input, "opencode"))),
				);
				const engine = new OrchestrationEngine({
					registry: new ProviderRegistry([instance]),
					durableCommands: {
						...(yield* makeDurableOptions({ sql })),
						ingestion: {
							ingest,
							ingestBatch: ingestion.ingestBatch,
						},
					},
				});

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(ingest).toHaveBeenCalledWith(runtimeEvent);
				expect(commandSinkPush).not.toHaveBeenCalled();
				expect((yield* receiptRow(sql, "cmd-durable-1"))?.status).toBe(
					"side_effect_completed",
				);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect("id generation failure does not consume command receipt", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const instance = makeStubInstance("opencode");
			const engine = yield* makeEngine(instance, {
				sql,
				generateId: vi.fn(() => {
					throw new Error("id service down");
				}),
			});

			const failed = yield* Effect.result(
				engine.dispatchEffect(sendTurnCommand()),
			);

			expect(failed._tag).toBe("Failure");
			if (failed._tag === "Failure") {
				expect(failed.failure._tag).toBe("CommandIdGenerationFailed");
			}
			expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			expect(yield* receiptRow(sql, "cmd-durable-1")).toBeUndefined();
		}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"replays accepted send_turn after restart without provider call",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;

				const firstInstance = makeStubInstance("opencode");
				const firstEngine = yield* makeEngine(firstInstance, { sql });
				yield* firstEngine.dispatchEffect(sendTurnCommand());
				expect(firstInstance.sendTurnEffect).toHaveBeenCalledTimes(1);

				// Fresh engine over the same DB (simulated restart).
				const secondInstance = makeStubInstance("opencode");
				const secondEngine = yield* makeEngine(secondInstance, { sql });

				const replayed = yield* secondEngine.dispatchEffect(sendTurnCommand());

				expect(replayed).toMatchObject({ status: "completed" });
				expect(secondInstance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"rejects reused command id with different fingerprint (changed dispatch identity)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;

				const firstEngine = yield* makeEngine(makeStubInstance("opencode"), {
					sql,
				});
				yield* firstEngine.dispatchEffect(sendTurnCommand({ prompt: "hello" }));

				// Restart, same command id, different effective dispatch (prompt).
				const secondInstance = makeStubInstance("opencode");
				const secondEngine = yield* makeEngine(secondInstance, { sql });

				const rejected = yield* Effect.result(
					secondEngine.dispatchEffect(sendTurnCommand({ prompt: "changed" })),
				);

				expect(rejected._tag).toBe("Failure");
				if (rejected._tag === "Failure") {
					expect(rejected.failure._tag).toBe("CommandFingerprintMismatch");
				}
				expect(secondInstance.sendTurnEffect).not.toHaveBeenCalled();

				// Durable: a further fresh engine still rejects the mismatch.
				const thirdInstance = makeStubInstance("opencode");
				const thirdEngine = yield* makeEngine(thirdInstance, { sql });
				const rejectedAgain = yield* Effect.result(
					thirdEngine.dispatchEffect(sendTurnCommand({ prompt: "changed" })),
				);
				expect(rejectedAgain._tag).toBe("Failure");
				expect(thirdInstance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"resolves provider permission requests through the caller's sink on the durable path (finding #3)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				// The caller's real, interaction-capable sink must answer the
				// provider's permission request; on the durable path the reactor
				// used to substitute a failing ingestion-only sink (deny).
				const requestPermission = vi.fn(() =>
					Effect.succeed({ decision: "once" as const }),
				);
				command.input.eventSink.requestPermission = requestPermission;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockImplementation((input) =>
					input.eventSink
						.requestPermission({
							requestId: "req-1",
							sessionId: "session-1",
							turnId: "turn-1",
							toolName: "Bash",
							toolInput: { command: "whoami" },
							providerItemId: "tool-1",
						})
						.pipe(Effect.andThen(finishTurn(input, "opencode"))),
				);
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(requestPermission).toHaveBeenCalledTimes(1);
				expect((yield* receiptRow(sql, "cmd-durable-1"))?.status).toBe(
					"side_effect_completed",
				);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"redispatch after retryable failure leaves one live outbox row; drain does not re-invoke the provider (finding #2)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let providerCalls = 0;
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockImplementation(
					(input: SendTurnCommand["input"]) =>
						Effect.suspend(() => {
							providerCalls += 1;
							if (providerCalls === 1) {
								return Effect.fail(
									new ProviderInstanceFailure({
										providerId: "opencode",
										operation: "sendTurn",
										cause: { code: "rate_limit", retryable: true },
									}),
								);
							}
							return finishTurn(input, "opencode");
						}),
				);
				const engine = yield* makeEngine(instance, { sql });

				expect(yield* engine.dispatchEffect(sendTurnCommand())).toMatchObject({
					status: "error",
					error: { code: "rate_limit" },
				});
				expect(providerCalls).toBe(1);

				const retry = yield* engine.dispatchEffect(sendTurnCommand());
				expect(retry).toMatchObject({ status: "completed" });
				expect(providerCalls).toBe(2);

				// The leftover-pending-row bug made a background drain invoke the
				// provider a third time for the already-completed command.
				yield* engine.drainSideEffects();
				expect(providerCalls).toBe(2);

				const rows = yield* sql.unsafe<{ status: string }>(
					`SELECT status FROM provider_command_outbox
					 WHERE command_id = ? ORDER BY request_sequence`,
					["cmd-durable-1"],
				);
				expect(rows.map((r) => r.status)).toEqual(["completed"]);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"records provider-declared error turns as failed, not completed (finding #4)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const errorTurn: TurnResult = {
					status: "error",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					error: { code: "provider_error", message: "boom" },
					providerStateUpdates: [],
				};
				const instance = makeStubInstance("opencode");
				// Provider declares failure on the SUCCESS channel.
				instance.sendTurnEffect.mockImplementation(
					(input: SendTurnCommand["input"]) =>
						finishTurn(input, "opencode", errorTurn),
				);
				const engine = yield* makeEngine(instance, { sql });

				expect(yield* engine.dispatchEffect(sendTurnCommand())).toMatchObject({
					status: "error",
					error: { code: "provider_error" },
				});
				expect((yield* receiptRow(sql, "cmd-durable-1"))?.status).toBe(
					"side_effect_failed",
				);

				// Restart replay must NOT synthesize success without executing.
				const secondInstance = makeStubInstance("opencode");
				const secondEngine = yield* makeEngine(secondInstance, { sql });
				yield* Effect.result(secondEngine.dispatchEffect(sendTurnCommand()));
				expect(secondInstance.sendTurnEffect).toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"replays an orphaned committed-but-unexecuted command as incomplete, not completed (finding #7)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				// Simulate a crash after commit but before execution: a
				// side_effect_requested receipt whose fingerprint matches the command.
				yield* seedReceipt(sql, command);
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* engine.dispatchEffect(command);

				expect(result.status).toBe("interrupted");
				expect(result.status).not.toBe("completed");
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"orphan replay terminalizes the leftover outbox row so a later drain cannot execute it (re-review finding #2)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session-1", {
						sessionId: "session-1",
						title: "Orphan",
						provider: "opencode",
					}),
					canonicalEvent(
						"run.requested",
						"session-1",
						{ runId: "orphaned-run", inputId: command.input.inputId },
						{ metadata: { runId: "orphaned-run" } },
					),
				]);
				// Crash after commit but before execution: a side_effect_requested
				// receipt AND the still-pending outbox row it committed.
				yield* seedReceipt(sql, command);
				const {
					eventSink: _sink,
					abortSignal: _abort,
					...payload
				} = command.input;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
					provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
					VALUES (1, ${command.commandId}, 'test-project', 'session-1', 'opencode', 'send_turn',
					${JSON.stringify({ ...payload, dispatchId: "disp-1" })}, 'orphaned-run', 'pending', 0, 1000, 1000)`;
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* engine.dispatchEffect(command);
				expect(result.status).toBe("interrupted");
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();

				// A later recovery drain must NOT execute the orphaned command.
				yield* engine.drainSideEffects();
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();

				const rows = yield* sql.unsafe<{ status: string }>(
					`SELECT status FROM provider_command_outbox
					 WHERE command_id = ? ORDER BY request_sequence`,
					[command.commandId],
				);
				expect(
					rows.every(
						(r) =>
							r.status !== "pending" &&
							r.status !== "running" &&
							r.status !== "retryable_failed",
					),
				).toBe(true);
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"rejects a receipt written under an older fingerprint scheme version instead of replaying it (re-review finding #5)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const command = sendTurnCommand();
				// Hash matches the current command, but the receipt was written under
				// fingerprint scheme version 1. Hashes are only comparable within a
				// scheme version, so this must be treated as a fingerprint mismatch,
				// never a completed replay and never a re-execution.
				yield* seedReceipt(sql, command, {
					status: "side_effect_completed",
					version: 1,
				});
				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const result = yield* Effect.result(engine.dispatchEffect(command));
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") {
					expect((result.failure as { _tag: string })._tag).toBe(
						"CommandFingerprintMismatch",
					);
				}
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);

	it.effect(
		"honors stale-command tombstones from the narrow command read model",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				// Seed a session-scope tombstone directly in the command read model
				// (no full relay/UI snapshot rows exist).
				yield* sql.unsafe(
					`INSERT INTO provider_command_tombstones
						(project_key, scope_kind, scope_id, event_sequence, reason_code, tombstoned_at)
					 VALUES ('test-project', 'session', 'session-1', 1, 'session_deleted', 500)`,
				);

				const instance = makeStubInstance("opencode");
				const engine = yield* makeEngine(instance, { sql });

				const rejected = yield* Effect.result(
					engine.dispatchEffect(sendTurnCommand()),
				);

				expect(rejected._tag).toBe("Failure");
				if (rejected._tag === "Failure") {
					expect(rejected.failure._tag).toBe("StaleCommandRejected");
				}
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
				expect(yield* receiptRow(sql, "cmd-durable-1")).toBeUndefined();
			}).pipe(Effect.provide(makeFixtureLayer())),
	);
});
