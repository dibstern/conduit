import { Context, Effect, Fiber, Layer, Stream } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
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
		const log = config.log;
		const scope = yield* Effect.scope;
		const gate = yield* Effect.makeSemaphore(1);
		// The relay view tags the selected instance with the default id.
		const selectedId = defaultInstanceIdForDriver("opencode");
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
			});
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
			on: main.on,
			getHealth: main.getHealth,
			isConnected: main.isConnected,
			connectEffect: () =>
				gate.withPermits(1)(
					Effect.gen(function* () {
						if (fiber) return;
						fiber = yield* Effect.forkIn(
							Stream.runForEach(instances.events([config.projectDir]), route),
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
