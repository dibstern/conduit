// ─── Daemon IPC Handlers (extracted from daemon.ts) ─────────────────────────
// Builds the IPC command handler map used by the daemon's Unix socket server.
// Each handler receives its dependencies via the DaemonContext interface,
// keeping the handler logic decoupled from the Daemon class internals.

import { formatErrorDetail } from "../errors.js";
import type {
	InstanceConfig,
	IPCResponse,
	OpenCodeInstance,
	StoredProject,
} from "../types.js";
import type { DaemonStatus } from "./daemon.js";

// ─── Context interface ──────────────────────────────────────────────────────
// Narrow surface the IPC handlers need from the Daemon instance.

export interface DaemonIPCContext {
	/** Add a project, returning its info. */
	addProject(directory: string): Promise<StoredProject>;
	/** Remove a project by slug. */
	removeProject(slug: string): Promise<void>;
	/** Return all registered projects (enriched with live relay data). */
	getProjects(): ReadonlyArray<
		Readonly<
			StoredProject & {
				sessions?: number;
				clients?: number;
				isProcessing?: boolean;
			}
		>
	>;
	/** Set the project title via registry. */
	setProjectTitle(slug: string, title: string): void;
	/** Get current PIN hash (null if unset). */
	getPinHash(): string | null;
	/** Update the PIN hash, auth manager, and persist config. */
	setPinHash(hash: string): void;
	/** Get current keepAwake state. */
	getKeepAwake(): boolean;
	/** Update keepAwake state, underlying manager, and persist config. */
	setKeepAwake(enabled: boolean): { supported: boolean; active: boolean };
	/** Set custom keep-awake command and args, replacing the current manager. */
	setKeepAwakeCommand(command: string, args: string[]): void;
	/** Persist daemon config to disk. */
	persistConfig(): void;
	/** Schedule a graceful daemon shutdown. */
	scheduleShutdown(): void;
	/** Return all registered OpenCode instances. */
	getInstances(): ReadonlyArray<Readonly<OpenCodeInstance>>;
	/** Look up a single instance by ID. */
	getInstance(id: string): Readonly<OpenCodeInstance> | undefined;
	/** Register a new OpenCode instance. */
	addInstance(id: string, config: InstanceConfig): Readonly<OpenCodeInstance>;
	/** Remove an instance by ID. */
	removeInstance(id: string): void;
	/** Start a managed instance. */
	startInstance(id: string): Promise<void>;
	/** Stop an instance. */
	stopInstance(id: string): void;
	/** Update an instance's name, env, or port. */
	updateInstance(
		id: string,
		updates: { name?: string; env?: Record<string, string>; port?: number },
	): Readonly<OpenCodeInstance>;
}

// ─── Handler map type ───────────────────────────────────────────────────────
// Matches the shape expected by createCommandRouter() from ipc-protocol.ts.

