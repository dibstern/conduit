// Tests for WebSocketRoutingLive and SessionPrefetchLive.
// Covers session prefetch, missing directories, and scoped fiber lifecycle.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, HashMap, Layer, Ref, Scope } from "effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import { HttpServerRefTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import {
	prefetchSessionCounts,
	SessionPrefetchLive,
} from "../../../src/lib/domain/daemon/Layers/session-prefetch-layer.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	makeProjectRegistryFromDaemonStateLive,
	makeProjectRegistryLive,
	ProjectRegistryTag,
	type ProjectState,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
	WebSocketUpgradeError,
} from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";

import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";

const configRefLayer = DaemonConfigRefLive(
	makeDaemonConfigFromOptions({ port: 2633 }),
);

const authLayer = makeAuthManagerLive(
	new AuthManager({ getPinHash: () => null }),
);
const wsRelayRouterLayer = Layer.succeed(WebSocketRelayRouterTag, {
	ensureRelayStarted: () => Effect.void,
	waitForRelay: (slug: string) =>
		Effect.fail(
			new WebSocketUpgradeError({
				reason: "relay_unavailable",
				slug,
				cause: new Error("No relay configured in this test"),
			}),
		),
	touchLastUsed: () => Effect.void,
});
const httpServerRefWithServerLayer = Layer.effect(
	HttpServerRefTag,
	Effect.flatMap(
		Effect.sync(() => createServer()),
		(server) => Ref.make<Server | null>(server),
	),
);

const registryLayer = makeProjectRegistryLive();
const sessions = (count: number) =>
	Array.from({ length: count }, (_, i) => ({ id: `s${i}` })) as SessionDetail[];

/** OpenCode Instances whose running instances list the given sessions. */
const makeInstancesLayer = (
	lists: Readonly<Record<string, () => Promise<SessionDetail[]>>>,
	calls: Array<[string, string | undefined]> = [],
) => {
	const stub = makeOpenCodeInstancesStub(
		Object.fromEntries(
			Object.entries(lists).map(([id, list]) => {
				const client = makeMockOpenCodeAPI();
				vi.mocked(client.session.list).mockImplementation(list);
				return [id, client];
			}),
		),
	);
	return Layer.succeed(OpenCodeInstancesTag, {
		...stub,
		ifRunning: (instanceId: string, directory?: string) => {
			calls.push([instanceId, directory]);
			return stub.ifRunning(instanceId, directory);
		},
	});
};

const makeSeededRegistryLayer = (entries: Array<[string, ProjectState]>) =>
	Layer.effect(ProjectRegistryTag, Ref.make(HashMap.fromIterable(entries)));

describe("WebSocketRoutingLive", () => {
	const wsLayer = WebSocketRoutingLive.pipe(
		Layer.provide(makeDaemonRpcTestLayer()),
		Layer.provide(configRefLayer),
		Layer.provide(httpServerRefWithServerLayer),
		Layer.provide(authLayer),
		Layer.provide(wsRelayRouterLayer),
	);

	it.scoped("builds without error", () =>
		Effect.sync(() => {
			expect(true).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(wsLayer))),
	);

	it.scoped("resolves all dependency Tags from context", () =>
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			expect(configRef).toBeDefined();
		}).pipe(
			Effect.provide(
				Layer.fresh(wsLayer.pipe(Layer.provideMerge(configRefLayer))),
			),
		),
	);

	it.scoped("finalizer runs on scope close without error", () =>
		Effect.gen(function* () {
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(Layer.fresh(wsLayer), scope);
			yield* Scope.close(scope, Exit.void);
		}),
	);
});

// prefetchSessionCounts (direct invocation)

