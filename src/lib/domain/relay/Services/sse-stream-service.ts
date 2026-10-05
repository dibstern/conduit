import { Context, Effect, Fiber, Layer, Stream } from "effect";
import type {
	SSEStreamCallbacks,
	SSEStreamPort,
} from "../../../relay/sse-stream.js";
import type { ConnectionHealth } from "../../../types.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import { ConfigTag } from "./services.js";

export class SSEStreamTag extends Context.Tag("SSEStream")<
	SSEStreamTag,
	SSEStreamPort
>() {}

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
		const callbacks: {
			[K in keyof SSEStreamCallbacks]: SSEStreamCallbacks[K][];
		} = {
			event: [],
			connected: [],
			disconnected: [],
			reconnecting: [],
			error: [],
			heartbeat: [],
		};
		let health: ConnectionHealth = {
			connected: false,
			lastEventAt: null,
			reconnectCount: 0,
			stale: false,
		};
		let fiber: Fiber.RuntimeFiber<void> | undefined;
		const notify = (callback: () => void) => {
			try {
				callback();
			} catch (error) {
				log?.warn("OpenCode SSE subscriber callback failed", error);
			}
		};
		const disconnectEffect = () =>
			gate.withPermits(1)(
				Effect.gen(function* () {
					if (fiber) yield* Fiber.interrupt(fiber);
					fiber = undefined;
					health = { ...health, connected: false, stale: false };
				}),
			);
		yield* Effect.addFinalizer(disconnectEffect);
		return {
			on: <K extends keyof SSEStreamCallbacks>(
				event: K,
				callback: SSEStreamCallbacks[K],
			) => {
				callbacks[event].push(callback);
			},
			getHealth: () => health,
			isConnected: () => health.connected,
			connectEffect: () =>
				gate.withPermits(1)(
					Effect.gen(function* () {
						if (fiber) return;
						fiber = yield* Effect.forkIn(
							Stream.runForEach(
								instances.events([config.projectDir]),
								(message) =>
									Effect.sync(() => {
										health = message.health;
										switch (message._tag) {
											case "event":
												for (const callback of callbacks.event)
													notify(() => callback(message.payload));
												break;
											case "heartbeat":
												for (const callback of callbacks.heartbeat)
													notify(callback);
												break;
											case "connection":
												if (message.state === "connected") {
													for (const callback of callbacks.connected)
														notify(callback);
												} else if (message.state === "disconnected") {
													for (const callback of callbacks.disconnected)
														notify(() => callback(message.error));
													const error = message.error;
													if (error)
														for (const callback of callbacks.error)
															notify(() => callback(error));
												} else {
													for (const callback of callbacks.reconnecting)
														notify(() =>
															callback({
																attempt: message.attempt ?? 0,
																delay: message.delay ?? 0,
															}),
														);
												}
										}
									}),
							),
							scope,
						);
					}),
				),
			disconnectEffect,
			drainEffect: disconnectEffect,
		} satisfies SSEStreamPort;
	}),
);
