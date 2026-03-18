import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { mockSystemError, mockSystemInfo } from "../../stories/mocks.js";
import SystemMessage from "./SystemMessage.svelte";

const meta = {
	title: "Chat/SystemMessage",
	component: SystemMessage,
	tags: ["autodocs"],
} satisfies Meta<typeof SystemMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {
	args: { message: mockSystemInfo },
};

export const ErrorState: Story = {
	args: { message: mockSystemError },
};
