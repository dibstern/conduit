import type { Meta, StoryObj } from "@storybook/svelte-vite";
import QrModal from "./QrModal.svelte";

const noop = () => {};

const meta = {
	title: "Overlays/QrModal",
	component: QrModal,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		// Modal uses fixed inset-0; needs own iframe viewport.
		docs: { story: { inline: false, height: "400px" } },
	},
	// QrModal fetches /health when it becomes visible to discover a LAN address,
	// and rewrites the QR code's URL if one comes back — so an unstubbed request
	// makes the rendered QR depend on what the story server happens to answer.
	// The component swallows the failure (`catch {}`), so this was invisible.
	// Rejecting keeps networkHost null and the QR on window.location.href, which
	// is what these baselines have always actually shown. See conduit-test-de3.33.
	beforeEach: () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (_input: RequestInfo | URL, _init?: RequestInit) =>
			Promise.reject(new TypeError("Failed to fetch"));
		return () => {
			globalThis.fetch = realFetch;
		};
	},
} satisfies Meta<typeof QrModal>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Modal visible with QR code rendering the current page URL.
 * Click the URL text to copy, click backdrop or press Escape to close.
 */
export const Visible: Story = {
	args: {
		visible: true,
		onClose: noop,
	},
};

/**
 * Modal hidden — nothing renders when visible is false.
 */
export const Hidden: Story = {
	args: {
		visible: false,
		onClose: noop,
	},
};

export const Hover: Story = {
	...Visible,
	parameters: { pseudo: { hover: true } },
};
