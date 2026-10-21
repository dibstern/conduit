import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { makeAccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../../../src/lib/provider/provider-session-binding-read-model.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import { createMockEventSink } from "../../helpers/mock-sdk.js";

function makeStubInstance(providerId: string): ProviderInstance & {
	sendTurnEffect: ReturnType<typeof vi.fn>;
	resolvePermissionEffect: ReturnType<typeof vi.fn>;
	resolveQuestionEffect: ReturnType<typeof vi.fn>;
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
		sendTurnEffect: vi.fn(() =>
			Effect.succeed({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 1, output: 1 },
				durationMs: 1,
				providerStateUpdates: [],
			}),
		),
		interruptTurnEffect: vi.fn(() => Effect.void),
		resolvePermissionEffect: vi.fn(() => Effect.void),
		resolveQuestionEffect: vi.fn(() => Effect.void),
		shutdownEffect: vi.fn(() => Effect.void),
		endSessionEffect: vi.fn(() => Effect.void),
	};
}

function sendTurnCommand(): SendTurnCommand {
	return {
		type: "send_turn",
		commandId: "cmd-retry-after-lookup-failure",
		providerId: "opencode",
		input: {
			sessionId: "session-1",
			inputId: "turn-1",
			prompt: "hello",
			history: [],
			providerState: {},
			workspaceRoot: "/tmp/project",
			extraFolders: [],
			eventSink: createMockEventSink(),
			abortSignal: new AbortController().signal,
		},
	};
}

