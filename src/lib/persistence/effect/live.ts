import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { type ConfigError, Effect, Layer, type ManagedRuntime } from "effect";
import {
	makePersistenceServiceLive,
	PersistenceError,
	PersistenceProjectTag,
	type PersistenceServiceTag,
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

export type PersistenceEffectRuntime = ManagedRuntime.ManagedRuntime<
	PersistenceEffectContext,
	PersistenceEffectError
>;

export function makePersistenceEffectLayer(
	filename: string,
	projectId: string,
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
	// When supplied, the SAME shared bus layer used by the ingestion choke point.
	// Wiring it here lets ClaudeEventPersistEffect publish committed writes (e.g.
	// user messages) as a post-commit change signal. Omitted → persist stays
	// silent (serviceOption resolves None). Must be the shared instance so all
	// publishers and subscribers meet on one PubSub under Effect memoization.
	sessionEventBusLayer?: Layer.Layer<SessionEventBusTag>,
) {
	if (!projectId || projectId.trim().length === 0)
		throw new PersistenceError({
			operation: "bindProject",
			cause: "A store requires a non-empty project id",
		});
	const projectLayer = Layer.succeed(PersistenceProjectTag, { projectId });
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

	// Each bound store must migrate and stamp its own connection, even when
	// several stores are composed in the same Layer graph.
	const persistenceServiceLayer = Layer.fresh(makePersistenceServiceLive).pipe(
		Layer.provide(Layer.merge(sqliteLayer, projectLayer)),
	);

	const baseLayer = Layer.mergeAll(
		sqliteLayer,
		projectLayer,
		persistenceServiceLayer,
	);

	const eventStoreLayer = Layer.effect(
		EventStoreEffectTag,
		makeEventStoreEffect,
	).pipe(Layer.provide(baseLayer));

	const cursorLayer = Layer.effect(
		ProjectorCursorEffectTag,
		makeProjectorCursorEffect,
	).pipe(Layer.provide(baseLayer));

	const projectionRunnerLayer = Layer.effect(
		ProjectionRunnerEffectTag,
		makeProjectionRunnerEffect(projectors),
	).pipe(Layer.provide(Layer.merge(cursorLayer, baseLayer)));

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
			sessionEventBusLayer
				? Layer.merge(claudeEventPersistDeps, sessionEventBusLayer)
				: claudeEventPersistDeps,
		),
	);

	return Layer.mergeAll(
		baseLayer,
		eventStoreLayer,
		cursorLayer,
		projectionRunnerLayer,
		readQueryLayer,
		providerStateLayer,
		claudeEventPersistLayer,
	);
}
