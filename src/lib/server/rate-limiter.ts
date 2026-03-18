// ─── Rate Limiter ────────────────────────────────────────────────────────────
// Sliding-window rate limiter for per-client message throttling.
// Tracks timestamps per client ID and enforces a configurable limit
// within a rolling time window.

/** Configuration for RateLimiter. */
export interface RateLimiterConfig {
	/** Maximum messages allowed within the window. Default: 5. */
	maxMessages?: number;
	/** Window duration in milliseconds. Default: 10_000 (10s). */
	windowMs?: number;
	/** Injectable clock for testing. Default: Date.now. */
	now?: () => number;
}

/** Result from a rate-limit check. */
export interface RateLimitResult {
	/** Whether the message is allowed. */
	allowed: boolean;
	/** If rejected, how many ms until the next slot opens. */
	retryAfterMs?: number;
}

export class RateLimiter {
	private readonly maxMessages: number;
	private readonly windowMs: number;
	private readonly now: () => number;

	/** Per-client sliding window: client ID → sorted array of timestamps. */
	private readonly windows = new Map<string, number[]>();

	constructor(config: RateLimiterConfig = {}) {
		this.maxMessages = config.maxMessages ?? 5;
		this.windowMs = config.windowMs ?? 10_000;
		this.now = config.now ?? Date.now;
	}

	/**
	 * Check whether a message from `clientId` is allowed.
	 * If under the limit, records the timestamp and returns allowed.
	 * If over the limit, returns the time until the oldest entry expires.
	 */
	check(clientId: string): RateLimitResult {
		const now = this.now();
		const timestamps = this.prune(clientId, now);

		if (timestamps.length < this.maxMessages) {
			timestamps.push(now);
			return { allowed: true };
		}

		// Over limit — calculate when the oldest message in the window expires.
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const oldest = timestamps[0]!;
		const retryAfterMs = oldest + this.windowMs - now;

		return { allowed: false, retryAfterMs };
	}

	/**
	 * Returns the number of remaining allowed messages for `clientId`
	 * in the current window.
	 */
	remaining(clientId: string): number {
		const now = this.now();
		const timestamps = this.prune(clientId, now);
		return Math.max(0, this.maxMessages - timestamps.length);
	}

	/**
	 * Remove stale client entries whose timestamps have all expired.
	 * Useful for periodic maintenance to avoid unbounded map growth.
	 */
	cleanup(): void {
		const now = this.now();
		const cutoff = now - this.windowMs;

		for (const [clientId, timestamps] of this.windows) {
			// Remove expired timestamps
			const fresh = timestamps.filter((t) => t > cutoff);
			if (fresh.length === 0) {
				this.windows.delete(clientId);
			} else {
				this.windows.set(clientId, fresh);
			}
		}
	}

	/**
	 * Prune expired timestamps for a client and return the active list.
	 * Creates the entry if it doesn't exist.
	 */
	private prune(clientId: string, now: number): number[] {
		const cutoff = now - this.windowMs;
		let timestamps = this.windows.get(clientId);

		if (!timestamps) {
			timestamps = [];
			this.windows.set(clientId, timestamps);
			return timestamps;
		}

		// Remove timestamps outside the window
		const firstValid = timestamps.findIndex((t) => t > cutoff);
		if (firstValid === -1) {
			// All expired
			timestamps.length = 0;
		} else if (firstValid > 0) {
			timestamps.splice(0, firstValid);
		}

		return timestamps;
	}
}
