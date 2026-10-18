import type { WorktreeCleanup } from "../contracts/worktree.js";
import type { AutoSettleFacts } from "./auto-settle-policy.js";

const DAY_MS = 86_400_000;

export type WorktreeCleanupGitCheck = "nothing-missing";

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

type RuleCandidate =
	| { readonly lifecycle: "deleted" }
	| { readonly lifecycle: "settled"; readonly latestSettledAt: number | null };

interface RuleContext {
	readonly rules: WorktreeCleanup;
	readonly now: number;
}

// First matching row wins. Deleted sessions only match the delete row.
// Settled-after accepts everything nothing-missing can remove, so it takes
// precedence and applies the user's keep level without an ancestor check.
const cleanupRules: readonly {
	readonly candidate: (context: RuleContext) => RuleCandidate | undefined;
	readonly reason: string;
	readonly keepWhen: (context: RuleContext) => WorktreeCleanup["keepWhen"];
	readonly gitChecks: readonly WorktreeCleanupGitCheck[];
}[] = [
	{
		candidate: ({ rules }) =>
			rules.onDelete ? { lifecycle: "deleted" } : undefined,
		reason: "Session was deleted",
		keepWhen: ({ rules }) => rules.keepWhen,
		gitChecks: [],
	},
	{
		candidate: ({ rules, now }) =>
			rules.settledAfterDays !== null
				? {
						lifecycle: "settled",
						latestSettledAt: now - rules.settledAfterDays * DAY_MS,
					}
				: undefined,
		reason: "Settled for the set time",
		keepWhen: ({ rules }) => rules.keepWhen,
		gitChecks: [],
	},
	{
		candidate: ({ rules }) =>
			rules.onSettle === "nothing-missing"
				? { lifecycle: "settled", latestSettledAt: null }
				: undefined,
		reason: "Settled with nothing missing",
		keepWhen: ({ rules }) =>
			rules.keepWhen === "tracked-changes"
				? "uncommitted-changes"
				: rules.keepWhen,
		gitChecks: ["nothing-missing"],
	},
];

export interface WorktreeCleanupCandidateFilter {
	readonly lifecycleStates: readonly RuleCandidate["lifecycle"][];
	/** Null means any settled age, when settled is an eligible lifecycle. */
	readonly latestSettledAt: number | null;
}

/** The cold reader and enabled short-circuit derive eligibility from the rule rows. */
export function worktreeCleanupCandidateFilter(
	rules: WorktreeCleanup,
	now: number,
): WorktreeCleanupCandidateFilter | undefined {
	const candidates = cleanupRules.flatMap((rule) => {
		const candidate = rule.candidate({ rules, now });
		return candidate ? [candidate] : [];
	});
	if (candidates.length === 0) return undefined;
	const settled = candidates.filter(
		(candidate) => candidate.lifecycle === "settled",
	);
	return {
		lifecycleStates: [
			...new Set(candidates.map((candidate) => candidate.lifecycle)),
		],
		latestSettledAt:
			settled.length === 0 ||
			settled.some((candidate) => candidate.latestSettledAt === null)
				? null
				: Math.max(
						...settled.map(
							(candidate) => candidate.latestSettledAt ?? -Infinity,
						),
					),
	};
}

/** Unknown Git checks are returned to the caller; failed checks skip their row. */
export function decideWorktreeCleanup(
	rules: WorktreeCleanup,
	facts: AutoSettleFacts | undefined,
	now: number,
	gitChecks: Partial<Readonly<Record<WorktreeCleanupGitCheck, boolean>>> = {},
): WorktreeCleanupDecision {
	const context: RuleContext = { rules, now };
	const applicable = cleanupRules.filter((rule) => {
		const candidate = rule.candidate(context);
		if (candidate === undefined) return false;
		if (candidate.lifecycle === "deleted") return facts === undefined;
		return (
			facts?.settledAt != null &&
			(candidate.latestSettledAt === null ||
				facts.settledAt <= candidate.latestSettledAt)
		);
	});
	for (const rule of applicable) {
		if (!rule.gitChecks.some((check) => gitChecks[check] === false))
			return {
				_tag: "Remove",
				reason: rule.reason,
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
		keepWhen: applicable[0]?.keepWhen(context) ?? rules.keepWhen,
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
