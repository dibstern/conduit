export interface AutoArchiveFacts {
	readonly settledAt: number | null;
	readonly archivedAt: number | null;
	readonly unarchivedAt: number | null;
	readonly lastActivityAt: number;
	readonly status: string;
	readonly snoozed: boolean;
	readonly pinnedAt: number | null;
	readonly hasPendingWork: boolean;
	readonly hasLiveBackgroundWork: boolean;
}

export function shouldArchiveIdleSession(
	facts: AutoArchiveFacts,
	now: number,
	idleWindowMs: number | null,
): boolean {
	return (
		idleWindowMs !== null &&
		facts.settledAt !== null &&
		facts.archivedAt === null &&
		!facts.snoozed &&
		facts.pinnedAt === null &&
		facts.status !== "busy" &&
		facts.status !== "retry" &&
		!facts.hasPendingWork &&
		!facts.hasLiveBackgroundWork &&
		(facts.unarchivedAt === null ||
			facts.unarchivedAt <= facts.lastActivityAt) &&
		facts.lastActivityAt < now - idleWindowMs
	);
}

export interface AutoDeleteArchivedFacts {
	readonly rootArchivedAt: number | null;
	readonly pinned: boolean;
	readonly hasPendingWork: boolean;
	readonly hasLiveBackgroundWork: boolean;
	readonly hasSurvivingFork: boolean;
}

export function shouldDeleteArchivedSessionTree(
	facts: AutoDeleteArchivedFacts,
	now: number,
	windowMs: number | null,
): boolean {
	return (
		windowMs !== null &&
		facts.rootArchivedAt !== null &&
		facts.rootArchivedAt <= now - windowMs &&
		!facts.pinned &&
		!facts.hasPendingWork &&
		!facts.hasLiveBackgroundWork &&
		!facts.hasSurvivingFork
	);
}
