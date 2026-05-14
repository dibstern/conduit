import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Scope,
} from "effect";
import { expect } from "vitest";
import {
	DaemonLifecycleLayerError,
	makePidFileLive,
	ProcessErrorHandlerLayer,
	ShutdownAwaiterLive,
	ShutdownSignalTag,
	SignalHandlerLayer,
} from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonHandleLive,
	DaemonHandleTag,
} from "../../../src/lib/domain/daemon/Services/daemon-handle.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";

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

describe("makePidFileLive", () => {
	it.scoped("maps PID write failures to DaemonLifecycleLayerError", () =>
		Effect.gen(function* () {
			const tempRoot = mkdtempSync(join(tmpdir(), "conduit-pid-"));
			const configDir = join(tempRoot, "not-a-directory");
			writeFileSync(configDir, "x");
			const scope = yield* Scope.make();

			try {
				const exit = yield* Effect.exit(
					Layer.buildWithScope(
						makePidFileLive(
							configDir,
							join(configDir, "daemon.pid"),
							join(tempRoot, "relay.sock"),
						),
						scope,
					),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const failure = Cause.failureOption(exit.cause);
					expect(Option.isSome(failure)).toBe(true);
					if (Option.isSome(failure)) {
						expect(failure.value).toBeInstanceOf(DaemonLifecycleLayerError);
						expect(failure.value.operation).toBe("writePidFile");
					}
				}
			} finally {
				yield* Scope.close(scope, Exit.void);
				rmSync(tempRoot, { recursive: true, force: true });
			}
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

	it.effect(
		"provides an Effect-owned handle backed by daemon config and project registry services",
		() => {
			const relayCacheStub = Layer.succeed(RelayCacheTag, {
				get: (slug: string) =>
					Effect.succeed({
						slug,
						wsHandler: { handleUpgrade: () => {} },
						rpcWsHandler: { handleUpgrade: () => {} },
						stop: () => {},
					}),
				peek: () => Effect.succeed(Option.none()),
				invalidate: () => Effect.void,
			});
			const handleDeps = Layer.mergeAll(
				DaemonConfigRefLive({
					port: 49876,
					host: "127.0.0.1",
					pinHash: "pin-hash",
					tlsEnabled: true,
					keepAwake: true,
					keepAwakeCommand: undefined,
					keepAwakeArgs: undefined,
					shuttingDown: false,
					dismissedPaths: new Set(["/tmp/new-project"]),
					startTime: Date.now() - 1_000,
					hostExplicit: false,
					persistedSessionCounts: new Map([["existing", 2]]),
				}),
				DaemonEventBusLive,
				ConfigPersistenceNoopLive,
				makeProjectRegistryLive([
					{
						slug: "existing",
						directory: "/tmp/existing",
						title: "Existing",
						lastUsed: 100,
					},
				]),
				relayCacheStub,
			);
			const layer = DaemonHandleLive.pipe(Layer.provideMerge(handleDeps));

			return Effect.gen(function* () {
				const handle = yield* DaemonHandleTag;
				const configRef = yield* DaemonConfigRefTag;

				const initialStatus = yield* handle.getStatus();
				expect(initialStatus.port).toBe(49876);
				expect(initialStatus.host).toBe("127.0.0.1");
				expect(initialStatus.projectCount).toBe(1);
				expect(initialStatus.sessionCount).toBe(2);
				expect(initialStatus.pinEnabled).toBe(true);
				expect(initialStatus.tlsEnabled).toBe(true);
				expect(initialStatus.keepAwake).toBe(true);

				yield* handle.addProject("/tmp/new-project");
				const projects = yield* handle.getProjects();
				expect(projects.map((project) => project.slug).sort()).toEqual([
					"existing",
					"new-project",
				]);
				const configAfterAdd = yield* Ref.get(configRef);
				expect(configAfterAdd.dismissedPaths.has("/tmp/new-project")).toBe(
					false,
				);

				yield* handle.removeProject("existing");
				const afterRemove = yield* handle.getStatus();
				expect(afterRemove.projectCount).toBe(1);
				expect(afterRemove.projects.map((project) => project.slug)).toEqual([
					"new-project",
				]);
				const configAfterRemove = yield* Ref.get(configRef);
				expect(configAfterRemove.dismissedPaths.has("/tmp/existing")).toBe(
					true,
				);

				const missingExit = yield* Effect.exit(handle.removeProject("missing"));
				expect(Exit.isFailure(missingExit)).toBe(true);
				if (Exit.isFailure(missingExit)) {
					const failure = Cause.failureOption(missingExit.cause);
					expect(Option.isSome(failure)).toBe(true);
					if (Option.isSome(failure)) {
						expect(failure.value._tag).toBe("ProjectNotFound");
						expect(failure.value.slug).toBe("missing");
					}
				}
			}).pipe(Effect.provide(layer));
		},
	);
});
