import {
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import type { AuthManager } from "../auth.js";

export class AuthManagerTag extends Context.Tag("AuthManager")<
	AuthManagerTag,
	AuthManager
>() {}

export const makeAuthManagerLive = (
	auth: AuthManager,
): Layer.Layer<AuthManagerTag> => Layer.succeed(AuthManagerTag, auth);

export const parseCookies = (
	header: string | undefined,
): Record<string, string> => {
	if (!header) return {};
	const cookies: Record<string, string> = {};
	for (const pair of header.split(";")) {
		const [key, ...rest] = pair.trim().split("=");
		if (key) cookies[key.trim()] = rest.join("=").trim();
	}
	return cookies;
};

const getClientIp = (req: HttpServerRequest.HttpServerRequest): string => {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded.length > 0) {
		return forwarded.split(",")[0]?.trim() || "unknown";
	}
	return "unknown";
};

const sessionCookie = (cookie: string) =>
	`relay_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;

export const withAuthGate = <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | AuthManagerTag | HttpServerRequest.HttpServerRequest
> =>
	Effect.gen(function* () {
		const auth = yield* AuthManagerTag;
		if (!auth.hasPin()) return yield* app;

		const req = yield* HttpServerRequest.HttpServerRequest;
		const cookies = parseCookies(req.headers["cookie"]);
		const cookie = cookies["relay_session"];

		if (cookie && auth.validateCookie(cookie)) {
			return yield* app;
		}

		const pinHeader = req.headers["x-relay-pin"];
		if (typeof pinHeader === "string") {
			const result = auth.authenticate(pinHeader, getClientIp(req));
			if (result.ok && result.cookie) {
				const response = yield* app;
				return HttpServerResponse.setHeader(
					response,
					"Set-Cookie",
					sessionCookie(result.cookie),
				);
			}
		}

		if (req.url.startsWith("/api/") || req.url.includes("/api/")) {
			return HttpServerResponse.unsafeJson(
				{ error: { code: "AUTH_REQUIRED", message: "PIN required" } },
				{ status: 401 },
			);
		}

		return HttpServerResponse.empty({
			status: 302,
			headers: { Location: "/auth" },
		});
	}).pipe(Effect.withSpan("auth.gate"));

const authHandler = Effect.gen(function* () {
	const auth = yield* AuthManagerTag;
	const req = yield* HttpServerRequest.HttpServerRequest;

	const body = yield* Effect.catchAll(req.json, () => Effect.succeed(null));
	if (body === null || typeof body !== "object") {
		return yield* HttpServerResponse.json(
			{ ok: false, error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	const pin = (body as { pin?: unknown }).pin;
	if (typeof pin !== "string" || pin.length === 0) {
		return yield* HttpServerResponse.json(
			{ ok: false, error: "PIN required" },
			{ status: 400 },
		);
	}

	const result = auth.authenticate(pin, getClientIp(req));

	if (result.locked) {
		return yield* HttpServerResponse.json(
			{ ok: false, locked: true, retryAfter: result.retryAfter ?? 0 },
			{ status: 429 },
		);
	}

	if (!result.ok) {
		return yield* HttpServerResponse.json(
			{
				ok: false,
				attemptsLeft: auth.getRemainingAttempts(getClientIp(req)),
			},
			{ status: 401 },
		);
	}

	return yield* HttpServerResponse.json(
		{ ok: true },
		{
			headers: {
				"Set-Cookie": sessionCookie(result.cookie ?? ""),
			},
		},
	);
}).pipe(Effect.withSpan("auth.post"));

export const authRoute = HttpRouter.empty.pipe(
	HttpRouter.post("/auth", authHandler),
);

const authStatusHandler = Effect.gen(function* () {
	const auth = yield* AuthManagerTag;
	if (!auth.hasPin()) {
		return yield* HttpServerResponse.json({
			hasPin: false,
			authenticated: true,
		});
	}

	const req = yield* HttpServerRequest.HttpServerRequest;
	const cookies = parseCookies(req.headers["cookie"]);
	const cookie = cookies["relay_session"];
	const pinHeader = req.headers["x-relay-pin"];
	const authenticated =
		(cookie != null && auth.validateCookie(cookie)) ||
		(typeof pinHeader === "string" && auth.checkPin(pinHeader));

	return yield* HttpServerResponse.json({
		hasPin: true,
		authenticated,
	});
}).pipe(Effect.withSpan("auth.status"));

export const authStatusRoute = HttpRouter.empty.pipe(
	HttpRouter.get("/api/auth/status", authStatusHandler),
);
