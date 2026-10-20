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

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

export const Final: Story = {
	args: {
		message: { ...mockToolSubagentCompleted, createdAt: 1000, endedAt: 109000 },
	},
	globals: { theme: "dark" },
};
export const FinalLight: Story = { ...Final, globals: { theme: "light" } };
