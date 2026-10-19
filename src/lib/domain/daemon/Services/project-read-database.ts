import { Context, Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import {
	type PersistenceEffectError,
	PersistenceStore,
} from "../../../persistence/effect/live.js";
import type { StoredProject } from "../../../types.js";
import {
	makePersistenceService,
	PersistenceProjectTag,
	PersistenceServiceTag,
} from "../../persistence/Services/persistence-service.js";
import { DaemonStoreAvailability } from "./daemon-store-availability.js";

/** Preserve the borrowed daemon store across explicitly restricted contexts. */
export const persistenceStoreContext = Effect.gen(function* () {
	return Context.make(PersistenceStore, yield* PersistenceStore).pipe(
		Context.add(DaemonStoreAvailability, yield* DaemonStoreAvailability),
	);
});

/** Bind a project without opening, preparing or stamping the daemon store. */
export function projectReadDatabase(
	project: Pick<StoredProject, "slug">,
	options: { readonly prepare: true },
): Effect.Effect<
	Layer.Layer<
		SqlClient.SqlClient | PersistenceServiceTag,
		PersistenceEffectError
	>,
	never,
	PersistenceStore
>;
export function projectReadDatabase(
	project: Pick<StoredProject, "slug">,
	options?: { readonly prepare?: false },
): Effect.Effect<
	Layer.Layer<SqlClient.SqlClient, PersistenceEffectError>,
	never,
	PersistenceStore
>;
export function projectReadDatabase(
	project: Pick<StoredProject, "slug">,
	options: { readonly prepare?: boolean } = {},
): Effect.Effect<
	| Layer.Layer<SqlClient.SqlClient, PersistenceEffectError>
	| Layer.Layer<
			SqlClient.SqlClient | PersistenceServiceTag,
			PersistenceEffectError
	  >,
	never,
	PersistenceStore
> {
	return Effect.gen(function* () {
		const database = Layer.succeedContext(yield* PersistenceStore);
		if (!options.prepare) return database;
		return Layer.fresh(
			Layer.effect(PersistenceServiceTag, makePersistenceService),
		).pipe(
			Layer.provideMerge(
				Layer.merge(
					database,
					Layer.succeed(PersistenceProjectTag, { projectId: project.slug }),
				),
			),
		);
	});
}