describe("prefetchSessionCounts", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "conduit-prefetch-"));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	const readyProject = (
		slug: string,
		instanceId: string,
		folder = directory,
	): [string, ProjectState] => [
		slug,
		{
			_tag: "Ready",
			project: {
				slug,
				folders: [folder],
				title: slug,
				lastUsed: Date.now(),
				instanceId,
			},
		},
	];

	it.scoped(
		"does not ask for an instance for a missing project directory",
		() => {
			const calls: Array<[string, string | undefined]> = [];
			return Effect.gen(function* () {
				const count = yield* prefetchSessionCounts;
				expect(count).toBe(0);
				expect(calls).toEqual([]);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						Layer.mergeAll(
							configRefLayer,
							makeInstancesLayer({ i1: async () => sessions(1) }, calls),
							makeSeededRegistryLayer([
								readyProject("missing", "i1", join(directory, "missing")),
							]),
						),
					),
				),
			);
		},
	);

	it.scoped("returns 0 when no projects registered", () =>
		Effect.gen(function* () {
			const count = yield* prefetchSessionCounts;
			expect(count).toBe(0);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					Layer.mergeAll(configRefLayer, makeInstancesLayer({}), registryLayer),
				),
			),
		),
	);

	it.scoped("skips projects with existing persisted session counts", () => {
		const calls: Array<[string, string | undefined]> = [];
		return Effect.gen(function* () {
			const count = yield* prefetchSessionCounts;
			expect(count).toBe(0);
			expect(calls).toEqual([]);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					Layer.mergeAll(
						DaemonConfigRefLive(
							makeDaemonConfigFromOptions({
								port: 2633,
								persistedSessionCounts: new Map([["my-project", 5]]),
							}),
						),
						makeInstancesLayer({ i1: async () => sessions(3) }, calls),
						makeSeededRegistryLayer([readyProject("my-project", "i1")]),
					),
				),
			),
		);
	});

	it.scoped("returns 0 when the project's instance is not running", () =>
		Effect.gen(function* () {
			const count = yield* prefetchSessionCounts;
			expect(count).toBe(0);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					Layer.mergeAll(
						configRefLayer,
						makeInstancesLayer({}),
						makeSeededRegistryLayer([readyProject("orphan", "nonexistent")]),
					),
				),
			),
		),
	);

	it.scoped("counts and persists sessions from a running instance", () =>
		Effect.gen(function* () {
			const count = yield* prefetchSessionCounts;
			expect(count).toBe(1);

			const configRef = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(configRef);
			expect(config.persistedSessionCounts.get("my-project")).toBe(3);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					Layer.provideMerge(
						Layer.mergeAll(
							makeInstancesLayer({ i1: async () => sessions(3) }),
							makeSeededRegistryLayer([readyProject("my-project", "i1")]),
						),
						DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 2633 })),
					),
				),
			),
		),
	);

	it.scoped("uses daemon-state seeded projects", () => {
		const calls: Array<[string, string | undefined]> = [];
		return Effect.gen(function* () {
			const count = yield* prefetchSessionCounts;
			expect(count).toBe(1);
			expect(calls).toEqual([["default", directory]]);

			const configRef = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(configRef);
			expect(config.persistedSessionCounts.get("seeded-project")).toBe(2);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					Layer.mergeAll(
						DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 2633 })),
						makeInstancesLayer({ default: async () => sessions(2) }, calls),
						makeProjectRegistryFromDaemonStateLive.pipe(
							Layer.provide(
								makeDaemonStateLive({
									projects: [
										{
											slug: "seeded-project",
											path: directory,
											folders: [directory],
											title: "Seeded Project",
											addedAt: 1,
											instanceId: "default",
										},
									],
								}),
							),
						),
					),
				),
			),
		);
	});

	it.scoped(
		"a failed session list for one project does not prevent others from prefetching",
		() =>
			Effect.gen(function* () {
				const count = yield* prefetchSessionCounts;
				// One project succeeds, one fails — total fetched should be 1
				expect(count).toBe(1);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						Layer.provideMerge(
							Layer.mergeAll(
								makeInstancesLayer({
									i1: async () => sessions(1),
									i2: () => Promise.reject(new Error("network error")),
								}),
								makeSeededRegistryLayer([
									readyProject("proj-a", "i1"),
									readyProject("proj-b", "i2"),
								]),
							),
							DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 2633 })),
						),
					),
				),
			),
	);
});

describe("SessionPrefetchLive", () => {
	const prefetchLayer = SessionPrefetchLive.pipe(
		Layer.provide(configRefLayer),
		Layer.provide(makeInstancesLayer({})),
		Layer.provide(registryLayer),
	);

	it.scoped("builds without error", () =>
		Effect.sync(() => {
			expect(true).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(prefetchLayer))),
	);
});

describe("Scoped fiber lifecycle", () => {
	it.effect("Effect.forkScoped fibers are interrupted when scope closes", () =>
		Effect.gen(function* () {
			const wasInterrupted = yield* Deferred.make<void>();
			const fiberStarted = yield* Deferred.make<void>();

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* Effect.forkScoped(
						Effect.gen(function* () {
							// Signal that fiber has reached the blocking point
							yield* Deferred.succeed(fiberStarted, void 0);
							yield* Effect.never;
						}).pipe(
							Effect.onInterrupt(() =>
								Deferred.succeed(wasInterrupted, void 0),
							),
						),
					);
					// Wait for fiber to start before scope closes
					yield* Deferred.await(fiberStarted);
				}),
			);

			// After Effect.scoped completes, fiber was interrupted
			expect(yield* Deferred.isDone(wasInterrupted)).toBe(true);
		}),
	);

	it.scoped("SessionPrefetchLive scope close tears down cleanly", () =>
		Effect.gen(function* () {
			const layer = Layer.fresh(
				SessionPrefetchLive.pipe(
					Layer.provide(configRefLayer),
					Layer.provide(makeInstancesLayer({})),
					Layer.provide(registryLayer),
				),
			);
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(layer, scope);
			yield* Scope.close(scope, Exit.void);
		}),
	);

	it.scoped("WebSocketRoutingLive scope close tears down cleanly", () =>
		Effect.gen(function* () {
			const layer = Layer.fresh(
				WebSocketRoutingLive.pipe(
					Layer.provide(makeDaemonRpcTestLayer()),
					Layer.provide(configRefLayer),
					Layer.provide(httpServerRefWithServerLayer),
					Layer.provide(authLayer),
					Layer.provide(wsRelayRouterLayer),
				),
			);
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(layer, scope);
			yield* Scope.close(scope, Exit.void);
		}),
	);
});
