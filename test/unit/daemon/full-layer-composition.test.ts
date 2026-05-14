import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	InstanceManagerStateTag,
	makeInstanceManagerStateLive,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	makeRelayCacheLive,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import {
	RateLimiterLive,
	RateLimiterTag,
} from "../../../src/lib/domain/relay/Layers/rate-limiter-layer.js";
import {
	makePollerManagerStateLive,
	PollerManagerStateTag,
} from "../../../src/lib/domain/relay/Services/message-poller.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	makePollerStateLive,
	PollerStateTag,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";

describe("Full Layer composition", () => {
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
				rpcWsHandler: { handleUpgrade: () => {} },
				stop: () => {},
			}),
		),
		RateLimiterLive({ maxRequests: 10, windowMs: 60_000 }),
		DaemonEventBusLive,
	);

	it.scoped("all state Tags are accessible from composed layer", () =>
		Effect.gen(function* () {
			const daemonState = yield* DaemonStateTag;
			const sessionState = yield* SessionManagerStateTag;
			const pollerState = yield* PollerStateTag;
			const pollerManager = yield* PollerManagerStateTag;
			const instanceState = yield* InstanceManagerStateTag;
			const relayCache = yield* RelayCacheTag;
			const limiter = yield* RateLimiterTag;
			const eventBus = yield* DaemonEventBusTag;

			expect(daemonState).toBeDefined();
			expect(sessionState).toBeDefined();
			expect(pollerState).toBeDefined();
			expect(pollerManager).toBeDefined();
			expect(instanceState).toBeDefined();
			expect(relayCache).toBeDefined();
			expect(limiter).toBeDefined();
			expect(eventBus).toBeDefined();
		}).pipe(Effect.provide(Layer.fresh(composedLayer))),
	);
});
