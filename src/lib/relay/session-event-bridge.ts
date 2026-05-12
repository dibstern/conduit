// ─── Session Event Bridge ───────────────────────────────────────────────────
// Temporary Layer: streams SessionManager EventEmitter events into DaemonEventBus.
//
// DELETE THIS FILE when SessionManager is converted to an Effect service that
// publishes directly to DaemonEventBus (Phase 7 Task 9+ / SessionManager conversion).

import { Deferred, Effect, Layer, PubSub, Stream } from "effect";
import { DaemonEvent, DaemonEventBusTag } from "../effect/daemon-pubsub.js";
import { SessionManagerTag } from "../effect/services.js";
import type { RelayMessage } from "../types.js";

/**
 * Scoped Layer that registers EventEmitter listeners on SessionManager
 * and republishes events to DaemonEventBus PubSub.
 *
 * Requires: SessionManagerTag, DaemonEventBusTag.
 */
export const SessionEventBridgeLive: Layer.Layer<
	never,
	never,
	SessionManagerTag | DaemonEventBusTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const sessionMgr = yield* SessionManagerTag;
		const bus = yield* DaemonEventBusTag;
		const registered = yield* Deferred.make<void>();

		const events = Stream.asyncPush<DaemonEvent>(
			(emit) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const broadcastHandler = (msg: RelayMessage) => {
							emit.single(DaemonEvent.RelayBroadcast({ message: msg }));
						};

						const lifecycleHandler = (ev: {
							type: "created" | "deleted";
							sessionId: string;
						}) => {
							emit.single(
								ev.type === "created"
									? DaemonEvent.SessionCreated({ sessionId: ev.sessionId })
									: DaemonEvent.SessionDeleted({ sessionId: ev.sessionId }),
							);
						};

						sessionMgr.on("broadcast", broadcastHandler);
						sessionMgr.on("session_lifecycle", lifecycleHandler);

						return { broadcastHandler, lifecycleHandler };
					}).pipe(Effect.tap(() => Deferred.succeed(registered, undefined))),
					({ broadcastHandler, lifecycleHandler }) =>
						Effect.sync(() => {
							sessionMgr.off("broadcast", broadcastHandler);
							sessionMgr.off("session_lifecycle", lifecycleHandler);
						}),
				),
			{ bufferSize: 256, strategy: "sliding" },
		);

		yield* Effect.forkScoped(
			events.pipe(Stream.runForEach((event) => PubSub.publish(bus, event))),
		);
		yield* Deferred.await(registered);
	}),
);
