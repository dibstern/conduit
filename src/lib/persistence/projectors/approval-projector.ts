// src/lib/persistence/projectors/approval-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import {
	assertHandledOrIgnored,
	encodeJson,
	isEventType,
} from "./projector.js";

/**
 * Projects permission and question lifecycle events into the
 * `pending_approvals` read-model table.
 *
 * Handled events:
 * - `permission.asked`    -> INSERT pending permission approval
 * - `permission.resolved` -> UPDATE to resolved with decision
 * - `question.asked`      -> INSERT pending question approval
 * - `question.resolved`   -> UPDATE to resolved with answers as decision
 *
 * `asked` events use `INSERT ... ON CONFLICT (id) DO NOTHING` so replay
 * after a `resolved` event does not reset the row to pending.
 * `resolved` events use guarded `UPDATE ... WHERE id = ?`.
 */
export class ApprovalProjector implements Projector {
	readonly name = "approval";

	readonly handles: readonly CanonicalEventType[] = [
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "permission.asked")) {
			// Use INSERT ... ON CONFLICT DO NOTHING instead of INSERT OR REPLACE.
			// On replay, if a `permission.resolved` has already run, INSERT OR REPLACE
			// would reset the row to `pending` and lose the decision.
			db.execute(
				`INSERT INTO pending_approvals
				 (id, session_id, type, status, tool_name, input, created_at)
				 VALUES (?, ?, 'permission', 'pending', ?, ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.id,
					event.data.sessionId,
					event.data.toolName,
					encodeJson(event.data.input),
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "permission.resolved")) {
			db.execute(
				`UPDATE pending_approvals
				 SET status = 'resolved', decision = ?, resolved_at = ?
				 WHERE id = ?`,
				[event.data.decision, event.createdAt, event.data.id],
			);
			return;
		}

		if (isEventType(event, "question.asked")) {
			// Use INSERT ... ON CONFLICT DO NOTHING (same rationale as permission.asked).
			db.execute(
				`INSERT INTO pending_approvals
				 (id, session_id, type, status, input, created_at)
				 VALUES (?, ?, 'question', 'pending', ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.id,
					event.data.sessionId,
					encodeJson(event.data.questions),
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "question.resolved")) {
			db.execute(
				`UPDATE pending_approvals
				 SET status = 'resolved', decision = ?, resolved_at = ?
				 WHERE id = ?`,
				[encodeJson(event.data.answers), event.createdAt, event.data.id],
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}
}
