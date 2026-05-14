// ─── Effect HTTP Server Layer ────────────────────────────────────────────────
// Replaces the raw `http.createServer` / `https.createServer` usage in
// server.ts with a proper @effect/platform-node NodeHttpServer layer.
//
// The layer reads config (port, host, TLS) from DaemonEnvConfigTag,
// constructs the appropriate Node.js server factory, and wires the
// Effect HTTP router via HttpServer.serve.
//
// WebSocket upgrade is NOT handled here — that is Task 32. This layer
// only serves HTTP routes through the Effect router.

import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { HttpServerError } from "@effect/platform";
import { HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import {
	effectRouterWithCors,
	type ProjectsProvider,
} from "../../../server/effect-http-router.js";
import type { DaemonEnvConfig } from "../../daemon/Services/daemon-config.js";
import { DaemonEnvConfigTag } from "../../daemon/Services/daemon-config.js";
import type { StaticDirTag } from "../Services/static-file-handler.js";
import type { AuthManagerTag } from "./auth-middleware.js";

// ─── HttpServerConfig Tag ──────────────────────────────────────────────────
// A focused config slice for the HTTP server layer, decoupled from the
// full DaemonEnvConfig for testability.

export interface HttpServerConfig {
	readonly port: number;
	readonly host: string;
	readonly tls: boolean;
	readonly tlsCertPath: string | undefined;
	readonly tlsKeyPath: string | undefined;
}

export class HttpServerConfigTag extends Context.Tag("HttpServerConfig")<
	HttpServerConfigTag,
	HttpServerConfig
>() {}

/**
 * Derive HttpServerConfigTag from DaemonEnvConfigTag — production use.
 */
export const HttpServerConfigFromEnv: Layer.Layer<
	HttpServerConfigTag,
	never,
	DaemonEnvConfigTag
> = Layer.effect(
	HttpServerConfigTag,
	Effect.map(DaemonEnvConfigTag, (env: DaemonEnvConfig) => ({
		port: env.port,
		host: env.host,
		tls: env.tls,
		tlsCertPath: env.tlsCertPath,
		tlsKeyPath: env.tlsKeyPath,
	})),
);

// ─── Server Factory ────────────────────────────────────────────────────────

/**
 * Build the Node.js server factory function based on TLS config.
 * When TLS is enabled, reads cert/key from disk synchronously (they are
 * needed at server construction time).
 */
const makeServerFactory = (
	config: HttpServerConfig,
): (() => ReturnType<typeof createHttpServer>) => {
	if (config.tls && config.tlsCertPath && config.tlsKeyPath) {
		const cert = readFileSync(config.tlsCertPath);
		const key = readFileSync(config.tlsKeyPath);
		return () =>
			createHttpsServer({ key, cert }) as unknown as ReturnType<
				typeof createHttpServer
			>;
	}
	return () => createHttpServer();
};

// ─── HttpServerLive ────────────────────────────────────────────────────────

/**
 * Layer that:
 * 1. Reads HttpServerConfig (port, host, TLS)
 * 2. Creates the appropriate Node.js HTTP/HTTPS server factory
 * 3. Starts the server via NodeHttpServer.layer
 * 4. Serves routes through the Effect HTTP router with CORS
 *
 * Requires: HttpServerConfigTag + all router dependencies
 * (ProjectsProvider, and optionally HealthProvider, PushProvider, CaCertProvider,
 * ThemeProvider, SetupInfoProvider).
 */
export const HttpServerLive: Layer.Layer<
	never,
	HttpServerError.ServeError,
	AuthManagerTag | HttpServerConfigTag | ProjectsProvider | StaticDirTag
> = Layer.unwrapEffect(
	Effect.gen(function* () {
		const config = yield* HttpServerConfigTag;
		const factory = makeServerFactory(config);

		// NodeHttpServer.layer provides HttpServer + platform context (FileSystem, Etag, Path).
		// HttpServer.serve(router) creates a Layer that starts serving the router
		// using the provided HttpServer.
		const serverLayer = NodeHttpServer.layer(factory, {
			port: config.port,
			host: config.host,
		});

		return HttpServer.serve(effectRouterWithCors).pipe(
			Layer.provide(serverLayer),
		);
	}),
);

/**
 * Convenience: Full HTTP server layer from DaemonEnvConfig.
 * Wires HttpServerConfigFromEnv -> HttpServerLive.
 */
export const HttpServerFromEnvLive: Layer.Layer<
	never,
	HttpServerError.ServeError,
	AuthManagerTag | DaemonEnvConfigTag | ProjectsProvider | StaticDirTag
> = HttpServerLive.pipe(Layer.provide(HttpServerConfigFromEnv));
