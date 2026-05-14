// ─── Layer Wiring Tests ─────────────────────────────────────────────────────
// Verify that makeDaemonLive correctly composes all Layers and that each
// service Tag is resolvable. These tests catch wiring bugs: if a Layer is
// missing, in the wrong tier, or has unsatisfied dependencies, the build
// fails or the Tag can't be resolved.
//
// Each test builds the composed Layer with mock server deps and verifies
// that the service is accessible and functional.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Layer, PubSub, Ref } from "effect";
import { expect } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import type { OnboardingServerDeps } from "../../../src/lib/daemon/daemon-lifecycle.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	type DaemonLiveOptions,
	makeDaemonLive,
	ShutdownSignalTag,
} from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { KeepAwakeTag } from "../../../src/lib/domain/daemon/Layers/keep-awake-layer.js";
import {
	HttpServerRefTag,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { StorageMonitorTag } from "../../../src/lib/domain/daemon/Layers/storage-monitor-layer.js";
import { TlsCertTag } from "../../../src/lib/domain/daemon/Layers/tls-cert-layer.js";
import { VersionCheckerTag } from "../../../src/lib/domain/daemon/Layers/version-checker-layer.js";
import {
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { CrashCounterTag } from "../../../src/lib/domain/daemon/Services/daemon-startup.js";
import { DaemonStateTag } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	addInstance,
	InstanceManagerStateTag,
	PollerFibersTag,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	addWithoutRelay,
	ProjectRegistryTag,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { AuthManagerTag } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import type { OpenCodeInstance } from "../../../src/lib/shared-types.js";
import type { StoredProject } from "../../../src/lib/types.js";

// ─── Mock DaemonLiveOptions ─────────────────────────────────────────────────

const makeMockOptions = (): DaemonLiveOptions => {
	const httpServer = createServer();
	const ipcServer = createNetServer();

	return {
		configDir: "/tmp/test-daemon-wiring",
		pidPath: "/tmp/test-daemon-wiring/daemon.pid",
		socketPath: "/tmp/test-daemon-wiring/relay.sock",
		ctx: {
			// Use an ephemeral port so wiring tests can run while the local
			// development daemon owns the default conduit port.
			httpServer,
			upgradeServer: null,
			onboardingServer: null,
			ipcServer,
			ipcClients: new Set<Socket>(),
			clientCount: 0,
			socketPath: "/tmp/test-daemon-wiring/relay.sock",
			router: null,
		},
		ipcContext: {
			addProject: () => Promise.resolve({}) as Promise<StoredProject>,
			removeProject: () => Promise.resolve(),
			getProjects: () => [],
			setProjectTitle: () => {},
			getPinHash: () => null,
			setPinHash: () => {},
			getKeepAwake: () => false,
			setKeepAwake: () => ({ supported: false, active: false }),
			setKeepAwakeCommand: () => {},
			persistConfig: () => {},
			scheduleShutdown: () => {},
			applyConfig: () => {},
			getInstances: () => [],
			getInstance: () => undefined,
			addInstance: () => ({}) as OpenCodeInstance,
			removeInstance: () => {},
			startInstance: () => Promise.resolve(),
			stopInstance: () => {},
			updateInstance: () => ({}) as OpenCodeInstance,
			setProjectAgent: () => Promise.resolve(),
			setProjectModel: () => Promise.resolve(),
		},
		getStatus: () => ({
			ok: true as const,
			pid: process.pid,
			port: 0,
			host: "127.0.0.1",
			version: "0.0.0-test",
			uptime: 0,
			projectCount: 0,
			sessionCount: 0,
			instanceCount: 0,
			clientCount: 0,
			keepAwake: false,
			pinEnabled: false,
			tlsEnabled: false,
			projects: [],
			instances: [],
		}),
		onboarding: {} as OnboardingServerDeps,
		httpRouter: {
			auth: new AuthManager(),
			staticDir: process.cwd(),
			getProjects: () => [],
			removeProject: () => Promise.resolve(),
			getPort: () => 0,
			getIsTls: () => false,
			getHealthResponse: () => ({ ok: true }),
			loadThemes: () => Promise.resolve({ bundled: {}, custom: {} }),
			pushManager: null,
		},
		initialConfig: makeDaemonConfigFromOptions({
			port: 0,
			host: "127.0.0.1",
			tlsEnabled: false,
			hostExplicit: false,
		}),
		// Background services with minimal configs
		keepAwake: {},
		versionCheck: {
			getCurrentVersion: () => "0.0.0",
			fetchLatestVersion: () => Effect.succeed(null),
			broadcast: () => Effect.void,
			checkInterval: Duration.hours(24),
		},
		storageMon: {
			getStorageUsage: () => Effect.succeed(0.1),
			persistence: { evictOldEvents: () => Effect.void },
			checkInterval: Duration.hours(24),
			highWaterMark: 0.9,
		},
		relayFactory: (slug: string) =>
			Effect.succeed({
				slug,
				wsHandler: { handleUpgrade: () => {} },
				rpcWsHandler: { handleUpgrade: () => {} },
				stop: () => {},
			}),
	};
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("makeDaemonLive wiring", () => {
	const makeDaemonLayer = () => Layer.fresh(makeDaemonLive(makeMockOptions()));

	// ── Tier 0: Foundation Tags ───────────────────────────────────────────

	it.scoped("provides DaemonEventBusTag (Tier 0)", () =>
		Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			// Verify it's a real PubSub by publishing
			const published = yield* PubSub.publish(
				bus,
				DaemonEvent.StatusChanged({ statuses: {} }),
			);
			expect(published).toBe(true);
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("provides DaemonConfigRefTag with the actual ephemeral port", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(ref);
			expect(config.port).toBeGreaterThan(0);
			expect(config.host).toBe("127.0.0.1");
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped(
		"makeDaemonLive seeds DaemonConfigRef from the full initial config",
		() => {
			const options = {
				...makeMockOptions(),
				initialConfig: makeDaemonConfigFromOptions({
					port: 53123,
					host: "0.0.0.0",
					tlsEnabled: false,
					hostExplicit: false,
					keepAwake: true,
					keepAwakeCommand: "printf",
					keepAwakeArgs: ["awake"],
					dismissedPaths: ["/tmp/dismissed"],
					persistedSessionCounts: new Map([["persisted", 3]]),
				}),
			} satisfies DaemonLiveOptions;

			return Effect.gen(function* () {
				const ref = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(ref);
				expect(config.port).toBe(53123);
				expect(config.host).toBe("0.0.0.0");
				expect(config.tlsEnabled).toBe(false);
				expect(config.hostExplicit).toBe(false);
				expect(config.keepAwake).toBe(true);
				expect(config.keepAwakeCommand).toBe("printf");
				expect(config.keepAwakeArgs).toEqual(["awake"]);
				expect(config.dismissedPaths.has("/tmp/dismissed")).toBe(true);
				expect(config.persistedSessionCounts.get("persisted")).toBe(3);
			}).pipe(Effect.provide(Layer.fresh(makeDaemonLive(options))));
		},
	);

	it.scoped("provides ShutdownSignalTag as a Deferred (Tier 0)", () =>
		Effect.gen(function* () {
			const shutdown = yield* ShutdownSignalTag;
			// It should be a Deferred — verify by checking it's not already done
			const isDone = yield* Deferred.isDone(shutdown);
			expect(isDone).toBe(false);
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("provides CrashCounterTag (Tier 0)", () =>
		Effect.gen(function* () {
			const counter = yield* CrashCounterTag;
			const result = yield* counter.record();
			expect(result.count).toBeGreaterThanOrEqual(1);
			expect(typeof result.shouldAbort).toBe("boolean");
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	// ── Tier 1: Service Tags ─────────────────────────────────────────────

	it.scoped(
		"provides AuthManagerTag with reactive pinHash from DaemonConfigRef (Tier 1)",
		() =>
			Effect.gen(function* () {
				const auth = yield* AuthManagerTag;
				// Initially no pin (options didn't set one)
				expect(yield* auth.hasPin()).toBe(false);

				// Update DaemonConfigRef — AuthManager should see it reactively
				const configRef = yield* DaemonConfigRefTag;
				yield* Ref.update(configRef, (c) => ({ ...c, pinHash: "test-hash" }));
				expect(yield* auth.hasPin()).toBe(true);
			}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("provides TlsCertTag (Tier 1)", () =>
		Effect.gen(function* () {
			const tls = yield* TlsCertTag;
			// TLS disabled by default — certs should be null
			expect(tls.certs).toBeNull();
			expect(tls.caRootPath).toBeNull();
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	// ── Tier 2: Registry Tags ────────────────────────────────────────────

	it.scoped("provides ProjectRegistryTag (Tier 2)", () =>
		Effect.gen(function* () {
			const ref = yield* ProjectRegistryTag;
			const state = yield* Ref.get(ref);
			// Empty registry on startup
			expect(state).toBeDefined();
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped(
		"provides InstanceManagerStateTag and PollerFibersTag (Tier 2)",
		() =>
			Effect.gen(function* () {
				const stateRef = yield* InstanceManagerStateTag;
				const state = yield* Ref.get(stateRef);
				expect(state.config.maxInstances).toBe(5);

				// PollerFibersTag should also be available
				const fibers = yield* PollerFibersTag;
				expect(fibers).toBeDefined();
			}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("provides RelayFactoryTag and HttpServerRefTag (Tier 2)", () =>
		Effect.gen(function* () {
			const factory = yield* RelayFactoryTag;
			expect(factory.create).toBeDefined();

			const serverRef = yield* HttpServerRefTag;
			const server = yield* Ref.get(serverRef);
			// The server lifecycle layer populates the ref after startup so
			// relay and WS routing code share the actual upgrade-capable server.
			expect(server).not.toBeNull();
			expect(server?.listening).toBe(true);
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("provides DaemonStateTag (Tier 2)", () =>
		Effect.gen(function* () {
			const stateRef = yield* DaemonStateTag;
			const state = yield* Ref.get(stateRef);
			expect(state.port).toBeDefined();
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	// ── Tier 4: Background Service Tags ──────────────────────────────────

	it.scoped("provides KeepAwakeTag with activate/deactivate (Tier 4)", () =>
		Effect.gen(function* () {
			const keepAwake = yield* KeepAwakeTag;
			const supported = yield* keepAwake.isSupported();
			// Platform-dependent, but the service should be functional
			expect(typeof supported).toBe("boolean");

			const active = yield* keepAwake.isActive();
			expect(active).toBe(false); // not activated by default
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("provides VersionCheckerTag (Tier 4)", () =>
		Effect.gen(function* () {
			const checker = yield* VersionCheckerTag;
			const current = yield* checker.getCurrentVersion();
			expect(current).toBe("0.0.0"); // from mock config
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("provides StorageMonitorTag (Tier 4)", () =>
		Effect.gen(function* () {
			const monitor = yield* StorageMonitorTag;
			const usage = yield* monitor.getUsage();
			// Mock returns 0.1 — if wiring is broken, this would throw
			expect(typeof usage).toBe("number");
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	// ── Cross-tier wiring: DaemonEventBus is shared ──────────────────────

	it.scoped("DaemonEventBus is shared across all tiers", () =>
		Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;

			// Subscribe before publishing
			const sub = yield* PubSub.subscribe(bus);

			// Publish an event that does not trigger daemon.json writes.
			yield* PubSub.publish(bus, DaemonEvent.StatusChanged({ statuses: {} }));

			// Should receive it — proves single bus instance
			const msg = yield* sub.take;
			expect(msg._tag).toBe("StatusChanged");
		}).pipe(Effect.provide(makeDaemonLayer())),
	);

	it.scoped("ConfigPersistenceLive is wired into makeDaemonLive", () =>
		Effect.gen(function* () {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-effect-config-"));
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => rmSync(configDir, { recursive: true, force: true })),
			);

			const base = makeMockOptions();
			const socketPath = join(configDir, "relay.sock");
			const options = {
				...base,
				configDir,
				pidPath: join(configDir, "daemon.pid"),
				socketPath,
				ctx: {
					...base.ctx,
					socketPath,
				},
				initialConfig: makeDaemonConfigFromOptions({
					port: 53124,
					host: "127.0.0.1",
					tlsEnabled: false,
					hostExplicit: false,
				}),
				configSnapshot: () => ({
					pid: process.pid,
					port: 53124,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					dangerouslySkipPermissions: false,
					projects: [
						{
							path: "/tmp/alpha",
							slug: "alpha",
							title: "Alpha",
							addedAt: 1700000000000,
							instanceId: "remote-1",
							sessionCount: 4,
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
				}),
			} satisfies DaemonLiveOptions;

			const persisted = yield* Effect.gen(function* () {
				const bus = yield* DaemonEventBusTag;
				const configPersistence = yield* ConfigPersistenceTag;
				yield* PubSub.publish(bus, DaemonEvent.ConfigChanged());
				yield* Effect.yieldNow();
				yield* configPersistence.flush;
				const raw = readFileSync(join(configDir, "daemon.json"), "utf-8");
				return JSON.parse(raw) as {
					projects: Array<{ slug: string; sessionCount?: number }>;
					instances: Array<{ id: string; url?: string }>;
				};
			}).pipe(Effect.provide(Layer.fresh(makeDaemonLive(options))));

			expect(persisted.projects).toEqual([
				expect.objectContaining({ slug: "alpha", sessionCount: 4 }),
			]);
			expect(persisted.instances).toEqual([
				expect.objectContaining({
					id: "remote-1",
					url: "https://opencode.example.test",
				}),
			]);
		}),
	);

	it.scoped(
		"Effect project and instance mutations request config persistence",
		() =>
			Effect.gen(function* () {
				const configDir = mkdtempSync(join(tmpdir(), "conduit-effect-config-"));
				yield* Effect.addFinalizer(() =>
					Effect.sync(() =>
						rmSync(configDir, { recursive: true, force: true }),
					),
				);

				const base = makeMockOptions();
				const socketPath = join(configDir, "relay.sock");
				const options = {
					...base,
					configDir,
					pidPath: join(configDir, "daemon.pid"),
					socketPath,
					ctx: {
						...base.ctx,
						socketPath,
					},
					initialConfig: makeDaemonConfigFromOptions({
						port: 53125,
						host: "127.0.0.1",
						tlsEnabled: false,
						hostExplicit: false,
					}),
				} satisfies DaemonLiveOptions;

				const persisted = yield* Effect.gen(function* () {
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
					const configPersistence = yield* ConfigPersistenceTag;
					yield* configPersistence.flush;
					const raw = readFileSync(join(configDir, "daemon.json"), "utf-8");
					return JSON.parse(raw) as {
						projects: Array<{ slug: string; sessionCount?: number }>;
						instances: Array<{ id: string; url?: string }>;
					};
				}).pipe(Effect.provide(Layer.fresh(makeDaemonLive(options))));

				expect(persisted.projects).toEqual([
					expect.objectContaining({ slug: "alpha" }),
				]);
				expect(persisted.instances).toEqual([
					expect.objectContaining({
						id: "remote-1",
						url: "https://opencode.example.test",
					}),
				]);
			}),
	);

	it.scoped(
		"pure Effect snapshot preserves disk-loaded projects and instances",
		() =>
			Effect.gen(function* () {
				const configDir = mkdtempSync(join(tmpdir(), "conduit-effect-config-"));
				yield* Effect.addFinalizer(() =>
					Effect.sync(() =>
						rmSync(configDir, { recursive: true, force: true }),
					),
				);

				const configPath = join(configDir, "daemon.json");
				writeFileSync(
					configPath,
					JSON.stringify(
						{
							pid: process.pid,
							port: 53126,
							pinHash: null,
							tls: false,
							debug: false,
							keepAwake: false,
							dangerouslySkipPermissions: false,
							projects: [
								{
									path: "/tmp/persisted-alpha",
									slug: "persisted-alpha",
									title: "Persisted Alpha",
									addedAt: 1700000000000,
									instanceId: "remote-1",
									sessionCount: 7,
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
						},
						null,
						2,
					),
				);

				const base = makeMockOptions();
				const socketPath = join(configDir, "relay.sock");
				const options = {
					...base,
					configDir,
					pidPath: join(configDir, "daemon.pid"),
					socketPath,
					ctx: {
						...base.ctx,
						socketPath,
					},
					configPath,
					initialConfig: makeDaemonConfigFromOptions({
						port: 0,
						host: "127.0.0.1",
						tlsEnabled: false,
						hostExplicit: false,
						persistedSessionCounts: new Map([["persisted-alpha", 7]]),
					}),
				} satisfies DaemonLiveOptions;

				const persisted = yield* Effect.gen(function* () {
					const bus = yield* DaemonEventBusTag;
					const configPersistence = yield* ConfigPersistenceTag;
					yield* PubSub.publish(bus, DaemonEvent.ConfigChanged());
					yield* Effect.yieldNow();
					yield* configPersistence.flush;
					const raw = readFileSync(configPath, "utf-8");
					return JSON.parse(raw) as {
						projects: Array<{ slug: string; sessionCount?: number }>;
						instances: Array<{ id: string; url?: string }>;
					};
				}).pipe(Effect.provide(Layer.fresh(makeDaemonLive(options))));

				expect(persisted.projects).toEqual([
					expect.objectContaining({
						slug: "persisted-alpha",
						sessionCount: 7,
					}),
				]);
				expect(persisted.instances).toEqual([
					expect.objectContaining({
						id: "remote-1",
						url: "https://opencode.example.test",
					}),
				]);
			}),
	);

	// ── Cross-tier wiring: AuthManager reads DaemonConfigRef reactively ──

	it.scoped(
		"AuthManager reactive wiring: pinHash update in Tier 0 visible in Tier 1",
		() =>
			Effect.gen(function* () {
				const auth = yield* AuthManagerTag;
				const configRef = yield* DaemonConfigRefTag;

				// Start: no pin
				expect(yield* auth.hasPin()).toBe(false);

				// Simulate IPC setPinHash → updates DaemonConfigRef
				yield* Ref.update(configRef, (c) => ({ ...c, pinHash: "abc123" }));

				// AuthManager reads reactively
				expect(yield* auth.hasPin()).toBe(true);
				expect(yield* auth.getPinHash()).toBe("abc123");

				// Clear pin
				yield* Ref.update(configRef, (c) => ({ ...c, pinHash: null }));
				expect(yield* auth.hasPin()).toBe(false);
			}).pipe(Effect.provide(makeDaemonLayer())),
	);

	// ── Cross-tier wiring: KeepAwake activate/deactivate lifecycle ────────

	it.scoped(
		"KeepAwake activate/deactivate lifecycle works through Layer (Tier 4)",
		() =>
			Effect.gen(function* () {
				const keepAwake = yield* KeepAwakeTag;

				// Activate
				yield* keepAwake.activate();
				const activeAfter = yield* keepAwake.isActive();
				// On supported platforms, should be true. On unsupported, stays false.
				// Either way, the call should not throw.
				expect(typeof activeAfter).toBe("boolean");

				// Deactivate
				yield* keepAwake.deactivate();
				const activeAfterDeactivate = yield* keepAwake.isActive();
				expect(activeAfterDeactivate).toBe(false);
			}).pipe(Effect.provide(makeDaemonLayer())),
	);

	// ── Cross-tier wiring: CrashCounter records and resets ───────────────

	it.scoped("CrashCounter record/reset lifecycle (Tier 0)", () =>
		Effect.gen(function* () {
			const counter = yield* CrashCounterTag;

			// Record 2 crashes
			yield* counter.record();
			const second = yield* counter.record();
			expect(second.count).toBe(2);

			// Reset
			yield* counter.reset();
			const afterReset = yield* counter.record();
			expect(afterReset.count).toBe(1);
		}).pipe(Effect.provide(makeDaemonLayer())),
	);
});
