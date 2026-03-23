import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockSession,
	mockSessionLongTitle,
	mockSessionProcessing,
} from "../../stories/mocks.js";
import SessionItem from "./SessionItem.svelte";

const meta = {
	title: "Session/SessionItem",
	component: SessionItem,
	tags: ["autodocs"],
} satisfies Meta<typeof SessionItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inactive: Story = {
	args: {
		session: mockSession,
		active: false,
	},
};

export const Active: Story = {
	args: {
		session: mockSession,
		active: true,
	},
};

export const Processing: Story = {
	args: {
		session: mockSessionProcessing,
		active: true,
	},
};

export const LongTitle: Story = {
	args: {
		session: mockSessionLongTitle,
		active: false,
	},
};

export const WithContextMenu: Story = {
	args: {
		session: mockSession,
		active: false,
	},
};
