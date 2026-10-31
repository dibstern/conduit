// Effect-based HTTP router using @effect/platform. This is the production HTTP
// route graph for both daemon and relay server modes; Node's request callback
// only delegates into the handler built from this router.
//
// Routes:
//   GET  /health, /api/status     — health check
//   GET  /info                    — version info
//   GET  /api/projects            — liveness probe (daemon lifecycle and HTTP router tests)
//   GET  /p/:slug/attachments/:hash — authenticated immutable attachment bytes
//   GET  /api/push/vapid-key      — VAPID public key
//   POST /api/push/subscribe      — push subscription
//   POST /api/push/unsubscribe    — push unsubscription
//   GET  /api/setup-info          — setup/onboarding info
//   GET  /ca/download             — CA certificate download
//   GET  /auth, /setup, /, /s/*, /p/* — SPA/static entry routes

import { readFile } from "node:fs/promises";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpBodyError } from "effect/http/HttpBody";
import {
	AuthManagerTag,
	authRoute,
	authStatusRoute,
	withAuthGate,
} from "../domain/server/Layers/auth-middleware.js";
import { serveStaticFile } from "../domain/server/Services/static-file-handler.js";
import type { AttachmentStore } from "../persistence/attachment-store.js";
import type {
	ApiError,
	DashboardProjectResponse,
	HealthResponse,
	InfoResponse,
	ProjectStatusResponse,
	ProjectsListResponse,
	PushOkResponse,
	SetupInfoResponse,
	VapidKeyResponse,
} from "../shared-types.js";
import { getVersion } from "../version.js";
import { SERVER_BUILD_ID } from "./build-update.js";

// Service Tags (dependency injection)
// Each tag represents a capability the router needs. Concrete implementations
// are provided via Effect Layers when the router is wired into the server.

/** Project data provider — returns the current project list. */
export interface RouterProjectInfo {
	slug: string;
	folders: readonly [string, ...string[]];
	title: string;
	status?: "registering" | "ready" | "error";
	error?: string;
	clients?: number;
	sessions?: number;
	isProcessing?: boolean;
}

export class ProjectsProvider extends Context.Service<
	ProjectsProvider,
	{ readonly getProjects: () => Effect.Effect<RouterProjectInfo[]> }
>()("ProjectsProvider") {}

export type HttpAttachmentReader = (
	slug: string,
	hash: string,
) => ReturnType<AttachmentStore["get"]>;

export class AttachmentsProvider extends Context.Service<
	AttachmentsProvider,
	{ readonly read: HttpAttachmentReader }
>()("AttachmentsProvider") {}

/** Health response provider — optionally overridden by daemon mode. */
export class HealthProvider extends Context.Service<
	HealthProvider,
	{ readonly getHealthResponse: () => Effect.Effect<object> }
>()("HealthProvider") {}

/** Push notification manager — may not be available. */
export class PushProvider extends Context.Service<
	PushProvider,
	{
		readonly getPublicKey: () => string | undefined;
		readonly addSubscription: (endpoint: string, subscription: unknown) => void;
		readonly removeSubscription: (endpoint: string) => void;
	}
>()("PushProvider") {}

/** CA certificate provider — may not be available. */
export class CaCertProvider extends Context.Service<
	CaCertProvider,
	{
		readonly caCertDer: Buffer | undefined;
		readonly caRootPath: string | undefined;
	}
>()("CaCertProvider") {}

/** Setup info provider — exposes server connectivity details. */
export class SetupInfoProvider extends Context.Service<
	SetupInfoProvider,
	{
		readonly getPort: () => Effect.Effect<number>;
		readonly getIsTls: () => Effect.Effect<boolean>;
		/** The Tailscale Serve URL, or null when serve mode is off. */
		readonly getPublicUrl: () => Effect.Effect<string | null>;
	}
>()("SetupInfoProvider") {}

/** Standalone project API delegation provider — optional. */
export class ProjectApiDelegateProvider extends Context.Service<
	ProjectApiDelegateProvider,
	{
		readonly delegateApiRequest: (
			slug: string,
			subPath: string,
			req: HttpServerRequest.HttpServerRequest,
		) => Effect.Effect<HttpServerResponse.HttpServerResponse, Error>;
	}
