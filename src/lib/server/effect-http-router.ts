// ─── Effect HTTP Router ─────────────────────────────────────────────────────
// Effect-based HTTP router using @effect/platform, created alongside the
// existing RequestRouter (http-router.ts). This is a proof-of-concept
// covering core routes; the full migration happens incrementally.
//
// Routes migrated:
//   GET  /health, /api/status   — health check
//   GET  /info                  — version info
//   GET  /api/projects          — project list
//   GET  /api/push/vapid-key    — VAPID public key
//   POST /api/push/subscribe    — push subscription
//   GET  /ca/download           — CA certificate download
//
// The existing http-router.ts continues to serve all traffic.
// This router is wired up in Task 6.3.

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

// ─── Push subscription body schema ──────────────────────────────────────────

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

// ─── Router ─────────────────────────────────────────────────────────────────

/**
 * Effect-based HTTP router with core routes.
 *
 * Requires: ProjectsProvider (always).
 * Optional: HealthProvider, PushProvider, CaCertProvider.
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
