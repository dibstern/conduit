// test/unit/provider/orchestration-engine.test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the logger module so we can spy on log.error calls
const { mockLogError } = vi.hoisted(() => ({
	mockLogError: vi.fn(),
}));
vi.mock("../../../src/lib/logger.js", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		verbose: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: mockLogError,
		child: () => ({
			debug: vi.fn(),
			verbose: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: mockLogError,
		}),
	}),
	createSilentLogger: () => ({
		debug: vi.fn(),
		verbose: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: () => ({
			debug: vi.fn(),
			verbose: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		}),
	}),
	createTestLogger: () => ({
		debug: vi.fn(),
		verbose: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: () => ({
			debug: vi.fn(),
			verbose: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		}),
	}),
}));

import { ClaudeProviderInstance } from "../../../src/lib/provider/claude/claude-provider-instance.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import {
	type DiscoverCommand,
	type EndSessionCommand,
	type InterruptTurnCommand,
	type OrchestrationCommand,
	OrchestrationEngine,
	type OrchestrationResult,
	type ResolvePermissionCommand,
	type ResolveQuestionCommand,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	ProviderCapabilities,
	ProviderInstance,
	TurnResult,
} from "../../../src/lib/provider/types.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../helpers/mock-sdk.js";

function dispatch(
	engine: OrchestrationEngine,
	command: SendTurnCommand,
): Promise<TurnResult>;
function dispatch(
	engine: OrchestrationEngine,
	command: DiscoverCommand,
): Promise<ProviderCapabilities>;
function dispatch(
	engine: OrchestrationEngine,
	command: InterruptTurnCommand,
): Promise<void>;
function dispatch(
	engine: OrchestrationEngine,
	command: ResolvePermissionCommand,
): Promise<void>;
function dispatch(
	engine: OrchestrationEngine,
	command: ResolveQuestionCommand,
): Promise<void>;
function dispatch(
	engine: OrchestrationEngine,
	command: EndSessionCommand,
): Promise<void>;
function dispatch(
	engine: OrchestrationEngine,
	command: OrchestrationCommand,
): Promise<OrchestrationResult>;
function dispatch(
	engine: OrchestrationEngine,
	command: OrchestrationCommand,
): Promise<OrchestrationResult> {
	return Effect.runPromise(engine.dispatchEffect(command));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStubInstance(providerId: string): ProviderInstance & {
	sendTurnEffect: ReturnType<typeof vi.fn>;
	interruptTurnEffect: ReturnType<typeof vi.fn>;
	resolvePermissionEffect: ReturnType<typeof vi.fn>;
	resolveQuestionEffect: ReturnType<typeof vi.fn>;
	discoverEffect: ReturnType<typeof vi.fn>;
	shutdownEffect: ReturnType<typeof vi.fn>;
	endSessionEffect: ReturnType<typeof vi.fn>;
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
				cost: 0.01,
				tokens: { input: 100, output: 50 },
				durationMs: 500,
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

// Use shared createMockEventSink from test helpers
const makeStubEventSink = createMockEventSink;

describe("OrchestrationEngine", () => {
	let registry: ProviderRegistry;
	let engine: OrchestrationEngine;
	let opencode: ReturnType<typeof makeStubInstance>;

	beforeEach(() => {
		registry = new ProviderRegistry();
		opencode = makeStubInstance("opencode");
		registry.registerInstance(opencode);
		engine = new OrchestrationEngine({ registry });
	});

	describe("dispatch: send_turn", () => {
		it("routes sendTurn to the correct instance", async () => {
			const result = await dispatch(engine, {
				type: "send_turn",
				commandId: "cmd-route-send",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			expect(opencode.sendTurnEffect).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ status: "completed" });
		});

		it("throws for unknown provider", async () => {
			await expect(
				dispatch(engine, {
					type: "send_turn",
					commandId: "cmd-unknown-provider",
					providerId: "unknown",
					input: {
						sessionId: "s1",
						turnId: "t1",
						prompt: "hello",
						history: [],
						providerState: {},
						model: { providerId: "x", modelId: "y" },
						workspaceRoot: "/tmp",
						eventSink: makeStubEventSink(),
						abortSignal: new AbortController().signal,
					},
				}),
			).rejects.toThrow(
				"No provider instance registered for provider: unknown",
			);
		});

		it("records session-to-provider binding", async () => {
			await dispatch(engine, {
				type: "send_turn",
				commandId: "cmd-bind-session",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			expect(engine.getProviderForSession("s1")).toBe("opencode");
		});
	});

	describe("dispatch: interrupt_turn", () => {
		it("routes interrupt to the correct instance", async () => {
			// Establish binding first
			engine.bindSession("s1", "opencode");

			await dispatch(engine, {
				type: "interrupt_turn",
				commandId: "cmd-interrupt",
				sessionId: "s1",
			});

			expect(opencode.interruptTurnEffect).toHaveBeenCalledWith("s1");
		});

		it("throws when session has no provider binding", async () => {
			await expect(
				dispatch(engine, {
					type: "interrupt_turn",
					commandId: "cmd-missing-binding",
					sessionId: "unknown-session",
				}),
			).rejects.toThrow("No provider bound to session: unknown-session");
		});
	});

	describe("dispatch: resolve_permission", () => {
		it("routes permission resolution to the correct instance", async () => {
			engine.bindSession("s1", "opencode");

			await dispatch(engine, {
				type: "resolve_permission",
				commandId: "cmd-resolve-permission",
				sessionId: "s1",
				requestId: "perm-1",
				decision: "always",
			});

			expect(opencode.resolvePermissionEffect).toHaveBeenCalledWith(
				"s1",
				"perm-1",
				"always",
			);
		});
	});

	describe("dispatch: resolve_question", () => {
		it("routes question resolution to the correct instance", async () => {
			engine.bindSession("s1", "opencode");

			await dispatch(engine, {
				type: "resolve_question",
				commandId: "cmd-resolve-question",
				sessionId: "s1",
				requestId: "q1",
				answers: { choice: "yes" },
			});

			expect(opencode.resolveQuestionEffect).toHaveBeenCalledWith("s1", "q1", {
				choice: "yes",
			});
		});
	});

	describe("dispatch: discover", () => {
		it("calls discover on the specified instance", async () => {
			const result = await dispatch(engine, {
				type: "discover",
				providerId: "opencode",
			});

			expect(opencode.discoverEffect).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ models: [] });
		});
	});

	describe("dispatch: end_session", () => {
		it("routes endSession to the bound provider", async () => {
			engine.bindSession("s-end-1", "opencode");

			await dispatch(engine, {
				type: "end_session",
				commandId: "cmd-end-session",
				sessionId: "s-end-1",
			});

			expect(opencode.endSessionEffect).toHaveBeenCalledWith("s-end-1");
		});

		it("is a no-op when session has no binding", async () => {
			await dispatch(engine, {
				type: "end_session",
				commandId: "cmd-end-session-unbound",
				sessionId: "unbound",
			});

			expect(opencode.endSessionEffect).not.toHaveBeenCalled();
		});

		it("preserves the binding when unbind is omitted", async () => {
			engine.bindSession("s-keep", "opencode");

			await dispatch(engine, {
				type: "end_session",
				commandId: "cmd-end-session-keep",
				sessionId: "s-keep",
			});

			expect(engine.getProviderForSession("s-keep")).toBe("opencode");
		});

		it("removes the binding when unbind: true is set", async () => {
			engine.bindSession("s-drop", "opencode");

			await dispatch(engine, {
				type: "end_session",
				commandId: "cmd-end-session-drop",
				sessionId: "s-drop",
				unbind: true,
			});

			expect(engine.getProviderForSession("s-drop")).toBeUndefined();
		});

		it("propagates provider instance errors and preserves binding", async () => {
			opencode.endSessionEffect.mockReturnValueOnce(
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "opencode",
						operation: "endSession",
						cause: new Error("provider instance boom"),
					}),
				),
			);
			engine.bindSession("s-err", "opencode");

			await expect(
				dispatch(engine, {
					type: "end_session",
					commandId: "cmd-end-session-error",
					sessionId: "s-err",
				}),
			).rejects.toThrow("provider instance boom");

			// Binding should be preserved when endSession throws
			expect(engine.getProviderForSession("s-err")).toBe("opencode");
		});
	});

	describe("session binding", () => {
		it("bindSession creates a session-to-provider mapping", () => {
			engine.bindSession("s1", "opencode");
			expect(engine.getProviderForSession("s1")).toBe("opencode");
		});

		it("unbindSession removes the mapping", () => {
			engine.bindSession("s1", "opencode");
			engine.unbindSession("s1");
			expect(engine.getProviderForSession("s1")).toBeUndefined();
		});

		it("getProviderForSession returns undefined for unbound session", () => {
			expect(engine.getProviderForSession("unknown")).toBeUndefined();
		});

		it("rebinding a session to a different provider updates the mapping", () => {
			const claude = makeStubInstance("claude");
			registry.registerInstance(claude);

			engine.bindSession("s1", "opencode");
			engine.bindSession("s1", "claude");
			expect(engine.getProviderForSession("s1")).toBe("claude");
		});

		it("listBoundSessions returns all bound sessions", () => {
			engine.bindSession("s1", "opencode");
			engine.bindSession("s2", "opencode");

			const sessions = engine.listBoundSessions();
			expect(sessions).toEqual(
				expect.arrayContaining([
					{ sessionId: "s1", providerId: "opencode" },
					{ sessionId: "s2", providerId: "opencode" },
				]),
			);
		});
	});

	describe("idempotency", () => {
		it("rejects send_turn without commandId before provider lookup", async () => {
			const getInstanceEffect = vi.spyOn(registry, "getInstanceEffect");

			await expect(
				dispatch(engine, {
					type: "send_turn",
					providerId: "opencode",
					input: {
						sessionId: "s1",
						turnId: "t1",
						prompt: "hello",
						history: [],
						providerState: {},
						model: {
							providerId: "anthropic",
							modelId: "claude-sonnet",
						},
						workspaceRoot: "/tmp",
						eventSink: makeStubEventSink(),
						abortSignal: new AbortController().signal,
					},
				} as unknown as SendTurnCommand),
			).rejects.toThrow(
				"Missing commandId for mutating provider command: send_turn",
			);

			expect(getInstanceEffect).not.toHaveBeenCalled();
			expect(opencode.sendTurnEffect).not.toHaveBeenCalled();
		});

		it("rejects interrupt_turn without commandId before provider side effects", async () => {
			engine.bindSession("s1", "opencode");
			const getInstanceEffect = vi.spyOn(registry, "getInstanceEffect");

			await expect(
				dispatch(engine, {
					type: "interrupt_turn",
					sessionId: "s1",
				} as unknown as InterruptTurnCommand),
			).rejects.toThrow(
				"Missing commandId for mutating provider command: interrupt_turn",
			);

			expect(getInstanceEffect).not.toHaveBeenCalled();
			expect(opencode.interruptTurnEffect).not.toHaveBeenCalled();
		});

		it.each([
			{
				command: {
					type: "resolve_permission",
					sessionId: "s1",
					requestId: "perm-1",
					decision: "once",
				},
				commandType: "resolve_permission",
				providerMethod: () => opencode.resolvePermissionEffect,
			},
			{
				command: {
					type: "resolve_question",
					sessionId: "s1",
					requestId: "question-1",
					answers: {},
				},
				commandType: "resolve_question",
				providerMethod: () => opencode.resolveQuestionEffect,
			},
			{
				command: {
					type: "end_session",
					sessionId: "s1",
				},
				commandType: "end_session",
				providerMethod: () => opencode.endSessionEffect,
			},
		] as const)("rejects $commandType without commandId before provider side effects", async ({
			command,
			commandType,
			providerMethod,
		}) => {
			engine.bindSession("s1", "opencode");

			await expect(
				dispatch(engine, command as unknown as OrchestrationCommand),
			).rejects.toThrow(
				`Missing commandId for mutating provider command: ${commandType}`,
			);
			expect(providerMethod()).not.toHaveBeenCalled();
		});

		it("shares in-flight duplicate command IDs", async () => {
			const gate = await Effect.runPromise(Deferred.make<void>());
			opencode.sendTurnEffect.mockReturnValueOnce(
				Deferred.await(gate).pipe(Effect.as(makeSuccessResult())),
			);
			const command: SendTurnCommand = {
				type: "send_turn",
				commandId: "cmd-1",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			};

			const first = dispatch(engine, command);
			const duplicate = dispatch(engine, command);
			await Promise.resolve();

			expect(opencode.sendTurnEffect).toHaveBeenCalledTimes(1);
			Effect.runSync(Deferred.succeed(gate, undefined));
			await expect(first).resolves.toEqual(makeSuccessResult());
			await expect(duplicate).resolves.toEqual(makeSuccessResult());
		});

		it("allows different command IDs to run independently", async () => {
			const makeCommand = (commandId: string): SendTurnCommand => ({
				type: "send_turn",
				commandId,
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			await dispatch(engine, makeCommand("cmd-independent-1"));
			await dispatch(engine, makeCommand("cmd-independent-2"));

			expect(opencode.sendTurnEffect).toHaveBeenCalledTimes(2);
		});
	});

	describe("shutdownEffect", () => {
		it("delegates to registry.shutdownAllEffect", async () => {
			const shutdownSpy = vi.spyOn(registry, "shutdownAllEffect");

			await Effect.runPromise(engine.shutdownEffect());

			expect(shutdownSpy).toHaveBeenCalledTimes(1);
		});

		it("clears session bindings", async () => {
			engine.bindSession("s1", "opencode");
			engine.bindSession("s2", "opencode");

			await Effect.runPromise(engine.shutdownEffect());

			expect(engine.getProviderForSession("s1")).toBeUndefined();
			expect(engine.getProviderForSession("s2")).toBeUndefined();
			expect(engine.listBoundSessions()).toEqual([]);
		});
	});

	// ─── Claude provider instance integration ─────────────────────────────────────────
	// These tests use a real ClaudeProviderInstance with an injected queryFactory
	// to verify the full dispatch path:
	// OrchestrationEngine.dispatchEffect(SendTurnCommand) → ClaudeProviderInstance.sendTurnEffect()
	// → SDK query() → stream consumer → canonical events via EventSink.

	describe("Claude provider instance integration", () => {
		let claudeWorkspace: string;

		beforeEach(() => {
			claudeWorkspace = join(tmpdir(), `conduit-orch-claude-${Date.now()}`);
			mkdirSync(claudeWorkspace, { recursive: true });
		});

		afterEach(() => {
			rmSync(claudeWorkspace, { recursive: true, force: true });
		});

		it("happy path: dispatch sendTurn through real ClaudeProviderInstance yields completed TurnResult", async () => {
			const resultMsg = makeSuccessResult();
			const mockQuery = createMockQuery([resultMsg]);
			const queryFactory = vi.fn(() => mockQuery);

			const claudeRegistry = new ProviderRegistry();
			const instance = new ClaudeProviderInstance({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerInstance(instance);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			const result = await dispatch(claudeEngine, {
				type: "send_turn",
				commandId: "cmd-claude-integration",
				providerId: "claude",
				input: makeBaseSendTurnInput({
					sessionId: "int-session-1",
					turnId: "int-turn-1",
					prompt: "Integration test prompt",
					workspaceRoot: claudeWorkspace,
					eventSink: sink,
				}),
			});

			expect(result.status).toBe("completed");
			expect(result.cost).toBe(0.05);
			expect(result.tokens.input).toBe(100);
			expect(result.tokens.output).toBe(50);
			expect(queryFactory).toHaveBeenCalledTimes(1);
		});

		it("session binding persists after sendTurn", async () => {
			const resultMsg = makeSuccessResult();
			const mockQuery = createMockQuery([resultMsg]);
			const queryFactory = vi.fn(() => mockQuery);

			const claudeRegistry = new ProviderRegistry();
			const instance = new ClaudeProviderInstance({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerInstance(instance);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			await dispatch(claudeEngine, {
				type: "send_turn",
				commandId: "cmd-claude-bind",
				providerId: "claude",
				input: makeBaseSendTurnInput({
					sessionId: "int-session-bind",
					turnId: "int-turn-1",
					workspaceRoot: claudeWorkspace,
					eventSink: sink,
				}),
			});

			expect(claudeEngine.getProviderForSession("int-session-bind")).toBe(
				"claude",
			);
		});

		it("error propagation: queryFactory throws → TurnResult has status error", async () => {
			// biome-ignore lint/correctness/useYield: intentionally throws before yielding
			const throwingGen = (async function* () {
				throw new Error("SDK connection failed");
			})();
			const throwingQuery = Object.assign(throwingGen, {
				interrupt: vi.fn(async () => {}),
				close: vi.fn(),
				setModel: vi.fn(async () => {}),
				setPermissionMode: vi.fn(async () => {}),
				streamInput: vi.fn(async () => {}),
				setMaxThinkingTokens: vi.fn(async () => {}),
				applyFlagSettings: vi.fn(async () => {}),
				initializationResult: vi.fn(async () => ({})),
				supportedCommands: vi.fn(async () => []),
				supportedModels: vi.fn(async () => []),
				supportedAgents: vi.fn(async () => []),
				mcpServerStatus: vi.fn(async () => []),
				getContextUsage: vi.fn(async () => ({})),
				reloadPlugins: vi.fn(async () => ({})),
				accountInfo: vi.fn(async () => ({})),
				rewindFiles: vi.fn(async () => ({ canRewind: false })),
				seedReadState: vi.fn(async () => {}),
				reconnectMcpServer: vi.fn(async () => {}),
				toggleMcpServer: vi.fn(async () => {}),
				setMcpServers: vi.fn(async () => ({})),
				stopTask: vi.fn(async () => {}),
				next: throwingGen.next.bind(throwingGen),
				return: throwingGen.return.bind(throwingGen),
				throw: throwingGen.throw.bind(throwingGen),
				[Symbol.asyncIterator]: () => throwingGen,
			}) as unknown as import("../../../src/lib/provider/claude/types.js").Query;

			const queryFactory = vi.fn(() => throwingQuery);

			const claudeRegistry = new ProviderRegistry();
			const instance = new ClaudeProviderInstance({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerInstance(instance);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			const result = await dispatch(claudeEngine, {
				type: "send_turn",
				commandId: "cmd-claude-error-result",
				providerId: "claude",
				input: makeBaseSendTurnInput({
					sessionId: "int-session-err",
					turnId: "int-turn-err",
					workspaceRoot: claudeWorkspace,
					eventSink: sink,
				}),
			});

			expect(result.status).toBe("error");
			expect(result.error).toBeDefined();
			expect(result.error?.message).toContain("SDK connection failed");
		});

		it("sendTurn that throws does NOT leave stale session binding", async () => {
			// A throwing sendTurn should not create a binding — the session is
			// not viable at the provider. This tests the fix for C3 (stale binding).
			const throwingInstance = makeStubInstance("thrower");
			throwingInstance.sendTurnEffect.mockReturnValue(
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "thrower",
						operation: "sendTurn",
						cause: new Error("Provider instance crash"),
					}),
				),
			);

			const throwingRegistry = new ProviderRegistry();
			throwingRegistry.registerInstance(throwingInstance);
			const throwingEngine = new OrchestrationEngine({
				registry: throwingRegistry,
			});

			await expect(
				dispatch(throwingEngine, {
					type: "send_turn",
					commandId: "cmd-provider-crash",
					providerId: "thrower",
					input: {
						sessionId: "s-crash",
						turnId: "t1",
						prompt: "hello",
						history: [],
						providerState: {},
						workspaceRoot: "/tmp",
						eventSink: makeStubEventSink(),
						abortSignal: new AbortController().signal,
					},
				}),
			).rejects.toThrow("Provider instance crash");

			// Binding should NOT exist after a thrown error
			expect(throwingEngine.getProviderForSession("s-crash")).toBeUndefined();
		});

		it("sendTurnEffect synchronous throw does NOT leave stale early binding", async () => {
			const throwingInstance = makeStubInstance("sync-thrower");
			throwingInstance.sendTurnEffect.mockImplementation(() => {
				throw new Error("Provider instance sync crash");
			});

			const throwingRegistry = new ProviderRegistry();
			throwingRegistry.registerInstance(throwingInstance);
			const throwingEngine = new OrchestrationEngine({
				registry: throwingRegistry,
			});

			await expect(
				dispatch(throwingEngine, {
					type: "send_turn",
					commandId: "cmd-provider-sync-crash",
					providerId: "sync-thrower",
					input: {
						sessionId: "s-sync-crash",
						turnId: "t1",
						prompt: "hello",
						history: [],
						providerState: {},
						workspaceRoot: "/tmp",
						eventSink: makeStubEventSink(),
						abortSignal: new AbortController().signal,
					},
				}),
			).rejects.toThrow("Provider instance sync crash");

			expect(
				throwingEngine.getProviderForSession("s-sync-crash"),
			).toBeUndefined();
		});

		it("sendTurn returning error TurnResult still binds session (session exists at provider)", async () => {
			// When sendTurn resolves with an error TurnResult (not throws),
			// the session IS bound — the provider has the session, it just errored.
			// biome-ignore lint/correctness/useYield: intentionally throws before yielding
			const throwingGen = (async function* () {
				throw new Error("Immediate failure");
			})();
			const throwingQuery = Object.assign(throwingGen, {
				interrupt: vi.fn(async () => {}),
				close: vi.fn(),
				setModel: vi.fn(async () => {}),
				setPermissionMode: vi.fn(async () => {}),
				streamInput: vi.fn(async () => {}),
				setMaxThinkingTokens: vi.fn(async () => {}),
				applyFlagSettings: vi.fn(async () => {}),
				initializationResult: vi.fn(async () => ({})),
				supportedCommands: vi.fn(async () => []),
				supportedModels: vi.fn(async () => []),
				supportedAgents: vi.fn(async () => []),
				mcpServerStatus: vi.fn(async () => []),
				getContextUsage: vi.fn(async () => ({})),
				reloadPlugins: vi.fn(async () => ({})),
				accountInfo: vi.fn(async () => ({})),
				rewindFiles: vi.fn(async () => ({ canRewind: false })),
				seedReadState: vi.fn(async () => {}),
				reconnectMcpServer: vi.fn(async () => {}),
				toggleMcpServer: vi.fn(async () => {}),
				setMcpServers: vi.fn(async () => ({})),
				stopTask: vi.fn(async () => {}),
				next: throwingGen.next.bind(throwingGen),
				return: throwingGen.return.bind(throwingGen),
				throw: throwingGen.throw.bind(throwingGen),
				[Symbol.asyncIterator]: () => throwingGen,
			}) as unknown as import("../../../src/lib/provider/claude/types.js").Query;

			const queryFactory = vi.fn(() => throwingQuery);

			const claudeRegistry = new ProviderRegistry();
			const instance = new ClaudeProviderInstance({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerInstance(instance);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			const result = await dispatch(claudeEngine, {
				type: "send_turn",
				commandId: "cmd-claude-erred-result",
				providerId: "claude",
				input: makeBaseSendTurnInput({
					sessionId: "int-session-erred",
					turnId: "int-turn-erred",
					workspaceRoot: claudeWorkspace,
					eventSink: sink,
				}),
			});

			// Error TurnResult (not thrown) — binding should exist
			expect(result.status).toBe("error");
			expect(claudeEngine.getProviderForSession("int-session-erred")).toBe(
				"claude",
			);
		});
	});

	describe("dispatch error context logging", () => {
		beforeEach(() => {
			mockLogError.mockClear();
		});

		it("dispatch logs error context before re-throwing for interruptTurn", async () => {
			const failing = makeStubInstance("opencode");
			failing.interruptTurnEffect.mockReturnValue(
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "opencode",
						operation: "interruptTurn",
						cause: new Error("Provider instance interrupt failed"),
					}),
				),
			);

			const reg = new ProviderRegistry();
			reg.registerInstance(failing);
			const eng = new OrchestrationEngine({ registry: reg });
			eng.bindSession("s-err", "opencode");

			await expect(
				dispatch(eng, {
					type: "interrupt_turn",
					commandId: "cmd-interrupt-error",
					sessionId: "s-err",
				}),
			).rejects.toThrow("Provider instance interrupt failed");

			expect(mockLogError).toHaveBeenCalledTimes(1);
			const call0 = mockLogError.mock.calls[0];
			expect(call0).toBeDefined();
			const logMsg = call0?.[0] as string;
			expect(logMsg).toContain("s-err");
			expect(logMsg).toContain("opencode");
		});

		it("dispatch logs error context before re-throwing for resolvePermission", async () => {
			const failing = makeStubInstance("opencode");
			failing.resolvePermissionEffect.mockReturnValue(
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "opencode",
						operation: "resolvePermission",
						cause: new Error("Provider instance permission failed"),
					}),
				),
			);

			const reg = new ProviderRegistry();
			reg.registerInstance(failing);
			const eng = new OrchestrationEngine({ registry: reg });
			eng.bindSession("s-perm", "opencode");

			await expect(
				dispatch(eng, {
					type: "resolve_permission",
					commandId: "cmd-permission-error",
					sessionId: "s-perm",
					requestId: "req-1",
					decision: "always",
				}),
			).rejects.toThrow("Provider instance permission failed");

			expect(mockLogError).toHaveBeenCalledTimes(1);
			const call1 = mockLogError.mock.calls[0];
			expect(call1).toBeDefined();
			const logMsg = call1?.[0] as string;
			expect(logMsg).toContain("s-perm");
			expect(logMsg).toContain("opencode");
		});

		it("dispatch logs error context before re-throwing for discover", async () => {
			const failing = makeStubInstance("opencode");
			failing.discoverEffect.mockReturnValue(
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "opencode",
						operation: "discover",
						cause: new Error("Provider instance discover failed"),
					}),
				),
			);

			const reg = new ProviderRegistry();
			reg.registerInstance(failing);
			const eng = new OrchestrationEngine({ registry: reg });

			await expect(
				dispatch(eng, {
					type: "discover",
					providerId: "opencode",
				}),
			).rejects.toThrow("Provider instance discover failed");

			expect(mockLogError).toHaveBeenCalledTimes(1);
			const call2 = mockLogError.mock.calls[0];
			expect(call2).toBeDefined();
			const logMsg = call2?.[0] as string;
			expect(logMsg).toContain("opencode");
		});
	});
});
