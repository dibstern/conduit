import type { Meta, StoryObj } from "@storybook/svelte-vite";
import TodoProgressBar from "./TodoProgressBar.svelte";

const meta = {
	title: "Todo/TodoProgressBar",
	component: TodoProgressBar,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	args: {
		percentage: 60,
	},
} satisfies Meta<typeof TodoProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ZeroPercent: Story = {
	args: {
		percentage: 0,
	},
};

export const Complete: Story = {
	args: {
		percentage: 100,
	},
};
