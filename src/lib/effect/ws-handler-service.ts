// ─── WsHandlerState — Effect-native WebSocket handler service ───────────────
// Replaces the imperative WebSocketHandler class's mutable Maps/Sets with
// a single atomic Ref<HashMap<string, ClientState>> and pure Effect functions.
//
// This module provides the STATE and OPERATIONS layer — the actual `ws`
// library integration and HTTP upgrade handling remain in the imperative
// ws-handler.ts (still used by daemon-main.ts).
//
// Key conversions from old ws-handler.ts:
//   clients: Map<string, WSType>          → Ref<HashMap<string, ClientState>>
//   bootstrappedClients: Set<string>      → bootstrapped field on ClientState
//   bootstrapQueues: Map<string, string[]> → bootstrapQueue field on ClientState
//   broadcast/sendTo/sendToSession         → pure Effect functions with safeSend
//   heartbeat setInterval                  → (kept in imperative layer for now)
//
// Pattern follows session-registry-state.ts and daemon-state.ts:
//   WsHandlerStateTag → Ref.Ref<HashMap<string, ClientState>>
//   makeWsHandlerStateLive() → Layer providing the Tag
//   Pure functions: addClient, removeClient, broadcast, sendTo, etc.

import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import type { RelayMessage } from "../shared-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Minimal WebSocket interface — abstracts the `ws` library's WebSocket type
 * so the state layer doesn't depend on the `ws` package.
 */
export interface WsConn {
	send(data: string): void;
	readyState: number;
	close(code?: number, reason?: string): void;
	ping?(): void;
	terminate?(): void;
}

/** WS_OPEN readyState constant (matches ws.OPEN = 1). */
const WS_OPEN = 1;

/**
 * Per-client state tracked in the HashMap.
 *
 * Collapses the old ws-handler's three separate data structures
 * (clients Map, bootstrappedClients Set, bootstrapQueues Map) into a
 * single record per client.
 */
export interface ClientState {
	/** The underlying WebSocket connection handle. */
	ws: WsConn;
	/** The session this client is currently viewing (if any). */
	sessionId: string | undefined;
	/**
	 * Whether this client has completed bootstrap (received session_list).
	 * Until true, per-session events are buffered in `bootstrapQueue`.
	 */
	bootstrapped: boolean;
	/**
	 * Heartbeat liveness. New clients start alive; each heartbeat marks them
	 * stale before pinging, and the transport marks them alive again on pong.
	 */
	isAlive: boolean;
	/**
	 * Serialized JSON strings buffered during bootstrap.
	 * Flushed in order when `markClientBootstrapped` is called.
	 */
	bootstrapQueue: readonly string[];
}

// ─── Context Tag ────────────────────────────────────────────────────────────

/** Tag for the mutable client→ClientState HashMap Ref in the Effect Context. */
export class WsHandlerStateTag extends Context.Tag("WsHandlerState")<
	WsHandlerStateTag,
	Ref.Ref<HashMap.HashMap<string, ClientState>>
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

/**
 * Create a Layer providing WsHandlerStateTag backed by a Ref.
 *
 * @param initial - Optional initial HashMap. Defaults to empty.
 */
export const makeWsHandlerStateLive = (
	initial?: HashMap.HashMap<string, ClientState>,
): Layer.Layer<WsHandlerStateTag> =>
	Layer.effect(
		WsHandlerStateTag,
		Ref.make(initial ?? HashMap.empty<string, ClientState>()),
	);

// ─── Pure functions ─────────────────────────────────────────────────────────

/**
 * Register a new client connection.
 * Returns the new client count.
 */
export const addClient = (clientId: string, ws: WsConn) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		yield* Ref.update(ref, (map) =>
			HashMap.set(map, clientId, {
				ws,
				sessionId: undefined,
				bootstrapped: false,
				isAlive: true,
				bootstrapQueue: [],
			}),
		);
		const map = yield* Ref.get(ref);
		return HashMap.size(map);
	}).pipe(Effect.annotateLogs("clientId", clientId));

