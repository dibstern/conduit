import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import { DEFAULT_CATEGORY_SET } from "../../../contracts/category-set.js";
import { type SurfacePin, surfaceTurn } from "../../utils/surface-turn.js";
import ActivityTimeline from "./ActivityTimeline.svelte";

const meta = {
	title: "UI/ActivityTimeline",
	component: ActivityTimeline,
	parameters: { layout: "padded" },
	args: {
		segments: [
			{
				id: "read",
				left: 0,
				width: 34,
				label: "Read src/unread.ts · 4s",
				tone: "explore",
			},
			{
				id: "thought",
				left: 34.2,
				width: 20,
				label: "Thought for 3s",
				tone: "thinking",
			},
			{
				id: "error",
				left: 54.4,
				width: 5,
				label: "Failed pnpm check · 1s",
				tone: "fail",
			},
			{
				id: "edit",
				left: 59.6,
				width: 40.4,
				label: "Editing src/unread.ts",
				tone: "live",
				running: true,
			},
		],
		onjump: fn(),
	},
} satisfies Meta<typeof ActivityTimeline>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Keyboard: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const track = canvas.getByRole("slider", { name: /Activity timeline/ });
		track.focus();
		await userEvent.keyboard("{ArrowRight}");
		await expect(track).toHaveAttribute("aria-valuetext", "Thought for 3s");
		await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
		await expect(track).toHaveAttribute(
			"aria-valuetext",
			"Read src/unread.ts · 4s",
		);
		await expect(track).toHaveFocus();
		await expect(track.matches(":focus-visible")).toBe(true);
	},
};
export const TouchScrub: Story = {
	play: async ({ canvasElement, args }) => {
		const track = within(canvasElement).getByRole("slider");
		const rect = track.getBoundingClientRect();
		const coords = { clientY: rect.top + rect.height / 2 };
		await userEvent.pointer([
			{
				keys: "[TouchA>]",
				target: track,
				coords: { ...coords, clientX: rect.left + rect.width * 0.1 },
			},
			{
				pointerName: "TouchA",
				target: track,
				coords: { ...coords, clientX: rect.left + rect.width * 0.56 },
			},
			{
				keys: "[/TouchA]",
				target: track,
				coords: { ...coords, clientX: rect.left + rect.width * 0.56 },
			},
		]);
		await expect(args["onjump"]).toHaveBeenLastCalledWith("error");
		await expect(track).toHaveAttribute(
			"aria-valuetext",
			"Failed pnpm check · 1s",
		);
	},
};

const messages = surfaceTurn({
	parts: [1, 2].map((number) => ({
		type: "assistant" as const,
		uuid: `message-${number}`,
		rawText: `Message ${number}`,
		html: `<p>Message ${number}</p>`,
		finalized: true,
		surfacingOrdinal: number,
		surfacingRead: false,
		surfacingProbabilities: { finding: 1 },
	})),
	positions: [
		{ left: 0, width: 34 },
		{ left: 59.6, width: 40.4 },
	],
	categorySet: DEFAULT_CATEGORY_SET,
	level: "all",
	view: { kind: "show", stop: "all" },
	live: false,
	latestTurn: true,
	start: 0,
	selection: { kind: "picked", uuid: "message-1" },
});

export const Pins: Story = {
	args: {
		cardSlot: messages.card
			? { kind: "selected", card: messages.card }
			: { kind: "none" },
		card: createRawSnippet(() => ({
			render: () =>
				'<div class="border border-border rounded-xl bg-bg p-3">Selected message</div>',
		})),
		markers: {
			kind: "pins",
			pins: messages.pins,
			selected: "message-1",
			thumbX: 17,
		},
		sliderText: messages.sliderText,
		onpick: fn(),
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole("slider")).toHaveAccessibleName(
			"Surfaced messages",
		);
		await expect(canvas.getByTestId("surfacing-pin-1")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		const pin = canvas.getByTestId("surfacing-pin-2");
		const user = userEvent.setup();
		await user.pointer({ keys: "[MouseLeft>]", target: pin });
		await expect(args["onpick"]).not.toHaveBeenCalled();
		await user.pointer({ keys: "[/MouseLeft]", target: pin });
		await expect(args["onpick"]).toHaveBeenLastCalledWith(messages.pins[1]);
		pin.focus();
		await userEvent.keyboard("{Enter}");
		await expect(args["onpick"]).toHaveBeenCalledTimes(2);
	},
};

export const Collapsed: Story = {
	args: {
		cardSlot: messages.card
			? { kind: "preview", card: messages.card }
			: { kind: "none" },
		markers: { kind: "dots", dots: messages.messages },
		preview: createRawSnippet<[SurfacePin]>((pin) => ({
			render: () =>
				`<span>#${pin().number} · ${pin().part.rawText} · Click to open</span>`,
		})),
		onpick: fn(),
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const strip = canvas.getByRole("slider");
		strip.focus();
		await waitFor(() =>
			expect(canvas.getByTestId("surfacing-minimised-peek")).toHaveTextContent(
				"Message 1",
			),
		);
		await userEvent.keyboard("{Enter}");
		await expect(args["onpick"]).toHaveBeenLastCalledWith(messages.messages[0]);
	},
};
