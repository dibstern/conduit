import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
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
				tone: "muted",
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
				tone: "error",
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
		await expect(args["onjump"]).toHaveBeenLastCalledWith(2);
		await expect(track).toHaveAttribute(
			"aria-valuetext",
			"Failed pnpm check · 1s",
		);
	},
};
