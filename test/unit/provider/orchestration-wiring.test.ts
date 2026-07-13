// test/unit/provider/orchestration-wiring.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import {
	OpenCodeDriver,
	OpenCodeProviderInstance,
} from "../../../src/lib/provider/opencode-provider-instance.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	createOrchestrationLayer,
	getOrchestrationLayer,
	makeOrchestrationRuntimeLayer,
} from "../../../src/lib/provider/orchestration-wiring.js";
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

function seedProjectedSessionBinding(
	dbPath: string,
	sessionId: string,
	providerId: string,
): void {
	const now = 1_735_689_600_000;
	const db = SqliteClient.open(dbPath);
	db.execute(
		"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		[sessionId, providerId, "Persisted session", "idle", now, now],
	);
	db.execute(
		"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
		[`${sessionId}:initial`, sessionId, providerId, now],
	);
	db.close();
}

describe("Orchestration wiring", () => {
	it("createOrchestrationLayer returns engine, registry, and OpenCode instance", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		expect(layer.engine).toBeInstanceOf(OrchestrationEngine);
		expect(layer.registry).toBeInstanceOf(ProviderRegistry);
		expect(layer.openCodeInstance).toBeInstanceOf(OpenCodeProviderInstance);
	});

	it("registry has opencode provider instance registered", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		expect(layer.registry.hasInstance("opencode")).toBe(true);
	});

	it("exposes orchestration services through the scoped runtime layer", async () => {
		const client = makeStubClient();
		const runtime = ManagedRuntime.make(
			makeOrchestrationRuntimeLayer().pipe(
				Layer.provide(Layer.succeed(OpenCodeAPITag, client)),
			),
		);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);

			expect(layer.engine).toBeInstanceOf(OrchestrationEngine);
			expect(layer.registry).toBeInstanceOf(ProviderRegistry);
			expect(layer.registry.hasInstance("opencode")).toBe(true);
			expect(layer.registry.hasInstance("claude")).toBe(true);
		} finally {
			await runtime.dispose();
		}
	});

	it("wires persisted session bindings into the scoped runtime layer", async () => {
		const client = makeStubClient();
		const tempDir = mkdtempSync(join(tmpdir(), "conduit-orchestration-"));
		const dbPath = join(tempDir, "events.db");
		const runtime = ManagedRuntime.make(
			makeOrchestrationRuntimeLayer({ persistenceDbPath: dbPath }).pipe(
				Layer.provide(
					Layer.merge(
						Layer.succeed(OpenCodeAPITag, client),
						makePersistenceEffectLayer(dbPath),
					),
				),
			),
		);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);
			seedProjectedSessionBinding(dbPath, "persisted-session", "claude");

			expect(layer.engine.getProviderForSession("persisted-session")).toBe(
				"claude",
			);
		} finally {
			await runtime.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("creates provider instances through plain drivers", async () => {
		const client = makeStubClient();
		const instance = await Effect.runPromise(
			OpenCodeDriver.create({ client }).pipe(Effect.scoped),
		);

		expect(OpenCodeDriver.providerId).toBe("opencode");
		expect(instance).toBeInstanceOf(OpenCodeProviderInstance);
	});

	it("engine can discover opencode capabilities", async () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		const caps = await Effect.runPromise(
			layer.engine.dispatchEffect({
				type: "discover",
				providerId: "opencode",
			}),
		);

		expect(caps).toMatchObject({ supportsTools: true });
	});

	it("shutdown cleans up all components", async () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		// Should not throw
		await Effect.runPromise(layer.engine.shutdownEffect());
	});

	it("accepts optional workspace root", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({
			client,
			workspaceRoot: "/my/project",
		});

		expect(layer.openCodeInstance).toBeInstanceOf(OpenCodeProviderInstance);
	});

	// ─── wireSSEToInstance ────────────────────────────────────────────────

	describe("wireSSEToInstance", () => {
		it("calls notifyTurnCompleted when session.status idle event arrives", () => {
			const client = makeStubClient();
			const layer = createOrchestrationLayer({ client });

			const notifySpy = vi.spyOn(layer.openCodeInstance, "notifyTurnCompleted");

			// Capture the handler registered via sseOn
			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			const mockSseOn = (_event: "event", handler: Handler) => {
				handlers.push(handler);
			};
			layer.wireSSEToInstance(mockSseOn);
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
			const notifySpy = vi.spyOn(layer.openCodeInstance, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToInstance((_event, handler) => {
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
			const notifySpy = vi.spyOn(layer.openCodeInstance, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToInstance((_event, handler) => {
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
			const notifySpy = vi.spyOn(layer.openCodeInstance, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToInstance((_event, handler) => {
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
			const notifySpy = vi.spyOn(layer.openCodeInstance, "notifyTurnCompleted");

			type Handler = (e: unknown) => void;
			const handlers: Handler[] = [];
			layer.wireSSEToInstance((_event, handler) => {
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
