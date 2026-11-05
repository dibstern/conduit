import { Context, Effect, Layer, Queue, Semaphore, Stream } from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
import type { Logger } from "../../../logger.js";
import { makeRetireReplacedProcessPrompts } from "../../../persistence/effect/retire-pending-prompts.js";
import type {
	SSEStreamCallbacks,
	SSEStreamPort,
} from "../../../relay/sse-stream.js";
import type { ConnectionHealth } from "../../../types.js";
import type { OpenCodeInstanceEvent } from "../../daemon/Services/opencode-instances-service.js";
import { OpenCodeProjectStreams } from "../../daemon/Services/opencode-project-streams.js";
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
						notify(() =>
							callback(message.payload, {
								directory: message.directory,
								providerProcessId: message.providerProcessId,
							}),
						);
					break;
				case "heartbeat":
					for (const callback of callbacks.heartbeat) notify(callback);
					break;
				case "connected":
					for (const callback of callbacks.connected)
						notify(() => callback(message.providerProcessId));
					break;
				case "disconnected":
					for (const callback of callbacks.disconnected)
						notify(() => callback(undefined));
					break;
				case "connection":
					for (const callback of callbacks.status)
						notify(() =>
							callback(
								message.state,
								message.managedStopped,
								message.stoppedProcessId,
							),
						);
			}
		},
	};
};

export const SSEStreamLive: Layer.Layer<
	SSEStreamTag,
	never,
	OpenCodeProjectStreams | ConfigTag
> = Layer.effect(
	SSEStreamTag,
	Effect.gen(function* () {
		const streams = yield* OpenCodeProjectStreams;
		const config = yield* ConfigTag;
		const retireReplacedPrompts = yield* makeRetireReplacedProcessPrompts;
		const observedProcesses = new Map<string, string>();
		const log = config.log;
		const gate = yield* Semaphore.make(1);
		// The main channel belongs to managed OpenCode; other accounts keep their ids.
		const selectedId = MANAGED_OPENCODE_ACCOUNT_ID;
		const main = makeChannel(log);
		const others = new Map<string, ReturnType<typeof makeChannel>>();
		let wirer:
			| ((stream: SSEStreamPort, instanceId: string) => Effect.Effect<void>)
			| undefined;
		const route = (message: OpenCodeInstanceEvent) =>
			Effect.gen(function* () {
				if (
					message._tag === "connected" &&
					message.managed &&
					message.providerProcessId &&
					observedProcesses.get(message.instanceId) !==
						message.providerProcessId
				) {
					const retired = yield* retireReplacedPrompts(
						message.providerProcessId,
						{
							providerInstanceIds: [message.instanceId],
						},
					).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								log?.error("Failed to retire replaced OpenCode prompts", error),
							),
						),
						Effect.option,
					);
					if (retired._tag === "Some")
						observedProcesses.set(
							message.instanceId,
							message.providerProcessId,
						);
				}
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
		// The daemon's project stream owns the subscription; this layer only dispatches.
		const inbox = yield* Queue.unbounded<OpenCodeInstanceEvent>();
		yield* Stream.fromQueue(inbox).pipe(
			Stream.runForEach(route),
			Effect.forkScoped,
		);
		let detach: Effect.Effect<void> | undefined;
		const disconnectEffect = () =>
			gate.withPermits(1)(
				Effect.gen(function* () {
					if (detach) yield* detach;
					detach = undefined;
					main.markDisconnected();
				}),
			);
		yield* Effect.addFinalizer(disconnectEffect);
		return {
			on: main.on,
			getHealth: main.getHealth,
			isConnected: main.isConnected,
			includeDirectory: (directory) =>
				streams.includeDirectory(config.slug, directory),
			connectEffect: () =>
				gate.withPermits(1)(
					Effect.gen(function* () {
						if (detach) return;
						detach = yield* streams.attach(config.slug, (message) => {
							Queue.offerUnsafe(inbox, message);
						});
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
