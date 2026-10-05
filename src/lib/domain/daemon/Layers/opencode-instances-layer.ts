import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	Deferred,
	Effect,
	Either,
	Exit,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import { OpenCodeConnectionError } from "../../../errors.js";
import { openCodeAuth } from "../../../instance/managed-opencode-process.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { createSdkClient } from "../../../instance/sdk-factory.js";
import { createLogger, type Logger } from "../../../logger.js";
import { SSEStream } from "../../../relay/sse-stream.js";
import {
	getInstances,
	getInstanceUrl,
	getManagedOpenCodeProcessEnv,
} from "../Services/instance-manager-service.js";
import {
	type OpenCodeInstanceEvent,
	OpenCodeInstancesTag,
	OpenCodeUnavailable,
} from "../Services/opencode-instances-service.js";
import {
	createOpenCodeReconciler,
	type OpenCodePayload,
} from "./opencode-instances-reconcile.js";

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

export type OpenCodeEndpoint = {
	readonly url: string;
	readonly auth?: { readonly username: string; readonly password: string };
};

type Connection = Extract<OpenCodeInstanceEvent, { _tag: "connection" }>;

type InstanceStream = {
	readonly key: string;
	readonly source: SSEStream;
	readonly connected: Deferred.Deferred<void>;
	readonly reconciler: ReturnType<typeof createOpenCodeReconciler>;
	readonly reconcileClient: OpenCodeAPI | undefined;
	connection: Connection;
};

const CONNECT_TIMEOUT = "4 seconds";

