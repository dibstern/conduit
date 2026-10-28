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
export const Compaction: Story = {
	args: { seams: [{ id: "compacted", left: 54.2, width: 0.2 }] },
	play: async ({ canvasElement }) => {
		const seam = canvasElement.querySelector('[data-step-id="compacted"]');
		if (!seam) throw new Error("Missing compaction seam");
		await expect(getComputedStyle(seam).width).toBe("2px");
		await expect(getComputedStyle(seam).height).toBe("10px");
	},
};
export const LiveFade: Story = {
	play: async ({ canvasElement }) => {
		const step = canvasElement.querySelector('[data-step-id="edit"]');
		if (!step) throw new Error("Missing live step");
		await expect(getComputedStyle(step).animationDuration).toBe("1.2s");
	},
};
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
	// Pin touch targets are taller than the fitted lane, so they reach above the root.
	tags: ["viewport-capture"],
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
		await expect(
			getComputedStyle(pin.querySelector(".pin-chip") ?? pin).height,
		).toBe("19px");
		await expect(
			canvas.getByTestId("surfacing-pins").getBoundingClientRect().height,
		).toBe(25);
		const user = userEvent.setup();
		await user.pointer({ keys: "[MouseLeft>]", target: pin });
		await expect(args["onpick"]).not.toHaveBeenCalled();
		await user.pointer({ keys: "[/MouseLeft]", target: pin });
		await expect(args["onpick"]).toHaveBeenLastCalledWith(messages.pins[1]);
		pin.focus();
		await userEvent.keyboard("{ArrowLeft}");
		await expect(canvas.getByTestId("surfacing-pin-1")).toHaveFocus();
		await userEvent.keyboard("{ArrowRight}");
		await expect(pin).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(args["onpick"]).toHaveBeenCalledTimes(2);
	},
};

export const PhonePins: Story = {
	...Pins,
	tags: ["viewport-capture"],
	args: { ...Pins.args, phone: true },
	play: async (context) => {
		await Pins.play?.(context);
		await expect(
			within(context.canvasElement)
				.getByTestId("surfacing-pin-1")
				.querySelector(".pin-number"),
		).not.toBeVisible();
	},
};
export const SelectedBelowStop: Story = {
	...Pins,
	tags: ["viewport-capture"],
	args: { ...Pins.args, belowLevel: true },
	play: async (context) => {
		await Pins.play?.(context);
		const chip = within(context.canvasElement)
			.getByTestId("surfacing-pin-1")
			.querySelector(".pin-chip");
		if (!chip) throw new Error("Missing selected chip");
		await expect(chip).toHaveClass(/below/);
		await expect(getComputedStyle(chip).boxShadow).toContain("1px");
	},
};

export const Collapsed: Story = {
	// The message peek is a floating hover card below the strip.
	tags: ["viewport-capture"],
	args: {
		// ActivityStrip keys message steps by their part, so the focused step names the pin.
		segments: [
			{
				id: "message-1",
				kind: "message",
				left: 0,
				width: 34,
				label: "Message 1",
				tone: "text",
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
				id: "message-2",
				kind: "message",
				left: 59.6,
				width: 40.4,
				label: "Message 2",
				tone: "text",
			},
		],
		cardSlot: messages.card
			? { kind: "preview", card: messages.card }
			: { kind: "none" },
		markers: { kind: "dots", mode: "collapsed", dots: messages.messages },
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
