import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { mockSession } from "../../stories/mocks.js";
import ForkDivider from "./ForkDivider.svelte";

const meta = {
	title: "Chat/ForkDivider",
	component: ForkDivider,
	tags: ["autodocs"],
	argTypes: {
		parentTitle: { control: "text" },
		parentId: { control: "text" },
	},
} satisfies Meta<typeof ForkDivider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		parentTitle: mockSession.title,
		parentId: mockSession.id,
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
