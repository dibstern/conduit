import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { uiState } from "../../stores/ui.svelte.js";
import Sidebar from "./Sidebar.svelte";

const meta = {
	title: "Layout/Sidebar",
	component: Sidebar,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Reset state for each story
		uiState.sidebarCollapsed = false;
	},
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getAllByRole("button", { name: "New session" })[0],
		).toBeVisible();
		await expect(
			canvas.queryByRole("button", { name: "File browser" }),
		).toBeNull();
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
