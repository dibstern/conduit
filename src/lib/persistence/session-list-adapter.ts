// src/lib/persistence/session-list-adapter.ts
// ─── Session List Adapter ────────────────────────────────────────────────────
// Converts SQLite SessionRow[] → SessionInfo[] for the frontend.

import type { SessionInfo } from "../shared-types.js";
import type { SessionRow } from "./read-query-service.js";

interface SessionStatus {
	type: string;
}

export interface SessionListAdapterOptions {
	statuses?: Record<string, SessionStatus>;
	pendingQuestionCounts?: ReadonlyMap<string, number>;
}

/**
 * Convert SQLite session rows to the SessionInfo format expected by the frontend.
 * Rows should already be sorted by the query (updated_at DESC).
 */
export function sessionRowsToSessionInfoList(
	rows: SessionRow[],
	opts?: SessionListAdapterOptions,
): SessionInfo[] {
	return rows.map((row) => {
		const info: SessionInfo = {
			id: row.id,
			title: row.title,
			updatedAt: row.updated_at,
			messageCount: 0,
		};

		if (row.parent_id) {
			info.parentID = row.parent_id;
		}
		if (row.fork_point_event) {
			info.forkMessageId = row.fork_point_event;
		}

		if (opts?.statuses) {
			const status = opts.statuses[row.id];
			if (status && (status.type === "busy" || status.type === "retry")) {
				info.processing = true;
			}
		}

		const qCount = opts?.pendingQuestionCounts?.get(row.id);
		if (qCount != null && qCount > 0) {
			info.pendingQuestionCount = qCount;
		}

		return info;
	});
}
