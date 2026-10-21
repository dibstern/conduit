import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import {
	getOrCreateSessionMessages,
	sessionMessages,
} from "../../stores/chat.svelte.js";
import { setSessionSurfaceLevel } from "../../stores/message-surfacing.svelte.js";
import { reveal, revealedPart } from "../../stores/reveal.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { setTurnMinimised } from "../../stores/turn-minimisation.svelte.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import type { ActivityPart, Segment, Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

const SESSION = "minimise-story-session";
const START = Date.now() - 900_000;
const descriptions = [
	[
		1,
		"finding",
		"The routing table has three consumers, including the push deep link.",
	],
	[2, "ask", "Recapture the phone baseline, or keep the old paint order?"],
	[3, "decision", "I will preserve the old route for one release."],
	[4, "routine", "Reading the next file before checking the schema."],
	[5, "risk", "One subscription per session could exhaust the socket budget."],
] as const;
function segment(read: boolean): Segment {
	const activity: ActivityPart[] = descriptions.flatMap(
		([ordinal, category, text], index) => [
			{
				type: "assistant",
				uuid: `minimise-agent/part-${ordinal}`,
				messageId: "minimise-agent",
				partId: `part-${ordinal}`,
				rawText: text,
				html: `<p>${text}</p>`,
				finalized: true,
				surfacingOrdinal: ordinal,
				surfacingProbabilities: { [category]: 1 },
				surfacingRead: read,
				createdAt: START + index * 120_000,
			},
			{
				type: "thinking",
				uuid: `minimise-thinking-${ordinal}`,
				text: "Checking the route",
				done: true,
				duration: 1_000,
				createdAt: START + index * 120_000 + 30_000,
			},
		],
	);
	return { activity, reply: [] };
}
const unread = segment(false);
const read = segment(true);
const turn: Turn = {
	id: "minimise-story-turn",
	user: {
		type: "user",
		uuid: "minimise-story-turn",
		text: "Review session routing.",
		createdAt: START,
	},
	segments: [unread],
	notices: [],
	live: false,
};
const config = {
	status: {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		summariesEnabled: true,
		enabled: true,
		active: true,
		key: { source: "stored" as const, rejected: false },
	},
	categorySet: DEFAULT_CATEGORY_SET,
};
const minimisedConfig = {
	...config,
	status: { ...config.status, turnsOpen: "minimised" as const },
};

const meta = {
	title: "Chat/Surfacing Minimise",
	component: TurnActivity,
	parameters: { layout: "padded" },
	args: {
		turn,
		segment: unread,
		final: true,
		sessionId: SESSION,
		providerId: "claude",
		surfacing: config,
		onMessagesRead: async () => {},
	},
	beforeEach: () => {
		setSessionSurfaceLevel(SESSION, null);
		setTurnMinimised(SESSION, turn.id, null);
		const previousSession = sessionState.currentId;
		const previousMessages = sessionMessages.get(SESSION);
		const cleanup = [connectedSocket(), replyRpc("ListRecaps", () => [])];
		return () => {
			for (const restore of cleanup.reverse()) restore();
			setTurnMinimised(SESSION, turn.id, null);
			revealedPart.request = null;
			openSessionForSetup(previousSession);
			if (previousMessages) sessionMessages.set(SESSION, previousMessages);
			else sessionMessages.delete(SESSION);
		};
	},
} satisfies Meta<typeof TurnActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

// The visual suite captures each story at desktop and phone widths.
export const Minimised: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: "Minimise turn" }),
		);
		await expect(canvas.getByTestId("surfacing-thin-track")).toHaveStyle({
			height: "4px",
		});
		await expect(canvas.queryByTestId("surfacing-msg-card")).toBeNull();
		await expect(canvas.queryByTestId("surfacing-pins")).toBeNull();
		await expect(
			canvas.getAllByTestId("surfacing-minimised-unread"),
		).toHaveLength(4);
		await expect(canvas.getByTestId("surfacing-minimised-ask")).toBeVisible();
		await expect(
			canvas.getByTestId("surfacing-summary-generate"),
		).toBeVisible();
		canvas.getByTestId("surfacing-card").blur();
	},
};
export const MinimisedLight: Story = {
	...Minimised,
	globals: { theme: "light" },
};

export const Peek: Story = {
	tags: ["viewport-capture"],
	args: { surfacing: minimisedConfig },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const strip = canvas.getByTestId("surfacing-minimised-strip");
		const dot = canvas
			.getByTestId("surfacing-minimised-ask")
			.getBoundingClientRect();
		await userEvent.pointer({
			target: strip,
			coords: {
				clientX: dot.x + dot.width / 2,
				clientY: dot.y + dot.height / 2,
			},
		});
		await expect(
			canvas.getByTestId("surfacing-minimised-peek"),
		).toHaveAttribute("data-ordinal", "2");
		await expect(
			canvas.getByTestId("surfacing-minimised-peek"),
		).toHaveTextContent("Click to open");
		await expect(
			canvas.getByRole("button", { name: "Expand turn" }),
		).toHaveAttribute("aria-expanded", "false");
	},
};
// The indexer reads tags statically, so the spread does not carry Peek's tag.
export const PeekLight: Story = {
	...Peek,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const AutoOlder: Story = {
	args: {
		turn: { ...turn, segments: [read] },
		segment: read,
		latestTurn: false,
		newestSettledTurn: false,
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByRole("button", {
				name: "Expand turn",
			}),
		).toBeVisible();
	},
};
export const AutoOlderLight: Story = {
	...AutoOlder,
	globals: { theme: "light" },
};

export const HandExpanded: Story = {
	args: { surfacing: minimisedConfig },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		canvas.getByTestId("surfacing-card").focus();
		await userEvent.keyboard("h");
		await expect(
			canvas.getByRole("button", { name: "Minimise turn" }),
		).toBeVisible();
		await expect(canvas.getByTestId("surfacing-msg-card")).toBeVisible();
		canvas.getByTestId("surfacing-card").blur();
	},
};
export const HandExpandedLight: Story = {
	...HandExpanded,
	globals: { theme: "light" },
};

export const MessageDestination: Story = {
	args: { surfacing: minimisedConfig },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		canvasElement.dataset["sessionId"] = SESSION;
		openSessionForSetup(SESSION);
		getOrCreateSessionMessages(SESSION).messages = unread.activity.filter(
			(part) => part.type !== "system",
		);
		// UUID destinations and message/part citations both enter through reveal().
		await expect(
			await reveal({ sessionId: SESSION, uuid: "minimise-agent/part-1" }),
		).toBe("landed");
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveAttribute(
			"data-ordinal",
			"1",
		);
		setTurnMinimised(SESSION, turn.id, true);
		await expect(
			await reveal({
				sessionId: SESSION,
				messageId: "minimise-agent",
				partId: "part-4",
			}),
		).toBe("landed");
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveAttribute(
			"data-ordinal",
			"4",
		);
		await expect(
			canvas.getByRole("button", { name: "Minimise turn" }),
		).toBeVisible();
	},
};
export const MessageDestinationLight: Story = {
	...MessageDestination,
	globals: { theme: "light" },
};
