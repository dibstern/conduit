import { Cause, Effect, Layer } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { makeEffectWsHandler } from "../../../server/effect-ws-handler.js";
import { LoggerTag, WebSocketHandlerTag } from "../Services/services.js";
import { makeWsHandlerStateLive } from "../Services/ws-handler-service.js";

export const WebSocketHandlerLive: Layer.Layer<
	WebSocketHandlerTag,
	never,
	LoggerTag
> = Layer.scoped(
	WebSocketHandlerTag,
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const wsLog = log.child("ws-handler");
		const handler = yield* makeEffectWsHandler();

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
).pipe(Layer.provide(makeWsHandlerStateLive()));
