// ─── Effect Dispatch Table Tests ────────────────────────────────────────────
// Verifies that dispatchMessageEffect correctly:
//   1. Schema-validates incoming payloads
//   2. Routes to the correct Effect handler
//   3. Rejects unknown message types with WebSocketError
//   4. Rejects malformed payloads with ParseError

import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { WebSocketError } from "../../../src/lib/errors.js";
import { dispatchMessageEffect } from "../../../src/lib/handlers/index.js";
import {
	makeMockPtyManager,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

// ─── Dispatch routing ───────────────────────────────────────────────────────

describe("dispatchMessageEffect", () => {
	it.effect("dispatches pty_input with validated payload", () => {
		const ptyManager = makeMockPtyManager();
		const layer = makeTestHandlerLayer({ ptyManager });

		return Effect.gen(function* () {
			yield* dispatchMessageEffect("client-1", "pty_input", {
				ptyId: "pty-1",
				data: "ls\n",
			}) as Effect.Effect<void, never>;
			expect(ptyManager.sendInput).toHaveBeenCalledWith("pty-1", "ls\n");
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
		// pty_input requires { ptyId: string; data: string }.
		const effect = dispatchMessageEffect("client-1", "pty_input", {
			ptyId: 42,
			data: "ls\n",
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
		const effect = dispatchMessageEffect("client-1", "pty_input", {
			// missing data
			ptyId: "pty-1",
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
		const ptyManager = makeMockPtyManager();
		const layer = makeTestHandlerLayer({ ptyManager });

		// Schema.Struct allows extra keys by default
		return Effect.gen(function* () {
			yield* dispatchMessageEffect("client-1", "pty_input", {
				ptyId: "pty-1",
				data: "pwd\n",
				extraField: "should be ignored",
			}) as Effect.Effect<void, never>;
			expect(ptyManager.sendInput).toHaveBeenCalledWith("pty-1", "pwd\n");
		}).pipe(Effect.provide(layer));
	});
});
