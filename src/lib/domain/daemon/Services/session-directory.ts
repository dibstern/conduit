import { existsSync } from "node:fs";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Effect, Layer, Option } from "effect";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import type { StoredProject } from "../../../types.js";

/** Session identity is global; provider session ids deliberately are not indexed. */
export class SessionDirectory extends Context.Tag("SessionDirectory")<
	SessionDirectory,
	{
		readonly projectOf: (
			sessionId: string,
		) => Effect.Effect<Option.Option<string>>;
		readonly record: (
			projectSlug: string,
			sessionIds: readonly string[],
		) => Effect.Effect<void>;
		readonly replaceProject: (
			projectSlug: string,
			sessionIds: readonly string[],
		) => Effect.Effect<void>;
		readonly remove: (
			projectSlug: string,
			sessionIds: readonly string[],
		) => Effect.Effect<void>;
		readonly removeProject: (projectSlug: string) => Effect.Effect<void>;
	}
>() {}

/** Per-store adapter. Missing stores are new projects, with no sessions yet. */
export const indexProjectSessions = (
	configDir: string,
	project: Pick<StoredProject, "slug" | "folders">,
) =>
	Effect.gen(function* () {
		const directory = yield* SessionDirectory;
		const filename = projectEventsDbPath({ configDir, ...project });
		if (!existsSync(filename)) return;
		const sessions = yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* sql<{ readonly id: string }>`SELECT id FROM sessions`;
		}).pipe(
			Effect.provide(
				SqliteNode.layer({ filename, readonly: true, disableWAL: true }).pipe(
					Layer.provide(Reactivity.layer),
				),
			),
		);
		yield* directory.replaceProject(
			project.slug,
			sessions.map(({ id }) => id),
		);
	});

export const makeSessionDirectoryLive = (
	configDir: string,
	projects: readonly Pick<StoredProject, "slug" | "folders">[],
) =>
	Layer.effect(
		SessionDirectory,
		Effect.gen(function* () {
			const owners = new Map<string, string>();
			const directory: SessionDirectory["Type"] = {
				projectOf: (sessionId) =>
					Effect.sync(() => Option.fromNullable(owners.get(sessionId))),
				record: (projectSlug, sessionIds) =>
					Effect.sync(() => {
						for (const id of sessionIds) owners.set(id, projectSlug);
					}),
				replaceProject: (projectSlug, sessionIds) =>
					Effect.sync(() => {
						for (const [id, owner] of owners)
							if (owner === projectSlug) owners.delete(id);
						for (const id of sessionIds) owners.set(id, projectSlug);
					}),
				remove: (projectSlug, sessionIds) =>
					Effect.sync(() => {
						for (const id of sessionIds)
							if (owners.get(id) === projectSlug) owners.delete(id);
					}),
				removeProject: (projectSlug) =>
					Effect.sync(() => {
						for (const [id, owner] of owners)
							if (owner === projectSlug) owners.delete(id);
					}),
			};
			for (const project of projects) {
				yield* indexProjectSessions(configDir, project).pipe(
					Effect.provideService(SessionDirectory, directory),
					Effect.catchAll((cause) =>
						Effect.logWarning(
							"Session directory could not read project history",
							{ projectSlug: project.slug, cause },
						),
					),
				);
			}
			return directory;
		}),
	);
