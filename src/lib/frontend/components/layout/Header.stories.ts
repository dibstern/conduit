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

// There is deliberately NO "terminal badge" story here (conduit-test-732b). The
// header's terminal button renders an unconditional icon and nothing else —
// `terminalState.tabs` is read by the click handler, never by any count or badge
// markup. The story that used to sit here seeded two tabs and captured a header
// identical to Connected's, so its baseline was byte-identical and it asserted
// nothing. Seeding the store harder would not have helped; there is no badge to
// render. If a badge is ever designed, this is where its story goes.

export const SidebarExpanded: Story = {
	beforeEach: () => {
		wsState.status = "connected";
		wsState.statusText = "Connected";
		uiState.sidebarCollapsed = false;
	},
};

export const Hover: Story = {
	...Connected,
	parameters: { pseudo: { hover: true } },
};
