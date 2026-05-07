// ─── Integration: Full Layer Composition ─────────────────────────────────────
// Verifies that all Effect-native state modules compose into a single Layer
// and key services work end-to-end.

import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Ref } from "effect";
import { expect } from "vitest";
import { PersistencePathTag } from "../../src/lib/effect/daemon-config-persistence.js";
import type { DaemonRuntimeConfig } from "../../src/lib/effect/daemon-config-ref.js";
import { DaemonConfigRefTag } from "../../src/lib/effect/daemon-config-ref.js";
import { ShutdownSignalTag } from "../../src/lib/effect/daemon-layers.js";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
	publishStatusChanged,
	subscribeToDaemonEvents,
} from "../../src/lib/effect/daemon-pubsub.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../src/lib/effect/daemon-state.js";
import {
	InstanceManagerStateTag,
	makeInstanceManagerStateLive,
} from "../../src/lib/effect/instance-manager-service.js";
import { decodeAndDispatch } from "../../src/lib/effect/ipc-dispatch.js";
import { KeepAwakeTag } from "../../src/lib/effect/keep-awake-layer.js";
import {
	makePollerManagerStateLive,
	PollerManagerStateTag,
} from "../../src/lib/effect/message-poller.js";
import {
	RateLimiterLive,
	RateLimiterTag,
} from "../../src/lib/effect/rate-limiter-layer.js";
import {
	makeRelayCacheLive,
	RelayCacheTag,
} from "../../src/lib/effect/relay-cache.js";
import {
	InstanceMgmtTag,
	ProjectMgmtTag,
	SessionOverridesTag,
} from "../../src/lib/effect/services.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../src/lib/effect/session-manager-state.js";
import {
	clearSession,
	getModel,
	makeOverridesStateLive,
	OverridesStateTag,
	setModel,
} from "../../src/lib/effect/session-overrides-state.js";
import {
	makePollerStateLive,
	PollerStateTag,
} from "../../src/lib/effect/session-status-poller.js";
import { SessionOverrides } from "../../src/lib/session/session-overrides.js";

// ─── In-memory FileSystem for IPC persistence ────────────────────────────────

const makeTestFileSystem = () => {
	const files = new Map<string, string>();
	const fs: FileSystem.FileSystem = FileSystem.makeNoop({
		readFileString: (path: string) =>
			Effect.gen(function* () {
				const content = files.get(path);
				if (content === undefined) {
					return yield* Effect.fail(
						new SystemError({
							reason: "NotFound",
							module: "FileSystem",
							method: "readFileString",
							description: `File not found: ${path}`,
							pathOrDescriptor: path,
						}),
					);
				}
				return content;
			}),
		writeFileString: (path: string, data: string) =>
			Effect.sync(() => {
				files.set(path, data);
			}),
		rename: (oldPath: string, newPath: string) =>
			Effect.sync(() => {
				const content = files.get(oldPath);
				if (content !== undefined) {
					files.set(newPath, content);
					files.delete(oldPath);
				}
			}),
		makeDirectory: () => Effect.void,
	});
	return Layer.succeed(FileSystem.FileSystem, fs);
};

// ─── Composed Layer ──────────────────────────────────────────────────────────

const CONFIG_PATH = "/test-config/daemon.json";

/** All Effect-native state layers + mock Tags for imperative services. */
const composedLayer = Layer.mergeAll(
	makeDaemonStateLive(),
	makeSessionManagerStateLive(),
	makePollerStateLive(),
	makePollerManagerStateLive(),
	makeInstanceManagerStateLive(),
	makeRelayCacheLive((slug) =>
		Effect.succeed({
			slug,
			wsHandler: { handleUpgrade: () => {} },
			stop: () => {},
		}),
	),
	RateLimiterLive({ maxRequests: 3, windowMs: 60_000 }),
	DaemonEventBusLive,
	makeOverridesStateLive(),
);

const makeMockKeepAwake = () =>
	Layer.effect(
		KeepAwakeTag,
		Effect.gen(function* () {
			const activeRef = yield* Ref.make(false);
			return {
				activate: () => Ref.set(activeRef, true),
				deactivate: () => Ref.set(activeRef, false),
				isActive: () => Ref.get(activeRef),
				isSupported: () => Effect.succeed(true),
			};
		}),
	);

const makeMockConfigRef = () => {
	const initial: DaemonRuntimeConfig = {
		port: 2633,
		host: "127.0.0.1",
		pinHash: null,
		tlsEnabled: false,
		keepAwake: false,
		keepAwakeCommand: undefined,
		keepAwakeArgs: undefined,
		shuttingDown: false,
		dismissedPaths: new Set<string>(),
		startTime: Date.now(),
		hostExplicit: false,
		persistedSessionCounts: new Map<string, number>(),
	};
	return Layer.effect(DaemonConfigRefTag, Ref.make(initial));
};

