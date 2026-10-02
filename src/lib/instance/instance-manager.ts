// Manages OpenCode instance CRUD, URL resolution, lifecycle events,
// process spawning, and health checks.

import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import type { ManagedOpenCodeProcessIdentity } from "../contracts/managed-opencode.js";
import { formatErrorDetail } from "../errors.js";
import type { InstanceConfig, OpenCodeInstance } from "../types.js";
import {
	cannotStartExternalInstance,
	instanceAlreadyExists,
	instanceLimitExceeded,
	instanceNotFound,
	invalidInstanceUrl,
} from "./instance-errors.js";
import {
	availableOpenCodePort,
	canReuseManagedOpenCode,
	commitManagedOpenCodeSpawn,
	inspectManagedOpenCodeProcess,
	isProcessAlive,
	ManagedOpenCodeProcessError,
	type ManagedOpenCodeRecord,
	managedOpenCodeEnv,
	probeOpenCodeHealth,
	publicManagedOpenCodeEnv,
	spawnManagedOpenCode,
	stopManagedOpenCode,
	waitForOpenCodeHealth,
} from "./managed-opencode-process.js";

export type InstanceSpawner = (
	port: number,
	env?: Record<string, string>,
	id?: string,
) => Promise<{
	pid: number;
	process: ChildProcess;
	processIdentity?: ManagedOpenCodeProcessIdentity;
}>;

export type InstanceHealthChecker = (
	port: number,
	instance: OpenCodeInstance,
) => Promise<boolean>;

/** Callback signatures for each InstanceManager event type. */
export interface InstanceManagerCallbacks {
	instance_added: (instance: OpenCodeInstance) => void;
	instance_removed: (id: string) => void;
	status_changed: (instance: OpenCodeInstance) => void;
	instance_error: (payload: { id: string; error: string }) => void;
}

export interface InstanceManagerOptions {
	/** Maximum number of instances allowed. Default: 5. */
	maxInstances?: number;
	/** Max crash restarts allowed within the restart window. Default: 3. */
	maxRestartsPerWindow?: number;
	/** Time window (ms) for counting crash restarts. Default: 60 000. */
	restartWindowMs?: number;
	/** Health polling interval (ms). Default: 5 000. */
	healthPollIntervalMs?: number;
	configDir?: string;
}

export class InstanceManager {
	private readonly maxInstances: number;
	private readonly maxRestartsPerWindow: number;
	private readonly restartWindowMs: number;
	private readonly healthPollIntervalMs: number;
	private readonly configDir: string | undefined;

	private readonly instances = new Map<string, OpenCodeInstance>();
	/** External URLs for unmanaged instances (keeps OpenCodeInstance clean). */
	private readonly externalUrls = new Map<string, string>();
	/** Tracks spawned child processes by instance ID. */
	private readonly processes = new Map<string, ChildProcess>();
	/** Backend-only credentials and supervisor generation identities. */
	private readonly instanceRecords = new Map<string, ManagedOpenCodeRecord>();
	/** Retains authenticated ownership until cleanup succeeds, including removals. */
	private readonly ownedProcesses = new Map<
		ManagedOpenCodeProcessIdentity,
		ManagedOpenCodeRecord
	>();
	private readonly pendingStops = new Map<string, Promise<void>>();
	/** Injectable spawner function (for testing). */
	private spawner: InstanceSpawner | null = null;
	/** Injectable health checker function (for testing). */
	private healthChecker: InstanceHealthChecker | null = null;
	/** Health polling intervals by instance ID. */
	private readonly healthIntervals = new Map<
		string,
		ReturnType<typeof setInterval>
	>();
	/** Pending restart timer IDs by instance ID (for cancellation). */
	private readonly pendingRestarts = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	/** Restart timestamps per instance for rate-limiting. */
	private readonly restartTimestamps = new Map<string, number[]>();
	/** Pending fire-and-forget promises — awaited in drain(). */
	private readonly pendingPromises = new Set<Promise<unknown>>();

	/** Registered callbacks keyed by event type. */
	private readonly callbacks: {
		[K in keyof InstanceManagerCallbacks]: InstanceManagerCallbacks[K][];
	} = {
		instance_added: [],
		instance_removed: [],
		status_changed: [],
		instance_error: [],
	};

