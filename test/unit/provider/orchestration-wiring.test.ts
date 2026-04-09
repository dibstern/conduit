// test/unit/provider/orchestration-wiring.test.ts
import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { createOrchestrationLayer } from "../../../src/lib/provider/orchestration-wiring.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";

function makeStubClient(): OpenCodeClient {
	return {
		abortSession: vi.fn(async () => {}),
		replyPermission: vi.fn(async () => {}),
		replyQuestion: vi.fn(async () => {}),
		sendMessageAsync: vi.fn(async () => {}),
		listProviders: vi.fn(async () => ({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-sonnet",
							name: "Claude Sonnet",
							limit: { context: 200000, output: 8192 },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		})),
		listAgents: vi.fn(async () => []),
		listCommands: vi.fn(async () => []),
		listSkills: vi.fn(async () => []),
	} as unknown as OpenCodeClient;
}

describe("Orchestration wiring", () => {
	it("createOrchestrationLayer returns engine, registry, and adapter", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		expect(layer.engine).toBeInstanceOf(OrchestrationEngine);
		expect(layer.registry).toBeInstanceOf(ProviderRegistry);
		expect(layer.adapter).toBeInstanceOf(OpenCodeAdapter);
	});

	it("registry has opencode adapter registered", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		expect(layer.registry.hasAdapter("opencode")).toBe(true);
	});

	it("engine can discover opencode capabilities", async () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		const caps = await layer.engine.dispatch({
			type: "discover",
			providerId: "opencode",
		});

		expect(caps).toMatchObject({ supportsTools: true });
	});

	it("shutdown cleans up all components", async () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		// Should not throw
		await layer.engine.shutdown();
	});

	it("accepts optional workspace root", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({
			client,
			workspaceRoot: "/my/project",
		});

		expect(layer.adapter).toBeInstanceOf(OpenCodeAdapter);
	});
});
