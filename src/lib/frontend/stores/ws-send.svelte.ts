// ─── WebSocket Send Logic ────────────────────────────────────────────────────
// Extracted from ws.svelte.ts — rate limiting and send helpers.
// The parent module provides the WebSocket reference via setWsGetter().

import { showToast } from "./ui.svelte.js";

// ─── WebSocket reference ────────────────────────────────────────────────────
// The parent module (ws.svelte.ts) owns the WebSocket lifecycle and provides
// a getter so this module can send without owning the connection.

let _getWs: () => WebSocket | null = () => null;

/** Set the getter function for the current WebSocket. Called by ws.svelte.ts. */
export function setWsGetter(getter: () => WebSocket | null): void {
	_getWs = getter;
}

// ─── Client-side rate limiting ──────────────────────────────────────────────
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

/** Send raw data over the WebSocket (no rate limiting). */
export function rawSend(data: Record<string, unknown>): void {
	const ws = _getWs();
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(data));
		return;
	}
	// WS not open — no current raw WS command is safe to replay offline.
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

// ─── Core send function ─────────────────────────────────────────────────────

/**
 * Send a JSON message over the WebSocket.
 * Chat messages (type "message") are rate-limited to match the server-side
 * sliding window (MAX_MESSAGES per WINDOW_MS). Non-chat control messages
 * are sent immediately.
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

export function wsSend(data: Record<string, unknown>): void {
	// Non-chat messages bypass rate limiting entirely.
	if (data["type"] !== "message") {
		rawSend(data);
		return;
	}

	rateLimitChatSend(() => rawSend(data));
}
