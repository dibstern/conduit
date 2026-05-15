// ─── Effect-based Event Store ───���─────────────────────────────────────────
// Migrates event-store.ts from raw SqliteClient to @effect/sql SqlClient.
// All database operations are Effect programs using template literal queries.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect, Schema } from "effect";
import type { CanonicalEvent, StoredEvent } from "../events.js";
import { CanonicalEventSchema } from "../events.js";
import {
	decodeStoredEventRow,
	type StoredEventRow,
} from "./stored-event-row.js";

// ─── Error type ──────���───────────────────────────────────────────────────────

export class EventStoreError extends Data.TaggedError("EventStoreError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

// ─── Constants ────────────────────────────────────��──────────────────────────

const DEFAULT_READ_LIMIT = 1000;

// ─── Service interface ─────────────���─────────────────────────────────────────

export interface EventStoreEffect {
	readonly append: (
		event: CanonicalEvent,
	) => Effect.Effect<StoredEvent, EventStoreError | SqlError>;

	readonly appendBatch: (
		events: readonly CanonicalEvent[],
	) => Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError>;

	readonly readFromSequence: (
		afterSequence: number,
		limit?: number,
	) => Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError>;

	readonly readBySession: (
		sessionId: string,
		fromSequence?: number,
		limit?: number,
	) => Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError>;

	readonly readAllBySession: (
		sessionId: string,
		fromSequence?: number,
	) => Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError>;

	readonly getNextStreamVersion: (
		sessionId: string,
	) => Effect.Effect<number, EventStoreError | SqlError>;
}

// ─── Service Tag ─────────���──────────────────────��────────────────────────────

export class EventStoreEffectTag extends Context.Tag("EventStoreEffect")<
	EventStoreEffectTag,
	EventStoreEffect
>() {}

// ─── Row conversion ───────��──────────────────────────────────────────────────

const decodeEventStoreRow = (
	row: StoredEventRow,
): Effect.Effect<StoredEvent, EventStoreError> =>
	decodeStoredEventRow(
		row,
		(cause) =>
			new EventStoreError({ operation: "decodeStoredEventRow", cause }),
	);

const validateCanonicalEvent = (
	event: CanonicalEvent,
): Effect.Effect<void, EventStoreError> =>
	Schema.decodeUnknown(CanonicalEventSchema)(event).pipe(
		Effect.asVoid,
		Effect.mapError(
			(cause) =>
				new EventStoreError({ operation: "validateCanonicalEvent", cause }),
		),
	);

// ─── Service implementation ───��─────────────────────────���────────────────────

export const makeEventStoreEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	const getNextStreamVersion = (
		sessionId: string,
	): Effect.Effect<number, EventStoreError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				next_version: number | null;
			}>`SELECT MAX(stream_version) + 1 as next_version FROM events WHERE session_id = ${sessionId}`;
			return rows[0]?.next_version ?? 0;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof EventStoreError
					? e
					: new EventStoreError({
							operation: "getNextStreamVersion",
							cause: e,
						}),
			),
		);

	const appendInCurrentTransaction = (
		event: CanonicalEvent,
	): Effect.Effect<StoredEvent, EventStoreError | SqlError> =>
		Effect.gen(function* () {
			yield* validateCanonicalEvent(event);

			const dataJson = JSON.stringify(event.data);
			const metadataJson = JSON.stringify(event.metadata);

			const rows = yield* sql<StoredEventRow>`
				INSERT INTO events (
					event_id, session_id, stream_version, type, data, metadata, provider, created_at
				)
				SELECT
					${event.eventId},
					${event.sessionId},
					COALESCE(MAX(stream_version) + 1, 0),
					${event.type},
					${dataJson},
					${metadataJson},
					${event.provider},
					${event.createdAt}
				FROM events
				WHERE session_id = ${event.sessionId}
				RETURNING
					sequence, event_id, session_id, stream_version,
					type, data, metadata, provider, created_at`;

			const row = rows[0];
			if (!row) {
				return yield* new EventStoreError({
					operation: "append",
					cause: "INSERT RETURNING produced no rows",
				});
			}

			const stored = yield* decodeEventStoreRow(row);
			return stored;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof EventStoreError
					? e
					: new EventStoreError({ operation: "append", cause: e }),
			),
		);

	const append = (
		event: CanonicalEvent,
	): Effect.Effect<StoredEvent, EventStoreError | SqlError> =>
		sql.withTransaction(appendInCurrentTransaction(event));

	const appendBatch = (
		events: readonly CanonicalEvent[],
	): Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError> => {
		if (events.length === 0) return Effect.succeed([]);

		return sql.withTransaction(
			Effect.gen(function* () {
				const results: StoredEvent[] = [];
				for (const event of events) {
					results.push(yield* appendInCurrentTransaction(event));
				}
				return results;
			}),
		);
	};

	const readFromSequence = (
		afterSequence: number,
		limit?: number,
	): Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError> =>
		Effect.gen(function* () {
			const effectiveLimit = limit ?? DEFAULT_READ_LIMIT;
			const rows = yield* sql<StoredEventRow>`
					SELECT sequence, event_id, session_id, stream_version,
						type, data, metadata, provider, created_at
					FROM events
					WHERE sequence > ${afterSequence}
					ORDER BY sequence ASC
					LIMIT ${effectiveLimit}`;
			return yield* Effect.forEach(rows, decodeEventStoreRow);
		}).pipe(
			Effect.mapError((e) =>
				e instanceof EventStoreError
					? e
					: new EventStoreError({ operation: "readFromSequence", cause: e }),
			),
		);

	const readBySession = (
		sessionId: string,
		fromSequence?: number,
		limit?: number,
	): Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError> =>
		Effect.gen(function* () {
			const afterSeq = fromSequence ?? 0;
			if (limit != null) {
				const rows = yield* sql<StoredEventRow>`
						SELECT sequence, event_id, session_id, stream_version,
							type, data, metadata, provider, created_at
						FROM events
						WHERE session_id = ${sessionId} AND sequence > ${afterSeq}
						ORDER BY sequence ASC
						LIMIT ${limit}`;
				return yield* Effect.forEach(rows, decodeEventStoreRow);
			}
			const rows = yield* sql<StoredEventRow>`
					SELECT sequence, event_id, session_id, stream_version,
						type, data, metadata, provider, created_at
					FROM events
					WHERE session_id = ${sessionId} AND sequence > ${afterSeq}
					ORDER BY sequence ASC`;
			return yield* Effect.forEach(rows, decodeEventStoreRow);
		}).pipe(
			Effect.mapError((e) =>
				e instanceof EventStoreError
					? e
					: new EventStoreError({ operation: "readBySession", cause: e }),
			),
		);

	const readAllBySession = (
		sessionId: string,
		fromSequence?: number,
	): Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError> =>
		readBySession(sessionId, fromSequence, undefined);

	return {
		append,
		appendBatch,
		readFromSequence,
		readBySession,
		readAllBySession,
		getNextStreamVersion,
	} satisfies EventStoreEffect;
});
