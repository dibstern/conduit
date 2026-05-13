import { createRequire } from "node:module";
import { Cause, Effect, Layer } from "effect";
import { formatErrorDetail } from "../errors.js";
import { PtyManager } from "../relay/pty-manager.js";
import { connectPtyUpstream } from "../relay/pty-upstream.js";
import {
	ConfigTag,
	ConnectPtyUpstreamTag,
	LoggerTag,
	OpenCodeAPITag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "./services.js";

const requireWs = createRequire(import.meta.url);
const wsLib = requireWs("ws");
const DefaultWebSocketClass = wsLib.WebSocket as typeof import("ws").WebSocket;

export const PtyManagerLive: Layer.Layer<PtyManagerTag, never, LoggerTag> =
	Layer.scoped(
		PtyManagerTag,
		Effect.gen(function* () {
			const log = yield* LoggerTag;
			const ptyLog = log.child("pty");
			const manager = new PtyManager({ log: ptyLog });
			yield* Effect.addFinalizer(() =>
				Effect.try({
					try: () => manager.closeAll(),
					catch: (cause) => cause,
				}).pipe(
					Effect.catchAll((cause) =>
						Effect.sync(() =>
							ptyLog.warn(
								`Failed to close PTY sessions during shutdown: ${formatErrorDetail(cause)}`,
							),
						),
					),
					Effect.catchAllCause((cause) =>
						Effect.sync(() =>
							ptyLog.warn(
								`Defect while closing PTY sessions during shutdown: ${Cause.pretty(cause)}`,
							),
						),
					),
				),
			);
			return manager;
		}),
	);

export const makeConnectPtyUpstreamLive = (
	WebSocketClass: typeof import("ws").WebSocket = DefaultWebSocketClass,
): Layer.Layer<
	ConnectPtyUpstreamTag,
	never,
	PtyManagerTag | WebSocketHandlerTag | OpenCodeAPITag | ConfigTag | LoggerTag
> =>
	Layer.effect(
		ConnectPtyUpstreamTag,
		Effect.gen(function* () {
			const ptyManager = yield* PtyManagerTag;
			const wsHandler = yield* WebSocketHandlerTag;
			const client = yield* OpenCodeAPITag;
			const config = yield* ConfigTag;
			const log = yield* LoggerTag;
			const ptyLog = log.child("pty");
			return (ptyId: string, cursor?: number) =>
				connectPtyUpstream(
					{
						ptyManager,
						wsHandler,
						client,
						opencodeUrl: config.opencodeUrl,
						log: ptyLog,
						WebSocketClass,
					},
					ptyId,
					cursor,
				);
		}),
	);

export const makePtyRuntimeLive = (
	WebSocketClass: typeof import("ws").WebSocket = DefaultWebSocketClass,
): Layer.Layer<
	PtyManagerTag | ConnectPtyUpstreamTag,
	never,
	WebSocketHandlerTag | OpenCodeAPITag | ConfigTag | LoggerTag
> =>
	Layer.provideMerge(
		makeConnectPtyUpstreamLive(WebSocketClass),
		PtyManagerLive,
	);
