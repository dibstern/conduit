// Smoke tests verifying that the new DaemonState and RelayCache layers
// compose correctly and provide their Tags.

import { describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vitest";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	makeRelayCacheLive,
	type Relay,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";

describe("daemon-layers", () => {
	it.effect("DaemonStateTag is available in composed layer", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonStateTag;
			const state = yield* Ref.get(ref);
			expect(state.clientCount).toBe(0);
		}).pipe(Effect.provide(makeDaemonStateLive())),
	);

	it.effect("RelayCacheTag is available via makeRelayCacheLayer", () =>
		Effect.gen(function* () {
			const cache = yield* RelayCacheTag;
			expect(cache.get).toBeTypeOf("function");
			expect(cache.invalidate).toBeTypeOf("function");
		}).pipe(
			Effect.provide(
				makeRelayCacheLive((slug) =>
					Effect.succeed({
						slug,
						rpcWsHandler: {},
						syncGlobalSetting: () => Effect.void,
						refreshGlobalDefaults: () => Effect.void,
						stop: () => {},
					} satisfies Relay),
				),
			),
		),
	);
});
