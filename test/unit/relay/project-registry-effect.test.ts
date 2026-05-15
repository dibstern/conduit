// test/unit/relay/project-registry-effect.test.ts
import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
} from "effect";
import { expect } from "vitest";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addWithoutRelay,
	allProjects,
	findByDirectory,
	getEntry,
	getProject,
	has,
	isReady,
	makeProjectRegistryLive,
	markError,
	markReady,
	readyEntries,
	remove,
	removeAll,
	size,
	slugs,
	startRelay,
	touchLastUsed,
	updateProject,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type RelayCache,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import type { StoredProject } from "../../../src/lib/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProject(slug: string, dir?: string): StoredProject {
	return {
		slug,
		directory: dir ?? `/test/${slug}`,
		title: slug,
		lastUsed: Date.now(),
	};
}

/** No-op RelayCacheTag for tests that don't exercise relay lifecycle. */
const NoOpRelayCacheLive = Layer.succeed(RelayCacheTag, {
	get: (_slug: string) =>
		Effect.succeed({
			slug: _slug,
			wsHandler: { handleUpgrade: () => {} },
			rpcWsHandler: { handleUpgrade: () => {} },
			stop: () => {},
		}),
	peek: () => Effect.succeed(Option.none()),
	invalidate: (_slug: string) => Effect.void,
} satisfies RelayCache);

/** Failing RelayCache for testing error paths (dies with defect). */
const FailingRelayCacheLive = Layer.succeed(RelayCacheTag, {
	get: (_slug: string) => Effect.die(new Error("relay-boom")),
	peek: () => Effect.succeed(Option.none()),
	invalidate: (_slug: string) => Effect.void,
} satisfies RelayCache);

/** Standard test layer providing all deps with fresh state. */
const TestLayer = Layer.fresh(
	Layer.mergeAll(
		makeProjectRegistryLive(),
		DaemonEventBusLive,
		NoOpRelayCacheLive,
		ConfigPersistenceNoopLive,
	),
);

/** Test layer with failing relay cache. */
const FailingRelayTestLayer = Layer.fresh(
	Layer.mergeAll(
		makeProjectRegistryLive(),
		DaemonEventBusLive,
		FailingRelayCacheLive,
		ConfigPersistenceNoopLive,
	),
);

// ─── Mutation: addWithoutRelay ───────────────────────────────────────────────

describe("ProjectRegistry Effect - addWithoutRelay", () => {
	it.scoped("registers a project in Registering state", () =>
		Effect.gen(function* () {
			const project = makeProject("alpha");
			yield* addWithoutRelay(project);

			const entry = yield* getEntry("alpha");
			expect(Option.isSome(entry)).toBe(true);
			expect(Option.getOrThrow(entry)._tag).toBe("Registering");
			expect(Option.getOrThrow(entry).project.slug).toBe("alpha");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("publishes InstanceAdded event", () =>
		Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* addWithoutRelay(makeProject("alpha"));

			const msg = yield* Queue.take(sub);
			expect(msg._tag).toBe("InstanceAdded");
			if (msg._tag === "InstanceAdded") {
				expect(msg.instanceId).toBe("alpha");
			}
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("does not publish event when silent", () =>
		Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* addWithoutRelay(makeProject("alpha"), { silent: true });

			const isEmpty = yield* Queue.isEmpty(sub);
			expect(isEmpty).toBe(true);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("fails with ProjectAlreadyExists for duplicate slug", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));

			const result = yield* addWithoutRelay(makeProject("alpha")).pipe(
				Effect.catchTag("ProjectAlreadyExists", (e) =>
					Effect.succeed(`caught: ${e.slug}`),
				),
			);
			expect(result).toBe("caught: alpha");
		}).pipe(Effect.provide(TestLayer)),
	);
});

// ─── Mutation: markReady ─────────────────────────────────────────────────────

describe("ProjectRegistry Effect - markReady", () => {
	it.scoped("transitions to Ready state", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* markReady("alpha");

			const entry = yield* getEntry("alpha");
			expect(Option.getOrThrow(entry)._tag).toBe("Ready");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("publishes InstanceStatusChanged", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));

			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* markReady("alpha");

			const msg = yield* Queue.take(sub);
			expect(msg._tag).toBe("InstanceStatusChanged");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("fails with ProjectNotFound if slug not registered", () =>
		Effect.gen(function* () {
			const result = yield* markReady("ghost").pipe(
				Effect.catchTag("ProjectNotFound", (e) =>
					Effect.succeed(`not-found: ${e.slug}`),
				),
			);
			expect(result).toBe("not-found: ghost");
		}).pipe(Effect.provide(TestLayer)),
	);
});

// ─── Mutation: markError ─────────────────────────────────────────────────────

describe("ProjectRegistry Effect - markError", () => {
	it.scoped("transitions to Error state with error message", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* markError("alpha", "connection refused");

			const entry = yield* getEntry("alpha");
			const val = Option.getOrThrow(entry);
			expect(val._tag).toBe("Error");
			if (val._tag === "Error") {
				expect(val.error).toBe("connection refused");
			}
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("publishes InstanceStatusChanged", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));

			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* markError("alpha", "boom");

			const msg = yield* Queue.take(sub);
			expect(msg._tag).toBe("InstanceStatusChanged");
		}).pipe(Effect.provide(TestLayer)),
	);
});