	constructor(options: InstanceManagerOptions = {}) {
		this.maxInstances = options.maxInstances ?? 5;
		this.maxRestartsPerWindow = options.maxRestartsPerWindow ?? 3;
		this.restartWindowMs = options.restartWindowMs ?? 60_000;
		this.healthPollIntervalMs = options.healthPollIntervalMs ?? 5_000;
		this.configDir = options.configDir;
	}

	/** Register a callback for a specific event type. */
	on<K extends keyof InstanceManagerCallbacks>(
		event: K,
		callback: InstanceManagerCallbacks[K],
	): void {
		this.callbacks[event].push(callback);
	}

	/** Invoke all registered callbacks for a given event type. */
	private notify<K extends keyof InstanceManagerCallbacks>(
		event: K,
		...args: Parameters<InstanceManagerCallbacks[K]>
	): void {
		for (const cb of this.callbacks[event]) {
			(cb as (...a: unknown[]) => void)(...args);
		}
	}

	/** Inject a custom spawner (for testing). */
	setSpawner(spawner: InstanceSpawner): void {
		this.spawner = spawner;
	}

	/** Inject a custom health checker (for testing). */
	setHealthChecker(checker: InstanceHealthChecker): void {
		this.healthChecker = checker;
	}

	/**
	 * Register a new instance with status "stopped".
	 * Rejects duplicate IDs and enforces maxInstances.
	 */
	addInstance(
		id: string,
		config: InstanceConfig & {
			processIdentity?: ManagedOpenCodeProcessIdentity;
		},
	): OpenCodeInstance {
		if (this.instances.has(id)) {
			throw instanceAlreadyExists(id);
		}
		if (this.instances.size >= this.maxInstances) {
			throw instanceLimitExceeded(this.maxInstances);
		}

		// Validate URL if provided (defense-in-depth: IPC layer already validates,
		// but direct callers like tests or future APIs should also get a clear error)
		if (config.url) {
			try {
				new URL(config.url);
			} catch (cause) {
				throw invalidInstanceUrl(id, config.url, cause);
			}
		}

		const instance: OpenCodeInstance = {
			id,
			name: config.name,
			port: config.port,
			managed: config.managed,
			...(config.managed && config.pid !== undefined
				? {
						pid: config.pid,
						...(config.version !== undefined && { version: config.version }),
					}
				: {}),
			status: "stopped",
			...(config.env != null && {
				env: publicManagedOpenCodeEnv(config.env),
			}),
			restartCount: 0,
			createdAt: Date.now(),
		};

		this.instances.set(id, instance);
		this.instanceRecords.set(id, {
			...config,
			...(config.env != null && { env: { ...config.env } }),
		});

		if (config.url) {
			this.externalUrls.set(id, config.url);
		}

		// Unmanaged (external) instances have no process lifecycle — start health
		// polling immediately so their status reflects whether the server is reachable.
		if (!config.managed) {
			this.startHealthPolling(id);
		}

		this.notify("instance_added", instance);
		return instance;
	}

	/**
	 * Remove an instance by ID. Stops it first if running, cancels pending
	 * restart timers, and cleans up all associated state. Throws if not found.
	 */
	removeInstance(id: string): void {
		if (!this.instances.has(id)) {
			throw instanceNotFound(id);
		}
		// Stop process and health polling if running
		this.stopInstance(id);
		// Cancel any pending restart timer
		this.cancelPendingRestart(id);
		// Clean up restart rate-limit timestamps
		this.restartTimestamps.delete(id);

		this.instances.delete(id);
		this.instanceRecords.delete(id);
		this.externalUrls.delete(id);
		this.notify("instance_removed", id);
	}

	/**
	 * Returns all registered instances as an array.
	 */
	getInstances(): OpenCodeInstance[] {
		return [...this.instances.values()];
	}

	/**
	 * Returns a single instance by ID, or undefined if not found.
	 */
	getInstance(id: string): OpenCodeInstance | undefined {
		return this.instances.get(id);
	}

