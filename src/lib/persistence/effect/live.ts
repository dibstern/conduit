import { Reactivity } from "@effect/experimental";
import type { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { type ConfigError, Layer, type ManagedRuntime } from "effect";
import {
	makePersistenceServiceLive,
	type PersistenceError,
	type PersistenceServiceTag,
} from "../../domain/persistence/Services/persistence-service.js";
import type { SessionEventBusTag } from "../../domain/relay/Services/session-event-bus.js";
import {
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
} from "./claude-event-persist-effect.js";
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
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
	// When supplied, the SAME shared bus layer used by the ingestion choke point.
	// Wiring it here lets ClaudeEventPersistEffect publish committed writes (e.g.
	// user messages) as a post-commit change signal. Omitted → persist stays
	// silent (serviceOption resolves None). Must be the shared instance so all
	// publishers and subscribers meet on one PubSub under Effect memoization.
	sessionEventBusLayer?: Layer.Layer<SessionEventBusTag>,
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
