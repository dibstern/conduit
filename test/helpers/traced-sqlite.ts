import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import { makeCompilerSqlite } from "effect/sql/Statement";

/** Owns one real SQLite connection for a sequential benchmark's scoped lifetime. */
export const makeTracedSqlite = (
	filename: string,
	record: (statement: string) => void,
) =>
	Effect.gen(function* () {
		const sqlite = yield* SqliteClient.make({ filename });
		const connection = yield* sqlite.reserve;
		const traced: Connection = {
			execute: (statement, params, transformRows) =>
				Effect.suspend(() => {
					record(statement);
					return connection.execute(statement, params, transformRows);
				}),
			executeRaw: (statement, params) =>
				Effect.suspend(() => {
					record(statement);
					return connection.executeRaw(statement, params);
				}),
			executeValues: (statement, params) =>
				Effect.suspend(() => {
					record(statement);
					return connection.executeValues(statement, params);
				}),
			executeUnprepared: (statement, params, transformRows) =>
				Effect.suspend(() => {
					record(statement);
					return connection.executeUnprepared(statement, params, transformRows);
				}),
			executeStream: (statement, params, transformRows) =>
				Stream.suspend(() => {
					record(statement);
					return connection.executeStream(statement, params, transformRows);
				}),
		};
		return yield* SqlClient.make({
			acquirer: Effect.succeed(traced),
			transactionAcquirer: Effect.succeed(traced),
			compiler: makeCompilerSqlite(),
			spanAttributes: [["db.system.name", "sqlite"]],
		});
	});
