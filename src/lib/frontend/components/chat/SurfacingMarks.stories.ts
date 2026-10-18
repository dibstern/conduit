import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	DEFAULT_CATEGORY_SET,
	type SurfacingMark,
} from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import { setSessionSurfaceLevel } from "../../stores/message-surfacing.svelte.js";
import { feedbackLedger } from "../../stores/surfacing-feedback.svelte.js";
import type { ActivityPart, Segment, Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

// Failure cases exercised at the rendered seam: limits, cancellation and focus,
// routine messages in the log, retype before reason, and persisted mark labels.
const start = Date.now() - 600_000;
const activity: ActivityPart[] = [
	{
		type: "assistant",
		uuid: "marks/finding",
		partId: "finding",
		rawText: "The badge store still fans out per row.",
		html: "<p>The badge store still fans out per row.</p>",
		finalized: true,
		createdAt: start,
		surfacingOrdinal: 26,
		surfacingProbabilities: { finding: 0.64, routine: 0.01 },
	},
	{
		type: "thinking",
		uuid: "thinking",
		text: "Checking the next file",
		done: true,
		createdAt: start + 20_000,
	},
	{
		type: "assistant",
		uuid: "marks/ask",
		partId: "ask",
		rawText: "Recapture the baseline?",
		html: "<p>Recapture the baseline?</p>",
		finalized: true,
		createdAt: start + 60_000,
		surfacingOrdinal: 27,
		surfacingProbabilities: { ask: 0.95 },
	},
	{
		type: "assistant",
		uuid: "marks/routine",
		partId: "routine",
		rawText: "I'll read the next file.",
		html: "<p>I'll read the next file.</p>",
		finalized: true,
		createdAt: start + 90_000,
		surfacingOrdinal: 28,
		surfacingProbabilities: { routine: 1 },
	},
];
const segment: Segment = { activity, reply: [] };
const turn: Turn = {
	id: "marks-turn",
	user: {
		type: "user",
		uuid: "marks-user",
		text: "Check the badge store",
		createdAt: start,
	},
	segments: [segment],
	notices: [],
	live: false,
};
const meta = {
	title: "Chat/Surfacing Marks",
	component: TurnActivity,
	parameters: { layout: "padded" },
	args: {
		turn,
		segment,
		final: true,
		sessionId: "marks-story",
		surfacing: {
			status: {
				...DEFAULT_MESSAGE_SURFACING_SETTINGS,
				summariesEnabled: true,
				enabled: true,
				active: true,
				key: { source: "stored" as const, rejected: false },
				defaultLevel: "all" as const,
			},
			categorySet: DEFAULT_CATEGORY_SET,
		},
	},
	beforeEach: () => {
		setSessionSurfaceLevel("marks-story", null);
		feedbackLedger.entries = [
			"users saw this",
			"root cause",
			"changes the plan",
		].map((reason, index) => ({
			sessionId: "marks-reasons",
			partId: String(index),
			mark: { level: "balanced", direction: "raise", reason },
		}));
	},
} satisfies Meta<typeof TurnActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RaiseWhy: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("surfacing-pin-26"));
		await userEvent.click(canvas.getByTestId("surfacing-mark-raise"));
		await expect(canvas.getByTestId("surfacing-mark-why")).toHaveTextContent(
			"▲ Raise #26: All → Balanced. Why?",
		);
		await expect(canvas.getByTestId("surfacing-mark-why")).toHaveTextContent(
			"p .64 × 40 = 26",
		);
		await expect(
			canvas.getAllByTestId("surfacing-mark-reason-chip"),
		).toHaveLength(3);
	},
};
export const RaiseWhyLight: Story = {
	...RaiseWhy,
	globals: { theme: "light" },
};
export const RetypeMenu: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("surfacing-pin-26"));
		await userEvent.click(canvas.getByTestId("surfacing-mark-retype"));
		await expect(
			canvas.getByTestId("surfacing-mark-category-risk"),
		).toBeVisible();
		await expect(
			canvas.queryByTestId("surfacing-mark-category-finding"),
		).not.toBeInTheDocument();
	},
};
export const RetypeMenuLight: Story = {
	...RetypeMenu,
	globals: { theme: "light" },
};
export const RetypeWhy: Story = {
	play: async (context) => {
		await RetypeMenu.play?.(context);
		const canvas = within(context.canvasElement);
		await userEvent.click(canvas.getByTestId("surfacing-mark-category-risk"));
		await expect(canvas.getByTestId("surfacing-mark-why")).toHaveTextContent(
			"Risk → Key. Why?",
		);
	},
};
export const RetypeWhyLight: Story = {
	...RetypeWhy,
	globals: { theme: "light" },
};
export const CancelAndLimits: Story = {
	play: async (context) => {
		await RaiseWhy.play?.(context);
		const canvas = within(context.canvasElement);
		await userEvent.click(canvas.getByTestId("surfacing-mark-cancel"));
		await expect(
			canvas.queryByTestId("surfacing-mark-why"),
		).not.toBeInTheDocument();
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveFocus();
		await userEvent.click(canvas.getByTestId("surfacing-pin-27"));
		await expect(canvas.getByTestId("surfacing-mark-raise")).toBeDisabled();
	},
};
export const CancelAndLimitsLight: Story = {
	...CancelAndLimits,
	globals: { theme: "light" },
};

