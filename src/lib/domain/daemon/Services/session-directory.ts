import { existsSync } from "node:fs";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Data, Effect, Layer, Option } from "effect";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import type { StoredProject } from "../../../types.js";

export class AmbiguousSession extends Data.TaggedError("AmbiguousSession")<{
	readonly sessionId: string;
	readonly projectSlugs: readonly string[];
}> {
	get message(): string {
		return "OpenCode session belongs to more than one Conduit project";
	}
}

/** Resolve stored session ids, including OpenCode ids adopted by multiple projects. */
export class SessionDirectory extends Context.Tag("SessionDirectory")<
	SessionDirectory,
	{
		readonly projectOf: (
			sessionId: string,
		) => Effect.Effect<Option.Option<string>, AmbiguousSession>;
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
			const owners = new Map<string, Set<string>>();
			const record = (projectSlug: string, sessionIds: readonly string[]) => {
				for (const id of sessionIds) {
					const projects = owners.get(id);
					if (projects) projects.add(projectSlug);
					else owners.set(id, new Set([projectSlug]));
				}
			};
			const remove = (projectSlug: string, sessionIds: Iterable<string>) => {
				for (const id of sessionIds) {
					const projects = owners.get(id);
					if (!projects) continue;
					projects.delete(projectSlug);
					if (projects.size === 0) owners.delete(id);
				}
			};
			const directory: SessionDirectory["Type"] = {
				projectOf: (sessionId) =>
					Effect.suspend(() => {
						const projects = owners.get(sessionId);
						if (!projects) return Effect.succeed(Option.none());
						if (projects.size > 1)
							return Effect.fail(
								new AmbiguousSession({
									sessionId,
									projectSlugs: [...projects].sort(),
								}),
							);
						return Effect.succeed(Option.fromIterable(projects));
					}),
				record: (projectSlug, sessionIds) =>
					Effect.sync(() => record(projectSlug, sessionIds)),
				replaceProject: (projectSlug, sessionIds) =>
					Effect.sync(() => {
						remove(projectSlug, owners.keys());
						record(projectSlug, sessionIds);
					}),
				remove: (projectSlug, sessionIds) =>
					Effect.sync(() => remove(projectSlug, sessionIds)),
				removeProject: (projectSlug) =>
					Effect.sync(() => remove(projectSlug, owners.keys())),
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
