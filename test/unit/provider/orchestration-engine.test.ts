// test/unit/provider/orchestration-engine.test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { ClaudeAdapter } from "../../../src/lib/provider/claude/claude-adapter.js";
import {
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderAdapter } from "../../../src/lib/provider/types.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../helpers/mock-sdk.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStubAdapter(providerId: string): ProviderAdapter & {
	sendTurn: ReturnType<typeof vi.fn>;
	interruptTurn: ReturnType<typeof vi.fn>;
	resolvePermission: ReturnType<typeof vi.fn>;
	resolveQuestion: ReturnType<typeof vi.fn>;
	discover: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	endSession: ReturnType<typeof vi.fn>;
} {
	return {
		providerId,
		discover: vi.fn(async () => ({
			models: [],
			supportsTools: false,
			supportsThinking: false,
			supportsPermissions: false,
			supportsQuestions: false,
			supportsAttachments: false,
			supportsFork: false,
			supportsRevert: false,
			commands: [],
		})),
		sendTurn: vi.fn(async () => ({
			status: "completed" as const,
			cost: 0.01,
			tokens: { input: 100, output: 50 },
			durationMs: 500,
			providerStateUpdates: [],
		})),
		interruptTurn: vi.fn(async () => {}),
		resolvePermission: vi.fn(async () => {}),
		resolveQuestion: vi.fn(async () => {}),
		shutdown: vi.fn(async () => {}),
		endSession: vi.fn(async () => {}),
	};
}

// Use shared createMockEventSink from test helpers
const makeStubEventSink = createMockEventSink;

