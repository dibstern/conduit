// ─── Instance Manager ────────────────────────────────────────────────────────
// Manages OpenCode instance CRUD, URL resolution, lifecycle events,
// process spawning, and health checks.

import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import type { ServiceRegistry } from "../daemon/service-registry.js";
import { TrackedService } from "../daemon/tracked-service.js";
import { formatErrorDetail } from "../errors.js";
import type { InstanceConfig, OpenCodeInstance } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type InstanceSpawner = (
	port: number,
	env?: Record<string, string>,
) => Promise<{ pid: number; process: ChildProcess }>;

export type InstanceHealthChecker = (
	port: number,
	instance: OpenCodeInstance,
) => Promise<boolean>;

export type InstanceManagerEvents = {
	instance_added: [instance: OpenCodeInstance];
	instance_removed: [id: string];
	status_changed: [instance: OpenCodeInstance];
	instance_error: [payload: { id: string; error: string }];
};

// ─── Configuration ──────────────────────────────────────────────────────────

export interface InstanceManagerOptions {
	/** Maximum number of instances allowed. Default: 5. */
	maxInstances?: number;
	/** Max crash restarts allowed within the restart window. Default: 3. */
	maxRestartsPerWindow?: number;
	/** Time window (ms) for counting crash restarts. Default: 60 000. */
	restartWindowMs?: number;
	/** Health polling interval (ms). Default: 5 000. */
	healthPollIntervalMs?: number;
}

// ─── InstanceManager ────────────────────────────────────────────────────────

export class InstanceManager extends TrackedService<InstanceManagerEvents> {
	private readonly maxInstances: number;
	private readonly maxRestartsPerWindow: number;
	private readonly restartWindowMs: number;
	private readonly healthPollIntervalMs: number;

	// ─── Private state ──────────────────────────────────────────────────

	private readonly instances = new Map<string, OpenCodeInstance>();
	/** External URLs for unmanaged instances (keeps OpenCodeInstance clean). */
	private readonly externalUrls = new Map<string, string>();
	/** Tracks spawned child processes by instance ID. */
	private readonly processes = new Map<string, ChildProcess>();
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

	constructor(registry: ServiceRegistry, options: InstanceManagerOptions = {}) {
		super(registry);
		this.maxInstances = options.maxInstances ?? 5;
		this.maxRestartsPerWindow = options.maxRestartsPerWindow ?? 3;
		this.restartWindowMs = options.restartWindowMs ?? 60_000;
		this.healthPollIntervalMs = options.healthPollIntervalMs ?? 5_000;
	}

	// ─── Dependency injection ────────────────────────────────────────────

	/** Inject a custom spawner (for testing). */
	setSpawner(spawner: InstanceSpawner): void {
		this.spawner = spawner;
	}

	/** Inject a custom health checker (for testing). */
	setHealthChecker(checker: InstanceHealthChecker): void {
		this.healthChecker = checker;
	}

	// ─── CRUD ─────────────────────────────────────────────────────────────

	/**
	 * Register a new instance with status "stopped".
	 * Rejects duplicate IDs and enforces maxInstances.
	 */
	addInstance(id: string, config: InstanceConfig): OpenCodeInstance {
		if (this.instances.has(id)) {
			throw new Error(`Instance "${id}" already exists`);
		}
		if (this.instances.size >= this.maxInstances) {
			throw new Error(
				`Max instances reached (${this.maxInstances}). Remove an instance first.`,
			);
		}

		// Validate URL if provided (defense-in-depth: IPC layer already validates,
		// but direct callers like tests or future APIs should also get a clear error)
		if (config.url) {
			try {
				new URL(config.url);
			} catch {
				throw new Error(`Invalid URL for instance "${id}": ${config.url}`);
			}
		}

		const instance: OpenCodeInstance = {
			id,
			name: config.name,
			port: config.port,
			managed: config.managed,
			status: "stopped",
			...(config.env != null && { env: config.env }),
			restartCount: 0,
			createdAt: Date.now(),
		};

		this.instances.set(id, instance);

		if (config.url) {
			this.externalUrls.set(id, config.url);
		}

		// Unmanaged (external) instances have no process lifecycle — start health
		// polling immediately so their status reflects whether the server is reachable.
		if (!config.managed) {
			this.startHealthPolling(id);
		}

		this.emit("instance_added", instance);
		return instance;
	}

