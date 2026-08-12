import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import StepTailscale from "./StepTailscale.svelte";

const meta = {
	title: "Setup/StepTailscale",
	component: StepTailscale,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		totalSteps: 4,
		currentIdx: 0,
		isIOS: false,
		isAndroid: false,
		tailscaleUrlHint: "",
		tsStatus: "pending",
		tsMessage: "Checking connection...",
		onnextstep: fn(),
	},
} satisfies Meta<typeof StepTailscale>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const IOSDownload: Story = {
	args: {
		isIOS: true,
	},
};

export const AndroidDownload: Story = {
	args: {
		isAndroid: true,
	},
};

export const Connected: Story = {
	args: {
		tailscaleUrlHint: "Your relay: https://100.64.0.1:7080",
		tsStatus: "ok",
		tsMessage: "Connected via Tailscale (100.64.0.1)",
	},
};

export const NotConnected: Story = {
	args: {
		tsStatus: "warn",
		tsMessage:
			"You are not on a Tailscale network. Install Tailscale and access the relay via your 100.x.x.x IP.",
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
