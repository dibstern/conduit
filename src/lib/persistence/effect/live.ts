import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import {
	type Config,
	Context,
	Effect,
	Layer,
	type ManagedRuntime,
} from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import {
	EventRetentionLive,
	type EventRetentionTag,
} from "../../domain/persistence/Services/event-retention.js";
import {
	EventRetentionSchedulerLive,
	type EventRetentionSchedulerTag,
} from "../../domain/persistence/Services/event-retention-scheduler.js";
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
import { bindEventStoreEffect } from "./bind-event-store-effect.js";
import {
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
	makeUnboundClaudeEventPersistEffect,
	UnboundClaudeEventPersistEffectTag,
} from "./claude-event-persist-effect.js";
import {
	EventStoreEffectTag,
	makeUnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "./event-store-effect.js";
import { makeEffectSqlMigrator } from "./migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
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
	makeUnboundProviderStateEffect,
	ProviderStateEffectTag,
	UnboundProviderStateEffectTag,
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
	| EventRetentionTag
	| EventRetentionSchedulerTag
	| EventStoreEffectTag
	| ProjectorCursorEffectTag
	| ProjectionRunnerEffectTag
	| ReadQueryEffectTag
	| ProviderStateEffectTag
	| ClaudeEventPersistEffectTag;

export type PersistenceEffectError = PersistenceError | Config.ConfigError;

export type PersistenceStoreContext =
	| SqlClient.SqlClient
	| SqliteNode.SqliteClient
	| ProjectorCursorEffectTag
	| ProjectionRunnerEffectTag;

/** A borrowed store Context. Its acquiring scope retains connection ownership. */
export class PersistenceStore extends Context.Service<
	PersistenceStore,
	Context.Context<PersistenceStoreContext>
>()("PersistenceStore") {}

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
						yield* sql`PRAGMA busy_timeout = 5000`;
						yield* sql`PRAGMA journal_mode = WAL`;
						yield* sql`PRAGMA synchronous = NORMAL`;
						yield* sql`PRAGMA foreign_keys = OFF`;
						yield* makeEffectSqlMigrator();
					}).pipe(
						Effect.provide(
							SqliteNode.layer({ filename, busyTimeout: 5000 }).pipe(
								Layer.orDie,
								Layer.provide(Reactivity.layer),
							),
						),
						Effect.mapError(
							(cause) => new PersistenceError({ operation: "migrate", cause }),
						),
					);
					yield* reclaimStore(filename);
				});
	const preparedSqliteLayer = SqliteNode.layer({
		filename,
		busyTimeout: 5000,
	}).pipe(
		Layer.orDie,
		Layer.provide(Reactivity.layer),
		Layer.provide(Layer.effectDiscard(prepareStore)),
	);
	const sqliteLayer = Layer.effectDiscard(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`PRAGMA foreign_keys = ON`;
			yield* sql`PRAGMA journal_mode = WAL`;
			yield* sql`PRAGMA busy_timeout = 5000`;
			// SQLite maps at most the file's size; this is an address-space ceiling.
			// WAL's NORMAL sync, explicit rather than better-sqlite3's build default.
			yield* sql`PRAGMA synchronous = NORMAL`;
			yield* sql`PRAGMA mmap_size = 1073741824`;
			// Every INSERT ... RETURNING buffers its rows in a temp b-tree. On the
			// default file temp store that opens a temp file per statement, which
			// made event appends ~5x slower than the insert itself.
			yield* sql`PRAGMA temp_store = MEMORY`;
			yield* sql`PRAGMA analysis_limit = 400`;
			yield* sql`PRAGMA optimize = 0x10002`;
			const optimize = sql`PRAGMA optimize`.pipe(
				Effect.catch((cause) =>
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
};

export type PersistenceDaemonContext =
	| UnboundEventStoreEffectTag
	| UnboundProviderStateEffectTag
	| UnboundClaudeEventPersistEffectTag
	| ReadQueryEffectTag
	| ProjectionRunnerEffectTag;

/** Daemon writers borrow one store and resolve project ownership per session. */
export function makePersistenceDaemonLayer(
	options: PersistenceProjectOptions = {},
): Layer.Layer<PersistenceDaemonContext, never, PersistenceStoreContext> {
	const eventStoreLayer = Layer.effect(
		UnboundEventStoreEffectTag,
		makeUnboundEventStoreEffect,
	);
	const providerStateLayer = Layer.effect(
		UnboundProviderStateEffectTag,
		makeUnboundProviderStateEffect,
	);
	const projectionRunnerLayer = Layer.effect(
		ProjectionRunnerEffectTag,
		ProjectionRunnerEffectTag,
	);
	const readQueryLayer = Layer.effect(ReadQueryEffectTag, makeReadQueryEffect);
	const claudeDeps = Layer.merge(eventStoreLayer, projectionRunnerLayer);
	const claudeLayer = Layer.effect(
		UnboundClaudeEventPersistEffectTag,
		makeUnboundClaudeEventPersistEffect,
	).pipe(
		Layer.provide(
			options.sessionEventBusLayer
				? Layer.merge(claudeDeps, options.sessionEventBusLayer)
				: claudeDeps,
		),
	);
	return Layer.mergeAll(
		eventStoreLayer,
		providerStateLayer,
		projectionRunnerLayer,
		readQueryLayer,
		claudeLayer,
	);
}

export function makePersistenceProjectLayer(
	projectId: string,
	options: PersistenceProjectOptions = {},
): Layer.Layer<
	PersistenceProjectContext,
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
	const baseLayer = Layer.merge(projectLayer, persistenceServiceLayer);
	const retentionLayer = EventRetentionSchedulerLive.pipe(
		Layer.provideMerge(EventRetentionLive.pipe(Layer.provideMerge(baseLayer))),
	);
	const daemonLayer = makePersistenceDaemonLayer(options);
	const eventStoreLayer = Layer.effect(
		EventStoreEffectTag,
		Effect.map(UnboundEventStoreEffectTag, (store) =>
			bindEventStoreEffect(store, projectId),
		),
	).pipe(Layer.provide(daemonLayer));

	const providerStateLayer = Layer.effect(
		ProviderStateEffectTag,
		Effect.map(UnboundProviderStateEffectTag, (state) => ({
			...state,
			projectId,
		})),
	).pipe(Layer.provide(daemonLayer));

	const claudeEventPersistDeps = Layer.mergeAll(
		baseLayer,
		retentionLayer,
		eventStoreLayer,
		daemonLayer,
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

	return Layer.mergeAll(
		baseLayer,
		retentionLayer,
		eventStoreLayer,
		daemonLayer,
		providerStateLayer,
		claudeEventPersistLayer,
	);
}

export function makePersistenceEffectLayer(
	filename: string,
	projectId: string,
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
	sessionEventBusLayer?: Layer.Layer<SessionEventBusTag>,
): Layer.Layer<PersistenceEffectContext, PersistenceEffectError> {
	const projectLayer = makePersistenceProjectLayer(projectId, {
		sessionEventBusLayer,
	});
	// Only opening a per-project file may stamp provenance. Project consumers
	// cannot see the connection until preparation and stamping have completed.
	const storeLayer = Layer.effectDiscard(
		stampProjectProvenance(projectId),
	).pipe(Layer.provideMerge(makePersistenceStoreLayer(filename, projectors)));
	// provideMerge merges the store first, so the project's runner wins.
	return projectLayer.pipe(Layer.provideMerge(storeLayer));
}
