import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";

export class ProviderStateEffectError extends Data.TaggedError(
	"ProviderStateEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface ProviderStateEffectUpdate {
	readonly key: string;
	readonly value: string;
}

export interface ProviderStateEffect {
	readonly getState: (
		sessionId: string,
	) => Effect.Effect<
		Record<string, string>,
		ProviderStateEffectError | SqlError
	>;

	readonly saveUpdates: (
		sessionId: string,
		updates: ReadonlyArray<ProviderStateEffectUpdate>,
	) => Effect.Effect<void, ProviderStateEffectError | SqlError>;

	readonly clearState: (
		sessionId: string,
	) => Effect.Effect<void, ProviderStateEffectError | SqlError>;
}

export class ProviderStateEffectTag extends Context.Tag("ProviderStateEffect")<
	ProviderStateEffectTag,
	ProviderStateEffect
>() {}

export const makeProviderStateEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	const getState = (
		sessionId: string,
	): Effect.Effect<
		Record<string, string>,
		ProviderStateEffectError | SqlError
	> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ key: string; value: string }>`
				SELECT key, value FROM provider_state WHERE session_id = ${sessionId}`;
			const result: Record<string, string> = {};
			for (const row of rows) {
				result[row.key] = row.value;
			}
			return result;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProviderStateEffectError
					? e
					: new ProviderStateEffectError({
							operation: "getState",
							cause: e,
						}),
			),
		);

	const saveUpdates = (
		sessionId: string,
		updates: ReadonlyArray<ProviderStateEffectUpdate>,
	): Effect.Effect<void, ProviderStateEffectError | SqlError> => {
		if (updates.length === 0) return Effect.void;

		return sql
			.withTransaction(
				Effect.forEach(
					updates,
					(update) =>
						sql`
							INSERT INTO provider_state (session_id, key, value)
							VALUES (${sessionId}, ${update.key}, ${update.value})
							ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value`,
					{ discard: true },
				),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ProviderStateEffectError
						? e
						: new ProviderStateEffectError({
								operation: "saveUpdates",
								cause: e,
							}),
				),
			);
	};

	const clearState = (
		sessionId: string,
	): Effect.Effect<void, ProviderStateEffectError | SqlError> =>
		sql`DELETE FROM provider_state WHERE session_id = ${sessionId}`.pipe(
			Effect.asVoid,
			Effect.mapError((e) =>
				e instanceof ProviderStateEffectError
					? e
					: new ProviderStateEffectError({
							operation: "clearState",
							cause: e,
						}),
			),
		);

	return {
		getState,
		saveUpdates,
		clearState,
	} satisfies ProviderStateEffect;
});
