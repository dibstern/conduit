import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { makeReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";

const testLayer = EffectSqliteClient.layer({ filename: ":memory:" });

describe("ReadQueryEffect snapshot consistency", () => {
	for (const source of ["session list", "transcript"] as const) {
		it(`${source} keeps rows and counter at one committed version during a concurrent deletion`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-snapshot-"));
			const filename = join(dir, "events.db");
			const writer = new Database(filename);
			writer.pragma("journal_mode = WAL");
			let deleteAfterCounter = false;
			const layer = EffectSqliteClient.layer({
				filename,
				transformResultNames: (name) => {
					// Interleave a real second connection after the counter SELECT
					// returns, before the read continues to its rows.
					if (name === "value" && deleteAfterCounter) {
						deleteAfterCounter = false;
						writer.transaction(() => {
							writer.exec("DELETE FROM messages; DELETE FROM sessions");
							writer.exec(
								"UPDATE read_model_counter SET value = 6 WHERE id = 1",
							);
						})();
					}
					return name;
				},
			});
			try {
				await Effect.runPromise(
					Effect.gen(function* () {
						yield* makeEffectSqlMigrator();
						yield* seedSession("B");
						const sql = yield* SqlClient.SqlClient;
						yield* sql`UPDATE sessions SET version = 5 WHERE id = 'B'`;
						yield* sql`INSERT INTO messages
						(id, session_id, role, text, created_at, updated_at, version)
						VALUES ('mB', 'B', 'user', 'Before deletion', 1, 1, 5)`;
						yield* sql`UPDATE read_model_counter SET value = 5 WHERE id = 1`;
						const readQuery = yield* makeReadQueryEffect;
						const snapshot =
							source === "session list"
								? readQuery.readSessionList().pipe(
										Effect.map(({ rows, version }) => ({
											ids: rows.map(({ item }) => item.id),
											version,
										})),
									)
								: readQuery.readSessionTranscript("B").pipe(
										Effect.map(({ messages, version }) => ({
											ids: messages.map((message) => message.id),
											version,
										})),
									);
						deleteAfterCounter = true;
						expect(yield* snapshot).toEqual({
							ids: [source === "session list" ? "B" : "mB"],
							version: 5,
						});
						expect(deleteAfterCounter).toBe(false);
						expect(yield* snapshot).toEqual({ ids: [], version: 6 });
					}).pipe(Effect.provide(layer)),
				);
			} finally {
				writer.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});

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

// ─── The session list reads (ni8.5 T-1) ─────────────────────────────────────
// These two reads are the only producers of the single session type, so the
// `sessions` projection reaches the wire and the browser already shaped for
// them. Nothing downstream holds a row, which is why the bridge could go.

describe("ReadQueryEffect session list reads", () => {
	const seedForkedSession = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO sessions
			(id, provider, title, status, parent_id, fork_point_event,
			 created_at, updated_at)
			VALUES ('child', 'claude', 'Forked', 'busy', 'root', 'msg_9', 5, 9)`;
	});

	it.effect("reads sessions in the wire shape, not the row shape", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("root");
			yield* seedForkedSession;
			const readQuery = yield* makeReadQueryEffect;

			expect(
				(yield* readQuery.readSessionList()).rows.map(({ item }) => item),
			).toEqual([
				{
					id: "child",
					title: "Forked",
					status: "busy",
					createdAt: 5,
					updatedAt: 9,
					parentID: "root",
					forkMessageId: "msg_9",
					pendingQuestions: 0,
					pendingPermissions: 0,
					unseenActivity: false,
				},
				{
					id: "root",
					title: "Test",
					status: "idle",
					createdAt: 1,
					updatedAt: 1,
					pendingQuestions: 0,
					pendingPermissions: 0,
					unseenActivity: false,
				},
			]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("derives the three notification facts onto the session row", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			// `noisy` has been looked at since its last message; `quiet` never has.
			yield* sql`
				INSERT INTO sessions
				(id, provider, title, status, created_at, updated_at,
				 last_message_at, last_viewed_at)
				VALUES
				('noisy', 'claude', 'Noisy', 'idle', 1, 9, 9, 10),
				('quiet', 'claude', 'Quiet', 'idle', 1, 9, 9, NULL)`;
			yield* sql`
				INSERT INTO pending_approvals
				(id, session_id, type, status, created_at)
				VALUES
				('q1', 'noisy', 'question', 'pending', 1),
				('q2', 'noisy', 'question', 'pending', 2),
				('p1', 'noisy', 'permission', 'pending', 3),
				('q3', 'noisy', 'question', 'resolved', 4)`;
			const readQuery = yield* makeReadQueryEffect;

			// Counts come off the same rows the approval projector writes — the
			// server decides what a badge means, once, and the browser is told.
			expect(
				(yield* readQuery.readSessionList()).rows.find(
					({ item }) => item.id === "noisy",
				)?.item,
			).toEqual({
				id: "noisy",
				title: "Noisy",
				status: "idle",
				createdAt: 1,
				updatedAt: 9,
				pendingQuestions: 2,
				pendingPermissions: 1,
				unseenActivity: false,
			});
			// Never looked at, and a message has landed: something is unread.
			expect(
				(yield* readQuery.readSessionList()).rows.find(
					({ item }) => item.id === "quiet",
				)?.item,
			).toEqual({
				id: "quiet",
				title: "Quiet",
				status: "idle",
				createdAt: 1,
				updatedAt: 9,
				pendingQuestions: 0,
				pendingPermissions: 0,
				unseenActivity: true,
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("a session with no messages is not unseen", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("fresh");
			const readQuery = yield* makeReadQueryEffect;

			const entry = (yield* readQuery.readSessionList()).rows.find(
				({ item }) => item.id === "fresh",
			)?.item;
			expect(entry?.unseenActivity).toBe(false);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("serves the base read and the catch-up from one query", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("root");
			yield* seedForkedSession;
			const sql = yield* SqlClient.SqlClient;
			// What a commit leaves behind: the counter moved, and the row that
			// commit wrote carries the number it moved to.
			yield* sql`UPDATE read_model_counter SET value = 7 WHERE id = 1`;
			yield* sql`UPDATE sessions SET version = 7 WHERE id = 'child'`;
			const readQuery = yield* makeReadQueryEffect;

			const base = yield* readQuery.readSessionList();
			expect(base.version).toBe(7);
			expect(base.rows.map(({ item }) => item.id)).toEqual(["child", "root"]);
			// Each row carries the version it moved at, not the counter, so a
			// replayed row keeps the identity it was first delivered under.
			expect(base.rows.map(({ version }) => version)).toEqual([7, 0]);

			// The live window is the same query bounded at both ends: the row that
			// moved comes back identical to the base's, the one that did not is
			// absent.
			const moved = yield* readQuery.readSessionList({ after: 6 });
			expect(moved).toEqual({ rows: [base.rows[0]], version: 7 });

			// A subscriber current through the counter is caught up.
			expect((yield* readQuery.readSessionList({ after: 7 })).rows).toEqual([]);

			// `through` is the half that keeps a slow read honest: bounded below
			// the commit that moved "child", it reports nothing even though the
			// counter it returns is already past it.
			const bounded = yield* readQuery.readSessionList({
				after: 6,
				through: 6,
			});
			expect(bounded).toEqual({ rows: [], version: 7 });
		}).pipe(Effect.provide(testLayer)),
	);
	it.effect("carries the same shape into the snapshot and the re-query", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("root");
			yield* seedForkedSession;
			const readQuery = yield* makeReadQueryEffect;
			const snapshot = yield* readQuery.readSessionList();
			const queried = yield* readQuery.readSessionList({ after: -1 });
			expect(queried.rows).toEqual(snapshot.rows);
			expect(
				queried.rows.find(({ item }) => item.id === "gone"),
			).toBeUndefined();
		}).pipe(Effect.provide(testLayer)),
	);
});
