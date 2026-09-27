import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	DURABLE_SESSION_COLUMNS,
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";

// Durable columns are not projection-owned: nothing rebuilds them from events,
// so a migration that recreates `sessions` without carrying them over wipes
// them for good. Each registered column is written right after the migration
// that introduces it, then the rest of the chain runs over it.

const runInMemory = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(
			Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" })),
		),
	);

describe("durable session columns", () => {
	it("registers seen_version, so the chain check below cannot pass vacuously", () => {
		expect(Object.keys(DURABLE_SESSION_COLUMNS)).toContain("seen_version");
	});

	for (const [column, introducedBy] of Object.entries(
		DURABLE_SESSION_COLUMNS,
	)) {
		it(`${column} survives every migration after ${introducedBy}`, async () => {
			const keys = Object.keys(effectMigrationEntries);
			const introducedAt = keys.indexOf(introducedBy);
			expect(introducedAt, `${introducedBy} is not a migration key`).not.toBe(
				-1,
			);

			const value = await runInMemory(
				Effect.gen(function* () {
					yield* makeEffectSqlMigrator(
						Object.fromEntries(
							Object.entries(effectMigrationEntries).slice(0, introducedAt + 1),
						),
					);
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s', 'claude', 1, 1)`;
					yield* sql.unsafe(
						`UPDATE sessions SET ${column} = 41 WHERE id = 's'`,
					);
					yield* makeEffectSqlMigrator();
					return yield* sql.unsafe<Record<string, unknown>>(
						`SELECT ${column} AS value FROM sessions WHERE id = 's'`,
					);
				}),
			);

			expect(value).toEqual([{ value: 41 }]);
		});
	}
});
