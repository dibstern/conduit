// Scoped Layer that owns daemon WebSocket upgrade routing.

import type http from "node:http";
import type net from "node:net";
import { Context, Data, Deferred, Effect, Exit, Layer, Ref } from "effect";
import { WsRpcError } from "../../../contracts/ws-rpc.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import {
	getClientIp,
	isOwnOrigin,
	parseCookies,
} from "../../../server/http-utils.js";
import type {
	RpcSubscriptionScopeTag,
	WsRpcServerLayer,
} from "../../../server/ws-rpc.js";
import { makeRoutedWsRpcWebSocketHandler } from "../../../server/ws-rpc-handler.js";
import { ShutdownSignalTag } from "../../daemon/Layers/daemon-layers.js";
import { DaemonWsRpcHandlersTag } from "../../daemon/Layers/daemon-ws-rpc-layer.js";
import type { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { ConfigPersistenceTag } from "../../daemon/Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../../daemon/Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../../daemon/Services/daemon-orchestration.js";
import { DaemonEventBusTag } from "../../daemon/Services/daemon-pubsub.js";
import {
	listArchivedSessions,
	listDaemonSessions,
} from "../../daemon/Services/daemon-session-reader.js";
import type { DaemonStateTag } from "../../daemon/Services/daemon-state.js";
import { persistenceStoreContext } from "../../daemon/Services/project-read-database.js";
import {
	getProject,
	markError,
	markReady,
	ProjectRegistryTag,
	touchLastUsed as touchProjectLastUsed,
} from "../../daemon/Services/project-registry-service.js";
import {
	type ProjectParts,
	ProjectServices,
} from "../../daemon/Services/project-services.js";
import { ProviderAdapters } from "../../daemon/Services/provider-adapters.js";
import { RelayCacheTag } from "../../daemon/Services/relay-cache.js";
import type { SessionActivityTag } from "../../daemon/Services/session-activity.js";
import type { SessionDirectory } from "../../daemon/Services/session-directory.js";
import type { Usage } from "../../daemon/Services/usage.js";
import type { UserAvatar } from "../../daemon/Services/user-avatar.js";
import type { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import type { RateLimiterTag } from "../../relay/Layers/rate-limiter-layer.js";
import type { AlertsTag } from "../../relay/Services/alerts.js";
import {
	DaemonSessionQueryServiceError,
	DaemonSessionQueryServiceTag,
} from "../../relay/Services/daemon-session-query-service.js";
import { DraftPreWarmTag } from "../../relay/Services/draft-prewarm.js";
import { InstanceManagementServiceLive } from "../../relay/Services/instance-management-service.js";
import { ProjectManagementServiceLive } from "../../relay/Services/project-management-service.js";
import { ScanServiceLive } from "../../relay/Services/scan-service.js";
import type { SessionManagerServiceTag } from "../../relay/Services/session-manager-service.js";
import { HttpServerRefTag } from "../Services/http-server-ref.js";
import { type AuthManagerService, AuthManagerTag } from "./auth-middleware.js";

export class WebSocketUpgradeError extends Data.TaggedError(
	"WebSocketUpgradeError",
)<{
	readonly reason:
		| "invalid_path"
		| "auth_failed"
		| "foreign_origin"
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
	readonly touchLastUsed: (
		slug: string,
	) => Effect.Effect<void, WebSocketUpgradeError>;
}

export class WebSocketRelayRouterTag extends Context.Service<
	WebSocketRelayRouterTag,
	WebSocketRelayRouter
>()("WebSocketRelayRouter") {}

/**
 * Each project's RPC context, built by the daemon from the project's own
 * services (82tn.16). A call names its project as t3code's commands name their
 * thread (Orchestrator.ts:1910); its streams end with the project's generation,
 * so replacing a relay leaves a tab's streams running.
 */
export class ProjectRpcContextsTag extends Context.Service<
	ProjectRpcContextsTag,
	(
		projectSlug: string,
	) => Effect.Effect<
		Context.Context<
			| Layer.Services<typeof WsRpcServerLayer>
			| RpcSubscriptionScopeTag
			| ProjectParts
		>,
		WsRpcError
	>
>()("ProjectRpcContexts") {}

export const ProjectRpcContextsLive = Layer.effect(
	ProjectRpcContextsTag,
	Effect.gen(function* () {
		const relayRouter = yield* WebSocketRelayRouterTag;
		const projects = yield* ProjectServices;
		const { registry } = yield* ProviderAdapters;
		const { drafts } = yield* DaemonOrchestration;
		const store = Context.merge(
			yield* Effect.context<
				ProjectRegistryTag | AccountDirectory | SessionActivityTag
			>(),
			yield* persistenceStoreContext,
		);
		const queryError = (cause: unknown) =>
			new DaemonSessionQueryServiceError({ cause });
		// Project, instance and scan RPCs are the daemon handlers'; these refuse.
		const refusing = yield* Layer.build(
			Layer.mergeAll(
				ProjectManagementServiceLive,
				InstanceManagementServiceLive,
				ScanServiceLive,
			),
		);
		const daemon = Context.merge(
			yield* Effect.context<
				| UserAvatar
				| DaemonConfigRefTag
				| ConfigPersistenceTag
				| Usage
				| WorktreeServiceTag
				| AlertsTag
				| RateLimiterTag
				| SessionManagerServiceTag
			>(),
			refusing,
		).pipe(
			Context.add(ProviderRegistryTag, registry),
			Context.add(DraftPreWarmTag, drafts),
			// Deleting a worktree asks which sessions in other projects still use it.
			Context.add(DaemonSessionQueryServiceTag, {
				list: (options) =>
					listDaemonSessions(options).pipe(
						Effect.provide(store),
						Effect.mapError(queryError),
					),
				listArchived: (options) =>
					listArchivedSessions(options).pipe(
						Effect.provide(store),
						Effect.mapError(queryError),
					),
			}),
		);
		const unavailable = (slug: string, cause: unknown) =>
			new WsRpcError({
				message: `Project "${slug}" unavailable: ${formatCause(cause)}`,
			});
		return (slug) =>
			Effect.gen(function* () {
				// The relay still wires the project's live provider events until S6.
				yield* relayRouter.ensureRelayStarted(slug);
				yield* relayRouter.touchLastUsed(slug);
				return Context.merge(daemon, yield* projects.forProject(slug));
			}).pipe(
				Effect.catch((cause) => Effect.fail(unavailable(slug, cause))),
				Effect.catchDefect((cause) => Effect.fail(unavailable(slug, cause))),
			);
	}),
);

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
				Effect.catch(() => Effect.void),
				Effect.andThen(Effect.fail(toRelayUnavailable(slug, cause))),
			);

		const loadRelay = (slug: string) =>
			withProjectRegistry(getProject(slug)).pipe(
				Effect.flatMap(() => relayCache.get(slug)),
				Effect.tap(() => withProjectRegistry(markReady(slug))),
				Effect.catch((cause) => failRelayUnavailable(slug, cause)),
				Effect.catchDefect((cause) => failRelayUnavailable(slug, cause)),
			);

		return {
			ensureRelayStarted: (slug) => loadRelay(slug).pipe(Effect.asVoid),
			touchLastUsed: (slug) =>
				withProjectRegistry(touchProjectLastUsed(slug)).pipe(
					Effect.catch((cause) => Effect.fail(toRelayUnavailable(slug, cause))),
				),
		} satisfies WebSocketRelayRouter;
	}),
);