	/**
	 * Updates a registered instance's configuration.
	 * Only name, env, and port can be updated.
	 * Sets needsRestart=true if env or port changes while instance is running.
	 */
	updateInstance(
		id: string,
		updates: { name?: string; env?: Record<string, string>; port?: number },
	): OpenCodeInstance {
		const instance = this.instances.get(id);
		const record = this.instanceRecords.get(id);
		if (!instance || !record) throw instanceNotFound(id);

		const isRunning =
			instance.status === "healthy" || instance.status === "starting";
		let changed = false;

		if (updates.name !== undefined && updates.name !== instance.name) {
			instance.name = updates.name;
			changed = true;
		}
		if (updates.port !== undefined && updates.port !== instance.port) {
			instance.port = updates.port;
			record.port = updates.port;
			changed = true;
			if (isRunning) instance.needsRestart = true;
		}
		if (updates.env !== undefined) {
			const oldEnv = JSON.stringify(record.env ?? {});
			const newEnv = JSON.stringify(updates.env);
			if (oldEnv !== newEnv) {
				record.env = { ...updates.env };
				instance.env = publicManagedOpenCodeEnv(updates.env);
				changed = true;
				if (isRunning) instance.needsRestart = true;
			}
		}

		if (changed) {
			this.notify("status_changed", instance);
		}

		return instance;
	}

	/**
	 * Returns the URL for an instance.
	 * - External instances with a custom URL return that URL.
	 * - All others return `http://localhost:{port}`.
	 * Throws if instance not found.
	 */
	getInstanceUrl(id: string): string {
		const instance = this.instances.get(id);
		if (!instance) {
			throw instanceNotFound(id);
		}

		const externalUrl = this.externalUrls.get(id);
		if (externalUrl) {
			return externalUrl;
		}

		return `http://localhost:${instance.port}`;
	}

	/**
	 * Start a managed instance: spawn its process and begin health polling.
	 * Throws if instance not found or not managed. Returns early if already
	 * healthy or starting. Kills existing process if unhealthy.
	 */
	async startInstance(id: string): Promise<void> {
		const instance = this.instances.get(id);
		const record = this.instanceRecords.get(id);
		if (!instance || !record) {
			throw instanceNotFound(id);
		}

		if (!instance.managed) {
			throw cannotStartExternalInstance(id);
		}

		// Idempotent: don't re-spawn if already healthy or starting
		if (instance.status === "healthy" || instance.status === "starting") {
			return;
		}
		const wasUnhealthy = instance.status === "unhealthy";

		// Cancel any pending restart timer (user is manually starting)
		this.cancelPendingRestart(id);
		this.stopHealthPolling(id);

		// Reserve recovery before the first await so concurrent starts cannot spawn.
		instance.status = "starting";
		instance.needsRestart = false;
		this.notify("status_changed", instance);

		try {
			const pendingStop = this.pendingStops.get(id);
			if (pendingStop) await pendingStop;
			if (!this.spawner && (await canReuseManagedOpenCode(record))) {
				const owned = await inspectManagedOpenCodeProcess(
					record.processIdentity,
				);
				if (owned?.running && owned.listening) {
					if (
						this.instances.get(id) !== instance ||
						instance.status !== "starting"
					) {
						return;
					}
					record.pid = owned.pid;
					instance.pid = owned.pid;
					if (record.processIdentity)
						this.ownedProcesses.set(record.processIdentity, { ...record });
					instance.status = "healthy";
					instance.lastHealthCheck = Date.now();
					this.notify("status_changed", instance);
					this.startHealthPolling(id);
					return;
				}
			}

			const oldProc = this.processes.get(id);
			if (oldProc && (wasUnhealthy || !this.spawner)) {
				oldProc.removeAllListeners("exit");
				if (this.spawner) oldProc.kill("SIGTERM");
				this.processes.delete(id);
			}
			const oldIdentity = record.processIdentity;
			if (!this.spawner && oldIdentity) {
				await this.stopManagedProcess(record);
				delete record.processIdentity;
			}

			// Spawn the process
			const spawnFn = this.spawner ?? this.defaultSpawner.bind(this);

			// Give each instance its own XDG_DATA_HOME so auth.json is isolated
			const effectiveEnv = managedOpenCodeEnv(record.env);
			if (!effectiveEnv["XDG_DATA_HOME"]) {
				const base =
					process.env["XDG_DATA_HOME"] ?? `${homedir()}/.local/share`;
				effectiveEnv["XDG_DATA_HOME"] = `${base}/conduit/${id}`;
			}

			if (
				!this.spawner &&
				(instance.pid !== undefined || instance.port === 0)
			) {
				instance.port = await availableOpenCodePort();
			}
			if (
				this.instances.get(id) !== instance ||
				instance.status !== "starting"
			) {
				return;
			}
			delete instance.pid;
			delete instance.version;
			delete record.pid;
			delete record.version;
			record.port = instance.port;
			record.env = effectiveEnv;
			instance.env = publicManagedOpenCodeEnv(effectiveEnv);
			const {
				pid,
				process: proc,
				processIdentity,
			} = await spawnFn(instance.port, effectiveEnv, id);
			if (!this.spawner && processIdentity)
				this.ownedProcesses.set(processIdentity, {
					...record,
					pid,
					processIdentity,
				});
			if (
				this.instances.get(id) !== instance ||
				instance.status !== "starting"
			) {
				if (this.spawner) proc.kill("SIGTERM");
				else if (processIdentity)
					await this.stopManagedProcess({ ...record, pid, processIdentity });
				return;
			}

			instance.pid = pid;
			record.pid = pid;
			if (processIdentity) record.processIdentity = processIdentity;
			this.processes.set(id, proc);

			// Wire up exit handler for crash recovery
			proc.on("exit", (code: number | null, signal: string | null) => {
				this.handleProcessExit(id, code, signal);
			});
			if (!this.spawner) {
				this.notify("status_changed", instance);
				await commitManagedOpenCodeSpawn(proc);
			}

			// Run initial health check
			const checkFn =
				this.healthChecker ?? this.defaultHealthChecker.bind(this);
			let healthy: boolean;
			if (!this.spawner && !this.healthChecker && record.processIdentity) {
				const health = await waitForOpenCodeHealth(
					{
						port: instance.port,
						env: effectiveEnv,
						processIdentity: record.processIdentity,
					},
					proc,
				);
				instance.pid = health.pid;
				record.pid = health.pid;
				if (health.version !== undefined) {
					instance.version = health.version;
					record.version = health.version;
				}
				healthy = true;
			} else {
				healthy = await checkFn(instance.port, instance);
			}

			// Guard: check if process exited during the health check await
			const afterHealthCheck = this.instances.get(id);
			if (
				!afterHealthCheck ||
				afterHealthCheck.status === "stopped" ||
				afterHealthCheck.status === "unhealthy"
			) {
				return; // Process exited during startup — don't update status or start health polling
			}

			if (healthy) {
				instance.status = "healthy";
				instance.lastHealthCheck = Date.now();
				this.notify("status_changed", instance);
			}

			// Start periodic health polling
			this.startHealthPolling(id);
		} catch (err) {
			// Clean up process if it was stored before the error
			const proc = this.processes.get(id);
			if (proc) {
				proc.removeAllListeners("exit");
				if (this.spawner) proc.kill("SIGTERM");
				this.processes.delete(id);
			}
			try {
				if (!this.spawner) await this.stopManagedProcess(record);
			} finally {
				const cleanupPending =
					record.processIdentity !== undefined &&
					this.ownedProcesses.has(record.processIdentity);
				instance.status = cleanupPending ? "unhealthy" : "stopped";
				if (!cleanupPending) {
					delete instance.pid;
					delete record.pid;
					delete record.processIdentity;
				}
				this.notify("status_changed", instance);
			}
			throw err;
		}
	}

