import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Result as Either, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	effectMigrationEntries,
	makeEffectMigrationLoader,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import {
	PROJECT_TREE_DATA_MIGRATION,
	readMigrationSql,
} from "../../../src/lib/persistence/schema.js";
import { seedLegacyEventStore } from "../../helpers/legacy-event-store.js";

function makeFileSqlLayer(seed?: (filename: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-effect-migrations-"));
	const filename = join(dir, "events.db");
	seed?.(filename);
	return EffectSqliteClient.layer({ filename }).pipe(
		Layer.merge(
			Layer.effectDiscard(
				Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			),
		),
	);
}

const migrationEntries = Object.entries(effectMigrationEntries);
const prefix = (count: number) =>
	Object.fromEntries(migrationEntries.slice(0, count));

// Ownership comes from the exact command input, including native message ids
// and continuation cut-offs. Neither claim status nor migration proves intake.
it.effect(
	"0078 links in-flight turns to their exact command reservations without changing acceptance",
	() =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(77));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
				VALUES ('legacy', 'claude', 1, 1), ('other', 'opencode', 1, 1)`;
			const owned = [
				{
					id: "pending",
					command: "pending",
					state: "pending",
					started: null,
					status: "pending",
					payload: { inputId: "pending" },
				},
				{
					id: "running",
					command: "running",
					state: "running",
					started: 7,
					status: "running",
					payload: { inputId: "running" },
				},
				{
					id: "retry",
					command: "retry",
					state: "pending",
					started: null,
					status: "retryable_failed",
					payload: { inputId: "retry" },
				},
				{
					id: "native-turn",
					command: "browser-input",
					state: "running",
					started: 8,
					status: "running",
					payload: { inputId: "browser-input" },
				},
				{
					id: "cut-off",
					command: "continuation",
					state: "running",
					started: 9,
					status: "running",
					payload: {
						inputId: "continuation",
						continuation: { cutOffMessageId: "cut-off" },
					},
				},
				{
					id: "legacy-user",
					command: "old-command",
					state: "pending",
					started: null,
					status: "running",
					payload: { userMessageId: "legacy-user" },
				},
			] as const;
			for (const [index, row] of owned.entries()) {
				const userId = row.id === "native-turn" ? "native-user" : row.id;
				const inputId =
					row.id === "cut-off"
						? "original-input"
						: row.id === "legacy-user"
							? null
							: row.command;
				yield* sql`INSERT INTO turns (id, session_id, user_message_id, state, requested_at, started_at)
					VALUES (${row.id}, 'legacy', ${userId}, ${row.state}, 1, ${row.started})`;
				yield* sql`INSERT INTO messages (id, session_id, role, input_id, created_at, updated_at)
					VALUES (${userId}, 'legacy', 'user', ${inputId}, 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
					provider_id, effect_type, payload_json, status, requested_at, updated_at)
					VALUES (${index + 1}, ${row.command}, 'project', 'legacy', 'claude', 'send_turn',
					${JSON.stringify(row.payload)}, ${row.status}, 10, 10)`;
			}
			yield* sql`INSERT INTO turns (id, session_id, user_message_id, state, requested_at, started_at, completed_at) VALUES
				('orphan-pending', 'legacy', 'orphan-pending', 'pending', 1, NULL, NULL),
				('orphan-running', 'legacy', 'orphan-running', 'running', 1, 3, NULL),
				('foreign', 'other', 'running', 'running', 1, 4, NULL),
				('finished', 'legacy', 'pending', 'completed', 1, 2, 3)`;
			yield* makeEffectSqlMigrator();
			for (const [index, row] of owned.entries())
				expect(
					yield* sql`SELECT state, started_at, completed_at, run_id FROM turns WHERE id = ${row.id}`,
				).toEqual([
					{
						state: row.state,
						started_at: row.started,
						completed_at: null,
						run_id: `legacy-run:project:${index + 1}`,
					},
				]);
			expect(
				yield* sql`SELECT id, state, started_at, completed_at, run_id FROM turns
				WHERE id IN ('orphan-pending', 'orphan-running', 'foreign', 'finished') ORDER BY id`,
			).toEqual([
				{
					id: "finished",
					state: "completed",
					started_at: 2,
					completed_at: 3,
					run_id: null,
				},
				{
					id: "foreign",
					state: "interrupted",
					started_at: 4,
					completed_at: 1,
					run_id: null,
				},
				{
					id: "orphan-pending",
					state: "interrupted",
					started_at: null,
					completed_at: 1,
					run_id: null,
				},
				{
					id: "orphan-running",
					state: "interrupted",
					started_at: 3,
					completed_at: 1,
					run_id: null,
				},
			]);
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
);

it.effect(
	"keeps executing legacy reservations running without guessing open turn owners",
	() =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(77));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('legacy', 'claude', 1, 1)`;
			yield* sql`INSERT INTO turns (id, session_id, state, requested_at) VALUES
			('old-open', 'legacy', 'running', 1), ('old-done', 'legacy', 'completed', 1)`;
			yield* sql`INSERT INTO provider_command_outbox (
			request_sequence, command_id, project_key, session_id, provider_id,
			effect_type, payload_json, status, requested_at, updated_at
		) VALUES (1, 'legacy-send', 'project', 'legacy', 'claude', 'send_turn',
			'{"inputId":"next-input"}', 'running', 10, 10),
			(2, 'pending-send', 'project', 'legacy', 'claude', 'send_turn',
			'{"inputId":"pending-input","runId":"carried-run"}', 'pending', 20, 20)`;
			yield* makeEffectSqlMigrator();
			const [outbox] = yield* sql<{
				payload_json: string;
				run_id: string;
			}>`SELECT payload_json, run_id FROM provider_command_outbox WHERE request_sequence = 1`;
			const payload: unknown = JSON.parse(outbox?.payload_json ?? "null");
			expect(payload).toEqual({
				inputId: "next-input",
			});
			expect(outbox?.run_id).toEqual(expect.any(String));
			expect(
				yield* sql`SELECT run_id FROM provider_command_outbox WHERE request_sequence = 2`,
			).toEqual([{ run_id: "carried-run" }]);
			expect(
				yield* sql`SELECT status, requested_at, started_at, completed_at FROM provider_runs ORDER BY requested_at`,
			).toEqual([
				{
					status: "running",
					requested_at: 10,
					started_at: 10,
					completed_at: null,
				},
				{
					status: "pending",
					requested_at: 20,
					started_at: null,
					completed_at: null,
				},
			]);
			expect(
				yield* sql`SELECT status FROM provider_command_outbox WHERE request_sequence = 1`,
			).toEqual([{ status: "running" }]);
			expect(yield* sql`SELECT type FROM events ORDER BY sequence`).toEqual([
				{ type: "run.requested" },
				{ type: "run.requested" },
			]);
			expect(
				yield* sql`SELECT id, state, run_id FROM turns ORDER BY id`,
			).toEqual([
				{ id: "old-done", state: "completed", run_id: null },
				{ id: "old-open", state: "interrupted", run_id: null },
			]);
			yield* makeEffectSqlMigrator();
			expect(
				yield* sql`SELECT payload_json, run_id FROM provider_command_outbox WHERE request_sequence = 1`,
			).toEqual([outbox]);
			expect(yield* sql`SELECT COUNT(*) AS n FROM provider_runs`).toEqual([
				{ n: 2 },
			]);
			yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('new-run', 'legacy', 'running', 30)`;
			yield* sql`INSERT INTO provider_command_outbox (
				request_sequence, command_id, project_key, session_id, provider_id,
				effect_type, payload_json, status, requested_at, updated_at
			) VALUES (3, 'owned-send', 'project', 'legacy', 'claude', 'send_turn',
				'{"inputId":"owned-input","runId":"new-run"}', 'running', 30, 30)`;
			yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 78`;
			yield* makeEffectSqlMigrator();
			expect(
				yield* sql`SELECT status FROM provider_runs WHERE id = 'new-run'`,
			).toEqual([{ status: "running" }]);
			expect(yield* sql`SELECT COUNT(*) AS n FROM events`).toEqual([{ n: 2 }]);
			yield* sql`DELETE FROM sessions WHERE id = 'legacy'`;
			expect(yield* sql`SELECT id FROM provider_runs`).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
);

