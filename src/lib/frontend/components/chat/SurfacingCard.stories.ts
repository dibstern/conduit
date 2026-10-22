import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { createRawSnippet, tick } from "svelte";
import { encodeReference } from "../../../composer-references.js";
import {
	BUILTIN_CATEGORIES,
	DEFAULT_CATEGORY_SET,
} from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import { setSessionSurfaceLevel } from "../../stores/message-surfacing.svelte.js";
import type { AssistantMessage } from "../../types.js";
import type { SurfaceTurn } from "../../utils/surface-turn.js";
import type { ActivityPart, Segment, Turn } from "../../utils/turns.js";
import { provideComposerDraft } from "../input/composer-reference.svelte.js";
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
	storeId: "jev-story-turn",
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
		summariesEnabled: true,
		enabled: true,
		active: true,
		key: { source: "stored" as const, rejected: false },
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

const categoryActivity: ActivityPart[] = BUILTIN_CATEGORIES.map(
	(category, index) => ({
		type: "assistant",
		uuid: `category-colours-${category.id}`,
		messageId: "category-colours",
		partId: category.id,
		rawText: category.criteria.what,
		html: `<p>${category.criteria.what}</p>`,
		finalized: true,
		surfacingOrdinal: index + 1,
		surfacingProbabilities: { [category.id]: 1 },
		createdAt: START + index * 120_000,
	}),
);
const categorySegment: Segment = { activity: categoryActivity, reply: [] };

