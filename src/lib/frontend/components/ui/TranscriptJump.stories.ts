import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import TranscriptJump from "./TranscriptJump.svelte";

const meta = {
	title: "UI/TranscriptJump",
	component: TranscriptJump,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { live: true, onclick: fn() },
} satisfies Meta<typeof TranscriptJump>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {
	play: async ({ canvasElement, args }) => {
		const jump = within(canvasElement).getByRole("button", {
			name: "Jump to live",
		});
		await expect(jump).toBeVisible();
		await userEvent.click(jump);
		await expect(args["onclick"]).toHaveBeenCalledOnce();
		// Capture the resting pill, not the focus ring the click leaves behind.
		jump.blur();
	},
};
export const LiveLight: Story = { ...Live, globals: { theme: "light" } };
export const Latest: Story = { args: { live: false } };
export const LatestLight: Story = { ...Latest, globals: { theme: "light" } };
