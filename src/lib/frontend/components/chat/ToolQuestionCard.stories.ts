import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { clearAllPermissions } from "../../stores/permissions.svelte.js";
import {
	mockQuestionAnswered,
	mockQuestionPending,
	mockQuestionRunning,
	mockQuestionSkipped,
} from "../../stories/mocks.js";
import ToolQuestionCard from "./ToolQuestionCard.svelte";

const meta = {
	title: "Chat/ToolQuestionCard",
	component: ToolQuestionCard,
	tags: ["autodocs"],
	beforeEach: () => {
		clearAllPermissions();
	},
} satisfies Meta<typeof ToolQuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockQuestionAnswered },
};

export const Active: Story = {
	args: { message: mockQuestionRunning },
};

export const WaitingWithoutQuestionData: Story = {
	args: { message: mockQuestionPending },
};

export const Skipped: Story = {
	args: { message: mockQuestionSkipped },
};

export const Final: Story = {
	args: {
		message: { ...mockQuestionAnswered, createdAt: 1000, endedAt: 45000 },
	},
	globals: { theme: "dark" },
};
export const FinalLight: Story = { ...Final, globals: { theme: "light" } };
export const ActiveLight: Story = { ...Active, globals: { theme: "light" } };
