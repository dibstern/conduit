// ─── Storage Monitor (Ticket 6.2 AC8) ───────────────────────────────────────
// Periodically checks available disk space and emits events on transitions
// between low/ok states. Used by the Daemon to warn about disk space issues.

import { statfs as nodeStatfs } from "node:fs/promises";
import type { ServiceRegistry } from "./service-registry.js";
import { TrackedService } from "./tracked-service.js";

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

export class StorageMonitor extends TrackedService<StorageMonitorEvents> {
	private readonly monitorPath: string;
	private readonly thresholdBytes: number;
	private readonly intervalMs: number;
	private readonly statfsFn: (path: string) => Promise<{ available: number }>;

	private timer: ReturnType<typeof setInterval> | null = null;
	private wasLow: boolean | null = null; // null = no check yet
	private checking = false;

	constructor(registry: ServiceRegistry, options: StorageMonitorOptions) {
		super(registry);
		this.monitorPath = options.path;
		this.thresholdBytes = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.statfsFn = options._statfs ?? defaultStatfs;
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	/** Start periodic polling. First check runs immediately, then on interval. */
	start(): void {
		// Run the first check immediately
		this.tracked(this.check());

		// Set up periodic polling
		this.timer = this.repeating(() => {
			this.tracked(this.check());
		}, this.intervalMs);
	}

	/** Stop polling (idempotent). */
	stop(): void {
		if (this.timer !== null) {
			this.clearTrackedTimer(this.timer);
			this.timer = null;
		}
	}

	// ─── Private ─────────────────────────────────────────────────────────────

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
			this.emit("low_disk_space", {
				availableBytes: available,
				thresholdBytes: this.thresholdBytes,
			} satisfies LowDiskSpaceEvent);
		} else if (!isLow && this.wasLow === true) {
			// Transition to ok (from low)
			this.wasLow = false;
			this.emit("disk_space_ok", {
				availableBytes: available,
			} satisfies DiskSpaceOkEvent);
		} else if (!isLow && this.wasLow === null) {
			// First check is ok — just record state, no event
			this.wasLow = false;
		}
	}
}
