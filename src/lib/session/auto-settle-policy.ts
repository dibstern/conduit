import type { SessionRow } from "../persistence/read-model-types.js";

export interface AutoSettleTurn {
	readonly state: string;
	readonly requestedAt: number | null;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
}

export interface AutoSettleFacts {
	readonly exists: boolean;
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
	readonly readAt: number | null;
	readonly autoSettleDisabledAt: number | null;
	readonly unsettledAt: number | null;
}

export function shouldSettleIdleSession(
	facts: AutoSettleFacts,
	now: number,
	idleWindowMs: number | null,
): boolean {
	if (
		idleWindowMs === null ||
		!facts.exists ||
		facts.settledAt !== null ||
		facts.autoSettleDisabledAt !== null ||
		facts.hasPendingApproval ||
		facts.status === "busy" ||
		facts.status === "retry" ||
		facts.latestTurn?.state === "pending" ||
		facts.latestTurn?.state === "running" ||
		facts.hasLiveBackgroundWork ||
		facts.isSnoozed ||
		facts.pinnedAt !== null ||
		facts.hasViewer ||
		facts.readAt === null ||
		(facts.lastMessageAt !== null && facts.readAt < facts.lastMessageAt)
	)
		return false;

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
		return false;

	const lastActivityAt = Math.max(
		facts.lastMessageAt ?? Number.NEGATIVE_INFINITY,
		turn?.requestedAt ?? Number.NEGATIVE_INFINITY,
		turn?.startedAt ?? Number.NEGATIVE_INFINITY,
		turn?.completedAt ?? Number.NEGATIVE_INFINITY,
	);
	return (
		Number.isFinite(lastActivityAt) &&
		(facts.unsettledAt === null || facts.unsettledAt <= lastActivityAt) &&
		lastActivityAt < now - idleWindowMs
	);
}

export function sessionRowToAutoSettleFacts(
	row: SessionRow | undefined,
	options: Omit<
		AutoSettleFacts,
		| "exists"
		| "settledAt"
		| "lastMessageAt"
		| "status"
		| "pinnedAt"
		| "readAt"
		| "autoSettleDisabledAt"
		| "unsettledAt"
	>,
): AutoSettleFacts {
	return {
		...options,
		exists: row !== undefined,
		settledAt: row?.settled_at ?? null,
		lastMessageAt: row?.last_message_at ?? null,
		status: row?.status ?? "idle",
		pinnedAt: row?.pinned_at ?? null,
		readAt: row?.read_at ?? null,
		autoSettleDisabledAt: row?.auto_settle_disabled_at ?? null,
		unsettledAt: row?.unsettled_at ?? null,
	};
}
