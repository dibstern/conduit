// Failure modes beyond the process harness:
// - A store is constructed without an id or with an empty id.
// - Empty command tables hide an omitted migration/stamping target.
// - Stamping changes event ids, sequences or payloads, or overwrites an event owner.
// - A caller's folder key overrides the slug bound to command writes.
// - Command tables gain a redundant project_id alongside project_key.
// - Legacy folder/empty/null keys remain, or metadata PK collisions lose progress.
// - Renumbering provenance loses main's migration order or changes shipped SQL.
// - Reopening runs UPDATEs despite every row already being stamped.
// - A failed stamp commits only a prefix of the tables.
// - Stored event and receipt contracts omit their project's identity.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { StoredEventSchema } from "../../../src/lib/contracts/stored-event.js";
import { PersistenceError } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectorCursorEffectTag } from "../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { PROJECT_PROVENANCE_MIGRATION } from "../../../src/lib/persistence/schema.js";
import { DurableCommandCommitRepository } from "../../../src/lib/provider/orchestration-command-commit.js";
import type { DurableCommandReceiptWrite } from "../../../src/lib/provider/orchestration-command-contracts.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const tables = [
	"events",
	"command_receipts",
	"provider_command_sessions",
	"provider_command_turns",
	"provider_command_interactions",
	"provider_command_tombstones",
	"provider_command_outbox",
	"provider_command_meta",
] as const;
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

async function oldStore() {
	const dir = mkdtempSync(join(tmpdir(), "conduit-provenance-"));
	directories.push(dir);
	const filename = join(dir, "events.db");
	await Effect.runPromise(
		Effect.scoped(
			makeEffectSqlMigrator(
				Object.fromEntries(Object.entries(effectMigrationEntries).slice(0, 44)),
			).pipe(Effect.provide(SqliteClient.layer({ filename }))),
		),
	);
	const db = new DatabaseSync(filename);
	try {
		db.exec(`
			INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at)
			VALUES ('old-event', 'old-session', 0, 'session.created', '{"sessionId":"old-session","title":"Old history","provider":"claude"}', '{}', 'claude', 1000);
			INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES ('old-command', 'old-session', 'accepted', 1000);
			INSERT INTO provider_command_sessions (project_key, session_id, provider_id, provider_kind, status, created_at, updated_at)
			VALUES ('old-folder', 'old-session', 'claude', 'claude', 'idle', 1000, 1000);
			INSERT INTO provider_command_turns (project_key, session_id, turn_id, command_id, status, created_at, updated_at)
			VALUES ('old-folder', 'old-session', 'turn-1', 'old-command', 'completed', 1000, 1000);
			INSERT INTO provider_command_interactions (project_key, session_id, interaction_id, kind, status, created_at, updated_at)
			VALUES ('old-folder', 'old-session', 'interaction-1', 'permission', 'resolved', 1000, 1000);
			INSERT INTO provider_command_tombstones (project_key, scope_kind, scope_id, event_sequence, reason_code, tombstoned_at)
			VALUES ('old-folder', 'session', 'gone-session', 1, 'deleted', 1000);
			INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, requested_at, updated_at)
			VALUES (1, 'old-command', 'old-folder', 'old-session', 'claude', 'send_turn', '{}', 1000, 1000);
			INSERT INTO provider_command_meta (project_key, last_applied_sequence, schema_version, rebuilt_at) VALUES ('old-folder', 9, 2, 2000);
			INSERT INTO provider_command_meta (project_key, last_applied_sequence, schema_version, rebuilt_at) VALUES ('alpha', 3, 1, 1000);
			INSERT INTO provider_command_meta (project_key, last_applied_sequence, schema_version, rebuilt_at) VALUES ('', 6, 1, 1500);
			INSERT INTO provider_command_meta (project_key, last_applied_sequence, schema_version, rebuilt_at) VALUES (NULL, 4, 1, 1200);
		`);
	} finally {
		db.close();
	}
	return filename;
}

