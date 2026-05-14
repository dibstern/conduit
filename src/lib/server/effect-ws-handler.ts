import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { RawData, WebSocket } from "ws";
import {
	makeHeartbeatFiber,
	makeWsTransportLive,
	type WsTransport,
	WsTransportTag,
} from "../domain/relay/Layers/ws-transport-layer.js";
import {
	addClient,
	bindClientSession,
	broadcast,
	broadcastPerSessionEvent,
	closeAllClients,
	getClientCount,
	getClientIds,
	getClientSession,
	getSessionViewers,
	makeWsHandlerStateLive,
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

export class EffectWsHandler implements WebSocketHandlerShape {
	private readonly events = new EventEmitter();
	private readonly runtime: ManagedRuntime.ManagedRuntime<
		WsBridgeServices,
		never
	>;
	private readonly transport: WsTransport;
	private readonly heartbeatFiber: RuntimeFiber<never, unknown>;
	private readonly upgradeListener?: (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => void;
	private closed = false;

	constructor(private readonly options: EffectWsHandlerOptions = {}) {
		this.runtime = ManagedRuntime.make(
			Layer.mergeAll(
				makeWsHandlerStateLive(),
				makeWsTransportLive({
					noServer: true,
					...(options.maxPayload != null && {
						maxPayload: options.maxPayload,
					}),
				}),
			),
		);
		this.transport = this.runtime.runSync(
			Effect.gen(function* () {
				return yield* WsTransportTag;
			}),
		);
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
		this.heartbeatFiber = this.runtime.runFork(
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
		this.runMutation("broadcast", broadcast(msg));
	}

	sendTo(clientId: string, msg: RelayMessage): void {
		this.runMutation("sendTo", sendTo(clientId, msg));
	}

	setClientSession(clientId: string, sessionId: string): void {
		this.runSyncMutation(
			"setClientSession",
			bindClientSession(clientId, sessionId),
		);
	}

	getClientSession(clientId: string): string | undefined {
		const session = this.runtime.runSync(getClientSession(clientId));
		return Option.getOrUndefined(session);
	}

	getClientsForSession(sessionId: string): string[] {
		return this.runtime.runSync(getSessionViewers(sessionId));
	}

	sendToSession(sessionId: string, msg: RelayMessage): void {
		this.runMutation("sendToSession", sendToSession(sessionId, msg));
	}

	broadcastPerSessionEvent(sessionId: string, msg: RelayMessage): void {
		this.runMutation(
			"broadcastPerSessionEvent",
			broadcastPerSessionEvent(sessionId, msg),
		);
	}

	markClientBootstrapped(clientId: string): void {
		this.runMutation(
			"markClientBootstrapped",
			markClientBootstrapped(clientId),
		);
	}

	getClientCount(): number {
		return this.runtime.runSync(getClientCount);
	}

	getClientIds(): string[] {
		return this.runtime.runSync(getClientIds);
	}

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		this.runtime
			.runPromise(this.transport.handleUpgrade(req, socket, head))
			.catch((err) => {
				socket.destroy(err instanceof Error ? err : undefined);
			});
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
		await this.runtime.runPromise(closeAllClients());
		await this.runtime.runPromise(Fiber.interrupt(this.heartbeatFiber));
		await this.runtime.dispose();
	}

	private onConnection(ws: WebSocket, req: IncomingMessage): void {
		const clientId = randomBytes(8).toString("hex");
		const requestedSessionId = extractRequestedSessionId(req.url);

		ws.on("message", (data: RawData) => this.onMessage(clientId, data));
		ws.on("close", () => this.onClose(clientId));
		ws.on("error", (err: Error) => {
			this.events.emit("client_error", { clientId, error: err });
		});
		ws.on("pong", () => {
			this.runMutation("markClientAlive", markClientAlive(clientId));
		});

		this.runtime
			.runPromise(addClient(clientId, ws))
			.then((clientCount) => {
				this.events.emit("client_connected", {
					clientId,
					clientCount,
					...(requestedSessionId != null && { requestedSessionId }),
				});
				this.broadcast(createClientCountMessage(clientCount));
			})
			.catch(this.logBridgeError("addClient"));
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
		this.runtime
			.runPromise(removeClient(clientId))
			.then(({ sessionId, newCount }) => {
				this.events.emit("client_disconnected", {
					clientId,
					clientCount: newCount,
					...(sessionId != null ? { sessionId } : {}),
				});
				this.broadcast(createClientCountMessage(newCount));
			})
			.catch(this.logBridgeError("removeClient"));
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

	private runMutation<A, E, R extends WsBridgeServices>(
		op: string,
		effect: Effect.Effect<A, E, R>,
	): void {
		this.runtime.runPromise(effect).catch(this.logBridgeError(op));
	}

	private runSyncMutation<A, E, R extends WsBridgeServices>(
		op: string,
		effect: Effect.Effect<A, E, R>,
	): void {
		try {
			this.runtime.runSync(effect);
		} catch (err) {
			this.logBridgeError(op)(err);
		}
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
