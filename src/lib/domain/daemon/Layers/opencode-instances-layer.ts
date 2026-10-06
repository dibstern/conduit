import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	Deferred,
	Effect,
	Either,
	Exit,
	FiberId,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveOpenCodeInstanceUrl,
} from "../../../daemon/config-persistence.js";
import { OpenCodeConnectionError } from "../../../errors.js";
import { openCodeAuth } from "../../../instance/managed-opencode-process.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { createSdkClient } from "../../../instance/sdk-factory.js";
import { createLogger, type Logger } from "../../../logger.js";
import { SSEStream } from "../../../relay/sse-stream.js";
import type { InstanceStatus, ProjectRelayConfig } from "../../../types.js";
import {
	getInstances,
	getInstanceUrl,
	getManagedOpenCodeProcessEnv,
	startInstance,
	stopInstance,
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
	/** Unknown (treated as running) when the resolver has no process state. */
	readonly status?: InstanceStatus;
	readonly managed?: boolean;
};

/** Process control for the instances behind the endpoints. */
type OpenCodeProcessControl<Start, Stop> = {
	/** Spawns a managed instance; begins health checks of an external one. */
	readonly start: (instanceId: string) => Effect.Effect<void, unknown, Start>;
	readonly stop: (instanceId: string) => Effect.Effect<void, never, Stop>;
	/** Instances running before any use: survivors re-adopted at startup. */
	readonly adopted: Effect.Effect<ReadonlyArray<string>, never, Start>;
};

const endpointKey = (endpoint: OpenCodeEndpoint | undefined) =>
	JSON.stringify([
		endpoint?.url,
		endpoint?.auth?.username,
		endpoint?.auth?.password,
	]);

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

