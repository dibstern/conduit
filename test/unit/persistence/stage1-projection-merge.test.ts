import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import {
	makeMessageProjector,
	makeSessionProjector,
	makeTurnProjector,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import {
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";

const database = SqliteClient.layer({ filename: ":memory:" });

describe("merged Effect projection", () => {
	it("stamps main's read and triage state", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
				VALUES ('session', 'claude', 1, 1)`;
				const projector = makeSessionProjector();
				const read: StoredEvent = {
					...canonicalEvent(
						"session.read",
						"session",
						{ sessionId: "session" },
						{ provider: "claude", createdAt: 100 },
					),
					sequence: 1,
					streamVersion: 1,
				};
				yield* projector.project(read, { version: 41 });
				expect(
					yield* sql`SELECT read_at, version FROM sessions WHERE id = 'session'`,
				).toEqual([{ read_at: 100, version: 41 }]);
				const unread: StoredEvent = {
					...canonicalEvent(
						"session.unread",
						"session",
						{ sessionId: "session" },
						{ provider: "claude", createdAt: 101 },
					),
					sequence: 2,
					streamVersion: 2,
				};
				yield* projector.project(unread, { version: 42 });
				const settled: StoredEvent = {
					...canonicalEvent(
						"session.settled",
						"session",
						{ sessionId: "session", automatic: true },
						{ provider: "claude", createdAt: 102 },
					),
					sequence: 3,
					streamVersion: 3,
				};
				yield* projector.project(settled, { version: 43 });
				expect(
					yield* sql`SELECT read_at, settled_at, settled_automatically, version FROM sessions WHERE id = 'session'`,
				).toEqual([
					{
						read_at: null,
						settled_at: 102,
						settled_automatically: 1,
						version: 43,
					},
				]);
			}).pipe(Effect.provide(database)),
		);
	});

	it("stamps the synthetic compaction message", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
				VALUES ('session', 'claude', 1, 1)`;
				const event: StoredEvent = {
					...canonicalEvent(
						"session.compaction",
						"session",
						{
							sessionId: "session",
							state: "completed",
							detail: "Compacted",
						},
						{ provider: "claude", createdAt: 200 },
					),
					sequence: 7,
					streamVersion: 1,
				};
				const touch = yield* makeMessageProjector().project(event, {
					version: 42,
				});
				expect(touch.stamped).toContain("session");
				expect(
					yield* sql`SELECT id, version FROM messages WHERE id = 'compaction-7'`,
				).toEqual([{ id: "compaction-7", version: 42 }]);
			}).pipe(Effect.provide(database)),
		);
	});

	it("stamps a snoozed ancestor woken by a child approval", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, snoozed_at, created_at, updated_at)
				VALUES ('root', 'claude', 100, 1, 1)`;
				yield* sql`INSERT INTO sessions (id, provider, parent_id, created_at, updated_at)
				VALUES ('child', 'claude', 'root', 1, 1)`;
				const event: StoredEvent = {
					...canonicalEvent(
						"permission.asked",
						"child",
						{
							id: "approval",
							sessionId: "child",
							toolName: "bash",
							input: {},
						},
						{ provider: "claude", createdAt: 200 },
					),
					sequence: 8,
					streamVersion: 1,
				};
				const touch = yield* makeSessionProjector().project(event, {
					version: 43,
				});
				expect(touch.stamped).toContain("root");
				expect(
					yield* sql`SELECT woken_reason, version FROM sessions WHERE id = 'root'`,
				).toEqual([{ woken_reason: "approval", version: 43 }]);
			}).pipe(Effect.provide(database)),
		);
	});

	it("keeps latest cost and adds per-execution tokens", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
				VALUES ('session', 'claude', 1, 1)`;
				yield* sql`INSERT INTO turns (id, session_id, state, assistant_message_id, requested_at)
				VALUES ('turn', 'session', 'running', 'answer', 1)`;
				for (const [sequence, cost, input] of [
					[1, 2.5, 10],
					[2, 3.5, 4],
				] as const) {
					const event: StoredEvent = {
						...canonicalEvent(
							"turn.completed",
							"session",
							{
								messageId: "answer",
								cost,
								tokens: { input, output: 1 },
							},
							{ provider: "claude", createdAt: 200 + sequence },
						),
						sequence,
						streamVersion: sequence,
					};
					yield* makeTurnProjector().project(event, { version: 43 + sequence });
				}
				expect(
					yield* sql`SELECT cost, tokens_in, tokens_out FROM turns WHERE id = 'turn'`,
				).toEqual([{ cost: 3.5, tokens_in: 14, tokens_out: 2 }]);
			}).pipe(Effect.provide(database)),
		);
	});
});
