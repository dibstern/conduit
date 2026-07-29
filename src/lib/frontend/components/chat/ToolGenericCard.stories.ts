import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { userEvent, within } from "storybook/test";
import {
	mockToolBash,
	mockToolCompleted,
	mockToolError,
	mockToolPending,
	mockToolReadWithOffset,
	mockToolRunning,
	mockToolTruncated,
} from "../../stories/mocks.js";
import ToolGenericCard from "./ToolGenericCard.svelte";

const meta = {
	title: "Chat/ToolGenericCard",
	component: ToolGenericCard,
	tags: ["autodocs"],
	args: { groupRadius: "rounded-panel" },
	argTypes: {
		groupRadius: { control: "text" },
	},
} satisfies Meta<typeof ToolGenericCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockToolCompleted },
};

export const Pending: Story = {
	args: { message: mockToolPending },
};

export const Running: Story = {
	args: { message: mockToolRunning },
};

export const ErrorState: Story = {
	args: { message: mockToolError },
};

export const WithTags: Story = {
	args: { message: mockToolReadWithOffset },
};

export const ExpandedResult: Story = {
	args: { message: mockToolCompleted },
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole("button"));
	},
};

export const ExpandedBashCommand: Story = {
	args: { message: mockToolBash },
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole("button"));
	},
};

export const ExpandedTruncatedResult: Story = {
	args: { message: mockToolTruncated },
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole("button"));
	},
};
