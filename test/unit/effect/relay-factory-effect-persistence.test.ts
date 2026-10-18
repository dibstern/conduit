import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Option, Ref } from "effect";
import { expect, vi } from "vitest";
import { makeRelayCacheLayer } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { PortScannerTag } from "../../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import {
	HttpServerRefTag,
	RelayFactoryLive,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { InstanceHealthCheckLive } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { DaemonSessionQueryServiceTag } from "../../../src/lib/domain/relay/Services/daemon-session-query-service.js";
import { InstanceManagementServiceTag } from "../../../src/lib/domain/relay/Services/instance-management-service.js";
import { ProjectManagementServiceTag } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import { ScanServiceTag } from "../../../src/lib/domain/relay/Services/scan-service.js";
import { PushManagerTag } from "../../../src/lib/domain/server/Services/push-service.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeDaemonStoreTestLayer } from "../../helpers/daemon-rpc.js";
import { makeOpenCodeInstancesStub } from "../../helpers/mock-factories.js";

const createProjectRelayMock = vi.hoisted(() =>
	vi.fn<(config: ProjectRelayConfig) => Promise<unknown>>(),
);

vi.mock("../../../src/lib/relay/relay-stack.js", () => ({
	createProjectRelay: createProjectRelayMock,
}));

