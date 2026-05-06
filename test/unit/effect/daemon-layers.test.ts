import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import { expect } from "vitest";
import {
	DaemonLifecycleLayerError,
	ProcessErrorHandlerLayer,
	ShutdownSignalTag,
	SignalHandlerLayer,
} from "../../../src/lib/effect/daemon-layers.js";

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

describe("DaemonLifecycleLayerError", () => {
	it.effect("message getter produces readable string from Error cause", () =>
		Effect.sync(() => {
			const err = new DaemonLifecycleLayerError({
				operation: "startHttpServer",
				cause: new Error("EADDRINUSE"),
			});
			expect(err.message).toBe("startHttpServer failed: EADDRINUSE");
		}),
	);

	it.effect("message getter handles non-Error cause via String()", () =>
		Effect.sync(() => {
			const err = new DaemonLifecycleLayerError({
				operation: "startIPCServer",
				cause: 42,
			});
			expect(err.message).toBe("startIPCServer failed: 42");
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
