// ─── TLS Certificate Loading Layer ──────────────────────────────────────────
// Converts the imperative TLS cert loading block (daemon-main.ts) to an
// Effect Layer. Loads certs via `ensureCerts`, updates DaemonConfigRefTag
// on success/failure, and exposes loaded certs through TlsCertTag.
//
// DI: EnsureCertsTag allows tests to mock the `ensureCerts` call without
// vi.mock — inject controlled results via Layer.succeed(EnsureCertsTag, ...).

import { Context, Data, Effect, Layer, Ref } from "effect";
import type { TlsCerts } from "../../../cli/tls.js";
import { ensureCerts } from "../../../cli/tls.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";

// ─── Service interface ─────────────────────────────────────────────────────

export interface TlsCertService {
	readonly certs: TlsCerts | null;
	readonly caRootPath: string | null;
	readonly caCertDer: Buffer | null;
	readonly caCertPem: Buffer | null;
}

// ─── Context Tags ──────────────────────────────────────────────────────────

export class TlsCertTag extends Context.Tag("TlsCert")<
	TlsCertTag,
	TlsCertService
>() {}

// ─── Error type ────────────────────────────────────────────────────────────

export class TlsCertLoadError extends Data.TaggedError("TlsCertLoadError")<{
	cause: unknown;
}> {}

// ─── EnsureCerts DI tag (AP-R2-6) ──────────────────────────────────────────

export interface EnsureCertsService {
	ensureCerts: (opts: {
		configDir: string;
	}) => Effect.Effect<TlsCerts | null, TlsCertLoadError>;
}

export class EnsureCertsTag extends Context.Tag("EnsureCerts")<
	EnsureCertsTag,
	EnsureCertsService
>() {}

// ─── Production EnsureCerts layer ──────────────────────────────────────────

export const EnsureCertsLive = Layer.succeed(EnsureCertsTag, {
	ensureCerts: (opts) =>
		Effect.tryPromise({
			try: () => ensureCerts(opts),
			catch: (cause) => new TlsCertLoadError({ cause }),
		}),
});

// ─── Null result (reused in multiple branches) ─────────────────────────────

const nullResult: TlsCertService = {
	certs: null,
	caRootPath: null,
	caCertDer: null,
	caCertPem: null,
};

// ─── TlsCertLive Layer factory ─────────────────────────────────────────────

export const TlsCertLive = (configDir: string) =>
	Layer.effect(
		TlsCertTag,
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(configRef);

			// TLS not requested — short-circuit
			if (!config.tlsEnabled) {
				return nullResult;
			}

			const certService = yield* EnsureCertsTag;
			const certs = yield* certService.ensureCerts({ configDir }).pipe(
				Effect.catchTag("TlsCertLoadError", (_e) =>
					Effect.gen(function* () {
						yield* Effect.logWarning("TLS unavailable — falling back to HTTP");
						yield* Ref.update(configRef, (c) => ({
							...c,
							tlsEnabled: false,
						}));
						return null;
					}),
				),
			);

			// AP-15: ensureCerts can return null (mkcert not found)
			if (!certs) {
				yield* Effect.logWarning(
					"TLS unavailable — mkcert not found, falling back to HTTP",
				);
				yield* Ref.update(configRef, (c) => ({ ...c, tlsEnabled: false }));
				return nullResult;
			}

			// AP-12: Only change host when not explicitly set
			if (!config.hostExplicit) {
				yield* Ref.update(configRef, (c) => ({ ...c, host: "0.0.0.0" }));
			}

			return {
				certs,
				caRootPath: certs.caRoot ?? null,
				caCertDer: certs.caCertDer ?? null,
				caCertPem: certs.caCertPem ?? null, // AP-R2-5
			};
		}),
	);
