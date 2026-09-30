// ─── Integration: Full Layer Composition ─────────────────────────────────────
// Verifies that all Effect-native state modules compose into a single Layer
// and key services work end-to-end.

import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue, Schema } from "effect";
import { expect } from "vitest";
import { IpcTaggedRequestSchema } from "../../src/lib/contracts/ipc-requests.js";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
	publishStatusChanged,
	subscribeToDaemonEvents,
} from "../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	InstanceManagerStateTag,
	makeInstanceManagerStateLive,
} from "../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { handleGetStatus } from "../../src/lib/domain/daemon/Services/ipc-handlers.js";
import {
	makeRelayCacheLive,
	RelayCacheTag,
} from "../../src/lib/domain/daemon/Services/relay-cache.js";
import {
	RateLimiterLive,
	RateLimiterTag,
} from "../../src/lib/domain/relay/Layers/rate-limiter-layer.js";
import {
	makePollerManagerStateLive,
	PollerManagerStateTag,
} from "../../src/lib/domain/relay/Services/message-poller.js";

import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	clearSession,
	getModel,
	makeOverridesStateLive,
	OverridesStateTag,
	setModel,
} from "../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	makePollerStateLive,
	PollerStateTag,
} from "../../src/lib/domain/relay/Services/session-status-poller.js";

// ─── Composed Layer ──────────────────────────────────────────────────────────

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
			attach: () => () => {},
			wsHandler: {},
			rpcWsHandler: {},
			stop: () => {},
		}),
	),
	RateLimiterLive({ maxRequests: 3, windowMs: 60_000 }),
	DaemonEventBusLive,
	makeOverridesStateLive(),
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

	it.effect("decodes and handles a tagged GetStatus request", () =>
		Effect.gen(function* () {
			const request = yield* Schema.decodeUnknown(IpcTaggedRequestSchema)(
				JSON.parse('{"_tag":"GetStatus"}'),
			);
			if (request._tag !== "GetStatus") throw new Error("Expected GetStatus");
			const result = yield* handleGetStatus(request);
			expect(result.ok).toBe(true);
			expect(result.uptime).toBeDefined();
		}).pipe(Effect.provide(Layer.fresh(makeDaemonStateLive()))),
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

	it.effect("Effect override state set/get/clear", () =>
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
