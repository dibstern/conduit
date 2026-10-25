import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	importProjectStore,
	seedDaemonStore,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import { createProjectStoreFixture } from "../../helpers/daemon-store-import-manifest.js";

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
					legacyDb.exec(`CREATE TABLE claude_runner_cursors (runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
				result_json TEXT NOT NULL DEFAULT '{}', attachment_id TEXT NOT NULL DEFAULT '');
				INSERT INTO claude_runner_cursors VALUES ('legacy_runner', 1, '{}', 'fixture-attachment')`);
				} finally {
					legacyDb.close();
				}
				const recentDb = new DatabaseSync(recent.sourcePath);
				try {
					recentDb.exec(`CREATE TABLE claude_runner_cursors (
					runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
					result_json TEXT NOT NULL DEFAULT '{}', attachment_id TEXT NOT NULL DEFAULT '',
					retired_at INTEGER, pid INTEGER, start_time TEXT, owned_run_ids TEXT NOT NULL DEFAULT '[]',
					session_id TEXT NOT NULL DEFAULT '', signalled INTEGER NOT NULL DEFAULT 0,
					driver_kind TEXT NOT NULL DEFAULT 'claude');
					INSERT INTO claude_runner_cursors VALUES ('recent_runner', 1, '{}', '', 1234, 123,
					'verified-start', '["owned-run"]', 'ses_recent', 1, 'cursor');
					INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id)
					VALUES ('recent_legacy_cursor', 4, 'retained-attachment')`);
				} finally {
					recentDb.close();
				}
				const configDir = join(root, "daemon");
				yield* seedDaemonStore(configDir, legacy);
				// Model an already-running older daemon's destination as well as its source.
				const destination = new DatabaseSync(daemonStorePath(configDir));
				try {
					for (const field of [
						"retired_at",
						"pid",
						"start_time",
						"owned_run_ids",
						"session_id",
						"signalled",
						"driver_kind",
					])
						destination.exec(
							`ALTER TABLE claude_runner_cursors DROP COLUMN ${field}`,
						);
				} finally {
					destination.close();
				}
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
								"SELECT pid, start_time, owned_run_ids, signalled FROM claude_runner_cursors WHERE runner_id = 'recent_runner'",
							)
							.get(),
					).toEqual({
						pid: 123,
						start_time: "verified-start",
						owned_run_ids: '["owned-run"]',
						signalled: 1,
					});
				} finally {
					imported.close();
				}
			}),
		),
);
