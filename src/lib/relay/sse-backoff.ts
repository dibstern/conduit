// ─── SSE Reconnection & Backoff (Ticket 1.2) ────────────────────────────────
// Pure logic for exponential backoff calculation and connection health tracking.
// Deliberately IO-free.

import type { ConnectionHealth } from "../types.js";

// ─── Exponential backoff ─────────────────────────────────────────────────────

export interface BackoffConfig {
	baseDelay: number; // Initial delay in ms (default: 1000)
	maxDelay: number; // Maximum delay in ms (default: 30000)
	multiplier: number; // Multiplier per attempt (default: 2)
}

const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
	baseDelay: 1000,
	maxDelay: 30000,
	multiplier: 2,
};

/**
 * Calculate the next reconnection delay using exponential backoff.
 * delay = min(baseDelay * multiplier^attempt, maxDelay)
 * Always returns a value between baseDelay and maxDelay.
 */
export function calculateBackoffDelay(
	attempt: number,
	config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
): number {
	if (attempt < 0) return config.baseDelay;
	const delay = config.baseDelay * config.multiplier ** attempt;
	return Math.min(delay, config.maxDelay);
}

// ─── Connection health tracking ──────────────────────────────────────────────

export interface HealthTracker {
	onConnected(): void;
	onDisconnected(): void;
	onEvent(): void;
	onReconnect(): void;
	getHealth(): ConnectionHealth & { stale: boolean };
	isStale(): boolean;
	getReconnectCount(): number;
}

export interface HealthTrackerConfig {
	staleThreshold: number; // ms — mark as stale if no event within this window
	now?: () => number;
}

const DEFAULT_HEALTH_CONFIG: HealthTrackerConfig = {
	staleThreshold: 60_000,
};

/**
 * Create a health tracker that monitors SSE connection state.
 */
export function createHealthTracker(
	config: HealthTrackerConfig = DEFAULT_HEALTH_CONFIG,
): HealthTracker {
	const now = config.now ?? (() => Date.now());
	let connected = false;
	let lastEventAt: number | null = null;
	let reconnectCount = 0;

	return {
		onConnected() {
			connected = true;
		},

		onDisconnected() {
			connected = false;
		},

		onEvent() {
			lastEventAt = now();
		},

		onReconnect() {
			reconnectCount++;
			connected = true;
		},

		getHealth() {
			return {
				connected,
				lastEventAt,
				reconnectCount,
				stale: this.isStale(),
			};
		},

		isStale() {
			if (!connected) return false;
			if (lastEventAt === null) return false;
			return now() - lastEventAt > config.staleThreshold;
		},

		getReconnectCount() {
			return reconnectCount;
		},
	};
}
