import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { routerState } from "../../stores/router.svelte.js";
import { terminalState } from "../../stores/terminal.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { wsState } from "../../stores/ws.svelte.js";
import Header from "./Header.svelte";

const meta = {
	title: "Layout/Header",
	component: Header,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Reset state for each story
		wsState.status = "";
		wsState.statusText = "";
		uiState.sidebarCollapsed = true;
		uiState.clientCount = 0;
		terminalState.tabs = new Map();
		routerState.path = "/p/my-project/";
	},
} satisfies Meta<typeof Header>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {
	beforeEach: () => {
		wsState.status = "connected";
		wsState.statusText = "Connected";
		routerState.path = "/p/my-project/";
	},
};

export const Disconnected: Story = {
	beforeEach: () => {
		wsState.status = "disconnected";
		wsState.statusText = "Disconnected";
	},
};

export const Processing: Story = {
	beforeEach: () => {
		wsState.status = "processing";
		wsState.statusText = "Processing...";
	},
};

export const WithError: Story = {
	beforeEach: () => {
		wsState.status = "error";
		wsState.statusText = "Connection error";
	},
};

export const WithMultipleClients: Story = {
	beforeEach: () => {
		wsState.status = "connected";
		wsState.statusText = "Connected";
		uiState.clientCount = 5;
	},
};

export const WithTerminalBadge: Story = {
	beforeEach: () => {
		wsState.status = "connected";
		wsState.statusText = "Connected";
		const tabs = new Map();
		tabs.set("pty-1", { ptyId: "pty-1", title: "Terminal", exited: false });
		tabs.set("pty-2", { ptyId: "pty-2", title: "Terminal 2", exited: false });
		terminalState.tabs = tabs;
	},
};

export const SidebarExpanded: Story = {
	beforeEach: () => {
		wsState.status = "connected";
		wsState.statusText = "Connected";
		uiState.sidebarCollapsed = false;
	},
};
