import {
	HttpApp,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import {
	AuthManagerTag,
	authRoute,
	authStatusRoute,
	withAuthGate,
} from "../../../src/lib/effect/auth-middleware.js";

const authLayer = (auth: AuthManager) => Layer.succeed(AuthManagerTag, auth);

const requestLayer = (url: string, headers?: HeadersInit) =>
	Layer.succeed(
		HttpServerRequest.HttpServerRequest,
		HttpServerRequest.fromWeb(
			new Request(`http://localhost${url}`, {
				...(headers !== undefined && { headers }),
			}),
		),
	);

function makeHandler(auth: AuthManager) {
	const router = HttpRouter.empty.pipe(
		HttpRouter.concat(authRoute),
		HttpRouter.concat(authStatusRoute),
	);
	return HttpApp.toWebHandlerLayer(router, authLayer(auth));
}

describe("Auth middleware", () => {
	describe("withAuthGate", () => {
		const innerOk = HttpServerResponse.json({ ok: true });

		it.effect("passes through when no PIN is set", () =>
			Effect.gen(function* () {
				const response = yield* withAuthGate(innerOk);
				expect(response.status).toBe(200);
			}).pipe(
				Effect.provide(
					Layer.merge(authLayer(new AuthManager()), requestLayer("/api/data")),
				),
			),
		);

		it.effect("passes through with valid session cookie", () =>
			Effect.gen(function* () {
				const auth = new AuthManager();
				auth.setPin("1234");
				const result = auth.authenticate("1234", "127.0.0.1");
				expect(result.ok).toBe(true);
				const response = yield* withAuthGate(innerOk).pipe(
					Effect.provide(
						Layer.merge(
							authLayer(auth),
							requestLayer("/api/data", {
								cookie: `relay_session=${result.cookie}`,
							}),
						),
					),
				);
				expect(response.status).toBe(200);
			}),
		);

		it.effect("returns 401 JSON for unauthenticated API route", () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			return Effect.gen(function* () {
				const response = yield* withAuthGate(innerOk);
				expect(response.status).toBe(401);
			}).pipe(
				Effect.provide(Layer.merge(authLayer(auth), requestLayer("/api/data"))),
			);
		});

		it.effect("returns 302 redirect for unauthenticated browser route", () =>
			Effect.gen(function* () {
				const auth = new AuthManager();
				auth.setPin("1234");
				const response = yield* withAuthGate(innerOk).pipe(
					Effect.provide(
						Layer.merge(authLayer(auth), requestLayer("/p/demo/")),
					),
				);
				expect(response.status).toBe(302);
				expect(response.headers["location"]).toBe("/auth");
			}),
		);

		it.effect("authenticates via x-relay-pin header and sets cookie", () =>
			Effect.gen(function* () {
				const auth = new AuthManager();
				auth.setPin("1234");
				const response = yield* withAuthGate(innerOk).pipe(
					Effect.provide(
						Layer.merge(
							authLayer(auth),
							requestLayer("/api/data", {
								"x-relay-pin": "1234",
								"x-forwarded-for": "10.0.0.1",
							}),
						),
					),
				);
				expect(response.status).toBe(200);
				expect(response.headers["set-cookie"]).toContain("relay_session=");
			}),
		);
	});

	describe("authRoute", () => {
		it("returns 400 on invalid JSON body", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			const { handler, dispose } = makeHandler(auth);
			try {
				const response = await handler(
					new Request("http://localhost/auth", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "not-json{",
					}),
				);
				expect(response.status).toBe(400);
			} finally {
				await dispose();
			}
		});

		it("sets a session cookie for valid PIN", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			const { handler, dispose } = makeHandler(auth);
			try {
				const response = await handler(
					new Request("http://localhost/auth", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ pin: "1234" }),
					}),
				);
				expect(response.status).toBe(200);
				expect(response.headers.get("set-cookie")).toContain("relay_session=");
			} finally {
				await dispose();
			}
		});
	});

	describe("authStatusRoute", () => {
		it("returns authenticated true when no PIN is set", async () => {
			const { handler, dispose } = makeHandler(new AuthManager());
			try {
				const response = await handler(
					new Request("http://localhost/api/auth/status"),
				);
				expect(response.status).toBe(200);
				await expect(response.json()).resolves.toEqual({
					hasPin: false,
					authenticated: true,
				});
			} finally {
				await dispose();
			}
		});
	});
});
