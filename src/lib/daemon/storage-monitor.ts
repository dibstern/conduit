// ─── Storage Monitor (Ticket 6.2 AC8) ───────────────────────────────────────
// Periodically checks available disk space and notifies via callbacks on
// transitions between low/ok states. Used by the Daemon to warn about disk
// space issues.

import { statfs as nodeStatfs } from "node:fs/promises";
import type { Drainable } from "./service-registry.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StorageMonitorOptions {
	/** Path to check disk space for */
	path: string;
	/** Threshold in bytes below which low_disk_space is emitted (default: 100MB) */
	thresholdBytes?: number;
	/** Polling interval in milliseconds (default: 5 minutes) */
	intervalMs?: number;
	/** Injectable statfs for testing — defaults to wrapping Node.js fs.statfs() */
	_statfs?: (path: string) => Promise<{ available: number }>;
}

export interface LowDiskSpaceEvent {
	availableBytes: number;
	thresholdBytes: number;
}

export interface DiskSpaceOkEvent {
	availableBytes: number;
}

export type StorageMonitorEvents = {
	low_disk_space: [event: LowDiskSpaceEvent];
	disk_space_ok: [event: DiskSpaceOkEvent];
};

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Default statfs wrapper ─────────────────────────────────────────────────

async function defaultStatfs(path: string): Promise<{ available: number }> {
	const stats = await nodeStatfs(path);
	return { available: stats.bavail * stats.bsize };
}

// ─── StorageMonitor ─────────────────────────────────────────────────────────

export class StorageMonitor implements Drainable {
	private readonly monitorPath: string;
	private readonly thresholdBytes: number;
	private readonly intervalMs: number;
	private readonly statfsFn: (path: string) => Promise<{ available: number }>;

	private timer: ReturnType<typeof setInterval> | null = null;
	private wasLow: boolean | null = null; // null = no check yet
	private checking = false;
	private pending = new Set<Promise<unknown>>();

	// ─── Callbacks ─────────────────────────────────────────────────────────

	onLowDiskSpace: ((event: LowDiskSpaceEvent) => void) | null = null;
	onDiskSpaceOk: ((event: DiskSpaceOkEvent) => void) | null = null;

	constructor(options: StorageMonitorOptions) {
		this.monitorPath = options.path;
		this.thresholdBytes = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.statfsFn = options._statfs ?? defaultStatfs;
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	/** Start periodic polling. First check runs immediately, then on interval. */
	start(): void {
		// Run the first check immediately
		this.trackPromise(this.check());

		// Set up periodic polling
		this.timer = setInterval(() => {
			this.trackPromise(this.check());
		}, this.intervalMs);
	}

	/** Stop polling (idempotent). */
	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Cancel the interval and await all pending checks. */
	async drain(): Promise<void> {
		this.stop();
		await Promise.allSettled([...this.pending]);
		this.pending.clear();
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	/** Track a promise for drain. */
	private trackPromise(promise: Promise<unknown>): void {
		this.pending.add(promise);
		promise.finally(() => this.pending.delete(promise));
	}

	private async check(): Promise<void> {
		if (this.checking) return;
		this.checking = true;
		let available: number;
		try {
			({ available } = await this.statfsFn(this.monitorPath));
		} finally {
			this.checking = false;
		}
		const isLow = available < this.thresholdBytes;

		if (isLow && this.wasLow !== true) {
			// Transition to low (from ok/unknown)
			this.wasLow = true;
			this.onLowDiskSpace?.({
				availableBytes: available,
				thresholdBytes: this.thresholdBytes,
			} satisfies LowDiskSpaceEvent);
		} else if (!isLow && this.wasLow === true) {
			// Transition to ok (from low)
			this.wasLow = false;
			this.onDiskSpaceOk?.({
				availableBytes: available,
			} satisfies DiskSpaceOkEvent);
		} else if (!isLow && this.wasLow === null) {
			// First check is ok — just record state, no event
			this.wasLow = false;
		}
	}
}
