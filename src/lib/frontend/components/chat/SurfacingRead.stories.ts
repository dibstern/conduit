import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import { setSessionSurfaceLevel } from "../../stores/message-surfacing.svelte.js";
import type { ActivityPart, Segment, Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

const START = Date.now() - 900_000;
const messages = [
	[
		1,
		"finding",
		1,
		"The routing table has **three consumers**, including the push deep link.",
	],
	[
		2,
		"ask",
		0.95,
		"The phone baseline shifts 2px. **Recapture it, or keep the old paint order?**",
	],
	[
		3,
		"finding",
		0.6,
		"The deep link opens the session before its history loads.",
	],
	[4, "decision", 0.9, "I will preserve the old route for one release."],
	[5, "blocked", 0.95, "The missing schema prevents the next check."],
	[
		8,
		"risk",
		0.95,
		"Opening one subscription per session could exhaust the socket budget.",
	],
] as const;

function readSegment(read: readonly number[]): Segment {
	const activity: ActivityPart[] = messages.flatMap(
		([ordinal, category, probability, text], index) => [
			{
				type: "assistant",
				uuid: `read-story/part-${ordinal}`,
				messageId: "read-story",
				partId: `part-${ordinal}`,
				rawText: text,
				html: `<p>${text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`,
				finalized: true,
				surfacingOrdinal: ordinal,
				surfacingProbabilities: { [category]: probability },
				surfacingSetVersion: 1,
				surfacingModel: "jev-1.13.0",
				surfacingRead: read.includes(ordinal),
				createdAt: START + index * 120_000,
			},
			{
				type: "thinking",
				uuid: `read-thinking-${ordinal}`,
				text: "Checking the implementation",
				done: true,
				duration: 1_000,
				createdAt: START + index * 120_000 + 30_000,
			},
		],
	);
	return { activity, reply: [] };
}

const mixed = readSegment([1, 4, 8]);
const all = readSegment(messages.map(([ordinal]) => ordinal));
const unread = readSegment([]);
const turn: Turn = {
	id: "read-story-turn",
	user: {
		type: "user",
		uuid: "read-story-user",
		text: "Review the session routing.",
		createdAt: START,
	},
	segments: [mixed],
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
const summariesOff = {
	...config,
	status: {
		...config.status,
		recap: { ...config.status.recap, model: "off" as const },
	},
};
const meta = {
	title: "Chat/Surfacing Read",
	component: TurnActivity,
	parameters: { layout: "padded" },
	args: {
		turn,
		segment: mixed,
		final: true,
		providerId: "claude",
		sessionId: "read-story-session",
		surfacing: config,
		// Persistence owns read state. The fixture keeps its initial state after a timer.
		onMessagesRead: async () => {},
	},
	beforeEach: () => {
		setSessionSurfaceLevel("read-story-session", null);
	},
} satisfies Meta<typeof TurnActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The visual suite captures each story at desktop and phone widths. */
export const MixedRead: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-head-unread")).toHaveTextContent(
			"2 unread",
		);
		await expect(canvas.getByTestId("surfacing-read-toggle")).toBeChecked();
		await expect(
			canvas.queryByTestId("surfacing-mark-read"),
		).not.toBeInTheDocument();
	},
};
export const MixedReadLight: Story = {
	...MixedRead,
	globals: { theme: "light" },
};

export const Unread: Story = {
	args: { turn: { ...turn, segments: [unread] }, segment: unread },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-head-unread")).toHaveTextContent(
			"5 unread",
		);
		await expect(canvas.getByTestId("surfacing-read-toggle")).not.toBeChecked();
	},
};
export const UnreadLight: Story = { ...Unread, globals: { theme: "light" } };

export const AllRead: Story = {
	args: {
		turn: { ...turn, segments: [all] },
		segment: all,
		surfacing: summariesOff,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-head-unread")).toHaveTextContent(
			"All read ✓",
		);
		await expect(
			canvas.queryByTestId("surfacing-mark-read"),
		).not.toBeInTheDocument();
		await expect(canvas.getByTestId("surfacing-read-toggle")).toBeChecked();
	},
};
export const AllReadLight: Story = { ...AllRead, globals: { theme: "light" } };

export const RecapsOff: Story = {
	args: { surfacing: summariesOff },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-mark-read")).toHaveTextContent(
			"Mark 2 read",
		);
		await expect(canvas.getByTestId("surfacing-mark-read")).toBeEnabled();
	},
};
export const RecapsOffLight: Story = {
	...RecapsOff,
	globals: { theme: "light" },
};

export const Key: Story = {
	args: {
		surfacing: {
			...summariesOff,
			status: { ...summariesOff.status, defaultLevel: "key" },
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-head-unread")).toHaveTextContent(
			"2 unread",
		);
		await expect(canvas.getByTestId("surfacing-mark-read")).toHaveTextContent(
			"Mark 2 read",
		);
		await expect(
			canvas.queryByTestId("surfacing-pin-1"),
		).not.toBeInTheDocument();
	},
};
export const KeyLight: Story = { ...Key, globals: { theme: "light" } };

export const Final: Story = {
	args: {
		surfacing: {
			...summariesOff,
			status: { ...summariesOff.status, defaultLevel: "final" },
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("surfacing-head-unread")).toHaveTextContent(
			"All read ✓",
		);
		await expect(
			canvas.queryByTestId("surfacing-mark-read"),
		).not.toBeInTheDocument();
		await expect(
			canvas.queryByTestId("surfacing-msg-card"),
		).not.toBeInTheDocument();
		await expect(canvas.getByText("Final only · 6 hidden")).toBeVisible();
	},
};
export const FinalLight: Story = { ...Final, globals: { theme: "light" } };
