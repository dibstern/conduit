// ─── SSE Reconnection & Backoff (Ticket 1.2) ────────────────────────────────
// Pure logic for exponential backoff calculation.
// Deliberately IO-free.

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
