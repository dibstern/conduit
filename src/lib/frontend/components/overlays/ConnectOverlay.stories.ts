import type { Meta, StoryObj } from "@storybook/svelte-vite";
import ConnectOverlay from "./ConnectOverlay.svelte";

const meta = {
	title: "Overlays/ConnectOverlay",
	component: ConnectOverlay,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
	},
} satisfies Meta<typeof ConnectOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Overlay visible — shows scatter-to-settle pixel animation and cycling
 * thinking verbs. Simulates the disconnected/connecting state.
 */
export const Connecting: Story = {};

/**
 * Overlay hidden — simulates the connected state where the overlay
 * has faded out. In practice, the overlay reads wsState from the store
 * and hides itself when connected.
 */
export const Connected: Story = {};
