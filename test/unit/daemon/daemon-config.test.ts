// ─── Tests: DaemonEnvConfig Layer (Effect.Config-based env parsing) ──────────

import { describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { expect } from "vitest";
import {
	DaemonEnvConfigLive,
	DaemonEnvConfigTag,
} from "../../../src/lib/effect/daemon-config.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a test layer with the given env var map. */
const testLayer = (vars: ReadonlyArray<readonly [string, string]>) =>
	DaemonEnvConfigLive.pipe(
		Layer.provide(
			Layer.setConfigProvider(ConfigProvider.fromMap(new Map(vars))),
		),
	);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("DaemonEnvConfig", () => {
	it.effect("reads host and port from env", () =>
		Effect.gen(function* () {
			const config = yield* DaemonEnvConfigTag;

			expect(config.host).toBe("0.0.0.0");
			expect(config.port).toBe(8080);
			expect(config.debug).toBe(true);
		}).pipe(
			Effect.provide(
				testLayer([
					["HOST", "0.0.0.0"],
					["CONDUIT_PORT", "8080"],
					["DEBUG", "1"],
				]),
			),
		),
	);

	it.effect("uses defaults when env vars are missing", () =>
		Effect.gen(function* () {
			const config = yield* DaemonEnvConfigTag;

			expect(config.host).toBe("127.0.0.1");
			expect(config.hostExplicit).toBe(false);
			expect(config.port).toBe(2633);
			expect(config.debug).toBe(false);
			expect(config.tls).toBe(false);
			expect(config.logLevel).toBe("info");
			expect(config.logFormat).toBeUndefined();
			expect(config.opencodeUrl).toBeUndefined();
			expect(config.opencodePassword).toBeUndefined();
			expect(config.opencodeUsername).toBe("opencode");
			expect(config.tlsCertPath).toBeUndefined();
			expect(config.tlsKeyPath).toBeUndefined();
		}).pipe(Effect.provide(testLayer([]))),
	);

	it.effect("handles redacted password", () =>
		Effect.gen(function* () {
			const config = yield* DaemonEnvConfigTag;

			expect(config.opencodePassword).toBeDefined();
			expect(Redacted.isRedacted(config.opencodePassword)).toBe(true);
			// biome-ignore lint/style/noNonNullAssertion: previous assertion guarantees defined
			expect(Redacted.value(config.opencodePassword!)).toBe("super-secret");
		}).pipe(
			Effect.provide(testLayer([["OPENCODE_SERVER_PASSWORD", "super-secret"]])),
		),
	);

	it.effect("hostExplicit is true when HOST is set, false when not", () =>
		Effect.gen(function* () {
			// With HOST set
			const withHost = yield* DaemonEnvConfigTag.pipe(
				Effect.provide(testLayer([["HOST", "10.0.0.1"]])),
			);
			expect(withHost.hostExplicit).toBe(true);
			expect(withHost.host).toBe("10.0.0.1");

			// Without HOST set
			const withoutHost = yield* DaemonEnvConfigTag.pipe(
				Effect.provide(testLayer([])),
			);
			expect(withoutHost.hostExplicit).toBe(false);
			expect(withoutHost.host).toBe("127.0.0.1");
		}),
	);

	it.effect("parses TLS configuration", () =>
		Effect.gen(function* () {
			const config = yield* DaemonEnvConfigTag;

			expect(config.tls).toBe(true);
			expect(config.tlsCertPath).toBe("/etc/ssl/cert.pem");
			expect(config.tlsKeyPath).toBe("/etc/ssl/key.pem");
		}).pipe(
			Effect.provide(
				testLayer([
					["CONDUIT_TLS", "1"],
					["CONDUIT_TLS_CERT", "/etc/ssl/cert.pem"],
					["CONDUIT_TLS_KEY", "/etc/ssl/key.pem"],
				]),
			),
		),
	);

	it.effect("debug accepts 'true' as well as '1'", () =>
		Effect.gen(function* () {
			const config = yield* DaemonEnvConfigTag;
			expect(config.debug).toBe(true);
		}).pipe(Effect.provide(testLayer([["DEBUG", "true"]]))),
	);

	it.effect("reads opencode username from env", () =>
		Effect.gen(function* () {
			const config = yield* DaemonEnvConfigTag;
			expect(config.opencodeUsername).toBe("admin");
		}).pipe(Effect.provide(testLayer([["OPENCODE_SERVER_USERNAME", "admin"]]))),
	);

	it.effect("reads log format from env", () =>
		Effect.gen(function* () {
			const config = yield* DaemonEnvConfigTag;
			expect(config.logFormat).toBe("json");
			expect(config.logLevel).toBe("debug");
		}).pipe(
			Effect.provide(
				testLayer([
					["LOG_FORMAT", "json"],
					["LOG_LEVEL", "debug"],
				]),
			),
		),
	);
});
