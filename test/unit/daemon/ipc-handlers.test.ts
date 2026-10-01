import {
	AddProject,
	GetStatus,
	InstanceAdd,
	InstanceList,
	InstanceRemove,
	InstanceStart,
	InstanceStatus,
	InstanceStop,
	InstanceUpdate,
	ListProjects,
	RemoveProject,
	RestartWithConfig,
	SetAgent,
	SetKeepAwake,
	SetKeepAwakeCommand,
	SetModel,
	SetPin,
	SetProjectTitle,
	Shutdown,
} from "../../../src/lib/contracts/ipc-requests.js";
import {
	InstanceMgmtTag,
	ProjectMgmtTag,
} from "../../../src/lib/domain/daemon/Services/management-service.js";
// Verify that Effect-returning IPC handlers correctly interact with services.

import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Ref } from "effect";
import { expect, vi } from "vitest";
import { hashPin } from "../../../src/lib/auth.js";
import { ShutdownSignalTag } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { KeepAwakeTag } from "../../../src/lib/domain/daemon/Layers/keep-awake-layer.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import type { DaemonState } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	handleAddProject,
	handleGetStatus,
	handleInstanceAdd,
	handleInstanceList,
	handleInstanceRemove,
	handleInstanceStart,
	handleInstanceStatus,
	handleInstanceStop,
	handleInstanceUpdate,
	handleListProjects,
	handleRemoveProject,
	handleRestartWithConfig,
	handleSetAgent,
	handleSetKeepAwake,
	handleSetKeepAwakeCommand,
	handleSetModel,
	handleSetPin,
	handleSetProjectTitle,
	handleShutdown,
} from "../../../src/lib/domain/daemon/Services/ipc-handlers.js";

