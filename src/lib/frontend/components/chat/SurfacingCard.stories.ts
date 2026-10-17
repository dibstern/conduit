import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import { setSessionSurfaceLevel } from "../../stores/message-surfacing.svelte.js";
import type { AssistantMessage } from "../../types.js";
import type { ActivityPart, Segment, Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

const START = Date.now() - 900_000;
const descriptions = [
	[
		1,
		"finding",
		1,
		"The unread counter has **three consumers**, including the push deep link.",
	],
	[
		2,
		"ask",
		0.95,
		"The phone sidebar baseline shifts 2px because the unread badge paints earlier. **Recapture it, or keep the old paint order?** I'll carry on with the deep link meanwhile.",
	],
	[
		3,
		"finding",
		0.6,
		"The deep link opens the session before its history loads. That explains the empty flash on iOS.",
	],
	[
		4,
		"decision",
		0.9,
		"I'm batching the subscriptions into one stream so reconnecting doesn't open 293 streams per tab.",
	],
	[
		5,
		"blocked",
		0.95,
		"The schema isn't merged. I can't finish the sidebar until it lands.",
	],
	[6, "routine", 1, "I'll read the next file."],
	[
		7,
		"risk",
		0.96,
		"293 simultaneous subscriptions could exhaust the daemon's socket budget.",
	],
] as const;
const activity: ActivityPart[] = descriptions.flatMap(
	([ordinal, category, probability, text], index) => [
		{
			type: "assistant",
			uuid: `jev-story/part-${ordinal}`,
			messageId: "jev-story",
			partId: `part-${ordinal}`,
			rawText: text,
			html: `<p>${text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`,
			finalized: true,
			surfacingOrdinal: ordinal,
			surfacingProbabilities: {
				[category]: probability,
				routine: category === "routine" ? 1 : 0.01,
			},
			surfacingSetVersion: 1,
			surfacingModel: "jev-1.13.0",
			createdAt: START + index * 120_000,
		},
		{
			type: "thinking",
			uuid: `thinking-${ordinal}`,
			text: "Checking the implementation",
			done: true,
			duration: 1000,
			createdAt: START + index * 120_000 + 30_000,
		},
	],
);
const segment: Segment = { activity, reply: [] };
const turn: Turn = {
	id: "jev-story-turn",
	user: {
		type: "user",
		uuid: "jev-story-user",
		text: "Migrate the session subscriptions",
		createdAt: START,
	},
	segments: [segment],
	notices: [],
	live: false,
};
const config = {
	status: {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		enabled: true,
		active: true,
		key: { state: "valid" as const },
	},
	categorySet: DEFAULT_CATEGORY_SET,
};
const meta = {
	title: "Chat/Surfacing Card",
	component: TurnActivity,
	parameters: { layout: "padded" },
	args: {
		turn,
		segment,
		final: true,
		providerId: "claude",
		sessionId: "jev-story-session",
		surfacing: config,
	},
	beforeEach: () => {
		setSessionSurfaceLevel("jev-story-session", null);
	},
} satisfies Meta<typeof TurnActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

/** All stories are captured at desktop and phone viewports by the visual suite. */
export const Balanced: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveAttribute(
			"data-ordinal",
			"7",
		);
		const card = canvas
			.getByTestId("surfacing-msg-card")
			.getBoundingClientRect();
		const lane = canvas.getByTestId("surfacing-pins").getBoundingClientRect();
		await expect(card.bottom).toBeLessThanOrEqual(lane.top);
		await expect(
			canvas.queryByTestId("surfacing-pin-3"),
		).not.toBeInTheDocument();
	},
};
export const BalancedLight: Story = {
	...Balanced,
	globals: { theme: "light" },
};

export const Ask: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("surfacing-pin-2"));
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveAttribute(
			"data-ordinal",
			"2",
		);
		await expect(canvas.getByText("Needs reply")).toBeVisible();
		canvas.getByTestId("surfacing-pin-2").blur();
	},
};
export const AskLight: Story = { ...Ask, globals: { theme: "light" } };

export const Key: Story = {
	args: {
		surfacing: { ...config, status: { ...config.status, defaultLevel: "key" } },
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("surfacing-pins").querySelectorAll("button"),
		).toHaveLength(3);
		await expect(
			canvas.queryByTestId("surfacing-pin-1"),
		).not.toBeInTheDocument();
	},
};
export const KeyLight: Story = { ...Key, globals: { theme: "light" } };
export const All: Story = {
	args: {
		surfacing: { ...config, status: { ...config.status, defaultLevel: "all" } },
	},
};
export const AllLight: Story = { ...All, globals: { theme: "light" } };
export const Final: Story = {
	args: {
		surfacing: {
			...config,
			status: { ...config.status, defaultLevel: "final" },
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.queryByTestId("surfacing-msg-card"),
		).not.toBeInTheDocument();
		await expect(canvas.getByText("Final only · 6 hidden")).toBeVisible();
	},
};
export const FinalLight: Story = { ...Final, globals: { theme: "light" } };

