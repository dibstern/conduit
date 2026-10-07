import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect, Schema } from "effect";

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

export interface NativeThread {
	readonly configDir?: string | undefined;
	readonly resumeSessionId: string;
	readonly firstSequence: number;
	readonly deliveredThrough: number;
}

const NativeThreadSchema = Schema.parseJson(
	Schema.Struct({
		configDir: Schema.optional(Schema.String),
		resumeSessionId: Schema.String,
		firstSequence: Schema.NonNegativeInt,
		deliveredThrough: Schema.NonNegativeInt,
	}),
);

const NATIVE_THREAD_PREFIX = "nativeThread:";

export const nativeThreadKey = (instanceId: string): string =>
	`${NATIVE_THREAD_PREFIX}${instanceId}`;

export interface ProviderStateEffect {
	readonly nativeThread: (
		sessionId: string,
		instanceId: string,
	) => Effect.Effect<
		NativeThread | undefined,
		ProviderStateEffectError | SqlError
	>;

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

	const nativeThread = (sessionId: string, instanceId: string) =>
		Effect.gen(function* () {
			const state = yield* getState(sessionId);
			const stored = state[nativeThreadKey(instanceId)];
			if (stored !== undefined) {
				return yield* Schema.decodeUnknown(NativeThreadSchema)(stored);
			}
			// Once per-account receipts exist, legacy keys cannot prove delivery to
			// an account with no receipt, especially after a provider change.
			if (
				Object.keys(state).some((key) => key.startsWith(NATIVE_THREAD_PREFIX))
			)
				return undefined;
			// Legacy keys belong to the account before its first switch, otherwise
			// the active binding or the session's projected provider.
			const [owner] = yield* sql<{ provider: string | null }>`
				SELECT COALESCE(
					(SELECT json_extract(data, '$.oldProvider') FROM events
						WHERE session_id = ${sessionId} AND type = 'session.provider_changed'
						ORDER BY sequence ASC LIMIT 1),
					(SELECT provider FROM session_providers
						WHERE session_id = ${sessionId} AND status = 'active'
						ORDER BY activated_at DESC, id DESC LIMIT 1),
					(SELECT provider FROM sessions WHERE id = ${sessionId})
				) AS provider`;
			if (owner?.provider !== instanceId) return undefined;
			const resumeSessionId = state["resumeSessionId"];
			if (!resumeSessionId) return undefined;
			const [bounds] = yield* sql<{
				firstSequence: number;
				deliveredThrough: number;
			}>`SELECT COALESCE(MIN(sequence), 0) AS firstSequence,
				COALESCE(MAX(sequence), 0) AS deliveredThrough
				FROM events WHERE session_id = ${sessionId}`;
			return {
				...(state["claudeConfigDir"] !== undefined
					? { configDir: state["claudeConfigDir"] }
					: {}),
				resumeSessionId,
				firstSequence: bounds?.firstSequence ?? 0,
				deliveredThrough: bounds?.deliveredThrough ?? 0,
			} satisfies NativeThread;
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ProviderStateEffectError({ operation: "nativeThread", cause }),
			),
		);

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
				Effect.gen(function* () {
					for (const update of updates) {
						let value = update.value;
						if (update.key.startsWith(NATIVE_THREAD_PREFIX)) {
							const thread =
								yield* Schema.decodeUnknown(NativeThreadSchema)(value);
							const instanceId = update.key.slice(NATIVE_THREAD_PREFIX.length);
							const [bounds] = yield* sql<{
								firstSequence: number;
								deliveredThrough: number;
							}>`SELECT COALESCE(
								(SELECT MAX(sequence) FROM events
									WHERE session_id = ${sessionId} AND type = 'session.provider_changed'
										AND json_extract(data, '$.newProvider') = ${instanceId}),
								MIN(sequence), 0) AS firstSequence,
								COALESCE(MAX(sequence), 0) AS deliveredThrough
								FROM events WHERE session_id = ${sessionId}`;
							// The adapter's completion and its SDK cursor share one receipt.
							// Zero marks a new thread before its first persisted receipt.
							// A switched thread begins at its handoff, not the parent's origin.
							value = JSON.stringify({
								...thread,
								firstSequence:
									thread.firstSequence || bounds?.firstSequence || 0,
								deliveredThrough: bounds?.deliveredThrough ?? 0,
							});
						}
						yield* sql`
							INSERT INTO provider_state (session_id, key, value)
							VALUES (${sessionId}, ${update.key}, ${value})
							ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value`;
					}
					if (
						updates.some((update) =>
							update.key.startsWith(NATIVE_THREAD_PREFIX),
						)
					) {
						yield* sql`DELETE FROM provider_state WHERE session_id = ${sessionId}
							AND key IN ('resumeSessionId', 'claudeConfigDir')`;
					}
				}),
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
		nativeThread,
		getState,
		saveUpdates,
		clearState,
	} satisfies ProviderStateEffect;
});
