// Thin wrapper around @effect/sql-sqlite-node providing schema migration,
// health checking and transaction helpers for the relay event store.

import { SqlClient } from "@effect/sql";
import { Context, Data, Effect, Layer } from "effect";
import {
	MAX_PURGEABLE_SKELETON_SESSIONS,
	makeEffectSqlMigrator,
	selectLegacySkeletonSessionIds,
} from "../../../persistence/effect/migrations.js";
import { PROJECT_PROVENANCE_TABLES } from "../../../persistence/schema.js";

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
	operation: string;
	cause: unknown;
}> {}

export interface PersistenceService {
	readonly projectId: string;
	readonly migrate: Effect.Effect<void, PersistenceError>;
	readonly healthCheck: Effect.Effect<boolean, PersistenceError>;
	readonly sql: SqlClient.SqlClient;
}

export class PersistenceServiceTag extends Context.Tag("PersistenceService")<
	PersistenceServiceTag,
	PersistenceService
>() {}

/** Required when constructing a store; write call sites inherit its owner. */
export class PersistenceProjectTag extends Context.Tag("PersistenceProject")<
	PersistenceProjectTag,
	{ readonly projectId: string }
>() {}

export const makePersistenceServiceLive: Layer.Layer<
	PersistenceServiceTag,
	PersistenceError,
	SqlClient.SqlClient | PersistenceProjectTag
> = Layer.effect(
	PersistenceServiceTag,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const { projectId } = yield* PersistenceProjectTag;
		if (projectId.trim().length === 0) {
			return yield* new PersistenceError({
				operation: "stampProjectProvenance",
				cause: "A store requires a non-empty project id",
			});
		}

		// Schema expansion cannot know the slug. Stamp legacy rows before any
		// consumer can obtain this store, atomically across every write table.
		const stampProjectProvenance = sql.withTransaction(
			Effect.gen(function* () {
				for (const table of PROJECT_PROVENANCE_TABLES) {
					const unstamped = "project_id IS NULL OR project_id = ''";
					const rows = yield* sql.unsafe(
						`SELECT 1 FROM ${table} WHERE ${unstamped} LIMIT 1`,
					);
					if (rows.length === 0) continue;
					yield* sql.unsafe(
						`UPDATE ${table} SET project_id = ? WHERE ${unstamped}`,
						[projectId],
					);
				}
			}),
		);

		const migrate = makeEffectSqlMigrator().pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.zipRight(stampProjectProvenance),
			Effect.asVoid,
			Effect.mapError(
				(e) => new PersistenceError({ operation: "migrate", cause: e }),
			),
			Effect.withSpan("persistence.migrate"),
		);

		yield* sql
			.unsafe("PRAGMA foreign_keys = OFF")
			.pipe(
				Effect.mapError(
					(e) => new PersistenceError({ operation: "migrate", cause: e }),
				),
			);
		yield* migrate.pipe(
			Effect.ensuring(
				sql.unsafe("PRAGMA foreign_keys = ON").pipe(Effect.ignore),
			),
		);

		// Boot diagnostic: if the 0010 purge circuit breaker tripped, the cohort is still
		// present and must stay noticeable on every boot, not just the boot that tripped it.
		// catchAllCause, not catchAll: this must swallow DEFECTS too, or a throw inside
		// the query would defeat the whole point of the wrapper and turn a safety check
		// into the outage it exists to avoid.
		yield* selectLegacySkeletonSessionIds.pipe(
			Effect.flatMap((ids) =>
				ids.length > MAX_PURGEABLE_SKELETON_SESSIONS
					? Effect.logError(
							`Legacy skeleton purge circuit breaker is TRIPPED: ${ids.length} sessions match ` +
								`the purge predicate, above the ${MAX_PURGEABLE_SKELETON_SESSIONS} threshold. ` +
								`Nothing has been deleted. Review the predicate before raising the threshold; ` +
								`the full id list was logged once by migration 0010_purge_legacy_skeleton_sessions.`,
						)
					: Effect.void,
			),
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.catchAllCause(() => Effect.void),
			Effect.withSpan("persistence.legacySkeletonBreakerCheck"),
		);

		const healthCheck = sql`SELECT 1 AS ok`.pipe(
			Effect.map((rows) => rows.length > 0),
			Effect.mapError(
				(e) => new PersistenceError({ operation: "healthCheck", cause: e }),
			),
			Effect.withSpan("persistence.healthCheck"),
		);

		return { projectId, migrate, healthCheck, sql };
	}),
);

// Transaction helper — accesses SqlClient from context
export const withTransaction = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PersistenceError, R | SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* sql.withTransaction(effect);
	}).pipe(
		Effect.mapError((e) =>
			e instanceof PersistenceError
				? e
				: new PersistenceError({ operation: "transaction", cause: e }),
		),
	);
