import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockUserMessage,
	mockUserMessageLong,
	mockUserMessageShort,
} from "../../stories/mocks.js";
import UserMessage from "./UserMessage.svelte";

const meta = {
	title: "Chat/UserMessage",
	component: UserMessage,
	tags: ["autodocs"],
} satisfies Meta<typeof UserMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockUserMessage },
};

export const ShortText: Story = {
	args: { message: mockUserMessageShort },
};

export const LongText: Story = {
	args: { message: mockUserMessageLong },
};
