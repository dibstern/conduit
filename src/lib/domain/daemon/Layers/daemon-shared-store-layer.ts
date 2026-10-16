import { existsSync } from "node:fs";
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
import {
	daemonStorePath,
	projectStorageDir,
} from "../../../persistence/project-storage.js";
import { reclaimStore } from "../../../persistence/rewrite-store.js";

/** Offline preparation and import must finish before any daemon consumer opens SQLite. */
export const makeDaemonSharedStoreLayer = (
	configDir: string,
	config: DaemonConfig,
) => {
	const filename = daemonStorePath(configDir);
	const offline = Layer.effectDiscard(
		Effect.gen(function* () {
			// An absent destination must stay absent so the importer can promote its
			// largest source. Every preparation handle closes before import/reclaim.
			if (existsSync(filename)) {
				yield* Effect.flatMap(ProjectionRunnerEffectTag, (runner) =>
					runner.recover(),
				).pipe(Effect.provide(makePersistenceStoreLayer(filename)));
				yield* reclaimStore(filename);
			}
			const results = yield* importRegisteredProjectStores(
				configDir,
				config.projects.map(({ slug }) => ({
					projectId: slug,
					sourcePath: join(projectStorageDir(configDir, slug), "events.db"),
				})),
			);
			for (const result of results) {
				const log =
					result.error || result.backupError
						? Effect.logWarning
						: Effect.logInfo;
				yield* log("Daemon store project import", result);
			}
		}),
	);
	const store = makePersistenceStoreLayer(filename).pipe(
		Layer.provide(offline),
	);
	const published = Layer.effect(
		PersistenceStore,
		Effect.context<PersistenceStoreContext>(),
	).pipe(Layer.provideMerge(store));
	// This dependency also keeps the store alive until every downstream relay
	// and background consumer has released its own scope.
	return Layer.effectDiscard(
		Effect.flatMap(SqlClient.SqlClient, (sql) =>
			migrateForkLineage(configDir, config, sql),
		),
	).pipe(Layer.provideMerge(published));
};
