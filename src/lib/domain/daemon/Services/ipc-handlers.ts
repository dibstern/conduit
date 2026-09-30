import { InstanceMgmtTag } from "./management-service.js";
// ─── IPC Effect Handlers ─────────────────────────────────────────────────────
// Effect-returning handlers for each IPC command. Each handler:
// 1. Receives the decoded tagged request
// 2. Accesses services via `yield* Tag`
// 3. Returns an IPCResponse-compatible object
// 4. Error channel is `never` (handlers catch/transform expected errors)

import { Data, Deferred, Effect, Ref } from "effect";
import { hashPin } from "../../../auth.js";
import type {
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
} from "../../../contracts/ipc-requests.js";
import type { IPCResponse } from "../../../types.js";
import { generateSlug } from "../../../utils.js";

import {
	type OverridesStateTag,
	setAgent,
	setModel,
} from "../../relay/Services/session-overrides-state.js";
import { ShutdownSignalTag } from "../Layers/daemon-layers.js";
import { KeepAwakeTag } from "../Layers/keep-awake-layer.js";
import {
	type ConfigPersistenceTag,
	requestConfigSave,
} from "./config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	type DaemonConfigRefTag,
} from "./daemon-config-ref.js";
import { DaemonStateTag } from "./daemon-state.js";

// ─── Shared dependency types ─────────────────────────────────────────────────

/** Dependencies needed for persistConfig calls. */
type PersistDeps = ConfigPersistenceTag;

class InstanceMgmtOperationFailed extends Data.TaggedError(
	"InstanceMgmtOperationFailed",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

const formatInstanceMgmtFailure = (failure: InstanceMgmtOperationFailed) =>
	String(failure.cause);

const failInstanceMgmtOperation = (operation: string, cause: unknown) =>
	new InstanceMgmtOperationFailed({
		operation,
		cause,
	});

const tryInstanceMgmtOperation = <A>(
	operation: string,
	tryOperation: () => A,
) =>
	Effect.try({
		try: tryOperation,
		catch: (cause) => failInstanceMgmtOperation(operation, cause),
	});

const tryInstanceMgmtPromise = <A>(
	operation: string,
	tryOperation: () => PromiseLike<A>,
) =>
	Effect.tryPromise({
		try: tryOperation,
		catch: (cause) => failInstanceMgmtOperation(operation, cause),
	});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const applyRestartConfig = (
	state: import("./daemon-state.js").DaemonState,
	config: Record<string, unknown> | undefined,
) => {
	if (config === undefined) return state;
	return {
		...state,
		...(typeof config["port"] === "number" ? { port: config["port"] } : {}),
		...(typeof config["tls"] === "boolean" ? { tls: config["tls"] } : {}),
		...(typeof config["pinHash"] === "string" || config["pinHash"] === null
			? { pinHash: config["pinHash"] }
			: {}),
		...(typeof config["keepAwake"] === "boolean"
			? { keepAwake: config["keepAwake"] }
			: {}),
		...(typeof config["keepAwakeCommand"] === "string"
			? { keepAwakeCommand: config["keepAwakeCommand"] }
			: {}),
		...(Array.isArray(config["keepAwakeArgs"]) &&
		config["keepAwakeArgs"].every((arg) => typeof arg === "string")
			? { keepAwakeArgs: config["keepAwakeArgs"] }
			: {}),
	};
};

const applyRestartRuntimeConfig = (
	config: import("./daemon-config-ref.js").DaemonRuntimeConfig,
	update: Record<string, unknown> | undefined,
) => {
	if (update === undefined) return config;
	return {
		...config,
		...(typeof update["port"] === "number" ? { port: update["port"] } : {}),
		...(typeof update["tls"] === "boolean"
			? { tlsEnabled: update["tls"] }
			: {}),
		...(typeof update["pinHash"] === "string" || update["pinHash"] === null
			? { pinHash: update["pinHash"] }
			: {}),
		...(typeof update["keepAwake"] === "boolean"
			? { keepAwake: update["keepAwake"] }
			: {}),
		...(typeof update["keepAwakeCommand"] === "string"
			? { keepAwakeCommand: update["keepAwakeCommand"] }
			: {}),
		...(Array.isArray(update["keepAwakeArgs"]) &&
		update["keepAwakeArgs"].every((arg) => typeof arg === "string")
			? { keepAwakeArgs: [...update["keepAwakeArgs"]] }
			: {}),
	};
};

// ─── Project handlers ────────────────────────────────────────────────────────

export const handleAddProject = (
	request: AddProject,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		// Check for duplicate directory
		const existing = state.projects.find((p) => p.path === request.directory);
		if (existing) {
			return { ok: false, error: `Project already exists: ${existing.slug}` };
		}

		// Generate slug
		const existingSlugs = new Set(state.projects.map((p) => p.slug));
		const slug = generateSlug(request.directory, existingSlugs);

		// Add project to state
		yield* Ref.update(ref, (s) => ({
			...s,
			projects: [
				...s.projects,
				{
					path: request.directory,
					slug,
					addedAt: Date.now(),
				},
			],
		}));

		yield* requestConfigSave;
		return { ok: true, slug, directory: request.directory };
	});

