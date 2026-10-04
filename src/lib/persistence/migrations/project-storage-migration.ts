import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Data, Effect, Layer } from "effect";
import { loadDaemonConfig } from "../../daemon/config-persistence.js";
import {
	projectStorageDir,
	readProjectStorageOwner,
	writeProjectStorageOwner,
} from "../project-storage.js";

class ProjectStorageMigrationError extends Data.TaggedError(
	"ProjectStorageMigrationError",
)<{
	readonly message: string;
}> {}

const readTableCounts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const tables = yield* sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
	const counts: Array<{ name: string; count: number }> = [];
	for (const { name } of tables) {
		const [row] = yield* sql<{ count: number }>`
			SELECT COUNT(*) AS count FROM ${sql(name)}`;
		if (row === undefined) {
			return yield* new ProjectStorageMigrationError({
				message: `Failed to count table ${name}`,
			});
		}
		counts.push({ name, count: row.count });
	}
	return counts;
});

/** Move legacy history before any project relay opens its store. */
export const migrateProjectStorage = (configDir: string) =>
	Effect.gen(function* () {
		const projects = yield* Effect.sync(
			() => loadDaemonConfig(configDir)?.projects ?? [],
		);
		for (const project of projects) {
			const storageDir = projectStorageDir(configDir, project.slug);
			const filename = join(storageDir, "events.db");
			const legacy = resolve(project.path, ".conduit", "events.db");
			const temporary = `${filename}.${randomUUID()}.tmp`;
			yield* Effect.gen(function* () {
				const currentExists = existsSync(filename);
				const legacyExists = existsSync(legacy);
				if (!legacyExists && !currentExists) return;
				if (currentExists) {
					if (
						!legacyExists &&
						!existsSync(`${legacy}-wal`) &&
						!existsSync(`${legacy}-shm`)
					)
						return;
					// A previous run may have promoted the copy but failed to archive.
					if (
						readProjectStorageOwner(configDir, project.slug) !==
						resolve(project.path)
					)
						return;
				} else {
					yield* Effect.try(() => mkdirSync(storageDir, { recursive: true }));
					const sourceCounts = yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const [checkpoint] = yield* sql<{ busy: number }>`
							PRAGMA wal_checkpoint(TRUNCATE)`;
						if (checkpoint?.busy !== 0) {
							return yield* new ProjectStorageMigrationError({
								message: `Legacy WAL checkpoint is busy: ${legacy}`,
							});
						}
						const counts = yield* readTableCounts;
						yield* sql`VACUUM INTO ${temporary}`;
						return counts;
					}).pipe(
						Effect.provide(
							SqliteNode.layer({ filename: legacy, disableWAL: true }).pipe(
								Layer.provide(Reactivity.layer),
							),
						),
					);
					yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const check = yield* sql<{
							quick_check: string;
						}>`PRAGMA quick_check`;
						if (check.length !== 1 || check[0]?.quick_check !== "ok") {
							return yield* new ProjectStorageMigrationError({
								message: `Copy failed quick_check: ${JSON.stringify(check)}`,
							});
						}
						const copyCounts = yield* readTableCounts;
						if (JSON.stringify(copyCounts) !== JSON.stringify(sourceCounts)) {
							return yield* new ProjectStorageMigrationError({
								message: `Copy table counts differ from ${legacy}`,
							});
						}
					}).pipe(
						Effect.provide(
							SqliteNode.layer({
								filename: temporary,
								readonly: true,
								disableWAL: true,
							}).pipe(Layer.provide(Reactivity.layer)),
						),
					);
					yield* Effect.try(() => {
						writeProjectStorageOwner(configDir, project.slug, project.path);
						if (existsSync(filename)) {
							throw new ProjectStorageMigrationError({
								message: `Project store appeared during migration: ${filename}`,
							});
						}
						renameSync(temporary, filename);
					});
				}
				yield* Effect.try(() => {
					for (const suffix of ["", "-wal", "-shm"]) {
						if (
							existsSync(`${legacy}${suffix}`) &&
							existsSync(`${legacy}.migrated${suffix}`)
						) {
							throw new ProjectStorageMigrationError({
								message: `Legacy archive already exists: ${legacy}.migrated${suffix}`,
							});
						}
					}
					for (const suffix of ["", "-wal", "-shm"]) {
						if (existsSync(`${legacy}${suffix}`)) {
							renameSync(`${legacy}${suffix}`, `${legacy}.migrated${suffix}`);
						}
					}
				});
				yield* Effect.logInfo("Migrated project history", {
					projectSlug: project.slug,
					directory: project.path,
					filename,
				});
			}).pipe(
				Effect.ensuring(
					Effect.try(() => {
						if (existsSync(temporary)) unlinkSync(temporary);
					}).pipe(
						Effect.catchAll((cause) =>
							Effect.logWarning(
								"Failed to remove project migration temporary file",
								{ projectSlug: project.slug, temporary, cause },
							),
						),
					),
				),
				Effect.catchAllCause((cause) =>
					Cause.isInterruptedOnly(cause)
						? Effect.failCause(cause)
						: Effect.logWarning("Project history migration failed", {
								projectSlug: project.slug,
								directory: project.path,
								cause: Cause.pretty(cause),
							}),
				),
			);
		}
	});
