import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { userEvent, within } from "storybook/test";
import {
	mockToolGroupCompleted,
	mockToolGroupError,
	mockToolGroupRunning,
} from "../../stories/mocks.js";
import ToolGroupCard from "./ToolGroupCard.svelte";

const meta = {
	title: "Chat/ToolGroupCard",
	component: ToolGroupCard,
	tags: ["autodocs"],
} satisfies Meta<typeof ToolGroupCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { group: mockToolGroupCompleted },
};

export const Running: Story = {
	args: { group: mockToolGroupRunning },
};

export const ErrorState: Story = {
	args: { group: mockToolGroupError },
};

export const Expanded: Story = {
	args: { group: mockToolGroupCompleted },
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole("button"));
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
