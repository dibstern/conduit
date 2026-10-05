import { createRequire } from "node:module";
import { Cause, Effect, Exit, Layer, Scope } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import { formatErrorDetail } from "../../../errors.js";
import { PtyManager } from "../../../relay/pty-manager.js";
import { connectPtyUpstream } from "../../../relay/pty-upstream.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import {
	ConfigTag,
	ConnectPtyUpstreamTag,
	LoggerTag,
	PtyManagerTag,
} from "../Services/services.js";

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
					try: () => manager.detachAll(),
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
	PtyManagerTag | OpenCodeInstancesTag | ConfigTag | LoggerTag
> =>
	Layer.effect(
		ConnectPtyUpstreamTag,
		Effect.gen(function* () {
			const ptyManager = yield* PtyManagerTag;
			const instances = yield* OpenCodeInstancesTag;
			const config = yield* ConfigTag;
			const log = yield* LoggerTag;
			const ptyLog = log.child("pty");
			// An attached OpenCode PTY holds a `use` scope until its upstream closes.
			return (ptyId: string, cursor?: number) =>
				Effect.gen(function* () {
					const attached = yield* Scope.make();
					const release = Scope.close(attached, Exit.void);
					const client = yield* instances
						.use(defaultInstanceIdForDriver("opencode"))
						.pipe(
							Scope.extend(attached),
							Effect.tapError(() => release),
						);
					yield* Effect.tryPromise({
						try: () =>
							connectPtyUpstream(
								{
									ptyManager,
									client,
									opencodeUrl: client.getBaseUrl(),
									projectDir: config.projectDir,
									log: ptyLog,
									WebSocketClass,
									onClose: () => Effect.runFork(release),
								},
								ptyId,
								cursor,
							),
						catch: (cause) => cause,
					}).pipe(Effect.tapError(() => release));
				});
		}),
	);

export const makePtyRuntimeLive = (
	WebSocketClass: typeof import("ws").WebSocket = DefaultWebSocketClass,
): Layer.Layer<
	PtyManagerTag | ConnectPtyUpstreamTag,
	never,
	OpenCodeInstancesTag | ConfigTag | LoggerTag
> =>
	Layer.provideMerge(
		makeConnectPtyUpstreamLive(WebSocketClass),
		PtyManagerLive,
	);
