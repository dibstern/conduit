// ─── WebSocket Debug Store ──────────────────────────────────────────────────
// Ring buffer of timestamped WS lifecycle events for diagnostics.
// Always records events. When featureFlags.debug is true, also logs to console.
// Access from browser console: window.__wsDebug()

import { featureFlags } from "./feature-flags.svelte.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WsDebugEvent {
	time: number;
	event: string;
	detail?: string | undefined;
	state: string; // ConnectionStatus at time of event
}

export interface WsDebugSnapshot {
	timeInState: number;
	eventCount: number;
	events: WsDebugEvent[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_EVENTS = 50;

// ─── State ──────────────────────────────────────────────────────────────────

let _events: WsDebugEvent[] = [];
let _lastTransitionTime = Date.now();
let _messageCount = 0;

export const wsDebugState = $state({
	/** Number of events in the buffer — triggers reactivity for the panel. */
	eventCount: 0,
	/** Timestamp of last state transition. */
	lastTransitionTime: Date.now(),
	/** When true, log every ws:message instead of 1-per-100. */
	verboseMessages: false,
});

// ─── Core ───────────────────────────────────────────────────────────────────

/** State transition events that reset the time-in-state counter. */
const TRANSITION_EVENTS = new Set([
	"connect",
	"ws:open",
	"ws:close",
	"disconnect",
	"timeout",
	"self-heal",
]);

/**
 * Log a WebSocket lifecycle event.
 * Always pushes to the ring buffer.
 * When featureFlags.debug is true, also logs to console.
 *
 * @param event - Event name (e.g. "connect", "ws:open", "timeout")
 * @param state - Current ConnectionStatus value from wsState.status
 * @param detail - Optional detail string (e.g. "slug=my-project")
 */
export function wsDebugLog(
	event: string,
	state: string,
	detail?: string,
): void {
	const entry: WsDebugEvent = {
		time: Date.now(),
		event,
		detail,
		state,
	};

	_events.push(entry);
	if (_events.length > MAX_EVENTS) {
		_events = _events.slice(-MAX_EVENTS);
	}

	wsDebugState.eventCount = _events.length;

	// Track state transitions for time-in-state calculation
	if (TRANSITION_EVENTS.has(event)) {
		_lastTransitionTime = entry.time;
		wsDebugState.lastTransitionTime = entry.time;
	}

	// Console output when debug is enabled
	if (featureFlags.debug) {
		const prefix = `[ws] ${event}`;
		if (detail) {
			console.debug(prefix, detail);
		} else {
			console.debug(prefix);
		}
	}
}

/**
 * Log ws:message events with throttling (first + every 100th).
 * Avoids flooding the ring buffer with message events.
 *
 * @param state - Current ConnectionStatus value
 * @param msgType - The parsed message type (e.g. "event", "session.list", "messages")
 */
export function wsDebugLogMessage(state: string, msgType?: string): void {
	_messageCount++;
	const shouldLog =
		wsDebugState.verboseMessages ||
		_messageCount === 1 ||
		_messageCount % 100 === 0;
	if (shouldLog) {
		const detail = msgType
			? `#${_messageCount} ${msgType}`
			: `#${_messageCount}`;
		wsDebugLog("ws:message", state, detail);
	}
}

/** Reset the message counter (call on new connection). */
export function wsDebugResetMessageCount(): void {
	_messageCount = 0;
}

/** Get a JSON-serializable snapshot of the current debug state. */
export function getDebugSnapshot(): WsDebugSnapshot {
	return {
		timeInState: Date.now() - _lastTransitionTime,
		eventCount: _events.length,
		events: [..._events],
	};
}

/** Get the raw events array (for the debug panel — read-only view). */
export function getDebugEvents(): readonly WsDebugEvent[] {
	return _events;
}

/** Clear the event buffer. */
export function clearDebugLog(): void {
	_events = [];
	_messageCount = 0;
	wsDebugState.eventCount = 0;
}

// ─── Global debug function ──────────────────────────────────────────────────
// Always available in browser console, even when debug UI is off.

if (typeof window !== "undefined") {
	(window as unknown as Record<string, unknown>)["__wsDebug"] = () => {
		const snap = getDebugSnapshot();
		console.table(snap.events);
		return snap;
	};
}
