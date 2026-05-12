import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";

export class ReadQueryEffectError extends Data.TaggedError(
	"ReadQueryEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface ReadQueryEffect {
	readonly getToolContent: (
		toolId: string,
	) => Effect.Effect<string | undefined, ReadQueryEffectError | SqlError>;
}

export class ReadQueryEffectTag extends Context.Tag("ReadQueryEffect")<
	ReadQueryEffectTag,
	ReadQueryEffect
>() {}

export const makeReadQueryEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	const getToolContent = (
		toolId: string,
	): Effect.Effect<string | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ content: string }>`
				SELECT content FROM tool_content WHERE tool_id = ${toolId}`;
			return rows[0]?.content;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getToolContent",
							cause: e,
						}),
			),
		);

	return { getToolContent } satisfies ReadQueryEffect;
});
