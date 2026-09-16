import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { terminalState } from "../../stores/terminal.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { wsState } from "../../stores/ws.svelte.js";
import type { OpenCodeInstance } from "../../types.js";
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
		instanceState.instances = [];
		projectState.projects = [];
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

// The instance badge needs TWO instances to appear at all -- Header hides it
// below that, on the grounds that a picker with one option is noise. Nothing
// seeded that, so the badge and its whole dropdown had no baseline until
// conduit-test-de3.35.6, which is how a menu with no aria-expanded, no
// keyboard navigation and no Escape survived this long.
const mockInstances: OpenCodeInstance[] = [
	{
		id: "inst-personal",
		name: "Personal",
		port: 4096,
		managed: true,
		status: "healthy",
		restartCount: 0,
		createdAt: 0,
	},
	{
		id: "inst-work",
		name: "Work",
		port: 4097,
		managed: true,
		status: "unhealthy",
		restartCount: 1,
		createdAt: 0,
	},
];

function seedInstances() {
	wsState.status = "connected";
	wsState.statusText = "Connected";
	instanceState.instances = [...mockInstances];
	projectState.projects = [
		{
			slug: "my-project",
			title: "my-project",
			directory: "/src/my-project",
			instanceId: "inst-personal",
		},
	];
	routerState.path = "/p/my-project/";
}

export const WithInstanceBadge: Story = {
	beforeEach: seedInstances,
};

export const InstanceSelectorOpen: Story = {
	// The menu portals to <body>, so the capture has to frame the page.
	tags: ["viewport-capture"],
	beforeEach: seedInstances,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("instance-badge"));
		// The check mark on Personal is the assertion: the old markup rendered
		// every instance identically and never said which one was current.
		const menu = await within(document.body).findByTestId(
			"instance-selector-dropdown",
		);
		await expect(
			within(menu).getByRole("menuitemradio", { name: /Personal/ }),
		).toBeChecked();
	},
};
