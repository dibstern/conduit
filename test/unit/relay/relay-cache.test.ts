import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";

import {
	makeRelayCacheLive,
	type Relay,
	RelayCacheTag,
	type RelayFactory,
} from "../../../src/lib/effect/relay-cache.js";

const makeTestRelay = (slug: string): Relay => ({
	slug,
	wsHandler: {
		handleUpgrade: vi.fn(),
	} as unknown as Relay["wsHandler"],
	stop: vi.fn(),
});

describe("RelayCache", () => {
	it.scoped("creates relay on first get", () =>
		Effect.gen(function* () {
			const created: Relay[] = [];
			const factory: RelayFactory = (slug) =>
				Effect.sync(() => {
					const relay = makeTestRelay(slug);
					created.push(relay);
					return relay;
				});

			const layer = makeRelayCacheLive(factory);
			const cache = yield* Effect.provide(RelayCacheTag, layer);

			const relay = yield* cache.get("my-project");

			expect(relay.slug).toBe("my-project");
			expect(created).toHaveLength(1);
			expect(created[0]?.slug).toBe("my-project");
		}),
	);

	it.scoped("returns same relay on subsequent gets", () =>
		Effect.gen(function* () {
			let callCount = 0;
			const factory: RelayFactory = (slug) =>
				Effect.sync(() => {
					callCount++;
					return makeTestRelay(slug);
				});

			const layer = makeRelayCacheLive(factory);
			const cache = yield* Effect.provide(RelayCacheTag, layer);

			const relay1 = yield* cache.get("my-project");
			const relay2 = yield* cache.get("my-project");

			expect(relay1).toBe(relay2);
			expect(callCount).toBe(1);
		}),
	);

	it.scoped("deduplicates concurrent gets for same slug", () =>
		Effect.gen(function* () {
			let callCount = 0;
			const factory: RelayFactory = (slug) =>
				Effect.sync(() => {
					callCount++;
					return makeTestRelay(slug);
				});

			const layer = makeRelayCacheLive(factory);
			const cache = yield* Effect.provide(RelayCacheTag, layer);

			// Fire two gets concurrently — semaphore serializes them,
			// so the second finds the already-created relay from the first.
			const [relay1, relay2] = yield* Effect.all(
				[cache.get("my-project"), cache.get("my-project")],
				{ concurrency: "unbounded" },
			);

			expect(callCount).toBe(1);
			expect(relay1.slug).toBe("my-project");
			expect(relay2.slug).toBe("my-project");
			expect(relay1).toBe(relay2);
		}),
	);

	it.scoped("invalidate stops relay and allows re-creation", () =>
		Effect.gen(function* () {
			const relays: Relay[] = [];
			const factory: RelayFactory = (slug) =>
				Effect.sync(() => {
					const relay = makeTestRelay(slug);
					relays.push(relay);
					return relay;
				});

			const layer = makeRelayCacheLive(factory);
			const cache = yield* Effect.provide(RelayCacheTag, layer);

			// First get creates the relay
			const relay1 = yield* cache.get("my-project");
			expect(relays).toHaveLength(1);

			// Invalidate should stop the relay
			yield* cache.invalidate("my-project");
			expect(relay1.stop).toHaveBeenCalledTimes(1);

			// Second get creates a new relay
			const relay2 = yield* cache.get("my-project");
			expect(relays).toHaveLength(2);
			expect(relay2).not.toBe(relay1);
			expect(relay2.slug).toBe("my-project");
		}),
	);

	it.scoped("manages multiple slugs independently", () =>
		Effect.gen(function* () {
			const factory: RelayFactory = (slug) =>
				Effect.sync(() => makeTestRelay(slug));

			const layer = makeRelayCacheLive(factory);
			const cache = yield* Effect.provide(RelayCacheTag, layer);

			const relayA = yield* cache.get("project-a");
			const relayB = yield* cache.get("project-b");

			expect(relayA.slug).toBe("project-a");
			expect(relayB.slug).toBe("project-b");
			expect(relayA).not.toBe(relayB);

			// Invalidating one doesn't affect the other
			yield* cache.invalidate("project-a");
			expect(relayA.stop).toHaveBeenCalledTimes(1);

			const relayB2 = yield* cache.get("project-b");
			expect(relayB2).toBe(relayB);
			expect(relayB.stop).not.toHaveBeenCalled();
		}),
	);
});
