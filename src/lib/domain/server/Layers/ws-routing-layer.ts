// ─── WebSocket Routing Layer ────────────────────────────────────────────────
// Scoped Layer that owns daemon WebSocket upgrade routing.

import { randomBytes } from "node:crypto";
import type http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import {
	Context,
	Data,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Runtime,
} from "effect";
import { WebSocket } from "ws";
import { WsRpcError } from "../../../contracts/ws-rpc.js";
import { getClientIp, parseCookies } from "../../../server/http-utils.js";
import {
	makeRoutedWsRpcWebSocketHandler,
	type RpcWebSocketHandlerShape,
} from "../../../server/ws-rpc-handler.js";
import { DaemonWsRpcHandlersTag } from "../../daemon/Layers/daemon-ws-rpc-layer.js";
import { HttpServerRefTag } from "../../daemon/Layers/relay-factory-layer.js";
import { ConfigPersistenceTag } from "../../daemon/Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../../daemon/Services/daemon-config-ref.js";
import { DaemonEventBusTag } from "../../daemon/Services/daemon-pubsub.js";
import { resolveDaemonSession } from "../../daemon/Services/daemon-session-reader.js";
import { DaemonWsClientRegistryTag } from "../../daemon/Services/daemon-ws-client-registry.js";
import {
	allProjects,
	getProject,
	markError,
	markReady,
	ProjectRegistryTag,
	touchLastUsed as touchProjectLastUsed,
} from "../../daemon/Services/project-registry-service.js";
import {
	type Relay,
	RelayCacheTag,
} from "../../daemon/Services/relay-cache.js";
import { type AuthManagerService, AuthManagerTag } from "./auth-middleware.js";

const PROJECT_WS_PATTERN = /^\/p\/([^/]+)\/(ws|rpc)(?:\?|$)/;
const RELAY_WAIT_TIMEOUT_MS = 10_000;
const SERVICE_UNAVAILABLE_RESPONSE = "HTTP/1.1 503 Service Unavailable\r\n\r\n";

