import { Cause, Effect, Layer, Ref } from "effect";
import {
	type SessionStateProjectionNotifier,
	SessionStateProjectionNotifierTag,
} from "../../../persistence/effect/session-state-projection-notifier.js";
import { WebSocketHandlerTag } from "../Services/services.js";
import { SessionManagerServiceTag } from "../Services/session-manager-service.js";

const logFailure = (operation: string, cause: Cause.Cause<unknown>) =>
	Effect.logError(`${operation}: ${Cause.pretty(cause)}`);

export const SessionStateProjectionNotifierLive: Layer.Layer<
	SessionStateProjectionNotifierTag,
	never,
	WebSocketHandlerTag | SessionManagerServiceTag
> = Layer.effect(
	SessionStateProjectionNotifierTag,
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const broadcastPending = yield* Ref.make(false);

		// One broadcast per burst. A streaming turn projects thousands of deltas
		// and the list only has to be right at the end of them.
		const broadcastSessionLists = Effect.sleep("150 millis").pipe(
			// Release the slot BEFORE reading the list, not after the fan-out.
			// A state change that lands while a broadcast is in flight has to arm
			// a fresh cycle: if the slot stayed taken until the fan-out finished,
			// that change would be dropped with nothing left to ever broadcast it,
			// which is the exact staleness this service exists to prevent. Paying
			// for it with an occasional redundant broadcast is a good trade -- a
			// duplicate list is invisible, a missing one is the bug.
			Effect.zipRight(Ref.set(broadcastPending, false)),
			// Suspended so each broadcast builds its own effect. The same effect
			// value is forked repeatedly, and sendSessionLists happens to be
			// lazy today; relying on that would make a future eager read here
			// publish one frozen snapshot forever.
			Effect.zipRight(
				Effect.suspend(() =>
					sessionManagerService.sendSessionLists((message) =>
						wsHandler.broadcast(message),
					),
				),
			),
			Effect.catchAllCause((cause) =>
				logFailure("Failed to broadcast projected session state", cause),
			),
			// Only reachable if the fiber is interrupted during the sleep, e.g. at
			// runtime teardown. Without it an interrupt there would leave the slot
			// taken and silence every later broadcast.
			Effect.ensuring(Ref.set(broadcastPending, false)),
		);

		const armBroadcast = Effect.gen(function* () {
			const alreadyPending = yield* Ref.getAndSet(broadcastPending, true);
			if (!alreadyPending) {
				yield* Effect.forkDaemon(broadcastSessionLists);
			}
		});

		const markViewedTurnRead: SessionStateProjectionNotifier["sessionStateProjected"] =
			(sessionId, eventType) => {
				if (eventType !== "turn.completed" && eventType !== "turn.error") {
					return Effect.void;
				}
				if (wsHandler.getClientsForSession(sessionId).length === 0) {
					return Effect.void;
				}
				return sessionManagerService
					.markSessionRead(sessionId)
					.pipe(
						Effect.catchAllCause((cause) =>
							logFailure(
								`Failed to mark viewed session ${sessionId} read`,
								cause,
							),
						),
					);
			};

		return {
			sessionStateProjected: (sessionId, eventType) =>
				Effect.gen(function* () {
					// Read first, then arm: the timer that follows is what publishes
					// the result, so recording the read after arming would race its
					// own broadcast and rely on a second cycle to correct the list.
					//
					// Awaited, not forked, and it re-enters the projection runner --
					// marking read appends session.read, which projects, which calls
					// back in here. That terminates, because session.read is not a
					// turn type, and it runs outside the caller's transaction. The
					// cost is one extra write per turn boundary, which buys the
					// guarantee above.
					yield* markViewedTurnRead(sessionId, eventType);
					yield* armBroadcast;
				}).pipe(
					Effect.catchAllCause((cause) =>
						logFailure(
							`Failed to handle projected session state for ${sessionId}`,
							cause,
						),
					),
				),
		} satisfies SessionStateProjectionNotifier;
	}),
);