	/**
	 * Stop an instance: kill its process, clear health polling, cancel pending
	 * restart timers, set status to "stopped". Throws if instance not found.
	 */
	stopInstance(id: string): void {
		const instance = this.instances.get(id);
		const record = this.instanceRecords.get(id);
		if (!instance) {
			throw instanceNotFound(id);
		}

		if (
			instance.status === "stopped" &&
			(!record?.processIdentity || this.pendingStops.has(id))
		) {
			return;
		}

		// Cancel any pending restart timer
		this.cancelPendingRestart(id);

		// Stop health polling
		this.stopHealthPolling(id);

		// Kill process if one exists
		const proc = this.processes.get(id);
		if (proc) {
			proc.removeAllListeners("exit");
			if (this.spawner) proc.kill("SIGTERM");
			this.processes.delete(id);
		}
		if (!this.spawner && instance.managed && record?.processIdentity) {
			const identity = record.processIdentity;
			const stopping = this.stopManagedProcess({ ...record }).then(() => {
				if (record.processIdentity === identity) {
					delete record.pid;
					delete record.version;
					delete record.processIdentity;
				}
			});
			this.pendingStops.set(id, stopping);
			this.trackPromise(
				stopping
					.catch((cause: unknown) =>
						this.notify("instance_error", {
							id,
							error: formatErrorDetail(cause),
						}),
					)
					.finally(() => {
						if (this.pendingStops.get(id) === stopping)
							this.pendingStops.delete(id);
					}),
			);
		} else if (record) {
			delete record.pid;
			delete record.version;
			delete record.processIdentity;
		}

		// Update status
		instance.status = "stopped";
		delete instance.pid;
		delete instance.version;
		instance.needsRestart = false;
		this.notify("status_changed", instance);
	}