// Purge failure modes: either reference source is missed, duplicate references
// multiply the cohort, content/descendants or non-Claude/root sessions are lost,
// dependent rows survive, retained rows change, or reopening repeats the purge.
it.effect(
	"purges only empty Claude background shell leaves and their dependent rows",
	() =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(66));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, parent_id, created_at, updated_at) VALUES
			('parent-card', 'claude', NULL, 1, 1), ('parent-event', 'claude', NULL, 1, 1),
			('phantom-card', 'claude', 'parent-card', 1, 1), ('phantom-event', 'claude', 'parent-event', 1, 1),
			('agent', 'claude', 'parent-card', 1, 1), ('with-message', 'claude', 'parent-card', 1, 1),
			('with-child', 'claude', 'parent-card', 1, 1), ('grandchild', 'claude', 'with-child', 1, 1),
			('other-provider', 'opencode', 'parent-card', 1, 1)`;
			yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at) VALUES
			('parent-message', 'parent-card', 'assistant', 'Bash tools', 1, 1),
			('event-parent-message', 'parent-event', 'user', 'Run a shell', 1, 1),
			('child-message', 'with-message', 'assistant', 'Keep this content', 1, 1)`;
			yield* sql`INSERT INTO message_parts (id, message_id, type, sort_order, metadata, created_at, updated_at)
			SELECT id, 'parent-message', 'tool', row_number() OVER (),
				json_object('childSessionId', id, 'subagentType', CASE WHEN id = 'agent' THEN 'general-purpose' ELSE 'local_bash' END), 1, 1
			FROM sessions WHERE id NOT IN ('phantom-event', 'grandchild')`;
			yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
			SELECT id, id, 1, 'session.created', '{}', provider, 1 FROM sessions`;
			yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES
			('running', 'parent-event', 2, 'tool.running', '{"metadata":{"childSessionId":"phantom-event","subagentType":"local_bash"}}', 'claude', 2)`;
			// Populate every deletion target for both purged and retained sessions.
			yield* sql`INSERT INTO turns (id, session_id, requested_at) SELECT id, id, 1 FROM sessions`;
			yield* sql`INSERT INTO pending_approvals (id, session_id, turn_id, type, created_at) SELECT id, id, id, 'permission', 1 FROM sessions`;
			yield* sql`INSERT INTO session_providers (id, session_id, provider, activated_at) SELECT id, id, provider, 1 FROM sessions`;
			yield* sql`INSERT INTO tool_content (tool_id, session_id, content, created_at) SELECT id, id, 'output', 1 FROM sessions`;
			yield* sql`INSERT INTO provider_state (session_id, key, value) SELECT id, 'key', 'value' FROM sessions`;
			yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at) SELECT id, id, 'accepted', 1 FROM sessions`;
			yield* sql`INSERT INTO provider_command_sessions (project_key, session_id, provider_id, provider_kind, status, created_at, updated_at)
			SELECT 'project', id, provider, provider, 'idle', 1, 1 FROM sessions`;
			yield* sql`INSERT INTO provider_command_turns (project_key, session_id, turn_id, command_id, status, created_at, updated_at)
			SELECT 'project', id, id, id, 'completed', 1, 1 FROM sessions`;
			yield* sql`INSERT INTO provider_command_interactions (project_key, session_id, interaction_id, kind, status, created_at, updated_at)
			SELECT 'project', id, id, 'permission', 'resolved', 1, 1 FROM sessions`;
			yield* sql`INSERT INTO provider_command_tombstones (project_key, scope_kind, scope_id, session_id, event_sequence, reason_code, tombstoned_at)
			SELECT 'project', 'session', id, id, 1, 'deleted', 1 FROM sessions`;
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, requested_at, updated_at)
			SELECT row_number() OVER (), id, 'project', id, provider, 'send_turn', '{}', 1, 1 FROM sessions`;
			yield* sql`INSERT INTO session_sidebar (session_id, version, last_activity, row) SELECT id, 1, 1, '{}' FROM sessions`;
			yield* sql`INSERT INTO message_tombstones (session_id, message_id, version) SELECT id, id, 1 FROM sessions`;
			yield* sql`INSERT INTO message_part_tombstones (session_id, message_id, part_id, version) SELECT id, id, id, 1 FROM sessions`;
			yield* sql`INSERT INTO pending_inputs (input_id, session_id, text, request, state, admitted_at, version)
			SELECT id, id, 'queued', '{}', 'queued', 1, 1 FROM sessions`;
			yield* sql`INSERT INTO session_goal_checks (event_id, session_id, condition, set_at, iterations, created_at)
			SELECT id, id, 'done', 1, 0, 1 FROM sessions`;
			const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'effect_sql_migrations' ORDER BY name`;
			const retained = new Map<string, readonly unknown[]>();
			for (const { name } of tables) {
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(${sql(name)})`;
				const key =
					name === "sessions"
						? "id"
						: columns.some(({ name }) => name === "session_id")
							? "session_id"
							: undefined;
				const rows = yield* sql`SELECT * FROM ${sql(name)} ORDER BY rowid`;
				retained.set(
					name,
					rows.filter(
						(row) =>
							!key ||
							!["phantom-card", "phantom-event"].includes(String(row[key])),
					),
				);
			}
			expect(yield* makeEffectSqlMigrator(prefix(67))).toEqual([
				[67, "purge_background_shell_sessions"],
			]);
			for (const { name } of tables) {
				expect(
					yield* sql`SELECT * FROM ${sql(name)} ORDER BY rowid`,
					name,
				).toEqual(retained.get(name));
			}
			expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
			expect(
				yield* sql`SELECT name FROM sqlite_temp_master WHERE type = 'table'`,
			).toEqual([]);
			expect(yield* makeEffectSqlMigrator(prefix(67))).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
);

it.effect(
	"extracts synthetic message ids without a correlated event scan",
	() =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(65));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s', 'opencode', 1, 1)`;
			yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 2000)
			INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
			SELECT 'm-' || value, 's', 'user', 'prompt', value, value FROM n`;
			yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at)
			SELECT id, session_id, created_at, 'message.created', json_object('messageId', id),
				CASE WHEN created_at % 4 = 0 THEN '{"synthetic":true}' ELSE '{}' END, 'opencode', created_at FROM messages`;
			const [query] = readMigrationSql(PROJECT_TREE_DATA_MIGRATION)
				.split(";")
				.filter((statement) => statement.includes("FROM events"));
			expect(query).toBeDefined();
			const plan = yield* sql.unsafe<{ detail: string }>(
				`EXPLAIN QUERY PLAN ${query}`,
			);
			const samples: number[] = [];
			for (let i = 0; i < 3; i++) {
				yield* sql`UPDATE messages SET rest_payload = NULL`;
				const started = performance.now();
				yield* sql.unsafe(query ?? "");
				samples.push(performance.now() - started);
				expect(
					yield* sql`SELECT COUNT(*) AS count FROM messages WHERE json_extract(rest_payload, '$.isSynthetic') = 1`,
				).toEqual([{ count: 500 }]);
			}
			console.info(
				`synthetic provenance: 2000 messages, 500 marked; median ${samples.sort((a, b) => a - b)[1]?.toFixed(2)} ms`,
			);
			expect(
				plan
					.map(({ detail }) => detail)
					.filter((detail) => detail.includes("CORRELATED")),
			).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	{ timeout: 30000 },
);

it.effect(
	"backfills more changed sessions than SQLite's parameter limit",
	() =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(65));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at, root_id)
			VALUES ('root', 'opencode', 1, 1, 'root')`;
			yield* sql`WITH RECURSIVE n(value) AS (
			SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 32766
		) INSERT INTO sessions (id, provider, parent_id, root_id, created_at, updated_at)
			SELECT 's-' || value, 'opencode', 'root', 'root', 1, 1 FROM n`;
			yield* sql`INSERT INTO messages (id, session_id, role, input_id, created_at, updated_at)
			SELECT 'm-' || id, id, 'user', id, 100, 100 FROM sessions WHERE parent_id = 'root'`;
			expect(yield* makeEffectSqlMigrator(prefix(68))).toEqual([
				[66, "project_tree_data"],
				[67, "purge_background_shell_sessions"],
				[68, "input_drafts"],
			]);
			expect(
				yield* sql`SELECT COUNT(*) AS count, COUNT(DISTINCT version) AS versions
			FROM sessions WHERE last_user_message_at = 100 AND version > 0`,
			).toEqual([{ count: 32766, versions: 1 }]);
			expect(
				yield* sql`SELECT session_id FROM session_sidebar WHERE row IS NOT NULL`,
			).toEqual([{ session_id: "root" }]);
			expect(
				yield* sql`SELECT last_user_message_at FROM sessions WHERE id = 'root'`,
			).toEqual([{ last_user_message_at: null }]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	{ timeout: 30000 },
);

it.effect(
	"adds project tree data in one migration from main and preserves it on reopen",
	() =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(65));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s', 'opencode', 1, 1)`;
			yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at, input_id, is_inherited, rest_payload)
			VALUES ('human', 's', 'user', 'prompt', 100, 100, NULL, 0, NULL),
			('synthetic', 's', 'user', 'context', 200, 200, NULL, 0, '{"isSynthetic":true}'),
			('delivered', 's', 'user', '', 300, 300, 'input', 0, '{"isSynthetic":true}'),
			('inherited', 's', 'user', 'copied', 400, 400, 'copy', 1, NULL),
			('late-synthetic', 's', 'user', 'context', 600, 600, NULL, 0, NULL),
			('part-human', 's', 'user', 'prompt', 250, 250, NULL, 0, NULL),
			('part-synthetic', 's', 'user', 'context', 700, 700, NULL, 0, NULL),
			('part-ignored', 's', 'user', '', 800, 800, NULL, 0, NULL),
			('tool', 's', 'user', 'tool result', 900, 900, NULL, 0, NULL),
			('ignored', 's', 'user', 'context', 500, 500, NULL, 0,
			'{"parts":[{"type":"text","text":"context","ignored":true}]}')`;
			yield* sql`INSERT INTO message_parts (id, message_id, type, text, metadata, rest_payload, sort_order, created_at, updated_at)
			VALUES ('ordinary', 'part-human', 'text', 'prompt', NULL, NULL, 0, 250, 250),
			('synthetic-part', 'part-synthetic', 'text', 'context', '{"synthetic":true}', NULL, 0, 700, 700),
			('ignored-part', 'part-ignored', 'file', '', NULL, '{"ignored":true}', 0, 800, 800),
			('tool-part', 'tool', 'tool', '', NULL, NULL, 0, 900, 900)`;
			yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at)
			VALUES ('late-header', 's', 1, 'message.created', '{"messageId":"late-synthetic"}', '{"synthetic":true}', 'opencode', 601)`;
			expect(yield* makeEffectSqlMigrator(prefix(68))).toEqual([
				[66, "project_tree_data"],
				[67, "purge_background_shell_sessions"],
				[68, "input_drafts"],
			]);
			expect(
				yield* sql`SELECT id, is_human_sent FROM messages ORDER BY id`,
			).toEqual([
				{ id: "delivered", is_human_sent: 1 },
				{ id: "human", is_human_sent: 1 },
				{ id: "ignored", is_human_sent: 0 },
				{ id: "inherited", is_human_sent: 0 },
				{ id: "late-synthetic", is_human_sent: 0 },
				{ id: "part-human", is_human_sent: 1 },
				{ id: "part-ignored", is_human_sent: 0 },
				{ id: "part-synthetic", is_human_sent: 0 },
				{ id: "synthetic", is_human_sent: 0 },
				{ id: "tool", is_human_sent: 0 },
			]);
			expect(
				yield* sql`SELECT last_user_message_at FROM sessions WHERE id = 's'`,
			).toEqual([{ last_user_message_at: 300 }]);
			const columns = yield* sql<{ name: string }>`PRAGMA table_info(messages)`;
			expect(columns.map(({ name }) => name)).not.toContain("is_synthetic");
			expect(
				yield* sql`SELECT json_extract(rest_payload, '$.isSynthetic') AS synthetic FROM messages WHERE id = 'late-synthetic'`,
			).toEqual([{ synthetic: 1 }]);
			expect(yield* makeEffectSqlMigrator(prefix(68))).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
);