export interface WebSocketRelay {
	readonly attach: Relay["attach"];
	readonly wsHandler: {
		readonly handleUpgrade: (
			req: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => void;
	};
	readonly rpcWsHandler: Pick<
		RpcWebSocketHandlerShape,
		"handleUpgrade" | "context"
	>;
}

export class WebSocketUpgradeError extends Data.TaggedError(
	"WebSocketUpgradeError",
)<{
	readonly reason:
		| "invalid_path"
		| "auth_failed"
		| "relay_unavailable"
		| "daemon_shutting_down"
		| "server_unavailable";
	readonly slug?: string;
	readonly url?: string;
	readonly cause?: unknown;
}> {
	get message(): string {
		const slug = this.slug ? ` for "${this.slug}"` : "";
		const detail = this.cause instanceof Error ? `: ${this.cause.message}` : "";
		return `WebSocket upgrade ${this.reason}${slug}${detail}`;
	}
}

export interface WebSocketRelayRouter {
	readonly ensureRelayStarted: (
		slug: string,
	) => Effect.Effect<void, WebSocketUpgradeError>;
	readonly waitForRelay: (
		slug: string,
		timeoutMs: number,
	) => Effect.Effect<WebSocketRelay, WebSocketUpgradeError>;
	readonly touchLastUsed: (
		slug: string,
	) => Effect.Effect<void, WebSocketUpgradeError>;
}

export class WebSocketRelayRouterTag extends Context.Tag(
	"WebSocketRelayRouter",
)<WebSocketRelayRouterTag, WebSocketRelayRouter>() {}

const toRelayUnavailable = (slug: string, cause: unknown) =>
	new WebSocketUpgradeError({
		reason: "relay_unavailable",
		slug,
		cause,
	});

export const WebSocketRelayRouterLive: Layer.Layer<
	WebSocketRelayRouterTag,
	never,
	RelayCacheTag | ProjectRegistryTag | DaemonEventBusTag | ConfigPersistenceTag
> = Layer.effect(
	WebSocketRelayRouterTag,
	Effect.gen(function* () {
		const relayCache = yield* RelayCacheTag;
		const projectRegistry = yield* ProjectRegistryTag;
		const eventBus = yield* DaemonEventBusTag;
		const configPersistence = yield* ConfigPersistenceTag;

		const withProjectRegistry = <A, E>(
			effect: Effect.Effect<
				A,
				E,
				ProjectRegistryTag | DaemonEventBusTag | ConfigPersistenceTag
			>,
		) =>
			effect.pipe(
				Effect.provideService(ProjectRegistryTag, projectRegistry),
				Effect.provideService(DaemonEventBusTag, eventBus),
				Effect.provideService(ConfigPersistenceTag, configPersistence),
			);

		const failRelayUnavailable = (slug: string, cause: unknown) =>
			withProjectRegistry(markError(slug, formatCause(cause))).pipe(
				Effect.catchAll(() => Effect.void),
				Effect.zipRight(Effect.fail(toRelayUnavailable(slug, cause))),
			);

		const loadRelay = (slug: string) =>
			withProjectRegistry(getProject(slug)).pipe(
				Effect.flatMap(() => relayCache.get(slug)),
				Effect.tap(() => withProjectRegistry(markReady(slug))),
				Effect.catchAll((cause) => failRelayUnavailable(slug, cause)),
				Effect.catchAllDefect((cause) => failRelayUnavailable(slug, cause)),
			);

		return {
			ensureRelayStarted: (slug) => loadRelay(slug).pipe(Effect.asVoid),
			waitForRelay: (slug, timeoutMs) =>
				loadRelay(slug).pipe(
					Effect.timeoutFail({
						duration: Duration.millis(timeoutMs),
						onTimeout: () =>
							toRelayUnavailable(
								slug,
								new Error("Timed out waiting for relay"),
							),
					}),
					Effect.catchAll((cause) =>
						Effect.fail(
							cause instanceof WebSocketUpgradeError
								? cause
								: toRelayUnavailable(slug, cause),
						),
					),
					Effect.catchAllDefect((cause) =>
						Effect.fail(toRelayUnavailable(slug, cause)),
					),
				),
			touchLastUsed: (slug) =>
				withProjectRegistry(touchProjectLastUsed(slug)).pipe(
					Effect.catchAll((cause) =>
						Effect.fail(toRelayUnavailable(slug, cause)),
					),
				),
		} satisfies WebSocketRelayRouter;
	}),
);

const destroySocket = (socket: net.Socket) =>
	Effect.sync(() => {
		if (!socket.destroyed) socket.destroy();
	});

const writeServiceUnavailable = (socket: net.Socket) =>
	Effect.sync(() => {
		if (socket.destroyed) return;
		if (socket.writable) socket.write(SERVICE_UNAVAILABLE_RESPONSE);
		socket.destroy();
	});

const formatCause = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const authenticateUpgrade = (
	auth: AuthManagerService,
	req: http.IncomingMessage,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const hasPin = yield* auth.hasPin();
		if (!hasPin) return true;

		const cookies = parseCookies(req.headers.cookie ?? "");
		const sessionCookie = cookies["relay_session"] ?? "";
		if (sessionCookie && (yield* auth.validateCookie(sessionCookie))) {
			return true;
		}

		const pinHeader = req.headers["x-relay-pin"];
		if (typeof pinHeader !== "string") return false;

		const result = yield* auth.authenticate(pinHeader, getClientIp(req));
		return result.ok;
	});

const handleFailure = (error: WebSocketUpgradeError, socket: net.Socket) =>
	Effect.gen(function* () {
		if (error.reason === "relay_unavailable") {
			yield* Effect.logWarning("WS upgrade rejected: relay unavailable", {
				slug: error.slug,
				error: error.cause == null ? error.message : formatCause(error.cause),
			});
			yield* writeServiceUnavailable(socket);
			return;
		}

		const log =
			error.reason === "invalid_path" || error.reason === "daemon_shutting_down"
				? Effect.logDebug
				: Effect.logWarning;
		yield* log("WS upgrade rejected", {
			reason: error.reason,
			slug: error.slug,
			url: error.url,
		});
		yield* destroySocket(socket);
	});

