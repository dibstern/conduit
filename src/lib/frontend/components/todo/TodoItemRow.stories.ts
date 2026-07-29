import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockTodoCancelled,
	mockTodoCompleted,
	mockTodoInProgress,
	mockTodoPending,
} from "../../stories/mocks.js";
import TodoItemRow from "./TodoItemRow.svelte";

const meta = {
	title: "Todo/TodoItemRow",
	component: TodoItemRow,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
} satisfies Meta<typeof TodoItemRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		item: mockTodoPending,
	},
};

export const InProgress: Story = {
	args: {
		item: mockTodoInProgress,
	},
	play: ({ canvasElement }) => {
		const icon = canvasElement.querySelector<HTMLElement>(
			".todo-icon-progress",
		);
		if (icon) icon.style.animation = "none";
	},
};

export const Completed: Story = {
	args: {
		item: mockTodoCompleted,
	},
};

export const Cancelled: Story = {
	args: {
		item: mockTodoCancelled,
	},
};
