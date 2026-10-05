import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Data, Effect, Layer, Schema } from "effect";
import { loadDaemonConfig } from "../../daemon/config-persistence.js";
import { deserializeRecent } from "../../daemon/recent-projects.js";
import { projectEventsDbPath } from "../project-storage.js";

class ForkLineageImportError extends Data.TaggedError(
	"ForkLineageImportError",
)<{
	readonly message: string;
}> {}

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
	Effect.gen(function* () {
		const source = yield* Effect.try({
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
							throw new ForkLineageImportError({
								message: `Conflicting fork lineage for ${id} in ${archive} and ${path}`,
							});
						}
						entries.set(id, entry);
					}
				}
				if (!hasSidecar && archiveText === undefined) return undefined;
				const projects = new Map(
					loadDaemonConfig(configDir)?.projects.map((project) => [
						project.path,
						{ slug: project.slug, directory: project.path },
					]),
				);
				const recentPath = join(configDir, "recent.json");
				if (existsSync(recentPath)) {
					for (const project of deserializeRecent(
						readFileSync(recentPath, "utf8"),
					)) {
						if (!projects.has(project.directory)) {
							projects.set(project.directory, project);
						}
					}
				}
				return { path, archive, archiveText, hasSidecar, entries, projects };
			},
			catch: (cause) => cause,
		});
		if (source === undefined) return;

		const { path, archive, archiveText, hasSidecar, entries, projects } =
			source;
		const remaining = new Set(entries.keys());
		for (const project of projects.values()) {
			const filename = projectEventsDbPath({ configDir, ...project });
			if (!existsSync(filename)) continue;
			const sqliteLayer = SqliteNode.layer({ filename }).pipe(
				Layer.provide(Reactivity.layer),
			);
			const imported = yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						const columns = yield* sql<{
							name: string;
						}>`PRAGMA table_info(sessions)`;
						const hasForkTimestamp = columns.some(
							(column) => column.name === "fork_point_timestamp",
						);
						const ids: string[] = [];
						for (const [id, entry] of entries) {
							const [row] = yield* sql<{
								parent_id: string | null;
								fork_point_event: string | null;
							}>`
							SELECT parent_id, fork_point_event FROM sessions WHERE id = ${id}`;
							if (!row) continue;
							const parent =
								typeof entry === "string" ? null : entry.parentID || null;
							if (parent) {
								const parentRows = yield* sql<{
									id: string;
								}>`SELECT id FROM sessions WHERE id = ${parent}`;
								if (parentRows.length === 0) continue;
							}
							const point =
								typeof entry === "string" ? entry : entry.forkMessageId;
							let needsTimestamp = false;
							if (hasForkTimestamp) {
								const boundary = yield* sql<{ id: string }>`
								SELECT id FROM sessions WHERE id = ${id} AND fork_point_timestamp IS NULL
								AND EXISTS (SELECT 1 FROM messages WHERE session_id = sessions.parent_id
								AND id = sessions.fork_point_event)`;
								needsTimestamp = boundary.length > 0;
							}
							const changesLineage =
								(row.parent_id === null && parent !== null) ||
								(row.fork_point_event === null && point !== "") ||
								needsTimestamp;
							if (changesLineage) {
								yield* sql`UPDATE sessions SET parent_id = COALESCE(parent_id, ${parent}),
								fork_point_event = COALESCE(fork_point_event, ${point || null}) WHERE id = ${id}`;
								if (hasForkTimestamp) {
									yield* sql`UPDATE sessions SET fork_point_timestamp = COALESCE(
									fork_point_timestamp, (SELECT created_at FROM messages
									WHERE session_id = sessions.parent_id AND id = sessions.fork_point_event)),
									fork_point_message_id = COALESCE(fork_point_message_id, fork_point_event)
									WHERE id = ${id}`;
								}
								const counter = yield* sql<{ name: string }>`
								SELECT name FROM sqlite_master WHERE name = 'read_model_counter'`;
								if (counter.length > 0) {
									yield* sql`UPDATE read_model_counter SET value = value + 1 WHERE id = 1`;
									yield* sql`UPDATE sessions SET version =
									(SELECT value FROM read_model_counter WHERE id = 1) WHERE id = ${id}`;
								}
							}
							ids.push(id);
						}
						return ids;
					}),
				);
			}).pipe(Effect.provide(sqliteLayer));
			for (const id of imported) remaining.delete(id);
		}
		const warning = yield* Effect.try({
			try: () => {
				if (remaining.size > 0) {
					const text = JSON.stringify(
						Object.fromEntries(
							[...remaining].map((id) => [id, entries.get(id)]),
						),
					);
					const temporary = `${archive}.${randomUUID()}.tmp`;
					try {
						const descriptor = openSync(temporary, "wx", 0o600);
						try {
							writeFileSync(descriptor, text);
							fsyncSync(descriptor);
						} finally {
							closeSync(descriptor);
						}
						// Replace only the archive consumed above, never a different file
						// that appeared while the databases were being imported.
						const current = existsSync(archive)
							? readFileSync(archive, "utf8")
							: undefined;
						if (current !== archiveText) {
							throw new ForkLineageImportError({
								message: `Archive already exists with different contents: ${archive}`,
							});
						}
						renameSync(temporary, archive);
					} finally {
						if (existsSync(temporary)) unlinkSync(temporary);
					}
				} else if (archiveText !== undefined) {
					if (readFileSync(archive, "utf8") !== archiveText) {
						throw new ForkLineageImportError({
							message: `Archive changed during import: ${archive}`,
						});
					}
					unlinkSync(archive);
				}
				// Make the archive rename or deletion durable before discarding the source.
				if (remaining.size > 0 || archiveText !== undefined) {
					let directory: number | undefined;
					try {
						directory = openSync(configDir, "r");
						fsyncSync(directory);
					} catch (error) {
						// Windows may reject directory handles; some Unix filesystems do
						// not support directory fsync. Degrade only for these limitations.
						if (
							!(
								error instanceof Error &&
								"code" in error &&
								(error.code === "EINVAL" ||
									error.code === "ENOTSUP" ||
									(process.platform === "win32" &&
										(error.code === "EPERM" ||
											error.code === "EACCES" ||
											error.code === "EISDIR")))
							)
						) {
							throw error;
						}
					} finally {
						if (directory !== undefined) closeSync(directory);
					}
				}
				// All databases have committed and closed before removing the global source.
				if (hasSidecar) unlinkSync(path);
				return remaining.size > 0
					? `Fork lineage import imported known sessions; ${remaining.size} unresolved session(s) retained for retry at next startup in ${archive}. The archive is not a request-path data source.`
					: undefined;
			},
			catch: (cause) => cause,
		});
		if (warning !== undefined) yield* Effect.logWarning(warning);
	}).pipe(
		Effect.catchAllCause((cause) =>
			Cause.isInterruptedOnly(cause)
				? Effect.failCause(cause)
				: Effect.logWarning(
						`Fork lineage import incomplete; startup continues and the source is retained. ${Cause.pretty(cause)}`,
					),
		),
	);