describe("OrchestrationEngine", () => {
	let registry: ProviderRegistry;
	let engine: OrchestrationEngine;
	let opencode: ReturnType<typeof makeStubAdapter>;

	beforeEach(() => {
		registry = new ProviderRegistry();
		opencode = makeStubAdapter("opencode");
		registry.registerAdapter(opencode);
		engine = new OrchestrationEngine({ registry });
	});

	describe("dispatch: send_turn", () => {
		it("routes sendTurn to the correct adapter", async () => {
			const result = await engine.dispatch({
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
			});

			expect(opencode.sendTurn).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ status: "completed" });
		});

		it("throws for unknown provider", async () => {
			await expect(
				engine.dispatch({
					type: "send_turn",
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
			).rejects.toThrow("No adapter registered for provider: unknown");
		});

		it("records session-to-provider binding", async () => {
			await engine.dispatch({
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
			});

			expect(engine.getProviderForSession("s1")).toBe("opencode");
		});
	});

	describe("dispatch: interrupt_turn", () => {
		it("routes interrupt to the correct adapter", async () => {
			// Establish binding first
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "interrupt_turn",
				sessionId: "s1",
			});

			expect(opencode.interruptTurn).toHaveBeenCalledWith("s1");
		});

		it("throws when session has no provider binding", async () => {
			await expect(
				engine.dispatch({
					type: "interrupt_turn",
					sessionId: "unknown-session",
				}),
			).rejects.toThrow("No provider bound to session: unknown-session");
		});
	});

	describe("dispatch: resolve_permission", () => {
		it("routes permission resolution to the correct adapter", async () => {
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "resolve_permission",
				sessionId: "s1",
				requestId: "perm-1",
				decision: "always",
			});

			expect(opencode.resolvePermission).toHaveBeenCalledWith(
				"s1",
				"perm-1",
				"always",
			);
		});
	});

	describe("dispatch: resolve_question", () => {
		it("routes question resolution to the correct adapter", async () => {
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "resolve_question",
				sessionId: "s1",
				requestId: "q1",
				answers: { choice: "yes" },
			});

			expect(opencode.resolveQuestion).toHaveBeenCalledWith("s1", "q1", {
				choice: "yes",
			});
		});
	});

	describe("dispatch: discover", () => {
		it("calls discover on the specified adapter", async () => {
			const result = await engine.dispatch({
				type: "discover",
				providerId: "opencode",
			});

			expect(opencode.discover).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ models: [] });
		});
	});

	describe("dispatch: end_session", () => {
		it("routes endSession to the bound provider", async () => {
			engine.bindSession("s-end-1", "opencode");

			await engine.dispatch({
				type: "end_session",
				sessionId: "s-end-1",
			});

			expect(opencode.endSession).toHaveBeenCalledWith("s-end-1");
		});

		it("is a no-op when session has no binding", async () => {
			await engine.dispatch({
				type: "end_session",
				sessionId: "unbound",
			});

			expect(opencode.endSession).not.toHaveBeenCalled();
		});

		it("preserves the binding when unbind is omitted", async () => {
			engine.bindSession("s-keep", "opencode");

			await engine.dispatch({
				type: "end_session",
				sessionId: "s-keep",
			});

			expect(engine.getProviderForSession("s-keep")).toBe("opencode");
		});

		it("removes the binding when unbind: true is set", async () => {
			engine.bindSession("s-drop", "opencode");

			await engine.dispatch({
				type: "end_session",
				sessionId: "s-drop",
				unbind: true,
			});

			expect(engine.getProviderForSession("s-drop")).toBeUndefined();
		});

		it("propagates adapter errors and preserves binding", async () => {
			opencode.endSession.mockRejectedValueOnce(new Error("adapter boom"));
			engine.bindSession("s-err", "opencode");

			await expect(
				engine.dispatch({
					type: "end_session",
					sessionId: "s-err",
				}),
			).rejects.toThrow("adapter boom");

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
			const claude = makeStubAdapter("claude");
			registry.registerAdapter(claude);

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
		it("rejects duplicate command IDs", async () => {
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

			await engine.dispatch(command);

			// Second dispatch with same commandId should be rejected
			await expect(engine.dispatch(command)).rejects.toThrow(
				"Duplicate command: cmd-1",
			);
		});

		it("allows commands without commandId (no idempotency check)", async () => {
			const makeCommand = (): SendTurnCommand => ({
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
			});

			await engine.dispatch(makeCommand());
			await engine.dispatch(makeCommand()); // Should not throw

			expect(opencode.sendTurn).toHaveBeenCalledTimes(2);
		});
	});

	describe("processedCommands pruning", () => {
		it("evicts oldest entries when exceeding 10,000 threshold", async () => {
			// Access the private processedCommands set via the engine instance
			const commands = (engine as unknown as { processedCommands: Set<string> })
				.processedCommands;

			// Fill the set to just above the threshold
			for (let i = 0; i < 10_001; i++) {
				commands.add(`pre-${i}`);
			}

			// Dispatch one more command to trigger pruning
			await engine.dispatch({
				type: "send_turn",
				commandId: "trigger-prune",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			// After pruning, the set should be roughly half its previous size
			// (10,002 entries → prune 5,000 → ~5,002 remaining)
			expect(commands.size).toBeLessThanOrEqual(5_100);
			expect(commands.size).toBeGreaterThan(0);
			// The trigger command should still be in the set
			expect(commands.has("trigger-prune")).toBe(true);
		});
	});

	describe("shutdown", () => {
		it("delegates to registry.shutdownAll", async () => {
			const shutdownSpy = vi.spyOn(registry, "shutdownAll");

			await engine.shutdown();

			expect(shutdownSpy).toHaveBeenCalledTimes(1);
		});

		it("clears session bindings", async () => {
			engine.bindSession("s1", "opencode");
			engine.bindSession("s2", "opencode");

			await engine.shutdown();

			expect(engine.getProviderForSession("s1")).toBeUndefined();
			expect(engine.getProviderForSession("s2")).toBeUndefined();
			expect(engine.listBoundSessions()).toEqual([]);
		});
	});

	// ─── Claude adapter integration ─────────────────────────────────────────
	// These tests use a real ClaudeAdapter with an injected queryFactory
	// to verify the full dispatch path:
	// OrchestrationEngine.dispatch(SendTurnCommand) → ClaudeAdapter.sendTurn()
	// → SDK query() → stream consumer → canonical events via EventSink.

	describe("Claude adapter integration", () => {
		let claudeWorkspace: string;

		beforeEach(() => {
			claudeWorkspace = join(tmpdir(), `conduit-orch-claude-${Date.now()}`);
			mkdirSync(claudeWorkspace, { recursive: true });
		});

		afterEach(() => {
			rmSync(claudeWorkspace, { recursive: true, force: true });
		});

		it("happy path: dispatch sendTurn through real ClaudeAdapter yields completed TurnResult", async () => {
			const resultMsg = makeSuccessResult();
			const mockQuery = createMockQuery([resultMsg]);
			const queryFactory = vi.fn(() => mockQuery);

			const claudeRegistry = new ProviderRegistry();
			const adapter = new ClaudeAdapter({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerAdapter(adapter);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			const result = await claudeEngine.dispatch({
				type: "send_turn",
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
			const adapter = new ClaudeAdapter({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerAdapter(adapter);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			await claudeEngine.dispatch({
				type: "send_turn",
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
			const adapter = new ClaudeAdapter({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerAdapter(adapter);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			const result = await claudeEngine.dispatch({
				type: "send_turn",
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
			const throwingAdapter = makeStubAdapter("thrower");
			throwingAdapter.sendTurn.mockRejectedValue(new Error("Adapter crash"));

			const throwingRegistry = new ProviderRegistry();
			throwingRegistry.registerAdapter(throwingAdapter);
			const throwingEngine = new OrchestrationEngine({
				registry: throwingRegistry,
			});

			await expect(
				throwingEngine.dispatch({
					type: "send_turn",
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
			).rejects.toThrow("Adapter crash");

			// Binding should NOT exist after a thrown error
			expect(throwingEngine.getProviderForSession("s-crash")).toBeUndefined();
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
			const adapter = new ClaudeAdapter({
				workspaceRoot: claudeWorkspace,
				queryFactory,
			});
			claudeRegistry.registerAdapter(adapter);

			const claudeEngine = new OrchestrationEngine({
				registry: claudeRegistry,
			});

			const sink = createMockEventSink();
			const result = await claudeEngine.dispatch({
				type: "send_turn",
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
			const failing = makeStubAdapter("opencode");
			failing.interruptTurn.mockRejectedValue(
				new Error("Adapter interrupt failed"),
			);

			const reg = new ProviderRegistry();
			reg.registerAdapter(failing);
			const eng = new OrchestrationEngine({ registry: reg });
			eng.bindSession("s-err", "opencode");

			await expect(
				eng.dispatch({
					type: "interrupt_turn",
					sessionId: "s-err",
				}),
			).rejects.toThrow("Adapter interrupt failed");

			expect(mockLogError).toHaveBeenCalledTimes(1);
			const call0 = mockLogError.mock.calls[0];
			expect(call0).toBeDefined();
			const logMsg = call0?.[0] as string;
			expect(logMsg).toContain("s-err");
			expect(logMsg).toContain("opencode");
		});

		it("dispatch logs error context before re-throwing for resolvePermission", async () => {
			const failing = makeStubAdapter("opencode");
			failing.resolvePermission.mockRejectedValue(
				new Error("Adapter permission failed"),
			);

			const reg = new ProviderRegistry();
			reg.registerAdapter(failing);
			const eng = new OrchestrationEngine({ registry: reg });
			eng.bindSession("s-perm", "opencode");

			await expect(
				eng.dispatch({
					type: "resolve_permission",
					sessionId: "s-perm",
					requestId: "req-1",
					decision: "always",
				}),
			).rejects.toThrow("Adapter permission failed");

			expect(mockLogError).toHaveBeenCalledTimes(1);
			const call1 = mockLogError.mock.calls[0];
			expect(call1).toBeDefined();
			const logMsg = call1?.[0] as string;
			expect(logMsg).toContain("s-perm");
			expect(logMsg).toContain("opencode");
		});

		it("dispatch logs error context before re-throwing for discover", async () => {
			const failing = makeStubAdapter("opencode");
			failing.discover.mockRejectedValue(new Error("Adapter discover failed"));

			const reg = new ProviderRegistry();
			reg.registerAdapter(failing);
			const eng = new OrchestrationEngine({ registry: reg });

			await expect(
				eng.dispatch({
					type: "discover",
					providerId: "opencode",
				}),
			).rejects.toThrow("Adapter discover failed");

			expect(mockLogError).toHaveBeenCalledTimes(1);
			const call2 = mockLogError.mock.calls[0];
			expect(call2).toBeDefined();
			const logMsg = call2?.[0] as string;
			expect(logMsg).toContain("opencode");
		});
	});
});
