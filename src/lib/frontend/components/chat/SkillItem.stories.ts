import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	mockToolSkillCompleted,
	mockToolSkillError,
	mockToolSkillPending,
	mockToolSkillRunning,
} from "../../stories/mocks.js";
import SkillItem from "./SkillItem.svelte";

const meta = {
	title: "Chat/SkillItem",
	component: SkillItem,
	tags: ["autodocs"],
} satisfies Meta<typeof SkillItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockToolSkillCompleted },
};

export const Pending: Story = {
	args: { message: mockToolSkillPending },
};

export const Running: Story = {
	args: { message: mockToolSkillRunning },
};

export const ErrorState: Story = {
	args: { message: mockToolSkillError },
};

export const ExpandedResult: Story = {
	args: { message: mockToolSkillCompleted },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvas.getByText(/Reproduce the failure/)).toBeVisible();
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