// ─── WebSocketRoutingLive ──────────────────────────────────────────────────

/**
 * Scoped Layer that attaches the WebSocket upgrade handler to the HTTP server.
 *
 * The handler authenticates requests, lazy-starts relays, waits for relay
 * readiness, and hands off to the relay's WS handler on success.
 *
 * Finalizer removes the upgrade listener to prevent leaks in tests.
 */
export const WebSocketRoutingLive: Layer.Layer<
	never,
	never,
	| DaemonConfigRefTag
	| HttpServerRefTag
	| AuthManagerTag
	| WebSocketRelayRouterTag
	| DaemonWsRpcHandlersTag
	| DaemonWsClientRegistryTag
	| ProjectRegistryTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const httpServerRef = yield* HttpServerRefTag;
		const auth = yield* AuthManagerTag;
		const relayRouter = yield* WebSocketRelayRouterTag;
		const daemonHandlers = yield* DaemonWsRpcHandlersTag;
		const daemonWsClients = yield* DaemonWsClientRegistryTag;
		const projectRegistry = yield* ProjectRegistryTag;
		const runtime = yield* Effect.runtime<never>();
		const scope = yield* Effect.scope;
		const server = yield* Ref.get(httpServerRef);

		if (server === null) {
			return yield* Effect.die(
				new WebSocketUpgradeError({ reason: "server_unavailable" }),
			);
		}

		const resolveRelay = (slug: string) =>
			Effect.gen(function* () {
				yield* relayRouter.ensureRelayStarted(slug);
				const relay = yield* relayRouter.waitForRelay(
					slug,
					RELAY_WAIT_TIMEOUT_MS,
				);
				yield* relayRouter.touchLastUsed(slug);
				return relay;
			});

		const toRpcUnavailable = (slug: string, cause: unknown) =>
			new WsRpcError({
				message: `Project "${slug}" unavailable: ${formatCause(cause)}`,
			});

		const resolveRpcRelay = (slug: string) =>
			resolveRelay(slug).pipe(
				Effect.mapError((cause) => toRpcUnavailable(slug, cause)),
				Effect.catchAllDefect((cause) =>
					Effect.fail(toRpcUnavailable(slug, cause)),
				),
			);

		const reattachViewSession = (payload: {
			readonly projectSlug: string;
			readonly sessionId: string;
			readonly originId: string;
		}) =>
			Effect.gen(function* () {
				const current = yield* daemonWsClients.get(payload.originId);
				if (
					Option.isNone(current) ||
					current.value.slug === payload.projectSlug
				) {
					return false;
				}
				const relay = yield* resolveRpcRelay(payload.projectSlug);
				const latest = yield* daemonWsClients.get(payload.originId);
				if (
					Option.isNone(latest) ||
					latest.value.slug === payload.projectSlug ||
					latest.value.ws.readyState !== WebSocket.OPEN
				) {
					return false;
				}

				latest.value.detach();
				const detached = yield* daemonWsClients.setAttachment(
					payload.originId,
					latest.value.ws,
					null,
					() => {},
				);
				if (!detached) return false;
				yield* Effect.try({
					try: () =>
						latest.value.ws.send(
							JSON.stringify({
								type: "project_attached",
								slug: payload.projectSlug,
							}),
						),
					catch: (cause) => toRpcUnavailable(payload.projectSlug, cause),
				});
				const detach = yield* Effect.try({
					try: () =>
						relay.attach(latest.value.ws, {
							clientId: payload.originId,
							requestedSessionId: payload.sessionId,
						}),
					catch: (cause) => toRpcUnavailable(payload.projectSlug, cause),
				});
				const attached = yield* daemonWsClients.setAttachment(
					payload.originId,
					latest.value.ws,
					payload.projectSlug,
					detach,
				);
				if (!attached) detach();
				return attached;
			});

		const rpcHandler = yield* makeRoutedWsRpcWebSocketHandler(
			(slug) =>
				resolveRpcRelay(slug)
					.pipe(
						Effect.flatMap((relay) => {
							if (!relay.rpcWsHandler.context) {
								return Effect.fail(new Error("RPC context unavailable"));
							}
							return relay.rpcWsHandler.context;
						}),
					)
					.pipe(
						Effect.catchAll((cause) =>
							Effect.fail(
								cause instanceof WsRpcError
									? cause
									: toRpcUnavailable(slug, cause),
							),
						),
						Effect.catchAllDefect((cause) =>
							Effect.fail(toRpcUnavailable(slug, cause)),
						),
					),
			daemonHandlers,
			undefined,
			reattachViewSession,
		);

		const attachDaemonSocket = (ws: WebSocket, req: http.IncomingMessage) =>
			Effect.gen(function* () {
				const params = new URL(req.url ?? "/ws", "http://localhost")
					.searchParams;
				const requestedClientId = params.get("client") ?? "";
				const clientId = /^[A-Za-z0-9._:-]{1,128}$/.test(requestedClientId)
					? requestedClientId
					: randomBytes(8).toString("hex");
				const requestedSessionId = params.get("session") || undefined;
				const requestedProjectSlug = params.get("p") || undefined;
				const onError = (error: Error) => {
					Runtime.runCallback(runtime)(
						Effect.logWarning("Daemon websocket error", {
							clientId,
							error: error.message,
						}),
					);
				};

				yield* daemonWsClients.register(clientId, ws);
				yield* Effect.sync(() => {
					ws.on("error", onError);
					ws.once("close", () => {
						ws.off("error", onError);
						Runtime.runCallback(runtime)(daemonWsClients.remove(clientId, ws));
					});
				});
				if (ws.readyState !== WebSocket.OPEN) {
					yield* daemonWsClients.remove(clientId, ws);
					return;
				}

				const projects = yield* allProjects.pipe(
					Effect.provideService(ProjectRegistryTag, projectRegistry),
				);
				const sessionSlug = requestedSessionId
					? yield* resolveDaemonSession(requestedSessionId).pipe(
							Effect.provideService(ProjectRegistryTag, projectRegistry),
						)
					: null;
				const slug =
					sessionSlug ??
					projects.find((project) => project.slug === requestedProjectSlug)
						?.slug ??
					projects[0]?.slug ??
					null;
				if (slug === null) return;

				const relay = yield* Effect.option(resolveRelay(slug));
				if (Option.isNone(relay) || ws.readyState !== WebSocket.OPEN) return;
				const current = yield* daemonWsClients.get(clientId);
				if (
					Option.isNone(current) ||
					current.value.ws !== ws ||
					current.value.slug !== null
				)
					return;
				yield* Effect.try(() =>
					ws.send(JSON.stringify({ type: "project_attached", slug })),
				);
				const detach = relay.value.attach(ws, {
					clientId,
					...(requestedSessionId != null && { requestedSessionId }),
				});
				const attached = yield* daemonWsClients.setAttachment(
					clientId,
					ws,
					slug,
					detach,
				);
				if (!attached) detach();
			}).pipe(
				Effect.catchAll((cause) =>
					Effect.logWarning("Daemon websocket remains unattached", { cause }),
				),
				Effect.catchAllDefect((cause) =>
					Effect.logWarning("Daemon websocket remains unattached", { cause }),
				),
			);

		const onDaemonConnection = (ws: WebSocket, req: http.IncomingMessage) => {
			Runtime.runFork(runtime)(
				Effect.forkIn(attachDaemonSocket(ws, req), scope),
			);
		};
		daemonWsClients.server.on("connection", onDaemonConnection);

		const routeUpgrade = (
			req: http.IncomingMessage,
			socket: net.Socket,
			head: Buffer,
		) =>
			Effect.gen(function* () {
				const isSharedRpc = req.url === "/rpc" || req.url?.startsWith("/rpc?");
				const isSharedWs = req.url === "/ws" || req.url?.startsWith("/ws?");
				const match = req.url?.match(PROJECT_WS_PATTERN);
				if (!isSharedRpc && !isSharedWs && !match) {
					return yield* new WebSocketUpgradeError({
						reason: "invalid_path",
						url: req.url ?? "",
					});
				}

				const slug = match?.[1];
				if (
					!isSharedRpc &&
					!isSharedWs &&
					(slug === undefined || slug.length === 0)
				) {
					return yield* new WebSocketUpgradeError({
						reason: "invalid_path",
						url: req.url ?? "",
					});
				}

				if (!(yield* authenticateUpgrade(auth, req))) {
					return yield* new WebSocketUpgradeError({
						reason: "auth_failed",
						...(slug === undefined ? {} : { slug }),
						url: req.url ?? "",
					});
				}

				const config = yield* Ref.get(configRef);
				if (socket.destroyed || config.shuttingDown) {
					return yield* new WebSocketUpgradeError({
						reason: "daemon_shutting_down",
						...(slug === undefined ? {} : { slug }),
						url: req.url ?? "",
					});
				}

				if (isSharedRpc) {
					yield* Effect.sync(() => rpcHandler.handleUpgrade(req, socket, head));
					return;
				}
				if (isSharedWs) {
					yield* Effect.try({
						try: () =>
							daemonWsClients.server.handleUpgrade(req, socket, head, (ws) =>
								daemonWsClients.server.emit("connection", ws, req),
							),
						catch: (cause) =>
							new WebSocketUpgradeError({
								reason: "server_unavailable",
								url: req.url ?? "",
								cause,
							}),
					});
					return;
				}
				if (slug === undefined) return;
				yield* relayRouter.ensureRelayStarted(slug);
				const relay = yield* relayRouter.waitForRelay(
					slug,
					RELAY_WAIT_TIMEOUT_MS,
				);
				if (socket.destroyed) {
					return yield* new WebSocketUpgradeError({
						reason: "daemon_shutting_down",
						slug,
						url: req.url ?? "",
					});
				}

				yield* Effect.logDebug("WS upgrade accepted", { slug });
				yield* relayRouter.touchLastUsed(slug);
				const endpoint = match?.[2] === "rpc" ? "rpc" : "ws";
				yield* Effect.try({
					try: () =>
						endpoint === "rpc"
							? relay.rpcWsHandler.handleUpgrade(req, socket, head)
							: relay.wsHandler.handleUpgrade(req, socket, head),
					catch: (cause) =>
						new WebSocketUpgradeError({
							reason: "relay_unavailable",
							slug,
							url: req.url ?? "",
							cause,
						}),
				});
			}).pipe(
				Effect.catchAll((error) => handleFailure(error, socket)),
				Effect.annotateLogs("component", "ws-routing"),
			);

		const onUpgrade = (
			req: http.IncomingMessage,
			socket: net.Socket,
			head: Buffer,
		) => {
			Runtime.runCallback(runtime)(routeUpgrade(req, socket, head), {
				onExit: (exit) => {
					if (Exit.isFailure(exit) && !socket.destroyed) socket.destroy();
				},
			});
		};

		server.on("upgrade", onUpgrade);
		yield* Effect.logInfo("WebSocket routing layer initialized");

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				server.off("upgrade", onUpgrade);
				daemonWsClients.server.off("connection", onDaemonConnection);
			}).pipe(
				Effect.zipRight(Effect.logInfo("WebSocket routing layer torn down")),
			),
		);
	}).pipe(
		Effect.annotateLogs("component", "ws-routing"),
		Effect.withSpan("WebSocketRoutingLive"),
	),
);
