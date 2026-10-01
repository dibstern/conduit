import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Queue } from "effect";
import { afterEach, expect } from "vitest";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	DaemonEventBusLive,
	subscribeToDaemonEvents,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addWithoutRelay,
	broadcastToAll,
	evictOldestSessions,
	isStarting,
	makeProjectRegistryLive,
	markReady,
	projectInfos,
	waitForRelay,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type RelayCache,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { daemonSessionGitCache } from "../../../src/lib/git/session-git.js";
import type { StoredProject } from "../../../src/lib/types.js";

const testProject: StoredProject = {
	slug: "test-project",
	directory: "/tmp/test",
	title: "Test Project",
	lastUsed: Date.now(),
};

const fixtureDirs: string[] = [];
afterEach(() => {
	for (const directory of fixtureDirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** Stub RelayCache that records calls for assertions. */
const makeStubRelayCache = (): RelayCache => ({
	get: (_slug: string) =>
		Effect.succeed({
			slug: _slug,
			attach: () => () => {},
			wsHandler: {},
			rpcWsHandler: {},
			stop: () => {},
		}),
	peek: () => Effect.succeed(Option.none()),
	invalidate: (_slug: string) => Effect.void,
});

/** Compose a test layer with ProjectRegistry, DaemonEventBus, and a stub RelayCache. */
const testLayer = Layer.mergeAll(
	makeProjectRegistryLive(),
	DaemonEventBusLive,
	ConfigPersistenceNoopLive,
	Layer.succeed(RelayCacheTag, makeStubRelayCache()),
);

describe("projectInfos", () => {
	it.effect(
		"includes cached git for a project and omits it for an uncached one",
		() => {
			const directory = mkdtempSync(join(tmpdir(), "conduit-registry-git-"));
			fixtureDirs.push(directory);
			execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
				cwd: directory,
			});
			writeFileSync(join(directory, "tracked"), "content");
			execFileSync("git", ["add", "tracked"], { cwd: directory });
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.com",
					"commit",
					"-qm",
					"initial",
				],
				{ cwd: directory },
			);
			const cached = { ...testProject, slug: "cached", directory };
			const uncached = {
				...testProject,
				slug: "uncached",
				directory: join(directory, "other"),
			};

			return Effect.gen(function* () {
				const git = yield* Effect.promise(() =>
					daemonSessionGitCache.refresh(directory),
				);
				expect(git).toMatchObject({ branch: "main", dirty: false });
				yield* addWithoutRelay(cached);
				yield* addWithoutRelay(uncached);
				const projects = yield* projectInfos;
				expect(
					projects.find((project) => project.slug === "cached"),
				).toHaveProperty("git", git);
				expect(
					projects.find((project) => project.slug === "uncached"),
				).not.toHaveProperty("git");
			}).pipe(Effect.provide(Layer.fresh(testLayer)));
		},
	);
});

describe("broadcastToAll", () => {
	it.scoped("publishes a RelayBroadcast event to the event bus", () =>
		Effect.gen(function* () {
			const sub = yield* subscribeToDaemonEvents;
			yield* broadcastToAll({ type: "test", data: 42 });
			const event = yield* Queue.take(sub);
			expect(event._tag).toBe("RelayBroadcast");
			if (event._tag === "RelayBroadcast") {
				expect(event.message).toEqual({ type: "test", data: 42 });
			}
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

describe("waitForRelay", () => {
	it.scoped("resolves immediately if project is already Ready", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);
			yield* markReady(testProject.slug);
			// Should not timeout — project is already ready
			const result = yield* waitForRelay(testProject.slug, 1000);
			// waitForRelay returns void on success
			expect(result).toBeUndefined();
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("fails with ProjectNotFound for unknown slug", () =>
		Effect.gen(function* () {
			const result = yield* waitForRelay("nonexistent", 1000).pipe(Effect.flip);
			expect(result._tag).toBe("ProjectNotFound");
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("waits for InstanceStatusChanged then verifies Ready", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);

			// Fork the wait in background
			const fiber = yield* Effect.fork(waitForRelay(testProject.slug, 5000));

			// Simulate the project becoming ready (publishes InstanceStatusChanged)
			yield* markReady(testProject.slug);

			// The fiber should complete successfully
			yield* fiber.await;
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

describe("evictOldestSessions", () => {
	it.effect("returns empty array (stub)", () =>
		Effect.gen(function* () {
			const result = yield* evictOldestSessions(5);
			expect(result).toEqual([]);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

describe("isStarting", () => {
	it.effect("returns true for a project in Registering state", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);
			const result = yield* isStarting(testProject.slug);
			expect(result).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("returns false for a project in Ready state", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);
			yield* markReady(testProject.slug);
			const result = yield* isStarting(testProject.slug);
			expect(result).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("returns false for unknown slug", () =>
		Effect.gen(function* () {
			const result = yield* isStarting("nonexistent");
			expect(result).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});
