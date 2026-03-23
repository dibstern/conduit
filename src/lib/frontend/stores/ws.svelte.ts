// ─── WebSocket Store ─────────────────────────────────────────────────────────
// Manages WebSocket connection lifecycle and centralized message dispatch.
// Creates WebSocket synchronously in connect() — no async pre-flight barrier.
// Server-side waitForRelay() handles relay readiness on the upgrade path.

import type { ConnectionStatus, RelayMessage } from "../types.js";
import { chatState } from "./chat.svelte.js";
import { clearInstanceState } from "./instance.svelte.js";
import { getCurrentSessionId } from "./router.svelte.js";
import {
	wsDebugLog,
	wsDebugLogMessage,
	wsDebugResetMessageCount,
} from "./ws-debug.svelte.js";

// ─── Re-exports from extracted modules ──────────────────────────────────────
// These were extracted for modularity but consumers still import from here.

// Re-export dispatch module — consumers import handleMessage from here.
export { handleMessage } from "./ws-dispatch.js";

export {
	fileBrowserListeners,
	fileHistoryListeners,
	type MessageListener,
	onFileBrowser,
	onFileHistory,
	onPlanMode,
	onProject,
	onRewind,
	planModeListeners,
	projectListeners,
	rewindListeners,
} from "./ws-listeners.js";
export {
	clearNavigateToSession,
	initSWNavigationListener,
	isPushActive,
	onNavigateToSession,
	setPushActive,
	triggerNotifications,
} from "./ws-notifications.js";
// Re-export send module — consumers import wsSend from here.
export { _resetRateLimit, wsSend, wsSendTyped } from "./ws-send.svelte.js";

import { handleMessage } from "./ws-dispatch.js";
import { flushOfflineQueue, setWsGetter } from "./ws-send.svelte.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max time to wait for onopen before force-closing and retrying. */
const CONNECT_TIMEOUT_MS = 5_000;

/** Initial reconnect delay (ms). */
const RECONNECT_BASE_MS = 1_000;

/** Maximum reconnect delay (ms). */
const RECONNECT_MAX_MS = 10_000;

// ─── State ──────────────────────────────────────────────────────────────────

let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _connectTimeout: ReturnType<typeof setTimeout> | null = null;
let _reconnectDelay = RECONNECT_BASE_MS;

export const wsState = $state({
	status: "" as ConnectionStatus,
	statusText: "",
	/** Number of connection attempts since last successful connection. */
	attempts: 0,
	/** Relay readiness from non-blocking status check. */
	relayStatus: undefined as "registering" | "ready" | "error" | undefined,
	/** Error message from relay when status is "error". */
	relayError: undefined as string | undefined,
});

// Wire up the send module's WS getter to our connection state.
setWsGetter(() => _ws);

// ─── Derived getters ────────────────────────────────────────────────────────

/** Get whether the WebSocket is connected. */
export function getIsConnected(): boolean {
	return wsState.status === "connected" || wsState.status === "processing";
}

/** Set connection status with tooltip text. */
function setStatus(status: ConnectionStatus, text: string): void {
	wsState.status = status;
	wsState.statusText = text;
}

// ─── Connection lifecycle ───────────────────────────────────────────────────

/** Connect callbacks — called after connection established. */
let _onConnectFn: (() => void) | null = null;
export function onConnect(fn: () => void): void {
	_onConnectFn = fn;
}

/** Current slug — stored for auto-reconnect so it reconnects to the right project. */
let _currentSlug: string | undefined;

/**
 * Non-blocking relay status fetch — for UI enrichment only.
 * Does NOT block connection. Updates wsState.relayStatus/relayError
 * so the ConnectOverlay can show "Starting relay..." or error details.
 */
function fetchRelayStatus(slug: string): void {
	fetch(`/p/${slug}/api/status`)
		.then((res) => {
			if (!res.ok || _currentSlug !== slug) return null;
			return res.json();
		})
		.then((data: { status?: string; error?: string } | null) => {
			if (!data || _currentSlug !== slug) return;
			if (data.status === "registering") {
				wsState.relayStatus = "registering";
			} else if (data.status === "error") {
				wsState.relayStatus = "error";
				wsState.relayError = data.error;
			} else if (data.status === "ready") {
				wsState.relayStatus = "ready";
			}
			wsDebugLog("relay:status", wsState.status, `status=${data.status}`);
		})
		.catch(() => {
			// Ignore — this is just for UI enrichment
		});
}

/**
 * Establish WebSocket connection.
 *
 * Creates the WebSocket synchronously — no async pre-flight barrier.
 * The server's waitForRelay() handles relay readiness on the upgrade path.
 * A non-blocking relay status fetch runs in parallel for UI display only.
 */
export function connect(slug?: string): void {
	_currentSlug = slug;

	// Cancel any pending reconnect or connect timeout
	if (_reconnectTimer) {
		clearTimeout(_reconnectTimer);
		_reconnectTimer = null;
	}
	if (_connectTimeout) {
		clearTimeout(_connectTimeout);
		_connectTimeout = null;
	}

	// Close existing socket cleanly — null out _ws first so the
	// old socket's close handler won't trigger reconnect logic.
	if (_ws) {
		const oldWs = _ws;
		_ws = null;
		oldWs.close();
	}

	wsState.attempts++;
	wsState.relayStatus = undefined;
	wsState.relayError = undefined;
	setStatus("connecting", "Connecting");
	wsDebugLog(
		"connect",
		wsState.status,
		`slug=${slug ?? "standalone"}, attempt=${wsState.attempts}`,
	);

	// Create WebSocket immediately — no async gap.
	doConnect(slug);

	// Non-blocking relay status check for UI enrichment (shows
	// "Starting relay..." or error details in the ConnectOverlay).
	if (slug) {
		fetchRelayStatus(slug);
	}
}

