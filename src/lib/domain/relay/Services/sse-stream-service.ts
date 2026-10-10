import { realpathSync } from "node:fs";
import { Context, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import type { Logger } from "../../../logger.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	hasInfoWithSessionID,
	hasPartWithSessionID,
	hasSessionID,
} from "../../../relay/opencode-events.js";
import type {
	SSEStreamCallbacks,
	SSEStreamPort,
} from "../../../relay/sse-stream.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import type { ConnectionHealth } from "../../../types.js";
import {
	type OpenCodeInstanceEvent,
	OpenCodeInstancesTag,
} from "../../daemon/Services/opencode-instances-service.js";
import { ConfigTag } from "./services.js";

export interface RelayOpenCodeStream extends SSEStreamPort {
	/** Keep previous directories subscribed while their running turns finish. */
	followDirectory(directory: string): Effect.Effect<void>;
	/**
	 * Wires a port for every other OpenCode instance that delivers events for
	 * this project. Each port is wired on that instance's first event.
	 */
	wireInstanceStreams<R>(
		wirer: (
			stream: SSEStreamPort,
			instanceId: string,
		) => Effect.Effect<void, never, R>,
	): Effect.Effect<void, never, R>;
}

export class SSEStreamTag extends Context.Tag("SSEStream")<
	SSEStreamTag,
	RelayOpenCodeStream
>() {}

const makeChannel = (log: Logger | undefined) => {
	const callbacks: {
		[K in keyof SSEStreamCallbacks]: SSEStreamCallbacks[K][];
	} = {
		event: [],
		connected: [],
		disconnected: [],
		reconnecting: [],
		error: [],
		heartbeat: [],
		status: [],
	};
	let health: ConnectionHealth = {
		connected: false,
		lastEventAt: null,
		reconnectCount: 0,
		stale: false,
	};
	const notify = (callback: () => void) => {
		try {
			callback();
		} catch (error) {
			log?.warn("OpenCode SSE subscriber callback failed", error);
		}
	};
	return {
		on: <K extends keyof SSEStreamCallbacks>(
			event: K,
			callback: SSEStreamCallbacks[K],
		) => {
			callbacks[event].push(callback);
		},
		getHealth: () => health,
		isConnected: () => health.connected,
		markDisconnected: () => {
			health = { ...health, connected: false, stale: false };
		},
		dispatch: (message: OpenCodeInstanceEvent) => {
			health = message.health;
			switch (message._tag) {
				case "event":
					for (const callback of callbacks.event)
						notify(() => callback(message.payload));
					break;
				case "heartbeat":
					for (const callback of callbacks.heartbeat) notify(callback);
					break;
				case "connection":
					if (message.state === "connected")
						for (const callback of callbacks.connected) notify(callback);
					for (const callback of callbacks.status)
						notify(() => callback(message.state));
			}
		},
	};
};

export const SSEStreamLive: Layer.Layer<
	SSEStreamTag,
	never,
	OpenCodeInstancesTag | ConfigTag
