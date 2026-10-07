import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	Deferred,
	Effect,
	Either,
	Exit,
	Fiber,
	FiberId,
	Layer,
	Option,
	Queue,
	Schema,
	Stream,
} from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import type { OpenCodeConnectionStatus } from "../../../contracts/ws-rpc.js";
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
import type {
	ConnectionHealth,
	InstanceStatus,
	ProjectRelayConfig,
} from "../../../types.js";
import { subscribeToDaemonEvents } from "../Services/daemon-pubsub.js";
import {
	getInstance,
	getInstances,
	getInstanceUrl,
	getManagedOpenCodeProcessEnv,
	scheduleRestart,
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
	readonly crashes?: {
		/** Ids of instances whose process status changed. */
		readonly statusChanges: Stream.Stream<string, never, Start>;
		/** Restarts a crashed managed instance with backoff; fails on giving up. */
		readonly restart: (
			instanceId: string,
		) => Effect.Effect<void, unknown, Start>;
	};
};

const endpointKey = (endpoint: OpenCodeEndpoint | undefined) =>
	JSON.stringify([
		endpoint?.url,
		endpoint?.auth?.username,
		endpoint?.auth?.password,
	]);

type InstanceStream = {
	readonly key: string;
	readonly managed: boolean;
	readonly source: SSEStream;
	readonly connected: Deferred.Deferred<void>;
	readonly reconciler: ReturnType<typeof createOpenCodeReconciler>;
	readonly reconcileClient: OpenCodeAPI | undefined;
};

const NO_STREAM_HEALTH: ConnectionHealth = {
	connected: false,
	lastEventAt: null,
	reconnectCount: 0,
	stale: false,
};

const CONNECT_TIMEOUT = "4 seconds";

/** Grace before an instance without demand stops, like the PTY host's idle timeout. */
const idleTimeoutFromEnv = Effect.sync(() => {
	const configured = process.env["CONDUIT_OPENCODE_IDLE_TIMEOUT_MS"];
	return configured === undefined ? 600_000 : Number(configured);
}).pipe(
	Effect.filterOrDieMessage(
		(ms) => Number.isInteger(ms) && ms > 0 && ms <= 2_147_483_647,
		"CONDUIT_OPENCODE_IDLE_TIMEOUT_MS must be an integer from 1 to 2147483647",
	),
);

