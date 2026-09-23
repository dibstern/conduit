import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { makeReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";

const testLayer = EffectSqliteClient.layer({ filename: ":memory:" });

function seedSession(
	sessionId: string,
	options: {
		title?: string;
		updatedAt?: number;
		parentId?: string;
	} = {},
) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO sessions
			(id, provider, title, status, parent_id, created_at, updated_at)
			VALUES (
				${sessionId},
				'claude',
				${options.title ?? "Test"},
				'idle',
				${options.parentId ?? null},
				${options.updatedAt ?? 1},
				${options.updatedAt ?? 1}
			)`;
	});
}

describe("ReadQueryEffect.listSessions", () => {
	it.effect("applies deterministic keyset paging, roots, and limits", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("z", { updatedAt: 300 });
			yield* seedSession("y", { updatedAt: 200 });
			yield* seedSession("x", { updatedAt: 200, parentId: "z" });
			yield* seedSession("a", { updatedAt: 200 });
			yield* seedSession("w", { updatedAt: 100 });
			const readQuery = yield* makeReadQueryEffect;

			expect((yield* readQuery.listSessions()).map((row) => row.id)).toEqual([
				"z",
				"y",
				"x",
				"a",
				"w",
			]);
			expect(
				(yield* readQuery.listSessions({
					roots: true,
					limit: 2,
				})).map((row) => row.id),
			).toEqual(["z", "y"]);
			expect(
				(yield* readQuery.listSessions({
					before: { updatedAt: 200, id: "y" },
					limit: 2,
				})).map((row) => row.id),
			).toEqual(["x", "a"]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"searches ASCII case-insensitively and escapes LIKE wildcards",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("literal", {
					title: "Alpha 100%_done\\now",
					updatedAt: 3,
				});
				yield* seedSession("case-match", {
					title: "alpha ordinary",
					updatedAt: 2,
				});
				yield* seedSession("wildcard-decoy", {
					title: "Alpha 100XYdone-now",
					updatedAt: 1,
				});
				const readQuery = yield* makeReadQueryEffect;

				expect(
					(yield* readQuery.listSessions({ titleQuery: "ALPHA" })).map(
						(row) => row.id,
					),
				).toEqual(["literal", "case-match", "wildcard-decoy"]);
				expect(
					(yield* readQuery.listSessions({ titleQuery: "%_done\\" })).map(
						(row) => row.id,
					),
				).toEqual(["literal"]);
			}).pipe(Effect.provide(testLayer)),
	);
});

describe("ReadQueryEffect.countPendingApprovalsBySession", () => {
	it.effect("counts pending approvals by session and type", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1");
			yield* seedSession("s2");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO pending_approvals
				(id, session_id, type, status, created_at)
				VALUES
				('p1', 's1', 'permission', 'pending', 1),
				('p2', 's1', 'permission', 'pending', 2),
				('q1', 's1', 'question', 'pending', 3),
				('q2', 's2', 'question', 'pending', 4),
				('resolved', 's2', 'permission', 'resolved', 5)`;

			const readQuery = yield* makeReadQueryEffect;
			const counts = [
				...(yield* readQuery.countPendingApprovalsBySession()),
			].sort((a, b) =>
				`${a.session_id}:${a.type}`.localeCompare(`${b.session_id}:${b.type}`),
			);

			expect(counts).toEqual([
				{ session_id: "s1", type: "permission", pending_count: 2 },
				{ session_id: "s1", type: "question", pending_count: 1 },
				{ session_id: "s2", type: "question", pending_count: 1 },
			]);
		}).pipe(Effect.provide(testLayer)),
	);
});

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
