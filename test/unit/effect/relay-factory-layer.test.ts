import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Queue, Ref } from "effect";
import { expect, vi } from "vitest";
import { PortScannerTag } from "../../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import {
	HttpServerRefLive,
	HttpServerRefTag,
	RelayFactoryError,
	RelayFactoryLive,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { VersionCheckerTag } from "../../../src/lib/domain/daemon/Layers/version-checker-layer.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonEventBusLive,
	subscribeToDaemonEvents,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { InstanceHealthCheckLive } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	addWithoutRelay,
	makeProjectRegistryLive,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { PushManagerTag } from "../../../src/lib/domain/server/Services/push-service.js";
import type { ProjectRelay } from "../../../src/lib/relay/relay-stack.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";

const createProjectRelayMock = vi.hoisted(() =>
	vi.fn<(config: ProjectRelayConfig) => Promise<ProjectRelay>>(),
);
vi.mock("../../../src/lib/relay/relay-stack.js", () => ({
	createProjectRelay: createProjectRelayMock,
}));

// ─── HttpServerRefTag tests ─────────────────────────────────────────────────

describe("HttpServerRefTag", () => {
	const testLayer = HttpServerRefLive;

	it.effect("initializes with null", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			const value = yield* Ref.get(ref);
			expect(value).toBeNull();
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("can be set to a mock server value", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			// Use a plain object as a mock http.Server
			const mockServer = {
				listening: true,
			} as unknown as import("node:http").Server;
			yield* Ref.set(ref, mockServer);
			const value = yield* Ref.get(ref);
			expect(value).toBe(mockServer);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("can be reset to null", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			const mockServer = {
				listening: true,
			} as unknown as import("node:http").Server;
			yield* Ref.set(ref, mockServer);
			yield* Ref.set(ref, null);
			const value = yield* Ref.get(ref);
			expect(value).toBeNull();
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

// ─── RelayFactoryTag tests ──────────────────────────────────────────────────

describe("RelayFactoryTag", () => {
	const configLayer = Layer.mergeAll(
		InstanceHealthCheckLive,
		DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
		ConfigPersistenceNoopLive,
		DaemonEventBusLive,
		makeProjectRegistryLive(),
		makeInstanceManagerStateLive(),
		Layer.succeed(PortScannerTag, {
			getKnownPorts: () => Effect.succeed(new Set<number>()),
			scanNow: () => Effect.succeed({ discovered: [], lost: [], active: [] }),
		}),
		Layer.succeed(VersionCheckerTag, {
			getLatestKnown: () => Effect.succeed(null),
			getCurrentVersion: () => Effect.succeed("unknown"),
		}),
		Layer.succeed(PushManagerTag, {
			subscribe: () => Effect.void,
			unsubscribe: () => Effect.void,
			broadcast: () => Effect.void,
			getPublicKey: Effect.succeed(undefined),
			addSubscription: () => Effect.void,
			removeSubscription: () => Effect.void,
			sendToAll: () => Effect.void,
			getLegacyManager: Effect.succeed(Option.none()),
		}),
	);

	// RelayFactoryLive provides both RelayFactoryTag and HttpServerRefTag.
	// It requires DaemonConfigRefTag from the caller.
	const factoryLayer = RelayFactoryLive("/tmp/test-conduit").pipe(
		Layer.provideMerge(configLayer),
	);

	it.effect("resolves from the Layer", () =>
		Effect.gen(function* () {
			const factory = yield* RelayFactoryTag;
			expect(factory).toBeDefined();
			expect(typeof factory.create).toBe("function");
		}).pipe(Effect.provide(Layer.fresh(factoryLayer))),
	);

	it.effect("also provides HttpServerRefTag", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			const value = yield* Ref.get(ref);
			// HttpServerRefLive initializes to null
			expect(value).toBeNull();
		}).pipe(Effect.provide(Layer.fresh(factoryLayer))),
	);

	it.effect("create fails with RelayFactoryError when httpServer is null", () =>
		Effect.gen(function* () {
			const factory = yield* RelayFactoryTag;
			const project = {
				slug: "test-project",
				directory: "/tmp/test-project",
				title: "Test Project",
			};

			const result = yield* factory
				.create(project, "http://localhost:4096")
				.pipe(Effect.scoped, Effect.either);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				const error = result.left;
				expect(error).toBeInstanceOf(RelayFactoryError);
				expect(error._tag).toBe("RelayFactoryError");
				expect(error.reason).toBe("HTTP server not started");
			}
		}).pipe(Effect.provide(Layer.fresh(factoryLayer))),
	);

	it.effect("broadcasts project_list only when refreshed git changes", () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-relay-git-"));
		const server = createServer();
		execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
			cwd: directory,
		});
		createProjectRelayMock.mockResolvedValue({
			stop: async () => undefined,
		} as ProjectRelay);
		return Effect.gen(function* () {
			const project = { slug: "git-project", title: "Git Project", directory };
			yield* addWithoutRelay(project);
			const subscription = yield* subscribeToDaemonEvents;
			const serverRef = yield* HttpServerRefTag;
			yield* Ref.set(serverRef, server);
			const factory = yield* RelayFactoryTag;
			yield* factory.create(project, "http://localhost:4096");
			const config = createProjectRelayMock.mock.calls[0]?.[0];
			expect(config?.refreshSessionGit).toBeTypeOf("function");
			if (!config?.refreshSessionGit)
				throw new Error("Missing git refresh callback");

			yield* Effect.promise(config.refreshSessionGit);
			const first = yield* Queue.take(subscription);
			expect(first).toMatchObject({
				_tag: "RelayBroadcast",
				message: {
					type: "project_list",
					projects: [
						{
							slug: "git-project",
							git: { branch: "main", dirty: false },
						},
					],
				},
			});
			yield* Queue.take(subscription); // daemon_sessions_changed
			yield* Effect.promise(config.refreshSessionGit);
			expect(Array.from(yield* Queue.takeAll(subscription))).toHaveLength(0);

			writeFileSync(join(directory, "untracked"), "changed");
			yield* Effect.promise(config.refreshSessionGit);
			const changed = yield* Queue.take(subscription);
			expect(changed).toMatchObject({
				_tag: "RelayBroadcast",
				message: {
					type: "project_list",
					projects: [{ slug: "git-project", git: { dirty: true } }],
				},
			});
			yield* Queue.take(subscription);
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.fresh(factoryLayer)),
			Effect.ensuring(
				Effect.sync(() => {
					server.close();
					rmSync(directory, { recursive: true, force: true });
					createProjectRelayMock.mockReset();
				}),
			),
		);
	});
});

// ─── RelayFactoryError tests ────────────────────────────────────────────────

describe("RelayFactoryError", () => {
	it("has correct tag", () => {
		const err = new RelayFactoryError({ reason: "test" });
		expect(err._tag).toBe("RelayFactoryError");
	});

	it("message includes reason", () => {
		const err = new RelayFactoryError({ reason: "server not started" });
		expect(err.message).toBe("server not started");
	});

	it("message includes cause when present", () => {
		const cause = new Error("connection refused");
		const err = new RelayFactoryError({
			reason: "failed to connect",
			cause,
		});
		expect(err.message).toBe("failed to connect: connection refused");
	});

	it("works with Effect.catchTag", () => {
		const program = Effect.gen(function* () {
			return yield* new RelayFactoryError({ reason: "test error" });
		}).pipe(
			Effect.catchTag("RelayFactoryError", (e) =>
				Effect.succeed(`caught: ${e.reason}`),
			),
		);

		const result = Effect.runSync(program);
		expect(result).toBe("caught: test error");
	});
});
