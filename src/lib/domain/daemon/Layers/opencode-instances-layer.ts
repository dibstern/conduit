import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Effect, Either, Layer, Schema, Stream } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import { OpenCodeConnectionError } from "../../../errors.js";
import { openCodeAuth } from "../../../instance/managed-opencode-process.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { createSdkClientEffect } from "../../../instance/sdk-factory.js";
import { createLogger, type Logger } from "../../../logger.js";
import { SSEStream, type SSEStreamOptions } from "../../../relay/sse-stream.js";
import {
	getInstances,
	getInstanceUrl,
	getManagedOpenCodeProcessEnv,
} from "../Services/instance-manager-service.js";
import {
	type OpenCodeInstanceEvent,
	OpenCodeInstancesTag,
} from "../Services/opencode-instances-service.js";
import {
	createOpenCodeReconciler,
	type OpenCodePayload,
	type OpenCodeReconcileClient,
} from "./opencode-instances-reconcile.js";

/** Stream source plus the directory-scoped reads used for recovery. */
export type OpenCodeInstancesApi = SSEStreamOptions["api"] & {
	readonly reconcile?: OpenCodeReconcileClient;
};

// Pin the transport envelope, not the SDK's event vocabulary. `sync` frames
// have syncEvent instead of properties; preserve the entire inner payload.
const decodeEnvelope = Schema.decodeUnknownEither(
	Schema.Struct({
		directory: Schema.optional(Schema.String),
		project: Schema.optional(Schema.String),
		payload: Schema.Struct({
			id: Schema.String,
			type: Schema.String,
			properties: Schema.optional(
				Schema.Record({ key: Schema.String, value: Schema.Unknown }),
			),
			syncEvent: Schema.optional(Schema.Unknown),
		}),
	}),
	{ onExcessProperty: "preserve" },
);

