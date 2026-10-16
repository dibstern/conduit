import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import {
	type ConfigError,
	Context,
	Effect,
	Layer,
	type ManagedRuntime,
	Option,
} from "effect";
import { SessionDirectory } from "../../domain/daemon/Services/session-directory.js";
import {
	makePersistenceService,
	PersistenceError,
	PersistenceProjectTag,
	PersistenceServiceTag,
	preparePersistenceStore,
	stampProjectProvenance,
} from "../../domain/persistence/Services/persistence-service.js";
import type { SessionEventBusTag } from "../../domain/relay/Services/session-event-bus.js";
import { reclaimStore } from "../rewrite-store.js";
import {
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
} from "./claude-event-persist-effect.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "./event-store-effect.js";
import { makeEffectSqlMigrator } from "./migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "./projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "./projector-cursor-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "./projectors-effect.js";
import {
	makeProviderStateEffect,
	ProviderStateEffectTag,
} from "./provider-state-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "./read-query-effect.js";

export type PersistenceEffectContext =
	| SqlClient.SqlClient
	| SqliteNode.SqliteClient
	| PersistenceServiceTag
	| PersistenceProjectTag
	| EventStoreEffectTag
	| ProjectorCursorEffectTag
	| ProjectionRunnerEffectTag
	| ReadQueryEffectTag
	| ProviderStateEffectTag
	| ClaudeEventPersistEffectTag;

export type PersistenceEffectError = PersistenceError | ConfigError.ConfigError;

export type PersistenceStoreContext =
	| SqlClient.SqlClient
	| SqliteNode.SqliteClient
	| ProjectorCursorEffectTag
	| ProjectionRunnerEffectTag;

/** A borrowed store Context. Its acquiring scope retains connection ownership. */
export class PersistenceStore extends Context.Tag("PersistenceStore")<
	PersistenceStore,
	Context.Context<PersistenceStoreContext>
>() {}

export type PersistenceProjectContext = Exclude<
	PersistenceEffectContext,
	SqlClient.SqlClient | SqliteNode.SqliteClient | ProjectorCursorEffectTag
>;

export type PersistenceEffectRuntime = ManagedRuntime.ManagedRuntime<
	PersistenceEffectContext,
	PersistenceEffectError
>;

export function makePersistenceStoreLayer(
	filename: string,
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
): Layer.Layer<PersistenceStoreContext, PersistenceEffectError> {
	// Closing this migration connection first makes newly freed pages eligible
	// on this boot, without replacing a file behind a persistent SQLite handle.
	const prepareStore =
		filename === ":memory:"
			? Effect.void
			: Effect.gen(function* () {
					yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`PRAGMA foreign_keys = OFF`;
						yield* makeEffectSqlMigrator();
					}).pipe(
						Effect.provide(
							SqliteNode.layer({ filename }).pipe(
								Layer.provide(Reactivity.layer),
							),
						),
						Effect.mapError(
							(cause) => new PersistenceError({ operation: "migrate", cause }),
						),
					);
					yield* reclaimStore(filename);
				});
	const preparedSqliteLayer = SqliteNode.layer({ filename }).pipe(
		Layer.provide(Reactivity.layer),
		Layer.provide(Layer.effectDiscard(prepareStore)),
	);
	const sqliteLayer = Layer.scopedDiscard(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// SQLite maps at most the file's size; this is an address-space ceiling.
			yield* sql`PRAGMA mmap_size = 1073741824`;
			yield* sql`PRAGMA analysis_limit = 400`;
			yield* sql`PRAGMA optimize = 0x10002`;
			const optimize = sql`PRAGMA optimize`.pipe(
				Effect.catchAll((cause) =>
					Effect.logWarning("SQLite optimize failed", cause),
				),
				Effect.asVoid,
			);
			// Reverse finalization stops the fiber, optimizes, then closes the driver.
			yield* Effect.addFinalizer(() => optimize);
			yield* Effect.gen(function* () {
				yield* Effect.sleep("6 hours");
				yield* optimize;
			}).pipe(Effect.forever, Effect.forkScoped);
		}).pipe(
			Effect.mapError(
				(cause) => new PersistenceError({ operation: "tuneDatabase", cause }),
			),
		),
	).pipe(Layer.provideMerge(preparedSqliteLayer));

	// Also migrate the final connection: :memory: has no preparation connection.
	const baseLayer = Layer.effectDiscard(preparePersistenceStore).pipe(
		Layer.provideMerge(sqliteLayer),
	);

	const cursorLayer = Layer.effect(
		ProjectorCursorEffectTag,
		makeProjectorCursorEffect,
	).pipe(Layer.provide(baseLayer));

	const projectionRunnerLayer = Layer.effect(
		ProjectionRunnerEffectTag,
		makeProjectionRunnerEffect(projectors),
	).pipe(Layer.provide(Layer.merge(cursorLayer, baseLayer)));

	return Layer.mergeAll(baseLayer, cursorLayer, projectionRunnerLayer);
}

