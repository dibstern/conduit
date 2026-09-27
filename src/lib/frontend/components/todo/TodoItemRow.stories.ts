import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
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
		// The spinner must be frozen or the capture is flaky. A silent no-op here
		// (renamed class) would reintroduce that flake, so assert before freezing.
		const icon = canvasElement.querySelector<HTMLElement>(
			".todo-icon-progress",
		);
		expect(icon).not.toBeNull();
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
