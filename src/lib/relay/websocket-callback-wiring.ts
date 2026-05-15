import { Cause, Effect, Runtime } from "effect";
import {
	type ClientInitEffectOptions,
	handleClientConnectedEffect,
} from "../bridges/client-init.js";
import { ClientMessageSerializationTag } from "../domain/relay/Services/client-message-serialization.js";
import type { Logger } from "../logger.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import { handleRelayWsMessageThroughGate } from "./ws-message-dispatch-effect.js";

export interface RelayWebSocketCallbackWiringDeps {
	readonly wsHandler: WebSocketHandlerShape;
	readonly log: Logger;
	readonly clientInitOptions?: ClientInitEffectOptions;
}

/**
 * Registers relay WebSocket callbacks from inside the relay runtime.
 *
 * The `ws` EventEmitter callbacks are still the external boundary, but the
 * forked programs consume the runtime environment directly instead of
 * `relay-stack.ts` owning each `ManagedRuntime.runFork(...)` call.
 */
export const wireRelayWebSocketCallbacksEffect = ({
	wsHandler,
	log,
	clientInitOptions = {},
}: RelayWebSocketCallbackWiringDeps) =>
	Effect.gen(function* () {
		// biome-ignore lint/suspicious/noExplicitAny: callback programs use the full relay runtime Layer graph.
		const runtime = yield* Effect.runtime<any>();
		yield* Effect.sync(() => {
			const runFork = Runtime.runFork(runtime);
			let relayCommandSequence = 0;

			wsHandler.on("client_connected", ({ clientId, requestedSessionId }) => {
				log.info(
					`Client connected: ${clientId}${requestedSessionId ? ` (requested session: ${requestedSessionId})` : ""}`,
				);
				runFork(
					handleClientConnectedEffect(
						clientId,
						requestedSessionId,
						clientInitOptions,
					).pipe(
						Effect.catchAllCause((cause) =>
							Effect.sync(() =>
								log.error(
									`Client init failed for ${clientId}: ${Cause.pretty(cause)}`,
								),
							),
						),
					),
				);
			});

			wsHandler.on("client_disconnected", ({ clientId }) => {
				runFork(
					Effect.gen(function* () {
						const serialization = yield* ClientMessageSerializationTag;
						yield* serialization.removeClient(clientId);
					}),
				);
				log.info(`Client disconnected: ${clientId}`);
			});

			wsHandler.on("message", ({ clientId, handler, payload }) => {
				const commandId = `${clientId}:${++relayCommandSequence}`;
				runFork(
					handleRelayWsMessageThroughGate({
						commandId,
						clientId,
						handler,
						payload,
						sendTo: (targetClientId, message) =>
							wsHandler.sendTo(targetClientId, message),
						log,
					}),
				);
			});
		});
	});
