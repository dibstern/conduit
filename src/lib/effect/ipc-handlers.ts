// ─── IPC Effect Handlers ─────────────────────────────────────────────────────
// Effect-returning handlers for each IPC command. Each handler:
// 1. Receives the decoded command (narrowed by `cmd` discriminant)
// 2. Accesses services via `yield* Tag`
// 3. Returns an IPCResponse-compatible object
// 4. Error channel is `never` (handlers catch/transform expected errors)

import { createHash } from "node:crypto";
import type { FileSystem } from "@effect/platform";
import { Effect, Ref, type Schema } from "effect";
import type { IPCCommandSchema } from "../daemon/ipc-protocol.js";
import type { IPCResponse } from "../types.js";
import { generateSlug } from "../utils.js";
import {
	type PersistencePathTag,
	persistConfig,
} from "./daemon-config-persistence.js";
import { DaemonStateTag } from "./daemon-state.js";
import { InstanceMgmtTag, SessionOverridesTag } from "./services.js";

// ─── Type extraction ─────────────────────────────────────────────────────────

type DecodedCommand = Schema.Schema.Type<typeof IPCCommandSchema>;
type CmdOf<C extends string> = Extract<DecodedCommand, { cmd: C }>;

// ─── Shared dependency types ─────────────────────────────────────────────────

/** Dependencies needed for persistConfig calls. */
type PersistDeps = DaemonStateTag | FileSystem.FileSystem | PersistencePathTag;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Hash a PIN using SHA-256 */
const hashPin = (pin: string): string =>
	createHash("sha256").update(pin).digest("hex");

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

		yield* persistConfig;
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

		yield* persistConfig;
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

		yield* persistConfig;
		return { ok: true };
	});

// ─── State handlers ──────────────────────────────────────────────────────────

export const handleSetPin = (
	cmd: CmdOf<"set_pin">,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;
		const hashed = hashPin(cmd.pin);

		yield* Ref.update(ref, (s) => ({
			...s,
			pinHash: hashed,
		}));

		yield* persistConfig;
		return { ok: true };
	});

export const handleSetKeepAwake = (
	cmd: CmdOf<"set_keep_awake">,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;

		yield* Ref.update(ref, (s) => ({
			...s,
			keepAwake: cmd.enabled,
		}));

		yield* persistConfig;
		return { ok: true };
	});

export const handleSetKeepAwakeCommand = (
	cmd: CmdOf<"set_keep_awake_command">,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;

		yield* Ref.update(ref, (s) => ({
			...s,
			keepAwakeCommand: cmd.command,
			keepAwakeArgs: [...cmd.args],
		}));

		yield* persistConfig;
		return { ok: true };
	});

export const handleShutdown = (
	_cmd: CmdOf<"shutdown">,
): Effect.Effect<IPCResponse, never, DaemonStateTag> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;

		yield* Ref.update(ref, (s) => ({
			...s,
			shuttingDown: true,
		}));

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
			projectCount: state.projects.length,
			clientCount: state.clientCount,
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
		const config: import("../shared-types.js").InstanceConfig = {
			name: cmd.name,
			port: cmd.port ?? 0,
			managed: cmd.managed,
		};
		if (cmd.env !== undefined) config.env = cmd.env as Record<string, string>;
		if (cmd.url !== undefined) config.url = cmd.url;
		const instance = mgmt.addInstance(id, config);
		mgmt.persistConfig();

		return { ok: true, instance };
	});

export const handleInstanceRemove = (
	cmd: CmdOf<"instance_remove">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* Effect.try(() => {
			mgmt.removeInstance(cmd.id);
			mgmt.persistConfig();
			return { ok: true } as IPCResponse;
		}).pipe(
			Effect.catchAll((e) =>
				Effect.succeed({ ok: false, error: String(e) } as IPCResponse),
			),
		);
	});

export const handleInstanceStart = (
	cmd: CmdOf<"instance_start">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* Effect.tryPromise(() => mgmt.startInstance(cmd.id)).pipe(
			Effect.map(() => ({ ok: true }) as IPCResponse),
			Effect.catchAll((e) =>
				Effect.succeed({ ok: false, error: String(e) } as IPCResponse),
			),
		);
	});

export const handleInstanceStop = (
	cmd: CmdOf<"instance_stop">,
): Effect.Effect<IPCResponse, never, InstanceMgmtTag> =>
	Effect.gen(function* () {
		const mgmt = yield* InstanceMgmtTag;

		return yield* Effect.try(() => {
			mgmt.stopInstance(cmd.id);
			return { ok: true } as IPCResponse;
		}).pipe(
			Effect.catchAll((e) =>
				Effect.succeed({ ok: false, error: String(e) } as IPCResponse),
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

		return yield* Effect.try(() => {
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
			Effect.catchAll((e) =>
				Effect.succeed({ ok: false, error: String(e) } as IPCResponse),
			),
		);
	});

// ─── Session override handlers ──────────────────────────────────────────────

export const handleSetAgent = (
	cmd: CmdOf<"set_agent">,
): Effect.Effect<IPCResponse, never, SessionOverridesTag> =>
	Effect.gen(function* () {
		const overrides = yield* SessionOverridesTag;
		// Protocol uses `slug` as the identifier (not sessionId)
		overrides.setAgent(cmd.slug, cmd.agent);
		return { ok: true };
	});

export const handleSetModel = (
	cmd: CmdOf<"set_model">,
): Effect.Effect<IPCResponse, never, SessionOverridesTag> =>
	Effect.gen(function* () {
		const overrides = yield* SessionOverridesTag;
		// Protocol uses `slug` as the identifier (not sessionId)
		overrides.setModel(cmd.slug, {
			providerID: cmd.provider,
			modelID: cmd.model,
		});
		return { ok: true };
	});

// ─── Restart handler ─────────────────────────────────────────────────────────

export const handleRestartWithConfig = (
	_cmd: CmdOf<"restart_with_config">,
): Effect.Effect<IPCResponse, never, DaemonStateTag | PersistDeps> =>
	Effect.gen(function* () {
		const ref = yield* DaemonStateTag;

		yield* Ref.update(ref, (s) => ({
			...s,
			shuttingDown: true,
		}));

		yield* persistConfig;
		return { ok: true };
	});
