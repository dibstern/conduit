import { Context, Data, Effect, HashMap, Layer, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { ProjectRegistryTag } from "./project-registry-service.js";

export class SessionDirectoryReadError extends Data.TaggedError(
	"SessionDirectoryReadError",
)<{
	readonly sessionId: string;
	readonly cause: unknown;
}> {
	get message(): string {
		return `Could not read session owner: ${this.sessionId}`;
	}
}

/** Resolve stored session ids to their registered project owner. */
export class SessionDirectory extends Context.Tag("SessionDirectory")<
	SessionDirectory,
	{
		readonly projectOf: (
			sessionId: string,
		) => Effect.Effect<Option.Option<string>, SessionDirectoryReadError>;
	}
>() {}

/** Read ownership at lookup time; current registration controls visibility. */
export const makeSharedSessionDirectoryLive = Layer.effect(
	SessionDirectory,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const registry = yield* ProjectRegistryTag;
		return {
			projectOf: (sessionId: string) =>
				Effect.gen(function* () {
					const rows = yield* sql<{ project_id: string | null }>`
						SELECT project_id FROM sessions WHERE id = ${sessionId}`.pipe(
						Effect.mapError(
							(cause) => new SessionDirectoryReadError({ sessionId, cause }),
						),
					);
					const owner = rows[0]?.project_id;
					const projects = yield* Ref.get(registry);
					return owner && HashMap.has(projects, owner)
						? Option.some(owner)
						: Option.none();
				}),
		};
	}),
);
