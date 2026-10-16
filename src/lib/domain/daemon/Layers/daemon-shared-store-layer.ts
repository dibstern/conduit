import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";
import type { DaemonConfig } from "../../../daemon/config-persistence.js";
import {
	makePersistenceStoreLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { importRegisteredProjectStores } from "../../../persistence/migrations/daemon-store-import.js";
import { migrateForkLineage } from "../../../persistence/migrations/fork-lineage-import.js";
import { migrateProjectStorage } from "../../../persistence/migrations/project-storage-migration.js";
import {
	daemonStorePath,
	projectStorageDir,
} from "../../../persistence/project-storage.js";
import { reclaimStore } from "../../../persistence/rewrite-store.js";
import { DaemonStoreAvailability } from "../Services/daemon-store-availability.js";

/** Offline preparation and import must finish before any daemon consumer opens SQLite. */
export const makeDaemonSharedStoreLayer = (
	configDir: string,
	config: DaemonConfig,
) => {
	const filename = daemonStorePath(configDir);
	const offline = Layer.effect(
		DaemonStoreAvailability,
		Effect.gen(function* () {
			const unavailable = yield* migrateProjectStorage(configDir, config);
			// An absent destination must stay absent so the importer can promote its
			// largest source. Every preparation handle closes before import/reclaim.
			if (existsSync(filename)) {
				yield* Effect.flatMap(ProjectionRunnerEffectTag, (runner) =>
					runner.recover(),
				).pipe(Effect.provide(makePersistenceStoreLayer(filename)));
				yield* reclaimStore(filename);
			}
			const registered = new Set(config.projects.map(({ slug }) => slug));
			const retained = yield* Effect.sync(() => {
				const projectsDir = join(configDir, "projects");
				return existsSync(projectsDir)
					? readdirSync(projectsDir, { withFileTypes: true })
							.filter(
								(entry) =>
									entry.isDirectory() &&
									!registered.has(entry.name) &&
									existsSync(join(projectsDir, entry.name, "events.db")),
							)
							.map((entry) => entry.name)
							.sort()
					: [];
			});
			const results = yield* importRegisteredProjectStores(configDir, [
				...config.projects
					.filter(({ slug }) => !unavailable.has(slug))
					.map(({ slug }) => ({
						projectId: slug,
						sourcePath: join(projectStorageDir(configDir, slug), "events.db"),
					})),
				...retained.map((slug) => ({
					projectId: slug,
					sourcePath: join(projectStorageDir(configDir, slug), "events.db"),
					retained: true,
				})),
			]);
			for (const result of results) {
				if (result.outcome === "failed" && result.error) {
					unavailable.set(
						result.projectId,
						`History import failed (${result.error.kind})`,
					);
				}
				const log =
					result.error || result.backupError
						? Effect.logWarning
						: Effect.logInfo;
				yield* log("Daemon store project import", result);
			}
			return unavailable;
		}),
	);
	const store = makePersistenceStoreLayer(filename).pipe(
		Layer.provideMerge(offline),
	);
	const published = Layer.effect(
		PersistenceStore,
		Effect.context<PersistenceStoreContext>(),
	).pipe(Layer.provideMerge(store));
	// This dependency also keeps the store alive until every downstream relay
	// and background consumer has released its own scope.
	return Layer.effectDiscard(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const unavailable = yield* DaemonStoreAvailability;
			if (unavailable.size > 0) {
				const blocked = yield* sql`SELECT 1 FROM sessions
					WHERE project_id IN ${sql.in([...unavailable.keys()])} LIMIT 1`;
				if (blocked.length > 0) {
					// Rerooting can update descendants and sidebar roots owned by other
					// projects. Keep the sidecar for retry rather than mutate blocked history.
					yield* Effect.logWarning(
						"Deferring fork lineage import while stored projects are unavailable",
					);
					return;
				}
			}
			yield* migrateForkLineage(configDir, config, sql);
		}),
	).pipe(Layer.provideMerge(published));
};
