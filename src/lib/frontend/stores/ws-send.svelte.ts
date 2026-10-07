// Client-side rate limiting for chat RPC calls.

import { showToast } from "./ui.svelte.js";

// Mirrors server-side limits to prevent RATE_LIMITED errors.

const MAX_MESSAGES = 5;
const WINDOW_MS = 10_000;

/** Timestamps of recent chat message sends (within the sliding window). */
let _sendTimestamps: number[] = [];

/** Queued chat send waiting for the window to slide. */
let _queuedSend: (() => void) | null = null;

/** Timer for draining the queued message. */
let _drainTimer: ReturnType<typeof setTimeout> | null = null;

/** Clock function — overridable for testing. */
let _now: () => number = () => Date.now();

/**
 * Reset rate-limit state. Exported for testing only.
 * @internal
 */
export function _resetRateLimit(opts?: { now?: () => number }): void {
	_sendTimestamps = [];
	_queuedSend = null;
	if (_drainTimer) {
		clearTimeout(_drainTimer);
		_drainTimer = null;
	}
	_now = opts?.now ?? (() => Date.now());
}

/** Remove expired timestamps from the sliding window. */
function pruneTimestamps(): void {
	const cutoff = _now() - WINDOW_MS;
	_sendTimestamps = _sendTimestamps.filter((t) => t > cutoff);
}

/** Schedule the drain timer for the queued message. */
function scheduleDrain(): void {
	if (_drainTimer) {
		clearTimeout(_drainTimer);
		_drainTimer = null;
	}
	if (!_queuedSend) return;

	pruneTimestamps();

	// Oldest timestamp determines when the next slot opens.
	// With noUncheckedIndexedAccess, _sendTimestamps[0] is number | undefined.
	const oldest = _sendTimestamps[0];
	const retryAfterMs = oldest !== undefined ? oldest + WINDOW_MS - _now() : 0;
	const delay = Math.max(0, retryAfterMs);

	_drainTimer = setTimeout(() => {
		_drainTimer = null;
		if (!_queuedSend) return;

		pruneTimestamps();
		const send = _queuedSend;
		_queuedSend = null;
		_sendTimestamps.push(_now());
		send();
	}, delay);
}

/**
 * Rate-limit chat RPC calls to match the server-side sliding window.
 */
export function rateLimitChatSend(send: () => void): void {
	pruneTimestamps();

	if (_sendTimestamps.length < MAX_MESSAGES) {
		// Under limit — send immediately.
		_sendTimestamps.push(_now());
		send();
		return;
	}

	// At limit — queue and show feedback.
	_queuedSend = send;
	showToast("Message queued — sending shortly", { variant: "warn" });
	scheduleDrain();
}
