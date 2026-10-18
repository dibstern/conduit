import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { AskExplanation } from "../../../contracts/ask-explanation.js";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import { setSessionSurfaceLevel } from "../../stores/message-surfacing.svelte.js";
import { connectedSocket, failRpc, replyRpc } from "../../stories/sockets.js";
import type { ActivityPart, Segment, Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

const START = Date.now() - 2_670_000;
const SETUP =
	"The visual suite caught a 2px drop on the phone sidebar only; desktop is unchanged. Cause: the unread badge now paints before the sidebar's first frame. Two ways out: recapture the phone-sidebar baseline and accept the new spacing, or hold the badge back one frame so nothing moves. I lean recapture, since the new spacing matches desktop.";
const QUESTION =
	"The phone sidebar baseline shifts 2px because the unread badge now paints before the first frame. Recapture it, or keep the old paint order? I'll carry on with the deep link meanwhile.";
const SESSION = "ask-story";
const part = (
	ordinal: number,
	category: string,
	rawText: string,
	elapsed: number,
): ActivityPart => ({
	type: "assistant",
	uuid: `ask-agent/part-${ordinal}`,
	messageId: "ask-agent",
	partId: `part-${ordinal}`,
	rawText,
	html: `<p>${rawText}</p>`,
	finalized: true,
	surfacingOrdinal: ordinal,
	surfacingProbabilities: { [category]: 1 },
	createdAt: START + elapsed,
});
const segment: Segment = {
	activity: [
		part(
			21,
			"milestone",
			"The sidebar and message list are switched over and every test passes.",
			1_600_000,
		),
		part(22, "finding", SETUP, 1_710_000),
		part(24, "ask", QUESTION, 1_862_000),
	],
	reply: [],
};
const empty: Segment = { activity: segment.activity.slice(-1), reply: [] };
const turn: Turn = {
	id: "ask-turn",
	user: {
		type: "user",
		uuid: "ask-turn",
		text: "Move the session list onto the new live-update connection.",
		createdAt: START,
	},
	segments: [segment],
	notices: [],
	live: false,
};
const explanation: AskExplanation = {
	model: "sonnet",
	soFar:
		"You asked the agent to move the session list onto the new live-update connection and remove the old code. The sidebar and message list are switched over and every test passes [#21].",
	whatCameUp:
		"On phones, the sidebar's list now sits 2 pixels lower than in its saved screenshot [#22], because the unread count shows up straight away and takes its space. Nothing is broken; it's a question of whether the new look is fine.",
	options: [
		{
			label: "Keep the new look",
			explanation:
				"The agent replaces the saved screenshot. On phones the list stays 2px lower, which matches desktop.",
			recommended: true,
		},
		{
			label: "Keep it as it was",
			explanation:
				"The unread count waits a split second before it appears, so nothing moves. Counts show up slightly later on open.",
			recommended: false,
		},
	],
	unanswered:
		"If you don't answer, the agent keeps working on push links, and the phone screenshot test stays failing until you decide [#24].",
};
const meta = {
	title: "Chat/Ask Context",
	component: TurnActivity,
	parameters: { layout: "padded" },
	args: {
		turn,
		segment,
		final: true,
		sessionId: SESSION,
		providerId: "claude",
		surfacing: {
			status: {
				...DEFAULT_MESSAGE_SURFACING_SETTINGS,
				active: true,
				enabled: true,
				recap: { model: "sonnet", when: "on-request" },
				key: { source: "stored", rejected: false },
			},
			categorySet: DEFAULT_CATEGORY_SET,
		},
		onReplyToAsk: fn(),
	},
	beforeEach: () => {
		setSessionSurfaceLevel(SESSION, null);
		const cleanup = [
			connectedSocket(),
			replyRpc("ListRecaps", () => []),
			replyRpc("ExplainAsk", () => explanation),
		];
		return () => {
			for (const restore of cleanup.reverse()) restore();
		};
	},
} satisfies Meta<typeof TurnActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Setup: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("ask-setup")).toHaveTextContent(
			"The agent explained this first",
		);
		await expect(canvas.getByTestId("ask-setup-jump")).toHaveTextContent(
			"#22 · 28:30 ›",
		);
	},
};
export const SetupLight: Story = { ...Setup, globals: { theme: "light" } };
export const NoSetup: Story = {
	args: { turn: { ...turn, segments: [empty] }, segment: empty },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("ask-setup")).toHaveTextContent(
			"No earlier explanation found.",
		);
		await expect(canvas.getByTestId("ask-explain")).toHaveAttribute(
			"data-primary",
			"true",
		);
	},
};
export const NoSetupLight: Story = { ...NoSetup, globals: { theme: "light" } };
export const Explained: Story = {
	// The app pins html and body to the viewport with overflow hidden, which
	// clips the phone capture of this taller-than-a-phone card; let it grow.
	beforeEach: () => {
		const pinned = [document.documentElement, document.body];
		for (const element of pinned) element.style.height = "auto";
		return () => {
			for (const element of pinned) element.style.height = "";
		};
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("ask-explain"));
		await expect(canvas.getByTestId("ask-explanation")).toHaveTextContent(
			"So far",
		);
		await expect(canvas.getByTestId("ask-explanation")).toHaveTextContent(
			"What came up",
		);
		await expect(canvas.getByTestId("ask-cite-22")).toBeVisible();
		const choice = canvas.getAllByRole("button", {
			name: "↩ Reply with this",
		})[0];
		if (choice) await userEvent.click(choice);
		await expect(args["onReplyToAsk"]).toHaveBeenCalledWith(
			segment.activity[2],
			"Keep the new look",
		);
		choice?.blur();
	},
};
export const ExplainedLight: Story = {
	...Explained,
	globals: { theme: "light" },
};
export const Failed: Story = {
	beforeEach: () => failRpc("ExplainAsk"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("ask-explain"));
		await expect(canvas.getByRole("alert")).toBeVisible();
		await expect(canvas.getByTestId("ask-explain")).toHaveTextContent(
			"✦ Try again",
		);
	},
};
export const FailedLight: Story = { ...Failed, globals: { theme: "light" } };
