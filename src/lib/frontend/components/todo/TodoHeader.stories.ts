import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import TodoHeader from "./TodoHeader.svelte";

const meta = {
	title: "Todo/TodoHeader",
	component: TodoHeader,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		completed: 2,
		total: 5,
		collapsed: false,
		onToggle: fn(),
	},
} satisfies Meta<typeof TodoHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Collapsed: Story = {
	args: {
		collapsed: true,
	},
};
