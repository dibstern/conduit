import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Socket, SocketServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import type { ManagedRuntime } from "effect";
import { Cause, Context, Effect, Layer, Option, Runtime } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { WebSocket } from "ws";
import {
	type OnSuccessfulShutdownResponse,
	withRpcShutdownResponse,
} from "../daemon/daemon-rpc-server.js";
import {
	makeWsTransportLive,
	type WsTransport,
	WsTransportTag,
} from "../domain/relay/Layers/ws-transport-layer.js";
import { isRecord } from "../utils.js";
import { getClientIp } from "./http-utils.js";
import {
	type AttachDaemonProject,
	BrowserRpcConnectionsTag,
	type DaemonRpcHandlers,
	makeRoutedWsRpcServerLayer,
	type ResolveRpcContext,
	RpcCaller,
	RpcPinChangeResponse,
	type RpcSubscriptionScopeTag,
	WsRpcGroup,
	WsRpcServerLayer,
} from "./ws-rpc.js";

const RPC_CONNECTION_CONCURRENCY = 32;
// Private WebSocket code: the PIN changed; reconnect and authenticate again.
const RPC_PIN_CHANGED_CLOSE_CODE = 4001;

type RpcWebSocketHandlerOptions = (
	| { readonly runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> }
	| {
			readonly context: Effect.Effect<
				Context.Context<
					Layer.Layer.Context<typeof WsRpcServerLayer> | RpcSubscriptionScopeTag
				>,
				unknown
			>;
			readonly runFork: (
				effect: Effect.Effect<
					void,
					never,
					Layer.Layer.Context<typeof WsRpcServerLayer>
				>,
			) => void;
	  }
) & { readonly maxPayload?: number };

type RpcTransportRunFork = <A, E>(
	effect: Effect.Effect<A, E, WsTransportTag>,
) => RuntimeFiber<A, E>;

interface RpcWebSocketHandlerRuntime {
	readonly transport: WsTransport;
	readonly runTransportFork: RpcTransportRunFork;
	readonly runConnection: (ws: WebSocket, ip: string) => void;
}

export interface RpcWebSocketHandlerShape {
	readonly context?: Effect.Effect<
		Context.Context<
			Layer.Layer.Context<typeof WsRpcServerLayer> | RpcSubscriptionScopeTag
		>,
		unknown
	>;
	readonly handleUpgrade: (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => void;
	readonly drain: () => Promise<void>;
}

const runRpcWebSocketConnection = <R>(
	ws: WebSocket,
	ip: string,
	serverLayer: Layer.Layer<
		Layer.Layer.Success<typeof WsRpcServerLayer>,
		never,
		R
	>,
	onSuccessfulShutdownResponse?: OnSuccessfulShutdownResponse,
	browserConnections?: Set<() => void>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const pendingPinChanges = new Map<string, () => void>();
			const invalidate = () =>
				ws.close(RPC_PIN_CHANGED_CLOSE_CODE, "PIN changed");
			browserConnections?.add(invalidate);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					browserConnections?.delete(invalidate);
					// A committed change must revoke other sockets even if its caller left.
					for (const revoke of pendingPinChanges.values()) revoke();
					pendingPinChanges.clear();
				}),
			);
			// The `ws` package is EventTarget-compatible at runtime, but its
			// types are narrower than the browser WebSocket type expected here.
			const socket = yield* Socket.fromWebSocket(
				Effect.succeed(ws as unknown as globalThis.WebSocket),
			);
			const socketServer = SocketServer.SocketServer.of({
				address: { _tag: "TcpAddress", hostname: "websocket", port: 0 },
				run: (handler) =>
					handler(socket).pipe(Effect.orDie, Effect.zipRight(Effect.never)),
			});
			const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
				Effect.provideService(SocketServer.SocketServer, socketServer),
				Effect.provide(RpcSerialization.layerJson),
			);
			const pinChangeProtocol: RpcServer.Protocol["Type"] = {
				...protocol,
				run: (handle) =>
					protocol.run((clientId, message) => {
						if (message._tag === "Request" && message.tag === "SetPin") {
							return handle(clientId, message).pipe(
								Effect.provideService(RpcPinChangeResponse, (revoke) => {
									pendingPinChanges.set(message.id, revoke);
								}),
							);
						}
						return handle(clientId, message);
					}),
				send: (clientId, response, transferables) =>
					protocol.send(clientId, response, transferables).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								if (response._tag !== "Exit") return;
								const revoke = pendingPinChanges.get(response.requestId);
								pendingPinChanges.delete(response.requestId);
								revoke?.();
							}),
						),
					),
			};

			// RpcServer.make runs the protocol loop until interrupted, so it has
			// to be forked. The scope then stays open only while the client is
			// connected; closing it tears the RPC server down. Before this the
			// fiber lived forever and every reconnect leaked one.
			yield* RpcServer.make(WsRpcGroup, {
				concurrency: RPC_CONNECTION_CONCURRENCY,
			}).pipe(
				Effect.provideService(
					RpcServer.Protocol,
					onSuccessfulShutdownResponse
						? withRpcShutdownResponse(
								pinChangeProtocol,
								onSuccessfulShutdownResponse,
							)
						: pinChangeProtocol,
				),
				Effect.provide(serverLayer),
				Effect.interruptible,
				Effect.forkScoped,
			);
			yield* Effect.async<void>((resume) => {
				if (ws.readyState === ws.CLOSED) {
					resume(Effect.void);
					return;
				}
				ws.once("close", () => resume(Effect.void));
			});
		}),
	).pipe(Effect.provideService(RpcCaller, { kind: "browser", ip }));

