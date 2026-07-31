import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Option } from "effect";
import { SessionEventBusTag } from "../../domain/relay/Services/session-event-bus.js";
import type { CanonicalEvent } from "../events.js";
import type { EventStoreError } from "./event-store-effect.js";
import { EventStoreEffectTag } from "./event-store-effect.js";
import type { ProjectionRunnerError } from "./projection-runner-effect.js";
import { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";

export type CommitAndSignalFailure =
	| EventStoreError
	| ProjectionRunnerError
	| SqlError;

export interface CommitAndSignalOptions {
	readonly publish?: boolean;
	readonly afterAppend?: Effect.Effect<void>;
}

export type CommitAndSignal = (
	events: readonly CanonicalEvent[],
	options?: CommitAndSignalOptions,
) => Effect.Effect<void, CommitAndSignalFailure>;

export const makeCommitAndSignal = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const eventStore = yield* EventStoreEffectTag;
	const projectionRunner = yield* ProjectionRunnerEffectTag;
	const sessionEventBus = yield* Effect.serviceOption(SessionEventBusTag);

	const commitAndSignal: CommitAndSignal = (events, options = {}) =>
		Effect.uninterruptible(
			Effect.gen(function* () {
				const stored = yield* eventStore.appendBatch(events);
				yield* options.afterAppend ?? Effect.void;
				yield* projectionRunner
					.projectBatch(stored)
					.pipe(Effect.provideService(SqlClient.SqlClient, sql));

				if (
					Option.isSome(sessionEventBus) &&
					options.publish !== false &&
					stored.length > 0
				) {
					yield* sessionEventBus.value.publish(stored);
				}
			}),
		);

	return commitAndSignal;
});