	/**
	 * Remove an instance by ID. Stops it first if running, cancels pending
	 * restart timers, and cleans up all associated state. Throws if not found.
	 */
	removeInstance(id: string): void {
		if (!this.instances.has(id)) {
			throw new Error(`Instance "${id}" not found`);
		}
		// Stop process and health polling if running
		this.stopInstance(id);
		// Cancel any pending restart timer
		this.cancelPendingRestart(id);
		// Clean up restart rate-limit timestamps
		this.restartTimestamps.delete(id);

		this.instances.delete(id);
		this.externalUrls.delete(id);
		this.emit("instance_removed", id);
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
		if (!instance) throw new Error(`Instance "${id}" not found`);

		const isRunning =
			instance.status === "healthy" || instance.status === "starting";
		let changed = false;

		if (updates.name !== undefined && updates.name !== instance.name) {
			instance.name = updates.name;
			changed = true;
		}
		if (updates.port !== undefined && updates.port !== instance.port) {
			instance.port = updates.port;
			changed = true;
			if (isRunning) instance.needsRestart = true;
		}
		if (updates.env !== undefined) {
			const oldEnv = JSON.stringify(instance.env ?? {});
			const newEnv = JSON.stringify(updates.env);
			if (oldEnv !== newEnv) {
				instance.env = { ...updates.env };
				changed = true;
				if (isRunning) instance.needsRestart = true;
			}
		}

		if (changed) {
			this.emit("status_changed", instance);
		}

		return instance;
	}

	// ─── URL Resolution ─────────────────────────────────────────────────────

	/**
	 * Returns the URL for an instance.
	 * - External instances with a custom URL return that URL.
	 * - All others return `http://localhost:{port}`.
	 * Throws if instance not found.
	 */
	getInstanceUrl(id: string): string {
		const instance = this.instances.get(id);
		if (!instance) {
			throw new Error(`Instance "${id}" not found`);
		}

		const externalUrl = this.externalUrls.get(id);
		if (externalUrl) {
			return externalUrl;
		}

		return `http://localhost:${instance.port}`;
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	/**
	 * Start a managed instance: spawn its process and begin health polling.
	 * Throws if instance not found or not managed. Returns early if already
	 * healthy or starting. Kills existing process if unhealthy.
	 */
	async startInstance(id: string): Promise<void> {
		const instance = this.instances.get(id);
		if (!instance) {
			throw new Error(`Instance "${id}" not found`);
		}

		if (!instance.managed) {
			throw new Error("Cannot start external instance");
		}

		// Idempotent: don't re-spawn if already healthy or starting
		if (instance.status === "healthy" || instance.status === "starting") {
			return;
		}

		// If unhealthy, kill the old process before spawning a new one
		if (instance.status === "unhealthy") {
			const oldProc = this.processes.get(id);
			if (oldProc) {
				oldProc.removeAllListeners("exit");
				oldProc.kill("SIGTERM");
				this.processes.delete(id);
			}
			this.stopHealthPolling(id);
		}

		// Cancel any pending restart timer (user is manually starting)
		this.cancelPendingRestart(id);

		// Transition to "starting"
		instance.status = "starting";
		instance.needsRestart = false;
		this.emit("status_changed", instance);

		try {
			// Spawn the process
			const spawnFn = this.spawner ?? this.defaultSpawner.bind(this);

			// Give each instance its own XDG_DATA_HOME so auth.json is isolated
			const effectiveEnv: Record<string, string> = { ...instance.env };
			if (!effectiveEnv["XDG_DATA_HOME"]) {
				const base =
					process.env["XDG_DATA_HOME"] ?? `${homedir()}/.local/share`;
				effectiveEnv["XDG_DATA_HOME"] = `${base}/conduit/${id}`;
			}

			// Ensure managed instances inherit the global OPENCODE_SERVER_PASSWORD
			if (
				!effectiveEnv["OPENCODE_SERVER_PASSWORD"] &&
				process.env["OPENCODE_SERVER_PASSWORD"]
			) {
				effectiveEnv["OPENCODE_SERVER_PASSWORD"] =
					process.env["OPENCODE_SERVER_PASSWORD"];
			}

			const { pid, process: proc } = await spawnFn(instance.port, effectiveEnv);

			instance.pid = pid;
			this.processes.set(id, proc);

			// Wire up exit handler for crash recovery
			proc.on("exit", (code: number | null, signal: string | null) => {
				this.handleProcessExit(id, code, signal);
			});

			// Run initial health check
			const checkFn =
				this.healthChecker ?? this.defaultHealthChecker.bind(this);
			const healthy = await checkFn(instance.port, instance);

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
				this.emit("status_changed", instance);
			}

			// Start periodic health polling
			this.startHealthPolling(id);
		} catch (err) {
			// Clean up process if it was stored before the error
			const proc = this.processes.get(id);
			if (proc) {
				proc.removeAllListeners("exit");
				proc.kill("SIGTERM");
				this.processes.delete(id);
			}
			instance.status = "stopped";
			delete instance.pid;
			this.emit("status_changed", instance);
			throw err;
		}
	}

