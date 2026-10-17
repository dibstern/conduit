import type { WorktreeCleanup } from "../contracts/worktree.js";
import type { AutoSettleFacts } from "./auto-settle-policy.js";

const DAY_MS = 86_400_000;

export type WorktreeCleanupGitCheck = "merged" | "no-commits-beyond-default";

type WorktreeCleanupDecision = {
	readonly keepWhen: WorktreeCleanup["keepWhen"];
} & (
	| {
			readonly _tag: "Keep";
			readonly reason: string;
			/** Preserve inspection reasons when a configured rule has not matched. */
			readonly inspectCheckout: boolean;
	  }
	| {
			readonly _tag: "Remove";
			readonly reason: string;
			readonly gitChecks: readonly WorktreeCleanupGitCheck[];
	  }
);

interface RuleContext {
	readonly rules: WorktreeCleanup;
	readonly facts: AutoSettleFacts | undefined;
	readonly now: number;
	readonly lastActivity: number;
}

// First matching row wins: delete, settle-any, inactivity, merged, no commits.
// A failed Git check falls through to the next row. Deleted sessions only use
// the delete row. Every row currently uses the user's keep level.
const cleanupRules: readonly {
	readonly applies: (context: RuleContext) => boolean;
	readonly reason: (context: RuleContext) => string | undefined;
	readonly keepWhen: (context: RuleContext) => WorktreeCleanup["keepWhen"];
	readonly gitChecks: readonly WorktreeCleanupGitCheck[];
}[] = [
	{
		applies: ({ rules, facts }) => facts === undefined && rules.onDelete,
		reason: () => "Session was deleted",
		keepWhen: ({ rules }) => rules.keepWhen,
		gitChecks: [],
	},
	{
		applies: ({ rules, facts }) =>
			facts?.settledAt != null && rules.onSettle === "any",
		reason: () => "Session is settled",
		keepWhen: ({ rules }) => rules.keepWhen,
		gitChecks: [],
	},
	{
		applies: ({ rules, facts }) =>
			facts !== undefined && rules.afterInactiveDays !== null,
		reason: ({ rules, now, lastActivity }) =>
			rules.afterInactiveDays !== null &&
			Number.isFinite(lastActivity) &&
			lastActivity < now - rules.afterInactiveDays * DAY_MS
				? `Inactive for ${Math.floor((now - lastActivity) / DAY_MS)} days`
				: undefined,
		keepWhen: ({ rules }) => rules.keepWhen,
		gitChecks: [],
	},
	{
		applies: ({ rules, facts }) =>
			facts !== undefined &&
			(rules.whenMerged ||
				(facts.settledAt !== null && rules.onSettle === "merged")),
		reason: ({ rules, facts }) =>
			facts?.settledAt != null && rules.onSettle === "merged"
				? "Settled and merged"
				: "Branch is merged",
		keepWhen: ({ rules }) => rules.keepWhen,
		gitChecks: ["merged"],
	},
	{
		applies: ({ rules, facts }) =>
			facts !== undefined && rules.noCommitsBeyondDefault,
		reason: () => "No commits beyond the default branch",
		keepWhen: ({ rules }) => rules.keepWhen,
		gitChecks: ["no-commits-beyond-default"],
	},
];

/** Unknown Git checks are returned to the caller; failed checks skip their row. */
export function decideWorktreeCleanup(
	rules: WorktreeCleanup,
	facts: AutoSettleFacts | undefined,
	now: number,
	gitChecks: Partial<Readonly<Record<WorktreeCleanupGitCheck, boolean>>> = {},
): WorktreeCleanupDecision {
	const turn = facts?.latestTurn;
	const context: RuleContext = {
		rules,
		facts,
		now,
		lastActivity: Math.max(
			facts?.lastMessageAt ?? -Infinity,
			facts?.latestUserMessageAt ?? -Infinity,
			turn?.requestedAt ?? -Infinity,
			turn?.startedAt ?? -Infinity,
			turn?.completedAt ?? -Infinity,
		),
	};
	const applicable = cleanupRules.filter((rule) => rule.applies(context));
	for (const rule of applicable) {
		const reason = rule.reason(context);
		if (
			reason !== undefined &&
			!rule.gitChecks.some((check) => gitChecks[check] === false)
		)
			return {
				_tag: "Remove",
				reason,
				keepWhen: rule.keepWhen(context),
				gitChecks: rule.gitChecks,
			};
	}
	return {
		_tag: "Keep",
		reason:
			facts === undefined
				? "No rule matched for deleted session"
				: "No rule matched",
		keepWhen: rules.keepWhen,
		inspectCheckout: applicable.length > 0,
	};
}

interface SessionQuiescenceState {
	readonly facts:
		| Pick<AutoSettleFacts, "status" | "latestTurn" | "hasPendingApproval">
		| undefined;
	readonly isRetrying: boolean;
	readonly hasPendingTurn: boolean;
	readonly hasLiveBackgroundWork: boolean;
}

export function sessionQuiescenceBlockReason(
	state: SessionQuiescenceState,
): string | undefined {
	const facts = state.facts;
	if (
		facts?.status === "busy" ||
		facts?.status === "pending" ||
		facts?.status === "retry" ||
		facts?.latestTurn?.state === "pending" ||
		facts?.latestTurn?.state === "running" ||
		state.isRetrying ||
		state.hasPendingTurn
	)
		return "Session is running";
	if (facts?.hasPendingApproval) return "Has a pending approval or question";
	if (state.hasLiveBackgroundWork) return "Has live background work";
	return undefined;
}

export function isSessionQuiescent(state: SessionQuiescenceState): boolean {
	return sessionQuiescenceBlockReason(state) === undefined;
}
