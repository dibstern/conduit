import { Effect, Schema } from "effect";
import type { StoredEvent } from "../events.js";
import { StoredEventSchema } from "../events.js";

export interface StoredEventRow {
	readonly sequence: number;
	readonly event_id: string;
	readonly session_id: string;
	readonly stream_version: number;
	readonly type: string;
	readonly data: string;
	readonly metadata: string;
	readonly provider: string;
	readonly created_at: number;
}

export const decodeStoredEventRow = <E>(
	row: StoredEventRow,
	mapCause: (cause: unknown) => E,
): Effect.Effect<StoredEvent, E> =>
	Effect.gen(function* () {
		const data = yield* Effect.try({
			try: () => JSON.parse(row.data),
			catch: (cause) => mapCause({ field: "data", cause }),
		});
		const metadata = yield* Effect.try({
			try: () => JSON.parse(row.metadata),
			catch: (cause) => mapCause({ field: "metadata", cause }),
		});

		return yield* Schema.decodeUnknown(StoredEventSchema)({
			sequence: row.sequence,
			eventId: row.event_id,
			sessionId: row.session_id,
			streamVersion: row.stream_version,
			type: row.type,
			data,
			metadata,
			provider: row.provider,
			createdAt: row.created_at,
		}).pipe(Effect.mapError(mapCause));
	});
