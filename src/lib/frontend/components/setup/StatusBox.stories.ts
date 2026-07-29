import type { Meta, StoryObj } from "@storybook/svelte-vite";
import StatusBox from "./StatusBox.svelte";

const meta = {
	title: "Setup/StatusBox",
	component: StatusBox,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		status: "pending",
		message: "Checking HTTPS connection...",
	},
} satisfies Meta<typeof StatusBox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Success: Story = {
	args: {
		status: "ok",
		message: "HTTPS connection verified. Certificate is trusted.",
	},
};

export const Warning: Story = {
	args: {
		status: "warn",
		message: "Certificate not trusted yet. Install it above, then retry.",
	},
};
