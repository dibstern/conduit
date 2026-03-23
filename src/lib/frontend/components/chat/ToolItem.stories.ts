import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockQuestionAnswered,
	mockQuestionPending,
	mockQuestionRunning,
	mockQuestionSkipped,
	mockToolBash,
	mockToolCompleted,
	mockToolError,
	mockToolLongResult,
	mockToolPending,
	mockToolReadWithOffset,
	mockToolRunning,
	mockToolSubagent,
	mockToolSubagentCompleted,
	mockToolWithDiff,
} from "../../stories/mocks.js";
import ToolItem from "./ToolItem.svelte";

const meta = {
	title: "Chat/ToolItem",
	component: ToolItem,
	tags: ["autodocs"],
} satisfies Meta<typeof ToolItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
	args: { message: mockToolPending },
};

export const Running: Story = {
	args: { message: mockToolRunning },
};

export const Completed: Story = {
	args: { message: mockToolCompleted },
};

export const ErrorState: Story = {
	args: { message: mockToolError },
};

export const WithDiff: Story = {
	args: { message: mockToolWithDiff },
};

export const LongResult: Story = {
	args: { message: mockToolLongResult },
};

export const FirstInGroup: Story = {
	args: {
		message: mockToolCompleted,
		isFirstInGroup: true,
		isLastInGroup: false,
	},
};

export const MiddleOfGroup: Story = {
	args: {
		message: mockToolRunning,
		isFirstInGroup: false,
		isLastInGroup: false,
	},
};

export const LastInGroup: Story = {
	args: {
		message: mockToolCompleted,
		isFirstInGroup: false,
		isLastInGroup: true,
	},
};

export const BashWithDescription: Story = {
	args: { message: mockToolBash },
};

export const ReadWithOffsetLimit: Story = {
	args: { message: mockToolReadWithOffset },
};

export const QuestionRunning: Story = {
	args: { message: mockQuestionRunning },
};

export const QuestionAnswered: Story = {
	args: { message: mockQuestionAnswered },
};

export const QuestionSkipped: Story = {
	args: { message: mockQuestionSkipped },
};

export const QuestionPending: Story = {
	args: { message: mockQuestionPending },
};

export const SubagentRunning: Story = {
	args: { message: mockToolSubagent },
};

export const SubagentCompleted: Story = {
	args: { message: mockToolSubagentCompleted },
};