const expectedNames = [
	"create_event_store_tables",
	"add_message_part_metadata",
	"add_durable_provider_commands",
	"drop_events_session_fk",
	"message_parts_file_type",
	"message_parts_compaction_type",
	"messages_context_window",
	"turn_model_execution",
	"sessions_permission_mode",
	"purge_legacy_skeleton_sessions",
	"session_cascade_deletes",
	"sessions_read_at",
	"sessions_last_turn_error",
	"backfill_compaction_messages",
	"sessions_settled_pinned",
	"sessions_snoozed",
	"sessions_auto_settle",
	"create_projection_failures",
	"read_model_version",
	"read_model_counter",
	"sent_alerts",
	"fork_point_timestamp",
	"sessions_marked_unread",
	"session_attention",
	"read_state_to_turn_ends",
	"sessions_forked_from",
	"messages_backfilled",
	"sessions_history_complete",
	"message_tombstones",
	"session_goals",
	"startup_restore_indexes",
	"tool_call_index",
	"pending_approvals_version",
	"sessions_model_settings",
	"sessions_side_thread",
	"sessions_limit_recovery",
	"sessions_resumes",
	"session_sidebar",
	"session_sidebar_tombstones",
	"sessions_workspace",
	"messages_input_id",
	"pending_inputs",
	"messages_steered",
	"sessions_last_turn_end_input_id",
	"project_provenance",
	"messages_context_tokens",
	"messages_completed_at",
	"sessions_claude_worktree_state",
	"sessions_workspace_hint",
	"sessions_pending_rewind",
	"message_part_versions",
	"session_git_published",
	"store_identity",
	"events_unstamped_index",
	"events_session_type_index",
	"drop_activities",
	"session_pick_backfill",
	"compact_redundant_events",
	"session_project_scope",
	"daemon_store_imports",
	"sessions_lineage",
	"legacy_forks",
	"sessions_archived",
	"prompt_provider_reference",
	"tool_result_event_refs",
	"project_tree_data",
	"purge_background_shell_sessions",
	"input_drafts",
	"goal_check_metadata",
	"message_part_surfacing",
	"sessions_settled_shelf_index",
	"surfacing_marks",
	"message_part_read",
	"turn_recaps",
	"events_parent_id_index",
	"events_forked_from_index",
	"message_parts_result_event_seq_index",
	"provider_run_ownership",
];
const legacyNames = [
	"create_event_store_tables",
	"add_message_part_metadata",
	"add_durable_provider_commands",
	"drop_events_session_fk",
	"message_parts_file_type",
	"message_parts_compaction_type",
	"messages_context_window",
	"turn_model_execution",
	"sessions_permission_mode",
	"session_cascade_deletes",
	"sessions_read_at",
	"sessions_last_turn_error",
	"backfill_compaction_messages",
];

it.effect(
	"adds lineage after the legacy fork-column cleanup and preserves it on reopen",
	() =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(60));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
			VALUES ('source', 'claude', 1, 1), ('fork', 'claude', 2, 2)`;
			expect(yield* makeEffectSqlMigrator()).toEqual([
				[61, "sessions_lineage"],
				[62, "legacy_forks"],
				[63, "sessions_archived"],
				[64, "prompt_provider_reference"],
				[65, "tool_result_event_refs"],
				[66, "project_tree_data"],
				[67, "purge_background_shell_sessions"],
				[68, "input_drafts"],
				[69, "goal_check_metadata"],
				[70, "message_part_surfacing"],
				[71, "sessions_settled_shelf_index"],
				[72, "surfacing_marks"],
				[73, "message_part_read"],
				[74, "turn_recaps"],
				[75, "events_parent_id_index"],
				[76, "events_forked_from_index"],
				[77, "message_parts_result_event_seq_index"],
				[78, "provider_run_ownership"],
			]);
			yield* sql`UPDATE sessions SET forked_from = 'source' WHERE id = 'fork'`;
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
			// A repaired ledger can replay the retired cleanup after lineage exists.
			yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 26`;
			expect(yield* makeEffectSqlMigrator()).toEqual([
				[26, "sessions_forked_from"],
			]);
			expect(
				yield* sql`SELECT parent_id, forked_from FROM sessions WHERE id = 'fork'`,
			).toEqual([{ parent_id: null, forked_from: "source" }]);
			expect(yield* sql`PRAGMA index_info(idx_sessions_forked_from)`).toEqual([
				{ seqno: 0, cid: expect.any(Number), name: "forked_from" },
			]);
			yield* sql`DELETE FROM sessions WHERE id = 'source'`;
			expect(
				yield* sql`SELECT id, parent_id, forked_from FROM sessions`,
			).toEqual([{ id: "fork", parent_id: null, forked_from: null }]);
			expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
);

