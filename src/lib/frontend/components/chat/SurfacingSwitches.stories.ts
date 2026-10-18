import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../contracts/message-surfacing.js";
import type { TurnRecap } from "../../../contracts/turn-recap.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import type { Segment, Turn } from "../../utils/turns.js";
import TurnActivity from "./TurnActivity.svelte";

const START = 1_800_000_000_000;
const segment: Segment = {
	activity: [
		...[
			"The routing table has three consumers.",
			"Recapture the phone baseline, or keep the old paint order?",
			"The deep link now waits for history.",
		].flatMap((text, index) => [
			{
				type: "assistant" as const,
				uuid: `split-text-${index}`,
				rawText: text,
				html: `<p>${text}</p>`,
				finalized: true,
				createdAt: START + index * 60_000,
			},
			{
				type: "thinking" as const,
				uuid: `split-thinking-${index}`,
				text: "Checking the route.",
				done: true,
				duration: 1_000,
				createdAt: START + index * 60_000 + 30_000,
			},
		]),
	],
	reply: [],
};
const turn: Turn = {
	id: "split-turn",
	user: {
		type: "user",
		uuid: "split-turn",
		text: "Review the session routing.",
		createdAt: START,
	},
	segments: [segment],
	notices: [],
	live: false,
};
const surfacing = {
	status: {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		summariesEnabled: true,
		active: false,
		key: { source: "stored" as const, rejected: false },
	},
	categorySet: DEFAULT_CATEGORY_SET,
};
const recap: TurnRecap = {
	sessionId: "split-session",
	turnId: turn.id,
	version: 1,
	scope: "whole",
	firstOrdinal: 1,
	lastOrdinal: 3,
	text: "The routing table has three consumers [#1]. The phone baseline needs a decision [#2]. The deep link waits for history [#3].",
	model: "sonnet",
	durationMs: 1600,
	createdAt: START + 180_000,
};
const meta = {
	title: "Chat/Surfacing Switches",
	component: TurnActivity,
	parameters: { layout: "padded" },
	args: {
		turn,
		segment,
		final: true,
		sessionId: "split-session",
		providerId: "claude",
		surfacing,
	},
	beforeEach: () => {
		const cleanup = [connectedSocket(), replyRpc("ListRecaps", () => [recap])];
		return () => {
			for (const restore of cleanup.reverse()) restore();
		};
	},
} satisfies Meta<typeof TurnActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

const summaryLog: NonNullable<Story["play"]> = async ({ canvasElement }) => {
	const canvas = within(canvasElement);
	const body = within(canvasElement.ownerDocument.body);
	// The head chip on wide screens, its own row on phones. The saved summary
	// loads first, so the click opens it rather than racing its auto-open.
	const trigger = await waitFor(() => {
		const visible = canvas
			.getAllByTestId("surfacing-summary-generate")
			.find((element) => element.checkVisibility());
		expect(visible).toHaveTextContent("✦ Summary");
		return visible as HTMLElement;
	});
	await expect(
		canvas.getByRole("slider", { name: /Activity timeline/ }),
	).toBeVisible();
	if (trigger.getAttribute("aria-expanded") !== "true")
		await userEvent.click(trigger);
	const citation = await body.findByTestId("surfacing-recap-cite-3");
	await expect(citation).toHaveAttribute("data-ask", "false");
	await userEvent.click(citation);
	const row = canvasElement.querySelector('[data-message-number="3"]');
	await expect(row).toBeVisible();
	await expect(row).toHaveAttribute("data-highlighted", "true");
	await expect(row?.parentElement).toHaveFocus();
	await expect(body.queryByTestId("surfacing-recap-reader")).toBeNull();
	await expect(canvas.queryByTestId("surfacing-minimise-toggle")).toBeNull();
	await expect(canvas.queryByTestId("surfacing-pins")).toBeNull();
};
export const JevOffSummariesOn: Story = { play: summaryLog };
export const JevOffSummariesOnLight: Story = {
	...JevOffSummariesOn,
	globals: { theme: "light" },
};
export const BothOff: Story = {
	args: {
		surfacing: {
			...surfacing,
			status: { ...surfacing.status, summariesEnabled: false },
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const timeline = canvas.getByRole("slider", { name: /Activity timeline/ });
		await expect(timeline).toBeVisible();
		await userEvent.click(timeline);
		const toggle = canvas.getByRole("button", { name: /^Worked/ });
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		timeline.blur();
		await expect(
			canvas.getByText("The deep link now waits for history."),
		).toBeVisible();
		await expect(
			canvasElement.querySelector("[data-message-number]"),
		).toBeNull();
		await expect(canvas.queryByTestId("surfacing-summary-generate")).toBeNull();
		await expect(canvas.queryByTestId("surfacing-minimise-toggle")).toBeNull();
	},
};
export const BothOffLight: Story = { ...BothOff, globals: { theme: "light" } };
export const NoKey: Story = {
	args: {
		surfacing: {
			...surfacing,
			status: { ...surfacing.status, key: { source: "none", rejected: false } },
		},
	},
	play: summaryLog,
};
export const NoKeyLight: Story = { ...NoKey, globals: { theme: "light" } };
