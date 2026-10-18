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
import { type ConfigError, Data, Effect, Layer, Schema } from "effect";
import type { DaemonConfig } from "../../daemon/config-persistence.js";
import { deserializeRecent } from "../../daemon/recent-projects.js";
import * as Failure from "../../effect/failure-classification.js";
import { refreshSidebar, rerootSession } from "../effect/sidebar-projection.js";
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
export const migrateForkLineage = (
	configDir: string,
	config: DaemonConfig,
	sharedSql?: SqlClient.SqlClient,
) =>
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
					config.projects.map((project) => [
						project.path,
						{ slug: project.slug, folders: project.folders },
					]),
				);
				const recentPath = join(configDir, "recent.json");
				if (existsSync(recentPath)) {
					for (const project of deserializeRecent(
						readFileSync(recentPath, "utf8"),
					)) {
						if (!projects.has(project.directory)) {
							projects.set(project.directory, {
								slug: project.slug,
								folders: [project.directory],
							});
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
		const sessionIds = JSON.stringify([
			...new Set(
				[...entries].flatMap(([id, entry]) =>
					typeof entry === "string" ? [id] : [id, entry.parentID],
				),
			),
		]);
		// Shared mode resolves each child's stored owner after import. The legacy
		// branch retains its per-file discovery, including recent projects.
		const stores: Layer.Layer<SqlClient.SqlClient, ConfigError.ConfigError>[] =
			sharedSql
				? [Layer.succeed(SqlClient.SqlClient, sharedSql)]
				: [...projects.values()].flatMap((project) => {
						const filename = projectEventsDbPath({ configDir, ...project });
						return existsSync(filename)
							? [
									SqliteNode.layer({ filename }).pipe(
										Layer.provide(Reactivity.layer),
									),
								]
							: [];
					});
		for (const sqliteLayer of stores) {
			const imported = yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				const hasLineage = columns.some(
					(column) => column.name === "forked_from",
				);
				const lineageColumn = sql.literal(
					hasLineage ? "forked_from" : "parent_id",
				);
				const sideThreadColumn = columns.some(
					(column) => column.name === "side_thread",
				)
					? "side_thread"
					: "0 AS side_thread";
				// Missing archived ids need one probe per store, without taking a writer.
				const rows = yield* sql<{
					id: string;
					parent_id: string | null;
					forked_from?: string | null;
					side_thread?: number;
					fork_point_event: string | null;
				}>`SELECT id, parent_id, fork_point_event${sql.literal(hasLineage ? `, forked_from, ${sideThreadColumn}` : "")} FROM sessions
					WHERE id IN (SELECT value FROM json_each(${sessionIds}))`;
				const sessions = new Map(rows.map((row) => [row.id, row] as const));
				const eligible = [...entries].filter(
					([id, entry]) =>
						sessions.has(id) &&
						(typeof entry === "string" ||
							!entry.parentID ||
							sessions.has(entry.parentID)),
				);
				if (eligible.length === 0) return [];
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						const hasForkTimestamp = columns.some(
							(column) => column.name === "fork_point_timestamp",
						);
						const hasRootId = columns.some(
							(column) => column.name === "root_id",
						);
						const ids: string[] = [];
						for (const [id, entry] of eligible) {
							const row = sessions.get(id);
							if (!row) continue;
							const parent =
								typeof entry === "string"
									? hasLineage
										? row.parent_id
										: null
									: entry.parentID || null;
							const point =
								typeof entry === "string" ? entry : entry.forkMessageId;
							let needsTimestamp = false;
							if (hasForkTimestamp) {
								const boundary = yield* sql<{ id: string }>`
								SELECT id FROM sessions WHERE id = ${id} AND fork_point_timestamp IS NULL
								AND EXISTS (SELECT 1 FROM messages WHERE session_id = sessions.${lineageColumn}
								AND id = sessions.fork_point_event)`;
								needsTimestamp = boundary.length > 0;
							}
							const detachesFork =
								hasLineage &&
								row.parent_id !== null &&
								row.side_thread !== 1 &&
								(row.forked_from != null || parent !== null);
							const changesLineage =
								detachesFork ||
								((hasLineage ? row.forked_from : row.parent_id) == null &&
									parent !== null) ||
								(row.fork_point_event === null && point !== "") ||
								needsTimestamp;
							if (changesLineage) {
								yield* sql`UPDATE sessions SET ${lineageColumn} = COALESCE(${lineageColumn}, ${parent}),
								fork_point_event = COALESCE(fork_point_event, ${point || null}) WHERE id = ${id}`;
								// Import precedes schema migrations; leaving containment here
								// would hide this Fork from the legacy repair's NULL-lineage guard.
								if (detachesFork)
									yield* sql`UPDATE sessions SET parent_id = NULL WHERE id = ${id}`;
								if (hasForkTimestamp) {
									yield* sql`UPDATE sessions SET fork_point_timestamp = COALESCE(
									fork_point_timestamp, (SELECT created_at FROM messages
									WHERE session_id = sessions.${lineageColumn} AND id = sessions.fork_point_event)),
									fork_point_message_id = COALESCE(fork_point_message_id, fork_point_event)
									WHERE id = ${id}`;
								}
								const counter = yield* sql<{ name: string }>`
								SELECT name FROM sqlite_master WHERE name = 'read_model_counter'`;
								if (counter.length > 0) {
									yield* sql`UPDATE read_model_counter SET value = value + 1 WHERE id = 1`;
									yield* sql`UPDATE sessions SET version =
									(SELECT value FROM read_model_counter WHERE id = 1) WHERE id = ${id}`;
									if (hasRootId) {
										const [version] = yield* sql<{ value: number }>`
										SELECT value FROM read_model_counter WHERE id = 1`;
										const left = yield* rerootSession(id, version?.value ?? 0);
										// The sidebar's upkeep writes today's table, which an
										// older store gets from a later migration whose
										// backfill refreshes every family anyway.
										const horizon = yield* sql<{ name: string }>`
										SELECT name FROM sqlite_master
										WHERE name = 'session_sidebar_horizon'`;
										if (horizon.length > 0)
											yield* refreshSidebar(left, version?.value ?? 0);
									}
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
		if (sharedSql) {
			// The per-file adapter closes/checkpoints before retiring the sidecar.
			// The daemon connection stays open, so checkpoint it explicitly first.
			const [checkpoint] = yield* sharedSql<{
				busy: number;
			}>`PRAGMA wal_checkpoint(FULL)`;
			if (checkpoint?.busy !== 0)
				return yield* new ForkLineageImportError({
					message:
						"Fork lineage checkpoint is busy; retaining source for retry",
				});
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
			Failure.isInterruptedOnly(cause)
				? Effect.failCause(cause)
				: Effect.logWarning(
						`Fork lineage import incomplete; startup continues and the source is retained. ${Failure.renderCause(cause)}`,
					),
		),
	);
