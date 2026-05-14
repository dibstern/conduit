// test/unit/relay/message-poller-effect.test.ts
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	isPollerActive,
	makePollerManagerStateLive,
	startPoller,
	stopPoller,
} from "../../../src/lib/domain/relay/Services/message-poller.js";

describe("MessagePoller Effect", () => {
	// Mock matches the real OpenCodeAPI shape: api.session.messages(sessionId)
	// but returns Effect-wrapped values for the Effect-based poller.
	const mockApi = {
		session: {
			messages: vi.fn().mockReturnValue(Promise.resolve([])),
		},
	};

	const testLayer = Layer.mergeAll(
		makePollerManagerStateLive(),
		Layer.succeed(OpenCodeAPITag, mockApi as unknown as OpenCodeAPITag["Type"]),
	);

	it.scoped("starts a poller for a session", () =>
		Effect.gen(function* () {
			yield* startPoller("s1");
			const result = yield* isPollerActive("s1");
			expect(result).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("replaces poller for same session (FiberMap auto-dedup)", () =>
		Effect.gen(function* () {
			yield* startPoller("s1");
			yield* startPoller("s1"); // FiberMap.run auto-interrupts previous
			const result = yield* isPollerActive("s1");
			expect(result).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("stops a poller by interrupting its fiber", () =>
		Effect.gen(function* () {
			yield* startPoller("s1");
			expect(yield* isPollerActive("s1")).toBe(true);
			yield* stopPoller("s1");
			const result = yield* isPollerActive("s1");
			expect(result).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});
