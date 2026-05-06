// ─── Effect-based Event Store ───���─────────────────────────────────────────
// Migrates event-store.ts from raw SqliteClient to @effect/sql SqlClient.
// All database operations are Effect programs using template literal queries.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type {
	CanonicalEvent,
	CanonicalEventType,
	StoredEvent,
} from "../events.js";
import { CANONICAL_EVENT_TYPES, validateEventPayload } from "../events.js";

// ─── Error type ──────���───────────────────────────────────────────────────────

export class EventStoreError extends Data.TaggedError("EventStoreError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

// ─── Row shape ──────────��───────────────────────────────��────────────────────

interface EventRow {
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

	readonly resetVersionCache: () => Effect.Effect<void>;
}

// ─── Service Tag ─────────���──────────────────────��────────────────────────────

export class EventStoreEffectTag extends Context.Tag("EventStoreEffect")<
	EventStoreEffectTag,
	EventStoreEffect
>() {}

// ─── Row conversion ───────��──────────────────────────────────────────────────

function rowToStoredEvent(row: EventRow): StoredEvent {
	if (!CANONICAL_EVENT_TYPES.includes(row.type as CanonicalEventType)) {
		throw new EventStoreError({
			operation: "rowToStoredEvent",
			cause: `Unknown event type in database: ${row.type}`,
		});
	}

	let data: unknown;
	let metadata: unknown;
	try {
		data = JSON.parse(row.data);
	} catch (err) {
		throw new EventStoreError({
			operation: "rowToStoredEvent",
			cause: `Failed to parse event data JSON: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
	try {
		metadata = JSON.parse(row.metadata);
	} catch (err) {
		throw new EventStoreError({
			operation: "rowToStoredEvent",
			cause: `Failed to parse event metadata JSON: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	return {
		sequence: row.sequence,
		eventId: row.event_id,
		sessionId: row.session_id,
		streamVersion: row.stream_version,
		type: row.type,
		data,
		metadata,
		provider: row.provider,
		createdAt: row.created_at,
	} as StoredEvent;
}

// ─── Service implementation ───��─────────────────────────���────────────────────

export const makeEventStoreEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const versionCache = new Map<string, number>();

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

	const append = (
		event: CanonicalEvent,
	): Effect.Effect<StoredEvent, EventStoreError | SqlError> =>
		Effect.gen(function* () {
			validateEventPayload(event);

			let nextVersion = versionCache.get(event.sessionId);
			if (nextVersion === undefined) {
				nextVersion = yield* getNextStreamVersion(event.sessionId);
			}

			const dataJson = JSON.stringify(event.data);
			const metadataJson = JSON.stringify(event.metadata);

			const rows = yield* sql<EventRow>`
				INSERT INTO events (
					event_id, session_id, stream_version, type, data, metadata, provider, created_at
				) VALUES (
					${event.eventId}, ${event.sessionId}, ${nextVersion}, ${event.type},
					${dataJson}, ${metadataJson}, ${event.provider}, ${event.createdAt}
				)
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

			const stored = rowToStoredEvent(row);
			versionCache.set(event.sessionId, nextVersion + 1);
			return stored;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof EventStoreError
					? e
					: new EventStoreError({ operation: "append", cause: e }),
			),
		);

	const appendBatch = (
		events: readonly CanonicalEvent[],
	): Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError> => {
		if (events.length === 0) return Effect.succeed([]);

		return sql.withTransaction(
			Effect.gen(function* () {
				const results: StoredEvent[] = [];
				for (const event of events) {
					results.push(yield* append(event));
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
			const rows = yield* sql<EventRow>`
				SELECT sequence, event_id, session_id, stream_version,
					type, data, metadata, provider, created_at
				FROM events
				WHERE sequence > ${afterSequence}
				ORDER BY sequence ASC
				LIMIT ${effectiveLimit}`;
			return rows.map((row) => rowToStoredEvent(row));
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
				const rows = yield* sql<EventRow>`
					SELECT sequence, event_id, session_id, stream_version,
						type, data, metadata, provider, created_at
					FROM events
					WHERE session_id = ${sessionId} AND sequence > ${afterSeq}
					ORDER BY sequence ASC
					LIMIT ${limit}`;
				return rows.map((row) => rowToStoredEvent(row));
			}
			const rows = yield* sql<EventRow>`
				SELECT sequence, event_id, session_id, stream_version,
					type, data, metadata, provider, created_at
				FROM events
				WHERE session_id = ${sessionId} AND sequence > ${afterSeq}
				ORDER BY sequence ASC`;
			return rows.map((row) => rowToStoredEvent(row));
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

	const resetVersionCache = (): Effect.Effect<void> =>
		Effect.sync(() => {
			versionCache.clear();
		});

	return {
		append,
		appendBatch,
		readFromSequence,
		readBySession,
		readAllBySession,
		getNextStreamVersion,
		resetVersionCache,
	} satisfies EventStoreEffect;
});
