import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberMap,
	Layer,
	Option,
	Queue,
	Result,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import {
	getProviderDriver,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../../../contracts/provider-instance.js";
import type { OpenCodeConnectionStatus } from "../../../contracts/ws-rpc.js";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
	resolveOpenCodeInstanceUrl,
} from "../../../daemon/config-persistence.js";
import { OpenCodeConnectionError } from "../../../errors.js";
import { instanceIdleTimeoutFromEnv } from "../../../instance/idle-policy.js";
import { openCodeAuth } from "../../../instance/managed-opencode-process.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { createSdkClient } from "../../../instance/sdk-factory.js";
import { createLogger, type Logger } from "../../../logger.js";
import { openCodePromptProcessId } from "../../../provider/opencode-process-identity.js";
import { SSEStream } from "../../../relay/sse-stream.js";
import type {
	ConnectionHealth,
	InstanceStatus,
	ProjectRelayConfig,
} from "../../../types.js";
import { subscribeToDaemonEvents } from "../Services/daemon-pubsub.js";
import {
	checkInstanceHealth,
	getInstance,
	getInstances,
	getInstanceUrl,
	getManagedOpenCodeProcessEnv,
	getManagedOpenCodeProcessIdentity,
	isManagedOpenCodeStopped,
	scheduleRestart,
	startInstance,
	stopInstance,
} from "../Services/instance-manager-service.js";
import {
	OpenCodeControlTarget,
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
const decodeEnvelope = Schema.decodeUnknownResult(
	Schema.StructWithRest(
		Schema.Struct({
			directory: Schema.optional(Schema.String),
			project: Schema.optional(Schema.String),
			payload: Schema.StructWithRest(
				Schema.Struct({
					id: Schema.String,
					type: Schema.String,
					properties: Schema.optional(
						Schema.Record(Schema.String, Schema.Unknown),
					),
					syncEvent: Schema.optional(Schema.Unknown),
				}),
				[Schema.Record(Schema.String, Schema.Unknown)],
			),
		}),
		[Schema.Record(Schema.String, Schema.Unknown)],
	),
);

export type OpenCodeEndpoint = {
	readonly processIdentity?: string | undefined;
	/** Registered identity, including when the caller used the default alias. */
	readonly instanceId?: string;
	readonly url: string;
	readonly auth?: { readonly username: string; readonly password: string };
	/** Unknown (treated as running) when the resolver has no process state. */
	readonly status?: InstanceStatus;
	readonly managed?: boolean;
};

/** Process control for the instances behind the endpoints. */
type OpenCodeProcessControl<Start, Stop> = {
	/** Passive process proof, serialized with managed starts and stops. */
	readonly isStopped?: (
		instanceId: string,
	) => Effect.Effect<boolean, never, Start>;
	/** Spawns a managed instance; begins health checks of an external one. */
	readonly start: (instanceId: string) => Effect.Effect<void, unknown, Start>;
	/** True only when termination completed; cached manager status is not proof. */
	readonly stop: (instanceId: string) => Effect.Effect<boolean, never, Stop>;
	/** Instances running before any use: survivors re-adopted at startup. */
	readonly adopted: Effect.Effect<ReadonlyArray<string>, never, Start>;
	/** Exact registered ids removed from the manager, independent of alias resolution. */
	readonly removed?: Stream.Stream<string, never, Start>;
	readonly crashes?: {
		/** Verify process health promptly after a managed transport loss. */
		readonly checkHealth?: (
			instanceId: string,
		) => Effect.Effect<void, never, Start>;
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
		endpoint?.processIdentity,
		endpoint?.auth?.username,
		endpoint?.auth?.password,
	]);

type InstanceStream = {
	identity: string;
	readonly promptProcessId: string;
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

const OPENCODE_BORROW_IDLE_TIMEOUT_MS = 30_000;

/** Test harness override; ordinary instance idle policy is independent. */
const borrowIdleTimeoutFromEnv = Effect.sync(() => {
	const configured =
		process.env["CONDUIT_TEST_OPENCODE_BORROW_IDLE_TIMEOUT_MS"];
	return configured === undefined
		? OPENCODE_BORROW_IDLE_TIMEOUT_MS
		: Number(configured);
}).pipe(
	Effect.filterOrFail(
		(ms) => Number.isInteger(ms) && ms > 0 && ms <= 2_147_483_647,
		() =>
			new Error(
				"CONDUIT_TEST_OPENCODE_BORROW_IDLE_TIMEOUT_MS must be an integer from 1 to 2147483647",
			),
	),
	Effect.orDie,
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
	Layer.effect(
		OpenCodeInstancesTag,
		Effect.gen(function* () {
			const { log = createLogger("daemon").child("opencode"), control } =
				options;
			const idleTimeoutMs =
				options.idleTimeoutMs ?? (yield* instanceIdleTimeoutFromEnv);
			const borrowIdleTimeoutMs = yield* borrowIdleTimeoutFromEnv;
			const context = yield* Effect.context<R | Start | Stop>();
			const scope = yield* Effect.scope;
			const gate = yield* Semaphore.make(1);
			// One in-flight start per instance, joined by every `use`.
			const starts = new Map<
				string,
				Deferred.Deferred<void, OpenCodeUnavailable>
			>();
			const subscribers = new Set<{
				directories: () => ReadonlySet<string>;
				send: (event: OpenCodeInstanceEvent) => void;
			}>();
			// One /global/event stream per instance, open exactly while the
			// instance has demand or its grace timer runs. Demand is the open
			// `use` scopes counted here plus the busy sessions and pending
			// prompts the stream's reconciler sees. Guarded by `gate`.
			const streams = new Map<string, InstanceStream>();
			const holds = new Map<string, number>();
			// Removed permanently for this start when real use joins it.
			const borrowedStarts = new Set<string>();
			const graces = new Map<
				string,
				{ readonly token: number; readonly fiber: Fiber.Fiber<void> }
			>();
			let graceTokens = 0;
			// Completes when an instance's stop finishes; `use` waits on it.
			const stopping = new Map<string, Deferred.Deferred<void>>();
			// Last lifecycle state per instance; only transitions are broadcast.
			const states = new Map<
				string,
				{ state: OpenCodeConnectionStatus; managedStopped: boolean }
			>();
			// Reconcilers report demand changes from callbacks; settled in order.
			const demandChanged = yield* Queue.unbounded<string>();
			const healthChecks = yield* Queue.unbounded<{
				instanceId: string;
				stream: InstanceStream;
			}>();
			const healthProbes = yield* FiberMap.make<string, void>();
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
				[...subscribers].flatMap(({ directories }) => [...directories()]);
			const broadcast = (event: OpenCodeInstanceEvent) => {
				for (const subscriber of subscribers) subscriber.send(event);
			};
			const resolveIn = (instanceId: string) =>
				resolveEndpoint(instanceId).pipe(Effect.provide(context));
			const resolveId = (instanceId: string) =>
				Effect.map(
					resolveIn(instanceId),
					(endpoint) => endpoint?.instanceId ?? instanceId,
				);
			const setState = (
				instanceId: string,
				state: OpenCodeConnectionStatus,
				managedStopped = false,
			) => {
				const previous = states.get(instanceId);
				if (
					previous?.state === state &&
					previous.managedStopped === managedStopped
				)
					return;
				states.set(instanceId, { state, managedStopped });
				log.info("OpenCode instance state", { instanceId, state });
				broadcast({
					_tag: "connection",
					instanceId,
					state,
					...(managedStopped ? { managedStopped } : {}),
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
				const stream = streams.get(instanceId);
				if (!stream || stream.source !== source) return false;
				let delivered = false;
				for (const subscriber of subscribers) {
					if (!subscriber.directories().has(directory)) continue;
					subscriber.send({
						_tag: "event",
						instanceId,
						directory,
						payload,
						providerProcessId: stream.promptProcessId,
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
						identity: randomUUID(),
						// External OpenCode exposes no process token. Its endpoint keeps
						// reconnects stable, but cannot distinguish a remote restart.
						promptProcessId: openCodePromptProcessId(
							instanceId,
							endpoint?.processIdentity ?? endpoint?.url ?? instanceId,
						),
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
								Queue.offerUnsafe(demandChanged, instanceId);
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
						// External servers expose no process token. A lost connection
						// invalidates directory warmth conservatively for that generation.
						if (!stream.managed) stream.identity = randomUUID();
						broadcast({
							_tag: "disconnected",
							instanceId,
							health: source.getHealth(),
						});
						if (hasDemand(instanceId)) setState(instanceId, "reconnecting");
						else if (!stream.managed) setState(instanceId, "stopped");
					};
					source.on("connected", () => {
						Deferred.doneUnsafe(stream.connected, Exit.void);
						if (!current()) return;
						setState(instanceId, "connected");
						broadcast({
							_tag: "connected",
							instanceId,
							providerProcessId: stream.promptProcessId,
							managed: stream.managed,
							health: source.getHealth(),
						});
						if (stream.reconcileClient)
							void stream.reconciler.reconcile(
								stream.reconcileClient,
								subscribedDirectories(),
							);
					});
					source.on("disconnected", () => {
						lost();
						if (current() && stream.managed && control?.crashes?.checkHealth)
							Queue.offerUnsafe(healthChecks, { instanceId, stream });
					});
					source.on("reconnecting", lost);
					source.on("event", (raw) => {
						const decoded = decodeEnvelope(raw);
						if (Result.isFailure(decoded)) {
							log.warn("Skipping undecodable OpenCode global envelope", {
								instanceId,
								raw,
								error: String(decoded.failure),
							});
							return;
						}
						const { directory, payload } = decoded.success;
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
					yield* FiberMap.remove(healthProbes, instanceId);
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
				return Effect.sync(() => grace.fiber.interruptUnsafe());
			};

			/**
			 * Arms the grace timer when an open stream has no demand, and cancels
			 * it when demand returns. Call under the gate.
			 */
			const settle = (instanceId: string): Effect.Effect<void> =>
				Effect.suspend(() => {
					const stream = streams.get(instanceId);
					if (stream?.reconciler.active()) borrowedStarts.delete(instanceId);
					const idle =
						(stream !== undefined ||
							(borrowedStarts.has(instanceId) && !starts.has(instanceId))) &&
						!stopping.has(instanceId) &&
						!holds.has(instanceId) &&
						!stream?.reconciler.active();
					if (!idle) return cancelGrace(instanceId);
					if (graces.has(instanceId)) return Effect.void;
					const token = ++graceTokens;
					const timeoutMs = borrowedStarts.has(instanceId)
						? borrowIdleTimeoutMs
						: idleTimeoutMs;
					log.debug("OpenCode instance idle; grace timer armed", {
						instanceId,
						idleTimeoutMs: timeoutMs,
					});
					// `use` settles from acquire/release, which are uninterruptible;
					// the timer must stay cancellable.
					return Effect.sleep(timeoutMs).pipe(
						Effect.andThen(expire(instanceId, token)),
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
					borrowedStarts.delete(instanceId);
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
					: Effect.succeed(false)
				).pipe(
					Effect.onExit((terminated) =>
						gate
							.withPermits(1)(
								Effect.gen(function* () {
									const endpoint = yield* resolveIn(instanceId);
									stopping.delete(instanceId);
									setState(
										instanceId,
										"stopped",
										Exit.isSuccess(terminated) &&
											terminated.value &&
											endpoint?.managed === true,
									);
								}),
							)
							.pipe(Effect.andThen(Deferred.done(done, Exit.void))),
					),
					Effect.asVoid,
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
									{
										instanceId,
										idleTimeoutMs: borrowedStarts.has(instanceId)
											? borrowIdleTimeoutMs
											: idleTimeoutMs,
									},
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

			const clientFor = (
				endpoint: OpenCodeEndpoint,
				directory: string | undefined,
				instanceId: string,
			) => {
				const { client: sdk, authHeaders } = createSdkClient({
					baseUrl: endpoint.url,
					...(endpoint.auth ? { auth: endpoint.auth } : {}),
					...(directory !== undefined ? { directory } : {}),
				});
				return new OpenCodeAPI({
					sdk,
					baseUrl: endpoint.url,
					authHeaders,
					processIdentity:
						endpoint.processIdentity ??
						streams.get(endpoint.instanceId ?? instanceId)?.identity,
					promptProcessId: openCodePromptProcessId(
						endpoint.instanceId ?? instanceId,
						endpoint.processIdentity ?? endpoint.url,
					),
					controlReplaySafe: endpoint.processIdentity !== undefined,
				});
			};

			const matchesControlTarget = (
				instanceId: string,
				endpoint: OpenCodeEndpoint | undefined,
				target: string,
			): endpoint is OpenCodeEndpoint =>
				endpoint !== undefined &&
				endpoint.status !== "stopped" &&
				(!endpoint.managed || endpoint.status === "healthy") &&
				!stopping.has(instanceId) &&
				openCodePromptProcessId(
					endpoint.instanceId ?? instanceId,
					endpoint.processIdentity ?? endpoint.url,
				) === target;

			const processGone = (instanceId: string, target: string) =>
				new OpenCodeUnavailable({
					instanceId,
					reason: "not-running",
					code: "provider_process_gone",
					message: `OpenCode process "${target}" is no longer running for instance "${instanceId}"`,
				});

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
					const started = Deferred.makeUnsafe<void, OpenCodeUnavailable>();
					starts.set(instanceId, started);
					setState(instanceId, pending);
					return run.pipe(
						Effect.provide(context),
						Effect.mapError((cause) => spawnFailed(instanceId, cause)),
						Effect.andThen(resolveIn(instanceId)),
						Effect.filterOrFail(
							(endpoint) => !endpoint?.managed || endpoint.status === "healthy",
							(endpoint) =>
								spawnFailed(instanceId, `status is ${endpoint?.status}`),
						),
						Effect.exit,
						Effect.flatMap((exit) =>
							Effect.gen(function* () {
								const endpoint = Exit.isFailure(exit)
									? yield* resolveIn(instanceId)
									: undefined;
								// Exhaustion can leave a live recovery record behind. Confirm
								// its termination before publishing a terminal settlement signal.
								const terminated =
									endpoint?.managed && endpoint.status === "stopped" && control
										? yield* control
												.stop(instanceId)
												.pipe(Effect.provide(context))
										: false;
								return yield* gate
									.withPermits(1)(
										Effect.gen(function* () {
											starts.delete(instanceId);
											if (Exit.isSuccess(exit)) {
												const endpoint = yield* resolveIn(instanceId);
												// A lazy Default resolving to an external server was
												// never started by this borrow.
												if (!endpoint?.managed)
													borrowedStarts.delete(instanceId);
												// Every orphaned success settles, including a borrow
												// promoted by ordinary use before both callers cancel.
												if (
													!holds.has(instanceId) &&
													!stopping.has(instanceId) &&
													endpoint &&
													endpoint.status !== "stopped"
												) {
													yield* ensureStream(instanceId, endpoint);
													yield* settle(instanceId);
												}
												return;
											}
											borrowedStarts.delete(instanceId);
											// A stop that won the race already settled the state.
											if (states.get(instanceId)?.state !== "stopped") {
												setState(instanceId, "failed", terminated);
											}
											yield* closeStream(instanceId);
										}),
									)
									.pipe(
										Effect.andThen(Deferred.done(started, Exit.asVoid(exit))),
									);
							}),
						),
						Effect.forkIn(scope),
						Effect.andThen(Deferred.await(started)),
					);
				});

			/** Counts a `use` scope as demand, first waiting out a stop in progress. */
			const hold = (
				instanceId: string,
				borrow = false,
				target?: string,
			): Effect.Effect<void, OpenCodeUnavailable> =>
				gate
					.withPermits(1)(
						Effect.gen(function* () {
							if (
								target !== undefined &&
								!matchesControlTarget(
									instanceId,
									yield* resolveIn(instanceId),
									target,
								)
							)
								return yield* processGone(instanceId, target);
							const stop = stopping.get(instanceId);
							if (stop) return stop;
							if (!borrow) borrowedStarts.delete(instanceId);
							else if (!holds.has(instanceId) && !starts.has(instanceId)) {
								const endpoint = yield* resolveIn(instanceId);
								if (
									endpoint &&
									(endpoint.status === "stopped" ||
										(endpoint.managed && endpoint.status !== "healthy"))
								)
									borrowedStarts.add(instanceId);
							}
							holds.set(instanceId, (holds.get(instanceId) ?? 0) + 1);
							yield* settle(instanceId);
							return undefined;
						}),
					)
					.pipe(
						Effect.flatMap((stop) =>
							stop
								? Deferred.await(stop).pipe(
										Effect.andThen(hold(instanceId, borrow, target)),
									)
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

			const use = (instanceId: string, directory?: string, borrow = false) =>
				Effect.gen(function* () {
					const target = yield* OpenCodeControlTarget;
					yield* Effect.acquireRelease(hold(instanceId, borrow, target), () =>
						release(instanceId),
					);
					let endpoint = yield* resolveIn(instanceId);
					// Not running yet: never started, stopped, or a managed instance
					// that failed or crashed. External instances are only checked.
					if (
						target === undefined &&
						endpoint &&
						control &&
						(endpoint.status === "stopped" ||
							(endpoint.managed && endpoint.status !== "healthy"))
					) {
						yield* start(instanceId, "starting", control.start(instanceId));
						endpoint = yield* resolveIn(instanceId);
					}
					if (!endpoint) {
						if (target !== undefined)
							return yield* processGone(instanceId, target);
						return yield* new OpenCodeUnavailable({
							instanceId,
							reason: "not-configured",
							message: `OpenCode instance "${instanceId}" is not configured with a server URL`,
						});
					}
					const available = endpoint;
					const selected = yield* gate.withPermits(1)(
						Effect.gen(function* () {
							let current = available;
							if (target !== undefined) {
								const resolved = yield* resolveIn(instanceId);
								if (!matchesControlTarget(instanceId, resolved, target))
									return yield* processGone(instanceId, target);
								current = resolved;
							}
							return {
								opened: yield* ensureStream(instanceId, current),
								client: clientFor(current, directory, instanceId),
							};
						}),
					);
					const { client, opened } = selected;
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
						Effect.andThen(
							stream
								? Deferred.await(stream.connected).pipe(
										Effect.timeoutOrElse({
											duration: CONNECT_TIMEOUT,
											orElse: () =>
												Effect.fail(
													unreachable(
														instanceId,
														endpoint.url,
														"event stream did not connect",
													),
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
											Effect.tap(() =>
												Effect.sync(() => setState(instanceId, "failed")),
											),
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
											Effect.andThen(settle(instanceId)),
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
			const checkHealth = crashes?.checkHealth;
			if (checkHealth)
				yield* Stream.fromQueue(healthChecks).pipe(
					Stream.runForEach(({ instanceId, stream }) =>
						gate.withPermits(1)(
							Effect.suspend(() =>
								streams.get(instanceId) === stream && !stopping.has(instanceId)
									? FiberMap.run(
											healthProbes,
											instanceId,
											Effect.suspend(() => checkHealth(instanceId)),
											{ onlyIfMissing: true },
										).pipe(Effect.asVoid)
									: Effect.void,
							),
						),
					),
					Effect.provide(context),
					Effect.forkIn(scope),
				);
			if (control?.removed)
				yield* control.removed.pipe(
					Stream.runForEach((instanceId) =>
						gate.withPermits(1)(
							Effect.suspend(() =>
								cancelGrace(instanceId).pipe(
									Effect.andThen(closeStream(instanceId)),
								),
							),
						),
					),
					Effect.provide(context),
					Effect.forkIn(scope),
				);
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
										Effect.andThen(resolveIn(instanceId)),
										Effect.flatMap((restarted) =>
											gate.withPermits(1)(
												Effect.suspend(() =>
													stopping.has(instanceId)
														? Effect.void
														: ensureStream(instanceId, restarted).pipe(
																Effect.andThen(settle(instanceId)),
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
					directories: readonly string[] | (() => readonly string[]),
					instanceId: string = MANAGED_OPENCODE_ACCOUNT_ID,
				) =>
					Stream.fromPull(
						Effect.gen(function* () {
							const emit = yield* Effect.acquireRelease(
								Queue.unbounded<OpenCodeInstanceEvent>(),
								Queue.shutdown,
							);
							yield* gate
								.withPermits(1)(
									Effect.gen(function* () {
										const subscribedId = yield* resolveId(instanceId);
										const subscriber = yield* Effect.acquireRelease(
											Effect.sync(() => {
												const member = {
													directories: () =>
														new Set(
															(typeof directories === "function"
																? directories()
																: directories
															).map(normalize),
														),
													send: (event: OpenCodeInstanceEvent) => {
														Queue.offerUnsafe(emit, event);
													},
												};
												subscribers.add(member);
												return member;
											}),
											(member) =>
												gate.withPermits(1)(
													Effect.sync(() => {
														subscribers.delete(member);
														const remaining = new Set(subscribedDirectories());
														for (const directory of member.directories()) {
															if (remaining.has(directory)) continue;
															for (const stream of streams.values())
																stream.reconciler.forget(directory);
														}
													}),
												),
										);
										const stream = streams.get(subscribedId);
										for (const [id, { state, managedStopped }] of states) {
											if (id !== subscribedId && !managedStopped) continue;
											subscriber.send({
												_tag: "connection",
												instanceId: id,
												state,
												...(managedStopped ? { managedStopped } : {}),
												health:
													streams.get(id)?.source.getHealth() ??
													NO_STREAM_HEALTH,
											});
										}
										if (stream?.source.isConnected())
											subscriber.send({
												_tag: "connected",
												instanceId: subscribedId,
												providerProcessId: stream.promptProcessId,
												managed: stream.managed,
												health: stream.source.getHealth(),
											});
										// Recover every already-open instance, including sessions
										// bound to a non-selected instance. This stays passive.
										for (const [runningId, running] of streams) {
											if (
												runningId !== subscribedId &&
												running.source.isConnected()
											)
												subscriber.send({
													_tag: "connected",
													instanceId: runningId,
													providerProcessId: running.promptProcessId,
													managed: running.managed,
													health: running.source.getHealth(),
												});
											// A late subscriber gets its own replay; others never see it.
											if (
												running.source.isConnected() &&
												running.reconcileClient
											)
												void running.reconciler.reconcile(
													running.reconcileClient,
													subscriber.directories(),
													(directory, payload) =>
														subscriber.send({
															_tag: "event",
															instanceId: runningId,
															directory,
															payload,
															providerProcessId: running.promptProcessId,
															health: running.source.getHealth(),
														}),
												);
										}
										return subscriber;
									}),
								)
								.pipe(Effect.uninterruptible);
							return Queue.takeAll(emit);
						}),
					).pipe(Stream.scoped),
				use: (instanceId, directory) =>
					Effect.flatMap(resolveId(instanceId), (id) => use(id, directory)),
				borrow: (instanceId, directory) =>
					Effect.flatMap(resolveId(instanceId), (id) =>
						use(id, directory, true),
					),
				useIfRunning: (instanceId, directory) =>
					Effect.flatMap(resolveId(instanceId), (instanceId) =>
						gate.withPermits(1)(
							Effect.gen(function* () {
								const target = yield* OpenCodeControlTarget;
								const endpoint = yield* resolveIn(instanceId);
								if (
									!endpoint ||
									endpoint.status === "stopped" ||
									(endpoint.managed && endpoint.status !== "healthy") ||
									stopping.has(instanceId) ||
									(target !== undefined &&
										!matchesControlTarget(instanceId, endpoint, target))
								)
									return Option.none();
								// Check and retain under the stop/idle gate. Register release
								// before opening transport, so interruption cannot leak demand.
								yield* Effect.acquireRelease(
									Effect.sync(() =>
										holds.set(instanceId, (holds.get(instanceId) ?? 0) + 1),
									),
									() => release(instanceId),
								);
								yield* settle(instanceId);
								yield* ensureStream(instanceId, endpoint);
								return Option.some(clientFor(endpoint, directory, instanceId));
							}),
						),
					),
				// Reads process state only: no request, no stream, never a start.
				ifRunning: (instanceId: string, directory?: string | null) =>
					Effect.flatMap(resolveId(instanceId), (instanceId) =>
						Effect.map(resolveIn(instanceId), (endpoint) =>
							endpoint &&
							endpoint.status !== "stopped" &&
							!stopping.has(instanceId)
								? Option.some(
										clientFor(endpoint, directory ?? undefined, instanceId),
									)
								: Option.none(),
						),
					),
				isManagedStopped: (instanceId) =>
					Effect.flatMap(resolveId(instanceId), (id) => {
						if (starts.has(id) || stopping.has(id))
							return Effect.succeed(false);
						if (states.get(id)?.managedStopped) return Effect.succeed(true);
						return control?.isStopped
							? control.isStopped(id).pipe(Effect.provide(context))
							: Effect.succeed(false);
					}),
				stop: (instanceId) => Effect.flatMap(resolveId(instanceId), stop),
			};
		}),
	);

export const OpenCodeInstancesLive = makeOpenCodeInstancesLive(
	(instanceId) =>
		Effect.gen(function* () {
			const instances = Array.from(yield* getInstances).filter(
				({ driver }) =>
					getProviderDriver(driver ?? "opencode")?.runsOpenCodeServer,
			);
			// The default id names the daemon's first OpenCode instance when no
			// instance carries that id.
			const instance =
				instances.find(({ id }) => id === instanceId) ??
				(instanceId === MANAGED_OPENCODE_ACCOUNT_ID ? instances[0] : undefined);
			const url = instance ? yield* getInstanceUrl(instance.id) : null;
			if (!instance || !url) return undefined;
			const auth = openCodeAuth(
				instance.managed
					? yield* getManagedOpenCodeProcessEnv(instance.id)
					: instance.env,
			);
			return {
				instanceId: instance.id,
				processIdentity: yield* getManagedOpenCodeProcessIdentity(instance.id),
				url,
				status: instance.status,
				managed: instance.managed,
				...(auth ? { auth } : {}),
			};
		}),
	{
		control: {
			isStopped: isManagedOpenCodeStopped,
			start: startInstance,
			removed: Stream.unwrap(
				Effect.map(subscribeToDaemonEvents, (events) =>
					Stream.fromSubscription(events).pipe(
						Stream.filterMap((event) =>
							event._tag === "ProviderInstanceRemoved"
								? Result.succeed(event.instanceId)
								: Result.fail(event),
						),
					),
				),
			),
			adopted: Effect.map(getInstances, (instances) =>
				Array.from(instances).flatMap(({ id, driver, managed, status }) =>
					getProviderDriver(driver ?? "opencode")?.runsOpenCodeServer &&
					managed &&
					status === "healthy"
						? [id]
						: [],
				),
			),
			stop: (instanceId) =>
				stopInstance(instanceId).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("OpenCode instance stop failed", cause).pipe(
							Effect.as(false),
						),
					),
				),
			crashes: {
				checkHealth: checkInstanceHealth,
				statusChanges: Stream.unwrap(
					Effect.map(subscribeToDaemonEvents, (events) =>
						Stream.fromSubscription(events).pipe(
							Stream.filterMap((event) =>
								event._tag === "InstanceStatusChanged"
									? Result.succeed(event.instanceId)
									: Result.fail(event),
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
	Layer.unwrap(
		Effect.gen(function* () {
			const daemonConfig = yield* Effect.suspend(() =>
				Effect.fromResult(loadDaemonConfigResult(config.configDir)),
			).pipe(
				Effect.catchTag("NotFound", () =>
					Effect.succeed(defaultDaemonConfig()),
				),
			);
			return makeOpenCodeInstancesLive(
				(instanceId) =>
					Effect.sync(() => {
						if (instanceId === MANAGED_OPENCODE_ACCOUNT_ID)
							return config.opencodeUrl === undefined
								? undefined
								: {
										url: config.opencodeUrl,
										...(config.opencodeAuth
											? { auth: config.opencodeAuth }
											: {}),
									};
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
		}),
	);