export const makeWsRpcWebSocketHandler = (
	options: RpcWebSocketHandlerOptions,
): Effect.Effect<WsRpcWebSocketHandler, never, WsTransportTag> =>
	Effect.gen(function* () {
		const transport = yield* WsTransportTag;
		const browserConnections = yield* Effect.serviceOption(
			BrowserRpcConnectionsTag,
		);
		const runtime = yield* Effect.runtime<WsTransportTag>();
		return new WsRpcWebSocketHandler(
			"runtime" in options
				? Effect.suspend(() =>
						Effect.map(options.runtime.runtimeEffect, (value) => value.context),
					)
				: options.context,
			{
				transport,
				runTransportFork: Runtime.runFork(runtime),
				runConnection: (ws, ip) => {
					const connection = runRpcWebSocketConnection(
						ws,
						ip,
						WsRpcServerLayer,
						undefined,
						Option.getOrUndefined(browserConnections),
					);
					if ("runtime" in options) options.runtime.runFork(connection);
					else options.runFork(connection);
				},
			},
		);
	});

export class RoutedWsRpcWebSocketHandlerTag extends Context.Tag(
	"RoutedWsRpcWebSocketHandler",
)<RoutedWsRpcWebSocketHandlerTag, RpcWebSocketHandlerShape>() {}

export const makeRoutedWsRpcWebSocketHandler = (
	resolveContext: ResolveRpcContext,
	daemonHandlers?: DaemonRpcHandlers,
	defaultProjectSlug?: string,
	onSuccessfulShutdownResponse?: OnSuccessfulShutdownResponse,
	attachProject?: AttachDaemonProject,
) =>
	Effect.gen(function* () {
		const browserConnections = yield* Effect.serviceOption(
			BrowserRpcConnectionsTag,
		);
		const transportContext = yield* Layer.build(
			makeWsTransportLive({ noServer: true }),
		);
		const runtime = yield* Effect.runtime<WsTransportTag>().pipe(
			Effect.provide(transportContext),
		);
		const scope = yield* Effect.scope;
		const serverLayer = makeRoutedWsRpcServerLayer(
			resolveContext,
			daemonHandlers,
			defaultProjectSlug,
			attachProject,
		);
		const handler = new WsRpcWebSocketHandler(undefined, {
			transport: Context.get(transportContext, WsTransportTag),
			runTransportFork: Runtime.runFork(runtime),
			runConnection: (ws, ip) =>
				Runtime.runFork(runtime)(
					Effect.forkIn(
						runRpcWebSocketConnection(
							ws,
							ip,
							serverLayer,
							onSuccessfulShutdownResponse,
							Option.getOrUndefined(browserConnections),
						),
						scope,
					),
				),
		});
		yield* Effect.addFinalizer(() =>
			Effect.tryPromise({
				try: () => handler.drain(),
				catch: (cause) => cause,
			}).pipe(Effect.orDie),
		);
		return handler;
	});

export class WsRpcWebSocketHandler implements RpcWebSocketHandlerShape {
	readonly context?: Effect.Effect<
		Context.Context<
			Layer.Layer.Context<typeof WsRpcServerLayer> | RpcSubscriptionScopeTag
		>,
		unknown
	>;
	private readonly runConnection: (ws: WebSocket, ip: string) => void;
	private readonly transport: WsTransport;
	private readonly runTransportFork: RpcTransportRunFork;
	private readonly clients = new Set<WebSocket>();
	private closed = false;

	constructor(
		context: RpcWebSocketHandlerShape["context"],
		runtime: RpcWebSocketHandlerRuntime,
	) {
		if (context) this.context = context;
		this.runConnection = runtime.runConnection;
		this.transport = runtime.transport;
		this.runTransportFork = runtime.runTransportFork;
		this.transport.wss.on("connection", (ws, req) =>
			this.onConnection(ws, req),
		);
	}

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		this.forkTransport(
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

	async drain(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const ws of this.clients) {
			ws.close();
		}
		this.clients.clear();
	}

	private onConnection(ws: WebSocket, req: IncomingMessage): void {
		this.clients.add(ws);
		ws.on("close", () => this.clients.delete(ws));
		if (
			process.env["NODE_ENV"] === "test" &&
			process.send &&
			process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"]
		) {
			ws.on("message", (data) => {
				const at = process.hrtime.bigint().toString();
				let frames: unknown;
				try {
					frames = JSON.parse(data.toString());
				} catch {
					return;
				}
				const values: unknown[] = Array.isArray(frames) ? frames : [frames];
				for (const frame of values) {
					if (
						isRecord(frame) &&
						frame["_tag"] === "Request" &&
						frame["tag"] === "input.submit" &&
						isRecord(frame["payload"]) &&
						typeof frame["payload"]["text"] === "string"
					) {
						process.send?.({
							channel: "conduit-process-test",
							kind: "receipt",
							prompt: frame["payload"]["text"],
							at,
						});
					}
				}
			});
		}
		this.runConnection(
			ws,
			getClientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]),
		);
	}

	private forkTransport<A, E>(
		op: string,
		effect: Effect.Effect<A, E, WsTransportTag>,
	): RuntimeFiber<unknown, never> {
		return this.runTransportFork(
			effect.pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() =>
						console.error(`[ws-rpc-bridge] ${op} failed:`, Cause.pretty(cause)),
					),
				),
			),
		);
	}
}
