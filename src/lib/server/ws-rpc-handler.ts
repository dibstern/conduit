import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { Socket, SocketServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Statement } from "@effect/sql";
import type { ManagedRuntime, Schema } from "effect";
import {
	Cause,
	Context,
	Effect,
	FiberRef,
	Layer,
	Option,
	Runtime,
	Tracer,
} from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { WebSocket } from "ws";
import {
	type OnSuccessfulShutdownResponse,
	withRpcShutdownResponse,
} from "../daemon/daemon-rpc-server.js";
import { SessionDirectory } from "../domain/daemon/Services/session-directory.js";
import {
	observeTurnTimelineSocketWrite,
	turnTimelineAwaitsSocketWrite,
} from "../domain/daemon/Services/turn-timeline.js";
import {
	makeWsTransportLive,
	type WsTransport,
	WsTransportTag,
} from "../domain/relay/Layers/ws-transport-layer.js";
import { ENV } from "../env.js";
import { isRecord } from "../utils.js";
import { getClientIp, isLoopbackAddress } from "./http-utils.js";
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

interface SlowRpcRequest {
	readonly method: string;
	readonly requestId: string;
	readonly projectSlug?: string;
	readonly sessionId?: string;
	readonly receivedAt: number;
	readonly kind: "request" | "stream-startup";
	startedAt?: number;
	sqlCount: number;
	sqlMs: number;
	finished: boolean;
}

const requestSqlStats = FiberRef.unsafeMake<SlowRpcRequest | undefined>(
	undefined,
);

const containsInterrupt = (
	cause: Schema.CauseEncoded<unknown, unknown>,
): boolean =>
	cause._tag === "Interrupt" ||
	((cause._tag === "Sequential" || cause._tag === "Parallel") &&
		(containsInterrupt(cause.left) || containsInterrupt(cause.right)));

