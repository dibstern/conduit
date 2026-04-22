// test/unit/provider/orchestration-wiring.test.ts
import { describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { createOrchestrationLayer } from "../../../src/lib/provider/orchestration-wiring.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";

function makeStubClient(): OpenCodeAPI {
	return {
		session: { abort: vi.fn(async () => {}), prompt: vi.fn(async () => {}) },
		permission: { reply: vi.fn(async () => {}), list: vi.fn(async () => []) },
		question: {
			reply: vi.fn(async () => {}),
			reject: vi.fn(async () => {}),
			list: vi.fn(async () => []),
		},
		provider: {
			list: vi.fn(async () => ({
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
		},
		app: {
			agents: vi.fn(async () => []),
			commands: vi.fn(async () => []),
			skills: vi.fn(async () => []),
		},
	} as unknown as OpenCodeAPI;
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

	// ─── wireSSEToAdapter ────────────────────────────────────────────────

	describe("wireSSEToAdapter", () => {
		it("calls notifyTurnCompleted when session.status idle event arrives", () => {
			const client = makeStubClient();
			const layer = createOrchestrationLayer({ client });

			const notifySpy = vi.spyOn(layer.adapter, "notifyTurnCompleted");

			// Capture the handler registered via sseOn
			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			const mockSseOn = (_event: "event", handler: Handler) => {
				handlers.push(handler);
			};
			layer.wireSSEToAdapter(mockSseOn);
			expect(handlers.length).toBe(1);

			// Fire a session.status idle event
			handlers[0]?.({
				type: "session.status",
				properties: {
					sessionID: "sess-123",
					status: { type: "idle" },
				},
			});

			expect(notifySpy).toHaveBeenCalledTimes(1);
			expect(notifySpy).toHaveBeenCalledWith(
				"sess-123",
				expect.objectContaining({ status: "completed" }),
			);
		});

		it("ignores non-session.status events", () => {
			const client = makeStubClient();
			const layer = createOrchestrationLayer({ client });
			const notifySpy = vi.spyOn(layer.adapter, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToAdapter((_event, handler) => {
				handlers.push(handler);
			});

			handlers[0]?.({
				type: "message.created",
				properties: { sessionID: "sess-123" },
			});

			expect(notifySpy).not.toHaveBeenCalled();
		});

		it("ignores session.status events with non-idle status", () => {
			const client = makeStubClient();
			const layer = createOrchestrationLayer({ client });
			const notifySpy = vi.spyOn(layer.adapter, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToAdapter((_event, handler) => {
				handlers.push(handler);
			});

			handlers[0]?.({
				type: "session.status",
				properties: {
					sessionID: "sess-123",
					status: { type: "busy" },
				},
			});

			expect(notifySpy).not.toHaveBeenCalled();
		});

		it("does nothing when sessionId is not present in event", () => {
			const client = makeStubClient();
			const layer = createOrchestrationLayer({ client });
			const notifySpy = vi.spyOn(layer.adapter, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToAdapter((_event, handler) => {
				handlers.push(handler);
			});

			// No sessionID in properties
			handlers[0]?.({
				type: "session.status",
				properties: {
					status: { type: "idle" },
				},
			});

			expect(notifySpy).not.toHaveBeenCalled();
		});

		it("falls back to event.sessionId when properties.sessionID is absent", () => {
			const client = makeStubClient();
			const layer = createOrchestrationLayer({ client });
			const notifySpy = vi.spyOn(layer.adapter, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToAdapter((_event, handler) => {
				handlers.push(handler);
			});

			handlers[0]?.({
				type: "session.status",
				sessionId: "sess-fallback",
				properties: {
					status: { type: "idle" },
				},
			});

			expect(notifySpy).toHaveBeenCalledWith(
				"sess-fallback",
				expect.objectContaining({ status: "completed" }),
			);
		});
	});
});
