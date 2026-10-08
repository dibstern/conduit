// Failure modes: continuous requests postpone saves indefinitely, a burst writes
// more than once, a flush uses stale state, failure/shutdown loses dirty state,
// or cancellation releases the lock before an uncancellable write finishes.
import { describe, expect, it } from "@effect/vitest";
import {
	Context,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Scope,
	TestClock,
} from "effect";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	buildDaemonConfigSnapshot,
	ConfigPersistenceLive,
	ConfigPersistenceNoopLive,
	ConfigPersistenceTag,
	ConfigSnapshotFromEffectStateLive,
	ConfigSnapshotTag,
	ConfigWriterTag,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addInstance,
	makeInstanceManagerStateLive,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	addWithoutRelay,
	makeProjectRegistryLive,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";

describe("ConfigPersistenceLive", () => {
	const defaults: DaemonRuntimeConfig = {
		port: 2633,
		host: "127.0.0.1",
		pinHash: null,
		tlsEnabled: false,
		keepAwake: false,
		keepAwakeCommand: undefined,
		keepAwakeArgs: undefined,
		claudeConfigDir: undefined,
		shuttingDown: false,
		startTime: Date.now(),
		hostExplicit: false,
		persistedSessionCounts: new Map(),
	};

	const makeTestLayer = () => {
		const writes: DaemonConfig[] = [];
		const writerLayer = Layer.succeed(ConfigWriterTag, {
			write: (config: DaemonConfig) =>
				Effect.sync(() => {
					writes.push(config);
				}),
		});
		const stateDeps = Layer.mergeAll(
			DaemonConfigRefLive(defaults),
			writerLayer,
			makeProjectRegistryLive(),
			makeInstanceManagerStateLive(),
		);
		const deps = ConfigSnapshotFromEffectStateLive.pipe(
			Layer.provideMerge(stateDeps),
		);
		const layer = ConfigPersistenceLive.pipe(Layer.provideMerge(deps));
		return { layer, writes };
	};

	it.scoped("writes config to disk after explicit save request", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			yield* persistence.requestSave;
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBeGreaterThanOrEqual(1);
		}),
	);

	it.scoped("flushes a pending explicit save request when scope closes", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const scope = yield* Scope.make();
			const ctx = yield* Layer.buildWithScope(Layer.fresh(layer), scope);
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			const configRef = Context.get(ctx, DaemonConfigRefTag);

			yield* Ref.update(configRef, (c) => ({ ...c, port: 7777 }));
			yield* persistence.requestSave;
			yield* Scope.close(scope, Exit.void);

			expect(writes.length).toBe(1);
			expect(writes[0]?.port).toBe(7777);
		}),
	);

	it.scoped("persists claudeConfigDir when set, omits it when unset", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const scope = yield* Scope.make();
			const ctx = yield* Layer.buildWithScope(Layer.fresh(layer), scope);
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			const configRef = Context.get(ctx, DaemonConfigRefTag);

			yield* persistence.requestSave;
			yield* persistence.flush;
			yield* Ref.update(configRef, (c) => ({
				...c,
				claudeConfigDir: "/home/user/.ccs/instances/personal",
			}));
			yield* persistence.requestSave;
			yield* Scope.close(scope, Exit.void);

			expect(writes.length).toBe(2);
			expect("claudeConfigDir" in (writes[0] ?? {})).toBe(false);
			expect(writes[1]?.claudeConfigDir).toBe(
				"/home/user/.ccs/instances/personal",
			);
		}),
	);

	it.scoped("writes within 500 ms despite requests every 100 ms", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			const configRef = Context.get(ctx, DaemonConfigRefTag);
			yield* persistence.requestSave;
			yield* TestClock.adjust(Duration.zero);
			for (let i = 1; i <= 4; i++) {
				yield* TestClock.adjust(Duration.millis(100));
				yield* Ref.update(configRef, (config) => ({
					...config,
					port: 8000 + i,
				}));
				yield* persistence.requestSave;
			}
			yield* TestClock.adjust(Duration.millis(99));
			expect(writes).toHaveLength(0);
			yield* TestClock.adjust(Duration.millis(1));
			expect(writes).toHaveLength(1);
			expect(writes[0]?.port).toBe(8004);
		}),
	);

	it.scoped("coalesces a burst into one write at the end of the window", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			yield* persistence.requestSave;
			yield* TestClock.adjust(Duration.zero);
			for (let i = 0; i < 5; i++) {
				yield* persistence.requestSave;
			}
			yield* TestClock.adjust(Duration.millis(499));
			expect(writes).toHaveLength(0);
			yield* TestClock.adjust(Duration.millis(1));
			expect(writes).toHaveLength(1);
			yield* TestClock.adjust(Duration.millis(500));
			expect(writes).toHaveLength(1);
		}),
	);

	it.scoped("does not write without a save request", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			yield* Layer.build(Layer.fresh(layer));
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBe(0);
		}),
	);

	it.scoped(
		"keeps an interrupted write locked until the disk operation ends",
		() =>
			Effect.gen(function* () {
				const writes: DaemonConfig[] = [];
				const pendingWrites: { complete: () => void }[] = [];
				const stateDeps = Layer.mergeAll(
					DaemonConfigRefLive(defaults),
					makeProjectRegistryLive(),
					makeInstanceManagerStateLive(),
					Layer.succeed(ConfigWriterTag, {
						// Like a filesystem Promise, the operation can finish even if
						// the waiting fiber has been interrupted.
						write: (config) =>
							Effect.async<void>((resume) => {
								pendingWrites.push({
									complete: () => {
										writes.push(config);
										resume(Effect.void);
									},
								});
							}),
					}),
				);
				const context = yield* Layer.build(
					ConfigPersistenceLive.pipe(
						Layer.provideMerge(
							ConfigSnapshotFromEffectStateLive.pipe(
								Layer.provideMerge(stateDeps),
							),
						),
					),
				);
				const persistence = Context.get(context, ConfigPersistenceTag);
				const configRef = Context.get(context, DaemonConfigRefTag);
				yield* persistence.requestSave;
				const firstSave = yield* Effect.fork(persistence.flush);
				yield* TestClock.adjust(Duration.zero);
				expect(pendingWrites).toHaveLength(1);
				const interruption = yield* Effect.fork(Fiber.interrupt(firstSave));
				yield* Ref.update(configRef, (config) => ({ ...config, port: 7777 }));
				yield* persistence.requestSave;
				const secondSave = yield* Effect.fork(persistence.flush);
				yield* TestClock.adjust(Duration.zero);
				const writesBeforeCompletion = pendingWrites.length;

				yield* Effect.sync(() => pendingWrites[0]?.complete());
				yield* TestClock.adjust(Duration.zero);
				yield* Effect.sync(() => pendingWrites[1]?.complete());
				yield* Fiber.join(secondSave);
				yield* Fiber.join(interruption);
				expect(writesBeforeCompletion).toBe(1);
				expect(pendingWrites).toHaveLength(2);
				expect(writes.map((config) => config.port)).toEqual([
					defaults.port,
					7777,
				]);
			}),
	);

	it.scoped("writes reflect current config state at time of flush", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			const configRef = Context.get(ctx, DaemonConfigRefTag);
			yield* Ref.update(configRef, (c) => ({ ...c, port: 9999 }));
			yield* persistence.requestSave;
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBe(1);
			expect(writes[0]?.port).toBe(9999);
		}),
	);

	it.scoped(
		"builds full daemon config from runtime, project, and instance state",
		() =>
			Effect.gen(function* () {
				const deps = Layer.mergeAll(
					DaemonConfigRefLive({
						...defaults,
						port: 4567,
						pinHash: "pin-hash",
						tlsEnabled: true,
						keepAwake: true,
						keepAwakeCommand: "caffeinate",
						keepAwakeArgs: ["-dims"],
						persistedSessionCounts: new Map([["alpha", 3]]),
					}),
					DaemonEventBusLive,
					makeProjectRegistryLive(),
					makeInstanceManagerStateLive(),
					ConfigPersistenceNoopLive,
				);

				const config = yield* Effect.gen(function* () {
					yield* addWithoutRelay(
						{
							slug: "alpha",
							folders: ["/tmp/alpha"],
							title: "Alpha",
							lastUsed: 1700000000000,
							instanceId: "remote-1",
						},
						{ silent: true },
					);
					yield* addInstance({
						id: "remote-1",
						name: "Remote",
						port: 4096,
						managed: false,
						url: "https://opencode.example.test",
					});
					return yield* buildDaemonConfigSnapshot;
				}).pipe(Effect.provide(Layer.fresh(deps)));

				expect(config).toMatchObject({
					pid: process.pid,
					port: 4567,
					pinHash: "pin-hash",
					tls: true,
					debug: false,
					keepAwake: true,
					keepAwakeCommand: "caffeinate",
					keepAwakeArgs: ["-dims"],
					dangerouslySkipPermissions: false,
					projects: [
						{
							path: "/tmp/alpha",
							folders: ["/tmp/alpha"],
							slug: "alpha",
							title: "Alpha",
							addedAt: 1700000000000,
							instanceId: "remote-1",
							sessionCount: 3,
						},
					],
					instances: [
						{
							id: "remote-1",
							name: "Remote",
							port: 4096,
							managed: false,
							url: "https://opencode.example.test",
						},
					],
				});
			}),
	);

	it.scoped("100+ rapid save requests coalesced to exactly 1 write", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			for (let i = 0; i < 120; i++) {
				yield* persistence.requestSave;
			}
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBe(1);
		}),
	);

	it.scoped("writer failure does not crash the persistence loop", () =>
		Effect.gen(function* () {
			const failingWriterLayer = Layer.succeed(ConfigWriterTag, {
				write: (_config: DaemonConfig) => Effect.fail(new Error("disk full")),
			});
			const stateDeps = Layer.mergeAll(
				DaemonConfigRefLive(defaults),
				failingWriterLayer,
				makeProjectRegistryLive(),
				makeInstanceManagerStateLive(),
			);
			const deps = ConfigSnapshotFromEffectStateLive.pipe(
				Layer.provideMerge(stateDeps),
			);
			const layer = ConfigPersistenceLive.pipe(Layer.provideMerge(deps));
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			yield* persistence.requestSave;
			yield* TestClock.adjust(Duration.millis(600));
			// Test passes if no crash — persistence loop survived the error
			yield* persistence.requestSave;
			yield* TestClock.adjust(Duration.millis(600));
			// Still alive after second attempt
		}),
	);

	it.scoped("snapshot failure keeps pending save dirty for manual retry", () =>
		Effect.gen(function* () {
			const writes: DaemonConfig[] = [];
			let attempts = 0;
			const snapshotConfig = {
				pid: process.pid,
				port: 7777,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances: [],
			} satisfies DaemonConfig;
			const snapshotLayer = Layer.succeed(ConfigSnapshotTag, {
				build: Effect.gen(function* () {
					attempts += 1;
					if (attempts === 1) {
						return yield* Effect.fail(new Error("snapshot boom"));
					}
					return snapshotConfig;
				}),
			});
			const writerLayer = Layer.succeed(ConfigWriterTag, {
				write: (config: DaemonConfig) =>
					Effect.sync(() => {
						writes.push(config);
					}),
			});
			const layer = ConfigPersistenceLive.pipe(
				Layer.provideMerge(Layer.mergeAll(snapshotLayer, writerLayer)),
			);
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);

			yield* persistence.requestSave;
			const failed = yield* Effect.exit(persistence.flush);
			expect(Exit.isFailure(failed)).toBe(true);

			yield* persistence.flush;
			expect(attempts).toBe(2);
			expect(writes).toEqual([snapshotConfig]);
		}),
	);

	it.scoped("background flush retries after transient writer failure", () =>
		Effect.gen(function* () {
			const writes: DaemonConfig[] = [];
			let attempts = 0;
			const snapshotConfig = {
				pid: process.pid,
				port: 8888,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances: [],
			} satisfies DaemonConfig;
			const snapshotLayer = Layer.succeed(ConfigSnapshotTag, {
				build: Effect.succeed(snapshotConfig),
			});
			const writerLayer = Layer.succeed(ConfigWriterTag, {
				write: (config: DaemonConfig) =>
					Effect.gen(function* () {
						attempts += 1;
						if (attempts === 1) {
							return yield* Effect.fail(new Error("disk busy"));
						}
						writes.push(config);
					}),
			});
			const layer = ConfigPersistenceLive.pipe(
				Layer.provideMerge(Layer.mergeAll(snapshotLayer, writerLayer)),
			);
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);

			yield* persistence.requestSave;
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes).toEqual([]);

			yield* TestClock.adjust(Duration.millis(1200));
			expect(attempts).toBe(2);
			expect(writes).toEqual([snapshotConfig]);
		}),
	);
});
