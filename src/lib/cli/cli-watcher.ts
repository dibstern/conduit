// ─── Daemon Health Watcher (Ticket 8.13) ─────────────────────────────────────
// Polls a Unix domain socket to detect when the daemon process dies.
// On crash: reads crash info, manages restart attempts with backoff.
// On intentional shutdown (no crash info): calls onShutdown.
// Ported from claude-relay/bin/cli.js lines 248-332.

import net from "node:net";

import type { CrashInfo } from "../daemon/config-persistence.js";
import { readCrashInfo as defaultReadCrashInfo } from "../daemon/config-persistence.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WatcherCallbacks {
	/** Called when daemon died (crash or shutdown). */
	onDied: (info: {
		isCrash: boolean;
		crashInfo: CrashInfo | null;
		attempt: number;
		maxAttempts: number;
	}) => void;
	/** Called when restart should happen */
	onRestart: () => Promise<void>;
	/** Called when giving up after max restarts */
	onGiveUp: (crashInfo: CrashInfo | null) => void;
	/** Called when intentional shutdown detected */
	onShutdown: () => void;
}

export interface WatcherOptions {
	/** Path to Unix domain socket */
	socketPath: string;
	/** Poll interval in ms (default: 3000) */
	pollInterval?: number;
	/** Connection timeout in ms (default: 1500) */
	connectTimeout?: number;
	/** Max restart attempts (default: 5) */
	maxAttempts?: number;
	/** Backoff reset window in ms (default: 60000) */
	backoffWindow?: number;
	/** Injectable crash info reader */
	readCrashInfo?: () => CrashInfo | null;
	/** Injectable socket connect for testing */
	connect?: (socketPath: string) => {
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		destroy: () => void;
	};
}

// ─── Default connect factory ────────────────────────────────────────────────

function defaultConnect(socketPath: string): {
	on: (event: string, cb: (...args: unknown[]) => void) => void;
	destroy: () => void;
} {
	return net.connect(socketPath);
}

// ─── DaemonWatcher ──────────────────────────────────────────────────────────

export class DaemonWatcher {
	private readonly callbacks: WatcherCallbacks;
	private readonly socketPath: string;
	private readonly pollInterval: number;
	private readonly connectTimeout: number;
	private readonly maxAttempts: number;
	private readonly backoffWindow: number;
	private readonly readCrashInfoFn: () => CrashInfo | null;
	private readonly connectFn: (socketPath: string) => {
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		destroy: () => void;
	};

	private intervalId: ReturnType<typeof setInterval> | null = null;
	private attemptCount = 0;
	private backoffStart = 0;
	/** Set when stop() is called externally. Prevents onDaemonDied from firing. */
	private userStopped = false;

	constructor(callbacks: WatcherCallbacks, options: WatcherOptions) {
		this.callbacks = callbacks;
		this.socketPath = options.socketPath;
		this.pollInterval = options.pollInterval ?? 3000;
		this.connectTimeout = options.connectTimeout ?? 1500;
		this.maxAttempts = options.maxAttempts ?? 5;
		this.backoffWindow = options.backoffWindow ?? 60000;
		this.readCrashInfoFn = options.readCrashInfo ?? defaultReadCrashInfo;
		this.connectFn = options.connect ?? defaultConnect;
	}

	/** Start polling the daemon socket */
	start(): void {
		if (this.intervalId) return;
		this.userStopped = false;
		this.intervalId = setInterval(() => this.poll(), this.pollInterval);
	}

	/** Stop polling */
	stop(): void {
		this.userStopped = true;
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** Reset restart attempt counter */
	resetAttempts(): void {
		this.attemptCount = 0;
		this.backoffStart = 0;
	}

	/** Get current attempt count (for testing) */
	getAttemptCount(): number {
		return this.attemptCount;
	}

	/** Check if watcher is running */
	isRunning(): boolean {
		return this.intervalId !== null;
	}

	// ─── Private ────────────────────────────────────────────────────────────

	private poll(): void {
		const client = this.connectFn(this.socketPath);
		const timer = setTimeout(() => {
			client.destroy();
			this.onDaemonDied();
		}, this.connectTimeout);

		client.on("connect", () => {
			clearTimeout(timer);
			client.destroy();
			// Daemon is alive — no action needed
		});

		client.on("error", () => {
			clearTimeout(timer);
			client.destroy();
			this.onDaemonDied();
		});
	}

	private async onDaemonDied(): Promise<void> {
		// If stop() was called externally, bail out
		if (this.userStopped) return;

		// Stop polling (clear interval without setting userStopped)
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		const crashInfo = this.readCrashInfoFn();

		if (!crashInfo) {
			// Intentional shutdown — no crash info file
			this.callbacks.onShutdown();
			return;
		}

		// Reset backoff counter if enough time has passed since last restart burst
		const now = Date.now();
		if (this.backoffStart && now - this.backoffStart > this.backoffWindow) {
			this.attemptCount = 0;
		}

		this.attemptCount++;

		if (this.attemptCount === 1) {
			this.backoffStart = now;
		}

		if (this.attemptCount > this.maxAttempts) {
			this.callbacks.onGiveUp(crashInfo);
			return;
		}

		// Notify about the crash
		this.callbacks.onDied({
			isCrash: true,
			crashInfo,
			attempt: this.attemptCount,
			maxAttempts: this.maxAttempts,
		});

		// Attempt restart
		await this.callbacks.onRestart();

		// After restart, re-start watching (unless user stopped during restart)
		if (!this.userStopped) {
			this.start();
		}
	}
}