	/**
	 * Stops all instances — including "stopped" ones that may still have
	 * health polling (e.g. unmanaged instances). Kills processes, clears
	 * health polling and pending restart timers for every instance.
	 */
	stopAll(): void {
		for (const instance of this.instances.values()) {
			this.cancelPendingRestart(instance.id);
			this.stopHealthPolling(instance.id);
			if (
				instance.status !== "stopped" ||
				this.instanceRecords.get(instance.id)?.processIdentity
			) {
				this.stopInstance(instance.id);
			}
		}
	}

	/** Cancel all work and wait for in-flight operations to settle. */
	async drain(): Promise<void> {
		this.stopAll();
		await Promise.allSettled([...this.pendingPromises]);
		this.pendingPromises.clear();
		await Promise.all(
			[...this.ownedProcesses.values()].map((record) =>
				this.stopManagedProcess(record),
			),
		);
	}

	// Health polling (private)

	/** Start periodic health polling for an instance (every 5s). */
	private startHealthPolling(id: string): void {
		// Clear any existing interval first
		this.stopHealthPolling(id);

		const interval = setInterval(async () => {
			const instance = this.instances.get(id);
			if (!instance) {
				this.stopHealthPolling(id);
				return;
			}

			const checkFn =
				this.healthChecker ?? this.defaultHealthChecker.bind(this);
			const healthy = await checkFn(instance.port, instance);

			// Re-check after await: instance may have been removed or stopped
			const current = this.instances.get(id);
			if (!current) {
				this.stopHealthPolling(id);
				return;
			}

			// For managed instances, stop polling if manually stopped or crash
			// recovery took over (unhealthy → restart cycle manages its own polling).
			// For unmanaged instances, always keep polling — they have no process
			// lifecycle, so polling is the only way to track health.
			if (current.managed) {
				if (current.status === "stopped" || current.status === "unhealthy") {
					this.stopHealthPolling(id);
					return;
				}
			}

			const previousStatus = current.status;
			const newStatus = healthy ? "healthy" : "unhealthy";

			current.lastHealthCheck = Date.now();

			if (previousStatus !== newStatus) {
				current.status = newStatus;
				this.notify("status_changed", current);
			}
		}, this.healthPollIntervalMs);

		this.healthIntervals.set(id, interval);
	}

	/** Stop periodic health polling for an instance. */
	private stopHealthPolling(id: string): void {
		const interval = this.healthIntervals.get(id);
		if (interval) {
			clearInterval(interval);
			this.healthIntervals.delete(id);
		}
	}

	/** Cancel a pending restart timer for an instance. */
	private cancelPendingRestart(id: string): void {
		const timer = this.pendingRestarts.get(id);
		if (timer) {
			clearTimeout(timer);
			this.pendingRestarts.delete(id);
		}
	}

	/**
	 * Returns the external URL for an instance, if one was configured.
	 * Used by buildConfig to persist unmanaged instance URLs.
	 */
	getExternalUrl(id: string): string | undefined {
		return this.externalUrls.get(id);
	}

	// Crash recovery (private)

