// Manages WebSocket connection lifecycle and centralized message dispatch.
// Creates WebSocket synchronously in connect(). The transport module preloads
// the message decoder; server-side waitForRelay() handles relay readiness.

import { Effect, Fiber, Stream } from "effect";
import {
	getRuntime,
	hasActiveStreamFiber,
	interruptStream,
	setActiveStreamFiber,
	type WsProtocolError,
	wsMessageStream,
} from "../transport/runtime.js";
import type { ConnectionStatus } from "../types.js";
import { createFrontendLogger } from "../utils/logger.js";
import { getBrowserClientId } from "./client-identity.js";
import { getCurrentSessionId, getCurrentSlug } from "./router.svelte.js";
import { sessionActivityBridge } from "./session-activity.svelte.js";
import {
	wsDebugLog,
	wsDebugLogMessage,
	wsDebugResetMessageCount,
} from "./ws-debug.svelte.js";

// These were extracted for modularity but consumers still import from here.

// Re-export dispatch module — consumers import handleMessage from here.
export { handleMessage, setAttachedProject } from "./ws-dispatch.js";

export {
	type FileBrowserReply,
	fileBrowserListeners,
	onFileBrowser,
	onProjectAttached,
} from "./ws-listeners.js";
export {
	clearNavigateToSession,
	initSWMessageListener,
	isPushActive,
	onNavigateToSession,
	reconcilePushActive,
	setPushActive,
	triggerNotifications,
} from "./ws-notifications.js";
// Re-export send module — consumers import wsSend from here.
export {
	_resetRateLimit,
	rateLimitChatSend,
	wsSend,
} from "./ws-send.svelte.js";

import { handleMessage } from "./ws-dispatch.js";
import { setWsGetter } from "./ws-send.svelte.js";

const log = createFrontendLogger("ws");

/** Max time to wait for onopen before force-closing and retrying. */
const CONNECT_TIMEOUT_MS = 5_000;

/** Initial reconnect delay (ms). */
const RECONNECT_BASE_MS = 1_000;

/** Maximum reconnect delay (ms). */
const RECONNECT_MAX_MS = 10_000;

let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _connectTimeout: ReturnType<typeof setTimeout> | null = null;
let _reconnectDelay = RECONNECT_BASE_MS;
let _connectionGeneration = 0;

// Kept for legacy self-healing and debug logs until the /ws socket is retired.
let _status: ConnectionStatus = "";

// Wire up the send module's WS getter to our connection state.
setWsGetter(() => _ws);

/** Connect callbacks — called after connection established. */
let _onConnectFn: (() => void) | null = null;
export function onConnect(fn: () => void): void {
	_onConnectFn = fn;
}

let _active = false;

/**
 * Establish WebSocket connection.
 *
 * Creates the WebSocket synchronously. The server's waitForRelay() handles
 * relay readiness on the upgrade path.
 */
export function connect(): void {
	_active = true;
	const slug = getCurrentSlug();
	const sessionId = getCurrentSessionId();
	const generation = ++_connectionGeneration;

	// Cancel any pending reconnect or connect timeout
	if (_reconnectTimer) {
		clearTimeout(_reconnectTimer);
		_reconnectTimer = null;
	}
	if (_connectTimeout) {
		clearTimeout(_connectTimeout);
		_connectTimeout = null;
	}

	void interruptStream();

	// Close existing socket cleanly — null out _ws first so the
	// old socket's close handler won't trigger reconnect logic.
	if (_ws) {
		const oldWs = _ws;
		_ws = null;
		oldWs.close();
	}

	_status = "connecting";
	wsDebugLog("connect", _status, `slug=${slug ?? "standalone"}`);

	doConnect(slug, sessionId, generation);
}

