// test/unit/persistence/persistence-effect.test.ts

import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	makePersistenceServiceLive,
	PersistenceServiceTag,
	withTransaction,
} from "../../../src/lib/effect/persistence-service.js";

// In-memory SQLite for tests
const TestSqlLayer = SqliteClient.layer({ filename: ":memory:" });

describe("Persistence Effect", () => {
	it.effect("migrate creates events table", () =>
		Effect.gen(function* () {
			const persistence = yield* PersistenceServiceTag;
			yield* persistence.migrate;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO events (type, payload) VALUES ('test', '{}')`;
			const rows = yield* sql`SELECT * FROM events`;
			expect(rows.length).toBe(1);
		}).pipe(
			Effect.provide(
				Layer.provideMerge(makePersistenceServiceLive, TestSqlLayer),
			),
		),
	);

	it.effect("healthCheck returns true", () =>
		Effect.gen(function* () {
			const persistence = yield* PersistenceServiceTag;
			const healthy = yield* persistence.healthCheck;
			expect(healthy).toBe(true);
		}).pipe(
			Effect.provide(
				Layer.provideMerge(makePersistenceServiceLive, TestSqlLayer),
			),
		),
	);

	it.effect("evictBefore deletes old events", () =>
		Effect.gen(function* () {
			const persistence = yield* PersistenceServiceTag;
			yield* persistence.migrate;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO events (type, payload, created_at) VALUES ('old', '{}', 1000)`;
			yield* sql`INSERT INTO events (type, payload, created_at) VALUES ('new', '{}', 9999999999)`;
			const deleted = yield* persistence.evictBefore(5000);
			expect(deleted).toBe(1);
			const remaining = yield* sql`SELECT * FROM events`;
			expect(remaining.length).toBe(1);
		}).pipe(
			Effect.provide(
				Layer.provideMerge(makePersistenceServiceLive, TestSqlLayer),
			),
		),
	);

	it.effect("withTransaction commits on success", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE test_items (id INTEGER PRIMARY KEY, name TEXT)`;
			yield* withTransaction(
				sql`INSERT INTO test_items (id, name) VALUES (1, 'item-1')`,
			);
			const rows = yield* sql`SELECT * FROM test_items`;
			expect(rows.length).toBe(1);
		}).pipe(Effect.provide(TestSqlLayer)),
	);

	it.effect("withTransaction rolls back on failure", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE test_rollback (id INTEGER PRIMARY KEY, name TEXT)`;
			yield* withTransaction(
				Effect.gen(function* () {
					yield* sql`INSERT INTO test_rollback (id, name) VALUES (1, 'x')`;
					yield* Effect.fail(new Error("boom"));
				}),
			).pipe(Effect.catchAll(() => Effect.void));
			const rows = yield* sql`SELECT * FROM test_rollback`;
			expect(rows.length).toBe(0);
		}).pipe(Effect.provide(TestSqlLayer)),
	);
});