const pending: AssistantMessage = {
	type: "assistant",
	uuid: "jev-story/pending",
	messageId: "jev-story",
	partId: "pending",
	rawText: "Checking the final baseline now.",
	html: "<p>Checking the final baseline now.</p>",
	finalized: true,
	createdAt: START + 850_000,
};
const liveSegment: Segment = {
	activity: [
		...activity,
		pending,
		{
			type: "thinking",
			uuid: "after-pending",
			text: "Verifying",
			done: false,
			createdAt: START + 860_000,
		},
	],
	reply: [],
};
const liveTurn: Turn = { ...turn, live: true, segments: [liveSegment] };
export const LivePending: Story = {
	args: { turn: liveTurn, segment: liveSegment },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-msg-card")).not.toHaveAttribute(
			"data-ordinal",
		);
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveTextContent(
			"Checking the final baseline now.",
		);
	},
};
export const LivePendingLight: Story = {
	...LivePending,
	globals: { theme: "light" },
};
export const LivePicked: Story = {
	args: { turn: liveTurn, segment: liveSegment },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("surfacing-pin-2"));
		await expect(
			canvas.getAllByRole("button", { name: "Follow latest" }),
		).toHaveLength(2);
		canvas.getByTestId("surfacing-pin-2").blur();
	},
};
export const LivePickedLight: Story = {
	...LivePicked,
	globals: { theme: "light" },
};
export const Folded: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: "Close message" }),
		);
		await expect(
			canvas.queryByTestId("surfacing-msg-card"),
		).not.toBeInTheDocument();
		await expect(canvas.getByTestId("surfacing-pin-2")).toBeVisible();
	},
};
export const FoldedLight: Story = { ...Folded, globals: { theme: "light" } };

const shortSegment: Segment = { activity: activity.slice(0, 4), reply: [] };
export const ShortTurn: Story = {
	args: { turn: { ...turn, segments: [shortSegment] }, segment: shortSegment },
};
export const ShortTurnLight: Story = {
	...ShortTurn,
	globals: { theme: "light" },
};
const quietSegment: Segment = { activity: activity.slice(0, 2), reply: [] };
export const NothingAtKey: Story = {
	args: {
		turn: { ...turn, segments: [quietSegment] },
		segment: quietSegment,
		surfacing: { ...config, status: { ...config.status, defaultLevel: "key" } },
	},
};
export const NothingAtKeyLight: Story = {
	...NothingAtKey,
	globals: { theme: "light" },
};
const failedSegment: Segment = {
	activity: [
		...activity,
		{ ...pending, surfacingOrdinal: 8, surfacingProbabilities: null },
	],
	reply: [],
};
export const NotJudged: Story = {
	args: {
		turn: { ...turn, segments: [failedSegment] },
		segment: failedSegment,
	},
};
export const NotJudgedLight: Story = {
	...NotJudged,
	globals: { theme: "light" },
};
export const OlderTurn: Story = { args: { latestTurn: false } };
export const OlderTurnLight: Story = {
	...OlderTurn,
	globals: { theme: "light" },
};
export const Override: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("radio", { name: /^Key$/ }));
		await expect(
			canvas.getByTestId("surfacing-level-default-dot"),
		).toBeVisible();
		canvas.getByRole("radio", { name: /^Key$/ }).blur();
	},
};
export const OverrideLight: Story = {
	...Override,
	globals: { theme: "light" },
};

const firstBlock: Segment = { activity: activity.slice(0, 8), reply: [] };
const laterBlock: Segment = { activity: activity.slice(8), reply: [] };
const handbackTurn: Turn = { ...turn, segments: [firstBlock, laterBlock] };
export const HandBackFirstBlock: Story = {
	args: { turn: handbackTurn, segment: firstBlock, final: false },
};
export const HandBackFirstBlockLight: Story = {
	...HandBackFirstBlock,
	globals: { theme: "light" },
};
export const HandBackLastBlock: Story = {
	args: { turn: handbackTurn, segment: laterBlock, final: true },
};
export const HandBackLastBlockLight: Story = {
	...HandBackLastBlock,
	globals: { theme: "light" },
};
const unjudgedSegment: Segment = {
	activity: [...activity, pending],
	reply: [],
};
export const SettledWithoutVerdict: Story = {
	args: {
		turn: { ...turn, segments: [unjudgedSegment] },
		segment: unjudgedSegment,
	},
};
export const SettledWithoutVerdictLight: Story = {
	...SettledWithoutVerdict,
	globals: { theme: "light" },
};
