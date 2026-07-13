import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
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

function makeStubInstance(providerId: string): ProviderInstance & {
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
		sendTurnEffect: vi.fn(() => Effect.succeed(COMPLETED)),
		interruptTurnEffect: vi.fn(() => Effect.void),
		resolvePermissionEffect: vi.fn(() => Effect.void),
		resolveQuestionEffect: vi.fn(() => Effect.void),
		shutdownEffect: vi.fn(() => Effect.void),
		endSessionEffect: vi.fn(() => Effect.void),
	};
}

function sendTurnCommand(
	overrides: { commandId?: string; prompt?: string } = {},
): SendTurnCommand {
	return {
		type: "send_turn",
		commandId: overrides.commandId ?? "cmd-durable-1",
		providerId: "opencode",
		input: {
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: overrides.prompt ?? "hello",
			history: [],
			providerState: {},
			workspaceRoot: "/tmp/project",
			eventSink: createMockEventSink(),
			abortSignal: new AbortController().signal,
		},
	};
}

interface DurableFixture {
	readonly db: SqliteClient;
	readonly now: ReturnType<typeof vi.fn>;
	readonly generateId: ReturnType<typeof vi.fn>;
}

function makeDurableOptions(
	fixture: Pick<DurableFixture, "db"> & Partial<DurableFixture>,
): DurableCommandStoreOptions {
	return {
		db: fixture.db,
		projectKey: "project-1",
		now: fixture.now ?? (() => 1000),
		generateId: fixture.generateId ?? (() => "disp-1"),
	};
}

function receiptRow(db: SqliteClient, commandId: string) {
	return db.queryOne<{
		readonly status: string;
		readonly fingerprint_hash: string | null;
		readonly updated_at: number | null;
	}>(
		"SELECT status, fingerprint_hash, updated_at FROM command_receipts WHERE command_id = ?",
		[commandId],
	);
}