export const withSlowRpcLogging = (
	protocol: RpcServer.Protocol["Type"],
	thresholdMs = ENV.slowRpcMs,
): RpcServer.Protocol["Type"] => {
	if (thresholdMs === 0) return protocol;
	const pending = new Map<string, SlowRpcRequest>();
	const finish = (key: string, outcome: "success" | "failure" | "interrupt") =>
		Effect.suspend(() => {
			const request = pending.get(key);
			if (!request) return Effect.void;
			pending.delete(key);
			request.finished = true;
			const endedAt = performance.now();
			const totalMs = endedAt - request.receivedAt;
			if (totalMs < thresholdMs) return Effect.void;
			return Effect.logWarning("slow rpc").pipe(
				Effect.annotateLogs({
					method: request.method,
					requestId: request.requestId,
					...(request.projectSlug !== undefined && {
						projectSlug: request.projectSlug,
					}),
					...(request.sessionId !== undefined && {
						sessionId: request.sessionId,
					}),
					totalMs,
					queuedMs: (request.startedAt ?? endedAt) - request.receivedAt,
					sqlCount: request.sqlCount,
					sqlMs: request.sqlMs,
					outcome,
					kind: request.kind,
				}),
			);
		});
	return {
		...protocol,
		run: (handle) =>
			protocol
				.run((clientId, message) => {
					if (
						message._tag !== "Request" ||
						typeof message.tag !== "string" ||
						typeof message.id !== "string"
					)
						return handle(clientId, message);
					const payload = isRecord(message.payload) ? message.payload : {};
					const request: SlowRpcRequest = {
						method: message.tag,
						requestId: message.id,
						...(typeof payload["projectSlug"] === "string" && {
							projectSlug: payload["projectSlug"],
						}),
						...(typeof payload["sessionId"] === "string" && {
							sessionId: payload["sessionId"],
						}),
						receivedAt: performance.now(),
						kind: message.tag.startsWith("Subscribe")
							? "stream-startup"
							: "request",
						sqlCount: 0,
						sqlMs: 0,
						finished: false,
					};
					pending.set(`${clientId}:${message.id}`, request);
					return Effect.gen(function* () {
						const previous = yield* FiberRef.get(Statement.currentTransformer);
						return yield* Effect.tracerWith((upstream) =>
							handle(clientId, message).pipe(
								Effect.withTracer(
									Tracer.make({
										span(...args) {
											// RpcServer creates this span after acquiring its concurrency permit.
											if (
												args[0] === `RpcServer.${message.tag}` &&
												request.startedAt === undefined
											)
												request.startedAt = performance.now();
											return upstream.span(...args);
										},
										context: (f, fiber) => upstream.context(f, fiber),
									}),
								),
								// A request-local FiberRef survives stream context replacement and shares counters only with child fibers.
								Effect.locally(requestSqlStats, request),
								Statement.withTransformer((statement, sql, refs, span) =>
									Effect.gen(function* () {
										const stats = yield* FiberRef.get(requestSqlStats);
										if (stats && !stats.finished) {
											const end = span.end.bind(span);
											span.end = (endTime, exit) => {
												const status = span.status;
												if (!stats.finished && status._tag === "Started") {
													stats.sqlCount++;
													stats.sqlMs +=
														Number(endTime - status.startTime) / 1_000_000;
												}
												end(endTime, exit);
											};
										}
										return Option.isSome(previous)
											? yield* previous.value(statement, sql, refs, span)
											: statement;
									}),
								),
							),
						);
					});
				})
				.pipe(
					Effect.ensuring(
						Effect.suspend(() =>
							Effect.forEach(
								pending.keys(),
								(key) => finish(key, "interrupt"),
								{ discard: true },
							),
						),
					),
				),
		send: (clientId, response, transferables) =>
			protocol.send(clientId, response, transferables).pipe(
				Effect.tap(() => {
					if (response._tag === "Defect") {
						return Effect.flatMap(FiberRef.get(requestSqlStats), (request) =>
							request
								? finish(`${clientId}:${request.requestId}`, "failure")
								: Effect.void,
						);
					}
					if (response._tag !== "Chunk" && response._tag !== "Exit")
						return Effect.void;
					return finish(
						`${clientId}:${response.requestId}`,
						response._tag === "Chunk" || response.exit._tag === "Success"
							? "success"
							: containsInterrupt(response.exit.cause)
								? "interrupt"
								: "failure",
					);
				}),
			),
	};
};

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
	readonly runConnection: (ws: WebSocket, ip: string, secure?: boolean) => void;
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
	secure = false,
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
			// Protocol sends can be no-ops after disconnect, so measure native writes.
			const originalSend = ws.send;
			const send = originalSend.bind(ws);
			ws.send = (
				data: Parameters<WebSocket["send"]>[0],
				options?: Parameters<WebSocket["send"]>[1] | ((error?: Error) => void),
				callback?: (error?: Error) => void,
			) => {
				// Idle tracing keeps the native send path: no callback per frame.
				if (!turnTimelineAwaitsSocketWrite()) {
					Reflect.apply(originalSend, ws, [data, options, callback]);
					return;
				}
				const complete = (error?: Error) => {
					if (
						!error &&
						(typeof data === "string" || data instanceof Uint8Array)
					)
						observeTurnTimelineSocketWrite(data);
					(typeof options === "function" ? options : callback)?.(error);
				};
				if (typeof options === "object") send(data, options, complete);
				else send(data, complete);
			};
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					ws.send = originalSend;
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
			const requestProtocol = withSlowRpcLogging(pinChangeProtocol);

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
								requestProtocol,
								onSuccessfulShutdownResponse,
							)
						: requestProtocol,
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
	).pipe(Effect.provideService(RpcCaller, { kind: "browser", ip, secure }));

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
				runConnection: (ws, ip, secure) => {
					const connection = runRpcWebSocketConnection(
						ws,
						ip,
						WsRpcServerLayer,
						undefined,
						Option.getOrUndefined(browserConnections),
						secure,
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
		const directory = yield* SessionDirectory;
		const serverLayer = makeRoutedWsRpcServerLayer(
			resolveContext,
			daemonHandlers,
			defaultProjectSlug,
			attachProject,
		).pipe(Layer.provide(Layer.succeed(SessionDirectory, directory)));
		const handler = new WsRpcWebSocketHandler(undefined, {
			transport: Context.get(transportContext, WsTransportTag),
			runTransportFork: Runtime.runFork(runtime),
			runConnection: (ws, ip, secure) =>
				Runtime.runFork(runtime)(
					Effect.forkIn(
						runRpcWebSocketConnection(
							ws,
							ip,
							serverLayer,
							onSuccessfulShutdownResponse,
							Option.getOrUndefined(browserConnections),
							secure,
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
	private readonly runConnection: (
		ws: WebSocket,
		ip: string,
		secure?: boolean,
	) => void;
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
			(req.socket instanceof TLSSocket && req.socket.encrypted) ||
				(isLoopbackAddress(req.socket.remoteAddress) &&
					req.headers["x-forwarded-proto"] === "https"),
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