export const AllCategories: Story = {
	args: {
		turn: { ...turn, segments: [categorySegment] },
		segment: categorySegment,
		surfacing: { ...config, status: { ...config.status, defaultLevel: "all" } },
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const colours = new Set<string>();
		for (const [index, category] of BUILTIN_CATEGORIES.entries()) {
			await userEvent.click(canvas.getByTestId(`surfacing-pin-${index + 1}`));
			const card = canvas.getByTestId("surfacing-msg-card");
			await expect(card).toHaveTextContent(category.label);
			const glyph = card.querySelector(".type-label .glyph");
			if (!glyph) throw new Error(`Missing ${category.id} glyph`);
			const hex = getComputedStyle(canvasElement.ownerDocument.documentElement)
				.getPropertyValue(`--color-cat-${category.id}`)
				.trim();
			const channels = hex
				.slice(1)
				.match(/../g)
				?.map((channel) => parseInt(channel, 16));
			await expect(getComputedStyle(glyph).color).toBe(
				`rgb(${channels?.join(", ")})`,
			);
			colours.add(getComputedStyle(glyph).color);
		}
		await expect(colours.size).toBe(9);
		(canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
	},
};
export const AllCategoriesLight: Story = {
	...AllCategories,
	globals: { theme: "light" },
};

// The design's 34-message turn: ordinal, seconds into the turn, category.
const DESIGN_TURN = (
	"1 102 finding,2 140 finding,3 190 scope,4 245 finding,5 330 milestone,6 415 decision,7 490 finding,8 560 blocked,9 588 replan,10 662 finding," +
	"11 765 decision,12 870 correction,13 980 blocked,14 1050 finding,15 1145 risk,16 1210 milestone,17 1265 correction,18 1360 decision,19 1440 finding,20 1540 risk," +
	"21 1635 milestone,22 1710 finding,23 1790 milestone,24 1862 ask,25 1935 decision,26 2020 finding,27 2090 finding,28 2130 milestone,29 2170 finding,30 2215 milestone," +
	"31 2320 finding,32 2420 decision,33 2490 decision,34 2630 milestone"
)
	.split(",")
	.map((entry) => entry.split(" "));
function denseSegment(
	messages: readonly (readonly string[])[],
	id: string,
): Segment {
	const activity = messages.map(
		([ordinal, seconds, category]): ActivityPart => ({
			type: "assistant",
			uuid: `${id}/part-${ordinal}`,
			messageId: id,
			partId: `part-${ordinal}`,
			rawText: `Update #${ordinal}.`,
			html: `<p>Update <strong>#${ordinal}</strong>.</p>`,
			finalized: true,
			surfacingOrdinal: Number(ordinal),
			surfacingProbabilities: { [category ?? "finding"]: 1 },
			createdAt: START + Number(seconds) * 1_000,
		}),
	);
	return { activity, reply: [] };
}
const designSegment = denseSegment(DESIGN_TURN, "jev-dense");
// The worst turn seen: 150 messages, a few of them urgent.
const busiestSegment = denseSegment(
	Array.from({ length: 150 }, (_, index) => [
		String(index + 1),
		String(index * 18),
		index === 23
			? "ask"
			: index % 37 === 7
				? "blocked"
				: index % 11 === 4
					? "decision"
					: index % 7 === 2
						? "milestone"
						: "finding",
	]),
	"jev-busiest",
);
export const Dense: Story = {
	args: {
		turn: { ...turn, segments: [designSegment] },
		segment: designSegment,
		surfacing: { ...config, status: { ...config.status, defaultLevel: "all" } },
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const lane = canvas.getByTestId("surfacing-pins");
		await expect(lane).toHaveAttribute("data-layout-ready", "true");
		const groups = canvas.getAllByTestId("surfacing-group");
		await expect(groups.length).toBeGreaterThan(1);
		await expect(canvas.getByTestId("surfacing-pin-24")).toHaveAttribute(
			"data-group-members",
			"24",
		);
		await expect(
			groups.some((group) =>
				/led by #\d+ Blocked/.test(group.getAttribute("aria-label") ?? ""),
			),
		).toBe(true);
		const buttons = [...lane.querySelectorAll<HTMLButtonElement>("button")];
		await expect(
			new Set(buttons.map((button) => button.dataset["row"])),
		).toEqual(new Set(["0", "1"]));
		const members = buttons.flatMap(
			(button) => button.dataset["groupMembers"]?.split(",").map(Number) ?? [],
		);
		await expect(members.sort((a, b) => a - b)).toEqual(
			Array.from(
				{ length: args["segment"]?.activity.length ?? 0 },
				(_, index) => index + 1,
			),
		);
		for (const row of ["0", "1"]) {
			const boxes = buttons
				.filter((button) => button.dataset["row"] === row)
				.map((button) => button.getBoundingClientRect())
				.sort((a, b) => a.left - b.left);
			for (const [index, box] of boxes.entries()) {
				await expect(box.left).toBeGreaterThanOrEqual(
					lane.getBoundingClientRect().left - 1,
				);
				await expect(box.right).toBeLessThanOrEqual(
					lane.getBoundingClientRect().right + 1,
				);
				if (index > 0)
					await expect(
						box.left - (boxes[index - 1]?.right ?? 0),
					).toBeGreaterThanOrEqual(9);
			}
		}
	},
};
export const DenseLight: Story = { ...Dense, globals: { theme: "light" } };
export const Busiest: Story = {
	...Dense,
	args: {
		...Dense.args,
		turn: { ...turn, segments: [busiestSegment] },
		segment: busiestSegment,
	},
};
export const BusiestLight: Story = { ...Busiest, globals: { theme: "light" } };
export const GroupCurrent: Story = {
	...Dense,
	play: async (context) => {
		await Dense.play?.(context);
		const canvas = within(context.canvasElement);
		const group = canvas.getAllByTestId("surfacing-group")[0];
		const leader = group?.dataset["groupLeader"];
		const member = group?.dataset["groupMembers"]
			?.split(",")
			.find((number) => number !== leader);
		await expect(member).toBeDefined();
		canvas.getByTestId("surfacing-scrub").focus();
		await userEvent.keyboard(
			`{Home}${"{ArrowRight}".repeat(Number(member) - 1)}`,
		);
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveAttribute(
			"data-ordinal",
			member,
		);
		await expect(group).toHaveAttribute("aria-pressed", "true");
		await expect(group?.querySelector(".pin-chip.current")).toHaveAttribute(
			"data-number",
			member,
		);
		canvas.getByTestId("surfacing-scrub").blur();
	},
};
export const GroupCurrentLight: Story = {
	...GroupCurrent,
	globals: { theme: "light" },
};
const citation = createRawSnippet<
	[SurfaceTurn, (partId: string | null) => void]
>((_view, onCite) => ({
	render: () =>
		'<p>Summary citation <button data-testid="density-citation">#22</button></p>',
	setup: (element) => {
		let hovered = false;
		const update = () =>
			onCite()(
				hovered || element.contains(document.activeElement)
					? "jev-dense/part-22"
					: null,
			);
		const controller = new AbortController();
		const options = { signal: controller.signal };
		element.addEventListener(
			"pointerenter",
			() => {
				hovered = true;
				update();
			},
			options,
		);
		element.addEventListener(
			"pointerleave",
			() => {
				hovered = false;
				update();
			},
			options,
		);
		element.addEventListener("focusin", update, options);
		element.addEventListener("focusout", update, options);
		return () => controller.abort();
	},
}));
export const GroupCited: Story = {
	...Dense,
	args: { ...Dense.args, surfacingRegions: { belowStrip: citation } },
	play: async (context) => {
		await Dense.play?.(context);
		const canvas = within(context.canvasElement);
		canvas.getByTestId("surfacing-scrub").focus();
		await userEvent.keyboard(`{Home}${"{ArrowRight}".repeat(21)}`);
		await expect(canvas.getByTestId("surfacing-msg-card")).toHaveAttribute(
			"data-ordinal",
			"22",
		);
		canvas.getByTestId("surfacing-scrub").blur();
		const footnote = within(context.canvasElement).getByTestId(
			"density-citation",
		);
		const lifted = () =>
			context.canvasElement.querySelector(
				'[data-testid="surfacing-group"][data-cited="true"] .pin-chip',
			);
		await userEvent.hover(footnote);
		await expect(lifted()).toHaveClass(/cited/);
		const pin = lifted();
		if (!pin) throw new Error("Missing cited pin");
		await expect(pin).toHaveClass(/current/);
		const inverse = new Option().style;
		inverse.color = getComputedStyle(pin).getPropertyValue("--color-bg");
		await expect(getComputedStyle(pin).color).toBe(inverse.color);
		await userEvent.unhover(footnote);
		await expect(lifted()).toBeNull();
		footnote.focus();
		await tick();
		await expect(lifted()).toHaveClass(/cited/);
	},
};
export const GroupCitedLight: Story = {
	...GroupCited,
	globals: { theme: "light" },
};
export const NarrowOverflow: Story = {
	...Busiest,
	play: async (context) => {
		const lane = within(context.canvasElement).getByTestId("surfacing-pins");
		lane.style.width = "180px";
		await waitFor(() => expect(lane).toHaveAttribute("data-lane-width", "180"));
		await Dense.play?.(context);
	},
};
export const NarrowOverflowLight: Story = {
	...NarrowOverflow,
	globals: { theme: "light" },
};
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

// The composer's draft already replies to the shown card, #7.
const repliedDraft = `Check this ${encodeReference({ kind: "message", ordinal: 7, category: "Risk", glyph: "⚠", time: "00:12", text: descriptions[6][3] })} first`;
let removedAt: number | undefined;
/** The spec's `.on` pill: pressed while the draft replies to the card, and pressing it takes that reply out. */
export const Replied: Story = {
	beforeEach: () => {
		removedAt = undefined;
		return provideComposerDraft({
			sessionId: () => "jev-story-session",
			draft: () => repliedDraft,
			insert: () => {},
			remove: (start) => {
				removedAt = start;
			},
		});
	},
	play: async ({ canvasElement }) => {
		const reply = within(canvasElement).getByRole("button", {
			name: /^Reply$/,
		});
		await expect(reply).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(reply);
		await expect(removedAt).toBe("Check this ".length);
		reply.blur();
	},
};
export const RepliedLight: Story = {
	...Replied,
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