export const handleRemoveProject = (
	request: RemoveProject,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		const exists = state.projects.some((p) => p.slug === request.slug);
		if (!exists) {
			return { ok: false, error: `Project not found: ${request.slug}` };
		}

		yield* Ref.update(ref, (s) => ({
			...s,
			projects: s.projects.filter((p) => p.slug !== request.slug),
		}));

		yield* requestConfigSave;
		return { ok: true };
	});

export const handleSetProjectTitle = (
	request: SetProjectTitle,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		const exists = state.projects.some((p) => p.slug === request.slug);
		if (!exists) {
			return { ok: false, error: `Project not found: ${request.slug}` };
		}

		yield* Ref.update(ref, (s) => ({
			...s,
			projects: s.projects.map((p) =>
				p.slug === request.slug ? { ...p, title: request.title } : p,
			),
		}));

		yield* requestConfigSave;
		return { ok: true };
	});

// ─── State handlers ──────────────────────────────────────────────────────────

export const handleSetPin = (
	request: SetPin,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | PersistDeps
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const hashed = request.pin === null ? null : hashPin(request.pin);

		// AP-24: Update DaemonConfigRef so AuthManager sees the new pinHash reactively.
		// AuthManager reads pinHash from DaemonConfigRef, not DaemonState.
		yield* commitDaemonRuntimeConfig((c) => ({ ...c, pinHash: hashed }));

		yield* Ref.update(ref, (s) => ({
			...s,
			pinHash: hashed,
		}));

		yield* requestConfigSave;
		return { ok: true };
	});

export const handleSetKeepAwake = (
	request: SetKeepAwake,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | KeepAwakeTag | PersistDeps
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const keepAwake = yield* KeepAwakeTag;

		// AP-22: Delegate to KeepAwakeTag for actual system keep-awake toggling,
		// not just the Ref update. KeepAwakeTag.activate/deactivate manages the
		// platform-specific process (caffeinate, systemd-inhibit, etc.).
		if (request.enabled) {
			yield* keepAwake.activate();
		} else {
			yield* keepAwake.deactivate();
		}

		const supported = yield* keepAwake.isSupported();
		const active = yield* keepAwake.isActive();

		yield* Ref.update(ref, (s) => ({
			...s,
			keepAwake: request.enabled,
		}));
		yield* commitDaemonRuntimeConfig((c) => ({
			...c,
			keepAwake: request.enabled,
		}));

		yield* requestConfigSave;
		return { ok: true, supported, active };
	});