export const makeOpenCodeInstancesLive = <R, Start = never, Stop = never>(
	resolveEndpoint: (
		instanceId: string,
	) => Effect.Effect<OpenCodeEndpoint | undefined, never, R>,
	options: {
		readonly log?: Logger;
		readonly control?: OpenCodeProcessControl<Start, Stop>;
		/** Defaults to CONDUIT_OPENCODE_IDLE_TIMEOUT_MS, else 10 minutes. */
		readonly idleTimeoutMs?: number;
	} = {},
) =>
	Layer.scoped(
		OpenCodeInstancesTag,
		Effect.gen(function* () {
			const { log = createLogger("daemon").child("opencode"), control } =
				options;
			const idleTimeoutMs =
				options.idleTimeoutMs ?? (yield* idleTimeoutFromEnv);
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
			// One /global/event stream per instance, open exactly while the
			// instance has demand or its grace timer runs. Demand is the open
			// `use` scopes counted here plus the busy sessions and pending
			// prompts the stream's reconciler sees. Guarded by `gate`.
			const streams = new Map<string, InstanceStream>();
			const holds = new Map<string, number>();
			const graces = new Map<
				string,
				{ readonly token: number; readonly fiber: Fiber.RuntimeFiber<void> }
			>();
			let graceTokens = 0;
			// Completes when an instance's stop finishes; `use` waits on it.
			const stopping = new Map<string, Deferred.Deferred<void>>();
			// Last lifecycle state per instance; only transitions are broadcast.
			const states = new Map<string, OpenCodeConnectionStatus>();
			// Reconcilers report demand changes from callbacks; settled in order.
			const demandChanged = yield* Queue.unbounded<string>();
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
			const subscribedDirectories = () =>
				[...subscribers].flatMap(({ directories }) => [...directories]);
			const broadcast = (event: OpenCodeInstanceEvent) => {
				for (const subscriber of subscribers) subscriber.send(event);
			};
			const resolveIn = (instanceId: string) =>
				resolveEndpoint(instanceId).pipe(Effect.provide(context));
			const setState = (
				instanceId: string,
				state: OpenCodeConnectionStatus,
			) => {
				if (states.get(instanceId) === state) return;
				states.set(instanceId, state);
				log.info("OpenCode instance state", { instanceId, state });
				broadcast({
					_tag: "connection",
					instanceId,
					state,
					health:
						streams.get(instanceId)?.source.getHealth() ?? NO_STREAM_HEALTH,
				});
			};
			const hasDemand = (instanceId: string) =>
				holds.has(instanceId) ||
				streams.get(instanceId)?.reconciler.active() === true;

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
						managed: endpoint?.managed === true,
						source,
						connected: yield* Deferred.make<void>(),
						reconciler: createOpenCodeReconciler({
							emit: (directory, payload) => {
								emitToDirectory(instanceId, source, directory, payload);
							},
							log,
							onChange: () => {
								Queue.unsafeOffer(demandChanged, instanceId);
							},
						}),
						reconcileClient:
							endpoint && sdk
								? new OpenCodeAPI({
										sdk: sdk.client,
										baseUrl: endpoint.url,
										authHeaders: sdk.authHeaders,
									})
								: undefined,
					};
					// A replaced or closed stream reports nothing.
					const current = () => streams.get(instanceId) === stream;
					// A managed process that died is the crash rule's call; a
					// managed one still running just reconnects unnoticed.
					const lost = () => {
						if (!current()) return;
						if (hasDemand(instanceId)) setState(instanceId, "reconnecting");
						else if (!stream.managed) setState(instanceId, "stopped");
					};
					source.on("connected", () => {
						Deferred.unsafeDone(stream.connected, Exit.void);
						if (!current()) return;
						setState(instanceId, "connected");
						if (stream.reconcileClient)
							void stream.reconciler.reconcile(
								stream.reconcileClient,
								subscribedDirectories(),
							);
					});
					source.on("disconnected", lost);
					source.on("reconnecting", lost);
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

			const cancelGrace = (instanceId: string) => {
				const grace = graces.get(instanceId);
				if (!grace) return Effect.void;
				graces.delete(instanceId);
				return Fiber.interruptFork(grace.fiber);
			};

			/**
			 * Arms the grace timer when an open stream has no demand, and cancels
			 * it when demand returns. Call under the gate.
			 */
			const settle = (instanceId: string): Effect.Effect<void> =>
				Effect.suspend(() => {
					const stream = streams.get(instanceId);
					const idle =
						stream !== undefined &&
						!stopping.has(instanceId) &&
						!holds.has(instanceId) &&
						!stream.reconciler.active();
					if (!idle) return cancelGrace(instanceId);
					if (graces.has(instanceId)) return Effect.void;
					const token = ++graceTokens;
					log.debug("OpenCode instance idle; grace timer armed", {
						instanceId,
						idleTimeoutMs,
					});
					// `use` settles from acquire/release, which are uninterruptible;
					// the timer must stay cancellable.
					return Effect.sleep(idleTimeoutMs).pipe(
						Effect.zipRight(expire(instanceId, token)),
						Effect.interruptible,
						Effect.forkIn(scope),
						Effect.flatMap((fiber) =>
							Effect.sync(() => {
								graces.set(instanceId, { token, fiber });
							}),
						),
					);
				});

			/**
			 * Marks the instance stopping and closes its stream (and any stream on
			 * the same endpoint). Call under the gate.
			 */
			const beginStop = (instanceId: string, key?: string) =>
				Effect.gen(function* () {
					const done = yield* Deferred.make<void>();
					stopping.set(instanceId, done);
					yield* cancelGrace(instanceId);
					yield* Effect.forEach(
						[...streams].filter(
							([id, stream]) => id === instanceId || stream.key === key,
						),
						([id]) => closeStream(id),
						{ discard: true },
					);
					return done;
				});

			/** Stops the process, if asked, then releases waiting `use` calls. */
			const finishStop = (
				instanceId: string,
				done: Deferred.Deferred<void>,
				stopProcess: boolean,
			) =>
				(control && stopProcess
					? control.stop(instanceId).pipe(Effect.provide(context))
					: Effect.void
				).pipe(
					Effect.ensuring(
						gate
							.withPermits(1)(
								Effect.sync(() => {
									stopping.delete(instanceId);
									setState(instanceId, "stopped");
								}),
							)
							.pipe(Effect.zipRight(Deferred.done(done, Exit.void))),
					),
				);

			/**
			 * Grace expiry: verify with the connect-time reconcile, then stop only
			 * if the instance still has no demand. External instances only lose
			 * their stream.
			 */
			const expire = (instanceId: string, token: number) =>
				Effect.gen(function* () {
					const stream = streams.get(instanceId);
					const client = stream?.reconcileClient;
					const verified =
						stream && client
							? yield* Effect.promise(() =>
									stream.reconciler.reconcile(client, subscribedDirectories()),
								)
							: true;
					const endpoint = yield* resolveIn(instanceId);
					yield* gate
						.withPermits(1)(
							Effect.suspend(() => {
								if (graces.get(instanceId)?.token !== token)
									return Effect.succeed(undefined);
								graces.delete(instanceId);
								if (
									!verified ||
									streams.get(instanceId) !== stream ||
									holds.has(instanceId) ||
									stream?.reconciler.active()
								) {
									log.info("OpenCode instance kept running at grace expiry", {
										instanceId,
										reason: verified ? "in use" : "reconcile failed",
									});
									return Effect.as(settle(instanceId), undefined);
								}
								log.info(
									endpoint?.managed
										? "Stopping idle OpenCode instance"
										: "Closing idle OpenCode instance stream",
									{ instanceId, idleTimeoutMs },
								);
								return beginStop(instanceId);
							}),
						)
						.pipe(
							Effect.flatMap((done) =>
								done
									? finishStop(instanceId, done, endpoint?.managed === true)
									: Effect.void,
							),
							Effect.uninterruptible,
						);
				});

			yield* Queue.take(demandChanged).pipe(
				Effect.flatMap((instanceId) => gate.withPermits(1)(settle(instanceId))),
				Effect.forever,
				Effect.forkIn(scope),
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
			// a spawn that other callers joined. A failure is not cached; it
			// closes any stream still retrying the dead endpoint.
			const start = (
				instanceId: string,
				pending: "starting" | "reconnecting",
				run: Effect.Effect<void, unknown, Start>,
			) =>
				Effect.suspend(() => {
					const running = starts.get(instanceId);
					if (running) return Deferred.await(running);
					const started = Deferred.unsafeMake<void, OpenCodeUnavailable>(
						FiberId.none,
					);
					starts.set(instanceId, started);
					setState(instanceId, pending);
					return run.pipe(
						Effect.provide(context),
						Effect.mapError((cause) => spawnFailed(instanceId, cause)),
						Effect.zipRight(resolveIn(instanceId)),
						Effect.filterOrFail(
							(endpoint) => !endpoint?.managed || endpoint.status === "healthy",
							(endpoint) =>
								spawnFailed(instanceId, `status is ${endpoint?.status}`),
						),
						Effect.exit,
						Effect.flatMap((exit) =>
							gate
								.withPermits(1)(
									Effect.suspend(() => {
										starts.delete(instanceId);
										if (Exit.isSuccess(exit)) return Effect.void;
										// A stop that won the race already settled the state.
										if (states.get(instanceId) !== "stopped")
											setState(instanceId, "failed");
										return closeStream(instanceId);
									}),
								)
								.pipe(
									Effect.zipRight(Deferred.done(started, Exit.asVoid(exit))),
								),
						),
						Effect.forkIn(scope),
						Effect.zipRight(Deferred.await(started)),
					);
				});

			/** Counts a `use` scope as demand, first waiting out a stop in progress. */
			const hold = (instanceId: string): Effect.Effect<void> =>
				gate
					.withPermits(1)(
						Effect.suspend(() => {
							const stop = stopping.get(instanceId);
							if (stop) return Effect.succeed(stop);
							holds.set(instanceId, (holds.get(instanceId) ?? 0) + 1);
							return Effect.as(settle(instanceId), undefined);
						}),
					)
					.pipe(
						Effect.flatMap((stop) =>
							stop
								? Deferred.await(stop).pipe(Effect.zipRight(hold(instanceId)))
								: Effect.void,
						),
					);

			const release = (instanceId: string) =>
				gate.withPermits(1)(
					Effect.suspend(() => {
						const remaining = (holds.get(instanceId) ?? 1) - 1;
						if (remaining > 0) holds.set(instanceId, remaining);
						else holds.delete(instanceId);
						return settle(instanceId);
					}),
				);

			const use = (instanceId: string, directory?: string) =>
				Effect.gen(function* () {
					yield* Effect.acquireRelease(hold(instanceId), () =>
						release(instanceId),
					);
					let endpoint = yield* resolveIn(instanceId);
					// Not running yet: never started, stopped, or a managed instance
					// that failed or crashed. External instances are only checked.
					if (
						endpoint &&
						control &&
						(endpoint.status === "stopped" ||
							(endpoint.managed && endpoint.status !== "healthy"))
					) {
						yield* start(instanceId, "starting", control.start(instanceId));
						endpoint = yield* resolveIn(instanceId);
					}
					if (!endpoint)
						return yield* new OpenCodeUnavailable({
							instanceId,
							reason: "not-configured",
							message: `OpenCode instance "${instanceId}" is not configured with a server URL`,
						});
					const opened = yield* gate.withPermits(1)(
						ensureStream(instanceId, endpoint),
					);
					const client = clientFor(endpoint, directory);
					const stream = streams.get(instanceId);
					if (stream?.source.isConnected()) {
						setState(instanceId, "connected");
						return client;
					}
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
								? gate.withPermits(1)(
										closeStream(instanceId).pipe(
											Effect.tap(() => setState(instanceId, "failed")),
										),
									)
								: Effect.void,
						),
					);
					return client;
				});

			// A survivor re-adopted at startup is running before any use. Open its
			// stream so reconcile-on-connect recovers busy sessions and pending
			// prompts; without demand its grace timer arms.
			if (control)
				yield* Effect.forEach(
					yield* control.adopted.pipe(Effect.provide(context)),
					(instanceId) =>
						Effect.flatMap(resolveIn(instanceId), (endpoint) =>
							endpoint
								? gate.withPermits(1)(
										ensureStream(instanceId, endpoint).pipe(
											Effect.zipRight(settle(instanceId)),
										),
									)
								: Effect.void,
						),
					{ discard: true },
				);

			// Crash rule: a managed process that died while its stream was open
			// restarts with backoff if it has demand; otherwise it stays stopped.
			// Starts and stops in progress own their failures.
			const crashes = control?.crashes;
			if (crashes)
				yield* crashes.statusChanges.pipe(
					Stream.runForEach((instanceId) =>
						Effect.gen(function* () {
							const endpoint = yield* resolveIn(instanceId);
							if (!endpoint?.managed || endpoint.status !== "unhealthy") return;
							const done = yield* gate.withPermits(1)(
								Effect.suspend(() => {
									if (
										!streams.has(instanceId) ||
										stopping.has(instanceId) ||
										starts.has(instanceId)
									)
										return Effect.succeed(undefined);
									if (!hasDemand(instanceId)) {
										log.info("OpenCode exited without demand; not restarting", {
											instanceId,
										});
										return beginStop(instanceId);
									}
									log.warn("OpenCode exited with demand; restarting", {
										instanceId,
									});
									return start(
										instanceId,
										"reconnecting",
										crashes.restart(instanceId),
									).pipe(
										Effect.zipRight(resolveIn(instanceId)),
										Effect.flatMap((restarted) =>
											gate.withPermits(1)(
												Effect.suspend(() =>
													stopping.has(instanceId)
														? Effect.void
														: ensureStream(instanceId, restarted).pipe(
																Effect.zipRight(settle(instanceId)),
															),
												),
											),
										),
										// A failed restart already closed the stream and failed.
										Effect.ignore,
										Effect.forkIn(scope),
										Effect.as(undefined),
									);
								}),
							);
							if (done) yield* finishStop(instanceId, done, true);
						}),
					),
					Effect.provide(context),
					Effect.forkIn(scope),
				);

			// Admin stop, regardless of demand. Waits out an idle stop first.
			const stop = (instanceId: string): Effect.Effect<void> =>
				Effect.gen(function* () {
					const key = endpointKey(yield* resolveIn(instanceId));
					const { started, done } = yield* gate.withPermits(1)(
						Effect.suspend(() => {
							const running = stopping.get(instanceId);
							return running
								? Effect.succeed({ started: false, done: running })
								: Effect.map(beginStop(instanceId, key), (done) => ({
										started: true,
										done,
									}));
						}),
					);
					if (started) return yield* finishStop(instanceId, done, true);
					yield* Deferred.await(done);
					yield* stop(instanceId);
				}).pipe(Effect.uninterruptible);

			return {
				// Subscribe path: registers a directory subscriber. Passive: it
				// neither opens a stream nor keeps one open.
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
												gate.withPermits(1)(
													Effect.sync(() => {
														subscribers.delete(member);
													}),
												),
										);
										const stream = streams.get(instanceId);
										const state = states.get(instanceId);
										if (state)
											subscriber.send({
												_tag: "connection",
												instanceId,
												state,
												health: stream?.source.getHealth() ?? NO_STREAM_HEALTH,
											});
										if (stream) {
											// A late subscriber gets its own replay; others never see it.
											if (stream.source.isConnected() && stream.reconcileClient)
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
						endpoint &&
						endpoint.status !== "stopped" &&
						!stopping.has(instanceId)
							? Option.some(clientFor(endpoint, directory))
							: Option.none(),
					),
				stop,
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
			crashes: {
				statusChanges: Stream.unwrapScoped(
					Effect.map(subscribeToDaemonEvents, (events) =>
						Stream.fromQueue(events).pipe(
							Stream.filterMap((event) =>
								event._tag === "InstanceStatusChanged"
									? Option.some(event.instanceId)
									: Option.none(),
							),
						),
					),
				),
				// Each attempt waits out the managed backoff; a failed spawn
				// tries again until the restart limit gives up.
				restart: (instanceId) =>
					Effect.gen(function* () {
						for (;;) {
							const attempt = yield* scheduleRestart(instanceId);
							if (!attempt)
								return yield* Effect.fail(
									new Error(
										`OpenCode instance "${instanceId}" restart limit reached`,
									),
								);
							yield* Fiber.join(attempt);
							if ((yield* getInstance(instanceId)).status !== "unhealthy")
								return;
						}
					}),
			},
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
