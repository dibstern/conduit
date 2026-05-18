import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect, vi } from "vitest";
import {
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	ProviderCapabilities,
	ProviderInstance,
} from "../../../src/lib/provider/types.js";
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

function capabilities(): ProviderCapabilities {
	return {
		models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
		supportsTools: true,
		supportsThinking: true,
		supportsPermissions: true,
		supportsQuestions: true,
		supportsAttachments: true,
		supportsFork: false,
		supportsRevert: false,
		commands: [],
	};
}

function sendTurnCommand(): SendTurnCommand {
	return {
		type: "send_turn",
		commandId: "cmd-retry-after-lookup-failure",
		providerId: "opencode",
		input: {
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: "hello",
			history: [],
			providerState: {},
			workspaceRoot: "/tmp/project",
			eventSink: createMockEventSink(),
			abortSignal: new AbortController().signal,
		},
	};
}

describe("OrchestrationEngine dispatchEffect", () => {
	it.effect(
		"returns typed provider lookup failures without consuming command idempotency",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const command = sendTurnCommand();

				const failed = yield* Effect.either(engine.dispatchEffect(command));
				expect(failed._tag).toBe("Left");
				if (failed._tag === "Left") {
					expect(failed.left).toMatchObject({
						_tag: "ProviderNotRegistered",
						providerId: "opencode",
					});
				}

				const instance = makeStubInstance("opencode");
				registry.registerInstance(instance);
				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(instance.sendTurnEffect).toHaveBeenCalledTimes(1);
				expect(engine.getProviderForSession("session-1")).toBe("opencode");
			}),
	);

	it.effect(
		"dispatches sendTurn through the provider instance Effect boundary",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const command = sendTurnCommand();
				const sendTurn = vi.fn(() => {
					throw new Error("legacy Promise sendTurn should not be called");
				});
				const sendTurnEffect = vi.fn(() =>
					Effect.succeed({
						status: "completed" as const,
						cost: 0,
						tokens: { input: 1, output: 1 },
						durationMs: 1,
						providerStateUpdates: [],
					}),
				);

				registry.registerInstance({
					...makeStubInstance("opencode"),
					sendTurn,
					sendTurnEffect,
				} as ProviderInstance & {
					sendTurn: typeof sendTurn;
					sendTurnEffect: typeof sendTurnEffect;
				});

				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(sendTurn).not.toHaveBeenCalled();
				expect(sendTurnEffect).toHaveBeenCalledWith(command.input);
				expect(engine.getProviderForSession("session-1")).toBe("opencode");
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

				const fiber = yield* Effect.fork(
					engine.dispatchEffect({
						...sendTurnCommand(),
						commandId: "cmd-bind-in-flight",
						providerId: "claude",
					}),
				);
				yield* Deferred.await(sendStarted);

				expect(engine.getProviderForSession("session-1")).toBe("claude");

				yield* Deferred.succeed(releaseSend, undefined);
				yield* Fiber.join(fiber);
			}),
	);

	it.effect(
		"dispatches discovery through the provider instance Effect boundary",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const discover = vi.fn(() => {
					throw new Error("legacy Promise discover should not be called");
				});
				const discoverEffect = vi.fn(() => Effect.succeed(capabilities()));

				registry.registerInstance({
					...makeStubInstance("claude"),
					discover,
					discoverEffect,
				} as ProviderInstance & { discover: typeof discover });

				const result = yield* engine.dispatchEffect({
					type: "discover",
					providerId: "claude",
				});

				expect(result.models).toEqual([
					{ id: "sonnet", name: "Sonnet", providerId: "claude" },
				]);
				expect(discover).not.toHaveBeenCalled();
				expect(discoverEffect).toHaveBeenCalledTimes(1);
			}),
	);

	it.effect(
		"dispatches interrupt through the provider instance Effect boundary",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const interruptTurn = vi.fn(() => {
					throw new Error("legacy Promise interrupt should not be called");
				});
				const interruptTurnEffect = vi.fn(() => Effect.void);

				registry.registerInstance({
					...makeStubInstance("claude"),
					interruptTurn,
					interruptTurnEffect,
				} as ProviderInstance & {
					interruptTurn: typeof interruptTurn;
					interruptTurnEffect: typeof interruptTurnEffect;
				});
				engine.bindSession("session-1", "claude");

				yield* engine.dispatchEffect({
					type: "interrupt_turn",
					sessionId: "session-1",
				});

				expect(interruptTurn).not.toHaveBeenCalled();
				expect(interruptTurnEffect).toHaveBeenCalledWith("session-1");
			}),
	);

	it.effect(
		"dispatches permission resolution through the provider instance Effect boundary",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const resolvePermission = vi.fn(() => {
					throw new Error(
						"legacy Promise resolvePermission should not be called",
					);
				});
				const resolvePermissionEffect = vi.fn(() => Effect.void);

				registry.registerInstance({
					...makeStubInstance("claude"),
					resolvePermission,
					resolvePermissionEffect,
				} as ProviderInstance & {
					resolvePermission: typeof resolvePermission;
					resolvePermissionEffect: typeof resolvePermissionEffect;
				});
				engine.bindSession("session-1", "claude");

				yield* engine.dispatchEffect({
					type: "resolve_permission",
					sessionId: "session-1",
					requestId: "perm-1",
					decision: "once",
				});

				expect(resolvePermission).not.toHaveBeenCalled();
				expect(resolvePermissionEffect).toHaveBeenCalledWith(
					"session-1",
					"perm-1",
					"once",
				);
			}),
	);

	it.effect(
		"dispatches question resolution through the provider instance Effect boundary",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const resolveQuestion = vi.fn(() => {
					throw new Error(
						"legacy Promise resolveQuestion should not be called",
					);
				});
				const resolveQuestionEffect = vi.fn(() => Effect.void);
				const answers = { choice: "A" };

				registry.registerInstance({
					...makeStubInstance("claude"),
					resolveQuestion,
					resolveQuestionEffect,
				} as ProviderInstance & {
					resolveQuestion: typeof resolveQuestion;
					resolveQuestionEffect: typeof resolveQuestionEffect;
				});
				engine.bindSession("session-1", "claude");

				yield* engine.dispatchEffect({
					type: "resolve_question",
					sessionId: "session-1",
					requestId: "question-1",
					answers,
				});

				expect(resolveQuestion).not.toHaveBeenCalled();
				expect(resolveQuestionEffect).toHaveBeenCalledWith(
					"session-1",
					"question-1",
					answers,
				);
			}),
	);

	it.effect(
		"dispatches endSession through the provider instance Effect boundary",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const endSession = vi.fn(() => {
					throw new Error("legacy Promise endSession should not be called");
				});
				const endSessionEffect = vi.fn(() => Effect.void);

				registry.registerInstance({
					...makeStubInstance("claude"),
					endSession,
					endSessionEffect,
				} as ProviderInstance & {
					endSession: typeof endSession;
					endSessionEffect: typeof endSessionEffect;
				});
				engine.bindSession("session-1", "claude");

				yield* engine.dispatchEffect({
					type: "end_session",
					sessionId: "session-1",
					unbind: true,
				});

				expect(endSession).not.toHaveBeenCalled();
				expect(endSessionEffect).toHaveBeenCalledWith("session-1");
				expect(engine.getProviderForSession("session-1")).toBeUndefined();
			}),
	);
});
