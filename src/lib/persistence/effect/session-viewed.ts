import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import type { CommitAndSignalFailure } from "./commit-and-signal.js";
import { makeCommitAndSignal } from "./commit-and-signal.js";
import type { EventStoreEffectTag } from "./event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";

/**
 * Record that the user looked at a session.
 *
 * Viewing is not a mutation of the session — nothing about it is worth
 * replaying, and ADR-0004 governs changes to the session, not attention paid to
 * it. So this writes the read model directly instead of appending an event,
 * which makes it the one write in the system with no projector behind it.
 *
 * It still goes through the seam. The seam hands out the read-model version and
 * takes back the ids of the rows stamped with it, then announces them from the
 * same post-COMMIT publish every projection uses. A subscriber watching
 * `sessions.version` therefore hears about a view exactly the way it hears about
 * a message: the row moved, re-query it. There is no side channel and no second
 * publish to keep in step.
 *
 * Returns false when no row was stamped — the session is gone, or was never
 * there. The caller is expected to say so rather than swallow it: a view that
 * silently writes nothing looks identical to one that worked.
 */
export const markSessionViewed = (
	sessionId: string,
	at: number,
): Effect.Effect<
	boolean,
	CommitAndSignalFailure | SqlError,
	SqlClient.SqlClient | EventStoreEffectTag | ProjectionRunnerEffectTag
> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commitAndSignal = yield* makeCommitAndSignal;

		const stamped = yield* commitAndSignal.write((_project, stamp) =>
			// One statement: the column and the version move together or not at
			// all. Splitting them is how the write becomes invisible.
			stamp((version) =>
				sql<{
					id: string;
				}>`UPDATE sessions SET last_viewed_at = ${at}, version = ${version} WHERE id = ${sessionId} RETURNING id`.pipe(
					Effect.map((rows) => rows.map((row) => row.id)),
				),
			),
		);

		return stamped.length > 0;
	});
