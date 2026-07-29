import type { Meta, StoryObj } from "@storybook/svelte-vite";
import ContextBar from "./ContextBar.svelte";

const meta = {
	title: "Input/ContextBar",
	component: ContextBar,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { percent: 32 },
	argTypes: {
		percent: { control: { type: "range", min: 0, max: 100, step: 1 } },
	},
} satisfies Meta<typeof ContextBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Warning: Story = {
	args: { percent: 50 },
};

export const High: Story = {
	args: { percent: 80 },
};
