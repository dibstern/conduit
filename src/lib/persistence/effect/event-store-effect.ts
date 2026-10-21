// All database operations are Effect programs using @effect/sql template literal queries.

import { Context, Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import type { CanonicalEvent, StoredEvent } from "../events.js";
import { CanonicalEventSchema } from "../events.js";
import {
	decodeStoredEventRow,
	type StoredEventRow,
} from "./stored-event-row.js";

export class EventStoreError extends Data.TaggedError("EventStoreError")<{
	readonly operation: string;
	readonly cause: unknown;
	readonly sessionId?: string;
	readonly projectId?: string;
	readonly ownerProjectId?: string;
}> {}

const DEFAULT_READ_LIMIT = 1000;
// 9 bound values a row stays far below SQLite's 32766-variable limit.
const APPEND_CHUNK_ROWS = 500;

/** OpenCode asks are deduplicated by request id rather than event id. */
const openCodeRequestId = (event: CanonicalEvent): string | undefined =>
	event.provider === "opencode" &&
	event.metadata.source !== "conduit.control-reconciliation" &&
	(event.type === "permission.asked" || event.type === "question.asked")
		? event.data.id
		: undefined;

const isOpenCodeSeed = (event: CanonicalEvent): boolean =>
	event.type === "session.created" &&
	event.provider === "opencode" &&
	event.eventId === `evt_opencode_session_created_${event.sessionId}`;

export interface EventStoreEffect {
	readonly projectId: string;
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

export class EventStoreEffectTag extends Context.Service<
	EventStoreEffectTag,
	EventStoreEffect
>()("EventStoreEffect") {}

const decodeEventStoreRow = (
	row: StoredEventRow,
): Effect.Effect<StoredEvent, EventStoreError> =>
	decodeStoredEventRow(
		row,
		(cause) =>
			new EventStoreError({ operation: "decodeStoredEventRow", cause }),
	);

export const validateCanonicalEvent = (
	event: CanonicalEvent,
): Effect.Effect<void, EventStoreError> =>
	Schema.decodeUnknownEffect(CanonicalEventSchema)(event).pipe(
		Effect.asVoid,
		Effect.mapError(
			(cause) =>
				new EventStoreError({ operation: "validateCanonicalEvent", cause }),
		),
	);

export const makeEventStoreEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* PersistenceProjectTag;
	const assertSessionOwnership = (sessionIds: readonly string[]) =>
		Effect.gen(function* () {
			// Reserve SQLite's writer slot before reading ownership. A deferred
			// read snapshot cannot upgrade after another connection commits.
			yield* sql`UPDATE sessions SET project_id = project_id WHERE 0`;
			for (const sessionId of new Set(sessionIds)) {
				const [session] = yield* sql<{ project_id: string | null }>`
					SELECT project_id FROM sessions WHERE id = ${sessionId}`;
				// An unstamped row (NULL or '') has no owner yet; the provenance stamp claims it.
				if (session?.project_id && session.project_id !== projectId)
					return yield* new EventStoreError({
						operation: "appendOwnership",
						sessionId,
						projectId,
						ownerProjectId: session.project_id,
						cause: `Project ${projectId} cannot append to session ${sessionId} owned by project ${session.project_id}`,
					});
			}
		});

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
	): Effect.Effect<
		{ readonly stored: StoredEvent; readonly duplicateAsk: boolean },
		EventStoreError | SqlError
	> =>
		Effect.gen(function* () {
			yield* validateCanonicalEvent(event);

			const dataJson = JSON.stringify(event.data);
			const metadataJson = JSON.stringify(event.metadata);
			const requestId = openCodeRequestId(event);
			const isOpenCodeSessionSeed = isOpenCodeSeed(event);

			// Check request identity in the first write statement so independent
			// SQLite connections cannot race a read snapshot into a write upgrade.
			// MAX stays in its own subquery: as an aggregate under HAVING it loses
			// SQLite's index lookup and scans the whole session on every append.
			const rows = yield* sql<StoredEventRow>`
				${sql.literal(isOpenCodeSessionSeed ? "INSERT OR IGNORE" : "INSERT")} INTO events (
					project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at
				)
				SELECT
					${projectId},
					${event.eventId},
					${event.sessionId},
					(SELECT COALESCE(MAX(stream_version) + 1, 0) FROM events WHERE session_id = ${event.sessionId}),
					${event.type},
					${dataJson},
					${metadataJson},
					${event.provider},
					${event.createdAt}
				WHERE ${requestId ?? null} IS NULL OR NOT EXISTS (
					SELECT 1 FROM events
					WHERE session_id = ${event.sessionId}
						AND provider = ${event.provider} AND type = ${event.type}
						AND json_extract(data, '$.id') = ${requestId ?? null}
				)
				RETURNING
					project_id, sequence, event_id, session_id, stream_version,
					type, data, metadata, provider, created_at`;

			let row = rows[0];
			const duplicateAsk = !row && requestId !== undefined;
			if (!row && isOpenCodeSessionSeed) {
				// Retry projection with the durable seed after a failed projection.
				const existingRows = yield* sql<StoredEventRow>`
					SELECT project_id, sequence, event_id, session_id, stream_version,
						type, data, metadata, provider, created_at
					FROM events
					WHERE event_id = ${event.eventId}`;
				row = existingRows[0];
			}
			if (duplicateAsk) {
				// Return the original event even when it predates request deduplication.
				const existingRows = yield* sql<StoredEventRow>`
					SELECT project_id, sequence, event_id, session_id, stream_version,
						type, data, metadata, provider, created_at
					FROM events
					WHERE session_id = ${event.sessionId}
						AND provider = ${event.provider} AND type = ${event.type}
						AND json_extract(data, '$.id') = ${requestId}
					ORDER BY sequence LIMIT 1`;
				row = existingRows[0];
			}
			if (!row) {
				return yield* new EventStoreError({
					operation: "append",
					cause: "INSERT RETURNING produced no rows",
				});
			}

			const stored = yield* decodeEventStoreRow(row);
			return { stored, duplicateAsk };
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
		sql.withTransaction(
			Effect.gen(function* () {
				yield* assertSessionOwnership([event.sessionId]);
				return (yield* appendInCurrentTransaction(event)).stored;
			}),
		);

	const appendBatch = (
		events: readonly CanonicalEvent[],
	): Effect.Effect<readonly StoredEvent[], EventStoreError | SqlError> => {
		if (events.length === 0) return Effect.succeed([]);

		return sql.withTransaction(
			Effect.gen(function* () {
				yield* assertSessionOwnership(events.map((event) => event.sessionId));
				const results: StoredEvent[] = [];
				// Plain events are inserted many rows per statement: inside a caller's
				// transaction each statement runs in a savepoint, where a one-row
				// insert costs several times the row itself. The writer slot is held,
				// so these versions cannot race another connection.
				const nextVersions = new Map<string, number>();
				let pending: CanonicalEvent[] = [];
				const flush = Effect.gen(function* () {
					if (pending.length === 0) return;
					const chunk = pending;
					pending = [];
					const rows = [];
					for (const event of chunk) {
						const version =
							nextVersions.get(event.sessionId) ??
							(yield* getNextStreamVersion(event.sessionId));
						nextVersions.set(event.sessionId, version + 1);
						rows.push({
							project_id: projectId,
							event_id: event.eventId,
							session_id: event.sessionId,
							stream_version: version,
							type: event.type,
							data: JSON.stringify(event.data),
							metadata: JSON.stringify(event.metadata),
							provider: event.provider,
							created_at: event.createdAt,
						});
					}
					const inserted = yield* sql<StoredEventRow>`
						INSERT INTO events ${sql.insert(rows)}
						RETURNING
							project_id, sequence, event_id, session_id, stream_version,
							type, data, metadata, provider, created_at`.pipe(
						Effect.mapError(
							(cause) => new EventStoreError({ operation: "append", cause }),
						),
					);
					// RETURNING order is unspecified; sequence follows VALUES order.
					for (const row of [...inserted].sort(
						(a, b) => a.sequence - b.sequence,
					))
						results.push(yield* decodeEventStoreRow(row));
				});
				for (const event of events) {
					// Re-projecting a child seed would reset a renamed title. OpenCode
					// seeds still return their stored row for projection recovery.
					const skipIfStored =
						event.type === "message.snapshot" ||
						(event.type === "session.created" &&
							event.provider === "claude" &&
							event.data.parentId !== undefined) ||
						(event.type === "session.compaction" &&
							event.provider === "opencode" &&
							event.data.state === "completed");
					if (
						!skipIfStored &&
						openCodeRequestId(event) === undefined &&
						!isOpenCodeSeed(event)
					) {
						yield* validateCanonicalEvent(event);
						pending.push(event);
						if (pending.length === APPEND_CHUNK_ROWS) yield* flush;
						continue;
					}
					yield* flush;
					if (skipIfStored) {
						const existing = yield* sql<{ sequence: number }>`
							SELECT sequence FROM events WHERE event_id = ${event.eventId}`;
						if (existing.length > 0) continue;
					}
					const { stored, duplicateAsk } =
						yield* appendInCurrentTransaction(event);
					nextVersions.delete(event.sessionId);
					// Recovery must not project an already stored ask again.
					if (!duplicateAsk) results.push(stored);
				}
				yield* flush;
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
					SELECT project_id, sequence, event_id, session_id, stream_version,
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
						SELECT project_id, sequence, event_id, session_id, stream_version,
							type, data, metadata, provider, created_at
						FROM events
						WHERE session_id = ${sessionId} AND sequence > ${afterSeq}
						ORDER BY sequence ASC
						LIMIT ${limit}`;
				return yield* Effect.forEach(rows, decodeEventStoreRow);
			}
			const rows = yield* sql<StoredEventRow>`
					SELECT project_id, sequence, event_id, session_id, stream_version,
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
		projectId,
		append,
		appendBatch,
		readFromSequence,
		readBySession,
		readAllBySession,
		getNextStreamVersion,
	} satisfies EventStoreEffect;
});
