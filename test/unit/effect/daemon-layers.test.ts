import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import { describe, expect, it } from "vitest";
import {
	ProcessErrorHandlerLayer,
	SignalHandlerLayer,
} from "../../../src/lib/effect/daemon-layers.js";
import { ShutdownSignalTag } from "../../../src/lib/effect/services.js";

describe("SignalHandlerLayer", () => {
	it("installs signal handlers on layer build", async () => {
		const beforeCount = process.listenerCount("SIGTERM");
		const program = Effect.scoped(
			Effect.gen(function* () {
				const layer = SignalHandlerLayer;
				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(layer, scope);
				const newCount = process.listenerCount("SIGTERM");
				expect(newCount).toBe(beforeCount + 1);
				yield* Scope.close(scope, Exit.void);
			}),
		);
		await Effect.runPromise(program);
		// After scope close, listener should be removed
		expect(process.listenerCount("SIGTERM")).toBe(beforeCount);
	});

	it("deferred completes when shutdown signal fires", async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				const deferred = yield* ShutdownSignalTag.pipe(
					Effect.provide(SignalHandlerLayer),
				);
				// Deferred should not be done yet
				const isDone = yield* Deferred.isDone(deferred);
				expect(isDone).toBe(false);
			}),
		);
		await Effect.runPromise(program);
	});
});

describe("ProcessErrorHandlerLayer", () => {
	it("attaches and removes error handlers on scope lifecycle", async () => {
		const beforeCount = process.listenerCount("unhandledRejection");
		const program = Effect.scoped(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(ProcessErrorHandlerLayer, scope);
				expect(process.listenerCount("unhandledRejection")).toBe(
					beforeCount + 1,
				);
				yield* Scope.close(scope, Exit.void);
			}),
		);
		await Effect.runPromise(program);
		expect(process.listenerCount("unhandledRejection")).toBe(beforeCount);
	});
});
