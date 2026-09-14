import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, waitFor } from "storybook/test";
import { discoveryState } from "../../stores/discovery.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
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

/**
 * The instance picker, shown when the connection is down and the project's
 * OpenCode instance is stopped while other instances exist.
 *
 * This story exists because those two buttons were in ZERO baselines
 * (conduit-test-8dgv). `showInstanceActions` is a four-way `$derived` fed by
 * effects that only fire on real store data, so none of the other stories here
 * reach it — which made the whole branch invisible to the visual suite. It was
 * caught only by perturbing Button's BASE_CLASSES during the de3.5 migration
 * and noticing that every ConnectOverlay story stayed green.
 *
 * Seeded, not mocked: these are the same plain `$state` stores the sibling
 * stories already write to.
 */
export const InstanceActions: Story = {
	beforeEach: () => {
		discoveryState.currentProviderId = "opencode";
		projectState.currentSlug = "demo";
		projectState.projects = [
			{
				slug: "demo",
				title: "Demo",
				directory: "/tmp/demo",
				instanceId: "instance-stopped",
			},
		];
		// Two instances is not padding: `cachedMultiInstance` gates these buttons
		// on `instances.length > 1`, so a single-instance seed renders nothing and
		// this story would silently become another picture of the plain overlay.
		instanceState.instances = [
			{
				id: "instance-stopped",
				name: "Primary",
				port: 4096,
				managed: true,
				status: "stopped",
				restartCount: 0,
				// Fixed, not Date.now(): a live clock here would bake a changing value
				// into any rendering that surfaces it and make the baseline unstable.
				createdAt: 0,
			},
			{
				id: "instance-other",
				name: "Secondary",
				port: 4097,
				managed: true,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
			},
		];
		return () => {
			discoveryState.currentProviderId = "";
			projectState.currentSlug = null;
			projectState.projects = [];
			instanceState.instances = [];
		};
	},
	/**
	 * Guards the seed. Every condition above is necessary, and if any one of them
	 * stops holding the overlay still renders perfectly happily — just without
	 * the buttons. That produces a stable, plausible screenshot of the wrong
	 * thing, which is exactly how ChatLayout's baselines spent three stories
	 * photographing this very overlay (conduit-test-732b).
	 */
	play: async ({ canvasElement }) => {
		await waitFor(() => {
			const labels = [...canvasElement.querySelectorAll("button")].map(
				(button) => button.textContent?.trim(),
			);
			expect(
				labels,
				"instance action buttons missing — the store seed no longer satisfies showInstanceActions, so this baseline is a picture of the plain overlay",
			).toEqual(expect.arrayContaining(["Start Instance", "Switch Instance"]));
		});
	},
};
