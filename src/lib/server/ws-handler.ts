// ─── WebSocket Handler (Ticket 2.2) ──────────────────────────────────────────
// I/O layer: actual WebSocket server using the `ws` library.
// Wires ws-router.ts (pure logic) to real WebSocket connections.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type { ServiceRegistry } from "../daemon/service-registry.js";
import { TrackedService } from "../daemon/tracked-service.js";
import { SessionRegistry } from "../session/session-registry.js";
import type { RelayMessage } from "../types.js";
import {
	type ClientTracker,
	createClientCountMessage,
	createClientTracker,
	type IncomingMessageType,
	isRouteError,
	parseIncomingMessage,
	routeMessage,
} from "./ws-router.js";

// Use createRequire to import ws — the ws package is CJS-only and
// named ESM imports behave inconsistently across tsx, vitest, and Node ESM.
const require = createRequire(import.meta.url);
const ws = require("ws");
const WebSocketServerClass =
	ws.WebSocketServer as typeof import("ws").WebSocketServer;
type WSType = import("ws").WebSocket;
type RawData = import("ws").RawData;

const WS_OPEN = 1; // WebSocket.OPEN constant

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WebSocketHandlerOptions {
	/** Path prefix for WebSocket upgrades (e.g., "/p/my-project") */
	pathPrefix?: string;
	/** Maximum message size in bytes */
	maxPayload?: number;
	/** Heartbeat interval in ms */
	heartbeatInterval?: number;
	/** Optional auth check on WebSocket upgrade (ws library verifyClient). */
	verifyClient?: (
		info: {
			origin: string;
			secure: boolean;
			req: import("node:http").IncomingMessage;
		},
		callback: (result: boolean, code?: number, message?: string) => void,
	) => void;
	/** Shared session registry for client→session tracking (default: creates a new one) */
	registry?: SessionRegistry;
}

export type WebSocketHandlerEvents = {
	/** Client connected */
	client_connected: [
		{
			clientId: string;
			clientCount: number;
			/** Session ID requested via ?session= query param (new-tab routing) */
			requestedSessionId?: string;
		},
	];
	/** Client disconnected */
	client_disconnected: [
		{
			clientId: string;
			clientCount: number;
			/** Session ID the client was viewing when they disconnected */
			sessionId?: string;
		},
	];
	/** Incoming message from a client */
	message: [
		{
			clientId: string;
			handler: IncomingMessageType;
			payload: Record<string, unknown>;
		},
	];
	/** Error on a client connection */
	client_error: [{ clientId: string; error: Error }];
};

// ─── WebSocket Handler ──────────────────────────────────────────────────────

export class WebSocketHandler extends TrackedService<WebSocketHandlerEvents> {
	private readonly wss: InstanceType<typeof WebSocketServerClass>;
	private readonly clients: Map<string, WSType> = new Map();
	private readonly tracker: ClientTracker;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private readonly heartbeatInterval: number;
	/** Per-tab session tracking: delegates to shared SessionRegistry */
	private readonly registry: SessionRegistry;
	/**
	 * Phase 0b: session_list-first invariant.
	 *
	 * Tracks which clients have received their initial `session_list` (and any
	 * other bootstrap messages). Until a client is marked bootstrapped, any
	 * per-session events delivered via {@link broadcastPerSessionEvent} are
	 * buffered in {@link bootstrapQueues} and flushed on
	 * {@link markClientBootstrapped}. This eliminates the race where a fresh
	 * connection sees a per-session event before it knows the session exists.
	 */
	private readonly bootstrappedClients: Set<string> = new Set();
	private readonly bootstrapQueues: Map<string, string[]> = new Map();

	constructor(
		registry: ServiceRegistry,
		server: Server | null,
		options: WebSocketHandlerOptions = {},
	) {
		super(registry);
		this.tracker = createClientTracker();
		this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
		this.registry = options.registry ?? new SessionRegistry();

		// When server is null, create in noServer mode — the caller (daemon)
		// handles HTTP upgrades and calls handleUpgrade() directly.
		// Do NOT pass { server: null } to ws — it throws.
		const wssOptions = server
			? {
					server,
					path: options.pathPrefix ? `${options.pathPrefix}/ws` : undefined,
					// verifyClient runs during the auto-attached upgrade handler
					verifyClient: options.verifyClient,
				}
			: {
					noServer: true as const,
					// In noServer mode, ws still calls verifyClient during handleUpgrade.
					// But the daemon's upgrade handler already checks auth, so skip it
					// to avoid redundant double-checking.
				};

		this.wss = new WebSocketServerClass({
			...wssOptions,
			maxPayload: options.maxPayload ?? 50 * 1024 * 1024, // 50MB — must accommodate base64 image payloads
			// @perf-guard S5 — removing perMessageDeflate increases WS bandwidth by 30-60%
			perMessageDeflate: {
				// Compress everything — the threshold option only works with
				// serverNoContextTakeover which destroys the inter-message
				// dictionary, reducing compression ratio for repeated JSON
				// structures. Better to compress all messages with context
				// carryover than to skip small ones with no carryover.
				//
				// Cap server window bits to reduce per-connection memory:
				//   Default (15): ~64KB per connection for zlib state
				//   With 10:      ~6-7KB per connection
				// JSON control messages compress nearly as well with smaller windows.
				serverMaxWindowBits: 10,
				// NOTE: clientMaxWindowBits is NOT set. Setting it to a specific
				// value can reject clients that don't include client_max_window_bits
				// in their extension negotiation offer. Omitting it lets the ws
				// library negotiate with whatever the client supports.
				zlibDeflateOptions: {
					level: 1, // Z_BEST_SPEED — minimal CPU overhead
				},
			},
		});

		this.wss.on("connection", (wsConn: WSType, req: IncomingMessage) =>
			this.onConnection(wsConn, req),
		);

		// Start heartbeat
		this.startHeartbeat();
	}

