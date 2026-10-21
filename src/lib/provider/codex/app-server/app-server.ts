import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { captureAppServerTransport } from "./trace.js";
import { createTraceAppServerTransport } from "./trace-player.js";
import {
	AppServerIoError,
	type AppServerTransport,
	type SpawnAppServerOptions,
	spawnAppServerTransport,
} from "./transport.js";

export interface OpenAppServerOptions extends SpawnAppServerOptions {
	readonly scenario?: string;
	readonly codexVersion?: string;
}

/** The only transport-selection seam used by real callers and trace replay. */
export function openAppServerTransport(
	options: OpenAppServerOptions = {},
): Effect.Effect<AppServerTransport, AppServerIoError, Scope.Scope> {
	return Effect.gen(function* () {
		const env = options.env ?? process.env;
		const scenario = options.scenario ?? "codex-app-server";
		const fixture = yield* Effect.try({
			try: () => {
				if (env["NODE_ENV"] !== "test") return undefined;
				const home = env["CODEX_HOME"] ?? join(env["HOME"] ?? "", ".codex");
				const report = env["CONDUIT_TEST_CODEX_TRANSPORTS"];
				if (report)
					appendFileSync(
						report,
						`${JSON.stringify({ home, scenario, environmentKeys: Object.keys(env).filter((key) => env[key] !== undefined) })}\n`,
					);
				const path = env["CONDUIT_TEST_CODEX_TRACE_MAP"];
				if (!path) return undefined;
				const map = JSON.parse(readFileSync(path, "utf8")) as Record<
					string,
					Record<string, { trace: string; capture?: string }>
				>;
				return map[home]?.[scenario] ?? map["*"]?.[scenario];
			},
			catch: (cause) =>
				new AppServerIoError({ operation: "test trace selection", cause }),
		});
		const trace =
			fixture?.trace ??
			options.env?.["CONDUIT_CODEX_APP_SERVER_TRACE"] ??
			process.env["CONDUIT_CODEX_APP_SERVER_TRACE"];
		const reportPath =
			options.env?.["CONDUIT_CODEX_APP_SERVER_TRACE_REPORT"] ??
			process.env["CONDUIT_CODEX_APP_SERVER_TRACE_REPORT"];
		const transport = trace
			? yield* createTraceAppServerTransport(trace, {
					...(reportPath ? { reportPath } : {}),
				})
			: yield* spawnAppServerTransport(options);
		const capture =
			fixture?.capture ??
			options.env?.["CONDUIT_CODEX_APP_SERVER_CAPTURE"] ??
			process.env["CONDUIT_CODEX_APP_SERVER_CAPTURE"];
		return capture
			? yield* captureAppServerTransport(transport, capture, {
					scenario,
					codexVersion: options.codexVersion ?? "unknown",
				})
			: transport;
	});
}
