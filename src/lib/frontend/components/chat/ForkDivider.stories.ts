import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { mockSession } from "../../stories/mocks.js";
import ForkDivider from "./ForkDivider.svelte";

const meta = {
	title: "Chat/ForkDivider",
	component: ForkDivider,
	tags: ["autodocs"],
	argTypes: {
		sourceTitle: { control: "text" },
		sourceId: { control: "text" },
	},
} satisfies Meta<typeof ForkDivider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		sourceTitle: mockSession.title,
		sourceId: mockSession.id,
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
