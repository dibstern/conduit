// test/unit/effect/sqlite-transactions.test.ts

import { afterEach, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("Effect-managed SQLite transactions", () => {
	let db: SqliteClient;

	afterEach(() => {
		db?.close();
	});

	it.effect("commits on success", () =>
		Effect.gen(function* () {
			db = SqliteClient.memory();
			db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

			yield* db.runInTransactionEffect(
				Effect.sync(() => {
					db.execute("INSERT INTO test (val) VALUES (?)", ["hello"]);
				}),
			);
			const rows = db.query("SELECT val FROM test");
			expect(rows).toEqual([{ val: "hello" }]);
		}),
	);

	it.effect("rolls back on failure", () =>
		Effect.gen(function* () {
			db = SqliteClient.memory();
			db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

			const exit = yield* Effect.exit(
				db.runInTransactionEffect(
					Effect.flatMap(
						Effect.sync(() =>
							db.execute("INSERT INTO test (val) VALUES (?)", ["hello"]),
						),
						() => Effect.fail(new Error("boom")),
					),
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);

			const rows = db.query("SELECT val FROM test");
			expect(rows).toEqual([]); // Rolled back
		}),
	);

	it("supports nested transactions via savepoints", () => {
		db = SqliteClient.memory();
		db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

		const program = db.runInTransactionEffect(
			Effect.sync(() => {
				db.execute("INSERT INTO test (val) VALUES (?)", ["outer"]);
				Effect.runSync(
					db.runInTransactionEffect(
						Effect.sync(() => {
							db.execute("INSERT INTO test (val) VALUES (?)", ["inner"]);
						}),
					),
				);
			}),
		);

		Effect.runSync(program);
		const rows = db.query<{ val: string }>("SELECT val FROM test ORDER BY id");
		expect(rows).toEqual([{ val: "outer" }, { val: "inner" }]);
	});

	it("rolls back only inner savepoint on nested failure when outer catches", () => {
		db = SqliteClient.memory();
		db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

		const program = db.runInTransactionEffect(
			Effect.sync(() => {
				db.execute("INSERT INTO test (val) VALUES (?)", ["outer"]);
				const innerExit = Effect.runSyncExit(
					db.runInTransactionEffect(
						Effect.flatMap(
							Effect.sync(() =>
								db.execute("INSERT INTO test (val) VALUES (?)", ["inner"]),
							),
							() => Effect.fail(new Error("inner boom")),
						),
					),
				);
				// Inner failed, but outer continues
				expect(Exit.isFailure(innerExit)).toBe(true);
			}),
		);

		Effect.runSync(program);
		const rows = db.query<{ val: string }>("SELECT val FROM test ORDER BY id");
		expect(rows).toEqual([{ val: "outer" }]);
	});
});