/** Inner function: create the WebSocket and wire up event handlers. */
function doConnect(slug: string | undefined): void {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const path = slug ? `/p/${slug}/ws` : "/ws";
	let url = `${protocol}//${window.location.host}${path}`;

	// If the URL has a session ID, pass it as a query param so the server
	// sends the correct session_switched on init (no flash of wrong session).
	const sessionId = getCurrentSessionId();
	if (sessionId) {
		url += `?session=${encodeURIComponent(sessionId)}`;
	}

	const ws = new WebSocket(url);
	_ws = ws;
	wsDebugLog("ws:create", wsState.status, url);

	// Connect timeout — if onopen doesn't fire within CONNECT_TIMEOUT_MS,
	// force-close and let the close handler schedule a reconnect.
	_connectTimeout = setTimeout(() => {
		_connectTimeout = null;
		if (_ws === ws && ws.readyState !== WebSocket.OPEN) {
			console.warn("[ws] Connect timeout, closing");
			wsDebugLog("timeout", wsState.status);
			ws.close();
		}
	}, CONNECT_TIMEOUT_MS);

	ws.addEventListener("open", () => {
		// Guard: only act if this is still the current socket
		if (_ws !== ws) return;
		if (_connectTimeout) {
			clearTimeout(_connectTimeout);
			_connectTimeout = null;
		}
		setStatus("connected", "Connected");
		wsDebugLog("ws:open", wsState.status);
		wsDebugResetMessageCount();
		wsState.attempts = 0;
		wsState.relayStatus = undefined;
		wsState.relayError = undefined;
		_reconnectDelay = RECONNECT_BASE_MS;
		flushOfflineQueue();
		_onConnectFn?.();
	});

	ws.addEventListener("close", () => {
		// Guard: only act if this is still the current socket.
		// If connect() was called again, _ws points to the new socket
		// and we must not null it or start a reconnect timer.
		if (_ws !== ws) return;

		if (_connectTimeout) {
			clearTimeout(_connectTimeout);
			_connectTimeout = null;
		}

		setStatus("disconnected", "Disconnected");
		wsDebugLog("ws:close", wsState.status);
		_ws = null;

		// Reset chat streaming/processing state so UI isn't stuck
		chatState.streaming = false;
		chatState.processing = false;

		// Clear instance state — will be re-populated on reconnect
		clearInstanceState();

		// Schedule reconnect with backoff
		scheduleReconnect();
	});

	ws.addEventListener("error", () => {
		// Don't set error status here — a close event always follows.
		// The close handler handles reconnect scheduling.
		if (_ws !== ws) return;
		wsDebugLog("ws:error", wsState.status);
	});

	ws.addEventListener("message", (event) => {
		if (_ws !== ws) return;

		// Self-healing: if messages arrive but status isn't connected, fix it.
		// Handles edge cases where onopen might be missed.
		if (wsState.status !== "connected" && wsState.status !== "processing") {
			wsDebugLog("self-heal", wsState.status);
			if (_connectTimeout) {
				clearTimeout(_connectTimeout);
				_connectTimeout = null;
			}
			setStatus("connected", "Connected");
			wsState.attempts = 0;
			wsState.relayStatus = undefined;
			wsState.relayError = undefined;
			_reconnectDelay = RECONNECT_BASE_MS;
		}

		let msg: RelayMessage;
		try {
			msg = JSON.parse(event.data) as RelayMessage;
		} catch {
			console.warn("[ws] Failed to parse message:", event.data);
			wsDebugLogMessage(wsState.status);
			return;
		}

		wsDebugLogMessage(wsState.status, msg.type);

		try {
			handleMessage(msg);
		} catch (err) {
			console.warn("[ws] Handler error for", msg.type, err);
		}
	});
}

/** Schedule a reconnect with increasing backoff (1s -> 1.5s -> 2.25s -> ... -> 10s cap). */
function scheduleReconnect(): void {
	if (_reconnectTimer) return;
	wsDebugLog(
		"reconnect:schedule",
		wsState.status,
		`delay=${_reconnectDelay}ms`,
	);
	_reconnectTimer = setTimeout(() => {
		_reconnectTimer = null;
		wsDebugLog("reconnect:fire", wsState.status);
		connect(_currentSlug);
	}, _reconnectDelay);
	_reconnectDelay = Math.min(_reconnectDelay * 1.5, RECONNECT_MAX_MS);
}

/** Disconnect and stop reconnecting. */
export function disconnect(): void {
	wsDebugLog("disconnect", wsState.status);
	// Clear slug first — prevents any in-flight callbacks from interfering.
	_currentSlug = undefined;
	wsState.relayStatus = undefined;
	wsState.relayError = undefined;
	if (_reconnectTimer) {
		clearTimeout(_reconnectTimer);
		_reconnectTimer = null;
	}
	if (_connectTimeout) {
		clearTimeout(_connectTimeout);
		_connectTimeout = null;
	}
	if (_ws) {
		const oldWs = _ws;
		_ws = null;
		oldWs.close();
	}
	setStatus("disconnected", "Disconnected");
}
