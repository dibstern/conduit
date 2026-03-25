// ─── Keep-Awake Management (Ticket 3.5) ─────────────────────────────────────
// Prevents the host machine from sleeping during long-running agent tasks.
// Uses `caffeinate` on macOS, `systemd-inhibit` on Linux, or a user-configured command.

import type { ChildProcess } from "node:child_process";
import { spawn as defaultSpawn, execFileSync } from "node:child_process";
import type { ServiceRegistry } from "./service-registry.js";
import { TrackedService } from "./tracked-service.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KeepAwakeOptions {
	enabled?: boolean;
	command?: string;
	args?: string[];
	/** Injectable platform for testing */
	_platform?: string;
	/** Injectable spawn for testing */
	_spawn?: typeof import("node:child_process").spawn;
	/** Injectable which-sync for testing (returns path or null) */
	_whichSync?: (cmd: string) => string | null;
}

export type KeepAwakeEvents = {
	activated: [];
	deactivated: [];
	error: [{ error: Error }];
	unsupported: [{ platform: string }];
};

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_COMMAND = "caffeinate";
const DEFAULT_ARGS = ["-di"];

const LINUX_COMMAND = "systemd-inhibit";
const LINUX_ARGS = [
	"--what=idle",
	"--who=conduit",
	"--why=Conduit relay running",
	"sleep",
	"infinity",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultWhichSync(cmd: string): string | null {
	try {
		const result = execFileSync("which", [cmd], {
			encoding: "utf-8",
			timeout: 2000,
		});
		return result.trim() || null;
	} catch {
		return null;
	}
}

// ─── KeepAwake ───────────────────────────────────────────────────────────────

/** @internal Exported for testing only */
export { defaultWhichSync as _defaultWhichSync };

export class KeepAwake extends TrackedService<KeepAwakeEvents> {
	private readonly whichSync: (cmd: string) => string | null;
	private readonly configCommand: string | undefined;
	private readonly configArgs: string[] | undefined;
	private readonly platform: string;
	private readonly spawnFn: typeof import("node:child_process").spawn;

	// undefined = not yet resolved; null = resolved to "no tool available"
	private resolvedCommand:
		| { command: string; args: string[] }
		| null
		| undefined;

	private enabled: boolean;
	private child: ChildProcess | null = null;
	private active = false;

	constructor(registry: ServiceRegistry, options?: KeepAwakeOptions) {
		super(registry);
		this.enabled = options?.enabled ?? true;
		// Treat empty string as "no command" — fall through to auto-detect
		this.configCommand = options?.command?.trim() || undefined;
		this.configArgs = options?.args;
		this.platform = options?._platform ?? process.platform;
		this.spawnFn = options?._spawn ?? defaultSpawn;
		this.whichSync = options?._whichSync ?? defaultWhichSync;
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private resolveCommand(): { command: string; args: string[] } | null {
		if (this.resolvedCommand !== undefined) return this.resolvedCommand;

		// 1. User-configured command (non-empty) takes priority
		if (this.configCommand != null) {
			this.resolvedCommand = {
				command: this.configCommand,
				args: this.configArgs ?? [],
			};
			return this.resolvedCommand;
		}

		// 2. Auto-detect: macOS → caffeinate
		if (this.platform === "darwin") {
			this.resolvedCommand = {
				command: DEFAULT_COMMAND,
				args: [...DEFAULT_ARGS],
			};
			return this.resolvedCommand;
		}

		// 3. Auto-detect: Linux → systemd-inhibit (if found)
		if (this.platform === "linux") {
			const path = this.whichSync(LINUX_COMMAND);
			if (path) {
				this.resolvedCommand = {
					command: LINUX_COMMAND,
					args: [...LINUX_ARGS],
				};
				return this.resolvedCommand;
			}
		}

		// 4. No tool found
		this.resolvedCommand = null;
		return null;
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	/** Start keeping awake (spawns platform-appropriate command) */
	activate(): void {
		// No-op if disabled
		if (!this.enabled) {
			return;
		}

		// AC5: Idempotent — don't spawn again if already active
		if (this.active) {
			return;
		}

		const resolved = this.resolveCommand();
		if (!resolved) {
			this.emit("unsupported", { platform: this.platform });
			return;
		}

		// Spawn the keep-awake command
		try {
			const child = this.spawnFn(resolved.command, resolved.args, {
				stdio: "ignore",
				detached: true,
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
						error: new Error(`${resolved.command} exited unexpectedly`),
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

	/** Stop keeping awake (kills process group) */
	deactivate(): void {
		// AC5: Idempotent — safe to call multiple times
		if (!this.active || !this.child) {
			return;
		}

		const child = this.child;
		this.active = false;
		this.child = null;

		try {
			if (child.pid) {
				process.kill(-child.pid, "SIGTERM");
			}
			// When pid is undefined (spawn failed with ENOENT), the child process
			// never started — calling child.kill() on it would create a dangling
			// event-loop reference. Just let it be GC'd.
		} catch {
			// Process may already be dead
		}

		this.emit("deactivated");
	}

	/** Is currently keeping awake? */
	isActive(): boolean {
		return this.active;
	}

	/** Enable/disable — activates when enabling, deactivates when disabling */
	setEnabled(value: boolean): void {
		this.enabled = value;

		if (value) {
			// Activate when enabling (idempotent — no-op if already active)
			this.activate();
		} else if (this.active) {
			// AC3: If disabling while active, deactivate
			this.deactivate();
		}
	}

	/** Is enabled? */
	isEnabled(): boolean {
		return this.enabled;
	}

	/** Is the platform supported? */
	isSupported(): boolean {
		return this.resolveCommand() !== null;
	}

	/** Kill the child process and drain tracked work. */
	override async drain(): Promise<void> {
		this.deactivate();
		await super.drain();
	}
}