import {
	getAgent,
	getModel,
	makeOverridesStateLive,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { InstanceManagementDeps } from "../../../src/lib/handlers/types.js";

const makeMockProjectMgmt = () =>
	Layer.succeed(ProjectMgmtTag, {
		getProjects: () => [
			{ slug: "proj-1", title: "Project 1", directory: "/home/proj-1" },
		],
		setProjectInstance: () => {},
	});

const makeMockInstanceMgmt = (overrides?: Partial<InstanceManagementDeps>) =>
	Layer.succeed(InstanceMgmtTag, {
		getInstances: () => [
			{
				id: "inst-1",
				name: "Dev",
				port: 4096,
				managed: true,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: Date.now(),
			},
		],
		addInstance: (id, config) => ({
			id,
			...config,
			status: "stopped" as const,
			restartCount: 0,
			createdAt: Date.now(),
		}),
		removeInstance: () => {},
		startInstance: () => Promise.resolve(),
		stopInstance: () => {},
		updateInstance: (id, updates) => ({
			id,
			name: updates.name ?? "Updated",
			port: updates.port ?? 4096,
			managed: true,
			status: "healthy" as const,
			restartCount: 0,
			createdAt: Date.now(),
		}),
		persistConfig: () => {},
		...overrides,
	});

/** Mock KeepAwakeTag — tracks activate/deactivate calls. */
const makeMockKeepAwake = () =>
	Layer.effect(
		KeepAwakeTag,
		Effect.gen(function* () {
			const activeRef = yield* Ref.make(false);
			return {
				activate: () => Ref.set(activeRef, true),
				deactivate: () => Ref.set(activeRef, false),
				isActive: () => Ref.get(activeRef),
				isSupported: () => Effect.succeed(true),
			};
		}),
	);

/** Mock DaemonConfigRefTag — Ref with sensible defaults. */
const makeMockConfigRef = () => {
	const initial: import("../../../src/lib/domain/daemon/Services/daemon-config-ref.js").DaemonRuntimeConfig =
		{
			port: 2633,
			host: "127.0.0.1",
			pinHash: null,
			tlsEnabled: false,
			keepAwake: false,
			keepAwakeCommand: undefined,
			keepAwakeArgs: undefined,
			claudeConfigDir: undefined,
			shuttingDown: false,
			dismissedPaths: new Set<string>(),
			startTime: Date.now(),
			hostExplicit: false,
			persistedSessionCounts: new Map<string, number>(),
		};
	return Layer.effect(DaemonConfigRefTag, Ref.make(initial));
};

/** Mock ShutdownSignalTag — Deferred for testing. */
const makeMockShutdownSignal = () =>
	Layer.effect(ShutdownSignalTag, Deferred.make<void>());

const makeTestLayers = (stateOverrides?: Partial<DaemonState>) => {
	return Layer.mergeAll(
		makeDaemonStateLive(stateOverrides),
		makeMockProjectMgmt(),
		makeMockInstanceMgmt(),
		makeOverridesStateLive(),
		makeMockKeepAwake(),
		makeMockConfigRef(),
		makeMockShutdownSignal(),
		Layer.succeed(ConfigPersistenceTag, {
			requestSave: Effect.void,
			flush: Effect.void,
		}),
	);
};

const makeTestLayersWithInstanceMgmt = (
	overrides?: Partial<InstanceManagementDeps>,
) =>
	Layer.mergeAll(
		makeDaemonStateLive(),
		makeMockProjectMgmt(),
		makeMockInstanceMgmt(overrides),
		makeOverridesStateLive(),
		makeMockKeepAwake(),
		makeMockConfigRef(),
		makeMockShutdownSignal(),
		Layer.succeed(ConfigPersistenceTag, {
			requestSave: Effect.void,
			flush: Effect.void,
		}),
	);

describe("IPC handlers", () => {
	describe("handleAddProject", () => {
		it.effect("adds project and returns slug", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				// Pre-populate with no projects
				yield* Ref.update(ref, (s) => ({ ...s, projects: [] }));

				const result = yield* handleAddProject(
					new AddProject({
						directory: "/home/new-project",
					}),
				);

				expect(result.ok).toBe(true);
				expect(result.slug).toBeDefined();

				// Verify project was added to state
				const state = yield* Ref.get(ref);
				expect(state.projects.length).toBe(1);
				expect(state.projects[0]?.path).toBe("/home/new-project");
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect("rejects duplicate project directory", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				yield* Ref.update(ref, (s) => ({
					...s,
					projects: [
						{
							path: "/home/existing",
							slug: "existing",
							addedAt: Date.now(),
						},
					],
				}));

				const result = yield* handleAddProject(
					new AddProject({
						directory: "/home/existing",
					}),
				);

				expect(result.ok).toBe(false);
				expect(result.error).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleRemoveProject", () => {
		it.effect("removes project by slug", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				yield* Ref.update(ref, (s) => ({
					...s,
					projects: [
						{
							path: "/home/proj",
							slug: "proj",
							addedAt: Date.now(),
						},
					],
				}));

				const result = yield* handleRemoveProject(
					new RemoveProject({
						slug: "proj",
					}),
				);

				expect(result.ok).toBe(true);
				const state = yield* Ref.get(ref);
				expect(state.projects.length).toBe(0);
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect("returns error for non-existent slug", () =>
			Effect.gen(function* () {
				const result = yield* handleRemoveProject(
					new RemoveProject({
						slug: "nonexistent",
					}),
				);

				expect(result.ok).toBe(false);
				expect(result.error).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleSetPin", () => {
		it.effect("clears both PIN refs before requesting persistence", () =>
			Effect.gen(function* () {
				const stateRef = yield* DaemonStateTag;
				const configRef = yield* DaemonConfigRefTag;
				yield* handleSetPin(new SetPin({ pin: "1234" }));
				expect((yield* Ref.get(stateRef)).pinHash).toBe(hashPin("1234"));
				expect((yield* Ref.get(configRef)).pinHash).toBe(hashPin("1234"));
				const saved = yield* Ref.make(false);

				const result = yield* handleSetPin(new SetPin({ pin: null })).pipe(
					Effect.provideService(ConfigPersistenceTag, {
						requestSave: Effect.gen(function* () {
							expect((yield* Ref.get(stateRef)).pinHash).toBeNull();
							expect((yield* Ref.get(configRef)).pinHash).toBeNull();
							yield* Ref.set(saved, true);
						}),
						flush: Effect.void,
					}),
				);

				expect(result.ok).toBe(true);
				expect(yield* Ref.get(saved)).toBe(true);
				expect((yield* Ref.get(stateRef)).pinHash).toBeNull();
				expect((yield* Ref.get(configRef)).pinHash).toBeNull();
			}).pipe(Effect.provide(Layer.fresh(makeTestLayers()))),
		);

		it.effect("updates pinHash in state and DaemonConfigRef", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;

				const result = yield* handleSetPin(
					new SetPin({
						pin: "1234",
					}),
				);

				expect(result.ok).toBe(true);
				const state = yield* Ref.get(ref);
				expect(state.pinHash).toBe(hashPin("1234"));

				// AP-24: Verify DaemonConfigRef was also updated
				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.pinHash).toBe(state.pinHash);
			}).pipe(Effect.provide(Layer.fresh(makeTestLayers()))),
		);
	});

	describe("handleSetKeepAwake", () => {
		it.effect("enables keep awake and activates KeepAwakeTag", () =>
			Effect.gen(function* () {
				const result = yield* handleSetKeepAwake(
					new SetKeepAwake({
						enabled: true,
					}),
				);

				expect(result.ok).toBe(true);
				expect(result["supported"]).toBe(true);
				expect(result["active"]).toBe(true);
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.keepAwake).toBe(true);
				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.keepAwake).toBe(true);

				// Verify KeepAwakeTag was activated
				const ka = yield* KeepAwakeTag;
				const isActive = yield* ka.isActive();
				expect(isActive).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(makeTestLayers()))),
		);

		it.effect("disables keep awake and deactivates KeepAwakeTag", () =>
			Effect.gen(function* () {
				// First activate
				const ka = yield* KeepAwakeTag;
				yield* ka.activate();

				const result = yield* handleSetKeepAwake(
					new SetKeepAwake({
						enabled: false,
					}),
				);

				expect(result.ok).toBe(true);
				expect(result["active"]).toBe(false);
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.keepAwake).toBe(false);
				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.keepAwake).toBe(false);

				// Verify KeepAwakeTag was deactivated
				const isActive = yield* ka.isActive();
				expect(isActive).toBe(false);
			}).pipe(Effect.provide(Layer.fresh(makeTestLayers({ keepAwake: true })))),
		);
	});

	describe("handleShutdown", () => {
		it.effect("sets shuttingDown and completes ShutdownSignal Deferred", () =>
			Effect.gen(function* () {
				const result = yield* handleShutdown(new Shutdown({}));

				expect(result.ok).toBe(true);
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.shuttingDown).toBe(true);

				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.shuttingDown).toBe(true);

				// AP-25: Verify ShutdownSignal Deferred was completed
				const deferred = yield* ShutdownSignalTag;
				const isDone = yield* Deferred.isDone(deferred);
				expect(isDone).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(makeTestLayers()))),
		);
	});

	describe("handleListProjects", () => {
		it.effect("returns projects from state", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				yield* Ref.update(ref, (s) => ({
					...s,
					projects: [
						{ path: "/a", slug: "a", addedAt: 1, title: "A" },
						{ path: "/b", slug: "b", addedAt: 2, title: "B" },
					],
				}));

				const result = yield* handleListProjects(new ListProjects({}));

				expect(result.ok).toBe(true);
				expect(result.projects).toHaveLength(2);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleGetStatus", () => {
		it.effect("returns daemon status", () =>
			Effect.gen(function* () {
				const result = yield* handleGetStatus(new GetStatus({}));

				expect(result.ok).toBe(true);
				expect(result.uptime).toBeDefined();
				expect(typeof result.uptime).toBe("number");
				expect(result.port).toBeDefined();
				expect(result.projectCount).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers({ port: 3456 }))),
		);
	});

	describe("handleSetProjectTitle", () => {
		it.effect("updates project title", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				yield* Ref.update(ref, (s) => ({
					...s,
					projects: [{ path: "/proj", slug: "proj", addedAt: 1 }],
				}));

				const result = yield* handleSetProjectTitle(
					new SetProjectTitle({
						slug: "proj",
						title: "New Title",
					}),
				);

				expect(result.ok).toBe(true);
				const state = yield* Ref.get(ref);
				expect(state.projects[0]?.title).toBe("New Title");
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleSetKeepAwakeCommand", () => {
		it.effect("updates keep awake command in state", () =>
			Effect.gen(function* () {
				const result = yield* handleSetKeepAwakeCommand(
					new SetKeepAwakeCommand({
						command: "caffeinate",
						args: ["-d"],
					}),
				);

				expect(result.ok).toBe(true);
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.keepAwakeCommand).toBe("caffeinate");
				expect(state.keepAwakeArgs).toEqual(["-d"]);
				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.keepAwakeCommand).toBe("caffeinate");
				expect(config.keepAwakeArgs).toEqual(["-d"]);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleSetAgent", () => {
		it.effect("sets agent via Effect override state using slug", () =>
			Effect.gen(function* () {
				const result = yield* handleSetAgent(
					new SetAgent({
						slug: "my-project",
						agent: "claude-3",
					}),
				);

				expect(result.ok).toBe(true);
				// IPC protocol uses slug as the override-state key.
				expect(yield* getAgent("my-project")).toBe("claude-3");
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleSetModel", () => {
		it.effect("sets model via Effect override state using slug", () =>
			Effect.gen(function* () {
				const result = yield* handleSetModel(
					new SetModel({
						slug: "my-project",
						provider: "anthropic",
						model: "claude-3-opus",
					}),
				);

				expect(result.ok).toBe(true);
				const model = yield* getModel("my-project");
				expect(model).toBeDefined();
				expect(model?.providerID).toBe("anthropic");
				expect(model?.modelID).toBe("claude-3-opus");
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleRestartWithConfig", () => {
		it.effect("sets shuttingDown and completes ShutdownSignal", () =>
			Effect.gen(function* () {
				const result = yield* handleRestartWithConfig(
					new RestartWithConfig({
						config: {
							port: 2634,
							tls: true,
							pinHash: "next-pin-hash",
							keepAwake: true,
						},
					}),
				);

				expect(result.ok).toBe(true);
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.shuttingDown).toBe(true);
				expect(state.port).toBe(2634);
				expect(state.tls).toBe(true);
				expect(state.pinHash).toBe("next-pin-hash");
				expect(state.keepAwake).toBe(true);

				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.shuttingDown).toBe(true);
				expect(config.port).toBe(2634);
				expect(config.tlsEnabled).toBe(true);
				expect(config.pinHash).toBe("next-pin-hash");
				expect(config.keepAwake).toBe(true);

				// AP-25: Verify ShutdownSignal Deferred was completed
				const deferred = yield* ShutdownSignalTag;
				const isDone = yield* Deferred.isDone(deferred);
				expect(isDone).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(makeTestLayers()))),
		);
	});

	describe("handleInstanceList", () => {
		it.effect("returns instances from InstanceMgmt", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceList(new InstanceList({}));

				expect(result.ok).toBe(true);
				expect(result.instances).toBeDefined();
				expect(Array.isArray(result.instances)).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceAdd", () => {
		it.effect("adds a managed instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceAdd(
					new InstanceAdd({
						name: "New Instance",
						managed: true,
						port: 5000,
					}),
				);

				expect(result.ok).toBe(true);
				expect(result.instance).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect("returns an IPC error when instance add rejects", () =>
			Effect.gen(function* () {
				const persistConfig = vi.fn();
				const layers = Layer.mergeAll(
					makeDaemonStateLive(),
					makeMockProjectMgmt(),
					makeMockInstanceMgmt({
						addInstance: () => {
							throw new Error("Max instances reached (5)");
						},
						persistConfig,
					}),
					makeOverridesStateLive(),
					makeMockKeepAwake(),
					makeMockConfigRef(),
					makeMockShutdownSignal(),
					Layer.succeed(ConfigPersistenceTag, {
						requestSave: Effect.void,
						flush: Effect.void,
					}),
				);

				const exit = yield* Effect.exit(
					handleInstanceAdd(
						new InstanceAdd({
							name: "Overflow",
							managed: true,
							port: 5001,
						}),
					).pipe(Effect.provide(layers)),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					expect(exit.value).toEqual({
						ok: false,
						error: "Error: Max instances reached (5)",
					});
				}
				expect(persistConfig).not.toHaveBeenCalled();
			}),
		);
	});

	describe("handleInstanceRemove", () => {
		it.effect("removes an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceRemove(
					new InstanceRemove({
						id: "inst-1",
					}),
				);

				expect(result.ok).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect("returns an IPC error when remove rejects", () =>
			Effect.gen(function* () {
				const persistConfig = vi.fn();
				const exit = yield* Effect.exit(
					handleInstanceRemove(
						new InstanceRemove({
							id: "missing",
						}),
					).pipe(
						Effect.provide(
							makeTestLayersWithInstanceMgmt({
								removeInstance: () => {
									throw new Error('Instance "missing" not found');
								},
								persistConfig,
							}),
						),
					),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					expect(exit.value).toEqual({
						ok: false,
						error: 'Error: Instance "missing" not found',
					});
				}
				expect(persistConfig).not.toHaveBeenCalled();
			}),
		);
	});

	describe("handleInstanceStart", () => {
		it.effect("starts an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceStart(
					new InstanceStart({
						id: "inst-1",
					}),
				);

				expect(result.ok).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect(
			"returns an IPC error when start rejects for a missing instance",
			() =>
				Effect.gen(function* () {
					const exit = yield* Effect.exit(
						handleInstanceStart(
							new InstanceStart({
								id: "missing",
							}),
						).pipe(
							Effect.provide(
								makeTestLayersWithInstanceMgmt({
									startInstance: () =>
										Promise.reject(new Error('Instance "missing" not found')),
								}),
							),
						),
					);

					expect(Exit.isSuccess(exit)).toBe(true);
					if (Exit.isSuccess(exit)) {
						expect(exit.value).toEqual({
							ok: false,
							error: 'Error: Instance "missing" not found',
						});
					}
				}),
		);

		it.effect(
			"returns an IPC error when start rejects for an external instance",
			() =>
				Effect.gen(function* () {
					const exit = yield* Effect.exit(
						handleInstanceStart(
							new InstanceStart({
								id: "external",
							}),
						).pipe(
							Effect.provide(
								makeTestLayersWithInstanceMgmt({
									startInstance: () =>
										Promise.reject(new Error("Cannot start external instance")),
								}),
							),
						),
					);

					expect(Exit.isSuccess(exit)).toBe(true);
					if (Exit.isSuccess(exit)) {
						expect(exit.value).toEqual({
							ok: false,
							error: "Error: Cannot start external instance",
						});
					}
				}),
		);
	});

	describe("handleInstanceStop", () => {
		it.effect("stops an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceStop(
					new InstanceStop({
						id: "inst-1",
					}),
				);

				expect(result.ok).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect("returns an IPC error when stop rejects", () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					handleInstanceStop(
						new InstanceStop({
							id: "missing",
						}),
					).pipe(
						Effect.provide(
							makeTestLayersWithInstanceMgmt({
								stopInstance: () => {
									throw new Error('Instance "missing" not found');
								},
							}),
						),
					),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					expect(exit.value).toEqual({
						ok: false,
						error: 'Error: Instance "missing" not found',
					});
				}
			}),
		);
	});

	describe("handleInstanceStatus", () => {
		it.effect("returns instance status", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceStatus(
					new InstanceStatus({
						id: "inst-1",
					}),
				);

				expect(result.ok).toBe(true);
				expect(result.instance).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceUpdate", () => {
		it.effect("updates an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceUpdate(
					new InstanceUpdate({
						id: "inst-1",
						name: "Renamed",
						port: 9999,
					}),
				);

				expect(result.ok).toBe(true);
				expect(result.instance).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect("returns an IPC error when update rejects", () =>
			Effect.gen(function* () {
				const persistConfig = vi.fn();
				const exit = yield* Effect.exit(
					handleInstanceUpdate(
						new InstanceUpdate({
							id: "missing",
							name: "Renamed",
						}),
					).pipe(
						Effect.provide(
							makeTestLayersWithInstanceMgmt({
								updateInstance: () => {
									throw new Error('Instance "missing" not found');
								},
								persistConfig,
							}),
						),
					),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					expect(exit.value).toEqual({
						ok: false,
						error: 'Error: Instance "missing" not found',
					});
				}
				expect(persistConfig).not.toHaveBeenCalled();
			}),
		);
	});
});
