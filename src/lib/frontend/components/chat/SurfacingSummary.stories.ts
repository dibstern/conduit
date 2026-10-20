import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import type { TurnRecap } from "../../../contracts/turn-recap.js";
import { type SurfacePart, surfaceTurn } from "../../utils/surface-turn.js";
import SurfacingSummary from "./SurfacingSummary.svelte";

const START = 1_800_000_000_000;
const parts: SurfacePart[] = [
	["finding", "The unread counter has three consumers."],
	["ask", "Recapture the phone sidebar, or keep the old paint order?"],
	["decision", "I will keep the legacy route for one release."],
	["risk", "One stream per session would exhaust the socket budget."],
	["milestone", "The typed stream is wired into the sidebar."],
	["finding", "The deep link now waits for history."],
].map(([category = "finding", rawText = ""], index) => ({
	type: "assistant",
	uuid: `recap-message-${index + 1}`,
	rawText,
	html: `<p>${rawText}</p>`,
	finalized: true,
	surfacingOrdinal: index + 1,
	surfacingProbabilities: { [category]: 1 },
	surfacingRead: index <= 1,
	createdAt: START + index * 120_000,
}));
const view = surfaceTurn({
	parts,
	positions: parts.map((_, index) => ({ left: index * 16, width: 16 })),
	categorySet: DEFAULT_CATEGORY_SET,
	level: "balanced",
	live: false,
	latestTurn: true,
	picked: null,
	folded: null,
	start: START,
});
const whole: TurnRecap = {
	sessionId: "recap-story",
	turnId: "recap-turn",
	version: 1,
	scope: "whole",
	firstOrdinal: 1,
	lastOrdinal: 4,
	text: "The job grew: the unread counter has three consumers [#1]. The phone sidebar needs your decision on a 2px shift [#2]. The agent kept the legacy route for a release [#3] and batched the subscriptions to avoid exhausting sockets [#4].",
	model: "sonnet",
	durationMs: 1600,
	createdAt: START + 600_000,
};
const newer: TurnRecap = {
	...whole,
	version: 2,
	scope: "new",
	firstOrdinal: 5,
	lastOrdinal: 6,
	text: "The sidebar is on the typed stream [#5]. Push deep links now wait for history, fixing the empty flash on iOS [#6].",
	createdAt: START + 900_000,
};
const meta = {
	title: "Chat/Surfacing Summary",
	component: SurfacingSummary,
	parameters: { layout: "padded", docs: { story: { inline: false } } },
	args: {
		versions: [whole, newer],
		selected: newer,
		open: true,
		live: false,
		view,
		start: START,
		settings: { model: "sonnet", when: "on-request" },
		onclose: fn(),
		onversion: fn(),
		ongenerate: fn(),
		onretry: fn(),
		onsettings: fn(),
		oncite: fn(),
		onreply: fn(),
		onquote: fn(),
	},
} satisfies Meta<typeof SurfacingSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every state is captured at desktop and mobile, in both themes. */
export const NewSinceLast: Story = {
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("surfacing-summary"),
		).toBeVisible();
		await expect(
			within(canvasElement).getByTestId("surfacing-recap-cite-5"),
		).toHaveAttribute("data-unread", "true");
	},
};
export const NewSinceLastLight: Story = {
	...NewSinceLast,
	globals: { theme: "light" },
};
export const WholeTurn: Story = {
	args: {
		versions: [{ ...whole, lastOrdinal: 6 }],
		selected: { ...whole, lastOrdinal: 6 },
	},
};
export const WholeTurnLight: Story = {
	...WholeTurn,
	globals: { theme: "light" },
};
export const Stale: Story = {
	args: { versions: [whole], selected: whole },
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("surfacing-summary-new"),
		).toHaveTextContent("Summarize 2 new");
	},
};
export const StaleLight: Story = { ...Stale, globals: { theme: "light" } };
export const Generating: Story = {
	...WholeTurn,
	args: { ...WholeTurn.args, generating: true, live: true },
};
export const GeneratingLight: Story = {
	...Generating,
	globals: { theme: "light" },
};
export const Failed: Story = {
	...WholeTurn,
	args: {
		...WholeTurn.args,
		error: "Claude is not signed in. Run claude to sign in.",
	},
};
export const FailedLight: Story = { ...Failed, globals: { theme: "light" } };
export const Unwritten: Story = {
	args: { versions: [], selected: undefined, live: true },
};
export const UnwrittenLight: Story = {
	...Unwritten,
	globals: { theme: "light" },
};

export const CitedMessage: Story = {
	...WholeTurn,
	// The desktop citation reader is a popover outside the story root.
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await within(canvasElement).getByTestId("surfacing-recap-cite-2").click();
		const reader = within(document.body).getByTestId("surfacing-recap-reader");
		await expect(reader).toBeVisible();
		await expect(reader).toHaveTextContent(
			"Recapture the phone sidebar, or keep the old paint order?",
		);
	},
};
export const CitedMessageLight: Story = {
	...CitedMessage,
	// Storybook indexes tags statically, so the spread does not carry them.
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
/** ↩ Reply on a cited message references it whole, and stays pressed while the draft does. */
export const CitedReplied: Story = {
	...WholeTurn,
	args: { ...WholeTurn.args, replies: new Map([[2, 0]]) },
	tags: ["viewport-capture"],
	play: async ({ args, canvasElement }) => {
		await within(canvasElement).getByTestId("surfacing-recap-cite-2").click();
		const reply = within(
			within(document.body).getByTestId("surfacing-recap-reader"),
		).getByRole("button", { name: "Reply" });
		await expect(reply).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(reply);
		await expect(args["onreply"]).toHaveBeenCalledWith(2, undefined);
		// Capture the resting pressed pill, not its focus ring.
		reply.blur();
	},
};
export const CitedRepliedLight: Story = {
	...CitedReplied,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

const QUOTE = "The job grew: the unread counter has three consumers";
function selectProse(canvasElement: HTMLElement) {
	const prose = canvasElement.querySelector(".summary-prose");
	const node = [...(prose?.childNodes ?? [])].find((child) =>
		child.textContent?.startsWith(QUOTE),
	);
	if (!node) throw new Error("Recap prose moved");
	const range = document.createRange();
	range.setStart(node, 0);
	range.setEnd(node, QUOTE.length);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
}

/** Selected recap words offer ❝ Reply to this, which quotes exactly the selection. */
export const RecapQuote: Story = {
	...WholeTurn,
	play: async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		selectProse(canvasElement);
		await userEvent.click(
			await canvas.findByRole("button", { name: "Reply to this" }),
		);
		await expect(args["onquote"]).toHaveBeenCalledWith(QUOTE);
		await expect(
			canvas.queryByRole("button", { name: "Reply to this" }),
		).toBeNull();
		selectProse(canvasElement);
		await canvas.findByRole("button", { name: "Reply to this" });
	},
};
export const RecapQuoteLight: Story = {
	...RecapQuote,
	globals: { theme: "light" },
};
