import { SqlClient } from "@effect/sql";
import * as Migrator from "@effect/sql/Migrator";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import {
	CURRENT_EVENT_STORE_MIGRATION,
	DURABLE_PROVIDER_COMMANDS_MIGRATION,
	MESSAGE_PART_METADATA_MIGRATION,
	readMigrationSql,
} from "../schema.js";

export const EFFECT_SQL_MIGRATIONS_TABLE = "effect_sql_migrations";

const baselineMigrationSql = readMigrationSql(CURRENT_EVENT_STORE_MIGRATION);
const messagePartMetadataMigrationSql = readMigrationSql(
	MESSAGE_PART_METADATA_MIGRATION,
);
const durableProviderCommandsMigrationSql = readMigrationSql(
	DURABLE_PROVIDER_COMMANDS_MIGRATION,
);

const expectedTableColumns = {
	activities: [
		"id",
		"session_id",
		"turn_id",
		"tone",
		"kind",
		"summary",
		"payload",
		"sequence",
		"created_at",
	],
	command_receipts: [
		"command_id",
		"session_id",
		"status",
		"result_sequence",
		"error",
		"created_at",
		"command_type",
		"project_key",
		"fingerprint_hash",
		"fingerprint_version",
		"accepted_sequence",
		"side_effect_sequence",
		"error_code",
		"updated_at",
	],
	events: [
		"sequence",
		"event_id",
		"session_id",
		"stream_version",
		"type",
		"data",
		"metadata",
		"provider",
		"created_at",
	],
	message_parts: [
		"id",
		"message_id",
		"type",
		"text",
		"tool_name",
		"call_id",
		"input",
		"result",
		"duration",
		"status",
		"sort_order",
		"created_at",
		"updated_at",
		"metadata",
	],
	messages: [
		"id",
		"session_id",
		"turn_id",
		"role",
		"text",
		"cost",
		"tokens_in",
		"tokens_out",
		"tokens_cache_read",
		"tokens_cache_write",
		"is_streaming",
		"is_inherited",
		"last_applied_seq",
		"created_at",
		"updated_at",
	],
	pending_approvals: [
		"id",
		"session_id",
		"turn_id",
		"type",
		"status",
		"tool_name",
		"input",
		"decision",
		"always",
		"created_at",
		"resolved_at",
	],
	projector_cursors: ["projector_name", "last_applied_seq", "updated_at"],
	provider_command_interactions: [
		"project_key",
		"session_id",
		"interaction_id",
		"turn_id",
		"kind",
		"status",
		"request_sequence",
		"result_sequence",
		"created_at",
		"updated_at",
		"tombstoned_at",
		"tombstone_reason",
		"retain_until",
	],
	provider_command_meta: [
		"project_key",
		"last_applied_sequence",
		"schema_version",
		"rebuilt_at",
	],
	provider_command_outbox: [
		"request_sequence",
		"command_id",
		"project_key",
		"session_id",
		"provider_id",
		"effect_type",
		"payload_json",
		"status",
		"attempt_count",
		"result_sequence",
		"error_code",
		"next_attempt_at",
		"requested_at",
		"updated_at",
	],
	provider_command_sessions: [
		"project_key",
		"session_id",
		"provider_id",
		"provider_kind",
		"provider_session_id",
		"status",
		"active_turn_id",
		"last_sequence",
		"created_at",
		"updated_at",
		"tombstoned_at",
		"tombstone_reason",
		"retain_until",
	],
	provider_command_tombstones: [
		"project_key",
		"scope_kind",
		"scope_id",
		"session_id",
		"turn_id",
		"causation_command_id",
		"event_sequence",
		"reason_code",
		"tombstoned_at",
		"retain_until",
		"details_json",
	],
	provider_command_turns: [
		"project_key",
		"session_id",
		"turn_id",
		"command_id",
		"status",
		"user_message_id",
		"assistant_message_id",
		"side_effect_sequence",
		"result_sequence",
		"error_code",
		"created_at",
		"updated_at",
		"tombstoned_at",
		"tombstone_reason",
		"retain_until",
	],
	provider_state: ["session_id", "key", "value"],
	session_providers: [
		"id",
		"session_id",
		"provider",
		"provider_sid",
		"status",
		"activated_at",
		"deactivated_at",
	],
	sessions: [
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
	],
	tool_content: ["tool_id", "session_id", "content", "created_at"],
	turns: [
		"id",
		"session_id",
		"state",
		"user_message_id",
		"assistant_message_id",
		"cost",
		"tokens_in",
		"tokens_out",
		"requested_at",
		"started_at",
		"completed_at",
	],
} as const;

