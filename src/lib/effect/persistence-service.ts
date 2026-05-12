// ─── Effect Persistence Service ──────────────────────────────────────────────
// Thin wrapper around @effect/sql-sqlite-node providing schema migration,
// health checking, eviction, and transaction helpers for the relay event store.

import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Data, Effect, Layer } from "effect";
import { runMigrationsEffect } from "../persistence/migrations.js";
import { schemaMigrations } from "../persistence/schema.js";

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
	operation: string;
	cause: unknown;
}> {}

export interface PersistenceService {
	readonly migrate: Effect.Effect<void, PersistenceError>;
	readonly healthCheck: Effect.Effect<boolean, PersistenceError>;
	readonly evictBefore: (
		timestampMs: number,
	) => Effect.Effect<number, PersistenceError>;
	readonly sql: SqlClient.SqlClient;
}

export class PersistenceServiceTag extends Context.Tag("PersistenceService")<
	PersistenceServiceTag,
	PersistenceService
>() {}

export const makePersistenceServiceLive: Layer.Layer<
	PersistenceServiceTag,
	PersistenceError,
	SqlClient.SqlClient | SqliteNode.SqliteClient
> = Layer.effect(
	PersistenceServiceTag,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const sqlite = yield* SqliteNode.SqliteClient;

		const migrate = runMigrationsEffect(schemaMigrations).pipe(
			Effect.asVoid,
			Effect.provideService(SqliteNode.SqliteClient, sqlite),
			Effect.mapError(
				(e) => new PersistenceError({ operation: "migrate", cause: e }),
			),
			Effect.withSpan("persistence.migrate"),
		);

		yield* migrate;

		const healthCheck = sql`SELECT 1 AS ok`.pipe(
			Effect.map((rows) => rows.length > 0),
			Effect.mapError(
				(e) => new PersistenceError({ operation: "healthCheck", cause: e }),
			),
			Effect.withSpan("persistence.healthCheck"),
		);

		const evictBefore = (timestampMs: number) =>
			Effect.gen(function* () {
				// Use .raw to get the better-sqlite3 RunResult with .changes
				const result =
					yield* sql`DELETE FROM events WHERE created_at < ${timestampMs}`.raw;
				return (result as { changes: number }).changes ?? 0;
			}).pipe(
				Effect.mapError((e) =>
					e instanceof PersistenceError
						? e
						: new PersistenceError({ operation: "evictBefore", cause: e }),
				),
				Effect.withSpan("persistence.evictBefore"),
			);

		return { migrate, healthCheck, evictBefore, sql };
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
