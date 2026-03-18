// ─── Crash Counter ──────────────────────────────────────────────────────────
// Tracks crash timestamps within a sliding window to detect restart loops.
// Extracted from daemon.ts for isolated testability.

const DEFAULT_CRASH_WINDOW_MS = 60_000;
const DEFAULT_MAX_CRASHES = 3;

export interface CrashCounterOptions {
	maxCrashes?: number;
	windowMs?: number;
}

export class CrashCounter {
	private readonly maxCrashes: number;
	private readonly windowMs: number;
	private timestamps: number[] = [];

	constructor(options?: CrashCounterOptions) {
		this.maxCrashes = options?.maxCrashes ?? DEFAULT_MAX_CRASHES;
		this.windowMs = options?.windowMs ?? DEFAULT_CRASH_WINDOW_MS;
	}

	record(): void {
		const now = Date.now();
		this.timestamps.push(now);
		// Prune old timestamps outside the crash window
		this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
	}

	shouldGiveUp(): boolean {
		return this.timestamps.length >= this.maxCrashes;
	}

	reset(): void {
		this.timestamps = [];
	}

	getTimestamps(): number[] {
		return [...this.timestamps];
	}
}
