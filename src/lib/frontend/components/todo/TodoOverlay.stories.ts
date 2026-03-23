import type { Meta, StoryObj } from "@storybook/svelte-vite";
import type { TodoItem } from "../../types.js";
import TodoOverlay from "./TodoOverlay.svelte";

const pendingItems: TodoItem[] = [
	{
		id: "todo-1",
		subject: "Set up project scaffolding",
		description: "Create directory structure and config files",
		status: "pending",
	},
	{
		id: "todo-2",
		subject: "Implement authentication module",
		status: "pending",
	},
	{
		id: "todo-3",
		subject: "Write unit tests for auth",
		description: "Cover login, logout, and token refresh flows",
		status: "pending",
	},
	{
		id: "todo-4",
		subject: "Deploy to staging",
		status: "pending",
	},
];

const mixedItems: TodoItem[] = [
	{
		id: "todo-1",
		subject: "Set up project scaffolding",
		description: "Create directory structure and config files",
		status: "completed",
	},
	{
		id: "todo-2",
		subject: "Implement authentication module",
		status: "completed",
	},
	{
		id: "todo-3",
		subject: "Write unit tests for auth",
		description: "Cover login, logout, and token refresh flows",
		status: "in_progress",
	},
	{
		id: "todo-4",
		subject: "Deploy to staging",
		status: "pending",
	},
];

const completedItems: TodoItem[] = [
	{
		id: "todo-1",
		subject: "Set up project scaffolding",
		description: "Create directory structure and config files",
		status: "completed",
	},
	{
		id: "todo-2",
		subject: "Implement authentication module",
		status: "completed",
	},
	{
		id: "todo-3",
		subject: "Write unit tests for auth",
		status: "completed",
	},
	{
		id: "todo-4",
		subject: "Deploy to staging",
		status: "completed",
	},
];

const meta = {
	title: "Todo/TodoOverlay",
	component: TodoOverlay,
	tags: ["autodocs"],
} satisfies Meta<typeof TodoOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllPending: Story = {
	args: {
		items: pendingItems,
	},
};

export const MixedProgress: Story = {
	args: {
		items: mixedItems,
	},
};

export const AllComplete: Story = {
	args: {
		items: completedItems,
	},
};

export const Collapsed: Story = {
	args: {
		items: mixedItems,
	},
};
