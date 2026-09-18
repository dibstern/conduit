import { Cause, Effect, Layer, Option, Stream } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { makeEffectWsHandler } from "../../../server/effect-ws-handler.js";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../Services/services.js";
import { SessionEventBusTag } from "../Services/session-event-bus.js";
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

		// Interim session_list delivery expires with conduit-test-ni8.5.20,
		// which installs the frontend SubscribeShell consumer.
		const bus = yield* Effect.serviceOption(SessionEventBusTag);
		const readQuery = yield* Effect.serviceOption(ReadQueryEffectTag);
		if (Option.isSome(bus) && Option.isSome(readQuery)) {
			const advances = yield* bus.value.subscribeAdvances();
			yield* advances.pipe(
				Stream.runForEach(() =>
					readQuery.value.readSessionList().pipe(
						Effect.tap(({ rows }) =>
							Effect.sync(() =>
								handler.broadcast({
									type: "session_list",
									sessions: rows.map(({ item }) => item),
									roots: false,
								}),
							),
						),
						Effect.catchAll((error) =>
							Effect.sync(() =>
								wsLog.warn("Interim session list broadcast failed", error),
							),
						),
					),
				),
				Effect.forkScoped,
			);
		}

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
