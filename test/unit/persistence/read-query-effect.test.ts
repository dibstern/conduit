import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { makeReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";

const testLayer = EffectSqliteClient.layer({ filename: ":memory:" });

function seedSession(sessionId: string) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO sessions
			(id, provider, title, status, created_at, updated_at)
			VALUES (${sessionId}, 'claude', 'Test', 'idle', 1, 1)`;
	});
}

describe("ReadQueryEffect.getLatestTurnModelExecution", () => {
	it.effect("returns undefined when no turn has resolved", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO turns
				(id, session_id, state, user_message_id, requested_at)
				VALUES ('t1', 's1', 'pending', 't1', 1)`;
			const readQuery = yield* makeReadQueryEffect;
			const execution = yield* readQuery.getLatestTurnModelExecution("s1");

			expect(execution).toBeUndefined();
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("returns one resolved turn", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO turns
				(id, session_id, state, user_message_id, requested_at,
				 requested_model, expected_model, actual_model)
				VALUES
				('t1', 's1', 'running', 't1', 1,
				 'sonnet', 'claude-sonnet-5[1m]', 'claude-sonnet-5[1m]')`;
			const readQuery = yield* makeReadQueryEffect;
			const execution = yield* readQuery.getLatestTurnModelExecution("s1");

			expect(execution).toEqual({
				requested_model: "sonnet",
				expected_model: "claude-sonnet-5[1m]",
				actual_model: "claude-sonnet-5[1m]",
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"keeps the latest resolved turn while a newer turn is unresolved",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("s1");
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
				INSERT INTO turns
				(id, session_id, state, user_message_id, requested_at,
				 requested_model, expected_model, actual_model)
				VALUES
				('resolved', 's1', 'completed', 'resolved', 1,
				 'sonnet', 'claude-sonnet-5', 'claude-fable-4-0'),
				('unresolved', 's1', 'pending', 'unresolved', 2,
				 NULL, NULL, NULL)`;
				const readQuery = yield* makeReadQueryEffect;
				const execution = yield* readQuery.getLatestTurnModelExecution("s1");

				expect(execution).toEqual({
					requested_model: "sonnet",
					expected_model: "claude-sonnet-5",
					actual_model: "claude-fable-4-0",
				});
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("replaces an older drift with a newer matching resolved turn", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO turns
				(id, session_id, state, user_message_id, requested_at,
				 requested_model, expected_model, actual_model)
				VALUES
				('drift', 's1', 'completed', 'drift', 1,
				 'sonnet', 'claude-sonnet-5', 'claude-fable-4-0'),
				('match', 's1', 'running', 'match', 2,
				 'opus', 'claude-opus-4-6', 'claude-opus-4-6')`;
			const readQuery = yield* makeReadQueryEffect;
			const execution = yield* readQuery.getLatestTurnModelExecution("s1");

			expect(execution).toEqual({
				requested_model: "opus",
				expected_model: "claude-opus-4-6",
				actual_model: "claude-opus-4-6",
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("isolates resolved turns by session", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1");
			yield* seedSession("s2");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO turns
				(id, session_id, state, user_message_id, requested_at,
				 requested_model, expected_model, actual_model)
				VALUES
				('s1-turn', 's1', 'running', 's1-turn', 1,
				 'sonnet', 'claude-sonnet-5', 'claude-sonnet-5'),
				('s2-turn', 's2', 'running', 's2-turn', 2,
				 'opus', 'claude-opus-4-6', 'claude-fable-4-0')`;
			const readQuery = yield* makeReadQueryEffect;
			const execution = yield* readQuery.getLatestTurnModelExecution("s1");

			expect(execution).toEqual({
				requested_model: "sonnet",
				expected_model: "claude-sonnet-5",
				actual_model: "claude-sonnet-5",
			});
		}).pipe(Effect.provide(testLayer)),
	);
});

describe("ReadQueryEffect.getSessionMessagesWithParts", () => {
	it.effect("carries each turn's model execution on its messages", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO turns
				(id, session_id, state, user_message_id, requested_at,
				 requested_model, expected_model, actual_model)
				VALUES
				('drift-turn', 's1', 'completed', 'drift-user', 1,
				 'sonnet', 'claude-sonnet-5', 'claude-fable-4-0'),
				('historical-turn', 's1', 'completed', 'historical-user', 2,
				 NULL, NULL, NULL)`;
			yield* sql`
				INSERT INTO messages
				(id, session_id, turn_id, role, text, created_at, updated_at)
				VALUES
				('drift-user', 's1', 'drift-turn', 'user', 'First', 1, 1),
				('drift-assistant', 's1', 'drift-turn', 'assistant', 'Reply', 2, 2),
				('historical-user', 's1', 'historical-turn', 'user', 'Old', 3, 3)`;

			const readQuery = yield* makeReadQueryEffect;
			const messages = yield* readQuery.getSessionMessagesWithParts("s1");

			expect(messages[0]?.modelExecution).toEqual({
				requestedModel: "sonnet",
				expectedModel: "claude-sonnet-5",
				actualModel: "claude-fable-4-0",
			});
			expect(messages[1]?.modelExecution).toEqual(messages[0]?.modelExecution);
			expect(messages[2]).not.toHaveProperty("modelExecution");
		}).pipe(Effect.provide(testLayer)),
	);
});
