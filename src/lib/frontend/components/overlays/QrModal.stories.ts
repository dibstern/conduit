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