	/** Broadcast a message to all connected clients */
	broadcast(message: RelayMessage): void {
		const data = JSON.stringify(message);
		for (const [_id, wsConn] of this.clients) {
			if (wsConn.readyState === WS_OPEN) {
				wsConn.send(data);
			}
		}
	}

	/** Send a message to a specific client */
	sendTo(clientId: string, message: RelayMessage): void {
		const wsConn = this.clients.get(clientId);
		if (wsConn && wsConn.readyState === WS_OPEN) {
			wsConn.send(JSON.stringify(message));
		}
	}

	// ── Per-tab session tracking ────────────────────────────────────────────

	/** Associate a client with a session (called on session switch) */
	setClientSession(clientId: string, sessionId: string): void {
		this.registry.setClientSession(clientId, sessionId);
	}

	/** Get the session a client is viewing */
	getClientSession(clientId: string): string | undefined {
		return this.registry.getClientSession(clientId);
	}

	/** Get all client IDs viewing a specific session */
	getClientsForSession(sessionId: string): string[] {
		// Filter to only connected clients (registry may have stale entries from races)
		return this.registry
			.getViewers(sessionId)
			.filter((cid) => this.clients.has(cid));
	}

	/**
	 * Send a message to all clients viewing a specific session.
	 *
	 * Retained for status-only viewer-scoped sends (e.g.
	 * `sendStatusToSession` in monitoring-wiring). Under Phase 0b, per-session
	 * chat events no longer go through this method — use
	 * {@link broadcastPerSessionEvent} instead so every client on this
	 * handler (i.e., every client on the project's `/p/<slug>`) receives the
	 * event regardless of which session they are actively viewing.
	 */
	sendToSession(sessionId: string, message: RelayMessage): void {
		const data = JSON.stringify(message);
		for (const clientId of this.registry.getViewers(sessionId)) {
			const wsConn = this.clients.get(clientId);
			if (wsConn && wsConn.readyState === WS_OPEN) {
				wsConn.send(data);
			}
		}
	}

	/**
	 * Phase 0b: project-scoped per-session event firehose.
	 *
	 * Delivers `message` to every client connected to this handler — all
	 * clients on the same project's `/p/<slug>`. Delivery is not gated by
	 * `view_session`; the client-side dispatcher routes by `sessionId`.
	 *
	 * Bootstrap-race guarantee: clients that have not yet received their
	 * initial `session_list` are not eligible recipients. Their events are
	 * buffered per-client in {@link bootstrapQueues} and flushed in order
	 * when {@link markClientBootstrapped} is called. This preserves the
	 * invariant that `session_list` arrives before any `PerSessionEvent` on
	 * a fresh connection.
	 *
	 * Per-session ordering: events produced in a given order are delivered in
	 * that order to every client. Cross-session interleaving is not
	 * constrained — events for different sessions may appear in different
	 * relative orders at different clients (acceptable per plan §Phase 0b).
	 *
	 * @param _sessionId - Currently only used for logging/telemetry; routing
	 *   is by project (this handler) rather than per-session. The parameter
	 *   is retained so call sites stay explicit about the session they're
	 *   broadcasting for and so future gating (presence, per-session backpressure)
	 *   can be layered in without signature churn.
	 */
	broadcastPerSessionEvent(_sessionId: string, message: RelayMessage): void {
		const data = JSON.stringify(message);
		for (const [clientId, wsConn] of this.clients) {
			if (!this.bootstrappedClients.has(clientId)) {
				// Still bootstrapping — hold until markClientBootstrapped flushes.
				let queue = this.bootstrapQueues.get(clientId);
				if (!queue) {
					queue = [];
					this.bootstrapQueues.set(clientId, queue);
				}
				queue.push(data);
				continue;
			}
			if (wsConn.readyState === WS_OPEN) {
				wsConn.send(data);
			}
		}
	}