function seedProjectedSessionBinding(
	sql: SqlClient.SqlClient,
	sessionId: string,
	providerId: string,
) {
	const now = 1_735_689_600_000;
	return Effect.all([
		sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (${sessionId}, ${providerId}, ${"Persisted session"}, ${"idle"}, ${now}, ${now})`,
		sql`INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (${`${sessionId}:initial`}, ${sessionId}, ${providerId}, 'active', ${now})`,
	]);
}

describe("OrchestrationEngine dispatchEffect", () => {
	// A fallback account must choose the driver without rewriting the historical
	// binding or re-resolving an admitted account against a changed registry.
	it.effect(
		"routes a carried account while preserving the historical binding",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("claude");
				registry.registerInstance(instance);
				const accountDirectory = makeAccountDirectory(
					Effect.succeed(
						accountsStateFromInstances(
							[],
							configuredClaudeConfigDir("/tmp/g4zp-test-default"),
						),
					),
				);
				const resolveAccount = vi.spyOn(accountDirectory, "resolve");
				const engine = new OrchestrationEngine({ registry, accountDirectory });
				const account = {
					id: AccountIdSchema.make("current-account"),
					name: "Current account",
					driver: "claude" as const,
					folder: configuredClaudeConfigDir("/tmp/test-claude-account"),
					usageEligible: true,
				};
				const command: SendTurnCommand = {
					...sendTurnCommand(),
					providerId: "removed-account",
					input: {
						...sendTurnCommand().input,
						instanceId: "current-account",
						account,
					},
				};

				expect(yield* engine.dispatchEffect(command)).toMatchObject({
					status: "completed",
				});
				expect(instance.sendTurnEffect).toHaveBeenCalledWith(command.input);
				yield* engine.dispatchEffect({
					type: "discover",
					providerId: account.id,
					account,
				});
				expect(instance.discoverEffect).toHaveBeenCalledOnce();
				expect(resolveAccount).not.toHaveBeenCalled();
				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					"removed-account",
				);
			}),
	);

	it.effect(
		"recovers session provider bindings from the durable read model in a fresh engine",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedProjectedSessionBinding(sql, "session-1", "claude");
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("claude");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					sessionBindingReadModel: new SqliteProviderSessionBindingReadModel(
						sql,
					),
				});

				yield* engine.dispatchEffect({
					type: "interrupt_turn",
					commandId: "cmd-durable-binding-interrupt",
					sessionId: "session-1",
				});

				expect(instance.interruptTurnEffect).toHaveBeenCalledWith("session-1");
				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					"claude",
				);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
	);

	it.effect(
		"forwards the original input identity when interrupting a session",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedProjectedSessionBinding(sql, "session-1", "claude");
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("claude");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					sessionBindingReadModel: new SqliteProviderSessionBindingReadModel(
						sql,
					),
				});

				yield* engine.dispatchEffect({
					type: "interrupt_turn",
					commandId: "cmd-bound-interrupt",
					sessionId: "session-1",
					turnIds: ["original-input"],
				});

				expect(instance.interruptTurnEffect).toHaveBeenCalledWith("session-1", [
					"original-input",
				]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
	);

	it.effect(
		"returns typed provider lookup failures without consuming command idempotency",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const command = sendTurnCommand();

				const failed = yield* Effect.result(engine.dispatchEffect(command));
				expect(failed._tag).toBe("Failure");
				if (failed._tag === "Failure") {
					expect(failed.failure).toMatchObject({
						_tag: "ProviderNotRegistered",
						providerId: "opencode",
					});
				}

				const instance = makeStubInstance("opencode");
				registry.registerInstance(instance);
				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					"opencode",
				);
			}),
	);

	it.effect(
		"routes a named Claude instance binding through the default Claude runtime",
		() =>
			Effect.gen(function* () {
				const config: DaemonConfig = {
					pid: 1234,
					port: 2633,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					projects: [],
					instances: [
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
						},
					],
				};
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("claude");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					accountDirectory: makeAccountDirectory(
						Effect.succeed(
							accountsStateFromInstances(
								(config.instances ?? []).map((instance) => ({
									...instance,
									driver: instance.driver ?? "opencode",
								})),
								configuredClaudeConfigDir("/tmp/g4zp-test-default"),
							),
						),
					),
				});
				const command = {
					...sendTurnCommand(),
					commandId: "cmd-named-claude",
					providerId: "work-claude",
				};

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(instance.sendTurnEffect).toHaveBeenCalledWith(command.input);
				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					"work-claude",
				);
			}),
	);

	it.effect(
		"routes a named OpenCode instance binding through the default OpenCode runtime",
		() =>
			Effect.gen(function* () {
				const config: DaemonConfig = {
					pid: 1234,
					port: 2633,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					projects: [],
					instances: [
						{
							id: "work-opencode",
							name: "Work OpenCode",
							port: 4096,
							managed: true,
							driver: "opencode",
						},
					],
				};
				const registry = new ProviderRegistry();
				const instance = makeStubInstance("opencode");
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({
					registry,
					accountDirectory: makeAccountDirectory(
						Effect.succeed(
							accountsStateFromInstances(
								(config.instances ?? []).map((instance) => ({
									...instance,
									driver: instance.driver ?? "opencode",
								})),
								configuredClaudeConfigDir("/tmp/g4zp-test-default"),
							),
						),
					),
				});
				const command = {
					...sendTurnCommand(),
					commandId: "cmd-named-opencode",
					providerId: "work-opencode",
				};

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(instance.sendTurnEffect).toHaveBeenCalledWith(command.input);
				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					"work-opencode",
				);
			}),
	);

	it.effect(
		"rejects an unresolvable instance binding without dispatching to OpenCode",
		() =>
			Effect.gen(function* () {
				const config: DaemonConfig = {
					pid: 1234,
					port: 2633,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					projects: [],
				};
				const registry = new ProviderRegistry();
				const openCodeInstance = makeStubInstance("opencode");
				registry.registerInstance(openCodeInstance);
				const engine = new OrchestrationEngine({
					registry,
					accountDirectory: makeAccountDirectory(
						Effect.succeed(
							accountsStateFromInstances(
								(config.instances ?? []).map((instance) => ({
									...instance,
									driver: instance.driver ?? "opencode",
								})),
								configuredClaudeConfigDir("/tmp/g4zp-test-default"),
							),
						),
					),
				});
				const command = {
					...sendTurnCommand(),
					commandId: "cmd-deleted-instance",
					providerId: "deleted-instance",
				};

				const result = yield* Effect.result(engine.dispatchEffect(command));

				expect(result).toMatchObject({
					_tag: "Failure",
					failure: {
						_tag: "ProviderNotRegistered",
						providerId: "deleted-instance",
					},
				});
				expect(openCodeInstance.sendTurnEffect).not.toHaveBeenCalled();
				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					undefined,
				);
			}),
	);

	it.effect(
		"binds a first provider turn while sendTurn is still in flight",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const sendStarted = yield* Deferred.make<void>();
				const releaseSend = yield* Deferred.make<void>();
				const instance = makeStubInstance("claude");
				instance.sendTurnEffect.mockReturnValue(
					Effect.gen(function* () {
						yield* Deferred.succeed(sendStarted, undefined);
						yield* Deferred.await(releaseSend);
						return {
							status: "completed" as const,
							cost: 0,
							tokens: { input: 1, output: 1 },
							durationMs: 1,
							providerStateUpdates: [],
						};
					}),
				);
				registry.registerInstance(instance);

				const fiber = yield* Effect.forkChild(
					engine.dispatchEffect({
						...sendTurnCommand(),
						commandId: "cmd-bind-in-flight",
						providerId: "claude",
					}),
				);
				yield* Deferred.await(sendStarted);

				expect(yield* engine.getProviderForSessionEffect("session-1")).toBe(
					"claude",
				);

				yield* Deferred.succeed(releaseSend, undefined);
				yield* Fiber.join(fiber);
			}),
	);
});