export const makeOpenCodeInstancesLive = <R>(
	resolveEndpoint: (
		instanceId: string,
	) => Effect.Effect<OpenCodeEndpoint | undefined, never, R>,
	log: Logger = createLogger("daemon").child("opencode"),
) =>
	Layer.scoped(
		OpenCodeInstancesTag,
		Effect.gen(function* () {
			const context = yield* Effect.context<R>();
			const gate = yield* Effect.makeSemaphore(1);
			const subscribers = new Set<{
				directories: ReadonlySet<string>;
				send: (event: OpenCodeInstanceEvent) => void;
			}>();
			// One /global/event stream per instance. Streams stay open while
			// anything holds the module: an events subscriber or a `use` scope.
			const streams = new Map<string, InstanceStream>();
			let uses = 0;
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
			const broadcast = (event: OpenCodeInstanceEvent) => {
				for (const subscriber of subscribers) subscriber.send(event);
			};
			const resolveIn = (instanceId: string) =>
				resolveEndpoint(instanceId).pipe(Effect.provide(context));

			const emitToDirectory = (
				instanceId: string,
				source: SSEStream,
				directory: string,
				payload: OpenCodePayload,
			) => {
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

			// Per-stream connect path: opens one instance's /global/event stream,
			// routes its envelopes to subscribers by directory, and recovers
			// pending prompts and session statuses on every (re)connect.
			const openStream = (
				instanceId: string,
				endpoint: OpenCodeEndpoint | undefined,
				key: string,
			) =>
				Effect.gen(function* () {
					const sdk = endpoint
						? createSdkClient({
								baseUrl: endpoint.url,
								...(endpoint.auth ? { auth: endpoint.auth } : {}),
							})
						: undefined;
					const client = sdk?.client;
					const source = new SSEStream({
						api: {
							event: {
								subscribe: async (options) => {
									if (!client)
										throw new OpenCodeConnectionError({
											message: `No OpenCode instance "${instanceId}" configured`,
										});
									return client.global.event(options);
								},
							},
						},
						log,
					});
					const stream: InstanceStream = {
						key,
						source,
						connected: yield* Deferred.make<void>(),
						reconciler: createOpenCodeReconciler({
							emit: (directory, payload) => {
								emitToDirectory(instanceId, source, directory, payload);
							},
							log,
						}),
						reconcileClient:
							endpoint && sdk
								? new OpenCodeAPI({
										sdk: sdk.client,
										baseUrl: endpoint.url,
										authHeaders: sdk.authHeaders,
									})
								: undefined,
						connection: {
							_tag: "connection",
							instanceId,
							state: "disconnected",
							health: source.getHealth(),
						},
					};
					const setConnection = (
						state: Connection["state"],
						extra: Partial<Connection> = {},
					) => {
						stream.connection = {
							_tag: "connection",
							instanceId,
							state,
							health: source.getHealth(),
							...extra,
						};
						broadcast(stream.connection);
					};
					source.on("connected", () => {
						Deferred.unsafeDone(stream.connected, Exit.void);
						setConnection("connected");
						if (stream.reconcileClient)
							void stream.reconciler.reconcile(
								stream.reconcileClient,
								[...subscribers].flatMap(({ directories }) => [...directories]),
							);
					});
					source.on("disconnected", (error) =>
						setConnection("disconnected", error ? { error } : {}),
					);
					source.on("reconnecting", (info) =>
						setConnection("reconnecting", info),
					);
					source.on("event", (raw) => {
						const decoded = decodeEnvelope(raw);
						if (Either.isLeft(decoded)) {
							log.warn("Skipping undecodable OpenCode global envelope", {
								instanceId,
								raw,
								error: String(decoded.left),
							});
							return;
						}
						const { directory, payload } = decoded.right;
						// Global keepalives have no directory. SSEStream already records
						// every yielded frame as liveness and runs its stale watchdog.
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
							canonical !== undefined &&
							emitToDirectory(instanceId, source, canonical, payload);
						if (delivered) stream.reconciler.observe(canonical, payload);
						else
							log.debug("Dropping OpenCode event for unsubscribed directory", {
								instanceId,
								directory,
								type: payload.type,
							});
					});
					streams.set(instanceId, stream);
					broadcast(stream.connection);
					yield* source.connectEffect();
				});

			const closeStream = (instanceId: string) =>
				Effect.gen(function* () {
					const stream = streams.get(instanceId);
					if (!stream) return;
					streams.delete(instanceId);
					stream.reconciler.reset();
					yield* stream.source.drainEffect();
				});

			/** Opens or replaces the stream when its endpoint changed. Call under the gate. */
			const ensureStream = (
				instanceId: string,
				endpoint: OpenCodeEndpoint | undefined,
			) =>
				Effect.gen(function* () {
					const key = JSON.stringify([
						endpoint?.url,
						endpoint?.auth?.username,
						endpoint?.auth?.password,
					]);
					if (streams.get(instanceId)?.key === key) return false;
					yield* closeStream(instanceId);
					yield* openStream(instanceId, endpoint, key);
					return true;
				});

			const releaseHold = (drop: () => void) =>
				gate.withPermits(1)(
					Effect.gen(function* () {
						drop();
						if (subscribers.size + uses > 0) return;
						yield* Effect.forEach([...streams.keys()], closeStream, {
							discard: true,
						});
					}),
				);

			yield* Effect.addFinalizer(() =>
				Effect.forEach([...streams.keys()], closeStream, { discard: true }),
			);

			const unreachable = (instanceId: string, url: string, cause: unknown) =>
				new OpenCodeUnavailable({
					instanceId,
					reason: "unreachable",
					message: `OpenCode instance "${instanceId}" is unreachable at ${url}: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				});

			const use = (instanceId: string, directory?: string) =>
				Effect.gen(function* () {
					const endpoint = yield* resolveIn(instanceId);
					if (!endpoint)
						return yield* new OpenCodeUnavailable({
							instanceId,
							reason: "not-configured",
							message: `OpenCode instance "${instanceId}" is not configured with a server URL`,
						});
					const opened = yield* Effect.acquireRelease(
						gate.withPermits(1)(
							Effect.suspend(() => {
								uses++;
								return ensureStream(instanceId, endpoint);
							}),
						),
						() =>
							releaseHold(() => {
								uses--;
							}),
					);
					const { client: sdk, authHeaders } = createSdkClient({
						baseUrl: endpoint.url,
						...(endpoint.auth ? { auth: endpoint.auth } : {}),
						...(directory !== undefined ? { directory } : {}),
					});
					const client = new OpenCodeAPI({
						sdk,
						baseUrl: endpoint.url,
						authHeaders,
					});
					const stream = streams.get(instanceId);
					if (stream?.connection.state === "connected") return client;
					yield* Effect.tryPromise({
						try: () => client.app.path(),
						catch: (cause) => cause,
					}).pipe(
						Effect.timeout(CONNECT_TIMEOUT),
						Effect.mapError((cause) =>
							unreachable(instanceId, endpoint.url, cause),
						),
						// A freshly opened stream must be live before the caller acts,
						// or events for that action could be missed.
						Effect.zipRight(
							opened && stream
								? Deferred.await(stream.connected).pipe(
										Effect.timeoutFail({
											duration: CONNECT_TIMEOUT,
											onTimeout: () =>
												unreachable(
													instanceId,
													endpoint.url,
													"event stream did not connect",
												),
										}),
									)
								: Effect.void,
						),
						// Don't leave a stream this call opened retrying a dead server.
						Effect.tapError(() =>
							opened && streams.get(instanceId) === stream
								? gate.withPermits(1)(closeStream(instanceId))
								: Effect.void,
						),
					);
					return client;
				});

			return {
				// Subscribe path: registers a directory subscriber and holds the
				// given instance's stream open.
				events: (
					directories: readonly string[],
					instanceId: string = defaultInstanceIdForDriver("opencode"),
				) =>
					Stream.asyncScoped<OpenCodeInstanceEvent>(
						(emit) =>
							gate
								.withPermits(1)(
									Effect.gen(function* () {
										const endpoint = yield* resolveIn(instanceId);
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
												releaseHold(() => {
													subscribers.delete(member);
												}),
										);
										const opened = yield* ensureStream(instanceId, endpoint);
										const stream = streams.get(instanceId);
										if (!opened && stream) {
											subscriber.send({
												...stream.connection,
												health: stream.source.getHealth(),
											});
											// A late subscriber gets its own replay; others never see it.
											if (
												stream.connection.state === "connected" &&
												stream.reconcileClient
											)
												void stream.reconciler.reconcile(
													stream.reconcileClient,
													subscriber.directories,
													(_directory, payload) =>
														subscriber.send({
															_tag: "event",
															instanceId,
															payload,
															health: stream.source.getHealth(),
														}),
												);
										}
										return subscriber;
									}),
								)
								.pipe(Effect.uninterruptible),
						"unbounded",
					),
				use,
				ifRunning: (instanceId: string, directory?: string) =>
					use(instanceId, directory).pipe(
						Effect.map(Option.some),
						Effect.catchTag("OpenCodeUnavailable", () =>
							Effect.succeed(Option.none()),
						),
					),
			};
		}),
	);

export const OpenCodeInstancesLive = makeOpenCodeInstancesLive((instanceId) =>
	Effect.gen(function* () {
		const instances = Array.from(yield* getInstances).filter(
			({ driver }) => (driver ?? "opencode") === "opencode",
		);
		// The default id names the daemon's first OpenCode instance when no
		// instance carries that id.
		const instance =
			instances.find(({ id }) => id === instanceId) ??
			(instanceId === defaultInstanceIdForDriver("opencode")
				? instances[0]
				: undefined);
		const url = instance ? yield* getInstanceUrl(instance.id) : null;
		if (!instance || !url) return undefined;
		const auth = openCodeAuth(
			instance.managed
				? yield* getManagedOpenCodeProcessEnv(instance.id)
				: instance.env,
		);
		return { url, ...(auth ? { auth } : {}) };
	}),
);
