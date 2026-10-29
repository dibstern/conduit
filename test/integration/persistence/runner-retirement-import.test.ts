import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import {
	importProjectStore,
	seedDaemonStore,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import { createProjectStoreFixture } from "../../helpers/daemon-store-import-manifest.js";

it.live(
	"backfills duplicate live cursors once and enforces one serving row in SQLite",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// A store from a build before migration 0089.
			yield* sql`DROP TABLE claude_runner_cursors`;
			yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 89`;
			yield* sql`CREATE TABLE claude_runner_cursors (runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, session_id TEXT NOT NULL)`;
			yield* sql`INSERT INTO claude_runner_cursors VALUES ('older', 3, 'session'), ('newer', 9, 'session')`;
			yield* makeEffectSqlMigrator();
			const receipts = yield* makeRunnerReceiptStore(sql);
			expect((yield* receipts.runners()).rows).toMatchObject([
				{ runnerId: "older", role: "candidate" },
				{ runnerId: "newer", role: "serving" },
			]);
			expect(
				yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_runner_serving_session'`,
			).toHaveLength(1);
			// A lost registration race is a value (CONTRACT 6.10); SQLite itself
			// refuses a second serving row.
			expect(
				yield* receipts.register("third", { sessionId: "session" }, "serving"),
			).toBe("Lost");
			expect(
				yield* Effect.flip(
					sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, role) VALUES ('fourth', 0, 'session', 'serving')`,
				),
			).toMatchObject({
				reason: { constraint: "claude_runner_cursors.session_id" },
			});
			expect(
				yield* receipts.register(
					"candidate",
					{ sessionId: "session" },
					"candidate",
				),
			).toBe("Registered");
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
);

it.live(
	"imports new retired cursors into a populated legacy cursor table",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "conduit-runner-retirement-import-")),
					),
					(directory) =>
						Effect.sync(() =>
							rmSync(directory, { recursive: true, force: true }),
						),
				);
				const transcript = { prompt: "hello", reply: "reply" };
				const legacy = yield* Effect.tryPromise(() =>
					createProjectStoreFixture(root, "legacy", { transcript }),
				);
				const recent = yield* Effect.tryPromise(() =>
					createProjectStoreFixture(root, "recent", { transcript }),
				);
				const legacyDb = new DatabaseSync(legacy.sourcePath);
				try {
					// Both sources come from builds before migration 0089.
					legacyDb.exec(`DROP TABLE claude_runner_cursors;
				DELETE FROM effect_sql_migrations WHERE migration_id = 89;
				CREATE TABLE claude_runner_cursors (runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
				result_json TEXT NOT NULL DEFAULT '{}', attachment_id TEXT NOT NULL DEFAULT '');
				INSERT INTO claude_runner_cursors VALUES ('legacy_runner', 1, '{}', 'fixture-attachment')`);
				} finally {
					legacyDb.close();
				}
				const recentDb = new DatabaseSync(recent.sourcePath);
				try {
					recentDb.exec(`DROP TABLE claude_runner_cursors;
					DELETE FROM effect_sql_migrations WHERE migration_id = 89;
					CREATE TABLE claude_runner_cursors (
					runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
					result_json TEXT NOT NULL DEFAULT '{}', attachment_id TEXT NOT NULL DEFAULT '',
					retired_at INTEGER, pid INTEGER, start_time TEXT, owned_run_ids TEXT NOT NULL DEFAULT '[]',
					session_id TEXT NOT NULL DEFAULT '', signalled INTEGER NOT NULL DEFAULT 0,
					driver_kind TEXT NOT NULL DEFAULT 'claude', retirement_state TEXT NOT NULL DEFAULT 'Watching',
					signal_state TEXT NOT NULL DEFAULT 'None', signal_members TEXT NOT NULL DEFAULT '[]', signal_sent_members TEXT NOT NULL DEFAULT '[]',
					reaper_pid INTEGER, reaper_start_time TEXT,
					member_snapshot TEXT NOT NULL DEFAULT '[]', signal_log TEXT NOT NULL DEFAULT '[]');
					INSERT INTO claude_runner_cursors VALUES ('recent_runner', 1, '{}', '', 1234, 123,
					'verified-start', '["owned-run"]', 'ses_recent', 1, 'cursor', 'Watching', 'None', '[]', '[]', 124, 'reaper-start',
					'[{"pid":123,"startTime":"verified-start"},{"pid":124,"startTime":"reaper-start"}]',
					'[{"signal":"SIGTERM","target":-123,"members":[{"pid":123,"startTime":"verified-start"}],"outcome":"refused"}]');
					INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id)
					VALUES ('recent_legacy_cursor', 4, 'retained-attachment')`);
					recentDb.exec(`ALTER TABLE claude_runner_cursors ADD COLUMN stop_state TEXT NOT NULL DEFAULT 'Requested';
					ALTER TABLE claude_runner_cursors ADD COLUMN stop_reason TEXT NOT NULL DEFAULT 'Provider process stopped';
					ALTER TABLE claude_runner_cursors ADD COLUMN stop_started_at INTEGER;
					ALTER TABLE claude_runner_cursors ADD COLUMN role TEXT NOT NULL DEFAULT 'serving';
					UPDATE claude_runner_cursors SET role = 'candidate' WHERE runner_id = 'recent_runner';
					UPDATE claude_runner_cursors SET stop_state = 'Escalated', stop_reason = 'Explicit Stop', stop_started_at = 1200 WHERE runner_id = 'recent_runner';
					INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id) VALUES ('held-run', 'ses_recent', 'running', 1000, 'recent_runner');
					INSERT INTO provider_runs (id, session_id, status, requested_at, joined_into, runner_id) VALUES ('held-joined', 'ses_recent', 'joined', 999, 'held-run', 'recent_runner')`);
				} finally {
					recentDb.close();
				}
				const configDir = join(root, "daemon");
				yield* seedDaemonStore(configDir, legacy);
				// Model an older daemon's destination as well as its source. Daemon
				// startup migrates it before any import, and 0089 must leave its
				// columns in the order a fresh store has, or the import rejects them.
				const destination = new DatabaseSync(daemonStorePath(configDir));
				try {
					destination.exec(
						"DROP INDEX IF EXISTS idx_runner_serving_session; DELETE FROM effect_sql_migrations WHERE migration_id = 89",
					);
					for (const field of [
						"retired_at",
						"pid",
						"start_time",
						"owned_run_ids",
						"session_id",
						"signalled",
						"driver_kind",
						"retirement_state",
						"signal_state",
						"signal_members",
						"signal_sent_members",
						"reaper_pid",
						"reaper_start_time",
						"member_snapshot",
						"signal_log",
						"stop_state",
						"stop_reason",
						"stop_started_at",
						"role",
						"journals_before_execution",
					])
						destination.exec(
							`ALTER TABLE claude_runner_cursors DROP COLUMN ${field}`,
						);
				} finally {
					destination.close();
				}
				yield* makeEffectSqlMigrator().pipe(
					Effect.provide(
						SqliteNode.layer({ filename: daemonStorePath(configDir) }).pipe(
							Layer.provide(Reactivity.layer),
						),
					),
				);
				yield* importProjectStore(configDir, recent);
				const imported = new DatabaseSync(daemonStorePath(configDir), {
					readOnly: true,
				});
				try {
					expect(
						imported
							.prepare(
								"SELECT runner_id, sequence, attachment_id, retired_at, session_id, driver_kind FROM claude_runner_cursors ORDER BY runner_id",
							)
							.all(),
					).toEqual([
						{
							runner_id: "legacy_runner",
							sequence: 1,
							attachment_id: "fixture-attachment",
							retired_at: null,
							session_id: "",
							driver_kind: "claude",
						},
						{
							runner_id: "recent_legacy_cursor",
							sequence: 4,
							attachment_id: "retained-attachment",
							retired_at: null,
							session_id: "",
							driver_kind: "claude",
						},
						{
							runner_id: "recent_runner",
							sequence: 1,
							attachment_id: "",
							retired_at: 1234,
							session_id: "ses_recent",
							driver_kind: "cursor",
						},
					]);
					expect(
						imported
							.prepare(
								"SELECT pid, start_time, owned_run_ids, signalled, reaper_pid, reaper_start_time, member_snapshot, signal_log, stop_state, stop_reason, stop_started_at, role FROM claude_runner_cursors WHERE runner_id = 'recent_runner'",
							)
							.get(),
					).toEqual({
						pid: 123,
						start_time: "verified-start",
						owned_run_ids: '["owned-run"]',
						signalled: 1,
						stop_state: "Escalated",
						stop_reason: "Explicit Stop",
						stop_started_at: 1200,
						role: "candidate",
						reaper_pid: 124,
						reaper_start_time: "reaper-start",
						member_snapshot:
							'[{"pid":123,"startTime":"verified-start"},{"pid":124,"startTime":"reaper-start"}]',
						signal_log:
							'[{"signal":"SIGTERM","target":-123,"members":[{"pid":123,"startTime":"verified-start"}],"outcome":"refused"}]',
					});
					expect(
						imported
							.prepare(
								"SELECT id, joined_into, runner_id FROM provider_runs WHERE session_id = 'ses_recent' ORDER BY id",
							)
							.all(),
					).toEqual([
						{
							id: "held-joined",
							joined_into: "held-run",
							runner_id: "recent_runner",
						},
						{ id: "held-run", joined_into: null, runner_id: "recent_runner" },
					]);
					expect(
						imported
							.prepare(
								"SELECT stop_state, stop_reason, stop_started_at FROM claude_runner_cursors WHERE runner_id = 'legacy_runner'",
							)
							.get(),
					).toEqual({
						stop_state: "Requested",
						stop_reason: "Provider process stopped",
						stop_started_at: null,
					});
				} finally {
					imported.close();
				}
			}),
		),
);

it.live(
	"ranks duplicate live cursors from sources before 0089, with and without a role column",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "conduit-runner-role-import-")),
					),
					(directory) =>
						Effect.sync(() =>
							rmSync(directory, { recursive: true, force: true }),
						),
				);
				const transcript = { prompt: "hello", reply: "reply" };
				const roleless = yield* Effect.tryPromise(() =>
					createProjectStoreFixture(root, "roleless", { transcript }),
				);
				const roled = yield* Effect.tryPromise(() =>
					createProjectStoreFixture(root, "roled", { transcript }),
				);
				// Each table is a prefix of today's columns, as every older build's was.
				for (const [source, columns, sessionId] of [
					[roleless, "", "ses_roleless"],
					[
						roled,
						`, signalled INTEGER NOT NULL DEFAULT 0,
						driver_kind TEXT NOT NULL DEFAULT 'claude', retirement_state TEXT NOT NULL DEFAULT 'Watching',
						signal_state TEXT NOT NULL DEFAULT 'None', signal_members TEXT NOT NULL DEFAULT '[]', signal_sent_members TEXT NOT NULL DEFAULT '[]',
						reaper_pid INTEGER, reaper_start_time TEXT, member_snapshot TEXT NOT NULL DEFAULT '[]', signal_log TEXT NOT NULL DEFAULT '[]',
						stop_state TEXT NOT NULL DEFAULT 'Requested', stop_reason TEXT NOT NULL DEFAULT 'Provider process stopped', stop_started_at INTEGER,
						role TEXT NOT NULL DEFAULT 'serving'`,
						"ses_roled",
					],
				] as const) {
					const db = new DatabaseSync(source.sourcePath);
					try {
						db.exec(`DROP TABLE claude_runner_cursors;
						DELETE FROM effect_sql_migrations WHERE migration_id = 89;
						CREATE TABLE claude_runner_cursors (runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
						result_json TEXT NOT NULL DEFAULT '{}', attachment_id TEXT NOT NULL DEFAULT '',
						retired_at INTEGER, pid INTEGER, start_time TEXT, owned_run_ids TEXT NOT NULL DEFAULT '[]',
						session_id TEXT NOT NULL DEFAULT ''${columns});
						INSERT INTO claude_runner_cursors (runner_id, sequence, session_id)
						VALUES ('${sessionId}_older', 3, '${sessionId}'), ('${sessionId}_newer', 9, '${sessionId}')`);
					} finally {
						db.close();
					}
				}
				const configDir = join(root, "daemon");
				yield* seedDaemonStore(configDir, roleless);
				yield* importProjectStore(configDir, roled);
				const imported = new DatabaseSync(daemonStorePath(configDir), {
					readOnly: true,
				});
				try {
					expect(
						imported
							.prepare(
								"SELECT runner_id, role FROM claude_runner_cursors ORDER BY runner_id",
							)
							.all(),
					).toEqual([
						{ runner_id: "ses_roled_newer", role: "serving" },
						{ runner_id: "ses_roled_older", role: "candidate" },
						{ runner_id: "ses_roleless_newer", role: "serving" },
						{ runner_id: "ses_roleless_older", role: "candidate" },
					]);
					expect(
						imported
							.prepare(
								"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_runner_serving_session'",
							)
							.all(),
					).toHaveLength(1);
				} finally {
					imported.close();
				}
			}),
		),
);
