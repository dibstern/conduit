import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockSystemError,
	mockSystemErrorWithDetails,
	mockSystemInfo,
} from "../../stories/mocks.js";
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

export const WithDetails: Story = {
	args: { message: mockSystemErrorWithDetails },
};

/**
 * Hovers the details-bearing card, not the plain info card. The info card has no
 * hover treatment by design — it is inert — so a hover story over it captured a
 * frame byte-identical to Info and asserted nothing (conduit-test-wzat).
 */
export const Hover: Story = {
	...WithDetails,
	parameters: { pseudo: { hover: true } },
};
