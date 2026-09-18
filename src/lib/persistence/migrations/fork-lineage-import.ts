import { randomUUID } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { loadDaemonConfig } from "../../daemon/config-persistence.js";
import { deserializeRecent } from "../../daemon/recent-projects.js";
import { MigrationError } from "../migrations.js";
import { SqliteClient } from "../sqlite-client.js";

const Sidecar = Schema.Record({
	key: Schema.String,
	value: Schema.Union(
		Schema.String,
		Schema.Struct({
			parentID: Schema.String,
			forkMessageId: Schema.String,
		}),
	),
});

/**
 * Global data import, not a numbered schema migration. The source has no project key, so this runs before
 * project relays open, across all known stores. It cannot run once per database:
 * the first project would delete the remaining projects' only copy of lineage.
 * Unresolved entries are retried from the archive at startup; partial imports are idempotent.
 */
export const migrateForkLineage = (configDir: string) =>
	Effect.try({
		try: () => {
			const path = join(configDir, "fork-metadata.json");
			const archive = join(configDir, "fork-metadata-unresolved.json");
			let archiveText: string | undefined;
			let hasSidecar = false;
			const entries = new Map<
				string,
				Schema.Schema.Type<typeof Sidecar>[string]
			>();
			for (const source of [archive, path]) {
				let text: string;
				try {
					text = readFileSync(source, "utf8");
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						continue;
					throw error;
				}
				if (source === archive) archiveText = text;
				else hasSidecar = true;
				const decoded = Schema.decodeUnknownSync(Schema.parseJson(Sidecar))(
					text,
				);
				for (const [id, entry] of Object.entries(decoded)) {
					if (
						entries.has(id) &&
						JSON.stringify(entries.get(id)) !== JSON.stringify(entry)
					) {
						throw new MigrationError({
							reason: `Conflicting fork lineage for ${id} in ${archive} and ${path}`,
						});
					}
					entries.set(id, entry);
				}
			}
			if (!hasSidecar && archiveText === undefined) return;
			const projects = new Set(
				loadDaemonConfig(configDir)?.projects.map((project) => project.path),
			);
			const recentPath = join(configDir, "recent.json");
			if (existsSync(recentPath)) {
				for (const project of deserializeRecent(
					readFileSync(recentPath, "utf8"),
				)) {
					projects.add(project.directory);
				}
			}
			const remaining = new Set(entries.keys());
			for (const project of projects) {
				const filename = join(project, ".conduit", "events.db");
				if (!existsSync(filename)) continue;
				const db = SqliteClient.open(filename);
				try {
					const imported = db.runInTransaction(() => {
						const ids: string[] = [];
						for (const [id, entry] of entries) {
							const row = db.queryOne<{
								parent_id: string | null;
								fork_point_event: string | null;
							}>(
								"SELECT parent_id, fork_point_event FROM sessions WHERE id = ?",
								[id],
							);
							if (!row) continue;
							const parent =
								typeof entry === "string" ? null : entry.parentID || null;
							if (
								parent &&
								!db.queryOne("SELECT id FROM sessions WHERE id = ?", [parent])
							)
								continue;
							const point =
								typeof entry === "string" ? entry : entry.forkMessageId;
							const changesLineage =
								(row.parent_id === null && parent !== null) ||
								(row.fork_point_event === null && point !== "");
							if (!changesLineage) {
								ids.push(id);
								continue;
							}
							db.execute(
								`UPDATE sessions SET parent_id = COALESCE(parent_id, ?),
						fork_point_event = COALESCE(fork_point_event, ?) WHERE id = ?`,
								[parent, point || null, id],
							);
							// Stores already on the new schema need the key during import;
							// older stores receive the same backfill in their schema migration.
							if (
								db
									.query<{ name: string }>("PRAGMA table_info(sessions)")
									.some((column) => column.name === "fork_point_timestamp")
							) {
								db.execute(
									`UPDATE sessions SET fork_point_timestamp = COALESCE(
									fork_point_timestamp, (SELECT created_at FROM messages
									WHERE session_id = sessions.parent_id AND id = sessions.fork_point_event)),
									fork_point_message_id = COALESCE(fork_point_message_id, fork_point_event)
									WHERE id = ?`,
									[id],
								);
							}
							// Resume cursors must see imported rows too. Older stores acquire
							// their first versions when their schema migrations run next.
							if (
								db.queryOne(
									"SELECT name FROM sqlite_master WHERE name = 'read_model_counter'",
								)
							) {
								db.execute(
									"UPDATE read_model_counter SET value = value + 1 WHERE id = 1",
								);
								db.execute(
									"UPDATE sessions SET version = (SELECT value FROM read_model_counter WHERE id = 1) WHERE id = ?",
									[id],
								);
							}
							ids.push(id);
						}
						return ids;
					});
					for (const id of imported) remaining.delete(id);
				} finally {
					db.close();
				}
			}
			if (remaining.size > 0) {
				const text = JSON.stringify(
					Object.fromEntries([...remaining].map((id) => [id, entries.get(id)])),
				);
				const temporary = `${archive}.${randomUUID()}.tmp`;
				try {
					writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
					// Replace only the archive consumed above, never a different file
					// that appeared while the databases were being imported.
					const current = existsSync(archive)
						? readFileSync(archive, "utf8")
						: undefined;
					if (current !== archiveText) {
						throw new MigrationError({
							reason: `Archive already exists with different contents: ${archive}`,
						});
					}
					renameSync(temporary, archive);
				} finally {
					if (existsSync(temporary)) unlinkSync(temporary);
				}
			} else if (archiveText !== undefined) {
				if (readFileSync(archive, "utf8") !== archiveText) {
					throw new MigrationError({
						reason: `Archive changed during import: ${archive}`,
					});
				}
				unlinkSync(archive);
			}
			// All databases have committed and closed before removing the global source.
			if (hasSidecar) unlinkSync(path);
			return remaining.size > 0
				? `Fork lineage import imported known sessions; ${remaining.size} unresolved session(s) retained for retry at next startup in ${archive}. The archive is not a request-path data source.`
				: undefined;
		},
		catch: (cause) => cause,
	}).pipe(
		Effect.flatMap((warning) =>
			warning === undefined ? Effect.void : Effect.logWarning(warning),
		),
		Effect.catchAll((error) =>
			Effect.logWarning(
				`Fork lineage import incomplete; startup continues and the source is retained. ${String(error)}`,
			),
		),
	);