function marked(mark: SurfacingMark): { turn: Turn; segment: Segment } {
	const markedSegment: Segment = {
		activity: activity.map((part) =>
			part.uuid === "marks/finding" ? { ...part, surfacingMark: mark } : part,
		),
		reply: [],
	};
	return {
		segment: markedSegment,
		turn: { ...turn, segments: [markedSegment] },
	};
}
export const SavedMark: Story = {
	args: marked({
		level: "balanced",
		direction: "raise",
		reason: "users saw this",
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("surfacing-pin-26"));
		await expect(canvas.getByTestId("surfacing-mark-label")).toHaveTextContent(
			"▲ you · users saw this",
		);
		await expect(canvas.getByTestId("surfacing-mark-raise")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(
			canvas.getByTestId("surfacing-pin-26").querySelector("sup"),
		).toHaveTextContent("▲");
	},
};
export const SavedMarkLight: Story = {
	...SavedMark,
	globals: { theme: "light" },
};
export const RoutineInLog: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const toggle = canvasElement.querySelector<HTMLButtonElement>(
			".turn-activity-toggle",
		);
		await expect(toggle).not.toBeNull();
		if (toggle) await userEvent.click(toggle);
		const row = within(canvas.getByTestId("surfacing-step-mark-28"));
		await expect(row.getByTestId("surfacing-mark-lower")).toBeDisabled();
		await userEvent.click(row.getByTestId("surfacing-mark-raise"));
		await expect(row.getByTestId("surfacing-mark-why")).toHaveTextContent(
			"the log → All",
		);
	},
};
export const RoutineInLogLight: Story = {
	...RoutineInLog,
	globals: { theme: "light" },
};

export const LoweredInLog: Story = {
	args: marked({
		level: "hidden",
		direction: "lower",
		reason: "just a compile",
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const toggle = canvasElement.querySelector<HTMLButtonElement>(
			".turn-activity-toggle",
		);
		await expect(toggle).not.toBeNull();
		if (toggle) await userEvent.click(toggle);
		await userEvent.click(canvas.getByTestId("surfacing-step-open-26"));
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveTextContent(
			"Hidden at this level",
		);
		await expect(
			within(canvas.getByTestId("surfacing-msg-card")).getByTestId(
				"surfacing-mark-lower",
			),
		).toHaveAttribute("aria-pressed", "true");
	},
};
export const LoweredInLogLight: Story = {
	...LoweredInLog,
	globals: { theme: "light" },
};
