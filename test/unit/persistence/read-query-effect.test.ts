import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { restoreClaudeQuestionsFromStore } from "../../../src/lib/domain/relay/Services/restore-claude-questions.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import {
	deriveSessionSnooze,
	makeReadQueryEffect,
	ReadQueryEffectTag,
	sessionRowsToSessionInfoList,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import { sessionFamilyQuery } from "../../../src/lib/persistence/session-family-query.js";

const testLayer = EffectSqliteClient.layer({ filename: ":memory:" });

describe("typed session row derivations", () => {
	it.effect("keeps a manual unread mark without messages", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("manual");
			const sql = yield* SqlClient.SqlClient;
			const [row] =
				yield* sql<SessionRow>`SELECT * FROM sessions WHERE id = 'manual'`;
			if (!row) throw new Error("expected session");
			expect(
				sessionRowsToSessionInfoList([{ ...row, marked_unread_at: 1 }])[0],
			).toMatchObject({
				unread: true,
				attention: "done-unread",
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"rolls live background work into root attention without changing status",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("root");
				yield* seedSession("child", { parentId: "root" });
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<SessionRow>`SELECT * FROM sessions ORDER BY id`;
				const converted = sessionRowsToSessionInfoList(rows, {
					parentMap: new Map([["child", "root"]]),
					hasLiveBackgroundWork: (id) => id === "child",
				});
				for (const item of converted) {
					expect(item).toMatchObject({
						status: "idle",
						processing: true,
						attention: "working",
					});
				}
				const priority = sessionRowsToSessionInfoList(rows, {
					hasLiveBackgroundWork: () => true,
					pendingPermissionCounts: new Map([["child", 1]]),
				});
				expect(priority.find((item) => item.id === "child")).toMatchObject({
					attention: "needs-approval",
					processing: true,
				});
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"derives approval, reply, error, working, unread and idle in priority order",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("priority");
				const sql = yield* SqlClient.SqlClient;
				const rows =
					yield* sql<SessionRow>`SELECT * FROM sessions WHERE id = 'priority'`;
				const row = rows[0];
				if (!row) throw new Error("expected session");
				const unread = { ...row, last_message_at: 20, read_at: 10 };
				const attention = (
					value: SessionRow,
					options: Parameters<typeof sessionRowsToSessionInfoList>[1] = {},
				) => sessionRowsToSessionInfoList([value], options)[0]?.attention;
				expect(attention(unread)).toBe("done-unread");
				expect(attention({ ...unread, read_at: 20 })).toBe("idle");
				expect(attention({ ...unread, status: "busy" })).toBe("working");
				expect(
					attention(
						{ ...unread, status: "idle" },
						{ statuses: { priority: { type: "busy" } } },
					),
				).toBe("working");
				expect(
					attention(
						{ ...unread, status: "busy" },
						{ statuses: { priority: { type: "idle" } } },
					),
				).toBe("done-unread");
				expect(
					attention({ ...unread, status: "busy", last_turn_error_at: 5 }),
				).toBe("error");
				expect(
					attention(
						{ ...unread, status: "busy", last_turn_error_at: 5 },
						{ pendingQuestionCounts: new Map([["priority", 1]]) },
					),
				).toBe("needs-reply");
				expect(
					attention(
						{ ...unread, status: "busy", last_turn_error_at: 5 },
						{
							pendingQuestionCounts: new Map([["priority", 1]]),
							pendingPermissionCounts: new Map([["priority", 1]]),
						},
					),
				).toBe("needs-approval");
				const counts = sessionRowsToSessionInfoList([row], {
					pendingQuestionCounts: new Map([["priority", 2]]),
					pendingPermissionCounts: new Map([["priority", 3]]),
				})[0];
				expect(counts).toMatchObject({
					pendingQuestionCount: 2,
					pendingPermissionCount: 3,
				});
				expect(sessionRowsToSessionInfoList([row])[0]).not.toHaveProperty(
					"pendingQuestionCount",
				);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"rolls nested descendant activity and counts into the root before choosing attention",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("root");
				yield* seedSession("child", { parentId: "root" });
				yield* seedSession("grandchild", { parentId: "child" });
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<SessionRow>`SELECT * FROM sessions ORDER BY id`;
				const options = {
					parentMap: new Map([
						["child", "root"],
						["grandchild", "child"],
					]),
					statuses: { grandchild: { type: "busy" } },
					pendingQuestionCounts: new Map([["child", 1]]),
					pendingPermissionCounts: new Map([["grandchild", 2]]),
				};
				const converted = sessionRowsToSessionInfoList(rows, options);
				expect(converted.find((row) => row.id === "root")).toMatchObject({
					processing: true,
					pendingQuestionCount: 1,
					pendingPermissionCount: 2,
					attention: "needs-approval",
				});
				expect(
					converted.find((row) => row.id === "child")?.pendingQuestionCount,
				).toBe(1);
				expect(
					converted.find((row) => row.id === "grandchild")
						?.pendingPermissionCount,
				).toBe(2);
				expect(
					converted.find((row) => row.id === "child")?.processing,
				).toBeUndefined();
				expect(
					converted.find((row) => row.id === "child")?.pendingPermissionCount,
				).toBeUndefined();
				const root = rows.find((row) => row.id === "root");
				if (!root) throw new Error("expected root row");
				expect(sessionRowsToSessionInfoList([root], options)[0]).toEqual(
					converted.find((row) => row.id === "root"),
				);
				const familyOptions = {
					statuses: options.statuses,
					pendingQuestionCounts: options.pendingQuestionCounts,
					pendingPermissionCounts: options.pendingPermissionCounts,
				};
				expect(
					sessionRowsToSessionInfoList(rows, familyOptions).find(
						(row) => row.id === "root",
					)?.pendingPermissionCount,
				).toBeUndefined();
				const errorRoot = {
					...root,
					last_turn_error_at: 1,
					last_message_at: 2,
				};
				expect(
					sessionRowsToSessionInfoList([errorRoot], {
						...options,
						pendingPermissionCounts: new Map(),
					})[0]?.attention,
				).toBe("needs-reply");
				expect(
					sessionRowsToSessionInfoList([errorRoot], {
						...options,
						pendingPermissionCounts: new Map(),
						pendingQuestionCounts: new Map(),
					})[0]?.attention,
				).toBe("error");
			}).pipe(Effect.provide(testLayer)),
	);

	it("keeps a timed or indefinite snooze until its wake, then clears it after read", () => {
		const row = {
			snoozed_at: 10,
			snoozed_until: 30,
			woken_at: null,
			woken_reason: null,
			read_at: null,
		};
		expect(deriveSessionSnooze(row, 29)).toEqual({
			snoozedAt: 10,
			snoozedUntil: 30,
		});
		expect(deriveSessionSnooze(row, 30)).toEqual({
			wokenAt: 30,
			wokeBecause: "time",
		});
		expect(deriveSessionSnooze({ ...row, read_at: 30 }, 30)).toEqual({});
		expect(deriveSessionSnooze({ ...row, snoozed_until: null }, 100)).toEqual({
			snoozedAt: 10,
		});
		expect(
			deriveSessionSnooze(
				{ ...row, woken_at: 25, woken_reason: "approval" },
				29,
			),
		).toEqual({ wokenAt: 25, wokeBecause: "approval" });
		expect(deriveSessionSnooze({ ...row, snoozed_at: null }, 30)).toEqual({});
	});

	it.effect("carries settled and pinned timestamps and omits NULL values", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("settled");
			yield* seedSession("plain");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE sessions SET settled_at = 10, pinned_at = 20 WHERE id = 'settled'`;
			const rows = yield* sql<SessionRow>`SELECT * FROM sessions ORDER BY id`;
			const converted = sessionRowsToSessionInfoList(rows);
			expect(converted.find((row) => row.id === "settled")).toMatchObject({
				settledAt: 10,
				pinnedAt: 20,
			});
			expect(converted.find((row) => row.id === "plain")).not.toHaveProperty(
				"settledAt",
			);
			expect(converted.find((row) => row.id === "plain")).not.toHaveProperty(
				"pinnedAt",
			);
		}).pipe(Effect.provide(testLayer)),
	);
});

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

function seedSession(
	sessionId: string,
	options: {
		title?: string;
		status?: string;
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
				${options.status ?? "idle"},
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

describe("ReadQueryEffect session lookups", () => {
	it.effect(
		"restores only running Claude question tools with stored inputs",
		() => {
			const services = PendingInteractionServiceLive;
			return Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("claude-session");
				yield* seedSession("opencode-session");
				yield* seedSession("abandoned-session");
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE sessions SET provider = 'opencode' WHERE id = 'opencode-session'`;
				for (const [sessionId, status] of [
					["claude-session", "running"],
					["claude-session", "completed"],
					["opencode-session", "running"],
					["abandoned-session", "running"],
				] as const) {
					const messageId = `${sessionId}-${status}`;
					yield* sql`INSERT INTO messages (id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${messageId}, ${sessionId}, 'assistant', '', 0, 1, 1)`;
					yield* sql`INSERT INTO message_parts
					(id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at)
					VALUES (${`part-${messageId}`}, ${messageId}, 'tool', 'AskUserQuestion', ${`toolu-${messageId}`},
						${JSON.stringify({ questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "red" }], multiSelect: false }] })},
						${status}, 0, 1, 1)`;
				}
				// The user moved on after this question, so it must not come back.
				yield* sql`INSERT INTO messages (id, session_id, role, text, is_streaming, created_at, updated_at)
				VALUES ('abandoned-later', 'abandoned-session', 'user', 'never mind', 0, 2, 2)`;
				const readQuery = yield* makeReadQueryEffect;
				if (!readQuery.getPendingClaudeQuestionTool)
					return yield* Effect.fail(new Error("Missing question lookup"));
				expect(
					yield* readQuery.getPendingClaudeQuestionTool(
						"claude-session",
						"toolu-claude-session-running",
					),
				).toMatchObject({
					id: "part-claude-session-running",
					message_id: "claude-session-running",
				});
				yield* restoreClaudeQuestionsFromStore.pipe(
					Effect.provideService(ReadQueryEffectTag, readQuery),
				);
				const pending = yield* PendingInteractionServiceTag;
				expect(yield* pending.listPendingQuestions()).toMatchObject([
					{
						requestId: "toolu-claude-session-running",
						toolCallId: "toolu-claude-session-running",
						recovered: true,
						questions: [
							{
								question: "Which colour?",
								header: "Colour",
								options: [{ label: "red" }],
								multiSelect: false,
							},
						],
					},
				]);
			}).pipe(Effect.provide(Layer.mergeAll(testLayer, services)));
		},
	);
	it.effect("reads tool content by tool id", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO tool_content (tool_id, session_id, content, created_at)
				VALUES ('tool-abc', 's1', '{"result": "hello"}', 1)`;
			const readQuery = yield* makeReadQueryEffect;

			expect(yield* readQuery.getToolContent("tool-abc")).toBe(
				'{"result": "hello"}',
			);
			expect(yield* readQuery.getToolContent("nonexistent")).toBeUndefined();
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("reads one session's status and the status of every session", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("s1", { status: "idle" });
			yield* seedSession("s2", { status: "busy" });
			const readQuery = yield* makeReadQueryEffect;

			expect(yield* readQuery.getSessionStatus("s2")).toBe("busy");
			expect(yield* readQuery.getSessionStatus("nonexistent")).toBeUndefined();
			expect(yield* readQuery.getAllSessionStatuses()).toEqual({
				s1: "idle",
				s2: "busy",
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("lists nothing for an empty store", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const readQuery = yield* makeReadQueryEffect;
			expect(yield* readQuery.listSessions()).toEqual([]);
		}).pipe(Effect.provide(testLayer)),
	);
});

describe("ReadQueryEffect session families", () => {
	it.effect(
		"finds the root from a grandchild and returns every descendant only once",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("root", { updatedAt: 5 });
				yield* seedSession("child", { parentId: "root", updatedAt: 4 });
				yield* seedSession("grandchild", { parentId: "child", updatedAt: 3 });
				yield* seedSession("sibling", { parentId: "root", updatedAt: 2 });
				yield* seedSession("unrelated");
				const readQuery = yield* makeReadQueryEffect;
				const expected = ["root", "child", "grandchild", "sibling"];
				expect(
					(yield* readQuery.getSessionFamily("grandchild")).map(
						(row) => row.id,
					),
				).toEqual(expected);
				expect(
					(yield* readQuery.getSessionFamily("root")).map((row) => row.id),
				).toEqual(expected);
				expect(yield* readQuery.getSessionFamily("missing")).toEqual([]);
				const lineage = yield* readQuery.getSessionLineage();
				expect(lineage.count).toBe(5);
				expect(lineage.rows).toHaveLength(5);
				expect(lineage.rows).toEqual(
					expect.arrayContaining([
						{ id: "root", parent_id: null },
						{ id: "grandchild", parent_id: "child" },
					]),
				);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"looks up family rows through indexes without scanning sessions",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("root");
				yield* seedSession("child", { parentId: "root" });
				yield* seedSession("grandchild", { parentId: "child" });
				for (let i = 0; i < 100; i++) yield* seedSession(`unrelated-${i}`);
				const sql = yield* SqlClient.SqlClient;
				const plan = (yield* sql.unsafe<{ detail: string }>(
					`EXPLAIN QUERY PLAN ${sessionFamilyQuery}`,
					["grandchild"],
				)).map((row) => row.detail);

				expect(plan.some((step) => /\bSCAN (?:s|sessions)\b/i.test(step))).toBe(
					false,
				);
				expect(plan).toContain(
					"SEARCH s USING INDEX idx_sessions_parent (parent_id=?)",
				);
				expect(plan).toContain(
					"SEARCH s USING INDEX sqlite_autoindex_sessions_1 (id=?)",
				);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("returns an empty lineage snapshot for an empty store", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const readQuery = yield* makeReadQueryEffect;
			expect(yield* readQuery.getSessionLineage()).toEqual({
				rows: [],
				count: 0,
			});
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

	// Guards the index, not the query: the SQL below is a copy, so this fails
	// only if idx_pending_approvals_pending is dropped from the migrations.
	// Without it this GROUP BY scans every resolved approval ever recorded.
	it.effect("uses the pending-approval index", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			const plan = yield* sql<{ detail: string }>`
				EXPLAIN QUERY PLAN
				SELECT session_id, type, COUNT(*) AS pending_count
				FROM pending_approvals
				WHERE status = 'pending'
				GROUP BY session_id, type`;

			expect(
				plan.some((row) =>
					row.detail.includes("idx_pending_approvals_pending"),
				),
			).toBe(true);
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

	it.effect(
		"orders messages by created_at, then id, and is empty for an unknown session",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				yield* seedSession("s1");
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
				INSERT INTO messages
				(id, session_id, role, text, created_at, updated_at)
				VALUES
				('m-later', 's1', 'assistant', 'hi there', 2000, 2000),
				('m-b', 's1', 'user', 'hello', 1000, 1000),
				('m-a', 's1', 'user', 'hello', 1000, 1000)`;
				const readQuery = yield* makeReadQueryEffect;

				expect(
					(yield* readQuery.getSessionMessagesWithParts("s1")).map(
						(row) => row.id,
					),
				).toEqual(["m-a", "m-b", "m-later"]);
				expect(
					yield* readQuery.getSessionMessagesWithParts("nonexistent"),
				).toEqual([]);
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
					messageCount: 0,
					processing: true,
					attention: "working",
				},
				{
					id: "root",
					title: "Test",
					status: "idle",
					createdAt: 1,
					updatedAt: 1,
					messageCount: 0,
					processing: true,
					attention: "working",
				},
			]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"derives approval counts and unread attention onto the session row",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				// `noisy` has been looked at since its last message; `quiet` never has.
				yield* sql`
				INSERT INTO sessions
				(id, provider, title, status, created_at, updated_at,
				 last_message_at, read_at)
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
					messageCount: 0,
					pendingQuestionCount: 2,
					pendingPermissionCount: 1,
					attention: "needs-approval",
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
					messageCount: 0,
					unread: true,
					attention: "done-unread",
				});
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("a session with no messages has no unread attention", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			yield* seedSession("fresh");
			const readQuery = yield* makeReadQueryEffect;

			const entry = (yield* readQuery.readSessionList()).rows.find(
				({ item }) => item.id === "fresh",
			)?.item;
			expect(entry?.unread).toBeUndefined();
			expect(entry?.attention).toBe("idle");
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
