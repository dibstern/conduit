import { createRequire } from "node:module";
import { Cause, Deferred, Effect, Exit, Layer, Option } from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
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
	Layer.scoped(
		ConnectPtyUpstreamTag,
		Effect.gen(function* () {
			const ptyManager = yield* PtyManagerTag;
			const instances = yield* OpenCodeInstancesTag;
			const config = yield* ConfigTag;
			const log = yield* LoggerTag;
			const ptyLog = log.child("pty");
			const scope = yield* Effect.scope;
			return (ptyId: string, cursor?: number) =>
				Effect.gen(function* () {
					const ready = yield* Deferred.make<void, unknown>();
					const closed = yield* Deferred.make<void>();
					yield* Effect.gen(function* () {
						const client = yield* instances.useIfRunning(
							MANAGED_OPENCODE_ACCOUNT_ID,
						);
						if (Option.isNone(client)) return;
						yield* Effect.tryPromise({
							try: (signal) =>
								connectPtyUpstream(
									{
										ptyManager,
										client: client.value,
										opencodeUrl: client.value.getBaseUrl(),
										projectDir: config.projectDir,
										log: ptyLog,
										WebSocketClass,
										signal,
										onClose: () => Deferred.unsafeDone(closed, Exit.void),
									},
									ptyId,
									cursor,
								),
							catch: (cause) => cause,
						});
						yield* Deferred.succeed(ready, undefined);
						yield* Deferred.await(closed);
					}).pipe(
						Effect.scoped,
						Effect.onExit((exit) => Deferred.done(ready, exit)),
						Effect.catchAll(() => Effect.void),
						Effect.forkIn(scope),
					);
					yield* Deferred.await(ready);
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