/** Inner function: create the WebSocket and wire up event handlers. */
function doConnect(
	slug: string | null,
	sessionId: string | null,
	generation: number,
): void {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const params = new URLSearchParams({
		client: getBrowserClientId(),
	});
	let url = `${protocol}//${window.location.host}/ws`;

	// If the URL has a session ID, pass it as a query param so the server
	// binds the session named by the URL on init (no flash of another session).
	if (sessionId) {
		params.set("session", sessionId);
	}
	if (slug) params.set("p", slug);
	url += `?${params.toString()}`;

	const ws = new WebSocket(url);
	_ws = ws;
	wsDebugLog("ws:create", _status, url);

	// Connect timeout — if onopen doesn't fire within CONNECT_TIMEOUT_MS,
	// force-close and let the close handler schedule a reconnect.
	_connectTimeout = setTimeout(() => {
		_connectTimeout = null;
		if (_ws === ws && ws.readyState !== WebSocket.OPEN) {
			log.warn("Connect timeout, closing");
			wsDebugLog("timeout", _status);
			ws.close();
		}
	}, CONNECT_TIMEOUT_MS);

	ws.addEventListener("open", () => {
		// Guard: only act if this is still the current socket
		if (_ws !== ws || generation !== _connectionGeneration) return;
		if (_connectTimeout) {
			clearTimeout(_connectTimeout);
			_connectTimeout = null;
		}
		// The incoming roots and family snapshots reconcile row state after
		// reconnect. Keep the previous rows visible until they arrive.
		_status = "connected";
		wsDebugLog("ws:open", _status);
		wsDebugResetMessageCount();
		_reconnectDelay = RECONNECT_BASE_MS;
		_onConnectFn?.();
	});

	ws.addEventListener("close", () => {
		// Guard: only act if this is still the current socket.
		// If connect() was called again, _ws points to the new socket
		// and we must not null it or start a reconnect timer.
		if (_ws !== ws || generation !== _connectionGeneration) return;

		if (_connectTimeout) {
			clearTimeout(_connectTimeout);
			_connectTimeout = null;
		}

		_status = "disconnected";
		wsDebugLog("ws:close", _status);
		_ws = null;
		sessionActivityBridge.clear();

		// The turn is not ended here: the session's shell row rides the RPC
		// socket, not this one, and it ends the turn when the row goes idle.

		// The instance list is not cleared: its subscription rides the RPC
		// sockets, not this one, and nothing here would re-populate it.

		// Schedule reconnect with backoff
		scheduleReconnect();
	});

	ws.addEventListener("error", () => {
		// Don't set error status here — a close event always follows.
		// The close handler handles reconnect scheduling.
		if (_ws !== ws || generation !== _connectionGeneration) return;
		wsDebugLog("ws:error", _status);
	});

	// The stream handles JSON parsing and cleanup. Self-healing and dispatch
	// happen in the runForEach callback synchronously per message.
	getRuntime().then((runtime) => {
		if (_ws !== ws || generation !== _connectionGeneration) return;
		const fiber = runtime.runFork(
			Stream.runForEach(
				wsMessageStream(ws, { onProtocolError: handleProtocolError }),
				(msg) =>
					Effect.sync(() => {
						if (_ws !== ws || generation !== _connectionGeneration) return;

						// Self-healing: if messages arrive but status isn't connected, fix it.
						if (_status !== "connected" && _status !== "processing") {
							wsDebugLog("self-heal", _status);
							if (_connectTimeout) {
								clearTimeout(_connectTimeout);
								_connectTimeout = null;
							}
							_status = "connected";
							_reconnectDelay = RECONNECT_BASE_MS;
						}

						wsDebugLogMessage(_status, msg.type, msg);

						try {
							handleMessage(msg);
						} catch (err) {
							log.warn("Handler error for", msg.type, err);
						}
					}),
			),
		);
		if (_ws !== ws || generation !== _connectionGeneration) {
			runtime.runFork(Fiber.interrupt(fiber));
			return;
		}
		setActiveStreamFiber(fiber);
	});
}

function handleProtocolError(error: WsProtocolError): void {
	const detail =
		error.kind === "invalid_message" && error.messageType
			? `${error.kind} type=${error.messageType}`
			: error.kind;
	wsDebugLog("protocol:error", _status, detail);
	log.warn("WebSocket protocol error:", error.detail, error);
}

/** Schedule a reconnect with increasing backoff (1s -> 1.5s -> 2.25s -> ... -> 10s cap). */
function scheduleReconnect(): void {
	if (_reconnectTimer) return;
	wsDebugLog("reconnect:schedule", _status, `delay=${_reconnectDelay}ms`);
	_reconnectTimer = setTimeout(() => {
		_reconnectTimer = null;
		wsDebugLog("reconnect:fire", _status);
		connect();
	}, _reconnectDelay);
	_reconnectDelay = Math.min(_reconnectDelay * 1.5, RECONNECT_MAX_MS);
}

/**
 * Re-establish the connection when the tab comes back to the foreground.
 *
 * A suspended mobile PWA routinely wakes with a socket that is open on paper
 * but dead in practice, so no close event ever arrives to trigger the backoff
 * timer, and the app sits there silently ignoring the relay. Checking on resume
 * also skips a backoff wait of up to RECONNECT_MAX_MS after a real drop.
 */
function reconnectIfStale(): void {
	if (document.visibilityState !== "visible" || !_active) {
		return;
	}
	if (_ws?.readyState === WebSocket.OPEN && hasActiveStreamFiber()) return;

	wsDebugLog("resume:reconnect", _status);
	if (_reconnectTimer) {
		clearTimeout(_reconnectTimer);
		_reconnectTimer = null;
	}
	_reconnectDelay = RECONNECT_BASE_MS;
	connect();
}

if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", reconnectIfStale);
	window.addEventListener("pageshow", reconnectIfStale);
}

/** Disconnect and stop reconnecting. */
export function disconnect(): void {
	sessionActivityBridge.clear();
	wsDebugLog("disconnect", _status);
	_active = false;
	_connectionGeneration++;
	void interruptStream();
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
	_status = "disconnected";
}
