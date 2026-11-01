import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import { getOrCreateSessionMessages } from "../../stores/chat.svelte.js";
import { reveal } from "../../stores/reveal.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { setTurnMinimised } from "../../stores/turn-minimisation.svelte.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import { expectTurnStop } from "../../stories/turn-controls.js";
import { setupTurnStory } from "../../stories/turn-setup.js";
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
	storeId: "minimise-story-turn",
	user: {
		type: "user",
		uuid: "minimise-story-turn",
		text: "Review session routing.",
		createdAt: START,
	},
	segments: [unread],
	preface: [],
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
	beforeEach: ({ args }) => {
		const previousSession = sessionState.currentId;
		const cleanup = [
			setupTurnStory({
				turn: args["turn"],
				sessionId: args["sessionId"],
				surfacing: args["surfacing"],
			}),
			connectedSocket(),
			replyRpc("ListRecaps", () => []),
		];
		return () => {
			for (const restore of cleanup.reverse()) restore();
			openSessionForSetup(previousSession);
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
			canvas.getByRole("button", { name: "Collapse turn" }),
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
			canvasElement.querySelectorAll(".dots > .unread-dot"),
		).toHaveLength(5);
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
		).toHaveTextContent(
			"Hover preview · click to open the turn on this message",
		);
		await expect(
			canvas.getByTestId("surfacing-hover-preview"),
		).toHaveTextContent(descriptions[1][2]);
		await expect(
			canvas
				.getByTestId("surfacing-hover-preview")
				.querySelectorAll("button, input, [tabindex]"),
		).toHaveLength(0);
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

export const OpenPreview: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// With pins showing, only the step strip (not the pin lane) previews a step on hover.
		const target = canvasElement.querySelector<HTMLElement>(
			'[data-step-id="minimise-agent/part-1"]',
		);
		if (!target) throw new Error("Missing message step");
		const step = target.getBoundingClientRect();
		await userEvent.pointer({
			target,
			coords: {
				clientX: step.x + step.width / 2,
				clientY: step.y + step.height / 2,
			},
		});
		await expect(canvas.getByTestId("surfacing-hover-preview")).toHaveAttribute(
			"data-ordinal",
			"1",
		);
		await expect(canvas.getByTestId("surfacing-msg-card")).not.toBeVisible();
		await expect(canvas.getByTestId("surfacing-pin-5")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		// The previewed pin's thumb is the one cursor, as in design E.
		await expect(canvas.queryByTestId("strip-hover-marker")).toBeNull();
	},
};

export const StepPopover: Story = {
	tags: ["viewport-capture"],
	args: { surfacing: minimisedConfig },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const strip = canvas.getByTestId("surfacing-minimised-strip");
		const step = canvasElement
			.querySelector('[data-step-id="minimise-thinking-1"]')
			?.getBoundingClientRect();
		if (!step) throw new Error("Missing thinking step");
		await userEvent.pointer({
			target: strip,
			coords: {
				clientX: step.x + step.width / 2,
				clientY: step.y + step.height / 2,
			},
		});
		await expect(canvas.getByTestId("turn-step-popover")).toHaveTextContent(
			"Step 2 of 10 · click to open it in the log",
		);
		await expect(canvas.queryByTestId("surfacing-hover-preview")).toBeNull();
		await expect(canvas.getByTestId("strip-hover-marker")).toBeVisible();
	},
};

const unjudged: Segment = {
	...unread,
	activity: unread.activity.map((part) => {
		if (part.uuid !== "minimise-agent/part-4" || part.type !== "assistant")
			return part;
		const { surfacingProbabilities: _never, ...unjudgedPart } = part;
		return unjudgedPart;
	}),
};

/** A settled message Jev never judged has no card, so its hover preview opens it in Full log. */
export const UnjudgedPreviewOpensLog: Story = {
	// Its own session: reveal leaves this Turn on Full log for the rest of the page.
	args: {
		turn: { ...turn, segments: [unjudged] },
		segment: unjudged,
		sessionId: "minimise-unjudged-session",
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const target = canvasElement.querySelector<HTMLElement>(
			'[data-step-id="minimise-agent/part-4"]',
		);
		if (!target) throw new Error("Missing unjudged step");
		const step = target.getBoundingClientRect();
		await userEvent.pointer({
			target,
			coords: {
				clientX: step.x + step.width / 2,
				clientY: step.y + step.height / 2,
			},
		});
		const preview = await canvas.findByRole("group", { name: "Hover preview" });
		await userEvent.pointer({ keys: "[MouseLeft]", target: preview });
		await waitFor(() => expectTurnStop(canvasElement, "log"));
		await waitFor(() =>
			expect(
				canvasElement.querySelector('[data-log-part="minimise-agent/part-4"]'),
			).toHaveFocus(),
		);
	},
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
			canvas.getByRole("button", { name: "Collapse turn" }),
		).toBeVisible();
		await expectTurnStop(canvasElement, "balanced");
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
		await expectTurnStop(canvasElement, "balanced");
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveTextContent(
			"opened directly",
		);
		await expect(
			canvas.getByRole("button", { name: "Collapse turn" }),
		).toBeVisible();
	},
};
export const MessageDestinationLight: Story = {
	...MessageDestination,
	globals: { theme: "light" },
};

export const SupersededDestination: Story = {
	args: { surfacing: minimisedConfig },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		openSessionForSetup(SESSION);
		const first = reveal({ sessionId: SESSION, uuid: "minimise-agent/part-1" });
		const second = reveal({
			sessionId: SESSION,
			uuid: "minimise-agent/part-4",
		});
		await expect(await first).toBe("missing");
		await expect(await second).toBe("landed");
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveAttribute(
			"data-ordinal",
			"4",
		);
	},
};

export const UnmountedDestination: Story = {
	args: { surfacing: minimisedConfig },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		openSessionForSetup(SESSION);
		getOrCreateSessionMessages(SESSION).messages = [
			{
				type: "user",
				uuid: "unmounted-turn",
				text: "A Turn that has no mounted panel",
			},
			...unread.activity,
		];
		await expect(
			await reveal({ sessionId: SESSION, uuid: "minimise-agent/part-1" }),
		).toBe("missing");
		await expect(
			canvas.getByRole("button", { name: "Expand turn" }),
		).toBeVisible();
		await expect(canvas.queryByTestId("surfacing-msg-card")).toBeNull();
	},
};
