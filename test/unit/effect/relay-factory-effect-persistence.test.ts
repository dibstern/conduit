import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { expect, vi } from "vitest";
import { makeRelayCacheLayer } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { PortScannerTag } from "../../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import {
	HttpServerRefTag,
	RelayFactoryLive,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { VersionCheckerTag } from "../../../src/lib/domain/daemon/Layers/version-checker-layer.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { PushManagerTag } from "../../../src/lib/domain/server/Services/push-service.js";
import type {
	OpenCodeInstance,
	ProjectInfo,
} from "../../../src/lib/shared-types.js";

const createProjectRelayMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/relay/relay-stack.js", () => ({
	createProjectRelay: createProjectRelayMock,
}));

const NoopAuxiliaryDaemonServices = Layer.mergeAll(
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

describe("RelayFactoryLive Effect persistence wiring", () => {
	it.effect(
		"creates relays with persistenceDbPath but no legacy PersistenceLayer",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-effect-"));
			const projectDir = join(dir, "project");
			const server = createServer();
			createProjectRelayMock.mockResolvedValue({
				stop: vi.fn(async () => undefined),
			});

			const layer = RelayFactoryLive(join(dir, "config")).pipe(
				Layer.provide(
					Layer.mergeAll(
						DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
						ConfigPersistenceNoopLive,
						DaemonEventBusLive,
						makeProjectRegistryLive(),
						makeInstanceManagerStateLive(),
						NoopAuxiliaryDaemonServices,
					),
				),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);

				const factory = yield* RelayFactoryTag;
				yield* factory
					.create(
						{
							slug: "effect-project",
							title: "Effect Project",
							directory: projectDir,
						},
						"http://localhost:4096",
					)
					.pipe(Effect.scoped);

				expect(createProjectRelayMock).toHaveBeenCalledOnce();
				const config = createProjectRelayMock.mock.calls[0]?.[0];
				expect(config).toEqual(
					expect.objectContaining({
						persistenceDbPath: join(projectDir, ".conduit", "events.db"),
					}),
				);
				expect(config).not.toHaveProperty("persistence");
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => {
						server.close();
						rmSync(dir, { recursive: true, force: true });
						createProjectRelayMock.mockReset();
					}),
				),
			);
		},
	);

	it.effect(
		"threads Effect-owned project and instance read models into relay config",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-config-"));
			const projectDir = join(dir, "project");
			const server = createServer();
			createProjectRelayMock.mockResolvedValue({
				stop: vi.fn(async () => undefined),
			});

			const layer = RelayFactoryLive(join(dir, "config")).pipe(
				Layer.provide(
					Layer.mergeAll(
						DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
						ConfigPersistenceNoopLive,
						DaemonEventBusLive,
						makeProjectRegistryLive([
							{
								slug: "effect-project",
								title: "Effect Project",
								directory: projectDir,
								instanceId: "default",
							},
						]),
						makeInstanceManagerStateLive(
							undefined,
							[
								{
									id: "default",
									name: "Default",
									port: 4096,
									managed: false,
									url: "http://localhost:4096",
								},
							],
							{ defaultOpencodeUrl: "http://localhost:4096" },
						),
						NoopAuxiliaryDaemonServices,
					),
				),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);

				const factory = yield* RelayFactoryTag;
				yield* factory
					.create(
						{
							slug: "effect-project",
							title: "Effect Project",
							directory: projectDir,
							instanceId: "default",
						},
						"http://localhost:4096",
					)
					.pipe(Effect.scoped);

				expect(createProjectRelayMock).toHaveBeenCalledOnce();
				const config = createProjectRelayMock.mock.calls[0]?.[0];
				expect(config?.getProjects).toBeTypeOf("function");
				expect(config?.getInstances).toBeTypeOf("function");

				const projects = yield* Effect.tryPromise({
					try: () => Promise.resolve(config?.getProjects?.() ?? []),
					catch: (cause) => cause,
				});
				const instances = yield* Effect.tryPromise<
					ReadonlyArray<Readonly<OpenCodeInstance>>,
					unknown
				>({
					try: () => Promise.resolve(config?.getInstances?.() ?? []),
					catch: (cause) => cause,
				});

				expect(projects).toEqual([
					{
						slug: "effect-project",
						title: "Effect Project",
						directory: projectDir,
						instanceId: "default",
					},
				]);
				expect(instances).toEqual([
					expect.objectContaining({
						id: "default",
						name: "Default",
						port: 4096,
						managed: false,
					}),
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => {
						server.close();
						rmSync(dir, { recursive: true, force: true });
						createProjectRelayMock.mockReset();
					}),
				),
			);
		},
	);

	it.effect("threads Effect-owned instance mutators into relay config", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-instance-"));
		const projectDir = join(dir, "project");
		const server = createServer();
		createProjectRelayMock.mockResolvedValue({
			stop: vi.fn(async () => undefined),
		});

		const layer = RelayFactoryLive(join(dir, "config")).pipe(
			Layer.provide(
				Layer.mergeAll(
					DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
					ConfigPersistenceNoopLive,
					DaemonEventBusLive,
					makeProjectRegistryLive([
						{
							slug: "effect-project",
							title: "Effect Project",
							directory: projectDir,
						},
					]),
					makeInstanceManagerStateLive(),
					NoopAuxiliaryDaemonServices,
				),
			),
		);

		return Effect.gen(function* () {
			const httpServerRef = yield* HttpServerRefTag;
			yield* Ref.set(httpServerRef, server);

			const factory = yield* RelayFactoryTag;
			yield* factory
				.create(
					{
						slug: "effect-project",
						title: "Effect Project",
						directory: projectDir,
					},
					"http://localhost:4096",
				)
				.pipe(Effect.scoped);

			const config = createProjectRelayMock.mock.calls[0]?.[0];
			expect(config?.addInstance).toBeTypeOf("function");
			expect(config?.removeInstance).toBeTypeOf("function");
			expect(config?.updateInstance).toBeTypeOf("function");
			expect(config?.persistConfig).toBeTypeOf("function");

			const added = yield* Effect.tryPromise({
				try: () =>
					Promise.resolve(
						config?.addInstance?.("remote", {
							name: "Remote",
							port: 4321,
							managed: false,
							url: "http://remote.example.test",
						}),
					),
				catch: (cause) => cause,
			});
			expect(added).toEqual(
				expect.objectContaining({
					id: "remote",
					name: "Remote",
					port: 4321,
					managed: false,
				}),
			);

			const updated = yield* Effect.tryPromise({
				try: () =>
					Promise.resolve(
						config?.updateInstance?.("remote", {
							name: "Renamed",
							port: 4322,
						}),
					),
				catch: (cause) => cause,
			});
			expect(updated).toEqual(
				expect.objectContaining({
					id: "remote",
					name: "Renamed",
					port: 4322,
				}),
			);

			yield* Effect.tryPromise({
				try: () => Promise.resolve(config?.removeInstance?.("remote")),
				catch: (cause) => cause,
			});
			const instances = yield* Effect.tryPromise({
				try: () => Promise.resolve(config?.getInstances?.() ?? []),
				catch: (cause) => cause,
			});
			expect(
				instances.some(
					(instance: Readonly<OpenCodeInstance>) => instance.id === "remote",
				),
			).toBe(false);
		}).pipe(
			Effect.provide(Layer.fresh(layer)),
			Effect.ensuring(
				Effect.sync(() => {
					server.close();
					rmSync(dir, { recursive: true, force: true });
					createProjectRelayMock.mockReset();
				}),
			),
		);
	});

	it.effect("threads auxiliary daemon services into relay config", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-aux-"));
		const projectDir = join(dir, "project");
		const server = createServer();
		const scanResult = {
			discovered: [4321],
			lost: [4320],
			active: [4321, 4322],
		};
		const pushManager = {
			getPublicKey: () => "public-key",
			addSubscription: vi.fn(),
			removeSubscription: vi.fn(),
			sendToAll: vi.fn(async () => undefined),
		};
		createProjectRelayMock.mockResolvedValue({
			stop: vi.fn(async () => undefined),
		});

		const layer = RelayFactoryLive(join(dir, "config")).pipe(
			Layer.provide(
				Layer.mergeAll(
					DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
					ConfigPersistenceNoopLive,
					DaemonEventBusLive,
					makeProjectRegistryLive([
						{
							slug: "effect-project",
							title: "Effect Project",
							directory: projectDir,
						},
					]),
					makeInstanceManagerStateLive(),
					Layer.succeed(PortScannerTag, {
						getKnownPorts: () => Effect.succeed(new Set([4321, 4322])),
						scanNow: () => Effect.succeed(scanResult),
					}),
					Layer.succeed(VersionCheckerTag, {
						getLatestKnown: () => Effect.succeed("9.9.9"),
						getCurrentVersion: () => Effect.succeed("1.0.0"),
					}),
					Layer.succeed(PushManagerTag, {
						subscribe: () => Effect.void,
						unsubscribe: () => Effect.void,
						broadcast: () => Effect.void,
						getPublicKey: Effect.succeed("public-key"),
						addSubscription: () => Effect.void,
						removeSubscription: () => Effect.void,
						sendToAll: () => Effect.void,
						getLegacyManager: Effect.succeed(Option.some(pushManager)),
					}),
				),
			),
		);

		return Effect.gen(function* () {
			const httpServerRef = yield* HttpServerRefTag;
			yield* Ref.set(httpServerRef, server);

			const factory = yield* RelayFactoryTag;
			yield* factory
				.create(
					{
						slug: "effect-project",
						title: "Effect Project",
						directory: projectDir,
					},
					"http://localhost:4096",
				)
				.pipe(Effect.scoped);

			const config = createProjectRelayMock.mock.calls[0]?.[0];
			expect(config?.triggerScan).toBeTypeOf("function");
			expect(config?.getCachedUpdate).toBeTypeOf("function");
			expect(config?.pushManager).toBe(pushManager);
			const triggerScan = config?.triggerScan;
			const getCachedUpdate = config?.getCachedUpdate;
			if (triggerScan == null || getCachedUpdate == null) {
				expect.fail("expected relay auxiliary callbacks");
			}

			const scan = yield* Effect.tryPromise({
				try: () => triggerScan(),
				catch: (cause) => cause,
			});
			expect(scan).toEqual(scanResult);

			const cachedUpdate = yield* Effect.tryPromise({
				try: () => Promise.resolve(getCachedUpdate()),
				catch: (cause) => cause,
			});
			expect(cachedUpdate).toBe("9.9.9");
		}).pipe(
			Effect.provide(Layer.fresh(layer)),
			Effect.ensuring(
				Effect.sync(() => {
					server.close();
					rmSync(dir, { recursive: true, force: true });
					createProjectRelayMock.mockReset();
				}),
			),
		);
	});

	it.effect(
		"threads relay-cache-owned project mutators into relay config",
		() => {
			const dir = mkdtempSync(
				join(tmpdir(), "conduit-relay-project-mutators-"),
			);
			const projectDir = join(dir, "project");
			const server = createServer();
			const firstStop = vi.fn(async () => undefined);
			const secondStop = vi.fn(async () => undefined);
			createProjectRelayMock
				.mockResolvedValueOnce({
					stop: firstStop,
				})
				.mockResolvedValueOnce({
					stop: secondStop,
				});

			const baseLayer = Layer.mergeAll(
				DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
				ConfigPersistenceNoopLive,
				DaemonEventBusLive,
				makeProjectRegistryLive([
					{
						slug: "effect-project",
						title: "Effect Project",
						directory: projectDir,
						instanceId: "default",
					},
				]),
				makeInstanceManagerStateLive(
					undefined,
					[
						{
							id: "default",
							name: "Default",
							port: 4096,
							managed: false,
							url: "http://localhost:4096",
						},
						{
							id: "remote",
							name: "Remote",
							port: 4321,
							managed: false,
							url: "http://localhost:4321",
						},
					],
					{ defaultOpencodeUrl: "http://localhost:4096" },
				),
				NoopAuxiliaryDaemonServices,
			);
			const layer = makeRelayCacheLayer.pipe(
				Layer.provideMerge(RelayFactoryLive(join(dir, "config"))),
				Layer.provide(baseLayer),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);

				const cache = yield* RelayCacheTag;
				yield* cache.get("effect-project");

				const config = createProjectRelayMock.mock.calls[0]?.[0];
				expect(config?.addProject).toBeTypeOf("function");
				expect(config?.removeProject).toBeTypeOf("function");
				expect(config?.setProjectTitle).toBeTypeOf("function");
				expect(config?.setProjectInstance).toBeTypeOf("function");
				const addProject = config?.addProject;
				const removeProject = config?.removeProject;
				const setProjectTitle = config?.setProjectTitle;
				const setProjectInstance = config?.setProjectInstance;
				const getProjects = config?.getProjects;
				if (
					addProject == null ||
					removeProject == null ||
					setProjectTitle == null ||
					setProjectInstance == null ||
					getProjects == null
				) {
					expect.fail("expected project mutation callbacks");
				}

				const added = yield* Effect.tryPromise<ProjectInfo, unknown>({
					try: () => addProject(join(dir, "added"), "remote"),
					catch: (cause) => cause,
				});
				expect(added).toEqual(
					expect.objectContaining({
						title: "added",
						directory: join(dir, "added"),
						instanceId: "remote",
					}),
				);

				yield* Effect.tryPromise({
					try: () =>
						Promise.resolve(setProjectTitle(added.slug, "Added Project")),
					catch: (cause) => cause,
				});
				let projects = yield* Effect.tryPromise<
					ReadonlyArray<ProjectInfo>,
					unknown
				>({
					try: () => Promise.resolve(getProjects()),
					catch: (cause) => cause,
				});
				expect(projects).toContainEqual(
					expect.objectContaining({
						slug: added.slug,
						title: "Added Project",
						instanceId: "remote",
					}),
				);

				yield* Effect.tryPromise({
					try: () => Promise.resolve(removeProject(added.slug)),
					catch: (cause) => cause,
				});
				projects = yield* Effect.tryPromise<
					ReadonlyArray<ProjectInfo>,
					unknown
				>({
					try: () => Promise.resolve(getProjects()),
					catch: (cause) => cause,
				});
				expect(projects.some((project) => project.slug === added.slug)).toBe(
					false,
				);

				yield* Effect.tryPromise({
					try: () =>
						Promise.resolve(setProjectInstance("effect-project", "remote")),
					catch: (cause) => cause,
				});
				projects = yield* Effect.tryPromise<
					ReadonlyArray<ProjectInfo>,
					unknown
				>({
					try: () => Promise.resolve(getProjects()),
					catch: (cause) => cause,
				});
				expect(projects).toContainEqual(
					expect.objectContaining({
						slug: "effect-project",
						instanceId: "remote",
					}),
				);
				expect(firstStop).toHaveBeenCalledOnce();
				expect(createProjectRelayMock).toHaveBeenCalledTimes(2);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => {
						server.close();
						rmSync(dir, { recursive: true, force: true });
						createProjectRelayMock.mockReset();
					}),
				),
			);
		},
	);
});
