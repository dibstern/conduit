// src/lib/session/session-status-sqlite.ts
// ─── Session Status SQLite Reader ───────────────────────────────────────────
// Reads session status from the projected `sessions.status` column instead
// of polling the OpenCode REST API. Used when the `sessionStatus` read flag
// is enabled (Phase 4d).
//
// This replaces the raw status fetch in SessionStatusPoller. The poller's
// augmentation logic (subagent propagation, message-activity) still runs
// on top of the raw statuses returned by this reader.

import type { SessionStatus } from "../instance/opencode-client.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";

export class SessionStatusSqliteReader {
	constructor(private readonly readQuery: ReadQueryService) {}

	/**
	 * Get statuses for all sessions in the same format as
	 * `OpenCodeClient.getSessionStatuses()`.
	 *
	 * Note: retry status objects from SQLite will lack the `attempt`,
	 * `message`, and `next` fields present on the REST variant. Consumers
	 * that only check `type === "busy" || type === "retry"` (the common case)
	 * are unaffected.
	 */
	getSessionStatuses(): Record<string, SessionStatus> {
		const raw = this.readQuery.getAllSessionStatuses();
		const result: Record<string, SessionStatus> = {};
		for (const [id, status] of Object.entries(raw)) {
			result[id] = { type: status } as SessionStatus;
		}
		return result;
	}

	/** Check if a specific session is currently processing (busy or retry). */
	isProcessing(sessionId: string): boolean {
		const status = this.readQuery.getSessionStatus(sessionId);
		return status === "busy" || status === "retry";
	}
}