	/**
	 * Stop an instance: kill its process, clear health polling, cancel pending
	 * restart timers, set status to "stopped". Throws if instance not found.
	 */
	stopInstance(id: string): void {
		const instance = this.instances.get(id);
		if (!instance) {
			throw new Error(`Instance "${id}" not found`);
		}

		if (instance.status === "stopped") {
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
			proc.kill("SIGTERM");
			this.processes.delete(id);
		}

		// Update status
		instance.status = "stopped";
		delete instance.pid;
		instance.needsRestart = false;
		this.emit("status_changed", instance);
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
			if (instance.status !== "stopped") {
				this.stopInstance(instance.id);
			}
		}
	}

	/** Cancel all work and wait for in-flight operations to settle. */
	async drain(): Promise<void> {
		this.stopAll();
		await super.drain();
	}

	// ─── Health polling (private) ───────────────────────────────────────────

	/** Start periodic health polling for an instance (every 5s). */
	private startHealthPolling(id: string): void {
		// Clear any existing interval first
		this.stopHealthPolling(id);

		const interval = this.repeating(async () => {
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
				this.emit("status_changed", current);
			}
		}, this.healthPollIntervalMs);

		this.healthIntervals.set(id, interval);
	}

	/** Stop periodic health polling for an instance. */
	private stopHealthPolling(id: string): void {
		const interval = this.healthIntervals.get(id);
		if (interval) {
			this.clearTrackedTimer(interval);
			this.healthIntervals.delete(id);
		}
	}

	/** Cancel a pending restart timer for an instance. */
	private cancelPendingRestart(id: string): void {
		const timer = this.pendingRestarts.get(id);
		if (timer) {
			this.clearTrackedTimer(timer);
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

	// ─── Crash recovery (private) ──────────────────────────────────────────

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
			this.emit("status_changed", instance);
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
		this.emit("status_changed", instance);

		// Rate-limit restarts
		const now = Date.now();
		const timestamps = this.restartTimestamps.get(id) ?? [];
		timestamps.push(now);
		const recent = timestamps.filter((t) => now - t < this.restartWindowMs);
		this.restartTimestamps.set(id, recent);

		if (recent.length >= this.maxRestartsPerWindow) {
			instance.status = "stopped";
			this.emit("status_changed", instance);
			this.emit("instance_error", {
				id,
				error: `Crashed ${recent.length} times in ${this.restartWindowMs / 1000}s — giving up`,
			});
			return;
		}

		// Restart with exponential backoff: 1s, 2s, 4s, ... capped at 30s
		const backoffMs = Math.min(1000 * 2 ** (recent.length - 1), 30_000);
		const timer = this.delayed(async () => {
			this.pendingRestarts.delete(id);
			try {
				// Reset status so startInstance doesn't return early
				instance.status = "stopped";
				await this.startInstance(id);
			} catch (err) {
				instance.status = "stopped";
				this.emit("status_changed", instance);
				this.emit("instance_error", {
					id,
					error: `Restart failed: ${formatErrorDetail(err)}`,
				});
			}
		}, backoffMs);

		this.pendingRestarts.set(id, timer);
	}

	// ─── Default spawner / health checker (private) ─────────────────────────

	/** Default spawner: runs `opencode serve --port {port}` with merged env. */
	private defaultSpawner(
		port: number,
		env?: Record<string, string>,
	): Promise<{ pid: number; process: ChildProcess }> {
		return new Promise((resolve, reject) => {
			const proc = spawn("opencode", ["serve", "--port", String(port)], {
				env: { ...process.env, ...env },
				stdio: "pipe",
			});

			proc.once("spawn", () => {
				// biome-ignore lint/style/noNonNullAssertion: safe — initialized before this code path
				resolve({ pid: proc.pid!, process: proc });
			});

			proc.once("error", (err) => {
				reject(err);
			});
		});
	}

	/** Default health checker: GET http://localhost:{port}/health. */
	private async defaultHealthChecker(
		port: number,
		_instance: OpenCodeInstance,
	): Promise<boolean> {
		try {
			const res = await this.fetch(`http://localhost:${port}/health`);
			return res.ok;
		} catch {
			return false;
		}
	}
}
