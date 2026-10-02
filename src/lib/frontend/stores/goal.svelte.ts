import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { SessionGoalChangedPayload } from "../../contracts/stored-event.js";
import type { SessionInfo } from "../types.js";

/** Provider facts only. Phase and presentation always come from goalView. */
export const sessionGoals = new SvelteMap<string, SessionGoalChangedPayload>();
const dismissedMetGoals = new SvelteSet<string>();

export const goalDetails = $state({ open: false });

export type GoalComposerAction = {
	sessionId: string;
	action: "pause" | "resume" | "edit" | "clear" | "new";
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
	phase:
		| "starting"
		| "pursuing"
		| "checking"
		| "not_yet"
		| "paused"
		| "met"
		| "cleared"
		| null;
	subtitle: string;
	tone: "violet" | "amber" | "success" | null;
	border: "solid" | "dashed" | "none";
	icon: "target" | "spinner" | "pause" | "check";
};

export function goalView(
	facts: SessionGoalChangedPayload | undefined,
	sessionStatus: SessionInfo["status"],
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
	if (sessionStatus === "busy" || sessionStatus === "retry") {
		if (goal.iterations === 0) {
			return {
				phase: "starting",
				subtitle: "Goal set · starting",
				tone: "violet",
				border: "solid",
				icon: "target",
			};
		}
		const checks = `${goal.iterations} ${goal.iterations === 1 ? "check" : "checks"}`;
		return {
			phase: "pursuing",
			subtitle: `${goal.condition} · ${checks}${goal.lastReason ? ` · ${goal.lastReason}` : ""}`,
			tone: "violet",
			border: "solid",
			icon: "target",
		};
	}
	if (goal.lastReason) {
		return {
			phase: "not_yet",
			subtitle: `Not yet · ${goal.lastReason} · check ${goal.iterations}`,
			tone: "amber",
			border: "solid",
			icon: "target",
		};
	}
	return {
		phase: "checking",
		subtitle: `Checking goal · check ${goal.iterations + 1}`,
		tone: "violet",
		border: "solid",
		icon: "spinner",
	};
}