describe("Effect migration lineage", () => {
	// Merge failure modes: shipped main ledger rows change, renamed redesign
	// migrations collide with old ids, annotations are lost, or reopen replays DDL.
	it.effect("appends redesign migrations to a shipped main store", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(68));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE effect_sql_migrations SET created_at = '2001-01-01 00:00:00'`;
			const before =
				yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
			yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES ('main', 'claude', 'Preserved', 1, 1)`;
			yield* sql`INSERT INTO messages (id, session_id, role, text, is_human_sent, created_at, updated_at) VALUES ('main-message', 'main', 'user', 'Prompt', 1, 2, 2)`;
			expect(yield* makeEffectSqlMigrator()).toEqual([
				[69, "goal_check_metadata"],
				[70, "message_part_surfacing"],
				[71, "sessions_settled_shelf_index"],
				[72, "surfacing_marks"],
				[73, "message_part_read"],
				[74, "turn_recaps"],
				[75, "events_parent_id_index"],
				[76, "events_forked_from_index"],
				[77, "message_parts_result_event_seq_index"],
				[78, "provider_run_ownership"],
			]);
			expect(
				yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 68 ORDER BY migration_id`,
			).toEqual(before);
			expect(
				yield* sql`SELECT text, is_human_sent FROM messages WHERE id = 'main-message'`,
			).toEqual([{ text: "Prompt", is_human_sent: 1 }]);
			expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"upgrades the previously deployed redesign ledger and retains its annotations",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator({
					...prefix(63),
					"0064_goal_check_metadata":
						effectMigrationEntries["0069_goal_check_metadata"],
					"0065_message_part_surfacing":
						effectMigrationEntries["0070_message_part_surfacing"],
					"0066_sessions_settled_shelf_index":
						effectMigrationEntries["0071_sessions_settled_shelf_index"],
					"0067_surfacing_marks":
						effectMigrationEntries["0072_surfacing_marks"],
					"0068_message_part_read":
						effectMigrationEntries["0073_message_part_read"],
					"0069_turn_recaps": effectMigrationEntries["0074_turn_recaps"],
				});
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES ('redesign', 'claude', 'Preserved', 1, 1)`;
				yield* sql`INSERT INTO turns (id, session_id, requested_at) VALUES ('turn', 'redesign', 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at) VALUES ('message', 'redesign', 'assistant', 'Answer', 2, 2)`;
				yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_model) VALUES ('part', 'message', 'text', 'Answer', 0, 2, 2, 7, 'judge')`;
				yield* sql`INSERT INTO session_goal_checks (event_id, session_id, condition, set_at, iterations, created_at, turn_index, judge_model) VALUES ('check', 'redesign', 'Done', 1, 1, 2, 3, 'judge')`;
				yield* sql`INSERT INTO surfacing_marks (part_id, session_id, message_id, level, created_at) VALUES ('part', 'redesign', 'message', 'key', 3)`;
				yield* sql`INSERT INTO message_part_read_state (session_id, part_id) VALUES ('redesign', 'part')`;
				yield* sql`INSERT INTO turn_recaps (turn_id, session_id, version, scope, first_ordinal, last_ordinal, text, model, duration_ms, created_at) VALUES ('turn', 'redesign', 2, 'whole', 1, 7, 'Recap', 'judge', 10, 3)`;
				const tables = [
					"session_goal_checks",
					"surfacing_marks",
					"message_part_read_state",
					"turn_recaps",
				];
				const before = new Map<string, readonly unknown[]>();
				for (const table of tables)
					before.set(
						table,
						yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`,
					);
				expect(yield* makeEffectSqlMigrator()).toEqual(
					expectedNames.slice(63).map((name, index) => [index + 64, name]),
				);
				for (const table of tables)
					expect(
						yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`,
						table,
					).toEqual(before.get(table));
				expect(
					yield* sql`SELECT text, surfacing_ordinal, surfacing_model, result_event_seq FROM message_parts WHERE id = 'part'`,
				).toEqual([
					{
						text: "Answer",
						surfacing_ordinal: 7,
						surfacing_model: "judge",
						result_event_seq: null,
					},
				]);
				expect(
					yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
				).toEqual(
					expectedNames.map((name, index) => ({
						migration_id: index + 1,
						name,
					})),
				);
				expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	// Replay can encounter either column alone or both. Guarding only the first
	// column can skip the second or duplicate it; both migration paths must retain data.
	for (const migrationPath of ["append", "gap"]) {
		for (const existingColumns of ["turn_index", "judge_model", "both"]) {
			it.effect(
				`replays goal metadata via ${migrationPath} with ${existingColumns} present`,
				() =>
					Effect.gen(function* () {
						const entries = {
							...effectMigrationEntries,
							...(migrationPath === "gap"
								? { "0079_test_marker": Effect.void }
								: {}),
						};
						yield* makeEffectSqlMigrator(entries);
						const sql = yield* SqlClient.SqlClient;
						yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('goal', 'claude', 1, 1)`;
						yield* sql`INSERT INTO session_goal_checks (event_id, session_id, condition, set_at, iterations, reason, created_at, turn_index, judge_model)
							VALUES ('check', 'goal', 'Ship it', 1, 1, 'Still failing', 2, 3, 'judge')`;
						if (existingColumns === "turn_index")
							yield* sql`ALTER TABLE session_goal_checks DROP COLUMN judge_model`;
						if (existingColumns === "judge_model")
							yield* sql`ALTER TABLE session_goal_checks DROP COLUMN turn_index`;
						yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 69`;
						expect(yield* makeEffectSqlMigrator(entries)).toEqual([
							[69, "goal_check_metadata"],
						]);
						expect(
							yield* sql`SELECT reason, turn_index, judge_model FROM session_goal_checks`,
						).toEqual([
							{
								reason: "Still failing",
								turn_index: existingColumns === "judge_model" ? null : 3,
								judge_model: existingColumns === "turn_index" ? null : "judge",
							},
						]);
						expect(yield* makeEffectSqlMigrator(entries)).toEqual([]);
					}).pipe(Effect.provide(makeFileSqlLayer())),
			);
		}
	}

	// Failure modes: existing check history lost, invented legacy metadata,
	// migration registered only in the unused legacy path, or rerun failures.
	it.effect("upgrades existing goal checks through the live migrator", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(68));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('goal', 'claude', 1, 1)`;
			yield* sql`INSERT INTO session_goal_checks (event_id, session_id, condition, set_at, iterations, reason, created_at)
				VALUES ('check', 'goal', 'Ship it', 1, 1, 'Still failing', 2)`;
			expect(yield* makeEffectSqlMigrator()).toEqual([
				[69, "goal_check_metadata"],
				[70, "message_part_surfacing"],
				[71, "sessions_settled_shelf_index"],
				[72, "surfacing_marks"],
				[73, "message_part_read"],
				[74, "turn_recaps"],
				[75, "events_parent_id_index"],
				[76, "events_forked_from_index"],
				[77, "message_parts_result_event_seq_index"],
				[78, "provider_run_ownership"],
			]);
			expect(
				yield* sql`SELECT reason, turn_index, judge_model FROM session_goal_checks`,
			).toEqual([
				{ reason: "Still failing", turn_index: null, judge_model: null },
			]);
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	// Failure modes: upgrades omit columns, erase existing parts, or fail when
	// ledger repair replays a migration whose columns already exist.
	it.effect(
		"upgrades part surfacing columns and retains verdicts on migration repair",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* makeEffectSqlMigrator(prefix(69));
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s', 'claude', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('m', 's', 'assistant', 2, 2)`;
				yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES ('p', 'm', 'text', 'Preserved', 0, 3, 4)`;
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[70, "message_part_surfacing"],
					[71, "sessions_settled_shelf_index"],
					[72, "surfacing_marks"],
					[73, "message_part_read"],
					[74, "turn_recaps"],
					[75, "events_parent_id_index"],
					[76, "events_forked_from_index"],
					[77, "message_parts_result_event_seq_index"],
					[78, "provider_run_ownership"],
				]);
				expect(
					yield* sql`SELECT text, created_at, updated_at, surfacing_ordinal, surfacing_probabilities, surfacing_set_version, surfacing_model FROM message_parts`,
				).toEqual([
					{
						text: "Preserved",
						created_at: 3,
						updated_at: 4,
						surfacing_ordinal: null,
						surfacing_probabilities: null,
						surfacing_set_version: null,
						surfacing_model: null,
					},
				]);
				yield* sql`UPDATE message_parts SET surfacing_ordinal = 5, surfacing_set_version = 2, surfacing_model = 'jev'`;
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 70`;
				yield* makeEffectSqlMigrator();
				expect(
					yield* sql`SELECT surfacing_ordinal, surfacing_model FROM message_parts`,
				).toEqual([{ surfacing_ordinal: 5, surfacing_model: "jev" }]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);
	it.effect(
		"defers legacy repair until recovery and preserves the durable completion marker",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* makeEffectSqlMigrator(prefix(55));
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at, model_id, model_provider, variant, context_window)
				VALUES ('legacy', 'claude', 1, 1, 'model', 'claude', NULL, NULL),
				('complete', 'claude', 1, 1, 'model', 'claude', '', '')`;
				yield* makeEffectSqlMigrator();
				expect(
					yield* sql`SELECT initialized FROM session_pick_backfill_state`,
				).toEqual([{ initialized: 0 }]);
				expect(
					yield* sql`SELECT session_id FROM session_pick_backfill`,
				).toEqual([]);
				yield* sql`DELETE FROM session_pick_backfill`;
				yield* sql`UPDATE session_pick_backfill_state SET initialized = 1`;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('new', 'claude', 1, 1)`;
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
				expect(
					yield* sql`SELECT session_id FROM session_pick_backfill`,
				).toEqual([]);
				expect(
					yield* sql`SELECT initialized FROM session_pick_backfill_state`,
				).toEqual([{ initialized: 1 }]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);
	it.effect(
		"catches up unpadded keys in numeric order and repeats as a no-op",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const entries = {
					"30_seed_users": sql`INSERT INTO users (name) VALUES ('ada')`,
					"1_create_users": sql`CREATE TABLE users (name TEXT)`,
				};
				expect(yield* makeEffectSqlMigrator(entries)).toEqual([
					[1, "create_users"],
					[30, "seed_users"],
				]);
				expect(yield* makeEffectSqlMigrator(entries)).toEqual([]);
				const filled = {
					...entries,
					"10_fill_tag": sql`UPDATE users SET tag = 'caught up'`,
					"2_add_tag": sql`ALTER TABLE users ADD COLUMN tag TEXT`,
				};
				expect(yield* makeEffectSqlMigrator(filled)).toEqual([
					[2, "add_tag"],
					[10, "fill_tag"],
				]);
				expect(yield* sql`SELECT name, tag FROM users`).toEqual([
					{ name: "ada", tag: "caught up" },
				]);
				expect(yield* makeEffectSqlMigrator(filled)).toEqual([]);
			}).pipe(
				Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" })),
			),
	);

	it.effect(
		"fills main's missing messages migrations without replaying workspace migrations",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					Object.fromEntries([
						...migrationEntries.slice(0, 45),
						...migrationEntries.slice(47),
					]),
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE effect_sql_migrations SET created_at = '2001-01-01 00:00:00'
					WHERE migration_id IN (48, 49)`;
				const before = yield* sql<{
					migration_id: number;
					name: string;
					created_at: string;
				}>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
				expect(before.map(({ migration_id }) => migration_id)).toEqual([
					...Array.from({ length: 45 }, (_, index) => index + 1),
					48,
					49,
					50,
					51,
					52,
					53,
					54,
					55,
					56,
					57,
					58,
					59,
					60,
					61,
					62,
					63,
					64,
					65,
					66,
					67,
					68,
					69,
					70,
					71,
					72,
					73,
					74,
					75,
					76,
					77,
					78,
				]);
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at, workspace_hint, workspace_hint_sequence)
					VALUES ('main-database', 'claude', 'Preserved', 'idle', 1, 1, '/repo/worktree', 123)`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at)
					VALUES ('main-message', 'main-database', 'assistant', 1, 2)`;

				expect(yield* makeEffectSqlMigrator()).toEqual([
					[46, "messages_context_tokens"],
					[47, "messages_completed_at"],
				]);
				const after = yield* sql<{
					migration_id: number;
					name: string;
					created_at: string;
				}>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
				expect(
					after.filter(
						({ migration_id }) => migration_id !== 46 && migration_id !== 47,
					),
				).toEqual(before);
				expect(
					after.map(({ migration_id, name }) => ({ migration_id, name })),
				).toEqual(
					expectedNames.map((name, index) => ({
						migration_id: index + 1,
						name,
					})),
				);
				expect(
					yield* sql`SELECT context_tokens, completed_at FROM messages WHERE id = 'main-message'`,
				).toEqual([{ context_tokens: null, completed_at: null }]);
				expect(
					yield* sql`SELECT title, workspace_hint, workspace_hint_sequence FROM sessions WHERE id = 'main-database'`,
				).toEqual([
					{
						title: "Preserved",
						workspace_hint: "/repo/worktree",
						workspace_hint_sequence: 123,
					},
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect("rolls back a failed catch-up below the recorded maximum", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const entries = {
				"0001_create_users": sql`CREATE TABLE users (name TEXT)`,
				"0003_seed_users": sql`INSERT INTO users (name) VALUES ('ada')`,
			};
			yield* makeEffectSqlMigrator(entries);
			const failed = yield* Effect.exit(
				makeEffectSqlMigrator({
					...entries,
					"0002_failing_gap": Effect.gen(function* () {
						yield* sql`ALTER TABLE users ADD COLUMN email TEXT`;
						yield* sql.unsafe("CREATE TABLE broken_table (");
					}),
				}),
			);
			expect(Exit.isFailure(failed)).toBe(true);
			expect(
				yield* sql<{
					name: string;
				}>`SELECT name FROM pragma_table_info('users')`,
			).toEqual([{ name: "name" }]);
			expect(
				yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
			).toEqual([
				{ migration_id: 1, name: "create_users" },
				{ migration_id: 3, name: "seed_users" },
			]);
			expect(yield* sql`SELECT name FROM users`).toEqual([{ name: "ada" }]);
			expect(yield* makeEffectSqlMigrator(entries)).toEqual([]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect(
		"catches up a skipped workspace migration below the recorded maximum",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					Object.fromEntries(
						migrationEntries.filter(
							([key]) => key !== "0051_message_part_versions",
						),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[51, "message_part_versions"],
				]);
				expect(
					(yield* sql<{ name: string }>`PRAGMA table_info(message_parts)`).map(
						({ name }) => name,
					),
				).toContain("version");
				expect(
					yield* sql`SELECT name FROM sqlite_master WHERE name = 'message_part_tombstones'`,
				).toEqual([{ name: "message_part_tombstones" }]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"upgrades a store that recorded the workspace migrations at their old ids 46-48",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator({
					...prefix(45),
					"0046_message_part_versions":
						effectMigrationEntries["0051_message_part_versions"],
					"0047_session_git_published":
						effectMigrationEntries["0052_session_git_published"],
					"0048_store_identity": effectMigrationEntries["0053_store_identity"],
				});
				const sql = yield* SqlClient.SqlClient;
				const identity = yield* sql`SELECT value FROM store_identity`;
				yield* sql`INSERT INTO session_git_published (directory, git) VALUES ('/repo', NULL)`;

				expect(yield* makeEffectSqlMigrator()).toEqual(
					expectedNames
						.slice(45)
						.map((name, index) => [index + 46, name] as const),
				);
				expect(
					yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
				).toEqual(
					expectedNames.map((name, index) => ({
						migration_id: index + 1,
						name,
					})),
				);
				expect(yield* sql`SELECT value FROM store_identity`).toEqual(identity);
				expect(
					yield* sql`SELECT directory, git FROM session_git_published`,
				).toEqual([{ directory: "/repo", git: null }]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"accepts a pending rewind point during baseline schema validation",
		() =>
			Effect.gen(function* () {
				// An existing pending point must be recognized during adoption, and
				// rewind must not add separate visibility or version columns.
				yield* makeEffectSqlMigrator(prefix(24));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`ALTER TABLE sessions ADD COLUMN pending_rewind_message_id TEXT`;
				yield* effectMigrationEntries["0001_create_event_store_tables"];
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter(
						(column) => column.name === "pending_rewind_message_id",
					),
				).toHaveLength(1);
				yield* effectMigrationEntries["0001_create_event_store_tables"];
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it("registers the contiguous production chain from 1 through 78", () => {
		expect(migrationEntries).toHaveLength(78);
		expect(migrationEntries.map(([key]) => key)).toEqual(
			expectedNames.map(
				(name, index) => `${String(index + 1).padStart(4, "0")}_${name}`,
			),
		);
	});

	it.effect(
		"upgrades migrations 1 through 47 and preserves replay across compaction and turn replacement",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(47));
				const sql = yield* SqlClient.SqlClient;
				const before = yield* sql<{ migration_id: number; name: string }>`
					SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(before).toEqual(
					expectedNames.slice(0, 47).map((name, index) => ({
						migration_id: index + 1,
						name,
					})),
				);
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES ('already-migrated', 'claude', 'Preserved', 'idle', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at, context_tokens, completed_at)
					VALUES ('kept-message', 'already-migrated', 'assistant', 1, 2, 123456, 2)`;
				const events = [
					["thinking.start", "thinking", undefined],
					["thinking.delta", "thinking", ""],
					["thinking.delta", "thinking", "reason"],
					["thinking.end", "thinking", undefined],
					["thinking.end", "thinking", undefined],
					["text.delta", "text-opener", ""],
					["tool.started", "interleaved-tool", undefined],
					["text.delta", "text-opener", "answer"],
					["text.delta", "text-opener", ""],
					["thinking.delta", "thinking-opener", ""],
					["text.delta", "interleaved-text", "another answer"],
					["thinking.delta", "thinking-opener", "reason"],
					["thinking.delta", "thinking-opener", ""],
					["thinking.end", "thinking-opener", undefined],
					["thinking.end", "thinking-opener", undefined],
					["thinking.end", "thinking", undefined, "other-session"],
					["thinking.end", "other-part", undefined],
					["text.delta", "whitespace", " "],
					["text.delta", "missing-text", undefined],
					["thinking.delta", "thinking", "", undefined, "late-thinking"],
					["text.delta", "text-opener", "", undefined, "late-text"],
					["thinking.end", "thinking", undefined, undefined, "late-thinking"],
					["thinking.delta", "thinking", ""],
					["thinking.delta", "thinking", ""],
					["thinking.end", "thinking", undefined],
					["text.delta", "text-opener", ""],
					["thinking.delta", "thinking-opener", ""],
					["thinking.end", "thinking-opener", undefined],
				] as const;
				for (const [
					index,
					[type, partId, text, sessionId, messageId],
				] of events.entries()) {
					yield* sql`INSERT INTO events
						(sequence, project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
						VALUES (${index + 1}, 'test-project', ${`event-${index + 1}`}, ${sessionId ?? "already-migrated"},
							${index + 100}, ${type}, ${JSON.stringify({ messageId: messageId ?? "kept-message", partId, text })},
							' { "rawSource" : "claude.subagent.transcript" } ', 'claude', ${1000 - index})`;
				}
				const cascadeEvents = [
					{
						type: "message.created",
						data: { messageId: "cascade-user", role: "user" },
					},
					{
						type: "message.created",
						data: {
							messageId: "cascade-answer",
							role: "assistant",
							parentID: "cascade-user",
						},
					},
					{ type: "thinking.start" },
					{ type: "thinking.delta", data: { text: "" } },
					{ type: "thinking.delta", data: { text: "" } },
					{ type: "thinking.end" },
					{ type: "thinking.end" },
					// TurnProjector REPLACE cascades through messages to their parts.
					{
						type: "message.created",
						data: { messageId: "cascade-user", role: "user" },
					},
					{ type: "thinking.delta", data: { text: "" } },
					{ type: "thinking.end" },
					{ type: "thinking.delta", data: { text: "" } },
					{ type: "thinking.end" },
					{ type: "thinking.delta", data: { text: "" } },
					{ type: "thinking.end" },
					// An end before insertion is ineffective. A retained tool event
					// can read the later completion to decide a child's liveness.
					{ type: "thinking.end", data: { partId: "observed-thinking" } },
					{ type: "thinking.start", data: { partId: "observed-thinking" } },
					{ type: "thinking.end", data: { partId: "observed-thinking" } },
					{
						type: "tool.running",
						data: {
							partId: "observed-thinking",
							metadata: { childSessionId: "child" },
						},
					},
					{ type: "thinking.end", data: { partId: "observed-thinking" } },
					{ type: "text.delta", data: { partId: "text-noops", text: "" } },
					{ type: "text.delta", data: { partId: "text-noops", text: "" } },
					{ type: "text.delta", data: { partId: "text-noops", text: "" } },
				] as const;
				for (const [index, event] of cascadeEvents.entries()) {
					const sequence = events.length + index + 1;
					yield* sql`INSERT INTO events
						(sequence, project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
						VALUES (${sequence}, 'test-project', ${`event-${sequence}`}, 'already-migrated',
							${sequence + 100}, ${event.type}, ${JSON.stringify({
								sessionId: "already-migrated",
								messageId: "cascade-answer",
								partId: "cascade-thinking",
								...("data" in event ? event.data : {}),
							})}, '{}', 'claude', ${1000 - sequence})`;
				}
				// The snapshot authority guard can skip a native opener while a
				// later REST-sourced delta is the first effective insertion.
				for (const sequence of [51, 52, 53, 54]) {
					yield* sql`INSERT INTO events
						(sequence, project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
						VALUES (${sequence}, 'test-project', ${`event-${sequence}`}, 'already-migrated',
							${sequence + 100}, 'text.delta', '{"messageId":"snapshot-message","partId":"snapshot-part","text":""}',
							${JSON.stringify({ rawSource: sequence === 51 ? "claude.sdk" : "opencode.rest" })}, 'claude', ${sequence})`;
				}
				// A tool update can observe only its own part, so unrelated tools
				// must not prevent compaction of an otherwise redundant sequence.
				const unrelatedObserverEvents = [
					["text.delta", "scoped-text"],
					["text.delta", "scoped-text"],
					["tool.running", "unrelated-tool"],
					["text.delta", "scoped-text"],
					["thinking.end", "scoped-thinking"],
					["thinking.end", "scoped-thinking"],
					["tool.running", "unrelated-tool"],
					["thinking.end", "scoped-thinking"],
				] as const;
				for (const [
					index,
					[type, partId],
				] of unrelatedObserverEvents.entries()) {
					const sequence = 55 + index;
					yield* sql`INSERT INTO events
						(sequence, project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
						VALUES (${sequence}, 'test-project', ${`event-${sequence}`}, 'already-migrated',
							${sequence + 100}, ${type}, ${JSON.stringify({ messageId: "cascade-answer", partId, text: "" })},
							'{}', 'claude', ${sequence})`;
				}
				const eventColumns = sql.literal(
					"project_id, sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at",
				);
				const originalEvents = yield* sql<{
					sequence: number;
				}>`SELECT ${eventColumns} FROM events ORDER BY sequence`;

				expect(yield* makeEffectSqlMigrator()).toEqual([
					[48, "sessions_claude_worktree_state"],
					[49, "sessions_workspace_hint"],
					[50, "sessions_pending_rewind"],
					[51, "message_part_versions"],
					[52, "session_git_published"],
					[53, "store_identity"],
					[54, "events_unstamped_index"],
					[55, "events_session_type_index"],
					[56, "drop_activities"],
					[57, "session_pick_backfill"],
					[58, "compact_redundant_events"],
					[59, "session_project_scope"],
					[60, "daemon_store_imports"],
					[61, "sessions_lineage"],
					[62, "legacy_forks"],
					[63, "sessions_archived"],
					[64, "prompt_provider_reference"],
					[65, "tool_result_event_refs"],
					[66, "project_tree_data"],
					[67, "purge_background_shell_sessions"],
					[68, "input_drafts"],
					[69, "goal_check_metadata"],
					[70, "message_part_surfacing"],
					[71, "sessions_settled_shelf_index"],
					[72, "surfacing_marks"],
					[73, "message_part_read"],
					[74, "turn_recaps"],
					[75, "events_parent_id_index"],
					[76, "events_forked_from_index"],
					[77, "message_parts_result_event_seq_index"],
					[78, "provider_run_ownership"],
				]);
				expect(yield* sql`SELECT type FROM events WHERE sequence = 45`).toEqual(
					[{ type: "thinking.end" }],
				);
				const deletedSequences = new Set([
					2, 5, 9, 13, 15, 23, 32, 39, 40, 49, 53, 56, 60,
				]);
				expect(
					yield* sql`SELECT ${eventColumns} FROM events ORDER BY sequence`,
				).toEqual(
					originalEvents.filter(
						({ sequence }) => !deletedSequences.has(sequence),
					),
				);
				expect(
					yield* sql`SELECT type, data FROM events WHERE sequence = 37`,
				).toEqual([
					{
						type: "thinking.delta",
						data: JSON.stringify({
							sessionId: "already-migrated",
							messageId: "cascade-answer",
							partId: "cascade-thinking",
							text: "",
						}),
					},
				]);
				const after = yield* sql<{ migration_id: number; name: string }>`
					SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(after.slice(0, 47)).toEqual(before);
				expect(after).toEqual(
					expectedNames.map((name, index) => ({
						migration_id: index + 1,
						name,
					})),
				);
				expect(
					yield* sql`SELECT context_tokens, completed_at FROM messages WHERE id = 'kept-message'`,
				).toEqual([{ context_tokens: 123456, completed_at: 2 }]);
				expect(
					yield* sql`SELECT title, claude_worktree_state, workspace_hint, workspace_hint_sequence
						FROM sessions WHERE id = 'already-migrated'`,
				).toEqual([
					{
						title: "Preserved",
						claude_worktree_state: null,
						workspace_hint: null,
						workspace_hint_sequence: null,
					},
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"hint columns must remain nullable without inventing historical generations",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					prefix(
						migrationEntries.findIndex(
							([key]) => key === "0049_sessions_workspace_hint",
						),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES ('kept-hint', 'claude', 'Preserved', 'idle', 1, 1)`;
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[49, "sessions_workspace_hint"],
					[50, "sessions_pending_rewind"],
					[51, "message_part_versions"],
					[52, "session_git_published"],
					[53, "store_identity"],
					[54, "events_unstamped_index"],
					[55, "events_session_type_index"],
					[56, "drop_activities"],
					[57, "session_pick_backfill"],
					[58, "compact_redundant_events"],
					[59, "session_project_scope"],
					[60, "daemon_store_imports"],
					[61, "sessions_lineage"],
					[62, "legacy_forks"],
					[63, "sessions_archived"],
					[64, "prompt_provider_reference"],
					[65, "tool_result_event_refs"],
					[66, "project_tree_data"],
					[67, "purge_background_shell_sessions"],
					[68, "input_drafts"],
					[69, "goal_check_metadata"],
					[70, "message_part_surfacing"],
					[71, "sessions_settled_shelf_index"],
					[72, "surfacing_marks"],
					[73, "message_part_read"],
					[74, "turn_recaps"],
					[75, "events_parent_id_index"],
					[76, "events_forked_from_index"],
					[77, "message_parts_result_event_seq_index"],
					[78, "provider_run_ownership"],
				]);
				expect(
					yield* sql`SELECT title, workspace_hint, workspace_hint_sequence
						FROM sessions WHERE id = 'kept-hint'`,
				).toEqual([
					{
						title: "Preserved",
						workspace_hint: null,
						workspace_hint_sequence: null,
					},
				]);
				expect(
					yield* sql`SELECT name, type, "notnull", dflt_value
						FROM pragma_table_info('sessions')
						WHERE name IN ('workspace_hint', 'workspace_hint_sequence')`,
				).toEqual([
					{
						name: "workspace_hint",
						type: "TEXT",
						notnull: 0,
						dflt_value: null,
					},
					{
						name: "workspace_hint_sequence",
						type: "INTEGER",
						notnull: 0,
						dflt_value: null,
					},
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);
	it.effect(
		"adds nullable Claude worktree state without inventing historical facts",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					prefix(
						migrationEntries.findIndex(
							([key]) => key === "0048_sessions_claude_worktree_state",
						),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('kept-workspace', 'claude', 'Preserved', 'idle', 1, 1)`;
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[48, "sessions_claude_worktree_state"],
					[49, "sessions_workspace_hint"],
					[50, "sessions_pending_rewind"],
					[51, "message_part_versions"],
					[52, "session_git_published"],
					[53, "store_identity"],
					[54, "events_unstamped_index"],
					[55, "events_session_type_index"],
					[56, "drop_activities"],
					[57, "session_pick_backfill"],
					[58, "compact_redundant_events"],
					[59, "session_project_scope"],
					[60, "daemon_store_imports"],
					[61, "sessions_lineage"],
					[62, "legacy_forks"],
					[63, "sessions_archived"],
					[64, "prompt_provider_reference"],
					[65, "tool_result_event_refs"],
					[66, "project_tree_data"],
					[67, "purge_background_shell_sessions"],
					[68, "input_drafts"],
					[69, "goal_check_metadata"],
					[70, "message_part_surfacing"],
					[71, "sessions_settled_shelf_index"],
					[72, "surfacing_marks"],
					[73, "message_part_read"],
					[74, "turn_recaps"],
					[75, "events_parent_id_index"],
					[76, "events_forked_from_index"],
					[77, "message_parts_result_event_seq_index"],
					[78, "provider_run_ownership"],
				]);
				expect(
					yield* sql`SELECT title, workspace, claude_worktree_state FROM sessions WHERE id = 'kept-workspace'`,
				).toEqual([
					{ title: "Preserved", workspace: null, claude_worktree_state: null },
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);
	it.effect("a failed migration run applies and records nothing", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const createGood = sql`CREATE TABLE good_table (id INTEGER PRIMARY KEY)`;
			const failed = yield* Effect.exit(
				makeEffectSqlMigrator({
					"0001_good": createGood,
					"0002_bad": sql.unsafe(
						"CREATE TABLE broken_table (id INTEGER PRIMARY KEY",
					),
				}),
			);
			expect(Exit.isFailure(failed)).toBe(true);
			expect(
				yield* sql`SELECT name FROM sqlite_master WHERE name = 'good_table'`,
			).toEqual([]);
			expect(
				yield* makeEffectSqlMigrator({
					"0001_good": createGood,
					"0002_fixed": sql`CREATE TABLE fixed_table (id INTEGER PRIMARY KEY)`,
				}),
			).toEqual([
				[1, "good"],
				[2, "fixed"],
			]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect("runs migrations in key order with a gap in ids", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const completed = yield* makeEffectSqlMigrator({
				"0003_seed_users": sql`INSERT INTO users (name) VALUES ('ada')`,
				"0001_create_users": sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`,
			});
			expect(completed).toEqual([
				[1, "create_users"],
				[3, "seed_users"],
			]);
			expect(yield* sql`SELECT name FROM users`).toEqual([{ name: "ada" }]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect("refuses static migration ids without the baseline", () =>
		Effect.gen(function* () {
			const result = yield* Effect.result(
				makeEffectMigrationLoader({ "0002_skip_baseline": Effect.void }),
			);
			expect(Either.isFailure(result)).toBe(true);
			if (Either.isFailure(result))
				expect(result.failure.message).toContain("start at 1");
		}),
	);

	it.effect(
		"runs static record migrations once through Effect SQL Migrator",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const entries = {
					"0001_create_items": sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`,
				};
				expect(yield* makeEffectSqlMigrator(entries)).toEqual([
					[1, "create_items"],
				]);
				expect(yield* makeEffectSqlMigrator(entries)).toEqual([]);
				const rows = yield* sql<{ migration_id: number; name: string }>`
				SELECT migration_id, name FROM effect_sql_migrations`;
				expect(rows).toEqual([{ migration_id: 1, name: "create_items" }]);
			}).pipe(
				Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" })),
			),
	);

	it.effect("runs only the migrations added since the last run", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const first = sql`CREATE TABLE users (id INTEGER PRIMARY KEY)`;
			yield* makeEffectSqlMigrator({ "0001_create_users": first });
			expect(
				yield* makeEffectSqlMigrator({
					"0001_create_users": first,
					"0002_create_posts": sql`CREATE TABLE posts (id INTEGER PRIMARY KEY)`,
				}),
			).toEqual([[2, "create_posts"]]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect(
		"adds read_at once and backfills existing sessions as already read",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(11));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, last_message_at, created_at, updated_at)
				VALUES ('existing', 'opencode', 2000000000456, 2000000000000, 2000000000456)`;
				yield* makeEffectSqlMigrator(prefix(12));
				const rows = yield* sql<{ read_at: number; last_message_at: number }>`
				SELECT read_at, last_message_at FROM sessions WHERE id = 'existing'`;
				expect(rows).toEqual([
					{ read_at: 2_000_000_000_456, last_message_at: 2_000_000_000_456 },
				]);
				expect(yield* makeEffectSqlMigrator(prefix(12))).toEqual([]);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "read_at"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	for (const [name, count, fields] of [
		["settled and pinned", 14, ["settled_at", "pinned_at"]],
		["snooze", 15, ["snoozed_at", "snoozed_until", "woken_at", "woken_reason"]],
		["automatic settlement", 16, ["unsettled_at", "auto_settle_disabled_at"]],
		["last turn error", 12, ["last_turn_error_at"]],
	] as const) {
		it.effect(
			`adds ${name} columns without backfilling historical sessions`,
			() =>
				Effect.gen(function* () {
					yield* makeEffectSqlMigrator(prefix(count));
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
					VALUES ('existing', 'opencode', 2000000000000, 2000000000000)`;
					yield* makeEffectSqlMigrator();
					const rows = yield* sql.unsafe<Record<string, number | null>>(
						`SELECT ${fields.join(", ")} FROM sessions WHERE id = 'existing'`,
					);
					for (const field of fields) expect(rows[0]?.[field]).toBeNull();
					const columns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(sessions)`;
					for (const field of fields)
						expect(
							columns.filter((column) => column.name === field),
						).toHaveLength(1);
					expect(yield* makeEffectSqlMigrator()).toEqual([]);
				}).pipe(Effect.provide(makeFileSqlLayer())),
		);
	}

	for (const legacyId of [1, 7, 8, 9, 13]) {
		it.effect(
			`adopts legacy migration-${legacyId} schema without changing its ledger`,
			() =>
				Effect.gen(function* () {
					const applied = yield* makeEffectSqlMigrator();
					expect(applied).toHaveLength(expectedNames.length);
					const sql = yield* SqlClient.SqlClient;
					const history = yield* sql<{ name: string }>`
					SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
					expect(history.map((row) => row.name)).toEqual(expectedNames);
					const legacy = yield* sql<{
						id: number;
						name: string;
					}>`SELECT id, name FROM _migrations ORDER BY id`;
					expect(legacy).toEqual(
						legacyNames.slice(0, legacyId).map((name, index) => ({
							id: index + 1,
							name,
						})),
					);
					const messagePartColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(message_parts)`;
					expect(messagePartColumns.map((row) => row.name)).toContain(
						"metadata",
					);
					const turnColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(turns)`;
					expect(turnColumns.map((row) => row.name)).toEqual(
						expect.arrayContaining([
							"requested_model",
							"expected_model",
							"actual_model",
						]),
					);
					const sessionColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(sessions)`;
					expect(sessionColumns.map((row) => row.name)).toContain(
						"permission_mode",
					);
					const projectionFailureColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(projection_failures)`;
					expect(projectionFailureColumns.map((row) => row.name)).toContain(
						"event_sequence",
					);
					expect(yield* makeEffectSqlMigrator()).toEqual([]);
				}).pipe(
					Effect.provide(
						makeFileSqlLayer((filename) => {
							const db = new DatabaseSync(filename);
							try {
								seedLegacyEventStore(db, legacyId);
							} finally {
								db.close();
							}
						}),
					),
				),
		);
	}

	it.effect(
		"adds the sessions permission mode column to a migration-8 database",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "permission_mode"),
				).toHaveLength(1);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) => {
						const db = new DatabaseSync(filename);
						try {
							seedLegacyEventStore(db, 8);
						} finally {
							db.close();
						}
					}),
				),
			),
	);

	it.effect(
		"is idempotent when the sessions permission mode column already exists",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "permission_mode"),
				).toHaveLength(1);
				const history = yield* sql<{ name: string }>`
				SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(history.map((row) => row.name)).toEqual(expectedNames);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) => {
						const db = new DatabaseSync(filename);
						try {
							seedLegacyEventStore(db, 8);
							db.exec("ALTER TABLE sessions ADD COLUMN permission_mode TEXT");
						} finally {
							db.close();
						}
					}),
				),
			),
	);

	it.effect(
		"backfills existing fork ordering once and retains unresolved legacy lineage",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(21));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at)
				VALUES ('parent', 'claude', 'Parent', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
				VALUES ('boundary', 'parent', 'assistant', 'answer', 1000, 1000)`;
				yield* sql`INSERT INTO sessions
				(id, provider, title, parent_id, fork_point_event, created_at, updated_at)
				VALUES ('child', 'claude', 'Child', 'parent', 'boundary', 2000, 2000),
				('legacy', 'claude', 'Legacy', 'parent', 'missing', 2000, 2000)`;
				yield* makeEffectSqlMigrator();
				yield* sql`DELETE FROM messages WHERE id = 'boundary'`;
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
				const rows = yield* sql<{
					id: string;
					fork_point_timestamp: number | null;
					fork_point_message_id: string | null;
				}>`SELECT id, fork_point_timestamp, fork_point_message_id FROM sessions
				WHERE forked_from IS NOT NULL ORDER BY id`;
				expect(rows).toEqual([
					{
						id: "child",
						fork_point_timestamp: 1000,
						fork_point_message_id: "boundary",
					},
					{
						id: "legacy",
						fork_point_timestamp: null,
						fork_point_message_id: null,
					},
				]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"creates a fresh database with main behavior and feature stamps",
		() =>
			Effect.gen(function* () {
				const applied = yield* makeEffectSqlMigrator();
				expect(applied).toEqual(
					expectedNames.map((name, index) => [index + 1, name]),
				);
				const sql = yield* SqlClient.SqlClient;
				const history = yield* sql<{ migration_id: number; name: string }>`
				SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(history).toEqual(
					expectedNames.map((name, index) => ({
						migration_id: index + 1,
						name,
					})),
				);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(columns.map((row) => row.name)).toEqual(
					expect.arrayContaining([
						"last_turn_error_at",
						"settled_at",
						"pinned_at",
						"snoozed_at",
						"auto_settle_disabled_at",
						"version",
						"fork_point_timestamp",
						"fork_point_message_id",
						"last_turn_end_version",
						"seen_version",
						"claude_worktree_state",
						"workspace_hint",
						"workspace_hint_sequence",
						"pending_rewind_message_id",
						"forked_from",
					]),
				);
				for (const retired of ["read_at", "marked_unread_at", "last_viewed_at"])
					expect(columns.map((row) => row.name)).not.toContain(retired);
				expect(columns.map((row) => row.name)).not.toContain("rewind_version");
				const messageColumns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(messages)`;
				expect(messageColumns.map((row) => row.name)).not.toContain(
					"rewind_hidden",
				);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	for (const mainId of [17, 13, 2]) {
		it.effect(
			`upgrades a main Effect ${mainId} database and repeats as a no-op`,
			() =>
				Effect.gen(function* () {
					yield* makeEffectSqlMigrator(prefix(mainId));
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at)
					VALUES ('kept', 'opencode', 'Preserved', 1900000000000, 1900000000000)`;
					const applied = yield* makeEffectSqlMigrator();
					expect(applied).toHaveLength(
						migrationEntries.filter(
							([key]) => Number(key.split("_")[0]) > mainId,
						).length,
					);
					const history = yield* sql<{ migration_id: number; name: string }>`
					SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
					expect(history.map((row) => row.name)).toEqual(expectedNames);
					const rows = yield* sql<{ title: string; version: number }>`
					SELECT title, version FROM sessions WHERE id = 'kept'`;
					expect(rows).toEqual([
						{ title: "Preserved", version: expect.any(Number) },
					]);
					expect(yield* makeEffectSqlMigrator()).toEqual([]);
				}).pipe(Effect.provide(makeFileSqlLayer())),
		);
	}

	it.effect(
		"reconciles a known feature name occupying a main-owned migration id",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(17));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE effect_sql_migrations SET name = 'create_projection_failures'
				WHERE migration_id = 12`;
				expect(yield* makeEffectSqlMigrator()).toHaveLength(
					migrationEntries.filter(([key]) => Number(key.split("_")[0]) >= 12)
						.length,
				);
				const history = yield* sql<{ name: string }>`
				SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(history.map((row) => row.name)).toEqual(expectedNames);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect("reconciles local-main id 18 and reruns 18 through 26 once", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(17));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`ALTER TABLE sessions ADD COLUMN marked_unread_at INTEGER`;
			yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
				VALUES (18, 'sessions_marked_unread')`;
			const before = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name = 'projection_failures'`;
			expect(before).toEqual([]);
			expect(yield* makeEffectSqlMigrator()).toEqual(
				migrationEntries
					.slice(17)
					.map(([key], index) => [
						Number(key.split("_")[0]),
						expectedNames[index + 17],
					]),
			);
			const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name IN ('projection_failures', 'read_model_counter', 'sent_alerts')`;
			expect(tables.map((row) => row.name).sort()).toEqual([
				"projection_failures",
				"read_model_counter",
				"sent_alerts",
			]);
			const columns = yield* sql<{ name: string }>`PRAGMA table_info(sessions)`;
			expect(columns.map((row) => row.name)).toEqual(
				expect.arrayContaining([
					"version",
					"fork_point_timestamp",
					"fork_point_message_id",
					"last_turn_end_version",
					"seen_version",
				]),
			);
			const history = yield* sql<{
				name: string;
			}>`SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
			expect(history.map((row) => row.name)).toEqual(expectedNames);
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"migrates the live local-main ledger (18 sessions_marked_unread, 19 sessions_forked_from)",
		() =>
			Effect.gen(function* () {
				// The shape recorded in the live store on 2026-09-28 (conduit-test-l4ek).
				yield* makeEffectSqlMigrator(prefix(17));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`ALTER TABLE sessions ADD COLUMN marked_unread_at INTEGER`;
				yield* sql`ALTER TABLE sessions ADD COLUMN forked_from TEXT`;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
					VALUES (18, 'sessions_marked_unread'), (19, 'sessions_forked_from')`;
				const liveColumns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(liveColumns.map((row) => row.name)).toEqual([
					"id",
					"provider",
					"provider_sid",
					"title",
					"status",
					"parent_id",
					"fork_point_event",
					"last_message_at",
					"created_at",
					"updated_at",
					"permission_mode",
					"read_at",
					"last_turn_error_at",
					"settled_at",
					"pinned_at",
					"snoozed_at",
					"snoozed_until",
					"woken_at",
					"woken_reason",
					"unsettled_at",
					"auto_settle_disabled_at",
					"settled_automatically",
					"marked_unread_at",
					"forked_from",
				]);
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
					VALUES ('origin', 'claude', 1, 1)`;
				yield* sql`INSERT INTO sessions (id, provider, forked_from, fork_point_event,
					created_at, updated_at) VALUES
					('fork', 'claude', 'origin', 'boundary', 1, 1),
					('orphan-fork', 'claude', 'deleted', 'gone', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at)
					VALUES ('boundary', 'origin', 'assistant', 200, 200)`;

				expect(yield* makeEffectSqlMigrator()).toEqual(
					migrationEntries
						.slice(17)
						.map(([key], index) => [
							Number(key.split("_")[0]),
							expectedNames[index + 17],
						]),
				);
				const history = yield* sql<{ name: string }>`
					SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(history.map((row) => row.name)).toEqual(expectedNames);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(columns.map((row) => row.name)).toContain("forked_from");
				expect(
					yield* sql`SELECT id, parent_id, forked_from, fork_point_event, fork_point_timestamp,
						fork_point_message_id FROM sessions ORDER BY id`,
				).toEqual([
					{
						id: "fork",
						parent_id: null,
						forked_from: "origin",
						fork_point_event: "boundary",
						fork_point_timestamp: 200,
						fork_point_message_id: "boundary",
					},
					{
						id: "origin",
						parent_id: null,
						forked_from: null,
						fork_point_event: null,
						fork_point_timestamp: null,
						fork_point_message_id: null,
					},
					{
						id: "orphan-fork",
						parent_id: null,
						forked_from: null,
						fork_point_event: "gone",
						fork_point_timestamp: null,
						fork_point_message_id: null,
					},
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect("appends only migrations 23 to 26 to a HEAD id-22 database", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(22));
			const sql = yield* SqlClient.SqlClient;
			expect(yield* makeEffectSqlMigrator()).toEqual([
				[23, "sessions_marked_unread"],
				[24, "session_attention"],
				[25, "read_state_to_turn_ends"],
				[26, "sessions_forked_from"],
				[27, "messages_backfilled"],
				[28, "sessions_history_complete"],
				[29, "message_tombstones"],
				[30, "session_goals"],
				[31, "startup_restore_indexes"],
				[32, "tool_call_index"],
				[33, "pending_approvals_version"],
				[34, "sessions_model_settings"],
				[35, "sessions_side_thread"],
				[36, "sessions_limit_recovery"],
				[37, "sessions_resumes"],
				[38, "session_sidebar"],
				[39, "session_sidebar_tombstones"],
				[40, "sessions_workspace"],
				[41, "messages_input_id"],
				[42, "pending_inputs"],
				[43, "messages_steered"],
				[44, "sessions_last_turn_end_input_id"],
				[45, "project_provenance"],
				[46, "messages_context_tokens"],
				[47, "messages_completed_at"],
				[48, "sessions_claude_worktree_state"],
				[49, "sessions_workspace_hint"],
				[50, "sessions_pending_rewind"],
				[51, "message_part_versions"],
				[52, "session_git_published"],
				[53, "store_identity"],
				[54, "events_unstamped_index"],
				[55, "events_session_type_index"],
				[56, "drop_activities"],
				[57, "session_pick_backfill"],
				[58, "compact_redundant_events"],
				[59, "session_project_scope"],
				[60, "daemon_store_imports"],
				[61, "sessions_lineage"],
				[62, "legacy_forks"],
				[63, "sessions_archived"],
				[64, "prompt_provider_reference"],
				[65, "tool_result_event_refs"],
				[66, "project_tree_data"],
				[67, "purge_background_shell_sessions"],
				[68, "input_drafts"],
				[69, "goal_check_metadata"],
				[70, "message_part_surfacing"],
				[71, "sessions_settled_shelf_index"],
				[72, "surfacing_marks"],
				[73, "message_part_read"],
				[74, "turn_recaps"],
				[75, "events_parent_id_index"],
				[76, "events_forked_from_index"],
				[77, "message_parts_result_event_seq_index"],
				[78, "provider_run_ownership"],
			]);
			const columns = yield* sql<{ name: string }>`PRAGMA table_info(sessions)`;
			expect(columns.map((row) => row.name)).not.toContain("marked_unread_at");
			expect(columns.map((row) => row.name)).toContain("last_turn_end_version");
			expect(columns.map((row) => row.name)).toContain("seen_version");
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"carries main's read state into turn-end positions (failure list 1-17)",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(24));
				const sql = yield* SqlClient.SqlClient;
				// id, parent, fork point, last_message_at, read_at, marked_unread_at, preset last/seen
				const sessions = [
					["a-no-turns", null, null, null, null, null, null, null],
					["b-error-last-tied", null, null, 100, 100, null, null, null],
					["c-interrupted-only", null, null, 50, null, null, null, null],
					["d-interrupted-after", null, null, 20, 10, null, null, null],
					["e-marked-and-read", null, null, 50, 100, 60, null, null],
					["f-child", "b-error-last-tied", null, 50, null, null, null, null],
					["g-fork", "b-error-last-tied", "evt", 50, null, null, null, null],
					["h-already-seen", null, null, 50, null, null, 9, 9],
				] as const;
				for (const [
					id,
					parent,
					fork,
					lastMessage,
					read,
					marked,
					last,
					seen,
				] of sessions)
					yield* sql`INSERT INTO sessions (id, provider, parent_id, fork_point_event,
						last_message_at, read_at, marked_unread_at, last_turn_end_version,
						seen_version, created_at, updated_at)
						VALUES (${id}, 'claude', ${parent}, ${fork}, ${lastMessage}, ${read},
						${marked}, ${last}, ${seen}, 1, 1)`;
				const events = [
					["a-no-turns", 1, "message.created"],
					["b-error-last-tied", 3, "turn.completed"],
					["b-error-last-tied", 7, "turn.error"],
					["c-interrupted-only", 4, "turn.interrupted"],
					["d-interrupted-after", 2, "turn.completed"],
					["d-interrupted-after", 5, "turn.interrupted"],
					["e-marked-and-read", 3, "turn.completed"],
					["f-child", 3, "turn.completed"],
					["g-fork", 3, "turn.completed"],
					["h-already-seen", 3, "turn.completed"],
					["orphan", 1, "turn.completed"],
				] as const;
				for (const [sessionId, version, type] of events)
					yield* sql`INSERT INTO events (event_id, session_id, stream_version, type,
						data, provider, created_at)
						VALUES (${`${sessionId}-${version}`}, ${sessionId}, ${version}, ${type},
						'{}', 'claude', 1)`;

				expect(yield* makeEffectSqlMigrator()).toEqual([
					[25, "read_state_to_turn_ends"],
					[26, "sessions_forked_from"],
					[27, "messages_backfilled"],
					[28, "sessions_history_complete"],
					[29, "message_tombstones"],
					[30, "session_goals"],
					[31, "startup_restore_indexes"],
					[32, "tool_call_index"],
					[33, "pending_approvals_version"],
					[34, "sessions_model_settings"],
					[35, "sessions_side_thread"],
					[36, "sessions_limit_recovery"],
					[37, "sessions_resumes"],
					[38, "session_sidebar"],
					[39, "session_sidebar_tombstones"],
					[40, "sessions_workspace"],
					[41, "messages_input_id"],
					[42, "pending_inputs"],
					[43, "messages_steered"],
					[44, "sessions_last_turn_end_input_id"],
					[45, "project_provenance"],
					[46, "messages_context_tokens"],
					[47, "messages_completed_at"],
					[48, "sessions_claude_worktree_state"],
					[49, "sessions_workspace_hint"],
					[50, "sessions_pending_rewind"],
					[51, "message_part_versions"],
					[52, "session_git_published"],
					[53, "store_identity"],
					[54, "events_unstamped_index"],
					[55, "events_session_type_index"],
					[56, "drop_activities"],
					[57, "session_pick_backfill"],
					[58, "compact_redundant_events"],
					[59, "session_project_scope"],
					[60, "daemon_store_imports"],
					[61, "sessions_lineage"],
					[62, "legacy_forks"],
					[63, "sessions_archived"],
					[64, "prompt_provider_reference"],
					[65, "tool_result_event_refs"],
					[66, "project_tree_data"],
					[67, "purge_background_shell_sessions"],
					[68, "input_drafts"],
					[69, "goal_check_metadata"],
					[70, "message_part_surfacing"],
					[71, "sessions_settled_shelf_index"],
					[72, "surfacing_marks"],
					[73, "message_part_read"],
					[74, "turn_recaps"],
					[75, "events_parent_id_index"],
					[76, "events_forked_from_index"],
					[77, "message_parts_result_event_seq_index"],
					[78, "provider_run_ownership"],
				]);
				const rows = yield* sql<{
					id: string;
					last_turn_end_version: number | null;
					seen_version: number | null;
					unread: number;
				}>`SELECT id, last_turn_end_version, seen_version, unread
					FROM sessions ORDER BY id`;
				expect(
					rows.map((row) => [
						row.id,
						row.last_turn_end_version,
						row.seen_version,
						row.unread,
					]),
				).toEqual([
					["a-no-turns", null, null, 0],
					["b-error-last-tied", 7, 7, 0],
					["c-interrupted-only", null, -2, 1],
					["d-interrupted-after", 2, 1, 1],
					["e-marked-and-read", 3, 2, 1],
					["f-child", 3, 2, 0],
					["g-fork", 3, 2, 1],
					["h-already-seen", 9, 9, 0],
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"refuses an unknown recorded name without deleting ledger rows",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(17));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
				VALUES (18, 'foreign_future_migration')`;
				const result = yield* Effect.result(makeEffectSqlMigrator());
				expect(Either.isFailure(result)).toBe(true);
				if (Either.isFailure(result))
					expect(result.failure.message).toContain("foreign_future_migration");
				const history = yield* sql<{ migration_id: number; name: string }>`
				SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(history).toEqual([
					...migrationEntries.slice(0, 17).map(([key], index) => ({
						migration_id: Number(key.split("_")[0]),
						name: expectedNames[index],
					})),
					{ migration_id: 18, name: "foreign_future_migration" },
				]);
				const tables = yield* sql<{
					name: string;
				}>`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name = 'projection_failures'`;
				expect(tables).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);
});
