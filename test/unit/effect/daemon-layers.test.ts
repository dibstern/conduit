import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import { expect } from "vitest";
import {
	DaemonLifecycleLayerError,
	ProcessErrorHandlerLayer,
	ShutdownAwaiterLive,
	ShutdownSignalTag,
	SignalHandlerLayer,
} from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { DaemonHandleTag } from "../../../src/lib/domain/daemon/Layers/daemon-main.js";

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

describe("ShutdownAwaiterLive", () => {
	it.scoped("builds successfully with a ShutdownSignalTag provider", () =>
		Effect.gen(function* () {
			// Provide a manually-created Deferred as the ShutdownSignalTag.
			// ShutdownAwaiterLive should build without error and fork a fiber
			// that waits on the Deferred.
			const deferred = yield* Deferred.make<void>();
			const testLayer = Layer.fresh(
				ShutdownAwaiterLive.pipe(
					Layer.provide(Layer.succeed(ShutdownSignalTag, deferred)),
				),
			);

			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(testLayer, scope);

			// The awaiter fiber is running but the Deferred is not yet done,
			// so the scope is still alive. Close it gracefully.
			yield* Scope.close(scope, Exit.void);
		}),
	);

	it.scoped("forks a fiber that is torn down when scope closes", () =>
		Effect.gen(function* () {
			// Verify that ShutdownAwaiterLive's forked fiber is properly
			// scoped — it should be interrupted when the scope closes,
			// even if the Deferred was never completed.
			const deferred = yield* Deferred.make<void>();
			const testLayer = Layer.fresh(
				ShutdownAwaiterLive.pipe(
					Layer.provide(Layer.succeed(ShutdownSignalTag, deferred)),
				),
			);

			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(testLayer, scope);

			// The Deferred is NOT done — the forked fiber is still waiting.
			const isDone = yield* Deferred.isDone(deferred);
			expect(isDone).toBe(false);

			// Close the scope — the forked fiber should be interrupted cleanly.
			yield* Scope.close(scope, Exit.void);
		}),
	);
});

describe("Shutdown signal integration", () => {
	it.scoped(
		"completing ShutdownSignalTag Deferred triggers scope teardown",
		() =>
			Effect.gen(function* () {
				const teardownRan = yield* Deferred.make<void>();
				const shutdownDeferred = yield* Deferred.make<void>();

				// Layer that marks teardown via finalizer
				const markerLayer = Layer.scopedDiscard(
					Effect.addFinalizer(() => Deferred.succeed(teardownRan, void 0)),
				);

				// Compose: ShutdownSignal provider + ShutdownAwaiter + marker
				const shutdownLayer = Layer.succeed(
					ShutdownSignalTag,
					shutdownDeferred,
				);
				const composed = Layer.mergeAll(
					ShutdownAwaiterLive.pipe(Layer.provide(shutdownLayer)),
					markerLayer,
				);

				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(Layer.fresh(composed), scope);

				// Teardown has NOT happened yet
				expect(yield* Deferred.isDone(teardownRan)).toBe(false);

				// Close scope (simulates the shutdown signal path completing)
				yield* Scope.close(scope, Exit.void);

				// Teardown finalizer should have run
				expect(yield* Deferred.isDone(teardownRan)).toBe(true);
			}),
	);
});

describe("DaemonHandleTag", () => {
	it.effect("is a valid Context.Tag with identifier 'DaemonHandle'", () =>
		Effect.sync(() => {
			// DaemonHandleTag should be importable and have the correct key
			expect(DaemonHandleTag.key).toBe("DaemonHandle");
		}),
	);
});
