import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { wsState } from "../../stores/ws.svelte.js";
import ConnectOverlay from "./ConnectOverlay.svelte";

const meta = {
	title: "Overlays/ConnectOverlay",
	component: ConnectOverlay,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		// Overlay uses fixed inset-0; needs own iframe viewport.
		docs: { story: { inline: false, height: "400px" } },
	},
	beforeEach: () => {
		wsState.status = "";
		wsState.statusText = "";
		wsState.relayStatus = undefined;
		wsState.relayError = undefined;
	},
} satisfies Meta<typeof ConnectOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Overlay visible — shows animated logo and "Connecting to OpenCode..."
 * status text. Simulates the disconnected/connecting state.
 */
export const Connecting: Story = {};

/**
 * Relay failed to start — overlay shows error text and a back link.
 */
export const RelayError: Story = {
	beforeEach: () => {
		wsState.relayStatus = "error";
		wsState.relayError = "Failed to bind port 4096: address already in use";
	},
};

/**
 * Relay registering — shows "Starting relay..." status text.
 */
export const RelayRegistering: Story = {
	beforeEach: () => {
		wsState.relayStatus = "registering";
	},
};
