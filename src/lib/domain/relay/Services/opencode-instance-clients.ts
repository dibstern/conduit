// ─── OpenCode Instance Clients (Phase 4.4) ──────────────────────────────────
// Relay-scoped lazy API clients + SSE streams for NAMED OpenCode instances.
// A session bound to a named OpenCode instance runs on that instance's real
// server: its session is created there, its turns are prompted there, and its
// events stream back through a second SSEStream wired into the SAME relay
// pipeline as the default stream (turn completion, streaming, persistence).
//
// Everything else (status/message pollers, pending permission/question
// recovery lists, file ops, model discovery, PTY, REST history) stays on the
// project-default instance — accepted degradation for named instances.

import { Context, Deferred, Effect, Layer } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveOpenCodeInstanceUrl,
} from "../../../daemon/config-persistence.js";
import { GapEndpoints } from "../../../instance/gap-endpoints.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { createSdkClient } from "../../../instance/sdk-factory.js";
import { SSEStream, type SSEStreamPort } from "../../../relay/sse-stream.js";
import { ConfigTag, LoggerTag } from "./services.js";

const NAMED_INSTANCE_CONNECT_TIMEOUT = "4 seconds";

export interface OpenCodeInstanceClients {
	/**
	 * Resolve the API client for the given provider instance id.
	 * Returns undefined for the default "opencode" id — callers use the relay's
	 * project-default client. Fails when a NAMED instance cannot be resolved
	 * (unknown id, missing URL, or the relay SSE pipeline is unavailable) so
	 * callers surface a clean error instead of silently using the default
	 * server. The first successful resolution of a named instance builds its
	 * client, wires a dedicated SSEStream into the relay pipeline, and caches
	 * both for the relay lifetime.
	 */
	clientFor(instanceId: string): Effect.Effect<OpenCodeAPI | undefined, Error>;
	/**
	 * Register the relay's SSE pipeline wirer. Called once at relay startup
	 * (after monitoring wiring exists). Each lazily created named-instance
	 * stream is passed through it before connecting, so named-instance events
	 * flow through the exact same consumer pipeline as the default stream.
	 */
	registerStreamWirer<R>(
		wirer: (stream: SSEStreamPort) => Effect.Effect<void, never, R>,
	): Effect.Effect<void, never, R>;
}

export class OpenCodeInstanceClientsTag extends Context.Tag(
	"OpenCodeInstanceClients",
)<OpenCodeInstanceClientsTag, OpenCodeInstanceClients>() {}

export const OpenCodeInstanceClientsLive: Layer.Layer<
	OpenCodeInstanceClientsTag,
	never,
	ConfigTag | LoggerTag
> = Layer.scoped(
	OpenCodeInstanceClientsTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const log = (yield* LoggerTag).child("opencode-instances");
		const bundles = new Map<string, { api: OpenCodeAPI; stream: SSEStream }>();
		const buildLock = yield* Effect.makeSemaphore(1);
		let streamWirer:
			| ((stream: SSEStreamPort) => Effect.Effect<void>)
			| undefined;

		yield* Effect.addFinalizer(() =>
			Effect.forEach(
				[...bundles.values()],
				(bundle) => bundle.stream.drainEffect(),
				{ discard: true },
			),
		);

		const defaultOpenCodeId = defaultInstanceIdForDriver("opencode");

		const buildBundle = (
			instanceId: string,
		): Effect.Effect<OpenCodeAPI, Error> =>
			Effect.gen(function* () {
				const existing = bundles.get(instanceId);
				if (existing) return existing.api;

				const url = resolveOpenCodeInstanceUrl(
					loadDaemonConfig(config.configDir),
					instanceId,
				);
				if (url === undefined) {
					return yield* Effect.fail(
						new Error(
							`OpenCode instance "${instanceId}" is not configured with a reachable server URL`,
						),
					);
				}
				const wirer = streamWirer;
				if (wirer === undefined) {
					return yield* Effect.fail(
						new Error(
							`OpenCode instance "${instanceId}" cannot be used: the relay SSE pipeline is unavailable`,
						),
					);
				}

				// Same construction as OpenCodeAPILive, with the instance's URL.
				const {
					client: sdkClient,
					fetch: sdkFetch,
					authHeaders,
				} = createSdkClient({
					baseUrl: url,
					...(config.noServer && config.projectDir != null
						? { directory: config.projectDir }
						: {}),
				});
				const api = new OpenCodeAPI({
					sdk: sdkClient,
					gapEndpoints: new GapEndpoints({
						baseUrl: url,
						fetch: sdkFetch,
						headers: authHeaders,
					}),
					baseUrl: url,
					authHeaders,
				});
				yield* Effect.tryPromise({
					try: () => api.app.path(),
					catch: (cause) =>
						cause instanceof Error ? cause : new Error(String(cause)),
				}).pipe(
					Effect.timeoutFail({
						duration: NAMED_INSTANCE_CONNECT_TIMEOUT,
						onTimeout: () =>
							new Error(
								`Timed out reaching OpenCode instance "${instanceId}" at ${url}`,
							),
					}),
				);
				const stream = new SSEStream({ api, log: log.child(instanceId) });
				const connected = yield* Deferred.make<void, Error>();
				stream.on("connected", () => {
					Deferred.unsafeDone(connected, Effect.void);
				});
				stream.on("error", (error) => {
					Deferred.unsafeDone(connected, Effect.fail(error));
				});
				yield* wirer(stream);
				yield* stream.connectEffect();
				const connectionResult = yield* Effect.either(
					Deferred.await(connected).pipe(
						Effect.timeoutFail({
							duration: NAMED_INSTANCE_CONNECT_TIMEOUT,
							onTimeout: () =>
								new Error(
									`Timed out connecting to OpenCode instance "${instanceId}" at ${url}`,
								),
						}),
					),
				);
				if (connectionResult._tag === "Left") {
					yield* stream.drainEffect();
					return yield* Effect.fail(connectionResult.left);
				}
				bundles.set(instanceId, { api, stream });
				yield* Effect.sync(() =>
					log.info(`✓ OpenCode instance "${instanceId}" connected: ${url}`),
				);
				return api;
			});

		return {
			clientFor: (instanceId) =>
				instanceId === defaultOpenCodeId
					? Effect.succeed(undefined)
					: buildLock.withPermits(1)(buildBundle(instanceId)),
			registerStreamWirer: <R>(
				wirer: (stream: SSEStreamPort) => Effect.Effect<void, never, R>,
			): Effect.Effect<void, never, R> =>
				Effect.context<R>().pipe(
					Effect.map((context) => {
						streamWirer = (stream) =>
							wirer(stream).pipe(Effect.provide(context));
						return undefined;
					}),
				),
		} satisfies OpenCodeInstanceClients;
	}),
);
