/**
 * What a session is doing, one answer for every surface (82tn.32.30). CONTRACT.md 8.1 (2734):
 * SessionActivity is a read-only view over the Run Ledger and the goal tracker. Foreground and
 * background stay separate facts; the label is derived from them.
 */
import type { TasksView } from "../provider/run-ledger/run-ledger-model.js";
import type {
	SessionActivityLabel,
	SessionActivityView,
	SessionBackgroundActivity,
} from "../shared-types.js";

export interface SessionActivityFacts {
	/** The ledger's active Run, any phase from Queued to Settling, input or wake. */
	readonly run?: { readonly origin: "input" | "wake" };
	readonly tasks: TasksView;
	readonly servers: readonly {
		readonly role: "serving" | "awaited";
		readonly taskId?: string;
	}[];
	readonly prompts: { readonly approvals: number; readonly questions: number };
	/** Carried for the goal view; CONTRACT.md 8.1 (2734) and 8.3 (2849) give a goal no activity term. */
	readonly goal?: SessionActivityView["goal"];
}

const backgroundOf = (
	facts: SessionActivityFacts,
): SessionBackgroundActivity => {
	const classes = new Set(
		facts.tasks.tag === "live" ? facts.tasks.tasks.map((t) => t.class) : [],
	);
	// 8.7 (2996): an awaited server reads as working, a serving one as calm.
	if (classes.has("work") || facts.servers.some((s) => s.role === "awaited"))
		return "work";
	if (facts.tasks.tag === "unknown") return "unknown";
	if (classes.has("serving") || facts.servers.length > 0) return "serving";
	if (classes.has("monitoring")) return "monitoring";
	return "none";
};

/** What runs, without the prompts. */
const runningOf = (
	view: Pick<SessionActivityView, "foreground" | "background">,
): Exclude<SessionActivityLabel, "needs-you"> =>
	view.foreground === "working" || view.background === "work"
		? "working"
		: view.background === "none"
			? "idle"
			: "background";

export const deriveSessionActivity = (
	facts: SessionActivityFacts,
): SessionActivityView => {
	const needsYou: SessionActivityView["needsYou"] =
		facts.prompts.approvals > 0
			? "approval"
			: facts.prompts.questions > 0
				? "reply"
				: undefined;
	const parts: Omit<SessionActivityView, "label" | "goal"> = {
		foreground: facts.run ? "working" : "idle",
		background: backgroundOf(facts),
		...(needsYou ? { needsYou } : {}),
	};
	return {
		...parts,
		label: parts.needsYou ? "needs-you" : runningOf(parts),
		...(facts.goal ? { goal: facts.goal } : {}),
	};
};

const rank: Record<SessionActivityLabel, number> = {
	idle: 0,
	background: 1,
	working: 2,
	"needs-you": 3,
};

/** A session's activity as the sessions feed reads it, for the prompts its row shows. */
export type ActivityOf = (
	sessionId: string,
	prompts: SessionActivityFacts["prompts"],
) => SessionActivityView;

/**
 * One roll-up for a root and its members (children and side threads). Prompts roll up as counts,
 * so needs-you never hides what runs. A live background agent is a task of its root, so its own
 * turn reads as the root's background, never its foreground.
 */
export const rollUpActivity = (
	own: SessionActivityView,
	members: readonly {
		readonly activity: SessionActivityView;
		readonly backgroundChild?: boolean;
	}[],
): Exclude<SessionActivityLabel, "needs-you"> =>
	[{ activity: own }, ...members]
		.map(({ activity, backgroundChild }: (typeof members)[number]) => {
			const label = runningOf(activity);
			return backgroundChild && label === "working" ? "background" : label;
		})
		.reduce((top, label) => (rank[label] > rank[top] ? label : top), "idle");
