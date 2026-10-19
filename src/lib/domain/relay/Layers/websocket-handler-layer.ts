import { Effect, Layer } from "effect";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail } from "../../../errors.js";
import { makeEffectWsHandler } from "../../../server/effect-ws-handler.js";
import { LoggerTag, WebSocketHandlerTag } from "../Services/services.js";

export const WebSocketHandlerLive: Layer.Layer<
	WebSocketHandlerTag,
	never,
	LoggerTag
> = Layer.effect(
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
				Effect.catch((cause) =>
					Effect.sync(() =>
						wsLog.warn(
							`Failed to drain websocket handler during shutdown: ${formatErrorDetail(cause)}`,
						),
					),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() =>
						wsLog.warn(
							`Defect while draining websocket handler during shutdown: ${Failure.renderCause(cause)}`,
						),
					),
				),
			),
		);

		return handler;
	}),
);
