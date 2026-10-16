import { statSync } from "node:fs";
import { Reactivity } from "@effect/experimental";
import type { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Effect, Either, Layer, Option } from "effect";
import {
	type PersistenceEffectError,
	PersistenceStore,
} from "../../../persistence/effect/live.js";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import type { StoredProject } from "../../../types.js";
import {
	makePersistenceService,
	makePersistenceServiceLive,
	PersistenceProjectTag,
	PersistenceServiceTag,
} from "../../persistence/Services/persistence-service.js";

/** Preserve the optional borrowed store across explicitly restricted contexts. */
export const optionalPersistenceStoreContext = Effect.suspend(() =>
	Effect.serviceOption(PersistenceStore),
).pipe(
	Effect.map((store) =>
		Option.isSome(store)
			? Context.make(PersistenceStore, store.value)
			: Context.empty(),
	),
);

type ProjectReadOptions = {
	readonly mapPathError?: (cause: unknown) => unknown;
};

/** Shared readers bind a project without preparing or stamping the daemon store. */
export function projectReadDatabase(
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
	options: ProjectReadOptions & { readonly prepare: true },
): Effect.Effect<
	Option.Option<
		Layer.Layer<
			SqlClient.SqlClient | PersistenceServiceTag,
			PersistenceEffectError
		>
	>,
	unknown
>;
export function projectReadDatabase(
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
	options?: ProjectReadOptions & { readonly prepare?: false },
): Effect.Effect<
	Option.Option<Layer.Layer<SqlClient.SqlClient, PersistenceEffectError>>,
	unknown
>;
export function projectReadDatabase(
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
	options: ProjectReadOptions & { readonly prepare?: boolean } = {},
): Effect.Effect<
	| Option.Option<Layer.Layer<SqlClient.SqlClient, PersistenceEffectError>>
	| Option.Option<
			Layer.Layer<
				SqlClient.SqlClient | PersistenceServiceTag,
				PersistenceEffectError
			>
	  >,
	unknown
> {
	return Effect.gen(function* () {
		const store = yield* Effect.serviceOption(PersistenceStore);
		const database: Option.Option<
			Layer.Layer<SqlClient.SqlClient, PersistenceEffectError>
		> = yield* Option.isSome(store)
			? Effect.succeed(Option.some(Layer.succeedContext(store.value)))
			: Effect.gen(function* () {
					const filename = projectEventsDbPath({ configDir, ...project });
					const databaseStat = yield* Effect.either(
						Effect.try({
							try: () => statSync(filename),
							catch: (cause) => cause,
						}),
					);
					if (Either.isLeft(databaseStat)) {
						const cause = databaseStat.left;
						if (
							typeof cause === "object" &&
							cause !== null &&
							"code" in cause &&
							cause.code === "ENOENT"
						)
							return Option.none();
						return yield* Effect.fail(options.mapPathError?.(cause) ?? cause);
					}
					return Option.some(
						SqliteNode.layer({
							filename,
							...(options.prepare ? {} : { readonly: true }),
							disableWAL: true,
						}).pipe(Layer.provide(Reactivity.layer)),
					);
				});
		if (Option.isNone(database) || !options.prepare) return database;
		const projectLayer = Layer.succeed(PersistenceProjectTag, {
			projectId: project.slug,
		});
		const bindProject = Layer.fresh(
			Option.isSome(store)
				? Layer.effect(PersistenceServiceTag, makePersistenceService)
				: makePersistenceServiceLive,
		);
		return Option.some(
			bindProject.pipe(
				Layer.provideMerge(Layer.merge(database.value, projectLayer)),
			),
		);
	});
}
