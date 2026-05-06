import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Option, Ref } from "effect";
import { expect } from "vitest";
import {
	getClientSession,
	getClientsForSession,
	makeSessionRegistryStateLive,
	removeClient,
	SessionRegistryStateTag,
	setClientSession,
} from "../../../src/lib/effect/session-registry-state.js";

describe("SessionRegistryState Effect", () => {
	it.effect("setClientSession registers a client for a session", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");

			const ref = yield* SessionRegistryStateTag;
			const map = yield* Ref.get(ref);
			expect(HashMap.get(map, "c1").pipe(Option.getOrNull)).toBe("s1");
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("setClientSession is no-op when same session", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");
			yield* setClientSession("c1", "s1"); // no-op

			const ref = yield* SessionRegistryStateTag;
			const map = yield* Ref.get(ref);
			expect(HashMap.size(map)).toBe(1);
			expect(HashMap.get(map, "c1").pipe(Option.getOrNull)).toBe("s1");
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("setClientSession switches session", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");
			yield* setClientSession("c1", "s2");

			const ref = yield* SessionRegistryStateTag;
			const map = yield* Ref.get(ref);
			expect(HashMap.get(map, "c1").pipe(Option.getOrNull)).toBe("s2");
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("getClientSession returns Option.some for known client", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");
			const result = yield* getClientSession("c1");
			expect(Option.getOrNull(result)).toBe("s1");
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("getClientSession returns Option.none for unknown client", () =>
		Effect.gen(function* () {
			const result = yield* getClientSession("unknown");
			expect(Option.isNone(result)).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("removeClient returns previous session and clears entry", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");
			const removed = yield* removeClient("c1");

			expect(Option.getOrNull(removed)).toBe("s1");

			const ref = yield* SessionRegistryStateTag;
			const map = yield* Ref.get(ref);
			expect(HashMap.has(map, "c1")).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("removeClient returns None for unknown client", () =>
		Effect.gen(function* () {
			const removed = yield* removeClient("unknown");
			expect(Option.isNone(removed)).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("getClientsForSession returns all viewers", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");
			yield* setClientSession("c2", "s1");
			yield* setClientSession("c3", "s2");

			const viewers = yield* getClientsForSession("s1");
			expect(viewers.sort()).toEqual(["c1", "c2"]);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("getClientsForSession returns empty for no viewers", () =>
		Effect.gen(function* () {
			const viewers = yield* getClientsForSession("s-none");
			expect(viewers).toEqual([]);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("getClientsForSession excludes client after session switch", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");
			yield* setClientSession("c2", "s1");
			yield* setClientSession("c1", "s2"); // switch c1 away from s1

			const s1Viewers = yield* getClientsForSession("s1");
			const s2Viewers = yield* getClientsForSession("s2");

			expect(s1Viewers).toEqual(["c2"]);
			expect(s2Viewers).toEqual(["c1"]);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("getClientsForSession excludes client after removeClient", () =>
		Effect.gen(function* () {
			yield* setClientSession("c1", "s1");
			yield* setClientSession("c2", "s1");
			yield* removeClient("c1");

			const viewers = yield* getClientsForSession("s1");
			expect(viewers).toEqual(["c2"]);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);

	it.effect("Layer.fresh provides isolated state per test", () =>
		Effect.gen(function* () {
			// Starting from empty — no leaks from other tests
			const ref = yield* SessionRegistryStateTag;
			const map = yield* Ref.get(ref);
			expect(HashMap.size(map)).toBe(0);
		}).pipe(Effect.provide(Layer.fresh(makeSessionRegistryStateLive()))),
	);
});