export const makeOpenCodeInstancesLive = <R>(
	api: Effect.Effect<OpenCodeInstancesApi, never, R>,
	log: Logger = createLogger("daemon").child("opencode"),
) =>
	Layer.scoped(
		OpenCodeInstancesTag,
		Effect.gen(function* () {
			const context = yield* Effect.context<R>();
			const gate = yield* Effect.makeSemaphore(1);
			const instanceId = defaultInstanceIdForDriver("opencode");
			const subscribers = new Set<{
				directories: ReadonlySet<string>;
				send: (event: OpenCodeInstanceEvent) => void;
			}>();
			const paths = new Map<string, string>();
			const normalize = (directory: string) => {
				const cached = paths.get(directory);
				if (cached !== undefined) return cached;
				const absolute = resolve(directory);
				let canonical = absolute;
				try {
					canonical = realpathSync(absolute);
				} catch (error) {
					log.debug("OpenCode directory realpath unavailable", {
						directory,
						error,
					});
				}
				paths.set(directory, canonical);
				return canonical;
			};
			let currentApi: OpenCodeInstancesApi | undefined;
			const source = new SSEStream({
				api: {
					event: {
						subscribe: async (options) => {
							if (!currentApi)
								throw new OpenCodeConnectionError({
									message: "OpenCode stream has no configured instance",
								});
							return currentApi.event.subscribe(options);
						},
					},
				},
				log,
			});
			let connection: Extract<OpenCodeInstanceEvent, { _tag: "connection" }> = {
				_tag: "connection",
				instanceId,
				state: "disconnected",
				health: source.getHealth(),
			};
			const broadcast = (event: OpenCodeInstanceEvent) => {
				for (const subscriber of subscribers) subscriber.send(event);
			};
			const emitToDirectory = (directory: string, payload: OpenCodePayload) => {
				let delivered = false;
				for (const subscriber of subscribers) {
					if (!subscriber.directories.has(directory)) continue;
					subscriber.send({
						_tag: "event",
						instanceId,
						payload,
						health: source.getHealth(),
					});
					delivered = true;
				}
				return delivered;
			};
			const reconciler = createOpenCodeReconciler({
				emit: emitToDirectory,
				log,
			});
			source.on("connected", () => {
				connection = {
					_tag: "connection",
					instanceId,
					state: "connected",
					health: source.getHealth(),
				};
				broadcast(connection);
				if (currentApi?.reconcile)
					void reconciler.reconcile(
						currentApi.reconcile,
						[...subscribers].flatMap(({ directories }) => [...directories]),
					);
			});
			source.on("disconnected", (error) => {
				connection = {
					_tag: "connection",
					instanceId,
					state: "disconnected",
					health: source.getHealth(),
					...(error ? { error } : {}),
				};
				broadcast(connection);
			});
			source.on("reconnecting", (info) => {
				connection = {
					_tag: "connection",
					instanceId,
					state: "reconnecting",
					health: source.getHealth(),
					...info,
				};
				broadcast(connection);
			});
			source.on("event", (raw) => {
				const decoded = decodeEnvelope(raw);
				if (Either.isLeft(decoded)) {
					log.warn("Skipping undecodable OpenCode global envelope", {
						raw,
						error: String(decoded.left),
					});
					return;
				}
				const { directory, payload } = decoded.right;
				// Global keepalives have no directory. SSEStream already records every
				// yielded frame as liveness and runs its normal stale watchdog.
				if (
					directory === undefined &&
					(payload.type === "server.connected" ||
						payload.type === "server.heartbeat")
				) {
					broadcast({
						_tag: "heartbeat",
						instanceId,
						health: source.getHealth(),
					});
					return;
				}
				const canonical =
					directory !== undefined && isAbsolute(directory)
						? normalize(directory)
						: undefined;
				const delivered =
					canonical !== undefined && emitToDirectory(canonical, payload);
				if (delivered) reconciler.observe(canonical, payload);
				else
					log.debug("Dropping OpenCode event for unsubscribed directory", {
						directory,
						type: payload.type,
					});
			});
			yield* Effect.addFinalizer(() => source.drainEffect());
			return {
				events: (directories: readonly string[]) =>
					Stream.asyncScoped<OpenCodeInstanceEvent>(
						(emit) =>
							gate
								.withPermits(1)(
									Effect.gen(function* () {
										const nextApi = yield* api.pipe(Effect.provide(context));
										const subscriber = yield* Effect.acquireRelease(
											Effect.sync(() => {
												const member = {
													directories: new Set(directories.map(normalize)),
													send: (event: OpenCodeInstanceEvent) => {
														void emit.single(event).catch(() => {});
													},
												};
												subscribers.add(member);
												return member;
											}),
											(member) =>
												gate.withPermits(1)(
													Effect.gen(function* () {
														subscribers.delete(member);
														if (subscribers.size === 0) {
															reconciler.reset();
															yield* source.drainEffect();
															currentApi = undefined;
															connection = {
																_tag: "connection",
																instanceId,
																state: "disconnected",
																health: source.getHealth(),
															};
														}
													}),
												),
										);
										if (currentApi !== nextApi) {
											if (currentApi) yield* source.drainEffect();
											currentApi = nextApi;
											connection = {
												_tag: "connection",
												instanceId,
												state: "disconnected",
												health: source.getHealth(),
											};
											broadcast(connection);
											yield* source.connectEffect();
										} else {
											subscriber.send({
												...connection,
												health: source.getHealth(),
											});
											// Late subscribers missed the connect-time reconcile.
											if (connection.state === "connected" && nextApi.reconcile)
												void reconciler.reconcile(
													nextApi.reconcile,
													subscriber.directories,
													(_directory, payload) =>
														subscriber.send({
															_tag: "event",
															instanceId,
															payload,
															health: source.getHealth(),
														}),
												);
										}
										return subscriber;
									}),
								)
								.pipe(Effect.uninterruptible),
						"unbounded",
					),
			};
		}),
	);

export const OpenCodeInstancesLive = Layer.suspend(() => {
	let cached: { key: string; api: OpenCodeInstancesApi } | undefined;
	return makeOpenCodeInstancesLive(
		Effect.gen(function* () {
			const instances = Array.from(yield* getInstances);
			const instance = instances.find(
				({ driver }) => (driver ?? "opencode") === "opencode",
			);
			const url = instance ? yield* getInstanceUrl(instance.id) : null;
			if (!instance || !url)
				return {
					event: {
						subscribe: async () => {
							throw new OpenCodeConnectionError({
								message: "No default OpenCode instance configured",
							});
						},
					},
				};
			const auth = openCodeAuth(
				instance.managed
					? yield* getManagedOpenCodeProcessEnv(instance.id)
					: instance.env,
			);
			// Keep SDK identity stable for unchanged subscriptions. A new relay
			// resolves current daemon configuration and can replace a stale endpoint.
			const key = JSON.stringify([url, auth?.username, auth?.password]);
			if (cached?.key === key) return cached.api;
			const { client, authHeaders } = yield* createSdkClientEffect({
				baseUrl: url,
				...(auth ? { auth } : {}),
			});
			const api = {
				event: { subscribe: (options) => client.global.event(options) },
				reconcile: new OpenCodeAPI({ sdk: client, baseUrl: url, authHeaders }),
			} satisfies OpenCodeInstancesApi;
			cached = { key, api };
			return api;
		}),
	);
});
