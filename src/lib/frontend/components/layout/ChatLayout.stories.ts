import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { routerState } from "../../stores/router.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import ChatLayout from "./ChatLayout.svelte";

const meta = {
	title: "Layout/ChatLayout",
	component: ChatLayout,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Reset state for each story
		uiState.sidebarCollapsed = false;
		uiState.rewindActive = false;
		routerState.path = "/p/test-project/";
	},
} satisfies Meta<typeof ChatLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SidebarCollapsed: Story = {
	beforeEach: () => {
		uiState.sidebarCollapsed = true;
	},
};

export const WithRewindBanner: Story = {
	beforeEach: () => {
		uiState.rewindActive = true;
	},
};
