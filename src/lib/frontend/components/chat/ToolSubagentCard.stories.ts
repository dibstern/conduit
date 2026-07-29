import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockToolSubagent,
	mockToolSubagentCompleted,
	mockToolSubagentError,
	mockToolSubagentPending,
} from "../../stories/mocks.js";
import ToolSubagentCard from "./ToolSubagentCard.svelte";

const meta = {
	title: "Chat/ToolSubagentCard",
	component: ToolSubagentCard,
	tags: ["autodocs"],
	args: { groupRadius: "rounded-panel" },
	argTypes: {
		groupRadius: { control: "text" },
	},
} satisfies Meta<typeof ToolSubagentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockToolSubagentCompleted },
};

export const Pending: Story = {
	args: { message: mockToolSubagentPending },
};

export const Running: Story = {
	args: { message: mockToolSubagent },
};

export const ErrorState: Story = {
	args: { message: mockToolSubagentError },
};
