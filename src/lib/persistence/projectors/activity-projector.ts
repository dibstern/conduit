// src/lib/persistence/projectors/activity-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import {
	assertHandledOrIgnored,
	encodeJson,
	isEventType,
} from "./projector.js";

/**
 * Projects tool, permission, question, and error events into the
 * `activities` timeline table.
 *
 * Every handled event creates one new activity row. Activities are
 * append-only — they are never updated. Each row records:
 *
 * - `tone`: category grouping (tool / approval / info / error)
 * - `kind`: the canonical event type that produced this activity
 * - `summary`: short human-readable label for the UI
 * - `payload`: full event data as JSON for detail views
 * - `sequence`: the event's store sequence for ordering and dedup
 *
 * Idempotency: uses a deterministic ID derived from the event's
 * `sessionId`, `sequence`, and `kind`:
 * `${event.sessionId}:${event.sequence}:${kind}`. This ensures that
 * replaying the same event never creates duplicate activity rows.
 * The `INSERT OR IGNORE` on the primary key handles the dedup.
 */
export class ActivityProjector implements Projector {
	readonly name = "activity";

	readonly handles: readonly CanonicalEventType[] = [
		"tool.started",
		"tool.running",
		"tool.completed",
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
		"turn.error",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "tool.started")) {
			this.insert(
				db,
				event,
				"tool",
				"tool.started",
				event.data.toolName,
				event.data,
			);
			return;
		}

		if (isEventType(event, "tool.running")) {
			this.insert(
				db,
				event,
				"tool",
				"tool.running",
				event.data.partId,
				event.data,
			);
			return;
		}

		if (isEventType(event, "tool.completed")) {
			const summary = `${event.data.partId} (${event.data.duration}ms)`;
			this.insert(db, event, "tool", "tool.completed", summary, event.data);
			return;
		}

		if (isEventType(event, "permission.asked")) {
			this.insert(
				db,
				event,
				"approval",
				"permission.asked",
				event.data.toolName,
				event.data,
			);
			return;
		}

		if (isEventType(event, "permission.resolved")) {
			this.insert(
				db,
				event,
				"approval",
				"permission.resolved",
				event.data.decision,
				event.data,
			);
			return;
		}

		if (isEventType(event, "question.asked")) {
			this.insert(
				db,
				event,
				"info",
				"question.asked",
				"Question asked",
				event.data,
			);
			return;
		}

		if (isEventType(event, "question.resolved")) {
			this.insert(
				db,
				event,
				"info",
				"question.resolved",
				"Question answered",
				event.data,
			);
			return;
		}

		if (isEventType(event, "turn.error")) {
			this.insert(
				db,
				event,
				"error",
				"turn.error",
				event.data.error,
				event.data,
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}

	private insert(
		db: SqliteClient,
		event: StoredEvent,
		tone: string,
		kind: string,
		summary: string,
		payload: unknown,
	): void {
		// Deterministic ID: sessionId + sequence + kind ensures replay
		// idempotency. `INSERT OR IGNORE` skips if the row already exists.
		const id = `${event.sessionId}:${event.sequence}:${kind}`;
		db.execute(
			`INSERT OR IGNORE INTO activities
			 (id, session_id, tone, kind, summary, payload, sequence, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				event.sessionId,
				tone,
				kind,
				summary,
				encodeJson(payload),
				event.sequence,
				event.createdAt,
			],
		);
	}
}
