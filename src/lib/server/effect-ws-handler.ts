import { EventEmitter } from "node:events";
import { Cause, Effect, Exit, Fiber, Runtime } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { RawData, WebSocket } from "ws";
import { makeHeartbeatFiber } from "../domain/relay/Layers/ws-transport-layer.js";
import {
	addClient,
	bindClientSession,
	broadcast,
	broadcastPerSessionEvent,
	closeAllClients,
	markClientAlive,
	markClientBootstrapped,
	removeClient,
	sendTo,
	sendToSession,
	type WsHandlerStateTag,
} from "../domain/relay/Services/ws-handler-service.js";
import { type RelayMessage, WS_PROTOCOL_VERSION } from "../shared-types.js";
import type {
	WebSocketHandlerShape,
	WsAttachOptions,
	WsClientConnectedEvent,
	WsClientDisconnectedEvent,
	WsMessageEvent,
} from "./ws-handler-shape.js";
import {
	createClientCountMessage,
	isRouteError,
	parseIncomingMessage,
	routeMessage,
} from "./ws-router.js";

type WsEventMap = {
	client_connected: WsClientConnectedEvent;
	client_disconnected: WsClientDisconnectedEvent;
	message: WsMessageEvent;
	client_error: { clientId: string; error: Error };
};

interface EffectWsHandlerOptions {
	heartbeatInterval?: number;
}

type WsBridgeServices = WsHandlerStateTag;

type WsRunFork = <A, E>(
	effect: Effect.Effect<A, E, WsBridgeServices>,
) => RuntimeFiber<A, E>;

interface EffectWsHandlerRuntime {
	readonly runFork: WsRunFork;
}

export const makeEffectWsHandler = (
	options: EffectWsHandlerOptions = {},
): Effect.Effect<EffectWsHandler, never, WsBridgeServices> =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<WsBridgeServices>();
		return new EffectWsHandler(options, {
			runFork: Runtime.runFork(runtime),
		});
	});

export class EffectWsHandler implements WebSocketHandlerShape {
	private readonly events = new EventEmitter();
	private readonly runFork: WsRunFork;
	private readonly heartbeatFiber: RuntimeFiber<unknown, never>;
	private readonly clients = new Set<string>();
	private readonly clientSessions = new Map<string, string>();
	private readonly sessionClients = new Map<string, Set<string>>();
	private closed = false;

	constructor(
		options: EffectWsHandlerOptions = {},
		runtime: EffectWsHandlerRuntime,
	) {
		this.runFork = runtime.runFork;
		this.heartbeatFiber = this.forkLogged(
			"heartbeat",
			makeHeartbeatFiber(options.heartbeatInterval ?? 30_000),
		);
	}

	on<K extends keyof WsEventMap>(
		event: K,
		cb: (data: WsEventMap[K]) => void,
	): void {
		this.events.on(event, cb);
	}

	once<K extends keyof WsEventMap>(
		event: K,
		cb: (data: WsEventMap[K]) => void,
	): void {
		this.events.once(event, cb);
	}

	broadcast(msg: RelayMessage): void {
		const clientIds = this.getClientIds();
		this.forkLogged(
			"broadcast",
			Effect.forEach(clientIds, (clientId) => sendTo(clientId, msg), {
				discard: true,
			}),
		);
	}

	sendTo(clientId: string, msg: RelayMessage): void {
		this.forkLogged("sendTo", sendTo(clientId, msg));
	}

	setClientSession(clientId: string, sessionId: string): void {
		this.recordClientSession(clientId, sessionId);
		this.forkLogged("setClientSession", bindClientSession(clientId, sessionId));
	}

	getClientSession(clientId: string): string | undefined {
		return this.clientSessions.get(clientId);
	}

	getClientsForSession(sessionId: string): string[] {
		return [...(this.sessionClients.get(sessionId) ?? [])];
	}

	sendToSession(sessionId: string, msg: RelayMessage): void {
		this.forkLogged("sendToSession", sendToSession(sessionId, msg));
	}

	broadcastPerSessionEvent(sessionId: string, msg: RelayMessage): void {
		this.forkLogged(
			"broadcastPerSessionEvent",
			broadcastPerSessionEvent(sessionId, msg),
		);
	}

	markClientBootstrapped(clientId: string): void {
		this.forkLogged("markClientBootstrapped", markClientBootstrapped(clientId));
	}

	getClientCount(): number {
		return this.clients.size;
	}

	getClientIds(): string[] {
		return [...this.clients];
	}

