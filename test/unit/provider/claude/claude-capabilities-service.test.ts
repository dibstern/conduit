import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, TestClock } from "effect";
import { expect, vi } from "vitest";
import {
	__setProbeOverrideForTesting,
	resetCapabilityCacheForTesting,
} from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { makeClaudeCapabilitiesService } from "../../../../src/lib/provider/claude/claude-capabilities-service.js";

describe("ClaudeCapabilitiesService", () => {
	it.effect("caches per layer and expires with TestClock", () =>
		Effect.gen(function* () {
			resetCapabilityCacheForTesting();
			const probe = vi
				.fn()
				.mockResolvedValueOnce({
					models: [
						{ id: "claude-sonnet-1", name: "Sonnet 1", providerId: "claude" },
					],
					commands: [],
					agents: [],
				})
				.mockResolvedValueOnce({
					models: [
						{ id: "claude-sonnet-2", name: "Sonnet 2", providerId: "claude" },
					],
					commands: [],
					agents: [],
				});
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService();

			const first = yield* service.get("/tmp/workspace");
			yield* TestClock.adjust("4 minutes");
			const second = yield* service.get("/tmp/workspace");
			yield* TestClock.adjust("2 minutes");
			const third = yield* service.get("/tmp/workspace");

			expect(first.models[0]?.id).toBe("claude-sonnet-1");
			expect(second.models[0]?.id).toBe("claude-sonnet-1");
			expect(third.models[0]?.id).toBe("claude-sonnet-2");
			expect(probe).toHaveBeenCalledTimes(2);
			__setProbeOverrideForTesting(undefined);
			resetCapabilityCacheForTesting();
		}),
	);

	it.effect("dedupes concurrent probes inside one layer", () =>
		Effect.gen(function* () {
			resetCapabilityCacheForTesting();
			const release = yield* Deferred.make<void>();
			const probe = vi.fn(async () => {
				await Effect.runPromise(Deferred.await(release));
				return { models: [], commands: [], agents: [] };
			});
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService();

			const first = yield* Effect.fork(service.get("/tmp/workspace"));
			const second = yield* Effect.fork(service.get("/tmp/workspace"));
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(first);
			yield* Fiber.join(second);

			expect(probe).toHaveBeenCalledTimes(1);
			__setProbeOverrideForTesting(undefined);
			resetCapabilityCacheForTesting();
		}),
	);
});