type PersistenceProjectOptions = {
	// Use the same shared bus as ingestion so publishers meet subscribers.
	sessionEventBusLayer?: Layer.Layer<SessionEventBusTag> | undefined;
	sessionDirectoryLayer?: Layer.Layer<SessionDirectory> | undefined;
};

export function makePersistenceProjectLayer(
	projectId: string,
	options: PersistenceProjectOptions & {
		sessionDirectoryLayer: Layer.Layer<SessionDirectory>;
	},
): Layer.Layer<
	PersistenceProjectContext | SessionDirectory,
	PersistenceError,
	PersistenceStoreContext
>;
export function makePersistenceProjectLayer(
	projectId: string,
	options?: PersistenceProjectOptions,
): Layer.Layer<
	PersistenceProjectContext,
	PersistenceError,
	PersistenceStoreContext
>;
export function makePersistenceProjectLayer(
	projectId: string,
	options: PersistenceProjectOptions = {},
):
	| Layer.Layer<
			PersistenceProjectContext,
			PersistenceError,
			PersistenceStoreContext
	  >
	| Layer.Layer<
			PersistenceProjectContext | SessionDirectory,
			PersistenceError,
			PersistenceStoreContext
	  > {
	if (!projectId || projectId.trim().length === 0)
		throw new PersistenceError({
			operation: "bindProject",
			cause: "A store requires a non-empty project id",
		});
	const projectLayer = Layer.succeed(PersistenceProjectTag, { projectId });
	const persistenceServiceLayer = Layer.fresh(
		Layer.effect(PersistenceServiceTag, makePersistenceService),
	).pipe(Layer.provide(projectLayer));
	const baseLayer = Layer.mergeAll(
		projectLayer,
		persistenceServiceLayer,
		options.sessionDirectoryLayer ?? Layer.empty,
	);
	const eventStoreLayer = Layer.effect(
		EventStoreEffectTag,
		makeEventStoreEffect,
	).pipe(Layer.provide(baseLayer));
	const projectionRunnerLayer = Layer.effect(
		ProjectionRunnerEffectTag,
		Effect.gen(function* () {
			const runner = yield* ProjectionRunnerEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const directory = yield* Effect.serviceOption(SessionDirectory);
			return {
				...runner,
				recover: () =>
					runner.recover().pipe(
						Effect.tap(() =>
							Effect.gen(function* () {
								if (Option.isNone(directory)) return;
								const sessions = yield* sql<{ readonly id: string }>`
							SELECT id FROM sessions WHERE project_id = ${projectId}`;
								yield* directory.value.replaceProject(
									projectId,
									sessions.map(({ id }) => id),
								);
							}),
						),
						Effect.mapError((cause) =>
							cause instanceof ProjectionRunnerError
								? cause
								: new ProjectionRunnerError({ operation: "recover", cause }),
						),
					),
			};
		}),
	).pipe(Layer.provide(baseLayer));

	const readQueryLayer = Layer.effect(
		ReadQueryEffectTag,
		makeReadQueryEffect,
	).pipe(Layer.provide(baseLayer));

	const providerStateLayer = Layer.effect(
		ProviderStateEffectTag,
		makeProviderStateEffect,
	).pipe(Layer.provide(baseLayer));

	const claudeEventPersistDeps = Layer.mergeAll(
		baseLayer,
		eventStoreLayer,
		projectionRunnerLayer,
	);
	const claudeEventPersistLayer = Layer.effect(
		ClaudeEventPersistEffectTag,
		makeClaudeEventPersistEffect,
	).pipe(
		Layer.provide(
			options.sessionEventBusLayer
				? Layer.merge(claudeEventPersistDeps, options.sessionEventBusLayer)
				: claudeEventPersistDeps,
		),
	);

	const services = Layer.mergeAll(
		baseLayer,
		eventStoreLayer,
		projectionRunnerLayer,
		readQueryLayer,
		providerStateLayer,
		claudeEventPersistLayer,
	);
	return options.sessionDirectoryLayer
		? Layer.merge(services, options.sessionDirectoryLayer)
		: services;
}

export function makePersistenceEffectLayer(
	filename: string,
	projectId: string,
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
	sessionEventBusLayer?: Layer.Layer<SessionEventBusTag>,
	sessionDirectoryLayer?: Layer.Layer<SessionDirectory>,
): Layer.Layer<PersistenceEffectContext, PersistenceEffectError> {
	const projectLayer = makePersistenceProjectLayer(projectId, {
		sessionEventBusLayer,
		sessionDirectoryLayer,
	});
	// Only opening a per-project file may stamp provenance. Project consumers
	// cannot see the connection until preparation and stamping have completed.
	const storeLayer = Layer.effectDiscard(
		stampProjectProvenance(projectId),
	).pipe(Layer.provideMerge(makePersistenceStoreLayer(filename, projectors)));
	// provideMerge merges the store first, so the project's runner wins.
	return projectLayer.pipe(Layer.provideMerge(storeLayer));
}
