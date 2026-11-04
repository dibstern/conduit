import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { SessionGoalChangedPayload } from "../../contracts/stored-event.js";
import type { SessionInfo } from "../types.js";

/** Provider facts only. Phase and presentation always come from goalView. */
export const sessionGoals = new SvelteMap<string, SessionGoalChangedPayload>();
const dismissedMetGoals = new SvelteSet<string>();

export const goalDetails = $state({ open: false });

export type GoalComposerAction = {
	sessionId: string;
	action: "resume" | "edit" | "clear" | "new";
	condition?: string;
};

declare global {
	interface WindowEventMap {
		"composer:goal": CustomEvent<GoalComposerAction>;
	}
}

function metDismissalKey(facts: SessionGoalChangedPayload): string {
	return `conduit:goal-met-dismissed:${facts.sessionId}:${facts.endedGoal?.setAt ?? "legacy"}`;
}

export function handleGoalChanged(facts: SessionGoalChangedPayload): void {
	sessionGoals.set(facts.sessionId, { ...facts });
	if (facts.ended !== "met") return;
	try {
		const key = metDismissalKey(facts);
		if (localStorage.getItem(key) === "true") dismissedMetGoals.add(key);
	} catch {
		// Storage can be unavailable; the current tab still remembers dismissals.
	}
}

export function isGoalMetDismissed(
	facts: SessionGoalChangedPayload | undefined,
): boolean {
	return (
		facts?.ended === "met" && dismissedMetGoals.has(metDismissalKey(facts))
	);
}

export function dismissGoalMet(facts: SessionGoalChangedPayload): void {
	if (facts.ended !== "met") return;
	const key = metDismissalKey(facts);
	dismissedMetGoals.add(key);
	try {
		localStorage.setItem(key, "true");
	} catch {
		// Keep the in-memory dismissal when storage is unavailable.
	}
}

export function hydrateSessionGoal(session: SessionInfo): void {
	handleGoalChanged(session.goalState ?? { sessionId: session.id, goal: null });
}

export type GoalView = {
	phase: "pursuing" | "not_yet" | "paused" | "met" | "cleared" | null;
	subtitle: string;
	tone: "violet" | "amber" | "success" | null;
	border: "solid" | "dashed" | "none";
	icon: "target" | "pause" | "check";
};

export function goalView(
	facts: SessionGoalChangedPayload | undefined,
	/** The session's foreground Run is working (SessionActivity, CONTRACT.md 8.1). */
	working: boolean,
): GoalView {
	const goal = facts?.goal;
	if (!goal) {
		const outcome = [
			facts?.ended === "met"
				? "Goal met"
				: facts?.ended === "cleared"
					? "Goal cleared"
					: "",
		];
		if (facts?.ended === "met" && facts.endedGoal) {
			outcome.push(`${facts.endedGoal.iterations} checks`);
			if (facts.endedAt !== undefined) {
				const minutes = Math.max(
					1,
					Math.floor((facts.endedAt - facts.endedGoal.setAt) / 60_000),
				);
				outcome.push(
					minutes < 60
						? `${minutes}m`
						: `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`,
				);
			}
		}
		return {
			phase: facts?.ended ?? null,
			subtitle: outcome.join(" · "),
			tone:
				facts?.ended === "met"
					? "success"
					: facts?.ended === "cleared"
						? "violet"
						: null,
			border: "none",
			icon: facts?.ended === "met" ? "check" : "target",
		};
	}
	if (facts?.pausedReason) {
		return {
			phase: "paused",
			subtitle: `Goal paused · ${goal.condition}`,
			tone: "violet",
			border: "dashed",
			icon: "pause",
		};
	}
	const checks = `${goal.iterations} ${goal.iterations === 1 ? "check" : "checks"}`;
	// Nothing observes a goal check, so the session's activity never makes a starting or checking phase.
	if (goal.lastReason && !working) {
		return {
			phase: "not_yet",
			subtitle: `${goal.condition} · ${checks}`,
			tone: "amber",
			border: "solid",
			icon: "target",
		};
	}
	return {
		phase: "pursuing",
		subtitle: `${goal.condition} · ${checks}`,
		tone: "violet",
		border: "solid",
		icon: "target",
	};
}
