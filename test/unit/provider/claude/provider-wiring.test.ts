// test/unit/provider/claude/provider-wiring.test.ts

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

describe("Provider wiring with Claude provider instance", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-wiring-test-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("OrchestrationEngine dispatches discover to Claude provider instance", async () => {
		const registry = new ProviderRegistry();
		const models = [
			{ id: "wiring-model", name: "Wiring model", providerId: "claude" },
		];
		const getCapabilities = vi.fn(() =>
			Effect.succeed({ models, commands: [], agents: [] }),
		);
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: workspace,
			capabilitiesService: { get: getCapabilities },
		});
		registry.registerInstance(instance);

		const engine = new OrchestrationEngine({ registry });
		const caps = await Effect.runPromise(
			engine.dispatchEffect({
				type: "discover",
				providerId: "claude",
			}),
		);

		expect(getCapabilities).toHaveBeenCalledWith(workspace);
		expect(caps.models).toEqual(models);
		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsFork).toBe(true);
	});

	it("shutdownAllEffect shuts down Claude provider instance", async () => {
		const registry = new ProviderRegistry();
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: workspace,
		});
		registry.registerInstance(instance);

		// Should not throw
		await Effect.runPromise(registry.shutdownAllEffect());
	});

	it("end-to-end: dispatch sendTurn through full ProviderRegistry → ClaudeProviderInstance → mock SDK stack", async () => {
		const resultMsg = makeSuccessResult({ total_cost_usd: 0.03 } as Record<
			string,
			unknown
		>);
		const mockQuery = createMockQuery([resultMsg]);
		const queryFactory = vi.fn(() => mockQuery);

		// Wire up the full stack: ProviderRegistry + ClaudeProviderInstance + OrchestrationEngine
		const registry = new ProviderRegistry();
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory,
		});
		registry.registerInstance(instance);

		const engine = new OrchestrationEngine({ registry });

		const sink = createMockEventSink();
		const result = await Effect.runPromise(
			engine.dispatchEffect({
				type: "send_turn",
				commandId: "cmd-provider-wiring",
				providerId: "claude",
				input: makeBaseSendTurnInput({
					sessionId: "e2e-session-1",
					inputId: "e2e-turn-1",
					prompt: "End-to-end wiring test",
					workspaceRoot: workspace,
					model: { providerId: "claude", modelId: "sonnet" },
					eventSink: sink,
				}),
			}),
		);

		// Result flows back through the full stack
		expect(result.status).toBe("completed");
		expect(result.cost).toBe(0.03);
		expect(result.tokens.input).toBe(100);
		expect(result.tokens.output).toBe(50);
		expect(result.providerStateUpdates).toBeDefined();

		// queryFactory was invoked once
		expect(queryFactory).toHaveBeenCalledTimes(1);

		// Session binding was established
		expect(
			Effect.runSync(engine.getProviderForSessionEffect("e2e-session-1")),
		).toBe("claude");

		// EventSink received events (at minimum session.status + turn.completed)
		expect(sink.push).toHaveBeenCalled();
	});
});
