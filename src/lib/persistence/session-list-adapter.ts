// src/lib/persistence/session-list-adapter.ts
// ─── Session List Adapter ────────────────────────────────────────────────────
// Converts SQLite SessionRow[] → SessionInfo[] for the frontend.

import type { ForkEntry } from "../daemon/fork-metadata.js";
import type { SessionAttention, SessionInfo } from "../shared-types.js";
import type {
	PendingApprovalCountRow,
	SessionRow,
} from "./read-model-types.js";

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
	now?: number;
	statuses?: Record<string, SessionStatus>;
	/** Supply full lineage for root list rollups; omit for per-session family state. */
	parentMap?: ReadonlyMap<string, string>;
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

export function deriveSessionSnooze(
	row: Pick<
		SessionRow,
		"snoozed_at" | "snoozed_until" | "woken_at" | "woken_reason" | "read_at"
	>,
	now = Date.now(),
): Pick<SessionInfo, "snoozedAt" | "snoozedUntil" | "wokenAt" | "wokeBecause"> {
	if (row.snoozed_at === null) return {};
	const wakeAt =
		row.woken_at ??
		(row.snoozed_until !== null && row.snoozed_until <= now
			? row.snoozed_until
			: null);
	if (wakeAt !== null) {
		return row.read_at === null || row.read_at < wakeAt
			? { wokenAt: wakeAt, wokeBecause: row.woken_reason ?? "time" }
			: {};
	}
	return {
		snoozedAt: row.snoozed_at,
		...(row.snoozed_until !== null ? { snoozedUntil: row.snoozed_until } : {}),
	};
}

/**
 * Convert SQLite session rows to the SessionInfo format expected by the frontend.
 * Rows should already be sorted by the query (updated_at DESC).
 */
export function sessionRowsToSessionInfoList(
	rows: SessionRow[],
	opts?: SessionListAdapterOptions,
): SessionInfo[] {
	const subtreeState = new Map<
		string,
		{ processing: boolean; questions: number; permissions: number }
	>();
	if (opts?.parentMap) {
		const projectedStatuses = new Map(rows.map((row) => [row.id, row.status]));
		const ids = new Set([
			...rows.map((row) => row.id),
			...opts.parentMap.keys(),
		]);
		for (const id of ids) {
			let rootId = id;
			const visited = new Set<string>();
			while (opts.parentMap.has(rootId) && !visited.has(rootId)) {
				visited.add(rootId);
				rootId = opts.parentMap.get(rootId) ?? rootId;
			}
			const state = subtreeState.get(rootId) ?? {
				processing: false,
				questions: 0,
				permissions: 0,
			};
			const status = opts.statuses?.[id]?.type ?? projectedStatuses.get(id);
			state.processing ||= status === "busy" || status === "retry";
			state.questions += opts.pendingQuestionCounts?.get(id) ?? 0;
			state.permissions += opts.pendingPermissionCounts?.get(id) ?? 0;
			subtreeState.set(rootId, state);
		}
	}
	return rows.map((row) => {
		const info: SessionInfo = {
			id: row.id,
			title: row.title,
			updatedAt: row.updated_at,
			messageCount: 0,
		};

		if (row.settled_at != null) info.settledAt = row.settled_at;
		if (row.pinned_at != null) info.pinnedAt = row.pinned_at;
		Object.assign(info, deriveSessionSnooze(row, opts?.now));

		const forkEntry = opts?.forkMeta?.get(row.id);
		const parentID = row.parent_id ?? forkEntry?.parentID;
		const forkMessageId = row.fork_point_event ?? forkEntry?.forkMessageId;
		if (parentID) info.parentID = parentID;
		if (forkMessageId) info.forkMessageId = forkMessageId;
		if (forkEntry?.forkPointTimestamp != null) {
			info.forkPointTimestamp = forkEntry.forkPointTimestamp;
		}
		const subtree = parentID ? undefined : subtreeState.get(row.id);

		if (opts?.statuses) {
			const status = opts.statuses[row.id];
			if (status && (status.type === "busy" || status.type === "retry")) {
				info.processing = true;
			}
		}
		if (subtree?.processing) {
			info.processing = true;
		}

		const qCount =
			subtree?.questions ?? opts?.pendingQuestionCounts?.get(row.id);
		if (qCount != null && qCount > 0) {
			info.pendingQuestionCount = qCount;
		}
		const pCount =
			subtree?.permissions ?? opts?.pendingPermissionCounts?.get(row.id);
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
			liveStatus:
				subtree && info.processing
					? { type: "busy" }
					: opts?.statuses?.[row.id],
			projectedStatus: row.status,
			unread: info.unread === true,
		});

		return info;
	});
}
