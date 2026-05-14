// ─── WebSocket Routing Layer ────────────────────────────────────────────────
// Scoped Layer that owns daemon WebSocket upgrade routing.

import type http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { Context, Data, Duration, Effect, Layer, Ref, Runtime } from "effect";
import { getClientIp, parseCookies } from "../../../server/http-utils.js";
import { HttpServerRefTag } from "../../daemon/Layers/relay-factory-layer.js";
import { ConfigPersistenceTag } from "../../daemon/Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../../daemon/Services/daemon-config-ref.js";
import { DaemonEventBusTag } from "../../daemon/Services/daemon-pubsub.js";
import {
	getProject,
	markError,
	markReady,
	ProjectRegistryTag,
	touchLastUsed as touchProjectLastUsed,
} from "../../daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../daemon/Services/relay-cache.js";
import { type AuthManagerService, AuthManagerTag } from "./auth-middleware.js";

const PROJECT_WS_PATTERN = /^\/p\/([^/]+)\/(ws|rpc)(?:\?|$)/;
const RELAY_WAIT_TIMEOUT_MS = 10_000;
const SERVICE_UNAVAILABLE_RESPONSE = "HTTP/1.1 503 Service Unavailable\r\n\r\n";

export interface WebSocketRelay {
	readonly wsHandler: {
		readonly handleUpgrade: (
			req: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => void;
	};
	readonly rpcWsHandler: {
		readonly handleUpgrade: (
			req: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => void;
	};
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
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const httpServerRef = yield* HttpServerRefTag;
		const auth = yield* AuthManagerTag;
		const relayRouter = yield* WebSocketRelayRouterTag;
		const runtime = yield* Effect.runtime<never>();
		const server = yield* Ref.get(httpServerRef);

		if (server === null) {
			return yield* Effect.die(
				new WebSocketUpgradeError({ reason: "server_unavailable" }),
			);
		}

		const routeUpgrade = (
			req: http.IncomingMessage,
			socket: net.Socket,
			head: Buffer,
		) =>
			Effect.gen(function* () {
				const match = req.url?.match(PROJECT_WS_PATTERN);
				if (!match) {
					return yield* new WebSocketUpgradeError({
						reason: "invalid_path",
						url: req.url ?? "",
					});
				}

				const slug = match[1];
				if (slug === undefined || slug.length === 0) {
					return yield* new WebSocketUpgradeError({
						reason: "invalid_path",
						url: req.url ?? "",
					});
				}

				if (!(yield* authenticateUpgrade(auth, req))) {
					return yield* new WebSocketUpgradeError({
						reason: "auth_failed",
						slug,
						url: req.url ?? "",
					});
				}

				const config = yield* Ref.get(configRef);
				if (socket.destroyed || config.shuttingDown) {
					return yield* new WebSocketUpgradeError({
						reason: "daemon_shutting_down",
						slug,
						url: req.url ?? "",
					});
				}

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
				const endpoint = match[2] === "rpc" ? "rpc" : "ws";
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

		const runUpgrade = Runtime.runPromise(runtime);
		const onUpgrade = (
			req: http.IncomingMessage,
			socket: net.Socket,
			head: Buffer,
		) => {
			void runUpgrade(routeUpgrade(req, socket, head)).catch(() => {
				if (!socket.destroyed) socket.destroy();
			});
		};

		server.on("upgrade", onUpgrade);
		yield* Effect.logInfo("WebSocket routing layer initialized");

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => server.off("upgrade", onUpgrade)).pipe(
				Effect.zipRight(Effect.logInfo("WebSocket routing layer torn down")),
			),
		);
	}).pipe(
		Effect.annotateLogs("component", "ws-routing"),
		Effect.withSpan("WebSocketRoutingLive"),
	),
);
