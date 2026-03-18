import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockThinkingActive,
	mockThinkingDone,
	mockThinkingLong,
} from "../../stories/mocks.js";
import ThinkingBlock from "./ThinkingBlock.svelte";

const meta = {
	title: "Chat/ThinkingBlock",
	component: ThinkingBlock,
	tags: ["autodocs"],
} satisfies Meta<typeof ThinkingBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {
	args: { message: mockThinkingActive },
};

export const Completed: Story = {
	args: { message: mockThinkingDone },
};

export const LongDuration: Story = {
	args: { message: mockThinkingLong },
};