// ─── Mutation: remove ────────────────────────────────────────────────────────

describe("ProjectRegistry Effect - remove", () => {
	it.scoped("removes a registered project", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* remove("alpha");

			const exists = yield* has("alpha");
			expect(exists).toBe(false);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("publishes InstanceRemoved event", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));

			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* remove("alpha");

			const msg = yield* Queue.take(sub);
			expect(msg._tag).toBe("InstanceRemoved");
			if (msg._tag === "InstanceRemoved") {
				expect(msg.instanceId).toBe("alpha");
			}
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("is a no-op for non-existent slug", () =>
		Effect.gen(function* () {
			// Should not throw
			yield* remove("ghost");

			const currentSize = yield* size;
			expect(currentSize).toBe(0);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("invalidates relay via RelayCacheTag", () => {
		let invalidatedSlug: string | null = null;
		const trackingCache: RelayCache = {
			get: (_slug: string) =>
				Effect.succeed({
					slug: _slug,
					wsHandler: { handleUpgrade: () => {} },
					rpcWsHandler: { handleUpgrade: () => {} },
					stop: () => {},
				}),
			peek: () => Effect.succeed(Option.none()),
			invalidate: (slug: string) =>
				Effect.sync(() => {
					invalidatedSlug = slug;
				}),
		};

		const customLayer = Layer.fresh(
			Layer.mergeAll(
				makeProjectRegistryLive(),
				DaemonEventBusLive,
				Layer.succeed(RelayCacheTag, trackingCache),
				ConfigPersistenceNoopLive,
			),
		);

		return Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* remove("alpha");

			expect(invalidatedSlug).toBe("alpha");
		}).pipe(Effect.provide(customLayer));
	});
});

// ─── Mutation: updateProject ─────────────────────────────────────────────────

describe("ProjectRegistry Effect - updateProject", () => {
	it.scoped("updates project title", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* updateProject("alpha", { title: "Alpha v2" });

			const project = yield* getProject("alpha");
			expect(project.title).toBe("Alpha v2");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("updates instanceId", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* updateProject("alpha", { instanceId: "inst-2" });

			const project = yield* getProject("alpha");
			expect(project.instanceId).toBe("inst-2");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("publishes InstanceStatusChanged", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));

			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* updateProject("alpha", { title: "New" });

			const msg = yield* Queue.take(sub);
			expect(msg._tag).toBe("InstanceStatusChanged");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("fails with ProjectNotFound for missing slug", () =>
		Effect.gen(function* () {
			const result = yield* updateProject("ghost", { title: "nope" }).pipe(
				Effect.catchTag("ProjectNotFound", (e) =>
					Effect.succeed(`not-found: ${e.slug}`),
				),
			);
			expect(result).toBe("not-found: ghost");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("preserves entry state (_tag) when updating project fields", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* markReady("alpha");
			yield* updateProject("alpha", { title: "Updated" });

			const entry = yield* getEntry("alpha");
			const val = Option.getOrThrow(entry);
			expect(val._tag).toBe("Ready");
			expect(val.project.title).toBe("Updated");
		}).pipe(Effect.provide(TestLayer)),
	);
});

// ─── Mutation: touchLastUsed ─────────────────────────────────────────────────

describe("ProjectRegistry Effect - touchLastUsed", () => {
	it.scoped("bumps lastUsed timestamp", () =>
		Effect.gen(function* () {
			const oldTimestamp = 1000;
			const project = { ...makeProject("alpha"), lastUsed: oldTimestamp };
			yield* addWithoutRelay(project);

			yield* touchLastUsed("alpha");

			const updated = yield* getProject("alpha");
			// touchLastUsed uses Date.now() which is always > 1000
			expect(updated.lastUsed).toBeGreaterThan(oldTimestamp);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("publishes InstanceStatusChanged", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));

			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* touchLastUsed("alpha");

			const msg = yield* Queue.take(sub);
			expect(msg._tag).toBe("InstanceStatusChanged");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("is a no-op for non-existent slug", () =>
		Effect.gen(function* () {
			// Should not throw
			yield* touchLastUsed("ghost");
		}).pipe(Effect.provide(TestLayer)),
	);
});

// ─── Queries ─────────────────────────────────────────────────────────────────

describe("ProjectRegistry Effect - Queries", () => {
	it.scoped("has() returns true for registered, false for unregistered", () =>
		Effect.gen(function* () {
			expect(yield* has("alpha")).toBe(false);
			yield* addWithoutRelay(makeProject("alpha"));
			expect(yield* has("alpha")).toBe(true);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("isReady() reflects current state", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			expect(yield* isReady("alpha")).toBe(false);

			yield* markReady("alpha");
			expect(yield* isReady("alpha")).toBe(true);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("getProject fails with ProjectNotFound for missing slug", () =>
		Effect.gen(function* () {
			const result = yield* getProject("ghost").pipe(
				Effect.catchTag("ProjectNotFound", (e) =>
					Effect.succeed(`not-found: ${e.slug}`),
				),
			);
			expect(result).toBe("not-found: ghost");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("allProjects() returns all projects sorted by lastUsed desc", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay({ ...makeProject("alpha"), lastUsed: 100 });
			yield* addWithoutRelay({ ...makeProject("beta"), lastUsed: 300 });
			yield* addWithoutRelay({ ...makeProject("gamma"), lastUsed: 200 });

			const all = yield* allProjects;
			expect(all.map((p) => p.slug)).toEqual(["beta", "gamma", "alpha"]);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("readyEntries() returns only Ready entries", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* addWithoutRelay(makeProject("beta"));
			yield* markReady("alpha");

			const ready = yield* readyEntries;
			expect(ready).toHaveLength(1);
			expect(ready[0]?.[0]).toBe("alpha");
			expect(ready[0]?.[1]._tag).toBe("Ready");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("slugs() returns all registered slugs", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* addWithoutRelay(makeProject("beta"));
			yield* addWithoutRelay(makeProject("gamma"));

			const allSlugs = yield* slugs;
			expect(allSlugs.sort()).toEqual(["alpha", "beta", "gamma"]);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("size() is accurate", () =>
		Effect.gen(function* () {
			expect(yield* size).toBe(0);
			yield* addWithoutRelay(makeProject("alpha"));
			expect(yield* size).toBe(1);
			yield* addWithoutRelay(makeProject("beta"));
			expect(yield* size).toBe(2);
			yield* remove("alpha");
			expect(yield* size).toBe(1);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("findByDirectory() finds entry by path", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha", "/custom/path"));

			const found = yield* findByDirectory("/custom/path");
			expect(Option.isSome(found)).toBe(true);
			expect(Option.getOrThrow(found).project.slug).toBe("alpha");

			const notFound = yield* findByDirectory("/nonexistent");
			expect(Option.isNone(notFound)).toBe(true);
		}).pipe(Effect.provide(TestLayer)),
	);
});

// ─── startRelay ──────────────────────────────────────────────────────────────

describe("ProjectRegistry Effect - startRelay", () => {
	it.scoped(
		"transitions Registering -> Ready on successful relay creation",
		() =>
			Effect.gen(function* () {
				yield* addWithoutRelay(makeProject("alpha"));
				yield* startRelay("alpha");

				const entry = yield* getEntry("alpha");
				expect(Option.getOrThrow(entry)._tag).toBe("Ready");
			}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("transitions Error -> Registering -> Ready on retry", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* markError("alpha", "first-fail");

			// Use TestLayer which has NoOpRelayCacheLive (succeeds)
			yield* startRelay("alpha");

			const entry = yield* getEntry("alpha");
			expect(Option.getOrThrow(entry)._tag).toBe("Ready");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("transitions to Error state when relay creation fails", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* startRelay("alpha");

			const entry = yield* getEntry("alpha");
			const val = Option.getOrThrow(entry);
			expect(val._tag).toBe("Error");
			if (val._tag === "Error") {
				expect(val.error).toBe("relay-boom");
			}
		}).pipe(Effect.provide(FailingRelayTestLayer)),
	);

	it.scoped("fails with ProjectNotFound for missing slug", () =>
		Effect.gen(function* () {
			const result = yield* startRelay("ghost").pipe(
				Effect.catchTag("ProjectNotFound", (e) =>
					Effect.succeed(`not-found: ${e.slug}`),
				),
			);
			expect(result).toBe("not-found: ghost");
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("fails with ProjectAlreadyReady for ready slug", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* markReady("alpha");

			const result = yield* startRelay("alpha").pipe(
				Effect.catchTag("ProjectAlreadyReady", (e) =>
					Effect.succeed(`already-ready: ${e.slug}`),
				),
			);
			expect(result).toBe("already-ready: alpha");
		}).pipe(Effect.provide(TestLayer)),
	);
});

// ─── removeAll ───────────────────────────────────────────────────────────────

describe("ProjectRegistry Effect - removeAll", () => {
	it.scoped("removes all projects, empties state", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* addWithoutRelay(makeProject("beta"));
			yield* addWithoutRelay(makeProject("gamma"));

			yield* removeAll;

			expect(yield* size).toBe(0);
			expect(yield* has("alpha")).toBe(false);
			expect(yield* has("beta")).toBe(false);
			expect(yield* has("gamma")).toBe(false);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("publishes InstanceRemoved for each project", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* addWithoutRelay(makeProject("beta"));

			const bus = yield* DaemonEventBusTag;
			const sub = yield* PubSub.subscribe(bus);

			yield* removeAll;

			const msg1 = yield* Queue.take(sub);
			const msg2 = yield* Queue.take(sub);
			const tags = [msg1._tag, msg2._tag];
			expect(tags).toEqual(["InstanceRemoved", "InstanceRemoved"]);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("is a no-op when registry is empty", () =>
		Effect.gen(function* () {
			yield* removeAll;
			expect(yield* size).toBe(0);
		}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped(
		"caps relay invalidation concurrency without dropping projects",
		() =>
			Effect.gen(function* () {
				const projectCount = 7;
				const maxAllowedConcurrency = 4;
				const current = yield* Ref.make(0);
				const maxObserved = yield* Ref.make(0);
				const invalidated = yield* Ref.make<ReadonlyArray<string>>([]);
				const firstInvalidationStarted = yield* Deferred.make<void>();
				const releaseInvalidations = yield* Deferred.make<void>();
				const TrackingRelayCacheLive = Layer.succeed(RelayCacheTag, {
					get: (slug: string) =>
						Effect.succeed({
							slug,
							wsHandler: { handleUpgrade: () => {} },
							rpcWsHandler: { handleUpgrade: () => {} },
							stop: () => {},
						}),
					peek: () => Effect.succeed(Option.none()),
					invalidate: (slug: string) =>
						Effect.gen(function* () {
							const inFlight = yield* Ref.updateAndGet(current, (n) => n + 1);
							yield* Ref.update(maxObserved, (n) => Math.max(n, inFlight));
							yield* Deferred.succeed(firstInvalidationStarted, void 0).pipe(
								Effect.ignore,
							);
							yield* Deferred.await(releaseInvalidations);
							yield* Ref.update(invalidated, (slugs) => [...slugs, slug]);
							yield* Ref.update(current, (n) => n - 1);
						}),
				} satisfies RelayCache);
				const TrackingLayer = Layer.fresh(
					Layer.mergeAll(
						makeProjectRegistryLive(),
						DaemonEventBusLive,
						TrackingRelayCacheLive,
						ConfigPersistenceNoopLive,
					),
				);

				yield* Effect.gen(function* () {
					for (let index = 0; index < projectCount; index++) {
						yield* addWithoutRelay(makeProject(`project-${index}`));
					}

					const fiber = yield* Effect.fork(removeAll);
					yield* Deferred.await(firstInvalidationStarted);
					for (let index = 0; index < maxAllowedConcurrency; index++) {
						yield* Effect.yieldNow();
					}
					expect(yield* Ref.get(maxObserved)).toBe(maxAllowedConcurrency);
					yield* Deferred.succeed(releaseInvalidations, void 0);
					yield* Fiber.join(fiber);

					expect(yield* Ref.get(maxObserved)).toBeLessThanOrEqual(
						maxAllowedConcurrency,
					);
					expect(new Set(yield* Ref.get(invalidated)).size).toBe(projectCount);
					expect(yield* size).toBe(0);
				}).pipe(Effect.provide(TrackingLayer));
			}),
	);
});

// ─── Multi-step lifecycle ────────────────────────────────────────────────────

describe("ProjectRegistry Effect - Multi-step lifecycle", () => {
	it.scoped(
		"full lifecycle: add -> markReady -> update -> touchLastUsed -> remove",
		() =>
			Effect.gen(function* () {
				const project = makeProject("alpha");
				yield* addWithoutRelay(project);
				expect(yield* has("alpha")).toBe(true);
				expect(yield* isReady("alpha")).toBe(false);

				yield* markReady("alpha");
				expect(yield* isReady("alpha")).toBe(true);

				yield* updateProject("alpha", { title: "New Title" });
				const updated = yield* getProject("alpha");
				expect(updated.title).toBe("New Title");

				yield* touchLastUsed("alpha");
				const touched = yield* getProject("alpha");
				expect(touched.lastUsed).toBeDefined();

				yield* remove("alpha");
				expect(yield* has("alpha")).toBe(false);
				expect(yield* size).toBe(0);
			}).pipe(Effect.provide(TestLayer)),
	);

	it.scoped("multiple projects with different states", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(makeProject("alpha"));
			yield* addWithoutRelay(makeProject("beta"));
			yield* addWithoutRelay(makeProject("gamma"));

			yield* markReady("alpha");
			yield* markError("beta", "fail");
			// gamma stays Registering

			const entryAlpha = yield* getEntry("alpha");
			const entryBeta = yield* getEntry("beta");
			const entryGamma = yield* getEntry("gamma");

			expect(Option.getOrThrow(entryAlpha)._tag).toBe("Ready");
			expect(Option.getOrThrow(entryBeta)._tag).toBe("Error");
			expect(Option.getOrThrow(entryGamma)._tag).toBe("Registering");

			const ready = yield* readyEntries;
			expect(ready).toHaveLength(1);

			const all = yield* allProjects;
			expect(all).toHaveLength(3);
		}).pipe(Effect.provide(TestLayer)),
	);
});
