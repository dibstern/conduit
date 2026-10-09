import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Layer, Option, Scope } from "effect";
import { afterEach, expect } from "vitest";
import {
	DaemonLifecycleLayerError,
	ProcessErrorHandlerLayer,
	ShutdownSignalTag,
	SignalHandlerLayer,
} from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { DaemonConfigRefLive } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonHandleLive,
	DaemonHandleTag,
} from "../../../src/lib/domain/daemon/Services/daemon-handle.js";
import {
	DaemonLifecycleContextTag,
	makeDaemonLifecycleContext,
} from "../../../src/lib/domain/daemon/Services/daemon-lifecycle-context.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";

const fixtureDirs: string[] = [];
afterEach(() => {
	for (const directory of fixtureDirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

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

	it.scoped("deferred completes with restart on SIGTERM", () =>
		Effect.gen(function* () {
			const deferred = yield* ShutdownSignalTag;
			const isDone = yield* Deferred.isDone(deferred);
			expect(isDone).toBe(false);
			yield* Effect.sync(() => process.emit("SIGTERM"));
			expect(yield* Deferred.await(deferred)).toBe("restart");
		}).pipe(Effect.provide(SignalHandlerLayer)),
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

describe("DaemonHandleTag", () => {
	it.effect("is a valid Context.Tag with identifier 'DaemonHandle'", () =>
		Effect.sync(() => {
			// DaemonHandleTag should be importable and have the correct key
			expect(DaemonHandleTag.key).toBe("DaemonHandle");
		}),
	);

	it.scoped(
		"provides an Effect-owned handle backed by daemon config and project registry services",
		() => {
			const configDir = mkdtempSync("/tmp/daemon-handle-");
			fixtureDirs.push(configDir);
			const projectDir = join(configDir, "new-project");
			mkdirSync(projectDir);
			const lifecycleContext = makeDaemonLifecycleContext("/tmp/relay.sock");
			lifecycleContext.clientCount = 7;
			const relayHealthBySlug = new Map([
				[
					"existing",
					{
						connected: true,
						lastEventAt: 101,
						reconnectCount: 1,
						stale: false,
					},
				],
				[
					"second",
					{
						connected: false,
						lastEventAt: 202,
						reconnectCount: 3,
						stale: false,
					},
				],
			]);
			const relayCacheStub = Layer.succeed(RelayCacheTag, {
				get: (slug: string) =>
					Effect.succeed({
						slug,
						attach: () => () => {},
						wsHandler: {},
						rpcWsHandler: {},
						syncGlobalSetting: () => Effect.void,
						refreshGlobalDefaults: () => Effect.void,
						getStatusSnapshot: () => ({
							sessionCount: slug === "existing" ? 5 : 4,
							clients: 0,
							isProcessing: false,
							sse: relayHealthBySlug.get(slug) ?? {
								connected: false,
								lastEventAt: null,
								reconnectCount: 0,
								stale: false,
							},
						}),
						stop: () => {},
					}),
				peek: (slug: string) => {
					const sse = relayHealthBySlug.get(slug);
					return sse === undefined
						? Effect.succeed(Option.none())
						: Effect.succeed(
								Option.some({
									slug,
									attach: () => () => {},
									wsHandler: {},
									rpcWsHandler: {},
									syncGlobalSetting: () => Effect.void,
									refreshGlobalDefaults: () => Effect.void,
									getStatusSnapshot: () => ({
										sessionCount: slug === "existing" ? 5 : 4,
										clients: 0,
										isProcessing: false,
										sse,
									}),
									stop: () => {},
								}),
							);
				},
				invalidate: () => Effect.void,
			});
			const handleDeps = Layer.mergeAll(
				makeDaemonStateLive({ configDir }),
				DaemonConfigRefLive({
					port: 49876,
					host: "127.0.0.1",
					pinHash: "pin-hash",
					tlsEnabled: true,
					keepAwake: true,
					keepAwakeCommand: undefined,
					keepAwakeArgs: undefined,
					claudeConfigDir: undefined,
					shuttingDown: false,
					startTime: Date.now() - 1_000,
					hostExplicit: false,
					persistedSessionCounts: new Map([["existing", 2]]),
				}),
				DaemonEventBusLive,
				ConfigPersistenceNoopLive,
				makeProjectRegistryLive([
					{
						slug: "existing",
						folders: ["/tmp/existing"],
						title: "Existing",
						lastUsed: 100,
					},
					{
						slug: "second",
						folders: ["/tmp/second"],
						title: "Second",
						lastUsed: 90,
					},
					{
						slug: "uncached",
						folders: ["/tmp/uncached"],
						title: "Uncached",
						lastUsed: 80,
					},
				]),
				relayCacheStub,
				Layer.succeed(DaemonLifecycleContextTag, lifecycleContext),
				makeInstanceManagerStateLive(undefined, [
					{
						id: "default",
						name: "Default",
						port: 4096,
						managed: false,
						url: "http://127.0.0.1:4096",
					},
				]),
			);
			const layer = DaemonHandleLive.pipe(Layer.provideMerge(handleDeps));

			return Effect.gen(function* () {
				const handle = yield* DaemonHandleTag;

				const initialStatus = yield* handle.getStatus();
				const initialOnboardingPort = yield* handle.onboardingPort;
				const instances = yield* handle.getInstances();
				expect(initialStatus.port).toBe(49876);
				expect(initialStatus.host).toBe("127.0.0.1");
				expect(initialStatus.projectCount).toBe(3);
				expect(initialStatus.sessionCount).toBe(9);
				expect(initialStatus.clientCount).toBe(7);
				expect(initialStatus.pinEnabled).toBe(true);
				expect(initialStatus.tlsEnabled).toBe(true);
				expect(initialStatus.keepAwake).toBe(true);
				expect(
					initialStatus.projects.find((project) => project.slug === "existing")
						?.sse,
				).toEqual(relayHealthBySlug.get("existing"));
				expect(
					initialStatus.projects.find((project) => project.slug === "second")
						?.sse,
				).toEqual(relayHealthBySlug.get("second"));
				expect(
					initialStatus.projects.find((project) => project.slug === "uncached"),
				).not.toHaveProperty("sse");
				expect(initialOnboardingPort).toBeNull();
				expect(instances.map((instance) => instance.id)).toEqual(["default"]);

				const added = yield* handle.saveProject({
					folders: [projectDir],
					instanceId: "default",
				});
				expect(added.project.slug).toBe("new-project");
				expect(added.project.instanceId).toBe("default");
				const projects = yield* handle.getProjects();
				expect(projects.map((project) => project.slug).sort()).toEqual([
					"existing",
					added.project.slug,
					"second",
					"uncached",
				]);

				yield* handle.removeProject("existing");
				const afterRemove = yield* handle.getStatus();
				expect(afterRemove.projectCount).toBe(3);
				expect(afterRemove.projects.map((project) => project.slug)).toEqual([
					"new-project",
					"second",
					"uncached",
				]);

				const missingExit = yield* Effect.exit(handle.removeProject("missing"));
				expect(Exit.isFailure(missingExit)).toBe(true);
				if (Exit.isFailure(missingExit)) {
					const failure = Cause.failureOption(missingExit.cause);
					expect(Option.isSome(failure)).toBe(true);
					if (Option.isSome(failure)) {
						expect(failure.value._tag).toBe("ProjectNotFound");
						if (failure.value._tag === "ProjectNotFound")
							expect(failure.value.slug).toBe("missing");
					}
				}
			}).pipe(Effect.provide(layer));
		},
	);
});