describe("OrchestrationEngine durable receipts", () => {
	it.effect("uses injected id and time sources", () =>
		Effect.gen(function* () {
			const db = SqliteClient.memory();
			runMigrations(db, schemaMigrations);
			const now = vi.fn(() => 4242);
			const generateId = vi.fn(() => "disp-xyz");
			const registry = new ProviderRegistry();
			const instance = makeStubInstance("opencode");
			registry.registerInstance(instance);
			const engine = new OrchestrationEngine({
				registry,
				durableCommands: makeDurableOptions({ db, now, generateId }),
			});

			const result = yield* engine.dispatchEffect(sendTurnCommand());

			expect(result).toMatchObject({ status: "completed" });
			expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
			expect(now).toHaveBeenCalled();
			expect(generateId).toHaveBeenCalled();
			const row = receiptRow(db, "cmd-durable-1");
			expect(row?.status).toBe("side_effect_completed");
			expect(row?.fingerprint_hash).toMatch(/^sha256:/);
			expect(row?.updated_at).toBe(4242);
			db.close();
		}),
	);

	it.effect(
		"routes committed send_turn through the reactor to provider runtime ingestion",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
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
				const ingest = vi.fn((_event: ProviderRuntimeEvent) =>
					Effect.succeed(1),
				);
				const command = sendTurnCommand();
				const commandSinkPush = vi.spyOn(command.input.eventSink, "push");
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				// Provider streams output through the sink it is handed; the reactor's
				// sink routes to ProviderRuntimeIngestion, not the command's sink.
				instance.sendTurnEffect.mockImplementation((input) =>
					input.eventSink.push(runtimeEvent).pipe(Effect.as(COMPLETED)),
				);
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: {
						...makeDurableOptions({ db }),
						ingestion: { ingest },
					},
				});

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(ingest).toHaveBeenCalledWith(runtimeEvent);
				expect(commandSinkPush).not.toHaveBeenCalled();
				expect(receiptRow(db, "cmd-durable-1")?.status).toBe(
					"side_effect_completed",
				);
				db.close();
			}),
	);

	it.effect("id generation failure does not consume command receipt", () =>
		Effect.gen(function* () {
			const db = SqliteClient.memory();
			runMigrations(db, schemaMigrations);
			const registry = new ProviderRegistry();
			const instance = makeStubInstance("opencode");
			registry.registerInstance(instance);
			const engine = new OrchestrationEngine({
				registry,
				durableCommands: makeDurableOptions({
					db,
					generateId: vi.fn(() => {
						throw new Error("id service down");
					}),
				}),
			});

			const failed = yield* Effect.either(
				engine.dispatchEffect(sendTurnCommand()),
			);

			expect(failed._tag).toBe("Left");
			if (failed._tag === "Left") {
				expect(failed.left._tag).toBe("CommandIdGenerationFailed");
			}
			expect(instance.sendTurnEffect).not.toHaveBeenCalled();
			expect(receiptRow(db, "cmd-durable-1")).toBeUndefined();
			db.close();
		}),
	);

	it.effect(
		"replays accepted send_turn after restart without provider call",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);

				const firstRegistry = new ProviderRegistry();
				const firstInstance = makeStubInstance("opencode");
				firstRegistry.registerInstance(firstInstance);
				const firstEngine = new OrchestrationEngine({
					registry: firstRegistry,
					durableCommands: makeDurableOptions({ db }),
				});
				yield* firstEngine.dispatchEffect(sendTurnCommand());
				expect(firstInstance.sendTurnEffect).toHaveBeenCalledTimes(1);

				// Fresh engine over the same DB (simulated restart).
				const secondRegistry = new ProviderRegistry();
				const secondInstance = makeStubInstance("opencode");
				secondRegistry.registerInstance(secondInstance);
				const secondEngine = new OrchestrationEngine({
					registry: secondRegistry,
					durableCommands: makeDurableOptions({ db }),
				});

				const replayed = yield* secondEngine.dispatchEffect(sendTurnCommand());

				expect(replayed).toMatchObject({ status: "completed" });
				expect(secondInstance.sendTurnEffect).not.toHaveBeenCalled();
				db.close();
			}),
	);

	it.effect(
		"rejects reused command id with different fingerprint (changed dispatch identity)",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);

				const firstRegistry = new ProviderRegistry();
				firstRegistry.registerInstance(makeStubInstance("opencode"));
				const firstEngine = new OrchestrationEngine({
					registry: firstRegistry,
					durableCommands: makeDurableOptions({ db }),
				});
				yield* firstEngine.dispatchEffect(sendTurnCommand({ prompt: "hello" }));

				// Restart, same command id, different effective dispatch (prompt).
				const secondRegistry = new ProviderRegistry();
				const secondInstance = makeStubInstance("opencode");
				secondRegistry.registerInstance(secondInstance);
				const secondEngine = new OrchestrationEngine({
					registry: secondRegistry,
					durableCommands: makeDurableOptions({ db }),
				});

				const rejected = yield* Effect.either(
					secondEngine.dispatchEffect(sendTurnCommand({ prompt: "changed" })),
				);

				expect(rejected._tag).toBe("Left");
				if (rejected._tag === "Left") {
					expect(rejected.left._tag).toBe("CommandFingerprintMismatch");
				}
				expect(secondInstance.sendTurnEffect).not.toHaveBeenCalled();

				// Durable: a further fresh engine still rejects the mismatch.
				const thirdRegistry = new ProviderRegistry();
				const thirdInstance = makeStubInstance("opencode");
				thirdRegistry.registerInstance(thirdInstance);
				const thirdEngine = new OrchestrationEngine({
					registry: thirdRegistry,
					durableCommands: makeDurableOptions({ db }),
				});
				const rejectedAgain = yield* Effect.either(
					thirdEngine.dispatchEffect(sendTurnCommand({ prompt: "changed" })),
				);
				expect(rejectedAgain._tag).toBe("Left");
				expect(thirdInstance.sendTurnEffect).not.toHaveBeenCalled();
				db.close();
			}),
	);

	it.effect(
		"resolves provider permission requests through the caller's sink on the durable path (finding #3)",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
				const command = sendTurnCommand();
				// The caller's real, interaction-capable sink must answer the
				// provider's permission request; on the durable path the reactor
				// used to substitute a failing ingestion-only sink (deny).
				const requestPermission = vi.fn(() =>
					Effect.succeed({ decision: "once" as const }),
				);
				command.input.eventSink.requestPermission = requestPermission;
				const registry = new ProviderRegistry();
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
						.pipe(Effect.as(COMPLETED)),
				);
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: makeDurableOptions({ db }),
				});

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(requestPermission).toHaveBeenCalledTimes(1);
				expect(receiptRow(db, "cmd-durable-1")?.status).toBe(
					"side_effect_completed",
				);
				db.close();
			}),
	);

	it.effect(
		"redispatch after retryable failure leaves one live outbox row; drain does not re-invoke the provider (finding #2)",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
				let providerCalls = 0;
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				instance.sendTurnEffect.mockImplementation(() =>
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
						return Effect.succeed(COMPLETED);
					}),
				);
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: makeDurableOptions({ db }),
				});

				const first = yield* Effect.either(
					engine.dispatchEffect(sendTurnCommand()),
				);
				expect(first._tag).toBe("Left");
				expect(providerCalls).toBe(1);

				const retry = yield* engine.dispatchEffect(sendTurnCommand());
				expect(retry).toMatchObject({ status: "completed" });
				expect(providerCalls).toBe(2);

				// The leftover-pending-row bug made a background drain invoke the
				// provider a third time for the already-completed command.
				yield* engine.drainSideEffects();
				expect(providerCalls).toBe(2);

				const rows = db.query<{ status: string }>(
					`SELECT status FROM provider_command_outbox
					 WHERE command_id = ? ORDER BY request_sequence`,
					["cmd-durable-1"],
				);
				expect(rows.map((r) => r.status)).toEqual(["completed"]);
				db.close();
			}),
	);

	it.effect(
		"records provider-declared error turns as failed, not completed (finding #4)",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
				const errorTurn: TurnResult = {
					status: "error",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					error: { code: "provider_error", message: "boom" },
					providerStateUpdates: [],
				};
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				// Provider declares failure on the SUCCESS channel.
				instance.sendTurnEffect.mockReturnValue(Effect.succeed(errorTurn));
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: makeDurableOptions({ db }),
				});

				const result = yield* engine.dispatchEffect(sendTurnCommand());
				expect(result).toMatchObject({ status: "error" });
				expect(receiptRow(db, "cmd-durable-1")?.status).toBe(
					"side_effect_failed",
				);

				// Restart replay must NOT synthesize success without executing.
				const secondRegistry = new ProviderRegistry();
				const secondInstance = makeStubInstance("opencode");
				secondRegistry.registerInstance(secondInstance);
				const secondEngine = new OrchestrationEngine({
					registry: secondRegistry,
					durableCommands: makeDurableOptions({ db }),
				});
				yield* Effect.either(secondEngine.dispatchEffect(sendTurnCommand()));
				expect(secondInstance.sendTurnEffect).toHaveBeenCalled();
				db.close();
			}),
	);

	it.effect(
		"replays an orphaned committed-but-unexecuted command as incomplete, not completed (finding #7)",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
				const command = sendTurnCommand();
				// Simulate a crash after commit but before execution: a
				// side_effect_requested receipt whose fingerprint matches the command.
				const hash = fingerprintHash(effectiveDispatchFingerprint(command));
				db.execute(
					`INSERT INTO command_receipts (
						command_id, session_id, status, created_at, command_type,
						project_key, fingerprint_hash, fingerprint_version,
						side_effect_sequence, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						command.commandId,
						"session-1",
						"side_effect_requested",
						1000,
						"send_turn",
						"project-1",
						hash,
						2,
						1,
						1000,
					],
				);
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: makeDurableOptions({ db }),
				});

				const result = yield* engine.dispatchEffect(command);

				expect(result.status).toBe("interrupted");
				expect(result.status).not.toBe("completed");
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
				db.close();
			}),
	);

	it.effect(
		"orphan replay terminalizes the leftover outbox row so a later drain cannot execute it (re-review finding #2)",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
				const command = sendTurnCommand();
				const hash = fingerprintHash(effectiveDispatchFingerprint(command));
				// Crash after commit but before execution: a side_effect_requested
				// receipt AND the still-pending outbox row it committed.
				db.execute(
					`INSERT INTO command_receipts (
						command_id, session_id, status, created_at, command_type,
						project_key, fingerprint_hash, fingerprint_version,
						side_effect_sequence, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						command.commandId,
						"session-1",
						"side_effect_requested",
						1000,
						"send_turn",
						"project-1",
						hash,
						2,
						1,
						1000,
					],
				);
				const {
					eventSink: _sink,
					abortSignal: _abort,
					...payload
				} = command.input;
				db.execute(
					`INSERT INTO provider_command_outbox (
						request_sequence, command_id, project_key, session_id, provider_id,
						effect_type, payload_json, status, attempt_count, requested_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
					[
						1,
						command.commandId,
						"project-1",
						"session-1",
						"opencode",
						"send_turn",
						JSON.stringify({ ...payload, dispatchId: "disp-1" }),
						1000,
						1000,
					],
				);
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: makeDurableOptions({ db }),
				});

				const result = yield* engine.dispatchEffect(command);
				expect(result.status).toBe("interrupted");
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();

				// A later recovery drain must NOT execute the orphaned command.
				yield* engine.drainSideEffects();
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();

				const rows = db.query<{ status: string }>(
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
				db.close();
			}),
	);

	it.effect(
		"rejects a receipt written under an older fingerprint scheme version instead of replaying it (re-review finding #5)",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
				const command = sendTurnCommand();
				// Hash matches the current command, but the receipt was written under
				// fingerprint scheme version 1. Hashes are only comparable within a
				// scheme version, so this must be treated as a fingerprint mismatch,
				// never a completed replay and never a re-execution.
				const hash = fingerprintHash(effectiveDispatchFingerprint(command));
				db.execute(
					`INSERT INTO command_receipts (
						command_id, session_id, status, created_at, command_type,
						project_key, fingerprint_hash, fingerprint_version,
						side_effect_sequence, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						command.commandId,
						"session-1",
						"side_effect_completed",
						1000,
						"send_turn",
						"project-1",
						hash,
						1,
						1,
						1000,
					],
				);
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: makeDurableOptions({ db }),
				});

				const result = yield* Effect.either(engine.dispatchEffect(command));
				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect((result.left as { _tag: string })._tag).toBe(
						"CommandFingerprintMismatch",
					);
				}
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
				db.close();
			}),
	);

	it.effect(
		"honors stale-command tombstones from the narrow command read model",
		() =>
			Effect.gen(function* () {
				const db = SqliteClient.memory();
				runMigrations(db, schemaMigrations);
				// Seed a session-scope tombstone directly in the command read model
				// (no full relay/UI snapshot rows exist).
				db.execute(
					`INSERT INTO provider_command_tombstones
						(project_key, scope_kind, scope_id, event_sequence, reason_code, tombstoned_at)
					 VALUES ('project-1', 'session', 'session-1', 1, 'session_deleted', 500)`,
				);

				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					durableCommands: makeDurableOptions({ db }),
				});

				const rejected = yield* Effect.either(
					engine.dispatchEffect(sendTurnCommand()),
				);

				expect(rejected._tag).toBe("Left");
				if (rejected._tag === "Left") {
					expect(rejected.left._tag).toBe("StaleCommandRejected");
				}
				expect(instance.sendTurnEffect).not.toHaveBeenCalled();
				expect(receiptRow(db, "cmd-durable-1")).toBeUndefined();
				db.close();
			}),
	);
});
