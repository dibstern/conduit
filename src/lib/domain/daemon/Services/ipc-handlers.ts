import { InstanceMgmtTag } from "./management-service.js";
// ─── IPC Effect Handlers ─────────────────────────────────────────────────────
// Effect-returning handlers for each IPC command. Each handler:
// 1. Receives the decoded command (narrowed by `cmd` discriminant)
// 2. Accesses services via `yield* Tag`
// 3. Returns an IPCResponse-compatible object
// 4. Error channel is `never` (handlers catch/transform expected errors)

import { Data, Deferred, Effect, Ref, type Schema } from "effect";
import { hashPin } from "../../../auth.js";
import type { IPCCommandSchema } from "../../../daemon/ipc-protocol.js";
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

// ─── Type extraction ─────────────────────────────────────────────────────────

type DecodedCommand = Schema.Schema.Type<typeof IPCCommandSchema>;
type CmdOf<C extends string> = Extract<DecodedCommand, { cmd: C }>;

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
	cmd: CmdOf<"add_project">,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		// Check for duplicate directory
		const existing = state.projects.find((p) => p.path === cmd.directory);
		if (existing) {
			return { ok: false, error: `Project already exists: ${existing.slug}` };
		}

		// Generate slug
		const existingSlugs = new Set(state.projects.map((p) => p.slug));
		const slug = generateSlug(cmd.directory, existingSlugs);

		// Add project to state
		yield* Ref.update(ref, (s) => ({
			...s,
			projects: [
				...s.projects,
				{
					path: cmd.directory,
					slug,
					addedAt: Date.now(),
				},
			],
		}));

		yield* requestConfigSave;
		return { ok: true, slug, directory: cmd.directory };
	});

export const handleRemoveProject = (
	cmd: CmdOf<"remove_project">,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		const exists = state.projects.some((p) => p.slug === cmd.slug);
		if (!exists) {
			return { ok: false, error: `Project not found: ${cmd.slug}` };
		}

		yield* Ref.update(ref, (s) => ({
			...s,
			projects: s.projects.filter((p) => p.slug !== cmd.slug),
		}));

		yield* requestConfigSave;
		return { ok: true };
	});

export const handleSetProjectTitle = (
	cmd: CmdOf<"set_project_title">,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const state = yield* Ref.get(ref);

		const exists = state.projects.some((p) => p.slug === cmd.slug);
		if (!exists) {
			return { ok: false, error: `Project not found: ${cmd.slug}` };
		}

		yield* Ref.update(ref, (s) => ({
			...s,
			projects: s.projects.map((p) =>
				p.slug === cmd.slug ? { ...p, title: cmd.title } : p,
			),
		}));

		yield* requestConfigSave;
		return { ok: true };
	});

// ─── State handlers ──────────────────────────────────────────────────────────

export const handleSetPin = (
	cmd: CmdOf<"set_pin">,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | PersistDeps
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const hashed = hashPin(cmd.pin);

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
	cmd: CmdOf<"set_keep_awake">,
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
		if (cmd.enabled) {
			yield* keepAwake.activate();
		} else {
			yield* keepAwake.deactivate();
		}

		const supported = yield* keepAwake.isSupported();
		const active = yield* keepAwake.isActive();

		yield* Ref.update(ref, (s) => ({
			...s,
			keepAwake: cmd.enabled,
		}));
		yield* commitDaemonRuntimeConfig((c) => ({
			...c,
			keepAwake: cmd.enabled,
		}));

		yield* requestConfigSave;
		return { ok: true, supported, active };
	});

export const handleSetKeepAwakeCommand = (
	cmd: CmdOf<"set_keep_awake_command">,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | PersistDeps
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			keepAwakeCommand: cmd.command,
			keepAwakeArgs: [...cmd.args],
		}));
		yield* commitDaemonRuntimeConfig((c) => ({
			...c,
			keepAwakeCommand: cmd.command,
			keepAwakeArgs: [...cmd.args],
		}));

		yield* requestConfigSave;
		return { ok: true };
	});

export const handleShutdown = (
	_cmd: CmdOf<"shutdown">,
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
	_cmd: CmdOf<"list_projects">,
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
	_cmd: CmdOf<"get_status">,
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
	_cmd: CmdOf<"instance_list">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;
		const instances = mgmt.getInstances();
		return { ok: true, instances };
	});

export const handleInstanceAdd = (
	cmd: CmdOf<"instance_add">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		const id = `inst-${Date.now()}`;
		const config: import("../../../shared-types.js").InstanceConfig = {
			name: cmd.name,
			port: cmd.port ?? 0,
			managed: cmd.managed,
		};
		if (cmd.env !== undefined) config.env = cmd.env as Record<string, string>;
		if (cmd.url !== undefined) config.url = cmd.url;
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
	cmd: CmdOf<"instance_remove">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtOperation("removeInstance", () => {
			mgmt.removeInstance(cmd.id);
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
	cmd: CmdOf<"instance_start">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtPromise("startInstance", () =>
			mgmt.startInstance(cmd.id),
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
	cmd: CmdOf<"instance_stop">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtOperation("stopInstance", () => {
			mgmt.stopInstance(cmd.id);
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
	cmd: CmdOf<"instance_status">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;
		const instances = mgmt.getInstances();
		const instance = instances.find((i) => i.id === cmd.id);

		if (!instance) {
			return { ok: false, error: `Instance not found: ${cmd.id}` };
		}

		return { ok: true, instance };
	});

export const handleInstanceUpdate = (
	cmd: CmdOf<"instance_update">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* tryInstanceMgmtOperation("updateInstance", () => {
			const updates: {
				name?: string;
				env?: Record<string, string>;
				port?: number;
			} = {};
			if (cmd.name !== undefined) updates.name = cmd.name;
			if (cmd.env !== undefined)
				updates.env = cmd.env as Record<string, string>;
			if (cmd.port !== undefined) updates.port = cmd.port;
			const instance = mgmt.updateInstance(cmd.id, updates);
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
	cmd: CmdOf<"set_agent">,
): Effect.Effect<IPCResponse, never, OverridesStateTag> =>
	Effect.gen(function* () {
		// Protocol uses `slug` as the identifier (not sessionId)
		yield* setAgent(cmd.slug, cmd.agent);
		return { ok: true };
	});

export const handleSetModel = (
	cmd: CmdOf<"set_model">,
): Effect.Effect<IPCResponse, never, OverridesStateTag> =>
	Effect.gen(function* () {
		// Protocol uses `slug` as the identifier (not sessionId)
		yield* setModel(cmd.slug, {
			providerID: cmd.provider,
			modelID: cmd.model,
		});
		return { ok: true };
	});

// ─── Restart handler ─────────────────────────────────────────────────────────

export const handleRestartWithConfig = (
	cmd: CmdOf<"restart_with_config">,
): Effect.Effect<
	IPCResponse,
	never,
	DaemonStateTag | DaemonConfigRefTag | ShutdownSignalTag | PersistDeps
> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		yield* Ref.update(ref, (s) => ({
			...applyRestartConfig(s, cmd.config),
			shuttingDown: true,
		}));
		yield* commitDaemonRuntimeConfig((c) => ({
			...applyRestartRuntimeConfig(c, cmd.config),
			shuttingDown: true,
		}));

		yield* requestConfigSave;

		// AP-25: Complete the ShutdownSignal Deferred to trigger graceful shutdown.
		const shutdownDeferred = yield* ShutdownSignalTag;
		yield* Deferred.succeed(shutdownDeferred, undefined);

		return { ok: true };
	});
