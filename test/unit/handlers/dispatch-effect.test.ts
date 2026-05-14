// ─── Effect Dispatch Table Tests ────────────────────────────────────────────
// Verifies that dispatchMessageEffect correctly:
//   1. Schema-validates incoming payloads
//   2. Routes to the correct Effect handler
//   3. Rejects unknown message types with WebSocketError
//   4. Rejects malformed payloads with ParseError

import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import type { WebSocketHandlerShape } from "../../../src/lib/domain/relay/Services/services.js";
import { WebSocketError } from "../../../src/lib/errors.js";
import { dispatchMessageEffect } from "../../../src/lib/handlers/index.js";
import {
	clearSessionInputDraft,
	getSessionInputDraft,
} from "../../../src/lib/handlers/prompt.js";
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

// ─── Dispatch routing ───────────────────────────────────────────────────────

describe("dispatchMessageEffect", () => {
	it.effect("dispatches input_sync with validated payload", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
			getClientsForSession: vi.fn(() => ["client-1"]),
		});
		const layer = makeTestHandlerLayer({ wsHandler: ws });

		clearSessionInputDraft("session-42");
		return Effect.gen(function* () {
			yield* dispatchMessageEffect("client-1", "input_sync", {
				text: "hello",
			}) as Effect.Effect<void, never>;
			expect(getSessionInputDraft("session-42")).toBe("hello");
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
		// input_sync requires { text: string } — passing a number should fail
		const effect = dispatchMessageEffect("client-1", "input_sync", {
			text: 42,
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
		const effect = dispatchMessageEffect("client-1", "input_sync", {
			// missing text
		}).pipe(Effect.either) as Effect.Effect<
			import("effect").Either.Either<void, unknown>
		>;

		return effect.pipe(
			Effect.tap((result) => {
				expect(result._tag).toBe("Left");
			}),
		);
	});

	it.effect("accepts payloads with extra unknown fields (open schema)", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => ["client-1"]),
		});
		const layer = makeTestHandlerLayer({ wsHandler: ws });

		// Schema.Struct allows extra keys by default
		clearSessionInputDraft("session-1");
		return Effect.gen(function* () {
			yield* dispatchMessageEffect("client-1", "input_sync", {
				text: "draft",
				extraField: "should be ignored",
			}) as Effect.Effect<void, never>;
			expect(getSessionInputDraft("session-1")).toBe("draft");
		}).pipe(Effect.provide(layer));
	});
});
