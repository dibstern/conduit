// test/unit/provider/claude/provider-wiring.test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

describe("Provider wiring with Claude adapter", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-wiring-test-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("registers Claude adapter in ProviderRegistry", () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });

		registry.registerAdapter(adapter);

		expect(registry.hasAdapter("claude")).toBe(true);
		expect(registry.getAdapter("claude")).toBe(adapter);
	});

	it("lists both providers when both registered", () => {
		const registry = new ProviderRegistry();
		const claude = new ClaudeAdapter({ workspaceRoot: workspace });

		// Create a minimal mock for opencode adapter
		const opencode = {
			providerId: "opencode",
			discover: async () => ({
				models: [],
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: true,
				supportsRevert: true,
				commands: [],
			}),
			sendTurn: async () => {
				throw new Error("not implemented");
			},
			interruptTurn: async () => {},
			resolvePermission: async () => {},
			resolveQuestion: async () => {},
			shutdown: async () => {},
			endSession: async () => {},
		};

		registry.registerAdapter(opencode);
		registry.registerAdapter(claude);

		const providers = registry.listProviders();
		expect(providers).toContain("opencode");
		expect(providers).toContain("claude");
		expect(providers).toHaveLength(2);
	});

	it("OrchestrationEngine dispatches discover to Claude adapter", async () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		registry.registerAdapter(adapter);

		const engine = new OrchestrationEngine({ registry });
		const caps = await engine.dispatch({
			type: "discover",
			providerId: "claude",
		});

		expect(caps.models.length).toBeGreaterThan(0);
		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsFork).toBe(false);
	});

	it("OrchestrationEngine throws for unregistered provider", async () => {
		const registry = new ProviderRegistry();
		const engine = new OrchestrationEngine({ registry });

		await expect(
			engine.dispatch({ type: "discover", providerId: "nonexistent" }),
		).rejects.toThrow("No adapter registered");
	});

	it("shutdownAll shuts down Claude adapter", async () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		registry.registerAdapter(adapter);

		// Should not throw
		await registry.shutdownAll();
	});

	it("session binding tracks provider for session", () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		registry.registerAdapter(adapter);

		const engine = new OrchestrationEngine({ registry });
		engine.bindSession("sess-1", "claude");

		expect(engine.getProviderForSession("sess-1")).toBe("claude");
	});

	it("session binding can switch provider", () => {
		const registry = new ProviderRegistry();
		const engine = new OrchestrationEngine({ registry });

		engine.bindSession("sess-1", "opencode");
		expect(engine.getProviderForSession("sess-1")).toBe("opencode");

		engine.bindSession("sess-1", "claude");
		expect(engine.getProviderForSession("sess-1")).toBe("claude");
	});

	it("listBoundSessions includes claude-bound sessions", () => {
		const registry = new ProviderRegistry();
		const engine = new OrchestrationEngine({ registry });

		engine.bindSession("sess-1", "claude");
		engine.bindSession("sess-2", "opencode");

		const bindings = engine.listBoundSessions();
		expect(bindings).toHaveLength(2);
		expect(bindings.find((b) => b.sessionId === "sess-1")?.providerId).toBe(
			"claude",
		);
		expect(bindings.find((b) => b.sessionId === "sess-2")?.providerId).toBe(
			"opencode",
		);
	});

	it("end-to-end: dispatch sendTurn through full ProviderRegistry → ClaudeAdapter → mock SDK stack", async () => {
		const resultMsg = makeSuccessResult({ total_cost_usd: 0.03 } as Record<
			string,
			unknown
		>);
		const mockQuery = createMockQuery([resultMsg]);
		const queryFactory = vi.fn(() => mockQuery);

		// Wire up the full stack: ProviderRegistry + ClaudeAdapter + OrchestrationEngine
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory,
		});
		registry.registerAdapter(adapter);

		const engine = new OrchestrationEngine({ registry });

		const sink = createMockEventSink();
		const result = await engine.dispatch({
			type: "send_turn",
			providerId: "claude",
			input: makeBaseSendTurnInput({
				sessionId: "e2e-session-1",
				turnId: "e2e-turn-1",
				prompt: "End-to-end wiring test",
				workspaceRoot: workspace,
				eventSink: sink,
			}),
		});

		// Result flows back through the full stack
		expect(result.status).toBe("completed");
		expect(result.cost).toBe(0.03);
		expect(result.tokens.input).toBe(100);
		expect(result.tokens.output).toBe(50);
		expect(result.providerStateUpdates).toBeDefined();

		// queryFactory was invoked once
		expect(queryFactory).toHaveBeenCalledTimes(1);

		// Session binding was established
		expect(engine.getProviderForSession("e2e-session-1")).toBe("claude");

		// EventSink received events (at minimum session.status + turn.completed)
		expect(sink.push).toHaveBeenCalled();
	});
});
