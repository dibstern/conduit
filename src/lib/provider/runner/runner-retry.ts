import { Duration, Effect, Schedule } from "effect";
import * as Failure from "../../effect/failure-classification.js";

/** Durable obligations keep retrying, with bounded load during an outage. */
export const runnerRetrySchedule = Schedule.exponential("100 millis").pipe(
	Schedule.jittered,
	Schedule.modifyDelay(({ duration }) =>
		Effect.succeed(
			Duration.millis(Math.ceil(Math.min(Duration.toMillis(duration), 30_000))),
		),
	),
);

export const retryRunnerPersistence = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, never, R> =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Failure.isInterruptedOnly(cause) ? Effect.interrupt : Effect.fail(cause),
		),
		Effect.retry(runnerRetrySchedule),
		// This schedule never ends. Exhaustion would be a programming error.
		Effect.orDie,
	);
