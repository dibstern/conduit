import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import type { TlsCerts } from "../../../src/lib/cli/tls.js";
import {
	EnsureCertsTag,
	TlsCertLive,
	TlsCertLoadError,
	TlsCertTag,
} from "../../../src/lib/domain/daemon/Layers/tls-cert-layer.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseConfig: DaemonRuntimeConfig = {
	port: 2633,
	host: "127.0.0.1",
	pinHash: null,
	tlsEnabled: false,
	keepAwake: false,
	keepAwakeCommand: undefined,
	keepAwakeArgs: undefined,
	shuttingDown: false,
	dismissedPaths: new Set(),
	startTime: Date.now(),
	hostExplicit: false,
	persistedSessionCounts: new Map(),
};

const fakeCerts: TlsCerts = {
	key: Buffer.from("fake-key"),
	cert: Buffer.from("fake-cert"),
	caRoot: "/fake/caRoot",
	caCertPem: Buffer.from("fake-ca-pem"),
	caCertDer: Buffer.from("fake-ca-der"),
};

/** Mock EnsureCerts that returns the given result or throws. */
const mockEnsureCerts = (
	result: TlsCerts | null | "throw",
	callTracker?: { called: boolean },
) =>
	Layer.succeed(EnsureCertsTag, {
		ensureCerts: (_opts) => {
			if (callTracker) callTracker.called = true;
			if (result === "throw") {
				return Effect.fail(
					new TlsCertLoadError({ cause: new Error("mkcert exploded") }),
				);
			}
			return Effect.succeed(result);
		},
	});

/** Build the full test layer for TlsCertLive with a given config and mock. */
const makeTestLayer = (
	configOverrides: Partial<DaemonRuntimeConfig>,
	ensureCertsResult: TlsCerts | null | "throw",
	callTracker?: { called: boolean },
) => {
	const config = { ...baseConfig, ...configOverrides };
	const configRefLayer = DaemonConfigRefLive(config);
	const ensureCertsLayer = mockEnsureCerts(ensureCertsResult, callTracker);
	return TlsCertLive("/fake/config").pipe(
		Layer.provide(configRefLayer),
		Layer.provide(ensureCertsLayer),
	);
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("TlsCertLive", () => {
	// (a) TLS disabled - null certs, no ensureCerts call
	it.effect("returns null certs when TLS is disabled", () => {
		const tracker = { called: false };
		const layer = makeTestLayer({}, null, tracker);

		return Effect.gen(function* () {
			const service = yield* TlsCertTag;
			expect(service.certs).toBeNull();
			expect(service.caRootPath).toBeNull();
			expect(service.caCertDer).toBeNull();
			expect(service.caCertPem).toBeNull();
			expect(tracker.called).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});

	// (b) TLS enabled, ensureCerts returns null - tlsEnabled set to false in Ref
	it.effect(
		"falls back when ensureCerts returns null (mkcert not found)",
		() => {
			const configRefLayer = DaemonConfigRefLive({
				...baseConfig,
				tlsEnabled: true,
			});
			const ensureCertsLayer = mockEnsureCerts(null);
			const tlsLayer = TlsCertLive("/fake/config").pipe(
				Layer.provide(configRefLayer),
				Layer.provide(ensureCertsLayer),
			);
			// Merge configRefLayer so we can read the Ref after TlsCertLive runs
			const fullLayer = Layer.merge(tlsLayer, configRefLayer);

			return Effect.gen(function* () {
				const service = yield* TlsCertTag;
				expect(service.certs).toBeNull();

				// Verify tlsEnabled was set to false in the config Ref
				const ref = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(ref);
				expect(config.tlsEnabled).toBe(false);
			}).pipe(Effect.provide(Layer.fresh(fullLayer)));
		},
	);

	// (c) TLS enabled, ensureCerts throws - catch, log, tlsEnabled set to false
	it.effect("falls back when ensureCerts throws", () => {
		const configRefLayer = DaemonConfigRefLive({
			...baseConfig,
			tlsEnabled: true,
		});
		const ensureCertsLayer = mockEnsureCerts("throw");
		const tlsLayer = TlsCertLive("/fake/config").pipe(
			Layer.provide(configRefLayer),
			Layer.provide(ensureCertsLayer),
		);
		const fullLayer = Layer.merge(tlsLayer, configRefLayer);

		return Effect.gen(function* () {
			const service = yield* TlsCertTag;
			expect(service.certs).toBeNull();

			const ref = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(ref);
			expect(config.tlsEnabled).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(fullLayer)));
	});

	// (d) TLS enabled, succeeds, host not explicit - host updated to "0.0.0.0"
	it.effect(
		"updates host to 0.0.0.0 when TLS succeeds and host is not explicit",
		() => {
			const configRefLayer = DaemonConfigRefLive({
				...baseConfig,
				tlsEnabled: true,
				hostExplicit: false,
			});
			const ensureCertsLayer = mockEnsureCerts(fakeCerts);
			const tlsLayer = TlsCertLive("/fake/config").pipe(
				Layer.provide(configRefLayer),
				Layer.provide(ensureCertsLayer),
			);
			const fullLayer = Layer.merge(tlsLayer, configRefLayer);

			return Effect.gen(function* () {
				const service = yield* TlsCertTag;
				expect(service.certs).toBe(fakeCerts);
				expect(service.caRootPath).toBe("/fake/caRoot");
				expect(service.caCertDer).toEqual(Buffer.from("fake-ca-der"));
				expect(service.caCertPem).toEqual(Buffer.from("fake-ca-pem"));

				const ref = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(ref);
				expect(config.host).toBe("0.0.0.0");
				expect(config.tlsEnabled).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(fullLayer)));
		},
	);

	// (e) TLS enabled, succeeds, host explicit - host NOT changed
	it.effect("preserves host when TLS succeeds and host is explicit", () => {
		const configRefLayer = DaemonConfigRefLive({
			...baseConfig,
			tlsEnabled: true,
			hostExplicit: true,
			host: "192.168.1.100",
		});
		const ensureCertsLayer = mockEnsureCerts(fakeCerts);
		const tlsLayer = TlsCertLive("/fake/config").pipe(
			Layer.provide(configRefLayer),
			Layer.provide(ensureCertsLayer),
		);
		const fullLayer = Layer.merge(tlsLayer, configRefLayer);

		return Effect.gen(function* () {
			const service = yield* TlsCertTag;
			expect(service.certs).toBe(fakeCerts);

			const ref = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(ref);
			expect(config.host).toBe("192.168.1.100");
			expect(config.tlsEnabled).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(fullLayer)));
	});
});