export interface IPCHandlerMap {
	addProject: (directory: string) => Promise<IPCResponse>;
	removeProject: (slug: string) => Promise<IPCResponse>;
	listProjects: () => Promise<IPCResponse>;
	setProjectTitle: (slug: string, title: string) => Promise<IPCResponse>;
	getStatus: () => Promise<IPCResponse>;
	setPin: (pin: string) => Promise<IPCResponse>;
	setKeepAwake: (enabled: boolean) => Promise<IPCResponse>;
	setKeepAwakeCommand: (
		command: string,
		args: string[],
	) => Promise<IPCResponse>;
	shutdown: () => Promise<IPCResponse>;
	setAgent: (slug: string, agent: string) => Promise<IPCResponse>;
	setModel: (
		slug: string,
		provider: string,
		model: string,
	) => Promise<IPCResponse>;
	restartWithConfig: () => Promise<IPCResponse>;
	instanceList: () => Promise<IPCResponse>;
	instanceAdd: (
		name: string,
		port?: number,
		managed?: boolean,
		env?: Record<string, string>,
		url?: string,
	) => Promise<IPCResponse>;
	instanceRemove: (id: string) => Promise<IPCResponse>;
	instanceStart: (id: string) => Promise<IPCResponse>;
	instanceStop: (id: string) => Promise<IPCResponse>;
	instanceUpdate: (
		instanceId: string,
		name?: string,
		env?: Record<string, string>,
		port?: number,
	) => Promise<IPCResponse>;
	instanceStatus: (id: string) => Promise<IPCResponse>;
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build the IPC handler map for a daemon instance.
 *
 * @param ctx  Narrow interface into the running Daemon
 * @param getStatus  Returns the full DaemonStatus snapshot (spread into IPCResponse)
 */
export function buildIPCHandlers(
	ctx: DaemonIPCContext,
	getStatus: () => DaemonStatus,
): IPCHandlerMap {
	return {
		addProject: async (directory: string): Promise<IPCResponse> => {
			try {
				const project = await ctx.addProject(directory);
				return {
					ok: true,
					slug: project.slug,
					directory: project.directory,
				};
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		removeProject: async (slug: string): Promise<IPCResponse> => {
			try {
				await ctx.removeProject(slug);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		listProjects: async (): Promise<IPCResponse> => {
			return { ok: true, projects: ctx.getProjects() };
		},

		setProjectTitle: async (
			slug: string,
			title: string,
		): Promise<IPCResponse> => {
			try {
				ctx.setProjectTitle(slug, title);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		getStatus: async (): Promise<IPCResponse> => {
			return { ...getStatus() };
		},

		setPin: async (pin: string): Promise<IPCResponse> => {
			// Hash the PIN, update auth enforcement, and persist config
			const { hashPin } = await import("../auth.js");
			ctx.setPinHash(hashPin(pin));
			return { ok: true };
		},

		setKeepAwake: async (enabled: boolean): Promise<IPCResponse> => {
			const result = ctx.setKeepAwake(enabled);
			return { ok: true, supported: result.supported, active: result.active };
		},

		setKeepAwakeCommand: async (
			command: string,
			args: string[],
		): Promise<IPCResponse> => {
			try {
				ctx.setKeepAwakeCommand(command, args);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		shutdown: async (): Promise<IPCResponse> => {
			// Schedule shutdown after response is sent
			ctx.scheduleShutdown();
			return { ok: true };
		},

		setAgent: async (_slug: string, _agent: string): Promise<IPCResponse> => {
			return { ok: true };
		},

		setModel: async (
			_slug: string,
			_provider: string,
			_model: string,
		): Promise<IPCResponse> => {
			return { ok: true };
		},

		restartWithConfig: async (): Promise<IPCResponse> => {
			// Schedule shutdown and return ok
			ctx.scheduleShutdown();
			return { ok: true };
		},

		instanceList: async (): Promise<IPCResponse> => {
			return { ok: true, instances: ctx.getInstances() };
		},

		instanceAdd: async (
			name: string,
			port?: number,
			managed = true,
			env?: Record<string, string>,
			url?: string,
		): Promise<IPCResponse> => {
			try {
				let id =
					name
						.toLowerCase()
						.replace(/[^a-z0-9-]/g, "-")
						.replace(/-+/g, "-")
						.replace(/^-|-$/g, "") || "instance";
				// Ensure uniqueness: add numeric suffix if base ID is taken
				let counter = 2;
				const baseId = id;
				while (ctx.getInstance(id)) {
					id = `${baseId}-${counter}`;
					counter++;
				}
				const instance = ctx.addInstance(id, {
					name,
					port: port ?? 0,
					managed,
					...(env != null && { env }),
					...(url != null && { url }),
				});
				ctx.persistConfig();
				return { ok: true, instance };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		instanceRemove: async (id: string): Promise<IPCResponse> => {
			try {
				ctx.removeInstance(id);
				ctx.persistConfig();
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		instanceStart: async (id: string): Promise<IPCResponse> => {
			try {
				await ctx.startInstance(id);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		instanceStop: async (id: string): Promise<IPCResponse> => {
			try {
				ctx.stopInstance(id);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		instanceUpdate: async (
			instanceId: string,
			name?: string,
			env?: Record<string, string>,
			port?: number,
		): Promise<IPCResponse> => {
			if (!instanceId) return { ok: false, error: "instanceId required" };
			try {
				const updates: {
					name?: string;
					env?: Record<string, string>;
					port?: number;
				} = {};
				if (name !== undefined) updates.name = name;
				if (env !== undefined) updates.env = env;
				if (port !== undefined) updates.port = port;
				ctx.updateInstance(instanceId, updates);
				ctx.persistConfig();
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		instanceStatus: async (id: string): Promise<IPCResponse> => {
			const instance = ctx.getInstance(id);
			if (!instance) return { ok: false, error: `Instance "${id}" not found` };
			return { ok: true, instance };
		},
	};
}
