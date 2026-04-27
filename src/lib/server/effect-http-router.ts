// ─── Effect HTTP Router ─────────────────────────────────────────────────────
// Effect-based HTTP router using @effect/platform, created alongside the
// existing RequestRouter (http-router.ts). Covers all JSON API routes;
// auth gate, static files, and SPA serving remain in the imperative router
// until the full daemon entry point migration.
//
// Routes:
//   GET  /health, /api/status     — health check
//   GET  /info                    — version info
//   GET  /api/projects            — project list
//   GET  /api/push/vapid-key      — VAPID public key
//   POST /api/push/subscribe      — push subscription
//   POST /api/push/unsubscribe    — push unsubscription
//   GET  /api/themes              — theme list
//   GET  /api/setup-info          — setup/onboarding info
//   GET  /ca/download             — CA certificate download

import { readFile } from "node:fs/promises";
import {
	HttpMiddleware,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import type { HttpBodyError } from "@effect/platform/HttpBody";
import { Context, Effect, Option, Schema } from "effect";
import type {
	ApiError,
	DashboardProjectResponse,
	HealthResponse,
	InfoResponse,
	ProjectsListResponse,
	PushOkResponse,
	SetupInfoResponse,
	ThemesResponse,
	VapidKeyResponse,
} from "../shared-types.js";
import { getVersion } from "../version.js";

// ─── Service Tags (dependency injection) ────────────────────────────────────
// Each tag represents a capability the router needs. Concrete implementations
// are provided via Effect Layers when the router is wired into the server.

/** Project data provider — returns the current project list. */
export interface RouterProjectInfo {
	slug: string;
	directory: string;
	title: string;
	status?: "registering" | "ready" | "error";
	error?: string;
	clients?: number;
	sessions?: number;
	isProcessing?: boolean;
}

export class ProjectsProvider extends Context.Tag("ProjectsProvider")<
	ProjectsProvider,
	{ readonly getProjects: () => RouterProjectInfo[] }
>() {}

/** Health response provider — optionally overridden by daemon mode. */
export class HealthProvider extends Context.Tag("HealthProvider")<
	HealthProvider,
	{ readonly getHealthResponse: () => object }
>() {}

/** Push notification manager — may not be available. */
export class PushProvider extends Context.Tag("PushProvider")<
	PushProvider,
	{
		readonly getPublicKey: () => string | undefined;
		readonly addSubscription: (endpoint: string, subscription: unknown) => void;
		readonly removeSubscription: (endpoint: string) => void;
	}
>() {}

/** CA certificate provider — may not be available. */
export class CaCertProvider extends Context.Tag("CaCertProvider")<
	CaCertProvider,
	{
		readonly caCertDer: Buffer | undefined;
		readonly caRootPath: string | undefined;
	}
>() {}

/** Theme loader provider — may not be available in test environments. */
export class ThemeProvider extends Context.Tag("ThemeProvider")<
	ThemeProvider,
	{
		readonly loadThemes: () => Promise<ThemesResponse>;
	}
>() {}

/** Setup info provider — exposes server connectivity details. */
export class SetupInfoProvider extends Context.Tag("SetupInfoProvider")<
	SetupInfoProvider,
	{
		readonly port: number;
		readonly isTls: boolean;
	}
>() {}

// ─── Helpers ────────────────────────────────────────────────────────────────

function serializeProject(p: RouterProjectInfo): DashboardProjectResponse {
	return {
		slug: p.slug,
		path: p.directory,
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

// ─── Request body schemas ───────────────────────────────────────────────────

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

// ─── Route handlers ─────────────────────────────────────────────────────────

/** GET /health, GET /api/status */
const healthHandler = Effect.gen(function* () {
	const { getProjects } = yield* ProjectsProvider;
	const maybeHealth = yield* Effect.serviceOption(HealthProvider);

	const body = Option.isSome(maybeHealth)
		? maybeHealth.value.getHealthResponse()
		: ({
				ok: true,
				projects: getProjects().length,
				uptime: process.uptime(),
			} satisfies HealthResponse);

	return yield* HttpServerResponse.json(body);
});

/** GET /info */
const infoHandler = Effect.gen(function* () {
	return yield* HttpServerResponse.json({
		version: getVersion(),
	} satisfies InfoResponse);
});

/** GET /api/projects */
const projectsHandler = Effect.gen(function* () {
	const { getProjects } = yield* ProjectsProvider;
	const projects = getProjects();

	return yield* HttpServerResponse.json({
		projects: projects.map(serializeProject),
		version: getVersion(),
	} satisfies ProjectsListResponse);
});

/** GET /api/push/vapid-key */
const vapidKeyHandler = Effect.gen(function* () {
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

/** GET /api/themes */
const themesHandler = Effect.gen(function* () {
	const maybeThemes = yield* Effect.serviceOption(ThemeProvider);

	if (Option.isNone(maybeThemes)) {
		return yield* jsonError(
			404,
			"NOT_AVAILABLE",
			"Theme loading not available",
		);
	}

	const themes = yield* Effect.tryPromise({
		try: () => maybeThemes.value.loadThemes(),
		catch: () => new Error("Failed to load themes"),
	});

	return yield* HttpServerResponse.json(themes);
});

/** GET /api/setup-info */
const setupInfoHandler = Effect.gen(function* () {
	const maybeSetup = yield* Effect.serviceOption(SetupInfoProvider);

	if (Option.isNone(maybeSetup)) {
		return yield* jsonError(404, "NOT_AVAILABLE", "Setup info not available");
	}

	const setup = maybeSetup.value;
	const request = yield* HttpServerRequest.HttpServerRequest;
	const hostHeader = request.headers["host"] ?? `localhost:${setup.port}`;
	const hostBase = hostHeader.replace(/:\d+$/, "");
	const httpsUrl = `https://${hostBase}:${setup.port}`;
	const httpUrl = `http://${hostBase}:${setup.port}`;

	// Check for ?mode=lan query parameter
	const url = new URL(request.url, `http://${hostHeader}`);
	const lanMode = url.searchParams.get("mode") === "lan";

	return yield* HttpServerResponse.json({
		httpsUrl,
		httpUrl,
		hasCert: setup.isTls,
		lanMode,
	} satisfies SetupInfoResponse);
});

// ─── Router ─────────────────────────────────────────────────────────────────

/**
 * Effect-based HTTP router with all JSON API routes.
 *
 * Requires: ProjectsProvider (always).
 * Optional: HealthProvider, PushProvider, CaCertProvider, ThemeProvider, SetupInfoProvider.
 *
 * Apply CORS middleware via `effectRouterWithCors` for production use.
 */
export const effectRouter = HttpRouter.empty.pipe(
	// Health check — two paths, same handler
	HttpRouter.get("/health", healthHandler),
	HttpRouter.get("/api/status", healthHandler),

	// Version info
	HttpRouter.get("/info", infoHandler),

	// Projects list
	HttpRouter.get("/api/projects", projectsHandler),

	// Push notification endpoints
	HttpRouter.get("/api/push/vapid-key", vapidKeyHandler),
	HttpRouter.post("/api/push/subscribe", pushSubscribeHandler),
	HttpRouter.post("/api/push/unsubscribe", pushUnsubscribeHandler),

	// Theme list
	HttpRouter.get("/api/themes", themesHandler),

	// Setup info (onboarding)
	HttpRouter.get("/api/setup-info", setupInfoHandler),

	// CA certificate download
	HttpRouter.get("/ca/download", caDownloadHandler),
);

/**
 * Effect router with CORS middleware applied.
 * Mirrors the CORS headers from the existing router:
 *   Access-Control-Allow-Origin: *
 *   Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
 *   Access-Control-Allow-Headers: Content-Type, Authorization, X-Relay-Pin
 */
export const effectRouterWithCors = effectRouter.pipe(
	HttpMiddleware.cors({
		allowedOrigins: ["*"],
		allowedMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization", "X-Relay-Pin"],
	}),
);
