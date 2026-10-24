import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";
import type { DaemonConfig } from "../../../daemon/config-persistence.js";
import { sweepAttachments } from "../../../persistence/attachment-store.js";
import {
	makePersistenceStoreLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { SessionRollupProjects } from "../../../persistence/effect/session-rollup-projects.js";
import { refreshCrossProjectSidebar } from "../../../persistence/effect/sidebar-projection.js";
import { importRegisteredProjectStores } from "../../../persistence/migrations/daemon-store-import.js";
import { migrateForkLineage } from "../../../persistence/migrations/fork-lineage-import.js";
import { migrateProjectStorage } from "../../../persistence/migrations/project-storage-migration.js";
import {
	daemonStorePath,
	projectStorageDir,
} from "../../../persistence/project-storage.js";
import { reclaimStore } from "../../../persistence/rewrite-store.js";
import {
	DaemonStoreAvailability,
	markProjectUnavailable,
} from "../Services/daemon-store-availability.js";

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
									(entry.isDirectory() || entry.isSymbolicLink()) &&
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
				// An error means nothing committed. A marker-backed source-changed
				// result has no error: its history is already imported.
				if (result.error) {
					yield* markProjectUnavailable(
						unavailable,
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
	const projects = Layer.effect(
		SessionRollupProjects,
		Effect.gen(function* () {
			const unavailable = yield* DaemonStoreAvailability;
			return yield* Ref.make<readonly string[]>(
				config.projects
					.map(({ slug }) => slug)
					.filter((slug) => !unavailable.has(slug)),
			);
		}),
	).pipe(Layer.provideMerge(offline));
	const store = makePersistenceStoreLayer(filename).pipe(
		Layer.provideMerge(projects),
	);
	const published = Layer.effect(
		PersistenceStore,
		Effect.gen(function* () {
			return Context.add(
				yield* Effect.context<PersistenceStoreContext>(),
				SessionRollupProjects,
				yield* SessionRollupProjects,
			);
		}),
	).pipe(Layer.provideMerge(store));
	// This dependency also keeps the store alive until every downstream relay
	// and background consumer has released its own scope.
	return Layer.effectDiscard(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const unavailable = yield* DaemonStoreAvailability;
			// All offline imports finished. No request or project consumer exists yet.
			yield* sweepAttachments;
			// Imported or previously cached families may include retained owners.
			// Rebuild after offline preparation, before any daemon reader starts.
			const projects = yield* SessionRollupProjects;
			const refresh = Effect.flatMap(
				projects ? Ref.get(projects) : Effect.succeed([]),
				refreshCrossProjectSidebar,
			);
			if (unavailable.size > 0) {
				const blocked = yield* sql`SELECT 1 FROM sessions
					WHERE project_id IN ${sql.in([...unavailable.keys()])} LIMIT 1`;
				if (blocked.length > 0) {
					// Rerooting can update descendants and sidebar roots owned by other
					// projects. Keep the sidecar for retry rather than mutate blocked history.
					yield* Effect.logWarning(
						"Deferring fork lineage import while stored projects are unavailable",
					);
					yield* refresh;
					return;
				}
			}
			yield* migrateForkLineage(configDir, config, sql);
			yield* refresh;
		}),
	).pipe(Layer.provideMerge(published));
};
