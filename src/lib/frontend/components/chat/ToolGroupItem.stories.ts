import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
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
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvasElement.querySelector(".tool-result")).toHaveTextContent(
			"authenticate(token: string)",
		);
	},
};

export const ExpandedBashCommand: Story = {
	args: { message: mockToolBash },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvasElement.querySelector(".tool-result")).toHaveTextContent(
			"git rev-parse HEAD",
		);
	},
};

export const ExpandedError: Story = {
	args: { message: mockToolError },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvasElement.querySelector(".tool-result")).toHaveTextContent(
			"ENOENT",
		);
	},
};

export const ExpandedTruncatedResult: Story = {
	args: { message: mockToolTruncated, isLast: true },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(
			canvas.getByRole("button", { name: "Show full output" }),
		).toBeVisible();
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
