// ─── Keep-Awake Management (Ticket 3.5) ─────────────────────────────────────
// Prevents the host machine from sleeping during long-running agent tasks.
// Uses `caffeinate` on macOS, no-op on other platforms.

import type { ChildProcess } from "node:child_process";
import { spawn as defaultSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KeepAwakeOptions {
	enabled?: boolean;
	command?: string;
	args?: string[];
	/** Injectable platform for testing */
	_platform?: string;
	/** Injectable spawn for testing */
	_spawn?: typeof import("node:child_process").spawn;
}

export interface KeepAwakeEvents {
	activated: [];
	deactivated: [];
	error: [{ error: Error }];
	unsupported: [{ platform: string }];
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_COMMAND = "caffeinate";
const DEFAULT_ARGS = ["-di"];

// ─── KeepAwake ───────────────────────────────────────────────────────────────

export class KeepAwake extends EventEmitter<KeepAwakeEvents> {
	private readonly command: string;
	private readonly args: string[];
	private readonly platform: string;
	private readonly spawnFn: typeof import("node:child_process").spawn;

	private enabled: boolean;
	private child: ChildProcess | null = null;
	private active = false;

	constructor(options?: KeepAwakeOptions) {
		super();
		this.enabled = options?.enabled ?? true;
		this.command = options?.command ?? DEFAULT_COMMAND;
		this.args = options?.args ?? [...DEFAULT_ARGS];
		this.platform = options?._platform ?? process.platform;
		this.spawnFn = options?._spawn ?? defaultSpawn;
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	/** Start keeping awake (spawns caffeinate on macOS) */
	activate(): void {
		// No-op if disabled
		if (!this.enabled) {
			return;
		}

		// AC5: Idempotent — don't spawn again if already active
		if (this.active) {
			return;
		}

		// AC4: No-op on non-macOS
		if (this.platform !== "darwin") {
			this.emit("unsupported", { platform: this.platform });
			return;
		}

		// AC1: Spawn caffeinate
		try {
			const child = this.spawnFn(this.command, this.args, {
				stdio: "ignore",
				detached: false,
			});

			this.child = child;
			this.active = true;

			// AC6: Handle unexpected exit
			child.on("exit", (_code, _signal) => {
				// Only treat as error if we didn't initiate the deactivation
				if (this.active) {
					this.active = false;
					this.child = null;
					this.emit("error", {
						error: new Error(`${this.command} exited unexpectedly`),
					});
				}
			});

			child.on("error", (err: Error) => {
				this.active = false;
				this.child = null;
				this.emit("error", { error: err });
			});

			this.emit("activated");
		} catch (err) {
			this.active = false;
			this.child = null;
			this.emit("error", {
				error: err instanceof Error ? err : new Error(String(err)),
			});
		}
	}

	/** Stop keeping awake (kills caffeinate) */
	deactivate(): void {
		// AC5: Idempotent — safe to call multiple times
		if (!this.active || !this.child) {
			return;
		}

		const child = this.child;
		this.active = false;
		this.child = null;

		try {
			child.kill();
		} catch {
			// Process may already be dead
		}

		this.emit("deactivated");
	}

	/** Is currently keeping awake? */
	isActive(): boolean {
		return this.active;
	}

	/** Enable/disable for future activate() calls */
	setEnabled(value: boolean): void {
		this.enabled = value;

		// AC3: If disabling while active, deactivate
		if (!value && this.active) {
			this.deactivate();
		}
	}

	/** Is enabled? */
	isEnabled(): boolean {
		return this.enabled;
	}

	/** Is the platform supported? */
	isSupported(): boolean {
		return this.platform === "darwin";
	}
}
