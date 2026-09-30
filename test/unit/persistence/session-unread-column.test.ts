import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";

// Ways the generated `sessions.unread` column can be wrong, listed before the
// column exists:
// - a session with no turn end shows a dot (NULL compared as a number);
// - a never-seen session with a turn end shows no dot (NULL seen_version);
// - seen at the latest turn end still shows a dot (off by one);
// - a newer turn end after the seen one shows no dot;
// - a sub-agent child shows a dot (parent_id alone treated as a fork);
// - a fork shows no dot (fork excluded with the sub-agents), whether its
//   lineage carries fork_point_event or only fork_point_timestamp.

const cases = [
	["root, no turn end", {}, 0],
	["root, never seen", { last_turn_end_version: 5 }, 1],
	[
		"root, seen at the turn end",
		{ last_turn_end_version: 5, seen_version: 5 },
		0,
	],
	["root, newer turn end", { last_turn_end_version: 7, seen_version: 5 }, 1],
	["sub-agent child", { parent_id: "root", last_turn_end_version: 5 }, 0],
	[
		"fork by event",
		{ parent_id: "root", fork_point_event: "m1", last_turn_end_version: 5 },
		1,
	],
	[
		"fork by timestamp",
		{ parent_id: "root", fork_point_timestamp: 10, last_turn_end_version: 5 },
		1,
	],
] as const;

describe("sessions.unread", () => {
	for (const [name, columns, unread] of cases) {
		it(`${name} → ${unread}`, async () => {
			const rows = await Effect.runPromise(
				Effect.gen(function* () {
					yield* makeEffectSqlMigrator();
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('root', 'claude', 1, 1), ('s', 'claude', 1, 1)`;
					for (const [column, value] of Object.entries(columns))
						yield* sql.unsafe(
							`UPDATE sessions SET ${column} = ? WHERE id = 's'`,
							[value],
						);
					return yield* sql<{
						unread: number;
					}>`SELECT unread FROM sessions WHERE id = 's'`;
				}).pipe(
					Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" })),
				),
			);
			expect(rows).toEqual([{ unread }]);
		});
	}
});