export const handleSetKeepAwakeCommand = (
	request: SetKeepAwakeCommand,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | PersistDeps
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			keepAwakeCommand: request.command,
			keepAwakeArgs: [...request.args],
		}));
		yield* commitDaemonRuntimeConfig((c) => ({
			...c,
			keepAwakeCommand: request.command,
			keepAwakeArgs: [...request.args],
		}));

		yield* requestConfigSave;
		return { ok: true };
	});

export const handleShutdown = (
	_request: Shutdown,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | ShutdownSignalTag
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			shuttingDown: true,
		}));
		yield* commitDaemonRuntimeConfig((c) => ({
			...c,
			shuttingDown: true,
		}));

		// AP-25: Complete the ShutdownSignal Deferred so the daemon-wide
		// shutdown sequence begins (Layer teardown in reverse order).
		const shutdownDeferred = yield* ShutdownSignalTag;
		yield* Deferred.succeed(shutdownDeferred, undefined);

		return { ok: true };
	});

export const handleListProjects = (
	_request: ListProjects,
): Effect.Effect<IPCResponse, never, DaemonStateTag> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		return {
			ok: true,
			projects: state.projects.map((p) => ({
				slug: p.slug,
				directory: p.path,
				title: p.title ?? p.slug,
			})),
		};
	});

export const handleGetStatus = (
	_request: GetStatus,
): Effect.Effect<IPCResponse, never, DaemonStateTag> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		return {
			ok: true,
			uptime: Math.floor((Date.now() - state.startTime) / 1000),
			port: state.port,
			host: state.host,
			projectCount: state.projects.length,
			sessionCount: state.projects.reduce(
				(total, project) => total + (project.sessionCount ?? 0),
				0,
			),
			clientCount: state.clientCount,
			pinEnabled: state.pinHash !== null,
			tlsEnabled: state.tls,
			keepAwake: state.keepAwake,
			projects: state.projects.map((project) => ({
				slug: project.slug,
				directory: project.path,
				title: project.title ?? project.slug,
			})),
		};
	});

// ─── Instance handlers ──────────────────────────────────────────────────────

export const handleInstanceList = (
	_request: InstanceList,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;
		return yield* tryInstanceMgmtPromise("getInstances", () =>
			Promise.resolve(mgmt.getInstances()),
		).pipe(
			Effect.map((instances) => ({ ok: true, instances }) as IPCResponse),
			Effect.catchAll((failure) =>
				Effect.succeed({
					ok: false,
					error: formatInstanceMgmtFailure(failure),
				} as IPCResponse),
			),
		);
	});

export const handleInstanceAdd = (
	request: InstanceAdd,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		const id = `inst-${Date.now()}`;
		const config: import("../../../shared-types.js").InstanceConfig = {
			name: request.name,
			port: request.port ?? 0,
			managed: request.managed,
		};
		if (request.env !== undefined)
			config.env = request.env as Record<string, string>;
		if (request.url !== undefined) config.url = request.url;
		if (request.driver !== undefined) config.driver = request.driver;
		if (request.configDir !== undefined) config.configDir = request.configDir;
		return yield* tryInstanceMgmtOperation("addInstance", () => {
			const instance = mgmt.addInstance(id, config);
			mgmt.persistConfig();
			return { ok: true, instance };
		}).pipe(
			Effect.catchAll((failure) =>
				Effect.succeed({
					ok: false,
					error: formatInstanceMgmtFailure(failure),
				}),
			),
		);
	});

export const handleInstanceRemove = (
	request: InstanceRemove,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtOperation("removeInstance", () => {
			mgmt.removeInstance(request.id);
			mgmt.persistConfig();
			return { ok: true } as IPCResponse;
		}).pipe(
			Effect.catchAll((failure) =>
				Effect.succeed({
					ok: false,
					error: formatInstanceMgmtFailure(failure),
				} as IPCResponse),
			),
		);
	});