const expectedTableNames = Object.keys(expectedTableColumns).sort();
const durableProviderCommandTableNames = [
	"provider_command_interactions",
	"provider_command_meta",
	"provider_command_outbox",
	"provider_command_sessions",
	"provider_command_tombstones",
	"provider_command_turns",
] as const;
const durableProviderCommandTableNameSet = new Set<string>(
	durableProviderCommandTableNames,
);
const preDurableProviderCommandTableNames = expectedTableNames.filter(
	(name) => !durableProviderCommandTableNameSet.has(name),
);
const preDurableCommandReceiptColumns =
	expectedTableColumns.command_receipts.slice(0, 6);

const expectedIndexNames = [
	"idx_activities_session_created",
	"idx_activities_session_kind",
	"idx_activities_tone",
	"idx_activities_turn",
	"idx_command_receipts_project",
	"idx_command_receipts_session",
	"idx_events_session_seq",
	"idx_events_session_version",
	"idx_events_type",
	"idx_message_parts_message",
	"idx_messages_session_created",
	"idx_messages_turn",
	"idx_pending_approvals_pending",
	"idx_pending_approvals_session_status",
	"idx_provider_command_outbox_status",
	"idx_provider_command_tombstones_session",
	"idx_provider_command_turns_session",
	"idx_session_providers_active",
	"idx_session_providers_session",
	"idx_sessions_parent",
	"idx_sessions_provider",
	"idx_sessions_updated",
	"idx_tool_content_session",
	"idx_turns_assistant_message",
	"idx_turns_session_requested",
] as const;
const durableProviderCommandIndexNames = [
	"idx_command_receipts_project",
	"idx_provider_command_outbox_status",
	"idx_provider_command_tombstones_session",
	"idx_provider_command_turns_session",
] as const;
const durableProviderCommandIndexNameSet = new Set<string>(
	durableProviderCommandIndexNames,
);
const preDurableProviderCommandIndexNames = expectedIndexNames.filter(
	(name) => !durableProviderCommandIndexNameSet.has(name),
);

const migrationKeyPattern = /^(\d+)_(.+)$/;

function migrationRegistryError(message: string): Migrator.MigrationError {
	return new Migrator.MigrationError({
		reason: "bad-state",
		message,
	});
}

function splitSqlStatements(sqlText: string): readonly string[] {
	return sqlText
		.split(/;\s*(?:\r?\n|$)/)
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

function sameStrings(
	actual: readonly string[],
	expected: readonly string[],
): boolean {
	if (actual.length !== expected.length) return false;
	return actual.every((value, index) => value === expected[index]);
}

const executeSqlStatements = (
	sqlText: string,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		for (const statement of splitSqlStatements(sqlText)) {
			yield* sql.unsafe(statement);
		}
	});

const failSchemaMismatch = (
	message: string,
): Effect.Effect<never, Migrator.MigrationError> =>
	Effect.fail(migrationRegistryError(message));

const verifyExistingBaselineSchema: Effect.Effect<
	void,
	unknown,
	SqlClient.SqlClient
> = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const tables = yield* sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type='table'
			AND name NOT LIKE 'sqlite_%'
			AND name NOT IN ('_migrations', ${EFFECT_SQL_MIGRATIONS_TABLE})
		ORDER BY name`;
	const actualTableNames = tables.map((row) => row.name);
	const knownTableShape =
		sameStrings(actualTableNames, expectedTableNames) ||
		sameStrings(actualTableNames, preDurableProviderCommandTableNames);
	if (!knownTableShape) {
		return yield* failSchemaMismatch(
			`Existing event-store tables differ from baseline migration. Expected ${expectedTableNames.join(", ")}, got ${actualTableNames.join(", ")}`,
		);
	}

	const indexes = yield* sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type='index' AND name NOT LIKE 'sqlite_%'
		ORDER BY name`;
	const actualIndexNames = indexes.map((row) => row.name);
	const knownIndexShape =
		sameStrings(actualIndexNames, expectedIndexNames) ||
		sameStrings(actualIndexNames, preDurableProviderCommandIndexNames);
	if (!knownIndexShape) {
		return yield* failSchemaMismatch(
			`Existing event-store indexes differ from baseline migration. Expected ${expectedIndexNames.join(", ")}, got ${actualIndexNames.join(", ")}`,
		);
	}

	for (const [tableName, expectedColumns] of Object.entries(
		expectedTableColumns,
	)) {
		if (
			durableProviderCommandTableNameSet.has(tableName) &&
			!actualTableNames.includes(tableName)
		) {
			continue;
		}
		const columns = yield* sql.unsafe<{ name: string }>(
			`PRAGMA table_info(${tableName})`,
		);
		const actualColumns = columns.map((column) => column.name);
		const matchesKnownSchema =
			sameStrings(actualColumns, expectedColumns) ||
			(tableName === "command_receipts" &&
				sameStrings(actualColumns, preDurableCommandReceiptColumns)) ||
			(tableName === "message_parts" &&
				sameStrings(
					actualColumns,
					expectedColumns.filter((column) => column !== "metadata"),
				));
		if (!matchesKnownSchema) {
			return yield* failSchemaMismatch(
				`Existing event-store columns differ for ${tableName}. Expected ${expectedColumns.join(", ")}, got ${actualColumns.join(", ")}`,
			);
		}
	}
});