const makeMockShutdownSignal = () =>
	Layer.effect(ShutdownSignalTag, Deferred.make<void>());

/** Layers needed by IPC dispatch (imperative service mocks + FS + persistence path). */
const ipcDepsLayer = Layer.mergeAll(
	makeTestFileSystem(),
	Layer.succeed(PersistencePathTag, CONFIG_PATH),
	Layer.succeed(ProjectMgmtTag, {
		getProjects: () => [],
		setProjectInstance: () => {},
	}),
	Layer.succeed(InstanceMgmtTag, {
		getInstances: () => [],
		addInstance: (id, config) => ({
			id,
			...config,
			status: "stopped" as const,
			restartCount: 0,
			createdAt: Date.now(),
		}),
		removeInstance: () => {},
		startInstance: () => Promise.resolve(),
		stopInstance: () => {},
		updateInstance: (id, updates) => ({
			id,
			name: updates.name ?? "Mock",
			port: updates.port ?? 0,
			managed: true,
			status: "healthy" as const,
			restartCount: 0,
			createdAt: Date.now(),
		}),
		persistConfig: () => {},
	}),
	Layer.succeed(SessionOverridesTag, new SessionOverrides()),
	makeMockKeepAwake(),
	makeMockConfigRef(),
	makeMockShutdownSignal(),
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Integration: Full Layer Composition", () => {
	it.scoped("all Tags resolve from composed Layer", () =>
		Effect.gen(function* () {
			const daemonState = yield* DaemonStateTag;
			const sessionState = yield* SessionManagerStateTag;
			const pollerState = yield* PollerStateTag;
			const pollerManager = yield* PollerManagerStateTag;
			const instanceState = yield* InstanceManagerStateTag;
			const relayCache = yield* RelayCacheTag;
			const limiter = yield* RateLimiterTag;
			const eventBus = yield* DaemonEventBusTag;
			const overrides = yield* OverridesStateTag;

			expect(daemonState).toBeDefined();
			expect(sessionState).toBeDefined();
			expect(pollerState).toBeDefined();
			expect(pollerManager).toBeDefined();
			expect(instanceState).toBeDefined();
			expect(relayCache).toBeDefined();
			expect(limiter).toBeDefined();
			expect(eventBus).toBeDefined();
			expect(overrides).toBeDefined();
		}).pipe(Effect.provide(Layer.fresh(composedLayer))),
	);

	it.effect("IPC dispatch end-to-end: get_status", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({ cmd: "get_status" });
			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(true);
			expect(result.uptime).toBeDefined();
		}).pipe(
			Effect.provide(
				Layer.fresh(Layer.mergeAll(makeDaemonStateLive(), ipcDepsLayer)),
			),
		),
	);

	it.scoped("PubSub events flow between publisher and subscriber", () =>
		Effect.gen(function* () {
			const sub = yield* subscribeToDaemonEvents;
			yield* publishStatusChanged({ s1: "busy", s2: "idle" });
			const event = yield* Queue.take(sub);

			expect(event._tag).toBe("StatusChanged");
			if (event._tag === "StatusChanged") {
				expect(event.statuses).toEqual({ s1: "busy", s2: "idle" });
			}
		}).pipe(Effect.provide(Layer.fresh(DaemonEventBusLive))),
	);

	it.scoped("RateLimiter enforces limits", () =>
		Effect.gen(function* () {
			const limiter = yield* RateLimiterTag;

			// First 3 requests should be allowed (maxRequests: 3)
			const r1 = yield* limiter.checkLimit("127.0.0.1");
			const r2 = yield* limiter.checkLimit("127.0.0.1");
			const r3 = yield* limiter.checkLimit("127.0.0.1");
			expect(r1.allowed).toBe(true);
			expect(r2.allowed).toBe(true);
			expect(r3.allowed).toBe(true);

			// 4th request from same IP should be blocked
			const r4 = yield* limiter.checkLimit("127.0.0.1");
			expect(r4.allowed).toBe(false);
			expect(r4.retryAfterMs).toBeDefined();
			expect(r4.retryAfterMs).toBeGreaterThan(0);

			// Different IP should still be allowed
			const r5 = yield* limiter.checkLimit("10.0.0.1");
			expect(r5.allowed).toBe(true);
		}).pipe(
			Effect.provide(
				Layer.fresh(RateLimiterLive({ maxRequests: 3, windowMs: 60_000 })),
			),
		),
	);

	it.effect("SessionOverrides set/get/clear", () =>
		Effect.gen(function* () {
			const model = { providerID: "anthropic", modelID: "claude-4" };

			// Set model
			yield* setModel("sess-1", model);
			const got = yield* getModel("sess-1");
			expect(got).toEqual(model);

			// Clear session
			yield* clearSession("sess-1");
			const afterClear = yield* getModel("sess-1");
			expect(afterClear).toBeUndefined();
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);
});
