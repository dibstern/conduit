import type { Meta, StoryObj } from "@storybook/svelte-vite";
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
		uiState.sidebarPanel = "sessions";
		uiState.mobileSidebarOpen = false;
	},
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	beforeEach: () => {
		uiState.sidebarPanel = "sessions";
	},
};

export const FileBrowserPanel: Story = {
	beforeEach: () => {
		uiState.sidebarPanel = "files";
	},
};

export const MobileOpen: Story = {
	parameters: {
		viewport: { defaultViewport: "mobile1" },
	},
	beforeEach: () => {
		uiState.mobileSidebarOpen = true;
	},
};