const destroySocket = (socket: net.Socket) =>
	Effect.sync(() => {
		if (!socket.destroyed) socket.destroy();
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

		const result = yield* auth.authenticate(
			pinHeader,
			getClientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]),
		);
		return result.ok;
	});

const handleFailure = (
	error: WebSocketUpgradeError,
	req: http.IncomingMessage,
	socket: net.Socket,
) =>
	Effect.gen(function* () {
		const log =
			error.reason === "invalid_path" || error.reason === "daemon_shutting_down"
				? Effect.logDebug
				: Effect.logWarning;
		yield* log("WS upgrade rejected", {
			reason: error.reason,
			slug: error.slug,
			url: error.url,
			// A client that never shows the PIN page redials forever; this names it.
			remoteAddress: req.socket.remoteAddress,
			userAgent: req.headers["user-agent"],
		});
		yield* destroySocket(socket);
	});

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
	| ProjectRpcContextsTag
	| DaemonWsRpcHandlersTag
	| ProjectRegistryTag
	| DaemonStateTag
	| ShutdownSignalTag
	| SessionDirectory
> = Layer.effectDiscard(
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const httpServerRef = yield* HttpServerRefTag;
		const auth = yield* AuthManagerTag;
		const resolveRpcContext = yield* ProjectRpcContextsTag;
		const daemonHandlers = yield* DaemonWsRpcHandlersTag;
		const shutdownSignal = yield* ShutdownSignalTag;
		const context = yield* Effect.context<never>();
		const server = yield* Ref.get(httpServerRef);

		if (server === null) {
			return yield* Effect.die(
				new WebSocketUpgradeError({ reason: "server_unavailable" }),
			);
		}

		const rpcHandler = yield* makeRoutedWsRpcWebSocketHandler(
			resolveRpcContext,
			daemonHandlers,
			undefined,
			(tag) =>
				Deferred.succeed(
					shutdownSignal,
					tag === "Shutdown" ? "stop" : "restart",
				).pipe(Effect.asVoid),
		);

		const routeUpgrade = (
			req: http.IncomingMessage,
			socket: net.Socket,
			head: Buffer,
		) =>
			Effect.gen(function* () {
				const isSharedRpc = req.url === "/rpc" || req.url?.startsWith("/rpc?");
				if (!isSharedRpc) {
					return yield* new WebSocketUpgradeError({
						reason: "invalid_path",
						url: req.url ?? "",
					});
				}

				if (!isOwnOrigin(req.headers)) {
					return yield* new WebSocketUpgradeError({
						reason: "foreign_origin",
						url: req.url ?? "",
					});
				}

				if (!(yield* authenticateUpgrade(auth, req))) {
					return yield* new WebSocketUpgradeError({
						reason: "auth_failed",
						url: req.url ?? "",
					});
				}

				const config = yield* Ref.get(configRef);
				if (socket.destroyed || config.shuttingDown) {
					return yield* new WebSocketUpgradeError({
						reason: "daemon_shutting_down",
						url: req.url ?? "",
					});
				}

				yield* Effect.sync(() => rpcHandler.handleUpgrade(req, socket, head));
			}).pipe(
				Effect.catch((error) => handleFailure(error, req, socket)),
				Effect.annotateLogs("component", "ws-routing"),
			);

		const onUpgrade = (
			req: http.IncomingMessage,
			socket: net.Socket,
			head: Buffer,
		) => {
			Effect.runCallbackWith(context)(routeUpgrade(req, socket, head), {
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
			}).pipe(
				Effect.andThen(Effect.logInfo("WebSocket routing layer torn down")),
			),
		);
	}).pipe(
		Effect.annotateLogs("component", "ws-routing"),
		Effect.withSpan("WebSocketRoutingLive"),
	),
);