	/**
	 * Phase 0b: mark a client as having completed its initial handshake.
	 *
	 * Called by bootstrap code (e.g. `handleClientConnected`) AFTER the
	 * initial `session_list` has been dispatched. Flushes any per-session
	 * events buffered in {@link bootstrapQueues} for this client, preserving
	 * the order they were produced.
	 *
	 * Idempotent — calling twice is a no-op.
	 */
	markClientBootstrapped(clientId: string): void {
		if (this.bootstrappedClients.has(clientId)) return;
		this.bootstrappedClients.add(clientId);
		const queue = this.bootstrapQueues.get(clientId);
		this.bootstrapQueues.delete(clientId);
		if (!queue || queue.length === 0) return;
		const wsConn = this.clients.get(clientId);
		if (!wsConn || wsConn.readyState !== WS_OPEN) return;
		for (const data of queue) {
			wsConn.send(data);
		}
	}

	/** Get connected client count */
	getClientCount(): number {
		return this.tracker.getClientCount();
	}

	/** Get all client IDs */
	getClientIds(): string[] {
		return this.tracker.getClientIds();
	}

	/** Close all connections and clean up */
	close(): void {
		if (this.heartbeatTimer) {
			this.clearTrackedTimer(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		for (const [_id, wsConn] of this.clients) {
			wsConn.close(1001, "Server shutting down");
		}

		this.clients.clear();
		this.registry.clear();
		this.bootstrappedClients.clear();
		this.bootstrapQueues.clear();
		this.wss.close();
	}

	/** Drain: close connections then cancel tracked async work. */
	override async drain(): Promise<void> {
		this.close();
		await super.drain();
	}

	/**
	 * Handle an HTTP upgrade manually (for noServer mode).
	 * The daemon's upgrade handler calls this after routing by slug and checking auth.
	 */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		this.wss.handleUpgrade(req, socket, head, (ws) => {
			this.wss.emit("connection", ws, req);
		});
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private onConnection(wsConn: WSType, req: IncomingMessage): void {
		const clientId = randomBytes(8).toString("hex");
		this.clients.set(clientId, wsConn);
		const count = this.tracker.addClient(clientId);

		// Parse ?session= from the WS URL to support new-tab routing:
		// the client tells us which session it wants from the very first message.
		let requestedSessionId: string | undefined;
		if (req.url) {
			try {
				const url = new URL(req.url, "http://localhost");
				const session = url.searchParams.get("session");
				if (session) requestedSessionId = session;
			} catch {
				// Malformed URL — ignore
			}
		}

		// Notify about new client
		this.emit("client_connected", {
			clientId,
			clientCount: count,
			...(requestedSessionId != null && { requestedSessionId }),
		});

		// Send client count update to all
		this.broadcast(createClientCountMessage(count));

		// Handle messages
		wsConn.on("message", (data: RawData) => {
			this.onMessage(clientId, data);
		});

		// Handle close
		wsConn.on("close", () => {
			this.clients.delete(clientId);
			// Drop any bootstrap state — no point flushing to a closed connection.
			this.bootstrappedClients.delete(clientId);
			this.bootstrapQueues.delete(clientId);
			// Remove client from registry — returns the session they were viewing
			// so the client_disconnected handler can access it.
			const sessionId = this.registry.removeClient(clientId);
			const newCount = this.tracker.removeClient(clientId);
			this.emit("client_disconnected", {
				clientId,
				clientCount: newCount,
				...(sessionId != null && { sessionId }),
			});
			this.broadcast(createClientCountMessage(newCount));
		});

		// Handle errors
		wsConn.on("error", (err: Error) => {
			this.emit("client_error", { clientId, error: err });
		});

		// Mark as alive for heartbeat
		(wsConn as WSType & { isAlive: boolean }).isAlive = true;
		wsConn.on("pong", () => {
			(wsConn as WSType & { isAlive: boolean }).isAlive = true;
		});
	}

	private onMessage(clientId: string, raw: RawData): void {
		const str = raw.toString();
		const parsed = parseIncomingMessage(str);

		if (!parsed) {
			// Invalid JSON — send error but don't disconnect (AC7)
			this.sendTo(clientId, {
				type: "system_error",
				code: "PARSE_ERROR",
				message: "Could not parse message as JSON",
			});
			return;
		}

		const result = routeMessage(parsed);

		if (isRouteError(result)) {
			// Unknown message type — send error but don't disconnect (AC7)
			this.sendTo(clientId, {
				type: "system_error",
				code: result.code,
				message: result.message,
			});
			return;
		}

		// Emit for the project context to handle
		this.emit("message", {
			clientId,
			handler: result.handler,
			payload: result.payload,
		});
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = this.repeating(() => {
			for (const [clientId, wsConn] of this.clients) {
				const aliveWs = wsConn as WSType & { isAlive: boolean };
				if (!aliveWs.isAlive) {
					// Dead connection — terminate and drop all per-client state.
					this.clients.delete(clientId);
					this.bootstrappedClients.delete(clientId);
					this.bootstrapQueues.delete(clientId);
					const count = this.tracker.removeClient(clientId);
					this.emit("client_disconnected", { clientId, clientCount: count });
					this.broadcast(createClientCountMessage(count));
					wsConn.terminate();
					continue;
				}
				aliveWs.isAlive = false;
				wsConn.ping();
			}
		}, this.heartbeatInterval);
	}
}
