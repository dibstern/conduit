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
	/** When true, this event is only shown in verbose mode (non-sampled ws:message). */
	verbose?: boolean | undefined;
	/** Full parsed message payload (for ws:message events). Always stored. */
	payload?: unknown;
	/** Transient UI flag (not persisted). */
	_expanded?: boolean;
}

export interface WsDebugSnapshot {
	timeInState: number;
	eventCount: number;
	events: WsDebugEvent[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_EVENTS = 300;

// ─── State ──────────────────────────────────────────────────────────────────

let _events: WsDebugEvent[] = [];
let _lastTransitionTime = Date.now();
let _messageCount = 0;

export const wsDebugState = $state({
	/** Monotonic revision counter — triggers reactivity for the panel.
	 *  Increments on every push (unlike array length which plateaus at MAX_EVENTS). */
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

	wsDebugState.eventCount++;

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
 * Log ws:message events. All messages are always recorded in the ring buffer;
 * non-sampled messages are tagged `verbose: true` so that getDebugEvents()
 * can filter them out when the user hasn't enabled verbose mode.
 *
 * Sampled messages: the first message and every 100th thereafter.
 *
 * @param state - Current ConnectionStatus value
 * @param msgType - The parsed message type (e.g. "event", "session.list", "messages")
 * @param payload - The full parsed message object (stored for expandable display)
 */
export function wsDebugLogMessage(
	state: string,
	msgType?: string,
	payload?: unknown,
): void {
	_messageCount++;
	const isSampled = _messageCount === 1 || _messageCount % 100 === 0;
	const detail = msgType ? `#${_messageCount} ${msgType}` : `#${_messageCount}`;

	const entry: WsDebugEvent = {
		time: Date.now(),
		event: "ws:message",
		detail,
		state,
		...(isSampled ? {} : { verbose: true }),
		...(payload !== undefined ? { payload } : {}),
	};

	_events.push(entry);
	if (_events.length > MAX_EVENTS) {
		_events = _events.slice(-MAX_EVENTS);
	}

	wsDebugState.eventCount++;

	// Console output when debug is enabled (respect verbose setting for console)
	if (featureFlags.debug && (wsDebugState.verboseMessages || isSampled)) {
		const prefix = "[ws] ws:message";
		if (payload !== undefined) {
			console.debug(prefix, detail, payload);
		} else {
			console.debug(prefix, detail);
		}
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

/**
 * Get the events array for display. When verboseMessages is off, non-sampled
 * ws:message events (tagged verbose) are filtered out.
 */
export function getDebugEvents(): readonly WsDebugEvent[] {
	if (wsDebugState.verboseMessages) {
		return _events;
	}
	return _events.filter((e) => !e.verbose);
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
