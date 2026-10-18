import {
	Context,
	Effect,
	Fiber,
	Layer,
	Schema,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import type { Logger } from "../../../logger.js";
import type {
	SSEStreamCallbacks,
	SSEStreamPort,
} from "../../../relay/sse-stream.js";
import type { ConnectionHealth } from "../../../types.js";
import {
	type OpenCodeInstanceEvent,
	OpenCodeInstancesTag,
} from "../../daemon/Services/opencode-instances-service.js";
import { ConfigTag } from "./services.js";

export interface RelayOpenCodeStream extends SSEStreamPort {
	/** Register before dispatch; earlier directories remain live for in-flight turns. */
	includeDirectory(directory: string): Effect.Effect<void>;
	/**
	 * Wires a port for every other OpenCode instance that delivers events for
	 * this project. Ports also receive managed stops before their first event.
	 */
	wireInstanceStreams<R>(
		wirer: (
			stream: SSEStreamPort,
			instanceId: string,
		) => Effect.Effect<void, never, R>,
	): Effect.Effect<void, never, R>;
}

export class SSEStreamTag extends Context.Service<
	SSEStreamTag,
	RelayOpenCodeStream
>()("SSEStream") {}

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
				case "connected":
					for (const callback of callbacks.connected) notify(callback);
					break;
				case "disconnected":
					for (const callback of callbacks.disconnected)
						notify(() => callback(undefined));
					break;
				case "connection":
					for (const callback of callbacks.status)
						notify(() => callback(message.state, message.managedStopped));
			}
		},
	};
};

export const SSEStreamLive: Layer.Layer<
	SSEStreamTag,
	never,
	OpenCodeInstancesTag | ConfigTag
> = Layer.effect(
	SSEStreamTag,
	Effect.gen(function* () {
		const instances = yield* OpenCodeInstancesTag;
		const config = yield* ConfigTag;
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const directories = new Set([
			config.projectDir,
			...(config.extraFolders ?? []),
		]);
		const log = config.log;
		const scope = yield* Effect.scope;
		const gate = yield* Semaphore.make(1);
		// The relay view tags the selected instance with the default id.
		const selectedId = MANAGED_OPENCODE_ACCOUNT_ID;
		const main = makeChannel(log);
		const others = new Map<string, ReturnType<typeof makeChannel>>();
		let wirer:
			| ((stream: SSEStreamPort, instanceId: string) => Effect.Effect<void>)
			| undefined;
		const route = (message: OpenCodeInstanceEvent) =>
			Effect.gen(function* () {
				if (message.instanceId === selectedId) return main.dispatch(message);
				let channel = others.get(message.instanceId);
				if (!channel) {
					if (
						!wirer ||
						(message._tag !== "event" &&
							!(message._tag === "connection" && message.managedStopped))
					)
						return;
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
					if (message.health.connected)
						channel.dispatch({
							_tag: "connected",
							instanceId: message.instanceId,
							health: message.health,
						});
				}
				channel.dispatch(message);
			});
		let fiber: Fiber.Fiber<void> | undefined;
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
			on: main.on,
			getHealth: main.getHealth,
			isConnected: main.isConnected,
			includeDirectory: (directory) =>
				Effect.sync(() => {
					directories.add(directory);
				}),
			connectEffect: () =>
				gate.withPermits(1)(
					Effect.gen(function* () {
						if (fiber) return;
						if (sql._tag === "Some") {
							const rows = yield* sql.value<{ workspace: string }>`
								SELECT workspace FROM sessions
								WHERE project_id = ${config.slug} AND workspace IS NOT NULL`.pipe(
								Effect.catch((error) => {
									log?.warn(
										"Failed to read OpenCode workspace directories",
										error,
									);
									return Effect.succeed([]);
								}),
							);
							for (const row of rows) {
								const workspace = yield* Schema.decodeUnknownEffect(
									Schema.fromJsonString(SessionWorkspaceSchema),
								)(row.workspace).pipe(Effect.option);
								if (workspace._tag === "None") continue;
								for (const directory of Object.values(
									workspace.value.worktrees ?? {},
								))
									directories.add(directory);
							}
						}
						yield* Effect.uninterruptible(
							Effect.gen(function* () {
								const subscriptionScope = yield* Scope.fork(scope);
								// Acquire registration before returning; callback setup is forked in Effect 4.
								const pull = yield* Stream.toPull(
									instances.events(() => [...directories]),
								).pipe(Scope.provide(subscriptionScope));
								fiber = yield* Effect.forkIn(
									Stream.runForEach(
										Stream.fromPull(Effect.succeed(pull)),
										route,
									).pipe(
										Effect.onExit((exit) =>
											Scope.close(subscriptionScope, exit),
										),
									),
									scope,
									{ uninterruptible: false },
								);
							}),
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