/** Mark a client alive after receiving a WebSocket pong. */
export const markClientAlive = (clientId: string) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		yield* Ref.update(ref, (map) => {
			const entry = HashMap.get(map, clientId);
			if (Option.isNone(entry)) return map;
			return HashMap.set(map, clientId, {
				...entry.value,
				isAlive: true,
			});
		});
	}).pipe(Effect.annotateLogs("clientId", clientId));

/** Close all tracked clients and clear handler state. */
export const closeAllClients = (code = 1001, reason = "Server shutting down") =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const map = yield* Ref.get(ref);
		for (const [_clientId, state] of map) {
			yield* Effect.sync(() => state.ws.close(code, reason)).pipe(
				Effect.catchAll(() => Effect.void),
			);
		}
		yield* Ref.set(ref, HashMap.empty<string, ClientState>());
	});

/**
 * Remove a client connection and clean up all per-client state.
 * Returns the session the client was viewing (Option), plus new client count.
 */
export const removeClient = (clientId: string) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const result = yield* Ref.modify(ref, (map) => {
			const entry = HashMap.get(map, clientId);
			const sessionId = Option.isSome(entry)
				? entry.value.sessionId
				: undefined;
			return [
				{
					sessionId,
					newCount: HashMap.size(map) - (Option.isSome(entry) ? 1 : 0),
				},
				HashMap.remove(map, clientId),
			] as const;
		});
		return result;
	}).pipe(Effect.annotateLogs("clientId", clientId));

/**
 * Safely send data to a WebSocket connection.
 * Returns true on success, false on failure (connection is NOT closed on failure
 * — that decision is left to the caller / heartbeat layer).
 */
export const safeSend = (ws: WsConn, data: string) =>
	Effect.try({
		try: () => {
			if (ws.readyState === WS_OPEN) {
				ws.send(data);
				return true;
			}
			return false;
		},
		catch: () => false,
	}).pipe(Effect.orElseSucceed(() => false));

/**
 * Broadcast a message to all connected clients.
 * Clients that fail to receive the message are silently skipped.
 */
export const broadcast = (message: RelayMessage) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const map = yield* Ref.get(ref);
		const data = JSON.stringify(message);
		for (const [_clientId, state] of map) {
			yield* safeSend(state.ws, data);
		}
	});

/**
 * Send a message to a specific client by ID.
 * No-op if the client doesn't exist or the connection is not open.
 */
export const sendTo = (clientId: string, message: RelayMessage) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const map = yield* Ref.get(ref);
		const entry = HashMap.get(map, clientId);
		if (Option.isSome(entry)) {
			yield* safeSend(entry.value.ws, JSON.stringify(message));
		}
	}).pipe(Effect.annotateLogs("clientId", clientId));

/**
 * Associate a client with a session (called on session switch / view_session).
 */
export const bindClientSession = (clientId: string, sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		yield* Ref.update(ref, (map) => {
			const entry = HashMap.get(map, clientId);
			if (Option.isNone(entry)) return map;
			if (entry.value.sessionId === sessionId) return map; // no-op
			return HashMap.set(map, clientId, {
				...entry.value,
				sessionId,
			});
		});
	}).pipe(Effect.annotateLogs("clientId", clientId));

/**
 * Get the session a client is currently viewing.
 * Returns Option<string>.
 */
export const getClientSession = (clientId: string) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const map = yield* Ref.get(ref);
		const entry = HashMap.get(map, clientId);
		return Option.flatMap(entry, (e) =>
			e.sessionId !== undefined ? Option.some(e.sessionId) : Option.none(),
		);
	});

/**
 * Get all client IDs viewing a specific session.
 * Only returns clients that are currently registered (no stale entries).
 */
