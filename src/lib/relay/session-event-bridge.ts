// ─── Session Event Bridge ───────────────────────────────────────────────────
// Temporary Layer: forwards SessionManager EventEmitter events to DaemonEventBus PubSub.
//
// DELETE THIS FILE when SessionManager is converted to an Effect service that
// publishes directly to DaemonEventBus (Phase 7 Task 9+ / SessionManager conversion).

import { Effect, Layer, PubSub } from "effect";
import { DaemonEvent, DaemonEventBusTag } from "../effect/daemon-pubsub.js";
import { SessionManagerTag } from "../effect/services.js";
import type { RelayMessage } from "../types.js";

/**
 * Scoped Layer that registers EventEmitter listeners on SessionManager
 * and republishes events to DaemonEventBus PubSub.
 *
 * Uses Effect.runSync(PubSub.publish(...)) — safe because PubSub.sliding
 * publish is synchronous (never blocks).
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

		const broadcastHandler = (msg: RelayMessage) => {
			Effect.runSync(
				PubSub.publish(bus, DaemonEvent.RelayBroadcast({ message: msg })),
			);
		};

		const lifecycleHandler = (ev: {
			type: "created" | "deleted";
			sessionId: string;
		}) => {
			const event =
				ev.type === "created"
					? DaemonEvent.SessionCreated({ sessionId: ev.sessionId })
					: DaemonEvent.SessionDeleted({ sessionId: ev.sessionId });
			Effect.runSync(PubSub.publish(bus, event));
		};

		sessionMgr.on("broadcast", broadcastHandler);
		sessionMgr.on("session_lifecycle", lifecycleHandler);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				sessionMgr.off("broadcast", broadcastHandler);
				sessionMgr.off("session_lifecycle", lifecycleHandler);
			}),
		);
	}),
);
