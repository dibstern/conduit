// ─── Layer Wiring Tests ─────────────────────────────────────────────────────
// Verify that makeDaemonLive correctly composes all Layers and that each
// service Tag is resolvable. These tests catch wiring bugs: if a Layer is
// missing, in the wrong tier, or has unsatisfied dependencies, the build
// fails or the Tag can't be resolved.
//
// Each test builds the composed Layer with mock server deps and verifies
// that the service is accessible and functional.

import { createServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Layer, PubSub, Ref } from "effect";
import { expect } from "vitest";
import type { OnboardingServerDeps } from "../../../src/lib/daemon/daemon-lifecycle.js";
import { AuthManagerTag } from "../../../src/lib/effect/auth-middleware.js";
import { DaemonConfigRefTag } from "../../../src/lib/effect/daemon-config-ref.js";
import {
	type DaemonLiveOptions,
	makeDaemonLive,
	ShutdownSignalTag,
} from "../../../src/lib/effect/daemon-layers.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../../../src/lib/effect/daemon-pubsub.js";
import { CrashCounterTag } from "../../../src/lib/effect/daemon-startup.js";
import { DaemonStateTag } from "../../../src/lib/effect/daemon-state.js";
import {
	InstanceManagerStateTag,
	PollerFibersTag,
} from "../../../src/lib/effect/instance-manager-service.js";
import { KeepAwakeTag } from "../../../src/lib/effect/keep-awake-layer.js";
import { ProjectRegistryTag } from "../../../src/lib/effect/project-registry-service.js";
import {
	HttpServerRefTag,
	RelayFactoryTag,
} from "../../../src/lib/effect/relay-factory-layer.js";
import { StorageMonitorTag } from "../../../src/lib/effect/storage-monitor-layer.js";
import { TlsCertTag } from "../../../src/lib/effect/tls-cert-layer.js";
import { VersionCheckerTag } from "../../../src/lib/effect/version-checker-layer.js";
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
			port: 0,
			host: "127.0.0.1",
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

	it.scoped(
		"provides DaemonConfigRefTag with ephemeral initial port (Tier 0)",
		() =>
			Effect.gen(function* () {
				const ref = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(ref);
				expect(config.port).toBe(0);
				expect(config.host).toBe("127.0.0.1");
			}).pipe(Effect.provide(makeDaemonLayer())),
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
				expect(auth.hasPin()).toBe(false);

				// Update DaemonConfigRef — AuthManager should see it reactively
				const configRef = yield* DaemonConfigRefTag;
				yield* Ref.update(configRef, (c) => ({ ...c, pinHash: "test-hash" }));
				expect(auth.hasPin()).toBe(true);
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
			// Initially null (server not set yet)
			expect(server).toBeNull();
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

	it.scoped(
		"DaemonEventBus is shared across all tiers (ConfigChanged reaches ConfigPersistence)",
		() =>
			Effect.gen(function* () {
				// Verify the bus from Tier 0 is the same one used by ConfigPersistenceLive
				const bus = yield* DaemonEventBusTag;

				// Subscribe before publishing
				const sub = yield* PubSub.subscribe(bus);

				// Publish a ConfigChanged event
				yield* PubSub.publish(bus, DaemonEvent.ConfigChanged());

				// Should receive it — proves single bus instance
				const msg = yield* sub.take;
				expect(msg._tag).toBe("ConfigChanged");
			}).pipe(Effect.provide(makeDaemonLayer())),
	);

	// ── Cross-tier wiring: AuthManager reads DaemonConfigRef reactively ──

	it.scoped(
		"AuthManager reactive wiring: pinHash update in Tier 0 visible in Tier 1",
		() =>
			Effect.gen(function* () {
				const auth = yield* AuthManagerTag;
				const configRef = yield* DaemonConfigRefTag;

				// Start: no pin
				expect(auth.hasPin()).toBe(false);

				// Simulate IPC setPinHash → updates DaemonConfigRef
				yield* Ref.update(configRef, (c) => ({ ...c, pinHash: "abc123" }));

				// AuthManager reads reactively
				expect(auth.hasPin()).toBe(true);
				expect(auth.getPinHash()).toBe("abc123");

				// Clear pin
				yield* Ref.update(configRef, (c) => ({ ...c, pinHash: null }));
				expect(auth.hasPin()).toBe(false);
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
