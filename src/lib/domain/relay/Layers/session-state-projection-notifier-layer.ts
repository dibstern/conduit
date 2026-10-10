import { Cause, Effect, Layer, Option, Ref, Scope } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import {
	type SessionStateProjectionNotifier,
	SessionStateProjectionNotifierTag,
} from "../../../persistence/effect/session-state-projection-notifier.js";
import { SessionGitServiceTag } from "../Services/session-git-service.js";
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
			const sessionGit = yield* Effect.serviceOption(SessionGitServiceTag);
			const broadcastPending = yield* Ref.make(false);

			// One lineage refresh per burst. A streaming turn projects thousands of
			// deltas, and the parent map and session count only have to be right at
			// the end of them. The sidebar and family feeds follow the store
			// themselves.
			const refreshLineage = Effect.sleep("150 millis").pipe(
				// Release the slot BEFORE reading lineage, not after the refresh.
				// A state change that lands while a refresh is in flight has to arm
				// a fresh cycle: if the slot stayed taken until the refresh finished,
				// that change would be dropped with nothing left to ever read it,
				// which is the exact staleness this service exists to prevent. Paying
				// for it with an occasional redundant read is a good trade.
				Effect.zipRight(Ref.set(broadcastPending, false)),
				// Suspended so each refresh builds its own effect. The same effect
				// value is forked repeatedly, and refreshSessionLineage happens to be
				// lazy today; relying on that would make a future eager read here
				// apply one frozen snapshot forever.
				Effect.zipRight(
					Effect.suspend(() => sessionManagerService.refreshSessionLineage()),
				),
				Effect.catchAllCause((cause) =>
					logFailure("Failed to refresh session lineage", cause),
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
					yield* Effect.forkIn(Effect.interruptible(refreshLineage), scope);
				}
			});

			return {
				sessionStateProjected: (sessionId, eventType) =>
					Effect.gen(function* () {
						if (
							eventType === "turn.completed" ||
							eventType === "turn.error" ||
							eventType === "turn.interrupted"
						) {
							yield* Effect.forkIn(
								Effect.interruptible(
									(Option.isSome(sessionGit)
										? sessionGit.value.refresh({ sessionId })
										: Effect.tryPromise(() => refreshSessionGit())
									).pipe(
										Effect.catchAllCause((cause) =>
											logFailure("Failed to refresh session git state", cause),
										),
										Effect.zipRight(armBroadcast),
									),
								),
								scope,
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
