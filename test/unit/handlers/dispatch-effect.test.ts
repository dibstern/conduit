// ─── Effect Dispatch Table Tests ────────────────────────────────────────────
// Verifies that dispatchMessageEffect correctly:
//   1. Schema-validates incoming payloads
//   2. Routes to the correct Effect handler
//   3. Rejects unknown message types with WebSocketError
//   4. Rejects malformed payloads with ParseError

import { describe, it } from "@effect/vitest";
import { Effect, type Layer } from "effect";
import { expect, vi } from "vitest";
import type { WebSocketHandlerShape } from "../../../src/lib/effect/services.js";
import { getAgent } from "../../../src/lib/effect/session-overrides-state.js";
import { WebSocketError } from "../../../src/lib/errors.js";
import {
	dispatchMessageEffect,
	filterAgents,
} from "../../../src/lib/handlers/index.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

// ─── Mock factories ────────────────────────────────────────────────────────

function mockWsHandler(
	overrides?: Partial<WebSocketHandlerShape>,
): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => undefined),
		getClientsForSession: vi.fn(() => []),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 0),
		getClientIds: vi.fn(() => []),
		handleUpgrade: vi.fn(),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
		...overrides,
	};
}

/**
 * Helper to create a dispatch effect with a provided layer.
 * dispatchMessageEffect returns Effect<void, any, any> because the handler
 * union erases specific R/E types. This helper casts through the `any` R
 * to satisfy exactOptionalPropertyTypes after Layer.provide.
 */
const makeDispatchEffect = (
	clientId: string,
	type: string,
	raw: unknown,
	// biome-ignore lint/suspicious/noExplicitAny: test helper — Layer type varies per test
	layer: Layer.Layer<any>,
) =>
	(
		dispatchMessageEffect(clientId, type, raw) as Effect.Effect<void, never>
	).pipe(Effect.provide(layer));

// ─── Dispatch routing ───────────────────────────────────────────────────────

describe("dispatchMessageEffect", () => {
	it.effect(
		"dispatches get_agents through Schema validation to the correct handler",
		() => {
			const ws = mockWsHandler();
			const mockAgents = [
				{ name: "build", id: "build", mode: "primary" as const },
				{ name: "title", id: "title", mode: "subagent" as const, hidden: true },
			];
			const client = {
				app: { agents: vi.fn(async () => mockAgents) },
			} as unknown as OpenCodeAPI;

			const layer = makeTestHandlerLayer({ api: client, wsHandler: ws });

			return makeDispatchEffect("client-1", "get_agents", {}, layer).pipe(
				Effect.tap(() => {
					expect(client.app.agents).toHaveBeenCalledOnce();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "agent_list",
						agents: filterAgents(mockAgents),
					});
				}),
			);
		},
	);

	it.effect("dispatches switch_agent with validated payload", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const layer = makeTestHandlerLayer({ wsHandler: ws });

		return Effect.gen(function* () {
			yield* dispatchMessageEffect("client-1", "switch_agent", {
				agentId: "plan",
			}) as Effect.Effect<void, never>;
			expect(yield* getAgent("session-42")).toBe("plan");
		}).pipe(Effect.provide(layer));
	});

	// ─── Unknown message type ──────────────────────────────────────────────

	it.effect("fails with WebSocketError for unknown message types", () => {
		const effect = dispatchMessageEffect(
			"client-1",
			"totally_unknown_type",
			{},
		).pipe(Effect.either) as Effect.Effect<
			import("effect").Either.Either<void, WebSocketError>
		>;

		return effect.pipe(
			Effect.tap((result) => {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left).toBeInstanceOf(WebSocketError);
					expect((result.left as WebSocketError).message).toContain(
						"Unknown message type: totally_unknown_type",
					);
				}
			}),
		);
	});

	// ─── Schema validation ─────────────────────────────────────────────────

	it.effect("fails with ParseError when payload is malformed", () => {
		// switch_agent requires { agentId: string } — passing a number should fail
		const effect = dispatchMessageEffect("client-1", "switch_agent", {
			agentId: 42, // wrong type — should be string
		}).pipe(Effect.either) as Effect.Effect<
			import("effect").Either.Either<void, unknown>
		>;

		return effect.pipe(
			Effect.tap((result) => {
				expect(result._tag).toBe("Left");
			}),
		);
	});

	it.effect("fails with ParseError when required fields are missing", () => {
		// switch_model requires { modelId: string, providerId: string }
		const effect = dispatchMessageEffect("client-1", "switch_model", {
			modelId: "gpt-4",
			// missing providerId
		}).pipe(Effect.either) as Effect.Effect<
			import("effect").Either.Either<void, unknown>
		>;

		return effect.pipe(
			Effect.tap((result) => {
				expect(result._tag).toBe("Left");
			}),
		);
	});

	it.effect("accepts valid payloads with optional fields omitted", () => {
		const ws = mockWsHandler();
		const client = {
			app: { agents: vi.fn(async () => []) },
		} as unknown as OpenCodeAPI;

		const layer = makeTestHandlerLayer({ api: client, wsHandler: ws });

		// get_agents expects {} — no required fields
		return makeDispatchEffect("client-1", "get_agents", {}, layer).pipe(
			Effect.tap(() => {
				// No error thrown = success
				expect(client.app.agents).toHaveBeenCalledOnce();
			}),
		);
	});

	it.effect("accepts payloads with extra unknown fields (open schema)", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const layer = makeTestHandlerLayer({ wsHandler: ws });

		// Schema.Struct allows extra keys by default
		return Effect.gen(function* () {
			yield* dispatchMessageEffect("client-1", "switch_agent", {
				agentId: "plan",
				extraField: "should be ignored",
			}) as Effect.Effect<void, never>;
			expect(yield* getAgent("session-1")).toBe("plan");
		}).pipe(Effect.provide(layer));
	});
});
