import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { permissionsState } from "../../stores/permissions.svelte.js";
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
	args: { groupRadius: "rounded-panel" },
	argTypes: {
		groupRadius: { control: "text" },
	},
	beforeEach: () => {
		permissionsState.pendingQuestions = [];
		permissionsState.questionErrors.clear();
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
