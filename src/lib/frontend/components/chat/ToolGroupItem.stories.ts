import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { userEvent, within } from "storybook/test";
import {
	mockToolBash,
	mockToolCompleted,
	mockToolError,
	mockToolReadWithOffset,
	mockToolTruncated,
} from "../../stories/mocks.js";
import ToolGroupItem from "./ToolGroupItem.svelte";

const meta = {
	title: "Chat/ToolGroupItem",
	component: ToolGroupItem,
	tags: ["autodocs"],
	argTypes: {
		isLast: { control: "boolean" },
	},
} satisfies Meta<typeof ToolGroupItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockToolReadWithOffset },
};

export const LastInGroup: Story = {
	args: { message: mockToolReadWithOffset, isLast: true },
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

export const ExpandedError: Story = {
	args: { message: mockToolError },
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole("button"));
	},
};

export const ExpandedTruncatedResult: Story = {
	args: { message: mockToolTruncated, isLast: true },
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole("button"));
	},
};
