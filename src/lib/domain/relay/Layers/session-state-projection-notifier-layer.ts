import { Cause, Effect, Layer, Option, Ref, Scope } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import {
	type SessionStateProjectionNotifier,
	SessionStateProjectionNotifierTag,
} from "../../../persistence/effect/session-state-projection-notifier.js";
import { SessionManagerServiceTag } from "../Services/session-manager-service.js";

const logFailure = (operation: string, cause: Cause.Cause<unknown>) => {
	if (Cause.isInterruptedOnly(cause)) return Effect.interrupt;
	const failure = Cause.failureOption(cause);
	const detail = Option.isSome(failure)
		? formatErrorDetail(failure.value)
		: Cause.pretty(cause);
	return Effect.logError(`${operation}: ${detail}\n${Cause.pretty(cause)}`);
};

export const makeSessionStateProjectionNotifierLive = (
	refreshSessionGit: () => Promise<void> = async () => {},
): Layer.Layer<
	SessionStateProjectionNotifierTag,
	never,
	SessionManagerServiceTag
> =>
	Layer.scoped(
		SessionStateProjectionNotifierTag,
		Effect.gen(function* () {
			const scope = yield* Scope.Scope;
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
				// value is forked repeatedly, and pushViewerFamilies happens to be
				// lazy today; relying on that would make a future eager read here
				// publish one frozen snapshot forever.
				Effect.zipRight(
					Effect.suspend(() => sessionManagerService.pushViewerFamilies()),
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
					// Arming happens inside the uninterruptible commit, and a fork inherits
					// that. Without this the scope-close interrupt waits out the sleep.
					yield* Effect.forkIn(
						Effect.interruptible(broadcastSessionLists),
						scope,
					);
				}
			});

			return {
				sessionStateProjected: (sessionId, eventType) =>
					Effect.gen(function* () {
						if (eventType === "turn.completed" || eventType === "turn.error") {
							yield* Effect.forkDaemon(
								Effect.tryPromise(() => refreshSessionGit()).pipe(
									Effect.catchAllCause((cause) =>
										logFailure("Failed to refresh session git state", cause),
									),
									Effect.zipRight(armBroadcast),
								),
							);
						} else {
							yield* armBroadcast;
						}
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

export const SessionStateProjectionNotifierLive =
	makeSessionStateProjectionNotifierLive();
