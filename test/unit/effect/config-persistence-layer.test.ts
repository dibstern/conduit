import { describe, expect, it } from "@effect/vitest";
import {
	Context,
	Duration,
	Effect,
	Exit,
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
} from "../../../src/lib/effect/config-persistence-layer.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../../../src/lib/effect/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/effect/daemon-pubsub.js";
import {
	addInstance,
	makeInstanceManagerStateLive,
} from "../../../src/lib/effect/instance-manager-service.js";
import {
	addWithoutRelay,
	makeProjectRegistryLive,
} from "../../../src/lib/effect/project-registry-service.js";

describe("ConfigPersistenceLive", () => {
	const defaults: DaemonRuntimeConfig = {
		port: 2633,
		host: "127.0.0.1",
		pinHash: null,
		tlsEnabled: false,
		keepAwake: false,
		keepAwakeCommand: undefined,
		keepAwakeArgs: undefined,
		shuttingDown: false,
		dismissedPaths: new Set(),
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

	it.scoped("coalesces multiple save requests within debounce window", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const persistence = Context.get(ctx, ConfigPersistenceTag);
			// Request 5 writes rapidly.
			for (let i = 0; i < 5; i++) {
				yield* persistence.requestSave;
			}
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBe(1);
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
						dismissedPaths: new Set(["/tmp/ignored"]),
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
							directory: "/tmp/alpha",
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
					dismissedPaths: ["/tmp/ignored"],
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
