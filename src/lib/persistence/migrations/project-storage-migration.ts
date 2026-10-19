import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { Data, Effect } from "effect";
import type { DaemonConfig } from "../../daemon/config-persistence.js";
import * as Failure from "../../effect/failure-classification.js";
import {
	projectStorageDir,
	readProjectStorageOwner,
	writeProjectStorageOwner,
} from "../project-storage.js";
import { rewriteStore } from "../rewrite-store.js";

class ProjectStorageMigrationError extends Data.TaggedError(
	"ProjectStorageMigrationError",
)<{
	readonly message: string;
}> {}

/** Prepare one project's legacy history before publishing it or opening its relay. */
export const migrateProjectStorageForProject = (
	configDir: string,
	project: Pick<DaemonConfig["projects"][number], "slug" | "path">,
) =>
	Effect.gen(function* () {
		const storageDir = projectStorageDir(configDir, project.slug);
		const filename = join(storageDir, "events.db");
		const legacy = resolve(project.path, ".conduit", "events.db");
		return yield* Effect.gen(function* () {
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
				yield* Effect.try(() => {
					writeProjectStorageOwner(configDir, project.slug, project.path);
				});
				yield* rewriteStore(legacy, filename);
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
			Effect.catchCause((cause) =>
				Failure.isInterruptedOnly(cause)
					? Effect.failCause(cause).pipe(Effect.orDie)
					: Effect.sync(() => {
							const error = Failure.squashCause(cause);
							return `Legacy history migration failed: ${error instanceof Error ? error.message : String(error)}`;
						}).pipe(
							Effect.tap(() =>
								Effect.logWarning("Project history migration failed", {
									projectSlug: project.slug,
									directory: project.path,
									cause: Failure.renderCause(cause),
								}),
							),
						),
			),
		);
	});

/** Move legacy history before any daemon consumer opens its store. */
export const migrateProjectStorage = (
	configDir: string,
	config: DaemonConfig,
) =>
	Effect.gen(function* () {
		const failures = new Map<string, string>();
		for (const project of config.projects) {
			const reason = yield* migrateProjectStorageForProject(configDir, project);
			if (reason !== undefined) failures.set(project.slug, reason);
		}
		return failures;
	});
