// ─── DaemonEnvConfig: Effect.Config-based env parsing ─────────────────────────
// Replaces the static ENV object in env.ts with a type-safe, testable Layer.
// Consumers `yield* DaemonEnvConfigTag` to access parsed environment values.
// Tests override via `ConfigProvider.fromMap` — no process.env mutation needed.

import {
	Config,
	type ConfigError,
	Context,
	Effect,
	Layer,
	type Option,
	Redacted,
} from "effect";

// ─── Service interface ──────────────────────────────────────────────────────

export interface DaemonEnvConfig {
	readonly host: string;
	readonly hostExplicit: boolean;
	readonly port: number;
	readonly opencodeUrl: string | undefined;
	readonly opencodePassword: Redacted.Redacted<string> | undefined;
	readonly opencodeUsername: string;
	readonly debug: boolean;
	readonly logLevel: string;
	readonly logFormat: string | undefined;
	readonly tls: boolean;
	readonly tlsCertPath: string | undefined;
	readonly tlsKeyPath: string | undefined;
}

// ─── Context Tag ────────────────────────────────────────────────────────────

export class DaemonEnvConfigTag extends Context.Tag("DaemonEnvConfig")<
	DaemonEnvConfigTag,
	DaemonEnvConfig
>() {}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract the value from a Config.option result, returning undefined for None. */
const optionToUndefined = <A>(o: Option.Option<A>): A | undefined =>
	o._tag === "Some" ? o.value : undefined;

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const DaemonEnvConfigLive: Layer.Layer<
	DaemonEnvConfigTag,
	ConfigError.ConfigError
> = Layer.effect(
	DaemonEnvConfigTag,
	Effect.gen(function* () {
		const host = yield* Config.string("HOST").pipe(
			Config.withDefault("127.0.0.1"),
		);
		const hostExplicit = yield* Effect.map(
			Config.option(Config.string("HOST")),
			(o) => o._tag === "Some",
		);
		const port = yield* Config.integer("CONDUIT_PORT").pipe(
			Config.withDefault(2633),
		);
		const opencodeUrl = yield* Effect.map(
			Config.option(Config.string("OPENCODE_URL")),
			optionToUndefined,
		);
		const opencodePassword = yield* Effect.map(
			Config.option(Config.redacted(Config.string("OPENCODE_SERVER_PASSWORD"))),
			optionToUndefined,
		);
		const opencodeUsername = yield* Config.string(
			"OPENCODE_SERVER_USERNAME",
		).pipe(Config.withDefault("opencode"));
		// Match the original `process.env["DEBUG"] === "1"` semantics exactly:
		// only "1" and "true" are truthy; absent or any other value is false.
		const debug = yield* Effect.map(
			Config.string("DEBUG").pipe(Config.withDefault("0")),
			(v) => v === "1" || v.toLowerCase() === "true",
		);
		const logLevel = yield* Config.string("LOG_LEVEL").pipe(
			Config.withDefault("info"),
		);
		const logFormat = yield* Effect.map(
			Config.option(Config.string("LOG_FORMAT")),
			optionToUndefined,
		);
		const tls = yield* Effect.map(
			Config.string("CONDUIT_TLS").pipe(Config.withDefault("0")),
			(v) => v === "1" || v.toLowerCase() === "true",
		);
		const tlsCertPath = yield* Effect.map(
			Config.option(Config.string("CONDUIT_TLS_CERT")),
			optionToUndefined,
		);
		const tlsKeyPath = yield* Effect.map(
			Config.option(Config.string("CONDUIT_TLS_KEY")),
			optionToUndefined,
		);

		return {
			host,
			hostExplicit,
			port,
			opencodeUrl,
			opencodePassword,
			opencodeUsername,
			debug,
			logLevel,
			logFormat,
			tls,
			tlsCertPath,
			tlsKeyPath,
		};
	}),
);