> = Layer.scoped(
	SSEStreamTag,
	Effect.gen(function* () {
		const instances = yield* OpenCodeInstancesTag;
		const config = yield* ConfigTag;
		const resolveOwner = config.resolveSessionProject;
		const read = yield* Effect.serviceOption(ReadQueryEffectTag);
		const log = config.log;
		const scope = yield* Effect.scope;
		const gate = yield* Effect.makeSemaphore(1);
		// The relay view tags the selected instance with the default id.
		const selectedId = defaultInstanceIdForDriver("opencode");
		const main = makeChannel(log);
		const directories = new Set([config.projectDir]);
		const ownedSessions = new Set<string>();
		let primary = config.projectDir;
		try {
			primary = realpathSync(primary);
		} catch {
			/* A checkout may have disappeared. */
		}
		// Admission only needs identity fields; the downstream consumer validates
		// the full schema and preserves raw frames from older/newer providers.
		const decodeEvent = Schema.decodeUnknownEither(
			Schema.Struct({
				type: Schema.String,
				properties: Schema.Record({
					key: Schema.String,
					value: Schema.Unknown,
				}),
			}),
		);
		const others = new Map<string, ReturnType<typeof makeChannel>>();
		let wirer:
			| ((stream: SSEStreamPort, instanceId: string) => Effect.Effect<void>)
			| undefined;
		const route = (message: OpenCodeInstanceEvent) =>
			Effect.gen(function* () {
				if (message._tag === "event" && message.directory !== undefined) {
					const event = decodeEvent(message.payload);
					if (event._tag === "Left") return;
					const props = event.right.properties;
					const id = hasSessionID(props)
						? props.sessionID
						: hasPartWithSessionID(props)
							? props.part.sessionID
							: hasInfoWithSessionID(props)
								? (props.info.sessionID ?? props.info.id)
								: undefined;
					if (!id && message.directory !== primary) return;
					if (id && !ownedSessions.has(id)) {
						const local = Option.isSome(read)
							? yield* read.value.getSession(id).pipe(Effect.option)
							: Option.none();
						if (Option.isSome(local) && local.value !== undefined)
							ownedSessions.add(id);
						else {
							const owner = resolveOwner
								? yield* Effect.tryPromise(() => resolveOwner(id))
								: null;
							if (owner !== null && owner !== config.slug) return;
							const info = props["info"];
							const metadata =
								(event.right.type === "session.created" ||
									event.right.type === "session.updated") &&
								typeof info === "object" &&
								info !== null
									? info
									: undefined;
							let parent =
								metadata &&
								"parentID" in metadata &&
								typeof metadata.parentID === "string"
									? metadata.parentID
									: undefined;
							if (!metadata) {
								const native = yield* Effect.gen(function* () {
									const client = yield* instances.ifRunning(
										message.instanceId,
										message.directory,
									);
									if (Option.isSome(client))
										return yield* Effect.tryPromise(() =>
											client.value.session.get(id),
										);
									return undefined;
								}).pipe(Effect.scoped, Effect.option);
								// Unavailable metadata does not establish an unowned root.
								if (Option.isNone(native) || !native.value) return;
								parent = native.value.parentID;
							}
							if (parent) {
								const parentRow =
									!ownedSessions.has(parent) && Option.isSome(read)
										? yield* read.value.getSession(parent).pipe(Effect.option)
										: Option.none();
								if (
									!ownedSessions.has(parent) &&
									!(Option.isSome(parentRow) && parentRow.value !== undefined)
								)
									return;
							} else if (message.directory !== primary) return;
							ownedSessions.add(id);
						}
					}
				}
				if (message.instanceId === selectedId) return main.dispatch(message);
				let channel = others.get(message.instanceId);
				if (!channel) {
					if (message._tag !== "event" || !wirer) return;
					const created = makeChannel(log);
					others.set(message.instanceId, created);
					yield* wirer(
						{
							on: created.on,
							getHealth: created.getHealth,
							isConnected: created.isConnected,
							// The OpenCode Instances module owns the stream lifecycle.
							connectEffect: () => Effect.void,
							disconnectEffect: () => Effect.void,
							drainEffect: () => Effect.void,
						},
						message.instanceId,
					);
					channel = created;
				}
				channel.dispatch(message);
			}).pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() =>
						log?.warn("Failed to route OpenCode workspace event", cause),
					),
				),
			);
		let fiber: Fiber.RuntimeFiber<void> | undefined;
		const disconnectEffect = () =>
			gate.withPermits(1)(
				Effect.gen(function* () {
					if (fiber) yield* Fiber.interrupt(fiber);
					fiber = undefined;
					main.markDisconnected();
				}),
			);
		yield* Effect.addFinalizer(disconnectEffect);
		return {
			followDirectory: (directory: string) =>
				Effect.sync(() => {
					directories.add(directory);
				}),
			on: main.on,
			getHealth: main.getHealth,
			isConnected: main.isConnected,
			connectEffect: () =>
				gate.withPermits(1)(
					Effect.gen(function* () {
						if (fiber) return;
						if (Option.isSome(read)) {
							const rows = yield* read.value
								.listSessions()
								.pipe(Effect.orElseSucceed(() => []));
							for (const row of rows) {
								ownedSessions.add(row.id);
								const workspace =
									row.workspace == null
										? null
										: yield* Schema.decodeUnknown(
												Schema.parseJson(SessionWorkspaceSchema),
											)(row.workspace).pipe(Effect.orElseSucceed(() => null));
								const directory = effectiveWorkingDirectory(
									config.projectDir,
									workspace,
								);
								directories.add(directory);
								if (workspace || row.status === "busy") {
									const source = yield* Effect.gen(function* () {
										const client = yield* instances.ifRunning(
											row.provider ?? selectedId,
											directory,
										);
										if (Option.isSome(client))
											return yield* Effect.tryPromise(() =>
												client.value.session.get(row.id),
											);
										return undefined;
									}).pipe(Effect.scoped, Effect.option);
									if (Option.isSome(source) && source.value)
										directories.add(source.value.directory);
								}
							}
						}
						fiber = yield* Effect.forkIn(
							Stream.runForEach(
								instances.events(() => [...directories]),
								route,
							),
							scope,
						);
					}),
				),
			disconnectEffect,
			drainEffect: disconnectEffect,
			wireInstanceStreams: <R>(
				register: (
					stream: SSEStreamPort,
					instanceId: string,
				) => Effect.Effect<void, never, R>,
			) =>
				Effect.map(Effect.context<R>(), (context) => {
					wirer = (stream, instanceId) =>
						register(stream, instanceId).pipe(Effect.provide(context));
				}),
		} satisfies RelayOpenCodeStream;
	}),
);
