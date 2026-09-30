// test/unit/provider/orchestration-wiring.test.ts
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { OpenCodeInstanceClientsLive } from "../../../src/lib/domain/relay/Services/opencode-instance-clients.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	OpenCodeDriver,
	OpenCodeProviderInstance,
} from "../../../src/lib/provider/opencode-provider-instance.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	getOrchestrationLayer,
	makeOrchestrationRuntimeLayer,
	type OrchestrationLayerOptions,
} from "../../../src/lib/provider/orchestration-wiring.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";

function orchestrationDeps(
	persistence: ReturnType<typeof makePersistenceEffectLayer>,
	client: OpenCodeAPI,
) {
	const config = Layer.succeed(ConfigTag, makeMockConfig());
	const logger = Layer.succeed(LoggerTag, makeMockLogger());
	return Layer.mergeAll(
		Layer.succeed(OpenCodeAPITag, client),
		persistence,
		OpenCodeInstanceClientsLive.pipe(
			Layer.provide(Layer.merge(config, logger)),
		),
		makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
	);
}

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

function seedProjectedSessionBinding(sessionId: string, providerId: string) {
	const now = 1_735_689_600_000;
	return Effect.flatMap(SqlClient.SqlClient, (sql) =>
		Effect.all([
			sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (${sessionId}, ${providerId}, ${"Persisted session"}, ${"idle"}, ${now}, ${now})`,
			sql`INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (${`${sessionId}:initial`}, ${sessionId}, ${providerId}, 'active', ${now})`,
		]),
	);
}

/**
 * Mirrors relay-stack: the same persistence layer reference is provided to
 * orchestration and merged into the outer runtime. An in-memory SQLite
 * database is private to its connection, so a row seeded through the outer
 * SqlClient is visible to orchestration only when both share one connection.
 */
function makeSharedPersistenceRuntime(
	outerPersistence: (
		persistence: ReturnType<typeof makePersistenceEffectLayer>,
	) => ReturnType<typeof makePersistenceEffectLayer>,
) {
	const persistence = makePersistenceEffectLayer(":memory:");
	return ManagedRuntime.make(
		Layer.merge(
			makeOrchestrationRuntimeLayer().pipe(
				Layer.provide(orchestrationDeps(persistence, makeStubClient())),
			),
			outerPersistence(persistence),
		),
	);
}

async function makeScopedOrchestrationView(options: OrchestrationLayerOptions) {
	const persistence = makePersistenceEffectLayer(":memory:");
	const runtime = ManagedRuntime.make(
		makeOrchestrationRuntimeLayer(options).pipe(
			Layer.provide(orchestrationDeps(persistence, options.client)),
		),
	);
	onTestFinished(() => runtime.dispose());
	return runtime.runPromise(getOrchestrationLayer);
}

describe("Orchestration wiring", () => {
	it("scoped orchestration view returns engine, registry, and OpenCode instance", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({ client });

		expect(layer.engine).toBeInstanceOf(OrchestrationEngine);
		expect(layer.registry).toBeInstanceOf(ProviderRegistry);
		expect(layer.openCodeInstance).toBeInstanceOf(OpenCodeProviderInstance);
	});

	it("registry has opencode provider instance registered", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({ client });

		expect(layer.registry.hasInstance("opencode")).toBe(true);
	});

	it("exposes orchestration services through the scoped runtime layer", async () => {
		const client = makeStubClient();
		const persistence = makePersistenceEffectLayer(":memory:");
		const runtime = ManagedRuntime.make(
			makeOrchestrationRuntimeLayer().pipe(
				Layer.provide(orchestrationDeps(persistence, client)),
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

	it("shares the relay's single SqlClient connection with orchestration", async () => {
		const runtime = makeSharedPersistenceRuntime((persistence) => persistence);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);
			await runtime.runPromise(
				seedProjectedSessionBinding("persisted-session", "claude"),
			);

			expect(
				await runtime.runPromise(
					layer.engine.getProviderForSessionEffect("persisted-session"),
				),
			).toBe("claude");
		} finally {
			await runtime.dispose();
		}
	});

	it("detects a second connection (control for the shared-connection proof)", async () => {
		const runtime = makeSharedPersistenceRuntime(Layer.fresh);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);
			await runtime.runPromise(
				seedProjectedSessionBinding("persisted-session", "claude"),
			);

			expect(
				await runtime.runPromise(
					layer.engine.getProviderForSessionEffect("persisted-session"),
				),
			).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});

	it("exposes a reactor drain quiescence seam through the wired runtime layer", async () => {
		const runtime = makeSharedPersistenceRuntime((persistence) => persistence);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);
			// No committed side effects: the reactor reaches quiescence deterministically
			// (no sleeps), proving the drain seam is wired through the production path.
			await Effect.runPromise(layer.drainSideEffects());
		} finally {
			await runtime.dispose();
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
		const layer = await makeScopedOrchestrationView({ client });

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
		const layer = await makeScopedOrchestrationView({ client });

		// Should not throw
		await Effect.runPromise(layer.engine.shutdownEffect());
	});

	it("accepts optional workspace root", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({
			client,
			workspaceRoot: "/my/project",
		});

		expect(layer.openCodeInstance).toBeInstanceOf(OpenCodeProviderInstance);
	});

	// ─── wireSSEToInstance ────────────────────────────────────────────────

	describe("wireSSEToInstance", () => {
		it("calls notifyTurnCompleted when session.status idle event arrives", async () => {
			const client = makeStubClient();
			const layer = await makeScopedOrchestrationView({ client });

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

		it("ignores non-session.status events", async () => {
			const client = makeStubClient();
			const layer = await makeScopedOrchestrationView({ client });
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

		it("ignores session.status events with non-idle status", async () => {
			const client = makeStubClient();
			const layer = await makeScopedOrchestrationView({ client });
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

		it("does nothing when sessionId is not present in event", async () => {
			const client = makeStubClient();
			const layer = await makeScopedOrchestrationView({ client });
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

		it("falls back to event.sessionId when properties.sessionID is absent", async () => {
			const client = makeStubClient();
			const layer = await makeScopedOrchestrationView({ client });
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
