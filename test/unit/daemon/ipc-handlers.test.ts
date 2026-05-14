import {
	InstanceMgmtTag,
	ProjectMgmtTag,
} from "../../../src/lib/domain/daemon/Services/management-service.js";
// ─── IPC Effect Handlers Tests ────────────────────────────────────────────────
// Verify that Effect-returning IPC handlers correctly interact with services.

import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
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

// ─── Mock factories ──────────────────────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IPC handlers", () => {
	// ── handleAddProject ──────────────────────────────────────────────────

	describe("handleAddProject", () => {
		it.effect("adds project and returns slug", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				// Pre-populate with no projects
				yield* Ref.update(ref, (s) => ({ ...s, projects: [] }));

				const result = yield* handleAddProject({
					cmd: "add_project",
					directory: "/home/new-project",
				});

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

				const result = yield* handleAddProject({
					cmd: "add_project",
					directory: "/home/existing",
				});

				expect(result.ok).toBe(false);
				expect(result.error).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	// ── handleRemoveProject ──────────────────────────────────────────────

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

				const result = yield* handleRemoveProject({
					cmd: "remove_project",
					slug: "proj",
				});

				expect(result.ok).toBe(true);
				const state = yield* Ref.get(ref);
				expect(state.projects.length).toBe(0);
			}).pipe(Effect.provide(makeTestLayers())),
		);

		it.effect("returns error for non-existent slug", () =>
			Effect.gen(function* () {
				const result = yield* handleRemoveProject({
					cmd: "remove_project",
					slug: "nonexistent",
				});

				expect(result.ok).toBe(false);
				expect(result.error).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	// ── handleSetPin ─────────────────────────────────────────────────────

	describe("handleSetPin", () => {
		it.effect("updates pinHash in state and DaemonConfigRef", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;

				const result = yield* handleSetPin({
					cmd: "set_pin",
					pin: "1234",
				});

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

	// ── handleSetKeepAwake ───────────────────────────────────────────────

	describe("handleSetKeepAwake", () => {
		it.effect("enables keep awake and activates KeepAwakeTag", () =>
			Effect.gen(function* () {
				const result = yield* handleSetKeepAwake({
					cmd: "set_keep_awake",
					enabled: true,
				});

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

				const result = yield* handleSetKeepAwake({
					cmd: "set_keep_awake",
					enabled: false,
				});

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

	// ── handleShutdown ───────────────────────────────────────────────────

	describe("handleShutdown", () => {
		it.effect("sets shuttingDown and completes ShutdownSignal Deferred", () =>
			Effect.gen(function* () {
				const result = yield* handleShutdown({ cmd: "shutdown" });

				expect(result.ok).toBe(true);
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.shuttingDown).toBe(true);

				// AP-25: Verify ShutdownSignal Deferred was completed
				const deferred = yield* ShutdownSignalTag;
				const isDone = yield* Deferred.isDone(deferred);
				expect(isDone).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(makeTestLayers()))),
		);
	});

	// ── handleListProjects ───────────────────────────────────────────────

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

				const result = yield* handleListProjects({ cmd: "list_projects" });

				expect(result.ok).toBe(true);
				expect(result.projects).toHaveLength(2);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	// ── handleGetStatus ──────────────────────────────────────────────────

	describe("handleGetStatus", () => {
		it.effect("returns daemon status", () =>
			Effect.gen(function* () {
				const result = yield* handleGetStatus({ cmd: "get_status" });

				expect(result.ok).toBe(true);
				expect(result.uptime).toBeDefined();
				expect(typeof result.uptime).toBe("number");
				expect(result.port).toBeDefined();
				expect(result.projectCount).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers({ port: 3456 }))),
		);
	});

	// ── handleSetProjectTitle ────────────────────────────────────────────

	describe("handleSetProjectTitle", () => {
		it.effect("updates project title", () =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				yield* Ref.update(ref, (s) => ({
					...s,
					projects: [{ path: "/proj", slug: "proj", addedAt: 1 }],
				}));

				const result = yield* handleSetProjectTitle({
					cmd: "set_project_title",
					slug: "proj",
					title: "New Title",
				});

				expect(result.ok).toBe(true);
				const state = yield* Ref.get(ref);
				expect(state.projects[0]?.title).toBe("New Title");
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	// ── handleSetKeepAwakeCommand ────────────────────────────────────────

	describe("handleSetKeepAwakeCommand", () => {
		it.effect("updates keep awake command in state", () =>
			Effect.gen(function* () {
				const result = yield* handleSetKeepAwakeCommand({
					cmd: "set_keep_awake_command",
					command: "caffeinate",
					args: ["-d"],
				});

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

	// ── handleSetAgent ───────────────────────────────────────────────────

	describe("handleSetAgent", () => {
		it.effect("sets agent via Effect override state using slug", () =>
			Effect.gen(function* () {
				const result = yield* handleSetAgent({
					cmd: "set_agent",
					slug: "my-project",
					agent: "claude-3",
				});

				expect(result.ok).toBe(true);
				// IPC protocol uses slug as the override-state key.
				expect(yield* getAgent("my-project")).toBe("claude-3");
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	// ── handleSetModel ───────────────────────────────────────────────────

	describe("handleSetModel", () => {
		it.effect("sets model via Effect override state using slug", () =>
			Effect.gen(function* () {
				const result = yield* handleSetModel({
					cmd: "set_model",
					slug: "my-project",
					provider: "anthropic",
					model: "claude-3-opus",
				});

				expect(result.ok).toBe(true);
				const model = yield* getModel("my-project");
				expect(model).toBeDefined();
				expect(model?.providerID).toBe("anthropic");
				expect(model?.modelID).toBe("claude-3-opus");
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	// ── handleRestartWithConfig ──────────────────────────────────────────

	describe("handleRestartWithConfig", () => {
		it.effect("sets shuttingDown and completes ShutdownSignal", () =>
			Effect.gen(function* () {
				const result = yield* handleRestartWithConfig({
					cmd: "restart_with_config",
					config: {
						port: 2634,
						tls: true,
						pinHash: "next-pin-hash",
						keepAwake: true,
					},
				});

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

	// ── Instance handlers ────────────────────────────────────────────────

	describe("handleInstanceList", () => {
		it.effect("returns instances from InstanceMgmt", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceList({ cmd: "instance_list" });

				expect(result.ok).toBe(true);
				expect(result.instances).toBeDefined();
				expect(Array.isArray(result.instances)).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceAdd", () => {
		it.effect("adds a managed instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceAdd({
					cmd: "instance_add",
					name: "New Instance",
					managed: true,
					port: 5000,
				});

				expect(result.ok).toBe(true);
				expect(result.instance).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceRemove", () => {
		it.effect("removes an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceRemove({
					cmd: "instance_remove",
					id: "inst-1",
				});

				expect(result.ok).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceStart", () => {
		it.effect("starts an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceStart({
					cmd: "instance_start",
					id: "inst-1",
				});

				expect(result.ok).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceStop", () => {
		it.effect("stops an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceStop({
					cmd: "instance_stop",
					id: "inst-1",
				});

				expect(result.ok).toBe(true);
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceStatus", () => {
		it.effect("returns instance status", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceStatus({
					cmd: "instance_status",
					id: "inst-1",
				});

				expect(result.ok).toBe(true);
				expect(result.instance).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});

	describe("handleInstanceUpdate", () => {
		it.effect("updates an instance", () =>
			Effect.gen(function* () {
				const result = yield* handleInstanceUpdate({
					cmd: "instance_update",
					id: "inst-1",
					name: "Renamed",
					port: 9999,
				});

				expect(result.ok).toBe(true);
				expect(result.instance).toBeDefined();
			}).pipe(Effect.provide(makeTestLayers())),
		);
	});
});