>()("ProjectApiDelegateProvider") {}

function serializeProject(p: RouterProjectInfo): DashboardProjectResponse {
	return {
		slug: p.slug,
		path: p.folders[0],
		title: p.title || "",
		status: p.status ?? "ready",
		...(p.error != null && { error: p.error }),
		sessions: p.sessions ?? 0,
		clients: p.clients ?? 0,
		isProcessing: p.isProcessing ?? false,
	};
}

/** Build a JSON error response with the standard ApiError envelope. */
function jsonError(
	status: number,
	code: string,
	message: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBodyError> {
	return HttpServerResponse.json(
		{
			error: { code, message },
		} satisfies ApiError,
		{ status },
	);
}

const PushSubscribeBody = Schema.Struct({
	subscription: Schema.Struct({
		endpoint: Schema.String,
		keys: Schema.optional(
			Schema.Struct({
				p256dh: Schema.optional(Schema.String),
				auth: Schema.optional(Schema.String),
			}),
		),
	}),
});

const PushUnsubscribeBody = Schema.Struct({
	endpoint: Schema.String,
});

/** GET /health, GET /api/status */
const healthHandler = Effect.gen(function* () {
	const { getProjects } = yield* ProjectsProvider;
	// The standalone router omits daemon health details.
	const maybeHealth = yield* Effect.serviceOption(HealthProvider);

	const body = Option.isSome(maybeHealth)
		? yield* maybeHealth.value.getHealthResponse()
		: ({
				ok: true,
				projects: (yield* getProjects()).length,
				uptime: process.uptime(),
			} satisfies HealthResponse);

	return yield* HttpServerResponse.json(body);
});

/** GET /info; buildId lets a stale tab check the build without RPC. */
const infoHandler = Effect.gen(function* () {
	return yield* HttpServerResponse.json({
		version: getVersion(),
		buildId: SERVER_BUILD_ID,
	} satisfies InfoResponse);
});

/**
 * GET /api/projects remains only as a liveness probe. Callers are the daemon
 * lifecycle integration flow and the HTTP router/server unit tests; browser
 * project lists use daemon RPC.
 */
const projectsHandler = Effect.gen(function* () {
	const { getProjects } = yield* ProjectsProvider;
	const projects = yield* getProjects();

	return yield* HttpServerResponse.json({
		projects: projects.map(serializeProject),
		version: getVersion(),
	} satisfies ProjectsListResponse);
});

/** GET /api/push/vapid-key */
const vapidKeyHandler = Effect.gen(function* () {
	// PushProvider is omitted when push notifications are disabled.
	const maybePush = yield* Effect.serviceOption(PushProvider);

	if (Option.isSome(maybePush)) {
		const publicKey = maybePush.value.getPublicKey();
		if (publicKey) {
			return yield* HttpServerResponse.json({
				publicKey,
			} satisfies VapidKeyResponse);
		}
	}

	return yield* jsonError(
		404,
		"NOT_AVAILABLE",
		"Push notifications not available",
	);
});

/** POST /api/push/subscribe */
const pushSubscribeHandler = Effect.gen(function* () {
	// PushProvider is omitted when push notifications are disabled.
	const maybePush = yield* Effect.serviceOption(PushProvider);

	if (Option.isNone(maybePush)) {
		return yield* jsonError(
			404,
			"NOT_AVAILABLE",
			"Push notifications not available",
		);
	}

	const push = maybePush.value;
	const body = yield* HttpServerRequest.schemaBodyJson(PushSubscribeBody);

	push.addSubscription(body.subscription.endpoint, body.subscription);
	return yield* HttpServerResponse.json({ ok: true } satisfies PushOkResponse);
});

/** GET /ca/download */
const caDownloadHandler = Effect.gen(function* () {
	// The HTTP router omits CaCertProvider when no CA certificate exists.
	const maybeCa = yield* Effect.serviceOption(CaCertProvider);

	if (Option.isNone(maybeCa)) {
		return yield* jsonError(404, "NOT_FOUND", "No CA certificate available");
	}

	const ca = maybeCa.value;

	// Prefer DER-encoded .cer for iOS compatibility
	if (ca.caCertDer) {
		return HttpServerResponse.uint8Array(new Uint8Array(ca.caCertDer), {
			status: 200,
			headers: {
				"content-type": "application/x-x509-ca-cert",
				"content-disposition": 'attachment; filename="conduit-ca.cer"',
			},
		});
	}

	// Fallback to PEM from disk
	const caPath = ca.caRootPath;
	if (!caPath) {
		return yield* jsonError(404, "NOT_FOUND", "No CA certificate available");
	}

	const pem = yield* Effect.tryPromise({
		try: () => readFile(caPath),
		catch: () => new Error("Failed to read CA certificate"),
	});

	return HttpServerResponse.uint8Array(new Uint8Array(pem), {
		status: 200,
		headers: {
			"content-type": "application/x-pem-file",
			"content-disposition": 'attachment; filename="conduit-ca.pem"',
		},
	});
});

/** POST /api/push/unsubscribe */
const pushUnsubscribeHandler = Effect.gen(function* () {
	// PushProvider is omitted when push notifications are disabled.
	const maybePush = yield* Effect.serviceOption(PushProvider);

	if (Option.isNone(maybePush)) {
		return yield* jsonError(
			404,
			"NOT_AVAILABLE",
			"Push notifications not available",
		);
	}

	const push = maybePush.value;
	const body = yield* HttpServerRequest.schemaBodyJson(PushUnsubscribeBody);

	push.removeSubscription(body.endpoint);
	return yield* HttpServerResponse.json({ ok: true } satisfies PushOkResponse);
});

/** GET /api/setup-info */
const setupInfoHandler = Effect.gen(function* () {
	const setup = yield* SetupInfoProvider;
	const port = yield* setup.getPort();
	const isTls = yield* setup.getIsTls();
	const publicUrl = yield* setup.getPublicUrl();
	const request = yield* HttpServerRequest.HttpServerRequest;
	const hostHeader = request.headers["host"] ?? `localhost:${port}`;
	const hostBase = hostHeader.replace(/:\d+$/, "");
	const httpsUrl = `https://${hostBase}:${port}`;
	const httpUrl = `http://${hostBase}:${port}`;

	// Check for ?mode=lan query parameter
	const url = new URL(request.url, `http://${hostHeader}`);
	const lanMode = url.searchParams.get("mode") === "lan";

	return yield* HttpServerResponse.json({
		httpsUrl,
		httpUrl,
		hasCert: isTls,
		lanMode,
		publicUrl,
	} satisfies SetupInfoResponse);
});

const authPageHandler = serveStaticFile("/index.html");
const setupPageHandler = serveStaticFile("/index.html");

const rootHandler = serveStaticFile("/index.html");

const attachmentHandler = Effect.gen(function* () {
	const params = yield* HttpRouter.params;
	const hash = params["hash"];
	if (!hash || !/^[a-f0-9]{64}$/.test(hash))
		return yield* jsonError(404, "NOT_FOUND", "Attachment not found");
	const attachments = yield* Effect.serviceOption(AttachmentsProvider);
	if (Option.isNone(attachments))
		return yield* jsonError(404, "NOT_FOUND", "Attachment not found");
	return yield* attachments.value.read(params["slug"] ?? "", hash).pipe(
		Effect.map(({ bytes, mime }) =>
			HttpServerResponse.uint8Array(bytes, {
				contentType: mime,
				headers: {
					"Cache-Control": "private, max-age=31536000, immutable",
					"X-Content-Type-Options": "nosniff",
					"Content-Security-Policy": "sandbox",
					"Content-Disposition": mime.startsWith("image/")
						? "inline"
						: "attachment",
				},
			}),
		),
		Effect.catchTag("AttachmentMissing", () =>
			jsonError(404, "NOT_FOUND", "Attachment not found"),
		),
	);
});

const projectRouteHandler = Effect.gen(function* () {
	const params = yield* HttpRouter.params;
	const rawSlug = params["slug"];
	if (!rawSlug) return yield* jsonError(400, "BAD_REQUEST", "Missing slug");
	const req = yield* HttpServerRequest.HttpServerRequest;
	const host = req.headers["host"] ?? "localhost";
	const pathname = new URL(req.url, `http://${host}`).pathname;
	// v4 also registers the wildcard's parent path, which serves the SPA root.
	if (pathname === `/p/${rawSlug}`) return yield* rootHandler;
	const slug = decodeURIComponent(rawSlug);
	const subPath = pathname.slice(`/p/${rawSlug}`.length) || "/";
	if (!subPath.startsWith("/api/")) {
		return yield* serveStaticFile("/index.html");
	}
	const { getProjects } = yield* ProjectsProvider;
	const project = (yield* getProjects()).find((p) => p.slug === slug);

	if (!project) {
		return yield* jsonError(404, "NOT_FOUND", `Project "${slug}" not found`);
	}

	if (subPath === "/api/status") {
		return yield* HttpServerResponse.json({
			status: project.status ?? "ready",
			...(project.error != null && { error: project.error }),
		} satisfies ProjectStatusResponse);
	}

	// The standalone router can omit project API delegation.
	const delegate = yield* Effect.serviceOption(ProjectApiDelegateProvider);
	if (Option.isSome(delegate)) {
		return yield* delegate.value.delegateApiRequest(
			slug,
			subPath.slice(4),
			req,
		);
	}
	return yield* jsonError(404, "NOT_FOUND", "Project API route not found");
});

const staticCatchAllHandler = Effect.gen(function* () {
	const req = yield* HttpServerRequest.HttpServerRequest;
	const host = req.headers["host"] ?? "localhost";
	const pathname = new URL(req.url, `http://${host}`).pathname;
	return yield* serveStaticFile(pathname);
});

/**
 * Effect-based HTTP router with all JSON API routes.
 *
 * Requires: ProjectsProvider (always).
 * Optional: AttachmentsProvider, HealthProvider, PushProvider, CaCertProvider, SetupInfoProvider.
 *
 * Apply CORS middleware via `effectRouterWithCors` for production use.
 */
const publicRoutes = Layer.mergeAll(
	// Health check — two paths, same handler
	HttpRouter.add("GET", "/health", healthHandler),
	HttpRouter.add("GET", "/api/status", healthHandler),

	// Version info
	HttpRouter.add("GET", "/info", infoHandler),

	// Setup info (onboarding)
	HttpRouter.add("GET", "/api/setup-info", setupInfoHandler),

	// CA certificate download
	HttpRouter.add("GET", "/ca/download", caDownloadHandler),

	HttpRouter.add("GET", "/auth", authPageHandler),
	HttpRouter.add("GET", "/setup", setupPageHandler),
	authRoute,
	authStatusRoute,
);

const protectedRoutes = Layer.mergeAll(
	HttpRouter.add("GET", "/api/projects", projectsHandler),
	HttpRouter.add("GET", "/api/push/vapid-key", vapidKeyHandler),
	HttpRouter.add("POST", "/api/push/subscribe", pushSubscribeHandler),
	HttpRouter.add("POST", "/api/push/unsubscribe", pushUnsubscribeHandler),
	HttpRouter.add("GET", "/", rootHandler),
	HttpRouter.add("GET", "/s/:id", rootHandler),
	HttpRouter.add("GET", "/p/:slug/attachments/:hash", attachmentHandler),
	HttpRouter.add("GET", "/p/:slug/attachments/*", attachmentHandler),
	HttpRouter.add("GET", "/p/:slug/*", projectRouteHandler),
).pipe(
	Layer.provide(
		HttpRouter.middleware(
			Effect.gen(function* () {
				const auth = yield* AuthManagerTag;
				return (handler) =>
					withAuthGate(handler).pipe(
						Effect.provideService(AuthManagerTag, auth),
					);
			}),
		).layer,
	),
);

const staticCatchAll = HttpRouter.add("GET", "*", staticCatchAllHandler);

export const effectRouter = Layer.mergeAll(
	publicRoutes,
	protectedRoutes,
	staticCatchAll,
);

/**
 * Effect router with CORS middleware applied.
 * Mirrors the CORS headers from the existing router:
 *   Access-Control-Allow-Origin: *
 *   Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
 *   Access-Control-Allow-Headers: Content-Type, Authorization, X-Relay-Pin
 */
export const effectRouterWithCors = Layer.merge(
	effectRouter,
	HttpRouter.cors({
		allowedOrigins: ["*"],
		allowedMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization", "X-Relay-Pin"],
	}),
);
