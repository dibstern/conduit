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
		// Freeze the packet for a repeatable visual capture.
		const icon = canvasElement.querySelector<HTMLElement>(
			".todo-icon-progress",
		);
		expect(icon).not.toBeNull();
		const glyph = icon?.querySelector('[data-flow-glyph="running"]');
		expect(glyph).toBeVisible();
		const packet = glyph?.querySelector<SVGElement>("[data-flow-packet]");
		expect(packet).not.toBeNull();
		if (packet) packet.style.animation = "none";
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
