import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Cause, Effect, Exit, Fiber, Runtime } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { RawData, WebSocket } from "ws";
import {
	makeHeartbeatFiber,
	type WsTransport,
	WsTransportTag,
} from "../domain/relay/Layers/ws-transport-layer.js";
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
import type { RelayMessage } from "../shared-types.js";
import type {
	WebSocketHandlerShape,
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
	maxPayload?: number;
	server?: Server;
	pathPrefix?: string;
	verifyClient?: (
		info: { origin: string; secure: boolean; req: IncomingMessage },
		callback: (result: boolean, code?: number, message?: string) => void,
	) => void;
}

type WsBridgeServices = WsHandlerStateTag | WsTransportTag;

type WsRunFork = <A, E>(
	effect: Effect.Effect<A, E, WsBridgeServices>,
) => RuntimeFiber<A, E>;

interface EffectWsHandlerRuntime {
	readonly transport: WsTransport;
	readonly runFork: WsRunFork;
}

export const makeEffectWsHandler = (
	options: EffectWsHandlerOptions = {},
): Effect.Effect<EffectWsHandler, never, WsBridgeServices> =>
	Effect.gen(function* () {
		const transport = yield* WsTransportTag;
		const runtime = yield* Effect.runtime<WsBridgeServices>();
		return new EffectWsHandler(options, {
			transport,
			runFork: Runtime.runFork(runtime),
		});
	});

export class EffectWsHandler implements WebSocketHandlerShape {
	private readonly events = new EventEmitter();
	private readonly transport: WsTransport;
	private readonly runFork: WsRunFork;
	private readonly heartbeatFiber: RuntimeFiber<unknown, never>;
	private readonly clients = new Set<string>();
	private readonly clientSessions = new Map<string, string>();
	private readonly sessionClients = new Map<string, Set<string>>();
	private readonly upgradeListener?: (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => void;
	private closed = false;

	constructor(
		private readonly options: EffectWsHandlerOptions = {},
		runtime: EffectWsHandlerRuntime,
	) {
		this.transport = runtime.transport;
		this.runFork = runtime.runFork;
		this.transport.wss.on("connection", (ws, req) =>
			this.onConnection(ws, req),
		);
		if (options.server) {
			this.upgradeListener = (req, socket, head) => {
				if (!this.matchesPath(req.url)) return;
				this.verifyUpgrade(req, socket, (allowed) => {
					if (!allowed) {
						socket.destroy();
						return;
					}
					this.handleUpgrade(req, socket, head);
				});
			};
			options.server.on("upgrade", this.upgradeListener);
		}
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
		this.forkLogged("broadcast", broadcast(msg));
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

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		this.forkLogged(
			"handleUpgrade",
			this.transport.handleUpgrade(req, socket, head).pipe(
				Effect.catchAll((err) =>
					Effect.sync(() => {
						socket.destroy(err instanceof Error ? err : undefined);
					}),
				),
			),
		);
	}

	close(): void {
		void this.drain();
	}

	async drain(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.options.server && this.upgradeListener) {
			this.options.server.off("upgrade", this.upgradeListener);
		}
		this.clearClientMirror();
		await this.runEffectPromise(
			"drain",
			closeAllClients().pipe(
				Effect.zipRight(Fiber.interrupt(this.heartbeatFiber)),
			),
		);
	}

	private onConnection(ws: WebSocket, req: IncomingMessage): void {
		const clientId =
			extractRequestedClientId(req.url) ?? randomBytes(8).toString("hex");
		const requestedSessionId = extractRequestedSessionId(req.url);

		ws.on("message", (data: RawData) => this.onMessage(clientId, data));
		ws.on("close", () => this.onClose(clientId));
		ws.on("error", (err: Error) => {
			this.events.emit("client_error", { clientId, error: err });
		});
		ws.on("pong", () => {
			this.forkLogged("markClientAlive", markClientAlive(clientId));
		});

		this.forkLogged(
			"addClient",
			addClient(clientId, ws).pipe(
				Effect.tap((clientCount) =>
					Effect.sync(() => {
						this.recordClientConnected(clientId);
						this.events.emit("client_connected", {
							clientId,
							clientCount,
							...(requestedSessionId != null && { requestedSessionId }),
						});
					}),
				),
				Effect.flatMap((clientCount) =>
					broadcast(createClientCountMessage(clientCount)),
				),
			),
		);
	}

	private matchesPath(url: string | undefined): boolean {
		if (!this.options.pathPrefix) return true;
		return Boolean(
			url === `${this.options.pathPrefix}/ws` ||
				url?.startsWith(`${this.options.pathPrefix}/ws?`),
		);
	}

	private verifyUpgrade(
		req: IncomingMessage,
		socket: Duplex,
		callback: (allowed: boolean) => void,
	): void {
		if (!this.options.verifyClient) {
			callback(true);
			return;
		}
		this.options.verifyClient(
			{
				origin:
					typeof req.headers.origin === "string" ? req.headers.origin : "",
				secure: Boolean((socket as Duplex & { encrypted?: boolean }).encrypted),
				req,
			},
			(result) => callback(result),
		);
	}

	private onClose(clientId: string): void {
		if (this.closed) return;
		this.forkLogged(
			"removeClient",
			removeClient(clientId).pipe(
				Effect.tap(({ sessionId, newCount }) =>
					Effect.sync(() => {
						this.recordClientRemoved(clientId);
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

function extractRequestedSessionId(
	url: string | undefined,
): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url, "http://localhost");
		return parsed.searchParams.get("session") ?? undefined;
	} catch {
		return undefined;
	}
}

function extractRequestedClientId(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url, "http://localhost");
		const clientId = parsed.searchParams.get("client") ?? undefined;
		if (!clientId) return undefined;
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) return undefined;
		return clientId;
	} catch {
		return undefined;
	}
}
