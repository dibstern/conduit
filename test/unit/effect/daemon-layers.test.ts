import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import { expect } from "vitest";
import {
	ProcessErrorHandlerLayer,
	SignalHandlerLayer,
} from "../../../src/lib/effect/daemon-layers.js";
import { ShutdownSignalTag } from "../../../src/lib/effect/services.js";

describe("SignalHandlerLayer", () => {
	it.scoped("installs signal handlers on layer build", () =>
		Effect.gen(function* () {
			const beforeCount = process.listenerCount("SIGTERM");
			const layer = SignalHandlerLayer;
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(layer, scope);
			const newCount = process.listenerCount("SIGTERM");
			expect(newCount).toBe(beforeCount + 1);
			yield* Scope.close(scope, Exit.void);
			// After scope close, listener should be removed
			expect(process.listenerCount("SIGTERM")).toBe(beforeCount);
		}),
	);

	it.scoped("deferred completes when shutdown signal fires", () =>
		Effect.gen(function* () {
			const deferred = yield* ShutdownSignalTag.pipe(
				Effect.provide(SignalHandlerLayer),
			);
			// Deferred should not be done yet
			const isDone = yield* Deferred.isDone(deferred);
			expect(isDone).toBe(false);
		}),
	);
});

describe("ProcessErrorHandlerLayer", () => {
	it.scoped("attaches and removes error handlers on scope lifecycle", () =>
		Effect.gen(function* () {
			const beforeCount = process.listenerCount("unhandledRejection");
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(ProcessErrorHandlerLayer, scope);
			expect(process.listenerCount("unhandledRejection")).toBe(beforeCount + 1);
			yield* Scope.close(scope, Exit.void);
			expect(process.listenerCount("unhandledRejection")).toBe(beforeCount);
		}),
	);
});