const NoopAuxiliaryDaemonServices = Layer.mergeAll(
	makeDaemonStoreTestLayer(),
	Layer.succeed(OpenCodeInstancesTag, makeOpenCodeInstancesStub()),
	InstanceHealthCheckLive,
	Layer.succeed(PortScannerTag, {
		getKnownPorts: () => Effect.succeed(new Set<number>()),
		scanNow: () => Effect.succeed({ discovered: [], lost: [], active: [] }),
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
		"creates relays with persistenceDbPath but no legacy persistence object",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-effect-"));
			const projectDir = join(dir, "project");
			mkdirSync(projectDir);
			const server = createServer();
			createProjectRelayMock.mockResolvedValue({
				syncGlobalSetting: () => Effect.void,
				refreshGlobalDefaults: () => Effect.void,
				stop: vi.fn(async () => undefined),
			});

			const layer = RelayFactoryLive(join(dir, "config")).pipe(
				Layer.provide(
					Layer.mergeAll(
						DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
						ConfigPersistenceNoopLive,
						DaemonEventBusLive,
						Layer.effect(SessionActivityTag, makeSessionActivity),
						makeProjectRegistryLive(),
						makeInstanceManagerStateLive(undefined, [], {
							launchLogin: sdkDefaultClaudeConfigDir(
								"/isolated-test-home/.claude",
							),
						}),
						NoopAuxiliaryDaemonServices,
					),
				),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);

				const factory = yield* RelayFactoryTag;
				yield* factory
					.create({
						slug: "effect-project",
						title: "Effect Project",
						folders: [projectDir],
					})
					.pipe(Effect.scoped);

				expect(createProjectRelayMock).toHaveBeenCalledOnce();
				const config = createProjectRelayMock.mock.calls[0]?.[0];
				expect(config).toEqual(
					expect.objectContaining({
						persistenceDbPath: join(dir, "config", "events.db"),
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
		"provides daemon read services to the relay through its Effect context",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-config-"));
			const projectDir = join(dir, "project");
			mkdirSync(projectDir);
			const server = createServer();
			createProjectRelayMock.mockResolvedValue({
				syncGlobalSetting: () => Effect.void,
				refreshGlobalDefaults: () => Effect.void,
				stop: vi.fn(async () => undefined),
			});

			const layer = RelayFactoryLive(join(dir, "config")).pipe(
				Layer.provide(
					Layer.mergeAll(
						DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
						ConfigPersistenceNoopLive,
						DaemonEventBusLive,
						Layer.effect(SessionActivityTag, makeSessionActivity),
						makeProjectRegistryLive([
							{
								slug: "effect-project",
								title: "Effect Project",
								folders: [projectDir],
							},
						]),
						makeInstanceManagerStateLive(
							undefined,
							[
								{
									id: "opencode",
									name: "Default",
									port: 4096,
									managed: false,
									url: "http://localhost:4096",
								},
							],
							{
								...{ defaultOpencodeUrl: "http://localhost:4096" },
								launchLogin: sdkDefaultClaudeConfigDir(
									"/isolated-test-home/.claude",
								),
							},
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
					.create({
						slug: "effect-project",
						title: "Effect Project",
						folders: [projectDir],
					})
					.pipe(Effect.scoped);

				expect(createProjectRelayMock).toHaveBeenCalledOnce();
				const config = createProjectRelayMock.mock.calls[0]?.[0];
				const context = config?.daemonConfigContext;
				if (!context) throw new Error("Missing daemon Effect context");
				for (const callback of [
					"getProjects",
					"listDaemonSessions",
					"getInstances",
					"broadcastSessionListChanged",
					"publishProjectList",
					"resolveSessionProject",
				]) {
					expect(config).not.toHaveProperty(callback);
				}
				const projectService = Option.getOrThrow(
					Context.getOption(context, ProjectManagementServiceTag),
				);
				const instanceService = Option.getOrThrow(
					Context.getOption(context, InstanceManagementServiceTag),
				);
				const sessionService = Option.getOrThrow(
					Context.getOption(context, DaemonSessionQueryServiceTag),
				);
				const projects = yield* projectService.list();
				const instances = yield* instanceService.list();
				const daemonSessions = yield* sessionService.list({ limit: 5 });
				expect(config?.openCodeInstanceId).toBe(
					instances.find((instance) => instance.driver !== "claude")?.id,
				);

				expect(projects).toEqual([
					{
						slug: "effect-project",
						title: "Effect Project",
						folders: [projectDir],
						missing: false,
						repositoryIdentities: {},
						effectiveGroupingMode: "repository",
						group: {
							key: '["project","effect-project"]',
							label: "Effect Project",
							needsProjectQualifier: false,
						},
					},
				]);
				expect(instances).toEqual([
					expect.objectContaining({
						id: "opencode",
						name: "Default",
						port: 4096,
						managed: false,
					}),
				]);
				expect(daemonSessions).toEqual({
					sessions: [],
					availability: [{ projectSlug: "effect-project", available: true }],
					hasMore: false,
					nextCursor: null,
				});
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
		"provides Effect-owned instance mutations with the original typed failure",
		() => {
			const dir = mkdtempSync(
				join(tmpdir(), "conduit-relay-factory-instance-"),
			);
			const projectDir = join(dir, "project");
			mkdirSync(projectDir);
			const server = createServer();
			createProjectRelayMock.mockResolvedValue({
				syncGlobalSetting: () => Effect.void,
				refreshGlobalDefaults: () => Effect.void,
				stop: vi.fn(async () => undefined),
			});

			const layer = RelayFactoryLive(join(dir, "config")).pipe(
				Layer.provide(
					Layer.mergeAll(
						InstanceHealthCheckLive,
						Layer.succeed(OpenCodeInstancesTag, makeOpenCodeInstancesStub()),
						DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
						ConfigPersistenceNoopLive,
						DaemonEventBusLive,
						Layer.effect(SessionActivityTag, makeSessionActivity),
						makeProjectRegistryLive([
							{
								slug: "effect-project",
								title: "Effect Project",
								folders: [projectDir],
							},
						]),
						makeInstanceManagerStateLive(undefined, [], {
							launchLogin: sdkDefaultClaudeConfigDir(
								"/isolated-test-home/.claude",
							),
						}),
						NoopAuxiliaryDaemonServices,
					),
				),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);

				const factory = yield* RelayFactoryTag;
				yield* factory
					.create({
						slug: "effect-project",
						title: "Effect Project",
						folders: [projectDir],
					})
					.pipe(Effect.scoped);

				const config = createProjectRelayMock.mock.calls[0]?.[0];
				const context = config?.daemonConfigContext;
				if (!context) throw new Error("Missing daemon Effect context");
				for (const callback of [
					"addInstance",
					"removeInstance",
					"updateInstance",
					"startInstance",
					"stopInstance",
					"persistConfig",
				]) {
					expect(config).not.toHaveProperty(callback);
				}
				const service = Option.getOrThrow(
					Context.getOption(context, InstanceManagementServiceTag),
				);
				const added = yield* service.add({
					name: "Remote",
					port: 4321,
					managed: false,
					url: "http://remote.example.test",
				});
				expect(added).toContainEqual(
					expect.objectContaining({
						id: "remote",
						name: "Remote",
						port: 4321,
						managed: false,
					}),
				);
				const updated = yield* service.update("remote", {
					name: "Renamed",
					port: 4322,
				});
				expect(updated).toContainEqual(
					expect.objectContaining({
						id: "remote",
						name: "Renamed",
						port: 4322,
					}),
				);
				const missing = yield* Effect.either(
					service.update("missing", { name: "Missing" }),
				);
				expect(missing).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "InstanceManagementServiceError",
						operation: "update",
						cause: { _tag: "AccountChangeRejected", id: "missing" },
					},
				});
				const instances = yield* service.remove("remote");
				expect(instances.some((instance) => instance.id === "remote")).toBe(
					false,
				);
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

	it.effect("threads auxiliary daemon services into relay config", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-aux-"));
		const projectDir = join(dir, "project");
		mkdirSync(projectDir);
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
			sendToAll: vi.fn(async () => ({
				delivered: ["client-1"],
				expired: [],
				failed: [],
			})),
		};
		createProjectRelayMock.mockResolvedValue({
			syncGlobalSetting: () => Effect.void,
			refreshGlobalDefaults: () => Effect.void,
			stop: vi.fn(async () => undefined),
		});

		const layer = RelayFactoryLive(join(dir, "config")).pipe(
			Layer.provide(
				Layer.mergeAll(
					makeDaemonStoreTestLayer(),
					InstanceHealthCheckLive,
					DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
					ConfigPersistenceNoopLive,
					DaemonEventBusLive,
					Layer.effect(SessionActivityTag, makeSessionActivity),
					makeProjectRegistryLive([
						{
							slug: "effect-project",
							title: "Effect Project",
							folders: [projectDir],
						},
					]),
					makeInstanceManagerStateLive(undefined, [], {
						launchLogin: sdkDefaultClaudeConfigDir(
							"/isolated-test-home/.claude",
						),
					}),
					Layer.succeed(OpenCodeInstancesTag, makeOpenCodeInstancesStub()),
					Layer.succeed(PortScannerTag, {
						getKnownPorts: () => Effect.succeed(new Set([4321, 4322])),
						scanNow: () => Effect.succeed(scanResult),
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
				.create({
					slug: "effect-project",
					title: "Effect Project",
					folders: [projectDir],
				})
				.pipe(Effect.scoped);

			const config = createProjectRelayMock.mock.calls[0]?.[0];
			expect(config).not.toHaveProperty("triggerScan");
			expect(config?.pushManager).toBe(pushManager);
			const context = config?.daemonConfigContext;
			if (!context) throw new Error("Missing daemon Effect context");
			const service = Option.getOrThrow(
				Context.getOption(context, ScanServiceTag),
			);
			const scan = yield* service.scanNow();
			expect(scan).toEqual(scanResult);
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

	it.effect("aborts in-flight relay creation when interrupted", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-abort-"));
		const projectDir = join(dir, "project");
		mkdirSync(projectDir);
		const server = createServer();
		let signal: AbortSignal | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		createProjectRelayMock.mockImplementation((config) => {
			signal = config.signal;
			markStarted?.();
			return new Promise((_, reject) => {
				config.signal?.addEventListener(
					"abort",
					() => reject(new Error("cancelled")),
					{ once: true },
				);
			});
		});

		const layer = RelayFactoryLive(join(dir, "config")).pipe(
			Layer.provide(
				Layer.mergeAll(
					DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
					ConfigPersistenceNoopLive,
					DaemonEventBusLive,
					Layer.effect(SessionActivityTag, makeSessionActivity),
					makeProjectRegistryLive([
						{
							slug: "effect-project",
							title: "Effect Project",
							folders: [projectDir],
						},
					]),
					makeInstanceManagerStateLive(undefined, [], {
						launchLogin: sdkDefaultClaudeConfigDir(
							"/isolated-test-home/.claude",
						),
					}),
					NoopAuxiliaryDaemonServices,
				),
			),
		);

		return Effect.gen(function* () {
			const httpServerRef = yield* HttpServerRefTag;
			yield* Ref.set(httpServerRef, server);

			const factory = yield* RelayFactoryTag;
			const fiber = yield* Effect.fork(
				factory.create({
					slug: "effect-project",
					title: "Effect Project",
					folders: [projectDir],
				}),
			);
			yield* Effect.promise(() => started);
			expect(signal?.aborted).toBe(false);

			yield* Fiber.interrupt(fiber);
			expect(signal?.aborted).toBe(true);
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
			const dir = mkdtempSync("/tmp/relay-project-mutators-");
			const projectDir = join(dir, "project");
			mkdirSync(projectDir);
			const server = createServer();
			const firstStop = vi.fn(async () => undefined);
			const secondStop = vi.fn(async () => undefined);
			createProjectRelayMock
				.mockResolvedValueOnce({
					syncGlobalSetting: () => Effect.void,
					refreshGlobalDefaults: () => Effect.void,
					stop: firstStop,
				})
				.mockResolvedValueOnce({
					syncGlobalSetting: () => Effect.void,
					refreshGlobalDefaults: () => Effect.void,
					stop: secondStop,
				});

			const baseLayer = Layer.mergeAll(
				DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
				makeDaemonStateLive({ configDir: join(dir, "config") }),
				ConfigPersistenceNoopLive,
				DaemonEventBusLive,
				Layer.effect(SessionActivityTag, makeSessionActivity),
				makeProjectRegistryLive([
					{
						slug: "effect-project",
						title: "Effect Project",
						folders: [projectDir],
					},
				]),
				makeInstanceManagerStateLive(
					undefined,
					[
						{
							id: "opencode",
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
					{
						...{ defaultOpencodeUrl: "http://localhost:4096" },
						launchLogin: sdkDefaultClaudeConfigDir(
							"/isolated-test-home/.claude",
						),
					},
				),
				NoopAuxiliaryDaemonServices,
			);
			const layer = makeRelayCacheLayer().pipe(
				Layer.provideMerge(RelayFactoryLive(join(dir, "config"))),
				Layer.provide(baseLayer),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);

				const cache = yield* RelayCacheTag;
				yield* cache.get("effect-project");

				const config = createProjectRelayMock.mock.calls[0]?.[0];
				const context = config?.daemonConfigContext;
				if (!context) throw new Error("Missing daemon Effect context");
				expect(config).not.toHaveProperty("saveProject");
				expect(config).not.toHaveProperty("removeProject");
				const service = Option.getOrThrow(
					Context.getOption(context, ProjectManagementServiceTag),
				);
				const { project: added } = yield* service.save({
					folders: [{ path: join(dir, "added"), create: { gitInit: false } }],
				});
				expect(added).toEqual(
					expect.objectContaining({
						title: "added",
						folders: [realpathSync(join(dir, "added"))],
					}),
				);
				yield* service.save({
					slug: added.slug,
					folders: added.folders,
					title: "Added Project",
				});
				let projects = yield* service.list();
				expect(projects).toContainEqual(
					expect.objectContaining({ slug: added.slug, title: "Added Project" }),
				);
				const invalid = yield* Effect.either(
					service.save({ folders: [join(dir, "missing")] }),
				);
				expect(invalid).toMatchObject({
					_tag: "Left",
					left: { _tag: "ProjectSaveRejected" },
				});
				projects = yield* service.remove(added.slug);
				expect(projects.some((project) => project.slug === added.slug)).toBe(
					false,
				);

				expect(firstStop).not.toHaveBeenCalled();
				expect(createProjectRelayMock).toHaveBeenCalledOnce();
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