export const handleInstanceStart = (
	request: InstanceStart,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtPromise("startInstance", () =>
			mgmt.startInstance(request.id),
		).pipe(
			Effect.map(() => ({ ok: true }) as IPCResponse),
			Effect.catchAll((failure) =>
				Effect.succeed({
					ok: false,
					error: formatInstanceMgmtFailure(failure),
				} as IPCResponse),
			),
		);
	});

export const handleInstanceStop = (
	request: InstanceStop,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtOperation("stopInstance", () => {
			mgmt.stopInstance(request.id);
			return { ok: true } as IPCResponse;
		}).pipe(
			Effect.catchAll((failure) =>
				Effect.succeed({
					ok: false,
					error: formatInstanceMgmtFailure(failure),
				} as IPCResponse),
			),
		);
	});

export const handleInstanceStatus = (
	request: InstanceStatus,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;
		const instances = yield* tryInstanceMgmtPromise("getInstances", () =>
			Promise.resolve(mgmt.getInstances()),
		).pipe(
			Effect.catchAll((failure) =>
				Effect.fail(failInstanceMgmtOperation("getInstances", failure)),
			),
		);
		const instance = instances.find((i) => i.id === request.id);

		if (!instance) {
			return { ok: false, error: `Instance not found: ${request.id}` };
		}

		return { ok: true, instance };
	}).pipe(
		Effect.catchAll((failure) =>
			Effect.succeed({
				ok: false,
				error: formatInstanceMgmtFailure(failure),
			} as IPCResponse),
		),
	);

export const handleInstanceUpdate = (
	request: InstanceUpdate,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtOperation("updateInstance", () => {
			const updates: {
				name?: string;
				env?: Record<string, string>;
				port?: number;
				driver?: string;
				configDir?: string;
			} = {};
			if (request.name !== undefined) updates.name = request.name;
			if (request.env !== undefined)
				updates.env = request.env as Record<string, string>;
			if (request.port !== undefined) updates.port = request.port;
			if (request.driver !== undefined) updates.driver = request.driver;
			if (request.configDir !== undefined)
				updates.configDir = request.configDir;
			const instance = mgmt.updateInstance(request.id, updates);
			mgmt.persistConfig();
			return { ok: true, instance } as IPCResponse;
		}).pipe(
			Effect.catchAll((failure) =>
				Effect.succeed({
					ok: false,
					error: formatInstanceMgmtFailure(failure),
				} as IPCResponse),
			),
		);
	});

// ─── Session override handlers ──────────────────────────────────────────────

export const handleSetAgent = (
	request: SetAgent,
): Effect.Effect<IPCResponse, never, OverridesStateTag> =>
	Effect.gen(function* () {
		// Protocol uses `slug` as the identifier (not sessionId)
		yield* setAgent(request.slug, request.agent);
		return { ok: true };
	});

export const handleSetModel = (
	request: SetModel,
): Effect.Effect<IPCResponse, never, OverridesStateTag> =>
	Effect.gen(function* () {
		// Protocol uses `slug` as the identifier (not sessionId)
		yield* setModel(request.slug, {
			providerID: request.provider,
			modelID: request.model,
		});
		return { ok: true };
	});

// ─── Restart handler ─────────────────────────────────────────────────────────

export const handleRestartWithConfig = (
	request: RestartWithConfig,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | ShutdownSignalTag | PersistDeps
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		yield* Ref.update(ref, (s) => ({
			...applyRestartConfig(s, request.config),
			shuttingDown: true,
		}));
		yield* commitDaemonRuntimeConfig((c) => ({
			...applyRestartRuntimeConfig(c, request.config),
			shuttingDown: true,
		}));

		yield* requestConfigSave;

		// AP-25: Complete the ShutdownSignal Deferred to trigger graceful shutdown.
		const shutdownDeferred = yield* ShutdownSignalTag;
		yield* Deferred.succeed(shutdownDeferred, undefined);

		return { ok: true };
	});
