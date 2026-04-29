import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Ref } from "effect";
import { expect } from "vitest";
import { makeInstanceManagerStateLive } from "../../../src/lib/effect/instance-manager-service.js";
import { makePollerManagerStateLive } from "../../../src/lib/effect/message-poller.js";
import {
	PtyManagerStateLive,
	PtyManagerStateTag,
} from "../../../src/lib/effect/pty-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/effect/session-manager-state.js";
import {
	makeOverridesStateLive,
	OverridesStateTag,
} from "../../../src/lib/effect/session-overrides-state.js";
import {
	makeSessionRegistryStateLive,
	SessionRegistryStateTag,
} from "../../../src/lib/effect/session-registry-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../../../src/lib/effect/session-status-poller.js";
import {
	makeWsHandlerStateLive,
	WsHandlerStateTag,
} from "../../../src/lib/effect/ws-handler-service.js";

describe("Self-constructing service layers", () => {
	const testLayer = Layer.mergeAll(
		makeSessionRegistryStateLive(),
		makeOverridesStateLive(),
		makePollerManagerStateLive(),
		makePollerStateLive(),
		makePollerPubSubLive(),
		makeWsHandlerStateLive(),
		makeSessionManagerStateLive(),
		makeInstanceManagerStateLive(),
		PtyManagerStateLive,
	);

	it.scoped("composes all Effect-native state layers without error", () =>
		Effect.gen(function* () {
			const registryRef = yield* SessionRegistryStateTag;
			const registry = yield* Ref.get(registryRef);
			expect(HashMap.size(registry)).toBe(0);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("PtyManagerStateTag starts empty", () =>
		Effect.gen(function* () {
			const ref = yield* PtyManagerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.size(state.sessions)).toBe(0);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("OverridesStateTag starts with empty sessions Map", () =>
		Effect.gen(function* () {
			const ref = yield* OverridesStateTag;
			const state = yield* Ref.get(ref);
			expect(state.sessions.size).toBe(0);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("WsHandlerStateTag starts empty", () =>
		Effect.gen(function* () {
			const ref = yield* WsHandlerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.size(state)).toBe(0);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("SessionManagerStateTag starts empty", () =>
		Effect.gen(function* () {
			const ref = yield* SessionManagerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.size(state.cachedParentMap)).toBe(0);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});
