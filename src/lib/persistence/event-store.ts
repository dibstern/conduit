import { PersistenceError } from "./errors.js";
import type {
	CanonicalEvent,
	CanonicalEventType,
	StoredEvent,
} from "./events.js";
import { CANONICAL_EVENT_TYPES, validateEventPayload } from "./events.js";
import type { SqliteClient } from "./sqlite-client.js";

interface EventRow {
	sequence: number;
	event_id: string;
	session_id: string;
	stream_version: number;
	type: string;
	data: string;
	metadata: string;
	provider: string;
	created_at: number;
}

const DEFAULT_READ_LIMIT = 1000;

export class EventStore {
	private readonly db: SqliteClient;
	private readonly versionCache = new Map<string, number>();

	constructor(db: SqliteClient) {
		this.db = db;
	}

	resetVersionCache(): void {
		this.versionCache.clear();
	}

	append(event: CanonicalEvent): StoredEvent {
		validateEventPayload(event);

		let nextVersion = this.versionCache.get(event.sessionId);
		if (nextVersion === undefined) {
			nextVersion = this.getNextStreamVersion(event.sessionId);
		}

		const dataJson = JSON.stringify(event.data);
		const metadataJson = JSON.stringify(event.metadata);

		const rows = this.db.query<EventRow>(
			`INSERT INTO events (
				event_id, session_id, stream_version, type, data, metadata, provider, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING
				sequence, event_id, session_id, stream_version,
				type, data, metadata, provider, created_at`,
			[
				event.eventId,
				event.sessionId,
				nextVersion,
				event.type,
				dataJson,
				metadataJson,
				event.provider,
				event.createdAt,
			],
		);

		const row = rows[0];
		if (!row) {
			throw new PersistenceError(
				"APPEND_FAILED",
				"INSERT RETURNING produced no rows",
				{
					eventId: event.eventId,
					sessionId: event.sessionId,
					type: event.type,
				},
			);
		}

		const stored = this.rowToStoredEvent(row);
		this.versionCache.set(event.sessionId, nextVersion + 1);
		return stored;
	}

	appendBatch(events: readonly CanonicalEvent[]): StoredEvent[] {
		if (events.length === 0) return [];

		return this.db.runInTransaction(() => {
			const results: StoredEvent[] = [];
			for (const event of events) {
				results.push(this.append(event));
			}
			return results;
		});
	}

	readFromSequence(afterSequence: number, limit?: number): StoredEvent[] {
		const effectiveLimit = limit ?? DEFAULT_READ_LIMIT;
		const rows = this.db.query<EventRow>(
			`SELECT sequence, event_id, session_id, stream_version,
				type, data, metadata, provider, created_at
			FROM events
			WHERE sequence > ?
			ORDER BY sequence ASC
			LIMIT ?`,
			[afterSequence, effectiveLimit],
		);
		return rows.map((row) => this.rowToStoredEvent(row));
	}

	readBySession(
		sessionId: string,
		fromSequence?: number,
		limit?: number,
	): StoredEvent[] {
		const afterSeq = fromSequence ?? 0;
		if (limit != null) {
			const rows = this.db.query<EventRow>(
				`SELECT sequence, event_id, session_id, stream_version,
					type, data, metadata, provider, created_at
				FROM events
				WHERE session_id = ? AND sequence > ?
				ORDER BY sequence ASC
				LIMIT ?`,
				[sessionId, afterSeq, limit],
			);
			return rows.map((row) => this.rowToStoredEvent(row));
		}
		const rows = this.db.query<EventRow>(
			`SELECT sequence, event_id, session_id, stream_version,
				type, data, metadata, provider, created_at
			FROM events
			WHERE session_id = ? AND sequence > ?
			ORDER BY sequence ASC`,
			[sessionId, afterSeq],
		);
		return rows.map((row) => this.rowToStoredEvent(row));
	}

	readAllBySession(sessionId: string, fromSequence?: number): StoredEvent[] {
		return this.readBySession(sessionId, fromSequence, undefined);
	}

	getNextStreamVersion(sessionId: string): number {
		const row = this.db.queryOne<{ next_version: number | null }>(
			"SELECT MAX(stream_version) + 1 as next_version FROM events WHERE session_id = ?",
			[sessionId],
		);
		return row?.next_version ?? 0;
	}

	private rowToStoredEvent(row: EventRow): StoredEvent {
		if (!CANONICAL_EVENT_TYPES.includes(row.type as CanonicalEventType)) {
			throw new PersistenceError(
				"UNKNOWN_EVENT_TYPE",
				`Unknown event type in database: ${row.type}`,
				{
					sequence: row.sequence,
					eventId: row.event_id,
					sessionId: row.session_id,
					type: row.type,
				},
			);
		}

		let data: unknown;
		let metadata: unknown;
		try {
			data = JSON.parse(row.data);
		} catch (err) {
			throw new PersistenceError(
				"DESERIALIZATION_FAILED",
				"Failed to parse event data JSON",
				{
					sequence: row.sequence,
					eventId: row.event_id,
					sessionId: row.session_id,
					type: row.type,
					rawData: row.data.slice(0, 200),
					parseError: err instanceof Error ? err.message : String(err),
				},
			);
		}
		try {
			metadata = JSON.parse(row.metadata);
		} catch (err) {
			throw new PersistenceError(
				"DESERIALIZATION_FAILED",
				"Failed to parse event metadata JSON",
				{
					sequence: row.sequence,
					eventId: row.event_id,
					rawMetadata: row.metadata.slice(0, 200),
					parseError: err instanceof Error ? err.message : String(err),
				},
			);
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
}