	/**
	 * Called when a spawned process exits. Handles:
	 * - Clean exit (code 0): mark stopped, no restart.
	 * - Intentional stop (status already "stopped"): no restart.
	 * - Crash (non-zero exit): mark unhealthy immediately, attempt restart
	 *   with exponential backoff, unless max restarts in window exceeded.
	 */
	private handleProcessExit(
		id: string,
		code: number | null,
		_signal: string | null,
	): void {
		const instance = this.instances.get(id);
		if (!instance) return;

		// The supervisor cleans up its private group before emitting exit.
		const record = this.instanceRecords.get(id);
		if (record) {
			if (record.processIdentity)
				this.ownedProcesses.delete(record.processIdentity);
			delete record.pid;
			delete record.processIdentity;
		}
		delete instance.pid;
		this.processes.delete(id);
		this.stopHealthPolling(id);

		// Intentional stop — don't restart
		if (instance.status === "stopped") {
			return;
		}

		// Clean exit — mark stopped, don't restart
		if (code === 0) {
			instance.status = "stopped";
			instance.exitCode = 0;
			this.notify("status_changed", instance);
			return;
		}

		// Crash — mark unhealthy immediately so consumers see accurate status
		if (code != null) {
			instance.exitCode = code;
		} else {
			delete instance.exitCode;
		}
		instance.restartCount++;
		instance.status = "unhealthy";
		this.notify("status_changed", instance);

		// Rate-limit restarts
		const now = Date.now();
		const timestamps = this.restartTimestamps.get(id) ?? [];
		timestamps.push(now);
		const recent = timestamps.filter((t) => now - t < this.restartWindowMs);
		this.restartTimestamps.set(id, recent);

		if (recent.length >= this.maxRestartsPerWindow) {
			instance.status = "stopped";
			this.notify("status_changed", instance);
			this.notify("instance_error", {
				id,
				error: `Crashed ${recent.length} times in ${this.restartWindowMs / 1000}s — giving up`,
			});
			return;
		}

		// Restart with exponential backoff: 1s, 2s, 4s, ... capped at 30s
		const backoffMs = Math.min(1000 * 2 ** (recent.length - 1), 30_000);
		const timer = setTimeout(() => {
			this.pendingRestarts.delete(id);
			const restartPromise = (async () => {
				try {
					// Reset status so startInstance doesn't return early
					instance.status = "stopped";
					await this.startInstance(id);
				} catch (err) {
					instance.status = "stopped";
					this.notify("status_changed", instance);
					this.notify("instance_error", {
						id,
						error: `Restart failed: ${formatErrorDetail(err)}`,
					});
				}
			})();
			this.trackPromise(restartPromise);
		}, backoffMs);

		this.pendingRestarts.set(id, timer);
	}

	// Default spawner / health checker (private)

	/** Default spawner: runs `opencode serve --port {port}` with merged env. */
	private defaultSpawner(
		port: number,
		env?: Record<string, string>,
		id = "opencode",
	): ReturnType<typeof spawnManagedOpenCode> {
		return spawnManagedOpenCode(id, port, env ?? {}, this.configDir);
	}

	/** Default health checker: GET http://localhost:{port}/global/health. */
	private async defaultHealthChecker(
		port: number,
		instance: OpenCodeInstance,
	): Promise<boolean> {
		const record = this.instanceRecords.get(instance.id);
		const health = await probeOpenCodeHealth(port, {
			...(process.env["OPENCODE_SERVER_PASSWORD"]
				? { OPENCODE_SERVER_PASSWORD: process.env["OPENCODE_SERVER_PASSWORD"] }
				: {}),
			...(process.env["OPENCODE_SERVER_USERNAME"]
				? { OPENCODE_SERVER_USERNAME: process.env["OPENCODE_SERVER_USERNAME"] }
				: {}),
			...(record?.env ?? instance.env),
		});
		if (health && !this.spawner && instance.managed) {
			const owned = await inspectManagedOpenCodeProcess(
				record?.processIdentity,
			);
			if (!record || !owned?.running || !owned.listening) return false;
			record.pid = owned.pid;
			instance.pid = owned.pid;
		}
		if (health?.version !== undefined) {
			instance.version = health.version;
			if (record) record.version = health.version;
		}
		return health !== undefined;
	}

	private async stopManagedProcess(
		record: ManagedOpenCodeRecord,
	): Promise<void> {
		const processIdentity = record.processIdentity;
		if (!processIdentity) return;
		const owned = await inspectManagedOpenCodeProcess(processIdentity);
		if (!owned) {
			if (
				isProcessAlive(processIdentity.supervisorPid) ||
				(record.pid !== undefined && isProcessAlive(record.pid))
			) {
				this.ownedProcesses.set(processIdentity, { ...record });
				throw new ManagedOpenCodeProcessError({
					message: "Could not verify managed OpenCode cleanup",
				});
			}
			this.ownedProcesses.delete(processIdentity);
			return;
		}
		this.ownedProcesses.set(processIdentity, { ...record, pid: owned.pid });
		if (!(await stopManagedOpenCode({ pid: owned.pid, processIdentity })))
			throw new ManagedOpenCodeProcessError({
				message: "Could not stop managed OpenCode supervisor",
			});
		this.ownedProcesses.delete(processIdentity);
	}

	/** Track a fire-and-forget promise for drain. */
	private trackPromise<T>(promise: Promise<T>): void {
		this.pendingPromises.add(promise);
		promise.finally(() => this.pendingPromises.delete(promise)).catch(() => {});
	}
}
