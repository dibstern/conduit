import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { turnFixtureMessages } from "../../stories/turn-fixtures.js";
import type { ChatMessage } from "../../types.js";
import { segmentTurns, type Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

const EMPTY_TURN: Turn = {
	id: "empty",
	segments: [{ activity: [], reply: [] }],
	notices: [],
	live: false,
};

function fixtureTurn(index: number, processing: boolean): Turn {
	return segmentTurns(turnFixtureMessages, processing)[index] ?? EMPTY_TURN;
}

/** Long finished turn: narration, reads, edits, a failing then passing test run, a subagent. */
const settled = fixtureTurn(1, false);
/** Same session mid-flight: an edit still running, no result yet. */
const live = fixtureTurn(2, true);

const meta = {
	title: "Chat/Turn Activity",
	component: TurnActivity,
	parameters: { layout: "padded" },
} satisfies Meta<typeof TurnActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Sentence + strip + bill across two lines, with the failed step called out. */
export const Settled: Story = {
	args: { turn: settled, segment: settled.segments[0]!, final: true },
};

/** Elapsed time counts up, the strip grows, and the last three steps show as a fading ticker. */
export const Live: Story = {
	args: { turn: live, segment: live.segments[0]!, final: true },
};

/** A short turn — few steps, so segments stay legible at minimum width. */
export const Short: Story = {
	args: {
		turn: settled,
		segment: {
			...settled.segments[0]!,
			activity: settled.segments[0]!.activity.slice(0, 3),
		},
		final: true,
	},
};

/** No usage reported, so cost, tokens and the context gauge are absent rather than zeroed. */
const billless: Turn = {
	...settled,
	segments: settled.segments.map((segment) =>
		segment.end?.type === "result"
			? { ...segment, end: { type: "result", uuid: segment.end.uuid } }
			: segment,
	),
};
export const NoBill: Story = {
	args: { turn: billless, segment: billless.segments[0]!, final: true },
};

const handBackMessages = [
	{ type: "user", uuid: "handback-user", text: "Help me choose a target." },
	{
		type: "tool",
		uuid: "handback-context",
		id: "handback-context",
		name: "Read",
		input: { tool: "Read", filePath: "package.json" },
		status: "completed",
	},
	{
		type: "assistant",
		uuid: "handback-question-text",
		rawText: "Which environment should I target?",
		html: "<p>Which environment should I target?</p>",
		finalized: true,
	},
	{
		type: "tool",
		uuid: "handback-question",
		id: "handback-question",
		name: "AskUserQuestion",
		input: {
			questions: [
				{
					header: "Environment",
					question: "Which environment should I target?",
					options: [
						{ label: "Staging", description: "Use the staging project." },
						{ label: "Production", description: "Use the production project." },
					],
				},
			],
		},
		status: "completed",
		result: "Staging",
	},
	{
		type: "tool",
		uuid: "handback-read",
		id: "handback-read",
		name: "Read",
		input: { tool: "Read", filePath: "deploy/staging.json" },
		status: "completed",
	},
	{
		type: "assistant",
		uuid: "handback-reply",
		rawText: "Staging is configured and ready.",
		html: "<p>Staging is configured and ready.</p>",
		finalized: true,
	},
] satisfies ChatMessage[];
const handBack = segmentTurns(handBackMessages, false)[0]!;

/** The pre-question ledger is settled and carries no turn-level bill. */
export const HandBack: Story = {
	args: { turn: handBack, segment: handBack.segments[0]!, final: false },
};