export const makeOpenCodeInstancesLive = <R, Start = never, Stop = never>(
	resolveEndpoint: (
		instanceId: string,
	) => Effect.Effect<OpenCodeEndpoint | undefined, never, R>,
	options: {
		readonly log?: Logger;
		readonly control?: OpenCodeProcessControl<Start, Stop>;
	} = {},
) =>
	Layer.scoped(
		OpenCodeInstancesTag,
		Effect.gen(function* () {
			const { log = createLogger("daemon").child("opencode"), control } =
				options;
			const context = yield* Effect.context<R | Start | Stop>();
			const scope = yield* Effect.scope;
			const gate = yield* Effect.makeSemaphore(1);
			// One in-flight start per instance, joined by every `use`.
			const starts = new Map<
				string,
				Deferred.Deferred<void, OpenCodeUnavailable>
			>();
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
					const key = endpointKey(endpoint);
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

			const clientFor = (endpoint: OpenCodeEndpoint, directory?: string) => {
				const { client: sdk, authHeaders } = createSdkClient({
					baseUrl: endpoint.url,
					...(endpoint.auth ? { auth: endpoint.auth } : {}),
					...(directory !== undefined ? { directory } : {}),
				});
				return new OpenCodeAPI({ sdk, baseUrl: endpoint.url, authHeaders });
			};

			const spawnFailed = (instanceId: string, cause: unknown) =>
				new OpenCodeUnavailable({
					instanceId,
					reason: "spawn-failed",
					message: `OpenCode instance "${instanceId}" failed to start: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				});

			// Runs in the module's scope, so a caller's interruption cannot abandon
			// a spawn that other callers joined. A failure is not cached.
			const start = (
				instanceId: string,
				control: OpenCodeProcessControl<Start, Stop>,
			) =>
				Effect.suspend(() => {
					const running = starts.get(instanceId);
					if (running) return Deferred.await(running);
					const started = Deferred.unsafeMake<void, OpenCodeUnavailable>(
						FiberId.none,
					);
					starts.set(instanceId, started);
					return control.start(instanceId).pipe(
						Effect.provide(context),
						Effect.mapError((cause) => spawnFailed(instanceId, cause)),
						Effect.zipRight(resolveIn(instanceId)),
						Effect.filterOrFail(
							(endpoint) => !endpoint?.managed || endpoint.status === "healthy",
							(endpoint) =>
								spawnFailed(instanceId, `status is ${endpoint?.status}`),
						),
						Effect.exit,
						Effect.flatMap((exit) => {
							starts.delete(instanceId);
							return Deferred.done(started, Exit.asVoid(exit));
						}),
						Effect.forkIn(scope),
						Effect.zipRight(Deferred.await(started)),
					);
				});

			const use = (instanceId: string, directory?: string) =>
				Effect.gen(function* () {
					let endpoint = yield* resolveIn(instanceId);
					// Not running yet: never started, stopped, or a managed instance
					// that failed or crashed. External instances are only checked.
					if (
						endpoint &&
						control &&
						(endpoint.status === "stopped" ||
							(endpoint.managed && endpoint.status !== "healthy"))
					) {
						yield* start(instanceId, control);
						endpoint = yield* resolveIn(instanceId);
					}
					if (!endpoint)
						return yield* new OpenCodeUnavailable({
							instanceId,
							reason: "not-configured",
							message: `OpenCode instance "${instanceId}" is not configured with a server URL`,
						});
					const resolved = endpoint;
					const opened = yield* Effect.acquireRelease(
						gate.withPermits(1)(
							Effect.suspend(() => {
								uses++;
								return ensureStream(instanceId, resolved);
							}),
						),
						() =>
							releaseHold(() => {
								uses--;
							}),
					);
					const client = clientFor(endpoint, directory);
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

			// A survivor re-adopted at startup is running before any use. Hold its
			// stream open so reconcile-on-connect recovers busy sessions and
			// pending prompts for every subscribed directory.
			if (control)
				yield* Effect.forEach(
					yield* control.adopted.pipe(Effect.provide(context)),
					(instanceId) =>
						Effect.flatMap(resolveIn(instanceId), (endpoint) =>
							endpoint
								? gate.withPermits(1)(
										Effect.suspend(() => {
											uses++;
											return ensureStream(instanceId, endpoint);
										}),
									)
								: Effect.void,
						),
					{ discard: true },
				);

			return {
				// Subscribe path: registers a directory subscriber. Passive: only
				// `use` opens a stream; subscribers keep open streams alive.
				events: (
					directories: readonly string[],
					instanceId: string = defaultInstanceIdForDriver("opencode"),
				) =>
					Stream.asyncScoped<OpenCodeInstanceEvent>(
						(emit) =>
							gate
								.withPermits(1)(
									Effect.gen(function* () {
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
										const stream = streams.get(instanceId);
										if (stream) {
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
				// Reads process state only: no request, no stream, never a start.
				ifRunning: (instanceId: string, directory?: string) =>
					Effect.map(resolveIn(instanceId), (endpoint) =>
						endpoint && endpoint.status !== "stopped"
							? Option.some(clientFor(endpoint, directory))
							: Option.none(),
					),
				stop: (instanceId: string) =>
					Effect.gen(function* () {
						const key = endpointKey(yield* resolveIn(instanceId));
						if (control)
							yield* control.stop(instanceId).pipe(Effect.provide(context));
						yield* gate.withPermits(1)(
							Effect.forEach(
								[...streams].filter(
									([id, stream]) => id === instanceId || stream.key === key,
								),
								([id]) => closeStream(id),
								{ discard: true },
							),
						);
					}),
			};
		}),
	);

export const OpenCodeInstancesLive = makeOpenCodeInstancesLive(
	(instanceId) =>
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
			return {
				url,
				status: instance.status,
				managed: instance.managed,
				...(auth ? { auth } : {}),
			};
		}),
	{
		control: {
			start: startInstance,
			adopted: Effect.map(getInstances, (instances) =>
				Array.from(instances).flatMap(({ id, driver, managed, status }) =>
					(driver ?? "opencode") === "opencode" &&
					managed &&
					status === "healthy"
						? [id]
						: [],
				),
			),
			stop: (instanceId) =>
				stopInstance(instanceId).pipe(
					Effect.catchAllCause((cause) =>
						Effect.logWarning("OpenCode instance stop failed", cause),
					),
				),
		},
	},
);

/** Relay without a daemon: endpoints come from relay config and the daemon config file. */
export const makeStandaloneOpenCodeInstancesLive = (
	config: Pick<
		ProjectRelayConfig,
		"opencodeUrl" | "opencodeAuth" | "configDir" | "log"
	>,
) =>
	makeOpenCodeInstancesLive(
		(instanceId) =>
			Effect.sync(() => {
				if (instanceId === defaultInstanceIdForDriver("opencode"))
					return config.opencodeUrl === undefined
						? undefined
						: {
								url: config.opencodeUrl,
								...(config.opencodeAuth ? { auth: config.opencodeAuth } : {}),
							};
				const daemonConfig = loadDaemonConfig(config.configDir);
				const url = resolveOpenCodeInstanceUrl(daemonConfig, instanceId);
				const auth = openCodeAuth(
					daemonConfig?.instances?.find(({ id }) => id === instanceId)?.env,
				);
				return url === undefined
					? undefined
					: { url, ...(auth ? { auth } : {}) };
			}),
		config.log ? { log: config.log.child("opencode") } : {},
	);
