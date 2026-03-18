// ─── WebSocket Send Logic ────────────────────────────────────────────────────
// Extracted from ws.svelte.ts — rate limiting, offline queue, and send helpers.
// The parent module provides the WebSocket reference via setWsGetter().

import type { PayloadMap } from "../types.js";
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

/** Queued message waiting to be sent after the window slides. */
let _queuedMessage: Record<string, unknown> | null = null;

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
	_queuedMessage = null;
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
	// WS not open — queue instance management commands for send-on-reconnect.
	// These are the commands that users trigger from the ConnectOverlay or
	// SettingsPanel while the connection is down.
	const type = data["type"] as string;
	if (
		type === "instance_start" ||
		type === "instance_stop" ||
		type === "instance_add" ||
		type === "instance_remove" ||
		type === "instance_update" ||
		type === "set_project_instance" ||
		type === "scan_now" ||
		type === "instance_rename"
	) {
		_offlineQueue.push(data);
	}
}

// ─── Offline message queue ──────────────────────────────────────────────────
// Instance management commands sent while WS is closed are queued here
// and flushed when the connection is re-established.

let _offlineQueue: Record<string, unknown>[] = [];

/** Flush any queued offline messages over the now-open WebSocket. */
export function flushOfflineQueue(): void {
	if (_offlineQueue.length === 0) return;
	const queue = _offlineQueue;
	_offlineQueue = [];
	for (const msg of queue) {
		rawSend(msg);
	}
}

/** Schedule the drain timer for the queued message. */
function scheduleDrain(): void {
	if (_drainTimer) {
		clearTimeout(_drainTimer);
		_drainTimer = null;
	}
	if (!_queuedMessage) return;

	pruneTimestamps();

	// Oldest timestamp determines when the next slot opens.
	// With noUncheckedIndexedAccess, _sendTimestamps[0] is number | undefined.
	const oldest = _sendTimestamps[0];
	const retryAfterMs = oldest !== undefined ? oldest + WINDOW_MS - _now() : 0;
	const delay = Math.max(0, retryAfterMs);

	_drainTimer = setTimeout(() => {
		_drainTimer = null;
		if (!_queuedMessage) return;

		pruneTimestamps();
		const msg = _queuedMessage;
		_queuedMessage = null;
		_sendTimestamps.push(_now());
		rawSend(msg);
	}, delay);
}

// ─── Core send function ─────────────────────────────────────────────────────

/**
 * Send a JSON message over the WebSocket.
 * Chat messages (type "message") are rate-limited to match the server-side
 * sliding window (MAX_MESSAGES per WINDOW_MS). Non-chat control messages
 * are sent immediately.
 */
/**
 * Type-safe WebSocket send. Ensures the payload matches the expected shape
 * for the given message type at compile time.
 * Delegates to wsSend for rate limiting and offline queuing.
 */
export function wsSendTyped<T extends keyof PayloadMap>(
	type: T,
	payload: PayloadMap[T],
): void {
	wsSend({ type, ...(payload as Record<string, unknown>) });
}

export function wsSend(data: Record<string, unknown>): void {
	// Non-chat messages bypass rate limiting entirely.
	if (data["type"] !== "message") {
		rawSend(data);
		return;
	}

	pruneTimestamps();

	if (_sendTimestamps.length < MAX_MESSAGES) {
		// Under limit — send immediately.
		_sendTimestamps.push(_now());
		rawSend(data);
		return;
	}

	// At limit — queue and show feedback.
	_queuedMessage = data;
	showToast("Message queued — sending shortly", { variant: "warn" });
	scheduleDrain();
}