const runBaselineEventStoreMigration: Effect.Effect<
	void,
	unknown,
	SqlClient.SqlClient
> = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const existingTables = yield* sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type='table'
			AND name NOT LIKE 'sqlite_%'
			AND name NOT IN ('_migrations', ${EFFECT_SQL_MIGRATIONS_TABLE})
		LIMIT 1`;

	if (existingTables.length === 0) {
		yield* executeSqlStatements(baselineMigrationSql);
		return;
	}

	yield* verifyExistingBaselineSchema;
});

const runMessagePartMetadataMigration: Effect.Effect<
	void,
	unknown,
	SqlClient.SqlClient
> = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql.unsafe<{ name: string }>(
		"PRAGMA table_info(message_parts)",
	);
	if (columns.some((column) => column.name === "metadata")) return;

	yield* executeSqlStatements(messagePartMetadataMigrationSql);
});

const runDurableProviderCommandsMigration: Effect.Effect<
	void,
	unknown,
	SqlClient.SqlClient
> = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql.unsafe<{ name: string }>(
		"PRAGMA table_info(command_receipts)",
	);
	if (columns.some((column) => column.name === "fingerprint_hash")) return;

	yield* executeSqlStatements(durableProviderCommandsMigrationSql);
});

export const effectMigrationEntries = {
	"0001_create_event_store_tables": runBaselineEventStoreMigration,
	"0002_add_message_part_metadata": runMessagePartMetadataMigration,
	"0003_add_durable_provider_commands": runDurableProviderCommandsMigration,
} satisfies Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>;

export function makeEffectMigrationLoader(
	entries: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>,
): Migrator.Loader {
	return Effect.gen(function* () {
		const parsed = [];
		const seenIds = new Set<number>();
		const seenNames = new Set<string>();
		for (const key of Object.keys(entries)) {
			const match = key.match(migrationKeyPattern);
			if (!match) {
				return yield* Effect.fail(
					migrationRegistryError(
						`Migration key "${key}" must match "<number>_<name>"`,
					),
				);
			}

			const id = Number(match[1]);
			const name = match[2];
			if (!Number.isInteger(id) || id <= 0) {
				return yield* Effect.fail(
					migrationRegistryError(
						`Migration key "${key}" must use a positive integer id`,
					),
				);
			}
			if (!name || name.trim() === "") {
				return yield* Effect.fail(
					migrationRegistryError(`Migration key "${key}" must include a name`),
				);
			}
			if (seenIds.has(id)) {
				return yield* Effect.fail(
					migrationRegistryError(`Duplicate migration id ${id}`),
				);
			}
			if (seenNames.has(name)) {
				return yield* Effect.fail(
					migrationRegistryError(`Duplicate migration name "${name}"`),
				);
			}
			seenIds.add(id);
			seenNames.add(name);
			parsed.push({ id, name });
		}

		const sorted = parsed.sort((a, b) => a.id - b.id);
		for (const [index, migration] of sorted.entries()) {
			const expectedId = index + 1;
			if (migration.id !== expectedId) {
				return yield* Effect.fail(
					migrationRegistryError(
						`Migration ids must be contiguous starting at 1: expected ${expectedId}, got ${migration.id} (${migration.name})`,
					),
				);
			}
		}

		return yield* Migrator.fromRecord(entries);
	});
}

export function makeEffectSqlMigrator(
	entries: Record<
		string,
		Effect.Effect<void, unknown, SqlClient.SqlClient>
	> = effectMigrationEntries,
): Effect.Effect<
	ReadonlyArray<readonly [id: number, name: string]>,
	Migrator.MigrationError | SqlError,
	SqlClient.SqlClient
> {
	return Migrator.make({})({
		loader: makeEffectMigrationLoader(entries),
		table: EFFECT_SQL_MIGRATIONS_TABLE,
	});
}
