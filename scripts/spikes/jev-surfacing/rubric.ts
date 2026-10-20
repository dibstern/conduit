/**
 * The default category set from the surfacing plan (decisions 4 and 6), shared by
 * the labellers and the Jev Choice so both judge against the same rubric.
 * `what` lines are the round-3 taxonomy; weights are the shipped defaults.
 */
export type Criterion = {
	what: string;
	not_for?: string;
	examples?: string[];
};

export const CATEGORIES = [
	{
		id: "ask",
		weight: 100,
		criteria: {
			what: "Asks the user for a choice, fact, approval or action",
			not_for: "Questions the agent answers itself",
			examples: ["Recapture it, or keep the old paint order?"],
		},
	},
	{
		id: "blocked",
		weight: 80,
		criteria: {
			what: "Reports a failed gate, missing access or stop condition that prevents the next step",
		},
	},
	{
		id: "risk",
		weight: 80,
		criteria: {
			what: "Names an unresolved plausible harm, regression or hazard",
		},
	},
	{
		id: "scope",
		weight: 80,
		criteria: { what: "Says the agreed deliverables must grow or shrink" },
	},
	{
		id: "replan",
		weight: 60,
		criteria: { what: "Changes method or order because of new evidence" },
	},
	{
		id: "correction",
		weight: 60,
		criteria: { what: "Retracts or materially revises an earlier claim" },
	},
	{
		id: "decision",
		weight: 60,
		criteria: {
			what: "Commits to a consequential choice or trade-off on the user's behalf",
		},
	},
	{
		id: "finding",
		weight: 40,
		criteria: { what: "Establishes a new fact or root cause" },
	},
	{
		id: "milestone",
		weight: 40,
		criteria: { what: "Reports a completed deliverable or full gate" },
	},
] as const satisfies ReadonlyArray<{
	id: string;
	weight: number;
	criteria: Criterion;
}>;

export const ROUTINE: Criterion = {
	what: "Says what the agent will do next, restates the plan, acknowledges, or reports progress with nothing new",
	examples: [
		"Let me read the file.",
		"Now running the tests.",
		"Good, moving on.",
	],
};

export type CategoryId = (typeof CATEGORIES)[number]["id"];
export type Label = CategoryId | "routine";
export const LABELS: readonly Label[] = [
	...CATEGORIES.map((c) => c.id),
	"routine",
];

export const criteriaMap = (): Record<Label, Criterion> => ({
	...(Object.fromEntries(CATEGORIES.map((c) => [c.id, c.criteria])) as Record<
		CategoryId,
		Criterion
	>),
	routine: ROUTINE,
});

/** Decision 4's instructions. Without `request` in state, the question drops the reference to it. */
export const instructions = (withRequest: boolean) =>
	withRequest
		? {
				question:
					"`message` was written by an AI coding agent partway through the user's `request`, between tool calls. What is the main thing it tells the user?",
				focus:
					"Judge `message` against `request`. Saying what the agent will do next, or progress with nothing new, is routine.",
			}
		: {
				question:
					"`message` was written by an AI coding agent partway through a user's request, between tool calls. What is the main thing it tells the user?",
				focus:
					"Saying what the agent will do next, or progress with nothing new, is routine.",
			};

/** A labelled part as committed in the fixture. `request` and `message` are already truncated and scrubbed. */
export type FixturePart = {
	id: string;
	provider: "claude" | "opencode";
	request: string;
	message: string;
	label: Label;
};

export type Fixture = {
	description: string;
	labellers: string[];
	sampled: number;
	bothLabelled: number;
	agreed: number;
	parts: FixturePart[];
};
