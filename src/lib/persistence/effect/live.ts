import { Reactivity } from "@effect/experimental";
import type { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { type ConfigError, Layer, type ManagedRuntime } from "effect";
import {
	makePersistenceServiceLive,
	type PersistenceError,
	type PersistenceServiceTag,
} from "../../effect/persistence-service.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "./event-store-effect.js";
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

export type PersistenceEffectContext =
	| SqlClient.SqlClient
	| SqliteNode.SqliteClient
	| PersistenceServiceTag
	| EventStoreEffectTag
	| ProjectorCursorEffectTag
	| ProjectionRunnerEffectTag;

export type PersistenceEffectError = PersistenceError | ConfigError.ConfigError;

export type PersistenceEffectRuntime = ManagedRuntime.ManagedRuntime<
	PersistenceEffectContext,
	PersistenceEffectError
>;

export function makePersistenceEffectLayer(
	filename: string,
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
) {
	const sqliteLayer = SqliteNode.layer({ filename }).pipe(
		Layer.provide(Reactivity.layer),
	);

	const persistenceServiceLayer = makePersistenceServiceLive.pipe(
		Layer.provide(sqliteLayer),
	);

	const baseLayer = Layer.merge(sqliteLayer, persistenceServiceLayer);

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

	return Layer.mergeAll(
		baseLayer,
		eventStoreLayer,
		cursorLayer,
		projectionRunnerLayer,
	);
}
