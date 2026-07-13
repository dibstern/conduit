import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
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