describe("Bound project provenance", () => {
	it("registers provenance after main's migrations with the file/key offset", () => {
		expect(PROJECT_PROVENANCE_MIGRATION).toBe("0044_project_provenance.sql");
		expect(Object.keys(effectMigrationEntries).slice(40)).toEqual([
			"0041_messages_input_id",
			"0042_pending_inputs",
			"0043_messages_steered",
			"0044_sessions_last_turn_end_input_id",
			"0045_project_provenance",
			"0046_messages_context_tokens",
			"0047_messages_completed_at",
			"0048_sessions_claude_worktree_state",
			"0049_sessions_workspace_hint",
			"0050_sessions_pending_rewind",
			"0051_message_part_versions",
			"0052_session_git_published",
			"0053_store_identity",
			"0054_events_unstamped_index",
			"0055_events_session_type_index",
			"0056_drop_activities",
			"0057_session_pick_backfill",
			"0058_compact_redundant_events",
			"0059_session_project_scope",
			"0060_daemon_store_imports",
			"0061_sessions_lineage",
			"0062_legacy_forks",
			"0063_sessions_archived",
			"0064_prompt_provider_reference",
			"0065_tool_result_event_refs",
			"0066_project_tree_data",
		]);
	});

	it("requires a project id at construction and in stored contracts", () => {
		expectTypeOf<
			Parameters<typeof makePersistenceEffectLayer>[1]
		>().toEqualTypeOf<string>();
		expectTypeOf<
			DurableCommandReceiptWrite["projectKey"]
		>().toEqualTypeOf<string>();
		expect(() => makePersistenceEffectLayer(":memory:", "")).toThrow(
			PersistenceError,
		);
		const event = {
			...makeSessionCreatedEvent("session-1"),
			sequence: 1,
			streamVersion: 0,
		};
		expect(Schema.is(StoredEventSchema)(event)).toBe(false);
		expect(Schema.is(StoredEventSchema)({ ...event, projectId: "alpha" })).toBe(
			true,
		);
	});

	it("binds append, receipt, outbox and metadata ownership while cursors remain store-wide", async () => {
		const runtime = ManagedRuntime.make(
			makePersistenceEffectLayer(":memory:", "alpha"),
		);
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const stored = yield* store.append(
						makeSessionCreatedEvent("session-1"),
					);
					expect(stored.projectId).toBe("alpha");
					expect((yield* store.readBySession("session-1"))[0]?.projectId).toBe(
						"alpha",
					);
					const cursors = yield* ProjectorCursorEffectTag;
					yield* cursors.upsert("session", stored.sequence);
					expect(yield* cursors.get("session")).toMatchObject({
						projectorName: "session",
						lastAppliedSeq: stored.sequence,
					});
				}),
			);
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const repository = new DurableCommandCommitRepository(sql, "alpha");
					const input = {
						events: [],
						readModelRows: [],
						receipt: {
							commandId: "command-1",
							commandType: "send_turn",
							projectKey: "legacy-key",
							sessionId: "session-1",
							status: "accepted" as const,
							fingerprintHash: "hash",
							fingerprintVersion: 2 as const,
							createdAt: 1,
							updatedAt: 1,
						},
						outboxRequests: [
							{
								requestSequence: 1,
								commandId: "command-1",
								projectKey: "legacy-key",
								sessionId: "session-1",
								providerId: "claude",
								effectType: "send_turn" as const,
								payloadJson: "{}",
							},
						],
					};
					yield* repository.commit(input);
					const snapshot = yield* new CommandReadModelRepository(
						sql,
						"alpha",
					).bootstrap();
					expect(snapshot.projectId).toBe("alpha");
					expect(snapshot.receipts.get("command-1")?.projectId).toBe("alpha");
					for (const table of [
						"command_receipts",
						"provider_command_outbox",
						"provider_command_meta",
					])
						expect(
							yield* sql.unsafe(`SELECT project_key FROM ${table}`),
						).toEqual([{ project_key: "alpha" }]);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});

	it("stamps legacy command keys, merges metadata progress and preserves event owners; reopens without updates", async () => {
		const filename = await oldStore();
		const before = new DatabaseSync(filename);
		const events = before
			.prepare("SELECT * FROM events ORDER BY sequence")
			.all();
		before.close();
		const runtime = ManagedRuntime.make(
			makePersistenceEffectLayer(filename, "alpha"),
		);
		try {
			await runtime.runPromise(EventStoreEffectTag);
		} finally {
			await runtime.dispose();
		}
		const db = new DatabaseSync(filename);
		try {
			for (const table of tables)
				expect(
					db
						.prepare(
							`SELECT ${table === "events" ? "project_id" : "project_key"} AS project FROM ${table}`,
						)
						.all(),
					table,
				).toEqual([{ project: "alpha" }]);
			expect(db.prepare("SELECT * FROM provider_command_meta").all()).toEqual([
				{
					project_key: "alpha",
					last_applied_sequence: 9,
					schema_version: 2,
					rebuilt_at: 2000,
				},
			]);
			for (const table of tables.filter((table) => table !== "events"))
				expect(
					db.prepare(`PRAGMA table_info(${table})`).all(),
					table,
				).not.toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "project_id" }),
					]),
				);
			expect(
				db
					.prepare(
						"SELECT sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at FROM events ORDER BY sequence",
					)
					.all(),
			).toEqual(events);
			// A populated owner survives even when a caller supplies a different
			// scope; the expand migration never relabels an already stamped row.
			db.exec("UPDATE events SET project_id = 'existing-owner'");
			for (const table of tables)
				db.exec(
					`CREATE TRIGGER no_stamp_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'already stamped'); END`,
				);
		} finally {
			db.close();
		}
		const reopened = ManagedRuntime.make(
			makePersistenceEffectLayer(filename, "alpha"),
		);
		try {
			await reopened.runPromise(EventStoreEffectTag);
		} finally {
			await reopened.dispose();
		}
	});

	it.each([
		{ canonical: 20, stale: 9, expected: 20 },
		{ canonical: 3, stale: 9, expected: 9 },
		{ canonical: 9, stale: 9, expected: 9 },
	])("keeps the highest metadata sequence when keys converge: $canonical/$stale", async ({
		canonical,
		stale,
		expected,
	}) => {
		const filename = await oldStore();
		const db = new DatabaseSync(filename);
		db.prepare(
			"UPDATE provider_command_meta SET last_applied_sequence = ? WHERE project_key = 'alpha'",
		).run(canonical);
		db.prepare(
			"UPDATE provider_command_meta SET last_applied_sequence = ? WHERE project_key = 'old-folder'",
		).run(stale);
		db.close();
		const runtime = ManagedRuntime.make(
			makePersistenceEffectLayer(filename, "alpha"),
		);
		try {
			await runtime.runPromise(EventStoreEffectTag);
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT project_key, last_applied_sequence FROM provider_command_meta`,
					).toEqual([
						{ project_key: "alpha", last_applied_sequence: expected },
					]);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});

	it("rolls all stamping back on failure and retries an unstamped store", async () => {
		const filename = await oldStore();
		await Effect.runPromise(
			Effect.scoped(
				makeEffectSqlMigrator().pipe(
					Effect.provide(SqliteClient.layer({ filename })),
				),
			),
		);
		const db = new DatabaseSync(filename);
		db.exec(
			"UPDATE events SET project_id = ''; CREATE TRIGGER reject_stamp BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'stamp failure'); END",
		);
		const runtime = ManagedRuntime.make(
			makePersistenceEffectLayer(filename, "alpha"),
		);
		try {
			await expect(runtime.runPromise(EventStoreEffectTag)).rejects.toThrow();
		} finally {
			await runtime.dispose();
		}
		expect(db.prepare("SELECT project_id FROM events").get()).toEqual({
			project_id: "",
		});
		db.exec("DROP TRIGGER reject_stamp");
		db.close();
		const retried = ManagedRuntime.make(
			makePersistenceEffectLayer(filename, "alpha"),
		);
		try {
			expect(
				(
					await retried.runPromise(
						EventStoreEffectTag.pipe(
							Effect.flatMap((store) => store.readAllBySession("old-session")),
						),
					)
				)[0]?.projectId,
			).toBe("alpha");
		} finally {
			await retried.dispose();
		}
	});
});