export const getSessionViewers = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const map = yield* Ref.get(ref);
		const result: string[] = [];
		for (const [clientId, state] of map) {
			if (state.sessionId === sessionId) result.push(clientId);
		}
		return result;
	});

/**
 * Send a message to all clients viewing a specific session.
 * (Status-only, viewer-scoped sends.)
 */
export const sendToSession = (sessionId: string, message: RelayMessage) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const map = yield* Ref.get(ref);
		const data = JSON.stringify(message);
		for (const [_clientId, state] of map) {
			if (state.sessionId === sessionId) {
				yield* safeSend(state.ws, data);
			}
		}
	});

/**
 * Phase 0b: project-scoped per-session event firehose.
 *
 * Delivers message to every client connected to this handler. Clients that
 * have NOT yet been marked as bootstrapped have the event buffered in their
 * bootstrapQueue (preserving order). Bootstrapped clients receive immediately.
 *
 * @param _sessionId - Retained for logging/telemetry; routing is by project.
 */
export const broadcastPerSessionEvent = (
	_sessionId: string,
	message: RelayMessage,
) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		const data = JSON.stringify(message);
		// Snapshot the map, then update buffered clients and send to ready ones
		const map = yield* Ref.get(ref);
		// Collect clients that need buffering
		const updates: Array<[string, ClientState]> = [];
		for (const [clientId, state] of map) {
			if (!state.bootstrapped) {
				// Buffer the serialized message
				updates.push([
					clientId,
					{
						...state,
						bootstrapQueue: [...state.bootstrapQueue, data],
					},
				]);
			} else {
				yield* safeSend(state.ws, data);
			}
		}
		// Apply buffer updates atomically
		if (updates.length > 0) {
			yield* Ref.update(ref, (m) => {
				let updated = m;
				for (const [clientId, newState] of updates) {
					updated = HashMap.set(updated, clientId, newState);
				}
				return updated;
			});
		}
	});

/**
 * Phase 0b: mark a client as having completed its initial handshake.
 *
 * Called AFTER the initial session_list has been sent. Flushes any
 * per-session events buffered in the client's bootstrapQueue, preserving
 * the order they were produced.
 *
 * Idempotent — calling twice is a no-op.
 */
export const markClientBootstrapped = (clientId: string) =>
	Effect.gen(function* () {
		const ref = yield* WsHandlerStateTag;
		// Extract the client's queued messages and mark bootstrapped in one update
		const queued = yield* Ref.modify(ref, (map) => {
			const entry = HashMap.get(map, clientId);
			if (Option.isNone(entry)) return [[] as readonly string[], map] as const;
			if (entry.value.bootstrapped)
				return [[] as readonly string[], map] as const; // idempotent
			const queue = entry.value.bootstrapQueue;
			const updated = HashMap.set(map, clientId, {
				...entry.value,
				bootstrapped: true,
				bootstrapQueue: [], // clear the queue
			});
			return [queue, updated] as const;
		});
		// Flush the queued messages in order
		if (queued.length > 0) {
			const map = yield* Ref.get(ref);
			const entry = HashMap.get(map, clientId);
			if (Option.isSome(entry) && entry.value.ws.readyState === WS_OPEN) {
				for (const data of queued) {
					yield* safeSend(entry.value.ws, data);
				}
			}
		}
	}).pipe(Effect.annotateLogs("clientId", clientId));

/**
 * Get the current number of connected clients.
 */
export const getClientCount = Effect.gen(function* () {
	const ref = yield* WsHandlerStateTag;
	const map = yield* Ref.get(ref);
	return HashMap.size(map);
});

/**
 * Get all connected client IDs.
 */
export const getClientIds = Effect.gen(function* () {
	const ref = yield* WsHandlerStateTag;
	const map = yield* Ref.get(ref);
	const result: string[] = [];
	for (const [clientId] of map) {
		result.push(clientId);
	}
	return result;
});