	attach(ws: WebSocket, options: WsAttachOptions): () => void {
		if (this.closed) {
			ws.close(1001, "Server shutting down");
			return () => {};
		}
		const { clientId, requestedSessionId, skipDefaultSession } = options;
		let attached = true;
		// In-flight effects can retain this connection after detach removes the
		// client from the relay. Revoke their access before another relay attaches.
		const connection = {
			get readyState() {
				return attached ? ws.readyState : ws.CLOSED;
			},
			send(data: string) {
				if (attached) ws.send(data);
			},
			close(code?: number, reason?: string) {
				if (attached) ws.close(code, reason);
			},
			ping() {
				if (attached) ws.ping();
			},
			terminate() {
				if (attached) ws.terminate();
			},
		};
		const onMessage = (data: RawData) => this.onMessage(clientId, data);
		const onError = (error: Error) => {
			this.events.emit("client_error", { clientId, error });
		};
		const onPong = () => {
			this.forkLogged("markClientAlive", markClientAlive(clientId));
		};
		const detach = () => {
			if (!attached) return;
			attached = false;
			ws.off("message", onMessage);
			ws.off("close", detach);
			ws.off("error", onError);
			ws.off("pong", onPong);
			this.recordClientRemoved(clientId);
			this.removeAttachedClient(clientId);
		};

		ws.on("message", onMessage);
		ws.on("close", detach);
		ws.on("error", onError);
		ws.on("pong", onPong);

		this.forkLogged(
			"addClient",
			Effect.suspend(() =>
				attached ? addClient(clientId, connection) : Effect.interrupt,
			).pipe(
				// Version first: client_connected listeners start the session-init
				// flood, and the mismatch check must not trail it.
				Effect.tap(() =>
					sendTo(clientId, {
						type: "protocol_version",
						version: WS_PROTOCOL_VERSION,
					}),
				),
				Effect.tap((clientCount) =>
					Effect.sync(() => {
						this.recordClientConnected(clientId);
						this.events.emit("client_connected", {
							clientId,
							clientCount,
							...(requestedSessionId != null && { requestedSessionId }),
							...(skipDefaultSession != null && { skipDefaultSession }),
						});
					}),
				),
				Effect.flatMap((clientCount) =>
					broadcast(createClientCountMessage(clientCount)),
				),
			),
		);

		return detach;
	}

	close(): void {
		void this.drain();
	}

	async drain(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.clearClientMirror();
		await this.runEffectPromise(
			"drain",
			closeAllClients().pipe(
				Effect.zipRight(Fiber.interrupt(this.heartbeatFiber)),
			),
		);
	}

	private removeAttachedClient(clientId: string): void {
		if (this.closed) return;
		this.forkLogged(
			"removeClient",
			removeClient(clientId).pipe(
				Effect.tap(({ sessionId, newCount }) =>
					Effect.sync(() => {
						this.events.emit("client_disconnected", {
							clientId,
							clientCount: newCount,
							...(sessionId != null ? { sessionId } : {}),
						});
					}),
				),
				Effect.flatMap(({ newCount }) =>
					broadcast(createClientCountMessage(newCount)),
				),
			),
		);
	}

	private onMessage(clientId: string, raw: RawData): void {
		if (this.closed) return;
		const parsed = parseIncomingMessage(raw.toString());
		if (!parsed) {
			this.sendTo(clientId, {
				type: "system_error",
				code: "PARSE_ERROR",
				message: "Could not parse message as JSON",
			});
			return;
		}

		const routed = routeMessage(parsed);
		if (isRouteError(routed)) {
			this.sendTo(clientId, {
				type: "system_error",
				code: routed.code,
				message: routed.message,
			});
			return;
		}

		this.events.emit("message", {
			clientId,
			handler: routed.handler,
			payload: routed.payload,
		});
	}

	private forkLogged<A, E>(
		op: string,
		effect: Effect.Effect<A, E, WsBridgeServices>,
	): RuntimeFiber<unknown, never> {
		return this.runFork(
			effect.pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() => this.logBridgeError(op)(Cause.pretty(cause))),
				),
			),
		);
	}

	private runEffectPromise<A, E>(
		op: string,
		effect: Effect.Effect<A, E, WsBridgeServices>,
	): Promise<void> {
		const fiber = this.forkLogged(op, effect);
		return new Promise((resolve, reject) => {
			fiber.addObserver((exit) => {
				if (Exit.isFailure(exit)) {
					reject(exit);
					return;
				}
				resolve();
			});
		});
	}

	private recordClientConnected(clientId: string): void {
		this.recordClientRemoved(clientId);
		this.clients.add(clientId);
	}

	private recordClientRemoved(clientId: string): void {
		this.clients.delete(clientId);
		const sessionId = this.clientSessions.get(clientId);
		if (sessionId == null) return;
		this.clientSessions.delete(clientId);
		const viewers = this.sessionClients.get(sessionId);
		if (!viewers) return;
		viewers.delete(clientId);
		if (viewers.size === 0) this.sessionClients.delete(sessionId);
	}

	private recordClientSession(clientId: string, sessionId: string): void {
		if (!this.clients.has(clientId)) return;
		const previous = this.clientSessions.get(clientId);
		if (previous === sessionId) return;
		if (previous != null) {
			const viewers = this.sessionClients.get(previous);
			viewers?.delete(clientId);
			if (viewers?.size === 0) this.sessionClients.delete(previous);
		}
		this.clientSessions.set(clientId, sessionId);
		const viewers = this.sessionClients.get(sessionId) ?? new Set<string>();
		viewers.add(clientId);
		this.sessionClients.set(sessionId, viewers);
	}

	private clearClientMirror(): void {
		this.clients.clear();
		this.clientSessions.clear();
		this.sessionClients.clear();
	}

	private logBridgeError(op: string) {
		return (err: unknown) => {
			if (this.closed) return;
			console.error(`[ws-bridge] ${op} failed:`, err);
		};
	}
}
