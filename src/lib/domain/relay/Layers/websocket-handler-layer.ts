import { Cause, Effect, Layer } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { makeEffectWsHandler } from "../../../server/effect-ws-handler.js";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../Services/services.js";
import { makeWsHandlerStateLive } from "../Services/ws-handler-service.js";
import { makeWsTransportLive } from "./ws-transport-layer.js";

export const WebSocketHandlerLive: Layer.Layer<
	WebSocketHandlerTag,
	never,
	ConfigTag | LoggerTag
> = Layer.scoped(
	WebSocketHandlerTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const wsLog = log.child("ws-handler");
		const handler = yield* makeEffectWsHandler({
			...(!config.noServer && {
				server: config.httpServer,
				...(config.verifyClient != null && {
					verifyClient: config.verifyClient,
				}),
			}),
		});

		yield* Effect.addFinalizer(() =>
			Effect.tryPromise({
				try: () => handler.drain(),
				catch: (cause) => cause,
			}).pipe(
				Effect.catchAll((cause) =>
					Effect.sync(() =>
						wsLog.warn(
							`Failed to drain websocket handler during shutdown: ${formatErrorDetail(cause)}`,
						),
					),
				),
				Effect.catchAllCause((cause) =>
					Effect.sync(() =>
						wsLog.warn(
							`Defect while draining websocket handler during shutdown: ${Cause.pretty(cause)}`,
						),
					),
				),
			),
		);

		return handler;
	}),
).pipe(
	Layer.provide(
		Layer.mergeAll(
			makeWsTransportLive({ noServer: true }),
			makeWsHandlerStateLive(),
		),
	),
);
