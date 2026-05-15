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
import type { DaemonStatus } from "./daemon-types.js";

type MaybePromise<T> = T | Promise<T>;

// ─── Context interface ──────────────────────────────────────────────────────
// Narrow surface the IPC handlers need from the Daemon instance.

export interface DaemonIPCContext {
	/** Add a project, returning its info. */
	addProject(directory: string): Promise<StoredProject>;
	/** Remove a project by slug. */
	removeProject(slug: string): Promise<void>;
	/** Return the full daemon status snapshot. */
	getStatus(): DaemonStatus;
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
	setProjectTitle(slug: string, title: string): MaybePromise<void>;
	/** Persist daemon config to disk. */
	persistConfig(): MaybePromise<void>;
	/** Return all registered OpenCode instances. */
	getInstances(): ReadonlyArray<Readonly<OpenCodeInstance>>;
	/** Look up a single instance by ID. */
	getInstance(id: string): Readonly<OpenCodeInstance> | undefined;
	/** Register a new OpenCode instance. */
	addInstance(
		id: string,
		config: InstanceConfig,
	): MaybePromise<Readonly<OpenCodeInstance>>;
	/** Remove an instance by ID. */
	removeInstance(id: string): MaybePromise<void>;
	/** Start a managed instance. */
	startInstance(id: string): Promise<void>;
	/** Stop an instance. */
	stopInstance(id: string): MaybePromise<void>;
	/** Update an instance's name, env, or port. */
	updateInstance(
		id: string,
		updates: { name?: string; env?: Record<string, string>; port?: number },
	): MaybePromise<Readonly<OpenCodeInstance>>;
	/** Set the active/default agent for a registered project relay. */
	setProjectAgent(slug: string, agent: string): Promise<void>;
	/** Set the default model for a registered project relay. */
	setProjectModel(
		slug: string,
		model: { providerID: string; modelID: string },
	): Promise<void>;
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
	restartWithConfig: (config?: Record<string, unknown>) => Promise<IPCResponse>;
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
 */
export function buildIPCHandlers(ctx: DaemonIPCContext): IPCHandlerMap {
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
				await ctx.setProjectTitle(slug, title);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		getStatus: async (): Promise<IPCResponse> => {
			return { ...ctx.getStatus() };
		},

		setPin: async (pin: string): Promise<IPCResponse> => {
			void pin;
			return {
				ok: false,
				error:
					"set_pin is handled by Effect IPC dispatch, not buildIPCHandlers",
			};
		},

		setKeepAwake: async (enabled: boolean): Promise<IPCResponse> => {
			void enabled;
			return {
				ok: false,
				error:
					"set_keep_awake is handled by Effect IPC dispatch, not buildIPCHandlers",
			};
		},

		setKeepAwakeCommand: async (
			command: string,
			args: string[],
		): Promise<IPCResponse> => {
			void command;
			void args;
			return {
				ok: false,
				error:
					"set_keep_awake_command is handled by Effect IPC dispatch, not buildIPCHandlers",
			};
		},

		shutdown: async (): Promise<IPCResponse> => {
			return {
				ok: false,
				error:
					"shutdown is scheduled by the IPC socket post-response hook, not buildIPCHandlers",
			};
		},

		setAgent: async (slug: string, agent: string): Promise<IPCResponse> => {
			try {
				await ctx.setProjectAgent(slug, agent);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		setModel: async (
			slug: string,
			provider: string,
			model: string,
		): Promise<IPCResponse> => {
			try {
				await ctx.setProjectModel(slug, {
					providerID: provider,
					modelID: model,
				});
				return { ok: true };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		restartWithConfig: async (
			config?: Record<string, unknown>,
		): Promise<IPCResponse> => {
			if (config !== undefined) {
				return {
					ok: false,
					error:
						"restart_with_config is handled by Effect IPC dispatch, not buildIPCHandlers",
				};
			}
			return {
				ok: false,
				error:
					"restart_with_config shutdown is scheduled by the IPC socket post-response hook, not buildIPCHandlers",
			};
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
				const instance = await ctx.addInstance(id, {
					name,
					port: port ?? 0,
					managed,
					...(env != null && { env }),
					...(url != null && { url }),
				});
				await ctx.persistConfig();
				return { ok: true, instance };
			} catch (err) {
				return { ok: false, error: formatErrorDetail(err) };
			}
		},

		instanceRemove: async (id: string): Promise<IPCResponse> => {
			try {
				await ctx.removeInstance(id);
				await ctx.persistConfig();
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
				await ctx.stopInstance(id);
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
				const instance = await ctx.updateInstance(instanceId, updates);
				await ctx.persistConfig();
				return { ok: true, instance };
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
