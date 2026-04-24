// ─── Effect Dispatch Table Tests ────────────────────────────────────────────
// Verifies that dispatchMessageEffect correctly:
//   1. Schema-validates incoming payloads
//   2. Routes to the correct Effect handler
//   3. Rejects unknown message types with WebSocketError
//   4. Rejects malformed payloads with ParseError

import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketHandlerShape } from "../../../src/lib/effect/services.js";
import {
	LoggerTag,
	OpenCodeAPITag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { WebSocketError } from "../../../src/lib/errors.js";
import {
	dispatchMessageEffect,
	filterAgents,
} from "../../../src/lib/handlers/index.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { SessionOverrides } from "../../../src/lib/session/session-overrides.js";

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
		...overrides,
	};
}

function mockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

function mockOverrides(
	overrides?: Partial<SessionOverrides>,
): SessionOverrides {
	return {
		setAgent: vi.fn(),
		setModel: vi.fn(),
		setVariant: vi.fn(),
		getModel: vi.fn(),
		getVariant: vi.fn(),
		setDefaultModel: vi.fn(),
		defaultModel: undefined,
		defaultVariant: "",
		...overrides,
	} as unknown as SessionOverrides;
}

/**
 * Helper to run a dispatch effect with a provided layer.
 * dispatchMessageEffect returns Effect<void, any, any> because the handler
 * union erases specific R/E types. This helper casts through the `any` R
 * to satisfy exactOptionalPropertyTypes after Layer.provide.
 */
const runDispatch = (
	clientId: string,
	type: string,
	raw: unknown,
	// biome-ignore lint/suspicious/noExplicitAny: test helper — Layer type varies per test
	layer: Layer.Layer<any>,
) =>
	Effect.runPromise(
		(
			dispatchMessageEffect(clientId, type, raw) as Effect.Effect<void, never>
		).pipe(Effect.provide(layer)),
	);

// ─── Dispatch routing ───────────────────────────────────────────────────────

describe("dispatchMessageEffect", () => {
	it("dispatches get_agents through Schema validation to the correct handler", async () => {
		const ws = mockWsHandler();
		const mockAgents = [
			{ name: "build", id: "build", mode: "primary" as const },
			{ name: "title", id: "title", mode: "subagent" as const, hidden: true },
		];
		const client = {
			app: { agents: vi.fn(async () => mockAgents) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		await runDispatch("client-1", "get_agents", {}, layer);

		expect(client.app.agents).toHaveBeenCalledOnce();
		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			agents: filterAgents(mockAgents),
		});
	});

	it("dispatches switch_agent with validated payload", async () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		await runDispatch("client-1", "switch_agent", { agentId: "plan" }, layer);

		expect(overrides.setAgent).toHaveBeenCalledWith("session-42", "plan");
	});

	// ─── Unknown message type ──────────────────────────────────────────────

	it("fails with WebSocketError for unknown message types", async () => {
		const effect = dispatchMessageEffect(
			"client-1",
			"totally_unknown_type",
			{},
		).pipe(Effect.either) as Effect.Effect<
			import("effect").Either.Either<void, WebSocketError>
		>;

		const result = await Effect.runPromise(effect);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left).toBeInstanceOf(WebSocketError);
			expect((result.left as WebSocketError).message).toContain(
				"Unknown message type: totally_unknown_type",
			);
		}
	});

	// ─── Schema validation ─────────────────────────────────────────────────

	it("fails with ParseError when payload is malformed", async () => {
		// switch_agent requires { agentId: string } — passing a number should fail
		const effect = dispatchMessageEffect("client-1", "switch_agent", {
			agentId: 42, // wrong type — should be string
		}).pipe(Effect.either) as Effect.Effect<
			import("effect").Either.Either<void, unknown>
		>;

		const result = await Effect.runPromise(effect);
		expect(result._tag).toBe("Left");
	});

	it("fails with ParseError when required fields are missing", async () => {
		// switch_model requires { modelId: string, providerId: string }
		const effect = dispatchMessageEffect("client-1", "switch_model", {
			modelId: "gpt-4",
			// missing providerId
		}).pipe(Effect.either) as Effect.Effect<
			import("effect").Either.Either<void, unknown>
		>;

		const result = await Effect.runPromise(effect);
		expect(result._tag).toBe("Left");
	});

	it("accepts valid payloads with optional fields omitted", async () => {
		const ws = mockWsHandler();
		const client = {
			app: { agents: vi.fn(async () => []) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		// get_agents expects {} — no required fields
		await runDispatch("client-1", "get_agents", {}, layer);

		// No error thrown = success
		expect(client.app.agents).toHaveBeenCalledOnce();
	});

	it("accepts payloads with extra unknown fields (open schema)", async () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		// Schema.Struct allows extra keys by default
		await runDispatch(
			"client-1",
			"switch_agent",
			{ agentId: "plan", extraField: "should be ignored" },
			layer,
		);

		expect(overrides.setAgent).toHaveBeenCalledWith("session-1", "plan");
	});
});
