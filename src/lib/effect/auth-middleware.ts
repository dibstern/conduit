import {
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Context, Effect, Layer, Ref } from "effect";
import { AuthManager, type AuthResult } from "../auth.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";

export class AuthManagerTag extends Context.Tag("AuthManager")<
	AuthManagerTag,
	AuthManagerService
>() {}

export interface AuthManagerService {
	readonly hasPin: () => Effect.Effect<boolean>;
	readonly validateCookie: (cookie: string) => Effect.Effect<boolean>;
	readonly authenticate: (pin: string, ip: string) => Effect.Effect<AuthResult>;
	readonly checkPin: (pin: string) => Effect.Effect<boolean>;
	readonly getRemainingAttempts: (ip: string) => Effect.Effect<number>;
	readonly getPinHash: () => Effect.Effect<string | null>;
}

const makeAuthManagerService = (auth: AuthManager): AuthManagerService => ({
	hasPin: () => Effect.sync(() => auth.hasPin()),
	validateCookie: (cookie) => Effect.sync(() => auth.validateCookie(cookie)),
	authenticate: (pin, ip) => Effect.sync(() => auth.authenticate(pin, ip)),
	checkPin: (pin) => Effect.sync(() => auth.checkPin(pin)),
	getRemainingAttempts: (ip) =>
		Effect.sync(() => auth.getRemainingAttempts(ip)),
	getPinHash: () => Effect.sync(() => auth.getPinHash()),
});

export const makeAuthManagerLive = (
	auth: AuthManager,
): Layer.Layer<AuthManagerTag> =>
	Layer.succeed(AuthManagerTag, makeAuthManagerService(auth));

/**
 * Auth service layer that reads pinHash reactively from DaemonConfigRef.
 * Auth attempts and cookies stay in one AuthManager, but every auth method reads
 * the latest pinHash through Effect before touching that state machine.
 */
export const AuthManagerFromConfigLive: Layer.Layer<
	AuthManagerTag,
	never,
	DaemonConfigRefTag
> = Layer.effect(
	AuthManagerTag,
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const auth = new AuthManager();
		const withCurrentPin = <A>(use: (manager: AuthManager) => A) =>
			Ref.get(configRef).pipe(
				Effect.map((config) => config.pinHash),
				Effect.flatMap((pinHash) =>
					Effect.sync(() => {
						auth.setPinHash(pinHash);
						return use(auth);
					}),
				),
			);

		return {
			hasPin: () => withCurrentPin((manager) => manager.hasPin()),
			validateCookie: (cookie) =>
				withCurrentPin((manager) => manager.validateCookie(cookie)),
			authenticate: (pin, ip) =>
				withCurrentPin((manager) => manager.authenticate(pin, ip)),
			checkPin: (pin) => withCurrentPin((manager) => manager.checkPin(pin)),
			getRemainingAttempts: (ip) =>
				withCurrentPin((manager) => manager.getRemainingAttempts(ip)),
			getPinHash: () => withCurrentPin((manager) => manager.getPinHash()),
		} satisfies AuthManagerService;
	}),
);

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
		const hasPin = yield* auth.hasPin();
		if (!hasPin) return yield* app;

		const req = yield* HttpServerRequest.HttpServerRequest;
		const cookies = parseCookies(req.headers["cookie"]);
		const cookie = cookies["relay_session"];

		if (cookie && (yield* auth.validateCookie(cookie))) {
			return yield* app;
		}

		const pinHeader = req.headers["x-relay-pin"];
		if (typeof pinHeader === "string") {
			const result = yield* auth.authenticate(pinHeader, getClientIp(req));
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

	const clientIp = getClientIp(req);
	const result = yield* auth.authenticate(pin, clientIp);

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
				attemptsLeft: yield* auth.getRemainingAttempts(clientIp),
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
	const hasPin = yield* auth.hasPin();
	if (!hasPin) {
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
		(cookie != null && (yield* auth.validateCookie(cookie))) ||
		(typeof pinHeader === "string" && (yield* auth.checkPin(pinHeader)));

	return yield* HttpServerResponse.json({
		hasPin: true,
		authenticated,
	});
}).pipe(Effect.withSpan("auth.status"));

export const authStatusRoute = HttpRouter.empty.pipe(
	HttpRouter.get("/api/auth/status", authStatusHandler),
);
