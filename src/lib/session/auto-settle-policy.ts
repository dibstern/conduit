import type { AutoSettleOutlook } from "../contracts/ws-rpc.js";
import type { SessionRow } from "../persistence/read-model-types.js";

export type { AutoSettleOutlook };

export interface AutoSettleTurn {
	readonly state: string;
	readonly requestedAt: number | null;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
}

export interface AutoSettleFacts {
	readonly exists: boolean;
	/** A side thread: only root sessions (Forks included) settle automatically. */
	readonly isChild: boolean;
	readonly settledAt: number | null;
	readonly lastMessageAt: number | null;
	readonly latestUserMessageAt: number | null;
	readonly latestTurn: AutoSettleTurn | null;
	readonly status: string;
	readonly hasPendingApproval: boolean;
	readonly hasLiveBackgroundWork: boolean;
	readonly hasViewer: boolean;
	readonly isSnoozed: boolean;
	readonly pinnedAt: number | null;
	readonly unread: boolean;
	readonly autoSettleDisabledAt: number | null;
	readonly unsettledAt: number | null;
	readonly createdAt: number | null;
	readonly mergedAt?: number | undefined;
}

export function getAutoSettleOutlook(
	facts: AutoSettleFacts,
	now: number,
	idleWindowMs: number | null,
): AutoSettleOutlook {
	if (!facts.exists || facts.isChild || facts.autoSettleDisabledAt !== null)
		return { kind: "off" };
	if (idleWindowMs === null) return { kind: "never" };
	if (facts.settledAt !== null) return { kind: "settled" };
	if (facts.pinnedAt !== null) return { kind: "paused", reason: "pinned" };
	if (facts.isSnoozed) return { kind: "paused", reason: "snoozed" };
	if (facts.unread) return { kind: "paused", reason: "unread" };

	if (
		facts.hasPendingApproval ||
		facts.status === "busy" ||
		facts.status === "retry" ||
		facts.latestTurn?.state === "pending" ||
		facts.latestTurn?.state === "running" ||
		facts.hasLiveBackgroundWork ||
		facts.hasViewer
	)
		return { kind: "paused", reason: "working" };

	const turn = facts.latestTurn;
	const latestUserMessageAt = facts.latestUserMessageAt;
	if (
		latestUserMessageAt !== null &&
		Math.abs(now - latestUserMessageAt) <= 120_000 &&
		(turn === null ||
			[turn.requestedAt, turn.startedAt, turn.completedAt].every(
				(time) => time === null || time < latestUserMessageAt,
			))
	)
		return { kind: "paused", reason: "working" };

	if (
		facts.mergedAt !== undefined &&
		facts.mergedAt >
			Math.max(
				facts.createdAt ?? Number.NEGATIVE_INFINITY,
				facts.latestUserMessageAt ?? Number.NEGATIVE_INFINITY,
				facts.unsettledAt ?? Number.NEGATIVE_INFINITY,
			)
	)
		return { kind: "due" };

	const lastActivityAt = Math.max(
		facts.lastMessageAt ?? Number.NEGATIVE_INFINITY,
		turn?.requestedAt ?? Number.NEGATIVE_INFINITY,
		turn?.startedAt ?? Number.NEGATIVE_INFINITY,
		turn?.completedAt ?? Number.NEGATIVE_INFINITY,
	);
	if (
		!Number.isFinite(lastActivityAt) ||
		!(facts.unsettledAt === null || facts.unsettledAt <= lastActivityAt)
	)
		return { kind: "paused", reason: "awaiting-activity" };

	return lastActivityAt < now - idleWindowMs
		? { kind: "due" }
		: { kind: "scheduled", at: lastActivityAt + idleWindowMs };
}

export function sessionRowToAutoSettleFacts(
	row: SessionRow | undefined,
	options: Omit<
		AutoSettleFacts,
		| "exists"
		| "isChild"
		| "settledAt"
		| "lastMessageAt"
		| "status"
		| "pinnedAt"
		| "unread"
		| "autoSettleDisabledAt"
		| "unsettledAt"
		| "createdAt"
	>,
): AutoSettleFacts {
	return {
		...options,
		exists: row !== undefined,
		isChild: (row?.parent_id ?? null) !== null,
		settledAt: row?.settled_at ?? null,
		lastMessageAt: row?.last_message_at ?? null,
		status: row?.status ?? "idle",
		pinnedAt: row?.pinned_at ?? null,
		unread: row?.unread === 1,
		autoSettleDisabledAt: row?.auto_settle_disabled_at ?? null,
		unsettledAt: row?.unsettled_at ?? null,
		createdAt: row?.created_at ?? null,
	};
}
