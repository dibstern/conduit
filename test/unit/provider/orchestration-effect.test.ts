// test/unit/provider/orchestration-effect.test.ts
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	makeIdempotencySetLive,
	type Provider,
	routeCommand,
} from "../../../src/lib/effect/orchestration-service.js";

describe("OrchestrationEngine Effect", () => {
	it.scoped("routes command to provider", () =>
		Effect.gen(function* () {
			const mockProvider: Provider = {
				execute: vi.fn().mockReturnValue(Effect.succeed({ text: "response" })),
			};
			const result = yield* routeCommand(
				{ id: "cmd-1", type: "send_turn", payload: "hello" },
				mockProvider,
			);
			expect(result).toEqual({ text: "response" });
			expect(mockProvider.execute).toHaveBeenCalled();
		}).pipe(Effect.provide(Layer.fresh(makeIdempotencySetLive()))),
	);

	it.scoped("deduplicates repeated command IDs", () =>
		Effect.gen(function* () {
			const mockProvider: Provider = {
				execute: vi.fn().mockReturnValue(Effect.succeed({ text: "response" })),
			};
			yield* routeCommand(
				{ id: "cmd-1", type: "send_turn", payload: "hello" },
				mockProvider,
			);
			const result = yield* routeCommand(
				{ id: "cmd-1", type: "send_turn", payload: "hello" },
				mockProvider,
			);
			expect(result).toEqual({ deduplicated: true });
			expect(mockProvider.execute).toHaveBeenCalledOnce();
		}).pipe(Effect.provide(Layer.fresh(makeIdempotencySetLive()))),
	);
});
