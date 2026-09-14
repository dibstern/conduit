import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { turnFixtureMessages } from "../../stories/turn-fixtures.js";
import { segmentTurns, type Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

const EMPTY_TURN: Turn = {
	id: "empty",
	activity: [],
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
export const Settled: Story = { args: { turn: settled } };

/** Elapsed time counts up, the strip grows, and the last three steps show as a fading ticker. */
export const Live: Story = { args: { turn: live } };

/** A short turn — few steps, so segments stay legible at minimum width. */
export const Short: Story = {
	args: { turn: { ...settled, activity: settled.activity.slice(0, 3) } },
};

/** No result message, so cost, tokens and the context gauge are absent rather than zeroed. */
const { result: _result, ...billless } = settled;
export const NoBill: Story = { args: { turn: billless } };
