import type { Meta, StoryObj } from "@storybook/svelte-vite";
import BlockGrid from "./BlockGrid.svelte";

const meta = {
	title: "Shared/BlockGrid",
	component: BlockGrid,
	tags: ["autodocs"],
	argTypes: {
		cols: { control: { type: "range", min: 3, max: 10, step: 1 } },
		mode: { control: "select", options: ["static", "animated", "fast"] },
		blockSize: { control: { type: "range", min: 1, max: 12, step: 0.5 } },
		gap: { control: { type: "range", min: 0.5, max: 4, step: 0.5 } },
		glow: { control: "boolean" },
	},
} satisfies Meta<typeof BlockGrid>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Static10: Story = {
	args: { cols: 10, mode: "static", blockSize: 3.5, gap: 1.5 },
};
export const Animated10: Story = {
	args: { cols: 10, mode: "animated", blockSize: 8, gap: 3, glow: true },
};
export const Fast5Spinner: Story = {
	args: { cols: 5, mode: "fast", blockSize: 2, gap: 0.75 },
};
export const Static5: Story = {
	args: { cols: 5, mode: "static", blockSize: 3.5, gap: 1.5 },
};
export const Animated5: Story = {
	args: { cols: 5, mode: "animated", blockSize: 6, gap: 2, glow: true },
};
export const Large10Loading: Story = {
	args: { cols: 10, mode: "animated", blockSize: 10, gap: 3, glow: true },
};
