// src/lib/persistence/session-list-adapter.ts
// ─── Session List Adapter ────────────────────────────────────────────────────
// Converts SQLite SessionRow[] → SessionInfo[] for the frontend.

import type { ForkEntry } from "../daemon/fork-metadata.js";
import type { SessionAttention, SessionInfo } from "../shared-types.js";
import type {
	PendingApprovalCountRow,
	SessionRow,
} from "./read-query-service.js";

interface SessionStatus {
	type: string;
}

/** The two attention counts a session list needs, split out of one query. */
export interface PendingApprovalCounts {
	questions: ReadonlyMap<string, number>;
	permissions: ReadonlyMap<string, number>;
}

/**
 * Fan the grouped `pending_approvals` rows out into one map per type.
 *
 * Shared because both the warm per-project listing and the cold cross-project
 * read consume the same query, and a divergence between two copies of this
 * would show up as a row that claims the wrong kind of attention.
 */
export function pendingApprovalCountsByType(
	rows: readonly PendingApprovalCountRow[],
): PendingApprovalCounts {
	const questions = new Map<string, number>();
	const permissions = new Map<string, number>();
	for (const row of rows) {
		const target = row.type === "question" ? questions : permissions;
		target.set(row.session_id, row.pending_count);
	}
	return { questions, permissions };
}

export interface SessionListAdapterOptions {
	statuses?: Record<string, SessionStatus>;
	pendingQuestionCounts?: ReadonlyMap<string, number>;
	pendingPermissionCounts?: ReadonlyMap<string, number>;
	forkMeta?: ReadonlyMap<string, ForkEntry>;
}

export function deriveSessionAttention(input: {
	pendingQuestionCount: number | undefined;
	pendingPermissionCount: number | undefined;
	lastTurnErrorAt: number | null;
	liveStatus: SessionStatus | undefined;
	projectedStatus: string;
	unread: boolean;
}): SessionAttention {
	if ((input.pendingPermissionCount ?? 0) > 0) return "needs-approval";
	if ((input.pendingQuestionCount ?? 0) > 0) return "needs-reply";
	if (input.lastTurnErrorAt != null) return "error";

	// Cold daemon-wide reads have no live status, so the projected column is the
	// only working signal. A relay killed mid-turn can leave it busy until another
	// event moves it; conduit-test-vik1.12 owns repairing that stale signal.
	const status = input.liveStatus?.type ?? input.projectedStatus;
	if (status === "busy" || status === "retry") return "working";
	if (input.unread) return "done-unread";
	return "idle";
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

		const forkEntry = opts?.forkMeta?.get(row.id);
		const parentID = row.parent_id ?? forkEntry?.parentID;
		const forkMessageId = row.fork_point_event ?? forkEntry?.forkMessageId;
		if (parentID) info.parentID = parentID;
		if (forkMessageId) info.forkMessageId = forkMessageId;
		if (forkEntry?.forkPointTimestamp != null) {
			info.forkPointTimestamp = forkEntry.forkPointTimestamp;
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
		const pCount = opts?.pendingPermissionCounts?.get(row.id);
		if (pCount != null && pCount > 0) {
			info.pendingPermissionCount = pCount;
		}

		// Comparing activity to the read timestamp makes new activity re-mark the
		// session unread without writing another event for every message.
		if (
			row.last_message_at != null &&
			(row.read_at == null || row.read_at < row.last_message_at)
		) {
			info.unread = true;
		}

		info.attention = deriveSessionAttention({
			pendingQuestionCount: info.pendingQuestionCount,
			pendingPermissionCount: info.pendingPermissionCount,
			lastTurnErrorAt: row.last_turn_error_at,
			liveStatus: opts?.statuses?.[row.id],
			projectedStatus: row.status,
			unread: info.unread === true,
		});

		return info;
	});
}
